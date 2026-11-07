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
 * Each send is remembered (`agents/store.ts`) so the agent's questions about
 * it can be answered (`agents/questions.ts`). The line is still on the
 * WhatsApp Business app, where Rafi also reads it.
 *
 * Like the staff relay, this never throws. The job order is already saved, so
 * a failed send is a reason in the reply, not a 500.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parameter, staffPhoneToE164 } from '../staff/notify.js';
import { sendAgentJobOrderTemplate } from '../whatsapp/client.js';
import { rememberAgentNotice, type AgentJobOrderDetails } from './store.js';

/** One agent and one job order, as the CRM relays them (`broadcast_job_order`). */
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
  industry?: string | null;
  headcount?: number | null;
  salary?: string | null;
  min_experience?: string | null;
  /** The job order's agent terms (`terms` on the order). */
  gender?: string | null;
  /** e.g. "6-8 months". */
  process_time?: string | null;
  /** e.g. "4.9 with Ticket". */
  b2b_rate?: string | null;
  /** The job order's remarks (`description`), written for agents. */
  remarks?: string | null;
  /** The job order's poster (CRM path or absolute URL): the message image. */
  poster_url?: string | null;
  /**
   * The staff member who handles this agent (`handlingStaff` on their Sourcing
   * Hub record): the template's "For any queries, contact" line.
   */
  staff_name?: string | null;
  staff_phone?: string | null;
}

export type AgentNotifyOutcome =
  | { sent: true; wamid?: string; shadowed: boolean }
  | { sent: false; reason: string };

/** What the 16-value template's Documents line said when an order gave none. */
const DEFAULT_AGENT_DOCUMENTS =
  'CV, passport copy (all pages including cover pages), PCC, experience certificates, ' +
  'educational documents and passport size photo, scanned in a single PDF in this order';

/**
 * The template's body parameters. This array is the contract with Meta.
 *
 * `agent_job_order_brief` (WABA 487030077834196, MARKETING, id
 * 1109809694992856) is an image header (`agentJobOrderImage`) and then
 * exactly this body, thirteen values:
 *
 *     Hello {{1}},
 *
 *     This is a requirement update from Adira Enterprises for your agency.
 *
 *     🌍 Country: {{2}}
 *     🏭 Industry: {{3}}
 *     👷 Position: {{4}}
 *     👥 Vacancies: {{5}} ({{6}})
 *     💰 Salary: {{7}}
 *     🧰 Experience: {{8}}
 *     ⏳ Process time: {{9}}
 *     🤝 B2B rate: {{10}}
 *
 *     📝 Remarks: {{11}}
 *
 *     📞 For any queries, contact {{12}} - {{13}}
 *
 *     Please reply to this message if you have suitable candidates for this
 *     requirement.
 *
 * Earlier templates still get a valid message, so a bot deployed before its
 * env names the new template keeps working:
 *
 * * `agent_job_order_details` (16 values): the same lines, plus Paid by
 *   candidate, Payment terms and Requirements (no longer collected: "Not
 *   stated") and Documents (the standard list) instead of Remarks.
 * * `agent_job_requirement` / `agent_new_job_order` (6 values): name,
 *   position, country, vacancies, salary, experience.
 *
 * The client's name is never sent.
 */
export function agentJobOrderParameters(
  facts: AgentJobOrderFacts,
  template = config.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE,
): string[] {
  const headcount = Number(facts.headcount);
  const vacancies = Number.isInteger(headcount) && headcount > 0 ? String(headcount) : 'Not stated';
  const name = parameter(facts.agent_name, 'Partner');
  const position = parameter(facts.title, 'New position');
  const country = parameter(facts.destination_country);
  const salary = parameter(facts.salary, 'Not disclosed');
  const experience = parameter(facts.min_experience, 'Any');

  if (template === 'agent_new_job_order' || template === 'agent_job_requirement') {
    return [name, position, country, vacancies, salary, experience];
  }

  const details = [
    name,
    country,
    parameter(facts.industry),
    position,
    vacancies,
    parameter(facts.gender, 'Any gender'),
    salary,
    experience,
    parameter(facts.process_time),
    parameter(facts.b2b_rate, 'On request'),
  ];
  // With no staff member assigned to the agent, they are pointed back at the
  // line the message came from, which Rafi reads.
  const contact = [
    parameter(facts.staff_name, 'Adira Enterprises'),
    parameter(facts.staff_phone, 'this WhatsApp number'),
  ];

  if (template === 'agent_job_order_details') {
    return [...details, 'Not stated', 'Not stated', 'Not stated', DEFAULT_AGENT_DOCUMENTS, ...contact];
  }
  return [...details, parameter(facts.remarks, 'None'), ...contact];
}

/**
 * The picture for the template's image header, required on every send.
 *
 * The job order's poster when WhatsApp can show it (an https JPG or PNG; a CRM
 * path is resolved against `CRM_API_URL`), otherwise
 * `WHATSAPP_AGENT_JOB_ORDER_DEFAULT_IMAGE`. WhatsApp cannot show WebP.
 */
export function agentJobOrderImage(posterUrl?: string | null): string {
  const fallback = config.WHATSAPP_AGENT_JOB_ORDER_DEFAULT_IMAGE;
  const value = (posterUrl ?? '').trim();
  if (!value) return fallback;
  let url: URL;
  try {
    url = value.startsWith('/') && config.CRM_API_URL ? new URL(value, config.CRM_API_URL) : new URL(value);
  } catch {
    return fallback;
  }
  if (url.protocol !== 'https:') return fallback;
  if (!/\.(jpe?g|png)$/i.test(url.pathname)) return fallback;
  return url.toString();
}

/**
 * The job order as the agent was told about it, kept for answering their
 * questions later. Blank where the order said nothing, so the answerer knows
 * it does not know (unlike the template, which needs "Not stated").
 */
export function agentJobOrderDetails(facts: AgentJobOrderFacts): AgentJobOrderDetails {
  const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const headcount = Number(facts.headcount);
  return {
    title: clean(facts.title),
    destination_country: clean(facts.destination_country),
    industry: clean(facts.industry),
    vacancies: Number.isInteger(headcount) && headcount > 0 ? String(headcount) : '',
    gender: clean(facts.gender),
    salary: clean(facts.salary),
    experience: clean(facts.min_experience),
    process_time: clean(facts.process_time),
    b2b_rate: clean(facts.b2b_rate),
    remarks: clean(facts.remarks),
    staff_name: clean(facts.staff_name),
    staff_phone: clean(facts.staff_phone),
  };
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
    // Remembered so the agent's questions about it can be answered. Not in
    // shadow mode: nothing reached the agent, so there is nothing to answer for.
    if (!result.shadowed) {
      await rememberAgentNotice({
        waId: to,
        jobOrderId: facts.job_order_id,
        ...(result.wamid ? { wamid: result.wamid } : {}),
        lineId: config.WHATSAPP_AGENT_PHONE_NUMBER_ID,
        sentAt: new Date(),
        details: agentJobOrderDetails(facts),
      });
    }
    return { sent: true, wamid: result.wamid, shadowed: result.shadowed };
  } catch (err) {
    logger.warn(
      { err, agentId: facts.agent_id, jobOrderId: facts.job_order_id },
      'could not send the job order to an agent',
    );
    return { sent: false, reason: 'send_failed' };
  }
}
