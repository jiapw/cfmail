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
 * Make sure a bucket binding is in the configuration, adding it if a previous version of this
 * script wrote the file before the binding existed.
 *
 * A generated configuration does not follow the template it came from. Every binding added after
 * a deployment was first set up is therefore invisible to it -- the Worker simply starts without
 * that binding, and the feature behind it is quietly never available. Routes have been kept in
 * step this way since the beginning; buckets need the same treatment.
 *
 * 确保某个桶的绑定在配置里,缺了就补上 —— 那是本脚本的旧版本在这个绑定还不存在时写下的文件。
 *
 * 生成出来的配置不会跟着它的模板走。于是每一个"部署建好之后才加的绑定"对它都是隐形的:
 * Worker 就那么少一个绑定地启动了,它背后的功能悄无声息地永远不可用。
 * routes 从一开始就是这样保持同步的,桶也该照办。
 */
export function withBucket(text, binding, bucket) {
  if (new RegExp('"binding"\\s*:\\s*"' + binding + '"').test(text)) return text;
  const m = /("r2_buckets"\s*:\s*\[)([\s\S]*?)(\n[ \t]*\])/.exec(text);
  if (!m) return null;
  const lines = m[2].split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t || t.startsWith('//')) continue;
    if (!t.endsWith(',')) lines[i] = lines[i].replace(/\s*$/, ',');
    break;
  }
  const body = lines.join('\n').replace(/\n+$/, '');
  return text.slice(0, m.index) + m[1] + body +
         `\n    { "binding": "${binding}", "bucket_name": "${bucket}" }` + m[3] +
         text.slice(m.index + m[0].length);
}

/**
 * Put a var into the configuration if it is not already there. Same reason as withBucket: a
 * generated file does not follow its template, so anything introduced after a deployment was set
 * up is invisible to it unless a later deploy goes looking.
 * 配置里没有这个 var 就补上。理由与 withBucket 相同:生成出来的文件不跟着模板走,
 * 于是"部署建好之后才加的东西"对它是隐形的 —— 除非后来的部署主动去找。
 */
export function withVar(text, name, value) {
  if (new RegExp('"' + name + '"\\s*:').test(text)) return text;
  const m = /("vars"\s*:\s*\{)/.exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  return text.slice(0, at) + `\n    "${name}": "${value}",` + text.slice(at);
}

/**
 * The span of the array that opens at `open`, found by counting brackets rather than by matching
 * a lazy regex to the first closing one.
 *
 * That distinction is not academic. A migrations entry contains a nested array, so a lazy
 * `[\s\S]*?\]` stops at the inner bracket, and an insertion made there lands inside
 * new_sqlite_classes -- still valid JSON, still parses, and quietly wrong. Counting cannot make
 * that mistake.
 *
 * 从 `open` 开始那个数组的范围,靠数括号得出,而不是拿惰性正则去撞第一个右括号。
 *
 * 这个区别不是学究气。一条迁移里含有嵌套数组,于是惰性的 `[\s\S]*?\]` 会停在内层那个括号上,
 * 插进去的东西就落到了 new_sqlite_classes 里面 —— 仍是合法 JSON、仍然解析得了、而且悄悄是错的。
 * 数括号犯不了这个错。
 */
function arraySpan(text, open) {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return { start: open, end: i };
    }
  }
  return null;
}

/**
 * Put the backup container into the configuration: the binding, the migration that creates its
 * class, and the container itself. Absent means the deployment simply has no backup, which is the
 * right outcome for anyone who never built the image.
 * 把备份容器写进配置:绑定、创建它那个类的迁移,以及容器本身。
 * 没有这一段,就意味着这套部署没有备份功能 —— 对于从没构建过镜像的人,这正是对的结果。
 */
/**
 * Tell local development to leave the container alone. Without this, `wrangler dev` goes to pull
 * the image, which wants Docker running -- a price to be paid when the backup is actually being
 * worked on, not on every local run of the mail system.
 * 让本地开发不去碰容器。没有这一句,`wrangler dev` 会去拉镜像,那要求 Docker 跑着 ——
 * 这笔账该在真正调备份的时候付,而不是每一次本地跑邮件系统都付。
 */
export function withDevContainersOff(text) {
  if (/"enable_containers"/.test(text)) return text;
  const m = /"containers"\s*:\s*\[/.exec(text);
  if (!m) return null;
  const lineStart = text.lastIndexOf('\n', m.index) + 1;
  const indent = (text.slice(lineStart).match(/^([ \t]*)/) || [, '  '])[1];
  return text.slice(0, lineStart)
    + `${indent}// 本地开发不碰容器:否则 wrangler dev 会去拉镜像,那要求 Docker 跑着。\n`
    + `${indent}// Local development leaves the container alone; pulling the image wants Docker.\n`
    + `${indent}"dev": { "enable_containers": false },\n\n`
    + text.slice(lineStart);
}

export function withBackupContainer(text, image, instanceType = 'standard-2') {
  // Each of the three pieces is decided on its own. One question standing for all of them would
  // let a half-finished configuration -- the binding written, the container not -- read as
  // complete, and no later deploy would ever go back and finish it.
  // 三个部分各自判断。用一个问题代表全部,会让"绑定写了、容器没写"的半成品读起来像是完成了,
  // 而此后任何一次部署都不会再回来把它补完。
  const hasBinding = /"name"\s*:\s*"BACKUP_CONTAINER"/.test(text);
  const hasContainer = /"containers"\s*:\s*\[[\s\S]*?"BackupContainer"/.test(text);
  let out = text;

  if (!hasBinding) {
    const dob = /("durable_objects"\s*:\s*\{\s*"bindings"\s*:\s*\[)/.exec(out);
    if (!dob) return null;
    const at = dob.index + dob[0].length;
    out = out.slice(0, at)
        + '\n      { "name": "BACKUP_CONTAINER", "class_name": "BackupContainer" },'
        + out.slice(at);
  }

  const migAt = /"migrations"\s*:\s*\[/.exec(out);
  if (!migAt) return null;
  const span = arraySpan(out, migAt.index + migAt[0].length - 1);
  if (!span) return null;
  const inner = out.slice(span.start + 1, span.end);
  const tags = [...inner.matchAll(/"tag"\s*:\s*"v(\d+)"/g)].map((m) => parseInt(m[1], 10));
  const next = 'v' + ((tags.length ? Math.max(...tags) : 0) + 1);
  const body = inner.replace(/\s*$/, '');
  const indent = (out.slice(0, span.start).match(/\n([ \t]*)[^\n]*$/) || [, '  '])[1];
  if (!/"BackupContainer"/.test(inner)) {
    out = out.slice(0, span.start + 1)
        + (body.trim() ? (body.trim().endsWith(',') ? body : body + ',') : '')
        + `\n${indent}  { "tag": "${next}", "new_sqlite_classes": ["BackupContainer"] }\n${indent}`
        + out.slice(span.end);
  }

  // Where the array now ends, plus the comma after it if there is one
  // 数组现在的末尾,以及它后面那个逗号(如果有的话)
  const span2 = arraySpan(out, /"migrations"\s*:\s*\[/.exec(out).index + /"migrations"\s*:\s*\[/.exec(out)[0].length - 1);
  let end = span2.end + 1;
  const needsComma = out[end] !== ',';
  if (!needsComma) end += 1;
  if (hasContainer) return out;

  const block = `

${indent}// 备份跑在容器里:那儿有 7-Zip、有磁盘、想跑多久跑多久,而 Worker 三样都没有。
${indent}// 镜像引用仓库地址而不是在此构建,所以部署不需要 Docker。
${indent}// Where the backup runs: 7-Zip, a disk, and as long as it takes. The image is referenced
${indent}// from the registry rather than built here, so a deploy needs no Docker.
${indent}"containers": [
${indent}  {
${indent}    "class_name": "BackupContainer",
${indent}    "image": "${image}",
${indent}    "instance_type": "${instanceType}",
${indent}    "max_instances": 1
${indent}  }
${indent}],`;
  return out.slice(0, end) + (needsComma ? ',' : '') + block + out.slice(end);
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
