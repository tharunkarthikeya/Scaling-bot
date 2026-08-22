import { Queue as BullQueue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface JobPayloads {
  /** One inbound WhatsApp message, already deduped and persisted. */
  inbound_message: { waId: string; wamid: string; profileName?: string };
  /** One stored document ready for OCR. OCR is slow (120s), so it never runs inline. */
  ocr: { waId: string; docType: string; uploadId: string };
  /**
   * One finished registration to hand to the CRM.
   *
   * Queued after the candidate has confirmed, so a CRM outage delays a delivery
   * rather than failing a registration the candidate has already completed.
   */
  crm_sync: { waId: string };
}

export type JobName = keyof JobPayloads;

export type JobHandler<K extends JobName> = (payload: JobPayloads[K]) => Promise<void>;

export interface JobQueue {
  enqueue<K extends JobName>(name: K, payload: JobPayloads[K]): Promise<void>;
  register<K extends JobName>(name: K, handler: JobHandler<K>, concurrency?: number): void;
  start(): Promise<void>;
  close(): Promise<void>;
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

class RedisQueue implements JobQueue {
  private readonly connection: Redis;
  private readonly queues = new Map<JobName, BullQueue>();
  private readonly workers: Worker[] = [];
  private readonly pending: Array<{ name: JobName; handler: JobHandler<any>; concurrency: number }> =
    [];

  constructor(url: string) {
    this.connection = new Redis(url, { maxRetriesPerRequest: null });
  }

  private queueFor(name: JobName): BullQueue {
    let q = this.queues.get(name);
    if (!q) {
      q = new BullQueue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<K extends JobName>(name: K, payload: JobPayloads[K]): Promise<void> {
    await this.queueFor(name).add(name, payload, DEFAULT_JOB_OPTIONS);
  }

  register<K extends JobName>(name: K, handler: JobHandler<K>, concurrency = 4): void {
    this.pending.push({ name, handler, concurrency });
  }

  async start(): Promise<void> {
    for (const { name, handler, concurrency } of this.pending) {
      const worker = new Worker(name, async (job) => handler(job.data), {
        connection: this.connection,
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
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.connection.disconnect();
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
      await this.handler(job.payload);
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

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.drain()));
  }
}

export const queue: JobQueue = config.REDIS_URL
  ? new RedisQueue(config.REDIS_URL)
  : new InProcessQueue();

/* ------------------------------------------------------------------ */
/* Per-candidate serialisation                                         */
/* ------------------------------------------------------------------ */

const locks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` with an exclusive lock on `key`. Two messages from the same
 * candidate must not be handled concurrently, or the bot answers both with the
 * same stale checklist and asks for the same document twice.
 *
 * In-memory, so it holds for a single instance. Running more than one instance
 * needs this backed by a Redis lock.
 */
export async function withCandidateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  // Run whether or not the previous holder succeeded — one candidate's failure
  // must not wedge the queue behind them.
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);

  try {
    return await run;
  } finally {
    // Only clear if nothing queued behind us in the meantime.
    if (locks.get(key) === tail) locks.delete(key);
  }
}
