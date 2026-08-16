/**
 * Turning an extracted CV into profile fields (§5).
 *
 * The point of this file is the rule in §1: never ask again for information the
 * CV already gave us. Everything mapped here is a question the candidate does
 * not have to answer, which is most of the difference between a registration
 * that takes seven questions and one that takes twenty.
 *
 * Everything written from here is marked `source: 'cv'` and unverified. §27 is
 * explicit that CV data is not verified identity information — it is good enough
 * to skip a question and to give staff something to work from, and not good
 * enough to act on.
 */

import type { CandidateProfile, OcrField } from '../db/models.js';

/** Field keys the resume extractor emits, as normalised in ocr/veris.ts. */
type ResumeFields = Record<string, string[]>;

function collect(fields: OcrField[]): ResumeFields {
  const out: ResumeFields = {};
  for (const field of fields) {
    const value = field.value?.trim();
    if (!value) continue;
    (out[field.key] ??= []).push(value);
  }
  return out;
}

const first = (fields: ResumeFields, key: string): string | undefined => fields[key]?.[0];

/* ─────────────────────────────────────────────────────────────────────────────
 * Normalisers
 * ───────────────────────────────────────────────────────────────────────────*/

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Normalises the date formats a CV actually contains to YYYY-MM-DD.
 *
 * Indian CVs write DD/MM/YYYY. `15/08/1995` is 15 August, never 8 March. Where
 * both numbers could be a month the day-first reading is taken, because that is
 * what the candidates writing these CVs mean.
 */
export function normaliseDate(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const text = input.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${pad(iso[2]!)}-${pad(iso[3]!)}`;

  const numeric = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = fullYear(Number(numeric[3]));
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  const named = /^(\d{1,2})[\s\-]([a-z]{3,})[\s\-,]*(\d{2,4})$/i.exec(text);
  if (named) {
    const month = MONTHS[named[2]!.slice(0, 3).toLowerCase()];
    if (month) return `${fullYear(Number(named[3]))}-${pad(month)}-${pad(Number(named[1]))}`;
  }

  return undefined;
}

const pad = (n: number | string): string => String(n).padStart(2, '0');

function fullYear(year: number): number {
  if (year > 1900) return year;
  // A two-digit year in a date of birth is last century. Nobody applying for
  // overseas work was born in 2050.
  return year > 30 ? 1900 + year : 2000 + year;
}

/** MM/YYYY, the form §12 asks for. */
export function normaliseMonthYear(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const iso = normaliseDate(input);
  if (iso) {
    const [year, month] = iso.split('-');
    return `${month}/${year}`;
  }
  const short = /^(\d{1,2})[\/\-.](\d{4})$/.exec(input.trim());
  return short ? `${pad(short[1]!)}/${short[2]}` : undefined;
}

/** "6 years 3 months", "6.5 yrs", "72 months" -> 6.25 */
export function parseYears(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const text = input.toLowerCase();

  const years = /(\d+(?:\.\d+)?)\s*(?:\+)?\s*(?:years?|yrs?|y\b|ஆண்ட|साल|वर्ष)/.exec(text);
  const months = /(\d+)\s*(?:months?|mos?\b|மாத|महीन|माह)/.exec(text);

  if (!years && !months) {
    const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
    return bare ? Number(bare[1]) : undefined;
  }

  const total = (years ? Number(years[1]) : 0) + (months ? Number(months[1]) / 12 : 0);
  return total > 0 && total < 60 ? Math.round(total * 100) / 100 : undefined;
}

/** The band §7 offers, derived from an exact figure so both are stored. */
export function experienceBand(years: number | undefined): string | undefined {
  if (years === undefined) return undefined;
  if (years < 0.5) return 'fresher';
  if (years < 2) return 'below_2';
  if (years < 5) return '2_5';
  if (years <= 10) return '5_10';
  return 'above_10';
}

const EDUCATION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(b\.?e\.?|b\.?tech|m\.?tech|b\.?sc|m\.?sc|b\.?com|m\.?com|b\.?a\b|m\.?a\b|mba|bca|mca|degree|graduat|bachelor|master)/i, 'graduate'],
  [/\bdiploma\b/i, 'diploma'],
  [/\b(iti|i\.t\.i)\b/i, 'iti'],
  [/\b(12th|xii|higher secondary|hsc|intermediate|\+2)\b/i, 'class_12'],
  [/\b(10th|x\b|sslc|matric|secondary)\b/i, 'class_10'],
];

export function normaliseEducation(input: string | undefined): string | undefined {
  if (!input) return undefined;
  for (const [pattern, id] of EDUCATION_PATTERNS) {
    if (pattern.test(input)) return id;
  }
  return undefined;
}

/**
 * Indian states and union territories, for splitting a CV address into the
 * fields matching filters on (§6). Matching on the state is what makes an
 * address useful; the rest of the line is kept as the city.
 */
const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Orissa', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Tamilnadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Delhi', 'New Delhi', 'Puducherry', 'Pondicherry',
  'Chandigarh', 'Jammu', 'Kashmir', 'Ladakh', 'Andaman', 'Lakshadweep', 'Dadra', 'Daman',
];

export function splitAddress(
  address: string | undefined,
): { city?: string; state?: string; country?: string } | undefined {
  if (!address) return undefined;

  const state = STATES.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(address));
  if (!state) return undefined;

  // Whatever sits immediately before the state is the city, in the address
  // formats CVs use. Postcodes and door numbers are dropped.
  const parts = address
    .split(/[,\n]/)
    .map((part) => part.replace(/\b\d{6}\b/g, '').trim())
    .filter(Boolean);

  const stateIndex = parts.findIndex((part) => new RegExp(state, 'i').test(part));
  const city = stateIndex > 0 ? parts[stateIndex - 1] : undefined;

  return {
    city: city && city.length <= 40 ? city : undefined,
    state,
    country: 'India',
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Mapping
 * ───────────────────────────────────────────────────────────────────────────*/

export interface CvExtraction {
  patch: Partial<CandidateProfile>;
  /** What the CV said about identity, for the §17 comparison. */
  identity: { name?: string; dateOfBirth?: string; fatherName?: string };
}

/**
 * Maps extracted CV fields onto the profile.
 *
 * Deliberately conservative. A field is mapped only where the CV states it
 * plainly; nothing here infers a trade from a job title or a country preference
 * from a work history. §27 forbids inventing candidate information, and a
 * plausible guess in a profile field is exactly that.
 */
export function extractFromCv(ocrFields: OcrField[], ownPhone?: string): CvExtraction {
  const f = collect(ocrFields);
  const patch: Partial<CandidateProfile> = {};

  const name = first(f, 'name');
  if (name) patch.fullName = name;

  const dob = normaliseDate(first(f, 'date_of_birth'));
  if (dob) patch.dateOfBirth = dob;

  const nationality = first(f, 'nationality');
  if (nationality) patch.nationality = nationality;

  const fatherName = first(f, 'father_name');
  if (fatherName) patch.fatherName = fatherName;

  const email = f.email?.find((e) => e.includes('@'));
  if (email) patch.email = email;

  // A second number, only when it is genuinely different from the one they are
  // messaging from.
  const alternate = (f.phone ?? []).find((phone) => {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 10 && !!ownPhone && !ownPhone.endsWith(digits.slice(-10));
  });
  if (alternate) patch.alternateNumber = alternate;

  const education = normaliseEducation(first(f, 'highest_qualification'));
  if (education) patch.education = education;

  const designation = first(f, 'designation');
  // §9: this is what they currently do. It is never copied into what they want.
  if (designation) patch.currentOccupation = designation;

  const totalYears =
    parseYears(first(f, 'total_experience_human')) ??
    parseYears(first(f, 'total_experience_years'));
  if (totalYears !== undefined) {
    patch.totalExperienceYears = totalYears;
    patch.totalExperienceBand = experienceBand(totalYears);
  }

  const indiaYears = parseYears(first(f, 'indian_experience_human'));
  if (indiaYears !== undefined) patch.indiaExperienceYears = indiaYears;

  const overseasYears = parseYears(first(f, 'overseas_experience_human'));
  if (overseasYears !== undefined && overseasYears > 0) {
    patch.overseasExperienceYears = overseasYears;
    // Unlocks the "which countries have you worked in?" question in §7, which is
    // asked only of candidates whose overseas experience is already on record.
    patch.hasOverseasExperience = true;
  }

  const address = splitAddress(first(f, 'address'));
  if (address?.state) {
    patch.currentState = address.state;
    if (address.city) patch.currentCity = address.city;
    patch.currentCountry = address.country;
  }

  const skills = first(f, 'skills');
  if (skills) {
    patch.skills = skills
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1)
      .slice(0, 40);
  }

  // Recorded, but the candidate is still asked whether their passport is valid
  // (§12). A passport number on a CV written three years ago says nothing about
  // whether it is in date today.
  const passportNumber = first(f, 'passport_number');
  if (passportNumber) patch.passportNumber = passportNumber;

  const passportExpiry = normaliseMonthYear(first(f, 'passport_expiry'));
  if (passportExpiry) patch.passportExpiry = passportExpiry;

  return {
    patch,
    identity: { name, dateOfBirth: dob, fatherName },
  };
}

/**
 * Pulls identity fields out of a passport, Aadhaar or PAN extraction, for the
 * §17 comparison. Extraction keys vary by extractor, so several are tried.
 */
export function identityFromDocument(ocrFields: OcrField[]): {
  name?: string;
  dateOfBirth?: string;
  fatherName?: string;
  number?: string;
} {
  const f = collect(ocrFields);
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const hit = Object.keys(f).find((k) => k.toLowerCase().replace(/[\s_-]/g, '') === key);
      if (hit) return f[hit]![0];
    }
    return undefined;
  };

  return {
    name: pick('name', 'fullname', 'givenname', 'surname', 'holdername'),
    dateOfBirth: normaliseDate(pick('dateofbirth', 'dob', 'birthdate')),
    fatherName: pick('fathername', 'fathersname', 'guardianname'),
    number: pick('passportnumber', 'documentnumber', 'aadhaarnumber', 'aadharnumber', 'pannumber', 'number'),
  };
}
