/**
 * Proves the link between this bot and the recruitment CRM actually works.
 *
 *   npm run verify:crm                 read-only — nothing is created anywhere
 *   npm run verify:crm -- --submit     also posts one clearly-marked test candidate
 *
 * `doctor` checks the chain between a candidate's WhatsApp message and a reply.
 * This checks the other end: the four things that have to be true before a
 * finished registration reaches the CRM, and the one thing that has to be true
 * before the CRM's decision reaches the candidate.
 *
 *   1. we are pointed at it                  CRM_API_URL / CRM_API_KEY
 *   2. it is reachable                       GET   /health
 *   3. it accepts our credential — and       GET   /policy/cv-required
 *      refuses a request without one
 *   4. it accepts a submission and           POST  /candidates             (--submit)
 *      recognises the repeat                 POST  /candidates/{id}/resume
 *   5. it can write a decision back to us    PATCH /api/candidates/:waId/application
 *
 * Point 3 is worth the extra call. A CRM that answers a request carrying no key
 * is authenticating nobody, and the failure that matters there is not ours.
 *
 * Point 4 is opt-in because it writes to somebody else's database. The test
 * candidate carries a fixed idempotency key, so running it repeatedly produces
 * one record rather than one per run — and the second call is itself the check:
 * the CRM must return the same id with `created: false`. Without that, every
 * queue retry of a real candidate would create a duplicate person.
 *
 * The last section reads our own database rather than the network — how many
 * finished registrations are waiting, delivered, or stuck. Live traffic is the
 * only evidence a health check cannot fake.
 */
import { config } from './config.js';
import {
  CrmError,
  createCandidate,
  crmConfigured,
  crmHealth,
  fetchCvRequirement,
  uploadResume,
} from './crm/client.js';
import type { CrmCandidatePayload } from './crm/mapping.js';

const SUBMIT = process.argv.includes('--submit');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

type State = 'ok' | 'warn' | 'fail';

const results: Array<{ state: State; name: string; detail: string }> = [];

function record(state: State, name: string, detail: string, fix?: string): void {
  results.push({ state, name, detail });
  const badge =
    state === 'ok'
      ? `${GREEN}  ok  ${RESET}`
      : state === 'warn'
        ? `${YELLOW} warn ${RESET}`
        : `${RED} FAIL ${RESET}`;
  console.log(`${badge} ${name.padEnd(24)} ${detail}`);
  if (fix) console.log(`${DIM}       -> ${fix}${RESET}`);
}

function short(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]!.slice(0, 200);
}

function section(title: string): void {
  console.log(`\n${DIM}${title}${RESET}`);
}

console.log(`\n${BOLD}Adira bot -> CRM link${RESET}`);
console.log(
  `${DIM}environment: ${config.NODE_ENV}   mode: ${
    SUBMIT ? '--submit (will create a test candidate)' : 'read-only'
  }${RESET}`,
);

/* 1. Are we even pointed at a CRM? ---------------------------------------- */

section('configuration');

if (!crmConfigured()) {
  record(
    'fail',
    'configuration',
    `CRM_API_URL=${config.CRM_API_URL ? 'set' : 'unset'}  CRM_API_KEY=${config.CRM_API_KEY ? 'set' : 'unset'}`,
    'Both must be set in .env — they ship commented out. Until they are, the bot skips the CRM ' +
      'entirely: registrations still complete and are stored here with crmSync status `pending`, ' +
      'and nothing is sent anywhere.',
  );
  console.log(`\n${RED}Not connected. Nothing further can be checked.${RESET}\n`);
  process.exit(1);
}

const base = config.CRM_API_URL!.replace(/\/$/, '');
record(
  'ok',
  'configuration',
  `${base}   key ${config.CRM_API_KEY!.length} chars   timeout ${config.CRM_TIMEOUT_MS}ms`,
);

if (/^http:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(base)) {
  record(
    'warn',
    'transport',
    'plain HTTP to a non-local host',
    'The service key and candidate PII cross the network in clear text. Use HTTPS for anything ' +
      'but a machine you are sitting at.',
  );
}

/* 2. Is it there? ---------------------------------------------------------- */

section('reachability');

const health = await crmHealth();
record(
  health.ok ? 'ok' : 'fail',
  'GET /health',
  health.detail,
  health.ok
    ? undefined
    : 'The CRM is not running, the URL is wrong, or a firewall sits between you. If your friend ' +
      'runs it on their own machine, `localhost` here means *your* machine — you need the address ' +
      'their service is actually published on.',
);

/* 3. Does it know who we are? ---------------------------------------------- */

section('authentication');

const policyUrl = `${base}/policy/cv-required?destination_country=Malaysia&job_category=construction`;

try {
  // No key, on purpose. A CRM that answers this is authenticating nobody.
  const res = await fetch(policyUrl, { signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS) });
  const refused = res.status === 401 || res.status === 403 || res.status === 422;
  record(
    refused ? 'ok' : 'warn',
    'key required',
    refused
      ? `unauthenticated request refused (${res.status})`
      : `unauthenticated request ANSWERED (${res.status})`,
    refused
      ? undefined
      : 'The CRM served candidate policy to a caller with no credential. Anyone who can reach the ' +
        'URL can reach the API. That is their side to fix, not ours.',
  );
} catch (err) {
  record('warn', 'key required', short(err));
}

try {
  const res = await fetch(policyUrl, {
    headers: { 'X-Service-Key': config.CRM_API_KEY! },
    signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    record(
      'fail',
      'key accepted',
      `refused with our key (${res.status})`,
      'CRM_API_KEY does not match what the CRM expects. On their side it is WHATSAPP_SERVICE_KEY, ' +
        'sent as the X-Service-Key header. Compare the two exactly — a trailing space or a quoted ' +
        'value in .env is the usual cause.',
    );
  } else if (res.status === 404) {
    record(
      'fail',
      'key accepted',
      '404 — /policy/cv-required is not implemented',
      'The bot asks this mid-conversation to decide whether to ask for a CV. Without it the bot ' +
        "falls back to its own cached policy, which drifts from theirs.",
    );
  } else {
    record('ok', 'key accepted', `${res.status} with X-Service-Key`);
  }
} catch (err) {
  record('fail', 'key accepted', short(err));
}

/* 4. The call the conversation itself makes -------------------------------- */

section('cv policy');

const policy = await fetchCvRequirement({
  destinationCountry: 'Malaysia',
  jobCategory: 'construction',
});

if (!policy) {
  record(
    'warn',
    'cv-required lookup',
    'no usable answer — the bot will fall back to its cached policy',
    'Not fatal by design: a registration is never stalled behind the CRM being unreachable. But ' +
      'until this answers, the CV question the bot asks is the one *we* think is right.',
  );
} else {
  record(
    'ok',
    'cv-required lookup',
    `cv_required=${policy.cv_required}  policy_version=${policy.policy_version || '(none)'}`,
  );
  if (!policy.policy_version) {
    record('warn', 'policy version', 'blank — cannot tell which ruleset answered');
  }
}

/* 4b. The questions the CRM decides ---------------------------------------- */

section('taxonomy (what the bot offers candidates)');

{
  const { refreshTaxonomy, taxonomy } = await import('./crm/taxonomy.js');
  await refreshTaxonomy();
  const rows = taxonomy();

  if (!rows) {
    record(
      'warn',
      'GET /taxonomy',
      'no list — the bot will offer its compiled-in jobs and countries',
      'Not fatal: the built-in lists are the ones the CRM is seeded with. But a job an admin ' +
        'adds will not reach candidates until this answers.',
    );
  } else {
    record(
      'ok',
      'GET /taxonomy',
      `${rows.jobs.length} job(s), ${rows.countries.length} countr(y|ies), version ${rows.version}`,
    );

    // The ceiling is the CRM's to state and the bot's to respect, and getting
    // it wrong is not a degraded list — Meta rejects the whole message.
    const overflow = rows.jobs.length > rows.botListLimit - 1;
    record(
      'ok',
      'list size',
      overflow
        ? `${rows.jobs.length} jobs, ${rows.botListLimit - 1} shown + "Other" (the rest are typed)`
        : `${rows.jobs.length} jobs, all shown`,
    );

    const unnamed = rows.countries.filter((c) => !c.name?.trim());
    if (unnamed.length) {
      record(
        'fail',
        'country names',
        `${unnamed.length} country row(s) have no name`,
        'The name is what fills `destination_country`, which is half the key the CV policy is ' +
          'resolved from. A country with no name is a candidate the policy cannot rule on.',
      );
    }

    /* Which rows a candidate can actually see -------------------------------- */
    //
    // The question an admin who has just added a job actually has, and the one
    // this command could not answer before: is it on the list? Ten rows is a
    // hard ceiling, so past a certain number of jobs the answer is no — and the
    // fix is an edit to `bot_order`, not a deploy.
    const { stepById } = await import('./conversation/flow.js');
    const { acceptedChoices, choicesFor } = await import('./conversation/render.js');
    const parked = {
      waId: '910000000000',
      profile: { lookingForOverseasJob: true },
      documents: {},
    } as unknown as import('./db/models.js').CandidateDoc;

    const lists: Array<[string, string, string[]]> = [
      ['job_category', 'jobs on the list', rows.jobs.map((j) => j.id)],
      ['country_preference', 'countries on the list', rows.countries.map((c) => c.id)],
    ];

    for (const [stepId, label, ids] of lists) {
      const step = stepById(stepId)!;
      const shown = new Set(choicesFor(step, parked).map((c) => c.id));
      const accepted = new Set(acceptedChoices(step, parked).map((c) => c.id));

      const offList = ids.filter((id) => !shown.has(id));
      const unreachable = ids.filter((id) => !accepted.has(id));

      record(
        'ok',
        label,
        offList.length
          ? `${ids.length - offList.length} shown, ${offList.length} reached by typing (${offList.join(', ')})`
          : `all ${ids.length} shown`,
        offList.length
          ? 'A row past the ceiling is not lost — a candidate who types it is understood — but it ' +
              'is not on screen. Lower its bot_order in Data Management to bring it onto the list.'
          : undefined,
      );

      if (unreachable.length) {
        record(
          'fail',
          `${label}: unreachable`,
          unreachable.join(', '),
          'These are on the CRM’s list and cannot be chosen or typed. A candidate answering with ' +
            'one is told it is not an option.',
        );
      }
    }

    /* The questions hanging off those jobs ----------------------------------- */
    //
    // One request per job. This is a diagnostic run by a person, not a hot path,
    // and "which of my jobs actually ask anything?" is not answerable from the
    // taxonomy alone.
    const { fetchJobQuestions } = await import('./crm/taxonomy.js');
    const counted = await Promise.all(
      rows.jobs.map(async (job) => [job, await fetchJobQuestions(job.id)] as const),
    );

    const unanswerable = counted.filter(([, questions]) => questions === undefined);
    const withQuestions = counted.filter(([, questions]) => questions?.length);

    if (unanswerable.length) {
      record(
        'fail',
        'GET /jobs/{id}/questions',
        `${unanswerable.length} job(s) did not answer`,
        'The screening questions an admin wrote will not be asked while this fails. The ' +
          'registration itself is unaffected.',
      );
    } else {
      record(
        'ok',
        'job questions',
        withQuestions.length
          ? withQuestions.map(([job, q]) => `${job.id}:${q!.length}`).join('  ')
          : 'none configured on any job',
        withQuestions.length
          ? undefined
          : 'Not a fault. Add them in Data Management → Questions and a candidate who picks that ' +
              'job is asked them within five minutes.',
      );
    }
  }
}

/* 5. The submission itself -------------------------------------------------- */

section('submission');

if (!SUBMIT) {
  record(
    'warn',
    'POST /candidates',
    'not tested — read-only run',
    'Re-run with `npm run verify:crm -- --submit` to post one test candidate. It writes to your ' +
      "friend's database, so it is opt-in.",
  );
} else {
  // Fixed, and obviously not a person. The key is what makes this safe to run
  // repeatedly: the CRM must fold every run into the same record.
  const probe: CrmCandidatePayload = {
    source: 'whatsapp',
    idempotency_key: `whatsapp/${config.WHATSAPP_PHONE_NUMBER_ID}/verify-crm-probe`,
    cv_required_claim: false,
    profile: {
      full_name: 'ZZ Integration Probe (safe to delete)',
      phone: '+910000000000',
      phone_e164: '+910000000000',
      email: 'integration-probe@example.invalid',
      country: 'India',
      destination_country: 'Malaysia',
      job_category: 'construction',
      job_preference: 'construction',
    },
  };

  let candidateId: string | undefined;

  try {
    const first = await createCandidate(probe);
    candidateId = first.candidate_id;
    record(
      'ok',
      'POST /candidates',
      `candidate_id=${first.candidate_id} created=${first.created} cv_required=${first.cv_required}`,
    );

    // The check that matters. Every retry in the queue sends this same payload;
    // if the CRM makes a second person out of it, one flaky network moment
    // becomes two candidates a recruiter reconciles by hand.
    const second = await createCandidate(probe);
    const sameRecord = second.candidate_id === first.candidate_id;
    record(
      sameRecord && second.created === false ? 'ok' : 'fail',
      'idempotency',
      sameRecord
        ? `repeat returned the same id, created=${second.created}`
        : `repeat created a SECOND record (${first.candidate_id} then ${second.candidate_id})`,
      sameRecord && second.created === false
        ? undefined
        : 'The CRM is not honouring idempotency_key. Our retries are not optional — a candidate ' +
          'whose first submission times out is resent — so this produces duplicate people.',
    );
  } catch (err) {
    const crmErr = err instanceof CrmError ? err : undefined;
    if (crmErr?.needsCv) {
      record(
        'warn',
        'POST /candidates',
        `422 policy requires a CV — ${crmErr.message}`,
        'This is the CRM working: it refused a candidate with no résumé. A real candidate would ' +
          'have the CV step reopened and be resubmitted under the same key. The probe carries no ' +
          'file, so it cannot get past this.',
      );
    } else {
      record(
        'fail',
        'POST /candidates',
        crmErr
          ? `${crmErr.status || 'network'} ${crmErr.message} (retryable=${crmErr.retryable})`
          : short(err),
        'This is the call that delivers a finished registration. While it fails, candidates are ' +
          'collected and stored here but never handed over.',
      );
    }
  }

  if (candidateId) {
    // Structurally valid, so a CRM that sniffs content types sees a real PDF.
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
        'trailer<</Root 1 0 R>>\n%%EOF\n',
      'utf8',
    );
    try {
      await uploadResume({
        candidateId,
        buffer: pdf,
        filename: 'integration-probe.pdf',
        mimeType: 'application/pdf',
      });
      record('ok', 'POST .../resume', `${pdf.length} bytes accepted for ${candidateId}`);
    } catch (err) {
      const crmErr = err instanceof CrmError ? err : undefined;
      record(
        'fail',
        'POST .../resume',
        crmErr ? `${crmErr.status || 'network'} ${crmErr.message}` : short(err),
        'Profiles would sync without their CVs. The bot treats this as best-effort and still marks ' +
          'the candidate synced, so nothing here would alert you in production.',
      );
    }
  }
}

/* 6. The way back ----------------------------------------------------------- */

section('return path (CRM -> bot)');

if (!config.ADMIN_API_KEY) {
  record(
    'warn',
    'ADMIN_API_KEY',
    'unset — /api/* is not served at all',
    'The CRM sets a hiring outcome with PATCH /api/candidates/:waId/application, and reads ' +
      'candidates and documents from /api/*. With no key those routes do not exist, so the ' +
      'decision never reaches the candidate. Set it here and give the same value to your friend.',
  );
} else {
  record('ok', 'ADMIN_API_KEY', `set (${config.ADMIN_API_KEY.length} chars) — /api/* is served`);

  const selfUrl = `http://127.0.0.1:${config.PORT}/api/candidates?limit=1`;
  try {
    const anon = await fetch(selfUrl, { signal: AbortSignal.timeout(5_000) });
    const authed = await fetch(selfUrl, {
      headers: { 'X-Api-Key': config.ADMIN_API_KEY },
      signal: AbortSignal.timeout(5_000),
    });
    record(
      anon.status === 401 && authed.ok ? 'ok' : 'warn',
      'bot /api/*',
      `without key ${anon.status}, with key ${authed.status}`,
      anon.status === 401 && authed.ok
        ? undefined
        : 'Expected 401 then 200. The header is x-api-key — see the onRequest hook in src/server.ts.',
    );
  } catch {
    record(
      'warn',
      'bot /api/*',
      `nothing answering on 127.0.0.1:${config.PORT}`,
      'Only checkable while the bot is running (`npm run dev`). Skipped, not failed.',
    );
  }
}

/* 7. What has actually happened --------------------------------------------- */

section('live traffic (our database)');

try {
  const { connectDb, closeDb } = await import('./db/client.js');
  const { candidates } = await import('./db/models.js');
  await connectDb();

  const completed = await candidates().countDocuments({ stage: 'REGISTRATION_COMPLETED' });
  const rows = await candidates()
    .aggregate<{ _id: string; n: number }>([
      { $match: { stage: 'REGISTRATION_COMPLETED' } },
      { $group: { _id: { $ifNull: ['$crmSync.status', 'never attempted'] }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();

  if (completed === 0) {
    record(
      'warn',
      'finished registrations',
      'none yet — nothing has had occasion to sync',
      'Drive one through with `npm run harness`, or register from a real number, then re-run this.',
    );
  } else {
    const summary = rows.map((r) => `${r._id}=${r.n}`).join('  ');
    const stuck = rows
      .filter((r) => r._id === 'failed' || r._id === 'needs_cv')
      .reduce((total, r) => total + r.n, 0);
    const synced = rows.find((r) => r._id === 'synced')?.n ?? 0;

    record(
      stuck > 0 ? 'fail' : synced > 0 ? 'ok' : 'warn',
      'crm sync status',
      `${completed} finished — ${summary}`,
      stuck > 0
        ? 'A `failed` candidate has exhausted its attempts and waits for an operator; the record is ' +
          'intact. `needs_cv` means the CRM asked for a résumé the candidate has not sent.'
        : synced === 0
          ? 'Nothing has reached the CRM yet. The sweep re-queues these every ' +
            `${Math.round(config.INGESTION_RECONCILE_INTERVAL_MS / 60_000)} minutes while the bot runs.`
          : undefined,
    );

    const [recent] = await candidates()
      .find({ 'crmSync.lastError': { $exists: true } })
      .sort({ 'crmSync.lastAttemptAt': -1 })
      .limit(1)
      .toArray();

    const sync = recent?.crmSync;
    const lastError = sync?.lastError;
    if (sync && lastError) {
      record(
        'warn',
        'last sync error',
        `${sync.lastAttemptAt?.toISOString() ?? '?'} after ${sync.attempts} attempt(s): ` +
          `${lastError.slice(0, 120)}`,
      );
    }
  }

  await closeDb();
} catch (err) {
  record('warn', 'live traffic', `database unreadable — ${short(err)}`);
}

/* 8. Verdict ---------------------------------------------------------------- */

const failures = results.filter((r) => r.state === 'fail');
const warnings = results.filter((r) => r.state === 'warn');

console.log('');
if (failures.length === 0) {
  console.log(`${GREEN}The link works.${RESET}`);
  if (!SUBMIT) {
    console.log(
      `${DIM}Reachability and credentials only — the submission itself stays untested until you run ` +
        `npm run verify:crm -- --submit${RESET}`,
    );
  }
} else {
  console.log(`${RED}${failures.length} blocking problem(s):${RESET}`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
}
if (warnings.length) {
  console.log(`${YELLOW}${warnings.length} warning(s) — worth reading, none are fatal.${RESET}`);
}

if (SUBMIT) {
  console.log(
    `${DIM}A test candidate named "ZZ Integration Probe" now exists in the CRM. Ask your friend to ` +
      `delete it before real traffic starts.${RESET}`,
  );
}
console.log('');

process.exit(failures.length ? 1 : 0);
