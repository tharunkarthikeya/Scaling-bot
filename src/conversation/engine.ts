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
import { logger } from '../logger.js';
import {
  candidates,
  messages,
  nextCandidateId,
  recordAudit,
  storedDocuments,
  type CandidateDoc,
  type CandidateStatus,
  type ConversationStage,
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
import { queue } from '../queue/index.js';
import * as copy from './copy.js';
import {
  fieldsToClear,
  inferTradePacks,
  nextStep,
  stepById,
  stepsInSection,
  type Answer,
  type FlowStep,
  type Section,
} from './flow.js';
import { attributeInboundDocument, initialSlots, withMissingSlots } from './checklist.js';
import { detectGlobalCommand, interpret } from './interpret.js';
import {
  acceptedChoices,
  choices as renderChoices,
  message as renderMessage,
  renderStep,
} from './render.js';
import { ageFrom, buildProfileWrite } from './profile.js';
import { detectLanguage, type Choice, type Language, type Localised } from './language.js';
import { requirementFor, TUNABLES } from './rules.js';
import { packById, type TradeQuestion } from './trades.js';
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
  update: 'menu:update',
  edit: 'menu:edit',
  delete: 'menu:delete',
  reminder: 'menu:reminder',
  jobs: 'menu:jobs',
  certificate: 'ask:certificate',
  contact: 'ask:contact',
} as const;

/** Suffix marking the free-text follow-up to an "Other" choice. */
const OTHER_SUFFIX = '#other';

/**
 * Documents whose acknowledgement waits for extraction rather than for arrival.
 * §5 wants the CV confirmed immediately but its questions skipped, and §14
 * forbids saying "Passport received" before the upload is known to be usable.
 */
const GATED = new Set(['cv', 'passport', 'aadhaar', 'pan']);

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
  const existing = await candidates().findOne({ waId: params.waId });

  if (existing) {
    if (params.profileName && params.profileName !== existing.profileName) {
      await candidates().updateOne(
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
      const raced = await candidates().findOne({ waId: params.waId });
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
  await candidates().updateOne({ _id: candidate._id }, { $set: update });
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
  await messages().insertOne({
    waId: candidate.waId,
    direction: 'outbound',
    // Omitted rather than stored as null — the unique index covers strings only.
    ...(wamid ? { wamid } : {}),
    type: 'text',
    text: body,
    ...(step ? { step } : {}),
    shadowed: results.some((r) => r.shadowed),
    createdAt: now,
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
      await messages().insertOne({
        waId: candidate.waId,
        direction: 'outbound',
        type: 'text',
        text: body,
        error: 'outside_24h_window',
        createdAt: new Date(),
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
  language: 'LANGUAGE_PENDING',
  consent: 'CONSENT_PENDING',
  cv: 'CV_PENDING',
  personal: 'BASIC_DETAILS_PENDING',
  experience: 'BASIC_DETAILS_PENDING',
  job_preference: 'JOB_PREFERENCE_PENDING',
  country: 'JOB_PREFERENCE_PENDING',
  availability: 'JOB_PREFERENCE_PENDING',
  passport: 'JOB_PREFERENCE_PENDING',
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
async function askNextQuestion(candidate: CandidateDoc): Promise<void> {
  // If what the candidate has already told us decides their trade questions,
  // record that now so the disambiguation question is skipped entirely (§8).
  const packs = inferTradePacks(candidate);
  if (packs) {
    await candidates().updateOne(
      { _id: candidate._id },
      { $set: { 'profile.tradePacks': packs, updatedAt: new Date() } },
    );
    candidate.profile.tradePacks = packs;
  }

  const step = nextStep(candidate);

  if (!step) {
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

  await reply(candidate, await renderStep(step, candidate), step.id);

  const patch: Partial<CandidateDoc> = {
    currentStep: step.id,
    stage: STAGE_BY_SECTION[step.section],
    status: statusForStage(STAGE_BY_SECTION[step.section], candidate.status),
  };

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

/** §24. Everything automated stops until staff hand the conversation back. */
async function handOffToStaff(candidate: CandidateDoc, reason: string): Promise<void> {
  await tell(candidate, copy.STAFF_HANDOFF);
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

/** Staff returning the conversation to the bot (§24). */
export async function returnConversationToBot(waId: string): Promise<boolean> {
  const candidate = await candidates().findOne({ waId });
  if (!candidate || candidate.stage !== 'HUMAN_HANDOFF') return false;

  candidate.documents = withMissingSlots(candidate.documents);
  candidate.profile ??= {};
  candidate.fieldMeta ??= {};

  await setState(candidate, {
    stage: candidate.completedAt ? 'REGISTRATION_COMPLETED' : 'BASIC_DETAILS_PENDING',
    humanHandoff: { ...candidate.humanHandoff!, returnedAt: new Date() },
    unclearCount: 0,
  });

  await recordAudit({ waId, candidateId: candidate.candidateId, event: 'handoff_returned' });
  await askNextQuestion(candidate);
  return true;
}

async function completeRegistration(candidate: CandidateDoc): Promise<void> {
  const candidateId = candidate.candidateId ?? (await nextCandidateId());

  await setState(candidate, {
    candidateId,
    stage: 'REGISTRATION_COMPLETED',
    status: BOT_OWNED.has(candidate.status) ? 'profile_registered' : candidate.status,
    completedAt: candidate.completedAt ?? new Date(),
    currentStep: undefined,
    editQueue: [],
    unclearCount: 0,
  });

  await tell(candidate, copy.COMPLETED, { candidateId });
  await recordAudit({ waId: candidate.waId, candidateId, event: 'registration_completed' });
  logger.info({ waId: candidate.waId, candidateId }, 'registration completed');
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

  await storedDocuments().updateMany(
    { candidateId: candidate._id },
    { $set: { supersededAt: now, updatedAt: now } },
  );

  await candidates().updateOne(
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

  let media;
  try {
    media = await downloadMedia(msg.mediaId);
  } catch (err) {
    logger.error({ err, mediaId: msg.mediaId, waId: candidate.waId }, 'media download failed');
    return { failed: true };
  }

  const stored = await saveFile({
    waId: candidate.waId,
    docType,
    buffer: media.buffer,
    mimeType: media.mimeType,
    originalFilename: msg.filename,
  });

  const now = new Date();
  const requirement = requirementFor(docType);
  const willOcr = !!requirement && requirement.ocr !== 'none';

  const inserted = await storedDocuments().insertOne({
    candidateId: candidate._id!,
    waId: candidate.waId,
    docType,
    mediaId: msg.mediaId,
    storageKey: stored.storageKey,
    mimeType: media.mimeType,
    byteSize: stored.byteSize,
    sha256: stored.sha256,
    originalFilename: msg.filename,
    caption: msg.text,
    ocr: { status: willOcr ? 'queued' : 'skipped' },
    createdAt: now,
    updatedAt: now,
  });

  const slots = withMissingSlots(candidate.documents);
  const previous = slots[docType]!;

  if (previous.documentId) {
    await storedDocuments().updateOne(
      { _id: previous.documentId },
      { $set: { supersededAt: now, updatedAt: now } },
    );
  }

  slots[docType] = {
    ...previous,
    status: willOcr ? 'ocr_queued' : 'received',
    documentId: inserted.insertedId,
    note: undefined,
    previousDocumentIds: previous.documentId
      ? [...(previous.previousDocumentIds ?? []), previous.documentId]
      : previous.previousDocumentIds,
    updatedAt: now,
  };

  await setState(candidate, { documents: slots });

  if (willOcr) {
    await queue.enqueue('ocr', { documentId: inserted.insertedId.toHexString() });
  }

  logger.info({ waId: candidate.waId, docType, storageKey: stored.storageKey }, 'document ingested');
  return { docType };
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
    await messages().insertOne({
      waId: candidate.waId,
      direction: 'inbound',
      type: 'text',
      text: `[voice note] ${text}`,
      createdAt: new Date(),
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

  await candidates().updateOne(
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
    case 'looking_for_job':
      if (chosen === 'no') {
        await tell(candidate, copy.NOT_LOOKING);
        await setState(candidate, { status: 'not_interested', currentStep: undefined });
        return true;
      }
      return false;

    case 'language':
      await setState(candidate, { language: chosen as Language });
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

  const answer: Answer = { ids: pending, raw: pending.join(', ') };

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

  await candidates().updateOne(
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
  [MENU.update]: copy.UPDATE_CHOICES,
  [MENU.edit]: copy.EDIT_CHOICES,
  [MENU.delete]: copy.DELETE_CHOICES,
  [MENU.reminder]: copy.REMINDER_CHOICES,
  [MENU.jobs]: [
    { id: 'yes', label: copy.YES },
    { id: 'no', label: copy.NO },
  ],
};

const MENU_PROMPTS: Record<string, Localised> = {
  [MENU.returning]: copy.RETURNING_NO_ID,
  [MENU.update]: copy.UPDATE_PROMPT,
  [MENU.edit]: copy.EDIT_PROMPT,
  [MENU.delete]: copy.DELETE_CONFIRM,
  [MENU.reminder]: copy.REMINDER,
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
    await candidates().updateOne({ _id: candidate._id }, { $unset: unset });
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
    case MENU.returning:
      switch (choiceId) {
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

    case MENU.reminder:
      switch (choiceId) {
        case 'continue':
          await setState(candidate, { currentStep: undefined, unclearCount: 0 });
          await askNextQuestion(candidate);
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
 * The turn
 * ───────────────────────────────────────────────────────────────────────────*/

export async function handleInboundMessage(payload: {
  waId: string;
  wamid: string;
  profileName?: string;
}): Promise<void> {
  const msg = await messages().findOne({ wamid: payload.wamid, direction: 'inbound' });
  if (!msg) {
    logger.warn({ wamid: payload.wamid }, 'inbound job for unknown message');
    return;
  }

  const { candidate, created } = await getOrCreateCandidate({
    waId: payload.waId,
    phone: msg.waId,
    profileName: payload.profileName,
  });

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
    await setState(candidate, {
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

  /* ---- a registered candidate coming back (§20) ---- */

  if (candidate.stage === 'REGISTRATION_COMPLETED' && !candidate.currentStep) {
    if (ingested.failed) {
      await tell(candidate, copy.FILE_FAILED);
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
    await tell(candidate, copy.FILE_FAILED);
    return;
  }
  if (ingested.docType) {
    await acknowledgeDocument(candidate, ingested.docType);
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
      await candidates().updateOne(
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

    await tell(candidate, voiceNoteUnread ? copy.VOICE_NOT_UNDERSTOOD : copy.UNCLEAR);
    await reply(candidate, await renderChoices(menu.prompt, options, candidate), current);
    return;
  }

  /* ---- the question we actually asked ---- */

  const step = (current ? stepById(current) : undefined) ?? nextStep(candidate);
  if (!step) {
    await askNextQuestion(candidate);
    return;
  }

  if (voiceNoteUnread) {
    await tell(candidate, copy.VOICE_NOT_UNDERSTOOD);
    await reply(candidate, await renderStep(step, candidate), step.id);
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

    case 'command':
      await ask(
        candidate,
        interpretation.command === 'delete' ? copy.DELETE_CONFIRM : copy.UPDATE_PROMPT,
        interpretation.command === 'delete' ? copy.DELETE_CHOICES : copy.UPDATE_CHOICES,
        interpretation.command === 'delete' ? MENU.delete : MENU.update,
      );
      return;

    case 'unrelated':
      // §27 — no promises about jobs, salaries or visas. Answer inside scope,
      // then put the same question back.
      await tell(candidate, copy.OUT_OF_SCOPE);
      await reply(candidate, await renderStep(step, candidate), step.id);
      return;

    case 'unclear': {
      const count = (candidate.unclearCount ?? 0) + 1;
      await setState(candidate, { unclearCount: count });

      if (count >= TUNABLES.maxAsksPerStep) {
        await tell(candidate, copy.STUCK);
        await handOffToStaff(candidate, `could not understand ${count} replies at "${step.id}"`);
        return;
      }
      await tell(candidate, copy.UNCLEAR);
      await reply(candidate, await renderStep(step, candidate), step.id);
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
    const answer: Answer =
      interpretation.kind === 'matched'
        ? { ids: interpretation.ids, raw: interpretation.raw }
        : interpretation.kind === 'structured'
          ? { fields: interpretation.fields, raw: interpretation.raw }
          : { value: interpretation.value, raw: interpretation.raw };

    if (await handleSpecialStep(candidate, step, answer)) return;
    await recordAnswer(candidate, step, answer);

    // "Other" on a trade question needs the candidate's own words before moving on.
    if (answer.ids?.includes('other') && (await askForOtherText(candidate, step))) return;
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
async function acknowledgeDocument(candidate: CandidateDoc, docType: string): Promise<void> {
  if (docType === 'cv') {
    await tell(candidate, copy.CV_RECEIVED);
    return;
  }
  if (GATED.has(docType)) {
    await tell(candidate, copy.CHECKING_DOCUMENT);
    return;
  }

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
}

/** Records the extraction verdict against the slot. Called by the OCR worker. */
export async function markSlotFromOcr(
  candidateId: ObjectId,
  docType: string,
  status: 'ocr_done' | 'ocr_failed' | 'needs_review' | 'incomplete',
): Promise<void> {
  await candidates().updateOne(
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
  const candidate = await candidates().findOne({ _id: candidateId });
  if (!candidate) return;

  candidate.profile ??= {};
  candidate.fieldMeta ??= {};

  const write = buildProfileWrite(candidate, patch, { source, confidence });
  if (!Object.keys(write.set).length) return;

  await candidates().updateOne(
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
): Promise<void> {
  const candidate = await candidates().findOne({ _id: candidateId });
  if (!candidate) return;

  candidate.documents = withMissingSlots(candidate.documents);
  candidate.profile ??= {};
  candidate.fieldMeta ??= {};
  candidate.history ??= [];

  // Staff have it, or the record is gone — either way, do not interject.
  if (candidate.stage === 'HUMAN_HANDOFF' || candidate.stage === 'DELETED') return;
  if (!GATED.has(docType)) return;

  // A CV is never re-requested for being hard to read. It is a convenience: what
  // it yields skips questions, and what it does not, the flow simply asks (§5).
  if (docType === 'cv') {
    await askNextQuestion(candidate);
    return;
  }

  if (!outcome.complete) {
    const slot = candidate.documents[docType]!;
    await markSlot(candidate, docType, 'incomplete', outcome.problems.join('; '));

    // Asking a third time for the same unreadable document is worse for the
    // candidate than letting staff sort it out on a call.
    if (slot.askedCount >= TUNABLES.maxAsksPerDocument) {
      await candidates().updateOne(
        { _id: candidateId },
        { $set: { status: 'documents_incomplete' as CandidateStatus, updatedAt: new Date() } },
      );
      await askNextQuestion(candidate);
      return;
    }

    // What went wrong decides what to say. Telling someone to "resend all pages"
    // when the extractor got nothing at all — or when they sent the wrong card —
    // is advice they cannot act on, and they send the same file again.
    const documentName = (await renderMessage(
      requirementFor(docType)?.label ?? copy.DOCUMENT_THIS_ONE,
      candidate,
    )).body;

    if (outcome.verdict === 'empty') {
      await tell(candidate, copy.DOCUMENT_NOT_READ, { document: documentName });
    } else if (outcome.verdict === 'wrong_document') {
      await tell(candidate, copy.DOCUMENT_WRONG_TYPE, { document: documentName });
    } else if (outcome.verdict === 'unreadable') {
      await tell(candidate, copy.DOCUMENT_UNREADABLE);
    } else {
      const detail = outcome.missingPages?.length
        ? (await renderMessage(copy.DOCUMENT_PAGES, candidate, {
            pages: outcome.missingPages.join(', '),
          })).body
        : (await renderMessage(copy.DOCUMENT_ALL_PAGES, candidate)).body;

      await tell(candidate, copy.DOCUMENT_INCOMPLETE, { detail });
    }

    await askNextQuestion(candidate);
    return;
  }

  const acknowledgement: Record<string, Localised> = {
    passport: copy.PASSPORT_RECEIVED,
    aadhaar: copy.AADHAAR_RECEIVED,
    pan: copy.PAN_RECEIVED,
  };

  if (acknowledgement[docType]) await tell(candidate, acknowledgement[docType]!);
  await askNextQuestion(candidate);
}

/** Raised once, when documents disagree about who the candidate is (§17). */
export async function flagIdentityMismatch(
  candidateId: ObjectId,
  differences: string[],
): Promise<void> {
  const candidate = await candidates().findOne({ _id: candidateId });
  if (!candidate || candidate.profile?.identityFlagged) return;

  candidate.documents = withMissingSlots(candidate.documents);
  candidate.profile ??= {};

  await candidates().updateOne(
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
        await ask(candidate, copy.REMINDER, copy.REMINDER_CHOICES, MENU.reminder, {
          name: candidate.profile?.fullName ?? candidate.profileName ?? '',
        });
      } else {
        // Outside the window, only an approved template may be sent (§27).
        await sendReengagementTemplate(candidate.phone);
        await messages().insertOne({
          waId: candidate.waId,
          direction: 'outbound',
          type: 'template',
          text: '[re-engagement template]',
          createdAt: new Date(),
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
