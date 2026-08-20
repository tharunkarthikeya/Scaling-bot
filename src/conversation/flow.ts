/**
 * The registration flow (§2–§18).
 *
 * Every question the bot can ask, in order, with the answers it accepts and
 * what each answer means. The engine walks this list and asks the first step
 * that applies and is not already satisfied — so a detail already extracted
 * from a CV is never asked for again (§1), and a candidate who stops halfway
 * resumes exactly where they left off (§21) without being restarted.
 *
 * Reading a step:
 *
 *   when       whether this step applies at all. Skipped entirely when false —
 *              a driver is never asked about welding, a Gulf candidate is never
 *              asked for their PAN card.
 *   satisfied  whether we already know the answer, from any source.
 *   apply      what the answer means, as fields to write.
 *   clears     what an edit of this section must forget, so re-asking works.
 *
 * Nothing here decides *phrasing*. The prompt is the phrasing.
 */

import type { CandidateDoc, CandidateProfile, GeneratedQuestion } from '../db/models.js';
import type { Choice, Localised } from './language.js';
import {
  CHOICE_STAFF,
  CONFIRM_CHOICES,
  ENTRY_CHOICES,
  OTHER,
  WELCOME,
  render,
} from './copy.js';
import {
  DOCUMENTS,
  EUROPE_RUSSIA_COUNTRIES,
  EUROPE_RUSSIA_PREFERENCES,
  TUNABLES,
} from './rules.js';
import {
  answersFromEvidence,
  disambiguationFor,
  packById,
  resolvePacks,
  type TradeQuestion,
} from './trades.js';
import { MAX_GENERATED_QUESTIONS } from './tradeQuestions.js';
import { passportExpiryFlag } from './profile.js';
import {
  availabilityBand,
  experienceBand,
  normaliseEducation,
  parseDaysAway,
  parseYears,
} from './cv.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Types
 * ───────────────────────────────────────────────────────────────────────────*/

export type Section =
  | 'start'
  /** The B2B branch (§2). Nothing in it is part of registration. */
  | 'b2b'
  | 'language'
  | 'consent'
  | 'cv'
  | 'personal'
  | 'experience'
  | 'job_preference'
  | 'country'
  | 'availability'
  | 'passport'
  | 'documents'
  | 'confirm';

export type InputKind =
  /** One tap from `choices`. */
  | 'choice'
  /** Several taps from `choices`, ended by Done. */
  | 'multi_choice'
  /** Free text, stored as one value. */
  | 'text'
  /** Free text broken into named fields by the interpreter. */
  | 'structured'
  /** A date, normalised to YYYY-MM-DD. */
  | 'date'
  /** A month and year, normalised to MM/YYYY. */
  | 'month_year'
  /** A file. */
  | 'document';

export interface Answer {
  /** Chosen option ids, for choice and multi_choice steps. */
  ids?: string[];
  /** Normalised value, for text, date and month_year steps. */
  value?: string;
  /** Named parts, for structured steps. */
  fields?: Record<string, string>;
  /** Exactly what the candidate typed or said. Preserved alongside the standardised value (§27). */
  raw?: string;
  /**
   * True when the ids came from the candidate tapping an offered option.
   *
   * A tap and a model-classified sentence both arrive as ids, but they are not
   * the same evidence: tapping "Fabrication / Welding" says only which category
   * they are in, while typing "TIG welder" says what they actually do. §8 needs
   * to tell them apart to know whether it may narrow a category on its own.
   */
  tapped?: boolean;
}

export interface FlowStep {
  id: string;
  section: Section;
  prompt: Localised;
  /** A second line under the prompt — an example, usually. */
  hint?: Localised;
  input: InputKind;
  choices?: Choice[];
  /**
   * Answers the interpreter may return that are not rendered as taps. Lets the
   * flow understand "no" at a question that only offers "Yes" and "Talk to
   * staff", without putting a discouraging button on the screen.
   */
  hiddenChoices?: Choice[];
  /** Field names the interpreter should fill, for structured steps. */
  fields?: string[];
  /** Which checklist slot a document step is asking for. */
  document?: string;
  /**
   * This question is about work, so a named job, trade or skill is an answer.
   *
   * Candidates answer "what work are you looking for?" with "type writer",
   * "parota master" or "JCB operator" — the thing they actually do — rather
   * than with one of the broad categories on the screen. Without this the
   * interpreter reads a specific occupation as off-topic and the candidate is
   * told to contact staff about their own answer.
   *
   * The two modes differ in what the offered options *are*, which decides what
   * should happen to the job they named:
   *
   *   'category'  the options are categories of work, so a named job belongs
   *               inside one of them. "Hotel cook" is hospitality. Match it.
   *   'named'     the options are not job names — `job_preference` offers four
   *               ways work can relate to their current trade — so no option
   *               covers "type writer" and matching one silently discards what
   *               they said. Keep their wording as a value instead.
   *
   * The step must also be able to record free text; a flag alone only changes
   * the reading, not what is stored.
   */
  acceptsOccupation?: 'category' | 'named';
  /**
   * What a free-text answer to this step has to be about (§8).
   *
   * Declared on a specialist question whose subject is narrower than "some
   * text" — the CNC pack's machine question, and anything like it added later.
   * The interpreter is given the context and judges the answer against it, so
   * an answer about something else comes back `related` and is replied to
   * rather than recorded. See `TradeQuestion.expects` for why.
   */
  expects?: { context: string; examples?: string };
  /** Offer "Talk to staff" alongside the answers. Always available by typing (§24). */
  allowStaff?: boolean;
  /** Accept a photo, file or voice note as an answer as well as a tap or text. */
  allowMedia?: boolean;
  when?: (c: CandidateDoc) => boolean;
  satisfied: (c: CandidateDoc) => boolean;
  apply?: (a: Answer, c: CandidateDoc) => Partial<CandidateProfile>;
  /** Profile fields to clear when this step's section is edited (§18, §22). */
  clears?: string[];
}

const p = (c: CandidateDoc): CandidateProfile => c.profile ?? {};
const has = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

/* ─────────────────────────────────────────────────────────────────────────────
 * Predicates shared by several steps
 * ───────────────────────────────────────────────────────────────────────────*/

function normaliseCountry(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Whether the candidate is in the Europe/Russia identity-document branch (§13).
 *
 * Triggered by the preference they picked, or by naming a listed country when
 * they chose "Select countries". Deliberately not triggered by "Any country" —
 * asking for Aadhaar and PAN from someone open to anywhere would collect
 * identity documents we have no specific reason to hold.
 */
export function inEuropeRussiaBranch(c: CandidateDoc): boolean {
  const pref = p(c).countryPreference;
  if (pref && EUROPE_RUSSIA_PREFERENCES.includes(pref)) return true;

  for (const country of p(c).selectedCountries ?? []) {
    const n = normaliseCountry(country);
    if (EUROPE_RUSSIA_COUNTRIES.some((known) => n.includes(known))) return true;
  }
  return false;
}

/** Whether we should still be asking for `docId` in the document branch. */
function wantsDocument(c: CandidateDoc, docId: string): boolean {
  if (!inEuropeRussiaBranch(c)) return false;

  const availability = p(c).documentAvailability;
  // "Upload later" is a promise, not a refusal — the slot is marked pending and
  // staff chase it. Asking again in the same conversation would be pestering.
  if (availability === 'later') return false;
  if (availability === 'some') {
    return (p(c).availableDocuments ?? []).includes(docId);
  }
  return availability === 'all';
}

function documentSatisfied(c: CandidateDoc, docId: string): boolean {
  const slot = c.documents?.[docId];
  if (!slot) return false;
  return (
    slot.status === 'received' ||
    slot.status.startsWith('ocr_') ||
    slot.status === 'needs_review' ||
    slot.status === 'unavailable' ||
    slot.status === 'promised' ||
    slot.askedCount >= TUNABLES.maxAsksPerDocument
  );
}

/**
 * Whether a file actually arrived for this slot.
 *
 * Stricter than `documentSatisfied`, and for a different question. That one
 * asks "may the conversation move on?", which "I don't have one" and "I'll send
 * it tomorrow" both answer. This one asks "do we hold the document?", which
 * only a file answers — and it is what decides whether a question the document
 * would settle may be skipped. Skipping one on the strength of a promise would
 * leave the field empty and the question unasked.
 */
function documentOnFile(c: CandidateDoc, docId: string): boolean {
  const slot = c.documents?.[docId];
  if (!slot) return false;
  return (
    slot.status === 'received' ||
    slot.status === 'ocr_queued' ||
    slot.status === 'ocr_done' ||
    slot.status === 'ocr_failed' ||
    slot.status === 'needs_review'
  );
}

/**
 * The same, minus the "we have asked enough times" escape.
 *
 * That escape is what let the B2B branch walk past an Aadhaar it had just told
 * the contact was too blurred to read: the re-ask went out, the second attempt
 * failed too, the slot hit the ceiling, and running out of asks counted as an
 * answer — so the very next message asked for the back of the card, before the
 * contact had a chance to send anything.
 *
 * Here the only thing that satisfies the question is a file that arrived and
 * could be read, or the contact saying plainly that they cannot send one. An
 * unreadable upload leaves the question open, and `resumeAfterDocument` fetches
 * a person once asking again has stopped being useful.
 */
function b2bDocumentSatisfied(c: CandidateDoc, docId: string): boolean {
  const slot = c.documents?.[docId];
  if (!slot) return false;
  return (
    slot.status === 'received' ||
    slot.status === 'ocr_done' ||
    slot.status === 'ocr_failed' ||
    slot.status === 'needs_review' ||
    slot.status === 'unavailable' ||
    slot.status === 'promised'
  );
}

/** Everything the candidate has told us about their trade, in their own words. */
export function tradeSignals(c: CandidateDoc): Array<string | undefined> {
  const meta = c.fieldMeta ?? {};
  return [
    meta.primaryTrade?.raw,
    p(c).currentOccupation,
    (p(c).previousOccupations ?? []).join(' '),
    (p(c).skills ?? []).join(' '),
    (p(c).certifications ?? []).join(' '),
    // Names the actual kit — TIG, MIG, VMC, forklift — which is often the only
    // thing on a CV that separates a welder from a fabricator.
    (p(c).machinery ?? []).join(' '),
    c.profileName,
  ];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Choice sets
 * ───────────────────────────────────────────────────────────────────────────*/

export const EDUCATION_CHOICES: Choice[] = [
  { id: 'below_10', label: { en: 'Below 10th', ta: '10-ஆம் வகுப்புக்கு கீழ்', hi: '10वीं से कम', te: '10వ లోపు', ml: '10ന് താഴെ' } },
  { id: 'class_10', label: { en: '10th', ta: '10-ஆம் வகுப்பு', hi: '10वीं', te: '10వ తరగతి', ml: '10-ാം ക്ലാസ്' } },
  { id: 'class_12', label: { en: '12th', ta: '12-ஆம் வகுப்பு', hi: '12वीं', te: '12వ తరగతి', ml: '12-ാം ക്ലാസ്' } },
  { id: 'iti', label: { en: 'ITI', ta: 'ITI', hi: 'ITI', te: 'ITI', ml: 'ITI' } },
  { id: 'diploma', label: { en: 'Diploma', ta: 'டிப்ளோமா', hi: 'डिप्लोमा', te: 'డిప్లొమా', ml: 'ഡിപ്ലോമ' } },
  { id: 'graduate', label: { en: 'Graduate', ta: 'பட்டப்படிப்பு', hi: 'ग्रेजुएट', te: 'గ్రాడ్యుయేట్', ml: 'ബിരുദം' } },
  { id: 'other', label: OTHER },
];

export const TRADE_CHOICES: Choice[] = [
  {
    id: 'fabrication_welding',
    label: { en: 'Fabrication / Welding', ta: 'ஃபேப்ரிகேஷன்/வெல்டிங்', hi: 'फैब्रिकेशन/वेल्डिंग', te: 'ఫాబ్రికేషన్ / వెల్డింగ్', ml: 'ഫാബ്രിക്കേഷൻ / വെൽഡിംഗ്' },
  },
  { id: 'construction', label: { en: 'Construction', ta: 'கட்டுமானம்', hi: 'निर्माण कार्य', te: 'నిర్మాణం', ml: 'നിർമ്മാണം' } },
  {
    id: 'driver_operator',
    label: { en: 'Driver / Operator', ta: 'டிரைவர்/ஆபரேட்டர்', hi: 'ड्राइवर/ऑपरेटर', te: 'డ్రైవర్ / ఆపరేటర్', ml: 'ഡ്രൈവർ / ഓപ്പറേറ്റർ' },
  },
  {
    id: 'electrical_mechanical',
    label: { en: 'Electrical / Mechanical', ta: 'எலெக்ட்ரிகல்/மெக்கானிக்', hi: 'इलेक्ट्रिकल/मैकेनिकल', te: 'ఎలక్ట్రికల్ / మెకానికల్', ml: 'ഇലക്ട്രിക്കൽ/മെക്കാനിക്' },
  },
  {
    id: 'factory_warehouse',
    label: { en: 'Factory / Warehouse', ta: 'தொழிற்சாலை/கிடங்கு', hi: 'फैक्ट्री/वेयरहाउस', te: 'ఫ్యాక్టరీ / గోడాము', ml: 'ഫാക്ടറി / വെയർഹൗസ്' },
  },
  { id: 'hospitality', label: { en: 'Hospitality', ta: 'ஹாஸ்பிடாலிட்டி', hi: 'हॉस्पिटैलिटी', te: 'హాస్పిటాలిటీ', ml: 'ഹോസ്പിറ്റാലിറ്റി' } },
  { id: 'sales_retail', label: { en: 'Sales / Retail', ta: 'விற்பனை/ரீடெயில்', hi: 'सेल्स/रिटेल', te: 'సేల్స్ / రిటైల్', ml: 'സെയിൽസ് / റീട്ടെയിൽ' } },
  {
    id: 'cleaning_housekeeping',
    label: { en: 'Cleaning / Housekeeping', ta: 'க்ளீனிங்/ஹவுஸ்கீப்பிங்', hi: 'क्लीनिंग/हाउसकीपिंग', te: 'క్లీనింగ్ / హౌస్‌కీపింగ్', ml: 'ക്ലീനിങ്/ഹൗസ്കീപ്പിങ്' },
  },
  { id: 'fresher', label: { en: 'Fresher', ta: 'புதியவர்', hi: 'फ्रेशर', te: 'ఫ్రెషర్', ml: 'പുതുതായി ജോലി' } },
  { id: 'other', label: OTHER },
];

export const EXPERIENCE_CHOICES: Choice[] = [
  { id: 'fresher', label: { en: 'Fresher', ta: 'புதியவர்', hi: 'फ्रेशर', te: 'ఫ్రెషర్', ml: 'പുതുതായി ജോലി' } },
  { id: 'below_2', label: { en: 'Below 2 years', ta: '2 ஆண்டுக்கு கீழ்', hi: '2 साल से कम', te: '2 సంవత్సరాల కంటే తక్కువ', ml: '2 വർഷത്തിൽ താഴെ' } },
  { id: '2_5', label: { en: '2–5 years', ta: '2–5 ஆண்டுகள்', hi: '2–5 साल', te: '2–5 సంవత్సరాలు', ml: '2–5 വർഷം' } },
  { id: '5_10', label: { en: '5–10 years', ta: '5–10 ஆண்டுகள்', hi: '5–10 साल', te: '5–10 సంవత్సరాలు', ml: '5–10 വർഷം' } },
  { id: 'above_10', label: { en: 'Above 10 years', ta: '10 ஆண்டுக்கு மேல்', hi: '10 साल से ज़्यादा', te: '10 సంవత్సరాల కంటే ఎక్కువ', ml: '10 വർഷത്തിൽ കൂടുതൽ' } },
];

export const GENERAL_JOB_CHOICES: Choice[] = [
  { id: 'factory', label: { en: 'Factory', ta: 'தொழிற்சாலை', hi: 'फैक्ट्री', te: 'ఫ్యాక్టరీ', ml: 'ഫാക്ടറി' } },
  { id: 'warehouse', label: { en: 'Warehouse', ta: 'கிடங்கு', hi: 'वेयरहाउस', te: 'వేర్‌హౌస్', ml: 'വെയർഹൗസ്' } },
  { id: 'packing', label: { en: 'Packing', ta: 'பேக்கிங்', hi: 'पैकिंग', te: 'ప్యాకింగ్', ml: 'പാക്കിംഗ്' } },
  { id: 'helper', label: { en: 'General Helper', ta: 'ஹெல்பர்', hi: 'हेल्पर', te: 'జనరల్ హెల్పర్', ml: 'ജനറൽ ഹെൽപ്പർ' } },
  { id: 'construction', label: { en: 'Construction', ta: 'கட்டுமானம்', hi: 'निर्माण', te: 'నిర్మాణం', ml: 'നിർമ്മാണം' } },
  { id: 'cleaning', label: { en: 'Cleaning', ta: 'க்ளீனிங்', hi: 'क्लीनिंग', te: 'క్లీనింగ్', ml: 'ക്ലീനിംഗ്' } },
  { id: 'hospitality', label: { en: 'Hospitality', ta: 'ஹாஸ்பிடாலிட்டி', hi: 'हॉस्पिटैलिटी', te: 'హాస్పిటాలిటీ', ml: 'ഹോസ്പിറ്റാലിറ്റി' } },
  { id: 'delivery', label: { en: 'Delivery', ta: 'டெலிவரி', hi: 'डिलीवरी', te: 'డెలివరీ', ml: 'ഡെലിവറി' } },
  { id: 'other', label: OTHER },
];

export const COUNTRY_CHOICES: Choice[] = [
  // Labelled the way candidates say it — "Gulf countries", never "GCC". The
  // acronym is trade jargon; the people answering this question say Gulf, and
  // every other language here already did. The id stays `gcc`: it is written
  // into every record that has already answered this question, and renaming it
  // would orphan their stored preference.
  {
    id: 'gcc',
    label: {
      en: 'Gulf countries',
      ta: 'வளைகுடா நாடுகள்',
      hi: 'गल्फ देश',
      te: 'గల్ఫ్ దేశాలు',
      ml: 'ഗൾഫ് രാജ്യങ്ങൾ',
    },
  },
  { id: 'europe', label: { en: 'Europe', ta: 'ஐரோப்பா', hi: 'यूरोप', te: 'యూరప్', ml: 'യൂറോപ്പ്' } },
  { id: 'russia_cis', label: { en: 'Russia / CIS', ta: 'ரஷ்யா/CIS', hi: 'रूस/CIS', te: 'రష్యా / CIS', ml: 'റഷ്യ / CIS' } },
  // Two options, not one.
  //
  // These used to share a row as "Singapore / Malaysia", which was fine while
  // the answer was only a preference. It stopped being fine the moment the CRM
  // began deciding the CV requirement from the destination: a rule about
  // Malaysia cannot be applied to someone whose record says "Singapore or
  // Malaysia, we never asked". `destination_country` has to name one country,
  // so the question has to offer one country.
  {
    id: 'singapore',
    label: { en: 'Singapore', ta: 'சிங்கப்பூர்', hi: 'सिंगापुर', te: 'సింగపూర్', ml: 'സിംഗപ്പൂർ' },
  },
  {
    id: 'malaysia',
    label: { en: 'Malaysia', ta: 'மலேசியா', hi: 'मलेशिया', te: 'మలేషియా', ml: 'മലേഷ്യ' },
  },
  { id: 'any', label: { en: 'Any country', ta: 'எந்த நாடும்', hi: 'कोई भी देश', te: 'ఏ దేశమైనా', ml: 'ഏത് രാജ്യവും' } },
  {
    id: 'select',
    label: { en: 'Select countries', ta: 'நாடுகளைத் தேர்வு', hi: 'देश चुनें', te: 'దేశాలు ఎంచుకోండి', ml: 'രാജ്യങ്ങൾ തിരഞ്ഞെടുക്കൂ' },
  },
];

/**
 * The job a candidate is looking for, as a controlled value.
 *
 * Ten rows, which is WhatsApp's ceiling for a list. The ids deliberately match
 * `TRADE_CHOICES` wherever the same job appears in both, so one vocabulary
 * covers what a candidate *does* and what they *want* — and so the CRM does not
 * have to hold two mappings.
 *
 * This exists because the CV requirement is decided from it. A free-text answer
 * cannot be matched against a policy table: "General Worker", "general labour"
 * and "helper" are one job written three ways, and every unmatched spelling
 * falls through to the default, which looks like a working rule and is not one.
 * The candidate's own words are still kept — see `desiredOccupation` — they are
 * just not what the decision reads.
 */
export const JOB_CATEGORY_CHOICES: Choice[] = [
  {
    id: 'general_worker',
    label: { en: 'General worker / Helper', ta: 'பொது வேலை/ஹெல்பர்', hi: 'जनरल वर्कर/हेल्पर', te: 'జనరల్ వర్కర్ / హెల్పర్', ml: 'ജനറൽ വർക്കർ / ഹെൽപ്പർ' },
  },
  {
    id: 'factory_warehouse',
    label: { en: 'Factory / Warehouse', ta: 'தொழிற்சாலை/கிடங்கு', hi: 'फैक्ट्री/वेयरहाउस', te: 'ఫ్యాక్టరీ / గోడాము', ml: 'ഫാക്ടറി / വെയർഹൗസ്' },
  },
  {
    id: 'cleaning_housekeeping',
    label: { en: 'Cleaning / Housekeeping', ta: 'க்ளீனிங்/ஹவுஸ்கீப்பிங்', hi: 'क्लीनिंग/हाउसकीपिंग', te: 'క్లీనింగ్ / హౌస్‌కీపింగ్', ml: 'ക്ലീനിങ്/ഹൗസ്കീപ്പിങ്' },
  },
  { id: 'hospitality', label: { en: 'Hospitality', ta: 'ஹாஸ்பிடாலிட்டி', hi: 'हॉस्पिटैलिटी', te: 'హాస్పిటాలిటీ', ml: 'ഹോസ്പിറ്റാലിറ്റി' } },
  { id: 'construction', label: { en: 'Construction', ta: 'கட்டுமானம்', hi: 'निर्माण', te: 'నిర్మాణం', ml: 'നിർമ്മാണം' } },
  {
    id: 'driver_operator',
    label: { en: 'Driver / Operator', ta: 'டிரைவர்/ஆபரேட்டர்', hi: 'ड्राइवर/ऑपरेटर', te: 'డ్రైవర్ / ఆపరేటర్', ml: 'ഡ്രൈവർ / ഓപ്പറേറ്റർ' },
  },
  {
    id: 'fabrication_welding',
    label: { en: 'Fabrication / Welding', ta: 'ஃபேப்ரிகேஷன்/வெல்டிங்', hi: 'फैब्रिकेशन/वेल्डिंग', te: 'ఫాబ్రికేషన్ / వెల్డింగ్', ml: 'ഫാബ്രിക്കേഷൻ / വെൽഡിംഗ്' },
  },
  {
    id: 'electrical_mechanical',
    label: { en: 'Electrical / Mechanical', ta: 'எலெக்ட்ரிகல்/மெக்கானிக்', hi: 'इलेक्ट्रिकल/मैकेनिकल', te: 'ఎలక్ట్రికల్ / మెకానికల్', ml: 'ഇലക്ട്രിക്കൽ/മെക്കാനിക്' },
  },
  { id: 'technician', label: { en: 'Technician', ta: 'தொழில்நுட்பர்', hi: 'टेक्नीशियन', te: 'టెక్నీషియన్', ml: 'ടെക്നീഷ്യൻ' } },
  { id: 'other', label: OTHER },
];

export const DOCUMENT_CHOICES: Choice[] = [
  { id: 'passport', label: { en: 'Passport', ta: 'பாஸ்போர்ட்', hi: 'पासपोर्ट', te: 'పాస్‌పోర్ట్', ml: 'പാസ്‌പോർട്ട്' } },
  { id: 'aadhaar', label: { en: 'Aadhaar', ta: 'ஆதார்', hi: 'आधार', te: 'ఆధార్', ml: 'ആധാർ' } },
  { id: 'pan', label: { en: 'PAN', ta: 'PAN', hi: 'PAN', te: 'PAN', ml: 'PAN' } },
];

const YES_NO: Choice[] = [
  { id: 'yes', label: { en: 'Yes', ta: 'ஆம்', hi: 'हाँ', te: 'అవును', ml: 'അതെ' } },
  { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं', te: 'కాదు', ml: 'അല്ല' } },
];

/**
 * Answers a document step accepts in words instead of a file.
 *
 * Never rendered as buttons: putting "I don't have it" on the screen invites the
 * answer. They exist so a candidate who says it in their own words is understood
 * the first time, rather than being asked again.
 */
const DOCUMENT_FALLBACKS: Choice[] = [
  {
    id: 'later',
    label: { en: 'I will send it later', ta: 'பிறகு அனுப்புகிறேன்', hi: 'बाद में भेजूँगा', te: 'నేను దీన్ని తర్వాత పంపిస్తాను', ml: 'ഞാൻ അത് പിന്നീട് അയക്കാം' },
  },
  {
    id: 'dont_have',
    label: { en: 'I do not have it', ta: 'என்னிடம் இல்லை', hi: 'मेरे पास नहीं है', te: 'నా దగ్గర ఇది లేదు', ml: 'എന്റെ കയ്യിൽ അതില്ല' },
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * §2–§5  Start, language, consent, CV
 * ───────────────────────────────────────────────────────────────────────────*/

const START_STEPS: FlowStep[] = [
  {
    // The opening menu (§2). Three taps, three destinations: a business contact
    // goes to a person without a single personal question being asked, someone
    // with an application id is read a decision staff already made, and everyone
    // else starts registering. The engine acts on the first two in
    // `handleSpecialStep`; only "apply" falls through into the flow below.
    id: 'entry',
    section: 'start',
    prompt: WELCOME,
    input: 'choice',
    choices: ENTRY_CHOICES,
    // Offered to the interpreter but never rendered. Three buttons is the whole
    // design; these exist so someone who declines in words, or asks for a
    // person, is understood the first time. Every id here is absent from
    // `choices` above — a duplicate would be numbered twice in the list the
    // interpreter sees and break "2 means the second option".
    hiddenChoices: [
      { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं', te: 'కాదు', ml: 'അല്ല' } },
      CHOICE_STAFF,
    ],
    satisfied: (c) => p(c).lookingForOverseasJob === true,
    apply: (a) => ({ lookingForOverseasJob: a.ids?.[0] === 'apply' }),
  },

  {
    id: 'language',
    section: 'language',
    prompt: {
      en: 'Please choose your preferred language.',
      ta: 'உங்கள் விருப்ப மொழியைத் தேர்ந்தெடுக்கவும்.',
      hi: 'कृपया अपनी पसंदीदा भाषा चुनें।',
      te: 'దయచేసి మీకు నచ్చిన భాష ఎంచుకోండి.',
      ml: 'നിങ്ങൾക്ക് വേണ്ട ഭാഷ ഒന്ന് തിരഞ്ഞെടുക്കൂ.',
    },
    input: 'choice',
    choices: [
      { id: 'en', label: { en: 'English', ta: 'English', hi: 'English', te: 'English', ml: 'English' } },
      { id: 'ta', label: { en: 'தமிழ்', ta: 'தமிழ்', hi: 'தமிழ்', te: 'தமிழ்', ml: 'தமிழ்' } },
      { id: 'hi', label: { en: 'हिंदी', ta: 'हिंदी', hi: 'हिंदी', te: 'हिंदी', ml: 'हिंदी' } },
      // Each language names itself, in its own script, in every language — that
      // is the whole point of this menu. Someone looking for Telugu is looking
      // for "తెలుగు", not for the word "Telugu" spelled out in another script.
      { id: 'te', label: { en: 'తెలుగు', ta: 'తెలుగు', hi: 'తెలుగు', te: 'తెలుగు', ml: 'తెలుగు' } },
      { id: 'ml', label: { en: 'മലയാളം', ta: 'മലയാളം', hi: 'മലയാളം', te: 'മലയാളം', ml: 'മലയാളം' } },
      { id: 'other', label: OTHER },
    ],
    // Satisfied by the candidate *choosing*, not by the engine guessing. The
    // welcome is rendered in a detected language so it arrives readable, but a
    // guess must not answer §3 on the candidate's behalf — checking
    // `has(c.language)` here meant anyone whose first message was in Latin
    // script was silently locked to English and never asked.
    satisfied: (c) => c.languageChosen === true,
  },

  {
    id: 'language_other',
    section: 'language',
    prompt: {
      en: 'Please type your preferred language.',
      ta: 'உங்கள் விருப்ப மொழியைத் தட்டச்சு செய்யவும்.',
      hi: 'कृपया अपनी पसंदीदा भाषा टाइप करें।',
      te: 'మీకు నచ్చిన భాష టైప్ చేయండి.',
      ml: 'നിങ്ങൾക്ക് ഇഷ്ടമുള്ള ഭാഷ ടൈപ്പ് ചെയ്യൂ.',
    },
    input: 'text',
    when: (c) => c.language === 'other',
    satisfied: (c) => has(c.languageOther),
  },

  {
    id: 'consent',
    section: 'consent',
    prompt: {
      en:
        'We’ll store your details and documents to process your application and notify you on ' +
        'WhatsApp about suitable overseas jobs. You can update or delete your profile anytime.\n' +
        'Shall we continue?',
      ta:
        'உங்கள் விண்ணப்பத்தைச் செயலாக்கவும், பொருத்தமான வெளிநாட்டு வேலைகள் குறித்து WhatsApp-இல் ' +
        'தெரிவிக்கவும் உங்கள் விவரங்களையும் ஆவணங்களையும் சேமிப்போம். எப்போது வேண்டுமானாலும் ' +
        'உங்கள் விவரங்களைப் புதுப்பிக்கலாம் அல்லது நீக்கலாம்.\nதொடரலாமா?',
      hi:
        'आपका आवेदन प्रोसेस करने और उपयुक्त विदेशी नौकरियों की जानकारी WhatsApp पर भेजने के लिए ' +
        'हम आपकी जानकारी और दस्तावेज़ सुरक्षित रखेंगे। आप कभी भी अपनी प्रोफ़ाइल अपडेट या डिलीट ' +
        'कर सकते हैं।\nक्या हम आगे बढ़ें?',
        te: 'మీ వివరాలు, డాక్యుమెంట్లు మేము దగ్గర పెట్టుకుని మీ అప్లికేషన్ ప్రాసెస్ చేసి, మీకు సరిపడే విదేశీ ఉద్యోగాల గురించి WhatsApp లో చెప్తాం. మీ ప్రొఫైల్‌ని మీరు ఎప్పుడైనా UPDATE లేదా DELETE చేసుకోవచ్చు.\nమనం కొనసాగించమంటారా?',
        ml: 'നിങ്ങളുടെ വിവരങ്ങളും ഡോക്യുമെന്റുകളും ഞങ്ങൾ സൂക്ഷിക്കും, അപേക്ഷ പ്രോസസ്സ് ചെയ്യാനും അനുയോജ്യമായ വിദേശ ജോലികളെക്കുറിച്ച് WhatsApp വഴി അറിയിക്കാനും. നിങ്ങൾക്ക് എപ്പോൾ വേണമെങ്കിലും പ്രൊഫൈൽ UPDATE ചെയ്യാം അല്ലെങ്കിൽ DELETE ചെയ്യാം.\nനമുക്ക് തുടരാമോ?',
    },
    input: 'choice',
    choices: [
      { id: 'yes', label: { en: 'Yes, continue', ta: 'ஆம், தொடரவும்', hi: 'हाँ, आगे बढ़ें', te: 'అవును, కొనసాగించండి', ml: 'അതെ, തുടരാം' } },
      { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं', te: 'కాదు', ml: 'അല്ല' } },
      CHOICE_STAFF,
    ],
    // Consent lives on the candidate, not the profile — the engine writes it.
    satisfied: (c) => c.consent?.given === true,
  },

];

/**
 * Whether this candidate is on the Singapore / Malaysia route.
 *
 * The one branch that changes the shape of registration rather than adding a
 * question to it: the passport is collected first and answers what a CV would
 * otherwise be asked to answer, so the CV becomes optional and the questions
 * the passport settles are never put to the candidate at all.
 */
export function inSingaporeMalaysiaBranch(c: CandidateDoc): boolean {
  return SINGAPORE_MALAYSIA.has(String(p(c).countryPreference));
}

/**
 * The destinations that take the passport-first route.
 *
 * A set rather than a comparison, because the two used to be one option and are
 * now two — and because `singapore_malaysia` still exists on every record
 * answered before the split. Those candidates chose this branch and must keep
 * it; §22 does not let a menu change rewrite what someone already said.
 */
const SINGAPORE_MALAYSIA: ReadonlySet<string> = new Set([
  'singapore',
  'malaysia',
  // Historical, pre-split. Read-only: nothing writes it any more.
  'singapore_malaysia',
]);

/**
 * The destination country as a country name, for the CRM.
 *
 * The bot stores an option id; the CRM's CV policy keys on a real country. Only
 * the ids that *are* single countries map — `gcc` covers six and `europe`
 * covers a continent, and inventing a country for them would put a fact on the
 * record nobody established. Those candidates reach the CRM with no
 * destination, and the policy defaults to requiring a CV, which is the safe
 * direction.
 */
const DESTINATION_COUNTRY_BY_ID: Record<string, string> = {
  singapore: 'Singapore',
  malaysia: 'Malaysia',
};

export function destinationCountryOf(c: CandidateDoc): string | undefined {
  return DESTINATION_COUNTRY_BY_ID[String(p(c).countryPreference)];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The Singapore / Malaysia branch
 *
 * Placed before the CV rather than after it, which is the whole point. The
 * passport carries the candidate's legal name, their date of birth, their
 * nationality and the number and expiry staff need — all of it printed, none of
 * it typed from memory. Reading it first means the name and date-of-birth
 * questions are never asked, because §1 does not ask for what is already on
 * file and §5 turns what a document says into profile fields.
 *
 * The CV still follows, and is still offered rather than required: someone who
 * has one gives us their work history, and someone who does not is not held up
 * over it.
 * ───────────────────────────────────────────────────────────────────────────*/

const SINGAPORE_MALAYSIA_STEPS: FlowStep[] = [
  {
    id: 'sgmy_passport',
    section: 'passport',
    prompt: {
      en: 'Please send a clear photo or scan of your passport — the page with your photo and details.\nWe will read your name and date of birth from it, so you will not have to type them.',
      ta: 'உங்கள் பாஸ்போர்ட்டின் புகைப்படம் மற்றும் விவரங்கள் உள்ள பக்கத்தைத் தெளிவாக அனுப்பவும்.\nஉங்கள் பெயரையும் பிறந்த தேதியையும் அதிலிருந்தே எடுத்துக்கொள்வோம் — நீங்கள் தட்டச்சு செய்ய வேண்டாம்.',
      hi: 'कृपया अपने पासपोर्ट की साफ़ फ़ोटो या स्कैन भेजें — जिस पेज पर आपकी फ़ोटो और जानकारी है।\nहम आपका नाम और जन्मतिथि उसी से पढ़ लेंगे, आपको टाइप नहीं करना पड़ेगा।',
      te: 'దయచేసి మీ పాస్‌పోర్ట్ ఫోటో లేదా స్కాన్ పంపండి — మీ ఫోటో, వివరాలు ఉన్న పేజీ.\nమీ పేరు, పుట్టిన తేదీ మేము దాన్నుంచే తీసుకుంటాం, మీరు టైప్ చేయాల్సిన పని లేదు.',
      ml: 'ദയവായി നിങ്ങളുടെ പാസ്‌പോർട്ടിന്റെ വ്യക്തമായ ഫോട്ടോ അയക്കൂ — ഫോട്ടോയും വിവരങ്ങളും ഉള്ള പേജ്.\nനിങ്ങളുടെ പേരും ജനന തീയതിയും അതിൽ നിന്ന് തന്നെ എടുത്തുകൊള്ളാം, ടൈപ്പ് ചെയ്യേണ്ട.',
    },
    input: 'document',
    document: 'passport',
    allowMedia: true,
    allowStaff: true,
    hiddenChoices: DOCUMENT_FALLBACKS,
    when: inSingaporeMalaysiaBranch,
    // The same slot `passport_document` fills, so a passport that arrived any
    // other way — sent unprompted, or found inside a CV — already satisfies
    // this and the candidate is not asked twice (§1).
    satisfied: (c) => documentSatisfied(c, 'passport'),
  },

  {
    /**
     * What they are looking for, asked before the CV and before what they
     * already do.
     *
     * Before the CV because the CV requirement is computed from destination and
     * job together: asking for a document before knowing whether it is needed
     * is either a wasted request or a missing one. Before `main_trade` because
     * the passport has already established who this person is, so the
     * conversation can open on what they actually came to talk about — and §9's
     * separation of "what you do" from "what you want" is preserved either way,
     * since the two write different fields.
     *
     * A tap, not free text, and that is the load-bearing detail — see
     * `JOB_CATEGORY_CHOICES`. Their own words are still captured when they type
     * instead of tapping.
     */
    id: 'sgmy_job_category',
    section: 'job_preference',
    prompt: {
      en: 'Which job are you looking for?',
      ta: 'எந்த வேலையைத் தேடுகிறீர்கள்?',
      hi: 'आप कौन सी नौकरी ढूंढ रहे हैं?',
      te: 'మీరు ఏ ఉద్యోగం కోసం చూస్తున్నారు?',
      ml: 'നിങ്ങൾ ഏത് ജോലിയാണ് അന്വേഷിക്കുന്നത്?',
    },
    input: 'choice',
    choices: JOB_CATEGORY_CHOICES,
    acceptsOccupation: 'category',
    when: inSingaporeMalaysiaBranch,
    satisfied: (c) => has(p(c).jobCategory),
    /**
     * A tapped row records the category. Anything typed records the category the
     * interpreter mapped it to *and* what they actually said.
     *
     * `desiredOccupation` is filled here too, so the general flow's
     * `desired_job` is already answered and never asked again (§1).
     */
    apply: (a) => {
      const typed = (a.value ?? a.raw ?? '').trim();
      if (a.ids?.length) {
        return {
          jobCategory: a.ids[0],
          ...(typed && !a.tapped ? { desiredOccupation: typed } : {}),
        };
      }
      return typed ? { jobCategory: 'other', desiredOccupation: typed } : {};
    },
    clears: ['jobCategory', 'desiredOccupation', 'cvRequired', 'cvPolicyVersion'],
  },
];

/**
 * The CV.
 *
 * Its own step rather than the tail of `START_STEPS`, because it is no longer
 * always the first thing asked for. On the Singapore / Malaysia route the
 * passport comes first and this follows it; everywhere else this is still where
 * registration begins in earnest.
 */
const CV_STEP: FlowStep = {
  id: 'cv',
  section: 'cv',
  prompt: {
    en: 'Please send your CV as a PDF, Word file or clear photo.',
    ta: 'உங்கள் CV-ஐ PDF, Word கோப்பு அல்லது தெளிவான புகைப்படமாக அனுப்பவும்.',
    hi: 'कृपया अपना CV — PDF, Word फ़ाइल या साफ़ फ़ोटो — भेजें।',
    te: 'దయచేసి మీ CV ని PDF, Word ఫైల్ లేదా క్లియర్ ఫోటోగా పంపండి.',
    ml: 'നിങ്ങളുടെ CV, PDF ആയോ Word ഫയൽ ആയോ വ്യക്തമായ ഫോട്ടോ ആയോ അയക്കൂ.',
  },
  input: 'document',
  document: 'cv',
  allowMedia: true,
  choices: [
    { id: 'upload_cv', label: { en: 'Upload CV', ta: 'CV அனுப்ப', hi: 'CV भेजें', te: 'CV అప్‌లోడ్ చేయండి', ml: 'CV അപ്‌ലോഡ് ചെയ്യുക' } },
    { id: 'no_cv', label: { en: "I don't have a CV", ta: 'CV இல்லை', hi: 'CV नहीं है', te: 'నా దగ్గర CV లేదు', ml: 'എന്റെ കയ്യിൽ CV ഇല്ല' } },
  ],
  hiddenChoices: DOCUMENT_FALLBACKS,
  allowStaff: true,
  /**
   * Skipped where the CV policy says no CV is needed.
   *
   * Only on the Singapore / Malaysia route, and only once the CRM has actually
   * answered — `cvRequired` is undefined until then, and an undefined answer
   * asks for the CV rather than assuming it away. Everywhere else this is
   * unconditional exactly as it always was: the CV is where registration begins
   * for a Gulf or Europe candidate and nothing here changes that.
   */
  when: (c) => !(inSingaporeMalaysiaBranch(c) && p(c).cvRequired === false),
  satisfied: (c) => documentSatisfied(c, 'cv'),
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §2  The B2B branch
 *
 * A separate, short flow behind "Other → B2B enquiry". A business contact is not
 * a candidate, so none of the registration questions below apply to them and
 * none of these apply to a candidate — `nextStep` picks one list or the other
 * from `enquiry`, and the `when` guards here say the same thing a second time so
 * a stray lookup cannot cross the two.
 *
 * Three things, in the order a person ringing back needs them: who they are, an
 * identity document, and proof the company exists. Only the Aadhaar is read; the
 * registration certificate is filed as it arrived (`ocr: 'none'` in `rules.ts`).
 *
 * They come as four questions, because the two sides of the Aadhaar are asked for
 * one at a time. A photo answers whichever question is open, so a single ask
 * would have the second photo land in the next slot — which here is the
 * company's certificate.
 * ─────────────────────────────────────────────────────────────────────────────*/

const isB2b = (c: CandidateDoc): boolean => c.enquiry === 'b2b';

export const B2B_STEPS: FlowStep[] = [
  {
    id: 'b2b_name',
    section: 'b2b',
    prompt: {
      en: 'May I have your full name?',
      ta: 'உங்கள் முழுப் பெயரைச் சொல்லுங்கள்.',
      hi: 'कृपया अपना पूरा नाम बताइए।',
      te: 'మీ పూర్తి పేరు చెప్పండి.',
      ml: 'നിങ്ങളുടെ പൂർണ്ണ പേര് പറയാമോ?',
    },
    input: 'text',
    when: isB2b,
    satisfied: (c) => has(p(c).fullName),
    apply: (a) => ({ fullName: a.value }),
    clears: ['fullName'],
  },

  {
    id: 'b2b_aadhaar_front',
    section: 'b2b',
    prompt: {
      en: 'Please send the front of your Aadhaar card — a clear photo or a PDF.',
      ta: 'உங்கள் ஆதார் அட்டையின் முன்புறத்தைத் தெளிவான புகைப்படமாகவோ PDF ஆகவோ அனுப்பவும்.',
      hi: 'कृपया अपने आधार कार्ड का अगला हिस्सा भेजें — साफ़ फ़ोटो या PDF।',
      te: 'దయచేసి మీ ఆధార్ కార్డు ముందు భాగాన్ని క్లియర్ ఫోటో గా లేదా PDF గా పంపండి.',
      ml: 'നിങ്ങളുടെ ആധാർ കാർഡിന്റെ മുൻവശം വ്യക്തമായ ഫോട്ടോ PDF ആയിട്ടോ അയക്കൂ.',
    },
    input: 'document',
    document: 'b2b_aadhaar_front',
    allowMedia: true,
    allowStaff: true,
    hiddenChoices: DOCUMENT_FALLBACKS,
    when: isB2b,
    satisfied: (c) => b2bDocumentSatisfied(c, 'b2b_aadhaar_front'),
  },

  {
    id: 'b2b_aadhaar_back',
    section: 'b2b',
    prompt: {
      en: 'Now the back of the same card, please — a photo or a PDF.',
      ta: 'இப்போது அதே அட்டையின் பின்புறத்தைப் புகைப்படமாகவோ PDF ஆகவோ அனுப்பவும்.',
      hi: 'अब उसी कार्ड का पिछला हिस्सा भेजें — फ़ोटो या PDF।',
      te: 'ఇప్పుడు అదే కార్డు వెనుక భాగం పంపండి — ఫోటో లేదా PDF.',
      ml: 'ഇനി അതേ കാർഡിന്റെ പിൻവശം അയക്കൂ — ഫോട്ടോ PDF ആയിട്ടോ.',
    },
    input: 'document',
    document: 'b2b_aadhaar_back',
    allowMedia: true,
    allowStaff: true,
    hiddenChoices: DOCUMENT_FALLBACKS,
    when: isB2b,
    satisfied: (c) => b2bDocumentSatisfied(c, 'b2b_aadhaar_back'),
  },

  {
    id: 'b2b_company_registration',
    section: 'b2b',
    prompt: {
      en: 'Finally, please send your company registration certificate — a PDF or a clear photo.',
      ta: 'கடைசியாக, உங்கள் நிறுவனப் பதிவுச் சான்றிதழை PDF ஆகவோ தெளிவான புகைப்படமாகவோ அனுப்பவும்.',
      hi: 'आखिर में, अपनी कंपनी का रजिस्ट्रेशन सर्टिफिकेट भेजें — PDF या साफ़ फ़ोटो।',
      te: 'చివరగా, మీ కంపెనీ రిజిస్ట్రేషన్ సర్టిఫికెట్ పంపండి — PDF లేదా క్లియర్ ఫోటో.',
      ml: 'ഒടുവിലായി, നിങ്ങളുടെ കമ്പനി രജിസ്ട്രേഷൻ സർട്ടിഫിക്കറ്റ് അയക്കൂ — PDF ആയിട്ടോ വ്യക്തമായ ഫോട്ടോ ആയിട്ടോ.',
    },
    input: 'document',
    document: 'company_registration',
    allowMedia: true,
    allowStaff: true,
    hiddenChoices: DOCUMENT_FALLBACKS,
    when: isB2b,
    satisfied: (c) => b2bDocumentSatisfied(c, 'company_registration'),
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * §6  Basic details
 *
 * Every step here is skipped when the CV already supplied the answer (§5).
 * ───────────────────────────────────────────────────────────────────────────*/

const PERSONAL_STEPS: FlowStep[] = [
  {
    id: 'full_name',
    section: 'personal',
    prompt: {
      en: 'What is your full name as per passport?',
      ta: 'பாஸ்போர்ட்டில் உள்ளபடி உங்கள் முழுப் பெயர் என்ன?',
      hi: 'पासपोर्ट के अनुसार आपका पूरा नाम क्या है?',
      te: 'పాస్‌పోర్ట్‌లో ఉన్నట్టు మీ పూర్తి పేరు ఏంటి?',
      ml: 'പാസ്‌പോർട്ട് പ്രകാരമുള്ള നിങ്ങളുടെ പൂർണ്ണ പേര് എന്താണ്?',
    },
    input: 'text',
    satisfied: (c) => has(p(c).fullName),
    apply: (a) => ({ fullName: a.value }),
    clears: ['fullName'],
  },

  {
    id: 'location',
    section: 'personal',
    prompt: {
      en: 'Which city and state are you currently living in?',
      ta: 'நீங்கள் தற்போது எந்த நகரம் மற்றும் மாநிலத்தில் வசிக்கிறீர்கள்?',
      hi: 'आप इस समय किस शहर और राज्य में रहते हैं?',
      te: 'మీరు ఇప్పుడు ఏ ఊరు, ఏ రాష్ట్రంలో ఉంటున్నారు?',
      ml: 'നിങ്ങൾ ഇപ്പോൾ താമസിക്കുന്ന നഗരവും സംസ്ഥാനവും ഏതാണ്?',
    },
    hint: {
      en: 'Example: Chennai, Tamil Nadu',
      ta: 'எடுத்துக்காட்டு: சென்னை, தமிழ்நாடு',
      hi: 'उदाहरण: चेन्नई, तमिलनाडु',
      te: 'ఉదాహరణ: చెన్నై, తమిళనాడు',
      ml: 'ഉദാഹരണം: ചെന്നൈ, തമിഴ്‌നാട്',
    },
    input: 'structured',
    // Stored split because matching filters on state and country, not on a
    // free-text blob (§6).
    fields: ['city', 'district', 'state', 'country'],
    satisfied: (c) => has(p(c).currentCity) || has(p(c).currentState),
    apply: (a) => ({
      currentCity: a.fields?.city,
      currentDistrict: a.fields?.district,
      currentState: a.fields?.state,
      currentCountry: a.fields?.country ?? 'India',
    }),
    clears: ['currentCity', 'currentDistrict', 'currentState', 'currentCountry'],
  },

  {
    id: 'dob',
    section: 'personal',
    prompt: {
      en: 'What is your date of birth?',
      ta: 'உங்கள் பிறந்த தேதி என்ன?',
      hi: 'आपकी जन्मतिथि क्या है?',
      te: 'మీ పుట్టిన తేదీ ఏంటి?',
      ml: 'നിങ്ങളുടെ ജനന തീയതി എന്താണ്?',
    },
    hint: {
      en: 'Example: 15/08/1995',
      ta: 'எடுத்துக்காட்டு: 15/08/1995',
      hi: 'उदाहरण: 15/08/1995',
      te: 'ఉదాహరణ: 15/08/1995',
      ml: 'ഉദാഹരണം: 15/08/1995',
    },
    input: 'date',
    // Age is derived from this, never asked separately (§6).
    satisfied: (c) => has(p(c).dateOfBirth),
    apply: (a) => ({ dateOfBirth: a.value }),
    clears: ['dateOfBirth'],
  },

  {
    id: 'education',
    section: 'personal',
    prompt: {
      en: 'What is your highest qualification?',
      ta: 'உங்கள் உயர்ந்த கல்வித் தகுதி என்ன?',
      hi: 'आपकी उच्चतम योग्यता क्या है?',
      te: 'మీ పెద్ద చదువు ఏంటి?',
      ml: 'നിങ്ങളുടെ ഏറ്റവും ഉയർന്ന വിദ്യാഭ്യാസ യോഗ്യത എന്താണ്?',
    },
    input: 'choice',
    choices: EDUCATION_CHOICES,
    satisfied: (c) => has(p(c).education),
    // Same shape as `availability`: a tap gives the id, and a typed "BSc" or
    // "polytechnic diploma" is mapped by the normaliser the CV path already
    // uses, rather than being lost because it did not arrive as an option.
    apply: (a) => {
      if (a.ids?.length) return { education: a.ids[0] };
      const level = normaliseEducation(a.value ?? a.raw);
      return level ? { education: level } : {};
    },
    clears: ['education', 'educationCourse'],
  },

  {
    id: 'education_course',
    section: 'personal',
    prompt: {
      en: 'What course or trade did you complete?',
      ta: 'எந்தப் படிப்பு அல்லது தொழிற்பயிற்சி முடித்தீர்கள்?',
      hi: 'आपने कौन सा कोर्स या ट्रेड पूरा किया है?',
      te: 'మీరు ఏ కోర్సు లేదా ట్రేడ్ పూర్తి చేశారు?',
      ml: 'നിങ്ങൾ പൂർത്തിയാക്കിയ കോഴ്‌സ് അല്ലെങ്കിൽ ട്രേഡ് ഏതാണ്?',
    },
    input: 'text',
    when: (c) => ['iti', 'diploma', 'graduate'].includes(String(p(c).education)),
    satisfied: (c) => has(p(c).educationCourse),
    apply: (a) => ({ educationCourse: a.value }),
    clears: ['educationCourse'],
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * §7  Experience and skills
 * ───────────────────────────────────────────────────────────────────────────*/

const EXPERIENCE_STEPS: FlowStep[] = [

  {
    id: 'main_trade',
    section: 'experience',
    prompt: {
      en: 'What is your main job or skill?',
      ta: 'உங்கள் முக்கிய வேலை அல்லது திறமை என்ன?',
      hi: 'आपका मुख्य काम या स्किल क्या है?',
      te: 'మీ ప్రధాన పని లేదా నైపుణ్యం ఏంటి?',
      ml: 'നിങ്ങളുടെ പ്രധാന ജോലി അല്ലെങ്കിൽ സ്‌കിൽ എന്താണ്?',
    },
    input: 'choice',
    choices: TRADE_CHOICES,
    // The categories here are trades, so a named job belongs inside one.
    acceptsOccupation: 'category',
    satisfied: (c) => has(p(c).primaryTrade),
    // §9: this is what they *do*, and it is kept apart from what they want next.
    //
    // The tapped category is deliberately NOT copied into `currentOccupation`.
    // That field holds the candidate's own wording, and a button title is not
    // it — writing "Fabrication / Welding" there also fed the category's own
    // label back into §8's keyword matching, which selected every pack under
    // the category and skipped the question that exists to choose between them.
    /**
     * A tapped category records the category. A typed answer records what they
     * actually said.
     *
     * "Parota master", "JCB operator", "hotel cleaner" are all valid answers to
     * this question that no button covers. The interpreter maps them to the
     * category that does cover them; when nothing does, the answer is still
     * kept in the candidate's own words under `other` (§27) rather than being
     * discarded and the question asked again.
     */
    apply: (a) => {
      if (a.ids?.length) return { primaryTrade: a.ids[0], tradeFromList: !!a.tapped };
      const typed = (a.value ?? a.raw ?? '').trim();
      return typed ? { primaryTrade: 'other', currentOccupation: typed } : {};
    },
    clears: ['primaryTrade', 'tradeFromList', 'currentOccupation', 'tradeAnswers', 'tradePacks'],
  },

  {
    id: 'main_trade_other',
    section: 'experience',
    prompt: {
      en: 'Please type your job or skill.',
      ta: 'உங்கள் வேலை அல்லது திறமையைத் தட்டச்சு செய்யவும்.',
      hi: 'कृपया अपना काम या स्किल टाइप करें।',
      te: 'దయచేసి మీ పని లేదా నైపుణ్యం టైప్ చేయండి.',
      ml: 'നിങ്ങളുടെ ജോലി അല്ലെങ്കിൽ സ്‌കിൽ ടൈപ്പ് ചെയ്യൂ.',
    },
    input: 'text',
    allowMedia: true,
    acceptsOccupation: 'named',
    when: (c) => p(c).primaryTrade === 'other',
    satisfied: (c) => has(p(c).currentOccupation),
    apply: (a) => ({ currentOccupation: a.value }),
    clears: ['currentOccupation'],
  },

  {
    id: 'total_experience',
    section: 'experience',
    prompt: {
      en: 'How many years of experience do you have in this work?',
      ta: 'இந்த வேலையில் எத்தனை ஆண்டுகள் அனுபவம் உள்ளது?',
      hi: 'इस काम में आपको कितने साल का अनुभव है?',
      te: 'ఈ పనిలో మీకు ఎన్ని సంవత్సరాల అనుభవం ఉంది?',
      ml: 'ഈ പണിയിൽ നിങ്ങൾക്ക് എത്ര വർഷത്തെ പരിചയം ഉണ്ട്?',
    },
    input: 'choice',
    choices: EXPERIENCE_CHOICES,
    satisfied: (c) => has(p(c).totalExperienceBand),
    /**
     * An exact figure is kept when given; the band is always set, because
     * matching filters on the band (§7).
     *
     * A typed answer counts. "6 years", "six and a half", "72 months" are all
     * valid answers to this question, and the band is derived from them rather
     * than discarded — previously anything that did not arrive as a tapped
     * option left the band empty, the step unsatisfied, and the candidate
     * asked the same question again.
     */
    apply: (a) => {
      const exact = parseYears(a.value) ?? parseYears(a.raw);
      const band = a.ids?.[0] ?? experienceBand(exact);
      return {
        totalExperienceBand: band,
        ...(exact !== undefined ? { totalExperienceYears: exact } : {}),
      };
    },
    clears: ['totalExperienceBand', 'totalExperienceYears'],
  },

  {
    id: 'overseas_countries',
    section: 'experience',
    prompt: {
      en: 'Which countries have you worked in?',
      ta: 'எந்தெந்த நாடுகளில் வேலை செய்துள்ளீர்கள்?',
      hi: 'आपने किन देशों में काम किया है?',
      te: 'మీరు ఏయే దేశాల్లో పని చేశారు?',
      ml: 'ഏതൊക്കെ രാജ്യങ്ങളിൽ നിങ്ങൾ ജോലി ചെയ്തിട്ടുണ്ട്?',
    },
    input: 'text',
    // Asked only when overseas experience is already on the record — from the
    // CV, or because the candidate mentioned it (§7).
    when: (c) => p(c).hasOverseasExperience === true,
    satisfied: (c) => has(p(c).overseasCountries),
    apply: (a) => ({
      overseasCountries: (a.value ?? '')
        .split(/[,;/]| and | மற்றும் | और /i)
        .map((s) => s.trim())
        .filter(Boolean),
    }),
    clears: ['overseasCountries'],
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * §9–§12  Preferences, availability, passport
 * ───────────────────────────────────────────────────────────────────────────*/

/* -----------------------------------------------------------------------------
 * Where they want to work (10)
 *
 * Asked immediately after consent, before anything else, because it is no
 * longer only a preference — it is the branch point. A candidate heading for
 * Singapore or Malaysia is registered differently from one heading for the
 * Gulf: their passport comes first and answers the questions a CV would
 * otherwise be asked to answer.
 *
 * That is why this sits here rather than in `PREFERENCE_STEPS` where it used to
 * live. The order of `STEPS` is the order of the conversation, and a branch
 * point that is asked two thirds of the way through cannot branch anything.
 * ---------------------------------------------------------------------------*/

const COUNTRY_STEPS: FlowStep[] = [
  {
    id: 'country_preference',
    section: 'country',
    prompt: {
      en: 'Where would you like to work?',
      ta: 'எங்கு வேலை செய்ய விரும்புகிறீர்கள்?',
      hi: 'आप कहाँ काम करना चाहेंगे?',
      te: 'మీరు ఎక్కడ పని చేయాలనుకుంటున్నారు?',
      ml: 'നിങ്ങൾക്ക് എവിടെയാണ് ജോലി ചെയ്യണ്ടത്?',
    },
    input: 'choice',
    choices: COUNTRY_CHOICES,
    satisfied: (c) => has(p(c).countryPreference),
    apply: (a) => ({ countryPreference: a.ids?.[0] }),
    clears: ['countryPreference', 'selectedCountries', 'countryStrictness'],
  },

  {
    id: 'selected_countries',
    section: 'country',
    prompt: {
      en: 'Please type the countries you prefer.',
      ta: 'நீங்கள் விரும்பும் நாடுகளைத் தட்டச்சு செய்யவும்.',
      hi: 'कृपया अपने पसंदीदा देश टाइप करें।',
      te: 'మీకు నచ్చిన దేశాల పేర్లు టైప్ చేయండి.',
      ml: 'നിങ്ങൾക്ക് ഇഷ്ടമുള്ള രാജ്യങ്ങൾ ടൈപ്പ് ചെയ്യൂ.',
    },
    hint: {
      en: 'Example: Romania, Serbia and Russia',
      ta: 'எடுத்துக்காட்டு: ருமேனியா, செர்பியா மற்றும் ரஷ்யா',
      hi: 'उदाहरण: रोमानिया, सर्बिया और रूस',
      te: 'ఉదాహరణ: రొమేనియా, సెర్బియా మరియు రష్యా',
      ml: 'ഉദാഹരണം: റൊമാനിയ, സെർബിയ, റഷ്യ',
    },
    input: 'text',
    when: (c) => p(c).countryPreference === 'select',
    satisfied: (c) => has(p(c).selectedCountries),
    apply: (a) => ({
      selectedCountries: (a.value ?? '')
        .split(/[,;/]| and | மற்றும் | और /i)
        .map((s) => s.trim())
        .filter(Boolean),
    }),
    clears: ['selectedCountries'],
  },

  {
    id: 'country_strictness',
    section: 'country',
    prompt: {
      en: 'Is this your strict preference?',
      ta: 'இது கண்டிப்பான விருப்பமா?',
      hi: 'क्या यह आपकी सख़्त पसंद है?',
      te: 'ఇదే మీ పక్కా ఇష్టమా?',
      ml: 'ഇത് നിങ്ങളുടെ ഉറച്ച തീരുമാനമാണോ?',
    },
    input: 'choice',
    choices: [
      {
        id: 'strict',
        label: { en: 'Only these countries', ta: 'இந்த நாடுகள் மட்டும்', hi: 'सिर्फ़ ये देश', te: 'ఈ దేశాలే కావాలి', ml: 'ഈ രാജ്യങ്ങൾ മാത്രം' },
      },
      {
        id: 'prefer',
        label: { en: 'Others okay too', ta: 'மற்ற நாடுகளும் சரி', hi: 'दूसरे देश भी चलेंगे', te: 'ఇతరాలు కూడా సరే', ml: 'മറ്റുള്ളവയും ആകാം' },
      },
      {
        id: 'any',
        label: { en: 'Any suitable country', ta: 'ஏதேனும் நாடு', hi: 'कोई भी देश', te: 'ఏ దేశమైనా సరిపోతుంది', ml: 'ഏത് രാജ്യവും മതി' },
      },
    ],
    // Only meaningful once they have named somewhere specific. "Any country"
    // already answers this question.
    when: (c) => p(c).countryPreference !== 'any',
    satisfied: (c) => has(p(c).countryStrictness),
    apply: (a) => ({ countryStrictness: a.ids?.[0] }),
    clears: ['countryStrictness'],
  },

];

const PREFERENCE_STEPS: FlowStep[] = [
  {
    id: 'job_preference',
    section: 'job_preference',
    prompt: {
      en: 'What type of work are you looking for now?',
      ta: 'இப்போது எந்த வகை வேலை தேடுகிறீர்கள்?',
      hi: 'अब आप किस तरह का काम ढूंढ रहे हैं?',
      te: 'ఇప్పుడు మీకు ఎలాంటి పని కావాలి?',
      ml: 'ഇപ്പോൾ എന്ത് തരം പണിയാണ് നിങ്ങൾ നോക്കുന്നത്?',
    },
    input: 'choice',
    choices: [
      {
        id: 'current_trade',
        label: { en: 'My current trade', ta: 'என் தற்போதைய வேலை', hi: 'मेरा मौजूदा काम', te: 'నా ఇప్పటి పని రంగం', ml: 'എന്റെ ഇപ്പോഴത്തെ പണി' },
      },
      {
        id: 'related',
        label: { en: 'Related skilled jobs', ta: 'தொடர்புடைய வேலைகள்', hi: 'मिलते-जुलते काम', te: 'దీనికి సంబంధించిన పనులు', ml: 'അനുബന്ധ വൈദഗ്ധ്യ ജോലികൾ' },
      },
      {
        id: 'general',
        label: { en: 'Any general work', ta: 'ஏதேனும் பொது வேலை', hi: 'कोई भी सामान्य काम', te: 'ఏదైనా సాధారణ పని', ml: 'ഏതെങ്കിലും സാധാരണ പണി' },
      },
      { id: 'different', label: { en: 'Different job', ta: 'வேறு வேலை', hi: 'अलग काम', te: 'వేరే పని', ml: 'വേറെ പണി' } },
    ],
    // The four options are relationships to their current trade, not jobs, so
    // a job they name has to keep its own wording.
    acceptsOccupation: 'named',
    satisfied: (c) => has(p(c).workTypePreference),
    /**
     * A tapped category records the category. A named job records the job.
     *
     * "Type writer", "welder", "hotel cook" are all answers to this question
     * that no button covers — the candidate is telling us the work they want,
     * which is exactly what "Different job" means, and they have already said
     * which one. Recording both satisfies this step and skips `desired_job`,
     * because §1 forbids asking for something we were just told.
     *
     * Before this, a named job left `workTypePreference` empty, the step
     * unsatisfied, and the candidate reading "our staff will answer that" about
     * their own answer.
     */
    apply: (a) => {
      if (a.ids?.length) return { workTypePreference: a.ids[0] };
      const typed = (a.value ?? a.raw ?? '').trim();
      return typed ? { workTypePreference: 'different', desiredOccupation: typed } : {};
    },
    clears: [
      'workTypePreference',
      'relatedAcceptance',
      'generalWorkWillingness',
      'generalJobs',
      'desiredOccupation',
      'trainingWillingness',
    ],
  },

  {
    id: 'related_acceptance',
    section: 'job_preference',
    prompt: {
      en: 'Will you accept related jobs also?',
      ta: 'தொடர்புடைய வேலைகளையும் ஏற்பீர்களா?',
      hi: 'क्या आप मिलते-जुलते काम भी करेंगे?',
      te: 'సంబంధిత పనులు కూడా చేస్తారా?',
      ml: 'ഇതുമായി ബന്ധപ്പെട്ട പണികളും സമ്മതമാണോ?',
    },
    input: 'choice',
    choices: [
      {
        id: 'only_my_job',
        label: { en: 'Only my job', ta: 'என் வேலை மட்டும்', hi: 'सिर्फ़ मेरा काम', te: 'నా ఉద్యోగం మాత్రమే', ml: 'എന്റെ ജോലി മാത്രം' },
      },
      {
        id: 'related_ok',
        label: { en: 'Related jobs okay', ta: 'தொடர்புடையது சரி', hi: 'मिलते-जुलते ठीक हैं', te: 'సంబంధిత పనులు ఓకే', ml: 'അനുബന്ധ ജോലികൾ മതി' },
      },
      {
        id: 'any_suitable',
        label: { en: 'Any suitable work', ta: 'ஏதேனும் பொருத்தமானது', hi: 'कोई भी उपयुक्त काम', te: 'ఏదైనా సరిపడే పని', ml: 'ഏത് ജോലിയും മതി' },
      },
    ],
    when: (c) => p(c).workTypePreference === 'current_trade',
    satisfied: (c) => has(p(c).relatedAcceptance),
    apply: (a) => ({ relatedAcceptance: a.ids?.[0] }),
    clears: ['relatedAcceptance'],
  },

  {
    id: 'general_work',
    section: 'job_preference',
    prompt: {
      en:
        'Are you willing to do factory, warehouse, packing, helper, cleaning or construction work, ' +
        'even if it is different from your previous experience?',
      ta:
        'உங்கள் முந்தைய அனுபவத்திலிருந்து வேறுபட்டாலும், தொழிற்சாலை, கிடங்கு, பேக்கிங், ஹெல்பர், ' +
        'க்ளீனிங் அல்லது கட்டுமான வேலை செய்யத் தயாரா?',
      hi:
        'क्या आप फैक्ट्री, वेयरहाउस, पैकिंग, हेल्पर, क्लीनिंग या निर्माण का काम करने को तैयार हैं, ' +
        'भले ही यह आपके पिछले अनुभव से अलग हो?',
        te: 'మీ ముందు అనుభవానికి వేరుగా ఉన్నా, ఫ్యాక్టరీ, వేర్‌హౌస్, ప్యాకింగ్, హెల్పర్, క్లీనింగ్ లేదా కన్‌స్ట్రక్షన్ పని చేయడానికి మీరు రెడీనా?',
        ml: 'നിങ്ങളുടെ മുൻപത്തെ പണിയിൽ നിന്ന് വേറെയാണെങ്കിലും, ഫാക്ടറി, വെയർഹൗസ്, പാക്കിംഗ്, ഹെൽപ്പർ, ക്ലീനിംഗ് അല്ലെങ്കിൽ കൺസ്ട്രക്ഷൻ പണി ചെയ്യാൻ നിങ്ങൾക്ക് സമ്മതമാണോ?',
    },
    input: 'choice',
    choices: [
      // Kept inside WhatsApp's 20-character button limit; the full question is
      // in the prompt above, so the buttons only have to be distinguishable.
      {
        id: 'any_suitable',
        label: { en: 'Yes, any work', ta: 'ஆம், எந்த வேலையும்', hi: 'हाँ, कोई भी काम', te: 'అవును, ఏ పనైనా సరే', ml: 'അതെ, ഏത് ജോലിയും' },
      },
      {
        id: 'selected',
        label: { en: 'Only selected jobs', ta: 'சில வேலைகள் மட்டும்', hi: 'सिर्फ़ चुने हुए काम', te: 'ఎంపిక చేసిన పనులే', ml: 'തിരഞ്ഞെടുത്തവ മാത്രം' },
      },
      {
        id: 'need_details',
        label: { en: 'Need details first', ta: 'முதலில் விவரம்', hi: 'पहले जानकारी चाहिए', te: 'ముందు వివరాలు కావాలి', ml: 'ആദ്യം വിവരങ്ങൾ വേണം' },
      },
    ],
    when: (c) => p(c).workTypePreference === 'general',
    satisfied: (c) => has(p(c).generalWorkWillingness),
    apply: (a) => ({ generalWorkWillingness: a.ids?.[0] }),
    clears: ['generalWorkWillingness', 'generalJobs'],
  },

  {
    id: 'general_jobs',
    section: 'job_preference',
    prompt: {
      en: 'Which jobs would you accept? Choose as many as you like.',
      ta: 'எந்த வேலைகளை ஏற்பீர்கள்? விரும்பியவற்றைத் தேர்ந்தெடுக்கவும்.',
      hi: 'आप कौन-कौन से काम करेंगे? जितने चाहें चुनें।',
      te: 'మీరు ఏ ఏ ఉద్యోగాలు ఒప్పుకుంటారు? మీకు నచ్చినన్ని ఎంచుకోండి.',
      ml: 'നിങ്ങൾക്ക് ഏതൊക്കെ ജോലി സ്വീകാര്യമാണ്? എത്ര വേണമെങ്കിലും തിരഞ്ഞെടുക്കാം.',
    },
    input: 'multi_choice',
    choices: GENERAL_JOB_CHOICES,
    when: (c) => p(c).generalWorkWillingness === 'selected',
    satisfied: (c) => has(p(c).generalJobs),
    apply: (a) => ({ generalJobs: a.ids }),
    clears: ['generalJobs'],
  },

  {
    id: 'desired_job',
    section: 'job_preference',
    prompt: {
      en: 'Which job are you looking for?',
      ta: 'எந்த வேலையைத் தேடுகிறீர்கள்?',
      hi: 'आप कौन सी नौकरी ढूंढ रहे हैं?',
      te: 'మీరు ఏ ఉద్యోగం కోసం చూస్తున్నారు?',
      ml: 'നിങ്ങൾ ഏത് ജോലിയാണ് അന്വേഷിക്കുന്നത്?',
    },
    input: 'text',
    allowMedia: true,
    acceptsOccupation: 'named',
    when: (c) => p(c).workTypePreference === 'different',
    // §9: kept apart from currentOccupation. What they want is not what they did.
    satisfied: (c) => has(p(c).desiredOccupation),
    apply: (a) => ({ desiredOccupation: a.value }),
    clears: ['desiredOccupation'],
  },

  {
    id: 'training_willingness',
    section: 'job_preference',
    prompt: {
      en: 'Are you willing to attend training for the new job?',
      ta: 'புதிய வேலைக்குப் பயிற்சி பெறத் தயாரா?',
      hi: 'क्या आप नई नौकरी के लिए ट्रेनिंग लेने को तैयार हैं?',
      te: 'కొత్త ఉద్యోగం కోసం ట్రైనింగ్‌కి రావడానికి మీరు ఒప్పుకుంటారా?',
      ml: 'പുതിയ ജോലിക്ക് വേണ്ടി ട്രെയിനിംഗ് അറ്റൻഡ് ചെയ്യാൻ നിങ്ങൾ തയ്യാറാണോ?',
    },
    input: 'choice',
    choices: [
      { id: 'yes', label: { en: 'Yes', ta: 'ஆம்', hi: 'हाँ', te: 'అవును', ml: 'അതെ' } },
      { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं', te: 'కాదు', ml: 'അല്ല' } },
      {
        id: 'depends',
        label: { en: 'Depends on details', ta: 'விவரத்தைப் பொறுத்து', hi: 'जानकारी पर निर्भर', te: 'వివరాలను బట్టి', ml: 'വിവരങ്ങൾ അനുസരിച്ച്' },
      },
    ],
    when: (c) => p(c).workTypePreference === 'different',
    satisfied: (c) => has(p(c).trainingWillingness),
    apply: (a) => ({ trainingWillingness: a.ids?.[0] }),
    clears: ['trainingWillingness'],
  },

  {
    id: 'availability',
    section: 'availability',
    prompt: {
      en: 'When can you join?',
      ta: 'எப்போது சேர முடியும்?',
      hi: 'आप कब जॉइन कर सकते हैं?',
      te: 'మీరు ఎప్పుడు జాయిన్ అవ్వగలరు?',
      ml: 'നിങ്ങൾക്ക് എപ്പോൾ ജോയിൻ ചെയ്യാൻ പറ്റും?',
    },
    input: 'choice',
    choices: [
      { id: 'immediate', label: { en: 'Immediately', ta: 'உடனடியாக', hi: 'तुरंत', te: 'వెంటనే', ml: 'ഉടനെ' } },
      { id: 'within_15', label: { en: 'Within 15 days', ta: '15 நாட்களுக்குள்', hi: '15 दिन के अंदर', te: '15 రోజుల్లోపు', ml: '15 ദിവസത്തിനുള്ളിൽ' } },
      { id: 'within_30', label: { en: 'Within 30 days', ta: '30 நாட்களுக்குள்', hi: '30 दिन के अंदर', te: '30 రోజుల్లోపు', ml: '30 ദിവസത്തിനുള്ളിൽ' } },
      {
        id: 'more_than_30',
        label: { en: 'More than 30 days', ta: '30 நாட்களுக்கு மேல்', hi: '30 दिन से ज़्यादा', te: '30 రోజుల కన్నా ఎక్కువ', ml: '30 ദിവസത്തിൽ കൂടുതൽ' },
      },
    ],
    satisfied: (c) => has(p(c).availability),
    /**
     * A tap records the bucket. A stated period is turned into one.
     *
     * "After 6 months", "next week", "in 20 days" are all answers to this
     * question that the interpreter sometimes returns as words rather than as
     * an option id — and reading only `ids` threw them away, left the step
     * unsatisfied, and told the candidate their answer could not be used.
     *
     * Their own wording is kept when it lands past 30 days, which both puts it
     * on the record and satisfies `availability_date` — the follow-up that
     * exists to ask exactly this (§1).
     */
    apply: (a) => {
      if (a.ids?.length) return { availability: a.ids[0] };

      const typed = (a.value ?? a.raw ?? '').trim();
      const band = availabilityBand(parseDaysAway(typed));
      if (!band) return {};

      return {
        availability: band,
        ...(band === 'more_than_30' && typed ? { availabilityNote: typed } : {}),
      };
    },
    clears: ['availability', 'availabilityNote'],
  },

  {
    id: 'availability_date',
    section: 'availability',
    prompt: {
      en: 'When will you be available?',
      ta: 'எப்போது கிடைப்பீர்கள்?',
      hi: 'आप कब उपलब्ध होंगे?',
      te: 'మీరు ఎప్పుడు అందుబాటులో ఉంటారు?',
      ml: 'നിങ്ങൾ എപ്പോൾ റെഡിയാകും?',
    },
    input: 'text',
    when: (c) => p(c).availability === 'more_than_30',
    satisfied: (c) => has(p(c).availabilityNote),
    apply: (a) => ({ availabilityNote: a.value }),
    clears: ['availabilityNote'],
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * §12  Passport status
 * ───────────────────────────────────────────────────────────────────────────*/

const PASSPORT_STEPS: FlowStep[] = [
  {
    id: 'passport_status',
    section: 'passport',
    prompt: {
      en: 'Do you have a valid passport?',
      ta: 'செல்லுபடியாகும் பாஸ்போர்ட் உள்ளதா?',
      hi: 'क्या आपके पास वैध पासपोर्ट है?',
      te: 'మీ దగ్గర సరైన పాస్‌పోర్ట్ ఉందా?',
      ml: 'നിങ്ങളുടെ കയ്യിൽ വാലിഡ് പാസ്‌പോർട്ട് ഉണ്ടോ?',
    },
    input: 'choice',
    choices: [
      { id: 'yes', label: { en: 'Yes', ta: 'ஆம்', hi: 'हाँ', te: 'అవును', ml: 'അതെ' } },
      { id: 'applied', label: { en: 'Applied', ta: 'விண்ணப்பித்தேன்', hi: 'अप्लाई किया है', te: 'అప్లై చేశారు', ml: 'അപേക്ഷിച്ചു' } },
      { id: 'expired', label: { en: 'Expired', ta: 'காலாவதியானது', hi: 'एक्सपायर हो गया', te: 'గడువు ముగిసింది', ml: 'കാലാവധി കഴിഞ്ഞു' } },
      { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं', te: 'కాదు', ml: 'അല്ല' } },
    ],
    // A passport already on file answers this. The Singapore / Malaysia branch
    // collects the booklet before anything else, and asking someone who has
    // just sent us their passport whether they have one is the kind of question
    // §1 exists to prevent.
    //
    // `documentOnFile`, not `documentSatisfied`: a candidate who said they have
    // no passport, or promised one for tomorrow, has satisfied the upload
    // question without giving us a passport — and they are exactly the person
    // this question needs to be put to, so that `no` or `applied` is recorded
    // rather than nothing at all.
    satisfied: (c) => has(p(c).passportStatus) || documentOnFile(c, 'passport'),
    apply: (a) => ({ passportStatus: a.ids?.[0] }),
    clears: [
      'passportStatus',
      'passportExpiry',
      'passportAppliedWhen',
      'passportRenewalIntent',
      'passportApplyWillingness',
    ],
  },

  {
    /**
     * The passport itself, rather than facts about it (§12).
     *
     * This used to ask "when does your passport expire?" and take the answer as
     * typed. A date typed from memory is the least reliable thing on the record
     * — people misremember the year, read the issue date, or type today's — and
     * the document that settles it is one they can send in a single tap. So the
     * question is the upload, and the expiry, the number and the name are read
     * off the page (`profileFromIdentityDocument` in `ocr/veris.ts`).
     *
     * Satisfied by the passport slot rather than by `passportExpiry`, so a
     * candidate who already sent their passport — including inside their CV,
     * which `ocr/veris.ts` files against this slot — is never asked for it again
     * (§1).
     */
    id: 'passport_document',
    section: 'passport',
    prompt: {
      en: 'Please send a clear photo or scan of your passport — the page with your photo and details.',
      ta: 'உங்கள் பாஸ்போர்ட்டின் புகைப்படம் மற்றும் விவரங்கள் உள்ள பக்கத்தைத் தெளிவாக அனுப்பவும்.',
      hi: 'कृपया अपने पासपोर्ट की साफ़ फ़ोटो या स्कैन भेजें — जिस पेज पर आपकी फ़ोटो और जानकारी है।',
      te: 'దయచేసి మీ పాస్‌పోర్ట్ ఫోటో లేదా స్కాన్ పంపండి — మీ ఫోటో, వివరాలు ఉన్న పేజీ.',
      ml: 'ദയവായി നിങ്ങളുടെ പാസ്‌പോർട്ടിന്റെ വ്യക്തമായ ഫോട്ടോ സ്കാൻ അയക്കൂ — ഫോട്ടോയും വിവരങ്ങളും ഉള്ള പേജ്.',
    },
    input: 'document',
    document: 'passport',
    allowMedia: true,
    allowStaff: true,
    hiddenChoices: DOCUMENT_FALLBACKS,
    when: (c) => p(c).passportStatus === 'yes',
    satisfied: (c) => documentSatisfied(c, 'passport'),
  },

  {
    id: 'passport_applied_when',
    section: 'passport',
    prompt: {
      en: 'When did you apply for it?',
      ta: 'எப்போது விண்ணப்பித்தீர்கள்?',
      hi: 'आपने कब अप्लाई किया था?',
      te: 'దాని కోసం ఎప్పుడు అప్లై చేశారు?',
      ml: 'നിങ്ങൾ എപ്പോഴാണ് ഇതിന് അപേക്ഷിച്ചത്?',
    },
    input: 'text',
    when: (c) => p(c).passportStatus === 'applied',
    satisfied: (c) => has(p(c).passportAppliedWhen),
    apply: (a) => ({ passportAppliedWhen: a.value }),
    clears: ['passportAppliedWhen'],
  },

  {
    id: 'passport_renewal',
    section: 'passport',
    prompt: {
      en: 'Are you applying for renewal?',
      ta: 'புதுப்பிக்க விண்ணப்பிக்கிறீர்களா?',
      hi: 'क्या आप रिन्यूअल के लिए अप्लाई कर रहे हैं?',
      te: 'రెన్యువల్ కోసం అప్లై చేస్తున్నారా?',
      ml: 'നിങ്ങൾ റിന്യൂവലിന് അപേക്ഷിക്കുന്നുണ്ടോ?',
    },
    input: 'choice',
    choices: YES_NO,
    /**
     * Asked of an expired passport, and of a valid one that runs out soon.
     *
     * §12 already flags a passport expiring within
     * `TUNABLES.passportExpiryWarningMonths` for staff; this asks the candidate
     * about it while we have them. Deliberately not asked of someone whose
     * passport is good for years — "are you applying for renewal?" against a
     * 2031 expiry is a question with no answer worth recording.
     */
    when: (c) => {
      if (p(c).passportStatus === 'expired') return true;
      if (p(c).passportStatus !== 'yes') return false;
      const flag = passportExpiryFlag(p(c));
      return !!flag && (flag.expired || flag.expiringSoon);
    },
    satisfied: (c) => has(p(c).passportRenewalIntent),
    apply: (a) => ({ passportRenewalIntent: a.ids?.[0] }),
    clears: ['passportRenewalIntent'],
  },

  {
    id: 'passport_apply_willing',
    section: 'passport',
    prompt: {
      en: 'Are you willing to apply for a passport?',
      ta: 'பாஸ்போர்ட்டுக்கு விண்ணப்பிக்கத் தயாரா?',
      hi: 'क्या आप पासपोर्ट के लिए अप्लाई करने को तैयार हैं?',
      te: 'పాస్‌పోర్ట్ కోసం అప్లై చేయడానికి మీకు ఇష్టమేనా?',
      ml: 'നിങ്ങൾ പാസ്‌പോർട്ടിന് അപേക്ഷിക്കാൻ തയ്യാറാണോ?',
    },
    input: 'choice',
    choices: YES_NO,
    when: (c) => p(c).passportStatus === 'no',
    satisfied: (c) => has(p(c).passportApplyWillingness),
    apply: (a) => ({ passportApplyWillingness: a.ids?.[0] }),
    clears: ['passportApplyWillingness'],
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * §13–§16  Europe / Russia document branch
 *
 * Every step here is gated on `inEuropeRussiaBranch`. A Gulf candidate never
 * sees any of it and is never asked for an identity document.
 * ───────────────────────────────────────────────────────────────────────────*/

const DOCUMENT_STEPS: FlowStep[] = [
  {
    id: 'europe_docs',
    section: 'documents',
    prompt: {
      en: 'For Europe/Russia opportunities, we need your passport, Aadhaar and PAN for document verification. Are they available?',
      ta: 'ஐரோப்பா/ரஷ்யா வாய்ப்புகளுக்கு, ஆவணச் சரிபார்ப்புக்காக உங்கள் பாஸ்போர்ட், ஆதார் மற்றும் PAN தேவை. அவை உள்ளனவா?',
      hi: 'यूरोप/रूस के अवसरों के लिए दस्तावेज़ सत्यापन हेतु आपका पासपोर्ट, आधार और PAN चाहिए। क्या ये उपलब्ध हैं?',
      te: 'యూరప్/రష్యా అవకాశాల కోసం, డాక్యుమెంట్ వెరిఫికేషన్ కి మీ పాస్‌పోర్ట్, ఆధార్, PAN కావాలి. ఇవి మీ దగ్గర ఉన్నాయా?',
      ml: 'യൂറോപ്പ്/റഷ്യ ജോലികൾക്ക് ഡോക്യുമെന്റ് വെരിഫിക്കേഷന് പാസ്‌പോർട്ട്, ആധാർ, PAN എന്നിവ വേണം. ഇവ കയ്യിൽ ഉണ്ടോ?',
    },
    input: 'choice',
    choices: [
      { id: 'all', label: { en: 'All available', ta: 'எல்லாம் உள்ளன', hi: 'सभी उपलब्ध हैं', te: 'అన్నీ ఉన్నాయి', ml: 'എല്ലാം ഉണ്ട്' } },
      { id: 'some', label: { en: 'Some are missing', ta: 'சில இல்லை', hi: 'कुछ नहीं हैं', te: 'కొన్ని లేవు', ml: 'ചിലത് ഇല്ല' } },
      { id: 'later', label: { en: 'Upload later', ta: 'பிறகு அனுப்புகிறேன்', hi: 'बाद में भेजूँगा', te: 'తర్వాత అప్‌లోడ్', ml: 'പിന്നീട് അയക്കാം' } },
    ],
    when: inEuropeRussiaBranch,
    satisfied: (c) => has(p(c).documentAvailability),
    apply: (a) => ({
      documentAvailability: a.ids?.[0],
      // "All available" answers the follow-up question before it is asked.
      ...(a.ids?.[0] === 'all' ? { availableDocuments: ['passport', 'aadhaar', 'pan'] } : {}),
    }),
    clears: ['documentAvailability', 'availableDocuments'],
  },

  {
    id: 'europe_docs_which',
    section: 'documents',
    prompt: {
      en: 'Which documents do you have with you?',
      ta: 'உங்களிடம் எந்த ஆவணங்கள் உள்ளன?',
      hi: 'आपके पास कौन-कौन से दस्तावेज़ हैं?',
      te: 'మీ దగ్గర ఏ డాక్యుమెంట్లు ఉన్నాయి?',
      ml: 'നിങ്ങളുടെ കയ്യിൽ ഏതൊക്കെ ഡോക്യുമെന്റ് ഉണ്ട്?',
    },
    input: 'multi_choice',
    choices: DOCUMENT_CHOICES,
    when: (c) => inEuropeRussiaBranch(c) && p(c).documentAvailability === 'some',
    satisfied: (c) => has(p(c).availableDocuments),
    apply: (a) => ({ availableDocuments: a.ids }),
    clears: ['availableDocuments'],
  },

  {
    id: 'passport_upload',
    section: 'documents',
    prompt: {
      en: 'Please send a clear colour scan of all passport pages, including blank pages, in one PDF.',
      ta: 'காலி பக்கங்கள் உட்பட அனைத்து பாஸ்போர்ட் பக்கங்களின் தெளிவான வண்ண ஸ்கேனை ஒரே PDF-ஆக அனுப்பவும்.',
      hi: 'कृपया खाली पेज सहित पासपोर्ट के सभी पेजों का साफ़ रंगीन स्कैन एक ही PDF में भेजें।',
      te: 'దయచేసి పాస్‌పోర్ట్ పేజీలన్నీ (ఖాళీ పేజీలతో సహా) క్లియర్‌గా కలర్ స్కాన్ చేసి, ఒక్క PDF లో పంపండి.',
      ml: 'പാസ്പോർട്ടിന്റെ എല്ലാ പേജുകളും (ബ്ലാങ്ക് പേജുകൾ ഉൾപ്പെടെ) വ്യക്തമായ കളർ സ്കാൻ ചെയ്ത് ഒരൊറ്റ PDF ആയി അയക്കൂ.',
    },
    input: 'document',
    document: 'passport',
    allowMedia: true,
    allowStaff: true,
    hiddenChoices: DOCUMENT_FALLBACKS,
    when: (c) => wantsDocument(c,'passport'),
    satisfied: (c) => documentSatisfied(c, 'passport'),
  },

  // Order is passport → PAN → Aadhaar. Passport first because it is the one
  // document the flow has already been talking about; the two cards follow.
  {
    id: 'pan_upload',
    section: 'documents',
    prompt: {
      en: 'Please send your PAN card as a PDF, or as photos of the front and back.',
      ta: 'உங்கள் PAN அட்டையை PDF ஆகவோ, முன் மற்றும் பின் பக்க புகைப்படங்களாகவோ அனுப்பவும்.',
      hi: 'कृपया अपना PAN कार्ड PDF के रूप में, या आगे और पीछे की फ़ोटो के रूप में भेजें।',
      te: 'దయచేసి మీ PAN కార్డు PDF గా పంపండి, లేదా ముందు వెనుక ఫోటోలు పంపండి.',
      ml: 'നിങ്ങളുടെ PAN കാർഡ് PDF ആയോ, അല്ലെങ്കിൽ മുൻവശം പിൻവശം ഫോട്ടോ ആയോ അയക്കൂ.',
    },
    input: 'document',
    document: 'pan',
    allowMedia: true,
    allowStaff: true,
    hiddenChoices: DOCUMENT_FALLBACKS,
    when: (c) => wantsDocument(c, 'pan'),
    satisfied: (c) => documentSatisfied(c, 'pan'),
  },

  {
    id: 'aadhaar_upload',
    section: 'documents',
    prompt: {
      en: 'Please send your Aadhaar card as a PDF, or as photos of the front and back.',
      ta: 'உங்கள் ஆதார் அட்டையை PDF ஆகவோ, முன் மற்றும் பின் பக்க புகைப்படங்களாகவோ அனுப்பவும்.',
      hi: 'कृपया अपना आधार कार्ड PDF के रूप में, या आगे और पीछे की फ़ोटो के रूप में भेजें।',
      te: 'దయచేసి మీ ఆధార్ కార్డు PDF గా పంపండి, లేదా ముందు వెనుక ఫోటోలు పంపండి.',
      ml: 'നിങ്ങളുടെ ആധാർ കാർഡ് PDF ആയോ, അല്ലെങ്കിൽ മുൻവശം പിൻവശം ഫോട്ടോ ആയോ അയക്കൂ.',
    },
    input: 'document',
    document: 'aadhaar',
    allowMedia: true,
    allowStaff: true,
    hiddenChoices: DOCUMENT_FALLBACKS,
    when: (c) => wantsDocument(c, 'aadhaar'),
    satisfied: (c) => documentSatisfied(c, 'aadhaar'),
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * Trade questions (§8) — generated, not written out
 * ───────────────────────────────────────────────────────────────────────────*/

function tradeQuestionStep(packId: string, q: TradeQuestion): FlowStep {
  return {
    id: `trade:${packId}:${q.id}`,
    section: 'experience',
    prompt: q.prompt,
    input: q.choices.length ? (q.multi ? 'multi_choice' : 'choice') : 'text',
    choices: q.choices.length ? q.choices : undefined,
    allowMedia: q.allowMedia,
    expects: q.expects,
    when: (c) => {
      if (!(p(c).tradePacks as string[] | undefined)?.includes(packId)) return false;
      return q.when ? q.when((p(c).tradeAnswers ?? {}) as Record<string, string[]>) : true;
    },
    satisfied: (c) => has((p(c).tradeAnswers ?? {})[q.id]),
    apply: (a, c) => ({
      tradeAnswers: {
        ...(p(c).tradeAnswers ?? {}),
        [q.id]: a.ids?.length ? a.ids : a.value ? [a.value] : [],
      },
    }),
    clears: ['tradeAnswers'],
  };
}

/**
 * The slots generated trade questions are served through (§8).
 *
 * `STEPS` is built once at module load and the flow scheduler walks it, so a
 * question written for one candidate cannot be a step of its own. These are
 * fixed steps that read their question out of the candidate instead: slot `n`
 * applies when that candidate has an `n`th generated question, and disappears
 * when they do not. Nothing about `nextStep`, editing or the confirmation
 * changes, and a candidate served by a hand-written pack never sees one.
 *
 * `input` is `text` on all of them because a step's shape is fixed at load and
 * a generated question may or may not carry options. Where it does they are
 * rendered as buttons anyway — see `choicesFor` — and a tap resolves against
 * them exactly as it would for any other step; where it does not, the candidate
 * types. What the two share is that a typed answer is always accepted, which is
 * the safe default for a question nobody wrote in advance.
 */
function generatedQuestionStep(index: number): FlowStep {
  const at = (c: CandidateDoc): GeneratedQuestion | undefined =>
    (p(c).tradeQuestions as GeneratedQuestion[] | undefined)?.[index];

  return {
    id: `trade_extra:${index}`,
    section: 'experience',
    // Replaced at render time by the candidate's own question, which is already
    // in their language. This is the fallback for a step rendered without one,
    // which `when` makes unreachable.
    prompt: { en: '', ta: '', hi: '', te: '', ml: '' },
    input: 'text',
    allowMedia: true,
    when: (c) => !!at(c),
    satisfied: (c) => {
      const question = at(c);
      return !question || has((p(c).tradeAnswers ?? {})[question.id]);
    },
    apply: (a, c) => {
      const question = at(c);
      if (!question) return {};
      return {
        tradeAnswers: {
          ...(p(c).tradeAnswers ?? {}),
          [question.id]: a.ids?.length ? a.ids : a.value ? [a.value] : [],
        },
      };
    },
    clears: ['tradeAnswers'],
  };
}

/**
 * The job to write trade questions about — the candidate's own words wherever
 * they exist (§8).
 *
 * Three sources, in the order they are worth having. `currentOccupation` is
 * what they typed and what the flow already keeps. Failing that, the raw
 * wording `recordAnswer` stored against `primaryTrade`, which matters more than
 * it sounds: someone who *types* "plumber" has it read as the
 * Electrical/Mechanical category, and `main_trade.apply` deliberately does not
 * copy a category into `currentOccupation` — so their word survives only here,
 * and handing "Electrical / Mechanical" to a question writer instead of
 * "plumber" is the difference between questions about their trade and questions
 * about a menu heading. Last, the category label itself, for someone who tapped
 * one and said nothing else.
 */
export function occupationForQuestions(c: CandidateDoc): string | undefined {
  const own = (p(c).currentOccupation ?? '').trim();
  if (own.length > 1) return own;

  const trade = p(c).primaryTrade as string | undefined;
  // "Other" is not a job. The follow-up question collects the real one, and
  // until it does there is nothing worth writing questions about.
  if (!trade || trade === 'other') return undefined;

  const label = labelFor(trade, 'main_trade')?.en;
  const typed = (c.fieldMeta?.primaryTrade?.raw ?? '').trim();
  const same = (a: string, b: string) =>
    a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

  // A bare number is the position of an option in the list they were shown, not
  // a job — see `resolveLocally`.
  const usable =
    typed.length > 2 && !/^\d+$/.test(typed) && !(label && same(typed, label));

  return usable ? typed : label;
}

/** The generated question a slot is currently serving, for the renderer. */
export function generatedQuestionFor(
  stepId: string,
  c: CandidateDoc,
): GeneratedQuestion | undefined {
  if (!stepId.startsWith('trade_extra:')) return undefined;
  const index = Number(stepId.slice('trade_extra:'.length));
  if (!Number.isInteger(index)) return undefined;
  return (p(c).tradeQuestions as GeneratedQuestion[] | undefined)?.[index];
}

/** The one-question fork used when a trade maps to more than one pack. */
function disambiguationStep(): FlowStep {
  return {
    id: 'trade_disambiguation',
    section: 'experience',
    prompt: {
      en: 'Which is your main work?',
      ta: 'உங்கள் முக்கிய வேலை எது?',
      hi: 'आपका मुख्य काम कौन सा है?',
      te: 'మీ ముఖ్యమైన పని ఏంటి?',
      ml: 'നിങ്ങളുടെ പ്രധാന ജോലി എന്താണ്?',
    },
    input: 'choice',
    choices: [],
    when: (c) => {
      const trade = p(c).primaryTrade;
      if (!trade || has(p(c).tradePacks)) return false;
      // A tapped category that covers more than one trade is always asked
      // about. Selection beats inference: the candidate told us the category
      // and nothing else, so the only honest way to narrow it is to ask.
      if (p(c).tradeFromList && disambiguationFor(trade)) return true;
      return resolvePacks(trade, tradeSignals(c)).needsDisambiguation;
    },
    satisfied: (c) => has(p(c).tradePacks),
    apply: (a, c) => {
      const d = disambiguationFor(String(p(c).primaryTrade));
      const picked = d?.choices.find((ch) => ch.id === a.ids?.[0]);
      return { tradePacks: picked?.packs ?? [] };
    },
    clears: ['tradePacks', 'tradeAnswers'],
  };
}

/**
 * Fills in `tradePacks` when the candidate's own words already decide it, so the
 * disambiguation question is skipped. Returns undefined when nothing changes.
 */
export function inferTradePacks(c: CandidateDoc): string[] | undefined {
  if (has(p(c).tradePacks)) return undefined;
  const trade = p(c).primaryTrade;
  if (!trade) return undefined;

  // Never infer from keywords when the candidate picked the category from the
  // list and that category is ambiguous — the disambiguation question owns the
  // decision, and only the candidate's explicit answer loads a pack.
  if (p(c).tradeFromList && disambiguationFor(trade)) return undefined;

  const { packs, needsDisambiguation } = resolvePacks(trade, tradeSignals(c));
  if (needsDisambiguation) return undefined;
  return packs.map((pk) => pk.id);
}

/**
 * Pack answers the candidate's own words already settle, so those questions are
 * skipped (§1). Returns undefined when nothing new can be filled in.
 *
 * Runs after `inferTradePacks` and reads the same signals, which is the point:
 * the evidence that chose the pack was previously invisible to the questions
 * inside it, so a CV naming four welding processes picked the welder pack and
 * was then asked which welding processes he knew.
 *
 * Conservative by construction — see `answersFromEvidence`. An answer already
 * recorded is never overwritten, because the candidate's own reply outranks
 * anything read off their CV.
 */
export function inferTradeAnswers(c: CandidateDoc): Record<string, string[]> | undefined {
  const packs = p(c).tradePacks as string[] | undefined;
  if (!packs?.length) return undefined;

  const evidence = tradeSignals(c).filter(Boolean).join(' ');
  if (!evidence.trim()) return undefined;

  const answered = (p(c).tradeAnswers ?? {}) as Record<string, string[]>;
  let found: Record<string, string[]> | undefined;

  for (const packId of packs) {
    for (const question of packById(packId)?.questions ?? []) {
      if (has(answered[question.id])) continue;
      // A question gated on an answer inside its own pack is left alone: it may
      // not apply at all, and inferring an answer to it would be deciding that
      // for the candidate.
      if (question.when && !question.when(answered)) continue;

      const ids = answersFromEvidence(question, evidence);
      if (ids?.length) (found ??= {})[question.id] = ids;
    }
  }

  return found;
}

/** The disambiguation question's choices, resolved for this candidate. */
export function disambiguationChoices(c: CandidateDoc): Choice[] {
  return disambiguationFor(String(p(c).primaryTrade))?.choices ?? [];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * §18  Confirmation
 * ───────────────────────────────────────────────────────────────────────────*/

const CONFIRM_STEP: FlowStep = {
  id: 'confirm',
  section: 'confirm',
  // The body is built from the candidate's own answers, so the prompt here is
  // only the closing question — see `renderConfirmation` in render.ts.
  prompt: { en: 'Is this correct?', ta: 'இது சரியா?', hi: 'क्या यह सही है?', te: 'ఇది కరెక్టేనా?', ml: 'ഇത് ശരിയാണോ?' },
  input: 'choice',
  // These have to be declared here, not only inside `renderConfirmation`. The
  // step's choices are what the interpreter is offered, and with an empty list
  // no answer could ever match — not even a tapped button, whose id is checked
  // against this list before it is trusted. Registration could not complete.
  choices: CONFIRM_CHOICES,
  satisfied: (c) => c.stage === 'REGISTRATION_COMPLETED',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Assembly
 * ───────────────────────────────────────────────────────────────────────────*/

/** Every trade step that could ever be asked, across all packs. */
const ALL_TRADE_STEPS: FlowStep[] = [
  disambiguationStep(),
  ...['welder', 'fabricator', 'driver', 'cnc_operator', 'ndt'].flatMap((packId) => {
    const pack = packById(packId);
    return pack ? pack.questions.map((q) => tradeQuestionStep(packId, q)) : [];
  }),
  // After the packs, and only ever reached by a candidate no pack covers.
  ...Array.from({ length: MAX_GENERATED_QUESTIONS }, (_, i) => generatedQuestionStep(i)),
];

/**
 * The flow, in order.
 *
 * Trade questions sit between the experience questions and the job preferences,
 * because they are about what the candidate has done — and §9 is about what they
 * want next. Keeping that order stops the two from bleeding into each other.
 */
export const STEPS: FlowStep[] = [
  ...START_STEPS,
  ...B2B_STEPS,
  // Where they want to work is asked immediately after consent, because it is
  // the branch point: it decides whether the passport or the CV comes next.
  ...COUNTRY_STEPS,
  ...SINGAPORE_MALAYSIA_STEPS,
  CV_STEP,
  ...PERSONAL_STEPS,
  ...EXPERIENCE_STEPS,
  ...ALL_TRADE_STEPS,
  ...PREFERENCE_STEPS,
  ...PASSPORT_STEPS,
  ...DOCUMENT_STEPS,
  CONFIRM_STEP,
];

export function stepById(id: string): FlowStep | undefined {
  return STEPS.find((s) => s.id === id);
}

/**
 * The next question to ask, or undefined when there is nothing left.
 *
 * This is the whole scheduler. It runs on every turn against current state
 * rather than from a stored cursor, which is what makes "never ask twice" and
 * "resume where you stopped" the same mechanism rather than two features.
 */
export function nextStep(c: CandidateDoc): FlowStep | undefined {
  // An edit or update queues specific steps; they take priority over the
  // ordinary flow so the candidate is not walked through registration again (§18).
  for (const id of c.editQueue ?? []) {
    const step = stepById(id);
    if (step && (!step.when || step.when(c)) && !step.satisfied(c)) return step;
  }
  if ((c.editQueue ?? []).length) return CONFIRM_STEP;

  // A business contact is walked through their own four questions and none of
  // registration's. Branching here rather than guarding every step below is what
  // keeps the two flows from having to know about each other.
  for (const step of c.enquiry === 'b2b' ? B2B_STEPS : STEPS) {
    if (step.when && !step.when(c)) continue;
    if (step.satisfied(c)) continue;
    return step;
  }
  return undefined;
}

/** Steps belonging to a section, for the edit and update menus (§18, §22). */
export function stepsInSection(section: Section): FlowStep[] {
  return STEPS.filter((s) => s.section === section);
}

/** Profile fields an edit of this section must forget before re-asking. */
export function fieldsToClear(section: Section): string[] {
  return [...new Set(stepsInSection(section).flatMap((s) => s.clears ?? []))];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Label lookup
 *
 * The confirmation summary shows what the candidate chose, in their language.
 * Values are stored as option ids, so this maps back.
 * ───────────────────────────────────────────────────────────────────────────*/

const LABELS = new Map<string, Localised>();
for (const step of STEPS) {
  for (const choice of [...(step.choices ?? []), ...(step.hiddenChoices ?? [])]) {
    LABELS.set(`${step.id}:${choice.id}`, choice.label);
    if (!LABELS.has(choice.id)) LABELS.set(choice.id, choice.label);
  }
}
for (const d of ['fabrication_welding'].map(disambiguationFor)) {
  for (const choice of d?.choices ?? []) LABELS.set(choice.id, choice.label);
}

export function labelFor(optionId: string, stepId?: string): Localised | undefined {
  return (stepId ? LABELS.get(`${stepId}:${optionId}`) : undefined) ?? LABELS.get(optionId);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Boot-time validation
 * ───────────────────────────────────────────────────────────────────────────*/

export { render };

/**
 * Documents referenced by a step must exist in the checklist, and every step id
 * must be unique. Both are the kind of mistake that only shows up mid-conversation
 * otherwise.
 */
export function assertFlowIsWellFormed(): void {
  const seen = new Set<string>();
  for (const step of STEPS) {
    if (seen.has(step.id)) throw new Error(`duplicate flow step id: ${step.id}`);
    seen.add(step.id);

    if (step.document && !DOCUMENTS.some((d) => d.id === step.document)) {
      throw new Error(`step ${step.id} asks for unknown document "${step.document}"`);
    }
    if (step.input === 'structured' && !step.fields?.length) {
      throw new Error(`step ${step.id} is structured but declares no fields`);
    }
  }
}
