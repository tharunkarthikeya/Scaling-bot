/**
 * A stand-in for the Veris OCR service.
 *
 * Reached because the rig sets `VERIS_OCR_BASE_URL` at it. Nothing in `src/`
 * knows it exists.
 *
 * It exists because the alternative is worse. Left pointing at a dead port, the
 * OCR worker fails every extraction on a refused connection: the job "completes"
 * in a millisecond, the flow moves on with "extraction failed; needs a manual
 * check", and the OCR pool at concurrency 3 is never actually occupied. That
 * measures nothing. Extraction is the slowest thing the application does and the
 * only work that holds a queue slot for seconds at a time, so a load test that
 * skips it is not testing the document path at all.
 *
 * Three routes, matching `ROUTES` in `ocr/veris.ts`:
 *
 *   POST /v1/passport/extract   MRZ + check digits
 *   POST /v1/resume/extract     structured CV fields
 *   POST /v1/aadhaar/extract    named Aadhaar fields
 *
 * The payloads are shaped for the normalisers that read them, so an extraction
 * produces real profile fields and the flow advances the way it would in
 * production rather than limping forward on a failure path.
 *
 *   PORT                  default 8789
 *   MOCK_OCR_MIN_MS       default 1500
 *   MOCK_OCR_MAX_MS       default 4000
 *   MOCK_OCR_FAIL_RATE    0..1, default 0 — share answered 500
 */

import http from 'node:http';
import {
  handleJobsRoute,
  jobsCounters,
  jobsState,
  resetJobsMock,
} from '../../src/testing/verisJobsMock.js';

const PORT = Number(process.env.PORT ?? 8789);

const tuning = {
  minMs: Number(process.env.MOCK_OCR_MIN_MS ?? 1500),
  maxMs: Number(process.env.MOCK_OCR_MAX_MS ?? 4000),
  failRate: Number(process.env.MOCK_OCR_FAIL_RATE ?? 0),
};

const counters = {
  total: 0,
  active: 0,
  completed: 0,
  errors: 0,
  maxConcurrent: 0,
  bytesReceived: 0,
  byRoute: {} as Record<string, number>,
  latencyMs: [] as number[],
};

let sequence = 0;

/** Evenly spaced rather than random, so two runs fail at the same points. */
function shouldFail(n: number): boolean {
  const r = tuning.failRate;
  if (r <= 0) return false;
  if (r >= 1) return true;
  return Math.floor(n * r) > Math.floor((n - 1) * r);
}

function latencyFor(n: number): number {
  if (tuning.maxMs <= tuning.minMs) return tuning.minMs;
  return tuning.minMs + ((n * 7919) % (tuning.maxMs - tuning.minMs));
}

/* ------------------------------------------------------------------ */
/* Payloads, shaped for the normalisers in ocr/veris.ts                */
/* ------------------------------------------------------------------ */

/**
 * Shaped from a real production response, observed via
 * `loadtest/tools/live-jobs-probe.ts` rather than assumed.
 *
 * Two things here were wrong before and both hid real behaviour:
 *
 *   - extracted fields are keyed `label`, not `key`. `fromExtractedFields`
 *     reads `f.label`, so every field this mock produced normalised to the key
 *     "unknown" — a load test could not have noticed a field mapping break.
 *   - MRZ dates are ISO `YYYY-MM-DD` (OpenAPI `MRZData`: `format: date`), and
 *     the given-name key is `given_names`, not `given_name`.
 */
const passportPayload = () => ({
  request_id: 'req_mock_passport',
  confidence: 0.94,
  mrz_source: 'mrz',
  raw_mrz:
    'P<INDKUMARI<<ASHA<<<<<<<<<<<<<<<<<<<<<<<<<<<' +
    String.fromCharCode(10) +
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
  processing_time_ms: 1840,
  warnings: [],
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
  pages: [
    {
      page_number: 1,
      text: 'REPUBLIC OF INDIA PASSPORT Type P Country Code IND Passport No. Z1234567 KUMARI ASHA',
      html: '',
      language: 'eng',
      width: 992,
      height: 1403,
      average_confidence: 0.94,
      processing_time_ms: 1620,
    },
  ],
});

const resumePayload = () => ({
  name: 'Asha Kumari',
  designation: 'Senior Welder',
  industry: 'Construction & Engineering',
  highest_qualification: 'Diploma in Mechanical Engineering',
  total_experience_years: 10.2,
  total_experience_human: '10 years 3 months',
  contact: { address: 'Chennai, Tamil Nadu' },
  personal_info: {
    date_of_birth: '1994-03-14',
    gender: 'female',
    nationality: 'Indian',
    father_name: 'Ramesh Kumar',
  },
  passport_details: { passport_number: 'Z1234567', date_of_expiry: '2031-05-11' },
  certifications: ['TIG welding certificate'],
  machinery: ['TIG welder', 'MIG welder'],
  warnings: [],
});

const aadhaarPayload = () => ({
  confidence: 0.95,
  aadhaar: {
    name: 'Asha Kumari',
    aadhaar_number: '2345 6789 0123',
    date_of_birth: '1994-03-14',
    year_of_birth: '1994',
    gender: 'female',
    address: '14 Bharathi Street, Tiruchirappalli, Tamil Nadu',
  },
  pages: [{ page_number: 1, average_confidence: 0.95 }],
  warnings: [],
});

function payloadFor(route: string): unknown {
  if (route.includes('passport')) return passportPayload();
  if (route.includes('aadhaar')) return aadhaarPayload();
  return resumePayload();
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/__stats') {
    const sorted = [...counters.latencyMs].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : 0;
    send(res, 200, {
      ...counters,
      latencyMs: undefined,
      latency: { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 },
      jobs: jobsCounters,
      jobsState,
      tuning,
    });
    return;
  }

  if (url.pathname === '/__reset' && req.method === 'POST') {
    counters.total = 0;
    counters.completed = 0;
    counters.errors = 0;
    counters.maxConcurrent = 0;
    counters.bytesReceived = 0;
    counters.byRoute = {};
    counters.latencyMs = [];
    resetJobsMock();
    send(res, 200, { ok: true });
    return;
  }

  // Runtime tuning, so a test can ask for queue-full or a longer progression
  // without restarting the mock.
  if (url.pathname === '/__config' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(raw || '{}') as Record<string, unknown>;
        if ('queueFull' in patch) jobsState.queueFull = !!patch.queueFull;
        if (typeof patch.queuedPolls === 'number') jobsState.queuedPolls = patch.queuedPolls;
        if (typeof patch.runningPolls === 'number') jobsState.runningPolls = patch.runningPolls;
        Object.assign(tuning, patch);
      } catch {
        /* keep the current tuning */
      }
      send(res, 200, { tuning, jobsState });
    });
    return;
  }

  // The async Jobs API, which is what the deployed service actually offers.
  if (handleJobsRoute(req, res, url.pathname)) return;

  if (url.pathname === '/v1/health') {
    send(res, 200, { ok: true });
    return;
  }

  if (!url.pathname.endsWith('/extract')) {
    send(res, 404, { error: url.pathname });
    return;
  }

  const route = url.pathname;
  const n = ++counters.total;
  counters.active += 1;
  counters.maxConcurrent = Math.max(counters.maxConcurrent, counters.active);
  counters.byRoute[route] = (counters.byRoute[route] ?? 0) + 1;

  // The multipart body is drained rather than parsed. What matters here is that
  // the bytes actually crossed the socket, and how many.
  let received = 0;
  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
  });

  req.on('end', () => {
    const startedAt = Date.now();
    counters.bytesReceived += received;
    sequence += 1;

    setTimeout(() => {
      counters.active -= 1;
      counters.latencyMs.push(Date.now() - startedAt);

      if (shouldFail(n)) {
        counters.errors += 1;
        send(res, 500, { error: 'mock ocr: extraction failed' });
        return;
      }

      counters.completed += 1;
      send(res, 200, payloadFor(route));
    }, latencyFor(n));
  });
});

server.keepAliveTimeout = 130_000;
server.headersTimeout = 135_000;
server.requestTimeout = 0;

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `mock veris ocr on http://127.0.0.1:${PORT}  latency ${tuning.minMs}-${tuning.maxMs}ms  fail ${tuning.failRate}`,
  );
});
