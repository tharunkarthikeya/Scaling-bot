/**
 * A WhatsApp question accepts its first option and makes every later tap on
 * that same message inert, even though WhatsApp leaves old buttons visible.
 */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'single_answer_test';
process.env.REDIS_URL = '';
process.env.RESUME_ATS_DB = '';
process.env.ROLE = 'all';
process.env.SHADOW_MODE = 'true';
process.env.CRM_API_URL = '';
process.env.CRM_API_KEY = '';

const { connectDb, closeDb } = await import('./db/client.js');
const {
  appendTurn,
  candidates,
  ensureIndexes,
  findConversation,
  turnsFor,
} = await import('./db/models.js');
const { getOrCreateCandidate, handleInboundMessage } = await import(
  './conversation/engine.js'
);

await connectDb();
await ensureIndexes();

const waId = '919700000002';
const { candidate } = await getOrCreateCandidate({
  waId,
  phone: waId,
  profileName: 'Single Answer Candidate',
});
const now = new Date();

await candidates().updateOne(
  { _id: candidate._id },
  {
    $set: {
      enquiry: 'apply',
      stage: 'CV_PENDING',
      status: 'registration_started',
      language: 'en',
      languageChosen: true,
      consent: { given: true, at: now, source: 'whatsapp_chat' },
      currentStep: 'country_strictness',
      lastInboundAt: now,
      profile: { lookingForOverseasJob: true, countryPreference: 'singapore' },
      updatedAt: now,
    },
  },
);

const questionWamid = 'wamid.country-strictness';
await appendTurn({
  waId,
  direction: 'outbound',
  wamid: questionWamid,
  type: 'interactive',
  text: 'Is this your strict preference?',
  step: 'country_strictness',
  at: now,
});

const firstWamid = 'wamid.first-answer';
await appendTurn({
  waId,
  direction: 'inbound',
  wamid: firstWamid,
  type: 'interactive',
  text: 'Any suitable country',
  replyId: 'any',
  contextWamid: questionWamid,
  at: new Date(now.getTime() + 1),
});
await handleInboundMessage({ waId, wamid: firstWamid });

const afterFirst = await findConversation(waId);
assert.equal(afterFirst?.profile.countryStrictness, 'any');
assert.notEqual(afterFirst?.currentStep, 'country_strictness');

const outboundAfterFirst = (await turnsFor(waId)).filter(
  (turn) => turn.direction === 'outbound',
).length;

const secondWamid = 'wamid.second-answer';
await appendTurn({
  waId,
  direction: 'inbound',
  wamid: secondWamid,
  type: 'interactive',
  text: 'Only these countries',
  replyId: 'strict',
  contextWamid: questionWamid,
  at: new Date(now.getTime() + 2),
});
await handleInboundMessage({ waId, wamid: secondWamid });

const afterSecond = await findConversation(waId);
const outboundAfterSecond = (await turnsFor(waId)).filter(
  (turn) => turn.direction === 'outbound',
).length;

assert.equal(afterSecond?.profile.countryStrictness, 'any', 'the second option replaced the first');
assert.equal(
  afterSecond?.currentStep,
  afterFirst?.currentStep,
  'the second option advanced or changed the open question',
);
assert.equal(
  outboundAfterSecond,
  outboundAfterFirst,
  'the second option caused another bot message',
);

await closeDb();
await mongo.stop();

console.log('\n\x1b[32mok\x1b[0m  one question accepted exactly one option\n');
