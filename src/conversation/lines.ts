/**
 * Which WhatsApp number a conversation belongs to, and which flow that number
 * runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE ONE PLACE A NUMBER IS TURNED INTO A FLOW. Nothing else may decide it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The agency runs two numbers. They are the same bot — the same opening menu,
 * the same consent, the same documents, the same tracking, the same handoff to
 * staff — differing only in which list of questions `nextStep` walks:
 *
 *   default   the flow this bot has always run. Unchanged, and it stays the
 *             answer for every number that is not explicitly the second one.
 *   sgmy      the Singapore/Malaysia line. Two destinations instead of five, no
 *             CV up front, and the CV asked later and only of a candidate whose
 *             job is one a CV says anything about (see `jobLevel.ts`).
 *
 * The mapping is a pure function of the `phone_number_id` Meta puts in the
 * webhook envelope, so it is decided from the message itself rather than from
 * anything the candidate can say. A number we do not recognise — a third line
 * somebody adds, a test number, an envelope with no metadata at all — is the
 * default flow, because the default flow is the one that is safe to run for
 * anyone.
 *
 * A conversation is stamped with its line and its variant when its record is
 * created, and keeps both. That is what makes the flow stable for a candidate
 * mid-registration, and it is also why the two numbers are not two identities:
 * the record is keyed on `waId`, so one person writing to both numbers has one
 * record, and it belongs to whichever line they wrote to first.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Which list of questions a conversation runs.
 *
 * Stored on the record rather than recomputed, because the question a candidate
 * is looking at must not change under them if an operator edits an environment
 * variable mid-conversation.
 */
export type FlowVariant = 'default' | 'sgmy';

/** Every variant, for the boot-time checks and the smoke suite. */
export const FLOW_VARIANTS: readonly FlowVariant[] = ['default', 'sgmy'] as const;

/**
 * The flow behind a `phone_number_id`.
 *
 * Undefined, blank, unknown, or simply the main number all give `default`. Only
 * an exact match on the configured second number gives `sgmy`, so the new flow
 * cannot be reached by accident — including when `WHATSAPP_PHONE_NUMBER_ID_SGMY`
 * is unset, which is the state every existing deployment is in.
 */
export function variantForLine(phoneNumberId: string | undefined): FlowVariant {
  const second = config.WHATSAPP_PHONE_NUMBER_ID_SGMY;
  if (!second || !phoneNumberId) return 'default';
  return phoneNumberId === second ? 'sgmy' : 'default';
}

/**
 * The number to send from, for a conversation on this line.
 *
 * A reply has to leave from the number the candidate wrote to. Sending from the
 * other one puts the agency's answer in a different thread on their phone,
 * under a number they never messaged — and on the second line it would also be
 * a reply from a number whose 24-hour window was never opened, which Meta
 * refuses outright.
 *
 * Falls back to the main number for a conversation recorded before this field
 * existed, which is every conversation already on file.
 */
export function sendingNumberFor(phoneNumberId: string | undefined): string {
  return phoneNumberId || config.WHATSAPP_PHONE_NUMBER_ID;
}

/** Whether the second line is configured at all. Read by `doctor` and the smoke checks. */
export function secondLineConfigured(): boolean {
  return !!config.WHATSAPP_PHONE_NUMBER_ID_SGMY;
}

/**
 * Warns when a conversation's line and the line a message arrived on disagree.
 *
 * It means one person has written to both numbers. There is one record per
 * `waId` and it keeps the flow it started on, which is the conservative answer —
 * changing flow mid-registration would re-ask questions the other flow does not
 * have and skip ones it does. Worth a log line either way, because the candidate
 * is being replied to on a number that is not the one they last wrote to.
 */
export function warnOnLineChange(params: {
  waId: string;
  recorded: string | undefined;
  arrivedOn: string | undefined;
}): void {
  if (!params.recorded || !params.arrivedOn) return;
  if (params.recorded === params.arrivedOn) return;

  logger.warn(
    { waId: params.waId, recordedLine: params.recorded, arrivedOn: params.arrivedOn },
    'message arrived on a different number from the one this conversation belongs to; ' +
      'keeping the recorded line and its flow',
  );
}
