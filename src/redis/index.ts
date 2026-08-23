/**
 * The one place a Redis connection is opened.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Redis is what makes more than one instance of this bot safe to run. Three
 *  things depend on it and each is a correctness boundary, not an optimisation:
 *
 *    the job queue        so a turn is executed once, by one worker, and
 *                         survives the restart of whichever process accepted it
 *    the candidate lock   so two instances cannot answer the same candidate at
 *                         the same time (`queue/lock.ts`)
 *    the rate limiters    so N instances share Meta's 20/sec rather than
 *                         spending 20/sec each (`whatsapp/rateLimiter.ts`)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Without `REDIS_URL` every one of those falls back to a per-process
 * implementation that is correct for exactly one instance. That is the right
 * behaviour for local development and it is why the fallbacks exist; it is also
 * why `ROLE`-based deployment refuses to start without Redis, because a second
 * instance silently sharing nothing is the failure this module exists to
 * prevent.
 *
 * Connections are pooled by purpose rather than shared globally. BullMQ needs
 * `maxRetriesPerRequest: null` — it holds blocking reads open indefinitely and
 * ioredis' default retry ceiling would tear them down — while the lock and the
 * limiters want the opposite: a bounded number of retries, so a Redis that has
 * gone away surfaces as an error a caller can handle rather than a promise that
 * never settles.
 */

import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** Whether this process has a Redis to talk to at all. */
export function redisEnabled(): boolean {
  return Boolean(config.REDIS_URL);
}

/**
 * The Redis URL, or a refusal that says what to do about it.
 *
 * Called by anything that cannot degrade — the `worker` and `scheduler` roles,
 * and `web` when more than one instance is expected. The message names the
 * variable rather than the symptom, because the symptom (two bots answering one
 * candidate) shows up hours later in a transcript and not at boot.
 */
export function requireRedisUrl(reason: string): string {
  if (!config.REDIS_URL) {
    throw new Error(
      `REDIS_URL is required for ${reason}. Without it this process keeps its queue, ` +
        `its candidate locks and its rate limits in local memory, which is only correct ` +
        `when exactly one instance is running.`,
    );
  }
  return config.REDIS_URL;
}

/**
 * Every key this application writes, under one prefix.
 *
 * So a Redis shared with another service — or with a staging copy of this one —
 * cannot have its keys collided with. Read from config rather than hardcoded
 * for exactly that reason: two deployments against one Redis is a deployment
 * decision, not a code change.
 */
export function key(...parts: Array<string | number>): string {
  return [config.REDIS_KEY_PREFIX, ...parts].join(':');
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

/** Open connections, so shutdown can close all of them and none is forgotten. */
const open = new Map<string, Redis>();

/**
 * Logs connection trouble once per state change rather than once per attempt.
 *
 * ioredis retries on a timer, and an unreachable Redis emits an error on every
 * one of those attempts. Logging each is how a five-minute outage produces a
 * hundred thousand identical lines and buries whatever else happened during it.
 */
function attachLogging(connection: Redis, purpose: string): void {
  let lastState = 'connecting';

  const state = (next: string, level: 'info' | 'warn' | 'error', err?: unknown) => {
    if (next === lastState) return;
    lastState = next;
    logger[level]({ purpose, err }, `redis ${next}`);
  };

  connection.on('ready', () => state('ready', 'info'));
  connection.on('end', () => state('disconnected', 'warn'));
  connection.on('reconnecting', () => state('reconnecting', 'warn'));
  connection.on('error', (err: unknown) => state('error', 'error', err));
}

/**
 * Opens — or returns — the connection for one purpose.
 *
 * Keyed by purpose so the queue's blocking reads never share a socket with a
 * lock acquisition. ioredis multiplexes commands on one connection, and a
 * blocking `BRPOPLPUSH` on a shared socket holds every other command behind it.
 */
export function redisFor(purpose: string, overrides: RedisOptions = {}): Redis {
  const existing = open.get(purpose);
  if (existing) return existing;

  const url = requireRedisUrl(`the "${purpose}" connection`);

  const connection = new Redis(url, {
    // Names the client in `CLIENT LIST`, so a connection leak can be traced to
    // the subsystem that opened it rather than to "the bot".
    connectionName: `adira-${purpose}`,
    // Bounded by default. BullMQ overrides this to null; nothing else should.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Backoff, capped. The default climbs without limit, which turns a Redis
    // restart into minutes of avoidable downtime for a process that is
    // otherwise healthy.
    retryStrategy: (attempt) => Math.min(attempt * 200, 3_000),
    ...overrides,
  });

  attachLogging(connection, purpose);
  open.set(purpose, connection);
  return connection;
}

/**
 * The general-purpose connection: locks, limiters, leader election, metrics.
 *
 * All of it is small, fast, non-blocking command traffic, so one multiplexed
 * socket is the right shape — and a shared one keeps the connection count per
 * instance to something a modest Redis can serve when the fleet grows.
 */
export function sharedRedis(): Redis {
  return redisFor('shared');
}

/** Whether Redis answers. Used by `/health`, `doctor`, and the role preflight. */
export async function pingRedis(timeoutMs = 2_000): Promise<{ ok: boolean; error?: string }> {
  if (!redisEnabled()) return { ok: false, error: 'REDIS_URL is not set' };

  try {
    const pong = await Promise.race([
      sharedRedis().ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`redis did not answer within ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return { ok: pong === 'PONG' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Closes every connection this module opened. Called once, from shutdown. */
export async function closeRedis(): Promise<void> {
  const connections = [...open.values()];
  open.clear();
  await Promise.all(
    connections.map(async (connection) => {
      try {
        // `quit` drains in-flight commands; `disconnect` would drop them.
        await connection.quit();
      } catch {
        connection.disconnect();
      }
    }),
  );
}
