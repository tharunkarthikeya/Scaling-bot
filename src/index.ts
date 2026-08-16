import { config } from './config.js';
import { logger } from './logger.js';
import { connectDb, closeDb } from './db/client.js';
import { ensureIndexes } from './db/models.js';
import { ensureStorageRoot } from './storage/index.js';
import { queue, withCandidateLock } from './queue/index.js';
import { handleInboundMessage } from './conversation/engine.js';
import { processOcrJob } from './ocr/veris.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
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

  await queue.start();

  const app = await buildServer();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      model: config.CLAUDE_MODEL,
      shadowMode: config.SHADOW_MODE,
      queue: config.REDIS_URL ? 'redis' : 'in-process',
    },
    'adira whatsapp bot started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
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
