/**
 * One candidate, one turn at a time — across every instance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE BOUNDARY THAT MAKES MORE THAN ONE BOT SAFE. Everything else in
 *  the horizontal architecture is throughput. This is correctness.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two messages from one candidate must never be handled concurrently. Both
 * would read the same checklist, both would decide the same document is still
 * missing, and the candidate is asked for their passport twice while the answer
 * they already gave is overwritten by the turn that started first and finished
 * last.
 *
 * This used to be a `Map<string, Promise>` in one process, which is exactly
 * right for one process and worthless for two: instance A and instance B each
 * held their own map, agreed with themselves, and answered the same candidate
 * simultaneously.
 *
 * The lock is now two gates in series, and both earn their place:
 *
 *   The local chain, first. Same-process contention is settled in memory with
 *   no round trip. Without it, eight workers on one instance would spin against
 *   Redis for a lock their own colleague is holding — correct, but a great deal
 *   of traffic to discover something this process already knew.
 *
 *   The Redis lock, second. `SET NX PX` against a key derived from the waId.
 *   This is the gate that sees other instances.
 *
 * Taken in that order by every caller, so the two can never deadlock against
 * each other.
 *
 * ## The fencing token
 *
 * Every acquisition takes a monotonically increasing number from a shared
 * counter, and the lock's value is `<fence>:<instance>:<uuid>`. Three separate
 * jobs:
 *
 *   *Unique* — the uuid means release and renewal are compare-and-swap. A
 *   holder can only ever delete or extend its own lock, so a process that
 *   stalled past its TTL cannot come back and delete the lock its successor is
 *   now holding. That failure mode — releasing someone else's lock — is the one
 *   that turns a lock into an ornament.
 *
 *   *Attributable* — the instance id means an unreleased lock names the replica
 *   that took it.
 *
 *   *Fenced* — the number increases globally, so a delayed writer can be
 *   recognised as stale by anything that records the fence it last accepted. It
 *   is handed to the callback and logged on the paths that matter. This
 *   application does not yet reject writes on it, and that is stated plainly
 *   rather than implied: the conditional updates already in `engine.ts` and
 *   `models.ts` (`sessionEndedAt: { $exists: false }`, the `claimEvent` unique
 *   index, the OCR claim) are what actually stop a stale writer today. The
 *   fence is what a future one would be built on.
 *
 * ## What happens when it cannot be had
 *
 * `acquire` waits, with jitter, up to `LOCK_ACQUIRE_TIMEOUT_MS`, then throws.
 * Throwing fails the job; BullMQ retries it with backoff; the turn is deferred
 * rather than lost. Waiting forever would hold a worker slot for a lock that may
 * never come, which is how one wedged candidate takes the whole pool with them.
 */

import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { config, instanceId } from '../config.js';
import { logger } from '../logger.js';
import { key, redisEnabled, sharedRedis } from '../redis/index.js';

/** Raised when the lock could not be obtained inside the configured window. */
export class LockTimeoutError extends Error {
  constructor(
    readonly lockKey: string,
    readonly waitedMs: number,
  ) {
    super(`could not acquire the lock for "${lockKey}" within ${waitedMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

/**
 * What the holder is given. Passed to the callback, which is free to ignore it —
 * every existing caller does, and their signatures did not have to change.
 */
export interface LockHandle {
  /** The candidate this lock is for. */
  readonly key: string;
  /** The value written into Redis. Unique to this acquisition. */
  readonly token: string;
  /** Monotonic across the fleet. Higher means later. */
  readonly fence: number;
  /**
   * False once a renewal has found the lock no longer ours — the process was
   * held off long enough for the TTL to expire and somebody else took it.
   * Anything about to make a decision it cannot take back should look at this.
   */
  readonly valid: boolean;
}

/* ------------------------------------------------------------------ */
/* Lua                                                                 */
/*                                                                     */
/* Redis runs each script to completion before anything else, so the   */
/* read-then-write pairs below are atomic without a transaction.       */
/* ------------------------------------------------------------------ */

/**
 * Takes the lock and stamps it, or reports who has it.
 *
 * The fence is only incremented when the lock is actually granted, so the
 * counter counts acquisitions rather than attempts — a busy candidate does not
 * inflate it by being polled.
 */
const ACQUIRE = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return {0, existing}
end
local fence = redis.call('INCR', KEYS[2])
local token = fence .. ':' .. ARGV[1]
redis.call('SET', KEYS[1], token, 'PX', ARGV[2])
return {1, token, fence}
`;

/** Extends the TTL, but only if the lock is still the one we took. */
const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/** Releases, but only our own. Never another holder's. */
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface LockScripts {
  lockAcquire(lockKey: string, fenceKey: string, holder: string, ttlMs: string): Promise<[number, string, number?]>;
  lockRenew(lockKey: string, token: string, ttlMs: string): Promise<number>;
  lockRelease(lockKey: string, token: string): Promise<number>;
}

let scriptsReady: (Redis & LockScripts) | undefined;

/**
 * The connection with the three scripts defined on it.
 *
 * `defineCommand` registers them as EVALSHA with an automatic fallback to EVAL
 * when Redis has not seen the script before — which is what makes this survive a
 * Redis restart without anybody handling NOSCRIPT.
 */
function scripts(): Redis & LockScripts {
  if (scriptsReady) return scriptsReady;

  const connection = sharedRedis();
  connection.defineCommand('lockAcquire', { numberOfKeys: 2, lua: ACQUIRE });
  connection.defineCommand('lockRenew', { numberOfKeys: 1, lua: RENEW });
  connection.defineCommand('lockRelease', { numberOfKeys: 1, lua: RELEASE });

  scriptsReady = connection as Redis & LockScripts;
  return scriptsReady;
}

/** Tests only — forces the next call to redefine the scripts on a fresh connection. */
export function resetLockScriptsForTests(): void {
  scriptsReady = undefined;
}

/* ------------------------------------------------------------------ */
/* Counters                                                            */
/* ------------------------------------------------------------------ */

const counters = {
  acquired: 0,
  contended: 0,
  timedOut: 0,
  renewals: 0,
  lost: 0,
  waitMsTotal: 0,
  waitMsMax: 0,
};

/** Held, contended and lost. Read by `/metrics`. */
export function lockStats(): {
  acquired: number;
  contended: number;
  timedOut: number;
  renewals: number;
  lost: number;
  held: number;
  waitMsAvg: number;
  waitMsMax: number;
  distributed: boolean;
} {
  return {
    ...counters,
    held: held.size,
    waitMsAvg: counters.acquired ? Math.round(counters.waitMsTotal / counters.acquired) : 0,
    distributed: redisEnabled(),
  };
}

/** Tests only. */
export function resetLockStatsForTests(): void {
  counters.acquired = 0;
  counters.contended = 0;
  counters.timedOut = 0;
  counters.renewals = 0;
  counters.lost = 0;
  counters.waitMsTotal = 0;
  counters.waitMsMax = 0;
}

/** Locks this process currently holds, for the metrics gauge and for shutdown. */
const held = new Set<string>();

/* ------------------------------------------------------------------ */
/* The Redis half                                                      */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backoff between attempts: quick at first, then slower, always jittered.
 *
 * Jitter matters more than the curve. Without it, every worker that lost a race
 * retries at the same instant as everyone else who lost the same race, and the
 * contention that caused the first collision reproduces itself indefinitely.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(15 * 2 ** Math.min(attempt, 4), 250);
  return Math.round(base * (0.5 + Math.random()));
}

async function acquireRedisLock(lockKey: string, candidate: string): Promise<Mutable<LockHandle>> {
  const redis = scripts();
  const fenceKey = key('lock', 'fence');
  const holder = `${instanceId}:${crypto.randomUUID()}`;
  const deadline = Date.now() + config.LOCK_ACQUIRE_TIMEOUT_MS;
  const startedAt = Date.now();

  for (let attempt = 0; ; attempt++) {
    const [ok, tokenOrHolder, fence] = await redis.lockAcquire(
      lockKey,
      fenceKey,
      holder,
      String(config.LOCK_TTL_MS),
    );

    if (ok === 1) {
      const waited = Date.now() - startedAt;
      counters.acquired += 1;
      counters.waitMsTotal += waited;
      counters.waitMsMax = Math.max(counters.waitMsMax, waited);
      return {
        key: candidate,
        token: tokenOrHolder,
        fence: fence ?? 0,
        valid: true,
      };
    }

    if (attempt === 0) counters.contended += 1;

    if (Date.now() >= deadline) {
      counters.timedOut += 1;
      const waited = Date.now() - startedAt;
      logger.warn(
        { waId: candidate, waitedMs: waited, heldBy: tokenOrHolder },
        'gave up waiting for a candidate lock; the job will be retried',
      );
      throw new LockTimeoutError(lockKey, waited);
    }

    await sleep(backoffMs(attempt));
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Keeps the lock alive for as long as the work takes.
 *
 * Renewed at a third of the TTL, so two consecutive renewals can fail — a
 * blocked event loop, a Redis blip — before the lock is actually at risk. A
 * renewal that comes back 0 means the lock is already gone and somebody else may
 * hold it, which is logged loudly and marked on the handle; it is not a reason
 * to abort work that may already have written something.
 */
function startWatchdog(lockKey: string, handle: Mutable<LockHandle>): () => void {
  const redis = scripts();
  const interval = Math.max(1_000, Math.floor(config.LOCK_TTL_MS / 3));

  const timer = setInterval(() => {
    void redis
      .lockRenew(lockKey, handle.token, String(config.LOCK_TTL_MS))
      .then((renewed) => {
        if (renewed === 1) {
          counters.renewals += 1;
          return;
        }
        if (handle.valid) {
          handle.valid = false;
          counters.lost += 1;
          logger.error(
            { waId: handle.key, token: handle.token, fence: handle.fence },
            'candidate lock expired while still in use — another instance may now hold it',
          );
        }
      })
      .catch((err) => logger.warn({ err, waId: handle.key }, 'candidate lock renewal failed'));
  }, interval);

  timer.unref();
  return () => clearInterval(timer);
}

/* ------------------------------------------------------------------ */
/* The local half                                                      */
/* ------------------------------------------------------------------ */

/**
 * Per-key promise chain. The original implementation, kept deliberately.
 *
 * With Redis it is the first gate — same-process contention settled without a
 * round trip. Without Redis it is the whole lock, and correct for exactly one
 * instance, which is what local development is.
 */
const chains = new Map<string, Promise<unknown>>();

async function withLocalChain<T>(candidate: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(candidate) ?? Promise.resolve();
  // Run whether or not the previous holder succeeded — one candidate's failure
  // must not wedge the queue behind them.
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(candidate, tail);

  try {
    return await run;
  } finally {
    // Only clear if nothing queued behind us in the meantime.
    if (chains.get(candidate) === tail) chains.delete(candidate);
  }
}

/* ------------------------------------------------------------------ */
/* The lock                                                            */
/* ------------------------------------------------------------------ */

/**
 * Runs `fn` holding an exclusive lock on `key`, fleet-wide.
 *
 * The signature is unchanged from the in-memory version it replaces, so every
 * existing call site — the inbound worker, the OCR completion path, the idle
 * session sweep — was left exactly as it was. The callback may now accept a
 * `LockHandle` if it wants the fence; none currently does.
 *
 * Throws `LockTimeoutError` if the lock cannot be had in time. Callers that run
 * inside a job should let it propagate: a failed job is retried, and a turn
 * deferred by a few seconds is a much better outcome than a turn executed
 * beside another one.
 */
export async function withCandidateLock<T>(
  candidate: string,
  fn: (lock?: LockHandle) => Promise<T>,
): Promise<T> {
  // No Redis: one instance, one map, exactly the behaviour this had before.
  if (!redisEnabled()) {
    return withLocalChain(candidate, () => fn());
  }

  const lockKey = key('lock', 'candidate', candidate);

  return withLocalChain(candidate, async () => {
    const handle = await acquireRedisLock(lockKey, candidate);
    const stopWatchdog = startWatchdog(lockKey, handle);
    held.add(lockKey);

    try {
      return await fn(handle);
    } finally {
      stopWatchdog();
      held.delete(lockKey);
      try {
        // Compare-and-swap: releases our own lock and never a successor's.
        await scripts().lockRelease(lockKey, handle.token);
      } catch (err) {
        // The TTL is the backstop. A release that failed costs the next holder
        // a wait, not correctness.
        logger.warn({ err, waId: candidate }, 'candidate lock release failed; it will expire');
      }
    }
  });
}
