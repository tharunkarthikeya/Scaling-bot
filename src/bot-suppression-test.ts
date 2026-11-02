import assert from 'node:assert/strict';
import { botSuppressionKey, matchesBotSuppression } from './crm/suppression.js';

const directory = ['919884447455', '+91 98849 49735'];

assert.equal(matchesBotSuppression('919884447455', directory), true);
assert.equal(matchesBotSuppression('9884447455', directory), true);
assert.equal(matchesBotSuppression('+91 (98849) 49735', directory), true);
assert.equal(matchesBotSuppression('919000000000', directory), false);

// The CRM serves the directory as last-ten-digit keys (`normalize_phone`). A
// Gulf number has to match in that form, not only an Indian one.
assert.equal(botSuppressionKey('+971 50 123 4567'), '1501234567');
assert.equal(matchesBotSuppression('971501234567', ['1501234567']), true);
assert.equal(matchesBotSuppression('97450123456', ['50123456']), false);
assert.equal(matchesBotSuppression('97450123456', [botSuppressionKey('+974 5012 3456')!]), true);
assert.equal(botSuppressionKey('12345'), undefined);
assert.equal(matchesBotSuppression('12345', ['12345']), false);

// Receiving phone-number id is intentionally absent from this match: the same
// sender is suppressed regardless of which configured bot line got the webhook.
console.log('bot suppression guard tests passed');
