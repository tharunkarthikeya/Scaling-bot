/**
 * The whole integration, driven end to end against a CRM that is actually
 * running.
 *
 *   npm run e2e:crm
 *
 * `harness` proves the bot works. `verify:crm` proves the link is up. Neither
 * proves the thing this integration is for: that a person can hold a WhatsApp
 * conversation and come out of it as a candidate in the CRM, correctly, with
 * the CV policy having decided whether they needed a résumé.
 *
 * So this drives real registrations — real webhooks with real signatures, the
 * real conversation engine, real OCR on the documents, the real queue — into a
 * real CRM over HTTP, and then reads the result back out of the CRM's own API
 * to check it arrived as the right kind of record.
 *
 * Four scenarios, and the fourth is the one that matters most:
 *
 *   A  Malaysia + general worker   the policy exempts them; no CV is asked for
 *   B  Malaysia + technician       the policy requires one; the CV is asked for
 *   C  Singapore + technician      the same rule, a different country — proof
 *                                  the split of Singapore from Malaysia reaches
 *                                  all the way through
 *   D  the CRM is down when a registration finishes, and comes back
 *
 * D is the one that would quietly ruin a database. A candidate who finishes
 * while the CRM is unreachable must not be lost, and the retry that delivers
 * them later must not create a second person. Both halves are asserted.
 *
 * Nothing here touches the bot's real database: Mongo runs in-process for the
 * duration. The CRM's database is real, because there is no way to prove a
 * candidate was created except by creating one. Every candidate this makes is
 * named "E2E" and is deleted at the end.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { CandidateDoc } from './db/models.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let failures = 0;

function check(ok: boolean, name: string, detail = ''): boolean {
  if (!ok) failures++;
  console.log(`  ${ok ? `${GREEN}ok  ${RESET}` : `${RED}FAIL${RESET}`}  ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
  return ok;
}

function heading(text: string): void {
  console.log(`\n${BOLD}${text}${RESET}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Boot
 *
 * Set before importing config: dotenv does not overwrite variables already in
 * the environment, so these win over .env. The CRM settings are deliberately
 * *not* overridden — the point is to talk to the one that is running.
 * ──────────────────────────────────────────────────────────────────────────*/

const mongo = await MongoMemoryServer.create();

process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'adira_e2e_crm';
process.env.SHADOW_MODE = 'true';
process.env.MOCK_WHATSAPP_MEDIA = 'true';
process.env.STORAGE_PATH = path.join(os.tmpdir(), 'adira-e2e-crm-storage');
process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? 'warn';
process.env.ADMIN_API_KEY ??= 'e2e-admin-key-0123456789';

const { config } = await import('./config.js');
const { connectDb, closeDb } = await import('./db/client.js');
const { ensureIndexes, candidates, turnsFor } = await import('./db/models.js');
const { ensureStorageRoot } = await import('./storage/index.js');
const { queue, withCandidateLock } = await import('./queue/index.js');
const { handleInboundMessage } = await import('./conversation/engine.js');
const { processOcrJob } = await import('./ocr/veris.js');
const { syncCandidateToCrm, reconcileCrmSync } = await import('./crm/sync.js');
const { buildServer } = await import('./server.js');
const { stepById } = await import('./conversation/flow.js');
const { acceptedChoices } = await import('./conversation/render.js');

console.log(`\n${BOLD}Adira bot ↔ CRM — end to end${RESET}`);
console.log(`${DIM}crm: ${config.CRM_API_URL ?? '(unset)'}   bot db: in-process${RESET}`);

if (!config.CRM_API_URL || !config.CRM_API_KEY) {
  console.error(
    `\n${RED}CRM_API_URL / CRM_API_KEY are not set.${RESET} This test needs a CRM to talk to; ` +
      `there is nothing to prove without one.\n`,
  );
  process.exit(2);
}

/* Fail early and clearly rather than after a two-minute registration. */
{
  const { crmHealth } = await import('./crm/client.js');
  const health = await crmHealth();
  if (!health.ok) {
    console.error(
      `\n${RED}The CRM is not answering${RESET} (${health.detail}).\n` +
        `Start it first:  cd D:\\email-automation && python -m uvicorn app.api.routes:app --port 8000\n`,
    );
    process.exit(2);
  }
}

await connectDb();
await ensureIndexes();
await ensureStorageRoot();

queue.register('inbound_message', (p) => withCandidateLock(p.waId, () => handleInboundMessage(p)), 4);
queue.register('ocr', processOcrJob, 2);
queue.register('crm_sync', syncCandidateToCrm, 2);
await queue.start();

const app = await buildServer();
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

/* ────────────────────────────────────────────────────────────────────────────
 * Talking to the bot the way Meta does
 * ──────────────────────────────────────────────────────────────────────────*/

let seq = 0;

function envelope(message: Record<string, unknown>, waId: string) {
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
              contacts: [{ wa_id: waId, profile: { name: 'E2E Candidate' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

async function postWebhook(message: Record<string, unknown>, waId: string): Promise<number> {
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

function base(waId: string): Record<string, unknown> {
  seq++;
  return { from: waId, id: `wamid.E2E${seq}`, timestamp: String(Math.floor(Date.now() / 1000)) };
}

const textMessage = (body: string, waId: string) => ({ ...base(waId), type: 'text', text: { body } });

const tapMessage = (id: string, title: string, waId: string) => ({
  ...base(waId),
  type: 'interactive',
  interactive: { type: 'list_reply', list_reply: { id, title } },
});

const documentMessage = (filename: string, caption: string | undefined, waId: string) => ({
  ...base(waId),
  type: 'document',
  document: {
    id: `MEDIA${seq}`,
    mime_type: 'application/pdf',
    filename,
    ...(caption ? { caption } : {}),
  },
});

async function outboundCount(waId: string): Promise<number> {
  return (await turnsFor(waId)).filter((t) => t.direction === 'outbound').length;
}

async function waitForReply(since: number, waId: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await outboundCount(waId)) > since) {
      await new Promise((r) => setTimeout(r, 300));
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Answering whatever is asked
 *
 * Adaptive rather than scripted, for the same reason the harness is: the flow
 * legitimately differs between these three candidates — that difference is the
 * thing being tested — and a fixed script would report it as a failure.
 * ──────────────────────────────────────────────────────────────────────────*/

interface Scenario {
  label: string;
  waId: string;
  /** Which country row to tap at `country_preference`. */
  destination: 'malaysia' | 'singapore';
  /** Which row to tap at `sgmy_job_category`. */
  jobCategory: string;
  /** What the CRM's policy should decide for this pair. */
  expectCvRequired: boolean;
}

const TYPED: Record<string, string> = {
  full_name: 'Asha Kumari',
  location: 'Chennai, Tamil Nadu',
  dob: '15/08/1995',
  education_course: 'Welder trade',
  main_trade_other: 'TIG welder',
  overseas_countries: 'Qatar and Saudi Arabia',
  selected_countries: 'Malaysia',
  availability_date: 'Next month',
  desired_job: 'General worker',
  passport_applied_when: 'Last month',
  language_other: 'Malayalam',
};

async function answerCurrentQuestion(
  scenario: Scenario,
): Promise<Record<string, unknown> | undefined> {
  const candidate = await candidates().findOne({ waId: scenario.waId });
  if (!candidate) return undefined;

  const stepId = candidate.currentStep;
  if (!stepId) return undefined;
  if (stepId.startsWith('menu:') || stepId.startsWith('ask:')) return undefined;
  if (stepId.endsWith('#other')) return textMessage('General helper', scenario.waId);

  // The trade questions are written per candidate by the model, so there is no
  // fixed list to answer from. A substantive sentence is what a real candidate
  // sends and what the interpreter is built to read; "yes" is not, and two of
  // those in a row is a handoff to staff — which would end the run for reasons
  // that have nothing to do with the CRM.
  if (stepId.startsWith('trade_extra')) {
    return textMessage(
      'About six years, mostly TIG and MIG welding on structural steel and pipework.',
      scenario.waId,
    );
  }

  const step = stepById(stepId);
  if (!step) return undefined;

  if (step.document) {
    return documentMessage(`${step.document}.pdf`, step.document, scenario.waId);
  }

  if (step.input === 'choice' || step.input === 'multi_choice') {
    const options = acceptedChoices(step, candidate).filter(
      (o) => o.id !== 'staff' && o.id !== '__done' && o.id !== 'other',
    );

    if (step.input === 'multi_choice') {
      if (candidate.pendingMulti?.step === stepId) return tapMessage('__done', 'Done', scenario.waId);
      const first = options[0];
      return first
        ? tapMessage(first.id, first.label.en, scenario.waId)
        : tapMessage('__done', 'Done', scenario.waId);
    }

    const preferred: Record<string, string> = {
      entry: 'apply',
      language: 'en',
      consent: 'yes',
      // The two answers this whole test turns on.
      country_preference: scenario.destination,
      sgmy_job_category: scenario.jobCategory,
      cv: 'upload_cv',
      education: 'iti',
      main_trade: 'fabrication_welding',
      trade_disambiguation: 'welding',
      total_experience: '5_10',
      job_preference: 'current_trade',
      related_acceptance: 'related_ok',
      country_strictness: 'prefer',
      availability: 'within_30',
      passport_status: 'yes',
      confirm: 'correct',
    };

    const wanted = preferred[stepId];
    const choice = options.find((o) => o.id === wanted) ?? options[0];
    return choice ? tapMessage(choice.id, choice.label.en, scenario.waId) : undefined;
  }

  return textMessage(TYPED[stepId] ?? 'yes', scenario.waId);
}

/** Drives one candidate from "hello" to a finished registration. */
async function register(scenario: Scenario): Promise<{ candidate?: CandidateDoc; steps: string[] }> {
  const steps: string[] = [];

  {
    const before = await outboundCount(scenario.waId);
    await postWebhook(textMessage('hello, I am looking for work abroad', scenario.waId), scenario.waId);
    await waitForReply(before, scenario.waId);
  }

  for (let turn = 0; turn < 45; turn++) {
    const candidate = await candidates().findOne({ waId: scenario.waId });
    if (!candidate) break;
    if (candidate.stage === 'REGISTRATION_COMPLETED') break;
    if (candidate.stage === 'HUMAN_HANDOFF') {
      console.log(`  ${YELLOW}note${RESET}  handed to staff: ${candidate.humanHandoff?.reason ?? '?'}`);
      break;
    }

    const message = await answerCurrentQuestion(scenario);
    if (!message) {
      console.log(`  ${YELLOW}note${RESET}  no answer available for step "${candidate.currentStep}"`);
      break;
    }

    if (candidate.currentStep) steps.push(candidate.currentStep);
    const before = await outboundCount(scenario.waId);
    await postWebhook(message, scenario.waId);
    if (!(await waitForReply(before, scenario.waId))) {
      console.log(`  ${YELLOW}note${RESET}  no reply after "${candidate.currentStep}"`);
      break;
    }
  }

  return { candidate: (await candidates().findOne({ waId: scenario.waId })) ?? undefined, steps };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading the answer back out of the CRM
 *
 * Through its own staff API rather than its database, because "the record is in
 * Mongo" is not the claim being tested — "a recruiter opening the CRM sees this
 * candidate" is.
 * ──────────────────────────────────────────────────────────────────────────*/

const crmUrl = config.CRM_API_URL.replace(/\/$/, '');
let staffToken = '';

async function loginToCrm(): Promise<boolean> {
  for (const [email, password] of [
    ['admin@gmail.com', 'admin@123'],
    ['staff@gmail.com', 'staff@123'],
  ]) {
    try {
      const res = await fetch(`${crmUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { token?: string };
      if (body.token) {
        staffToken = body.token;
        return true;
      }
    } catch {
      // Try the next account.
    }
  }
  return false;
}

interface CrmRecord {
  id: string;
  source: string;
  cv_required: boolean;
  cv_policy_version?: string;
  resume?: { storage_key?: string; sha256?: string; size?: number } | null;
  assigned_staff_id?: string | null;
  evaluation_status?: string;
  idempotency_key?: string;
  profile: Record<string, unknown>;
}

async function crmCandidate(id: string): Promise<CrmRecord | undefined> {
  const res = await fetch(`${crmUrl}/candidates/${id}`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  });
  if (!res.ok) return undefined;
  return (await res.json()) as CrmRecord;
}

/** Every candidate this run created, so the count can be checked and the mess cleaned. */
const created = new Set<string>();

/* ────────────────────────────────────────────────────────────────────────────
 * The scenarios
 * ──────────────────────────────────────────────────────────────────────────*/

const SCENARIOS: Scenario[] = [
  {
    label: 'A  Malaysia + general worker  (no CV expected)',
    waId: '919700000001',
    destination: 'malaysia',
    jobCategory: 'general_worker',
    expectCvRequired: false,
  },
  {
    label: 'B  Malaysia + technician      (CV expected)',
    waId: '919700000002',
    destination: 'malaysia',
    jobCategory: 'technician',
    expectCvRequired: true,
  },
  {
    label: 'C  Singapore + technician     (CV expected)',
    waId: '919700000003',
    destination: 'singapore',
    jobCategory: 'technician',
    expectCvRequired: true,
  },
];

if (!(await loginToCrm())) {
  console.error(`\n${RED}Could not log in to the CRM${RESET} with either demo account.\n`);
  process.exit(2);
}

/** Run a subset while iterating: `E2E_ONLY=B,C npm run e2e:crm`. */
const only = (process.env.E2E_ONLY ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

for (const scenario of SCENARIOS) {
  if (only.length && !only.includes(scenario.label.trim()[0]!)) continue;
  heading(scenario.label);

  const { candidate, steps } = await register(scenario);

  if (!check(candidate?.stage === 'REGISTRATION_COMPLETED', 'registration completed', candidate?.stage)) {
    continue;
  }

  // 1. The policy was consulted, and its answer is on our record.
  check(
    candidate!.profile?.cvRequired === scenario.expectCvRequired,
    'crm cv policy applied',
    `cvRequired=${candidate!.profile?.cvRequired} policy=${candidate!.profile?.cvPolicyVersion ?? '—'}`,
  );

  // 2. And the conversation actually reflected it: the CV was asked for, or it
  //    was not. This is the difference a candidate would notice.
  const askedForCv = steps.includes('cv');
  check(
    askedForCv === scenario.expectCvRequired,
    scenario.expectCvRequired ? 'the CV was requested' : 'the CV step was skipped',
    `steps: ${steps.filter((s) => ['country_preference', 'sgmy_passport', 'sgmy_job_category', 'cv'].includes(s)).join(' → ')}`,
  );

  // What actually went over the wire, so a merge or a duplicate can be read off
  // the output rather than guessed at.
  {
    const { toCrmPayload } = await import('./crm/mapping.js');
    const sent = toCrmPayload(candidate!, config.WHATSAPP_PHONE_NUMBER_ID);
    console.log(
      `  ${DIM}sent  key=${sent.idempotency_key}  phone=${sent.profile.phone_e164 ?? '—'}  ` +
        `destination=${sent.profile.destination_country ?? '—'}${RESET}`,
    );
  }

  // 3. The submission reached the CRM.
  const synced = await waitFor(async () => {
    const fresh = await candidates().findOne({ waId: scenario.waId });
    return fresh?.crmSync?.status === 'synced';
  }, 90_000);

  const fresh = await candidates().findOne({ waId: scenario.waId });
  check(synced, 'crmSync = synced', `${fresh?.crmSync?.status ?? 'none'} ${fresh?.crmSync?.lastError ?? ''}`);
  if (!synced) continue;

  const crmId = fresh!.crmSync!.candidateId!;
  created.add(crmId);
  check(!!crmId, 'crm candidate id returned', crmId);

  // 4. And it is the right kind of record on the other side.
  const record = await crmCandidate(crmId);
  if (!check(!!record, 'the CRM serves the candidate', crmId)) continue;

  check(record!.source === 'whatsapp', 'source = whatsapp', record!.source);
  check(
    record!.cv_required === scenario.expectCvRequired,
    'the CRM recorded its own cv decision',
    `cv_required=${record!.cv_required} version=${record!.cv_policy_version ?? '—'}`,
  );
  check(
    scenario.expectCvRequired ? !!record!.resume : record!.resume == null,
    scenario.expectCvRequired ? 'the résumé is stored in the CRM' : 'no résumé, and none invented',
    record!.resume ? `${record!.resume.size} bytes at ${record!.resume.storage_key}` : 'resume=null',
  );
  if (record!.resume?.storage_key) {
    // The key belongs to the CRM's storage, not to a path on this machine.
    check(
      !/^[A-Za-z]:|\\\\|\.\./.test(record!.resume.storage_key),
      'the résumé key is the CRM’s own',
      record!.resume.storage_key,
    );
  }
  check(!!record!.assigned_staff_id, 'allocated by the existing balancer', record!.assigned_staff_id ?? '—');

  // 5. Residence and destination stayed apart, and the destination is a country.
  const profile = record!.profile as Record<string, string | undefined>;
  check(
    profile.country === 'India' &&
      profile.destination_country === (scenario.destination === 'malaysia' ? 'Malaysia' : 'Singapore'),
    'residence and destination are separate',
    `country=${profile.country} destination=${profile.destination_country}`,
  );
  check(
    profile.job_category === scenario.jobCategory,
    'job category travelled as a controlled value',
    `${profile.job_category} (${profile.job_preference ?? 'no free text'})`,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * D. The CRM is down when someone finishes
 *
 * Simulated by pointing the client at a port nothing is listening on, which
 * produces exactly the failure a stopped CRM produces: the connection is
 * refused. The candidate must survive it, and the delivery that happens later
 * must not create a second person.
 * ──────────────────────────────────────────────────────────────────────────*/

heading('D  the CRM is unreachable, then comes back');

const outage: Scenario = {
  label: 'D',
  waId: '919700000004',
  destination: 'malaysia',
  jobCategory: 'general_worker',
  expectCvRequired: false,
};

const liveUrl = config.CRM_API_URL;
// A port with nothing behind it. Chosen high and odd so it is not something
// else's service on a developer's machine.
(config as { CRM_API_URL?: string }).CRM_API_URL = 'http://127.0.0.1:59999';

const { candidate: strandedRaw } = await register(outage);
check(strandedRaw?.stage === 'REGISTRATION_COMPLETED', 'registration completed with no CRM', strandedRaw?.stage);

// The queue retries with backoff; give it long enough to have tried and failed.
await waitFor(async () => {
  const fresh = await candidates().findOne({ waId: outage.waId });
  return !!fresh?.crmSync?.attempts && fresh.crmSync.attempts > 0;
}, 60_000);

const stranded = await candidates().findOne({ waId: outage.waId });
check(!!stranded, 'the candidate is retained locally', 'the record is still here');
check(
  stranded?.crmSync?.status !== 'synced',
  'not marked synced while the CRM was down',
  `${stranded?.crmSync?.status ?? 'none'} after ${stranded?.crmSync?.attempts ?? 0} attempt(s)`,
);
check(
  !!stranded?.crmSync?.lastError,
  'the failure is recorded rather than swallowed',
  (stranded?.crmSync?.lastError ?? '').slice(0, 60),
);

// The CRM comes back.
(config as { CRM_API_URL?: string }).CRM_API_URL = liveUrl;

// Two things deliver a stranded candidate in production, and only one of them
// can be demonstrated in the time this test has:
//
//   * the queue's own retry, with exponential backoff — which the in-process
//     queue does not do at all (it is local-dev only, and says so), so there is
//     nothing here to wait for;
//   * the reconcile sweep, which deliberately ignores anything attempted more
//     recently than INGESTION_STALE_AFTER_MS. That is fifteen minutes by
//     default and is correct: re-submitting something that is merely slow races
//     the answer already coming back.
//
// So the sweep is called to show it *declines* — a candidate one second old is
// not stuck — and then the delivery is driven directly, which is exactly what
// the sweep would do a quarter of an hour later.
const requeued = await reconcileCrmSync();
console.log(
  `  ${DIM}the reconcile sweep re-queued ${requeued} candidate(s) — 0 is right this soon ` +
    `(stale after ${Math.round(config.INGESTION_STALE_AFTER_MS / 60_000)} min)${RESET}`,
);

await syncCandidateToCrm({ waId: outage.waId });

const recovered = await waitFor(async () => {
  const fresh = await candidates().findOne({ waId: outage.waId });
  return fresh?.crmSync?.status === 'synced';
}, 90_000);

const delivered = await candidates().findOne({ waId: outage.waId });
check(recovered, 'delivered once the CRM returned', delivered?.crmSync?.status ?? 'none');

if (delivered?.crmSync?.candidateId) {
  created.add(delivered.crmSync.candidateId);

  // The same submission, sent again by hand, must land on the same person.
  const firstId = delivered.crmSync.candidateId;
  await syncCandidateToCrm({ waId: outage.waId });
  const again = await candidates().findOne({ waId: outage.waId });
  check(
    again?.crmSync?.candidateId === firstId,
    'a further retry did not create a second candidate',
    `${firstId} === ${again?.crmSync?.candidateId}`,
  );

  // And the CRM agrees: one record for this idempotency key.
  const record = await crmCandidate(firstId);
  check(
    record?.idempotency_key === `whatsapp/${config.WHATSAPP_PHONE_NUMBER_ID}/${outage.waId}`,
    'the CRM holds it under the bot’s idempotency key',
    record?.idempotency_key ?? '—',
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Tidy up
 *
 * The bot's database was in memory and goes with the process. The CRM's is
 * real, so what this run put in it comes back out.
 * ──────────────────────────────────────────────────────────────────────────*/

heading('cleanup');

let deleted = 0;
for (const id of created) {
  try {
    const res = await fetch(`${crmUrl}/candidates/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    if (res.ok) deleted++;
  } catch {
    // Reported below by the count.
  }
}
check(deleted === created.size, 'test candidates removed from the CRM', `${deleted}/${created.size}`);

await queue.close();
await app.close();
await closeDb();
await mongo.stop();

console.log('');
if (failures === 0) {
  console.log(`${GREEN}${BOLD}End to end: the bot registers candidates into the CRM.${RESET}`);
} else {
  console.log(`${RED}${BOLD}${failures} check(s) failed.${RESET}`);
}
console.log('');

process.exit(failures ? 1 : 0);
