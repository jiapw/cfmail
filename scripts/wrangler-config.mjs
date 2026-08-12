// Reads deployment configuration out of wrangler.jsonc, shared by every script here.
// wrangler.jsonc is not committed (it carries each operator's own account_id and domains),
// so no script may hardcode a domain -- everything is derived here and acts on whoever deployed it.
// 从 wrangler.jsonc 读部署配置,给各脚本共用。
// wrangler.jsonc 不入库(含各自的 account_id 和域名),所以脚本里不能硬编码任何域名 ——
// 一律从这里推导,谁部署就作用于谁的域名。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');

/** JSONC -> JSON: strip comments and trailing commas. A // inside a string must survive, so scan with state.
 *  JSONC → JSON:去掉注释和尾逗号。字符串里的 // 不能误伤,所以要带状态扫一遍 */
export function stripJsonc(src) {
  let out = '';
  let inStr = false;
  let quote = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[++i] ?? ''; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function loadWranglerConfig() {
  if (!fs.existsSync(CONFIG)) {
    console.error('✗ 找不到 wrangler.jsonc。先复制模板:cp wrangler.example.jsonc wrangler.jsonc');
    process.exit(1);
  }
  try {
    return JSON.parse(stripJsonc(fs.readFileSync(CONFIG, 'utf8')));
  } catch (e) {
    console.error('✗ wrangler.jsonc 解析失败:' + e.message);
    process.exit(1);
  }
}

/** Raw text of wrangler.jsonc, comments and all. For the scripts that rewrite it in place.
 *  wrangler.jsonc 的原始文本(含注释),给需要就地改写它的脚本用 */
export function readWranglerText() {
  if (!fs.existsSync(CONFIG)) {
    console.error('✗ 找不到 wrangler.jsonc。先复制模板:cp wrangler.example.jsonc wrangler.jsonc');
    process.exit(1);
  }
  return fs.readFileSync(CONFIG, 'utf8');
}

/**
 * Write wrangler.jsonc, but never write something we cannot read back. A broken config means
 * no deploys, and the file is not in git, so there would be nothing to restore from.
 * `verify(parsed)` should return true if the intended change is actually in there.
 * Returns null on success, or the reason it refused to write.
 *
 * 写 wrangler.jsonc,但绝不写出一个自己都读不回来的配置 —— 它一坏就没法部署,
 * 而且不在 git 里,坏了没地方恢复。verify(parsed) 用来确认改动确实写进去了。
 * 成功返回 null,拒绝写入则返回原因。
 */
export function writeWranglerConfig(text, verify) {
  try {
    const parsed = JSON.parse(stripJsonc(text));
    if (verify && !verify(parsed)) return '写入后读不回预期的值';
  } catch (e) {
    return e.message;
  }
  fs.writeFileSync(CONFIG, text);
  return null;
}

/** Entry custom domains, e.g. ["mail.example.com"] -- the routes flagged custom_domain.
 *  入口自定义域,如 ["mail.example.com"] —— routes 里 custom_domain 的那些 */
export function entryHosts(cfg = loadWranglerConfig()) {
  return (cfg.routes || [])
    .filter((r) => r && r.custom_domain && typeof r.pattern === 'string')
    .map((r) => r.pattern);
}

/**
 * The entry subdomain -- the leftmost label of the entry hosts, e.g. "mail" for mail.example.com.
 * routes is the single source of truth for it; the untouched template still holds a
 * <placeholder>, in which case there is nothing to derive and the caller decides.
 * 入口子域,即入口域最左边那一段(mail.example.com → "mail")。
 * 以 routes 为唯一来源;模板没填时那里还是 <占位符>,推导不出来,交给调用方决定。
 */
export function entrySubdomain(cfg = loadWranglerConfig()) {
  for (const host of entryHosts(cfg)) {
    const label = host.split('.')[0];
    if (label && !label.includes('<') && host.includes('.')) return label;
  }
  return null;
}

/**
 * Add an entry custom domain to the "routes" array, working on the raw text so comments survive.
 * The untouched template ships one <placeholder> route -- that line is meant to be replaced,
 * not to gain a sibling, so any pattern still containing <> is dropped.
 * Returns the new text, or null if there is no routes array to write into.
 *
 * 往 routes 里加一条入口自定义域。直接改文本,注释才不会丢。
 * 模板里那条 <占位符> route 是拿来被替换的,不是拿来陪跑的,所以 pattern 里还带 <> 的整行删掉。
 * 返回新文本;找不到 routes 数组则返回 null。
 */
export function withEntryRoute(text, host) {
  const m = /("routes"\s*:\s*\[)([\s\S]*?)(\n[ \t]*\])/.exec(text);
  if (!m) return null;
  const lines = m[2].split('\n').filter((l) => !/"pattern"\s*:\s*"[^"]*<[^"]*"/.test(l));
  // Give the previous last entry a comma -- unless there is no previous entry at all.
  // 给原来的最后一条补逗号 —— 除非原本就一条都没有。
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t || t.startsWith('//')) continue;
    if (!t.endsWith(',')) lines[i] = lines[i].replace(/\s*$/, ',');
    break;
  }
  const body = lines.join('\n').replace(/\n+$/, '');
  return text.slice(0, m.index) + m[1] + body +
         `\n    { "pattern": "${host}", "custom_domain": true }` + m[3] +
         text.slice(m.index + m[0].length);
}

/**
 * The zone each entry host belongs to. This project's convention is <subdomain>.<zone>,
 * so dropping the leftmost label is enough -- that also keeps suffixes like example.co.uk correct.
 * 各入口域对应的 zone 名。本项目约定入口恒为 <子域>.<zone>,
 * 去掉最左一段即可 —— 这样 example.co.uk 这种多级后缀也不会算错。
 */
export function zoneNames(cfg = loadWranglerConfig()) {
  const set = new Set();
  for (const host of entryHosts(cfg)) {
    const parts = host.split('.');
    set.add(parts.length > 2 ? parts.slice(1).join('.') : host);
  }
  return [...set];
}
