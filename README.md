# Adira — WhatsApp document-intake bot

Collects candidate documents over WhatsApp, stores them, runs them through OCR,
and keeps a per-candidate record that the CRM will read.

## Running it

```bash
npm install
npm run smoke        # offline checks — no Mongo, Redis, or network needed
npm run harness      # full end-to-end run, no Mongo or Meta needed
npm run dev          # needs MongoDB reachable at MONGODB_URI
```

`npm run harness` is the one to reach for when you want to know whether the bot
actually works. It starts a real MongoDB in-process, starts the real server, and
drives real conversations through properly-signed webhooks — real Claude calls,
real OCR calls, real storage. Only the outbound send to Meta is suppressed, so no
phone number and no Meta app are involved. It prints the transcript, the
candidate record, the extracted OCR fields, and a pass/fail verdict per
subsystem, and exits non-zero if any of them fail.

Three numbers are driven, so all three opening branches are covered: one
registers end to end and is then tracked and edited, one taps B2B and must reach
a person without a profile being written, and one is abandoned mid-registration
to exercise the idle-session timeout and "start from first".

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
| `src/conversation/rules.ts` | **Documents, thresholds, trigger lists, tunables, the one prompt.** |
| `src/conversation/flow.ts` | **Every question, in order, and what each answer means.** |
| `src/conversation/copy.ts` | Every other sentence a candidate can receive, in en/ta/hi. |
| `src/conversation/trades.ts` | Trade-specific question packs (§8). Add a trade here and nowhere else. |
| `src/conversation/interpret.ts` | The only model call that reads a candidate: reply → option id. |
| `src/conversation/translate.ts` | The only model output a candidate sees: fixed copy, other language. |
| `src/conversation/engine.ts` | Orchestrates one inbound message end to end. |
| `src/conversation/render.ts` | Step → WhatsApp shape (text, ≤3 buttons, or a list). |
| `src/conversation/checklist.ts` | Deterministic document state machine. |
| `src/conversation/cv.ts` | Extracted CV fields → profile fields. |
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
        idle too long?  offer continue-or-restart instead of the open question
        interpret the reply against the question actually asked
        record it with its source and their own wording
        ask the next unsatisfied question, or finish
```

The split that matters: **the bot never composes a sentence.** Every word it
sends is written by a person in `flow.ts` or `copy.ts`, in all three languages.
The model's only job on the way in is to read what the candidate typed and say
which of the offered options it corresponds to — it cannot go off topic because
it has no channel through which to do so. On the way out it is used for exactly
one thing: translating fixed copy for a language we do not ship (`translate.ts`).

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
reply. Nothing is discarded — every answer is written as it arrives — so the only
thing closing a session changes is that the next message is met with *"continue
from where you stopped, or start again?"* rather than a question the candidate
last saw hours ago with no memory of the context.

Choosing **start from first** clears the answers and keeps the documents. §22
forbids destroying an upload without a version history, and someone re-answering
questions has not withdrawn the passport they already sent; re-requesting it
would also break §1. Consent and language survive for the same reason — both are
recorded facts rather than answers being revised.

Closing a session sends nothing. The sweep in `index.ts` only records that it
lapsed, so the CRM can see where registrations are being abandoned; what the
candidate sees is decided on their next message, which is what makes the
behaviour correct even when the sweep has not run.

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
`maxAsksPerStep` the conversation goes to a person rather than asking a fourth
time.

**Option ids the model invents are dropped, not trusted.** The prompt forbids
returning an id that was not offered; `interpret.ts` filters the returned ids
against the offered set, which is what makes that a guarantee rather than a
rule. A step whose choices are declared only inside the renderer would offer the
interpreter an empty list and nothing could ever match — that is what
`acceptedChoices` exists to prevent, and there is a smoke check pinning it.

**The interpreter prompt is deterministic and sees no candidate data.** It is
the cached prefix of every interpretation call, and it is handed one question,
the answers that question accepts, and one message — never a name, a document,
or any other field. Putting anything per-candidate into `INTERPRETER_PROMPT`
silently kills caching and every message starts paying full input price.

**Credentials never reach the log sink**, and stored files are written `0600`
under a path-traversal-checked root. Candidate passports are PII.

## Known gaps

These are deliberate — flagging rather than hiding them:

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
