/**
 * Discovers the real `/v1/jobs` wire contract, with the fewest live requests
 * that can establish it.
 *
 * Investigation only. Nothing here is reusable as a client — it exists to find
 * out what the client will have to be, and it deliberately reports what the
 * service says rather than assuming what it ought to say.
 *
 * Order is chosen to keep the service's cost near zero:
 *
 *   0. Ask for machine-readable docs. If an OpenAPI document exists, the whole
 *      contract arrives in one GET and no extraction work is done at all.
 *   1. Submit one small synthetic fixture.
 *   2. Poll to a terminal state, honouring Retry-After.
 *   3. Re-submit under the same Idempotency-Key — the only way to observe
 *      whether a key is honoured, and if it is, this creates no second job.
 *
 * The same fetch guard the load rig uses is installed first, with exactly one
 * host allowlisted, so a stray call to Meta, Anthropic, the CRM or anything
 * else fails loudly instead of leaving the machine.
 *
 * Values are never printed — only shapes, types and lengths. Headers are never
 * printed. The fixture is synthetic (a generated PDF naming a fictional person)
 * and contains no real personal data.
 */

import { installFetchGuard } from '../rig/guard.js';

/**
 * The allowlist is supplied by whoever runs this, not granted by the script.
 *
 * The guard reads `LOADTEST_ALLOW_HOST` when it is imported, so a script that
 * set the variable in its own body would be too late anyway — but the better
 * reason is that reaching a live service should be a decision someone typed on
 * a command line, not a constant buried in a file.
 *
 *   LOADTEST_ALLOW_HOST=veriis.adiragroups.com npx tsx loadtest/tools/jobs-contract-probe.ts
 */
const HOST = process.env.LOADTEST_ALLOW_HOST ?? '';
if (!HOST) {
  console.error(
    'Refusing to run: set LOADTEST_ALLOW_HOST to the single host this probe may reach.',
  );
  process.exit(1);
}

const guard = installFetchGuard({ onOutbound: () => undefined });

const { config } = await import('../../src/config.js');
const { SAMPLE_PASSPORT_PDF } = await import('../../src/testing/fixtures.js');

const BASE = config.VERIS_OCR_BASE_URL.replace(/\/$/, '');
const AUTH = { 'X-API-Key': config.VERIS_OCR_API_KEY };

let live = 0;

/* ------------------------------------------------------------------ */
/* Shape reporting — structure without content                         */
/* ------------------------------------------------------------------ */

/**
 * Describes a value by its shape.
 *
 * Strings become `string(len)` rather than their contents, because the whole
 * point of the exercise is the schema and none of it is the document.
 */
function shape(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[] (empty)';
    return [shape(value[0], depth + 1), `×${value.length}`];
  }
  switch (typeof value) {
    case 'string':
      return `string(${value.length})`;
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object': {
      if (depth > 6) return '…';
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = shape(v, depth + 1);
      }
      return out;
    }
    default:
      return typeof value;
  }
}

function report(label: string, body: unknown): void {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(shape(body), null, 2));
}

/** Header names only — never values, so a key can never be printed. */
function headerNames(res: Response): string {
  return [...res.headers.keys()].sort().join(', ');
}

function retryAfterOf(res: Response): string {
  const h = res.headers.get('retry-after');
  return h === null ? '(absent)' : `"${h}"`;
}

async function call(
  label: string,
  url: string,
  init: RequestInit,
): Promise<{ res: Response; text: string; json?: unknown }> {
  live += 1;
  const started = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  console.log(
    `[live ${live}] ${label}  ${res.status}  ${Date.now() - started}ms  ` +
      `retry-after=${retryAfterOf(res)}  headers: ${headerNames(res)}`,
  );
  return { res, text, json };
}

/* ------------------------------------------------------------------ */
/* Preflight                                                           */
/* ------------------------------------------------------------------ */

const fixture = SAMPLE_PASSPORT_PDF();

console.log(`
PREFLIGHT
  target host              ${HOST}
  base url                 ${BASE}
  fixture                  passport.pdf, application/pdf, ${fixture.byteLength} bytes
                           (synthetic PDF, fictional person, no real personal data)
  intended live requests   up to 3 discovery GETs (docs), 1 submit, <=20 polls, 1 idempotency re-submit
  outbound guard           INSTALLED — only ${HOST} permitted; all else throws

  NOT contacted: production MongoDB (no DB connection opened at all),
                 CRM, Anthropic, Meta/WhatsApp Graph, Redis.
  Secrets: API key read from config and sent as a header; never logged.
`);

/* ------------------------------------------------------------------ */
/* 0. Machine-readable docs — cheapest possible discovery              */
/* ------------------------------------------------------------------ */

console.log('=== phase 0: documentation discovery ===');

let docsFound = false;
for (const path of ['/openapi.json', '/docs/openapi.json', '/v1/openapi.json']) {
  const { res, json } = await call(`GET ${path}`, `${BASE}${path}`, { headers: AUTH });
  if (res.ok && json) {
    const doc = json as { paths?: Record<string, unknown> };
    if (doc.paths) {
      docsFound = true;
      const jobPaths = Object.keys(doc.paths).filter((p) => p.includes('job'));
      console.log(`\nOpenAPI found. Job-related paths: ${JSON.stringify(jobPaths)}`);
      for (const p of jobPaths) {
        console.log(`\n  ${p}:`);
        console.log(
          JSON.stringify(shape((doc.paths as Record<string, unknown>)[p]), null, 2)
            .split('\n')
            .map((l) => '    ' + l)
            .join('\n'),
        );
      }
      // The schemas matter more than the paths for the result payload.
      const components = (json as { components?: { schemas?: Record<string, unknown> } }).components;
      if (components?.schemas) {
        console.log(`\n  schema names: ${JSON.stringify(Object.keys(components.schemas))}`);
      }
    }
    break;
  }
}

if (!docsFound) console.log('\nNo OpenAPI document served; falling back to a live submission.\n');

/* ------------------------------------------------------------------ */
/* 1. Submit                                                           */
/* ------------------------------------------------------------------ */

console.log('\n=== phase 1: submission ===');

const IDEMPOTENCY_KEY = 'probe/contract/passport/0001';

/**
 * The extract routes use a multipart field named `image`, so that is the
 * starting assumption. If the service wants something else it will say so, and
 * what it says is the answer — this does not iterate through guesses.
 */
const form = new FormData();
form.append('image', new Blob([fixture], { type: 'application/pdf' }), 'passport.pdf');
form.append('mode', 'passport');

const submit = await call('POST /v1/jobs', `${BASE}/v1/jobs`, {
  method: 'POST',
  headers: { ...AUTH, 'Idempotency-Key': IDEMPOTENCY_KEY },
  body: form,
  signal: AbortSignal.timeout(60_000),
});

report('submit response body', submit.json ?? submit.text.slice(0, 400));

if (!submit.res.ok) {
  console.log(`
SUBMISSION DID NOT SUCCEED (${submit.res.status}).
Documenting the service's own words rather than guessing another shape:

${submit.text.slice(0, 800)}

Stopping here. The required request format is whatever the message above
describes; the remaining phases need a job id that was never issued.
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 2. Poll                                                             */
/* ------------------------------------------------------------------ */

console.log('\n=== phase 2: status polling ===');

const body = submit.json as Record<string, any>;

// Find the job id and status url wherever they are, and report where they were.
const jobId =
  body?.job_id ?? body?.id ?? body?.jobId ?? body?.job?.id ?? body?.data?.job_id ?? body?.data?.id;
const statusUrlRaw =
  body?.status_url ?? body?.statusUrl ?? body?.links?.status ?? body?.job?.status_url ?? undefined;

console.log(`  job id      ${jobId ? `found (${typeof jobId}, ${String(jobId).length} chars)` : 'NOT FOUND in the response'}`);
console.log(`  status url  ${statusUrlRaw ? 'provided by the service' : 'NOT provided — will use /v1/jobs/{id}'}`);

const statusUrl = statusUrlRaw
  ? String(statusUrlRaw).startsWith('http')
    ? String(statusUrlRaw)
    : `${BASE}${String(statusUrlRaw)}`
  : `${BASE}/v1/jobs/${jobId}`;

const states = new Set<string>();
let terminal: Record<string, any> | undefined;
let delay = 2000;
const deadline = Date.now() + 180_000;

for (let i = 0; i < 20 && Date.now() < deadline; i++) {
  await new Promise((r) => setTimeout(r, delay));

  const poll = await call(`GET status (poll ${i + 1})`, statusUrl, { headers: AUTH });
  const pj = poll.json as Record<string, any> | undefined;

  const state = pj?.status ?? pj?.state ?? pj?.job?.status ?? pj?.data?.status;
  if (typeof state === 'string') states.add(state);
  console.log(`            state=${JSON.stringify(state)}`);

  const ra = poll.res.headers.get('retry-after');
  delay = ra && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.min(delay * 1.5, 15_000);

  if (typeof state === 'string' && /succeed|complete|done|fail|error|cancel/i.test(state)) {
    terminal = pj;
    break;
  }
  if (i === 0) report('status response body (first poll)', pj ?? poll.text.slice(0, 300));
}

console.log(`\n  states observed: ${JSON.stringify([...states])}`);

if (terminal) {
  report('TERMINAL status body (shape only)', terminal);

  // Where does the extraction actually live?
  for (const candidate of ['result', 'output', 'data', 'payload', 'extraction', 'results']) {
    if (terminal[candidate] !== undefined) {
      console.log(`\n  result appears under: "${candidate}"`);
      report(`terminal.${candidate}`, terminal[candidate]);
    }
  }

  // Compatibility with the three existing normalisers.
  const probe = (obj: any, path: string): boolean =>
    path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) !== undefined;

  const roots: Array<[string, any]> = [
    ['(top level)', terminal],
    ['result', terminal.result],
    ['output', terminal.output],
    ['data', terminal.data],
  ].filter(([, v]) => v && typeof v === 'object') as Array<[string, any]>;

  console.log('\n  NORMALISER COMPATIBILITY:');
  for (const [label, root] of roots) {
    const hits = [
      ['mrz', probe(root, 'mrz')],
      ['mrz.passport_number', probe(root, 'mrz.passport_number')],
      ['aadhaar', probe(root, 'aadhaar')],
      ['personal_info', probe(root, 'personal_info')],
      ['pages', probe(root, 'pages')],
      ['fields', probe(root, 'fields')],
      ['confidence', probe(root, 'confidence')],
      ['name', probe(root, 'name')],
    ]
      .filter(([, present]) => present)
      .map(([k]) => k);
    console.log(`    under ${String(label).padEnd(12)} ${hits.length ? hits.join(', ') : '(none of the expected keys)'}`);
  }
} else {
  console.log('\n  No terminal state reached inside the probe window. Not retried.');
}

/* ------------------------------------------------------------------ */
/* 3. Idempotency                                                      */
/* ------------------------------------------------------------------ */

console.log('\n=== phase 3: idempotency ===');
console.log('  re-submitting with the SAME Idempotency-Key.');
console.log('  If the key is honoured this creates no second job.');

const form2 = new FormData();
form2.append('image', new Blob([fixture], { type: 'application/pdf' }), 'passport.pdf');
form2.append('mode', 'passport');

const resubmit = await call('POST /v1/jobs (same key)', `${BASE}/v1/jobs`, {
  method: 'POST',
  headers: { ...AUTH, 'Idempotency-Key': IDEMPOTENCY_KEY },
  body: form2,
  signal: AbortSignal.timeout(60_000),
});

const rj = resubmit.json as Record<string, any> | undefined;
const jobId2 = rj?.job_id ?? rj?.id ?? rj?.jobId ?? rj?.job?.id ?? rj?.data?.job_id;

console.log(`  first job id  === second job id ?  ${String(jobId) === String(jobId2) ? 'YES — key honoured' : 'NO — a second job was created'}`);
report('re-submit response body', rj ?? resubmit.text.slice(0, 300));

console.log(`\n=== done. ${live} live requests total. Guard blocked: ${guard.stats().blocked} ===\n`);
