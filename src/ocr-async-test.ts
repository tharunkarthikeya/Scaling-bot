/**
 * The async extraction path, against a real database.
 *
 * The smoke suite covers the wire client — 202s, duplicates, queue-full, the
 * retry question, normaliser compatibility — because none of that needs state.
 * What needs state is everything the migration could get quietly wrong: two
 * sweeps racing one job, a superseded upload answering a candidate who has
 * already moved on, one extraction overwriting another's job id, and the
 * inspection surviving from submission to a terminal poll that happens in a
 * different invocation entirely.
 *
 * Boots `mongodb-memory-server` and the jobs mock, and drives the real
 * `sweepRunningExtractions` rather than a stand-in.
 *
 *   npm run test:ocr-async
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';

const mongo = await MongoMemoryServer.create();

process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'adira_ocr_async';
process.env.SHADOW_MODE = 'true';
process.env.MOCK_WHATSAPP_MEDIA = 'true';
process.env.STORAGE_PATH = path.join(os.tmpdir(), 'adira-ocr-async-storage');
process.env.LOG_LEVEL = process.env.OCR_TEST_LOG_LEVEL ?? 'error';
process.env.VERIS_OCR_ASYNC = 'true';
process.env.VERIS_OCR_POLL_MIN_MS = '10';
process.env.VERIS_OCR_POLL_MAX_MS = '20';
process.env.OCR_CLAIM_STALE_MS = '60000';

/* The jobs mock, on a port chosen before config is read. */
const { handleJobsRoute, resetJobsMock, jobsState } = await import('./testing/verisJobsMock.js');
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (handleJobsRoute(req, res, url.pathname)) return;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const mockPort = (server.address() as { port: number }).port;
process.env.VERIS_OCR_BASE_URL = `http://127.0.0.1:${mockPort}`;
process.env.VERIS_OCR_API_KEY = 'test';

const { config } = await import('./config.js');
const { connectDb, closeDb, getDb } = await import('./db/client.js');
const { ensureIndexes, addUpload, findUpload, candidates, claimExtraction, dueExtractions } =
  await import('./db/models.js');
const { ensureStorageRoot, saveFile } = await import('./storage/index.js');
const { processOcrJob, sweepRunningExtractions } = await import('./ocr/veris.js');
const { SAMPLE_PASSPORT_PDF, SAMPLE_RESUME_PDF } = await import('./testing/fixtures.js');

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

/** A candidate with one stored document, ready for extraction. */
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

/** Runs the sweep until the upload leaves the in-flight states, or gives up. */
async function settle(waId: string, docType: string, uploadId: ObjectId, ticks = 40) {
  for (let i = 0; i < ticks; i++) {
    await sweepRunningExtractions();
    const doc = await findUpload(waId, docType, uploadId);
    const status = doc?.ocr?.status;
    if (status === 'done' || status === 'failed' || status === 'skipped') return doc;
    await sleep(25);
  }
  return findUpload(waId, docType, uploadId);
}

console.log('\nasync ocr — database-backed');

resetJobsMock();
jobsState.queuedPolls = 1;
jobsState.runningPolls = 1;

await check('a document is submitted, polled, and finishes as done', async () => {
  const waId = '919000200001';
  const { uploadId } = await seed({ waId, docType: 'passport', filename: 'passport.pdf' });

  await processOcrJob({ waId, docType: 'passport', uploadId: uploadId.toHexString() });

  const afterSubmit = await findUpload(waId, 'passport', uploadId);
  assert.equal(afterSubmit?.ocr?.status, 'running', 'submission did not move it to running');
  assert.ok(afterSubmit?.ocr?.jobId, 'no jobId persisted');
  assert.ok(afterSubmit?.ocr?.statusUrl, 'no statusUrl persisted');

  const done = await settle(waId, 'passport', uploadId);
  assert.equal(done?.ocr?.status, 'done', `ended as ${done?.ocr?.status}`);
  assert.ok(done?.ocr?.completeness, 'no completeness verdict stored');
  // Values are deliberately NOT stored here: the fixture is a one-page passport
  // and §14 wants two, so the read is unusable and `processOcrJob` keeps the
  // verdict and discards the values. Asserting fields here would be asserting
  // the opposite of the behaviour the synchronous path has always had.
  assert.equal(done?.ocr?.completeness?.complete, false);

  // An Aadhaar does complete, so it is the one that must carry values through.
  const aadhaar = await seed({ waId: waId + '9', docType: 'aadhaar', filename: 'aadhaar.pdf' });
  await processOcrJob({
    waId: waId + '9',
    docType: 'aadhaar',
    uploadId: aadhaar.uploadId.toHexString(),
  });
  const read = await settle(waId + '9', 'aadhaar', aadhaar.uploadId);
  assert.equal(read?.ocr?.status, 'done');
  assert.ok((read?.ocr?.fields?.length ?? 0) > 0, 'a complete extraction stored no fields');
});

await check('the inspection survives from submission to the terminal poll', async () => {
  // §14's page check reads this at the terminal end, in a later invocation with
  // the file long out of memory. If it is not persisted the check silently stops
  // working and every passport looks like a complete booklet.
  const waId = '919000200002';
  const { uploadId } = await seed({ waId, docType: 'passport', filename: 'passport.pdf' });

  await processOcrJob({ waId, docType: 'passport', uploadId: uploadId.toHexString() });

  const afterSubmit = await findUpload(waId, 'passport', uploadId);
  assert.ok(afterSubmit?.ocr?.inspection, 'inspection was not persisted at submission');
  assert.equal(afterSubmit?.ocr?.inspection?.readable, true);
  assert.equal(afterSubmit?.ocr?.inspection?.pages, 1, 'page count lost');

  const done = await settle(waId, 'passport', uploadId);
  // One page against passportMinPdfPages of 2 — the verdict that is only
  // reachable because the inspection was still there.
  assert.equal(done?.ocr?.completeness?.complete, false);
  assert.ok(
    done?.ocr?.completeness?.problems.some((p) => /page/i.test(p)),
    `expected a page problem, got ${JSON.stringify(done?.ocr?.completeness?.problems)}`,
  );
});

await check('two sweeps cannot both drive the same extraction', async () => {
  const waId = '919000200003';
  const { uploadId } = await seed({ waId, docType: 'aadhaar', filename: 'aadhaar.pdf' });
  await processOcrJob({ waId, docType: 'aadhaar', uploadId: uploadId.toHexString() });

  // Two ticks racing on one upload. Exactly one may take the claim.
  const [a, b] = await Promise.all([
    claimExtraction({ waId, docType: 'aadhaar', uploadId, staleClaimMs: config.OCR_CLAIM_STALE_MS }),
    claimExtraction({ waId, docType: 'aadhaar', uploadId, staleClaimMs: config.OCR_CLAIM_STALE_MS }),
  ]);
  assert.equal(
    [a, b].filter(Boolean).length,
    1,
    `exactly one tick must claim it; ${[a, b].filter(Boolean).length} did`,
  );
});

await check('a claimed extraction is not offered to another sweep', async () => {
  const waId = '919000200004';
  const { uploadId } = await seed({ waId, docType: 'aadhaar', filename: 'aadhaar.pdf' });
  await processOcrJob({ waId, docType: 'aadhaar', uploadId: uploadId.toHexString() });

  const claimed = await claimExtraction({
    waId,
    docType: 'aadhaar',
    uploadId,
    staleClaimMs: config.OCR_CLAIM_STALE_MS,
  });
  assert.equal(claimed, true);

  const due = await dueExtractions({ staleClaimMs: config.OCR_CLAIM_STALE_MS });
  assert.equal(
    due.some((d) => d.uploadId.equals(uploadId)),
    false,
    'a claimed extraction was still offered as due',
  );
});

await check('one upload cannot overwrite another extraction of the same bytes', async () => {
  // The CV-passport case. `filePassportFoundInCv` files the same mediaId and the
  // same storageKey under the passport slot, so both extractions describe one
  // attachment — and each must keep its own job.
  const waId = '919000200005';
  const cv = await seed({
    waId,
    docType: 'cv',
    filename: 'cv.pdf',
    body: SAMPLE_RESUME_PDF('async-test'),
  });

  const passportUploadId = await addUpload({
    waId,
    candidateId: cv.candidateId,
    docType: 'passport',
    upload: {
      mediaId: `MEDIA-${waId}`, // identical
      wamid: `wamid.${waId}`, // identical
      storageKey: (await findUpload(waId, 'cv', cv.uploadId))!.storageKey, // identical
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
  assert.notEqual(cvDoc!.ocr!.jobId, ppDoc!.ocr!.jobId, 'one job id served both extractions');
});

await check('a superseded upload does not resume the conversation', async () => {
  const waId = '919000200006';
  const first = await seed({ waId, docType: 'aadhaar', filename: 'aadhaar.pdf' });
  await processOcrJob({ waId, docType: 'aadhaar', uploadId: first.uploadId.toHexString() });

  // A second photo arrives before the first extraction comes back. `addUpload`
  // supersedes the first, and its verdict must not speak for the slot.
  await addUpload({
    waId,
    candidateId: first.candidateId,
    docType: 'aadhaar',
    upload: {
      mediaId: 'MEDIA-second',
      wamid: 'wamid.second',
      storageKey: (await findUpload(waId, 'aadhaar', first.uploadId))!.storageKey,
      mimeType: 'application/pdf',
      byteSize: 1,
      sha256: 'second',
      ocr: { status: 'queued' },
    },
  });

  const settled = await settle(waId, 'aadhaar', first.uploadId);
  assert.equal(settled?.ocr?.status, 'done', 'the first extraction did not finish');
  assert.ok(settled?.supersededAt, 'the first upload was not superseded');

  const candidate = await candidates().findOne({ waId });
  // The superseded verdict must not have written the slot.
  assert.notEqual(candidate?.documents?.aadhaar?.status, 'ocr_done');
});

await check('a terminal failure ends as failed and is not left running', async () => {
  const waId = '919000200007';
  const { uploadId } = await seed({ waId, docType: 'aadhaar', filename: 'fail-terminal.pdf' });
  await processOcrJob({ waId, docType: 'aadhaar', uploadId: uploadId.toHexString() });

  const settled = await settle(waId, 'aadhaar', uploadId);
  assert.equal(settled?.ocr?.status, 'failed', `ended as ${settled?.ocr?.status}`);
  assert.ok(settled?.ocr?.error, 'no error recorded');
});

await check('queue-full leaves the upload queued and costs it no attempt', async () => {
  const waId = '919000200008';
  const { uploadId } = await seed({ waId, docType: 'aadhaar', filename: 'queuefull.pdf' });

  await processOcrJob({ waId, docType: 'aadhaar', uploadId: uploadId.toHexString() });

  const after = await findUpload(waId, 'aadhaar', uploadId);
  assert.equal(after?.ocr?.status, 'queued', `became ${after?.ocr?.status}`);
  assert.ok(!after?.ocr?.attempts, `attempt was consumed: ${after?.ocr?.attempts}`);
  assert.ok(after?.ocr?.nextPollAt, 'no retry time was set');
});

await check('the ledger mirrors the job for operators', async () => {
  const waId = '919000200009';
  const { uploadId } = await seed({ waId, docType: 'passport', filename: 'passport.pdf' });

  const { openIngestion, findIngestion, idempotencyKeyFor } = await import('./ingestion/ledger.js');
  const key = {
    provider: 'whatsapp' as const,
    account: config.WHATSAPP_PHONE_NUMBER_ID,
    messageId: `wamid.${waId}`,
    attachmentId: `MEDIA-${waId}`,
  };
  await openIngestion({ ...key, waId });

  await processOcrJob({ waId, docType: 'passport', uploadId: uploadId.toHexString() });

  const row = await findIngestion(idempotencyKeyFor(key));
  assert.equal(row?.status, 'running', `ledger status was ${row?.status}`);
  assert.ok(row?.jobId, 'ledger did not record the job id');
  assert.equal(row?.ocrMode, 'passport');
});

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} of ${passed + failures.length} checks failed\x1b[0m\n` +
        failures.map((f) => `  - ${f}`).join('\n') +
        '\n'
    : `\n\x1b[32m${passed} checks passed\x1b[0m\n`,
);

server.close();
await closeDb();
await mongo.stop();
void getDb;
process.exit(failures.length ? 1 : 0);
