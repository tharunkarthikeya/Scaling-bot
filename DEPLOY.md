# Deploying to Dokploy

## The order that matters

1. Database (done)
2. App service + environment
3. Domain → HTTPS
4. Meta callback URL → that domain
5. `npm run doctor` inside the container

Skipping step 4 is the usual reason a correctly-deployed bot stays silent.

---

## 1. Database

Already created. Two things to fix on it:

**Remove `NODE_ENV` and `PORT` from the database service's Environment tab.**
Those belong to the app, not to MongoDB. They do nothing there.

**Remove the External Port (27017).** Setting it publishes MongoDB to the open
internet, and this database holds candidate passports and CVs. The app reaches
it over Dokploy's internal network, so the external port buys nothing and is a
standing exposure. Leave it blank unless you specifically need to connect a GUI
from your laptop — and if you do, take it back out afterwards.

---

## 2. App service

Create a **separate** service (Application, not Database) in the same Dokploy
project — same project is what makes the internal hostname resolve.

- Build type: **Dockerfile** (one is in the repo root)
- Port: **3000**

### Environment

Paste this into the *app* service's Environment tab, filling in the four
bracketed values:

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Copy the "Internal Connection URL" from the database service and append the
# database name + authSource. Do NOT use localhost — that is the app's own
# container, where nothing is listening.
MONGODB_URI=<paste Internal Connection URL>/mountroad_wa_bot?authSource=admin
MONGODB_DB=mountroad_wa_bot

# --- Meta WhatsApp Cloud API ---
WHATSAPP_APP_SECRET=<from your .env>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<from your .env>
WHATSAPP_ACCESS_TOKEN=<from your .env>
WHATSAPP_PHONE_NUMBER_ID=<from your .env>
WHATSAPP_WABA_ID=<from your .env>
WHATSAPP_GRAPH_API_VERSION=v25.0
WHATSAPP_REENGAGEMENT_TEMPLATE=<from your .env>
WHATSAPP_REENGAGEMENT_TEMPLATE_LANG=en

# --- Anthropic ---
ANTHROPIC_API_KEY=<from your .env>
CLAUDE_MODEL=claude-haiku-4-5

# --- Veris OCR ---
VERIS_OCR_BASE_URL=https://veris.recursai.in
VERIS_OCR_API_KEY=<from your .env>
VERIS_OCR_TIMEOUT_MS=120000

STORAGE_PATH=/data/storage
SHADOW_MODE=false
OUTBOUND_RATE_PER_SECOND=20
```

`MOCK_WHATSAPP_MEDIA` must not be set here. It replaces real candidate documents
with a test fixture.

### Volume

Mount a persistent volume at **`/data/storage`**. Without it, every redeploy
destroys candidate documents that have not been reviewed yet.

### Redis (optional for one instance, required for more than one)

Without `REDIS_URL` the queue, the per-candidate lock and the outbound rate
limiters are all per-process. That is correct for exactly **one** instance, and
it is what this bot has run on so far — but jobs are lost on restart and never
retried.

**Do not run more than one replica without Redis.** Three things break, and only
the first is obvious:

- the per-candidate lock is per-process, so two instances answer the same
  candidate twice;
- the outbound limiter is per-process, so three replicas send 60/sec against
  Meta's 20/sec — and Meta *drops* the overage rather than queueing it, so
  scaling out makes delivery worse;
- documents are written to a local volume by whichever instance received them
  and are not visible to the instance that later reads them back for OCR.

With `REDIS_URL` set, all three become fleet-wide and the replica count is free.

Create a Redis service in the **same Dokploy project** and use its Internal
Connection URL — the hostname is the service name on the internal network, port
6379. Do not expose it publicly: it holds candidate lock state and job payloads.

### More than one instance

Set `ROLE` per service. One image, three deployments:

| ROLE | Serves | Consumes | Sweeps | Scale with |
|---|---|---|---|---|
| `all` | webhook + API | yes | yes | *the default; leave it here for one instance* |
| `web` | webhook + API | no | no | inbound traffic |
| `worker` | `/health`, `/metrics` | yes | no | queue backlog |
| `scheduler` | `/health`, `/metrics` | no | yes (one at a time) | never — replicas are for failover |

Anything but `all` **requires** `REDIS_URL` and `STORAGE_DRIVER=s3`; the process
refuses to start otherwise rather than starting wrong. `scheduler` replicas
elect one sweeper through a Redis lease, so running two is redundancy and not
duplicated work.

Point the load balancer at the `web` service only. `worker` and `scheduler`
listen so they can be health-checked, and serve nothing else.

### Storage for more than one instance

`STORAGE_DRIVER=s3` with `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
and — for anything that is not real AWS — `S3_ENDPOINT`.

**Migrate before switching.** Keys are identical across both drivers, but
documents already on the volume are not in the bucket. Copy `/data/storage` into
the bucket first, then change the variable; otherwise every existing document is
stranded and every review task pointing at one fails.

### Metrics

`GET /metrics`, Prometheus text format, on every role. Set `METRICS_API_KEY`
(16+ characters) — this bot is served at a public hostname, and unset means the
endpoint is open. It carries no candidate PII by construction.

Watch queue depth first. Flat is keeping up; monotonically rising is not,
whatever the latency averages say.

---

## 3. Domain

Attach a domain in Dokploy pointing at container port **3000**, with HTTPS
enabled. Meta requires a public HTTPS callback on port 443 with a valid
certificate — it will not accept an IP, a self-signed cert, or a custom port.

Confirm it from your laptop:

```bash
curl https://<your-domain>/health
# {"ok":true,"shadowMode":false}
```

If that does not return JSON, stop here. Nothing downstream can work yet.

---

## 4. Meta callback URL — the step that is probably missing

`npm run doctor` currently reports:

```
ok  webhook subscription    app subscribed — MLSG Web App Automation
```

Your WABA **is** subscribed, but to an app called *MLSG Web App Automation* —
and your `.env` notes the app secret is shared with `career-pathways-suite`.
So Meta already has a callback URL on file for that app, and it points at
whatever that other service is. Messages are being delivered there, not here.

In Meta → your app → **WhatsApp → Configuration**:

- Callback URL: `https://<your-domain>/webhook`
- Verify token: exactly your `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Subscribe to the **`messages`** field

Then send a test message and watch the app logs for `webhook verification
succeeded` followed by inbound traffic.

> ⚠️ **One callback URL per app.** Changing it moves *all* traffic for this
> number away from the existing receiver. If `career-pathways-suite` is live and
> serving real candidates, repointing the URL will break it. Decide first
> whether this bot replaces that receiver, or whether it needs its own Meta app
> and phone number. This is a product decision, not a config one.

---

## 5. Verify

Open a terminal in the app container and run:

```bash
npm run doctor:prod
```

Every line should read `ok`. It checks, in order: shadow mode, MongoDB
connectivity and writability, storage, the Anthropic key, the OCR service, the
WhatsApp token and number, and whether Meta has an app subscribed.

---

## Quick triage — "the bot isn't replying"

| Symptom | Cause |
|---|---|
| `doctor` says shadow mode is ON | `SHADOW_MODE=true`. Replies are generated and discarded. |
| `doctor` fails on mongodb | `MONGODB_URI` still says `localhost`, or the app is in a different Dokploy project from the database. |
| `/health` does not respond | Container is not running or the domain is not mapped to port 3000. Check the app logs. |
| `/health` fine, no logs on send | Meta's callback URL does not point here — see step 4. |
| Logs show `rejected webhook with an invalid signature` | `WHATSAPP_APP_SECRET` does not match the app sending the webhook. |
| Logs show inbound, no reply | `doctor` will show whether it is the Anthropic key. Otherwise check for `outside_24h_window`. |
| Replies stop after 24h of candidate silence | Expected. Meta's window closed; only the approved template can reopen it, and nothing schedules it yet. |
