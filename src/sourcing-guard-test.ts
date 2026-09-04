/** Sourcing Hub inbound suppression against an isolated MongoDB. */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'sourcing_guard_bot';
process.env.RESUME_ATS_DB = 'sourcing_guard_ats';
process.env.REDIS_URL = '';

const { connectDb, closeDb } = await import('./db/client.js');
const { atsCollection, ATS_COLLECTIONS } = await import('./ats/client.js');
const {
  isSourcingWhatsAppNumber,
  refreshSourcingContactNumbers,
  sourcingNumbersFrom,
} = await import('./ats/sourcingGuard.js');

await connectDb();
const sourcing = atsCollection(ATS_COLLECTIONS.sourcingClients);

await sourcing.insertMany([
  { type: 'agent', phone: '+91 98765 43210' },
  {
    type: 'client',
    mobileNumbers: ['98765 43211', '+971 50 123 4567'],
  },
  {
    type: 'associate',
    contactPersons: [
      { name: 'Primary', number: '+91-98765-43212' },
      { name: 'Secondary', value: '98765 43213' },
    ],
  },
  {
    type: 'future sourcing type',
    whatsapp: { primary: '+91 98765 43214', alternate: '+91 98765 43215' },
  },
]);

const extracted = sourcingNumbersFrom({
  contacts: [{ number: '+91 90000 00001' }, { value: '90000 00002' }],
  registrationNumber: '123456789012',
});
assert.ok(extracted.includes('919000000001'));
assert.ok(extracted.includes('919000000002'));
assert.ok(!extracted.includes('123456789012'), 'a company registration number is not a phone');

const loaded = await refreshSourcingContactNumbers();
assert.ok(loaded >= 7, 'every stored contact number was loaded');

for (const waId of [
  '919876543210',
  '919876543211',
  '971501234567',
  '919876543212',
  '919876543213',
  '919876543214',
  '919876543215',
]) {
  assert.equal(await isSourcingWhatsAppNumber(waId), true, waId);
}
assert.equal(await isSourcingWhatsAppNumber('919000000099'), false);

await closeDb();
await mongo.stop();

console.log('\n\x1b[32mSourcing contact guard checks passed\x1b[0m\n');
