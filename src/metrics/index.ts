/**
 * What this instance is doing, in a form Prometheus can scrape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  The load-test rig has measured all of this for a while, from the outside,
 *  by wrapping the queue's methods on the singleton. That was the right shape
 *  for a temporary rig and the wrong shape for a fleet: it only exists while a
 *  load test is running, and it can only see the process it is inside.
 *
 *  This is the permanent version. It is not a copy of the rig — the rig keeps
 *  every sample so it can report exact percentiles over a bounded run, which is
 *  a memory leak in a server that runs for weeks. This keeps bucket counts.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two kinds of number live here, and the difference matters when reading them:
 *
 *   Counted as it happens — HTTP requests, job outcomes, errors. Cheap, always
 *   on, incremented on the hot path.
 *
 *   Collected at scrape time — queue depth, limiter waits, model concurrency,
 *   memory. Nothing is sampled on a timer, so an unscraped instance costs
 *   nothing, and every gauge is as fresh as the scrape that asked for it.
 *
 * Queue depth is read from Redis, so it is the depth of the *fleet* and not of
 * this process. A worker reporting an empty local pool while eight thousand
 * jobs wait in Redis is exactly the picture a per-process metric would paint.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { config, instanceId } from './../config.js';
import { queue, lockStats } from '../queue/index.js';
import { limiterStats } from '../whatsapp/rateLimiter.js';
import { modelStats } from '../conversation/model.js';
import { storageDriver } from '../storage/index.js';
import { redisEnabled } from '../redis/index.js';
import { gauge, renderRegistry } from './registry.js';
import { record } from './record.js';

export { record } from './record.js';

/* ------------------------------------------------------------------ */
/* Event-loop lag                                                      */
/* ------------------------------------------------------------------ */

/**
 * Measured by libuv rather than by a timer.
 *
 * The rig measures drift on a 20ms `setInterval`, which works but costs a timer
 * wakeup fifty times a second forever. `monitorEventLoopDelay` is a native
 * histogram sampled by the runtime itself: the same number, no JavaScript
 * executed to obtain it, and percentiles that do not have to be computed from a
 * growing array.
 *
 * This is the metric that distinguishes "slow because it is waiting on Anthropic"
 * from "slow because something is blocking the loop" — the second is the only
 * one where adding concurrency makes things worse.
 */
let loopDelay: IntervalHistogram | undefined;

export function startEventLoopMonitor(): void {
  if (loopDelay) return;
  loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
}

export function stopEventLoopMonitor(): void {
  loopDelay?.disable();
  loopDelay = undefined;
}

/* ------------------------------------------------------------------ */
/* Collected at scrape time                                            */
/* ------------------------------------------------------------------ */

const up = gauge('adira_up', 'Always 1. Carries the role, instance, queue and storage as labels.');

const queueWaiting = gauge('adira_queue_waiting', 'Jobs accepted and not yet started, fleet-wide when Redis backs the queue.');
const queueActive = gauge('adira_queue_active', 'Jobs currently executing, fleet-wide when Redis backs the queue.');
const queueFailed = gauge('adira_queue_failed', 'Jobs that exhausted their retries and are parked.');
const queueDelayed = gauge('adira_queue_delayed', 'Jobs waiting out a retry backoff.');
const queueConcurrency = gauge('adira_queue_concurrency', 'What this process is willing to run at once. Zero when it only observes.');
const workerUtilisation = gauge(
  'adira_worker_utilisation',
  'Active jobs as a fraction of this process concurrency. Sustained 1 with a rising queue means add workers.',
);

const limiterGranted = gauge('adira_rate_limit_granted_total', 'Tokens handed out, by budget.');
const limiterRefused = gauge('adira_rate_limit_refused_total', 'Requests refused a token, by budget. Read receipts, mostly, which are meant to be dropped.');
const limiterWaited = gauge('adira_rate_limit_waited_total', 'Acquisitions that had to wait, by budget.');
const limiterWaitAvg = gauge('adira_rate_limit_wait_avg_seconds', 'Mean wait for a token, by budget. Rising here with a flat queue means the outbound path is the constraint.');
const limiterWaitMax = gauge('adira_rate_limit_wait_max_seconds', 'Longest wait for a token since boot, by budget.');

const modelInFlight = gauge('adira_model_in_flight', 'Anthropic calls executing in this process.');
const modelWaiting = gauge('adira_model_waiting', 'Calls queued for a concurrency slot in this process.');
const modelConcurrency = gauge('adira_model_concurrency_limit', 'MODEL_MAX_CONCURRENCY, per process.');
const modelCalls = gauge('adira_model_calls_total', 'Calls attempted.');
const modelTransient = gauge('adira_model_transient_total', 'Calls that failed after the SDK exhausted its retries. Throttling, mostly.');
const modelShed = gauge('adira_model_shed_total', 'Calls refused because the concurrency queue was full. Each one is a candidate asked to repeat themselves.');
const modelFailed = gauge('adira_model_failed_total', 'Calls that failed for a reason retrying will not fix.');

const lockAcquired = gauge('adira_lock_acquired_total', 'Candidate locks taken.');
const lockContended = gauge('adira_lock_contended_total', 'Acquisitions that found the lock held. Expected under load; it is what the lock is for.');
const lockTimedOut = gauge('adira_lock_timeout_total', 'Acquisitions that gave up. Each one is a job deferred to a retry.');
const lockLost = gauge('adira_lock_lost_total', 'Locks that expired while still in use. Should be zero; anything else means work outran its TTL.');
const lockHeld = gauge('adira_lock_held', 'Locks this process holds right now.');
const lockWaitAvg = gauge('adira_lock_wait_avg_seconds', 'Mean time spent waiting for a candidate lock.');

const loopLag = gauge('adira_event_loop_lag_seconds', 'Event-loop delay, by quantile. Distinguishes waiting from blocking.');

const memory = gauge('adira_process_memory_bytes', 'Process memory, by kind.');
const cpuSeconds = gauge('adira_process_cpu_seconds_total', 'CPU consumed since boot, user and system.');
const uptime = gauge('adira_process_uptime_seconds', 'Seconds since this process started.');

/**
 * Fills every gauge, then renders.
 *
 * `queue.depth()` is the only await, and the only thing that can be slow — it
 * is a handful of Redis reads. A scrape that cannot reach Redis reports what it
 * can rather than failing outright, because metrics that vanish exactly when
 * the system is unwell are worse than no metrics.
 */
export async function renderMetrics(): Promise<string> {
  up.set(1, {
    role: config.ROLE,
    instance: instanceId,
    queue: redisEnabled() ? 'redis' : 'in-process',
    storage: storageDriver(),
  });

  /* Queue ---------------------------------------------------------- */

  try {
    const depth = await queue.depth();
    for (const [job, d] of Object.entries(depth)) {
      queueWaiting.set(d.waiting, { job });
      queueActive.set(d.active, { job });
      queueFailed.set(d.failed, { job });
      queueDelayed.set(d.delayed, { job });
      queueConcurrency.set(d.concurrency, { job });
      // Undefined rather than zero when this process does not consume the
      // queue: a `web` instance is not 0% busy on OCR, it is not a party to it.
      if (d.concurrency > 0) workerUtilisation.set(d.active / d.concurrency, { job });
    }
  } catch {
    record.error('redis');
  }

  /* Rate limiters -------------------------------------------------- */

  for (const [budget, s] of Object.entries(limiterStats())) {
    limiterGranted.set(s.granted, { budget });
    limiterRefused.set(s.refused, { budget });
    limiterWaited.set(s.waited, { budget });
    limiterWaitAvg.set(s.waitMsAvg / 1000, { budget });
    limiterWaitMax.set(s.waitMsMax / 1000, { budget });
  }

  /* Model ---------------------------------------------------------- */

  const model = modelStats();
  modelInFlight.set(model.inFlight);
  modelWaiting.set(model.waiting);
  modelConcurrency.set(model.concurrency);
  modelCalls.set(model.calls);
  modelTransient.set(model.transient);
  modelShed.set(model.shed);
  modelFailed.set(model.failed);

  /* Locks ---------------------------------------------------------- */

  const locks = lockStats();
  lockAcquired.set(locks.acquired);
  lockContended.set(locks.contended);
  lockTimedOut.set(locks.timedOut);
  lockLost.set(locks.lost);
  lockHeld.set(locks.held);
  lockWaitAvg.set(locks.waitMsAvg / 1000);

  /* Event loop ----------------------------------------------------- */

  if (loopDelay) {
    // Nanoseconds from libuv; seconds for Prometheus.
    loopLag.set(loopDelay.mean / 1e9, { quantile: 'mean' });
    loopLag.set(loopDelay.percentile(50) / 1e9, { quantile: '0.5' });
    loopLag.set(loopDelay.percentile(95) / 1e9, { quantile: '0.95' });
    loopLag.set(loopDelay.percentile(99) / 1e9, { quantile: '0.99' });
    loopLag.set(loopDelay.max / 1e9, { quantile: 'max' });
  }

  /* Process -------------------------------------------------------- */

  const mem = process.memoryUsage();
  memory.set(mem.rss, { kind: 'rss' });
  memory.set(mem.heapUsed, { kind: 'heap_used' });
  memory.set(mem.heapTotal, { kind: 'heap_total' });
  memory.set(mem.external, { kind: 'external' });

  const cpu = process.cpuUsage();
  cpuSeconds.set(cpu.user / 1e6, { mode: 'user' });
  cpuSeconds.set(cpu.system / 1e6, { mode: 'system' });
  uptime.set(process.uptime());

  return renderRegistry();
}
