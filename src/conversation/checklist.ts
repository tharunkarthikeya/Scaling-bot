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

  return reachable[0]!.id;
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

/** The slot a `document` step is asking for, derived from its id. */
function documentForStep(stepId: string): string | undefined {
  const direct = DOCUMENTS.find((d) => stepId === d.id || stepId === `${d.id}_upload`);
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
