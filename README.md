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
drives a real candidate conversation through a properly-signed webhook — real
Claude calls, real OCR calls, real storage. Only the outbound send to Meta is
suppressed, so no phone number and no Meta app are involved. It prints the
transcript, the candidate record, the extracted OCR fields, and a pass/fail
verdict per subsystem.

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
| `src/conversation/rules.ts` | **The file you edit.** Persona, rules, checklist, tunables. |
| `src/conversation/checklist.ts` | Deterministic document state machine. |
| `src/conversation/claude.ts` | Model call and tool loop. |
| `src/conversation/engine.ts` | Orchestrates one inbound message end to end. |
| `src/whatsapp/` | Signature check, webhook parsing, Graph API client, rate limiter. |
| `src/ocr/veris.ts` | Veris OCR client and queue handler. |
| `src/storage/` | File storage (local volume today, swappable for S3/R2). |
| `src/db/models.ts` | Collections, indexes, and the dedupe claim. |
| `src/server.ts` | Fastify routes: webhook + read-only CRM endpoints. |

## How a message flows

```
Meta webhook
  → signature verified against the raw bytes
  → wamid claimed (drops Meta's retries)
  → inbound row written, job enqueued, 200 returned    ← must be fast
  → worker, holding a per-candidate lock:
        media?  download → store → file to a slot → queue OCR
        build <state> from the checklist
        call Claude with the cached rules prefix
        apply tool effects, send reply, record what was asked for
```

The split that matters: **the checklist is code, the wording is the model.** The
model never decides whether a document arrived, only how to ask for the next
one. Every state change has a cause you can point at.

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

**Every turn is guaranteed to produce a reply.** The model intermittently treats
a tool call as its entire turn and ends without writing anything. Prompting
alone does not prevent it, so when a turn yields no text the engine retries once
with `tool_choice: none`. Verified across repeated runs: the candidate never
sees the fallback message.

**The system prompt is deterministic.** It is the cached prefix of every
request. Per-candidate state goes in the `<state>` block on the latest user turn
instead. Putting a name or timestamp in `buildSystemPrompt()` silently kills
caching and every message starts paying full input price.

**Credentials never reach the log sink**, and stored files are written `0600`
under a path-traversal-checked root. Candidate passports are PII.

## Known gaps

These are deliberate — flagging rather than hiding them:

- **Storage is a local volume.** Fine on a mounted Dokploy volume; move to
  S3/R2 before this holds real volume. The `storage/` interface is the seam.
- **The candidate lock is per-process.** Single instance only until it is moved
  to Redis.
- **The re-engagement template is wired but never fired.** `sendReengagementTemplate()`
  works; nothing schedules it yet. Replies that land outside the 24-hour window
  are recorded with `error: outside_24h_window` and dropped.
- **The passport and document extractors are wired but unproven.** Only the
  resume path has been exercised against a real file end to end. The other two
  are written against the live OpenAPI schema, but send a real passport scan
  through before trusting them.
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
