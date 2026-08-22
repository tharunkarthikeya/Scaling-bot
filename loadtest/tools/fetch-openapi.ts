/**
 * Fetches the Veris OpenAPI document once and saves it for offline analysis.
 *
 * One live GET, no extraction work, no job created. An API description is a
 * schema, not data — it carries no secrets and no personal information — so
 * unlike the probe's shape-summariser this keeps it verbatim, because the field
 * names are precisely what the contract question is asking about.
 *
 *   LOADTEST_ALLOW_HOST=veriis.adiragroups.com npx tsx loadtest/tools/fetch-openapi.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { installFetchGuard } from '../rig/guard.js';

const HOST = process.env.LOADTEST_ALLOW_HOST ?? '';
if (!HOST) {
  console.error('Refusing to run: set LOADTEST_ALLOW_HOST to the single host this may reach.');
  process.exit(1);
}

installFetchGuard({ onOutbound: () => undefined });

const { config } = await import('../../src/config.js');
const BASE = config.VERIS_OCR_BASE_URL.replace(/\/$/, '');

const res = await fetch(`${BASE}/openapi.json`, {
  headers: { 'X-API-Key': config.VERIS_OCR_API_KEY },
  signal: AbortSignal.timeout(30_000),
});

if (!res.ok) {
  console.error(`openapi.json -> ${res.status}`);
  process.exit(1);
}

const doc = await res.json();
const out = path.resolve('loadtest/tools/veris-openapi.json');
fs.writeFileSync(out, JSON.stringify(doc, null, 2));

const paths = Object.keys((doc as { paths: Record<string, unknown> }).paths ?? {});
console.log(`saved ${out}`);
console.log(`paths: ${paths.length}`);
console.log(`schemas: ${Object.keys((doc as any).components?.schemas ?? {}).length}`);
console.log('1 live request. No job submitted.');
