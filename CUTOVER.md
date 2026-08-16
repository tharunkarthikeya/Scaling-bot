# Cutover: replacing career-pathways-suite

Both systems share one Meta app and one phone number (+91 63817 27653), and a
Meta app has **exactly one callback URL**. So this is a switch, not a migration:
the moment you save the new URL, career-pathways-suite stops receiving webhooks
and this bot starts. There is no overlap period and no gradual rollout.

That makes the order below matter. Do not repoint until step 3 passes.

---

## 1. Deploy, and confirm the container is healthy

Follow `DEPLOY.md`. Then, from a terminal inside the app container:

```bash
npm run doctor:prod
```

Every line must read `ok`. In particular `shadow mode` must be **off** — with it
on, the bot receives messages, thinks, and silently discards every reply.

## 2. Confirm the domain is publicly reachable

From your own machine, not the server:

```bash
curl https://<your-domain>/health
# {"ok":true,"shadowMode":false}
```

Meta requires public HTTPS on port 443 with a valid certificate. It will not
accept an IP address, a self-signed certificate, or a non-standard port.

## 3. Prove the endpoint will satisfy Meta — before touching Meta

```bash
npm run verify:endpoint https://<your-domain>
```

This performs the exact exchanges Meta will: the subscription handshake, a
correctly signed delivery, and a forged one. It is non-destructive — the signed
payload carries a delivery status rather than a message, so it creates no
candidate and sends nothing.

```
  ok  health                         200 shadowMode=false
  ok  verification handshake         challenge echoed correctly
  ok  rejects a wrong token          403
  ok  accepts a signed delivery      200
  ok  rejects a forged delivery      401

Endpoint is ready. It is safe to repoint Meta's callback URL here.
```

**If any line fails, stop.** Repointing now would take career-pathways-suite
offline without this bot working, and the number would answer nobody.

## 4. Record the current callback URL

Before changing anything, open Meta → your app → **WhatsApp → Configuration**
and write down the existing callback URL verbatim. That value is your rollback,
and once overwritten Meta does not show you what it was.

```
Previous callback URL: ______________________________________
Changed on:            ______________________________________
```

## 5. Flip it

Same screen:

- Callback URL → `https://<your-domain>/webhook`
- Verify token → exactly your `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Confirm the **`messages`** field is subscribed

Meta performs the handshake on save. It succeeds immediately or it does not.

## 6. Validate with a real message

Message the number from a phone that has never contacted it, and watch the app
logs. Expect, in order:

```
webhook verification succeeded          (once, at save time)
document ingested / reply sent          (on your message)
```

Then confirm it landed in the database:

```bash
curl https://<your-domain>/api/candidates?limit=5
```

Send a document too, not just text — that exercises media download, storage,
and the OCR hand-off, which text alone does not.

---

## Rollback

If the bot misbehaves, put the old callback URL back in the same field. Traffic
returns to career-pathways-suite on the next message; nothing else needs
undoing. Messages that arrived while this bot was live stay in this database and
are not replayed to the old system.

Keep the rollback value from step 4 to hand until you have watched a full day of
real traffic.

---

## What changes for candidates already mid-conversation

This is the part worth deciding deliberately, because it affects real people.

Candidates who were partway through career-pathways-suite have **no record in
this database**. When they next message, this bot treats them as brand new: it
sends the greeting and asks for their CV from the top — including documents they
have already sent to the old system.

Three options, in increasing effort:

1. **Accept it, and say so.** Edit `GREETING` in `src/conversation/rules.ts` for
   the first week or two, e.g. *"We've upgraded our system, so I may ask for a
   document you've already sent — sorry about that."* Honest, costs one line,
   and candidates forgive a stated reason far more readily than a silent repeat.

2. **Cut over during a quiet window** — a weekend or overnight — so the number
   of candidates mid-flow is as small as possible.

3. **Import the old records.** If career-pathways-suite's database is reachable
   and its candidates can be mapped to `waId`, a one-off import into the
   `candidates` collection would preserve their progress. This is the only
   option that avoids re-asking, and the only one that needs real work. Ask if
   you want it — I would need the old schema.

Option 1 is the sensible default unless a lot of candidates are mid-flow right
now.

---

## Watch these for the first day

| Log line | Meaning |
|---|---|
| `rejected webhook with an invalid signature` | `WHATSAPP_APP_SECRET` does not match the app. Nothing will be processed. |
| `duplicate delivery ignored` | Normal and healthy — Meta retrying, dedupe working. |
| `reply dropped: outside the 24-hour window` | Candidate went quiet for over a day. Only the approved template can reopen it, and nothing schedules that yet. |
| `model produced no reply text; falling back` | The forced-reply path caught it; the candidate still got an answer. Fine occasionally, worth investigating if frequent. |
| `ocr failed` | The document is still stored and flagged for review. Not candidate-facing. |
| `conversation handed off to a human` | The bot stopped on purpose. **Someone must actually pick these up** — nothing notifies a recruiter yet. |

That last row is the one gap that bites soonest: handoffs are recorded in the
database but nobody is told. Until the CRM exists, check
`/api/candidates?stage=human_handoff` daily.
