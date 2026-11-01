/**
 * What the bot remembers about its conversations with Sourcing Hub agents.
 *
 * * `agent_job_order_notices`: every job order sent to an agent, with the
 *   details as they were sent. It is the context for answering the agent's
 *   questions later (`agents/questions.ts`).
 * * `agent_questions`: each question an agent asked and what the bot replied,
 *   so a follow-up ("and the salary?") can be understood.
 *
 * Both expire after 90 days.
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
  reply: string;
  /** False when the bot handed the question to the assigned staff member. */
  answered: boolean;
  jobOrderId?: string;
  at: Date;
}

const RETAIN_SECONDS = 60 * 60 * 24 * 90;

export const agentNotices = (): Collection<AgentJobOrderNotice> =>
  getDb().collection<AgentJobOrderNotice>('agent_job_order_notices');
export const agentQuestions = (): Collection<AgentQuestion> =>
  getDb().collection<AgentQuestion>('agent_questions');

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
