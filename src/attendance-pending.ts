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

/**
 * What went wrong with a message that was meant to carry a location.
 *
 * Named by what the bot *observed*, never by what it guesses the employee did.
 * `unreadable` is the important one: a message typed `location` whose
 * coordinates could not be parsed proves only that — not that a live location
 * was shared. It can equally be a truncated payload, a field Meta renamed, or a
 * bug in our own parser, and telling somebody "you shared your live location"
 * in that case sends them to fix something that was never wrong (and, when the
 * fault is ours, blames them for it).
 *
 * A live location is still the usual cause, so it is named in the instructions
 * as guidance. The difference between guidance and a diagnosis is the whole
 * point of splitting these.
 */
export type LocationProblem =
  /** Typed `location`, but no usable latitude/longitude came out of it. */
  | 'unreadable'
  /** A type the Cloud API cannot represent at all. Often a live location. */
  | 'unsupported_type'
  /** Not a location message of any kind — a text, a photo, a sticker. */
  | 'not_a_location';

/** How to send a location that counts. Appended when a command is waiting. */
// The two taps that go wrong, named explicitly. WhatsApp's location screen
// puts "Send your current location" at the top and a list of nearby shops and
// landmarks under it; tapping one of those sends *that place's* coordinates,
// which can be several hundred metres from the person holding the phone and
// arrives here looking exactly like a genuine pin. Live location is the other
// one, and it reaches the Cloud API with no coordinates at all.
const SHARE_CURRENT_LOCATION =
  'Tap "Send location", then "Send your current location" at the top. ' +
  'Do not pick a shop or place name from the list below it, and do not use ' +
  'live location — neither one can be used for attendance.';

/**
 * The same, for somebody with no command on file.
 *
 * Both halves have to be said — the command, then the right kind of location —
 * or they fix one and fall at the other.
 */
const SEND_COMMAND_FIRST =
  'Send "check in" or "check out" first, then share your current location when I ask for it. ' +
  'A live location cannot be used for attendance.';

export const LOCATION_NOT_RECEIVED_MESSAGE = `Location not received. ${SHARE_CURRENT_LOCATION}`;

/**
 * What to tell a staff member whose location did not arrive usably.
 *
 * `pending` is whether a command of theirs is waiting for it, which changes the
 * instruction rather than the diagnosis.
 */
export function locationProblemMessage(problem: LocationProblem, pending: boolean): string {
  const how = pending ? SHARE_CURRENT_LOCATION : SEND_COMMAND_FIRST;
  if (problem === 'unreadable') {
    // Deliberately not "you shared a live location": what is known is that no
    // coordinates could be read out of the message, and that is what is said.
    return `Your location could not be read. ${how}`;
  }
  if (problem === 'unsupported_type') {
    return `That message type cannot be used for attendance. ${how}`;
  }
  return pending ? LOCATION_NOT_RECEIVED_MESSAGE : ATTENDANCE_HELP_MESSAGE;
}

export function locationRequestMessage(command: AttendanceCommand): string {
  const action = command.action === 'check_in' ? 'check in' : 'check out';
  // Addressed by name when one was written, and impersonally when none was.
  // "undefined, tap Send location" is what the template produced before the
  // name became optional.
  const greeting = command.statedName ? `${command.statedName}, t` : 'T';
  return `${greeting}ap "Send location", then "Send your current location" at the top, to complete your ${action}. Do not pick a shop or place name from the list below it — that sends the shop's location, not yours.`;
}

/**
 * What to send a staff member whose message on the attendance line was not a
 * command and not a location.
 *
 * The attendance line is theirs and nothing else answers on it, so the
 * alternative is silence — which is exactly how "attendance is not working"
 * looked from a staff phone: a mistyped word, a greeting, or a command sent
 * after the pending one had expired all produced no reply whatsoever, because
 * the message fell through to the candidate pipeline and the CRM's reply policy
 * suppresses internal numbers. Telling them the format costs one message and
 * ends the guessing.
 */
export const ATTENDANCE_HELP_MESSAGE =
  'To mark attendance, send "check in" or "check out" from this number. ' +
  'I will then ask you to share your current location, which has to be at the office.';

/**
 * What to send when the pin was a place rather than where the sender is.
 *
 * Said plainly, because the person reading it has just shared something they
 * believe is their location and is about to be told it did not count. Naming
 * the two taps is what makes it fixable on the next try rather than a second
 * refusal.
 */
export const PICKED_LOCATION_MESSAGE =
  'That is a saved place, not your current location, so it cannot be used for attendance. ' +
  'Tap "Send location", then "Send your current location" at the top — do not pick a ' +
  'shop or place name from the list, and do not move the map pin. Your command is still ' +
  'waiting, so just send the location again.';

/** The same help, once the sender has shown they are mid-command. */
export const ATTENDANCE_RESEND_MESSAGE =
  'Your attendance command has expired. Send "check in" or "check out" again, ' +
  'then share your current location when I ask for it.';
