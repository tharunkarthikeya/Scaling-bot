import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  addUpload,
  claimExtraction,
  documentsFor,
  documentStoreFor,
  dueExtractions,
  findUpload,
  flattenUploads,
  releaseExtraction,
  updateUpload,
  type DocumentUpload,
  type DueExtraction,
  type OcrField,
  type UploadOcr,
} from '../db/models.js';
import { recordOcrJob } from '../ingestion/ledger.js';
import {
  JobQueueFullError,
  nextPollDelayMs,
  ocrIdempotencyKey,
  pollOcrJob,
  retryFailedJob,
  serviceStillWorking,
  shouldRetryFailedJob,
  submitOcrJob,
  type JobResponse,
} from './jobs.js';
import { readFile } from '../storage/index.js';
import { queue, withCandidateLock } from '../queue/index.js';
import { TUNABLES } from '../conversation/rules.js';
import { requirementFor } from '../conversation/checklist.js';
import {
  flagIdentityMismatch,
  markSlotFromOcr,
  mergeExtractedProfile,
  resumeAfterDocument,
  uploadStillCurrent,
} from '../conversation/engine.js';
import {
  extractFromCv,
  identityFromDocument,
  identityKind,
  parseMrzDate,
  profileFromIdentityDocument,
} from '../conversation/cv.js';
import { compareIdentity } from '../conversation/profile.js';
import type { CandidateProfile } from '../db/models.js';

/**
 * Veris (RecursAI) OCR client — https://veris.recursai.in
 *
 * Three extractors, each with its own route, form field, and response shape:
 *
 *   passport  POST /v1/passport/extract   field "image"  → MRZ + check digits
 *   resume    POST /v1/resume/extract     field "image"  → structured CV fields
 *   aadhaar   POST /v1/aadhaar/extract    field "image"  → named Aadhaar fields
 *
 * Three, and only three. Veris also publishes a generic `/v1/document/extract`
 * that returns page text plus whatever key/value pairs it happened to find, and
 * PAN cards, driving licences and loose certificates used to go through it. They
 * no longer do: nothing on those answers a question the flow asks, so they are
 * stored and left alone (`ocr: 'none'` in `rules.ts`), and the generic route is
 * gone from this file so a checklist edit cannot quietly send an identifier
 * back through it. A kind either has an extractor built for it, or it is not
 * read.
 *
 * That specificity is the point. Aadhaar cards were themselves on the generic
 * route once, and a card that read cleanly could still yield nothing usable —
 * the number, the name and the date of birth had to be picked back out of a bag
 * of strings. The dedicated endpoint returns them named, tells us which side of
 * the card it read, and validates the number's checksum.
 *
 * OCR is slow (the configured timeout is 120s), so this only ever runs from a
 * queue worker — never inside the webhook request.
 */

export type Extractor = 'passport' | 'resume' | 'aadhaar';

const ROUTES: Record<Extractor, { path: string; field: string }> = {
  passport: { path: '/v1/passport/extract', field: 'image' },
  resume: { path: '/v1/resume/extract', field: 'image' },
  aadhaar: { path: '/v1/aadhaar/extract', field: 'image' },
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
  const markers = DOCUMENT_MARKERS[identityKind(docType)];
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
  /**
   * Page count, when it can be established. Undefined means "could not tell".
   *
   * Saturating, not exact: the scan stops at `PAGE_SCAN_STOP_AT` because that
   * is the largest number any caller compares against. A `2` here means "two or
   * more", and the only question asked of this field — `§14`'s "is this the
   * photo page on its own?" — is answered identically either way.
   */
  pages?: number;
  /** Plain-language problem, when `readable` is false. */
  problem?: string;
}

const PDF_MAGIC = '%PDF-';

/** The two literals a page object is spelled with, as bytes rather than text. */
const TYPE_MARKER = Buffer.from('/Type', 'latin1');
const PAGE_MARKER = Buffer.from('/Page', 'latin1');

/**
 * How far into the file the page scan is allowed to read.
 *
 * A cap rather than a budget: page objects live in the body, and a document
 * whose first two are past eight megabytes is not one this check can speak to
 * honestly. Reaching the cap without an answer reports `undefined`, which is
 * the same thing said about a PDF whose pages are hidden in compressed object
 * streams — see the note on `inspectUpload`.
 */
const PAGE_SCAN_WINDOW = 8 * 1024 * 1024;

/**
 * Matches to find before stopping. `TUNABLES.passportMinPdfPages` is 2 and the
 * count is only ever compared against it, so a third match cannot change any
 * decision and a millionth would only cost the loop that found it.
 */
const PAGE_SCAN_STOP_AT = 2;

/**
 * The bytes JavaScript's `\s` matches that a single latin1 byte can actually
 * be — tab through carriage return, space, and the non-breaking space. The
 * wider unicode spaces `\s` also covers need more than one byte to spell and so
 * cannot appear here.
 */
function isPdfSpace(byte: number): boolean {
  return (byte >= 0x09 && byte <= 0x0d) || byte === 0x20 || byte === 0xa0;
}

/** `[^sA-Za-z]` — an `s` is a letter, so the class is exactly "not a letter". */
function isAsciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

/**
 * Page objects in the first `PAGE_SCAN_WINDOW` bytes, counted straight off the
 * buffer and abandoned once `PAGE_SCAN_STOP_AT` have been found.
 *
 * What it looks for is what the regex it replaces looked for: the literal
 * `/Type`, any run of whitespace, the literal `/Page`, and then one byte that
 * is not a letter — which is what keeps `/Type /Pages`, the page *tree*, from
 * being counted as a page, and what makes a `/Type /Page` with nothing after it
 * no match at all.
 *
 * Returns the count and whether the scan reached the end of the file, because
 * the two together are what decide whether a count may be reported. Allocates
 * nothing: `subarray` is a view, and `indexOf` searches bytes.
 */
function scanPageObjects(buffer: Buffer): { found: number; exhaustive: boolean } {
  const horizon = Math.min(buffer.byteLength, PAGE_SCAN_WINDOW);
  // Bounds `indexOf` to the window without copying — a match may only *start*
  // inside it, while the bytes confirming that match are read from the file.
  const window = buffer.subarray(0, horizon);

  let found = 0;
  let from = 0;

  while (found < PAGE_SCAN_STOP_AT) {
    const at = window.indexOf(TYPE_MARKER, from);
    if (at === -1) break;

    // Resume past this `/Type` whether or not it turns out to be a page, so a
    // near-miss cannot put the loop back where it started. `/Type` cannot
    // overlap itself, so skipping its whole length finds the same next
    // occurrence the regex found by advancing one byte at a time.
    from = at + TYPE_MARKER.length;

    let cursor = from;
    while (cursor < buffer.byteLength && isPdfSpace(buffer[cursor]!)) cursor += 1;

    // `compare` throws rather than returning false when the range runs off the
    // end, and `%%EOF` only has to appear in the last 4 KB — so a file may well
    // end in a `/Type` with no room left to spell `/Page` after it.
    if (cursor + PAGE_MARKER.length > buffer.byteLength) continue;

    if (
      buffer.compare(PAGE_MARKER, 0, PAGE_MARKER.length, cursor, cursor + PAGE_MARKER.length) !== 0
    ) {
      continue;
    }

    const after = cursor + PAGE_MARKER.length;
    // One byte has to exist and it has to not be a letter. A page object cut off
    // by the end of the file is not something to count.
    if (after >= buffer.byteLength || isAsciiLetter(buffer[after]!)) continue;

    found += 1;
    // That byte is part of the match and the regex consumed it, so the next
    // search starts past it. It matters where two page objects are written with
    // nothing between them: `/Type/Page/Type/Page` is one match, not two,
    // because the first swallowed the slash the second needed. An artifact of
    // how the old scan was spelled rather than anything about PDFs — but it is
    // the behaviour that shipped, and a page count is not the place to quietly
    // change an answer.
    from = after + 1;
  }

  return { found, exhaustive: horizon === buffer.byteLength };
}

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
 *
 * `countPages` exists because the count has exactly one reader. Only
 * `passportCompleteness` asks for it; the resume and Aadhaar normalisers take
 * no inspection at all, so scanning their uploads was work whose result was
 * thrown away — and a CV is the commonest PDF the bot is sent. Callers that
 * will not read the number should say so and skip the scan. It defaults on, so
 * asking for less is deliberate and asking for everything is free.
 */
export function inspectUpload(
  buffer: Buffer,
  mimeType: string,
  options: { countPages?: boolean } = {},
): UploadInspection {
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

  if (options.countPages === false) return { readable: true };

  const { found, exhaustive } = scanPageObjects(buffer);

  // Three ways this ends, and only one of them is a number worth reporting.
  //
  //   found the lot        the count stands, whatever it is
  //   stopped early        `PAGE_SCAN_STOP_AT` reached, which already answers
  //                        the only question asked of it
  //   ran out of window    fewer than that, and more file left to read — so the
  //                        honest answer is that we do not know, exactly as for
  //                        a PDF whose pages are hidden in object streams
  const countable = exhaustive || found >= PAGE_SCAN_STOP_AT;

  return { readable: true, ...(countable && found > 0 ? { pages: found } : {}) };
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

/**
 * The Aadhaar endpoint's own response.
 *
 * `payload.aadhaar` carries the card's fields under their own names, so unlike
 * the generic document extractor there is nothing to guess at: the keys pushed
 * here are the ones `identityFromDocument` already looks for, which is what puts
 * the number and the date of birth on the profile.
 *
 * Two things this endpoint knows that the generic one could not:
 *
 *   `aadhaar_number_valid`  the number's checksum. A card whose number does not
 *                           validate is not refused — a misread digit is far
 *                           likelier than a forged card — but it is a review
 *                           task, because the number is what staff will key in.
 *   `document_side`         which side was read. Recorded rather than enforced:
 *                           the B2B branch asks for the two sides separately and
 *                           a mismatch is worth a person's eye, not a rejection.
 */
function normaliseAadhaar(payload: any): OcrOutcome {
  const card = payload?.aadhaar ?? {};
  const fields: OcrField[] = [];
  const reasons: string[] = [];

  const pageScores = (payload?.pages ?? [])
    .map((pg: any) => pg?.average_confidence)
    .filter((c: unknown): c is number => typeof c === 'number');

  // Worst page governs, as everywhere else: one unreadable side is enough.
  const overall = pageScores.length ? Math.min(...pageScores) : null;

  // Named exactly as the endpoint names them. `aadhaar_number` normalises to
  // "aadhaarnumber", which is one of the keys `identityFromDocument` picks up.
  for (const key of [
    'name',
    'aadhaar_number',
    'masked_aadhaar_number',
    'date_of_birth',
    'year_of_birth',
    'gender',
    'mobile_number',
    'address',
    'care_of',
    'pincode',
    'vid',
    'enrollment_id',
    'document_side',
  ]) {
    pushField(fields, key, card[key], overall, { category: 'aadhaar' });
  }

  for (const page of payload?.pages ?? []) {
    if (page?.text) {
      pushField(fields, `page_${page.page_number}_text`, page.text, page.average_confidence ?? null, {
        page: page.page_number,
        category: 'text',
      });
    }
  }

  if (card.aadhaar_number && card.aadhaar_number_valid === false) {
    reasons.push('the Aadhaar number read off the card failed its checksum');
  }
  if (overall !== null && overall < TUNABLES.ocrReviewThreshold) {
    reasons.push(`weakest page confidence ${overall.toFixed(2)} below ${TUNABLES.ocrReviewThreshold}`);
  }
  if (overall === null) reasons.push('no page confidence reported');
  for (const w of payload?.warnings ?? []) reasons.push(String(w));

  // What makes the upload usable: something that identifies the holder. A back
  // side carries an address and the number but no name or date of birth, and it
  // is a perfectly good upload — so either identifier is enough.
  const identified = !!(card.name || card.aadhaar_number);
  const anyText = fields.some((f) => f.category === 'text' && f.value.trim().length > 0);

  const problems: string[] = [];
  let verdict: CompletenessVerdict = 'ok';

  if (!identified && !anyText) {
    problems.push('nothing could be read from the image');
    verdict = 'empty';
  } else if (!identified && overall !== null && overall >= TUNABLES.ocrReviewThreshold) {
    // Text came back clean and none of it was an Aadhaar's. That is a different
    // card, not a bad photo — and this endpoint only ever reads Aadhaars, so it
    // is the one thing it can say with confidence.
    problems.push('this does not look like an Aadhaar card');
    reasons.push('the Aadhaar extractor found no Aadhaar fields in a page that read clearly');
    verdict = 'wrong_document';
  } else if (!identified || (overall !== null && overall < TUNABLES.ocrReviewThreshold)) {
    problems.push('the text was too unclear to read');
    verdict = 'unreadable';
  }

  return {
    raw: payload,
    fields,
    confidence: overall,
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    completeness: { complete: problems.length === 0, verdict, problems },
  };
}

type Normaliser = (payload: any, docType?: string, inspection?: UploadInspection) => OcrOutcome;

const NORMALISERS: Record<Extractor, Normaliser> = {
  passport: normalisePassport,
  resume: normaliseResume,
  aadhaar: normaliseAadhaar,
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
  // Only the passport normaliser reads the page count (`passportCompleteness`),
  // so only a passport pays for the scan.
  const inspection = inspectUpload(params.buffer, params.mimeType, {
    countPages: params.extractor === 'passport',
  });

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
    // A `Buffer` is already a `Uint8Array`, and `Blob` copies its parts either
    // way — so wrapping it in another one only bought a second copy of the file.
    new Blob([params.buffer], { type: params.mimeType }),
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

/**
 * Runs one document-specific normaliser. Tests only.
 *
 * Exists so the migration's central claim can be checked directly: that a job
 * `result` and a synchronous response body are the same object, and the three
 * normalisers therefore need no changes. Testing that through the whole worker
 * would prove it only for whatever path the test happened to take.
 */
export function normaliseExtractionForTests(
  extractor: Extractor,
  payload: unknown,
  docType?: string,
  inspection?: UploadInspection,
): OcrOutcome {
  return NORMALISERS[extractor](payload, docType, inspection);
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
async function runIdentityComparison(candidateId: ObjectId, docType: string): Promise<void> {
  // `docType` says which store to read: a business contact's uploads live in
  // `b2b_documents`, and comparing across a store they are not in would find
  // nothing to compare.
  const record = await documentStoreFor(docType).findOne({ candidateId });
  if (!record) return;

  // The current version of each kind — a superseded upload is a previous
  // answer, and comparing against it would flag a difference the candidate has
  // already corrected.
  const current = flattenUploads(record).filter((u) => !u.supersededAt);

  const sources: Record<string, { name?: string; dateOfBirth?: string; fatherName?: string }> = {};

  for (const doc of current) {
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

/**
 * Files the passport a candidate attached to their CV as a passport as well.
 *
 * People send one PDF: CV first, passport pages scanned in behind it. Read only
 * by the resume extractor, those pages are wasted — the passport slot stays
 * empty, so §12 asks for a document the agency already has, and the number and
 * expiry that are sitting in the file are never read.
 *
 * So the same bytes are filed a second time, against the passport slot, and
 * queued for the passport extractor. Two extractions of one file, which is the
 * point: the resume extractor reads a CV and the passport extractor reads an
 * MRZ, and neither can do the other's job.
 *
 * Nothing is copied on disk. The new upload carries the same `storageKey`, so
 * there is one file with two records pointing at it.
 *
 * Deliberately narrow:
 *   - only when the CV's own text carries passport markers, so an ordinary CV
 *     mentioning the word "passport" does not trigger it;
 *   - only when the passport slot is empty, so a passport the candidate sent
 *     properly is never superseded by one scraped out of a CV.
 */
async function filePassportFoundInCv(
  waId: string,
  candidateId: ObjectId,
  cv: {
    storageKey: string;
    mediaId: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    /** Carried through so the second extraction can key itself. */
    wamid?: string;
  },
  fields: OcrField[],
  payload: unknown,
): Promise<void> {
  if (identifyFromMarkers(payload, fields) !== 'passport') return;

  const record = await documentsFor(waId, 'passport');
  const already = (record?.passport?.uploads ?? []).some((u) => !u.supersededAt);
  if (already) return;

  const uploadId = await addUpload({
    waId,
    candidateId,
    docType: 'passport',
    upload: {
      mediaId: cv.mediaId,
      storageKey: cv.storageKey,
      mimeType: cv.mimeType,
      byteSize: cv.byteSize,
      sha256: cv.sha256,
      ...(cv.wamid ? { wamid: cv.wamid } : {}),
      caption: 'passport pages found inside the CV',
      ocr: { status: 'queued' },
    },
  });

  await markSlotFromOcr(candidateId, 'passport', 'ocr_queued');
  await queue.enqueue('ocr', { waId, docType: 'passport', uploadId: uploadId.toHexString() });

  logger.info(
    { waId, storageKey: cv.storageKey },
    'passport pages found inside a CV; filed and queued for the passport extractor',
  );
}

export async function processOcrJob(payload: {
  waId: string;
  docType: string;
  uploadId: string;
}): Promise<void> {
  const { waId, docType } = payload;
  const uploadId = new ObjectId(payload.uploadId);
  const doc = await findUpload(waId, docType, uploadId);

  if (!doc) {
    logger.warn(payload, 'ocr job for unknown upload');
    return;
  }

  const record = await documentsFor(waId, docType);
  const candidateId = record?.candidateId;
  if (!candidateId) {
    logger.warn(payload, 'ocr job for an upload with no candidate');
    return;
  }

  const extractor = requirementFor(docType)?.ocr;
  if (!extractor || extractor === 'none') {
    await updateUpload(waId, docType, uploadId, { 'ocr.status': 'skipped' });
    // Nothing to read, so the conversation moves on immediately.
    await withCandidateLock(waId, () =>
      resumeAfterDocument(
        candidateId,
        docType,
        { complete: true, verdict: 'ok', problems: [] },
        uploadId,
      ),
    );
    return;
  }

  if (config.VERIS_OCR_ASYNC) {
    await submitExtraction({ waId, docType, uploadId, candidateId, extractor, doc });
    return;
  }

  await updateUpload(waId, docType, uploadId, {
    'ocr.status': 'running',
    'ocr.extractor': extractor,
    'ocr.startedAt': new Date(),
  });

  try {
    const buffer = await readFile(doc.storageKey);
    const outcome = await runOcr({
      extractor,
      buffer,
      mimeType: doc.mimeType,
      filename: doc.originalFilename ?? doc.storageKey.split('/').pop() ?? 'upload',
      docType,
    });

    await applySuccessfulExtraction({
      waId,
      docType,
      uploadId,
      candidateId,
      extractor,
      doc,
      outcome,
      startedAt: doc.ocr?.startedAt,
    });
  } catch (err) {
    logger.error({ err, ...payload }, 'ocr failed');
    await applyFailedExtraction({
      waId,
      docType,
      uploadId,
      candidateId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Terminal handling, shared by both paths                             */
/* ------------------------------------------------------------------ */

/**
 * Everything that happens once an extraction has produced a verdict.
 *
 * Lifted out of `processOcrJob` unchanged so the synchronous and asynchronous
 * paths cannot drift: whichever way the payload was fetched, what is stored,
 * what is written to the profile and what the candidate is told is the same
 * code. That is what makes the feature flag a decision about transport rather
 * than about behaviour.
 */
async function applySuccessfulExtraction(params: {
  waId: string;
  docType: string;
  uploadId: ObjectId;
  candidateId: ObjectId;
  extractor: Extractor;
  doc: { storageKey: string; mediaId: string; mimeType: string; byteSize: number; sha256: string; wamid?: string };
  outcome: OcrOutcome;
  startedAt?: Date;
}): Promise<void> {
  const { waId, docType, uploadId, candidateId, extractor, doc, outcome } = params;

  // Whether anything read off this file is worth keeping.
  //
  // A blurred card does not fail cleanly: the extractor returns values, and
  // they are half right — a digit dropped from an Aadhaar number, a name with
  // two letters guessed. Storing that is worse than storing nothing, because
  // nothing is obviously missing and a wrong number looks like a real one. So
  // an unusable read keeps its verdict and its reasons, which is what a person
  // needs to see, and none of its values.
  //
  // A CV is the exception, and stays as it was: it holds no identifier, and a
  // partial read still saves the candidate questions (§5). Only a file that is
  // not a CV at all is discarded there.
  const keepExtraction =
    outcome.completeness.complete ||
    (extractor === 'resume' && outcome.completeness.verdict !== 'wrong_document');

  await updateUpload(waId, docType, uploadId, {
    'ocr.status': 'done',
    'ocr.extractor': extractor,
    'ocr.startedAt': params.startedAt,
    'ocr.finishedAt': new Date(),
    ...(keepExtraction ? { 'ocr.raw': outcome.raw, 'ocr.fields': outcome.fields } : {}),
    'ocr.confidence': outcome.confidence,
    'ocr.needsReview': outcome.needsReview,
    'ocr.reviewReasons': outcome.reviewReasons,
    'ocr.completeness': outcome.completeness,
    'ocr.claimedAt': undefined,
  });

  // From here on this job writes profile fields and then asks a question off
  // the back of them, which is the same thing an inbound turn does — so it
  // takes the same lock. Without it, a candidate who messages while their CV
  // is being read has two turns running at once: both compute the next
  // question from a half-written profile, both send one, and whichever
  // finishes last overwrites `currentStep`. The visible symptom is questions
  // arriving out of order and an answer recorded against the wrong one.
  await withCandidateLock(waId, async () => {
    // Two photos sent seconds apart both land in the slot the bot last asked
    // for, the second superseding the first, and both are read. Only the
    // verdict on the file the slot actually holds may write anything.
    if (!(await uploadStillCurrent(candidateId, docType, uploadId))) {
      logger.info(
        { waId, docType, uploadId: uploadId.toHexString() },
        'extraction finished for an upload that has since been replaced',
      );
      return;
    }

    await markSlotFromOcr(
      candidateId,
      docType,
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
        ? extractFromCv(outcome.fields, waId).patch
        : profileFromIdentityDocument(docType, outcome.fields);

    // Nothing is written from a file that is not the document it was filed
    // as, and nothing from one that could not be read. Whatever an Aadhaar
    // card yields under the resume extractor is not this candidate's CV, and
    // a profile is harder to correct than a slot.
    if (keepExtraction && Object.keys(patch).length) {
      await mergeExtractedProfile(
        candidateId,
        patch,
        extractor === 'resume' ? 'cv' : 'document',
        outcome.confidence,
      );
    }

    // A CV can carry a passport behind it. Read as a CV it is one document;
    // read again as a passport it is two, and §12 stops asking for something
    // already on file.
    if (docType === 'cv') {
      await filePassportFoundInCv(
        waId,
        candidateId,
        {
          storageKey: doc.storageKey,
          mediaId: doc.mediaId,
          mimeType: doc.mimeType,
          byteSize: doc.byteSize,
          sha256: doc.sha256,
          wamid: doc.wamid,
        },
        outcome.fields,
        outcome.raw,
      );
    }

    await runIdentityComparison(candidateId, docType);

    // Moves the conversation on: the acknowledgement, or the re-ask (§14).
    await resumeAfterDocument(candidateId, docType, outcome.completeness, uploadId);
  });

  logger.info(
    {
      waId,
      docType,
      uploadId: uploadId.toHexString(),
      extractor,
      fields: outcome.fields.length,
      confidence: outcome.confidence,
      needsReview: outcome.needsReview,
      complete: outcome.completeness.complete,
    },
    'ocr complete',
  );
}

/**
 * An extraction that will not produce a verdict.
 *
 * The file is on disk; what failed is our reading of it. A failed extraction is
 * a review task, not a reason to make the candidate photograph their passport
 * again — so the upload is acknowledged and staff pick it up.
 */
async function applyFailedExtraction(params: {
  waId: string;
  docType: string;
  uploadId: ObjectId;
  candidateId: ObjectId;
  error: string;
}): Promise<void> {
  const { waId, docType, uploadId, candidateId } = params;

  await updateUpload(waId, docType, uploadId, {
    'ocr.status': 'failed',
    'ocr.finishedAt': new Date(),
    'ocr.error': params.error,
    'ocr.needsReview': true,
    'ocr.claimedAt': undefined,
  });

  await withCandidateLock(waId, async () => {
    if (!(await uploadStillCurrent(candidateId, docType, uploadId))) {
      logger.info(
        { waId, docType, uploadId: uploadId.toHexString() },
        'extraction failed for an upload that has since been replaced',
      );
      return;
    }
    await markSlotFromOcr(candidateId, docType, 'ocr_failed');
    await resumeAfterDocument(
      candidateId,
      docType,
      { complete: true, verdict: 'ok', problems: ['extraction failed; needs a manual check'] },
      uploadId,
    );
  });
}

/* ------------------------------------------------------------------ */
/* The async Jobs API path (VERIS_OCR_ASYNC)                           */
/* ------------------------------------------------------------------ */

/** The verdict on a file that will not open, shared by both paths. */
function unreadableOutcome(problem: string): OcrOutcome {
  return {
    raw: { unreadable: problem },
    fields: [],
    confidence: null,
    needsReview: true,
    reviewReasons: [problem],
    completeness: { complete: false, verdict: 'empty', problems: [problem] },
  };
}

/** The message the upload arrived on, falling back as `ingestDocument` does. */
function wamidOf(doc: { wamid?: string; mediaId: string }): string {
  return doc.wamid ?? doc.mediaId;
}

/**
 * Queues one document with Veris and hands the slot back.
 *
 * The pool slot is released the moment the job is accepted, which is the whole
 * point of the migration: an extraction no longer occupies a worker for its
 * duration, so `QUEUE_CONCURRENCY_OCR` bounds submissions rather than bounding
 * how many documents can be in flight at once.
 *
 * The inspection is written *before* anything else, because the terminal poll
 * happens in a later invocation with the file long out of memory, and
 * `passportCompleteness` reads it to decide whether §14's page requirement was
 * met. Losing it would silently disable that check.
 */
async function submitExtraction(params: {
  waId: string;
  docType: string;
  uploadId: ObjectId;
  candidateId: ObjectId;
  extractor: Extractor;
  doc: DocumentUpload;
}): Promise<void> {
  const { waId, docType, uploadId, candidateId, extractor, doc } = params;
  const attempts = (doc.ocr?.attempts ?? 0) + 1;

  const buffer = await readFile(doc.storageKey);
  const inspection = inspectUpload(buffer, doc.mimeType, {
    countPages: extractor === 'passport',
  });

  // A file that will not open cannot be extracted, and discovering that here
  // costs nothing rather than a job and a poll cycle.
  if (!inspection.readable) {
    const problem = inspection.problem ?? 'the file could not be opened';
    logger.warn({ waId, docType, problem }, 'upload rejected before submission');
    await applySuccessfulExtraction({
      waId,
      docType,
      uploadId,
      candidateId,
      extractor,
      doc,
      outcome: unreadableOutcome(problem),
    });
    return;
  }

  const idempotencyKey = ocrIdempotencyKey({
    phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
    wamid: wamidOf(doc),
    mediaId: doc.mediaId,
    extractor,
  });

  try {
    const accepted = await submitOcrJob({
      mode: extractor,
      buffer,
      mimeType: doc.mimeType,
      filename: doc.originalFilename ?? doc.storageKey.split('/').pop() ?? 'upload',
      idempotencyKey,
    });

    await updateUpload(waId, docType, uploadId, {
      'ocr.status': 'running',
      'ocr.extractor': extractor,
      'ocr.jobId': accepted.job_id,
      'ocr.statusUrl': accepted.status_url,
      'ocr.submittedAt': new Date(accepted.submitted_at),
      'ocr.startedAt': doc.ocr?.startedAt ?? new Date(),
      'ocr.attempts': attempts,
      'ocr.inspection': inspection,
      'ocr.nextPollAt': new Date(Date.now() + config.VERIS_OCR_POLL_MIN_MS),
      'ocr.claimedAt': undefined,
    });

    await recordOcrJob({
      wamid: wamidOf(doc),
      mediaId: doc.mediaId,
      status: 'running',
      ocrMode: extractor,
      jobId: accepted.job_id,
      attempts,
    });

    logger.info(
      {
        waId,
        docType,
        uploadId: uploadId.toHexString(),
        jobId: accepted.job_id,
        duplicate: accepted.duplicate === true,
      },
      'ocr job submitted',
    );
  } catch (err) {
    if (err instanceof JobQueueFullError) {
      // Admission control, not a document problem. The upload stays queued and
      // the attempt is deliberately NOT counted — the spec is explicit that
      // queue-full is backpressure and never document loss, so a busy hour must
      // not exhaust an upload's attempts and turn it into a review task.
      const wait = (err as JobQueueFullError).retryAfterMs ?? config.VERIS_OCR_POLL_MAX_MS;
      await updateUpload(waId, docType, uploadId, {
        'ocr.status': 'queued',
        'ocr.nextPollAt': new Date(Date.now() + wait),
        'ocr.claimedAt': undefined,
      });
      await recordOcrJob({
        wamid: wamidOf(doc),
        mediaId: doc.mediaId,
        status: 'submitting',
        ocrMode: extractor,
        nextAttemptAt: new Date(Date.now() + wait),
      });
      logger.warn({ waId, docType, waitMs: wait }, 'veris queue full; submission deferred');
      return;
    }

    // A submission that did not land. Worth another go with the *same*
    // idempotency key, so a request that actually succeeded before the response
    // was lost cannot produce a second job.
    const message = err instanceof Error ? err.message : String(err);

    if (attempts >= config.INGESTION_MAX_ATTEMPTS) {
      logger.error({ waId, docType, attempts, err }, 'ocr submission exhausted its attempts');
      await applyFailedExtraction({
        waId,
        docType,
        uploadId,
        candidateId,
        error: `submission failed after ${attempts} attempts: ${message}`,
      });
      return;
    }

    const wait = Math.min(
      config.VERIS_OCR_POLL_MIN_MS * 2 ** (attempts - 1),
      config.VERIS_OCR_POLL_MAX_MS,
    );
    await updateUpload(waId, docType, uploadId, {
      'ocr.status': 'queued',
      'ocr.attempts': attempts,
      'ocr.error': message,
      'ocr.nextPollAt': new Date(Date.now() + wait),
      'ocr.claimedAt': undefined,
    });
    await recordOcrJob({
      wamid: wamidOf(doc),
      mediaId: doc.mediaId,
      status: 'submitting',
      ocrMode: extractor,
      attempts,
      error: message,
      nextAttemptAt: new Date(Date.now() + wait),
    });
    logger.warn({ waId, docType, attempts, err }, 'ocr submission failed; will try again');
  }
}

/**
 * Asks Veris what became of one job, and acts on the answer.
 *
 * Four states and only four. `queued` and `running` reschedule; `succeeded`
 * normalises and releases the conversation; `failed` goes to the retry question,
 * which is the one piece of this contract Veris has not confirmed.
 */
async function pollExtraction(params: {
  waId: string;
  docType: string;
  uploadId: ObjectId;
  candidateId: ObjectId;
  extractor: Extractor;
  doc: DocumentUpload;
}): Promise<void> {
  const { waId, docType, uploadId, candidateId, extractor, doc } = params;
  const ocr = doc.ocr;

  if (!ocr?.statusUrl) {
    // Marked running with nowhere to ask. Nothing can recover this but a
    // resubmission, so it goes back to queued rather than sitting forever.
    logger.warn({ waId, docType }, 'running extraction has no status url; requeued');
    await updateUpload(waId, docType, uploadId, {
      'ocr.status': 'queued',
      'ocr.claimedAt': undefined,
    });
    return;
  }

  const { job, retryAfterMs } = await pollOcrJob(ocr.statusUrl);

  const common = { waId, docType, uploadId: uploadId.toHexString(), jobId: job.job_id };

  if (job.status === 'queued' || job.status === 'running') {
    // Still working. The service's own schedule is preferred over ours.
    const delay = nextPollDelayMs({ job, retryAfterMs, previousDelayMs: 0 });

    if (hasOutlivedItsDeadline(ocr, job)) {
      logger.error({ ...common, attempts: job.attempts }, 'ocr job exceeded its deadline');
      await applyFailedExtraction({
        waId,
        docType,
        uploadId,
        candidateId,
        error: 'extraction did not finish within the job deadline',
      });
      return;
    }

    await updateUpload(waId, docType, uploadId, {
      'ocr.attempts': job.attempts,
      'ocr.maxAttempts': job.max_attempts,
      'ocr.nextPollAt': new Date(Date.now() + delay),
      'ocr.claimedAt': undefined,
    });
    logger.debug({ ...common, status: job.status, nextPollMs: delay }, 'ocr job still working');
    return;
  }

  if (job.status === 'succeeded') {
    if (job.result === undefined || job.result === null) {
      logger.error(common, 'ocr job succeeded with no result payload');
      await applyFailedExtraction({
        waId,
        docType,
        uploadId,
        candidateId,
        error: 'extraction succeeded but returned no result',
      });
      return;
    }

    let outcome: OcrOutcome;
    try {
      // The same normalisers the synchronous path uses, on the same payload
      // shape. `result` carries exactly what `/v1/{mode}/extract` returned.
      outcome = NORMALISERS[extractor](job.result, docType, ocr.inspection);
    } catch (err) {
      logger.error({ ...common, err }, 'ocr result could not be normalised');
      await applyFailedExtraction({
        waId,
        docType,
        uploadId,
        candidateId,
        error: `extraction result was malformed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    await recordOcrJob({
      wamid: wamidOf(doc),
      mediaId: doc.mediaId,
      status: 'succeeded',
      ocrMode: extractor,
      jobId: job.job_id,
      attempts: job.attempts,
    });

    await applySuccessfulExtraction({
      waId,
      docType,
      uploadId,
      candidateId,
      extractor,
      doc,
      outcome,
      startedAt: ocr.startedAt,
    });
    return;
  }

  /* job.status === 'failed' */
  if (shouldRetryFailedJob(job)) {
    try {
      const accepted = await retryFailedJob(job.job_id);
      // The retry may issue a different job id, so whatever came back is stored
      // rather than assuming the old one still applies.
      await updateUpload(waId, docType, uploadId, {
        'ocr.jobId': accepted.job_id,
        'ocr.statusUrl': accepted.status_url,
        'ocr.status': 'running',
        'ocr.nextPollAt': new Date(Date.now() + config.VERIS_OCR_POLL_MIN_MS),
        'ocr.claimedAt': undefined,
      });
      await recordOcrJob({
        wamid: wamidOf(doc),
        mediaId: doc.mediaId,
        status: 'running',
        ocrMode: extractor,
        jobId: accepted.job_id,
      });
      logger.info({ ...common, newJobId: accepted.job_id }, 'ocr job retried');
      return;
    } catch (err) {
      logger.warn({ ...common, err }, 'ocr retry was refused; treating as terminal');
    }
  }

  logger.error(
    { ...common, code: job.error?.code, retryable: job.error?.retryable },
    'ocr job failed',
  );
  await recordOcrJob({
    wamid: wamidOf(doc),
    mediaId: doc.mediaId,
    status: 'review',
    ocrMode: extractor,
    jobId: job.job_id,
    attempts: job.attempts,
    error: job.error?.code,
  });
  await applyFailedExtraction({
    waId,
    docType,
    uploadId,
    candidateId,
    error: job.error ? `${job.error.code}: ${job.error.message}` : 'extraction failed',
  });
}

/**
 * Whether an unfinished job has been unfinished for too long.
 *
 * Not a plain wall-clock deadline. Veris runs its own retries and says so, and
 * a job inside that budget with a scheduled next attempt is working rather than
 * stuck — abandoning it would discard an extraction about to arrive. The
 * deadline only bites once the service has stopped saying it will try again,
 * which is the only case where nothing else will ever release the candidate.
 */
function hasOutlivedItsDeadline(ocr: UploadOcr, job: JobResponse, now = new Date()): boolean {
  if (serviceStillWorking(job, now)) return false;
  const since = ocr.submittedAt ?? ocr.startedAt;
  if (!since) return false;
  return now.getTime() - since.getTime() > config.VERIS_OCR_JOB_TIMEOUT_MS;
}

/**
 * One pass over every extraction that is not finished.
 *
 * Submits what is queued, polls what is running, and acts on what has become
 * terminal. Each upload is claimed first, so two ticks — or two processes —
 * cannot both drive the same extraction and answer the candidate twice.
 *
 * Work runs at the OCR pool's own concurrency, because that is the number that
 * was chosen to describe how much extraction traffic this instance should have
 * in flight, and it means the sweep does not need a second one.
 */
export async function sweepRunningExtractions(): Promise<void> {
  if (!config.VERIS_OCR_ASYNC) return;

  const due = await dueExtractions({ staleClaimMs: config.OCR_CLAIM_STALE_MS });
  if (!due.length) return;

  const width = Math.max(1, config.QUEUE_CONCURRENCY_OCR);

  for (let i = 0; i < due.length; i += width) {
    await Promise.all(due.slice(i, i + width).map((item) => driveExtraction(item)));
  }
}

/** One claimed extraction, moved along by exactly one worker. */
async function driveExtraction(item: DueExtraction): Promise<void> {
  const claimed = await claimExtraction({
    waId: item.waId,
    docType: item.docType,
    uploadId: item.uploadId,
    staleClaimMs: config.OCR_CLAIM_STALE_MS,
  });
  // Someone else has it. Not an error, and the whole point of the claim.
  if (!claimed) return;

  let released = false;

  try {
    const doc = await findUpload(item.waId, item.docType, item.uploadId);
    if (!doc) return;

    const record = await documentsFor(item.waId, item.docType);
    const candidateId = record?.candidateId;
    if (!candidateId) {
      logger.warn({ waId: item.waId, docType: item.docType }, 'extraction for an upload with no candidate');
      return;
    }

    const extractor = requirementFor(item.docType)?.ocr;
    if (!extractor || extractor === 'none') return;

    const shared = {
      waId: item.waId,
      docType: item.docType,
      uploadId: item.uploadId,
      candidateId,
      extractor,
      doc,
    };

    // Both of these clear the claim themselves when they reach a terminal state
    // or reschedule, so releasing again below would be wrong.
    released = true;
    if (doc.ocr?.status === 'queued') await submitExtraction(shared);
    else await pollExtraction(shared);
  } catch (err) {
    logger.error(
      { err, waId: item.waId, docType: item.docType, uploadId: item.uploadId.toHexString() },
      'extraction sweep failed for one upload',
    );
    released = false;
  } finally {
    // Anything that did not reach a decision gives the claim back, so the next
    // tick can try rather than waiting for the claim to go stale.
    if (!released) {
      await releaseExtraction(item.waId, item.docType, item.uploadId).catch(() => undefined);
    }
  }
}
