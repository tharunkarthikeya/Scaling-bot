/**
 * The load generator.
 *
 * Runs N independent virtual candidates against the rig's webhook. Each has its
 * own waId, its own candidate document, its own session, its own lock key and
 * its own queue ordering key — nothing is shared, because a load test that
 * reuses one candidate for many users measures the lock rather than the system.
 *
 * Two latencies are recorded and they are not the same number:
 *
 *   ACK       how long `POST /webhook` took to return 200. The webhook enqueues
 *             and returns, so this is the time Meta would wait — and on its own
 *             it says almost nothing about whether the bot is keeping up.
 *   REPLY     how long until the bot actually sent something back, observed on
 *             the control port. This is the number a candidate experiences, and
 *             it is the one that degrades first.
 *
 * Reporting only the first is how a load test concludes a saturated system is
 * healthy. Both are reported, always, and the summary leads with reply latency.
 *
 *   npm run loadtest -- --users 10
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Conversation,
  envelope,
  messageFor,
  type BotReply,
  type OutboundMessage,
} from './scenario.js';
import { Stats, percentile } from './stats.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADTEST_DIR = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const OPTIONS = {
  users: Number(arg('users', '10')),
  messages: Number(arg('messages', '8')),
  /** Think time between a reply landing and the next message, in ms. */
  think: Number(arg('think', '1200')),
  /** Seconds over which users are started. 0 starts them all at once. */
  rampup: Number(arg('rampup', '10')),
  /** Hard stop, seconds. 0 means run until every user finishes its script. */
  duration: Number(arg('duration', '0')),
  /** How long to wait for one bot reply before recording a timeout. */
  replyTimeout: Number(arg('reply-timeout', '30000')),
  /**
   * Consecutive timeouts before this candidate gives up.
   *
   * A conversation that has stopped answering does not start again, and
   * grinding through the remaining turns at one timeout each turns a
   * broken run into a very slow one. Two strikes and the user stops, which
   * is both faster and a clearer signal.
   */
  giveUpAfter: Number(arg('give-up-after', '2')),
  /**
   * Grace period after the first reply of a turn lands.
   *
   * A turn can produce more than one message — an acknowledgement and then
   * the next question. Answering the first and leaving the second buffered
   * puts the script one message behind for the rest of the conversation:
   * every later answer is given to the previous question, the bot rejects
   * two in a row, and it hands the candidate to staff (§8) exactly as it
   * should. `harness.ts` waits for the same reason.
   */
  replySettle: Number(arg('reply-settle', '500')),
  /**
   * Quiet time after the last user finishes, before the final snapshot.
   *
   * Without it the report is taken while work is still in flight and reads
   * as failure: jobs counted as started but not completed, model calls
   * counted as sent but not returned. The run is over; the system is still
   * finishing it.
   */
  settle: Number(arg('settle', '5000')),
  label: arg('label', ''),
};

const runtimePath = path.join(LOADTEST_DIR, '.runtime.json');
if (!fs.existsSync(runtimePath)) {
  console.error('No .runtime.json — start the rig first:  npm run loadtest:rig');
  process.exit(1);
}
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as {
  appUrl: string;
  controlUrl: string;
  mockUrl: string;
  ocrUrl?: string;
  wabaId: string;
  appSecret: string;
};

const APP = arg('target', runtime.appUrl);
const CONTROL = arg('control', runtime.controlUrl);
const MOCK = arg('mock', runtime.mockUrl);
const OCR = arg('ocr', runtime.ocrUrl ?? 'http://127.0.0.1:8789');
const LABEL = OPTIONS.label || String(OPTIONS.users);

/* ------------------------------------------------------------------ */
/* Counters                                                            */
/* ------------------------------------------------------------------ */

const ack = new Stats();
const replyLatency = new Stats();
const statuses = new Map<number, number>();

const counts = {
  requests: 0,
  ok: 0,
  failed: 0,
  transportErrors: 0,
  replies: 0,
  replyTimeouts: 0,
  usersStarted: 0,
  usersFinished: 0,
  messagesSent: 0,
  usersAbandoned: 0,
  documentsSent: 0,
  registrationsCompleted: 0,
};

const bump = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);

/* ------------------------------------------------------------------ */
/* One virtual candidate                                               */
/* ------------------------------------------------------------------ */

function sign(raw: Buffer): string {
  return 'sha256=' + crypto.createHmac('sha256', runtime.appSecret).update(raw).digest('hex');
}

let stopping = false;

async function runUser(index: number): Promise<void> {
  const waId = `9190000${String(100000 + index).slice(-6)}`;
  const conversation = new Conversation(waId);
  let seenSeq = 0;
  let stalled = 0;
  let outgoing: OutboundMessage | undefined = conversation.first();

  counts.usersStarted += 1;

  for (let turn = 0; turn < OPTIONS.messages && !stopping; turn++) {
    if (!outgoing) break;

    const wamid = `wamid.LOAD-${LABEL}-${index}-${turn}`;
    const raw = Buffer.from(
      JSON.stringify(envelope(messageFor(outgoing, waId, wamid), waId, runtime.wabaId)),
    );

    const startedAt = performance.now();
    counts.requests += 1;

    try {
      const res = await fetch(`${APP}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
        body: raw,
      });
      await res.arrayBuffer();

      ack.add(performance.now() - startedAt);
      bump(statuses, res.status);
      if (res.ok) counts.ok += 1;
      else counts.failed += 1;
      counts.messagesSent += 1;
      if (outgoing.type === 'document') counts.documentsSent += 1;
    } catch {
      counts.transportErrors += 1;
      counts.failed += 1;
      ack.add(performance.now() - startedAt);
      break;
    }

    // Wait for the bot to actually say something. This is the number that
    // matters, and it is measured on the control port so asking for it does not
    // add load to the thing being measured.
    const reply = await waitForReply(waId, seenSeq, startedAt);
    if (reply) {
      seenSeq = reply.seq;
      counts.replies += 1;
      stalled = 0;
    } else {
      counts.replyTimeouts += 1;
      stalled += 1;
      if (stalled >= OPTIONS.giveUpAfter) {
        counts.usersAbandoned += 1;
        break;
      }
    }

    if (stopping) break;
    if (OPTIONS.think > 0) await sleep(OPTIONS.think);

    outgoing = conversation.next(reply);
  }

  if (conversation.completed) counts.registrationsCompleted += 1;
  counts.usersFinished += 1;
}

async function waitForReply(
  waId: string,
  after: number,
  sentAt: number,
): Promise<BotReply | undefined> {
  const deadline = Date.now() + OPTIONS.replyTimeout;

  while (Date.now() < deadline && !stopping) {
    try {
      const res = await fetch(
        `${CONTROL}/reply?waId=${waId}&after=${after}&timeout=${Math.min(15000, deadline - Date.now())}`,
      );
      const body = (await res.json()) as { replies: BotReply[] };
      if (body.replies?.length) {
        // Latency is to the FIRST message of the turn — that is when the
        // candidate's phone buzzes.
        replyLatency.add(performance.now() - sentAt);

        // Then let the rest of the turn land before deciding what to say next,
        // and answer the last question asked rather than the first.
        if (OPTIONS.replySettle > 0) {
          await sleep(OPTIONS.replySettle);
          try {
            const again = await fetch(`${CONTROL}/reply?waId=${waId}&after=${after}&timeout=0`);
            const all = (await again.json()) as { replies: BotReply[] };
            if (all.replies?.length) return all.replies[all.replies.length - 1];
          } catch {
            /* fall through to what we already have */
          }
        }
        return body.replies[body.replies.length - 1];
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(
    `\nload test "${LABEL}"  users=${OPTIONS.users} messages=${OPTIONS.messages} ` +
      `think=${OPTIONS.think}ms rampup=${OPTIONS.rampup}s\n` +
      `  app     ${APP}\n  control ${CONTROL}\n`,
  );

  // Reset both sides so the window is exactly this run.
  await fetch(`${CONTROL}/mark`, { method: 'POST' }).catch(() => undefined);
  await fetch(`${MOCK}/__reset`, { method: 'POST' }).catch(() => undefined);
  await fetch(`${OCR}/__reset`, { method: 'POST' }).catch(() => undefined);

  const startedAt = Date.now();

  if (OPTIONS.duration > 0) {
    setTimeout(() => {
      stopping = true;
    }, OPTIONS.duration * 1000).unref();
  }

  const progress = setInterval(() => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
    process.stdout.write(
      `\r  ${secs}s  users ${counts.usersFinished}/${counts.usersStarted}  ` +
        `sent ${counts.messagesSent}  replies ${counts.replies}  ` +
        `timeouts ${counts.replyTimeouts}  failed ${counts.failed}   `,
    );
  }, 1000);
  progress.unref();

  // Ramp-up: start users evenly across the window rather than all at once, so
  // the first seconds are a load test and not a thundering herd.
  const gap = OPTIONS.rampup > 0 ? (OPTIONS.rampup * 1000) / OPTIONS.users : 0;
  const users: Array<Promise<void>> = [];
  for (let i = 0; i < OPTIONS.users; i++) {
    users.push(
      (async () => {
        if (gap > 0) await sleep(i * gap);
        if (!stopping) await runUser(i);
      })(),
    );
  }

  await Promise.all(users);

  // Throughput is measured over the sending window; the counters are read
  // after the system has drained. Mixing the two understates both.
  const durationMs = Date.now() - startedAt;
  if (OPTIONS.settle > 0) await sleep(OPTIONS.settle);

  clearInterval(progress);
  process.stdout.write('\r' + ' '.repeat(100) + '\r');

  const [metrics, mock, db, stages, ocrMock] = await Promise.all([
    fetch(`${CONTROL}/metrics`).then((r) => r.json()).catch(() => null),
    fetch(`${MOCK}/__stats`).then((r) => r.json()).catch(() => null),
    fetch(`${CONTROL}/db`).then((r) => r.json()).catch(() => null),
    fetch(`${CONTROL}/stages`).then((r) => r.json()).catch(() => null),
    fetch(`${OCR}/__stats`).then((r) => r.json()).catch(() => null),
  ]);

  const report = {
    label: LABEL,
    options: OPTIONS,
    durationSeconds: round(durationMs / 1000),
    users: {
      requested: OPTIONS.users,
      started: counts.usersStarted,
      finished: counts.usersFinished,
      abandoned: counts.usersAbandoned,
    },
    messages: {
      sent: counts.messagesSent,
      successful: counts.ok,
      failed: counts.failed,
      transportErrors: counts.transportErrors,
    },
    throughput: {
      requestsPerSecond: round(counts.requests / (durationMs / 1000)),
      repliesPerSecond: round(counts.replies / (durationMs / 1000)),
    },
    httpStatus: Object.fromEntries([...statuses.entries()].map(([k, v]) => [String(k), v])),
    ackLatencyMs: ack.summary(),
    replyLatencyMs: replyLatency.summary(),
    replyTimeouts: counts.replyTimeouts,
    server: metrics,
    mockAnthropic: mock,
    database: db,
    stages,
    mockVeris: ocrMock,
    documentsSent: counts.documentsSent,
    registrationsCompleted: counts.registrationsCompleted,
  };

  print(report);

  const outDir = path.join(LOADTEST_DIR, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `run-${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nraw results: ${path.relative(process.cwd(), file)}\n`);
}

const round = (n: number) => Math.round(n * 100) / 100;

function print(r: Record<string, any>): void {
  const s = r.server;
  const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(34)} ${v}`);

  console.log(`\n${'='.repeat(74)}\n  RESULT — ${r.label} users\n${'='.repeat(74)}\n`);

  console.log('CONCURRENT USERS vs THROUGHPUT');
  line('concurrent users (simulated)', `${r.users.started} started, ${r.users.finished} finished`);
  line('inbound messages sent', r.messages.sent);
  line('requests/sec (HTTP to /webhook)', r.throughput.requestsPerSecond);
  line('bot replies observed', s?.graph?.sends ?? 'unavailable');
  line('replies/sec (mean)', r.throughput.repliesPerSecond);
  line('anthropic requests', s?.model?.calls ?? 'unavailable');
  line('test duration (s)', r.durationSeconds);

  console.log('\nLATENCY — ACK (webhook returns 200; enqueues only)');
  const a = r.ackLatencyMs;
  line('avg / p50 / p95 / p99 / max', `${a.avg} / ${a.p50} / ${a.p95} / ${a.p99} / ${a.max} ms`);

  console.log('\nLATENCY — REPLY (what a candidate actually waits)');
  const rl = r.replyLatencyMs;
  line('avg / p50 / p95 / p99 / max', `${rl.avg} / ${rl.p50} / ${rl.p95} / ${rl.p99} / ${rl.max} ms`);
  line('reply timeouts', r.replyTimeouts);
  line('users that gave up', r.users.abandoned);

  console.log('\nERRORS');
  line('http status codes', JSON.stringify(r.httpStatus));
  line('failed messages', r.messages.failed);
  line('transport errors', r.messages.transportErrors);
  line('mongo errors', s?.mongoErrors ?? 'unavailable');
  line('blocked outbound (must be 0)', s?.graph?.blocked ?? 'unavailable');

  console.log('\nQUEUE');
  if (s?.queue) {
    line('configured concurrency', JSON.stringify(s.config));
    for (const name of Object.keys(s.queue.submitted ?? {})) {
      line(
        `${name}: submitted/started/done/fail`,
        `${s.queue.submitted[name] ?? 0} / ${s.queue.started[name] ?? 0} / ` +
          `${s.queue.completed[name] ?? 0} / ${s.queue.failed[name] ?? 0}`,
      );
      const w = s.queue.waitMs?.[name];
      if (w) line(`${name}: wait avg/p95/max ms`, `${w.avg} / ${w.p95} / ${w.max}`);
      const d = s.queue.depth?.[name];
      if (d) line(`${name}: depth avg/max`, `${d.avg} / ${d.max}`);
    }
  } else line('queue', 'unavailable');

  console.log('\nREPLY RATE LIMITER (configured 20/sec)');
  if (s?.replyRate) {
    line('peak replies in one second', s.replyRate.max);
    line('max sustained (3s floor)', s.replyRate.sustainedMax);
    line('per-second series', JSON.stringify(s.replyRate.perSecond.slice(0, 40)));
  } else line('reply rate', 'unavailable');

  console.log('\nANTHROPIC');
  if (s?.model) {
    line('calls / transient / shed / failed', `${s.model.calls} / ${s.model.transient} / ${s.model.shed} / ${s.model.failed}`);
    line('gate concurrency / queued', `${s.model.concurrency} / ${s.model.waiting}`);
  }
  if (r.mockAnthropic) {
    line('mock: total / completed / errors', `${r.mockAnthropic.total} / ${r.mockAnthropic.completed} / ${r.mockAnthropic.errors}`);
    line('mock: max concurrent', r.mockAnthropic.maxConcurrent);
    line('mock: 429 sent', r.mockAnthropic.sent429);
    line('mock: latency p50/p95/max', `${r.mockAnthropic.latency?.p50} / ${r.mockAnthropic.latency?.p95} / ${r.mockAnthropic.latency?.max} ms`);
  }

  console.log('\nEVENT LOOP');
  if (s?.eventLoopLagMs) {
    const l = s.eventLoopLagMs;
    line('lag avg / p95 / p99 / max ms', `${l.avg} / ${l.p95} / ${l.p99} / ${l.max}`);
  } else line('event loop lag', 'unavailable');

  console.log('\nPROCESS');
  if (s?.memory) {
    line('rss avg / max MB', `${s.memory.rss.avg} / ${s.memory.rss.max}`);
    line('heap used avg / max MB', `${s.memory.heapUsed.avg} / ${s.memory.heapUsed.max}`);
    line('rss final MB', s.memory.currentRssMb);
  }
  if (s?.cpuPercentOfOneCore) {
    line('cpu avg / p95 / max (% of 1 core)', `${s.cpuPercentOfOneCore.avg} / ${s.cpuPercentOfOneCore.p95} / ${s.cpuPercentOfOneCore.max}`);
    line('cpu ceiling on this box', `${(s.cores ?? 4) * 100}% (${s.cores ?? 4} cores)`);
  }

  console.log('\nDATABASE');
  if (s?.modelGate) {
    line('model gate: peak concurrent', `${s.modelGate.peakInFlight} of ${s.config.modelConcurrency}`);
    line('model gate: peak queue depth', `${s.modelGate.peakWaiting} of ${s.config.modelQueued}`);
    line('model gate: seconds at capacity', s.modelGate.secondsAtCapacity);
  }

  if (r.database) {
    line('candidates created', r.database.candidates);
    line('registrations completed', r.database.registered);
  }
  if (s?.mongoLatency) {
    for (const [k, v] of Object.entries(s.mongoLatency as Record<string, any>)) {
      line(`mongo ${k}: ops / avg ms`, `${v.ops} / ${v.avgMs}`);
    }
  } else line('mongo latency', 'unavailable');

  console.log('');
  console.log('DOCUMENTS / OCR / MEDIA');
  line('documents sent', r.documentsSent);
  line('registrations completed (observed)', r.registrationsCompleted);
  if (s?.media) {
    line('media lookups / served', `${s.media.lookups} / ${s.media.served}`);
    line('bytes served', `${(s.media.bytesServed / 1048576).toFixed(2)} MB`);
    line('media limit', `${(s.media.limitBytes / 1048576).toFixed(0)} MB`);
    line('downloads under the limit', s.media.underLimit);
    line('oversize offered', s.media.oversizeOffered);
  }
  if (s?.queue?.submitted?.ocr !== undefined) {
    line('ocr jobs submitted/done/fail', `${s.queue.submitted.ocr ?? 0} / ${s.queue.completed.ocr ?? 0} / ${s.queue.failed.ocr ?? 0}`);
    const ow = s.queue.waitMs?.ocr;
    if (ow) line('ocr queue wait avg/p95/max ms', `${ow.avg} / ${ow.p95} / ${ow.max}`);
    const od = s.queue.depth?.ocr;
    if (od) line('ocr queue depth avg/max', `${od.avg} / ${od.max}`);
  }
  if (s?.ocr) line('ocr outcomes', JSON.stringify(s.ocr));
  if (r.mockVeris) {
    line('mock veris total/done/errors', `${r.mockVeris.total} / ${r.mockVeris.completed} / ${r.mockVeris.errors}`);
    line('mock veris max concurrent', r.mockVeris.maxConcurrent);
    line('mock veris latency p50/p95', `${r.mockVeris.latency?.p50} / ${r.mockVeris.latency?.p95} ms`);
  }

  if (r.stages) {
    console.log('');
    console.log('FLOW PROGRESS');
    for (const [k, v] of Object.entries(r.stages.byStage as Record<string, number>)) line(`stage ${k}`, v);
    console.log('  open question:');
    for (const [k, v] of Object.entries(r.stages.byStep as Record<string, number>)) {
      console.log(`    ${String(k).padEnd(30)} ${v}`);
    }
  }
  console.log('');
}

await main();
