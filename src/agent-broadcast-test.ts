/** New job orders to Sourcing Hub agents: wording, sending line, and refusals. Offline. */
import assert from 'node:assert/strict';

// Before config is parsed: these are read once, at import.
process.env.REDIS_URL = '';
process.env.SHADOW_MODE = 'false';
process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID = 'AGENT-LINE';
process.env.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE = 'agent_new_job_order';
process.env.WHATSAPP_AGENT_JOB_ORDER_TEMPLATE_LANG = 'en';
process.env.STAFF_PHONE_DEFAULT_COUNTRY_CODE = '91';
process.env.CRM_API_URL = 'https://crm.example.com';
process.env.WHATSAPP_AGENT_JOB_ORDER_DEFAULT_IMAGE = 'https://example.com/default.jpg';

const { config, graphBaseUrl } = await import('./config.js');
const { agentJobOrderImage, agentJobOrderParameters, notifyAgentOfJobOrder } = await import(
  './agents/notify.js'
);

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
  title: 'Pipe Fitter',
  destination_country: 'Saudi Arabia',
  headcount: 12,
  salary: 'SAR 1800',
  min_experience: '3 years',
  poster_url: '/public/job-posters/0123456789abcdef0123456789abcdef.jpg',
};

console.log('\n\x1b[1mNew job orders to agents\x1b[0m');

await check('the six parameters follow the approved body, in order', () => {
  assert.deepEqual(agentJobOrderParameters(ORDER), [
    'Imran',
    'Pipe Fitter',
    'Saudi Arabia',
    '12',
    'SAR 1800',
    '3 years',
  ]);
});

await check('a bare order still has six sendable, single-line values', () => {
  const params = agentJobOrderParameters({ job_order_id: 'X', title: 'Welder\n  TIG' });
  assert.deepEqual(params, ['Partner', 'Welder TIG', 'Not stated', 'Not stated', 'Not disclosed', 'Any']);
  for (const value of params) assert.ok(value && !/[\n\t]/.test(value));
});

await check('it sends the template from the agent line to the normalised number', async () => {
  const outcome = await notifyAgentOfJobOrder(ORDER);
  assert.deepEqual(outcome, { sent: true, wamid: 'wamid.TEST', shadowed: false });
  assert.equal(calls.length, 1);
  assert.equal(firstCall().url, `${graphBaseUrl}/AGENT-LINE/messages`);
  const { to, type, template } = firstCall().body;
  assert.equal(to, '919876543210');
  assert.equal(type, 'template');
  assert.equal(template.name, 'agent_new_job_order');
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
  assert.equal(agentJobOrderImage('https://cdn.example.com/a/poster.PNG'), 'https://cdn.example.com/a/poster.PNG');
  assert.equal(agentJobOrderImage('/public/job-posters/x.jpeg'), 'https://crm.example.com/public/job-posters/x.jpeg');
  for (const unusable of [undefined, '', '   ', '/public/job-posters/x.webp', 'http://insecure.example.com/a.jpg',
    'https://example.com/page.html', 'not a url']) {
    assert.equal(agentJobOrderImage(unusable), 'https://example.com/default.jpg', `used ${JSON.stringify(unusable)}`);
  }
});

await check('an order without a poster still sends, with the default image', async () => {
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
