import assert from 'node:assert/strict';
import {
  attendanceRecordedMessage,
  attendanceSuccessMessage,
  parseAttendanceCommand,
} from './attendance.js';
import { parseWebhook } from './whatsapp/parse.js';
import { locationProblem, readableRefusal } from './attendance-workflow.js';
import { PICKED_LOCATION_MESSAGE } from './attendance-pending.js';
import {
  ATTENDANCE_HELP_MESSAGE,
  ATTENDANCE_RESEND_MESSAGE,
  locationProblemMessage,
  locationRequestMessage,
} from './attendance-pending.js';

let checks = 0;
function check(label: string, assertion: () => void): void {
  try {
    assertion();
  } catch (err) {
    console.error(`\x1b[31mfailed: ${label}\x1b[0m`);
    throw err;
  }
  checks += 1;
}

/* ------------------------------------------------------------------------- *
 *  The written form
 * ------------------------------------------------------------------------- */
check('the requested format', () =>
  assert.deepEqual(parseAttendanceCommand('Asha - check in'), {
    statedName: 'Asha',
    action: 'check_in',
  }),
);
check('name after the keyword', () =>
  assert.deepEqual(parseAttendanceCommand('CHECK OUT: Mohammed Ali'), {
    statedName: 'Mohammed Ali',
    action: 'check_out',
  }),
);
check('a reported time is ignored, not taken as part of the name', () =>
  assert.deepEqual(parseAttendanceCommand('tharun - check in 10.15'), {
    statedName: 'tharun',
    action: 'check_in',
  }),
);
check('no separator', () =>
  assert.deepEqual(parseAttendanceCommand('tharun check in'), {
    statedName: 'tharun',
    action: 'check_in',
  }),
);
check('a colon time after the keyword', () =>
  assert.deepEqual(parseAttendanceCommand('tharun - check out 19:10'), {
    statedName: 'tharun',
    action: 'check_out',
  }),
);

/* ------------------------------------------------------------------------- *
 *  A command with no name
 *
 *  The plainest message a staff member can send, and the one that used to do
 *  nothing: it was not a command, so it fell through to candidate processing
 *  and was silenced there as an internal number. The sender's own phone is the
 *  identity; the CRM resolves it before it looks at any name.
 * ------------------------------------------------------------------------- */
check('bare check in', () =>
  assert.deepEqual(parseAttendanceCommand('check in'), { action: 'check_in' }),
);
check('bare check out', () =>
  assert.deepEqual(parseAttendanceCommand('Check Out'), { action: 'check_out' }),
);
check('bare clock in', () =>
  assert.deepEqual(parseAttendanceCommand('clocked in'), { action: 'check_in' }),
);
check('bare command with the time appended is still nameless', () =>
  assert.deepEqual(parseAttendanceCommand('check in 10.15'), { action: 'check_in' }),
);
check('a leading time is not a name', () =>
  assert.deepEqual(parseAttendanceCommand('10.15 check in'), { action: 'check_in' }),
);
check('punctuation alone is not a name', () =>
  assert.deepEqual(parseAttendanceCommand('check-in -'), { action: 'check_in' }),
);

/* ------------------------------------------------------------------------- *
 *  Still not fuzzy
 *
 *  Accepting a bare command must not turn staff conversation into attendance.
 * ------------------------------------------------------------------------- */
check('two actions are ambiguous', () =>
  assert.equal(parseAttendanceCommand('Asha check in or check out'), undefined),
);
check('"check inside" is not "check in"', () =>
  assert.equal(parseAttendanceCommand('Asha will check inside'), undefined),
);
check('no action at all', () =>
  assert.equal(parseAttendanceCommand('Asha will check the roster'), undefined),
);
check('a greeting is not a command', () =>
  assert.equal(parseAttendanceCommand('good morning'), undefined),
);
check('empty text is not a command', () => assert.equal(parseAttendanceCommand(''), undefined));
check('no text at all is not a command', () =>
  assert.equal(parseAttendanceCommand(undefined), undefined),
);
check('an over-long name is refused rather than truncated', () =>
  assert.equal(parseAttendanceCommand(`${'a'.repeat(160)} - check in`), undefined),
);

/* ------------------------------------------------------------------------- *
 *  What the employee is told
 * ------------------------------------------------------------------------- */
check('plain confirmations', () => {
  assert.equal(attendanceSuccessMessage('check_in'), 'Attendance check in successful.');
  assert.equal(attendanceSuccessMessage('check_out'), 'Attendance check out successful.');
});
check('a confirmation carries the office time and office when the CRM sends them', () =>
  assert.equal(
    attendanceRecordedMessage('check_in', { time: '09:42', site: 'Mount Road' }),
    'Attendance check in successful at 09:42 at Mount Road.',
  ),
);
check('a CRM too old to send them still confirms', () =>
  assert.equal(attendanceRecordedMessage('check_out'), 'Attendance check out successful.'),
);
check('the location request names the employee when they named themselves', () =>
  assert.match(
    locationRequestMessage({ statedName: 'Asha', action: 'check_in' }),
    /^Asha, tap "Send location".*check in/,
  ),
);
check('and reads properly when they did not', () => {
  const message = locationRequestMessage({ action: 'check_out' });
  assert.match(message, /^Tap "Send location".*check out/);
  assert.doesNotMatch(message, /undefined/);
});
check('a validation dump is never shown to a staff member', () => {
  // Reachable while the bot is newer than the CRM it talks to: a bare command
  // is refused with a serialised list of pydantic field errors.
  const dump = '[{"type":"missing","loc":["body","stated_name"],"msg":"Field required"}]';
  assert.doesNotMatch(readableRefusal(dump), /loc|pydantic|missing/);
  assert.match(readableRefusal(dump), /check in/);
  // A sentence written for the employee still comes through as written.
  assert.equal(
    readableRefusal('You are at the wrong location.'),
    'Attendance not recorded: You are at the wrong location.',
  );
});
check('the help and resend messages name the two commands', () => {
  for (const message of [ATTENDANCE_HELP_MESSAGE, ATTENDANCE_RESEND_MESSAGE]) {
    assert.match(message, /check in/);
    assert.match(message, /check out/);
  }
});

/* ------------------------------------------------------------------------- *
 *  Locations that cannot mark attendance
 *
 *  Two shapes arrive without a pin and they are not the same fact, so they
 *  must not be answered with the same sentence. A live location is the usual
 *  cause of both, but only ever the *usual* one — the reply says what the bot
 *  observed and names live location as guidance, never as a diagnosis.
 * ------------------------------------------------------------------------- */
check('a type the Cloud API cannot represent', () =>
  assert.equal(locationProblem({ rawType: 'unsupported' }), 'unsupported_type'),
);
check('a location whose coordinates could not be read', () =>
  // The shape the old `rawType === "unsupported"` check sailed straight past.
  assert.equal(locationProblem({ rawType: 'location' }), 'unreadable'),
);
check('anything else is not a location at all', () => {
  for (const rawType of ['text', 'image', 'document', 'audio', 'sticker', undefined]) {
    assert.equal(locationProblem({ rawType }), 'not_a_location', `${rawType}`);
  }
});

check('an unreadable location is not blamed on the employee', () => {
  const message = locationProblemMessage('unreadable', true);
  assert.match(message, /could not be read/i);
  // It may well have been a live location — but it may equally have been a
  // malformed payload or a bug in our own parser, so this must not assert it.
  assert.doesNotMatch(message, /you shared/i);
  // Still tells them the one thing that always works.
  assert.match(message, /current location/i);
});
check('an unsupported type is described as a type, not as a live location', () => {
  const message = locationProblemMessage('unsupported_type', true);
  assert.match(message, /message type cannot be used/i);
  assert.doesNotMatch(message, /you shared/i);
  assert.match(message, /current location/i);
});
check('both location failures name live location and the place-name trap', () => {
  for (const problem of ['unreadable', 'unsupported_type'] as const) {
    const message = locationProblemMessage(problem, true);
    assert.match(message, /live location/i);
    // The commonest cause of a pin from the wrong side of the city: tapping a
    // shop in WhatsApp's nearby-places list instead of the top option.
    assert.match(message, /shop or place name/i);
  }
});
check('with no command on file, the command is asked for too', () => {
  for (const problem of ['unreadable', 'unsupported_type'] as const) {
    const message = locationProblemMessage(problem, false);
    assert.match(message, /check in/);
    assert.match(message, /check out/);
    // Fixing only the location would fail at the very next step.
    assert.match(message, /current location/i);
  }
});
check('a non-location message falls back to the plain answers', () => {
  assert.match(locationProblemMessage('not_a_location', true), /^Location not received\./);
  assert.equal(locationProblemMessage('not_a_location', false), ATTENDANCE_HELP_MESSAGE);
});

/* ------------------------------------------------------------------------- *
 *  The webhook shapes this workflow reads
 * ------------------------------------------------------------------------- */
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
check('a group message is recognisable as one', () => {
  assert.equal(parsed.messages[0]?.groupId, 'attendance-group');
  assert.equal(parsed.messages[0]?.waId, '919876543210');
});

const shared = parseWebhook({
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: 'phone-1' },
        messages: [{
          from: '917806822702',
          id: 'wamid-2',
          timestamp: '1788748260',
          type: 'location',
          location: { latitude: 13.0571, longitude: 80.2646, name: 'Office' },
        }],
      },
    }],
  }],
});
check('a shared pin carries its coordinates, and what named it', () => {
  assert.equal(shared.messages[0]?.type, 'location');
  // `name` is kept rather than dropped: it is the only thing that separates a
  // place somebody chose from where they are standing. See `parse.ts`.
  assert.deepEqual(shared.messages[0]?.location, {
    latitude: 13.0571,
    longitude: 80.2646,
    name: 'Office',
  });
});

/**
 * The two pin-less deliveries, through the real parser.
 *
 * Classifying hand-built objects only proves the function agrees with itself.
 * What matters is that it agrees with whatever `parseWebhook` produces for
 * these payloads, because that is the only thing the workflow ever sees.
 */
function inbound(message: Record<string, unknown>) {
  const parsed = parseWebhook({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '1344483985421841' },
          messages: [{ from: '919884447455', timestamp: '1788748300', ...message }],
        },
      }],
    }],
  });
  return parsed.messages[0];
}

check('an "unsupported" delivery classifies as an unsupported type', () => {
  const msg = inbound({ id: 'wamid-live-1', type: 'unsupported' });
  assert.equal(msg?.rawType, 'unsupported');
  assert.equal(msg?.location, undefined);
  assert.equal(locationProblem(msg!), 'unsupported_type');
});

check('a location delivery with no coordinates classifies as unreadable', () => {
  // The parser refuses to invent a pin, so the message arrives as `other`
  // holding nothing but its rawType.
  const msg = inbound({ id: 'wamid-live-2', type: 'location', location: { name: 'Live location' } });
  assert.equal(msg?.type, 'other');
  assert.equal(msg?.rawType, 'location');
  assert.equal(msg?.location, undefined);
  assert.equal(locationProblem(msg!), 'unreadable');
});

check('a real pin survives the parser with its coordinates', () => {
  // The case that must never reach `locationProblem` at all: callers check
  // `msg.location` first, and a usable pin is processed whatever its rawType.
  const msg = inbound({
    id: 'wamid-pin-1',
    type: 'location',
    location: { latitude: 13.05976, longitude: 80.25873 },
  });
  assert.equal(msg?.type, 'location');
  assert.deepEqual(msg?.location, { latitude: 13.05976, longitude: 80.25873 });
});

check('a text message mid-command is not a location failure', () => {
  const msg = inbound({ id: 'wamid-text-1', type: 'text', text: { body: 'done' } });
  assert.equal(locationProblem(msg!), 'not_a_location');
});

check('a current-location pin carries coordinates and nothing else', () => {
  const msg = inbound({
    id: 'wamid-pin-current',
    type: 'location',
    location: { latitude: 13.060263, longitude: 80.259109 },
  });
  assert.equal(msg?.location?.name, undefined);
  assert.equal(msg?.location?.address, undefined);
});

check('a pin chosen from the places list keeps what names it', () => {
  // The whole of the signal. Meta sends no "this is really where they are"
  // flag, so a name or an address is the only thing separating a shop somebody
  // tapped - or a point they dragged the map onto - from where they stand.
  const msg = inbound({
    id: 'wamid-pin-place',
    type: 'location',
    location: {
      latitude: 13.060263,
      longitude: 80.259109,
      name: 'Mount Chambers',
      address: '758 Anna Salai, Chennai',
    },
  });
  assert.equal(msg?.location?.name, 'Mount Chambers');
  assert.equal(msg?.location?.address, '758 Anna Salai, Chennai');
  // Still a usable pin as far as the parser goes: attendance refuses it, not
  // parsing, and the coordinates have to survive for the log.
  assert.equal(msg?.location?.latitude, 13.060263);
});

check('the picked-location reply names both taps and keeps the command alive', () => {
  assert.match(PICKED_LOCATION_MESSAGE, /current location/i);
  assert.match(PICKED_LOCATION_MESSAGE, /do not move the map/i);
  // Nothing to retype is the point: being told to start over is how staff gave
  // up on this the first time.
  assert.match(PICKED_LOCATION_MESSAGE, /still waiting/i);
});

console.log(`\n\x1b[32m${checks} attendance checks passed\x1b[0m\n`);
