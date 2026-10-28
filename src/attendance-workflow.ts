/**
 * Marking attendance over WhatsApp, start to finish.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  EVERY MESSAGE A STAFF MEMBER SENDS ON THIS LINE GETS EXACTLY ONE ANSWER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * That is the whole of what was wrong. The steps themselves worked — the CRM
 * resolves the number, holds the punch to an office radius and files it — but
 * only two of the outcomes were ever spoken back to the employee. Everything
 * else left the attendance line silent:
 *
 *   * `check in` with no name was not a command at all, so it fell past
 *     attendance into the candidate pipeline, where the CRM's reply policy
 *     suppresses internal numbers. No punch, no reply.
 *   * a command the CRM declined — already checked in, no check-in to check out
 *     of, a name that was not theirs — came back as a 4xx with no branch.
 *   * a location shared after the ten-minute pending window, or after a restart
 *     with no Redis, had no command to complete and was logged and dropped.
 *   * a typo, a greeting, a "thanks" — anything unrecognised — was silenced the
 *     same way as a bare command.
 *
 * From a staff phone all of that is one symptom: attendance does not work. So
 * the rule here is the invariant, not the happy path: on the attendance line a
 * recognised employee always hears back, and that answer is sent at most once
 * per delivery because Meta repeats deliveries.
 *
 * Strangers are the one exception, and deliberately: an attendance command from
 * a number the CRM does not know is never answered *as attendance*, so the line
 * cannot be used to find out who works here. It is not swallowed either — it
 * goes on to the ordinary candidate workflow, because candidates do write to
 * this number.
 */

import { config } from './config.js';
import { logger } from './logger.js';
import {
  attendanceRecordedMessage,
  parseAttendanceCommand,
  type AttendanceCommand,
} from './attendance.js';
import {
  ATTENDANCE_RESEND_MESSAGE,
  locationProblemMessage,
  type LocationProblem,
  firstAttendanceDelivery,
  forgetPendingAttendance,
  locationRequestMessage,
  pendingAttendance,
  rememberPendingAttendance,
} from './attendance-pending.js';
import { crmConfigured, fetchWhatsappReplyPolicy, submitAttendanceEvent } from './crm/client.js';
import { sendLocationRequest, sendText } from './whatsapp/client.js';
import type { InboundMessage } from './whatsapp/parse.js';

/**
 * Which number attendance is read on.
 *
 * Falls back to the candidate line so a deployment that has not set the
 * attendance number still accepts commands there.
 */
export function attendanceLineId(): string {
  return config.WHATSAPP_ATTENDANCE_PHONE_NUMBER_ID ?? config.WHATSAPP_PHONE_NUMBER_ID;
}

/**
 * Whether the attendance line is a line of its own.
 *
 * It decides one thing only: whether a *staff* message that is not a command
 * gets the attendance format back. On a number set aside for attendance that is
 * the helpful answer; on the candidate line it would be noise, and it would
 * cost a reply-policy lookup on every candidate message.
 *
 * It does **not** make the line staff-only. Non-staff senders go on to
 * candidate processing either way — see `offerAttendanceHelp`.
 */
export function attendanceLineIsDedicated(): boolean {
  const attendance = config.WHATSAPP_ATTENDANCE_PHONE_NUMBER_ID;
  return !!attendance && attendance !== config.WHATSAPP_PHONE_NUMBER_ID;
}

export type AttendanceOutcome =
  /** Dealt with here. The caller must not process the message further. */
  | 'handled'
  /** Nothing to do with attendance. The caller decides what happens next. */
  | 'not_attendance';

/**
 * Send a reply, but only for the first delivery of this message.
 *
 * Meta can deliver one message several times inside a second. Each delivery
 * used to be free to earn its own reply on the branches that had one, so a
 * redelivered command confirmed attendance twice — which reads, to someone who
 * has just been told their attendance does not work, like two punches.
 */
async function replyOnce(msg: InboundMessage, body: string): Promise<void> {
  if (!(await firstAttendanceDelivery(msg.wamid))) {
    logger.debug({ wamid: msg.wamid }, 'attendance reply already sent for this delivery');
    return;
  }
  await sendText(msg.waId, body, msg.phoneNumberId);
}

/**
 * Why a message carried no usable location.
 *
 * Two shapes reach the bot without a pin, and they are not the same fact:
 *
 *   * `unsupported` — a type the Cloud API cannot represent at all. A live
 *     location is the usual one, but polls and view-once media land here too,
 *     so this is not evidence of a live location.
 *   * `location` with no usable latitude/longitude — `parseWebhook` refuses to
 *     invent a pin and leaves the message as `other`, keeping only `rawType`.
 *     This one proves the coordinates could not be read; it does *not* prove
 *     what the employee tapped. A truncated payload, a renamed Meta field or a
 *     bug in our own parser all look identical from here.
 *
 * It was the second shape that used to be missed entirely, and it is the one
 * that most looks like a working location message from the outside.
 *
 * `msg.location` is checked first and wins outright: a message with real
 * coordinates is a usable pin whatever its `rawType` says, so callers must
 * handle that before asking this.
 */
export function locationProblem(msg: Pick<InboundMessage, 'rawType'>): LocationProblem {
  if (msg.rawType === 'location') return 'unreadable';
  if (msg.rawType === 'unsupported') return 'unsupported_type';
  return 'not_a_location';
}

/**
 * A refusal this bot has no branch for, as something a person can read.
 *
 * The CRM's `detail` is normally a sentence written for the employee and is
 * passed straight through. A framework validation error is not: it arrives as a
 * serialised list of field errors, and showing that to somebody trying to mark
 * attendance is worse than saying less. It is reachable during a rollout — the
 * bot and the CRM ship separately, so a bot that accepts a bare "check in" can
 * be talking to a CRM that still demands a name.
 */
export function readableRefusal(detail: string): string {
  const text = detail.trim();
  if (/^[[{]/.test(text) || text.length > 180) {
    return 'Attendance not recorded. Please send "check in" or "check out" with your name, for example "Asha - check in".';
  }
  return `Attendance not recorded: ${text}`;
}

/** Answer a command the CRM has just ruled on. */
async function answerSubmission(
  msg: InboundMessage,
  command: PendingCommand,
  submission: Awaited<ReturnType<typeof submitAttendanceEvent>>,
  stage: 'command' | 'location',
): Promise<AttendanceOutcome> {
  logger.info(
    {
      wamid: msg.wamid,
      stage,
      action: command.action,
      named: !!command.statedName,
      result: submission.result,
      ...(submission.result === 'recorded' ? { duplicate: submission.duplicate } : {}),
    },
    'attendance message handled',
  );

  switch (submission.result) {
    case 'recorded':
      await forgetPendingAttendance(msg.waId);
      await replyOnce(
        msg,
        attendanceRecordedMessage(command.action, {
          time: submission.time,
          site: submission.site,
          locationStatus: submission.locationStatus,
        }),
      );
      return 'handled';

    case 'location_required':
      // The first step of a normal punch, not a failure: the command arrives
      // with no location and the CRM asks for one. Hold the command so the
      // location that follows completes it.
      await rememberPendingAttendance(msg.waId, { ...command, commandWamid: msg.wamid });
      if (await firstAttendanceDelivery(msg.wamid)) {
        await sendLocationRequest(msg.waId, locationRequestMessage(command), msg.phoneNumberId);
      }
      return 'handled';

    case 'off_site':
      // Keep the command pending, so sharing again from the office finishes it
      // without the employee having to retype anything.
      await rememberPendingAttendance(msg.waId, {
        ...command,
        // At the command stage this message *is* the command. At the location
        // stage it is the pin, and the command it completes is the one already
        // held — keep pointing at that one.
        commandWamid: (stage === 'location' ? command.commandWamid : msg.wamid) ?? msg.wamid,
      });
      await replyOnce(msg, submission.detail);
      return 'handled';

    case 'conflict':
      // "Check-in already recorded", "check-in is required before check-out".
      // The employee is authenticated and on site; this is theirs to hear.
      await forgetPendingAttendance(msg.waId);
      await replyOnce(msg, `Attendance not recorded. ${submission.detail}`);
      return 'handled';

    case 'name_mismatch':
      await forgetPendingAttendance(msg.waId);
      await replyOnce(
        msg,
        'Attendance not recorded: that name does not match your staff account. ' +
          'Send "check in" or "check out" on its own, or write the name on your CRM account.',
      );
      return 'handled';

    case 'unknown_sender':
      // Never answered here. Replying would tell an outsider that this number
      // is the attendance line and that some numbers are recognised on it.
      // Handled by the caller instead of consumed, because when the candidate
      // line is doubling as the attendance line this is simply a candidate who
      // happened to type "check in", and swallowing it would lose them.
      logger.info(
        { wamid: msg.wamid, waId: msg.waId },
        'attendance command from a number that is not staff',
      );
      return 'not_attendance';

    default:
      await forgetPendingAttendance(msg.waId);
      await replyOnce(msg, readableRefusal(submission.detail));
      return 'handled';
  }
}

/** Pending commands carry the wamid of the text that started them. */
type PendingCommand = AttendanceCommand & { commandWamid?: string };

/**
 * Run the attendance workflow for one inbound message.
 *
 * Only called for messages that arrived on the attendance line.
 */
export async function handleAttendanceMessage(msg: InboundMessage): Promise<AttendanceOutcome> {
  // Attendance is entirely the CRM's to decide — who the number belongs to,
  // where the offices are, whether the punch stands. With no CRM there is
  // nothing to ask, so nothing here may claim the message: otherwise every
  // "check in" on the line would throw and Meta would redeliver it forever.
  if (!crmConfigured()) return 'not_attendance';

  const command = parseAttendanceCommand(msg.text);

  if (command) {
    // Sent without a location on purpose. The CRM owns the phone-to-staff
    // match and the office radius, so it is the CRM that decides whether this
    // employee has to prove where they are — and an unknown sender is refused
    // before anyone is asked anything.
    const submission = await submitAttendanceEvent({
      message_id: msg.wamid,
      sender_phone: msg.waId,
      ...(command.statedName ? { stated_name: command.statedName } : {}),
      action: command.action,
      occurred_at: msg.timestamp.toISOString(),
      chat_type: 'private',
    });
    return answerSubmission(msg, command, submission, 'command');
  }

  const pending = (await pendingAttendance(msg.waId)) as PendingCommand | undefined;

  if (msg.location) {
    if (!pending) {
      // The ten-minute window closed, or the bot restarted with no Redis and
      // the command was only ever in that process's memory. Either way the
      // employee may be standing at the office holding a shared pin, so this
      // must not be dropped on the floor the way it used to be — but whether
      // they are staff at all is the CRM's to say, so the answer is left to
      // `offerAttendanceHelp`.
      logger.info(
        { wamid: msg.wamid, waId: msg.waId },
        'location received with no attendance command waiting',
      );
      return 'not_attendance';
    }
    const submission = await submitAttendanceEvent({
      message_id: msg.wamid,
      sender_phone: msg.waId,
      ...(pending.statedName ? { stated_name: pending.statedName } : {}),
      action: pending.action,
      occurred_at: msg.timestamp.toISOString(),
      chat_type: 'private',
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
      ...(pending.commandWamid ? { command_message_id: pending.commandWamid } : {}),
    });
    return answerSubmission(msg, pending, submission, 'location');
  }

  if (pending) {
    const problem = locationProblem(msg);
    // `not_a_location` is an ordinary message that happens to arrive while a
    // punch is waiting — a "ok", a greeting, a typo. It is not an attempt to
    // share a location and must not become a punch, so that one is still
    // answered by asking.
    if (problem === 'not_a_location') {
      logger.info(
        { wamid: msg.wamid, rawType: msg.rawType },
        'attendance waiting for a location; message was not an attempt at one',
      );
      await replyOnce(msg, locationProblemMessage(problem, true));
      return 'handled';
    }
    // They *did* try to send a location and nothing usable arrived. Almost
    // always a live location, which WhatsApp never delivers to the Cloud API:
    // it comes through as `unsupported` with no coordinates, so asking again
    // gets the same nothing back. That loop was the complaint — staff sharing
    // their location from inside the office and never getting marked.
    //
    // So the punch is filed with the location left unestablished, and the CRM
    // flags it for a manager instead of refusing it.
    logger.info(
      { wamid: msg.wamid, rawType: msg.rawType, problem },
      'attendance location unusable; filing the punch unverified',
    );
    const submission = await submitAttendanceEvent({
      message_id: msg.wamid,
      sender_phone: msg.waId,
      ...(pending.statedName ? { stated_name: pending.statedName } : {}),
      action: pending.action,
      occurred_at: msg.timestamp.toISOString(),
      chat_type: 'private',
      location_unavailable: true,
      ...(pending.commandWamid ? { command_message_id: pending.commandWamid } : {}),
    });
    return answerSubmission(msg, pending, submission, 'location');
  }

  return 'not_attendance';
}

/**
 * Tell a staff member how to mark attendance.
 *
 * Reached on a dedicated attendance line for a message that is neither a
 * command nor part of one. The CRM is asked who the sender is rather than the
 * local directory, for the same reason the candidate path asks it: it is
 * authoritative, and a number removed from staff must stop being treated as
 * staff on the next message.
 *
 * Returns whether the message was dealt with. **False for anyone the CRM does
 * not call internal, and the caller must carry on with them.** The attendance
 * number is not a number nothing else has ever used — candidates have been
 * reaching the bot on it, because until the id was corrected the attendance
 * branch never matched and every message on that line fell through to
 * onboarding. Turning the line staff-only would have started silently dropping
 * those people, which is a worse fault than the one being fixed. Staff are
 * matched by their number and answered before this, so attendance loses
 * nothing by letting the rest through.
 */
export async function offerAttendanceHelp(msg: InboundMessage): Promise<boolean> {
  if (!crmConfigured()) return false;
  const policy = await fetchWhatsappReplyPolicy(msg.waId);
  const internal = !policy.should_reply && policy.reason === 'internal_user_number';
  if (!internal) {
    logger.info(
      { wamid: msg.wamid, waId: msg.waId, reason: policy.reason },
      'non-staff message on the attendance line; left to the candidate workflow',
    );
    return false;
  }
  logger.info(
    { wamid: msg.wamid, waId: msg.waId, type: msg.type },
    'staff message on the attendance line was not a command; sent the format',
  );
  // A usable pin with nothing waiting is a half-finished punch: ask for the
  // command, not for the location again. Everything else is diagnosed by what
  // the message actually was — the generic format help answers none of the
  // location failures, because the employee *did* send their location and
  // being shown the format again says nothing about why it did not count.
  await replyOnce(
    msg,
    msg.location ? ATTENDANCE_RESEND_MESSAGE : locationProblemMessage(locationProblem(msg), false),
  );
  return true;
}
