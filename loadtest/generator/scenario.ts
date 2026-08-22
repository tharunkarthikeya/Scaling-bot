/**
 * What a simulated candidate does.
 *
 * Adaptive rather than scripted, and for the same reason `harness.ts` is: the
 * flow legitimately differs run to run, so a fixed list of messages would drift
 * out of step with the questions actually being asked and then measure a
 * conversation nobody is having. Each turn reads the reply the bot actually
 * sent, taps one of the options it actually offered, and falls back to typing
 * only when the question has no options.
 *
 * The two kinds of turn cost very different things, which is the point of
 * mixing them:
 *
 *   a tap        resolved locally in `interpret.ts` — no model call at all
 *   free text    falls through to the model — one Anthropic call
 *
 * A tap-only script would make the bot look far faster than it is; a text-only
 * script would make it look far slower. The real flow is mostly taps with a
 * handful of typed answers, and that is what this reproduces.
 *
 * No documents are sent. The first runs must not touch Veris, and the fetch
 * guard would refuse the host in any case.
 */

export interface BotReply {
  seq: number;
  waId: string;
  at: number;
  type: string;
  text: string;
  optionIds: string[];
}

/**
 * Options that end or divert the conversation. Tapping one would take the
 * candidate out of the registration flow and stop measuring what we came to
 * measure.
 */
const AVOID = new Set(['staff', 'delete', 'update', 'track', 'other', 'no']);

/**
 * A multi-select re-asks itself after every pick, echoing the running choice
 * back as "Selected: ...". Something has to end it, and that something is the
 * Done row. Without this the script taps options on the same question until it
 * runs out of message budget and the run never reaches the questions after it —
 * which looks like the flow stalling and is really the generator refusing to
 * finish a sentence.
 */
const DONE_ID = '__done';
const ALREADY_SELECTING = /Selected:/;

/**
 * The end of the scenario.
 *
 * Registration finishing is the goal, and carrying on past it is not more load,
 * it is different load: the bot moves to the returning-candidate menu, and a
 * script that keeps tapping whatever is offered there wanders into "talk to
 * staff" and lands the candidate in HUMAN_HANDOFF. The smoke run did exactly
 * that — both candidates registered successfully, then talked themselves into a
 * handoff, and the stage count read 0 completed when the truth was 2.
 */
const REGISTRATION_COMPLETE = /Registration completed|Application ID: ADR-/i;

/** Where a preferred option exists, take it — this is the registration path. */
const PREFERRED = [
  'apply',
  'yes',
  // Was `no_cv` in Tests A and B, which skipped the CV and with it the resume
  // extractor. Uploading exercises the OCR pool from the first document step
  // and lets §5 fill profile fields the way it does in production.
  'upload_cv',
  'diploma',
  'class_12',
  'fabrication_welding',
  '2_5',
  'factory',
  'below_2',
];

/** Typed answers, in the order the flow tends to ask for them. */
const TYPED = [
  'Asha Kumari',
  'Chennai, Tamil Nadu',
  '15/08/1995',
  'Welder trade',
  'Qatar and Saudi Arabia',
  'Warehouse supervisor',
  'After Diwali, around November',
];

export interface OutboundMessage {
  type: 'text' | 'tap' | 'document';
  text?: string;
  id?: string;
  title?: string;
  /** For a document: which fixture the rig should serve. */
  kind?: string;
  filename?: string;
}

/**
 * Which document a question is asking for.
 *
 * Matched on the English prompt because that is the only signal the reply
 * carries: `passport_upload`, `aadhaar_upload` and `pan_upload` declare their
 * fallbacks as `hiddenChoices`, and `renderStep` renders only `choicesFor`, so
 * a document question arrives with no tappable options at all. Test B typed at
 * them and was correctly refused 150 times.
 *
 * Order matters — the CV prompt is checked last because the others are more
 * specific.
 */
const DOCUMENT_PROMPTS: Array<[RegExp, string]> = [
  [/passport/i, 'passport'],
  [/aadhaar|aadhar/i, 'aadhaar'],
  [/PAN card/i, 'pan'],
  [/your CV/i, 'cv'],
];

function documentWanted(text: string): string | undefined {
  if (!/please send/i.test(text)) return undefined;
  for (const [pattern, kind] of DOCUMENT_PROMPTS) if (pattern.test(text)) return kind;
  return undefined;
}

export class Conversation {
  private typedIndex = 0;
  /** Counted so the report can say how many files a candidate actually sent. */
  documentsSent = 0;
  /** Set when the bot confirmed the registration. The scenario stops there. */
  completed = false;

  constructor(readonly waId: string) {}

  /** The opening message. Every candidate starts by saying something. */
  first(): OutboundMessage {
    return { type: 'text', text: 'hi' };
  }

  /**
   * The answer to whatever the bot just asked.
   *
   * Returns undefined when the reply offers nothing to answer and there is no
   * typed answer left — which means the conversation has run its course rather
   * than that something went wrong.
   */
  next(reply: BotReply | undefined): OutboundMessage | undefined {
    if (REGISTRATION_COMPLETE.test(reply?.text ?? '')) {
      this.completed = true;
      return undefined;
    }

    const offered = reply?.optionIds ?? [];

    // A document question wants a file, and no amount of typing satisfies it.
    const wants = documentWanted(reply?.text ?? '');
    if (wants) {
      this.documentsSent += 1;
      return { type: 'document', kind: wants, filename: `${wants}.pdf` };
    }

    // One pick is enough for a multi-select; take it and close the question.
    if (ALREADY_SELECTING.test(reply?.text ?? '') && offered.includes(DONE_ID)) {
      return { type: 'tap', id: DONE_ID, title: 'Done' };
    }

    const options = offered.filter((id) => !AVOID.has(id) && id !== DONE_ID);

    if (options.length) {
      const preferred = PREFERRED.find((id) => options.includes(id));
      const id = preferred ?? options[0]!;
      return { type: 'tap', id, title: id };
    }

    if (this.typedIndex < TYPED.length) {
      return { type: 'text', text: TYPED[this.typedIndex++]! };
    }

    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Webhook payloads                                                    */
/* ------------------------------------------------------------------ */

export function envelope(message: Record<string, unknown>, waId: string, wabaId: string): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ wa_id: waId, profile: { name: 'Load Test' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

export function messageFor(out: OutboundMessage, waId: string, wamid: string): Record<string, unknown> {
  const base = {
    from: waId,
    id: wamid,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };

  if (out.type === 'document') {
    return {
      ...base,
      type: 'document',
      document: {
        // The kind is the last segment; the rig reads it back to decide which
        // fixture to serve, so nothing has to be registered in advance.
        id: `MEDIA-${waId}-${wamid.split('-').pop()}-${out.kind}`,
        mime_type: 'application/pdf',
        filename: out.filename ?? 'document.pdf',
      },
    };
  }

  if (out.type === 'tap') {
    return {
      ...base,
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: out.id, title: out.title ?? out.id } },
    };
  }

  return { ...base, type: 'text', text: { body: out.text ?? '' } };
}
