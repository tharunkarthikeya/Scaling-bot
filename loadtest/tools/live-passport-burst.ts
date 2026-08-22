/**
 * A concurrent burst of real passport documents against the live Veris Jobs API.
 *
 * Explicitly authorised. Two things follow from these being real documents and
 * are not negotiable in the reporting:
 *
 *   - No extracted value is ever printed. Not a name, not a passport number,
 *     not an MRZ line, not a field value. Only counts, formats, confidences and
 *     verdicts leave this script.
 *   - The fetch guard allows exactly one host, so a stray call anywhere else
 *     fails loudly rather than quietly leaving the machine.
 *
 * It also answers the question the synthetic fixture could not: whether real
 * passport scans clear the 0.85 `keepExtraction` threshold.
 *
 *   LOADTEST_ALLOW_HOST=veriis.adiragroups.com npx tsx loadtest/tools/live-passport-burst.ts <dir>
 */

import fs from 'node:fs';
import path from 'node:path';

const HOST = process.env.LOADTEST_ALLOW_HOST ?? '';
if (!HOST) {
  console.error('Refusing to run: LOADTEST_ALLOW_HOST is not set.');
  process.exit(1);
}

const DIR = process.argv[2] ?? '';
if (!DIR || !fs.existsSync(DIR)) {
  console.error(`Refusing to run: directory not found: ${JSON.stringify(DIR)}`);
  process.exit(1);
}

import { installFetchGuard } from '../rig/guard.js';
const guard = installFetchGuard({ onOutbound: () => undefined });

const { config } = await import('../../src/config.js');
const jobs = await import('../../src/ocr/jobs.js');
const { inspectUpload, normaliseExtractionForTests } = await import('../../src/ocr/veris.js');

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const files = fs
  .readdirSync(DIR)
  .filter((f) => MIME[path.extname(f).toLowerCase()])
  .map((f) => {
    const full = path.join(DIR, f);
    const ext = path.extname(f).toLowerCase();
    return { name: f, ext, mime: MIME[ext]!, buffer: fs.readFileSync(full) };
  });

const totalBytes = files.reduce((n, f) => n + f.buffer.byteLength, 0);
const byExt: Record<string, number> = {};
for (const f of files) byExt[f.ext] = (byExt[f.ext] ?? 0) + 1;

console.log(`
PREFLIGHT
  target host     ${HOST}
  base url        ${config.VERIS_OCR_BASE_URL}
  directory       ${DIR}
  files           ${files.length}   ${JSON.stringify(byExt)}
  total bytes     ${(totalBytes / 1024 / 1024).toFixed(2)} MB
  largest         ${(Math.max(...files.map((f) => f.buffer.byteLength)) / 1024 / 1024).toFixed(2)} MB
  mode            ALL SUBMITTED SIMULTANEOUSLY
  reporting       aggregates only - no extracted value is printed
`);

interface Row {
  idx: number;
  ext: string;
  bytes: number;
  inspectReadable: boolean;
  inspectPages?: number;
  submitStatus: 'accepted' | 'queue_full' | 'error';
  submitError?: string;
  jobStatus?: string;
  polls: number;
  confidence?: number | null;
  mrzSource?: string;
  checkDigitsValid?: boolean;
  fieldCount?: number;
  complete?: boolean;
  verdict?: string;
  keepExtraction?: boolean;
  expiryFormat?: string;
  errorCode?: string;
}

/**
 * Distinguishes one burst from the next.
 *
 * The key used to be derived from index and byte size alone, which made it
 * stable across runs — so a second burst came back as 56 `duplicate: true`
 * replays in 35s, having done no extraction at all, and reported the first
 * run's numbers as though they were fresh. Set `BURST_RUN_ID` to repeat a
 * specific run deliberately; otherwise every launch is its own.
 */
const RUN_ID = process.env.BURST_RUN_ID ?? String(Date.now());

/* ------------------------------------------------------------------ */
/* Worker saturation sampling                                          */
/* ------------------------------------------------------------------ */

/**
 * `GET /v1/jobs/stats` -> `JobQueueStats`, sampled while the burst runs.
 *
 * This is the only honest answer to "what is the CPU doing": the service
 * reports its own CPU-worker depth and slot count, and nothing observable from
 * this side does. `cpu` is the number of jobs on the CPU queue and
 * `cpu_worker_slots` is how many can run at once, so `cpu / cpu_worker_slots`
 * is the saturation ratio and `oldest_active_seconds` is how far behind the
 * front of the queue has fallen.
 *
 * Sampling is cheap and read-only. It adds one small GET per interval, which is
 * counted separately below so it cannot be confused with extraction traffic.
 */
interface StatSample {
  t: number;
  cpu: number;
  cpuSlots: number;
  resume: number;
  resumeSlots: number;
  queued: number;
  running: number;
  delayed: number;
  failed: number;
  oldestActiveSeconds: number | null;
}

const samples: StatSample[] = [];
let statPolls = 0;
let statErrors = 0;

async function sampleStats(): Promise<void> {
  try {
    const res = await fetch(`${config.VERIS_OCR_BASE_URL.replace(/\/$/, '')}/v1/jobs/stats`, {
      headers: { 'X-API-Key': config.VERIS_OCR_API_KEY },
      signal: AbortSignal.timeout(15_000),
    });
    statPolls += 1;
    if (!res.ok) {
      statErrors += 1;
      return;
    }
    const s = (await res.json()) as any;
    samples.push({
      t: Date.now(),
      cpu: s.cpu ?? 0,
      cpuSlots: s.cpu_worker_slots ?? 0,
      resume: s.resume ?? 0,
      resumeSlots: s.resume_worker_slots ?? 0,
      queued: s.queued ?? 0,
      running: s.running ?? 0,
      delayed: s.delayed ?? 0,
      failed: s.failed ?? 0,
      oldestActiveSeconds: s.oldest_active_seconds ?? null,
    });
  } catch {
    statErrors += 1;
  }
}

const rows: Row[] = [];
const started = Date.now();

// A baseline before any of our load lands, so the burst's contribution can be
// separated from whatever the service was already carrying.
await sampleStats();
const baseline = samples[0];

const statTimer = setInterval(() => void sampleStats(), 2000);
statTimer.unref();

/* ------------------------------------------------------------------ */
/* Submit every file at once                                           */
/* ------------------------------------------------------------------ */

console.log('=== submitting all ' + files.length + ' simultaneously ===');

const submissions = await Promise.all(
  files.map(async (f, idx) => {
    const inspection = inspectUpload(f.buffer, f.mime, { countPages: true });
    const row: Row = {
      idx,
      ext: f.ext,
      bytes: f.buffer.byteLength,
      inspectReadable: inspection.readable,
      inspectPages: inspection.pages,
      submitStatus: 'error',
      polls: 0,
    };

    try {
      const accepted = await jobs.submitOcrJob({
        mode: 'passport',
        buffer: f.buffer,
        filename: `doc-${idx}${f.ext}`,
        mimeType: f.mime,
        idempotencyKey: `burst/${RUN_ID}/passport/${idx}/${f.buffer.byteLength}`,
      });
      row.submitStatus = 'accepted';
      rows.push(row);
      return { row, accepted };
    } catch (err: any) {
      row.submitStatus = err?.constructor?.name === 'JobQueueFullError' ? 'queue_full' : 'error';
      row.submitError = `${err?.constructor?.name}: ${String(err?.message).slice(0, 120)}`;
      rows.push(row);
      return { row, accepted: undefined };
    }
  }),
);

const accepted = submissions.filter((s) => s.accepted);
console.log(`  accepted ${accepted.length} / ${files.length}   in ${Date.now() - started}ms`);
const qf = rows.filter((r) => r.submitStatus === 'queue_full').length;
const errs = rows.filter((r) => r.submitStatus === 'error').length;
if (qf) console.log(`  queue-full rejections: ${qf}  (backpressure, not document loss)`);
if (errs) console.log(`  submission errors    : ${errs}`);

/* ------------------------------------------------------------------ */
/* Poll each to terminal                                               */
/* ------------------------------------------------------------------ */

console.log('\n=== polling to terminal ===');

const DEADLINE = Date.now() + 15 * 60 * 1000;

await Promise.all(
  accepted.map(async ({ row, accepted: acc }) => {
    let delay = 3000;
    while (Date.now() < DEADLINE) {
      await new Promise((r) => setTimeout(r, delay));
      let polled: any;
      try {
        polled = await jobs.pollOcrJob(acc!.status_url);
      } catch (err: any) {
        row.jobStatus = 'poll_error';
        row.submitError = String(err?.message).slice(0, 120);
        return;
      }
      row.polls += 1;
      const job = polled.job;
      delay = jobs.nextPollDelayMs({ job, retryAfterMs: polled.retryAfterMs, previousDelayMs: delay });

      if (job.status === 'succeeded' || job.status === 'failed') {
        row.jobStatus = job.status;
        if (job.status === 'failed') {
          row.errorCode = job.error?.code ?? 'unknown';
          return;
        }

        const inspection = {
          readable: row.inspectReadable,
          ...(row.inspectPages !== undefined ? { pages: row.inspectPages } : {}),
        };
        const o = normaliseExtractionForTests('passport', job.result, 'passport', inspection);
        const mrz = (job.result as any)?.mrz ?? {};

        row.confidence = o.confidence;
        row.mrzSource = (job.result as any)?.mrz_source;
        row.checkDigitsValid = mrz.all_check_digits_valid === true;
        row.fieldCount = o.fields.length;
        row.complete = o.completeness.complete;
        row.verdict = o.completeness.verdict;
        row.keepExtraction = o.completeness.complete;
        const e = mrz.expiry_date;
        row.expiryFormat =
          e == null ? 'null' : /^\d{4}-\d{2}-\d{2}$/.test(String(e)) ? 'ISO' : /^\d{6}$/.test(String(e)) ? 'YYMMDD' : 'OTHER';
        return;
      }
    }
    row.jobStatus = 'timeout';
  }),
);

/* ------------------------------------------------------------------ */
/* Aggregate report - counts only                                      */
/* ------------------------------------------------------------------ */

clearInterval(statTimer);
await sampleStats();

const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const peak = <K extends keyof StatSample>(k: K): number =>
  samples.length ? Math.max(...samples.map((s) => Number(s[k] ?? 0))) : 0;

const cpuSlots = peak('cpuSlots');
const peakCpu = peak('cpu');
const saturation = cpuSlots > 0 ? ((peakCpu / cpuSlots) * 100).toFixed(0) + '%' : 'n/a';

const timeline = samples
  .map((s) => {
    const at = ((s.t - started) / 1000).toFixed(0).padStart(4);
    const bar = '#'.repeat(Math.min(40, cpuSlots > 0 ? Math.round((s.cpu / cpuSlots) * 20) : 0));
    return (
      `  t+${at}s  cpu=${String(s.cpu).padStart(3)}/${String(s.cpuSlots).padEnd(3)}` +
      ` queued=${String(s.queued).padStart(3)} running=${String(s.running).padStart(3)}` +
      ` delayed=${String(s.delayed).padStart(3)} oldest=${s.oldestActiveSeconds ?? '-'}s ${bar}`
    );
  })
  .join('\n');

console.log(`
=== VERIS WORKER SATURATION (GET /v1/jobs/stats, sampled every 2s) ===

  samples / poll errors  ${samples.length} / ${statErrors}   (${statPolls} stat requests, excluded from job traffic)
  cpu worker slots       ${cpuSlots}
  baseline cpu depth     ${baseline ? `${baseline.cpu} (queued=${baseline.queued} running=${baseline.running})` : 'not captured'}
  PEAK cpu queue depth   ${peakCpu}
  PEAK saturation        ${saturation}  (peak cpu depth / worker slots)
  peak queued/running    ${peak('queued')} / ${peak('running')}
  peak delayed           ${peak('delayed')}
  peak oldest active     ${peak('oldestActiveSeconds')}s
  failed (service-wide)  ${peak('failed')}

TIMELINE
${timeline || '  (no samples)'}
`);
const done = rows.filter((r) => r.jobStatus === 'succeeded');
const failed = rows.filter((r) => r.jobStatus === 'failed');
const timedOut = rows.filter((r) => r.jobStatus === 'timeout' || r.jobStatus === 'poll_error');

const tally = (xs: Array<string | undefined>) => {
  const m: Record<string, number> = {};
  for (const x of xs) m[x ?? 'n/a'] = (m[x ?? 'n/a'] ?? 0) + 1;
  return m;
};

const confs = done.map((r) => r.confidence).filter((c): c is number => typeof c === 'number');
const sorted = [...confs].sort((a, b) => a - b);
const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0);

console.log(`
=== RESULTS (${elapsed}s) ===

SUBMISSION
  files submitted        ${files.length}
  accepted (202)         ${accepted.length}
  queue-full             ${qf}
  submit errors          ${errs}

TERMINAL
  succeeded              ${done.length}
  failed                 ${failed.length}
  timeout / poll error   ${timedOut.length}
  total polls            ${rows.reduce((n, r) => n + r.polls, 0)}
  failure codes          ${JSON.stringify(tally(failed.map((r) => r.errorCode)))}

INSPECTION (local, before submit)
  readable               ${rows.filter((r) => r.inspectReadable).length} / ${rows.length}
  page counts            ${JSON.stringify(tally(rows.map((r) => String(r.inspectPages))))}

CONFIDENCE  (threshold 0.85)
  n                      ${confs.length}
  min / p25 / p50        ${sorted[0]?.toFixed(2) ?? '-'} / ${pct(0.25).toFixed(2)} / ${pct(0.5).toFixed(2)}
  p75 / p95 / max        ${pct(0.75).toFixed(2)} / ${pct(0.95).toFixed(2)} / ${sorted.at(-1)?.toFixed(2) ?? '-'}
  >= 0.85                ${confs.filter((c) => c >= 0.85).length} / ${confs.length}
  <  0.85                ${confs.filter((c) => c < 0.85).length} / ${confs.length}

EXTRACTION QUALITY
  mrz_source             ${JSON.stringify(tally(done.map((r) => r.mrzSource)))}
  check digits valid     ${done.filter((r) => r.checkDigitsValid).length} / ${done.length}
  expiry date format     ${JSON.stringify(tally(done.map((r) => r.expiryFormat)))}
  completeness verdict   ${JSON.stringify(tally(done.map((r) => r.verdict)))}
  complete = true        ${done.filter((r) => r.complete).length} / ${done.length}
  keepExtraction = true  ${done.filter((r) => r.keepExtraction).length} / ${done.length}
  fields (avg)           ${done.length ? (done.reduce((n, r) => n + (r.fieldCount ?? 0), 0) / done.length).toFixed(1) : '-'}

BY FORMAT
${Object.keys(byExt)
  .map((ext) => {
    const g = done.filter((r) => r.ext === ext);
    const gc = g.map((r) => r.confidence).filter((c): c is number => typeof c === 'number');
    const avg = gc.length ? (gc.reduce((a, b) => a + b, 0) / gc.length).toFixed(2) : '-';
    return `  ${ext.padEnd(6)} submitted=${rows.filter((r) => r.ext === ext).length} succeeded=${g.length} avgConfidence=${avg} >=0.85=${gc.filter((c) => c >= 0.85).length}`;
  })
  .join('\n')}

GUARD
  external requests      ${guard.stats().externalRequests}  (all to ${HOST})
  blocked                ${guard.stats().blocked}
`);
