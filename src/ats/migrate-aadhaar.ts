/**
 * The one-off that folds `aadhar_records` into `aadhaar_records`.
 *
 *   npm run migrate:aadhaar             what would move (nothing is written)
 *   npm run migrate:aadhaar -- --apply  move it, then drop the old collection
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY THERE ARE TWO OF THEM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An earlier build spelled the collection `aadhar_records`, with one `a`. This
 * one spells it `aadhaar_records`, which is how the card is spelled and how
 * `ATS_COLLECTIONS` has named it since. `ensureAtsCollections` creates only what
 * is missing and never renames — correctly — so the deploy that changed the
 * spelling did not touch the rows already filed under the old name. It made a
 * second collection beside them, and `resume_ats` has had two Aadhaar sections
 * ever since: one being written to, one a dead end holding real uploads.
 *
 * This moves those rows across and removes the dead end. It is a one-off, but it
 * is written to be run twice: a second run finds nothing to move and says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE THREE RULES IT KEEPS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. THE DESTINATION WINS. A row already in `aadhaar_records` for the same
 *      upload was written by the current build and is newer than the copy under
 *      the old name. Every write here is `$setOnInsert` on the same natural key
 *      the export upserts on, so an old copy fills a gap and never overwrites a
 *      row in use.
 *   2. `source` SAYS WHATSAPP WHEN THE BOT PUT IT THERE. That is what tells a
 *      recruiter which rows in a shared collection came out of a conversation,
 *      and it is what `npm run inspect:ats` filters on. A row carrying some
 *      other source is copied across with it untouched — it is not ours to
 *      relabel.
 *   3. NOTHING IS DROPPED UNVERIFIED. The old collection goes only after every
 *      one of its rows has been found again in the new one. A count that does
 *      not add up leaves both collections standing and exits non-zero.
 *
 * Note that `b2b_agent_aadhar` is NOT this. It is spelled that way on purpose,
 * it holds a different document — the agent's own card, not a candidate's — and
 * renaming it would split it in two exactly as happened here.
 */

import type { Document } from 'mongodb';
import { config } from '../config.js';
import { closeDb, connectDb } from '../db/client.js';
import { atsConfigured, atsDb, ATS_COLLECTIONS, LEGACY_AADHAAR_COLLECTION } from './client.js';

/** The misspelling. Named in `ats/client.ts`, beside the collections in use. */
const LEGACY_COLLECTION: string = LEGACY_AADHAAR_COLLECTION;

/** Where the rows belong, and what the export has written to since. */
const TARGET_COLLECTION: string = ATS_COLLECTIONS.aadhaarRecords;

/** What a row the bot wrote says about where it came from. The export's token. */
const SOURCE = 'whatsapp' as const;

const apply = process.argv.includes('--apply');

/**
 * Whether the bot wrote this row.
 *
 * Two ways to be sure, because the old collection sits in a shared database and
 * a row in it is not automatically ours:
 *
 *   - it already says `whatsapp`, which every row the old build wrote did; or
 *   - it says nothing at all and carries the export's shape — a WhatsApp id and
 *     an upload id together are not something another system produces.
 *
 * Anything with a different `source` is somebody else's. It is copied across
 * unchanged rather than relabelled, and counted separately so the run tells you
 * it was there.
 */
function isOurs(row: Document): boolean {
  const source = typeof row.source === 'string' ? row.source.trim() : '';
  if (source) return source === SOURCE;
  return typeof row.waId === 'string' && !!row.waId && !!row.uploadId;
}

async function main(): Promise<number> {
  if (!atsConfigured()) {
    console.log('RESUME_ATS_DB is blank — the ATS export is off, so there is nothing to migrate.');
    return 0;
  }

  // Guards against the day somebody edits the constants above and the two names
  // become the same string. Copying a collection onto itself and then dropping
  // it destroys the data this file exists to save.
  if (LEGACY_COLLECTION === TARGET_COLLECTION) {
    console.error(`refusing to run: both names are "${LEGACY_COLLECTION}"`);
    return 1;
  }

  await connectDb();
  const db = atsDb();

  console.log(`\nats database  ${config.RESUME_ATS_DB}`);
  console.log(`from          ${LEGACY_COLLECTION}`);
  console.log(`into          ${TARGET_COLLECTION}`);
  console.log(apply ? 'mode          apply\n' : 'mode          dry run — nothing is written\n');

  const present = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );

  // Already done, or never happened on this deployment. Either way there is
  // nothing to move, and saying so plainly is what makes this safe to re-run.
  if (!present.has(LEGACY_COLLECTION)) {
    console.log(`${LEGACY_COLLECTION} is not in ${config.RESUME_ATS_DB}. Nothing to do.`);
    return 0;
  }

  const legacy = db.collection(LEGACY_COLLECTION);
  const target = db.collection(TARGET_COLLECTION);

  const rows = await legacy.find({}).toArray();
  const before = await target.countDocuments({});

  console.log(`${LEGACY_COLLECTION}   ${rows.length} row(s)`);
  console.log(`${TARGET_COLLECTION}  ${before} row(s) already there\n`);

  if (!rows.length) {
    if (apply) {
      await legacy.drop();
      console.log(`empty — dropped ${LEGACY_COLLECTION}.`);
    } else {
      console.log(`empty — ${LEGACY_COLLECTION} would be dropped.`);
    }
    return 0;
  }

  let moved = 0;
  let alreadyThere = 0;
  let relabelled = 0;
  let foreign = 0;

  for (const row of rows) {
    const { _id, ...rest } = row;
    const ours = isOurs(row);

    // Rule 2. A row of ours says `whatsapp` on the way out whether or not it
    // said so on the way in; anything else keeps whatever source it arrived
    // with, including none at all.
    const payload: Document = ours ? { ...rest, source: SOURCE } : rest;

    // The export's own natural key, so a row it has already written for this
    // upload is the row we match. Without an upload id there is no natural key
    // and the original `_id` is the only thing identifying the row — which is
    // also what lets a second run recognise it rather than duplicate it.
    const key: Document =
      typeof payload.uploadId === 'string' && payload.uploadId
        ? { uploadId: payload.uploadId, source: payload.source ?? null }
        : { _id };

    // A dry run counts and stops. It does not write, does not upsert, and does
    // not touch `aadhaar_records` — the whole point of running it first is to
    // read the numbers off a database nothing has changed yet.
    if (!apply) {
      if (await target.countDocuments(key, { limit: 1 })) alreadyThere += 1;
      else {
        moved += 1;
        if (ours && rest.source !== SOURCE) relabelled += 1;
        if (!ours) foreign += 1;
      }
      continue;
    }

    // Rule 1. `$setOnInsert`, never `$set`: a row already in the destination was
    // put there by the build in use and is newer than this copy of it.
    const result = await target.updateOne(key, { $setOnInsert: payload }, { upsert: true });

    if (result.upsertedCount) {
      moved += 1;
      // Counted on the rows that actually crossed. A row already in the
      // destination was not relabelled by us — it was left exactly as it was.
      if (ours && rest.source !== SOURCE) relabelled += 1;
      if (!ours) foreign += 1;
    } else {
      alreadyThere += 1;
    }
  }

  console.log(`${apply ? 'moved         ' : 'would move    '} ${moved}`);
  console.log(`already there   ${alreadyThere}  (left as they were — the newer row wins)`);
  if (relabelled) console.log(`relabelled      ${relabelled}  → source: '${SOURCE}'`);
  if (foreign) console.log(`not ours        ${foreign}  (copied across, source untouched)`);

  if (!apply) {
    console.log(
      `\nDry run. Nothing was written and ${LEGACY_COLLECTION} is still there.` +
        `\nRun again with --apply to move these rows and drop it.`,
    );
    return 0;
  }

  // Rule 3. Every row is looked for again in the destination before anything is
  // dropped. `moved + alreadyThere` adding up to the row count is not proof —
  // that arithmetic holds even if a write was rolled back underneath us.
  const missing: string[] = [];
  for (const row of rows) {
    const uploadId = typeof row.uploadId === 'string' ? row.uploadId : '';
    const found = uploadId
      ? await target.countDocuments({ uploadId }, { limit: 1 })
      : await target.countDocuments({ _id: row._id }, { limit: 1 });
    if (!found) missing.push(uploadId || String(row._id));
  }

  if (missing.length) {
    console.error(
      `\n${missing.length} row(s) are not in ${TARGET_COLLECTION}: ${missing.slice(0, 5).join(', ')}` +
        `\nBoth collections have been left standing. ${LEGACY_COLLECTION} was NOT dropped.`,
    );
    return 1;
  }

  await legacy.drop();

  console.log(`\nverified ${rows.length} row(s) in ${TARGET_COLLECTION}.`);
  console.log(`dropped ${LEGACY_COLLECTION}.`);
  console.log(`${TARGET_COLLECTION} now holds ${await target.countDocuments({})} row(s).`);

  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error('\nmigration failed; nothing was dropped.', err);
} finally {
  await closeDb();
}

process.exit(code);
