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
      jobs: [...jobs].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
      countries: [...countries].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
      fetchedAt: new Date(),
    };

    if (changed) {
      logger.info(
        { version: cache.version, jobs: jobs.length, countries: countries.length },
        'crm taxonomy updated',
      );
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

/** Test seam: drop the cache so a run starts from the built-in lists. */
export function resetTaxonomy(): void {
  cache = undefined;
}

/** Test seam: install a list without going near the network. */
export function setTaxonomyForTests(value: {
  version?: string;
  botListLimit?: number;
  jobs?: TaxonomyJob[];
  countries?: TaxonomyCountry[];
}): void {
  cache = {
    version: value.version ?? 'test',
    botListLimit: value.botListLimit ?? DEFAULT_LIST_LIMIT,
    jobs: value.jobs ?? [],
    countries: value.countries ?? [],
    fetchedAt: new Date(),
  };
}
