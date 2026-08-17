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
  glyphLength,
  WA_LIMITS,
  type Choice,
  type Localised,
} from './language.js';
import { assertFlowIsWellFormed, STEPS, type FlowStep } from './flow.js';
import { TRADE_PACKS, DISAMBIGUATIONS } from './trades.js';
import { DOCUMENTS } from './rules.js';

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
  // Rendering adds a Done row to a multi-select and a staff row where the step
  // allows one, so both have to be counted against the limit here.
  const rendered =
    (step.choices?.length ?? 0) + (step.input === 'multi_choice' ? 1 : 0) + (step.allowStaff ? 1 : 0);

  if (step.choices?.length) {
    const options = [...step.choices];
    if (step.input === 'multi_choice') options.push(copy.CHOICE_DONE);
    if (step.allowStaff) options.push(copy.CHOICE_STAFF);
    checkChoices(`step "${step.id}"`, options);
  }

  // The prompt and its hint share one interactive body.
  const budget = rendered > 0 ? WA_LIMITS.body : 4096;
  for (const lang of ['en', 'ta', 'hi'] as const) {
    const length = glyphLength(step.prompt[lang]) + (step.hint ? glyphLength(step.hint[lang]) + 1 : 0);
    if (length > budget) {
      throw new Error(
        `step "${step.id}" [${lang}] is ${length} characters; WhatsApp allows ${budget}.`,
      );
    }
  }
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

  for (const step of STEPS) checkStep(step);

  // Menus are rendered by the same code path as steps, so they get the same
  // treatment — the interpreter never sees them, but the candidate does.
  checkChoices('opening menu', copy.ENTRY_CHOICES);
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
  checkMessage('staff handoff', copy.STAFF_HANDOFF);
  checkMessage('b2b handoff', copy.B2B_HANDOFF);
  checkMessage('deleted', copy.DELETED);
  checkMessage('restarted', copy.RESTARTED);

  // Tracking (§25). The three status replies are plain messages; the two that
  // offer a way out are sent with options and share the interactive body.
  checkMessage('track: ask for id', copy.TRACK_ASK_ID);
  checkMessage('track: pending', copy.TRACK_PENDING);
  checkMessage('track: completed', copy.TRACK_COMPLETED);
  checkMessage('track: rejected', copy.TRACK_REJECTED);
  checkInteractive('track: not found', copy.TRACK_NOT_FOUND);
  checkInteractive('track: not registered', copy.TRACK_NOT_REGISTERED);
  checkInteractive('resume prompt', copy.RESUME_PROMPT);
  checkInteractive('reminder', copy.REMINDER);
  checkInteractive('expired option', copy.OPTION_EXPIRED);
}
