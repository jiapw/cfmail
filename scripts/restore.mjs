#!/usr/bin/env node
// Put a backup back. Reads one dated copy out of the backup bucket and writes it into the
// database and the mail bucket of the deployment you point it at.
//
//   node scripts/restore.mjs --token <API token> --from daily/2026-08-24 [--into <目标>] [--dry-run]
//
// The backup holds rows as gzipped NDJSON, one file per table (split into parts), plus a pool of
// message bytes under mail/. Rows come back first, in the order the dump wrote them, so nothing
// ever references a row that is not there yet; the message bytes come back afterwards, and only
// the ones the restored rows actually name.
//
// WHAT IT DOES NOT DO
// It does not recreate the deployment: no Worker, no DNS, no mail routing, no secrets. Point it at
// a deployment that already exists and works. It also never deletes: rows are written with INSERT
// OR REPLACE, so restoring on top of a live database repairs what is missing and overwrites what
// collides, and leaves anything newer alone.
//
// 把一份备份放回去。从备份桶里读某一份带日期的副本,写进你指定的那套部署的数据库和邮件桶。
//
// 备份里,行数据是按表分文件的 gzip NDJSON(大表再分片),邮件字节在 mail/ 这个池子里。
// 先回填行,顺序与导出时一致,于是不会出现"引用了一行还不存在的数据";
// 邮件字节随后回填,而且只回填那些被还原出来的行真正指名的对象。
//
// 它不做什么
// 它不重建部署:不建 Worker、不配 DNS、不设收发信、不写 secret。请指向一套已经存在并且能跑的部署。
// 它也从不删除:行用 INSERT OR REPLACE 写入,所以对着一个活着的库恢复,是补上缺的、覆盖撞车的,
// 更新的东西原样留着。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BK_BUCKET = 'cfmail-backup';
const RAW_BUCKET = 'cfmail-raw';
const D1_NAME = 'cfmail';

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.from) usage(args.help ? 0 : 1);
const TOKEN = args.token || process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) die('缺少 API token(--token,或环境变量 CLOUDFLARE_API_TOKEN)');
const DRY = !!args['dry-run'];
const FROM = String(args.from).replace(/\/+$/, '') + '/';
const CONFIG = args.config ? path.resolve(args.config) : null;

function usage(code) {
  console.log(`
用法 / Usage:
  node scripts/restore.mjs --token <API token> --from <备份路径> [选项]

  --from <p>     要恢复哪一份,例如 daily/2026-08-24 / monthly/2026-06 / yearly/2025
  --token <t>    Cloudflare API token;也可放在环境变量 CLOUDFLARE_API_TOKEN 里
  --config <f>   指定 wrangler 配置文件(部署到第二个账号时用 wrangler.acct-<id>.jsonc)
  --tables <a,b> 只恢复这几张表(默认全部)
  --skip-mail    只恢复数据库行,不回填邮件原件
  --dry-run      只报告将要恢复什么,不写入

  先用 --dry-run 看一眼:它会列出这份备份里有哪些表、各多少行、要回填多少个邮件对象。
`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

function die(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}
const step = (s) => console.log('\n▸ ' + s);
const log = (s) => console.log('  ' + s);

function wranglerBin() {
  const bin = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!fs.existsSync(bin)) die('找不到 wrangler,先运行:npm install');
  return bin;
}

function wrangler(argv, { capture = false } = {}) {
  const full = CONFIG ? [...argv, '-c', CONFIG] : argv;
  const r = spawnSync(process.execPath, [wranglerBin(), ...full], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, CI: 'true' },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) die('无法启动 wrangler:' + r.error.message);
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

/** One object out of a bucket, as a Buffer / 从桶里取一个对象,返回 Buffer */
function getObject(bucket, key) {
  const tmp = path.join(ROOT, `.restore.tmp`);
  const r = wrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--file', tmp, '--remote'], { capture: true });
  if (r.code !== 0 || !fs.existsSync(tmp)) return null;
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf;
}

function putObject(bucket, key, buf) {
  const tmp = path.join(ROOT, `.restore.tmp`);
  fs.writeFileSync(tmp, buf);
  const r = wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--file', tmp, '--remote'], { capture: true });
  fs.unlinkSync(tmp);
  return r.code === 0;
}

// ---------------------------------------------------------------------------

console.log('\n=== CFMail 恢复 ===');
if (DRY) console.log('    (--dry-run:只报告,不写入)');

step(`读取清单 ${FROM}manifest.json`);
const mBuf = getObject(BK_BUCKET, FROM + 'manifest.json');
if (!mBuf) die(`取不到 ${FROM}manifest.json —— 确认 --from 写对了,且这个账号里有 ${BK_BUCKET} 桶`);
const manifest = JSON.parse(mBuf.toString('utf8'));
log(`这份备份属于 ${manifest.day || manifest.month || '?'},完成于 ${new Date(manifest.finishedAt || 0).toISOString()}`);

const only = args.tables ? String(args.tables).split(',').map((x) => x.trim()).filter(Boolean) : null;
const tables = Object.entries(manifest.tables || {}).filter(([t]) => !only || only.includes(t));
if (!tables.length) die('清单里没有可恢复的表');

step('数据库行');
let totalRows = 0;
for (const [table, parts] of tables) {
  const rows = [];
  for (let i = 0; i < parts; i++) {
    const key = `${FROM}rows/${table}.${String(i).padStart(4, '0')}.ndjson.gz`;
    const buf = getObject(BK_BUCKET, key);
    if (!buf) die(`缺少分片 ${key} —— 这份备份不完整,已中止(还没有写入任何东西)`);
    const text = zlib.gunzipSync(buf).toString('utf8');
    for (const line of text.split('\n')) if (line.trim()) rows.push(JSON.parse(line));
  }
  totalRows += rows.length;
  if (DRY) {
    log(`${table.padEnd(16)} ${String(rows.length).padStart(7)} 行`);
    continue;
  }
  if (!rows.length) { log(`${table.padEnd(16)}       0 行`); continue; }
  // One file of statements per table, fed to wrangler in one go: a row at a time over the API
  // would take hours for a mailbox of any size.
  // 每张表写一个语句文件,一次性交给 wrangler:逐行走 API 的话,稍大的邮箱要跑上几个小时。
  const cols = Object.keys(rows[0]);
  const lines = rows.map((r) => {
    const vals = cols.map((c) => sqlValue(r[c])).join(',');
    return `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${vals});`;
  });
  const file = path.join(ROOT, `.restore.${table}.sql`);
  fs.writeFileSync(file, lines.join('\n'));
  const r = wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', file, '-y'], { capture: true });
  fs.unlinkSync(file);
  if (r.code !== 0) die(`写入 ${table} 失败:\n${r.out.slice(-800)}`);
  log(`${table.padEnd(16)} ${String(rows.length).padStart(7)} 行 ✓`);
}
log(`合计 ${totalRows} 行`);

if (!args['skip-mail']) {
  step('邮件原件');
  // Only what the restored rows name. The pool holds every message this deployment ever had,
  // including ones deleted long before the day being restored.
  // 只回填被还原出来的行指名的那些。池子里装着这套部署有过的每一封信,
  // 包括那些在被恢复的那一天之前很久就删掉的。
  const keys = new Set();
  for (const [table, parts] of tables) {
    if (!['messages', 'unrouted', 'outbox', 'uploads'].includes(table)) continue;
    for (let i = 0; i < parts; i++) {
      const buf = getObject(BK_BUCKET, `${FROM}rows/${table}.${String(i).padStart(4, '0')}.ndjson.gz`);
      if (!buf) continue;
      for (const line of zlib.gunzipSync(buf).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        const k = JSON.parse(line).r2_key;
        if (k) keys.add(k);
      }
    }
  }
  log(`需要回填 ${keys.size} 个对象`);
  if (!DRY) {
    let done = 0;
    let missing = 0;
    for (const k of keys) {
      const buf = getObject(BK_BUCKET, `mail/${k}`);
      if (!buf) { missing++; continue; }
      if (putObject(RAW_BUCKET, k, buf)) done++;
      if (done % 100 === 0) log(`  …${done}/${keys.size}`);
    }
    log(`回填 ${done} 个,池子里找不到 ${missing} 个`);
  }
}

if (!DRY) {
  step('重建全文索引');
  const r = wrangler(['d1', 'execute', D1_NAME, '--remote', '-y', '--command',
    "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"], { capture: true });
  log(r.code === 0 ? '已重建' : '⚠ 重建失败,可稍后手动执行同一条语句');
}

console.log(DRY ? '\n--dry-run 到此为止,没有写入任何东西。\n' : '\n完成。\n');

/** SQLite literal. Numbers stay numbers; everything else is a quoted string, and NULL is NULL --
 *  an empty string is not the same value and must not become one.
 *  SQLite 字面量。数字仍是数字;其余引号包起来;NULL 就是 NULL ——
 *  空串是另一个值,不能混成一个。 */
function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}
