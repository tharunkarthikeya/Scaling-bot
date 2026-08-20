import { config } from './config.js';
import { logger } from './logger.js';
import { connectDb, closeDb } from './db/client.js';
import { ensureIndexes } from './db/models.js';
import { ensureStorageRoot } from './storage/index.js';
import { queue, withCandidateLock } from './queue/index.js';
import { endIdleSessions, handleInboundMessage, sendReminders } from './conversation/engine.js';
import { validateCopy } from './conversation/validate.js';
import { processOcrJob } from './ocr/veris.js';
import { reconcileCrmSync, syncCandidateToCrm } from './crm/sync.js';
import { buildServer } from './server.js';

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

async function main(): Promise<void> {
  // Before anything accepts traffic: a button title one character over Meta's
  // limit rejects the whole message, and that must break the deploy rather than
  // one candidate's registration.
  validateCopy();

  await connectDb();
  await ensureIndexes();
  await ensureStorageRoot();

  // Two messages from the same candidate must not run concurrently, or both
  // turns see the same stale checklist and ask for the same document.
  queue.register(
    'inbound_message',
    (payload) => withCandidateLock(payload.waId, () => handleInboundMessage(payload)),
    4,
  );

  // OCR is slow and independent per document, so it runs wider.
  queue.register('ocr', processOcrJob, 4);

  // Handing finished registrations to the CRM. One at a time per candidate is
  // unnecessary — the submission is idempotent by key, so a duplicate job
  // returns the same candidate rather than creating a second one.
  queue.register('crm_sync', syncCandidateToCrm, 4);

  await queue.start();

  const app = await buildServer();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  // §21 — one reminder per candidate who goes quiet mid-registration. The sweep
  // runs often; "exactly one" is enforced per candidate in the database, so a
  // restart or a second instance cannot produce a second reminder.
  const reminderSweep = setInterval(() => {
    void sendReminders().catch((err) => logger.error({ err }, 'reminder sweep failed'));
  }, REMINDER_SWEEP_MS);
  reminderSweep.unref();

  const sessionSweep = setInterval(() => {
    void endIdleSessions().catch((err) => logger.error({ err }, 'session sweep failed'));
  }, SESSION_SWEEP_MS);
  sessionSweep.unref();

  // Candidates the CRM has not accepted yet.
  //
  // The queue retries a call that failed; this catches what the queue cannot
  // see — a job lost to a restart, a registration completed while the CRM was
  // unconfigured. Nothing is ever dropped for being old: an undelivered
  // candidate stays undelivered until they are delivered.
  const crmSweep = setInterval(() => {
    void reconcileCrmSync().catch((err) => logger.error({ err }, 'crm sync sweep failed'));
  }, config.INGESTION_RECONCILE_INTERVAL_MS);
  crmSweep.unref();

  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      model: config.CLAUDE_MODEL,
      shadowMode: config.SHADOW_MODE,
      queue: config.REDIS_URL ? 'redis' : 'in-process',
      crm: config.CRM_API_URL ? 'configured' : 'not configured',
    },
    'adira whatsapp bot started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(reminderSweep);
    clearInterval(sessionSweep);
    clearInterval(crmSweep);
    try {
      await app.close();
      await queue.close();
      await closeDb();
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
