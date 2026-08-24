import { ObjectId, type Collection } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../logger.js';
import { DOCUMENTS, TUNABLES } from '../conversation/rules.js';
import { ingestionRows } from '../ingestion/ledger.js';
import type { Language } from '../conversation/language.js';
import type { FlowVariant } from '../conversation/lines.js';

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
  /** Mid-way through the B2B branch (§2): name, Aadhaar, company certificate. */
  | 'B2B_PENDING'
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
  /**
   * The job they want, as a controlled value from `JOB_CATEGORY_CHOICES`.
   *
   * Kept beside `desiredOccupation` rather than replacing it: that field holds
   * the candidate's own words (§27) and a button id is not their words. This
   * one exists because the CRM's CV policy has to key on something matchable,
   * and "General Worker", "general labour" and "helper" are the same job typed
   * three ways.
   */
  jobCategory?: string;

  /**
   * Whether this candidate must supply a CV, and which policy version said so.
   *
   * The CRM decides — see `crm/client.ts`. Cached here because the bot needs
   * the answer mid-conversation to know whether the next question is "send your
   * CV", and because the CRM being briefly unreachable must not stall a
   * registration. It is never the authority: `POST /candidates` re-derives the
   * requirement and can still refuse, which is what makes this a cache rather
   * than a decision.
   */
  cvRequired?: boolean;
  cvPolicyVersion?: string;

  /* trade-specific answers, keyed by question id (§8) */
  tradeAnswers?: Record<string, string[]>;

  /* job preference (§9) */
  workTypePreference?: string;
  relatedAcceptance?: string;
  generalWorkWillingness?: string;
  generalJobs?: string[];
  trainingWillingness?: string;
  /**
   * How much a CV would add for the job they want (`conversation/jobLevel.ts`).
   *
   * Written only on the Singapore/Malaysia line, once the job preferences are
   * answered, and read by exactly one thing: whether the CV step is asked. It
   * is a property of the *job*, not an assessment of the candidate, and it is
   * deliberately not sent to the CRM — a recruiter reading a profile has the
   * job title itself, which is better evidence than our guess about it.
   *
   * Stored rather than recomputed so the CV question does not flicker between
   * turns, and so staff can see why a candidate was or was not asked.
   */
  jobLevel?: 'low_skill' | 'skilled' | 'unknown';
  /**
   * The job `jobLevel` was computed for, so a change re-computes it.
   *
   * The same pairing `tradeQuestionsFor` has with `tradeQuestions`, and for the
   * same reason: the stored pair is what stops the classification running on
   * every turn, and storing the level without the job it belongs to would make
   * an edit of the job preferences invisible to it.
   */
  jobLevelFor?: string;

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
  /**
   * MM/YYYY, read off the passport by the extractor.
   *
   * No longer typed by the candidate: the flow asks whether they hold a passport
   * and then for the booklet, and the date comes from the page. A value here
   * that predates that change may still be one they typed — `fieldMeta` says
   * which.
   */
  passportExpiry?: string;
  /**
   * The expiry the candidate has already been warned about (§12).
   *
   * Keyed on the date rather than a boolean so a *new* passport that is also
   * near expiry produces a new warning, while a clearer photo of the same
   * booklet does not produce a second one.
   */
  passportExpiryNotifiedFor?: string;
  /**
   * Retired with the passport-validity questions, which the extractor now
   * answers. Kept for records that hold them.
   */
  passportAppliedWhen?: string;
  passportRenewalIntent?: string;
  passportApplyWillingness?: string;

  /**
   * Retired with the Europe/Russia document branch — documents are asked of
   * everyone now. Kept for records that hold them.
   */
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

  /**
   * Which branch this conversation is on (§2).
   *
   *   apply  registration
   *   track  reading back a decision staff recorded
   *   b2b    a business contact, filed in its own collection
   *   staff  somebody who asked to speak to a person, and is being asked the
   *          seven questions that make that call useful (§24)
   */
  enquiry?: 'apply' | 'b2b' | 'track' | 'staff';

  /**
   * Which of the agency's numbers this conversation belongs to.
   *
   * Meta's `phone_number_id` for the line the first message arrived on. Kept
   * because a reply has to leave from the number the candidate wrote to, and
   * the reminder and idle-session sweeps send outside any inbound context and
   * would otherwise have nothing to send from. Absent on every record written
   * before there was a second number, which `sendingNumberFor` reads as the
   * main one.
   */
  phoneNumberId?: string;

  /**
   * Which list of questions this conversation walks (`conversation/lines.ts`).
   *
   * Derived from `phoneNumberId` when the record is created, and then left
   * alone. Recomputing it per turn would let an environment change move a
   * candidate mid-registration onto a flow that asks different questions, and
   * re-ask or skip whichever ones the two lists disagree about.
   *
   * Absent means the default flow, which is what every existing record means.
   */
  flowVariant?: FlowVariant;

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
  /**
   * The flow question a resume or reminder prompt displaced.
   *
   * There is only one open-step pointer, and a prompt offering "Continue" or
   * "Restart" has to hold it — otherwise the candidate's tap is read as an
   * answer to whatever was underneath. This is where the question underneath
   * waits, so "Continue session" can put it back rather than merely recomputing
   * the next one. Cleared the moment it is used, and by a restart.
   */
  resumeStep?: string;
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

  /**
   * How this candidate's handover to the recruitment CRM is going.
   *
   * The registration is complete and stored here the moment the candidate
   * confirms it; reaching the CRM is a separate thing that can fail on its own.
   * Keeping the two apart is what stops a CRM outage from costing a
   * registration — the record is safe, and this says whether it has been
   * delivered yet.
   *
   *   pending   queued, not yet accepted
   *   synced    the CRM has it, and `candidateId` is its id for them
   *   failed    attempts exhausted; an operator has to look
   *   needs_cv  the CRM's policy wants a CV this candidate has not sent. Not a
   *             failure of ours to fix by retrying — the candidate is asked
   *             again and the same submission is resent afterwards.
   */
  crmSync?: {
    status: 'pending' | 'synced' | 'failed' | 'needs_cv';
    /** The CRM's id for this candidate, which is not the same as ours. */
    candidateId?: string;
    attempts: number;
    lastError?: string;
    lastAttemptAt?: Date;
    syncedAt?: Date;
  };

  /**
   * An application lookup part-way through its identity check (§25, §27).
   *
   * Tracking asks for the Application ID and then for the date of birth on that
   * record, and this is what sits between the two: which application was
   * claimed, and how many times the date of birth has been got wrong. Both have
   * to be on the record rather than in memory — the attempts are the whole
   * point of the check, and a counter a candidate can reset by messaging again
   * is not a counter.
   *
   * Cleared the moment the check passes, is abandoned, or runs out of attempts.
   * It holds no personal data of its own: the id is one the candidate typed,
   * and the date of birth is compared and discarded, never stored here.
   */
  tracking?: {
    /**
     * The application the date-of-birth question is being asked about.
     *
     * Absent during the "I have lost my id" lookup, which runs the other way
     * round — a mobile number and a date of birth that between them name an id
     * nobody has typed yet.
     */
    candidateId?: string;
    attempts: number;
    startedAt: Date;
    /** Ids that missed. Two, and the lookup below is offered (§25). */
    idAttempts?: number;
    /** The mobile number given to the lookup, held while the date is asked for. */
    forgotMobile?: string;
    /** Mobile-and-date pairs that missed. Capped like the id check itself. */
    forgotAttempts?: number;
  };

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

/**
 * One message, inbound or outbound.
 *
 * Stored inside the session it belongs to rather than as a row of its own —
 * see `SessionDoc`. Everything here is what it always was; only where it lives
 * has changed, and `at` is the old `createdAt` under the name it reads better
 * as inside a list of turns.
 */
export interface MessageDoc {
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
  at: Date;
}

/**
 * One sitting: everything said between a candidate and the bot in one go.
 *
 * A message per document made `messages` unreadable — hundreds of rows per
 * candidate, in delivery order, with a conversation reconstructable only by
 * sorting and squinting. A session document *is* the transcript: open one and
 * read it top to bottom.
 *
 * A sitting ends the way §21's session does, after
 * `TUNABLES.sessionTimeoutMinutes` of silence, and `appendTurn` decides that
 * from the gap rather than from the candidate's state — so the log stays
 * correct even when the idle sweep never ran, which a restart or an outage can
 * cause. `closeOpenSession` is called from the places the app knows a sitting
 * ended, so `endedAt` reflects what happened rather than only what lapsed.
 *
 * `open` exists because MongoDB's partial indexes cannot filter on a missing
 * field. It is what makes "at most one open session per candidate" an index
 * rather than a convention, and it is unset — not set false — when a session
 * closes, so the partial index stops covering the row.
 */
export interface SessionDoc {
  _id?: ObjectId;
  waId: string;
  /** Present only while the session is open. See the note above. */
  open?: true;
  startedAt: Date;
  /** When the last turn landed. What the next turn is measured against. */
  lastAt: Date;
  /** Set when the sitting ends. */
  endedAt?: Date;
  turnCount: number;
  turns: MessageDoc[];
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

/** What an extractor made of one upload. Unchanged by the regrouping. */
export interface UploadOcr {
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  /**
   * Which extractor read it. Only three are routed to now (`rules.ts`);
   * 'document' appears on rows written before PAN cards, driving licences and
   * loose certificates stopped being read, and stays in the type because those
   * rows are still on file and §22 keeps them there.
   */
  extractor?: 'passport' | 'resume' | 'aadhaar' | 'document';
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
  /* ---------------------------------------------------------------- */
  /* Async Jobs API state (VERIS_OCR_ASYNC). Absent on rows written by  */
  /* the synchronous path, which is what makes the flag reversible.     */
  /* ---------------------------------------------------------------- */

  /** Veris job id, from `JobAccepted.job_id`. */
  jobId?: string;
  /** `JobAccepted.status_url` — stored rather than rebuilt, as the service issues it. */
  statusUrl?: string;
  submittedAt?: Date;
  /** Veris' own attempt counters, mirrored so the sweep can see them. */
  attempts?: number;
  maxAttempts?: number;
  /** Earliest the sweep may act on this upload again. */
  nextPollAt?: Date;
  /**
   * Held by the sweep tick currently working this upload.
   *
   * The compare-and-set on this field is what stops two ticks polling one job,
   * which would otherwise resume the conversation twice — two acknowledgements,
   * or two re-asks for the same document.
   */
  claimedAt?: Date;
  /**
   * What `inspectUpload` made of the bytes, captured at submission.
   *
   * Persisted because submit and terminal are now separate invocations and
   * `passportCompleteness` reads this at the terminal end. Without it §14's
   * page-count check silently stops working — the file is long gone from memory
   * by the time the job comes back.
   */
  inspection?: { readable: boolean; pages?: number; problem?: string };

  /** Document-completeness verdict (§14). Separate from extraction confidence. */
  completeness?: {
    complete: boolean;
    /** Plain-language problems to quote back to the candidate. */
    problems: string[];
    /** Page numbers to re-request, when the extractor can tell us. */
    missingPages?: number[];
    /** On `wrong_document`: which document the upload appears to be, if known. */
    looksLike?: string;
  };
}

/**
 * One file a candidate sent.
 *
 * `uploadId` is its own, and it is what the OCR job carries — the row's `_id`
 * used to serve that purpose, and an upload inside an array has no `_id` of its
 * own to use.
 */
export interface DocumentUpload {
  uploadId: ObjectId;
  mediaId: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  originalFilename?: string;
  caption?: string;
  /**
   * The message the file arrived on.
   *
   * Carried so the OCR job can build its idempotency key and find the ingestion
   * row without a scan — the ledger is keyed on the wamid and the upload had no
   * way to name it. Optional because rows written before this existed do not
   * have one, and §22 keeps those rows.
   */
  wamid?: string;
  /** Set when a later upload replaced this one. Old versions are kept (§22). */
  supersededAt?: Date;
  ocr?: UploadOcr;
  createdAt: Date;
  updatedAt: Date;
}

/** Every version of one kind of document, oldest first. */
export interface DocumentSection {
  uploads: DocumentUpload[];
}

/**
 * Everything one candidate has sent, grouped by what it is.
 *
 * A row per upload made this collection unreadable: a candidate who re-sent a
 * blurred passport twice had five rows across three kinds of document, and
 * telling which was current meant sorting on `supersededAt`. One record per
 * candidate, one section per kind, and the current version of anything is the
 * last entry in its section.
 *
 * The sections are the document kinds in `rules.ts` and nothing else. A kind
 * with no uploads has no section at all rather than an empty one, so what is
 * present is what was sent.
 *
 * Nothing is ever removed. §22 forbids destroying a superseded upload — a
 * candidate who sends a better scan of their passport has not withdrawn the
 * first one — so a replacement is a `supersededAt` on the old entry and a new
 * entry after it.
 */
export interface CandidateDocumentsDoc {
  _id?: ObjectId;
  waId: string;
  candidateId: ObjectId;
  cv?: DocumentSection;
  passport?: DocumentSection;
  aadhaar?: DocumentSection;
  pan?: DocumentSection;
  driving_licence?: DocumentSection;
  certificate?: DocumentSection;
  b2b_aadhaar_front?: DocumentSection;
  b2b_aadhaar_back?: DocumentSection;
  company_registration?: DocumentSection;
  createdAt: Date;
  updatedAt: Date;
}

/** An upload with the candidate and kind it belongs to, for callers that flatten. */
export interface LocatedUpload extends DocumentUpload {
  waId: string;
  candidateId: ObjectId;
  docType: string;
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
    | 'application_status_changed'
    /**
     * What the passport extractor read about the booklet's expiry (§12).
     *
     * Audited rather than merely logged because it is a thing the candidate was
     * told, and "nobody warned me" is a claim staff need to be able to answer.
     */
    | 'passport_expired'
    | 'passport_expiring_soon'
    /** A business contact chose the B2B branch (§2), so data collection began. */
    | 'b2b_enquiry_started'
    /**
     * Somebody asked to speak to a person (§24), so the intake began.
     *
     * Audited rather than only logged for the same reason consent is: it is the
     * moment a name and two identity documents started being collected from
     * somebody who had not registered for anything.
     */
    | 'staff_enquiry_started'
    | 'staff_enquiry_completed';
  detail?: string;
  at: Date;
}

export const candidates = (): Collection<CandidateDoc> =>
  getDb().collection<CandidateDoc>(COLLECTIONS.candidates);
/**
 * Business contacts (§2), kept out of `candidates` entirely.
 *
 * The record has the same shape — it is still a conversation, with a stage, a
 * current step and a document checklist — but it is not a candidate, has no
 * application and never gets an Application ID. Filing it separately is what
 * keeps a recruiter's candidate list, the §21 reminder sweep and the matching
 * indexes free of people who wrote in to sell something.
 */
export const b2bEnquiries = (): Collection<CandidateDoc> =>
  getDb().collection<CandidateDoc>(COLLECTIONS.b2bEnquiries);
export const messages = (): Collection<SessionDoc> => getDb().collection<SessionDoc>('messages');
export const storedDocuments = (): Collection<CandidateDocumentsDoc> =>
  getDb().collection<CandidateDocumentsDoc>(COLLECTIONS.documents);
/** The same, for the files a business contact sends. */
export const b2bDocuments = (): Collection<CandidateDocumentsDoc> =>
  getDb().collection<CandidateDocumentsDoc>(COLLECTIONS.b2bDocuments);
export const processedEvents = (): Collection<ProcessedEventDoc> =>
  getDb().collection<ProcessedEventDoc>('processed_events');
export const auditEvents = (): Collection<AuditEventDoc> =>
  getDb().collection<AuditEventDoc>('audit_events');
/** Single-document counter behind the human-facing candidate id. */
const counters = (): Collection<{ _id: string; seq: number }> =>
  getDb().collection<{ _id: string; seq: number }>('counters');

/* ─────────────────────────────────────────────────────────────────────────────
 * Which collection a record lives in
 *
 * Two branches, two sets of collections. Everything that reads or writes a
 * conversation goes through `recordsFor`, and everything that reads or writes an
 * upload goes through `documentStoreFor`, so "B2B is filed apart" is one
 * decision made in one place rather than a rule every caller has to remember.
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * The names, separately from the collections.
 *
 * Both routing rules are pure functions of a string, and naming them that way
 * is what lets them be asserted without a database — the two decisions this
 * whole split rests on are worth a unit test.
 */
export const COLLECTIONS = {
  candidates: 'candidates',
  b2bEnquiries: 'b2b_enquiries',
  documents: 'documents',
  b2bDocuments: 'b2b_documents',
} as const;

/** Which collection this conversation's record lives in, from what they chose (§2). */
export function recordCollectionFor(enquiry: CandidateDoc['enquiry']): string {
  return enquiry === 'b2b' ? COLLECTIONS.b2bEnquiries : COLLECTIONS.candidates;
}

/** Document kinds only the B2B branch asks for, from `rules.ts`. */
const B2B_DOCUMENT_KINDS: ReadonlySet<string> = new Set(
  DOCUMENTS.filter((d) => d.branch === 'b2b').map((d) => d.id),
);

/**
 * Which collection an upload is filed in.
 *
 * Routed on the kind rather than on the contact, because the two branches ask
 * for disjoint kinds — a `company_registration` can only have come from a
 * business contact — and every caller that writes an upload already has one.
 */
export function documentCollectionFor(docType: string): string {
  return B2B_DOCUMENT_KINDS.has(docType) ? COLLECTIONS.b2bDocuments : COLLECTIONS.documents;
}

export function recordsFor(enquiry: CandidateDoc['enquiry']): Collection<CandidateDoc> {
  return getDb().collection<CandidateDoc>(recordCollectionFor(enquiry));
}

export function documentStoreFor(docType: string): Collection<CandidateDocumentsDoc> {
  return getDb().collection<CandidateDocumentsDoc>(documentCollectionFor(docType));
}

/**
 * The conversation record for a number, whichever collection holds it.
 *
 * A number is in exactly one of the two — `refileConversation` moves a record,
 * it never copies one. Candidates are checked first because they are the
 * overwhelming majority.
 */
export async function findConversation(waId: string): Promise<CandidateDoc | null> {
  return (await candidates().findOne({ waId })) ?? (await b2bEnquiries().findOne({ waId }));
}

/** The same lookup by `_id`, for the OCR worker's callbacks. */
export async function findConversationById(id: ObjectId): Promise<CandidateDoc | null> {
  return (await candidates().findOne({ _id: id })) ?? (await b2bEnquiries().findOne({ _id: id }));
}

/**
 * Moves a conversation into the collection its branch belongs to.
 *
 * Every conversation starts in `candidates`, because until the opening menu is
 * answered there is nothing to say it is anything else. This runs the instant
 * that answer is "B2B enquiry" — before a single question is asked, so no
 * business contact's name or document is ever written to the candidate
 * collection, not even briefly — and it runs the other way when a deleted
 * record starts over and is a blank conversation again (§23).
 *
 * `_id` is preserved: uploads point at it, and a new one would orphan them.
 * `replaceOne` with an upsert rather than an insert, so a repeat is a no-op
 * rather than a duplicate-key error. A record is never left in both: the
 * delete follows a write that has already succeeded.
 */
export async function refileConversation(
  candidate: CandidateDoc,
  enquiry: CandidateDoc['enquiry'],
): Promise<void> {
  const from = recordCollectionFor(candidate.enquiry);
  const to = recordCollectionFor(enquiry);
  if (from === to) return;

  const now = new Date();
  const record: CandidateDoc = { ...candidate, enquiry, updatedAt: now };

  await recordsFor(enquiry).replaceOne({ _id: record._id! }, record, { upsert: true });
  await getDb().collection<CandidateDoc>(from).deleteOne({ _id: record._id! });

  // The caller holds this object and keeps using it after we return; without
  // this its next write would go back to the collection we just left.
  candidate.enquiry = enquiry;
  candidate.updatedAt = now;
}

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

  // A business contact has no Application ID and no matching profile, so this
  // carries only the indexes a conversation actually needs.
  await createIndexes(b2bEnquiries(), [
    { key: { waId: 1 }, unique: true, name: 'waId_unique' },
    { key: { stage: 1, updatedAt: -1 }, name: 'stage_updatedAt' },
    { key: { sessionEndedAt: 1, lastInboundAt: 1 }, name: 'session_sweep' },
  ]);

  await createIndexes(messages(), [
    { key: { waId: 1, startedAt: -1 }, name: 'waId_startedAt' },
    // At most one open sitting per candidate, enforced rather than assumed —
    // two open sessions would split one conversation across two documents and
    // neither would read as a transcript. Partial on `open` because MongoDB
    // cannot build a partial index on a field being absent.
    {
      key: { waId: 1 },
      unique: true,
      name: 'one_open_session',
      partialFilterExpression: { open: true },
    },
    // Both wamid lookups go through this: the worker reading back the message
    // it was queued for, and the stale-tap guard asking which question an
    // outbound message posed. Multikey over the turns array.
    { key: { 'turns.wamid': 1 }, name: 'turns_wamid' },
  ]);

  // One record per candidate, so the sections are addressable by waId alone and
  // a second record for the same person cannot exist.
  await createIndexes(storedDocuments(), [
    { key: { waId: 1 }, unique: true, name: 'waId_unique' },
    { key: { candidateId: 1 }, name: 'candidateId' },
    // The CRM's review queue reads across sections, so it needs one index per
    // kind — a multikey index cannot span sibling fields.
    ...DOCUMENTS.filter((d) => d.branch !== 'b2b').map((d) => ({
      key: { [`${d.id}.uploads.ocr.needsReview`]: 1 },
      name: `${d.id}_needsReview`,
    })),
  ]);

  await createIndexes(b2bDocuments(), [
    { key: { waId: 1 }, unique: true, name: 'waId_unique' },
    { key: { candidateId: 1 }, name: 'candidateId' },
    ...DOCUMENTS.filter((d) => d.branch === 'b2b').map((d) => ({
      key: { [`${d.id}.uploads.ocr.needsReview`]: 1 },
      name: `${d.id}_needsReview`,
    })),
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

  // The ingestion ledger (`ingestion/ledger.ts`).
  //
  // The first index is the deduplication boundary `automation-integration.md`
  // specifies, and it is the load-bearing one: an attachment is identified by
  // where it came from and what it was attached to, never by the message alone.
  // Unique, so a duplicate webhook delivery cannot open a second row for a file
  // that is already halfway through extraction — and so the upsert in
  // `openIngestion` has something to race against.
  //
  // No TTL here, unlike `processed_events`. That table exists to forget; this
  // one is the record of what happened to a candidate's documents.
  await createIndexes(ingestionRows(), [
    {
      key: { provider: 1, account: 1, messageId: 1, attachmentId: 1 },
      unique: true,
      name: 'attachment_unique',
    },
    { key: { idempotencyKey: 1 }, unique: true, name: 'idempotencyKey_unique' },
    // What the reconciler sweeps: unfinished rows whose next attempt is due,
    // oldest first.
    { key: { status: 1, nextAttemptAt: 1 }, name: 'status_nextAttemptAt' },
    // What the age alert reads, and what the review queue is ordered by.
    { key: { status: 1, receivedAt: 1 }, name: 'status_receivedAt' },
    { key: { waId: 1, receivedAt: -1 }, name: 'waId_receivedAt' },
  ]);

  logger.info('mongodb indexes ensured');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Sessions
 *
 * The only four things anything outside this file does with the transcript:
 * add a turn, find a turn by its wamid, record that a send failed, and close
 * the sitting. Keeping them here is what lets the storage shape change without
 * the engine knowing it did.
 * ───────────────────────────────────────────────────────────────────────────*/

/** How long a sitting may go quiet before the next message starts a new one. */
const SESSION_GAP_MS = TUNABLES.sessionTimeoutMinutes * 60_000;

/**
 * Appends one message to the candidate's open session, starting one if needed.
 *
 * The upsert and the unique partial index do the concurrency work between them:
 * two turns arriving at once either both append to the same session, or one
 * loses the insert race with a duplicate-key error and retries into the session
 * the other just created.
 */
export async function appendTurn(turn: MessageDoc): Promise<void> {
  const at = turn.at;

  // A sitting that went quiet for longer than the timeout is over, whether or
  // not the sweep noticed. Closing it here keeps the transcript honest.
  await messages().updateOne(
    { waId: turn.waId, open: true, lastAt: { $lt: new Date(at.getTime() - SESSION_GAP_MS) } },
    { $set: { endedAt: at }, $unset: { open: '' } },
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await messages().updateOne(
        { waId: turn.waId, open: true },
        {
          $push: { turns: turn },
          $inc: { turnCount: 1 },
          $set: { lastAt: at },
          $setOnInsert: { waId: turn.waId, open: true, startedAt: at },
        },
        { upsert: true },
      );
      return;
    } catch (err) {
      // Two turns raced to open the same session. The other one won; append to it.
      if ((err as { code?: number }).code !== 11000 || attempt === 1) throw err;
    }
  }
}

/** One turn, found by the id Meta gave it. */
export async function findTurn(
  wamid: string,
  direction: 'inbound' | 'outbound',
): Promise<MessageDoc | undefined> {
  const session = await messages().findOne(
    { turns: { $elemMatch: { wamid, direction } } },
    { projection: { turns: { $elemMatch: { wamid, direction } } } },
  );
  return session?.turns?.[0];
}

/** Records that Meta could not deliver an outbound message. */
export async function markTurnFailed(wamid: string, error: string): Promise<void> {
  await messages().updateOne(
    { turns: { $elemMatch: { wamid, direction: 'outbound' } } },
    { $set: { 'turns.$[turn].error': error } },
    { arrayFilters: [{ 'turn.wamid': wamid, 'turn.direction': 'outbound' }] },
  );
}

/**
 * Ends the open sitting, if there is one.
 *
 * Called where the app knows a session finished — the idle sweep, a restart, a
 * completed registration — so `endedAt` says when rather than being inferred
 * from the next message that happens to arrive.
 */
export async function closeOpenSession(waId: string, at = new Date()): Promise<void> {
  await messages().updateOne(
    { waId, open: true },
    { $set: { endedAt: at }, $unset: { open: '' } },
  );
}

/**
 * Every turn with this candidate, across every sitting, in order.
 *
 * The flat view, for callers that want the conversation rather than the
 * sittings it happened to be split into — the harness printing a transcript,
 * and anything counting what the bot said.
 */
export async function turnsFor(waId: string): Promise<MessageDoc[]> {
  const sessions = await messages().find({ waId }).sort({ startedAt: 1 }).toArray();
  return sessions.flatMap((session) => session.turns ?? []);
}

/** Every sitting with this candidate, oldest first. The transcript. */
export async function sessionsFor(waId: string, limit = 50): Promise<SessionDoc[]> {
  return messages().find({ waId }).sort({ startedAt: 1 }).limit(limit).toArray();
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Documents
 *
 * Every read and write of a candidate's files goes through these five, so the
 * section-per-kind layout stays here rather than spreading into the engine and
 * the OCR worker as string paths.
 * ───────────────────────────────────────────────────────────────────────────*/

/** Kinds that may be stored, from `rules.ts`. Guards a dynamic field path. */
function sectionFor(docType: string): string {
  if (!DOCUMENTS.some((d) => d.id === docType)) {
    throw new Error(`unknown document kind "${docType}"`);
  }
  return docType;
}

/**
 * Files one upload into its section, superseding whatever it replaces.
 *
 * The previous current version is marked rather than removed (§22), so the
 * section is a history and the last entry is what counts now.
 */
export async function addUpload(params: {
  waId: string;
  candidateId: ObjectId;
  docType: string;
  upload: Omit<DocumentUpload, 'uploadId' | 'createdAt' | 'updatedAt'>;
}): Promise<ObjectId> {
  const section = sectionFor(params.docType);
  const now = new Date();
  const uploadId = new ObjectId();

  // Everything already in this section is now a previous version.
  //
  // Guarded on the section existing: MongoDB refuses an `arrayFilters` update
  // when the path is absent — "the path must exist in the document in order to
  // apply array updates" — so the first upload of a kind would throw rather
  // than supersede the nothing that is there.
  const store = documentStoreFor(params.docType);

  await store.updateOne(
    { waId: params.waId, [`${section}.uploads.0`]: { $exists: true } },
    { $set: { [`${section}.uploads.$[current].supersededAt`]: now } },
    { arrayFilters: [{ 'current.supersededAt': { $exists: false } }] },
  );

  await store.updateOne(
    { waId: params.waId },
    {
      $push: { [`${section}.uploads`]: { ...params.upload, uploadId, createdAt: now, updatedAt: now } },
      $set: { candidateId: params.candidateId, updatedAt: now },
      $setOnInsert: { waId: params.waId, createdAt: now },
    },
    { upsert: true },
  );

  return uploadId;
}

/* ------------------------------------------------------------------ */
/* Async extraction sweep support                                      */
/* ------------------------------------------------------------------ */

/** One upload the OCR sweep may have work to do on. */
export interface DueExtraction {
  waId: string;
  docType: string;
  uploadId: ObjectId;
  ocr: UploadOcr;
}

/**
 * Uploads whose extraction is unfinished and due.
 *
 * Scans both document collections, one query per section, because an upload
 * lives inside `<section>.uploads[]` and there is no collection of uploads to
 * query directly. `nextPollAt` is what keeps this cheap: a job that is not due
 * is filtered in the database rather than fetched and discarded.
 *
 * A stale claim is treated as no claim. A process that dies mid-poll would
 * otherwise leave an upload claimed forever, and the whole point of the sweep
 * is that nothing gets stranded.
 */
export async function dueExtractions(params: {
  now?: Date;
  staleClaimMs: number;
  limit?: number;
}): Promise<DueExtraction[]> {
  const now = params.now ?? new Date();
  const claimCutoff = new Date(now.getTime() - params.staleClaimMs);
  const out: DueExtraction[] = [];

  for (const docType of DOCUMENTS.map((d) => d.id)) {
    const section = sectionFor(docType);
    const store = documentStoreFor(docType);

    const rows = await store
      .find(
        {
          [`${section}.uploads`]: {
              $elemMatch: {
              'ocr.status': { $in: ['queued', 'running'] },
            },
          },
        },
        { projection: { waId: 1, [section]: 1 } },
      )
      .limit(params.limit ?? 200)
      .toArray();

    for (const row of rows) {
      const uploads = (row as unknown as Record<string, { uploads?: DocumentUpload[] }>)[section]
        ?.uploads;
      for (const upload of uploads ?? []) {
        const ocr = upload.ocr;
        // Superseded uploads are still driven to a terminal state. Their verdict
        // is discarded — `uploadStillCurrent` sees to that — but abandoning them
        // mid-flight would leave rows reading `running` forever, which is the
        // stuck-job condition an operator is meant to be able to alert on.
        if (!ocr) continue;
        if (ocr.status !== 'queued' && ocr.status !== 'running') continue;
        if (ocr.nextPollAt && ocr.nextPollAt > now) continue;
        if (ocr.claimedAt && ocr.claimedAt > claimCutoff) continue;
        out.push({ waId: row.waId, docType, uploadId: upload.uploadId, ocr });
      }
    }
  }

  return out;
}

/**
 * Takes exclusive ownership of one extraction, or reports that someone else has it.
 *
 * The compare-and-set is the whole mechanism: the filter matches only while the
 * upload is unclaimed or its claim has gone stale, so two sweep ticks racing on
 * the same upload produce exactly one `modifiedCount === 1`. Without it the
 * terminal path could run twice and the candidate would be answered twice.
 */
export async function claimExtraction(params: {
  waId: string;
  docType: string;
  uploadId: ObjectId;
  staleClaimMs: number;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const claimCutoff = new Date(now.getTime() - params.staleClaimMs);
  const section = sectionFor(params.docType);

  const res = await documentStoreFor(params.docType).updateOne(
    {
      waId: params.waId,
      [`${section}.uploads`]: {
        $elemMatch: {
          uploadId: params.uploadId,
          'ocr.status': { $in: ['queued', 'running'] },
          // `null` matches both a missing field and an explicit null, which a
          // row written before the `$unset` fix above will carry.
          $or: [{ 'ocr.claimedAt': null }, { 'ocr.claimedAt': { $lte: claimCutoff } }],
        },
      },
    },
    { $set: { [`${section}.uploads.$[u].ocr.claimedAt`]: now } },
    { arrayFilters: [{ 'u.uploadId': params.uploadId }] },
  );

  return res.modifiedCount === 1;
}

/** Gives the claim back, so the next tick may pick the upload up immediately. */
export async function releaseExtraction(
  waId: string,
  docType: string,
  uploadId: ObjectId,
): Promise<void> {
  const section = sectionFor(docType);
  await documentStoreFor(docType).updateOne(
    { waId, [`${section}.uploads.0`]: { $exists: true } },
    { $unset: { [`${section}.uploads.$[u].ocr.claimedAt`]: '' } },
    { arrayFilters: [{ 'u.uploadId': uploadId }] },
  );
}

/** One upload, by the id the OCR job carries. */
export async function findUpload(
  waId: string,
  docType: string,
  uploadId: ObjectId,
): Promise<DocumentUpload | undefined> {
  const section = sectionFor(docType);
  const record = await documentStoreFor(docType).findOne(
    { waId },
    { projection: { [`${section}.uploads`]: 1 } },
  );
  return (record as unknown as Record<string, DocumentSection | undefined> | null)?.[
    section
  ]?.uploads?.find(
    (u) => u.uploadId.equals(uploadId),
  );
}

/** Writes fields onto one upload, addressed within its section. */
export async function updateUpload(
  waId: string,
  docType: string,
  uploadId: ObjectId,
  patch: Record<string, unknown>,
): Promise<void> {
  const section = sectionFor(docType);
  const now = new Date();
  const set: Record<string, unknown> = { updatedAt: now, [`${section}.uploads.$[u].updatedAt`]: now };
  const unset: Record<string, ''> = {};

  for (const [key, value] of Object.entries(patch)) {
    const path = `${section}.uploads.$[u].${key}`;
    // `undefined` means remove, not store null. The driver serialises an
    // undefined value as null, and a null is not absent: `{$exists: false}`
    // stops matching, and a range comparison against a Date never matches a
    // null. Clearing `ocr.claimedAt` this way left every extraction permanently
    // unclaimable and the sweep silently stopped polling anything.
    if (value === undefined) unset[path] = '';
    else set[path] = value;
  }

  await documentStoreFor(docType).updateOne(
    { waId, [`${section}.uploads.0`]: { $exists: true } },
    Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set },
    { arrayFilters: [{ 'u.uploadId': uploadId }] },
  );
}

/**
 * Marks every current upload in every section as superseded (§23).
 *
 * One update per section rather than one across all of them, because an
 * `arrayFilters` update throws on a section the candidate never sent anything
 * for — and most candidates have several of those.
 */
export async function supersedeAllUploads(waId: string, at = new Date()): Promise<void> {
  for (const requirement of DOCUMENTS) {
    // §23 is about everything this number sent, so it reaches into whichever
    // store each kind is filed in rather than assuming the candidate one.
    await documentStoreFor(requirement.id).updateOne(
      { waId, [`${requirement.id}.uploads.0`]: { $exists: true } },
      {
        $set: { updatedAt: at, [`${requirement.id}.uploads.$[current].supersededAt`]: at },
      },
      { arrayFilters: [{ 'current.supersededAt': { $exists: false } }] },
    );
  }
}

/**
 * Everything one contact has sent, as stored.
 *
 * `docType` says which store to look in. Callers always have one — it is the
 * kind they are working on — and passing it avoids a second query for the
 * overwhelming majority of reads, which are about a candidate.
 */
export async function documentsFor(
  waId: string,
  docType?: string,
): Promise<CandidateDocumentsDoc | null> {
  if (docType) return documentStoreFor(docType).findOne({ waId });
  return (await storedDocuments().findOne({ waId })) ?? (await b2bDocuments().findOne({ waId }));
}

/**
 * Every upload for a candidate as one flat list, newest last.
 *
 * For callers that want the files rather than the filing — the CRM listing, the
 * inspector, the harness.
 */
export async function uploadsFor(waId: string): Promise<LocatedUpload[]> {
  // Both stores, because this answers "what has this number sent us?" and the
  // caller asking that has no reason to know which branch the number is in.
  const records = await Promise.all([
    storedDocuments().findOne({ waId }),
    b2bDocuments().findOne({ waId }),
  ]);

  return records
    .flatMap((record) => (record ? flattenUploads(record) : []))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** The same flattening, for a record already in hand. */
export function flattenUploads(record: CandidateDocumentsDoc): LocatedUpload[] {
  const out: LocatedUpload[] = [];
  for (const requirement of DOCUMENTS) {
    const section = (record as unknown as Record<string, DocumentSection | undefined>)[
      requirement.id
    ];
    for (const upload of section?.uploads ?? []) {
      out.push({ ...upload, waId: record.waId, candidateId: record.candidateId, docType: requirement.id });
    }
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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

/**
 * The prefix on a staff enquiry's reference number (§24).
 *
 * Deliberately not `ADR`. An ADR id means a registration a recruiter can work
 * on; this is somebody who asked for a call back, and giving the two the same
 * shape would have staff opening one expecting the other. Its own counter too,
 * so the two series do not interleave and neither can be used to guess how many
 * of the other there are.
 */
export const ENQUIRY_ID_PREFIX = 'ENQ';

/** Digits in the sequence part of an id. The tracking flow pads to this. */
export const CANDIDATE_ID_DIGITS = 5;

export async function nextCandidateId(
  prefix = CANDIDATE_ID_PREFIX,
  counter = 'candidateId',
): Promise<string> {
  const result = await counters().findOneAndUpdate(
    { _id: counter },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const seq = result?.seq ?? 1;
  return `${prefix}-${String(seq).padStart(CANDIDATE_ID_DIGITS, '0')}`;
}

/**
 * The next staff-enquiry reference number (§24).
 *
 * Its own counter, so `ENQ-00001` is the first call-back request rather than
 * whatever number the registrations happened to have reached.
 */
export function nextEnquiryId(): Promise<string> {
  return nextCandidateId(ENQUIRY_ID_PREFIX, 'enquiryId');
}
