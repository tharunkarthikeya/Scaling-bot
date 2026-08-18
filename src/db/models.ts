import type { Collection, ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../logger.js';
import type { Language } from '../conversation/language.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Registration state (protocol §21)
 *
 * These are the states the protocol names, plus the operational ones it implies.
 * The engine owns every transition. The model never writes one — it cannot even
 * see them.
 * ───────────────────────────────────────────────────────────────────────────*/

export type ConversationStage =
  | 'NEW'
  | 'LANGUAGE_PENDING'
  | 'CONSENT_PENDING'
  | 'CV_PENDING'
  | 'BASIC_DETAILS_PENDING'
  | 'JOB_PREFERENCE_PENDING'
  | 'DOCUMENTS_PENDING'
  | 'CONFIRMATION_PENDING'
  | 'REGISTRATION_COMPLETED'
  | 'HUMAN_HANDOFF'
  | 'CONSENT_REFUSED'
  | 'DELETED';

/* ─────────────────────────────────────────────────────────────────────────────
 * Candidate status (protocol §26)
 *
 * Distinct from stage. Stage is where the conversation is; status is what the
 * business thinks of the candidate. The bot sets a handful of these; the rest
 * are set by staff through the CRM.
 * ───────────────────────────────────────────────────────────────────────────*/

export const CANDIDATE_STATUSES = [
  'new_enquiry',
  'consent_pending',
  'registration_started',
  'profile_incomplete',
  'profile_registered',
  'documents_pending',
  'documents_received',
  'documents_incomplete',
  'documents_verified',
  'manual_review',
  'job_ready',
  'shortlisted',
  'contacted',
  'interested',
  'interview_scheduled',
  'selected',
  'processing',
  'deployed',
  'temporarily_unavailable',
  'not_interested',
  'consent_withdrawn',
  'archived',
] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/* ─────────────────────────────────────────────────────────────────────────────
 * Application outcome
 *
 * What a candidate is told when they ask to track their application. Distinct
 * from both stage and status: those describe where the conversation and the
 * record are, this is the decision staff have taken on the application itself.
 *
 * The bot never sets anything but the initial `pending`. Everything after that
 * is an admin decision made in the CRM — the bot has no authority to tell anyone
 * they were selected or rejected (§27).
 * ───────────────────────────────────────────────────────────────────────────*/

export const APPLICATION_STATUSES = ['pending', 'completed', 'rejected'] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses the bot is allowed to set on its own. Everything else is staff-only (§27). */
export const BOT_SETTABLE_STATUSES: ReadonlySet<CandidateStatus> = new Set<CandidateStatus>([
  'new_enquiry',
  'consent_pending',
  'registration_started',
  'profile_incomplete',
  'profile_registered',
  'documents_pending',
  'documents_received',
  'documents_incomplete',
  'manual_review',
  'not_interested',
  'consent_withdrawn',
]);

/* ─────────────────────────────────────────────────────────────────────────────
 * Documents
 * ───────────────────────────────────────────────────────────────────────────*/

export type DocumentStatus =
  | 'pending' // never asked for, or asked for and no answer yet
  | 'received' // file is on disk
  | 'ocr_queued'
  | 'ocr_done'
  | 'ocr_failed'
  | 'incomplete' // arrived but unreadable or missing pages (§14)
  | 'needs_review' // extraction confidence too low — a human must confirm
  | 'promised' // candidate said they will send it later
  | 'unavailable'; // candidate says they do not have it

export interface DocumentSlot {
  status: DocumentStatus;
  documentId?: ObjectId;
  askedCount: number;
  lastAskedAt?: Date;
  updatedAt: Date;
  /** Why it is incomplete, in plain language, for the candidate-facing re-ask. */
  note?: string;
  /** Superseded uploads, newest last. §22 forbids destroying old versions. */
  previousDocumentIds?: ObjectId[];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Profile
 *
 * Flat and queryable. Three rules from the protocol are load-bearing here:
 *
 *  §9  previous, current and desired occupation are three separate fields and
 *      are never merged into one another.
 *  §10 country preference carries its own strictness flag, because a strict
 *      candidate must never be matched outside their list.
 *  §27 every value records where it came from and keeps the candidate's own
 *      wording — see `fieldMeta` on the candidate document.
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * A trade question written for one candidate, because no pack covers their job
 * (§8). Stored on the profile before it is asked — see
 * `conversation/tradeQuestions.ts` for how it is written and what it may not
 * contain.
 */
export interface GeneratedQuestion {
  /** Stable key. Answers live at `profile.tradeAnswers[id]`, like a pack's. */
  id: string;
  /** The question, already in the candidate's language. */
  prompt: string;
  /** Up to six short options, or none for a typed answer. */
  options: string[];
}

export interface CandidateProfile {
  /** §2 — answered before anything personal is collected. */
  lookingForOverseasJob?: boolean;
  /** Trade question packs selected for this candidate (§8). */
  tradePacks?: string[];
  /**
   * Questions written for a job no pack covers (§8), stored before they are
   * asked so what the candidate was asked is on the record next to what they
   * answered. See `conversation/tradeQuestions.ts` for the fence around them.
   */
  tradeQuestions?: GeneratedQuestion[];
  /** The occupation those questions were written for, so a change rewrites them. */
  tradeQuestionsFor?: string;
  /** Set once the §17 comparison has flagged a difference, so it is raised once. */
  identityFlagged?: boolean;

  /* identity */
  fullName?: string;
  /** ISO yyyy-mm-dd. Stored normalised; the candidate always types DD/MM/YYYY. */
  dateOfBirth?: string;
  email?: string;
  /**
   * The number on the CV. Usually the same as `waId`, and kept anyway — a CV
   * that gives a different number is worth a staff member seeing.
   */
  mobileNumber?: string;
  alternateNumber?: string;
  nationality?: string;
  fatherName?: string;

  /* location — stored split, because matching filters on state and country (§6) */
  currentCity?: string;
  currentDistrict?: string;
  currentState?: string;
  currentCountry?: string;

  /* education */
  education?: string;
  educationCourse?: string;

  /* experience */
  primaryTrade?: string;
  /**
   * True when `primaryTrade` came from tapping one of the offered categories
   * rather than from free text or a CV.
   *
   * A tapped category is a category, not a description of the work: the label
   * "Fabrication / Welding" contains the keywords of every pack beneath it, so
   * matching on it selects all of them at once. Recording where the value came
   * from is what lets §8 ask the disambiguation question instead of guessing.
   */
  tradeFromList?: boolean;
  totalExperienceBand?: string;
  /** Set only when the candidate gives an exact figure; the band is always set. */
  totalExperienceYears?: number;
  indiaExperienceYears?: number;
  overseasExperienceYears?: number;
  overseasCountries?: string[];
  employers?: string[];
  skills?: string[];
  certifications?: string[];
  drivingLicences?: string[];
  machinery?: string[];
  hasOverseasExperience?: boolean;

  /* §9 — three occupations, never mixed */
  previousOccupations?: string[];
  currentOccupation?: string;
  desiredOccupation?: string;

  /* trade-specific answers, keyed by question id (§8) */
  tradeAnswers?: Record<string, string[]>;

  /* job preference (§9) */
  workTypePreference?: string;
  relatedAcceptance?: string;
  generalWorkWillingness?: string;
  generalJobs?: string[];
  trainingWillingness?: string;

  /* country preference (§10) */
  countryPreference?: string;
  selectedCountries?: string[];
  /** 'strict' means never shortlist outside `selectedCountries` without asking. */
  countryStrictness?: string;

  /* availability (§11) */
  availability?: string;
  availabilityNote?: string;

  /* passport (§12) */
  passportStatus?: string;
  /** MM/YYYY as the candidate gives it. */
  passportExpiry?: string;
  passportAppliedWhen?: string;
  passportRenewalIntent?: string;
  passportApplyWillingness?: string;

  /* Europe / Russia document branch (§13) */
  documentAvailability?: string;
  availableDocuments?: string[];

  /* extracted from documents — never echoed to the candidate in full (§27) */
  passportNumber?: string;
  aadhaarNumber?: string;
  panNumber?: string;

  [key: string]: unknown;
}

/** Where a value came from. Required by §27. */
export type FieldSource = 'cv' | 'chat' | 'document' | 'staff';

export interface FieldMeta {
  source: FieldSource;
  /** The candidate's own wording, kept alongside the standardised value (§27). */
  raw?: string;
  at: Date;
  /** Extraction confidence, when the source reported one. Null means unscored. */
  confidence?: number | null;
  /** True once a human has confirmed it. CV data is never verified by default (§27). */
  verified?: boolean;
}

export interface ProfileChange {
  field: string;
  from?: unknown;
  to?: unknown;
  source: FieldSource;
  at: Date;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Candidate
 * ───────────────────────────────────────────────────────────────────────────*/

export interface CandidateDoc {
  _id?: ObjectId;
  /** Meta's stable per-business identifier. Primary key for the conversation. */
  waId: string;
  phone: string;
  profileName?: string;

  /**
   * Human-facing id, assigned once registration completes (§19). Shown to the
   * candidate as their Application ID and typed back at us to track progress,
   * so it stays short and unambiguous — see `nextCandidateId`.
   */
  candidateId?: string;

  /** Which of the three opening options they chose (§2). */
  enquiry?: 'apply' | 'b2b' | 'track';

  /**
   * The decision staff have recorded on the application. Absent until
   * registration completes, when the bot seeds it as `pending` and stops
   * touching it — every later change is an admin action through the CRM.
   */
  application?: {
    status: ApplicationStatus;
    updatedAt: Date;
    /** Staff identifier from the CRM, for the audit trail. */
    updatedBy?: string;
    /** Internal note. Never shown to the candidate. */
    note?: string;
  };

  /**
   * The language replies are written in.
   *
   * Set twice, for two different reasons. The engine guesses it from the script
   * of the very first message so the welcome arrives in something readable, and
   * the candidate sets it properly when they answer the language question. Only
   * the second of those counts as a choice — see `languageChosen`.
   */
  language?: Language;
  /**
   * True once the candidate has actually picked a language (§3).
   *
   * Kept apart from `language` because a guess and a choice are not the same
   * thing. Without this, detecting a language from "hi" would mark §3 answered
   * and the question would never be asked — which is exactly what it did.
   */
  languageChosen?: boolean;
  /** What the candidate typed when they chose "Other" (§3). */
  languageOther?: string;

  /** §4. Nothing personal is collected until this is recorded as given. */
  consent?: {
    given: boolean;
    at: Date;
    /** How consent was obtained, for the audit record. */
    source: 'whatsapp_chat' | 'staff';
    withdrawnAt?: Date;
  };

  stage: ConversationStage;
  status: CandidateStatus;

  profile: CandidateProfile;
  /** Provenance per profile field (§27). Keys mirror `profile`. */
  fieldMeta: Record<string, FieldMeta>;
  /** Append-only change log (§22). */
  history: ProfileChange[];

  /** Slot key -> slot. Keys come from DOCUMENTS in conversation/rules.ts. */
  documents: Record<string, DocumentSlot>;

  /** The step whose answer the next inbound message is presumed to be. */
  currentStep?: string;
  /** Partial selection for a multi-select step, held until the candidate taps Done. */
  pendingMulti?: { step: string; selected: string[] };
  /** Steps queued by an UPDATE or an edit request (§18, §22). Drains before normal flow. */
  editQueue?: string[];
  /**
   * Consecutive replies we could not make sense of. Reset by any answer that
   * lands. Past the limit the conversation goes to a person rather than asking
   * the same question a fourth time.
   */
  unclearCount?: number;

  humanHandoff?: { reason: string; at: Date; returnedAt?: Date };

  /** Meta's 24-hour customer service window. Outside it, only templates may be sent. */
  windowExpiresAt?: Date;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;
  /** §21 allows exactly one reminder. This is what enforces "exactly one". */
  reminderSentAt?: Date;

  /**
   * When the idle session was closed.
   *
   * A candidate who goes quiet mid-registration has their session ended after
   * `TUNABLES.sessionTimeoutMinutes`. Nothing is lost — progress is written after
   * every answer — but the next message is greeted with "continue where you
   * stopped, or start again?" rather than silently resuming a conversation the
   * candidate has forgotten the context of.
   */
  sessionEndedAt?: Date;

  completedAt?: Date;
  /** §23. The record is tombstoned, not dropped — a minimum audit trail survives. */
  deletion?: { requestedAt: Date; completedAt?: Date; by: 'candidate' | 'staff' };

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
  /** For an interactive reply, the stable option id the candidate tapped. */
  replyId?: string;
  /**
   * The message this one is a reply to, as Meta reports it.
   *
   * For a tapped button it is the wamid of the message that offered it, which
   * is the only way to tell whether the candidate answered the question on
   * screen or scrolled back and tapped one from four questions ago.
   */
  contextWamid?: string;
  mediaId?: string;
  filename?: string;
  mimeType?: string;
  /** Which flow step this message asked or answered. Makes the transcript auditable. */
  step?: string;
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
   * confidence — an unscored field must never be treated as verified (§27).
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
  /** Slot key, e.g. 'cv' | 'passport' | 'aadhaar' | 'pan'. */
  docType: string;
  mediaId: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  originalFilename?: string;
  caption?: string;
  /** Set when a later upload replaced this one. Old versions are kept (§22). */
  supersededAt?: Date;
  ocr?: {
    status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
    extractor?: 'passport' | 'resume' | 'document';
    startedAt?: Date;
    finishedAt?: Date;
    error?: string;
    /** Raw payload, kept verbatim so extraction can be re-derived without re-OCRing. */
    raw?: unknown;
    /** Field-level extraction with provenance. The CRM reads this, not `raw`. */
    fields?: OcrField[];
    confidence?: number | null;
    needsReview?: boolean;
    reviewReasons?: string[];
    /** Document-completeness verdict (§14). Separate from extraction confidence. */
    completeness?: {
      complete: boolean;
      /** Plain-language problems to quote back to the candidate. */
      problems: string[];
      /** Page numbers to re-request, when the extractor can tell us. */
      missingPages?: number[];
    };
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

/**
 * Audit trail for the events §23 and §27 require us to be able to prove:
 * consent given, consent withdrawn, deletion requested, staff takeover.
 * Survives candidate deletion by design — it holds no document content.
 */
export interface AuditEventDoc {
  _id?: ObjectId;
  waId: string;
  candidateId?: string;
  event:
    | 'consent_given'
    | 'consent_refused'
    | 'consent_withdrawn'
    | 'deletion_requested'
    | 'deletion_completed'
    | 'handoff_requested'
    | 'handoff_returned'
    | 'registration_completed'
    | 'registration_restarted'
    | 'reminder_sent'
    | 'session_timed_out'
    | 'application_status_changed';
  detail?: string;
  at: Date;
}

export const candidates = (): Collection<CandidateDoc> =>
  getDb().collection<CandidateDoc>('candidates');
export const messages = (): Collection<MessageDoc> => getDb().collection<MessageDoc>('messages');
export const storedDocuments = (): Collection<StoredDocumentDoc> =>
  getDb().collection<StoredDocumentDoc>('documents');
export const processedEvents = (): Collection<ProcessedEventDoc> =>
  getDb().collection<ProcessedEventDoc>('processed_events');
export const auditEvents = (): Collection<AuditEventDoc> =>
  getDb().collection<AuditEventDoc>('audit_events');
/** Single-document counter behind the human-facing candidate id. */
const counters = (): Collection<{ _id: string; seq: number }> =>
  getDb().collection<{ _id: string; seq: number }>('counters');

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
    {
      key: { candidateId: 1 },
      unique: true,
      name: 'candidateId_unique',
      partialFilterExpression: { candidateId: { $type: 'string' } },
    },
    { key: { stage: 1, updatedAt: -1 }, name: 'stage_updatedAt' },
    { key: { status: 1, updatedAt: -1 }, name: 'status_updatedAt' },
    { key: { windowExpiresAt: 1 }, name: 'windowExpiresAt' },
    // Drives the §21 reminder sweep: incomplete, gone quiet, not yet reminded.
    { key: { reminderSentAt: 1, lastInboundAt: 1 }, name: 'reminder_sweep' },
    // Drives the idle-session sweep, which runs far more often than the reminder
    // one — every minute against a five-minute timeout.
    { key: { sessionEndedAt: 1, lastInboundAt: 1 }, name: 'session_sweep' },
    // The CRM's application board reads off this.
    { key: { 'application.status': 1, updatedAt: -1 }, name: 'application_status' },
    // Matching filters on these together often enough to earn a compound index.
    {
      key: { 'profile.primaryTrade': 1, 'profile.countryPreference': 1, status: 1 },
      name: 'match_trade_country',
    },
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
    { key: { candidateId: 1, docType: 1, createdAt: -1 }, name: 'candidate_docType' },
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

  await createIndexes(auditEvents(), [
    { key: { waId: 1, at: -1 }, name: 'waId_at' },
    { key: { event: 1, at: -1 }, name: 'event_at' },
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

export async function recordAudit(
  event: Omit<AuditEventDoc, '_id' | 'at'> & { at?: Date },
): Promise<void> {
  await auditEvents().insertOne({ ...event, at: event.at ?? new Date() });
}

/**
 * Allocates the next human-facing candidate id (§19).
 *
 * A counter document rather than a random string: candidates read these out over
 * the phone to staff, so they have to be short and unambiguous. findOneAndUpdate
 * with $inc is atomic, so two concurrent completions cannot collide.
 */
/**
 * Prefix on every human-facing id. Shared with the tracking flow, which has to
 * rebuild an id from whatever the candidate types — "42", "adr 42", "ADR-00042"
 * are all the same application.
 */
export const CANDIDATE_ID_PREFIX = 'ADR';

/** Digits in the sequence part of an id. The tracking flow pads to this. */
export const CANDIDATE_ID_DIGITS = 5;

export async function nextCandidateId(prefix = CANDIDATE_ID_PREFIX): Promise<string> {
  const result = await counters().findOneAndUpdate(
    { _id: 'candidateId' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const seq = result?.seq ?? 1;
  return `${prefix}-${String(seq).padStart(CANDIDATE_ID_DIGITS, '0')}`;
}
