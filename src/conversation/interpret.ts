/**
 * Reading what the candidate said.
 *
 * This is the only place a model is used, and the only thing it can return is a
 * classification — an option id, a normalised value, or "I could not tell". It
 * never produces a sentence, so no output of the model is ever forwarded to a
 * candidate. That is the structural reason the bot cannot go off-topic.
 *
 * Most turns never reach the model at all. A tapped button already carries its
 * option id, and a typed reply that matches an offered label, or is the number
 * of an offered row, is resolved by comparison. The model is for the rest:
 * "naan welder, 6 varusham", "mera passport expire ho gaya", "chennai la irukken".
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Choice } from './language.js';
import { CORE_LANGUAGES } from './language.js';
import type { FlowStep } from './flow.js';
import { INTERPRETER_PROMPT, TUNABLES } from './rules.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export type Interpretation =
  | { kind: 'matched'; ids: string[]; raw: string }
  | { kind: 'value'; value: string; raw: string }
  | { kind: 'structured'; fields: Record<string, string>; raw: string }
  | { kind: 'staff'; reason: string }
  | { kind: 'command'; command: 'update' | 'delete'; raw: string }
  | { kind: 'unrelated'; raw: string }
  /** About the question we asked, but not an answer to it. See `respond.ts`. */
  | { kind: 'related'; raw: string }
  | { kind: 'unclear'; raw: string };

export interface InterpretParams {
  step: FlowStep;
  /** Everything the candidate can validly choose, including hidden options. */
  choices: Choice[];
  /** The candidate's message. Empty for a media-only message. */
  text: string;
  /** The option id carried by a tapped button or list row, when there was one. */
  replyId?: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Deterministic paths
 *
 * Everything resolved here is resolved exactly, for free, and identically every
 * time. Only what falls through reaches the model.
 * ───────────────────────────────────────────────────────────────────────────*/

const UPDATE_WORDS = /^\s*(update|अपडेट|புதுப்பி)\s*$/i;
const DELETE_WORDS = /^\s*(delete|remove|डिलीट|हटाओ|நீக்கு)\s*$/i;

/**
 * Typed requests for a person. The button is separate; this catches free text.
 *
 * Every one of these needs the *asking* as well as the noun, and that is the
 * whole point. "Agent" and "manager" on their own are ordinary words in this
 * conversation — "my passport is with the agent", "I was a production manager
 * for five years" — and matching them bare handed a candidate to staff for
 * answering the trade question with their own job title. Silently: the handoff
 * happens before the interpreter is ever called, so nothing downstream could
 * undo it, and what staff saw was someone who had said nothing to them.
 *
 * The window between verb and noun is short on purpose. "Speak" fourteen
 * characters from "manager" is a request; the same two words in a sentence
 * about a previous job are further apart.
 *
 * The Tamil and Hindi phrases carry no `\b`, because JavaScript's `\b` is
 * ASCII-only: there is never a word boundary before a Tamil or Devanagari
 * letter, so anchoring them that way meant a candidate typing the Tamil label
 * of the Talk to staff button was not understood in the language the button
 * was written in.
 */
const STAFF_REQUESTS: RegExp[] = [
  /\b(?:talk|speak|chat|connect|transfer|put me through|pass me|forward me)\b[^.?!\n]{0,14}\b(?:staff|someone|somebody|person|human|agent|manager|executive|representative|operator)\b/i,
  /\b(?:need|want|get|give)\b[^.?!\n]{0,16}\b(?:staff|human|real person|customer care)\b/i,
  /\bcustomer\s*(?:care|service|support)\b|\bhelp\s*?line\b/i,
  // "call me back" is a request. "call me at 98765" is a phone number they are
  // giving us at the contact question, and used to be read as one.
  /\b(?:call|ring|phone)\s+me\b(?!\s*(?:at|on|as)\b)/i,
  /ஊழிய|ஆள்\s*கிட்ட|நபரிடம்|மனிதர்|स्टाफ|इंसान|किसी\s*व्यक्ति|बात\s*कर/,
];

/** Whether a typed message is asking to be put through to a person. */
export function asksForStaff(text: string): boolean {
  return STAFF_REQUESTS.some((p) => p.test(text));
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Yes/no in the three supported languages plus the romanisations candidates actually type. */
const AFFIRMATIVE = new Set(
  [
    'y', 'ya', 'yes', 'yeah', 'yep', 'ok', 'okay', 'k', 'sure', 'correct', 'right', 'done',
    'ஆம்', 'சரி', 'ஓகே', 'aam', 'sari', 'seri', 'aamaa',
    'हाँ', 'हां', 'जी', 'ठीक', 'haan', 'ha', 'ji', 'thik', 'theek',
  ].map(normalise),
);

const NEGATIVE = new Set(
  ['n', 'no', 'nope', 'nahi', 'illai', 'இல்லை', 'வேண்டாம்', 'नहीं', 'ना', 'nahin'].map(normalise),
);

/**
 * Commands that work at any point in the conversation (§22, §23, §24).
 *
 * Checked before the current question, because a candidate typing DELETE while
 * being asked about welding processes means DELETE. Matched by comparison
 * rather than by the model, so these never fail to be recognised.
 */
export function detectGlobalCommand(
  text: string | undefined,
  replyId?: string,
): 'update' | 'delete' | 'staff' | undefined {
  if (replyId === 'staff') return 'staff';
  if (replyId === 'update') return 'update';
  if (replyId === 'delete') return 'delete';

  const raw = (text ?? '').trim();
  if (!raw) return undefined;

  if (UPDATE_WORDS.test(raw)) return 'update';
  if (DELETE_WORDS.test(raw)) return 'delete';
  if (asksForStaff(raw)) return 'staff';
  return undefined;
}

/**
 * Resolves a reply without calling the model, when that is possible with
 * certainty. Returns undefined when it is not.
 */
function resolveLocally(params: InterpretParams): Interpretation | undefined {
  const { step, choices, text, replyId } = params;
  const raw = text.trim();

  // A tap. The id came from the message we sent, so there is nothing to infer.
  if (replyId) {
    if (replyId === 'staff') return { kind: 'staff', reason: 'tapped Talk to staff' };
    if (choices.some((c) => c.id === replyId) || replyId === '__done') {
      return { kind: 'matched', ids: [replyId], raw: raw || replyId };
    }
  }

  if (!raw) return undefined;

  if (UPDATE_WORDS.test(raw)) return { kind: 'command', command: 'update', raw };
  if (DELETE_WORDS.test(raw)) return { kind: 'command', command: 'delete', raw };
  if (asksForStaff(raw)) return { kind: 'staff', reason: 'asked for a person' };

  if (!choices.length) return undefined;

  const normalised = normalise(raw);

  // An exact match against an offered label, in any of the three languages —
  // candidates on older clients retype the option rather than tapping it.
  for (const choice of choices) {
    for (const lang of CORE_LANGUAGES) {
      if (normalise(choice.label[lang]) === normalised) {
        return { kind: 'matched', ids: [choice.id], raw };
      }
    }
  }

  // "2" means the second option shown.
  const asIndex = Number(normalised);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= choices.length) {
    return { kind: 'matched', ids: [choices[asIndex - 1]!.id], raw };
  }

  // A bare yes or no, where the step offers one.
  const yesChoice = choices.find((c) => c.id === 'yes');
  const noChoice = choices.find((c) => c.id === 'no');
  if (yesChoice && AFFIRMATIVE.has(normalised)) return { kind: 'matched', ids: [yesChoice.id], raw };
  if (noChoice && NEGATIVE.has(normalised)) return { kind: 'matched', ids: [noChoice.id], raw };

  return undefined;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The model path
 * ───────────────────────────────────────────────────────────────────────────*/

const INTERPRET_TOOL: Anthropic.Tool = {
  name: 'interpret',
  description: 'Report what the candidate’s reply means. Call this exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      classification: {
        type: 'string',
        enum: ['matched', 'value', 'staff', 'command', 'related', 'unrelated', 'unclear'],
      },
      option_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For "matched": the ids of the options the reply corresponds to. Only ids that were offered.',
      },
      value: {
        type: 'string',
        description:
          'For "value": the normalised answer. A date as YYYY-MM-DD, a month as MM/YYYY, otherwise the answer in plain text.',
      },
      fields: {
        type: 'object',
        description:
          'For "value" on a question that asked for named parts: each part the reply supplies. Omit a part the reply does not mention rather than guessing it.',
        additionalProperties: { type: 'string' },
      },
      command: { type: 'string', enum: ['update', 'delete'] },
      reason: {
        type: 'string',
        description: 'For "staff": one short sentence on why, for the staff member picking this up.',
      },
    },
    required: ['classification'],
    additionalProperties: false,
  },
};

/**
 * Turns what the model returned into ids that were genuinely offered.
 *
 * Two jobs. It drops anything that was not on the list — the prompt forbids
 * inventing ids, and this is what makes that a guarantee rather than a rule.
 * And it recovers a bare position: models classify the reply correctly and then
 * answer with the option's place in the list rather than its id. Discarding
 * that turned a right answer into "unclear" and re-asked a question the
 * candidate had already answered — silently, for every free-text reply to every
 * choice question.
 *
 * A position is resolved against the same offered list, so this cannot widen
 * what the model is able to choose.
 */
export function resolveOfferedIds(returned: unknown, choices: Choice[]): string[] {
  const valid = new Set(choices.map((c) => c.id));

  return (Array.isArray(returned) ? returned : [])
    .map(String)
    .map((id) => {
      if (valid.has(id)) return id;

      const position = Number(id);
      if (Number.isInteger(position) && position >= 1 && position <= choices.length) {
        const recovered = choices[position - 1]!.id;
        logger.debug({ returned: id, recovered }, 'interpreter answered with a position');
        return recovered;
      }
      return undefined;
    })
    .filter((id): id is string => id !== undefined);
}

function describeQuestion(step: FlowStep, choices: Choice[]): string {
  const lines = [`Question asked: ${step.prompt.en}`];

  // Work questions get an explicit test before anything else, because the
  // failure they had was silent and expensive: a candidate answering "type
  // writer" was told to contact staff about their own answer, and the question
  // was asked again.
  if (step.acceptsOccupation) {
    lines.push(
      '',
      'THIS QUESTION IS ABOUT WORK. Before anything else, decide one thing: does',
      'the reply name a job, trade, skill, tool, machine or workplace?',
      '',
      'Count anything a person could be paid to do, however it is written —',
      '"type writer" (typist), "parota master", "JCB operator", "AC mechanic",',
      '"loading unloading", "computer work", "tailoring", "driver cum helper".',
      'Spelling, English and word order will be rough. A trade named in Tamil or',
      'Hindi, or romanised, counts the same.',
      '',
      'If it names work, it is an answer. Never classify it "unrelated".',
    );

    lines.push(
      '',
      step.acceptsOccupation === 'category'
        ? 'The options offered are categories of work, so a named job belongs inside\n' +
          'one of them — return that id. Fall back to "value" only when no category\n' +
          'genuinely covers it.'
        : 'The options offered are NOT job names — they describe how the work relates\n' +
          'to what the candidate already does. So a specific job the candidate names\n' +
          'is never one of them: return it as a "value" in their own words. Choosing\n' +
          'the nearest-sounding option instead throws away the only thing they told\n' +
          'us. Return an id only when the reply really is one of those options.',
    );

    lines.push(
      '',
      'Only if it names no work at all — a greeting, a question, small talk — go',
      'on to the other classifications.',
    );
  }

  if (choices.length) {
    // Not numbered. A leading "1." reads as the option's identifier, and the
    // model returns "1" instead of the id — which then fails validation and a
    // correctly classified answer is thrown away as unclear.
    lines.push('', 'Options offered. Return the id exactly as written on the left:');
    choices.forEach((c) => lines.push(`  ${c.id}  =  ${c.label.en}`));
    lines.push(
      '',
      step.input === 'multi_choice'
        ? 'The candidate may choose several. Return every id their reply covers.'
        : 'The candidate chooses one.',
    );
  }

  switch (step.input) {
    case 'date':
      lines.push('', 'This question wants a date. Return it as YYYY-MM-DD in `value`.');
      break;
    case 'month_year':
      lines.push('', 'This question wants a month and year. Return it as MM/YYYY in `value`.');
      break;
    case 'structured':
      lines.push(
        '',
        `This question wants these parts: ${(step.fields ?? []).join(', ')}. ` +
          'Return the ones the reply actually supplies, in `fields`. Leave out any it does not.',
      );
      break;
    case 'text':
      lines.push('', 'This question wants free text. Return it, tidied up, in `value`.');
      break;
    case 'document':
      lines.push(
        '',
        'This question asked for a file. The candidate replied with words instead — work out ' +
          'whether they are refusing, promising it later, or choosing one of the options.',
      );
      break;
  }

  return lines.join('\n');
}

/**
 * Classifies one reply.
 *
 * Falls back to 'unclear' on any failure. An unclear answer costs one re-asked
 * question; a wrongly-confident one is written into a candidate's permanent
 * record, so every failure path here resolves towards asking again.
 */
export async function interpret(params: InterpretParams): Promise<Interpretation> {
  const local = resolveLocally(params);
  if (local) return local;

  const raw = params.text.trim();
  if (!raw) return { kind: 'unclear', raw };

  try {
    const response = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: TUNABLES.maxInterpretTokens,
      system: [
        { type: 'text', text: INTERPRETER_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: [INTERPRET_TOOL],
      // Forced, so the reply is always a parseable object rather than prose.
      tool_choice: { type: 'tool', name: 'interpret' },
      messages: [
        {
          role: 'user',
          content: `${describeQuestion(params.step, params.choices)}\n\nCandidate's reply:\n${raw}`,
        },
      ],
    });

    const call = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'interpret',
    );
    if (!call) {
      logger.warn({ step: params.step.id }, 'interpreter returned no tool call');
      return { kind: 'unclear', raw };
    }

    const input = (call.input ?? {}) as {
      classification?: string;
      option_ids?: unknown;
      value?: unknown;
      fields?: unknown;
      command?: unknown;
      reason?: unknown;
    };

    switch (input.classification) {
      case 'matched': {
        const ids = resolveOfferedIds(input.option_ids, params.choices);
        if (!ids.length) return { kind: 'unclear', raw };
        return {
          kind: 'matched',
          ids: params.step.input === 'multi_choice' ? ids : ids.slice(0, 1),
          raw,
        };
      }

      case 'value': {
        const fields =
          input.fields && typeof input.fields === 'object'
            ? Object.fromEntries(
                Object.entries(input.fields as Record<string, unknown>)
                  .filter(([, v]) => typeof v === 'string' && v.trim())
                  .map(([k, v]) => [k, String(v).trim()]),
              )
            : {};

        if (params.step.input === 'structured') {
          if (!Object.keys(fields).length) return { kind: 'unclear', raw };
          return { kind: 'structured', fields, raw };
        }

        const value = typeof input.value === 'string' ? input.value.trim() : '';
        if (!value) return { kind: 'unclear', raw };
        return { kind: 'value', value, raw };
      }

      case 'staff':
        return {
          kind: 'staff',
          reason: typeof input.reason === 'string' ? input.reason : 'candidate asked for a person',
        };

      case 'command':
        return input.command === 'delete'
          ? { kind: 'command', command: 'delete', raw }
          : { kind: 'command', command: 'update', raw };

      case 'related':
        return { kind: 'related', raw };

      case 'unrelated':
        return { kind: 'unrelated', raw };

      default:
        return { kind: 'unclear', raw };
    }
  } catch (err) {
    logger.error({ err, step: params.step.id }, 'interpretation failed');
    return { kind: 'unclear', raw };
  }
}
