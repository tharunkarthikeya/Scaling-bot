/**
 * Turning a step into a message.
 *
 * Decides the WhatsApp shape (plain text, up to three buttons, or a list),
 * resolves the candidate's language, and — for a language the bot does not ship
 * copy for — routes the English original through the translator.
 *
 * Everything this file emits originates in `flow.ts` or `copy.ts`. It selects
 * and formats; it never writes.
 */

import type { CandidateDoc } from '../db/models.js';
import type { Outbound } from '../whatsapp/client.js';
import {
  copyLanguage,
  WA_LIMITS,
  type Choice,
  type CoreLanguage,
  type Localised,
} from './language.js';
import {
  CHOICE_DONE,
  CONFIRM_CHOICES,
  CONFIRM_HEADER,
  CONFIRM_LABELS,
  CONFIRM_QUESTION,
  render,
} from './copy.js';
import {
  disambiguationChoices,
  generatedQuestionFor,
  labelFor,
  SGMY_DESTINATIONS,
  type FlowStep,
} from './flow.js';
import {
  taxonomy,
  taxonomyCountries,
  taxonomyCountryName,
  taxonomyJobs,
  taxonomyJobTitle,
} from '../crm/taxonomy.js';
import { documentSummary } from './checklist.js';
import { DOCUMENTS } from './rules.js';
import { translate } from './translate.js';

/** Three or fewer options fit on buttons; more need a list. */
const BUTTON_LIMIT = 3;

const LIST_BUTTON: Localised = {
  en: 'Choose',
  ta: 'தேர்ந்தெடுக்க',
  hi: 'चुनें',
  te: 'ఎంచుకోండి',
  ml: 'തിരഞ്ഞെടുക്കുക',
};

const SELECTED_SO_FAR: Localised = {
  en: 'Selected: {{items}}',
  ta: 'தேர்ந்தெடுத்தவை: {{items}}',
  hi: 'चुने गए: {{items}}',
  te: 'ఎంచుకున్నవి: {{items}}',
  ml: 'തിരഞ്ഞെടുത്തത്: {{items}}',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Language
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Resolves one piece of copy for a candidate.
 *
 * The translator is only reached for a language outside the shipped three, and
 * its cache means each string costs one call in the lifetime of the process.
 */
async function say(
  text: Localised,
  candidate: CandidateDoc,
  vars?: Record<string, string | undefined>,
): Promise<string> {
  const lang: CoreLanguage = copyLanguage(candidate.language);
  const resolved = render(text[lang], vars);

  if (candidate.language === 'other' && candidate.languageOther) {
    return translate(render(text.en, vars), candidate.languageOther);
  }
  return resolved;
}

async function sayChoice(choice: Choice, candidate: CandidateDoc): Promise<string> {
  return say(choice.label, candidate);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Messages
 * ───────────────────────────────────────────────────────────────────────────*/

/** A plain message with no options. */
export async function message(
  text: Localised,
  candidate: CandidateDoc,
  vars?: Record<string, string | undefined>,
): Promise<Outbound> {
  return { kind: 'text', body: await say(text, candidate, vars) };
}

/** A message with options, rendered as buttons or a list depending on how many. */
export async function choices(
  body: Localised,
  options: Choice[],
  candidate: CandidateDoc,
  vars?: Record<string, string | undefined>,
): Promise<Outbound> {
  const text = await say(body, candidate, vars);

  if (!options.length) return { kind: 'text', body: text };

  if (options.length <= BUTTON_LIMIT) {
    return {
      kind: 'buttons',
      body: text,
      buttons: await Promise.all(
        options.map(async (o) => ({ id: o.id, title: await sayChoice(o, candidate) })),
      ),
    };
  }

  return {
    kind: 'list',
    body: text,
    buttonText: await say(LIST_BUTTON, candidate),
    rows: await Promise.all(
      options.map(async (o) => ({
        id: o.id,
        title: await sayChoice(o, candidate),
        ...(o.description ? { description: await say(o.description, candidate) } : {}),
      })),
    ),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Steps
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * The two questions whose options an admin controls, and where they come from.
 *
 * Both are lists of things the agency recruits for, both change when the
 * business changes, and neither is something a candidate should have to wait
 * for a deploy to be asked about. So the CRM holds them and this reads them —
 * see `crm/taxonomy.ts` for why that read is synchronous and cached.
 *
 * Returns undefined when the CRM has told us nothing yet, and the step's own
 * compiled-in list is used instead. That is not a degraded mode so much as the
 * starting one: the CRM is seeded with exactly these rows.
 */
function crmChoicesFor(step: FlowStep): Choice[] | undefined {
  if (step.id === 'job_category') {
    // One row is kept back for "Other", which is what makes a list of nine
    // usable when the agency recruits for thirty: a candidate whose job is not
    // shown types it, and the interpreter maps what they typed onto a job id.
    const other = (step.choices ?? []).find((c) => c.id === 'other');
    const jobs = taxonomyJobs(other ? 1 : 0);
    if (!jobs) return undefined;

    const compiled = new Map((step.choices ?? []).map((c) => [c.id, c]));
    const rows = jobs.map((job) => {
      // A job that exists in both keeps the label compiled in here, because
      // that one is translated into all five languages and the CRM's title is
      // English. A job an admin invented has only their words, which is still
      // better than not offering it.
      const known = compiled.get(job.id);
      if (known) return known;
      return {
        id: job.id,
        label: {
          en: job.title,
          ta: job.title,
          hi: job.title,
          te: job.title,
          ml: job.title,
        },
      };
    });

    return other ? [...rows, other] : rows;
  }

  if (step.id === 'country_preference') {
    const countries = taxonomyCountries();
    if (!countries) return undefined;

    const compiled = new Map((step.choices ?? []).map((c) => [c.id, c]));
    const labelled = (id: string, name: string): Choice =>
      compiled.get(id) ?? { id, label: { en: name, ta: name, hi: name, te: name, ml: name } };

    /* The row budget, in priority order. Ten rows, and more things that could
     * fill one than there is room for — so what gets cut has to be a decision
     * written down once rather than a slice() nobody reads.
     *
     * The version this replaces spent seven rows before it looked at the CRM's
     * list at all: two pinned destinations and five compiled region rows. With
     * eight countries on file that left three, and Kuwait, Oman and Bahrain —
     * active, bot-visible, added by an admin who expected to see them — were
     * dropped without a word. An admin's list losing to a hard-coded one is the
     * feature failing at exactly the moment it is being used.
     *
     *   1. Singapore and Malaysia. Not merely two more destinations: choosing
     *      one is what puts a candidate on the route that does not ask for a CV
     *      up front (§10), and a fork with no way to reach it is a flow nobody
     *      can enter. Kept even if an admin retires them from the CRM.
     *   2. "Any country" and "Select countries". The first is what most
     *      candidates actually mean; the second is the only way to name a
     *      country that is not on the list. Losing either leaves an answer with
     *      no row to give it.
     *   3. The CRM's countries, in the admin's order. This is the list the
     *      screen exists to publish.
     *   4. The regions — the Gulf, Europe, Russia/CIS — with whatever is left.
     *      Real answers, and they still are: everything cut here stays typable,
     *      because `crmHiddenChoicesFor` puts it back in the answer space.
     */
    const essential = (step.choices ?? []).filter((c) => c.id === 'any' || c.id === 'select');
    const regions = (step.choices ?? []).filter(
      (c) =>
        !SGMY_DESTINATIONS.has(c.id) &&
        c.id !== 'any' &&
        c.id !== 'select' &&
        !countries.some((x) => x.id === c.id),
    );

    // The CRM's own list, in the CRM's own order, Singapore and Malaysia among
    // the rest rather than appended after it — an admin who ordered Kuwait
    // above Qatar meant that, and an admin who put Singapore third meant that
    // too. Either is pinned back on the end only if the CRM has dropped it.
    const named = countries.map((country) => labelled(country.id, country.name));
    for (const pin of (step.choices ?? []).filter((c) => SGMY_DESTINATIONS.has(c.id))) {
      if (!named.some((row) => row.id === pin.id)) named.push(pin);
    }

    const room = Math.max(1, WA_LIMITS.listRows - essential.length);
    const shown = named.slice(0, room);

    return [...shown, ...regions.slice(0, Math.max(0, room - shown.length)), ...essential];
  }

  return undefined;
}

/**
 * Answers the interpreter accepts for a taxonomy question but never renders.
 *
 * WhatsApp's ten rows are a limit on what can be *shown*, not on what an agency
 * recruits for or where it sends people. Everything the ceiling cuts is put back
 * here: a candidate who types "Kuwait" at a question that had no room for
 * Kuwait is answering it, and until this existed they were told their answer was
 * not one of the options — for a country an admin had added on purpose.
 *
 * Three kinds of thing go in:
 *
 *   * every taxonomy row that did not fit, so the id it resolves to is the
 *     CRM's own id and lands in `destination_country` and `job_id` correctly;
 *   * the compiled rows the CRM's list displaced, so "the Gulf" and "Europe"
 *     keep working for a candidate who says them;
 *   * a few shorthands people actually type — "UAE", "KSA" — which otherwise
 *     cost a model call each to resolve, and are the two most common answers to
 *     this question after Singapore.
 *
 * Every one of them is marked `hidden`, which keeps them out of the numbering:
 * see `Choice.hidden`.
 */
function crmHiddenChoicesFor(step: FlowStep): Choice[] {
  const shown = new Set(crmChoicesFor(step)?.map((c) => c.id) ?? []);
  if (!shown.size) return [];

  const hidden: Choice[] = [];
  const add = (id: string, text: string) => {
    hidden.push({
      id,
      label: { en: text, ta: text, hi: text, te: text, ml: text },
      hidden: true,
    });
  };

  if (step.id === 'job_category') {
    for (const job of taxonomy()?.jobs ?? []) {
      if (!shown.has(job.id)) add(job.id, job.title);
    }
  }

  if (step.id === 'country_preference') {
    for (const country of taxonomy()?.countries ?? []) {
      // The name, only for a country that did not fit. The aliases for every
      // country there is: "UAE" is typed at least as often as the row is
      // tapped, and resolving it here rather than in the interpreter is the
      // difference between an answer and a model call.
      if (!shown.has(country.id)) add(country.id, country.name);
      for (const alias of aliasesFor(country.name)) add(country.id, alias);
    }
  }

  // Whatever the CRM's list pushed off the screen. These are ids already
  // written into records that answered this question before the list moved, so
  // they have to stay answerable as well as readable.
  for (const compiled of step.choices ?? []) {
    if (!shown.has(compiled.id)) hidden.push({ ...compiled, hidden: true });
  }

  return hidden;
}

/**
 * The other things people call a country.
 *
 * Only two rules, both mechanical: the acronym of a multi-word name, which is
 * how "United Arab Emirates" is written on nine tenths of the messages that
 * mention it, and a short list of names that are not derivable from the CRM's
 * spelling at all. Anything subtler — "Dubai", "the Emirates", a misspelling —
 * is the interpreter's job, and it is given every id to choose from.
 */
function aliasesFor(name: string): string[] {
  const out: string[] = [];
  const words = name.split(/[^A-Za-z]+/).filter(Boolean);

  if (words.length > 1) out.push(words.map((w) => w[0]!).join('').toUpperCase());

  const known: Record<string, string[]> = {
    'saudi arabia': ['KSA', 'Saudi'],
    'united arab emirates': ['Emirates'],
    'united kingdom': ['UK', 'Britain'],
    'united states': ['USA', 'America'],
  };
  out.push(...(known[name.trim().toLowerCase()] ?? []));

  return out;
}

/**
 * The id stored when a candidate taps an option on a question that was written
 * rather than compiled — a generated trade question, or one an admin attached
 * to a job.
 *
 * Derived from the option's own text because there is nothing else to derive it
 * from: neither kind of question has ids of its own. Exported because the CRM
 * mapping has to run it backwards — an answer reaches the CRM as the words the
 * candidate was shown, and this is the only thing that connects `tig_welding`
 * to "TIG welding".
 */
export function generatedOptionId(option: string): string {
  return option.toLowerCase().replace(/\s+/g, '_').slice(0, 40);
}

/**
 * Every option a step accepts, in the order the candidate sees them.
 *
 * Order matters twice over: it is the order rendered, and it is what "2" means
 * when a candidate replies with a number instead of tapping.
 */
export function choicesFor(step: FlowStep, candidate: CandidateDoc): Choice[] {
  const generated = generatedQuestionFor(step.id, candidate);

  // A generated question's options are already in the candidate's language —
  // the whole question was written in it — so the same string stands for all
  // three. That also makes a typed reply match by comparison, without a model
  // call, exactly as a hand-written label does.
  const base = generated
    ? generated.options.map((option) => ({
        id: generatedOptionId(option),
        label: { en: option, ta: option, hi: option, te: option, ml: option },
      }))
    : step.id === 'trade_disambiguation'
      ? disambiguationChoices(candidate)
      : (crmChoicesFor(step) ?? step.choices ?? []);

  const options = [...base];

  if (step.input === 'multi_choice') {
    // A multi-select needs a way to say "that's everything". Without it the
    // candidate has no way to leave the question.
    options.push(CHOICE_DONE);
  }

  return options;
}

/** Options the interpreter may return, including any that are not rendered. */
export function acceptedChoices(step: FlowStep, candidate: CandidateDoc): Choice[] {
  const rendered = choicesFor(step, candidate);

  // The rows the candidate can see, then everything else they could reasonably
  // say. Order matters twice over: the rendered rows come first so that a reply
  // of "3" means the third row on their screen, and everything after them is
  // marked `hidden` so it can never be reached by a number at all.
  const behind = [
    ...crmHiddenChoicesFor(step),
    ...(step.hiddenChoices ?? []).map((c) => ({ ...c, hidden: true })),
  ];

  // One entry per label, first occurrence winning. A duplicate *id* is expected
  // and kept — that is what an alias is, a second name for the same answer — but
  // one label meaning two things is not something the interpreter can resolve,
  // and repeating a label the candidate can already tap adds a line to the
  // model's prompt and nothing to what it can choose. First wins is what makes
  // the order above the ranking: a rendered row beats a hidden one, and the
  // CRM's own name for a row beats the compiled alias it displaced.
  // Nothing rendered is ever dropped, whatever it repeats: those are the rows on
  // the candidate's screen and their positions are what "3" means.
  const claimed = new Set(rendered.map((c) => c.label.en.trim().toLowerCase()));

  return [
    ...rendered,
    ...behind.filter((choice) => {
      const key = choice.label.en.trim().toLowerCase();
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
  ];
}

export async function renderStep(step: FlowStep, candidate: CandidateDoc): Promise<Outbound> {
  if (step.id === 'confirm') return renderConfirmation(candidate);

  const options = choicesFor(step, candidate);

  // A generated question is stored already written in the candidate's language,
  // so it is used as it stands rather than selected from `Localised` — and it
  // is never handed to the translator, which exists to translate copy a person
  // wrote, not text a model produced a moment ago.
  const generated = generatedQuestionFor(step.id, candidate);
  const parts: string[] = [generated ? generated.prompt : await say(step.prompt, candidate)];

  if (step.hint) parts.push(await say(step.hint, candidate));

  // What they have picked so far, so a multi-select does not feel like it is
  // ignoring the taps.
  if (step.input === 'multi_choice') {
    const selected = candidate.pendingMulti?.step === step.id ? candidate.pendingMulti.selected : [];
    if (selected.length) {
      const names = await Promise.all(
        selected.map(async (id) => {
          const label = labelFor(id, step.id);
          return label ? say(label, candidate) : id;
        }),
      );
      parts.push(await say(SELECTED_SO_FAR, candidate, { items: names.join(', ') }));
    }
  }

  return choices({ en: '', ta: '', hi: '', te: '', ml: '' }, options, candidate).then(async (shape) => {
    const body = parts.join('\n');
    return shape.kind === 'text' ? { kind: 'text', body } : { ...shape, body };
  });
}

/**
 * Re-asks a question the candidate's reply did not answer.
 *
 * One message, not two. Sending "Sorry, I did not follow that." and then the
 * question as separate messages puts two bubbles on the candidate's screen for
 * one event, and on a phone the question can arrive above the apology. The lead
 * line and the question belong together.
 *
 * There is no way out attached. A staff row used to be available here behind an
 * `offerStaff` flag; a person is now reached from one place only — "Other" on
 * the opening menu — and typing "talk to staff" still works at any point.
 *
 * `lead` is normally fixed copy. A plain string is accepted for the one caller
 * that has already resolved its text — `faq.ts` generates its answer directly in
 * the candidate's language, so there is no `Localised` to select from.
 */
export async function renderRetry(
  step: FlowStep,
  candidate: CandidateDoc,
  lead: Localised | string,
): Promise<Outbound> {
  const rendered = await renderStep(step, candidate);
  const leadText = typeof lead === 'string' ? lead : await say(lead, candidate);
  return { ...rendered, body: `${leadText}\n\n${rendered.body}` };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * §18  The confirmation summary
 *
 * Built from the candidate's own answers, in their language. It shows what was
 * recorded, never an identity number — §27 forbids putting a full Aadhaar, PAN
 * or passport number in a WhatsApp confirmation.
 * ───────────────────────────────────────────────────────────────────────────*/

const NOT_GIVEN: Localised = { en: '—', ta: '—', hi: '—', te: '—', ml: '—' };

const STRICT_NOTE: Localised = {
  en: '{{countries}} (only these)',
  ta: '{{countries}} (இவை மட்டும்)',
  hi: '{{countries}} (सिर्फ़ ये)',
  te: '{{countries}} (ఇవి మాత్రమే)',
  ml: '{{countries}} (ഇവ മാത്രം)',
};

const DOCS_RECEIVED: Localised = {
  en: 'Received: {{received}}',
  ta: 'கிடைத்தவை: {{received}}',
  hi: 'मिले: {{received}}',
  te: 'వచ్చినవి: {{received}}',
  ml: 'കിട്ടിയത്: {{received}}',
};

const DOCS_PENDING: Localised = {
  en: 'Pending: {{pending}}',
  ta: 'நிலுவையில்: {{pending}}',
  hi: 'बाकी: {{pending}}',
  te: 'రావాల్సినవి: {{pending}}',
  ml: 'ബാക്കിയുള്ളത്: {{pending}}',
};

const DOCS_NONE: Localised = {
  en: 'None needed yet',
  ta: 'இப்போது தேவையில்லை',
  hi: 'अभी कोई नहीं',
  te: 'ఇంకా ఏమీ అవసరం లేదు',
  ml: 'ഇപ്പോൾ ഒന്നും വേണ്ട',
};

async function label(
  optionId: string | undefined,
  candidate: CandidateDoc,
  stepId?: string,
): Promise<string | undefined> {
  if (!optionId) return undefined;

  const found = labelFor(optionId, stepId);
  if (found) return say(found, candidate);

  // A row that exists only in the CRM has no compiled label to find, and the
  // fallback below it is the option id — so a candidate who chose Kuwait read
  // "kuwait" back on their own confirmation. The taxonomy is what named that row
  // in the first place; asking it again is the difference between a summary and
  // a database key. English, because that is all the CRM holds.
  const named = taxonomyCountryName(optionId) ?? taxonomyJobTitle(optionId);
  return named ?? optionId;
}

/** What the candidate is looking for, which §9 keeps separate from what they do. */
async function lookingForLine(candidate: CandidateDoc): Promise<string | undefined> {
  const p = candidate.profile ?? {};

  switch (p.workTypePreference) {
    case 'current_trade':
      return (await label(p.relatedAcceptance, candidate)) ?? (await label(p.primaryTrade, candidate));
    case 'related':
      return label('related', candidate, 'job_preference');
    case 'general': {
      if (p.generalJobs?.length) {
        const names = await Promise.all(p.generalJobs.map((id) => label(id, candidate, 'general_jobs')));
        return names.filter(Boolean).join(', ');
      }
      return label(p.generalWorkWillingness, candidate);
    }
    case 'different':
      return p.desiredOccupation;
    default:
      return undefined;
  }
}

async function countriesLine(candidate: CandidateDoc): Promise<string | undefined> {
  const p = candidate.profile ?? {};
  const named = p.selectedCountries?.length
    ? p.selectedCountries.join(', ')
    : await label(p.countryPreference, candidate, 'country_preference');

  if (!named) return undefined;
  return p.countryStrictness === 'strict'
    ? say(STRICT_NOTE, candidate, { countries: named })
    : named;
}

async function passportLine(candidate: CandidateDoc): Promise<string | undefined> {
  const p = candidate.profile ?? {};
  const status = await label(p.passportStatus, candidate, 'passport_status');
  if (!status) return undefined;
  return p.passportExpiry ? `${status} — ${p.passportExpiry}` : status;
}

async function documentsLine(candidate: CandidateDoc): Promise<string> {
  const { received, pending } = documentSummary(candidate);

  const names = async (ids: string[]) =>
    (
      await Promise.all(
        ids.map(async (id) => {
          const doc = DOCUMENTS.find((d) => d.id === id);
          return doc ? say(doc.label, candidate) : id;
        }),
      )
    ).join(', ');

  const parts: string[] = [];
  if (received.length) parts.push(await say(DOCS_RECEIVED, candidate, { received: await names(received) }));
  if (pending.length) parts.push(await say(DOCS_PENDING, candidate, { pending: await names(pending) }));

  return parts.length ? parts.join(' · ') : await say(DOCS_NONE, candidate);
}

export async function renderConfirmation(candidate: CandidateDoc): Promise<Outbound> {
  const p = candidate.profile ?? {};
  const dash = await say(NOT_GIVEN, candidate);

  const experience = p.totalExperienceYears
    ? `${p.totalExperienceYears} ${p.totalExperienceYears === 1 ? 'year' : 'years'}`
    : await label(p.totalExperienceBand, candidate, 'total_experience');

  const rows: Array<[string, string | undefined]> = [
    [await say(CONFIRM_LABELS.name!, candidate), p.fullName],
    [
      await say(CONFIRM_LABELS.skill!, candidate),
      (await label(p.primaryTrade, candidate, 'main_trade')) ?? p.currentOccupation,
    ],
    [await say(CONFIRM_LABELS.experience!, candidate), experience],
    [await say(CONFIRM_LABELS.lookingFor!, candidate), await lookingForLine(candidate)],
    [await say(CONFIRM_LABELS.countries!, candidate), await countriesLine(candidate)],
    [
      await say(CONFIRM_LABELS.joining!, candidate),
      (await label(p.availability, candidate, 'availability')) ?? p.availabilityNote,
    ],
    [await say(CONFIRM_LABELS.passport!, candidate), await passportLine(candidate)],
    [await say(CONFIRM_LABELS.documents!, candidate), await documentsLine(candidate)],
  ];

  const body = [
    await say(CONFIRM_HEADER, candidate),
    '',
    ...rows.map(([key, value]) => `${key}: ${value || dash}`),
    '',
    await say(CONFIRM_QUESTION, candidate),
  ].join('\n');

  const shape = await choices({ en: '', ta: '', hi: '', te: '', ml: '' }, CONFIRM_CHOICES, candidate);
  return shape.kind === 'text' ? { kind: 'text', body } : { ...shape, body };
}
