/**
 * The webhook gate for Sourcing Hub senders, against an in-memory MongoDB.
 *
 * A file from a Sourcing Hub contact is queued as a possible agent résumé
 * (once, even if Meta delivers it twice). Their text is still dropped, and
 * nothing from them ever reaches the candidate conversation.
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

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  if (String(input) === 'https://crm.example.com/whatsapp/reply-policy') {
    const { phone } = JSON.parse(String(init?.body)) as { phone: string };
    return Response.json(
      phone === AGENT
        ? { should_reply: false, action: 'ignore', reason: 'sourcing_contact_number' }
        : { should_reply: true, action: 'continue', reason: 'external_number' },
    );
  }
  if (String(input) === 'https://crm.example.com/bot-suppression-directory') {
    return Response.json({ numbers: [] });
  }
  return realFetch(input, init);
}) as typeof fetch;

await connectDb();
await ensureIndexes();

const agentJobs: unknown[] = [];
const inboundJobs: unknown[] = [];
queue.register('agent_resume', async (payload) => void agentJobs.push(payload));
queue.register('inbound_message', async (payload) => void inboundJobs.push(payload));
await queue.start();

const app = await buildServer();

async function deliver(waId: string, message: Record<string, unknown>): Promise<number> {
  const raw = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'WABA',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '558448830676126' },
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

await check('text from a Sourcing Hub contact is still left alone', async () => {
  await deliver(AGENT, { id: 'wamid.AGENT-TXT-1', type: 'text', text: { body: 'hello Rafi' } });
  await settle();
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

console.log(`\n${passed} passed\n`);
await app.close();
await closeDb();
await mongo.stop();
process.exit(0);
