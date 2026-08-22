/**
 * Controlled live contract test against the production Veris Jobs API.
 *
 * Differs from `jobs-contract-probe.ts` in one decisive way: it drives the REAL
 * client (`src/ocr/jobs.ts`) rather than hand-rolling requests. The older probe
 * posts a multipart field named `image` — a pre-OpenAPI guess — while the
 * captured schema (`Body_submit_job_v1_jobs_post`) and the shipped client both
 * use `file`. A probe that sends a different request than production sends
 * cannot answer whether production's request is correct.
 *
 * Structural output only. No API key, no header, no document text and no
 * extracted value is ever printed; dates are reported as a format
 * classification rather than a value.
 *
 *   LOADTEST_ALLOW_HOST=veriis.adiragroups.com npx tsx loadtest/tools/live-jobs-probe.ts
 */

const HOST = process.env.LOADTEST_ALLOW_HOST ?? '';
if (!HOST) {
  console.error('Refusing to run: LOADTEST_ALLOW_HOST is not set.');
  process.exit(1);
}

import { installFetchGuard } from '../rig/guard.js';

const guard = installFetchGuard({ onOutbound: () => undefined });

const { config } = await import('../../src/config.js');
const jobs = await import('../../src/ocr/jobs.js');
const { SAMPLE_PASSPORT_PDF } = await import('../../src/testing/fixtures.js');
const { normaliseExtractionForTests } = await import('../../src/ocr/veris.js');

/* ------------------------------------------------------------------ */
/* Structural reporting — shape without content                        */
/* ------------------------------------------------------------------ */

function shape(v: unknown, depth = 0): unknown {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) {
    if (!v.length) return '[] empty';
    return [`array(${v.length}) of`, depth > 2 ? '...' : shape(v[0], depth + 1)];
  }
  if (typeof v === 'object') {
    if (depth > 3) return '{...}';
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as object)) out[k] = shape(val, depth + 1);
    return out;
  }
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'string ISO-DATE';
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return 'string ISO-DATETIME';
    if (/^\d{6}$/.test(v)) return 'string YYMMDD';
    return `string(${v.length})`;
  }
  return typeof v;
}

function report(label: string, v: unknown): void {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(shape(v), null, 2));
}

const line = (s: string) => console.log(s);

function dateFormatOf(v: unknown): string {
  if (v == null) return 'null';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'ISO YYYY-MM-DD';
  if (/^\d{6}$/.test(s)) return 'YYMMDD';
  return 'OTHER';
}

/* ------------------------------------------------------------------ */
/* Preflight                                                           */
/* ------------------------------------------------------------------ */

const fixture = SAMPLE_PASSPORT_PDF();

line(`
PREFLIGHT
  target host        ${HOST}
  base url           ${config.VERIS_OCR_BASE_URL}
  client under test  src/ocr/jobs.ts (multipart field "file", per OpenAPI)
  fixture            synthetic passport PDF, ${fixture.byteLength} bytes, fictional person
  guard              INSTALLED - only ${HOST} may leave the machine
  database           none opened
`);

let terminalJob: any;
let firstJobId = '';

/* ------------------------------------------------------------------ */
/* Phase 1 - submit                                                    */
/* ------------------------------------------------------------------ */

line('=== phase 1: POST /v1/jobs ===');

const KEY = jobs.ocrIdempotencyKey({
  phoneNumberId: 'probe',
  wamid: 'wamid.probe.contract.0001',
  mediaId: 'media.probe.0001',
  extractor: 'passport',
});
line(`  idempotency key: ${KEY.split('/').length} segments, extractor segment present: ${KEY.endsWith('/passport')}`);

let accepted: any;
try {
  accepted = await jobs.submitOcrJob({
    mode: 'passport',
    buffer: fixture,
    filename: 'passport.pdf',
    mimeType: 'application/pdf',
    idempotencyKey: KEY,
  });
} catch (err: any) {
  line('\n  SUBMIT FAILED - classifying and stopping.');
  line(`  error class : ${err?.constructor?.name}`);
  line(`  status      : ${err?.status ?? '(none)'}`);
  line(`  message     : ${String(err?.message).slice(0, 200)}`);
  if (err?.body) line(`  body        : ${String(err.body).slice(0, 400)}`);
  if (err?.retryAfterMs !== undefined) line(`  retryAfterMs: ${err.retryAfterMs}`);
  const st = guard.stats();
  line(`\n  live external requests: ${st.externalRequests}, blocked: ${st.blocked}`);
  process.exit(0);
}

line('  submitOcrJob returned (the client enforces 202; anything else throws)');
report('JobAccepted', accepted);
line(`  job_id present     : ${Boolean(accepted.job_id)}`);
line(`  status_url present : ${Boolean(accepted.status_url)}`);
line(`  status_url form    : ${String(accepted.status_url).startsWith('http') ? 'absolute' : 'relative'}`);
line(`  duplicate flag     : ${JSON.stringify(accepted.duplicate)}`);
firstJobId = accepted.job_id;

/* ------------------------------------------------------------------ */
/* Phase 2 - poll                                                      */
/* ------------------------------------------------------------------ */

line('\n=== phase 2: GET status_url ===');

const states = new Set<string>();
let delay = 2000;
let sawRetryAfter = false;
const deadline = Date.now() + 180_000;

for (let i = 0; i < 15 && Date.now() < deadline; i++) {
  await new Promise((r) => setTimeout(r, delay));

  let polled: any;
  try {
    polled = await jobs.pollOcrJob(accepted.status_url);
  } catch (err: any) {
    line(`  POLL FAILED: ${err?.constructor?.name} status=${err?.status} ${String(err?.message).slice(0, 160)}`);
    break;
  }

  const job = polled.job;
  states.add(job.status);
  if (polled.retryAfterMs !== undefined) sawRetryAfter = true;

  line(
    `  poll ${String(i + 1).padStart(2)}  status=${job.status}` +
      `  attempts=${job.attempts}/${job.max_attempts}` +
      `  next_attempt_at=${job.next_attempt_at ? 'set' : 'null'}` +
      `  retry-after=${polled.retryAfterMs !== undefined ? polled.retryAfterMs + 'ms' : 'absent'}`,
  );

  if (i === 0) report('JobResponse (first poll)', job);

  delay = jobs.nextPollDelayMs({
    job,
    retryAfterMs: polled.retryAfterMs,
    previousDelayMs: delay,
  });

  if (job.status === 'succeeded' || job.status === 'failed') {
    terminalJob = job;
    break;
  }
}

line(`\n  state vocabulary observed: ${JSON.stringify([...states])}`);
line(`  Retry-After seen at least once: ${sawRetryAfter}`);

/* ------------------------------------------------------------------ */
/* Phase 3 - result location and normaliser compatibility              */
/* ------------------------------------------------------------------ */

if (terminalJob) {
  report('TERMINAL JobResponse', terminalJob);

  const found = ['result', 'output', 'data', 'payload', 'extraction'].filter(
    (k) => terminalJob[k] !== undefined,
  );
  line(`\n  result envelope key(s): ${JSON.stringify(found)}`);

  if (terminalJob.status === 'succeeded' && terminalJob.result !== undefined) {
    report('terminal.result', terminalJob.result);

    line('\n=== phase 3: normaliser compatibility (nothing modified) ===');
    const outcome = normaliseExtractionForTests('passport', terminalJob.result);
    line(`  normalisePassport ran   : yes`);
    line(`  fields extracted        : ${outcome.fields.length}`);
    line(`  confidence              : ${outcome.confidence === null ? 'null' : 'number'}`);
    line(`  needsReview             : ${outcome.needsReview}`);
    line(`  completeness.complete   : ${outcome.completeness.complete}`);
    line(`  completeness.verdict    : ${outcome.completeness.verdict}`);
    line(`  completeness.problems   : ${JSON.stringify(outcome.completeness.problems)}`);

    const mrz = (terminalJob.result as any)?.mrz;
    line(`\n  mrz present                 : ${Boolean(mrz)}`);
    if (mrz) {
      line(`  mrz.passport_number present : ${Boolean(mrz.passport_number)}`);
      for (const k of ['expiry_date', 'date_of_birth', 'date_of_issue']) {
        line(`  mrz.${k.padEnd(15)} format : ${dateFormatOf(mrz[k])}`);
      }
    }
  }
} else {
  line('\n  no terminal state inside the probe window - not retried further');
}

/* ------------------------------------------------------------------ */
/* Phase 4 - idempotency                                               */
/* ------------------------------------------------------------------ */

line('\n=== phase 4: idempotency (same key, same bytes) ===');

try {
  const second = await jobs.submitOcrJob({
    mode: 'passport',
    buffer: fixture,
    filename: 'passport.pdf',
    mimeType: 'application/pdf',
    idempotencyKey: KEY,
  });
  line(`  same job_id returned : ${second.job_id === firstJobId ? 'YES - key honoured' : 'NO - a second job was created'}`);
  line(`  duplicate flag       : ${JSON.stringify(second.duplicate)}`);
  report('JobAccepted (re-submit)', second);
} catch (err: any) {
  line(`  RE-SUBMIT FAILED: ${err?.constructor?.name} status=${err?.status}`);
}

/* ------------------------------------------------------------------ */
/* Phase 5 - retry, only if a failure occurred naturally               */
/* ------------------------------------------------------------------ */

line('\n=== phase 5: retry ===');
if (terminalJob?.status === 'failed') {
  line(`  a genuine failed job exists; retryable=${terminalJob.error?.retryable}`);
  line(`  shouldRetryFailedJob() = ${jobs.shouldRetryFailedJob(terminalJob)}`);
  line('  NOT calling /retry automatically - reporting only.');
} else {
  line('  UNVERIFIED - no job failed naturally, and forcing one would create');
  line('  production workload for no reason. POST /v1/jobs/{job_id}/retry was');
  line('  not exercised; whether it preserves job_id remains unknown.');
}

/* ------------------------------------------------------------------ */

const s = guard.stats();
line('\n=== done ===');
line(`  live external requests : ${s.externalRequests}`);
line(`  blocked (non-allowed)  : ${s.blocked}${s.blockedHosts.length ? ' ' + JSON.stringify(s.blockedHosts) : ''}`);
line(`  graph/meta requests    : ${s.graphRequests} (intercepted locally, never sent)`);
