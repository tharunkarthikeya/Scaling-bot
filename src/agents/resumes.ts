/**
 * Résumés that Sourcing Hub agents send on WhatsApp.
 *
 * An agent sends a candidate's CV (a document or a photo) to Rafi's number.
 * The webhook (`server.ts`) recognises the sender as a Sourcing Hub agent and
 * queues an `agent_resume` job. This worker then:
 *
 * 1. downloads the file from Meta,
 * 2. posts it to the CRM (`POST /agent-resumes`). The CRM checks the sender is
 *    an agent, reads the file with VeriIS, refuses it if it is not a résumé or
 *    is a duplicate, and otherwise creates the candidate labelled with the
 *    agent and assigns it.
 *
 * The agent is sent nothing back, whatever the outcome. The bot never replies
 * to an agent (user rule, 2026-11-14); the only bot message an agent gets is
 * the new job order broadcast. The outcome is logged here and stored by the
 * CRM (`agent_resume_submissions`), and Rafi sees the agent's message in the
 * WhatsApp Business app (the line is on coexistence).
 *
 * A non-agent Sourcing Hub contact (a client or association) never reaches
 * this worker, and the CRM ignores one that does.
 */
import { CrmError, submitAgentResume, type AgentResumeOutcome } from '../crm/client.js';
import { isBotSuppressedNumber } from '../crm/suppression.js';
import { logger } from '../logger.js';
import type { JobPayloads } from '../queue/index.js';
import { downloadMedia, MediaTooLargeError } from '../whatsapp/client.js';

/** The message types an agent can send a CV as. Text is not a résumé file. */
export function isAgentResumeMessage(msg: { type: string; media?: { id: string } }): boolean {
  return !!msg.media?.id && (msg.type === 'document' || msg.type === 'image');
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

/**
 * The `agent_resume` worker. Throws only for something worth retrying: the
 * CRM unreachable, a 5xx, or the same message still being processed.
 */
export async function processAgentResume(payload: JobPayloads['agent_resume']): Promise<void> {
  // The webhook checked this before queueing. Checked again because the number
  // may have been added to the suppression list while the job waited, and a
  // suppressed number gets nothing: no CRM intake.
  if (await isBotSuppressedNumber(payload.waId)) {
    logger.info({ wamid: payload.wamid }, 'queued agent résumé from a bot-suppressed number dropped');
    return;
  }

  let media;
  try {
    media = await downloadMedia(payload.mediaId, payload.filename, payload.phoneNumberId);
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      logger.warn({ wamid: payload.wamid }, 'agent résumé too large to download; dropped without a reply');
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
}
