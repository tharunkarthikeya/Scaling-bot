/**
 * Handing a finished registration to the CRM.
 *
 * Runs as a queue job, after the candidate has confirmed and been told they are
 * registered — never during the conversation. The two are deliberately
 * decoupled: registration succeeds when the candidate finishes answering, and
 * whether the CRM is reachable at that moment is not their problem. A record
 * that has not synced yet is a delivery still in flight, not a lost candidate.
 *
 * Three outcomes, and the third is the interesting one:
 *
 *   synced     the CRM has it, and told us its id for them
 *   failed     attempts exhausted; the record is intact and an operator picks
 *              it up. Nothing is discarded, ever.
 *   needs_cv   the CRM's policy requires a CV this candidate did not send.
 *              Retrying is pointless — the request is not wrong, the candidate
 *              is incomplete — so the CV step is reopened and the same
 *              submission goes out again once the file arrives, under the same
 *              idempotency key.
 */

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  documentsFor,
  findConversation,
  recordsFor,
  type CandidateDoc,
} from '../db/models.js';
import { readFile } from '../storage/index.js';
import { CrmError, createCandidate, crmConfigured, uploadResume } from './client.js';
import { toCrmPayload } from './mapping.js';

/**
 * Submits one candidate.
 *
 * Idempotent by construction: the payload carries a key derived from the
 * candidate's WhatsApp id, so every retry — this minute or next week, after a
 * crash or a redeploy — is recognised by the CRM as the same submission and
 * returns the same candidate rather than creating another.
 */
export async function syncCandidateToCrm(payload: { waId: string }): Promise<void> {
  const { waId } = payload;

  if (!crmConfigured()) {
    // Nothing to sync to. Left `pending` rather than `failed`, because no
    // attempt was made and none failed — wiring up a CRM later should find
    // these waiting, not written off.
    logger.debug({ waId }, 'crm not configured; candidate left pending');
    return;
  }

  const candidate = await findConversation(waId);
  if (!candidate) {
    logger.warn({ waId }, 'crm sync for an unknown conversation');
    return;
  }

  // Already delivered. A duplicate job, or a retry that raced the success.
  if (candidate.crmSync?.status === 'synced') {
    logger.debug({ waId, crmId: candidate.crmSync.candidateId }, 'already synced');
    return;
  }

  const attempts = (candidate.crmSync?.attempts ?? 0) + 1;
  const body = toCrmPayload(candidate, config.WHATSAPP_PHONE_NUMBER_ID);

  try {
    const result = await createCandidate(body);

    // The CV, where there is one. After creation because the CRM assigns the id
    // the file is filed against — and the bytes go over, never a path into our
    // own storage, which the CRM has no way to read.
    await uploadCvIfPresent(candidate, result.candidate_id);

    await setSync(candidate, {
      status: 'synced',
      candidateId: result.candidate_id,
      attempts,
      lastAttemptAt: new Date(),
      syncedAt: new Date(),
      lastError: undefined,
    });

    logger.info(
      {
        waId,
        crmId: result.candidate_id,
        created: result.created,
        cvRequired: result.cv_required,
        // Worth seeing in the log: it means our cached policy has drifted from
        // the CRM's, and every candidate after this one will drift the same way
        // until the cache refreshes.
        policyOverrode: result.policy_overrode_claim ?? false,
      },
      'candidate synced to crm',
    );
    return;
  } catch (err) {
    const crmErr = err instanceof CrmError ? err : undefined;

    // The CRM wants a CV. The submission is correct and the candidate is not
    // complete, so this is not a retry — it is a question to ask.
    if (crmErr?.needsCv) {
      await setSync(candidate, {
        status: 'needs_cv',
        attempts,
        lastAttemptAt: new Date(),
        lastError: crmErr.message,
      });
      logger.warn(
        { waId, detail: crmErr.message },
        'crm policy requires a CV this candidate has not sent; reopening the CV step',
      );
      const { reopenCvForCrm } = await import('../conversation/engine.js');
      await reopenCvForCrm(candidate);
      return;
    }

    const exhausted = !crmErr?.retryable || attempts >= config.CRM_SYNC_MAX_ATTEMPTS;

    await setSync(candidate, {
      status: exhausted ? 'failed' : 'pending',
      attempts,
      lastAttemptAt: new Date(),
      lastError: crmErr?.message ?? String(err),
    });

    logger[exhausted ? 'error' : 'warn'](
      { waId, attempts, status: crmErr?.status, detail: crmErr?.message },
      exhausted ? 'crm sync exhausted; candidate retained for an operator' : 'crm sync failed; will retry',
    );

    // Rethrown so the queue applies its own backoff and schedules the retry.
    // The record is already written, so nothing is lost either way.
    if (!exhausted) throw err;
  }
}

/**
 * Sends the candidate's CV, if they sent us one.
 *
 * Best-effort on purpose. A candidate who reached the CRM without their file
 * attached is a far better outcome than one who did not reach it at all, so a
 * failure here is logged and the sync still counts as done — the profile is
 * what the CRM's workflow runs on, and the file can be re-sent.
 */
async function uploadCvIfPresent(candidate: CandidateDoc, crmCandidateId: string): Promise<void> {
  const slot = candidate.documents?.cv;
  if (!slot?.documentId) return;

  try {
    const record = await documentsFor(candidate.waId, 'cv');
    const upload = record?.cv?.uploads?.find((u) => u.uploadId.equals(slot.documentId as ObjectId));
    if (!upload) return;

    const buffer = await readFile(upload.storageKey);
    await uploadResume({
      candidateId: crmCandidateId,
      buffer,
      filename: upload.originalFilename ?? 'cv.pdf',
      mimeType: upload.mimeType,
    });
    logger.info({ waId: candidate.waId, crmId: crmCandidateId }, 'cv uploaded to crm');
  } catch (err) {
    logger.error(
      { err, waId: candidate.waId, crmId: crmCandidateId },
      'cv upload to crm failed; the candidate is synced without it',
    );
  }
}

async function setSync(
  candidate: CandidateDoc,
  sync: NonNullable<CandidateDoc['crmSync']>,
): Promise<void> {
  await recordsFor(candidate.enquiry).updateOne(
    { _id: candidate._id },
    { $set: { crmSync: sync, updatedAt: new Date() } },
  );
  candidate.crmSync = sync;
}

/**
 * Re-queues candidates whose delivery is still outstanding.
 *
 * The queue's own retries cover a failing call; this covers the cases it cannot
 * see — a job lost to a restart, a candidate registered while the CRM was
 * unconfigured, a `needs_cv` that has since been resolved. Nothing here is
 * discarded on age: an undelivered candidate stays undelivered until someone
 * delivers them.
 */
export async function reconcileCrmSync(): Promise<number> {
  if (!crmConfigured()) return 0;

  const { queue } = await import('../queue/index.js');
  const stale = new Date(Date.now() - config.INGESTION_STALE_AFTER_MS);

  const pending = await recordsFor(undefined)
    .find({
      stage: 'REGISTRATION_COMPLETED',
      $or: [
        { crmSync: { $exists: false } },
        { 'crmSync.status': 'pending', 'crmSync.lastAttemptAt': { $lt: stale } },
      ],
    })
    .limit(50)
    .toArray();

  for (const candidate of pending) {
    await queue.enqueue('crm_sync', { waId: candidate.waId });
  }

  if (pending.length) {
    logger.info({ count: pending.length }, 'requeued candidates for crm sync');
  }
  return pending.length;
}
