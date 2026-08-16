import { ObjectId } from 'mongodb';
import { logger } from '../logger.js';
import {
  candidates,
  messages,
  storedDocuments,
  type CandidateDoc,
  type MessageDoc,
} from '../db/models.js';
import { downloadMedia, sendText, WhatsAppApiError } from '../whatsapp/client.js';
import { saveFile } from '../storage/index.js';
import { queue } from '../queue/index.js';
import { generateReply, type ToolEffects } from './claude.js';
import {
  attributeInboundDocument,
  initialSlots,
  isChecklistComplete,
  nextDocumentToAsk,
  renderState,
  requirementFor,
  withMissingSlots,
} from './checklist.js';
import { buildSystemPrompt, GREETING, TUNABLES } from './rules.js';

/** Meta's customer service window. Outside it, only approved templates may be sent. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Sent when the model fails, refuses, or returns nothing. A candidate must
 * never be left with silence — silence reads as the process being broken.
 */
const FALLBACK_REPLY =
  "Sorry, something went wrong on my side just then. Could you send that again? If it keeps happening, a recruiter will pick this up.";

const systemPrompt = buildSystemPrompt();

export async function getOrCreateCandidate(params: {
  waId: string;
  phone: string;
  profileName?: string;
}): Promise<{ candidate: CandidateDoc; created: boolean }> {
  const now = new Date();

  const existing = await candidates().findOne({ waId: params.waId });
  if (existing) {
    if (params.profileName && params.profileName !== existing.profileName) {
      await candidates().updateOne(
        { _id: existing._id },
        { $set: { profileName: params.profileName, updatedAt: now } },
      );
      existing.profileName = params.profileName;
    }
    return { candidate: existing, created: false };
  }

  const doc: CandidateDoc = {
    waId: params.waId,
    phone: params.phone,
    profileName: params.profileName,
    stage: 'new',
    profile: {},
    documents: initialSlots(),
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await candidates().insertOne(doc);
    doc._id = result.insertedId;
    return { candidate: doc, created: true };
  } catch (err) {
    // Lost a race with a concurrent first message — re-read rather than fail.
    if ((err as { code?: number }).code === 11000) {
      const raced = await candidates().findOne({ waId: params.waId });
      if (raced) return { candidate: raced, created: false };
    }
    throw err;
  }
}

/** A short, factual description of an inbound message for the transcript. */
function describeMessage(msg: MessageDoc): string {
  if (msg.type === 'text' || msg.type === 'interactive') return msg.text ?? '';
  if (msg.text) return `[sent a ${msg.type}] ${msg.text}`;
  return `[sent a ${msg.type}]`;
}

async function loadHistory(
  waId: string,
  excludeWamid: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  // Meta's timestamps are second-resolution, so several messages routinely share
  // one. _id breaks the tie by insertion order — without it the model can be
  // handed the conversation out of sequence.
  const rows = await messages()
    .find({ waId, wamid: { $ne: excludeWamid } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(TUNABLES.historyTurns)
    .toArray();

  return rows
    .reverse()
    .map((m) => ({
      role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: describeMessage(m),
    }))
    .filter((m) => m.content.trim().length > 0);
}

/**
 * Downloads an inbound file, stores it, files it against a checklist slot, and
 * queues OCR. Returns a description of what happened for the model to react to.
 */
async function ingestDocument(
  candidate: CandidateDoc,
  msg: MessageDoc,
): Promise<{ description: string; docType?: string }> {
  if (!msg.mediaId) return { description: describeMessage(msg) };

  const docType = attributeInboundDocument(candidate, {
    caption: msg.text,
    filename: msg.filename,
  });
  const requirement = requirementFor(docType);
  const label = requirement?.label ?? docType;

  let media;
  try {
    media = await downloadMedia(msg.mediaId);
  } catch (err) {
    logger.error({ err, mediaId: msg.mediaId, waId: candidate.waId }, 'media download failed');
    return {
      description:
        `[The candidate sent a file, but it could not be downloaded. Apologise briefly and ` +
        `ask them to send it once more.]`,
    };
  }

  const stored = await saveFile({
    waId: candidate.waId,
    docType,
    buffer: media.buffer,
    mimeType: media.mimeType,
    originalFilename: msg.filename,
  });

  const now = new Date();
  const willOcr = !!requirement && requirement.ocr !== 'none';

  const documentResult = await storedDocuments().insertOne({
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

  // Update the slot before the state block is rendered, so the model sees the
  // document as received on this very turn.
  const slots = withMissingSlots(candidate.documents);
  slots[docType] = {
    ...slots[docType]!,
    status: willOcr ? 'ocr_queued' : 'received',
    documentId: documentResult.insertedId,
    updatedAt: now,
  };
  candidate.documents = slots;

  await candidates().updateOne(
    { _id: candidate._id },
    { $set: { [`documents.${docType}`]: slots[docType], updatedAt: now } },
  );

  if (willOcr) {
    await queue.enqueue('ocr', { documentId: documentResult.insertedId.toHexString() });
  }

  logger.info({ waId: candidate.waId, docType, storageKey: stored.storageKey }, 'document ingested');

  return {
    description: `[The candidate sent a file. It has been received and filed as their ${label}.${
      msg.text ? ` They captioned it: "${msg.text}"` : ''
    }]`,
    docType,
  };
}

async function applyEffects(candidate: CandidateDoc, effects: ToolEffects): Promise<void> {
  const now = new Date();
  const set: Record<string, unknown> = { updatedAt: now };

  for (const [key, value] of Object.entries(effects.profileUpdates)) {
    set[`profile.${key}`] = value;
    candidate.profile[key] = value;
  }

  const slots = withMissingSlots(candidate.documents);
  for (const update of effects.documentStatusUpdates) {
    const current = slots[update.docType];
    if (!current) continue;
    // A document already on disk outranks anything the model claims about it.
    if (current.status === 'received' || current.status.startsWith('ocr_')) continue;
    slots[update.docType] = {
      ...current,
      status: update.status,
      note: update.note,
      updatedAt: now,
    };
    set[`documents.${update.docType}`] = slots[update.docType];
  }
  candidate.documents = slots;

  if (effects.handoff) {
    set.stage = 'human_handoff';
    set.humanHandoff = { reason: effects.handoff.reason, at: now };
    candidate.stage = 'human_handoff';
    logger.warn(
      { waId: candidate.waId, reason: effects.handoff.reason },
      'conversation handed off to a human',
    );
  }

  await candidates().updateOne({ _id: candidate._id }, { $set: set });
}

async function persistOutbound(
  waId: string,
  text: string,
  results: Array<{ wamid?: string; shadowed: boolean }>,
): Promise<void> {
  const now = new Date();
  const wamid = results[0]?.wamid;
  await messages().insertOne({
    waId,
    direction: 'outbound',
    // Omit rather than store null — the unique index covers string values only.
    ...(wamid ? { wamid } : {}),
    type: 'text',
    text,
    shadowed: results.some((r) => r.shadowed),
    createdAt: now,
  });
  await candidates().updateOne({ waId }, { $set: { lastOutboundAt: now, updatedAt: now } });
}

async function reply(candidate: CandidateDoc, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  try {
    const results = await sendText(candidate.phone, trimmed);
    await persistOutbound(candidate.waId, trimmed, results);
  } catch (err) {
    if (err instanceof WhatsAppApiError && err.isOutsideWindow) {
      // Nothing to do here — the 24-hour window closed. The re-engagement
      // template is the only way back in, and that is a scheduled decision.
      logger.warn({ waId: candidate.waId }, 'reply dropped: outside the 24-hour window');
      await messages().insertOne({
        waId: candidate.waId,
        direction: 'outbound',
        type: 'text',
        text: trimmed,
        error: 'outside_24h_window',
        createdAt: new Date(),
      });
      return;
    }
    throw err;
  }
}

/**
 * Handles one inbound message end to end. Called from the queue, never inline
 * from the webhook — Meta expects an ack within seconds and this can take
 * tens of seconds.
 */
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
  await candidates().updateOne(
    { _id: candidate._id },
    {
      $set: {
        lastInboundAt: now,
        windowExpiresAt: new Date(now.getTime() + WINDOW_MS),
        updatedAt: now,
      },
    },
  );

  if (candidate.stage === 'human_handoff' || candidate.stage === 'opted_out') {
    logger.info({ waId: candidate.waId, stage: candidate.stage }, 'inbound ignored: bot is paused');
    return;
  }

  // A deterministic opening line, so the first thing a candidate reads is
  // always the same and always on-message.
  if (created) {
    await reply(candidate, GREETING);
  }

  const ingested =
    msg.mediaId && (msg.type === 'image' || msg.type === 'document')
      ? await ingestDocument(candidate, msg)
      : { description: describeMessage(msg) };

  if (candidate.stage === 'new') {
    candidate.stage = 'collecting_documents';
    await candidates().updateOne(
      { _id: candidate._id },
      { $set: { stage: 'collecting_documents', updatedAt: new Date() } },
    );
  }

  const history = await loadHistory(candidate.waId, payload.wamid);

  let replyText = '';
  try {
    const result = await generateReply({
      systemPrompt,
      history,
      stateBlock: renderState(candidate),
      latestMessage: ingested.description || '[empty message]',
    });
    replyText = result.reply;
    await applyEffects(candidate, result.effects);

    if (!replyText.trim()) {
      // The model returned successfully but said nothing. Without this the
      // candidate silently gets the fallback and the logs show a clean run.
      logger.warn(
        { waId: candidate.waId, stopReason: result.stopReason },
        'model produced no reply text; falling back',
      );
    }
  } catch (err) {
    logger.error({ err, waId: candidate.waId }, 'reply generation failed');
  }

  await reply(candidate, replyText || FALLBACK_REPLY);

  // Record what we just asked for, so the next inbound file lands in the right
  // slot even when the candidate sends it without a caption.
  const next = nextDocumentToAsk(candidate);
  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (next) {
    update.awaitingDocument = next.id;
    const slot = candidate.documents[next.id];
    if (slot) {
      update[`documents.${next.id}`] = {
        ...slot,
        askedCount: slot.askedCount + 1,
        lastAskedAt: new Date(),
        updatedAt: new Date(),
      };
    }
  } else if (candidate.stage === 'collecting_documents' && isChecklistComplete(candidate)) {
    update.stage = 'awaiting_review';
    update.awaitingDocument = undefined;
  }

  await candidates().updateOne({ _id: candidate._id }, { $set: update });
}

export async function markSlotFromOcr(
  candidateId: ObjectId,
  docType: string,
  status: 'ocr_done' | 'ocr_failed' | 'needs_review',
): Promise<void> {
  await candidates().updateOne(
    { _id: candidateId },
    { $set: { [`documents.${docType}.status`]: status, updatedAt: new Date() } },
  );
}
