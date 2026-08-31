// Reads deployment configuration out of wrangler.jsonc, shared by every script here.
// wrangler.jsonc is not committed (it carries each operator's own account_id and domains),
// so no script may hardcode a domain -- everything is derived here and acts on whoever deployed it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');

/** JSONC -> JSON: strip comments and trailing commas. A // inside a string must survive, so scan with state.
  */
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
    console.error('✗ wrangler.jsonc not found. Copy the template first: cp wrangler.example.jsonc wrangler.jsonc');
    process.exit(1);
  }
  try {
    return JSON.parse(stripJsonc(fs.readFileSync(CONFIG, 'utf8')));
  } catch (e) {
    console.error('✗ wrangler.jsonc could not be parsed: ' + e.message);
    process.exit(1);
  }
}

/** Raw text of wrangler.jsonc, comments and all. For the scripts that rewrite it in place.
  */
export function readWranglerText() {
  if (!fs.existsSync(CONFIG)) {
    console.error('✗ wrangler.jsonc not found. Copy the template first: cp wrangler.example.jsonc wrangler.jsonc');
    process.exit(1);
  }
  return fs.readFileSync(CONFIG, 'utf8');
}

/**
 * Write wrangler.jsonc, but never write something we cannot read back. A broken config means
 * no deploys, and the file is not in git, so there would be nothing to restore from.
 * `verify(parsed)` should return true if the intended change is actually in there.
 * Returns null on success, or the reason it refused to write.
 */
export function writeWranglerConfig(text, verify) {
  try {
    const parsed = JSON.parse(stripJsonc(text));
    if (verify && !verify(parsed)) return 'the value written could not be read back';
  } catch (e) {
    return e.message;
  }
  fs.writeFileSync(CONFIG, text);
  return null;
}

/** Entry custom domains, e.g. ["mail.example.com"] -- the routes flagged custom_domain.
  */
export function entryHosts(cfg = loadWranglerConfig()) {
  return (cfg.routes || [])
    .filter((r) => r && r.custom_domain && typeof r.pattern === 'string')
    .map((r) => r.pattern);
}

/**
 * The entry subdomain -- the leftmost label of the entry hosts, e.g. "mail" for mail.example.com.
 * routes is the single source of truth for it; the untouched template still holds a
 * <placeholder>, in which case there is nothing to derive and the caller decides.
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
 */
/**
 * Tell local development to leave the container alone. Without this, `wrangler dev` goes to pull
 * the image, which wants Docker running -- a price to be paid when the backup is actually being
 * worked on, not on every local run of the mail system.
 */
export function withDevContainersOff(text) {
  if (/"enable_containers"/.test(text)) return text;
  const m = /"containers"\s*:\s*\[/.exec(text);
  if (!m) return null;
  const lineStart = text.lastIndexOf('\n', m.index) + 1;
  const indent = (text.slice(lineStart).match(/^([ \t]*)/) || [, '  '])[1];
  return text.slice(0, lineStart)
    + `${indent}// Local development leaves the container alone; pulling the image would want Docker.\n`
    + `${indent}// Local development leaves the container alone; pulling the image wants Docker.\n`
    + `${indent}"dev": { "enable_containers": false },\n\n`
    + text.slice(lineStart);
}

/**
 * The image the configuration names for the backup container, or '' if it names none -- and a
 * reference that still carries a <placeholder> counts as none.
 *
 * That distinction is the whole point of this function. A configuration containing the words
 * "BackupContainer" was once taken to mean the container was set up, and a template shipping a
 * placeholder image therefore read as finished: the deploy left it alone, and Cloudflare was
 * handed a container pointing at an image nobody had ever pushed.
 *
 * 配置里给备份容器写的镜像;没有则返回 ''—— 引用里还带着 <占位符> 的,一律算没有。
 *
 * 这个区分正是本函数存在的理由。从前只要配置里出现 "BackupContainer" 就算容器已配好,
 * 于是模板里那个占位镜像被读成"已完成":部署不再管它,交给 Cloudflare 的是一个
 * 指向从没有人推送过的镜像的容器。
 */
export function containerImage(text) {
  const m = /"containers"\s*:\s*\[[\s\S]*?"image"\s*:\s*"([^"]*)"/.exec(text);
  const image = m ? m[1] : '';
  return image.includes('<') ? '' : image;
}

/** Does the configuration carry a backup container that names nowhere? That is the shape an
 *  older version of this script left behind, and it cannot be deployed.
 *  配置里那个备份容器指向的是个"哪儿也不是"吗?这是本脚本旧版本留下的形状,部署不了。 */
export function hasPlaceholderContainer(text) {
  return /"containers"\s*:\s*\[[\s\S]*?"BackupContainer"/.test(text) && !containerImage(text);
}

/**
 * Take the backup container back out: the containers array, the binding, and the migration that
 * created the class. For when there is no image and no way to build one -- a container naming an
 * image that does not exist does not merely disable the backup, it fails the entire deploy.
 *
 * Editing JSONC by hand is how configurations get quietly mangled, so this does not trust itself:
 * the result is parsed and inspected, and anything short of "valid, and exactly these three
 * pieces gone" returns null for the caller to fall back on. Refusing is always available; a
 * damaged wrangler.jsonc is not.
 *
 * 把备份容器整个取出来:containers 数组、绑定,以及创建该类的那条 migration。
 * 用在既没有镜像、也无从构建的时候 —— 一个指向不存在镜像的容器不只是让备份不可用,
 * 它会让整个部署失败。
 *
 * 手改 JSONC 正是配置被悄悄改坏的典型途径,所以这个函数不信任自己:
 * 改完要解析、要核对,凡是达不到"合法,且恰好少了这三样"的一律返回 null 交给调用方兜底。
 * 拒绝随时可以;一份被改坏的 wrangler.jsonc 不行。
 */
export function withoutBackupContainer(text) {
  const before = (() => {
    try { return JSON.parse(stripJsonc(text)); } catch { return null; }
  })();
  if (!before) return null;

  let out = text;
  // The containers array, whole, with the comma that followed it if it had one.
  const cm = /[ \t]*"containers"\s*:\s*\[/.exec(out);
  if (cm) {
    const span = arraySpan(out, cm.index + cm[0].length - 1);
    if (!span) return null;
    let end = span.end + 1;
    if (out[end] === ',') end += 1;
    const lineStart = out.lastIndexOf('\n', cm.index) + 1;
    out = out.slice(0, lineStart) + out.slice(end).replace(/^[ \t]*\n/, '');
  }
  // The binding line and the migration entry, each on its own line in every configuration this
  // script has ever written.
  out = out.replace(/^[ \t]*\{[^\n]*"BACKUP_CONTAINER"[^\n]*\n/m, '');
  out = out.replace(/^[ \t]*\{[^\n]*"new_sqlite_classes"\s*:\s*\["BackupContainer"\][^\n]*\n/m, '');
  // A list whose last entry has just been removed keeps a trailing comma behind it.
  out = out.replace(/,(\s*\])/g, '$1');

  let after;
  try { after = JSON.parse(stripJsonc(out)); } catch { return null; }
  const names = (c) => (c.durable_objects?.bindings || []).map((b) => b.name).sort().join(',');
  const tags = (c) => (c.migrations || []).map((m) => (m.new_sqlite_classes || []).join('/')).sort().join(',');
  const ok = !after.containers
    && names(after) === names(before).split(',').filter((n) => n !== 'BACKUP_CONTAINER').join(',')
    && tags(after) === tags(before).split(',').filter((t) => t !== 'BackupContainer').join(',')
    && JSON.stringify(after.vars || {}) === JSON.stringify(before.vars || {})
    && JSON.stringify(after.routes || []) === JSON.stringify(before.routes || []);
  return ok ? out : null;
}

/**
 * Bring the migrations list into line with what the account has actually applied.
 *
 * A migration that creates a Durable Object class can only ever run once. Send it again and
 * Cloudflare refuses the whole deploy -- "cannot apply new-sqlite-class migration to class X that
 * is already depended on by existing Durable Objects" -- and the deploy stays refused every time
 * after, because nothing about the situation changes on its own.
 *
 * Two things put a checkout in that position. A deploy can fail after the script was uploaded but
 * before the account recorded the new tag, leaving the class created and the tag behind. And a
 * configuration rebuilt from the template gets the template's numbering, which need not agree
 * with the numbering the account applied long ago -- the same tag then means a different step on
 * each side.
 *
 * Both are answered the same way: among the entries wrangler would actually send, any that would
 * create a class the account already has is taken out. Entries it will not send are left alone,
 * so a healthy configuration is never rewritten -- and a first install, where nothing exists yet,
 * is untouched by the same rule.
 *
 * 让 migrations 列表与账号上"实际已经应用"的状态对齐。
 *
 * 创建 Durable Object 类的 migration 只能跑一次。再发一次,Cloudflare 会拒掉整个部署 ——
 * "cannot apply new-sqlite-class migration to class X that is already depended on by existing
 * Durable Objects" —— 而且此后每次都拒,因为这个局面不会自己好转。
 *
 * 有两种情况会把一份 checkout 推到这个位置。一是部署在"脚本已上传、但账号还没记下新 tag"
 * 之间失败,于是类建好了、tag 却没往前走。二是配置从模板重建,拿到的是模板的编号,
 * 而它未必与这个账号很久以前应用过的编号一致 —— 同一个 tag 在两边指的就成了不同的步骤。
 *
 * 两者的答案是同一个:在 wrangler 真正会发出去的那些条目里,凡是"要创建一个账号上已经存在的类"的,
 * 整条拿掉。它不会发的条目原样不动,所以健康的配置永远不会被改写 ——
 * 而首次安装那里什么都还不存在,同一条规则下也一样毫发无损。
 */
export function withReconciledMigrations(text, { applied = null, existing = [] } = {}) {
  const have = new Set(existing);
  const m = /"migrations"\s*:\s*\[/.exec(text);
  if (!m) return text;
  const span = arraySpan(text, m.index + m[0].length - 1);
  if (!span) return text;

  let entries;
  try {
    entries = JSON.parse(stripJsonc(text)).migrations;
  } catch {
    return text;
  }
  if (!Array.isArray(entries) || !entries.length) return text;

  // Which entries wrangler will actually send, which is the only place a problem can arise. It
  // sends what follows the tag the account recorded -- and when the account recorded no tag at
  // all, it sends every one of them. That last case is the one that matters here: a deploy that
  // died after creating the classes but before the tag was written leaves exactly that state,
  // and from then on every step is offered again, including the ones that already happened.
  // 哪些条目 wrangler 真的会发出去 —— 问题只可能出在这些条目上。它发的是"账号记下的那个 tag
  // 之后的部分";而当账号根本没记下 tag 时,它把每一条都发出去。
  // 要紧的正是后一种:部署在"类已创建、tag 未写入"之间死掉,留下的就是这个状态,
  // 此后每一步都会被再提交一次,包括那些早已发生过的。
  const idx = applied ? entries.findIndex((e) => e.tag === applied) : -1;
  const firstSent = idx >= 0 ? idx + 1 : 0;

  // An entry that creates classes the account already has is dropped, not emptied: wrangler
  // sends a step without its tag, so an entry left with only a tag would go out as {} -- a step
  // that says nothing, which is not something to hand an API in place of a step.
  // 要创建"账号已有的类"的条目会被整条删掉,而不是清空:wrangler 发送步骤时会把 tag 去掉,
  // 于是只剩 tag 的条目发出去就是 {} —— 一个什么也没说的步骤,不该拿它去顶替一个步骤。
  const out = entries.filter((e, i) => {
    if (i < firstSent) return true;
    const makes = [...(e.new_sqlite_classes || []), ...(e.new_classes || [])];
    return !makes.length || !makes.every((c) => have.has(c));
  });
  if (out.length === entries.length) return text;

  const indent = (text.slice(0, span.start).match(/\n([ \t]*)[^\n]*$/) || [, '  '])[1];
  const body = out.map((e) => `${indent}  ${JSON.stringify(e)}`).join(',\n');
  const next = text.slice(0, span.start + 1) + '\n' + body + '\n' + indent + text.slice(span.end);
  try {
    JSON.parse(stripJsonc(next));
  } catch {
    return text;
  }
  return next;
}

export function withBackupContainer(text, image, instanceType = 'standard-2') {
  // Each of the three pieces is decided on its own. One question standing for all of them would
  // let a half-finished configuration -- the binding written, the container not -- read as
  // complete, and no later deploy would ever go back and finish it.
  const hasBinding = /"name"\s*:\s*"BACKUP_CONTAINER"/.test(text);
  const hasContainer = !!containerImage(text);
  let out = text;

  // A container that was left pointing at a placeholder is finished here rather than duplicated:
  // the block is already in the right place, only the image was never filled in.
  // 指向占位符的容器在这里补完,而不是再写一个:块本身位置就对,只是镜像从来没填上。
  if (!hasContainer && hasPlaceholderContainer(text)) {
    return text.replace(/("containers"\s*:\s*\[[\s\S]*?"image"\s*:\s*")([^"]*)(")/, `$1${image}$3`);
  }

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
  const span2 = arraySpan(out, /"migrations"\s*:\s*\[/.exec(out).index + /"migrations"\s*:\s*\[/.exec(out)[0].length - 1);
  let end = span2.end + 1;
  const needsComma = out[end] !== ',';
  if (!needsComma) end += 1;
  if (hasContainer) return out;

  const block = `

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
 */
export function withEntryRoute(text, host) {
  const m = /("routes"\s*:\s*\[)([\s\S]*?)(\n[ \t]*\])/.exec(text);
  if (!m) return null;
  const lines = m[2].split('\n').filter((l) => !/"pattern"\s*:\s*"[^"]*<[^"]*"/.test(l));
  // Give the previous last entry a comma -- unless there is no previous entry at all.
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
 */
export function zoneNames(cfg = loadWranglerConfig()) {
  const set = new Set();
  for (const host of entryHosts(cfg)) {
    const parts = host.split('.');
    set.add(parts.length > 2 ? parts.slice(1).join('.') : host);
  }
  return [...set];
}
