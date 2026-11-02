/**
 * Résumés that Sourcing Hub agents send on WhatsApp.
 *
 * An agent sends a candidate's CV (a document or a photo) to Rafi's number.
 * The webhook (`server.ts`) recognises the sender as a Sourcing Hub contact,
 * which used to mean "ignore", and queues an `agent_resume` job instead. This
 * worker then:
 *
 * 1. downloads the file from Meta,
 * 2. posts it to the CRM (`POST /agent-resumes`). The CRM checks the sender is
 *    an agent, reads the file with VeriIS, refuses it if it is not a résumé or
 *    is a duplicate, and otherwise creates the candidate labelled with the
 *    agent and assigns it,
 * 3. replies to the agent with what happened, from the line they wrote to.
 *
 * The reply is free text, which is allowed because the agent has just written
 * to us, so their 24-hour window is open. It also shows in Rafi's WhatsApp
 * Business app (the line is on coexistence).
 *
 * A non-agent Sourcing Hub contact (a client or association) gets no reply,
 * exactly as before. Their message was always left for a person to read.
 */
import { CrmError, submitAgentResume, type AgentResumeOutcome } from '../crm/client.js';
import { isBotSuppressedNumber } from '../crm/suppression.js';
import { logger } from '../logger.js';
import type { JobPayloads } from '../queue/index.js';
import { downloadMedia, MediaTooLargeError, sendText } from '../whatsapp/client.js';

/** The message types an agent can send a CV as. Text is not a résumé file. */
export function isAgentResumeMessage(msg: { type: string; media?: { id: string } }): boolean {
  return !!msg.media?.id && (msg.type === 'document' || msg.type === 'image');
}

/** Rejection codes from the CRM intake, grouped by what the agent should do. */
const DUPLICATE = new Set(['duplicate_resume', 'duplicate_candidate', 'duplicate_passport']);
const UNREADABLE = new Set([
  'low_resume_confidence',
  'missing_candidate_name',
  'missing_candidate_contact',
  'resume_ocr_failed',
  'resume_veris_failed',
]);
const NOT_A_RESUME = new Set(['not_a_resume', 'unsupported_resume_type', 'invalid_resume', 'empty_resume']);

/**
 * What to tell the agent, or null to stay silent.
 *
 * Deliberately not the CRM's own `message`: that can name an existing
 * candidate, which is not the agent's business when two agents send the same
 * person.
 */
export function agentResumeReply(outcome: AgentResumeOutcome, filename?: string): string | null {
  const file = filename ? `"${filename}"` : 'the file you sent';
  switch (outcome.status) {
    case 'created': {
      const who = outcome.full_name ? `${outcome.full_name} has` : 'The candidate has';
      const code = outcome.candidate_code ? ` (ID: ${outcome.candidate_code})` : '';
      return `Received. ${who} been added to Adira Enterprises${code}. Thank you.`;
    }
    case 'rejected': {
      const code = outcome.code ?? '';
      if (DUPLICATE.has(code)) {
        return `${capitalise(file)}: this candidate is already registered with Adira Enterprises, so they were not added again.`;
      }
      if (UNREADABLE.has(code)) {
        return `We could not read ${file} clearly enough to find the candidate's name and phone number. Please send a clearer copy, preferably a PDF or Word file.`;
      }
      if (code === 'foreign_nationality') {
        return `${capitalise(file)}: we are not able to process this candidate, so they were not added.`;
      }
      if (code === 'file_too_large' || code === 'resume_too_large') {
        return `${capitalise(file)} is too large. Please send a file smaller than 20 MB.`;
      }
      if (NOT_A_RESUME.has(code)) {
        return `${capitalise(file)} does not look like a résumé, so no candidate was added. Please send the candidate's CV as a PDF, Word file or clear photo.`;
      }
      return `${capitalise(file)} could not be added as a candidate. Please check it is the candidate's CV and send it again.`;
    }
    case 'error':
      return `We could not process ${file} right now. Please send it again in a few minutes.`;
    case 'ignored':
    case 'processing':
      return null;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Default name for a file WhatsApp sent without one (photos have none). */
function filenameFor(payload: JobPayloads['agent_resume'], mimeType: string): string {
  if (payload.filename) return payload.filename;
  const extension = mimeType.includes('png')
    ? 'png'
    : mimeType.includes('jpeg') || mimeType.includes('jpg')
      ? 'jpg'
      : mimeType.includes('pdf')
        ? 'pdf'
        : 'bin';
  return `resume.${extension}`;
}

async function reply(payload: JobPayloads['agent_resume'], text: string): Promise<void> {
  try {
    await sendText(payload.waId, text, payload.phoneNumberId);
  } catch (err) {
    // The CRM side is done and recorded; a failed reply is not worth redoing it.
    logger.warn({ err, wamid: payload.wamid }, 'could not reply to an agent about their résumé');
  }
}

/**
 * The `agent_resume` worker. Throws only for something worth retrying: the
 * CRM unreachable, a 5xx, or the same message still being processed.
 */
export async function processAgentResume(payload: JobPayloads['agent_resume']): Promise<void> {
  // The webhook checked this before queueing. Checked again because the number
  // may have been added to the suppression list while the job waited, and a
  // suppressed number gets nothing: no CRM intake and no reply.
  if (await isBotSuppressedNumber(payload.waId)) {
    logger.info({ wamid: payload.wamid }, 'queued agent résumé from a bot-suppressed number dropped');
    return;
  }

  let media;
  try {
    media = await downloadMedia(payload.mediaId, payload.filename, payload.phoneNumberId);
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      await reply(payload, agentResumeReply({ status: 'rejected', code: 'file_too_large' }, payload.filename)!);
      return;
    }
    throw err;
  }

  const mimeType = media.mimeType || payload.mimeType || 'application/octet-stream';
  const filename = filenameFor(payload, mimeType);

  let outcome: AgentResumeOutcome;
  try {
    outcome = await submitAgentResume({
      buffer: media.buffer,
      filename,
      mimeType,
      phone: payload.waId,
      wamid: payload.wamid,
      lineId: payload.phoneNumberId,
    });
  } catch (err) {
    if (err instanceof CrmError && !err.retryable) {
      logger.warn({ err, wamid: payload.wamid }, 'the CRM refused an agent résumé outright');
      await reply(payload, agentResumeReply({ status: 'error' }, payload.filename)!);
      return;
    }
    throw err;
  }

  if (outcome.status === 'processing') {
    // Another attempt is still reading it. Retry later for the stored outcome.
    throw new Error(`agent résumé ${payload.wamid} is still being processed by the CRM`);
  }

  logger.info(
    {
      wamid: payload.wamid,
      status: outcome.status,
      ...('code' in outcome ? { code: outcome.code } : {}),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...(outcome.status === 'created' ? { candidateCode: outcome.candidate_code } : {}),
    },
    'agent résumé handled by the CRM',
  );

  const text = agentResumeReply(outcome, payload.filename);
  if (text) await reply(payload, text);
}
