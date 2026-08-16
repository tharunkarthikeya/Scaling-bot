/**
 * Local development without installing MongoDB.
 *
 *   npm run dev:local
 *
 * Starts a real mongod bound to ./.mongo-data (so candidates and documents
 * survive a restart), then boots the real server against it. Everything else —
 * Claude, OCR, WhatsApp sending — behaves exactly as in production.
 *
 * This is a convenience for a developer machine. Production points MONGODB_URI
 * at a managed database and runs `npm start`.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';

const dbPath = path.resolve('.mongo-data');
await fs.mkdir(dbPath, { recursive: true });

// Pin the standard port so MongoDB Compass can connect at a predictable
// address. Falls back to a random port if something already holds 27017.
let mongo;
try {
  mongo = await MongoMemoryServer.create({
    instance: { port: 27017, dbName: 'mountroad_wa_bot', dbPath, storageEngine: 'wiredTiger' },
  });
} catch {
  console.warn('port 27017 is busy — falling back to a random port');
  mongo = await MongoMemoryServer.create({
    instance: { dbName: 'mountroad_wa_bot', dbPath, storageEngine: 'wiredTiger' },
  });
}

// Set before importing config; dotenv leaves existing variables alone.
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'mountroad_wa_bot';

const { config } = await import('./config.js');
const { logger } = await import('./logger.js');
const { connectDb, closeDb } = await import('./db/client.js');
const { ensureIndexes } = await import('./db/models.js');
const { ensureStorageRoot } = await import('./storage/index.js');
const { queue, withCandidateLock } = await import('./queue/index.js');
const { handleInboundMessage } = await import('./conversation/engine.js');
const { processOcrJob } = await import('./ocr/veris.js');
const { buildServer } = await import('./server.js');

await connectDb();
await ensureIndexes();
await ensureStorageRoot();

queue.register(
  'inbound_message',
  (p) => withCandidateLock(p.waId, () => handleInboundMessage(p)),
  4,
);
queue.register('ocr', processOcrJob, 4);
await queue.start();

const app = await buildServer();
await app.listen({ port: config.PORT, host: '0.0.0.0' });

logger.info(
  { port: config.PORT, dbPath, model: config.CLAUDE_MODEL, shadowMode: config.SHADOW_MODE },
  'dev server ready (embedded mongodb)',
);
console.log(`\n  local:   http://127.0.0.1:${config.PORT}/health`);
console.log(`  webhook: http://127.0.0.1:${config.PORT}/webhook`);
console.log(`  mongodb: ${mongo.getUri()}`);
console.log(`${'           '}↑ paste into MongoDB Compass. OCR output is in the`);
console.log(`${'           '}  "documents" collection, under the ocr field.`);
console.log(`\n  Meta cannot reach this directly — expose it with a tunnel, e.g.`);
console.log(`    cloudflared tunnel --url http://localhost:${config.PORT}\n`);

const shutdown = async () => {
  await app.close();
  await queue.close();
  await closeDb();
  await mongo.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
