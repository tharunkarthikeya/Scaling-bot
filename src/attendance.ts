/** Attendance commands accepted in a recognised staff member's private chat. */
export type AttendanceAction = 'check_in' | 'check_out';

export interface AttendanceCommand {
  statedName: string;
  action: AttendanceAction;
}

export function attendanceSuccessMessage(action: AttendanceAction): string {
  return action === 'check_in'
    ? 'Attendance check in successful.'
    : 'Attendance check out successful.';
}

const ACTION = '\\b(?:check(?:ed)?|clock(?:ed)?)\\s*[-_ ]?\\s*(?:in|out)\\b';

function actionFrom(value: string): AttendanceAction | undefined {
  const compact = value.toLowerCase().replace(/[^a-z]/g, '');
  if (compact === 'checkin' || compact === 'checkedin' || compact === 'clockin' || compact === 'clockedin') {
    return 'check_in';
  }
  if (compact === 'checkout' || compact === 'checkedout' || compact === 'clockout' || compact === 'clockedout') {
    return 'check_out';
  }
  return undefined;
}

/**
 * Accept "Asha - check in" (the requested format) and the natural inverse
 * "check out Asha".  Nothing fuzzy is inferred: ordinary staff conversation
 * in a staff chat must never become attendance accidentally.
 */
export function parseAttendanceCommand(text: string | undefined): AttendanceCommand | undefined {
  const input = (text ?? '').trim().replace(/\s+/g, ' ');
  if (!input || input.length > 220) return undefined;

  // A command must contain one unambiguous action. In particular, do not turn
  // "Asha check in or check out" into whichever action happens to occur first.
  if ([...input.matchAll(new RegExp(ACTION, 'gi'))].length !== 1) return undefined;

  // Staff often append the time they intended to report (for example 10.15).
  // The webhook timestamp remains authoritative; text after the keyword is
  // deliberately ignored rather than mistaken for part of the staff name.
  const suffix = input.match(
    new RegExp(`^(.+?)\\s*(?:[-,:|]\\s*)?(${ACTION})(?:\\s*(?:[-,:|]\\s*)?.*)?$`, 'i'),
  );
  const prefix = input.match(new RegExp(`^(${ACTION})\\s*(?:[-,:|]\\s*)?(.+)$`, 'i'));
  const match = suffix ?? prefix;
  if (!match) return undefined;

  const actionText = suffix ? match[2] : match[1];
  const nameText = suffix ? match[1] : match[2];
  if (!actionText || !nameText) return undefined;
  const statedName = nameText.trim().replace(/^[-,:|]\s*|\s*[-,:|]$/g, '');
  const action = actionFrom(actionText);
  if (!action || !statedName || statedName.length > 150) return undefined;
  return { statedName, action };
}
