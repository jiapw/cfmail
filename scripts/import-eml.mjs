#!/usr/bin/env node
// Bulk-import .eml files exported from an old provider into CFMail.
// The source is an unzipped export directory; its structure mirrors the original mailbox folders.
// 把旧邮箱导出的 .eml 批量导入 CFMail。
// 数据源是 Zoho 管理控制台的 ZIP 导出解压后的目录(目录结构 = 原邮箱的文件夹结构)。
//
// Usage:
//        --base https://mail.example.com --cookie "sid=xxxxx"
// 用法:
//   node scripts/import-eml.mjs --dir <解压后的目录> --mailbox someone@example.com \
//
// Arguments:
//   --dir       directory holding the .eml files, traversed recursively
//   --mailbox   target company address (must already exist in the admin console)
//   --base      CFMail entry URL
//   --cookie    an admin session cookie (the sid value from DevTools > Application > Cookies)
//   --map       folder mapping such as "Inbox=inbox,Sent=sent"; unmatched folders use --default
//   --default   where unmapped folders land, default inbox
//   --dry       count only, upload nothing -- useful to preview where things would go
//   --limit     stop after N messages (for a trial run)
// 参数:
//   --dir       .eml 所在目录,会递归遍历
//   --mailbox   目标企业邮箱地址(必须已在后台创建)
//   --base      CFMail 入口地址
//   --cookie    管理员会话 cookie(浏览器 DevTools → Application → Cookies 里的 sid)
//   --map       文件夹映射,形如 "Inbox=inbox,Sent=sent,已发送=sent",不匹配的落到 --default
//   --default   未命中映射时的去处,默认 inbox
//   --dry       只统计不上传,先看看会往哪儿放
//   --limit     最多导入多少封(试水用)
//
// Interrupted? Just run it again -- the server deduplicates by Message-ID, so nothing doubles up.
// 断了直接重跑:服务端按 Message-ID 去重,不会产生副本。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const DIR = args.dir;
const MAILBOX = args.mailbox;
const BASE = (args.base || 'https://mail.example.com').replace(/\/$/, '');
const COOKIE = args.cookie;
const DEFAULT_FOLDER = args.default || 'inbox';
const DRY = 'dry' in args;
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;

if (!DIR || !MAILBOX || (!COOKIE && !DRY)) {
  console.error('用法: node scripts/import-eml.mjs --dir <目录> --mailbox <地址> --cookie "sid=..." [--base <url>] [--map "Inbox=inbox,..."] [--dry] [--limit N]');
  process.exit(1);
}

// Default mapping from common Zoho/Outlook folder names to our roles. --map extends or overrides it.
// Keep this in sync with FOLDER_MAP in public/assets/admin-import.js -- change both together.
// 默认映射:Zoho/Outlook 常见文件夹名(简繁中英)→ 我们的角色。--map 可以追加/覆盖。
// 与浏览器端 public/assets/admin-import.js 的 FOLDER_MAP 保持一致(两处改动请同步)。
const MAP = {
  inbox: 'inbox', '收件箱': 'inbox', '收件夾': 'inbox',
  sent: 'sent', 'sent items': 'sent', 'sent mail': 'sent',
  '已发送': 'sent', '已發送': 'sent', '已发邮件': 'sent', '寄件備份': 'sent',
  drafts: 'drafts', draft: 'drafts', '草稿': 'drafts', '草稿箱': 'drafts',
  archive: 'archive', archives: 'archive', '归档': 'archive', '封存': 'archive',
  spam: 'spam', junk: 'spam', 'junk email': 'spam', '垃圾邮件': 'spam', '垃圾郵件': 'spam',
  trash: 'trash', deleted: 'trash', 'deleted items': 'trash', '已删除': 'trash', '回收站': 'trash',
};
for (const pair of (args.map || '').split(',').filter(Boolean)) {
  const [k, v] = pair.split('=');
  if (k && v) MAP[k.trim().toLowerCase()] = v.trim();
}

/** Decide which folder a file belongs to from the first segment of its relative path.
 *  用相对路径的第一段判断属于哪个文件夹 */
function folderOf(relPath) {
  const parts = relPath.split(sep).slice(0, -1);
  for (const p of parts) {
    const hit = MAP[p.trim().toLowerCase()];
    if (hit) return hit;
  }
  return DEFAULT_FOLDER;
}

/** The header alone is enough: Message-ID, plus a couple of headers that may carry read state.
 *  只读头部就够了:Message-ID 和几个可能带已读状态的头 */
function peekHeaders(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 16384)).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  const h = end > 0 ? head.slice(0, end) : head;
  const grab = (name) => {
    const m = new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)$`, 'im').exec(h);
    return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
  };
  const messageId = (grab('message-id').match(/<[^>]+>/) || [''])[0];
  // .eml carries no IMAP flags of its own, but some exports write these two headers.
  // .eml 本身不带 IMAP 标记,但有些导出会写这两个头
  const status = grab('status') + ' ' + grab('x-status');
  const moz = grab('x-mozilla-status');
  // 导入一律按已读入库,所以旧标记里只取星标 / imports always arrive read; only the star is read out
  let flagged = null;
  if (status.trim()) flagged = /F/.test(status);
  if (moz) { const n = parseInt(moz, 16); if (!Number.isNaN(n)) flagged = !!(n & 0x4); }
  return { messageId, flagged };
}

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.eml$/i.test(e.name)) yield p;
  }
}

const stats = { total: 0, ok: 0, dup: 0, fail: 0, bytes: 0, byFolder: {} };
const failures = [];

const root = await stat(DIR).catch(() => null);
if (!root?.isDirectory()) { console.error('✗ 目录不存在: ' + DIR); process.exit(1); }

console.log(`\n== 导入 ${DIR} → ${MAILBOX} @ ${BASE} ==${DRY ? '  (dry run)' : ''}\n`);

for await (const file of walk(DIR)) {
  if (stats.total >= LIMIT) break;
  stats.total++;
  const rel = relative(DIR, file);
  const folder = folderOf(rel);
  stats.byFolder[folder] = (stats.byFolder[folder] || 0) + 1;

  const buf = await readFile(file);
  stats.bytes += buf.length;
  const { messageId, flagged } = peekHeaders(buf);

  if (DRY) {
    if (stats.total <= 20) console.log(`  ${folder.padEnd(8)} ${rel}`);
    continue;
  }

  const q = new URLSearchParams({ mailbox: MAILBOX, folder });
  // Exported mail rarely carries read state; default to read so hundreds do not land unread.
  // 导出件普遍不带已读标记,默认按已读进,免得一进来几百封未读
  if (flagged) q.set('flagged', '1');
  if (messageId) q.set('message_id', messageId);

  try {
    const res = await fetch(`${BASE}/api/admin/import?${q}`, {
      method: 'POST',
      headers: { Cookie: COOKIE, 'Content-Type': 'message/rfc822', Origin: BASE },
      body: buf,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    if (j.skipped) stats.dup++; else stats.ok++;
  } catch (e) {
    stats.fail++;
    failures.push(`${rel}: ${e.message}`);
  }
  if (stats.total % 50 === 0) process.stdout.write(`  已处理 ${stats.total}(新增 ${stats.ok} / 重复 ${stats.dup} / 失败 ${stats.fail})\r`);
}

console.log('\n');
console.log('  文件夹分布:', Object.entries(stats.byFolder).map(([k, v]) => `${k}=${v}`).join('  '));
console.log(`  总计 ${stats.total} 封,${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);
if (!DRY) console.log(`  新增 ${stats.ok},跳过重复 ${stats.dup},失败 ${stats.fail}`);
if (failures.length) {
  console.log('\n  失败明细(前 20 条):');
  failures.slice(0, 20).forEach((f) => console.log('   - ' + f));
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    o[k] = v;
  }
  return o;
}
