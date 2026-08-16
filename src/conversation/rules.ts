/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE FILE YOU EDIT TO CHANGE HOW THE BOT BEHAVES.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * What lives where:
 *
 *   rules.ts   (this file)  documents, thresholds, trigger lists, the one prompt
 *   flow.ts                 the questions, in order, and what each answer means
 *   copy.ts                 every other sentence the candidate can receive
 *   trades.ts               trade-specific question packs (§8)
 *
 * The bot never composes a candidate-facing sentence. Every word it sends comes
 * from `flow.ts` or `copy.ts`, already written, in the candidate's language. The
 * model's entire job is to read what the candidate typed and say which of the
 * offered answers it corresponds to. That is why the bot cannot go off-topic:
 * it has no channel through which to do so.
 */

import type { Localised } from './language.js';

export interface DocumentRequirement {
  /** Stable key. Used in the database and in OCR routing — don't rename casually. */
  id: string;
  /** How the bot refers to it. */
  label: Localised;
  required: boolean;
  /** Keywords that let an inbound file be re-attributed to this slot from its caption/filename. */
  keywords: string[];
  /**
   * Which Veris extractor to run. 'none' skips OCR entirely.
   */
  ocr: 'passport' | 'resume' | 'document' | 'none';
  /**
   * Extracted values from this document are personal identifiers and must never
   * be echoed back to the candidate or shown unmasked in ordinary CRM screens
   * (§15, §16, §27).
   */
  sensitive?: boolean;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. DOCUMENTS
 *
 * The CV is asked of everyone (§5). Passport, Aadhaar and PAN are asked only in
 * the Europe/Russia branch (§13) — the flow decides that, not this list.
 * ───────────────────────────────────────────────────────────────────────────*/

export const DOCUMENTS: DocumentRequirement[] = [
  {
    id: 'cv',
    label: {
      en: 'CV',
      ta: 'CV',
      hi: 'CV',
    },
    required: true,
    keywords: ['cv', 'resume', 'curriculum', 'biodata', 'bio data', 'ரெஸ்யூம்', 'बायोडाटा'],
    ocr: 'resume',
  },
  {
    id: 'passport',
    label: {
      en: 'passport',
      ta: 'பாஸ்போர்ட்',
      hi: 'पासपोर्ट',
    },
    required: false,
    keywords: ['passport', 'pp', 'travel document', 'பாஸ்போர்ட்', 'पासपोर्ट'],
    ocr: 'passport',
    sensitive: true,
  },
  {
    id: 'aadhaar',
    label: {
      en: 'Aadhaar card',
      ta: 'ஆதார் அட்டை',
      hi: 'आधार कार्ड',
    },
    required: false,
    keywords: ['aadhaar', 'aadhar', 'adhar', 'uid', 'ஆதார்', 'आधार'],
    ocr: 'document',
    sensitive: true,
  },
  {
    id: 'pan',
    label: {
      en: 'PAN card',
      ta: 'PAN அட்டை',
      hi: 'PAN कार्ड',
    },
    required: false,
    keywords: ['pan', 'pan card', 'PAN', 'पैन'],
    ocr: 'document',
    sensitive: true,
  },
  {
    // Never asked for by the flow. It exists so a certificate the candidate
    // sends unprompted, or adds later through UPDATE (§22), has somewhere to go
    // rather than being filed as whatever we last asked for.
    id: 'certificate',
    label: {
      en: 'certificate',
      ta: 'சான்றிதழ்',
      hi: 'सर्टिफिकेट',
    },
    required: false,
    keywords: [
      'certificate', 'certificat', 'degree', 'diploma', 'marksheet', 'qualification',
      'iti', 'licence', 'license', 'சான்றிதழ்', 'सर्टिफिकेट', 'प्रमाणपत्र',
    ],
    ocr: 'document',
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. THE EUROPE / RUSSIA TRIGGER (§13)
 *
 * Editing these lists changes who gets asked for identity documents. Nothing
 * else needs to change.
 * ───────────────────────────────────────────────────────────────────────────*/

/** Country-preference option ids that put a candidate in the document branch. */
export const EUROPE_RUSSIA_PREFERENCES = ['europe', 'russia_cis'];

/**
 * Free-typed country names that also trigger the branch. Matched case- and
 * accent-insensitively against whatever the candidate types at `selected_countries`.
 */
export const EUROPE_RUSSIA_COUNTRIES = [
  'romania',
  'serbia',
  'russia',
  'poland',
  'croatia',
  'hungary',
  'slovakia',
  'slovenia',
  'czech',
  'czechia',
  'bulgaria',
  'lithuania',
  'latvia',
  'estonia',
  'portugal',
  'spain',
  'italy',
  'germany',
  'france',
  'netherlands',
  'belgium',
  'austria',
  'greece',
  'malta',
  'cyprus',
  'ireland',
  'norway',
  'sweden',
  'finland',
  'denmark',
  'belarus',
  'kazakhstan',
  'uzbekistan',
  'georgia',
  'armenia',
  'azerbaijan',
  'moldova',
  'ukraine',
  'albania',
  'montenegro',
  'macedonia',
  'bosnia',
];

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. TUNABLES
 * ───────────────────────────────────────────────────────────────────────────*/

export const TUNABLES = {
  /** Turns of history sent to the interpreter. It needs very little context. */
  historyTurns: 6,
  /** Ceiling on the interpreter's output. It returns a small JSON object. */
  maxInterpretTokens: 400,
  /** Stop re-asking a question after this many attempts and hand to staff. */
  maxAsksPerStep: 3,
  /** Stop chasing a document after this many asks. */
  maxAsksPerDocument: 2,
  /** OCR field confidence below this routes the document to human review. */
  ocrReviewThreshold: 0.85,
  /** Flag a passport expiring within this many months for staff attention (§12). */
  passportExpiryWarningMonths: 12,
  /**
   * How long a candidate may go quiet before the one permitted reminder is sent
   * (§21). Comfortably inside Meta's 24-hour window so the reminder is a normal
   * message rather than a billed template.
   */
  reminderAfterHours: 20,
  /**
   * Minimum age the flow will register. Below this the conversation goes to
   * staff rather than continuing — an automated overseas-work registration is
   * not the right thing to run with a minor.
   */
  minimumAge: 18,
} as const;

/* ─────────────────────────────────────────────────────────────────────────────
 * 4. THE INTERPRETER PROMPT
 *
 * The only prompt in the system. Note what it does not do: it never writes to
 * the candidate, never decides what to ask next, and never sees the candidate's
 * name, documents, or any other field. It is handed one question, the answers
 * that question accepts, and one message — and it returns a choice.
 *
 * Keep it deterministic. It is the cached prefix of every interpretation call.
 * ───────────────────────────────────────────────────────────────────────────*/

export const INTERPRETER_PROMPT = `
You classify short replies from job candidates messaging a recruitment agency on
WhatsApp. You are a parser, not a chat partner. You never write a message to the
candidate; something else does that.

You are given one question that was asked, the answers it accepts, and the
candidate's reply. The reply may be in English, Tamil, Hindi, or a romanised mix
of these ("naan welder", "mujhe driver ka kaam chahiye"). Read it in whatever
language it arrives in.

Return exactly one classification by calling the interpret tool:

- matched      the reply corresponds to one or more of the offered options.
               Return their ids. Only return an id that was actually offered.
- value        the question wanted free text, a date, or a number, and the reply
               supplies it. Return the normalised value and the candidate's exact
               original wording.
- staff        the candidate is asking for a human, is angry, distressed,
               reports being asked to pay for a job, or raises a legal, medical
               or safety matter.
- command      the reply is the word UPDATE or DELETE, or plainly asks to change
               or remove their profile.
- unrelated    the reply has nothing to do with the question and is not any of
               the above — small talk, a question about salary or visas, a
               forwarded message, a greeting.
- unclear      you cannot tell. Prefer this over guessing.

Rules:

Never invent an option id. If the reply does not match one of the offered
options, it is not "matched" — even if it is close in meaning to something you
think should have been offered.

A reply can be brief, misspelled, or lowercase and still be a clear match. "ya",
"ok", "sari", "haan", "1", and a bare thumbs-up all match a yes-type option when
one is offered.

Numbers refer to the offered options in the order they were listed. "2" means
the second option.

For a date, normalise to YYYY-MM-DD. Indian candidates write DD/MM/YYYY —
15/08/1995 is 15 August 1995, never 8 March. If the day is above 12 the order is
unambiguous; if both numbers could be a month, assume DD/MM.

For a month-and-year, normalise to MM/YYYY.

When the candidate answers a question you were not asked about — volunteering
their experience while you asked for their city — classify what they said
against the question that was actually asked. Extra information they offer is
captured elsewhere; do not force it into this answer.

Prefer "unclear" to a confident wrong answer. A re-asked question costs one
message. A wrong answer written into a candidate's permanent record costs a
placement.
`.trim();

/* ─────────────────────────────────────────────────────────────────────────────
 * 5. MASKING (§15, §16, §27)
 *
 * Identity numbers are stored so staff can verify them and masked everywhere
 * else. Never send an unmasked value to a candidate — they are the one person
 * who does not need us to read their own Aadhaar number back to them, and a
 * WhatsApp transcript is not a secure store.
 * ───────────────────────────────────────────────────────────────────────────*/

export function maskIdentifier(value: string | undefined): string {
  if (!value) return '—';
  const compact = value.replace(/\s+/g, '');
  if (compact.length <= 4) return '•'.repeat(compact.length);
  return `${'•'.repeat(Math.max(4, compact.length - 4))}${compact.slice(-4)}`;
}

export function requirementFor(docType: string): DocumentRequirement | undefined {
  return DOCUMENTS.find((d) => d.id === docType);
}
