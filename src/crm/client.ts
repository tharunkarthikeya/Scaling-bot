/**
 * Talking to the recruitment CRM.
 *
 * Two calls and a health check:
 *
 *   GET  /policy/cv-required   is a CV needed for this destination and job?
 *   POST /candidates           submit a finished registration
 *   POST /candidates/{id}/resume   hand over the CV file itself
 *
 * The division of responsibility is worth stating, because it is the thing that
 * makes this file small. The CRM owns candidates once they exist: assignment,
 * evaluation, SLA, the hiring decision. This bot owns the conversation. Nothing
 * here reimplements anything on the other side of that line, and nothing here
 * writes to the CRM's database — every change goes through its API, so its own
 * business logic runs on the way in.
 *
 * The bytes of a CV go over the wire rather than a path. Our storage is ours:
 * a `storage_key` from this process names a file on a disk the CRM cannot read,
 * and a recruiter clicking "download résumé" would get a 404 for a document
 * that exists.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { CrmCandidatePayload } from './mapping.js';

export interface CrmCandidateResponse {
  success: boolean;
  /** Internal record id used for subsequent CRM API calls. */
  candidate_id: string;
  /** CRM-generated human id used in notifications and UI. */
  candidate_code?: string;
  created: boolean;
  cv_required: boolean;
  cv_policy_version?: string;
  /** True when the CRM's policy disagreed with the claim we sent. */
  policy_overrode_claim?: boolean;
}

export interface CvPolicyAnswer {
  cv_required: boolean;
  policy_version: string;
}

/**
 * A CRM call that did not succeed.
 *
 * `retryable` is the field callers act on, and the distinction it draws is the
 * important one. A 503 means "come back later" and the candidate is fine. A 422
 * means the submission itself is wrong — retrying it unchanged will fail
 * forever, and something has to change before it is worth sending again.
 */
export class CrmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** Set on a 422 caused by the CV policy — the one failure the bot can fix. */
    readonly needsCv = false,
    /** The CRM's machine-readable reason, where it gave one (`CV_REQUIRED`, …). */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CrmError';
  }
}

export function crmConfigured(): boolean {
  return !!(config.CRM_API_URL && config.CRM_API_KEY);
}

function url(path: string): string {
  return `${config.CRM_API_URL!.replace(/\/$/, '')}${path}`;
}

function headers(): Record<string, string> {
  // The service credential, not a staff token. The CRM checks them separately
  // so neither can stand in for the other.
  return { 'X-Service-Key': config.CRM_API_KEY! };
}

/**
 * Retryable statuses.
 *
 * 429, 502, 503 and 504 all mean the request was fine and the service was not.
 * A 5xx we do not recognise is treated the same way: an unexpected server
 * failure is far more likely to be transient than to be our fault, and the cost
 * of retrying something unretryable is a few wasted attempts, while the cost of
 * giving up on something transient is a lost candidate.
 */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * What the CRM said went wrong.
 *
 * `code` is the part that matters. The bot has to tell one 422 from another —
 * "you owe me a CV", which it can act on, from "this submission is malformed",
 * which it cannot — and reading that out of a prose message means matching on
 * wording that is free to change. The CRM sends a code for exactly this reason;
 * the text is kept alongside it for the log.
 */
interface CrmFailure {
  detail: string;
  code?: string;
}

async function readError(res: Response): Promise<CrmFailure> {
  try {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { detail?: unknown; code?: unknown };
      const code = typeof parsed.code === 'string' ? parsed.code : undefined;
      if (typeof parsed.detail === 'string') return { detail: parsed.detail, code };
      // FastAPI's own errors nest the message under `detail`; ours do not, and
      // both reach here.
      if (parsed.detail !== undefined) {
        return { detail: JSON.stringify(parsed.detail).slice(0, 300), code };
      }
      if (code) return { detail: body.slice(0, 300), code };
    } catch {
      // Not JSON. The raw body is still the best description we have.
    }
    return { detail: body.slice(0, 300) };
  } catch {
    return { detail: `${res.status}` };
  }
}

/**
 * Whether a CV is required, according to the CRM.
 *
 * Asked mid-conversation, so the question the bot puts next matches the rule
 * that will be applied when it submits. Returns undefined when the CRM cannot
 * be reached — the caller then falls back to its own cached policy rather than
 * stalling a registration behind someone else's outage.
 */
export async function fetchCvRequirement(params: {
  destinationCountry: string;
  jobCategory: string;
}): Promise<CvPolicyAnswer | undefined> {
  if (!crmConfigured()) return undefined;

  const query = new URLSearchParams({
    destination_country: params.destinationCountry,
    job_category: params.jobCategory,
  });

  try {
    const res = await fetch(`${url('/policy/cv-required')}?${query}`, {
      headers: headers(),
      signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'crm cv policy lookup failed');
      return undefined;
    }
    const body = (await res.json()) as CvPolicyAnswer;
    return { cv_required: !!body.cv_required, policy_version: body.policy_version ?? '' };
  } catch (err) {
    logger.warn({ err }, 'crm cv policy lookup unreachable');
    return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * Reading a candidate back, to announce that somebody now owns them
 *
 * Both of these are `undefined` on any failure rather than throwing. Their one
 * caller is composing a notification about an allocation that has already
 * happened and been recorded on the other side: there is nothing to roll back
 * and nothing to retry into, so a CRM that cannot be reached costs a message,
 * not a candidate.
 * -------------------------------------------------------------------------*/

/** The handful of facts the staff assignment message is built from. */
export interface CrmAssignmentSummary {
  /** Internal CRM id. Used for API relationships only; never shown in WhatsApp. */
  candidate_id: string;
  /** CRM-generated human id, for example CND-000101. */
  candidate_code?: string | null;
  source?: string;
  /** Which conversation created the record; selects the matching staff template. */
  enquiry?: 'apply' | 'staff' | null;
  /** Accepted as well for CRMs that keep the value under registration. */
  registration?: { enquiry?: 'apply' | 'staff' | null } | null;
  full_name?: string | null;
  destination_country?: string | null;
  job?: string | null;
  phone?: string | null;
  documents?: string[];
  assigned_staff_id?: string | null;
  /**
   * When that allocation was made, ISO-8601, as the CRM recorded it.
   *
   * What tells one allocation apart from a retried relay announcing the same
   * one. See `staffNoticeKey`.
   */
  assigned_at?: string | null;
}

/** One staff member's contact details, and whether they are still active. */
export interface CrmStaffContact {
  /** Internal CRM id. Used for API relationships only; never shown in WhatsApp. */
  id: string;
  /** CRM-generated human id, for example STF-000012. */
  staff_code?: string | null;
  name?: string | null;
  phone?: string | null;
  role?: string | null;
  active?: boolean;
}

async function readJson<T>(path: string, what: string): Promise<T | undefined> {
  if (!crmConfigured()) return undefined;

  try {
    const res = await fetch(url(path), {
      headers: headers(),
      signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, what }, 'crm read failed');
      return undefined;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, what }, 'crm read unreachable');
    return undefined;
  }
}

/** What to say about the candidate. */
export async function fetchAssignmentSummary(
  candidateId: string,
): Promise<CrmAssignmentSummary | undefined> {
  return readJson<CrmAssignmentSummary>(
    `/candidates/${encodeURIComponent(candidateId)}/assignment-summary`,
    'assignment summary',
  );
}

/** Who to say it to. */
export async function fetchStaffContact(
  staffId: string,
): Promise<CrmStaffContact | undefined> {
  return readJson<CrmStaffContact>(
    `/staff/${encodeURIComponent(staffId)}/contact`,
    'staff contact',
  );
}

/**
 * Every admin who should hear that work has gone unattended.
 *
 * A list rather than one id, because an SLA breach is not addressed to anybody
 * in particular - it is addressed to whoever is running the desk, and the CRM's
 * own feed already fans out to all of them.
 */
export async function fetchAdminContacts(): Promise<CrmStaffContact[]> {
  const body = await readJson<{ contacts?: CrmStaffContact[] }>(
    '/staff/admin-contacts',
    'admin contacts',
  );
  return body?.contacts ?? [];
}

/**
 * Numbers the CRM administrator has explicitly excluded from bot automation.
 *
 * Unlike informational CRM reads, failure is not converted to an empty list:
 * an empty list would mean "allow everyone" and could start a candidate flow
 * for a contact the administrator deliberately suppressed.
 */
export async function fetchBotSuppressionNumbers(): Promise<string[]> {
  if (!crmConfigured()) return [];

  const res = await fetch(url('/bot-suppression-directory'), {
    headers: headers(),
    signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`CRM bot suppression directory returned ${res.status}`);
  }
  const body = (await res.json()) as { numbers?: unknown };
  if (!Array.isArray(body.numbers)) {
    throw new Error('CRM bot suppression directory returned an invalid response');
  }
  return body.numbers.filter((value): value is string => typeof value === 'string');
}

/** Submits one finished registration. Safe to call again with the same payload. */
export async function createCandidate(
  payload: CrmCandidatePayload,
): Promise<CrmCandidateResponse> {
  if (!crmConfigured()) {
    throw new CrmError('CRM is not configured', 0, true);
  }

  let res: Response;
  try {
    res = await fetch(url('/candidates'), {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS),
    });
  } catch (err) {
    // Never reached the service. Always worth another go.
    throw new CrmError(err instanceof Error ? err.message : String(err), 0, true);
  }

  if (res.ok) return (await res.json()) as CrmCandidateResponse;

  const { detail, code } = await readError(res);

  // The one rejection the bot can act on: the policy wants a CV and this
  // candidate has none. Flagged so the caller sends the file — or reopens the
  // CV step to go and get one — instead of retrying an identical request that
  // will be refused identically.
  //
  // The code is what decides it. The wording test that used to stand here also
  // matched "resume is not valid base64", which is a bug in what we sent and
  // not a question for the candidate; asking someone to re-upload a CV that
  // arrived perfectly well would have looked like the bot losing their file.
  // The regex survives only as a fallback for a CRM too old to send a code.
  const needsCv =
    code === 'CV_REQUIRED' || (!code && res.status === 422 && /resume|cv/i.test(detail));

  throw new CrmError(detail, res.status, isRetryable(res.status), needsCv, code);
}

/**
 * Uploads a CV to a candidate the CRM already has.
 *
 * A second call rather than part of the first, because the CRM assigns the id
 * this file is filed against — and because a multipart body carrying both the
 * profile and the bytes would make the common case (no CV at all) the awkward
 * one.
 *
 * This is the normal path for a candidate whose CV was optional and who sent
 * one anyway. It is not available for a candidate the policy *requires* a CV
 * from: they cannot be created without the file, so there is no id to upload
 * against, and the file travels inside the submission instead. See
 * `syncCandidateToCrm`.
 */
export async function uploadResume(params: {
  candidateId: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<void> {
  if (!crmConfigured()) throw new CrmError('CRM is not configured', 0, true);

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(params.buffer)], { type: params.mimeType }),
    params.filename,
  );

  let res: Response;
  try {
    res = await fetch(url(`/candidates/${params.candidateId}/resume`), {
      method: 'POST',
      headers: headers(),
      body: form,
      signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CrmError(err instanceof Error ? err.message : String(err), 0, true);
  }

  if (!res.ok) {
    const { detail, code } = await readError(res);
    throw new CrmError(detail, res.status, isRetryable(res.status), false, code);
  }
}

/**
 * Hands over the scan behind one identity record the CRM already holds.
 *
 * Two requests, for the same reason the CV is two: the record travels with
 * every submission because it is small, and the bytes travel once because they
 * are not. `crmSync.identitySha256` is what makes "once" true — a partial sync
 * runs on every answered question, and a passport photograph on each of them
 * would be twenty megabytes for one registration.
 *
 * The record has to exist over there first, which it does: the same sync sends
 * the submission describing it immediately before this. A 404 means it did not
 * land, and the next sync sends both again in the same order.
 */
export async function uploadIdentityFile(params: {
  candidateId: string;
  documentType: 'aadhaar' | 'passport';
  recordId: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<void> {
  if (!crmConfigured()) throw new CrmError('CRM is not configured', 0, true);

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(params.buffer)], { type: params.mimeType }),
    params.filename,
  );

  const path =
    `/candidates/${encodeURIComponent(params.candidateId)}/identity/` +
    `${params.documentType}/${encodeURIComponent(params.recordId)}/file`;

  let res: Response;
  try {
    res = await fetch(url(path), {
      method: 'POST',
      headers: headers(),
      body: form,
      signal: AbortSignal.timeout(config.CRM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CrmError(err instanceof Error ? err.message : String(err), 0, true);
  }

  if (!res.ok) {
    const { detail, code } = await readError(res);
    throw new CrmError(detail, res.status, isRetryable(res.status), false, code);
  }
}

/** Liveness, for the doctor and the harness. */
export async function crmHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!crmConfigured()) return { ok: false, detail: 'CRM_API_URL / CRM_API_KEY not set' };
  try {
    const res = await fetch(url('/health'), { signal: AbortSignal.timeout(10_000) });
    return { ok: res.ok, detail: `${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
