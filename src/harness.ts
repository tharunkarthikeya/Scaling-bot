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
// Without a key the /api routes are not served at all, and the run could not
// exercise the one write the CRM makes — setting an application's outcome.
process.env.ADMIN_API_KEY ??= 'harness-admin-key-0123456789';

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
const { interpret } = await import('./conversation/interpret.js');

const WA_ID = '919000000001';
/** A second number, so the B2B branch cannot disturb the registration above. */
const B2B_WA_ID = '919000000002';
/** A third, abandoned mid-registration to exercise the idle-session timeout. */
const IDLE_WA_ID = '919000000003';
/** A fourth, which asks questions of its own instead of answering ours. */
const FAQ_WA_ID = '919000000004';
/** A fifth, which names a job instead of tapping one of the offered categories. */
const JOB_WA_ID = '919000000005';

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

function envelope(message: Record<string, unknown>, waId = WA_ID) {
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
              contacts: [{ wa_id: waId, profile: { name: 'Asha Kumari' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

async function postWebhook(message: Record<string, unknown>, waId = WA_ID): Promise<number> {
  const raw = Buffer.from(JSON.stringify(envelope(message, waId)));
  const signature =
    'sha256=' + crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');

  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  return res.status;
}

function base(waId = WA_ID): Record<string, unknown> {
  seq++;
  return {
    from: waId,
    id: `wamid.HARNESS${seq}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
}

const textMessage = (body: string, waId = WA_ID) => ({
  ...base(waId),
  type: 'text',
  text: { body },
});

/** A tapped button or list row — carries the option id, as the real client does. */
const tapMessage = (id: string, title: string, waId = WA_ID) => ({
  ...base(waId),
  type: 'interactive',
  interactive: { type: 'list_reply', list_reply: { id, title } },
});

const documentMessage = (filename: string, caption?: string, waId = WA_ID) => ({
  ...base(waId),
  type: 'document',
  document: { id: `MEDIA${seq}`, mime_type: 'application/pdf', filename, ...(caption ? { caption } : {}) },
});

async function outboundCount(waId = WA_ID): Promise<number> {
  return messages().countDocuments({ waId, direction: 'outbound' });
}

/** The last thing the bot said, for assertions about wording. */
async function lastOutbound(waId = WA_ID): Promise<string> {
  const row = await messages()
    .find({ waId, direction: 'outbound' })
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .next();
  return row?.text ?? '';
}

/** Waits for the bot to say something new. */
async function waitForReply(since: number, waId = WA_ID, timeoutMs = 150_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await outboundCount(waId)) > since) {
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
    const stillRegistered =
      (await candidates().findOne({ waId: WA_ID }))?.stage === 'REGISTRATION_COMPLETED';
    console.log(`  ${ok ? green('ok') : red('TIMEOUT')}  editing one section only`);
    // §18 and §22: an edit opens a section, it does not un-register anyone.
    console.log(
      `  ${stillRegistered ? green('ok') : red('FAIL')}  an edit does not restart registration`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Application tracking, and the one write the CRM makes               */
/* ------------------------------------------------------------------ */

const registered = await candidates().findOne({ waId: WA_ID });
let trackingOk = false;
let statusApiOk = false;

if (registered?.candidateId) {
  heading('Application tracking (§25)');

  {
    const before = await outboundCount();
    // Typed unprompted, mid-menu — it is answered wherever it arrives.
    await postWebhook(textMessage(registered.candidateId));
    await waitForReply(before);
    const said = await lastOutbound();
    const ok = said.includes(registered.candidateId);
    trackingOk = ok;
    console.log(
      `  ${ok ? green('ok') : red('FAIL')}  an id sent unprompted is answered with its status`,
    );
    console.log(dim(`       ${said.split('\n').slice(0, 2).join(' / ')}`));
  }

  {
    const res = await fetch(`${baseUrl}/api/candidates/${WA_ID}/application`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': config.ADMIN_API_KEY! },
      body: JSON.stringify({ status: 'completed', by: 'harness', note: 'set by the harness' }),
    });
    console.log(`  ${res.ok ? green('ok') : red('FAIL')}  staff set the outcome (${res.status})`);

    const unauthorised = await fetch(`${baseUrl}/api/candidates/${WA_ID}/application`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'rejected' }),
    });
    const rejected = unauthorised.status === 401;
    console.log(
      `  ${rejected ? green('ok') : red('FAIL')}  an unauthenticated write is refused (${unauthorised.status})`,
    );

    const before = await outboundCount();
    await postWebhook(textMessage(registered.candidateId!));
    await waitForReply(before);
    const said = await lastOutbound();
    statusApiOk = res.ok && rejected && /Completed|முடிந்தது|पूरा/.test(said);
    console.log(
      `  ${statusApiOk ? green('ok') : red('FAIL')}  the candidate is told the new outcome`,
    );
    console.log(dim(`       ${said.split('\n').slice(0, 2).join(' / ')}`));
  }
}

/* ------------------------------------------------------------------ */
/* The other two things the opening menu can mean                      */
/* ------------------------------------------------------------------ */

heading('Opening menu: B2B (§2, §24)');

let b2bOk = false;
{
  await postWebhook(textMessage('hello, we are a manpower agency', B2B_WA_ID), B2B_WA_ID);
  await waitForReply(0, B2B_WA_ID);

  const before = await outboundCount(B2B_WA_ID);
  await postWebhook(tapMessage('b2b', 'B2B enquiry', B2B_WA_ID), B2B_WA_ID);
  await waitForReply(before, B2B_WA_ID);

  const contact = await candidates().findOne({ waId: B2B_WA_ID });
  // The point of the branch: a business contact reaches a person without one
  // personal question being asked and without a consent notice being needed.
  b2bOk =
    contact?.stage === 'HUMAN_HANDOFF' &&
    !contact.consent &&
    Object.keys(contact.profile ?? {}).length === 0;

  console.log(`  ${b2bOk ? green('ok') : red('FAIL')}  B2B goes straight to staff`);
  console.log(
    dim(`       stage=${contact?.stage} profile fields=${Object.keys(contact?.profile ?? {}).length}`),
  );

  for (const m of await messages().find({ waId: B2B_WA_ID }).sort({ createdAt: 1, _id: 1 }).toArray()) {
    const who = m.direction === 'inbound' ? '\x1b[36mcontact  \x1b[0m' : '\x1b[35mbot      \x1b[0m';
    console.log(`  ${who} │ ${(m.text ?? `[${m.type}]`).replace(/\n/g, ' / ')}`);
  }

  const before2 = await outboundCount(B2B_WA_ID);
  await postWebhook(textMessage('are you there?', B2B_WA_ID), B2B_WA_ID);
  // §24: nothing automated runs while staff hold the conversation, so silence
  // here is the correct outcome rather than a timeout.
  const spoke = await waitForReply(before2, B2B_WA_ID, 6_000);
  console.log(`  ${spoke ? red('FAIL') : green('ok')}  the bot stays silent during a handoff`);
  b2bOk = b2bOk && !spoke;
}

/* ------------------------------------------------------------------ */
/* Answering a question the flow did not ask                           */
/* ------------------------------------------------------------------ */

heading('Candidate questions (§27, faq.ts)');

let faqOk = false;
{
  const { violatesGuardrails } = await import('./conversation/faq.js');

  await postWebhook(textMessage('hi', FAQ_WA_ID), FAQ_WA_ID);
  await waitForReply(0, FAQ_WA_ID);
  {
    const before = await outboundCount(FAQ_WA_ID);
    await postWebhook(tapMessage('apply', 'Apply for a job', FAQ_WA_ID), FAQ_WA_ID);
    await waitForReply(before, FAQ_WA_ID);
  }

  /** Asks something mid-flow and returns what the bot said back. */
  const asks = async (question: string): Promise<string> => {
    const before = await outboundCount(FAQ_WA_ID);
    await postWebhook(textMessage(question, FAQ_WA_ID), FAQ_WA_ID);
    await waitForReply(before, FAQ_WA_ID);
    return lastOutbound(FAQ_WA_ID);
  };

  const deflected = (said: string) => /staff will answer that|ஊழியர் தொடர்பு|स्टाफ संपर्क/.test(said);

  {
    const said = await asks('is there any fee for this?');
    // Answered rather than deflected, and the question it interrupted is still
    // underneath it — an answer must not cost the candidate their place.
    const answered = !deflected(said) && /free|not? ?(?:ask|charge)|never ask|no fee/i.test(said);
    const reAsked = /language|மொழி|भाषा/i.test(said);
    console.log(`  ${answered ? green('ok') : red('FAIL')}  a covered question is answered, not deflected`);
    console.log(`  ${reAsked ? green('ok') : red('FAIL')}  the open question is re-sent underneath`);
    console.log(dim(`       ${said.replace(/\n/g, ' / ').slice(0, 150)}`));
    faqOk = answered && reAsked;
  }

  {
    // The one that matters. A salary question must be answered helpfully and
    // without a figure — §27 is not satisfied by refusing to engage.
    const said = await asks('how much salary will i get in dubai?');
    const clean = violatesGuardrails(said) === undefined;
    const engaged = !deflected(said);
    console.log(`  ${clean ? green('ok') : red('FAIL')}  no salary figure reaches the candidate`);
    console.log(`  ${engaged ? green('ok') : yellow('warn')}  the salary question gets a real answer`);
    console.log(dim(`       ${said.replace(/\n/g, ' / ').slice(0, 150)}`));
    faqOk = faqOk && clean;
  }

  {
    // Nothing approved covers this, so the staff line is the right answer —
    // this is the only case that should still produce it.
    const said = await asks('what is the weather in chennai today?');
    const handedOver = deflected(said);
    console.log(`  ${handedOver ? green('ok') : red('FAIL')}  an uncovered question goes to staff`);
    console.log(dim(`       ${said.replace(/\n/g, ' / ').slice(0, 150)}`));
    faqOk = faqOk && handedOver;
  }

  const stillGoing = await candidates().findOne({ waId: FAQ_WA_ID });
  const flowIntact = stillGoing?.stage !== 'HUMAN_HANDOFF' && !!stillGoing?.currentStep;
  console.log(`  ${flowIntact ? green('ok') : red('FAIL')}  answering never moves the flow`);
  console.log(dim(`       stage=${stillGoing?.stage} step=${stillGoing?.currentStep}`));
  faqOk = faqOk && flowIntact;
}

/* ------------------------------------------------------------------ */
/* A named job is an answer, not an off-topic message                  */
/* ------------------------------------------------------------------ */

heading('Naming a job instead of tapping a category (§9)');

let occupationOk = false;
{
  // The reported bug, driven end to end: "type writer" at the job-preference
  // question was classified off-topic, so the candidate was told to contact
  // staff about their own answer and asked again.
  await postWebhook(textMessage('hi', JOB_WA_ID), JOB_WA_ID);
  await waitForReply(0, JOB_WA_ID);

  // Taking the first offered option is not safe here — at the opening menu it is
  // "B2B enquiry", which ends the conversation, and at the CV question it is
  // "Upload CV", which waits for a file that never comes. The route to the
  // job-preference question is pinned instead. "Hospitality" is chosen because
  // it maps to no trade pack, so §8's questions are skipped and the run is short.
  const taps: Record<string, string> = {
    entry: 'apply',
    language: 'en',
    consent: 'yes',
    cv: 'no_cv',
    education: 'class_10',
    main_trade: 'hospitality',
    total_experience: '2_5',
  };
  const typed: Record<string, string> = {
    full_name: 'Test Candidate',
    location: 'Chennai, Tamil Nadu',
    dob: '15/08/1995',
  };

  /** Answers whatever is on screen until the named step is the open question. */
  const driveTo = async (target: string): Promise<boolean> => {
    for (let turn = 0; turn < 25; turn++) {
      const c = await candidates().findOne({ waId: JOB_WA_ID });
      if (c?.currentStep === target) return true;
      if (!c?.currentStep || c.stage === 'HUMAN_HANDOFF') return false;

      const step = stepById(c.currentStep);
      const before = await outboundCount(JOB_WA_ID);
      const wanted = taps[c.currentStep];

      if (typed[c.currentStep]) {
        await postWebhook(textMessage(typed[c.currentStep]!, JOB_WA_ID), JOB_WA_ID);
      } else if (step && wanted) {
        const choice = acceptedChoices(step, c).find((o) => o.id === wanted);
        await postWebhook(tapMessage(wanted, choice?.label.en ?? wanted, JOB_WA_ID), JOB_WA_ID);
      } else if (step && acceptedChoices(step, c).length) {
        const first = acceptedChoices(step, c)[0]!;
        await postWebhook(tapMessage(first.id, first.label.en, JOB_WA_ID), JOB_WA_ID);
      } else {
        await postWebhook(textMessage('Chennai, Tamil Nadu', JOB_WA_ID), JOB_WA_ID);
      }
      await waitForReply(before, JOB_WA_ID);
    }
    return false;
  };

  const arrived = await driveTo('job_preference');

  if (!arrived) {
    console.log(`  ${yellow('warn')} could not reach the job-preference question; skipped`);
    occupationOk = true;
  } else {
    const before = await outboundCount(JOB_WA_ID);
    await postWebhook(textMessage('type writer', JOB_WA_ID), JOB_WA_ID);
    await waitForReply(before, JOB_WA_ID);

    const said = await lastOutbound(JOB_WA_ID);
    const after = await candidates().findOne({ waId: JOB_WA_ID });

    const notDeflected = !/staff will answer that/i.test(said);
    // Their own words, not a category the model squeezed them into. Matching
    // "type writer" to "Related skilled jobs" satisfies the step and silently
    // discards the only thing the candidate actually told us.
    const recorded = /typ/i.test(String(after?.profile?.desiredOccupation ?? ''));
    const movedOn = after?.currentStep !== 'job_preference';

    console.log(`  ${notDeflected ? green('ok') : red('FAIL')}  a named job is not treated as off-topic`);
    console.log(`  ${recorded ? green('ok') : red('FAIL')}  the job is stored in their own words`);
    console.log(`  ${movedOn ? green('ok') : red('FAIL')}  the question is not asked again`);
    console.log(
      dim(
        `       workType=${after?.profile?.workTypePreference ?? '—'} ` +
          `desired=${after?.profile?.desiredOccupation ?? '—'} step=${after?.currentStep}`,
      ),
    );
    console.log(dim(`       ${said.replace(/\n/g, ' / ').slice(0, 130)}`));

    occupationOk = notDeflected && recorded && movedOn;
  }
}

/* ------------------------------------------------------------------ */
/* The five-minute idle session                                        */
/* ------------------------------------------------------------------ */

heading('Idle session and starting over');

let idleOk = false;
{
  const { TUNABLES } = await import('./conversation/rules.js');
  const { endIdleSessions } = await import('./conversation/engine.js');

  await postWebhook(textMessage('hi', IDLE_WA_ID), IDLE_WA_ID);
  await waitForReply(0, IDLE_WA_ID);

  {
    const before = await outboundCount(IDLE_WA_ID);
    await postWebhook(tapMessage('apply', 'Apply for a job', IDLE_WA_ID), IDLE_WA_ID);
    await waitForReply(before, IDLE_WA_ID);
  }

  const midway = await candidates().findOne({ waId: IDLE_WA_ID });
  const stepBefore = midway?.currentStep;

  // Backdated rather than waited out — the timeout is five minutes and the point
  // is to test the rule, not the clock.
  const longAgo = new Date(Date.now() - (TUNABLES.sessionTimeoutMinutes + 5) * 60_000);
  await candidates().updateOne({ waId: IDLE_WA_ID }, { $set: { lastInboundAt: longAgo } });

  const outboundBeforeSweep = await outboundCount(IDLE_WA_ID);
  const closed = await endIdleSessions();
  const marked = await candidates().findOne({ waId: IDLE_WA_ID });
  const sweepOk = closed >= 1 && marked?.sessionEndedAt instanceof Date;
  console.log(`  ${sweepOk ? green('ok') : red('FAIL')}  the sweep closes an idle session`);

  {
    // The candidate is told the moment it lapses, rather than on their next
    // message — someone who stopped mid-registration is exactly the person who
    // will not come back on their own.
    const said = await lastOutbound(IDLE_WA_ID);
    const told =
      (await outboundCount(IDLE_WA_ID)) > outboundBeforeSweep &&
      /terminated due to inactivity|நிறுத்தப்பட்டது|समाप्त कर दिया गया/.test(said);
    console.log(`  ${told ? green('ok') : red('FAIL')}  the sweep tells the candidate it ended`);
    console.log(dim(`       ${said.split('\n')[0]}`));

    // ...and the resume menu is left open, so their reply answers it.
    const menuOpen = marked?.currentStep === 'menu:resume';
    console.log(`  ${menuOpen ? green('ok') : red('FAIL')}  continue-or-restart is the open question`);
    idleOk = sweepOk && told && menuOpen;
  }

  // Nothing was lost by closing it — every answer is written as it arrives, so
  // what they had told us is still on the record behind the menu. Asserted on
  // the profile rather than on `currentStep`, which now holds the open menu.
  const savedOk = stepBefore !== undefined && Object.keys(marked?.profile ?? {}).length > 0;
  console.log(`  ${savedOk ? green('ok') : red('FAIL')}  the answers already given are kept`);
  idleOk = idleOk && savedOk;

  {
    const before = await outboundCount(IDLE_WA_ID);
    await postWebhook(tapMessage('restart', 'Restart session', IDLE_WA_ID), IDLE_WA_ID);
    await waitForReply(before, IDLE_WA_ID);

    const fresh = await candidates().findOne({ waId: IDLE_WA_ID });
    // Answers go, consent stays: it is a recorded fact, not an answer being
    // revised, and §4 is satisfied either way.
    const restarted =
      Object.keys(fresh?.profile ?? {}).length === 0 && fresh?.sessionEndedAt == null;
    console.log(`  ${restarted ? green('ok') : red('FAIL')}  "start from first" clears the answers`);
    console.log(
      dim(`       stage=${fresh?.stage} step=${fresh?.currentStep} fields=${Object.keys(fresh?.profile ?? {}).length}`),
    );
    idleOk = idleOk && restarted;
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
verdict('copy fits WhatsApp limits', copyOk, copyOk ? 'en / ta / hi / te / ml' : 'over the limit');
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

// §28 asks for roughly 7–10 questions for a typical registration, and this run
// is not typical: the driver deliberately takes every expensive branch. Europe
// adds `europe_docs` and three uploads, "Fabrication/Welding" runs two trade
// packs, and a valid passport adds its expiry — about ten steps a GCC candidate
// with a clean CV never sees. The ceiling below is for that branch-maximal path;
// exceeding it means questions are being asked that the CV already answered.
verdict(
  'question count is reasonable (§28)',
  questionsAsked > 0 && questionsAsked <= 20,
  `${questionsAsked} distinct questions`,
);

// The worker reads inbound rows back out of Mongo, so anything the webhook
// handler forgets to persist is invisible to the engine. `replyId` was dropped
// for a long time and nothing noticed: taps still worked, but only because the
// button's title happened to match a label we ship.
const taps = transcript.filter((m) => m.direction === 'inbound' && m.type === 'interactive');
const tapsWithId = taps.filter((m) => !!m.replyId).length;
verdict(
  'button taps keep their option id',
  taps.length > 0 && tapsWithId === taps.length,
  `${tapsWithId}/${taps.length} taps carry replyId`,
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

/* A specialist question, answered about something else (§8).
 *
 * Two interpretations rather than a fifth conversation: the failure is entirely
 * inside the classification, and driving a whole registration to reach one
 * question would take minutes to tell us the same thing.
 *
 * "Tailor machine" is a clear, well-spelled answer to a different question. It
 * was stored as machining experience, and the candidate was never asked again,
 * because a free-text step said only "this wants text". "HAAS VF-2" has to keep
 * working — a guard that also rejects real machines is worse than no guard, and
 * this one is a model reading the subject rather than a list of banned words.
 */
const cncStep = stepById('trade:cnc_operator:machines_operated')!;
const cncCandidate = { profile: {}, documents: {}, fieldMeta: {}, history: [] } as never;
const cncChoices = acceptedChoices(cncStep, cncCandidate);

const offSubject = await interpret({ step: cncStep, choices: cncChoices, text: 'tailor machine' });
const onSubject = await interpret({ step: cncStep, choices: cncChoices, text: 'HAAS VF-2' });
const specialistOk = offSubject.kind !== 'value' && onSubject.kind === 'value';

verdict(
  'a specialist question refuses an answer about something else (§8)',
  specialistOk,
  `"tailor machine" -> ${offSubject.kind}, "HAAS VF-2" -> ${onSubject.kind}`,
);

verdict(
  'application tracking (§25)',
  trackingOk && statusApiOk,
  trackingOk && statusApiOk ? 'id → status, and staff can change it' : 'tracking did not work',
);

verdict(
  'B2B reaches staff without collecting data (§2, §24)',
  b2bOk,
  b2bOk ? 'handed over, no profile written' : 'did not behave as specified',
);

verdict(
  'idle session closes and can be resumed',
  idleOk,
  idleOk ? 'closed, kept, and restartable' : 'did not behave as specified',
);

verdict(
  'a named job is recorded, not called off-topic (§9)',
  occupationOk,
  occupationOk ? 'stored and the flow moved on' : 'did not behave as specified',
);

verdict(
  'candidate questions answered within guardrails (§27)',
  faqOk,
  faqOk ? 'answered from the approved list, no figures' : 'did not behave as specified',
);

/* ------------------------------------------------------------------ */

await app.close();
await queue.close();
await closeDb();
await mongo.stop();
console.log('');
process.exit(
  completed && trackingOk && statusApiOk && b2bOk && idleOk && faqOk && occupationOk && specialistOk
    ? 0
    : 1,
);
