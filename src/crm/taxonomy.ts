/**
 * The jobs and countries the CRM says to offer.
 *
 * These used to be two lists in `flow.ts`, which meant that opening a Kuwait
 * desk or adding "CNC Operator" to what the agency recruits for was a code
 * change in this repository, a code change in the CRM's policy table, and a
 * deploy of each. The person who knows a new job has opened is an admin, so the
 * list moved to where the admin is and the bot reads it from there.
 *
 * What this file does not do is decide anything. It fetches a list, holds it,
 * and hands it back. The CV rule attached to a job stays entirely in the CRM —
 * the bot asks `GET /policy/cv-required` for that, and the CRM re-derives it at
 * submission anyway.
 *
 * ## Why a cache, and why a synchronous read
 *
 * The question "what rows go in this list?" is asked while a candidate is
 * waiting, inside `choicesFor`, which is synchronous and is called on every
 * turn. An HTTP request there would put the CRM's latency — and its outages —
 * inside every reply the bot sends.
 *
 * So the list is fetched on a timer and read out of memory. The cost of that is
 * bounded and worth naming: a job an admin adds is offered to candidates within
 * one refresh interval, not instantly.
 *
 * ## Why the built-in lists still exist
 *
 * An empty cache means "we have not been told", not "there are no jobs". Until
 * the first successful fetch — a cold start, a CRM that is down, a bot running
 * with no CRM configured at all — the questions fall back to the lists compiled
 * into `flow.ts`, which are the same ones the CRM is seeded with. A candidate
 * mid-registration during a CRM outage is asked the same questions they were
 * asked yesterday rather than none at all.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { crmConfigured } from './client.js';

export interface TaxonomyJob {
  id: string;
  title: string;
  order: number;
}

export interface TaxonomyCountry {
  id: string;
  name: string;
  order: number;
}

/**
 * One screening question an admin attached to a job, as
 * `GET /jobs/{job_id}/questions` returns it.
 */
export interface TaxonomyJobQuestion {
  id: string;
  text: string;
  /** `text` for a typed answer, `choice` for a tap. */
  kind: 'text' | 'choice';
  choices: string[];
  required: boolean;
}

interface Taxonomy {
  version: string;
  botListLimit: number;
  jobs: TaxonomyJob[];
  countries: TaxonomyCountry[];
  fetchedAt: Date;
}

/**
 * WhatsApp's ceiling for a list message, and a hard one — an eleventh row is
 * rejected by the API rather than dropped by it. The CRM sends its own value;
 * this is what we assume until it does.
 */
const DEFAULT_LIST_LIMIT = 10;

let cache: Taxonomy | undefined;

/**
 * The admin's order, and the whole of what "configurable" means here.
 *
 * WhatsApp shows ten rows and an agency recruits for more than ten things, so
 * which rows a candidate sees is decided by `bot_order` and nothing else. The
 * CRM sorts on it too; this is not trust in that, it is the same rule applied
 * where the list is used — a row arriving out of order from anywhere would
 * otherwise silently change what nine jobs get shown.
 *
 * Ties break on the name, so two rows an admin left at the default order come
 * out in a stable order rather than in whatever order Mongo returned them.
 * The renderer preserves this order across as many WhatsApp pages as needed.
 */
function inAdminOrder<T extends { order?: number; title?: string; name?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const by = (a.order ?? 100) - (b.order ?? 100);
    if (by !== 0) return by;
    return (a.title ?? a.name ?? '').localeCompare(b.title ?? b.name ?? '');
  });
}

/** How often the list is re-read. Also the worst-case delay on a new job. */
export const TAXONOMY_REFRESH_MS = 5 * 60_000;

/**
 * Fetches the list, or leaves the last good one in place.
 *
 * A failure is a warning and nothing else. The alternative — clearing the cache
 * when the CRM is unreachable — would take a working question list away from
 * candidates in the middle of a conversation because a service they have never
 * heard of restarted.
 */
export async function refreshTaxonomy(): Promise<Taxonomy | undefined> {
  if (!crmConfigured()) return cache;

  try {
    const res = await fetch(`${config.CRM_API_URL!.replace(/\/$/, '')}/taxonomy`, {
      headers: { 'X-Service-Key': config.CRM_API_KEY! },
      signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'crm taxonomy fetch failed; keeping the cached list');
      return cache;
    }

    const body = (await res.json()) as {
      version?: string;
      bot_list_limit?: number;
      jobs?: TaxonomyJob[];
      countries?: TaxonomyCountry[];
    };

    const jobs = (body.jobs ?? []).filter((j) => j?.id && j?.title);
    const countries = (body.countries ?? []).filter((c) => c?.id && c?.name);

    // An empty list is not an answer. A CRM that returns no jobs at all is
    // misconfigured or mid-migration, and offering a candidate a question with
    // no options is worse than offering them yesterday's.
    if (!jobs.length && !countries.length) {
      logger.warn('crm taxonomy came back empty; keeping the cached list');
      return cache;
    }

    const changed = cache?.version !== body.version;
    cache = {
      version: body.version ?? '',
      botListLimit: body.bot_list_limit ?? DEFAULT_LIST_LIMIT,
      jobs: inAdminOrder(jobs),
      countries: inAdminOrder(countries),
      fetchedAt: new Date(),
    };

    if (changed) {
      logger.info(
        { version: cache.version, jobs: jobs.length, countries: countries.length },
        'crm taxonomy updated',
      );

      // Other and More options take two rows on the first page. The remaining
      // jobs are not hidden: the renderer gives them subsequent pages while
      // keeping every page below Meta's hard ceiling.
      const firstPage = Math.max(1, taxonomyListLimit() - 2);
      if (cache.jobs.length > firstPage) {
        logger.info(
          { jobs: cache.jobs.length, firstPage },
          'crm job list spans multiple WhatsApp pages',
        );
      }

      // The taxonomy moved, so an admin has been editing. Drop the per-job
      // questions rather than serving them until their own TTL runs out — a
      // candidate part-way through a set keeps the copy stored on their record,
      // so nothing they are being asked changes underneath them.
      questionCache.clear();
    }
    return cache;
  } catch (err) {
    logger.warn({ err }, 'crm taxonomy unreachable; keeping the cached list');
    return cache;
  }
}

/** What is currently held, if anything has been fetched. */
export function taxonomy(): Taxonomy | undefined {
  return cache;
}

/** The CRM's requested row ceiling, never allowed above Meta's hard limit. */
export function taxonomyListLimit(): number {
  const requested = cache?.botListLimit ?? DEFAULT_LIST_LIMIT;
  return Math.min(DEFAULT_LIST_LIMIT, Math.max(1, requested));
}

/**
 * The jobs to offer, in the admin's order, already cut to what WhatsApp allows.
 *
 * `reserve` is the number of rows the caller needs for its own options — the
 * "Other" row, and "Talk to staff" where the step offers it. Those are not
 * negotiable, so the jobs get what is left rather than the other way round.
 *
 * Returns undefined when nothing has been fetched, which means "use the
 * built-in list".
 */
export function taxonomyJobs(reserve = 1): TaxonomyJob[] | undefined {
  if (!cache?.jobs.length) return undefined;
  const room = Math.max(1, (cache.botListLimit || DEFAULT_LIST_LIMIT) - reserve);
  return cache.jobs.slice(0, room);
}

export function taxonomyCountries(reserve = 0): TaxonomyCountry[] | undefined {
  if (!cache?.countries.length) return undefined;
  const room = Math.max(1, (cache.botListLimit || DEFAULT_LIST_LIMIT) - reserve);
  return cache.countries.slice(0, room);
}

/**
 * The country name behind an option id, according to the CRM.
 *
 * `singapore` → `Singapore`. Used to fill `destination_country`, which is half
 * the key the CV policy is resolved from — so a country the bot offers but
 * cannot name is a candidate the policy cannot rule on.
 */
export function taxonomyCountryName(optionId: string): string | undefined {
  return cache?.countries.find((c) => c.id === optionId)?.name;
}

/** Whether the CRM knows this option id as a destination country. */
export function isTaxonomyCountry(optionId: string): boolean {
  return !!cache?.countries.some((c) => c.id === optionId);
}

/** Whether the CRM knows this id as a job. */
export function isTaxonomyJob(jobId: string): boolean {
  return !!cache?.jobs.some((j) => j.id === jobId);
}

/** The title an admin gave a job, for the record the CRM keeps of the choice. */
export function taxonomyJobTitle(jobId: string): string | undefined {
  return cache?.jobs.find((j) => j.id === jobId)?.title;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The questions an admin attached to a job
 *
 * A second, smaller list, read from `GET /jobs/{job_id}/questions` and cached
 * per job rather than fetched with the taxonomy. Two reasons for the split:
 *
 *   * Most jobs carry no questions and most candidates pick one of a handful of
 *     jobs, so pulling every job's questions on a timer would be a request per
 *     job every five minutes to fill a cache nobody reads.
 *   * They are needed once per candidate — at the moment they pick a job — and
 *     that moment is already asynchronous (`ensureJobQuestions` in the engine),
 *     unlike the synchronous render path the jobs and countries are read from.
 *
 * So: fetched on demand, held for `JOB_QUESTIONS_TTL_MS`, shared between
 * candidates who pick the same job, and one request per job however many of
 * them are waiting.
 * ───────────────────────────────────────────────────────────────────────────*/

/** How long a job's questions are held before they are re-read. */
export const JOB_QUESTIONS_TTL_MS = 5 * 60_000;

/**
 * How long a failed read is left alone before it is tried again.
 *
 * This one is not about load, it is about the candidate's clock. Unlike the
 * taxonomy, which is refreshed on a timer, these are read inside a turn — so a
 * CRM that is down costs whoever is typing the full `CRM_TIMEOUT_MS` before
 * their next question arrives. Retrying on every turn would spend that once per
 * message for the rest of the outage; remembering the failure for a minute
 * spends it once per minute, and the candidate is asked nothing different
 * either way.
 */
const RETRY_AFTER_FAILURE_MS = 60_000;

interface QuestionEntry {
  questions: TaxonomyJobQuestion[];
  fetchedAt: number;
}

const questionCache = new Map<string, QuestionEntry>();
const failedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<TaxonomyJobQuestion[] | undefined>>();

/**
 * WhatsApp renders at most ten rows, and a question with one option is not a
 * choice. Both are enforced here rather than trusted to the admin form, because
 * what an over-long list costs is not a truncated question — it is a message
 * Meta refuses outright and a candidate who receives nothing.
 */
const MAX_QUESTION_CHOICES = 10;

function usableQuestion(raw: unknown): TaxonomyJobQuestion | undefined {
  const q = (raw ?? {}) as Record<string, unknown>;
  const id = typeof q.id === 'string' ? q.id.trim() : '';
  const asked = typeof q.text === 'string' ? q.text.trim() : '';
  if (!id || !asked) return undefined;

  const choices = (Array.isArray(q.choices) ? q.choices : [])
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, MAX_QUESTION_CHOICES);

  // An admin who wrote a single option wrote a leading question. It is asked as
  // free text instead, which still records what they say.
  const kind = q.kind === 'choice' && choices.length >= 2 ? 'choice' : 'text';

  return { id, text: asked, kind, choices: kind === 'choice' ? choices : [], required: !!q.required };
}

/**
 * The questions attached to one job, from the cache or from the CRM.
 *
 * Never throws and never stalls a registration.
 *
 * The return type carries a distinction the caller cannot do without.
 * `[]` means the CRM answered and this job has no questions; `undefined` means
 * we could not find out. They look the same to a candidate — neither is asked
 * anything — and they are opposites to the record: the caller stores an empty
 * list against the job, and a stored empty list is what stops this running
 * again. Collapsing the two would let one unreachable minute record "this job
 * has no screening questions" for a candidate permanently.
 */
export async function fetchJobQuestions(
  jobId: string,
): Promise<TaxonomyJobQuestion[] | undefined> {
  if (!jobId) return [];

  const held = questionCache.get(jobId);
  if (held && Date.now() - held.fetchedAt < JOB_QUESTIONS_TTL_MS) return held.questions;

  if (!crmConfigured()) return held?.questions;

  const failed = failedAt.get(jobId);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_FAILURE_MS) {
    return held?.questions;
  }

  const existing = inFlight.get(jobId);
  if (existing) return existing;

  const request = (async (): Promise<TaxonomyJobQuestion[] | undefined> => {
    try {
      const res = await fetch(
        `${config.CRM_API_URL!.replace(/\/$/, '')}/jobs/${encodeURIComponent(jobId)}/questions`,
        {
          headers: { 'X-Service-Key': config.CRM_API_KEY! },
          signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS),
        },
      );

      if (!res.ok) {
        logger.warn(
          { jobId, status: res.status },
          'crm job questions fetch failed; keeping what was cached',
        );
        failedAt.set(jobId, Date.now());
        return held?.questions;
      }

      const body = (await res.json()) as { questions?: unknown[] };
      const questions = (body.questions ?? [])
        .map(usableQuestion)
        .filter((q): q is TaxonomyJobQuestion => !!q);

      questionCache.set(jobId, { questions, fetchedAt: Date.now() });
      failedAt.delete(jobId);
      if (questions.length) {
        logger.info({ jobId, questions: questions.length }, 'crm job questions loaded');
      }
      return questions;
    } catch (err) {
      logger.warn({ err, jobId }, 'crm job questions unreachable; keeping what was cached');
      failedAt.set(jobId, Date.now());
      return held?.questions;
    } finally {
      inFlight.delete(jobId);
    }
  })();

  inFlight.set(jobId, request);
  return request;
}

/** What is currently held for a job, without reaching for the network. */
export function cachedJobQuestions(jobId: string): TaxonomyJobQuestion[] | undefined {
  return questionCache.get(jobId)?.questions;
}

/** Test seam: drop the cache so a run starts from the built-in lists. */
export function resetTaxonomy(): void {
  cache = undefined;
  questionCache.clear();
  failedAt.clear();
  inFlight.clear();
}

/** Test seam: install a job's questions without going near the network. */
export function setJobQuestionsForTests(
  jobId: string,
  questions: Array<Partial<TaxonomyJobQuestion> & { id: string; text: string }>,
): void {
  failedAt.delete(jobId);
  questionCache.set(jobId, {
    questions: questions
      .map((q) => usableQuestion({ kind: 'text', choices: [], required: false, ...q }))
      .filter((q): q is TaxonomyJobQuestion => !!q),
    fetchedAt: Date.now(),
  });
}

/** Test seam: install a list without going near the network. */
export function setTaxonomyForTests(value: {
  version?: string;
  botListLimit?: number;
  jobs?: TaxonomyJob[];
  countries?: TaxonomyCountry[];
}): void {
  // Sorted, exactly as a fetched list is. A seam that skipped this would let a
  // test pass on an order production would never produce, which is the one
  // thing a seam must not do.
  cache = {
    version: value.version ?? 'test',
    botListLimit: value.botListLimit ?? DEFAULT_LIST_LIMIT,
    jobs: inAdminOrder(value.jobs ?? []),
    countries: inAdminOrder(value.countries ?? []),
    fetchedAt: new Date(),
  };
}
