/**
 * A stand-in for api.anthropic.com, good enough to be lied to at scale.
 *
 * The application reaches this because `ANTHROPIC_BASE_URL` is set in the rig's
 * environment and the SDK reads that variable in its own constructor. Nothing in
 * `src/` knows this file exists, and no production code was changed to make it
 * work — which is the point. The real SDK, the real transport, the real retry
 * and backoff behaviour and the real 429 handling all run; only the far end is
 * ours.
 *
 * Every model call the application makes forces a tool:
 *
 *   interpret.ts        tool_choice { name: 'interpret' }
 *   faq.ts              tool_choice { name: 'answer' }
 *   respond.ts          tool_choice { name: 'respond' }   (twice)
 *   tradeQuestions.ts   tool_choice { name: 'questions' }
 *   translate.ts        no tool — plain text back
 *
 * and then looks for a `tool_use` block carrying that name. So this server does
 * not need to know which call site it is answering: it reads the name out of
 * `tool_choice` and answers in that shape. A new call site would be handled
 * without touching this file, and an unknown tool name is reported loudly rather
 * than answered with something plausible.
 *
 *   PORT                  default 8788
 *   MOCK_LATENCY_MIN_MS   default 1000
 *   MOCK_LATENCY_MAX_MS   default 2000
 *   MOCK_429_RATE         0..1, default 0 — share of requests answered 429
 *   MOCK_ERROR_RATE       0..1, default 0 — share answered 500
 *
 * Counters at GET /__stats, reset at POST /__reset, and the latency and failure
 * rates can be changed mid-run with POST /__config so a saturation test does not
 * need a restart.
 */

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8788);

const tuning = {
  latencyMinMs: Number(process.env.MOCK_LATENCY_MIN_MS ?? 1000),
  latencyMaxMs: Number(process.env.MOCK_LATENCY_MAX_MS ?? 2000),
  rate429: Number(process.env.MOCK_429_RATE ?? 0),
  rate500: Number(process.env.MOCK_ERROR_RATE ?? 0),
};

const counters = {
  total: 0,
  active: 0,
  completed: 0,
  errors: 0,
  sent429: 0,
  sent500: 0,
  maxConcurrent: 0,
  byTool: {} as Record<string, number>,
  latencyMs: [] as number[],
};

/**
 * Deterministic per request rather than random, so two runs of the same test
 * inject failures at the same points and a difference between them is the
 * application changing rather than the dice.
 */
let sequence = 0;
function shouldInject(rate: number, n: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  // Evenly spaced rather than clustered: 0.1 fires on every tenth request.
  return Math.floor(n * rate) > Math.floor((n - 1) * rate);
}

function latencyFor(n: number): number {
  const { latencyMinMs, latencyMaxMs } = tuning;
  if (latencyMaxMs <= latencyMinMs) return latencyMinMs;
  // A repeatable spread across the band, not a constant and not random.
  const spread = latencyMaxMs - latencyMinMs;
  return latencyMinMs + ((n * 7919) % spread);
}

interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  messages?: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string }>;
  tool_choice?: { type: string; name?: string };
}

/** The candidate's own words, dug out of the last user message. */
function lastUserText(body: AnthropicRequest): string {
  const last = body.messages?.[body.messages.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join(' ');
  }
  return '';
}

/**
 * What the tool call should say.
 *
 * `interpret` is the one that matters: it is on the path of every free-text
 * answer, and the flow only advances if what comes back is usable. A reply that
 * looks like a date is normalised to ISO because that is what the step's own
 * validation expects; anything else is handed back as the value it plainly is.
 * Neither is clever, and neither needs to be — the point of the rig is to load
 * the transport, the gate and the queue, not to test comprehension.
 */
function toolInput(tool: string, text: string): Record<string, unknown> {
  const trimmed = text.split('Candidate' + "'" + 's reply:').pop()?.trim() ?? text.trim();
  const reply = trimmed.slice(0, 200);

  switch (tool) {
    case 'interpret': {
      const date = reply.match(/([0-9]{1,2})[/-]([0-9]{1,2})[/-]([0-9]{4})/);
      if (date) {
        const [, d, m, y] = date;
        return {
          classification: 'value',
          value: `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`,
        };
      }

      // A structured question names its parts in the prompt — `interpret.ts`
      // writes "This question wants these parts: city, district, state,
      // country." Returning a bare `value` for one of those is not an answer:
      // the step stores `fields`, `satisfied` reads them, and a reply without
      // them is rejected. Two rejections in a row hand the candidate to staff
      // (§8) and the run quietly stops being a registration.
      const wants = text.match(/wants these parts:([^.]*)/);
      if (wants) {
        const parts = wants[1]!.split(',').map((x) => x.trim()).filter(Boolean);
        const pieces = reply.split(',').map((x) => x.trim()).filter(Boolean);
        const fields: Record<string, string> = {};

        if (parts.includes('city') && parts.includes('state') && pieces.length >= 2) {
          // "Chennai, Tamil Nadu" — city first, state last. Anything between is
          // left out rather than guessed at, which is what the tool asks for.
          fields.city = pieces[0]!;
          fields.state = pieces[pieces.length - 1]!;
        } else {
          pieces.forEach((piece, i) => {
            if (parts[i]) fields[parts[i]!] = piece;
          });
        }

        return { classification: 'value', value: reply, fields };
      }

      return { classification: 'value', value: reply };
    }
    case 'answer':
      return { answerable: false, reason: 'load-test mock does not answer FAQs' };
    case 'respond':
      return { reply: 'Thanks — noted.', related: true };
    case 'questions':
      return { questions: [] };
    default:
      return {};
  }
}

function messageResponse(tool: string | undefined, text: string, model: string) {
  const content = tool
    ? [{ type: 'tool_use', id: `toolu_mock_${++sequence}`, name: tool, input: toolInput(tool, text) }]
    : // translate.ts takes plain text. Echoing the input keeps the English run
      // English and keeps the transcript readable.
      [{ type: 'text', text: text.slice(0, 2000) }];

  return {
    id: `msg_mock_${sequence}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: tool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 40 },
  };
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/__stats') {
    const sorted = [...counters.latencyMs].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : 0);
    send(res, 200, {
      ...counters,
      latencyMs: undefined,
      latency: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0 },
      tuning,
    });
    return;
  }

  if (url.pathname === '/__reset' && req.method === 'POST') {
    counters.total = 0;
    counters.completed = 0;
    counters.errors = 0;
    counters.sent429 = 0;
    counters.sent500 = 0;
    counters.maxConcurrent = 0;
    counters.byTool = {};
    counters.latencyMs = [];
    send(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/__config' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        Object.assign(tuning, JSON.parse(raw || '{}'));
      } catch {
        /* keep the current tuning */
      }
      send(res, 200, tuning);
    });
    return;
  }

  if (!url.pathname.endsWith('/messages')) {
    send(res, 404, { type: 'error', error: { type: 'not_found_error', message: url.pathname } });
    return;
  }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const n = ++counters.total;
    counters.active += 1;
    counters.maxConcurrent = Math.max(counters.maxConcurrent, counters.active);

    let body: AnthropicRequest = {};
    try {
      body = JSON.parse(raw || '{}') as AnthropicRequest;
    } catch {
      /* answered as a malformed request below */
    }

    const tool = body.tool_choice?.name;
    if (tool) counters.byTool[tool] = (counters.byTool[tool] ?? 0) + 1;

    const startedAt = Date.now();
    const finish = (fn: () => void) => {
      setTimeout(() => {
        counters.active -= 1;
        counters.latencyMs.push(Date.now() - startedAt);
        fn();
      }, latencyFor(n));
    };

    // Throttling first, and *before* the latency wait — a real 429 comes back
    // fast. Answering it slowly would hide the retry storm it is meant to cause.
    if (shouldInject(tuning.rate429, n)) {
      counters.active -= 1;
      counters.sent429 += 1;
      counters.errors += 1;
      send(
        res,
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'mock: rate limited' } },
        { 'retry-after': '1' },
      );
      return;
    }

    if (shouldInject(tuning.rate500, n)) {
      finish(() => {
        counters.sent500 += 1;
        counters.errors += 1;
        send(res, 500, { type: 'error', error: { type: 'api_error', message: 'mock: server error' } });
      });
      return;
    }

    if (!raw) {
      finish(() => {
        counters.errors += 1;
        send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'empty body' } });
      });
      return;
    }

    finish(() => {
      counters.completed += 1;
      send(res, 200, messageResponse(tool, lastUserText(body), body.model ?? 'mock'));
    });
  });
});

// Hundreds of concurrent requests, each held open for a second or two.
// `maxConnections` is deliberately left alone: in Node it is a *rejection*
// threshold, and setting it to 0 refuses every connection rather than allowing
// any number of them. Unset is unlimited.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `mock anthropic on http://127.0.0.1:${PORT}  ` +
      `latency ${tuning.latencyMinMs}-${tuning.latencyMaxMs}ms  429 ${tuning.rate429}  500 ${tuning.rate500}`,
  );
});
