/**
 * Offline smoke test for the pieces that don't need Mongo, Redis, or the network.
 * Run with: npx tsx src/smoke.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from './config.js';
import { verifySignature } from './whatsapp/signature.js';
import { parseWebhook } from './whatsapp/parse.js';
import { chunkText } from './whatsapp/client.js';
import {
  attributeInboundDocument,
  initialSlots,
  isChecklistComplete,
  nextDocumentToAsk,
  renderState,
} from './conversation/checklist.js';
import { buildSystemPrompt } from './conversation/rules.js';
import type { CandidateDoc } from './db/models.js';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('\nsignature');
check('accepts a correctly signed body', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(body).digest('hex');
  assert.equal(verifySignature(body, sig), true);
});
check('rejects a tampered body', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(body).digest('hex');
  assert.equal(verifySignature(Buffer.from('{"hello":"there"}'), sig), false);
});
check('rejects a missing signature', () => {
  assert.equal(verifySignature(Buffer.from('{}'), undefined), false);
});

console.log('\nwebhook parsing');
const sampleText = {
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ wa_id: '919000000000', profile: { name: 'Asha' } }],
            messages: [
              {
                from: '919000000000',
                id: 'wamid.TEXT1',
                timestamp: '1750000000',
                type: 'text',
                text: { body: 'hi, I want to apply' },
              },
            ],
          },
        },
      ],
    },
  ],
};
check('parses a text message', () => {
  const parsed = parseWebhook(sampleText);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0]!.type, 'text');
  assert.equal(parsed.messages[0]!.text, 'hi, I want to apply');
  assert.equal(parsed.messages[0]!.profileName, 'Asha');
});

const sampleDoc = {
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messages: [
              {
                from: '919000000000',
                id: 'wamid.DOC1',
                timestamp: '1750000100',
                type: 'document',
                document: {
                  id: 'MEDIA123',
                  mime_type: 'application/pdf',
                  filename: 'Asha_Resume.pdf',
                  caption: 'my cv',
                },
              },
            ],
            statuses: [
              {
                id: 'wamid.OUT1',
                recipient_id: '919000000000',
                status: 'failed',
                timestamp: '1750000200',
                errors: [{ title: 'Re-engagement message' }],
              },
            ],
          },
        },
      ],
    },
  ],
};
check('parses a document message and a failed status', () => {
  const parsed = parseWebhook(sampleDoc);
  assert.equal(parsed.messages[0]!.type, 'document');
  assert.equal(parsed.messages[0]!.media?.filename, 'Asha_Resume.pdf');
  assert.equal(parsed.statuses[0]!.status, 'failed');
});
check('ignores a non-whatsapp payload', () => {
  assert.equal(parseWebhook({ object: 'page' }).messages.length, 0);
});

console.log('\ntext chunking');
check('leaves a short message alone', () => {
  assert.deepEqual(chunkText('hello'), ['hello']);
});
check('splits a long message under the limit', () => {
  const long = ('word '.repeat(2000)).trim();
  const chunks = chunkText(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
});

console.log('\nchecklist');
function makeCandidate(): CandidateDoc {
  return {
    waId: '919000000000',
    phone: '919000000000',
    stage: 'collecting_documents',
    profile: {},
    documents: initialSlots(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

check('asks for required documents before optional ones', () => {
  const c = makeCandidate();
  assert.equal(nextDocumentToAsk(c)?.id, 'cv');
});
check('advances once a slot is resolved', () => {
  const c = makeCandidate();
  c.documents.cv!.status = 'ocr_queued';
  assert.equal(nextDocumentToAsk(c)?.id, 'passport');
});
check('stops chasing after the ask cap', () => {
  const c = makeCandidate();
  c.documents.cv!.askedCount = 2;
  assert.equal(nextDocumentToAsk(c)?.id, 'passport');
});
check('is complete when every required slot is resolved', () => {
  const c = makeCandidate();
  assert.equal(isChecklistComplete(c), false);
  for (const id of ['cv', 'passport', 'photograph']) c.documents[id]!.status = 'ocr_done';
  assert.equal(isChecklistComplete(c), true);
});
check('unavailable counts as resolved', () => {
  const c = makeCandidate();
  for (const id of ['cv', 'passport']) c.documents[id]!.status = 'ocr_done';
  c.documents.photograph!.status = 'unavailable';
  assert.equal(isChecklistComplete(c), true);
});
check('files an inbound file by caption over the awaited slot', () => {
  const c = makeCandidate();
  c.awaitingDocument = 'cv';
  assert.equal(attributeInboundDocument(c, { caption: 'here is my passport' }), 'passport');
});
check('falls back to the awaited slot with no hint', () => {
  const c = makeCandidate();
  c.awaitingDocument = 'photograph';
  assert.equal(attributeInboundDocument(c, {}), 'photograph');
});
check('state block names the outstanding document', () => {
  const c = makeCandidate();
  const state = renderState(c);
  assert.ok(state.includes('OUTSTANDING: cv'));
  assert.ok(state.includes('<state>') && state.includes('</state>'));
});

console.log('\nprompt');
check('system prompt is deterministic (cacheable)', () => {
  assert.equal(buildSystemPrompt(), buildSystemPrompt());
  assert.ok(buildSystemPrompt().length > 500);
});

console.log(`\n${passed} checks passed\n`);
