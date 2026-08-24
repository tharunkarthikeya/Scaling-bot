/**
 * The ATS database, and the collections this bot writes into it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  A SECOND DATABASE ON THE SAME DEPLOYMENT. NOT A SECOND SERVER, NOT AN API.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `resume_ats` is the recruitment system's own database. A finished
 * conversation is copied into it so a recruiter opens one record rather than
 * two systems, and every row carries `source: 'whatsapp'` so it is obvious which
 * of them the bot put there and which arrived some other way.
 *
 * Two rules govern everything in this directory:
 *
 *   1. NOTHING IS CREATED THAT ALREADY EXISTS. Some of these collections are
 *      already in `resume_ats` with data in them. `ensureAtsCollections` lists
 *      what is there and creates only what is missing — it never drops, never
 *      renames, and never alters a collection it did not create.
 *   2. NOTHING IS EVER OVERWRITTEN BLIND. Every write is an upsert on a natural
 *      key — the WhatsApp id for a person, the upload id for a document — so a
 *      retry, a redeploy or a second export of the same candidate updates one
 *      row rather than adding another.
 *
 * The export is a copy, not a move. The bot's own database stays the record of
 * what happened in the conversation; this is what the ATS reads.
 */

import type { Collection, Db, Document } from 'mongodb';
import { config } from '../config.js';
import { getMongoClient } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * The collections written here.
 *
 * Named in one place because two things have to agree about them — what
 * `ensureAtsCollections` creates, and what the writers write into — and a
 * string typed twice is a collection created empty beside the one in use.
 */
export const ATS_COLLECTIONS = {
  /** One per person: a candidate, or somebody who asked to speak to staff. */
  candidates: 'candidates',
  /** One per Aadhaar upload, with what the extractor read off it. */
  aadhaarRecords: 'aadhaar_records',
  /** One per passport upload, likewise. */
  passportRecords: 'passport_records',
  /** One per person: their whole conversation, every sitting in order. */
  messages: 'messages',

  /**
   * The business contacts themselves, alongside whatever else sources clients.
   *
   * Their own row rather than a `candidates` one: an agent sourcing workers is
   * not somebody applying for a job, and a recruiter's candidate list is the
   * one place they must never appear. `type` says which kind of sourcing client
   * they are, and `source` says how they reached us.
   */
  sourcingClients: 'sourcing_clients',
  /** A business contact's company paperwork. Never sent to an extractor. */
  b2bCompanyDocuments: 'b2b_company_documents',
  /** One per business contact: their whole conversation. */
  b2bMessages: 'b2b_messages',
  /** The agent's own Aadhaar, both sides, with what was read off them. */
  b2bAgentAadhaar: 'b2b_agent_aadhar',
} as const;

export type AtsCollection = (typeof ATS_COLLECTIONS)[keyof typeof ATS_COLLECTIONS];

/** Whether an ATS is configured at all. Blank `RESUME_ATS_DB` turns this off. */
export function atsConfigured(): boolean {
  return !!config.RESUME_ATS_DB;
}

/**
 * The ATS database handle.
 *
 * Taken off the existing client, so it shares the pool, the retry settings and
 * the credentials the bot already connected with — `resume_ats` is a database
 * on that deployment, and a second `MongoClient` would be a second pool nobody
 * sized.
 */
export function atsDb(): Db {
  if (!config.RESUME_ATS_DB) {
    throw new Error('atsDb() called with RESUME_ATS_DB blank; check atsConfigured() first');
  }
  return getMongoClient().db(config.RESUME_ATS_DB);
}

export function atsCollection<T extends Document = Document>(name: AtsCollection): Collection<T> {
  return atsDb().collection<T>(name);
}

/**
 * Creates the collections that are not there yet, and nothing else.
 *
 * Called once at boot. The listing decides: a name already in `resume_ats` is
 * left exactly as it is, including its indexes and its documents, because some
 * of these already exist and are already being read by something that is not
 * this bot. Only a name that is absent is created.
 *
 * Indexes are added only to collections created here, for the same reason. A
 * unique index dropped onto a populated collection fails on the first duplicate
 * and takes the deploy with it; a non-unique one silently changes the query
 * plans of a system nobody warned. The writers do not depend on an index to be
 * correct — every one of them upserts on a natural key, under the per-candidate
 * lock that already serialises everything for one person — so an index here is
 * a read optimisation and never a correctness requirement.
 *
 * Never throws. An ATS that cannot be prepared is a failed export, logged and
 * retried, and not a bot that refuses to answer anybody.
 */
export async function ensureAtsCollections(): Promise<void> {
  if (!atsConfigured()) {
    logger.info('RESUME_ATS_DB is blank; the ATS export is off');
    return;
  }

  try {
    const db = atsDb();
    const existing = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
    );

    const created: string[] = [];
    const kept: string[] = [];

    for (const name of Object.values(ATS_COLLECTIONS)) {
      if (existing.has(name)) {
        kept.push(name);
        continue;
      }

      try {
        await db.createCollection(name);
        created.push(name);
      } catch (err) {
        // Lost a race with another instance booting. Both wanted it to exist,
        // and it does.
        if ((err as { codeName?: string }).codeName === 'NamespaceExists') {
          kept.push(name);
          continue;
        }
        throw err;
      }
    }

    // Only on what we just made. See the note above.
    for (const name of created) await indexFor(db, name);

    logger.info(
      { db: config.RESUME_ATS_DB, created, alreadyThere: kept },
      'ats collections checked',
    );
  } catch (err) {
    logger.error({ err, db: config.RESUME_ATS_DB }, 'could not prepare the ats collections');
  }
}

/**
 * The index a newly created collection gets: its natural key, and `source`.
 *
 * Not unique, deliberately. These collections are shared with whatever else
 * writes into `resume_ats`, and a uniqueness rule is a claim about everybody's
 * data rather than only about ours.
 */
async function indexFor(db: Db, name: string): Promise<void> {
  const keys: Record<string, Record<string, 1>> = {
    [ATS_COLLECTIONS.candidates]: { waId: 1, source: 1 },
    [ATS_COLLECTIONS.sourcingClients]: { waId: 1, source: 1 },
    [ATS_COLLECTIONS.messages]: { waId: 1 },
    [ATS_COLLECTIONS.aadhaarRecords]: { uploadId: 1 },
    [ATS_COLLECTIONS.passportRecords]: { uploadId: 1 },
    [ATS_COLLECTIONS.b2bCompanyDocuments]: { uploadId: 1 },
    [ATS_COLLECTIONS.b2bMessages]: { waId: 1 },
    [ATS_COLLECTIONS.b2bAgentAadhaar]: { uploadId: 1 },
  };

  const spec = keys[name];
  if (!spec) return;

  try {
    await db.collection(name).createIndex(spec);
  } catch (err) {
    logger.warn({ err, collection: name }, 'could not index a new ats collection');
  }
}
