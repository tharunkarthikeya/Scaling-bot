import type { Collection, Document, WithId } from 'mongodb';
import { logger } from '../logger.js';
import {
  normalizeAadhaarNumber,
  normalizeContactNumber,
  normalizePassportNumber,
  type CandidateContact,
} from '../identity.js';

type CandidateRow = WithId<Document>;

export interface AtsIdentityKeys {
  passport?: string;
  aadhaar?: string;
  contacts: CandidateContact[];
  waId: string;
}

export interface AtsIdentityResolution {
  status: 'matched' | 'new' | 'conflict';
  matchedBy?: 'passport' | 'aadhaar' | 'phone';
  target?: CandidateRow;
  conflictType?: 'duplicate_passport' | 'duplicate_aadhaar' | 'aadhaar_passport_mismatch';
  conflicts?: CandidateRow[];
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function at(row: Document, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, row);
}

function firstNormalized(
  row: Document,
  paths: string[],
  normalize: (value: unknown) => string | undefined,
): string | undefined {
  for (const path of paths) {
    const value = at(row, path);
    for (const item of Array.isArray(value) ? value : [value]) {
      const normalized = normalize(item);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

const PASSPORT_PATHS = [
  'passportNumberNormalized',
  'normalizedPassportNumber',
  'passportNumber',
  'passport_number',
  'profile.passportNumber',
  'profile.passport_number',
];

const AADHAAR_PATHS = [
  'aadhaarNumberNormalized',
  'normalizedAadhaarNumber',
  'aadhaarNumber',
  'aadhaar_number',
  'profile.aadhaarNumber',
  'profile.aadhaar_number',
];

export function passportKeyOf(row: Document): string | undefined {
  return firstNormalized(row, PASSPORT_PATHS, normalizePassportNumber);
}

export function aadhaarKeyOf(row: Document): string | undefined {
  return firstNormalized(row, AADHAAR_PATHS, normalizeAadhaarNumber);
}

export function contactKeysOf(row: Document): string[] {
  const values: unknown[] = [
    row.waId,
    row.phone,
    row.mobileNumber,
    row.alternateNumber,
    row.contactNumbers,
    row.contactNumbersNormalized,
    row.waIds,
    at(row, 'profile.phone'),
    at(row, 'profile.phone_e164'),
    at(row, 'profile.phone_numbers'),
  ];
  const normalized = values.flatMap(strings).map(normalizeContactNumber).filter(Boolean) as string[];
  return [...new Set(normalized)];
}

function matches(rows: CandidateRow[], key: string | undefined, read: (row: Document) => string | undefined) {
  return key ? rows.filter((row) => read(row) === key) : [];
}

function uniqueRows(rows: CandidateRow[]): CandidateRow[] {
  return [...new Map(rows.map((row) => [row._id.toString(), row])).values()];
}

/**
 * Resolve a CRM/ATS candidate before any insert. Passport is absolute; Aadhaar
 * can fill a passport-less record, and phone is used only when no strong
 * identifier disagrees. Names are intentionally never read here.
 */
export async function resolveAtsCandidate(
  collection: Collection<Document>,
  incoming: AtsIdentityKeys,
): Promise<AtsIdentityResolution> {
  // Include legacy rows which predate normalized identity columns. This is a
  // correctness scan: otherwise "z 123-4567" and "Z1234567" can coexist until
  // the old row happens to be rewritten.
  const rows = await collection.find({}).toArray();

  const passportMatches = matches(rows, incoming.passport, passportKeyOf);
  if (passportMatches.length > 1) {
    return {
      status: 'conflict',
      conflictType: 'duplicate_passport',
      conflicts: uniqueRows(passportMatches),
    };
  }
  if (passportMatches.length === 1) {
    const target = passportMatches[0]!;
    const targetAadhaar = aadhaarKeyOf(target);
    return {
      status: 'matched',
      matchedBy: 'passport',
      target,
      ...(incoming.aadhaar && targetAadhaar && incoming.aadhaar !== targetAadhaar
        ? { conflictType: 'aadhaar_passport_mismatch' as const, conflicts: [target] }
        : {}),
    };
  }

  const aadhaarMatches = matches(rows, incoming.aadhaar, aadhaarKeyOf);
  if (aadhaarMatches.length > 1) {
    // A new passport remains a distinct identity. Without one, duplicate
    // Aadhaar rows are ambiguous and no record may be chosen automatically.
    return incoming.passport
      ? {
          status: 'new',
          conflictType: 'duplicate_aadhaar',
          conflicts: uniqueRows(aadhaarMatches),
        }
      : {
          status: 'conflict',
          conflictType: 'duplicate_aadhaar',
          conflicts: uniqueRows(aadhaarMatches),
        };
  }
  if (aadhaarMatches.length === 1) {
    const target = aadhaarMatches[0]!;
    const targetPassport = passportKeyOf(target);
    if (incoming.passport && targetPassport && incoming.passport !== targetPassport) {
      return {
        status: 'new',
        conflictType: 'aadhaar_passport_mismatch',
        conflicts: [target],
      };
    }
    return { status: 'matched', matchedBy: 'aadhaar', target };
  }

  const contactKeys = new Set(incoming.contacts.map((contact) => contact.normalized));
  const phoneMatches = rows.filter((row) => contactKeysOf(row).some((key) => contactKeys.has(key)));
  const eligible = phoneMatches.filter((row) => {
    const existingPassport = passportKeyOf(row);
    if (incoming.passport && existingPassport && incoming.passport !== existingPassport) return false;
    const existingAadhaar = aadhaarKeyOf(row);
    if (incoming.aadhaar && existingAadhaar && incoming.aadhaar !== existingAadhaar) return false;
    return true;
  });

  // Phone is only a fallback. If it names several records, choosing one would
  // be a merge decision; a new strong identity is safer than a silent merge.
  if (eligible.length === 1) return { status: 'matched', matchedBy: 'phone', target: eligible[0] };
  return { status: 'new' };
}

function mergedContacts(existing: Document | undefined, incoming: CandidateContact[]): CandidateContact[] {
  const merged = new Map<string, CandidateContact>();
  const old = Array.isArray(existing?.contacts) ? existing.contacts : [];
  const legacy: CandidateContact[] = existing
    ? contactKeysOf(existing).map((normalized) => ({
        number: `+${normalized}`,
        normalized,
        sources: ['whatsapp'],
      }))
    : [];
  for (const value of [...legacy, ...old, ...incoming]) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Partial<CandidateContact>;
    const normalized = normalizeContactNumber(row.normalized ?? row.number);
    if (!normalized) continue;
    const sources = Array.isArray(row.sources) ? row.sources : [];
    const current = merged.get(normalized);
    if (current) {
      for (const source of sources) {
        if (!current.sources.includes(source)) current.sources.push(source);
      }
    } else {
      merged.set(normalized, {
        number: typeof row.number === 'string' ? row.number : `+${normalized}`,
        normalized,
        sources: [...sources],
      });
    }
  }
  return [...merged.values()];
}

async function flagConflict(
  collection: Collection<Document>,
  rows: CandidateRow[],
  resolution: AtsIdentityResolution,
  incoming: AtsIdentityKeys,
): Promise<void> {
  if (!resolution.conflictType || !rows.length) return;
  const at = new Date();
  const recordIds = rows.map((row) => row._id.toString());
  await collection.updateMany(
    { _id: { $in: rows.map((row) => row._id) } },
    {
      $set: {
        manualReviewRequired: true,
        identityConflict: {
          status: 'open',
          type: resolution.conflictType,
          candidateRecordIds: recordIds,
          incomingWaId: incoming.waId,
          detectedAt: at,
        },
      },
    },
  );
  logger.warn(
    { conflictType: resolution.conflictType, candidates: rows.length },
    'candidate identity conflict flagged for manual review',
  );
}

/** Writes one exported candidate according to the resolution above. */
export async function writeResolvedAtsCandidate(params: {
  collection: Collection<Document>;
  row: Record<string, unknown>;
  identity: AtsIdentityKeys;
}): Promise<AtsIdentityResolution> {
  const { collection, identity } = params;
  const resolution = await resolveAtsCandidate(collection, identity);
  const conflicts = resolution.conflicts ?? [];

  if (resolution.status === 'conflict') {
    await flagConflict(collection, conflicts, resolution, identity);
    return resolution;
  }

  const target = resolution.target;
  const contacts = mergedContacts(target, identity.contacts);
  const waIds = [...new Set([
    ...strings(target?.waIds),
    ...(typeof target?.waId === 'string' ? [target.waId] : []),
    identity.waId,
  ])];
  const row = {
    ...params.row,
    ...(target?.waId ? { waId: target.waId } : {}),
    waIds,
    contacts,
    contactNumbers: contacts.map((contact) => contact.number),
    contactNumbersNormalized: contacts.map((contact) => contact.normalized),
    passportNumberNormalized: identity.passport,
    aadhaarNumberNormalized: identity.aadhaar,
  };

  let written: CandidateRow;
  if (target) {
    await collection.updateOne({ _id: target._id }, { $set: row });
    written = { ...target, ...row } as CandidateRow;
  } else {
    const result = await collection.insertOne(row);
    written = { _id: result.insertedId, ...row } as CandidateRow;
  }

  if (resolution.conflictType) {
    const all = uniqueRows([...conflicts, written]);
    await flagConflict(collection, all, resolution, identity);
  }
  return { ...resolution, target: written };
}
