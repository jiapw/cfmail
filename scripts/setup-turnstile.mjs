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
import { entryHosts, readWranglerText, writeWranglerConfig } from './wrangler-config.mjs';

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

// 3) Write the sitekey into wrangler.jsonc under vars. It is a public value, so it
//    belongs in the config rather than in a secret -- and doing it here means nobody
//    has to copy and paste it by hand.
// 3) 把 sitekey 写进 wrangler.jsonc 的 vars。它是公开值,本来就该放配置里;
//    脚本自己写,省得用户手动粘贴。
const original = readWranglerText();
const LINE = `    "TURNSTILE_SITEKEY": "${sitekey}"`;
let cfg;

// One code path: drop any existing entry (live or commented -- the template ships it
// commented), then append a fresh one. Doing it in two steps means the comma handling
// below is the only place that has to be right.
// 统一走一条路径:先把已有的那行删掉(可能是生效的,也可能是注释状态 —— 模板里就是注释),
// 再统一追加一行。这样"补逗号"的逻辑只有一处,不会两个分支各错一半。
const EXISTING = /^[ \t]*(?:\/\/[ \t]*)?"TURNSTILE_SITEKEY"[ \t]*:.*(\r?\n)?/m;
const stripped = original.replace(EXISTING, '');

const m = /("vars"\s*:\s*\{)([\s\S]*?)(\n[ \t]*\})/.exec(stripped);
if (!m) {
  console.error('✗ wrangler.jsonc 里找不到 vars 段,请手动加一行:');
  console.error(`  "TURNSTILE_SITEKEY": "${sitekey}"`);
  process.exit(1);
}
const lines = m[2].split('\n');
// Walk back to the last real entry (skipping blanks and comments) and give it a comma.
// The template leaves DEV_MODE without one precisely because the next line is commented out.
// 从后往前找最后一个"有内容且不是注释"的行给它补逗号 —— 模板里 DEV_MODE 正是因为
// 下一行被注释掉了才没有逗号。
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
  console.error('✗ 改写 wrangler.jsonc 会产生非法配置,已放弃改动:' + bad);
  console.error(`  请手动在 vars 里加一行:  "TURNSTILE_SITEKEY": "${sitekey}"`);
  process.exit(1);
}

console.log(`\n✓ sitekey 已写入 wrangler.jsonc:${sitekey}`);
console.log('  下一步:npm run deploy —— 部署后人机验证即生效。');
