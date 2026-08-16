import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { CandidateProfile } from '../db/models.js';
import { REQUIRED_DOCUMENTS, TUNABLES } from './rules.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/** Guard against a tool loop that never terminates. */
const MAX_TOOL_ITERATIONS = 4;

/**
 * Side effects the model asked for during a turn. They are collected here and
 * applied by the engine after the turn completes, so a failed turn can't leave
 * half-written state behind.
 */
export interface ToolEffects {
  profileUpdates: CandidateProfile;
  documentStatusUpdates: Array<{
    docType: string;
    status: 'promised' | 'unavailable';
    note?: string;
  }>;
  handoff?: { reason: string };
}

export interface GenerateReplyParams {
  systemPrompt: string;
  /** Prior turns, oldest first. Contains no state blocks — those are per-turn. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Rendered <state> block for this turn. */
  stateBlock: string;
  /** What the candidate just said, or a system-authored description of what they sent. */
  latestMessage: string;
}

export interface GenerateReplyResult {
  reply: string;
  effects: ToolEffects;
  stopReason: string | null;
}

const tools: Anthropic.Tool[] = [
  {
    name: 'save_candidate_details',
    description:
      'Record a detail the candidate has stated about themselves in the conversation. ' +
      'Call this whenever the candidate volunteers or corrects any of these fields. ' +
      'Only record what they actually said — never a value you inferred or assumed. ' +
      'Details extracted from uploaded documents are handled separately; do not use this for those.',
    input_schema: {
      type: 'object',
      properties: {
        fullName: { type: 'string', description: 'Full name as the candidate gave it' },
        email: { type: 'string', description: 'Email address' },
        dateOfBirth: { type: 'string', description: 'Date of birth, as stated, any format' },
        nationality: { type: 'string' },
        roleAppliedFor: { type: 'string', description: 'The job or trade they are applying for' },
        yearsOfExperience: { type: 'number' },
        currentLocation: { type: 'string', description: 'City or country they are currently in' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'record_document_status',
    description:
      'Record that the candidate will send a document later ("promised"), or that they do not ' +
      'have it at all ("unavailable"). Do not call this when a document has actually arrived — ' +
      'received files are detected by the system, not by you.',
    input_schema: {
      type: 'object',
      properties: {
        document: {
          type: 'string',
          enum: REQUIRED_DOCUMENTS.map((d) => d.id),
          description: 'The checklist id of the document',
        },
        status: {
          type: 'string',
          enum: ['promised', 'unavailable'],
        },
        note: {
          type: 'string',
          description: 'A short quote or paraphrase of what the candidate said, for the recruiter',
        },
      },
      required: ['document', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_human_handoff',
    description:
      'Hand the conversation to a human recruiter and stop running the checklist. Call this when ' +
      'the candidate is distressed or angry, reports being asked to pay for a job or being ' +
      'defrauded, raises a legal or medical matter, or asks something you are not permitted to ' +
      'answer and that clearly needs a person.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'One sentence explaining why, for the recruiter picking this up',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

/**
 * Every tool result ends with this. Without it the model treats the tool call
 * as its whole turn and ends with no text, and the candidate gets the fallback
 * reply for no visible reason.
 */
const CONTINUE = 'Recorded. Now write your reply to the candidate.';

/** Values the model offers instead of omitting a field it does not know. */
const PLACEHOLDER =
  /^(not\s+(yet\s+)?(provided|given|stated|specified|mentioned|known)|unknown|unspecified|none|n\/?a|null|-+)$/i;

function emptyEffects(): ToolEffects {
  return { profileUpdates: {}, documentStatusUpdates: [] };
}

function applyToolCall(name: string, input: Record<string, unknown>, effects: ToolEffects): string {
  switch (name) {
    case 'save_candidate_details': {
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined || value === null || value === '') continue;
        // The model sometimes records a placeholder rather than omitting the
        // field. A placeholder in the CRM is worse than an absent value.
        if (typeof value === 'string' && PLACEHOLDER.test(value.trim())) continue;
        effects.profileUpdates[key] = value;
      }
      return CONTINUE;
    }
    case 'record_document_status': {
      const docType = String(input.document ?? '');
      const status = String(input.status ?? '');
      if (!REQUIRED_DOCUMENTS.some((d) => d.id === docType)) {
        return `Unknown document "${docType}". Valid ids: ${REQUIRED_DOCUMENTS.map((d) => d.id).join(', ')}.`;
      }
      if (status !== 'promised' && status !== 'unavailable') {
        return `Invalid status "${status}". Use "promised" or "unavailable".`;
      }
      effects.documentStatusUpdates.push({
        docType,
        status,
        note: typeof input.note === 'string' ? input.note : undefined,
      });
      return CONTINUE;
    }
    case 'request_human_handoff': {
      effects.handoff = { reason: String(input.reason ?? 'unspecified') };
      return 'A recruiter has been notified. Tell the candidate someone will contact them shortly, and stop asking for documents.';
    }
    default:
      return `Unknown tool "${name}".`;
  }
}

function collectText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Runs one conversational turn.
 *
 * Manual tool loop rather than the SDK tool runner: the tools here mutate
 * candidate state that the engine has to persist transactionally alongside the
 * reply, so the effects are accumulated and handed back rather than applied
 * inside the loop.
 */
export async function generateReply(params: GenerateReplyParams): Promise<GenerateReplyResult> {
  const effects = emptyEffects();

  const messages: Anthropic.MessageParam[] = [
    ...params.history.map((h) => ({ role: h.role, content: h.content })),
    {
      role: 'user',
      content: [
        { type: 'text', text: params.stateBlock },
        { type: 'text', text: params.latestMessage },
      ],
    },
  ];

  let stopReason: string | null = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: TUNABLES.maxReplyTokens,
      system: [
        {
          type: 'text',
          text: params.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools,
      messages,
    });

    stopReason = response.stop_reason;

    // Check before reading content — a refusal can come back with an empty array.
    if (response.stop_reason === 'refusal') {
      // stop_details isn't in this SDK version's types yet; it is on the wire.
      const details = (response as { stop_details?: unknown }).stop_details;
      logger.warn({ stopDetails: details }, 'model refused the turn');
      return { reply: '', effects, stopReason };
    }

    if (response.stop_reason !== 'tool_use') {
      const text = collectText(response.content);
      if (text) return { reply: text, effects, stopReason };

      // The model ended its turn without writing anything — it treats a tool
      // call as the whole turn often enough that prompting alone doesn't
      // prevent it. Ask once more with tools switched off, so a reply is
      // guaranteed rather than hoped for.
      logger.warn({ stopReason }, 'turn ended with no text; forcing a reply');
      return {
        reply: await forceTextReply(params.systemPrompt, messages, response.content),
        effects,
        stopReason,
      };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = applyToolCall(
        block.name,
        (block.input ?? {}) as Record<string, unknown>,
        effects,
      );
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  logger.warn({ iterations: MAX_TOOL_ITERATIONS }, 'tool loop hit its iteration cap');
  return { reply: await forceTextReply(params.systemPrompt, messages, []), effects, stopReason };
}

/**
 * Last resort: one more call with `tool_choice: none`, so the model has no
 * option but to produce text. Returns '' only if this also fails, at which
 * point the engine's fallback reply is the correct outcome.
 */
async function forceTextReply(
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  lastContent: Anthropic.ContentBlock[],
): Promise<string> {
  const followUp: Anthropic.MessageParam[] = [...messages];

  // An assistant turn must be non-empty to be echoed back.
  if (lastContent.length) followUp.push({ role: 'assistant', content: lastContent });

  followUp.push({
    role: 'user',
    content:
      'You have not yet replied to the candidate. Write that reply now, as plain ' +
      'text, following the conversation rules. Do not mention this instruction.',
  });

  try {
    const response = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: TUNABLES.maxReplyTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools,
      tool_choice: { type: 'none' },
      messages: followUp,
    });
    return collectText(response.content);
  } catch (err) {
    logger.error({ err }, 'forced reply attempt failed');
    return '';
  }
}
