/**
 * The four load stages, and what passing one means.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  These are the stages from SCALABILITY-AUDIT.md §G, extended to 1000 users
 *  now that the architecture can be more than one instance. Each is a *claim*
 *  with thresholds attached, so a run either supports the claim or does not,
 *  rather than producing numbers somebody has to interpret afterwards.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## The load model
 *
 * A candidate replies at human pace: roughly one message every thirty seconds,
 * because they are reading a question, finding a document, and typing. So the
 * offered turn rate is `users / 30`, not `users / think-time-somebody-chose`.
 * That is what makes 500 users ≈ 17 turns a second rather than the 400 a second
 * a zero-think-time hammer would produce, and it is the number the capacity
 * arithmetic in the audit is built on.
 *
 * A registration is around fifteen questions and thirty messages, of which
 * roughly 45% are button taps the interpreter resolves locally without touching
 * the model. `messages` is set to cover a full registration so the run exercises
 * the whole flow rather than the first few steps of it repeatedly.
 *
 * ## Why `documents` is capped rather than switched off
 *
 * Stage 100 is meant to isolate the conversational path, and the audit calls it
 * "text only". A document question cannot be answered with text — the bot asks
 * again, correctly — so a virtual candidate that refuses to upload would stall
 * rather than stay on the text path. With `documents: 0` the candidate stops
 * when the first document is asked for and is counted as having reached it.
 * That is text-only in the sense that matters and it is reported as what it is.
 *
 * ## Thresholds
 *
 * ACK latency is what Meta waits for. Sustained p95 above about a second means
 * redeliveries and duplicate work, so the bar is well under it.
 *
 * Reply latency is what a candidate waits for, and it is the one that degrades
 * first. It is allowed to grow with load, because it legitimately does — a
 * model call is a model call — but not without limit.
 *
 * Queue depth is the clearest pass/fail signal there is. Flat is passing;
 * monotonically rising is failing whatever the averages say. The ceiling here is
 * a *peak* during the run, checked against a system that must return to zero.
 *
 * Event-loop lag catches blocking work. It is the one number where a regression
 * means adding concurrency will make things worse rather than better.
 */

export interface StageThresholds {
  /** Webhook acknowledgement, p95, milliseconds. */
  ackP95Ms: number;
  /** Inbound message to first outbound message, p95, milliseconds. */
  replyP95Ms: number;
  /** Peak jobs waiting in any one queue at any sample during the run. */
  maxQueueDepth: number;
  /** Event-loop delay, p99, milliseconds. */
  eventLoopP99Ms: number;
  /** Candidates who waited out the reply timeout. Always zero. */
  replyTimeouts: number;
  /** Candidates who gave up after consecutive timeouts. Always zero. */
  abandoned: number;
}

export interface Stage {
  name: string;
  users: number;
  /** Messages one virtual candidate will send before finishing. */
  messages: number;
  /** Milliseconds between a reply landing and the next message. Human pace. */
  think: number;
  /** Seconds over which users are started, so the first seconds are load and not a herd. */
  rampup: number;
  /** Hard stop, seconds. */
  duration: number;
  /** Documents one candidate will upload. 0 stops at the first document question; -1 is unlimited. */
  documents: number;
  /** users / (think in seconds), which is the offered rate this stage represents. */
  offeredTurnsPerSecond: number;
  thresholds: StageThresholds;
  /** What this stage is for, printed at the top of the run. */
  purpose: string;
}

const HUMAN_PACE_MS = 30_000;

function stage(
  name: string,
  users: number,
  overrides: Partial<Stage> & { thresholds: StageThresholds; purpose: string },
): Stage {
  const think = overrides.think ?? HUMAN_PACE_MS;
  return {
    name,
    users,
    messages: 30,
    think,
    rampup: Math.max(30, Math.round(users / 10)),
    duration: 1_200,
    documents: -1,
    offeredTurnsPerSecond: Math.round((users / (think / 1000)) * 10) / 10,
    ...overrides,
  };
}

export const STAGES: Record<string, Stage> = {
  '100': stage('100', 100, {
    // Stops before the document steps, so a failure here is a failure of the
    // conversational path and cannot be blamed on OCR.
    documents: 0,
    messages: 12,
    duration: 1_200,
    purpose:
      'Baseline. Text path only, no documents. Establishes that the rig is honest and that ' +
      'the conversational path keeps up before anything slower is added to it.',
    thresholds: {
      ackP95Ms: 300,
      replyP95Ms: 3_000,
      maxQueueDepth: 50,
      eventLoopP99Ms: 50,
      replyTimeouts: 0,
      abandoned: 0,
    },
  }),

  '250': stage('250', 250, {
    duration: 1_800,
    purpose:
      'Documents in flight. Exercises the OCR pool, the media download inside the webhook, and ' +
      'the byte scan in inspectUpload - which is where event-loop lag shows up if it is going to.',
    thresholds: {
      ackP95Ms: 500,
      replyP95Ms: 5_000,
      maxQueueDepth: 150,
      eventLoopP99Ms: 100,
      replyTimeouts: 0,
      abandoned: 0,
    },
  }),

  '500': stage('500', 500, {
    duration: 3_600,
    purpose:
      'The original target. Full mix, run long enough that the reminder and reconcile sweeps ' +
      'both fire during it. This is the stage the outbound 20/sec limiter is expected to be the ' +
      'binding constraint on, at roughly 85% utilised.',
    thresholds: {
      ackP95Ms: 500,
      replyP95Ms: 8_000,
      maxQueueDepth: 400,
      eventLoopP99Ms: 100,
      replyTimeouts: 0,
      abandoned: 0,
    },
  }),

  '1000': stage('1000', 1000, {
    duration: 3_600,
    purpose:
      'Beyond one instance. At 33 turns/sec the offered load exceeds what Meta will accept on ' +
      'ONE number (20 messages/sec), so this stage measures the application, not the account: ' +
      'expect the reply limiter to be saturated and read the queue depth and ACK latency, which ' +
      'are the numbers that say whether the fleet itself is coping. Passing here without ' +
      'additional phone numbers is a statement about this software and not about deliverability.',
    thresholds: {
      ackP95Ms: 750,
      // Deliberately generous: at this rate the reply limiter is the queue, and
      // a candidate waiting on a shared 20/sec budget is waiting by design.
      replyP95Ms: 20_000,
      maxQueueDepth: 1_000,
      eventLoopP99Ms: 150,
      replyTimeouts: 0,
      abandoned: 0,
    },
  }),
};

export const STAGE_NAMES = Object.keys(STAGES);

/** One line per stage, for `--help` and for the refusal when a name is wrong. */
export function describeStages(): string {
  return STAGE_NAMES.map((name) => {
    const s = STAGES[name]!;
    return (
      `  ${name.padEnd(5)} ${String(s.users).padStart(4)} users  ` +
      `${String(s.offeredTurnsPerSecond).padStart(5)} turns/sec  ` +
      `${String(Math.round(s.duration / 60)).padStart(3)} min  ` +
      `${s.documents === 0 ? 'no documents' : 'with documents'}`
    );
  }).join('\n');
}
