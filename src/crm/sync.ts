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
import {
  CrmError,
  createCandidate,
  crmConfigured,
  uploadResume,
  type CrmCandidateResponse,
} from './client.js';
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

  // Read once, before anything is sent. Both paths below may need it, and a
  // file read is not worth doing twice inside a retry.
  const cv = await readCv(candidate);

  try {
    let result: CrmCandidateResponse;
    let sentWithSubmission = false;
    try {
      result = await createCandidate(body);
    } catch (err) {
      // "You owe me a CV" — and we are holding one.
      //
      // This is the §12 recovery in its short form. The CRM's policy disagreed
      // with our cached answer, but the candidate did send a CV, so nothing has
      // to be asked of them: the same submission goes again under the same
      // idempotency key with the file inside it. Reopening the CV step here
      // would ask someone to upload a document they already uploaded, which
      // looks exactly like the bot having lost it.
      if (err instanceof CrmError && err.needsCv && cv) {
        logger.info(
          { waId },
          'crm requires a cv we already hold; resubmitting with the file attached',
        );
        result = await createCandidate({
          ...body,
          resume: {
            filename: cv.filename,
            mime_type: cv.mimeType,
            content_base64: cv.buffer.toString('base64'),
          },
        });
        sentWithSubmission = true;
      } else {
        throw err;
      }
    }

    // The CV, where there is one and it did not already travel with the
    // submission. After creation because the CRM assigns the id the file is
    // filed against — and the bytes go over, never a path into our own storage,
    // which the CRM has no way to read.
    if (cv && !sentWithSubmission) {
      await uploadCv(candidate, result.candidate_id, cv);
    }

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

/** A CV read off our own disk, ready to go over the wire as bytes. */
interface CvFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * The candidate's CV, if they sent us one and we can still read it.
 *
 * Returns undefined rather than throwing when there is no file, and also when
 * there is one we cannot open: a missing byte on our side must not hold up a
 * profile the CRM can use. Whether that absence then matters is the CRM's
 * decision, not ours — it will refuse the submission if its policy requires a
 * CV, and that refusal is handled where it lands.
 */
async function readCv(candidate: CandidateDoc): Promise<CvFile | undefined> {
  const slot = candidate.documents?.cv;
  if (!slot?.documentId) return undefined;

  try {
    const record = await documentsFor(candidate.waId, 'cv');
    const upload = record?.cv?.uploads?.find((u) => u.uploadId.equals(slot.documentId as ObjectId));
    if (!upload) return undefined;

    return {
      buffer: await readFile(upload.storageKey),
      filename: upload.originalFilename ?? 'cv.pdf',
      mimeType: upload.mimeType,
    };
  } catch (err) {
    logger.error(
      { err, waId: candidate.waId },
      'the candidate’s cv could not be read; submitting without it',
    );
    return undefined;
  }
}

/**
 * Hands a CV to a candidate the CRM already has.
 *
 * Best-effort on purpose. A candidate who reached the CRM without their file
 * attached is a far better outcome than one who did not reach it at all, so a
 * failure here is logged and the sync still counts as done — the profile is
 * what the CRM's workflow runs on, and the file can be re-sent.
 *
 * A 409 is the ordinary case rather than a fault: the CRM keeps the résumé it
 * already holds, because a recruiter may have read it and formed a view, and
 * swapping the document under that view is not a refresh.
 */
async function uploadCv(
  candidate: CandidateDoc,
  crmCandidateId: string,
  cv: CvFile,
): Promise<void> {
  try {
    await uploadResume({
      candidateId: crmCandidateId,
      buffer: cv.buffer,
      filename: cv.filename,
      mimeType: cv.mimeType,
    });
    logger.info({ waId: candidate.waId, crmId: crmCandidateId }, 'cv uploaded to crm');
  } catch (err) {
    const conflict = err instanceof CrmError && err.status === 409;
    logger[conflict ? 'info' : 'error'](
      { err, waId: candidate.waId, crmId: crmCandidateId },
      conflict
        ? 'the crm already holds a cv for this candidate; keeping theirs'
        : 'cv upload to crm failed; the candidate is synced without it',
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
