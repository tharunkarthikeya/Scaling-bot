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
 *   3. Check the commands that work anywhere: UPDATE, DELETE, or route a typed
 *      staff request to the Other menu.
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
  currentUpload,
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
  ENQUIRY_ID_PREFIX,
  nextEnquiryId,
  type ApplicationStatus,
  type CandidateDoc,
  type CandidateStatus,
  type ConversationStage,
  type DocumentStatus,
  type FieldMeta,
  type UploadOcr,
  type MessageDoc,
  type OcrField,
  type StoredJobQuestion,
} from '../db/models.js';
import { fetchJobQuestions } from '../crm/taxonomy.js';
import {
  downloadMedia,
  send,
  sendReengagementTemplate,
  WhatsAppApiError,
  type Outbound,
} from '../whatsapp/client.js';
import { saveFile } from '../storage/index.js';
import { coalesceKey, queue, withCandidateLock } from '../queue/index.js';
import * as copy from './copy.js';
import {
  sectionFieldsFor,
  sectionStepsFor,
  inferTradeAnswers,
  inferTradePacks,
  activeTradePackIds,
  desiredJobForLevel,
  selectedJobForQuestions,
  MAX_JOB_QUESTIONS,
  nextStep,
  stepById,
  stepsInSection,
  wantsSgMy,
  type Answer,
  type FlowStep,
  type Section,
} from './flow.js';
import {
  aadhaarFullyRead,
  attributeInboundDocument,
  initialSlots,
  withMissingSlots,
} from './checklist.js';
import { extractFromCv, normaliseDate, profileFromIdentityDocument } from './cv.js';
import {
  externalCandidateDeliveryBlocked,
  nationalityBlocked,
  nationalityCheckPending,
  nationalityDecision,
} from './eligibility.js';
import { captureAttachment, ingestionForMessage } from '../ingestion/whatsapp.js';
import { detectGlobalCommand, interpret } from './interpret.js';
import { ModelUnavailableError } from './model.js';
import { answerFromFaq } from './faq.js';
import { explainWrongDocument, respondInContext } from './respond.js';
import {
  acceptedChoices,
  choices as renderChoices,
  listPageTarget,
  message as renderMessage,
  renderRetry,
  renderStep,
} from './render.js';
import { ageFrom, buildProfileWrite, passportExpiryFlag } from './profile.js';
import { detectLanguage, type Choice, type Language, type Localised } from './language.js';
import { DOCUMENTS, requirementFor, TUNABLES } from './rules.js';
import { disambiguationFor, packById, type TradeQuestion } from './trades.js';
import { questionsForOccupation } from './tradeQuestions.js';
import { classifyJobLevel } from './jobLevel.js';
import { activeLineFor, logLineChange } from './lines.js';
import { transcribe } from './audio.js';
import { purgeCandidateData } from '../privacy/purge.js';
import { isSourcingWhatsAppNumber } from '../ats/sourcingGuard.js';

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
  /**
   * The "I have lost my id" lookup (§25), offered after two ids have missed.
   *
   * The tracking check with its halves swapped: a mobile number and a date of
   * birth that between them name an id, instead of an id confirmed by a date.
   */
  forgotMobile: 'ask:forgot_mobile',
  forgotDob: 'ask:forgot_dob',
} as const;

/**
 * Somebody saying they do not have their Application ID, in words (§25).
 *
 * The row is offered after two misses, but a candidate who has just been asked
 * for an id and types "I forgot it" has said the same thing, and reading that
 * as another wrong id would cost them one of the two.
 */
const FORGOT_ID_WORDS =
  /\b(?:forgot|forgotten|lost|don'?t\s+have|do\s+not\s+have|no)\b.{0,20}\b(?:id|number|reference)\b|\bid\b.{0,20}\b(?:forgot|forgotten|lost|missing)\b/i;

/** Suffix marking the free-text follow-up to an "Other" choice. */
const OTHER_SUFFIX = '#other';

/**
 * Documents whose acknowledgement waits for extraction rather than for arrival.
 * §5 wants the CV confirmed immediately but its questions skipped, and §14
 * forbids saying "Passport received" before the upload is known to be usable.
 *
 * Storage-only documents are deliberately absent: no extraction will return to
 * release them, so they are acknowledged on arrival instead.
 */
const GATED = new Set([
  'cv',
  'passport',
  'aadhaar',
]);

/* ─────────────────────────────────────────────────────────────────────────────
 * Candidate lifecycle
 * ───────────────────────────────────────────────────────────────────────────*/

function blankCandidate(params: {
  waId: string;
  phone: string;
  profileName?: string;
  phoneNumberId?: string;
}): CandidateDoc {
  const now = new Date();
  return {
    waId: params.waId,
    phone: params.phone,
    profileName: params.profileName,
    // Which number they wrote to. Only ever read to decide where a reply leaves
    // from: both numbers run the same flow, and which questions this
    // conversation gets is decided later, from the destination it chooses
    // (`routeFor` in `flow.ts`).
    phoneNumberId: params.phoneNumberId,
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
  /** The number it arrived on. It becomes the active outbound line. */
  phoneNumberId?: string;
}): Promise<{ candidate: CandidateDoc; created: boolean; lineChanged: boolean }> {
  // Both stores. A business contact's record has moved out of `candidates`, and
  // looking only there would create a second one for a number already on file.
  const existing = await findConversation(params.waId);

  if (existing) {
    const lineChanged = !!(
      existing.phoneNumberId &&
      params.phoneNumberId &&
      existing.phoneNumberId !== params.phoneNumberId
    );
    if (params.profileName && params.profileName !== existing.profileName) {
      await recordsFor(existing.enquiry).updateOne(
        { _id: existing._id },
        { $set: { profileName: params.profileName, updatedAt: new Date() } },
      );
      existing.profileName = params.profileName;
    }
    // One person remains one record, but the reply must leave from the number
    // they just messaged or it appears in another thread (and may be outside
    // that line's 24-hour customer-service window).
    logLineChange({
      waId: existing.waId,
      recorded: existing.phoneNumberId,
      arrivedOn: params.phoneNumberId,
    });
    const activeLine = activeLineFor(existing.phoneNumberId, params.phoneNumberId);
    if (activeLine !== existing.phoneNumberId) {
      const updatedAt = new Date();
      await recordsFor(existing.enquiry).updateOne(
        { _id: existing._id },
        { $set: { phoneNumberId: activeLine, updatedAt } },
      );
      existing.phoneNumberId = activeLine;
      existing.updatedAt = updatedAt;
    }

    // Backfill for records written before a field or document existed.
    existing.documents = withMissingSlots(existing.documents);
    existing.profile ??= {};
    existing.fieldMeta ??= {};
    existing.history ??= [];
    return { candidate: existing, created: false, lineChanged };
  }

  const doc = blankCandidate(params);

  try {
    const result = await candidates().insertOne(doc);
    doc._id = result.insertedId;
    return { candidate: doc, created: true, lineChanged: false };
  } catch (err) {
    // Lost a race with a concurrent first message. §2 is explicit that a number
    // already on file must never produce a second candidate.
    if ((err as { code?: number }).code === 11000) {
      const raced = await findConversation(params.waId);
      if (raced) {
        raced.documents = withMissingSlots(raced.documents);
        return { candidate: raced, created: false, lineChanged: false };
      }
    }
    throw err;
  }
}

/**
 * Atomically starts one new conversation and sends its welcome once.
 *
 * The per-candidate lock remains the normal ordering boundary, but the claim is
 * deliberately a conditional MongoDB update as well. That makes the invariant
 * survive two workers or instances that both loaded the record while it still
 * said `NEW`: exactly one changes `welcomeTriggeredAt` from missing/null to a
 * date, and only that caller is allowed to send.
 *
 * Returns true only for the winning caller. Losing first-message events have
 * already passed through attachment ingestion before reaching this function;
 * returning false therefore suppresses only the duplicate welcome, not a photo.
 */
export async function initializeConversationOnce(
  candidate: CandidateDoc,
  text: string,
): Promise<boolean> {
  const triggeredAt = new Date();
  const claimed = await recordsFor(candidate.enquiry).updateOne(
    {
      _id: candidate._id,
      stage: 'NEW',
      welcomeTriggeredAt: null,
    },
    { $set: { welcomeTriggeredAt: triggeredAt, updatedAt: triggeredAt } },
  );

  if (claimed.modifiedCount !== 1) return false;

  candidate.welcomeTriggeredAt = triggeredAt;
  candidate.updatedAt = triggeredAt;

  const detected = detectLanguage(text);
  // Only chooses the language of the welcome message; section 3 asks them to
  // confirm on the next turn, so a wrong guess costs nothing.
  if (detected && !candidate.language) await setState(candidate, { language: detected });

  await askNextQuestion(candidate);
  return true;
}

/**
 * Tells the CRM what has just changed, once the answers stop arriving.
 *
 * Called wherever the record actually changes — an answer recorded, a document
 * filed, an extraction merged — rather than at the end of a turn, because a
 * turn has a dozen ways to end early and a hook on one of them syncs some
 * changes and not others.
 *
 * Every call inside one window collapses into a single delivery (`coalesceKey`),
 * so a candidate tapping through six buttons produces one submission carrying
 * all six answers rather than six submissions carrying one each. The window is
 * therefore the CRM's worst-case lag behind the conversation, and nothing else.
 *
 * Nothing here can fail a turn. The enqueue is awaited only far enough to hand
 * the job over; a queue that will not take it is logged and the conversation
 * carries on, because a candidate answering questions must never be held up by
 * a second system's availability.
 */
export async function scheduleCrmSync(candidate: CandidateDoc): Promise<void> {
  if (!config.CRM_PARTIAL_SYNC) return;

  // §4 — nothing personal travels before consent, and the CRM is not an
  // exception to that. Checked here as well as in the worker: the cheapest
  // place to not send something is before it is queued.
  if (!candidate.consent?.given) return;

  // Hold candidate creation until CV/passport OCR can apply the India-only
  // eligibility decision. This also closes the partial-sync upload race.
  if (externalCandidateDeliveryBlocked(candidate)) return;

  // A business contact is not a candidate (§2), and a tracking lookup is not a
  // record. A staff enquiry is neither of those: it is somebody who gave their
  // name, their destination and the job they want so that a person could call
  // them back, and the CRM is where that person works. It syncs through the
  // partial path and is marked `enquiry: 'staff'` on the way (`crm/sync.ts`).
  if (candidate.enquiry === 'b2b' || candidate.enquiry === 'track') return;

  // Once the registration is finished, `completeRegistration` has queued the
  // real handover and its outcome is the one that is recorded. A partial
  // chasing it would race that handover under the same key.
  //
  // Once the handover has actually landed, a later change is not a race any
  // more — it is a document that arrived after the candidate was told they were
  // registered, or an answer they corrected. Those used to stop here and reach
  // the CRM never: `syncModeFor` now calls them an update, and this is the
  // guard that has to let them past to get there.
  if (candidate.stage === 'REGISTRATION_COMPLETED' && candidate.crmSync?.status !== 'synced') {
    return;
  }

  try {
    await queue.enqueue(
      'crm_sync',
      { waId: candidate.waId, partial: true },
      {
        key: coalesceKey(
          'crm_sync',
          candidate.waId,
          config.CRM_PARTIAL_SYNC_DEBOUNCE_MS,
        ),
        delayMs: config.CRM_PARTIAL_SYNC_DEBOUNCE_MS,
      },
    );
  } catch (err) {
    logger.warn({ err, waId: candidate.waId }, 'could not schedule a partial crm sync');
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

/** Removes list navigation state without leaving a BSON null behind. */
async function clearListPage(candidate: CandidateDoc): Promise<void> {
  if (!candidate.listPage) return;
  const now = new Date();
  delete candidate.listPage;
  candidate.updatedAt = now;
  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    { $unset: { listPage: '' }, $set: { updatedAt: now } },
  );
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
    // From the number this conversation belongs to. Sending from the other one
    // puts the reply in a thread the candidate never opened, under a number
    // whose 24-hour window they never opened either.
    const results = await send(candidate.phone, { ...outbound, body }, candidate.phoneNumberId);
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
  /**
   * The destination, which is asked first now — straight after consent, because
   * it decides which route the conversation takes (§10).
   *
   * It was `JOB_PREFERENCE_PENDING` while it sat among the preferences. Left
   * there it would report a candidate who has answered one question as being at
   * the job preferences, and then walk the stage *backwards* through
   * `CV_PENDING` and `BASIC_DETAILS_PENDING` as the rest of registration
   * happened — visible on every CRM screen and in every mid-registration sync.
   *
   * `CV_PENDING` is where this question actually falls: consent given,
   * registration under way, the CV the next thing to come. The stage names a
   * phase rather than a question, and `statusForStage` reads this one as
   * `registration_started`, which is exactly what such a candidate is.
   */
  country: 'CV_PENDING',
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
 * The stage a question puts the conversation in.
 *
 * `STAGE_BY_SECTION` with one exception, and the exception is the staff
 * intake's country question. That flow has no CV in it at all, so `CV_PENDING`
 * on an enquiry that will never be asked for one would read, on a CRM screen,
 * as a document being chased from somebody nobody has asked.
 */
function stageForStep(candidate: CandidateDoc, section: Section): ConversationStage {
  if (candidate.enquiry === 'staff' && section === 'country') return 'BASIC_DETAILS_PENDING';
  return STAGE_BY_SECTION[section];
}

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
    case 'B2B_COMPLETED':
      return 'manual_review';
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
 * Runs once per candidate per selected job, and only where the packs came up
 * empty — a welder, a fabricator, a driver, a machinist and an NDT technician
 * all keep the questions a person wrote for them. Everyone else used to be
 * asked nothing at all about that job: a recruiter opening an electrician's
 * profile learned that he was an electrician and nothing further.
 *
 * The result is stored either way, empty included. An empty list is an answer —
 * "there is nothing useful to ask about this selected job" — and
 * storing it is what stops a model call on every turn for the rest of the
 * registration.
 */
async function ensureTradeQuestions(candidate: CandidateDoc): Promise<void> {
  // Nobody in the staff intake is asked specialist questions, so there is nothing to
  // write questions about.
  if (candidate.enquiry === 'staff') return;

  const profile = candidate.profile ?? {};

  const jobId = profile.jobCategory as string | undefined;
  if (!jobId) return;
  if (activeTradePackIds(candidate).length) return;
  if (disambiguationFor(jobId)) return;
  // Always use the job being applied for. The candidate's current occupation
  // may be unrelated and is never the subject of generated follow-ups.
  const occupation = selectedJobForQuestions(candidate);
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
 * Reads the screening questions an admin attached to the job this candidate
 * chose, and stores them so the flow can ask them.
 *
 * The counterpart of `ensureTradeQuestions`, and it runs in the same place for
 * the same reason: the scheduler is a synchronous walk over stored state, so
 * anything a step's guard needs has to be on the record before it is consulted.
 * The questions live in the CRM's `job_questions` table, which the bot reaches
 * over HTTP — that read cannot happen inside `nextStep`.
 *
 * Stored rather than read per turn, which is what makes an admin's edit safe.
 * A question reworded, reordered or retired half way through one candidate's
 * registration changes nothing they are being asked and nothing their answers
 * are filed against; the next candidate gets the new set. The CRM keeps its own
 * copy of the text for exactly this reason, and this is the other half of it.
 *
 * Once per candidate per job. An empty list is stored like any other answer —
 * "this job has no screening questions" — and that stored pair is what stops a
 * request on every turn for the rest of the registration.
 */
async function ensureJobQuestions(candidate: CandidateDoc): Promise<void> {
  // The staff intake is nine questions somebody already asked to be called
  // about (§24). It has no trade questions for the same reason.
  if (candidate.enquiry === 'staff') return;

  const profile = candidate.profile ?? {};
  const jobId = profile.jobCategory as string | undefined;

  // Nothing chosen yet, or a job that is not one of the CRM's — "Other" is the
  // row for a job the agency has no designation for, so there is nothing for a
  // client to have attached questions to.
  if (!jobId || jobId === 'other') return;
  if (profile.jobQuestionsFor === jobId) return;

  const questions = await fetchJobQuestions(jobId);

  // The CRM could not be asked. Writing what comes next would store an empty
  // list *and* the job it was fetched for, and that pair is what stops this ever
  // running again — so a two-second outage would record "this job has no
  // questions" for this candidate permanently. Leave it unset and try next turn.
  if (!questions) {
    logger.warn({ waId: candidate.waId, jobId }, 'job questions deferred: the CRM did not answer');
    return;
  }

  const askedAt = new Date().toISOString();
  const stored: StoredJobQuestion[] = questions.slice(0, MAX_JOB_QUESTIONS).map((question) => ({
    id: question.id,
    jobId,
    question: question.text,
    kind: question.kind,
    choices: question.choices,
    required: question.required,
    askedAt,
  }));

  if (questions.length > MAX_JOB_QUESTIONS) {
    logger.warn(
      { jobId, attached: questions.length, asked: MAX_JOB_QUESTIONS },
      'more screening questions on this job than the flow will ask; the rest are not put to candidates',
    );
  }

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    {
      $set: {
        'profile.jobQuestions': stored,
        'profile.jobQuestionsFor': jobId,
        updatedAt: new Date(),
      },
    },
  );
  candidate.profile.jobQuestions = stored;
  candidate.profile.jobQuestionsFor = jobId;

  if (stored.length) {
    logger.info(
      { waId: candidate.waId, jobId, questions: stored.length },
      'screening questions loaded for the job this candidate chose',
    );
  }
}

/**
 * Works out how much a CV would add for the job this candidate wants (§5).
 *
 * Only for a candidate bound for Singapore or Malaysia, where it decides one
 * thing: whether the CV step is asked at all. For every other destination it
 * does nothing, because there the CV is asked of everyone — and asked before
 * this could run — so there is nothing to decide.
 *
 * Runs before `nextStep`, for the same reason `ensureTradeQuestions` does: the
 * scheduler is a synchronous walk over stored state, so anything a step's guard
 * needs has to be on the record by the time it is consulted.
 *
 * Computed once and stored. Recomputing per turn would spend a model call on
 * every message and could change its mind mid-conversation, which on this route
 * means a CV question that appears and disappears. It is recomputed only when
 * the job it was computed for changes — an edit of the job preferences, which
 * clears `desiredOccupation` and friends, produces a different job here and a
 * fresh classification.
 */
async function ensureJobLevel(candidate: CandidateDoc): Promise<void> {
  // Read from the destination they chose, not from the number they wrote to.
  // A candidate who edits §10 away from Singapore or Malaysia (§22) stops
  // being one of these on the same turn, and is asked for a CV like anybody
  // else — the level stays on the record and nothing reads it.
  if (!wantsSgMy(candidate)) return;
  if (candidate.enquiry === 'b2b' || candidate.enquiry === 'staff') return;

  const job = desiredJobForLevel(candidate);
  // Nothing to classify yet — the job preferences are still ahead of us. The
  // CV step sits behind them in this flow, so it cannot be reached first.
  if (!job) return;
  if (candidate.profile?.jobLevelFor === job) return;

  let level;
  try {
    level = await classifyJobLevel({ job });
  } catch (err) {
    // Unreachable, not undecided. Writing `unknown` here would store it beside
    // the job it was computed for, and the pair is what stops this running
    // again — so a two-second outage would settle the question permanently on
    // a non-answer. Left unset, which asks for the CV, and retried next turn.
    if (err instanceof ModelUnavailableError) {
      logger.warn(
        { waId: candidate.waId, job },
        'job level deferred: the model was unavailable, nothing recorded',
      );
      return;
    }
    throw err;
  }

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    {
      $set: {
        'profile.jobLevel': level,
        'profile.jobLevelFor': job,
        updatedAt: new Date(),
      },
    },
  );
  candidate.profile.jobLevel = level;
  candidate.profile.jobLevelFor = job;

  logger.info(
    { waId: candidate.waId, job, level, cvAsked: level !== 'low_skill' },
    'job level recorded for the Singapore/Malaysia CV question',
  );
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
  // If the selected job and supporting evidence decide its specialist questions,
  // record that now so the disambiguation question is skipped entirely (§8).
  const packs = inferTradePacks(candidate);
  if (packs) {
    const jobId = candidate.profile.jobCategory as string;
    await recordsFor(candidate.enquiry).updateOne(
      { _id: candidate._id },
      {
        $set: {
          'profile.tradePacks': packs,
          'profile.tradePacksFor': jobId,
          updatedAt: new Date(),
        },
      },
    );
    candidate.profile.tradePacks = packs;
    candidate.profile.tradePacksFor = jobId;
  }

  await ensureTradeQuestions(candidate);

  // And the questions an admin attached to the job they picked, which are read
  // from the CRM rather than written here.
  await ensureJobQuestions(candidate);

  // Whether this candidate is asked for a CV at all, on the route where that is
  // a question. A no-op for every other destination.
  await ensureJobLevel(candidate);

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
    if (candidate.enquiry === 'staff') {
      await completeStaffEnquiry(candidate);
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

  // A list page belongs only to the open taxonomy question. Once the flow has
  // moved on it must not affect a later edit or a fresh registration pass.
  if (candidate.listPage && candidate.listPage.step !== step.id) {
    await clearListPage(candidate);
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
    const stage = stageForStep(candidate, step.section);
    patch.stage = stage;
    patch.status = statusForStage(stage, candidate.status);
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
 * §24. The only function allowed to pause automation for staff. It is called
 * only after the intake reached through Other → Talk to staff is complete.
 */
async function completeRequestedStaffHandoff(
  candidate: CandidateDoc,
  reason: string,
): Promise<void> {
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
 * Closes it: everything asked for is in and CRM review can begin.
 *
 * Not `completeRegistration` — a business contact has no application, so there
 * is no Application ID to issue and nothing for §25 tracking to read. What they
 * They receive a neutral submission confirmation. Approval and Sourcing Hub
 * export remain CRM actions; this does not pause their chat for staff.
 */
async function completeB2bEnquiry(candidate: CandidateDoc): Promise<void> {
  if (candidate.stage === 'B2B_COMPLETED') {
    await tell(candidate, copy.B2B_ALREADY_SUBMITTED);
    return;
  }
  const completedAt = candidate.completedAt ?? new Date();
  await setState(candidate, {
    stage: 'B2B_COMPLETED',
    completedAt,
    status: 'manual_review',
    b2bReview: candidate.b2bReview ?? { status: 'pending', submittedAt: completedAt },
    currentStep: undefined,
    sessionEndedAt: completedAt,
  });
  await recordAudit({ waId: candidate.waId, event: 'b2b_enquiry_completed' });
  await tell(candidate, copy.B2B_COMPLETE);

  // The completed row is now visible in the CRM B2B review endpoint. Sourcing
  // export is deliberately not queued here: only CRM approval may do that.
  await closeOpenSession(candidate.waId);
  logger.info({ waId: candidate.waId }, 'b2b enquiry collected for CRM review');
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

/**
 * Releases handoffs created by versions that automatically paused on unrelated
 * answers, job-opening questions, B2B completion, eligibility checks, or typed
 * staff phrases. A completed staff enquiry is the one historical handoff that
 * came through the intended intake, so it remains paused until CRM returns it.
 */
async function releaseLegacyAutomaticHandoff(candidate: CandidateDoc): Promise<boolean> {
  if (candidate.stage !== 'HUMAN_HANDOFF') return false;
  if (candidate.enquiry === 'staff' && candidate.completedAt) return false;

  const now = new Date();
  const stage: ConversationStage = candidate.ageFlagged
    ? 'NOT_ELIGIBLE'
    : candidate.enquiry === 'b2b' && candidate.completedAt
      ? 'B2B_COMPLETED'
      : candidate.completedAt
        ? 'REGISTRATION_COMPLETED'
        : candidate.enquiry === 'b2b'
          ? 'B2B_PENDING'
          : 'BASIC_DETAILS_PENDING';

  await setState(candidate, {
    stage,
    status: stage === 'NOT_ELIGIBLE' ? 'not_eligible' : statusForStage(stage, candidate.status),
    humanHandoff: candidate.humanHandoff
      ? { ...candidate.humanHandoff, returnedAt: now }
      : undefined,
    unclearCount: 0,
  });
  await recordAudit({
    waId: candidate.waId,
    candidateId: candidate.candidateId,
    event: 'handoff_returned',
    detail: 'legacy automatic handoff released by the explicit-Other-only rule',
  });
  logger.info(
    { waId: candidate.waId, oldReason: candidate.humanHandoff?.reason, stage },
    'legacy automatic staff handoff released',
  );
  return true;
}

async function completeRegistration(candidate: CandidateDoc): Promise<void> {
  // A queued CV/passport satisfies its document slot, but nationality has not
  // been decided yet. OCR completion resumes the flow.
  if (nationalityCheckPending(candidate) || nationalityBlocked(candidate)) return;

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

  // And into the ATS database, which is a copy rather than a handover: the
  // record stays here, and `resume_ats` is what a recruiter reads.
  await queue.enqueue('ats_export', { waId: candidate.waId });
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
  const compact = typed.replace(/\s+/g, '');
  const digits = /(\d{1,10})/.exec(compact);
  if (!digits) return undefined;

  // The prefix they typed, where they typed one. A staff enquiry's reference is
  // `ENQ-00007` and rebuilding it as `ADR-00007` would look up a different
  // record — or somebody else's — from the same digits.
  const prefix = new RegExp(`^${ENQUIRY_ID_PREFIX}`, 'i').test(compact)
    ? ENQUIRY_ID_PREFIX
    : CANDIDATE_ID_PREFIX;

  return `${prefix}-${digits[1]!.padStart(CANDIDATE_ID_DIGITS, '0')}`;
}

/**
 * Both readings of a bare number, for the lookup.
 *
 * "42" at the tracking question is an application id with the prefix left off,
 * and there are two series it could belong to. Trying both is what stops
 * somebody with `ENQ-00042` being told their own reference does not exist —
 * still scoped to the number that sent it, so it widens nothing.
 */
function applicationIdsToTry(typed: string): string[] {
  const normalised = normaliseApplicationId(typed);
  if (!normalised) return [];

  const compact = typed.replace(/\s+/g, '');
  const typedAPrefix = new RegExp(`^(${CANDIDATE_ID_PREFIX}|${ENQUIRY_ID_PREFIX})`, 'i').test(
    compact,
  );
  if (typedAPrefix) return [normalised];

  const digits = normalised.slice(normalised.indexOf('-') + 1);
  return [`${CANDIDATE_ID_PREFIX}-${digits}`, `${ENQUIRY_ID_PREFIX}-${digits}`];
}

/**
 * Whether a message is someone quoting their application id at us.
 *
 * The prefix is required. A bare number is how candidates pick an option from a
 * list — "2" means the second row — and treating that as an application id
 * would hijack every numbered answer in the flow.
 */
const APPLICATION_ID_PATTERN = new RegExp(
  `\\b(?:${CANDIDATE_ID_PREFIX}|${ENQUIRY_ID_PREFIX})[\\s-]?\\d{1,10}\\b`,
  'i',
);

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
  const ids = applicationIdsToTry(typed);
  const record = ids.length
    ? // Only ever a candidate: a business enquiry has no Application ID to quote.
      await candidates().findOne({ candidateId: { $in: ids }, waId: candidate.waId })
    : null;

  if (record) {
    // A record with no date of birth cannot be checked, and a check that cannot
    // be performed is not a check that passed. Staff take it from here.
    if (!record.profile?.dateOfBirth) {
      logger.warn(
        { waId: candidate.waId, candidateId: record.candidateId },
        'tracking blocked: no date of birth on the application to verify against',
      );
      // No option attached: the staff row is gone from everywhere but the
      // opening menu. The id question stays open, so another id can be tried.
      await tell(candidate, copy.TRACK_CANNOT_VERIFY);
      await setState(candidate, { currentStep: MENU.trackId, tracking: undefined });
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

  // A miss. Two of them are a typo; the third is somebody who does not have
  // their id, and that is when the lookup is worth offering (§25).
  const idAttempts = (candidate.tracking?.idAttempts ?? 0) + 1;
  const tracking = {
    ...(candidate.tracking ?? { attempts: 0, startedAt: new Date() }),
    idAttempts,
  };

  if (idAttempts >= TUNABLES.maxTrackingIdAttempts) {
    await ask(candidate, copy.TRACK_NOT_FOUND_FORGOT, [copy.CHOICE_FORGOT_ID], MENU.trackId);
    await setState(candidate, { tracking });
    return;
  }

  await tell(candidate, copy.TRACK_NOT_FOUND);
  await setState(candidate, { currentStep: MENU.trackId, tracking });
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
  if (!tracking?.candidateId) {
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
    await setState(candidate, { tracking: undefined, currentStep: MENU.trackId });
    await tell(candidate, copy.TRACK_DOB_EXHAUSTED);
    return;
  }

  await setState(candidate, {
    tracking: { ...tracking, attempts },
    currentStep: MENU.trackDob,
  });
  await tell(candidate, copy.TRACK_DOB_WRONG, { remaining: String(remaining) });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * §24  The staff intake
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * "Other → Talk to staff", which no longer hands over on the spot.
 *
 * The intake questions in `STAFF_STEPS` run first, so the member of staff who
 * picks the conversation up has a name, a destination and the requested documents
 * rather than a phone number. `nextStep` switches lists on `enquiry`, exactly
 * as it does for a business contact, so nothing below has to know which branch
 * it is on.
 *
 * The record stays in `candidates`: this is a person, their Aadhaar and their
 * passport, and `documentCollectionFor` files those uploads where every other
 * candidate's go. Only the B2B branch is filed apart, and only because a
 * business contact is not a person applying for anything.
 */
async function startStaffEnquiry(candidate: CandidateDoc): Promise<void> {
  await setState(candidate, { enquiry: 'staff', currentStep: undefined, unclearCount: 0 });
  await recordAudit({
    waId: candidate.waId,
    event: 'staff_enquiry_started',
    detail: 'asked to speak to a person; collecting details first',
  });

  await tell(candidate, copy.STAFF_INTAKE_START);
  await askNextQuestion(candidate);
}

/**
 * The end of the intake: a reference number, a promise of a call, and a person.
 *
 * The id is an `ENQ`, not an `ADR`. They have not registered for work and a
 * recruiter opening an ADR expects somebody who has — but they have given us
 * their documents and they need something to quote when they ring back, which
 * is what a reference number is for.
 *
 * `application` is seeded `pending` for the same reason it is on a finished
 * registration: it is the field staff record an outcome in, and the bot never
 * writes another value into it (§26, §27).
 *
 * Nothing is sent to the CRM. That is for candidates, and this is a call-back
 * request.
 */
async function completeStaffEnquiry(candidate: CandidateDoc): Promise<void> {
  const enquiryId = candidate.candidateId ?? (await nextEnquiryId());
  const now = new Date();

  await setState(candidate, {
    candidateId: enquiryId,
    application: candidate.application ?? { status: 'pending', updatedAt: now },
    completedAt: candidate.completedAt ?? now,
    currentStep: undefined,
    editQueue: [],
    unclearCount: 0,
    sessionEndedAt: now,
  });

  await tell(candidate, copy.STAFF_INTAKE_COMPLETE, { enquiryId });
  await closeOpenSession(candidate.waId);
  await recordAudit({
    waId: candidate.waId,
    candidateId: enquiryId,
    event: 'staff_enquiry_completed',
  });
  logger.info({ waId: candidate.waId, enquiryId }, 'staff enquiry collected; handing over');

  // Filed with the candidates, as asked: they gave the same name and the same
  // documents, and a recruiter opening the record should not have to know which
  // menu brought them in. Enqueued before the handover, so the export does not
  // depend on staff doing anything.
  await queue.enqueue('ats_export', { waId: candidate.waId });

  // And into the CRM, where whoever picks this up actually works. The last
  // answer already scheduled one of these and this coalesces with it, which is
  // the point: what goes out is the finished intake, carrying the enquiry id
  // this function has just minted rather than the state before it.
  //
  // Not `completeRegistration`'s handover, and deliberately so. There is no
  // registration here to complete, no CV policy to satisfy and no Application
  // ID — the record says `enquiry: 'staff'`, `complete: false`, and
  // `assignable: true`, which is the whole truth about it.
  await scheduleCrmSync(candidate);

  await completeRequestedStaffHandoff(
    candidate,
    'Other → Talk to staff intake: details and documents collected',
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * §25  "I have lost my Application ID"
 * ───────────────────────────────────────────────────────────────────────────*/

/** Opens the lookup. Offered once two ids have missed, never before. */
async function startForgotIdLookup(candidate: CandidateDoc): Promise<void> {
  await tell(candidate, copy.TRACK_FORGOT_ASK_MOBILE);
  await setState(candidate, {
    currentStep: MENU.forgotMobile,
    tracking: {
      ...(candidate.tracking ?? { attempts: 0, startedAt: new Date() }),
      forgotMobile: undefined,
    },
  });
}

/** Holds the mobile number and asks for the date that has to go with it. */
async function receiveForgotMobile(candidate: CandidateDoc, typed: string): Promise<void> {
  const digits = typed.replace(/\D/g, '');

  // Not a number at all. Costs no attempt — the attempts exist to bound
  // guessing at a date of birth, and this is somebody mistyping a phone number.
  if (digits.length < 6) {
    await tell(candidate, copy.TRACK_FORGOT_ASK_MOBILE);
    return;
  }

  await setState(candidate, {
    currentStep: MENU.forgotDob,
    tracking: {
      ...(candidate.tracking ?? { attempts: 0, startedAt: new Date() }),
      forgotMobile: digits,
    },
  });
  await tell(candidate, copy.TRACK_FORGOT_ASK_DOB);
}

/**
 * Matches a mobile number and a date of birth against this number's records.
 *
 * Scoped to `waId` like every other read in the tracking flow, and for the same
 * reason: an id is short and sequential, and a lookup that answered for any
 * number would hand one person's reference — and the fact that their record
 * exists — to anybody who guessed a phone number (§27).
 *
 * Which means the mobile number is a second factor rather than the search key.
 * It is checked against the number they are messaging from and against the one
 * recorded on the profile, because a candidate whose CV gave a different number
 * has both on file and may quote either.
 */
async function verifyForgotIdentity(candidate: CandidateDoc, typed: string): Promise<void> {
  const tracking = candidate.tracking;
  const mobile = tracking?.forgotMobile;
  if (!mobile) {
    // The lookup was cleared underneath us — a restart, a deletion, a takeover.
    await startForgotIdLookup(candidate);
    return;
  }

  const supplied = normaliseDate(typed);
  if (!supplied) {
    await tell(candidate, copy.TRACK_DOB_UNREADABLE);
    return;
  }

  const record = await candidates().findOne({
    waId: candidate.waId,
    candidateId: { $exists: true },
  });

  const last = (value: string | undefined): string => (value ?? '').replace(/\D/g, '').slice(-10);
  const mobileMatches =
    !!record &&
    [record.profile?.mobileNumber, record.phone, record.waId].some(
      (known) => last(known) && last(known) === last(mobile),
    );
  const onFile = record?.profile?.dateOfBirth ? normaliseDate(record.profile.dateOfBirth) : undefined;

  if (record?.candidateId && mobileMatches && onFile && onFile === supplied) {
    await setState(candidate, { tracking: undefined, currentStep: undefined });
    await tell(candidate, copy.TRACK_FORGOT_FOUND, { candidateId: record.candidateId });
    logger.info(
      { waId: candidate.waId, candidateId: record.candidateId },
      'application id returned after a successful mobile and date-of-birth check',
    );
    return;
  }

  const attempts = (tracking?.forgotAttempts ?? 0) + 1;
  const remaining = TUNABLES.maxTrackingDobAttempts - attempts;

  if (remaining <= 0) {
    logger.warn(
      { waId: candidate.waId, attempts },
      'forgotten-id lookup exhausted; nothing released',
    );
    await setState(candidate, { tracking: undefined, currentStep: undefined });
    await tell(candidate, copy.TRACK_DOB_EXHAUSTED);
    return;
  }

  // Back to the start of the pair. A date that did not match may have been the
  // wrong date or the wrong number, and there is no way to tell which, so both
  // are asked again — leaving `currentStep` on the date would have their next
  // message read as a second date against a number already known to be wrong.
  await setState(candidate, {
    tracking: { ...(tracking ?? { attempts: 0, startedAt: new Date() }), forgotAttempts: attempts },
  });
  await tell(candidate, copy.TRACK_FORGOT_NO_MATCH, { remaining: String(remaining) });
  await startForgotIdLookup(candidate);
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
      // The message it arrived on. Carried so the OCR job can build its
      // idempotency key and find the ingestion row without a scan.
      wamid,
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

  // The file is on disk and filed, so the CRM can be told about it now rather
  // than after extraction. A recruiter seeing "CV received" while Veris is
  // still reading it is the truth; waiting for the read would hide the arrival
  // for as long as the queue is deep.
  await scheduleCrmSync(candidate);

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
    media = await downloadMedia(msg.mediaId, undefined, candidate.phoneNumberId);
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

  await scheduleCrmSync(candidate);
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
  await scheduleCrmSync(candidate);
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
        const cv = withMissingSlots(candidate.documents).cv;
        // An old interactive button can still be tapped after a CV has already
        // arrived. Treat the stored upload as authoritative: never tell the
        // candidate to attach the same file again.
        if (cv?.documentId) {
          if (cv.status === 'ocr_queued') await tell(candidate, copy.CV_RECEIVED);
          else await askNextQuestion(candidate);
          return true;
        }
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

    case 'confirm':
      if (chosen === 'correct') {
        // The same question ends two different things. A staff enquiry has no
        // registration to complete and nothing to hand to the CRM.
        if (candidate.enquiry === 'staff') {
          await completeStaffEnquiry(candidate);
          return true;
        }
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

  // The candidate's own words for a trade no option covered — which is the
  // most specific thing on their profile, and would otherwise be the one
  // answer that never reached the CRM, because this is the only place that
  // writes it.
  await scheduleCrmSync(candidate);
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
  // This conversation's questions — its route and its branch. The staff
  // intake's `personal` section is one question where registration's is five,
  // and its `country` section is one where registration's is three. Resolving
  // by anything less would clear an answer this conversation never gave and
  // then queue the question that gave it.
  const steps = sectionStepsFor(candidate, section);

  if (!steps.length) {
    // Nothing in this section belongs to this conversation. Offered by a fixed
    // menu that does not know which branch it is on; the honest answer is to go
    // back to what was on screen rather than to clear nothing and say nothing.
    logger.info(
      { waId: candidate.waId, section, enquiry: candidate.enquiry },
      'edit asked for a section this conversation does not have',
    );
    await askNextQuestion(candidate);
    return;
  }

  const unset: Record<string, ''> = {};
  for (const field of sectionFieldsFor(candidate, section)) {
    unset[`profile.${field}`] = '';
    delete candidate.profile[field];
  }

  if (Object.keys(unset).length) {
    await recordsFor(candidate.enquiry).updateOne({ _id: candidate._id }, { $unset: unset });
  }

  await setState(candidate, {
    editQueue: steps.map((s) => s.id),
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
    // "Other" (§2). This is the only menu that can start a staff intake.
    case MENU.other:
      if (choiceId === 'b2b') {
        await startB2bEnquiry(candidate);
        return;
      }
      if (choiceId === 'staff') await startStaffEnquiry(candidate);
      else await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
      return;

    case MENU.returning:
      switch (choiceId) {
        case 'track':
          await startTracking(candidate);
          return;
        case 'check_jobs':
          await tell(candidate, copy.JOBS_ANSWER);
          await showReturningMenu(candidate);
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
      // Compatibility for a yes/no jobs prompt sent by an older deployment.
      // Neither answer may initiate a handoff now.
      await showReturningMenu(candidate);
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
  'listPage',
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
 *   listPage     a page of display options, not an answer
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
    listPage: undefined,
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
    //
    // Caught per candidate, because the lock can now refuse. It is a Redis key
    // rather than a local map, so a candidate mid-turn on another instance
    // holds it and `withCandidateLock` throws once it has waited its timeout
    // out. Letting that propagate would abandon the rest of this sweep over one
    // busy candidate — and the one thing a candidate who is actively messaging
    // does not need is to be told their session went idle. Skipping them is
    // both the safe answer and the correct one; the next tick will find them if
    // they really did go quiet.
    try {
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
    } catch (err) {
      logger.warn(
        { err, waId: row.waId },
        'skipped a candidate in the idle-session sweep: their lock was held elsewhere',
      );
    }
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
  /** Which of the agency's numbers it arrived on (`conversation/lines.ts`). */
  phoneNumberId?: string;
}): Promise<void> {
  const msg = await findTurn(payload.wamid, 'inbound');
  if (!msg) {
    logger.warn({ wamid: payload.wamid }, 'inbound job for unknown message');
    return;
  }

  // The webhook performs this before it stores or queues anything. Keep the
  // same guard here for jobs that were already queued when a number was added
  // to Sourcing Hub, or when a deployment changed underneath the queue.
  if (await isSourcingWhatsAppNumber(payload.waId)) {
    logger.info(
      { waId: payload.waId, wamid: payload.wamid },
      'queued sourcing contact inbound ignored before bot workflow',
    );
    return;
  }

  const { candidate, created, lineChanged } = await getOrCreateCandidate({
    waId: payload.waId,
    phone: msg.waId,
    profileName: payload.profileName,
    phoneNumberId: payload.phoneNumberId,
  });

  // Read before it is overwritten: the gap since their last message is what
  // decides whether the session they were in is still open.
  const previousInboundAt = candidate.lastInboundAt;

  const now = new Date();
  await setState(candidate, {
    lastInboundAt: now,
    windowExpiresAt: new Date(now.getTime() + WINDOW_MS),
  });

  // §24 — only an explicitly requested staff intake may keep automation paused.
  if (candidate.stage === 'HUMAN_HANDOFF') {
    const released = await releaseLegacyAutomaticHandoff(candidate);
    if (!released) {
      logger.info({ waId: candidate.waId }, 'inbound left for staff: the bot is paused');
      return;
    }
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
      // A deleted record starts a new conversation. Null is intentional: the
      // atomic welcome filter treats missing/null as unclaimed.
      welcomeTriggeredAt: null,
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
  } else if (
    candidate.stage !== 'NOT_ELIGIBLE' &&
    msg.mediaId &&
    ['image', 'document', 'video'].includes(msg.type)
  ) {
    ingested = await ingestDocument(candidate, msg);
  }

  /* ---- the opening turn (§2) ---- */

  if (created || candidate.stage === 'NEW') {
    await initializeConversationOnce(candidate, text);
    return;
  }

  /* ---- reject buttons from a question that has already closed ---- */

  // WhatsApp keeps old interactive messages tappable in chat history. Meta
  // includes the id of the outbound message a tap belongs to, so compare that
  // message's step with the one currently open before interpreting the option
  // (and before global button commands). A second tap is a strict no-op: the
  // first answer remains authoritative and the late tap cannot produce another
  // question, warning bubble, command, or profile write.
  if (msg.replyId && msg.contextWamid) {
    const asked = await findTurn(msg.contextWamid, 'outbound');
    if (asked?.step && asked.step !== candidate.currentStep) {
      logger.info(
        {
          waId: candidate.waId,
          tapped: msg.replyId,
          from: asked.step,
          now: candidate.currentStep,
        },
        'ignored a tap on a closed question',
      );
      return;
    }
  }

  /* ---- commands that work anywhere (§22, §23, §24) ---- */

  const command = detectGlobalCommand(text, msg.replyId);

  if (command === 'delete') {
    await ask(candidate, copy.DELETE_CONFIRM, copy.DELETE_CHOICES, MENU.delete);
    return;
  }
  // India-only eligibility is terminal. The deletion menu remains available
  // for privacy, but registration, updates, handoff and new file storage stop.
  if (candidate.stage === 'NOT_ELIGIBLE') {
    if (candidate.currentStep === MENU.delete) {
      const menu = pseudoStep(MENU.delete);
      const options = MENU_CHOICES[MENU.delete] ?? [];
      const interpretation = await interpret({
        step: menu,
        choices: options,
        text,
        replyId: msg.replyId,
      });
      if (interpretation.kind === 'matched') {
        await handleMenuAnswer(candidate, MENU.delete, interpretation.ids[0]!);
      } else {
        await ask(candidate, copy.DELETE_CONFIRM, copy.DELETE_CHOICES, MENU.delete);
      }
    } else {
      logger.info({ waId: candidate.waId }, 'inbound ignored: candidate is not eligible');
    }
    return;
  }
  if (command === 'staff') {
    // Typing a request is not itself a handoff. The user must select the one
    // current staff option, which exists only inside Other.
    await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
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

  /* ---- the candidate moved to another bot number ---- */

  // Progress belongs to the candidate, not to one of the agency's sending
  // numbers. Moving to another number therefore keeps every saved answer but
  // never treats the first message in the new chat as an answer to the old
  // chat's open question. Offer the choice explicitly, even when the old
  // session has not timed out. `getOrCreateCandidate` has already changed the
  // active sending identity, so this prompt leaves from the number they just
  // messaged rather than appearing back in the previous thread.
  if (lineChanged && RESUMABLE_STAGES.has(candidate.stage)) {
    const name = candidate.profile?.fullName ?? candidate.profileName ?? '';
    await askResume(candidate, copy.RESUME_PROMPT, copy.RESUME_CHOICES, MENU.resume, {
      name: name ? `, ${name}` : '',
    });
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
    // The row offered after two misses. Checked before the text below, because
    // a tap arrives carrying its title, and "Forgot my ID" is not an id.
    if (msg.replyId === copy.CHOICE_FORGOT_ID.id || FORGOT_ID_WORDS.test(text)) {
      await startForgotIdLookup(candidate);
      return;
    }
    if (!text.trim()) {
      await tell(candidate, voiceNoteUnread ? copy.VOICE_NOT_UNDERSTOOD : copy.TRACK_ASK_ID);
      return;
    }
    await lookUpApplication(candidate, text.trim());
    return;
  }

  if (current === MENU.forgotMobile) {
    if (!text.trim()) {
      await tell(
        candidate,
        voiceNoteUnread ? copy.VOICE_NOT_UNDERSTOOD : copy.TRACK_FORGOT_ASK_MOBILE,
      );
      return;
    }
    await receiveForgotMobile(candidate, text.trim());
    return;
  }

  if (current === MENU.forgotDob) {
    if (!text.trim()) {
      await tell(
        candidate,
        voiceNoteUnread ? copy.VOICE_NOT_UNDERSTOOD : copy.TRACK_FORGOT_ASK_DOB,
      );
      return;
    }
    await verifyForgotIdentity(candidate, text.trim());
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
      await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
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
        await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
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
        await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
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

  // A deployed flow change or a corrected job can leave `currentStep` pointing
  // at a specialist question that no longer applies. Never accept an answer to
  // it; resume from the first currently valid question instead.
  if (step.when && !step.when(candidate)) {
    logger.info(
      { waId: candidate.waId, step: step.id },
      'skipped an open question that no longer applies',
    );
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
    // A repeated tap is deliberately silent. WhatsApp cannot disable a button
    // already in chat history, but the backend can make it inert; replying here
    // used to make one late tap send the next question a second time. Typed
    // words still get a useful retry because they may be an attempted answer.
    if (msg.replyId) return;
    await askNextQuestion(candidate, copy.UNCLEAR);
    return;
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

  // Back/More are navigation, not profile answers. They are ordinary rows so
  // tapping their id, typing their label, or replying with their row number all
  // resolve through the same interpreter path. Only this branch consumes them.
  if (interpretation.kind === 'matched') {
    const page = listPageTarget(step.id, interpretation.ids);
    if (page) {
      await setState(candidate, { listPage: page, unclearCount: 0 });
      await reply(candidate, await renderStep(step, candidate), step.id);
      return;
    }
  }

  switch (interpretation.kind) {
    case 'staff':
      await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
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
        await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
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
        await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
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
        await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
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
      // Counted, logged, and never escalated.
      //
      // Two unreadable replies used to end the automated conversation and hand
      // the candidate to a member of staff. That is the wrong trade: somebody
      // mistyping a city name, or answering in a way the classifier could not
      // place, has not asked for a person and does not want one — they want the
      // question again. So the question comes again, for as long as it takes.
      //
      // The count is kept because it is worth seeing in the logs: a step that
      // is misread by everybody is a step whose wording is wrong, and this is
      // the only number that would show it.
      const count = (candidate.unclearCount ?? 0) + 1;
      await setState(candidate, { unclearCount: count });

      if (count >= TUNABLES.maxAsksPerStep) {
        logger.warn(
          { waId: candidate.waId, step: step.id, count },
          'a reply could not be read; re-asking rather than handing over',
        );
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
        await ask(candidate, copy.OTHER_PROMPT, copy.OTHER_CHOICES, MENU.other);
        return;
      }

      // No staff button either way: a typo in a city name is not a reason to
      // offer a human, and the handoff above catches the second one anyway.
      await reply(
        candidate,
        await renderRetry(
          step,
          candidate,
          replied.kind === 'answered'
            ? replied.text
            : // The same message twice reads as the bot not listening. From the
              // second miss it says plainly that the answer was not right for
              // this question, which is more use than apologising again.
              count >= TUNABLES.maxAsksPerStep
              ? copy.ANSWER_NOT_RIGHT
              : copy.UNCLEAR,
        ),
        step.id,
      );
      return;
    }

    default:
      break;
  }

  // A real selection has been made. Page number is presentation state and must
  // never follow the candidate into the next question or a later edit.
  if (candidate.listPage?.step === step.id) await clearListPage(candidate);

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
    // Understood, but it did not answer the question — `total_experience` given
    // "about six" with no band, `location` yielding only a country. Asked
    // again, and again, rather than handed to a person: the candidate is
    // engaged and trying, and taking the conversation away from them at that
    // moment is the opposite of helping.
    const count = (candidate.unclearCount ?? 0) + 1;
    await setState(candidate, { unclearCount: count });

    logger.warn({ waId: candidate.waId, step: step.id, count }, 'answer left the step unsatisfied');
    await reply(candidate, await renderRetry(step, candidate, copy.ANSWER_NOT_RIGHT), step.id);
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
  // the same turn.
  await tell(candidate, copy.DOCUMENT_RECEIVED);
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
  uploadId?: ObjectId,
): Promise<void> {
  const record = await findConversationById(candidateId);
  if (!record) return;

  await recordsFor(record.enquiry).updateOne(
    { _id: candidateId },
    {
      $set: {
        [`documents.${docType}.status`]: status,
        ...(uploadId ? { [`documents.${docType}.documentId`]: uploadId } : {}),
        updatedAt: new Date(),
      },
    },
  );
}

/**
 * Puts a slot back in step with the uploads it actually holds.
 *
 * Called after an upload is moved out of a slot it never belonged in. The slot
 * status was set from the file that has just left, so it says `ocr_done` about
 * an extraction of somebody's Aadhaar under the résumé extractor — and the flow
 * reads that as "the CV is on file" and never asks again.
 *
 * The status is derived from whatever upload is current now, rather than
 * remembered, because the slot has just changed underneath and remembering is
 * what got it wrong in the first place. An empty slot goes back to `pending`,
 * which is what makes the question askable again.
 */
/**
 * The status a slot should have, given the extraction state of the upload it
 * holds.
 *
 * Its own function because it is derived in one place and asserted in another,
 * and because the mapping is where this is most likely to go quietly wrong: a
 * slot claiming `ocr_done` about a document that has left is a slot the flow
 * reads as answered, and the question is never asked again.
 *
 * No upload means `pending`, which is what makes the question askable again —
 * the point of re-deriving at all.
 */
export function slotStatusFor(ocr: UploadOcr | undefined): DocumentStatus {
  if (!ocr) return 'pending';
  if (ocr.status === 'queued' || ocr.status === 'running') return 'ocr_queued';
  if (ocr.status === 'failed') return 'ocr_failed';
  if (ocr.status === 'skipped') return 'received';
  if (ocr.completeness && !ocr.completeness.complete) return 'incomplete';
  if (ocr.needsReview) return 'needs_review';
  return ocr.status === 'done' ? 'ocr_done' : 'received';
}

export async function resyncSlotFromUploads(
  candidateId: ObjectId,
  docType: string,
): Promise<void> {
  const candidate = await findConversationById(candidateId);
  if (!candidate) return;

  const upload = await currentUpload(candidate.waId, docType);
  const slots = withMissingSlots(candidate.documents);
  const slot = slots[docType]!;
  const status = slotStatusFor(upload?.ocr);

  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidateId },
    {
      $set: {
        [`documents.${docType}`]: {
          ...slot,
          status,
          documentId: upload?.uploadId,
          // The note belonged to the file that has gone. Keeping it would have
          // the candidate re-asked with a complaint about a document that is
          // no longer in this slot.
          note: undefined,
          updatedAt: new Date(),
        },
        updatedAt: new Date(),
      },
    },
  );

  logger.info({ waId: candidate.waId, docType, status }, 'document slot re-derived from its uploads');
}

/**
 * Records which of the Aadhaar's four core fields an upload gave up (§15).
 *
 * The union across every Aadhaar this candidate has sent, because a front and a
 * back are two files and one card. What it decides is whether the back page is
 * asked for at all: a card sent as a PDF, as two images at once, or as one photo
 * of both sides yields all four in a single upload, and asking for "the other
 * side" then is asking for something already on file (§1).
 *
 * Written straight rather than through `buildProfileWrite`. That function weighs
 * provenance and refuses a weaker source, which is exactly right for a name and
 * exactly wrong for a set that has to grow as more of the card is read.
 */
export async function recordAadhaarCoverage(
  candidateId: ObjectId,
  docType: string,
  fields: OcrField[],
): Promise<void> {
  if (!AADHAAR_KINDS.has(docType)) return;

  const candidate = await findConversationById(candidateId);
  if (!candidate) return;

  const read = new Set(candidate.profile?.aadhaarFieldsRead ?? []);
  const before = read.size;

  for (const key of TUNABLES.aadhaarRequiredFields) {
    const found = fields.find((f) => f.key === key && f.value.trim().length > 0);
    if (found) read.add(key);
  }

  if (read.size === before) return;

  const merged = [...read];
  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidateId },
    { $set: { 'profile.aadhaarFieldsRead': merged, updatedAt: new Date() } },
  );

  logger.info(
    { waId: candidate.waId, docType, read: merged },
    'aadhaar fields read so far',
  );
}

/** Candidate Aadhaar slots. B2B identity files are intentionally never read. */
const AADHAAR_KINDS = new Set(['aadhaar', 'aadhaar_back']);


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
  nationalitySource?: 'cv' | 'passport',
): Promise<void> {
  const candidate = await findConversationById(candidateId);
  if (!candidate) return;

  candidate.profile ??= {};
  candidate.fieldMeta ??= {};

  const write = buildProfileWrite(candidate, patch, { source, confidence });
  if (Object.keys(write.set).length) {
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

  // This is an eligibility fact even when provenance rules keep a stronger
  // chat-entered nationality as the profile's display value.
  if (
    nationalitySource &&
    (await stopIfNonIndianNationality(candidate, patch.nationality, nationalitySource))
  ) return;

  // §27 — an automated overseas-work registration is not the right thing to run
  // with a minor, and this is now the only place a date of birth comes from.
  //
  // The flow stopped asking for one: it is on the Aadhaar and it is on the
  // passport, both of which are read, and a date typed from memory is the least
  // reliable thing on a record. That moved the age check here with it. Checked
  // against what was written rather than what was extracted, so a date the
  // profile refused — a weaker source than one already on file — cannot trigger
  // it.
  const written = write.set['profile.dateOfBirth'];
  if (typeof written === 'string') await stopIfUnderAge(candidate, written, source);

}

async function stopIfNonIndianNationality(
  candidate: CandidateDoc,
  nationality: unknown,
  source: 'cv' | 'passport',
): Promise<boolean> {
  if (nationalityBlocked(candidate)) {
    await purgeCandidateData(candidate.waId);
    return true;
  }

  const decision = nationalityDecision(nationality);
  if (decision === 'unknown') return false;

  // Passport is the authoritative nationality document. A later CV extraction
  // cannot weaken or replace a passport-based decision.
  if (candidate.nationalityCheck?.source === 'passport' && source === 'cv') return false;

  const check: NonNullable<CandidateDoc['nationalityCheck']> = {
    status: decision === 'indian' ? 'indian' : 'not_eligible',
    nationality: String(nationality).trim(),
    source,
    at: new Date(),
  };

  if (decision === 'indian') {
    await setState(candidate, { nationalityCheck: check });
    return false;
  }

  await setState(candidate, {
    nationalityCheck: check,
    stage: 'NOT_ELIGIBLE',
    status: 'not_eligible',
    currentStep: undefined,
    editQueue: [],
    sessionEndedAt: new Date(),
  });

  // The refusal needs the conversation record for language and delivery, but
  // it must be the last use of that record. Even if Meta refuses the outbound
  // message, the eligibility decision still requires the data to be removed.
  try {
    await tell(candidate, copy.NATIONALITY_NOT_SUPPORTED);
    await closeOpenSession(candidate.waId);
  } finally {
    const purged = await purgeCandidateData(candidate.waId);
    logger.info(
      { waId: candidate.waId, source, ...purged },
      'registration stopped and candidate data purged: nationality not supported',
    );
  }
  return true;
}

/**
 * Ends the conversation where an extracted date of birth makes the candidate a
 * minor (§27).
 *
 * Said once. `ageFlagged` marks it, because a candidate who sends an Aadhaar and
 * then a passport has two documents carrying the same date, and being told twice
 * that a person will be in touch reads as the bot having lost the thread.
 */
async function stopIfUnderAge(
  candidate: CandidateDoc,
  dateOfBirth: string,
  source: 'cv' | 'document',
): Promise<void> {
  if (candidate.stage === 'NOT_ELIGIBLE' || candidate.ageFlagged) return;

  const age = ageFrom(dateOfBirth);
  if (age === undefined || age >= TUNABLES.minimumAge) return;

  const now = new Date();
  await setState(candidate, {
    ageFlagged: true,
    stage: 'NOT_ELIGIBLE',
    status: 'not_eligible',
    currentStep: undefined,
    editQueue: [],
    sessionEndedAt: now,
  });
  logger.warn(
    { waId: candidate.waId, age, source },
    'the date of birth read off a document gives an age below the minimum',
  );

  await tell(candidate, copy.AGE_HANDOFF);
  await closeOpenSession(candidate.waId);
  await recordAudit({
    waId: candidate.waId,
    candidateId: candidate.candidateId,
    event: 'eligibility_blocked',
    detail: `${source} gives a date of birth with an age of ${age}`,
  });
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
  if (
    candidate.stage === 'HUMAN_HANDOFF' ||
    candidate.stage === 'DELETED' ||
    candidate.stage === 'NOT_ELIGIBLE'
  ) return;
  if (!GATED.has(docType)) return;

  if (uploadId && !isCurrentUpload(candidate, docType, uploadId)) {
    logger.info(
      { waId: candidate.waId, docType, uploadId: uploadId.toHexString() },
      'ignored an extraction verdict for an upload that has since been replaced',
    );
    return;
  }

  // A first contact can include a CV, so OCR may finish before the opening
  // questions do. A background result must never advance past consent. The
  // document stays filed and the ordinary flow will skip it after consent.
  if (!candidate.consent?.given) {
    logger.info(
      { waId: candidate.waId, docType },
      'document processed before consent; conversation remains behind consent gate',
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
    // The file itself satisfies the CV step. A partial extraction only means
    // that the unanswered profile fields must be collected in chat.
    if (outcome.complete || candidate.documents.cv?.documentId) {
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
        await recordAudit({
          waId: candidate.waId,
          candidateId: candidate.candidateId,
          event: 'document_rejected',
          detail: `"${docType}" remained unreadable after ${slot.askedCount} attempts`,
        });
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

  // The ATS holds a row per upload with what was read off it, and this is the
  // moment there is something to read. Only once the conversation has produced
  // a record worth exporting — before that, completion will carry it.
  await exportAfterExtraction(candidate);

  await askNextQuestion(candidate);
}

/**
 * Re-exports a conversation whose documents have just changed.
 *
 * An extraction finishes on its own schedule, and often after the candidate has
 * been told they are registered — a passport sent at the last question is still
 * with Veris when the confirmation is tapped. The export at completion writes
 * the upload with whatever was known then; this writes it again once the fields
 * exist.
 *
 * Only for a conversation that has already been exported, which `candidateId`
 * marks: a document arriving mid-registration will be carried by the completion
 * export anyway, and exporting a half-answered profile would put a row in front
 * of a recruiter for somebody who has not finished.
 */
async function exportAfterExtraction(candidate: CandidateDoc): Promise<void> {
  const exported = candidate.enquiry === 'b2b' ? candidate.completedAt : candidate.candidateId;
  if (!exported) return;
  await queue.enqueue('ats_export', { waId: candidate.waId });
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
      // Not a staff enquiry. Those live in `candidates` and pass through the
      // same stages, but §21's reminder is written for somebody part-way
      // through a registration and there is none here to be reminded about —
      // the same reason `B2B_PENDING` is absent from the stages above.
      enquiry: { $ne: 'staff' },
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
        await sendReengagementTemplate(candidate.phone, candidate.phoneNumberId);
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
