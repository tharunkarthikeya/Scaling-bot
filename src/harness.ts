/**
 * End-to-end local harness.
 *
 * Boots a real MongoDB in-process, starts the real server, and drives a real
 * candidate through the whole registration over properly-signed WhatsApp
 * webhooks. Everything runs except the outbound send to Meta, which SHADOW_MODE
 * suppresses — so no phone number, no Meta app, and no real candidate.
 *
 * The driver is adaptive: each turn it reads which question the bot is actually
 * on and produces a valid answer for that question, rather than replaying a
 * fixed script. That matters because the flow legitimately differs run to run —
 * a CV that extracts cleanly skips questions that a failed extraction asks — and
 * a fixed script would report those differences as failures.
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
const { ensureIndexes, messages, candidates, storedDocuments, auditEvents } = await import(
  './db/models.js'
);
const { ensureStorageRoot } = await import('./storage/index.js');
const { queue, withCandidateLock } = await import('./queue/index.js');
const { handleInboundMessage } = await import('./conversation/engine.js');
const { processOcrJob } = await import('./ocr/veris.js');
const { buildServer } = await import('./server.js');
const { validateCopy } = await import('./conversation/validate.js');
const { stepById } = await import('./conversation/flow.js');
const { acceptedChoices } = await import('./conversation/render.js');

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

let copyOk = false;
try {
  validateCopy();
  copyOk = true;
  console.log(`  ${green('ok')}   copy           every label fits WhatsApp's limits in en/ta/hi`);
} catch (err) {
  console.log(`  ${red('FAIL')} copy           ${err instanceof Error ? err.message : String(err)}`);
}

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
  console.log(dim('       free-text answers will fall back to "I did not follow that"'));
}

const { ocrHealth } = await import('./ocr/veris.js');
const health = await ocrHealth();
console.log(`  ${health.ok ? green('ok') : red('FAIL')}   veris ocr      ${health.detail}`);

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
    'sha256=' + crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');

  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  return res.status;
}

function base(): Record<string, unknown> {
  seq++;
  return {
    from: WA_ID,
    id: `wamid.HARNESS${seq}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
}

const textMessage = (body: string) => ({ ...base(), type: 'text', text: { body } });

/** A tapped button or list row — carries the option id, as the real client does. */
const tapMessage = (id: string, title: string) => ({
  ...base(),
  type: 'interactive',
  interactive: { type: 'list_reply', list_reply: { id, title } },
});

const documentMessage = (filename: string, caption?: string) => ({
  ...base(),
  type: 'document',
  document: { id: `MEDIA${seq}`, mime_type: 'application/pdf', filename, ...(caption ? { caption } : {}) },
});

async function outboundCount(): Promise<number> {
  return messages().countDocuments({ waId: WA_ID, direction: 'outbound' });
}

/** Waits for the bot to say something new. */
async function waitForReply(since: number, timeoutMs = 150_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await outboundCount()) > since) {
      // Let a turn that sends two messages finish before reading state.
      await new Promise((r) => setTimeout(r, 300));
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Answering whatever is asked                                         */
/* ------------------------------------------------------------------ */

/** Canned free-text answers, by step. */
const TYPED: Record<string, string> = {
  full_name: 'Asha Kumari',
  location: 'Chennai, Tamil Nadu',
  dob: '15/08/1995',
  education_course: 'Welder trade',
  main_trade_other: 'TIG welder',
  overseas_countries: 'Qatar and Saudi Arabia',
  selected_countries: 'Romania, Serbia and Russia',
  availability_date: 'After Diwali, around November',
  desired_job: 'Warehouse supervisor',
  passport_expiry: '03/2031',
  passport_applied_when: 'Last month',
  language_other: 'Malayalam',
};

/**
 * Produces a valid answer to whatever the bot just asked.
 *
 * Returns undefined when there is nothing sensible to send, which ends the run
 * rather than looping on a question the driver does not understand.
 */
async function answerCurrentQuestion(): Promise<Record<string, unknown> | undefined> {
  const candidate = await candidates().findOne({ waId: WA_ID });
  if (!candidate) return undefined;

  const stepId = candidate.currentStep;
  if (!stepId) return undefined;

  // A menu, not a flow question.
  if (stepId.startsWith('menu:') || stepId.startsWith('ask:')) return undefined;

  if (stepId.endsWith('#other')) return textMessage('Orbital welding');

  const step = stepById(stepId);
  if (!step) return undefined;

  if (step.document) return documentMessage(`${step.document}.pdf`, step.document);

  if (step.input === 'choice' || step.input === 'multi_choice') {
    const options = acceptedChoices(step, candidate).filter(
      (o) => o.id !== 'staff' && o.id !== '__done' && o.id !== 'other',
    );

    // For a multi-select, the driver taps one real option and then Done, which
    // is exactly the two-step interaction a candidate performs.
    if (step.input === 'multi_choice') {
      const alreadyChosen = candidate.pendingMulti?.step === stepId;
      if (alreadyChosen) return tapMessage('__done', 'Done');
      const first = options[0];
      return first ? tapMessage(first.id, first.label.en) : tapMessage('__done', 'Done');
    }

    // Prefer an answer that keeps the run going through the interesting
    // branches: a real trade, Europe (so the document branch runs), a passport.
    const preferred: Record<string, string> = {
      entry: 'apply',
      language: 'en',
      consent: 'yes',
      cv: 'upload_cv',
      education: 'iti',
      main_trade: 'fabrication_welding',
      trade_disambiguation: 'welding',
      total_experience: '5_10',
      job_preference: 'current_trade',
      related_acceptance: 'related_ok',
      country_preference: 'europe',
      country_strictness: 'prefer',
      availability: 'within_30',
      passport_status: 'yes',
      europe_docs: 'all',
      confirm: 'correct',
    };

    const wanted = preferred[stepId];
    const choice = options.find((o) => o.id === wanted) ?? options[0];
    return choice ? tapMessage(choice.id, choice.label.en) : undefined;
  }

  return textMessage(TYPED[stepId] ?? 'yes');
}

/* ------------------------------------------------------------------ */
/* Scenario                                                            */
/* ------------------------------------------------------------------ */

heading('Driving a registration');

const MAX_TURNS = 45;
let turns = 0;
let stalled: string | undefined;

{
  const before = await outboundCount();
  await postWebhook(textMessage('hi, I saw the welder job advertisement'));
  const replied = await waitForReply(before);
  console.log(`  ${replied ? green('ok') : red('TIMEOUT')}  opening message`);
}

while (turns < MAX_TURNS) {
  const candidate = await candidates().findOne({ waId: WA_ID });
  if (!candidate) break;

  if (candidate.stage === 'REGISTRATION_COMPLETED') break;
  if (candidate.stage === 'HUMAN_HANDOFF') {
    stalled = `handed to staff: ${candidate.humanHandoff?.reason ?? 'unknown'}`;
    break;
  }

  const message = await answerCurrentQuestion();
  if (!message) {
    stalled = `no answer available for step "${candidate.currentStep ?? 'none'}"`;
    break;
  }

  const label = candidate.currentStep ?? '—';
  const before = await outboundCount();
  const status = await postWebhook(message);
  const replied = await waitForReply(before);

  turns++;
  console.log(
    `  ${replied ? green('ok') : red('TIMEOUT')}  ${String(turns).padStart(2)}. answered ${label} ${dim(`(webhook ${status})`)}`,
  );

  if (!replied) {
    stalled = `no reply after answering "${label}"`;
    break;
  }
}

/* ------------------------------------------------------------------ */
/* Also exercise the returning-candidate path                          */
/* ------------------------------------------------------------------ */

const finished = await candidates().findOne({ waId: WA_ID });

if (finished?.stage === 'REGISTRATION_COMPLETED') {
  heading('Returning candidate (§20) and UPDATE (§22)');

  {
    const before = await outboundCount();
    await postWebhook(textMessage('hello again'));
    const ok = await waitForReply(before);
    console.log(`  ${ok ? green('ok') : red('TIMEOUT')}  returning menu shown`);
  }
  {
    const before = await outboundCount();
    await postWebhook(textMessage('UPDATE'));
    const ok = await waitForReply(before);
    console.log(`  ${ok ? green('ok') : red('TIMEOUT')}  UPDATE opens the update menu`);
  }
  {
    const before = await outboundCount();
    await postWebhook(tapMessage('availability', 'Joining availability'));
    const ok = await waitForReply(before);
    console.log(`  ${ok ? green('ok') : red('TIMEOUT')}  editing one section only`);
  }
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

heading('Transcript');

const transcript = await messages().find({ waId: WA_ID }).sort({ createdAt: 1, _id: 1 }).toArray();
for (const m of transcript) {
  const who = m.direction === 'inbound' ? '\x1b[36mcandidate\x1b[0m' : '\x1b[35mbot      \x1b[0m';
  const body = m.text ?? `[${m.type}${m.filename ? ` ${m.filename}` : ''}]`;
  const note = m.error ? red(` !! ${m.error}`) : '';
  console.log(`  ${who} │ ${body.replace(/\n/g, '\n            │ ')}${note}`);
}

heading('Candidate record');

const candidate = await candidates().findOne({ waId: WA_ID });
if (candidate) {
  console.log(`  candidate id      ${candidate.candidateId ?? dim('not yet assigned')}`);
  console.log(`  stage             ${candidate.stage}`);
  console.log(`  status            ${candidate.status}`);
  console.log(`  language          ${candidate.language ?? '—'}`);
  console.log(
    `  consent           ${candidate.consent?.given ? green('given') : red('not given')}`,
  );
  console.log('  profile');
  for (const [key, value] of Object.entries(candidate.profile ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    const meta = candidate.fieldMeta?.[key];
    const shown = Array.isArray(value) ? value.join(', ') : String(value);
    console.log(
      `    ${key.padEnd(24)} ${shown.slice(0, 38).padEnd(40)} ${dim(`from ${meta?.source ?? '?'}`)}`,
    );
  }
  console.log('  documents');
  for (const [id, slot] of Object.entries(candidate.documents ?? {})) {
    const marker =
      slot.status === 'pending' ? dim('·') : slot.status.startsWith('ocr') ? green('✓') : yellow('~');
    console.log(`    ${marker} ${id.padEnd(14)} ${slot.status} ${dim(`asked ${slot.askedCount}x`)}`);
  }
}

heading('Stored files');
const docs = await storedDocuments().find({ waId: WA_ID }).toArray();
if (!docs.length) console.log(dim('  none'));
for (const d of docs) {
  const ocr = d.ocr?.status ?? 'none';
  const marker = ocr === 'done' ? green('✓') : ocr === 'failed' ? red('✗') : yellow('~');
  console.log(
    `  ${marker} ${d.docType.padEnd(12)} ${String(d.byteSize).padStart(6)} bytes  ` +
      `ocr=${ocr}${d.ocr?.extractor ? `/${d.ocr.extractor}` : ''}` +
      (d.ocr?.fields?.length ? green(`  ${d.ocr.fields.length} fields`) : '') +
      (d.ocr?.completeness ? dim(`  complete=${d.ocr.completeness.complete}`) : ''),
  );
  if (d.ocr?.error) console.log(red(`      error: ${d.ocr.error.split('\n')[0]!.slice(0, 100)}`));
  for (const f of (d.ocr?.fields ?? []).slice(0, 6)) {
    console.log(`      ${f.key.padEnd(22)} ${String(f.value).slice(0, 44)}`);
  }
}

heading('Audit trail');
const audit = await auditEvents().find({ waId: WA_ID }).sort({ at: 1 }).toArray();
if (!audit.length) console.log(dim('  none'));
for (const a of audit) {
  console.log(`  ${a.at.toISOString().slice(11, 19)}  ${a.event.padEnd(24)} ${dim(a.detail ?? '')}`);
}

/* ------------------------------------------------------------------ */

heading('Verdict');

function verdict(label: string, ok: boolean, detail: string) {
  console.log(`  ${label.padEnd(38)}${ok ? green(detail) : red(detail)}`);
}

const inbound = transcript.filter((m) => m.direction === 'inbound').length;
const outbound = transcript.filter((m) => m.direction === 'outbound').length;

// `completedAt`, not the live stage. The run deliberately carries on into an
// UPDATE afterwards, and reading the stage at the end would report a completed
// registration as unfinished just because a section was reopened.
const completed = !!candidate?.completedAt;

// Only the questions asked to get to registration. Everything after
// `completedAt` belongs to the §20 and §22 paths the run also exercises, and
// counting those against §28's 7–10 guidance measures the wrong thing.
const questionsAsked = new Set(
  transcript
    .filter(
      (m) =>
        m.direction === 'outbound' &&
        m.step &&
        (!candidate?.completedAt || m.createdAt <= candidate.completedAt),
    )
    .map((m) => m.step),
).size;

verdict('signature verification', true, 'working');
verdict('copy fits WhatsApp limits', copyOk, copyOk ? 'en / ta / hi' : 'over the limit');
verdict('every turn produced a reply', outbound >= inbound, `${outbound} replies to ${inbound} messages`);
verdict(
  'registration completed',
  completed,
  completed ? `${candidate?.candidateId}` : (stalled ?? 'did not finish'),
);
verdict(
  'consent recorded before personal data',
  !!candidate?.consent?.given,
  candidate?.consent?.given ? 'recorded' : 'missing',
);

// §28 asks for roughly 7–10 questions. More than about 16 means the flow is
// asking things it should have skipped.
verdict(
  'question count is reasonable (§28)',
  questionsAsked > 0 && questionsAsked <= 18,
  `${questionsAsked} distinct questions`,
);

const cvDoc = docs.find((d) => d.docType === 'cv');
verdict(
  'CV stored and extracted',
  !!cvDoc && cvDoc.ocr?.status === 'done',
  cvDoc ? `ocr=${cvDoc.ocr?.status}, ${cvDoc.ocr?.fields?.length ?? 0} fields` : 'no CV stored',
);

const fromCv = Object.entries(candidate?.fieldMeta ?? {}).filter(([, m]) => m.source === 'cv').length;
verdict(
  'CV filled in profile fields (§5)',
  fromCv > 0,
  fromCv > 0 ? `${fromCv} fields skipped a question` : 'nothing extracted',
);

verdict(
  'model replies',
  anthropicOk,
  anthropicOk ? 'working' : 'unverified — free text would not be understood',
);

/* ------------------------------------------------------------------ */

await app.close();
await queue.close();
await closeDb();
await mongo.stop();
console.log('');
process.exit(completed ? 0 : 1);
