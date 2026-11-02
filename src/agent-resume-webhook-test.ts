/**
 * The webhook gate for Sourcing Hub senders, against an in-memory MongoDB.
 *
 * A file from a Sourcing Hub agent is queued as an agent résumé (once, even if
 * Meta delivers it twice), their text as an agent question. Clients and
 * associations, on any of their contact numbers, get nothing, and no Sourcing
 * Hub number ever reaches the candidate conversation. A number on the CRM
 * suppression list gets nothing at all, on any line.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'agent_resume_webhook_test';
process.env.REDIS_URL = '';
process.env.RESUME_ATS_DB = '';
process.env.ROLE = 'all';
process.env.SHADOW_MODE = 'true';
process.env.MOCK_WHATSAPP_MEDIA = 'true';
process.env.CRM_API_URL = 'https://crm.example.com';
process.env.CRM_API_KEY = 'service-key';

const { config } = await import('./config.js');
const { connectDb, closeDb } = await import('./db/client.js');
const { ensureIndexes } = await import('./db/models.js');
const { queue } = await import('./queue/index.js');
const { buildServer } = await import('./server.js');

const AGENT = '919876543210';
const CANDIDATE = '919000000009';
/** An agent the administrator also suppressed. */
const SUPPRESSED_AGENT = '919811122233';
/** A Gulf candidate, suppressed. The CRM serves it as its last ten digits. */
const SUPPRESSED_GULF = '971501234567';
/** A Sourcing Hub client's first and second contacts. */
const CLIENT_CONTACTS = ['919555555555', '971551112222'];
/** A Sourcing Hub row from a CRM too old to report `sourcing_type`. */
const UNTYPED_SOURCING = '919444444444';

/** Every CRM or Graph call other than the two gate lookups. */
const otherCalls: string[] = [];

const SOURCING = { should_reply: false, action: 'ignore', reason: 'sourcing_contact_number' };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  if (String(input) === 'https://crm.example.com/whatsapp/reply-policy') {
    const { phone } = JSON.parse(String(init?.body)) as { phone: string };
    // The CRM's answer before suppression was checked first: a suppressed
    // agent came back as an agent. The bot must not rely on that order.
    if (phone === AGENT || phone === SUPPRESSED_AGENT) {
      return Response.json({ ...SOURCING, sourcing_type: 'agent' });
    }
    if (CLIENT_CONTACTS.includes(phone)) return Response.json({ ...SOURCING, sourcing_type: 'client' });
    if (phone === UNTYPED_SOURCING) return Response.json(SOURCING);
    return Response.json({ should_reply: true, action: 'continue', reason: 'external_number' });
  }
  if (String(input) === 'https://crm.example.com/bot-suppression-directory') {
    return Response.json({ numbers: ['9811122233', '1501234567'] });
  }
  otherCalls.push(String(input));
  return realFetch(input, init);
}) as typeof fetch;

await connectDb();
await ensureIndexes();

const agentJobs: unknown[] = [];
const inboundJobs: unknown[] = [];
const questionJobs: unknown[] = [];
queue.register('agent_resume', async (payload) => void agentJobs.push(payload));
queue.register('agent_question', async (payload) => void questionJobs.push(payload));
queue.register('inbound_message', async (payload) => void inboundJobs.push(payload));
await queue.start();

const app = await buildServer();

async function deliver(
  waId: string,
  message: Record<string, unknown>,
  line = '558448830676126',
): Promise<number> {
  const raw = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'WABA',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: line },
            contacts: [{ wa_id: waId, profile: { name: 'Imran' } }],
            messages: [{ from: waId, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
          },
        }],
      }],
    }),
  );
  const signature =
    'sha256=' + crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    payload: raw,
  });
  return res.statusCode;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  agentJobs.length = 0;
  inboundJobs.length = 0;
  questionJobs.length = 0;
  otherCalls.length = 0;
  await run();
  passed++;
  console.log(`  \x1b[32mok\x1b[0m  ${name}`);
}

console.log('\n\x1b[1mAgent résumés at the webhook\x1b[0m');

await check('a document from a Sourcing Hub contact is queued as an agent résumé, once', async () => {
  const message = {
    id: 'wamid.AGENT-DOC-1',
    type: 'document',
    document: { id: 'MEDIA-1', mime_type: 'application/pdf', filename: 'ramesh.pdf' },
  };
  assert.equal(await deliver(AGENT, message), 200);
  assert.equal(await deliver(AGENT, message), 200); // Meta redelivers
  await settle();
  assert.deepEqual(agentJobs, [{
    waId: AGENT,
    wamid: 'wamid.AGENT-DOC-1',
    mediaId: 'MEDIA-1',
    mimeType: 'application/pdf',
    filename: 'ramesh.pdf',
    phoneNumberId: '558448830676126',
  }]);
  assert.equal(inboundJobs.length, 0, 'an agent reached the candidate conversation');
});

await check('a photo from a Sourcing Hub contact is queued too', async () => {
  await deliver(AGENT, { id: 'wamid.AGENT-IMG-1', type: 'image', image: { id: 'MEDIA-2', mime_type: 'image/jpeg' } });
  await settle();
  assert.equal(agentJobs.length, 1);
  assert.equal(inboundJobs.length, 0);
});

await check('text from a Sourcing Hub contact is queued as an agent question, never as a candidate', async () => {
  await deliver(AGENT, {
    id: 'wamid.AGENT-TXT-1',
    type: 'text',
    text: { body: 'What is the salary?' },
    context: { from: '919884447455', id: 'wamid.JOB-ORDER-TEMPLATE' },
  });
  await settle();
  assert.deepEqual(questionJobs, [{
    waId: AGENT,
    wamid: 'wamid.AGENT-TXT-1',
    text: 'What is the salary?',
    contextWamid: 'wamid.JOB-ORDER-TEMPLATE',
    phoneNumberId: '558448830676126',
  }]);
  assert.equal(agentJobs.length, 0);
  assert.equal(inboundJobs.length, 0);
});

await check('a candidate sending a document still goes to the candidate conversation', async () => {
  const status = await deliver(CANDIDATE, {
    id: 'wamid.CAND-DOC-1',
    type: 'document',
    document: { id: 'MEDIA-3', mime_type: 'application/pdf', filename: 'me.pdf' },
  });
  assert.equal(status, 200);
  await settle();
  assert.equal(agentJobs.length, 0);
  assert.equal(inboundJobs.length, 1);
});

await check('every contact of a Sourcing Hub client gets nothing, first contact or second', async () => {
  for (const [i, phone] of CLIENT_CONTACTS.entries()) {
    await deliver(phone, {
      id: `wamid.CLIENT-DOC-${i}`,
      type: 'document',
      document: { id: `MEDIA-C${i}`, mime_type: 'application/pdf', filename: 'requirement.pdf' },
    });
    await deliver(phone, { id: `wamid.CLIENT-TXT-${i}`, type: 'text', text: { body: 'Need 20 welders' } });
  }
  await settle();
  assert.equal(agentJobs.length, 0, 'a client was handed to the agent résumé worker');
  assert.equal(questionJobs.length, 0, 'a client was handed to the agent question worker');
  assert.equal(inboundJobs.length, 0, 'a client reached the candidate conversation');
});

await check('a Sourcing Hub number without a reported type is not treated as an agent', async () => {
  await deliver(UNTYPED_SOURCING, {
    id: 'wamid.UNTYPED-DOC',
    type: 'document',
    document: { id: 'MEDIA-U', mime_type: 'application/pdf', filename: 'cv.pdf' },
  });
  await settle();
  assert.equal(agentJobs.length + questionJobs.length + inboundJobs.length, 0);
});

await check('a suppressed agent gets nothing: no résumé intake, no question answer, no candidate flow', async () => {
  assert.equal(await deliver(SUPPRESSED_AGENT, {
    id: 'wamid.SUP-AGENT-DOC',
    type: 'document',
    document: { id: 'MEDIA-4', mime_type: 'application/pdf', filename: 'cv.pdf' },
  }), 200);
  assert.equal(await deliver(SUPPRESSED_AGENT, {
    id: 'wamid.SUP-AGENT-TXT',
    type: 'text',
    text: { body: 'Any update on the welder job?' },
  }), 200);
  await settle();
  assert.equal(agentJobs.length, 0, 'a suppressed agent was queued for résumé intake');
  assert.equal(questionJobs.length, 0, 'a suppressed agent was queued for an answer');
  assert.equal(inboundJobs.length, 0, 'a suppressed agent reached the candidate conversation');
});

await check('a suppressed Gulf number is matched on its last ten digits and ignored', async () => {
  await deliver(SUPPRESSED_GULF, { id: 'wamid.SUP-GULF', type: 'text', text: { body: 'Hi' } });
  await settle();
  assert.equal(inboundJobs.length, 0);
});

await check('a suppressed number on the attendance line is not answered by attendance either', async () => {
  const line = config.WHATSAPP_ATTENDANCE_PHONE_NUMBER_ID ?? 'ATTENDANCE-LINE';
  assert.equal(
    await deliver(SUPPRESSED_AGENT, { id: 'wamid.SUP-ATT', type: 'text', text: { body: 'IN' } }, line),
    200,
  );
  await settle();
  assert.deepEqual(otherCalls, [], 'the attendance workflow ran for a suppressed number');
  assert.equal(inboundJobs.length + agentJobs.length + questionJobs.length, 0);
});

console.log(`\n${passed} passed\n`);
await app.close();
await closeDb();
await mongo.stop();
process.exit(0);
