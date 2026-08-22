/**
 * The thing that makes this rig safe to run: nothing leaves the machine.
 *
 * `globalThis.fetch` is replaced with a wrapper that answers three kinds of
 * request and refuses everything else by throwing. It is an allowlist, not a
 * blocklist, so a call this file has never heard of fails loudly on the first
 * attempt rather than quietly reaching a real service — which is the failure
 * mode that actually matters when the alternative is messaging real candidates
 * or spending a real Anthropic budget.
 *
 *   graph.facebook.com    intercepted and answered locally. Never dialled.
 *   127.0.0.1 / localhost passed through — the mock, the app, the rig itself.
 *   anything else         throws. graph, api.anthropic.com over its real host,
 *                         the CRM, Veris: none of them can be reached from here.
 *
 * Anthropic is *not* intercepted here on purpose. It goes over real HTTP to the
 * local mock via `ANTHROPIC_BASE_URL`, so the SDK's own transport, retries,
 * backoff and 429 handling are all exercised. Intercepting it would test this
 * file instead of the thing being measured.
 *
 * Intercepting Graph rather than using SHADOW_MODE is deliberate and is the
 * whole of Step 8. Every shadow-mode check in `whatsapp/client.ts` returns
 * *before* `budgets.replies.acquire()`, so with SHADOW_MODE=true the 20/sec
 * reply limiter never runs and a load test measures a system with its main
 * bottleneck removed. With the limiter left in and the socket stubbed here, the
 * real queueing behaviour is what gets measured.
 */

export interface OutboundRecord {
  seq: number;
  waId: string;
  at: number;
  type: 'text' | 'interactive' | 'template' | 'read' | 'other';
  text: string;
  optionIds: string[];
}

export interface GuardStats {
  graphRequests: number;
  graphSends: number;
  graphReads: number;
  graphErrors: number;
  /** Media metadata lookups — the first hop of a download. */
  graphMediaLookups: number;
  /** Requests that genuinely left the machine, via LOADTEST_ALLOW_HOST. */
  externalRequests: number;
  blocked: number;
  blockedHosts: string[];
  /** Epoch millis of every reply handed to Graph — the reply-rate evidence. */
  sendTimestamps: number[];
}

/**
 * Answers Meta's media metadata hop.
 *
 * Returning a real `file_size` and a real URL is what lets the application's own
 * `downloadMedia` run in full: L1 reads `file_size` here, L2 reads
 * `Content-Length` off the served file, L3 counts the bytes as they arrive, and
 * the 10/sec media limiter is spent on the way in. Setting
 * `MOCK_WHATSAPP_MEDIA=true` instead would short-circuit all four before any of
 * them executed, so the media protections added in Step 5 would go untested at
 * exactly the load that matters.
 */
export interface MediaSource {
  /** Bytes and type for a media id, or undefined for an id we do not serve. */
  describe: (mediaId: string) => { byteSize: number; mimeType: string } | undefined;
  /** Where the bytes will be served from. Must be a host the guard allows. */
  urlFor: (mediaId: string) => string;
}

const ALLOWED_LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const GRAPH_HOST = 'graph.facebook.com';

/**
 * One extra host, named explicitly, opted into by environment variable.
 *
 * This is the only way real external traffic can leave the rig, and it exists
 * so that "test against the live OCR service" is a decision somebody makes out
 * loud rather than a default. Unset, the guard behaves exactly as before and
 * refuses everything but Graph and loopback.
 */
const EXTRA_ALLOWED = (process.env.LOADTEST_ALLOW_HOST ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

export function installFetchGuard(sink: {
  onOutbound: (record: Omit<OutboundRecord, 'seq'>) => void;
  media?: MediaSource;
}): { stats: () => GuardStats; reset: () => void } {
  const real = globalThis.fetch;

  const stats: GuardStats = {
    graphRequests: 0,
    graphSends: 0,
    graphReads: 0,
    graphErrors: 0,
    graphMediaLookups: 0,
    externalRequests: 0,
    blocked: 0,
    blockedHosts: [],
    sendTimestamps: [],
  };

  let wamid = 0;

  type FetchInput = Parameters<typeof fetch>[0];

  globalThis.fetch = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let host: string;
    try {
      host = new URL(href).hostname;
    } catch {
      host = '';
    }

    if (ALLOWED_LOCAL.has(host)) return real(input, init);

    // Real external traffic, and the only path to it. Counted separately so a
    // report can never confuse it with something answered locally.
    if (EXTRA_ALLOWED.includes(host)) {
      stats.externalRequests += 1;
      return real(input, init);
    }

    if (host === GRAPH_HOST) {
      stats.graphRequests += 1;

      // The media metadata hop is a GET on /{media-id}. Answering it with a
      // real size and a real local URL is what makes the download path run for
      // real rather than being mocked away.
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && sink.media) {
        const mediaId = new URL(href).pathname.split('/').filter(Boolean).pop() ?? '';
        const described = sink.media.describe(mediaId);
        if (described) {
          stats.graphMediaLookups += 1;
          return json({
            messaging_product: 'whatsapp',
            url: sink.media.urlFor(mediaId),
            mime_type: described.mimeType,
            sha256: 'mock',
            file_size: described.byteSize,
            id: mediaId,
          });
        }
      }

      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      } catch {
        stats.graphErrors += 1;
      }

      if (body.status === 'read') {
        stats.graphReads += 1;
        return json({ success: true });
      }

      stats.graphSends += 1;
      stats.sendTimestamps.push(Date.now());
      sink.onOutbound(describe(body));

      return json({
        messaging_product: 'whatsapp',
        contacts: [{ wa_id: String(body.to ?? '') }],
        messages: [{ id: `wamid.RIG${++wamid}` }],
      });
    }

    stats.blocked += 1;
    if (!stats.blockedHosts.includes(host)) stats.blockedHosts.push(host);
    // Loud, and fatal for that call. A rig that silently allowed one of these
    // would be worse than no rig at all.
    throw new Error(
      `loadtest guard: refused an outbound request to ${host || href}. ` +
        'Only graph.facebook.com (stubbed) and localhost are permitted.',
    );
  }) as typeof fetch;

  return {
    stats: () => ({ ...stats, sendTimestamps: [...stats.sendTimestamps] }),
    reset: () => {
      stats.graphRequests = 0;
      stats.graphSends = 0;
      stats.graphReads = 0;
      stats.graphErrors = 0;
      stats.graphMediaLookups = 0;
      stats.externalRequests = 0;
      stats.blocked = 0;
      stats.blockedHosts = [];
      stats.sendTimestamps.length = 0;
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Reads a Graph send payload back into something the generator can answer.
 *
 * The option ids matter: they are what the next simulated tap carries, and
 * taking them from the message the bot actually sent is what keeps the script
 * following the real flow instead of a guess about it.
 */
function describe(body: Record<string, unknown>): Omit<OutboundRecord, 'seq'> {
  const waId = String(body.to ?? '');
  const at = Date.now();

  if (body.type === 'text') {
    const text = (body.text as { body?: string } | undefined)?.body ?? '';
    return { waId, at, type: 'text', text, optionIds: [] };
  }

  if (body.type === 'interactive') {
    const interactive = body.interactive as
      | {
          body?: { text?: string };
          action?: {
            buttons?: Array<{ reply?: { id?: string } }>;
            sections?: Array<{ rows?: Array<{ id?: string }> }>;
          };
        }
      | undefined;

    const ids: string[] = [];
    for (const b of interactive?.action?.buttons ?? []) if (b.reply?.id) ids.push(b.reply.id);
    for (const s of interactive?.action?.sections ?? []) {
      for (const r of s.rows ?? []) if (r.id) ids.push(r.id);
    }

    return {
      waId,
      at,
      type: 'interactive',
      text: interactive?.body?.text ?? '',
      optionIds: ids,
    };
  }

  if (body.type === 'template') return { waId, at, type: 'template', text: '', optionIds: [] };
  return { waId, at, type: 'other', text: '', optionIds: [] };
}
