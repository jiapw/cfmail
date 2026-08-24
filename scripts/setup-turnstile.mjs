#!/usr/bin/env node
// Create (or reuse) a Turnstile widget and push its secret straight into the Worker's
// TURNSTILE_SECRET. Only the public sitekey is printed; the secret is never shown or written to disk.
//
// Prerequisite: the token needs Account - Turnstile Sites - Edit (that is the name the
// dashboard uses), plus Workers Scripts: Edit for `secret put`. Allow ~1 minute to take effect.
// Usage:  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/setup-turnstile.mjs
//   (in PowerShell, load both variables from .env.deploy first)

import { spawnSync } from 'node:child_process';
import { entryHosts, loadWranglerConfig, readWranglerText, writeWranglerConfig } from './wrangler-config.mjs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
// The account id is already written in wrangler.jsonc by the deploy, so asking for it again
// would only be a way to get it wrong.
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || loadWranglerConfig().account_id;
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const NAME = 'CFMail';
// Which domains the widget covers: taken from the entry custom domains in wrangler.jsonc, never hardcoded.
const DOMAINS = entryHosts();

if (!TOKEN || !ACCOUNT) {
  console.error('✗ no CLOUDFLARE_API_TOKEN (or no account_id in wrangler.jsonc)');
  process.exit(1);
}
if (!DOMAINS.length) {
  console.error('✗ no custom_domain in the routes of wrangler.jsonc, so there is nothing to bind the widget to');
  process.exit(1);
}

async function cf(method, path, body) {
  const res = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.success !== false, status: res.status, data };
}

// 1) Is there already a widget with this name? Reuse it and rotate the secret; otherwise create one.
const list = await cf('GET', `/accounts/${ACCOUNT}/challenges/widgets`);
if (!list.ok) {
  const msg = (list.data.errors || []).map((e) => `${e.code}:${e.message}`).join('; ');
  console.error(`✗ could not reach Turnstile (${list.status}): ${msg}`);
  if (/1000|9109|authentication|not authorized|permission/i.test(msg)) {
    console.error('  -> the token is missing Account - Turnstile - Edit. Add it and run this again.');
  }
  process.exit(1);
}
const existing = (list.data.result || []).find((w) => w.name === NAME);

let sitekey, secret;
if (existing) {
  sitekey = existing.sitekey;

  // A widget only answers for the hostnames on its own allowlist. Connecting a domain adds an
  // entry host, and a widget that has not been told about it fails every challenge served from
  // there -- which looks like "login is broken on the new domain", not like a captcha setting.
  const have = [...(existing.domains || [])].sort().join(',');
  const want = [...DOMAINS].sort().join(',');
  if (have !== want) {
    const upd = await cf('PUT', `/accounts/${ACCOUNT}/challenges/widgets/${sitekey}`, {
      name: NAME, domains: DOMAINS, mode: existing.mode || 'managed',
    });
    if (!upd.ok) {
      console.error('✗ could not update the widget domains:', JSON.stringify(upd.data.errors || upd.data).slice(0, 200));
      process.exit(1);
    }
    console.log(`✓ widget "${NAME}" now covers: ${DOMAINS.join(', ')}`);
  } else {
    console.log(`✓ widget "${NAME}" already covers: ${DOMAINS.join(', ')}`);
  }

  // Rotating invalidates the old secret immediately, so it is worth a few seconds of failed
  // challenges only when the Worker does not already hold a matching one. When the sitekey in
  // wrangler.jsonc is this widget's, the pair is already in place and syncing domains is all
  // that was needed.
  const inConfig = loadWranglerConfig()?.vars?.TURNSTILE_SITEKEY;
  if (inConfig === sitekey) {
    console.log('  the Worker already holds the matching secret; not rotating it (rotation voids the old one at once and would fail live checks)');
    console.log(`\nDone. Sitekey ${sitekey} is already in wrangler.jsonc; no redeploy needed.\n`);
    process.exit(0);
  }
  const rot = await cf('POST', `/accounts/${ACCOUNT}/challenges/widgets/${sitekey}/rotate_secret`, { invalidate_immediately: true });
  if (!rot.ok) { console.error('✗ could not rotate the secret:', JSON.stringify(rot.data.errors || rot.data).slice(0, 200)); process.exit(1); }
  secret = rot.data.result.secret;
  console.log('✓ rotated to a new secret');
} else {
  const cr = await cf('POST', `/accounts/${ACCOUNT}/challenges/widgets`, { name: NAME, domains: DOMAINS, mode: 'managed' });
  if (!cr.ok) { console.error('✗ could not create the widget:', JSON.stringify(cr.data.errors || cr.data).slice(0, 200)); process.exit(1); }
  sitekey = cr.data.result.sitekey;
  secret = cr.data.result.secret;
  console.log(`✓ created widget "${NAME}" for: ${DOMAINS.join(', ')}`);
}

// 2) Push the secret into the Worker, over stdin so it is never printed.
const put = spawnSync('npx', ['wrangler', 'secret', 'put', 'TURNSTILE_SECRET'], {
  input: secret + '\n',
  env: process.env,
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: process.platform === 'win32',
});
if (put.status !== 0) {
  console.error('✗ wrangler secret put failed. Run it by hand: npx wrangler secret put TURNSTILE_SECRET, then paste the secret');
  process.exit(1);
}

// 3) Write the sitekey into wrangler.jsonc under vars. It is a public value, so it
//    belongs in the config rather than in a secret -- and doing it here means nobody
//    has to copy and paste it by hand.
const original = readWranglerText();
const LINE = `    "TURNSTILE_SITEKEY": "${sitekey}"`;
let cfg;

// One code path: drop any existing entry (live or commented -- the template ships it
// commented), then append a fresh one. Doing it in two steps means the comma handling
// below is the only place that has to be right.
const EXISTING = /^[ \t]*(?:\/\/[ \t]*)?"TURNSTILE_SITEKEY"[ \t]*:.*(\r?\n)?/m;
const stripped = original.replace(EXISTING, '');

const m = /("vars"\s*:\s*\{)([\s\S]*?)(\n[ \t]*\})/.exec(stripped);
if (!m) {
  console.error('✗ no vars section in wrangler.jsonc; add this line by hand:');
  console.error(`  "TURNSTILE_SITEKEY": "${sitekey}"`);
  process.exit(1);
}
const lines = m[2].split('\n');
// Walk back to the last real entry (skipping blanks and comments) and give it a comma.
// The template leaves DEV_MODE without one precisely because the next line is commented out.
for (let i = lines.length - 1; i >= 0; i--) {
  const t = lines[i].trim();
  if (!t || t.startsWith('//')) continue;
  if (!t.endsWith(',')) lines[i] = lines[i].replace(/\s*$/, ',');
  break;
}
cfg = stripped.slice(0, m.index) + m[1] + lines.join('\n') + '\n' + LINE + m[3] +
      stripped.slice(m.index + m[0].length);

const bad = writeWranglerConfig(cfg, (p) => p?.vars?.TURNSTILE_SITEKEY === sitekey);
if (bad) {
  console.error('✗ editing wrangler.jsonc would produce an invalid configuration; nothing was changed: ' + bad);
  console.error(`  Add this to vars by hand:  "TURNSTILE_SITEKEY": "${sitekey}"`);
  process.exit(1);
}

console.log(`\n✓ sitekey written to wrangler.jsonc: ${sitekey}`);
console.log('  Next: npm run deploy -- the check goes live once deployed.');
