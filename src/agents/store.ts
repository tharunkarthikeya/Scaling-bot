/**
 * What the bot remembers about Sourcing Hub agents.
 *
 * * `agent_job_order_notices`: every job order sent to an agent, with the
 *   details as they were sent. A record of the broadcast; it expires after
 *   90 days.
 * * `agent_handoffs`: one row per agent number that has been sent the
 *   "contact staff" message (`agents/handoff.ts`). The row is the lock that
 *   keeps that message to ONCE per agent number, ever: its `_id` is the
 *   number, so only one message can claim it however many arrive at once,
 *   and it never expires and is never given back.
 *
 * `agent_questions` is left over from the earlier question answering, which
 * was removed on 2026-11-14. It is read once at startup, only to carry the
 * hand-offs it recorded into `agent_handoffs`, so no agent who already got
 * one gets it again.
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
  /** The template message's id. */
  wamid?: string;
  lineId?: string;
  sentAt: Date;
  details: AgentJobOrderDetails;
}

/**
 * The one "contact staff" message an agent number has been sent. `_id` is the
 * agent's WhatsApp number, so a second claim for the same number fails on the
 * index every collection has, with no race between checking and writing.
 */
export interface AgentHandoff {
  _id: string;
  /** Whom the message named, "Name - phone". */
  to: string;
  /** The agent's message that earned it, or `before-lock` for an older one. */
  wamid: string;
  /** The line it was sent from. */
  lineId?: string;
  at: Date;
}

const RETAIN_SECONDS = 60 * 60 * 24 * 90;

export const agentNotices = (): Collection<AgentJobOrderNotice> =>
  getDb().collection<AgentJobOrderNotice>('agent_job_order_notices');
export const agentHandoffs = (): Collection<AgentHandoff> =>
  getDb().collection<AgentHandoff>('agent_handoffs');

export async function ensureAgentIndexes(): Promise<void> {
  await agentNotices().createIndexes([
    { key: { waId: 1, jobOrderId: 1 }, unique: true, name: 'waId_jobOrder_unique' },
    { key: { waId: 1, sentAt: -1 }, name: 'waId_sentAt' },
    { key: { wamid: 1 }, name: 'wamid', sparse: true },
    { key: { sentAt: 1 }, expireAfterSeconds: RETAIN_SECONDS, name: 'sentAt_ttl' },
  ]);
  await carryOverEarlierHandoffs();
}

/**
 * Locks every agent number the removed question answering already sent a
 * "contact staff" or "our team will get back to you" reply to. Those rows sit
 * in `agent_questions`, which expires after 90 days; without this, such an
 * agent would get the message a second time once their row expired.
 * Idempotent: an existing lock is never touched.
 */
async function carryOverEarlierHandoffs(): Promise<void> {
  const waIds = await getDb()
    .collection('agent_questions')
    .distinct('waId', {
      $or: [{ handoffTo: { $exists: true } }, { answered: false, reply: { $exists: true, $ne: '' } }],
    });
  const numbers = waIds.filter((waId): waId is string => typeof waId === 'string' && !!waId);
  if (numbers.length === 0) return;
  await agentHandoffs().bulkWrite(
    numbers.map((waId) => ({
      updateOne: {
        filter: { _id: waId },
        update: { $setOnInsert: { to: 'earlier hand-off', wamid: 'before-lock', at: new Date() } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

/**
 * Claims the one "contact staff" message this agent number will ever get.
 * True means this message won it and should send it; false means the number
 * already had it (from an earlier message, or one being handled right now)
 * and must get nothing.
 *
 * Throws only if the database cannot be written, before anything is sent, so
 * the queue can retry the job without any risk of a second message.
 */
export async function claimAgentHandoff(
  waId: string,
  claim: { to: string; wamid: string; lineId?: string },
): Promise<boolean> {
  try {
    await agentHandoffs().insertOne({ _id: waId, ...claim, at: new Date() });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

/**
 * The staff contact on the newest job order this agent was sent, for an agent
 * with no handling staff of their own in the Sourcing Hub.
 */
export async function latestNoticeStaff(waId: string): Promise<{ name: string; phone: string } | undefined> {
  const [notice] = await agentNotices()
    .find(
      { waId, $or: [{ 'details.staff_name': { $nin: ['', null] } }, { 'details.staff_phone': { $nin: ['', null] } }] },
      { projection: { _id: 0, 'details.staff_name': 1, 'details.staff_phone': 1 } },
    )
    .sort({ sentAt: -1 })
    .limit(1)
    .toArray();
  if (!notice) return undefined;
  return { name: notice.details.staff_name ?? '', phone: notice.details.staff_phone ?? '' };
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
