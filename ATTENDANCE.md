# WhatsApp attendance

The bot accepts attendance only from the Meta Groups API group whose exact id
is configured as `WHATSAPP_ATTENDANCE_GROUP_ID`. Every other group message is
ignored and can never enter the candidate conversation.

Staff can write either form:

- `Asha - check in`
- `Asha - check out`
- `check in: Asha`
- `check out: Asha`

The sender's WhatsApp number must match the phone on an active CRM staff
account. The written full name, first name, or staff code must match that same
account. Rejected, malformed, and accepted attendance messages are all silent:
the bot sends no reply and no read receipt to the group.

## CRM policy

- Office timezone: `Asia/Kolkata`
- Shift: 10:00 to 19:00
- Sundays: weekly leave
- Rotational leave: assigned per staff member and restricted to Fridays
- Paid leave: at most one per staff member per calendar month
- Grace: first 60 total shortfall minutes in the month
- Deduction: late check-in minutes plus early checkout minutes, less the
  remaining monthly grace. Checkout after 19:00 is not penalised.
- Payroll base is exposed as 30 days; actual calendar days and Sundays are also
  returned so the CRM can display the real month correctly.

The CRM exposes `POST /attendance/events` to the bot, `GET /attendance?month=YYYY-MM`
to signed-in users, and `PUT /attendance/leaves` to administrators.

## Deployment

Set `WHATSAPP_ATTENDANCE_GROUP_ID` on the webhook bot. `CRM_API_URL` and
`CRM_API_KEY` must point to the CRM, and the CRM's `WHATSAPP_SERVICE_KEY` must
contain the same key.

This requires access to Meta's official Groups API and a group created through
that API. It is not the same as adding a Cloud API number to an arbitrary
existing consumer WhatsApp group.
