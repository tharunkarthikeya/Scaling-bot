/**
 * Languages, localised copy, and the size limits WhatsApp enforces on
 * interactive messages.
 *
 * The protocol supports English, Tamil and Hindi as first-class languages: every
 * candidate-facing string in this codebase ships in all three. A candidate who
 * asks for something else gets the English string translated at send time and
 * cached — see `translate.ts`.
 *
 * The limits below are Meta's, not ours. Exceeding one does not degrade
 * gracefully: the Graph API rejects the whole message and the candidate gets
 * silence. `assertFits` is called at boot so an over-long Tamil label fails the
 * deploy rather than the conversation.
 */

export const CORE_LANGUAGES = ['en', 'ta', 'hi'] as const;

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

/** Throws if any language's version of `value` exceeds `limit`. Used at boot. */
export function assertFits(where: string, value: Localised, limit: number): void {
  for (const lang of CORE_LANGUAGES) {
    const actual = glyphLength(value[lang]);
    if (actual > limit) throw new CopyTooLongError(where, lang, limit, actual, value[lang]);
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
