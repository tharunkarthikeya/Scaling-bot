# CRM public ID contract

The CRM must generate and persist human-readable IDs independently from its
database primary keys.

Recommended formats:

- Candidate: `CND-000001`, `CND-000002`, ...
- Staff: `STF-000001`, `STF-000002`, ...

Both fields must be immutable and uniquely indexed. Allocate the next sequence
atomically inside the same CRM transaction that creates the record. Never build
the public code by truncating, exposing, or encoding a MongoDB `_id`, UUID, or
other database key.

The CRM API keeps its internal IDs for routing and relationships, but returns
the public codes separately:

```json
{
  "candidate_id": "<internal CRM key>",
  "candidate_code": "CND-000101"
}
```

`GET /candidates/{internal-id}/assignment-summary` must include:

```json
{
  "candidate_id": "<internal CRM key>",
  "candidate_code": "CND-000101",
  "full_name": "Candidate name"
}
```

`GET /staff/{internal-id}/contact` and `/staff/admin-contacts` must include:

```json
{
  "id": "<internal CRM key>",
  "staff_code": "STF-000012",
  "name": "Staff name",
  "phone": "+919876543210"
}
```

The assignment callback continues to use internal IDs for lookup and may carry
the public codes as an immediate fallback:

```json
{
  "candidate_id": "<internal CRM key>",
  "staff_id": "<internal CRM key>",
  "candidate_code": "CND-000101",
  "staff_code": "STF-000012"
}
```

The SLA callback uses only public codes in user-visible fields:

```json
{
  "candidate_code": "CND-000101",
  "staff_code": "STF-000012"
}
```

The WhatsApp bot will never fall back to `candidate_id` or `staff_id` in a
staff/admin message. If a public code is missing, it displays a neutral fallback
instead of exposing the database key.
