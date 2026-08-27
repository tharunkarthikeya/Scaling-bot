/**
 * The three sections of a candidate that live outside `profile`.
 *
 * `mapping.ts` turns our flat profile into the CRM's flat profile, field by
 * field. That covers the summary a recruiter reads at the top of the screen and
 * nothing else — and the screen has three more panels on it:
 *
 *   cv        the CV as the extractor read it: employers, dates, education,
 *             certificates. The email side of the CRM has had this since it
 *             existed, because a résumé arriving by email is parsed into that
 *             shape. A résumé arriving by WhatsApp was flattened into six
 *             profile fields and the rest was dropped on our side of the wire.
 *   identity  the Aadhaar and the passport, as their own extractors read them.
 *             Filed against their own records in the CRM, exactly as the email
 *             pipeline files them, and never onto the candidate profile.
 *   job       what the candidate was asked about the work — the trade
 *             questions, the country and how strictly they mean it, the job
 *             itself, and when they can start.
 *
 * Two rules run through all of it.
 *
 * **Questions travel with their answers.** A recruiter reading "3 to 5" needs
 * to know it answers "how many years have you worked in this trade?", and a
 * generated question (§8) exists only on this record — the CRM has never seen
 * its text. So every answer carries the question that produced it, in English,
 * along with the candidate's own wording where they typed rather than tapped.
 *
 * **Nothing is invented.** A field the extractor did not produce is absent, not
 * empty: the CRM reads an absent field as "not stated" and an empty one as
 * "stated to be nothing", and on a partial sync — where most fields are absent
 * most of the time — that difference decides whether tomorrow's answer is
 * allowed to fill it in.
 */

import type {
  CandidateDoc,
  DocumentUpload,
  GeneratedQuestion,
} from '../db/models.js';
import { documentsFor } from '../db/models.js';
import { logger } from '../logger.js';
import { acceptedChoices } from '../conversation/render.js';
import { labelFor, stepById, type FlowStep } from '../conversation/flow.js';
import { TRADE_PACKS } from '../conversation/trades.js';
import { destinationCountryOf } from '../conversation/flow.js';
import { taxonomyCountryName } from './taxonomy.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * The shapes the CRM stores
 *
 * Their names, not ours — these mirror `app/core/models.py` on the other side,
 * so what arrives needs no translation once it is through the door.
 * ───────────────────────────────────────────────────────────────────────────*/

export interface CrmWorkExperience {
  company?: string;
  designation?: string;
  title?: string;
  start_date?: string;
  end_date?: string;
  location?: string;
  country?: string;
  is_overseas?: boolean;
  duration_human?: string;
  duration_months?: number;
  description?: string;
}

export interface CrmEducation {
  institution?: string;
  board_or_university?: string;
  degree?: string;
  field_of_study?: string;
  start_date?: string;
  end_date?: string;
  passing_year?: string;
  grade?: string;
}

export interface CrmTradeLicense {
  name?: string;
  number?: string;
  issuer?: string;
  issue_date?: string;
  expiry_date?: string;
}

export interface CrmProject {
  name?: string;
  description?: string;
  technologies?: string[];
  url?: string;
}

/**
 * The CV, in the shape the CRM already keeps résumés in.
 *
 * Deliberately the same field names the email pipeline's parser produces, so a
 * recruiter opening a WhatsApp candidate and an emailed one is reading the same
 * screen rather than two that happen to be about the same thing.
 */
export interface CrmCvSection {
  /** Which file this was read out of, so the panel can name its source. */
  filename?: string;
  mime_type?: string;
  sha256?: string;
  uploaded_at?: string;
  extracted_at?: string;
  /**
   * The extractor's own score, where it gives one. The résumé extractor does
   * not, and this is left absent rather than filled with a number nobody
   * measured — an unscored extraction must never read as a verified one.
   */
  confidence?: number | null;
  needs_review?: boolean;

  full_name?: string;
  email?: string;
  phone?: string;
  phone_numbers?: string[];
  location?: string;
  current_company?: string;
  current_designation?: string;
  industry?: string;
  resume_summary?: string;

  skills?: string[];
  technical_skills?: string[];
  trade_skills?: string[];
  languages?: string[];
  certifications?: string[];
  achievements?: string[];

  work_experience?: CrmWorkExperience[];
  education?: CrmEducation[];
  licenses?: CrmTradeLicense[];
  projects?: CrmProject[];

  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;

  total_experience_years?: number;
  total_experience_band?: string;

  /**
   * The extractor's answer, verbatim.
   *
   * Kept for the same reason the CRM keeps it on the email side: every field
   * above is derived from it, so a mapping mistake made here is recoverable
   * there without asking the candidate for their CV again.
   */
  raw_ocr?: unknown;
}

/**
 * One identity document, as its extractor read it.
 *
 * `result` is the payload untouched, because the CRM already has the code that
 * projects an Aadhaar or a passport out of exactly this shape — the email
 * pipeline feeds `store_aadhaar_record` and `store_passport_record` the same
 * thing. Mapping it here would mean two implementations of one projection, and
 * the one over there is the one that has been in front of recruiters.
 *
 * The number is inside `result`. That is deliberate and it is the arrangement
 * that already exists: the CRM files these in their own collections, masks them
 * for everybody but an administrator, and keeps them off the candidate document
 * that the recruiter list projects wholesale.
 */
export interface CrmIdentityDocument {
  document_type: 'aadhaar' | 'passport';
  /**
   * Our upload id.
   *
   * Doubles as the CRM's natural key for the record, so re-sending the same
   * document — every partial sync does — overwrites its own row rather than
   * adding another. The email pipeline keys on the message and attachment it
   * came off; this is the same idea with the identifiers we have.
   */
  record_id: string;
  /** Which slot it arrived in: `aadhaar`, `aadhaar_back`, `passport`. */
  slot: string;
  filename?: string;
  mime_type?: string;
  sha256?: string;
  uploaded_at?: string;
  extracted_at?: string;
  result: unknown;
}

export interface CrmIdentitySection {
  aadhaar?: CrmIdentityDocument[];
  passport?: CrmIdentityDocument[];
}

/** One question the bot asked and the answer it got. */
export interface CrmAnsweredQuestion {
  /** The step or trade-question id. Stable, so an answer can be found again. */
  id: string;
  /** The question as it was put, in English. */
  question: string;
  /** The answer, as labels rather than option ids. */
  answer: string;
  /** The candidate's own wording, where they typed rather than tapped (§27). */
  raw?: string;
}

/**
 * Everything the conversation established about the work.
 *
 * The panel this fills is new, and what goes in it is what the agency actually
 * decides on: what the candidate can do, where they will go and whether that is
 * negotiable, what they are applying for, and when they can start.
 */
export interface CrmJobSection {
  /** The job they want, in their own words. */
  job?: string;
  /** The same thing as a controlled value, which the CV policy keys on. */
  job_category?: string;
  /** The category's own title, for a person to read. */
  job_category_title?: string;

  course_or_trade?: {
    education?: string;
    /** The course or trade they studied — ITI Welder, Diploma in Mechanical. */
    course?: string;
    primary_trade?: string;
    primary_trade_title?: string;
    /** Which specialist question packs were selected for them (§8). */
    trade_packs?: string[];
    /** Every trade question asked, packed or written for them, with its answer. */
    questions?: CrmAnsweredQuestion[];
  };

  country?: {
    /** The option they chose — a country id, or a region. */
    preference?: string;
    /** One actual country, where the answer named one. Never a region. */
    destination_country?: string;
    /** The countries they picked, where the question let them pick several. */
    selected?: string[];
    selected_names?: string[];
    /**
     * How strictly they mean it.
     *
     * `strict` is the one that changes what may be done with the record: a
     * candidate who said so must never be shortlisted outside their list
     * without being asked first (§10).
     */
    strictness?: string;
    strict: boolean;
  };

  /** The job-preference questions and their answers, in the order they were asked. */
  questions?: CrmAnsweredQuestion[];

  availability?: {
    /** The band they chose — immediately, within 15 days, and so on. */
    band?: string;
    /** The date they gave, where they gave one. */
    date?: string;
    /** Their own words, where they typed rather than tapped. */
    note?: string;
  };
}

export interface CrmSnapshot {
  cv?: CrmCvSection;
  identity?: CrmIdentitySection;
  job?: CrmJobSection;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ───────────────────────────────────────────────────────────────────────────*/

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.\-]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** The first key of `keys` that yields a usable string. */
function pick(source: unknown, ...keys: string[]): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const found = text(record[key]);
    if (found) return found;
  }
  return undefined;
}

/** Whatever `value` is, as an array — a bare object counts as one entry. */
function rows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
  }
  if (value && typeof value === 'object') return [value as Record<string, unknown>];
  return [];
}

/**
 * A list of strings out of whatever the extractor produced.
 *
 * Résumé extractors are inconsistent about this in a way that is not worth
 * fighting: `certifications` comes back as a list of strings from one document
 * and a list of `{name}` objects from the next. Both are the same information
 * and both are read.
 */
function strings(value: unknown, ...keys: string[]): string[] | undefined {
  const out: string[] = [];

  for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
    if (typeof item === 'string' || typeof item === 'number') {
      const found = text(item);
      if (found) out.push(found);
      continue;
    }
    const found = keys.length ? pick(item, ...keys) : undefined;
    if (found) out.push(found);
  }

  // Case-insensitively distinct, first spelling wins. A CV that lists "TIG" and
  // "tig" is claiming one skill.
  const seen = new Set<string>();
  const distinct = out.filter((entry) => {
    const key = entry.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return distinct.length ? distinct : undefined;
}

/**
 * Drops the keys whose value is undefined, and the object itself if nothing is
 * left.
 *
 * The CRM reads an absent field as "not stated" and a present-but-empty one as
 * "stated to be nothing", and on a partial sync — where most fields are absent
 * most of the time — that difference decides whether tomorrow's answer is
 * allowed to fill in today's blank. So a section nobody has answered anything
 * in is not sent at all rather than sent as `{}`.
 */
function pruned<T extends object>(value: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    out[key] = entry;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

function iso(value: Date | undefined): string | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The CV
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * The résumé extractor's payload in the CRM's résumé shape.
 *
 * Read defensively throughout. The extractor names its employment history
 * `experience` on one response and `work_experience` on the next, and a mapper
 * that knows one spelling silently produces an empty work history for half the
 * candidates — which looks exactly like a candidate with no work history.
 */
export function cvSectionFrom(upload: DocumentUpload): CrmCvSection | undefined {
  const raw = upload.ocr?.raw as Record<string, unknown> | undefined;

  const base: CrmCvSection = {
    filename: upload.originalFilename,
    mime_type: upload.mimeType,
    sha256: upload.sha256,
    uploaded_at: iso(upload.createdAt),
    extracted_at: iso(upload.ocr?.finishedAt),
    confidence: upload.ocr?.confidence ?? undefined,
    needs_review: upload.ocr?.needsReview,
  };

  // The file is on record even when nothing could be read off it. A panel that
  // says "CV received, not yet readable" is worth more to a recruiter than no
  // panel, and it is the difference between a candidate who sent nothing and
  // one whose scan was too dark.
  if (!raw || typeof raw !== 'object') return pruned(base);

  const contact = (raw.contact ?? {}) as Record<string, unknown>;
  const personal = (raw.personal_info ?? raw.personal ?? {}) as Record<string, unknown>;

  const history =
    raw.experience ??
    raw.work_experience ??
    raw.employment ??
    raw.experiences ??
    raw.employment_history;

  const schooling = raw.education ?? raw.educations ?? raw.qualifications ?? raw.academics;

  const section: CrmCvSection = {
    ...base,

    full_name: text(raw.name) ?? text(raw.full_name),
    email: strings(contact.emails, 'email', 'value')?.[0] ?? text(contact.email),
    phone: strings(contact.phones, 'phone', 'number', 'value')?.[0] ?? text(contact.phone),
    phone_numbers: strings(contact.phones, 'phone', 'number', 'value'),
    location: text(contact.address) ?? text(raw.location) ?? text(raw.address),

    current_designation: text(raw.designation) ?? text(raw.current_designation),
    current_company: text(raw.current_company) ?? text(raw.company),
    industry: text(raw.industry),
    resume_summary: text(raw.summary) ?? text(raw.resume_summary) ?? text(raw.objective),

    skills: strings(raw.skills, 'name', 'skill'),
    technical_skills: strings(raw.technical_skills, 'name', 'skill'),
    // Machinery and processes are the specific claim on a blue-collar CV; a
    // general skills list flattens exactly that away.
    trade_skills: strings(
      raw.machinery ?? raw.equipment ?? raw.machines ?? raw.processes ?? raw.trade_skills,
      'name',
      'machine',
      'process',
      'equipment',
    ),
    languages: strings(raw.languages, 'name', 'language'),
    certifications: strings(
      raw.certifications ?? raw.certificates,
      'name',
      'title',
      'certification',
      'certificate',
    ),
    achievements: strings(raw.achievements ?? raw.awards, 'name', 'title', 'description'),

    work_experience: workExperienceFrom(history),
    education: educationFrom(schooling),
    licenses: licencesFrom(raw.licenses ?? raw.licences),
    projects: projectsFrom(raw.projects),

    linkedin_url: text(contact.linkedin) ?? text(raw.linkedin),
    github_url: text(contact.github) ?? text(raw.github),
    portfolio_url: text(contact.portfolio) ?? text(raw.portfolio),

    total_experience_years: num(raw.total_experience_years),

    raw_ocr: raw,
  };

  // Read off the CV and worth having on the panel, but not fields of their own
  // in the CRM's résumé shape — they go where anything else unschematised goes.
  const extras = pruned({
    date_of_birth: text(personal.date_of_birth),
    gender: text(personal.gender),
    nationality: text(personal.nationality),
    father_name: text(personal.father_name),
    marital_status: text(personal.marital_status),
    total_experience_human: text(raw.total_experience_human),
    indian_experience_human: text(raw.indian_experience_human),
    overseas_experience_human: text(raw.overseas_experience_human),
    highest_qualification: text(raw.highest_qualification),
  });
  if (extras) (section as Record<string, unknown>).additional_info = extras;

  return pruned(section);
}

function workExperienceFrom(value: unknown): CrmWorkExperience[] | undefined {
  const out = rows(value)
    .map((row) =>
      pruned<CrmWorkExperience>({
        company: pick(row, 'company', 'company_name', 'employer', 'employer_name', 'organisation', 'organization'),
        designation: pick(row, 'designation', 'role', 'position'),
        title: pick(row, 'title', 'job_title'),
        start_date: pick(row, 'start_date', 'from', 'start', 'from_date'),
        end_date: pick(row, 'end_date', 'to', 'end', 'to_date'),
        location: pick(row, 'location', 'city', 'place'),
        country: pick(row, 'country'),
        is_overseas: bool(row.is_overseas ?? row.overseas),
        duration_human: pick(row, 'duration_human', 'duration'),
        duration_months: num(row.duration_months),
        description: pick(row, 'description', 'responsibilities', 'summary'),
      }),
    )
    .filter((row): row is CrmWorkExperience => !!row);

  return out.length ? out : undefined;
}

function educationFrom(value: unknown): CrmEducation[] | undefined {
  const out = rows(value)
    .map((row) =>
      pruned<CrmEducation>({
        institution: pick(row, 'institution', 'school', 'college', 'institute'),
        board_or_university: pick(row, 'board_or_university', 'board', 'university'),
        degree: pick(row, 'degree', 'qualification', 'course', 'name'),
        field_of_study: pick(row, 'field_of_study', 'field', 'specialisation', 'specialization', 'branch', 'trade'),
        start_date: pick(row, 'start_date', 'from', 'start'),
        end_date: pick(row, 'end_date', 'to', 'end'),
        passing_year: pick(row, 'passing_year', 'year', 'year_of_passing', 'completed'),
        grade: pick(row, 'grade', 'percentage', 'cgpa', 'marks'),
      }),
    )
    .filter((row): row is CrmEducation => !!row);

  return out.length ? out : undefined;
}

function licencesFrom(value: unknown): CrmTradeLicense[] | undefined {
  const out = rows(value)
    .map((row) =>
      pruned<CrmTradeLicense>({
        name: pick(row, 'name', 'title', 'licence', 'license', 'type'),
        number: pick(row, 'number', 'licence_number', 'license_number', 'id'),
        issuer: pick(row, 'issuer', 'issued_by', 'authority'),
        issue_date: pick(row, 'issue_date', 'issued_on', 'from'),
        expiry_date: pick(row, 'expiry_date', 'expires_on', 'valid_until', 'to'),
      }),
    )
    .filter((row): row is CrmTradeLicense => !!row);

  return out.length ? out : undefined;
}

function projectsFrom(value: unknown): CrmProject[] | undefined {
  const out = rows(value)
    .map((row) =>
      pruned<CrmProject>({
        name: pick(row, 'name', 'title'),
        description: pick(row, 'description', 'summary'),
        technologies: strings(row.technologies ?? row.tech ?? row.stack, 'name'),
        url: pick(row, 'url', 'link'),
      }),
    )
    .filter((row): row is CrmProject => !!row);

  return out.length ? out : undefined;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The job section
 * ───────────────────────────────────────────────────────────────────────────*/

/** A step's question, in English. Generated questions carry their own text. */
function questionText(step: FlowStep, candidate: CandidateDoc): string | undefined {
  const generated = generatedFor(step.id, candidate);
  if (generated) return generated.prompt;
  return text(step.prompt.en);
}

function generatedFor(stepId: string, candidate: CandidateDoc): GeneratedQuestion | undefined {
  if (!stepId.startsWith('trade_extra:')) return undefined;
  const index = Number(stepId.slice('trade_extra:'.length));
  const questions = candidate.profile?.tradeQuestions as GeneratedQuestion[] | undefined;
  return Number.isInteger(index) ? questions?.[index] : undefined;
}

/**
 * An answer as a person reads it.
 *
 * Option ids are ours. "within_15" is a key in this repository and nothing at
 * all in the CRM, so what travels is the label the candidate was actually
 * shown. An id with no label left — an option removed from the flow since they
 * answered — is sent as it stands rather than dropped: a value nobody can
 * decode is still better than a question that appears never to have been asked.
 */
function answerText(
  step: FlowStep,
  candidate: CandidateDoc,
  values: string[],
): string | undefined {
  if (!values.length) return undefined;

  let options: Array<{ id: string; label: { en: string } }> = [];
  try {
    // Everything the step accepts, not only what it rendered. A country or a job
    // past WhatsApp's ten-row ceiling is a perfectly ordinary answer — the
    // candidate typed it — and reading it back from the rendered rows alone
    // would put the option id on a recruiter's screen instead of its name.
    options = acceptedChoices(step, candidate) as Array<{ id: string; label: { en: string } }>;
  } catch {
    // `acceptedChoices` reaches into the taxonomy cache and the candidate's own
    // generated questions. A snapshot is never worth failing over, and the ids
    // below are still readable.
    options = [];
  }

  const labels = values.map((value) => {
    const option = options.find((choice) => choice.id === value);
    return (
      text(option?.label?.en) ??
      text(labelFor(value, step.id)?.en) ??
      text(labelFor(value)?.en) ??
      value
    );
  });

  return labels.join(', ') || undefined;
}

/** One answered question, or nothing when the candidate has not answered it. */
function answered(
  candidate: CandidateDoc,
  stepId: string,
  values: string[] | undefined,
  rawField?: string,
): CrmAnsweredQuestion | undefined {
  const step = stepById(stepId);
  if (!step || !values?.length) return undefined;

  const question = questionText(step, candidate);
  const answer = answerText(step, candidate, values);
  if (!question || !answer) return undefined;

  return pruned<CrmAnsweredQuestion>({
    id: stepId,
    question,
    answer,
    raw: rawField ? text(candidate.fieldMeta?.[rawField]?.raw) : undefined,
  }) as CrmAnsweredQuestion | undefined;
}

/** A profile value as the list of option ids it stands for. */
function values(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.map((entry) => text(entry)).filter((entry): entry is string => !!entry);
    return out.length ? out : undefined;
  }
  const single = text(value);
  return single ? [single] : undefined;
}

/**
 * The job-preference questions, in the order the flow puts them.
 *
 * Listed rather than derived from the section, because "job preference" as the
 * flow groups it also contains the experience questions — and a recruiter
 * looking at the job panel wants what the candidate is applying for, not how
 * long they have been welding. The experience questions have their own place on
 * the profile.
 */
const JOB_QUESTION_STEPS: Array<{ step: string; field: string }> = [
  { step: 'job_category', field: 'jobCategory' },
  { step: 'job_preference', field: 'workTypePreference' },
  { step: 'general_work', field: 'generalWorkWillingness' },
  { step: 'general_jobs', field: 'generalJobs' },
  { step: 'desired_job', field: 'desiredOccupation' },
  { step: 'training_willingness', field: 'trainingWillingness' },
  // When they can start. Listed here as well as broken out under
  // `availability` below, because the panel shows both: the field for the
  // recruiter scanning a row of candidates, and the question-and-answer for
  // the one reading this candidate's conversation.
  { step: 'availability', field: 'availability' },
  { step: 'availability_date', field: 'availabilityDate' },
];

/** The course-and-trade questions, same idea. */
const TRADE_QUESTION_STEPS: Array<{ step: string; field: string }> = [
  { step: 'education', field: 'education' },
  { step: 'education_course', field: 'educationCourse' },
  { step: 'main_trade', field: 'primaryTrade' },
  { step: 'total_experience', field: 'totalExperienceBand' },
  { step: 'overseas_countries', field: 'overseasCountries' },
];

/**
 * Where they want to go, or nothing at all when they have not said.
 *
 * Built apart from the rest of the section because of `strict`, which is a
 * boolean and therefore always has a value — and a `strict: false` on a
 * candidate who has never been asked reads as "open to anywhere", which is an
 * answer they did not give. So the flag is only produced once something about
 * the country question has actually been answered, and an unanswered question
 * sends no country block at all.
 */
function countryOf(candidate: CandidateDoc): CrmJobSection['country'] {
  const profile = candidate.profile ?? {};
  const selected = values(profile.selectedCountries);

  const answered = pruned({
    preference: text(profile.countryPreference),
    destination_country: destinationCountryOf(candidate),
    selected,
    selected_names: selected
      ?.map((id) => taxonomyCountryName(id) ?? text(labelFor(id, 'selected_countries')?.en))
      .filter((name): name is string => !!name),
    strictness: text(profile.countryStrictness),
  });

  if (!answered) return undefined;

  return {
    ...answered,
    // Hoisted out of the answer rather than left for the CRM to parse. It is
    // the one thing on this panel that constrains what may be done with the
    // candidate — §10 forbids shortlisting a strict candidate outside their
    // list without asking — and a rule that important should not depend on
    // matching a string on the far side of a wire.
    strict: profile.countryStrictness === 'strict',
  };
}

export function jobSectionOf(candidate: CandidateDoc): CrmJobSection | undefined {
  const profile = candidate.profile ?? {};
  const answers = (profile.tradeAnswers ?? {}) as Record<string, string[]>;

  const tradeQuestions: CrmAnsweredQuestion[] = [];

  for (const { step, field } of TRADE_QUESTION_STEPS) {
    const entry = answered(candidate, step, values(profile[field]), field);
    if (entry) tradeQuestions.push(entry);
  }

  // The specialist packs (§8). Their question text lives in `trades.ts` and
  // their answers under the question's own id, so neither can be found from the
  // step id alone.
  for (const packId of (profile.tradePacks as string[] | undefined) ?? []) {
    const pack = TRADE_PACKS.find((candidatePack) => candidatePack.id === packId);
    if (!pack) continue;

    for (const question of pack.questions) {
      const value = answers[question.id];
      if (!value?.length) continue;

      const stepId = `trade:${packId}:${question.id}`;
      const step = stepById(stepId);
      const answer = step
        ? answerText(step, candidate, value)
        : value.join(', ');

      tradeQuestions.push({
        id: stepId,
        question: question.prompt.en,
        answer: answer ?? value.join(', '),
      });
    }
  }

  // Questions written for this one candidate, because no pack covered their job
  // (§8). They exist nowhere else — the CRM has never seen the text — so the
  // question travelling with the answer is the only thing that makes the answer
  // mean anything.
  const generated = (profile.tradeQuestions as GeneratedQuestion[] | undefined) ?? [];
  generated.forEach((question, index) => {
    const value = answers[question.id];
    if (!value?.length) return;
    tradeQuestions.push({
      id: `trade_extra:${index}`,
      question: question.prompt,
      answer: value.join(', '),
    });
  });

  const jobQuestions: CrmAnsweredQuestion[] = [];
  for (const { step, field } of JOB_QUESTION_STEPS) {
    const entry = answered(candidate, step, values(profile[field]), field);
    if (entry) jobQuestions.push(entry);
  }

  const section: CrmJobSection = {
    job: text(profile.desiredOccupation) ?? text(profile.currentOccupation),
    job_category: text(profile.jobCategory),
    job_category_title: text(labelFor(String(profile.jobCategory), 'job_category')?.en),

    course_or_trade: pruned({
      education: text(profile.education),
      course: text(profile.educationCourse),
      primary_trade: text(profile.primaryTrade),
      primary_trade_title: text(labelFor(String(profile.primaryTrade), 'main_trade')?.en),
      trade_packs: profile.tradePacks as string[] | undefined,
      questions: tradeQuestions.length ? tradeQuestions : undefined,
    }),

    country: countryOf(candidate),

    questions: jobQuestions.length ? jobQuestions : undefined,

    availability: pruned({
      // The label, not the option id. "within_15" is a key in this repository
      // and nothing at all in the CRM, and a recruiter reading it off a profile
      // is reading our internals.
      band:
        text(labelFor(String(profile.availability), 'availability')?.en) ??
        text(profile.availability),
      date: text(profile.availabilityDate),
      note: text(profile.availabilityNote) ?? text(candidate.fieldMeta?.availability?.raw),
    }),
  };

  return pruned(section);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Assembly
 * ───────────────────────────────────────────────────────────────────────────*/

/** Slots whose contents are an Aadhaar, whatever the slot is called. */
const AADHAAR_SLOTS = ['aadhaar', 'aadhaar_back'] as const;

/** The current upload in a section — the last one nothing has superseded. */
function current(uploads: DocumentUpload[] | undefined): DocumentUpload | undefined {
  return [...(uploads ?? [])].reverse().find((upload) => !upload.supersededAt);
}

function identityDocument(
  slot: string,
  documentType: 'aadhaar' | 'passport',
  upload: DocumentUpload | undefined,
): CrmIdentityDocument | undefined {
  // Nothing was read off it, so there is nothing for the CRM to file. The slot
  // still shows on our side as holding a document; a row over there with no
  // fields would say the extraction failed, which it may not have — it may
  // simply not have run yet.
  if (!upload?.ocr?.raw) return undefined;

  return {
    document_type: documentType,
    record_id: upload.uploadId.toHexString(),
    slot,
    filename: upload.originalFilename,
    mime_type: upload.mimeType,
    sha256: upload.sha256,
    uploaded_at: iso(upload.createdAt),
    extracted_at: iso(upload.ocr.finishedAt),
    result: upload.ocr.raw,
  };
}

/**
 * The CV, the identity documents and the job answers for one candidate.
 *
 * Reads the documents record, so it is a database call and the only reason this
 * is not part of `toCrmPayload`. Returns as much as it can and never throws: a
 * snapshot that cannot be built must not stop a candidate reaching the CRM,
 * because the profile alone is already worth more to a recruiter than nothing.
 */
export async function snapshotFor(candidate: CandidateDoc): Promise<CrmSnapshot> {
  const snapshot: CrmSnapshot = {};

  try {
    snapshot.job = jobSectionOf(candidate);
  } catch (err) {
    logger.error({ err, waId: candidate.waId }, 'the job section could not be built');
  }

  try {
    const record = await documentsFor(candidate.waId, 'cv');
    if (!record) return snapshot;

    const cv = current(record.cv?.uploads);
    if (cv) snapshot.cv = cvSectionFrom(cv);

    const aadhaar = AADHAAR_SLOTS.map((slot) =>
      identityDocument(slot, 'aadhaar', current(record[slot]?.uploads)),
    ).filter((entry): entry is CrmIdentityDocument => !!entry);

    const passport = identityDocument('passport', 'passport', current(record.passport?.uploads));

    const identity = pruned<CrmIdentitySection>({
      aadhaar: aadhaar.length ? aadhaar : undefined,
      passport: passport ? [passport] : undefined,
    });
    if (identity) snapshot.identity = identity;
  } catch (err) {
    logger.error(
      { err, waId: candidate.waId },
      'the candidate’s documents could not be read; syncing the profile without them',
    );
  }

  return snapshot;
}
