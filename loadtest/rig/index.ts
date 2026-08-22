/**
 * The application under test, isolated.
 *
 * This is `src/index.ts` composed the same way production composes it — same
 * modules, same queue registrations, same concurrency read from the same config
 * — with three things wrapped around it that production does not have: a fetch
 * guard so nothing leaves the machine, instrumentation for the numbers the app
 * does not take of itself, and a control server on its own port so measuring
 * the app does not mean loading it.
 *
 * Nothing in `src/` is modified. Everything here is composition and wrapping.
 *
 * Two ports, and the split matters. The app is on APP_PORT and every request to
 * it counts as load. The control server is on APP_PORT + 1, is a separate
 * `http.Server` on a separate listener, and is where the generator reads replies
 * and metrics — so the side channel never appears in the measurement.
 *
 *   npm run loadtest:rig
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installFetchGuard, type OutboundRecord } from './guard.js';
import {
  Histogram,
  instrumentQueue,
  summarise,
  watchEventLoopLag,
  watchProcess,
} from './instrument.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADTEST_DIR = path.resolve(HERE, '..');

const APP_PORT = Number(process.env.APP_PORT ?? 3100);
const CONTROL_PORT = APP_PORT + 1;
const MOCK_URL = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:8788';

/* ------------------------------------------------------------------ */
/* Isolation, asserted before anything is imported                     */
/* ------------------------------------------------------------------ */

/**
 * `container` — the compose mongod on 127.0.0.1:27018. What the real runs should
 *               use: it is a separate process with its own CPU and memory caps,
 *               so the database cannot quietly become the bottleneck being
 *               measured, and the numbers are comparable to production.
 * `memory`    — `mongodb-memory-server`, the same one `harness.ts` boots. For
 *               machines without Docker. Honest but not equivalent: mongod is
 *               uncapped and competing for the same cores as the application,
 *               so treat capacity numbers from this mode as a floor.
 * `auto`      — try the container, fall back to memory and say so. The default.
 */
const MONGO_MODE = (process.env.LOADTEST_MONGO ?? 'auto') as 'auto' | 'container' | 'memory';
const CONTAINER_URI = process.env.LOADTEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const MONGO_DB = process.env.LOADTEST_MONGODB_DB ?? 'adira_loadtest';

/** Resolved below; the isolation assertion runs against whatever wins. */
let MONGO_URI = CONTAINER_URI;
let mongoKind = MONGO_MODE;
let memoryServer: { stop: () => Promise<unknown> } | undefined;

async function reachable(uri: string): Promise<boolean> {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (MONGO_MODE !== 'memory') {
  if (await reachable(CONTAINER_URI)) {
    mongoKind = 'container';
  } else if (MONGO_MODE === 'container') {
    throw new Error(
      'loadtest: LOADTEST_MONGO=container but nothing is answering on 127.0.0.1:27018. ' +
        'Start it with:  npm run loadtest:mongo',
    );
  } else {
    mongoKind = 'memory';
  }
}

if (mongoKind === 'memory') {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const server = await MongoMemoryServer.create();
  memoryServer = server;
  MONGO_URI = server.getUri();
}

/**
 * Refuses to start against anything that is not a local database.
 *
 * A load test that writes to the production database is not a load test, it is
 * an incident, and the difference between the two is one environment variable
 * somebody forgot to change. This is the check that makes that mistake
 * impossible rather than unlikely.
 */
function assertLocalMongo(uri: string): void {
  let host: string;
  try {
    host = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname;
  } catch {
    throw new Error(`loadtest: could not parse LOADTEST_MONGODB_URI`);
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(
      `loadtest: refusing to run against a non-local MongoDB (${host}). ` +
        'Point LOADTEST_MONGODB_URI at the compose container on 127.0.0.1:27018.',
    );
  }
  if (/adira(_prod|_production)?$/.test(MONGO_DB) && MONGO_DB !== 'adira_loadtest') {
    throw new Error(`loadtest: refusing to use database name "${MONGO_DB}"`);
  }
}

assertLocalMongo(MONGO_URI);


/* ------------------------------------------------------------------ */
/* Environment, set before `config` is first imported                  */
/* ------------------------------------------------------------------ */

// dotenv does not overwrite what is already set, so these win over .env — which
// is what keeps the production values in .env from reaching this process.
process.env.MONGODB_URI = MONGO_URI;
process.env.MONGODB_DB = MONGO_DB;

// The application talks to the mock over real HTTP. The SDK reads this variable
// in its own constructor, so no application code has to know about it.
process.env.ANTHROPIC_BASE_URL = MOCK_URL;
process.env.ANTHROPIC_API_KEY = 'loadtest-not-a-real-key';

// Left OFF deliberately. Shadow mode returns before `budgets.replies.acquire()`,
// so switching it on would remove the 20/sec reply limiter from the measurement
// — the single most important thing this rig exists to observe. Graph is stubbed
// at the socket instead, by the fetch guard.
process.env.SHADOW_MODE = 'false';

// OFF, deliberately, and this is the whole of the document path being real.
// `MOCK_WHATSAPP_MEDIA=true` returns a canned buffer from the first line of
// `downloadMedia`, before the media rate limiter, before the `file_size` check,
// before `Content-Length`, and before the streaming byte counter. With it off,
// the guard answers Meta's two hops instead and every one of those runs.
process.env.MOCK_WHATSAPP_MEDIA = 'false';

// The mock OCR service. Pointing this at a dead port instead would fail every
// extraction on a refused connection in about a millisecond, which leaves the
// OCR pool idle and measures nothing.
//
// `LOADTEST_REAL_VERIS=true` leaves both alone so `.env` supplies the live
// service, and the host has to be named in `LOADTEST_ALLOW_HOST` as well before
// the guard will let a byte out. Two switches, both explicit, because this is
// the one configuration in which the rig stops being isolated.
if (process.env.LOADTEST_REAL_VERIS !== 'true') {
  process.env.VERIS_OCR_BASE_URL = process.env.LOADTEST_VERIS_URL ?? 'http://127.0.0.1:8789';
  process.env.VERIS_OCR_API_KEY = 'loadtest-not-a-real-key';
}

// The async Jobs API, which is the transport the deployed service actually
// offers and the one this rig exists to measure.
//
// Set here rather than left to `.env` because the application default is
// `false`: without this line the rig submits to the synchronous `/extract`
// routes, every number it reports describes the old transport, and nothing in
// the output says so. A sync run reported as an async one is the specific
// failure this is written to prevent — see the assertion after `config` loads.
//
// `LOADTEST_SYNC_OCR=true` opts back out, for comparing the two transports
// deliberately rather than by accident.
process.env.VERIS_OCR_ASYNC = process.env.LOADTEST_SYNC_OCR === 'true' ? 'false' : 'true';

// Pointed at a dead loopback port rather than deleted.
//
// Deleting was wrong and the rig proved it: `config.ts` loads dotenv, dotenv
// fills in anything *absent*, and `.env` carries a CRM_API_URL — so unsetting
// the variable here handed the value straight back and `crmConfigured()` was
// true. Every completed registration then attempted a real CRM call. Nothing
// escaped, because the value in `.env` is itself a localhost address and the
// guard would have refused a remote one, but the rig was claiming an isolation
// it did not have.
//
// Setting the variable is what actually wins: dotenv does not overwrite. Port 1
// on loopback refuses instantly, so `crm_sync` runs its real path and fails
// locally in microseconds. Those failures are expected and are reported as
// such; the cost of a real CRM call is not represented in these numbers.
process.env.CRM_API_URL = 'http://127.0.0.1:1/loadtest-crm-unreachable';
process.env.CRM_API_KEY = 'loadtest-not-a-real-key';

// Credentials that exist only for this process. The generator reads the secret
// from the runtime file, so the real app secret is never needed to sign a
// load-test webhook and never enters this environment.
const APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_ACCESS_TOKEN = 'loadtest-not-a-real-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '000000000000000';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'loadtest-verify';
process.env.WHATSAPP_WABA_ID = 'LOADTEST_WABA';

process.env.STORAGE_PATH = path.join(LOADTEST_DIR, '.storage');
process.env.LOG_LEVEL = process.env.LOADTEST_LOG_LEVEL ?? 'error';
process.env.PORT = String(APP_PORT);
process.env.NODE_ENV = 'production';

/* ------------------------------------------------------------------ */
/* The guard goes on before anything can call out                      */
/* ------------------------------------------------------------------ */

const outbound: OutboundRecord[] = [];
const byCandidate = new Map<string, OutboundRecord[]>();
let outboundSeq = 0;
/** Resolvers for generators long-polling for a reply that has not landed yet. */
const waiters = new Map<string, Array<() => void>>();

/**
 * The documents the rig serves, built once from the project's own fixtures.
 *
 * Imported, not copied: these are the same PDFs the harness uses, so the OCR
 * path sees a real PDF with a real MRZ band and `inspectUpload`'s byte scan has
 * something true to scan. The media id carries the kind, so serving is
 * stateless — no map to keep, nothing to clean up between runs.
 *
 * `oversize` is built at 12 MB, past `MEDIA_MAX_BYTES`. It is only served when
 * a media id asks for it, which the generator does not do unless told to, so it
 * sits unused in a normal run and is there to prove the refusal path on demand.
 */
const { SAMPLE_PASSPORT_PDF, SAMPLE_AADHAAR_PDF, SAMPLE_RESUME_PDF } = await import(
  '../../src/testing/fixtures.js'
);

const DOCUMENTS: Record<string, Buffer> = {
  cv: SAMPLE_RESUME_PDF('loadtest'),
  passport: SAMPLE_PASSPORT_PDF(),
  aadhaar: SAMPLE_AADHAAR_PDF(),
  pan: SAMPLE_RESUME_PDF('loadtest-pan'),
  oversize: Buffer.concat([
    Buffer.from('%PDF-1.7 ', 'latin1'),
    Buffer.alloc(12 * 1024 * 1024, 0x41),
    Buffer.from(' %%EOF', 'latin1'),
  ]),
};

/** `MEDIA-<waId>-<n>-<kind>` — the kind is the last segment. */
function kindOf(mediaId: string): string | undefined {
  const kind = mediaId.split('-').pop() ?? '';
  return kind in DOCUMENTS ? kind : undefined;
}

const mediaStats = {
  lookups: 0,
  served: 0,
  bytesServed: 0,
  refusedTooLarge: 0,
  oversizeOffered: 0,
};

const guard = installFetchGuard({
  media: {
    describe: (mediaId) => {
      const kind = kindOf(mediaId);
      if (!kind) return undefined;
      mediaStats.lookups += 1;
      if (kind === 'oversize') mediaStats.oversizeOffered += 1;
      return { byteSize: DOCUMENTS[kind]!.byteLength, mimeType: 'application/pdf' };
    },
    urlFor: (mediaId) => `http://127.0.0.1:${CONTROL_PORT}/media/${mediaId}`,
  },
  onOutbound: (record) => {
    const full: OutboundRecord = { ...record, seq: ++outboundSeq };
    outbound.push(full);
    const list = byCandidate.get(full.waId) ?? [];
    list.push(full);
    byCandidate.set(full.waId, list);

    const pending = waiters.get(full.waId);
    if (pending?.length) {
      waiters.set(full.waId, []);
      for (const wake of pending) wake();
    }
  },
});

/* ------------------------------------------------------------------ */
/* The application, composed as production composes it                 */
/* ------------------------------------------------------------------ */

const { config } = await import('../../src/config.js');
const { connectDb, closeDb } = await import('../../src/db/client.js');
const { ensureIndexes, candidates, turnsFor } = await import('../../src/db/models.js');
const { ensureStorageRoot } = await import('../../src/storage/index.js');
const { queue, withCandidateLock } = await import('../../src/queue/index.js');
const { handleInboundMessage } = await import('../../src/conversation/engine.js');
const { processOcrJob, sweepRunningExtractions } = await import('../../src/ocr/veris.js');
const { syncCandidateToCrm } = await import('../../src/crm/sync.js');
const { buildServer } = await import('../../src/server.js');
const { validateCopy } = await import('../../src/conversation/validate.js');
const { modelStats, resetModelStatsForTests } = await import('../../src/conversation/model.js');

/**
 * The transport the run will actually measure, checked against what it claims.
 *
 * Read off the resolved `config`, not off `process.env`, because those are two
 * different questions: the variable can be set and still not be what the
 * application resolved — dotenv precedence, a coercion that fell back to the
 * default, an import ordering that read the value before the rig wrote it. Only
 * `config` says what the code under test will do.
 *
 * This is a hard stop rather than a warning. A sync run mistaken for an async
 * one does not look wrong: the flow completes, the documents extract, the
 * numbers are plausible, and the conclusion drawn from them — that the async
 * Jobs API holds up under load — would be about code that never executed.
 */
if (process.env.LOADTEST_SYNC_OCR === 'true') {
  console.log(
    '\n  OCR transport: SYNCHRONOUS /extract routes (LOADTEST_SYNC_OCR=true).\n' +
      '  This run does NOT exercise the async Jobs API.\n',
  );
} else if (config.VERIS_OCR_ASYNC !== true) {
  console.error(
    '\nRefusing to run: VERIS_OCR_ASYNC did not resolve to true.\n' +
      `  process.env.VERIS_OCR_ASYNC = ${JSON.stringify(process.env.VERIS_OCR_ASYNC)}\n` +
      `  config.VERIS_OCR_ASYNC      = ${JSON.stringify(config.VERIS_OCR_ASYNC)}\n\n` +
      'The rig sets this before importing config, so a mismatch means the value\n' +
      'was overridden or read too early. Running on would exercise the synchronous\n' +
      'path and report it as an async load test.\n\n' +
      'To test the sync transport on purpose, set LOADTEST_SYNC_OCR=true.\n',
  );
  process.exit(1);
} else {
  console.log('\n  OCR transport: ASYNC Jobs API (config.VERIS_OCR_ASYNC=true)\n');
}

validateCopy();

await connectDb();
await ensureIndexes();
await ensureStorageRoot();

// A clean database every run, so a number is about this run and not the last.
const dropped = await candidates().countDocuments();
if (process.env.LOADTEST_KEEP_DB !== 'true') {
  const { getDb } = await import('../../src/db/client.js');
  await getDb().dropDatabase();
  await ensureIndexes();
}

const instrumented = instrumentQueue(queue as never);

// The registrations `src/index.ts` makes, with the concurrency it reads from the
// same config. Not numbers written here — the point is to measure what
// production is set to, so they are taken from where production takes them.
queue.register(
  'inbound_message',
  (payload) => withCandidateLock(payload.waId, () => handleInboundMessage(payload)),
  config.QUEUE_CONCURRENCY_INBOUND,
);
queue.register('ocr', processOcrJob, config.QUEUE_CONCURRENCY_OCR);
queue.register('crm_sync', syncCandidateToCrm, config.QUEUE_CONCURRENCY_CRM_SYNC);

await queue.start();

const app = await buildServer();
await app.listen({ port: APP_PORT, host: '0.0.0.0' });

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

const lag = watchEventLoopLag(20);
const proc = watchProcess(500);
/**
 * Peak model-gate occupancy.
 *
 * `modelStats()` reports what is happening right now, and reading it only at the
 * end reports the quiet moment after the run rather than the busy one during it.
 * Sampled alongside queue depth so "peak concurrent Anthropic calls" and "peak
 * model queue depth" are measurements rather than the last value seen.
 */
const modelPeak = { inFlight: 0, waiting: 0 };
const modelSamples: Array<{ inFlight: number; waiting: number }> = [];

const depthTimer = setInterval(() => {
  instrumented.sampleDepth();
  const m = modelStats();
  modelPeak.inFlight = Math.max(modelPeak.inFlight, m.inFlight);
  modelPeak.waiting = Math.max(modelPeak.waiting, m.waiting);
  modelSamples.push({ inFlight: m.inFlight, waiting: m.waiting });
}, 50);
depthTimer.unref();

/**
 * The extraction sweep, exactly as `src/index.ts` runs it in production.
 *
 * Required, not optional, once the async transport is on. `processOcrJob`
 * submits the job and releases its queue slot; from there the upload is with
 * Veris and only the sweep polls it, applies the result and releases the
 * candidate. Without this the rig submits every document, nothing ever reaches
 * a terminal state, and the run reports a document path that silently stalls —
 * with the queue looking healthy, because the slot was handed back on time.
 *
 * `sweepRunningExtractions` returns immediately when the flag is off, so this
 * costs a `LOADTEST_SYNC_OCR=true` run nothing.
 */
const ocrSweepTimer = setInterval(() => {
  void sweepRunningExtractions().catch(() => undefined);
}, config.OCR_SWEEP_INTERVAL_MS);
ocrSweepTimer.unref();

/**
 * Server-side operation latency, straight from mongod.
 *
 * `serverStatus().opLatencies` accumulates microseconds and op counts, so the
 * difference across a run gives the average latency mongod itself observed. It
 * is the only honest MongoDB latency available here: measuring it from our side
 * would mean turning on command monitoring where the client is constructed,
 * which is production code.
 */
let mongoBaseline: Record<string, { latency: number; ops: number }> | undefined;

async function opLatencies(): Promise<Record<string, { latency: number; ops: number }> | undefined> {
  try {
    const { getDb } = await import('../../src/db/client.js');
    const status = (await getDb().admin().command({ serverStatus: 1 })) as {
      opLatencies?: Record<string, { latency: number; ops: number }>;
    };
    return status.opLatencies;
  } catch {
    return undefined;
  }
}

function mongoLatencyDelta(
  now: Record<string, { latency: number; ops: number }> | undefined,
): Record<string, { ops: number; avgMs: number }> | null {
  if (!now || !mongoBaseline) return null;
  const out: Record<string, { ops: number; avgMs: number }> = {};
  for (const key of ['reads', 'writes', 'commands']) {
    const a = mongoBaseline[key];
    const b = now[key];
    if (!a || !b) continue;
    const ops = b.ops - a.ops;
    const micros = b.latency - a.latency;
    out[key] = { ops, avgMs: ops > 0 ? Math.round((micros / ops / 1000) * 1000) / 1000 : 0 };
  }
  return out;
}

let mongoErrorCount = 0;
let pendingMongoLatency: Record<string, { ops: number; avgMs: number }> | null = null;
let pendingOcr: Record<string, number> | null = null;

/**
 * What became of every extraction, counted off the stored uploads.
 *
 * The OCR pool's own counters say how many jobs ran; this says what they
 * decided, which is the difference between "three extractions completed" and
 * "three extractions completed and all three failed".
 */
async function ocrOutcomes(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const { storedDocuments } = await import('../../src/db/models.js');
    const rows = await storedDocuments().find({}).toArray();
    for (const row of rows as Array<Record<string, unknown>>) {
      for (const [key, value] of Object.entries(row)) {
        const uploads = (value as { uploads?: Array<{ ocr?: { status?: string } }> })?.uploads;
        if (!Array.isArray(uploads)) continue;
        for (const upload of uploads) {
          const status = upload?.ocr?.status ?? 'none';
          out[`${key}:${status}`] = (out[`${key}:${status}`] ?? 0) + 1;
          out[`total:${status}`] = (out[`total:${status}`] ?? 0) + 1;
        }
      }
    }
  } catch (err) {
    out.error = 1;
  }
  return out;
}
process.on('unhandledRejection', (err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (/Mongo|topology|pool|ECONNREFUSED/i.test(message)) mongoErrorCount += 1;
});

let markAt = Date.now();

function snapshot() {
  const cpu = proc.samples.map((s) => s.cpuPercent);
  const rss = proc.samples.map((s) => s.rssMb);
  const heap = proc.samples.map((s) => s.heapUsedMb);
  const last = proc.samples.at(-1);

  const depth: Record<string, { max: number; avg: number }> = {};
  for (const [name, samples] of Object.entries(instrumented.metrics.depthSamples)) {
    const s = summarise(samples);
    depth[name] = { max: instrumented.metrics.maxDepth[name] ?? 0, avg: s.avg };
  }

  const wait: Record<string, ReturnType<Histogram['summary']>> = {};
  for (const [name, h] of Object.entries(instrumented.metrics.waitMs)) wait[name] = h.summary();
  const run: Record<string, ReturnType<Histogram['summary']>> = {};
  for (const [name, h] of Object.entries(instrumented.metrics.runMs)) run[name] = h.summary();

  const sends = guard.stats().sendTimestamps;
  return {
    elapsedMs: Date.now() - markAt,
    config: {
      inbound: config.QUEUE_CONCURRENCY_INBOUND,
      ocr: config.QUEUE_CONCURRENCY_OCR,
      crmSync: config.QUEUE_CONCURRENCY_CRM_SYNC,
      replyRate: config.OUTBOUND_RATE_PER_SECOND,
      receiptRate: config.READ_RECEIPT_RATE_PER_SECOND,
      mediaRate: config.MEDIA_DOWNLOAD_RATE_PER_SECOND,
      mediaMaxBytes: config.MEDIA_MAX_BYTES,
      modelConcurrency: config.MODEL_MAX_CONCURRENCY,
      modelQueued: config.MODEL_MAX_QUEUED,
      queue: config.REDIS_URL ? 'redis' : 'in-process',
      shadowMode: config.SHADOW_MODE,
    },
    queue: {
      submitted: instrumented.metrics.submitted,
      started: instrumented.metrics.started,
      completed: instrumented.metrics.completed,
      failed: instrumented.metrics.failed,
      depth,
      waitMs: wait,
      runMs: run,
      live: (queue as unknown as { stats?: () => unknown }).stats?.() ?? null,
    },
    model: modelStats(),
    modelGate: {
      peakInFlight: modelPeak.inFlight,
      peakWaiting: modelPeak.waiting,
      samples: modelSamples.length,
      // How much of the run the gate spent completely full.
      secondsAtCapacity:
        Math.round(
          (modelSamples.filter((m) => m.inFlight >= config.MODEL_MAX_CONCURRENCY).length * 0.05) *
            100,
        ) / 100,
    },
    graph: { ...guard.stats(), sendTimestamps: undefined, sends: sends.length },
    replyRate: replyRateSeries(sends),
    eventLoopLagMs: lag.histogram.summary(),
    memory: {
      currentRssMb: last?.rssMb ?? 0,
      currentHeapUsedMb: last?.heapUsedMb ?? 0,
      currentHeapTotalMb: last?.heapTotalMb ?? 0,
      rss: summarise(rss),
      heapUsed: summarise(heap),
    },
    cpuPercentOfOneCore: summarise(cpu),
    cores: 4,
    mongoErrors: mongoErrorCount,
    outboundMessages: outbound.length,
    mongoLatency: pendingMongoLatency,
    media: {
      ...mediaStats,
      limitBytes: config.MEDIA_MAX_BYTES,
      // Every download that got as far as being served was under the limit;
      // anything refused never reached the byte server. The two numbers
      // together are the media-limit result.
      underLimit: mediaStats.served,
    },
    ocr: pendingOcr,
  };
}

/** Replies per whole second, which is what the 20/sec limiter should be pinning. */
function replyRateSeries(timestamps: number[]): {
  perSecond: number[];
  max: number;
  sustainedMax: number;
} {
  if (!timestamps.length) return { perSecond: [], max: 0, sustainedMax: 0 };
  const first = Math.floor(timestamps[0]! / 1000);
  const buckets = new Map<number, number>();
  for (const t of timestamps) {
    const s = Math.floor(t / 1000) - first;
    buckets.set(s, (buckets.get(s) ?? 0) + 1);
  }
  const series: number[] = [];
  const highest = Math.max(...buckets.keys());
  for (let i = 0; i <= highest; i++) series.push(buckets.get(i) ?? 0);

  // The busiest second can catch a partial bucket at either end. Three
  // consecutive seconds is what "sustained" should mean.
  let sustained = 0;
  for (let i = 0; i + 2 < series.length; i++) {
    sustained = Math.max(sustained, Math.min(series[i]!, series[i + 1]!, series[i + 2]!));
  }
  return { perSecond: series, max: Math.max(...series), sustainedMax: sustained };
}

/* ------------------------------------------------------------------ */
/* Control server — its own port, so reading does not add load         */
/* ------------------------------------------------------------------ */

function reply(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const control = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/metrics') {
    pendingMongoLatency = mongoLatencyDelta(await opLatencies());
    pendingOcr = await ocrOutcomes();
    return reply(res, 200, snapshot());
  }

  /** How far each candidate actually got, by flow stage and open question. */
  if (url.pathname === '/stages') {
    const rows = await candidates()
      .find({}, { projection: { waId: 1, stage: 1, currentStep: 1, status: 1 } })
      .toArray();
    const byStage: Record<string, number> = {};
    const byStep: Record<string, number> = {};
    for (const r of rows) {
      byStage[String(r.stage)] = (byStage[String(r.stage)] ?? 0) + 1;
      byStep[String(r.currentStep ?? 'none')] = (byStep[String(r.currentStep ?? 'none')] ?? 0) + 1;
    }
    return reply(res, 200, { total: rows.length, byStage, byStep });
  }

  if (url.pathname === '/mark' && req.method === 'POST') {
    // A clean database, not just clean counters. Candidate state is keyed on
    // waId and the generator reuses the same waIds every run, so without this a
    // second run resumes the first run's half-finished conversations: the bot
    // correctly rejects an opening "hi" from someone already mid-registration,
    // two unusable answers in a row hand them to staff (§8), and every later
    // message goes unanswered. That reads as the application failing under load
    // when it is the rig failing to reset.
    if (url.searchParams.get('keepDb') !== 'true') {
      const { getDb } = await import('../../src/db/client.js');
      await getDb().dropDatabase();
      await ensureIndexes();
    }
    modelPeak.inFlight = 0;
    modelPeak.waiting = 0;
    modelSamples.length = 0;
    mediaStats.lookups = 0;
    mediaStats.served = 0;
    mediaStats.bytesServed = 0;
    mediaStats.refusedTooLarge = 0;
    mediaStats.oversizeOffered = 0;
    pendingOcr = null;
    mongoBaseline = await opLatencies();
    pendingMongoLatency = null;
    markAt = Date.now();
    instrumented.reset();
    lag.histogram.reset();
    proc.samples.length = 0;
    guard.reset();
    resetModelStatsForTests();
    outbound.length = 0;
    byCandidate.clear();
    outboundSeq = 0;
    mongoErrorCount = 0;
    return reply(res, 200, { ok: true, at: markAt });
  }

  // Long-poll for the next reply to one candidate. This is how the generator
  // measures true time-to-reply and learns which option ids to tap next.
  if (url.pathname === '/reply') {
    const waId = url.searchParams.get('waId') ?? '';
    const after = Number(url.searchParams.get('after') ?? 0);
    const timeoutMs = Number(url.searchParams.get('timeout') ?? 30000);

    const found = () => (byCandidate.get(waId) ?? []).filter((r) => r.seq > after);

    const existing = found();
    if (existing.length) return reply(res, 200, { replies: existing });

    const deadline = setTimeout(() => {
      waiters.set(waId, (waiters.get(waId) ?? []).filter((w) => w !== wake));
      reply(res, 200, { replies: [] });
    }, timeoutMs);

    const wake = () => {
      clearTimeout(deadline);
      reply(res, 200, { replies: found() });
    };
    waiters.set(waId, [...(waiters.get(waId) ?? []), wake]);
    return;
  }

  // Demonstrates the guard rather than asserting it. Each of these is a host the
  // application could plausibly reach in production; none of them can be reached
  // from here. Nothing leaves the machine when this runs — the guard answers or
  // throws before a socket is opened.
  if (url.pathname === '/guard-probe') {
    const hosts = [
      'https://api.anthropic.com/v1/messages',
      'https://graph.facebook.com/v25.0/000/messages',
      'https://crm.example.com/v1/candidates',
      'https://veris.recursai.in/v1/health',
    ];

    const results: Array<{ url: string; outcome: string }> = [];
    for (const target of hosts) {
      try {
        const r = await fetch(target, { method: 'POST', body: '{}' });
        results.push({ url: target, outcome: `answered locally by the guard (${r.status})` });
      } catch (err) {
        results.push({ url: target, outcome: `BLOCKED: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return reply(res, 200, { results, guard: guard.stats().blockedHosts });
  }

  /**
   * The bytes behind a media id.
   *
   * Served with an honest `Content-Length` so the application's L2 check has
   * something real to read, and on the control port so the download does not
   * count as load against the app being measured.
   */
  if (url.pathname.startsWith('/media/')) {
    const mediaId = url.pathname.slice('/media/'.length);
    const kind = kindOf(mediaId);
    const buffer = kind ? DOCUMENTS[kind] : undefined;

    if (!buffer) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"unknown media id"}');
      return;
    }

    mediaStats.served += 1;
    mediaStats.bytesServed += buffer.byteLength;
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': String(buffer.byteLength),
    });
    res.end(buffer);
    return;
  }

  if (url.pathname === '/db') {
    const [candidateCount, registered] = await Promise.all([
      candidates().countDocuments(),
      candidates().countDocuments({ stage: 'REGISTRATION_COMPLETED' as never }),
    ]);
    return reply(res, 200, { candidates: candidateCount, registered, mongoErrors: mongoErrorCount });
  }

  if (url.pathname === '/transcript') {
    const waId = url.searchParams.get('waId') ?? '';
    return reply(res, 200, { turns: await turnsFor(waId) });
  }

  reply(res, 404, { error: 'not found' });
});

control.listen(CONTROL_PORT, '0.0.0.0');

/* ------------------------------------------------------------------ */
/* Runtime handshake                                                   */
/* ------------------------------------------------------------------ */

const runtime = {
  appUrl: `http://127.0.0.1:${APP_PORT}`,
  controlUrl: `http://127.0.0.1:${CONTROL_PORT}`,
  mockUrl: MOCK_URL,
  ocrUrl: process.env.VERIS_OCR_BASE_URL,
  wabaId: process.env.WHATSAPP_WABA_ID,
  // Generated for this process only. Not the production secret, which this rig
  // never reads and never needs.
  appSecret: APP_SECRET,
  startedAt: new Date().toISOString(),
};

fs.writeFileSync(path.join(LOADTEST_DIR, '.runtime.json'), JSON.stringify(runtime, null, 2), {
  mode: 0o600,
});

console.log(
  [
    '',
    'load-test rig up',
    `  app       ${runtime.appUrl}       (measured — all load goes here)`,
    `  control   ${runtime.controlUrl}   (metrics + replies — not measured)`,
    `  anthropic ${MOCK_URL}             (mock; real host is refused by the guard)`,
    `  veris ocr ${process.env.VERIS_OCR_BASE_URL}` +
      `${process.env.LOADTEST_REAL_VERIS === 'true' ? '   *** LIVE SERVICE — real traffic leaves this machine ***' : '   (mock)'}`,
    `  media     served by the control port; MOCK_WHATSAPP_MEDIA=false so the real download runs`,
    `  mongo     ${mongoKind}  db=${MONGO_DB}  (dropped ${dropped} stale candidates)`,
    ...(mongoKind === 'memory'
      ? [
          '  NOTE: the in-memory mongod shares this box with the application, so',
          '        capacity numbers from this mode are a floor, not a match for',
          '        production. Use LOADTEST_MONGO=container for the real runs.',
        ]
      : []),
    '',
    `  concurrency  inbound=${config.QUEUE_CONCURRENCY_INBOUND} ocr=${config.QUEUE_CONCURRENCY_OCR} crm=${config.QUEUE_CONCURRENCY_CRM_SYNC}`,
    `  limiters     replies=${config.OUTBOUND_RATE_PER_SECOND}/s receipts=${config.READ_RECEIPT_RATE_PER_SECOND}/s media=${config.MEDIA_DOWNLOAD_RATE_PER_SECOND}/s`,
    `  model        concurrency=${config.MODEL_MAX_CONCURRENCY} queued=${config.MODEL_MAX_QUEUED} retries=${config.MODEL_MAX_RETRIES}`,
    `  queue        ${config.REDIS_URL ? 'redis' : 'in-process'}   shadowMode=${config.SHADOW_MODE}`,
    '',
    '  outbound guard: only graph.facebook.com (stubbed) and localhost. Anything else throws.',
    '',
  ].join('\n'),
);

const shutdown = async () => {
  clearInterval(depthTimer);
  clearInterval(ocrSweepTimer);
  lag.stop();
  proc.stop();
  try {
    await app.close();
    control.close();
    await queue.close();
    await closeDb();
    await memoryServer?.stop();
  } catch {
    /* going down anyway */
  }
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
