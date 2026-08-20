/**
 * Turning a candidate of ours into a candidate of theirs.
 *
 * Written out field by field on purpose. The tempting version of this file is
 * two lines — take the Mongo document, rename a few keys, post it — and that
 * version is wrong in three separate ways:
 *
 *  * It ships whatever happens to be on the record. Aadhaar and PAN numbers
 *    live on our profile and have no business in the CRM; a wholesale copy
 *    sends them, and nobody notices until an audit.
 *  * It couples the two schemas. A field renamed here would silently change
 *    what the CRM receives, and a field added there would appear to be
 *    supported when nothing populates it.
 *  * It hides the semantic mismatches, which are the interesting part. Their
 *    `country` is where a candidate lives; ours records both that and where the
 *    candidate wants to go, and merging the two would put Malaysia in the
 *    residence field of someone sitting in Tamil Nadu.
 *
 * So: an explicit allow-list, with the disagreements written down where they
 * happen.
 */

import { destinationCountryOf } from '../conversation/flow.js';
import type { CandidateDoc } from '../db/models.js';

/** The profile shape `POST /candidates` accepts. Their names, not ours. */
export interface CrmProfile {
  full_name: string;
  phone?: string;
  phone_e164?: string;
  email?: string;
  location?: string;
  city?: string;
  country?: string;
  destination_country?: string;
  job_preference?: string;
  job_category?: string;
  trade_skills?: string[];
  skills?: string[];
  languages?: string[];
  certifications?: string[];
  total_experience_band?: string;
  total_experience_years?: number;
  passport_number?: string;
  passport_expiry?: string;
}

export interface CrmCandidatePayload {
  source: 'whatsapp';
  profile: CrmProfile;
  idempotency_key: string;
  /** What we believe. The CRM decides for itself and may disagree. */
  cv_required_claim?: boolean;
}

/**
 * A stable key for one candidate's submission.
 *
 * Derived from identifiers that do not change — the business phone number the
 * message arrived on, and the candidate's WhatsApp id — rather than generated,
 * so a retry after a crash produces the same key it did the first time. That is
 * what lets the CRM recognise a repeat instead of creating a second candidate.
 */
export function idempotencyKeyFor(candidate: CandidateDoc, phoneNumberId: string): string {
  return `whatsapp/${phoneNumberId}/${candidate.waId}`;
}

/**
 * The candidate's number in international form.
 *
 * `waId` is Meta's identifier and is already the full number in digits, without
 * a leading plus — "919876543210". Adding the plus is the whole conversion; it
 * is what tells the CRM this is an international number rather than a local one
 * whose country nobody recorded, and their cross-country duplicate check reads
 * exactly that distinction.
 */
export function e164From(waId: string): string | undefined {
  const digits = waId.replace(/\D/g, '');
  return digits.length >= 10 ? `+${digits}` : undefined;
}

function trimmed(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function list(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out = values.map((v) => String(v).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * Everything the CRM is given about one candidate.
 *
 * Note what is absent and stays absent: `aadhaarNumber` and `panNumber`. They
 * are on our record because a documentation officer needs them, and the CRM has
 * no screen that shows them and no workflow that reads them. Copying an
 * identifier into a second database for no reason is exposure bought with
 * nothing (§15, §16).
 *
 * The passport *is* sent. Overseas placement turns on whether a passport is in
 * date, and that is a question the CRM is asked.
 */
export function toCrmPayload(
  candidate: CandidateDoc,
  phoneNumberId: string,
): CrmCandidatePayload {
  const p = candidate.profile ?? {};

  const profile: CrmProfile = {
    // Their only required field. Falls back to the WhatsApp display name, and
    // then to the number, because a candidate who reached registration without
    // a readable name is still a person the CRM has to be able to open.
    full_name: trimmed(p.fullName) ?? trimmed(candidate.profileName) ?? candidate.waId,

    phone: e164From(candidate.waId),
    phone_e164: e164From(candidate.waId),

    // Residence. Three fields on our side, and their `location` is the readable
    // one-liner a recruiter actually looks at.
    city: trimmed(p.currentCity),
    country: trimmed(p.currentCountry) ?? 'India',
    location: [trimmed(p.currentCity), trimmed(p.currentState)].filter(Boolean).join(', ') ||
      undefined,

    // Destination, kept strictly apart from residence above. Undefined for
    // candidates whose answer was a region rather than a country — see
    // `destinationCountryOf`, which refuses to invent one.
    destination_country: destinationCountryOf(candidate),

    // What they want, twice over: the controlled value the CV policy reads, and
    // their own words for a person to read (§27).
    job_category: trimmed(p.jobCategory),
    job_preference: trimmed(p.desiredOccupation) ?? trimmed(p.currentOccupation),

    // Machinery first: on a blue-collar profile the machines someone has run
    // are the specific claim, and the general skills list is the fallback.
    trade_skills: list(p.machinery) ?? list(p.skills),
    certifications: list(p.certifications),

    // The band as a band. Never coerced into their numeric field — "3_5" is a
    // range the candidate chose, and turning it into 4.0 would put a figure on
    // the record they never gave. The numeric field is filled only when a CV
    // actually stated one.
    total_experience_band: trimmed(p.totalExperienceBand),
    total_experience_years:
      typeof p.totalExperienceYears === 'number' ? p.totalExperienceYears : undefined,

    passport_number: trimmed(p.passportNumber),
    passport_expiry: trimmed(p.passportExpiry),
  };

  // Undefined keys are dropped rather than sent as nulls: the CRM treats an
  // absent field as "not stated" and a null as "stated to be nothing", and on a
  // re-registration that difference decides whether an existing value survives.
  for (const key of Object.keys(profile) as Array<keyof CrmProfile>) {
    if (profile[key] === undefined) delete profile[key];
  }

  return {
    source: 'whatsapp',
    profile,
    idempotency_key: idempotencyKeyFor(candidate, phoneNumberId),
    ...(typeof p.cvRequired === 'boolean' ? { cv_required_claim: p.cvRequired } : {}),
  };
}
