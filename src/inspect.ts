/**
 * Prints what the bot has collected, straight from the database.
 *
 *   npm run inspect                    every candidate, summarised
 *   npm run inspect 919994690490       one candidate in full, with OCR fields
 *   npm run inspect --review           only documents awaiting human review
 *
 * Connects to the same embedded database dev:local uses, so it works whether or
 * not the bot is currently running.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';

const args = process.argv.slice(2);
const reviewOnly = args.includes('--review');
const waIdArg = args.find((a) => !a.startsWith('--'));

const dbPath = path.resolve('.mongo-data');
await fs.mkdir(dbPath, { recursive: true });

// Reuse a running instance's port if there is one; otherwise start against the
// same on-disk data directory.
let mongo;
try {
  mongo = await MongoMemoryServer.create({
    instance: { port: 27017, dbName: 'mountroad_wa_bot', dbPath, storageEngine: 'wiredTiger' },
  });
} catch {
  console.error(
    'Could not open the database on port 27017.\n' +
      'If `npm run dev:local` is running, stop it first — the two cannot hold the same data directory.',
  );
  process.exit(1);
}

process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'mountroad_wa_bot';

const { connectDb, closeDb } = await import('./db/client.js');
const { candidates, storedDocuments } = await import('./db/models.js');

await connectDb();

const B = '\x1b[1m';
const D = '\x1b[2m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[0m';

function fieldTable(fields: Array<{ key: string; value: string; confidence: number | null }>) {
  for (const f of fields) {
    const conf = f.confidence == null ? `${D}unscored${R}` : `${D}${f.confidence.toFixed(2)}${R}`;
    const value = f.value.length > 60 ? f.value.slice(0, 57) + '...' : f.value;
    console.log(`      ${f.key.padEnd(24)} ${value.padEnd(62)} ${conf}`);
  }
}

if (reviewOnly) {
  const docs = await storedDocuments()
    .find({ 'ocr.needsReview': true })
    .sort({ createdAt: -1 })
    .toArray();

  console.log(`\n${B}Documents awaiting review: ${docs.length}${R}\n`);
  for (const d of docs) {
    console.log(`${B}${d.docType}${R}  ${d.waId}  ${D}${d.originalFilename ?? ''}${R}`);
    for (const r of d.ocr?.reviewReasons ?? []) console.log(`  ${Y}why:${R} ${r}`);
    fieldTable(d.ocr?.fields ?? []);
    console.log('');
  }
} else if (waIdArg) {
  const candidate = await candidates().findOne({ waId: waIdArg });
  if (!candidate) {
    console.log(`no candidate with waId ${waIdArg}`);
  } else {
    console.log(`\n${B}${candidate.profileName ?? 'unknown'}${R}  ${candidate.waId}`);
    console.log(`  candidate id  ${candidate.candidateId ?? '—'}`);
    console.log(`  stage         ${candidate.stage}`);
    console.log(`  status        ${candidate.status}`);
    console.log(`  language      ${candidate.language ?? '—'}${candidate.languageOther ? ` (${candidate.languageOther})` : ''}`);
    console.log(
      `  consent       ${candidate.consent?.given ? `given ${candidate.consent.at.toISOString().slice(0, 10)}` : '—'}`,
    );
    console.log(`  on question   ${candidate.currentStep ?? '—'}`);

    // Every field with where it came from — §27 wants the source visible, not
    // just the value.
    const profileEntries = Object.entries(candidate.profile ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== '',
    );
    console.log(`\n  ${B}profile (${profileEntries.length} fields)${R}`);
    for (const [key, value] of profileEntries) {
      const meta = candidate.fieldMeta?.[key];
      const shown = Array.isArray(value) ? value.join(', ') : String(value);
      const origin = meta ? `${D}from ${meta.source}${meta.raw ? ` — "${meta.raw}"` : ''}${R}` : '';
      console.log(`    ${key.padEnd(24)} ${shown.slice(0, 44).padEnd(46)} ${origin}`);
    }

    console.log(`\n  ${B}checklist${R}`);
    for (const [id, slot] of Object.entries(candidate.documents)) {
      console.log(`    ${id.padEnd(20)} ${slot.status}  ${D}asked ${slot.askedCount}x${R}`);
    }

    const docs = await storedDocuments().find({ waId: waIdArg }).sort({ createdAt: 1 }).toArray();
    console.log(`\n  ${B}documents (${docs.length})${R}`);
    for (const d of docs) {
      const ok = d.ocr?.status === 'done';
      console.log(
        `\n    ${ok ? G + '✓' : Y + '~'}${R} ${d.docType}  ${D}${d.originalFilename ?? d.storageKey}${R}`,
      );
      console.log(
        `      ${D}ocr=${d.ocr?.status ?? 'none'}${d.ocr?.extractor ? '/' + d.ocr.extractor : ''}` +
          `  fields=${d.ocr?.fields?.length ?? 0}  needsReview=${d.ocr?.needsReview ?? false}${R}`,
      );
      if (d.ocr?.error) console.log(`      ${Y}error: ${d.ocr.error.slice(0, 100)}${R}`);
      fieldTable(d.ocr?.fields ?? []);
    }
  }
} else {
  const rows = await candidates().find({}).sort({ updatedAt: -1 }).limit(50).toArray();
  console.log(`\n${B}Candidates: ${rows.length}${R}\n`);
  for (const c of rows) {
    const docCount = await storedDocuments().countDocuments({ waId: c.waId });
    console.log(
      `  ${c.waId.padEnd(16)} ${(c.candidateId ?? '—').padEnd(11)} ` +
        `${(c.profileName ?? '').padEnd(16)} ${c.stage.padEnd(24)} ` +
        `${D}${docCount} docs, on ${c.currentStep ?? '—'}${R}`,
    );
  }
  console.log(`\n${D}  npm run inspect <waId>     full detail with OCR fields`);
  console.log(`  npm run inspect --review   documents needing a human${R}\n`);
}

await closeDb();
await mongo.stop();
process.exit(0);
