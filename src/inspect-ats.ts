/**
 * What the bot has put into the ATS, straight from `resume_ats`.
 *
 * The counterpart of `npm run inspect`, which reads the bot's own database.
 * This one answers the question you actually have after a live test: did the
 * registration reach the ATS, and does the row look right?
 *
 * Read-only. It opens the same connection the bot uses, prints, and exits.
 *
 *   npm run inspect:ats                  everything the bot has written
 *   npm run inspect:ats -- 919000000000  one number, in full
 */

import { config } from './config.js';
import { closeDb, connectDb } from './db/client.js';
import { atsCollection, atsConfigured, ATS_COLLECTIONS } from './ats/client.js';

const wanted = process.argv.slice(2).find((a) => !a.startsWith('-'));

if (!atsConfigured()) {
  console.log('RESUME_ATS_DB is blank — the ATS export is off, so there is nothing to read.');
  process.exit(0);
}

await connectDb();

console.log(`\nats database: ${config.RESUME_ATS_DB}`);
console.log(`bot database: ${config.MONGODB_DB}`);
if (wanted) console.log(`filtered to:  ${wanted}`);

/** Only what this bot wrote. Anything else in these collections is not ours. */
const ours = { source: 'whatsapp', ...(wanted ? { waId: wanted } : {}) };

let total = 0;

for (const name of Object.values(ATS_COLLECTIONS)) {
  const collection = atsCollection(name);

  // Two counts, because the difference is the point: these collections are
  // shared, and knowing the bot wrote 3 of 400 rows is more useful than either
  // number alone.
  const mine = await collection.countDocuments(ours);
  const everything = await collection.countDocuments(wanted ? { waId: wanted } : {});
  total += mine;

  console.log(`\n── ${name} — ${mine} from whatsapp, ${everything} in total`);

  const rows = await collection.find(ours).sort({ exportedAt: -1 }).limit(wanted ? 20 : 5).toArray();

  for (const row of rows) {
    const r = row as Record<string, any>;

    if (r.turns) {
      console.log(
        `   ${r.waId}  ${r.applicationId ?? r.contactName ?? ''}  ` +
          `${r.turnCount} turns over ${r.sittingCount} sitting(s)`,
      );
      if (wanted) {
        for (const t of r.turns as any[]) {
          const who = t.direction === 'inbound' ? '  <' : '  >';
          const text = String(t.text ?? `[${t.type}]`).replace(/\s+/g, ' ').slice(0, 90);
          console.log(`   ${who} ${text}`);
        }
      }
      continue;
    }

    if (r.documentType) {
      const fields = (r.ocr?.fields ?? [])
        .map((f: any) => `${f.key}=${f.value}`)
        .slice(0, 6)
        .join('  ');
      console.log(
        `   ${r.waId}  ${r.documentType}${r.isCurrent ? '' : ' (superseded)'}  ` +
          `${r.mimeType} ${r.byteSize}B`,
      );
      console.log(`     ${r.ocr ? fields || '(read, no fields)' : '(not read — no extractor)'}`);
      if (r.ocr?.needsReview) console.log(`     needs review: ${(r.ocr.reviewReasons ?? []).join('; ')}`);
      continue;
    }

    if (r.type) {
      console.log(`   ${r.waId}  ${r.contactName ?? ''}  type=${r.type}  ${r.stage ?? ''}`);
      continue;
    }

    console.log(
      `   ${r.waId}  ${r.applicationId ?? '(no id)'}  ${r.fullName ?? ''}  ` +
        `${r.enquiry}/${r.flowVariant}  ${r.primaryTrade ?? ''} ${r.countryPreference ?? ''}`,
    );
    if (wanted) {
      for (const [k, v] of Object.entries(r)) {
        if (['_id', 'documents', 'turns'].includes(k)) continue;
        if (v === undefined || v === null || v === '') continue;
        console.log(`     ${k.padEnd(22)} ${JSON.stringify(v)}`);
      }
      console.log(`     documents             ${JSON.stringify(r.documents ?? {})}`);
    }
  }

  if (!rows.length) console.log('   (nothing)');
}

console.log(`\n${total} row(s) written by the bot${wanted ? ' for that number' : ''}.\n`);

await closeDb();
