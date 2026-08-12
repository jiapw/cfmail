#!/usr/bin/env node
// Connect a domain that already lives in your Cloudflare account to cfmail:
//   1. enable Email Routing (MX/SPF records publish automatically)
//   2. point the catch-all rule at the cfmail Worker
//   3. bind <entry-subdomain>.<domain> as a custom domain (web entry and invite links)
//      and add it to "routes" in wrangler.jsonc so the next deploy keeps it
// 把一个已在 Cloudflare 账号里的域名接入 cfmail:
//   1. 启用 Email Routing(自动下发 MX/SPF 记录)
//   2. catch-all 规则指向 cfmail Worker
//   3. 绑定 <入口子域>.<域名> 自定义域到 cfmail Worker(邀请链接/网页入口),
//      并写进 wrangler.jsonc 的 routes,下次部署才不会被摘掉
//
// The entry subdomain comes from "routes" in wrangler.jsonc -- whatever prefix is already
// there is reused, so every domain gets the same one. Pass a second argument to override it --
// that is also how you choose it the very first time, when routes is still empty.
// 入口子域取自 wrangler.jsonc 的 routes —— 已有什么前缀就沿用什么,保证各域名一致。
// 想换成别的,加第二个参数;第一次接域名时 routes 还是空的,也正是这么指定的。
//
// Usage:
//   CLOUDFLARE_API_TOKEN=xxx node scripts/setup-zone.mjs example.com [entry-subdomain]
//   (PowerShell: $env:CLOUDFLARE_API_TOKEN="xxx"; node scripts/setup-zone.mjs example.com)
// 用法:同上,PowerShell 用 $env: 设环境变量。

import { entrySubdomain, entryHosts, readWranglerText, withEntryRoute, writeWranglerConfig } from './wrangler-config.mjs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WORKER = process.env.CFMAIL_WORKER || 'cfmail';
const domain = process.argv[2];

if (!TOKEN) die('缺少环境变量 CLOUDFLARE_API_TOKEN');
if (!domain) die('用法: node scripts/setup-zone.mjs <domain> [入口子域]');

const PREFIX = process.argv[3] || entrySubdomain();
if (!PREFIX) {
  die('wrangler.jsonc 的 routes 还是空的,推导不出入口子域。\n' +
      '  第一次接域名时用第二个参数指定一次,之后就不用再写了:\n' +
      '    node scripts/setup-zone.mjs ' + domain + ' mail   →  https://mail.' + domain);
}
if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(PREFIX)) die(`入口子域 "${PREFIX}" 不是合法的 DNS 标签`);

const API = 'https://api.cloudflare.com/client/v4';

async function cf(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data.success !== false, data };
}

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

const log = (s) => console.log('  ' + s);

console.log(`\n== 接入域名 ${domain} → Worker "${WORKER}" ==\n`);

// 1. Find the zone
// 1. 找 zone
const zones = await cf('GET', `/zones?name=${encodeURIComponent(domain)}`);
const zone = zones.data.result?.[0];
if (!zone) die(`找不到 zone "${domain}",请确认该域名已添加到这个 Cloudflare 账号`);
const zoneId = zone.id;
const accountId = zone.account?.id;
log(`zone: ${zoneId} (账号 ${zone.account?.name || accountId})`);

// 2. Email Routing status, and enable it if needed
// 2. Email Routing 状态与启用
const st = await cf('GET', `/zones/${zoneId}/email/routing`);
if (st.ok && st.data.result?.enabled) {
  log('Email Routing 已启用');
} else {
  const en = await cf('POST', `/zones/${zoneId}/email/routing/enable`);
  if (en.ok) log('Email Routing 已启用(MX/SPF 记录已自动下发)');
  else {
    log(`自动启用失败(${en.status}):${JSON.stringify(en.data.errors || en.data).slice(0, 300)}`);
    log('请在 Dashboard → 该域名 → Email → Email Routing 手动点击启用,然后重跑本脚本');
  }
}

// 3. catch-all -> worker
// 3. catch-all → worker
const ca = await cf('PUT', `/zones/${zoneId}/email/routing/rules/catch_all`, {
  name: `catch-all to ${WORKER}`,
  enabled: true,
  matchers: [{ type: 'all' }],
  actions: [{ type: 'worker', value: [WORKER] }],
});
if (ca.ok) log(`catch-all 已指向 Worker "${WORKER}"`);
else die(`设置 catch-all 失败:${JSON.stringify(ca.data.errors || ca.data).slice(0, 300)}`);

// 4. Bind the entry custom domain to the Worker
// 4. <入口子域>.<domain> 自定义域绑定 Worker
const host = `${PREFIX}.${domain}`;
if (accountId) {
  const cd = await cf('PUT', `/accounts/${accountId}/workers/domains`, {
    zone_id: zoneId,
    hostname: host,
    service: WORKER,
    environment: 'production',
  });
  if (cd.ok) log(`自定义域 ${host} 已绑定`);
  else log(`绑定 ${host} 失败(${cd.status}):${JSON.stringify(cd.data.errors || cd.data).slice(0, 200)}(可在 Workers → cfmail → Domains 手动添加)`);
} else {
  log(`未取到 account id,跳过自定义域绑定,请手动添加 ${host}`);
}

// 5. Record it in wrangler.jsonc. `wrangler deploy` reconciles custom domains against
//    "routes", so a domain that is bound via the API but missing from the file would be
//    detached again on the next deploy.
// 5. 记进 wrangler.jsonc。wrangler deploy 会拿 routes 跟线上自定义域对账,
//    只在 API 上绑了、文件里没写的域名,下次部署就会被摘掉。
if (entryHosts().includes(host)) {
  log(`wrangler.jsonc 的 routes 里已有 ${host}`);
} else {
  const cfg = withEntryRoute(readWranglerText(), host);
  const manually = `请手动在 routes 里加一条:{ "pattern": "${host}", "custom_domain": true }`;
  if (!cfg) {
    log('✗ wrangler.jsonc 里找不到 routes,' + manually);
  } else {
    const bad = writeWranglerConfig(cfg, (p) =>
      (p?.routes || []).some((r) => r?.pattern === host && r.custom_domain));
    if (bad) log(`✗ 改写 wrangler.jsonc 会产生非法配置,已放弃改动(${bad}),${manually}`);
    else log(`已写入 wrangler.jsonc 的 routes:${host}`);
  }
}

console.log(`\n完成。下一步:npm run deploy,然后在 CFMail 管理后台「域名与邮箱」里添加 ${domain} 并创建邮箱。\n`);
