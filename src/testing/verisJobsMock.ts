/**
 * The Veris Jobs API, mocked to the captured OpenAPI contract.
 *
 * Every state the real service can be in is reachable here on demand, because
 * the ones that matter most — queue full, a retryable failure, a job that never
 * terminates — are exactly the ones that cannot be produced against the live
 * service without doing something antisocial to it.
 *
 * The behaviour of a job is chosen by its filename, so a test asks for a state
 * by naming its fixture and needs no side channel:
 *
 *   anything.pdf            queued -> running -> succeeded
 *   fail-terminal.pdf       queued -> running -> failed, retryable: false
 *   fail-retryable.pdf      queued -> running -> failed, retryable: true
 *   never.pdf               queued -> running -> running -> ... forever
 *   malformed.pdf           succeeded with a result nothing can normalise
 *   queuefull.pdf           rejected at submission with 503
 *
 * `POST /__config {"queueFull": true}` makes every submission a 503, for the
 * backpressure tests that are not about one document.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface JobsMockState {
  queueFull: boolean;
  /** How many polls a job spends queued, then running, before it terminates. */
  queuedPolls: number;
  runningPolls: number;
}

interface Job {
  job_id: string;
  mode: string;
  filename: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  max_attempts: number;
  replay_count: number;
  submitted_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  next_attempt_at?: string | null;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean } | null;
  /** Polls served so far — drives the state progression. */
  polls: number;
  behaviour: string;
}

export const jobsState: JobsMockState = { queueFull: false, queuedPolls: 1, runningPolls: 1 };

const jobs = new Map<string, Job>();
/** Idempotency-Key -> job_id, which is what makes `duplicate` observable. */
const byKey = new Map<string, string>();

export const jobsCounters = {
  submitted: 0,
  duplicates: 0,
  polls: 0,
  retries: 0,
  queueFullRejections: 0,
};

let sequence = 0;

export function resetJobsMock(): void {
  jobs.clear();
  byKey.clear();
  jobsCounters.submitted = 0;
  jobsCounters.duplicates = 0;
  jobsCounters.polls = 0;
  jobsCounters.retries = 0;
  jobsCounters.queueFullRejections = 0;
  jobsState.queueFull = false;
  jobsState.queuedPolls = 1;
  jobsState.runningPolls = 1;
}

/* ------------------------------------------------------------------ */
/* Result payloads — the same shapes the sync routes return            */
/* ------------------------------------------------------------------ */

const RESULTS: Record<string, () => unknown> = {
  // Field-for-field what production returned to `live-jobs-probe.ts`: ten MRZ
  // keys and eight printed-page fields, which normalise to the same eighteen
  // the live service produced. A single field here was enough to prove the
  // envelope was intact but not enough for a load test to notice a mapping
  // break, because one field going missing looks much like one field.
  passport: () => ({
    request_id: 'req_mock',
    confidence: 0.94,
    mrz_source: 'mrz',
    raw_mrz:
      'P<INDKUMARI<<ASHA<<<<<<<<<<<<<<<<<<<<<<<<<<<\n' +
      'Z1234567<1IND9403143F3105113<<<<<<<<<<<<<<04',
    mrz: {
      document_type: 'P',
      issuing_country: 'IND',
      surname: 'KUMARI',
      given_names: 'ASHA',
      passport_number: 'Z1234567',
      nationality: 'IND',
      date_of_birth: '1994-03-14',
      sex: 'F',
      expiry_date: '2031-05-11',
      date_of_issue: '2021-05-12',
      personal_number: null,
      all_check_digits_valid: true,
      individual_check_digits: {
        passport_number: true,
        date_of_birth: true,
        expiry_date: true,
        personal_number: true,
        composite: true,
      },
    },
    fields: [
      { label: 'passport_number', value: 'Z1234567', category: 'passport', page: 1, source: 'printed_page', confidence: 0.95 },
      { label: 'surname', value: 'KUMARI', category: 'passport', page: 1, source: 'printed_page', confidence: 0.94 },
      { label: 'given_names', value: 'ASHA', category: 'passport', page: 1, source: 'printed_page', confidence: 0.94 },
      { label: 'date_of_birth', value: '14/03/1994', category: 'passport', page: 1, source: 'printed_page', confidence: 0.93 },
      { label: 'date_of_issue', value: '12/05/2021', category: 'passport', page: 1, source: 'printed_page', confidence: 0.92 },
      { label: 'date_of_expiry', value: '11/05/2031', category: 'passport', page: 1, source: 'printed_page', confidence: 0.92 },
      { label: 'place_of_birth', value: 'TIRUCHIRAPPALLI', category: 'passport', page: 1, source: 'printed_page', confidence: 0.93 },
      { label: 'place_of_issue', value: 'MADURAI', category: 'passport', page: 1, source: 'printed_page', confidence: 0.92 },
    ],
    pages: [{ page_number: 1, average_confidence: 0.94 }],
    warnings: [],
    processing_time_ms: 1200,
  }),
  resume: () => ({
    request_id: 'req_mock',
    name: 'Asha Kumari',
    designation: 'Senior Welder',
    industry: 'Construction & Engineering',
    highest_qualification: 'Diploma in Mechanical Engineering',
    total_experience_years: 10.2,
    total_experience_human: '10 years 3 months',
    contact: { address: 'Chennai, Tamil Nadu' },
    personal_info: { date_of_birth: '1994-03-14', gender: 'female', father_name: 'Ramesh Kumar' },
    passport_details: { passport_number: 'Z1234567', date_of_expiry: '2031-05-11' },
    certifications: ['TIG welding certificate'],
    warnings: [],
    processing_time_ms: 1500,
  }),
  aadhaar: () => ({
    request_id: 'req_mock',
    aadhaar: {
      name: 'Asha Kumari',
      aadhaar_number: '2345 6789 0123',
      date_of_birth: '1994-03-14',
      year_of_birth: 1994,
      gender: 'female',
      address: '14 Bharathi Street, Tiruchirappalli',
    },
    pages: [{ page_number: 1, average_confidence: 0.95 }],
    page_count: 1,
    languages_used: 'en',
    total_processing_time_ms: 1800,
    warnings: [],
  }),
};

function behaviourOf(filename: string): string {
  if (/queuefull/i.test(filename)) return 'queuefull';
  if (/fail-terminal/i.test(filename)) return 'fail-terminal';
  if (/fail-retryable/i.test(filename)) return 'fail-retryable';
  if (/never/i.test(filename)) return 'never';
  if (/malformed/i.test(filename)) return 'malformed';
  return 'succeed';
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** Minimal multipart reader — enough to recover `mode` and the filename. */
function parseMultipart(raw: Buffer): { mode?: string; filename?: string } {
  const text = raw.toString('latin1');
  const mode = /name="mode"\r?\n\r?\n([^\r\n]+)/.exec(text)?.[1]?.trim();
  const filename = /name="file"; filename="([^"]*)"/.exec(text)?.[1];
  return { mode, filename };
}

function accepted(job: Job, duplicate: boolean) {
  return {
    job_id: job.job_id,
    mode: job.mode,
    status: job.status,
    status_url: `/v1/jobs/${job.job_id}`,
    submitted_at: job.submitted_at,
    duplicate,
  };
}

/** Advances a job one step per poll, so a test sees the real progression. */
function advance(job: Job): void {
  job.polls += 1;

  if (job.behaviour === 'never') {
    job.status = job.polls > jobsState.queuedPolls ? 'running' : 'queued';
    return;
  }

  if (job.polls <= jobsState.queuedPolls) {
    job.status = 'queued';
    return;
  }
  if (job.polls <= jobsState.queuedPolls + jobsState.runningPolls) {
    job.status = 'running';
    job.started_at ??= new Date().toISOString();
    return;
  }

  job.completed_at = new Date().toISOString();

  if (job.behaviour === 'fail-terminal') {
    job.status = 'failed';
    job.attempts = job.max_attempts;
    job.error = { code: 'unreadable_document', message: 'could not read', retryable: false };
    return;
  }
  if (job.behaviour === 'fail-retryable') {
    job.status = 'failed';
    job.attempts = job.max_attempts;
    job.error = { code: 'transient_worker_error', message: 'worker died', retryable: true };
    return;
  }
  if (job.behaviour === 'malformed') {
    job.status = 'succeeded';
    // Structurally valid JSON that carries nothing any normaliser can use.
    job.result = { unexpected: 'envelope', nothing: ['useful'] };
    return;
  }

  job.status = 'succeeded';
  job.result = (RESULTS[job.mode] ?? RESULTS.resume)!();
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

/** Returns true when it handled the request. */
export function handleJobsRoute(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (pathname === '/v1/jobs' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const { mode, filename } = parseMultipart(Buffer.concat(chunks));
      const behaviour = behaviourOf(filename ?? '');

      if (jobsState.queueFull || behaviour === 'queuefull') {
        jobsCounters.queueFullRejections += 1;
        send(
          res,
          503,
          { error: 'job_queue_full', code: 'job_queue_full', detail: 'queue is at max depth' },
          { 'retry-after': '2' },
        );
        return;
      }

      const key = req.headers['idempotency-key'];
      const idem = typeof key === 'string' ? key : undefined;

      if (idem && byKey.has(idem)) {
        jobsCounters.duplicates += 1;
        send(res, 202, accepted(jobs.get(byKey.get(idem)!)!, true));
        return;
      }

      const job: Job = {
        job_id: `job_mock_${++sequence}`,
        mode: mode ?? 'resume',
        filename: filename ?? 'upload',
        status: 'queued',
        attempts: 0,
        max_attempts: 3,
        replay_count: 0,
        submitted_at: new Date().toISOString(),
        polls: 0,
        behaviour,
      };

      jobs.set(job.job_id, job);
      if (idem) byKey.set(idem, job.job_id);
      jobsCounters.submitted += 1;

      send(res, 202, accepted(job, false));
    });
    return true;
  }

  const retry = /^\/v1\/jobs\/([^/]+)\/retry$/.exec(pathname);
  if (retry && req.method === 'POST') {
    req.resume();
    const job = jobs.get(retry[1]!);
    if (!job) {
      send(res, 404, { error: 'not_found' });
      return true;
    }
    jobsCounters.retries += 1;
    // A retry issues a NEW job id, which is the case the client must not assume
    // away — the OpenAPI never promises the id is preserved.
    const replayed: Job = {
      ...job,
      job_id: `job_mock_${++sequence}`,
      status: 'queued',
      polls: 0,
      attempts: 0,
      replay_count: job.replay_count + 1,
      error: null,
      result: undefined,
      behaviour: 'succeed',
    };
    jobs.set(replayed.job_id, replayed);
    send(res, 202, accepted(replayed, false));
    return true;
  }

  const status = /^\/v1\/jobs\/([^/]+)$/.exec(pathname);
  if (status && req.method === 'GET') {
    req.resume();
    const job = jobs.get(status[1]!);
    if (!job) {
      send(res, 404, { error: 'not_found' });
      return true;
    }
    jobsCounters.polls += 1;
    advance(job);
    const { polls, behaviour, ...wire } = job;
    void polls;
    void behaviour;
    send(res, 200, wire);
    return true;
  }

  return false;
}
