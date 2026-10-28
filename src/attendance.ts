/** Attendance commands accepted in a recognised staff member's private chat. */
export type AttendanceAction = 'check_in' | 'check_out';

export interface AttendanceCommand {
  /**
   * The name written with the command, when one was written.
   *
   * Optional, and that is the point. This is the employee's own one-to-one chat
   * on the attendance line: the number they are holding already resolves to
   * exactly one active CRM employee, and the CRM resolves it before it looks at
   * any name. A name that *is* written is still verified against that account,
   * so the second factor survives for everyone who writes one — but "check in"
   * on its own used not to parse as a command at all, so it fell through to the
   * candidate pipeline, where the CRM's reply policy silences staff numbers.
   * The plainest message anyone could send produced no attendance and no reply.
   */
  statedName?: string;
  action: AttendanceAction;
}

export function attendanceSuccessMessage(action: AttendanceAction): string {
  return action === 'check_in'
    ? 'Attendance check in successful.'
    : 'Attendance check out successful.';
}

/**
 * The confirmation when the CRM says where and when it filed the punch.
 *
 * Worth the extra words: "successful" on its own is an assurance, and staff who
 * had been getting silence do not believe assurances. The office time and the
 * office name are evidence they can check against the CRM.
 */
export function attendanceRecordedMessage(
  action: AttendanceAction,
  details: { time?: string; site?: string; locationStatus?: string } = {},
): string {
  const base = attendanceSuccessMessage(action);
  const confirmed = details.time
    ? `${base.replace(/\.$/, '')} at ${details.time}${details.site ? ` at ${details.site}` : ''}.`
    : base;
  // A punch the CRM could not place at an office is still recorded — losing
  // somebody the day over a 400 m WiFi fix is the worse error — but saying only
  // "recorded" would hide that a manager is going to be asked about it. Telling
  // them here is also the cheapest way to catch the real cause: someone who
  // tapped a shop name in the location picker finds out the same minute,
  // instead of at the end of the month.
  if (details.locationStatus === 'off_site') {
    return `${confirmed} Your location did not match the office, so this one goes to your manager for review. If you are at the office, share your location again using "Send your current location".`;
  }
  if (details.locationStatus === 'unverified') {
    return `${confirmed} Your location could not be read, so this one goes to your manager for review. Live location does not reach us — next time use "Send your current location" instead.`;
  }
  return confirmed;
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
 * The text around the keyword, as a name — or nothing, when it is not one.
 *
 * Staff append the time they meant to report ("check in 10.15", "9:05 am check
 * out"). The webhook timestamp is authoritative, so that is not a name and must
 * not be sent to the CRM as one: a punch filed under the stated name "10.15"
 * came back as a name mismatch, and the employee was told nothing at all.
 * Anything with no letter in it is a clock reading, not a person.
 */
function nameOrNothing(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim().replace(/^[-,:|]+\s*|\s*[-,:|]+$/g, '').trim();
  if (!trimmed || !/[a-z]/i.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Accept "Asha - check in" (the requested format), the natural inverse
 * "check out Asha", and the bare "check in" from the employee's own number.
 * Nothing fuzzy is inferred: ordinary staff conversation in a staff chat must
 * never become attendance accidentally.
 */
export function parseAttendanceCommand(text: string | undefined): AttendanceCommand | undefined {
  const input = (text ?? '').trim().replace(/\s+/g, ' ');
  if (!input || input.length > 220) return undefined;

  // A command must contain one unambiguous action. In particular, do not turn
  // "Asha check in or check out" into whichever action happens to occur first.
  if ([...input.matchAll(new RegExp(ACTION, 'gi'))].length !== 1) return undefined;

  const suffix = input.match(
    new RegExp(`^(.+?)\\s*(?:[-,:|]\\s*)?(${ACTION})(?:\\s*(?:[-,:|]\\s*)?.*)?$`, 'i'),
  );
  // `(.*)` rather than `(.+)`: the trailing group is what a name goes in, and a
  // command with no name is a command.
  const prefix = input.match(new RegExp(`^(${ACTION})\\s*(?:[-,:|]\\s*)?(.*)$`, 'i'));
  const match = suffix ?? prefix;
  if (!match) return undefined;

  const actionText = suffix ? match[2] : match[1];
  if (!actionText) return undefined;
  const action = actionFrom(actionText);
  if (!action) return undefined;

  const statedName = nameOrNothing(suffix ? match[1] : match[2]);
  if (statedName && statedName.length > 150) return undefined;
  return statedName ? { statedName, action } : { action };
}
