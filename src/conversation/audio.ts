/**
 * Voice notes (§3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE HOOK FOR A TRANSCRIPTION PROVIDER. IT IS THE ONLY THING TO FILL IN.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing in the current configuration can turn audio into text. Meta's API
 * delivers the file, Veris reads documents, and the Claude API takes text and
 * images — none of them transcribe speech. So `transcribe` returns undefined
 * and the flow falls back to asking the candidate to tap or type, while the
 * audio itself is stored against the candidate for staff to listen to.
 *
 * To turn voice notes on, implement `transcribe` below. Everything else already
 * works: `engine.ts` calls it for every inbound voice note, and a returned
 * string is fed to the interpreter exactly as if the candidate had typed it —
 * which is what §3 means by "voice notes may be understood, but important
 * information must be converted into structured text".
 *
 * Providers that handle Tamil and Hindi well, for whoever picks one:
 *
 *   Sarvam AI      saarika model. Built for Indian languages; best Tamil accuracy.
 *   Google STT     chirp_2. Broad language coverage, familiar billing.
 *   Deepgram       nova-3. Fast and cheap; Hindi is solid, Tamil is weaker.
 *   OpenAI Whisper Widely used, but noticeably worse on Tamil than the above.
 *
 * A provider needs a base URL and a key in `config.ts` alongside the Veris ones,
 * and this function needs to post the buffer and return the text. Roughly:
 *
 *   const form = new FormData();
 *   form.append('file', new Blob([audio.buffer], { type: audio.mimeType }), 'note.ogg');
 *   form.append('language_code', languageHintFor(audio.language));
 *   const res = await fetch(`${config.STT_BASE_URL}/speech-to-text`, {
 *     method: 'POST',
 *     headers: { 'api-subscription-key': config.STT_API_KEY },
 *     body: form,
 *     signal: AbortSignal.timeout(30_000),
 *   });
 *   if (!res.ok) return undefined;
 *   return ((await res.json()) as { transcript?: string }).transcript?.trim() || undefined;
 *
 * Two things to keep when implementing it. Return undefined rather than throwing
 * or guessing — the fallback is a working path and a wrong transcript is not.
 * And pass the candidate's chosen language as a hint: these models are markedly
 * more accurate when told whether to expect Tamil or Hindi.
 */

import { logger } from '../logger.js';
import type { Language } from './language.js';

export interface VoiceNote {
  buffer: Buffer;
  mimeType: string;
  /** The candidate's chosen language, as a hint to the recogniser. */
  language?: Language;
}

/** True when a provider is wired up. Drives whether the flow offers voice at all. */
export function transcriptionAvailable(): boolean {
  return false;
}

/**
 * Transcribes a voice note, or returns undefined when that is not possible.
 *
 * Undefined is a normal outcome, not an error: the caller stores the audio for
 * staff and asks the candidate to tap or type instead.
 */
export async function transcribe(note: VoiceNote): Promise<string | undefined> {
  if (!transcriptionAvailable()) {
    logger.debug(
      { bytes: note.buffer.byteLength },
      'voice note stored; no transcription provider configured',
    );
    return undefined;
  }

  // Implement here. See the note at the top of this file.
  return undefined;
}
