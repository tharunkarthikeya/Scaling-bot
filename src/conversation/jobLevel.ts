/**
 * Whether the job a candidate wants is one a CV says anything about (§5, SG/MY).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  USED ONLY BY THE SINGAPORE/MALAYSIA FLOW, AND ONLY TO DECIDE ONE QUESTION.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * On that line the CV is not asked for up front. It is asked after the job
 * preferences, and only of a candidate whose desired job is one where a résumé
 * carries information — a technician, an electrician, a nurse, a supervisor.
 * Someone applying to clean, to pack, to load or to help is not asked, because
 * most of them do not have one, the ones who do have one that says what the flow
 * has already recorded, and asking anyway costs a turn and reads as a hurdle.
 *
 * What this file is *not*: an assessment of the candidate. It classifies the
 * **job**, from the job title, and its only consequence is whether one optional
 * question is asked. Nothing it returns reaches the candidate, is stored as a
 * judgement about them, or is sent to the CRM. The words "low" and "high" are
 * about how much a CV adds, not about the worth of the work or the person.
 *
 * The fence, such as it is needed:
 *
 *   1. NEVER SHOWN.  The output is an enum used by a `when` guard. There is no
 *      generated text, so there is nothing to guard-check.
 *   2. FILTERED.     A value the model invents is not trusted — the returned
 *      string is checked against the three allowed ones, and anything else is
 *      `unknown`.
 *   3. FAILS TOWARDS ASKING. Every failure path returns `unknown`, and
 *      `unknown` asks for the CV. A CV question can be declined in one tap; a
 *      CV never asked for is a document nobody finds out was available.
 *
 * Most candidates never reach the model at all: `LOW_SKILL_JOBS` and
 * `SKILLED_JOBS` settle the common titles by comparison, the same way
 * `interpret.ts` resolves a tapped button without a call.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { callModel, ModelUnavailableError, modelClient } from './model.js';

/**
 * How much a CV adds for this job.
 *
 *   low_skill  entry-level work hired on availability and willingness. No CV
 *              asked for.
 *   skilled    work hired on training, licences, tickets or a track record. The
 *              CV is asked for.
 *   unknown    we could not tell. Treated as `skilled`, because asking is the
 *              recoverable mistake.
 */
export type JobLevel = 'low_skill' | 'skilled' | 'unknown';

const LEVELS: ReadonlySet<string> = new Set<JobLevel>(['low_skill', 'skilled', 'unknown']);

/** Whether a job at this level is asked for a CV. Anything but `low_skill` is. */
export function cvWorthAsking(level: JobLevel | undefined): boolean {
  return level !== 'low_skill';
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The titles that need no model call
 *
 * Phrases, not bare words, for the reason `tradeQuestions.ts` gives at length: a
 * word list blocks the thing it is protecting. "Helper" alone is a helper and it
 * is also a "welder helper", who is a welder in training and has a certificate
 * to send. "Cleaning" alone is cleaning and it is also "cleaning validation" in
 * a pharmaceutical plant. So each pattern has to see enough of the sense to be
 * sure, and where it cannot be sure it matches nothing and the model decides.
 *
 * Both lists are deliberately short. They exist to save a call on the titles
 * that come up every day, not to be a taxonomy of work.
 * ───────────────────────────────────────────────────────────────────────────*/

const LOW_SKILL_JOBS = new RegExp(
  [
    String.raw`\bcleaner\b|\bcleaning\s+(?:job|work|staff|boy|worker)\b`,
    String.raw`\bhousekeep\w*\b|\broom\s+attendant\b`,
    String.raw`\bsweeper\b|\bjanitor\b|\bmopping\b`,
    String.raw`\bgeneral\s+(?:helper|worker|labour\w*|labor\w*)\b`,
    String.raw`\bhelper\s+(?:job|work)\b|\bonly\s+helper\b|^\s*helper\s*$`,
    String.raw`\bpacker\b|\bpacking\s+(?:job|work|staff|helper)\b`,
    String.raw`\bloader\b|\bunloader\b|\bloading\s+(?:job|work)\b`,
    String.raw`\bcoolie\b|\bporter\b|\bluggage\s+handler\b`,
    String.raw`\bdish\s*wash\w*\b|\bkitchen\s+(?:helper|hand|assistant)\b`,
    String.raw`\bwaiter\s+helper\b|\bsteward\b`,
    String.raw`\bconstruction\s+(?:helper|labour\w*|labor\w*|coolie)\b`,
    String.raw`\bunskilled\b|\bno\s+skill\b|\bany\s+(?:general\s+)?(?:work|job|labour\w*)\b`,
    String.raw`\bdaily\s+wage\s+(?:work|labour\w*|labor\w*)\b`,
    String.raw`\bfarm\s+(?:labour\w*|labor\w*|hand)\b|\bplantation\s+worker\b`,
  ].join('|'),
  'i',
);

const SKILLED_JOBS = new RegExp(
  [
    String.raw`\bwelder\b|\bwelding\b|\bfabricat\w*\b|\brigger\b|\bscaffold\w*\b`,
    String.raw`\belectric(?:ian|al)\b|\binstrument\w*\b|\bwireman\b`,
    String.raw`\bplumb\w*\b|\bpipe\s*fitter\b|\bfitter\b|\bmillwright\b`,
    String.raw`\bmechanic\b|\bmachinist\b|\bcnc\b|\blathe\b|\bturner\b`,
    String.raw`\btechnician\b|\bengineer\b|\bsupervisor\b|\bforeman\b|\bcharge\s*hand\b`,
    String.raw`\bcarpenter\b|\bmason\b|\bsteel\s+fixer\b|\bshuttering\s+carpenter\b`,
    String.raw`\bdriver\b|\bcrane\s+operator\b|\bforklift\b|\bexcavator\b|\bheavy\s+(?:vehicle|equipment)\b`,
    String.raw`\bnurse\b|\bpharmac\w*\b|\blab\s+technician\b|\bphysiothera\w*\b|\bdoctor\b`,
    String.raw`\bchef\b|\bcook\b|\bbaker\b|\bbutcher\b|\bbarista\b`,
    String.raw`\baccount\w*\b|\badmin\w*\b|\bclerk\b|\bstore\s*keeper\b|\bdata\s+entry\b`,
    String.raw`\bdesigner\b|\bdraft\w*man\b|\bautocad\b|\bsurveyor\b|\bquantity\s+survey\w*\b`,
    String.raw`\bsafety\s+officer\b|\bhse\b|\bqa\s*\/?\s*qc\b|\bquality\s+(?:inspector|control)\b`,
    String.raw`\bndt\b|\bradiograph\w*\b|\bultrasonic\b`,
    String.raw`\bsecurity\s+(?:officer|guard)\b|\bbarber\b|\btailor\b|\bbeautician\b`,
    String.raw`\bit\s+support\b|\bdevelop\w*\b|\bprogram\w*\b|\bnetwork\s+engineer\b`,
  ].join('|'),
  'i',
);

/**
 * The level a title settles on its own, or undefined when it does not.
 *
 * Exported for the smoke checks, which pin both lists in both directions — a
 * pattern that quietly stops matching is a candidate who stops being asked for a
 * CV, and nothing else in the system would notice.
 */
export function levelFromTitle(job: string): JobLevel | undefined {
  const text = job.trim();
  if (text.length < 2) return undefined;

  // Skilled is tested first on purpose. "Welder helper" and "electrician
  // assistant" contain a low-skill word and are neither of them low-skill work
  // — they are people learning a trade, who are exactly the candidates with a
  // certificate worth sending.
  if (SKILLED_JOBS.test(text)) return 'skilled';
  if (LOW_SKILL_JOBS.test(text)) return 'low_skill';
  return undefined;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The model call, for everything the lists do not settle
 * ───────────────────────────────────────────────────────────────────────────*/

const LEVEL_PROMPT = `
You classify one job title for a recruitment agency that places Indian workers
in Singapore and Malaysia. Your only output decides whether the candidate is
asked to send a CV.

You are given one thing: a job, in the candidate's own words. It may be a job
title, a trade, a category, or a rough description. It may be misspelled, or in
another language, or both.

Answer one question about it: would a CV tell an employer anything they do not
already know from the job title?

  low_skill   Entry-level work hired on availability, fitness and willingness.
              Cleaning, helping, packing, loading, portering, general labour,
              kitchen hands. A worker in these jobs usually has no CV, and one
              that exists repeats what the registration already recorded.

  skilled     Work hired on training, a licence, a ticket, a certificate or a
              track record. Trades, machine operators, drivers, technicians,
              healthcare, hospitality with a craft to it, office and technical
              roles, and anything supervisory. A CV is worth having here.

Read it the way a hiring manager for that job would. Judge the work, never the
person: this says how much a résumé adds, and nothing about anyone's worth.

A helper or assistant attached to a trade — "welder helper", "electrician
assistant" — is skilled. They are learning a trade and often hold a certificate.

Supervisory or senior wording anywhere — supervisor, foreman, in-charge, senior,
lead — is skilled, whatever the underlying work.

If the job is too vague to place — "any job", "work", "abroad", "good salary" —
return unknown. Do not guess. Unknown is treated as skilled, which costs one
question and never costs a document.
`.trim();

const LEVEL_TOOL: Anthropic.Tool = {
  name: 'job_level',
  description: 'Return how much a CV adds for this job. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        enum: ['low_skill', 'skilled', 'unknown'],
        description: 'low_skill, skilled, or unknown when the job is too vague to place.',
      },
    },
    required: ['level'],
    additionalProperties: false,
  },
};

/**
 * Classifies the job a candidate says they want.
 *
 * Throws `ModelUnavailableError` when Anthropic could not be reached, exactly
 * as `questionsForOccupation` does and for the same reason: the caller stores
 * what comes back, and storing `unknown` because the model was busy for two
 * seconds would settle the question permanently on a non-answer. Nothing is
 * recorded and the next turn tries again.
 *
 * Every other failure — no tool call, a value that is not one of the three —
 * returns `unknown`, which asks for the CV.
 */
export async function classifyJobLevel(params: { job: string }): Promise<JobLevel> {
  const job = params.job.trim().slice(0, 120);
  if (job.length < 2) return 'unknown';

  const settled = levelFromTitle(job);
  if (settled) {
    logger.info({ job, level: settled }, 'job level settled without a model call');
    return settled;
  }

  try {
    const response = await callModel('job-level', () =>
      modelClient().messages.create({
        model: config.CLAUDE_MODEL,
        max_tokens: 128,
        // Deterministic and candidate-free, so it caches as a prefix across
        // every classification — the same rule `INTERPRETER_PROMPT` follows.
        system: [{ type: 'text', text: LEVEL_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [LEVEL_TOOL],
        tool_choice: { type: 'tool', name: 'job_level' },
        messages: [{ role: 'user', content: `The job, in their words:\n${job}` }],
      }),
    );

    const call = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'job_level',
    );
    if (!call) {
      logger.warn({ job }, 'job level: no tool call returned');
      return 'unknown';
    }

    const returned = (call.input as { level?: unknown })?.level;
    // Filtered rather than trusted. A model that returns "medium" must not
    // become a fourth level nothing in the flow knows how to read.
    if (typeof returned !== 'string' || !LEVELS.has(returned)) {
      logger.warn({ job, returned }, 'job level: unrecognised value; treating as unknown');
      return 'unknown';
    }

    logger.info({ job, level: returned }, 'job level classified');
    return returned as JobLevel;
  } catch (err) {
    if (err instanceof ModelUnavailableError) throw err;
    logger.error({ err, job }, 'could not classify the job level');
    return 'unknown';
  }
}
