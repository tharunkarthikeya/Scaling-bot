/**
 * The measurements the application does not take of itself.
 *
 * All of it lives here rather than in `src/`, because a metrics endpoint welded
 * into the production server would be a permanent change made for a temporary
 * reason. The rig imports the same modules `index.ts` does and instruments the
 * objects it gets back — the queue is a singleton, so wrapping its methods on
 * the instance reaches every caller including `server.ts`, which never learns
 * anything happened.
 *
 * Three things are measured:
 *
 *   Event-loop lag, by timer drift. A timer set for 20ms that fires at 95ms was
 *   held off by 75ms of synchronous work, and that number is the one that says
 *   whether a queue is slow because it is waiting or slow because the loop is
 *   blocked.
 *
 *   Queue wait, honestly. `enqueue` is wrapped to stamp the moment a job was
 *   accepted and the handler is wrapped to read that stamp when it starts. The
 *   difference is the time the job spent waiting for a worker rather than the
 *   time it spent running, and the two answer different questions.
 *
 *   Queue depth, by sampling `stats()` — which `InProcessQueue` already
 *   exposes and nothing has ever called.
 */

import { performance } from 'node:perf_hooks';

export class Histogram {
  private readonly values: number[] = [];

  add(v: number): void {
    this.values.push(v);
  }

  get count(): number {
    return this.values.length;
  }

  summary(): { count: number; avg: number; p50: number; p95: number; p99: number; max: number } {
    if (!this.values.length) return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      avg: round(sum / sorted.length),
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      p99: round(at(0.99)),
      max: round(sorted[sorted.length - 1]!),
    };
  }

  reset(): void {
    this.values.length = 0;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Event-loop lag                                                      */
/* ------------------------------------------------------------------ */

export function watchEventLoopLag(intervalMs = 20): {
  histogram: Histogram;
  stop: () => void;
} {
  const histogram = new Histogram();
  let expected = performance.now() + intervalMs;

  const timer = setInterval(() => {
    const now = performance.now();
    // Anything beyond the interval itself is time the loop was not free.
    histogram.add(Math.max(0, now - expected));
    expected = now + intervalMs;
  }, intervalMs);

  timer.unref();
  return { histogram, stop: () => clearInterval(timer) };
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

export interface QueueMetrics {
  submitted: Record<string, number>;
  started: Record<string, number>;
  completed: Record<string, number>;
  failed: Record<string, number>;
  waitMs: Record<string, Histogram>;
  runMs: Record<string, Histogram>;
  maxDepth: Record<string, number>;
  depthSamples: Record<string, number[]>;
}

interface QueueLike {
  enqueue: (name: string, payload: unknown) => Promise<void>;
  register: (name: string, handler: (payload: unknown) => Promise<void>, concurrency?: number) => void;
  stats?: () => Record<string, { running: number; waiting: number; concurrency: number }>;
}

const bump = (r: Record<string, number>, k: string) => (r[k] = (r[k] ?? 0) + 1);
const hist = (r: Record<string, Histogram>, k: string) => (r[k] ??= new Histogram());

/**
 * Wraps a queue in place so every job is timed from acceptance to completion.
 *
 * `enqueue` stamps the payload object itself with a non-enumerable property. It
 * has to be the object rather than a side table because the in-process queue
 * hands the very same object to the handler, and a side table keyed on anything
 * else would need an id the payload does not carry.
 */
export function instrumentQueue(queue: QueueLike): {
  metrics: QueueMetrics;
  sampleDepth: () => void;
  reset: () => void;
} {
  const metrics: QueueMetrics = {
    submitted: {},
    started: {},
    completed: {},
    failed: {},
    waitMs: {},
    runMs: {},
    maxDepth: {},
    depthSamples: {},
  };

  const STAMP = Symbol.for('loadtest.enqueuedAt');

  const originalEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = async (name: string, payload: unknown): Promise<void> => {
    bump(metrics.submitted, name);
    if (payload && typeof payload === 'object') {
      Object.defineProperty(payload, STAMP, {
        value: performance.now(),
        enumerable: false,
        configurable: true,
      });
    }
    return originalEnqueue(name, payload);
  };

  const originalRegister = queue.register.bind(queue);
  queue.register = (
    name: string,
    handler: (payload: unknown) => Promise<void>,
    concurrency?: number,
  ): void => {
    const wrapped = async (payload: unknown): Promise<void> => {
      const startedAt = performance.now();
      const enqueuedAt = (payload as Record<symbol, number> | undefined)?.[STAMP];
      if (typeof enqueuedAt === 'number') hist(metrics.waitMs, name).add(startedAt - enqueuedAt);
      bump(metrics.started, name);

      try {
        await handler(payload);
        bump(metrics.completed, name);
      } catch (err) {
        bump(metrics.failed, name);
        throw err;
      } finally {
        hist(metrics.runMs, name).add(performance.now() - startedAt);
      }
    };

    return originalRegister(name, wrapped, concurrency);
  };

  const sampleDepth = () => {
    const stats = queue.stats?.();
    if (!stats) return;
    for (const [name, s] of Object.entries(stats)) {
      metrics.maxDepth[name] = Math.max(metrics.maxDepth[name] ?? 0, s.waiting);
      (metrics.depthSamples[name] ??= []).push(s.waiting);
    }
  };

  const reset = () => {
    for (const key of ['submitted', 'started', 'completed', 'failed', 'maxDepth'] as const) {
      for (const k of Object.keys(metrics[key])) delete metrics[key][k];
    }
    for (const h of Object.values(metrics.waitMs)) h.reset();
    for (const h of Object.values(metrics.runMs)) h.reset();
    for (const k of Object.keys(metrics.depthSamples)) metrics.depthSamples[k] = [];
  };

  return { metrics, sampleDepth, reset };
}

/* ------------------------------------------------------------------ */
/* Process                                                             */
/* ------------------------------------------------------------------ */

export interface ProcessSample {
  at: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  cpuPercent: number;
}

export function watchProcess(intervalMs = 500): {
  samples: ProcessSample[];
  stop: () => void;
} {
  const samples: ProcessSample[] = [];
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpu);
    const elapsedUs = (now - lastAt) * 1000;
    lastCpu = process.cpuUsage();
    lastAt = now;

    const mem = process.memoryUsage();
    samples.push({
      at: now,
      rssMb: round(mem.rss / 1048576),
      heapUsedMb: round(mem.heapUsed / 1048576),
      heapTotalMb: round(mem.heapTotal / 1048576),
      externalMb: round(mem.external / 1048576),
      // Percent of ONE core. Above 100 means more than one core is in use;
      // the ceiling on a 4-core box is 400.
      cpuPercent: elapsedUs > 0 ? round(((cpu.user + cpu.system) / elapsedUs) * 100) : 0,
    });
  }, intervalMs);

  timer.unref();
  return { samples, stop: () => clearInterval(timer) };
}

export function summarise(values: number[]): { avg: number; p95: number; max: number; min: number } {
  if (!values.length) return { avg: 0, p95: 0, max: 0, min: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: round(sum / sorted.length),
    p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!),
    max: round(sorted[sorted.length - 1]!),
    min: round(sorted[0]!),
  };
}
