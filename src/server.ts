import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config, instanceId } from './config.js';
import { logger } from './logger.js';
import { verifySignature } from './whatsapp/signature.js';
import { parseWebhook } from './whatsapp/parse.js';
import {
  appendTurn,
  b2bDocuments,
  b2bEnquiries,
  claimEvent,
  markTurnFailed,
  sessionsFor,
  candidates,
  storedDocuments,
  uploadsFor,
  flattenUploads,
  recordAudit,
  APPLICATION_STATUSES,
  type ApplicationStatus,
} from './db/models.js';
import { queue } from './queue/index.js';
import { markAsRead } from './whatsapp/client.js';
import { captureAttachment } from './ingestion/whatsapp.js';
import { ingestionRows, oldestUnfinishedAgeMs, IN_FLIGHT_STATUSES } from './ingestion/ledger.js';
import { record, renderMetrics } from './metrics/index.js';
import { notifyAdminsOfSlaBreach, notifyStaffOfAssignment } from './staff/notify.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    /** Set by the metrics hook. Nanoseconds, from a monotonic clock. */
    startedAt?: bigint;
  }
}

/**
 * Strips the raw extractor payload from every upload.
 *
 * It is the largest thing in the record by far and nothing reading these
 * endpoints wants it — the structured fields carry the same information with
 * provenance attached.
 */
function withoutRawOcr<T extends { ocr?: { raw?: unknown } }>(uploads: T[]): T[] {
  return uploads.map((upload) =>
    upload.ocr ? { ...upload, ocr: { ...upload.ocr, raw: undefined } } : upload,
  );
}

export interface ServerOptions {
  /**
   * Serve the Meta webhook and the admin API.
   *
   * False on the `worker` and `scheduler` roles. They still listen, because a
   * container with no socket cannot be health-checked and an orchestrator that
   * cannot health-check a container cannot tell "starting" from "wedged" - but
   * they serve `/health` and `/metrics` and nothing else. A process with no
   * reason to expose candidate PII does not get routes that can.
   */
  webhook?: boolean;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const servesWebhook = options.webhook ?? true;
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  // Meta signs the raw bytes. Parse from a buffer and keep the original around —
  // re-serialising the parsed JSON changes the bytes and the HMAC never matches.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      req.rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch {
        done(null, {});
      }
    },
  );

  /* --------------------------------------------------------------- */
  /* Metrics                                                           */
  /* --------------------------------------------------------------- */

  /**
   * Times every request.
   *
   * Labelled by `routerPath` rather than by `url`, deliberately: the url
   * carries a waId on the admin routes, and a per-candidate label would be an
   * unbounded series and a PII leak in the same mistake. An unmatched request
   * is labelled `unmatched` for the same reason - 404 scanning traffic must not
   * be able to create series.
   */
  app.addHook('onRequest', async (req) => {
    req.startedAt = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (req, res) => {
    if (req.startedAt === undefined) return;
    const seconds = Number(process.hrtime.bigint() - req.startedAt) / 1e9;
    const route = req.routeOptions?.url ?? 'unmatched';
    record.http(req.method, route, res.statusCode, seconds);
  });

  app.get('/health', async () => ({
    ok: true,
    role: config.ROLE,
    instance: instanceId,
    shadowMode: config.SHADOW_MODE,
  }));

  if (config.METRICS_ENABLED) {
    app.get('/metrics', async (req, res) => {
      // Unset means open, which is right on a private network and wrong on a
      // public domain. The endpoint carries no candidate PII either way - no
      // waId, no name, no document - but queue depth and error rates still tell
      // a stranger more about the service than they need to know.
      if (config.METRICS_API_KEY) {
        const expected = Buffer.from(config.METRICS_API_KEY);
        const provided = req.headers['x-api-key'];
        const supplied = Buffer.from(typeof provided === 'string' ? provided : '');

        const ok =
          supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

        if (!ok) return res.code(401).send('unauthorized');
      }

      // Prometheus is specific about this content type; a scrape will reject
      // anything else.
      return res.type('text/plain; version=0.0.4; charset=utf-8').send(await renderMetrics());
    });
  } else {
    logger.warn('METRICS_ENABLED=false - /metrics is not served');
  }

  // Everything below is the webhook and the admin API. A role that serves
  // neither stops here with a live socket and nothing else on it.
  if (!servesWebhook) {
    logger.info({ role: config.ROLE }, 'ops-only server: /health and /metrics only');
    return app;
  }

  /** Meta's subscription handshake. Echoes the challenge if our token matches. */
  app.get('/webhook', async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (
      q['hub.mode'] === 'subscribe' &&
      q['hub.verify_token'] === config.WHATSAPP_WEBHOOK_VERIFY_TOKEN
    ) {
      logger.info('webhook verification succeeded');
      return res.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    logger.warn({ mode: q['hub.mode'] }, 'webhook verification rejected');
    return res.code(403).send('forbidden');
  });

  app.post('/webhook', async (req, res) => {
    const signature = req.headers['x-hub-signature-256'];
    if (!req.rawBody || !verifySignature(req.rawBody, signature as string | undefined)) {
      logger.warn('rejected webhook with an invalid signature');
      return res.code(401).send({ error: 'invalid signature' });
    }

    const { messages: inbound, statuses } = parseWebhook(req.body);

    for (const msg of inbound) {
      // Meta retries deliveries. Without this claim, a retry re-runs the whole
      // turn and the candidate is asked for the same document twice.
      const fresh = await claimEvent(msg.wamid);
      if (!fresh) {
        logger.debug({ wamid: msg.wamid }, 'duplicate delivery ignored');
        continue;
      }

      await appendTurn({
        waId: msg.waId,
        direction: 'inbound',
        wamid: msg.wamid,
        type: msg.type === 'interactive' ? 'interactive' : msg.type,
        text: msg.text,
        // The tapped option id and the message it came from. Both are parsed
        // from the webhook and both must be persisted: the worker reads this
        // row back, so anything dropped here is invisible to the engine. Without
        // `replyId` every tap is handled as if the candidate had typed the
        // button's title, which only works while the title matches a label we
        // ship — not once a label is translated at send time.
        ...(msg.replyId ? { replyId: msg.replyId } : {}),
        ...(msg.contextWamid ? { contextWamid: msg.contextWamid } : {}),
        mediaId: msg.media?.id,
        filename: msg.media?.filename,
        mimeType: msg.media?.mimeType,
        at: msg.timestamp,
      });

      // The attachment, before the ack (`automation-integration.md`, steps 2–4).
      //
      // Acknowledging is what stops Meta retrying. Doing it while the only copy
      // of the file is still a media id on Meta's servers means a worker that
      // never runs takes the document with it and leaves nothing behind that
      // knew there was one. So the bytes are fetched and written first, and a
      // ledger row records the outcome either way.
      //
      // `captureAttachment` does not throw: a failed download is a recorded
      // failure on a row the reconciler will pick up, not a reason to fail the
      // whole batch back to Meta.
      if (msg.media?.id) {
        await captureAttachment({
          waId: msg.waId,
          wamid: msg.wamid,
          mediaId: msg.media.id,
          mimeType: msg.media.mimeType,
          filename: msg.media.filename,
          receivedAt: msg.timestamp,
          phoneNumberId: msg.phoneNumberId,
        });
      }

      await queue.enqueue('inbound_message', {
        waId: msg.waId,
        wamid: msg.wamid,
        profileName: msg.profileName,
        // Which number they wrote to. The worker needs it to decide the flow
        // for a first-time contact, and to reply from the right number.
        phoneNumberId: msg.phoneNumberId,
      });

      // Posted back to the number it arrived on, or the tick never appears.
      void markAsRead(msg.wamid, msg.phoneNumberId);
    }

    for (const status of statuses) {
      if (status.status === 'failed') {
        logger.warn(
          { wamid: status.wamid, waId: status.waId, reason: status.errorTitle },
          'outbound message failed',
        );
        await markTurnFailed(status.wamid, status.errorTitle ?? 'delivery failed');
      }
    }

    // Always ack. A non-2xx here makes Meta retry the whole batch, including the
    // messages we already accepted.
    return res.code(200).send({ received: true });
  });

  /* --------------------------------------------------------------- */
  /* Read-only endpoints the CRM will consume                          */
  /*                                                                   */
  /* These return candidate PII. They are served only when             */
  /* ADMIN_API_KEY is configured, and every request must present it.   */
  /* --------------------------------------------------------------- */

  if (!config.ADMIN_API_KEY) {
    logger.warn('ADMIN_API_KEY not set — /api/* routes are disabled');
  } else {
    const expected = Buffer.from(config.ADMIN_API_KEY);

    app.addHook('onRequest', async (req, res) => {
      if (!req.url.startsWith('/api/')) return;

      const provided = req.headers['x-api-key'];
      const supplied = Buffer.from(typeof provided === 'string' ? provided : '');

      // Constant-time compare, length-guarded — timingSafeEqual throws on a
      // length mismatch rather than returning false.
      const ok =
        supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

      if (!ok) {
        logger.warn({ url: req.url, ip: req.ip }, 'rejected unauthenticated api request');
        return res.code(401).send({ error: 'unauthorized' });
      }
    });

    /**
     * The CRM telling us that a candidate now belongs to somebody.
     *
     * Two ids and nothing else on the wire. Everything the message says is read
     * back out of the CRM by `notifyStaffOfAssignment` - see `staff/notify.ts`
     * for why the wording lives on this side of the hop.
     *
     * Always 200 when the request itself was well formed, including when
     * nothing was sent. The CRM has already written its own durable
     * notification by the time it calls this, and there is nothing here it
     * could usefully retry: a staff member with no number on file needs an
     * admin, not another delivery attempt. The reason travels in the body
     * instead, so it lands in the CRM's log where somebody will read it.
     */
    app.post('/api/staff-assignment', async (req, res) => {
      const body = (req.body ?? {}) as { candidate_id?: unknown; staff_id?: unknown };
      const candidateId = typeof body.candidate_id === 'string' ? body.candidate_id.trim() : '';
      const staffId = typeof body.staff_id === 'string' ? body.staff_id.trim() : '';

      if (!candidateId || !staffId) {
        return res.code(400).send({ error: 'candidate_id and staff_id are required' });
      }

      return notifyStaffOfAssignment({ candidateId, staffId });
    });

    /**
     * The CRM's SLA sweep telling us nobody has touched some allocated work.
     *
     * Facts rather than ids, unlike the assignment relay above. A sweep's result
     * is not a record this bot could fetch back: by the time it asked, the next
     * sweep may have resolved half of it, and re-reading would report a
     * different set than the one that actually breached.
     *
     * One call per sweep, covering however many profiles it found - so `count`
     * is the field that decides whether the message names a candidate or
     * summarises a backlog.
     */
    app.post('/api/sla-breach', async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const count = Number(body.count);
      const thresholdHours = Number(body.threshold_hours);

      if (!Number.isFinite(count) || count < 1 || !Number.isFinite(thresholdHours)) {
        return res.code(400).send({ error: 'count and threshold_hours are required' });
      }

      const text = (value: unknown): string | undefined =>
        typeof value === 'string' && value.trim() ? value.trim() : undefined;

      return notifyAdminsOfSlaBreach({
        count,
        threshold_hours: thresholdHours,
        staff_count: Number.isFinite(Number(body.staff_count))
          ? Number(body.staff_count)
          : undefined,
        candidate_id: text(body.candidate_id),
        candidate_name: text(body.candidate_name),
        staff_name: text(body.staff_name),
        hours_overdue: Number.isFinite(Number(body.hours_overdue))
          ? Number(body.hours_overdue)
          : undefined,
        reason: text(body.reason),
      });
    });

    app.get('/api/candidates', async (req) => {
      const q = req.query as { stage?: string; limit?: string };
      const filter = q.stage ? { stage: q.stage as never } : {};
      const limit = Math.min(Number(q.limit) || 50, 200);

      const rows = await candidates()
        .find(filter)
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();

      return { count: rows.length, candidates: rows };
    });

    app.get('/api/candidates/:waId', async (req, res) => {
      const { waId } = req.params as { waId: string };
      const candidate = await candidates().findOne({ waId });
      if (!candidate) return res.code(404).send({ error: 'not found' });

      const [transcript, documents] = await Promise.all([
        // Sittings, oldest first. Each one reads as a transcript on its own.
        sessionsFor(waId),
        // Flat and oldest first, with the raw OCR payload dropped — it is large
        // and the structured fields are what a reader actually wants.
        uploadsFor(waId).then(withoutRawOcr),
      ]);

      return { candidate, documents, transcript };
    });

    /**
     * Sets the application outcome the candidate is told when they track (§25).
     *
     * This is the only write in the API, and it exists because the decision is
     * the agency's, not the bot's — the bot seeds `pending` at registration and
     * never touches it again. Every change is recorded in the audit trail with
     * whoever made it.
     */
    app.patch('/api/candidates/:waId/application', async (req, res) => {
      const { waId } = req.params as { waId: string };
      const body = (req.body ?? {}) as { status?: string; note?: string; by?: string };

      if (!APPLICATION_STATUSES.includes(body.status as ApplicationStatus)) {
        return res.code(400).send({
          error: `status must be one of: ${APPLICATION_STATUSES.join(', ')}`,
        });
      }

      const status = body.status as ApplicationStatus;
      const now = new Date();

      const result = await candidates().findOneAndUpdate(
        { waId },
        {
          $set: {
            application: {
              status,
              updatedAt: now,
              ...(body.by ? { updatedBy: body.by } : {}),
              ...(body.note ? { note: body.note } : {}),
            },
            updatedAt: now,
          },
        },
        { returnDocument: 'after' },
      );

      if (!result) return res.code(404).send({ error: 'not found' });

      await recordAudit({
        waId,
        candidateId: result.candidateId,
        event: 'application_status_changed',
        detail: `${status}${body.by ? ` by ${body.by}` : ''}`,
      });

      logger.info({ waId, status, by: body.by }, 'application status set');

      // The candidate is not messaged. They are told when they ask — pushing an
      // outcome unprompted is a decision for staff, not a side effect of a
      // CRM edit.
      return { waId, candidateId: result.candidateId, application: result.application };
    });

    /* --------------------------------------------------------------- */
    /* B2B enquiries (§2)                                                */
    /*                                                                   */
    /* A business contact is not a candidate and is filed in its own     */
    /* collections, so it is read through its own endpoints. Nothing     */
    /* here is reachable through /api/candidates, and nothing there is   */
    /* reachable here — which is the whole point of the split.           */
    /* --------------------------------------------------------------- */

    app.get('/api/b2b', async (req) => {
      const q = req.query as { stage?: string; status?: string; limit?: string };
      // The CRM review section contains submitted enquiries only. Partial B2B
      // conversations remain safely stored but are not reviewable yet.
      const filter = {
        completedAt: { $exists: true },
        ...(q.stage ? { stage: q.stage } : {}),
        ...(q.status ? { 'b2bReview.status': q.status } : {}),
      } as never;
      const limit = Math.min(Number(q.limit) || 50, 200);

      const rows = await b2bEnquiries()
        .find(filter)
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();

      return { count: rows.length, enquiries: rows };
    });

    app.get('/api/b2b/:waId', async (req, res) => {
      const { waId } = req.params as { waId: string };
      const enquiry = await b2bEnquiries().findOne({ waId });
      if (!enquiry) return res.code(404).send({ error: 'not found' });

      const [transcript, record] = await Promise.all([
        sessionsFor(waId),
        b2bDocuments().findOne({ waId }),
      ]);

      const documents = withoutRawOcr(record ? flattenUploads(record) : []);

      return { enquiry, documents, transcript };
    });

    /** CRM review decision. Approval is the sole trigger for sourcing export. */
    app.patch('/api/b2b/:waId/review', async (req, res) => {
      const { waId } = req.params as { waId: string };
      const body = (req.body ?? {}) as { status?: string; by?: string; note?: string };
      if (body.status !== 'approved' && body.status !== 'rejected') {
        return res.code(400).send({ error: 'status must be one of: approved, rejected' });
      }

      const existing = await b2bEnquiries().findOne({ waId, completedAt: { $exists: true } });
      if (!existing) return res.code(404).send({ error: 'completed enquiry not found' });

      const now = new Date();
      const review = {
        status: body.status,
        submittedAt: existing.b2bReview?.submittedAt ?? existing.completedAt ?? now,
        reviewedAt: now,
        ...(body.by ? { reviewedBy: body.by } : {}),
        ...(body.note ? { note: body.note } : {}),
        ...(existing.b2bReview?.sourcingQueuedAt
          ? { sourcingQueuedAt: existing.b2bReview.sourcingQueuedAt }
          : {}),
      } as const;

      const enquiry = await b2bEnquiries().findOneAndUpdate(
        { waId, completedAt: { $exists: true } },
        {
          $set: {
            b2bReview: review,
            status: body.status === 'approved' ? 'job_ready' : 'archived',
            updatedAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      if (!enquiry) return res.code(404).send({ error: 'completed enquiry not found' });

      await recordAudit({
        waId,
        event: body.status === 'approved' ? 'b2b_enquiry_approved' : 'b2b_enquiry_rejected',
        detail: `${body.status}${body.by ? ` by ${body.by}` : ''}`,
      });

      if (body.status === 'approved') {
        await queue.enqueue('ats_export', { waId });
        const queuedAt = new Date();
        await b2bEnquiries().updateOne(
          { waId, 'b2bReview.status': 'approved' },
          { $set: { 'b2bReview.sourcingQueuedAt': queuedAt, updatedAt: queuedAt } },
        );
        enquiry.b2bReview = { ...enquiry.b2bReview!, sourcingQueuedAt: queuedAt };
      }

      logger.info({ waId, status: body.status, by: body.by }, 'b2b review decision set');
      return { waId, review: enquiry.b2bReview, sourcing: body.status === 'approved' ? 'queued' : 'not_queued' };
    });

    /** The review queue: documents whose extraction a human must confirm. */
    app.get('/api/documents', async (req) => {
      const q = req.query as { needsReview?: string; waId?: string; limit?: string };
      const limit = Math.min(Number(q.limit) || 50, 200);

      // One record per candidate now, so the review queue is assembled from the
      // sections rather than read straight off matching rows. Candidates only —
      // a business contact's uploads are reviewed through /api/b2b/:waId.
      const records = await storedDocuments()
        .find(q.waId ? { waId: q.waId } : {})
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();

      let uploads = records.flatMap(flattenUploads);
      if (q.needsReview === 'true') uploads = uploads.filter((u) => u.ocr?.needsReview);

      const rows = withoutRawOcr(uploads)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);

      return { count: rows.length, documents: rows };
    });
  }

  return app;
}
