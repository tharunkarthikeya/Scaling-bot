/**
 * Boot-time checks on the copy.
 *
 * WhatsApp does not truncate an over-long button title — it rejects the whole
 * message, and the candidate gets silence. That failure would appear only when
 * a Tamil speaker reached one particular question, which is the worst possible
 * time to find out.
 *
 * So this runs at startup, walks every question and every menu in all three
 * languages, and throws. A label that is one character too long breaks the
 * deploy rather than one candidate's registration.
 */

import * as copy from './copy.js';
import {
  assertFits,
  assertScript,
  CORE_LANGUAGES,
  glyphLength,
  WA_LIMITS,
  type Choice,
  type Localised,
} from './language.js';
import { assertFlowIsWellFormed, FLOWS, type FlowStep } from './flow.js';
import { TRADE_PACKS, DISAMBIGUATIONS } from './trades.js';
import { assertOcrRoutingIsSafe, DOCUMENTS } from './rules.js';

/** Three or fewer options render as buttons; more render as a list. */
function limitsFor(count: number): { title: number; body: number } {
  return count <= WA_LIMITS.buttons
    ? { title: WA_LIMITS.buttonTitle, body: WA_LIMITS.body }
    : { title: WA_LIMITS.listRowTitle, body: WA_LIMITS.body };
}

function checkChoices(where: string, options: Choice[]): void {
  if (options.length > WA_LIMITS.listRows) {
    throw new Error(
      `${where} offers ${options.length} options; WhatsApp renders at most ` +
        `${WA_LIMITS.listRows} in a list. Split the question or drop an option.`,
    );
  }

  const { title } = limitsFor(options.length);
  const seen = new Set<string>();

  for (const option of options) {
    if (seen.has(option.id)) {
      throw new Error(`${where} offers the option id "${option.id}" twice`);
    }
    seen.add(option.id);

    assertFits(`${where} → option "${option.id}"`, option.label, title);
    if (option.description) {
      assertFits(`${where} → description "${option.id}"`, option.description, WA_LIMITS.listRowDescription);
    }
  }
}

function checkStep(step: FlowStep): void {
  // Rendering adds a Done row to a multi-select, so it has to be counted against
  // the limit here.
  const rendered = (step.choices?.length ?? 0) + (step.input === 'multi_choice' ? 1 : 0);

  if (step.choices?.length) {
    const options = [...step.choices];
    if (step.input === 'multi_choice') options.push(copy.CHOICE_DONE);
    checkChoices(`step "${step.id}"`, options);
  }

  // The prompt and its hint share one interactive body.
  const budget = rendered > 0 ? WA_LIMITS.body : 4096;
  for (const lang of CORE_LANGUAGES) {
    const length = glyphLength(step.prompt[lang]) + (step.hint ? glyphLength(step.hint[lang]) + 1 : 0);
    if (length > budget) {
      throw new Error(
        `step "${step.id}" [${lang}] is ${length} characters; WhatsApp allows ${budget}.`,
      );
    }
  }

  assertScript(`step "${step.id}" prompt`, step.prompt);
  if (step.hint) assertScript(`step "${step.id}" hint`, step.hint);
}

function checkMessage(where: string, text: Localised): void {
  assertFits(where, text, 4096);
}

/** Copy that is sent with buttons or a list, so it shares the interactive body. */
function checkInteractive(where: string, text: Localised): void {
  assertFits(where, text, WA_LIMITS.body);
}

/**
 * Runs every check. Called from `index.ts` and the harness before anything
 * accepts traffic.
 */
export function validateCopy(): void {
  assertFlowIsWellFormed();

  // Not copy, but the same argument for checking it here: a slot that must never
  // be read is a promise, and a promise that is only true until someone edits a
  // table is worth failing a deploy over. See `NEVER_OCR` in `rules.ts`.
  assertOcrRoutingIsSafe();

  // Every flow, and every step in it. The lists share most of their steps, so
  // most are checked twice — which costs nothing and is the only way a question
  // that exists on one line only is checked at all. A button title one glyph
  // over Meta's limit on the second number would otherwise be found by a
  // candidate rather than by the deploy.
  const checked = new Set<FlowStep>();
  for (const steps of Object.values(FLOWS)) {
    for (const step of steps) {
      if (checked.has(step)) continue;
      checked.add(step);
      checkStep(step);
    }
  }

  // Menus are rendered by the same code path as steps, so they get the same
  // treatment — the interpreter never sees them, but the candidate does.
  checkChoices('opening menu', copy.ENTRY_CHOICES);
  checkChoices('forgotten id', [copy.CHOICE_FORGOT_ID]);
  checkChoices('"Other" menu', copy.OTHER_CHOICES);
  checkChoices('resume prompt', copy.RESUME_CHOICES);
  checkChoices('confirmation', copy.CONFIRM_CHOICES);
  checkChoices('edit menu', copy.EDIT_CHOICES);
  checkChoices('returning menu', copy.RETURNING_CHOICES);
  checkChoices('reminder', copy.REMINDER_CHOICES);
  checkChoices('update menu', copy.UPDATE_CHOICES);
  checkChoices('delete confirmation', copy.DELETE_CHOICES);

  for (const pack of TRADE_PACKS) {
    for (const question of pack.questions) {
      if (!question.choices.length) continue;
      const options = [...question.choices];
      if (question.multi) options.push(copy.CHOICE_DONE);
      checkChoices(`trade question "${pack.id}:${question.id}"`, options);
    }
  }

  for (const d of DISAMBIGUATIONS) {
    checkChoices(`trade disambiguation "${d.trade}"`, d.choices);
  }

  for (const doc of DOCUMENTS) {
    checkMessage(`document label "${doc.id}"`, doc.label);
  }

  // Anything sent as a plain message. Only the outright absurd fails here; the
  // point is to catch a copy edit that pasted in a wall of text.
  checkMessage('welcome', copy.WELCOME);
  checkMessage('completion', copy.COMPLETED);
  checkMessage('consent declined', copy.CONSENT_DECLINED);
  checkMessage('identity mismatch', copy.IDENTITY_MISMATCH);
  // Carries a number and a two-clause instruction in five scripts; the one
  // most likely to outgrow a bubble if it is ever reworded.
  checkMessage('file too large', copy.FILE_TOO_LARGE);
  checkMessage('staff handoff', copy.STAFF_HANDOFF);
  checkMessage('b2b welcome', copy.B2B_WELCOME);
  checkMessage('b2b complete', copy.B2B_COMPLETE);
  checkMessage('deleted', copy.DELETED);
  checkMessage('restarted', copy.RESTARTED);

  // Tracking (§25). The three status replies are plain messages; the two that
  // offer a way out are sent with options and share the interactive body.
  checkMessage('track: ask for id', copy.TRACK_ASK_ID);
  checkMessage('track: pending', copy.TRACK_PENDING);
  checkMessage('track: completed', copy.TRACK_COMPLETED);
  checkMessage('track: rejected', copy.TRACK_REJECTED);
  checkMessage('track: not found', copy.TRACK_NOT_FOUND);
  checkInteractive('track: not found, offering the lookup', copy.TRACK_NOT_FOUND_FORGOT);
  checkMessage('track: ask for the mobile number', copy.TRACK_FORGOT_ASK_MOBILE);
  checkMessage('track: ask for the date of birth', copy.TRACK_FORGOT_ASK_DOB);
  checkMessage('track: id recovered', copy.TRACK_FORGOT_FOUND);
  checkMessage('track: details did not match', copy.TRACK_FORGOT_NO_MATCH);
  checkMessage('staff intake: opening', copy.STAFF_INTAKE_START);
  checkMessage('staff intake: complete', copy.STAFF_INTAKE_COMPLETE);
  checkInteractive('track: not registered', copy.TRACK_NOT_REGISTERED);
  // The identity check in front of a status (§25, §27).
  checkMessage('track: ask for date of birth', copy.TRACK_ASK_DOB);
  checkMessage('track: date of birth unreadable', copy.TRACK_DOB_UNREADABLE);
  checkMessage('track: date of birth wrong', copy.TRACK_DOB_WRONG);
  // Both of these go out with the staff button attached, so they are held to
  // the interactive body limit rather than the plain-message one.
  checkInteractive('track: out of attempts', copy.TRACK_DOB_EXHAUSTED);
  checkInteractive('track: nothing to verify against', copy.TRACK_CANNOT_VERIFY);
  checkInteractive('resume prompt', copy.RESUME_PROMPT);
  checkInteractive('reminder', copy.REMINDER);
  checkInteractive('expired option', copy.OPTION_EXPIRED);
  checkInteractive('"Other" menu prompt', copy.OTHER_PROMPT);
}
