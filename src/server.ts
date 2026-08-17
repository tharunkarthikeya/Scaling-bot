import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { logger } from './logger.js';
import { verifySignature } from './whatsapp/signature.js';
import { parseWebhook } from './whatsapp/parse.js';
import {
  claimEvent,
  messages,
  candidates,
  storedDocuments,
  recordAudit,
  APPLICATION_STATUSES,
  type ApplicationStatus,
} from './db/models.js';
import { queue } from './queue/index.js';
import { markAsRead } from './whatsapp/client.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
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

  app.get('/health', async () => ({ ok: true, shadowMode: config.SHADOW_MODE }));

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

      await messages().insertOne({
        waId: msg.waId,
        direction: 'inbound',
        wamid: msg.wamid,
        type: msg.type === 'interactive' ? 'interactive' : msg.type,
        text: msg.text,
        mediaId: msg.media?.id,
        filename: msg.media?.filename,
        mimeType: msg.media?.mimeType,
        createdAt: msg.timestamp,
      });

      await queue.enqueue('inbound_message', {
        waId: msg.waId,
        wamid: msg.wamid,
        profileName: msg.profileName,
      });

      void markAsRead(msg.wamid);
    }

    for (const status of statuses) {
      if (status.status === 'failed') {
        logger.warn(
          { wamid: status.wamid, waId: status.waId, reason: status.errorTitle },
          'outbound message failed',
        );
        await messages().updateOne(
          { wamid: status.wamid },
          { $set: { error: status.errorTitle ?? 'delivery failed' } },
        );
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
        messages().find({ waId }).sort({ createdAt: 1, _id: 1 }).limit(500).toArray(),
        // Drop the raw OCR payload — it is large and the structured fields
        // are what a reader actually wants.
        storedDocuments()
          .find({ waId }, { projection: { 'ocr.raw': 0 } })
          .sort({ createdAt: 1 })
          .toArray(),
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

    /** The review queue: documents whose extraction a human must confirm. */
    app.get('/api/documents', async (req) => {
      const q = req.query as { needsReview?: string; waId?: string; limit?: string };
      const filter: Record<string, unknown> = {};
      if (q.needsReview === 'true') filter['ocr.needsReview'] = true;
      if (q.waId) filter.waId = q.waId;

      const rows = await storedDocuments()
        .find(filter, { projection: { 'ocr.raw': 0 } })
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(q.limit) || 50, 200))
        .toArray();

      return { count: rows.length, documents: rows };
    });
  }

  return app;
}
