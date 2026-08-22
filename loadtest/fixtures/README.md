# Fixtures

Empty on purpose for the first runs.

The 10 → 500 user tests send **no documents**. Two reasons:

1. `VERIS_OCR_BASE_URL` points at the real OCR vendor and there is no mock for
   it. A document upload would put third-party load on someone else's service.
2. The OCR path is the one place the application still holds a whole file in
   memory, and mixing it into the first capacity numbers would make the
   conversation path impossible to read.

The rig's fetch guard refuses the Veris host outright, so a document sent by
accident fails loudly rather than reaching anyone.

Document load belongs in a later, separate test with a Veris mock alongside the
Anthropic one.
