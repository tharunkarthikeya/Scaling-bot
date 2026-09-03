import crypto from 'node:crypto';
import { config, graphBaseUrl } from '../config.js';
import { accessTokenFor, configuredLines } from '../conversation/lines.js';

export interface CoexistenceCompletion {
  code: string;
  wabaId: string;
  phoneNumberId?: string;
}

type GraphErrorBody = {
  error?: { message?: string; code?: number; error_subcode?: number };
};

function digits(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
}

export function parseCoexistenceCompletion(value: unknown): CoexistenceCompletion | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const code = typeof row.code === 'string' && row.code.length <= 2048 ? row.code : undefined;
  const wabaId = digits(row.wabaId);
  const phoneNumberId = digits(row.phoneNumberId);
  if (!code || !wabaId || (row.phoneNumberId !== undefined && !phoneNumberId)) return undefined;
  return phoneNumberId ? { code, wabaId, phoneNumberId } : { code, wabaId };
}

/** Constant-time check for the HTTP Basic password protecting onboarding. */
export function validOnboardingAuthorization(
  header: string | undefined,
  adminKey: string | undefined,
): boolean {
  if (!header?.startsWith('Basic ') || !adminKey) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0 || decoded.slice(0, separator) !== 'admin') return false;
    const supplied = Buffer.from(decoded.slice(separator + 1));
    const expected = Buffer.from(adminKey);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

function safeGraphError(status: number, body: GraphErrorBody): Error {
  const detail = body.error?.message ?? `Graph API ${status}`;
  const code = body.error?.code ? ` (code ${body.error.code})` : '';
  return new Error(`${detail}${code}`);
}

async function graph(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Record<string, any>> {
  const res = await fetch(`${graphBaseUrl}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as GraphErrorBody & Record<string, any>;
  if (!res.ok) throw safeGraphError(res.status, body);
  return body;
}

/**
 * Finishes the server-side half of Embedded Signup.
 *
 * Neither the short-lived code nor the exchanged token is logged, returned to
 * the browser, or persisted. The bot's own permanent token is checked after
 * signup because that is the credential actual replies will use.
 */
export async function completeCoexistence(input: CoexistenceCompletion): Promise<{
  subscribed: boolean;
  runtimeTokenReady: boolean;
  phone: Record<string, any>;
}> {
  if (!config.WHATSAPP_APP_ID) throw new Error('WhatsApp App ID is not configured');
  if (input.phoneNumberId && !configuredLines().includes(input.phoneNumberId)) {
    throw new Error('Embedded Signup returned a phone number that is not configured in this bot');
  }

  const exchange = new URL(`${graphBaseUrl}/oauth/access_token`);
  exchange.searchParams.set('client_id', config.WHATSAPP_APP_ID);
  exchange.searchParams.set('client_secret', config.WHATSAPP_APP_SECRET);
  exchange.searchParams.set('code', input.code);

  const exchanged = await fetch(exchange);
  const exchangeBody = (await exchanged.json().catch(() => ({}))) as GraphErrorBody & {
    access_token?: string;
  };
  if (!exchanged.ok || !exchangeBody.access_token) {
    throw safeGraphError(exchanged.status, exchangeBody);
  }

  const token = exchangeBody.access_token;
  const subscription = await graph(`${input.wabaId}/subscribed_apps`, token, { method: 'POST' });
  let phoneNumberId = input.phoneNumberId;
  if (!phoneNumberId) {
    const result = await graph(
      `${input.wabaId}/phone_numbers?fields=id,display_phone_number,platform_type,is_on_biz_app,code_verification_status`,
      token,
    );
    const configured = new Set(configuredLines());
    const matches = Array.isArray(result.data)
      ? result.data.filter((row: Record<string, unknown>) => typeof row.id === 'string' && configured.has(row.id))
      : [];
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'The returned WABA has no phone number configured in this bot'
          : 'The returned WABA has multiple configured phone numbers; retry after specifying one',
      );
    }
    phoneNumberId = matches[0].id;
  }

  const phone = await graph(
    `${phoneNumberId}?fields=id,display_phone_number,platform_type,is_on_biz_app,code_verification_status`,
    token,
  );

  let runtimeTokenReady = false;
  try {
    await graph(`${phoneNumberId}?fields=id`, accessTokenFor(phoneNumberId));
    runtimeTokenReady = true;
  } catch {
    // The existing System User may still need this WABA assigned in Business
    // Settings. We report that without exposing either credential.
  }

  return { subscribed: subscription.success === true, runtimeTokenReady, phone };
}

/** HTML contains public Meta ids only; secrets remain on the server. */
export function coexistencePage(appId: string, configurationId: string, nonce: string): string {
  const app = JSON.stringify(appId);
  const configuration = JSON.stringify(configurationId);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp Coexistence Setup</title>
  <style nonce="${nonce}">
    body{font:16px system-ui,sans-serif;background:#f4f7f5;color:#15241d;margin:0;padding:32px}
    main{max-width:680px;margin:auto;background:white;padding:32px;border-radius:16px;box-shadow:0 8px 30px #0001}
    button{background:#147a4b;color:white;border:0;border-radius:9px;padding:13px 18px;font-weight:700;cursor:pointer}
    button:disabled{opacity:.55;cursor:wait} pre{white-space:pre-wrap;background:#eef4f0;padding:16px;border-radius:9px}
  </style>
</head>
<body>
<main>
  <h1>Connect WhatsApp Business App</h1>
  <p>This keeps the mobile app active and adds Cloud API access for the bot.</p>
  <button id="launch" disabled>Loading Meta...</button>
  <pre id="status">Waiting for the Meta SDK.</pre>
</main>
<script nonce="${nonce}">
  const status = document.getElementById('status');
  const launch = document.getElementById('launch');
  let authCode;
  let session;
  let completing = false;

  function setStatus(message) { status.textContent = message; }
  function facebookOrigin(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' && (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'));
    } catch { return false; }
  }
  async function completeWhenReady() {
    if (completing || !authCode || !session?.waba_id) return;
    completing = true;
    setStatus('Finishing the secure server-side setup...');
    try {
      const response = await fetch('/whatsapp/coexistence/complete', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({
          code: authCode,
          wabaId: String(session.waba_id),
          ...(session.phone_number_id ? {phoneNumberId:String(session.phone_number_id)} : {})
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Setup failed');
      const ready = result.runtimeTokenReady
        ? 'The bot token can access this number.'
        : 'Assign this WABA to the bot System User, then generate a fresh permanent token.';
      setStatus('Connected successfully. ' + ready + '\\n\\n' + JSON.stringify(result.phone, null, 2));
    } catch (error) {
      completing = false;
      launch.disabled = false;
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  window.addEventListener('message', (event) => {
    if (!facebookOrigin(event.origin)) return;
    let payload = event.data;
    try { if (typeof payload === 'string') payload = JSON.parse(payload); } catch { return; }
    if (payload?.type !== 'WA_EMBEDDED_SIGNUP') return;
    if (payload.event === 'FINISH' || payload.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
      session = payload.data;
      void completeWhenReady();
    } else if (payload.event === 'CANCEL') {
      launch.disabled = false;
      setStatus('Signup was cancelled. You can safely try again.');
    } else if (payload.event === 'ERROR') {
      launch.disabled = false;
      setStatus('Meta reported: ' + (payload.data?.error_message || 'Embedded Signup failed'));
    }
  });

  window.fbAsyncInit = function() {
    FB.init({appId:${app},autoLogAppEvents:true,xfbml:false,version:'v26.0'});
    launch.disabled = false;
    launch.textContent = 'Connect with Facebook';
    setStatus('Ready. Click the button and choose "Connect your existing WhatsApp Business app".');
  };
  launch.addEventListener('click', () => {
    launch.disabled = true;
    setStatus('Complete the Meta popup and the confirmation inside WhatsApp Business.');
    FB.login((response) => {
      if (response.authResponse?.code) {
        authCode = response.authResponse.code;
        void completeWhenReady();
      } else {
        launch.disabled = false;
        setStatus('Meta login did not complete. You can safely try again.');
      }
    }, {
      config_id:${configuration},
      response_type:'code',
      override_default_response_type:true,
      extras:{setup:{},featureType:'whatsapp_business_app_onboarding',sessionInfoVersion:'3'}
    });
  });
</script>
<script nonce="${nonce}" async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
</body>
</html>`;
}
