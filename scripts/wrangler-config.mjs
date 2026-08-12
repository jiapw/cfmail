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
function stripJsonc(src) {
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

/** Entry custom domains, e.g. ["mail.example.com"] -- the routes flagged custom_domain.
 *  入口自定义域,如 ["mail.example.com"] —— routes 里 custom_domain 的那些 */
export function entryHosts(cfg = loadWranglerConfig()) {
  return (cfg.routes || [])
    .filter((r) => r && r.custom_domain && typeof r.pattern === 'string')
    .map((r) => r.pattern);
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
