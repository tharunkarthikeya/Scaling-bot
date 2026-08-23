/**
 * A second bot instance, for the tests that need one to be real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why a whole process. `withCandidateLock` puts a per-key promise chain in
 *  front of the Redis lock, so two callers *inside one process* are serialised
 *  by the chain and never reach the part being tested. A test that ran both
 *  halves in one process would pass whether or not the Redis lock existed,
 *  which is the most expensive kind of green.
 *
 *  So the parent forks two of these. Each has its own module registry, its own
 *  chain, its own instance id and its own Redis connection — which is exactly
 *  what two containers behind a load balancer have.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Not a test itself. It performs one instruction and reports what happened
 * through Redis, and the parent decides whether that was correct.
 *
 *   node --import tsx src/testing/scalingChild.ts lock <waId> <holdMs> <key>
 *   node --import tsx src/testing/scalingChild.ts rate <budget> <attempts> <key>
 */

import { instanceId } from '../config.js';
import { sharedRedis, closeRedis, key as nsKey } from '../redis/index.js';
import { withCandidateLock } from '../queue/lock.js';
import { RedisRateLimiter } from '../whatsapp/rateLimiter.js';

const [mode, target, amount, runKey] = process.argv.slice(2);
const redis = sharedRedis();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holds the candidate lock and reports whether anyone else held it at the same
 * time.
 *
 * The proof is a counter rather than a pair of timestamps: `INCR` on entry
 * returns the number of holders *including this one*, atomically, so a value
 * above 1 is direct evidence of overlap and needs no clock the two processes
 * would have to agree on.
 */
async function lockMode(): Promise<void> {
  const holdMs = Number(amount);
  const holders = nsKey('test', runKey!, 'holders');
  const observed = nsKey('test', runKey!, 'observed');
  const ran = nsKey('test', runKey!, 'ran');

  await withCandidateLock(target!, async () => {
    const concurrent = await redis.incr(holders);

    // The high-water mark across both processes. Anything but 1 means the lock
    // did not hold.
    await redis.rpush(observed, String(concurrent));
    await redis.rpush(ran, instanceId);

    // Long enough that a broken lock would certainly overlap. The parent starts
    // both children at once, so any exclusion failure lands inside this window.
    await sleep(holdMs);

    await redis.decr(holders);
  });
}

/**
 * Spends as much of a shared budget as it can, and reports what it got.
 *
 * `tryAcquire` rather than `acquire`, because the question is how many tokens
 * exist and not how long it takes to wait for more.
 */
async function rateMode(): Promise<void> {
  const attempts = Number(amount);
  const limiter = new RedisRateLimiter(10, target!);

  let granted = 0;
  for (let i = 0; i < attempts; i++) {
    if (await limiter.tryAcquire()) granted += 1;
  }

  await redis.rpush(nsKey('test', runKey!, 'granted'), String(granted));
}

try {
  if (mode === 'lock') await lockMode();
  else if (mode === 'rate') await rateMode();
  else throw new Error(`unknown mode "${mode}"`);

  await closeRedis();
  process.exit(0);
} catch (err) {
  console.error(`child ${instanceId} failed:`, err);
  await closeRedis().catch(() => undefined);
  process.exit(1);
}
