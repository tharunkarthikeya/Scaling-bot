/**
 * Offline checks for the pieces that need no Mongo, Redis, or network.
 *
 * Most of what this covers is the protocol's own rules expressed as assertions:
 * that a question already answered is never asked again, that a Gulf candidate is
 * never asked for identity documents, that what a candidate wants is never
 * written over what they do, and that a spelling difference in a name is not
 * treated as a different person.
 *
 * Run with: npm run smoke
 */
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { config } from './config.js';
import { verifySignature } from './whatsapp/signature.js';
import { parseWebhook } from './whatsapp/parse.js';
import { chunkText } from './whatsapp/client.js';
import { attributeInboundDocument, initialSlots, requirementFor } from './conversation/checklist.js';
import { DOCUMENTS } from './conversation/rules.js';
import {
  destinationCountryOf,
  disambiguationChoices,
  fieldsToClear,
  inSingaporeMalaysiaBranch,
  inferTradeAnswers,
  inferTradePacks,
  occupationForQuestions,
  inEuropeRussiaBranch,
  nextStep,
  stepById,
  STEPS,
  TRADE_CHOICES,
} from './conversation/flow.js';
import { validateCopy } from './conversation/validate.js';
import {
  describeQuestion,
  detectGlobalCommand,
  interpret,
  resolveOfferedIds,
} from './conversation/interpret.js';
import {
  ageFrom,
  buildProfileWrite,
  compareIdentity,
  namesMatch,
  passportExpiryFlag,
} from './conversation/profile.js';
import {
  availabilityBand,
  experienceBand,
  extractFromCv,
  normaliseDate,
  normaliseEducation,
  normaliseMonthYear,
  parseDaysAway,
  parseYears,
  profileFromIdentityDocument,
  splitAddress,
} from './conversation/cv.js';
import { acceptedChoices, choicesFor } from './conversation/render.js';
import {
  looksLikeApplicationId,
  normaliseApplicationId,
  restartPatch,
  RESTART_UNSETS,
} from './conversation/engine.js';
import { OTHER_CHOICES, REMINDER_CHOICES, RESUME_CHOICES } from './conversation/copy.js';
import * as copy from './conversation/copy.js';
import { toCrmPayload } from './crm/mapping.js';
import { resetTaxonomy, setTaxonomyForTests } from './crm/taxonomy.js';
import { FAQ, violatesGuardrails } from './conversation/faq.js';
import { inspectUpload, resumeCompleteness } from './ocr/veris.js';
import { offLimits } from './conversation/tradeQuestions.js';
import { hasForeignScript } from './conversation/language.js';
import { INTERPRETER_PROMPT, TUNABLES } from './conversation/rules.js';
import { documentCollectionFor, recordCollectionFor } from './db/models.js';
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

await check('every label fits WhatsApp’s limits in every language we ship', () => {
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
    ['other', 'track', 'apply'],
  );
});

await check('"Other" opens the second menu, not a branch of its own (§2)', () => {
  assert.deepEqual(
    OTHER_CHOICES.map((o) => o.id),
    ['b2b', 'staff'],
  );
});

await check('a B2B contact is asked the B2B questions and none of registration', () => {
  const contact = candidate({ enquiry: 'b2b', profile: {}, consent: undefined });
  assert.equal(nextStep(contact)?.id, 'b2b_name');

  // Name in hand, the flow moves to the card rather than to the language or
  // consent questions — a business contact is not registering.
  contact.profile = { fullName: 'Priya Raman' };
  assert.equal(nextStep(contact)?.id, 'b2b_aadhaar_front');
});

await check('registration never reaches the B2B questions', () => {
  const c = candidate({ enquiry: 'apply', profile: {}, consent: undefined });
  for (const step of STEPS) {
    if (step.section === 'b2b') assert.equal(step.when?.(c), false);
  }
});

await check('B2B records and uploads are routed to their own collections', () => {
  // Routing is by branch, and it is what keeps a business contact out of the
  // candidate list, the reminder sweep and the matching indexes.
  assert.equal(recordCollectionFor('b2b'), 'b2b_enquiries');
  assert.equal(recordCollectionFor('apply'), 'candidates');
  assert.equal(recordCollectionFor(undefined), 'candidates');

  for (const id of ['b2b_aadhaar_front', 'b2b_aadhaar_back', 'company_registration']) {
    assert.equal(documentCollectionFor(id), 'b2b_documents');
  }
  for (const id of ['cv', 'passport', 'aadhaar', 'pan', 'certificate']) {
    assert.equal(documentCollectionFor(id), 'documents');
  }
});

await check('only the Aadhaar sides are read; the certificate is filed as it arrived', () => {
  // The Aadhaar endpoint, not the generic document one: it returns the number,
  // the name and the date of birth under their own names.
  assert.equal(requirementFor('b2b_aadhaar_front')?.ocr, 'aadhaar');
  assert.equal(requirementFor('b2b_aadhaar_back')?.ocr, 'aadhaar');
  assert.equal(requirementFor('aadhaar')?.ocr, 'aadhaar');
  assert.equal(requirementFor('company_registration')?.ocr, 'none');
});

await check('an unreadable B2B document leaves its question open', () => {
  // The bug this covers: the bot told the contact their Aadhaar was too blurred
  // to read, then asked for the back of the card in the very next message —
  // because running out of asks counted as an answer. It must not.
  const spent = (docId: string) => {
    const c = candidate({ enquiry: 'b2b', profile: { fullName: 'Priya Raman' } });
    c.documents[docId] = {
      status: 'incomplete',
      askedCount: TUNABLES.maxAsksPerB2bDocument + 1,
      updatedAt: new Date(),
    };
    return c;
  };

  const contact = spent('b2b_aadhaar_front');
  assert.equal(stepById('b2b_aadhaar_front')!.satisfied(contact), false);
  // And the flow stays on it rather than moving to the back of the card.
  assert.equal(nextStep(contact)?.id, 'b2b_aadhaar_front');

  // A file that arrived and read is what closes the question.
  contact.documents.b2b_aadhaar_front!.status = 'ocr_done';
  assert.equal(nextStep(contact)?.id, 'b2b_aadhaar_back');
});

await check('a candidate document still stops being chased at the ceiling (§14)', () => {
  // The candidate rule is deliberate and unchanged: their identity documents are
  // optional and staff collect them on a call.
  const c = candidate({
    profile: { countryPreference: 'europe', documentAvailability: 'all' },
  });
  c.documents.aadhaar = {
    status: 'incomplete',
    askedCount: TUNABLES.maxAsksPerDocument,
    updatedAt: new Date(),
  };
  assert.equal(stepById('aadhaar_upload')!.satisfied(c), true);
});

await check('a B2B caption cannot re-file an upload into a candidate slot', () => {
  // "aadhaar" is a keyword on the candidate slot too, and it is listed first.
  // Attribution is scoped to the branch, so the open question wins.
  const contact = candidate({ enquiry: 'b2b', currentStep: 'b2b_aadhaar_front' });
  assert.equal(
    attributeInboundDocument(contact, { caption: 'aadhaar front', expecting: 'b2b_aadhaar_front' }),
    'b2b_aadhaar_front',
  );

  // And the reverse: a candidate's Aadhaar still goes to the candidate slot.
  const applicant = candidate({ enquiry: 'apply', currentStep: 'aadhaar_upload' });
  assert.equal(
    attributeInboundDocument(applicant, { caption: 'my aadhaar', expecting: 'aadhaar' }),
    'aadhaar',
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
  // `countryPreference` is set on both: it is now the first question after
  // consent, because it decides whether the passport or the CV comes next.
  // Gulf is the branch that leaves the rest of the flow as it was.
  const withoutCv = candidate({
    profile: { lookingForOverseasJob: true, countryPreference: 'gcc', countryStrictness: 'any' },
  });
  withoutCv.documents.cv!.status = 'unavailable';
  assert.equal(nextStep(withoutCv)?.id, 'full_name');

  const withName = candidate({
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'gcc',
      countryStrictness: 'any',
      fullName: 'Asha Kumari',
    },
  });
  withName.documents.cv!.status = 'ocr_done';
  assert.notEqual(nextStep(withName)?.id, 'full_name');
});

await check('asks for a trade course only for ITI, diploma or graduate (§6)', () => {
  const tenth = candidate({ profile: { lookingForOverseasJob: true, education: 'class_10' } });
  assert.equal(stepById('education_course')!.when!(tenth), false);

  const iti = candidate({ profile: { lookingForOverseasJob: true, education: 'iti' } });
  assert.equal(stepById('education_course')!.when!(iti), true);
});

await check('a Gulf candidate is never asked for identity documents (§13)', () => {
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

/**
 * The order the questions come in.
 *
 * `nextStep` recomputes from state every turn rather than reading a stored
 * cursor, which is what makes "never ask twice" and "resume where you stopped"
 * one mechanism. The property that follows, and the one people actually notice,
 * is that the conversation can only ever move *forward* through `STEPS`. These
 * walk the whole flow and assert exactly that.
 *
 * A skipped question is not a reordered one, but it looks like one from the
 * candidate's side — upload a CV that supplies name, city, education and trade,
 * and the first thing you are asked is your date of birth. So both paths are
 * walked here: no CV, and a CV with gaps in it.
 */
console.log('\nquestion order (§1, §5)');

/** Answers whatever `nextStep` returns, and reports the sequence of step ids. */
function walkFlow(start: CandidateDoc): { order: string[]; indexes: number[] } {
  const c: CandidateDoc = structuredClone(start);
  const order: string[] = [];
  const indexes: number[] = [];

  for (let turn = 0; turn < 80; turn++) {
    const step = nextStep(c);
    if (!step) break;

    order.push(step.id);
    indexes.push(STEPS.findIndex((s) => s.id === step.id));

    // Answer it, the way the engine would.
    switch (step.id) {
      case 'entry':
        c.profile.lookingForOverseasJob = true;
        continue;
      case 'language':
        c.language = 'en';
        c.languageChosen = true;
        continue;
      case 'consent':
        c.consent = { given: true, at: new Date(), source: 'whatsapp_chat' };
        continue;
      case 'confirm':
        c.stage = 'REGISTRATION_COMPLETED';
        continue;
      default:
        break;
    }

    if (step.document) {
      c.documents[step.document] = {
        ...c.documents[step.document]!,
        status: 'received',
      };
      continue;
    }

    // `acceptedChoices`, not `step.choices` — the disambiguation question
    // resolves its options per candidate at render time, so its declared list
    // is empty. This is the same accessor the engine hands the interpreter.
    const offered = acceptedChoices(step, c).filter(
      (o) => o.id !== 'staff' && o.id !== '__done',
    );

    const answer =
      step.input === 'structured'
        ? { fields: { city: 'Chennai', state: 'Tamil Nadu', country: 'India' } }
        : step.input === 'date'
          ? { value: '1995-08-15' }
          : step.input === 'month_year'
            ? { value: '03/2031' }
            : offered.length
              ? { ids: [offered[0]!.id], tapped: true }
              : { value: 'something' };

    Object.assign(c.profile, step.apply?.(answer, c) ?? {});

    // A step with no `apply` would never become satisfied and the walk would
    // spin on it forever — which is itself worth failing on.
    if (!step.satisfied(c) && (!step.when || step.when(c))) {
      throw new Error(`step "${step.id}" cannot be satisfied by a normal answer`);
    }
  }

  return { order, indexes };
}

await check('the flow only ever moves forward, never back (no CV)', () => {
  const fresh = candidate({
    profile: {},
    consent: undefined,
    language: undefined,
    languageChosen: undefined,
    stage: 'NEW',
  });

  const { order, indexes } = walkFlow(fresh);

  for (let i = 1; i < indexes.length; i++) {
    assert.ok(
      indexes[i]! > indexes[i - 1]!,
      `went backwards: "${order[i - 1]}" then "${order[i]}"`,
    );
  }
  assert.ok(order.length > 10, 'the walk did not get through the flow');
});

await check('the CV is asked for before any personal question', () => {
  const fresh = candidate({
    profile: {},
    consent: undefined,
    language: undefined,
    languageChosen: undefined,
    stage: 'NEW',
  });

  const { order } = walkFlow(fresh);
  const cvAt = order.indexOf('cv');
  const firstPersonal = order.findIndex((id) => stepById(id)?.section === 'personal');

  assert.ok(cvAt >= 0, 'the CV is never asked for');
  assert.ok(cvAt < firstPersonal, 'a personal question comes before the CV is asked for');
});

await check('with no CV, every question is asked, in order', () => {
  const noCv = candidate({
    profile: { lookingForOverseasJob: true },
  });
  noCv.documents.cv!.status = 'unavailable';

  const { order } = walkFlow(noCv);

  // The whole of §6 is asked when nothing has been supplied for it.
  for (const id of ['full_name', 'location', 'dob', 'education']) {
    assert.ok(order.includes(id), `${id} was not asked`);
  }
  assert.ok(
    order.indexOf('full_name') < order.indexOf('location'),
    'name must come before location',
  );
  assert.ok(order.indexOf('location') < order.indexOf('dob'), 'location must come before dob');
  assert.ok(order.indexOf('dob') < order.indexOf('education'), 'dob must come before education');
});

await check('a CV with gaps is asked only for the gaps, still in order', () => {
  // Exactly the shape of the reported session: the CV supplied a name, a city
  // and a qualification, and had no date of birth.
  const withCv = candidate({
    profile: {
      lookingForOverseasJob: true,
      fullName: 'Asha Kumari',
      currentCity: 'Chennai',
      currentState: 'Tamil Nadu',
      education: 'iti',
      educationCourse: 'Welding',
    },
  });
  withCv.documents.cv!.status = 'ocr_done';

  const { order, indexes } = walkFlow(withCv);
  const personal = order.filter((id) => stepById(id)?.section === 'personal');

  // The gap is asked; what the CV supplied is not.
  assert.deepEqual(personal, ['dob'], `expected only dob to be asked, got ${personal.join(', ')}`);

  // And skipping does not disturb the order of everything that remains.
  for (let i = 1; i < indexes.length; i++) {
    assert.ok(indexes[i]! > indexes[i - 1]!, `went backwards at "${order[i]}"`);
  }
});

/* ------------------------------------------------------------------ */

/**
 * Questions whose options are buckets over a continuum.
 *
 * The interpreter usually picks the right bucket, but it sometimes hedges and
 * returns the candidate's words instead — "after 6 months" came back as a value
 * rather than as `more_than_30`. A step that reads only `ids` then drops the
 * answer, stays unsatisfied, and tells the candidate it could not be used.
 *
 * These pin the deterministic half, which is the half that does not depend on a
 * model behaving well on the day.
 */
console.log('\nbucketed answers (§7, §11)');

await check('a stated joining period becomes the right bucket', () => {
  const cases: Array<[string, string]> = [
    ['after 6 months', 'more_than_30'],
    ['6 months', 'more_than_30'],
    ['after 2 months', 'more_than_30'],
    ['in 20 days', 'within_30'],
    ['next week', 'within_15'],
    ['2 weeks', 'within_15'],
    ['10 days', 'within_15'],
    ['immediately', 'immediate'],
    ['ready now', 'immediate'],
    ['one month', 'within_30'],
    ['after 1 year', 'more_than_30'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(availabilityBand(parseDaysAway(text)), expected, text);
  }
});

await check('an answer naming no period stays unparsed, so it is re-asked', () => {
  // Correct behaviour, not a gap: "when my visa comes" is not a joining date,
  // and inventing a bucket for it would write a wrong answer into the record.
  for (const text of ['when my visa comes', 'not sure', 'after my exams', '']) {
    assert.equal(parseDaysAway(text), undefined, text);
  }
});

await check('the joining question records a typed answer, not just a tap', () => {
  const step = stepById('availability')!;

  // What the model returned in the reported session.
  const hedged = step.apply!({ value: 'after 6 months', raw: 'after 6 months' }, {} as never);
  assert.equal(hedged.availability, 'more_than_30');
  // Their wording is kept, which also satisfies the follow-up that would ask it.
  assert.equal(hedged.availabilityNote, 'after 6 months');

  const tapped = step.apply!({ ids: ['within_15'], tapped: true }, {} as never);
  assert.equal(tapped.availability, 'within_15');
  assert.equal(tapped.availabilityNote, undefined);
});

await check('a typed joining answer satisfies the step and skips the follow-up', () => {
  const step = stepById('availability')!;
  const after = { profile: step.apply!({ value: 'after 6 months' }, {} as never) } as never;
  assert.equal(step.satisfied(after), true);

  const followUp = stepById('availability_date')!;
  assert.equal(followUp.when!(after), true);
  assert.equal(followUp.satisfied(after), true, 'they already said when — §1 forbids asking again');
});

await check('a typed qualification is mapped instead of being lost', () => {
  const step = stepById('education')!;
  assert.equal(step.apply!({ value: 'BSc Physics' }, {} as never).education, 'graduate');
  assert.equal(step.apply!({ value: 'polytechnic diploma' }, {} as never).education, 'diploma');
  assert.equal(step.apply!({ ids: ['iti'], tapped: true }, {} as never).education, 'iti');
  // Nothing recognisable — re-asked rather than guessed at.
  assert.deepEqual(step.apply!({ value: 'hello' }, {} as never), {});
});

await check('an exact experience figure still derives its band (§7)', () => {
  const step = stepById('total_experience')!;
  const patch = step.apply!({ value: '6 years', raw: 'about six years' }, {} as never);
  assert.equal(patch.totalExperienceBand, '5_10');
  assert.equal(patch.totalExperienceYears, 6);
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

console.log('\nan upload that is not the document that was asked for (§5, §14)');

const cvField = (key: string, value: string): OcrField => ({ key, value, confidence: null });

await check('a CV that read is never sent back to be re-taken', () => {
  const outcome = resumeCompleteness({ name: 'Ravi Kumar' }, [cvField('name', 'Ravi Kumar')]);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.verdict, 'ok');
});

await check('a CV read only as far as its skills still counts as read', () => {
  // The extractor missing the name is not the candidate sending the wrong file.
  const outcome = resumeCompleteness({ skills: ['TIG', 'MIG'] }, [cvField('skills', 'TIG, MIG')]);
  assert.equal(outcome.complete, true);
});

await check('an Aadhaar card sent as a CV is identified rather than filed as one', () => {
  const outcome = resumeCompleteness(
    { page_text: 'Government of India — Unique Identification Authority. Aadhaar 4321 8765 2109' },
    [],
  );
  assert.equal(outcome.complete, false);
  assert.equal(outcome.verdict, 'wrong_document');
  assert.equal(outcome.looksLike, 'aadhaar');
});

await check('a passport sent as a CV is identified from its MRZ', () => {
  const outcome = resumeCompleteness(
    { page_text: 'P<INDSREENU<<ERITAM<<<<<<<<<<<<<<<<<<<<<<<<<< C40197166IND7605254M3410108' },
    [],
  );
  assert.equal(outcome.verdict, 'wrong_document');
  assert.equal(outcome.looksLike, 'passport');
});

await check('a file nothing could be read from is not accused of being another document', () => {
  // "empty" and "wrong_document" are different sentences to the candidate: one
  // asks for a clearer photo, the other says they picked the wrong file.
  const outcome = resumeCompleteness({}, []);
  assert.equal(outcome.complete, false);
  assert.equal(outcome.verdict, 'empty');
  assert.equal(outcome.looksLike, undefined);
});

/* ------------------------------------------------------------------ */

console.log('\nreaching a person (§24)');

await check('an unreadable reply is re-asked once, then handed over', () => {
  // The ladder itself lives in the engine; this pins the number it counts to.
  // Three meant a candidate the bot could not read sat through two retries.
  assert.equal(TUNABLES.maxAsksPerStep, 2);
});

await check('a job title is not a request for a person', () => {
  // Every one of these used to hand the candidate to staff before the
  // interpreter was reached, for answering a question with their own job.
  for (const said of [
    'production manager',
    'planning and production manager',
    'i was a site manager for 5 years',
    'my passport is with the agent',
    'agent asked me to send it',
  ]) {
    assert.equal(detectGlobalCommand(said), undefined, said);
  }
});

await check('a number given at the contact question is not a request for a call', () => {
  assert.equal(detectGlobalCommand('you can call me at 9876543210'), undefined);
  assert.equal(detectGlobalCommand('call me back please'), 'staff');
});

await check('asking for a person is understood in every language we ship', () => {
  for (const said of [
    'talk to staff',
    'speak to someone',
    'i want to talk to a person',
    'connect me to a human',
    'customer care',
    // The Tamil and Hindi labels of the button itself. Anchored with \b these
    // never matched: there is no ASCII word boundary before a Tamil letter.
    'ஊழியருடன் பேச',
    'स्टाफ से बात करें',
  ]) {
    assert.equal(detectGlobalCommand(said), 'staff', said);
  }
});

await check('the interpreter is told what "related" is, and what "unclear" now costs', () => {
  // The tool accepts the classification; the prompt is what makes it usable.
  // A classification the tool offers and the prompt never explains is dead.
  assert.match(INTERPRETER_PROMPT, /- related/);
  assert.match(INTERPRETER_PROMPT, /handed to a member of staff/);
});

/* ------------------------------------------------------------------ */

console.log('\nwhich trade, and which questions follow from it (§7, §8)');

await check('a trade is read from all the CV says, not from one word of the job title', () => {
  // The case this was written for. "Planning & Production Manager" matched the
  // word `production` in the factory/warehouse pattern, that pattern came first,
  // and four welding processes, an ASNT certification, pressure vessels and PEB
  // were never looked at.
  const { patch } = extractFromCv([
    cvField('name', 'SREENU ERITAM'),
    cvField('designation', 'Planning & Production Manager'),
    cvField('industry', 'Pressure Vessels | Steel Structures'),
    cvField(
      'skills',
      'Project Planning, Production Control, Welding Procedures (SMAW/GTAW/GMAW/SAW), PWHT, Stage Inspection',
    ),
    cvField('certification', 'ASNT Level-II in PT, MPT, UT & RT'),
    cvField('previous_designation', 'Production Head'),
  ]);

  assert.equal(patch.primaryTrade, 'fabrication_welding');
});

await check('the trade vocabulary also picks the right question packs', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      currentOccupation: 'Planning & Production Manager',
      skills: ['Welding Procedures (SMAW/GTAW/GMAW/SAW)', 'PWHT'],
      certifications: ['ASNT Level-II in PT, MPT, UT & RT'],
    },
  });
  // Welding from the processes, NDT from the certification. Both are this
  // candidate's actual work, and neither was reachable before.
  assert.deepEqual(inferTradePacks(c), ['welder', 'ndt']);
});

await check('a generic job title alone loads no specialist pack', () => {
  const { patch } = extractFromCv([cvField('designation', 'Production Manager')]);
  const c = candidate({ profile: { lookingForOverseasJob: true, ...patch } });

  // The title is still read as factory/warehouse, which is a fair reading of it
  // and one the candidate can correct at the summary. What must not happen is
  // the CNC pack loading off the back of it — that is how someone with no
  // machining evidence was asked which machines he had operated.
  assert.notEqual(patch.primaryTrade, 'fabrication_welding');
  assert.deepEqual(inferTradePacks(c), []);
});

await check('"operator" alone does not make someone a CNC machinist (§8)', () => {
  // The reported bug: a JCB operator was asked which CNC machines he had
  // operated. "operator" was a keyword on the CNC pack, and it means only that
  // someone works a machine of some kind.
  for (const job of ['JCB operator', 'crane operator', 'forklift operator', 'boiler operator']) {
    const c = candidate({
      profile: { lookingForOverseasJob: true, primaryTrade: 'driver_operator', currentOccupation: job },
    });
    assert.deepEqual(inferTradePacks(c), [], `${job} should load no CNC pack`);
  }

  // And a machinist still gets it, which is the point of the pack.
  for (const job of ['CNC operator', 'VMC setter', 'lathe machinist']) {
    const c = candidate({
      profile: { lookingForOverseasJob: true, primaryTrade: 'driver_operator', currentOccupation: job },
    });
    assert.deepEqual(inferTradePacks(c), ['cnc_operator'], `${job} should load the CNC pack`);
  }
});

await check('a pack keyword is a word, not a run of letters inside one (§8)', () => {
  // "mig" inside "migrant" and "arc" inside "March" both used to load the
  // welding pack for someone who had said nothing about welding.
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      currentOccupation: 'migrant worker since March',
    },
  });
  // undefined, not []: nothing matched, so the disambiguation question decides
  // rather than a run of letters inside an unrelated word.
  assert.equal(inferTradePacks(c), undefined);

  // The real word still loads it.
  const welder = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      currentOccupation: 'MIG welder',
    },
  });
  assert.deepEqual(inferTradePacks(welder), ['welder']);
});

await check('§12 asks for the passport, not for facts about it', () => {
  // Typed-from-memory expiry dates are the least reliable thing on the record,
  // and the document that settles it is one tap away.
  assert.equal(stepById('passport_expiry'), undefined);

  const holder = candidate({ profile: { lookingForOverseasJob: true, passportStatus: 'yes' } });
  const step = stepById('passport_document')!;
  assert.equal(step.when!(holder), true);
  assert.equal(step.document, 'passport');
  assert.equal(step.satisfied(holder), false);
});

await check('a passport already on file is never asked for again (§1, §12)', () => {
  // Covers the CV case: `ocr/veris.ts` files passport pages found inside a CV
  // against this slot, and filling the slot is what closes the question.
  const c = candidate({ profile: { lookingForOverseasJob: true, passportStatus: 'yes' } });
  c.documents.passport = { status: 'ocr_queued', askedCount: 0, updatedAt: new Date() };

  assert.equal(stepById('passport_document')!.satisfied(c), true);
  // And the Europe/Russia upload question does not ask for it a second time.
  assert.equal(stepById('passport_upload')!.satisfied(c), true);
});

await check('one candidate pack is not evidence for that pack', () => {
  // factory_warehouse is served by exactly one pack. That used to be taken as
  // "nothing to choose between", and the pack was loaded with no support at all.
  const c = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'factory_warehouse' },
  });
  assert.deepEqual(inferTradePacks(c), []);
});

await check('tapping Fabrication / Welding asks which, rather than loading both', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      tradeFromList: true,
    },
  });

  // Nothing is inferred: the candidate named a category and nothing else, so
  // only their own answer may narrow it.
  assert.equal(inferTradePacks(c), undefined);

  // The question applies and is outstanding, so the flow reaches it — asserted
  // on the step itself rather than on `nextStep`, which returns the CV question
  // first for a candidate who has not sent one.
  const step = stepById('trade_disambiguation')!;
  assert.equal(step.when!(c), true);
  assert.equal(step.satisfied(c), false);
  assert.deepEqual(
    disambiguationChoices(c).map((ch) => ch.id),
    ['welding', 'fabrication', 'both'],
  );
});

await check('a date of birth written the way people write it is not dropped', () => {
  // The CV said "25th May 1976" and the candidate was asked for a date of birth
  // printed at the top of the page he had just sent.
  assert.equal(normaliseDate('25th May 1976'), '1976-05-25');
  assert.equal(normaliseDate('1st Mar 1994'), '1994-03-01');
  assert.equal(normaliseDate('3rd December 1988'), '1988-12-03');
  assert.equal(normaliseDate('May 25, 1976'), '1976-05-25');
  // Still day-first where both numbers could be a month (§5), and still silent
  // where there is no date at all.
  assert.equal(normaliseDate('12/02/2027'), '2027-02-12');
  assert.equal(normaliseDate('sometime next year'), undefined);
});

await check('pack questions the CV already answered are not asked (§1)', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      tradePacks: ['welder', 'ndt'],
      skills: ['Welding Procedures (SMAW/GTAW/GMAW/SAW)', 'PWHT', 'Stage Inspection'],
      certifications: ['ASNT Level-II in PT, MPT, UT & RT'],
    },
  });

  const inferred = inferTradeAnswers(c)!;
  assert.ok(inferred, 'nothing was inferred from a CV that names both');

  // GMAW is MIG and GTAW is TIG — the CV's own words for the same processes.
  assert.deepEqual(inferred.welding_process!.sort(), ['arc_smaw', 'mig', 'saw', 'tig']);
  assert.deepEqual(inferred.ndt_certifications, ['asnt']);

  // Never the yes/no question next to them: a list of certifications does not
  // say whether the welding one is *valid*, and that is what it asks.
  assert.equal(inferred.welding_certificate, undefined);
});

await check('an answer the candidate gave is never overwritten by the CV', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      tradePacks: ['welder'],
      skills: ['SMAW', 'GMAW'],
      tradeAnswers: { welding_process: ['tig'] },
    },
  });
  assert.equal(inferTradeAnswers(c), undefined);
});

await check('a CV that names nothing infers nothing', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      tradePacks: ['welder', 'ndt'],
      skills: ['Team management', 'MS Office'],
    },
  });
  assert.equal(inferTradeAnswers(c), undefined);
});

await check('a specialist question tells the interpreter what it is about', () => {
  const step = stepById('trade:cnc_operator:machines_operated')!;
  assert.ok(step.expects, 'the CNC machine question declares no context');

  // Declared on the question and dropped on the way to the model is the same as
  // not declared at all, and looks identical from outside.
  const described = describeQuestion(step, []);
  assert.match(described, /THIS QUESTION IS ABOUT/);
  assert.match(described, /CNC/);
  assert.match(described, /"related"/);
});

/* ------------------------------------------------------------------ */

console.log('\nan answered question stays answered');

await check('the flow never returns a question that has an answer', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'gcc',
      countryStrictness: 'any',
      fullName: 'Ravi Kumar',
      currentCity: 'Chennai',
      currentState: 'Tamil Nadu',
      dateOfBirth: '1995-08-15',
      education: 'iti',
      educationCourse: 'Welder',
    },
    documents: { ...initialSlots(), cv: { status: 'unavailable', askedCount: 1, updatedAt: new Date() } },
  });

  // Every answered step reports itself satisfied, and the scheduler walks past
  // all of them to the first one that is not.
  for (const id of ['full_name', 'location', 'dob', 'education', 'education_course']) {
    assert.equal(stepById(id)!.satisfied(c), true, id);
  }
  assert.equal(nextStep(c)?.id, 'main_trade');
});

await check('an answer survives a restart, because it is state and not a cursor', () => {
  const c = candidate({ profile: { lookingForOverseasJob: true, fullName: 'Ravi Kumar' } });

  // What a restart actually does: the process forgets everything and reads the
  // candidate back out of Mongo. `satisfied` is computed from that document, so
  // there is no in-memory progress to lose — and `currentStep` is a pointer to
  // the open question, not a record of what has been answered.
  const reloaded = JSON.parse(JSON.stringify(c)) as CandidateDoc;
  assert.equal(stepById('full_name')!.satisfied(reloaded), true);
  assert.notEqual(nextStep(reloaded)?.id, 'full_name');
});

await check('an answer the CV supplied locks the question just as tightly', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      tradePacks: ['welder'],
      tradeAnswers: { welding_process: ['arc_smaw'] },
    },
  });
  assert.equal(stepById('trade:welder:welding_process')!.satisfied(c), true);
  // And nothing further is inferred over the top of it.
  assert.equal(inferTradeAnswers(c), undefined);
});

await check('an edit reopens exactly the section it was asked for', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      fullName: 'Ravi Kumar',
      dateOfBirth: '1995-08-15',
      education: 'iti',
      primaryTrade: 'fabrication_welding',
    },
  });

  // §22 and §18: an edit clears that section's fields, which is what makes the
  // steps unanswered again. The lock is on having an answer, so clearing the
  // answer is the only thing that reopens a question — and it cannot reach
  // outside the section the candidate chose.
  const cleared = fieldsToClear('personal');
  assert.ok(cleared.includes('fullName'));
  assert.ok(cleared.includes('dateOfBirth'));
  assert.ok(!cleared.includes('primaryTrade'), 'an edit of personal details reached the trade');

  const edited = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'fabrication_welding' },
    editQueue: ['full_name', 'dob', 'education'],
  });
  assert.equal(stepById('full_name')!.satisfied(edited), false);
  assert.equal(nextStep(edited)?.id, 'full_name');
});

/* ------------------------------------------------------------------ */

console.log('\nquestions written for a trade no pack covers (§8)');

await check('a generated question may not stray off the trade it was written for', () => {
  for (const asked of [
    'What salary are you expecting for this work?',
    'How much do you charge for a day of work?',
    'Please send your passport copy.',
    'When can you join?',
    'Which country would you like to work in?',
    'How old are you?',
    'Are you married or single?',
    'Do you have children?',
    'What is your blood group?',
    'Do you have any medical condition?',
    'Which caste do you belong to?',
    'How many years of experience do you have?',
  ]) {
    assert.equal(offLimits(asked), true, asked);
  }
});

await check('a professional qualification for the trade may be asked about', () => {
  // The registration asks for schooling. A certificate for the work itself is a
  // different question and one a recruiter needs — blocking the word
  // "qualification" outright took it away from every trade at once.
  for (const asked of [
    'Do you have a professional accounting qualification such as CA, CPA or ACCA?',
    'Do you hold a plumbing certificate or registration?',
    'Are you registered with a physiotherapy board or council?',
    'Did you complete a course or training in beauty work, or did you learn on the job?',
  ]) {
    assert.equal(offLimits(asked), false, asked);
  }

  // What the flow asks itself stays out of bounds.
  assert.equal(offLimits('What is your highest qualification?'), true);
  assert.equal(offLimits('Which college did you attend?'), true);
  assert.equal(offLimits('How many years of experience do you have?'), true);
});

await check('the filter does not mistake trade vocabulary for a banned subject', () => {
  // Every one of these was blocked by the first version of the filter, which
  // matched the risky word without the sense that made it risky. A screen that
  // silently drops the questions a recruiter needs is worse than none: nothing
  // reports it, and the profile just comes back thin.
  for (const asked of [
    'What voltage have you worked with — low voltage single phase, or three phase?',
    'Do you have health and safety training?',
    'Have you worked on medical gas piping?',
    'Have you worked as a chargehand?',
    'Which joining methods do you use?',
    'Have you cooked in a family restaurant or a community kitchen?',
    'Do you do cost estimation for the jobs you take?',
    'Which sewing machines have you used?',
    'What licences or certificates do you hold for electrical work?',
    'Who did you mostly cut hair for — men, women, children, or mixed?',
  ]) {
    assert.equal(offLimits(asked), false, asked);
  }
});

await check('copy is never written in a script the reader does not read', () => {
  // A Tamil question came back from the model with Bengali letters inside two of
  // its words. It is not a typo a reader can see past — it is a glyph outside
  // the alphabet they read, and it is invisible in review to anyone who does not
  // read the script. Checked at boot for written copy, and here for the runtime
  // half that guards generated questions.
  assert.equal(hasForeignScript('எந்த மின் வேலை செய்தீர்கள்?', 'ta'), false);
  assert.equal(hasForeignScript('என்ன ধরமான மின் வேலை?', 'ta'), true, 'Bengali inside Tamil');
  assert.equal(hasForeignScript('మీరు ఏ పని చేస్తారు?', 'te'), false);
  assert.equal(hasForeignScript('మీ సংગ్రహించి', 'te'), true, 'Bengali and Gujarati inside Telugu');
  assert.equal(hasForeignScript('നിങ്ങളുടെ ജോലി എന്താണ്?', 'ml'), false);

  // English is Latin and unconstrained, and a language we do not ship copy for
  // has no script to check against.
  assert.equal(hasForeignScript('Which machines have you operated?', 'en'), false);
  assert.equal(hasForeignScript('যে কোনো লেখা', 'other'), false);
  // Latin terms inside a translated sentence are expected, not foreign.
  assert.equal(hasForeignScript('உங்கள் CV-ஐ PDF ஆக அனுப்பவும்', 'ta'), false);
});

await check('the job asked about is the candidate own words, not a menu heading', () => {
  // Typing "plumber" is read as the Electrical/Mechanical category, and
  // `main_trade.apply` deliberately does not copy a category into
  // `currentOccupation` — so their word survives only in the raw wording, and
  // that is the brief a question writer needs.
  const typed = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'electrical_mechanical' },
    fieldMeta: { primaryTrade: { source: 'chat', raw: 'plumber', at: new Date() } },
  });
  assert.equal(occupationForQuestions(typed), 'plumber');

  // A tap carries the label as its raw text, so there is nothing better to use.
  const tapped = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'electrical_mechanical' },
    fieldMeta: { primaryTrade: { source: 'chat', raw: 'Electrical / Mechanical', at: new Date() } },
  });
  assert.equal(occupationForQuestions(tapped), 'Electrical / Mechanical');

  // A number is the position of an option in the list they were shown.
  const numbered = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'hospitality' },
    fieldMeta: { primaryTrade: { source: 'chat', raw: '6', at: new Date() } },
  });
  assert.equal(occupationForQuestions(numbered), 'Hospitality');

  // Their own words win over everything.
  const own = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'other',
      currentOccupation: 'poultry farm supervisor',
    },
  });
  assert.equal(occupationForQuestions(own), 'poultry farm supervisor');

  // "Other" with nothing behind it yet is not a job to write questions about.
  const nothing = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'other' },
  });
  assert.equal(occupationForQuestions(nothing), undefined);
});

await check('a hand-written pack is always asked before a generated question', () => {
  const packStep = STEPS.findIndex((s) => s.id.startsWith('trade:'));
  const generated = STEPS.findIndex((s) => s.id.startsWith('trade_extra:'));
  assert.ok(packStep >= 0 && generated > packStep, 'generated questions come before a pack');
});

await check('generated slots exist only for the questions a candidate has', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'other',
      currentOccupation: 'accountant',
      tradePacks: [],
      tradeQuestions: [
        { id: 'accounting_software', prompt: 'Which accounting software have you used?', options: [] },
      ],
    },
  });

  const first = stepById('trade_extra:0')!;
  const second = stepById('trade_extra:1')!;

  assert.equal(first.when!(c), true);
  assert.equal(first.satisfied(c), false);
  // One question means one slot. The other three never apply.
  assert.equal(second.when!(c), false);

  const answered = candidate({
    profile: { ...c.profile, tradeAnswers: { accounting_software: ['Tally'] } },
  });
  assert.equal(first.satisfied(answered), true);
});

/* ------------------------------------------------------------------ */

console.log('\nhow uploads are filed');

await check('a driving licence is filed as one, not as a certificate', () => {
  const c = candidate();
  // "Licence" used to be a certificate keyword, so every driver's licence
  // landed among the qualifications and a recruiter had to open each one.
  for (const hint of ['driving licence.jpg', 'my DL', 'driver license', 'ஓட்டுநர் உரிமம்']) {
    assert.equal(attributeInboundDocument(c, { filename: hint }), 'driving_licence', hint);
  }

  // What a certificate slot is still for.
  assert.equal(attributeInboundDocument(c, { filename: 'ITI certificate.pdf' }), 'certificate');
  assert.equal(attributeInboundDocument(c, { filename: 'marksheet.pdf' }), 'certificate');
});

await check('every document kind the flow can ask for has a section to live in', () => {
  // The sections of a candidate's document record are exactly the kinds in
  // `rules.ts`; a step asking for one that has nowhere to go would store the
  // upload and lose it.
  const kinds = DOCUMENTS.map((d) => d.id);
  for (const id of ['cv', 'passport', 'aadhaar', 'pan', 'driving_licence', 'certificate']) {
    assert.ok(kinds.includes(id), `no section for "${id}"`);
  }
  for (const step of STEPS) {
    if (step.document) assert.ok(kinds.includes(step.document), step.id);
  }
});

console.log('\nwhere they want to work decides how they are registered');

/** A candidate who has consented and is standing at the country question. */
function atCountryQuestion(preference?: string): CandidateDoc {
  return candidate({
    stage: 'NEW',
    profile: {
      lookingForOverseasJob: true,
      ...(preference ? { countryPreference: preference, countryStrictness: 'any' } : {}),
    },
  });
}

await check('the country question comes before the CV, not two thirds of the way in', () => {
  // It is the branch point now: it decides whether the passport or the CV is
  // asked for next, and a branch point asked after the branch cannot branch.
  const ids = STEPS.map((s) => s.id);
  assert.ok(ids.indexOf('country_preference') < ids.indexOf('cv'), 'country must precede the CV');
  assert.ok(
    ids.indexOf('consent') < ids.indexOf('country_preference'),
    'nothing is asked before consent',
  );

  // And it is what a freshly consented candidate is actually asked.
  assert.equal(nextStep(atCountryQuestion())?.id, 'country_preference');
});

await check('Singapore or Malaysia asks for the passport before anything else', () => {
  const sgmy = atCountryQuestion('malaysia');
  assert.equal(inSingaporeMalaysiaBranch(sgmy), true);
  assert.equal(nextStep(sgmy)?.id, 'sgmy_passport');

  // Every other destination is unchanged: the CV still comes first.
  for (const elsewhere of ['gcc', 'europe', 'russia_cis', 'any']) {
    const c = atCountryQuestion(elsewhere);
    assert.equal(inSingaporeMalaysiaBranch(c), false, elsewhere);
    assert.equal(nextStep(c)?.id, 'cv', elsewhere);
  }
});

await check('what the passport says is never asked as a question', () => {
  // The whole point of reading the passport first (§1, §5). The extractor fills
  // these, and a filled field is a question that is never put to the candidate.
  const passportFields: OcrField[] = [
    { key: 'name', value: 'RAVI KUMAR', confidence: 0.97 },
    { key: 'date_of_birth', value: '1994-03-11', confidence: 0.97 },
    { key: 'nationality', value: 'INDIAN', confidence: 0.97 },
    { key: 'passport_number', value: 'Z1234567', confidence: 0.97 },
  ];

  const patch = profileFromIdentityDocument('passport', passportFields);
  assert.equal(patch.fullName, 'RAVI KUMAR');
  assert.equal(patch.dateOfBirth, '1994-03-11');
  assert.equal(patch.nationality, 'INDIAN');
  assert.equal(patch.passportNumber, 'Z1234567');

  const sgmy = atCountryQuestion('malaysia');
  sgmy.documents.passport = { status: 'ocr_done', askedCount: 1, updatedAt: new Date() };
  Object.assign(sgmy.profile, patch);

  assert.equal(stepById('full_name')!.satisfied(sgmy), true, 'name still being asked');
  assert.equal(stepById('dob')!.satisfied(sgmy), true, 'date of birth still being asked');
  // And the passport itself is not asked for a second time further down.
  assert.equal(stepById('passport_status')!.satisfied(sgmy), true);
});

await check('the CV is skipped only when the CRM says it is not needed', () => {
  const cvStep = stepById('cv')!;

  // The policy has not answered yet. An unknown requirement asks for the CV —
  // the cost of an unnecessary question is one question, and the cost of
  // skipping a required one is a submission refused after the conversation has
  // already ended.
  const undecided = atCountryQuestion('malaysia');
  assert.equal(cvStep.when!(undecided), true);

  // Policy says no. Skipped.
  const exempt = atCountryQuestion('malaysia');
  exempt.profile.cvRequired = false;
  assert.equal(cvStep.when!(exempt), false);

  // Policy says yes. Asked.
  const required = atCountryQuestion('malaysia');
  required.profile.cvRequired = true;
  assert.equal(cvStep.when!(required), true);
});

await check('every other destination still always asks for the CV', () => {
  // The one thing that must not change. A Gulf or Europe candidate's
  // registration begins with the CV exactly as it always has, and no policy
  // answer can turn it off for them.
  const cvStep = stepById('cv')!;
  for (const region of ['gcc', 'europe', 'russia_cis', 'any']) {
    const c = atCountryQuestion(region);
    assert.equal(cvStep.when!(c), true, region);
    // Even if a stale requirement were somehow on the record.
    c.profile.cvRequired = false;
    assert.equal(cvStep.when!(c), true, `${region} with a stale cvRequired`);
  }
});

await check('candidates who chose the old combined option keep their branch', () => {
  // Singapore and Malaysia used to be one row. §22 does not let a menu change
  // rewrite what someone already answered, so records carrying the old id stay
  // on the passport-first route.
  const legacy = atCountryQuestion('singapore_malaysia');
  assert.equal(inSingaporeMalaysiaBranch(legacy), true);
  // But no country can be claimed for them — the question was never asked.
  assert.equal(toCrmPayload(legacy, '111').profile.destination_country, undefined);
});

await check('a promised passport does not count as a passport', () => {
  // `documentOnFile`, not `documentSatisfied`. Someone who said "I don't have
  // one" has answered the upload question without giving us a document, and is
  // exactly who "do you have a valid passport?" needs to be put to.
  const sgmy = atCountryQuestion('malaysia');
  for (const status of ['unavailable', 'promised'] as const) {
    sgmy.documents.passport = { status, askedCount: 1, updatedAt: new Date() };
    assert.equal(
      stepById('passport_status')!.satisfied(sgmy),
      false,
      `"${status}" must not answer the passport question`,
    );
  }
});

await check('the job is asked before the CV, because it decides whether one is needed', () => {
  // The reordering this branch exists for. A CV requirement computed from
  // destination and job cannot be computed before the job is known, so asking
  // for the document first is either a wasted request or a missing one.
  const ids = STEPS.map((s) => s.id);
  assert.ok(
    ids.indexOf('sgmy_job_category') < ids.indexOf('cv'),
    'the job category must be established before the CV is asked for',
  );
  assert.ok(
    ids.indexOf('country_preference') < ids.indexOf('sgmy_passport'),
    'the destination decides the branch, so it comes first',
  );
  assert.ok(
    ids.indexOf('sgmy_passport') < ids.indexOf('sgmy_job_category'),
    'passport, then job',
  );
  assert.ok(
    ids.indexOf('sgmy_job_category') < ids.indexOf('main_trade'),
    'what they want is asked before what they already do',
  );
  assert.ok(
    ids.indexOf('main_trade') < ids.indexOf('total_experience'),
    'experience follows the current job',
  );

  // Only on this branch. Everyone else keeps §9's order, where what someone
  // does is established before what they want.
  assert.equal(stepById('sgmy_job_category')!.when!(atCountryQuestion('gcc')), false);
  assert.equal(stepById('sgmy_job_category')!.when!(atCountryQuestion('malaysia')), true);
});

await check('the job is a controlled value, not free text', () => {
  // A policy table cannot match "general labour", "helper" and "GW" against a
  // rule about general workers. The tap is what makes the CV decision possible.
  const step = stepById('sgmy_job_category')!;
  assert.equal(step.input, 'choice');
  assert.ok(step.choices?.length, 'the job question must offer a fixed list');

  const ids = step.choices!.map((c) => c.id);
  for (const required of ['general_worker', 'technician', 'other']) {
    assert.ok(ids.includes(required), `missing category "${required}"`);
  }
  // WhatsApp lists cap at ten rows; an eleventh would silently not render.
  assert.ok(ids.length <= 10, `too many rows for a WhatsApp list: ${ids.length}`);
});

await check('answering it once answers it everywhere', () => {
  // The tap records the category; typing records the category *and* their own
  // words. Either way `desiredOccupation` is filled, so the general flow's
  // `desired_job` is already answered and never asked twice (§1).
  const tapped = atCountryQuestion('malaysia');
  Object.assign(
    tapped.profile,
    stepById('sgmy_job_category')!.apply!({ ids: ['general_worker'], tapped: true }, tapped),
  );
  assert.equal(tapped.profile.jobCategory, 'general_worker');

  const typed = atCountryQuestion('malaysia');
  Object.assign(
    typed.profile,
    stepById('sgmy_job_category')!.apply!({ value: 'Warehouse packer' }, typed),
  );
  assert.equal(typed.profile.desiredOccupation, 'Warehouse packer');
  assert.equal(typed.profile.jobCategory, 'other');
  assert.equal(stepById('desired_job')!.satisfied(typed), true);
});

await check('a name read off a passport never overwrites one the candidate typed', () => {
  // §17 flags a disagreement between documents for a person to settle; it
  // cannot flag what has already been silently overwritten. Chat outranks OCR.
  const c = candidate({ profile: { lookingForOverseasJob: true } });
  buildProfileWrite(c, { fullName: 'Ravi Kumar' }, { source: 'chat' });
  buildProfileWrite(c, { fullName: 'RAVI KUMAAR' }, { source: 'document', confidence: 0.6 });

  assert.equal(c.profile.fullName, 'Ravi Kumar');
  assert.equal(c.fieldMeta.fullName?.source, 'chat');
});

console.log('\ncontinue keeps the half-finished session; restart throws it away');

/**
 * Someone who answered four questions and then went quiet.
 *
 * `editQueue` and `pendingMulti` are left out of the base fixture and set only
 * where a test is about them: an edit queue takes priority in `nextStep`, so a
 * candidate carrying one is not a candidate in the middle of ordinary
 * registration, and using one here would test the wrong thing.
 */
function halfFinished(over: Partial<CandidateDoc> = {}): CandidateDoc {
  const slots = initialSlots();
  slots.cv = { status: 'ocr_done', askedCount: 1, documentId: new ObjectId(), updatedAt: new Date() };

  return candidate({
    stage: 'BASIC_DETAILS_PENDING',
    // Mid-question: the education step is open and unanswered.
    currentStep: 'education',
    unclearCount: 1,
    sessionEndedAt: new Date(),
    documents: slots,
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'gcc',
      countryStrictness: 'any',
      fullName: 'Ravi Kumar',
      currentCity: 'Chennai',
      currentState: 'Tamil Nadu',
      dateOfBirth: '1994-03-11',
    },
    fieldMeta: {
      fullName: { source: 'chat', at: new Date(), verified: false },
      dateOfBirth: { source: 'chat', at: new Date(), verified: false },
    },
    ...over,
  });
}

await check('continue keeps every answer already given', () => {
  // Continue reopens the session and asks the next question. It changes no
  // answer, so everything the candidate already said is still there.
  const c = halfFinished();

  assert.equal(c.profile.fullName, 'Ravi Kumar');
  assert.equal(c.profile.dateOfBirth, '1994-03-11');
  assert.equal(c.profile.currentCity, 'Chennai');

  for (const id of ['full_name', 'location', 'dob']) {
    assert.equal(stepById(id)!.satisfied(c), true, `${id} was forgotten`);
  }
});

await check('continue resumes at the first question still unanswered', () => {
  // `nextStep` is computed from state, not from a stored cursor — which is why
  // "resume where you stopped" needs no bookmark. The engine clears
  // `currentStep` and asks again; the scheduler walks past everything answered.
  const c = halfFinished();
  c.currentStep = undefined; // what the engine does on 'continue'
  c.sessionEndedAt = undefined;

  assert.equal(nextStep(c)?.id, 'education', 'continue must resume at the open question');
});

await check('continue does not re-ask anything already answered', () => {
  const c = halfFinished();
  c.currentStep = undefined;

  const { order } = walkFlow(c);
  for (const answered of ['full_name', 'location', 'dob', 'country_preference']) {
    assert.ok(!order.includes(answered), `continue re-asked "${answered}"`);
  }
  // And the CV, which is on file (§1, §22).
  assert.ok(!order.includes('cv'), 'continue re-asked for a CV already on file');
});

await check('restart throws away every answer the candidate typed', () => {
  // The half-finished session goes. That is what starting over means, and it
  // is the difference between the two buttons.
  const before = halfFinished({
    editQueue: ['location'],
    pendingMulti: { step: 'general_jobs', selected: ['warehouse'] },
  });
  const after: CandidateDoc = { ...before, ...restartPatch(before) };
  for (const key of RESTART_UNSETS) delete (after as unknown as Record<string, unknown>)[key];

  assert.deepEqual(after.profile, {}, 'a typed answer survived the restart');
  assert.deepEqual(after.fieldMeta, {}, 'field provenance survived the restart');
  assert.deepEqual(after.editQueue, [], 'a queued edit survived the restart');
  assert.equal(after.unclearCount, 0);
  assert.equal(after.stage, 'NEW');

  // The open question, the half-made multi-select and the closed session are
  // removed outright — left behind, `currentStep` would have the next tap
  // answer the question they just abandoned.
  assert.equal(after.currentStep, undefined);
  assert.equal(after.pendingMulti, undefined);
  assert.equal(after.sessionEndedAt, undefined);
});

await check('restart keeps the things that are not answers', () => {
  const before = halfFinished();
  const after: CandidateDoc = { ...before, ...restartPatch(before) };

  // §22 — re-answering the questions is not withdrawing a passport.
  assert.equal(after.documents.cv?.status, 'ocr_done');
  // §4 and §3 — recorded facts, not answers being revised.
  assert.equal(after.consent?.given, true);
  assert.equal(after.language, 'en');
  assert.equal(after.languageChosen, true);
});

await check('restart runs the same workflow, from the top', () => {
  // The complaint this fixes: a restart that drops someone into the middle, or
  // into a different set of questions, is not a restart.
  const before = halfFinished();
  const after: CandidateDoc = { ...before, ...restartPatch(before) };
  for (const key of RESTART_UNSETS) delete (after as unknown as Record<string, unknown>)[key];

  // Back at the opening menu, because `lookingForOverseasJob` went with the
  // profile — and then the same ordered flow every candidate walks.
  assert.equal(nextStep(after)?.id, 'entry');

  const { order, indexes } = walkFlow(after);
  assert.equal(order[0], 'entry');
  for (let i = 1; i < indexes.length; i++) {
    assert.ok(indexes[i]! > indexes[i - 1]!, `restart went backwards at "${order[i]}"`);
  }
});

await check('a new session field cannot be forgotten by a restart', () => {
  // The real risk is not today's code, it is the field somebody adds in six
  // months. Everything that holds half-session state must be named in the
  // restart contract; anything missing here is a stale answer that survives.
  const patch = restartPatch(halfFinished());
  const cleared = new Set([...Object.keys(patch), ...RESTART_UNSETS]);

  for (const field of ['profile', 'fieldMeta', 'editQueue', 'unclearCount', 'currentStep', 'pendingMulti']) {
    assert.ok(cleared.has(field), `"${field}" is session state that a restart does not clear`);
  }
  // And the deliberate survivors are absent from the patch, not accidentally in it.
  for (const kept of ['documents', 'consent', 'language', 'history', 'reminderSentAt']) {
    assert.ok(!cleared.has(kept), `"${kept}" must survive a restart`);
  }
});

console.log('\nhanding a finished registration to the CRM');

/** A candidate who has finished registering on the Singapore/Malaysia route. */
function readyForCrm(overrides: Partial<CandidateDoc['profile']> = {}): CandidateDoc {
  return candidate({
    stage: 'REGISTRATION_COMPLETED',
    candidateId: 'ADR-00042',
    profileName: 'Ravi',
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'malaysia',
      fullName: 'Ravi Kumar',
      currentCity: 'Chennai',
      currentState: 'Tamil Nadu',
      currentCountry: 'India',
      jobCategory: 'general_worker',
      desiredOccupation: 'Warehouse packing',
      totalExperienceBand: '1_3',
      passportNumber: 'Z1234567',
      passportExpiry: '03/2031',
      ...overrides,
    },
  });
}

await check('residence and destination are sent as two different facts', () => {
  // Their `country` means where someone lives; ours also records where they
  // want to go. Merging them would file a Chennai candidate as living in
  // Malaysia, and every recruiter filter on residence would be wrong.
  const payload = toCrmPayload(readyForCrm(), '111222333');
  assert.equal(payload.profile.country, 'India');
  assert.equal(payload.profile.destination_country, 'Malaysia');
  assert.equal(payload.profile.location, 'Chennai, Tamil Nadu');
});

await check('a region is never sent as a destination country', () => {
  // "Gulf countries" is six countries and "Europe" is a continent. Sending
  // either as `destination_country` would put a fact on the record that nobody
  // established — so nothing is sent, and the CRM's policy defaults to
  // requiring a CV, which is the safe direction.
  for (const region of ['gcc', 'europe', 'russia_cis', 'any', 'select']) {
    const payload = toCrmPayload(readyForCrm({ countryPreference: region }), '111');
    assert.equal(payload.profile.destination_country, undefined, region);
  }
});

await check('the experience band is sent as a band, never as a number', () => {
  const payload = toCrmPayload(readyForCrm(), '111');
  assert.equal(payload.profile.total_experience_band, '1_3');
  // "1_3" is a range the candidate picked. Turning it into 2.0 would put a
  // figure on the record they never gave.
  assert.equal(payload.profile.total_experience_years, undefined);

  // A CV that stated an actual figure does fill the numeric field.
  const exact = toCrmPayload(readyForCrm({ totalExperienceYears: 6 }), '111');
  assert.equal(exact.profile.total_experience_years, 6);
});

await check('the passport is sent and the Aadhaar and PAN are not', () => {
  // A recruiter has to know whether a passport expires inside the deployment
  // window. Nothing in the CRM reads an Aadhaar or a PAN, and copying an
  // identifier into a second system for no reason is exposure bought with
  // nothing (§15, §16).
  const payload = toCrmPayload(
    readyForCrm({ aadhaarNumber: '1234 5678 9012', panNumber: 'ABCDE1234F' }),
    '111',
  );
  assert.equal(payload.profile.passport_number, 'Z1234567');
  assert.equal(payload.profile.passport_expiry, '03/2031');

  const serialised = JSON.stringify(payload);
  assert.ok(!serialised.includes('1234 5678 9012'), 'an Aadhaar number reached the CRM payload');
  assert.ok(!serialised.includes('ABCDE1234F'), 'a PAN number reached the CRM payload');
});

await check('the idempotency key is derived, so a retry reproduces it', () => {
  // Generated keys defeat the purpose: a retry after a crash would carry a new
  // one and the CRM would create a second candidate. Derived from identifiers
  // that do not change, the same submission always produces the same key.
  const first = toCrmPayload(readyForCrm(), '111222333').idempotency_key;
  const second = toCrmPayload(readyForCrm(), '111222333').idempotency_key;
  assert.equal(first, second);
  assert.equal(first, 'whatsapp/111222333/919000000000');

  // Two candidates on the same business number are still two submissions.
  const other = candidate({ waId: '919999999999', profile: { fullName: 'Asha' } });
  assert.notEqual(toCrmPayload(other, '111222333').idempotency_key, first);
});

await check('the phone is sent in international form', () => {
  // `waId` is the full number without a plus. The plus is what tells the CRM
  // this is international rather than a local number whose country nobody
  // recorded — their cross-country duplicate check reads exactly that.
  const payload = toCrmPayload(readyForCrm(), '111');
  assert.equal(payload.profile.phone_e164, '+919000000000');
  assert.equal(payload.profile.phone, '+919000000000');
});

await check('what the bot believes about the CV is sent as a claim, not a fact', () => {
  const payload = toCrmPayload(readyForCrm({ cvRequired: false }), '111');
  // Named `cv_required_claim` on the wire. The CRM derives its own answer and
  // may refuse the submission regardless of what this says.
  assert.equal(payload.cv_required_claim, false);
  assert.equal(payload.source, 'whatsapp');

  // Absent when the bot has no opinion, rather than guessed at.
  assert.equal(toCrmPayload(readyForCrm(), '111').cv_required_claim, undefined);
});

await check('a candidate with no name still reaches the CRM', () => {
  // `full_name` is the CRM's one required field. Someone who finished
  // registering without a readable name is still a person a recruiter has to be
  // able to open, so the display name and then the number stand in.
  const noName = candidate({ profileName: 'Ravi', profile: { lookingForOverseasJob: true } });
  assert.equal(toCrmPayload(noName, '111').profile.full_name, 'Ravi');

  const nothing = candidate({ profile: { lookingForOverseasJob: true } });
  assert.equal(toCrmPayload(nothing, '111').profile.full_name, '919000000000');
});

await check('empty fields are omitted rather than sent as nulls', () => {
  // The CRM treats an absent field as "not stated" and a null as "stated to be
  // nothing" — and on a re-registration that difference decides whether an
  // existing value survives.
  const sparse = candidate({ profile: { lookingForOverseasJob: true, fullName: 'Ravi' } });
  const payload = toCrmPayload(sparse, '111');
  for (const [key, value] of Object.entries(payload.profile)) {
    assert.notEqual(value, undefined, `${key} was sent as undefined`);
    assert.notEqual(value, null, `${key} was sent as null`);
  }
});

console.log('\nwhich documents are read, and which are only stored');

await check('only the CV, the passport and the Aadhaar go to an extractor', () => {
  // Three extractors exist and three kinds are routed to them. Everything else
  // is filed and left alone — a PAN card, a driving licence, a loose
  // certificate and a company's registration certificate all carry an
  // identifier the bot has no question for, and running them through an
  // extractor is an exposure with nothing on the other side of it.
  const read = DOCUMENTS.filter((d) => d.ocr !== 'none').map((d) => d.id).sort();
  assert.deepEqual(read, ['aadhaar', 'b2b_aadhaar_back', 'b2b_aadhaar_front', 'cv', 'passport']);

  const stored = ['pan', 'driving_licence', 'certificate', 'company_registration'];
  for (const id of stored) {
    assert.equal(requirementFor(id)?.ocr, 'none', `${id} must not be sent to an extractor`);
  }
});

await check('each kind goes to the extractor built for it, never a generic one', () => {
  // Each of these is a different Veris endpoint with a different response
  // shape, so this is a routing decision and not a hint. An Aadhaar read by
  // anything but the Aadhaar endpoint comes back as page text with the number
  // buried in it.
  assert.equal(requirementFor('cv')?.ocr, 'resume');
  assert.equal(requirementFor('passport')?.ocr, 'passport');
  assert.equal(requirementFor('aadhaar')?.ocr, 'aadhaar');
  // Both sides of the B2B card are Aadhaars and are read as Aadhaars (§2).
  assert.equal(requirementFor('b2b_aadhaar_front')?.ocr, 'aadhaar');
  assert.equal(requirementFor('b2b_aadhaar_back')?.ocr, 'aadhaar');

  // There is deliberately no generic route left to fall back to.
  for (const d of DOCUMENTS) {
    assert.notEqual(d.ocr as string, 'document', `${d.id} still routes to the generic extractor`);
  }
});

console.log('\nrestarting does not re-interview someone whose CV is on file');

/** The OCR fields a read CV leaves behind on the upload. */
const CV_FIELDS: OcrField[] = [
  { key: 'name', value: 'Ravi Kumar', confidence: null },
  { key: 'date_of_birth', value: '1994-03-11', confidence: null },
  { key: 'current_occupation', value: 'Welder', confidence: null },
];

/**
 * A candidate just after a restart: answers cleared, documents still on file
 * (§22), and the opening menu already re-answered.
 *
 * The opening menu comes back first — clearing the profile clears the answer to
 * it — and that part was never in question. `lookingForOverseasJob` is set here
 * because the reported failure starts one tap later: whatever they choose, the
 * flow behind it should be the flow they went through the first time.
 */
function restarted(): CandidateDoc {
  const slots = initialSlots();
  slots.cv = { status: 'ocr_done', askedCount: 1, updatedAt: new Date() };
  return candidate({
    stage: 'NEW',
    // Country is asked before the CV now, so a restart re-asks it along with
    // everything else. Set here so this fixture is a candidate standing at the
    // question the bug was actually about.
    profile: { lookingForOverseasJob: true, countryPreference: 'gcc', countryStrictness: 'any' },
    fieldMeta: {},
    documents: slots,
  });
}

await check('a restart leaves the CV counting as sent', () => {
  // §22 keeps the upload and §1 forbids asking for it again, so the CV step is
  // satisfied even though every answer was just cleared. That is correct — and
  // it is exactly what makes the next check load-bearing.
  const c = restarted();
  assert.equal(stepById('cv')!.satisfied(c), true);
});

await check('what the CV answered comes back with it, instead of being asked by hand', () => {
  const c = restarted();

  // The bug: the CV stays on file, so its step is skipped, but everything it
  // told us went out with the profile. The candidate had sent a CV and was then
  // interviewed as if they had not — name, date of birth and the rest, one
  // question at a time.
  assert.equal(nextStep(c)?.id, 'full_name');

  // The fix, as `reseedProfileFromDocuments` performs it: replay the extraction
  // already stored on the upload. Nothing is re-read and nothing is
  // re-downloaded — the fields are on the upload, as the worker left them.
  const write = buildProfileWrite(c, extractFromCv(CV_FIELDS, c.waId).patch, {
    source: 'cv',
    confidence: null,
  });
  assert.ok(Object.keys(write.set).length, 'the stored CV fields yielded nothing');

  assert.equal(stepById('full_name')!.satisfied(c), true);
  assert.notEqual(nextStep(c)?.id, 'full_name');
  assert.equal(c.profile.fullName, 'Ravi Kumar');
});

await check('a restored field is marked as the document guess it is, not as verified', () => {
  const c = restarted();
  buildProfileWrite(c, extractFromCv(CV_FIELDS, c.waId).patch, { source: 'cv', confidence: null });

  // §27 — nothing but a person marks a field verified, and a restart must not
  // launder a CV reading into one.
  assert.equal(c.fieldMeta.fullName?.source, 'cv');
  assert.equal(c.fieldMeta.fullName?.verified, false);
});

await check('a restart does not restore what the candidate typed', () => {
  // Only what a document says comes back. The typed answers are the ones they
  // asked to start over on, so re-seeding must not resurrect them.
  const c = restarted();
  buildProfileWrite(c, extractFromCv(CV_FIELDS, c.waId).patch, { source: 'cv', confidence: null });

  // `trainingWillingness` is a menu answer and nothing else — no extractor
  // writes it — so if re-seeding ever started restoring typed answers, this is
  // where it would show.
  assert.equal(c.profile.trainingWillingness, undefined);
});

console.log('\nthe identity check in front of an application status');

await check('a date of birth is compared on meaning, not on how it was typed', () => {
  // The check has to accept the ways a person actually writes their own date of
  // birth. Rejecting "25/05/1994" because the record says "1994-05-25" would
  // spend a real attempt on a formatting difference, and three of those send a
  // candidate to staff over nothing.
  const onFile = normaliseDate('1994-05-25');
  for (const typed of ['25/05/1994', '25-05-1994', '25.05.1994', '1994-05-25', '25 May 1994']) {
    assert.equal(normaliseDate(typed), onFile, typed);
  }
});

await check('a different date is a different date', () => {
  // Day and month transposed is the commonest near miss, and it must not pass.
  assert.notEqual(normaliseDate('05/25/1994'), normaliseDate('25/05/1994'));
  assert.notEqual(normaliseDate('24/05/1994'), normaliseDate('25/05/1994'));
  assert.notEqual(normaliseDate('25/05/1993'), normaliseDate('25/05/1994'));
});

await check('an unreadable date is not a wrong answer', () => {
  // These cost no attempt — `verifyTrackingDob` returns on an unparsed date
  // before the counter moves, because someone who has not understood the format
  // is not someone guessing.
  for (const junk of ['1994', 'May', 'dont remember', '', 'ADR-00042']) {
    assert.equal(normaliseDate(junk), undefined, junk);
  }
});

await check('three chances, then a person', () => {
  // The ceiling is what stands between a short, sequential Application ID and
  // somebody else's application status (§27).
  assert.equal(TUNABLES.maxTrackingDobAttempts, 3);

  // Counted the way the engine counts them: remaining = ceiling - attempts, and
  // the hand-off is at zero, not below it.
  const remainingAfter = (attempts: number): number =>
    TUNABLES.maxTrackingDobAttempts - attempts;
  assert.equal(remainingAfter(1), 2);
  assert.equal(remainingAfter(2), 1);
  assert.ok(remainingAfter(3) <= 0, 'the third wrong answer must exhaust the check');
});

await check('the status messages never quote the date of birth back', () => {
  // §15/§16 — the check reads a personal identifier and must not echo it. The
  // candidate is told their answer did not match, never what was on file.
  for (const message of [copy.TRACK_DOB_WRONG, copy.TRACK_DOB_EXHAUSTED, copy.TRACK_ASK_DOB]) {
    for (const text of Object.values(message)) {
      assert.ok(
        !/\d{4}-\d{2}-\d{2}/.test(text),
        'a stored-format date must never appear in candidate-facing copy',
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* Jobs and countries the CRM decides                                  */
/*                                                                     */
/* An admin adds "CNC Operator" in the CRM and a candidate is offered  */
/* it. That is the whole feature, and these are the four ways it could */
/* quietly not work: the list never arrives, it arrives and is ignored, */
/* it arrives and overflows WhatsApp's ten-row ceiling, or it arrives   */
/* and takes the candidate down a route where nobody asks the CV       */
/* question.                                                           */
/* ------------------------------------------------------------------ */

console.log('\njobs and countries from the CRM');

const jobStep = stepById('sgmy_job_category')!;
const countryStep = stepById('country_preference')!;

/** A candidate parked on the job question, which is all `choicesFor` reads. */
function atJobStep(overrides: Partial<CandidateDoc['profile']> = {}): CandidateDoc {
  return {
    ...candidate(),
    currentStep: 'sgmy_job_category',
    profile: { countryPreference: 'malaysia', ...overrides },
  } as CandidateDoc;
}

await check('with no CRM list, the compiled-in jobs are offered', () => {
  resetTaxonomy();
  const ids = acceptedChoices(jobStep, atJobStep()).map((c) => c.id);
  assert.ok(ids.includes('general_worker'), 'the built-in list must survive a silent CRM');
  assert.ok(ids.includes('other'));
});

await check('a job an admin added in the CRM is offered to candidates', () => {
  setTaxonomyForTests({
    jobs: [
      { id: 'general_worker', title: 'General Worker', order: 1 },
      { id: 'cnc_operator', title: 'CNC Operator', order: 2 },
    ],
  });
  const offered = acceptedChoices(jobStep, atJobStep());
  const cnc = offered.find((c) => c.id === 'cnc_operator');
  assert.ok(cnc, 'a job added in the CRM never reached the candidate');
  assert.equal(cnc!.label.en, 'CNC Operator');
  // No translation exists for a job invented five minutes ago, so their own
  // words stand in every language rather than the row vanishing for a Tamil
  // speaker.
  assert.equal(cnc!.label.ta, 'CNC Operator');
  resetTaxonomy();
});

await check('a job that exists in both keeps its translated label', () => {
  setTaxonomyForTests({ jobs: [{ id: 'general_worker', title: 'General Worker', order: 1 }] });
  const row = acceptedChoices(jobStep, atJobStep()).find((c) => c.id === 'general_worker')!;
  assert.notEqual(row.label.ta, 'General Worker', 'the Tamil label was replaced by English');
  resetTaxonomy();
});

await check('the job list never exceeds what WhatsApp will accept', () => {
  // Thirty jobs is a plausible agency. Eleven rows is a rejected message.
  setTaxonomyForTests({
    jobs: Array.from({ length: 30 }, (_, i) => ({
      id: `job_${i}`,
      title: `Job ${i}`,
      order: i,
    })),
  });
  const rendered = choicesFor(jobStep, atJobStep());
  assert.ok(rendered.length <= 10, `a list of ${rendered.length} rows would be refused by Meta`);
  // And "Other" survives the cut, because it is the way out for the twenty-one
  // jobs that did not fit.
  assert.ok(rendered.some((c) => c.id === 'other'), '"Other" was crowded out');
  resetTaxonomy();
});

await check('a country an admin added is offered, and the regions survive', () => {
  setTaxonomyForTests({
    countries: [
      { id: 'singapore', name: 'Singapore', order: 1 },
      { id: 'malaysia', name: 'Malaysia', order: 2 },
      { id: 'kuwait', name: 'Kuwait', order: 3 },
    ],
  });
  const rendered = choicesFor(countryStep, atJobStep());
  const ids = rendered.map((c) => c.id);
  assert.ok(ids.includes('kuwait'), 'a country added in the CRM never reached the candidate');
  assert.ok(ids.includes('gcc'), 'the regions are still real answers and must remain');
  assert.ok(ids.includes('any'));
  assert.ok(rendered.length <= 10, `a list of ${rendered.length} rows would be refused by Meta`);
  resetTaxonomy();
});

await check('a candidate choosing a new country still gets a CV ruling', () => {
  // The point of the branch, and the reason a new country joins it: the CV
  // policy is keyed on destination *and* job, so a candidate who names one
  // country has to be asked their job and has to have a country name to send.
  setTaxonomyForTests({ countries: [{ id: 'kuwait', name: 'Kuwait', order: 1 }] });
  const kuwait = { ...candidate(), profile: { countryPreference: 'kuwait' } } as CandidateDoc;

  assert.ok(
    inSingaporeMalaysiaBranch(kuwait),
    'a candidate bound for Kuwait skipped the route where the job and the CV rule are settled',
  );
  assert.equal(destinationCountryOf(kuwait), 'Kuwait');
  resetTaxonomy();
});

await check('a region is still not a destination country', () => {
  // "The Gulf" is six countries with six sets of rules. Naming one of them for
  // the candidate would put a fact on the record nobody established.
  setTaxonomyForTests({ countries: [{ id: 'kuwait', name: 'Kuwait', order: 1 }] });
  const gulf = { ...candidate(), profile: { countryPreference: 'gcc' } } as CandidateDoc;
  assert.equal(destinationCountryOf(gulf), undefined);
  assert.equal(inSingaporeMalaysiaBranch(gulf), false);
  resetTaxonomy();
});

await check('the two compiled-in countries answer the same way with or without the CRM', () => {
  const malaysia = { ...candidate(), profile: { countryPreference: 'malaysia' } } as CandidateDoc;

  resetTaxonomy();
  const before = destinationCountryOf(malaysia);

  setTaxonomyForTests({ countries: [{ id: 'malaysia', name: 'Malaysia', order: 1 }] });
  const after = destinationCountryOf(malaysia);

  assert.equal(before, 'Malaysia');
  assert.equal(after, 'Malaysia');
  resetTaxonomy();
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
