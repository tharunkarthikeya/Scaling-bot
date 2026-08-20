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
  candidate_id: string;
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

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { detail?: unknown };
      if (typeof parsed.detail === 'string') return parsed.detail;
    } catch {
      // Not JSON. The raw body is still the best description we have.
    }
    return body.slice(0, 300);
  } catch {
    return `${res.status}`;
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

  const detail = await readError(res);

  // The one rejection the bot can act on: the policy wants a CV and this
  // candidate has none. Flagged so the caller reopens the CV step instead of
  // retrying an identical request that will be refused identically.
  const needsCv = res.status === 422 && /resume|cv/i.test(detail);

  throw new CrmError(detail, res.status, isRetryable(res.status), needsCv);
}

/**
 * Uploads a CV to a candidate the CRM already has.
 *
 * A second call rather than part of the first, because the CRM assigns the id
 * this file is filed against — and because a multipart body carrying both the
 * profile and the bytes would make the common case (no CV at all) the awkward
 * one.
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
    const detail = await readError(res);
    throw new CrmError(detail, res.status, isRetryable(res.status));
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
