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
| `src/conversation/flow.ts` | **Every question, in order, and what each answer means — for both numbers.** |
| `src/conversation/lines.ts` | **Which number a conversation is on, and which flow that number runs.** |
| `src/conversation/copy.ts` | Every other sentence a candidate can receive, in en/ta/hi. |
| `src/conversation/trades.ts` | Trade-specific question packs (§8). Add a trade here and nowhere else. |
| `src/conversation/tradeQuestions.ts` | **Questions written per candidate for a job no pack covers, and the filter around them.** |
| `src/conversation/interpret.ts` | The only model call that reads a candidate: reply → option id. |
| `src/conversation/jobLevel.ts` | Whether the job someone wants is one a CV speaks to. Second number only. |
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

## Two numbers, two flows

The agency runs two WhatsApp numbers off one app, and they do not ask the same
questions. Which flow a conversation gets is decided from the `phone_number_id`
Meta puts in the webhook envelope, in `conversation/lines.ts`, and nowhere else:

| Number | WABA | Flow | |
|---|---|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | `WHATSAPP_WABA_ID` | `STEPS` | The flow this bot has always run. Unchanged. |
| `WHATSAPP_PHONE_NUMBER_ID_SGMY` | `WHATSAPP_WABA_ID_SGMY` | `SGMY_STEPS` | Singapore and Malaysia. |

The two numbers are on two WhatsApp Business Accounts. Whether they are also on
two Meta **apps** is the question that decides two more settings:

| | Under one app | Under two apps |
|---|---|---|
| App secret | shared — leave `WHATSAPP_APP_SECRET_SGMY` unset | set it, or every webhook from the second number fails its signature check |
| Access token | shared — leave `WHATSAPP_ACCESS_TOKEN_SGMY` unset | set it, or every reply to the second number gets a 401 |

Both failures look identical from outside: the bot ignoring that number. Each
setting falls back to the main line's value, so unset means "same app" and
nothing changes for a deployment that has only ever had one number.
`npm run doctor` checks both numbers and both WABA subscriptions, each on its own
token, and refuses at boot if the two numbers are set to the same id.

**Leave the second variable unset and there is no second line.** Every message
runs the default flow, which is the state every existing deployment is in — an
unrecognised number, a blank one, and an envelope with no metadata at all all
resolve to the default, because the default is the flow that is safe to run for
anyone.

### The Singapore/Malaysia flow

```
Apply
  → Language
  → Consent
  → Personal details             ← no CV here
  → Country preference           ← Singapore | Malaysia. Nothing else.
  → Experience
  → Trade-specific questions
  → Job preferences
  → CV                           ← only if the job is one a CV speaks to
  → Documents
  → Confirm
  → Application ID
```

Three differences from the default flow, and nothing else. Every other question,
the opening menu, the B2B branch, tracking, the documents, the edit and update
menus, the idle-session prompt and the handoff to staff are the same code — the
shared steps are the *same objects* in both lists, so a question added to a
shared section appears on both numbers without anyone remembering to add it
twice.

**No CV up front.** The default flow asks for it immediately after consent
because it is the only step that can answer other steps — the resume extractor
fills the name, date of birth, education, trade and experience, and `nextStep`
then walks past every question it filled (§1, §5). This flow gives that up. Its
CV is collected after the personal and experience sections have already been put
to the candidate by hand, so it is a document for a recruiter to read rather
than a shortcut through the flow. That is the price of not asking a cleaner for
a résumé, and it is worth stating rather than discovering.

**Two destinations.** `country_preference_sgmy` replaces the five-row question
and the free-text follow-up behind its "Select countries" row — there is nothing
to select from and no "any country", which on this line would be a preference
nobody can act on. It writes the same `countryPreference` field as the default
question, so a record reads the same way whichever number wrote it. The ids are
`singapore` and `malaysia`; `destination_country` reaches the CRM only if an
admin has both in the CRM's country taxonomy, which `verify:taxonomy` reports.

**The CV is asked of some candidates and not others.** After the job
preferences — the first point at which the job they *want* is known, as distinct
from the one they are leaving — `jobLevel.ts` classifies that job:

| | |
|---|---|
| `low_skill` | Cleaning, helping, packing, loading, portering, general labour, kitchen work. **No CV asked.** |
| `skilled` | Trades, operators, drivers, technicians, healthcare, office and technical roles, anything supervisory. **CV asked.** |
| `unknown` | Too vague to place. **CV asked.** |

Most candidates never reach a model for it: two phrase lists settle the common
titles by comparison, the way `interpret.ts` resolves a tapped button. The lists
are phrases rather than words for the reason `tradeQuestions.ts` gives at
length — and skilled is tested first, because a "welder helper" is someone
learning a trade and often the one person in the group holding a certificate
worth sending.

**Every failure path asks for the CV.** No tool call, a value that is not one of
the three, a model outage — all of them end with the question being put. A CV
question can be declined in one tap; a CV never asked for is a document nobody
finds out was available. The classification is stored beside the job it was
computed for, so it costs one call per candidate and re-runs only when an edit
changes the job.

The level says how much a **résumé** adds for a **job**. It is not an assessment
of the candidate, it is never shown to them, and it is not sent to the CRM — a
recruiter reading a profile has the job title itself, which is better evidence
than our guess about it.

### What a second number costs elsewhere

Replies, read receipts and the re-engagement template are all posted to the
number the conversation belongs to, which is stored on the record as
`phoneNumberId` — the 24-hour window belongs to the pair, so a reply sent from
the other number is not merely confusing, it is one Meta refuses. The sweeps
need it for the same reason: they send outside any inbound context and would
otherwise have nothing to send from.

A conversation is stamped with its line and its flow when its record is created
and keeps both. `npm run doctor` checks that the token can see both numbers, and
that they are not the same id.

## The opening menu

Anyone messaging the number is offered three things, and the branch decides how
much of the machinery runs at all:

| Option | What happens |
|---|---|
| Other | Opens a second, two-option menu: **B2B enquiry** or **Talk to staff** — the only place either is offered. |
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

### Other → Talk to staff

The one route to a person a candidate can choose. It no longer hands the
conversation straight over: a member of staff picking it up used to get a phone
number and nothing else, and their first four messages were always the same four
questions. Those are asked here instead.

```
Other → Talk to staff
  1. Language
  2. Full name
  3. Country preference        ← whichever question this number asks
  4. Passport — do you have one?
     ...if yes, upload         → read by the passport extractor
  5. Aadhaar upload            → read by the document extractor
  6. PAN upload                → stored, never read
  7. Confirm
  → "Our staff will contact you shortly", with a reference number
  → the conversation goes to a person
```

Every one of those is a step that already existed. Nothing here is a new
question; what is new is which of them are asked, and in what order. The
documents route to OCR exactly as they do in registration, because they are the
same slots — `rules.ts` decides, `NEVER_OCR` keeps the PAN away from both
extractors, and there is nothing configured separately here that could drift.

The reference number is an **`ENQ-00001`, not an `ADR-`**, on its own counter. An
ADR id means a registration a recruiter can work on; this is somebody who asked
for a call back, and giving the two the same shape would have staff opening one
expecting the other. Both are recognised at the tracking question and anywhere
else a candidate quotes one.

The record stays in `candidates` — it is a person, their passport and their
Aadhaar, and the uploads belong where every other candidate's go. Only the B2B
branch is filed apart, and only because a business contact is not applying for
anything. What a staff enquiry does *not* get: a CV, trade questions, job
preferences, a CRM submission, or a §21 reminder.

Nothing asks for a date of birth, and tracking needs one. In practice the
passport and Aadhaar extractors supply it, which is what makes the reference
number checkable later; where neither yielded one, tracking says so rather than
releasing a status on an unverified claim.

### The staff option is gone from everywhere else

It used to appear on the confirmation, on the returning menu, on the consent
question, and as an extra row under seven steps and every re-asked question. A
button offering a human on every screen is an invitation to leave, and it was
being offered hardest at the moments a candidate was most likely to take it —
underneath a question they had just failed to answer.

There is now exactly one: **Other → Talk to staff**. A smoke check walks all four
flows and every menu to keep it that way.

**The automatic escalations are untouched.** Distress, a report that somebody has
demanded money, a legal or medical matter, an under-age date of birth, and two
replies the bot could not read all still reach a person immediately, with no
questions in front of them. Putting a document checklist between somebody and
help is the one thing this change must not do. Typing "talk to staff" mid-flow
also still reaches a person directly — they are already deep in a conversation
that has their details.

### "I have lost my Application ID"

Two attempts at an id are a typo, and both get the same answer: check it and send
it again. The third miss is somebody who genuinely does not have it, so that is
when a **Forgot my ID** row appears:

```
Application ID?  → miss  → "check it and send it again"
                 → miss  → "...or tap below"   [ Forgot my ID ]
                              ↓
                         mobile number → date of birth
                              ↓
                    both match a record on this number
                              ↓
                    "Your Application ID is ADR-00042"
```

It is the tracking check with its halves swapped: instead of an id confirmed by a
date of birth, a mobile number and a date of birth that between them name the id.
Scoped to the number that sent it, exactly as the id lookup is — an id is short
and sequential, and a lookup that answered for any number would hand one person's
reference, and the fact that their record exists, to anybody who guessed a phone
number. The mobile is a second factor, not the search key, and it is checked
against both the number they are messaging from and the one recorded on their
profile.

It costs attempts on the same budget as the date-of-birth check, and a date it
could not parse costs nothing — that is somebody who has not understood the
format, not somebody guessing.


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

## The ATS export (`resume_ats`)

A finished conversation is copied into `resume_ats`, a second database on this
same MongoDB deployment — not a second server, and not an API, so it needs no
connection string of its own. Blank `RESUME_ATS_DB` to turn the export off.

Every row the bot writes carries **`source: 'whatsapp'`**, so it is obvious which
records it put there and which arrived some other way.

| Collection | What goes in it |
|---|---|
| `candidates` | One row per person — a registration, or somebody who asked to speak to staff. Their answers, flattened. |
| `messages` | One row per person: the whole conversation, every sitting in order. |
| `aadhaar_records` | One row per Aadhaar upload, with what the extractor read off it. |
| `passport_records` | One row per passport upload, likewise. |
| `sourcing_clients` | One row per business contact, `type: 'b2b agents'`. Not a candidate row — see below. |
| `b2b_company_documents` | A business contact's company paperwork — registration certificate, MSME certificate, whatever they sent. **No OCR.** |
| `b2b_messages` | One row per business contact: their whole conversation. |
| `b2b_agent_aadhar` | The agent's own Aadhaar, both sides, with what was read off them. |

**Nothing that already exists is created.** `ensureAtsCollections` lists what is
in `resume_ats` at boot and creates only the missing names. It never drops,
never renames, and never alters a collection it did not create — including its
indexes, because a unique index dropped onto a populated collection fails on the
first duplicate and takes the deploy with it. A collection created here gets a
non-unique index on its natural key and nothing more.

**Nothing is overwritten blind.** Every write is an upsert on a natural key — the
WhatsApp id for a person, the upload id for a document — so a retry, a redeploy,
or a document that arrived late updates one row rather than adding another. The
export is idempotent by construction and safe to run again.

The bot's own database stays the record of what happened; this is a copy for the
ATS to read. It runs on the queue after the person has been told they are done,
for the reason the CRM sync does: whether another database is reachable that
second is not the candidate's problem.

### Which branch writes where

| | `candidates` | `messages` | documents |
|---|---|---|---|
| **Apply** | ✓ | ✓ | `aadhaar_records`, `passport_records` |
| **Talk to staff** | ✓ | ✓ | `aadhaar_records`, `passport_records` |
| **B2B** | `sourcing_clients` | `b2b_messages` | `b2b_company_documents`, `b2b_agent_aadhar` |

A staff enquiry is filed with the candidates deliberately: they gave the same
name and the same documents, and a recruiter opening the record should not have
to know which menu brought them in. `enquiry` on the row says which it was. A
business contact has no candidate row, here or in the bot's own database — they
go to `sourcing_clients` with `type: 'b2b agents'` and `source: 'whatsapp'`,
because an agent sourcing workers is not somebody applying for a job and a
recruiter's candidate list is the one place they must never appear. A separate
collection rather than a flag on a candidate row, because a flag is something a
query can forget to filter on. If the ATS spells that type differently, it is
one constant in `ats/export.ts`.

Every version of a document is exported and nothing is ever removed (§22), so a
reader wanting "their Aadhaar" filters on **`isCurrent: true`** rather than
guessing from dates.

**The PAN has no collection of its own**, because none was asked for. Nothing
reads a PAN (`NEVER_OCR`), so there is no extraction to file — it is named on the
candidate row's `documents` index with its status, which is what a documentation
officer needs to find the file. The CV, driving licences and loose certificates
are indexed the same way. Say the word if the PAN should have a `pan_records`
collection like the other two.

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

**There is one button to reach a person, and it is not a shrug.** "Other →
Talk to staff" on the opening menu, which runs the intake above before handing
over — or "talk to staff" typed at any point, which hands over directly. The
option is attached to nothing else: not to the confirmation, not to the
returning menu, not to a retry, not to a question with no approved answer, not
to a reply the bot understood but could not record. It used to be on all of
them, which meant it was offered hardest underneath a question the candidate had
just failed to answer.
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
- **The second number is not driven end to end.** `npm run smoke` pins its
  question order, its two-country question, both sides of the CV decision and
  the routing; `npm run harness` still drives the default line only. The
  envelope it posts carries `phone_number_id`, so pointing a driven number at
  the second line is a parameter rather than a rewrite.
- **One record per number, not per person.** The record is keyed on `waId`, so
  somebody who writes to both numbers has one conversation, on whichever line
  they wrote to first. The other number's flow is not offered to them and their
  replies keep coming from the first. It is logged when it happens.
- **The Singapore/Malaysia CV answers nothing.** Collected after the personal
  and experience sections, it cannot skip the questions it fills on the default
  line — see **Two numbers, two flows** above. If that saving matters more than
  not asking a cleaner for a résumé, move `CV_STEP` back up `SGMY_STEPS`; the
  step itself is shared and needs no change.
- **`singapore` and `malaysia` must exist in the CRM's country taxonomy** for
  `destination_country` to reach it. The bot offers them either way; the CRM
  simply receives no destination until an admin adds them. `npm run
  verify:taxonomy` prints the list it actually has.
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
#   S c a l i n g - b o t 
 
 