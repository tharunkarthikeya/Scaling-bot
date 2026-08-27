/**
 * The two things the CRM asks this bot to say on WhatsApp.
 *
 *   * **An allocation** - a candidate is now yours - to the staff member.
 *   * **An SLA breach** - nobody has touched it since - to the admins.
 *
 * The CRM owns both events and always has. What it does not own is a way to
 * reach a phone: the Meta credentials, the number the agency sends from and the
 * send budget all live here. So it posts to `/api/staff-assignment` and
 * `/api/sla-breach`, and this module composes the wording - which is what keeps
 * the message text on this side of the wire, where the other four hundred lines
 * of copy already are.
 *
 * Two things about both are not preference:
 *
 *   * **They are templates.** Neither a staff member nor an admin ever messages
 *     this number, so their 24-hour service window is closed and stays closed.
 *     Free-form text to them is refused by Meta, not merely discouraged.
 *   * **They never throw.** Every caller is announcing something that has
 *     already happened and already been recorded in the CRM's own bell. There
 *     is nothing to roll back, so a failure here is a log line and a reason in
 *     the reply - never a 500 that makes the CRM think the event failed.
 */
import { config } from '../config.js';
import type { CrmStaffContact } from '../crm/client.js';
import { fetchAdminContacts, fetchAssignmentSummary, fetchStaffContact } from '../crm/client.js';
import {
  claimStaffNotice,
  confirmStaffNotice,
  releaseStaffNotice,
  staffNoticeKey,
} from '../db/models.js';
import { logger } from '../logger.js';
import { sendSlaAlertTemplate, sendStaffAssignmentTemplate } from '../whatsapp/client.js';

/**
 * Why a notification did not go out, for the CRM's log and for `/api`'s reply.
 *
 * Every one of these is a 200 to the caller. The CRM is not being asked to
 * retry - it has already written the durable notification that matters - and a
 * staff member with no number on file is a data problem for an admin to fix,
 * not an error condition for a relay to keep hammering.
 */
export type StaffNotifyOutcome =
  | { sent: true; wamid?: string; shadowed: boolean }
  | { sent: false; reason: string };

/** Meta rejects a template parameter that is empty, so nothing may be blank. */
const NOT_STATED = 'Not stated';

/**
 * One field's worth of text, fit to travel as a template parameter.
 *
 * Newlines and tabs are rejected by Meta outright, and so is a run of four or
 * more spaces - the line breaks belong to the template body, and a parameter is
 * one value on one line. Collapsing rather than rejecting is deliberate: an
 * address pasted into a job title should cost the message its formatting, not
 * cost the staff member their notification.
 */
function parameter(value: string | null | undefined, fallback = NOT_STATED): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  // 1024 is the per-parameter limit. Truncating loses the tail of a long job
  // title; not truncating loses the whole message.
  return text ? text.slice(0, 1024) : fallback;
}

/**
 * A staff member's number as Meta wants it: digits, country code included.
 *
 * The CRM stores this as free text on purpose - the roster is Indian, Gulf and
 * occasionally European, and a field that rejects "+971 50 123 4567" is a field
 * somebody works around by typing the number into the name box. So the cleaning
 * happens here, at the only point that needs it.
 *
 * A number that already carries a country code is used as it stands. A bare
 * ten-digit one cannot be placed by looking at it - 9876543210 is a valid
 * subscriber number in several of the countries this roster spans - so it is
 * read as `STAFF_PHONE_DEFAULT_COUNTRY_CODE`, and that is logged, because the
 * alternative is either guessing silently or refusing to message the majority
 * of the roster who write their own number the way they say it.
 */
export function staffPhoneToE164(raw: string | null | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;

  const hadCountryCode = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/^00/, '').replace(/\D/g, '');
  if (!digits) return undefined;

  if (hadCountryCode) {
    // 8 is the shortest national number in use anywhere; below that this is a
    // typo or an extension, and sending to it reaches somebody else.
    return digits.length >= 8 && digits.length <= 15 ? digits : undefined;
  }

  const cc = config.STAFF_PHONE_DEFAULT_COUNTRY_CODE;
  if (digits.length === 10 && cc) {
    logger.debug({ cc }, 'staff number had no country code; assuming the default');
    return `${cc}${digits}`;
  }

  // Long enough to already include a country code, just written without a plus.
  return digits.length >= 11 && digits.length <= 15 ? digits : undefined;
}

/**
 * The template's three parameters, in the order the approved body expects.
 *
 * This array **is** the contract with Meta. The body submitted for approval is:
 *
 *     Hello, {{1}}
 *     Candidate Name: {{1}}
 *     Candidate ID: {{2}}
 *     Mobile Number: {{3}}
 *
 * Reordering here without resubmitting there produces a message that sends
 * cleanly and says the wrong things, which is the worst shape this bug can
 * take - so the body is written out above rather than left in a wiki.
 */
export function staffAssignmentParameters(fields: {
  fullName?: string | null;
  candidateId: string;
  phone?: string | null;
}): string[] {
  return [
    parameter(fields.fullName, 'Unnamed candidate'),
    parameter(fields.candidateId),
    parameter(fields.phone, 'Not on file'),
  ];
}

/**
 * The whole path: read both sides, decide whether to send, send.
 *
 * The two reads go together rather than in sequence - neither depends on the
 * other, and an allocation is announced while somebody is still looking at the
 * screen that caused it.
 */
export async function notifyStaffOfAssignment(params: {
  candidateId: string;
  staffId: string;
}): Promise<StaffNotifyOutcome> {
  const { candidateId, staffId } = params;

  if (!config.WHATSAPP_STAFF_ASSIGNMENT_TEMPLATE) {
    return { sent: false, reason: 'staff_template_not_configured' };
  }

  const [staff, summary] = await Promise.all([
    fetchStaffContact(staffId),
    fetchAssignmentSummary(candidateId),
  ]);

  if (!staff) return { sent: false, reason: 'staff_not_found' };
  if (!summary) return { sent: false, reason: 'candidate_not_found' };

  // A deactivated account still owns its queue - deletion is what redistributes
  // work, deactivation is not - but it is not a person to message tonight.
  if (staff.active === false) return { sent: false, reason: 'staff_inactive' };

  const to = staffPhoneToE164(staff.phone);
  if (!to) return { sent: false, reason: 'staff_has_no_usable_phone' };

  // The relay is best-effort and arrives on its own schedule, so it can land
  // after a rebalance has already moved this candidate to somebody else.
  // Telling the previous owner they have been given work they no longer hold is
  // worse than telling them nothing.
  if (summary.assigned_staff_id && summary.assigned_staff_id !== staffId) {
    return { sent: false, reason: 'assignment_superseded' };
  }

  // The relay is best-effort, so it retries, so the same allocation reaches
  // here more than once. A template is not a pop-up that can be sent twice
  // harmlessly - it costs the agency money and reads to the recipient as a
  // second candidate. Claimed before the send rather than recorded after it,
  // because a crash in between is exactly the case the retry exists for.
  const noticeKey = staffNoticeKey({
    candidateId,
    staffId,
    assignedAt: summary.assigned_at,
  });
  if (!(await claimStaffNotice({ candidateId, staffId, assignedAt: summary.assigned_at }))) {
    logger.debug({ staffId, candidateId }, 'this allocation has already been announced');
    return { sent: false, reason: 'already_notified' };
  }

  try {
    const result = await sendStaffAssignmentTemplate(
      to,
      staffAssignmentParameters({
        fullName: summary.full_name,
        candidateId: summary.candidate_id || candidateId,
        phone: summary.phone,
      }),
    );

    await confirmStaffNotice(noticeKey, result.wamid);
    logger.info(
      { staffId, candidateId, shadowed: !!result.shadowed },
      'told a staff member about an allocation',
    );
    return { sent: true, wamid: result.wamid, shadowed: !!result.shadowed };
  } catch (err) {
    // Nothing was delivered, so the claim goes back. Holding it would refuse
    // the retry that could have worked, as a duplicate of a message that never
    // existed.
    await releaseStaffNotice(noticeKey);
    logger.warn({ err, staffId, candidateId }, 'could not send the staff assignment message');
    return { sent: false, reason: 'send_failed' };
  }
}

/* ---------------------------------------------------------------------------
 * The other direction: telling the admins that nobody has touched it
 *
 * The CRM's sweep decides what counts as unattended - a candidate whose owner
 * has not opened it or not judged it, past `sla_threshold_hours`. This end only
 * turns one sweep's result into a message and puts it in front of the admins.
 * -------------------------------------------------------------------------*/

/** One sweep's result, in the shape the CRM relays it. */
export interface SlaBreachFacts {
  count: number;
  threshold_hours: number;
  staff_count?: number;
  /** Present only when the sweep found exactly one - see `relay_sla_breach`. */
  candidate_id?: string | null;
  candidate_name?: string | null;
  staff_name?: string | null;
  hours_overdue?: number | null;
  /** "unviewed" - never opened. "unevaluated" - opened, never judged. */
  reason?: string | null;
}

export type SlaNotifyOutcome =
  | { sent: true; recipients: number; shadowed: boolean }
  | { sent: false; reason: string };

function plural(n: number, one: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${one}s`;
}

/**
 * The SLA template's four parameters, in the order the approved body expects.
 *
 * As with the assignment template, this array **is** the contract with Meta:
 *
 *     Candidate Review Overdue
 *     Overdue: {{1}}
 *     Waiting: {{2}}
 *     With: {{3}}
 *     Not yet: {{4}}
 *     Open the CRM to review.
 *
 * One template covers both the single breach and the digest, which is why the
 * scaffolding is four labels rather than a sentence: "6 candidates / over 48
 * hours / 4 staff members / opened or verified" and "John Doe (CND-1024) / 51
 * hours / Priya Sharma / opened" both have to read as English through it.
 */
export function slaAlertParameters(facts: SlaBreachFacts): string[] {
  const single = facts.count === 1;
  const threshold = Math.round(facts.threshold_hours);

  const overdue = single
    ? [facts.candidate_name || 'An unnamed candidate', facts.candidate_id ? `(${facts.candidate_id})` : '']
        .filter(Boolean)
        .join(' ')
    : plural(facts.count, 'candidate');

  // A single breach can say how long it has actually been waiting. A digest
  // cannot without picking one of them, so it reports the window instead.
  const waiting =
    single && typeof facts.hours_overdue === 'number'
      ? plural(Math.round(facts.hours_overdue), 'hour')
      : `over ${threshold} hours`;

  const withWhom = single
    ? facts.staff_name || 'a staff member'
    : facts.staff_count
      ? plural(facts.staff_count, 'staff member')
      : 'their staff';

  // The admin's first question is always "did they even look at it?", so the
  // distinction the sweep drew is the one worth carrying.
  const notYet = single ? (facts.reason === 'unevaluated' ? 'verified' : 'opened') : 'opened or verified';

  return [parameter(overdue), parameter(waiting), parameter(withWhom), parameter(notYet)];
}

/**
 * Message every admin who has a number on file.
 *
 * Sent one at a time rather than all at once. The roster of admins is small, and
 * going through the reply budget in order is what keeps a sweep that found forty
 * breaches from arriving as a burst against the same rate limit a candidate's
 * next answer needs.
 *
 * An admin with no usable number is skipped and logged rather than failing the
 * batch - the others still need telling, and the log is how somebody discovers
 * their own account is the one being left out.
 */
export async function notifyAdminsOfSlaBreach(facts: SlaBreachFacts): Promise<SlaNotifyOutcome> {
  if (!config.WHATSAPP_SLA_ALERT_TEMPLATE) {
    return { sent: false, reason: 'sla_template_not_configured' };
  }
  if (!facts.count) return { sent: false, reason: 'nothing_in_breach' };

  const admins = await fetchAdminContacts();
  if (!admins.length) return { sent: false, reason: 'no_admins' };

  const reachable = admins
    .map((admin) => ({ admin, to: staffPhoneToE164(admin.phone) }))
    .filter((row): row is { admin: CrmStaffContact; to: string } => !!row.to);

  if (reachable.length < admins.length) {
    logger.warn(
      { without: admins.length - reachable.length },
      'some admins have no usable number and were left out of the SLA alert',
    );
  }
  if (!reachable.length) return { sent: false, reason: 'no_admin_with_a_usable_phone' };

  const parameters = slaAlertParameters(facts);
  let recipients = 0;
  let shadowed = false;

  for (const row of reachable) {
    try {
      const result = await sendSlaAlertTemplate(row.to, parameters);
      shadowed = shadowed || !!result.shadowed;
      recipients += 1;
    } catch (err) {
      logger.warn({ err, adminId: row.admin.id }, 'could not send the SLA alert to an admin');
    }
  }

  if (!recipients) return { sent: false, reason: 'send_failed' };

  logger.info({ recipients, breaches: facts.count }, 'told the admins about unattended work');
  return { sent: true, recipients, shadowed };
}
