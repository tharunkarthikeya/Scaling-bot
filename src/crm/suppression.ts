/** Global CRM-managed deny-list for inbound candidate automation. */
import { sourcingPhoneKeys } from '../ats/sourcingGuard.js';
import { crmConfigured, fetchBotSuppressionNumbers } from './client.js';

const REFRESH_MS = 15_000;

let numbers = new Set<string>();
let refreshedAt = 0;
let refreshInFlight: Promise<number> | undefined;

export function matchesBotSuppression(waId: string, storedNumbers: readonly string[]): boolean {
  const stored = new Set(storedNumbers.flatMap((value) => sourcingPhoneKeys(value)));
  return sourcingPhoneKeys(waId).some((key) => stored.has(key));
}

export async function refreshBotSuppressionNumbers(): Promise<number> {
  if (!crmConfigured()) {
    numbers = new Set();
    refreshedAt = Date.now();
    return 0;
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const next = new Set<string>();
    for (const value of await fetchBotSuppressionNumbers()) {
      for (const key of sourcingPhoneKeys(value)) next.add(key);
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
 * True when this sender must be ignored, regardless of which bot line received
 * the webhook. Refresh errors deliberately throw so the webhook can be retried
 * instead of allowing a suppressed contact through.
 */
export async function isBotSuppressedNumber(waId: string): Promise<boolean> {
  if (!crmConfigured()) return false;
  if (!refreshedAt || Date.now() - refreshedAt >= REFRESH_MS) {
    await refreshBotSuppressionNumbers();
  }
  return sourcingPhoneKeys(waId).some((key) => numbers.has(key));
}
