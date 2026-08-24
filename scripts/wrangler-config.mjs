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
 *
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

export function withBackupContainer(text, image, instanceType = 'standard-2') {
  // Each of the three pieces is decided on its own. One question standing for all of them would
  // let a half-finished configuration -- the binding written, the container not -- read as
  // complete, and no later deploy would ever go back and finish it.
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
 *
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
