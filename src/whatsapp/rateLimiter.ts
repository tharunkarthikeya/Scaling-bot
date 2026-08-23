/**
 * Outbound budgets, shared by every instance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE TRAP THIS MODULE EXISTS TO CLOSE. A token bucket in process memory is
 *  correct for one process and actively harmful for three. Meta's 20/sec is a
 *  limit on the phone number, not on the container: three instances each
 *  holding a local 20/sec bucket send 60/sec, and Meta *drops* the overage
 *  rather than queueing it. Scaling out would have made delivery worse while
 *  every instance reported itself as comfortably within its limit.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * So the bucket moved into Redis, where there is one of it. The arithmetic is
 * the same arithmetic as before — capacity, refill rate, tokens — but it runs
 * inside a Lua script, which Redis executes to completion before anything else
 * touches the key. Two instances asking at the same instant are serialised by
 * Redis rather than by luck.
 *
 * There is still an instance per budget rather than one for everything, and that
 * separation is as load-bearing as it ever was: read receipts and media
 * downloads used to spend capacity that Meta grants for *sending messages*, so a
 * candidate's reply queued behind the acknowledgement of their own last one.
 *
 * Without `REDIS_URL` this falls back to the local bucket, which is what it
 * always was and is correct for exactly one instance.
 *
 * ## Why the API is async now
 *
 * `tryAcquire()` used to be synchronous and return a boolean. A shared bucket
 * lives across a socket, so it cannot be. The one call site that cared —
 * `markAsRead`, which drops a read receipt rather than queueing it — awaits it
 * now. The semantics are unchanged: `tryAcquire` still never waits for a token,
 * it just has to ask Redis whether there is one.
 */

import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { key, redisEnabled, sharedRedis } from '../redis/index.js';

/**
 * One class of outbound traffic, and what it is allowed to spend.
 *
 * Implemented locally and in Redis. Callers never learn which they got, which
 * is what lets a single-instance development run behave like production without
 * a Redis.
 */
export interface Budget {
  /** Names the budget in metrics and in the Redis key. */
  readonly name: string;
  /** Tokens per second, which is also the burst ceiling. */
  readonly perSecond: number;

  /**
   * Waits for a token. For traffic that must not be lost — a reply, a document.
   */
  acquire(): Promise<void>;

  /**
   * Takes a token if one is free, and reports whether it got one. Never waits
   * for a token to become available.
   *
   * For traffic that is better dropped than delayed. A read receipt is a blue
   * tick: worth sending when there is room and worth forgetting when there is
   * not. Queueing them instead would pile up promises nobody is waiting on for
   * exactly as long as the overload lasts.
   */
  tryAcquire(): Promise<boolean>;

  /** Tokens free right now. For tests and for the metrics gauge. */
  available(): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

interface BudgetCounters {
  granted: number;
  refused: number;
  waited: number;
  waitMsTotal: number;
  waitMsMax: number;
}

const counters = new Map<string, BudgetCounters>();

function countersFor(name: string): BudgetCounters {
  let found = counters.get(name);
  if (!found) {
    found = { granted: 0, refused: 0, waited: 0, waitMsTotal: 0, waitMsMax: 0 };
    counters.set(name, found);
  }
  return found;
}

function recordWait(name: string, waitedMs: number): void {
  const c = countersFor(name);
  if (waitedMs <= 0) return;
  c.waited += 1;
  c.waitMsTotal += waitedMs;
  c.waitMsMax = Math.max(c.waitMsMax, waitedMs);
}

/**
 * How long callers spent queued for each budget.
 *
 * This is the number that says whether the outbound path is the bottleneck.
 * Rising wait on `replies` with a flat queue depth means the limiter is the
 * constraint and no amount of extra worker concurrency will help.
 */
export function limiterStats(): Record<
  string,
  { granted: number; refused: number; waited: number; waitMsAvg: number; waitMsMax: number; distributed: boolean }
> {
  return Object.fromEntries(
    [...counters.entries()].map(([name, c]) => [
      name,
      {
        granted: c.granted,
        refused: c.refused,
        waited: c.waited,
        waitMsAvg: c.waited ? Math.round(c.waitMsTotal / c.waited) : 0,
        waitMsMax: c.waitMsMax,
        distributed: redisEnabled(),
      },
    ]),
  );
}

/** Tests only. */
export function resetLimiterStatsForTests(): void {
  counters.clear();
}

/* ------------------------------------------------------------------ */
/* Local                                                               */
/* ------------------------------------------------------------------ */

/**
 * The in-process token bucket. Correct for one instance.
 *
 * Unchanged arithmetic from the version that predates Redis: tokens refill
 * continuously at `perSecond`, and the bucket never holds more than one
 * second's worth, so a burst can never exceed the configured ceiling.
 */
export class LocalRateLimiter implements Budget {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    readonly perSecond: number,
    readonly name = 'local',
  ) {
    this.tokens = perSecond;
  }

  async acquire(): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      if (this.take()) {
        countersFor(this.name).granted += 1;
        recordWait(this.name, Date.now() - startedAt);
        return;
      }
      // Wait for roughly one token's worth of time rather than spinning.
      const waitMs = Math.ceil(1000 / this.perSecond);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  async tryAcquire(): Promise<boolean> {
    const got = this.take();
    if (got) countersFor(this.name).granted += 1;
    else countersFor(this.name).refused += 1;
    return got;
  }

  async available(): Promise<number> {
    this.refill();
    return Math.floor(this.tokens);
  }

  private take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.perSecond, this.tokens + elapsed * this.perSecond);
    this.lastRefill = now;
  }
}

/* ------------------------------------------------------------------ */
/* Redis                                                               */
/* ------------------------------------------------------------------ */

/**
 * The same token bucket, in one place, evaluated atomically.
 *
 * `TIME` is read inside the script rather than passed in by the caller, so the
 * bucket is paced by Redis' clock and not by the clock of whichever instance
 * happened to ask. Instances drifting apart by a second would otherwise be able
 * to refill each other's tokens early.
 *
 * The key expires once it has been idle for longer than it takes to refill
 * completely — at that point a fresh key and the key it replaces hold exactly
 * the same thing, a full bucket, so letting it lapse costs nothing and stops an
 * abandoned budget from occupying memory forever.
 */
const TAKE = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local consume = tonumber(ARGV[3])

local clock = redis.call('TIME')
local nowMs = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = nowMs
end

local elapsed = nowMs - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed * rate / 1000))

local granted = 0
local waitMs = 0

if consume == 0 then
  -- A read. Refills, reports, and takes nothing.
  granted = 1
elseif tokens >= 1 then
  tokens = tokens - 1
  granted = 1
else
  -- What the caller would have to wait for the next whole token.
  waitMs = math.ceil(((1 - tokens) / rate) * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', nowMs)
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / rate) * 1000) + 10000)

return {granted, waitMs, math.floor(tokens)}
`;

interface BucketScript {
  rateTake(bucketKey: string, capacity: string, rate: string, consume: string): Promise<[number, number, number]>;
}

let scriptReady: (Redis & BucketScript) | undefined;

function bucketScript(): Redis & BucketScript {
  if (scriptReady) return scriptReady;
  const connection = sharedRedis();
  connection.defineCommand('rateTake', { numberOfKeys: 1, lua: TAKE });
  scriptReady = connection as Redis & BucketScript;
  return scriptReady;
}

/** Tests only — forces the script to be redefined on the next call. */
export function resetLimiterScriptForTests(): void {
  scriptReady = undefined;
}

export class RedisRateLimiter implements Budget {
  private readonly bucketKey: string;

  constructor(
    readonly perSecond: number,
    readonly name: string,
  ) {
    this.bucketKey = key('rate', name);
  }

  async acquire(): Promise<void> {
    const startedAt = Date.now();

    for (;;) {
      const [granted, waitMs] = await this.call(1);

      if (granted === 1) {
        countersFor(this.name).granted += 1;
        recordWait(this.name, Date.now() - startedAt);
        return;
      }

      // Sleep exactly as long as Redis says the next token is away, plus a
      // little jitter. Without the jitter every instance that was refused at the
      // same moment wakes at the same moment and collides again.
      const jitter = Math.random() * 25;
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, waitMs) + jitter));
    }
  }

  async tryAcquire(): Promise<boolean> {
    const [granted] = await this.call(1);
    if (granted === 1) countersFor(this.name).granted += 1;
    else countersFor(this.name).refused += 1;
    return granted === 1;
  }

  async available(): Promise<number> {
    const [, , tokens] = await this.call(0);
    return tokens;
  }

  private async call(consume: 0 | 1): Promise<[number, number, number]> {
    return bucketScript().rateTake(
      this.bucketKey,
      String(this.perSecond),
      String(this.perSecond),
      String(consume),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/**
 * The budget for one class of traffic, distributed when it can be.
 *
 * `name` is part of the Redis key, so two budgets must never share one — that
 * is exactly the bug this module was built to fix, and giving two callers the
 * same name would reintroduce it through the back door.
 */
export function createBudget(name: string, perSecond: number): Budget {
  if (!redisEnabled()) {
    logger.debug({ budget: name, perSecond }, 'rate limit is local to this process');
    return new LocalRateLimiter(perSecond, name);
  }
  return new RedisRateLimiter(perSecond, name);
}

/**
 * Retired name, kept pointing at the local implementation.
 *
 * Nothing in `src/` constructs a limiter directly any more — they come from
 * `createBudget` — but the offline tests build local buckets on purpose, to
 * assert the arithmetic without a Redis.
 */
export { LocalRateLimiter as RateLimiter };

/**
 * A global ceiling on how fast the fleet may call Anthropic.
 *
 * Deliberately a *rate* limit and not a distributed semaphore, because that is
 * what Anthropic actually enforces: requests and tokens per minute, per
 * organisation. A fleet-wide concurrency cap would be a number with no
 * counterpart on their side, and it would need lease expiry and reaping to
 * survive a worker being killed mid-call — machinery whose own failure mode is
 * a leaked lease that throttles the whole fleet to nothing.
 *
 * The per-process ceiling in `conversation/model.ts` stays where it is and does
 * the other half of the job: it bounds fan-out and, more importantly, bounds
 * the *queue* of calls waiting to be made, which is what keeps a throttled
 * minute from becoming an out-of-memory hour. Rate globally, concurrency
 * locally.
 *
 * Off unless `MODEL_RATE_PER_SECOND` is set, because the right number is an
 * account fact this code has no business guessing.
 */
export const modelBudget: Budget | undefined =
  config.MODEL_RATE_PER_SECOND > 0
    ? createBudget('model', config.MODEL_RATE_PER_SECOND)
    : undefined;
