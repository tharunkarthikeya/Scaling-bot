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
import { snapshotFor } from './snapshot.js';

/**
 * Submits one candidate.
 *
 * Idempotent by construction: the payload carries a key derived from the
 * candidate's WhatsApp id, so every retry — this minute or next week, after a
 * crash or a redeploy — is recognised by the CRM as the same submission and
 * returns the same candidate rather than creating another.
 */
export async function syncCandidateToCrm(payload: {
  waId: string;
  partial?: boolean;
}): Promise<void> {
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

  // A partial that arrives after the registration finished is not a partial. The
  // job was scheduled while the candidate was still answering and the delay ran
  // out afterwards; delivering it as one would tell the CRM the conversation is
  // still open when it is not.
  const partial = !!payload.partial && candidate.stage !== 'REGISTRATION_COMPLETED';

  if (partial) {
    await syncPartial(candidate);
    return;
  }

  // Already delivered. A duplicate job, or a retry that raced the success.
  if (candidate.crmSync?.status === 'synced') {
    logger.debug({ waId, crmId: candidate.crmSync.candidateId }, 'already synced');
    return;
  }

  const attempts = (candidate.crmSync?.attempts ?? 0) + 1;
  const body = toCrmPayload(
    candidate,
    config.WHATSAPP_PHONE_NUMBER_ID,
    await snapshotFor(candidate),
  );

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
      ...candidate.crmSync,
      status: 'synced',
      candidateId: result.candidate_id,
      attempts,
      lastAttemptAt: new Date(),
      syncedAt: new Date(),
      lastError: undefined,
      // Whatever went with the submission or straight after it, the CRM now
      // holds this file — so a later partial does not send it again.
      resumeSha256: cv?.sha256 ?? candidate.crmSync?.resumeSha256,
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
        ...candidate.crmSync,
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
      ...candidate.crmSync,
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
 * Delivers a registration that is still being answered.
 *
 * The same endpoint, the same idempotency key, the same candidate — this is not
 * a second record, it is the first one arriving early and then filling in. What
 * makes it safe is that the CRM is told: `registration.complete` is false, so
 * the CV policy is not applied to somebody who has not yet reached the question
 * that would have produced a CV, and the candidate is not put in front of a
 * recruiter as a finished profile.
 *
 * Three things it deliberately does not do.
 *
 * It **never reopens a step and never fails the candidate.** A partial is a
 * courtesy to the recruiter watching the desk; nothing in the conversation
 * depends on it, and a candidate must not be asked a question because a
 * background delivery to another system did not land. So a failure here is a
 * log line and a note on the record, and the next answer schedules another one.
 *
 * It **never touches `crmSync.status`.** That field means "has this candidate
 * been handed over?", and the answer is still no. Writing `synced` on a partial
 * would take the candidate out of `reconcileCrmSync`'s sight and a registration
 * that never completed would never be delivered.
 *
 * It **does not resend the CV it has already sent.** The bytes are the
 * expensive part of the submission and a partial runs on every answered
 * question. The digest on the record is what decides, so replacing a CV still
 * sends the new one.
 */
async function syncPartial(candidate: CandidateDoc): Promise<void> {
  const { waId } = candidate;

  // §4 — nothing about anybody who has not consented leaves this system, and
  // that is not softened by the destination being our own CRM.
  if (!candidate.consent?.given) {
    logger.debug({ waId }, 'partial crm sync skipped: no consent on record');
    return;
  }

  // A business contact is not a candidate (§2), and somebody reading back an
  // application is not a record at all.
  //
  // A staff enquiry is neither, and it does sync. They gave a name, a
  // destination and a job precisely so that the person calling them back would
  // have them, and the CRM is where that person works — a record that reached
  // only the ATS was a record nobody could be assigned. It goes through this
  // path rather than the finished-registration one because that is exactly what
  // it is: a record that is complete for its own purpose and will never carry
  // `complete: true`. `registrationStateOf` marks it `enquiry: 'staff'`.
  if (candidate.enquiry === 'b2b' || candidate.enquiry === 'track') {
    logger.debug({ waId, enquiry: candidate.enquiry }, 'partial crm sync skipped: not a candidate');
    return;
  }

  // Somebody who has answered nothing yet. The CRM would get a record with a
  // phone number on it and nothing else, which is not a candidate, it is a
  // missed call — and it would be allocated to a recruiter as though it were.
  if (!worthSending(candidate)) {
    logger.debug({ waId }, 'partial crm sync skipped: nothing answered yet');
    return;
  }

  const body = toCrmPayload(
    candidate,
    config.WHATSAPP_PHONE_NUMBER_ID,
    await snapshotFor(candidate),
  );

  try {
    const result = await createCandidate(body);

    // The CV, once. `uploadResume` needs an id, which is why this is after the
    // submission rather than inside it — and a partial never sends the file
    // inline, because the inline path exists for the CV policy and a partial is
    // not held to it.
    const cv = await readCv(candidate);
    const sent =
      cv && cv.sha256 !== candidate.crmSync?.resumeSha256
        ? await uploadCv(candidate, result.candidate_id, cv)
        : false;

    await setSync(candidate, {
      ...(candidate.crmSync ?? { status: 'pending', attempts: 0 }),
      candidateId: result.candidate_id,
      partialSyncedAt: new Date(),
      partialError: undefined,
      ...(sent ? { resumeSha256: cv!.sha256 } : {}),
    });

    logger.info(
      { waId, crmId: result.candidate_id, stage: candidate.stage, cv: sent },
      'registration in progress delivered to the crm',
    );
  } catch (err) {
    const detail = err instanceof CrmError ? err.message : String(err);

    await setSync(candidate, {
      ...(candidate.crmSync ?? { status: 'pending', attempts: 0 }),
      partialError: detail,
    });

    // Warn, and stop. The next answer schedules another delivery carrying
    // everything this one was carrying, so retrying here would only race it.
    logger.warn(
      { waId, detail, status: err instanceof CrmError ? err.status : undefined },
      'partial crm sync failed; the next answer will carry it',
    );
  }
}

/**
 * Whether there is enough on the record for the CRM to be worth telling.
 *
 * Consent alone is not enough: it is given before a single question is asked,
 * so syncing on it would file every "hi" as a candidate. One answer is, because
 * one answer is a person who started registering — and someone who starts and
 * stops is exactly the candidate a recruiter wants to see.
 */
function worthSending(candidate: CandidateDoc): boolean {
  const p = candidate.profile ?? {};
  if (typeof p.fullName === 'string' && p.fullName.trim()) return true;

  // A CV or any other document is an answer, and often the first one — a
  // candidate who sends their CV before anything else has told us a great deal.
  const documents = Object.values(candidate.documents ?? {});
  if (documents.some((slot) => slot?.documentId)) return true;

  // Anything the flow has recorded, other than the bookkeeping it writes for
  // itself. Without this exclusion the language question alone would count.
  const BOOKKEEPING = new Set([
    'lookingForOverseasJob',
    'tradePacks',
    'tradeQuestions',
    'tradeQuestionsFor',
    'jobLevel',
    'jobLevelFor',
    'cvRequired',
    'cvPolicyVersion',
    'identityFlagged',
    'aadhaarFieldsRead',
    'passportExpiryNotifiedFor',
  ]);

  return Object.entries(p).some(([key, value]) => {
    if (BOOKKEEPING.has(key)) return false;
    if (value === undefined || value === null || value === '') return false;
    return !Array.isArray(value) || value.length > 0;
  });
}

/** A CV read off our own disk, ready to go over the wire as bytes. */
interface CvFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  /** The upload's digest, so a file already handed over is not handed over twice. */
  sha256?: string;
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
      sha256: upload.sha256,
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
): Promise<boolean> {
  try {
    await uploadResume({
      candidateId: crmCandidateId,
      buffer: cv.buffer,
      filename: cv.filename,
      mimeType: cv.mimeType,
    });
    logger.info({ waId: candidate.waId, crmId: crmCandidateId }, 'cv uploaded to crm');
    return true;
  } catch (err) {
    const conflict = err instanceof CrmError && err.status === 409;
    logger[conflict ? 'info' : 'error'](
      { err, waId: candidate.waId, crmId: crmCandidateId },
      conflict
        ? 'the crm already holds a cv for this candidate; keeping theirs'
        : 'cv upload to crm failed; the candidate is synced without it',
    );
    // A conflict is the CRM keeping the résumé it already has, which is the
    // file being *there* rather than the upload having failed — so it counts as
    // delivered and no partial sync offers it again.
    return conflict;
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
        // Pending and never attempted at all.
        //
        // `completeRegistration` writes `{status: 'pending', attempts: 0}` the
        // moment it queues the handover, so a job lost between the queue and a
        // worker leaves a record that satisfies neither clause above: `crmSync`
        // exists, and `lastAttemptAt` is absent rather than old — and a `$lt`
        // never matches a missing field. That candidate was invisible to the
        // one sweep whose entire job is to find them.
        //
        // Gated on the registration having finished a while ago, so a handover
        // still legitimately in flight is not chased a second time.
        {
          'crmSync.status': 'pending',
          'crmSync.lastAttemptAt': { $exists: false },
          completedAt: { $lt: stale },
        },
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
