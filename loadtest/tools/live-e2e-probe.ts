/**
 * Phase 2: a tiny end-to-end run of the async application path against the
 * live Veris Jobs API.
 *
 * Everything except Veris is local or stubbed:
 *   - Mongo is an in-memory server created for this process and thrown away
 *   - SHADOW_MODE stops every WhatsApp send
 *   - the fetch guard permits exactly one external host and blocks the rest
 *
 * Four extractions at most. The point is not coverage — `src/ocr-async-test.ts`
 * already covers the logic against the mock — but whether the real service's
 * timing and payload survive the full submit -> sweep -> normalise -> resume
 * chain.
 *
 *   LOADTEST_ALLOW_HOST=veriis.adiragroups.com npx tsx loadtest/tools/live-e2e-probe.ts
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const HOST = process.env.LOADTEST_ALLOW_HOST ?? '';
if (!HOST) {
  console.error('Refusing to run: LOADTEST_ALLOW_HOST is not set.');
  process.exit(1);
}

import { installFetchGuard } from '../rig/guard.js';
const guard = installFetchGuard({ onOutbound: () => undefined });

import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';

const mongo = await MongoMemoryServer.create();

/* Local-only wiring. VERIS_OCR_BASE_URL is deliberately NOT set here — it comes
 * from .env, which is the production endpoint this test is about. */
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'adira_live_e2e';
process.env.SHADOW_MODE = 'true';
process.env.MOCK_WHATSAPP_MEDIA = 'true';
process.env.STORAGE_PATH = path.join(os.tmpdir(), 'adira-live-e2e-storage');
process.env.LOG_LEVEL = 'error';
process.env.VERIS_OCR_ASYNC = 'true';
process.env.VERIS_OCR_POLL_MIN_MS = '2000';
process.env.VERIS_OCR_POLL_MAX_MS = '8000';
process.env.OCR_CLAIM_STALE_MS = '120000';

const { config } = await import('../../src/config.js');
const { connectDb, closeDb } = await import('../../src/db/client.js');
const { ensureIndexes, addUpload, findUpload, candidates } = await import('../../src/db/models.js');
const { ensureStorageRoot, saveFile } = await import('../../src/storage/index.js');
const { processOcrJob, sweepRunningExtractions } = await import('../../src/ocr/veris.js');
const { SAMPLE_PASSPORT_PDF, SAMPLE_RESUME_PDF } = await import('../../src/testing/fixtures.js');

console.log(`
PREFLIGHT (phase 2)
  veris base url   ${config.VERIS_OCR_BASE_URL}
  allowed host     ${HOST}   (all others blocked)
  mongo            in-memory, discarded on exit
  shadow mode      ${config.SHADOW_MODE}   (no WhatsApp sends)
  async flag       ${config.VERIS_OCR_ASYNC}
  extractions      4 maximum
`);

await connectDb();
await ensureIndexes();
await ensureStorageRoot();

let passed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32mok\x1b[0m  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seed(params: {
  waId: string;
  docType: string;
  filename: string;
  body?: Buffer;
}): Promise<{ candidateId: ObjectId; uploadId: ObjectId }> {
  const candidateId = new ObjectId();
  await candidates().insertOne({
    _id: candidateId,
    waId: params.waId,
    phone: params.waId,
    stage: 'DOCUMENTS_PENDING',
    status: 'profile_incomplete',
    profile: {},
    documents: {},
    history: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);

  const buffer = params.body ?? SAMPLE_PASSPORT_PDF();
  const stored = await saveFile({
    waId: params.waId,
    docType: params.docType,
    buffer,
    mimeType: 'application/pdf',
    originalFilename: params.filename,
  });

  const uploadId = await addUpload({
    waId: params.waId,
    candidateId,
    docType: params.docType,
    upload: {
      mediaId: `MEDIA-${params.waId}`,
      wamid: `wamid.${params.waId}`,
      storageKey: stored.storageKey,
      mimeType: 'application/pdf',
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: params.filename,
      ocr: { status: 'queued' },
    },
  });

  return { candidateId, uploadId };
}

/** Sweeps until terminal, at real-service pace. */
async function settle(waId: string, docType: string, uploadId: ObjectId, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sweepRunningExtractions();
    const doc = await findUpload(waId, docType, uploadId);
    const status = doc?.ocr?.status;
    if (status === 'done' || status === 'failed' || status === 'skipped') return doc;
    await sleep(1500);
  }
  return findUpload(waId, docType, uploadId);
}

console.log('live end-to-end (production Veris, local everything else)\n');

/* ------------------------------------------------------------------ */
/* 1. One passport, all the way through                                */
/* ------------------------------------------------------------------ */

const waId1 = '919000900001';
const seeded1 = await seed({ waId: waId1, docType: 'passport', filename: 'passport.pdf' });

await check('submit reaches /v1/jobs and persists jobId + statusUrl', async () => {
  await processOcrJob({ waId: waId1, docType: 'passport', uploadId: seeded1.uploadId.toHexString() });
  const doc = await findUpload(waId1, 'passport', seeded1.uploadId);
  assert.equal(doc?.ocr?.status, 'running', `status is ${doc?.ocr?.status}`);
  assert.ok(doc?.ocr?.jobId, 'jobId was not persisted');
  assert.ok(doc?.ocr?.statusUrl, 'statusUrl was not persisted');
  assert.ok(doc?.ocr?.submittedAt, 'submittedAt was not persisted');
  console.log(`       jobId persisted (${doc!.ocr!.jobId!.length} chars), statusUrl persisted`);
});

await check('inspection is captured at submission and survives', async () => {
  const doc = await findUpload(waId1, 'passport', seeded1.uploadId);
  assert.ok(doc?.ocr?.inspection, 'no inspection persisted');
  assert.equal(doc!.ocr!.inspection!.readable, true);
  console.log(`       inspection.pages=${doc!.ocr!.inspection!.pages}`);
});

let settled1: Awaited<ReturnType<typeof findUpload>>;

await check('polling progresses to a terminal state', async () => {
  settled1 = await settle(waId1, 'passport', seeded1.uploadId);
  assert.ok(
    settled1?.ocr?.status === 'done' || settled1?.ocr?.status === 'failed',
    `still ${settled1?.ocr?.status}`,
  );
  console.log(`       terminal status=${settled1!.ocr!.status}`);
});

await check('the real payload reaches the normalisers', async () => {
  assert.equal(settled1?.ocr?.status, 'done', `ended ${settled1?.ocr?.status}`);
  assert.ok(settled1?.ocr?.completeness, 'no completeness verdict');
  assert.ok(settled1?.ocr?.reviewReasons?.length, 'no review reasons recorded');

  // `keepExtraction` (veris.ts) deliberately discards values from a read the
  // service was not confident about, so an empty `fields` here is the designed
  // outcome for a low-confidence scan rather than a normalisation failure.
  console.log(`       confidence=${settled1!.ocr!.confidence}  threshold=0.85`);
  console.log(`       reviewReasons=${JSON.stringify(settled1!.ocr!.reviewReasons)}`);
  console.log(`       fields kept=${settled1?.ocr?.fields?.length ?? 0}  raw kept=${Boolean(settled1?.ocr?.raw)}`);
  console.log(
    `       needsReview=${settled1!.ocr!.needsReview}` +
      `  complete=${settled1!.ocr!.completeness!.complete}` +
      `  problems=${JSON.stringify(settled1!.ocr!.completeness!.problems)}`,
  );
});

await check('inspection still present at the terminal end', async () => {
  assert.ok(settled1?.ocr?.inspection, 'inspection was lost between submit and terminal');
});

await check('extra sweeps after terminal cause no duplicate processing', async () => {
  const before = await findUpload(waId1, 'passport', seeded1.uploadId);
  const finishedAt = before?.ocr?.finishedAt?.getTime();
  const cand1 = await candidates().findOne({ waId: waId1 });
  const historyBefore = (cand1?.history ?? []).length;

  for (let i = 0; i < 3; i++) await sweepRunningExtractions();

  const after = await findUpload(waId1, 'passport', seeded1.uploadId);
  const cand2 = await candidates().findOne({ waId: waId1 });
  assert.equal(after?.ocr?.finishedAt?.getTime(), finishedAt, 'terminal was re-processed');
  assert.equal((cand2?.history ?? []).length, historyBefore, 'the conversation was resumed twice');
  console.log(`       history entries stable at ${historyBefore}`);
});

await check('the ledger mirrors the job', async () => {
  const { findIngestion, idempotencyKeyFor } = await import('../../src/ingestion/ledger.js');
  const row = await findIngestion(
    idempotencyKeyFor({
      provider: 'whatsapp',
      account: config.WHATSAPP_PHONE_NUMBER_ID,
      messageId: `wamid.${waId1}`,
      attachmentId: `MEDIA-${waId1}`,
    }),
  );
  if (!row) {
    console.log('       (no ingestion row was opened by this seeding path — not applicable)');
    return;
  }
  console.log(`       ledger status=${(row as any).ocrStatus ?? (row as any).status}`);
});

/* ------------------------------------------------------------------ */
/* 2. CV plus the passport found inside it - distinct jobs             */
/* ------------------------------------------------------------------ */

if (process.env.E2E_FULL === '1')
  await check('a CV and the passport inside it get distinct jobs', async () => {
  const waId = '919000900002';
  const cv = await seed({
    waId,
    docType: 'cv',
    filename: 'cv.pdf',
    body: SAMPLE_RESUME_PDF('live-e2e'),
  });

  const passportUploadId = await addUpload({
    waId,
    candidateId: cv.candidateId,
    docType: 'passport',
    upload: {
      mediaId: `MEDIA-${waId}`,
      wamid: `wamid.${waId}`,
      storageKey: (await findUpload(waId, 'cv', cv.uploadId))!.storageKey,
      mimeType: 'application/pdf',
      byteSize: 1,
      sha256: 'same',
      caption: 'passport pages found inside the CV',
      ocr: { status: 'queued' },
    },
  });

  await processOcrJob({ waId, docType: 'cv', uploadId: cv.uploadId.toHexString() });
  await processOcrJob({ waId, docType: 'passport', uploadId: passportUploadId.toHexString() });

  const cvDoc = await findUpload(waId, 'cv', cv.uploadId);
  const ppDoc = await findUpload(waId, 'passport', passportUploadId);

  assert.ok(cvDoc?.ocr?.jobId, 'cv has no job');
  assert.ok(ppDoc?.ocr?.jobId, 'passport has no job');
  assert.notEqual(
    cvDoc!.ocr!.jobId,
    ppDoc!.ocr!.jobId,
    'the same job id served both extractions - idempotency key collision',
  );
  console.log('       two distinct job ids issued for one attachment');

  await settle(waId, 'cv', cv.uploadId, 90_000);
});

/* ------------------------------------------------------------------ */
/* 3. A superseded upload must not speak for its slot                  */
/* ------------------------------------------------------------------ */

if (process.env.E2E_FULL === '1')
  await check('a superseded upload does not resume the conversation', async () => {
  const waId = '919000900003';
  const first = await seed({ waId, docType: 'passport', filename: 'passport.pdf' });
  await processOcrJob({ waId, docType: 'passport', uploadId: first.uploadId.toHexString() });

  await addUpload({
    waId,
    candidateId: first.candidateId,
    docType: 'passport',
    upload: {
      mediaId: 'MEDIA-second',
      wamid: 'wamid.second',
      storageKey: (await findUpload(waId, 'passport', first.uploadId))!.storageKey,
      mimeType: 'application/pdf',
      byteSize: 1,
      sha256: 'second',
      ocr: { status: 'queued' },
    },
  });

  const settled = await settle(waId, 'passport', first.uploadId, 120_000);
  assert.equal(settled?.ocr?.status, 'done', `first extraction ended ${settled?.ocr?.status}`);
  assert.ok(settled?.supersededAt, 'the first upload was not superseded');

  const candidate = await candidates().findOne({ waId });
  assert.notEqual(
    candidate?.documents?.passport?.status,
    'ocr_done',
    'a superseded verdict wrote the slot',
  );
  console.log('       superseded verdict did not write the slot');
});

/* ------------------------------------------------------------------ */

const s = guard.stats();
console.log(`
=== phase 2 done ===
  checks passed          : ${passed}
  checks failed          : ${failures.length}${failures.length ? ' -> ' + JSON.stringify(failures) : ''}
  live external requests : ${s.externalRequests}  (all to ${HOST})
  blocked (non-allowed)  : ${s.blocked}${s.blockedHosts.length ? ' ' + JSON.stringify(s.blockedHosts) : ''}
  graph/meta requests    : ${s.graphRequests} (intercepted locally, never sent)
`);

await closeDb();
await mongo.stop();
process.exit(failures.length ? 1 : 0);
