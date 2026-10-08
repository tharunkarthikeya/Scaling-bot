/**
 * Attendance commands waiting for the sender's location.
 *
 * "Asha - check in" no longer records anything on its own. The bot asks for the
 * sender's current location and keeps the command here. The location that
 * comes back completes it, and the CRM decides whether that spot is close
 * enough to the office.
 *
 * Kept in Redis when there is one, so the location can land on a different
 * instance than the text did. Otherwise kept in this process.
 */

import type { AttendanceCommand } from './attendance.js';
import { key, redisEnabled, sharedRedis } from './redis/index.js';

/** How long a command waits for its location before it has to be sent again. */
export const PENDING_ATTENDANCE_TTL_MS = 10 * 60 * 1000;

export interface PendingAttendance extends AttendanceCommand {
  /** The text command's wamid. */
  commandWamid: string;
}

const local = new Map<string, { value: PendingAttendance; expires: number }>();

function pendingKey(waId: string): string {
  return key('attendance', 'pending', waId);
}

export async function rememberPendingAttendance(waId: string, value: PendingAttendance): Promise<void> {
  if (redisEnabled()) {
    await sharedRedis().set(pendingKey(waId), JSON.stringify(value), 'PX', PENDING_ATTENDANCE_TTL_MS);
    return;
  }
  local.set(waId, { value, expires: Date.now() + PENDING_ATTENDANCE_TTL_MS });
}

export async function pendingAttendance(waId: string): Promise<PendingAttendance | undefined> {
  if (redisEnabled()) {
    const raw = await sharedRedis().get(pendingKey(waId));
    return raw ? (JSON.parse(raw) as PendingAttendance) : undefined;
  }
  const entry = local.get(waId);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    local.delete(waId);
    return undefined;
  }
  return entry.value;
}

export async function forgetPendingAttendance(waId: string): Promise<void> {
  if (redisEnabled()) {
    await sharedRedis().del(pendingKey(waId));
    return;
  }
  local.delete(waId);
}

const answered = new Map<string, number>();

/**
 * True the first time a message is seen. Meta can deliver one message several
 * times within a second, and each delivery must not earn its own reply.
 */
export async function firstAttendanceDelivery(wamid: string): Promise<boolean> {
  if (redisEnabled()) {
    const set = await sharedRedis().set(key('attendance', 'answered', wamid), '1', 'PX', 3_600_000, 'NX');
    return set === 'OK';
  }
  const now = Date.now();
  for (const [id, expires] of answered) if (expires <= now) answered.delete(id);
  if (answered.has(wamid)) return false;
  answered.set(wamid, now + 3_600_000);
  return true;
}

export const LOCATION_NOT_RECEIVED_MESSAGE =
  'Location not received. Tap "Send location" and choose "Send your current location". Live location cannot be used for attendance.';

/** A live location reaches the bot as an "unsupported" message with no coordinates. */
export const LIVE_LOCATION_MESSAGE =
  'You shared your live location. Live location cannot be used for attendance. Please send your current location: tap "Send location" and choose "Send your current location".';

export function locationRequestMessage(command: AttendanceCommand): string {
  const action = command.action === 'check_in' ? 'check in' : 'check out';
  return `${command.statedName}, tap "Send location" and share your current location to complete your ${action}. Attendance is only marked at the office.`;
}
