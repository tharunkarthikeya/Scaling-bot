import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { storedDocuments, type OcrField } from '../db/models.js';
import { readFile } from '../storage/index.js';
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
  completeness: { complete: boolean; problems: string[]; missingPages?: number[] };
}

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

function normalisePassport(payload: any): OcrOutcome {
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

  return {
    raw: payload,
    fields,
    confidence: overall,
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    completeness: passportCompleteness(payload, mrz, overall),
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
): OcrOutcome['completeness'] {
  const problems: string[] = [];
  const missingPages: number[] = [];

  if (!mrz?.passport_number && !payload?.fields?.length) {
    problems.push('the photo page could not be read');
  } else if (!mrz?.passport_number) {
    problems.push('the passport number was not readable');
  }

  if (mrz?.expiry_date) {
    // MRZ dates are YYMMDD. A passport already expired is not a bad scan, but it
    // is not a usable document either, and staff need to know now.
    const expiry = parseMrzDate(String(mrz.expiry_date));
    if (expiry && expiry.getTime() < Date.now()) problems.push('the passport has expired');
  }

  if (overall !== null && overall < TUNABLES.ocrReviewThreshold) {
    problems.push('some of the text was too unclear to read');
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

  return {
    complete: problems.length === 0,
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

  const reasons: string[] = ['resume extractor returns no confidence scores'];
  if (!payload?.name) reasons.push('no candidate name extracted');
  for (const w of payload?.warnings ?? []) reasons.push(String(w));

  return {
    raw: payload,
    fields,
    confidence: null,
    // Unscored data is never auto-trusted. A recruiter confirms it once; the
    // CRM shows it as unverified until then.
    needsReview: true,
    reviewReasons: reasons,
    // A CV is never sent back to be re-taken. Whatever it yields skips a
    // question, and whatever it does not, the flow simply asks (§5).
    completeness: { complete: true, problems: [] },
  };
}

function normaliseDocument(payload: any): OcrOutcome {
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
  if (!fields.length) problems.push('nothing could be read from the image');
  else if (overall !== null && overall < TUNABLES.ocrReviewThreshold) {
    problems.push('the text was too unclear to read');
  }

  const unreadablePages = (payload?.pages ?? [])
    .filter(
      (p: any) =>
        typeof p?.average_confidence === 'number' &&
        p.average_confidence < TUNABLES.ocrReviewThreshold,
    )
    .map((p: any) => p.page_number)
    .filter((n: unknown): n is number => typeof n === 'number');

  return {
    raw: payload,
    fields,
    confidence: overall,
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    completeness: {
      complete: problems.length === 0,
      problems,
      ...(unreadablePages.length ? { missingPages: unreadablePages } : {}),
    },
  };
}

const NORMALISERS: Record<Extractor, (payload: any) => OcrOutcome> = {
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
}): Promise<OcrOutcome> {
  const route = ROUTES[params.extractor];

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

    return NORMALISERS[params.extractor](JSON.parse(text));
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
    await resumeAfterDocument(doc.candidateId, doc.docType, { complete: true, problems: [] });
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

    if (Object.keys(patch).length) {
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
    await markSlotFromOcr(doc.candidateId, doc.docType, 'ocr_failed');
    await resumeAfterDocument(doc.candidateId, doc.docType, {
      complete: true,
      problems: ['extraction failed; needs a manual check'],
    });
  }
}
