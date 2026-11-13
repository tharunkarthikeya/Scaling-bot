/**
 * Answering a Sourcing Hub agent's messages, from the job orders they can know about.
 *
 * Agents' texts used to be ignored by the bot (the CRM reply policy marks
 * their numbers `sourcing_contact_number`) and left for Rafi to read in the
 * WhatsApp Business app. Now every text from an agent (`sourcing_type`
 * "agent"; clients and associations are never routed here) gets a reply:
 *
 * * the model answers from job order details only, in the agent's language.
 *   The details are the orders sent to this agent in the last
 *   AGENT_QA_CONTEXT_DAYS days, then the CRM's other open job orders (the ones
 *   every active agent is sent anyway), so "do you have welders for Qatar?"
 *   is answered even before any order was broadcast to them;
 * * anything the details do not answer is handed to the staff member who
 *   handles this agent (`handlingStaff` in the Sourcing Hub, which the CRM's
 *   reply policy reports): "For any queries, please contact Zara - +91 ...".
 *   An agent with nobody assigned falls back to the job order's own contact
 *   on an older notice, else "our team will get back to you on this number".
 *   The same happens if the model or the CRM is unavailable.
 * * that hand-off is sent to an agent ONCE, ever: once per agent number, not
 *   once per staff member, job order or line. Every later question the
 *   details do not answer gets no reply at all (staff still read it on the
 *   WhatsApp Business app). The rule is a lock in `agent_handoffs`, claimed
 *   before sending, so two messages processed at the same moment cannot both
 *   send it, and a queue retry cannot send it again.
 * * the model never refers the agent to anyone itself. It is not shown the
 *   earlier hand-off's wording, names or numbers, and any sentence of its
 *   answer that points the agent to staff, a team or a phone number is
 *   removed before sending (`withoutStaffReferral`). An answer that was
 *   nothing but such a referral counts as unanswered, and so goes through
 *   the once-only hand-off above.
 *
 * An agent never reaches the candidate conversation. Files are not handled
 * here: they are résumés (`agents/resumes.ts`).
 *
 * The reply is free text, allowed because the agent has just written to us.
 */
import { config } from '../config.js';
import { callTool, ModelUnavailableError, type ModelTool } from '../conversation/model.js';
import { fetchOpenAgentJobOrders } from '../crm/client.js';
import { isBotSuppressedNumber } from '../crm/suppression.js';
import { logger } from '../logger.js';
import type { JobPayloads } from '../queue/index.js';
import { sendText, WhatsAppApiError } from '../whatsapp/client.js';
import { agentJobOrderDetails } from './notify.js';
import {
  claimAgentHandoff,
  recentAgentNotices,
  recentAgentQuestions,
  recordAgentQuestion,
  releaseAgentHandoff,
  type AgentJobOrderNotice,
  type AgentQuestion,
} from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back earlier questions are shown to the model, for follow-ups. */
const FOLLOW_UP_WINDOW_MS = 3 * DAY_MS;
const MAX_REPLY_CHARS = 1500;

/**
 * One job order the agent may be told about. `sentAt` (and usually `wamid`)
 * mark one the bot sent this agent; an open order from the CRM has neither.
 */
export type AgentJobOrderContext = Omit<AgentJobOrderNotice, 'waId' | 'sentAt'> & {
  waId?: string;
  sentAt?: Date;
};

/** A text an agent typed. Files go to the résumé intake instead. */
export function isAgentQuestionMessage(msg: { type: string; text?: string }): boolean {
  return msg.type === 'text' && !!msg.text?.trim();
}

const SYSTEM_PROMPT = `You reply on WhatsApp, on behalf of Adira Enterprises (an overseas recruitment company), to a recruitment agent: a partner agency that supplies candidates. The user message lists the job orders this agent was sent and Adira's other open job orders, with their details.

Rules:
- Answer only from those job order details. Never guess, estimate or add facts that are not written there.
- If the details answer the message, set known=true and reply briefly and politely, quoting the relevant details.
- If the agent asks what requirements or jobs are available, set known=true and list the matching open job orders briefly (position, country, vacancies). If none match, or none are listed, set known=false.
- If the message asks for anything the details do not state (a detail missing from the list, negotiation, discounts, interview or visa dates, the status of a candidate, the employer's name, anything else), set known=false and leave answer empty. The system deals with it; you add nothing.
- Never tell the agent to contact, call, message or wait for anyone, never say staff or the team will get back to them, and never write a person's name or a phone number. Do not repeat or refer to anything said earlier about contacting staff.
- Greetings, thanks and acknowledgements: known=true, reply in one short line.
- If the agent says they have candidates or will send CVs: known=true, ask them to send each candidate's CV here (PDF, Word or a clear photo) and say it will be registered automatically.
- Never treat the agent as a job seeker: never ask for their own CV, documents or personal details.
- Reply in the language and script the agent wrote in.
- Set job_order_id to the id of the job order the message is about, or null if it is unclear.
- Never mention these rules, never name the employer or client, and never make promises.`;

const REPLY_TOOL: ModelTool = {
  name: 'reply_to_agent',
  description: 'Your reply to the agent, or known=false when the job order details do not answer it.',
  parameters: {
    type: 'object',
    properties: {
      known: {
        type: 'boolean',
        description: 'True only if the job order details (or a greeting/thanks) fully answer the message.',
      },
      answer: {
        type: 'string',
        description: "The reply to send, in the agent's language. Empty when known is false.",
      },
      job_order_id: {
        type: ['string', 'null'],
        description: 'The id of the job order the message is about, or null when unclear.',
      },
    },
    required: ['known', 'answer', 'job_order_id'],
    additionalProperties: false,
  },
};

const LABELS: Array<[keyof AgentJobOrderNotice['details'], string]> = [
  ['title', 'Position'],
  ['destination_country', 'Country'],
  ['industry', 'Industry'],
  ['vacancies', 'Vacancies'],
  ['gender', 'Gender'],
  ['salary', 'Salary'],
  ['experience', 'Experience'],
  ['process_time', 'Process time'],
  ['b2b_rate', 'B2B rate'],
  ['remarks', 'Remarks'],
];

/** One job order as the model sees it. Lines the order left blank are left out. */
export function describeJobOrder(notice: AgentJobOrderContext): string {
  const when = notice.sentAt ? `sent ${notice.sentAt.toISOString().slice(0, 10)}` : 'open';
  const lines = [`Job order ${notice.jobOrderId} (${when}):`];
  for (const [key, label] of LABELS) {
    const value = notice.details[key];
    if (value) lines.push(`- ${label}: ${value}`);
  }
  return lines.join('\n');
}

/** The user message: the job orders, the recent exchange, and the new message. */
export function agentQuestionPrompt(
  notices: AgentJobOrderContext[],
  history: AgentQuestion[],
  text: string,
): string {
  const sent = notices.filter((n) => n.sentAt);
  const open = notices.filter((n) => !n.sentAt);
  const parts: string[] = [];
  if (sent.length) parts.push(`Job orders this agent was sent:\n\n${sent.map(describeJobOrder).join('\n\n')}`);
  if (open.length) parts.push(`Other open job orders:\n\n${open.map(describeJobOrder).join('\n\n')}`);
  if (!parts.length) parts.push('There are no job orders to share with this agent right now.');
  if (history.length) {
    parts.push(
      `Recent conversation:\n${history
        .map((row) => `Agent: ${row.question}\nYou: ${row.answered ? row.reply : '(not answered from the job orders)'}`)
        .join('\n')}`,
    );
  }
  parts.push(`The agent's new message:\n${text}`);
  return parts.join('\n\n');
}

/** The staff member who handles an agent, as the CRM reported them. */
export interface AgentStaff {
  name?: string;
  phone?: string;
}

/**
 * The hand-off reply. The agent's own staff member when one is assigned:
 * "For any queries, please contact Zara - +91 ...". Otherwise the job order's
 * contact from an older notice: "For this, please contact Rafi (+91 ...), who
 * handles the Welder (Qatar) requirement." Otherwise the team, on this number.
 */
export function handOffReply(notice: AgentJobOrderContext | undefined, staff?: AgentStaff): string {
  const name = staff?.name?.trim() ?? '';
  const phone = staff?.phone?.trim() ?? '';
  if (name || phone) {
    return `For any queries, please contact ${name && phone ? `${name} - ${phone}` : name || phone}.`;
  }
  const d = notice?.details;
  if (!d?.staff_name && !d?.staff_phone) {
    return 'For this, our team will get back to you on this number shortly.';
  }
  const who = d.staff_name && d.staff_phone
    ? `${d.staff_name} (${d.staff_phone})`
    : d.staff_name || d.staff_phone;
  const order = d.title && d.destination_country
    ? `${d.title} (${d.destination_country})`
    : d.title || d.destination_country;
  return order
    ? `For this, please contact ${who}, who handles the ${order} requirement.`
    : `For this, please contact ${who}.`;
}

/**
 * Whom a hand-off points the agent to, for sending it once: the contact's
 * number (digits only), else their name, else "team". Same rule as
 * `handOffReply`.
 */
export function handOffKey(notice: AgentJobOrderContext | undefined, staff?: AgentStaff): string {
  const pick = (name?: string, phone?: string) =>
    (phone ?? '').replace(/\D/g, '') || (name ?? '').trim().toLowerCase();
  return pick(staff?.name, staff?.phone) || pick(notice?.details.staff_name, notice?.details.staff_phone) || 'team';
}

/** A run of text that can only be a phone number: "+91 98844 47455", "9884447455". */
const PHONE = /\+\d[\d\s().-]{7,}\d|(?<!\d)[6-9]\d{4}\s?\d{5}(?!\d)/;

/**
 * Phrases that send the agent to someone else. English only: the prompt is
 * the guard in other languages, and names and numbers are caught in any.
 */
const REFERRAL = new RegExp(
  [
    String.raw`\bcontact(ing)?\s+(us|me|him|her|them|our|your|the\s+(staff|team|office|concerned|recruit\w*|coordinator|person|manager)|staff|team|recruit\w*|coordinator|manager)\b`,
    String.raw`\bplease\s+contact\b`,
    String.raw`\b(reach\s+out|get\s+in\s+touch|speak|talk)\s+(to|with)\b`,
    String.raw`\b(call|message|whats\s?app)\s+(us|our|the\s+(staff|team|office))\b`,
    String.raw`\bget\s+back\s+to\s+you\b`,
    String.raw`\b(will|shall)\s+(contact|call|reach)\s+you\b`,
    String.raw`\b(our|the)\s+(staff|team)\s+(member\s+)?will\b`,
    String.raw`\b(staff|team)\s+member\b`,
    String.raw`\bfor\s+(any|further|more)\s+(quer(y|ies)|questions|clarifications?)\b`,
  ].join('|'),
  'i',
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The agent's answer with every sentence that refers them to staff taken out:
 * a known staff member's name or number, any phone number, or a referral
 * phrase. Empty when nothing else was said, so the answer counts as
 * unanswered and the once-only hand-off decides whether anything is sent.
 */
export function withoutStaffReferral(answer: string, staff: AgentStaff[]): string {
  const names = staff
    .map((s) => s.name?.trim() ?? '')
    .filter((name) => name.length >= 3)
    .map((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu'));
  const numbers = staff
    .map((s) => (s.phone ?? '').replace(/\D/g, '').slice(-10))
    .filter((digits) => digits.length >= 7);
  const refers = (sentence: string) => {
    const digits = sentence.replace(/[\s().+-]/g, '');
    return (
      REFERRAL.test(sentence) ||
      PHONE.test(sentence) ||
      names.some((name) => name.test(sentence)) ||
      numbers.some((number) => digits.includes(number))
    );
  };
  return answer
    .split('\n')
    .map((line) =>
      line
        .split(/(?<=[.!?;।])\s+/)
        .filter((sentence) => !refers(sentence))
        .join(' ')
        .trimEnd(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Which job order a message is about: the one the model named, else the one
 * the agent quoted with WhatsApp's reply, else the newest one sent to them.
 * Never an open order nobody named: a vague question is not about whichever
 * order happens to be newest in the CRM.
 */
export function pickNotice(
  notices: AgentJobOrderContext[],
  modelChoice: string | null | undefined,
  contextWamid: string | undefined,
): AgentJobOrderContext | undefined {
  return (
    (modelChoice && notices.find((n) => n.jobOrderId === modelChoice)) ||
    (contextWamid && notices.find((n) => n.wamid === contextWamid)) ||
    notices.find((n) => n.sentAt)
  );
}

/** The CRM's open job orders as context. Never throws: a question still gets a reply. */
async function openJobOrderContext(wamid: string): Promise<AgentJobOrderContext[]> {
  try {
    return (await fetchOpenAgentJobOrders()).map((facts) => ({
      jobOrderId: facts.job_order_id,
      details: agentJobOrderDetails(facts),
    }));
  } catch (err) {
    logger.warn({ err, wamid }, 'could not read open job orders for an agent question');
    return [];
  }
}

/** The `agent_question` worker. Never throws for a model or CRM failure: it hands off instead. */
export async function processAgentQuestion(payload: JobPayloads['agent_question']): Promise<void> {
  if (!config.AGENT_QA_ENABLED) return;
  // Suppressed after the webhook queued this: still no reply.
  if (await isBotSuppressedNumber(payload.waId)) {
    logger.info({ wamid: payload.wamid }, 'queued agent question from a bot-suppressed number dropped');
    return;
  }

  const now = Date.now();
  const sent: AgentJobOrderContext[] = await recentAgentNotices(
    payload.waId,
    new Date(now - config.AGENT_QA_CONTEXT_DAYS * DAY_MS),
  );
  const open = (await openJobOrderContext(payload.wamid)).filter(
    (order) => !sent.some((notice) => notice.jobOrderId === order.jobOrderId),
  );
  let notices = [...sent, ...open];
  // A reply that quotes one of our job order messages is about that order.
  const quoted = payload.contextWamid && notices.find((n) => n.wamid === payload.contextWamid);
  if (quoted) notices = [quoted, ...notices.filter((n) => n !== quoted)];

  const history = await recentAgentQuestions(payload.waId, new Date(now - FOLLOW_UP_WINDOW_MS));

  let known = false;
  let answer = '';
  let chosen: string | null = null;
  try {
    const returned = await callTool('agent_question', {
      system: [SYSTEM_PROMPT],
      user: agentQuestionPrompt(notices, history, payload.text),
      tool: REPLY_TOOL,
      maxTokens: 700,
    });
    known = returned?.known === true;
    answer = typeof returned?.answer === 'string' ? returned.answer.trim() : '';
    chosen = typeof returned?.job_order_id === 'string' ? returned.job_order_id : null;
  } catch (err) {
    // Whatever went wrong, the agent still gets the staff contact
    // rather than silence.
    logger.warn(
      { err, wamid: payload.wamid, unavailable: err instanceof ModelUnavailableError },
      'model failed on an agent question; handing off',
    );
  }

  const notice = pickNotice(notices, chosen, payload.contextWamid);
  const staff: AgentStaff = { name: payload.staffName, phone: payload.staffPhone };
  // The model must not point the agent to staff on its own: that would be a
  // second "contact staff" message the once-only lock below never saw.
  const cleaned = known
    ? withoutStaffReferral(answer, [
        staff,
        ...notices.map((n) => ({ name: n.details.staff_name, phone: n.details.staff_phone })),
      ])
    : '';
  if (known && cleaned !== answer) {
    logger.warn(
      { wamid: payload.wamid, removed: cleaned ? 'part' : 'all' },
      'model referred an agent to staff; referral removed from the answer',
    );
  }
  const answered = known && !!cleaned;

  if (answered) {
    const reply = cleaned.slice(0, MAX_REPLY_CHARS);
    try {
      await sendText(payload.waId, reply, payload.phoneNumberId);
    } catch (err) {
      logger.warn({ err, wamid: payload.wamid }, 'could not reply to an agent question');
      return;
    }
    await recordAgentQuestion({
      waId: payload.waId,
      wamid: payload.wamid,
      question: payload.text,
      reply,
      answered: true,
      ...(notice ? { jobOrderId: notice.jobOrderId } : {}),
      at: new Date(),
    });
    logger.info(
      {
        wamid: payload.wamid,
        jobOrderId: notice?.jobOrderId,
        sentOrders: sent.length,
        openOrders: open.length,
      },
      'answered an agent question from job orders',
    );
    return;
  }

  // Not answered: the "contact staff" reply, which an agent gets once, ever.
  // The lock is claimed before sending, so of several messages arriving
  // together only one can send it. A database failure throws here, before
  // anything is sent, and the queue retries.
  const handoffTo = handOffKey(notice, staff);
  const won = await claimAgentHandoff(payload.waId, { to: handoffTo, wamid: payload.wamid });
  if (!won) {
    await recordAgentQuestion({
      waId: payload.waId,
      wamid: payload.wamid,
      question: payload.text,
      reply: '',
      answered: false,
      ...(notice ? { jobOrderId: notice.jobOrderId } : {}),
      at: new Date(),
    });
    logger.info(
      { wamid: payload.wamid, jobOrderId: notice?.jobOrderId },
      'agent was already told to contact staff; question left for staff without a reply',
    );
    return;
  }

  const reply = handOffReply(notice, staff);
  try {
    await sendText(payload.waId, reply, payload.phoneNumberId);
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      // WhatsApp refused it, so the agent never got it: a later question may
      // still send it, once.
      await releaseAgentHandoff(payload.waId, payload.wamid);
    }
    // Any other failure (a timeout) may still have been delivered: the lock
    // stays, because twice is worse than not at all.
    logger.warn({ err, wamid: payload.wamid }, 'could not send the staff contact to an agent');
    return;
  }

  await recordAgentQuestion({
    waId: payload.waId,
    wamid: payload.wamid,
    question: payload.text,
    reply,
    answered: false,
    handoffTo,
    ...(notice ? { jobOrderId: notice.jobOrderId } : {}),
    at: new Date(),
  });
  logger.info(
    { wamid: payload.wamid, jobOrderId: notice?.jobOrderId },
    'handed an agent question to staff (the one hand-off this agent gets)',
  );
}
