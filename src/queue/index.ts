import { Queue as BullQueue, Worker, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { key, redisFor } from '../redis/index.js';
import { record } from '../metrics/record.js';

export interface JobPayloads {
  /** One inbound WhatsApp message, already deduped and persisted. */
  inbound_message: {
    waId: string;
    wamid: string;
    profileName?: string;
    /**
     * Which of the agency's numbers it arrived on (`conversation/lines.ts`).
     *
     * Carried on the job rather than re-read from the stored turn because it
     * decides which flow a *new* conversation gets, and that decision is made
     * before there is a record to read it from. Absent on a job enqueued
     * before this field existed, which means the main number.
     */
    phoneNumberId?: string;
  };
  /** One stored document ready for OCR. OCR is slow (120s), so it never runs inline. */
  ocr: { waId: string; docType: string; uploadId: string };
  /**
   * One finished registration to hand to the CRM.
   *
   * Queued after the candidate has confirmed, so a CRM outage delays a delivery
   * rather than failing a registration the candidate has already completed.
   */
  crm_sync: { waId: string };
  /**
   * Copying a finished conversation into the ATS database (`ats/export.ts`).
   *
   * Its own job for the same reason `crm_sync` is one: the candidate has
   * already been told they are done, and a second database being briefly
   * unreachable is ours to retry rather than theirs to wait for.
   */
  ats_export: { waId: string };
}

export type JobName = keyof JobPayloads;

export type JobHandler<K extends JobName> = (payload: JobPayloads[K]) => Promise<void>;

export interface JobQueue {
  enqueue<K extends JobName>(name: K, payload: JobPayloads[K]): Promise<void>;
  register<K extends JobName>(name: K, handler: JobHandler<K>, concurrency?: number): void;
  start(): Promise<void>;
  close(): Promise<void>;

  /**
   * How far behind each queue is, whichever implementation is running.
   *
   * `waiting` is the number to watch under load: flat is keeping up, rising is
   * not, whatever the latency averages say. Both backends answer this, so
   * `/metrics` never has to know which one it got.
   */
  depth(): Promise<Record<string, QueueDepth>>;

  /**
   * Report this job name in `depth()` even though this process does not consume
   * it.
   *
   * A `web` instance registers no workers but is the one being scraped, so
   * without this its metrics would claim every queue is empty — which is the
   * most misleading thing a queue metric can say.
   */
  observe(name: JobName): void;
}

export interface QueueDepth {
  /** Accepted, not yet started. */
  waiting: number;
  /** Started, not yet finished. */
  active: number;
  /** Exhausted their retries. Redis only; the in-process queue does not retry. */
  failed: number;
  /** Waiting out a retry backoff. Redis only. */
  delayed: number;
  /** What this process is willing to run at once, when it consumes this queue. */
  concurrency: number;
}

/**
 * Every BullMQ key under the application's namespace.
 *
 * BullMQ builds its own key structure beneath this, so one Redis can carry a
 * staging copy of this bot and production without the two consuming each
 * other's jobs - which is a mistake that looks exactly like message loss.
 */
const QUEUE_PREFIX = key('bull');

/**
 * Times one job and records its outcome, whichever backend is running it.
 *
 * Wrapped here rather than at each registration site so the two implementations
 * cannot report different things, and so a handler added later is measured
 * without anybody remembering to measure it. The error is re-thrown untouched:
 * this observes, it does not handle.
 */
async function instrumented(name: JobName, run: () => Promise<void>): Promise<void> {
  const startedAt = process.hrtime.bigint();
  record.jobStarted(name);

  const seconds = () => Number(process.hrtime.bigint() - startedAt) / 1e9;

  try {
    await run();
    record.jobFinished(name, seconds(), true);
  } catch (err) {
    record.jobFinished(name, seconds(), false);
    throw err;
  }
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 60 * 60 * 24 * 7 },
};

/* ------------------------------------------------------------------ */
/* Redis-backed (production)                                           */
/* ------------------------------------------------------------------ */

/**
 * Exported for the scaling tests, which build more than one of these to stand
 * in for more than one worker process. Application code uses the `queue`
 * singleton at the bottom of this file and should never construct its own.
 */
export class RedisQueue implements JobQueue {
  private readonly connection: Redis;
  private readonly queues = new Map<JobName, BullQueue>();
  private readonly workers: Worker[] = [];
  private readonly pending: Array<{ name: JobName; handler: JobHandler<any>; concurrency: number }> =
    [];
  /** What this process runs each queue at. Zero when it only observes. */
  private readonly concurrencyFor = new Map<JobName, number>();

  /**
   * BullMQ gets its own connection, and it must be an unbounded one.
   *
   * Workers hold a blocking read open waiting for the next job. ioredis'
   * default `maxRetriesPerRequest` counts that as a command in flight and tears
   * the connection down when the ceiling is reached, so BullMQ documents `null`
   * as a requirement rather than a preference. Nothing else in this application
   * wants that: a lock or a limiter with no retry ceiling is a promise that
   * never settles when Redis goes away.
   */
  constructor() {
    this.connection = redisFor('queue', { maxRetriesPerRequest: null });
  }

  private queueFor(name: JobName): BullQueue {
    let q = this.queues.get(name);
    if (!q) {
      q = new BullQueue(name, { connection: this.connection, prefix: QUEUE_PREFIX });
      this.queues.set(name, q);
    }
    return q;
  }

  /**
   * Depth per job name, read from Redis, so it is the depth of the whole fleet
   * rather than of this process.
   *
   * That distinction is the entire reason to scrape it: one worker reporting an
   * empty local pool while eight thousand jobs wait in Redis is exactly the
   * picture a per-process metric would paint.
   */
  async depth(): Promise<Record<string, QueueDepth>> {
    const entries = await Promise.all(
      [...this.queues.keys()].map(async (name) => {
        const counts = await this.queueFor(name).getJobCounts(
          'waiting',
          'active',
          'failed',
          'delayed',
        );
        return [
          name,
          {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            failed: counts.failed ?? 0,
            delayed: counts.delayed ?? 0,
            concurrency: this.concurrencyFor.get(name) ?? 0,
          },
        ] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  observe(name: JobName): void {
    this.queueFor(name);
  }

  async enqueue<K extends JobName>(name: K, payload: JobPayloads[K]): Promise<void> {
    await this.queueFor(name).add(name, payload, DEFAULT_JOB_OPTIONS);
  }

  register<K extends JobName>(name: K, handler: JobHandler<K>, concurrency = 4): void {
    this.pending.push({ name, handler, concurrency });
    this.concurrencyFor.set(name, concurrency);
    this.queueFor(name);
  }

  async start(): Promise<void> {
    for (const { name, handler, concurrency } of this.pending) {
      const worker = new Worker(name, async (job) => instrumented(name, () => handler(job.data)), {
        connection: this.connection,
        prefix: QUEUE_PREFIX,
        concurrency,
      });
      worker.on('failed', (job, err) => {
        logger.error({ err, job: name, attempts: job?.attemptsMade }, 'job failed');
      });
      this.workers.push(worker);
    }
    logger.info({ workers: this.workers.length }, 'redis queue started');
  }

  async close(): Promise<void> {
    // Workers first, so nothing is mid-job when the queues go. The connection
    // itself is closed by `closeRedis()` at the end of shutdown, because it is
    // shared with whatever else asked `redisFor('queue')` for it.
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/* ------------------------------------------------------------------ */
/* In-process                                                          */
/* ------------------------------------------------------------------ */

/** One queued job, with the key that decides what it may run alongside. */
interface PendingJob {
  payload: unknown;
  /**
   * Jobs sharing a key never run concurrently in the same pool, and run in the
   * order they were enqueued. Derived from the candidate's `waId`.
   */
  key?: string;
}

/**
 * Every payload this queue carries names a candidate, and that name is the
 * ordering key. A payload without one is unordered — it may run alongside
 * anything, which is the correct default for a job that belongs to nobody.
 */
function orderingKeyFor(payload: unknown): string | undefined {
  const waId = (payload as { waId?: unknown } | undefined)?.waId;
  return typeof waId === 'string' && waId.length > 0 ? waId : undefined;
}

/**
 * A bounded set of workers over one job name.
 *
 * Replaces the single promise chain this queue used to be. That chain was one
 * execution slot for the entire process — every job of every type behind one
 * another — so a 120-second extraction stopped every conversation on the
 * platform until it finished. Worse, the `concurrency` argument callers passed
 * at registration was accepted by the type checker and then discarded, because
 * the old `register` took only two parameters. Nothing failed; the number was
 * simply never read.
 *
 * The pool holds a FIFO of waiting jobs and at most `concurrency` in flight.
 * Two properties make it safe to run candidate turns in parallel:
 *
 *   Jobs sharing an ordering key never overlap. `busyKeys` holds the key of
 *   every job currently running, and `pump` will not start a second job for a
 *   key already in it.
 *
 *   A job whose key is busy is *skipped, not awaited*. It stays in the queue
 *   and a later job for a free candidate takes the slot instead. Blocking the
 *   worker on the key would let one talkative candidate occupy every slot and
 *   reintroduce the head-of-line stall this class exists to remove.
 *
 * The consequence is deliberate: FIFO holds per candidate, not globally. A
 * later message for a free candidate may overtake an earlier message for a busy
 * one, which is exactly what "one slow document must not block everyone else"
 * means in practice.
 */
class JobPool {
  private readonly waiting: PendingJob[] = [];
  private readonly busyKeys = new Set<string>();
  private active = 0;
  /** Resolvers waiting for this pool to go quiet. Drained by `close`. */
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly name: JobName,
    private readonly handler: JobHandler<any>,
    readonly concurrency: number,
  ) {}

  /** Jobs queued but not yet started. The number to watch under load. */
  get depth(): number {
    return this.waiting.length;
  }

  /** Jobs currently executing. Never exceeds `concurrency`. */
  get running(): number {
    return this.active;
  }

  push(job: PendingJob): void {
    this.waiting.push(job);
    this.pump();
  }

  /**
   * Fills every free slot it can, oldest runnable job first.
   *
   * Synchronous on purpose. `run` increments `active` before its first await,
   * so the loop below always sees an accurate count and cannot oversubscribe.
   */
  private pump(): void {
    while (this.active < this.concurrency) {
      const index = this.waiting.findIndex((job) => !job.key || !this.busyKeys.has(job.key));
      // Everything left is waiting on a key that is already running.
      if (index === -1) return;
      void this.run(this.waiting.splice(index, 1)[0]!);
    }
  }

  /**
   * Runs one job. Never rejects — a handler that throws is logged and the slot
   * is released, because one bad payload must not wedge the pool.
   */
  private async run(job: PendingJob): Promise<void> {
    this.active += 1;
    if (job.key) this.busyKeys.add(job.key);

    try {
      await instrumented(this.name, () => this.handler(job.payload));
    } catch (err) {
      logger.error({ err, job: this.name }, 'job failed (no retry in the in-process queue)');
    } finally {
      this.active -= 1;
      if (job.key) this.busyKeys.delete(job.key);
      this.pump();
      if (this.active === 0 && this.waiting.length === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  /** Resolves once nothing is queued and nothing is running. */
  async drain(): Promise<void> {
    while (this.active > 0 || this.waiting.length > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }
}

export class InProcessQueue implements JobQueue {
  private readonly pools = new Map<JobName, JobPool>();

  async enqueue<K extends JobName>(name: K, payload: JobPayloads[K]): Promise<void> {
    const pool = this.pools.get(name);
    if (!pool) {
      logger.warn({ job: name }, 'no handler registered; job dropped');
      return;
    }
    pool.push({ payload, key: orderingKeyFor(payload) });
  }

  /**
   * `concurrency` defaults to 1 — the behaviour this class had before it could
   * count. A caller that forgets to say gets the safe answer rather than a
   * number somebody guessed; the real values are configured in `config.ts` and
   * passed in `index.ts`.
   */
  register<K extends JobName>(name: K, handler: JobHandler<K>, concurrency = 1): void {
    this.pools.set(
      name,
      new JobPool(name, handler as JobHandler<any>, Math.max(1, Math.floor(concurrency))),
    );
  }

  async start(): Promise<void> {
    const pools = Object.fromEntries(
      [...this.pools.entries()].map(([name, pool]) => [name, pool.concurrency]),
    );
    logger.warn(
      { pools },
      'using the in-process queue — bounded concurrency, but jobs are lost on restart and are never retried',
    );
  }

  /** Queue depth and in-flight count per job name. The load-test signal. */
  stats(): Record<string, { running: number; waiting: number; concurrency: number }> {
    return Object.fromEntries(
      [...this.pools.entries()].map(([name, pool]) => [
        name,
        { running: pool.running, waiting: pool.depth, concurrency: pool.concurrency },
      ]),
    );
  }

  /**
   * The same shape the Redis queue reports, so `/metrics` is implementation-
   * blind.
   *
   * `failed` and `delayed` are always zero and that is not a gap in the
   * reporting: this queue has no retries and no backoff, which is the honest
   * answer and the reason it is not the production backend.
   */
  async depth(): Promise<Record<string, QueueDepth>> {
    return Object.fromEntries(
      [...this.pools.entries()].map(([name, pool]) => [
        name,
        {
          waiting: pool.depth,
          active: pool.running,
          failed: 0,
          delayed: 0,
          concurrency: pool.concurrency,
        },
      ]),
    );
  }

  /** No-op: this queue only knows about job names it has a handler for. */
  observe(): void {}

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.drain()));
  }
}

export const queue: JobQueue = config.REDIS_URL ? new RedisQueue() : new InProcessQueue();

/* ------------------------------------------------------------------ */
/* Per-candidate serialisation                                         */
/* ------------------------------------------------------------------ */

/**
 * Re-exported so every existing import keeps working.
 *
 * The lock moved to `./lock.ts` when it stopped being a `Map` and became a
 * Redis key, because it is no longer a detail of the queue — the OCR completion
 * path and the idle-session sweep take it from outside the queue entirely. It
 * is exported from here as well so that the eleven call sites that already say
 * `from '../queue/index.js'` did not all have to be edited to prove the same
 * behaviour.
 */
export { withCandidateLock, lockStats, LockTimeoutError, type LockHandle } from './lock.js';
