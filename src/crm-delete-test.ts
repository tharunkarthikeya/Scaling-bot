/** A CRM deletion releases the matching WhatsApp identity for re-registration. */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'crm_delete_test';
process.env.REDIS_URL = '';

const [{ connectDb, closeDb }, { candidates, messages }, { purgeCrmCandidateData }] =
  await Promise.all([
    import('./db/client.js'),
    import('./db/models.js'),
    import('./privacy/purge.js'),
  ]);

await connectDb();

await candidates().insertOne({
  waId: '919800000001',
  phone: '919800000001',
  stage: 'REGISTRATION_COMPLETED',
  status: 'profile_registered',
  profile: {},
  fieldMeta: {},
  history: [],
  documents: {},
  crmSync: { status: 'synced', candidateId: 'crm-candidate-1', attempts: 1 },
  createdAt: new Date(),
  updatedAt: new Date(),
});
await messages().insertOne({
  waId: '919800000001',
  startedAt: new Date(),
  lastAt: new Date(),
  turnCount: 0,
  turns: [],
});

const unrelated = await purgeCrmCandidateData('crm-somebody-else');
assert.equal(unrelated.removed, false);
assert.equal(await candidates().countDocuments(), 1);

const removed = await purgeCrmCandidateData('crm-candidate-1');
assert.equal(removed.removed, true);
assert.equal(removed.waId, '919800000001');
assert.equal(await candidates().countDocuments(), 0);
assert.equal(await messages().countDocuments(), 0);

// The same WhatsApp number is no longer held by the deleted registration.
await candidates().insertOne({
  waId: '919800000001',
  phone: '919800000001',
  stage: 'NEW',
  status: 'new_enquiry',
  profile: {},
  fieldMeta: {},
  history: [],
  documents: {},
  createdAt: new Date(),
  updatedAt: new Date(),
});
assert.equal(await candidates().countDocuments({ waId: '919800000001' }), 1);

console.log('\x1b[32mok\x1b[0m CRM deletion releases a WhatsApp candidate for registration again');

await closeDb();
await mongo.stop();
