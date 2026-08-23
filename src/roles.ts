/**
 * What this process is for.
 *
 * One image, one entry point, three jobs. Which job a container does is a
 * deployment decision — a replica count in Dokploy, not a branch in the code —
 * so it arrives as an environment variable and this module turns it into a plan
 * the boot sequence can follow.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  all        HTTP, workers and sweeps together. The default, and what every
 *             deployment of this bot has run so far. Correct at any replica
 *             count *with* Redis; correct at exactly one without it.
 *  web        Webhook and admin API. Enqueues work and never performs it, so it
 *             scales with inbound traffic and nothing else. A slow extraction
 *             cannot make a webhook acknowledgement late, because the extraction
 *             is not happening in this process.
 *  worker     BullMQ consumers. No webhook. Scales with the backlog, which is a
 *             different curve from the traffic — documents arrive in bursts and
 *             take a hundred times longer to process than a button tap.
 *  scheduler  Sweeps. Exactly one instance does them at a time, chosen by a
 *             Redis lease, however many replicas are running.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## Why every role still serves HTTP
 *
 * A worker with no listening socket cannot be health-checked, and an
 * orchestrator that cannot health-check a container cannot tell "starting" from
 * "wedged". So `worker` and `scheduler` serve `/health` and `/metrics` and
 * nothing else — no webhook, no admin API, no candidate PII on a process that
 * has no reason to expose any.
 */

import { config } from './config.js';

export type Role = (typeof config)['ROLE'];

export interface RolePlan {
  readonly role: Role;

  /**
   * Serve the Meta webhook and the admin API.
   *
   * When false the process still listens — see the note above — but only for
   * `/health` and `/metrics`.
   */
  readonly webhook: boolean;

  /** Consume jobs. False on `web`, which produces them and never consumes. */
  readonly workers: boolean;

  /** Run the reminder, session, OCR, CRM and taxonomy sweeps. */
  readonly sweeps: boolean;

  /**
   * Take a Redis lease before sweeping, so N replicas produce one sweeper.
   *
   * Wanted on any role that sweeps and has a Redis to coordinate through,
   * `all` included: two `all` instances would otherwise both refresh the CRM
   * taxonomy on every tick and both scan for idle sessions, which is wasted
   * work rather than wrong work — the sweeps themselves claim in the database —
   * but wasted work at every tick, forever.
   */
  readonly leaderElection: boolean;

  /**
   * Refuse to start without Redis.
   *
   * True for every role but `all`. A role exists because another process is
   * doing the other half of the job, and without Redis they share nothing: two
   * queues, two lock tables, two rate-limit budgets, and one candidate answered
   * twice.
   */
  readonly requiresRedis: boolean;
}

export function planFor(role: Role, redisAvailable: boolean): RolePlan {
  const base = { role, requiresRedis: role !== 'all' } as const;

  switch (role) {
    case 'web':
      return { ...base, webhook: true, workers: false, sweeps: false, leaderElection: false };

    case 'worker':
      return { ...base, webhook: false, workers: true, sweeps: false, leaderElection: false };

    case 'scheduler':
      return { ...base, webhook: false, workers: false, sweeps: true, leaderElection: true };

    case 'all':
    default:
      return {
        ...base,
        webhook: true,
        workers: true,
        sweeps: true,
        // Only when there is something to elect through. A single instance with
        // no Redis is the leader by virtue of being the only candidate.
        leaderElection: redisAvailable,
      };
  }
}

/** One line for the boot log, so a container says what it is. */
export function describePlan(plan: RolePlan): string {
  const parts = [
    plan.webhook ? 'webhook+api' : 'ops-only',
    plan.workers ? 'workers' : null,
    plan.sweeps ? (plan.leaderElection ? 'sweeps(elected)' : 'sweeps') : null,
  ].filter(Boolean);
  return `${plan.role}: ${parts.join(' + ')}`;
}
