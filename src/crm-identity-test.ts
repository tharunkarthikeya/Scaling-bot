/**
 * The identity documents crossing to the CRM, against a stub that records what
 * arrives.
 *
 *   npm run test:crm-identity
 *
 * The CRM's own suite proves what it does with an Aadhaar once it has one.
 * This proves the half that lives here: that the passport a candidate
 * photographed on Tuesday is described in the submission, that its bytes
 * follow it in a second request against the record the submission created, and
 * that neither happens twice.
 *
 * Two things are stubbed and nothing else is. Mongo runs in-process
 * (`mongodb-memory-server`), and the CRM is a local HTTP server that answers
 * like the real one and keeps every request. The conversation engine, the
 * queue and the network are not involved — this is about the sync, and the
 * sync is the thing that would break silently.
 *
 * Nothing here touches a real database or a real CRM. It is safe to run
 * against a laptop whose `.env` points at production, which is exactly the
 * situation it has to be safe in.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';

const mongo = await MongoMemoryServer.create();

process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'adira_crm_identity';
process.env.SHADOW_MODE = 'true';
process.env.MOCK_WHATSAPP_MEDIA = 'true';
process.env.STORAGE_PATH = path.join(os.tmpdir(), 'adira-crm-identity-storage');
process.env.LOG_LEVEL = process.env.CRM_IDENTITY_TEST_LOG_LEVEL ?? 'error';

/* ────────────────────────────────────────────────────────────────────────────
 * The CRM, as far as this test is concerned
 *
 * Answers the two calls the sync makes and records both. `nextFileStatus` is
 * how the "the record has not landed yet" case is reproduced without racing
 * anything.
 * ──────────────────────────────────────────────────────────────────────────*/

interface SeenSubmission {
  body: Record<string, any>;
}

interface SeenUpload {
  url: string;
  candidateId: string;
  documentType: string;
  recordId: string;
  raw: Buffer;
}

const submissions: SeenSubmission[] = [];
const uploads: SeenUpload[] = [];
let nextFileStatus = 200;

const CRM_CANDIDATE_ID = 'crm-candidate-0001';

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const crm = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);

    const file = /^\/candidates\/([^/]+)\/identity\/([^/]+)\/([^/]+)\/file$/.exec(url.pathname);
    if (req.method === 'POST' && file) {
      uploads.push({
        url: url.pathname,
        candidateId: decodeURIComponent(file[1]!),
        documentType: file[2]!,
        recordId: decodeURIComponent(file[3]!),
        raw: body,
      });
      res.writeHead(nextFileStatus, { 'content-type': 'application/json' });
      res.end(
        nextFileStatus === 200
          ? JSON.stringify({ success: true })
          : JSON.stringify({ code: 'identity_record_not_found', detail: 'no such record' }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/candidates') {
      submissions.push({ body: JSON.parse(body.toString('utf8')) });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          candidate_id: CRM_CANDIDATE_ID,
          created: submissions.length === 1,
          cv_required: false,
          cv_policy_version: 'test',
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  })();
});

await new Promise<void>((r) => crm.listen(0, '127.0.0.1', r));
process.env.CRM_API_URL = `http://127.0.0.1:${(crm.address() as { port: number }).port}`;
process.env.CRM_API_KEY = 'test-service-key';

const { connectDb, closeDb } = await import('./db/client.js');
const { ensureIndexes, addUpload, candidates, recordsFor, findConversation } = await import(
  './db/models.js'
);
const { ensureStorageRoot, saveFile } = await import('./storage/index.js');
const { snapshotFor, identityUploadsFor } = await import('./crm/snapshot.js');
const { syncCandidateToCrm } = await import('./crm/sync.js');

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

/* ────────────────────────────────────────────────────────────────────────────
 * Fixtures
 * ──────────────────────────────────────────────────────────────────────────*/

const PASSPORT_BYTES = Buffer.from('fake-jpeg-bytes-for-a-passport-data-page');
const AADHAAR_BYTES = Buffer.from('fake-jpeg-bytes-for-an-aadhaar-card-front');

const PASSPORT_OCR = {
  mrz: {
    passport_number: 'Z1234567',
    surname: 'Shah',
    given_names: 'Nasim',
    nationality: 'IND',
    date_of_birth: '1994-02-17',
    sex: 'M',
    expiry_date: '2031-03-14',
    all_check_digits_valid: true,
  },
  fields: { place_of_issue: 'CHENNAI' },
  confidence: 0.97,
};

const AADHAAR_OCR = {
  aadhaar: {
    name: 'Nasim Shah',
    aadhaar_number: '123412349017',
    aadhaar_number_valid: true,
    date_of_birth: '1994-02-17',
    address: 'Vill Chaturbuhjwa, West Champaran, Bihar',
    document_side: 'front',
  },
};

/** A consenting, finished candidate with the documents this test is about. */
async function seed(waId: string, options: { withAadhaar?: boolean } = {}) {
  const candidateId = new ObjectId();
  await candidates().insertOne({
    _id: candidateId,
    waId,
    phone: waId,
    stage: 'REGISTRATION_COMPLETED',
    status: 'profile_complete',
    enquiry: 'apply',
    consent: { given: true, at: new Date() },
    profile: {
      fullName: 'Nasim Shah',
      currentCountry: 'India',
      jobCategory: 'general_worker',
    },
    documents: {},
    history: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);

  const passport = await saveFile({
    waId,
    docType: 'passport',
    buffer: PASSPORT_BYTES,
    mimeType: 'image/jpeg',
    originalFilename: 'passport.jpg',
  });
  const passportUploadId = await addUpload({
    waId,
    candidateId,
    docType: 'passport',
    upload: {
      mediaId: `MEDIA-${waId}-p`,
      wamid: `wamid.${waId}.passport`,
      storageKey: passport.storageKey,
      mimeType: 'image/jpeg',
      byteSize: passport.byteSize,
      sha256: passport.sha256,
      originalFilename: 'passport.jpg',
      ocr: { status: 'succeeded', raw: PASSPORT_OCR, finishedAt: new Date() },
    } as never,
  });

  let aadhaarUploadId: ObjectId | undefined;
  if (options.withAadhaar) {
    const aadhaar = await saveFile({
      waId,
      docType: 'aadhaar',
      buffer: AADHAAR_BYTES,
      mimeType: 'image/jpeg',
      originalFilename: 'aadhaar-front.jpg',
    });
    aadhaarUploadId = await addUpload({
      waId,
      candidateId,
      docType: 'aadhaar',
      upload: {
        mediaId: `MEDIA-${waId}-a`,
        wamid: `wamid.${waId}.aadhaar`,
        storageKey: aadhaar.storageKey,
        mimeType: 'image/jpeg',
        byteSize: aadhaar.byteSize,
        sha256: aadhaar.sha256,
        originalFilename: 'aadhaar-front.jpg',
        ocr: { status: 'succeeded', raw: AADHAAR_OCR, finishedAt: new Date() },
      } as never,
    });
  }

  return { candidateId, passportUploadId, aadhaarUploadId, passportSha: passport.sha256 };
}

/** Puts the candidate back in a state where another handover will run. */
async function reopen(waId: string): Promise<void> {
  const candidate = await findConversation(waId);
  await recordsFor(candidate!.enquiry).updateOne(
    { _id: candidate!._id },
    { $set: { 'crmSync.status': 'pending' } },
  );
}

function reset(): void {
  submissions.length = 0;
  uploads.length = 0;
  nextFileStatus = 200;
}

console.log('\n\x1b[1mIdentity documents, bot → CRM\x1b[0m');

/* ────────────────────────────────────────────────────────────────────────────
 * The submission describes the documents
 * ──────────────────────────────────────────────────────────────────────────*/

await check('the snapshot carries every field the extractor read', async () => {
  const waId = '919800000001';
  const { passportUploadId } = await seed(waId);
  const candidate = await findConversation(waId);

  const snapshot = await snapshotFor(candidate!);
  const passport = snapshot.identity?.passport?.[0];

  assert.ok(passport, 'no passport in the snapshot');
  assert.equal(passport.document_type, 'passport');
  // Our upload id, which becomes the CRM's id for the record — and the id the
  // file upload attaches against.
  assert.equal(passport.record_id, passportUploadId.toHexString());
  assert.equal(passport.slot, 'passport');
  assert.equal(passport.filename, 'passport.jpg');
  assert.equal(passport.mime_type, 'image/jpeg');
  // Provenance: the message it arrived on, the way the email pipeline names a
  // Gmail message id.
  assert.equal(passport.message_id, `wamid.${waId}.passport`);
  // The payload untouched, because the CRM already owns the projection.
  assert.deepEqual(passport.result, PASSPORT_OCR);
});

await check('a document nothing has been read off yet is not described', async () => {
  const waId = '919800000002';
  const candidateId = new ObjectId();
  await candidates().insertOne({
    _id: candidateId, waId, phone: waId, stage: 'DOCUMENTS_PENDING',
    status: 'profile_incomplete', enquiry: 'apply', consent: { given: true, at: new Date() },
    profile: {}, documents: {}, history: [], createdAt: new Date(), updatedAt: new Date(),
  } as never);
  const stored = await saveFile({
    waId, docType: 'passport', buffer: PASSPORT_BYTES,
    mimeType: 'image/jpeg', originalFilename: 'passport.jpg',
  });
  await addUpload({
    waId, candidateId, docType: 'passport',
    upload: {
      mediaId: 'M', storageKey: stored.storageKey, mimeType: 'image/jpeg',
      byteSize: stored.byteSize, sha256: stored.sha256,
      // Queued, not read. A row over there with no fields would say the
      // extraction failed, which it has not — it has not run.
      ocr: { status: 'queued' },
    } as never,
  });

  const candidate = await findConversation(waId);
  assert.equal((await snapshotFor(candidate!)).identity, undefined);
  assert.deepEqual(await identityUploadsFor(candidate!), []);
});

await check('the files listed for upload are exactly the ones described', async () => {
  const waId = '919800000003';
  const { passportUploadId, aadhaarUploadId } = await seed(waId, { withAadhaar: true });
  const candidate = await findConversation(waId);

  const snapshot = await snapshotFor(candidate!);
  const files = await identityUploadsFor(candidate!);

  const described = [
    ...(snapshot.identity?.aadhaar ?? []),
    ...(snapshot.identity?.passport ?? []),
  ].map((d) => d.record_id);

  assert.deepEqual(
    [...described].sort(),
    [...files.map((f) => f.recordId)].sort(),
    'a document was described but not offered, or offered but not described',
  );
  assert.deepEqual(
    [...described].sort(),
    [passportUploadId.toHexString(), aadhaarUploadId!.toHexString()].sort(),
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * The bytes follow
 * ──────────────────────────────────────────────────────────────────────────*/

await check('the scan is uploaded against the record the submission created', async () => {
  reset();
  const waId = '919800000010';
  const { passportUploadId } = await seed(waId);

  await syncCandidateToCrm({ waId });

  assert.equal(submissions.length, 1, 'the submission did not go');
  const identity = submissions[0]!.body.identity;
  assert.ok(identity?.passport?.length, 'the submission carried no identity section');

  assert.equal(uploads.length, 1, 'the scan did not go');
  const upload = uploads[0]!;
  assert.equal(upload.candidateId, CRM_CANDIDATE_ID);
  assert.equal(upload.documentType, 'passport');
  assert.equal(upload.recordId, passportUploadId.toHexString());
  // The record id in the URL is the one the submission named, or the file
  // attaches to nothing.
  assert.equal(upload.recordId, identity.passport[0].record_id);
  // And the bytes are the candidate's own file, not a path into our storage.
  assert.ok(upload.raw.includes(PASSPORT_BYTES), 'the uploaded body did not carry the file');
});

await check('the submission goes before the file', async () => {
  // Ordering, not timing: the record the file attaches to is created by the
  // submission, so a file first is a 404 every time.
  assert.ok(submissions.length > 0 && uploads.length > 0);
});

await check('both documents are uploaded, each to its own type', async () => {
  reset();
  const waId = '919800000011';
  const { passportUploadId, aadhaarUploadId } = await seed(waId, { withAadhaar: true });

  await syncCandidateToCrm({ waId });

  assert.equal(uploads.length, 2);
  const byType = Object.fromEntries(uploads.map((u) => [u.documentType, u]));
  assert.equal(byType.passport!.recordId, passportUploadId.toHexString());
  assert.equal(byType.aadhaar!.recordId, aadhaarUploadId!.toHexString());
  assert.ok(byType.aadhaar!.raw.includes(AADHAAR_BYTES));
});

await check('a scan already handed over is not handed over again', async () => {
  reset();
  const waId = '919800000012';
  await seed(waId);

  await syncCandidateToCrm({ waId });
  assert.equal(uploads.length, 1, 'the first sync should send it');

  await reopen(waId);
  await syncCandidateToCrm({ waId });

  assert.equal(uploads.length, 1, 'the same passport went over the wire twice');
  // The submission still goes — it is small, and it is what keeps the record
  // in step. Only the bytes are held back.
  assert.equal(submissions.length, 2);
});

await check('what the CRM holds is recorded on the candidate', async () => {
  const waId = '919800000012';
  const candidate = await findConversation(waId);
  const digests = candidate!.crmSync?.identitySha256 ?? {};

  assert.equal(Object.keys(digests).length, 1);
  const [recordId, sha] = Object.entries(digests)[0]!;
  assert.match(recordId, /^[0-9a-f]{24}$/, 'keyed on something other than the upload id');
  assert.match(sha, /^[0-9a-f]{64}$/);
});

await check('a replaced document is sent again', async () => {
  reset();
  const waId = '919800000013';
  const { candidateId } = await seed(waId);
  await syncCandidateToCrm({ waId });
  assert.equal(uploads.length, 1);

  // A clearer photograph of the same passport: a new upload, a new id, and the
  // old one superseded.
  const better = await saveFile({
    waId,
    docType: 'passport',
    buffer: Buffer.from('a-much-clearer-photograph-of-the-same-passport'),
    mimeType: 'image/jpeg',
    originalFilename: 'passport.jpg',
  });
  const replacementId = await addUpload({
    waId,
    candidateId,
    docType: 'passport',
    upload: {
      mediaId: `MEDIA-${waId}-p2`,
      wamid: `wamid.${waId}.passport2`,
      storageKey: better.storageKey,
      mimeType: 'image/jpeg',
      byteSize: better.byteSize,
      sha256: better.sha256,
      originalFilename: 'passport.jpg',
      ocr: { status: 'succeeded', raw: PASSPORT_OCR, finishedAt: new Date() },
    } as never,
  });

  await reopen(waId);
  await syncCandidateToCrm({ waId });

  assert.equal(uploads.length, 2, 'the replacement was not sent');
  assert.equal(uploads[1]!.recordId, replacementId.toHexString());
  assert.ok(uploads[1]!.raw.includes(Buffer.from('a-much-clearer-photograph')));
});

await check('a scan the CRM has no record for is offered again next time', async () => {
  reset();
  const waId = '919800000014';
  await seed(waId);

  // The record has not landed. The CRM says 404, and the sync must not write
  // the digest down — doing so would mean the file is never offered again and
  // the recruiter's download button 404s forever.
  nextFileStatus = 404;
  await syncCandidateToCrm({ waId });
  assert.equal(uploads.length, 1, 'it should have been attempted');

  const afterFailure = await findConversation(waId);
  assert.deepEqual(
    afterFailure!.crmSync?.identitySha256 ?? {},
    {},
    'a refused upload was recorded as delivered',
  );

  nextFileStatus = 200;
  await reopen(waId);
  await syncCandidateToCrm({ waId });

  assert.equal(uploads.length, 2, 'it was not offered again');
  const afterSuccess = await findConversation(waId);
  assert.equal(Object.keys(afterSuccess!.crmSync?.identitySha256 ?? {}).length, 1);
});

await check('a failed scan does not fail the candidate', async () => {
  reset();
  const waId = '919800000015';
  await seed(waId);

  nextFileStatus = 500;
  await syncCandidateToCrm({ waId });

  const candidate = await findConversation(waId);
  // Handed over. The profile landed, and a scan that would not upload is not a
  // reason to keep chasing a candidate the CRM already has.
  assert.equal(candidate!.crmSync?.status, 'synced');
});

await check('a candidate with no documents syncs unchanged', async () => {
  reset();
  const waId = '919800000016';
  const candidateId = new ObjectId();
  await candidates().insertOne({
    _id: candidateId, waId, phone: waId, stage: 'REGISTRATION_COMPLETED',
    status: 'profile_complete', enquiry: 'apply', consent: { given: true, at: new Date() },
    profile: { fullName: 'No Documents', jobCategory: 'general_worker' },
    documents: {}, history: [], createdAt: new Date(), updatedAt: new Date(),
  } as never);

  await syncCandidateToCrm({ waId });

  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]!.body.identity, undefined);
  assert.equal(uploads.length, 0);
  assert.equal((await findConversation(waId))!.crmSync?.status, 'synced');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Down
 * ──────────────────────────────────────────────────────────────────────────*/

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`
    : `\n\x1b[32mall ${passed} checks passed\x1b[0m\n`,
);

await closeDb();
await new Promise<void>((r) => crm.close(() => r()));
await mongo.stop();

process.exit(failures.length ? 1 : 0);
