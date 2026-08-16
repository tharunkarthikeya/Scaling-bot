/**
 * Proves a deployed endpoint will satisfy Meta *before* you repoint the
 * callback URL at it.
 *
 *   npm run verify:endpoint https://bot.example.com
 *
 * Every check is non-destructive. The signed POST carries a delivery-status
 * event rather than a message, so it exercises signature verification, parsing
 * and the ack path without creating a candidate or sending anything.
 */
import crypto from 'node:crypto';
import { config } from './config.js';

const baseUrl = (process.argv[2] ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');

if (!baseUrl) {
  console.error('usage: npm run verify:endpoint <https://your-domain>');
  process.exit(2);
}
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(baseUrl);

if (!baseUrl.startsWith('https://') && !isLocal) {
  console.error(`refusing to test ${baseUrl} — Meta requires HTTPS on port 443`);
  process.exit(2);
}
if (isLocal) {
  console.warn(
    '\x1b[33mTesting a local address. Meta cannot reach this — ' +
      're-run against the public HTTPS domain before repointing.\x1b[0m',
  );
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let failures = 0;

function report(ok: boolean, name: string, detail: string, fix?: string) {
  if (!ok) failures++;
  console.log(`${ok ? `${GREEN}  ok  ` : `${RED} FAIL `}${RESET} ${name.padEnd(30)} ${detail}`);
  if (!ok && fix) console.log(`${DIM}       → ${fix}${RESET}`);
}

async function timed(url: string, init?: RequestInit) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
}

console.log(`\n\x1b[1mVerifying ${baseUrl}\x1b[0m\n`);

/* 1. Is anything there at all? ------------------------------------------- */

try {
  const res = await timed(`${baseUrl}/health`);
  const body: any = await res.json().catch(() => ({}));
  report(
    res.ok && body?.ok === true,
    'health',
    res.ok ? `${res.status} shadowMode=${body?.shadowMode}` : `${res.status}`,
    'The container is not running, or the domain is not mapped to its port.',
  );
  if (body?.shadowMode === true) {
    report(false, 'shadow mode', 'ON — replies would be generated and discarded', 'Set SHADOW_MODE=false.');
  }
} catch (err) {
  report(false, 'health', err instanceof Error ? err.message : String(err), 'Domain unreachable or TLS invalid.');
}

/* 2. The subscription handshake Meta performs when you save the URL ------ */

const challenge = `probe-${Date.now()}`;

try {
  const url =
    `${baseUrl}/webhook?hub.mode=subscribe` +
    `&hub.verify_token=${encodeURIComponent(config.WHATSAPP_WEBHOOK_VERIFY_TOKEN)}` +
    `&hub.challenge=${challenge}`;
  const res = await timed(url);
  const text = (await res.text()).trim();
  report(
    res.ok && text === challenge,
    'verification handshake',
    res.ok && text === challenge ? 'challenge echoed correctly' : `${res.status} body="${text.slice(0, 60)}"`,
    'WHATSAPP_WEBHOOK_VERIFY_TOKEN here must equal the token typed into Meta.',
  );
} catch (err) {
  report(false, 'verification handshake', err instanceof Error ? err.message : String(err));
}

/* 3. A wrong token must be refused --------------------------------------- */

try {
  const res = await timed(
    `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=definitely-wrong&hub.challenge=x`,
  );
  report(
    res.status === 403,
    'rejects a wrong token',
    `${res.status}`,
    'Anyone could otherwise complete the handshake against your endpoint.',
  );
} catch (err) {
  report(false, 'rejects a wrong token', err instanceof Error ? err.message : String(err));
}

/* 4. A correctly signed delivery — creates nothing, sends nothing -------- */

const statusPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: config.WHATSAPP_WABA_ID ?? 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: config.WHATSAPP_PHONE_NUMBER_ID },
            // A status, not a message: nothing downstream creates a candidate.
            statuses: [
              {
                id: `wamid.PROBE${Date.now()}`,
                recipient_id: '000000000000',
                status: 'delivered',
                timestamp: String(Math.floor(Date.now() / 1000)),
              },
            ],
          },
        },
      ],
    },
  ],
};

const raw = Buffer.from(JSON.stringify(statusPayload));
const goodSig =
  'sha256=' + crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');

try {
  const res = await timed(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': goodSig },
    body: raw,
  });
  report(
    res.status === 200,
    'accepts a signed delivery',
    `${res.status}`,
    'WHATSAPP_APP_SECRET on the server does not match the one used here.',
  );
} catch (err) {
  report(false, 'accepts a signed delivery', err instanceof Error ? err.message : String(err));
}

/* 5. A forged delivery must be refused ----------------------------------- */

try {
  const res = await timed(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
    body: raw,
  });
  report(
    res.status === 401,
    'rejects a forged delivery',
    `${res.status}`,
    'Signature verification is not working — anyone could post fake candidate messages.',
  );
} catch (err) {
  report(false, 'rejects a forged delivery', err instanceof Error ? err.message : String(err));
}

console.log('');
if (failures === 0) {
  console.log(`${GREEN}Endpoint is ready. It is safe to repoint Meta's callback URL here.${RESET}`);
  console.log(`${DIM}Callback URL:  ${baseUrl}/webhook${RESET}`);
  console.log(`${DIM}Verify token:  the value of WHATSAPP_WEBHOOK_VERIFY_TOKEN${RESET}`);
} else {
  console.log(`${RED}${failures} check(s) failed — do not repoint Meta yet.${RESET}`);
  console.log(`${DIM}Repointing now would take career-pathways-suite offline without this bot working.${RESET}`);
}
console.log('');

process.exit(failures ? 1 : 0);
