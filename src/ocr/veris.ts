import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { storedDocuments, type OcrField } from '../db/models.js';
import { readFile } from '../storage/index.js';
import { withCandidateLock } from '../queue/index.js';
import { TUNABLES } from '../conversation/rules.js';
import { requirementFor } from '../conversation/checklist.js';
import {
  flagIdentityMismatch,
  markSlotFromOcr,
  mergeExtractedProfile,
  resumeAfterDocument,
} from '../conversation/engine.js';
import { extractFromCv, identityFromDocument } from '../conversation/cv.js';
import { compareIdentity } from '../conversation/profile.js';
import type { CandidateProfile } from '../db/models.js';

/**
 * Veris (RecursAI) OCR client — https://veris.recursai.in
 *
 * Three extractors, each with its own route, form field, and response shape:
 *
 *   passport  POST /v1/passport/extract   field "image"  → MRZ + check digits
 *   resume    POST /v1/resume/extract     field "image"  → structured CV fields
 *   document  POST /v1/document/extract   field "file"   → per-page text + key fields
 *
 * OCR is slow (the configured timeout is 120s), so this only ever runs from a
 * queue worker — never inside the webhook request.
 */

export type Extractor = 'passport' | 'resume' | 'document';

const ROUTES: Record<Extractor, { path: string; field: string }> = {
  passport: { path: '/v1/passport/extract', field: 'image' },
  resume: { path: '/v1/resume/extract', field: 'image' },
  document: { path: '/v1/document/extract', field: 'file' },
};

export interface OcrOutcome {
  raw: unknown;
  fields: OcrField[];
  /** Overall score where the extractor reports one; null where it does not. */
  confidence: number | null;
  needsReview: boolean;
  reviewReasons: string[];
  /**
   * Whether the upload is usable as a document (§14). Distinct from extraction
   * confidence: a perfectly sharp photo of one page of a passport scores well
   * and is still an incomplete upload. This is what decides whether the
   * candidate is asked to send it again.
   */
  completeness: {
    complete: boolean;
    /**
     * Why it is unusable, which decides *which* re-ask the candidate gets.
     * Telling someone "send all the pages" when they sent a selfie is useless.
     *
     *   ok             usable
     *   pages          the right document, but pages are missing or unclear
     *   unreadable     probably the right document, too poor a photo to read
     *   empty          nothing came back at all — bad photo, or not a document
     *   wrong_document read cleanly, and it is not the document we asked for
     */
    verdict: CompletenessVerdict;
    problems: string[];
    missingPages?: number[];
    /**
     * On `wrong_document`: the id of the document the upload appears to be,
     * where the markers identified one. Absent means "not this document, and we
     * cannot say what it is" — which the candidate is still owed a sentence
     * about, just a vaguer one.
     */
    looksLike?: string;
  };
}

export type CompletenessVerdict = 'ok' | 'pages' | 'unreadable' | 'empty' | 'wrong_document';

/* ------------------------------------------------------------------ */
/* Normalisation — one branch per response shape                       */
/* ------------------------------------------------------------------ */

function pushField(
  fields: OcrField[],
  key: string,
  value: unknown,
  confidence: number | null,
  extra: { page?: number; category?: string; source?: string } = {},
): void {
  if (value === undefined || value === null || value === '') return;
  fields.push({ key, value: String(value), confidence, ...extra });
}

/**
 * Pulls a list of strings out of whatever shape a payload key arrived in.
 *
 * The resume extractor's published schema pins down the flat fields and little
 * else, so employment history, certifications and machinery are read
 * defensively: an array of strings, an array of objects under any of several
 * plausible keys, or one comma-separated string all give the same answer, and
 * an absent or unrecognised key gives an empty list rather than an error.
 */
function stringsFrom(value: unknown, ...keys: string[]): string[] {
  if (!value) return [];

  if (typeof value === 'string') {
    return value
      .split(/[,;|\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(value)) return [];

  const out: string[] = [];
  for (const row of value) {
    if (typeof row === 'string') {
      if (row.trim()) out.push(row.trim());
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    for (const key of keys) {
      const found = (row as Record<string, unknown>)[key];
      if (typeof found === 'string' && found.trim()) {
        out.push(found.trim());
        break;
      }
    }
  }

  // A CV can repeat an employer across several roles; the profile wants the
  // list of places they worked, not one entry per line on the page.
  return [...new Set(out)];
}

/** ExtractedField is shared by the passport and document responses. */
function fromExtractedFields(raw: any): OcrField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f?.value !== undefined && f?.value !== null && f?.value !== '')
    .map((f) => ({
      key: String(f.label ?? 'unknown'),
      value: String(f.value),
      confidence: typeof f.confidence === 'number' ? f.confidence : null,
      page: typeof f.page === 'number' ? f.page : undefined,
      category: f.category ? String(f.category) : undefined,
      source: f.source ? String(f.source) : undefined,
    }));
}

/* ------------------------------------------------------------------ */
/* Is this the document we asked for?                                  */
/* ------------------------------------------------------------------ */

/**
 * Markers that identify a document type from whatever text was read.
 *
 * Deliberately generous: a real Aadhaar photographed badly may yield only the
 * number, or only the word "Government of India". Any one hit is enough. The
 * cost of a false "that isn't an Aadhaar" is a confused candidate, so the bar
 * for declaring a mismatch is high and this is only consulted when the read was
 * confident enough to be trusted (see `identifyDocument`).
 */
const DOCUMENT_MARKERS: Record<string, RegExp[]> = {
  passport: [
    /\bP<[A-Z]{3}[A-Z<]+/, // the MRZ first line, which nothing else carries
    /republic\s+of\s+india.{0,40}passport|passport\s+no\.?\s*[:#]?\s*[A-Z]\d{7}/i,
    /\b(?:place|date)\s+of\s+issue\b.{0,60}\bdate\s+of\s+expiry\b/i,
  ],
  aadhaar: [
    /\b\d{4}\s?\d{4}\s?\d{4}\b/, // the 12-digit UID, spaced or not
    /aadhaar|aadhar|adhaar|uidai|unique\s+identification/i,
    /आधार|ஆதார்/,
  ],
  pan: [
    /\b[A-Z]{5}\s?\d{4}\s?[A-Z]\b/, // ABCDE1234F
    /permanent\s+account\s+number|income\s+tax\s+department/i,
    /आयकर|स्थायी\s+लेखा/,
  ],
};

/** Every readable string the extractor gave us, as one haystack. */
function textOf(fields: OcrField[]): string {
  return fields.map((f) => `${f.key} ${f.value}`).join('\n');
}

/**
 * Decides whether an upload is the document type the slot asked for.
 *
 * Returns `null` when there is no opinion — either we have no markers for this
 * type, or too little text came back to judge. A null is not a pass; the caller
 * still treats an empty read as unusable. It only means "don't accuse them of
 * sending the wrong thing".
 */
function identifyDocument(
  docType: string | undefined,
  fields: OcrField[],
  overall: number | null,
): boolean | null {
  if (!docType) return null;
  const markers = DOCUMENT_MARKERS[docType];
  if (!markers) return null;

  const haystack = textOf(fields);
  // A confident mismatch is the only mismatch worth reporting. If the read was
  // poor, the honest verdict is "I couldn't read it", not "wrong document" —
  // blur destroys exactly the markers we are looking for.
  if (haystack.trim().length < MIN_TEXT_TO_JUDGE) return null;
  if (overall !== null && overall < TUNABLES.ocrReviewThreshold) return null;

  return markers.some((m) => m.test(haystack));
}

/** Below this much text, any verdict about document type is guesswork. */
const MIN_TEXT_TO_JUDGE = 40;

/* ------------------------------------------------------------------ */
/* What the file itself says, before it is sent anywhere               */
/* ------------------------------------------------------------------ */

export interface UploadInspection {
  /** False when the file is not a document that will open at all. */
  readable: boolean;
  /** Page count, when it can be established. Undefined means "could not tell". */
  pages?: number;
  /** Plain-language problem, when `readable` is false. */
  problem?: string;
}

const PDF_MAGIC = '%PDF-';

/**
 * Reads what the upload can be asked without an extractor: does it open, and
 * how many pages does it have.
 *
 * Worth doing before OCR rather than after. A truncated PDF costs a 120-second
 * extraction timeout to discover otherwise, and the candidate waits all of it
 * to be told something that was knowable the moment the bytes landed.
 *
 * Page counting is best-effort by design. PDF 1.5 and later can hide page
 * objects inside compressed object streams, where this finds none — and finding
 * none is reported as `undefined`, never as zero. A wrong "you only sent one
 * page" told to someone who sent twelve is worse than not checking.
 */
export function inspectUpload(buffer: Buffer, mimeType: string): UploadInspection {
  if (!buffer.byteLength) return { readable: false, problem: 'the file was empty' };

  const head = buffer.subarray(0, 5).toString('latin1');
  const claimsPdf = mimeType.toLowerCase().includes('pdf');

  if (!claimsPdf && head !== PDF_MAGIC) {
    // An image. Nothing to open and nothing to count — the extractor's own
    // verdict is the only thing that can speak to it.
    return { readable: true };
  }

  if (head !== PDF_MAGIC) {
    return { readable: false, problem: 'the file does not open as a PDF' };
  }

  // Every PDF ends with %%EOF. Its absence means the upload was cut short,
  // which is what a file sent on a weak mobile signal looks like.
  const tail = buffer.subarray(Math.max(0, buffer.byteLength - 4096)).toString('latin1');
  if (!tail.includes('%%EOF')) {
    return { readable: false, problem: 'the PDF is incomplete and will not open' };
  }

  const pageObjects = (buffer.toString('latin1').match(/\/Type\s*\/Page[^sA-Za-z]/g) ?? []).length;

  return { readable: true, ...(pageObjects > 0 ? { pages: pageObjects } : {}) };
}

/**
 * Pages §14 wants a documentation officer to have laid eyes on.
 *
 * Recorded as review notes, never as problems. The passport extractor reads the
 * photo page; a marker not appearing means the extractor did not report it,
 * which is not the same as the page not having been sent. Re-asking on that
 * basis would have the bot chasing candidates who sent a complete booklet.
 */
const PASSPORT_PAGE_MARKERS: Array<[string, RegExp]> = [
  ['observation page', /\bobservation/i],
  ['ECR/ECNR endorsement', /\bec[rn]r\b|emigration\s+check/i],
  ['visa page', /\bvisas?\b/i],
  ['entry/exit stamp', /\b(immigration|arrival|departure)\b/i],
  ['previous passport reference', /(previous|old)\s+passport/i],
];

function normalisePassport(
  payload: any,
  _docType?: string,
  inspection?: UploadInspection,
): OcrOutcome {
  const fields: OcrField[] = [];
  const reasons: string[] = [];

  const overall = typeof payload?.confidence === 'number' ? payload.confidence : null;
  const mrz = payload?.mrz ?? {};

  // MRZ values inherit the document-level confidence — the API scores the read
  // as a whole, not field by field.
  for (const [key, value] of Object.entries(mrz)) {
    if (key === 'individual_check_digits' || key === 'all_check_digits_valid') continue;
    pushField(fields, key, value, overall, { source: payload?.mrz_source ?? 'mrz', category: 'mrz' });
  }

  fields.push(...fromExtractedFields(payload?.fields));

  // Recovered from the printed bio fields rather than the MRZ band: no check
  // digits exist, so nothing here can be verified arithmetically.
  if (payload?.mrz_source === 'visual') {
    reasons.push('MRZ band not detected — values read from the printed page, unverifiable');
  }
  if (payload?.mrz && payload.mrz.all_check_digits_valid === false) {
    reasons.push('MRZ check digits did not validate');
  }
  if (overall !== null && overall < TUNABLES.ocrReviewThreshold) {
    reasons.push(`overall confidence ${overall.toFixed(2)} below ${TUNABLES.ocrReviewThreshold}`);
  }
  if (!mrz.passport_number) {
    reasons.push('no passport number extracted');
  }
  for (const w of payload?.warnings ?? []) reasons.push(String(w));

  // §14 also asks for the visa pages, the entry and exit stamps, the observation
  // page, any previous-passport reference and the ECR/ECNR endorsement — and
  // for corners visible, no fingers over the text and no glare. None of those
  // are things this extractor answers. What can be done is tell the reviewer
  // which of them appear in the text that did come back, so a person opening
  // the review queue starts from something rather than from nothing.
  const haystack = textOf(fields);
  const detected = PASSPORT_PAGE_MARKERS.filter(([, p]) => p.test(haystack)).map(([name]) => name);

  reasons.push(
    detected.length
      ? `pages detected: ${detected.join(', ')} — confirm the full booklet against §14`
      : 'only the photo page could be identified — confirm the full booklet against §14',
  );

  return {
    raw: payload,
    fields,
    confidence: overall,
    // Always true for a passport, and deliberately so. The §14 checklist is a
    // page-by-page human judgement; the honest position is that every passport
    // is a review task, not that a clean MRZ read means the booklet is complete.
    needsReview: true,
    reviewReasons: reasons,
    completeness: passportCompleteness(payload, mrz, overall, inspection),
  };
}

/**
 * The §14 checks, as far as an extractor can answer them.
 *
 * §14 lists more than this — blank pages present, page sequence, visa pages,
 * entry and exit stamps, the observation page, ECR/ECNR. Those are page-by-page
 * judgements the extractor does not make, so they belong to the documentation
 * team, and the review queue is what puts the upload in front of them. What is
 * checked here is what can be checked reliably: that the photo page was read,
 * that the number came off it, that the passport is in date, and that nothing
 * was too dark or blurred to read.
 */
function passportCompleteness(
  payload: any,
  mrz: any,
  overall: number | null,
  inspection?: UploadInspection,
): OcrOutcome['completeness'] {
  const problems: string[] = [];
  const missingPages: number[] = [];
  let verdict: CompletenessVerdict = 'ok';

  // The file itself. A PDF that will not open is not a bad scan and saying "send
  // a clearer photo" about one is useless advice.
  if (inspection && !inspection.readable) {
    return {
      complete: false,
      verdict: 'empty',
      problems: [inspection.problem ?? 'the file could not be opened'],
    };
  }

  // §14 wants the whole booklet in one PDF. A one-page PDF is the photo page on
  // its own, which is far and away the commonest incomplete passport upload.
  // Only applied when the pages were actually countable — see `inspectUpload`.
  if (
    inspection?.pages !== undefined &&
    inspection.pages < TUNABLES.passportMinPdfPages
  ) {
    problems.push(
      `only ${inspection.pages} page was included — §14 asks for every page, including the blank ones`,
    );
    verdict = 'pages';
  }

  if (!mrz?.passport_number && !payload?.fields?.length) {
    // No MRZ band, no printed bio fields, nothing. Either the photo is unusable
    // or this is not a passport page at all — from here the two are
    // indistinguishable, and the re-ask covers both.
    problems.push('the photo page could not be read');
    verdict = 'empty';
  } else if (!mrz?.passport_number) {
    problems.push('the passport number was not readable');
    verdict = 'unreadable';
  }

  if (mrz?.expiry_date) {
    // MRZ dates are YYMMDD. A passport already expired is not a bad scan, but it
    // is not a usable document either, and staff need to know now.
    const expiry = parseMrzDate(String(mrz.expiry_date));
    if (expiry && expiry.getTime() < Date.now()) problems.push('the passport has expired');
  }

  if (overall !== null && overall < TUNABLES.ocrReviewThreshold) {
    problems.push('some of the text was too unclear to read');
    if (verdict === 'ok') verdict = 'unreadable';
  }

  for (const page of payload?.pages ?? []) {
    if (
      typeof page?.average_confidence === 'number' &&
      page.average_confidence < TUNABLES.ocrReviewThreshold &&
      typeof page.page_number === 'number'
    ) {
      missingPages.push(page.page_number);
    }
  }

  // Named pages beat a general "it was blurry", but only when naming them says
  // something: on a single page, or when every page failed, the useful
  // instruction is "send a clearer photo".
  const totalPages = (payload?.pages ?? []).length;
  if (
    verdict === 'unreadable' &&
    missingPages.length &&
    totalPages > 1 &&
    missingPages.length < totalPages
  ) {
    verdict = 'pages';
  }

  return {
    complete: problems.length === 0,
    // A problem with no verdict of its own (an expired passport, say) falls back
    // to the generic re-ask rather than silently reporting 'ok'.
    verdict: problems.length === 0 ? 'ok' : verdict === 'ok' ? 'pages' : verdict,
    problems,
    ...(missingPages.length ? { missingPages } : {}),
  };
}

/** YYMMDD, as written in the machine-readable zone. */
function parseMrzDate(value: string): Date | undefined {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return undefined;

  const year = Number(match[1]);
  // A two-digit year on an expiry date is always in the future or recent past.
  const fullYear = year > 70 ? 1900 + year : 2000 + year;
  const date = new Date(fullYear, Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normaliseResume(payload: any): OcrOutcome {
  const fields: OcrField[] = [];

  // The resume extractor returns no confidence scores at all. Every field is
  // recorded unscored rather than assigned a made-up score — an unscored field
  // must not read as a verified one.
  const flat: Array<[string, unknown]> = [
    ['name', payload?.name],
    ['designation', payload?.designation],
    ['industry', payload?.industry],
    ['highest_qualification', payload?.highest_qualification],
    ['total_experience_years', payload?.total_experience_years],
    ['total_experience_human', payload?.total_experience_human],
    ['indian_experience_human', payload?.indian_experience_human],
    ['overseas_experience_human', payload?.overseas_experience_human],
    ['address', payload?.contact?.address],
    ['linkedin', payload?.contact?.linkedin],
    ['whatsapp', payload?.contact?.whatsapp],
    ['date_of_birth', payload?.personal_info?.date_of_birth],
    ['gender', payload?.personal_info?.gender],
    ['nationality', payload?.personal_info?.nationality],
    ['father_name', payload?.personal_info?.father_name],
    ['marital_status', payload?.personal_info?.marital_status],
    ['passport_number', payload?.passport_details?.passport_number],
    ['passport_expiry', payload?.passport_details?.date_of_expiry],
  ];
  for (const [key, value] of flat) pushField(fields, key, value, null, { category: 'resume' });

  for (const email of payload?.contact?.emails ?? []) {
    pushField(fields, 'email', email, null, { category: 'contact' });
  }
  for (const phone of payload?.contact?.phones ?? []) {
    pushField(fields, 'phone', phone, null, { category: 'contact' });
  }
  const skills = payload?.skills;
  if (Array.isArray(skills) && skills.length) {
    pushField(fields, 'skills', skills.join(', '), null, { category: 'resume' });
  }

  // Employment history. Every employer the CV names and every job title it
  // lists, kept apart from `designation` — §9 is explicit that what someone did
  // before is not what they do now, and the two must never merge.
  const history =
    payload?.experience ??
    payload?.work_experience ??
    payload?.employment ??
    payload?.experiences ??
    payload?.employment_history;

  for (const employer of stringsFrom(
    history,
    'company',
    'company_name',
    'employer',
    'employer_name',
    'organisation',
    'organization',
  )) {
    pushField(fields, 'employer', employer, null, { category: 'experience' });
  }

  for (const title of stringsFrom(
    history,
    'title',
    'designation',
    'role',
    'job_title',
    'position',
  )) {
    pushField(fields, 'previous_designation', title, null, { category: 'experience' });
  }

  // Only where the extractor states them outright. Inferring countries from an
  // employer's address — "Gulf Steel Works, Sharjah" — would be guessing at the
  // CV rather than reading it, and §27 forbids inventing candidate information.
  for (const country of stringsFrom(
    payload?.overseas_countries ?? payload?.countries_worked ?? payload?.overseas?.countries,
    'name',
    'country',
  )) {
    pushField(fields, 'overseas_country', country, null, { category: 'experience' });
  }

  for (const cert of stringsFrom(
    payload?.certifications ?? payload?.certificates ?? payload?.licenses,
    'name',
    'title',
    'certification',
    'certificate',
  )) {
    pushField(fields, 'certification', cert, null, { category: 'resume' });
  }

  // Machinery and processes — a welder's TIG and MIG, an operator's VMC and
  // lathe. Worth reading off the CV because §8's trade questions ask for
  // exactly this, and anything already on the page need not be asked (§1).
  for (const machine of stringsFrom(
    payload?.machinery ?? payload?.equipment ?? payload?.machines ?? payload?.processes,
    'name',
    'machine',
    'process',
    'equipment',
  )) {
    pushField(fields, 'machinery', machine, null, { category: 'resume' });
  }

  const reasons: string[] = ['resume extractor returns no confidence scores'];
  if (!payload?.name) reasons.push('no candidate name extracted');
  for (const w of payload?.warnings ?? []) reasons.push(String(w));

  const completeness = resumeCompleteness(payload, fields);
  if (completeness.verdict === 'wrong_document') {
    reasons.push(
      completeness.looksLike
        ? `the upload reads as a ${completeness.looksLike}, not a CV`
        : 'the upload does not read as a CV',
    );
  }

  return {
    raw: payload,
    fields,
    confidence: null,
    // Unscored data is never auto-trusted. A recruiter confirms it once; the
    // CRM shows it as unverified until then.
    needsReview: true,
    reviewReasons: reasons,
    completeness,
  };
}

/**
 * Whether what came back is a CV at all.
 *
 * §5 says a CV is never re-requested for being *hard to read* — whatever it
 * yields skips a question, and whatever it does not, the flow simply asks. That
 * is still true here. What this catches is the other thing: the file is not a CV
 * in the first place.
 *
 * It happens constantly. The candidate is asked for a CV, taps the attach
 * button, and picks the wrong scan out of a gallery of them. With no filename
 * or caption naming another document, `attributeInboundDocument` has nothing to
 * go on and files it in the slot that was asked for — so their Aadhaar card
 * went through the resume extractor, produced nothing, and the bot moved
 * silently to the next question with the CV slot marked done. The candidate was
 * never told, and staff got a CV slot holding an Aadhaar card.
 *
 * "Nothing usable" is the test, not "low confidence" — the resume extractor
 * reports no confidence at all, so there is no score to threshold.
 *
 * Exported for the smoke checks: this decides whether a candidate is told they
 * sent the wrong file, so both directions are worth pinning.
 */
export function resumeCompleteness(payload: any, fields: OcrField[]): OcrOutcome['completeness'] {
  const USABLE = [
    'name',
    'designation',
    'highest_qualification',
    'employer',
    'previous_designation',
    'skills',
    'total_experience_human',
    'total_experience_years',
  ];

  const readSomething = fields.some(
    (f) => USABLE.includes(f.key) && String(f.value ?? '').trim().length > 1,
  );
  if (readSomething) return { complete: true, verdict: 'ok', problems: [] };

  const looksLike = identifyFromMarkers(payload, fields);
  if (looksLike) {
    return {
      complete: false,
      verdict: 'wrong_document',
      problems: [`the upload reads as a ${looksLike} rather than a CV`],
      looksLike,
    };
  }

  // A CV we could not read and a photo of a wall are indistinguishable from
  // here, and the re-ask covers both — the same reasoning `passportCompleteness`
  // uses for its own `empty`.
  return {
    complete: false,
    verdict: 'empty',
    problems: ['nothing that reads as a CV came back from the extractor'],
  };
}

/**
 * Which known document an upload appears to be, from its markers.
 *
 * The inverse of `identifyDocument`, which asks "is this the one we wanted?".
 * Only consulted once the extraction has produced nothing usable for the slot,
 * which is what keeps it off real documents: a CV that read cleanly never
 * reaches here, so its author's own passport number cannot make it "a passport".
 */
function identifyFromMarkers(payload: unknown, fields: OcrField[]): string | undefined {
  let haystack = textOf(fields);
  try {
    haystack += ' ' + JSON.stringify(payload ?? {});
  } catch {
    // A payload that will not serialise tells us nothing; the fields still might.
  }

  if (haystack.trim().length < MIN_TEXT_TO_JUDGE) return undefined;

  for (const [docType, markers] of Object.entries(DOCUMENT_MARKERS)) {
    if (markers.some((m) => m.test(haystack))) return docType;
  }
  return undefined;
}

function normaliseDocument(payload: any, docType?: string): OcrOutcome {
  const fields = fromExtractedFields(payload?.key_fields);
  const reasons: string[] = [];

  const pageScores = (payload?.pages ?? [])
    .map((p: any) => p?.average_confidence)
    .filter((c: unknown): c is number => typeof c === 'number');

  // Worst page governs — one unreadable page is enough to need a human.
  const overall = pageScores.length ? Math.min(...pageScores) : null;

  for (const page of payload?.pages ?? []) {
    if (page?.text) {
      pushField(fields, `page_${page.page_number}_text`, page.text, page.average_confidence ?? null, {
        page: page.page_number,
        category: 'text',
      });
    }
  }

  if (overall !== null && overall < TUNABLES.ocrReviewThreshold) {
    reasons.push(`weakest page confidence ${overall.toFixed(2)} below ${TUNABLES.ocrReviewThreshold}`);
  }
  if (overall === null) reasons.push('no page confidence reported');
  if (!fields.length) reasons.push('nothing extracted');
  for (const w of payload?.warnings ?? []) reasons.push(String(w));

  // Aadhaar and PAN come through here. Unlike a CV, an unreadable one is worth
  // asking for again — it is a single card photographed on a phone (§15, §16).
  const problems: string[] = [];
  let verdict: CompletenessVerdict = 'ok';

  const isExpectedType = identifyDocument(docType, fields, overall);

  if (!fields.length) {
    problems.push('nothing could be read from the image');
    verdict = 'empty';
  } else if (isExpectedType === false) {
    // Text came back clean and carries none of this document's markers. That is
    // a different document, not a bad photo — say so, or they will keep
    // resending the same wrong card.
    problems.push('this does not look like the document that was asked for');
    reasons.push(`expected ${docType}, none of its markers appear in the extracted text`);
    verdict = 'wrong_document';
  } else if (overall !== null && overall < TUNABLES.ocrReviewThreshold) {
    problems.push('the text was too unclear to read');
    verdict = 'unreadable';
  }

  const unreadablePages = (payload?.pages ?? [])
    .filter(
      (p: any) =>
        typeof p?.average_confidence === 'number' &&
        p.average_confidence < TUNABLES.ocrReviewThreshold,
    )
    .map((p: any) => p.page_number)
    .filter((n: unknown): n is number => typeof n === 'number');

  const totalPages = (payload?.pages ?? []).length;

  return {
    raw: payload,
    fields,
    confidence: overall,
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    completeness: {
      complete: problems.length === 0,
      // Naming the bad pages beats a general "it was blurry" — but only when
      // naming them tells the candidate something. On a one-page card, or when
      // every page is bad, "resend page 1" is noise; "send a clearer photo" is
      // the actionable instruction.
      verdict:
        problems.length === 0
          ? 'ok'
          : verdict === 'unreadable' &&
              unreadablePages.length &&
              totalPages > 1 &&
              unreadablePages.length < totalPages
            ? 'pages'
            : verdict,
      problems,
      ...(unreadablePages.length ? { missingPages: unreadablePages } : {}),
    },
  };
}

type Normaliser = (payload: any, docType?: string, inspection?: UploadInspection) => OcrOutcome;

const NORMALISERS: Record<Extractor, Normaliser> = {
  passport: normalisePassport,
  resume: normaliseResume,
  document: normaliseDocument,
};

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

export async function runOcr(params: {
  extractor: Extractor;
  buffer: Buffer;
  mimeType: string;
  filename: string;
  /** Which slot this was uploaded against, so the read can be checked against it. */
  docType?: string;
}): Promise<OcrOutcome> {
  const route = ROUTES[params.extractor];

  // Asked of the bytes before anything is sent anywhere. A file that will not
  // open cannot be extracted, and discovering that here costs milliseconds
  // instead of the full 120-second extraction timeout.
  const inspection = inspectUpload(params.buffer, params.mimeType);

  if (!inspection.readable) {
    const problem = inspection.problem ?? 'the file could not be opened';
    logger.warn({ extractor: params.extractor, problem }, 'upload rejected before extraction');
    return {
      raw: { unreadable: problem },
      fields: [],
      confidence: null,
      needsReview: true,
      reviewReasons: [problem],
      completeness: { complete: false, verdict: 'empty', problems: [problem] },
    };
  }

  const form = new FormData();
  form.append(
    route.field,
    new Blob([new Uint8Array(params.buffer)], { type: params.mimeType }),
    params.filename,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.VERIS_OCR_TIMEOUT_MS);

  try {
    const res = await fetch(`${config.VERIS_OCR_BASE_URL.replace(/\/$/, '')}${route.path}`, {
      method: 'POST',
      // The API accepts X-API-Key or Authorization; X-API-Key is the documented one.
      headers: { 'X-API-Key': config.VERIS_OCR_API_KEY },
      body: form,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${params.extractor} extract failed with ${res.status}: ${text.slice(0, 400)}`);
    }

    return NORMALISERS[params.extractor](JSON.parse(text), params.docType, inspection);
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness probe, used by the harness. */
export async function ocrHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${config.VERIS_OCR_BASE_URL.replace(/\/$/, '')}/v1/health`, {
      headers: { 'X-API-Key': config.VERIS_OCR_API_KEY },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    return { ok: res.ok, detail: `${res.status} ${body.slice(0, 120)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ */
/* Queue handler                                                       */
/* ------------------------------------------------------------------ */

/**
 * Compares identity fields across every current document (§17).
 *
 * Runs after each extraction, because the comparison only becomes possible once
 * a second document exists. Nothing is rejected on the strength of it — a
 * difference raises a flag for the documentation team and nothing else.
 */
async function runIdentityComparison(candidateId: ObjectId): Promise<void> {
  const docs = await storedDocuments()
    .find({ candidateId, supersededAt: { $exists: false } })
    .toArray();

  const sources: Record<string, { name?: string; dateOfBirth?: string; fatherName?: string }> = {};

  for (const doc of docs) {
    const fields = doc.ocr?.fields;
    if (!fields?.length) continue;
    sources[doc.docType] =
      doc.docType === 'cv' ? extractFromCv(fields).identity : identityFromDocument(fields);
  }

  if (Object.keys(sources).length < 2) return;

  const comparison = compareIdentity(sources);
  if (!comparison.consistent) {
    await flagIdentityMismatch(candidateId, comparison.differences);
  }
}

/** Maps an identity document's extraction onto the profile fields it can fill. */
function profileFromIdentityDocument(
  docType: string,
  fields: Parameters<typeof identityFromDocument>[0],
): Partial<CandidateProfile> {
  const identity = identityFromDocument(fields);
  const patch: Partial<CandidateProfile> = {};

  if (identity.fatherName) patch.fatherName = identity.fatherName;
  if (identity.dateOfBirth) patch.dateOfBirth = identity.dateOfBirth;

  // Stored so staff can verify them, masked everywhere else, and never read back
  // to the candidate (§15, §16, §27).
  if (identity.number) {
    if (docType === 'passport') patch.passportNumber = identity.number;
    if (docType === 'aadhaar') patch.aadhaarNumber = identity.number;
    if (docType === 'pan') patch.panNumber = identity.number;
  }

  return patch;
}

export async function processOcrJob(payload: { documentId: string }): Promise<void> {
  const _id = new ObjectId(payload.documentId);
  const doc = await storedDocuments().findOne({ _id });

  if (!doc) {
    logger.warn({ documentId: payload.documentId }, 'ocr job for unknown document');
    return;
  }

  const extractor = requirementFor(doc.docType)?.ocr;
  if (!extractor || extractor === 'none') {
    await storedDocuments().updateOne(
      { _id },
      { $set: { 'ocr.status': 'skipped', updatedAt: new Date() } },
    );
    // Nothing to read, so the conversation moves on immediately.
    await withCandidateLock(doc.waId, () =>
      resumeAfterDocument(doc.candidateId, doc.docType, {
        complete: true,
        verdict: 'ok',
        problems: [],
      }),
    );
    return;
  }

  await storedDocuments().updateOne(
    { _id },
    {
      $set: {
        'ocr.status': 'running',
        'ocr.extractor': extractor,
        'ocr.startedAt': new Date(),
        updatedAt: new Date(),
      },
    },
  );

  try {
    const buffer = await readFile(doc.storageKey);
    const outcome = await runOcr({
      extractor,
      buffer,
      mimeType: doc.mimeType,
      filename: doc.originalFilename ?? doc.storageKey.split('/').pop() ?? 'upload',
      docType: doc.docType,
    });

    await storedDocuments().updateOne(
      { _id },
      {
        $set: {
          ocr: {
            status: 'done',
            extractor,
            startedAt: doc.ocr?.startedAt,
            finishedAt: new Date(),
            raw: outcome.raw,
            fields: outcome.fields,
            confidence: outcome.confidence,
            needsReview: outcome.needsReview,
            reviewReasons: outcome.reviewReasons,
            completeness: outcome.completeness,
          },
          updatedAt: new Date(),
        },
      },
    );

    // From here on this job writes profile fields and then asks a question off
    // the back of them, which is the same thing an inbound turn does — so it
    // takes the same lock. Without it, a candidate who messages while their CV
    // is being read has two turns running at once: both compute the next
    // question from a half-written profile, both send one, and whichever
    // finishes last overwrites `currentStep`. The visible symptom is questions
    // arriving out of order and an answer recorded against the wrong one.
    //
    // The lock is taken *here* rather than around the whole job on purpose:
    // extraction takes up to 120 seconds, and holding it for that long would
    // freeze the conversation while the file is read.
    await withCandidateLock(doc.waId, async () => {
      await markSlotFromOcr(
        doc.candidateId,
        doc.docType,
        !outcome.completeness.complete
          ? 'incomplete'
          : outcome.needsReview
            ? 'needs_review'
            : 'ocr_done',
      );

      // §5 — what the document yields becomes profile fields, so the questions it
      // answers are never asked. Marked unverified; a person confirms it (§27).
      const patch =
        extractor === 'resume'
          ? extractFromCv(outcome.fields, doc.waId).patch
          : profileFromIdentityDocument(doc.docType, outcome.fields);

      // Nothing is written from a file that is not the document it was filed
      // as. Whatever an Aadhaar card yields under the resume extractor is not
      // this candidate's CV, and a profile is harder to correct than a slot.
      const trustworthy = outcome.completeness.verdict !== 'wrong_document';

      if (trustworthy && Object.keys(patch).length) {
        await mergeExtractedProfile(
          doc.candidateId,
          patch,
          extractor === 'resume' ? 'cv' : 'document',
          outcome.confidence,
        );
      }

      await runIdentityComparison(doc.candidateId);

      // Moves the conversation on: the acknowledgement, or the re-ask (§14).
      await resumeAfterDocument(doc.candidateId, doc.docType, outcome.completeness);
    });

    logger.info(
      {
        documentId: payload.documentId,
        docType: doc.docType,
        extractor,
        fields: outcome.fields.length,
        confidence: outcome.confidence,
        needsReview: outcome.needsReview,
        complete: outcome.completeness.complete,
      },
      'ocr complete',
    );
  } catch (err) {
    logger.error({ err, documentId: payload.documentId }, 'ocr failed');
    await storedDocuments().updateOne(
      { _id },
      {
        $set: {
          'ocr.status': 'failed',
          'ocr.finishedAt': new Date(),
          'ocr.error': err instanceof Error ? err.message : String(err),
          'ocr.needsReview': true,
          updatedAt: new Date(),
        },
      },
    );

    // The file is on disk; what failed is our reading of it. A failed extraction
    // is a review task, not a reason to make the candidate photograph their
    // passport again — so the upload is acknowledged and staff pick it up.
    await withCandidateLock(doc.waId, async () => {
      await markSlotFromOcr(doc.candidateId, doc.docType, 'ocr_failed');
      await resumeAfterDocument(doc.candidateId, doc.docType, {
        complete: true,
        verdict: 'ok',
        problems: ['extraction failed; needs a manual check'],
      });
    });
  }
}
