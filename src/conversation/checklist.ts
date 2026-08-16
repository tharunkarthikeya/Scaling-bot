import type { CandidateDoc, DocumentSlot, DocumentStatus } from '../db/models.js';
import { REQUIRED_DOCUMENTS, TUNABLES, type DocumentRequirement } from './rules.js';

/**
 * The checklist is deterministic and lives entirely in code. The model decides
 * how to phrase a request; it never decides whether a document has been
 * received. That split is what makes the bot auditable — every state change has
 * a cause you can point at.
 */

/** Statuses that mean "we are done chasing this slot", one way or another. */
const RESOLVED: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>([
  'received',
  'ocr_queued',
  'ocr_done',
  'ocr_failed',
  'needs_review',
  'unavailable',
]);

export function requirementFor(docType: string): DocumentRequirement | undefined {
  return REQUIRED_DOCUMENTS.find((d) => d.id === docType);
}

export function initialSlots(): Record<string, DocumentSlot> {
  const now = new Date();
  const slots: Record<string, DocumentSlot> = {};
  for (const req of REQUIRED_DOCUMENTS) {
    slots[req.id] = { status: 'pending', askedCount: 0, updatedAt: now };
  }
  return slots;
}

/** Backfills slots for requirements added after a candidate was created. */
export function withMissingSlots(slots: Record<string, DocumentSlot>): Record<string, DocumentSlot> {
  const now = new Date();
  const merged = { ...slots };
  for (const req of REQUIRED_DOCUMENTS) {
    merged[req.id] ??= { status: 'pending', askedCount: 0, updatedAt: now };
  }
  return merged;
}

export function isResolved(slot: DocumentSlot | undefined): boolean {
  return !!slot && RESOLVED.has(slot.status);
}

/**
 * The next document to ask for, in checklist order. A slot the candidate has
 * been asked about `maxAsksPerDocument` times is skipped — chasing it further
 * annoys candidates and stalls the flow.
 */
export function nextDocumentToAsk(candidate: CandidateDoc): DocumentRequirement | undefined {
  const slots = withMissingSlots(candidate.documents);

  const askable = (req: DocumentRequirement) => {
    const slot = slots[req.id]!;
    if (isResolved(slot)) return false;
    if (slot.status === 'promised' && slot.askedCount >= TUNABLES.maxAsksPerDocument) return false;
    return slot.askedCount < TUNABLES.maxAsksPerDocument;
  };

  // Required documents first, then optional ones.
  return (
    REQUIRED_DOCUMENTS.filter((d) => d.required).find(askable) ??
    REQUIRED_DOCUMENTS.filter((d) => !d.required).find(askable)
  );
}

/** True once every required slot is resolved. Optional slots never block completion. */
export function isChecklistComplete(candidate: CandidateDoc): boolean {
  const slots = withMissingSlots(candidate.documents);
  return REQUIRED_DOCUMENTS.filter((d) => d.required).every((d) => isResolved(slots[d.id]));
}

export function outstandingDocuments(candidate: CandidateDoc): DocumentRequirement[] {
  const slots = withMissingSlots(candidate.documents);
  return REQUIRED_DOCUMENTS.filter((d) => !isResolved(slots[d.id]));
}

/**
 * Works out which checklist slot an inbound file belongs to.
 *
 * The caption or filename wins when it clearly names a document, because a
 * candidate who sends their passport while we're asking for a CV should not have
 * it filed as a CV. Otherwise it goes to whatever we last asked for.
 */
export function attributeInboundDocument(
  candidate: CandidateDoc,
  hints: { caption?: string; filename?: string },
): string {
  const haystack = `${hints.caption ?? ''} ${hints.filename ?? ''}`.toLowerCase();

  if (haystack.trim()) {
    for (const req of REQUIRED_DOCUMENTS) {
      if (req.keywords.some((kw) => haystack.includes(kw))) return req.id;
    }
  }

  if (candidate.awaitingDocument && requirementFor(candidate.awaitingDocument)) {
    return candidate.awaitingDocument;
  }

  return nextDocumentToAsk(candidate)?.id ?? REQUIRED_DOCUMENTS[0]!.id;
}

/**
 * The per-candidate state block prepended to the latest user turn.
 *
 * It goes in the message, not the system prompt, so the cached system prefix
 * stays byte-identical across every candidate and every turn.
 */
export function renderState(candidate: CandidateDoc): string {
  const slots = withMissingSlots(candidate.documents);
  const next = nextDocumentToAsk(candidate);

  const lines: string[] = ['<state>'];

  const knownProfile = Object.entries(candidate.profile ?? {}).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  lines.push(
    knownProfile.length
      ? `known_about_candidate: ${knownProfile.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`
      : 'known_about_candidate: nothing yet',
  );

  lines.push('documents:');
  for (const req of REQUIRED_DOCUMENTS) {
    const slot = slots[req.id]!;
    const flags = [req.required ? 'required' : 'optional', `asked ${slot.askedCount}x`];
    lines.push(`  - ${req.id}: ${slot.status} (${flags.join(', ')})`);
  }

  lines.push(
    next
      ? `OUTSTANDING: ${next.id} — ask for the ${next.label} in this reply.`
      : isChecklistComplete(candidate)
        ? 'OUTSTANDING: none. Every required document is in. Thank the candidate and tell them a recruiter will review and follow up.'
        : 'OUTSTANDING: none askable. Do not chase further; acknowledge and let them know a recruiter will follow up.',
  );

  lines.push('</state>');
  return lines.join('\n');
}
