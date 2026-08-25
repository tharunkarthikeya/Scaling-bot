/**
 * Where an Aadhaar actually lands, driven against a database that is running.
 *
 *   npm run e2e:ats
 *
 * `smoke` asserts the routing table says `aadhaar_records`. That is a string
 * compared against a string, and it stayed green through the whole period when
 * `resume_ats` had two Aadhaar collections in it — because the name was right
 * and the rows were somewhere else. A table is not a destination.
 *
 * So this runs the real `ensureAtsCollections` and the real `exportToAts`
 * against an in-process MongoDB, sends an Aadhaar through as a candidate would,
 * and then reads `resume_ats` back to answer the two questions that matter:
 *
 *   1. Did the row land in `aadhaar_records`?
 *   2. Does it say `source: 'whatsapp'`?
 *
 * and the one that caused the mess in the first place:
 *
 *   3. Is `aadhar_records` — one `a` — still absent? Boot must not create it,
 *      and neither must a document going through.
 *
 * Nothing here touches a real database. Mongo runs in-process for the duration
 * and is thrown away at the end.
 */
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import type { CandidateDoc } from './db/models.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let failures = 0;

function check(ok: boolean, name: string, detail = ''): boolean {
  if (!ok) failures++;
  console.log(
    `  ${ok ? `${GREEN}ok  ${RESET}` : `${RED}FAIL${RESET}`}  ${name}` +
      `${detail ? `  ${DIM}${detail}${RESET}` : ''}`,
  );
  return ok;
}

function heading(text: string): void {
  console.log(`\n${BOLD}${text}${RESET}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Boot
 *
 * Set before importing config: dotenv does not overwrite variables already in
 * the environment, so these win over `.env` and this can never be pointed at
 * the real deployment by accident.
 * ──────────────────────────────────────────────────────────────────────────*/

const mongo = await MongoMemoryServer.create();

process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'adira_e2e_ats_bot';
process.env.RESUME_ATS_DB = 'adira_e2e_ats';
process.env.SHADOW_MODE = 'true';
process.env.STORAGE_PATH = path.join(os.tmpdir(), 'adira-e2e-ats-storage');
process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? 'warn';

const { config } = await import('./config.js');
const { connectDb, closeDb } = await import('./db/client.js');
const { addUpload, candidates, b2bEnquiries } = await import('./db/models.js');
const { ensureAtsCollections, atsDb, ATS_COLLECTIONS, LEGACY_AADHAAR_COLLECTION } = await import(
  './ats/client.js',
);
const { exportToAts } = await import('./ats/export.js');

/** The misspelling this whole check exists to keep out. */
const LEGACY: string = LEGACY_AADHAAR_COLLECTION;

console.log(`\n${BOLD}Aadhaar → resume_ats — end to end${RESET}`);
console.log(`${DIM}ats db: ${config.RESUME_ATS_DB}   mongo: in-process${RESET}`);

await connectDb();

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────*/

const names = async (): Promise<Set<string>> =>
  new Set((await atsDb().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

const aadhaarRows = () => atsDb().collection(ATS_COLLECTIONS.aadhaarRecords);
const agentAadhaarRows = () => atsDb().collection(ATS_COLLECTIONS.b2bAgentAadhaar);

/** A finished conversation, as the engine would have left it. */
function conversation(waId: string, enquiry: CandidateDoc['enquiry']): CandidateDoc {
  const now = new Date();
  return {
    _id: new ObjectId(),
    waId,
    phone: waId,
    enquiry,
    candidateId: enquiry === 'b2b' ? undefined : 'ADR-E2E-0001',
    stage: 'REGISTRATION_COMPLETED',
    status: 'documents_received',
    profile: { fullName: 'E2E Aadhaar' },
    fieldMeta: {},
    history: [],
    documents: {},
    createdAt: now,
    completedAt: now,
    lastInboundAt: now,
    updatedAt: now,
  } as CandidateDoc;
}

/** One file arriving, with an extraction on it, exactly as the OCR worker leaves it. */
async function sendDocument(c: CandidateDoc, docType: string, name: string): Promise<ObjectId> {
  return addUpload({
    waId: c.waId,
    candidateId: c._id!,
    docType,
    upload: {
      mediaId: `media_${name}`,
      storageKey: `e2e/${c.waId}/${name}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      sha256: `sha_${name}`,
      originalFilename: `${name}.pdf`,
      ocr: {
        status: 'done',
        extractor: 'aadhaar',
        fields: [{ key: 'aadhaar_number', value: '1234 5678 9012', confidence: 0.97 }],
        finishedAt: new Date(),
      },
    },
  } as Parameters<typeof addUpload>[0]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Boot
 * ──────────────────────────────────────────────────────────────────────────*/

heading('boot');

await ensureAtsCollections();

{
  const present = await names();
  check(present.has(ATS_COLLECTIONS.aadhaarRecords), '`aadhaar_records` exists after boot');
  check(!present.has(LEGACY), '`aadhar_records` is NOT created at boot', 'the misspelling stays gone');

  // The general rule behind the specific one: exactly two collections in this
  // database are about an Aadhaar, and they are the two that are meant to be.
  const aadhaarish = [...present].filter((n) => n.includes('adha')).sort();
  check(
    JSON.stringify(aadhaarish) ===
      JSON.stringify([ATS_COLLECTIONS.aadhaarRecords, ATS_COLLECTIONS.b2bAgentAadhaar].sort()),
    'no third Aadhaar collection exists',
    aadhaarish.join(', '),
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. A candidate's Aadhaar, both sides
 * ──────────────────────────────────────────────────────────────────────────*/

heading('a candidate sends an Aadhaar');

const applicant = conversation('919000000101', 'apply');
await candidates().insertOne(applicant);
await sendDocument(applicant, 'aadhaar', 'aadhaar-front');
await sendDocument(applicant, 'aadhaar_back', 'aadhaar-back');

await exportToAts({ waId: applicant.waId });

{
  const rows = await aadhaarRows().find({ waId: applicant.waId }).toArray();
  check(rows.length === 2, 'both sides land in `aadhaar_records`', `${rows.length} row(s)`);

  check(
    rows.length > 0 && rows.every((r) => r.source === 'whatsapp'),
    "every row says source: 'whatsapp'",
    [...new Set(rows.map((r) => String(r.source)))].join(', '),
  );

  const kinds = rows.map((r) => String(r.documentType)).sort();
  check(
    JSON.stringify(kinds) === JSON.stringify(['aadhaar', 'aadhaar_back']),
    '`documentType` says which side is which',
    kinds.join(', '),
  );

  check(
    rows.every((r) => Array.isArray((r.ocr as { fields?: unknown[] })?.fields)),
    'what the extractor read came across with them',
  );

  check(!(await names()).has(LEGACY), 'exporting did not resurrect `aadhar_records`');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. A second copy of the front, and a re-export
 * ──────────────────────────────────────────────────────────────────────────*/

heading('they re-send the front, and the export runs again');

await sendDocument(applicant, 'aadhaar', 'aadhaar-front-2');
await exportToAts({ waId: applicant.waId });
// Twice more, because the queue retries and a late extraction re-runs it.
await exportToAts({ waId: applicant.waId });

{
  const rows = await aadhaarRows().find({ waId: applicant.waId }).toArray();
  check(rows.length === 3, 'every version is kept, and no row is duplicated', `${rows.length} row(s)`);

  const fronts = rows.filter((r) => r.documentType === 'aadhaar');
  const current = fronts.filter((r) => r.isCurrent === true);
  check(
    current.length === 1,
    'exactly one front is `isCurrent`',
    `${current.length} of ${fronts.length}`,
  );

  check(rows.every((r) => r.source === 'whatsapp'), "the new rows say source: 'whatsapp' too");
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. A B2B agent's Aadhaar goes somewhere else
 * ──────────────────────────────────────────────────────────────────────────*/

heading("a sourcing agent's own Aadhaar");

const agent = conversation('919000000102', 'b2b');
await b2bEnquiries().insertOne(agent);
await sendDocument(agent, 'b2b_aadhaar_front', 'b2b-front');
await sendDocument(agent, 'b2b_aadhaar_back', 'b2b-back');

const candidateRowsBefore = await aadhaarRows().countDocuments({});

await exportToAts({ waId: agent.waId });

{
  const agentRows = await agentAadhaarRows().find({ waId: agent.waId }).toArray();
  check(agentRows.length === 2, "the agent's card lands in `b2b_agent_aadhar`", `${agentRows.length} row(s)`);
  check(
    agentRows.length > 0 && agentRows.every((r) => r.source === 'whatsapp'),
    "the agent's rows say source: 'whatsapp'",
  );

  // The point of the separate collection: an agent must never appear in the
  // candidates' Aadhaar records.
  check(
    (await aadhaarRows().countDocuments({})) === candidateRowsBefore,
    '`aadhaar_records` is untouched by a B2B export',
  );
  check(
    (await aadhaarRows().countDocuments({ waId: agent.waId })) === 0,
    'the agent has no row in `aadhaar_records`',
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. What `npm run inspect:ats` will show
 * ──────────────────────────────────────────────────────────────────────────*/

heading('read back the way a recruiter would');

{
  // The inspector filters on exactly this. A row the bot wrote that does not
  // match it is a row nobody will ever find.
  const mine = await aadhaarRows().countDocuments({ source: 'whatsapp' });
  const all = await aadhaarRows().countDocuments({});
  check(mine === all && all === 3, 'every row in `aadhaar_records` is findable as ours', `${mine}/${all}`);

  const present = await names();
  check(!present.has(LEGACY), '`aadhar_records` was never created, start to finish');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. If the old name ever comes back
 * ──────────────────────────────────────────────────────────────────────────*/

heading('the old name, put back by hand');

{
  // Standing in for an older image booting against this database. Boot must
  // notice it and must not touch it: dropping a populated collection because a
  // deploy did not expect it is how data nobody agreed to lose disappears.
  await atsDb().collection(LEGACY).insertOne({ waId: 'stray', uploadId: 'x1', source: 'whatsapp' });

  await ensureAtsCollections();

  check(
    (await names()).has(LEGACY),
    'boot leaves it standing rather than dropping it',
    'a warning is logged; the migration is what removes it',
  );
  check(
    (await atsDb().collection(LEGACY).countDocuments({})) === 1,
    'and does not touch what is in it',
  );

  // And the export still goes to the right place regardless of what else is in
  // the database. This is the check that would have failed all along.
  await exportToAts({ waId: applicant.waId });
  check(
    (await atsDb().collection(LEGACY).countDocuments({ waId: applicant.waId })) === 0,
    'a new Aadhaar still goes to `aadhaar_records`, not the old name',
  );
  check(
    (await aadhaarRows().countDocuments({ waId: applicant.waId, source: 'whatsapp' })) === 3,
    "and still says source: 'whatsapp'",
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Done
 * ──────────────────────────────────────────────────────────────────────────*/

await closeDb();
await mongo.stop();

if (failures) {
  console.log(`\n${RED}${failures} check(s) failed${RESET}\n`);
  process.exit(1);
}

console.log(`\n${GREEN}every check passed${RESET}\n`);
process.exit(0);
