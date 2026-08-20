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

  VERIS_OCR_BASE_URL: z.string().min(1),
  VERIS_OCR_API_KEY: z.string().min(1),
  VERIS_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

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

  OUTBOUND_RATE_PER_SECOND: z.coerce.number().int().positive().default(20),

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
