import crypto from 'node:crypto';
import { webhookSecrets } from '../conversation/lines.js';

/**
 * Meta signs every webhook delivery with the app secret. Anything unsigned or
 * mis-signed is someone else pretending to be Meta — reject it.
 *
 * The signature covers the raw request bytes, so this must run against the body
 * exactly as received. Re-serialising the parsed JSON changes the bytes and the
 * comparison will never match.
 *
 * Checked against every secret the business owns, which is one unless the two
 * numbers sit under two Meta apps — see `webhookSecrets`. The comparison is
 * constant-time per secret and the list is ours, so trying both accepts nothing
 * a single check would have refused.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;

  const provided = header.slice('sha256='.length);

  // Accumulated rather than returned early, so the work done does not depend on
  // which secret matched.
  let matched = false;

  for (const secret of webhookSecrets()) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    // Both are fixed-length hex, so a length mismatch means malformed input.
    if (provided.length !== expected.length) continue;

    if (crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))) {
      matched = true;
    }
  }

  return matched;
}
