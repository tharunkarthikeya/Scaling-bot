/** Agents' résumés: which messages qualify, the CRM hand-off, and the reply. Offline. */
import assert from 'node:assert/strict';

process.env.REDIS_URL = '';
process.env.SHADOW_MODE = 'false';
process.env.MOCK_WHATSAPP_MEDIA = 'false';
process.env.CRM_API_URL = 'https://crm.example.com';
process.env.CRM_API_KEY = 'service-key';

const { agentResumeReply, isAgentResumeMessage, processAgentResume } = await import('./agents/resumes.js');

type Call = { url: string; init?: RequestInit };
const calls: Call[] = [];
let crmReply: () => Response;

const MEDIA_ID = 'MEDIA-1';
const FILE_URL = 'https://media.example.com/file-1';

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.endsWith(`/${MEDIA_ID}`)) {
    return Response.json({ url: FILE_URL, mime_type: 'application/pdf', file_size: 9 });
  }
  if (url === FILE_URL) return new Response(new Uint8Array(Buffer.from('%PDF-1.4 ')));
  if (url === 'https://crm.example.com/agent-resumes') return crmReply();
  if (url.endsWith('/messages')) return Response.json({ messages: [{ id: 'wamid.REPLY' }] });
  return new Response('unexpected', { status: 500 });
}) as typeof fetch;

const JOB = {
  waId: '919876543210',
  wamid: 'wamid.AGENT-1',
  mediaId: MEDIA_ID,
  mimeType: 'application/pdf',
  filename: 'ramesh.pdf',
  phoneNumberId: '558448830676126',
};

const sentTexts = () =>
  calls
    .filter((c) => c.url.endsWith('/messages'))
    .map((c) => JSON.parse(String(c.init?.body)) as { to: string; text: { body: string } });
const crmCall = () => calls.find((c) => c.url === 'https://crm.example.com/agent-resumes');

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  calls.length = 0;
  crmReply = () => Response.json({ status: 'created', candidate_id: 'c1', candidate_code: 'CND-1001', full_name: 'Ramesh Kumar' });
  await run();
  passed++;
  console.log(`  \x1b[32mok\x1b[0m  ${name}`);
}

console.log('\n\x1b[1mAgent résumés\x1b[0m');

await check('documents and photos qualify; text does not', () => {
  assert.equal(isAgentResumeMessage({ type: 'document', media: { id: 'm' } }), true);
  assert.equal(isAgentResumeMessage({ type: 'image', media: { id: 'm' } }), true);
  assert.equal(isAgentResumeMessage({ type: 'text' }), false);
  assert.equal(isAgentResumeMessage({ type: 'audio', media: { id: 'm' } }), false);
});

await check('the reply names the candidate and their CRM id when one is created', () => {
  assert.equal(
    agentResumeReply({ status: 'created', candidate_id: 'c', candidate_code: 'CND-1', full_name: 'Ramesh' }),
    'Received. Ramesh has been added to Adira Enterprises (ID: CND-1). Thank you.',
  );
});

await check('each refusal gets a reply that says what to do, and never names another candidate', () => {
  const dup = agentResumeReply(
    { status: 'rejected', code: 'duplicate_candidate', message: 'A candidate with this email or phone already exists: Someone Else (CND-9).' },
    'cv.pdf',
  )!;
  assert.match(dup, /already registered/);
  assert.doesNotMatch(dup, /Someone Else|CND-9/);
  assert.match(agentResumeReply({ status: 'rejected', code: 'not_a_resume' }, 'pic.jpg')!, /does not look like a résumé/);
  assert.match(agentResumeReply({ status: 'rejected', code: 'missing_candidate_contact' })!, /clearer copy/);
  assert.match(agentResumeReply({ status: 'rejected', code: 'resume_too_large' })!, /20 MB/);
  assert.match(agentResumeReply({ status: 'error', code: 'resume_ocr_failed' })!, /send it again/);
});

await check('clients, associations and inactive agents get no reply', () => {
  assert.equal(agentResumeReply({ status: 'ignored', reason: 'not_an_agent' }), null);
  assert.equal(agentResumeReply({ status: 'processing' }), null);
});

await check('the file goes to the CRM with the sender and message id, and the agent is told', async () => {
  await processAgentResume(JOB);
  const crm = crmCall();
  assert.ok(crm, 'the CRM was not called');
  assert.equal((crm.init?.headers as Record<string, string>)['X-Service-Key'], 'service-key');
  const form = crm.init?.body as FormData;
  assert.equal(form.get('phone'), '919876543210');
  assert.equal(form.get('wamid'), 'wamid.AGENT-1');
  assert.equal(form.get('line_id'), '558448830676126');
  assert.equal((form.get('file') as File).name, 'ramesh.pdf');

  const [reply] = sentTexts();
  assert.ok(reply, 'no reply was sent');
  assert.equal(reply.to, '919876543210');
  assert.match(reply.text.body, /Ramesh Kumar has been added .*CND-1001/);
  // From the line the agent wrote to.
  assert.ok(calls.some((c) => c.url.endsWith('/558448830676126/messages')));
});

await check('a photo with no filename is still sent, with a sensible name', async () => {
  await processAgentResume({ ...JOB, filename: undefined });
  assert.equal(((crmCall()?.init?.body as FormData).get('file') as File).name, 'resume.pdf');
});

await check('a non-agent is left alone: no reply', async () => {
  crmReply = () => Response.json({ status: 'ignored', reason: 'not_an_agent' });
  await processAgentResume(JOB);
  assert.equal(sentTexts().length, 0);
});

await check('the CRM being down is retried, not answered', async () => {
  crmReply = () => new Response('down', { status: 503 });
  await assert.rejects(processAgentResume(JOB));
  assert.equal(sentTexts().length, 0);
});

await check('a message the CRM is still reading is retried for its outcome', async () => {
  crmReply = () => Response.json({ status: 'processing' });
  await assert.rejects(processAgentResume(JOB), /still being processed/);
  assert.equal(sentTexts().length, 0);
});

console.log(`\n${passed} passed\n`);
process.exit(0);
