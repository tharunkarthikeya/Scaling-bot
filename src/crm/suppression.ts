/**
 * CRM Data Management's bot suppression list.
 *
 * A number on it gets nothing from the bot, on any line: no attendance reply,
 * no agent résumé or question answer, no candidate conversation, no read
 * receipt. `server.ts` checks it before anything else, the agent workers and
 * the candidate engine check it again before they send.
 */
import { crmConfigured, fetchBotSuppressionNumbers } from './client.js';

const REFRESH_MS = 15_000;

let numbers = new Set<string>();
let refreshedAt = 0;
let refreshInFlight: Promise<number> | undefined;

/**
 * The comparable form of a number: its last ten digits, which is the CRM's own
 * rule (`normalize_phone` in `app/db/dedup.py`) and the form the directory is
 * served in. A WhatsApp id has to be cut down the same way to meet it.
 *
 * Expanding stored numbers with the Indian default instead, as this once did,
 * matched only Indian numbers: +971 50 123 4567 is stored as `1501234567`, and
 * no expansion of that ever equals the waId `971501234567`.
 */
export function botSuppressionKey(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : undefined;
}

export function matchesBotSuppression(waId: string, storedNumbers: readonly string[]): boolean {
  const key = botSuppressionKey(waId);
  return !!key && storedNumbers.some((value) => botSuppressionKey(value) === key);
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
      const key = botSuppressionKey(value);
      if (key) next.add(key);
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
 * True when the bot must not answer this number, whichever line it wrote to.
 * Refresh errors deliberately throw so the webhook can be retried instead of
 * letting a suppressed contact through.
 */
export async function isBotSuppressedNumber(waId: string): Promise<boolean> {
  if (!crmConfigured()) return false;
  if (!refreshedAt || Date.now() - refreshedAt >= REFRESH_MS) {
    await refreshBotSuppressionNumbers();
  }
  const key = botSuppressionKey(waId);
  return !!key && numbers.has(key);
}
