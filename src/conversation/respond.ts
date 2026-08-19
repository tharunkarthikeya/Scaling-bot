/**
 * Replying to what the candidate actually said.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE THIRD AND LAST PLACE A MODEL WRITES TO A CANDIDATE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `faq.ts` answers a question that has nothing to do with the one being asked —
 * "is there any fee?" in the middle of the passport questions. This file covers
 * the other half: a reply that *is* about the open question but is not an answer
 * to it.
 *
 *   "my passport is with the agent, I will get it next week"
 *   "what is FCAW?"
 *   "I have TIG but the certificate expired last year"
 *   "is 6 years enough for Europe?"
 *
 * Every one of those is a person engaging with the question in front of them,
 * and every one of them used to be met with "Sorry, I could not use that as an
 * answer" and the same question again — or worse, with an offer to fetch a human
 * because the bot had nothing to say. A form with a chat window around it.
 *
 * It is fenced the same four ways `faq.ts` is, and for the same reasons:
 *
 *   1. GROUNDED.  It sees the question, the options offered, the candidate's
 *      message, and `FAQ`. No candidate record, no vacancy list, no policy
 *      beyond the approved entries. It cannot state a fact it was not given
 *      because it was given nothing else.
 *   2. CHECKED.   Output goes through `violatesGuardrails` — the same guard the
 *      FAQ answers pass — before it is sent. A trip becomes `no_answer` and the
 *      candidate gets the fixed re-ask instead of an invented figure.
 *   3. BOUNDED.   It runs on one branch of one turn, records nothing, and the
 *      open question is re-sent underneath whatever it writes. It can change
 *      what the candidate reads. It cannot change the flow, and it cannot
 *      answer the question on the candidate's behalf.
 *   4. DISCLOSED. Stored in `messages` like any other outbound.
 *
 * `explainWrongDocument` is the same machinery pointed at a different problem:
 * a file arrived in a slot it does not belong in, and the candidate is owed a
 * sentence saying so rather than silence.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { faqContext, violatesGuardrails } from './faq.js';
import { LANGUAGE_NAMES, type Language } from './language.js';
import { TUNABLES } from './rules.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export type RespondOutcome =
  /** Send this, then re-send the open question underneath it. */
  | { kind: 'answered'; text: string }
  /** Nothing safe to say — the caller falls back to its fixed copy. */
  | { kind: 'no_answer' }
  /** Hand the conversation to a person outright. */
  | { kind: 'staff' };

/** Resolves the language name the prompts are told to write in. */
function languageName(language: Language | undefined, languageOther?: string): string {
  if (language && language !== 'other') return LANGUAGE_NAMES[language];
  return languageOther?.trim().slice(0, 40) || 'English';
}

/* ─────────────────────────────────────────────────────────────────────────────
 * A reply about the question we asked
 * ───────────────────────────────────────────────────────────────────────────*/

const IN_CONTEXT_PROMPT = `
You help job candidates who are messaging an overseas recruitment agency, Adira
Enterprises, on WhatsApp. They are part-way through registering, and a question
is open on their screen.

You are given that question, the options it offered, the candidate's message,
and a list of approved answers about the agency. The candidate's message is not
an answer to the question. It is usually about it — querying it, adding a
condition, describing their situation, asking what something means — and
sometimes it is a message nothing could be made of at all.

Your job is one or two short sentences that respond to what they actually said.

Call the tool with kind "answered" and the reply when you have something useful
and grounded to say. Call it with "no_answer" when you do not.

What you may say:

Facts from the approved answers, rephrased and translated as needed.

The plain meaning of the question itself, or of a word in it — an option's name,
a trade term like FCAW or LMV, what "valid passport" means. This is describing
the question that is already on their screen, not new information.

Where the message tells you what the question is about, what it is asking for —
so a candidate who answered about something else knows what to answer instead.
Say it as a clarification and not a correction: they read the question the way
it was written, and the useful reply is the one that gets them to the right
answer rather than the one that points out the wrong one.

That what they described is fine to record, or that they should pick the option
closest to their situation, when the options themselves make that obvious.

Where they say what they are going to do — "I will send my passport", "I will
ask my agent and tell you", "let me check the certificate" — say that is fine
and what to do next, in their terms. Asked when their passport expires, someone
who says they will upload it should be told to go ahead and send it, and that
the date is on it. That is the single most useful thing you can say to them, and
"I could not use that as an answer" is the least.

If the message carries no meaning you can find — a keysmash, a stray fragment,
a forwarded sticker — call the tool with "no_answer". Do not invent a reading of
it, and do not tell them their message was unclear: something else says that,
in their language, and better than a guess would.

What you must never do:

Never answer the question for them, and never say which option they should pick
as though it were their answer. Something else records answers; you only reply.

Never re-ask the question or repeat its options. The question is sent underneath
your reply automatically, so ending with "so, do you have a passport?" puts it
on their screen twice.

Never state a salary, wage, fee or any money amount, even one the candidate
names first. Never say a job, visa, selection or approval is guaranteed,
assured or certain. Never commit to a date or a number of weeks. Never invent
agency policy, a document requirement, a processing time, or anything about
their application that you were not given.

If answering would need a fact you were not given, call the tool with
"no_answer". The candidate then gets the question again with a plain lead line,
which is a worse reply but never a wrong one.

If the candidate sounds angry or distressed, says someone has actually asked
them for money, or raises a legal, medical or safety matter, call the tool with
kind "staff" instead of answering. Asking *whether* there is a fee is not that —
that has an approved answer, so give it.

Writing:

The candidate's language is named in the message. Write in it. Keep to one or
two short sentences — this is WhatsApp, read on a phone, often by someone who
did not finish school. Plain words, no bullet points, no greeting, no sign-off,
no "great question".
`.trim();

const RESPOND_TOOL: Anthropic.Tool = {
  name: 'respond',
  description: 'Reply to what the candidate said about the open question. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['answered', 'no_answer', 'staff'] },
      text: {
        type: 'string',
        description:
          'For "answered": the reply to send, in the candidate\'s language, one or two short sentences.',
      },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

/**
 * Replies to a message that is about the open question without answering it.
 *
 * Every failure path returns `no_answer`, and the caller turns that into the
 * fixed re-ask it would have sent anyway — so an outage costs the warmth of the
 * reply, never the conversation.
 */
export async function respondInContext(params: {
  /** The question on the candidate's screen, in English. */
  question: string;
  /** The option labels offered with it, in English. Empty for a text question. */
  options: string[];
  /**
   * What a specialist question is about, where the step declares it (§8).
   *
   * Without it a reply about the wrong subject can only be met with "that is
   * not an answer"; with it the candidate is told what the question is actually
   * asking, which is the difference between being corrected and being helped.
   */
  context?: string;
  /** What the candidate said instead of answering. */
  message: string;
  language: Language | undefined;
  languageOther?: string;
}): Promise<RespondOutcome> {
  const message = params.message.trim();
  if (!message) return { kind: 'no_answer' };

  const offered = params.options.length
    ? `Options offered:\n${params.options.map((o) => `  - ${o}`).join('\n')}`
    : 'This question has no options — it asks for typed text.';

  // A specialist question says what it is about, so the reply can say it too.
  const about = params.context
    ? `\nWhat this question is about: ${params.context}. Their reply is not about that, which is why it could not be recorded as an answer.`
    : '';

  try {
    const response = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: TUNABLES.maxAnswerTokens,
      system: [
        // Identical on every call and the larger half of the input, so both
        // blocks are cached. Anything per-candidate above this line would kill
        // the cache for every reply — see the same note in `faq.ts`.
        { type: 'text', text: IN_CONTEXT_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: faqContext(), cache_control: { type: 'ephemeral' } },
      ],
      tools: [RESPOND_TOOL],
      tool_choice: { type: 'tool', name: 'respond' },
      messages: [
        {
          role: 'user',
          content:
            `Candidate's language: ${languageName(params.language, params.languageOther)}\n\n` +
            `Question on their screen: ${params.question}\n${offered}${about}\n\n` +
            `They replied:\n${message}`,
        },
      ],
    });

    return readReply(response, 'respond');
  } catch (err) {
    logger.error({ err }, 'in-context reply failed');
    return { kind: 'no_answer' };
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * A file that is not the document we asked for
 * ───────────────────────────────────────────────────────────────────────────*/

const WRONG_DOCUMENT_PROMPT = `
You write one message to a job candidate registering with an overseas
recruitment agency, Adira Enterprises, on WhatsApp.

They uploaded a file where a particular document was asked for, and it is not
that document. You are told which document was asked for and, when it could be
established, what the file appears to be instead.

Write one or two short sentences that say the file is not the document that was
asked for, name what it looks like if you were told, and ask them to send the
right one. Call the tool with kind "answered" and that text.

Be matter-of-fact. This is an easy mistake — the wrong file gets picked from a
gallery of scans every day — so no scolding, no apology, and no suggestion that
anything has gone wrong with their application.

Say only what you were told. If you were not told what the file appears to be,
say it did not look like the document asked for and ask for that document; do
not guess at what they sent. Never say the file was rejected, deleted or lost —
it is kept either way. Never mention verification, approval or any outcome, and
never state a money amount or a timeline.

Write in the candidate's language, named in the message. Plain words, no
greeting, no sign-off.
`.trim();

/**
 * Tells the candidate their upload is not the document that was asked for.
 *
 * The detection is the engine's — this only puts a sentence on it. `no_answer`
 * falls back to the fixed `DOCUMENT_WRONG_TYPE` copy in `copy.ts`, which says
 * the same thing in fewer words and ships in all three languages.
 */
export async function explainWrongDocument(params: {
  /** The document the slot asked for, in the candidate's language. */
  expected: string;
  /** What the upload appears to be, where that could be established. */
  appearsToBe?: string;
  language: Language | undefined;
  languageOther?: string;
}): Promise<RespondOutcome> {
  try {
    const response = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: TUNABLES.maxAnswerTokens,
      system: [{ type: 'text', text: WRONG_DOCUMENT_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [RESPOND_TOOL],
      tool_choice: { type: 'tool', name: 'respond' },
      messages: [
        {
          role: 'user',
          content:
            `Candidate's language: ${languageName(params.language, params.languageOther)}\n\n` +
            `Document asked for: ${params.expected}\n` +
            (params.appearsToBe
              ? `The file appears to be: ${params.appearsToBe}`
              : 'What the file is could not be established.'),
        },
      ],
    });

    return readReply(response, 'wrong document');
  } catch (err) {
    logger.error({ err }, 'wrong-document reply failed');
    return { kind: 'no_answer' };
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Shared tail
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Reads the tool call and guards the text.
 *
 * Not repaired on a trip, for the reason `faq.ts` gives: asking the same model
 * the same question with the same context tends to produce the same sentence.
 */
function readReply(response: Anthropic.Message, what: string): RespondOutcome {
  const call = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'respond',
  );
  if (!call) return { kind: 'no_answer' };

  const input = (call.input ?? {}) as { kind?: string; text?: unknown };

  if (input.kind === 'staff') return { kind: 'staff' };
  if (input.kind !== 'answered') return { kind: 'no_answer' };

  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) return { kind: 'no_answer' };

  const violation = violatesGuardrails(text);
  if (violation) {
    logger.warn({ violation, what }, 'generated reply failed the guardrail; not sent');
    return { kind: 'no_answer' };
  }

  logger.info({ what, chars: text.length }, 'replied in the candidate’s own terms');
  return { kind: 'answered', text };
}
