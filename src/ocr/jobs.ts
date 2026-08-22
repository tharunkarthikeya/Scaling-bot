/**
 * The Veris async Jobs API, as a client and nothing else.
 *
 * No database, no conversation, no policy about what an extraction *means* —
 * that all stays in `veris.ts`. This file knows the wire and the wire only,
 * which is what makes the three genuinely uncertain behaviours isolatable
 * rather than smeared across the worker.
 *
 * The contract is taken from the service's own OpenAPI document, captured at
 * `loadtest/tools/veris-openapi.json`:
 *
 *   POST /v1/jobs              multipart: mode, file, lang?      -> 202 JobAccepted
 *   GET  {status_url}                                            -> 200 JobResponse
 *   POST /v1/jobs/{job_id}/retry                                 -> 202 JobAccepted
 *
 * Three things the document does *not* declare, each behind its own function so
 * that a correction later is a one-line change rather than an audit:
 *
 *   isJobQueueFull()        the 503 body for queue admission failure
 *   shouldRetryFailedJob()  whether a `failed` job is ours to retry
 *   nextPollDelayMs()       whether `Retry-After` is ever sent at all
 *
 * Nothing here logs a key, a document, or an extracted value.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';

/** The four states the service reports. Nothing else is valid. */
export type VerisJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** `mode` on the wire. Deliberately narrower than the API's own enum — see below. */
export type VerisJobMode = 'passport' | 'resume' | 'aadhaar';

export interface VerisJobError {
  code: string;
  message: string;
  retryable?: boolean;
}

/** `JobAccepted` — the 202 from a submit or a retry. */
export interface JobAccepted {
  job_id: string;
  mode: string;
  status: VerisJobStatus;
  status_url: string;
  submitted_at: string;
  /** True when the idempotency key matched an existing job. */
  duplicate?: boolean;
}

/** `JobResponse` — the 200 from the status URL. */
export interface JobResponse {
  job_id: string;
  mode: string;
  filename: string;
  status: VerisJobStatus;
  attempts: number;
  max_attempts: number;
  replay_count?: number;
  submitted_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  next_attempt_at?: string | null;
  result?: unknown;
  error?: VerisJobError | null;
}

/**
 * The API's `mode` enum also offers `document`, the generic route this codebase
 * removed on purpose — `rules.ts` marks those kinds `ocr: 'none'` and
 * `assertOcrRoutingIsSafe` fails the boot if that is edited away. Naming the
 * three allowed modes here means the generic route cannot be reached by
 * accident from this side either.
 */
const ALLOWED_MODES: ReadonlySet<string> = new Set<VerisJobMode>(['passport', 'resume', 'aadhaar']);

export class VerisJobError_ extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'VerisJobError';
  }
}

/** Raised when the queue refused admission. Never a document failure. */
export class JobQueueFullError extends Error {
  constructor(readonly retryAfterMs?: number) {
    super('veris job queue is full');
    this.name = 'JobQueueFullError';
  }
}

function base(): string {
  return config.VERIS_OCR_BASE_URL.replace(/\/$/, '');
}

function authHeaders(): Record<string, string> {
  return { 'X-API-Key': config.VERIS_OCR_API_KEY };
}

/** Absolute where the service gave one, resolved against the base where it did not. */
function absolute(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${base()}${url.startsWith('/') ? '' : '/'}${url}`;
}

/* ------------------------------------------------------------------ */
/* The three undeclared behaviours                                     */
/* ------------------------------------------------------------------ */

/**
 * Whether a rejection is queue admission control rather than a real failure.
 *
 * `automation-integration.md` states the queue "deliberately rejects new work
 * with `503 job_queue_full` at `OCR_JOB_QUEUE_MAX_DEPTH`", and that this is
 * "backpressure, not document loss". The OpenAPI document declares no 503 at
 * all, so the body is matched defensively on either the documented code or the
 * status alone.
 *
 * Erring towards treating a 503 as backpressure is the safe direction: the
 * upload stays queued and is tried again, rather than being written off. The
 * one 503 we have actually observed — `ocr_queue_required`, from the disabled
 * synchronous routes — is excluded, because that one is a misconfiguration and
 * retrying it forever would hide it.
 */
export function isJobQueueFull(status: number, body: string): boolean {
  if (status !== 503) return false;
  // Both spellings the service uses for it: the `code` is `ocr_queue_required`
  // and the `error` is `OcrQueueRequiredError`, and a body may carry either.
  if (/ocr[_ ]?queue[_ ]?required/i.test(body)) return false;
  return true;
}

/**
 * Whether a `failed` job is one we should ask the service to run again.
 *
 * The single remaining contract question lives here. Veris runs its own retries
 * and reports `attempts`, `max_attempts` and `next_attempt_at`, so a job that
 * has attempts left and a future `next_attempt_at` is one the *service* intends
 * to retry — calling `/retry` on it would duplicate work the service is already
 * scheduled to do.
 *
 * So the conservative reading is used: only retry when the service says the
 * error is retryable AND it has run out of its own attempts AND it is not
 * already scheduled to try again. If Veris confirms different semantics this is
 * the only function that changes.
 */
export function shouldRetryFailedJob(job: JobResponse, now = new Date()): boolean {
  if (job.error?.retryable !== true) return false;
  if (job.next_attempt_at && new Date(job.next_attempt_at) > now) return false;
  if (typeof job.attempts === 'number' && typeof job.max_attempts === 'number') {
    return job.attempts >= job.max_attempts;
  }
  return true;
}

/**
 * Whether the service still considers this job live.
 *
 * Used instead of a flat wall-clock deadline: a job inside its own retry budget
 * with a scheduled next attempt is working, however long it has been, and
 * abandoning it would throw away an extraction the service is about to produce.
 */
export function serviceStillWorking(job: JobResponse, now = new Date()): boolean {
  if (job.status === 'queued' || job.status === 'running') return true;
  if (job.next_attempt_at && new Date(job.next_attempt_at) > now) return true;
  if (typeof job.attempts === 'number' && typeof job.max_attempts === 'number') {
    return job.attempts < job.max_attempts;
  }
  return false;
}

/**
 * When to look again.
 *
 * Precedence is deliberate and matches who knows most: the service's own
 * `next_attempt_at` first, a `Retry-After` header second where one appears —
 * the spec assumes it, the OpenAPI never mentions it, so it is read
 * opportunistically and never depended on — and a bounded local backoff last.
 */
export function nextPollDelayMs(params: {
  job?: JobResponse;
  retryAfterMs?: number;
  previousDelayMs?: number;
  now?: Date;
}): number {
  const min = config.VERIS_OCR_POLL_MIN_MS;
  const max = config.VERIS_OCR_POLL_MAX_MS;
  const now = params.now ?? new Date();

  const scheduled = params.job?.next_attempt_at;
  if (scheduled) {
    const wait = new Date(scheduled).getTime() - now.getTime();
    if (Number.isFinite(wait) && wait > 0) return Math.min(Math.max(wait, min), max);
  }

  if (params.retryAfterMs !== undefined && params.retryAfterMs > 0) {
    return Math.min(Math.max(params.retryAfterMs, min), max);
  }

  const previous = params.previousDelayMs ?? 0;
  return Math.min(previous > 0 ? Math.round(previous * 1.5) : min, max);
}

/** `Retry-After` in seconds, where the service sent one at all. */
export function retryAfterMsOf(res: { headers: { get(name: string): string | null } }): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/* ------------------------------------------------------------------ */
/* Submit                                                              */
/* ------------------------------------------------------------------ */

/**
 * Queues one document for extraction.
 *
 * The idempotency key is the caller's, and the caller must reuse it on every
 * attempt at the same submission — that is what makes a retried HTTP request
 * safe. `duplicate: true` coming back is success, not a problem: it means the
 * key matched a job that already exists and no second job was created.
 *
 * Throws `JobQueueFullError` when the queue refused admission, which callers
 * must treat as "try later", never as a failed document.
 */
export async function submitOcrJob(params: {
  mode: VerisJobMode;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  idempotencyKey: string;
  lang?: string;
}): Promise<JobAccepted> {
  if (!ALLOWED_MODES.has(params.mode)) {
    throw new Error(`refusing to submit an extraction in mode "${params.mode}"`);
  }

  const form = new FormData();
  form.append('mode', params.mode);
  form.append('file', new Blob([params.buffer], { type: params.mimeType }), params.filename);
  if (params.lang) form.append('lang', params.lang);

  const res = await fetch(`${base()}/v1/jobs`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Idempotency-Key': params.idempotencyKey },
    body: form,
    signal: AbortSignal.timeout(config.VERIS_OCR_TIMEOUT_MS),
  });

  const text = await res.text();

  if (isJobQueueFull(res.status, text)) {
    throw new JobQueueFullError(retryAfterMsOf(res));
  }

  // The contract says 202. Anything else is not an accepted job, including a
  // 200 — which would mean the service is not behaving as its document says.
  if (res.status !== 202) {
    throw new VerisJobError_(
      `job submission failed with ${res.status}`,
      res.status,
      text.slice(0, 400),
    );
  }

  const accepted = JSON.parse(text) as JobAccepted;
  if (!accepted?.job_id || !accepted?.status_url) {
    throw new VerisJobError_('job submission returned no job_id or status_url', res.status);
  }

  logger.info(
    {
      jobId: accepted.job_id,
      mode: accepted.mode,
      status: accepted.status,
      duplicate: accepted.duplicate === true,
    },
    accepted.duplicate === true ? 'veris returned an existing job' : 'veris accepted a job',
  );

  return accepted;
}

/* ------------------------------------------------------------------ */
/* Poll                                                                */
/* ------------------------------------------------------------------ */

export async function pollOcrJob(
  statusUrl: string,
): Promise<{ job: JobResponse; retryAfterMs?: number }> {
  const res = await fetch(absolute(statusUrl), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(config.VERIS_OCR_TIMEOUT_MS),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new VerisJobError_(`job status failed with ${res.status}`, res.status, text.slice(0, 400));
  }

  const job = JSON.parse(text) as JobResponse;
  if (!job?.status) throw new VerisJobError_('job status response carried no status', res.status);

  return { job, retryAfterMs: retryAfterMsOf(res) };
}

/* ------------------------------------------------------------------ */
/* Retry                                                               */
/* ------------------------------------------------------------------ */

/**
 * Asks the service to run a retained failed job again.
 *
 * Returns `JobAccepted`, so it may carry a *different* `job_id` — the OpenAPI
 * does not say whether the id is preserved. Callers must therefore store
 * whatever comes back rather than assuming their existing id still applies.
 */
export async function retryFailedJob(jobId: string): Promise<JobAccepted> {
  const res = await fetch(`${base()}/v1/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
    headers: authHeaders(),
    signal: AbortSignal.timeout(config.VERIS_OCR_TIMEOUT_MS),
  });

  const text = await res.text();

  if (isJobQueueFull(res.status, text)) throw new JobQueueFullError(retryAfterMsOf(res));

  if (res.status !== 202) {
    throw new VerisJobError_(`job retry failed with ${res.status}`, res.status, text.slice(0, 400));
  }

  const accepted = JSON.parse(text) as JobAccepted;
  logger.info(
    { previousJobId: jobId, jobId: accepted.job_id, status: accepted.status },
    'veris accepted a retry',
  );
  return accepted;
}

/* ------------------------------------------------------------------ */
/* Idempotency                                                         */
/* ------------------------------------------------------------------ */

/**
 * The submission key for one extraction.
 *
 * The four-part form in `automation-integration.md` plus the extractor, and the
 * extractor is not optional. One WhatsApp attachment can produce two
 * independent extractions — `filePassportFoundInCv` files the same `mediaId`
 * under the passport slot as well — and without the fifth segment both would
 * submit the same key, Veris would answer the second with `duplicate: true`,
 * and the passport slot would be handed the CV's résumé extraction.
 */
export function ocrIdempotencyKey(params: {
  phoneNumberId: string;
  wamid: string;
  mediaId: string;
  extractor: VerisJobMode;
}): string {
  return `whatsapp/${params.phoneNumberId}/${params.wamid}/${params.mediaId}/${params.extractor}`;
}
