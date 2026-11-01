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
  industry?: string | null;
  headcount?: number | null;
  salary?: string | null;
  min_experience?: string | null;
  /**
   * The job order's agent terms (`terms` on the order, sent by
   * `terms_facts` in the CRM's `app/agent_whatsapp.py`).
   */
  gender?: string | null;
  /** e.g. "6-8 months". */
  process_time?: string | null;
  /** e.g. "4.9 with Ticket". */
  b2b_rate?: string | null;
  /** Costs the candidate bears, e.g. "VFS, Embassy fee". */
  candidate_pays?: string | null;
  /** Paid once the candidate accepts the offer, e.g. "€946". */
  advance_payment?: string | null;
  /** When the remainder is paid, e.g. "After visa". */
  balance_payment?: string | null;
  /** One item each. */
  requirements?: string[] | string | null;
  /** In the order they must appear. */
  documents?: string[] | string | null;
  /** The documents must arrive as one PDF. */
  documents_single_pdf?: boolean | null;
  /** The job order's poster (CRM path or absolute URL): the message image. */
  poster_url?: string | null;
  /**
   * The staff member the job order is assigned to (`assignedStaff` on the
   * order, `staff_facts` in the CRM), for agents' questions.
   */
  staff_name?: string | null;
  staff_phone?: string | null;
}

export type AgentNotifyOutcome =
  | { sent: true; wamid?: string; shadowed: boolean }
  | { sent: false; reason: string };

/** A list (or one string) as one line: "a, b, c". */
function joined(value: string[] | string | null | undefined): string {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => String(item).trim()).filter(Boolean).join(', ');
}

/** "€946 in advance after offer acceptance; Balance: After visa", as the CRM screen shows it. */
function paymentTerms(facts: AgentJobOrderFacts): string {
  const advance = (facts.advance_payment ?? '').trim();
  const balance = (facts.balance_payment ?? '').trim();
  return [
    advance && `${advance} in advance after offer acceptance`,
    balance && `Balance: ${balance}`,
  ]
    .filter(Boolean)
    .join('; ');
}

/** The documents line: the list, in order, and whether it must be one PDF. */
function documentsLine(facts: AgentJobOrderFacts): string {
  const list = joined(facts.documents);
  if (!list) return '';
  return facts.documents_single_pdf ? `${list} (in this order, in a single PDF)` : `${list} (in this order)`;
}

/** What agents are asked to send when the job order does not say. */
export const DEFAULT_AGENT_DOCUMENTS =
  'CV, passport copy (all pages including cover pages), PCC, experience certificates, ' +
  'educational documents and passport size photo, scanned in a single PDF in this order';

/**
 * The two earlier templates take six values. Kept so a bot deployed before
 * its env is switched to `agent_job_order_details` still sends a valid message.
 */
const SIX_FIELD_TEMPLATES = new Set(['agent_new_job_order', 'agent_job_requirement']);

/**
 * The template's body parameters. This array is the contract with Meta.
 *
 * `agent_job_order_details` (WABA 487030077834196, MARKETING) is an image
 * header (`agentJobOrderImage`) and then exactly this body, sixteen values:
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
 *     💳 Paid by candidate: {{11}}
 *     📅 Payment terms: {{12}}
 *
 *     ✅ Requirements: {{13}}
 *
 *     📄 Documents: {{14}}
 *
 *     📞 For any queries, contact {{15}} - {{16}}
 *
 *     Please reply to this message if you have suitable candidates for this
 *     requirement.
 *
 * The older `agent_job_requirement` / `agent_new_job_order` take only name,
 * position, country, vacancies, salary and experience, and get those six.
 *
 * The client's name and the internal remarks are never sent.
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

  if (template && SIX_FIELD_TEMPLATES.has(template)) {
    return [name, position, country, vacancies, salary, experience];
  }
  return [
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
    parameter(facts.candidate_pays),
    parameter(paymentTerms(facts)),
    parameter(joined(facts.requirements)),
    parameter(documentsLine(facts), DEFAULT_AGENT_DOCUMENTS),
    // With no staff member on the order, agents are pointed back at the line
    // the message came from, which Rafi reads.
    parameter(facts.staff_name, 'Adira Enterprises'),
    parameter(facts.staff_phone, 'this WhatsApp number'),
  ];
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
