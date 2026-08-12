#!/usr/bin/env node
// Push CFMail's edge rate-limit rules into the http_ratelimit entrypoint ruleset of every zone.
// Idempotent: rules whose description starts with "cfmail:" are cleared first, so repeated runs never stack.
// 把 CFMail 的边缘限速规则推到全部 zone 的 http_ratelimit 入口 ruleset。
// 幂等:凡 description 以 "cfmail:" 开头的旧规则先清掉再写入当前这套,反复运行不会叠加。
//
// Prerequisite: the token needs Zone - Zone WAF - Edit on every relevant zone.
// Usage:  set -a; . ./.env.deploy; set +a; node scripts/push-ratelimit.mjs
// 前置:token 需含 Zone · Zone WAF · Edit(全部相关 zone)。
// 用法:  set -a; . ./.env.deploy; set +a; node scripts/push-ratelimit.mjs
//
// Free-plan hard limits (learned the hard way):
//   - one rate-limit rule per zone, so every sensitive endpoint folds into a single rule
//   - the counting window can only be 10 seconds, and so can mitigation_timeout
//   - characteristics must include cf.colo.id (counting happens per colocation)
// Paid zones allow several rules and windows up to 60s, but for consistency every zone gets the same one.
// 免费版硬限制(踩过的坑):
//   - 每 zone 只能有 1 条限速规则 → 所有敏感接口合成一条
//   - 计数窗口只能 10 秒,mitigation_timeout 也只能 10 秒
//   - characteristics 必须带 cf.colo.id(计数在机房级别做)
// 付费 zone 能建多条、窗口可到 60s,但为一致性所有 zone 统一用同一条规则。

import { zoneNames } from './wrangler-config.mjs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
// Which zones to act on: derived from the entry custom domains in wrangler.jsonc, never hardcoded.
// 作用于哪些 zone:从 wrangler.jsonc 的入口自定义域推导,不硬编码
const DOMAINS = zoneNames();

if (!TOKEN) { console.error('✗ 缺少 CLOUDFLARE_API_TOKEN'); process.exit(1); }
if (!DOMAINS.length) { console.error('✗ wrangler.jsonc 的 routes 里没有 custom_domain'); process.exit(1); }

// Login / reset / invite signup / invite verify: 5 requests per IP per 10s, then block for 10s.
// 登录 / 重置 / 邀请注册 / 邀请验证:每 IP 5 次/10 秒,超限 block 10 秒
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
  if (!zone) { console.log(`✗ ${name}: 找不到 zone`); continue; }

  // The current entrypoint ruleset (may not exist yet); anything not ours is preserved.
  // 现有入口 ruleset(可能不存在);保留非 cfmail 的既有规则
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
    console.log(`✓ ${name}: 现在 ${put.data.result.rules.length} 条限速规则(保留旧 ${existing.length} + cfmail ${OUR_RULES.length})`);
  } else {
    console.log(`✗ ${name}: PUT 失败 ${put.status} — ${JSON.stringify((put.data.errors || []).map((e) => e.message)).slice(0, 200)}`);
  }
}
