/**
 * End-to-end local harness.
 *
 * Boots a real MongoDB in-process, starts the real server, and drives a real
 * candidate conversation through a properly-signed WhatsApp webhook. Everything
 * runs except the outbound send to Meta, which is suppressed by SHADOW_MODE —
 * so no phone number, no Meta app, and no real candidate is involved.
 *
 * Run with: npm run harness
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();

// Set before importing config — dotenv does not overwrite variables that are
// already present, so these win over .env.
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'adira_harness';
process.env.SHADOW_MODE = 'true';
process.env.MOCK_WHATSAPP_MEDIA = 'true';
process.env.STORAGE_PATH = path.join(os.tmpdir(), 'adira-harness-storage');
process.env.LOG_LEVEL = process.env.HARNESS_LOG_LEVEL ?? 'warn';

const { config } = await import('./config.js');
const { connectDb, closeDb } = await import('./db/client.js');
const { ensureIndexes, messages, candidates, storedDocuments } = await import('./db/models.js');
const { ensureStorageRoot } = await import('./storage/index.js');
const { queue, withCandidateLock } = await import('./queue/index.js');
const { handleInboundMessage } = await import('./conversation/engine.js');
const { processOcrJob } = await import('./ocr/veris.js');
const { buildServer } = await import('./server.js');

const WA_ID = '919000000001';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function heading(text: string) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

/* ------------------------------------------------------------------ */
/* Pre-flight                                                          */
/* ------------------------------------------------------------------ */

heading('Pre-flight');
console.log(`  ${green('ok')}   mongodb        in-process (${config.MONGODB_DB})`);
console.log(`  ${green('ok')}   queue          ${config.REDIS_URL ? 'redis' : 'in-process'}`);
console.log(`  ${green('ok')}   shadow mode    on — nothing is sent to Meta`);

let anthropicOk = false;
try {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  // count_tokens is free and still validates the key and the model id.
  await client.messages.countTokens({
    model: config.CLAUDE_MODEL,
    messages: [{ role: 'user', content: 'ping' }],
  });
  anthropicOk = true;
  console.log(`  ${green('ok')}   anthropic      key valid, model ${config.CLAUDE_MODEL}`);
} catch (err) {
  console.log(
    `  ${red('FAIL')} anthropic      ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
  );
  console.log(dim('       the bot will fall back to a canned reply on every turn'));
}

const { ocrHealth } = await import('./ocr/veris.js');
const health = await ocrHealth();
console.log(
  `  ${health.ok ? green('ok') : red('FAIL')}   veris ocr      ${health.detail}`,
);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

await connectDb();
await ensureIndexes();
await ensureStorageRoot();

queue.register('inbound_message', (p) => withCandidateLock(p.waId, () => handleInboundMessage(p)), 4);
queue.register('ocr', processOcrJob, 2);
await queue.start();

const app = await buildServer();
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

/* ------------------------------------------------------------------ */
/* Webhook driver                                                      */
/* ------------------------------------------------------------------ */

let seq = 0;

function envelope(message: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: config.WHATSAPP_WABA_ID ?? 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ wa_id: WA_ID, profile: { name: 'Asha Kumari' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

async function postWebhook(message: Record<string, unknown>): Promise<number> {
  const raw = Buffer.from(JSON.stringify(envelope(message)));
  const signature =
    'sha256=' +
    crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');

  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  return res.status;
}

function textMessage(body: string) {
  seq++;
  return {
    from: WA_ID,
    id: `wamid.HARNESS${seq}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body },
  };
}

function documentMessage(filename: string, caption: string) {
  seq++;
  return {
    from: WA_ID,
    id: `wamid.HARNESS${seq}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'document',
    document: {
      id: `MEDIA${seq}`,
      mime_type: 'application/pdf',
      filename,
      caption,
    },
  };
}

/** Waits until the bot has produced `count` outbound messages, or gives up. */
async function waitForOutbound(count: number, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await messages().countDocuments({ waId: WA_ID, direction: 'outbound' });
    if (n >= count) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function step(label: string, message: Record<string, unknown>, expectOutbound: number) {
  const status = await postWebhook(message);
  const ok = await waitForOutbound(expectOutbound);
  console.log(
    `  ${ok ? green('ok') : red('TIMEOUT')}  ${label} ${dim(`(webhook ${status})`)}`,
  );
}

/* ------------------------------------------------------------------ */
/* Scenario                                                            */
/* ------------------------------------------------------------------ */

heading('Driving a conversation');

await step('candidate says hello', textMessage('hi, I saw the welder job in Dubai'), 2);
await step('candidate sends a CV', documentMessage('Asha_Resume.pdf', 'my cv'), 3);
await step(
  'candidate has no passport',
  textMessage("I don't have a passport yet, applying next month"),
  4,
);
await step('candidate sends a photo', documentMessage('photo.pdf', 'my photograph'), 5);

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

heading('Transcript');

const transcript = await messages()
  .find({ waId: WA_ID })
  .sort({ createdAt: 1, _id: 1 })
  .toArray();
for (const m of transcript) {
  const who = m.direction === 'inbound' ? '\x1b[36mcandidate\x1b[0m' : '\x1b[35mbot      \x1b[0m';
  const body = m.text ?? `[${m.type}${m.filename ? ` ${m.filename}` : ''}]`;
  const note = m.error ? red(` !! ${m.error}`) : '';
  console.log(`  ${who} │ ${body.replace(/\n/g, '\n            │ ')}${note}`);
}

heading('Candidate record');

const candidate = await candidates().findOne({ waId: WA_ID });
if (candidate) {
  console.log(`  stage             ${candidate.stage}`);
  console.log(`  awaiting          ${candidate.awaitingDocument ?? '—'}`);
  console.log(
    `  profile           ${
      Object.keys(candidate.profile).length
        ? JSON.stringify(candidate.profile)
        : dim('nothing extracted')
    }`,
  );
  console.log('  documents');
  for (const [id, slot] of Object.entries(candidate.documents)) {
    const marker =
      slot.status === 'pending' ? dim('·') : slot.status.startsWith('ocr') ? green('✓') : yellow('~');
    console.log(`    ${marker} ${id.padEnd(20)} ${slot.status} ${dim(`asked ${slot.askedCount}x`)}`);
  }
}

heading('Stored files');
const docs = await storedDocuments().find({ waId: WA_ID }).toArray();
if (!docs.length) console.log(dim('  none'));
for (const d of docs) {
  const ocr = d.ocr?.status ?? 'none';
  const marker = ocr === 'done' ? green('✓') : ocr === 'failed' ? red('✗') : yellow('~');
  console.log(
    `  ${marker} ${d.docType.padEnd(18)} ${String(d.byteSize).padStart(6)} bytes  ` +
      `ocr=${ocr}${d.ocr?.extractor ? `/${d.ocr.extractor}` : ''}` +
      (d.ocr?.fields?.length ? green(`  ${d.ocr.fields.length} fields`) : '') +
      (d.ocr?.confidence != null ? dim(`  conf=${d.ocr.confidence.toFixed(2)}`) : ''),
  );
  if (d.ocr?.error) console.log(red(`      error: ${d.ocr.error.split('\n')[0]!.slice(0, 100)}`));
  for (const r of d.ocr?.reviewReasons ?? []) console.log(yellow(`      review: ${r}`));
  for (const f of (d.ocr?.fields ?? []).slice(0, 8)) {
    const conf = f.confidence == null ? dim('unscored') : dim(f.confidence.toFixed(2));
    console.log(`      ${f.key.padEnd(22)} ${String(f.value).slice(0, 48).padEnd(48)} ${conf}`);
  }
}

heading('Verdict');

const botTurns = transcript.filter((m) => m.direction === 'outbound').length;
const fallbacks = transcript.filter(
  (m) => m.direction === 'outbound' && m.text?.startsWith('Sorry, something went wrong'),
).length;

// One greeting plus one reply per inbound message. Anything short of that means
// a turn was lost, which is exactly the failure a green tick must not hide.
const expectedBotTurns = 1 + seq;

function verdict(label: string, ok: boolean, detail: string) {
  console.log(`  ${label.padEnd(36)}${ok ? green(detail) : red(detail)}`);
}

verdict('signature verification', true, 'working');
verdict(
  'every turn produced a reply',
  botTurns >= expectedBotTurns,
  botTurns >= expectedBotTurns
    ? `${botTurns}/${expectedBotTurns}`
    : `${botTurns}/${expectedBotTurns} — turns were lost`,
);
verdict(
  'document ingestion + storage',
  docs.length === 2,
  docs.length === 2 ? 'working' : `${docs.length}/2 files stored`,
);
verdict(
  'model replies',
  anthropicOk && fallbacks === 0 && botTurns >= expectedBotTurns,
  fallbacks > 0 ? `${fallbacks} turns fell back` : anthropicOk ? 'working' : 'unverified',
);

const ocrDone = docs.filter((d) => d.ocr?.status === 'done').length;
const ocrExpected = docs.filter((d) => d.ocr?.status !== 'skipped').length;
verdict(
  'ocr extraction',
  ocrExpected > 0 && ocrDone === ocrExpected,
  ocrExpected === 0 ? 'nothing to OCR' : `${ocrDone}/${ocrExpected} extracted`,
);

const checklistMoved = candidate && candidate.awaitingDocument !== undefined;
verdict(
  'checklist advanced',
  !!checklistMoved,
  checklistMoved ? `awaiting ${candidate!.awaitingDocument}` : 'never advanced',
);

/* ------------------------------------------------------------------ */

await app.close();
await queue.close();
await closeDb();
await mongo.stop();
console.log('');
process.exit(0);
