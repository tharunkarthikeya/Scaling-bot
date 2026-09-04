/**
 * Answering a question the flow did not ask.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE FILE YOU EDIT TO CHANGE WHAT THE BOT CAN ANSWER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Candidates do not only answer questions — they ask them. "Is there any fee?",
 * "how long does this take?", "what documents do I need?". Deflecting all of
 * those to staff is what makes a bot feel like a form with a chat window around
 * it, and it buries the staff inbox in questions that have one settled answer.
 *
 * So this is the second — and last — place a model writes to a candidate. It is
 * generative, and it is fenced on four sides:
 *
 *   1. GROUNDED.  The model sees `FAQ` and nothing else. It is instructed to
 *      answer only from it and to return `no_answer` when the entries do not
 *      cover the question. It has no other knowledge to draw on because it is
 *      given none.
 *   2. CHECKED.   Whatever comes back is run through `violatesGuardrails`
 *      before it is sent. The prompt says never to quote a salary figure; that
 *      function is what makes it true. A tripped guard becomes `no_answer`, and
 *      the candidate gets the staff line instead of an invented number.
 *   3. BOUNDED.   It runs only on the `unrelated` branch of one turn, it cannot
 *      record anything, and the open question is re-sent underneath its answer.
 *      It can change what the candidate reads. It cannot change the flow.
 *   4. DISCLOSED. Every answer is stored in `messages`, like any other outbound,
 *      so what the bot actually said is on the record.
 *
 * The facts live in `FAQ` below, written by a person. Add an entry here rather
 * than loosening the prompt — the prompt is the fence, the entries are the
 * ground.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { LANGUAGE_NAMES, type Language } from './language.js';
import { TUNABLES } from './rules.js';

import { callModel, modelClient } from './model.js';

export interface FaqEntry {
  id: string;
  /** What a candidate asking this sounds like. Matching hints, not copy. */
  asks: string;
  /** The approved facts. The model may rephrase and translate these, nothing more. */
  answer: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The knowledge base
 *
 * Everything the bot is allowed to say in its own words. Each `answer` is the
 * settled position of the agency — write it as you would want it repeated,
 * because it will be.
 *
 * Note what the sensitive entries do. They do not refuse; they give the honest
 * answer *without the number*. "We cannot discuss that" reads as evasion to
 * someone deciding whether to trust an agency with their passport. "It depends
 * on the employer and the role, and staff confirm it before you accept
 * anything" is both true and the thing they actually need to know.
 * ───────────────────────────────────────────────────────────────────────────*/

export const FAQ: FaqEntry[] = [
  {
    id: 'fees',
    asks: 'Is there a fee? Do I have to pay anything? How much does registration cost?',
    answer:
      'Registering with Adira Enterprises is free. We never ask candidates to pay for a job ' +
      'or for registration. If anyone asks you for money in our name, do not pay and keep the evidence.',
  },
  {
    id: 'salary',
    asks: 'What salary will I get? How much will they pay? What is the pay in Dubai/Europe?',
    answer:
      'Pay depends on the employer, the country and the role, so it is not something we can ' +
      'state up front. The exact salary and terms must be stated in an offer before it is accepted.',
  },
  {
    id: 'selection_chance',
    asks: 'Will I get selected? Am I suitable? What are my chances? Will I definitely get a job?',
    answer:
      'Registering does not guarantee selection. Profiles are reviewed against the vacancies ' +
      'currently available.',
  },
  {
    id: 'how_long_registration',
    asks: 'How long does this take? How many questions? Why so many questions?',
    answer:
      'Registration takes about ten minutes. Your answers are saved as you go, so you can stop ' +
      'and continue later from where you left off.',
  },
  {
    id: 'timeline',
    asks: 'When will I get a job? How long until you call me? When will I hear back?',
    answer:
      'It depends on which vacancies are open and which ones match your profile. You can use ' +
      'your Application ID to check the recorded status.',
  },
  {
    id: 'documents_needed',
    asks: 'What documents do I need? Which papers should I send? Do I need to send anything else?',
    answer:
      'Your CV to begin with. For Europe and Russia we also need your passport and Aadhaar ' +
      'for document verification. The bot asks for each one when it is needed, so you do not ' +
      'have to send anything before it is requested.',
  },
  {
    id: 'passport_needed',
    asks: 'Do I need a passport? Can I apply without a passport? My passport is expired.',
    answer:
      'You can register without a passport — the questions cover whether you have one, have ' +
      'applied, or need to apply. A valid passport is needed before you can travel.',
  },
  {
    id: 'no_cv',
    asks: 'I do not have a CV. Can I still apply? How do I make a CV?',
    answer:
      'A CV is helpful but not required. If you do not have one, say so and the questions will ' +
      'collect the same details directly.',
  },
  {
    id: 'countries',
    asks: 'Which countries do you send to? Do you have jobs in Dubai / Europe / Russia?',
    answer:
      'We work with employers in the Gulf countries, Europe, Russia and the CIS, and Singapore ' +
      'and Malaysia. Which vacancies are open changes over time and depends on the trade.',
  },
  {
    id: 'visa_ticket',
    asks: 'Who pays for the visa and ticket? Is the visa free? Will you arrange the visa?',
    answer:
      'Visa and travel arrangements depend on the employer and the offer. Our staff go through ' +
      'exactly what is covered, and what is not, before you accept anything.',
  },
  {
    id: 'change_details',
    asks: 'How do I change my details? I gave a wrong answer. Can I correct something?',
    answer:
      'Send UPDATE at any time to change your details, and DELETE to remove your profile. You ' +
      'can also correct anything at the summary at the end of registration.',
  },
  {
    id: 'data_privacy',
    asks: 'Is my data safe? What will you do with my passport? Who sees my documents?',
    answer:
      'Your details and documents are stored securely and used only to process your application ' +
      'and match you to vacancies. You can ask us to delete your profile at any time by sending ' +
      'DELETE.',
  },
  {
    id: 'contact_hours',
    asks: 'Is anyone there? Can I call you? What are your timings? Is this a real person?',
    answer:
      'This is an automated assistant that collects your details. Our staff read these ' +
      'conversations and will reply here themselves when they need to.',
  },
  {
    id: 'track',
    asks: 'What is happening with my application? Where has my application reached?',
    answer:
      'Once you finish registering you get an application ID. Send that ID here at any time and ' +
      'the current status of your application comes straight back.',
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * The guard
 *
 * The prompt below says never to state a figure or promise an outcome. This is
 * what makes that a guarantee rather than a rule, in the same way that
 * `resolveOfferedIds` is what actually stops the interpreter inventing an
 * option id. A prompt is an instruction; a check is a property.
 *
 * Deliberately blunt, and deliberately biased towards refusing. The cost of a
 * false positive is one staff line the candidate was going to get anyway. The
 * cost of a false negative is an agency quoting a salary it has to honour.
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Negations that make a promise safe.
 *
 * "Registering does not guarantee selection" is not a promise — it is the exact
 * sentence §27 wants said, and the first version of this guard blocked it. A
 * denial has to survive, or the guard silences the very copy it exists to
 * protect. Kept as a lookbehind on the word immediately before, which is where
 * a negation lands in all three languages' English source.
 */
const NEGATED = String.raw`(?<!\b(?:not|never|no|cannot|can't|won't|doesn't|don't|nothing)\s{1,2})`;

const FORBIDDEN = [
  {
    id: 'money_amount',
    // A currency symbol or code next to a number, either order: "AED 4000",
    // "₹50,000", "$1,200", "45,000 rupees", "2 lakh", "35000 INR".
    pattern:
      /(?:₹|\$|€|£|\b(?:aed|sar|qar|kwd|omr|bhd|usd|eur|inr|rs|rupees?|dirhams?|riyals?)\b)\s*[\d][\d,.]*|[\d][\d,.]*\s*(?:₹|\$|€|£|\b(?:aed|sar|qar|kwd|omr|bhd|usd|eur|inr|rs|rupees?|dirhams?|riyals?|lakhs?|lacs?|crores?)\b)/i,
    why: 'quoted a money amount',
  },
  {
    id: 'guarantee',
    pattern: new RegExp(
      `${NEGATED}\\b(?:guarantee[ds]?|assured|definitely (?:get|will)|surely get|certain to get|promise (?:you|that))\\b` +
        // "100%" cannot use a trailing word boundary — the % is not a word
        // character, so \b after it never matches before a space.
        `|\\b100\\s*%`,
      'i',
    ),
    why: 'promised an outcome',
  },
  {
    id: 'timeline_promise',
    // "within 2 weeks", "in three months" — a date the agency cannot commit to
    // on an employer's behalf.
    pattern: new RegExp(
      `${NEGATED}\\b(?:within|in|after|by)\\s+(?:\\d+|a|two|three|four|five|six)\\s+(?:day|week|month|year)s?\\b`,
      'i',
    ),
    why: 'committed to a timeline',
  },
];

/**
 * Whether a generated answer must not be sent. Returns the reason, or undefined.
 *
 * Exported for the smoke checks — this is the fence, so it is worth pinning.
 */
export function violatesGuardrails(text: string): string | undefined {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) return rule.why;
  }
  return undefined;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The prompt
 * ───────────────────────────────────────────────────────────────────────────*/

const ANSWER_PROMPT = `
You answer questions from job candidates messaging an overseas recruitment
agency, Adira Enterprises, on WhatsApp.

You are given a numbered list of approved answers, and one question a candidate
asked in the middle of filling in their registration. Decide whether the
approved answers cover their question.

If they do, call the tool with kind "answered" and write the reply.
If they do not, call it with kind "no_answer". Do not stretch an entry to fit.

Writing the reply:

Say only what the approved answers say. You may rephrase, shorten, combine two
entries, and translate — you may not add a fact that is not in them. If the
candidate asked two things and the entries cover one, answer that one.

Write in the candidate's language, named in the message. Keep it to one or two
short sentences. This is WhatsApp, read on a phone, often by someone who did not
finish school. Plain words, no bullet points, no greeting, no sign-off.

Do not re-ask the registration question. It is sent underneath your answer
automatically, so ending with "now, back to..." duplicates it.

Never state a salary, wage, fee or any money amount, even if the candidate
insists or names one themselves. Never say a job, visa or selection is
guaranteed, assured or certain. Never commit to a date or a number of weeks.
The approved answers already say the right thing about pay, timing and
selection — use them as written rather than going further.

If the candidate sounds angry or distressed, says someone has actually asked
them for money, or raises a legal, medical or safety matter, call the tool with
kind "staff" instead of answering.

Asking about fees is not that. "Is there any fee?" is a question with an
approved answer — give it. "A man asked me for 50,000 rupees for this job" is a
report, and that is what "staff" is for.

When in doubt, "no_answer". A question routed to a person costs one message. A
wrong answer about money or a visa costs the agency far more.
`.trim();

const ANSWER_TOOL: Anthropic.Tool = {
  name: 'answer',
  description: 'Report whether the approved answers cover the question. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['answered', 'no_answer', 'staff'],
      },
      text: {
        type: 'string',
        description:
          'For "answered": the reply to send, in the candidate\'s language, one or two short sentences.',
      },
      used: {
        type: 'string',
        description: 'For "answered": the id of the approved answer you used, for the log.',
      },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

/** The approved list, as the cached grounding block. Shared with `respond.ts`. */
export function faqContext(): string {
  return FAQ.map((e) => `[${e.id}]\nAsked as: ${e.asks}\nApproved answer: ${e.answer}`).join('\n\n');
}

export type FaqOutcome =
  /** Send this text, then re-send the open question underneath it. */
  | { kind: 'answered'; text: string; used?: string }
  /** Nothing approved covers it — the candidate gets the staff line. */
  | { kind: 'no_answer' }
  /** Hand the conversation to a person outright. */
  | { kind: 'staff' };

/**
 * Answers one off-topic question from the approved list.
 *
 * Every failure path returns `no_answer`, which the caller turns into the same
 * "our staff will answer that" line the bot sent before this file existed. A
 * model outage degrades the bot to its old behaviour rather than to silence.
 */
export async function answerFromFaq(params: {
  question: string;
  language: Language | undefined;
  /** The candidate's own words for their language, when they picked "Other". */
  languageOther?: string;
}): Promise<FaqOutcome> {
  const question = params.question.trim();
  if (!question) return { kind: 'no_answer' };

  const language =
    params.language && params.language !== 'other'
      ? LANGUAGE_NAMES[params.language]
      : (params.languageOther?.trim().slice(0, 40) || 'English');

  try {
    const response = await callModel('faq', () =>
      modelClient().messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: TUNABLES.maxAnswerTokens,
      system: [
        // The FAQ is part of the cached prefix: it is identical on every call,
        // and it is the larger half of the input. Putting anything
        // per-candidate above this line would kill the cache for every answer.
        { type: 'text', text: ANSWER_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: faqContext(), cache_control: { type: 'ephemeral' } },
      ],
      tools: [ANSWER_TOOL],
      tool_choice: { type: 'tool', name: 'answer' },
      messages: [
        {
          role: 'user',
          content: `Candidate's language: ${language}\n\nCandidate asked:\n${question}`,
        },
      ],
      }),
    );

    const call = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'answer',
    );
    if (!call) return { kind: 'no_answer' };

    const input = (call.input ?? {}) as { kind?: string; text?: unknown; used?: unknown };

    if (input.kind === 'staff') return { kind: 'staff' };
    if (input.kind !== 'answered') return { kind: 'no_answer' };

    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) return { kind: 'no_answer' };

    const violation = violatesGuardrails(text);
    if (violation) {
      // Not sent, and not repaired. A second attempt at the same question with
      // the same context tends to produce the same sentence.
      logger.warn({ violation, used: input.used }, 'generated answer failed the guardrail; not sent');
      return { kind: 'no_answer' };
    }

    logger.info({ used: input.used, chars: text.length }, 'answered from the approved list');
    return { kind: 'answered', text, used: typeof input.used === 'string' ? input.used : undefined };
  } catch (err) {
    logger.error({ err }, 'faq answer failed');
    return { kind: 'no_answer' };
  }
}
