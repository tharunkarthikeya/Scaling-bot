/**
 * Agents' questions about the job orders they were sent, against an in-memory
 * MongoDB, a stubbed model and a stubbed WhatsApp API.
 */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type OpenAI from 'openai';

const mongo = await MongoMemoryServer.create();
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'agent_question_test';
process.env.REDIS_URL = '';
process.env.SHADOW_MODE = 'false';
process.env.AGENT_QA_ENABLED = 'true';
process.env.AGENT_QA_CONTEXT_DAYS = '30';
process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID = 'AGENT-LINE';
process.env.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE = 'agent_job_order_details';
// Set explicitly: otherwise dotenv fills in the real CRM from .env.
process.env.CRM_API_URL = 'https://crm.example.com';
process.env.CRM_API_KEY = 'service-key';

const { connectDb, closeDb } = await import('./db/client.js');
const { ensureIndexes } = await import('./db/models.js');
const { setModelClientForTests } = await import('./conversation/model.js');
const { agentNotices, agentQuestions, rememberAgentNotice } = await import('./agents/store.js');
const { agentJobOrderDetails, notifyAgentOfJobOrder } = await import('./agents/notify.js');
const { agentQuestionPrompt, describeJobOrder, handOffKey, handOffReply, pickNotice, processAgentQuestion } =
  await import('./agents/questions.js');
const { refreshBotSuppressionNumbers } = await import('./crm/suppression.js');

await connectDb();
await ensureIndexes();

const AGENT = '919876543210';
const DAY = 24 * 60 * 60 * 1000;

/* WhatsApp: record what is sent. The CRM's two reads are served apart. */
let suppressed: string[] = [];
/** The CRM's open job orders (`GET /agent-job-orders`), or a status to fail with. */
let openOrders: Array<Record<string, unknown>> | number = [];
const sent: Array<{ url: string; body: any }> = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  if (String(url) === 'https://crm.example.com/bot-suppression-directory') {
    return Response.json({ numbers: suppressed });
  }
  if (String(url) === 'https://crm.example.com/agent-job-orders') {
    return typeof openOrders === 'number'
      ? new Response('down', { status: openOrders })
      : Response.json({ items: openOrders, count: openOrders.length });
  }
  sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
  return Response.json({ messages: [{ id: `wamid.OUT${sent.length}` }] });
}) as typeof fetch;
const texts = () => sent.filter((s) => s.body.type === 'text').map((s) => s.body.text.body as string);

/* The model: answers whatever the test sets, and records what it was asked. */
let modelReply: { known: boolean; answer: string; job_order_id: string | null } | Error = {
  known: true, answer: '', job_order_id: null,
};
const prompts: string[] = [];
const fakeModel = {
  chat: {
    completions: {
      create: async (req: { messages: Array<{ role: string; content: string }> }) => {
        prompts.push(req.messages.map((m) => m.content).join('\n---\n'));
        if (modelReply instanceof Error) throw modelReply;
        return {
          choices: [{
            message: {
              tool_calls: [{
                type: 'function',
                function: { name: 'reply_to_agent', arguments: JSON.stringify(modelReply) },
              }],
            },
          }],
        };
      },
    },
  },
};
setModelClientForTests(fakeModel as unknown as OpenAI);

const CZECH = {
  job_order_id: 'ORD-CZ',
  title: 'Production Operators',
  destination_country: 'Czech Republic',
  industry: 'Automotive',
  headcount: 30,
  gender: 'Male & Female',
  salary: 'EUR 900',
  process_time: '6-8 months',
  b2b_rate: '4.9 with Ticket',
  remarks: '€946 in advance after offer acceptance, balance after visa',
  staff_name: 'Rafi',
  staff_phone: '+91 98844 47455',
};

async function sendOrder(facts: Record<string, unknown>, sentAt = new Date(), wamid = `wamid.T-${facts.job_order_id}`) {
  await rememberAgentNotice({
    waId: AGENT, jobOrderId: String(facts.job_order_id), wamid, lineId: 'AGENT-LINE', sentAt,
    details: agentJobOrderDetails(facts as never),
  });
}

const ask = (text: string, extra: Record<string, string> = {}) =>
  processAgentQuestion({ waId: AGENT, wamid: `wamid.Q${Math.random()}`, text, phoneNumberId: 'AGENT-LINE', ...extra });

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  await agentNotices().deleteMany({});
  await agentQuestions().deleteMany({});
  sent.length = 0;
  prompts.length = 0;
  openOrders = [];
  modelReply = { known: true, answer: '', job_order_id: null };
  await run();
  passed++;
  console.log(`  \x1b[32mok\x1b[0m  ${name}`);
}

console.log('\n\x1b[1mAgent questions\x1b[0m');

await check('the model is shown only what the job order says', () => {
  const text = describeJobOrder({
    waId: AGENT, jobOrderId: 'ORD-CZ', sentAt: new Date('2026-11-01'),
    details: agentJobOrderDetails({ ...CZECH, salary: undefined } as never),
  });
  assert.match(text, /Position: Production Operators/);
  assert.match(text, /Remarks: €946 in advance after offer acceptance, balance after visa/);
  assert.doesNotMatch(text, /Salary/, 'a blank detail must be left out, not shown as known');
  assert.doesNotMatch(text, /Rafi/, 'the staff contact is for the hand-off, not for answers');
});

await check('the hand-off names the job order\'s staff member and number', () => {
  const notice = { waId: AGENT, jobOrderId: 'ORD-CZ', sentAt: new Date(), details: agentJobOrderDetails(CZECH as never) };
  assert.equal(
    handOffReply(notice),
    'For this, please contact Rafi (+91 98844 47455), who handles the Production Operators (Czech Republic) requirement.',
  );
  const noStaff = { ...notice, details: { ...notice.details, staff_name: '', staff_phone: '' } };
  assert.equal(handOffReply(noStaff), 'For this, our team will get back to you on this number shortly.');
});

await check("the agent's own staff member is the hand-off, over the job order's", () => {
  const notice = { waId: AGENT, jobOrderId: 'ORD-CZ', sentAt: new Date(), details: agentJobOrderDetails(CZECH as never) };
  const zara = { name: 'Zara', phone: '+91 98849 49735' };
  assert.equal(handOffReply(notice, zara), 'For any queries, please contact Zara - +91 98849 49735.');
  assert.equal(handOffReply(undefined, { name: '', phone: '+91 98849 49735' }), 'For any queries, please contact +91 98849 49735.');
  // Nobody assigned to the agent: the order's contact, as before.
  assert.match(handOffReply(notice, { name: '', phone: '' }), /contact Rafi \(\+91 98844 47455\)/);
  assert.equal(handOffKey(notice, zara), '919884949735');
  assert.equal(handOffKey(notice), '919884447455');
  assert.equal(handOffKey(undefined), 'team');
});

await check('the order the model names wins, then the quoted message, then the newest', () => {
  const a = { waId: AGENT, jobOrderId: 'A', wamid: 'w-a', sentAt: new Date(), details: agentJobOrderDetails({ job_order_id: 'A' }) };
  const b = { waId: AGENT, jobOrderId: 'B', wamid: 'w-b', sentAt: new Date(), details: agentJobOrderDetails({ job_order_id: 'B' }) };
  assert.equal(pickNotice([a, b], 'B', 'w-a')?.jobOrderId, 'B');
  assert.equal(pickNotice([a, b], null, 'w-b')?.jobOrderId, 'B');
  assert.equal(pickNotice([a, b], 'unknown', undefined)?.jobOrderId, 'A');
});

await check("an agent never sent a job order is answered from the CRM's open job orders", async () => {
  await sendOrder(CZECH, new Date(Date.now() - 45 * DAY)); // older than 30 days: not "sent"
  openOrders = [CZECH];
  modelReply = { known: true, answer: 'Yes: Production Operators, Czech Republic, 30 vacancies.', job_order_id: 'ORD-CZ' };
  await ask('Do you have any factory jobs?');
  assert.deepEqual(texts(), ['Yes: Production Operators, Czech Republic, 30 vacancies.']);
  assert.match(prompts[0]!, /Other open job orders:\n\nJob order ORD-CZ \(open\):/);
  assert.match(prompts[0]!, /B2B rate: 4\.9 with Ticket/);
  assert.doesNotMatch(prompts[0]!, /Job orders this agent was sent/);
});

await check('an order both sent and open is shown once, as sent', async () => {
  await sendOrder(CZECH);
  openOrders = [CZECH];
  await ask('Hello');
  assert.equal(prompts[0]!.match(/Job order ORD-CZ/g)?.length, 1);
  assert.match(prompts[0]!, /Job order ORD-CZ \(sent /);
});

await check('with no job order anywhere, the agent still gets a reply, never silence', async () => {
  modelReply = { known: false, answer: '', job_order_id: null };
  await ask('Any requirement for Qatar?');
  assert.deepEqual(texts(), ['For this, our team will get back to you on this number shortly.']);
  assert.match(prompts[0]!, /There are no job orders to share with this agent right now\./);
});

await check('a vague question is not pinned on whichever open order is newest', async () => {
  openOrders = [CZECH];
  modelReply = { known: false, answer: '', job_order_id: null };
  await ask('Can we discuss commission?');
  assert.deepEqual(texts(), ['For this, our team will get back to you on this number shortly.']);
});

await check("a question about a named open order goes to that order's staff member", async () => {
  openOrders = [CZECH];
  modelReply = { known: false, answer: '', job_order_id: 'ORD-CZ' };
  await ask('When is the interview for the Czech job?');
  assert.match(texts()[0]!, /contact Rafi \(\+91 98844 47455\)/);
});

await check('the CRM being down still leaves the agent a reply', async () => {
  openOrders = 503;
  modelReply = { known: true, answer: "Hello! Send your candidates' CVs here.", job_order_id: null };
  await ask('Hi');
  assert.deepEqual(texts(), ["Hello! Send your candidates' CVs here."]);
});

await check('a question the job order answers is answered, and remembered', async () => {
  await sendOrder(CZECH);
  modelReply = { known: true, answer: 'The process time is 6-8 months.', job_order_id: 'ORD-CZ' };
  await ask('How long is the process?');
  assert.deepEqual(texts(), ['The process time is 6-8 months.']);
  assert.ok(sent[0]?.url.endsWith('/AGENT-LINE/messages'), 'not sent from the line the agent wrote to');
  assert.match(prompts[0]!, /Process time: 6-8 months/);
  assert.match(prompts[0]!, /How long is the process\?/);
  const row = await agentQuestions().findOne({ waId: AGENT });
  assert.equal(row?.answered, true);
  assert.equal(row?.jobOrderId, 'ORD-CZ');
});

await check('a follow-up is shown the earlier exchange', async () => {
  await sendOrder(CZECH);
  modelReply = { known: true, answer: 'The process time is 6-8 months.', job_order_id: 'ORD-CZ' };
  await ask('How long is the process?');
  modelReply = { known: true, answer: 'The B2B rate is 4.9 with Ticket.', job_order_id: 'ORD-CZ' };
  await ask('and the rate?');
  assert.match(prompts[1]!, /Agent: How long is the process\?\nYou: The process time is 6-8 months\./);
});

await check('a question the job order does not answer goes to its assigned staff member', async () => {
  await sendOrder(CZECH);
  modelReply = { known: false, answer: '', job_order_id: 'ORD-CZ' };
  await ask('Can you reduce the B2B rate for 10 candidates?');
  assert.deepEqual(texts(), [
    'For this, please contact Rafi (+91 98844 47455), who handles the Production Operators (Czech Republic) requirement.',
  ]);
  assert.equal((await agentQuestions().findOne({ waId: AGENT }))?.answered, false);
});

await check('with two job orders, the hand-off follows the order the question is about', async () => {
  await sendOrder(CZECH, new Date(Date.now() - DAY));
  await sendOrder({ job_order_id: 'ORD-QA', title: 'Welder', destination_country: 'Qatar', staff_name: 'Zara', staff_phone: '+91 98849 49735' });
  modelReply = { known: false, answer: '', job_order_id: 'ORD-CZ' };
  await ask('When is the Czech interview?');
  assert.match(texts()[0]!, /contact Rafi/);
});

await check('a reply quoting a job order message is about that order', async () => {
  await sendOrder(CZECH, new Date(Date.now() - DAY), 'wamid.CZ-TEMPLATE');
  await sendOrder({ job_order_id: 'ORD-QA', title: 'Welder', destination_country: 'Qatar', staff_name: 'Zara', staff_phone: '+91 98849 49735' });
  modelReply = { known: false, answer: '', job_order_id: null };
  await ask('Interview date?', { contextWamid: 'wamid.CZ-TEMPLATE' });
  assert.match(texts()[0]!, /contact Rafi/);
  assert.match(prompts[0]!.split('Job orders this agent was sent:')[1]!, /^\s*Job order ORD-CZ/);
});

await check('if the model fails, the agent still gets the staff contact', async () => {
  await sendOrder(CZECH);
  modelReply = Object.assign(new Error('boom'), { status: 400 });
  await ask('Salary?');
  assert.match(texts()[0]!, /contact Rafi \(\+91 98844 47455\)/);
});

await check('sending a job order remembers it for later questions', async () => {
  await notifyAgentOfJobOrder({ ...CZECH, agent_name: 'Imran', phone: '98765 43210' });
  const notice = await agentNotices().findOne({ waId: AGENT, jobOrderId: 'ORD-CZ' });
  assert.ok(notice, 'the job order was not remembered');
  assert.equal(notice.details.staff_name, 'Rafi');
  assert.equal(notice.details.process_time, '6-8 months');
  assert.ok(notice.wamid, 'the template message id was not kept');
  // And it is now context for that agent's questions.
  modelReply = { known: true, answer: 'Yes, 30 vacancies.', job_order_id: 'ORD-CZ' };
  sent.length = 0;
  await ask('How many vacancies?');
  assert.deepEqual(texts(), ['Yes, 30 vacancies.']);
});

await check('an agent suppressed while the question waited gets no reply and costs no model call', async () => {
  await sendOrder(CZECH);
  suppressed = ['9876543210'];
  await refreshBotSuppressionNumbers();
  const before = prompts.length;
  try {
    await ask('How many vacancies?');
    assert.equal(sent.length, 0);
    assert.equal(prompts.length, before);
  } finally {
    suppressed = [];
    await refreshBotSuppressionNumbers();
  }
});

const ZARA = { staffName: 'Zara', staffPhone: '+91 98849 49735' };

await check("an unanswered question points the agent to their own staff member", async () => {
  await sendOrder(CZECH);
  modelReply = { known: false, answer: '', job_order_id: 'ORD-CZ' };
  await ask('Can you reduce the B2B rate?', ZARA);
  assert.deepEqual(texts(), ['For any queries, please contact Zara - +91 98849 49735.']);
  const row = await agentQuestions().findOne({ waId: AGENT });
  assert.equal(row?.answered, false);
  assert.equal(row?.handoffTo, '919884949735');
});

await check('the staff contact is sent once, not on every message', async () => {
  await sendOrder(CZECH);
  modelReply = { known: false, answer: '', job_order_id: 'ORD-CZ' };
  await ask('Can you reduce the B2B rate?', ZARA);
  await ask('Interview date?', ZARA);
  await ask('Visa timeline?', ZARA);
  assert.deepEqual(texts(), ['For any queries, please contact Zara - +91 98849 49735.']);
  // Still remembered, for follow-ups, with no reply.
  const rows = await agentQuestions().find({ waId: AGENT }).sort({ at: 1 }).toArray();
  assert.deepEqual(rows.map((r) => r.reply), ['For any queries, please contact Zara - +91 98849 49735.', '', '']);
  assert.match(prompts[2]!, /Agent: Interview date\?\nYou: \(no reply; left for the staff member\)/);
  // A question the job order does answer is still answered.
  modelReply = { known: true, answer: 'The process time is 6-8 months.', job_order_id: 'ORD-CZ' };
  await ask('How long is the process?', ZARA);
  assert.equal(texts().at(-1), 'The process time is 6-8 months.');
});

await check('a new staff member for the agent is passed on once', async () => {
  modelReply = { known: false, answer: '', job_order_id: null };
  await ask('Any requirement for Qatar?', ZARA);
  await ask('Any requirement for Oman?', { staffName: 'Arun', staffPhone: '+91 90000 11111' });
  await ask('Any requirement for Kuwait?', { staffName: 'Arun', staffPhone: '+91 90000 11111' });
  assert.deepEqual(texts(), [
    'For any queries, please contact Zara - +91 98849 49735.',
    'For any queries, please contact Arun - +91 90000 11111.',
  ]);
});

await check('with nobody to name, "our team will get back to you" is also sent once', async () => {
  modelReply = { known: false, answer: '', job_order_id: null };
  await ask('Any requirement for Qatar?');
  await ask('Hello?');
  assert.deepEqual(texts(), ['For this, our team will get back to you on this number shortly.']);
});

await check('agentQuestionPrompt keeps the new message last', () => {
  const prompt = agentQuestionPrompt([], [], 'hello');
  assert.ok(prompt.endsWith("The agent's new message:\nhello"));
});

console.log(`\n${passed} passed\n`);
await closeDb();
await mongo.stop();
process.exit(0);
