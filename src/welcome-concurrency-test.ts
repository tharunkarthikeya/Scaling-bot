/**
 * A burst of first messages must atomically produce one welcome.
 *
 * The eight CandidateDoc instances are loaded before any initializer runs. They
 * therefore reproduce the production race directly: every worker holds a stale
 * snapshot that says `stage: NEW`. The database claim, not timing or an
 * in-process lock, decides the sole winner.
 */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'welcome_concurrency_test';
process.env.REDIS_URL = '';
process.env.RESUME_ATS_DB = '';
process.env.ROLE = 'all';
process.env.SHADOW_MODE = 'true';
process.env.CRM_API_URL = '';
process.env.CRM_API_KEY = '';

const { connectDb, closeDb } = await import('./db/client.js');
const { appendTurn, ensureIndexes, findConversation, sessionsFor } = await import(
  './db/models.js'
);
const { getOrCreateCandidate, initializeConversationOnce } = await import(
  './conversation/engine.js'
);

await connectDb();
await ensureIndexes();

const waId = '919700000001';
await getOrCreateCandidate({ waId, phone: waId, profileName: 'Burst Candidate' });

const burst = Array.from({ length: 8 }, (_, index) => ({
  wamid: `rapid-photo-${index + 1}`,
  at: new Date(Date.now() + index),
}));

// Persist every inbound event just as the webhook does. They are image turns;
// the initialization test intentionally supplies no media bytes because file
// capture and OCR have their own tests and are not changed by this fix.
await Promise.all(
  burst.map((message) =>
    appendTurn({
      waId,
      direction: 'inbound',
      wamid: message.wamid,
      type: 'image',
      at: message.at,
    }),
  ),
);

// Load all stale NEW snapshots first, then release them concurrently.
const snapshots = await Promise.all(burst.map(() => findConversation(waId)));
assert.ok(snapshots.every(Boolean), 'candidate snapshots were not loaded');

const winners = await Promise.all(
  snapshots.map((candidate) => initializeConversationOnce(candidate!, '')),
);

const sessions = await sessionsFor(waId);
const turns = sessions.flatMap((session) => session.turns);
const welcomes = turns.filter((turn) => turn.direction === 'outbound' && turn.step === 'entry');

assert.equal(winners.filter(Boolean).length, 1, 'more than one initializer won the claim');
assert.equal(welcomes.length, 1, 'the rapid burst sent more than one welcome');
assert.equal(
  turns.filter((turn) => turn.direction === 'inbound').length,
  burst.length,
  'an inbound photo event was lost',
);

await closeDb();
await mongo.stop();

console.log('\n\x1b[32mok\x1b[0m  8 concurrent first messages produced exactly 1 welcome\n');
