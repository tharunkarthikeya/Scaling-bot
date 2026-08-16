/**
 * Keeps a public HTTPS tunnel pointed at the local bot.
 *
 *   npm run tunnel
 *
 * Cloudflare quick tunnels drop without warning, and each restart hands out a
 * new random hostname — which means re-entering the callback URL in Meta. This
 * restarts the tunnel automatically and shouts whenever the URL changes, so you
 * find out here rather than by wondering why messages stopped arriving.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { config } from './config.js';

const CANDIDATE_PATHS = [
  process.env.CLOUDFLARED_PATH,
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  '/usr/local/bin/cloudflared',
  '/usr/bin/cloudflared',
].filter((p): p is string => !!p);

const binary = CANDIDATE_PATHS.find((p) => fs.existsSync(p)) ?? 'cloudflared';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let currentUrl: string | null = null;
let restarts = 0;

function announce(url: string) {
  const changed = currentUrl !== null && currentUrl !== url;
  currentUrl = url;

  console.log('');
  if (changed) {
    console.log(`${RED}${BOLD}  THE URL CHANGED — update it in Meta or messages stop arriving.${RESET}`);
  }
  console.log(`${BOLD}  Callback URL${RESET}  ${GREEN}${url}/webhook${RESET}`);
  console.log(`${BOLD}  Verify token${RESET}  ${config.WHATSAPP_WEBHOOK_VERIFY_TOKEN}`);
  console.log(`${DIM}  Meta → WhatsApp → Configuration. Subscribe the "messages" field.${RESET}`);
  console.log('');
}

function start(): void {
  const child = spawn(binary, [
    'tunnel',
    '--url',
    `http://localhost:${config.PORT}`,
    '--no-autoupdate',
    '--protocol',
    'http2',
  ]);

  const scan = (chunk: Buffer) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) announce(match[0]);

    // cloudflared logs its own connection failures; surface them rather than
    // letting the tunnel die quietly.
    if (/ERR .*(failed to serve|Serve tunnel error)/.test(text)) {
      console.log(`${YELLOW}  tunnel connection lost — reconnecting${RESET}`);
    }
  };

  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  child.on('exit', (code) => {
    restarts++;
    console.log(`${RED}  cloudflared exited (code ${code}) — restarting [#${restarts}]${RESET}`);
    setTimeout(start, 2_000);
  });
}

console.log(`${DIM}using ${binary}, forwarding to http://localhost:${config.PORT}${RESET}`);
console.log(`${DIM}start the bot separately with: npm run dev:local${RESET}`);
start();

process.on('SIGINT', () => process.exit(0));
