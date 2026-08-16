/**
 * Checks every link in the chain between a candidate's WhatsApp message and a
 * reply, and reports which one is broken.
 *
 * Run it wherever the bot runs — locally, or inside the Dokploy container:
 *   npm run doctor
 *
 * It is read-only apart from one throwaway document written to Mongo and one
 * throwaway file written to storage, both removed immediately.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, graphBaseUrl } from './config.js';

type State = 'ok' | 'warn' | 'fail';

const results: Array<{ state: State; name: string; detail: string; fix?: string }> = [];

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function record(state: State, name: string, detail: string, fix?: string) {
  results.push({ state, name, detail, fix });
  const badge =
    state === 'ok' ? `${GREEN}  ok  ${RESET}` : state === 'warn' ? `${YELLOW} warn ${RESET}` : `${RED} FAIL ${RESET}`;
  console.log(`${badge} ${name.padEnd(26)} ${detail}`);
  if (fix) console.log(`${DIM}       → ${fix}${RESET}`);
}

function short(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]!.slice(0, 160);
}

console.log(`\n\x1b[1mAdira bot — diagnostics\x1b[0m`);
console.log(`${DIM}environment: ${config.NODE_ENV}   model: ${config.CLAUDE_MODEL}${RESET}\n`);

/* 1. The single most common reason a working bot stays silent ------------- */

if (config.SHADOW_MODE) {
  record(
    'fail',
    'shadow mode',
    'ON — replies are generated but never sent to WhatsApp',
    'Set SHADOW_MODE=false and redeploy. This alone makes the bot appear dead.',
  );
} else {
  record('ok', 'shadow mode', 'off — replies will be sent');
}

if (config.MOCK_WHATSAPP_MEDIA) {
  record(
    'fail',
    'mock media',
    'ON — candidate documents are replaced by a test fixture',
    'Remove MOCK_WHATSAPP_MEDIA from the environment. It is for local testing only.',
  );
}

/* 2. Database ------------------------------------------------------------- */

let dbOk = false;
try {
  const { connectDb, closeDb } = await import('./db/client.js');
  const db = await connectDb();
  await db.command({ ping: 1 });

  const probe = db.collection('_doctor');
  await probe.insertOne({ at: new Date() });
  await probe.deleteMany({});

  const host = config.MONGODB_URI.replace(/\/\/[^@]*@/, '//<credentials>@');
  record('ok', 'mongodb', `connected and writable — ${host}`);
  dbOk = true;
  await closeDb();
} catch (err) {
  record(
    'fail',
    'mongodb',
    short(err),
    'On Dokploy use the database\'s Internal Connection URL, not localhost. ' +
      'The app and the database must be in the same project to resolve the internal host.',
  );
}

/* 3. Storage -------------------------------------------------------------- */

try {
  const root = path.resolve(config.STORAGE_PATH);
  await fs.mkdir(root, { recursive: true });
  const probe = path.join(root, `.doctor-${Date.now()}`);
  await fs.writeFile(probe, 'ok');
  await fs.unlink(probe);
  record('ok', 'storage', `writable — ${root}`);
} catch (err) {
  record(
    'fail',
    'storage',
    short(err),
    'STORAGE_PATH must point at a writable mounted volume. Candidate documents live here.',
  );
}

/* 4. Anthropic ------------------------------------------------------------ */

try {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  // Free, and still validates both the key and the model id.
  await client.messages.countTokens({
    model: config.CLAUDE_MODEL,
    messages: [{ role: 'user', content: 'ping' }],
  });
  record('ok', 'anthropic', `key valid, model ${config.CLAUDE_MODEL}`);
} catch (err) {
  record(
    'fail',
    'anthropic',
    short(err),
    'Check ANTHROPIC_API_KEY and CLAUDE_MODEL. Without this every reply is the fallback message.',
  );
}

/* 5. OCR ------------------------------------------------------------------ */

try {
  const { ocrHealth } = await import('./ocr/veris.js');
  const health = await ocrHealth();
  record(
    health.ok ? 'ok' : 'warn',
    'veris ocr',
    health.detail,
    health.ok ? undefined : 'Documents are still received and stored; only extraction is affected.',
  );
} catch (err) {
  record('warn', 'veris ocr', short(err), 'Non-fatal — the bot still collects documents.');
}

/* 6. WhatsApp credentials ------------------------------------------------- */

async function graphGet(pathname: string): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${graphBaseUrl}/${pathname}`, {
    headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

try {
  const r = await graphGet(
    `${config.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`,
  );
  if (r.ok) {
    record(
      'ok',
      'whatsapp number',
      `${r.body.display_phone_number ?? '?'} (${r.body.verified_name ?? '?'}) quality=${r.body.quality_rating ?? '?'}`,
    );
  } else {
    record(
      'fail',
      'whatsapp number',
      `${r.status} ${r.body?.error?.message ?? ''}`,
      'WHATSAPP_ACCESS_TOKEN may be expired, or WHATSAPP_PHONE_NUMBER_ID is wrong. ' +
        'A temporary token from the dashboard expires in 24 hours — use a System User token.',
    );
  }
} catch (err) {
  record('fail', 'whatsapp number', short(err));
}

/* 7. Is Meta actually subscribed to send us anything? --------------------- */

if (config.WHATSAPP_WABA_ID) {
  try {
    const r = await graphGet(`${config.WHATSAPP_WABA_ID}/subscribed_apps`);
    const apps = Array.isArray(r.body?.data) ? r.body.data : [];
    if (r.ok && apps.length) {
      const names = apps
        .map((a: any) => a?.whatsapp_business_api_data?.name ?? a?.whatsapp_business_api_data?.id ?? '?')
        .join(', ');
      record('ok', 'webhook subscription', `app subscribed — ${names}`);
    } else if (r.ok) {
      record(
        'fail',
        'webhook subscription',
        'no app is subscribed to this WABA',
        'In Meta → WhatsApp → Configuration, set the callback URL and verify token, ' +
          'then subscribe the app to the "messages" field. Until this exists, nothing reaches the bot.',
      );
    } else {
      record('warn', 'webhook subscription', `${r.status} ${r.body?.error?.message ?? ''}`);
    }
  } catch (err) {
    record('warn', 'webhook subscription', short(err));
  }
} else {
  record('warn', 'webhook subscription', 'WHATSAPP_WABA_ID not set — cannot check');
}

/* 8. Summary -------------------------------------------------------------- */

const failures = results.filter((r) => r.state === 'fail');
const warnings = results.filter((r) => r.state === 'warn');

console.log('');
if (failures.length === 0) {
  console.log(`${GREEN}All checks passed.${RESET}`);
  console.log(
    `${DIM}If messages still do not arrive, the gap is between Meta and this process: ` +
      `the callback URL must be public HTTPS on port 443 and must reach this container.${RESET}`,
  );
} else {
  console.log(`${RED}${failures.length} blocking problem(s):${RESET}`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
}
if (warnings.length) {
  console.log(`${YELLOW}${warnings.length} warning(s) — not fatal.${RESET}`);
}
console.log('');

process.exit(failures.length ? 1 : 0);
