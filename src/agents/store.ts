/**
 * What the bot remembers about its conversations with Sourcing Hub agents.
 *
 * * `agent_job_order_notices`: every job order sent to an agent, with the
 *   details as they were sent. It is the context for answering the agent's
 *   questions later (`agents/questions.ts`).
 * * `agent_questions`: each question an agent asked and what the bot replied,
 *   so a follow-up ("and the salary?") can be understood.
 * * `agent_handoffs`: one row per agent number that has been told to contact
 *   staff ("For any queries, please contact Zara - +91 ..."). The row is the
 *   lock that keeps that reply to once per agent: its `_id` is the agent's
 *   number, so only one message can ever claim it, however many arrive at
 *   once. It never expires.
 *
 * The first two expire after 90 days.
 */
import type { Collection } from 'mongodb';
import { getDb } from '../db/client.js';
import { logger } from '../logger.js';

/** A job order as an agent was told about it. Blank means the order did not say. */
export interface AgentJobOrderDetails {
  title: string;
  destination_country: string;
  industry: string;
  vacancies: string;
  gender: string;
  salary: string;
  experience: string;
  process_time: string;
  b2b_rate: string;
  remarks: string;
  staff_name: string;
  staff_phone: string;
}

export interface AgentJobOrderNotice {
  /** The agent's WhatsApp number, as Meta writes it (digits with country code). */
  waId: string;
  jobOrderId: string;
  /** The template message's id, so a reply that quotes it finds this order. */
  wamid?: string;
  lineId?: string;
  sentAt: Date;
  details: AgentJobOrderDetails;
}

export interface AgentQuestion {
  waId: string;
  wamid: string;
  question: string;
  /** Empty when the bot stayed silent: the agent already had the staff contact. */
  reply: string;
  /** False when the bot did not answer it: a hand-off, or silence after one. */
  answered: boolean;
  /**
   * Set on the one hand-off an agent gets: whom the reply pointed them to
   * (`handOffKey`). The once-only rule itself is `agent_handoffs`.
   */
  handoffTo?: string;
  jobOrderId?: string;
  at: Date;
}

/**
 * The one "contact staff" reply an agent has been sent. `_id` is the agent's
 * WhatsApp number, so a second claim for the same agent fails on the index
 * every collection has, with no race between checking and writing.
 */
export interface AgentHandoff {
  _id: string;
  /** Whom the reply named (`handOffKey`). */
  to: string;
  /** The agent's message that the hand-off answered. */
  wamid: string;
  at: Date;
}

const RETAIN_SECONDS = 60 * 60 * 24 * 90;

export const agentNotices = (): Collection<AgentJobOrderNotice> =>
  getDb().collection<AgentJobOrderNotice>('agent_job_order_notices');
export const agentQuestions = (): Collection<AgentQuestion> =>
  getDb().collection<AgentQuestion>('agent_questions');
export const agentHandoffs = (): Collection<AgentHandoff> =>
  getDb().collection<AgentHandoff>('agent_handoffs');

export async function ensureAgentIndexes(): Promise<void> {
  await agentNotices().createIndexes([
    { key: { waId: 1, jobOrderId: 1 }, unique: true, name: 'waId_jobOrder_unique' },
    { key: { waId: 1, sentAt: -1 }, name: 'waId_sentAt' },
    { key: { wamid: 1 }, name: 'wamid', sparse: true },
    { key: { sentAt: 1 }, expireAfterSeconds: RETAIN_SECONDS, name: 'sentAt_ttl' },
  ]);
  await agentQuestions().createIndexes([
    { key: { waId: 1, at: -1 }, name: 'waId_at' },
    { key: { at: 1 }, expireAfterSeconds: RETAIN_SECONDS, name: 'at_ttl' },
  ]);
}

/** Remember a job order sent to an agent. Never throws: the message already went out. */
export async function rememberAgentNotice(notice: AgentJobOrderNotice): Promise<void> {
  try {
    await agentNotices().updateOne(
      { waId: notice.waId, jobOrderId: notice.jobOrderId },
      { $set: notice },
      { upsert: true },
    );
  } catch (err) {
    logger.warn({ err, jobOrderId: notice.jobOrderId }, 'could not remember a job order sent to an agent');
  }
}

/** The job orders an agent was sent since `since`, newest first. */
export async function recentAgentNotices(
  waId: string,
  since: Date,
  limit = 5,
): Promise<AgentJobOrderNotice[]> {
  return agentNotices()
    .find({ waId, sentAt: { $gte: since } }, { projection: { _id: 0 } })
    .sort({ sentAt: -1 })
    .limit(limit)
    .toArray();
}

export async function recordAgentQuestion(question: AgentQuestion): Promise<void> {
  try {
    await agentQuestions().insertOne(question);
  } catch (err) {
    logger.warn({ err, wamid: question.wamid }, 'could not record an agent question');
  }
}

/**
 * A hand-off this agent was sent before `agent_handoffs` existed: an
 * unanswered question with a reply, which can only have been the staff
 * contact (or "our team will get back to you").
 */
async function handedOffBeforeLock(waId: string): Promise<boolean> {
  const earlier = await agentQuestions().countDocuments(
    {
      waId,
      $or: [{ handoffTo: { $exists: true } }, { answered: false, reply: { $exists: true, $ne: '' } }],
    },
    { limit: 1 },
  );
  return earlier > 0;
}

/**
 * Claims the one "contact staff" reply this agent will ever get. True means
 * this message won it and should send the hand-off; false means the agent was
 * already sent one (by an earlier message, or by one being processed right
 * now) and must get nothing.
 *
 * Throws only if the database cannot be written, before anything is sent, so
 * the queue can retry the job instead of risking a second hand-off.
 */
export async function claimAgentHandoff(waId: string, claim: { to: string; wamid: string }): Promise<boolean> {
  if (await handedOffBeforeLock(waId)) {
    // Carry the earlier hand-off over into the lock, so it is not looked up again.
    await agentHandoffs().updateOne(
      { _id: waId },
      { $setOnInsert: { to: claim.to, wamid: 'before-lock', at: new Date() } },
      { upsert: true },
    );
    return false;
  }
  try {
    await agentHandoffs().insertOne({ _id: waId, to: claim.to, wamid: claim.wamid, at: new Date() });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

/**
 * Gives the claim back after WhatsApp refused the hand-off, so it was never
 * delivered and a later question may still send it once. Only the message
 * that made the claim can release it.
 */
export async function releaseAgentHandoff(waId: string, wamid: string): Promise<void> {
  try {
    await agentHandoffs().deleteOne({ _id: waId, wamid });
  } catch (err) {
    // Kept: the agent goes without the contact rather than risk it twice.
    logger.warn({ err, wamid }, 'could not release an undelivered agent hand-off');
  }
}

/** The agent's last few questions and replies since `since`, oldest first. */
export async function recentAgentQuestions(
  waId: string,
  since: Date,
  limit = 6,
): Promise<AgentQuestion[]> {
  const rows = await agentQuestions()
    .find({ waId, at: { $gte: since } }, { projection: { _id: 0 } })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
  return rows.reverse();
}
