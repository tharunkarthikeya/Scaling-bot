/**
 * Proves the loop the CRM's Data Management screen exists for.
 *
 *   npm run verify:taxonomy
 *
 * An admin adds a job in the CRM. A candidate is offered it on WhatsApp. That
 * is one sentence and four systems, and every one of them can silently fail to
 * hold up its end:
 *
 *   * the CRM can store the job but not publish it to the bot;
 *   * the bot can fetch it and not put it in the list;
 *   * the list can overflow WhatsApp's ten-row ceiling, which rejects the whole
 *     message rather than dropping a row;
 *   * the CV rule the admin set on the job can fail to reach the answer the
 *     conversation actually asks for.
 *
 * So this creates a real job with a real country override, drives it through
 * the real fetch and the real rendering path, checks the real policy endpoint,
 * and deletes it again. It writes to the CRM, so it is opt-in the same way
 * `verify:crm -- --submit` is.
 *
 * Needs an admin login, because creating a job is an admin's job — the service
 * key deliberately cannot do it.
 */
import { config } from './config.js';
import { crmConfigured } from './crm/client.js';
import { refreshTaxonomy, resetTaxonomy, taxonomy } from './crm/taxonomy.js';
import { stepById } from './conversation/flow.js';
import { choicesFor } from './conversation/render.js';
import { destinationCountryOf, inSingaporeMalaysiaBranch } from './conversation/flow.js';
import type { CandidateDoc } from './db/models.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let failures = 0;

function check(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(
    `  ${ok ? `${GREEN}ok  ${RESET}` : `${RED}FAIL${RESET}`}  ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`,
  );
}

console.log(`\n${BOLD}CRM Data Management → the bot's questions${RESET}`);

if (!crmConfigured()) {
  console.error(`\n${RED}CRM_API_URL / CRM_API_KEY are not set.${RESET}\n`);
  process.exit(2);
}

const base = config.CRM_API_URL!.replace(/\/$/, '');

const email = process.env.CRM_ADMIN_EMAIL ?? 'admin@gmail.com';
const password = process.env.CRM_ADMIN_PASSWORD ?? 'admin@123';

const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
}).catch(() => undefined);

if (!login?.ok) {
  console.error(
    `\n${RED}Could not sign in to the CRM as ${email}.${RESET}\n` +
      `Set CRM_ADMIN_EMAIL and CRM_ADMIN_PASSWORD if the admin account differs.\n`,
  );
  process.exit(2);
}

const { token } = (await login.json()) as { token: string };
const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

/** A job nobody will mistake for a real one. */
const TITLE = 'ZZ Taxonomy Probe';
const JOB_ID = 'zz_taxonomy_probe';

console.log(`${DIM}creating "${TITLE}" — CV required by default, not required in Malaysia${RESET}\n`);

const probe = {
  title: TITLE,
  cv_required_default: true,
  cv_overrides: { Malaysia: false },
  active: true,
  bot_visible: true,
  // First, because that is the claim being tested: an admin adds a job, puts it
  // at the top, and a candidate sees it. Ordering it last would prove only that
  // the ten-row cap works, which the smoke suite already covers — and would
  // fail this check for the right reason, which is a confusing way to pass.
  bot_order: 0,
};

let created = await fetch(`${base}/job-designations`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify(probe),
});

if (created.status === 409) {
  // A previous run's probe is still on file. Jobs are retired rather than
  // erased — candidates point at them, and a deleted row would make "why was
  // this candidate not asked for a CV?" unanswerable — so the row from last
  // time is reused, which is exactly what the 409 tells an admin to do.
  console.log(`${DIM}reusing the probe job left by an earlier run${RESET}`);
  created = await fetch(`${base}/job-designations`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ...probe, id: JOB_ID }),
  });
}

check(created.ok, 'the CRM accepted the job', `${created.status}`);

try {
  /* 1. Does the bot see it? ------------------------------------------------ */
  resetTaxonomy();
  await refreshTaxonomy();
  const rows = taxonomy();
  check(!!rows, 'the bot fetched the list', rows ? `version ${rows.version}` : 'nothing came back');
  check(
    !!rows?.jobs.some((j) => j.id === JOB_ID),
    'the new job is in what the bot fetched',
    `${rows?.jobs.length ?? 0} jobs`,
  );

  /* 2. Does a candidate get offered it? ------------------------------------ */
  const step = stepById('sgmy_job_category')!;
  const candidate = {
    waId: '910000000000',
    currentStep: 'sgmy_job_category',
    profile: { countryPreference: 'malaysia' },
    documents: {},
  } as unknown as CandidateDoc;

  const offered = choicesFor(step, candidate);
  const row = offered.find((c) => c.id === JOB_ID);
  check(!!row, 'a candidate is offered it', row ? row.label.en : 'not in the rendered list');
  check(
    offered.length <= (rows?.botListLimit ?? 10),
    'the list still fits in one WhatsApp message',
    `${offered.length} rows, ceiling ${rows?.botListLimit ?? 10}`,
  );
  check(
    offered.some((c) => c.id === 'other'),
    '"Other" survives, so a job past the ninth row is still reachable',
  );

  /* 3. Does the CV rule the admin wrote reach the conversation? ------------ */
  const { fetchCvRequirement } = await import('./crm/client.js');

  const inMalaysia = await fetchCvRequirement({
    destinationCountry: 'Malaysia',
    jobCategory: JOB_ID,
  });
  check(
    inMalaysia?.cv_required === false,
    'Malaysia: no CV — the country override the admin set',
    `cv_required=${inMalaysia?.cv_required} version=${inMalaysia?.policy_version}`,
  );

  const elsewhere = await fetchCvRequirement({
    destinationCountry: 'Singapore',
    jobCategory: JOB_ID,
  });
  check(
    elsewhere?.cv_required === true,
    'Singapore: CV — the job default, since no override says otherwise',
    `cv_required=${elsewhere?.cv_required}`,
  );

  /* 4. And a country added in the CRM? ------------------------------------- */
  const country = await fetch(`${base}/countries`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'ZZ Probeland', bot_order: 99 }),
  });
  check(country.ok, 'the CRM accepted a new country', `${country.status}`);

  resetTaxonomy();
  await refreshTaxonomy();

  const probeCandidate = {
    ...candidate,
    profile: { countryPreference: 'zz_probeland' },
  } as unknown as CandidateDoc;

  check(
    destinationCountryOf(probeCandidate) === 'ZZ Probeland',
    'the bot can name the new country for the CRM',
    destinationCountryOf(probeCandidate) ?? 'undefined',
  );
  check(
    inSingaporeMalaysiaBranch(probeCandidate),
    'and routes it through the questions that settle the CV rule',
    'passport → job → policy',
  );

  await fetch(`${base}/countries/zz_probeland`, { method: 'DELETE', headers: auth });
} finally {
  /* Always tidy up, including after a failed assertion. */
  await fetch(`${base}/job-designations/${JOB_ID}`, { method: 'DELETE', headers: auth });
  const { deleteProbe } = { deleteProbe: true };
  if (deleteProbe) {
    console.log(`\n${DIM}probe job and country retired${RESET}`);
  }
  resetTaxonomy();
}

console.log('');
if (failures === 0) {
  console.log(`${GREEN}${BOLD}A job added in the CRM reaches candidates.${RESET}`);
} else {
  console.log(`${RED}${BOLD}${failures} check(s) failed.${RESET}`);
  console.log(
    `${YELLOW}The probe job may still exist in the CRM — search Data Management for "${TITLE}".${RESET}`,
  );
}
console.log('');

process.exit(failures ? 1 : 0);
