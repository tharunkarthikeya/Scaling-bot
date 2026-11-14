/**
 * The one message an agent may ever get in reply: "contact the staff".
 *
 * The bot never answers agents (user rule, 2026-11-14), with this single
 * exception (same day): when a Sourcing Hub agent writes to the line in
 * `WHATSAPP_AGENT_HANDOFF_PHONE_NUMBER_ID` (+91 63817 27653), the bot replies
 * with the name and number of the staff member who handles them:
 *
 *     For any queries, please contact Zara - +91 98765 43210.
 *
 * **Once per agent number, ever.** The user called this the main thing: it
 * must never go twice. So:
 *
 * * the lock (`agent_handoffs`, `_id` = the agent's number) is claimed
 *   BEFORE sending. Of several messages arriving together, or of several bot
 *   instances, only one can win it;
 * * it is never released, not even when the send fails. A failed send may
 *   still have been delivered, and twice is worse than not at all. To let one
 *   agent get it again, delete their row in `agent_handoffs` by hand;
 * * an agent who already got the earlier hand-off (from the removed question
 *   answering, on any line) already holds a lock and gets nothing;
 * * a job retried by the queue finds the lock taken and sends nothing;
 * * nothing here throws after the claim, so the queue never re-runs a job
 *   that may have sent.
 *
 * With no staff to name (no handling staff in the Sourcing Hub and no job
 * order with a contact), nothing is sent and the lock is not taken, so the
 * agent can still get it once after a staff member is assigned.
 *
 * Shadow mode sends nothing and takes no lock.
 */
import { config } from '../config.js';
import { isBotSuppressedNumber } from '../crm/suppression.js';
import { logger } from '../logger.js';
import type { JobPayloads } from '../queue/index.js';
import { sendText } from '../whatsapp/client.js';
import { claimAgentHandoff, latestNoticeStaff } from './store.js';

/** Whether a message from an agent on this line may earn the hand-off. */
export function isAgentHandoffLine(phoneNumberId: string | undefined): boolean {
  const line = config.WHATSAPP_AGENT_HANDOFF_PHONE_NUMBER_ID.trim();
  return !!line && phoneNumberId === line;
}

/** "Name - phone" for the staff member, or null when there is nobody to name. */
function staffLabel(staff: { name?: string; phone?: string } | undefined): string | null {
  const name = staff?.name?.trim() ?? '';
  const phone = staff?.phone?.trim() ?? '';
  if (!name && !phone) return null;
  return name && phone ? `${name} - ${phone}` : name || phone;
}

/** The message, or null when there is nobody to name. */
export function agentHandoffMessage(staff: { name?: string; phone?: string } | undefined): string | null {
  const label = staffLabel(staff);
  return label ? `For any queries, please contact ${label}.` : null;
}

/** The `agent_handoff` worker. Throws only before the claim (a database failure). */
export async function processAgentHandoff(payload: JobPayloads['agent_handoff']): Promise<void> {
  // Checked again: the number may have been suppressed while the job waited.
  if (await isBotSuppressedNumber(payload.waId)) {
    logger.info({ wamid: payload.wamid }, 'agent hand-off for a bot-suppressed number dropped');
    return;
  }

  const fromCrm = { name: payload.staffName ?? '', phone: payload.staffPhone ?? '' };
  const staff = fromCrm.name.trim() || fromCrm.phone.trim() ? fromCrm : await latestNoticeStaff(payload.waId);
  const to = staffLabel(staff);
  if (!to) {
    logger.info({ wamid: payload.wamid }, 'agent has no staff to be pointed to; nothing sent, no lock taken');
    return;
  }

  const text = agentHandoffMessage(staff)!;
  if (config.SHADOW_MODE) {
    logger.info({ wamid: payload.wamid, text }, 'shadow mode: agent hand-off not sent, no lock taken');
    return;
  }

  const won = await claimAgentHandoff(payload.waId, {
    to,
    wamid: payload.wamid,
    ...(payload.phoneNumberId ? { lineId: payload.phoneNumberId } : {}),
  });
  if (!won) {
    logger.info({ wamid: payload.wamid }, 'agent already had the staff contact; not sent again');
    return;
  }

  try {
    await sendText(payload.waId, text, payload.phoneNumberId);
  } catch (err) {
    // The lock stays. Whatever went wrong, this agent is never sent it again.
    logger.warn({ err, wamid: payload.wamid }, 'could not send the staff contact to an agent; it will not be retried');
    return;
  }
  logger.info({ wamid: payload.wamid, to }, 'sent an agent the staff contact (the only time they get it)');
}
