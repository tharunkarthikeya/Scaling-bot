import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .transform((v) => v.trim().toLowerCase() === 'true')
  .pipe(z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().min(1),

  // Omit to fall back to the in-process queue (local dev only — jobs are lost on restart).
  REDIS_URL: z.string().min(1).optional(),

  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_WABA_ID: z.string().min(1).optional(),
  WHATSAPP_GRAPH_API_VERSION: z.string().default('v25.0'),

  WHATSAPP_REENGAGEMENT_TEMPLATE: z.string().min(1).optional(),
  WHATSAPP_REENGAGEMENT_TEMPLATE_LANG: z.string().default('en'),

  ANTHROPIC_API_KEY: z.string().min(1),
  // Model is read from env so it can be changed without touching code.
  CLAUDE_MODEL: z.string().default('claude-opus-5'),

  /* ---------------------------------------------------------------- */
  /* Model resilience (see `conversation/model.ts`)                     */
  /* ---------------------------------------------------------------- */

  /**
   * Retries after the first attempt, so 2 means three tries in all.
   *
   * The SDK does the retrying — exponential backoff with jitter, honouring
   * `retry-after-ms` and `retry-after`, for 408, 409, 429 and 5xx. This states
   * the number rather than inheriting it, because a retry budget that nobody
   * declared is one nobody reasons about.
   *
   * Raising it does not buy much. If three attempts spread over a second and a
   * half all come back throttled, the problem is the rate we are asking at, not
   * the number of times we ask.
   */
  MODEL_MAX_RETRIES: z.coerce.number().int().min(0).default(2),

  /**
   * Per-request ceiling, retries included. A candidate is waiting at the other
   * end of this, and a reply that arrives after they have given up is not a
   * reply.
   */
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /**
   * Model calls allowed in flight at once.
   *
   * A bound on *our* fan-out, not a claim about Anthropic's limits, which are
   * an account fact this code has no business guessing. Matched to
   * `QUEUE_CONCURRENCY_INBOUND` because that is what actually generates the
   * calls: a turn makes at most one interpretation and at most one reply, in
   * sequence, so eight workers cannot exceed eight in flight by much.
   *
   * The reason to have a ceiling at all is that the response to a rate limit is
   * retries, and retries from every worker at once are what turn a busy minute
   * into a sustained one.
   */
  MODEL_MAX_CONCURRENCY: z.coerce.number().int().positive().default(8),

  /**
   * Calls allowed to queue for a slot before we stop accepting them.
   *
   * Waiting is bounded on purpose. An unbounded queue holds a promise, a
   * payload and a worker for every turn that ever backed up, and it converts a
   * throttled minute into an out-of-memory hour. Past this, a call is refused
   * immediately and the candidate is asked to send their message again — which
   * is a worse answer than a real one and a much better answer than silence.
   */
  MODEL_MAX_QUEUED: z.coerce.number().int().min(0).default(32),

  VERIS_OCR_BASE_URL: z.string().min(1),
  VERIS_OCR_API_KEY: z.string().min(1),
  VERIS_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /**
   * Use the Veris async Jobs API instead of the synchronous extract routes.
   *
   * Off by default, and deliberately so: the synchronous path is what has been
   * in production, and it stays the default until the async path has been through
   * staging against the real service. Flipping this changes only how an
   * extraction is fetched — the normalisers, the completeness verdicts and the
   * conversation behaviour are identical on both sides.
   *
   * The deployed service currently answers the synchronous routes with
   * `503 ocr_queue_required`, so with this off, extraction fails and every
   * upload becomes a review task. That is the bug this flag exists to fix; it is
   * off because the fix should be proven before it is trusted, not because the
   * old path works.
   */
  VERIS_OCR_ASYNC: bool.default('false'),

  /**
   * How long an extraction may remain unfinished before the sweep gives up.
   *
   * A backstop, not a schedule. Veris runs its own retries and reports
   * `attempts`, `max_attempts` and `next_attempt_at`; a job that is still inside
   * that budget is working, not stuck, and the sweep leaves it alone however
   * long it has been — see `hasOutlivedItsDeadline`. This bounds the case where
   * the service stops answering about a job at all, which is the only case where
   * nothing else will ever release the candidate.
   */
  VERIS_OCR_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),

  /**
   * Poll pacing, used only when the server offers no opinion.
   *
   * `next_attempt_at` is preferred over both of these, and a `Retry-After`
   * header over the computed value — the service knows when it will next have
   * something to say and we do not.
   */
  VERIS_OCR_POLL_MIN_MS: z.coerce.number().int().positive().default(2_000),
  VERIS_OCR_POLL_MAX_MS: z.coerce.number().int().positive().default(15_000),

  /**
   * How often the extraction sweep looks for work.
   *
   * Frequent and cheap: a tick that finds nothing due is one indexed query per
   * document section. The interval is the lag between a job finishing at Veris
   * and the candidate hearing about it, so it wants to be well under a second's
   * worth of patience rather than tuned for throughput.
   */
  OCR_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),

  /**
   * How long a sweep claim is honoured before another tick may take it.
   *
   * Long enough that a slow poll is not stolen mid-flight, short enough that a
   * process killed while holding a claim does not strand the upload for long.
   */
  OCR_CLAIM_STALE_MS: z.coerce.number().int().positive().default(120_000),


  STORAGE_PATH: z.string().default('./storage'),

  // Guards the read-only /api/* endpoints, which expose candidate PII —
  // names, passport numbers, transcripts. Unset means those routes are not
  // served at all, which is the safe default for a public deployment.
  ADMIN_API_KEY: z.string().min(16).optional(),

  // true  = process inbound and decide a reply, but never hand it to Meta.
  // false = actually send.
  SHADOW_MODE: bool.default('false'),

  // Test-only. Serves a canned file instead of calling Meta's media API, so the
  // document path can be exercised without a real media id. Never set in production:
  // in shadow mode against real traffic you still want the real download.
  MOCK_WHATSAPP_MEDIA: bool.default('false'),

  /**
   * Candidate replies per second — and nothing else.
   *
   * This is Meta's messaging throughput for the number, so the value is theirs
   * and not ours to raise. What changed is what spends it: read receipts and
   * media downloads used to draw on this same budget, which meant roughly half
   * of a 20/sec allowance went on acknowledging messages rather than answering
   * them. They have their own budgets below.
   *
   * One token per message Meta receives, so a reply long enough to be split by
   * `chunkText` spends one per chunk — because that is what Meta counts.
   */
  OUTBOUND_RATE_PER_SECOND: z.coerce.number().int().positive().default(20),

  /**
   * Read receipts per second.
   *
   * Separate from replies because they are a different operation on Meta's
   * side and must never compete with an answer a candidate is waiting for.
   * Bounded rather than unlimited: still a Graph call, still someone else's
   * capacity.
   *
   * Dropped rather than queued when the budget is empty — see `markAsRead`. A
   * blue tick that arrives late is worth less than the memory it costs to
   * remember it.
   */
  READ_RECEIPT_RATE_PER_SECOND: z.coerce.number().int().positive().default(20),

  /**
   * Inbound media fetches per second.
   *
   * Two Graph requests per document — resolve the id, then fetch the bytes —
   * and neither is a message, so neither belongs in the messaging budget. This
   * one runs inside the webhook before the acknowledgement, so its own bucket
   * also keeps document traffic from adding reply-queue latency to every ACK.
   *
   * Lower than the others on purpose: documents arrive far less often than
   * messages, and each one holds a buffer in memory while it is read.
   */
  MEDIA_DOWNLOAD_RATE_PER_SECOND: z.coerce.number().int().positive().default(10),

  /**
   * The largest inbound file this bot will hold, in bytes. Ten megabytes.
   *
   * Meta's own ceiling for a document is 100 MB, and accepting that here would
   * be a promise this machine cannot keep. One instance, four cores, sixteen
   * gigabytes: each document in flight costs roughly twice its own size before
   * OCR has read a word of it — the buffer the download produced, and the copy
   * the multipart body makes of it — and three extractions may be in flight at
   * once. The SHA-256 taken on the way in is a further ~1 ms per megabyte,
   * synchronous, inside the webhook and ahead of the acknowledgement.
   *
   * Ten megabytes is well past what the documents this bot asks for actually
   * weigh. A passport booklet photographed page by page, a CV, an Aadhaar card,
   * a trade certificate: these are hundreds of kilobytes, a few megabytes for a
   * generous scan. A file above ten is a camera setting, not a document, and
   * the candidate is better served by being told so than by a silent OOM.
   *
   * Enforced in three places, because the first two are only claims — see
   * `downloadMedia`. Raise it in the Dokploy Environment tab if a real document
   * is ever refused; there is no code change behind it.
   */
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  /* ---------------------------------------------------------------- */
  /* Queue concurrency                                                 */
  /*                                                                   */
  /* THIS IS WHERE WORKER CONCURRENCY IS TUNED. Set these in the        */
  /* Dokploy Environment tab; no code change and no redeploy of the     */
  /* image is needed to change them, only a restart.                    */
  /*                                                                   */
  /* One pool per job name, each with its own bound — so a saturated    */
  /* extraction queue cannot starve inbound conversation. The totals    */
  /* matter more than any single value: the defaults below allow at     */
  /* most 13 jobs in flight at once.                                    */
  /*                                                                   */
  /* Almost all of this work is I/O — a model call, a Mongo round trip, */
  /* a Graph request — so these are not core counts and should not be   */
  /* set from `nproc`. What actually bounds them is the slowest thing   */
  /* downstream, and today that is the outbound rate limiter.           */
  /* ---------------------------------------------------------------- */

  /**
   * Candidate turns handled in parallel.
   *
   * Default 8. A turn takes roughly 0.6s on average — about a second when it
   * reaches the model, near-instant when the reply is a button tap the
   * interpreter resolves locally — so eight slots offer something like 13
   * turns a second. That is deliberately close to, and not far beyond, what
   * the outbound limiter can currently drain: concurrency past the point
   * where replies can actually be sent does not buy throughput, it just moves
   * the queue somewhere less visible.
   *
   * Raise this once the outbound path is widened, and raise it to a number
   * measured under load rather than a number that sounds bigger.
   */
  QUEUE_CONCURRENCY_INBOUND: z.coerce.number().int().positive().default(8),

  /**
   * Document extractions in parallel.
   *
   * Deliberately the smallest of the three. Each one holds the file in memory,
   * spends up to `VERIS_OCR_TIMEOUT_MS` waiting on a third party, and inspects
   * the bytes on the way in — work that blocks the event loop for as long as it
   * takes. Three keeps documents moving without turning a slow vendor into a
   * stalled server, and the real ceiling is Veris' own concurrency limit, which
   * is theirs to state and not ours to assume.
   */
  QUEUE_CONCURRENCY_OCR: z.coerce.number().int().positive().default(3),

  /**
   * CRM submissions in parallel.
   *
   * Two is enough. These fire once per completed registration, they are
   * idempotent by key, and anything that fails is picked up by the reconcile
   * sweep — so depth here costs nothing and speed buys nothing.
   */
  QUEUE_CONCURRENCY_CRM_SYNC: z.coerce.number().int().positive().default(2),

  /* ---------------------------------------------------------------- */
  /* Ingestion (see `automation-integration.md` and `ingestion/`)       */
  /* ---------------------------------------------------------------- */

  /**
   * Submission attempts before an attachment stops being retried and becomes a
   * review task. Counts attempts to get the bytes and attempts to get them
   * extracted; both leave the same row unfinished and both are worth the same
   * number of goes.
   */
  INGESTION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /**
   * How often the reconciler sweeps for attachments that are still received,
   * stored, submitting or running.
   *
   * The spec asks for a periodic sweep rather than relying on the queue's own
   * retries, because the failures worth catching are the ones where the queue
   * never got the job at all.
   */
  INGESTION_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60_000),

  /**
   * How long an attachment may sit unfinished before the reconciler treats it
   * as stuck and submits it again under the same idempotency key.
   *
   * Comfortably longer than a slow extraction: VERIS_OCR_TIMEOUT_MS is 120s by
   * default, and re-submitting something that is merely slow wastes an
   * extraction and races the result that is already coming.
   */
  INGESTION_STALE_AFTER_MS: z.coerce.number().int().positive().default(15 * 60_000),

  /**
   * Queue age that constitutes an alert, in milliseconds.
   *
   * Age, not count — the spec is specific about this and it is the right call.
   * Four attachments that arrived a minute ago are a working queue; one that
   * arrived on Tuesday is an incident, and a count cannot tell them apart.
   */
  INGESTION_QUEUE_AGE_ALERT_MS: z.coerce.number().int().positive().default(30 * 60_000),

  /* ---------------------------------------------------------------- */
  /* Recruitment CRM                                                   */
  /*                                                                   */
  /* The CRM is the system of record for candidates once registration  */
  /* completes. This bot collects and submits; it never writes to the  */
  /* CRM's database, and it does not reimplement anything the CRM      */
  /* already does — assignment, evaluation, SLA all stay there.        */
  /* ---------------------------------------------------------------- */

  /**
   * Base URL of the CRM API. Omit to run without a CRM: registrations still
   * complete and are still stored here, and their sync status stays `pending`
   * rather than failing, so nothing is lost if the CRM is added later.
   */
  CRM_API_URL: z.string().min(1).optional(),
  /**
   * The bot's service credential, sent as `X-Service-Key`.
   *
   * Not a staff login. The CRM authenticates this separately from its
   * recruiters precisely so that neither credential can stand in for the other.
   */
  CRM_API_KEY: z.string().min(1).optional(),
  CRM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * Submission attempts before a candidate is left for an operator.
   *
   * The record is never discarded — a failed sync means the CRM did not get it
   * yet, not that the registration did not happen.
   */
  CRM_SYNC_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Fail at boot, not on the first candidate's resume.
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

export const graphBaseUrl = `https://graph.facebook.com/${config.WHATSAPP_GRAPH_API_VERSION}`;
