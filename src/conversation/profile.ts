/**
 * Writing to a candidate's profile, and the checks that read back off it.
 *
 * Two rules from §27 are enforced here rather than remembered:
 *
 *   Every value records where it came from — CV, chat, document, or staff — and
 *   keeps the candidate's own wording next to the standardised value.
 *
 *   A value that came from a CV is not verified identity information. It is
 *   recorded, it is used to avoid asking the same question twice, and it is
 *   marked unverified until a person confirms it.
 */

import type {
  CandidateDoc,
  CandidateProfile,
  FieldMeta,
  FieldSource,
  ProfileChange,
} from '../db/models.js';
import { TUNABLES } from './rules.js';

export interface ProfileWrite {
  /** Mongo $set operations, ready to apply. */
  set: Record<string, unknown>;
  /** Entries to push onto the change log. */
  changes: ProfileChange[];
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Values a model or an extractor offers instead of leaving a field out. A
 * placeholder written into a CRM field is worse than an absent one — it reads
 * as an answer and stops anyone asking the question.
 */
const PLACEHOLDER =
  /^(not\s+(yet\s+)?(provided|given|stated|specified|mentioned|known|available)|unknown|unspecified|none|nil|n\/?a|null|-+|\.+)$/i;

export function isPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER.test(value.trim());
}

/**
 * Builds the write for a set of profile changes.
 *
 * `existing` values are only overwritten when the new value comes from a source
 * at least as trustworthy, or when the candidate is explicitly editing. A CV
 * extraction never silently overwrites something the candidate typed.
 */
export function buildProfileWrite(
  candidate: CandidateDoc,
  patch: Partial<CandidateProfile>,
  options: {
    source: FieldSource;
    /** The candidate's exact wording, when this came from something they said. */
    raw?: string;
    confidence?: number | null;
    /** Set when the candidate is deliberately changing an answer (§18, §22). */
    overwrite?: boolean;
  },
): ProfileWrite {
  const now = new Date();
  const set: Record<string, unknown> = {};
  const changes: ProfileChange[] = [];

  const profile = candidate.profile ?? {};
  const meta = candidate.fieldMeta ?? {};

  for (const [field, value] of Object.entries(patch)) {
    if (isEmpty(value) || isPlaceholder(value)) continue;

    const current = profile[field];
    const currentSource = meta[field]?.source;

    if (!isEmpty(current) && !options.overwrite) {
      // Something a candidate said in chat outranks something read off a
      // document. They are the authority on their own details; OCR is a guess.
      //
      // Both document sources are covered, not just the CV. A passport now
      // supplies the legal name (`profileFromIdentityDocument`), and a
      // misread letter in an MRZ must not quietly replace a name the candidate
      // typed out themselves — §17 exists to flag that disagreement for a
      // person, and it cannot flag what has already been overwritten.
      const incomingIsWeaker =
        (options.source === 'cv' || options.source === 'document') && currentSource === 'chat';
      if (incomingIsWeaker) continue;
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
    }

    set[`profile.${field}`] = value;

    const fieldMeta: FieldMeta = {
      source: options.source,
      at: now,
      ...(options.raw ? { raw: options.raw } : {}),
      ...(options.confidence !== undefined ? { confidence: options.confidence } : {}),
      // Only a person marks something verified. Nothing here ever does (§27).
      verified: false,
    };
    set[`fieldMeta.${field}`] = fieldMeta;

    changes.push({ field, from: current, to: value, source: options.source, at: now });

    // Keep the in-memory copy in step, so later steps in the same turn see it.
    profile[field] = value;
    meta[field] = fieldMeta;
  }

  candidate.profile = profile;
  candidate.fieldMeta = meta;

  return { set, changes };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Derived values
 * ───────────────────────────────────────────────────────────────────────────*/

/** Age in whole years. Derived from date of birth, never asked for (§6). */
export function ageFrom(dateOfBirth: string | undefined, on = new Date()): number | undefined {
  if (!dateOfBirth) return undefined;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return undefined;

  let age = on.getFullYear() - dob.getFullYear();
  const monthDelta = on.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && on.getDate() < dob.getDate())) age -= 1;

  return age >= 0 && age < 120 ? age : undefined;
}

/** Parses the MM/YYYY the candidate gives for passport expiry. */
export function parseMonthYear(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{1,2})\s*[\/\-.]\s*(\d{4})$/.exec(value.trim());
  if (!match) return undefined;

  const month = Number(match[1]);
  const year = Number(match[2]);
  if (month < 1 || month > 12) return undefined;

  // Last day of that month — a passport is valid through its expiry month.
  return new Date(year, month, 0, 23, 59, 59);
}

/**
 * Passports expiring within the warning window are flagged for staff (§12).
 * Returns undefined when there is no usable expiry date, which is not the same
 * as "not expiring soon" and must not be treated as an all-clear.
 */
export function passportExpiryFlag(
  profile: CandidateProfile,
  now = new Date(),
): { expired: boolean; expiringSoon: boolean; monthsRemaining: number } | undefined {
  const expiry = parseMonthYear(profile.passportExpiry);
  if (!expiry) return undefined;

  const monthsRemaining =
    (expiry.getFullYear() - now.getFullYear()) * 12 + (expiry.getMonth() - now.getMonth());

  return {
    expired: expiry.getTime() < now.getTime(),
    expiringSoon: monthsRemaining <= TUNABLES.passportExpiryWarningMonths,
    monthsRemaining,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Identity comparison (§17)
 *
 * The point of this is *not* to reject anyone. §17 is explicit that a spelling
 * difference must never auto-reject a candidate, and that a mismatch goes to the
 * documentation team rather than into a WhatsApp interrogation. So this
 * classifies a difference as either negligible or worth a human look — and
 * nothing more happens automatically either way.
 * ───────────────────────────────────────────────────────────────────────────*/

function nameTokens(name: string): string[] {
  return name
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .sort();
}

/** Levenshtein distance, iterative and allocation-light. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length]!;
}

/**
 * Whether two names are the same name.
 *
 * MOHAMED YOOSUF and MOHAMMED YOOSUF are the same person spelled two ways, and
 * transliterated Indian names vary like this constantly — a doubled consonant, a
 * dropped vowel, an initial written out in full. The tolerance scales with token
 * length so short tokens are not matched to each other by accident.
 */
export function namesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;

  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length) return false;

  // Compare the tokens they have in common; one document carrying a middle name
  // the other omits is normal and is not a mismatch.
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;

  let matched = 0;
  const unused = [...longer];

  for (const token of shorter) {
    const index = unused.findIndex((other) => {
      const tolerance = Math.floor(Math.max(token.length, other.length) / 4);
      return editDistance(token, other) <= Math.max(1, tolerance);
    });
    if (index >= 0) {
      matched += 1;
      unused.splice(index, 1);
    }
  }

  return matched === shorter.length;
}

export interface IdentityComparison {
  consistent: boolean;
  /** Human-readable differences, for staff. Never sent to the candidate. */
  differences: string[];
}

/**
 * Compares the identity fields across every source we hold (§17).
 *
 * `sources` is a map of label -> what that source says, e.g.
 * `{ CV: { name: 'MOHAMED YOOSUF' }, passport: { name: 'MOHAMMED YOOSUF' } }`.
 */
export function compareIdentity(
  sources: Record<string, { name?: string; dateOfBirth?: string; fatherName?: string }>,
): IdentityComparison {
  const differences: string[] = [];
  const entries = Object.entries(sources).filter(([, v]) => v.name || v.dateOfBirth || v.fatherName);

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [leftLabel, left] = entries[i]!;
      const [rightLabel, right] = entries[j]!;

      if (left.name && right.name && !namesMatch(left.name, right.name)) {
        differences.push(`name differs between ${leftLabel} and ${rightLabel}`);
      }
      if (left.dateOfBirth && right.dateOfBirth && left.dateOfBirth !== right.dateOfBirth) {
        differences.push(`date of birth differs between ${leftLabel} and ${rightLabel}`);
      }
      if (left.fatherName && right.fatherName && !namesMatch(left.fatherName, right.fatherName)) {
        differences.push(`father's name differs between ${leftLabel} and ${rightLabel}`);
      }
    }
  }

  return { consistent: differences.length === 0, differences };
}
