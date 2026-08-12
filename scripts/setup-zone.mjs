#!/usr/bin/env node
// Connect a domain that already lives in your Cloudflare account to cfmail:
//   1. enable Email Routing (MX/SPF records publish automatically)
//   2. point the catch-all rule at the cfmail Worker
//   3. bind <entry-subdomain>.<domain> as a custom domain (web entry and invite links)
// 把一个已在 Cloudflare 账号里的域名接入 cfmail:
//   1. 启用 Email Routing(自动下发 MX/SPF 记录)
//   2. catch-all 规则指向 cfmail Worker
//   3. 绑定 intl-mail.<域名> 自定义域到 cfmail Worker(邀请链接/网页入口)
//
// Usage:
//   CLOUDFLARE_API_TOKEN=xxx node scripts/setup-zone.mjs example.com
//   (PowerShell: $env:CLOUDFLARE_API_TOKEN="xxx"; node scripts/setup-zone.mjs example.com)
// 用法:

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WORKER = process.env.CFMAIL_WORKER || 'cfmail';
const domain = process.argv[2];

if (!TOKEN) die('缺少环境变量 CLOUDFLARE_API_TOKEN');
if (!domain) die('用法: node scripts/setup-zone.mjs <domain>');

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
// 4. mail.<domain> 自定义域绑定 Worker
if (accountId) {
  const host = `intl-mail.${domain}`;
  const cd = await cf('PUT', `/accounts/${accountId}/workers/domains`, {
    zone_id: zoneId,
    hostname: host,
    service: WORKER,
    environment: 'production',
  });
  if (cd.ok) log(`自定义域 ${host} 已绑定`);
  else log(`绑定 ${host} 失败(${cd.status}):${JSON.stringify(cd.data.errors || cd.data).slice(0, 200)}(可在 Workers → cfmail → Domains 手动添加)`);
} else {
  log('未取到 account id,跳过自定义域绑定,请手动添加 intl-mail.' + domain);
}

console.log(`\n完成。别忘了在 CFMail 管理后台「域名与邮箱」里添加 ${domain} 并创建邮箱。\n`);
