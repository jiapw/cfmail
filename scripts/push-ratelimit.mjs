#!/usr/bin/env node
// Push CFMail's edge rate-limit rules into the http_ratelimit entrypoint ruleset of every zone.
// Idempotent: rules whose description starts with "cfmail:" are cleared first, so repeated runs never stack.
//
// Prerequisite: the token needs Zone - Zone WAF - Edit on every relevant zone.
// Usage:  set -a; . ./.env.deploy; set +a; node scripts/push-ratelimit.mjs
//
// Free-plan hard limits (learned the hard way):
//   - one rate-limit rule per zone, so every sensitive endpoint folds into a single rule
//   - the counting window can only be 10 seconds, and so can mitigation_timeout
//   - characteristics must include cf.colo.id (counting happens per colocation)
// Paid zones allow several rules and windows up to 60s, but for consistency every zone gets the same one.

import { zoneNames } from './wrangler-config.mjs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
// Which zones to act on: derived from the entry custom domains in wrangler.jsonc, never hardcoded.
const DOMAINS = zoneNames();

if (!TOKEN) { console.error('✗ no CLOUDFLARE_API_TOKEN'); process.exit(1); }
if (!DOMAINS.length) { console.error('✗ no custom_domain in the routes of wrangler.jsonc'); process.exit(1); }

// Login / reset / invite signup / invite verify: 5 requests per IP per 10s, then block for 10s.
const OUR_RULES = [
  {
    description: 'cfmail: auth endpoints throttle',
    expression:
      '(http.request.method eq "POST" and (http.request.uri.path eq "/api/auth/login" or http.request.uri.path eq "/api/auth/reset/request" or (starts_with(http.request.uri.path, "/api/invites/") and (ends_with(http.request.uri.path, "/register") or ends_with(http.request.uri.path, "/verify")))))',
    action: 'block',
    ratelimit: { characteristics: ['ip.src', 'cf.colo.id'], period: 10, requests_per_period: 5, mitigation_timeout: 10 },
  },
];
const isOurs = (r) => String(r.description || '').startsWith('cfmail:');

async function cf(method, path, body) {
  const res = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.success !== false, status: res.status, data };
}

for (const name of DOMAINS) {
  const z = await cf('GET', `/zones?name=${encodeURIComponent(name)}`);
  const zone = z.data.result?.[0];
  if (!zone) { console.log(`✗ ${name}: no such zone`); continue; }

  // The current entrypoint ruleset (may not exist yet); anything not ours is preserved.
  const cur = await cf('GET', `/zones/${zone.id}/rulesets/phases/http_ratelimit/entrypoint`);
  const existing = (cur.data.result?.rules || []).filter((r) => !isOurs(r));
  const merged = [
    ...existing.map((r) => ({
      description: r.description,
      expression: r.expression,
      action: r.action,
      ...(r.ratelimit ? { ratelimit: r.ratelimit } : {}),
      ...(r.action_parameters ? { action_parameters: r.action_parameters } : {}),
    })),
    ...OUR_RULES,
  ];

  const put = await cf('PUT', `/zones/${zone.id}/rulesets/phases/http_ratelimit/entrypoint`, { rules: merged });
  if (put.ok) {
    console.log(`✓ ${name}: ${put.data.result.rules.length} rate-limit rules now (${existing.length} kept + ${OUR_RULES.length} from cfmail)`);
  } else {
    console.log(`✗ ${name}: PUT failed ${put.status} -- ${JSON.stringify((put.data.errors || []).map((e) => e.message)).slice(0, 200)}`);
  }
}
