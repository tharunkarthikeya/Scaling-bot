/**
 * Trade questions for a job no pack covers (§8).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE ONE PLACE THE MODEL WRITES A QUESTION. READ THE FENCE BEFORE EDITING.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `trades.ts` holds hand-written packs for the trades this agency places most —
 * a welder is asked about welding processes, a driver about licence classes.
 * Everyone else got nothing: an electrician, a cook, a tailor, a nurse, a
 * barber answered "what is your main job?" and then went straight to the
 * preference questions, and the profile a recruiter opened said what the
 * candidate does and not one thing about how well they do it.
 *
 * Writing a pack for every trade in the world is not a plan. So for a job no
 * pack covers, the questions are written per candidate — and because that is
 * the model composing candidate-facing text that answers get recorded against,
 * it is the most carefully fenced thing in this codebase:
 *
 *   1. GROUNDED.   It is told one thing: the job, in the candidate's own words.
 *      No name, no CV, no documents, no history. It cannot reference a
 *      candidate detail because it has none.
 *   2. BOUNDED.    Two to four questions, once per candidate, about their work
 *      and nothing else. `FORBIDDEN_SUBJECTS` is a hard filter over the
 *      returned text, not an instruction — anything touching pay, documents,
 *      identity, health or protected characteristics is dropped before it can
 *      be asked. The flow owns everything else and is unchanged.
 *   3. CHECKED.    Every question and every option passes `violatesGuardrails`
 *      and the WhatsApp length limits before it is stored. A question that
 *      fails is dropped, not repaired.
 *   4. RECORDED.   Questions are stored on the candidate before they are asked,
 *      so what was asked is auditable, identical on every re-ask, and reviewable
 *      by staff next to the answers.
 *
 * Every failure path returns an empty list, and an empty list means the
 * candidate is asked no trade questions — exactly what happened before this
 * file existed. A model outage costs depth of profile, never the registration.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { GeneratedQuestion } from '../db/models.js';
import { violatesGuardrails } from './faq.js';
import { hasForeignScript, LANGUAGE_NAMES, WA_LIMITS, type Language } from './language.js';
import { TUNABLES } from './rules.js';

export type { GeneratedQuestion };

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/** Most questions any candidate is asked about their trade. */
export const MAX_GENERATED_QUESTIONS = 4;

/**
 * Subjects a generated question may never touch.
 *
 * The prompt says all of this too. This is what makes it true — the same
 * relationship `violatesGuardrails` has to `ANSWER_PROMPT`. Two kinds of thing
 * are here and they are here for different reasons:
 *
 * Pay, visas, documents, identity numbers, availability, destination and
 * education are asked *elsewhere*, by the flow, in wording a person wrote. A
 * generated question about them is a duplicate at best and a contradiction at
 * worst.
 *
 * Age, gender, religion, caste, marital status, family, health and disability
 * are not asked at all, by anyone, ever. An agency that screens on them is
 * breaking the law in most of the countries it places into, and a bot that asks
 * on its behalf has put that in writing on the candidate's phone.
 *
 * Note how much of this is phrases rather than words, and why. A bare word list
 * blocks the trade it is trying to protect: "single" is marital status and it is
 * also single-phase power, "health" is a medical condition and it is also health
 * and safety training, "medical" is a fitness test and it is also medical gas
 * piping, "join" is a start date and it is also how two pieces of steel are
 * joined, "charge" is a fee and it is also a chargehand. Each of those blocked a
 * question a recruiter genuinely needed answered. So the risky word alone is
 * never enough — the pattern has to see the sense it is banning.
 */
/**
 * Whether a generated question strays off the candidate's trade.
 *
 * Exported for the smoke checks: it decides what a candidate is asked, and both
 * directions matter — the questions it must stop, and the trade vocabulary it
 * must not mistake for them.
 */
export function offLimits(text: string): boolean {
  return FORBIDDEN_SUBJECTS.test(text);
}

const FORBIDDEN_SUBJECTS = new RegExp(
  [
    // Money, in any of the forms a question about it takes.
    String.raw`\b(?:salary|wage|wages|pay|payment|stipend|remunerat\w*)\b`,
    String.raw`\b(?:fee|fees|rupees?|lakhs?|crores?|dirhams?|riyals?)\b`,
    String.raw`\bhow much (?:do|does|will|would|are)\b`,
    String.raw`\b(?:cost|charge|charges|price)\s+(?:for|of|to)\b`,
    // Documents and identity. The flow collects every one of these itself.
    String.raw`\b(?:passport|visa|aadhaar|aadhar|pan\s*card|identity|id\s*(?:card|proof|number))\b`,
    String.raw`\b(?:document|documents|certificate\s*cop(?:y|ies)|photocopy)\b`,
    String.raw`\b(?:send|upload|share|attach)\s+(?:me\s+)?(?:a|your|the)\b`,
    // Questions the registration already asks, in wording a person wrote.
    String.raw`\bwhen\s+can\s+you\s+(?:join|start)\b|\bjoining\s+date\b|\bnotice\s+period\b`,
    String.raw`\b(?:which|what)\s+country\b|\bwork\s+abroad\b|\bgo\s+overseas\b`,
    String.raw`\bhighest\s+qualification\b|\byour\s+(?:education|schooling)\b|\beducation(?:al)?\s+(?:level|background)\b`,
    String.raw`\bwhich\s+(?:school|college)\b|\bwhat\s+(?:school|college)\b|\bdid\s+you\s+study\b`,
    String.raw`\bhow\s+many\s+years\b|\byears\s+of\s+experience\b`,
    // Things nobody may ask, in any wording.
    String.raw`\bhow\s+old\s+are\s+you\b|\byour\s+age\b|\bage\s+group\b|\bdate\s+of\s+birth\b|\bbirthday\b`,
    String.raw`\b(?:gender|sex)\b|\bmale\s+or\s+female\b`,
    String.raw`\b(?:religion|caste|nationality\s+group)\b|\bwhich\s+community\b`,
    String.raw`\bmarital\b|\b(?:are|is)\s+you\s+married\b|\bmarried\s+or\s+single\b|\bsingle\s+or\s+married\b`,
    String.raw`\b(?:wife|husband|spouse)\b|\byour\s+famil\w*\b|\bhow\s+many\s+children\b|\bdo\s+you\s+have\s+children\b`,
    String.raw`\bpregnan\w*\b`,
    String.raw`\byour\s+health\b|\bhealth\s+(?:condition|problem|issue)\w*\b|\bmedical\s+(?:condition|history|fitness|check|test|report)\b`,
    String.raw`\b(?:disabilit\w*|illness|blood\s*group)\b`,
  ].join('|'),
  'i',
);

/* ─────────────────────────────────────────────────────────────────────────────
 * The prompt
 * ───────────────────────────────────────────────────────────────────────────*/

const QUESTION_PROMPT = `
You write screening questions for Adira Enterprises, an agency that places
Indian workers in overseas jobs. Candidates answer on WhatsApp, on a phone,
often having left school early.

You are given one thing: a candidate's job, in their own words. It may be a
skilled trade, a machine operator's role, an office profession, a technical or
creative role, a healthcare role, a service job, a supervisory title, or a job
title you have never seen. Read it the way an employer hiring for it would.

Work it out first, then decide what to ask.

Step one: what is this job, actually? What does a person in it do all day, and
what would a hiring manager need to know to tell a strong one from a weak one?

Step two: which of these separate one worker from another IN THIS JOB —

  the qualification, course or training the work is learned through
  a licence, registration or certification needed to do it
  the specialisation within the job
  the tools, machines, materials, software or systems they work with
  the kind of workplace or industry they have done it in
  the kind of work they have done, as distinct from how long

Step three: ask about the two to four that matter most here. Not the same ones
every time — what decides everything in one job is irrelevant in the next. A
licence class is the whole question for a driver and meaningless for a
designer. Which software they use decides an accountant's level and tells you
nothing about a mason. A speciality matters enormously to a nurse and barely at
all to a general helper.

The same method, applied to different work:

  electrician        what kind of wiring, what licence they hold, what systems
                     and equipment they have worked on
  accountant         what accounting qualification, which software, whether
                     they work in audit, tax, payroll or accounts
  graphic designer   what design training, which software, what kind of work —
                     print, branding, packaging, digital
  plumber            what plumbing training, what systems and materials, what
                     kind of sites, whether they hold a certificate
  physiotherapist    whether they are registered, which speciality, what
                     setting — hospital, clinic, home visits

Never assume. Do not ask which licence they hold — ask whether they hold one.
Do not ask what their speciality is as though they have one — ask whether they
specialise, and in what. Many candidates learned their trade on site and hold
nothing on paper, and a question written as though they must costs an honest
answer. Where you give options for a question like that, one of them must mean
"I do not have one".

If what you are given is a broad category rather than a job — "Electrical /
Mechanical", "Factory / Warehouse", "Construction" — your first question is the
one that narrows it to what they actually do.

Rules, all of them absolute:

Ask only about their work. Never about pay, fees or money. Never about a
passport, visa, identity document or a copy of a certificate. Never about when
they can join or which country they want. Never about their schooling, their
highest qualification, or how many years they have worked — the registration
asks all of that itself, in wording a person wrote. A professional
qualification, course or certificate *for this trade* is different, and is
worth asking about.

Never about age, date of birth, gender, religion, caste, marital status,
family, children, pregnancy, health or disability. Not in any wording, not for
any reason, not even where an employer would want to know.

Never promise anything, never mention a figure, never suggest one answer is
better than another. You are asking, not assessing.

One sentence per question, plain words, no jargon the candidate would not use
themselves. Write in the candidate's language, named in the message.

Where the sensible answers are a small fixed set, give two to six options, each
at most 20 characters — they become buttons on the candidate's phone. Where the
answer is open, such as which machines or which certificates, give no options
and let them type. Never add "Other"; that is added for you.

Give each question a short lowercase id in English, like "wiring_type" or
"accounting_software". Ids are stored with the answers, so keep them descriptive.

If the job is too vague to ask anything useful about — "work", "any job",
"labour" — return no questions at all. A vague question produces an answer
nobody can use and costs the candidate a turn.
`.trim();

const QUESTIONS_TOOL: Anthropic.Tool = {
  name: 'questions',
  description: 'Return the screening questions for this trade. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short lowercase English key, e.g. "wiring_type".' },
            question: { type: 'string', description: "One sentence, in the candidate's language." },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Two to six options of at most 20 characters, or omitted for a typed answer.',
            },
          },
          required: ['id', 'question'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * The filter
 * ───────────────────────────────────────────────────────────────────────────*/

const ID_SHAPE = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * Keeps a question only if every part of it is safe to send and to store.
 *
 * Deliberately drops rather than trims. A question cut to fit reads as a
 * question, and a candidate cannot tell that the half of it deciding what they
 * were being asked has gone.
 */
function usable(
  raw: { id?: unknown; question?: unknown; options?: unknown },
  language: Language | undefined,
): GeneratedQuestion | undefined {
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  const prompt = typeof raw.question === 'string' ? raw.question.trim() : '';

  if (!ID_SHAPE.test(id)) return undefined;
  if (prompt.length < 8 || prompt.length > WA_LIMITS.body) return undefined;

  if (FORBIDDEN_SUBJECTS.test(prompt)) {
    logger.warn({ id, prompt }, 'generated trade question touched a forbidden subject; dropped');
    return undefined;
  }
  const violation = violatesGuardrails(prompt);
  if (violation) {
    logger.warn({ id, violation }, 'generated trade question failed the guardrail; dropped');
    return undefined;
  }

  // Written in the candidate's language, with a letter of a different Indic
  // script in the middle of a word. It happens often enough to matter — a Tamil
  // question came back with Bengali characters inside two of its words — and it
  // is not a typo a reader can see past: it is a glyph that does not belong to
  // the alphabet they read, on a phone, from an agency they are deciding
  // whether to trust with their passport. The same check runs at boot over the
  // written copy; this is its runtime half.
  if (hasForeignScript(prompt, language)) {
    logger.warn({ id, prompt }, 'generated trade question mixed scripts; dropped');
    return undefined;
  }

  const options = (Array.isArray(raw.options) ? raw.options : [])
    .filter((o): o is string => typeof o === 'string')
    .map((o) => o.trim())
    .filter(
      (o) =>
        o.length > 0 &&
        // The button-title limit, which is the tighter of the two: three or
        // fewer options render as buttons, and a longer title is refused by the
        // Graph API — the whole question then fails to send.
        o.length <= WA_LIMITS.buttonTitle &&
        !FORBIDDEN_SUBJECTS.test(o) &&
        !violatesGuardrails(o) &&
        // An option is droppable on its own; the question survives without it.
        !hasForeignScript(o, language),
    )
    .slice(0, 6);

  // One option is not a choice, it is a leading question.
  return { id, prompt, options: options.length >= 2 ? options : [] };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Generation
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Writes the trade questions for one candidate's job.
 *
 * Called once per candidate, and only when no hand-written pack covers what they
 * do. Returns an empty array on any failure, on a job too vague to ask about,
 * and on everything the filter rejects — all of which mean the same thing to the
 * flow: no trade questions, carry on.
 */
export async function questionsForOccupation(params: {
  /** The job, in the candidate's own words. */
  occupation: string;
  language: Language | undefined;
  languageOther?: string;
}): Promise<GeneratedQuestion[]> {
  const occupation = params.occupation.trim().slice(0, 120);
  if (occupation.length < 2) return [];

  const language =
    params.language && params.language !== 'other'
      ? LANGUAGE_NAMES[params.language]
      : (params.languageOther?.trim().slice(0, 40) || 'English');

  try {
    const response = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: TUNABLES.maxQuestionTokens,
      system: [{ type: 'text', text: QUESTION_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [QUESTIONS_TOOL],
      tool_choice: { type: 'tool', name: 'questions' },
      messages: [
        {
          role: 'user',
          content: `Candidate's language: ${language}\n\nTheir job, in their words:\n${occupation}`,
        },
      ],
    });

    const call = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'questions',
    );
    if (!call) return [];

    const returned = (call.input as { questions?: unknown })?.questions;
    if (!Array.isArray(returned)) return [];

    const seen = new Set<string>();
    const questions: GeneratedQuestion[] = [];

    for (const raw of returned) {
      const question = usable((raw ?? {}) as Record<string, unknown>, params.language);
      // A duplicate id would have the second question's answer overwrite the
      // first, and both are stored under the same key.
      if (!question || seen.has(question.id)) continue;
      seen.add(question.id);
      questions.push(question);
      if (questions.length === MAX_GENERATED_QUESTIONS) break;
    }

    logger.info(
      { occupation, kept: questions.length, returned: returned.length },
      'trade questions written for a job no pack covers',
    );
    return questions;
  } catch (err) {
    logger.error({ err, occupation }, 'could not write trade questions');
    return [];
  }
}
