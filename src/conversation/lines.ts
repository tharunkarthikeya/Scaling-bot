/**
 * Which WhatsApp number a conversation belongs to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  NUMBERS ONLY. WHICH QUESTIONS GET ASKED IS `conversation/flow.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The agency runs two numbers and they are the same bot: the same opening menu,
 * the same consent, the same country question, the same documents, the same
 * tracking, the same handoff to staff — and now the same flow. They did differ.
 * The second number ran the Singapore/Malaysia questions and the first did not,
 * and a candidate got one flow or the other according to which number they had
 * happened to write to. That split is gone: Singapore and Malaysia are two rows
 * in the one country question, and choosing one is what puts a candidate on that
 * route, from either number. `routeFor` in `flow.ts` is the whole of it.
 *
 * What is left here is everything about a number that stays true whatever
 * questions it asks: a reply has to leave from the number the candidate wrote
 * to, on a token that can see that number, and a webhook has to survive a
 * signature check against the app that owns the subscription.
 *
 * A conversation is stamped with its number when its record is created and keeps
 * it. The record is keyed on `waId`, so one person writing to both numbers has
 * one record, and it belongs to whichever number they wrote to first.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';

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

/**
 * The Graph access token to call on behalf of a line.
 *
 * Two WABAs under one Meta app share a token and `WHATSAPP_ACCESS_TOKEN_SGMY`
 * stays unset, which is the common case and the one every existing deployment
 * is in. Two WABAs under two apps do not share one, and a call made with the
 * wrong token is a 401 on the second number alone — indistinguishable, from
 * outside, from the bot ignoring that number.
 */
export function accessTokenFor(phoneNumberId: string | undefined): string {
  const second = config.WHATSAPP_PHONE_NUMBER_ID_SGMY;
  if (second && phoneNumberId === second && config.WHATSAPP_ACCESS_TOKEN_SGMY) {
    return config.WHATSAPP_ACCESS_TOKEN_SGMY;
  }
  return config.WHATSAPP_ACCESS_TOKEN;
}

/**
 * Every app secret a delivery could legitimately be signed with.
 *
 * Meta signs a webhook with the secret of the app that owns the subscription,
 * and the envelope's signature is checked before anything in it is parsed — so
 * there is no line to look the secret up by yet. Both are ours, so trying both
 * widens nothing: a body signed with neither is still rejected.
 *
 * One entry unless the second line has a secret of its own.
 */
export function webhookSecrets(): string[] {
  const second = config.WHATSAPP_APP_SECRET_SGMY;
  return second && second !== config.WHATSAPP_APP_SECRET
    ? [config.WHATSAPP_APP_SECRET, second]
    : [config.WHATSAPP_APP_SECRET];
}

/** Whether the second number is configured at all. Read by `doctor` and the smoke checks. */
export function secondLineConfigured(): boolean {
  return !!config.WHATSAPP_PHONE_NUMBER_ID_SGMY;
}

/**
 * Warns when a conversation's number and the number a message arrived on
 * disagree.
 *
 * It means one person has written to both. There is one record per `waId` and it
 * keeps the number it started on — nothing about the questions turns on that any
 * more, because both numbers run the same flow, but the reply still leaves from
 * a number that is not the one they last wrote to, and that is worth a log line.
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
