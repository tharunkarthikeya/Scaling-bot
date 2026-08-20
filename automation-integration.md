# Email and WhatsApp OCR automation

The automation service owns provider webhooks, durable source attachments, and
message-level reconciliation. The OCR service owns bounded extraction workers,
retries, and structured results. Do not put Gmail/IMAP or WhatsApp-provider
credentials inside the OCR service.

## Required ingestion state machine

Persist one row per provider attachment with at least:

- provider (`email` or `whatsapp`)
- mailbox/account identifier
- provider message ID and attachment/media ID
- source object-storage key and SHA-256
- OCR mode (`resume` or `aadhaar`)
- OCR job ID, status, attempts, and last error
- received, submitted, and completed timestamps

Use a unique database constraint on provider, account, message ID, and
attachment ID. This is the permanent deduplication boundary; OCR idempotency is
an additional concurrency guard, not a replacement for the ingestion ledger.

Process each attachment as follows:

1. Validate the provider signature or authenticated mailbox session.
2. Download the attachment immediately; WhatsApp media URLs may expire.
3. Store the original bytes in S3, MinIO, or equivalent durable object storage.
4. Insert or update the ingestion row before acknowledging the webhook or
   marking an email processed.
5. Submit `POST /v1/jobs` with one attachment and a stable `Idempotency-Key`.
6. Persist the returned job ID, then acknowledge the provider event.
7. Poll the returned status URL using `Retry-After` until terminal.
8. On `succeeded`, persist the structured result and mark the attachment done.
9. On `failed`, inspect the error, call `POST /v1/jobs/{job_id}/retry` while the
   failed upload is retained, or re-submit the durable source object later.

Recommended idempotency keys:

```text
email/{account_id}/{message_id}/{attachment_id}
whatsapp/{phone_number_id}/{message_id}/{media_id}
```

## Backpressure and reconciliation

- Treat `429`, `502`, and `503` as retryable. Honor `Retry-After` and apply
  exponential backoff with jitter.
- Never discard the ingestion row or source object when queue admission fails.
- Submit attachments independently; one bad document must not block siblings.
- Run a periodic reconciler for rows that remain received, submitting, or
  running for too long. Reuse the same idempotency key on every submit retry.
- Move exhausted failures to an operator-visible review queue and alert on
  queue age, not only queue count.
- Keep API keys separate: Email normally needs `resume`; WhatsApp needs
  `resume` and `aadhaar`.

## Capacity gates

Before increasing traffic, run load tests against representative Aadhaar
images and resumes with the real LLM provider. Test at least twice the expected
burst and require zero untracked, unfinished, or failed attachments. Scale CPU
and resume worker containers independently; add CPU replicas before increasing
`PADDLE_MAX_CONCURRENCY`, because every predictor consumes substantial RAM.

The OCR queue deliberately rejects new work with `503 job_queue_full` at
`OCR_JOB_QUEUE_MAX_DEPTH`. This is backpressure, not document loss: the
automation retains the original object and retries admission later.
