/**
 * One real call to the live Veris service, to size a real-OCR load test.
 *
 * Everything the load rig knows about OCR timing so far came from a mock set to
 * 1.5–4s. That number was invented. Real extraction time is what decides whether
 * a 100-user run is four minutes or an hour, and whether OCR concurrency 3 is
 * merely a bottleneck or a wall — so it gets measured before anything is run at
 * scale against somebody's live service.
 *
 * Sends exactly one document per extractor named on the command line, and
 * nothing else. The API key is read from the environment and never printed.
 *
 *   npx tsx loadtest/tools/veris-probe.ts            health + one passport
 *   npx tsx loadtest/tools/veris-probe.ts all        one of each extractor
 */

import { config } from '../../src/config.js';
import { SAMPLE_PASSPORT_PDF, SAMPLE_AADHAAR_PDF, SAMPLE_RESUME_PDF } from '../../src/testing/fixtures.js';

const BASE = config.VERIS_OCR_BASE_URL.replace(/\/$/, '');

const ROUTES: Record<string, { path: string; field: string; body: () => Buffer }> = {
  passport: { path: '/v1/passport/extract', field: 'image', body: () => SAMPLE_PASSPORT_PDF() },
  resume: { path: '/v1/resume/extract', field: 'image', body: () => SAMPLE_RESUME_PDF('probe') },
  aadhaar: { path: '/v1/aadhaar/extract', field: 'image', body: () => SAMPLE_AADHAAR_PDF() },
};

function host(): string {
  try {
    return new URL(BASE).hostname;
  } catch {
    return '(unparseable)';
  }
}

async function health(): Promise<void> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/health`, {
      headers: { 'X-API-Key': config.VERIS_OCR_API_KEY },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    console.log(`health   ${res.status}  ${Date.now() - started}ms  ${text.slice(0, 120)}`);
  } catch (err) {
    console.log(`health   FAILED after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function probe(name: string): Promise<void> {
  const route = ROUTES[name]!;
  const buffer = route.body();

  const form = new FormData();
  form.append(route.field, new Blob([buffer], { type: 'application/pdf' }), `${name}.pdf`);

  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${route.path}`, {
      method: 'POST',
      headers: { 'X-API-Key': config.VERIS_OCR_API_KEY },
      body: form,
      signal: AbortSignal.timeout(config.VERIS_OCR_TIMEOUT_MS),
    });

    const elapsed = Date.now() - started;
    const text = await res.text();

    if (!res.ok) {
      console.log(`${name.padEnd(9)} ${res.status}  ${elapsed}ms  ${text.slice(0, 200)}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log(`${name.padEnd(9)} 200  ${elapsed}ms  body did not parse as JSON (${text.length} bytes)`);
      return;
    }

    const keys = Object.keys(parsed as Record<string, unknown>);
    console.log(
      `${name.padEnd(9)} 200  ${String(elapsed).padStart(6)}ms  ${(buffer.byteLength / 1024).toFixed(1)}KB sent  ` +
        `keys: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ' …' : ''}`,
    );
  } catch (err) {
    console.log(
      `${name.padEnd(9)} FAILED after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const which = process.argv[2] === 'all' ? Object.keys(ROUTES) : ['passport'];

console.log(`\nveris probe -> ${host()}  (timeout ${config.VERIS_OCR_TIMEOUT_MS}ms)`);
console.log(`sending ${which.length} document${which.length === 1 ? '' : 's'}, one per extractor\n`);

await health();
for (const name of which) await probe(name);
console.log('');
