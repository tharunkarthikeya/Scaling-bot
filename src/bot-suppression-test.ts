import assert from 'node:assert/strict';
import { matchesBotSuppression } from './crm/suppression.js';

const directory = ['919884447455', '+91 98849 49735'];

assert.equal(matchesBotSuppression('919884447455', directory), true);
assert.equal(matchesBotSuppression('9884447455', directory), true);
assert.equal(matchesBotSuppression('+91 (98849) 49735', directory), true);
assert.equal(matchesBotSuppression('919000000000', directory), false);

// Receiving phone-number id is intentionally absent from this match: the same
// sender is suppressed regardless of which configured bot line got the webhook.
console.log('bot suppression guard tests passed');
