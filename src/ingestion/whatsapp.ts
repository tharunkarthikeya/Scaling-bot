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
import { downloadMedia } from '../whatsapp/client.js';
import { readFile, saveFile } from '../storage/index.js';
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

  try {
    const media = await downloadMedia(params.mediaId, params.filename);

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
    const status = await recordIngestionFailure({
      key,
      error: err instanceof Error ? err.message : String(err),
      attempts,
      maxAttempts: config.INGESTION_MAX_ATTEMPTS,
      retryAfterMs: retryAfterMsFrom(err),
    });

    return { ...row, status, attempts };
  }
}

/**
 * The original bytes for a row, from storage where they are there and from Meta
 * where they are not.
 *
 * The fallback exists for attachments that arrived before the capture step did,
 * and for the window where a capture failed but the media id is still good. It
 * is a fallback and not the path: if it runs, the ledger row says why.
 */
export async function sourceBytesFor(
  row: IngestionRow,
): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
  if (row.storageKey) {
    try {
      return {
        buffer: await readFile(row.storageKey),
        mimeType: row.mimeType ?? 'application/octet-stream',
      };
    } catch (err) {
      // The row says the bytes are there and they are not. Worth shouting
      // about: it means the storage volume is not the one that was written to,
      // which on Dokploy means STORAGE_PATH is a container path again.
      logger.error(
        { err, storageKey: row.storageKey, waId: row.waId },
        'ingestion row names a source object that cannot be read',
      );
    }
  }

  if (row.provider !== 'whatsapp') return undefined;

  try {
    const media = await downloadMedia(row.attachmentId, row.originalFilename);
    return { buffer: media.buffer, mimeType: media.mimeType };
  } catch (err) {
    logger.error(
      { err, waId: row.waId, attachmentId: row.attachmentId },
      'source bytes unavailable from storage and from the provider',
    );
    return undefined;
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
