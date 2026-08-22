/**
 * What the PDF page scan costs, old mechanism against new.
 *
 * The webhook, all three job pools and every timer share one event loop (see
 * `index.ts`), so time spent inside `inspectUpload` is time in which no webhook
 * is acknowledged, no reply is sent and no timer fires. That makes the number
 * this prints a latency figure for the whole process, not for one document.
 *
 * The old mechanism was one line:
 *
 *   buffer.toString('latin1').match(/\/Type\s*\/Page[^sA-Za-z]/g)
 *
 * which decodes the entire file into a JavaScript string and then builds an
 * array holding every match as a separate string. Both allocations scale with
 * the file; the second scales with how *page-dense* the file is, which is what
 * makes an uncompressed PDF so much worse than a scanned one. It is reproduced
 * below rather than imported, because the point is the comparison.
 *
 *   npm run bench:inspect
 */

import { inspectUpload } from './ocr/veris.js';

const MB = 1024 * 1024;
const OLD_PATTERN = /\/Type\s*\/Page[^sA-Za-z]/g;

/** The line this change replaced, kept intact so the two can be timed together. */
function oldScan(buffer: Buffer): number | undefined {
  const pageObjects = (buffer.toString('latin1').match(OLD_PATTERN) ?? []).length;
  return pageObjects > 0 ? pageObjects : undefined;
}

function wrap(body: Buffer): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), body, Buffer.from('\n%%EOF', 'latin1')]);
}

/** A scanned document: page objects at the front, compressed image data behind. */
function scanned(mb: number): Buffer {
  const pages = Buffer.from('/Type /Page  /Type /Page  /Type /Page \n', 'latin1');
  const streams = Buffer.alloc(mb * MB);
  // Not random, but not a repeated byte either — something the scanner has to
  // walk rather than something a memchr trivially skips.
  for (let i = 0; i < streams.length; i += 1) streams[i] = (i * 31 + (i >> 7)) & 0xff;
  return wrap(Buffer.concat([pages, streams]));
}

/** The pathological shape: an uncompressed PDF that is almost all page markers. */
function dense(mb: number): Buffer {
  return wrap(Buffer.alloc(mb * MB).fill(Buffer.from('/Type /Page ', 'latin1')));
}

/** A PDF with no countable page objects at all — the full-file walk, worst case. */
function opaque(mb: number): Buffer {
  return wrap(Buffer.alloc(mb * MB, 'x'));
}

function measure(run: () => number | undefined): { ms: number; heapMb: number; pages?: number } {
  global.gc?.();
  const before = process.memoryUsage();
  const started = process.hrtime.bigint();
  const pages = run();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const after = process.memoryUsage();
  const heapMb =
    (after.heapUsed - before.heapUsed + (after.external - before.external)) / MB;
  return { ms, heapMb: Math.max(0, heapMb), ...(pages === undefined ? {} : { pages }) };
}

const CASES: Array<{ label: string; buffer: Buffer }> = [
  { label: 'scanned 5 MB', buffer: scanned(5) },
  { label: 'scanned 25 MB', buffer: scanned(25) },
  { label: 'opaque 25 MB', buffer: opaque(25) },
  { label: 'dense 5 MB', buffer: dense(5) },
  { label: 'dense 25 MB', buffer: dense(25) },
  { label: 'dense 50 MB', buffer: dense(50) },
];

console.log(`node ${process.version}\n`);
console.log(
  `${'case'.padEnd(15)}${'old ms'.padStart(10)}${'new ms'.padStart(10)}` +
    `${'faster'.padStart(10)}${'old heap'.padStart(11)}${'new heap'.padStart(11)}` +
    `${'old pages'.padStart(11)}${'new pages'.padStart(11)}`,
);
console.log('-'.repeat(89));

for (const { label, buffer } of CASES) {
  const old = measure(() => oldScan(buffer));
  const now = measure(() => inspectUpload(buffer, 'application/pdf').pages);

  console.log(
    label.padEnd(15) +
      old.ms.toFixed(1).padStart(10) +
      now.ms.toFixed(1).padStart(10) +
      `${(old.ms / Math.max(now.ms, 0.001)).toFixed(0)}x`.padStart(10) +
      `${old.heapMb.toFixed(0)} MB`.padStart(11) +
      `${now.heapMb.toFixed(0)} MB`.padStart(11) +
      String(old.pages ?? '—').padStart(11) +
      String(now.pages ?? '—').padStart(11),
  );
}

console.log(
  '\n`new pages` saturates at 2 by design — the count is only ever compared\n' +
    'against TUNABLES.passportMinPdfPages, so a third match cannot change a verdict.\n' +
    'Run with --expose-gc for stable heap figures.',
);
