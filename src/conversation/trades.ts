/**
 * Trade-specific questions (§8).
 *
 * A welder is asked about welding processes. A driver is asked which vehicles
 * they can drive. Nobody is asked both. §8 requires these to be configurable
 * without changing the main conversation logic, so they live here as data and
 * the flow reads them generically — adding a trade means adding a pack to this
 * file and nothing else.
 *
 * Packs attach to the coarse trade a candidate picks at `main_trade`. Several
 * packs can share one trade — "Fabrication/Welding" covers both welders and
 * fabricators — in which case the pack is chosen by matching keywords against
 * what the candidate actually said and what their CV shows. When that is still
 * ambiguous, one short disambiguation question decides it, rather than asking
 * every question from every pack.
 */

import type { Choice, Localised } from './language.js';
import { OTHER } from './copy.js';

export interface TradeQuestion {
  /** Stable key. Answers are stored under `profile.tradeAnswers[id]`. */
  id: string;
  prompt: Localised;
  choices: Choice[];
  /** True when the candidate may pick several answers. */
  multi: boolean;
  /** When the candidate picks `other`, ask them to type it. */
  otherPrompt?: Localised;
  /** Ask only when this returns true, given the answers already collected in this pack. */
  when?: (answers: Record<string, string[]>) => boolean;
  /**
   * Accept a photo or voice note as the answer as well as a tap (§8 — CNC
   * operators are told they may answer by text, image, or voice).
   */
  allowMedia?: boolean;
}

export interface TradePack {
  id: string;
  /** Trade ids from `main_trade` this pack can serve. */
  trades: string[];
  /** Words in the candidate's own wording or CV that select this pack. */
  keywords: string[];
  questions: TradeQuestion[];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Packs
 * ───────────────────────────────────────────────────────────────────────────*/

export const TRADE_PACKS: TradePack[] = [
  {
    id: 'welder',
    trades: ['fabrication_welding'],
    keywords: [
      'welder', 'welding', 'weld', 'tig', 'mig', 'arc', 'smaw', 'fcaw', 'saw',
      'வெல்டர்', 'வெல்டிங்', 'वेल्डर', 'वेल्डिंग',
    ],
    questions: [
      {
        id: 'welding_process',
        prompt: {
          en: 'Which welding processes do you know?',
          ta: 'எந்தெந்த வெல்டிங் முறைகள் தெரியும்?',
          hi: 'आपको कौन-कौन सी वेल्डिंग प्रोसेस आती हैं?',
        },
        multi: true,
        choices: [
          { id: 'tig', label: { en: 'TIG', ta: 'TIG', hi: 'TIG' } },
          { id: 'arc_smaw', label: { en: 'ARC / SMAW', ta: 'ARC / SMAW', hi: 'ARC / SMAW' } },
          { id: 'mig', label: { en: 'MIG', ta: 'MIG', hi: 'MIG' } },
          { id: 'fcaw', label: { en: 'FCAW', ta: 'FCAW', hi: 'FCAW' } },
          { id: 'saw', label: { en: 'SAW', ta: 'SAW', hi: 'SAW' } },
          { id: 'other', label: OTHER },
        ],
        otherPrompt: {
          en: 'Please type the welding process.',
          ta: 'வெல்டிங் முறையைத் தட்டச்சு செய்யவும்.',
          hi: 'कृपया वेल्डिंग प्रोसेस टाइप करें।',
        },
      },
      {
        id: 'welding_certificate',
        prompt: {
          en: 'Do you have a valid welding certificate?',
          ta: 'செல்லுபடியாகும் வெல்டிங் சான்றிதழ் உள்ளதா?',
          hi: 'क्या आपके पास वैध वेल्डिंग सर्टिफिकेट है?',
        },
        multi: false,
        choices: [
          { id: 'yes', label: { en: 'Yes', ta: 'ஆம்', hi: 'हाँ' } },
          { id: 'no', label: { en: 'No', ta: 'இல்லை', hi: 'नहीं' } },
          { id: 'expired', label: { en: 'Expired', ta: 'காலாவதி', hi: 'एक्सपायर' } },
        ],
      },
    ],
  },

  {
    id: 'fabricator',
    trades: ['fabrication_welding'],
    keywords: [
      'fabricator', 'fabrication', 'fabricator', 'fitter', 'structural', 'peb',
      'ஃபேப்ரிகேஷன்', 'फैब्रिकेशन', 'फिटर',
    ],
    questions: [
      {
        id: 'fabrication_type',
        prompt: {
          en: 'What type of fabrication work do you do?',
          ta: 'எந்த வகை ஃபேப்ரிகேஷன் வேலை செய்கிறீர்கள்?',
          hi: 'आप किस तरह का फैब्रिकेशन काम करते हैं?',
        },
        multi: true,
        choices: [
          { id: 'structural', label: { en: 'Structural', ta: 'ஸ்ட்ரக்சரல்', hi: 'स्ट्रक्चरल' } },
          { id: 'peb', label: { en: 'PEB', ta: 'PEB', hi: 'PEB' } },
          { id: 'tank', label: { en: 'Tank', ta: 'டேங்க்', hi: 'टैंक' } },
          { id: 'vessel', label: { en: 'Vessel', ta: 'வெசல்', hi: 'वेसल' } },
          { id: 'pipe', label: { en: 'Pipe', ta: 'பைப்', hi: 'पाइप' } },
          { id: 'sheet_metal', label: { en: 'Sheet metal', ta: 'ஷீட் மெட்டல்', hi: 'शीट मेटल' } },
          { id: 'other', label: OTHER },
        ],
        otherPrompt: {
          en: 'Please type the type of fabrication work.',
          ta: 'ஃபேப்ரிகேஷன் வேலை வகையைத் தட்டச்சு செய்யவும்.',
          hi: 'कृपया फैब्रिकेशन काम का प्रकार टाइप करें।',
        },
      },
    ],
  },

  {
    id: 'driver',
    trades: ['driver_operator'],
    keywords: [
      'driver', 'driving', 'drive', 'chauffeur', 'trailer', 'bus', 'lorry', 'truck',
      'டிரைவர்', 'ஓட்டுநர்', 'ड्राइवर', 'चालक',
    ],
    questions: [
      {
        id: 'driver_vehicles',
        prompt: {
          en: 'Which vehicles can you drive?',
          ta: 'எந்தெந்த வாகனங்களை ஓட்டுவீர்கள்?',
          hi: 'आप कौन-कौन से वाहन चला सकते हैं?',
        },
        multi: true,
        choices: [
          { id: 'light', label: { en: 'Light vehicle', ta: 'லைட் வாகனம்', hi: 'लाइट व्हीकल' } },
          { id: 'heavy', label: { en: 'Heavy vehicle', ta: 'ஹெவி வாகனம்', hi: 'हैवी व्हीकल' } },
          { id: 'trailer', label: { en: 'Trailer', ta: 'டிரெய்லர்', hi: 'ट्रेलर' } },
          { id: 'bus', label: { en: 'Bus', ta: 'பஸ்', hi: 'बस' } },
          { id: 'forklift', label: { en: 'Forklift', ta: 'ஃபோர்க்லிஃப்ட்', hi: 'फोर्कलिफ्ट' } },
          { id: 'equipment', label: { en: 'Equipment', ta: 'எக்யூப்மென்ட்', hi: 'इक्विपमेंट' } },
          { id: 'other', label: OTHER },
        ],
        otherPrompt: {
          en: 'Please type which vehicle you drive.',
          ta: 'நீங்கள் ஓட்டும் வாகனத்தைத் தட்டச்சு செய்யவும்.',
          hi: 'कृपया टाइप करें कि आप कौन सा वाहन चलाते हैं।',
        },
      },
      {
        id: 'driver_licences',
        prompt: {
          en: 'Which driving licences do you hold?',
          ta: 'உங்களிடம் எந்த ஓட்டுநர் உரிமங்கள் உள்ளன?',
          hi: 'आपके पास कौन-कौन से ड्राइविंग लाइसेंस हैं?',
        },
        multi: true,
        allowMedia: true,
        choices: [
          { id: 'indian_lmv', label: { en: 'Indian LMV', ta: 'இந்திய LMV', hi: 'भारतीय LMV' } },
          { id: 'indian_hmv', label: { en: 'Indian HMV', ta: 'இந்திய HMV', hi: 'भारतीय HMV' } },
          { id: 'gulf', label: { en: 'Gulf licence', ta: 'வளைகுடா உரிமம்', hi: 'गल्फ लाइसेंस' } },
          { id: 'international', label: { en: 'International', ta: 'சர்வதேசம்', hi: 'इंटरनेशनल' } },
          { id: 'none', label: { en: 'None yet', ta: 'இன்னும் இல்லை', hi: 'अभी नहीं' } },
          { id: 'other', label: OTHER },
        ],
        otherPrompt: {
          en: 'Please type which licence you hold.',
          ta: 'உங்களிடம் உள்ள உரிமத்தைத் தட்டச்சு செய்யவும்.',
          hi: 'कृपया टाइप करें कि आपके पास कौन सा लाइसेंस है।',
        },
      },
    ],
  },

  {
    id: 'cnc_operator',
    trades: ['driver_operator', 'factory_warehouse', 'electrical_mechanical'],
    keywords: [
      'cnc', 'vmc', 'hmc', 'lathe', 'machinist', 'turner', 'miller', 'milling',
      'operator', 'machine operator', 'மெஷின்', 'मशीन', 'ऑपरेटर',
    ],
    questions: [
      {
        id: 'machines_operated',
        prompt: {
          en: 'Which machines have you operated? You can type them, send a photo, or send a voice note.',
          ta: 'எந்தெந்த இயந்திரங்களை இயக்கியுள்ளீர்கள்? தட்டச்சு செய்யலாம், புகைப்படம் அல்லது குரல் செய்தியும் அனுப்பலாம்.',
          hi: 'आपने कौन-कौन सी मशीनें चलाई हैं? आप टाइप कर सकते हैं, फ़ोटो या वॉइस नोट भी भेज सकते हैं।',
        },
        multi: false,
        allowMedia: true,
        choices: [],
      },
    ],
  },

  {
    id: 'ndt',
    trades: ['electrical_mechanical', 'fabrication_welding'],
    keywords: [
      'ndt', 'asnt', 'pcn', 'irata', 'ultrasonic', 'radiograph', 'mpi', 'dpt',
      'ut level', 'rt level', 'non destructive',
    ],
    questions: [
      {
        id: 'ndt_certifications',
        prompt: {
          en: 'Which valid certifications do you hold?',
          ta: 'செல்லுபடியாகும் எந்தச் சான்றிதழ்கள் உங்களிடம் உள்ளன?',
          hi: 'आपके पास कौन-कौन से वैध सर्टिफिकेट हैं?',
        },
        multi: true,
        choices: [
          { id: 'asnt', label: { en: 'ASNT', ta: 'ASNT', hi: 'ASNT' } },
          { id: 'pcn', label: { en: 'PCN', ta: 'PCN', hi: 'PCN' } },
          { id: 'irata', label: { en: 'IRATA', ta: 'IRATA', hi: 'IRATA' } },
          { id: 'other', label: OTHER },
        ],
        otherPrompt: {
          en: 'Please type the certification.',
          ta: 'சான்றிதழைத் தட்டச்சு செய்யவும்.',
          hi: 'कृपया सर्टिफिकेट टाइप करें।',
        },
      },
    ],
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * Disambiguation
 *
 * Asked only when a trade has several packs and nothing the candidate has told
 * us picks one. One question is cheaper than asking every pack's questions, and
 * far cheaper than guessing wrong and storing a welder as a fabricator.
 * ───────────────────────────────────────────────────────────────────────────*/

export interface Disambiguation {
  trade: string;
  prompt: Localised;
  /** Choice id -> pack ids to run. */
  choices: Array<Choice & { packs: string[] }>;
}

export const DISAMBIGUATIONS: Disambiguation[] = [
  {
    trade: 'fabrication_welding',
    prompt: {
      en: 'Which is your main work?',
      ta: 'உங்கள் முக்கிய வேலை எது?',
      hi: 'आपका मुख्य काम कौन सा है?',
    },
    choices: [
      {
        id: 'welding',
        label: { en: 'Welding', ta: 'வெல்டிங்', hi: 'वेल्डिंग' },
        packs: ['welder'],
      },
      {
        id: 'fabrication',
        label: { en: 'Fabrication', ta: 'ஃபேப்ரிகேஷன்', hi: 'फैब्रिकेशन' },
        packs: ['fabricator'],
      },
      {
        id: 'both',
        label: { en: 'Both', ta: 'இரண்டும்', hi: 'दोनों' },
        packs: ['welder', 'fabricator'],
      },
    ],
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * Resolution
 * ───────────────────────────────────────────────────────────────────────────*/

export function packById(id: string): TradePack | undefined {
  return TRADE_PACKS.find((p) => p.id === id);
}

export function packsForTrade(trade: string): TradePack[] {
  return TRADE_PACKS.filter((p) => p.trades.includes(trade));
}

export function disambiguationFor(trade: string): Disambiguation | undefined {
  return DISAMBIGUATIONS.find((d) => d.trade === trade);
}

/**
 * Chooses which packs to run.
 *
 * `signals` is everything the candidate has told us in their own words — what
 * they typed at `main_trade`, their current job title, and the skills their CV
 * listed. A welder who typed "welder" never sees the disambiguation question;
 * one who tapped "Fabrication/Welding" and said nothing else does.
 *
 * Returns an empty array when the trade has no packs at all, which is the normal
 * case for Hospitality, Sales, Cleaning and Fresher — they get no trade
 * questions, exactly as §8 requires.
 */
export function resolvePacks(
  trade: string | undefined,
  signals: Array<string | undefined>,
): { packs: TradePack[]; needsDisambiguation: boolean } {
  if (!trade) return { packs: [], needsDisambiguation: false };

  const candidates = packsForTrade(trade);
  if (candidates.length === 0) return { packs: [], needsDisambiguation: false };

  const haystack = signals.filter(Boolean).join(' ').toLowerCase();
  const matched = haystack
    ? candidates.filter((p) => p.keywords.some((kw) => haystack.includes(kw.toLowerCase())))
    : [];

  if (matched.length) return { packs: matched, needsDisambiguation: false };
  if (candidates.length === 1) return { packs: candidates, needsDisambiguation: false };

  // Several packs, nothing to choose between them. Ask, if there is a question
  // defined; otherwise skip trade questions rather than ask all of them.
  return {
    packs: [],
    needsDisambiguation: disambiguationFor(trade) !== undefined,
  };
}
