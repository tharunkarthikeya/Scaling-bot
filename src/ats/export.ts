/**
 * Copying a finished conversation into the ATS.
 *
 * Runs as a queue job, after the person has been told they are done — never
 * during the conversation, for the reason `crm/sync.ts` gives at length: a
 * registration succeeds when the candidate finishes answering, and whether
 * another database is reachable at that second is not their problem.
 *
 * Three shapes go across, and which one depends on the branch the conversation
 * took (§2):
 *
 *   apply   candidate → `candidates`, conversation → `messages`,
 *           documents → `aadhaar_records` / `passport_records`
 *   staff   the same three. Somebody who asked to speak to a person gave us the
 *           same name and the same documents, and a recruiter opening them
 *           should not have to know which menu they came through.
 *   b2b     a business contact → `sourcing_clients`, `b2b_company_documents`,
 *           `b2b_messages`, `b2b_agent_aadhar`. Filed apart in the bot's own
 *           database and filed apart here, because an agent sourcing workers is
 *           not somebody applying for a job.
 *
 * Every row carries `source: 'whatsapp'`. Documents upsert on upload id;
 * candidates resolve on normalized passport first, Aadhaar second and phone
 * only as a fallback. Re-exporting the same person therefore updates their row
 * even when the document arrived late or they used another WhatsApp number.
 */

import type { ObjectId } from 'mongodb';
import { logger } from '../logger.js';
import { externalCandidateDeliveryBlocked } from '../conversation/eligibility.js';
import {
  documentsFor,
  findConversation,
  type CandidateDoc,
  type CandidateDocumentsDoc,
  type DocumentUpload,
  type MessageDoc,
  type OcrField,
  type SessionDoc,
} from '../db/models.js';
import { messages as botSessions } from '../db/models.js';
import { routeFor } from '../conversation/flow.js';
import {
  contactsFor,
  normalizeAadhaarNumber,
  normalizePassportNumber,
} from '../identity.js';
import { atsCollection, atsConfigured, ATS_COLLECTIONS } from './client.js';
import { writeResolvedAtsCandidate } from './identity.js';

/** What every row this file writes says about where it came from. */
const SOURCE = 'whatsapp' as const;

/**
 * What a business contact is, in the ATS's own vocabulary.
 *
 * `sourcing_clients` holds more than one kind of thing, and this is the token
 * that says which of them these rows are. Change it here if the ATS spells it
 * differently — it is written to every row and read by nothing else in this
 * codebase.
 */
const B2B_CLIENT_TYPE = 'b2b agents' as const;

/* ─────────────────────────────────────────────────────────────────────────────
 * The shapes
 * ───────────────────────────────────────────────────────────────────────────*/

/** An extracted field, flattened to what a reader of the ATS actually wants. */
interface ExportedField {
  key: string;
  value: string;
  /** Null means the extractor returned no score. Null is not confidence (§27). */
  confidence: number | null;
  page?: number;
}

interface ExportedDocument {
  waId: string;
  applicationId?: string;
  candidateName?: string;
  source: typeof SOURCE;

  /** Which kind of document this is, in the bot's own vocabulary. */
  documentType: string;
  uploadId: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  originalFilename?: string;

  /**
   * Whether this is the version in force.
   *
   * Every version is exported and nothing is ever removed (§22), so a reader
   * wanting "their Aadhaar" filters on this rather than guessing from dates.
   */
  isCurrent: boolean;
  supersededAt?: Date;

  /** Absent on a document nothing reads — the PAN, a company certificate. */
  ocr?: {
    status: string;
    /** Which extractor read it, where one did. */
    extractor?: string;
    fields: ExportedField[];
    /**
     * Whether a person still has to look at it.
     *
     * True on every passport by design: half of §14's checklist is a
     * page-by-page human judgement no extractor makes, and a clean MRZ read is
     * not evidence the booklet is complete.
     */
    needsReview?: boolean;
    reviewReasons?: string[];
    finishedAt?: Date;
  };

  uploadedAt: Date;
  exportedAt: Date;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Mapping
 * ───────────────────────────────────────────────────────────────────────────*/

function fieldsOf(upload: DocumentUpload): ExportedField[] {
  const raw = (upload.ocr?.fields ?? []) as OcrField[];
  return raw.map((f) => ({
    key: f.key,
    value: f.value,
    confidence: f.confidence,
    ...(f.page !== undefined ? { page: f.page } : {}),
  }));
}

/**
 * One upload, as the ATS stores it.
 *
 * `withOcr` is false for the kinds nothing reads. It is a parameter rather than
 * a lookup because the two callers know the answer for different reasons: a
 * company certificate has no extractor by policy, and a PAN has none because
 * `NEVER_OCR` forbids one.
 */
function exportedDocument(params: {
  candidate: CandidateDoc;
  documentType: string;
  upload: DocumentUpload;
  isCurrent: boolean;
  withOcr: boolean;
}): ExportedDocument {
  const { candidate, upload } = params;

  const row: ExportedDocument = {
    waId: candidate.waId,
    ...(candidate.candidateId ? { applicationId: candidate.candidateId } : {}),
    ...(candidate.profile?.fullName ? { candidateName: candidate.profile.fullName } : {}),
    source: SOURCE,
    documentType: params.documentType,
    uploadId: upload.uploadId.toHexString(),
    storageKey: upload.storageKey,
    mimeType: upload.mimeType,
    byteSize: upload.byteSize,
    sha256: upload.sha256,
    ...(upload.originalFilename ? { originalFilename: upload.originalFilename } : {}),
    isCurrent: params.isCurrent,
    ...(upload.supersededAt ? { supersededAt: upload.supersededAt } : {}),
    uploadedAt: upload.createdAt,
    exportedAt: new Date(),
  };

  if (params.withOcr && upload.ocr) {
    row.ocr = {
      status: upload.ocr.status,
      ...(upload.ocr.extractor ? { extractor: upload.ocr.extractor } : {}),
      fields: fieldsOf(upload),
      ...(upload.ocr.needsReview !== undefined ? { needsReview: upload.ocr.needsReview } : {}),
      ...(upload.ocr.reviewReasons?.length ? { reviewReasons: upload.ocr.reviewReasons } : {}),
      ...(upload.ocr.finishedAt ? { finishedAt: upload.ocr.finishedAt } : {}),
    };
  }

  return row;
}

/**
 * The candidate record, as the ATS stores it.
 *
 * Their answers, flattened — the ATS reads fields, not the bot's step ids. What
 * is deliberately *not* here: the conversation position, the edit queue, the
 * unclear counter, the trade questions the model wrote. Those are how the bot
 * runs a conversation, and none of them mean anything to a recruiter.
 */
function exportedCandidate(candidate: CandidateDoc): Record<string, unknown> {
  const p = candidate.profile ?? {};

  return {
    source: SOURCE,
    waId: candidate.waId,
    phone: candidate.phone,
    /** `apply` or `staff` — how they reached us, kept because it changes what was asked. */
    enquiry: candidate.enquiry ?? 'apply',
    /** Which of the agency's numbers they wrote to (`conversation/lines.ts`). */
    whatsappNumberId: candidate.phoneNumberId,
    /**
     * Which of the two routes they walked, worked out from the destination they
     * chose rather than read off the record — there is no stored copy of it any
     * more, because a destination edited later (§22) would leave one behind
     * (`routeFor` in `conversation/flow.ts`).
     */
    flowVariant: routeFor(candidate),

    applicationId: candidate.candidateId,
    applicationStatus: candidate.application?.status,
    stage: candidate.stage,
    status: candidate.status,

    fullName: p.fullName,
    dateOfBirth: p.dateOfBirth,
    email: p.email,
    mobileNumber: p.mobileNumber ?? candidate.phone,
    alternateNumber: p.alternateNumber,
    nationality: p.nationality,
    fatherName: p.fatherName,

    currentCity: p.currentCity,
    currentDistrict: p.currentDistrict,
    currentState: p.currentState,
    currentCountry: p.currentCountry,

    education: p.education,
    educationCourse: p.educationCourse,

    primaryTrade: p.primaryTrade,
    currentOccupation: p.currentOccupation,
    totalExperienceBand: p.totalExperienceBand,
    totalExperienceYears: p.totalExperienceYears,
    overseasCountries: p.overseasCountries,
    employers: p.employers,
    skills: p.skills,
    certifications: p.certifications,
    tradeAnswers: p.tradeAnswers,

    jobCategory: p.jobCategory,
    desiredOccupation: p.desiredOccupation,
    workTypePreference: p.workTypePreference,
    generalJobs: p.generalJobs,
    trainingWillingness: p.trainingWillingness,
    /** Only ever set for a Singapore/Malaysia candidate; see `conversation/jobLevel.ts`. */
    jobLevel: p.jobLevel,

    countryPreference: p.countryPreference,
    selectedCountries: p.selectedCountries,
    countryStrictness: p.countryStrictness,

    availability: p.availability,
    availabilityNote: p.availabilityNote,

    passportStatus: p.passportStatus,
    passportNumber: p.passportNumber,
    passportNumberNormalized: normalizePassportNumber(p.passportNumber),
    passportExpiry: p.passportExpiry,
    aadhaarNumber: p.aadhaarNumber,
    aadhaarNumberNormalized: normalizeAadhaarNumber(p.aadhaarNumber),

    // A CV number and the number used on WhatsApp remain separate contact
    // routes on this one person. Neither is allowed to outrank a passport.
    contacts: contactsFor(candidate),

    language: candidate.language,
    languageOther: candidate.languageOther,
    consentGivenAt: candidate.consent?.given ? candidate.consent.at : undefined,

    /**
     * What is on file, and where the bytes are.
     *
     * The Aadhaar and the passport have records of their own; this is the index,
     * and it is also the only place the PAN appears — nothing reads a PAN
     * (`NEVER_OCR`), so it has no extraction to file and no record collection
     * was asked for. It is named here so a documentation officer can find it.
     */
    documents: documentIndex(candidate),

    registeredAt: candidate.completedAt,
    firstContactAt: candidate.createdAt,
    lastMessageAt: candidate.lastInboundAt,
    exportedAt: new Date(),
  };
}

/**
 * The business contact, as a sourcing client.
 *
 * `type` is what distinguishes them from whatever else sources workers into the
 * ATS, and `source` is how they reached us — the same `whatsapp` every other
 * row this file writes carries.
 *
 * What is deliberately thin: the B2B branch asks four questions, so there are
 * four things to say. Their Aadhaar and their company paperwork have rows of
 * their own; this names the person those rows belong to.
 */
function exportedSourcingClient(candidate: CandidateDoc): Record<string, unknown> {
  return {
    source: SOURCE,
    /** Which kind of sourcing client. Set for every row the bot writes here. */
    type: B2B_CLIENT_TYPE,

    waId: candidate.waId,
    phone: candidate.phone,
    contactName: candidate.profile?.fullName ?? candidate.profileName,
    /** Which of the agency's numbers they wrote to (`conversation/lines.ts`). */
    whatsappNumberId: candidate.phoneNumberId,

    stage: candidate.stage,
    status: candidate.status,
    language: candidate.language,

    /** What they sent, and where the bytes are. The rows themselves are elsewhere. */
    documents: documentIndex(candidate),

    firstContactAt: candidate.createdAt,
    enquiredAt: candidate.completedAt,
    lastMessageAt: candidate.lastInboundAt,
    exportedAt: new Date(),
  };
}

/** Slot → status and current storage key, for the candidate record above. */
function documentIndex(candidate: CandidateDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [kind, slot] of Object.entries(candidate.documents ?? {})) {
    if (!slot) continue;
    out[kind] = {
      status: slot.status,
      askedCount: slot.askedCount,
      ...(slot.note ? { note: slot.note } : {}),
    };
  }
  return out;
}

/**
 * Every sitting a person has had, as one document.
 *
 * The bot keeps a document per sitting, because that is what makes its own
 * `messages` collection readable. The ATS wants the opposite: one document per
 * person, the whole conversation top to bottom, which is what somebody about to
 * ring them wants open on a screen.
 */
async function exportedConversation(candidate: CandidateDoc): Promise<Record<string, unknown>> {
  const sittings = (await botSessions()
    .find({ waId: candidate.waId })
    .sort({ startedAt: 1 })
    .toArray()) as SessionDoc[];

  const turns = sittings.flatMap((sitting) =>
    (sitting.turns ?? []).map((turn: MessageDoc) => ({
      at: turn.at,
      direction: turn.direction,
      type: turn.type,
      text: turn.text,
      ...(turn.replyId ? { optionId: turn.replyId } : {}),
      ...(turn.step ? { step: turn.step } : {}),
      ...(turn.mediaId ? { mediaId: turn.mediaId, filename: turn.filename } : {}),
      ...(turn.error ? { error: turn.error } : {}),
    })),
  );

  return {
    source: SOURCE,
    waId: candidate.waId,
    applicationId: candidate.candidateId,
    candidateName: candidate.profile?.fullName ?? candidate.profileName,
    enquiry: candidate.enquiry ?? 'apply',
    whatsappNumberId: candidate.phoneNumberId,
    sittingCount: sittings.length,
    turnCount: turns.length,
    startedAt: sittings[0]?.startedAt ?? candidate.createdAt,
    lastAt: sittings[sittings.length - 1]?.lastAt ?? candidate.lastInboundAt,
    turns,
    exportedAt: new Date(),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Which document goes where
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * The routing table, and the whole of it.
 *
 * A kind absent from here is not exported to a collection of its own — the PAN,
 * the CV, a driving licence, a loose certificate. They are named on the
 * candidate record instead, which is where `documentIndex` puts them.
 *
 * `ocr: false` says the collection stores the file and never an extraction, and
 * it is a property of the destination rather than of the upload: a company
 * certificate has no extractor by policy, and writing an empty `ocr` block for
 * one would read as an extraction that found nothing.
 */
const DOCUMENT_ROUTES: Record<string, { collection: string; ocr: boolean }> = {
  aadhaar: { collection: ATS_COLLECTIONS.aadhaarRecords, ocr: true },
  // The back of the same card, filed beside the front rather than apart from
  // it: one Aadhaar, two sides, and `documentType` says which is which.
  aadhaar_back: { collection: ATS_COLLECTIONS.aadhaarRecords, ocr: true },
  passport: { collection: ATS_COLLECTIONS.passportRecords, ocr: true },

  // The agent's own Aadhaar, both sides, filed together.
  b2b_aadhaar_front: { collection: ATS_COLLECTIONS.b2bAgentAadhaar, ocr: true },
  b2b_aadhaar_back: { collection: ATS_COLLECTIONS.b2bAgentAadhaar, ocr: true },

  // Whatever company paperwork the contact sent — a registration certificate,
  // an MSME certificate, anything else. Stored exactly as it arrived: there is
  // nothing on it the bot needs to read, and `rules.ts` gives it no route.
  company_registration: { collection: ATS_COLLECTIONS.b2bCompanyDocuments, ocr: false },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * The export
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Copies one conversation into the ATS.
 *
 * Idempotent throughout. Called at completion, and again whenever a late
 * extraction changes what there is to say about a document.
 */
export async function exportToAts(payload: { waId: string }): Promise<void> {
  const { waId } = payload;

  if (!atsConfigured()) {
    logger.debug({ waId }, 'ats export skipped: RESUME_ATS_DB is blank');
    return;
  }

  const candidate = await findConversation(waId);
  if (!candidate) {
    logger.warn({ waId }, 'ats export for an unknown conversation');
    return;
  }

  if (externalCandidateDeliveryBlocked(candidate)) {
    logger.info({ waId }, 'ats export skipped: nationality ineligible or still being checked');
    return;
  }

  const b2b = candidate.enquiry === 'b2b';
  const documents = await documentsFor(waId);

  // A business contact is not a candidate and never gets a `candidates` row —
  // a recruiter's candidate list is the one place somebody who wrote in to
  // source workers must not appear. They go to `sourcing_clients` instead.
  let identityResolution: string | undefined;
  if (b2b) {
    await atsCollection(ATS_COLLECTIONS.sourcingClients).updateOne(
      { waId, source: SOURCE },
      { $set: exportedSourcingClient(candidate) },
      { upsert: true },
    );
  } else {
    const resolution = await writeResolvedAtsCandidate({
      collection: atsCollection(ATS_COLLECTIONS.candidates),
      row: exportedCandidate(candidate),
      identity: {
        waId,
        passport: normalizePassportNumber(candidate.profile?.passportNumber),
        aadhaar: normalizeAadhaarNumber(candidate.profile?.aadhaarNumber),
        contacts: contactsFor(candidate),
      },
    });
    identityResolution = resolution.status === 'matched'
      ? `matched:${resolution.matchedBy}`
      : resolution.status;
  }

  await atsCollection(b2b ? ATS_COLLECTIONS.b2bMessages : ATS_COLLECTIONS.messages).updateOne(
    { waId, source: SOURCE },
    { $set: await exportedConversation(candidate) },
    { upsert: true },
  );

  const written = await exportDocuments(candidate, documents);

  logger.info(
    {
      waId,
      applicationId: candidate.candidateId,
      enquiry: candidate.enquiry,
      documents: written,
      identityResolution,
    },
    'conversation exported to the ats',
  );
}

/** Every upload of every routed kind, oldest first, each as its own row. */
async function exportDocuments(
  candidate: CandidateDoc,
  documents: CandidateDocumentsDoc | null,
): Promise<Record<string, number>> {
  if (!documents) return {};

  const counts: Record<string, number> = {};

  for (const [kind, route] of Object.entries(DOCUMENT_ROUTES)) {
    const section = (documents as unknown as Record<string, { uploads?: DocumentUpload[] }>)[kind];
    const uploads = section?.uploads ?? [];
    if (!uploads.length) continue;

    // The version in force is the last one nothing has superseded. Computed
    // once rather than per upload, so exactly one row per kind claims it.
    const current = [...uploads].reverse().find((u) => !u.supersededAt);

    for (const upload of uploads) {
      await atsCollection(route.collection as never).updateOne(
        { uploadId: upload.uploadId.toHexString(), source: SOURCE },
        {
          $set: exportedDocument({
            candidate,
            documentType: kind,
            upload,
            isCurrent: !!current && current.uploadId.equals(upload.uploadId),
            withOcr: route.ocr,
          }),
        },
        { upsert: true },
      );
    }

    counts[kind] = uploads.length;
  }

  return counts;
}

/** Whether a document kind has a collection of its own in the ATS. */
export function atsRouteFor(docType: string): { collection: string; ocr: boolean } | undefined {
  return DOCUMENT_ROUTES[docType];
}

/** The `type` written on every sourcing client this bot creates. For the smoke checks. */
export function b2bClientType(): string {
  return B2B_CLIENT_TYPE;
}

/** The routing table, for the smoke checks. */
export function atsDocumentRoutes(): Record<string, { collection: string; ocr: boolean }> {
  return { ...DOCUMENT_ROUTES };
}

/** Exported so a caller can name the upload it wants re-exported. */
export type { ObjectId };
