/**
 * The conversation engine.
 *
 * One inbound message in, one turn out. The engine decides everything that
 * matters — which question comes next, what has been answered, whether a
 * document has actually arrived, when a person takes over. The model decides
 * one thing only: what a sentence meant.
 *
 * The shape of a turn:
 *
 *   1. Load the candidate and note they are still inside the 24-hour window.
 *   2. Take delivery of anything they sent — a file is stored and filed, a voice
 *      note is stored and transcribed where that is possible.
 *   3. Check the commands that work anywhere: UPDATE, DELETE, talk to staff.
 *   4. Read their reply against the question we actually asked.
 *   5. Record it, with its source and their own wording.
 *   6. Ask the next question, or finish.
 *
 * Step 5 happens before step 6, so a candidate who stops replying has lost
 * nothing (§21), and a message delivered twice cannot ask twice (§1).
 */

import type { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  addUpload,
  appendTurn,
  supersedeAllUploads,
  b2bEnquiries,
  candidates,
  closeOpenSession,
  refileConversation,
  findConversation,
  findConversationById,
  findTurn,
  nextCandidateId,
  recordAudit,
  recordsFor,
  uploadsFor,
  CANDIDATE_ID_DIGITS,
  CANDIDATE_ID_PREFIX,
  type ApplicationStatus,
  type CandidateDoc,
  type CandidateStatus,
  type ConversationStage,
  type FieldMeta,
  type MessageDoc,
} from '../db/models.js';
import {
  downloadMedia,
  send,
  sendReengagementTemplate,
  WhatsAppApiError,
  type Outbound,
} from '../whatsapp/client.js';
import { saveFile } from '../storage/index.js';
import { queue, withCandidateLock } from '../queue/index.js';
import * as copy from './copy.js';
import {
  fieldsToClear,
  inferTradeAnswers,
  inferTradePacks,
  occupationForQuestions,
  nextStep,
  stepById,
  stepsInSection,
  type Answer,
  type FlowStep,
  type Section,
} from './flow.js';
import { attributeInboundDocument, initialSlots, withMissingSlots } from './checklist.js';
import { extractFromCv, normaliseDate, profileFromIdentityDocument } from './cv.js';
import { captureAttachment, ingestionForMessage } from '../ingestion/whatsapp.js';
import { detectGlobalCommand, interpret } from './interpret.js';
import { ModelUnavailableError } from './model.js';
import { answerFromFaq } from './faq.js';
import { explainWrongDocument, respondInContext } from './respond.js';
import {
  acceptedChoices,
  choices as renderChoices,
  message as renderMessage,
  renderRetry,
  renderStep,
} from './render.js';
import { ageFrom, buildProfileWrite, passportExpiryFlag } from './profile.js';
import { detectLanguage, type Choice, type Language, type Localised } from './language.js';
import { DOCUMENTS, requirementFor, TUNABLES } from './rules.js';
import { packById, type TradeQuestion } from './trades.js';
import { questionsForOccupation } from './tradeQuestions.js';
import { transcribe } from './audio.js';

/** Meta's customer service window. Outside it, only approved templates may be sent. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Points in the conversation that are not flow questions: the menus, and the two
 * follow-ups that hang off an UPDATE. Stored in `currentStep` like any other, so
 * a candidate who walks away mid-menu comes back to it rather than to the start.
 */
const MENU = {
  returning: 'menu:returning',
  /** The second menu, behind "Other" on the opening one (§2). */
  other: 'menu:other',
  update: 'menu:update',
  edit: 'menu:edit',
  delete: 'menu:delete',
  reminder: 'menu:reminder',
  resume: 'menu:resume',
  jobs: 'menu:jobs',
  certificate: 'ask:certificate',
  contact: 'ask:contact',
  trackId: 'ask:track_id',
  /** The identity check between the Application ID and the status (§25, §27). */
  trackDob: 'ask:track_dob',
} as const;

/** Suffix marking the free-text follow-up to an "Other" choice. */
const OTHER_SUFFIX = '#other';

/**
 * Documents whose acknowledgement waits for extraction rather than for arrival.
 * §5 wants the CV confirmed immediately but its questions skipped, and §14
 * forbids saying "Passport received" before the upload is known to be usable.
 *
 * The PAN is deliberately absent, and that absence is load-bearing rather than
 * an oversight. It is never sent to an extractor, so no extraction will ever
 * come back to release it — while it was listed here a candidate who sent their
 * PAN was told "checking your document" and then heard nothing, because the
 * only code that resumes a gated upload is the OCR worker. It is acknowledged
 * on arrival instead, which is the truth about a document that is filed and not
 * read.
 */
const GATED = new Set([
  'cv',
  'passport',
  'aadhaar',
  'b2b_aadhaar_front',
  'b2b_aadhaar_back',
]);

/* ─────────────────────────────────────────────────────────────────────────────
 * Candidate lifecycle
 * ───────────────────────────────────────────────────────────────────────────*/

function blankCandidate(params: {
  waId: string;
  phone: string;
  profileName?: string;
}): CandidateDoc {
  const now = new Date();
  return {
    waId: params.waId,
    phone: params.phone,
    profileName: params.profileName,
    stage: 'NEW',
    status: 'new_enquiry',
    profile: {},
    fieldMeta: {},
    history: [],
    documents: initialSlots(),
    createdAt: now,
    updatedAt: now,
  };
}

export async function getOrCreateCandidate(params: {
  waId: string;
  phone: string;
  profileName?: string;
}): Promise<{ candidate: CandidateDoc; created: boolean }> {
  // Both stores. A business contact's record has moved out of `candidates`, and
  // looking only there would create a second one for a number already on file.
  const existing = await findConversation(params.waId);

  if (existing) {
    if (params.profileName && params.profileName !== existing.profileName) {
      await recordsFor(existing.enquiry).updateOne(
        { _id: existing._id },
        { $set: { profileName: params.profileName, updatedAt: new Date() } },
      );
      existing.profileName = params.profileName;
    }
    // Backfill for records written before a field or document existed.
    existing.documents = withMissingSlots(existing.documents);
    existing.profile ??= {};
    existing.fieldMeta ??= {};
    existing.history ??= [];
    return { candidate: existing, created: false };
  }

  const doc = blankCandidate(params);

  try {
    const result = await candidates().insertOne(doc);
    doc._id = result.insertedId;
    return { candidate: doc, created: true };
  } catch (err) {
    // Lost a race with a concurrent first message. §2 is explicit that a number
    // already on file must never produce a second candidate.
    if ((err as { code?: number }).code === 11000) {
      const raced = await findConversation(params.waId);
      if (raced) {
        raced.documents = withMissingSlots(raced.documents);
        return { candidate: raced, created: false };
      }
    }
    throw err;
  }
}

/** Applies a patch to the stored candidate and the in-memory copy together. */
async function setState(candidate: CandidateDoc, patch: Partial<CandidateDoc>): Promise<void> {
  const update = { ...patch, updatedAt: new Date() };
  Object.assign(candidate, update);
  // Routed on what the contact chose, so a B2B enquiry is never written back
  // into the candidate collection it was moved out of.
  await recordsFor(candidate.enquiry).updateOne({ _id: candidate._id }, { $set: update });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Sending
 * ───────────────────────────────────────────────────────────────────────────*/

async function persistOutbound(
  candidate: CandidateDoc,
  body: string,
  results: Array<{ wamid?: string; shadowed: boolean }>,
  step?: string,
): Promise<void> {
  const now = new Date();
  const wamid = results[0]?.wamid;
  await appendTurn({
    waId: candidate.waId,
    direction: 'outbound',
    // Omitted rather than stored as null. Not every send comes back with one:
    // shadow mode has nothing to record, and a failed send never got an id.
    ...(wamid ? { wamid } : {}),
    type: 'text',
    text: body,
    ...(step ? { step } : {}),
    shadowed: results.some((r) => r.shadowed),
    at: now,
  });
  await setState(candidate, { lastOutboundAt: now });
}

/** Sends one message. A closed 24-hour window is recorded, not retried. */
async function reply(candidate: CandidateDoc, outbound: Outbound, step?: string): Promise<void> {
  const body = outbound.body.trim();
  if (!body) return;

  try {
    const results = await send(candidate.phone, { ...outbound, body });
    await persistOutbound(candidate, body, results, step);
  } catch (err) {
    if (err instanceof WhatsAppApiError && err.isOutsideWindow) {
      // The re-engagement template is the only way back in, and sending it is a
      // scheduled decision rather than something to do in the middle of a turn.
      logger.warn({ waId: candidate.waId }, 'reply dropped: outside the 24-hour window');
      await appendTurn({
        waId: candidate.waId,
        direction: 'outbound',
        type: 'text',
        text: body,
        error: 'outside_24h_window',
        at: new Date(),
      });
      return;
    }
    throw err;
  }
}

/** Sends one piece of copy. */
async function tell(
  candidate: CandidateDoc,
  text: Localised,
  vars?: Record<string, string | undefined>,
): Promise<void> {
  await reply(candidate, await renderMessage(text, candidate, vars));
}

/** Sends a question with options and remembers that it is the open question. */
async function ask(
  candidate: CandidateDoc,
  body: Localised,
  options: Choice[],
  step: string,
  vars?: Record<string, string | undefined>,
): Promise<void> {
  await reply(candidate, await renderChoices(body, options, candidate, vars), step);
  await setState(candidate, { currentStep: step });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Stage and status
 * ───────────────────────────────────────────────────────────────────────────*/

const STAGE_BY_SECTION: Record<Section, ConversationStage> = {
  start: 'LANGUAGE_PENDING',
  b2b: 'B2B_PENDING',
  language: 'LANGUAGE_PENDING',
  consent: 'CONSENT_PENDING',
  cv: 'CV_PENDING',
  personal: 'BASIC_DETAILS_PENDING',
  experience: 'BASIC_DETAILS_PENDING',
  job_preference: 'JOB_PREFERENCE_PENDING',
  country: 'JOB_PREFERENCE_PENDING',
  availability: 'JOB_PREFERENCE_PENDING',
  documents: 'DOCUMENTS_PENDING',
  confirm: 'CONFIRMATION_PENDING',
};

/** Statuses the bot may set on its own. Everything else belongs to staff (§26). */
const BOT_OWNED: ReadonlySet<CandidateStatus> = new Set<CandidateStatus>([
  'new_enquiry',
  'consent_pending',
  'registration_started',
  'profile_incomplete',
  'documents_pending',
  'documents_received',
]);

/**
 * Keeps the CRM-facing status in step with the conversation, without ever
 * dragging a candidate backwards. Someone staff have moved to `shortlisted` is
 * not reset to `profile_incomplete` by a stray reply.
 */
function statusForStage(stage: ConversationStage, current: CandidateStatus): CandidateStatus {
  if (!BOT_OWNED.has(current)) return current;

  switch (stage) {
    case 'NEW':
    case 'LANGUAGE_PENDING':
      return 'new_enquiry';
    case 'CONSENT_PENDING':
      return 'consent_pending';
    case 'CV_PENDING':
      return 'registration_started';
    // Not a candidate at all (§2). `profile_incomplete` would put a business
    // contact in the queue of people whose registration needs chasing.
    case 'B2B_PENDING':
      return 'new_enquiry';
    case 'DOCUMENTS_PENDING':
      return 'documents_pending';
    case 'REGISTRATION_COMPLETED':
      return 'profile_registered';
    default:
      return 'profile_incomplete';
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Asking the next question
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Works out the next question and asks it, or finishes.
 *
 * Recomputed from current state every time rather than read from a stored
 * cursor. That is what makes "never ask twice" (§1) and "resume where you
 * stopped" (§21) one mechanism rather than two that can disagree.
 */
/**
 * Writes the trade questions for a job no hand-written pack covers (§8).
 *
 * Runs once per candidate per occupation, and only where the packs came up
 * empty — a welder, a fabricator, a driver, a machinist and an NDT technician
 * all keep the questions a person wrote for them. Everyone else used to be
 * asked nothing at all about their trade: a recruiter opening an electrician's
 * profile learned that he was an electrician and nothing further.
 *
 * The result is stored either way, empty included. An empty list is an answer —
 * "there is nothing useful to ask this candidate about their trade" — and
 * storing it is what stops a model call on every turn for the rest of the
 * registration.
 */
async function ensureTradeQuestions(candidate: CandidateDoc): Promise<void> {
  const profile = candidate.profile ?? {};

  if ((profile.tradePacks ?? []).length) return;
  // A fresher has no trade to be asked about, which is what the option means.
  if (!profile.primaryTrade || profile.primaryTrade === 'fresher') return;

  // Their own words wherever they exist — see `occupationForQuestions`, which is
  // where the difference between "plumber" and "Electrical / Mechanical" is
  // recovered.
  const occupation = occupationForQuestions(candidate);
  if (!occupation) return;
  if (profile.tradeQuestionsFor === occupation) return;

  let questions;
  try {
    questions = await questionsForOccupation({
      occupation,
      language: candidate.language,
      languageOther: candidate.languageOther,
    });
  } catch (err) {
    // The model was unreachable. Writing what comes next would store an empty
    // list *and* the occupation it was computed for, and the pair of them is
    // what stops this ever running again — so a two-second outage would record
    // "this candidate has no trade questions" for good. Leave it unset; the
    // next turn asks again.
    if (err instanceof ModelUnavailableError) {
      logger.warn(
        { waId: candidate.waId, occupation },
        'trade questions deferred: the model was unavailable, nothing recorded',
      );
      return;
    }
    throw err;
  }

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    {
      $set: {
        'profile.tradeQuestions': questions,
        'profile.tradeQuestionsFor': occupation,
        updatedAt: new Date(),
      },
    },
  );
  candidate.profile.tradeQuestions = questions;
  candidate.profile.tradeQuestionsFor = occupation;
}

/**
 * Asks the first question that applies and is not already answered.
 *
 * `lead` prefixes it in the same message, for callers that have something to
 * explain first — a tap on a question that has moved on, say. One bubble, not
 * two: on a phone the question can otherwise arrive above the sentence
 * explaining it.
 */
async function askNextQuestion(
  candidate: CandidateDoc,
  lead?: Localised | string,
): Promise<void> {
  // If what the candidate has already told us decides their trade questions,
  // record that now so the disambiguation question is skipped entirely (§8).
  const packs = inferTradePacks(candidate);
  if (packs) {
    await recordsFor(candidate.enquiry).updateOne(
      { _id: candidate._id },
      { $set: { 'profile.tradePacks': packs, updatedAt: new Date() } },
    );
    candidate.profile.tradePacks = packs;
  }

  await ensureTradeQuestions(candidate);

  // And the answers those questions already have, from the same evidence (§1).
  // Recorded with their source, so a recruiter can see the candidate never said
  // this out loud — it was read off their CV, and CV data is never verified
  // information (§27).
  const inferred = inferTradeAnswers(candidate);
  if (inferred) {
    const merged = { ...(candidate.profile.tradeAnswers ?? {}), ...inferred };
    const now = new Date();
    const meta: Record<string, FieldMeta> = { ...(candidate.fieldMeta ?? {}) };
    for (const key of Object.keys(inferred)) {
      meta[`tradeAnswers.${key}`] = { source: 'cv', at: now, confidence: null };
    }

    await recordsFor(candidate.enquiry).updateOne(
      { _id: candidate._id },
      { $set: { 'profile.tradeAnswers': merged, fieldMeta: meta, updatedAt: now } },
    );
    candidate.profile.tradeAnswers = merged;
    candidate.fieldMeta = meta;

    logger.info(
      { waId: candidate.waId, questions: Object.keys(inferred) },
      'trade answers taken from the CV rather than asked',
    );
  }

  const step = nextStep(candidate);

  if (!step) {
    if (candidate.enquiry === 'b2b') {
      await completeB2bEnquiry(candidate);
      return;
    }
    if (candidate.stage === 'REGISTRATION_COMPLETED') {
      // Already registered and there is nothing outstanding — this is the tail
      // of an update, not a second registration.
      await tell(candidate, copy.UPDATE_SAVED);
      await setState(candidate, { currentStep: undefined, editQueue: [] });
      return;
    }
    await completeRegistration(candidate);
    return;
  }

  await reply(
    candidate,
    lead ? await renderRetry(step, candidate, lead) : await renderStep(step, candidate),
    step.id,
  );

  const patch: Partial<CandidateDoc> = { currentStep: step.id };

  // Stage tracks how far registration got, and a registered candidate editing
  // one section has not become unregistered. §18 and §22 both say an edit opens
  // the chosen section and does not restart registration — letting the stage
  // fall back to JOB_PREFERENCE_PENDING would restart it as far as every CRM
  // screen and every sweep is concerned.
  if (!candidate.completedAt) {
    patch.stage = STAGE_BY_SECTION[step.section];
    patch.status = statusForStage(STAGE_BY_SECTION[step.section], candidate.status);
  }

  // A half-finished multi-select left behind would have the next question's taps
  // land on the previous one.
  if (candidate.pendingMulti && candidate.pendingMulti.step !== step.id) {
    patch.pendingMulti = undefined;
  }

  if (step.document) {
    const slots = withMissingSlots(candidate.documents);
    const slot = slots[step.document]!;
    slots[step.document] = {
      ...slot,
      askedCount: slot.askedCount + 1,
      lastAskedAt: new Date(),
      updatedAt: new Date(),
    };
    patch.documents = slots;
  }

  await setState(candidate, patch);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Endings
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * §24. Everything automated stops until staff hand the conversation back.
 *
 * `announce: false` is for callers that have already said something better
 * suited to the situation — the B2B greeting, for one. The handoff itself is
 * identical either way; only the sentence differs.
 */
async function handOffToStaff(
  candidate: CandidateDoc,
  reason: string,
  options: { announce?: boolean } = {},
): Promise<void> {
  if (options.announce !== false) await tell(candidate, copy.STAFF_HANDOFF);
  await setState(candidate, {
    stage: 'HUMAN_HANDOFF',
    humanHandoff: { reason, at: new Date() },
    currentStep: undefined,
  });
  await recordAudit({
    waId: candidate.waId,
    candidateId: candidate.candidateId,
    event: 'handoff_requested',
    detail: reason,
  });
  logger.warn({ waId: candidate.waId, reason }, 'conversation handed to staff');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The B2B branch (§2)
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Opens the branch: `enquiry` is what makes `nextStep` walk the B2B questions
 * instead of registration, so it is written before anything is asked.
 *
 * The greeting rides on the first question rather than arriving as its own
 * bubble — the same rule the rest of the bot follows for a lead line.
 */
async function startB2bEnquiry(candidate: CandidateDoc): Promise<void> {
  // Moves the record out of `candidates` and into `b2b_enquiries` first, so
  // every write from here on — the name, the document slots, the stage — lands
  // in the B2B collection and nothing of theirs is left behind in the other.
  await refileConversation(candidate, 'b2b');
  await setState(candidate, { currentStep: undefined, unclearCount: 0 });
  await recordAudit({ waId: candidate.waId, event: 'b2b_enquiry_started' });
  await askNextQuestion(candidate, copy.B2B_WELCOME);
}

/**
 * Closes it: everything asked for is in, and a person takes over.
 *
 * Not `completeRegistration` — a business contact has no application, so there
 * is no Application ID to issue and nothing for §25 tracking to read. What they
 * get is the promise that someone will call, and §24 silence behind it.
 */
async function completeB2bEnquiry(candidate: CandidateDoc): Promise<void> {
  await tell(candidate, copy.B2B_COMPLETE);
  await handOffToStaff(candidate, 'B2B enquiry: details and documents collected', {
    announce: false,
  });
  await closeOpenSession(candidate.waId);
  logger.info({ waId: candidate.waId }, 'b2b enquiry collected and handed to staff');
}

/** Staff returning the conversation to the bot (§24). */
export async function returnConversationToBot(waId: string): Promise<boolean> {
  const candidate = await findConversation(waId);
  if (!candidate || candidate.stage !== 'HUMAN_HANDOFF') return false;

  candidate.documents = withMissingSlots(candidate.documents);
  candidate.profile ??= {};
  candidate.fieldMeta ??= {};

  await setState(candidate, {
    stage: candidate.completedAt
      ? 'REGISTRATION_COMPLETED'
      : // A business contact handed back mid-branch resumes the B2B questions,
        // not registration — they have none to be part-way through.
        candidate.enquiry === 'b2b'
        ? 'B2B_PENDING'
        : 'BASIC_DETAILS_PENDING',
    humanHandoff: { ...candidate.humanHandoff!, returnedAt: new Date() },
    unclearCount: 0,
  });

  await recordAudit({ waId, candidateId: candidate.candidateId, event: 'handoff_returned' });
  await askNextQuestion(candidate);
  return true;
}

async function completeRegistration(candidate: CandidateDoc): Promise<void> {
  const candidateId = candidate.candidateId ?? (await nextCandidateId());
  const now = new Date();

  await setState(candidate, {
    candidateId,
    stage: 'REGISTRATION_COMPLETED',
    status: BOT_OWNED.has(candidate.status) ? 'profile_registered' : candidate.status,
    completedAt: candidate.completedAt ?? now,
    // Seeded once and never touched again by the bot. Everything after this is
    // an admin decision in the CRM — the bot has no authority to move an
    // application to completed or rejected (§27).
    application: candidate.application ?? { status: 'pending', updatedAt: now },
    currentStep: undefined,
    editQueue: [],
    unclearCount: 0,
    // The conversation is finished. A later message opens the returning menu
    // (§20) rather than resuming a registration that has nothing left to ask.
    sessionEndedAt: now,
  });

  await tell(candidate, copy.COMPLETED, { candidateId });
  // The last thing said in this sitting has been said. Close the transcript so
  // `endedAt` records when it actually ended rather than when it lapsed.
  await closeOpenSession(candidate.waId);
  await recordAudit({ waId: candidate.waId, candidateId, event: 'registration_completed' });
  logger.info({ waId: candidate.waId, candidateId }, 'registration completed');

  // Hand the finished profile to the CRM, which owns everything that happens to
  // a candidate from here — assignment, evaluation, the SLA clock, the hiring
  // decision. None of that is reimplemented on this side.
  //
  // Queued rather than awaited, and queued *after* the candidate has been told
  // they are registered. They are: the record is written and complete. Whether
  // the CRM happens to be reachable this second is our problem to retry, not a
  // reason to leave someone staring at a half-finished conversation — and a
  // failed delivery keeps the candidate on file either way.
  //
  // B2B enquiries are not candidates and have no place in a candidate CRM (§2).
  if (candidate.enquiry !== 'b2b') {
    await setState(candidate, { crmSync: { status: 'pending', attempts: 0 } });
    await queue.enqueue('crm_sync', { waId: candidate.waId });
  }
}

/**
 * Asks again for a CV the CRM's policy turned out to require.
 *
 * Reached only from the sync worker, when a submission comes back refused
 * because the destination and job need a CV this candidate has not sent. That
 * is not a failure worth retrying — the request was well formed and the
 * candidate is incomplete — so the honest response is to go back and ask.
 *
 * The registration is *not* reopened. `stage` stays REGISTRATION_COMPLETED and
 * the candidate keeps their Application ID: they answered every question and
 * were told they were done, and taking that back because two services disagreed
 * about a document would be the bot's mistake charged to them. Only the CV slot
 * is reopened, and the same submission goes out again — under the same
 * idempotency key — once the file lands.
 */
export async function reopenCvForCrm(candidate: CandidateDoc): Promise<void> {
  const slots = withMissingSlots(candidate.documents);
  const cv = slots.cv!;

  slots.cv = { ...cv, status: 'pending', note: undefined, updatedAt: new Date() };

  await setState(candidate, {
    documents: slots,
    currentStep: 'cv',
    // The flow no longer gates the CV on this — it is asked of everyone — so
    // this no longer changes which question comes next. It is still written,
    // because it is the CRM’s own ruling for this candidate and `toCrmPayload`
    // sends it back as `cv_required_claim`: dropping it would have the next
    // submission repeat the claim the CRM has just corrected.
    profile: { ...candidate.profile, cvRequired: true },
  });

  await tell(candidate, copy.CRM_NEEDS_CV);
  logger.info({ waId: candidate.waId }, 'cv re-requested at the crm policy’s insistence');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Application tracking
 *
 * Reads back a decision staff recorded in the CRM. The bot contributes nothing
 * to it — it seeds `pending` at completion and from then on only reports.
 * ───────────────────────────────────────────────────────────────────────────*/

const TRACK_COPY: Record<ApplicationStatus, Localised> = {
  pending: copy.TRACK_PENDING,
  completed: copy.TRACK_COMPLETED,
  rejected: copy.TRACK_REJECTED,
};

/**
 * Rebuilds an application id from whatever the candidate typed.
 *
 * They read these out over the phone and type them back from memory, so
 * "ADR-00042", "adr 42" and "42" all have to reach the same record. Only the
 * digits are load-bearing; the prefix is reattached here.
 */
export function normaliseApplicationId(typed: string): string | undefined {
  const digits = /(\d{1,10})/.exec(typed.replace(/\s+/g, ''));
  if (!digits) return undefined;
  return `${CANDIDATE_ID_PREFIX}-${digits[1]!.padStart(CANDIDATE_ID_DIGITS, '0')}`;
}

/**
 * Whether a message is someone quoting their application id at us.
 *
 * The prefix is required. A bare number is how candidates pick an option from a
 * list — "2" means the second row — and treating that as an application id
 * would hijack every numbered answer in the flow.
 */
const APPLICATION_ID_PATTERN = new RegExp(`\\b${CANDIDATE_ID_PREFIX}[\\s-]?\\d{1,10}\\b`, 'i');

export function looksLikeApplicationId(text: string | undefined): boolean {
  return !!text && APPLICATION_ID_PATTERN.test(text);
}

async function reportApplicationStatus(
  candidate: CandidateDoc,
  record: CandidateDoc,
): Promise<void> {
  const status: ApplicationStatus = record.application?.status ?? 'pending';
  await tell(candidate, TRACK_COPY[status], { candidateId: record.candidateId });
  await setState(candidate, { currentStep: undefined });
  logger.info({ waId: candidate.waId, candidateId: record.candidateId, status }, 'status reported');
}

/**
 * Starts the tracking flow.
 *
 * The Application ID is always asked for, including from a candidate registered
 * on this very number whose record we could simply have read. That is the
 * point: a status is something §27 says we owe to the candidate and to nobody
 * else, and "this message came from the right handset" is not the same claim as
 * "this is the right person". Phones are shared, lent and left on tables. So
 * the id names the application and the date of birth on it confirms who is
 * asking, and the two questions are asked of everyone.
 */
async function startTracking(candidate: CandidateDoc): Promise<void> {
  // Mid-registration on this very number: they have no id yet, and asking them
  // to type one they were never given is a dead end. Consent is the marker —
  // nothing is recorded before it, so someone who has given it is partway
  // through, whereas a first-time contact may well be tracking a registration
  // made on another number and does need to be asked.
  if (!candidate.candidateId && candidate.consent?.given) {
    await ask(candidate, copy.TRACK_NOT_REGISTERED, copy.RESUME_CHOICES, MENU.resume);
    return;
  }

  await tell(candidate, copy.TRACK_ASK_ID);
  // Any half-finished check from a previous attempt goes: a fresh lookup starts
  // with a fresh id, and inheriting someone else's attempt count would be both
  // confusing and wrong.
  await setState(candidate, { currentStep: MENU.trackId, tracking: undefined });
}

/**
 * Looks up an id the candidate typed, and opens the identity check on it.
 *
 * Scoped to the number that sent it. Ids are short and sequential, so answering
 * for any id at all would hand one candidate's status — and the fact that their
 * record exists — to anyone who guessed a number (§27). A miss is reported the
 * same way whether the id is unknown or belongs to somebody else.
 *
 * Nothing about the application is said here. Finding the record only earns the
 * candidate the date-of-birth question; the status waits behind it.
 */
async function lookUpApplication(candidate: CandidateDoc, typed: string): Promise<void> {
  const id = normaliseApplicationId(typed);
  const record = id
    ? // Only ever a candidate: a business enquiry has no Application ID to quote.
      await candidates().findOne({ candidateId: id, waId: candidate.waId })
    : null;

  if (record) {
    // A record with no date of birth cannot be checked, and a check that cannot
    // be performed is not a check that passed. Staff take it from here.
    if (!record.profile?.dateOfBirth) {
      logger.warn(
        { waId: candidate.waId, candidateId: record.candidateId },
        'tracking blocked: no date of birth on the application to verify against',
      );
      await ask(candidate, copy.TRACK_CANNOT_VERIFY, [copy.CHOICE_STAFF], MENU.trackId);
      await setState(candidate, { tracking: undefined });
      return;
    }

    await tell(candidate, copy.TRACK_ASK_DOB);
    await setState(candidate, {
      currentStep: MENU.trackDob,
      tracking: { candidateId: record.candidateId!, attempts: 0, startedAt: new Date() },
    });
    return;
  }

  // Their own registration simply is not finished. Saying "not found" would be
  // technically true and useless — offer to carry on instead.
  if (!candidate.candidateId) {
    await ask(candidate, copy.TRACK_NOT_REGISTERED, copy.RESUME_CHOICES, MENU.resume);
    return;
  }

  await ask(candidate, copy.TRACK_NOT_FOUND, [copy.CHOICE_STAFF], MENU.trackId);
}

/**
 * Checks a typed date of birth against the application it was claimed for.
 *
 * Three chances, counted on the record rather than in memory — the attempts are
 * the whole point of the check, and a counter that resets when the candidate
 * messages again is not a counter.
 *
 * A date we could not parse at all does not cost an attempt. "1994", or "May",
 * is someone who has not understood the format rather than someone guessing,
 * and burning one of three chances on a misunderstanding would punish the
 * candidate this check exists to protect.
 */
async function verifyTrackingDob(candidate: CandidateDoc, typed: string): Promise<void> {
  const tracking = candidate.tracking;
  if (!tracking) {
    // The check was cleared underneath us — a restart, a deletion, a staff
    // takeover. Start again rather than compare against nothing.
    await startTracking(candidate);
    return;
  }

  const supplied = normaliseDate(typed);
  if (!supplied) {
    await tell(candidate, copy.TRACK_DOB_UNREADABLE);
    return;
  }

  const record = await candidates().findOne({
    candidateId: tracking.candidateId,
    waId: candidate.waId,
  });

  // Re-read rather than trusted from the earlier lookup: the record is fetched
  // again at the moment of the comparison, so a profile deleted (§23) or
  // refiled between the two questions cannot be reported from a stale copy.
  const onFile = record?.profile?.dateOfBirth
    ? normaliseDate(record.profile.dateOfBirth)
    : undefined;

  if (record && onFile && onFile === supplied) {
    await setState(candidate, { tracking: undefined });
    await reportApplicationStatus(candidate, record);
    logger.info(
      { waId: candidate.waId, candidateId: tracking.candidateId },
      'application status released after a successful identity check',
    );
    return;
  }

  const attempts = tracking.attempts + 1;
  const remaining = TUNABLES.maxTrackingDobAttempts - attempts;

  if (remaining <= 0) {
    // Out of chances. No hint about what the right answer was, and no status.
    logger.warn(
      { waId: candidate.waId, candidateId: tracking.candidateId, attempts },
      'tracking identity check exhausted; sending the candidate to staff',
    );
    await setState(candidate, { tracking: undefined, currentStep: undefined });
    await ask(candidate, copy.TRACK_DOB_EXHAUSTED, [copy.CHOICE_STAFF], MENU.trackId);
    return;
  }

  await setState(candidate, {
    tracking: { ...tracking, attempts },
    currentStep: MENU.trackDob,
  });
  await tell(candidate, copy.TRACK_DOB_WRONG, { remaining: String(remaining) });
}

/**
 * §23. The profile is tombstoned rather than dropped: consent is withdrawn, job
 * messages stop, personal data goes, and a minimal audit record survives — which
 * is what "keep only the minimum legally required audit record" means here.
 */
async function deleteProfile(candidate: CandidateDoc): Promise<void> {
  const now = new Date();

  await recordAudit({
    waId: candidate.waId,
    candidateId: candidate.candidateId,
    event: 'deletion_requested',
    detail: 'requested by the candidate over WhatsApp',
  });

  // Every upload in every section is marked superseded. Nothing is removed —
  // the files and their history stay for the audit record §23 requires.
  await supersedeAllUploads(candidate.waId, now);

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    {
      $set: {
        stage: 'DELETED' as ConversationStage,
        status: 'consent_withdrawn' as CandidateStatus,
        consent: {
          given: false,
          at: candidate.consent?.at ?? now,
          source: candidate.consent?.source ?? 'whatsapp_chat',
          withdrawnAt: now,
        },
        deletion: { requestedAt: now, completedAt: now, by: 'candidate' as const },
        profile: {},
        fieldMeta: {},
        history: [],
        documents: initialSlots(),
        editQueue: [],
        updatedAt: now,
      },
      $unset: { pendingMulti: '', currentStep: '' },
    },
  );

  Object.assign(candidate, {
    stage: 'DELETED' as ConversationStage,
    profile: {},
    fieldMeta: {},
    currentStep: undefined,
  });

  await tell(candidate, copy.DELETED);
  await recordAudit({
    waId: candidate.waId,
    candidateId: candidate.candidateId,
    event: 'deletion_completed',
  });
  logger.warn({ waId: candidate.waId }, 'candidate profile deleted on request');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Inbound media
 * ───────────────────────────────────────────────────────────────────────────*/

interface Ingested {
  docType?: string;
  /** Set when the file could not be fetched from Meta. */
  failed?: boolean;
  /**
   * Set when the reason was its size, which changes what the candidate is told.
   * "Send it once more" is right for a download that dropped and wrong for a
   * file over `MEDIA_MAX_BYTES` — resending produces the identical refusal.
   */
  tooLarge?: boolean;
}

/**
 * Stores an inbound file, files it against a slot, and queues extraction.
 *
 * A new upload for a slot that already holds one supersedes it rather than
 * replacing it — §22 forbids destroying an old document without a version
 * history.
 */
async function ingestDocument(candidate: CandidateDoc, msg: MessageDoc): Promise<Ingested> {
  if (!msg.mediaId) return {};

  const step = candidate.currentStep ? stepById(candidate.currentStep) : undefined;
  const docType = attributeInboundDocument(candidate, {
    caption: msg.text,
    filename: msg.filename,
    expecting: candidate.currentStep === MENU.certificate ? 'certificate' : step?.document,
  });

  // The bytes are already on disk: they were fetched and stored at the webhook,
  // before it was acknowledged, and the ledger row says where they went
  // (`ingestion/whatsapp.ts`). Downloading again here would be a second copy of
  // a file we hold, fetched over a media URL that may no longer resolve.
  //
  // The capture is retried inline when the row has no source object — a message
  // that arrived before this path existed, or one whose first attempt failed.
  // Either way what comes back is a row, and a row without a `storageKey` is an
  // attachment we could not get, which the candidate is told about and the
  // reconciler keeps working on.
  //
  // `wamid` is optional on the type because outbound rows have none; every
  // inbound row carries one, and the media id stands in rather than throwing if
  // one ever does not — the ledger key only has to be unique, and it still is.
  const wamid = msg.wamid ?? msg.mediaId;

  let row = await ingestionForMessage(wamid, msg.mediaId);

  if (!row?.storageKey) {
    row = await captureAttachment({
      waId: candidate.waId,
      wamid,
      mediaId: msg.mediaId,
      mimeType: msg.mimeType,
      filename: msg.filename,
      receivedAt: msg.at,
    });
  }

  if (!row.storageKey || !row.sha256) {
    logger.error(
      { mediaId: msg.mediaId, waId: candidate.waId, error: row.lastError, kind: row.failureKind },
      'media unavailable; the ingestion row is retained for the reconciler',
    );
    return { failed: true, tooLarge: row.failureKind === 'too_large' };
  }

  const stored = {
    storageKey: row.storageKey,
    sha256: row.sha256,
    byteSize: row.byteSize ?? 0,
  };
  const media = { mimeType: row.mimeType ?? msg.mimeType ?? 'application/octet-stream' };

  const now = new Date();
  const requirement = requirementFor(docType);
  const willOcr = !!requirement && requirement.ocr !== 'none';

  // Files it into its section and marks whatever it replaces as a previous
  // version — never removing it, because §22 forbids destroying an upload a
  // candidate has not withdrawn.
  const uploadId = await addUpload({
    waId: candidate.waId,
    candidateId: candidate._id!,
    docType,
    upload: {
      mediaId: msg.mediaId,
      storageKey: stored.storageKey,
      mimeType: media.mimeType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: msg.filename,
      caption: msg.text,
      ocr: { status: willOcr ? 'queued' : 'skipped' },
    },
  });

  const slots = withMissingSlots(candidate.documents);
  const previous = slots[docType]!;

  slots[docType] = {
    ...previous,
    status: willOcr ? 'ocr_queued' : 'received',
    documentId: uploadId,
    note: undefined,
    previousDocumentIds: previous.documentId
      ? [...(previous.previousDocumentIds ?? []), previous.documentId]
      : previous.previousDocumentIds,
    updatedAt: now,
  };

  await setState(candidate, { documents: slots });

  if (willOcr) {
    // The job carries where the upload lives, not just which one it is: an
    // upload inside a section cannot be found by id alone.
    await queue.enqueue('ocr', {
      waId: candidate.waId,
      docType,
      uploadId: uploadId.toHexString(),
    });
  }

  logger.info({ waId: candidate.waId, docType, storageKey: stored.storageKey }, 'document ingested');
  return { docType };
}

/**
 * Which apology a failed upload earns.
 *
 * Two failures, two different things to say. A download that dropped is worth
 * asking about again; a file over the limit is not, and telling someone to
 * resend it sends them round the same refusal with no more information than
 * they had the first time.
 */
function fileFailureCopy(ingested: Ingested): {
  text: Localised;
  vars?: Record<string, string | undefined>;
} {
  if (!ingested.tooLarge) return { text: copy.FILE_FAILED };
  return {
    text: copy.FILE_TOO_LARGE,
    vars: { limit: String(Math.floor(config.MEDIA_MAX_BYTES / (1024 * 1024))) },
  };
}

/**
 * Stores a voice note and transcribes it where a provider is configured (§3).
 *
 * The audio is kept either way so staff can listen to it. A transcript is
 * returned so the rest of the turn treats it exactly as if it had been typed.
 */
async function ingestVoiceNote(
  candidate: CandidateDoc,
  msg: MessageDoc,
): Promise<string | undefined> {
  if (!msg.mediaId) return undefined;

  let media;
  try {
    media = await downloadMedia(msg.mediaId);
  } catch (err) {
    logger.error({ err, waId: candidate.waId }, 'voice note download failed');
    return undefined;
  }

  await saveFile({
    waId: candidate.waId,
    docType: 'voice',
    buffer: media.buffer,
    mimeType: media.mimeType,
  });

  const text = await transcribe({
    buffer: media.buffer,
    mimeType: media.mimeType,
    language: candidate.language,
  });

  if (text) {
    logger.info({ waId: candidate.waId, chars: text.length }, 'voice note transcribed');
    // §3 — what a candidate says by voice becomes structured text on the record,
    // not an audio file nobody has listened to.
    await appendTurn({
      waId: candidate.waId,
      direction: 'inbound',
      type: 'text',
      text: `[voice note] ${text}`,
      at: new Date(),
    });
  }

  return text;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Recording answers
 * ───────────────────────────────────────────────────────────────────────────*/

async function recordAnswer(
  candidate: CandidateDoc,
  step: FlowStep,
  answer: Answer,
): Promise<void> {
  const patch = step.apply?.(answer, candidate) ?? {};
  if (!Object.keys(patch).length) return;

  const editing = (candidate.editQueue ?? []).includes(step.id);
  const write = buildProfileWrite(candidate, patch, {
    source: 'chat',
    raw: answer.raw,
    // An edit is a deliberate correction, so it overrides what is already there.
    overwrite: editing,
  });

  if (!Object.keys(write.set).length) return;

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    {
      $set: { ...write.set, updatedAt: new Date() },
      $push: { history: { $each: write.changes } },
    },
  );
}

async function markSlot(
  candidate: CandidateDoc,
  docType: string,
  status: 'promised' | 'unavailable' | 'incomplete',
  note?: string,
): Promise<void> {
  const slots = withMissingSlots(candidate.documents);
  slots[docType] = { ...slots[docType]!, status, note, updatedAt: new Date() };
  await setState(candidate, { documents: slots });
}

/** Removes a step from the edit queue once it has been answered. */
async function drainEditQueue(candidate: CandidateDoc, stepId: string): Promise<void> {
  if (!(candidate.editQueue ?? []).includes(stepId)) return;
  await setState(candidate, { editQueue: candidate.editQueue!.filter((id) => id !== stepId) });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Steps with effects beyond a profile field
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Handles steps whose answer changes something other than a profile field —
 * consent, language, the confirmation, and the answers that end a conversation.
 * Returns true when the turn is completely handled.
 */
async function handleSpecialStep(
  candidate: CandidateDoc,
  step: FlowStep,
  answer: Answer,
): Promise<boolean> {
  const chosen = answer.ids?.[0];

  switch (step.id) {
    // The opening menu (§2). Two of the three answers end the turn here and
    // never reach the registration flow at all.
    case 'entry':
      switch (chosen) {
        case 'other':
          // Neither of the two things behind this is a job application, so
          // nothing is recorded yet — the second menu decides which it is.
          await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
          return true;

        case 'staff':
          await handOffToStaff(candidate, 'asked for a person at the opening menu');
          return true;

        case 'track':
          await setState(candidate, { enquiry: 'track' });
          await startTracking(candidate);
          return true;

        case 'no':
          await tell(candidate, copy.NOT_LOOKING);
          await setState(candidate, { status: 'not_interested', currentStep: undefined });
          return true;

        default:
          await setState(candidate, { enquiry: 'apply' });
          return false;
      }

    case 'language':
      // `languageChosen` is what marks §3 answered — the engine's own guess
      // never sets it, so the question is asked exactly once, by choice.
      await setState(candidate, { language: chosen as Language, languageChosen: true });
      return false;

    case 'language_other':
      await setState(candidate, { languageOther: answer.value });
      return false;

    case 'consent':
      if (chosen === 'no') {
        // §4 — stop collecting personal information the moment consent is refused.
        await tell(candidate, copy.CONSENT_DECLINED);
        await setState(candidate, {
          stage: 'CONSENT_REFUSED',
          status: 'not_interested',
          currentStep: undefined,
        });
        await recordAudit({ waId: candidate.waId, event: 'consent_refused' });
        return true;
      }
      await setState(candidate, {
        consent: { given: true, at: new Date(), source: 'whatsapp_chat' },
        status: 'registration_started',
      });
      await recordAudit({
        waId: candidate.waId,
        event: 'consent_given',
        detail: 'confirmed in WhatsApp chat',
      });
      return false;

    case 'cv':
      if (chosen === 'upload_cv') {
        // A button cannot open a file picker; all it can do is say "go ahead".
        await tell(candidate, copy.GO_AHEAD);
        return true;
      }
      if (chosen === 'no_cv' || chosen === 'dont_have') {
        await markSlot(candidate, 'cv', 'unavailable');
        await tell(candidate, copy.NO_CV_OK);
        return false;
      }
      if (chosen === 'later') {
        await markSlot(candidate, 'cv', 'promised');
        await tell(candidate, copy.WILL_WAIT);
        return false;
      }
      return false;

    case 'dob': {
      // §27 — an automated overseas-work registration is not the right thing to
      // run with a minor. It stops, and a person takes it from here.
      const age = ageFrom(answer.value);
      if (age !== undefined && age < TUNABLES.minimumAge) {
        await tell(candidate, copy.AGE_HANDOFF);
        await handOffToStaff(candidate, `stated date of birth gives an age of ${age}`);
        return true;
      }
      return false;
    }

    case 'confirm':
      if (chosen === 'correct') {
        await completeRegistration(candidate);
        return true;
      }
      if (chosen === 'edit') {
        await ask(candidate, copy.EDIT_PROMPT, copy.EDIT_CHOICES, MENU.edit);
        return true;
      }
      return false;

    default:
      // A document step answered in words rather than with a file.
      if (step.document && (chosen === 'later' || chosen === 'dont_have')) {
        const promised = chosen === 'later';
        await markSlot(candidate, step.document, promised ? 'promised' : 'unavailable');
        await tell(candidate, promised ? copy.WILL_WAIT : copy.NOTED);
        return false;
      }
      return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Multi-select and "Other"
 * ───────────────────────────────────────────────────────────────────────────*/

type MultiOutcome =
  /** Still collecting — re-render the question with what is chosen so far. */
  | 'waiting'
  /** Finished and the answer is recorded; carry on to the next question. */
  | 'recorded'
  /** Finished, but something else has taken over the turn. */
  | 'handled';

/**
 * Adds taps to a multi-select and reports where it got to.
 *
 * A tap adds to the selection and waits for more, because that is what tapping
 * one row of a list means. Typed text finishes the answer, because someone who
 * writes "factory and packing" has said everything they mean to say and should
 * not have to confirm it.
 */
async function accumulateMultiSelect(
  candidate: CandidateDoc,
  step: FlowStep,
  ids: string[],
  wasTapped: boolean,
): Promise<MultiOutcome> {
  const pending =
    candidate.pendingMulti?.step === step.id ? [...candidate.pendingMulti.selected] : [];

  const tappedDone = ids.includes('__done');
  for (const id of ids) {
    if (id !== '__done' && !pending.includes(id)) pending.push(id);
  }

  if (!tappedDone && wasTapped) {
    await setState(candidate, { pendingMulti: { step: step.id, selected: pending } });
    return 'waiting';
  }

  await setState(candidate, { pendingMulti: undefined });

  // Tapped Done without choosing anything — ask again rather than record nothing.
  if (!pending.length) return 'waiting';

  const answer: Answer = { ids: pending, raw: pending.join(', '), tapped: wasTapped };

  if (await handleSpecialStep(candidate, step, answer)) return 'handled';
  await recordAnswer(candidate, step, answer);
  if (pending.includes('other') && (await askForOtherText(candidate, step))) return 'handled';

  return 'recorded';
}

function tradeQuestionFor(step: FlowStep): TradeQuestion | undefined {
  if (!step.id.startsWith('trade:')) return undefined;
  const [, packId, questionId] = step.id.split(':');
  return packId ? packById(packId)?.questions.find((q) => q.id === questionId) : undefined;
}

/** Asks for the free text behind an "Other" choice, where the step defines one. */
async function askForOtherText(candidate: CandidateDoc, step: FlowStep): Promise<boolean> {
  const question = tradeQuestionFor(step);
  if (!question?.otherPrompt) return false;

  await reply(candidate, await renderMessage(question.otherPrompt, candidate), step.id);
  await setState(candidate, { currentStep: `${step.id}${OTHER_SUFFIX}` });
  return true;
}

/** Records the typed "Other" value in place of the bare `other` marker. */
async function appendOtherAnswer(
  candidate: CandidateDoc,
  step: FlowStep,
  value: string,
): Promise<void> {
  const question = tradeQuestionFor(step);
  if (!question) return;

  const answers = { ...(candidate.profile.tradeAnswers ?? {}) };
  answers[question.id] = [...(answers[question.id] ?? []).filter((v) => v !== 'other'), value];

  const write = buildProfileWrite(
    candidate,
    { tradeAnswers: answers },
    { source: 'chat', raw: value, overwrite: true },
  );

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    {
      $set: { ...write.set, updatedAt: new Date() },
      $push: { history: { $each: write.changes } },
    },
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Menus
 * ───────────────────────────────────────────────────────────────────────────*/

const MENU_CHOICES: Record<string, Choice[]> = {
  [MENU.returning]: copy.RETURNING_CHOICES,
  [MENU.other]: copy.OTHER_CHOICES,
  [MENU.update]: copy.UPDATE_CHOICES,
  [MENU.edit]: copy.EDIT_CHOICES,
  [MENU.delete]: copy.DELETE_CHOICES,
  [MENU.reminder]: copy.REMINDER_CHOICES,
  [MENU.resume]: copy.RESUME_CHOICES,
  [MENU.jobs]: [
    { id: 'yes', label: copy.YES },
    { id: 'no', label: copy.NO },
  ],
};

const MENU_PROMPTS: Record<string, Localised> = {
  [MENU.returning]: copy.RETURNING_NO_ID,
  [MENU.other]: copy.OTHER_PROMPT,
  [MENU.update]: copy.UPDATE_PROMPT,
  [MENU.edit]: copy.EDIT_PROMPT,
  [MENU.delete]: copy.DELETE_CONFIRM,
  [MENU.reminder]: copy.REMINDER,
  [MENU.resume]: copy.RESUME_PROMPT,
  [MENU.jobs]: copy.JOBS_ANSWER,
};

/** A menu dressed as a step, so the interpreter takes the same input everywhere. */
function pseudoStep(menu: string): FlowStep {
  return {
    id: menu,
    section: 'confirm',
    prompt: MENU_PROMPTS[menu] ?? copy.UNCLEAR,
    input: 'choice',
    choices: MENU_CHOICES[menu] ?? [],
    satisfied: () => false,
  };
}

async function showReturningMenu(candidate: CandidateDoc): Promise<void> {
  const name = candidate.profile?.fullName ?? candidate.profileName ?? '';
  await ask(
    candidate,
    candidate.candidateId ? copy.RETURNING : copy.RETURNING_NO_ID,
    copy.RETURNING_CHOICES,
    MENU.returning,
    { name, candidateId: candidate.candidateId },
  );
}

/** Maps the edit and update menus onto flow sections (§18, §22). */
const SECTION_BY_MENU_CHOICE: Record<string, Section> = {
  personal: 'personal',
  experience: 'experience',
  new_experience: 'experience',
  job_preference: 'job_preference',
  country: 'country',
  availability: 'availability',
  documents: 'documents',
};

/**
 * Opens one section for editing.
 *
 * §18 is explicit that this opens the chosen section and does not restart
 * registration, which is why only that section's fields are forgotten.
 */
async function startEdit(candidate: CandidateDoc, section: Section): Promise<void> {
  const unset: Record<string, ''> = {};
  for (const field of fieldsToClear(section)) {
    unset[`profile.${field}`] = '';
    delete candidate.profile[field];
  }

  if (Object.keys(unset).length) {
    await recordsFor(candidate.enquiry).updateOne({ _id: candidate._id }, { $unset: unset });
  }

  await setState(candidate, {
    editQueue: stepsInSection(section).map((s) => s.id),
    unclearCount: 0,
  });
  await askNextQuestion(candidate);
}

async function handleMenuAnswer(
  candidate: CandidateDoc,
  menu: string,
  choiceId: string,
): Promise<void> {
  switch (menu) {
    // "Other" (§2). Two ways out: the B2B branch, or straight to a person.
    case MENU.other:
      if (choiceId === 'b2b') {
        await startB2bEnquiry(candidate);
        return;
      }
      await handOffToStaff(candidate, 'asked for a person from the "Other" menu');
      return;

    case MENU.returning:
      switch (choiceId) {
        case 'track':
          await startTracking(candidate);
          return;
        case 'check_jobs':
          // §27 forbids describing anyone's prospects, so this offers a person
          // rather than an answer.
          await ask(candidate, copy.JOBS_ANSWER, MENU_CHOICES[MENU.jobs]!, MENU.jobs);
          return;
        case 'update':
          await ask(candidate, copy.UPDATE_PROMPT, copy.UPDATE_CHOICES, MENU.update);
          return;
        case 'upload_documents':
          await tell(candidate, copy.SEND_DOCUMENTS);
          await setState(candidate, { currentStep: MENU.certificate });
          return;
        case 'delete':
          await ask(candidate, copy.DELETE_CONFIRM, copy.DELETE_CHOICES, MENU.delete);
          return;
        default:
          await showReturningMenu(candidate);
          return;
      }

    case MENU.jobs:
      if (choiceId === 'yes') await handOffToStaff(candidate, 'asked about current openings');
      else await showReturningMenu(candidate);
      return;

    case MENU.update:
    case MENU.edit: {
      const section = SECTION_BY_MENU_CHOICE[choiceId];
      if (section) {
        await startEdit(candidate, section);
        return;
      }
      if (choiceId === 'new_certificate') {
        await tell(candidate, copy.SEND_CERTIFICATE);
        await setState(candidate, { currentStep: MENU.certificate });
        return;
      }
      if (choiceId === 'contact') {
        await tell(candidate, copy.CONTACT_PROMPT);
        await setState(candidate, { currentStep: MENU.contact });
        return;
      }
      await ask(candidate, copy.UPDATE_PROMPT, copy.UPDATE_CHOICES, MENU.update);
      return;
    }

    case MENU.delete:
      if (choiceId === 'delete_yes') await deleteProfile(candidate);
      else {
        await tell(candidate, copy.DELETE_CANCELLED);
        await setState(candidate, { currentStep: undefined });
      }
      return;

    // §21's reminder and the idle-session prompt offer the same three things,
    // so they answer to the same code. Only the wording that opened them differs.
    case MENU.reminder:
    case MENU.resume:
      switch (choiceId) {
        case 'continue':
          await continueSession(candidate);
          return;
        case 'restart':
          await restartRegistration(candidate);
          return;
        case 'not_interested':
          await tell(candidate, copy.REMINDER_NOT_INTERESTED);
          await setState(candidate, { status: 'not_interested', currentStep: undefined });
          return;
        default:
          await tell(candidate, copy.REMINDER_LATER);
          await setState(candidate, { currentStep: undefined });
          return;
      }

    default:
      await askNextQuestion(candidate);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Idle sessions and starting over
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Stages a half-finished registration can be sitting in.
 *
 * Deliberately not the same list as the §21 reminder sweep: this one includes
 * LANGUAGE_PENDING, because someone who tapped "Apply" and then went quiet at
 * the language question has an open session worth closing, even though §21 does
 * not want them chased with a reminder.
 */
const RESUMABLE_STAGES: ReadonlySet<ConversationStage> = new Set<ConversationStage>([
  'LANGUAGE_PENDING',
  'CONSENT_PENDING',
  'CV_PENDING',
  'BASIC_DETAILS_PENDING',
  'JOB_PREFERENCE_PENDING',
  'DOCUMENTS_PENDING',
  'CONFIRMATION_PENDING',
  'B2B_PENDING',
]);

function sessionTimedOut(lastInboundAt: Date | undefined, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() > TUNABLES.sessionTimeoutMinutes * 60_000;
}

/**
 * Reopens a closed session.
 *
 * `$unset` rather than setting the field to undefined: through `$set` that
 * writes a BSON null, which still satisfies `$exists`, and the sweep would
 * never close this candidate's session again.
 */
async function reopenSession(candidate: CandidateDoc): Promise<void> {
  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    { $unset: { sessionEndedAt: '' }, $set: { updatedAt: new Date() } },
  );
  candidate.sessionEndedAt = undefined;
}

/**
 * Rebuilds the profile fields the documents on file already answered.
 *
 * Restarting clears the profile but keeps the documents (§22), and those two
 * facts used to contradict each other. The CV stayed on file, so the CV step
 * counted as satisfied and was skipped — but everything the CV had *told* us
 * went out with the profile, so the candidate was walked through their name,
 * their date of birth, their trade and the rest one question at a time. They had
 * sent a CV and were then interviewed as if they had not, which is precisely
 * what §5 exists to prevent.
 *
 * So the extractions are replayed here, from the OCR already stored against each
 * current upload. Nothing is re-read and nothing is re-downloaded — the fields
 * are on the upload, exactly as the worker left them. Oldest first, so the order
 * matches the order they originally arrived in and later documents settle over
 * earlier ones the same way they did the first time.
 *
 * What the candidate typed is not restored, and should not be: those are the
 * answers they asked to start over on. Only what a document says comes back.
 */
async function reseedProfileFromDocuments(candidate: CandidateDoc): Promise<void> {
  const uploads = await uploadsFor(candidate.waId);

  for (const upload of uploads) {
    // Superseded versions are history. The current upload in each slot is the
    // one whose reading counts (§22).
    if (upload.supersededAt) continue;

    const fields = upload.ocr?.fields;
    if (upload.ocr?.status !== 'done' || !fields?.length) continue;

    const extractor = requirementFor(upload.docType)?.ocr;
    if (!extractor || extractor === 'none') continue;

    const patch =
      extractor === 'resume'
        ? extractFromCv(fields, candidate.waId).patch
        : profileFromIdentityDocument(upload.docType, fields);

    if (!Object.keys(patch).length) continue;

    // Straight through `buildProfileWrite` so the restored fields carry the same
    // provenance they had before — source 'cv' or 'document', unverified, with
    // the extractor's confidence attached (§27).
    const write = buildProfileWrite(candidate, patch, {
      source: extractor === 'resume' ? 'cv' : 'document',
      confidence: upload.ocr.confidence ?? null,
    });

    if (!Object.keys(write.set).length) continue;

    await recordsFor(candidate.enquiry).updateOne(
      { _id: candidate._id },
      { $set: { ...write.set, updatedAt: new Date() }, $push: { history: { $each: write.changes } } },
    );

    logger.info(
      { waId: candidate.waId, docType: upload.docType, fields: Object.keys(patch).length },
      'profile reseeded from a document already on file',
    );
  }
}

/**
 * Starts the questions again from the top.
 *
 * Answers go; documents stay. §22 forbids destroying an upload without a
 * version history, and someone re-answering the questions has not withdrawn the
 * passport they already sent — re-requesting it would also break §1, which says
 * never to ask for something already on file. Consent and language survive for
 * the same reason: both are recorded facts, not answers being revised.
 */
/**
 * Fields a restart removes from the record entirely.
 *
 * `$unset` rather than setting them to undefined: through `$set` that writes a
 * BSON null, which still satisfies `$exists`, and a stale `currentStep` left
 * behind would have the candidate's next tap answer the question they just
 * abandoned.
 */
export const RESTART_UNSETS = [
  'currentStep',
  'resumeStep',
  'pendingMulti',
  'sessionEndedAt',
] as const;

/**
 * What "Restart session" resets, and — more importantly — what it does not.
 *
 * A restart moves the candidate back to the top of the flow. It does not throw
 * anything away. That distinction used to be the other way round: `profile` and
 * `fieldMeta` were emptied here, so someone who tapped "start again" because
 * they had mistyped one answer lost every answer, and the CV they had already
 * sent was re-read to put some of them back. Restarting a conversation is not
 * the same act as withdrawing the answers given during it — that is what DELETE
 * is for (§23), and it asks first.
 *
 * So what is cleared is the conversation's *position*, and nothing else:
 *
 *   stage        back to the beginning of the flow
 *   editQueue    steps an UPDATE had queued, which are not where they now are
 *   unclearCount the run of replies we could not read
 *   currentStep  the question that was open (via RESTART_UNSETS)
 *   resumeStep   the question a resume prompt interrupted (via RESTART_UNSETS)
 *   pendingMulti a half-made multi-select, which belongs to a question that is
 *                about to be recomputed
 *
 * Everything a candidate has told us or sent us stays: `profile`, `fieldMeta`,
 * `documents`, `consent`, `language`, `history`, and `reminderSentAt` (§21
 * allows one reminder per candidate, and restarting does not make someone a new
 * one).
 *
 * The visible result is what the candidate is promised: the flow starts over,
 * `nextStep` walks it from the first step, and every step that is already
 * satisfied is skipped — so they are asked only for what is genuinely still
 * missing (§1). Where nothing is missing, a restart runs straight to the
 * confirmation, which is the correct answer to "start again" from someone whose
 * answers are all on file.
 *
 * The smoke tests assert against this contract, so a new session field has to be
 * classified deliberately rather than forgotten.
 */
export function restartPatch(candidate: CandidateDoc): Partial<CandidateDoc> {
  return {
    stage: 'NEW',
    status: BOT_OWNED.has(candidate.status) ? 'new_enquiry' : candidate.status,
    editQueue: [],
    unclearCount: 0,
  };
}

/**
 * "Restart session" — the flow from the top, the record untouched.
 *
 * `askNextQuestion` recomputes from `STEPS[0]` every time it runs, so clearing
 * the position *is* the restart: there is no cursor to rewind and no separate
 * "start again" path that could disagree with the ordinary one. What the
 * candidate then sees is the first step that is not already satisfied, which for
 * someone part-way through is usually the question they were on, and for someone
 * who has answered everything is the confirmation.
 */
async function restartRegistration(candidate: CandidateDoc): Promise<void> {
  await recordAudit({
    waId: candidate.waId,
    candidateId: candidate.candidateId,
    event: 'registration_restarted',
    detail: 'candidate chose to start from the beginning; answers and documents kept',
  });

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    { $unset: Object.fromEntries(RESTART_UNSETS.map((key) => [key, ''])) },
  );

  await setState(candidate, restartPatch(candidate));

  Object.assign(candidate, {
    currentStep: undefined,
    resumeStep: undefined,
    pendingMulti: undefined,
    sessionEndedAt: undefined,
  });

  // Belt and braces on §5, and no longer load-bearing: the profile is not
  // cleared above any more, so this is here for the uploads whose extraction
  // landed while the record was being written — it replays what each current
  // document said, and `buildProfileWrite` refuses to let any of it overwrite
  // something the candidate typed.
  await reseedProfileFromDocuments(candidate);

  logger.info(
    { waId: candidate.waId },
    'registration restarted at the candidate’s request; stored answers kept',
  );

  await tell(candidate, copy.RESTARTED);
  await askNextQuestion(candidate);
}

/**
 * "Continue session" — back to the exact question that was interrupted.
 *
 * `currentStep` cannot answer this on its own, because by the time the candidate
 * taps Continue it holds the resume menu: the prompt has to occupy the open-step
 * pointer, or their tap would be read as an answer to the question underneath
 * instead of to the prompt. So `askResume` stashes what it displaced and this
 * puts it back.
 *
 * Falls through to the ordinary scheduler whenever the stashed question is no
 * longer a question — it was answered by a document that arrived in the
 * meantime, or a step it depends on changed and `when` now excludes it. That
 * fallback is also what handles a candidate who had no open question at all,
 * which is everyone whose session lapsed between two questions.
 */
async function continueSession(candidate: CandidateDoc): Promise<void> {
  await reopenSession(candidate);

  const stashed = candidate.resumeStep;
  await setState(candidate, { currentStep: undefined, resumeStep: undefined, unclearCount: 0 });

  if (stashed) {
    // A free-text follow-up to an "Other" choice. The base step is satisfied —
    // they did answer it — so `nextStep` would walk straight past it and the
    // words they were being asked for would never be collected.
    if (stashed.endsWith(OTHER_SUFFIX)) {
      const base = stepById(stashed.slice(0, -OTHER_SUFFIX.length));
      if (base && (await askForOtherText(candidate, base))) return;
    } else {
      const step = stepById(stashed);
      if (step && (!step.when || step.when(candidate)) && !step.satisfied(candidate)) {
        await reply(candidate, await renderStep(step, candidate), step.id);
        await setState(candidate, { currentStep: step.id });
        return;
      }
    }
  }

  await askNextQuestion(candidate);
}

/**
 * Pushes a resume or reminder prompt, remembering the question it interrupts.
 *
 * See `continueSession` for why the stash exists. Menus and the `ask:`
 * pseudo-steps are deliberately not stashed: they are prompts rather than flow
 * questions, and restoring one would put the candidate back in front of a menu
 * they walked away from instead of in front of the registration they came for.
 */
async function askResume(
  candidate: CandidateDoc,
  body: Localised,
  options: Choice[],
  menu: string,
  vars?: Record<string, string | undefined>,
): Promise<void> {
  const open = candidate.currentStep;
  if (open && !open.startsWith('menu:') && !open.startsWith('ask:')) {
    await setState(candidate, { resumeStep: open });
  }
  await ask(candidate, body, options, menu, vars);
}

/**
 * Closes sessions that have gone quiet and tells the candidate, offering the two
 * ways out.
 *
 * The message is pushed the moment the session lapses rather than waiting for
 * the candidate to message again — someone who has stopped mid-registration is
 * precisely the person who will not come back on their own. `handleInboundMessage`
 * still carries the same offer for a message that arrives before this sweep
 * reached them, so the behaviour is correct even after a restart or an outage.
 *
 * The session is claimed *before* anything is sent, so a second instance, a
 * restart, or a slow send cannot produce two of these for one lapse.
 */
export async function endIdleSessions(limit = 200): Promise<number> {
  const cutoff = new Date(Date.now() - TUNABLES.sessionTimeoutMinutes * 60_000);

  const query = {
    sessionEndedAt: { $exists: false },
    lastInboundAt: { $lt: cutoff },
    stage: { $in: [...RESUMABLE_STAGES] },
  };

  // Both stores: a business contact who goes quiet part-way through the B2B
  // branch has an open sitting worth closing, exactly like a candidate does.
  const stale = (
    await Promise.all([
      candidates().find(query).limit(limit).toArray(),
      b2bEnquiries().find(query).limit(limit).toArray(),
    ])
  )
    .flat()
    .slice(0, limit);

  let ended = 0;

  for (const row of stale) {
    // The same lock the queue holds. Without it this can land between a
    // candidate's reply and the answer to it — they would be told the session
    // ended a second after being asked the next question.
    ended += await withCandidateLock(row.waId, async () => {
      // Re-read under the lock: they may have replied while we queued behind
      // their own turn, and the row in hand is a snapshot from before that.
      const candidate = await recordsFor(row.enquiry).findOne({ _id: row._id });
      if (!candidate) return 0;
      if (candidate.sessionEndedAt != null) return 0;
      if (!RESUMABLE_STAGES.has(candidate.stage)) return 0;
      if (!sessionTimedOut(candidate.lastInboundAt)) return 0;

      const claimed = await recordsFor(candidate.enquiry).updateOne(
        { _id: candidate._id, sessionEndedAt: { $exists: false } },
        { $set: { sessionEndedAt: new Date(), updatedAt: new Date() } },
      );
      if (!claimed.modifiedCount) return 0;

      await recordAudit({
        waId: candidate.waId,
        candidateId: candidate.candidateId,
        event: 'session_timed_out',
        detail: `idle at "${candidate.currentStep ?? 'unknown step'}"`,
      });

      // Backfill for records written before a field or document existed — the
      // render path reads both.
      candidate.documents = withMissingSlots(candidate.documents);
      candidate.profile ??= {};
      candidate.fieldMeta ??= {};

      // Only an approved template may be sent outside the window, and this is
      // not one. A candidate five minutes idle is comfortably inside it; the
      // guard is for the backlog a restart sweeps up, where the alternative is
      // a message Meta rejects for everyone who went quiet yesterday.
      if ((candidate.windowExpiresAt?.getTime() ?? 0) > Date.now()) {
        try {
          await askResume(candidate, copy.SESSION_ENDED, copy.RESUME_CHOICES, MENU.resume);
        } catch (err) {
          // The session is closed either way; `handleInboundMessage` still
          // offers the same choice on their next message.
          logger.error({ err, waId: candidate.waId }, 'session-ended notice failed to send');
        }
      }

      // Closed after the notice, so the sentence telling them the sitting ended
      // is the last line of that sitting rather than the first of the next.
      await closeOpenSession(candidate.waId);

      return 1;
    });
  }

  if (ended) logger.info({ ended }, 'idle sessions closed and candidates told');
  return ended;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The turn
 * ───────────────────────────────────────────────────────────────────────────*/

export async function handleInboundMessage(payload: {
  waId: string;
  wamid: string;
  profileName?: string;
}): Promise<void> {
  const msg = await findTurn(payload.wamid, 'inbound');
  if (!msg) {
    logger.warn({ wamid: payload.wamid }, 'inbound job for unknown message');
    return;
  }

  const { candidate, created } = await getOrCreateCandidate({
    waId: payload.waId,
    phone: msg.waId,
    profileName: payload.profileName,
  });

  // Read before it is overwritten: the gap since their last message is what
  // decides whether the session they were in is still open.
  const previousInboundAt = candidate.lastInboundAt;

  const now = new Date();
  await setState(candidate, {
    lastInboundAt: now,
    windowExpiresAt: new Date(now.getTime() + WINDOW_MS),
  });

  // §24 — nothing automated runs while a person has the conversation.
  if (candidate.stage === 'HUMAN_HANDOFF') {
    logger.info({ waId: candidate.waId }, 'inbound left for staff: the bot is paused');
    return;
  }

  // A deleted candidate messaging again is starting over, not resuming (§23).
  if (candidate.stage === 'DELETED') {
    // Back to a blank conversation, which means back to the collection blank
    // conversations live in: they get the opening menu again, and what they
    // choose this time decides where the record is filed.
    await refileConversation(candidate, undefined);
    await setState(candidate, {
      enquiry: undefined,
      stage: 'NEW',
      status: 'new_enquiry',
      profile: {},
      fieldMeta: {},
      history: [],
      documents: initialSlots(),
      consent: undefined,
      candidateId: undefined,
      completedAt: undefined,
      deletion: undefined,
      currentStep: undefined,
      reminderSentAt: undefined,
      // Starting over means picking a language again, not inheriting the one
      // attached to a profile that no longer exists.
      languageChosen: undefined,
    });
  }

  /* ---- take delivery of whatever they sent ---- */

  let text = msg.text ?? '';
  let voiceNoteUnread = false;
  let ingested: Ingested = {};

  if (msg.mediaId && msg.type === 'audio') {
    const transcript = await ingestVoiceNote(candidate, msg);
    if (transcript) text = transcript;
    else voiceNoteUnread = true;
  } else if (msg.mediaId && ['image', 'document', 'video'].includes(msg.type)) {
    ingested = await ingestDocument(candidate, msg);
  }

  /* ---- the opening turn (§2) ---- */

  if (created || candidate.stage === 'NEW') {
    const detected = detectLanguage(text);
    // Only chooses the language of the welcome message; §3 asks them to confirm
    // on the very next turn, so a wrong guess costs nothing.
    if (detected && !candidate.language) await setState(candidate, { language: detected });
    await askNextQuestion(candidate);
    return;
  }

  /* ---- commands that work anywhere (§22, §23, §24) ---- */

  const command = detectGlobalCommand(text, msg.replyId);

  if (command === 'staff') {
    await handOffToStaff(candidate, 'asked to speak to a person');
    return;
  }
  if (command === 'delete') {
    await ask(candidate, copy.DELETE_CONFIRM, copy.DELETE_CHOICES, MENU.delete);
    return;
  }
  // Not offered before consent — there is nothing recorded yet to update.
  if (command === 'update' && candidate.consent?.given) {
    await ask(candidate, copy.UPDATE_PROMPT, copy.UPDATE_CHOICES, MENU.update);
    return;
  }

  // An application id sent unprompted, at any point in the conversation. It is
  // only ever one question — "where has my application got to?" — and it is
  // answered wherever it arrives rather than being read as an answer to
  // whatever was last asked.
  if (looksLikeApplicationId(text)) {
    await lookUpApplication(candidate, text);
    return;
  }

  /* ---- a registered candidate coming back (§20) ---- */

  if (candidate.stage === 'REGISTRATION_COMPLETED' && !candidate.currentStep) {
    if (ingested.failed) {
      const failure = fileFailureCopy(ingested);
      await tell(candidate, failure.text, failure.vars);
      return;
    }
    if (ingested.docType) {
      await acknowledgeDocument(candidate, ingested.docType);
      return;
    }
    await showReturningMenu(candidate);
    return;
  }

  /* ---- a file arrived ---- */

  if (ingested.failed) {
    const failure = fileFailureCopy(ingested);
    await tell(candidate, failure.text, failure.vars);
    return;
  }
  if (ingested.docType) {
    await acknowledgeDocument(candidate, ingested.docType);
    return;
  }

  /* ---- the session they were in has expired ---- */

  // The sweep normally gets here first and has already pushed the same choice —
  // in which case `currentStep` is the resume menu and this is skipped. This is
  // the path for a message that beats the sweep to it, or arrives after a
  // restart or an outage stopped it running at all.
  // Only reached for a message that is not a file: someone sending a document
  // knows exactly what they are doing and should not be asked whether they want
  // to start again.
  // The `currentStep` guard is what stops this answering itself: once the
  // prompt is on screen it is an ordinary open menu, handled below.
  // `!= null` rather than `!== undefined` because clearing a field through
  // `$set` writes BSON null, not absence.
  if (
    candidate.currentStep !== MENU.resume &&
    RESUMABLE_STAGES.has(candidate.stage) &&
    (candidate.sessionEndedAt != null || sessionTimedOut(previousInboundAt, now))
  ) {
    const name = candidate.profile?.fullName ?? candidate.profileName ?? '';
    await askResume(candidate, copy.RESUME_PROMPT, copy.RESUME_CHOICES, MENU.resume, {
      name: name ? `, ${name}` : '',
    });
    return;
  }

  const current = candidate.currentStep ?? '';

  /* ---- waiting for something that is not a flow answer ---- */

  if (current === MENU.contact) {
    if (text.trim()) {
      const value = text.trim();
      const write = buildProfileWrite(
        candidate,
        value.includes('@') ? { email: value } : { alternateNumber: value },
        { source: 'chat', raw: value, overwrite: true },
      );
      await recordsFor(candidate.enquiry).updateOne(
        { _id: candidate._id },
        {
          $set: { ...write.set, updatedAt: new Date() },
          $push: { history: { $each: write.changes } },
        },
      );
      await tell(candidate, copy.UPDATE_SAVED);
      await setState(candidate, { currentStep: undefined });
      return;
    }
    await tell(candidate, voiceNoteUnread ? copy.VOICE_NOT_UNDERSTOOD : copy.CONTACT_PROMPT);
    return;
  }

  if (current === MENU.trackId) {
    if (!text.trim()) {
      await tell(candidate, voiceNoteUnread ? copy.VOICE_NOT_UNDERSTOOD : copy.TRACK_ASK_ID);
      return;
    }
    await lookUpApplication(candidate, text.trim());
    return;
  }

  if (current === MENU.trackDob) {
    if (!text.trim()) {
      await tell(candidate, voiceNoteUnread ? copy.VOICE_NOT_UNDERSTOOD : copy.TRACK_ASK_DOB);
      return;
    }
    await verifyTrackingDob(candidate, text.trim());
    return;
  }

  if (current === MENU.certificate) {
    // Waiting for a file. Anything else is a nudge, not an answer.
    await tell(candidate, copy.SEND_CERTIFICATE);
    return;
  }

  if (current.endsWith(OTHER_SUFFIX)) {
    const step = stepById(current.slice(0, -OTHER_SUFFIX.length));
    if (step) {
      if (!text.trim()) {
        await tell(candidate, voiceNoteUnread ? copy.VOICE_NOT_UNDERSTOOD : copy.UNCLEAR);
        return;
      }
      await appendOtherAnswer(candidate, step, text.trim());
      await setState(candidate, { currentStep: step.id, unclearCount: 0 });
      await drainEditQueue(candidate, step.id);
      await askNextQuestion(candidate);
      return;
    }
  }

  /* ---- a menu is open ---- */

  if (current.startsWith('menu:')) {
    const menu = pseudoStep(current);
    const options = MENU_CHOICES[current] ?? [];

    const interpretation = await interpret({ step: menu, choices: options, text, replyId: msg.replyId });

    if (interpretation.kind === 'matched') {
      await handleMenuAnswer(candidate, current, interpretation.ids[0]!);
      return;
    }
    if (interpretation.kind === 'staff') {
      await handOffToStaff(candidate, interpretation.reason);
      return;
    }

    // The model could not be reached. Put the menu back and say why, rather
    // than telling them their tap was unusable.
    if (interpretation.kind === 'unavailable') {
      const shape = await renderChoices(menu.prompt, options, candidate);
      const lead = (await renderMessage(copy.BUSY_TRY_AGAIN, candidate)).body;
      await reply(candidate, { ...shape, body: `${lead}\n\n${shape.body}` }, current);
      return;
    }

    // A question asked at a menu is still a question, and a remark about the
    // menu is still a remark. Both are answered here as well as in the flow —
    // otherwise "is there any fee?" is met with "sorry, I could not use that as
    // an answer" purely because of where in the conversation it landed.
    let answer: string | undefined;
    if (interpretation.kind === 'unrelated') {
      const answered = await answerFromFaq({
        question: interpretation.raw,
        language: candidate.language,
        languageOther: candidate.languageOther,
      });
      if (answered.kind === 'staff') {
        await handOffToStaff(candidate, 'raised something the bot must not answer');
        return;
      }
      if (answered.kind === 'answered') answer = answered.text;
    } else if (interpretation.kind === 'related') {
      const replied = await respondInContext({
        question: menu.prompt.en,
        options: options.map((o) => o.label.en),
        message: interpretation.raw,
        language: candidate.language,
        languageOther: candidate.languageOther,
      });
      if (replied.kind === 'staff') {
        await handOffToStaff(candidate, 'raised something the bot must not answer');
        return;
      }
      if (replied.kind === 'answered') answer = replied.text;
    }

    // Same rule as a flow question: one message carrying both the lead line and
    // the menu, not two bubbles for one event.
    const lead =
      answer ??
      (await renderMessage(voiceNoteUnread ? copy.VOICE_NOT_UNDERSTOOD : copy.UNCLEAR, candidate))
        .body;
    const shape = await renderChoices(menu.prompt, options, candidate);
    await reply(candidate, { ...shape, body: `${lead}\n\n${shape.body}` }, current);
    return;
  }

  /* ---- the question we actually asked ---- */

  const step = (current ? stepById(current) : undefined) ?? nextStep(candidate);
  if (!step) {
    await askNextQuestion(candidate);
    return;
  }

  // An answered question stays answered.
  //
  // `currentStep` is a pointer, and pointers go stale: a restart between the
  // answer being written and the next question being asked, a redelivery, a tap
  // on a message from before the answer landed. Each of those arrives here
  // pointing at a step whose answer is already on the record — and
  // `recordAnswer` would write over it, because `buildProfileWrite` only refuses
  // a *weaker* source, so a second reply from chat replaces the first without
  // anything noticing.
  //
  // The lock is on the step rather than the field, because one field can hold
  // many answers: every question in a trade pack writes into `tradeAnswers`, so
  // locking that field would silently drop the second question of every pack.
  //
  // An edit is exempt, and barely needs to be: `startEdit` clears the section's
  // fields first, so those steps are genuinely unanswered by the time they are
  // re-asked. The `editQueue` check is belt and braces around that.
  if (!(candidate.editQueue ?? []).includes(step.id) && step.satisfied(candidate)) {
    logger.info(
      { waId: candidate.waId, step: step.id, tapped: msg.replyId },
      'ignored a reply to a question that is already answered',
    );
    // A tap is told its option has expired; typed words are told they could not
    // be used as an answer, which is true of both and accurate about neither
    // the candidate nor their message.
    await askNextQuestion(candidate, msg.replyId ? copy.OPTION_EXPIRED : copy.UNCLEAR);
    return;
  }

  // A tap that belongs to an earlier question answers that question, not this
  // one. WhatsApp keeps every button live in the history, and several steps
  // offer the same ids — "yes" appears on the passport, welding-certificate and
  // training questions — so a stale tap can be recorded against a question it
  // was never about. Meta tells us which message the button came from; if that
  // message asked something else, the tap is refused and the open question is
  // put back.
  if (msg.replyId && msg.contextWamid) {
    const asked = await findTurn(msg.contextWamid, 'outbound');
    if (asked?.step && asked.step !== step.id) {
      logger.info(
        { waId: candidate.waId, tapped: msg.replyId, from: asked.step, now: step.id },
        'ignored a tap on an expired option',
      );
      await reply(candidate, await renderRetry(step, candidate, copy.OPTION_EXPIRED), step.id);
      return;
    }
  }

  if (voiceNoteUnread) {
    await reply(
      candidate,
      await renderRetry(step, candidate, copy.VOICE_NOT_UNDERSTOOD),
      step.id,
    );
    return;
  }

  const interpretation = await interpret({
    step,
    choices: acceptedChoices(step, candidate),
    text,
    replyId: msg.replyId,
  });

  switch (interpretation.kind) {
    case 'staff':
      await handOffToStaff(candidate, interpretation.reason);
      return;

    case 'unavailable':
      // Not an answer, and explicitly not a reply we could not read. Nothing is
      // recorded, `unclearCount` is untouched, and the same question goes back —
      // so a throttled minute costs the candidate one repeated message rather
      // than their place in the queue and a handover to staff.
      await reply(candidate, await renderRetry(step, candidate, copy.BUSY_TRY_AGAIN), step.id);
      return;

    case 'command':
      await ask(
        candidate,
        interpretation.command === 'delete' ? copy.DELETE_CONFIRM : copy.UPDATE_PROMPT,
        interpretation.command === 'delete' ? copy.DELETE_CHOICES : copy.UPDATE_CHOICES,
        interpretation.command === 'delete' ? MENU.delete : MENU.update,
      );
      return;

    case 'related': {
      // They engaged with the question without answering it — asked what an
      // option means, described a condition, queried the question itself.
      // Re-asking it with "I could not use that as an answer" on top is a lie:
      // it was a usable message, just not an answer, and it deserves a reply.
      const replied = await respondInContext({
        question: step.prompt.en,
        options: acceptedChoices(step, candidate).map((c) => c.label.en),
        context: step.expects?.context,
        message: interpretation.raw,
        language: candidate.language,
        languageOther: candidate.languageOther,
      });

      if (replied.kind === 'staff') {
        await handOffToStaff(candidate, 'raised something the bot must not answer');
        return;
      }

      if (replied.kind === 'answered') {
        // The question goes back underneath, unchanged, so replying to them
        // never costs them their place in the flow.
        await reply(candidate, await renderRetry(step, candidate, replied.text), step.id);
        return;
      }

      // Nothing safe to say. Not counted as a reply we could not read — we read
      // it fine — so this cannot walk the candidate towards a handoff.
      await reply(candidate, await renderRetry(step, candidate, copy.UNCLEAR), step.id);
      return;
    }

    case 'unrelated': {
      // The candidate asked a question of their own. Answer it where we have an
      // approved answer, and put the open question back underneath — one
      // message, so their screen shows an exchange rather than a rebuff.
      //
      // §27 survives this: `faq.ts` writes only from the approved list and its
      // output is guard-checked before it gets here, so no promise about a
      // salary, a visa or a selection can reach a candidate.
      const answered = await answerFromFaq({
        question: interpretation.raw,
        language: candidate.language,
        languageOther: candidate.languageOther,
      });

      if (answered.kind === 'staff') {
        await handOffToStaff(candidate, 'raised something the bot must not answer');
        return;
      }

      if (answered.kind === 'answered') {
        // No staff button. The question was answered — offering a person on top
        // of an answer is the reflex this branch exists to stop.
        await reply(candidate, await renderRetry(step, candidate, answered.text), step.id);
        return;
      }

      // Nothing approved covers it. Before falling back to the staff line, try
      // reading it as a remark about the open question instead.
      //
      // The split between `related` and `unrelated` is a model's judgement and
      // it is not stable: the same reply — "tailor machine" at the CNC machine
      // question — came back `related` on one run and `unrelated` on the next.
      // Both are correct readings; only one of them used to produce a useful
      // message, and which one the candidate got was luck. This makes the two
      // paths converge on the same reply rather than leaving that to the prompt.
      const asRemark = await respondInContext({
        question: step.prompt.en,
        options: acceptedChoices(step, candidate).map((c) => c.label.en),
        context: step.expects?.context,
        message: interpretation.raw,
        language: candidate.language,
        languageOther: candidate.languageOther,
      });

      if (asRemark.kind === 'staff') {
        await handOffToStaff(candidate, 'raised something the bot must not answer');
        return;
      }

      if (asRemark.kind === 'answered') {
        await reply(candidate, await renderRetry(step, candidate, asRemark.text), step.id);
        return;
      }

      // Genuinely nothing to say. They are told staff will pick it up — which is
      // true — but no button is attached: a person is reached by asking for one,
      // and hanging the offer off every unanswerable question is what made the
      // bot feel like it was showing them the door.
      await reply(candidate, await renderRetry(step, candidate, copy.OUT_OF_SCOPE), step.id);
      return;
    }

    case 'unclear': {
      const count = (candidate.unclearCount ?? 0) + 1;
      await setState(candidate, { unclearCount: count });

      if (count >= TUNABLES.maxAsksPerStep) {
        await tell(candidate, copy.STUCK);
        await handOffToStaff(candidate, `could not understand ${count} replies at "${step.id}"`);
        return;
      }

      // The classifier could not fit the reply into an answer. That is not the
      // same as the reply being meaningless, and the two used to get the same
      // sentence: "Sorry, I could not use that as an answer", over a message
      // like "I will upload my passport" — which anybody reading it understands
      // perfectly well, and which deserves an answer about the upload rather
      // than a shrug.
      //
      // So the same fenced reply `related` uses is tried here too. It is
      // grounded in the open question, the options, and the approved answers,
      // its output is guard-checked, and it records nothing. When it has
      // nothing safe to say — a genuine keysmash, a fragment — it declines and
      // the fixed line below is sent exactly as before.
      const replied = await respondInContext({
        question: step.prompt.en,
        options: acceptedChoices(step, candidate).map((c) => c.label.en),
        context: step.expects?.context,
        message: interpretation.raw,
        language: candidate.language,
        languageOther: candidate.languageOther,
      });

      if (replied.kind === 'staff') {
        await handOffToStaff(candidate, 'raised something the bot must not answer');
        return;
      }

      // No staff button either way: a typo in a city name is not a reason to
      // offer a human, and the handoff above catches the second one anyway.
      await reply(
        candidate,
        await renderRetry(
          step,
          candidate,
          replied.kind === 'answered' ? replied.text : copy.UNCLEAR,
        ),
        step.id,
      );
      return;
    }

    default:
      break;
  }

  await setState(candidate, { unclearCount: 0 });

  if (step.input === 'multi_choice' && interpretation.kind === 'matched') {
    const outcome = await accumulateMultiSelect(
      candidate,
      step,
      interpretation.ids,
      !!msg.replyId,
    );
    if (outcome === 'waiting') {
      await reply(candidate, await renderStep(step, candidate), step.id);
      return;
    }
    if (outcome === 'handled') return;
  } else {
    // `tapped` distinguishes an option the candidate actually pressed from one
    // the interpreter chose on their behalf. Both arrive as ids; only the first
    // is a statement that they are in that category and nothing more.
    const tapped = !!msg.replyId;
    const answer: Answer =
      interpretation.kind === 'matched'
        ? { ids: interpretation.ids, raw: interpretation.raw, tapped }
        : interpretation.kind === 'structured'
          ? { fields: interpretation.fields, raw: interpretation.raw, tapped }
          : { value: interpretation.value, raw: interpretation.raw, tapped };

    if (await handleSpecialStep(candidate, step, answer)) return;
    await recordAnswer(candidate, step, answer);

    // "Other" on a trade question needs the candidate's own words before moving on.
    if (answer.ids?.includes('other') && (await askForOtherText(candidate, step))) return;
  }

  // An answer that was understood but left the question unsatisfied would have
  // the same question asked again next turn, and the turn after that, forever.
  // It happens when the interpreter returns a value for a step that needed an
  // option id — `total_experience` gets "about six" with no band, `location`
  // yields only a country — and no amount of re-asking fixes it. Counted like a
  // reply we could not read, so the conversation reaches a person instead.
  if ((!step.when || step.when(candidate)) && !step.satisfied(candidate)) {
    const count = (candidate.unclearCount ?? 0) + 1;
    await setState(candidate, { unclearCount: count });

    if (count >= TUNABLES.maxAsksPerStep) {
      await tell(candidate, copy.STUCK);
      await handOffToStaff(candidate, `"${step.id}" still unanswered after ${count} replies`);
      return;
    }

    logger.warn({ waId: candidate.waId, step: step.id, count }, 'answer left the step unsatisfied');
    await reply(candidate, await renderRetry(step, candidate, copy.UNCLEAR), step.id);
    return;
  }

  await drainEditQueue(candidate, step.id);
  await askNextQuestion(candidate);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Documents, after extraction
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * What to say the moment a file arrives.
 *
 * A CV is acknowledged straight away and the next question waits for extraction,
 * so the questions the CV answers are never asked (§5). An identity document is
 * not called "received" until it has been read, because §14 forbids saying so
 * before the upload is known to be usable.
 */
/**
 * Tells the candidate the file they sent is not the document that was asked for.
 *
 * Written by `respond.ts` rather than taken from `copy.ts`, because the useful
 * sentence names both halves — "that looks like your Aadhaar card, could you
 * send your CV?" — and fixed copy cannot name something the engine only found
 * out at runtime. It is fenced and guard-checked there, and it decides nothing:
 * the slot, the verdict and the next question are all settled before it is
 * called. When it declines, or the model call fails, the fixed copy says the
 * same thing in fewer words and in all three languages.
 */
async function wrongDocumentLead(
  candidate: CandidateDoc,
  docType: string,
  looksLike?: string,
): Promise<string> {
  const name = (
    await renderMessage(requirementFor(docType)?.label ?? copy.DOCUMENT_THIS_ONE, candidate)
  ).body;

  const appearsToBe = looksLike
    ? (await renderMessage(requirementFor(looksLike)?.label ?? copy.DOCUMENT_THIS_ONE, candidate))
        .body
    : undefined;

  const written = await explainWrongDocument({
    expected: name,
    appearsToBe,
    language: candidate.language,
    languageOther: candidate.languageOther,
  });

  if (written.kind === 'answered') return written.text;

  // `DOCUMENT_WRONG_TYPE` claims to know what the file is not; without an
  // identification the honest fixed line is the one that only says it could not
  // be read.
  return (
    await renderMessage(
      looksLike ? copy.DOCUMENT_WRONG_TYPE : copy.DOCUMENT_NOT_READ,
      candidate,
      { document: name },
    )
  ).body;
}

/**
 * What to say about an upload that could not be used, in the contact's language.
 *
 * Returned rather than sent, so the caller can put it on the same message as the
 * question it belongs to. What went wrong decides the wording: telling someone
 * to "resend all pages" when the extractor got nothing at all — or when they
 * sent the wrong card — is advice they cannot act on, and they send the same
 * file again.
 */
async function unusableUploadLead(
  candidate: CandidateDoc,
  docType: string,
  outcome: DocumentOutcome,
): Promise<string> {
  if (outcome.verdict === 'wrong_document') {
    return wrongDocumentLead(candidate, docType, outcome.looksLike);
  }

  if (outcome.verdict === 'unreadable') {
    return (await renderMessage(copy.DOCUMENT_UNREADABLE, candidate)).body;
  }

  const documentName = (
    await renderMessage(requirementFor(docType)?.label ?? copy.DOCUMENT_THIS_ONE, candidate)
  ).body;

  if (outcome.verdict === 'empty') {
    return (await renderMessage(copy.DOCUMENT_NOT_READ, candidate, { document: documentName })).body;
  }

  const detail = outcome.missingPages?.length
    ? (
        await renderMessage(copy.DOCUMENT_PAGES, candidate, {
          pages: outcome.missingPages.join(', '),
        })
      ).body
    : (await renderMessage(copy.DOCUMENT_ALL_PAGES, candidate)).body;

  return (await renderMessage(copy.DOCUMENT_INCOMPLETE, candidate, { detail })).body;
}

async function acknowledgeDocument(candidate: CandidateDoc, docType: string): Promise<void> {
  if (docType === 'cv') {
    await tell(candidate, copy.CV_RECEIVED);
    return;
  }
  if (GATED.has(docType)) {
    await tell(candidate, copy.CHECKING_DOCUMENT);
    return;
  }

  // Nothing is read from this one, so there is nothing to wait for and nothing
  // to hedge about: it arrived, it is on file, and the next question follows in
  // the same turn. The PAN gets its own line rather than the generic one
  // because "PAN card received" is what the candidate just did.
  await tell(candidate, docType === 'pan' ? copy.PAN_RECEIVED : copy.DOCUMENT_RECEIVED);
  await askNextQuestion(candidate);
}

export interface DocumentOutcome {
  complete: boolean;
  /**
   * What was wrong with the upload, which decides which re-ask is sent.
   * Optional so callers with nothing to report (a skipped extraction) can omit
   * it; absent behaves as the generic "pages missing or unclear" re-ask.
   */
  verdict?: 'ok' | 'pages' | 'unreadable' | 'empty' | 'wrong_document';
  /** Plain-language problems, for the candidate-facing re-ask. */
  problems: string[];
  missingPages?: number[];
  /** On `wrong_document`: which document the upload appears to be, if known. */
  looksLike?: string;
}

/** Records the extraction verdict against the slot. Called by the OCR worker. */
export async function markSlotFromOcr(
  candidateId: ObjectId,
  docType: string,
  status: 'ocr_queued' | 'ocr_done' | 'ocr_failed' | 'needs_review' | 'incomplete',
): Promise<void> {
  const record = await findConversationById(candidateId);
  if (!record) return;

  await recordsFor(record.enquiry).updateOne(
    { _id: candidateId },
    { $set: { [`documents.${docType}.status`]: status, updatedAt: new Date() } },
  );
}

/**
 * Merges what a document yielded into the profile (§5).
 *
 * Everything written here is marked as coming from the document and unverified.
 * §27 is explicit that extracted data is not verified identity information, and
 * `buildProfileWrite` will not let it overwrite anything the candidate typed.
 */
export async function mergeExtractedProfile(
  candidateId: ObjectId,
  patch: Record<string, unknown>,
  source: 'cv' | 'document',
  confidence: number | null,
): Promise<void> {
  const candidate = await findConversationById(candidateId);
  if (!candidate) return;

  candidate.profile ??= {};
  candidate.fieldMeta ??= {};

  const write = buildProfileWrite(candidate, patch, { source, confidence });
  if (!Object.keys(write.set).length) return;

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidateId },
    {
      $set: { ...write.set, updatedAt: new Date() },
      $push: { history: { $each: write.changes } },
    },
  );

  logger.info(
    { waId: candidate.waId, source, fields: Object.keys(patch).length },
    'profile updated from an extracted document',
  );
}

/**
 * Whether this upload is still the one the slot is waiting on.
 *
 * People send the front and the back together, seconds apart. Both land in the
 * slot the bot last asked for, the second superseding the first, and both are
 * read — so two verdicts come back about a slot that now holds only the second
 * file. Acting on the older one talks over the newer, and marks a good upload
 * unreadable because a file it replaced was.
 *
 * The current upload is the one the slot points at. Anything else is history.
 */
function isCurrentUpload(candidate: CandidateDoc, docType: string, uploadId: ObjectId): boolean {
  const current = withMissingSlots(candidate.documents)[docType]?.documentId;
  return !!current && current.equals(uploadId);
}

/**
 * The same question, for the OCR worker, which holds an id rather than a record.
 *
 * Asked once under the candidate lock, before anything an extraction produces is
 * written anywhere — the slot status, the profile, the identity comparison and
 * the reply all belong to the upload the slot is actually waiting on.
 */
export async function uploadStillCurrent(
  candidateId: ObjectId,
  docType: string,
  uploadId: ObjectId,
): Promise<boolean> {
  const candidate = await findConversationById(candidateId);
  return !!candidate && isCurrentUpload(candidate, docType, uploadId);
}

/**
 * Called by the OCR worker once a document has been read.
 *
 * This is what moves the conversation on after a gated upload: an unusable
 * document is sent back with what is wrong (§14), and a good one is
 * acknowledged and followed by the next question.
 *
 * Called on the failure path too, so a candidate is never left waiting on an
 * extraction that never finished.
 */
export async function resumeAfterDocument(
  candidateId: ObjectId,
  docType: string,
  outcome: DocumentOutcome,
  uploadId?: ObjectId,
): Promise<void> {
  const candidate = await findConversationById(candidateId);
  if (!candidate) return;

  candidate.documents = withMissingSlots(candidate.documents);
  candidate.profile ??= {};
  candidate.fieldMeta ??= {};
  candidate.history ??= [];

  // Staff have it, or the record is gone — either way, do not interject.
  if (candidate.stage === 'HUMAN_HANDOFF' || candidate.stage === 'DELETED') return;
  if (!GATED.has(docType)) return;

  if (uploadId && !isCurrentUpload(candidate, docType, uploadId)) {
    logger.info(
      { waId: candidate.waId, docType, uploadId: uploadId.toHexString() },
      'ignored an extraction verdict for an upload that has since been replaced',
    );
    return;
  }

  // A CV is never re-requested for being hard to read. It is a convenience: what
  // it yields skips questions, and what it does not, the flow simply asks (§5).
  //
  // A file that is not a CV at all is a different matter, and it used to be
  // silent: the wrong scan picked out of a gallery went through the resume
  // extractor, yielded nothing, and the slot was marked done while the bot
  // moved on to the next question. The candidate was never told they had sent
  // the wrong file, and the CV they meant to send never arrived.
  if (docType === 'cv') {
    if (outcome.complete) {
      await askNextQuestion(candidate);
      return;
    }

    const slot = candidate.documents.cv!;
    await markSlot(candidate, 'cv', 'incomplete', outcome.problems.join('; '));

    // Asked for twice already — the CV is optional, so stop chasing it and let
    // the flow collect the same details by question instead (§5).
    if (slot.askedCount >= TUNABLES.maxAsksPerDocument) {
      await askNextQuestion(candidate);
      return;
    }

    await askNextQuestion(candidate, await wrongDocumentLead(candidate, 'cv', outcome.looksLike));
    return;
  }

  if (!outcome.complete) {
    const slot = candidate.documents[docType]!;
    await markSlot(candidate, docType, 'incomplete', outcome.problems.join('; '));

    const b2b = candidate.enquiry === 'b2b';
    const ceiling = b2b ? TUNABLES.maxAsksPerB2bDocument : TUNABLES.maxAsksPerDocument;

    if (slot.askedCount >= ceiling) {
      // The B2B branch never walks past a document it could not read — there is
      // no next question worth asking without it — so it stops and fetches a
      // person instead of moving on.
      if (b2b) {
        await tell(candidate, copy.STUCK);
        await handOffToStaff(
          candidate,
          `"${docType}" was still unreadable after ${slot.askedCount} attempts`,
        );
        return;
      }

      // A candidate's is optional: asking a third time for the same unreadable
      // document is worse for them than letting staff sort it out on a call.
      await recordsFor(candidate.enquiry).updateOne(
        { _id: candidateId },
        { $set: { status: 'documents_incomplete' as CandidateStatus, updatedAt: new Date() } },
      );
      await askNextQuestion(candidate);
      return;
    }

    // One message, not two. Sent apart, the explanation and the question it
    // belongs to are two bubbles for one event, and on a phone the question can
    // arrive above the sentence explaining it — which is exactly how "send it
    // again" ended up reading as if the bot had already moved on.
    await askNextQuestion(candidate, await unusableUploadLead(candidate, docType, outcome));
    return;
  }

  const acknowledgement: Record<string, Localised> = {
    passport: copy.PASSPORT_RECEIVED,
    aadhaar: copy.AADHAAR_RECEIVED,
    b2b_aadhaar_front: copy.AADHAAR_RECEIVED,
    b2b_aadhaar_back: copy.AADHAAR_RECEIVED,
  };

  if (acknowledgement[docType]) await tell(candidate, acknowledgement[docType]!);

  // §12 — whether the passport is in date, decided from the page rather than
  // from memory.
  //
  // The flow stopped asking "is it valid?" and "when does it expire?" because a
  // date typed from memory is the least reliable thing on a record: people read
  // the issue date, misremember the year, or type today's. The extractor has
  // just read the real one, `mergeExtractedProfile` has already written it, and
  // this is the first moment the answer is actually known.
  //
  // Said once, and only when there is something to say. An expired booklet and
  // one with a few months left are different messages because they call for
  // different things from the candidate. Neither stops the conversation: the
  // passport is on file, staff can see the flag, and telling someone their
  // renewal is due is not a reason to refuse their registration.
  if (docType === 'passport') await reportPassportValidity(candidate);

  await askNextQuestion(candidate);
}

/**
 * Tells the candidate what the passport extractor read about their expiry date.
 *
 * Marked on the record so it is said once per expiry date rather than once per
 * upload — a candidate who sends a clearer photo of the same expired passport
 * has already been told.
 */
async function reportPassportValidity(candidate: CandidateDoc): Promise<void> {
  const expiry = candidate.profile?.passportExpiry;
  if (!expiry) return;

  const flag = passportExpiryFlag(candidate.profile ?? {});
  if (!flag || (!flag.expired && !flag.expiringSoon)) return;

  if (candidate.profile?.passportExpiryNotifiedFor === expiry) return;

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    { $set: { 'profile.passportExpiryNotifiedFor': expiry, updatedAt: new Date() } },
  );
  candidate.profile.passportExpiryNotifiedFor = expiry;

  await tell(
    candidate,
    flag.expired ? copy.PASSPORT_EXPIRED : copy.PASSPORT_EXPIRING_SOON,
    { expiry },
  );

  await recordAudit({
    waId: candidate.waId,
    candidateId: candidate.candidateId,
    event: flag.expired ? 'passport_expired' : 'passport_expiring_soon',
    detail: `expiry ${expiry} read from the passport`,
  });

  logger.info(
    { waId: candidate.waId, expiry, expired: flag.expired },
    'candidate told what the passport says about its expiry',
  );
}

/** Raised once, when documents disagree about who the candidate is (§17). */
export async function flagIdentityMismatch(
  candidateId: ObjectId,
  differences: string[],
): Promise<void> {
  const candidate = await findConversationById(candidateId);
  if (!candidate || candidate.profile?.identityFlagged) return;

  candidate.documents = withMissingSlots(candidate.documents);
  candidate.profile ??= {};

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidateId },
    {
      $set: {
        'profile.identityFlagged': true,
        status: 'manual_review' as CandidateStatus,
        updatedAt: new Date(),
      },
    },
  );

  logger.warn({ waId: candidate.waId, differences }, 'identity mismatch flagged for staff');

  // §17 forbids running the investigation over WhatsApp, so this says only that
  // someone will be in touch.
  if (candidate.stage !== 'HUMAN_HANDOFF' && candidate.stage !== 'DELETED') {
    await tell(candidate, copy.IDENTITY_MISMATCH);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * §21  The one reminder
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Sends the single permitted reminder to candidates who stopped mid-registration.
 *
 * "Exactly one" is enforced by claiming `reminderSentAt` before sending, not by
 * the schedule — so a restart, a duplicate cron, or a second instance cannot
 * produce a second one.
 */
export async function sendReminders(limit = 50): Promise<number> {
  const cutoff = new Date(Date.now() - TUNABLES.reminderAfterHours * 60 * 60 * 1000);

  // Candidates only. §21's reminder is written for someone part-way through a
  // registration; a business contact has none to be reminded about, and
  // `B2B_PENDING` is deliberately absent from the stages below.
  const stalled = await candidates()
    .find({
      reminderSentAt: { $exists: false },
      lastInboundAt: { $lt: cutoff },
      stage: {
        $in: [
          'CONSENT_PENDING',
          'CV_PENDING',
          'BASIC_DETAILS_PENDING',
          'JOB_PREFERENCE_PENDING',
          'DOCUMENTS_PENDING',
          'CONFIRMATION_PENDING',
        ] as ConversationStage[],
      },
      status: { $nin: ['not_interested', 'consent_withdrawn'] as CandidateStatus[] },
    })
    .limit(limit)
    .toArray();

  let sent = 0;

  for (const candidate of stalled) {
    candidate.documents = withMissingSlots(candidate.documents);
    candidate.profile ??= {};

    // Claimed before sending. If the send then fails the candidate is not
    // reminded — which is the right way round: §21 permits one reminder, not one
    // attempt per restart.
    const claimed = await candidates().updateOne(
      { _id: candidate._id, reminderSentAt: { $exists: false } },
      { $set: { reminderSentAt: new Date(), updatedAt: new Date() } },
    );
    if (!claimed.modifiedCount) continue;

    const insideWindow = (candidate.windowExpiresAt?.getTime() ?? 0) > Date.now();

    try {
      if (insideWindow) {
        await askResume(candidate, copy.REMINDER, copy.REMINDER_CHOICES, MENU.reminder, {
          name: candidate.profile?.fullName ?? candidate.profileName ?? '',
        });
      } else {
        // Outside the window, only an approved template may be sent (§27).
        await sendReengagementTemplate(candidate.phone);
        await appendTurn({
          waId: candidate.waId,
          direction: 'outbound',
          type: 'template',
          text: '[re-engagement template]',
          at: new Date(),
        });
      }

      await recordAudit({
        waId: candidate.waId,
        candidateId: candidate.candidateId,
        event: 'reminder_sent',
        detail: insideWindow ? 'in-window message' : 'approved template',
      });
      sent += 1;
    } catch (err) {
      logger.error({ err, waId: candidate.waId }, 'reminder failed to send');
    }
  }

  if (sent) logger.info({ sent }, 'reminders sent');
  return sent;
}
