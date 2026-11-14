/** Agents' résumés: which messages qualify, the CRM hand-off, and that the agent is never replied to. Offline. */
import assert from 'node:assert/strict';

process.env.REDIS_URL = '';
process.env.SHADOW_MODE = 'false';
process.env.MOCK_WHATSAPP_MEDIA = 'false';
process.env.CRM_API_URL = 'https://crm.example.com';
process.env.CRM_API_KEY = 'service-key';

const { isAgentResumeMessage, processAgentResume } = await import('./agents/resumes.js');
const { refreshBotSuppressionNumbers } = await import('./crm/suppression.js');

type Call = { url: string; init?: RequestInit };
const calls: Call[] = [];
let crmReply: () => Response;
/** The CRM suppression directory, as last-ten-digit keys. */
let suppressed: string[] = [];

const MEDIA_ID = 'MEDIA-1';
const FILE_URL = 'https://media.example.com/file-1';

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === 'https://crm.example.com/bot-suppression-directory') {
    return Response.json({ numbers: suppressed });
  }
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

/** Anything sent to WhatsApp. An agent must never be sent a reply. */
const sentMessages = () => calls.filter((c) => c.url.endsWith('/messages'));
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

await check('the file goes to the CRM with the sender and message id, and the agent is not replied to', async () => {
  await processAgentResume(JOB);
  const crm = crmCall();
  assert.ok(crm, 'the CRM was not called');
  assert.equal((crm.init?.headers as Record<string, string>)['X-Service-Key'], 'service-key');
  const form = crm.init?.body as FormData;
  assert.equal(form.get('phone'), '919876543210');
  assert.equal(form.get('wamid'), 'wamid.AGENT-1');
  assert.equal(form.get('line_id'), '558448830676126');
  assert.equal((form.get('file') as File).name, 'ramesh.pdf');
  assert.equal(sentMessages().length, 0, 'the agent was sent a reply');
});

await check('a photo with no filename is still sent, with a sensible name', async () => {
  await processAgentResume({ ...JOB, filename: undefined });
  assert.equal(((crmCall()?.init?.body as FormData).get('file') as File).name, 'resume.pdf');
});

await check('no outcome sends the agent anything: refused, duplicate, ignored or CRM error', async () => {
  const outcomes: Array<() => Response> = [
    () => Response.json({ status: 'rejected', code: 'duplicate_candidate', message: 'exists: Someone Else (CND-9)' }),
    () => Response.json({ status: 'rejected', code: 'not_a_resume' }),
    () => Response.json({ status: 'rejected', code: 'missing_candidate_contact' }),
    () => Response.json({ status: 'error', code: 'resume_ocr_failed' }),
    () => Response.json({ status: 'ignored', reason: 'not_an_agent' }),
    () => new Response('bad request', { status: 400 }),
  ];
  for (const outcome of outcomes) {
    crmReply = outcome;
    await processAgentResume(JOB);
  }
  assert.equal(sentMessages().length, 0, 'the agent was sent a reply');
});

await check('the CRM being down is retried, not answered', async () => {
  crmReply = () => new Response('down', { status: 503 });
  await assert.rejects(processAgentResume(JOB));
  assert.equal(sentMessages().length, 0);
});

await check('a message the CRM is still reading is retried for its outcome', async () => {
  crmReply = () => Response.json({ status: 'processing' });
  await assert.rejects(processAgentResume(JOB), /still being processed/);
  assert.equal(sentMessages().length, 0);
});

await check('an agent suppressed while the job waited gets nothing: no download, no intake, no reply', async () => {
  suppressed = ['9876543210'];
  await refreshBotSuppressionNumbers();
  try {
    await processAgentResume(JOB);
    assert.deepEqual(calls, []);
  } finally {
    suppressed = [];
    await refreshBotSuppressionNumbers();
  }
});

console.log(`\n${passed} passed\n`);
process.exit(0);
