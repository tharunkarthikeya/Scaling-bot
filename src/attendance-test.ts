import assert from 'node:assert/strict';
import { parseAttendanceCommand } from './attendance.js';
import { parseWebhook } from './whatsapp/parse.js';

assert.deepEqual(parseAttendanceCommand('Asha - check in'), {
  statedName: 'Asha',
  action: 'check_in',
});
assert.deepEqual(parseAttendanceCommand('CHECK OUT: Mohammed Ali'), {
  statedName: 'Mohammed Ali',
  action: 'check_out',
});
assert.equal(parseAttendanceCommand('Asha will check the roster'), undefined);

const parsed = parseWebhook({
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: 'phone-1' },
        contacts: [{ wa_id: '919876543210', profile: { name: 'Asha' } }],
        messages: [{
          from: '919876543210',
          group_id: 'attendance-group',
          id: 'wamid-1',
          timestamp: '1788748200',
          type: 'text',
          text: { body: 'Asha check in' },
        }],
      },
    }],
  }],
});
assert.equal(parsed.messages[0]?.groupId, 'attendance-group');
assert.equal(parsed.messages[0]?.waId, '919876543210');

console.log('\n\x1b[32m3 attendance checks passed\x1b[0m\n');
