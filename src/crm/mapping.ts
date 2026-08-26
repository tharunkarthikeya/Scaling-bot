/**
 * Turning a candidate of ours into a candidate of theirs.
 *
 * Written out field by field on purpose. The tempting version of this file is
 * two lines — take the Mongo document, rename a few keys, post it — and that
 * version is wrong in three separate ways:
 *
 *  * It ships whatever happens to be on the record. Aadhaar and PAN numbers
 *    live on our profile and have no business in the CRM; a wholesale copy
 *    sends them, and nobody notices until an audit.
 *  * It couples the two schemas. A field renamed here would silently change
 *    what the CRM receives, and a field added there would appear to be
 *    supported when nothing populates it.
 *  * It hides the semantic mismatches, which are the interesting part. Their
 *    `country` is where a candidate lives; ours records both that and where the
 *    candidate wants to go, and merging the two would put Malaysia in the
 *    residence field of someone sitting in Tamil Nadu.
 *
 * So: an explicit allow-list, with the disagreements written down where they
 * happen.
 */

import type { CandidateDoc } from '../db/models.js';
import { destinationCountryOf, stepsFor } from '../conversation/flow.js';
import type {
  CrmCvSection,
  CrmIdentitySection,
  CrmJobSection,
  CrmSnapshot,
} from './snapshot.js';

/** The profile shape `POST /candidates` accepts. Their names, not ours. */
export interface CrmProfile {
  full_name: string;
  phone?: string;
  phone_e164?: string;
  email?: string;
  location?: string;
  city?: string;
  country?: string;
  destination_country?: string;
  job_preference?: string;
  job_category?: string;
  trade_skills?: string[];
  skills?: string[];
  languages?: string[];
  certifications?: string[];
  total_experience_band?: string;
  total_experience_years?: number;
  passport_number?: string;
  passport_expiry?: string;
}

/**
 * A CV travelling inside the submission.
 *
 * Base64, not a path. Our `storage_key` names a file on a disk the CRM cannot
 * read, and a recruiter clicking "download résumé" would get a 404 for a
 * document that exists.
 *
 * Sent only when it has to be. A candidate the CRM's policy requires a CV from
 * cannot be created without one, and `POST /candidates/{id}/resume` needs an id
 * that does not exist yet — so for them the file comes with the submission.
 * Everyone else uploads afterwards, which keeps the common request small.
 */
export interface CrmResumePayload {
  filename: string;
  mime_type: string;
  content_base64: string;
}

/**
 * Where the conversation has got to.
 *
 * Sent because a registration now reaches the CRM while it is still happening,
 * and a recruiter opening a half-filled record has to be able to tell that from
 * a finished one. Without it, "no passport on file" reads as "this candidate
 * has no passport" when it means "we have not asked yet".
 *
 * `complete` is the field the CRM acts on for the CV policy. A partial
 * submission is not held to it — refusing to file someone because they have not
 * yet reached the question that would have produced the document is not a rule,
 * it is a race.
 *
 * `complete` is deliberately *not* what allocation waits for; `assignable` is.
 * See below.
 */
export interface CrmRegistrationState {
  complete: boolean;
  /**
   * Which conversation produced this record.
   *
   *   apply  a registration, finished or still being answered
   *   staff  somebody who tapped "Talk to staff" and was asked the intake's
   *          nine questions (§24). They are not registering, and this record
   *          will never carry `complete: true` — the field says so plainly so
   *          the CRM never has to infer it from an absence.
   */
  enquiry: 'apply' | 'staff';
  /**
   * Whether there is enough here to put in front of a person.
   *
   * The CRM owns assignment — who gets this candidate, when, and under what
   * workload rules. This is the one thing it cannot work out for itself: which
   * half-finished records are a person worth calling and which are a message
   * that stopped after "hi".
   *
   * True when all three of these hold:
   *
   *   1. Consent is on the record (§4). Nothing is assignable before it.
   *   2. There is somebody to call something — a name they typed, one read off
   *      a document, or the name WhatsApp shows. Not the phone number the
   *      profile falls back to, which is not a name.
   *   3. They have said what they want — a destination, a job category, or a
   *      job in their own words.
   *
   * A finished registration is always assignable. Everything else is judged on
   * what is actually on the record, so a candidate who answers the destination
   * and then goes quiet is assignable, and one who consented and said nothing
   * else is not.
   *
   * Deliberately not gated on `complete`. Waiting for a finished registration
   * means the candidate who needs a person most — the one who stopped — is the
   * one nobody is given.
   */
  assignable: boolean;
  /** Our own stage name, for the audit trail rather than for a decision. */
  stage: string;
  /** The bot's candidate status (§26). */
  status: string;
  /** The Application ID the candidate was given, once they have one (§19). */
  application_id?: string;
  /** The language the conversation is being held in. */
  language?: string;
  /** When consent was recorded (§4). Absent means nothing may be stored yet. */
  consent_at?: string;
  started_at?: string;
  updated_at?: string;
  completed_at?: string;
  /** Which questions are still outstanding, so the panel can say what is missing. */
  outstanding_documents?: string[];
}

export interface CrmCandidatePayload {
  source: 'whatsapp';
  profile: CrmProfile;
  idempotency_key: string;
  /** What we believe. The CRM decides for itself and may disagree. */
  cv_required_claim?: boolean;
  resume?: CrmResumePayload;

  /** Where the conversation has got to. Absent on a payload built before this existed. */
  registration?: CrmRegistrationState;
  /** The CV as the extractor read it, in the CRM's own résumé shape. */
  cv?: CrmCvSection;
  /** The Aadhaar and the passport, for the CRM's identity records. */
  identity?: CrmIdentitySection;
  /** What the conversation established about the work. */
  job?: CrmJobSection;
}

/**
 * A stable key for one candidate's submission.
 *
 * Derived from identifiers that do not change — the business phone number the
 * message arrived on, and the candidate's WhatsApp id — rather than generated,
 * so a retry after a crash produces the same key it did the first time. That is
 * what lets the CRM recognise a repeat instead of creating a second candidate.
 */
export function idempotencyKeyFor(candidate: CandidateDoc, phoneNumberId: string): string {
  return `whatsapp/${phoneNumberId}/${candidate.waId}`;
}

/**
 * The candidate's number in international form.
 *
 * `waId` is Meta's identifier and is already the full number in digits, without
 * a leading plus — "919876543210". Adding the plus is the whole conversion; it
 * is what tells the CRM this is an international number rather than a local one
 * whose country nobody recorded, and their cross-country duplicate check reads
 * exactly that distinction.
 */
export function e164From(waId: string): string | undefined {
  const digits = waId.replace(/\D/g, '');
  return digits.length >= 10 ? `+${digits}` : undefined;
}

function trimmed(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function list(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out = values.map((v) => String(v).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * Everything the CRM is given about one candidate.
 *
 * Note what is absent and stays absent: `aadhaarNumber` and `panNumber`. They
 * are on our record because a documentation officer needs them, and the CRM has
 * no screen that shows them and no workflow that reads them. Copying an
 * identifier into a second database for no reason is exposure bought with
 * nothing (§15, §16).
 *
 * The passport *is* sent. Overseas placement turns on whether a passport is in
 * date, and that is a question the CRM is asked.
 */
export function toCrmPayload(
  candidate: CandidateDoc,
  phoneNumberId: string,
  /**
   * The CV, identity and job sections, where the caller has read them.
   *
   * Optional because building them costs a database read and two callers do not
   * want one: `verify:crm`, which is checking the mapping rather than a real
   * candidate, and anything constructing a payload from a record it already
   * holds in full. An absent snapshot sends the profile alone, which is what
   * this function did before those sections existed.
   */
  snapshot?: CrmSnapshot,
): CrmCandidatePayload {
  const p = candidate.profile ?? {};

  const profile: CrmProfile = {
    // Their only required field. Falls back to the WhatsApp display name, and
    // then to the number, because a candidate who reached registration without
    // a readable name is still a person the CRM has to be able to open.
    full_name: trimmed(p.fullName) ?? trimmed(candidate.profileName) ?? candidate.waId,

    phone: e164From(candidate.waId),
    phone_e164: e164From(candidate.waId),

    // Residence. Three fields on our side, and their `location` is the readable
    // one-liner a recruiter actually looks at.
    city: trimmed(p.currentCity),
    country: trimmed(p.currentCountry) ?? 'India',
    location: [trimmed(p.currentCity), trimmed(p.currentState)].filter(Boolean).join(', ') ||
      undefined,

    // Destination, kept strictly apart from residence above. Undefined for
    // candidates whose answer was a region rather than a country — see
    // `destinationCountryOf`, which refuses to invent one.
    destination_country: destinationCountryOf(candidate),

    // What they want, twice over: the controlled value the CV policy reads, and
    // their own words for a person to read (§27).
    job_category: trimmed(p.jobCategory),
    job_preference: trimmed(p.desiredOccupation) ?? trimmed(p.currentOccupation),

    // Machinery first: on a blue-collar profile the machines someone has run
    // are the specific claim, and the general skills list is the fallback.
    trade_skills: list(p.machinery) ?? list(p.skills),
    certifications: list(p.certifications),

    // The band as a band. Never coerced into their numeric field — "3_5" is a
    // range the candidate chose, and turning it into 4.0 would put a figure on
    // the record they never gave. The numeric field is filled only when a CV
    // actually stated one.
    total_experience_band: trimmed(p.totalExperienceBand),
    total_experience_years:
      typeof p.totalExperienceYears === 'number' ? p.totalExperienceYears : undefined,

    passport_number: trimmed(p.passportNumber),
    passport_expiry: trimmed(p.passportExpiry),
  };

  // Undefined keys are dropped rather than sent as nulls: the CRM treats an
  // absent field as "not stated" and a null as "stated to be nothing", and on a
  // re-registration that difference decides whether an existing value survives.
  for (const key of Object.keys(profile) as Array<keyof CrmProfile>) {
    if (profile[key] === undefined) delete profile[key];
  }

  return {
    source: 'whatsapp',
    profile,
    idempotency_key: idempotencyKeyFor(candidate, phoneNumberId),
    ...(typeof p.cvRequired === 'boolean' ? { cv_required_claim: p.cvRequired } : {}),
    registration: registrationStateOf(candidate),
    ...(snapshot?.cv ? { cv: snapshot.cv } : {}),
    ...(snapshot?.identity ? { identity: snapshot.identity } : {}),
    ...(snapshot?.job ? { job: snapshot.job } : {}),
  };
}

/**
 * How far through the conversation this candidate is.
 *
 * Derived rather than stored: `stage` is the conversation's own state machine
 * and "complete" is one value of it, so keeping a second flag beside it would
 * be two facts that can disagree.
 */
export function registrationStateOf(candidate: CandidateDoc): CrmRegistrationState {
  const outstanding = documentsStillToAskFor(candidate);

  const state: CrmRegistrationState = {
    complete: candidate.stage === 'REGISTRATION_COMPLETED',
    // Only two branches ever reach the CRM. A business enquiry is filed
    // elsewhere and a tracking lookup is not a record at all.
    enquiry: candidate.enquiry === 'staff' ? 'staff' : 'apply',
    assignable: assignableFor(candidate),
    stage: candidate.stage,
    status: candidate.status,
    application_id: trimmed(candidate.candidateId),
    language: trimmed(candidate.language),
    consent_at: candidate.consent?.given ? candidate.consent.at?.toISOString() : undefined,
    started_at: candidate.createdAt?.toISOString(),
    updated_at: candidate.updatedAt?.toISOString(),
    completed_at: candidate.completedAt?.toISOString(),
    outstanding_documents: outstanding.length ? outstanding : undefined,
  };

  for (const key of Object.keys(state) as Array<keyof CrmRegistrationState>) {
    if (state[key] === undefined) delete state[key];
  }
  return state;
}

/**
 * Whether the CRM may put this record in front of a person yet.
 *
 * The conditions are spelled out on `CrmRegistrationState.assignable`; this is
 * where they are applied. Exported because it is a rule rather than a
 * formatting detail, and a rule is worth testing directly.
 */
export function assignableFor(candidate: CandidateDoc): boolean {
  // Finished is finished. Nothing below can make it less true.
  if (candidate.stage === 'REGISTRATION_COMPLETED') return true;

  // §4, again and without exception. The consent gate on the sync already stops
  // this record leaving, and saying it here too means a payload built anywhere
  // else cannot claim otherwise.
  if (!candidate.consent?.given) return false;

  // Not a candidate at all (§2). Neither of these is synced today; the guard is
  // here so that a future caller cannot make one assignable by accident.
  if (candidate.enquiry === 'b2b' || candidate.enquiry === 'track') return false;

  const p = candidate.profile ?? {};

  // Somebody to ask for by name. `profile.full_name` falls back to the WhatsApp
  // id so the CRM can always open the record; that fallback is not a name and
  // is not accepted here.
  const named = !!(trimmed(p.fullName) ?? trimmed(candidate.profileName));

  // And something they have actually asked for. Any one of the three is enough:
  // a destination alone tells a recruiter whether this is theirs, and so does a
  // job.
  const wants = !!(
    trimmed(p.countryPreference) ??
    trimmed(p.jobCategory) ??
    trimmed(p.desiredOccupation)
  );

  return named && wants;
}

/**
 * The documents this conversation is still going to ask for.
 *
 * Asked of the flow rather than of the checklist, and the difference is the
 * whole value of the field. The checklist holds a slot for every kind of
 * document the system knows about — a B2B contact's company registration
 * certificate, a loose certificate that only exists so an unprompted upload has
 * somewhere to go — and none of those will ever be put to this candidate. A
 * recruiter reading "still to come: company registration certificate" against a
 * welder would reasonably conclude the bot was broken.
 *
 * So: the document steps this candidate's own flow contains, that apply to
 * them, and that they have not answered. Which is exactly the list of things
 * the bot has left to ask.
 */
function documentsStillToAskFor(candidate: CandidateDoc): string[] {
  const outstanding: string[] = [];

  for (const step of stepsFor(candidate)) {
    if (step.input !== 'document' || !step.document) continue;
    if (step.when && !step.when(candidate)) continue;
    if (step.satisfied(candidate)) continue;
    if (!outstanding.includes(step.document)) outstanding.push(step.document);
  }

  return outstanding;
}
