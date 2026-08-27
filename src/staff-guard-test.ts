/** Staff inbound suppression against an isolated in-memory MongoDB. */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'staff_guard_test';
process.env.REDIS_URL = '';
process.env.RESUME_ATS_DB = '';
process.env.ROLE = 'all';

const { connectDb, closeDb } = await import('./db/client.js');
const {
  ensureIndexes,
  isStaffWhatsAppNumber,
  rememberStaffContact,
  rememberStaffAssignmentReply,
  staffIdsWithNotices,
  staffDirectory,
  staffNotices,
} = await import('./db/models.js');

await connectDb();
await ensureIndexes();

let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  await staffDirectory().deleteMany({});
  await staffNotices().deleteMany({});
  await run();
  passed++;
  console.log(`  \x1b[32mok\x1b[0m  ${name}`);
}

console.log('\n\x1b[1mStaff inbound suppression\x1b[0m');

await check('a CRM staff phone is recognised despite display formatting', async () => {
  await rememberStaffContact({ staffId: 'staff-1', waId: '+91 98765 43210' });
  assert.equal(await isStaffWhatsAppNumber('919876543210'), true);
  assert.equal(await isStaffWhatsAppNumber('919000000000'), false);
});

await check('changing a staff phone stops suppressing the former number', async () => {
  await rememberStaffContact({ staffId: 'staff-1', waId: '+91 98765 43210' });
  await rememberStaffContact({ staffId: 'staff-1', waId: '+971 50 123 4567' });
  assert.equal(await isStaffWhatsAppNumber('919876543210'), false);
  assert.equal(await isStaffWhatsAppNumber('971501234567'), true);
  assert.equal(await staffDirectory().countDocuments(), 1);
});

await check('admin contacts use the same suppression directory', async () => {
  await rememberStaffContact({ staffId: 'admin-1', waId: '919811111111', role: 'admin' });
  assert.equal(await isStaffWhatsAppNumber('919811111111'), true);
});

await check('replying to an older assignment backfills the staff directory', async () => {
  await staffNotices().insertOne({
    noticeKey: 'candidate-1/staff-9/now',
    candidateId: 'candidate-1',
    staffId: 'staff-9',
    assignedAt: 'now',
    claimedAt: new Date(),
    sentAt: new Date(),
    wamid: 'assignment-wamid',
  });

  assert.equal(
    await rememberStaffAssignmentReply('assignment-wamid', '919822222222'),
    true,
  );
  assert.equal(await isStaffWhatsAppNumber('919822222222'), true);
  assert.equal(await rememberStaffAssignmentReply('candidate-wamid', '919833333333'), false);
  assert.deepEqual(await staffIdsWithNotices(), ['staff-9']);
});

await closeDb();
await mongo.stop();

console.log(`\n\x1b[32m${passed} staff guard checks passed\x1b[0m\n`);
