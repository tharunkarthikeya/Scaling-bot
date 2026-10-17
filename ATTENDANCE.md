# Private WhatsApp attendance

Attendance is accepted only in a private one-to-one chat, from a phone number
linked to an active CRM staff account, and only when the message arrives on
`WHATSAPP_ATTENDANCE_PHONE_NUMBER_ID`. If that setting is omitted, the primary
`WHATSAPP_PHONE_NUMBER_ID` is used. Group messages are ignored.

## The workflow

A punch takes two messages, because a punch only counts from the office.

1. **The command.** The employee sends `check in` or `check out`.
2. **The location.** The bot replies with WhatsApp's "Send location" button. The
   employee taps it and chooses *Send your current location*. The CRM measures
   that point against the office pins and records the punch, or refuses it.
3. **The confirmation.** `Attendance check in successful at 09:42 at Mount Road.`
   The time is office time as the CRM filed it, so the reply is evidence rather
   than an assurance.

**Live location cannot be used.** WhatsApp gives a bot no coordinates for one.
It arrives in either of two shapes, and the bot answers them differently,
because they are not the same fact:

| Delivery | What is known | What the employee is told |
| --- | --- | --- |
| `location` with valid coordinates | a usable pin, whatever its `rawType` | nothing — it is processed |
| `location`, coordinates unusable | the location could not be read | `Your location could not be read.` |
| `unsupported` | the type cannot be represented at all | `That message type cannot be used for attendance.` |
| anything else, mid-command | not a location message | `Location not received.` |

A live location is the usual cause of the middle two, so every one of those
replies names it — as guidance on what to tap, never as a diagnosis. The
distinction matters: `location` with unusable coordinates proves only that no
coordinates came out of the message. It can equally be a truncated payload, a
field Meta renamed, or a bug in the bot's own parser, and "you shared your live
location" would send the employee to fix something that was never wrong — or
blame them for a fault that is ours.

If any of these arrives with no command waiting, the reply asks for the command
too, so they do not fix one half and fall at the other.

A command waits ten minutes for its location (`PENDING_ATTENDANCE_TTL_MS`). It
is held in Redis when there is one, so the location may land on a different
instance than the text did.

## Accepted forms

The sender's WhatsApp number must match the phone on an active CRM staff
account. That number **is** the identity: it resolves to exactly one active
employee before any name is looked at, so a name is optional.

- `check in` / `check out` — the plain form, and the one to tell staff
- `clock in`, `checked out`, `check-in` — the same words, loosely spelled
- `check in 10.15` — a reported time is ignored; the webhook timestamp is
  authoritative, and the digits are never mistaken for a name
- `Asha - check in`, `check out: Asha`, `Asha check out 19:10` — a name may be
  written, and when one is it must match that same account: the full name, the
  first name, or the staff code

Nothing fuzzy is inferred. A message with two actions in it
(`check in or check out`), with none (`check the roster`), or with a word that
merely contains one (`check inside`) is not a command.

## Nobody is left in silence

Every outcome has a reply. A recognised employee always hears one of:

| Outcome | What they are told |
| --- | --- |
| Recorded | `Attendance check in successful at 09:42 at Mount Road.` |
| Location needed | the "Send location" prompt |
| Away from every office | `Attendance not recorded. You are at the wrong location.` |
| Conflicts with the day | `Attendance not recorded. Check-in already recorded for this attendance date.` |
| Name is not theirs | that the name does not match, and to send the command on its own |
| A pin with nothing waiting | to send the command again, then share the pin |
| A location that could not be read | what was observed, and how to send one that counts |
| Anything unrecognised | the two commands and what happens next |

Each reply is sent once per delivery: Meta repeats deliveries, and a redelivered
command must not look like a second punch.

A sender the CRM does not recognise as staff gets **no attendance reply** — the
line cannot be used to find out who works here — but their message is not
swallowed either. It continues into the ordinary candidate workflow, because
candidates do write to this number: until the phone id was corrected the
attendance branch never matched anything, so every message on that line fell
through to onboarding. Making the line staff-only would have started silently
dropping those people, which is a worse fault than the one being fixed.

The same holds, more simply, when `WHATSAPP_ATTENDANCE_PHONE_NUMBER_ID` is unset
and the candidate line doubles as the attendance line: a candidate who happened
to type "check in" is not lost.

## CRM policy

The CRM owns every rule below. The bot decides nothing about attendance.

- Office timezone: `Asia/Kolkata`
- Default shift: 10:00 to 19:00 with a 60-minute break; individual shifts may be
  assigned per employee
- Flexible hours: presence counts from 60 minutes before shift start to 60
  minutes after shift end — 09:00 to 20:00 on the default shift. A punch is
  **never** refused for its time of day; the day calculation decides what the
  time is worth
- Offices: Mount Road (300 m) and Royapettah (350 m). Any office counts, not
  only the employee's own, so somebody sitting at the other branch's desk is not
  locked out. An office with no pin enforces nothing
- One check-in and one check-out per attendance date; a check-out needs a
  check-in first
- Sundays are the weekly leave, unless a rotational weekly off was approved for
  that week instead
- Grace: 60 paid minutes and 2 paid occasions per month, shared across late
  arrivals and early departures
- A day with only half its punches is provisional for 2 days, then unpaid

Endpoints: `POST /attendance/events` for the bot, `GET /attendance/month/{year}/{month}`
for signed-in users, and the permission, duty-plan and extra-OT routes for
managers and administrators.

Every refusal from `POST /attendance/events` carries a machine-readable `code` —
`location_required`, `off_site`, `conflict`, `name_mismatch`, `unknown_sender` —
which is what the bot branches on. Matching on the wording would break the
moment the wording changed, and the bot and the CRM ship separately.

## Deployment

Set `WHATSAPP_ATTENDANCE_PHONE_NUMBER_ID=1344483985421841` on the bot
deployment — **+91 63817 27653**, "Adira Enterprises Private Limited".
`CRM_API_URL` and `CRM_API_KEY` must point to the CRM, and the CRM's
`WHATSAPP_SERVICE_KEY` must contain the same key.

Set `WHATSAPP_ATTENDANCE_WABA_ID` to the WhatsApp Business Account that number
belongs to. Nothing at runtime reads it; `doctor` does, and it is the only way
the webhook subscription on this line can be checked.

Two things have to be true in Meta, and neither is visible from the inside once
it is wrong:

1. The bot's access token can see the number. Check with
   `GET /{WHATSAPP_ATTENDANCE_PHONE_NUMBER_ID}` — a `code 100` / `subcode 33`
   means the number's WABA is not assigned to the bot's System User.
2. The bot's app is subscribed to that WABA's `messages` field, under Meta →
   WhatsApp → Configuration. A subscription is per-WABA, not per-number.

Run `npm run doctor` after any change here. The attendance line is checked by
name — `whatsapp number (attendance line)` and
`webhook subscription (attendance line)` — so a wrong id, an expired token or an
unsubscribed WABA is reported instead of being invisible.

> This is how the line was dead for months. `WHATSAPP_ATTENDANCE_PHONE_NUMBER_ID`
> held `1248836374980442`, an id the bot's token cannot see at all, so the
> attendance branch never matched an inbound message and every reply would have
> been sent from a number the token has no access to. Nothing reported a fault,
> because at the time nothing checked this line.
