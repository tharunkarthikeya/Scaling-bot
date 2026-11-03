/**
 * Who may mark attendance, as the CRM says: `GET /attendance/directory`.
 *
 * Used for one decision only — whether a number on the CRM suppression list is
 * still allowed to mark attendance. The suppression list silences the bot's
 * *conversations*: candidate onboarding, agent résumés and questions, read
 * receipts. It must not take an employee's attendance away, and it did: from
 * 2026-11-02 the webhook checked suppression before attendance, and five staff
 * whose phones were also on that list (the whole Royapettah desk bar one) got
 * no reply to "check in" and no punch, so their days filed as absent.
 *
 * The directory is the CRM's own list of active employees on attendance — the
 * same set `POST /attendance/events` resolves a sender against — so the bot
 * does not decide who is staff; it only asks. Refreshed at most every fifteen
 * seconds, like the suppression list, so somebody removed from staff in the CRM
 * stops getting through within that window.
 */
import { crmConfigured, fetchAttendanceContacts } from './client.js';
import { botSuppressionKey } from './suppression.js';

const REFRESH_MS = 15_000;

let numbers = new Set<string>();
let refreshedAt = 0;
let refreshInFlight: Promise<number> | undefined;

async function refresh(): Promise<number> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const contacts = await fetchAttendanceContacts();
    // `readJson` turns every failure into `undefined`. An empty answer here
    // would silently drop staff again, so a failure throws instead and Meta
    // redelivers the message — the same choice the suppression list makes.
    if (!contacts) throw new Error('CRM staff attendance directory could not be read');
    const next = new Set<string>();
    for (const contact of contacts) {
      if (contact.active === false) continue;
      // The CRM compares phones on their last ten digits (`normalize_phone`),
      // which is exactly what the suppression key is.
      const key = botSuppressionKey(contact.phone);
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

/** True when this WhatsApp sender is an active CRM employee on attendance. */
export async function isAttendanceStaffNumber(waId: string): Promise<boolean> {
  if (!crmConfigured()) return false;
  if (!refreshedAt || Date.now() - refreshedAt >= REFRESH_MS) await refresh();
  const key = botSuppressionKey(waId);
  return !!key && numbers.has(key);
}
