import type { Collection, ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../logger.js';

/** Where a candidate is in the intake flow. The engine owns these transitions, not the model. */
export type ConversationStage =
  | 'new'
  | 'collecting_documents'
  | 'awaiting_review'
  | 'complete'
  | 'human_handoff'
  | 'opted_out';

export type DocumentStatus =
  | 'pending' // never asked for, or asked for and no answer yet
  | 'received' // file is on disk
  | 'ocr_queued'
  | 'ocr_done'
  | 'ocr_failed'
  | 'needs_review' // OCR confidence below threshold — a human must confirm
  | 'promised' // candidate said they'll send it later
  | 'unavailable'; // candidate says they don't have it

export interface DocumentSlot {
  status: DocumentStatus;
  documentId?: ObjectId;
  askedCount: number;
  lastAskedAt?: Date;
  updatedAt: Date;
  note?: string;
}

export interface CandidateProfile {
  fullName?: string;
  email?: string;
  dateOfBirth?: string;
  nationality?: string;
  passportNumber?: string;
  roleAppliedFor?: string;
  yearsOfExperience?: number;
  currentLocation?: string;
  [key: string]: unknown;
}

export interface CandidateDoc {
  _id?: ObjectId;
  /** Meta's stable per-business identifier for the user. Primary key for the conversation. */
  waId: string;
  phone: string;
  profileName?: string;
  stage: ConversationStage;
  profile: CandidateProfile;
  /** documentId -> slot. Keys come from REQUIRED_DOCUMENTS in conversation/rules.ts. */
  documents: Record<string, DocumentSlot>;
  /** Which document the bot most recently asked for; inbound media is attributed here by default. */
  awaitingDocument?: string;
  humanHandoff?: { reason: string; at: Date };
  /** Meta's 24-hour customer service window. Outside it, only templates may be sent. */
  windowExpiresAt?: Date;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;
  reengagementSentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageDoc {
  _id?: ObjectId;
  waId: string;
  direction: 'inbound' | 'outbound';
  /** Meta's message id. Unique per direction; used for inbound idempotency. */
  wamid?: string;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'template' | 'interactive' | 'other';
  text?: string;
  mediaId?: string;
  filename?: string;
  mimeType?: string;
  /** Set on outbound rows when SHADOW_MODE suppressed the actual send. */
  shadowed?: boolean;
  error?: string;
  createdAt: Date;
}

export interface OcrField {
  key: string;
  value: string;
  /**
   * Null when the extractor returned no score for this field. Null is not
   * confidence — an unscored field must never be treated as verified.
   */
  confidence: number | null;
  page?: number;
  category?: string;
  source?: string;
}

export interface StoredDocumentDoc {
  _id?: ObjectId;
  candidateId: ObjectId;
  waId: string;
  /** Slot key, e.g. 'cv' | 'passport'. */
  docType: string;
  mediaId: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  originalFilename?: string;
  caption?: string;
  ocr?: {
    status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
    /** Which Veris extractor ran. */
    extractor?: 'passport' | 'resume' | 'document';
    startedAt?: Date;
    finishedAt?: Date;
    error?: string;
    /** Raw OCR payload, kept verbatim so extraction can be re-derived without re-OCRing. */
    raw?: unknown;
    /** Field-level extraction with provenance. The CRM reads this, not `raw`. */
    fields?: OcrField[];
    /** Overall score, when the extractor reports one. Null means it does not. */
    confidence?: number | null;
    /** True when a human must confirm before this data is treated as fact. */
    needsReview?: boolean;
    /** Why review is needed, in plain language, for the CRM to display. */
    reviewReasons?: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

/** Inbound webhook dedupe. Meta retries deliveries; without this, candidates get asked twice. */
export interface ProcessedEventDoc {
  _id?: ObjectId;
  wamid: string;
  processedAt: Date;
}

export const candidates = (): Collection<CandidateDoc> =>
  getDb().collection<CandidateDoc>('candidates');
export const messages = (): Collection<MessageDoc> => getDb().collection<MessageDoc>('messages');
export const storedDocuments = (): Collection<StoredDocumentDoc> =>
  getDb().collection<StoredDocumentDoc>('documents');
export const processedEvents = (): Collection<ProcessedEventDoc> =>
  getDb().collection<ProcessedEventDoc>('processed_events');

/**
 * Creates indexes, replacing any that already exist with different options.
 * Mongo rejects a redefinition outright, which would otherwise wedge a deploy
 * whenever an index spec changes.
 */
async function createIndexes(
  collection: Collection<any>,
  specs: Array<Parameters<Collection<any>['createIndexes']>[0][number]>,
): Promise<void> {
  for (const spec of specs) {
    try {
      await collection.createIndexes([spec]);
    } catch (err) {
      const code = (err as { code?: number }).code;
      // 85 IndexOptionsConflict, 86 IndexKeySpecsConflict
      if (code !== 85 && code !== 86) throw err;
      logger.warn({ index: spec.name }, 'index definition changed; rebuilding');
      await collection.dropIndex(spec.name!);
      await collection.createIndexes([spec]);
    }
  }
}

export async function ensureIndexes(): Promise<void> {
  await createIndexes(candidates(), [
    { key: { waId: 1 }, unique: true, name: 'waId_unique' },
    { key: { stage: 1, updatedAt: -1 }, name: 'stage_updatedAt' },
    { key: { windowExpiresAt: 1 }, name: 'windowExpiresAt' },
  ]);

  await createIndexes(messages(), [
    { key: { waId: 1, createdAt: -1 }, name: 'waId_createdAt' },
    // Partial, not sparse. Outbound rows can legitimately carry no wamid —
    // shadow mode, a send that failed, a Meta response without an id — and a
    // sparse index still indexes an explicit null, so the second such row
    // collides with the first and the reply is lost.
    {
      key: { wamid: 1 },
      unique: true,
      name: 'wamid_unique',
      partialFilterExpression: { wamid: { $type: 'string' } },
    },
  ]);

  await createIndexes(storedDocuments(), [
    { key: { candidateId: 1, docType: 1 }, name: 'candidate_docType' },
    { key: { 'ocr.status': 1, createdAt: 1 }, name: 'ocr_status' },
    // The CRM's review queue reads off this.
    { key: { 'ocr.needsReview': 1, createdAt: 1 }, name: 'ocr_needsReview' },
    { key: { sha256: 1 }, name: 'sha256' },
  ]);

  await createIndexes(processedEvents(), [
    { key: { wamid: 1 }, unique: true, name: 'wamid_unique' },
    // Meta stops retrying long before 7 days; the dedupe table doesn't need to grow forever.
    { key: { processedAt: 1 }, expireAfterSeconds: 60 * 60 * 24 * 7, name: 'processedAt_ttl' },
  ]);

  logger.info('mongodb indexes ensured');
}

/**
 * Records a wamid as seen. Returns false if it was already recorded, in which case
 * the caller must drop the message — Meta is retrying a delivery we already handled.
 */
export async function claimEvent(wamid: string): Promise<boolean> {
  try {
    await processedEvents().insertOne({ wamid, processedAt: new Date() });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}
