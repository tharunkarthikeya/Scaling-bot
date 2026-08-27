import { config, instanceId } from './config.js';
import { logger } from './logger.js';
import { connectDb, closeDb } from './db/client.js';
import { ensureIndexes } from './db/models.js';
import { ensureStorageRoot, storageDriver } from './storage/index.js';
import { queue, withCandidateLock } from './queue/index.js';
import { endIdleSessions, handleInboundMessage, sendReminders } from './conversation/engine.js';
import { validateCopy } from './conversation/validate.js';
import { processOcrJob, sweepRunningExtractions } from './ocr/veris.js';
import { reconcileCrmSync, syncCandidateToCrm } from './crm/sync.js';
import { exportToAts } from './ats/export.js';
import { ensureAtsCollections } from './ats/client.js';
import { TAXONOMY_REFRESH_MS, refreshTaxonomy } from './crm/taxonomy.js';
import { buildServer } from './server.js';
import { describePlan, planFor } from './roles.js';
import { Lease, scheduleWithLease } from './scheduler/leader.js';
import { closeRedis, pingRedis, redisEnabled, requireRedisUrl } from './redis/index.js';
import { startEventLoopMonitor, stopEventLoopMonitor } from './metrics/index.js';
import { refreshStaffDirectoryFromCrm } from './staff/notify.js';

/** How often the §21 reminder sweep runs. The claim is per candidate, not per sweep. */
const REMINDER_SWEEP_MS = 15 * 60 * 1000;

/**
 * How often idle registration sessions are closed.
 *
 * Runs against a five-minute timeout, so it has to be frequent — this interval
 * is the lag between a session lapsing and the candidate being told, so it must
 * stay well under the timeout itself.
 *
 * Closing a session both records that it lapsed, which is what lets the CRM see
 * where registrations are being abandoned, and pushes the continue-or-restart
 * choice. A missed sweep only delays that: the same choice is offered on the
 * candidate's next message either way.
 */
const SESSION_SWEEP_MS = 60 * 1000;

/**
 * How long a sweep lease is held.
 *
 * Comfortably longer than the slowest sweep interval that renews it, so a
 * leader that is merely busy does not lose the duty to a replica that is merely
 * idle. The reminder sweep runs every fifteen minutes and is not what renews
 * this — the session sweep, at sixty seconds, is.
 */
const SWEEP_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * Refuses to start rather than starting wrong.
 *
 * Every check here is a configuration that boots cleanly and then misbehaves in
 * a way nobody attributes to configuration: a `worker` with no Redis quietly
 * consuming its own private queue that no `web` instance ever writes to, or a
 * Redis that is configured but unreachable, which looks like the bot ignoring
 * every message.
 */
async function preflight(plan: ReturnType<typeof planFor>): Promise<void> {
  if (plan.requiresRedis) {
    requireRedisUrl(`ROLE=${plan.role}`);
  }

  if (redisEnabled()) {
    const { ok, error } = await pingRedis();
    if (!ok) {
      throw new Error(
        `REDIS_URL is set but Redis did not answer: ${error}. ` +
          `On Dokploy this must be the Internal Connection URL of a Redis service in the ` +
          `same project, on port 6379.`,
      );
    }
  } else {
    // Supported, and correct — for exactly one instance. Said out loud at every
    // boot, because the failure it leads to is invisible until the second
    // instance exists and then presents as a candidate being answered twice.
    logger.warn(
      'REDIS_URL is not set: the queue, candidate locks and rate limits are local to this ' +
        'process. Safe for exactly one instance. Do not run a second one.',
    );
  }
}

/**
 * Registers the job handlers this process consumes.
 *
 * Only called on roles that actually run workers. On `web` the handlers are
 * never registered, so a webhook process cannot pick up a job even if one were
 * somehow routed to it — the separation is structural rather than a matter of
 * configuration discipline.
 */
function registerWorkers(): void {
  // Two messages from the same candidate must not run concurrently, or both
  // turns see the same stale checklist and ask for the same document.
  //
  // Two mechanisms enforce that, and both are load-bearing. The queue will not
  // schedule two jobs for one candidate in the same pool at the same time, which
  // is what keeps a worker from ever blocking on a lock it cannot win. And
  // `withCandidateLock` holds the actual boundary, because it is also taken from
  // outside the queue entirely — by the OCR worker when an extraction comes back,
  // and by the idle-session sweep. The queue schedules; the lock is correct.
  //
  // Since the lock became a Redis key it is also what stops a *second instance*
  // answering the same candidate, which is the whole reason more than one worker
  // is safe to run.
  queue.register(
    'inbound_message',
    (payload) => withCandidateLock(payload.waId, () => handleInboundMessage(payload)),
    config.QUEUE_CONCURRENCY_INBOUND,
  );

  // Its own pool, so a slow extraction queues behind other extractions and never
  // behind — or in front of — a candidate waiting on an answer.
  queue.register('ocr', processOcrJob, config.QUEUE_CONCURRENCY_OCR);

  // Handing finished registrations to the CRM. One at a time per candidate is
  // unnecessary — the submission is idempotent by key, so a duplicate job
  // returns the same candidate rather than creating a second one.
  queue.register('crm_sync', syncCandidateToCrm, config.QUEUE_CONCURRENCY_CRM_SYNC);

  // Copying finished conversations into the ATS. Shares the CRM pool's size
  // because it is the same kind of work — a handful of writes to a database
  // that is not on the candidate's critical path — and every write is an
  // upsert on a natural key, so a duplicate job rewrites a row rather than
  // adding one.
  queue.register('ats_export', exportToAts, config.QUEUE_CONCURRENCY_CRM_SYNC);
}

async function main(): Promise<void> {
  // Before anything accepts traffic: a button title one character over Meta's
  // limit rejects the whole message, and that must break the deploy rather than
  // one candidate's registration.
  validateCopy();

  const plan = planFor(config.ROLE, redisEnabled());
  await preflight(plan);

  // Before anything that could block it, so the first samples describe a real
  // boot rather than an idle process. Native, so it costs no JavaScript.
  startEventLoopMonitor();

  await connectDb();
  await ensureIndexes();

  if (plan.webhook) {
    try {
      const remembered = await refreshStaffDirectoryFromCrm();
      logger.info({ remembered }, 'staff directory refreshed for inbound suppression');
    } catch (err) {
      logger.warn({ err }, 'could not refresh staff directory; assignment callbacks will backfill it');
    }
  }
  // Only the ones that are not there yet — see `ats/client.ts`. Never throws:
  // an ATS that cannot be prepared is a failed export, not a bot that refuses
  // to answer anybody.
  await ensureAtsCollections();
  await ensureStorageRoot();

  if (plan.workers) {
    registerWorkers();
  } else {
    // Not consumed here, but still reported. A `web` instance is the one being
    // scraped, and a metrics endpoint that shows every queue empty because this
    // process happens not to consume them is worse than no endpoint at all.
    queue.observe('inbound_message');
    queue.observe('ocr');
    queue.observe('crm_sync');
    queue.observe('ats_export');
  }

  await queue.start();

  const app = await buildServer({ webhook: plan.webhook });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  /* --- Sweeps ------------------------------------------------------- */

  const lease = new Lease('sweeps', SWEEP_LEASE_TTL_MS);
  const stopSweeps: Array<() => void> = [];

  if (plan.sweeps) {
    // §21 — one reminder per candidate who goes quiet mid-registration. The
    // sweep runs often; "exactly one" is enforced per candidate in the database,
    // so a restart or a second instance cannot produce a second reminder. The
    // lease is not what makes that true — it is what stops the fleet paying for
    // the same scan N times.
    stopSweeps.push(
      scheduleWithLease(lease, REMINDER_SWEEP_MS, 'reminders', sendReminders),
      scheduleWithLease(lease, SESSION_SWEEP_MS, 'sessions', endIdleSessions),
      // Extractions that are with Veris rather than with us. Only does anything
      // when VERIS_OCR_ASYNC is on; without it a gated upload is released by the
      // OCR path alone, so a candidate would wait on a reply that never comes.
      scheduleWithLease(lease, config.OCR_SWEEP_INTERVAL_MS, 'ocr', sweepRunningExtractions),
      // Candidates the CRM has not accepted yet. The queue retries a call that
      // failed; this catches what the queue cannot see — a job lost to a
      // restart, a registration completed while the CRM was unconfigured.
      // Nothing is dropped for being old.
      scheduleWithLease(
        lease,
        config.INGESTION_RECONCILE_INTERVAL_MS,
        'crm-reconcile',
        reconcileCrmSync,
      ),
    );
  }

  /* --- Taxonomy ----------------------------------------------------- */

  // The jobs and countries an admin can edit in the CRM.
  //
  // Deliberately NOT lease-gated, and this is the one piece of the role split
  // that is easy to get wrong. `refreshTaxonomy` populates a module-level cache
  // that `conversation/flow.ts` and `conversation/render.ts` read synchronously
  // while composing a reply. That cache is per process. Electing a single
  // instance to refresh it would leave every other instance rendering the
  // compiled fallback list instead of the current one.
  //
  // So it is refreshed by every process that runs conversation code — the
  // workers, and the sweeps that finish an extraction and ask the next question.
  // A pure `web` instance never renders a choice list and does not need it.
  let taxonomySweep: NodeJS.Timeout | undefined;

  if (plan.workers || plan.sweeps) {
    // Once before taking traffic, so the first candidate of a deploy is offered
    // the current list rather than the compiled one.
    await refreshTaxonomy();
    taxonomySweep = setInterval(() => {
      void refreshTaxonomy().catch((err) => logger.error({ err }, 'crm taxonomy refresh failed'));
    }, TAXONOMY_REFRESH_MS);
    taxonomySweep.unref();
  }

  logger.info(
    {
      instance: instanceId,
      role: describePlan(plan),
      port: config.PORT,
      env: config.NODE_ENV,
      model: config.CLAUDE_MODEL,
      shadowMode: config.SHADOW_MODE,
      queue: redisEnabled() ? 'redis' : 'in-process',
      storage: storageDriver(),
      concurrency: plan.workers
        ? {
            inbound: config.QUEUE_CONCURRENCY_INBOUND,
            ocr: config.QUEUE_CONCURRENCY_OCR,
            crmSync: config.QUEUE_CONCURRENCY_CRM_SYNC,
          }
        : 'none (this process does not consume jobs)',
      crm: config.CRM_API_URL ? 'configured' : 'not configured',
    },
    'adira whatsapp bot started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal, instance: instanceId }, 'shutting down');
    for (const stop of stopSweeps) stop();
    if (taxonomySweep) clearInterval(taxonomySweep);
    stopEventLoopMonitor();

    try {
      // Order matters. Stop accepting new work, then let in-flight work finish,
      // then give up the lease so another instance can take over immediately
      // rather than waiting out its TTL, and only then close the connections
      // everything above was using.
      await app.close();
      await queue.close();
      await lease.release();
      await closeDb();
      await closeRedis();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
