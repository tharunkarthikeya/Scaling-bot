/**
 * Permanent removal for a person who is outside the service's nationality policy.
 *
 * This is intentionally different from candidate-requested deletion, which
 * retains a minimal legal tombstone and upload history. A nationality refusal
 * must not create a candidate record at rest, so every local row and stored
 * object associated with the WhatsApp number is removed after the refusal is
 * sent.
 */
import {
  auditEvents,
  b2bDocuments,
  b2bEnquiries,
  candidates,
  flattenUploads,
  messages,
  processedEvents,
  storedDocuments,
} from '../db/models.js';
import { ingestionRows } from '../ingestion/ledger.js';
import { logger } from '../logger.js';
import { deleteFile } from '../storage/index.js';

export interface PurgeResult {
  storageObjects: number;
  storageFailures: number;
}

export interface ExistingNationalityPurgeResult extends PurgeResult {
  candidates: number;
}

export async function purgeCandidateData(waId: string): Promise<PurgeResult> {
  const [candidateDocs, businessDocs, sessions, ingestion] = await Promise.all([
    storedDocuments().findOne({ waId }),
    b2bDocuments().findOne({ waId }),
    messages().find({ waId }).toArray(),
    ingestionRows().find({ waId }).toArray(),
  ]);

  const storageKeys = new Set<string>();
  for (const record of [candidateDocs, businessDocs]) {
    if (!record) continue;
    for (const upload of flattenUploads(record)) storageKeys.add(upload.storageKey);
  }
  for (const row of ingestion) if (row.storageKey) storageKeys.add(row.storageKey);

  const wamids = new Set<string>(ingestion.map((row) => row.messageId).filter(Boolean));
  for (const session of sessions) {
    for (const turn of session.turns ?? []) if (turn.wamid) wamids.add(turn.wamid);
  }

  await Promise.all([
    candidates().deleteMany({ waId }),
    b2bEnquiries().deleteMany({ waId }),
    messages().deleteMany({ waId }),
    storedDocuments().deleteMany({ waId }),
    b2bDocuments().deleteMany({ waId }),
    ingestionRows().deleteMany({ waId }),
    auditEvents().deleteMany({ waId }),
    ...(wamids.size ? [processedEvents().deleteMany({ wamid: { $in: [...wamids] } })] : []),
  ]);

  const removed = await Promise.allSettled([...storageKeys].map((key) => deleteFile(key)));
  const storageFailures = removed.filter((result) => result.status === 'rejected').length;
  if (storageFailures) {
    logger.error(
      { waId, storageObjects: storageKeys.size, storageFailures },
      'candidate database rows were purged but some stored files could not be removed',
    );
  }

  return { storageObjects: storageKeys.size, storageFailures };
}

/** Removes records retained by releases that used to keep nationality refusals. */
export async function purgeExistingNationalityRefusals(): Promise<ExistingNationalityPurgeResult> {
  const waIds = await candidates().distinct('waId', {
    'nationalityCheck.status': 'not_eligible',
  });

  let storageObjects = 0;
  let storageFailures = 0;
  for (const waId of waIds) {
    const result = await purgeCandidateData(waId);
    storageObjects += result.storageObjects;
    storageFailures += result.storageFailures;
  }

  return { candidates: waIds.length, storageObjects, storageFailures };
}
