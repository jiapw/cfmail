#!/usr/bin/env node
// Create (or reuse) a Turnstile widget and push its secret straight into the Worker's
// TURNSTILE_SECRET. Only the public sitekey is printed; the secret is never shown or written to disk.
// 创建(或复用)一个 Turnstile widget,把 secret 直接灌进 Worker 的 TURNSTILE_SECRET,
// 只在终端打印公开的 sitekey。secret 全程不显示、不落盘。
//
// Prerequisite: the token needs Account - Turnstile Sites - Edit (that is the name the
// dashboard uses), plus Workers Scripts: Edit for `secret put`. Allow ~1 minute to take effect.
// Usage:  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/setup-turnstile.mjs
//   (in PowerShell, load both variables from .env.deploy first)
// 前置:token 需含 Account · Turnstile Sites · Edit(Dashboard 权限列表里叫 "Turnstile Sites";
//       另需部署用的 Workers Scripts:Edit 才能 secret put)。改完权限约 1 分钟后生效。
// 用法:  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/setup-turnstile.mjs
//   (PowerShell 里先 . .env.deploy 载入两个变量,或直接 set-a 后 source)

import { spawnSync } from 'node:child_process';
import { entryHosts } from './wrangler-config.mjs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const NAME = 'CFMail';
// Which domains the widget covers: taken from the entry custom domains in wrangler.jsonc, never hardcoded.
// widget 绑定哪些域名:直接取 wrangler.jsonc 里的入口自定义域,不硬编码
const DOMAINS = entryHosts();

if (!TOKEN || !ACCOUNT) {
  console.error('✗ 缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID');
  process.exit(1);
}
if (!DOMAINS.length) {
  console.error('✗ wrangler.jsonc 的 routes 里没有 custom_domain,无处绑定 widget');
  process.exit(1);
}

async function cf(method, path, body) {
  const res = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.success !== false, status: res.status, data };
}

// 1) Is there already a widget with this name? Reuse it and rotate the secret; otherwise create one.
// 1) 有没有同名 widget:有就轮换 secret 拿一份可用的;没有就新建
const list = await cf('GET', `/accounts/${ACCOUNT}/challenges/widgets`);
if (!list.ok) {
  const msg = (list.data.errors || []).map((e) => `${e.code}:${e.message}`).join('; ');
  console.error(`✗ 访问 Turnstile 失败(${list.status}):${msg}`);
  if (/1000|9109|authentication|not authorized|permission/i.test(msg)) {
    console.error('  → token 缺少 Account · Turnstile · Edit 权限,请补上后重跑。');
  }
  process.exit(1);
}
const existing = (list.data.result || []).find((w) => w.name === NAME);

let sitekey, secret;
if (existing) {
  sitekey = existing.sitekey;
  const rot = await cf('POST', `/accounts/${ACCOUNT}/challenges/widgets/${sitekey}/rotate_secret`, { invalidate_immediately: true });
  if (!rot.ok) { console.error('✗ 轮换 secret 失败:', JSON.stringify(rot.data.errors || rot.data).slice(0, 200)); process.exit(1); }
  secret = rot.data.result.secret;
  console.log(`✓ 复用已有 widget「${NAME}」,已轮换出新 secret`);
} else {
  const cr = await cf('POST', `/accounts/${ACCOUNT}/challenges/widgets`, { name: NAME, domains: DOMAINS, mode: 'managed' });
  if (!cr.ok) { console.error('✗ 创建 widget 失败:', JSON.stringify(cr.data.errors || cr.data).slice(0, 200)); process.exit(1); }
  sitekey = cr.data.result.sitekey;
  secret = cr.data.result.secret;
  console.log(`✓ 已创建 widget「${NAME}」,域名:${DOMAINS.join(', ')}`);
}

// 2) Push the secret into the Worker, over stdin so it is never printed.
// 2) 把 secret 灌进 Worker(经 stdin,不打印)
const put = spawnSync('npx', ['wrangler', 'secret', 'put', 'TURNSTILE_SECRET'], {
  input: secret + '\n',
  env: process.env,
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: process.platform === 'win32',
});
if (put.status !== 0) {
  console.error('✗ wrangler secret put 失败,请手动执行:  npx wrangler secret put TURNSTILE_SECRET  再粘贴 secret');
  process.exit(1);
}

console.log('\n完成。把下面这行 sitekey 发给 Claude(它是公开值,可写进配置):');
console.log(`\n  TURNSTILE_SITEKEY = ${sitekey}\n`);
