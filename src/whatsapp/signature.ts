import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Meta signs every webhook delivery with the app secret. Anything unsigned or
 * mis-signed is someone else pretending to be Meta — reject it.
 *
 * The signature covers the raw request bytes, so this must run against the body
 * exactly as received. Re-serialising the parsed JSON changes the bytes and the
 * comparison will never match.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;

  const expected = crypto
    .createHmac('sha256', config.WHATSAPP_APP_SECRET)
    .update(rawBody)
    .digest('hex');

  const provided = header.slice('sha256='.length);

  // Both are fixed-length hex, so a length mismatch means malformed input.
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}
