/**
 * Which WhatsApp number a conversation belongs to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  NUMBERS ONLY. WHICH QUESTIONS GET ASKED IS `conversation/flow.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The agency runs five or six numbers and they are all the same bot: the same
 * opening menu, the same consent, the same country question, the same
 * documents, the same tracking, the same handoff to staff — and the same flow.
 * They did differ. One number ran the Singapore/Malaysia questions and the
 * others did not, and a candidate got one flow or the other according to which
 * number they had happened to write to. That split is gone: Singapore and
 * Malaysia are two rows in the one country question, and choosing one is what
 * puts a candidate on that route, from any number. `routeFor` in `flow.ts` is
 * the whole of it.
 *
 * What is left here is everything about a number that stays true whatever
 * questions it asks: a reply has to leave from the number the candidate wrote
 * to, on a token that can see that number, and a webhook has to survive a
 * signature check against the app that owns the subscription.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  A LINE IS A SENDING IDENTITY. IT IS NOT A CANDIDATE IDENTITY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A conversation is stamped with its number when its record is created and
 * keeps it. The record is keyed on `waId` — the number the *candidate* is
 * holding — so one person writing to three of these numbers has one record, and
 * it belongs to whichever they wrote to first. Nothing downstream may key on
 * the line either: see `idempotencyKeyFor` in `crm/mapping.ts`, which is what
 * makes that true of the CRM as well.
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
 * A comma-separated setting, as the list it stands for.
 *
 * Blanks and repeats are dropped rather than rejected: these are edited by hand
 * in a deployment panel, and a trailing comma is not a reason to refuse to boot.
 */
function csv(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((part) => part.trim()).filter(Boolean))];
}

/**
 * Every number the agency runs, in the order they were configured.
 *
 * The main line, the SGMY one where it is set, and everything in
 * `WHATSAPP_ADDITIONAL_PHONE_NUMBER_IDS`. Deduplicated, because the same id
 * named twice is one number and a fleet count that says otherwise is a report
 * somebody will act on.
 *
 * Read by `doctor` and the smoke checks. Nothing about *identity* consults it:
 * a candidate is the number they are holding, and that is the same fact on
 * every line here. See `idempotencyKeyFor` in `crm/mapping.ts`.
 */
export function configuredLines(): string[] {
  return [
    ...new Set(
      [
        config.WHATSAPP_PHONE_NUMBER_ID,
        config.WHATSAPP_PHONE_NUMBER_ID_SGMY,
        ...csv(config.WHATSAPP_ADDITIONAL_PHONE_NUMBER_IDS),
      ].filter((id): id is string => !!id),
    ),
  ];
}

/**
 * The per-line access tokens, as a lookup.
 *
 * `WHATSAPP_ACCESS_TOKEN_SGMY` is folded in here rather than special-cased at
 * the call site, so there is one place a line's token comes from however it was
 * configured. An entry without an `=` is skipped with a warning — silently
 * ignoring it would mean a line quietly running on the wrong token.
 */
function tokenOverrides(): Map<string, string> {
  const map = new Map<string, string>();

  const sgmy = config.WHATSAPP_PHONE_NUMBER_ID_SGMY;
  if (sgmy && config.WHATSAPP_ACCESS_TOKEN_SGMY) {
    map.set(sgmy, config.WHATSAPP_ACCESS_TOKEN_SGMY);
  }

  for (const pair of csv(config.WHATSAPP_ADDITIONAL_ACCESS_TOKENS)) {
    const at = pair.indexOf('=');
    const id = at > 0 ? pair.slice(0, at).trim() : '';
    const token = at > 0 ? pair.slice(at + 1).trim() : '';
    if (!id || !token) {
      logger.warn(
        'WHATSAPP_ADDITIONAL_ACCESS_TOKENS has an entry that is not phoneNumberId=token; ignoring it',
      );
      continue;
    }
    map.set(id, token);
  }

  return map;
}

/**
 * The Graph access token to call on behalf of a line.
 *
 * Numbers under one Meta app share a token, every override stays unset, and
 * this returns the main one — which is the common case and the one every
 * existing deployment is in. Numbers under separate apps do not share one, and
 * a call made with the wrong token is a 401 on that number alone,
 * indistinguishable from outside from the bot ignoring it.
 */
export function accessTokenFor(phoneNumberId: string | undefined): string {
  const override = phoneNumberId ? tokenOverrides().get(phoneNumberId) : undefined;
  return override ?? config.WHATSAPP_ACCESS_TOKEN;
}

/**
 * Every app secret a delivery could legitimately be signed with.
 *
 * Meta signs a webhook with the secret of the app that owns the subscription,
 * and the envelope's signature is checked before anything in it is parsed — so
 * there is no line to look the secret up by yet. Every one of these is ours, so
 * trying all of them widens nothing: a body signed with none is still rejected.
 *
 * One entry unless some line has a secret of its own.
 */
export function webhookSecrets(): string[] {
  return [
    ...new Set(
      [
        config.WHATSAPP_APP_SECRET,
        config.WHATSAPP_APP_SECRET_SGMY,
        ...csv(config.WHATSAPP_ADDITIONAL_APP_SECRETS),
      ].filter((secret): secret is string => !!secret),
    ),
  ];
}

/** Whether the second number is configured at all. Read by `doctor` and the smoke checks. */
export function secondLineConfigured(): boolean {
  return !!config.WHATSAPP_PHONE_NUMBER_ID_SGMY;
}

/**
 * Warns when a conversation's number and the number a message arrived on
 * disagree.
 *
 * It means one person has written to more than one of them. There is one record
 * per `waId` and it keeps the number it started on — nothing about the questions
 * turns on that any more, because every number runs the same flow, but the reply
 * still leaves from a number that is not the one they last wrote to, and that is
 * worth a log line.
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
