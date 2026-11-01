/**
 * Telling the CRM's Sourcing Hub agents about a new job order.
 *
 * The CRM decides who and when: it runs once per job order, when the order is
 * created, and calls `POST /api/agent-job-order` once for each active agent.
 * This end only formats the message and sends it from the agent line (Rafi's
 * number, `WHATSAPP_AGENT_PHONE_NUMBER_ID`).
 *
 * It is a template because an agent has usually not written to that line in
 * the last 24 hours, and Meta refuses free-form text outside that window.
 *
 * Replies need nothing here. An agent's number is a Sourcing Hub contact, so
 * the CRM's reply policy already tells the bot to ignore it, and the line is
 * still on the WhatsApp Business app, where Rafi reads and answers it.
 *
 * Like the staff relay, this never throws. The job order is already saved, so
 * a failed send is a reason in the reply, not a 500.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parameter, staffPhoneToE164 } from '../staff/notify.js';
import { sendAgentJobOrderTemplate } from '../whatsapp/client.js';

/** One agent and one job order, as the CRM relays them. */
export interface AgentJobOrderFacts {
  job_order_id: string;
  /** The Sourcing Hub record id, for logs only. */
  agent_id?: string | null;
  /** The primary contact's name, or the agency name when there is none. */
  agent_name?: string | null;
  /** As typed in the Sourcing Hub. A bare 10-digit number is read as Indian. */
  phone?: string | null;
  title?: string | null;
  destination_country?: string | null;
  headcount?: number | null;
  salary?: string | null;
  min_experience?: string | null;
  /**
   * The job order's website poster, as stored: a CRM path
   * (`/public/job-posters/…`) or an absolute URL. Optional.
   */
  poster_url?: string | null;
}

export type AgentNotifyOutcome =
  | { sent: true; wamid?: string; shadowed: boolean }
  | { sent: false; reason: string };

/**
 * The template's six body parameters. This array is the contract with Meta.
 * Both templates on WABA 487030077834196 take the same image header
 * (`agentJobOrderImage`) and these six values in this order:
 *
 *   * `agent_job_requirement` (submitted as UTILITY; Meta approved it but
 *     recategorised it MARKETING, because an unrequested job broadcast is
 *     promotional to Meta whatever the wording):
 *
 *         Hello {{1}},
 *
 *         This is a requirement update from Adira Enterprises for your agency.
 *
 *         Position: {{2}}
 *         Country: {{3}}
 *         Vacancies: {{4}}
 *         Salary: {{5}}
 *         Experience: {{6}}
 *
 *         Please reply to this message if you have suitable candidates for
 *         this requirement.
 *
 *   * `agent_new_job_order` (MARKETING): the same values, worded as a job ad.
 *
 * Both are marketing, so Meta may hold one back from a number that has never
 * chatted with the line. Agents who already message Rafi on it receive them.
 *
 * The client's name is never sent. Agents get the same facts the public
 * Current Jobs page shows.
 */
export function agentJobOrderParameters(facts: AgentJobOrderFacts): string[] {
  const headcount = Number(facts.headcount);
  return [
    parameter(facts.agent_name, 'Partner'),
    parameter(facts.title, 'New position'),
    parameter(facts.destination_country),
    Number.isInteger(headcount) && headcount > 0 ? String(headcount) : 'Not stated',
    parameter(facts.salary, 'Not disclosed'),
    parameter(facts.min_experience, 'Any'),
  ];
}

/**
 * The picture for the template's image header.
 *
 * The job order's poster when WhatsApp can use it: an https JPG or PNG. A CRM
 * path is resolved against `CRM_API_URL`, the CRM's public address. WebP, any
 * other type, or no poster falls back to `WHATSAPP_AGENT_JOB_ORDER_DEFAULT_IMAGE`,
 * because the header image is required on every send.
 */
export function agentJobOrderImage(posterUrl?: string | null): string {
  const fallback = config.WHATSAPP_AGENT_JOB_ORDER_DEFAULT_IMAGE;
  const raw = (posterUrl ?? '').trim();
  if (!raw) return fallback;
  let url: URL;
  try {
    url = raw.startsWith('/') && config.CRM_API_URL ? new URL(raw, config.CRM_API_URL) : new URL(raw);
  } catch {
    return fallback;
  }
  if (url.protocol !== 'https:') return fallback;
  if (!/\.(jpe?g|png)$/i.test(url.pathname)) return fallback;
  return url.toString();
}

/** Send one agent the new-job-order template. Never throws. */
export async function notifyAgentOfJobOrder(
  facts: AgentJobOrderFacts,
): Promise<AgentNotifyOutcome> {
  if (!config.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE) {
    return { sent: false, reason: 'agent_template_not_configured' };
  }
  if (!config.WHATSAPP_AGENT_PHONE_NUMBER_ID) {
    return { sent: false, reason: 'agent_line_not_configured' };
  }

  const to = staffPhoneToE164(facts.phone);
  if (!to) {
    logger.warn(
      { agentId: facts.agent_id, jobOrderId: facts.job_order_id },
      'agent has no usable WhatsApp number; job order not sent',
    );
    return { sent: false, reason: 'no_usable_phone' };
  }

  try {
    const result = await sendAgentJobOrderTemplate(
      to,
      agentJobOrderParameters(facts),
      agentJobOrderImage(facts.poster_url),
    );
    logger.info(
      { agentId: facts.agent_id, jobOrderId: facts.job_order_id, shadowed: result.shadowed },
      'told an agent about a new job order',
    );
    return { sent: true, wamid: result.wamid, shadowed: result.shadowed };
  } catch (err) {
    logger.warn(
      { err, agentId: facts.agent_id, jobOrderId: facts.job_order_id },
      'could not send the job order to an agent',
    );
    return { sent: false, reason: 'send_failed' };
  }
}
