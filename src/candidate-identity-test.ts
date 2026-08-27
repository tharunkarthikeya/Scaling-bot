/**
 * Passport-first candidate resolution against an isolated in-memory CRM DB.
 * No environment value from .env is used and no network service is contacted.
 */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Collection, type Document } from 'mongodb';
import {
  resolveAtsCandidate,
  writeResolvedAtsCandidate,
  type AtsIdentityKeys,
} from './ats/identity.js';
import { normalizeAadhaarNumber, normalizeContactNumber, normalizePassportNumber } from './identity.js';

const mongo = await MongoMemoryServer.create();
const client = new MongoClient(mongo.getUri());
await client.connect();
const candidates = client.db('candidate_identity_test').collection('candidates');

let passed = 0;
const failures: string[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  await candidates.deleteMany({});
  try {
    await run();
    passed++;
    console.log(`  \x1b[32mok\x1b[0m  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.error(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

function contact(number: string, source: 'whatsapp' | 'resume' = 'whatsapp') {
  return { number, normalized: normalizeContactNumber(number)!, sources: [source] };
}

function identity(params: {
  waId: string;
  passport?: string;
  aadhaar?: string;
  resumePhone?: string;
}): AtsIdentityKeys {
  return {
    waId: params.waId,
    passport: normalizePassportNumber(params.passport),
    aadhaar: normalizeAadhaarNumber(params.aadhaar),
    contacts: [
      contact(params.waId),
      ...(params.resumePhone ? [contact(params.resumePhone, 'resume')] : []),
    ],
  };
}

async function write(params: {
  waId: string;
  passport?: string;
  aadhaar?: string;
  resumePhone?: string;
  name?: string;
  stage?: string;
}) {
  return writeResolvedAtsCandidate({
    collection: candidates,
    row: {
      source: 'whatsapp',
      waId: params.waId,
      fullName: params.name,
      passportNumber: params.passport,
      aadhaarNumber: params.aadhaar,
      stage: params.stage,
    },
    identity: identity(params),
  });
}

console.log('\n\x1b[1mPassport-first candidate identity\x1b[0m');

await check('same passport + different WhatsApp numbers -> one candidate', async () => {
  await write({ waId: '919800000001', passport: 'z 123-4567' });
  const second = await write({ waId: '919800000002', passport: 'Z1234567' });
  assert.equal(second.matchedBy, 'passport');
  assert.equal(await candidates.countDocuments(), 1);
  const row = await candidates.findOne({});
  assert.deepEqual(row!.waIds.sort(), ['919800000001', '919800000002']);
  assert.deepEqual(
    new Set(row!.contactNumbersNormalized),
    new Set(['919800000001', '919800000002']),
  );
});

await check('different resume and WhatsApp phones remain on the same candidate', async () => {
  await write({
    waId: '919800000010',
    resumePhone: '+971 50 123 4567',
    passport: 'P7654321',
  });
  const row = await candidates.findOne({});
  assert.equal(await candidates.countDocuments(), 1);
  assert.deepEqual(
    new Set(row!.contactNumbersNormalized),
    new Set(['919800000010', '971501234567']),
  );
});

await check('CV first -> passport later stays on the same candidate', async () => {
  await write({ waId: '919800000020', resumePhone: '+91 98765 43210', stage: 'CV_RECEIVED' });
  const later = await write({
    waId: '919800000020',
    resumePhone: '+91 98765 43210',
    passport: 'N1234567',
    stage: 'PASSPORT_RECEIVED',
  });
  assert.equal(later.matchedBy, 'phone');
  assert.equal(await candidates.countDocuments(), 1);
  assert.equal((await candidates.findOne({}))!.passportNumberNormalized, 'N1234567');
});

await check('partial registration -> passport later stays on the same candidate', async () => {
  await write({ waId: '919800000030', stage: 'PROFILE_IN_PROGRESS' });
  await write({ waId: '919800000030', passport: 'R1234567', stage: 'DOCUMENTS_PENDING' });
  assert.equal(await candidates.countDocuments(), 1);
});

await check('passport first -> later WhatsApp registration stays on the same candidate', async () => {
  await write({ waId: '919800000040', passport: 'T1234567', stage: 'PASSPORT_ONLY' });
  const later = await write({
    waId: '919800000041',
    passport: 't 123 4567',
    stage: 'REGISTRATION_COMPLETED',
  });
  assert.equal(later.matchedBy, 'passport');
  assert.equal(await candidates.countDocuments(), 1);
});

await check('different passports + same phone do not merge', async () => {
  await write({ waId: '919800000050', passport: 'A1234567' });
  await write({ waId: '919800000050', passport: 'B1234567' });
  assert.equal(await candidates.countDocuments(), 2);
  assert.deepEqual(
    (await candidates.find({}).toArray()).map((row) => row.passportNumberNormalized).sort(),
    ['A1234567', 'B1234567'],
  );
});

await check('same name + different passports creates two candidates', async () => {
  await write({ waId: '919800000060', name: 'Same Name', passport: 'C1234567' });
  await write({ waId: '919800000061', name: 'Same Name', passport: 'D1234567' });
  assert.equal(await candidates.countDocuments(), 2);
});

await check('an existing duplicate passport is flagged, never silently merged', async () => {
  await candidates.insertMany([
    { waId: '919800000070', passportNumber: 'X 123-4567', source: 'email' },
    { waId: '919800000071', passport_number: 'x1234567', source: 'legacy-import' },
  ]);
  const result = await write({ waId: '919800000072', passport: 'X1234567' });
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflictType, 'duplicate_passport');
  assert.equal(await candidates.countDocuments(), 2, 'a third record was created');
  const flagged = await candidates.countDocuments({
    manualReviewRequired: true,
    'identityConflict.type': 'duplicate_passport',
  });
  assert.equal(flagged, 2);
});

await check('Aadhaar is secondary and cannot override a conflicting passport', async () => {
  await write({ waId: '919800000080', passport: 'K1234567', aadhaar: '1234 5678 9012' });
  const second = await write({
    waId: '919800000081',
    passport: 'L1234567',
    aadhaar: '123456789012',
  });
  assert.equal(second.status, 'new');
  assert.equal(second.conflictType, 'aadhaar_passport_mismatch');
  assert.equal(await candidates.countDocuments(), 2);
  assert.equal(await candidates.countDocuments({ manualReviewRequired: true }), 2);
});

await check('name is not an identity input', async () => {
  const source = await candidates.insertOne({ fullName: 'Only A Name' });
  const result = await resolveAtsCandidate(candidates as Collection<Document>, {
    waId: '919800000090',
    contacts: [contact('919800000090')],
  });
  assert.equal(result.status, 'new');
  assert.equal(result.target?._id.toString(), undefined);
  assert.ok(source.insertedId);
});

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`
    : `\n\x1b[32mall ${passed} checks passed\x1b[0m\n`,
);

await client.close();
await mongo.stop();
process.exit(failures.length ? 1 : 0);
