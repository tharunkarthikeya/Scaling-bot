# Scalability audit — 500 concurrent WhatsApp users

**Read-only audit. No source files were modified.**

| | |
|---|---|
| Scope | `D:\adira bot` @ `main` |
| Target | 500 realistic concurrent WhatsApp users, one application |
| Host | Dokploy · 4 vCPU · 16 GB RAM · 200 GB · 1 instance |
| Date | 22 August 2026 |

---

## Verdict

500 users replying at human pace is roughly **17 inbound turns per second**. The
application cannot approach that today.

`REDIS_URL` is not set, so the queue is the in-process fallback — and that
implementation **silently discards the concurrency argument** and runs every job of
every type through a single serial promise chain. Effective global concurrency is
**1**, not the 4 assumed. A single 120-second OCR call stalls every inbound message
behind it.

Above that sit two more ceilings:

- the outbound rate limiter is shared with read receipts and media downloads, so it
  drains at roughly **10 replies/sec, not 20**;
- although 5 WhatsApp numbers are connected, the code sends from **exactly one**
  hardcoded number.

The first two are fixable in place, on this server, with no Redis and no new
infrastructure.

> **Deployment gap to confirm first.** These values come from the repository `.env`,
> which is the local development file. Production runs on Dokploy with its own
> environment, which I cannot read. **If `REDIS_URL` is set there**, the queue is
> BullMQ and real concurrency is 4 — the picture improves, but the outbound and
> phone-number ceilings still stand. Check this before acting on D1.

---

## 1. Message lifecycle — arrival to reply

| # | Step | Class | Blocks ACK |
|---|---|---|---|
| 1 | Fastify receives `POST /webhook`, raw body buffered (`bodyLimit` 5 MB) | CPU | yes |
| 2 | HMAC-SHA256 over raw bytes — `verifySignature` | CPU | yes |
| 3 | `JSON.parse` + `parseWebhook` flattens Meta's envelope | CPU | yes |
| 4 | `claimEvent(wamid)` — `insertOne` on a unique index, drops Meta retries | I/O · Mongo | yes |
| 5 | `appendTurn` — persist the inbound message | I/O · Mongo | yes |
| 6 | **`captureAttachment`** — 2 Graph hops + SHA-256 + disk write | **External** | **yes** |
| 7 | `queue.enqueue('inbound_message')` — appends to chain, returns | — | no |
| 8 | `void markAsRead(wamid)` — fire-and-forget, **but takes a send token** | External | no |
| 9 | `200 { received: true }` — always 200, even on partial failure | — | ACK |
| 10 | Worker: `withCandidateLock(waId)` — in-memory `Map` | — | — |
| 11 | `handleInboundMessage` — ~10–15 Mongo round trips | I/O | — |
| 12 | **`client.messages.create`** — ~55% of turns; taps resolve locally | **External** | — |
| 13 | Record answer, `nextStep` recompute over ~60 steps | CPU (trivial) | — |
| 14 | **`send()` → Graph API** through the 20/sec bucket | **External** | — |
| 15 | If a document arrived: `ocr` job, up to 120 s, **same serial chain** | External | — |

Step 6 is deliberate — acking while the only copy of a file is a media id on Meta's
servers loses it if the worker dies — but it makes ACK latency a network round-trip.

---

## 2. Inspection findings (Q2–Q13)

| Question | Finding | Evidence |
|---|---|---|
| **CPU-bound** | HMAC verify; JSON parse; SHA-256 per upload; **PDF page-count converts the entire buffer to a latin1 string and regex-scans it** — up to 5 MB, synchronous, on the event loop | `whatsapp/signature.ts`, `storage/index.ts`, `ocr/veris.ts inspectUpload` |
| **I/O-bound** | Everything else. The app is overwhelmingly I/O-bound — which is why concurrency, not cores, is the lever | — |
| **External APIs** | Meta Graph (send, read receipt, media resolve, media fetch), Anthropic (5 separate client instances, one key), Veris OCR (3 extractors), CRM (optional). Voice transcription is a stub returning `undefined` — no STT dependency | `whatsapp/client.ts`, `interpret\|faq\|respond\|tradeQuestions\|translate.ts`, `ocr/veris.ts`, `crm/client.ts`, `conversation/audio.ts` |
| **Blocks ACK** | Signature, parse, `claimEvent`, `appendTurn`, and — when a file is attached — the **full media download and disk write** | `server.ts` |
| **Concurrent jobs** | **1.** `InProcessQueue.register()` takes no concurrency parameter; `enqueue()` chains every job onto one promise. The `4` passed in `index.ts` is discarded | `queue/index.ts`, `index.ts` |
| **Same-candidate races** | No. `withCandidateLock` serialises per `waId`, and the OCR worker takes the same lock before writing. Correct on one instance | `queue/index.ts`, `ocr/veris.ts` |
| **Multi-replica safe** | **No.** In-memory lock and local-disk storage. Sweeps and `claimEvent` are safe (DB-claimed); the turn lock is not | `queue/index.ts`, `storage/index.ts` |
| **Local filesystem** | All candidate uploads. `STORAGE_PATH`, container volume `/data/storage`. Read back by the OCR worker and CRM sync | `storage/index.ts`, `Dockerfile` |
| **MongoDB** | Single client, `maxPoolSize: 20`, `retryWrites` on. `mongodb://` scheme — not Atlas SRV, so likely local and low-latency. Indexes comprehensive, including a TTL on the dedupe table | `db/client.ts`, `db/models.ts` |
| **Anthropic** | No app-level concurrency cap, no explicit retry config, no queue. Prompt caching used correctly (static system prefix). 5 clients share one key and one org rate limit | 5 call sites |
| **OCR** | Concurrency nominally 4 (actually 1), 120 s timeout, `AbortController`, no internal retry. Three routes only; PAN/licence/certificate never sent | `ocr/veris.ts runOcr` |
| **Outbound limiting** | One global token bucket at 20/sec, **shared by sends, read receipts and media downloads** | `whatsapp/rateLimiter.ts`, `whatsapp/client.ts` |

---

## A. Current architecture

One Node 22 process on Alpine, single-threaded, no clustering. Fastify serves the Meta
webhook and the admin API **on the same event loop that runs every queue worker and
every background sweep**. There is no separate worker process.

| Component | Implementation | Isolation |
|---|---|---|
| HTTP | Fastify, container port 3000 | Shared event loop |
| Queue | In-process promise chain (`REDIS_URL` unset) | Shared event loop |
| Workers | `inbound_message`, `ocr`, `crm_sync` | Shared serial chain |
| Sweeps | Reminders 15 min · sessions 60 s · CRM reconcile 5 min · taxonomy timer | `setInterval`, same loop |
| State | MongoDB, pool 20 | External |
| Files | Local disk `/data/storage` | Container volume |
| Locking | In-memory `Map<waId, Promise>` | Process-local |

---

## B. Current concurrency limits

| Limit | Configured | Actually in effect | Set at |
|---|---|---|---|
| Inbound workers | 4 | **1** (shared with all job types) | `index.ts` → `queue/index.ts` |
| OCR workers | 4 | **1** (same chain) | `index.ts` |
| CRM sync workers | 4 | **1** (same chain) | `index.ts` |
| Outbound sends | 20/sec | **~10/sec of replies** | `OUTBOUND_RATE_PER_SECOND` |
| Mongo pool | 20 | 1–2 in use | `db/client.ts` |
| Anthropic in flight | uncapped | 1 (queue-limited) | — |
| OCR timeout | 120 s | 120 s — blocks the chain | `VERIS_OCR_TIMEOUT_MS` |
| Webhook body | 5 MB | 5 MB | `server.ts` |
| Node processes | 1 | 1 of 4 cores | `Dockerfile` |

---

## C. Expected bottlenecks at 500 users

**Load model.** 500 open conversations, one reply every ~30 s of human pace →
**16.7 turns/sec sustained**, bursting to ~33/sec. A registration is ~15 questions and
~30 messages; roughly 45% of turns are button taps that never reach the model.
Average service time per turn ≈ **0.57 s** (0.55 × ~1 s model + 0.45 × ~50 ms local).

| Subsystem | Required @ 500 | Capacity | Status |
|---|---|---|---|
| Webhook ingest | 17/sec | ~500/sec | headroom |
| **Job execution** | 17/sec | **1.8/sec** | **OVER — 10×** |
| **Outbound Graph** | 34 tokens/sec | **20/sec** | **OVER — 1.7×** |
| Anthropic | ~9 calls/sec | tier unknown | verify |
| Veris OCR | 0.2 docs/sec | ~0.4/sec | tight, vendor-bound |
| MongoDB | ~200 ops/sec | thousands | headroom |
| CPU | ~0.25 core | 1 usable of 4 | headroom |
| Memory | ~2 GB | 16 GB | headroom |

### Secondary pressures

- **The idle-session sweep is a send burst.** Runs every 60 s against a 5-minute
  timeout, closing up to 200 sessions per tick, each sending a message — 200 outbound
  tokens, 10 seconds of the entire budget, competing with live traffic. At 500 users a
  5-minute timeout fires constantly, because finding a passport takes longer than five
  minutes.
- **Event-loop stalls from PDF inspection.** `inspectUpload` stringifies the whole
  buffer and regex-scans it. On a 5 MB PDF that is tens to hundreds of milliseconds of
  blocked loop — during which no webhook is acked and no reply is sent.
- **No retry, no durability.** The in-process queue drops jobs on restart and never
  retries. Every deploy during business hours loses whatever was mid-flight.
- **Anthropic 429s are unhandled at app level.** A rate-limited interpretation returns
  `unclear`, and two of those hand the candidate to staff. Under load the failure mode
  is **mass false handoffs**, not visible errors.

---

## D. Critical blockers

### D1 · Queue concurrency is 1, not 4 — BLOCKER

`InProcessQueue.register()` accepts no concurrency argument, so the `4` passed at
registration is silently dropped. `enqueue()` appends to a single `this.chain` promise,
so inbound turns, OCR extractions and CRM syncs all execute one at a time, globally.
One 120-second OCR call blocks every conversation. A ~10× throughput deficit before any
other limit applies.

**Where:** `src/queue/index.ts` — `class InProcessQueue` · registered in `src/index.ts`

### D2 · Read receipts and media downloads spend the send budget — BLOCKER

`markAsRead()` and `downloadMedia()` both call `limiter.acquire()` on the same 20/sec
bucket as replies. Every inbound message costs one token before a reply is composed,
halving effective reply capacity to ~10/sec. Meta's 20/sec Coexistence limit governs
*messages sent*; read receipts and media reads are not the same quota — this is
self-imposed.

**Where:** `src/whatsapp/client.ts` — `markAsRead`, `downloadMedia`, shared `limiter`

### D3 · Five numbers connected, one number used — VERIFY URGENTLY

`WHATSAPP_PHONE_NUMBER_ID` is a single required string, and every send, read receipt and
media fetch hardcodes it. `parseWebhook` never reads `value.metadata.phone_number_id`,
so the app cannot tell which number received a message. If all 5 numbers point at this
webhook, replies to four of them go out from the wrong number — a different thread to
the candidate, and the 24-hour window is per number-and-user pair, so those replies may
be rejected outright. It also strands 4× your available send capacity.

**Where:** `src/config.ts` · `src/whatsapp/client.ts` · `src/whatsapp/parse.ts` ·
idempotency keys in `src/crm/mapping.ts` and `src/ingestion/whatsapp.ts` also key on
this value

### D4 · In-memory candidate lock — blocks scale-out

`withCandidateLock` is a process-local `Map`. Two instances would answer the same
candidate twice. This blocks replicas **and** Node's `cluster` module, so the other
three cores stay idle. Already documented in `DEPLOY.md` and `README.md`.

**Where:** `src/queue/index.ts` — `withCandidateLock`

### D5 · Local-disk storage — blocks scale-out

Uploads are written to a container volume and read back by the OCR worker and CRM sync.
A second instance would not see the first's files. The `storage/` module is already
written as the swap seam for object storage.

**Where:** `src/storage/index.ts` · `STORAGE_PATH` · `Dockerfile` volume

---

## E. Safe changes on this 4-core / 16 GB server

All in-place code or config. No Redis, no object storage, no replicas, no second
machine. Ordered by throughput gained per unit of risk.

| # | Change | Gain | Exact location | Risk |
|---|---|---|---|---|
| **E1** | Give read receipts and media downloads their own limiter (or none) so the 20/sec bucket is replies only | Reply capacity **10 → 20/sec** | `whatsapp/client.ts` — separate `RateLimiter` instances; `markAsRead`, `downloadMedia` | Low |
| **E2** | Make `InProcessQueue` honour the concurrency argument — a bounded worker pool per job type instead of one shared chain | Throughput **1.8 → ~18 turns/sec** | `queue/index.ts` — `InProcessQueue.register` / `enqueue`; keep the `JobQueue` interface unchanged | Medium |
| **E3** | Isolate OCR from the inbound path so a 120 s extraction can never stall a conversation | Removes the worst stall | Falls out of E2 — separate pool per job name | Low |
| **E4** | Stop stringifying whole PDFs — count pages by scanning the `Buffer` directly, or cap the scan window | Removes event-loop stalls | `ocr/veris.ts` — `inspectUpload`, the `buffer.toString('latin1')` line | Low |
| **E5** | Cap in-flight Anthropic calls and handle 429 with backoff, so rate limiting degrades into waiting rather than false handoffs | Prevents mass handoffs | `conversation/interpret.ts` + 4 sibling call sites — shared semaphore + `maxRetries` | Medium |
| **E6** | Raise `maxPoolSize` in step with worker concurrency | Avoids pool starvation | `db/client.ts` — `maxPoolSize: 20` → ≥ concurrency + sweep headroom | Low |
| **E7** | Smooth the idle-session sweep: smaller batch, and revisit the 5-minute timeout for a flow where people go and find documents | Frees ~10 s of send budget per tick | `index.ts SESSION_SWEEP_MS` · `engine.ts endIdleSessions(limit)` · `rules.ts TUNABLES.sessionTimeoutMinutes` | Product call |
| **E8** | Add per-turn timing and queue-depth metrics **before** load testing anything | Makes section G measurable | `conversation/engine.ts handleInboundMessage` · `queue/index.ts` · `logger.ts` | Low |
| **E9** | Confirm the Anthropic org tier covers ~9 calls/sec | Removes an unknown | Console, not code. `CLAUDE_MODEL=claude-haiku-4-5` is already the right latency choice | None |
| **E10** | Confirm Veris' own concurrency and rate limits | Removes an unknown | Vendor question. Nothing in-app can exceed it | None |

**E1 + E2 + E4 together** take the app from ~1.8 turns/sec to roughly 18 — covering 500
users at human pace on this one box, with the outbound limiter at ~85% utilised as the
remaining squeeze. That is the whole target, without new infrastructure.

What it does **not** buy is durability: jobs are still lost on restart and never
retried. That is what Redis is for, and it stays out of scope until you say otherwise.

---

## F. Do not change yet

| Change | Why not yet |
|---|---|
| Redis / BullMQ | Out of scope by your instruction. Note it is the correct long-term fix for E2 — durability and retries are real gaps E2 does not close. |
| S3 / R2 | Out of scope. Required before replicas, not before 500 users on one box. |
| Replicas / Kubernetes | Unsafe until D4 and D5 are fixed. Two instances would double-answer candidates. |
| Node `cluster` to use the other 3 cores | Same blocker as replicas — each worker gets its own in-memory lock `Map`. Tempting because the cores are idle; still wrong. |
| Raising `OUTBOUND_RATE_PER_SECOND` above 20 | Meta **drops** over-limit messages rather than queueing them. Raising this loses candidate replies silently. |
| Raising OCR concurrency | Meaningless until E2 lands, and then bounded by Veris' limits (E10), not ours. |
| Raising worker concurrency blindly | Past ~20 you just move the queue from the chain to the outbound limiter. Concurrency should be raised **to** a measured number, not past it. |
| Lowering the 5 MB webhook body limit | Not a bottleneck — media arrives by id, not inline. |

---

## G. Load-testing plan

### The rig already exists

`src/harness.ts` boots an in-process MongoDB, starts the real server, and drives real
conversations over **properly signed webhooks**. Its helpers — `postWebhook`,
`textMessage`, `tapMessage`, `answerCurrentQuestion(waId)` — are already parameterised
by `waId`. A load rig is that harness driving N synthetic numbers concurrently, not a
new tool.

> **Do not test in `SHADOW_MODE`.** It suppresses outbound sends, which is precisely the
> bottleneck you are trying to measure. Point the Graph base URL at a local mock that
> sleeps ~80 ms and returns a wamid, so the limiter and the send path both run for real.
> Keep `MOCK_WHATSAPP_MEDIA=true` so document runs don't hammer Meta.

### Instrument before you run — all of these, every stage

- **Webhook ACK latency** p50/p95/p99 — the one Meta cares about. Sustained p95 above
  ~1 s means redeliveries and duplicate work.
- **Queue depth over time** — the clearest pass/fail signal. Flat is passing;
  monotonically rising is failing, whatever the averages say.
- **End-to-end turn latency**, inbound receipt → outbound send.
- **Outbound limiter wait time** — isolates D2/E1 from everything else.
- **Event-loop lag** — catches the `inspectUpload` stall (E4). Watch it specifically
  during document-heavy runs.
- **Anthropic latency and 429 rate**; count `unclear` classifications and staff handoffs
  as a proxy for silent degradation.
- **RSS and per-core CPU**; Mongo op latency and pool checkout time.

### Stage 1 — 100 users · ~3.3 turns/sec · text only

- Establish the baseline and confirm the rig is honest.
- No documents yet — isolate the conversational path.
- Run 20 minutes minimum; short runs hide queue growth.

**Pass:** queue depth flat, ACK p95 < 300 ms, zero unexplained handoffs.
**Expect to fail this today** — 3.3/sec is already ~2× the serial chain.

### Stage 2 — 250 users · ~8.3 turns/sec · with documents

- Introduce ~3 uploads per registration to exercise OCR and the ACK-blocking download.
- This is where E4's event-loop stall and OCR isolation get proven.
- Include one deliberate restart mid-run to measure job loss.

**Pass:** ACK p95 < 500 ms with documents in flight, OCR backlog draining, event-loop
lag p99 < 100 ms.

### Stage 3 — 500 users · ~16.7 turns/sec sustained, burst to 33/sec

- Full mix: documents, taps, free text, FAQ questions, idle-session sweeps firing.
- Run 60 minutes so the reminder and reconcile sweeps both fire during the test.
- Add a burst phase — 2× for 60 s — to size the queue rather than just the average.

**Pass:** queue depth returns to zero after the burst, outbound limiter wait < 500 ms
p95, no candidate waits > 10 s for a reply.

### Sequencing

1. Confirm the Dokploy environment — is `REDIS_URL` set in production?
2. Land **E8** (instrumentation) only. Change nothing else.
3. Run **Stage 1** against today's code for a true baseline. Expect failure; record where.
4. Land **E1, E2, E4, E6**. Re-run Stage 1, then Stage 2.
5. Resolve **D3** (the phone-number question) before Stage 3 — at 500 users across 5
   numbers it stops being a capacity question and becomes a correctness one.
6. Run **Stage 3**. Take the measured numbers back into the E-list before deciding
   anything about Redis.

---

*Read-only audit. No source files were modified. Figures for job execution, outbound
capacity and per-turn service time are derived from the code paths cited; Anthropic and
Veris ceilings are unverified vendor limits and are marked as such. Production
environment values could not be read and are assumed from the repository `.env` —
confirm before acting on D1.*
