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

/** Typed requests for a person. The button is separate; this catches free text. */
const STAFF_WORDS =
  /\b(talk to (staff|someone|a person|human)|speak to (staff|someone|a person)|customer care|call me|agent|manager|ஊழிய|ஆள்\s*கிட்ட|स्टाफ|इंसान|बात कर)/i;

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
  if (STAFF_WORDS.test(raw)) return 'staff';
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
  if (STAFF_WORDS.test(raw)) return { kind: 'staff', reason: 'asked for a person' };

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
        enum: ['matched', 'value', 'staff', 'command', 'unrelated', 'unclear'],
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

function describeQuestion(step: FlowStep, choices: Choice[]): string {
  const lines = [`Question asked: ${step.prompt.en}`];

  if (choices.length) {
    lines.push('', 'Options offered (id — what it means):');
    choices.forEach((c, i) => lines.push(`  ${i + 1}. ${c.id} — ${c.label.en}`));
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

  const validIds = new Set(params.choices.map((c) => c.id));

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
        // Drop anything that was not actually offered. The prompt forbids
        // inventing ids; this is what makes that a guarantee rather than a rule.
        const ids = (Array.isArray(input.option_ids) ? input.option_ids : [])
          .map(String)
          .filter((id) => validIds.has(id));
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
