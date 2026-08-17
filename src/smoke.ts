/**
 * Offline checks for the pieces that need no Mongo, Redis, or network.
 *
 * Most of what this covers is the protocol's own rules expressed as assertions:
 * that a question already answered is never asked again, that a GCC candidate is
 * never asked for identity documents, that what a candidate wants is never
 * written over what they do, and that a spelling difference in a name is not
 * treated as a different person.
 *
 * Run with: npm run smoke
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from './config.js';
import { verifySignature } from './whatsapp/signature.js';
import { parseWebhook } from './whatsapp/parse.js';
import { chunkText } from './whatsapp/client.js';
import { attributeInboundDocument, initialSlots } from './conversation/checklist.js';
import {
  inferTradePacks,
  inEuropeRussiaBranch,
  nextStep,
  stepById,
  TRADE_CHOICES,
} from './conversation/flow.js';
import { validateCopy } from './conversation/validate.js';
import { interpret, resolveOfferedIds } from './conversation/interpret.js';
import {
  ageFrom,
  buildProfileWrite,
  compareIdentity,
  namesMatch,
  passportExpiryFlag,
} from './conversation/profile.js';
import {
  experienceBand,
  extractFromCv,
  normaliseDate,
  normaliseEducation,
  normaliseMonthYear,
  parseYears,
  splitAddress,
} from './conversation/cv.js';
import { acceptedChoices } from './conversation/render.js';
import { looksLikeApplicationId, normaliseApplicationId } from './conversation/engine.js';
import { REMINDER_CHOICES, RESUME_CHOICES } from './conversation/copy.js';
import { FAQ, violatesGuardrails } from './conversation/faq.js';
import { inspectUpload } from './ocr/veris.js';
import type { CandidateDoc, OcrField } from './db/models.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  \x1b[32mok\x1b[0m  ${name}`);
    })
    .catch((err) => {
      failures.push(name);
      console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
      console.log(`       ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    });
}

function candidate(overrides: Partial<CandidateDoc> = {}): CandidateDoc {
  return {
    waId: '919000000000',
    phone: '919000000000',
    stage: 'BASIC_DETAILS_PENDING',
    status: 'profile_incomplete',
    profile: { lookingForOverseasJob: true },
    fieldMeta: {},
    history: [],
    documents: initialSlots(),
    language: 'en',
    // This helper stands for a candidate already partway through registration,
    // so §3 is behind them. Tests that care about the language question itself
    // override this.
    languageChosen: true,
    consent: { given: true, at: new Date(), source: 'whatsapp_chat' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */

console.log('\nsignature');

await check('accepts a correctly signed body', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig =
    'sha256=' + crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(body).digest('hex');
  assert.equal(verifySignature(body, sig), true);
});

await check('rejects a tampered body', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig =
    'sha256=' + crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(body).digest('hex');
  assert.equal(verifySignature(Buffer.from('{"hello":"there"}'), sig), false);
});

await check('rejects a missing signature', () => {
  assert.equal(verifySignature(Buffer.from('{}'), undefined), false);
});

/* ------------------------------------------------------------------ */

console.log('\nwebhook parsing');

const envelope = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ wa_id: '919000000000', profile: { name: 'Asha' } }],
            messages: [message],
            ...extra,
          },
        },
      ],
    },
  ],
});

await check('parses a text message', () => {
  const parsed = parseWebhook(
    envelope({
      from: '919000000000',
      id: 'wamid.TEXT1',
      timestamp: '1750000000',
      type: 'text',
      text: { body: 'hi, I want to apply' },
    }),
  );
  assert.equal(parsed.messages[0]!.type, 'text');
  assert.equal(parsed.messages[0]!.text, 'hi, I want to apply');
  assert.equal(parsed.messages[0]!.profileName, 'Asha');
});

await check('a tapped button carries its option id, not just its label', () => {
  const parsed = parseWebhook(
    envelope({
      from: '919000000000',
      id: 'wamid.BTN1',
      timestamp: '1750000000',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'ஆம்' } },
    }),
  );
  // The id is language-independent; the Tamil label is only what they saw.
  assert.equal(parsed.messages[0]!.replyId, 'yes');
  assert.equal(parsed.messages[0]!.text, 'ஆம்');
});

await check('a tapped list row carries its option id', () => {
  const parsed = parseWebhook(
    envelope({
      from: '919000000000',
      id: 'wamid.LIST1',
      timestamp: '1750000000',
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'iti', title: 'ITI' } },
    }),
  );
  assert.equal(parsed.messages[0]!.replyId, 'iti');
});

await check('parses a document message and a failed status', () => {
  const parsed = parseWebhook(
    envelope(
      {
        from: '919000000000',
        id: 'wamid.DOC1',
        timestamp: '1750000100',
        type: 'document',
        document: { id: 'MEDIA123', mime_type: 'application/pdf', filename: 'CV.pdf', caption: 'my cv' },
      },
      {
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
    ),
  );
  assert.equal(parsed.messages[0]!.type, 'document');
  assert.equal(parsed.statuses[0]!.status, 'failed');
});

await check('ignores a non-whatsapp payload', () => {
  assert.equal(parseWebhook({ object: 'page' }).messages.length, 0);
});

/* ------------------------------------------------------------------ */

console.log('\ncopy');

await check('every label fits WhatsApp’s limits in all three languages', () => {
  validateCopy();
});

await check('text chunking never truncates', () => {
  const long = 'word '.repeat(2000).trim();
  const chunks = chunkText(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
});

/* ------------------------------------------------------------------ */

console.log('\nflow (§1 never ask twice, §13 branch gating)');

await check('starts at the three-option opening menu (§2)', () => {
  const c = candidate({ profile: {}, consent: undefined, language: undefined });
  const step = nextStep(c);
  assert.equal(step?.id, 'entry');
  assert.deepEqual(
    step!.choices!.map((o) => o.id),
    ['b2b', 'track', 'apply'],
  );
});

await check('the opening menu offers no duplicate ids to the interpreter', () => {
  const step = stepById('entry')!;
  const ids = [...(step.choices ?? []), ...(step.hiddenChoices ?? [])].map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
});

await check('the confirmation offers its buttons to the interpreter too (§18)', () => {
  // Declared only inside the renderer, these were sent to the candidate but
  // never offered to the interpreter — so a tapped "Yes, correct" matched
  // nothing and registration could not complete.
  const c = candidate({ currentStep: 'confirm' });
  assert.deepEqual(
    acceptedChoices(stepById('confirm')!, c).map((o) => o.id),
    ['correct', 'edit', 'staff'],
  );
});

await check('asks the language question even when it guessed one (§3)', () => {
  // The engine guesses a language from the first message's script so the
  // welcome is readable. That guess must not answer §3 — it used to, which
  // silently locked every Latin-script candidate to English.
  const guessed = candidate({
    profile: { lookingForOverseasJob: true },
    consent: undefined,
    language: 'en',
    languageChosen: undefined,
  });
  assert.equal(nextStep(guessed)?.id, 'language');

  const chosen = candidate({
    profile: { lookingForOverseasJob: true },
    consent: undefined,
    language: 'en',
    languageChosen: true,
  });
  assert.equal(nextStep(chosen)?.id, 'consent');
});

await check('asks for consent before anything personal (§4)', () => {
  const c = candidate({ profile: { lookingForOverseasJob: true }, consent: undefined });
  assert.equal(nextStep(c)?.id, 'consent');
});

await check('skips a question the CV already answered (§1, §5)', () => {
  const withoutCv = candidate();
  withoutCv.documents.cv!.status = 'unavailable';
  assert.equal(nextStep(withoutCv)?.id, 'full_name');

  const withName = candidate({ profile: { lookingForOverseasJob: true, fullName: 'Asha Kumari' } });
  withName.documents.cv!.status = 'ocr_done';
  assert.notEqual(nextStep(withName)?.id, 'full_name');
});

await check('asks for a trade course only for ITI, diploma or graduate (§6)', () => {
  const tenth = candidate({ profile: { lookingForOverseasJob: true, education: 'class_10' } });
  assert.equal(stepById('education_course')!.when!(tenth), false);

  const iti = candidate({ profile: { lookingForOverseasJob: true, education: 'iti' } });
  assert.equal(stepById('education_course')!.when!(iti), true);
});

await check('a GCC candidate is never asked for identity documents (§13)', () => {
  const gcc = candidate({ profile: { lookingForOverseasJob: true, countryPreference: 'gcc' } });
  assert.equal(inEuropeRussiaBranch(gcc), false);
  assert.equal(stepById('europe_docs')!.when!(gcc), false);
  assert.equal(stepById('aadhaar_upload')!.when!(gcc), false);
});

await check('choosing Europe opens the document branch (§13)', () => {
  const europe = candidate({ profile: { lookingForOverseasJob: true, countryPreference: 'europe' } });
  assert.equal(inEuropeRussiaBranch(europe), true);
  assert.equal(stepById('europe_docs')!.when!(europe), true);
});

await check('naming Romania opens the branch even under "select countries" (§13)', () => {
  const named = candidate({
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'select',
      selectedCountries: ['Romania', 'Serbia'],
    },
  });
  assert.equal(inEuropeRussiaBranch(named), true);
});

await check('"any country" does not open the document branch', () => {
  const any = candidate({ profile: { lookingForOverseasJob: true, countryPreference: 'any' } });
  assert.equal(inEuropeRussiaBranch(any), false);
});

await check('only the documents the candidate says they have are requested (§13)', () => {
  const some = candidate({
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'europe',
      documentAvailability: 'some',
      availableDocuments: ['passport'],
    },
  });
  assert.equal(stepById('passport_upload')!.when!(some), true);
  assert.equal(stepById('aadhaar_upload')!.when!(some), false);
  assert.equal(stepById('pan_upload')!.when!(some), false);
});

await check('"upload later" stops the bot asking for files at all (§13)', () => {
  const later = candidate({
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'europe',
      documentAvailability: 'later',
    },
  });
  assert.equal(stepById('passport_upload')!.when!(later), false);
});

await check('a strict country preference is stored separately from the countries (§10)', () => {
  const strict = candidate({
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'select',
      selectedCountries: ['Romania'],
      countryStrictness: 'strict',
    },
  });
  // §25 relies on this pair: the list, and whether it may be departed from.
  assert.equal(strict.profile.countryStrictness, 'strict');
  assert.deepEqual(strict.profile.selectedCountries, ['Romania']);
});

/* ------------------------------------------------------------------ */

console.log('\ntrade questions (§8)');

await check('a welder gets welding questions and no others', () => {
  const c = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'fabrication_welding' },
    fieldMeta: { primaryTrade: { source: 'chat', raw: 'I am a TIG welder', at: new Date() } },
  });
  assert.deepEqual(inferTradePacks(c), ['welder']);
});

await check('a fabricator gets fabrication questions', () => {
  const c = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'fabrication_welding' },
    fieldMeta: { primaryTrade: { source: 'chat', raw: 'structural fabrication', at: new Date() } },
  });
  assert.deepEqual(inferTradePacks(c), ['fabricator']);
});

await check('tapping a category never loads a pack by keyword (§8)', () => {
  // "Fabrication / Welding" contains the keywords of both packs beneath it, so
  // keyword matching used to select welder AND fabricator and skip the tie-break
  // question entirely — three trade questions instead of one.
  const tapped = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'fabrication_welding', tradeFromList: true },
  });
  assert.equal(inferTradePacks(tapped), undefined, 'must not infer from a tapped category');
  assert.equal(stepById('trade_disambiguation')!.when!(tapped), true, 'must ask which one');

  // Their own words still decide it — a typed "welder" skips the question.
  const typed = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      currentOccupation: 'TIG welder',
    },
  });
  assert.deepEqual(inferTradePacks(typed), ['welder']);
  assert.equal(stepById('trade_disambiguation')!.when!(typed), false);
});

await check('only the explicit choice loads a pack (§8)', () => {
  const chosen = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'fabrication_welding', tradeFromList: true },
  });
  const step = stepById('trade_disambiguation')!;
  assert.deepEqual(step.apply!({ ids: ['welding'] }, chosen).tradePacks, ['welder']);
  assert.deepEqual(step.apply!({ ids: ['fabrication'] }, chosen).tradePacks, ['fabricator']);
  assert.deepEqual(step.apply!({ ids: ['both'] }, chosen).tradePacks, ['welder', 'fabricator']);
});

await check('a typed answer is stored, not discarded and re-asked (§7)', () => {
  const step = stepById('total_experience')!;
  const c = candidate();

  // Tapped option — unchanged.
  assert.equal(step.apply!({ ids: ['5_10'] }, c).totalExperienceBand, '5_10');

  // Typed in words. A valid answer the flow used to drop on the floor, leaving
  // the step unsatisfied so the same question came back.
  const typed = step.apply!({ value: '6 years', raw: '6 years' }, c);
  assert.equal(typed.totalExperienceYears, 6);
  assert.equal(typed.totalExperienceBand, '5_10');

  const months = step.apply!({ value: '18 months', raw: '18 months' }, c);
  assert.equal(months.totalExperienceBand, 'below_2');

  // Genuinely unusable input still leaves the step unsatisfied, so it re-asks.
  assert.equal(step.apply!({ value: 'lots', raw: 'lots' }, c).totalExperienceBand, undefined);
});

await check('an ambiguous answer asks one question rather than guessing', () => {
  const c = candidate({ profile: { lookingForOverseasJob: true, primaryTrade: 'fabrication_welding' } });
  assert.equal(inferTradePacks(c), undefined);
  assert.equal(stepById('trade_disambiguation')!.when!(c), true);
});

await check('a hospitality candidate gets no trade questions at all', () => {
  const c = candidate({ profile: { lookingForOverseasJob: true, primaryTrade: 'hospitality' } });
  assert.deepEqual(inferTradePacks(c), []);
});

await check('a driver is never asked about welding', () => {
  const c = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'driver_operator', tradePacks: ['driver'] },
  });
  assert.equal(stepById('trade:welder:welding_process')!.when!(c), false);
  assert.equal(stepById('trade:driver:driver_vehicles')!.when!(c), true);
});

/* ------------------------------------------------------------------ */

console.log('\ninterpreting replies (no network)');

const nameStep = stepById('full_name')!;
const educationStep = stepById('education')!;

await check('a tapped option resolves without calling the model', async () => {
  const result = await interpret({
    step: educationStep,
    choices: acceptedChoices(educationStep, candidate()),
    text: 'ITI',
    replyId: 'iti',
  });
  assert.equal(result.kind, 'matched');
  assert.deepEqual(result.kind === 'matched' && result.ids, ['iti']);
});

await check('typing the option in Tamil resolves without the model', async () => {
  const result = await interpret({
    step: educationStep,
    choices: acceptedChoices(educationStep, candidate()),
    text: 'டிப்ளோமா',
  });
  assert.equal(result.kind, 'matched');
  assert.deepEqual(result.kind === 'matched' && result.ids, ['diploma']);
});

await check('a number picks the option at that position', async () => {
  const result = await interpret({
    step: educationStep,
    choices: acceptedChoices(educationStep, candidate()),
    text: '4',
  });
  assert.equal(result.kind, 'matched');
  assert.deepEqual(result.kind === 'matched' && result.ids, ['iti']);
});

await check('an answer given as a position is recovered, not discarded', () => {
  // The model classifies correctly and then answers with the option's place in
  // the list ("6") instead of its id ("hospitality"). Discarding that turned
  // every correct free-text answer to a choice question into "unclear".
  assert.deepEqual(resolveOfferedIds(['hospitality'], TRADE_CHOICES), ['hospitality']);
  assert.deepEqual(resolveOfferedIds(['6'], TRADE_CHOICES), ['hospitality']);
  assert.deepEqual(resolveOfferedIds([6], TRADE_CHOICES), ['hospitality']);
  assert.deepEqual(resolveOfferedIds(['1'], TRADE_CHOICES), ['fabrication_welding']);
});

await check('a position outside the offered list is still refused', () => {
  // Recovery resolves against the offered list only — it cannot widen what the
  // model is allowed to choose.
  assert.deepEqual(resolveOfferedIds(['0'], TRADE_CHOICES), []);
  assert.deepEqual(resolveOfferedIds([String(TRADE_CHOICES.length + 1)], TRADE_CHOICES), []);
  assert.deepEqual(resolveOfferedIds(['doctor'], TRADE_CHOICES), []);
  assert.deepEqual(resolveOfferedIds(['1.5'], TRADE_CHOICES), []);
  assert.deepEqual(resolveOfferedIds(undefined, TRADE_CHOICES), []);
});

await check('DELETE is recognised anywhere, in any case', async () => {
  const result = await interpret({ step: nameStep, choices: [], text: 'delete' });
  assert.equal(result.kind, 'command');
  assert.equal(result.kind === 'command' && result.command, 'delete');
});

await check('asking for a person is recognised without the model (§24)', async () => {
  const result = await interpret({ step: nameStep, choices: [], text: 'I want to talk to staff' });
  assert.equal(result.kind, 'staff');
});

/* ------------------------------------------------------------------ */

console.log('\nprofile rules (§9 separation, §27 provenance)');

await check('a value records where it came from and the candidate’s own words (§27)', () => {
  const c = candidate({ profile: { lookingForOverseasJob: true } });
  const write = buildProfileWrite(c, { primaryTrade: 'fabrication_welding' }, {
    source: 'chat',
    raw: 'naan welder',
  });
  assert.equal(write.set['profile.primaryTrade'], 'fabrication_welding');
  assert.equal((write.set['fieldMeta.primaryTrade'] as { raw: string }).raw, 'naan welder');
  assert.equal((write.set['fieldMeta.primaryTrade'] as { source: string }).source, 'chat');
});

await check('extracted data is never marked verified (§27)', () => {
  const c = candidate({ profile: {} });
  const write = buildProfileWrite(c, { fullName: 'Asha Kumari' }, { source: 'cv' });
  assert.equal((write.set['fieldMeta.fullName'] as { verified: boolean }).verified, false);
});

await check('a CV never overwrites what the candidate typed (§27)', () => {
  const c = candidate({
    profile: { fullName: 'Asha Kumari' },
    fieldMeta: { fullName: { source: 'chat', at: new Date() } },
  });
  const write = buildProfileWrite(c, { fullName: 'A. KUMARI' }, { source: 'cv' });
  assert.equal(Object.keys(write.set).length, 0);
});

await check('a placeholder is never written into a field', () => {
  const c = candidate({ profile: {} });
  const write = buildProfileWrite(c, { fullName: 'not provided' }, { source: 'chat' });
  assert.equal(Object.keys(write.set).length, 0);
});

await check('what they want is stored apart from what they do (§9)', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      currentOccupation: 'TIG Welder',
      desiredOccupation: 'Driver',
    },
  });
  // §9 forbids these ever collapsing into one field.
  assert.equal(c.profile.currentOccupation, 'TIG Welder');
  assert.equal(c.profile.desiredOccupation, 'Driver');
});

await check('age is derived from date of birth, never asked (§6)', () => {
  assert.equal(ageFrom('1995-08-15', new Date('2026-08-16')), 31);
  assert.equal(ageFrom('1995-08-17', new Date('2026-08-16')), 30);
  assert.equal(ageFrom(undefined), undefined);
});

await check('a passport expiring inside a year is flagged (§12)', () => {
  const soon = passportExpiryFlag({ passportExpiry: '03/2027' }, new Date('2026-08-16'));
  assert.equal(soon?.expiringSoon, true);
  assert.equal(soon?.expired, false);

  const far = passportExpiryFlag({ passportExpiry: '03/2031' }, new Date('2026-08-16'));
  assert.equal(far?.expiringSoon, false);

  const gone = passportExpiryFlag({ passportExpiry: '03/2020' }, new Date('2026-08-16'));
  assert.equal(gone?.expired, true);

  // No date is not the same as "not expiring soon", and must not read as one.
  assert.equal(passportExpiryFlag({}), undefined);
});

/* ------------------------------------------------------------------ */

console.log('\nidentity comparison (§17)');

await check('a spelling difference is the same person', () => {
  assert.equal(namesMatch('MOHAMED YOOSUF', 'MOHAMMED YOOSUF'), true);
  assert.equal(namesMatch('Asha Kumari', 'ASHA KUMARI'), true);
  assert.equal(namesMatch('Ramesh Kumar', 'Ramesh Kumaar'), true);
});

await check('a middle name on one document only is not a mismatch', () => {
  assert.equal(namesMatch('Asha Devi Kumari', 'Asha Kumari'), true);
});

await check('genuinely different names do not match', () => {
  assert.equal(namesMatch('Asha Kumari', 'Priya Sharma'), false);
});

await check('a real difference is reported, not acted on', () => {
  const result = compareIdentity({
    cv: { name: 'MOHAMED YOOSUF', dateOfBirth: '1995-08-15' },
    passport: { name: 'MOHAMMED YOOSUF', dateOfBirth: '1995-08-15' },
  });
  assert.equal(result.consistent, true);

  const mismatch = compareIdentity({
    cv: { name: 'Asha Kumari', dateOfBirth: '1995-08-15' },
    passport: { name: 'Asha Kumari', dateOfBirth: '1991-02-03' },
  });
  assert.equal(mismatch.consistent, false);
  assert.ok(mismatch.differences[0]!.includes('date of birth'));
});

/* ------------------------------------------------------------------ */

console.log('\nCV extraction (§5)');

await check('reads Indian date order correctly', () => {
  assert.equal(normaliseDate('15/08/1995'), '1995-08-15');
  // Both halves could be a month; DD/MM is what these CVs mean.
  assert.equal(normaliseDate('03/04/1990'), '1990-04-03');
  assert.equal(normaliseDate('15-Aug-1995'), '1995-08-15');
  assert.equal(normaliseDate('1995-08-15'), '1995-08-15');
  assert.equal(normaliseDate('nonsense'), undefined);
});

await check('normalises a passport expiry to MM/YYYY (§12)', () => {
  assert.equal(normaliseMonthYear('03/2031'), '03/2031');
  assert.equal(normaliseMonthYear('3/2031'), '03/2031');
});

await check('reads experience written in words', () => {
  assert.equal(parseYears('6 years 3 months'), 6.25);
  assert.equal(parseYears('6 yrs'), 6);
  assert.equal(parseYears('8'), 8);
  assert.equal(parseYears(''), undefined);
});

await check('derives the experience band from an exact figure (§7)', () => {
  assert.equal(experienceBand(0), 'fresher');
  assert.equal(experienceBand(1.5), 'below_2');
  assert.equal(experienceBand(3), '2_5');
  assert.equal(experienceBand(7), '5_10');
  assert.equal(experienceBand(14), 'above_10');
});

await check('maps qualifications onto the offered options', () => {
  assert.equal(normaliseEducation('B.E. Mechanical'), 'graduate');
  assert.equal(normaliseEducation('Diploma in Civil'), 'diploma');
  assert.equal(normaliseEducation('ITI Fitter'), 'iti');
  assert.equal(normaliseEducation('SSLC'), 'class_10');
  assert.equal(normaliseEducation('gibberish'), undefined);
});

await check('splits an address into the fields matching filters on (§6)', () => {
  const split = splitAddress('12/4 Anna Nagar, Chennai, Tamil Nadu 600040');
  assert.equal(split?.state, 'Tamil Nadu');
  assert.equal(split?.city, 'Chennai');
  assert.equal(split?.country, 'India');
  assert.equal(splitAddress('somewhere unspecified'), undefined);
});

await check('a CV fills in the questions it answers, and no more', () => {
  const fields: OcrField[] = [
    { key: 'name', value: 'Asha Kumari', confidence: null },
    { key: 'date_of_birth', value: '15/08/1995', confidence: null },
    { key: 'designation', value: 'TIG Welder', confidence: null },
    { key: 'total_experience_human', value: '6 years', confidence: null },
    { key: 'overseas_experience_human', value: '2 years', confidence: null },
    { key: 'highest_qualification', value: 'ITI Welder', confidence: null },
    { key: 'email', value: 'asha@example.com', confidence: null },
  ];

  const { patch, identity } = extractFromCv(fields, '919000000000');

  assert.equal(patch.fullName, 'Asha Kumari');
  assert.equal(patch.dateOfBirth, '1995-08-15');
  assert.equal(patch.currentOccupation, 'TIG Welder');
  assert.equal(patch.totalExperienceYears, 6);
  assert.equal(patch.totalExperienceBand, '5_10');
  assert.equal(patch.education, 'iti');
  // Unlocks the §7 overseas-countries question, which is otherwise not asked.
  assert.equal(patch.hasOverseasExperience, true);
  // Never inferred from a job history — §27 forbids inventing this.
  assert.equal(patch.countryPreference, undefined);
  assert.equal(patch.desiredOccupation, undefined);
  assert.equal(identity.name, 'Asha Kumari');
});

/* ------------------------------------------------------------------ */

console.log('\ndocument filing');

await check('a caption naming a document beats the question being asked', () => {
  const c = candidate({ currentStep: 'cv' });
  assert.equal(attributeInboundDocument(c, { caption: 'here is my passport' }), 'passport');
});

await check('an uncaptioned file goes to the document we asked for', () => {
  const c = candidate({ currentStep: 'aadhaar_upload' });
  assert.equal(attributeInboundDocument(c, { expecting: 'aadhaar' }), 'aadhaar');
});

/* ------------------------------------------------------------------ */

console.log('\napplication tracking');

await check('an id is recognised however the candidate types it', () => {
  assert.equal(normaliseApplicationId('ADR-00042'), 'ADR-00042');
  assert.equal(normaliseApplicationId('adr 42'), 'ADR-00042');
  assert.equal(normaliseApplicationId('  42 '), 'ADR-00042');
  assert.equal(normaliseApplicationId('no digits here'), undefined);
});

await check('a bare number is never mistaken for an application id', () => {
  // "2" is how a candidate picks the second row of a list. Reading it as an
  // application id would hijack every numbered answer in the flow.
  assert.equal(looksLikeApplicationId('2'), false);
  assert.equal(looksLikeApplicationId('yes'), false);
  assert.equal(looksLikeApplicationId('ADR-00042'), true);
  assert.equal(looksLikeApplicationId('my id is adr 42'), true);
});

/* ------------------------------------------------------------------ */

console.log('\nidle sessions (§21)');

await check('the resume prompt offers continue and start again', () => {
  assert.deepEqual(
    RESUME_CHOICES.map((c) => c.id),
    ['continue', 'restart'],
  );
});

await check('the reminder offers continue, later and start from first', () => {
  assert.deepEqual(
    REMINDER_CHOICES.map((c) => c.id),
    ['continue', 'later', 'restart'],
  );
});

/* ------------------------------------------------------------------ */

console.log('\nnaming a job instead of tapping a category (§9)');

await check('a job named at the preference question is kept in their own words', () => {
  // The reported bug had two halves. The interpreter calling "type writer"
  // off-topic was one; this is the other — even once it came back as a value,
  // the step had nowhere to put it, so it stayed unsatisfied and was re-asked.
  const step = stepById('job_preference')!;
  const patch = step.apply!({ value: 'typist', raw: 'type writer' }, {} as never);

  assert.equal(patch.workTypePreference, 'different');
  assert.equal(patch.desiredOccupation, 'typist');
});

await check('a tapped category still records the category, not a job', () => {
  const step = stepById('job_preference')!;
  const patch = step.apply!({ ids: ['general'], tapped: true }, {} as never);

  assert.equal(patch.workTypePreference, 'general');
  assert.equal(patch.desiredOccupation, undefined);
});

await check('naming a job satisfies the step, so it is not asked again', () => {
  const step = stepById('job_preference')!;
  const after = { profile: step.apply!({ value: 'typist' }, {} as never) } as never;
  assert.equal(step.satisfied(after), true);
});

await check('the job they named skips the question that would ask for it again', () => {
  // `desired_job` exists to ask "which job?" — §1 forbids asking when they have
  // just told us, and `desiredOccupation` being set is what prevents it.
  const desired = stepById('desired_job')!;
  const after = { profile: { workTypePreference: 'different', desiredOccupation: 'typist' } } as never;
  assert.equal(desired.when!(after), true);
  assert.equal(desired.satisfied(after), true);
});

await check('every work question declares how a named job should be read', () => {
  for (const id of ['main_trade', 'main_trade_other', 'job_preference', 'desired_job']) {
    const step = stepById(id)!;
    assert.ok(step.acceptsOccupation, `${id} does not accept a named occupation`);
  }
  // The distinction that matters: only where the options are themselves trades
  // may a named job be folded into one of them.
  assert.equal(stepById('main_trade')!.acceptsOccupation, 'category');
  assert.equal(stepById('job_preference')!.acceptsOccupation, 'named');
});

/* ------------------------------------------------------------------ */

// The FAQ answer is the one generative thing a candidate reads, so the fence
// around it is worth pinning. `violatesGuardrails` is what turns "never quote a
// salary" from a line in a prompt into a property of the system.
console.log('\nanswer guardrails (§27)');

await check('a salary figure is never sent, however it is written', () => {
  for (const attempt of [
    'You will get around 45,000 rupees per month.',
    'The salary is AED 4000.',
    'Expect ₹50,000 to start.',
    'They pay about 2 lakh a year.',
    'The wage is $1,200 monthly.',
    'Roughly 35000 INR.',
  ]) {
    assert.equal(violatesGuardrails(attempt), 'quoted a money amount', attempt);
  }
});

await check('an outcome is never promised', () => {
  for (const attempt of [
    'Your selection is guaranteed.',
    'You will definitely get this job.',
    'We promise you a visa.',
    '100% placement for welders.',
  ]) {
    assert.equal(violatesGuardrails(attempt), 'promised an outcome', attempt);
  }
});

await check('a timeline is never committed to', () => {
  assert.equal(violatesGuardrails('We will call you within 2 weeks.'), 'committed to a timeline');
  assert.equal(violatesGuardrails('You will travel in three months.'), 'committed to a timeline');
});

await check('the approved answers themselves all pass the guard', () => {
  // If an entry cannot be sent as written, the model has been handed a fact it
  // is forbidden to repeat — which reads to the candidate as the bot dodging.
  for (const entry of FAQ) {
    assert.equal(violatesGuardrails(entry.answer), undefined, `${entry.id}: ${entry.answer}`);
  }
});

await check('denying a guarantee is allowed — it is the safe sentence', () => {
  // The guard blocking this was a real bug: "does not guarantee" is precisely
  // what §27 wants said, and refusing to send it would leave the candidate with
  // the staff line instead of the honest answer.
  for (const denial of [
    'Registering does not guarantee selection.',
    'We cannot guarantee a job.',
    'There is no guarantee of placement.',
    'We never promise you a visa.',
  ]) {
    assert.equal(violatesGuardrails(denial), undefined, denial);
  }
});

await check('an ordinary answer is not caught by the guard', () => {
  for (const fine of [
    'Registering with us is free. We never ask candidates to pay for a job.',
    'Registration takes about ten minutes and your answers are saved as you go.',
    'Send UPDATE at any time to change your details.',
    'Pay depends on the employer and the role, and our staff confirm it before you accept.',
  ]) {
    assert.equal(violatesGuardrails(fine), undefined, fine);
  }
});

await check('every approved answer is reachable and distinct', () => {
  const ids = FAQ.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate FAQ id');
  for (const entry of FAQ) {
    assert.ok(entry.asks.trim().length > 0, `${entry.id} has no matching hints`);
    assert.ok(entry.answer.trim().length > 0, `${entry.id} has no answer`);
  }
});

/* ------------------------------------------------------------------ */

console.log('\nupload inspection (§14)');

const pdf = (body: string, terminated = true) =>
  Buffer.from(`%PDF-1.4\n${body}\n${terminated ? '%%EOF' : ''}`, 'latin1');

await check('a truncated PDF is rejected before a 120-second extraction', () => {
  const result = inspectUpload(pdf('/Type /Page ', false), 'application/pdf');
  assert.equal(result.readable, false);
  assert.match(result.problem!, /incomplete/);
});

await check('a file that is not a PDF at all is rejected', () => {
  const result = inspectUpload(Buffer.from('this is not a pdf'), 'application/pdf');
  assert.equal(result.readable, false);
});

await check('pages are counted when the PDF is uncompressed', () => {
  const result = inspectUpload(pdf('/Type /Page  /Type /Page  /Type /Pages '), 'application/pdf');
  assert.equal(result.readable, true);
  // /Type /Pages is the page *tree*, not a page. Counting it would inflate every
  // document by one and mask a single-page upload.
  assert.equal(result.pages, 2);
});

await check('an uncountable PDF reports no opinion rather than zero pages', () => {
  const result = inspectUpload(pdf('compressed object streams hide page objects'), 'application/pdf');
  assert.equal(result.readable, true);
  assert.equal(result.pages, undefined);
});

await check('an image is passed through without a page verdict', () => {
  const result = inspectUpload(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
  assert.equal(result.readable, true);
  assert.equal(result.pages, undefined);
});

/* ------------------------------------------------------------------ */

console.log('\nwider CV extraction (§5)');

await check('employment history is read and kept apart from the current job (§9)', () => {
  const fields: OcrField[] = [
    { key: 'designation', value: 'TIG Welder', confidence: null },
    { key: 'previous_designation', value: 'Helper', confidence: null },
    { key: 'previous_designation', value: 'TIG Welder', confidence: null },
    { key: 'employer', value: 'Larsen & Toubro', confidence: null },
    { key: 'employer', value: 'Godrej', confidence: null },
    { key: 'certification', value: 'ASNT Level II', confidence: null },
    { key: 'machinery', value: 'VMC', confidence: null },
    { key: 'phone', value: '919000000000', confidence: null },
    { key: 'phone', value: '918888888888', confidence: null },
  ];

  const { patch } = extractFromCv(fields, '919000000000');

  assert.equal(patch.currentOccupation, 'TIG Welder');
  // The current title is filtered out, so the same job never appears as both.
  assert.deepEqual(patch.previousOccupations, ['Helper']);
  assert.deepEqual(patch.employers, ['Larsen & Toubro', 'Godrej']);
  assert.deepEqual(patch.certifications, ['ASNT Level II']);
  assert.deepEqual(patch.machinery, ['VMC']);
  assert.equal(patch.mobileNumber, '919000000000');
  assert.equal(patch.alternateNumber, '918888888888');
  assert.equal(patch.desiredOccupation, undefined);
});

await check('machinery on the CV picks the trade pack without asking (§8)', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      machinery: ['TIG', 'MIG'],
    },
  });
  // Two packs serve fabrication_welding, so without a signal this would ask a
  // disambiguation question. The CV already answered it.
  assert.deepEqual(inferTradePacks(c), ['welder']);
});

/* ------------------------------------------------------------------ */

const total = passed + failures.length;
console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} of ${total} checks failed\x1b[0m\n` +
        failures.map((f) => `  - ${f}`).join('\n') +
        '\n'
    : `\n\x1b[32m${passed} checks passed\x1b[0m\n`,
);

process.exit(failures.length ? 1 : 0);
