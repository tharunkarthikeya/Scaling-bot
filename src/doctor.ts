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
import { accessTokenFor } from './conversation/lines.js';

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
  if (config.STORAGE_DRIVER === 's3') {
    // HeadBucket through the real backend, so this proves the same thing the
    // application proves at boot rather than a rehearsal of it.
    const { ensureStorageRoot } = await import('./storage/index.js');
    await ensureStorageRoot();
    record('ok', 'storage', `s3 — bucket ${config.S3_BUCKET} reachable`);
  } else {
    const root = path.resolve(config.STORAGE_PATH);
    await fs.mkdir(root, { recursive: true });
    const probe = path.join(root, `.doctor-${Date.now()}`);
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    record('ok', 'storage', `local — writable, ${root}`);

    // Correct on one instance and silently wrong on two: whichever process
    // downloads a document is rarely the one that reads it back for OCR.
    if (config.ROLE !== 'all') {
      record(
        'fail',
        'storage',
        `STORAGE_DRIVER=local with ROLE=${config.ROLE}`,
        'A local volume is not visible to the other role. Set STORAGE_DRIVER=s3.',
      );
    }
  }
} catch (err) {
  record(
    'fail',
    'storage',
    short(err),
    config.STORAGE_DRIVER === 's3'
      ? 'Check S3_BUCKET, S3_ENDPOINT, S3_REGION and the credentials. Candidate documents live here.'
      : 'STORAGE_PATH must point at a writable mounted volume. Candidate documents live here.',
  );
}

/* 3b. Redis --------------------------------------------------------------- */

try {
  const { pingRedis, redisEnabled } = await import('./redis/index.js');

  if (!redisEnabled()) {
    // Not a failure on its own — one instance with no Redis is a supported and
    // fully correct deployment. It is only fatal for a role, and config.ts has
    // already refused to start in that case.
    record(
      config.ROLE === 'all' ? 'warn' : 'fail',
      'redis',
      'REDIS_URL is not set',
      'Queue, candidate locks and rate limits are per-process. Correct for exactly ' +
        'one instance; unsafe behind a load balancer.',
    );
  } else {
    const { ok, error } = await pingRedis();
    if (ok) record('ok', 'redis', 'reachable — queue, locks and rate limits are shared');
    else {
      record(
        'fail',
        'redis',
        error ?? 'no response',
        'On Dokploy use the Internal Connection URL of the Redis service. The app and Redis ' +
          'must be in the same project to resolve the internal host.',
      );
    }
  }
} catch (err) {
  record('fail', 'redis', short(err), 'Check REDIS_URL.');
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

async function graphGet(
  pathname: string,
  line?: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${graphBaseUrl}/${pathname}`, {
    headers: { Authorization: `Bearer ${accessTokenFor(line)}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Both numbers, where a second one is configured. A second line that is set to
// an id the token cannot see is a flow nobody can reach and a candidate whose
// replies fail to send — and it would otherwise show up only in production, on
// the first message to that number.
const lines: Array<{ label: string; id: string; variable: string }> = [
  {
    label: 'whatsapp number',
    id: config.WHATSAPP_PHONE_NUMBER_ID,
    variable: 'WHATSAPP_PHONE_NUMBER_ID',
  },
  ...(config.WHATSAPP_PHONE_NUMBER_ID_SGMY
    ? [
        {
          label: 'whatsapp number (second line)',
          id: config.WHATSAPP_PHONE_NUMBER_ID_SGMY,
          variable: 'WHATSAPP_PHONE_NUMBER_ID_SGMY',
        },
      ]
    : []),
];

if (lines.length === 1) {
  record('ok', 'whatsapp lines', 'one number; WHATSAPP_PHONE_NUMBER_ID_SGMY is not set');
} else if (lines[0]!.id === lines[1]!.id) {
  record(
    'fail',
    'whatsapp lines',
    'both numbers are the same id',
    'WHATSAPP_PHONE_NUMBER_ID_SGMY must be the *other* number. Set to the same ' +
      'id, the second number is not configured at all and nothing checks it.',
  );
}

for (const line of lines) {
  try {
    const r = await graphGet(
      `${line.id}?fields=display_phone_number,verified_name,quality_rating`,
      line.id,
    );
    if (r.ok) {
      record(
        'ok',
        line.label,
        `${r.body.display_phone_number ?? '?'} (${r.body.verified_name ?? '?'}) quality=${r.body.quality_rating ?? '?'}`,
      );
    } else {
      record(
        'fail',
        line.label,
        `${r.status} ${r.body?.error?.message ?? ''}`,
        `WHATSAPP_ACCESS_TOKEN may be expired, or ${line.variable} is wrong. ` +
          'A temporary token from the dashboard expires in 24 hours — use a System User token.',
      );
    }
  } catch (err) {
    record('fail', line.label, short(err));
  }
}

/* 7. Is Meta actually subscribed to send us anything? --------------------- */

// Every WABA, because the two numbers are on two of them. Checking one would
// report the fleet as subscribed while every message to the other number went
// nowhere — the failure this loop exists to make visible.
const wabas: Array<{ label: string; id?: string; variable: string; line?: string }> = [
  { label: 'webhook subscription', id: config.WHATSAPP_WABA_ID, variable: 'WHATSAPP_WABA_ID' },
  ...(config.WHATSAPP_PHONE_NUMBER_ID_SGMY
    ? [
        {
          label: 'webhook subscription (second line)',
          id: config.WHATSAPP_WABA_ID_SGMY,
          variable: 'WHATSAPP_WABA_ID_SGMY',
          line: config.WHATSAPP_PHONE_NUMBER_ID_SGMY,
        },
      ]
    : []),
];

for (const waba of wabas) {
  if (!waba.id) {
    record('warn', waba.label, `${waba.variable} not set — cannot check`);
    continue;
  }

  try {
    // On the line's own token. Where the two numbers sit under two Meta apps,
    // the main token cannot see the second WABA and the check would report a
    // permissions error as a missing subscription.
    const r = await graphGet(`${waba.id}/subscribed_apps`, waba.line);
    const apps = Array.isArray(r.body?.data) ? r.body.data : [];
    if (r.ok && apps.length) {
      const names = apps
        .map((a: any) => a?.whatsapp_business_api_data?.name ?? a?.whatsapp_business_api_data?.id ?? '?')
        .join(', ');
      record('ok', waba.label, `app subscribed — ${names}`);
    } else if (r.ok) {
      record(
        'fail',
        waba.label,
        'no app is subscribed to this WABA',
        'In Meta → WhatsApp → Configuration, set the callback URL and verify token, ' +
          'then subscribe the app to the "messages" field. Until this exists, nothing reaches the bot.',
      );
    } else {
      record('warn', waba.label, `${r.status} ${r.body?.error?.message ?? ''}`);
    }
  } catch (err) {
    record('warn', waba.label, short(err));
  }
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
