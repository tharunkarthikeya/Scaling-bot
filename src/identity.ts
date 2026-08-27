import type { CandidateDoc } from './db/models.js';

/** Canonical form used only for equality checks; the original value is retained for display. */
export function normalizePassportNumber(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.length >= 5 ? normalized : undefined;
}

/** Aadhaar identity key. Spaces and punctuation are formatting, not identity. */
export function normalizeAadhaarNumber(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').replace(/\D/g, '');
  return normalized.length === 12 ? normalized : undefined;
}

/**
 * A conservative phone key. It is deliberately weaker than either identity
 * document and is never used when it conflicts with a passport.
 */
export function normalizeContactNumber(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 ? digits : undefined;
}

export interface CandidateContact {
  number: string;
  normalized: string;
  sources: Array<'whatsapp' | 'resume' | 'alternate'>;
}

/** WhatsApp and resume numbers are contacts on one person, not competing identities. */
export function contactsFor(candidate: CandidateDoc): CandidateContact[] {
  const values: Array<{ number: unknown; source: CandidateContact['sources'][number] }> = [
    { number: candidate.waId, source: 'whatsapp' },
    { number: candidate.phone, source: 'whatsapp' },
    { number: candidate.profile?.mobileNumber, source: 'resume' },
    { number: candidate.profile?.alternateNumber, source: 'alternate' },
  ];

  const contacts = new Map<string, CandidateContact>();
  for (const item of values) {
    const normalized = normalizeContactNumber(item.number);
    if (!normalized || typeof item.number !== 'string') continue;
    const current = contacts.get(normalized);
    if (current) {
      if (!current.sources.includes(item.source)) current.sources.push(item.source);
      continue;
    }
    contacts.set(normalized, {
      number: item.number.trim(),
      normalized,
      sources: [item.source],
    });
  }
  return [...contacts.values()];
}

export function contactNumbersFor(candidate: CandidateDoc): string[] | undefined {
  const numbers = contactsFor(candidate).map((contact) =>
    contact.number.startsWith('+') ? contact.number : `+${contact.normalized}`,
  );
  return numbers.length ? numbers : undefined;
}
