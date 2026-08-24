import type { CandidateDoc, DocumentSlot, DocumentStatus } from '../db/models.js';
import { DOCUMENTS, TUNABLES, requirementFor, type DocumentRequirement } from './rules.js';

/**
 * Document slots.
 *
 * Whether a document has arrived is a fact about the filesystem, so the engine
 * decides it and the model is never asked. The model's only involvement with
 * documents is reading a sentence like "I'll send it tomorrow" and reporting
 * that it means "promised".
 */

/** Statuses that mean we are done asking for this slot, one way or another. */
const RESOLVED: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>([
  'received',
  'ocr_queued',
  'ocr_done',
  'ocr_failed',
  'needs_review',
  'unavailable',
]);

export { requirementFor };

export function initialSlots(): Record<string, DocumentSlot> {
  const now = new Date();
  const slots: Record<string, DocumentSlot> = {};
  for (const req of DOCUMENTS) {
    slots[req.id] = { status: 'pending', askedCount: 0, updatedAt: now };
  }
  return slots;
}

/** Backfills slots for documents added after a candidate was created. */
export function withMissingSlots(
  slots: Record<string, DocumentSlot> | undefined,
): Record<string, DocumentSlot> {
  const now = new Date();
  const merged = { ...(slots ?? {}) };
  for (const req of DOCUMENTS) {
    merged[req.id] ??= { status: 'pending', askedCount: 0, updatedAt: now };
  }
  return merged;
}

export function isResolved(slot: DocumentSlot | undefined): boolean {
  return !!slot && RESOLVED.has(slot.status);
}

/**
 * A slot that arrived but could not be read (§14). Distinct from resolved: the
 * file is on disk, but we still need a usable copy, so the flow asks again.
 */
export function isIncomplete(slot: DocumentSlot | undefined): boolean {
  return slot?.status === 'incomplete';
}

/**
 * Whether the Aadhaar has given up everything anybody needs off it (§15).
 *
 * Name, date of birth, address and number — three on the front and one on the
 * back, so having all four is also the proof that both sides have been read,
 * however many files that took. `recordAadhaarCoverage` in the engine keeps the
 * set; this is the question two flow steps and the engine all ask of it, and a
 * rule written three times is a rule that drifts twice.
 *
 * Here rather than in `flow.ts` because the engine needs it too, and flow
 * importing the engine would be a cycle.
 */
export function aadhaarFullyRead(candidate: CandidateDoc): boolean {
  const read = candidate.profile?.aadhaarFieldsRead ?? [];
  return TUNABLES.aadhaarRequiredFields.every((key) => read.includes(key));
}

export function exhausted(slot: DocumentSlot | undefined): boolean {
  return (slot?.askedCount ?? 0) >= TUNABLES.maxAsksPerDocument;
}

/**
 * Works out which slot an inbound file belongs to.
 *
 * A caption or filename that names a document wins, because a candidate who
 * sends their passport while we are asking for a CV should not have it filed as
 * a CV. Otherwise it goes to whatever we last asked for.
 */
export function attributeInboundDocument(
  candidate: CandidateDoc,
  hints: { caption?: string; filename?: string; expecting?: string },
): string {
  const haystack = `${hints.caption ?? ''} ${hints.filename ?? ''}`.toLowerCase();
  const reachable = documentsInBranch(candidate);

  if (haystack.trim()) {
    for (const req of reachable) {
      if (req.keywords.some((kw) => haystack.includes(kw.toLowerCase()))) return req.id;
    }
  }

  if (hints.expecting && requirementFor(hints.expecting)) return hints.expecting;
  if (candidate.currentStep) {
    const expected = documentForStep(candidate.currentStep);
    if (expected) return expected;
  }

  // Nothing named it and the open question is not a document step. The first
  // slot still WAITING is the honest guess, and it is a very different guess
  // from the first slot in the list.
  //
  // This is the bug that had a passport acknowledged as a CV. "Do you have a
  // valid passport?" is a choice step, not a document step, and a candidate who
  // answers it by sending the passport rather than tapping Yes used to have the
  // file attributed to `reachable[0]` — which is the CV, whatever the
  // conversation was actually about. It was then sent to the resume extractor,
  // which is the wrong endpoint for a passport, and the candidate was told
  // "CV received".
  const outstanding = reachable.find((req) => !isResolved(withMissingSlots(candidate.documents)[req.id]));
  return (outstanding ?? reachable[0]!).id;
}

/**
 * The slots this conversation can actually put a file in.
 *
 * A business contact never reaches the candidate checklist and a candidate never
 * reaches the B2B one, so neither should have a caption re-file their upload
 * into the other's slots — where nothing would ever ask for it again.
 */
function documentsInBranch(candidate: CandidateDoc): DocumentRequirement[] {
  const branch = candidate.enquiry === 'b2b' ? 'b2b' : 'candidate';
  return DOCUMENTS.filter((d) => (d.branch ?? 'candidate') === branch);
}

/**
 * The slot a step is asking about, derived from its id.
 *
 * Two shapes: the document step itself (`passport_upload`, or `cv`, which is
 * named for its slot), and the question that precedes it. "Do you have a valid
 * passport?" is `passport_status`, and a file arriving there is a passport —
 * the candidate answered with the document instead of the button, which is a
 * perfectly reasonable thing to do and used to file their passport as a CV.
 */
function documentForStep(stepId: string): string | undefined {
  const direct = DOCUMENTS.find(
    (d) => stepId === d.id || stepId === `${d.id}_upload` || stepId === `${d.id}_status`,
  );
  return direct?.id;
}

export function documentsOutstanding(candidate: CandidateDoc): DocumentRequirement[] {
  const slots = withMissingSlots(candidate.documents);
  return documentsInBranch(candidate).filter((d) => !isResolved(slots[d.id]));
}

/** A one-line summary of document state for the confirmation message (§18). */
export function documentSummary(
  candidate: CandidateDoc,
): { received: string[]; pending: string[] } {
  const slots = withMissingSlots(candidate.documents);
  const received: string[] = [];
  const pending: string[] = [];

  for (const req of DOCUMENTS) {
    const slot = slots[req.id]!;
    if (slot.status === 'pending') continue;
    if (isResolved(slot) && slot.status !== 'unavailable') received.push(req.id);
    else pending.push(req.id);
  }

  return { received, pending };
}
