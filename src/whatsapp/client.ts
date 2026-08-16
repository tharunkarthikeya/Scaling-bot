import { config, graphBaseUrl } from '../config.js';
import { logger } from '../logger.js';
import { RateLimiter } from './rateLimiter.js';

const limiter = new RateLimiter(config.OUTBOUND_RATE_PER_SECOND);

/** WhatsApp rejects text bodies longer than this. */
const MAX_TEXT_LENGTH = 4096;

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }

  /** Meta's code for "the 24-hour customer service window has closed". */
  get isOutsideWindow(): boolean {
    return this.code === 131047 || this.code === 131051;
  }
}

async function graphPost(path: string, body: unknown): Promise<any> {
  await limiter.acquire();

  const res = await fetch(`${graphBaseUrl}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as any;

  if (!res.ok) {
    const err = json?.error ?? {};
    throw new WhatsAppApiError(
      err.message ?? `Graph API ${res.status}`,
      res.status,
      err.code,
      err.error_subcode,
    );
  }

  return json;
}

export interface SendResult {
  wamid?: string;
  shadowed: boolean;
}

/** Splits on paragraph, then line, then hard-cuts — so we never post-truncate a reply. */
export function chunkText(text: string, limit = MAX_TEXT_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.5) cut = limit;

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length) chunks.push(remaining);
  return chunks;
}

export async function sendText(to: string, text: string): Promise<SendResult[]> {
  const parts = chunkText(text);
  const results: SendResult[] = [];

  for (const part of parts) {
    if (config.SHADOW_MODE) {
      logger.info({ to, text: part }, 'shadow mode: outbound suppressed');
      results.push({ shadowed: true });
      continue;
    }

    const json = await graphPost(`${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: part },
    });

    results.push({ wamid: json?.messages?.[0]?.id, shadowed: false });
  }

  return results;
}

/**
 * Sends the approved re-engagement template. This is the only thing that may be
 * sent once the 24-hour window has closed.
 */
export async function sendReengagementTemplate(to: string): Promise<SendResult> {
  const name = config.WHATSAPP_REENGAGEMENT_TEMPLATE;
  if (!name) throw new Error('WHATSAPP_REENGAGEMENT_TEMPLATE is not configured');

  if (config.SHADOW_MODE) {
    logger.info({ to, template: name }, 'shadow mode: template suppressed');
    return { shadowed: true };
  }

  const json = await graphPost(`${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: config.WHATSAPP_REENGAGEMENT_TEMPLATE_LANG },
    },
  });

  return { wamid: json?.messages?.[0]?.id, shadowed: false };
}

/** Best-effort read receipt. Failing to mark read must never block processing. */
export async function markAsRead(wamid: string): Promise<void> {
  if (config.SHADOW_MODE) return;
  try {
    await graphPost(`${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: wamid,
    });
  } catch (err) {
    logger.warn({ err, wamid }, 'failed to mark message as read');
  }
}

export interface MediaPayload {
  buffer: Buffer;
  mimeType: string;
  byteSize: number;
}

/**
 * Media download is two hops: resolve the id to a short-lived signed URL, then
 * fetch that URL. The second request still needs the bearer token — Meta's CDN
 * rejects unauthenticated reads.
 */
export async function downloadMedia(mediaId: string): Promise<MediaPayload> {
  if (config.MOCK_WHATSAPP_MEDIA) {
    const { SAMPLE_RESUME_PDF } = await import('../testing/fixtures.js');
    const pdf = SAMPLE_RESUME_PDF();
    logger.warn({ mediaId }, 'MOCK_WHATSAPP_MEDIA is on — serving a canned file');
    return { buffer: pdf, mimeType: 'application/pdf', byteSize: pdf.byteLength };
  }

  await limiter.acquire();

  const metaRes = await fetch(`${graphBaseUrl}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
  });

  if (!metaRes.ok) {
    throw new WhatsAppApiError(`media lookup failed for ${mediaId}`, metaRes.status);
  }

  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) throw new WhatsAppApiError(`media ${mediaId} has no download url`, 502);

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
  });

  if (!fileRes.ok) {
    throw new WhatsAppApiError(`media download failed for ${mediaId}`, fileRes.status);
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());

  return {
    buffer,
    mimeType: meta.mime_type ?? 'application/octet-stream',
    byteSize: buffer.byteLength,
  };
}
