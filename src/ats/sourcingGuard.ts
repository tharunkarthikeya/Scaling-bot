/**
 * Stops Sourcing Hub contacts entering the candidate conversation.
 *
 * `sourcing_clients` is shared with the sourcing application, so its historical
 * rows do not all have one schema. Some have `waId`, some have a formatted
 * `phone`, and others carry several numbers in arrays or contact objects. The
 * guard therefore reads every phone-shaped field and keeps one normalized set.
 * Contact type is deliberately irrelevant: agents, clients, associations and
 * any future sourcing type are all excluded.
 */
import type { Document } from 'mongodb';
import { config } from '../config.js';
import { atsCollection, atsConfigured, ATS_COLLECTIONS } from './client.js';

/** A short cache avoids scanning the shared collection for every message. */
const REFRESH_MS = 15_000;

let numbers = new Set<string>();
let refreshedAt = 0;
let refreshInFlight: Promise<number> | undefined;

function compactKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPhoneKey(key: string): boolean {
  const value = compactKey(key);
  return (
    value === 'waid' ||
    value === 'tel' ||
    value === 'number' ||
    value === 'numbers' ||
    value.startsWith('tel') ||
    value.includes('phone') ||
    value.includes('mobile') ||
    value.includes('whatsapp') ||
    value.includes('contactnumber') ||
    value.includes('contactno') ||
    /^(?:primary|secondary|alternate|alternative|additional|other|office|business)(?:number|numbers|no)$/.test(
      value,
    )
  );
}

function isContactContainer(key: string): boolean {
  const value = compactKey(key);
  return value === 'contact' || value === 'contacts' || value.includes('contactperson');
}

/** All comparable E.164-like keys represented by one stored value. */
export function sourcingPhoneKeys(value: unknown): string[] {
  if (typeof value !== 'string' && typeof value !== 'number') return [];

  const raw = String(value);
  const pieces = raw.match(/\+?\d(?:[\d\s().-]{6,}\d)/g) ?? [raw];
  const out = new Set<string>();
  const countryCode = config.STAFF_PHONE_DEFAULT_COUNTRY_CODE.replace(/\D/g, '');

  for (const piece of pieces) {
    let digits = piece.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length < 8 || digits.length > 15) continue;

    out.add(digits);

    // Sourcing staff commonly enter Indian numbers without +91. Use the same
    // configured default already used for CRM staff contacts.
    if (countryCode && digits.length === 10) out.add(`${countryCode}${digits}`);
    if (countryCode && digits.length === 11 && digits.startsWith('0')) {
      out.add(`${countryCode}${digits.slice(1)}`);
    }
  }

  return [...out];
}

/** Reads every number field, including arrays and nested contact-person rows. */
export function sourcingNumbersFrom(row: Document): string[] {
  const out = new Set<string>();

  const visit = (value: unknown, phoneContext: boolean, contactContext: boolean): void => {
    if (value === null || value === undefined) return;

    if (typeof value === 'string' || typeof value === 'number') {
      if (phoneContext) for (const key of sourcingPhoneKeys(value)) out.add(key);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item, phoneContext, contactContext);
      return;
    }

    if (typeof value !== 'object' || value instanceof Date) return;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const directPhone = isPhoneKey(key);
      const nestedContact = contactContext || isContactContainer(key);
      const numberInsideContact = nestedContact && ['number', 'value'].includes(compactKey(key));
      visit(child, phoneContext || directPhone || numberInsideContact, nestedContact);
    }
  };

  visit(row, false, false);
  return [...out];
}

/** Rebuilds the suppression set from every sourcing type and every active row. */
export async function refreshSourcingContactNumbers(): Promise<number> {
  if (!atsConfigured()) {
    numbers = new Set();
    refreshedAt = Date.now();
    return 0;
  }

  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const next = new Set<string>();
    const cursor = atsCollection(ATS_COLLECTIONS.sourcingClients).find({});
    for await (const row of cursor) {
      for (const number of sourcingNumbersFrom(row)) next.add(number);
    }
    numbers = next;
    refreshedAt = Date.now();
    return next.size;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}

/**
 * True for every number present anywhere in `sourcing_clients`.
 *
 * Refresh failures are allowed to throw. The webhook performs this check before
 * claiming the message, so Meta retries later instead of the bot accidentally
 * starting a candidate flow for a sourcing contact while the directory is
 * unavailable.
 */
export async function isSourcingWhatsAppNumber(waId: string): Promise<boolean> {
  if (!atsConfigured()) return false;
  if (!refreshedAt || Date.now() - refreshedAt >= REFRESH_MS) {
    await refreshSourcingContactNumbers();
  }

  return sourcingPhoneKeys(waId).some((key) => numbers.has(key));
}
