/** New job orders to Sourcing Hub agents: wording, image, sending line, and refusals. Offline. */
import assert from 'node:assert/strict';

// Before config is parsed: these are read once, at import.
process.env.REDIS_URL = '';
process.env.SHADOW_MODE = 'false';
process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID = 'AGENT-LINE';
process.env.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE = 'agent_job_order_details';
process.env.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE_LANG = 'en';
process.env.STAFF_PHONE_DEFAULT_COUNTRY_CODE = '91';
process.env.CRM_API_URL = 'https://crm.example.com';
process.env.WHATSAPP_AGENT_JOB_ORDER_DEFAULT_IMAGE = 'https://example.com/default.jpg';

const { config, graphBaseUrl } = await import('./config.js');
const { DEFAULT_AGENT_DOCUMENTS, agentJobOrderImage, agentJobOrderParameters, notifyAgentOfJobOrder } =
  await import('./agents/notify.js');

type Call = { url: string; body: any };
const calls: Call[] = [];
let reply: () => Response = () =>
  new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }), { status: 200 });

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
  return reply();
}) as typeof fetch;

function firstCall(): Call {
  const call = calls[0];
  assert.ok(call, 'nothing was sent to Meta');
  return call;
}

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  calls.length = 0;
  reply = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }), { status: 200 });
  await run();
  passed++;
  console.log(`  \x1b[32mok\x1b[0m  ${name}`);
}

const ORDER = {
  job_order_id: 'ORD-123-4567',
  agent_id: 'AGT-1',
  agent_name: 'Imran',
  phone: '98765 43210',
  title: 'Production Operator',
  destination_country: 'Czech Republic',
  industry: 'Automotive',
  headcount: 30,
  gender: 'Male & Female',
  salary: 'EUR 900',
  min_experience: '1-2 years',
  process_time: '6-8 months',
  b2b_rate: '4.9 with Ticket',
  candidate_pays: 'VFS, Embassy fee',
  advance_payment: '€946',
  balance_payment: 'After visa',
  requirements: ['Relevant work experience', 'Basic English', 'Valid passport & PCC', 'Updated CV'],
  documents: ['CV', 'Passport copy (all pages including cover pages)', 'PCC', 'Experience certificates'],
  documents_single_pdf: true,
  poster_url: '/public/job-posters/0123456789abcdef0123456789abcdef.jpg',
  staff_name: 'Zara',
  staff_phone: '+91 98849 49735',
};

console.log('\n\x1b[1mNew job orders to agents\x1b[0m');

await check('the sixteen parameters follow the approved detailed body, in order', () => {
  assert.deepEqual(agentJobOrderParameters(ORDER), [
    'Imran',
    'Czech Republic',
    'Automotive',
    'Production Operator',
    '30',
    'Male & Female',
    'EUR 900',
    '1-2 years',
    '6-8 months',
    '4.9 with Ticket',
    'VFS, Embassy fee',
    '€946 in advance after offer acceptance; Balance: After visa',
    'Relevant work experience, Basic English, Valid passport & PCC, Updated CV',
    'CV, Passport copy (all pages including cover pages), PCC, Experience certificates (in this order, in a single PDF)',
    'Zara',
    '+91 98849 49735',
  ]);
});

await check('payment and documents read well when only part of them is filled', () => {
  const only = (extra: object) => agentJobOrderParameters({ job_order_id: 'X', ...extra });
  assert.equal(only({ advance_payment: '€946' })[11], '€946 in advance after offer acceptance');
  assert.equal(only({ balance_payment: 'After visa' })[11], 'Balance: After visa');
  assert.equal(only({ documents: ['CV', 'PCC'] })[13], 'CV, PCC (in this order)');
  assert.equal(only({ documents: 'CV only' })[13], 'CV only (in this order)');
});

await check('a bare order still has sixteen sendable, single-line values', () => {
  const params = agentJobOrderParameters({
    job_order_id: 'X',
    title: 'Welder\n  TIG',
    candidate_pays: 'first line\nsecond line',
  });
  assert.equal(params.length, 16);
  assert.deepEqual(params.slice(0, 6), [
    'Partner', 'Not stated', 'Not stated', 'Welder TIG', 'Not stated', 'Any gender',
  ]);
  assert.equal(params[9], 'On request');
  assert.equal(params[10], 'first line second line');
  assert.equal(params[11], 'Not stated');
  assert.equal(params[13], DEFAULT_AGENT_DOCUMENTS);
  // No staff member on the order: agents are pointed back at this line.
  assert.deepEqual(params.slice(14), ['Adira Enterprises', 'this WhatsApp number']);
  for (const value of params) assert.ok(value && !/[\n\t]/.test(value), JSON.stringify(value));
});

await check('the two older templates still get their six values', () => {
  for (const older of ['agent_new_job_order', 'agent_job_requirement']) {
    assert.deepEqual(agentJobOrderParameters(ORDER, older), [
      'Imran', 'Production Operator', 'Czech Republic', '30', 'EUR 900', '1-2 years',
    ]);
  }
});

await check('it sends the template, with the job order poster, from the agent line', async () => {
  const outcome = await notifyAgentOfJobOrder(ORDER);
  assert.deepEqual(outcome, { sent: true, wamid: 'wamid.TEST', shadowed: false });
  assert.equal(calls.length, 1);
  assert.equal(firstCall().url, `${graphBaseUrl}/AGENT-LINE/messages`);
  const { to, type, template } = firstCall().body;
  assert.equal(to, '919876543210');
  assert.equal(type, 'template');
  assert.equal(template.name, 'agent_job_order_details');
  assert.equal(template.language.code, 'en');
  const [header, body] = template.components;
  assert.equal(header.type, 'header');
  assert.deepEqual(header.parameters, [
    {
      type: 'image',
      image: { link: 'https://crm.example.com/public/job-posters/0123456789abcdef0123456789abcdef.jpg' },
    },
  ]);
  assert.equal(body.type, 'body');
  assert.deepEqual(
    body.parameters.map((p: { text: string }) => p.text),
    agentJobOrderParameters(ORDER),
  );
});

await check('the header image is the poster when WhatsApp can show it, else the default', () => {
  assert.equal(agentJobOrderImage('/public/job-posters/a.png'), 'https://crm.example.com/public/job-posters/a.png');
  assert.equal(agentJobOrderImage('https://cdn.example.com/a/poster.PNG'), 'https://cdn.example.com/a/poster.PNG');
  for (const unusable of [undefined, '', '   ', '/public/job-posters/x.webp', 'http://insecure.example.com/a.jpg',
    'https://example.com/page.html', 'not a url']) {
    assert.equal(agentJobOrderImage(unusable), 'https://example.com/default.jpg', `used ${JSON.stringify(unusable)}`);
  }
});

await check('an order without any image still sends, with the default image', async () => {
  await notifyAgentOfJobOrder({ ...ORDER, poster_url: undefined });
  assert.equal(firstCall().body.template.components[0].parameters[0].image.link, 'https://example.com/default.jpg');
});

await check('a Gulf number written with a country code is used as written', async () => {
  await notifyAgentOfJobOrder({ ...ORDER, phone: '+971 50 123 4567' });
  assert.equal(firstCall().body.to, '971501234567');
});

await check('an unusable number sends nothing', async () => {
  assert.deepEqual(await notifyAgentOfJobOrder({ ...ORDER, phone: '12345' }), {
    sent: false,
    reason: 'no_usable_phone',
  });
  assert.equal(calls.length, 0);
});

await check('a Meta refusal is a reason, not an exception', async () => {
  reply = () =>
    new Response(JSON.stringify({ error: { message: 'Template not found', code: 132001 } }), {
      status: 400,
    });
  assert.deepEqual(await notifyAgentOfJobOrder(ORDER), { sent: false, reason: 'send_failed' });
});

await check('no template configured sends nothing', async () => {
  const saved = config.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE;
  config.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE = undefined;
  try {
    assert.deepEqual(await notifyAgentOfJobOrder(ORDER), {
      sent: false,
      reason: 'agent_template_not_configured',
    });
    assert.equal(calls.length, 0);
  } finally {
    config.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE = saved;
  }
});

await check('no agent line configured sends nothing, and never falls back to the main line', async () => {
  const saved = config.WHATSAPP_AGENT_PHONE_NUMBER_ID;
  config.WHATSAPP_AGENT_PHONE_NUMBER_ID = undefined;
  try {
    assert.deepEqual(await notifyAgentOfJobOrder(ORDER), {
      sent: false,
      reason: 'agent_line_not_configured',
    });
    assert.equal(calls.length, 0);
  } finally {
    config.WHATSAPP_AGENT_PHONE_NUMBER_ID = saved;
  }
});

console.log(`\n${passed} passed\n`);
