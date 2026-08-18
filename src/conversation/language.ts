/**
 * Languages, localised copy, and the size limits WhatsApp enforces on
 * interactive messages.
 *
 * English, Tamil, Hindi, Telugu and Malayalam are first-class: every
 * candidate-facing string in this codebase ships in all five, and the flow they
 * are asked in is the same array of steps regardless — a language changes the
 * wording and nothing else. A candidate who asks for a sixth language gets the
 * English string translated at send time and cached — see `translate.ts`.
 *
 * The limits below are Meta's, not ours. Exceeding one does not degrade
 * gracefully: the Graph API rejects the whole message and the candidate gets
 * silence. `assertFits` is called at boot so an over-long Tamil label fails the
 * deploy rather than the conversation.
 */

export const CORE_LANGUAGES = ['en', 'ta', 'hi', 'te', 'ml'] as const;

export type CoreLanguage = (typeof CORE_LANGUAGES)[number];

/** 'other' means the candidate named a language we do not ship copy for. */
export type Language = CoreLanguage | 'other';

/** A string in every language the bot ships. */
export type Localised = Record<CoreLanguage, string>;

/**
 * One tappable answer.
 *
 * `id` is the contract. It is what the candidate's tap actually returns, what
 * gets written to the database, and what the interpreter must choose from — so
 * it never changes when the wording does, and it is identical in every language.
 * A Tamil speaker and an English speaker tapping the same row produce the same
 * id, which is what keeps the flow language-independent.
 */
export interface Choice {
  id: string;
  label: Localised;
  /** Shown under the label in a list. Ignored when rendered as buttons. */
  description?: Localised;
}

export const LANGUAGE_NAMES: Record<CoreLanguage, string> = {
  en: 'English',
  ta: 'Tamil',
  hi: 'Hindi',
  te: 'Telugu',
  ml: 'Malayalam',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * WhatsApp Cloud API limits
 *
 * Reply buttons and list rows are the two interactive shapes we use. Three
 * options or fewer become buttons; four to ten become a list; anything more
 * cannot be rendered natively and is a design error, caught at boot.
 * ───────────────────────────────────────────────────────────────────────────*/

export const WA_LIMITS = {
  /** Body of an interactive message. Plain text messages allow 4096. */
  body: 1024,
  header: 60,
  footer: 60,
  buttonTitle: 20,
  /** Reply buttons per message. */
  buttons: 3,
  listButtonText: 20,
  listRowTitle: 24,
  listRowDescription: 72,
  /** Rows across every section of one list. */
  listRows: 10,
} as const;

/**
 * Counts characters the way Meta does — by code point, not UTF-16 unit. Tamil
 * and Devanagari combining marks each count as one, so `String.length` and the
 * limit disagree exactly where the copy is longest.
 */
export function glyphLength(text: string): number {
  return [...text].length;
}

/** Hard-truncates to a limit. The last line of defence; boot assertions catch these first. */
export function fit(text: string, limit: number): string {
  const glyphs = [...text];
  if (glyphs.length <= limit) return text;
  return glyphs.slice(0, limit - 1).join('').trimEnd() + '…';
}

export class CopyTooLongError extends Error {
  constructor(where: string, language: string, limit: number, actual: number, text: string) {
    super(
      `${where} [${language}] is ${actual} characters; WhatsApp allows ${limit}. ` +
        `Shorten it in the copy: "${text}"`,
    );
    this.name = 'CopyTooLongError';
  }
}

/**
 * Throws if any language's version of `value` exceeds `limit`, or is written in
 * the wrong script. Used at boot.
 */
export function assertFits(where: string, value: Localised, limit: number): void {
  for (const lang of CORE_LANGUAGES) {
    const actual = glyphLength(value[lang]);
    if (actual > limit) throw new CopyTooLongError(where, lang, limit, actual, value[lang]);
  }
  assertScript(where, value);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Script
 *
 * Copy in five languages is copy in four Indic scripts, and a Telugu sentence
 * with a Bengali or Gujarati character in the middle of a word is not a typo a
 * reader can see past — it is a glyph that does not belong to the alphabet they
 * read, in the middle of a word they are trying to read on a phone. It is also
 * exactly what a translation pass produces when it slips, and it is invisible in
 * review to anyone who does not read the script.
 *
 * So it is checked, not trusted, the same way lengths are.
 * ───────────────────────────────────────────────────────────────────────────*/

/** Where each language's letters live. English is Latin and unconstrained. */
const SCRIPT_BLOCKS: Partial<Record<CoreLanguage, readonly [number, number]>> = {
  hi: [0x0900, 0x097f],
  ta: [0x0b80, 0x0bff],
  te: [0x0c00, 0x0c7f],
  ml: [0x0d00, 0x0d7f],
};

/** Devanagari through Malayalam — every Indic block Unicode puts in this range. */
const INDIC_RANGE: readonly [number, number] = [0x0900, 0x0d7f];

export class WrongScriptError extends Error {
  constructor(where: string, language: string, character: string, text: string) {
    super(
      `${where} [${language}] contains "${character}" (U+${character
        .codePointAt(0)!
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')}), which belongs to a different script. ` +
        `Rewrite it in ${language} only: "${text}"`,
    );
    this.name = 'WrongScriptError';
  }
}

/**
 * Whether text meant for one language borrows a letter from another Indic
 * script. The non-throwing form, for text written at runtime rather than
 * checked at boot — see `tradeQuestions.ts`.
 */
/**
 * Throws if a language's copy borrows a letter from another Indic script.
 *
 * A value that is identical in every language is left alone: that is a proper
 * noun or a name shown as itself — "English", "தமிழ்", "PAN" — and the language
 * menu depends on being able to write each language's name in its own script
 * whatever the reader's language is.
 */
export function hasForeignScript(text: string, language: Language | undefined): boolean {
  const block = language && language !== 'other' ? SCRIPT_BLOCKS[language] : undefined;
  if (!block) return false;

  for (const character of text) {
    const code = character.codePointAt(0)!;
    const indic = code >= INDIC_RANGE[0] && code <= INDIC_RANGE[1];
    if (indic && (code < block[0] || code > block[1])) return true;
  }
  return false;
}

export function assertScript(where: string, value: Localised): void {
  const first = value[CORE_LANGUAGES[0]];
  if (CORE_LANGUAGES.every((lang) => value[lang] === first)) return;

  for (const lang of CORE_LANGUAGES) {
    const block = SCRIPT_BLOCKS[lang];
    if (!block) continue;

    for (const character of value[lang]) {
      const code = character.codePointAt(0)!;
      const indic = code >= INDIC_RANGE[0] && code <= INDIC_RANGE[1];
      if (indic && (code < block[0] || code > block[1])) {
        throw new WrongScriptError(where, lang, character, value[lang]);
      }
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Detection
 *
 * Used once, to choose the language of the welcome message before the candidate
 * has picked one. Script detection is deterministic and free; the model is not
 * consulted. The candidate is asked to confirm a moment later either way, so a
 * wrong guess here costs nothing.
 * ───────────────────────────────────────────────────────────────────────────*/

const TAMIL = /[஀-௿]/;
const DEVANAGARI = /[ऀ-ॿ]/;
const TELUGU = /[ఀ-౿]/;
const MALAYALAM = /[ഀ-ൿ]/;

/**
 * Best guess at the language of a first message. Returns undefined when there is
 * nothing to go on — an empty message, a bare emoji, or a file with no caption.
 *
 * Latin script resolves to English. It cannot distinguish English from romanised
 * Tamil or Hindi ("naan welder", "mujhe job chahiye"), and it does not try: the
 * language question is asked explicitly on the next turn.
 */
export function detectLanguage(text: string | undefined): CoreLanguage | undefined {
  if (!text) return undefined;
  if (TAMIL.test(text)) return 'ta';
  if (DEVANAGARI.test(text)) return 'hi';
  if (TELUGU.test(text)) return 'te';
  if (MALAYALAM.test(text)) return 'ml';
  if (/[a-z]/i.test(text)) return 'en';
  return undefined;
}

/**
 * Resolves the language to use for copy. A candidate on 'other' reads English
 * copy that the translation layer rewrites before sending; this returns the
 * source language for that rewrite.
 */
export function copyLanguage(language: Language | undefined): CoreLanguage {
  return language && language !== 'other' ? language : 'en';
}
