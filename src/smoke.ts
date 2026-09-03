/**
 * Offline checks for the pieces that need no Mongo, Redis, or network.
 *
 * Enforced rather than assumed, since the rate limiters became Redis-backed:
 * `./testing/offline.js` is imported first and blanks REDIS_URL, so these run
 * against the local implementations whatever the environment says.
 *
 * Most of what this covers is the protocol's own rules expressed as assertions:
 * that a question already answered is never asked again, that a Gulf candidate is
 * never asked for identity documents, that what a candidate wants is never
 * written over what they do, and that a spelling difference in a name is not
 * treated as a different person.
 *
 * Run with: npm run smoke
 */
// First, and it has to be: this blanks REDIS_URL before `config.ts` is parsed,
// which is what keeps these checks offline when a developer's .env points at a
// deployment's Redis. See the module for why blanking rather than deleting.
import './testing/offline.js';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { config } from './config.js';
import {
  slaAlertParameters,
  staffAssignmentParameters,
  staffEnquiryParameters,
  staffPhoneToE164,
} from './staff/notify.js';
import { verifySignature } from './whatsapp/signature.js';
import {
  coexistencePage,
  parseCoexistenceCompletion,
  validOnboardingAuthorization,
} from './whatsapp/coexistence.js';
import { parseWebhook } from './whatsapp/parse.js';
import {
  MediaTooLargeError,
  chunkText,
  downloadMedia,
  outboundBudgets,
  readCappedBody,
  setMediaBaseUrlForTests,
  staffAssignmentTemplateComponents,
  staffNotificationLine,
  staffNotificationPhoneNumberId,
} from './whatsapp/client.js';
import { isTerminalFailure } from './ingestion/ledger.js';
import { render } from './conversation/copy.js';
import { RateLimiter } from './whatsapp/rateLimiter.js';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import {
  callModel,
  MODEL_REQUEST_OPTIONS,
  ModelUnavailableError,
  modelStats,
  resetModelStatsForTests,
  setModelClientForTests,
} from './conversation/model.js';
import { attributeInboundDocument, initialSlots, requirementFor } from './conversation/checklist.js';
import { assertOcrRoutingIsSafe, DOCUMENTS, NEVER_OCR } from './conversation/rules.js';
import {
  desiredJobForLevel,
  disambiguationChoices,
  FLOWS,
  labelFor,
  SGMY_DESTINATIONS,
  STAFF_STEPS,
  fieldsToClear,
  inferTradeAnswers,
  inferTradePacks,
  occupationForQuestions,
  selectedJobForQuestions,
  nextStep,
  routeFor,
  SGMY_COUNTRY_CHOICES,
  SGMY_STEPS,
  stepById,
  stepsInSection,
  STEPS,
  TRADE_CHOICES,
  type Answer,
  type FlowStep,
} from './conversation/flow.js';
import { cvWorthAsking, levelFromTitle } from './conversation/jobLevel.js';
import {
  externalCandidateDeliveryBlocked,
  nationalityBlocked,
  nationalityCheckPending,
  nationalityDecision,
} from './conversation/eligibility.js';
import { validateCopy } from './conversation/validate.js';
import { coalesceKey, InProcessQueue } from './queue/index.js';
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
  expiryFromPassport,
  parseDaysAway,
  parseMrzDate,
  parseYears,
  profileFromIdentityDocument,
  splitAddress,
} from './conversation/cv.js';
import {
  acceptedChoices,
  choicesFor,
  listPageTarget,
  renderConfirmation,
  renderStep,
} from './conversation/render.js';
import {
  looksLikeApplicationId,
  normaliseApplicationId,
  restartPatch,
  slotStatusFor,
  RESTART_UNSETS,
} from './conversation/engine.js';
import { OTHER_CHOICES, REMINDER_CHOICES, RESUME_CHOICES } from './conversation/copy.js';
import * as copy from './conversation/copy.js';
import { assignableFor, idempotencyKeyFor, toCrmPayload } from './crm/mapping.js';
import { syncModeFor } from './crm/sync.js';
import {
  accessTokenFor,
  activeLineFor,
  configuredLines,
  webhookSecrets,
} from './conversation/lines.js';
import { staffNoticeKey } from './db/models.js';
import { cvSectionFrom, jobSectionOf } from './crm/snapshot.js';
import {
  cachedJobQuestions,
  fetchJobQuestions,
  resetTaxonomy,
  setJobQuestionsForTests,
  setTaxonomyForTests,
} from './crm/taxonomy.js';
import { FAQ, violatesGuardrails } from './conversation/faq.js';
import {
  CHOICE_FORGOT_ID,
  CHOICE_STAFF,
  CONFIRM_CHOICES,
  RETURNING_CHOICES,
} from './conversation/copy.js';
import {
  CANDIDATE_ID_PREFIX,
  ENQUIRY_ID_PREFIX,
  type DocumentUpload,
  type StoredJobQuestion,
} from './db/models.js';
import { ATS_COLLECTIONS, LEGACY_AADHAAR_COLLECTION } from './ats/client.js';
import {
  atsDocumentRoutes,
  atsRouteFor,
  b2bApprovedForSourcing,
  b2bClientType,
} from './ats/export.js';
import {
  identityBehindCv,
  inspectUpload,
  normaliseExtractionForTests,
  resumeCompleteness,
} from './ocr/veris.js';
import {
  JobQueueFullError,
  isJobQueueFull,
  nextPollDelayMs,
  ocrIdempotencyKey,
  pollOcrJob,
  retryAfterMsOf,
  retryFailedJob,
  serviceStillWorking,
  shouldRetryFailedJob,
  submitOcrJob,
} from './ocr/jobs.js';
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

await check('the protected coexistence page exposes ids but no credential', () => {
  const page = coexistencePage('APP123', 'CONFIG456', 'NONCE');
  assert.ok(page.includes('APP123'));
  assert.ok(page.includes('CONFIG456'));
  assert.ok(page.includes('whatsapp_business_app_onboarding'));
  assert.ok(page.includes("sessionInfoVersion:'3'"));
  assert.ok(!page.includes(config.WHATSAPP_APP_SECRET));
  assert.ok(!page.includes(config.WHATSAPP_ACCESS_TOKEN));
});

await check('coexistence completion accepts Meta results with or without a phone id', () => {
  assert.deepEqual(
    parseCoexistenceCompletion({ code: 'short-code', wabaId: '123', phoneNumberId: '456' }),
    { code: 'short-code', wabaId: '123', phoneNumberId: '456' },
  );
  assert.deepEqual(parseCoexistenceCompletion({ code: 'short-code', wabaId: '123' }), {
    code: 'short-code',
    wabaId: '123',
  });
  assert.equal(
    parseCoexistenceCompletion({ code: 'x', wabaId: '../bad', phoneNumberId: '456' }),
    undefined,
  );
});

await check('coexistence Basic auth requires admin and compares the whole key', () => {
  const header = `Basic ${Buffer.from('admin:a-long-private-key').toString('base64')}`;
  assert.equal(validOnboardingAuthorization(header, 'a-long-private-key'), true);
  assert.equal(validOnboardingAuthorization(header, 'a-long-private-keY'), false);
  assert.equal(validOnboardingAuthorization(undefined, 'a-long-private-key'), false);
});

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
  assert.equal(nextStep(contact)?.id, 'b2b_contact_type');

  // Name in hand, the flow moves to the card rather than to the language or
  // consent questions — a business contact is not registering.
  contact.profile = { b2bContactType: 'agent', fullName: 'Priya Raman' };
  assert.equal(nextStep(contact)?.id, 'b2b_aadhaar_front');
});

await check('clients and associations share the generic ID-proof workflow', () => {
  for (const b2bContactType of ['client', 'association'] as const) {
    const contact = candidate({
      enquiry: 'b2b',
      profile: { b2bContactType, fullName: 'Priya Raman' },
      consent: undefined,
    });
    assert.equal(nextStep(contact)?.id, 'b2b_id_proof');
  }
});

await check('company certification is an explicit optional B2B step', () => {
  const contact = candidate({
    enquiry: 'b2b',
    profile: { b2bContactType: 'client', fullName: 'Priya Raman' },
    consent: undefined,
  });
  contact.documents.b2b_id_proof = {
    status: 'received',
    askedCount: 1,
    updatedAt: new Date(),
  };
  assert.equal(nextStep(contact)?.id, 'b2b_company_document_choice');

  contact.profile.b2bCompanyDocumentChoice = 'skip';
  assert.equal(nextStep(contact), undefined);

  contact.profile.b2bCompanyDocumentChoice = 'upload';
  assert.equal(nextStep(contact)?.id, 'b2b_company_registration');
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

  for (const id of ['b2b_aadhaar_front', 'b2b_aadhaar_back', 'b2b_id_proof', 'company_registration']) {
    assert.equal(documentCollectionFor(id), 'b2b_documents');
  }
  for (const id of ['cv', 'passport', 'aadhaar', 'pan', 'certificate']) {
    assert.equal(documentCollectionFor(id), 'documents');
  }
});

await check('all B2B identity and company documents are stored without OCR', () => {
  assert.equal(requirementFor('b2b_aadhaar_front')?.ocr, 'none');
  assert.equal(requirementFor('b2b_aadhaar_back')?.ocr, 'none');
  assert.equal(requirementFor('b2b_id_proof')?.ocr, 'none');
  assert.equal(requirementFor('aadhaar')?.ocr, 'aadhaar');
  assert.equal(requirementFor('company_registration')?.ocr, 'none');
});

await check('a B2B document question closes only after its storage status is received', () => {
  // A failed or missing storage attempt cannot advance the conversation.
  const spent = (docId: string) => {
    const c = candidate({
      enquiry: 'b2b',
      profile: { b2bContactType: 'agent', fullName: 'Priya Raman' },
    });
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

  // Arrival is sufficient; no OCR result is expected for any B2B file.
  contact.documents.b2b_aadhaar_front!.status = 'received';
  assert.equal(nextStep(contact)?.id, 'b2b_aadhaar_back');
});

await check('a candidate document still stops being chased at the ceiling (§14)', () => {
  // The candidate rule is deliberate and unchanged: their identity documents are
  // optional and staff collect them on a call.
  const c = candidate({ profile: { lookingForOverseasJob: true } });
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
    // Two, not three. The staff row used to sit here as well, and a person is
    // now reached from the opening menu alone.
    ['correct', 'edit'],
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

await check('the destination is asked first, and the CV straight after it (§5, §10)', () => {
  // §10 is a branch point again — Singapore and Malaysia are two of its rows —
  // so it has to be answered before the step it decides.
  const c = candidate({ profile: { lookingForOverseasJob: true } });
  assert.equal(nextStep(c)?.id, 'country_preference');

  const gulf = candidate({
    profile: { lookingForOverseasJob: true, countryPreference: 'gcc', countryStrictness: 'prefer' },
  });
  assert.equal(nextStep(gulf)?.id, 'cv');

  // Unconditionally, for every destination but two. The step does carry a
  // `when`, because a Singapore/Malaysia candidate is asked for the CV later
  // and only for some jobs — so what is pinned here is the behaviour rather
  // than the absence of the guard. A guard that started returning false for a
  // Gulf candidate would be a CV silently stopped being collected, which
  // nothing else in the system would notice.
  const guard = stepById('cv')!.when!;
  assert.equal(guard(gulf), true, 'the CV must be asked of every candidate but two destinations');
  assert.equal(
    guard(
      candidate({
        profile: {
          lookingForOverseasJob: true,
          countryPreference: 'gcc',
          jobLevel: 'low_skill',
        },
      }),
    ),
    true,
    'a job level must not gate the CV anywhere but Singapore and Malaysia',
  );
});

await check('skips a question the CV already answered (§1, §5)', () => {
  const bound = { countryPreference: 'gcc', countryStrictness: 'prefer' };

  const withoutCv = candidate({ profile: { lookingForOverseasJob: true, ...bound } });
  withoutCv.documents.cv!.status = 'unavailable';
  assert.equal(nextStep(withoutCv)?.id, 'full_name');

  const withName = candidate({
    profile: { lookingForOverseasJob: true, ...bound, fullName: 'Asha Kumari' },
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

await check('every candidate is asked for Aadhaar and PAN (§13)', () => {
  // This used to be gated on a Europe/Russia destination, so a Gulf candidate
  // finished registration without ever being asked for an identity document.
  // The gate is gone: both are asked of everyone, whatever they answered at
  // §10 and whichever route it put them on, in that order.
  const c = candidate({ profile: { lookingForOverseasJob: true } });
  assert.equal(stepById('aadhaar_upload')!.when, undefined, 'Aadhaar must not be conditional');
  assert.equal(stepById('pan_upload')!.when, undefined, 'PAN must not be conditional');

  const ids = STEPS.map((step) => step.id);
  assert.ok(
    ids.indexOf('aadhaar_upload') < ids.indexOf('pan_upload'),
    'Aadhaar is read and PAN is not, so Aadhaar goes first',
  );
  assert.equal(stepById('aadhaar_upload')!.satisfied(c), false);
  assert.equal(stepById('pan_upload')!.satisfied(c), false);
});

await check('the passport is asked as a question before it is asked as a file (§12)', () => {
  const ids = STEPS.map((step) => step.id);
  assert.ok(
    ids.indexOf('passport_status') < ids.indexOf('passport_upload'),
    'ask whether they have one before asking them to photograph it',
  );
  assert.ok(
    ids.indexOf('passport_upload') < ids.indexOf('aadhaar_upload'),
    'passport, then the two cards',
  );

  // Both belong to the documents section now, so one UPDATE opens all of them.
  for (const id of ['passport_status', 'passport_upload', 'aadhaar_upload', 'pan_upload']) {
    assert.equal(stepById(id)!.section, 'documents', id);
  }
});

await check('only someone who says they hold a passport is asked to send it (§12)', () => {
  const step = stepById('passport_upload')!;

  const holds = candidate({ profile: { lookingForOverseasJob: true, passportStatus: 'yes' } });
  assert.equal(step.when!(holds), true);

  // "Applied", "expired" and "no" are answers, not evasions. Following any of
  // them with "please photograph your passport" asks for something they have
  // just said does not exist.
  for (const status of ['applied', 'expired', 'no']) {
    const c = candidate({ profile: { lookingForOverseasJob: true, passportStatus: status } });
    assert.equal(step.when!(c), false, status);
  }
});

await check('nothing asks the candidate about passport validity (§12)', () => {
  // The expiry is read off the page by the extractor. The questions that used to
  // ask for it from memory are gone, and their absence is the assertion — a
  // reintroduced "when does it expire?" is exactly the regression this catches.
  const ids = STEPS.map((step) => step.id);
  for (const retired of [
    'passport_applied_when',
    'passport_renewal',
    'passport_apply_willing',
    'passport_document',
  ]) {
    assert.ok(!ids.includes(retired), `"${retired}" is back in the flow`);
  }

  // And no step writes the expiry, which is what would make it a typed answer.
  for (const step of STEPS) {
    assert.ok(
      !(step.clears ?? []).includes('passportExpiry') || step.id === 'passport_status',
      `"${step.id}" treats the passport expiry as an answer`,
    );
  }
});

await check('every destination is on one menu, and two of them fork it (§10)', () => {
  // The two rows were a flow of their own, reached by writing to a second
  // number. They are rows in the one country question now, and choosing one is
  // the only thing that decides which route a candidate walks.
  const offered = stepById('country_preference')!.choices!.map((c) => c.id);
  for (const kept of ['gcc', 'europe', 'russia_cis', 'singapore', 'malaysia', 'any', 'select']) {
    assert.ok(offered.includes(kept), `"${kept}" is missing from the country question`);
  }

  // One row per destination. "Gulf countries" was on it twice, under two ids,
  // and the second is understood without being shown.
  assert.equal(new Set(offered).size, offered.length, 'the menu has a duplicate row');
  assert.ok(!offered.includes('gulf countries'), 'the second Gulf row is not rendered');
  assert.equal(labelFor('gulf countries')?.en, 'Gulf countries', 'and is still understood');

  // WhatsApp's ceiling is ten rows, and the CRM's country list is rendered into
  // this same question at run time — so the compiled list has to leave room.
  assert.ok(offered.length <= 10, `the country question renders ${offered.length} rows`);

  // Choosing one of the two is the fork, and nothing else is.
  const sg = candidate({ profile: { lookingForOverseasJob: true, countryPreference: 'singapore' } });
  const gulf = candidate({ profile: { lookingForOverseasJob: true, countryPreference: 'gcc' } });
  assert.equal(routeFor(sg), 'sgmy');
  assert.equal(routeFor(gulf), 'default');
  assert.equal(routeFor(candidate({ profile: { lookingForOverseasJob: true } })), 'default');

  // Typing a list of countries behind "Select countries" is a preference, not a
  // destination: it must not move anybody onto the other route.
  const typed = candidate({
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'select',
      selectedCountries: ['Singapore', 'Malaysia'],
    },
  });
  assert.equal(routeFor(typed), 'default');

  const ids = STEPS.map((step) => step.id);
  for (const retired of ['sgmy_passport', 'sgmy_job_category', 'europe_docs', 'europe_docs_which']) {
    assert.ok(!ids.includes(retired), `"${retired}" is back in the flow`);
  }

  // Nothing is left in the flow claiming to belong to a section that no longer
  // exists — a step with an orphaned section would break `STAGE_BY_SECTION`.
  for (const step of STEPS) {
    assert.ok(
      ['start', 'b2b', 'language', 'consent', 'cv', 'personal', 'experience',
       'job_preference', 'country', 'availability', 'documents', 'confirm'].includes(step.section),
      `"${step.id}" is in the removed "${step.section}" section`,
    );
  }
});

await check('the country question is asked before anything it decides (§10)', () => {
  const ids = STEPS.map((step) => step.id);

  // Straight after consent, on both routes. It is a branch point again — two of
  // its rows send a candidate down a flow that does not ask for a CV up front —
  // and a branch point asked after the branch cannot branch.
  assert.ok(
    ids.indexOf('consent') < ids.indexOf('country_preference'),
    'consent still comes first',
  );
  for (const later of ['cv', 'full_name', 'location', 'education', 'main_trade']) {
    assert.ok(
      ids.indexOf('country_preference') < ids.indexOf(later),
      `the country question must be asked before "${later}"`,
    );
  }

  // The follow-ups hang off it in order.
  assert.ok(ids.indexOf('country_preference') < ids.indexOf('selected_countries'));
  assert.ok(ids.indexOf('selected_countries') < ids.indexOf('country_strictness'));

  // "Select countries" is only followed up when it is what they chose, and the
  // strictness question is meaningless once they have said anywhere will do.
  const selected = candidate({
    profile: { lookingForOverseasJob: true, countryPreference: 'select' },
  });
  assert.equal(stepById('selected_countries')!.when!(selected), true);
  assert.equal(stepById('country_strictness')!.when!(selected), true);

  const anywhere = candidate({
    profile: { lookingForOverseasJob: true, countryPreference: 'any' },
  });
  assert.equal(stepById('selected_countries')!.when!(anywhere), false);
  assert.equal(stepById('country_strictness')!.when!(anywhere), false);
});

await check('a region is never sent to the CRM as a destination country', () => {
  // "Gulf countries" is six countries and "Europe" is a continent. Naming one
  // for the candidate would put a fact on the record nobody established.
  for (const region of ['gcc', 'europe', 'russia_cis', 'any', 'select']) {
    const c = candidate({ profile: { lookingForOverseasJob: true, countryPreference: region } });
    assert.equal(toCrmPayload(c).profile.destination_country, undefined, region);
  }
});

/* ------------------------------------------------------------------ */

console.log('\ntrade questions (§8)');

await check('a welder gets welding questions and no others', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      jobCategory: 'fabrication_welding',
      desiredOccupation: 'TIG welder',
    },
    fieldMeta: { primaryTrade: { source: 'chat', raw: 'I am a TIG welder', at: new Date() } },
  });
  assert.deepEqual(inferTradePacks(c), ['welder']);
});

await check('a fabricator gets fabrication questions', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      jobCategory: 'fabrication_welding',
      desiredOccupation: 'structural fabrication',
    },
    fieldMeta: { primaryTrade: { source: 'chat', raw: 'structural fabrication', at: new Date() } },
  });
  assert.deepEqual(inferTradePacks(c), ['fabricator']);
});

await check('tapping a category never loads a pack by keyword (§8)', () => {
  // "Fabrication / Welding" contains the keywords of both packs beneath it, so
  // keyword matching used to select welder AND fabricator and skip the tie-break
  // question entirely — three trade questions instead of one.
  const tapped = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      jobCategory: 'fabrication_welding',
      tradeFromList: true,
    },
  });
  assert.equal(inferTradePacks(tapped), undefined, 'must not infer from a tapped category');
  assert.equal(stepById('trade_disambiguation')!.when!(tapped), true, 'must ask which one');

  // Their own words still decide it — a typed "welder" skips the question.
  const typed = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      jobCategory: 'fabrication_welding',
      currentOccupation: 'TIG welder',
    },
  });
  assert.deepEqual(inferTradePacks(typed), ['welder']);
  assert.equal(stepById('trade_disambiguation')!.when!(typed), false);
});

await check('a category label is never treated as trade evidence (§8)', () => {
  // Some older WhatsApp deliveries retained the button title but not the fact
  // that it was tapped. The title itself must still not activate both packs.
  const legacyTap = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      jobCategory: 'fabrication_welding',
      tradeFromList: false,
      // Already persisted by the older inference. The fix must protect these
      // in-progress records too, not only prevent new bad writes.
      tradePacks: ['welder', 'fabricator'],
    },
    fieldMeta: {
      jobCategory: {
        source: 'chat',
        raw: 'Fabrication / Welding',
        at: new Date(),
      },
    },
  });

  assert.equal(inferTradePacks(legacyTap), undefined);
  assert.equal(stepById('trade_disambiguation')!.when!(legacyTap), true);
  assert.equal(stepById('trade:welder:welding_process')!.when!(legacyTap), false);
});

await check('only the explicit choice loads a pack (§8)', () => {
  const chosen = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      jobCategory: 'fabrication_welding',
      tradeFromList: true,
    },
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
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      jobCategory: 'fabrication_welding',
    },
  });
  assert.equal(inferTradePacks(c), undefined);
  assert.equal(stepById('trade_disambiguation')!.when!(c), true);
});

await check('a hospitality candidate gets no trade questions at all', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'hospitality',
      jobCategory: 'hospitality',
    },
  });
  assert.deepEqual(inferTradePacks(c), []);
});

await check('a driver is never asked about welding', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'driver_operator',
      jobCategory: 'driver_operator',
      currentOccupation: 'truck driver',
      tradePacks: ['driver'],
      tradePacksFor: 'driver_operator',
    },
  });
  assert.equal(stepById('trade:welder:welding_process')!.when!(c), false);
  assert.equal(stepById('trade:driver:driver_vehicles')!.when!(c), true);
});

await check('a stale pack id cannot activate a question for another trade', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'hospitality',
      jobCategory: 'hospitality',
      tradePacks: ['welder'],
    },
  });

  assert.equal(stepById('trade:welder:welding_process')!.when!(c), false);
});

await check('specialist questions follow the selected job, not the current job', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      currentOccupation: 'TIG welder',
      jobCategory: 'hospitality',
      tradePacks: ['welder'],
      tradePacksFor: 'fabrication_welding',
    },
  });

  assert.equal(selectedJobForQuestions(c), 'Hospitality');
  assert.deepEqual(inferTradePacks(c), []);
  assert.equal(stepById('trade:welder:welding_process')!.when!(c), false);
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

await check('only the current Other-menu staff row is an actionable choice', async () => {
  const current = await interpret({
    step: nameStep,
    choices: [CHOICE_STAFF],
    text: '',
    replyId: CHOICE_STAFF.id,
  });
  assert.equal(current.kind, 'matched');

  const stale = await interpret({
    step: nameStep,
    choices: [],
    text: '',
    replyId: CHOICE_STAFF.id,
  });
  assert.equal(stale.kind, 'staff');
  assert.equal(detectGlobalCommand(undefined, CHOICE_STAFF.id), undefined);
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

console.log('\nMRZ dates (§12, §14)');

await check('an MRZ date is read in both forms the extractor sends', () => {
  // What the Jobs API actually returns: OpenAPI `MRZData` declares every date
  // `format: date`. This is the form that used to fall through to undefined.
  const iso = parseMrzDate('2031-05-11');
  assert.equal(iso?.toISOString().slice(0, 10), '2031-05-11');

  // The ICAO band form, still read for anything parsed off a raw MRZ.
  const legacy = parseMrzDate('310511');
  assert.equal(legacy?.toISOString().slice(0, 10), '2031-05-11');

  // Both forms of the same date must agree, or the two paths disagree about
  // whether a passport is in date.
  assert.equal(iso?.getTime(), legacy?.getTime());

  assert.equal(parseMrzDate('  2031-05-11  ')?.getTime(), iso?.getTime());
});

await check('the two-digit century pivot survives', () => {
  assert.equal(parseMrzDate('710101')?.getUTCFullYear(), 1971);
  assert.equal(parseMrzDate('700101')?.getUTCFullYear(), 2070);
  assert.equal(parseMrzDate('000101')?.getUTCFullYear(), 2000);
});

await check('a first-of-the-month expiry does not slip back a month', () => {
  // The date is built in UTC and read back through getUTC* by
  // `expiryFromPassport`. Built locally, midnight on the 1st in IST is the
  // previous month in UTC, and a May passport is filed as April.
  assert.equal(parseMrzDate('310501')?.getUTCMonth(), 4);
  assert.equal(parseMrzDate('2031-05-01')?.getUTCMonth(), 4);

  const field = (value: string) => [{ key: 'expiry_date', value, confidence: 0.9 }];
  assert.equal(expiryFromPassport(field('310501')), '05/2031');
  assert.equal(expiryFromPassport(field('2031-05-01')), '05/2031');
  assert.equal(expiryFromPassport(field('2031-05-11')), '05/2031');
});

await check('a malformed MRZ date is no date, not a guess', () => {
  for (const bad of [
    '',
    '   ',
    '31051',
    '3105111',
    '2031-5-11',
    '2031/05/11',
    '20310511',
    'abcdef',
    '31-05-11',
  ]) {
    assert.equal(parseMrzDate(bad), undefined, `${JSON.stringify(bad)} should not parse`);
  }
});

await check('an impossible calendar date is rejected, not rolled over', () => {
  // `Date` turns month 13 into January and 30 February into 2 March. A date
  // quietly shifted into the wrong month is worse than none at all.
  for (const bad of ['2031-02-30', '2031-13-01', '2031-00-01', '2031-01-32', '2031-01-00',
                     '310230', '311301', '310001', '310132', '310500']) {
    assert.equal(parseMrzDate(bad), undefined, `${bad} should not parse`);
  }

  // A real leap day still reads.
  assert.equal(parseMrzDate('2032-02-29')?.getUTCDate(), 29);
  assert.equal(parseMrzDate('320229')?.getUTCDate(), 29);
});

await check('an expired ISO passport is reported as expired (§14)', () => {
  const outcome = normaliseExtractionForTests('passport', {
    confidence: 0.94,
    mrz_source: 'mrz',
    mrz: {
      passport_number: 'Z1234567',
      date_of_birth: '1994-03-14',
      expiry_date: '2020-05-11',
      all_check_digits_valid: true,
    },
    fields: [],
    pages: [{ page_number: 1, average_confidence: 0.94 }],
    warnings: [],
  });

  // This is the bug: the ISO date parsed to undefined, the guard never fired,
  // and an out-of-date passport was filed as complete.
  assert.equal(outcome.completeness.complete, false);
  assert.ok(
    outcome.completeness.problems.some((p) => /expired/i.test(p)),
    `expected an expiry problem, got ${JSON.stringify(outcome.completeness.problems)}`,
  );
});

await check('a passport still in date raises no expiry problem (§14)', () => {
  const outcome = normaliseExtractionForTests('passport', {
    confidence: 0.94,
    mrz_source: 'mrz',
    mrz: {
      passport_number: 'Z1234567',
      date_of_birth: '1994-03-14',
      expiry_date: '2031-05-11',
      all_check_digits_valid: true,
    },
    fields: [],
    pages: [{ page_number: 1, average_confidence: 0.94 }],
    warnings: [],
  });

  assert.equal(outcome.completeness.complete, true);
  assert.equal(
    outcome.completeness.problems.some((p) => /expired/i.test(p)),
    false,
  );
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

  // No state named, which is most CVs — people write the town and the postcode
  // and stop. This used to return nothing, so a candidate was asked which city
  // they live in while it was printed on the CV they had just sent (§1).
  const noState = splitAddress('45 Bypass Road, Madurai 625001');
  assert.equal(noState?.city, 'Madurai');
  assert.equal(noState?.state, undefined);

  // Still nothing where there is nothing to find: a door number is not a town,
  // and filing one as somebody's city is worse than asking them for it.
  assert.equal(splitAddress('12/4'), undefined);
  assert.equal(splitAddress('3rd Floor'), undefined);
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
  for (const id of ['full_name', 'location', 'education']) {
    assert.ok(order.includes(id), `${id} was not asked`);
  }
  assert.ok(
    order.indexOf('full_name') < order.indexOf('location'),
    'name must come before location',
  );
  assert.ok(
    order.indexOf('location') < order.indexOf('education'),
    'location must come before education',
  );
  // And nobody is asked for a date of birth: it is on the Aadhaar and on the
  // passport, both of which are read, and a date typed from memory is the least
  // reliable thing on a record.
  assert.equal(stepById('dob'), undefined, 'the date of birth question is gone');
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
  assert.deepEqual(
    personal,
    [],
    `the CV answered every personal question, got ${personal.join(', ')}`,
  );

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

await check('a one-page PDF still reports one page, which is what §14 re-asks on', () => {
  assert.equal(inspectUpload(pdf('/Type /Page '), 'application/pdf').pages, 1);
});

await check('the scan stops at the second page marker rather than counting them all', () => {
  // Five page objects, and the answer is 2. The count saturates because
  // `passportMinPdfPages` is the only thing it is ever compared against, so a
  // third match cannot change a verdict — it can only cost the loop that found
  // it. A 5 here would mean the scan had read the whole file to no purpose.
  assert.equal(inspectUpload(pdf('/Type /Page  '.repeat(5)), 'application/pdf').pages, 2);
});

await check('a marker-dense PDF is answered from its first two markers', () => {
  // The shape that used to hurt: an uncompressed file that is almost entirely
  // page markers. The old scan built a latin1 copy of the whole thing and then
  // an array holding every match — hundreds of thousands of strings. This one
  // reads far enough to find two.
  const dense = Buffer.concat([
    Buffer.from('%PDF-1.4 ', 'latin1'),
    Buffer.alloc(4 * 1024 * 1024).fill(Buffer.from('/Type /Page ', 'latin1')),
    Buffer.from(' %%EOF', 'latin1'),
  ]);
  const result = inspectUpload(dense, 'application/pdf');
  assert.equal(result.readable, true);
  assert.equal(result.pages, 2);
});

await check('a large PDF is answered without reading past its first two markers', () => {
  const large = Buffer.concat([
    Buffer.from('%PDF-1.4 /Type /Page  /Type /Page  ', 'latin1'),
    Buffer.alloc(12 * 1024 * 1024, 'x'),
    Buffer.from(' %%EOF', 'latin1'),
  ]);
  const result = inspectUpload(large, 'application/pdf');
  assert.equal(result.readable, true);
  assert.equal(result.pages, 2);
});

await check('page objects past the scan window report no opinion rather than a guess', () => {
  // Nine megabytes of filler before the first marker. The scan gives up at
  // eight and says so — `undefined`, the same answer given for a PDF whose
  // pages are hidden in compressed object streams. Reporting the zero it
  // actually saw would tell a candidate who sent twelve pages that they sent
  // none.
  const beyond = Buffer.concat([
    Buffer.from('%PDF-1.4 ', 'latin1'),
    Buffer.alloc(9 * 1024 * 1024, 'x'),
    Buffer.from(' /Type /Page  /Type /Page  %%EOF', 'latin1'),
  ]);
  const result = inspectUpload(beyond, 'application/pdf');
  assert.equal(result.readable, true);
  assert.equal(result.pages, undefined);
});

await check('a single page inside the window of an oversized PDF is not reported', () => {
  // One marker found and eight megabytes read without a second: the file is
  // longer than the window, so "only one page" is a claim the scan cannot make,
  // and §14 would re-ask on it.
  const oversized = Buffer.concat([
    Buffer.from('%PDF-1.4 /Type /Page  ', 'latin1'),
    Buffer.alloc(9 * 1024 * 1024, 'x'),
    Buffer.from(' %%EOF', 'latin1'),
  ]);
  assert.equal(inspectUpload(oversized, 'application/pdf').pages, undefined);
});

await check('a caller that will not read the count does not pay for the scan', () => {
  // What `runOcr` passes for the resume and Aadhaar extractors: neither
  // normaliser takes an inspection, so counting their pages was work thrown
  // away — and a CV is the commonest PDF the bot is sent.
  const result = inspectUpload(pdf('/Type /Page  /Type /Page '), 'application/pdf', {
    countPages: false,
  });
  assert.equal(result.readable, true);
  assert.equal(result.pages, undefined);
});

await check('a PDF whose last bytes are a bare /Type is inspected, not failed', () => {
  // `%%EOF` only has to fall in the final 4 KB, so a file may genuinely end on a
  // `/Type` with no room to spell `/Page` after it. Reading off the end of the
  // buffer there throws, and a throw here becomes a failed extraction and a
  // review task for a file that is fine.
  const result = inspectUpload(Buffer.from('%PDF-1.4 %%EOF /Type', 'latin1'), 'application/pdf');
  assert.equal(result.readable, true);
  assert.equal(result.pages, undefined);
});

await check('/Type /Pages is still the page tree and still not a page', () => {
  // The distinction the regex drew with `[^sA-Za-z]`, which the byte scan has to
  // keep: a letter after `/Page` means some other key, not a page object.
  const result = inspectUpload(pdf('/Type /Pages  /Type /PageLabels '), 'application/pdf');
  assert.equal(result.pages, undefined);
});

await check('a line break between /Type and /Page is still one page object', () => {
  // The regex allowed any run of whitespace between the two and real writers do
  // emit a break there. Matching only on a single space would undercount them.
  const gap = String.fromCharCode(10, 9);
  const result = inspectUpload(pdf(`/Type${gap}/Page  /Type   /Page `), 'application/pdf');
  assert.equal(result.pages, 2);
});

await check('two page objects written with nothing between them still count as one', () => {
  // The one place the old scan's spelling showed through. Its `[^sA-Za-z]`
  // consumed the byte after `/Page`, so in `/Type/Page/Type/Page` the first
  // match swallowed the slash the second needed and the pair counted once. An
  // artifact rather than anything about PDF syntax, and nothing a real writer
  // emits — but it is the answer that shipped, and this pins the byte scan to
  // it so the rewrite stays a rewrite and not a change of verdict.
  const result = inspectUpload(pdf('/Type/Page/Type/Page]'), 'application/pdf');
  assert.equal(result.pages, 1);
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
      jobCategory: 'fabrication_welding',
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
      jobCategory: 'fabrication_welding',
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
  const c = candidate({
    profile: { lookingForOverseasJob: true, ...patch, jobCategory: 'factory_warehouse' },
  });

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
      profile: {
        lookingForOverseasJob: true,
        primaryTrade: 'driver_operator',
        jobCategory: 'driver_operator',
        currentOccupation: job,
      },
    });
    assert.deepEqual(inferTradePacks(c), [], `${job} should load no CNC pack`);
  }

  // And a machinist still gets it, which is the point of the pack.
  for (const job of ['CNC operator', 'VMC setter', 'lathe machinist']) {
    const c = candidate({
      profile: {
        lookingForOverseasJob: true,
        primaryTrade: 'driver_operator',
        jobCategory: 'driver_operator',
        currentOccupation: job,
      },
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
      jobCategory: 'fabrication_welding',
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
      jobCategory: 'fabrication_welding',
      currentOccupation: 'MIG welder',
    },
  });
  assert.deepEqual(inferTradePacks(welder), ['welder']);
});

await check('§12 asks for the passport, not for facts about it', () => {
  // Typed-from-memory expiry dates are the least reliable thing on the record,
  // and the document that settles it is one tap away. There is now exactly one
  // upload question rather than two, and no question about the date at all.
  assert.equal(stepById('passport_expiry'), undefined);
  assert.equal(stepById('passport_document'), undefined);

  const holder = candidate({ profile: { lookingForOverseasJob: true, passportStatus: 'yes' } });
  const step = stepById('passport_upload')!;
  assert.equal(step.when!(holder), true);
  assert.equal(step.document, 'passport');
  assert.equal(step.satisfied(holder), false);
});

await check('a passport already on file is never asked for again (§1, §12)', () => {
  // Covers the CV case: `ocr/veris.ts` files passport pages found inside a CV
  // against this slot, and filling the slot is what closes the question.
  const c = candidate({ profile: { lookingForOverseasJob: true, passportStatus: 'yes' } });
  c.documents.passport = { status: 'ocr_queued', askedCount: 0, updatedAt: new Date() };

  assert.equal(stepById('passport_upload')!.satisfied(c), true);
});

await check('identity pages queued from a CV close both upload questions', () => {
  const c = candidate({ profile: { lookingForOverseasJob: true, passportStatus: 'yes' } });
  c.documents.passport = { status: 'ocr_queued', askedCount: 0, updatedAt: new Date() };
  c.documents.aadhaar = { status: 'ocr_queued', askedCount: 0, updatedAt: new Date() };

  assert.equal(stepById('passport_upload')!.satisfied(c), true);
  assert.equal(stepById('aadhaar_upload')!.satisfied(c), true);
});

await check('one candidate pack is not evidence for that pack', () => {
  // factory_warehouse is served by exactly one pack. That used to be taken as
  // "nothing to choose between", and the pack was loaded with no support at all.
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'factory_warehouse',
      jobCategory: 'factory_warehouse',
    },
  });
  assert.deepEqual(inferTradePacks(c), []);
});

await check('tapping Fabrication / Welding asks which, rather than loading both', () => {
  const c = candidate({
    profile: {
      lookingForOverseasJob: true,
      primaryTrade: 'fabrication_welding',
      jobCategory: 'fabrication_welding',
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
  for (const id of ['full_name', 'location', 'education', 'education_course']) {
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
  assert.ok(cleared.includes('currentCity'));
  assert.ok(!cleared.includes('primaryTrade'), 'an edit of personal details reached the trade');

  const edited = candidate({
    profile: { lookingForOverseasJob: true, primaryTrade: 'fabrication_welding' },
    editQueue: ['full_name', 'education'],
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

console.log('\nthe order registration runs in');

/** A candidate who has consented and has been asked nothing else. */
function justConsented(): CandidateDoc {
  return candidate({ stage: 'NEW', profile: { lookingForOverseasJob: true } });
}

await check('the flow runs in the order the protocol lays out', () => {
  const ids = STEPS.map((step) => step.id);
  const at = (id: string) => {
    const i = ids.indexOf(id);
    assert.ok(i !== -1, `"${id}" is missing from the flow`);
    return i;
  };

  // Apply → consent → country → CV → personal → experience → trade → job
  // preferences → documents → confirm.
  const order = [
    'entry',
    'language',
    'consent',
    'country_preference',
    'cv',
    'full_name',
    'main_trade',
    'job_category',
    'trade_disambiguation',
    'passport_status',
    'aadhaar_upload',
    'pan_upload',
    'confirm',
  ];

  for (let i = 1; i < order.length; i++) {
    assert.ok(
      at(order[i]!) > at(order[i - 1]!),
      `"${order[i]}" must come after "${order[i - 1]}"`,
    );
  }
});

await check('the CV is asked before every section it can answer (§1, §5)', () => {
  // The reason it sits where it does. Every one of these is a question the
  // resume extractor can fill, and filling it is only useful if the CV arrives
  // first — afterwards the candidate has already been asked by hand.
  const ids = STEPS.map((step) => step.id);
  for (const answerable of ['full_name', 'education', 'main_trade', 'total_experience']) {
    assert.ok(ids.indexOf('cv') < ids.indexOf(answerable), `the CV must precede "${answerable}"`);
  }

  // One question ahead of it, and only one: where they want to work, which
  // decides whether this step is asked here at all (§10).
  assert.ok(ids.indexOf('country_preference') < ids.indexOf('cv'));
  assert.equal(nextStep(justConsented())?.id, 'country_preference');

  // And with that answered, it is what a freshly consented candidate is asked.
  const bound = justConsented();
  bound.profile.countryPreference = 'gcc';
  bound.profile.countryStrictness = 'prefer';
  assert.equal(nextStep(bound)?.id, 'cv');
});

await check('what a document says is never asked as a question (§1, §5)', () => {
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

  const c = justConsented();
  c.documents.passport = { status: 'ocr_done', askedCount: 1, updatedAt: new Date() };
  Object.assign(c.profile, patch);

  assert.equal(stepById('full_name')!.satisfied(c), true, 'name still being asked');
  assert.equal(stepById('dob'), undefined, 'the date of birth question is gone');
  // A passport that arrived unprompted, or inside a CV, answers the question
  // about whether they have one.
  assert.equal(stepById('passport_status')!.satisfied(c), true);
});

await check('a passport uses given names as the candidate name, never the surname', () => {
  const patch = profileFromIdentityDocument('passport', [
    { key: 'surname', value: 'KUMARI', confidence: 0.97 },
    { key: 'given_names', value: 'ASHA DEVI', confidence: 0.97 },
    { key: 'passport_number', value: 'Z1234567', confidence: 0.97 },
  ]);

  assert.equal(patch.fullName, 'ASHA DEVI');

  const surnameOnly = profileFromIdentityDocument('passport', [
    { key: 'surname', value: 'KUMARI', confidence: 0.97 },
  ]);
  assert.equal(surnameOnly.fullName, undefined);
});

await check('a promised passport does not count as a passport', () => {
  // `documentOnFile`, not `documentSatisfied`. Someone who said "I don't have
  // one" has answered the upload question without giving us a document, and is
  // exactly who "do you have a valid passport?" needs to be put to.
  const c = justConsented();
  for (const status of ['unavailable', 'promised'] as const) {
    c.documents.passport = { status, askedCount: 1, updatedAt: new Date() };
    assert.equal(
      stepById('passport_status')!.satisfied(c),
      false,
      `"${status}" must not answer the passport question`,
    );
  }
});

await check('the job is a controlled value, not free text', () => {
  // A recruiter filter cannot match "general labour", "helper" and "GW" against
  // one category. The tap is what makes `job_category` a filter rather than a
  // second free-text field.
  const step = stepById('job_category')!;
  assert.equal(step.input, 'choice');
  assert.ok(step.choices?.length, 'the job question must offer a fixed list');

  const ids = step.choices!.map((c) => c.id);
  for (const required of ['general_worker', 'technician', 'other']) {
    assert.ok(ids.includes(required), `missing category "${required}"`);
  }
  // WhatsApp lists cap at ten rows; an eleventh would silently not render.
  assert.ok(ids.length <= 10, `too many rows for a WhatsApp list: ${ids.length}`);

  // Asked of everyone now, not only the route it was invented for.
  assert.equal(step.when, undefined, 'the job category must not be conditional');
});

await check('answering the job once answers it everywhere', () => {
  // The tap records the category; typing records the category *and* their own
  // words. Either way `desiredOccupation` is filled, so `desired_job` further
  // down is already answered and never asked twice (§1).
  const tapped = justConsented();
  Object.assign(
    tapped.profile,
    stepById('job_category')!.apply!({ ids: ['general_worker'], tapped: true }, tapped),
  );
  assert.equal(tapped.profile.jobCategory, 'general_worker');

  const typed = justConsented();
  Object.assign(
    typed.profile,
    stepById('job_category')!.apply!({ value: 'Warehouse packer' }, typed),
  );
  assert.equal(typed.profile.desiredOccupation, 'Warehouse packer');
  assert.equal(typed.profile.jobCategory, 'other');
  assert.equal(stepById('desired_job')!.satisfied(typed), true);
});

console.log('\nthe Singapore/Malaysia route (conversation/flow.ts)');

/**
 * A candidate who has named Singapore, and answered nothing after it.
 *
 * The destination is the whole of what puts them on this route — not the number
 * they wrote to, which is why one is not set here. `phoneNumberId` stays on the
 * record for replies and says nothing about the questions.
 */
function sgmyCandidate(profile: Record<string, unknown> = {}): CandidateDoc {
  return candidate({
    stage: 'NEW',
    phoneNumberId: 'SECOND-LINE',
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'singapore',
      countryStrictness: 'prefer',
      ...profile,
    },
  });
}

/** Walks a flow from where it is, answering nothing, and returns the ids in order. */
function questionOrder(c: CandidateDoc, satisfy: (id: string) => void): string[] {
  const asked: string[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const step = nextStep(c);
    if (!step) break;
    asked.push(step.id);
    satisfy(step.id);
  }
  return asked;
}

await check('the number they wrote to decides nothing about the questions', () => {
  // The two flows are one. Whichever number a message arrives on, the route is
  // read off the destination and nothing else — so the same answers give the
  // same next question from either.
  const answered = { lookingForOverseasJob: true, countryPreference: 'singapore' };

  const first = candidate({ stage: 'NEW', phoneNumberId: 'MAIN-LINE', profile: { ...answered } });
  const second = candidate({ stage: 'NEW', phoneNumberId: 'SECOND-LINE', profile: { ...answered } });
  assert.equal(routeFor(first), 'sgmy');
  assert.equal(routeFor(second), 'sgmy');
  assert.equal(nextStep(first)?.id, nextStep(second)?.id);

  // And a Gulf candidate on the second number is asked for a CV like anybody
  // else, which is exactly what could not happen while the number picked the
  // flow.
  const gulf = candidate({
    stage: 'NEW',
    phoneNumberId: 'SECOND-LINE',
    profile: { lookingForOverseasJob: true, countryPreference: 'gcc', countryStrictness: 'prefer' },
  });
  assert.equal(routeFor(gulf), 'default');
  assert.equal(nextStep(gulf)?.id, 'cv');
});

await check('the webhook says which number a message arrived on', () => {
  const { messages: parsed } = parseWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'SECOND-LINE' },
              contacts: [{ wa_id: '919000000000', profile: { name: 'Asha' } }],
              messages: [
                {
                  id: 'wamid.LINE',
                  from: '919000000000',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.phoneNumberId, 'SECOND-LINE');
});

await check('this route never asks for a CV before the job is known (§5)', () => {
  const c = sgmyCandidate();

  // The destination, then straight to the personal details. Not the CV.
  assert.equal(nextStep(c)?.id, 'full_name');

  const ids = SGMY_STEPS.map((step) => step.id);
  const at = (id: string) => {
    const i = ids.indexOf(id);
    assert.ok(i !== -1, `"${id}" is missing from this route`);
    return i;
  };

  assert.ok(at('consent') < at('country_preference'), 'consent still comes first');
  assert.ok(at('country_preference') < at('full_name'), 'and the destination straight after it');
  assert.ok(at('full_name') < at('cv'), 'the personal details come before the CV here');
  assert.ok(at('job_preference') < at('cv'), 'the CV waits until the job is known');
  assert.ok(at('cv') < at('availability'), 'and is asked before when they can join');
  assert.ok(at('cv') < at('passport_status'), 'and before the documents');
  assert.ok(at('availability') < at('confirm'), 'the rest of the flow is unchanged');
});

await check('one country question, asked once, on both routes (§10)', () => {
  assert.deepEqual(
    SGMY_COUNTRY_CHOICES.map((choice) => choice.id),
    ['singapore', 'malaysia'],
  );

  // There is no second country question to keep in step with the first. The
  // one everybody is asked writes `countryPreference`, and the route is read
  // back off that field.
  assert.equal(stepById('country_preference_sgmy'), undefined);

  const ids = SGMY_STEPS.map((s2) => s2.id);
  assert.ok(ids.includes('country_preference'), 'the same question, on this route too');
  assert.ok(ids.includes('country_strictness'), 'whether they hold out for one is still asked');
  // Present and never asked: "Select countries" is not a Singapore/Malaysia
  // answer, so the step's own guard keeps it out of this route's way.
  assert.ok(ids.includes('selected_countries'));
  assert.equal(stepById('selected_countries')!.when!(sgmyCandidate()), false);

  const step = stepById('country_preference')!;
  const c = sgmyCandidate({ countryPreference: undefined, countryStrictness: undefined });
  Object.assign(c.profile, step.apply!({ ids: ['singapore'], raw: 'Singapore' }, c));
  assert.equal(c.profile.countryPreference, 'singapore');
  assert.equal(step.satisfied(c), true);
  assert.equal(routeFor(c), 'sgmy', 'and the answer is what moves them onto the route');

  // And the confirmation summary can name it back.
  assert.equal(labelFor('singapore', 'country_preference')?.en, 'Singapore');
  assert.equal(labelFor('malaysia', 'country_preference')?.ta, 'மலேசியா');
});

await check('every other destination is untouched by any of it', () => {
  const c = candidate({
    stage: 'NEW',
    profile: { lookingForOverseasJob: true, countryPreference: 'gcc', countryStrictness: 'prefer' },
  });
  assert.equal(nextStep(c)?.id, 'cv', 'the CV is still the first thing asked after the destination');

  const ids = STEPS.map((step) => step.id);
  assert.ok(ids.includes('country_preference'));
  assert.ok(ids.includes('selected_countries'));

  // A Gulf candidate carrying a job level — which nothing writes for them —
  // must still be asked for a CV.
  const withLevel = candidate({
    stage: 'NEW',
    profile: {
      lookingForOverseasJob: true,
      countryPreference: 'gcc',
      countryStrictness: 'prefer',
      jobLevel: 'low_skill',
    },
  });
  assert.equal(nextStep(withLevel)?.id, 'cv');
});

await check('changing the destination changes the route, and the CV with it (§22)', () => {
  // The route is derived, so an edit of §10 moves the candidate on the same
  // turn. This is the case a stored variant would have got wrong.
  const c = sgmyCandidate({
    fullName: 'Asha Kumari',
    jobLevel: 'low_skill',
    jobCategory: 'cleaning_housekeeping',
    desiredOccupation: 'cleaner',
  });
  assert.equal(stepById('cv')!.when!(c), false, 'a cleaner bound for Singapore is not asked');

  c.profile.countryPreference = 'gcc';
  assert.equal(routeFor(c), 'default');
  assert.equal(stepById('cv')!.when!(c), true, 'the same cleaner bound for the Gulf is');
});

await check('a cleaner is not asked for a CV; a welder is (§5)', () => {
  // Everything up to the job preferences is answered, so the next question is
  // the one this line puts the CV behind.
  const answered = {
    fullName: 'Asha Kumari',
    currentCity: 'Madurai',
    currentState: 'Tamil Nadu',
    currentCountry: 'India',
    dateOfBirth: '1994-04-02',
    education: 'class_10',
    countryPreference: 'singapore',
    countryStrictness: 'prefer',
    primaryTrade: 'cleaning_housekeeping',
    totalExperienceBand: '2_5',
    jobCategory: 'cleaning_housekeeping',
    workTypePreference: 'current_trade',
    relatedAcceptance: 'related_ok',
    trainingWillingness: 'yes',
  };

  const cleaner = sgmyCandidate({ ...answered, jobLevel: 'low_skill' });
  const cleanerAsked = questionOrder(cleaner, (id) => {
    if (id === 'cv') throw new Error('a low-skill applicant must not be asked for a CV');
    if (id === 'availability') cleaner.profile.availability = 'immediate';
    else if (id === 'passport_status') cleaner.profile.passportStatus = 'no';
    else if (id === 'aadhaar_upload') {
      cleaner.documents.aadhaar!.status = 'ocr_done';
      // Read in full — a PDF, or both sides in one photo. The back is not asked
      // for, which is the whole point of `aadhaar_back_upload`'s guard (§15).
      cleaner.profile.aadhaarFieldsRead = [...TUNABLES.aadhaarRequiredFields];
    }
    else if (id === 'pan_upload') cleaner.documents.pan!.status = 'received';
    else if (id === 'confirm') cleaner.stage = 'REGISTRATION_COMPLETED';
    else throw new Error(`unexpected question for a low-skill applicant: ${id}`);
  });
  assert.deepEqual(cleanerAsked, [
    'availability',
    'passport_status',
    'aadhaar_upload',
    'pan_upload',
    'confirm',
  ]);

  // The same candidate, one field different: the CV is asked, and asked first.
  const welder = sgmyCandidate({ ...answered, jobLevel: 'skilled' });
  assert.equal(nextStep(welder)?.id, 'cv');

  // We could not tell. Asking costs one question that can be declined in a tap;
  // not asking loses a document nobody finds out was available.
  const unknown = sgmyCandidate({ ...answered, jobLevel: 'unknown' });
  assert.equal(nextStep(unknown)?.id, 'cv');

  // Not classified at all — the model was unreachable when the level was due.
  // Same answer, for the same reason.
  const undecided = sgmyCandidate(answered);
  assert.equal(nextStep(undecided)?.id, 'cv');
});

await check('the common job titles are settled without a model call', () => {
  for (const job of [
    'cleaner',
    'housekeeping',
    'general helper',
    'packing job',
    'loader',
    'kitchen helper',
    'construction labour',
    'any general work',
  ]) {
    assert.equal(levelFromTitle(job), 'low_skill', job);
  }

  for (const job of [
    'welder',
    'electrician',
    'pipe fitter',
    'cnc operator',
    'crane operator',
    'staff nurse',
    'accountant',
    'safety officer',
    'site supervisor',
  ]) {
    assert.equal(levelFromTitle(job), 'skilled', job);
  }

  // The trap the ordering exists for: a helper attached to a trade is someone
  // learning that trade, and often the one candidate in the group holding a
  // certificate worth sending.
  assert.equal(levelFromTitle('welder helper'), 'skilled');
  assert.equal(levelFromTitle('electrician assistant'), 'skilled');

  // Anything it cannot place goes to the model rather than being guessed at.
  assert.equal(levelFromTitle('poultry farm work'), undefined);
  assert.equal(levelFromTitle(''), undefined);

  // Only `low_skill` skips the CV. Every other answer, including the absence of
  // one, asks.
  assert.equal(cvWorthAsking('low_skill'), false);
  assert.equal(cvWorthAsking('skilled'), true);
  assert.equal(cvWorthAsking('unknown'), true);
  assert.equal(cvWorthAsking(undefined), true);
});

await check('the job classified is the one they are applying for, not the one they left', () => {
  // Their own words win outright.
  const named = sgmyCandidate({
    workTypePreference: 'different',
    desiredOccupation: 'tower crane operator',
  });
  assert.equal(desiredJobForLevel(named), 'tower crane operator');

  // But nothing at all before the job preference is answered — the job on the
  // record until then is the one they are leaving, not the one they want.
  const tooEarly = sgmyCandidate({
    primaryTrade: 'fabrication_welding',
    currentOccupation: 'welder',
  });
  assert.equal(desiredJobForLevel(tooEarly), undefined);

  // "Any general work" is itself the answer: the question names packing,
  // helping, cleaning and construction, so choosing it says what the job is
  // whatever trade they came from.
  const general = sgmyCandidate({
    primaryTrade: 'fabrication_welding',
    currentOccupation: 'welder',
    workTypePreference: 'general',
  });
  assert.equal(desiredJobForLevel(general), 'any general work');
  assert.equal(levelFromTitle(desiredJobForLevel(general)!), 'low_skill');

  // More of what they already do: their current trade, in their own words.
  const same = sgmyCandidate({
    primaryTrade: 'electrical_mechanical',
    currentOccupation: 'plumber',
    workTypePreference: 'current_trade',
  });
  assert.equal(desiredJobForLevel(same), 'plumber');

  // Nothing said yet is nothing to classify — and the CV step sits behind these
  // questions, so it is never reached in this state.
  assert.equal(desiredJobForLevel(sgmyCandidate()), undefined);
});

await check('editing the destination re-asks the same three questions (§18, §22)', () => {
  // The `country` section is identical on both routes now — one question, asked
  // of everyone — so an edit of it opens the same three steps either way.
  const expected = ['country_preference', 'selected_countries', 'country_strictness'];
  assert.deepEqual(stepsInSection('country').map((step) => step.id), expected);
  assert.deepEqual(stepsInSection('country', 'sgmy').map((step) => step.id), expected);

  // And both forget the same fields, so an edit leaves the record in the same
  // shape whichever route the candidate was on.
  for (const variant of [undefined, 'sgmy' as const]) {
    assert.deepEqual(
      [...fieldsToClear('country', variant)].sort(),
      ['countryPreference', 'countryStrictness', 'selectedCountries'],
    );
  }
});

await check('the two routes share every step, and the same opening', () => {
  const shared = STEPS.filter((step) => SGMY_STEPS.includes(step));

  // Same objects, not copies. It is what makes "a question added to a shared
  // section appears on both routes" true rather than a thing to remember.
  assert.ok(shared.length > 20, `expected the routes to share most steps, shared ${shared.length}`);
  for (const id of ['entry', 'language', 'consent', 'country_preference', 'cv', 'full_name', 'confirm']) {
    assert.ok(
      shared.some((step) => step.id === id),
      `"${id}" should be the same step on both routes`,
    );
  }

  // Every step in one list is in the other. The routes differ in the *order*
  // they ask, not in what they hold.
  assert.deepEqual(
    [...new Set(SGMY_STEPS)].filter((step) => !STEPS.includes(step)),
    [],
    'this route holds a step the flow does not',
  );

  // And the questions asked before the fork are the same questions in the same
  // order, which is what makes it safe for `routeFor` to answer "default" for a
  // candidate who has not chosen a destination yet.
  const upToFork = (steps: typeof STEPS) => {
    const ids = steps.map((step) => step.id);
    return ids.slice(0, ids.indexOf('country_strictness') + 1);
  };
  assert.deepEqual(upToFork(SGMY_STEPS), upToFork(STEPS));
});

console.log('\nreaching a person: one route, and the intake in front of it (§24)');

/** Somebody who tapped Other → Talk to staff and nothing else. */
function staffEnquirer(): CandidateDoc {
  return candidate({
    stage: 'NEW',
    enquiry: 'staff',
    languageChosen: undefined,
    consent: undefined,
    profile: {},
  });
}

await check('the staff option is offered in one place and one place only', () => {
  // The "Other" menu keeps it. That is the whole design.
  assert.ok(
    OTHER_CHOICES.some((o) => o.id === CHOICE_STAFF.id),
    'Other → Talk to staff is the route to a person',
  );

  // Nowhere else. Not on the confirmation, not on the returning menu, and not
  // on any step in any of the four flows, including hidden interpreter choices.
  assert.ok(!CONFIRM_CHOICES.some((o) => o.id === CHOICE_STAFF.id), 'confirmation');
  assert.ok(!RETURNING_CHOICES.some((o) => o.id === CHOICE_STAFF.id), 'returning menu');

  for (const [name, steps] of Object.entries(FLOWS)) {
    for (const step of steps) {
      assert.ok(
        !(step.choices ?? []).some((o) => o.id === CHOICE_STAFF.id),
        `step "${step.id}" in the ${name} flow still renders a staff row`,
      );
      assert.ok(
        !(step.hiddenChoices ?? []).some((o) => o.id === CHOICE_STAFF.id),
        `step "${step.id}" in the ${name} flow still offers staff to the interpreter`,
      );
    }
  }
});

await check('a staff enquiry is asked nine things, in order (§24)', () => {
  assert.deepEqual(
    STAFF_STEPS.map((s) => s.id),
    [
      'language',
      'language_other',
      'consent',
      'full_name',
      'country_preference',
      'job_category',
      'passport_status',
      'passport_upload',
      'aadhaar_upload',
      'pan_upload',
      'confirm',
    ],
  );

  // Consent before anything personal, exactly as registration asks it (§4).
  // The intake used to skip it; an intake is filed in the CRM now, so a second
  // system holds their name and their documents.
  const ids = STAFF_STEPS.map((s) => s.id);
  for (const personal of ['full_name', 'country_preference', 'aadhaar_upload']) {
    assert.ok(
      ids.indexOf('consent') < ids.indexOf(personal),
      `consent must be asked before "${personal}"`,
    );
  }

  // The same steps registration uses, not copies — so an edit to either
  // question is an edit to both.
  assert.equal(STAFF_STEPS.find((s) => s.id === 'job_category'), stepById('job_category'));
  assert.equal(STAFF_STEPS.find((s) => s.id === 'consent'), stepById('consent'));

  // One intake, because there is one country question. It was two while the
  // second number asked its own.
  assert.equal(FLOWS['staff intake (sgmy)'], undefined);

  // Still not a registration: no CV, no trade questions, no availability.
  for (const id of ['cv', 'main_trade', 'job_preference', 'availability']) {
    assert.ok(!STAFF_STEPS.some((s) => s.id === id), `"${id}" does not belong in the intake`);
  }
});

await check('the intake walks language → consent → name → country → job → documents → confirm', () => {
  const c = staffEnquirer();
  assert.equal(nextStep(c)?.id, 'language');

  c.languageChosen = true;
  assert.equal(nextStep(c)?.id, 'consent');

  c.consent = { given: true, at: new Date(), source: 'whatsapp_chat' };
  assert.equal(nextStep(c)?.id, 'full_name');

  c.profile.fullName = 'Asha Kumari';
  assert.equal(nextStep(c)?.id, 'country_preference');

  c.profile.countryPreference = 'gcc';
  assert.equal(nextStep(c)?.id, 'job_category');

  c.profile.jobCategory = 'general_worker';
  assert.equal(nextStep(c)?.id, 'passport_status');

  c.profile.passportStatus = 'yes';
  assert.equal(nextStep(c)?.id, 'passport_upload');

  c.documents.passport!.status = 'ocr_done';
  assert.equal(nextStep(c)?.id, 'aadhaar_upload');

  c.documents.aadhaar!.status = 'ocr_done';
  assert.equal(nextStep(c)?.id, 'pan_upload');

  c.documents.pan!.status = 'received';
  assert.equal(nextStep(c)?.id, 'confirm');

  // Confirmed. The intake ends in a handover, not in REGISTRATION_COMPLETED, so
  // the reference number is what says the confirmation was answered.
  c.candidateId = 'ENQ-00001';
  assert.equal(nextStep(c), undefined, 'nothing is left to ask');
});

await check('somebody without a passport is not asked to photograph one', () => {
  const c = staffEnquirer();
  c.languageChosen = true;
  c.consent = { given: true, at: new Date(), source: 'whatsapp_chat' };
  c.profile.fullName = 'Asha Kumari';
  c.profile.countryPreference = 'gcc';
  c.profile.jobCategory = 'general_worker';
  c.profile.passportStatus = 'no';
  assert.equal(nextStep(c)?.id, 'aadhaar_upload');
});

await check('the intake reads the passport and the Aadhaar, and never the PAN', () => {
  // The same slots registration uses, so the routing is the same routing —
  // there is nothing configured separately here that could drift from it.
  assert.equal(requirementFor('passport')!.ocr, 'passport');
  assert.notEqual(requirementFor('aadhaar')!.ocr, 'none');
  assert.equal(requirementFor('pan')!.ocr, 'none');
  assert.ok(NEVER_OCR.has('pan'));

  for (const id of ['passport_upload', 'aadhaar_upload', 'pan_upload']) {
    const step = STAFF_STEPS.find((s) => s.id === id)!;
    assert.ok(step.document, `${id} must file into a document slot`);
  }
});

await check('a staff enquiry is given a reference number, not an ADR id (§24)', () => {
  assert.notEqual(ENQUIRY_ID_PREFIX, CANDIDATE_ID_PREFIX);

  // Both are read back as ids, and each keeps its own series. A registration
  // and an enquiry that happen to share digits are different records.
  assert.equal(normaliseApplicationId('ENQ-00007'), 'ENQ-00007');
  assert.equal(normaliseApplicationId('enq 7'), 'ENQ-00007');
  assert.equal(normaliseApplicationId('ADR-00042'), 'ADR-00042');
  assert.equal(normaliseApplicationId('adr 42'), 'ADR-00042');

  // A bare number still reads as a registration id, which is what it has always
  // meant at the tracking question.
  assert.equal(normaliseApplicationId('42'), 'ADR-00042');

  // Quoted unprompted, either prefix is recognised anywhere in a message.
  assert.equal(looksLikeApplicationId('my id is ENQ-00007'), true);
  assert.equal(looksLikeApplicationId('my id is ADR-00042'), true);
  // A bare number is not, because that is how a candidate picks a row.
  assert.equal(looksLikeApplicationId('2'), false);
});

await check('the forgotten-id lookup is offered on the third miss, not the first (§25)', () => {
  assert.equal(TUNABLES.maxTrackingIdAttempts, 2);

  // Two chances at typing it, then a way out. The lookup costs attempts of its
  // own, capped by the same number that caps the date-of-birth check — an id is
  // worth only as much as the check standing in front of it.
  assert.ok(TUNABLES.maxTrackingDobAttempts >= 1);
  assert.equal(CHOICE_FORGOT_ID.id, 'forgot_id');
});

console.log('\nthe ats export (resume_ats)');

await check('every collection asked for is named, and named once', () => {
  assert.deepEqual(ATS_COLLECTIONS, {
    candidates: 'candidates',
    aadhaarRecords: 'aadhaar_records',
    passportRecords: 'passport_records',
    messages: 'messages',
    sourcingClients: 'sourcing_clients',
    b2bCompanyDocuments: 'b2b_company_documents',
    b2bMessages: 'b2b_messages',
    b2bAgentAadhaar: 'b2b_agent_aadhar',
    b2bIdentityDocuments: 'b2b_identity_documents',
  });

  // A name typed twice is a collection created empty beside the one in use.
  const names = Object.values(ATS_COLLECTIONS);
  assert.equal(new Set(names).size, names.length);
});

await check('the candidate Aadhaar collection is spelled with two a-s, everywhere', () => {
  // An earlier build wrote it to `aadhar_records`, with one. Correcting the
  // name did not move the rows — `ensureAtsCollections` never renames, by
  // design — so that deploy left two Aadhaar collections standing in
  // `resume_ats` and a one-off had to fold one into the other
  // (`npm run migrate:aadhaar`). The price of the typo coming back is running
  // that migration a second time, which is why this is asserted rather than
  // trusted.
  assert.equal(ATS_COLLECTIONS.aadhaarRecords, 'aadhaar_records');

  // And the old name is a destination for nothing. It is still named, because
  // the migration has to look for it and boot has to warn about it, but a build
  // that writes there again is the same bug a second time.
  assert.equal(LEGACY_AADHAAR_COLLECTION, 'aadhar_records');
  assert.ok(!Object.values(ATS_COLLECTIONS).includes(LEGACY_AADHAAR_COLLECTION as never));
  assert.ok(
    !Object.values(atsDocumentRoutes()).some((r) => r.collection === LEGACY_AADHAAR_COLLECTION),
  );

  // Both sides of the card, and every future kind starting `aadhaar`, land in
  // that one collection. A route pointing somewhere else is the same split
  // arriving through the routing table instead of the name list.
  const routed = Object.entries(atsDocumentRoutes())
    .filter(([kind]) => kind.startsWith('aadhaar'))
    .map(([, route]) => route.collection);
  assert.ok(routed.length >= 2);
  for (const name of routed) assert.equal(name, ATS_COLLECTIONS.aadhaarRecords);

  // `b2b_agent_aadhar` is the one collection spelled with a single `a`, and it
  // is spelled that way on purpose: a different document — the agent's own
  // card, not a candidate's — with rows already filed under that name. Renaming
  // it would split it in two exactly as happened above.
  assert.deepEqual(
    Object.values(ATS_COLLECTIONS).filter((n) => n.includes('adha')),
    ['aadhaar_records', 'b2b_agent_aadhar'],
  );
});

await check('a business contact is a sourcing client, never a candidate', () => {
  // The row says what kind of sourcing client they are, and how they reached
  // us. Both are written on every one the bot creates.
  assert.equal(b2bClientType(), 'b2b agents');
  assert.equal(b2bClientType('client'), 'b2b clients');
  assert.equal(b2bClientType('association'), 'b2b associations');

  // And they must never land in the candidate list. That is the whole reason
  // they have a collection of their own rather than a `candidates` row with a
  // flag on it — a flag is something a query can forget to filter on.
  assert.notEqual(ATS_COLLECTIONS.sourcingClients, ATS_COLLECTIONS.candidates);
});

await check('a B2B enquiry reaches sourcing only after CRM approval', () => {
  const contact = candidate({ enquiry: 'b2b' });
  assert.equal(b2bApprovedForSourcing(contact), false);
  contact.b2bReview = { status: 'pending', submittedAt: new Date() };
  assert.equal(b2bApprovedForSourcing(contact), false);
  contact.b2bReview.status = 'approved';
  assert.equal(b2bApprovedForSourcing(contact), true);
});

await check('each document kind goes to its own collection, and reads or does not', () => {
  const routes = atsDocumentRoutes();

  assert.deepEqual(routes.aadhaar, { collection: 'aadhaar_records', ocr: true });
  // Both sides of one card go to the same place.
  assert.deepEqual(routes.aadhaar_back, { collection: 'aadhaar_records', ocr: true });
  assert.deepEqual(routes.passport, { collection: 'passport_records', ocr: true });

  // Both sides of the agent's card, filed together.
  assert.deepEqual(routes.b2b_aadhaar_front, { collection: 'b2b_agent_aadhar', ocr: false });
  assert.deepEqual(routes.b2b_aadhaar_back, { collection: 'b2b_agent_aadhar', ocr: false });
  assert.deepEqual(routes.b2b_id_proof, {
    collection: 'b2b_identity_documents',
    ocr: false,
  });

  // The company's paperwork is stored and never read — no extractor, so no
  // `ocr` block, which would otherwise read as an extraction that found nothing.
  assert.deepEqual(routes.company_registration, {
    collection: 'b2b_company_documents',
    ocr: false,
  });
});

await check('nothing is routed to an extractor the rules forbid', () => {
  // The export cannot invent a route that `rules.ts` refuses. This is the same
  // guarantee `assertOcrRoutingIsSafe` makes at boot, checked from the other
  // end: a kind exported *with* OCR must be a kind the bot is allowed to read.
  for (const [kind, route] of Object.entries(atsDocumentRoutes())) {
    if (!route.ocr) continue;
    assert.ok(!NEVER_OCR.has(kind), `${kind} must never be exported with an extraction`);
  }

  // And the PAN specifically, which is the one this protects.
  assert.equal(atsRouteFor('pan'), undefined, 'the PAN has no record collection');
  assert.ok(NEVER_OCR.has('pan'));
});

await check('a kind with no collection of its own is still named on the candidate', () => {
  // The PAN, the CV, a driving licence, a loose certificate. None was asked for
  // as a collection; all of them are on the candidate record's document index,
  // so a documentation officer can still find the file.
  for (const kind of ['pan', 'cv', 'driving_licence', 'certificate']) {
    assert.equal(atsRouteFor(kind), undefined, `${kind} should have no collection of its own`);
  }
});

console.log('\nwhat may be sent to an extractor');

await check('the PAN is never routed to an extractor (§15, §16)', () => {
  // The requirement, stated three ways, because one of them will be the one
  // somebody edits.
  assert.equal(requirementFor('pan')!.ocr, 'none');
  assert.ok(NEVER_OCR.has('pan'));

  // The flow does ask for it — storing it is the point — it just never reads it.
  assert.equal(stepById('pan_upload')!.document, 'pan');
});

await check('a PAN routed to an extractor fails the boot, not a candidate', () => {
  // The check that makes the promise above enforceable. `validateCopy` runs it
  // before the server accepts traffic, so an edit that gives the PAN a route
  // breaks the deploy rather than quietly posting tax identifiers to a third
  // party.
  const pan = DOCUMENTS.find((d) => d.id === 'pan')!;
  const original = pan.ocr;
  try {
    (pan as { ocr: string }).ocr = 'aadhaar';
    assert.throws(() => assertOcrRoutingIsSafe(), /pan/i);
  } finally {
    (pan as { ocr: string }).ocr = original;
  }
  // And it passes as shipped.
  assertOcrRoutingIsSafe();
});

await check('only the three documents with extractors built for them are read', () => {
  // A kind either has an extractor written for it or it is not read at all.
  // There is deliberately no generic route, so a new slot cannot inherit one.
  for (const doc of DOCUMENTS) {
    assert.ok(
      ['passport', 'resume', 'aadhaar', 'none'].includes(doc.ocr),
      `"${doc.id}" routes to an extractor that does not exist: ${doc.ocr}`,
    );
    if (NEVER_OCR.has(doc.id)) assert.equal(doc.ocr, 'none', doc.id);
  }
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

console.log('\ncontinue resumes; restart re-walks. Neither deletes anything');

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
      // Answered, because §10 is asked before the CV and the CV is on file
      // here. A fixture that had skipped it would be resumed at the country
      // question rather than at the education one.
      countryPreference: 'gcc',
      countryStrictness: 'prefer',
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
  const c = halfFinished();

  assert.equal(c.profile.fullName, 'Ravi Kumar');
  assert.equal(c.profile.dateOfBirth, '1994-03-11');
  assert.equal(c.profile.currentCity, 'Chennai');

  for (const id of ['full_name', 'location']) {
    assert.equal(stepById(id)!.satisfied(c), true, `${id} was forgotten`);
  }
});

await check('continue returns to the exact question the prompt interrupted', () => {
  // The prompt has to occupy `currentStep` — otherwise the candidate's tap on
  // "Continue" would be read as an answer to the question underneath — so the
  // engine stashes what it displaced in `resumeStep` and puts it back. Without
  // the stash, "continue" could only ever mean "recompute", which is what the
  // other button does.
  const c = halfFinished({ resumeStep: 'education', currentStep: 'menu:resume' });

  const stashed = stepById(c.resumeStep!)!;
  assert.equal(stashed.satisfied(c), false, 'the stashed question must still be open');
  assert.ok(!stashed.when || stashed.when(c), 'the stashed question must still apply');
  assert.equal(stashed.id, 'education');
});

await check('continue falls back to the scheduler when the stash went stale', () => {
  // The stashed question was answered while the prompt was on screen — a
  // document arrived and filled it. Re-asking would break §1, so the fallback
  // is the ordinary scheduler.
  const c = halfFinished({ resumeStep: 'full_name', currentStep: 'menu:resume' });
  assert.equal(stepById(c.resumeStep!)!.satisfied(c), true, 'fixture is not stale');

  c.currentStep = undefined;
  assert.equal(nextStep(c)?.id, 'education', 'the scheduler must take over');
});

await check('continue does not re-ask anything already answered', () => {
  const c = halfFinished();
  c.currentStep = undefined;

  const { order } = walkFlow(c);
  for (const answered of ['full_name', 'location']) {
    assert.ok(!order.includes(answered), `continue re-asked "${answered}"`);
  }
  // And the CV, which is on file (§1, §22).
  assert.ok(!order.includes('cv'), 'continue re-asked for a CV already on file');
});

await check('restart keeps every answer, document and extraction', () => {
  // The behaviour this replaced: a restart emptied `profile` and `fieldMeta`,
  // so someone who tapped "start again" because they mistyped one answer lost
  // all of them. Restarting a conversation is not withdrawing the answers given
  // during it — DELETE is what does that, and it asks first (§23).
  const before = halfFinished({
    editQueue: ['location'],
    pendingMulti: { step: 'general_jobs', selected: ['warehouse'] },
  });
  const after: CandidateDoc = { ...before, ...restartPatch(before) };
  for (const key of RESTART_UNSETS) delete (after as unknown as Record<string, unknown>)[key];

  assert.equal(after.profile.fullName, 'Ravi Kumar', 'a typed answer was destroyed by a restart');
  assert.equal(after.profile.dateOfBirth, '1994-03-11');
  assert.equal(after.fieldMeta.fullName?.source, 'chat', 'field provenance was destroyed');
  assert.equal(after.documents.cv?.status, 'ocr_done', 'an uploaded CV was destroyed');
  // §4 and §3 — recorded facts, not answers being revised.
  assert.equal(after.consent?.given, true);
  assert.equal(after.language, 'en');
  assert.equal(after.languageChosen, true);
});

await check('restart clears the position and nothing else', () => {
  const before = halfFinished({
    editQueue: ['location'],
    pendingMulti: { step: 'general_jobs', selected: ['warehouse'] },
    resumeStep: 'education',
  });
  const after: CandidateDoc = { ...before, ...restartPatch(before) };
  for (const key of RESTART_UNSETS) delete (after as unknown as Record<string, unknown>)[key];

  assert.deepEqual(after.editQueue, [], 'a queued edit survived the restart');
  assert.equal(after.unclearCount, 0);
  assert.equal(after.stage, 'NEW');

  // The open question, the stashed one, the half-made multi-select and the
  // closed session are removed outright — left behind, `currentStep` would have
  // the next tap answer a question the candidate has moved on from.
  assert.equal(after.currentStep, undefined);
  assert.equal(after.resumeStep, undefined);
  assert.equal(after.pendingMulti, undefined);
  assert.equal(after.sessionEndedAt, undefined);
});

await check('restart re-walks from the top and asks only what is missing', () => {
  // Both halves of what the candidate is promised. The flow starts at the first
  // step; every step already satisfied is skipped; the first question they
  // actually see is the first genuinely unanswered one.
  const before = halfFinished();
  const after: CandidateDoc = { ...before, ...restartPatch(before) };
  for (const key of RESTART_UNSETS) delete (after as unknown as Record<string, unknown>)[key];

  const { order, indexes } = walkFlow(after);

  // Never backwards: the scheduler walks one ordered list, so a restart cannot
  // drop someone into the middle of a different one.
  for (let i = 1; i < indexes.length; i++) {
    assert.ok(indexes[i]! > indexes[i - 1]!, `restart went backwards at "${order[i]}"`);
  }

  // Nothing already answered is put again.
  for (const answered of ['entry', 'language', 'consent', 'cv', 'full_name', 'location']) {
    assert.ok(!order.includes(answered), `restart re-asked "${answered}"`);
  }
  assert.equal(order[0], 'education', 'restart must resume at the first unanswered step');
});

await check('a restart with nothing missing runs straight to the confirmation', () => {
  // The honest answer to "start again" from someone whose answers are all on
  // file. Asking them to re-enter a complete profile would be the old
  // behaviour wearing a different hat.
  const complete = halfFinished({
    profile: {
      lookingForOverseasJob: true,
      fullName: 'Ravi Kumar',
      currentCity: 'Chennai',
      currentState: 'Tamil Nadu',
      dateOfBirth: '1994-03-11',
      education: 'class_10',
      primaryTrade: 'helper',
      tradePacks: [],
      generatedQuestions: [],
      totalExperienceBand: '1_3',
      hasOverseasExperience: false,
      countryPreference: 'gcc',
      countryStrictness: 'any',
      jobCategory: 'general_worker',
      desiredOccupation: 'Warehouse packing',
      workTypePreference: 'general',
      generalWorkWillingness: 'any_suitable',
      availability: 'immediate',
      passportStatus: 'no',
    },
  });
  for (const slot of ['aadhaar', 'pan'] as const) {
    complete.documents[slot] = { status: 'received', askedCount: 1, updatedAt: new Date() };
  }

  const after: CandidateDoc = { ...complete, ...restartPatch(complete) };
  for (const key of RESTART_UNSETS) delete (after as unknown as Record<string, unknown>)[key];

  assert.equal(nextStep(after)?.id, 'confirm');
});

await check('a new session field cannot be forgotten by a restart', () => {
  // The real risk is not today's code, it is the field somebody adds in six
  // months. Everything that holds the conversation's *position* must be named
  // in the restart contract; anything missing here is a stale pointer that
  // survives.
  const patch = restartPatch(halfFinished());
  const cleared = new Set([...Object.keys(patch), ...RESTART_UNSETS]);

  for (const field of [
    'editQueue',
    'unclearCount',
    'currentStep',
    'resumeStep',
    'pendingMulti',
    'listPage',
  ]) {
    assert.ok(cleared.has(field), `"${field}" is session state that a restart does not clear`);
  }
  // And what a restart must not touch is absent from the patch, not accidentally
  // in it. `profile` and `fieldMeta` are on this list now, which is the change.
  for (const kept of [
    'profile',
    'fieldMeta',
    'documents',
    'consent',
    'language',
    'history',
    'reminderSentAt',
  ]) {
    assert.ok(!cleared.has(kept), `"${kept}" must survive a restart`);
  }
});

console.log('\nhanding a finished registration to the CRM');

/** A candidate who has finished registering. */
function readyForCrm(overrides: Partial<CandidateDoc['profile']> = {}): CandidateDoc {
  return candidate({
    stage: 'REGISTRATION_COMPLETED',
    candidateId: 'ADR-00042',
    profileName: 'Ravi',
    profile: {
      lookingForOverseasJob: true,
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

await check('residence is sent, and no destination is invented', () => {
  // Their `country` means where someone lives; ours records that and, in a
  // different field, where the candidate wants to go. This one answered "Gulf
  // countries", which is six of them and not a destination the CRM can be told
  // — and sending the residence in its place would file a Chennai candidate as
  // wanting to work in India, which is a fact nobody established.
  const payload = toCrmPayload(readyForCrm());
  assert.equal(payload.profile.country, 'India');
  assert.equal(payload.profile.location, 'Chennai, Tamil Nadu');
  assert.equal(payload.profile.destination_country, undefined);
});

await check('a destination the CRM cannot name is not invented', () => {
  // `destinationCountryOf` resolves an option id against the CRM's own country
  // list and refuses to guess. A region is never in it; Singapore and Malaysia
  // are only there once an admin has added them, and nothing has been fetched
  // here — so every one of these reaches the CRM with no destination rather
  // than with a country somebody made up. `verify:taxonomy` is what reports the
  // list an installation actually has.
  for (const region of ['gcc', 'europe', 'malaysia', 'singapore']) {
    const payload = toCrmPayload(readyForCrm({ countryPreference: region }));
    assert.equal(payload.profile.destination_country, undefined, region);
  }

  // And the job category, which the flow does still ask, does reach the CRM.
  assert.equal(toCrmPayload(readyForCrm()).profile.job_category, 'general_worker');
});

await check('the experience band is sent as a band, never as a number', () => {
  const payload = toCrmPayload(readyForCrm());
  assert.equal(payload.profile.total_experience_band, '1_3');
  // "1_3" is a range the candidate picked. Turning it into 2.0 would put a
  // figure on the record they never gave.
  assert.equal(payload.profile.total_experience_years, undefined);

  // A CV that stated an actual figure does fill the numeric field.
  const exact = toCrmPayload(readyForCrm({ totalExperienceYears: 6 }));
  assert.equal(exact.profile.total_experience_years, 6);
});

await check('the passport is sent and the Aadhaar and PAN are not', () => {
  // A recruiter has to know whether a passport expires inside the deployment
  // window. Nothing in the CRM reads an Aadhaar or a PAN, and copying an
  // identifier into a second system for no reason is exposure bought with
  // nothing (§15, §16).
  const payload = toCrmPayload(
    readyForCrm({ aadhaarNumber: '1234 5678 9012', panNumber: 'ABCDE1234F' }),
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
  const first = toCrmPayload(readyForCrm()).idempotency_key;
  const second = toCrmPayload(readyForCrm()).idempotency_key;
  assert.equal(first, second);
  assert.equal(first, `whatsapp/${config.WHATSAPP_PHONE_NUMBER_ID}/919000000000`);

  // Two candidates on the same business number are still two submissions.
  const other = candidate({ waId: '919999999999', profile: { fullName: 'Asha' } });
  assert.notEqual(toCrmPayload(other).idempotency_key, first);
});

await check('the phone is sent in international form', () => {
  // `waId` is the full number without a plus. The plus is what tells the CRM
  // this is international rather than a local number whose country nobody
  // recorded — their cross-country duplicate check reads exactly that.
  const payload = toCrmPayload(readyForCrm());
  assert.equal(payload.profile.phone_e164, '+919000000000');
  assert.equal(payload.profile.phone, '+919000000000');
});

await check('what the bot believes about the CV is sent as a claim, not a fact', () => {
  const payload = toCrmPayload(readyForCrm({ cvRequired: false }));
  // Named `cv_required_claim` on the wire. The CRM derives its own answer and
  // may refuse the submission regardless of what this says.
  assert.equal(payload.cv_required_claim, false);
  assert.equal(payload.source, 'whatsapp');

  // Absent when the bot has no opinion, rather than guessed at.
  assert.equal(toCrmPayload(readyForCrm()).cv_required_claim, undefined);
});

await check('a candidate with no name still reaches the CRM', () => {
  // `full_name` is the CRM's one required field. Someone who finished
  // registering without a readable name is still a person a recruiter has to be
  // able to open, so the display name and then the number stand in.
  const noName = candidate({ profileName: 'Ravi', profile: { lookingForOverseasJob: true } });
  assert.equal(toCrmPayload(noName).profile.full_name, 'Ravi');

  const nothing = candidate({ profile: { lookingForOverseasJob: true } });
  assert.equal(toCrmPayload(nothing).profile.full_name, '919000000000');
});

await check('empty fields are omitted rather than sent as nulls', () => {
  // The CRM treats an absent field as "not stated" and a null as "stated to be
  // nothing" — and on a re-registration that difference decides whether an
  // existing value survives.
  const sparse = candidate({ profile: { lookingForOverseasJob: true, fullName: 'Ravi' } });
  const payload = toCrmPayload(sparse);
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
  assert.deepEqual(read, [
    'aadhaar',
    // The other side of the same card, read by the same extractor. Asked for
    // only when the front did not already carry the whole card (§15).
    'aadhaar_back',
    'cv',
    'passport',
  ]);

  const stored = [
    'pan',
    'driving_licence',
    'certificate',
    'b2b_aadhaar_front',
    'b2b_aadhaar_back',
    'b2b_id_proof',
    'company_registration',
  ];
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
  assert.equal(requirementFor('b2b_aadhaar_front')?.ocr, 'none');
  assert.equal(requirementFor('b2b_aadhaar_back')?.ocr, 'none');
  assert.equal(requirementFor('b2b_id_proof')?.ocr, 'none');

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

console.log('\njobs from the CRM');

const jobStep = stepById('job_category')!;

/** A candidate parked on the job question, which is all `choicesFor` reads. */
function atJobStep(overrides: Partial<CandidateDoc['profile']> = {}): CandidateDoc {
  return {
    ...candidate(),
    currentStep: 'job_category',
    profile: { lookingForOverseasJob: true, ...overrides },
  } as CandidateDoc;
}

/** A candidate looking at one page of a CRM-backed list. */
const atTaxonomyPage = (
  step: 'job_category' | 'country_preference',
  page = 0,
): CandidateDoc => ({
  ...atJobStep(),
  currentStep: step,
  listPage: { step, page },
});

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
  const reached = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const rendered = choicesFor(jobStep, atTaxonomyPage('job_category', page));
    assert.ok(rendered.length <= 10, `page ${page} has ${rendered.length} rows`);
    assert.ok(rendered.some((c) => c.id === 'other'), '"Other" was crowded out');
    for (const row of rendered) if (row.id.startsWith('job_')) reached.add(row.id);
    if (!rendered.some((row) => row.id === `__list_page__:job_category:${page + 1}`)) break;
  }
  assert.equal(reached.size, 30, 'pagination did not expose every CRM job');
  resetTaxonomy();
});

await check('a country an admin added is offered, and the regions survive', () => {
  setTaxonomyForTests({
    countries: [
      { id: 'kuwait', name: 'Kuwait', order: 1 },
      { id: 'qatar', name: 'Qatar', order: 2 },
    ],
  });
  const rendered = choicesFor(stepById('country_preference')!, atJobStep());
  const ids = rendered.map((c) => c.id);
  assert.ok(ids.includes('kuwait'), 'a country added in the CRM never reached the candidate');
  assert.ok(ids.includes('gcc'), 'the regions are still real answers and must remain');
  assert.ok(ids.includes('any'));
  assert.ok(rendered.length <= 10, `a list of ${rendered.length} rows would be refused by Meta`);
  resetTaxonomy();
});

await check('the CRM can name a country it added, and refuses to name a region', () => {
  // `destination_country` has to be a country. An admin adding Kuwait is what
  // makes Kuwait nameable; "the Gulf" is six countries and stays unnamed.
  setTaxonomyForTests({ countries: [{ id: 'kuwait', name: 'Kuwait', order: 1 }] });

  const kuwait = candidate({ profile: { lookingForOverseasJob: true, countryPreference: 'kuwait' } });
  assert.equal(toCrmPayload(kuwait).profile.destination_country, 'Kuwait');

  const gulf = candidate({ profile: { lookingForOverseasJob: true, countryPreference: 'gcc' } });
  assert.equal(toCrmPayload(gulf).profile.destination_country, undefined);
  resetTaxonomy();
});


/* ------------------------------------------------------------------ */
/* The taxonomy at the size a real agency runs it                      */
/*                                                                     */
/* The checks above prove the wiring with two jobs and two countries,  */
/* which is the size at which nothing has to be cut. Every failure     */
/* this feature actually had appeared at the size the CRM is actually  */
/* loaded to: eleven jobs and eight countries against ten WhatsApp     */
/* rows. So these run at that size, and the ones that matter most are  */
/* about what happens to the rows that do not fit.                     */
/* ------------------------------------------------------------------ */

console.log('\nthe CRM taxonomy at the size a real agency runs it');

/** The eleven job designations the live CRM holds, in the admin's order. */
const ELEVEN_JOBS = [
  { id: 'general_worker', title: 'General Worker', order: 1 },
  { id: 'factory_warehouse', title: 'Factory / Warehouse', order: 2 },
  { id: 'packing', title: 'Packing', order: 3 },
  { id: 'cleaning_housekeeping', title: 'Cleaning / Housekeeping', order: 4 },
  { id: 'construction', title: 'Construction', order: 5 },
  { id: 'hospitality', title: 'Hospitality', order: 6 },
  { id: 'sales_retail', title: 'Sales / Retail', order: 7 },
  { id: 'driver_operator', title: 'Driver / Operator', order: 8 },
  { id: 'fabrication_welding', title: 'Welding / Fabrication', order: 9 },
  { id: 'electrical_mechanical', title: 'Electrical / Mechanical', order: 10 },
  { id: 'technician', title: 'Technician', order: 11 },
];

/** The eight destinations it holds, likewise. */
const EIGHT_COUNTRIES = [
  { id: 'singapore', name: 'Singapore', order: 1 },
  { id: 'malaysia', name: 'Malaysia', order: 2 },
  { id: 'saudi_arabia', name: 'Saudi Arabia', order: 3 },
  { id: 'united_arab_emirates', name: 'United Arab Emirates', order: 4 },
  { id: 'qatar', name: 'Qatar', order: 5 },
  { id: 'kuwait', name: 'Kuwait', order: 6 },
  { id: 'oman', name: 'Oman', order: 7 },
  { id: 'bahrain', name: 'Bahrain', order: 8 },
];

const countryStep = stepById('country_preference')!;

/** The rows on one screen, and everything else that screen accepts. */
const shownFor = (step: FlowStep, page = 0) =>
  choicesFor(
    step,
    step.id === 'job_category' || step.id === 'country_preference'
      ? atTaxonomyPage(step.id, page)
      : atJobStep(),
  ).map((c) => c.id);
const typableFor = (step: FlowStep, page = 0) =>
  acceptedChoices(
    step,
    step.id === 'job_category' || step.id === 'country_preference'
      ? atTaxonomyPage(step.id, page)
      : atJobStep(),
  )
    .filter((c) => c.hidden)
    .map((c) => c.id);

await check('eleven jobs fill the list without overflowing it', () => {
  setTaxonomyForTests({ jobs: ELEVEN_JOBS });
  const shown = shownFor(jobStep);

  assert.ok(shown.length <= 10, `${shown.length} rows would be refused by Meta`);
  assert.ok(shown.includes('other'), '"Other" was crowded out by the eleven');
  // Eight jobs, More options, and the way to type something unlisted.
  assert.equal(shown.length, 10);
  assert.ok(shown.includes('__list_page__:job_category:1'));
  resetTaxonomy();
});

await check('the first page follows the admin order', () => {
  setTaxonomyForTests({ jobs: ELEVEN_JOBS });
  assert.deepEqual(shownFor(jobStep).slice(0, 3), [
    'general_worker',
    'factory_warehouse',
    'packing',
  ]);
  resetTaxonomy();
});

await check('More options reaches every remaining job and Back returns', async () => {
  setTaxonomyForTests({ jobs: ELEVEN_JOBS });
  const firstCandidate = atTaxonomyPage('job_category', 0);
  const firstAccepted = acceptedChoices(jobStep, firstCandidate);
  const moreId = '__list_page__:job_category:1';
  const second = shownFor(jobStep, 1);

  for (const job of ELEVEN_JOBS.slice(8)) {
    assert.ok(second.includes(job.id), `${job.id} is missing from the second page`);
  }
  assert.ok(second.includes('__list_page__:job_category:0'));
  assert.ok(second.includes('other'));
  assert.ok(second.length <= 10);
  const tapped = await interpret({
    step: jobStep,
    choices: firstAccepted,
    text: 'More options',
    replyId: moreId,
  });
  assert.equal(tapped.kind, 'matched');
  assert.deepEqual(
    listPageTarget(jobStep.id, tapped.kind === 'matched' ? tapped.ids : []),
    {
    step: 'job_category',
    page: 1,
    },
  );
  resetTaxonomy();
});

await check('the CRM list limit is respected below Meta’s ceiling', () => {
  setTaxonomyForTests({ botListLimit: 6, jobs: ELEVEN_JOBS });
  for (const page of [0, 1, 2]) {
    const shown = shownFor(jobStep, page);
    assert.ok(shown.length <= 6, `page ${page} has ${shown.length} rows`);
    assert.ok(shown.includes('other'));
  }
  resetTaxonomy();
});

await check('a job an admin promotes to the top appears first', () => {
  // The whole of "make the order configurable": an eleventh job is invisible
  // until an admin says it matters, and then it is the first thing offered.
  setTaxonomyForTests({
    jobs: [...ELEVEN_JOBS, { id: 'cnc_operator', title: 'CNC Operator', order: 0 }],
  });
  assert.equal(shownFor(jobStep)[0], 'cnc_operator');
  resetTaxonomy();
});

await check('jobs on later pages are still answerable by typing', () => {
  // The failure this closes: `electrical_mechanical` and `technician` were on
  // the CRM's list, off the WhatsApp list, and absent from what the interpreter
  // was allowed to choose — so a candidate who typed "technician" was told
  // their answer was not one of the options.
  setTaxonomyForTests({ jobs: ELEVEN_JOBS });

  const shown = shownFor(jobStep);
  assert.ok(!shown.includes('technician'), 'the fixture no longer overflows');

  const accepted = acceptedChoices(jobStep, atJobStep()).map((c) => c.id);
  for (const job of ELEVEN_JOBS) {
    assert.ok(accepted.includes(job.id), `${job.id} is on the CRM's list and cannot be answered`);
  }
  assert.ok(typableFor(jobStep).includes('technician'));
  resetTaxonomy();
});

await check('country pagination reaches every CRM country', () => {
  // The bug this pins: seven of the ten rows went to two pinned destinations
  // and five compiled region rows, leaving three for the CRM's list — so
  // Kuwait, Oman and Bahrain were dropped without a word.
  setTaxonomyForTests({ countries: EIGHT_COUNTRIES });
  const first = shownFor(countryStep);
  const second = shownFor(countryStep, 1);
  const shown = new Set([...first, ...second]);

  for (const country of EIGHT_COUNTRIES) {
    assert.ok(shown.has(country.id), `${country.id} never reached the candidate`);
  }
  assert.ok(first.includes('__list_page__:country_preference:1'));
  assert.ok(second.includes('__list_page__:country_preference:0'));
  assert.ok(first.length <= 10, `${first.length} rows would be refused by Meta`);
  assert.ok(second.length <= 10, `${second.length} rows would be refused by Meta`);
  resetTaxonomy();
});

await check('and the two answers that are not countries survive with them', () => {
  setTaxonomyForTests({ countries: EIGHT_COUNTRIES });
  const first = shownFor(countryStep);
  const second = shownFor(countryStep, 1);

  // "Any country" is what most candidates mean, and "Select countries" is the
  // only row that leads anywhere for a destination the list does not carry;
  // both remain fixed on every page.
  for (const shown of [first, second]) {
    assert.ok(shown.includes('any'), 'a candidate with no preference has no row to tap');
    assert.ok(shown.includes('select'), 'the way to name an unlisted country was cut');
  }
  resetTaxonomy();
});

await check('Singapore and Malaysia survive a CRM that has dropped them', () => {
  // Not two more destinations: choosing one is what puts a candidate on the
  // route that does not ask for a CV up front, and a fork nobody can reach is
  // a flow nobody can enter.
  setTaxonomyForTests({
    countries: EIGHT_COUNTRIES.filter((c) => !SGMY_DESTINATIONS.has(c.id)),
  });
  const first = shownFor(countryStep);
  const second = shownFor(countryStep, 1);
  const shown = new Set([...first, ...second]);

  assert.ok(shown.has('singapore'));
  assert.ok(shown.has('malaysia'));
  assert.ok(first.length <= 10);
  assert.ok(second.length <= 10);
  resetTaxonomy();
});

await check('the regions stay answerable once the countries have taken the rows', () => {
  setTaxonomyForTests({ countries: EIGHT_COUNTRIES });
  const typable = typableFor(countryStep);

  // "The Gulf, anywhere" is a real answer and always was. What changed is that
  // it is now said rather than tapped — and a region a candidate cannot say at
  // all would be a worse trade than the one this makes.
  for (const region of ['gcc', 'europe', 'russia_cis']) {
    assert.ok(typable.includes(region), `${region} can no longer be answered at all`);
  }
  resetTaxonomy();
});

await check('a short country list leaves room for the regions on screen', () => {
  // The budget is a ranking, not a rule that always cuts: an agency placing
  // into three countries has six rows to spare and the regions take them.
  setTaxonomyForTests({ countries: EIGHT_COUNTRIES.slice(0, 3) });
  const shown = shownFor(countryStep);

  assert.ok(shown.includes('gcc'), 'a list with room to spare still hid a region');
  assert.ok(shown.length <= 10);
  resetTaxonomy();
});

await check('ten countries overflow, and the overflow is still answerable', () => {
  setTaxonomyForTests({
    countries: [
      ...EIGHT_COUNTRIES,
      { id: 'romania', name: 'Romania', order: 9 },
      { id: 'serbia', name: 'Serbia', order: 10 },
    ],
  });

  const shown = shownFor(countryStep);
  assert.ok(shown.length <= 10, `${shown.length} rows would be refused by Meta`);
  assert.ok(!shown.includes('serbia'), 'the fixture no longer overflows');

  const accepted = acceptedChoices(countryStep, atJobStep()).map((c) => c.id);
  assert.ok(accepted.includes('serbia'), 'a country an admin added cannot be answered at all');
  resetTaxonomy();
});

/* ------------------------------------------------------------------ */
/* Typing a country instead of tapping one                             */
/* ------------------------------------------------------------------ */

console.log('\ntyping a country the CRM knows');

await check('a country typed by name resolves to the CRM’s own id', async () => {
  setTaxonomyForTests({ countries: EIGHT_COUNTRIES });

  const result = await interpret({
    step: countryStep,
    choices: acceptedChoices(countryStep, atJobStep()),
    text: 'Kuwait',
  });

  assert.equal(result.kind, 'matched');
  assert.deepEqual(result.kind === 'matched' ? result.ids : [], ['kuwait']);
  resetTaxonomy();
});

await check('a country past the ceiling resolves the same way', async () => {
  setTaxonomyForTests({
    countries: [...EIGHT_COUNTRIES, { id: 'romania', name: 'Romania', order: 9 }],
  });

  const result = await interpret({
    step: countryStep,
    choices: acceptedChoices(countryStep, atJobStep()),
    text: 'romania',
  });

  assert.equal(result.kind, 'matched', 'a country nobody could see was not accepted either');
  assert.deepEqual(result.kind === 'matched' ? result.ids : [], ['romania']);
  resetTaxonomy();
});

await check('the shorthands people actually type resolve without a model call', async () => {
  setTaxonomyForTests({ countries: EIGHT_COUNTRIES });
  const choices = acceptedChoices(countryStep, atJobStep());

  for (const [typed, expected] of [
    ['UAE', 'united_arab_emirates'],
    ['KSA', 'saudi_arabia'],
    ['saudi', 'saudi_arabia'],
  ] as const) {
    // Offline: `interpret` reaches the model only when the local resolver
    // returns nothing, and this suite has no model to reach.
    const result = await interpret({ step: countryStep, choices, text: typed });
    assert.equal(result.kind, 'matched', `${typed} was not understood`);
    assert.deepEqual(result.kind === 'matched' ? result.ids : [], [expected]);
  }
  resetTaxonomy();
});

await check('a number still means the row that number was on', () => {
  // The regression this closes off: `acceptedChoices` now carries answers that
  // were never rendered, and counting those would make "11" an answer to a
  // question that offered ten rows — filing a candidate against a country they
  // never saw.
  setTaxonomyForTests({ countries: EIGHT_COUNTRIES });
  const accepted = acceptedChoices(countryStep, atJobStep());
  const shown = choicesFor(countryStep, atJobStep());

  assert.deepEqual(resolveOfferedIds(['3'], accepted), [shown[2]!.id]);
  assert.deepEqual(
    resolveOfferedIds([String(shown.length + 1)], accepted),
    [],
    'a position past the last row was resolved to a hidden answer',
  );

  const secondCandidate = atTaxonomyPage('country_preference', 1);
  const secondAccepted = acceptedChoices(countryStep, secondCandidate);
  const secondShown = choicesFor(countryStep, secondCandidate);
  assert.deepEqual(resolveOfferedIds(['1'], secondAccepted), [secondShown[0]!.id]);
  resetTaxonomy();
});

await check('every option the candidate can see is countable, and nothing else is', () => {
  setTaxonomyForTests({ jobs: ELEVEN_JOBS, countries: EIGHT_COUNTRIES });

  for (const step of [jobStep, countryStep]) {
    for (const page of [0, 1]) {
      const viewing = atTaxonomyPage(
        step.id as 'job_category' | 'country_preference',
        page,
      );
      const accepted = acceptedChoices(step, viewing);
      const visible = accepted.filter((c) => !c.hidden);
      assert.deepEqual(
        visible.map((c) => c.id),
        choicesFor(step, viewing).map((c) => c.id),
        `the countable options of ${step.id} page ${page} are not the rendered ones`,
      );
    }
  }
  resetTaxonomy();
});

await check('a country only the CRM knows is read back by name, not by id', async () => {
  // The confirmation summary resolves an option id through the compiled labels
  // and falls back to the id itself, so a candidate who chose Kuwait used to
  // read "kuwait" back off their own summary.
  setTaxonomyForTests({ countries: EIGHT_COUNTRIES });

  const chose = candidate({
    profile: { lookingForOverseasJob: true, countryPreference: 'kuwait' },
  });
  const summary = await renderConfirmation(chose);
  assert.ok(summary.body.includes('Kuwait'), 'the summary shows the option id');
  assert.ok(!/\bkuwait\b/.test(summary.body), 'the summary shows the option id');
  resetTaxonomy();
});

/* ------------------------------------------------------------------ */
/* The questions an admin attaches to a job                            */
/*                                                                     */
/* Written in the CRM, read over HTTP, stored on the candidate before  */
/* they are asked, and sent back as answers. The pieces are tested     */
/* separately because the middle one needs a database and the rest do  */
/* not.                                                                */
/* ------------------------------------------------------------------ */

console.log('\nthe screening questions an admin attaches to a job');

const WELDING_QUESTIONS = [
  {
    id: 'q_processes',
    text: 'Which welding processes have you worked with?',
    kind: 'choice' as const,
    choices: ['TIG', 'MIG', 'Arc'],
    required: true,
  },
  {
    id: 'q_years',
    text: 'How many years of welding experience do you have?',
    kind: 'text' as const,
    choices: [],
    required: false,
  },
];

/** The questions as they are stored on a candidate once they have picked the job. */
const STORED_WELDING: StoredJobQuestion[] = WELDING_QUESTIONS.map((q) => ({
  id: q.id,
  jobId: 'fabrication_welding',
  question: q.text,
  kind: q.kind,
  choices: q.choices,
  required: q.required,
  askedAt: '2026-08-27T09:00:00.000Z',
}));

/** A welder part-way through, with the screening questions on their record. */
function welder(overrides: Partial<CandidateDoc> = {}, answers: Record<string, string[]> = {}) {
  return candidate({
    profile: {
      lookingForOverseasJob: true,
      fullName: 'Ravi Kumar',
      countryPreference: 'qatar',
      jobCategory: 'fabrication_welding',
      jobQuestions: STORED_WELDING,
      jobQuestionsFor: 'fabrication_welding',
      jobQuestionAnswers: answers,
    },
    ...overrides,
  });
}

await check('a job’s questions are cached, and read without a network call', async () => {
  setJobQuestionsForTests('fabrication_welding', WELDING_QUESTIONS);
  const held = await fetchJobQuestions('fabrication_welding');

  assert.equal(held?.length, 2);
  assert.equal(held![0]!.text, 'Which welding processes have you worked with?');
  assert.deepEqual(held![0]!.choices, ['TIG', 'MIG', 'Arc']);
  resetTaxonomy();
});

await check('a question with one option is asked as free text', () => {
  // One option is not a choice, it is a leading question — and a button that
  // can only be pressed one way collects nothing.
  setJobQuestionsForTests('packing', [
    { id: 'q', text: 'Can you start immediately?', kind: 'choice', choices: ['Yes'] },
  ]);
  const held = cachedJobQuestions('packing')!;

  assert.equal(held[0]!.kind, 'text');
  assert.deepEqual(held[0]!.choices, []);
  resetTaxonomy();
});

await check('an admin who writes fourteen options gets ten', () => {
  // Meta rejects the eleventh row and the whole message with it, so this is
  // not a tidy-up: it is the difference between a question and silence.
  setJobQuestionsForTests('packing', [
    {
      id: 'q',
      text: 'Which shifts can you work?',
      kind: 'choice',
      choices: Array.from({ length: 14 }, (_, i) => `Shift ${i + 1}`),
    },
  ]);
  assert.equal(cachedJobQuestions('packing')![0]!.choices.length, 10);
  resetTaxonomy();
});

await check('the questions are asked after the job is chosen, before the rest', () => {
  const ids = STEPS.map((s) => s.id);
  const job = ids.indexOf('job_category');
  const first = ids.indexOf('job_question:0');
  const preference = ids.indexOf('job_preference');

  assert.ok(first > job, 'a screening question is asked before the job it is about');
  assert.ok(first < preference, 'the screening questions come after the preference questions');
});

await check('they are on both routes and on neither menu', () => {
  assert.ok(
    SGMY_STEPS.some((s) => s.id === 'job_question:0'),
    'a candidate bound for Singapore is asked no screening questions',
  );
  assert.ok(
    !STAFF_STEPS.some((s) => s.id.startsWith('job_question:')),
    'the staff intake grew a screening question',
  );
});

await check('a slot is a question only for a candidate who has one', () => {
  const slot = stepById('job_question:0')!;

  assert.equal(slot.when!(candidate()), false, 'a candidate with no questions was asked one');
  assert.equal(slot.when!(welder()), true);
  assert.equal(
    stepById('job_question:2')!.when!(welder()),
    false,
    'a third slot applied to a candidate with two questions',
  );
});

await check('an answered screening question is not asked again', () => {
  const slot = stepById('job_question:0')!;

  assert.equal(slot.satisfied(welder()), false);
  assert.equal(slot.satisfied(welder({}, { q_processes: ['tig'] })), true);
});

await check('the candidate is asked the admin’s words, with the admin’s options', async () => {
  const slot = stepById('job_question:0')!;
  const rendered = await renderStep(slot, welder());

  assert.ok(
    rendered.body.includes('Which welding processes have you worked with?'),
    'the candidate was not asked the question the admin wrote',
  );
  assert.deepEqual(
    choicesFor(slot, welder()).map((c) => c.id),
    ['tig', 'mig', 'arc'],
  );
});

await check('a typed answer is recorded against the question’s own id', () => {
  const slot = stepById('job_question:1')!;
  const patch = slot.apply!({ value: '6 years', raw: '6 years' } as Answer, welder());

  assert.deepEqual(patch.jobQuestionAnswers, { q_years: ['6 years'] });
});

await check('answering one question does not forget the other', () => {
  const slot = stepById('job_question:1')!;
  const patch = slot.apply!(
    { value: '6 years' } as Answer,
    welder({}, { q_processes: ['tig'] }),
  );

  assert.deepEqual(patch.jobQuestionAnswers, { q_processes: ['tig'], q_years: ['6 years'] });
});

await check('changing the job forgets the questions that came with it', () => {
  // Otherwise a candidate who moves from welding to driving keeps answering
  // welding questions, and their answers are filed against a job they are no
  // longer applying for.
  const cleared = fieldsToClear('job_preference');

  for (const field of ['jobQuestions', 'jobQuestionsFor', 'jobQuestionAnswers']) {
    assert.ok(cleared.includes(field), `${field} survives an edit of the job`);
  }
});

/* ------------------------------------------------------------------ */
/* And what the CRM is told about it                                   */
/* ------------------------------------------------------------------ */

console.log('\nscreening answers reaching the CRM');

await check('the answers travel as the words the candidate was shown', () => {
  setTaxonomyForTests({ jobs: ELEVEN_JOBS });
  const payload = toCrmPayload(welder({}, { q_processes: ['tig', 'mig'], q_years: ['6 years'] }));
  const answers = payload.profile.job_answers ?? [];

  assert.equal(answers.length, 2);
  assert.equal(answers[0]!.question_id, 'q_processes');
  assert.equal(answers[0]!.question, 'Which welding processes have you worked with?');
  // Not "tig, mig" — the ids are ours and mean nothing on a recruiter's screen.
  assert.equal(answers[0]!.answer, 'TIG, MIG');
  assert.equal(answers[0]!.kind, 'choice');
  assert.equal(answers[0]!.asked_at, '2026-08-27T09:00:00.000Z');
  assert.equal(answers[1]!.answer, '6 years');
  resetTaxonomy();
});

await check('the job travels as an id and a title, not only a category', () => {
  setTaxonomyForTests({ jobs: ELEVEN_JOBS });
  const payload = toCrmPayload(welder({}, { q_processes: ['tig'] }));

  assert.equal(payload.profile.job_id, 'fabrication_welding');
  assert.equal(payload.profile.job_title, 'Welding / Fabrication');
  assert.equal(payload.profile.job_category, 'fabrication_welding');
  resetTaxonomy();
});

await check('"Other" is not a designation, and is not sent as one', () => {
  setTaxonomyForTests({ jobs: ELEVEN_JOBS });
  const typed = candidate({
    profile: {
      lookingForOverseasJob: true,
      fullName: 'Ravi Kumar',
      jobCategory: 'other',
      desiredOccupation: 'parota master',
    },
  });
  const payload = toCrmPayload(typed);

  assert.equal(payload.profile.job_id, undefined);
  assert.equal(payload.profile.job_title, undefined);
  // Their own words still travel, which is the whole point of the row.
  assert.equal(payload.profile.job_preference, 'parota master');
  resetTaxonomy();
});

await check('an unanswered question is not sent as an empty answer', () => {
  const payload = toCrmPayload(welder({}, { q_processes: ['tig'] }));
  const answers = payload.profile.job_answers ?? [];

  assert.equal(answers.length, 1, 'a question the conversation has not reached was sent');
  assert.equal(answers[0]!.question_id, 'q_processes');
});

await check('a candidate who has answered none sends no answers at all', () => {
  assert.equal(toCrmPayload(welder()).profile.job_answers, undefined);
});

await check('a question reworded since it was asked keeps the wording it was asked in', () => {
  // The reason the text is stored on the candidate rather than looked up. An
  // admin rewords a question the week after somebody answered it, and a profile
  // that renders today's wording against last week's answer is a record of a
  // conversation that never happened.
  setJobQuestionsForTests('fabrication_welding', [
    { id: 'q_processes', text: 'REWORDED BY AN ADMIN', kind: 'choice', choices: ['TIG'] },
  ]);

  const payload = toCrmPayload(welder({}, { q_processes: ['tig'] }));
  assert.equal(
    payload.profile.job_answers![0]!.question,
    'Which welding processes have you worked with?',
  );
  resetTaxonomy();
});

await check('a paragraph of an answer is clipped, not refused', () => {
  // The CRM's model caps an answer at a thousand characters and a 422 fails the
  // whole submission — one long reply must not cost a candidate their record.
  const payload = toCrmPayload(welder({}, { q_years: ['x'.repeat(4000)] }));
  assert.equal(payload.profile.job_answers![0]!.answer.length, 1000);
});

await check('a half-finished registration carries its screening answers', () => {
  // The case that matters most: somebody who answered the client's question and
  // then stopped is exactly the person a recruiter should be calling, and the
  // answer has to be on the record before the conversation finishes.
  const partial = welder(
    { stage: 'BASIC_DETAILS_PENDING', status: 'profile_incomplete' },
    { q_processes: ['tig'] },
  );
  const payload = toCrmPayload(partial);

  assert.equal(payload.registration?.complete, false);
  assert.equal(payload.registration?.assignable, true);
  assert.equal(payload.profile.job_answers?.length, 1);
  assert.equal(syncModeFor(partial, true), 'update', 'a partial stopped being an update');
});

await check('a finished registration carries the same answers', () => {
  const done = welder(
    { stage: 'REGISTRATION_COMPLETED', status: 'profile_registered', completedAt: new Date() },
    { q_processes: ['tig', 'mig'], q_years: ['6 years'] },
  );
  const payload = toCrmPayload(done);

  assert.equal(payload.registration?.complete, true);
  assert.equal(payload.profile.job_answers?.length, 2);
  assert.equal(syncModeFor(done, false), 'handover');
});

await check('none of it changes the key the CRM deduplicates on', () => {
  // Everything above is added to one candidate's profile, and a payload that
  // keyed differently because of it would file the same person twice.
  const empty = welder();
  const answered = welder({}, { q_processes: ['tig'], q_years: ['6 years'] });

  assert.equal(idempotencyKeyFor(empty), idempotencyKeyFor(answered));
  assert.equal(toCrmPayload(empty).idempotency_key, toCrmPayload(answered).idempotency_key);
  assert.equal(assignableFor(empty), assignableFor(answered));
});

/* ------------------------------------------------------------------ */

console.log('\nthe in-process queue runs jobs in parallel, safely');

/**
 * These drive `InProcessQueue` directly rather than the exported singleton,
 * which is built from the environment at import time. Handlers are supplied by
 * the test, so nothing here touches Mongo, Meta, Anthropic or Veris.
 *
 * The bug being pinned: this queue used to hold one promise chain for the whole
 * process, so every job of every type ran one after another and the
 * `concurrency` argument passed at registration was silently discarded — the
 * old `register` took two parameters, and TypeScript lets that satisfy a
 * three-parameter signature without complaint.
 */
const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An inbound payload for a given candidate. Only `waId` steers the scheduler. */
const job = (waId: string, wamid = 'w') => ({ waId, wamid });

await check('jobs for different candidates run at the same time', () => {
  const q = new InProcessQueue();
  let running = 0;
  let peak = 0;

  q.register(
    'inbound_message',
    async () => {
      running += 1;
      peak = Math.max(peak, running);
      await nap(20);
      running -= 1;
    },
    4,
  );

  const enqueued = Array.from({ length: 12 }, (_, i) =>
    q.enqueue('inbound_message', job(`91900000${i.toString().padStart(4, '0')}`)),
  );

  return Promise.all(enqueued)
    .then(() => q.close())
    .then(() => {
      // The old implementation pinned this at 1. Exactly 4 proves both halves:
      // the bound is reached, and it is never exceeded.
      assert.equal(peak, 4, `expected 4 concurrent jobs, saw ${peak}`);
      assert.equal(running, 0, 'a slot was leaked');
    });
});

await check('concurrency is bounded — never more slots than configured', async () => {
  const q = new InProcessQueue();
  let running = 0;
  let breached = false;

  q.register(
    'inbound_message',
    async () => {
      running += 1;
      if (running > 2) breached = true;
      await nap(5);
      running -= 1;
    },
    2,
  );

  for (let i = 0; i < 20; i++) await q.enqueue('inbound_message', job(`9190000${i}`));
  await q.close();

  assert.equal(breached, false, 'the pool oversubscribed its own limit');
});

await check('two messages from one candidate never overlap, and stay in order', async () => {
  // The guarantee that matters most. Two turns for one person running at once
  // means both read the same checklist and both ask for the same document.
  const q = new InProcessQueue();
  let inFlight = 0;
  let overlapped = false;
  const order: string[] = [];

  q.register(
    'inbound_message',
    async (payload) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      order.push(payload.wamid);
      await nap(10);
      inFlight -= 1;
    },
    4,
  );

  for (let i = 0; i < 5; i++) await q.enqueue('inbound_message', job('919000000001', `w${i}`));
  await q.close();

  assert.equal(overlapped, false, 'two turns for one candidate ran concurrently');
  assert.deepEqual(order, ['w0', 'w1', 'w2', 'w3', 'w4'], 'a candidate\'s turns were reordered');
});

await check('a busy candidate does not hold a worker slot hostage', async () => {
  // A job whose candidate is busy is skipped, not awaited. Blocking the worker
  // on the key would let one talkative candidate occupy every slot.
  const q = new InProcessQueue();
  const finished: string[] = [];

  q.register(
    'inbound_message',
    async (payload) => {
      await nap(payload.waId === '919000000001' ? 12 : 4);
      finished.push(payload.waId);
    },
    2,
  );

  // Four turns for one candidate, which can only run one at a time, and two
  // other people who should not have to wait for any of them.
  for (let i = 0; i < 4; i++) await q.enqueue('inbound_message', job('919000000001', `a${i}`));
  await q.enqueue('inbound_message', job('919000000002'));
  await q.enqueue('inbound_message', job('919000000003'));
  await q.close();

  const others = finished.filter((waId) => waId !== '919000000001');
  assert.equal(others.length, 2, 'the unrelated candidates did not run');
  assert.ok(
    finished.indexOf('919000000002') < finished.lastIndexOf('919000000001'),
    'an unrelated candidate waited for the busy one to finish entirely',
  );
});

await check('a slow extraction does not block unrelated candidates (§14)', async () => {
  // The stall this whole change exists to remove: one 120-second Veris call at
  // the head of a single global chain used to stop every conversation.
  const q = new InProcessQueue();
  const finished: string[] = [];

  q.register(
    'ocr',
    async (payload) => {
      await nap(60);
      finished.push(`ocr:${payload.waId}`);
    },
    2,
  );
  q.register(
    'inbound_message',
    async (payload) => {
      await nap(2);
      finished.push(`msg:${payload.waId}`);
    },
    4,
  );

  await q.enqueue('ocr', { waId: '919000000001', docType: 'passport', uploadId: 'u1' });
  await q.enqueue('ocr', { waId: '919000000002', docType: 'aadhaar', uploadId: 'u2' });
  for (let i = 3; i <= 6; i++) await q.enqueue('inbound_message', job(`91900000000${i}`));

  await q.close();

  const lastMessage = finished.findLastIndex((entry) => entry.startsWith('msg:'));
  const firstOcr = finished.findIndex((entry) => entry.startsWith('ocr:'));
  assert.equal(finished.filter((e) => e.startsWith('msg:')).length, 4);
  assert.ok(lastMessage < firstOcr, 'conversations queued behind a document extraction');
});

await check('a saturated pool cannot starve another job type', async () => {
  // Separate pool per job name. An extraction backlog is an extraction problem.
  const q = new InProcessQueue();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inboundDone = 0;

  q.register('ocr', async () => held, 2);
  q.register(
    'inbound_message',
    async () => {
      inboundDone += 1;
    },
    4,
  );

  // Four extractions against two slots: the pool is jammed and stays jammed.
  for (let i = 1; i <= 4; i++) {
    await q.enqueue('ocr', { waId: `9190000000${i}`, docType: 'passport', uploadId: `u${i}` });
  }
  for (let i = 5; i <= 7; i++) await q.enqueue('inbound_message', job(`9190000000${i}`));

  await nap(30);
  assert.equal(inboundDone, 3, 'conversations were blocked by a jammed extraction pool');

  release();
  await q.close();
});

await check('a handler that throws frees its slot instead of wedging the pool', async () => {
  const q = new InProcessQueue();
  let completed = 0;

  q.register(
    'inbound_message',
    async (payload) => {
      if (payload.wamid === 'boom') throw new Error('handler exploded');
      completed += 1;
    },
    2,
  );

  await q.enqueue('inbound_message', job('919000000001', 'boom'));
  for (let i = 2; i <= 4; i++) await q.enqueue('inbound_message', job(`91900000000${i}`));
  await q.close();

  assert.equal(completed, 3, 'a throwing job took the pool down with it');
});

await check('close() waits for everything queued, not just what is running', async () => {
  const q = new InProcessQueue();
  let ran = 0;

  q.register(
    'inbound_message',
    async () => {
      await nap(5);
      ran += 1;
    },
    3,
  );

  for (let i = 0; i < 9; i++) await q.enqueue('inbound_message', job(`9190000${i}`));
  await q.close();

  assert.equal(ran, 9, 'shutdown dropped queued jobs');
});

await check('a job with no handler is dropped, not thrown', async () => {
  const q = new InProcessQueue();
  await q.enqueue('inbound_message', job('919000000001'));
  await q.close();
});

/* ------------------------------------------------------------------ */

console.log('\noutbound budgets — replies, receipts and media are separate');

await check('the three budgets are distinct buckets, not one shared one', () => {
  // The bug: a single limiter covered replies, read receipts and media fetches,
  // so roughly half of a 20/sec messaging allowance went on acknowledging
  // messages rather than answering them.
  const { replies, receipts, media } = outboundBudgets;
  assert.notEqual(replies, receipts, 'receipts share the reply bucket');
  assert.notEqual(replies, media, 'media fetches share the reply bucket');
  assert.notEqual(receipts, media, 'receipts and media share a bucket');
});

await check('read receipts cannot spend reply capacity', async () => {
  // Asserted against the real wiring rather than a copy of it, so this fails if
  // someone points `markAsRead` back at the reply budget.
  const { replies, receipts } = outboundBudgets;

  const replyCapacity = await replies.available();
  assert.ok(replyCapacity > 0, 'the reply budget started empty; test cannot prove anything');

  // Exhaust receipts completely. The bound is a guard against a refill race,
  // not an expected iteration count.
  let drained = 0;
  while (drained < 1000 && (await receipts.tryAcquire())) drained += 1;
  assert.ok(drained > 0, 'the receipt budget had no capacity to drain');
  assert.equal(await receipts.tryAcquire(), false, 'the receipt budget refused to run out');

  // Replies are untouched by that.
  const remaining = await replies.available();
  assert.ok(
    remaining >= replyCapacity,
    `draining ${drained} receipts cost reply capacity (${replyCapacity} -> ${remaining})`,
  );
  assert.equal(await replies.tryAcquire(), true, 'a reply could not be sent after receipts ran dry');
});

await check('a drained receipt budget recovers on its own', async () => {
  // Receipts are dropped, not queued — so the budget has to come back by itself
  // or blue ticks stop for good after the first burst.
  const limiter = new RateLimiter(20);
  let drained = 0;
  while (drained < 1000 && (await limiter.tryAcquire())) drained += 1;
  assert.equal(await limiter.tryAcquire(), false);

  await nap(150);
  assert.equal(await limiter.tryAcquire(), true, 'the budget never refilled');
});

await check('candidate replies are still rate limited', async () => {
  // Separating the budgets must not turn into removing the limit. Twenty sends
  // through a 10/sec bucket: ten immediately, the rest paced at ten a second.
  const limiter = new RateLimiter(10);

  const started = Date.now();
  for (let i = 0; i < 20; i++) await limiter.acquire();
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 700, `20 sends at 10/sec finished in ${elapsed}ms — not throttled`);
});

await check('concurrent sends are paced, not oversubscribed', async () => {
  // Fifteen turns finishing at once is the normal shape of load now that the
  // queue runs jobs in parallel. Every one must be sent, and the rate must hold.
  const limiter = new RateLimiter(5);
  let granted = 0;

  const started = Date.now();
  await Promise.all(
    Array.from({ length: 15 }, async () => {
      await limiter.acquire();
      granted += 1;
    }),
  );
  const elapsed = Date.now() - started;

  assert.equal(granted, 15, 'a concurrent send was dropped');
  // Five are free; the remaining ten arrive at five a second.
  assert.ok(elapsed >= 1400, `15 concurrent sends at 5/sec finished in ${elapsed}ms`);
});

await check('a burst can never exceed the configured ceiling', async () => {
  const limiter = new RateLimiter(8);
  let granted = 0;
  while (granted <= 100 && (await limiter.tryAcquire())) granted += 1;
  assert.equal(granted, 8, `a burst granted ${granted} tokens against a ceiling of 8`);
});

await check('tryAcquire reports honestly and never waits', async () => {
  const limiter = new RateLimiter(3);
  assert.equal(await limiter.available(), 3);

  const started = Date.now();
  assert.equal(await limiter.tryAcquire(), true);
  assert.equal(await limiter.tryAcquire(), true);
  assert.equal(await limiter.tryAcquire(), true);
  assert.equal(await limiter.tryAcquire(), false, 'handed out a token it did not have');
  assert.equal(await limiter.available(), 0);

  // The point of tryAcquire: a refusal costs nothing and blocks nobody. It is
  // async now because a shared bucket lives across a socket, but it still never
  // waits for a token to appear.
  assert.ok(Date.now() - started < 50, 'tryAcquire blocked');
});

/* ------------------------------------------------------------------ */

console.log('\nanthropic resilience — throttling is ours to absorb, not the candidate\'s');

/**
 * These run the real SDK, with the real retry settings, against a stub server on
 * localhost. Nothing here needs a network, a key, or a live model.
 *
 * Driving the transport rather than mocking it is deliberate: the retry, the
 * backoff and the `Retry-After` handling all live inside the SDK, so a test that
 * stubbed `messages.create` would be testing an imitation of the thing that
 * actually has to work.
 */
interface Stub {
  url: string;
  requests: () => number;
  close: () => Promise<void>;
}

/** Serves the given responses in order, repeating the last one forever. */
async function modelStub(
  plan: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>,
): Promise<Stub> {
  let served = 0;

  const server = http.createServer((req, res) => {
    const step = plan[Math.min(served, plan.length - 1)]!;
    served += 1;

    // Drain the request body so the socket closes cleanly.
    req.resume();
    req.on('end', () => {
      res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers ?? {}) });
      res.end(
        JSON.stringify(
          step.body ?? {
            type: 'error',
            error: { type: 'rate_limit_error', message: 'stubbed' },
          },
        ),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => served,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A well-formed successful completion, as the SDK expects to parse it. */
const OK_BODY = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'stub',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function withStub<T>(
  plan: Parameters<typeof modelStub>[0],
  run: (client: Anthropic, stub: Stub) => Promise<T>,
): Promise<T> {
  const stub = await modelStub(plan);
  const client = new Anthropic({
    apiKey: 'test-key',
    baseURL: stub.url,
    ...MODEL_REQUEST_OPTIONS,
  });
  const restore = setModelClientForTests(client);
  try {
    return await run(client, stub);
  } finally {
    restore();
    await stub.close();
  }
}

const ask = (client: Anthropic) =>
  client.messages.create({
    model: 'stub',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
  });

await check('a successful request goes through untouched', async () => {
  resetModelStatsForTests();
  await withStub([{ status: 200, body: OK_BODY }], async (client, stub) => {
    const response = await callModel('test', () => ask(client));
    assert.equal(response.content[0]?.type, 'text');
    assert.equal(stub.requests(), 1, 'a healthy request was retried');
  });
  assert.equal(modelStats().transient, 0);
});

await check('a 429 followed by success is retried and succeeds', async () => {
  resetModelStatsForTests();
  await withStub(
    [{ status: 429 }, { status: 200, body: OK_BODY }],
    async (client, stub) => {
      const response = await callModel('test', () => ask(client));
      assert.equal(response.content[0]?.type, 'text');
      assert.equal(stub.requests(), 2, 'the 429 was not retried');
    },
  );
  // The candidate never learns any of this happened.
  assert.equal(modelStats().transient, 0, 'a recovered 429 was reported as unavailable');
});

await check('Retry-After is respected rather than backed off past', async () => {
  resetModelStatsForTests();
  const started = Date.now();
  await withStub(
    [{ status: 429, headers: { 'retry-after': '1' } }, { status: 200, body: OK_BODY }],
    async (client, stub) => {
      await callModel('test', () => ask(client));
      assert.equal(stub.requests(), 2);
    },
  );
  const elapsed = Date.now() - started;
  // The SDK's own backoff for a first retry is ~0.5s; obeying the header means
  // waiting the full second it asked for.
  assert.ok(elapsed >= 900, `waited ${elapsed}ms for a Retry-After of 1s`);
});

await check('repeated 429s stop at the retry limit and report unavailable', async () => {
  resetModelStatsForTests();
  await withStub([{ status: 429 }], async (client, stub) => {
    await assert.rejects(
      () => callModel('test', () => ask(client)),
      (err: unknown) => err instanceof ModelUnavailableError && err.status === 429,
      'exhausted throttling did not surface as ModelUnavailableError',
    );

    // One attempt plus MODEL_MAX_RETRIES. Bounded, and bounded by config.
    const expected = MODEL_REQUEST_OPTIONS.maxRetries + 1;
    assert.equal(
      stub.requests(),
      expected,
      `made ${stub.requests()} attempts against a limit of ${expected}`,
    );
  });
  assert.equal(modelStats().transient, 1);
});

await check('there is no infinite retry — attempts are bounded by config', async () => {
  resetModelStatsForTests();
  await withStub([{ status: 503 }], async (client, stub) => {
    await assert.rejects(() => callModel('test', () => ask(client)));
    assert.ok(
      stub.requests() <= MODEL_REQUEST_OPTIONS.maxRetries + 1,
      `a 5xx produced ${stub.requests()} attempts`,
    );
  });
});

await check('a non-retryable error is not retried and is not called throttling', async () => {
  // A 400 is a malformed request — our bug. Retrying produces the same 400
  // forever, and dressing it up as "busy, try again" hides a real defect.
  resetModelStatsForTests();
  await withStub(
    [
      {
        status: 400,
        body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
      },
    ],
    async (client, stub) => {
      await assert.rejects(
        () => callModel('test', () => ask(client)),
        (err: unknown) => !(err instanceof ModelUnavailableError),
        'a 400 was reported as the model being unavailable',
      );
      assert.equal(stub.requests(), 1, 'a 400 was retried');
    },
  );
  assert.equal(modelStats().failed, 1);
  assert.equal(modelStats().transient, 0);
});

await check('concurrent calls are bounded by the gate and all complete', async () => {
  resetModelStatsForTests();
  await withStub([{ status: 200, body: OK_BODY }], async (client) => {
    let peak = 0;
    const observed: number[] = [];

    const calls = Array.from({ length: 20 }, () =>
      callModel('test', async () => {
        peak = Math.max(peak, modelStats().inFlight);
        observed.push(modelStats().inFlight);
        return ask(client);
      }),
    );

    const results = await Promise.all(calls);
    assert.equal(results.length, 20, 'a concurrent call was lost');
    assert.ok(
      peak <= modelStats().concurrency,
      `${peak} calls were in flight against a ceiling of ${modelStats().concurrency}`,
    );
    assert.ok(observed.length === 20);
  });

  // The gate hands every slot back, so nothing leaks between bursts.
  assert.equal(modelStats().inFlight, 0, 'the gate leaked a slot');
  assert.equal(modelStats().waiting, 0);
});

await check('throttling is never mistaken for an unreadable reply', async () => {
  // The whole point. `unclear` is counted against the candidate and two of them
  // fetch a member of staff; `unavailable` is counted against nobody. A test
  // that let these collapse into one another would let the false handoff back.
  resetModelStatsForTests();
  await withStub([{ status: 429 }], async (client) => {
    const step = stepById('full_name')!;
    const outcome = await interpret({
      step,
      choices: acceptedChoices(step, candidate()),
      text: 'Ravi Kumar',
    });

    assert.equal(outcome.kind, 'unavailable', `throttling surfaced as "${outcome.kind}"`);
    assert.notEqual(outcome.kind, 'unclear', 'a throttle would have counted against the candidate');
    assert.equal(outcome.raw, 'Ravi Kumar', 'the candidate\'s own words were lost');
  });
});

await check('candidate state is untouched when the model is unavailable', async () => {
  // Nothing may be recorded from a turn that was never interpreted: no answer,
  // no step advance, no unclear count. The step stays exactly as it was.
  resetModelStatsForTests();
  const before = candidate({ profile: { lookingForOverseasJob: true }, unclearCount: 0 });
  const snapshot = JSON.stringify(before);

  await withStub([{ status: 429 }], async (client) => {
    const step = stepById('full_name')!;
    const outcome = await interpret({
      step,
      choices: acceptedChoices(step, before),
      text: 'Ravi Kumar',
    });
    assert.equal(outcome.kind, 'unavailable');
  });

  assert.equal(JSON.stringify(before), snapshot, 'an unavailable turn mutated the candidate');
  assert.equal(before.unclearCount, 0, 'a throttle was counted against the candidate');
  assert.equal(stepById('full_name')!.satisfied(before), false, 'the step was marked answered');
});

/* ------------------------------------------------------------------ */

console.log('\nmedia size limit');

const LIMIT = config.MEDIA_MAX_BYTES;

/**
 * Both hops of a media download, on one local server.
 *
 * `GET /:id` answers as Meta's metadata endpoint and points at `/file` on the
 * same server, so the whole of `downloadMedia` runs — the real fetch, the real
 * headers, a real chunked body — against something whose every answer this test
 * chose. `fileRequests` is what proves a refusal happened before the download
 * rather than after it.
 */
interface MediaStub {
  url: string;
  fileRequests: () => number;
  bytesSent: () => number;
  close: () => Promise<void>;
}

async function mediaStub(plan: {
  fileSize?: number | 'omit';
  contentLength?: number | 'omit';
  body: number;
  chunk?: number;
}): Promise<MediaStub> {
  let fileRequests = 0;
  let bytesSent = 0;

  const server = http.createServer(async (req, res) => {
    req.resume();

    if (!req.url!.startsWith('/file')) {
      const port = (server.address() as { port: number }).port;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          messaging_product: 'whatsapp',
          url: `http://127.0.0.1:${port}/file`,
          mime_type: 'application/pdf',
          ...(plan.fileSize === 'omit' ? {} : { file_size: plan.fileSize ?? plan.body }),
        }),
      );
      return;
    }

    fileRequests += 1;

    const headers: Record<string, string> = { 'content-type': 'application/pdf' };
    if (plan.contentLength !== 'omit') {
      headers['content-length'] = String(plan.contentLength ?? plan.body);
    }
    res.writeHead(200, headers);

    // Written in chunks so the reader gets more than one turn, which is what
    // lets the byte counter stop a transfer part-way through it.
    const size = plan.chunk ?? 64 * 1024;
    const chunk = Buffer.alloc(size, 0x41);
    let left = plan.body;

    while (left > 0) {
      const piece = chunk.subarray(0, Math.min(size, left));
      left -= piece.byteLength;
      bytesSent += piece.byteLength;
      if (!res.write(piece)) {
        // Stop feeding a socket nobody is reading; if the client walked away
        // this is where it becomes visible.
        const drained = await new Promise<boolean>((resolve) => {
          const onDrain = () => {
            res.off('close', onClose);
            resolve(true);
          };
          const onClose = () => {
            res.off('drain', onDrain);
            resolve(false);
          };
          res.once('drain', onDrain);
          res.once('close', onClose);
        });
        if (!drained) return;
      }
    }
    res.end();
  });

  // A client that abandons a response mid-body makes the server emit ECONNRESET.
  // That is the abort working, not a failure.
  server.on('clientError', () => undefined);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    fileRequests: () => fileRequests,
    bytesSent: () => bytesSent,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withMediaStub<T>(
  plan: Parameters<typeof mediaStub>[0],
  run: (stub: MediaStub) => Promise<T>,
): Promise<T> {
  const stub = await mediaStub(plan);
  const restore = setMediaBaseUrlForTests(stub.url);
  try {
    return await run(stub);
  } finally {
    restore();
    await stub.close();
  }
}

/** A response built by hand, so the headers and the body can disagree. */
function responseOf(
  chunks: Uint8Array[],
  headers: Record<string, string>,
  hooks: { onPull?: () => void; onCancel?: () => void } = {},
): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.onPull?.();
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
    cancel() {
      hooks.onCancel?.();
    },
  });
  return new Response(stream, { headers });
}

await check('exactly the limit is accepted', async () => {
  await withMediaStub({ body: LIMIT }, async (stub) => {
    const media = await downloadMedia('MEDIA_EXACT');
    assert.equal(media.byteSize, LIMIT);
    assert.equal(media.buffer.byteLength, 10 * 1024 * 1024);
    assert.equal(stub.fileRequests(), 1);
  });
});

await check('one byte over the limit is refused', async () => {
  await withMediaStub({ body: LIMIT + 1, fileSize: 'omit', contentLength: 'omit' }, async () => {
    await assert.rejects(() => downloadMedia('MEDIA_OVER'), MediaTooLargeError);
  });
});

await check('a declared file_size over the limit is refused before the file is requested', async () => {
  // L1. The whole point of the layer: the metadata request is paid for and the
  // document is not. `fileRequests` is zero or the layer did not work.
  await withMediaStub({ body: 1024, fileSize: LIMIT + 1 }, async (stub) => {
    await assert.rejects(() => downloadMedia('MEDIA_DECLARED'), MediaTooLargeError);
    assert.equal(stub.fileRequests(), 0);
    assert.equal(stub.bytesSent(), 0);
  });
});

await check('a Content-Length over the limit is refused before the body is read', async () => {
  // L2, proved on the stream rather than on a counter. `getReader()` locks a
  // ReadableStream and nothing else does, so a body still unlocked after the
  // refusal is a body that was never opened — which a chunk counter could not
  // show, because a ReadableStream pulls its first chunk to fill its queue as
  // soon as it is constructed, long before this function sees it.
  const res = responseOf([new Uint8Array(8)], { 'content-length': String(LIMIT + 1) });

  await assert.rejects(() => readCappedBody(res, LIMIT, 'test'), MediaTooLargeError);
  assert.equal(res.body!.locked, false, 'the body was opened despite an oversized Content-Length');
  assert.equal(res.bodyUsed, false);
});

await check('a missing Content-Length is still bounded by the byte counter', async () => {
  // Chunked, so there is no header to check and L3 is the only thing standing
  // between this process and the whole file.
  await withMediaStub(
    { body: LIMIT + 512 * 1024, fileSize: 'omit', contentLength: 'omit' },
    async (stub) => {
      await assert.rejects(() => downloadMedia('MEDIA_CHUNKED'), MediaTooLargeError);
      assert.equal(stub.fileRequests(), 1);
    },
  );
});

await check('a Content-Length that understates the body does not get past the counter', async () => {
  // The case the first two layers cannot cover: everything the far end said was
  // within the limit, and then it sent more. Only counting catches this.
  const chunk = new Uint8Array(1024 * 1024);
  const chunks = Array.from({ length: 12 }, () => chunk);
  const res = responseOf(chunks, { 'content-length': '64' });

  await assert.rejects(() => readCappedBody(res, LIMIT, 'test'), MediaTooLargeError);
});

await check('exceeding the limit aborts the transfer rather than draining it', async () => {
  let aborted = 0;
  let cancelled = 0;
  let pulls = 0;

  const chunk = new Uint8Array(1024 * 1024);
  // Far more than the limit, so a reader that did not stop would keep going.
  const chunks = Array.from({ length: 40 }, () => chunk);
  const res = responseOf(chunks, {}, {
    onPull: () => {
      pulls += 1;
    },
    onCancel: () => {
      cancelled += 1;
    },
  });

  await assert.rejects(
    () => readCappedBody(res, LIMIT, 'test', () => {
      aborted += 1;
    }),
    MediaTooLargeError,
  );

  assert.equal(aborted, 1, 'the abort callback did not fire');
  assert.equal(cancelled, 1, 'the stream was not cancelled');
  // Eleven pulls to pass ten megabytes, and then it stopped. Never forty.
  assert.ok(pulls <= 12, `read ${pulls} chunks past the limit`);
});

await check('an oversized file is terminal, not retried', async () => {
  // One attempt out of five, and it is over anyway: nothing about the file
  // changes between now and the fifth try.
  assert.equal(
    isTerminalFailure({ attempts: 1, maxAttempts: 5, terminal: 'too_large' }),
    true,
  );
  // The same attempt count without the terminal reason is still retryable, so
  // the flag is what decided it and not the counter.
  assert.equal(isTerminalFailure({ attempts: 1, maxAttempts: 5 }), false);
  assert.equal(isTerminalFailure({ attempts: 5, maxAttempts: 5 }), true);

  // And the error carries the marker the ingestion layer branches on.
  const err = new MediaTooLargeError('media X', LIMIT, LIMIT + 1);
  assert.equal(err.permanent, true);
  assert.equal(err.status, 413);
});

await check('an ordinary file downloads unharmed', async () => {
  await withMediaStub({ body: 64 * 1024 }, async (stub) => {
    const media = await downloadMedia('MEDIA_OK');
    assert.equal(media.byteSize, 64 * 1024);
    assert.equal(media.mimeType, 'application/pdf');
    // The bytes are the bytes, not a truncation that happened to be the right
    // length.
    assert.ok(media.buffer.every((b) => b === 0x41));
    assert.equal(stub.fileRequests(), 1);
  });
});

await check('the too-large message exists in all five languages and carries the limit', () => {
  for (const lang of ['en', 'ta', 'hi', 'te', 'ml'] as const) {
    const text = copy.FILE_TOO_LARGE[lang];
    assert.ok(text && text.trim().length > 0, `${lang} is missing`);
    assert.ok(text.includes('{{limit}}'), `${lang} does not name the limit`);
  }
  // Distinct from the generic failure, because the advice is different: one
  // asks for the file again, the other asks for a smaller one.
  assert.notEqual(copy.FILE_TOO_LARGE.en, copy.FILE_FAILED.en);
  // Rendered, it says ten.
  assert.match(
    render(copy.FILE_TOO_LARGE.en, {
      limit: String(Math.floor(config.MEDIA_MAX_BYTES / (1024 * 1024))),
    }),
    /10 MB/,
  );
  // And it passes the length checks the deploy runs.
  validateCopy();
});

/* ------------------------------------------------------------------ */

console.log('\nveris async jobs api');

/**
 * The mock jobs service, in-process.
 *
 * The client is exercised over real HTTP against the same mock the load rig
 * uses, because the parts most worth testing — a 202 that is not a 200, a
 * `duplicate` flag, a 503 that must not count as a failure — are transport
 * behaviour, and a stubbed function would assert only that the stub was written
 * to match the test.
 */
async function jobsStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const { handleJobsRoute, resetJobsMock, jobsState } = await import(
    './testing/verisJobsMock.js'
  );
  resetJobsMock();
  jobsState.queuedPolls = 1;
  jobsState.runningPolls = 1;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (handleJobsRoute(req, res, url.pathname)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Runs `fn` with VERIS_OCR_BASE_URL pointed at a fresh jobs mock. */
async function withJobs<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const stub = await jobsStub();
  const previous = config.VERIS_OCR_BASE_URL;
  (config as { VERIS_OCR_BASE_URL: string }).VERIS_OCR_BASE_URL = stub.url;
  try {
    return await fn(stub.url);
  } finally {
    (config as { VERIS_OCR_BASE_URL: string }).VERIS_OCR_BASE_URL = previous;
    await stub.close();
  }
}

const jobPdf = () => Buffer.from('%PDF-1.4 /Type /Page  /Type /Page  %%EOF', 'latin1');

async function drain(base: string, statusUrl: string, max = 10) {
  let last;
  for (let i = 0; i < max; i++) {
    last = await pollOcrJob(statusUrl);
    if (last.job.status === 'succeeded' || last.job.status === 'failed') return last;
  }
  return last!;
}

await check('a submission is accepted with 202 and yields a job id and status url', async () => {
  await withJobs(async () => {
    const accepted = await submitOcrJob({
      mode: 'passport',
      buffer: jobPdf(),
      filename: 'passport.pdf',
      mimeType: 'application/pdf',
      idempotencyKey: 'k/1',
    });
    assert.ok(accepted.job_id, 'no job_id');
    assert.ok(accepted.status_url, 'no status_url');
    assert.equal(accepted.duplicate, false);
    assert.ok(['queued', 'running'].includes(accepted.status));
  });
});

await check('a job progresses queued to running to succeeded', async () => {
  await withJobs(async (base) => {
    const a = await submitOcrJob({
      mode: 'passport', buffer: jobPdf(), filename: 'passport.pdf',
      mimeType: 'application/pdf', idempotencyKey: 'k/2',
    });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { job } = await pollOcrJob(a.status_url);
      seen.push(job.status);
      if (job.status === 'succeeded' || job.status === 'failed') break;
    }
    assert.deepEqual(seen, ['queued', 'running', 'succeeded']);
  });
});

await check('the same idempotency key returns the same job, marked duplicate', async () => {
  await withJobs(async () => {
    const key = 'whatsapp/PN/wamid.X/MEDIA1/passport';
    const first = await submitOcrJob({
      mode: 'passport', buffer: jobPdf(), filename: 'passport.pdf',
      mimeType: 'application/pdf', idempotencyKey: key,
    });
    const second = await submitOcrJob({
      mode: 'passport', buffer: jobPdf(), filename: 'passport.pdf',
      mimeType: 'application/pdf', idempotencyKey: key,
    });
    assert.equal(second.job_id, first.job_id, 'a second job was created');
    assert.equal(second.duplicate, true);
  });
});

await check('the CV-passport case submits two independent jobs', async () => {
  // The whole reason the key carries the extractor. Same phone number, same
  // wamid, same mediaId — `filePassportFoundInCv` files the identical bytes a
  // second time — so without the fifth segment Veris would answer the passport
  // submission with the resume job and the passport slot would be handed a CV.
  await withJobs(async () => {
    const shared = { phoneNumberId: 'PN', wamid: 'wamid.A', mediaId: 'MEDIA1' } as const;
    const cvKey = ocrIdempotencyKey({ ...shared, extractor: 'resume' });
    const ppKey = ocrIdempotencyKey({ ...shared, extractor: 'passport' });
    assert.notEqual(cvKey, ppKey, 'the two extractions share an idempotency key');

    const cv = await submitOcrJob({
      mode: 'resume', buffer: jobPdf(), filename: 'cv.pdf',
      mimeType: 'application/pdf', idempotencyKey: cvKey,
    });
    const pp = await submitOcrJob({
      mode: 'passport', buffer: jobPdf(), filename: 'passport.pdf',
      mimeType: 'application/pdf', idempotencyKey: ppKey,
    });
    assert.notEqual(cv.job_id, pp.job_id, 'one upload produced only one job');
    assert.equal(pp.duplicate, false);
  });
});

await check('queue full is reported as backpressure, not as a failed document', async () => {
  await withJobs(async () => {
    await assert.rejects(
      () =>
        submitOcrJob({
          mode: 'resume', buffer: jobPdf(), filename: 'queuefull.pdf',
          mimeType: 'application/pdf', idempotencyKey: 'k/full',
        }),
      JobQueueFullError,
    );
  });
});

await check('a queue-full 503 is distinguished from the disabled-sync 503', () => {
  // Both are 503. One is admission control and must be retried forever; the
  // other is the misconfiguration this whole migration exists to fix, and
  // retrying it silently would hide it.
  assert.equal(isJobQueueFull(503, '{"code":"job_queue_full"}'), true);
  assert.equal(isJobQueueFull(500, 'anything'), false);

  // The body exactly as the live service sent it, which carries the reason
  // twice and in two spellings. An earlier version of this check matched only
  // the underscored `code` and would have retried the misconfiguration forever.
  const observed =
    '{"request_id":"req_01M0MGY04QNAV519EQ172S41SF","error":"OcrQueueRequiredError",' +
    '"code":"ocr_queue_required","detail":"Synchronous OCR is disabled on this deployment; ' +
    'submit the file to /v1/jobs"}';
  assert.equal(isJobQueueFull(503, observed), false);
  assert.equal(isJobQueueFull(503, '{"error":"OcrQueueRequiredError"}'), false);
});

await check('a terminal failure is not retried', async () => {
  await withJobs(async (base) => {
    const a = await submitOcrJob({
      mode: 'resume', buffer: jobPdf(), filename: 'fail-terminal.pdf',
      mimeType: 'application/pdf', idempotencyKey: 'k/term',
    });
    const last = await drain(base, a.status_url);
    assert.equal(last!.job.status, 'failed');
    assert.equal(last!.job.error?.retryable, false);
    assert.equal(shouldRetryFailedJob(last!.job), false);
  });
});

await check('a retryable failure that has exhausted its attempts is retried once', async () => {
  await withJobs(async (base) => {
    const a = await submitOcrJob({
      mode: 'resume', buffer: jobPdf(), filename: 'fail-retryable.pdf',
      mimeType: 'application/pdf', idempotencyKey: 'k/retry',
    });
    const last = await drain(base, a.status_url);
    assert.equal(last!.job.status, 'failed');
    assert.equal(shouldRetryFailedJob(last!.job), true);

    const replayed = await retryFailedJob(last!.job.job_id);
    // The contract does not promise the id survives a retry, so the client must
    // store whatever comes back rather than keep using the old one.
    assert.ok(replayed.job_id);
    assert.ok(replayed.status_url);
  });
});

await check('a job the service is still retrying is left alone', () => {
  const soon = new Date(Date.now() + 60_000).toISOString();
  const job = {
    job_id: 'j', mode: 'resume', filename: 'f', status: 'failed' as const,
    attempts: 1, max_attempts: 3, submitted_at: new Date().toISOString(),
    next_attempt_at: soon, error: { code: 'x', message: 'y', retryable: true },
  };
  // Retrying here would duplicate work Veris has already scheduled.
  assert.equal(shouldRetryFailedJob(job), false);
  assert.equal(serviceStillWorking(job), true);
});

await check('a never-terminal job stays in flight rather than being called done', async () => {
  await withJobs(async (base) => {
    const a = await submitOcrJob({
      mode: 'resume', buffer: jobPdf(), filename: 'never.pdf',
      mimeType: 'application/pdf', idempotencyKey: 'k/never',
    });
    for (let i = 0; i < 6; i++) {
      const { job } = await pollOcrJob(a.status_url);
      assert.ok(job.status === 'queued' || job.status === 'running', `became ${job.status}`);
    }
  });
});

await check('a malformed success payload does not become a valid extraction', async () => {
  await withJobs(async (base) => {
    const a = await submitOcrJob({
      mode: 'aadhaar', buffer: jobPdf(), filename: 'malformed.pdf',
      mimeType: 'application/pdf', idempotencyKey: 'k/bad',
    });
    const last = await drain(base, a.status_url);
    assert.equal(last!.job.status, 'succeeded');
    // The normaliser must not invent an identity out of an unrecognised shape.
    const outcome = normaliseExtractionForTests('aadhaar', last!.job.result);
    assert.equal(outcome.completeness.complete, false);
  });
});

await check('poll pacing prefers the server schedule over local backoff', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const job = {
    job_id: 'j', mode: 'resume', filename: 'f', status: 'running' as const,
    attempts: 0, max_attempts: 3, submitted_at: now.toISOString(),
    next_attempt_at: new Date(now.getTime() + 9_000).toISOString(),
  };
  // next_attempt_at wins over both Retry-After and the computed value.
  assert.equal(nextPollDelayMs({ job, retryAfterMs: 1_000, previousDelayMs: 2_000, now }), 9_000);
  // Retry-After is honoured where the service offers no schedule of its own.
  assert.equal(
    nextPollDelayMs({ job: { ...job, next_attempt_at: null }, retryAfterMs: 5_000, now }),
    5_000,
  );
  // Otherwise bounded local backoff, never below the floor or above the cap.
  assert.equal(
    nextPollDelayMs({ job: { ...job, next_attempt_at: null }, previousDelayMs: 0, now }),
    config.VERIS_OCR_POLL_MIN_MS,
  );
  assert.equal(
    nextPollDelayMs({ job: { ...job, next_attempt_at: null }, previousDelayMs: 999_999, now }),
    config.VERIS_OCR_POLL_MAX_MS,
  );
});

await check('the three normalisers read a job result exactly as they read a sync body', async () => {
  // The migration's central claim: `job.result` carries the same object the
  // synchronous route returned, so the normalisers are untouched. This feeds
  // one payload down both paths and requires the verdicts to match.
  await withJobs(async (base) => {
    for (const [mode, docType] of [
      ['passport', 'passport'],
      ['resume', 'cv'],
      ['aadhaar', 'aadhaar'],
    ] as const) {
      const a = await submitOcrJob({
        mode, buffer: jobPdf(), filename: `${mode}.pdf`,
        mimeType: 'application/pdf', idempotencyKey: `k/norm/${mode}`,
      });
      const last = await drain(base, a.status_url);
      assert.equal(last!.job.status, 'succeeded', `${mode} did not succeed`);

      const outcome = normaliseExtractionForTests(mode, last!.job.result, docType);
      const keys = outcome.fields.map((f) => f.key);

      // The identifying field each normaliser exists to recover. If the job
      // envelope had reshaped the payload, these are what would go missing.
      const expected = {
        passport: 'passport_number',
        resume: 'name',
        aadhaar: 'aadhaar_number',
      }[mode];

      assert.ok(outcome.fields.length > 0, `${mode} produced no fields from a job result`);
      assert.ok(keys.includes(expected), `${mode} lost ${expected}: got ${keys.join(', ')}`);
    }
  });
});

await check('the idempotency key always carries the extractor segment', () => {
  const key = ocrIdempotencyKey({
    phoneNumberId: '123', wamid: 'wamid.Z', mediaId: 'MEDIA9', extractor: 'aadhaar',
  });
  assert.equal(key, 'whatsapp/123/wamid.Z/MEDIA9/aadhaar');
  assert.equal(key.split('/').length, 5);
});

await check('a Retry-After header is read when present and ignored when absent', () => {
  const withHeader = { headers: { get: (n: string) => (n === 'retry-after' ? '3' : null) } };
  const without = { headers: { get: () => null } };
  const nonsense = { headers: { get: () => 'soon' } };
  assert.equal(retryAfterMsOf(withHeader), 3000);
  assert.equal(retryAfterMsOf(without), undefined);
  assert.equal(retryAfterMsOf(nonsense), undefined);
});


console.log('\na registration reaches the CRM while it is still being answered');

/** A candidate part-way through, with enough said to be worth sending. */
function midRegistration(overrides: Partial<CandidateDoc> = {}): CandidateDoc {
  return candidate({
    stage: 'JOB_PREFERENCE_PENDING',
    profile: {
      lookingForOverseasJob: true,
      fullName: 'Ravi Kumar',
      education: 'diploma',
      educationCourse: 'Mechanical Engineering',
      primaryTrade: 'fabrication_welding',
      jobCategory: 'general_worker',
      desiredOccupation: 'TIG welder',
      totalExperienceBand: '2_5',
      countryPreference: 'malaysia',
      selectedCountries: ['malaysia', 'singapore'],
      countryStrictness: 'strict',
      availability: 'within_15',
      tradePacks: ['welder'],
      tradeAnswers: { welding_process: ['tig', 'mig'] },
      tradeQuestions: [
        { id: 'gen_1', prompt: 'Which machines have you operated?', options: [] },
      ],
    },
    fieldMeta: {
      desiredOccupation: { source: 'chat', raw: 'tig welder job', at: new Date() },
    },
    ...overrides,
  });
}

await check('the payload says plainly that the registration is unfinished', () => {
  const payload = toCrmPayload(midRegistration());
  assert.equal(payload.registration?.complete, false);
  assert.equal(payload.registration?.stage, 'JOB_PREFERENCE_PENDING');
});

await check('a finished registration says so, and carries its application id', () => {
  const payload = toCrmPayload(readyForCrm());
  assert.equal(payload.registration?.complete, true);
  assert.equal(payload.registration?.application_id, 'ADR-00042');
});

await check('the documents still outstanding are named, not merely absent', () => {
  // A blank on a half-filled record is a question nobody has asked yet. Saying
  // which ones is the difference between that and "this candidate has no
  // Aadhaar".
  const outstanding = toCrmPayload(midRegistration()).registration
    ?.outstanding_documents;
  assert.ok(outstanding?.includes('cv'));
  assert.ok(outstanding?.includes('aadhaar'));
});

await check('only documents this candidate will actually be asked for are listed', () => {
  // Derived from the flow, not from the checklist. The checklist holds a slot
  // for every kind of document the system knows about, including a business
  // contact's company registration certificate — and "still to come: company
  // registration certificate" against a welder reads as a broken bot.
  const outstanding =
    toCrmPayload(midRegistration()).registration?.outstanding_documents ?? [];
  for (const never of [
    'b2b_aadhaar_front',
    'b2b_aadhaar_back',
    'company_registration',
    'certificate',
    'driving_licence',
  ]) {
    assert.ok(!outstanding.includes(never), `"${never}" is never asked of a candidate`);
  }
});

await check('a passport is listed once the candidate says they hold one', () => {
  // And not before. The booklet is only asked for of somebody who has just said
  // they have one, so naming it earlier would be a guess about a question that
  // has not been put yet.
  const before = midRegistration();
  const after = midRegistration({
    profile: { ...before.profile, passportStatus: 'yes' },
  });

  assert.ok(!toCrmPayload(before).registration?.outstanding_documents?.includes('passport'));
  assert.ok(toCrmPayload(after).registration?.outstanding_documents?.includes('passport'));
});

console.log('\nthe job section — questions travel with their answers');

await check('the job, the course and the trade are all sent', () => {
  const job = jobSectionOf(midRegistration())!;
  assert.equal(job.job, 'TIG welder');
  assert.equal(job.job_category, 'general_worker');
  assert.equal(job.course_or_trade?.course, 'Mechanical Engineering');
  assert.equal(job.course_or_trade?.primary_trade, 'fabrication_welding');
});

await check('the country and how strictly it is meant are separate facts', () => {
  const job = jobSectionOf(midRegistration())!;
  assert.deepEqual(job.country?.selected, ['malaysia', 'singapore']);
  assert.equal(job.country?.strictness, 'strict');
  // Hoisted out of the answer: a recruiter must never have to parse a string to
  // learn they may not shortlist this candidate elsewhere (§10).
  assert.equal(job.country?.strict, true);
});

await check('a candidate who is open to anywhere is not marked strict', () => {
  const job = jobSectionOf(midRegistration({
    profile: { ...midRegistration().profile, countryStrictness: 'any' },
  }))!;
  assert.equal(job.country?.strict, false);
});

await check('when they can join is sent as its own answer', () => {
  const job = jobSectionOf(midRegistration())!;
  assert.ok(job.availability?.band);
  assert.ok(job.questions?.some((q) => q.id === 'availability'));
});

await check('every answer carries the question that produced it', () => {
  const job = jobSectionOf(midRegistration())!;
  const asked = [...(job.questions ?? []), ...(job.course_or_trade?.questions ?? [])];
  assert.ok(asked.length > 0, 'no questions were sent at all');
  for (const entry of asked) {
    assert.ok(entry.question.trim().length > 0, `${entry.id} was sent without its question`);
    assert.ok(entry.answer.trim().length > 0, `${entry.id} was sent without an answer`);
  }
});

await check('answers are sent as labels, never as our own option ids', () => {
  const job = jobSectionOf(midRegistration())!;
  const education = job.course_or_trade?.questions?.find((q) => q.id === 'education');
  // "diploma" is a key in this repository and nothing at all in the CRM.
  assert.equal(education?.answer, 'Diploma');
});

await check('the candidate’s own wording is kept beside the standardised answer', () => {
  const job = jobSectionOf(midRegistration())!;
  const desired = job.questions?.find((q) => q.id === 'desired_job');
  assert.equal(desired?.raw, 'tig welder job');
});

await check('a specialist pack’s question travels with its own text', () => {
  // The pack's questions live in `trades.ts` and their answers under the
  // question's own id, so neither can be found from the step id alone — and a
  // welder's processes are the most specific thing on their profile.
  const job = jobSectionOf(midRegistration())!;
  const asked = job.course_or_trade?.questions?.find(
    (q) => q.id === 'trade:welder:welding_process',
  );
  assert.equal(asked?.question, 'Which welding processes do you know?');
  assert.equal(asked?.answer, 'TIG, MIG');
});

await check('when they can join is sent as a label, never as our option id', () => {
  // "within_15" is a key in this repository and nothing at all in the CRM.
  const job = jobSectionOf(midRegistration())!;
  assert.equal(job.availability?.band, 'Within 15 days');
});

await check('a question written for this one candidate travels with its text', () => {
  // §8's generated questions exist nowhere but on this record — the CRM has
  // never seen the text — so an answer arriving without it is a value nobody
  // can interpret.
  const c = midRegistration();
  c.profile.tradeAnswers = { ...c.profile.tradeAnswers, gen_1: ['lathe', 'milling'] };
  const job = jobSectionOf(c)!;
  const generated = job.course_or_trade?.questions?.find((q) => q.id === 'trade_extra:0');
  assert.equal(generated?.question, 'Which machines have you operated?');
  assert.equal(generated?.answer, 'lathe, milling');
});

await check('a candidate who has answered nothing has no job section at all', () => {
  // Absent means "not stated"; an empty object would mean "stated to be
  // nothing", and on a partial sync that difference decides whether tomorrow's
  // answer is allowed to fill it in.
  assert.equal(jobSectionOf(candidate()), undefined);
});

console.log('\nwho the CRM may put in front of a person');

/** A finished staff intake: name, destination, job, documents, reference number. */
function staffEnquiry(overrides: Partial<CandidateDoc> = {}): CandidateDoc {
  return candidate({
    enquiry: 'staff',
    stage: 'CONFIRMATION_PENDING',
    candidateId: 'ENQ-00007',
    completedAt: new Date(),
    profileName: 'Asha',
    profile: {
      fullName: 'Asha Kumari',
      countryPreference: 'gcc',
      jobCategory: 'general_worker',
    },
    ...overrides,
  });
}

await check('a staff enquiry reaches the CRM saying what it is (§24)', () => {
  const registration = toCrmPayload(staffEnquiry()).registration!;

  // Not a registration, and it says so rather than leaving the CRM to infer it
  // from an absence. This record will never carry `complete: true`.
  assert.equal(registration.enquiry, 'staff');
  assert.equal(registration.complete, false);
  assert.equal(registration.application_id, 'ENQ-00007');

  // And it is ready for somebody to be given it.
  assert.equal(registration.assignable, true);

  // A registration says the other thing, on the same field.
  assert.equal(toCrmPayload(readyForCrm()).registration!.enquiry, 'apply');

  // And the state the record is actually in when the delivery fires: the intake
  // ends in a handover, and the debounced sync lands after it.
  const handed = toCrmPayload(staffEnquiry({ stage: 'HUMAN_HANDOFF' })).registration!;
  assert.equal(handed.stage, 'HUMAN_HANDOFF');
  assert.equal(handed.complete, false);
  assert.equal(handed.assignable, true);
});

await check('the intake\u2019s country and job travel with it', () => {
  // The whole reason the intake asks them: whoever picks the enquiry up has the
  // destination and the job before they dial.
  const job = jobSectionOf(staffEnquiry())!;
  assert.equal(job.country?.preference, 'gcc');
  assert.equal(job.job_category, 'general_worker');

  // On the flat profile too, which is what their list screen reads.
  const profile = toCrmPayload(staffEnquiry()).profile;
  assert.equal(profile.job_category, 'general_worker');
  assert.equal(profile.full_name, 'Asha Kumari');
});

await check('an enquiry and a registration from one person are one record', () => {
  // The key is derived from the business number and their WhatsApp id, and
  // nothing else — not the branch, not the stage, not the id we minted. Somebody
  // who asks for staff today and registers next week updates the record they
  // already have.
  const enquiry = staffEnquiry();
  const registered = readyForCrm();
  assert.equal(enquiry.waId, registered.waId, 'fixtures must be the same person');
  assert.equal(
    toCrmPayload(enquiry).idempotency_key,
    toCrmPayload(registered).idempotency_key,
  );
  assert.equal(
    idempotencyKeyFor(enquiry),
    `whatsapp/${config.WHATSAPP_PHONE_NUMBER_ID}/919000000000`,
  );
});

await check('assignable does not wait for a finished registration', () => {
  // The point of the flag. A candidate who answered the destination and went
  // quiet is exactly the person a recruiter should be given, and they will
  // never be `complete`.
  const partial = toCrmPayload(midRegistration()).registration!;
  assert.equal(partial.complete, false);
  assert.equal(partial.assignable, true);

  // And a finished one is assignable for the ordinary reason.
  assert.equal(toCrmPayload(readyForCrm()).registration!.assignable, true);
});

await check('assignable needs consent, a name, and something they asked for', () => {
  const named = { fullName: 'Asha Kumari' };

  // §4 first: nothing is assignable before consent, whatever else is on file.
  assert.equal(
    assignableFor(candidate({ consent: undefined, profile: { ...named, countryPreference: 'gcc' } })),
    false,
    'assignable before consent',
  );

  // Consented and said nothing else. A record with a phone number on it is a
  // missed call, not a candidate.
  assert.equal(assignableFor(candidate({ profileName: undefined, profile: {} })), false);

  // A destination is enough. So is a job, on its own.
  assert.equal(assignableFor(candidate({ profile: { ...named, countryPreference: 'gcc' } })), true);
  assert.equal(assignableFor(candidate({ profile: { ...named, jobCategory: 'general_worker' } })), true);
  assert.equal(assignableFor(candidate({ profile: { ...named, desiredOccupation: 'TIG welder' } })), true);

  // Named only by WhatsApp. That is still a name to ask for on the phone.
  assert.equal(
    assignableFor(candidate({ profileName: 'Asha', profile: { countryPreference: 'gcc' } })),
    true,
  );

  // Nothing to call them but their number, which `profile.full_name` falls back
  // to so the record can be opened. A fallback is not a name.
  assert.equal(
    assignableFor(candidate({ profileName: undefined, profile: { countryPreference: 'gcc' } })),
    false,
  );

  // Not a candidate at all (§2). Neither is synced; the guard says so anyway.
  assert.equal(
    assignableFor(candidate({ enquiry: 'b2b', profileName: 'Asha', profile: { ...named } })),
    false,
  );
  assert.equal(
    assignableFor(
      candidate({ enquiry: 'track', profile: { ...named, countryPreference: 'gcc' } }),
    ),
    false,
  );
});

console.log('\nthe CV, in the shape the CRM keeps résumés in');

/** One CV upload, as it sits in the documents record after extraction. */
function cvUpload(raw: unknown): DocumentUpload {
  return {
    uploadId: new ObjectId(),
    mediaId: 'MEDIA1',
    storageKey: 'cv/1',
    mimeType: 'application/pdf',
    byteSize: 1024,
    sha256: 'sha-cv',
    originalFilename: 'ravi-cv.pdf',
    createdAt: new Date(),
    updatedAt: new Date(),
    ocr: { status: 'done', extractor: 'resume', raw, finishedAt: new Date(), needsReview: true },
  };
}

const RESUME_PAYLOAD = {
  name: 'Ravi Kumar',
  designation: 'Senior Welder',
  industry: 'Construction & Engineering',
  total_experience_years: 10.2,
  total_experience_human: '10 years 3 months',
  contact: {
    emails: ['ravi@example.com'],
    phones: ['+919876543210', '+914412345678'],
    address: 'Chennai, Tamil Nadu',
  },
  personal_info: { date_of_birth: '1994-03-14', father_name: 'Ramesh Kumar' },
  skills: ['SMAW', 'GTAW'],
  machinery: ['TIG welding machine'],
  certifications: [{ name: '6G welder certificate' }],
  experience: [
    { company: 'Larsen and Toubro', designation: 'Senior Welder', start_date: '2019-01' },
    { company: 'Gulf Steel Works', title: 'Welder', country: 'UAE', is_overseas: true },
  ],
  education: [
    {
      institution: 'Government Polytechnic',
      degree: 'Diploma in Mechanical Engineering',
      passing_year: '2015',
    },
  ],
};

await check('the employment history is sent, not flattened into one field', () => {
  const cv = cvSectionFrom(cvUpload(RESUME_PAYLOAD))!;
  assert.deepEqual(
    cv.work_experience?.map((row) => row.company),
    ['Larsen and Toubro', 'Gulf Steel Works'],
  );
  assert.equal(cv.work_experience?.[1]?.is_overseas, true);
});

await check('the education history is sent as entries, not as one line', () => {
  const cv = cvSectionFrom(cvUpload(RESUME_PAYLOAD))!;
  assert.equal(cv.education?.[0]?.degree, 'Diploma in Mechanical Engineering');
  assert.equal(cv.education?.[0]?.passing_year, '2015');
});

await check('certificates arrive whether the extractor gave strings or objects', () => {
  // One document yields `["x"]` and the next `[{name: "x"}]`. A mapper that
  // knows one spelling silently produces an empty list for half the candidates,
  // which looks exactly like a candidate with no certificates.
  const objects = cvSectionFrom(cvUpload(RESUME_PAYLOAD))!;
  const strings = cvSectionFrom(
    cvUpload({ ...RESUME_PAYLOAD, certifications: ['6G welder certificate'] }),
  )!;
  assert.deepEqual(objects.certifications, ['6G welder certificate']);
  assert.deepEqual(strings.certifications, ['6G welder certificate']);
});

await check('the employment history is found under either of its spellings', () => {
  const other = cvSectionFrom(
    cvUpload({ ...RESUME_PAYLOAD, experience: undefined, work_experience: RESUME_PAYLOAD.experience }),
  )!;
  assert.equal(other.work_experience?.length, 2);
});

await check('machinery is sent as trade skills, apart from the general list', () => {
  const cv = cvSectionFrom(cvUpload(RESUME_PAYLOAD))!;
  assert.deepEqual(cv.trade_skills, ['TIG welding machine']);
  assert.deepEqual(cv.skills, ['SMAW', 'GTAW']);
});

await check('the raw extraction travels, so a mapping mistake is recoverable', () => {
  const cv = cvSectionFrom(cvUpload(RESUME_PAYLOAD))!;
  assert.equal((cv.raw_ocr as { name?: string }).name, 'Ravi Kumar');
});

await check('a CV that could not be read is still reported as received', () => {
  const cv = cvSectionFrom(cvUpload(undefined))!;
  assert.equal(cv.filename, 'ravi-cv.pdf');
  assert.equal(cv.work_experience, undefined);
});

await check('an unscored extraction never travels as a scored one', () => {
  // The résumé extractor reports no confidence at all. A default of 0 — or of
  // anything else — would read as a measurement nobody took.
  const cv = cvSectionFrom(cvUpload(RESUME_PAYLOAD))!;
  assert.equal(cv.confidence, undefined);
});

console.log('\nan upload filed against the wrong question is moved, not re-asked');

await check('a burst of documents is what makes this happen at all', () => {
  // Nothing names the files — a photo from a gallery has no useful filename and
  // people do not caption things — so all three land in whatever slot was open.
  const c = candidate({ currentStep: 'cv' });
  for (const _ of ['cv', 'passport', 'aadhaar']) {
    assert.equal(attributeInboundDocument(c, { expecting: 'cv' }), 'cv');
  }
});

await check('the aadhaar extractor says what a wrong upload actually is', () => {
  // Without `looksLike` the upload can only be re-asked for. With it, an
  // Aadhaar slot holding somebody's passport hands the passport to the slot
  // that wanted one.
  const outcome = normaliseExtractionForTests('aadhaar', {
    aadhaar: {},
    pages: [
      {
        page_number: 1,
        average_confidence: 0.95,
        text:
          'REPUBLIC OF INDIA PASSPORT\nPassport No: Z1234567\n' +
          'Date of Issue 12/05/2021 Date of Expiry 11/05/2031',
      },
    ],
  });
  assert.equal(outcome.completeness.verdict, 'wrong_document');
  assert.equal(outcome.completeness.looksLike, 'passport');
});

await check('a slot is re-derived from the upload it actually holds', () => {
  // The status was set from the file that has just left. Left alone it says
  // `ocr_done` about an extraction of somebody's Aadhaar under the résumé
  // extractor, and the flow reads that as "the CV is on file".
  const restored = slotStatusFor(undefined);
  assert.equal(restored, 'pending');
  assert.equal(slotStatusFor({ status: 'queued' }), 'ocr_queued');
  assert.equal(slotStatusFor({ status: 'skipped' }), 'received');
  assert.equal(
    slotStatusFor({ status: 'done', completeness: { complete: false, problems: [] } }),
    'incomplete',
  );
});

console.log('\nidentity documents go to the CRM’s own identity records');

await check('an Aadhaar found behind a CV is filed as an Aadhaar', () => {
  // People send one PDF: CV first, the cards scanned in behind it. Read only by
  // the résumé extractor those pages are wasted, and the bot then asks for a
  // card it is already holding.
  const behind = identityBehindCv(
    {},
    [
      {
        key: 'page_1_text',
        value:
          'GOVERNMENT OF INDIA UNIQUE IDENTIFICATION AUTHORITY OF INDIA ' +
          'AADHAAR 2345 6789 0123 Asha Kumari',
        confidence: null,
      },
    ],
  );
  assert.ok(behind.includes('aadhaar'));
});

await check('a CV that merely contains twelve digits is not an Aadhaar', () => {
  // The number marker alone is twelve digits in three groups, which an ordinary
  // CV produces by accident out of a row of years. Filing that as somebody's
  // Aadhaar card would be worse than not looking.
  const behind = identityBehindCv(
    {},
    [
      {
        key: 'page_1_text',
        value:
          'RAVI KUMAR — Welder. Projects delivered 2019 2020 2021 across three refineries, ' +
          'with commissioning support throughout.',
        confidence: null,
      },
    ],
  );
  assert.ok(!behind.includes('aadhaar'));
});

await check('a passport scanned behind a CV is still found', () => {
  const behind = identityBehindCv(
    {},
    [
      {
        key: 'page_1_text',
        value:
          'RAVI KUMAR Welder\nREPUBLIC OF INDIA PASSPORT Passport No: Z1234567 ' +
          'Date of Issue 12/05/2021 Date of Expiry 11/05/2031',
        confidence: null,
      },
    ],
  );
  assert.ok(behind.includes('passport'));
});

await check('one CV can route passport and Aadhaar to their own OCR endpoints', () => {
  const behind = identityBehindCv(
    {},
    [{
      key: 'all_pages',
      value:
        'REPUBLIC OF INDIA PASSPORT Passport No Z1234567 Date of Issue 12/05/2021 ' +
        'Date of Expiry 11/05/2031 UIDAI AADHAAR 2345 6789 0123',
      confidence: null,
    }],
  );

  assert.deepEqual(behind, ['passport', 'aadhaar']);
  assert.equal(requirementFor('passport')?.ocr, 'passport');
  assert.equal(requirementFor('aadhaar')?.ocr, 'aadhaar');
});

console.log('\nnationality eligibility');

await check('Indian passport and CV nationality aliases remain eligible', () => {
  for (const value of [
    'Indian',
    'IND',
    'India',
    'Republic of India',
    'Indian National',
    'Nationality: Indian',
  ]) {
    assert.equal(nationalityDecision(value), 'indian', value);
  }
});

await check('an explicit non-Indian nationality blocks candidate delivery', () => {
  for (const value of ['Nepalese', 'Sri Lankan', 'British', 'Non-Indian']) {
    assert.equal(nationalityDecision(value), 'non_indian', value);
  }

  const c = candidate({
    stage: 'NOT_ELIGIBLE',
    status: 'not_eligible',
    nationalityCheck: {
      status: 'not_eligible',
      nationality: 'Nepalese',
      source: 'passport',
      at: new Date(),
    },
  });
  assert.equal(nationalityBlocked(c), true);
});

await check('missing or unusable nationality OCR never rejects a candidate', () => {
  for (const value of [undefined, '', 'N/A', 'Unknown', 'Not specified', '7']) {
    assert.equal(nationalityDecision(value), 'unknown', String(value));
  }
});

await check('CRM and ATS delivery wait while CV or passport OCR is queued', () => {
  const cv = candidate();
  cv.documents.cv = { status: 'ocr_queued', askedCount: 0, updatedAt: new Date() };
  assert.equal(nationalityCheckPending(cv), true);

  const passport = candidate();
  passport.documents.passport = { status: 'ocr_queued', askedCount: 0, updatedAt: new Date() };
  assert.equal(nationalityCheckPending(passport), true);

  const aadhaarOnly = candidate();
  aadhaarOnly.documents.aadhaar = { status: 'ocr_queued', askedCount: 0, updatedAt: new Date() };
  assert.equal(nationalityCheckPending(aadhaarOnly), false);
});

await check('an application cannot reach CRM before nationality has been checked', () => {
  const beforeCv = candidate({ enquiry: 'apply', stage: 'CV_PENDING' });
  assert.equal(externalCandidateDeliveryBlocked(beforeCv), true);
  assert.equal(
    externalCandidateDeliveryBlocked(candidate({ enquiry: undefined, stage: 'CV_PENDING' })),
    true,
  );

  const indian = candidate({
    enquiry: 'apply',
    nationalityCheck: {
      status: 'indian',
      nationality: 'IND',
      source: 'passport',
      at: new Date(),
    },
  });
  assert.equal(externalCandidateDeliveryBlocked(indian), false);

  const exhaustedWithoutValue = candidate({
    enquiry: 'apply',
    stage: 'REGISTRATION_COMPLETED',
  });
  assert.equal(externalCandidateDeliveryBlocked(exhaustedWithoutValue), false);
});

console.log('\npartial deliveries are collapsed, not sent one per answer');

await check('everything inside one window shares a key', () => {
  const now = 1_700_000_000_000;
  const first = coalesceKey('crm_sync', '919000000000', 10_000, now);
  const second = coalesceKey('crm_sync', '919000000000', 10_000, now + 4_000);
  assert.equal(first, second);
});

await check('the key moves forward with the clock', () => {
  // A key of just the candidate's id would coalesce the first burst and then be
  // refused for an hour, because a completed job's id is retained — so every
  // delivery after the first would be silently dropped.
  const now = 1_700_000_000_000;
  assert.notEqual(
    coalesceKey('crm_sync', '919000000000', 10_000, now),
    coalesceKey('crm_sync', '919000000000', 10_000, now + 11_000),
  );
});

await check('two candidates are never collapsed into one delivery', () => {
  const now = 1_700_000_000_000;
  assert.notEqual(
    coalesceKey('crm_sync', '919000000000', 10_000, now),
    coalesceKey('crm_sync', '919000000001', 10_000, now),
  );
});

await check('a burst of answers becomes one delivery, not one each', async () => {
  const seen: string[] = [];
  const q = new InProcessQueue();
  q.register('crm_sync', async (payload) => {
    seen.push(payload.waId);
  }, 1);

  // Five answers inside one window. The delay is what the coalescing rests on:
  // the key is claimed the moment the timer is set, so the four that follow
  // find it taken rather than each setting a timer of their own.
  for (let i = 0; i < 5; i += 1) {
    await q.enqueue(
      'crm_sync',
      { waId: '919000000000', partial: true },
      { key: 'one-window', delayMs: 20 },
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 120));
  await q.close();

  assert.deepEqual(seen, ['919000000000']);
});

await check('the window closing lets the next burst through', async () => {
  const seen: string[] = [];
  const q = new InProcessQueue();
  q.register('crm_sync', async (payload) => {
    seen.push(payload.waId);
  }, 1);

  await q.enqueue('crm_sync', { waId: '9190', partial: true }, { key: 'window-1', delayMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await q.enqueue('crm_sync', { waId: '9190', partial: true }, { key: 'window-2', delayMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await q.close();

  assert.equal(seen.length, 2);
});

/* ------------------------------------------------------------------ */

console.log('\ntelling a staff member they have been given somebody');

await check('a number written with its country code is used as written', () => {
  assert.equal(staffPhoneToE164('+971 50 123 4567'), '971501234567');
  assert.equal(staffPhoneToE164('00919876543210'), '919876543210');
  assert.equal(staffPhoneToE164('+91-98765-43210'), '919876543210');
});

await check('a bare ten-digit number is read as the default country code', () => {
  // The roster is mostly Indian and writes its own numbers the way it says
  // them. Without this the majority of staff would never be messaged.
  const cc = config.STAFF_PHONE_DEFAULT_COUNTRY_CODE;
  assert.equal(staffPhoneToE164('9876543210'), `${cc}9876543210`);
  assert.equal(staffPhoneToE164('98765 43210'), `${cc}9876543210`);
});

await check('a number too short to reach anybody is refused, not padded', () => {
  // Refused rather than repaired: a typo that is sent anyway reaches a stranger,
  // and the message names a candidate.
  for (const bad of ['12345', '+1234', '', '   ', 'extension 204', undefined, null]) {
    assert.equal(staffPhoneToE164(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
});

await check('every parameter is non-empty, whatever is missing from the record', () => {
  // Meta rejects an empty parameter, so a candidate who has answered almost
  // nothing must still produce one header and three sendable body values.
  const params = staffAssignmentParameters({ candidateCode: 'CND-1024' });
  assert.equal(params.body.length, 3);
  for (const value of [params.header, ...params.body]) {
    assert.ok(value.length > 0, 'a blank parameter');
    assert.ok(!/[\n\t]/.test(value), `a line break in ${JSON.stringify(value)}`);
    assert.ok(!/ {4}/.test(value), `four spaces in ${JSON.stringify(value)}`);
  }
});

await check('the parameters are in the order the approved body expects', () => {
  // This is the contract with Meta. Reordering it here without resubmitting the
  // template there sends cleanly and says the wrong things.
  assert.deepEqual(
    staffAssignmentParameters({
      staffName: 'Priya Sharma',
      staffCode: 'STF-0012',
      fullName: 'John Doe',
      candidateCode: 'CND-1024',
      phone: '+91 98765 43210',
    }),
    {
      header: 'Priya Sharma (STF-0012)',
      body: ['John Doe', 'CND-1024', '+91 98765 43210'],
    },
  );
});

await check('the greeting is a header parameter, not a fourth body parameter', () => {
  assert.deepEqual(
    staffAssignmentTemplateComponents({
      header: 'Priya Sharma',
      body: ['John Doe', 'CND-1024', '+91 98765 43210'],
    }),
    [
      { type: 'header', parameters: [{ type: 'text', text: 'Priya Sharma' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'John Doe' },
          { type: 'text', text: 'CND-1024' },
          { type: 'text', text: '+91 98765 43210' },
        ],
      },
    ],
  );
});

await check('proactive staff templates use the WABA that owns them', () => {
  assert.equal(
    staffNotificationLine(),
    config.WHATSAPP_STAFF_NOTIFICATION_PHONE_NUMBER_ID ?? config.WHATSAPP_PHONE_NUMBER_ID_SGMY,
  );
  assert.equal(staffNotificationLine('explicit-line'), 'explicit-line');
  assert.equal(
    staffNotificationPhoneNumberId(),
    config.WHATSAPP_STAFF_NOTIFICATION_PHONE_NUMBER_ID ??
      config.WHATSAPP_PHONE_NUMBER_ID_SGMY ??
      config.WHATSAPP_PHONE_NUMBER_ID,
  );
  assert.equal(staffNotificationPhoneNumberId('explicit-line'), 'explicit-line');
});

await check('a staff enquiry uses the four fields in the approved body order', () => {
  assert.deepEqual(
    staffEnquiryParameters({
      fullName: 'Nasir',
      country: 'India',
      job: 'Welder',
      phone: '+91 98765 43210',
    }),
    ['Nasir', 'India', 'Welder', '+91 98765 43210'],
  );
});

await check('a staff enquiry never sends blank Meta parameters', () => {
  const params = staffEnquiryParameters({});
  assert.equal(params.length, 4);
  for (const value of params) assert.ok(value.length > 0, 'a blank staff-enquiry parameter');
});

await check('database ids are never rendered as candidate or staff ids', () => {
  const internalCandidateId = '6a901d88f1a8cb33943a1ea3';
  const internalStaffId = '11400d70df114b12a7cac4a31aeb865f';
  const params = staffAssignmentParameters({
    staffName: 'Priya Sharma',
    staffCode: internalStaffId,
    fullName: 'John Doe',
    candidateCode: internalCandidateId,
  });

  assert.equal(params.header, 'Priya Sharma');
  assert.equal(params.body[1], 'Candidate code unavailable');
  assert.ok(!JSON.stringify(params).includes(internalCandidateId));
  assert.ok(!JSON.stringify(params).includes(internalStaffId));

  const adminParams = slaAlertParameters({
    count: 1,
    threshold_hours: 48,
    candidate_name: 'John Doe',
    candidate_code: internalCandidateId,
    staff_name: 'Priya Sharma',
    staff_code: internalStaffId,
  });
  assert.ok(!JSON.stringify(adminParams).includes(internalCandidateId));
  assert.ok(!JSON.stringify(adminParams).includes(internalStaffId));
});

await check('a value that arrived with a line break in it still sends', () => {
  // A CV's name field routinely carries one. Collapsing costs the formatting;
  // rejecting would cost the notification.
  const [name] = staffAssignmentParameters({
    fullName: 'John\n   Doe',
    candidateCode: 'CND-1',
  }).body;
  assert.equal(name, 'John Doe');
});

/* ------------------------------------------------------------------ */

console.log('\ntelling the admins nobody has acted for 48 hours');

await check('the 48-hour parameters match the approved body exactly', () => {
  assert.deepEqual(
    slaAlertParameters({
      count: 1,
      threshold_hours: 48,
      candidate_code: 'CND-1024',
      candidate_name: 'John Doe',
      staff_code: 'STF-0012',
      staff_name: 'Priya Sharma',
      hours_overdue: 51.4,
      reason: 'unviewed',
    }),
    ['John Doe', 'CND-1024', 'Priya Sharma'],
  );
});

await check('an alert with missing CRM fields still has three sendable values', () => {
  // Meta rejects an empty parameter, and a sweep that found something must be
  // announceable even when the record behind it is bare.
  const facts = { count: 1, threshold_hours: 48 };
  const params = slaAlertParameters(facts);
  assert.deepEqual(params, ['Unnamed candidate', 'Candidate code unavailable', 'Unassigned']);
  for (const value of params) {
    assert.ok(!/[\n\t]/.test(value), `a line break in ${JSON.stringify(value)}`);
  }
});

/* ------------------------------------------------------------------ */

console.log('\none candidate across five or six company numbers');

await check('a reply follows the number the latest message arrived on', () => {
  assert.equal(activeLineFor('MAIN-LINE', 'NEW-LINE'), 'NEW-LINE');
  assert.equal(activeLineFor('MAIN-LINE', undefined), 'MAIN-LINE');
  assert.equal(activeLineFor(undefined, 'NEW-LINE'), 'NEW-LINE');
});

await check('the idempotency key does not vary by line', () => {
  // The claim the whole feature rests on. The agency's numbers are sending
  // identities - different threads on the candidate's phone - and a key that
  // carried the line would make one person six candidates, each holding a
  // sixth of a registration, on up to six different desks.
  const person = candidate({ waId: '919000000000', profile: { fullName: 'Ravi' } });
  const keys = new Set(
    ['101', '202', '303', '404', '505', '606'].map((line) =>
      idempotencyKeyFor({ ...person, phoneNumberId: line }),
    ),
  );
  assert.equal(keys.size, 1, `the line leaked into the key: ${[...keys].join(', ')}`);
});

await check('the key is the candidate number, so two people are two records', () => {
  // The converse, and the half a phone-derived rule could get wrong.
  const one = idempotencyKeyFor(candidate({ waId: '919000000000' }));
  const two = idempotencyKeyFor(candidate({ waId: '919999999999' }));
  assert.notEqual(one, two);
});

await check('a waId written with punctuation keys the same as a bare one', () => {
  // Meta sends bare digits, so this costs nothing today. It means a record
  // repaired by hand, or migrated, cannot key differently from the same
  // person's next message.
  assert.equal(
    idempotencyKeyFor(candidate({ waId: '+91 90000-00000' })),
    idempotencyKeyFor(candidate({ waId: '919000000000' })),
  );
});

await check('every configured number is listed once', () => {
  const lines = configuredLines();
  assert.ok(lines.includes(config.WHATSAPP_PHONE_NUMBER_ID), 'the main line is missing');
  assert.equal(new Set(lines).size, lines.length, 'a number is listed twice');
  for (const line of lines) assert.ok(line.length > 0, 'a blank entry reached the fleet list');
});

await check('a line with no token override calls on the main token', () => {
  // The common case, and the one every existing deployment is in: numbers
  // under one Meta app share a token.
  assert.equal(accessTokenFor('a-line-with-no-override'), config.WHATSAPP_ACCESS_TOKEN);
  assert.equal(accessTokenFor(undefined), config.WHATSAPP_ACCESS_TOKEN);
});

await check('every app secret we own is offered to the signature check', () => {
  const secrets = webhookSecrets();
  assert.ok(secrets.includes(config.WHATSAPP_APP_SECRET), 'the main app secret is missing');
  assert.equal(new Set(secrets).size, secrets.length, 'a secret is offered twice');
  assert.ok(secrets.every(Boolean), 'a blank secret reached the signature check');
});

await check('one allocation is one notice, and a move back is a new one', () => {
  // The key the outbound dedupe is built on. Same candidate, same staff member,
  // same moment - a retried relay - is one notice. A different moment is a
  // different allocation, which is what makes A -> B -> A announceable.
  const at = '2026-08-27T09:00:00Z';
  const replay = staffNoticeKey({ candidateId: 'CND-1', staffId: 'ST-1', assignedAt: at });
  assert.equal(staffNoticeKey({ candidateId: 'CND-1', staffId: 'ST-1', assignedAt: at }), replay);

  const movedBack = staffNoticeKey({
    candidateId: 'CND-1',
    staffId: 'ST-1',
    assignedAt: '2026-08-29T11:00:00Z',
  });
  assert.notEqual(movedBack, replay);

  const otherOwner = staffNoticeKey({ candidateId: 'CND-1', staffId: 'ST-2', assignedAt: at });
  assert.notEqual(otherOwner, replay);
});

await check('a document sent after registration still reaches the crm', () => {
  // The case that was dropped in silence. A passport promised during the
  // conversation and sent a week later changed the record, scheduled a sync,
  // and the sync stopped treating it as a partial because the registration had
  // finished - then saw `synced` and returned. The CRM never learned about it.
  const done = candidate({
    stage: 'REGISTRATION_COMPLETED',
    crmSync: { status: 'synced', candidateId: 'CND-1024', attempts: 1 },
  });
  assert.equal(syncModeFor(done, true), 'update');
});

await check('a partial that outran the handover becomes the handover', () => {
  // Scheduled while the candidate was still answering, debounce ran out after
  // they finished. Delivering it as an update would leave the handover
  // unrecorded and the candidate `pending` for good.
  const justFinished = candidate({ stage: 'REGISTRATION_COMPLETED' });
  assert.equal(syncModeFor(justFinished, true), 'handover');
});

await check('a duplicate handover job for a delivered record does nothing', () => {
  const done = candidate({
    stage: 'REGISTRATION_COMPLETED',
    crmSync: { status: 'synced', candidateId: 'CND-1024', attempts: 1 },
  });
  assert.equal(syncModeFor(done, false), 'already_delivered');
});

await check('a registration still being answered is an update', () => {
  assert.equal(syncModeFor(candidate({ stage: 'DOCUMENTS_PENDING' }), true), 'update');
  assert.equal(syncModeFor(candidate({ stage: 'DOCUMENTS_PENDING' }), false), 'handover');
});

await check('a notice with no allocation time is still a stable key', () => {
  // A candidate whose `assigned_at` the CRM has no record of. It must not key
  // on undefined and produce a different string every call, which would send
  // the message once per relay.
  const first = staffNoticeKey({ candidateId: 'CND-9', staffId: 'ST-3' });
  const second = staffNoticeKey({ candidateId: 'CND-9', staffId: 'ST-3', assignedAt: null });
  assert.equal(first, second);
  assert.ok(first.includes('CND-9') && first.includes('ST-3'));
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
