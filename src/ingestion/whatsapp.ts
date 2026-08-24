/**
 * Getting an inbound WhatsApp attachment onto disk, and into the ledger, before
 * the webhook is acknowledged.
 *
 * `automation-integration.md` is explicit about the order, and about why:
 *
 *   2. Download the attachment immediately; WhatsApp media URLs may expire.
 *   3. Store the original bytes in durable object storage.
 *   4. Insert or update the ingestion row before acknowledging the webhook.
 *
 * The reason to do this at the webhook rather than in the worker is not speed,
 * it is what an acknowledgement means. Acknowledging tells Meta the message is
 * ours now and stops the retries. Doing that while the only copy of the file is
 * still a media id on Meta's servers means a worker that never runs — a crash, a
 * lost Redis job, a bad deploy — takes the document with it, and nothing in our
 * database ever knew there was one.
 *
 * So the bytes are fetched and written first, and the ack is a statement about
 * something we actually hold.
 *
 * What is deliberately *not* done here is deciding what the file is. Which
 * checklist slot an upload belongs to depends on the conversation — the question
 * that was open, the caption, the filename — and that is the engine's job, on
 * the worker, under the candidate lock. This function only ever answers "are the
 * bytes safe, and is there a row saying so?". Which is why they land under
 * `inbound/` rather than under a document kind: at this point nobody honestly
 * knows the kind, and a directory named for a guess is worse than one named for
 * the truth.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { MediaTooLargeError, downloadMedia } from '../whatsapp/client.js';
import { saveFile } from '../storage/index.js';
import {
  findIngestion,
  idempotencyKeyFor,
  openIngestion,
  recordIngestionFailure,
  updateIngestion,
  type IngestionKey,
  type IngestionRow,
} from './ledger.js';

/** Everything under one phone number id, which is the account for this provider. */
export function whatsappKey(wamid: string, mediaId: string): IngestionKey {
  return {
    provider: 'whatsapp',
    account: config.WHATSAPP_PHONE_NUMBER_ID,
    messageId: wamid,
    attachmentId: mediaId,
  };
}

/**
 * Downloads one attachment, stores it, and records where it went.
 *
 * Idempotent by the ledger row: an attachment already stored is returned as it
 * stands rather than fetched a second time. That matters because Meta retries
 * deliveries, and because the reconciler calls this again for rows whose first
 * attempt failed — both must be able to run over the same attachment without
 * producing two copies of the file.
 *
 * Never throws. A download that fails is a recorded failure on a row that still
 * exists, which is the difference between an attachment we owe someone an
 * explanation for and one that silently never existed. The caller acknowledges
 * the webhook either way — a non-2xx would make Meta redeliver the whole batch,
 * including the messages that were fine.
 */
export async function captureAttachment(params: {
  waId: string;
  wamid: string;
  mediaId: string;
  mimeType?: string;
  filename?: string;
  receivedAt?: Date;
  /**
   * The number it arrived on (`conversation/lines.ts`).
   *
   * A media id belongs to the WABA it was uploaded to, so where the two lines
   * do not share a Meta app the download has to present that line's token.
   */
  phoneNumberId?: string;
}): Promise<IngestionRow> {
  const key = whatsappKey(params.wamid, params.mediaId);

  const { row } = await openIngestion({
    ...key,
    waId: params.waId,
    mimeType: params.mimeType,
    originalFilename: params.filename,
    receivedAt: params.receivedAt,
  });

  // Already on disk. A redelivery, or the reconciler passing over a row that
  // got further than its status suggested.
  if (row.storageKey) return row;

  // Done with, and not because it succeeded. `review` means retries are over
  // and a person has to look at it, so fetching again is work whose result is
  // already known — and for a file refused on its size it is the same refusal,
  // paid for again. The row goes back exactly as it stands.
  if (row.status === 'review') {
    logger.debug(
      { waId: params.waId, wamid: params.wamid, failureKind: row.failureKind },
      'attachment already in the review queue; not fetched again',
    );
    return row;
  }

  try {
    const media = await downloadMedia(params.mediaId, params.filename, params.phoneNumberId);

    const stored = await saveFile({
      waId: params.waId,
      // Not a document kind. See the note at the top of this file: the kind is
      // the engine's decision and it has not been made yet.
      docType: 'inbound',
      buffer: media.buffer,
      mimeType: media.mimeType,
      originalFilename: params.filename,
    });

    await updateIngestion(key, {
      status: 'stored',
      storageKey: stored.storageKey,
      sha256: stored.sha256,
      byteSize: stored.byteSize,
      mimeType: media.mimeType,
      lastError: undefined,
      nextAttemptAt: undefined,
    });

    logger.info(
      { waId: params.waId, wamid: params.wamid, storageKey: stored.storageKey },
      'attachment captured before webhook ack',
    );

    return {
      ...row,
      status: 'stored',
      storageKey: stored.storageKey,
      sha256: stored.sha256,
      byteSize: stored.byteSize,
      mimeType: media.mimeType,
    };
  } catch (err) {
    const attempts = (row.attempts ?? 0) + 1;

    // A file over `MEDIA_MAX_BYTES` is over it on every attempt. Recorded as
    // terminal so the row stops here rather than costing four more fetches, and
    // so the conversation can tell the candidate what is actually wrong — "send
    // it again" is advice that cannot work on a file that is simply too big.
    const tooLarge = err instanceof MediaTooLargeError;

    const status = await recordIngestionFailure({
      key,
      error: err instanceof Error ? err.message : String(err),
      attempts,
      maxAttempts: config.INGESTION_MAX_ATTEMPTS,
      retryAfterMs: retryAfterMsFrom(err),
      ...(tooLarge ? { terminal: 'too_large' as const } : {}),
    });

    return { ...row, status, attempts, ...(tooLarge ? { failureKind: 'too_large' as const } : {}) };
  }
}

/** The row for one inbound message's attachment, if the capture step opened one. */
export async function ingestionForMessage(
  wamid: string,
  mediaId: string,
): Promise<IngestionRow | null> {
  return findIngestion(idempotencyKeyFor(whatsappKey(wamid, mediaId)));
}

/**
 * `Retry-After`, where the failure carried one.
 *
 * The spec asks for it to be honored ahead of our own backoff curve on 429, 502
 * and 503 — a service that has said when to come back has information we do not.
 */
function retryAfterMsFrom(err: unknown): number | undefined {
  const seconds = (err as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
  return typeof seconds === 'number' && seconds > 0 ? seconds * 1_000 : undefined;
}
