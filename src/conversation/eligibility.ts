import type { CandidateDoc } from '../db/models.js';

export type NationalityDecision = 'indian' | 'non_indian' | 'unknown';

/**
 * Interprets only an explicit nationality value extracted from a CV/passport.
 * Missing and boilerplate OCR values remain unknown; they must never reject a
 * candidate. The negative form is checked first so "non Indian" cannot be
 * mistaken for "Indian".
 */
export function nationalityDecision(value: unknown): NationalityDecision {
  if (typeof value !== 'string') return 'unknown';

  const words = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z]+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/^(?:NATIONALITY|CITIZENSHIP)\s+/, '');

  if (!words || /^(?:N A|NA|NONE|UNKNOWN|NOT SPECIFIED|NOT AVAILABLE|UNSPECIFIED)$/.test(words)) {
    return 'unknown';
  }
  if (/\bNON INDIAN\b/.test(words)) return 'non_indian';
  if (/^(?:INDIA|INDIAN|IND|REPUBLIC OF INDIA|INDIAN NATIONAL|INDIAN CITIZEN)$/.test(words)) {
    return 'indian';
  }

  // A real alphabetic value which is not an Indian alias is an explicit
  // non-Indian nationality. Numeric noise and one-character OCR fragments are
  // left unknown so a poor scan cannot terminate a registration.
  return words.replace(/ /g, '').length >= 2 ? 'non_indian' : 'unknown';
}

export function nationalityBlocked(candidate: CandidateDoc): boolean {
  return (
    candidate.nationalityCheck?.status === 'not_eligible' ||
    candidate.stage === 'NOT_ELIGIBLE' ||
    candidate.status === 'not_eligible'
  );
}

/**
 * A CV or passport can be the first place nationality is known. Hold external
 * candidate creation while either extractor is outstanding, otherwise a CV
 * upload could create a partial CRM row milliseconds before its passport page
 * proves the applicant ineligible.
 */
export function nationalityCheckPending(candidate: CandidateDoc): boolean {
  return ['cv', 'passport'].some((kind) => candidate.documents?.[kind]?.status === 'ocr_queued');
}

/**
 * Hard gate used immediately before every external candidate write.
 *
 * In-progress applications wait for a positive Indian result, preventing an
 * answer submitted before the CV from creating a CRM row too early. A finished
 * application with no readable nationality may proceed: all available checks
 * have completed and an absent OCR value is not evidence of ineligibility.
 */
export function externalCandidateDeliveryBlocked(candidate: CandidateDoc): boolean {
  if (nationalityBlocked(candidate) || nationalityCheckPending(candidate)) return true;
  // `enquiry` was optional on older application rows; absence means the
  // original registration branch, not an exemption from this gate.
  if (candidate.enquiry === 'b2b' || candidate.enquiry === 'track' || candidate.enquiry === 'staff') {
    return false;
  }
  if (candidate.stage === 'REGISTRATION_COMPLETED') return false;
  return candidate.nationalityCheck?.status !== 'indian';
}
