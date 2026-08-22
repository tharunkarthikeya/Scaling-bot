/**
 * The ingestion ledger: one row per provider attachment, from the moment the
 * bytes land to the moment extraction finishes with them.
 *
 * `automation-integration.md` calls this the permanent deduplication boundary,
 * and the distinction it draws is the reason this collection exists at all.
 * `processed_events` already deduplicates *messages* by wamid, which stops
 * Meta's retries from running a turn twice — but a message is not an
 * attachment. It says nothing about whether the file inside it was ever
 * downloaded, whether the bytes reached storage, or whether anything ever read
 * them. A wamid claimed by a delivery that then failed mid-download leaves no
 * trace at all: the retry is dropped as a duplicate, and the document is simply
 * gone.
 *
 * So the ledger is keyed on the attachment, not the message —
 * `(provider, account, messageId, attachmentId)`, unique — and a row is written
 * before the webhook is acknowledged. Everything after that is a state
 * transition on a row that already exists, which is what makes an unfinished
 * ingestion something you can *find* rather than something you infer from an
 * absence.
 *
 * The row is deliberately not the document record. `documents` holds what a
 * candidate sent and what was read off it, grouped for a person to read; this
 * holds the mechanics of getting it there, for the reconciler and for whoever
 * is on call. They are updated together and neither is derived from the other.
 */

import type { Collection, ObjectId } from 'mongodb';
import { getDb } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * Where an attachment came from. Only `whatsapp` is produced here — the email
 * side of `automation-integration.md` is a separate service — but the key
 * includes the provider because the ledger is defined across both, and a
 * mailbox and a phone number can hand out colliding message ids.
 */
export type IngestionProvider = 'whatsapp' | 'email';

/**
 * Where an attachment has got to.
 *
 *   received    the row exists; the bytes have not been fetched yet
 *   stored      the original bytes are in durable storage, with a checksum
 *   submitting  handed to the OCR queue, no job id back yet
 *   running     an extractor has it
 *   succeeded   a structured result is persisted
 *   failed      retryable: the reconciler will submit it again
 *   review      retries exhausted; a person has to look at it
 *   skipped     stored deliberately unread — see `ocr: 'none'` in rules.ts
 *
 * `failed` and `review` are separated on purpose. The spec asks for exhausted
 * failures to land somewhere a human is looking, and a status that means both
 * "we will try again" and "nobody is coming" is a status nobody can alert on.
 */
export type IngestionStatus =
  | 'received'
  | 'stored'
  | 'submitting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'review'
  | 'skipped';

/** Statuses that are not going to change on their own. */
export const TERMINAL_STATUSES: ReadonlySet<IngestionStatus> = new Set<IngestionStatus>([
  'succeeded',
  'review',
  'skipped',
]);

/** Statuses the reconciler is responsible for moving along. */
export const IN_FLIGHT_STATUSES: ReadonlySet<IngestionStatus> = new Set<IngestionStatus>([
  'received',
  'stored',
  'submitting',
  'running',
  'failed',
]);

export interface IngestionRow {
  _id?: ObjectId;

  /* The key. Unique across these four, and nothing else. */
  provider: IngestionProvider;
  /** The mailbox or phone number id the attachment arrived on. */
  account: string;
  /** Provider message id — the wamid, for WhatsApp. */
  messageId: string;
  /** Provider attachment id — the media id, for WhatsApp. */
  attachmentId: string;

  /**
   * Stable across every retry, and derived from the key rather than generated,
   * so a resubmission after a crash carries the same one it did the first time.
   * `automation-integration.md` names the format.
   */
  idempotencyKey: string;

  /** The conversation this arrived on, once it is known. */
  waId?: string;
  /** The checklist slot it was filed against, once attribution has run. */
  docType?: string;

  /* The durable source object. Absent until the download succeeds. */
  storageKey?: string;
  sha256?: string;
  byteSize?: number;
  mimeType?: string;
  originalFilename?: string;

  /**
   * Which extractor this is destined for, or 'none' for a kind that is stored
   * and never read (a PAN card, a company's registration certificate).
   */
  ocrMode?: 'resume' | 'aadhaar' | 'passport' | 'none';

  /** Our own job identity: the upload the OCR worker is carrying. */
  jobId?: string;

  status: IngestionStatus;
  /** Submission attempts, not extraction retries inside a single attempt. */
  attempts: number;
  lastError?: string;
  /**
   * Why this row will not be tried again, where the reason was not "we ran out
   * of goes". Set on a failure that retrying cannot fix — today that is a file
   * over `MEDIA_MAX_BYTES`, which will be exactly as large next time.
   *
   * Read by the conversation, which owes the candidate a different sentence for
   * a file that was too big than for one that did not arrive, and by whoever
   * opens the review queue and would otherwise see five identical timeouts.
   */
  failureKind?: 'too_large';

  receivedAt: Date;
  submittedAt?: Date;
  completedAt?: Date;
  /** Earliest the reconciler may try again — backoff with jitter, applied. */
  nextAttemptAt?: Date;
  updatedAt: Date;
}

export const INGESTION_COLLECTION = 'ingestion_attachments';

export const ingestionRows = (): Collection<IngestionRow> =>
  getDb().collection<IngestionRow>(INGESTION_COLLECTION);

export type IngestionKey = Pick<
  IngestionRow,
  'provider' | 'account' | 'messageId' | 'attachmentId'
>;

/**
 * The idempotency key formats `automation-integration.md` specifies.
 *
 * Built from the key rather than stored alongside it, so it cannot drift from
 * the row it identifies and so a caller with the four identifiers can always
 * reproduce it without a read.
 */
export function idempotencyKeyFor(key: IngestionKey): string {
  return `${key.provider}/${key.account}/${key.messageId}/${key.attachmentId}`;
}

/**
 * Opens a row for an attachment, or returns the existing one untouched.
 *
 * The upsert and the unique index do the concurrency work between them: two
 * simultaneous deliveries of the same attachment race, one inserts, the other
 * matches, and both come away with the same row. Nothing here overwrites
 * progress — an attachment already stored or already extracted must not be
 * dragged back to `received` by a duplicate webhook.
 *
 * Returns the row and whether this call was the one that created it. The caller
 * uses that to decide whether to spend a download.
 */
export async function openIngestion(params: {
  provider: IngestionProvider;
  account: string;
  messageId: string;
  attachmentId: string;
  waId?: string;
  mimeType?: string;
  originalFilename?: string;
  receivedAt?: Date;
}): Promise<{ row: IngestionRow; created: boolean }> {
  const now = new Date();
  const key: IngestionKey = {
    provider: params.provider,
    account: params.account,
    messageId: params.messageId,
    attachmentId: params.attachmentId,
  };

  const result = await ingestionRows().findOneAndUpdate(
    key,
    {
      $setOnInsert: {
        ...key,
        idempotencyKey: idempotencyKeyFor(key),
        status: 'received' as IngestionStatus,
        attempts: 0,
        receivedAt: params.receivedAt ?? now,
        ...(params.waId ? { waId: params.waId } : {}),
        ...(params.mimeType ? { mimeType: params.mimeType } : {}),
        ...(params.originalFilename ? { originalFilename: params.originalFilename } : {}),
      },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true },
  );

  const row = result.value as IngestionRow;
  // `upserted` is set only on the call that performed the insert, which is what
  // distinguishes the first delivery from a retry of it.
  return { row, created: !!result.lastErrorObject?.upserted };
}

/** Writes fields onto one row, addressed by its key. */
export async function updateIngestion(
  key: IngestionKey,
  patch: Partial<Omit<IngestionRow, '_id' | keyof IngestionKey>>,
): Promise<void> {
  await ingestionRows().updateOne(key, { $set: { ...patch, updatedAt: new Date() } });
}

/** The same, by the idempotency key, for callers that only carry that. */
export async function updateIngestionByKey(
  idempotencyKey: string,
  patch: Partial<Omit<IngestionRow, '_id'>>,
): Promise<void> {
  await ingestionRows().updateOne({ idempotencyKey }, { $set: { ...patch, updatedAt: new Date() } });
}

export async function findIngestion(idempotencyKey: string): Promise<IngestionRow | null> {
  return ingestionRows().findOne({ idempotencyKey });
}

/**
 * Exponential backoff with full jitter, capped so a retry is never hours away.
 *
 * Full jitter rather than a fixed curve: a thundering herd of retries all
 * landing at the same moment after an outage is the failure mode a fixed curve
 * produces, and the cap is exactly when it happens.
 */
export function backoffMs(attempts: number, baseDelayMs = 2_000, capMs = 5 * 60_000): number {
  const ceiling = Math.min(capMs, baseDelayMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(Math.random() * ceiling);
}

/**
 * Records a failed attempt and schedules the next one.
 *
 * Exponential backoff with jitter, as the spec asks for, with `Retry-After`
 * taking precedence when the service supplied one — a server that has told us
 * when to come back knows better than our own curve. Past `maxAttempts` the row
 * stops being retryable and becomes a review task: the source object is still
 * on disk and the row still names it, which is the whole point of discarding
 * neither on failure.
 */
/**
 * Whether a failure ends the row or schedules another attempt.
 *
 * Two ways to stop. The ordinary one is running out of goes. The other is a
 * failure whose cause cannot change between attempts — a file larger than
 * `MEDIA_MAX_BYTES` is the same size on the fifth try, and four more downloads
 * of it buy nothing but four more downloads of it.
 *
 * Separated from the write so it can be checked without a database, which is
 * the only way the "an oversized file is never retried" promise gets a test.
 */
export function isTerminalFailure(params: {
  attempts: number;
  maxAttempts: number;
  terminal?: 'too_large';
}): boolean {
  return !!params.terminal || params.attempts >= params.maxAttempts;
}

export async function recordIngestionFailure(params: {
  key: IngestionKey;
  error: string;
  attempts: number;
  maxAttempts: number;
  retryAfterMs?: number;
  baseDelayMs?: number;
  /**
   * A failure that retrying cannot fix, whatever the attempt count says. Goes
   * straight to `review` with no `nextAttemptAt`, because scheduling four more
   * downloads of a file we have already refused on its size is four more
   * downloads of a file we are going to refuse on its size.
   */
  terminal?: 'too_large';
}): Promise<IngestionStatus> {
  const { key, error, attempts, maxAttempts, terminal } = params;
  const exhausted = isTerminalFailure({ attempts, maxAttempts, terminal });

  const status: IngestionStatus = exhausted ? 'review' : 'failed';
  const patch: Partial<IngestionRow> = { status, attempts, lastError: error.slice(0, 1_000) };
  if (terminal) patch.failureKind = terminal;

  if (exhausted) {
    patch.completedAt = new Date();
  } else {
    patch.nextAttemptAt = new Date(
      Date.now() + (params.retryAfterMs ?? backoffMs(attempts, params.baseDelayMs)),
    );
  }

  await updateIngestion(key, patch);

  logger[exhausted ? 'error' : 'warn'](
    { ...key, attempts, error, status, ...(terminal ? { failureKind: terminal } : {}) },
    terminal
      ? 'attachment will not be retried; moved to the review queue'
      : exhausted
        ? 'attachment moved to the review queue'
        : 'attachment ingestion failed; will retry',
  );

  return status;
}

/**
 * How long the oldest unfinished attachment has been waiting, in milliseconds.
 *
 * The spec asks for alerting on queue *age*, not queue count, and the
 * difference matters: a queue holding four attachments is fine if they arrived
 * a minute ago and is an incident if the oldest arrived on Tuesday. A count
 * cannot tell those apart.
 */
export async function oldestUnfinishedAgeMs(now = new Date()): Promise<number> {
  const [oldest] = await ingestionRows()
    .find({ status: { $in: [...IN_FLIGHT_STATUSES] } })
    .sort({ receivedAt: 1 })
    .limit(1)
    .toArray();

  return oldest ? now.getTime() - oldest.receivedAt.getTime() : 0;
}
