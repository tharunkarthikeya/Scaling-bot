import { config, graphBaseUrl } from '../config.js';
import { logger } from '../logger.js';
import { accessTokenFor, sendingNumberFor } from '../conversation/lines.js';
import { createBudget } from './rateLimiter.js';

/**
 * Outbound Graph traffic, split by what Meta is actually being asked to do.
 *
 * One bucket used to cover all three, so every inbound message spent a token on
 * its read receipt before the reply had been composed, and every document spent
 * another fetching itself — roughly halving the messaging allowance the number
 * actually has. A candidate's answer queued behind the acknowledgement of their
 * own last message.
 *
 * The partition is the point: capacity cannot move between these, by
 * construction rather than by priority. Replies keep the whole of the limit
 * Meta grants for messages, and the other two are bounded on their own terms.
 */
const budgets = {
  /** Messages to candidates. Waited for, never dropped. */
  replies: createBudget('replies', config.OUTBOUND_RATE_PER_SECOND),
  /** Blue ticks. Dropped when there is no room — see `markAsRead`. */
  receipts: createBudget('receipts', config.READ_RECEIPT_RATE_PER_SECOND),
  /** Inbound document fetches. Waited for; the file matters. */
  media: createBudget('media', config.MEDIA_DOWNLOAD_RATE_PER_SECOND),
} as const;

/**
 * The budgets, for tests and for load-test instrumentation.
 *
 * Exported so a test can prove the partition holds on the wiring itself rather
 * than on a copy of it, and so a load run can report which budget is actually
 * saturated.
 */
export const outboundBudgets = budgets;

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

/**
 * Posts to the Graph API. Deliberately does **not** rate limit.
 *
 * Which budget a call spends from is a property of what the call is for, not of
 * how it is transported, and this function cannot tell the difference between a
 * reply and a read receipt — they are the same endpoint. So every caller takes
 * its token first, from the budget named above. Adding a caller here without
 * taking one spends nobody's allowance and will eventually cost a real message.
 *
 * `from` is the number the call is made on behalf of, and it decides the
 * credential as well as the path. Where the two lines share a Meta app that is
 * the same token either way; where they do not, calling the second number with
 * the first's token is a 401 nobody would attribute to configuration.
 */
async function graphPost(path: string, body: unknown, from?: FromNumber): Promise<any> {
  const res = await fetch(`${graphBaseUrl}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessTokenFor(sendingNumberFor(from))}`,
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

/**
 * Which of the agency's numbers a message leaves from.
 *
 * Every send takes it, and every send defaults it to the main number, so a
 * caller that does not know about the second line behaves exactly as it did.
 * The default is applied by `sendingNumberFor` rather than here, so "blank
 * means the main number" is one decision in one place.
 *
 * It matters beyond tidiness: the 24-hour customer service window belongs to the
 * *pair* of numbers, so replying to a candidate from the number they did not
 * write to is not merely confusing, it is a message Meta refuses.
 */
export type FromNumber = string | undefined;

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

export async function sendText(
  to: string,
  text: string,
  from?: FromNumber,
): Promise<SendResult[]> {
  const parts = chunkText(text);
  const results: SendResult[] = [];

  for (const part of parts) {
    if (config.SHADOW_MODE) {
      logger.info({ to, text: part }, 'shadow mode: outbound suppressed');
      results.push({ shadowed: true });
      continue;
    }

    // One token per chunk, because Meta counts one message per chunk.
    await budgets.replies.acquire();

    const json = await graphPost(
      `${sendingNumberFor(from)}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: part },
      },
      from,
    );

    results.push({ wamid: json?.messages?.[0]?.id, shadowed: false });
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Interactive messages                                                */
/*                                                                     */
/* §1 asks for buttons wherever possible. WhatsApp offers two shapes:  */
/* up to three reply buttons, or a list of up to ten rows behind a     */
/* single tap. Which one is used is decided by the number of options,  */
/* not by the caller.                                                  */
/* ------------------------------------------------------------------ */

export interface Button {
  id: string;
  title: string;
}

export interface Row {
  id: string;
  title: string;
  description?: string;
}

export type Outbound =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; buttons: Button[] }
  | { kind: 'list'; body: string; buttonText: string; rows: Row[] };

/** Meta's limits. Exceeding one rejects the whole message rather than trimming it. */
const INTERACTIVE_BODY_LIMIT = 1024;
const BUTTON_TITLE_LIMIT = 20;
const ROW_TITLE_LIMIT = 24;
const ROW_DESCRIPTION_LIMIT = 72;
const MAX_BUTTONS = 3;
const MAX_ROWS = 10;

function clip(text: string, limit: number): string {
  const glyphs = [...text];
  return glyphs.length <= limit ? text : glyphs.slice(0, limit - 1).join('') + '…';
}

/**
 * Sends a message, choosing the WhatsApp shape that fits it.
 *
 * A body longer than the interactive limit is sent as a plain message first and
 * the options follow with a short prompt — the alternative is Meta rejecting the
 * message and the candidate receiving nothing.
 */
export async function send(
  to: string,
  message: Outbound,
  from?: FromNumber,
): Promise<SendResult[]> {
  if (message.kind === 'text') return sendText(to, message.body, from);

  const results: SendResult[] = [];
  let body = message.body;

  if ([...body].length > INTERACTIVE_BODY_LIMIT) {
    const split = [...body].length - INTERACTIVE_BODY_LIMIT;
    logger.warn({ to, overBy: split }, 'interactive body too long; sending it as text first');
    results.push(...(await sendText(to, body, from)));
    body = message.kind === 'buttons' ? '👇' : '👇';
  }

  const interactive =
    message.kind === 'buttons'
      ? {
          type: 'button',
          body: { text: body },
          action: {
            buttons: message.buttons.slice(0, MAX_BUTTONS).map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: clip(b.title, BUTTON_TITLE_LIMIT) },
            })),
          },
        }
      : {
          type: 'list',
          body: { text: body },
          action: {
            button: clip(message.buttonText, BUTTON_TITLE_LIMIT),
            sections: [
              {
                rows: message.rows.slice(0, MAX_ROWS).map((r) => ({
                  id: r.id,
                  title: clip(r.title, ROW_TITLE_LIMIT),
                  ...(r.description
                    ? { description: clip(r.description, ROW_DESCRIPTION_LIMIT) }
                    : {}),
                })),
              },
            ],
          },
        };

  if (config.SHADOW_MODE) {
    logger.info({ to, body, interactive }, 'shadow mode: interactive suppressed');
    results.push({ shadowed: true });
    return results;
  }

  await budgets.replies.acquire();

  const json = await graphPost(
    `${sendingNumberFor(from)}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive,
    },
    from,
  );

  results.push({ wamid: json?.messages?.[0]?.id, shadowed: false });
  return results;
}

/**
 * Sends the approved re-engagement template. This is the only thing that may be
 * sent once the 24-hour window has closed.
 */
export async function sendReengagementTemplate(
  to: string,
  from?: FromNumber,
): Promise<SendResult> {
  const name = config.WHATSAPP_REENGAGEMENT_TEMPLATE;
  if (!name) throw new Error('WHATSAPP_REENGAGEMENT_TEMPLATE is not configured');

  if (config.SHADOW_MODE) {
    logger.info({ to, template: name }, 'shadow mode: template suppressed');
    return { shadowed: true };
  }

  await budgets.replies.acquire();

  const json = await graphPost(
    `${sendingNumberFor(from)}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name,
        language: { code: config.WHATSAPP_REENGAGEMENT_TEMPLATE_LANG },
      },
    },
    from,
  );

  return { wamid: json?.messages?.[0]?.id, shadowed: false };
}

/**
 * One approved template, with its body parameters filled in.
 *
 * Both callers below are templates for the same reason, and it is not a matter
 * of taste: neither a staff member nor an admin ever messages this number, so
 * the 24-hour window that free-form text needs is closed for them permanently
 * and always will be. Meta refuses such a send outright - the failure is a 400,
 * not a message that quietly does not arrive.
 *
 * Parameters are positional because a WhatsApp template's are: `{{1}}` is the
 * first element of the array and there is no way to name them. Each caller
 * documents its own order against the body submitted to Meta.
 */
async function sendBodyTemplate(
  to: string,
  name: string,
  language: string,
  parameters: string[],
  from?: FromNumber,
): Promise<SendResult> {
  if (config.SHADOW_MODE) {
    logger.info({ to, template: name, parameters }, 'shadow mode: template suppressed');
    return { shadowed: true };
  }

  // From the same budget as a reply. It is the same Meta rate limit and the
  // same number: a burst of allocations that spent nothing here would simply
  // spend it out of a candidate's reply a moment later, and be harder to see.
  await budgets.replies.acquire();

  const json = await graphPost(
    `${sendingNumberFor(from)}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: [
          {
            type: 'body',
            // Meta rejects a newline inside a parameter, which is worth knowing
            // here rather than in a 400: the line breaks belong to the template
            // body, and each parameter is one field's worth of text.
            parameters: parameters.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    },
    from,
  );

  return { wamid: json?.messages?.[0]?.id, shadowed: false };
}

/**
 * Tells one staff member, on their own number, that a candidate is now theirs.
 *
 * Parameter order is fixed by `staffAssignmentParameters` in `staff/notify.ts`,
 * which is the one place it is written down.
 */
export async function sendStaffAssignmentTemplate(
  to: string,
  parameters: { header: string; body: string[] },
  from?: FromNumber,
): Promise<SendResult> {
  const name = config.WHATSAPP_STAFF_ASSIGNMENT_TEMPLATE;
  if (!name) throw new Error('WHATSAPP_STAFF_ASSIGNMENT_TEMPLATE is not configured');

  if (config.SHADOW_MODE) {
    logger.info({ to, template: name, parameters }, 'shadow mode: template suppressed');
    return { shadowed: true };
  }

  await budgets.replies.acquire();

  const json = await graphPost(
    `${sendingNumberFor(from)}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name,
        language: { code: config.WHATSAPP_STAFF_ASSIGNMENT_TEMPLATE_LANG },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'text', text: parameters.header }],
          },
          {
            type: 'body',
            parameters: parameters.body.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    },
    from,
  );

  return { wamid: json?.messages?.[0]?.id, shadowed: false };
}

/**
 * Tells one admin that a candidate has sat with a staff member untouched.
 *
 * Parameter order is fixed by `slaAlertParameters` in `staff/notify.ts`.
 */
export async function sendSlaAlertTemplate(
  to: string,
  parameters: string[],
  from?: FromNumber,
): Promise<SendResult> {
  const name = config.WHATSAPP_SLA_ALERT_TEMPLATE;
  if (!name) throw new Error('WHATSAPP_SLA_ALERT_TEMPLATE is not configured');
  return sendBodyTemplate(to, name, config.WHATSAPP_SLA_ALERT_TEMPLATE_LANG, parameters, from);
}

/**
 * Best-effort read receipt. Failing to mark read must never block processing.
 *
 * Spends from its own budget, and gives up rather than waiting for one. Both
 * halves matter. Taking a reply token meant a blue tick could delay an answer;
 * *waiting* for a token meant a caller that fires this and walks away — which is
 * every caller, it is invoked as `void markAsRead(...)` — left a promise pending
 * for as long as the overload lasted, one per message, remembered by nobody.
 *
 * A receipt that cannot be sent now is worth less than the memory of intending
 * to send it, so it is dropped and logged at debug.
 */
export async function markAsRead(wamid: string, from?: FromNumber): Promise<void> {
  if (config.SHADOW_MODE) return;

  if (!(await budgets.receipts.tryAcquire())) {
    logger.debug({ wamid }, 'read receipt dropped: no capacity in the receipt budget');
    return;
  }

  try {
    // The receipt has to be posted to the number the message arrived on. Sent
    // to the other one it is a message id that number has never seen, and Meta
    // rejects it — a blue tick that never appears on the second line.
    await graphPost(
      `${sendingNumberFor(from)}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: wamid,
      },
      from,
    );
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
 * An inbound file larger than this instance is willing to hold.
 *
 * Permanent, and that is the whole reason it has its own class. Every other
 * download failure is worth another go — a timeout, a 500, an expired URL. A
 * file that is too big is still too big on the fifth attempt, and the ledger
 * has to be able to tell the two apart or it spends `INGESTION_MAX_ATTEMPTS`
 * re-fetching something it was always going to refuse.
 *
 * 413 rather than a Meta status code, because nothing on Meta's side went
 * wrong. This is our limit, refusing their file.
 */
export class MediaTooLargeError extends WhatsAppApiError {
  /** Read by `captureAttachment`, which schedules no retry when it is set. */
  readonly permanent = true;

  constructor(
    what: string,
    readonly limit: number,
    /** Bytes, where anything was willing to say — absent when we stopped counting. */
    readonly reported?: number,
  ) {
    super(
      `${what} is larger than the ${limit}-byte limit` +
        (reported === undefined ? '' : ` (${reported} bytes)`),
      413,
    );
  }
}

/**
 * The Graph host media metadata is resolved against.
 *
 * A `let` only so tests can point the first hop at a local server; production
 * reads it once and never writes it. See `setMediaBaseUrlForTests`.
 */
let mediaBaseUrl: string = graphBaseUrl;

/**
 * Points media lookups at a stub. Tests only — it is how the size limit is
 * exercised against real HTTP responses, chunked bodies and lying headers,
 * without a network or a token.
 */
export function setMediaBaseUrlForTests(replacement: string): () => void {
  const previous = mediaBaseUrl;
  mediaBaseUrl = replacement;
  return () => {
    mediaBaseUrl = previous;
  };
}

/**
 * Reads a response body, refusing to hold more than `limit` bytes of it.
 *
 * Two layers, and they are not redundant.
 *
 * `Content-Length` is checked first because it costs nothing and, when it is
 * both present and honest, the body is never opened at all. It is not a
 * guarantee: the header is optional, a chunked response omits it entirely, and
 * a value in it is a claim by whoever is sending rather than a promise about
 * what the socket will deliver.
 *
 * So the bytes are counted as they arrive and the read is abandoned the moment
 * the running total passes the limit. That is the layer that actually bounds
 * memory, and it holds when the header is missing, when it is wrong, and when
 * the far end simply keeps sending. What is held at the worst moment is the
 * limit plus one chunk, never the whole file.
 *
 * `abort` is called before either refusal, so the socket is closed rather than
 * left delivering a file nobody will read.
 */
export async function readCappedBody(
  res: Pick<Response, 'headers' | 'body'>,
  limit: number,
  what: string,
  abort?: () => void,
): Promise<Buffer> {
  // L2 — what the response claims, before the body is opened.
  const advertised = Number(res.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) {
    abort?.();
    throw new MediaTooLargeError(what, limit, advertised);
  }

  if (!res.body) return Buffer.alloc(0);

  // L3 — what actually arrives.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;

    if (total > limit) {
      // Stop the transfer before anything else. The chunks already read go out
      // of scope with this function and the rest is never asked for.
      abort?.();
      await reader.cancel().catch(() => undefined);
      throw new MediaTooLargeError(what, limit, undefined);
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks, total);
}

/**
 * Media download is two hops: resolve the id to a short-lived signed URL, then
 * fetch that URL. The second request still needs the bearer token — Meta's CDN
 * rejects unauthenticated reads.
 *
 * The size limit is enforced three times, each at the first moment it becomes
 * possible:
 *
 *   L1  `file_size` in the metadata response, before the file is requested at
 *       all. This is the one that matters — a refusal here costs one small JSON
 *       request and not a byte of the document.
 *   L2  `Content-Length` on the file response, before its body is opened.
 *   L3  the bytes themselves, counted as they arrive.
 *
 * Three rather than one because the first two are assertions by the other end
 * and only the third is a measurement. `file_size` and `Content-Length` may be
 * absent, may disagree with each other, and may both disagree with what the
 * socket delivers. The earlier layers exist to make the common case cheap, not
 * to make the last one unnecessary.
 */
/**
 * `filename` is only ever read in mock mode, to choose which canned file to
 * serve. The real download is by id and Meta tells us the type itself.
 */
export async function downloadMedia(
  mediaId: string,
  filename?: string,
  from?: FromNumber,
): Promise<MediaPayload> {
  const limit = config.MEDIA_MAX_BYTES;

  if (config.MOCK_WHATSAPP_MEDIA) {
    const { fixtureFor } = await import('../testing/fixtures.js');
    // The media id makes each mocked CV a distinct file. Two candidates sending
    // the identical résumé is not a thing that happens, and a CRM that
    // deduplicates on the résumé hash is right to treat it as one person.
    const pdf = fixtureFor(filename, mediaId);
    // Held to the same limit as a real download. A fixture that outgrew it
    // would otherwise take a path production cannot take, which is the one
    // thing a fixture must never do.
    if (pdf.byteLength > limit) {
      throw new MediaTooLargeError(`mock media ${mediaId}`, limit, pdf.byteLength);
    }
    logger.warn({ mediaId, filename }, 'MOCK_WHATSAPP_MEDIA is on — serving a canned file');
    return { buffer: pdf, mimeType: 'application/pdf', byteSize: pdf.byteLength };
  }

  // Not a message, and not on the messaging budget. This runs inside the
  // webhook before the acknowledgement, so keeping it out of the reply queue is
  // also what stops a document arriving mid-conversation from adding that
  // queue's latency to every ACK.
  await budgets.media.acquire();

  // A media id belongs to the WABA it was uploaded to, so the credential has to
  // be that line's. The wrong one is a 404 on a file that is really there.
  const token = accessTokenFor(sendingNumberFor(from));

  const metaRes = await fetch(`${mediaBaseUrl}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!metaRes.ok) {
    throw new WhatsAppApiError(`media lookup failed for ${mediaId}`, metaRes.status);
  }

  const meta = (await metaRes.json()) as {
    url?: string;
    mime_type?: string;
    file_size?: number | string;
  };
  if (!meta.url) throw new WhatsAppApiError(`media ${mediaId} has no download url`, 502);

  // L1 — Meta states the size alongside the URL. Refusing here means an
  // oversized document costs the metadata request and nothing else: the file is
  // never requested, so none of it is ever in this process.
  const declared = Number(meta.file_size);
  if (Number.isFinite(declared) && declared > limit) {
    logger.warn(
      { mediaId, fileSize: declared, limit },
      'media refused on its declared size; the file was not requested',
    );
    throw new MediaTooLargeError(`media ${mediaId}`, limit, declared);
  }

  const controller = new AbortController();

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });

  if (!fileRes.ok) {
    controller.abort();
    throw new WhatsAppApiError(`media download failed for ${mediaId}`, fileRes.status);
  }

  const buffer = await readCappedBody(fileRes, limit, `media ${mediaId}`, () => controller.abort());

  return {
    buffer,
    mimeType: meta.mime_type ?? 'application/octet-stream',
    byteSize: buffer.byteLength,
  };
}
