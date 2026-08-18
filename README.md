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
end and is then tracked and edited, one taps B2B and must reach a person without
a profile being written, one is abandoned mid-registration to exercise the
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
| `src/db/models.ts` | Collections, indexes, and the dedupe claim. |
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
| B2B enquiry | Straight to a person. No consent notice, no profile, no questions. |
| Track application | Reads back the outcome staff recorded. Nothing else. |
| Apply for a job | The registration flow. |

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

Choosing **restart** clears the answers and keeps the documents. §22
forbids destroying an upload without a version history, and someone re-answering
questions has not withdrawn the passport they already sent; re-requesting it
would also break §1. Consent and language survive for the same reason — both are
recorded facts rather than answers being revised.

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
