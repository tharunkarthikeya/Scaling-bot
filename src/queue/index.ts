import { Queue as BullQueue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface JobPayloads {
  /** One inbound WhatsApp message, already deduped and persisted. */
  inbound_message: { waId: string; wamid: string; profileName?: string };
  /** One stored document ready for OCR. OCR is slow (120s), so it never runs inline. */
  ocr: { documentId: string };
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
/* In-process (local dev only)                                         */
/* ------------------------------------------------------------------ */

class InProcessQueue implements JobQueue {
  private readonly handlers = new Map<JobName, JobHandler<any>>();
  private chain: Promise<void> = Promise.resolve();

  async enqueue<K extends JobName>(name: K, payload: JobPayloads[K]): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) {
      logger.warn({ job: name }, 'no handler registered; job dropped');
      return;
    }
    // Serialised so ordering matches the Redis-backed path closely enough for dev.
    this.chain = this.chain.then(async () => {
      try {
        await handler(payload);
      } catch (err) {
        logger.error({ err, job: name }, 'job failed (no retry in in-process queue)');
      }
    });
  }

  register<K extends JobName>(name: K, handler: JobHandler<K>): void {
    this.handlers.set(name, handler);
  }

  async start(): Promise<void> {
    logger.warn('using in-process queue — jobs are lost on restart and are not retried');
  }

  async close(): Promise<void> {
    await this.chain;
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
