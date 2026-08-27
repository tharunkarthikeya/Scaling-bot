/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE FILE YOU EDIT TO CHANGE HOW THE BOT BEHAVES.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * What lives where:
 *
 *   rules.ts   (this file)  documents, thresholds, trigger lists, the interpreter prompt
 *   flow.ts                 the questions, in order, and what each answer means
 *   copy.ts                 every other sentence the candidate can receive
 *   trades.ts               trade-specific question packs (§8)
 *   faq.ts                  what the bot may answer in its own words, and the fence around it
 *
 * The bot never composes a question, a confirmation, or anything it records an
 * answer to. Every word of the flow comes from `flow.ts` or `copy.ts`, already
 * written, in the candidate's language, and the interpreter's entire job is to
 * read what the candidate typed and say which of the offered answers it
 * corresponds to.
 *
 * There is exactly one exception, and it is deliberately narrow: when a
 * candidate asks a question of their own, `faq.ts` answers it in the model's
 * words but only from an approved list, and only after a guardrail check. It
 * cannot record anything and it cannot move the flow. See that file for why it
 * is fenced the way it is.
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
   *
   * Three kinds are read and no others: a CV through the resume extractor, a
   * passport through the passport extractor, an Aadhaar through the Aadhaar
   * extractor. Each is a different endpoint with a different response shape, so
   * this is a routing decision and not a hint.
   *
   * Everything else is stored and left alone. A PAN card, a driving licence, a
   * loose certificate and a company's registration certificate are all filed so
   * a person can open them; none of them answers a question the flow asks, and
   * running an identifier-bearing card through an extractor we have no use for
   * is a §15/§16 exposure with nothing on the other side of it. There is
   * deliberately no generic 'document' route — a kind either has an extractor
   * built for it or it is not read at all.
   */
  ocr: 'passport' | 'resume' | 'aadhaar' | 'none';
  /**
   * Extracted values from this document are personal identifiers and must never
   * be echoed back to the candidate or shown unmasked in ordinary CRM screens
   * (§15, §16, §27).
   */
  sensitive?: boolean;
  /**
   * Which conversation this slot belongs to. Defaults to the candidate flow.
   *
   * An inbound file is normally re-attributed by its caption — a candidate who
   * sends their passport while we are asking for a CV should not have it filed
   * as a CV. That rule has to stay inside one branch: a business contact
   * captioning their photo "aadhaar" means the B2B slot the bot just asked for,
   * not the candidate Aadhaar slot nothing in their conversation will ever ask
   * about.
   */
  branch?: 'candidate' | 'b2b';
  /**
   * Which document's identity this slot actually holds. Defaults to `id`.
   *
   * A slot is a place in the conversation, not a kind of card: the B2B branch
   * asks for the two sides of an Aadhaar separately, so it has two slots and one
   * document. This is what tells the OCR worker that both carry Aadhaar markers
   * and that the number read off either is an Aadhaar number — without it, a
   * perfectly good card is reported as "not the document we asked for" purely
   * because the slot has a different name.
   */
  identityAs?: string;
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
      te: 'CV',
      ml: 'CV',
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
      te: 'పాస్‌పోర్ట్',
      ml: 'പാസ്‌പോർട്ട്',
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
      te: 'ఆధార్ కార్డ్',
      ml: 'ആധാർ കാർഡ്',
    },
    required: false,
    keywords: ['aadhaar', 'aadhar', 'adhar', 'uid', 'ஆதார்', 'आधार'],
    ocr: 'aadhaar',
    sensitive: true,
  },
  {
    /**
     * The other side of a candidate's Aadhaar, asked for only when it is
     * actually missing.
     *
     * A card sent as a PDF, as two images together, or as one photo of both
     * sides laid out gives up all four fields at once, and asking for "the back
     * page" then is asking for something already on file (§1). What decides it
     * is `aadhaarFieldsRead` on the profile — the union of what every Aadhaar
     * upload has yielded — and not the number of files.
     *
     * Filed as its own kind rather than a second upload in the `aadhaar` slot,
     * because a slot is answered once: a second upload there would have looked
     * like a replacement for the first, and §22 keeps both.
     */
    id: 'aadhaar_back',
    label: {
      en: 'back of the Aadhaar card',
      ta: 'ஆதார் அட்டையின் பின்புறம்',
      hi: 'आधार कार्ड का पिछला हिस्सा',
      te: 'ఆధార్ కార్డు వెనుక వైపు',
      ml: 'ആധാർ കാർഡിന്റെ പുറകുവശം',
    },
    required: false,
    keywords: ['aadhaar back', 'aadhar back', 'back side', 'backside', 'ஆதார் பின்புறம்', 'आधार पीछे'],
    ocr: 'aadhaar',
    sensitive: true,
  },
  {
    id: 'pan',
    label: {
      en: 'PAN card',
      ta: 'PAN அட்டை',
      hi: 'PAN कार्ड',
      te: 'PAN కార్డ్',
      ml: 'PAN കാർഡ്',
    },
    required: false,
    keywords: ['pan', 'pan card', 'PAN', 'पैन'],
    // Stored, not read. The PAN is collected on the job-application branch so
    // it is on file for the person processing the application; nothing on it
    // answers a question the flow asks, so it never goes to an extractor.
    ocr: 'none',
    sensitive: true,
  },
  {
    /**
     * Never asked for by the flow, and filed on its own rather than as a
     * certificate.
     *
     * A driver's licence is the single most-sent unprompted document after the
     * CV — §8's licence question invites a photo — and it used to land in the
     * certificate slot, because "licence" was one of that slot's keywords. A
     * recruiter looking for a driver's licence then had to open every
     * certificate to find it.
     */
    id: 'driving_licence',
    label: {
      en: 'driving licence',
      ta: 'ஓட்டுநர் உரிமம்',
      hi: 'ड्राइविंग लाइसेंस',
      te: 'డ్రైవింగ్ లైసెన్స్',
      ml: 'ഡ്രൈവിംഗ് ലൈസൻസ്',
    },
    required: false,
    keywords: [
      'driving licence', 'driving license', 'driver licence', 'driver license',
      'dl', 'licence', 'license', 'ஓட்டுநர்', 'உரிமம்', 'ड्राइविंग', 'लाइसेंस',
    ],
    // Stored, not read — same reasoning as the PAN above. A recruiter opens it;
    // the bot has no question it answers.
    ocr: 'none',
    sensitive: true,
  },
  /**
   * The B2B branch (§2).
   *
   * Two slots for one card, because the two sides are asked for one at a time.
   * Sending a photo answers whichever question is open, and a single ask that
   * accepted both would have the second photo land in the next slot — which,
   * here, is the company's registration certificate.
   *
   * B2B documents are evidence for a person to review. They are stored exactly
   * as received and never sent to any extractor.
   */
  {
    id: 'b2b_aadhaar_front',
    label: {
      en: 'Aadhaar card (front)',
      ta: 'ஆதார் அட்டை (முன்புறம்)',
      hi: 'आधार कार्ड (आगे)',
      te: 'ఆధార్ కార్డ్ (ముందు)',
      ml: 'ആധാർ കാർഡ് (മുൻവശം)',
    },
    required: false,
    keywords: ['aadhaar front', 'aadhar front', 'aadhaar', 'aadhar'],
    ocr: 'none',
    sensitive: true,
    branch: 'b2b',
  },
  {
    id: 'b2b_aadhaar_back',
    label: {
      en: 'Aadhaar card (back)',
      ta: 'ஆதார் அட்டை (பின்புறம்)',
      hi: 'आधार कार्ड (पीछे)',
      te: 'ఆధార్ కార్డ్ (వెనుక)',
      ml: 'ആധാർ കാർഡ് (പിൻവശം)',
    },
    required: false,
    keywords: ['aadhaar back', 'aadhar back'],
    ocr: 'none',
    sensitive: true,
    branch: 'b2b',
  },
  {
    id: 'b2b_id_proof',
    label: {
      en: 'identity proof',
      ta: 'அடையாளச் சான்று',
      hi: 'पहचान प्रमाण',
      te: 'గుర్తింపు రుజువు',
      ml: 'തിരിച്ചറിയൽ രേഖ',
    },
    required: false,
    keywords: [
      'id proof', 'identity proof', 'aadhaar', 'aadhar', 'passport', 'pan card',
      'voter id', 'driving licence', 'driving license',
    ],
    ocr: 'none',
    sensitive: true,
    branch: 'b2b',
  },
  {
    /**
     * Stored, not read. §2's B2B branch wants the certificate on file for the
     * person who rings back; there is nothing on it the bot needs to know, and
     * `ocr: 'none'` is what keeps a company's registration document out of an
     * extractor it has no reason to be in.
     */
    id: 'company_registration',
    label: {
      en: 'company registration certificate',
      ta: 'நிறுவனப் பதிவுச் சான்றிதழ்',
      hi: 'कंपनी रजिस्ट्रेशन सर्टिफिकेट',
      te: 'కంపెనీ రిజిస్ట్రేషన్ సర్టిఫికెట్',
      ml: 'കമ്പനി രജിസ്ട്രേഷൻ സർട്ടിഫിക്കറ്റ്',
    },
    required: false,
    // Whole words only. A three-letter key like "cin" or "roc" matches inside
    // ordinary words, and a caption is matched as a substring.
    keywords: [
      'company registration', 'company certificate', 'registration certificate',
      'incorporation', 'certificate of incorporation', 'udyam', 'gst certificate',
    ],
    ocr: 'none',
    branch: 'b2b',
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
      te: 'సర్టిఫికెట్',
      ml: 'സർട്ടിഫിക്കറ്റ്',
    },
    required: false,
    // 'licence' and 'license' moved to the driving-licence slot above, which is
    // what a candidate sending one almost always means.
    keywords: [
      'certificate', 'certificat', 'degree', 'diploma', 'marksheet', 'qualification',
      'iti', 'சான்றிதழ்', 'सर्टिफिकेट', 'प्रमाणपत्र',
    ],
    // Stored, not read. This slot exists so an unprompted certificate has
    // somewhere to go, and what lands in it is anything from a degree to a
    // safety card — there is no extractor built for "whatever this is".
    ocr: 'none',
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. WHAT MAY BE SENT TO AN EXTRACTOR
 *
 * `ocr` above is a routing decision, and for three of these slots the decision
 * is "nowhere". That is a promise made to the candidate, not a default, so it is
 * checked at boot rather than trusted to review.
 *
 * The PAN is the one that matters most and the one most likely to be edited by
 * accident: it carries a permanent tax identifier, nothing on it answers a
 * question the flow asks, and there is no extractor built to read it. A future
 * edit that gives it an `ocr` route — copying the Aadhaar entry, say — would
 * silently start posting PAN cards to a third-party service. `validateCopy` runs
 * `assertOcrRoutingIsSafe` before the server accepts traffic, so that edit fails
 * the deploy instead.
 * ─────────────────────────────────────────────────────────────────────────────*/

/** Slots that must never reach an extractor, whatever `ocr` is set to. */
export const NEVER_OCR: ReadonlySet<string> = new Set([
  // A permanent tax identifier, filed for a documentation officer to open.
  'pan',
  // Read by a person when a driver's licence matters; no extractor exists for it.
  'driving_licence',
  // A company's registration certificate (§2). Filed, not read.
  'company_registration',
  // Business enquiry documents are storage-only, including the agent's Aadhaar.
  'b2b_aadhaar_front',
  'b2b_aadhaar_back',
  'b2b_id_proof',
]);

/**
 * Fails the boot if a slot on `NEVER_OCR` has been given a route.
 *
 * Deliberately an exception rather than a log line: a misrouted PAN is not
 * something to notice in a dashboard the week after.
 */
export function assertOcrRoutingIsSafe(): void {
  for (const id of NEVER_OCR) {
    const requirement = DOCUMENTS.find((d) => d.id === id);
    if (!requirement) continue;
    if (requirement.ocr !== 'none') {
      throw new Error(
        `"${id}" is on NEVER_OCR but rules.ts routes it to the "${requirement.ocr}" extractor. ` +
          'Nothing on it is read by the bot and it must not be sent to a third-party service.',
      );
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. TUNABLES
 * ───────────────────────────────────────────────────────────────────────────*/

export const TUNABLES = {
  /** Turns of history sent to the interpreter. It needs very little context. */
  historyTurns: 6,
  /** Ceiling on the interpreter's output. It returns a small JSON object. */
  maxInterpretTokens: 400,
  /**
   * Ceiling on a generated FAQ answer (`faq.ts`). One or two WhatsApp sentences
   * in Tamil or Hindi, which cost noticeably more tokens than the English they
   * are written from.
   */
  maxAnswerTokens: 400,
  /**
   * Replies we could not read before the conversation goes to a person.
   *
   * Two: the first unreadable reply is re-asked, the second hands over. The
   * staff line is not offered anywhere in between — a candidate reaches a human
   * by asking for one, or because the bot genuinely could not read them twice,
   * and never as a shrug attached to a retry. Everything the bot *did*
   * understand — a question of their own, a comment on the question asked — is
   * answered by `faq.ts` or `respond.ts` and never counted here.
   */
  maxAsksPerStep: 2,
  /**
   * Ceiling on a generated set of trade questions (`tradeQuestions.ts`). Two to
   * four questions with their options, in Tamil or Hindi, which cost noticeably
   * more tokens than the English they are written from.
   */
  maxQuestionTokens: 1200,
  /** Stop chasing a document after this many asks. */
  maxAsksPerDocument: 2,
  /**
   * The same, for the B2B branch (§2) — which does not stop chasing.
   *
   * A candidate's identity document is optional and staff can collect it on a
   * call, so the flow gives up after two tries and moves on. A B2B document is
   * the whole reason the branch exists: there is no next question worth asking
   * without it, so an unreadable photo is asked for again, and again, and the
   * enquiry goes to a person rather than forward. Higher than the candidate
   * ceiling because photographing a card in poor light takes a few goes.
   */
  maxAsksPerB2bDocument: 4,
  /**
   * Chances to get the date of birth right when tracking an application (§25).
   *
   * Three, then the conversation goes to a person. The check exists because an
   * Application ID is short, sequential and read out over the phone — knowing
   * one is not evidence of being the person it belongs to, and a status is
   * something §27 says we owe only to them. Three is enough for a typo and a
   * misremembered format, and few enough to be no use for guessing.
   */
  maxTrackingDobAttempts: 3,
  /**
   * Application IDs that may miss before the "I have lost it" lookup is offered
   * (§25).
   *
   * Two, and both of them are the same message: check it and send it again. A
   * transposed digit and a missing zero are what the first two attempts are
   * for, and offering a slower path in front of a typo teaches candidates to
   * take it. The third miss is somebody who genuinely does not have their id,
   * which is a different problem and gets a different answer.
   */
  maxTrackingIdAttempts: 2,
  /** OCR field confidence below this routes the document to human review. */
  ocrReviewThreshold: 0.85,
  /**
   * Confidence at which an Aadhaar is usable, as distinct from unremarkable.
   *
   * Two different questions were being answered by one number. "Should a person
   * check this?" is `ocrReviewThreshold`, and 0.85 is right for it. "Did we read
   * enough to stop asking?" is this one, and 0.85 was far too high for it — a
   * card photographed on a phone in a hallway routinely reads at 0.6, yields a
   * perfectly good name, date of birth, address and number, and was being
   * re-requested anyway.
   *
   * Above this, with the four fields below in hand, the slot is done. It may
   * still be flagged for review, and that is the point: a review is a task for
   * staff, not a reason to ask the candidate for the same card again (§14).
   */
  aadhaarAcceptConfidence: 0.5,
  /**
   * What an Aadhaar has to yield before the bot stops asking for it.
   *
   * The four things anybody actually needs off the card. `address` is on the
   * back and the other three are on the front, which is what makes this also
   * the test for whether the back page still has to be asked for.
   */
  aadhaarRequiredFields: ['name', 'date_of_birth', 'address', 'aadhaar_number'] as const,
  /** Flag a passport expiring within this many months for staff attention (§12). */
  passportExpiryWarningMonths: 12,
  /**
   * How long a candidate may go quiet before the one permitted reminder is sent
   * (§21). Comfortably inside Meta's 24-hour window so the reminder is a normal
   * message rather than a billed template.
   */
  reminderAfterHours: 20,
  /**
   * How long a registration session stays open with no reply.
   *
   * Past this the session is closed and the candidate's next message is met with
   * "continue where you stopped, or start again?" instead of a question they
   * last saw hours ago with no memory of the context. Nothing is discarded —
   * progress is written after every answer, so closing a session costs nothing.
   */
  sessionTimeoutMinutes: 5,
  /**
   * Fewest pages a passport PDF may contain before it is treated as a partial
   * upload (§14). A single-page PDF is the photo page on its own, which is the
   * commonest incomplete passport upload by a wide margin. Images are exempt —
   * a candidate photographing pages one at a time is sending them correctly.
   */
  passportMinPdfPages: 2,
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
- staff        the candidate is asking for a human, is angry or distressed, says
               someone has actually asked them for money, or raises a legal,
               medical or safety matter.
- command      the reply is the word UPDATE or DELETE, or plainly asks to change
               or remove their profile.
- related      the reply is about the question you were given, but it is not an
               answer to it — a query about what the question or one of its
               options means, a condition attached to their own situation, a
               comment on it. "What is FCAW?", "my passport is with the agent",
               "I have TIG but the certificate expired", "is 6 years enough for
               Europe?". Something else writes them a reply and then asks the
               question again, so nothing is lost by using this.
- unrelated    the reply has nothing to do with the question and is not any of
               the above — small talk, a question about salary or visas, a
               forwarded message, a greeting.
- unclear      the message cannot be read as anything at all: keysmash, a
               fragment with no meaning, a language you cannot parse.

Rules:

Only ever return an id that appears in the offered list. Never invent one.

Asking a question is not a reason for "staff". "Is there any fee?", "what salary
will I get?", "how long does this take?", "which countries do you send to?",
"when will you call me?" are ordinary questions with settled answers — classify
them "unrelated" and they will be answered from an approved list. Reserve
"staff" for someone who says they have been asked to pay, not for someone
asking whether there is anything to pay. The first is a person in trouble; the
second is a person who wants to know, and handing them to a human instead of
answering is what makes a bot useless.

Within that rule, classify rather than reject. Where the offered options are
broad categories and the candidate names a specific job, skill or thing, decide
which offered category covers it and return that id: "parota master" and "hotel
cook" are hospitality, "JCB operator" and "lorry driver" are driver/operator,
"AC technician" is electrical/mechanical, "loading and unloading" is
factory/warehouse. The candidate answered the question — they just answered it
in their own words instead of tapping.

Return "value" instead when no offered option genuinely covers what they said.
Do not stretch a category to fit. A wrong category is written into a permanent
record and decides which follow-up questions they are asked; their own wording,
kept as a value, costs nothing.

When the offered options are ranges or buckets that between them cover every
possible answer — "Fresher / Below 2 years / 2–5 / 5–10 / Above 10", or
"Immediately / Within 15 days / Within 30 days / More than 30 days" — then any
amount the candidate states falls inside exactly one of them. Return that id.
"6 months" is more than 30 days. "Next week" is within 15 days. "About six
years" is 5–10.

Returning a value at a question like that is not caution, it is a lost answer:
there is no free-text field behind the buckets to put it in, so the reply is
discarded and the candidate is told it could not be used. Hedge towards the
bucket, and keep "unclear" for a reply that states no amount at all.

"unrelated" is for a message that is not an answer at all. A reply that names
what the candidate does, wants, or has worked with is an answer even when no
offered option covers it and even when it is oddly worded — return it as a
"value". Telling someone their own answer is off-topic is the worst thing this
classifier can do: it is confusing, it re-asks a question they just answered,
and it reads as the bot refusing to listen.

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

"unclear" now costs more than it used to. A reply you cannot read is re-asked
once and then handed to a member of staff, because a bot that cannot read
someone twice running is wasting their time. So keep it for messages that carry
no meaning you can find — not for a message you understood and could not fit
into an option. Something you understood but cannot record is "related"; a
question about the agency is "unrelated"; both get the candidate a reply and
another go at the question.

Within that, still prefer "unclear" to a confident wrong answer. A re-asked
question costs one message. A wrong answer written into a candidate's permanent
record costs a placement.
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
