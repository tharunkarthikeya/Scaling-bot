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
 *              a driver is never asked about welding, a GCC candidate is never
 *              asked for their PAN card.
 *   satisfied  whether we already know the answer, from any source.
 *   apply      what the answer means, as fields to write.
 *   clears     what an edit of this section must forget, so re-asking works.
 *
 * Nothing here decides *phrasing*. The prompt is the phrasing.
 */

import type { CandidateDoc, CandidateProfile } from '../db/models.js';
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
  disambiguationFor,
  packById,
  resolvePacks,
  type TradeQuestion,
} from './trades.js';
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
  { id: 'below_10', label: { en: 'Below 10th', ta: '10-ஆம் வகுப்புக்கு கீழ்', hi: '10वीं से कम' } },
  { id: 'class_10', label: { en: '10th', ta: '10-ஆம் வகுப்பு', hi: '10वीं' } },
  { id: 'class_12', label: { en: '12th', ta: '12-ஆம் வகுப்பு', hi: '12वीं' } },
  { id: 'iti', label: { en: 'ITI', ta: 'ITI', hi: 'ITI' } },
  { id: 'diploma', label: { en: 'Diploma', ta: 'டிப்ளோமா', hi: 'डिप्लोमा' } },
  { id: 'graduate', label: { en: 'Graduate', ta: 'பட்டப்படிப்பு', hi: 'ग्रेजुएट' } },
  { id: 'other', label: OTHER },
];

export const TRADE_CHOICES: Choice[] = [
  {
    id: 'fabrication_welding',
    label: { en: 'Fabrication / Welding', ta: 'ஃபேப்ரிகேஷன்/வெல்டிங்', hi: 'फैब्रिकेशन/वेल्डिंग' },
  },
  { id: 'construction', label: { en: 'Construction', ta: 'கட்டுமானம்', hi: 'निर्माण कार्य' } },
  {
    id: 'driver_operator',
    label: { en: 'Driver / Operator', ta: 'டிரைவர்/ஆபரேட்டர்', hi: 'ड्राइवर/ऑपरेटर' },
  },
  {
    id: 'electrical_mechanical',
    label: { en: 'Electrical / Mechanical', ta: 'எலெக்ட்ரிகல்/மெக்கானிக்', hi: 'इलेक्ट्रिकल/मैकेनिकल' },
  },
  {
    id: 'factory_warehouse',
    label: { en: 'Factory / Warehouse', ta: 'தொழிற்சாலை/கிடங்கு', hi: 'फैक्ट्री/वेयरहाउस' },
  },
  { id: 'hospitality', label: { en: 'Hospitality', ta: 'ஹாஸ்பிடாலிட்டி', hi: 'हॉस्पिटैलिटी' } },
  { id: 'sales_retail', label: { en: 'Sales / Retail', ta: 'விற்பனை/ரீடெயில்', hi: 'सेल्स/रिटेल' } },
  {
    id: 'cleaning_housekeeping',
    label: { en: 'Cleaning / Housekeeping', ta: 'க்ளீனிங்/ஹவுஸ்கீப்பிங்', hi: 'क्लीनिंग/हाउसकीपिंग' },
  },
  { id: 'fresher', label: { en: 'Fresher', ta: 'புதியவர்', hi: 'फ्रेशर' } },
  { id: 'other', label: OTHER },
];

export const EXPERIENCE_CHOICES: Choice[] = [
  { id: 'fresher', label: { en: 'Fresher', ta: 'புதியவர்', hi: 'फ्रेशर' } },
  { id: 'below_2', label: { en: 'Below 2 years', ta: '2 ஆண்டுக்கு கீழ்', hi: '2 साल से कम' } },
  { id: '2_5', label: { en: '2–5 years', ta: '2–5 ஆண்டுகள்', hi: '2–5 साल' } },
  { id: '5_10', label: { en: '5–10 years', ta: '5–10 ஆண்டுகள்', hi: '5–10 साल' } },
  { id: 'above_10', label: { en: 'Above 10 years', ta: '10 ஆண்டுக்கு மேல்', hi: '10 साल से ज़्यादा' } },
];

export const GENERAL_JOB_CHOICES: Choice[] = [
  { id: 'factory', label: { en: 'Factory', ta: 'தொழிற்சாலை', hi: 'फैक्ट्री' } },
  { id: 'warehouse', label: { en: 'Warehouse', ta: 'கிடங்கு', hi: 'वेयरहाउस' } },
  { id: 'packing', label: { en: 'Packing', ta: 'பேக்கிங்', hi: 'पैकिंग' } },
  { id: 'helper', label: { en: 'General Helper', ta: 'ஹெல்பர்', hi: 'हेल्पर' } },
  { id: 'construction', label: { en: 'Construction', ta: 'கட்டுமானம்', hi: 'निर्माण' } },
  { id: 'cleaning', label: { en: 'Cleaning', ta: 'க்ளீனிங்', hi: 'क्लीनिंग' } },
  { id: 'hospitality', label: { en: 'Hospitality', ta: 'ஹாஸ்பிடாலிட்டி', hi: 'हॉस्पिटैलिटी' } },
  { id: 'delivery', label: { en: 'Delivery', ta: 'டெலிவரி', hi: 'डिलीवरी' } },
  { id: 'other', label: OTHER },
];

export const COUNTRY_CHOICES: Choice[] = [
  { id: 'gcc', label: { en: 'GCC', ta: 'வளைகுடா நாடுகள் (GCC)', hi: 'GCC देश' } },
  { id: 'europe', label: { en: 'Europe', ta: 'ஐரோப்பா', hi: 'यूरोप' } },
  { id: 'russia_cis', label: { en: 'Russia / CIS', ta: 'ரஷ்யா/CIS', hi: 'रूस/CIS' } },
  {
    id: 'singapore_malaysia',
    label: { en: 'Singapore / Malaysia', ta: 'சிங்கப்பூர்/மலேசியா', hi: 'सिंगापुर/मलेशिया' },
  },
  { id: 'any', label: { en: 'Any country', ta: 'எந்த நாடும்', hi: 'कोई भी देश' } },
  {
    id: 'select',
    label: { en: 'Select countries', ta: 'நாடுகளைத் தேர்வு', hi: 'देश चुनें' },
  },
];

export const DOCUMENT_CHOICES: Choice[] = [
  { id: 'passport', label: { en: 'Passport', ta: 'பாஸ்போர்ட்', hi: 'पासपोर्ट' } },
  { id: 'aadhaar', label: { en: 'Aadhaar', ta: 'ஆதார்', hi: 'आधार' } },
  { id: 'pan', label: { en: 'PAN', ta: 'PAN', hi: 'PAN' } },
];

const YES_NO: Choice[] = [
  { id: 'yes', label: { en: 'Yes', ta: 'ஆம்', hi: 'हाँ' } },
  { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं' } },
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
    label: { en: 'I will send it later', ta: 'பிறகு அனுப்புகிறேன்', hi: 'बाद में भेजूँगा' },
  },
  {
    id: 'dont_have',
    label: { en: 'I do not have it', ta: 'என்னிடம் இல்லை', hi: 'मेरे पास नहीं है' },
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
      { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं' } },
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
    },
    input: 'choice',
    choices: [
      { id: 'en', label: { en: 'English', ta: 'English', hi: 'English' } },
      { id: 'ta', label: { en: 'தமிழ்', ta: 'தமிழ்', hi: 'தமிழ்' } },
      { id: 'hi', label: { en: 'हिंदी', ta: 'हिंदी', hi: 'हिंदी' } },
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
    },
    input: 'choice',
    choices: [
      { id: 'yes', label: { en: 'Yes, continue', ta: 'ஆம், தொடரவும்', hi: 'हाँ, आगे बढ़ें' } },
      { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं' } },
      CHOICE_STAFF,
    ],
    // Consent lives on the candidate, not the profile — the engine writes it.
    satisfied: (c) => c.consent?.given === true,
  },

  {
    id: 'cv',
    section: 'cv',
    prompt: {
      en: 'Please send your CV as a PDF, Word file or clear photo.',
      ta: 'உங்கள் CV-ஐ PDF, Word கோப்பு அல்லது தெளிவான புகைப்படமாக அனுப்பவும்.',
      hi: 'कृपया अपना CV — PDF, Word फ़ाइल या साफ़ फ़ोटो — भेजें।',
    },
    input: 'document',
    document: 'cv',
    allowMedia: true,
    choices: [
      { id: 'upload_cv', label: { en: 'Upload CV', ta: 'CV அனுப்ப', hi: 'CV भेजें' } },
      { id: 'no_cv', label: { en: "I don't have a CV", ta: 'CV இல்லை', hi: 'CV नहीं है' } },
    ],
    hiddenChoices: DOCUMENT_FALLBACKS,
    allowStaff: true,
    satisfied: (c) => documentSatisfied(c, 'cv'),
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
    },
    hint: {
      en: 'Example: Chennai, Tamil Nadu',
      ta: 'எடுத்துக்காட்டு: சென்னை, தமிழ்நாடு',
      hi: 'उदाहरण: चेन्नई, तमिलनाडु',
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
    },
    hint: {
      en: 'Example: 15/08/1995',
      ta: 'எடுத்துக்காட்டு: 15/08/1995',
      hi: 'उदाहरण: 15/08/1995',
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

const PREFERENCE_STEPS: FlowStep[] = [
  {
    id: 'job_preference',
    section: 'job_preference',
    prompt: {
      en: 'What type of work are you looking for now?',
      ta: 'இப்போது எந்த வகை வேலை தேடுகிறீர்கள்?',
      hi: 'अब आप किस तरह का काम ढूंढ रहे हैं?',
    },
    input: 'choice',
    choices: [
      {
        id: 'current_trade',
        label: { en: 'My current trade', ta: 'என் தற்போதைய வேலை', hi: 'मेरा मौजूदा काम' },
      },
      {
        id: 'related',
        label: { en: 'Related skilled jobs', ta: 'தொடர்புடைய வேலைகள்', hi: 'मिलते-जुलते काम' },
      },
      {
        id: 'general',
        label: { en: 'Any general work', ta: 'ஏதேனும் பொது வேலை', hi: 'कोई भी सामान्य काम' },
      },
      { id: 'different', label: { en: 'Different job', ta: 'வேறு வேலை', hi: 'अलग काम' } },
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
    },
    input: 'choice',
    choices: [
      {
        id: 'only_my_job',
        label: { en: 'Only my job', ta: 'என் வேலை மட்டும்', hi: 'सिर्फ़ मेरा काम' },
      },
      {
        id: 'related_ok',
        label: { en: 'Related jobs okay', ta: 'தொடர்புடையது சரி', hi: 'मिलते-जुलते ठीक हैं' },
      },
      {
        id: 'any_suitable',
        label: { en: 'Any suitable work', ta: 'ஏதேனும் பொருத்தமானது', hi: 'कोई भी उपयुक्त काम' },
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
    },
    input: 'choice',
    choices: [
      // Kept inside WhatsApp's 20-character button limit; the full question is
      // in the prompt above, so the buttons only have to be distinguishable.
      {
        id: 'any_suitable',
        label: { en: 'Yes, any work', ta: 'ஆம், எந்த வேலையும்', hi: 'हाँ, कोई भी काम' },
      },
      {
        id: 'selected',
        label: { en: 'Only selected jobs', ta: 'சில வேலைகள் மட்டும்', hi: 'सिर्फ़ चुने हुए काम' },
      },
      {
        id: 'need_details',
        label: { en: 'Need details first', ta: 'முதலில் விவரம்', hi: 'पहले जानकारी चाहिए' },
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
    },
    input: 'choice',
    choices: [
      { id: 'yes', label: { en: 'Yes', ta: 'ஆம்', hi: 'हाँ' } },
      { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं' } },
      {
        id: 'depends',
        label: { en: 'Depends on details', ta: 'விவரத்தைப் பொறுத்து', hi: 'जानकारी पर निर्भर' },
      },
    ],
    when: (c) => p(c).workTypePreference === 'different',
    satisfied: (c) => has(p(c).trainingWillingness),
    apply: (a) => ({ trainingWillingness: a.ids?.[0] }),
    clears: ['trainingWillingness'],
  },

  {
    id: 'country_preference',
    section: 'country',
    prompt: {
      en: 'Where would you like to work?',
      ta: 'எங்கு வேலை செய்ய விரும்புகிறீர்கள்?',
      hi: 'आप कहाँ काम करना चाहेंगे?',
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
    },
    hint: {
      en: 'Example: Romania, Serbia and Russia',
      ta: 'எடுத்துக்காட்டு: ருமேனியா, செர்பியா மற்றும் ரஷ்யா',
      hi: 'उदाहरण: रोमानिया, सर्बिया और रूस',
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
    },
    input: 'choice',
    choices: [
      {
        id: 'strict',
        label: { en: 'Only these countries', ta: 'இந்த நாடுகள் மட்டும்', hi: 'सिर्फ़ ये देश' },
      },
      {
        id: 'prefer',
        label: { en: 'Others okay too', ta: 'மற்ற நாடுகளும் சரி', hi: 'दूसरे देश भी चलेंगे' },
      },
      {
        id: 'any',
        label: { en: 'Any suitable country', ta: 'ஏதேனும் நாடு', hi: 'कोई भी देश' },
      },
    ],
    // Only meaningful once they have named somewhere specific. "Any country"
    // already answers this question.
    when: (c) => p(c).countryPreference !== 'any',
    satisfied: (c) => has(p(c).countryStrictness),
    apply: (a) => ({ countryStrictness: a.ids?.[0] }),
    clears: ['countryStrictness'],
  },

  {
    id: 'availability',
    section: 'availability',
    prompt: {
      en: 'When can you join?',
      ta: 'எப்போது சேர முடியும்?',
      hi: 'आप कब जॉइन कर सकते हैं?',
    },
    input: 'choice',
    choices: [
      { id: 'immediate', label: { en: 'Immediately', ta: 'உடனடியாக', hi: 'तुरंत' } },
      { id: 'within_15', label: { en: 'Within 15 days', ta: '15 நாட்களுக்குள்', hi: '15 दिन के अंदर' } },
      { id: 'within_30', label: { en: 'Within 30 days', ta: '30 நாட்களுக்குள்', hi: '30 दिन के अंदर' } },
      {
        id: 'more_than_30',
        label: { en: 'More than 30 days', ta: '30 நாட்களுக்கு மேல்', hi: '30 दिन से ज़्यादा' },
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
    },
    input: 'choice',
    choices: [
      { id: 'yes', label: { en: 'Yes', ta: 'ஆம்', hi: 'हाँ' } },
      { id: 'applied', label: { en: 'Applied', ta: 'விண்ணப்பித்தேன்', hi: 'अप्लाई किया है' } },
      { id: 'expired', label: { en: 'Expired', ta: 'காலாவதியானது', hi: 'एक्सपायर हो गया' } },
      { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं' } },
    ],
    satisfied: (c) => has(p(c).passportStatus),
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
    id: 'passport_expiry',
    section: 'passport',
    prompt: {
      en: 'When does your passport expire?',
      ta: 'உங்கள் பாஸ்போர்ட் எப்போது காலாவதியாகும்?',
      hi: 'आपका पासपोर्ट कब एक्सपायर हो रहा है?',
    },
    hint: { en: 'Example: 03/2031', ta: 'எடுத்துக்காட்டு: 03/2031', hi: 'उदाहरण: 03/2031' },
    input: 'month_year',
    when: (c) => p(c).passportStatus === 'yes',
    satisfied: (c) => has(p(c).passportExpiry),
    apply: (a) => ({ passportExpiry: a.value }),
    clears: ['passportExpiry'],
  },

  {
    id: 'passport_applied_when',
    section: 'passport',
    prompt: {
      en: 'When did you apply for it?',
      ta: 'எப்போது விண்ணப்பித்தீர்கள்?',
      hi: 'आपने कब अप्लाई किया था?',
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
 * Every step here is gated on `inEuropeRussiaBranch`. A GCC candidate never
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
    },
    input: 'choice',
    choices: [
      { id: 'all', label: { en: 'All available', ta: 'எல்லாம் உள்ளன', hi: 'सभी उपलब्ध हैं' } },
      { id: 'some', label: { en: 'Some are missing', ta: 'சில இல்லை', hi: 'कुछ नहीं हैं' } },
      { id: 'later', label: { en: 'Upload later', ta: 'பிறகு அனுப்புகிறேன்', hi: 'बाद में भेजूँगा' } },
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

/** The one-question fork used when a trade maps to more than one pack. */
function disambiguationStep(): FlowStep {
  return {
    id: 'trade_disambiguation',
    section: 'experience',
    prompt: {
      en: 'Which is your main work?',
      ta: 'உங்கள் முக்கிய வேலை எது?',
      hi: 'आपका मुख्य काम कौन सा है?',
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
  prompt: { en: 'Is this correct?', ta: 'இது சரியா?', hi: 'क्या यह सही है?' },
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

  for (const step of STEPS) {
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
