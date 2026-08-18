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

/**
 * An option that a CV can name.
 *
 * `evidence` is what the candidate's own words would have to say for this option
 * to be true — the terms a CV actually uses for it, including the ones the
 * option's label does not: nobody writes "ARC / SMAW" on a CV, they write SMAW,
 * and GMAW and MIG are the same process under two names. Trade knowledge, so it
 * lives here beside the option rather than in the matching code.
 */
export interface TradeChoice extends Choice {
  evidence?: string[];
}

export interface TradeQuestion {
  /** Stable key. Answers are stored under `profile.tradeAnswers[id]`. */
  id: string;
  prompt: Localised;
  choices: TradeChoice[];
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
  /**
   * What a free-text answer to this question has to be about.
   *
   * Only meaningful on a question with no options, because a question with
   * options already constrains its answers by offering them. Without this the
   * interpreter is told only "this question wants free text", and it has no
   * grounds to treat "tailor machine" as anything other than a tidy answer to
   * "which machines have you operated?" — so it was stored as machining
   * experience and the candidate was never asked again (§1 cuts both ways).
   *
   * The interpreter classifies an incompatible answer `related` rather than
   * `value`, which replies to what they said and puts the question back. It is
   * never a blacklist of wrong answers: the model is told what the question is
   * about and judges the answer against that, so a question about welding
   * positions or licence classes gets the same protection by declaring what it
   * is about.
   */
  expects?: { context: string; examples?: string };
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
          { id: 'tig', label: { en: 'TIG', ta: 'TIG', hi: 'TIG' }, evidence: ['tig', 'gtaw'] },
          {
            id: 'arc_smaw',
            label: { en: 'ARC / SMAW', ta: 'ARC / SMAW', hi: 'ARC / SMAW' },
            evidence: ['smaw', 'stick welding', 'shielded metal arc'],
          },
          { id: 'mig', label: { en: 'MIG', ta: 'MIG', hi: 'MIG' }, evidence: ['mig', 'gmaw'] },
          {
            id: 'fcaw',
            label: { en: 'FCAW', ta: 'FCAW', hi: 'FCAW' },
            evidence: ['fcaw', 'flux cored'],
          },
          {
            id: 'saw',
            label: { en: 'SAW', ta: 'SAW', hi: 'SAW' },
            evidence: ['saw', 'submerged arc'],
          },
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
          {
            id: 'structural',
            label: { en: 'Structural', ta: 'ஸ்ட்ரக்சரல்', hi: 'स्ट्रक्चरल' },
            evidence: ['structural steel', 'structural fabrication'],
          },
          {
            id: 'peb',
            label: { en: 'PEB', ta: 'PEB', hi: 'PEB' },
            evidence: ['peb', 'pre engineered building'],
          },
          {
            id: 'tank',
            label: { en: 'Tank', ta: 'டேங்க்', hi: 'टैंक' },
            evidence: ['storage tank', 'storage tanks'],
          },
          {
            id: 'vessel',
            label: { en: 'Vessel', ta: 'வெசல்', hi: 'वेसल' },
            evidence: ['pressure vessel', 'pressure vessels', 'heat exchanger'],
          },
          {
            id: 'pipe',
            label: { en: 'Pipe', ta: 'பைப்', hi: 'पाइप' },
            evidence: ['piping', 'pipe fabrication', 'pipe fitting'],
          },
          {
            id: 'sheet_metal',
            label: { en: 'Sheet metal', ta: 'ஷீட் மெட்டல்', hi: 'शीट मेटल' },
            evidence: ['sheet metal'],
          },
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
        // Names CNC, because "which machines have you operated?" does not: a
        // tailor, a packer and a crane driver have all operated machines, and
        // the question was never about those. The pack is only loaded for a
        // machining candidate, so naming it costs nothing and removes the one
        // reading of the question that produced wrong answers.
        prompt: {
          en: 'Which CNC machines have you operated? You can type them, send a photo, or send a voice note.',
          ta: 'எந்தெந்த CNC இயந்திரங்களை இயக்கியுள்ளீர்கள்? தட்டச்சு செய்யலாம், புகைப்படம் அல்லது குரல் செய்தியும் அனுப்பலாம்.',
          hi: 'आपने कौन-कौन सी CNC मशीनें चलाई हैं? आप टाइप कर सकते हैं, फ़ोटो या वॉइस नोट भी भेज सकते हैं।',
        },
        multi: false,
        allowMedia: true,
        choices: [],
        expects: {
          context: 'CNC and machine-shop machine tools',
          examples:
            'VMC, HMC, CNC lathe, turning centre, machining centre, Fanuc or Siemens controls, ' +
            'conventional lathe, milling machine, drilling machine, surface grinder',
        },
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
          { id: 'asnt', label: { en: 'ASNT', ta: 'ASNT', hi: 'ASNT' }, evidence: ['asnt'] },
          { id: 'pcn', label: { en: 'PCN', ta: 'PCN', hi: 'PCN' }, evidence: ['pcn'] },
          { id: 'irata', label: { en: 'IRATA', ta: 'IRATA', hi: 'IRATA' }, evidence: ['irata'] },
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
 * Answers the CV already gave
 *
 * §1: never ask for what we already know. The pack questions were the one place
 * that rule did not reach — the evidence that *chose* the pack was then invisible
 * to the questions inside it, so a CV reading "Welding Procedures
 * (SMAW/GTAW/GMAW/SAW)" and "ASNT Level-II" selected the welder and NDT packs
 * and then asked which welding processes he knew and which certifications he
 * held. The bot picked the right questions using facts it went on to ask for.
 *
 * The reason it could not was structural rather than an oversight: a pack answer
 * is an option id, CV evidence is free text, and nothing mapped one to the
 * other. `evidence` is that map, written next to the option it belongs to.
 *
 * Opt-in on purpose. A choice with no `evidence` is never inferred, so adding a
 * question is still adding data and nothing else, and a question that should
 * always be asked — "do you have a valid welding certificate?", which a list of
 * certifications cannot answer, because holding one and holding a *valid* one
 * are different claims — simply declares none.
 * ───────────────────────────────────────────────────────────────────────────*/

/** Whether the evidence names this term, as a whole word rather than a substring. */
function names(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * The answers this question's own options can be settled from, or undefined.
 *
 * Deliberately silent in three cases, each of which costs one question and
 * saves a wrong answer on a permanent record:
 *
 *   - no option declares evidence, so the question is not inferable at all;
 *   - nothing matched;
 *   - a single-answer question matched more than one option, which is the CV
 *     being ambiguous rather than the CV answering.
 */
export function answersFromEvidence(q: TradeQuestion, evidence: string): string[] | undefined {
  if (!evidence.trim()) return undefined;

  const matched = q.choices.filter(
    (c) => c.id !== 'other' && (c.evidence ?? []).some((term) => names(evidence, term)),
  );

  if (!matched.length) return undefined;
  if (!q.multi && matched.length > 1) return undefined;

  return matched.map((c) => c.id);
}

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
 * Returns an empty array when the trade has no packs at all — the normal case
 * for Hospitality, Sales, Cleaning and Fresher, which get no trade questions,
 * exactly as §8 requires — and also when it has packs but nothing supports any
 * of them. A pack is loaded on evidence or on the candidate's own answer to the
 * disambiguation question, and on nothing else.
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

  // Nothing the candidate has told us supports any pack under this trade.
  //
  // This used to load the pack anyway whenever the trade had exactly one, on
  // the reasoning that there was nothing to choose between. There was nothing
  // to choose *from* — which is not the same thing, and it is how a planning
  // manager whose CV never mentions a machine tool came to be asked which CNC
  // machines he had operated, and then had "tailor machine" recorded as an
  // answer to it. One candidate pack is not evidence; it is a coincidence of
  // how the packs happen to be filed.
  //
  // So: ask, where the trade has a question that would settle it, and
  // otherwise ask nothing. A candidate skipping trade questions they had no
  // business being asked loses nothing — §8's questions exist to sharpen a
  // match, and a sharpened match built on an invented answer is worse than an
  // unsharpened one.
  return {
    packs: [],
    needsDisambiguation: disambiguationFor(trade) !== undefined,
  };
}
