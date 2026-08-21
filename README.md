# Adira — WhatsApp document-intake bot

Collects candidate documents over WhatsApp, stores them, runs them through OCR,
and keeps a per-candidate record that the CRM will read.

## Running it

```bash
npm install
npm run smoke        # offline checks — no Mongo, Redis, or network needed
npm run harness      # full end-to-end run, no Mongo or Meta needed
npm run dev          # needs MongoDB reachable at MONGODB_URI

npm run inspect      # what the bot has collected, straight from the database
npm run reset -- <number>            # what clearing that number would remove
npm run reset -- <number> --delete   # clear it, so the next message starts fresh

npm run verify:crm                   # is the CRM link live? read-only
npm run verify:crm -- --submit       # ...and post one test candidate to prove it
```

`reset` is for testing, and it is not the §23 deletion a candidate can ask for —
that one tombstones the profile and keeps an audit record because a real person
withdrew consent. This removes the rows outright, including the `processed_events`
wamid claims: leave those behind and the first message of the next test is
silently dropped as one of Meta's redeliveries, which looks exactly like the bot
ignoring you. It prints the database it is pointed at before it does anything,
and does nothing at all without `--delete`.

`npm run harness` is the one to reach for when you want to know whether the bot
actually works. It starts a real MongoDB in-process, starts the real server, and
drives real conversations through properly-signed webhooks — real Claude calls,
real OCR calls, real storage. Only the outbound send to Meta is suppressed, so no
phone number and no Meta app are involved. It prints the transcript, the
candidate record, the extracted OCR fields, and a pass/fail verdict per
subsystem, and exits non-zero if any of them fail.

Four numbers are driven, so every opening branch is covered: one registers end to
end and is then tracked and edited, one goes Other → B2B and must give a name,
both sides of an Aadhaar and a company registration certificate before reaching a
person, one is abandoned mid-registration to exercise the
idle-session timeout and "start from first", and one asks questions of its own
instead of answering — including the salary question, which must come back
answered and without a figure.

The driver is adaptive — it reads which question the bot is actually on each turn
rather than replaying a script — because the flow legitimately differs run to
run. Note that the canned media fixture is a **single-page** PDF, so the passport
slot is correctly reported incomplete by the §14 page-count check and re-asked;
that is the check working, not a failure.

`npm run dev` will not start without MongoDB. Redis is optional: omit `REDIS_URL`
and the queue runs in-process (jobs are lost on restart and are never retried —
local dev only).

Expose the webhook to Meta over HTTPS, then point the WhatsApp app at
`https://<host>/webhook`. The `GET` handler answers the subscription handshake
using `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.

`SHADOW_MODE=true` runs everything — parsing, storage, OCR, the model call — but
never hands the reply to Meta. Use it to watch what the bot *would* say against
real traffic before going live.

`npm run verify:crm` answers the other question — whether a finished registration
can actually reach the CRM. It checks that we are pointed at one, that it
answers, that it accepts our service key *and refuses a request without one*, that
`/policy/cv-required` replies, that the CRM can write a hiring decision back
through `/api/*`, and how the candidates already in our database are syncing.
The submission itself is opt-in (`-- --submit`) because it writes to the CRM's
database: it posts one obviously-fake candidate twice under a fixed idempotency
key, which is the check that matters — if the repeat creates a second record
rather than returning the first, every queue retry of a real candidate becomes a
duplicate person.

## Where things are

| Path | What it does |
|---|---|
| `src/conversation/rules.ts` | **Documents, thresholds, trigger lists, tunables, the interpreter prompt.** |
| `src/conversation/flow.ts` | **Every question, in order, and what each answer means.** |
| `src/conversation/copy.ts` | Every other sentence a candidate can receive, in en/ta/hi. |
| `src/conversation/trades.ts` | Trade-specific question packs (§8). Add a trade here and nowhere else. |
| `src/conversation/tradeQuestions.ts` | **Questions written per candidate for a job no pack covers, and the filter around them.** |
| `src/conversation/interpret.ts` | The only model call that reads a candidate: reply → option id. |
| `src/conversation/translate.ts` | Fixed copy in a language we do not ship. |
| `src/conversation/faq.ts` | **What the bot may answer in its own words, and the guardrail around it.** |
| `src/conversation/respond.ts` | Replies to a message that is about the open question, and to a file that is not the document asked for. |
| `src/conversation/engine.ts` | Orchestrates one inbound message end to end. |
| `src/conversation/render.ts` | Step → WhatsApp shape (text, ≤3 buttons, or a list). |
| `src/conversation/checklist.ts` | Deterministic document state machine. |
| `src/conversation/cv.ts` | Extracted CV fields → profile fields, including which trade the evidence supports. |
| `src/conversation/validate.ts` | Boot-time copy and flow assertions. |
| `src/whatsapp/` | Signature check, webhook parsing, Graph API client, rate limiter. |
| `src/ocr/veris.ts` | Veris OCR client, upload inspection, and queue handler. |
| `src/storage/` | File storage (local volume today, swappable for S3/R2). |
| `src/db/models.ts` | Collections, indexes, the dedupe claim, and the session and document helpers everything else reads through. |
| `src/server.ts` | Fastify routes: webhook, CRM reads, and the one CRM write. |

## How a message flows

```
Meta webhook
  → signature verified against the raw bytes
  → wamid claimed (drops Meta's retries)
  → inbound row written, job enqueued, 200 returned    ← must be fast
  → worker, holding a per-candidate lock:
        media?  download → store → file to a slot → queue OCR
        UPDATE / DELETE / talk to staff / an application id?  handled here
        idle too long and the sweep has not said so?  offer continue-or-restart
        interpret the reply against the question actually asked
        record it with its source and their own wording
        ask the next unsatisfied question, or finish
```

### The registration flow

```
Apply
  → Language
  → Consent
  → CV upload                  ← read by the resume extractor; everything it
  → Personal details             yields is a question the sections below skip
  → Country preference         ← Gulf / Europe / Russia-CIS / Any / Select
  → Experience
  → Trade-specific questions
  → Job preferences
  → Documents
        Passport — do you have one?      → upload, if they do
        Aadhaar  — uploaded and read
        PAN      — uploaded and stored, never read
  → Confirm
  → Application ID
```

The CV sits directly after consent because it is the only step that can answer
other steps: the resume extractor fills the name, date of birth, education,
trade, experience and certifications, and `nextStep` then walks past every
question those fill (§1, §5). Collected any later, the saving arrives after the
candidate has already been asked by hand.

**Singapore and Malaysia are no longer offered as destinations**, and the branch
they triggered went with them. Naming one country used to collect the passport
before the CV and ask the job early, so the CRM could resolve a CV requirement
from destination plus job; a Europe/Russia answer was the only thing that
triggered the identity documents at all. Neither runs now — every candidate is
asked for a CV, and every candidate is asked for Aadhaar and PAN.

The country question itself stays, minus those two rows, and has moved from
first to after the personal details. It was asked first because it was a branch
point, and a branch point asked after the branch cannot branch. It is an ordinary
preference now, so it sits where it reads naturally. `destination_country` still
reaches the CRM for a country an admin adds to the taxonomy; a region — "the
Gulf" is six countries — is never named as one.

**The PAN is never sent to an extractor.** Nothing on it answers a question the
flow asks, so it is filed exactly as it arrived for a documentation officer to
open. That is enforced rather than declared — `NEVER_OCR` in `rules.ts` lists it,
and `assertOcrRoutingIsSafe` runs inside `validateCopy()` at boot, so an edit
that gives it a route breaks the deploy instead of quietly posting tax
identifiers to a third party.

Nothing asks about the passport's validity either. The expiry is read off the
page, and the candidate is told when what was read has expired or is close to it
(§12) — an expiry typed from memory is the least reliable thing anyone puts on a
record.

The split that matters: **the bot never composes the flow.** Every question,
confirmation and acknowledgement is written by a person in `flow.ts` or
`copy.ts`, in all three languages. The model's job on the way in is to read what
the candidate typed and say which of the offered options it corresponds to — it
cannot steer the conversation because it has no channel through which to do so.

It writes to a candidate in exactly four places, and all four are fenced:

| Where | What it may write | The fence |
|---|---|---|
| `translate.ts` | Fixed copy, in a language we do not ship | One sentence in, the same sentence out. Never given a topic, so it cannot introduce one. |
| `faq.ts` | An answer to a question the candidate asked | Grounded in `FAQ` and nothing else, then guard-checked for money amounts, promises and timelines before it is sent. |
| `respond.ts` | A reply to a message that is about the open question, and the sentence telling someone their upload is not the document asked for |
| `tradeQuestions.ts` | Two to four screening questions about a job no pack covers | Told one thing — the job, in the candidate's own words. `FORBIDDEN_SUBJECTS` drops anything touching pay, documents, the flow's own questions, or a protected characteristic, whatever the model returns. Guard-checked and length-checked, stored before it is asked, and empty on any failure. | Same grounding and the same guard as `faq.ts`. It is told the question, the options and the message — never the candidate's record — and it is forbidden to answer the question on their behalf. The question is re-sent underneath whatever it writes. |

`faq.ts` is what stops the bot deflecting every question to staff. A candidate
who asks *"is there any fee?"* gets the agency's actual answer. `respond.ts`
covers the other half: a message that is about the question in front of them
without being an answer to it — *"my passport is with the agent"*, *"what is
FCAW?"*, *"I have TIG but the certificate expired"*. Both send their reply with
the open question underneath it, so being answered never costs the candidate
their place in the flow.

Neither can move the flow, record an answer, or state a fact it was not given.
When either declines — nothing approved covers it, or the guard trips — the
candidate gets fixed copy and the question again, which is a worse reply and
never a wrong one.

Most turns never reach a model at all. A tapped button already carries its
option id; a typed reply matching an offered label in any of the three
languages, or the number of an offered row, is resolved by comparison.

## The opening menu

Anyone messaging the number is offered three things, and the branch decides how
much of the machinery runs at all:

| Option | What happens |
|---|---|
| Other | Opens a second, two-option menu: **B2B enquiry** or **Talk to staff**. |
| Track application | Reads back the outcome staff recorded. Nothing else. |
| Apply for a job | The registration flow. |

### Other → B2B enquiry

A business contact is not a candidate, so none of registration runs for them —
no consent notice, no CV, no trade questions. Four questions, in the order a
person ringing back needs them:

1. their full name;
2. the **front** of their Aadhaar card, as a photo or a PDF;
3. the **back** of the same card;
4. their company registration certificate.

The two sides are two questions rather than one because a photo answers whichever
question is open — a single ask would have the second photo land in the next slot.

Only the Aadhaar goes to OCR. The registration certificate is stored exactly as it
arrived (`ocr: 'none'` in `conversation/rules.ts`); there is nothing on it the bot
needs to read. When all four are in, the contact is told staff will be in touch and
the conversation goes to a person — no Application ID is issued, because a business
enquiry is not an application for §25 to track.

Uploads are attributed within the branch they arrived in: a business contact
captioning a photo "aadhaar" means the B2B slot the bot just asked for, never the
candidate Aadhaar slot nothing in their conversation will ever ask about.

**B2B data is stored apart from candidate data.** Two collections of its own:

| | Candidates | B2B enquiries |
|---|---|---|
| record | `candidates` | `b2b_enquiries` |
| uploads | `documents` | `b2b_documents` |
| read through | `GET /api/candidates`, `/api/candidates/:waId` | `GET /api/b2b`, `/api/b2b/:waId` |

Every conversation starts in `candidates` — until the opening menu is answered
there is nothing to say it is anything else. Choosing **B2B enquiry** moves the
record, keeping its `_id` so the uploads still point at it, *before* the first
question is asked; no business contact's name or Aadhaar is ever written to the
candidate collection, not even briefly. A deleted record starting over (§23) moves
back, because it is a blank conversation again.

Two functions in `db/models.ts` decide all of it — `recordCollectionFor(enquiry)`
and `documentCollectionFor(docType)` — and every read and write goes through them,
so the split is one decision in one place rather than a rule each caller has to
remember. Uploads route on the *kind*, because the two branches ask for disjoint
kinds: a `company_registration` can only have come from a business contact.

What this buys: a recruiter's candidate list, the §21 reminder sweep, the
matching indexes and the document review queue contain candidates and nothing
else. The transcript stays in `messages`, keyed by `waId` like every other
conversation — it is the log of a conversation, not enquiry data.

An application id also works on its own, typed at any point — `ADR-00042`,
`adr 42`, or a bare `42` at the tracking question. A **bare number elsewhere is
never read as an id**, because that is how candidates pick a row from a list.

Tracking is scoped to the number that sent it. Ids are short and sequential, so
answering for any id would hand one candidate's status — and the existence of
their record — to anyone who guessed a number. A miss reads the same whether the
id is unknown or belongs to somebody else.

The outcome itself is never the bot's decision. It seeds `pending` at completion
and from then on only reports; staff set it through the one write in the API:

```bash
curl -X PATCH https://<host>/api/candidates/<waId>/application \
  -H "x-api-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"completed","by":"priya","note":"offer accepted"}'
```

`pending` · `completed` · `rejected`. Setting one does **not** message the
candidate — they are told when they ask. Pushing an outcome unprompted is a
decision for staff, not a side effect of a CRM edit.

## Sessions

A registration session closes after `TUNABLES.sessionTimeoutMinutes` (5) with no
reply, and the candidate is told:

```
Your session has been terminated due to inactivity.
Your answers are saved — would you like to continue, or start again?

                                   [ Continue session ] [ Restart session ]
```

Nothing is discarded — every answer is written as it arrives — so closing a
session costs the candidate nothing but a tap, and it replaces a question they
last saw hours ago with no memory of the context.

**Neither choice deletes anything.** They differ in where the conversation
resumes, and in nothing else:

| | What it does |
|---|---|
| **Continue session** | Back to the exact question the prompt interrupted. The prompt has to occupy `currentStep` — otherwise the tap would be read as an answer to the question underneath — so the engine stashes what it displaced in `resumeStep` and puts it back. Where that question has since been answered (a document arrived and filled it), it falls through to the ordinary scheduler. |
| **Restart session** | The flow from the first step. Only the conversation's *position* is cleared — `currentStep`, `resumeStep`, `pendingMulti`, the edit queue, the unclear counter. `nextStep` then walks `STEPS` from the top and skips everything already satisfied, so the candidate is asked only for what is genuinely still missing. Where nothing is missing, it runs straight to the confirmation. |

Restarting used to empty `profile` and `fieldMeta`, which meant tapping *"start
again"* over one mistyped answer cost the candidate all of them — and the CV they
had already sent was re-read to put some of them back. It no longer does.
Restarting a conversation is not the same act as withdrawing the answers given
during it; DELETE is what does that (§23), and it asks first.

Documents, consent, language, history and `reminderSentAt` survive both, as they
always did. §22 forbids destroying an upload without a version history, someone
re-answering questions has not withdrawn the passport they already sent, and §21
allows one reminder per candidate — restarting does not make someone a new one.

The sweep in `index.ts` runs every 60s, so `SESSION_SWEEP_MS` is the lag between
a session lapsing and the candidate hearing about it — keep it well under the
timeout. The session is claimed in the database *before* anything is sent, and
the send holds the same per-candidate lock the queue uses, so neither a second
instance nor a reply landing mid-sweep can produce two notices for one lapse.

Missing the sweep entirely — a restart, an outage — costs only the push:
`handleInboundMessage` still meets the next message with the same two choices,
which is what makes the behaviour correct either way. The one case that is
deliberately silent is a session that lapsed more than 24 hours ago, because only
an approved template may be sent outside Meta's window; those are closed without
a message, exactly as before.

Separately, §21's single reminder still fires after `reminderAfterHours` (20) —
one per candidate, ever, claimed in the database before it is sent so a restart
or a second instance cannot produce a second one.

## Deliberate design decisions

**The webhook acks fast.** OCR takes up to 120s and the model call takes
seconds; Meta wants a response in about five. Everything real happens on the
queue.

**A conversation is one document, and so is a candidate's paperwork.**
`messages` holds one document per sitting — `turns` in order, `endedAt` when it
closed — because a row per message made the collection unreadable and a
transcript something you reassembled by sorting. A sitting ends after
`TUNABLES.sessionTimeoutMinutes` of silence, decided from the gap at write time
so the log stays right even when the sweep never ran, and at most one open
session per candidate is a unique partial index rather than a convention.
`documents` holds one record per candidate with a section per kind — cv,
passport, aadhaar, pan, driving_licence, certificate — each an array of versions,
oldest first, nothing ever removed (§22). The current version of anything is the
last entry without a `supersededAt`. `b2b_documents` is the same shape for the
three kinds only a business contact sends; see **Other → B2B enquiry** above for
why those are filed apart.

**Deliveries are deduped.** Meta retries. `claimEvent()` inserts the `wamid`
into a unique index, and a duplicate is dropped — otherwise a retry re-runs the
turn and the candidate is asked for the same document twice.

**One turn at a time per candidate.** `withCandidateLock` serialises messages
from the same person. Without it, two rapid messages both read the same stale
checklist and both ask for the CV. The lock is in-memory, so **running more than
one instance needs it backed by Redis.**

**A file that is not the document asked for is said out loud.** The commonest
document mistake by far is the right person sending the wrong scan — the CV
question is answered with an Aadhaar card picked out of a gallery of them. With
no filename or caption naming another document there is nothing to re-attribute
it by, so it lands in the slot that was asked for. When the extraction then
yields nothing usable, `resumeCompleteness` asks the markers what the file
actually is: an identified document is a `wrong_document` and the candidate is
told which one they sent, an unidentifiable one is `empty` and they are asked
for a clearer photo. Nothing is written to the profile from a file filed as
something it is not, and the upload itself is kept either way. §5's rule that a
CV is never re-requested for being *hard to read* is unchanged — this is about
files that are not CVs.

**OCR routes per document kind.** Veris exposes three extractors, each with its
own route, form field, and response shape — `passport` (MRZ + check digits),
`resume` (structured CV fields), and `document` (per-page text). Which one runs
is set per checklist entry in `rules.ts`; `ocr: 'none'` skips it entirely, which
is right for a headshot.

**OCR output carries confidence and provenance — and `null` is not confidence.**
Every field is stored as `{key, value, confidence, page, category, source}` next
to the raw payload. The passport and document extractors return real scores;
**the resume extractor returns none**, so its fields are stored with
`confidence: null` and the document is always flagged `needsReview` rather than
being assigned an invented score. Anything below `TUNABLES.ocrReviewThreshold`,
a passport whose MRZ was recovered visually (no check digits exist), or a failed
check digit all mark the document `needs_review` with a plain-language reason.
A failed OCR is a review task — it does not re-open the slot and re-ask the
candidate.

**Every failure path resolves towards asking again.** The interpreter is called
with `tool_choice` forced, so its answer is always a parseable object rather
than prose, and every error — no tool call, an unknown classification, a network
failure — returns `unclear`. An unclear answer costs one re-asked question; a
confidently wrong one is written into a candidate's permanent record. Past
`maxAsksPerStep` the conversation goes to a person rather than asking again.

**Option ids the model invents are dropped, not trusted.** The prompt forbids
returning an id that was not offered; `interpret.ts` filters the returned ids
against the offered set, which is what makes that a guarantee rather than a
rule. A step whose choices are declared only inside the renderer would offer the
interpreter an empty list and nothing could ever match — that is what
`acceptedChoices` exists to prevent, and there is a smoke check pinning it.

**A generated answer is checked, not trusted.** `ANSWER_PROMPT` says never to
quote a salary, promise an outcome, or commit to a timeline. `violatesGuardrails`
is what makes that true: every generated sentence is tested before it is sent,
and a trip becomes the staff line rather than a repair attempt — asking the same
model the same question with the same context tends to produce the same
sentence. The smoke checks pin both directions, including that *"registering
does not guarantee selection"* still gets through. That one is not hypothetical:
the first version of the guard blocked it, which would have silenced the exact
sentence §27 wants said.

**A trade nobody wrote a pack for still gets asked about.** `trades.ts` holds
hand-written packs for the trades this agency places most, and they always win.
Everyone else — an electrician, an accountant, a physiotherapist, a poultry farm
supervisor — used to answer "what is your main job?" and go straight to the
preference questions, leaving a recruiter a profile that named the trade and said
nothing about the worker. For those, `tradeQuestions.ts` writes two to four
questions for that job, once, and stores them on the candidate before they are
asked. It is told one thing: the job, in the candidate's own words — which is
also why `occupationForQuestions` exists, because someone who *types* "plumber"
has it recorded as the Electrical/Mechanical category, and generating from a menu
heading produces menu-heading questions.

The filter around it is phrases, not words, and that is the point. A bare word
list blocks the trade it is protecting: "single" is marital status and also
single-phase power, "health" is a medical condition and also health-and-safety
training, "join" is a start date and also how two pieces of steel are joined. Each
of those silently dropped a question a recruiter needed. What stays absolutely
blocked, in any wording, is age, gender, religion, caste, marital status, family,
pregnancy, health and disability — an agency screening on those is breaking the
law in most of the countries it places into.

**A trade is weighed, not raced.** `classifyTrade` scores every trade over
everything the CV gave us — designation, industry, skills, certifications,
machinery, previous titles, employers — with a trade's own vocabulary worth
three times a generic job-title word, and a tie returning nothing so the
candidate is asked. It replaced a first-pattern-wins race over the job title
alone, which classified a pressure-vessel planning manager as factory/warehouse
because `production` appeared in his title, while SMAW, GTAW, GMAW, SAW, PWHT,
ASNT Level-II and PEB sat unread in the same extraction.

**A specialist pack loads on evidence or on an answer, never on being the only
one.** `resolvePacks` used to take a trade's single pack as settled — nothing to
choose between, so no need to ask. There was nothing to choose *from*, which is
not the same thing: `factory_warehouse` has exactly one pack, so that manager was
asked which CNC machines he had operated. Now an unsupported pack is either
disambiguated, where the trade has a question for it, or skipped. Trade questions
sharpen a match; a sharpened match built on an invented answer is worse than an
unsharpened one.

**A question narrower than "some text" says so.** A free-text step may declare
`expects` — what its answers have to be about — and the interpreter is given that
subject and judges the reply against it. "Tailor machine" at the CNC question
comes back `related`, so the candidate is told what the question is asking and
gets it again, instead of having a sewing machine recorded as machining
experience and never being asked again (§1 cuts both ways). It is a subject, not
a blacklist: rough spelling, an unfamiliar model number and an answer in Tamil
all still count, because the model is told what the question is about rather than
which answers are wrong. Any step can declare it.

**A job the candidate names is an answer, not an off-topic message.** Steps about
work carry `acceptsOccupation`, and the interpreter is told to test for a named
job, trade, tool or workplace before anything else. The two modes matter:
`'category'` on `main_trade`, whose options *are* trades, so "hotel cook" becomes
hospitality; `'named'` on `job_preference`, whose four options describe how work
relates to their current trade, so "type writer" is kept as their own wording and
`desired_job` is skipped rather than asked. Getting this wrong is silent and
expensive — the candidate is told to contact staff about their own answer, then
asked the same question again.

**Asking about a fee is not a safeguarding report.** The interpreter escalates to
a person when a candidate says someone *has asked them for money*, and answers
normally when they ask *whether there is a fee*. Collapsing the two sent every
worried candidate to a human instead of telling them registration is free — the
harness drives that question specifically.

**There are two ways to reach a person, and neither is a shrug.** A candidate
asks for one — the button, or "talk to staff" typed at any point — or the bot
could not read two replies in a row, at which point it says so and hands over.
The staff line is attached to nothing else: not to a retry, not to a question
with no approved answer, not to a reply the bot understood but could not record.
A message the bot *did* understand is answered by `faq.ts` or `respond.ts` and
never counted towards the handoff, so engaging with the bot can no longer walk a
candidate towards being passed off. Distress, a report that someone has demanded
money, and legal or medical matters still escalate on the first message —
that is a safeguarding route, not a fallback for the bot having nothing to say.

**The interpreter prompt is deterministic and sees no candidate data.** It is
the cached prefix of every interpretation call, and it is handed one question,
the answers that question accepts, and one message — never a name, a document,
or any other field. Putting anything per-candidate into `INTERPRETER_PROMPT`
silently kills caching and every message starts paying full input price.

**Credentials never reach the log sink**, and stored files are written `0600`
under a path-traversal-checked root. Candidate passports are PII.

## Known gaps

These are deliberate — flagging rather than hiding them:

- **The FAQ answers are only as good as `FAQ` in `faq.ts`.** The guard stops the
  model inventing figures and promises; it cannot stop it repeating a fact that
  is written down wrongly. Read those fourteen entries as agency policy, because
  once they are in that file the bot will say them. Anything not covered still
  goes to staff, so the safe way to widen the bot's range is to add an entry.
- **Off-topic questions cost a second model call.** Only on the `unrelated`
  branch, and only for a candidate who asked something — a tapped button never
  reaches it. The FAQ is in the cached prefix, so the marginal cost is the
  question and the answer, not the knowledge base.
- **Everything rests on the interpreter's `related` / `unrelated` / `unclear`
  split.** `related` and `unrelated` both get the candidate a written reply;
  `unclear` re-asks once and then hands to a person. A message misfiled as
  `unclear` therefore costs more than it used to — two of them end the automated
  conversation. If candidates are reaching staff without asking to, that
  classification is where to look first, and the wording that governs it is in
  `INTERPRETER_PROMPT`.
- **Storage is a local volume.** Fine on a mounted Dokploy volume; move to
  S3/R2 before this holds real volume. The `storage/` interface is the seam.
- **The candidate lock is per-process.** Single instance only until it is moved
  to Redis. The same applies to the idle-session and reminder sweeps — both
  claim per candidate in the database, so a second instance cannot double-send,
  but the lock itself does not hold across processes.
- **Replies outside the 24-hour window are dropped, not queued.** They are
  recorded with `error: outside_24h_window`. The re-engagement template is the
  only way back in, and it fires from the §21 reminder sweep only — nothing else
  schedules it.
- **The passport and document extractors are wired but unproven.** Only the
  resume path has been exercised against a real file end to end. The other two
  are written against the live OpenAPI schema, but send a real passport scan
  through before trusting them.
- **Employers, previous job titles, certifications and machinery are read
  defensively.** The resume extractor's published schema pins down its flat
  fields and little else, so `stringsFrom` probes several plausible shapes for
  the list fields. An unrecognised key yields nothing rather than an error —
  which means an empty `employers` array is not proof the CV had none. Check one
  real CV's raw payload before relying on these.
- **Half of §14's passport checklist cannot be automated.** Readable, corners
  visible, no fingers or shadows, no glare, page sequence, visa pages, entry and
  exit stamps, the observation page, the previous-passport reference and
  ECR/ECNR are page-by-page human judgements this extractor does not make. What
  *is* checked: the file opens, the PDF is not truncated, the page count is
  plausible, the photo page was read, the number came off it, and the passport is
  in date. The rest is why **every passport is flagged `needsReview`** — the
  review queue is what puts the booklet in front of a person, and a clean MRZ
  read is not evidence the booklet is complete.
- **Nothing notifies a candidate when staff change an application's outcome.**
  They are told when they ask. Push would need a template outside the 24-hour
  window and a decision about who authorises it.
- **`MOCK_WHATSAPP_MEDIA` must stay off in production.** It serves a canned
  fixture instead of calling Meta's media API. It exists for the harness.
- **Test coverage is `src/smoke.ts` (pure logic) plus `src/harness.ts`
  (end-to-end).** There is no unit-test suite around the engine itself.

## Model

Read from `CLAUDE_MODEL`; your `.env` currently sets `claude-haiku-4-5`.

Requests deliberately send no `thinking` or `effort` parameter, so the same code
runs on Haiku and on Opus without changes — `effort` errors on Haiku 4.5. If you
move to `claude-opus-5` for better handling of messy multilingual replies, it is
a one-line env change.
