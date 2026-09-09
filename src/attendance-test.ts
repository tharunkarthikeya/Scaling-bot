import assert from 'node:assert/strict';
import { attendanceSuccessMessage, parseAttendanceCommand } from './attendance.js';
import { parseWebhook } from './whatsapp/parse.js';

assert.deepEqual(parseAttendanceCommand('Asha - check in'), {
  statedName: 'Asha',
  action: 'check_in',
});
assert.deepEqual(parseAttendanceCommand('CHECK OUT: Mohammed Ali'), {
  statedName: 'Mohammed Ali',
  action: 'check_out',
});
assert.deepEqual(parseAttendanceCommand('tharun - check in 10.15'), {
  statedName: 'tharun',
  action: 'check_in',
});
assert.deepEqual(parseAttendanceCommand('tharun check in'), {
  statedName: 'tharun',
  action: 'check_in',
});
assert.deepEqual(parseAttendanceCommand('tharun - check out 19:10'), {
  statedName: 'tharun',
  action: 'check_out',
});
assert.equal(parseAttendanceCommand('Asha check in or check out'), undefined);
assert.equal(parseAttendanceCommand('Asha will check inside'), undefined);
assert.equal(parseAttendanceCommand('Asha will check the roster'), undefined);
assert.equal(attendanceSuccessMessage('check_in'), 'Attendance check in successful.');
assert.equal(attendanceSuccessMessage('check_out'), 'Attendance check out successful.');

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

console.log('\n\x1b[32m12 attendance checks passed\x1b[0m\n');
