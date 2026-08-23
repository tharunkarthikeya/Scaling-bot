/**
 * The one Anthropic client, and the ceiling on how hard we lean on it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS WHERE MODEL RETRIES AND FAN-OUT ARE TUNED. The numbers live in
 *  `config.ts`; the behaviour lives here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Five places used to construct their own `Anthropic` instance — the
 * interpreter, the FAQ, the two in-context replies, and the trade-question
 * writer. Five clients, one API key, and no idea of each other. With one job in
 * flight that was merely untidy. With eight it is a fan-out nobody bounds: every
 * worker that hits a rate limit retries, and the retries arrive together.
 *
 * What this file does *not* do is reimplement backoff. The SDK already retries
 * 408, 409, 429 and 5xx, already honours `retry-after-ms` and `retry-after`, and
 * already applies exponential backoff with jitter — 0.5s doubling to a cap of
 * 8s, minus up to a quarter. Writing that again would be writing it worse. What
 * it does is state those settings out loud instead of inheriting them silently,
 * and add the two things the transport cannot know about:
 *
 *   A ceiling on concurrent calls, so a throttled minute does not become a
 *   thundering herd. Retrying harder is the one response to a rate limit that
 *   reliably makes it worse.
 *
 *   A distinction between "the model said no" and "we could not ask". Without
 *   it, `interpret` returns `unclear` when Anthropic is busy, `unclear` is
 *   counted as a reply the bot could not read, and two of those in a row hand
 *   the candidate to a member of staff — for a fault that was entirely ours.
 *   That is what `ModelUnavailableError` exists to prevent.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { modelBudget } from '../whatsapp/rateLimiter.js';

/**
 * Raised when a call could not be completed for a reason that is ours or
 * Anthropic's, and never the candidate's.
 *
 * Callers must not treat this as an answer. It means the question was never
 * put, so nothing may be recorded and nothing may be counted against the
 * candidate.
 */
export class ModelUnavailableError extends Error {
  constructor(
    readonly label: string,
    readonly status: number | undefined,
    override readonly cause: unknown,
  ) {
    super(`model unavailable during "${label}"${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ModelUnavailableError';
  }
}

/**
 * Retry settings, stated rather than inherited.
 *
 * Exported so a test can build a client that behaves exactly like the real one
 * against a stub server — the alternative is testing a different configuration
 * from the one that ships.
 */
export const MODEL_REQUEST_OPTIONS = {
  maxRetries: config.MODEL_MAX_RETRIES,
  timeout: config.MODEL_TIMEOUT_MS,
} as const;

let client = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  ...MODEL_REQUEST_OPTIONS,
});

/** The shared client. Every model call in the application goes through it. */
export function modelClient(): Anthropic {
  return client;
}

/**
 * Swaps the client. Tests only — it is how the retry behaviour is exercised
 * against a stub server without a network or a key.
 */
export function setModelClientForTests(replacement: Anthropic): () => void {
  const previous = client;
  client = replacement;
  return () => {
    client = previous;
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Which failures are worth trying again
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Statuses the SDK will already have retried to exhaustion by the time we see
 * them. Seeing one here means the retries did not help, not that none happened.
 */
const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Whether a failure is Anthropic being unavailable rather than us being wrong.
 *
 * The distinction is the point of this module. A 400 is a malformed request — a
 * bug in a prompt or a tool definition — and retrying it produces the same 400
 * forever while a candidate waits. A 401 is a bad key, and no amount of waiting
 * fixes it. Neither is throttling and neither may be dressed up as it, or a
 * genuine defect becomes invisible behind a "busy, try again" message.
 */
function isTransient(err: unknown): { transient: boolean; status?: number } {
  const status = (err as { status?: unknown } | undefined)?.status;
  if (typeof status === 'number') {
    return { transient: TRANSIENT_STATUSES.has(status), status };
  }

  // No status at all: a connection failure or a timeout, which never reached
  // Anthropic and says nothing about whether the request was valid.
  const name = (err as { name?: unknown } | undefined)?.name;
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
    return { transient: true };
  }
  if (err instanceof Error && /timeout|aborted|ECONNRESET|ETIMEDOUT/i.test(err.message)) {
    return { transient: true };
  }

  return { transient: false };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The fan-out ceiling
 * ───────────────────────────────────────────────────────────────────────────*/

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

let inFlight = 0;
const waiting: Waiter[] = [];

/** Counters for the load-test report. Cheap, and the only way to see throttling. */
const counters = { calls: 0, transient: 0, shed: 0, failed: 0 };

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) {
    // Hand the slot straight over rather than decrementing and racing.
    next.resolve();
    return;
  }
  inFlight -= 1;
}

async function takeSlot(label: string): Promise<void> {
  if (inFlight < config.MODEL_MAX_CONCURRENCY) {
    inFlight += 1;
    return;
  }

  // Queueing without a bound is how a slow minute becomes an out-of-memory
  // hour: every waiting turn holds a promise, a payload and a worker. Past the
  // cap the honest answer is that we cannot serve this one.
  if (waiting.length >= config.MODEL_MAX_QUEUED) {
    counters.shed += 1;
    logger.warn(
      { label, inFlight, waiting: waiting.length },
      'model call shed: the concurrency gate is full and its queue is at its limit',
    );
    throw new ModelUnavailableError(label, undefined, 'model concurrency queue full');
  }

  await new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The call
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Runs one model call under the concurrency ceiling, and classifies what comes
 * back out.
 *
 * `label` names the call site in the logs, so a throttling incident says which
 * part of the conversation was affected rather than only that something was.
 *
 * Throws `ModelUnavailableError` when Anthropic could not answer. Anything else
 * — a malformed request, a bad key — propagates unchanged to the caller's own
 * error handling, which is where it was already dealt with.
 */
export async function callModel<T>(label: string, run: () => Promise<T>): Promise<T> {
  await takeSlot(label);

  // The local slot is taken first on purpose. It is what bounds the number of
  // calls that can be *waiting* here, and the wait below is unbounded in time.
  // Queueing on the global limiter before the local gate would let every worker
  // in the fleet pile into an unbounded wait, which is the memory failure the
  // local gate exists to prevent.
  //
  // Undefined unless MODEL_RATE_PER_SECOND is set, in which case this is the one
  // place the whole fleet is paced against Anthropic's per-minute quota.
  if (modelBudget) {
    const waitedFrom = Date.now();
    await modelBudget.acquire();
    const waited = Date.now() - waitedFrom;
    if (waited > 1_000) {
      logger.warn({ label, waitedMs: waited }, 'waited on the fleet-wide model rate limit');
    }
  }

  counters.calls += 1;

  const startedAt = Date.now();
  try {
    return await run();
  } catch (err) {
    const { transient, status } = isTransient(err);

    if (transient) {
      counters.transient += 1;
      // Warn, not error: this is a working system under load, and the retries
      // the SDK already made are not visible from here. The count is what
      // matters — one is weather, a hundred a minute is a capacity problem.
      logger.warn(
        { label, status, elapsedMs: Date.now() - startedAt, throttled: counters.transient },
        'anthropic unavailable after the client exhausted its retries',
      );
      throw new ModelUnavailableError(label, status, err);
    }

    counters.failed += 1;
    logger.error({ err, label, status }, 'anthropic call failed and is not worth retrying');
    throw err;
  } finally {
    releaseSlot();
  }
}

/** In-flight, queued, and what has gone wrong. Read by the load-test report. */
export function modelStats(): {
  inFlight: number;
  waiting: number;
  concurrency: number;
  calls: number;
  transient: number;
  shed: number;
  failed: number;
} {
  return {
    inFlight,
    waiting: waiting.length,
    concurrency: config.MODEL_MAX_CONCURRENCY,
    ...counters,
  };
}

/** Resets the counters and the gate. Tests only. */
export function resetModelStatsForTests(): void {
  counters.calls = 0;
  counters.transient = 0;
  counters.shed = 0;
  counters.failed = 0;
  inFlight = 0;
  waiting.length = 0;
}
