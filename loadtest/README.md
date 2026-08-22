# Load test rig

An isolated copy of the production application, driven by simulated candidates.
Nothing in `src/` was modified to make it work.

## What is real and what is not

| | |
|---|---|
| Application code | **real** — same modules, same `config.ts`, same queue registrations |
| Concurrency | **real** — read from config, not written here (inbound 8, ocr 3, crm 2) |
| Reply rate limiter | **real** — 20/sec, and deliberately exercised (see below) |
| Anthropic SDK, retries, 429 handling | **real** — only the far end is a mock |
| Fastify, webhook, signature check | **real** |
| MongoDB | **real mongod**, isolated, dropped before every run |
| Anthropic API | **mock** on `127.0.0.1:8788` |
| Meta Graph | **stubbed at the socket** by the fetch guard |
| Veris OCR | **never called** — no documents are sent |
| CRM | **never called** — `CRM_API_URL` unset |

### Why not SHADOW_MODE

Every shadow-mode check in `whatsapp/client.ts` returns *before*
`budgets.replies.acquire()`. With `SHADOW_MODE=true` the 20/sec reply limiter
never runs, so a shadow-mode load test measures the system with its main
bottleneck removed. The rig runs with `SHADOW_MODE=false` and stubs Graph at the
socket instead, so the limiter and its queueing behaviour are what get measured.

### Why it cannot reach anything real

`rig/guard.ts` replaces `globalThis.fetch` with an allowlist:

- `graph.facebook.com` — intercepted, answered locally, never dialled
- `127.0.0.1` / `localhost` — passed through
- **anything else throws**

So Meta, the real Anthropic host, the CRM and Veris are all unreachable by
construction, not by configuration. `blocked outbound (must be 0)` in every
report is the evidence. The rig also refuses to start against a MongoDB whose
host is not loopback, and generates its own throwaway `WHATSAPP_APP_SECRET` —
the production secret is never read and never needed.

## Layout

```
loadtest/
  rig/            the application under test + instrumentation + control server
    index.ts        composes src/ the way src/index.ts does; two ports
    guard.ts        the fetch allowlist and the Graph stub
    instrument.ts   event-loop lag, queue wait/depth, CPU/RSS sampling
  mock-anthropic/
    server.ts       a stand-in for api.anthropic.com
  generator/
    index.ts        the load generator
    scenario.ts     what a simulated candidate does
    stats.ts        percentiles
  fixtures/         empty on purpose — see fixtures/README.md
  docker-compose.yml
  results/          one JSON per run (gitignored)
```

Two ports, and the split matters: the app is on **3100** and everything sent
there counts as load; the control server is on **3101** and is where the
generator reads replies and metrics, so measuring does not add to the thing
being measured.

## Running

### 1. MongoDB

```bash
npm run loadtest:mongo          # docker compose, 127.0.0.1:27018, capped at 1.5 CPU / 3 GB
```

Without Docker the rig falls back to `mongodb-memory-server` and says so.
That mode works but **mongod then competes for the same cores as the
application**, so capacity numbers from it are a floor, not a match for
production. Use the container for any run whose numbers you intend to quote.

### 2. Mock Anthropic

```bash
npm run loadtest:mock
```

`MOCK_LATENCY_MIN_MS` / `MOCK_LATENCY_MAX_MS` (default 1000–2000),
`MOCK_429_RATE`, `MOCK_ERROR_RATE`. All four can also be changed mid-run:

```bash
curl -X POST 127.0.0.1:8788/__config -d '{"rate429":0.1}'
curl 127.0.0.1:8788/__stats
```

### 3. The rig

```bash
npm run loadtest:rig
```

Prints the concurrency it actually resolved. Check that banner before quoting
any number — it is the answer to "are we testing what production runs?".

### 4. The tests

Each run drops the database first, so runs do not contaminate each other.

```bash
npm run loadtest -- --users 10  --messages 20 --think 1500 --rampup 5   --label 10
npm run loadtest -- --users 50  --messages 20 --think 1500 --rampup 15  --label 50
npm run loadtest -- --users 100 --messages 20 --think 1500 --rampup 30  --label 100
npm run loadtest -- --users 250 --messages 20 --think 1500 --rampup 60  --label 250
npm run loadtest -- --users 500 --messages 20 --think 1500 --rampup 120 --label 500
```

Run them in order and read each before starting the next.

| flag | default | meaning |
|---|---|---|
| `--users` | 10 | concurrent simulated candidates |
| `--messages` | 8 | messages each one sends |
| `--think` | 1200 | ms between a reply landing and the next message |
| `--rampup` | 10 | seconds over which users start |
| `--duration` | 0 | hard stop in seconds; 0 = run the script out |
| `--settle` | 5000 | drain time before counters are read |
| `--reply-timeout` | 30000 | ms to wait for one reply |
| `--give-up-after` | 2 | consecutive timeouts before a candidate stops |
| `--reply-settle` | 500 | ms to let a multi-message turn finish |
| `--target` | rig | app URL, if the generator runs on another machine |

**Run the generator on a different machine from the rig** where the numbers
matter. Both on one box means the generator's own CPU is inside the measurement.
Point it with `--target http://<rig-host>:3100 --control http://<rig-host>:3101`.

## Reading the output

Four different things, and they are not interchangeable:

- **concurrent users** — candidates in a conversation at once
- **requests/sec** — HTTP into `/webhook`
- **messages/sec** — inbound candidate messages processed
- **anthropic requests/sec** — model calls, only from free-text answers

A tap is resolved locally by `interpret.ts` and costs no model call; a typed
answer costs exactly one. The scenario mixes both because a tap-only script
makes the bot look far faster than it is and a text-only script far slower.

**ACK latency is not reply latency.** The webhook enqueues and returns 200, so
ACK stays fast long after the bot has stopped keeping up. Reply latency is what
a candidate experiences and it is the number that degrades first. Both are
always reported; judge saturation on the second.

## Known limits of this rig

- No documents, so the OCR path and the media limiter are untested here.
- `mongodb-memory-server` mode shares cores with the app.
- Reply latency is measured to the *first* message of a turn.
- The generator's own cost is inside the numbers when it runs on the same box.
