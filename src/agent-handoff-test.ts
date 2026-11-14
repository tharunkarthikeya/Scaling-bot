/**
 * The one "contact the staff" message an agent can get, against an in-memory
 * MongoDB and a stubbed WhatsApp API. The point of every check: never twice.
 */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'agent_handoff_test';
process.env.REDIS_URL = '';
process.env.SHADOW_MODE = 'false';
process.env.WHATSAPP_AGENT_HANDOFF_PHONE_NUMBER_ID = '1344483985421841';
// Set explicitly: otherwise dotenv fills in the real CRM from .env.
process.env.CRM_API_URL = 'https://crm.example.com';
process.env.CRM_API_KEY = 'service-key';

const { connectDb, closeDb, getDb } = await import('./db/client.js');
const { ensureIndexes } = await import('./db/models.js');
const { agentHandoffs, agentNotices, rememberAgentNotice } = await import('./agents/store.js');
const { agentHandoffMessage, isAgentHandoffLine, processAgentHandoff } = await import('./agents/handoff.js');
const { refreshBotSuppressionNumbers } = await import('./crm/suppression.js');

await connectDb();
await ensureIndexes();

const LINE = '1344483985421841';
const ZARA = { staffName: 'Zara', staffPhone: '+91 98765 43210' };

let suppressed: string[] = [];
const sent: Array<{ url: string; body: any }> = [];
/** Make WhatsApp refuse the next message with this Graph error. */
let refuseNext: { status: number; code: number } | undefined;
/** Make the next message fail as a network error (delivery unknown). */
let dropNext = false;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  if (String(url) === 'https://crm.example.com/bot-suppression-directory') {
    return Response.json({ numbers: suppressed });
  }
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (dropNext) {
    dropNext = false;
    throw new TypeError('fetch failed');
  }
  if (refuseNext) {
    const { status, code } = refuseNext;
    refuseNext = undefined;
    return Response.json({ error: { message: 'refused', code } }, { status });
  }
  sent.push({ url: String(url), body });
  return Response.json({ messages: [{ id: `wamid.OUT${sent.length}` }] });
}) as typeof fetch;
const textsTo = (waId: string) => sent.filter((s) => s.body.to === waId).map((s) => s.body.text.body as string);

let n = 0;
const message = (waId: string, extra: Record<string, string> = {}) =>
  processAgentHandoff({ waId, wamid: `wamid.IN${++n}`, phoneNumberId: LINE, ...extra });

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  sent.length = 0;
  await run();
  passed++;
  console.log(`  \x1b[32mok\x1b[0m  ${name}`);
}

console.log('\n\x1b[1mAgent "contact the staff" message: once, ever\x1b[0m');

await check('only +91 63817 27653 (1344483985421841) is the hand-off line', () => {
  assert.equal(isAgentHandoffLine(LINE), true);
  assert.equal(isAgentHandoffLine('558448830676126'), false, "Rafi's line");
  assert.equal(isAgentHandoffLine(undefined), false);
});

await check('the message names the staff member and their number', () => {
  assert.equal(
    agentHandoffMessage({ name: 'Zara', phone: '+91 98765 43210' }),
    'For any queries, please contact Zara - +91 98765 43210.',
  );
  assert.equal(agentHandoffMessage({ name: '', phone: '' }), null);
});

await check('the first message gets it, from the hand-off line; every later one gets nothing', async () => {
  const agent = '919100000001';
  await message(agent, ZARA);
  await message(agent, ZARA);
  await message(agent, ZARA);
  await message(agent, { staffName: 'Someone Else', staffPhone: '+91 90000 00000' }); // reassigned later
  assert.deepEqual(textsTo(agent), ['For any queries, please contact Zara - +91 98765 43210.']);
  assert.ok(sent[0]!.url.endsWith(`/${LINE}/messages`));
});

await check('a burst of messages handled at the same moment sends it once', async () => {
  const agent = '919100000002';
  await Promise.all(Array.from({ length: 10 }, () => message(agent, ZARA)));
  assert.equal(textsTo(agent).length, 1);
});

await check('the same job run twice (a queue retry) sends it once', async () => {
  const agent = '919100000003';
  const job = { waId: agent, wamid: 'wamid.RETRY', phoneNumberId: LINE, ...ZARA };
  await processAgentHandoff(job);
  await processAgentHandoff(job);
  assert.equal(textsTo(agent).length, 1);
});

await check('WhatsApp refusing the send keeps the lock: the agent is never sent it later', async () => {
  const agent = '919100000004';
  refuseNext = { status: 400, code: 131000 };
  await message(agent, ZARA);
  await message(agent, ZARA);
  assert.equal(textsTo(agent).length, 0);
});

await check('a send that timed out (maybe delivered) keeps the lock too', async () => {
  const agent = '919100000005';
  dropNext = true;
  await message(agent, ZARA);
  await message(agent, ZARA);
  assert.equal(textsTo(agent).length, 0);
});

await check('with no handling staff, the newest job order contact is named', async () => {
  const agent = '919100000006';
  const details = {
    title: 'Welder', destination_country: 'Qatar', industry: '', vacancies: '', gender: '', salary: '',
    experience: '', process_time: '', b2b_rate: '', remarks: '',
  };
  await rememberAgentNotice({
    waId: agent, jobOrderId: 'OLD', sentAt: new Date(Date.now() - 60_000),
    details: { ...details, staff_name: 'Rafi', staff_phone: '+91 98844 47455' },
  });
  await rememberAgentNotice({
    waId: agent, jobOrderId: 'NEW', sentAt: new Date(),
    details: { ...details, staff_name: 'Priya', staff_phone: '+91 91234 56789' },
  });
  await message(agent);
  assert.deepEqual(textsTo(agent), ['For any queries, please contact Priya - +91 91234 56789.']);
});

await check('with nobody to name, nothing is sent and the once is not used up', async () => {
  const agent = '919100000007';
  await message(agent);
  assert.equal(textsTo(agent).length, 0);
  assert.equal(await agentHandoffs().countDocuments({ _id: agent }), 0);
  await message(agent, ZARA); // a staff member was assigned since
  await message(agent, ZARA);
  assert.equal(textsTo(agent).length, 1);
});

await check('an agent who got the earlier hand-off (before 2026-11-14) never gets it again', async () => {
  const before = '919100000008';
  const legacy = '919100000009';
  await agentHandoffs().insertOne({ _id: before, to: 'Rafi - +91 98844 47455', wamid: 'wamid.OLD', at: new Date() });
  await getDb().collection('agent_questions').insertMany([
    { waId: legacy, wamid: 'wamid.L1', question: 'salary?', reply: 'For this, please contact Rafi.', answered: false, at: new Date() },
    { waId: '919100000010', wamid: 'wamid.L2', question: 'salary?', reply: 'EUR 900', answered: true, at: new Date() },
  ]);
  await ensureIndexes(); // what startup does: carries the old hand-offs into the lock
  await message(before, ZARA);
  await message(legacy, ZARA);
  await message('919100000010', ZARA); // only ever got a real answer, so gets it once
  assert.equal(textsTo(before).length, 0);
  assert.equal(textsTo(legacy).length, 0);
  assert.equal(textsTo('919100000010').length, 1);
});

await check('a suppressed agent gets nothing and uses up nothing', async () => {
  const agent = '919100000011';
  suppressed = ['9100000011'];
  await refreshBotSuppressionNumbers();
  try {
    await message(agent, ZARA);
    assert.equal(textsTo(agent).length, 0);
    assert.equal(await agentHandoffs().countDocuments({ _id: agent }), 0);
  } finally {
    suppressed = [];
    await refreshBotSuppressionNumbers();
  }
});

assert.ok((await agentNotices().countDocuments()) > 0);
console.log(`\n${passed} passed\n`);
await closeDb();
await mongo.stop();
process.exit(0);
