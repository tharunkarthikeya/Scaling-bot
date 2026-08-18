/**
 * Clears a test number so the next message starts a conversation from scratch.
 *
 *   npm run reset -- 9994690490            what would go (nothing is deleted)
 *   npm run reset -- 9994690490 --delete   delete it
 *   npm run reset -- --all                 inventory of every number on file
 *   npm run reset -- --all --delete        clear the whole database
 *
 * This is not the §23 deletion a candidate can ask for. That one tombstones the
 * profile and keeps an audit record on purpose, because a real person withdrew
 * consent and we have to be able to show when. This removes the rows outright,
 * which is only ever right for a number you are testing with.
 *
 * The `processed_events` rows matter as much as the candidate does. They are the
 * wamid claims that drop Meta's redeliveries; leave them behind and the first
 * message of the next test can be silently discarded as a duplicate, which looks
 * exactly like the bot ignoring you.
 *
 * Runs against MONGODB_URI, and prints it before doing anything — the guard
 * against clearing something that is not a test database is that you can see
 * which one you are pointed at.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { config } from './config.js';

const args = process.argv.slice(2);
const commit = args.includes('--delete');
const all = args.includes('--all');
const target = args.find((a) => !a.startsWith('--'));

if (!target && !all) {
  console.error(
    'usage:\n' +
      '  npm run reset -- <number>            show what would go\n' +
      '  npm run reset -- <number> --delete   delete it\n' +
      '  npm run reset -- --all [--delete]    every number on file',
  );
  process.exit(1);
}

/**
 * Candidates give a number every which way; the database holds it with the
 * country code, because that is what Meta sends. Both are tried so a ten-digit
 * argument still finds the record.
 */
function variantsOf(raw: string): string[] {
  const digits = raw.replace(/\D/g, '');
  return [...new Set([digits, digits.startsWith('91') ? digits.slice(2) : `91${digits}`])];
}

const client = new MongoClient(config.MONGODB_URI);
await client.connect();
const db = client.db(config.MONGODB_DB);

console.log(`\ndatabase  ${config.MONGODB_URI}`);
console.log(`           ${config.MONGODB_DB}\n`);

const waIds: string[] = all
  ? await db.collection('candidates').distinct('waId')
  : variantsOf(target!);

let totalRows = 0;

for (const waId of waIds) {
  const q = { waId };
  const candidate = await db.collection('candidates').findOne(q);

  // The wamid claims are keyed by message id, not by waId, so they have to be
  // found through this number's messages before those messages are deleted.
  const wamids = (
    await db.collection('messages').find(q, { projection: { 'turns.wamid': 1 } }).toArray()
  )
    .flatMap((session) => (session.turns ?? []) as Array<{ wamid?: string }>)
    .map((turn) => turn.wamid)
    .filter((w): w is string => !!w);

  const counts: Record<string, number> = {
    candidates: await db.collection('candidates').countDocuments(q),
    // Sessions now, not messages — one document per sitting.
    messages: await db.collection('messages').countDocuments(q),
    // One record per candidate now, holding every upload in its section.
    documents: await db.collection('documents').countDocuments(q),
    audit_events: await db.collection('audit_events').countDocuments(q),
    processed_events: wamids.length
      ? await db.collection('processed_events').countDocuments({ wamid: { $in: wamids } })
      : 0,
  };

  const rows = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!rows) {
    if (!all) console.log(`${waId}  nothing on file`);
    continue;
  }
  totalRows += rows;

  const name = candidate?.profile?.fullName ?? candidate?.profileName ?? '—';
  console.log(
    `${waId}  ${String(name).slice(0, 24).padEnd(26)}` +
      `${candidate?.candidateId ?? '—'}  ${candidate?.stage ?? '—'}`,
  );
  console.log(
    '            ' +
      Object.entries(counts)
        .filter(([, n]) => n)
        .map(([k, n]) => `${k} ${n}`)
        .join(', '),
  );

  const dir = path.resolve(config.STORAGE_PATH, waId);
  let hasFiles = false;
  try {
    await fs.stat(dir);
    hasFiles = true;
    console.log(`            files ${dir}`);
  } catch {
    /* nothing stored for this number */
  }

  if (!commit) continue;

  await db.collection('candidates').deleteMany(q);
  await db.collection('messages').deleteMany(q);
  await db.collection('documents').deleteMany(q);
  await db.collection('audit_events').deleteMany(q);
  if (wamids.length) {
    await db.collection('processed_events').deleteMany({ wamid: { $in: wamids } });
  }
  if (hasFiles) await fs.rm(dir, { recursive: true, force: true });

  console.log(`            \x1b[32mcleared\x1b[0m`);
}

if (!totalRows) {
  console.log('nothing on file.\n');
} else if (commit) {
  console.log(`\n${waIds.length} number(s) cleared — the next message starts at the welcome.\n`);
} else {
  console.log('\n[dry run] nothing deleted. add --delete to clear the above.\n');
}

await client.close();
