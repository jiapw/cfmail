#!/usr/bin/env node
/**
 * The backup job. Runs inside the container, and runs just as well outside it -- which is the
 * point: everything that can go wrong here is ordinary code, testable on a laptop against the real
 * account, long before it is ever wrapped in an image.
 *
 * WHY THIS IS NOT IN THE WORKER
 * A Worker gets thirty seconds of CPU and a hundred and twenty-eight megabytes, and has no LZMA.
 * This job compresses a gigabyte with 7-Zip and takes as long as it takes. Those are not the same
 * kind of place, and pretending otherwise cost several hundred lines of streaming binary formats
 * that this script does not need: it has a disk, and tar, and 7z, and zip.
 *
 * WHAT IT PRODUCES
 *   daily/YYYY-MM-DD.7z    the whole database as SQL, plus the .eml that arrived that day
 *   monthly/YYYY-MM.zip    that month's dailies, stored, not recompressed
 *   yearly/YYYY.zip        that year's monthlies, likewise
 *
 * Each .eml appears in exactly one daily, the daily it arrived in; a monthly is a container of
 * dailies and a yearly a container of monthlies, so no message is ever stored twice. Restoring a
 * given day means opening at most three nested files.
 *
 *
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const env = process.env;
const need = (k) => {
  const v = env[k];
  if (!v) fail(`missing environment variable ${k}`);
  return v;
};

const ACCOUNT = need('CF_ACCOUNT_ID');
const DB_ID = need('CF_D1_DATABASE_ID');
const TOKEN_ID = need('CF_TOKEN_ID');
const TOKEN_VALUE = need('CF_TOKEN_VALUE');
const RAW_BUCKET = env.R2_RAW_BUCKET || 'cfmail-raw';
const BK_BUCKET = env.R2_BACKUP_BUCKET || 'cfmail-backup';
const WORK = env.WORK_DIR || '/tmp/cfmail-backup';
const LEVEL = env.SEVENZ_LEVEL || '9';

/** R2's S3 credentials are derived, not separate: the key is the token's id, the secret is the
 *  SHA-256 of its value. One token therefore opens both D1 and the buckets.
 */
const S3_KEY = TOKEN_ID;
const S3_SECRET = crypto.createHash('sha256').update(TOKEN_VALUE).digest('hex');
const S3_HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;

const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);
function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// S3 (SigV4)
// ---------------------------------------------------------------------------

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();

/**
 * Sign one S3 request for R2. Payloads are hashed, never streamed unsigned: R2 accepts
 * UNSIGNED-PAYLOAD, but a signed hash is what makes a truncated upload fail loudly instead of
 * landing as a shorter object.
 */
function sign(method, bucket, key, query, payloadHash, extraHeaders = {}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const canonicalUri = '/' + bucket + (key ? '/' + key.split('/').map(encodeURIComponent).join('/') : '');
  const qs = Object.keys(query).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
  const headers = { host: S3_HOST, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extraHeaders };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [method, canonicalUri, qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  let k = hmac('AWS4' + S3_SECRET, date);
  k = hmac(k, 'auto');
  k = hmac(k, 's3');
  k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(toSign).digest('hex');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${S3_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `https://${S3_HOST}${canonicalUri}${qs ? '?' + qs : ''}`, headers };
}

async function s3(method, bucket, key, { query = {}, body = null, headers = {} } = {}) {
  const payload = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const { url, headers: h } = sign(method, bucket, key, query, sha256hex(payload), headers);
  const res = await fetch(url, { method, headers: h, body: payload.length ? payload : undefined });
  return res;
}

/** Every object under a prefix, with its size and last-modified time. */
async function listAll(bucket, prefix = '') {
  const out = [];
  let token;
  for (;;) {
    const query = { 'list-type': '2', 'max-keys': '1000' };
    if (prefix) query.prefix = prefix;
    if (token) query['continuation-token'] = token;
    const res = await s3('GET', bucket, '', { query });
    if (!res.ok) fail(`could not list ${bucket}/${prefix}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const g = (tag) => (m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [, ''])[1];
      out.push({
        key: g('Key').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
        size: parseInt(g('Size'), 10) || 0,
        modified: Date.parse(g('LastModified')) || 0,
      });
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    token = (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [, ''])[1];
    if (!token) break;
  }
  return out;
}

/**
 * Fetch one object to disk -- buffered, not streamed, and that is a hard-won distinction.
 *
 * Streaming these through a download pool tripped an assertion inside Node's own HTTP client:
 * undici's `assert(!this.paused)`, thrown on a socket event when a backpressure-paused parser
 * meets the end of a keep-alive connection. It detonates outside any promise, so no try/catch
 * in this file can reach it; the process just dies with a version banner. Reading each body
 * whole keeps the parser unpaused, and nothing fetched here outgrows the container's memory --
 * mail objects are kilobytes, and even a folded yearly is a fraction of it.
 *
 * Network failures that CAN be caught are retried twice: across eight thousand objects, one
 * reset connection should cost a retry, not the run.
 */
async function getToFile(bucket, key, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { url, headers } = sign('GET', bucket, key, {}, sha256hex(Buffer.alloc(0)));
      const res = await fetch(url, { headers });
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, buf);
      return true;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/**
 * Upload a file, in parts when it is large. R2 takes a single PUT up to five gigabytes, but a
 * failure at four and a half means starting over; parts fail one at a time.
 */
const PART = 64 * 1024 * 1024;
/** Archives go to Infrequent Access; the index does not -- it is rewritten after every run, and
 *  every overwrite of an IA object is billed as thirty days of a new one. */
const IA = 'STANDARD_IA';
async function putFile(bucket, key, file, contentType, storageClass) {
  const cls = storageClass ? { 'x-amz-storage-class': storageClass } : {};
  const size = (await fs.promises.stat(file)).size;
  if (size <= PART) {
    const body = await fs.promises.readFile(file);
    const res = await s3('PUT', bucket, key, { body, headers: { 'content-type': contentType, ...cls } });
    if (!res.ok) fail(`could not upload ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return size;
  }
  const start = await s3('POST', bucket, key, { query: { uploads: '' }, headers: { 'content-type': contentType, ...cls } });
  if (!start.ok) fail(`could not start the multipart upload: HTTP ${start.status}`);
  const uploadId = ((await start.text()).match(/<UploadId>([\s\S]*?)<\/UploadId>/) || [, ''])[1];
  if (!uploadId) fail('the multipart upload returned no UploadId');
  const fd = await fs.promises.open(file, 'r');
  const etags = [];
  try {
    for (let i = 0, n = 1; i < size; i += PART, n++) {
      const len = Math.min(PART, size - i);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, i);
      const res = await s3('PUT', bucket, key, { query: { partNumber: String(n), uploadId }, body: buf });
      if (!res.ok) fail(`could not upload part ${n}: HTTP ${res.status}`);
      etags.push({ n, etag: (res.headers.get('etag') || '').replace(/"/g, '') });
      log(`  part ${n}/${Math.ceil(size / PART)}`);
    }
  } finally {
    await fd.close();
  }
  const body = '<CompleteMultipartUpload>'
    + etags.map((e) => `<Part><PartNumber>${e.n}</PartNumber><ETag>"${e.etag}"</ETag></Part>`).join('')
    + '</CompleteMultipartUpload>';
  const done = await s3('POST', bucket, key, { query: { uploadId }, body, headers: { 'content-type': 'application/xml' } });
  if (!done.ok) fail(`could not complete the multipart upload: HTTP ${done.status} ${(await done.text()).slice(0, 300)}`);
  return size;
}

async function del(bucket, key) {
  const res = await s3('DELETE', bucket, key, {});
  return res.ok || res.status === 204;
}

// ---------------------------------------------------------------------------
// The archive index
// ---------------------------------------------------------------------------

/**
 * One gzipped list of every R2 key that is inside some archive. It is what makes "not yet backed
 * up" a question with an exact answer: catch-up is the set difference between the mail bucket and
 * this file. Folds move archives around but never un-archive anything, so the index only grows,
 * and it survives them untouched.
 *
 * Single writer by construction -- the control plane runs one job at a time -- so read-modify-
 * write is safe.
 */
const INDEX_KEY = 'index/archived.txt.gz';

async function loadIndex() {
  const { url, headers } = sign('GET', BK_BUCKET, INDEX_KEY, {}, sha256hex(Buffer.alloc(0)));
  const res = await fetch(url, { headers });
  if (res.status === 404) return new Set();
  if (!res.ok) fail(`could not read the archive index: HTTP ${res.status}`);
  return new Set(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8').split('\n').filter(Boolean));
}

async function saveIndex(set) {
  const body = zlib.gzipSync(Buffer.from([...set].sort().join('\n') + '\n'));
  const res = await s3('PUT', BK_BUCKET, INDEX_KEY, { body, headers: { 'content-type': 'application/gzip' } });
  if (!res.ok) fail(`could not write the archive index: HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

/**
 * The tables that go into a backup, named explicitly -- which turns out to be required, not
 * merely tidy.
 *
 * D1 refuses to export a database that contains a virtual table: "cannot export databases with
 * Virtual Tables (fts5)". This one has messages_fts. Naming the tables sidesteps it, because the
 * export then never looks at the index -- and the index was never worth backing up anyway, being
 * one statement's worth of rebuilding over message_texts.
 *
 * Absent for their own reasons: sessions, password_resets and pending_regs are live credentials,
 * and restoring a login or a year-old reset token is not restoring data. chat_* and drive_* are
 * out of scope; a Drive tree without its bytes would be worse than no Drive at all.
 *
 *
 */
const TABLES = [
  'users', 'domains', 'domain_admins', 'mailboxes', 'aliases', 'grants',
  'folders', 'labels', 'messages', 'message_texts', 'attachments', 'message_labels',
  'drafts', 'outbox', 'contacts', 'invites', 'invite_uses', 'suppressions',
  'unrouted', 'uploads', 'audit_log', 'meta',
];

/** One ordinary query against D1, over the REST API. */
async function d1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN_VALUE}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    }
  );
  const j = await res.json().catch(() => ({}));
  if (!j.success) fail(`query failed: ${sql.slice(0, 80)} -- ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  return j.result?.[0]?.results || [];
}

/** A SQLite literal. Numbers stay numbers, NULL stays NULL -- an empty string is a different
 *  value and must not become one -- and anything binary goes back as an X'..' blob. */
function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Array.isArray(v)) return "X'" + v.map((b) => b.toString(16).padStart(2, '0')).join('') + "'";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Write the tables out as SQL, a page at a time.
 *
 * D1 has an export API that does this in one call, and it is not used, because a running export
 * takes the database for itself: every other query fails with "Currently processing a long-running
 * export" while it runs. Measured against this deployment, that was six to seven seconds in which
 * the whole mail system answered 500 -- webmail requests, and any message arriving in that window.
 * A backup that opens a daily hole in the thing it is protecting is not worth the convenience.
 *
 * Ordinary paged SELECTs block nothing. They cost a few dozen more round trips and a minute more
 * wall clock, in a job that has all day.
 */
async function exportD1(file) {
  const out = fs.createWriteStream(file);
  const write = (s) => new Promise((res, rej) => out.write(s, (e) => (e ? rej(e) : res())));
  await write('PRAGMA defer_foreign_keys=TRUE;\n');

  // The schema as SQLite itself stores it. Indexes come along; the FTS5 virtual table and its
  // shadow tables do not, because the index is rebuilt from message_texts with one statement.
  const list = TABLES.map((t) => `'${t}'`).join(',');
  const schema = await d1(
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        AND (name IN (${list}) OR tbl_name IN (${list}))
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`
  );
  for (const row of schema) await write(row.sql.trim() + ';\n');

  const PAGE = 500;
  let rows = 0;
  for (const table of TABLES) {
    for (let offset = 0; ; offset += PAGE) {
      const page = await d1(`SELECT * FROM ${table} LIMIT ${PAGE} OFFSET ${offset}`);
      if (!page.length) break;
      const cols = Object.keys(page[0]);
      const names = cols.join(',');
      for (const r of page) {
        await write(`INSERT INTO ${table} (${names}) VALUES (${cols.map((c) => sqlValue(r[c])).join(',')});\n`);
      }
      rows += page.length;
      if (page.length < PAGE) break;
    }
    log(`  ${table.padEnd(16)} ${rows} rows so far`);
  }
  await new Promise((res) => out.end(res));
  return (await fs.promises.stat(file)).size;
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error) fail(`could not run ${cmd}: ${r.error.message} (is it in the image?)`);
  if ((r.status ?? 1) !== 0) fail(`${cmd} exited with ${r.status}`);
}

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

/**
 * The mail that arrived on this UTC day and is not in an archive already.
 *
 * import/ is deliberately absent. An import drops thousands of historical messages into the
 * bucket in one afternoon, and sweeping them into that night's archive would make one daily a
 * gigabyte among kilobytes. Imported mail waits for the operator to run the catch-up, which files
 * it deliberately; the automatic nightly covers only what actually arrived.
 *
 * The index check closes the other gap: if a catch-up already archived something from this day,
 * tonight's run must not archive it again -- one message, one archive.
 */
async function dailyBackup(day) {
  const from = Date.parse(day + 'T00:00:00Z');
  const to = from + 24 * 3600 * 1000;
  const work = path.join(WORK, day);
  rmrf(work);
  await fs.promises.mkdir(path.join(work, 'mail'), { recursive: true });

  log('exporting the database...');
  const sqlBytes = await exportD1(path.join(work, 'database.sql'));
  log(`  database.sql ${(sqlBytes / 1048576).toFixed(1)} MB`);

  const index = await loadIndex();
  log(`collecting the mail that arrived on ${day}...`);
  let picked = 0;
  let bytes = 0;
  const keys = [];
  for (const prefix of ['raw/', 'unrouted/', 'brand/']) {
    const objs = (await listAll(RAW_BUCKET, prefix))
      .filter((o) => o.modified >= from && o.modified < to && !index.has(o.key));
    for (const o of objs) {
      if (await getToFile(RAW_BUCKET, o.key, path.join(work, 'mail', o.key))) {
        picked++;
        bytes += o.size;
        keys.push(o.key);
      }
      if (picked % 200 === 0 && picked) log(`  ${picked} so far...`);
    }
  }
  log(`  ${picked} messages, ${(bytes / 1048576).toFixed(1)} MB`);

  await fs.promises.writeFile(path.join(work, 'manifest.json'), JSON.stringify({
    day, kind: 'daily', at: Date.now(),
    database_bytes: sqlBytes, mail_objects: picked, mail_bytes: bytes,
    note: 'database.sql is a SQL dump of the tables listed above. mail/ holds the messages that '
        + 'arrived on this day, laid out under their original storage keys. Imported mail is not '
        + 'here -- it enters the archives through the catch-up, in a .extra.7z beside this file. '
        + 'Each message lives in exactly one archive.',
  }, null, 2));

  const out = path.join(WORK, `${day}.7z`);
  rmrf(out);
  log(`compressing (7z -mx=${LEVEL})...`);
  run('7z', ['a', '-t7z', `-mx=${LEVEL}`, '-mmt=on', out, '.'], work);
  const size = (await fs.promises.stat(out)).size;
  log(`  ${(size / 1048576).toFixed(1)} MB`);

  log(`uploading daily/${day}.7z...`);
  await putFile(BK_BUCKET, `daily/${day}.7z`, out, 'application/x-7z-compressed', IA);
  if (keys.length) {
    for (const k of keys) index.add(k);
    await saveIndex(index);
  }
  rmrf(work);
  rmrf(out);
  return { objects: picked, bytes, size };
}

// ---------------------------------------------------------------------------
// Catch-up
// ---------------------------------------------------------------------------

/** A few downloads at a time. Eight thousand sequential GETs would spend most of an hour waiting. */
async function pool(items, width, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      await fn(items[k]);
    }
  }));
}

function walkLocal(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkLocal(full, base));
    else out.push(full);
  }
  return out;
}

function writeCatchupManifest(dir, day) {
  const files = walkLocal(path.join(dir, 'mail'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    day, kind: 'catchup', at: Date.now(),
    mail_objects: files.length,
    mail_bytes: files.reduce((n, f) => n + fs.statSync(f).size, 0),
    note: 'Mail filed by the catch-up: imported messages, and mail from days the automatic backup '
        + 'missed, under their original storage keys. There is no database.sql here -- the '
        + 'automatic dailies carry those.',
  }, null, 2));
}

/**
 * What is in no archive yet, grouped by the UTC day it arrived.
 *
 * Imported mail is pending whatever its day -- the automatic run never takes it. For everything
 * else, the current day is left out: tonight's run will take it, and archiving it here as well
 * would put one message in two archives.
 */
async function pendingByDay(onlyDay) {
  const index = await loadIndex();
  const today = dayOf(Date.now());
  const days = new Map();
  for (const prefix of ['import/', 'raw/', 'unrouted/', 'brand/']) {
    for (const o of await listAll(RAW_BUCKET, prefix)) {
      if (index.has(o.key)) continue;
      const d = dayOf(o.modified);
      if (prefix !== 'import/' && d >= today) continue;
      if (onlyDay && d !== onlyDay) continue;
      let g = days.get(d);
      if (!g) days.set(d, (g = []));
      g.push(o);
    }
  }
  return { index, days };
}

/** Build (or rebuild) the day's .extra.7z from a directory that already holds its mail. */
function packExtra(dir, day, out) {
  writeCatchupManifest(dir, day);
  rmrf(out);
  run('7z', ['a', '-t7z', `-mx=${LEVEL}`, '-mmt=on', out, '.'], dir);
}

/**
 * The day still lives at the top level: create daily/<day>.extra.7z, or merge into it if an
 * earlier catch-up already made one. The automatic daily/<day>.7z is never touched -- the two
 * names never collide, which is what lets a catch-up run while the nightly schedule goes on.
 */
async function intoExtra(work, newMail, day, dailyNames) {
  const key = `daily/${day}.extra.7z`;
  const dir = path.join(work, 'x');
  if (dailyNames.has(key)) {
    const cur = path.join(work, 'cur.7z');
    if (!(await getToFile(BK_BUCKET, key, cur))) fail(`could not fetch ${key}`);
    run('7z', ['x', cur, '-o' + dir, '-y']);
  } else {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  fs.cpSync(path.join(newMail, 'mail'), path.join(dir, 'mail'), { recursive: true });
  const out = path.join(work, 'extra.7z');
  packExtra(dir, day, out);
  await putFile(BK_BUCKET, key, out, 'application/x-7z-compressed', IA);
  dailyNames.add(key);
  return key;
}

/**
 * The day has been folded: its archives live inside a monthly zip, possibly inside a yearly one.
 * The fold is opened, the day's .extra.7z is created or merged inside it, and the fold is packed
 * again -- stored zips all the way, so this is I/O, not compression. Restoring a day still means
 * opening at most three nested files.
 */
async function intoFold(work, newMail, day, chain) {
  const outerKey = chain[0];
  const outerFile = path.join(work, 'outer.zip');
  if (!(await getToFile(BK_BUCKET, outerKey, outerFile))) fail(`could not fetch ${outerKey}`);
  const outerDir = path.join(work, 'outer');
  run('7z', ['x', outerFile, '-o' + outerDir, '-y']);

  let levelDir = outerDir;
  if (chain.length === 2) {
    const innerFile = path.join(outerDir, chain[1]);
    const innerDir = path.join(work, 'inner');
    if (fs.existsSync(innerFile)) {
      run('7z', ['x', innerFile, '-o' + innerDir, '-y']);
      fs.rmSync(innerFile);
    } else {
      fs.mkdirSync(innerDir, { recursive: true });
    }
    levelDir = innerDir;
  }

  const extraName = `${day}.extra.7z`;
  const extraFile = path.join(levelDir, extraName);
  const xDir = path.join(work, 'extra');
  if (fs.existsSync(extraFile)) {
    run('7z', ['x', extraFile, '-o' + xDir, '-y']);
    fs.rmSync(extraFile);
  } else {
    fs.mkdirSync(xDir, { recursive: true });
  }
  fs.cpSync(path.join(newMail, 'mail'), path.join(xDir, 'mail'), { recursive: true });
  packExtra(xDir, day, extraFile);

  // The fold's manifest lists its members; a member that appeared later belongs on that list too.
  try {
    const mPath = path.join(levelDir, 'manifest.json');
    const man = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    if (Array.isArray(man.members) && !man.members.includes(extraName)) {
      man.members.push(extraName);
      man.members.sort();
      fs.writeFileSync(mPath, JSON.stringify(man, null, 2));
    }
  } catch { /* a fold without a manifest is still a fold */ }

  if (chain.length === 2) {
    const innerFile = path.join(outerDir, chain[1]);
    run('zip', ['-0', '-r', '-q', innerFile, '.'], levelDir);
  }
  const outFile = path.join(work, 'packed.zip');
  rmrf(outFile);
  run('zip', ['-0', '-r', '-q', outFile, '.'], outerDir);
  await putFile(BK_BUCKET, outerKey, outFile, 'application/zip', IA);
  return outerKey;
}

/**
 * File everything that is in no archive into the archive it belongs to, one day at a time.
 * The index is saved after every committed day, so a run cut short loses nothing and repeats
 * nothing: the next catch-up simply has less to do.
 */
async function catchup(onlyDay) {
  const { index, days } = await pendingByDay(onlyDay);
  if (!days.size) {
    log('nothing to catch up');
    return { days: 0, objects: 0, bytes: 0, archives: [] };
  }
  const dailyNames = new Set((await listAll(BK_BUCKET, 'daily/')).map((o) => o.key));
  const monthlyNames = new Set((await listAll(BK_BUCKET, 'monthly/')).map((o) => o.key));
  const yearlyNames = new Set((await listAll(BK_BUCKET, 'yearly/')).map((o) => o.key));

  let objects = 0;
  let bytes = 0;
  const archives = new Set();
  for (const day of [...days.keys()].sort()) {
    const objs = days.get(day);
    const dayBytes = objs.reduce((n, o) => n + o.size, 0);
    log(`${day}: ${objs.length} message(s), ${(dayBytes / 1048576).toFixed(1)} MB`);

    const work = path.join(WORK, 'catchup-' + day);
    rmrf(work);
    const newMail = path.join(work, 'new');
    await fs.promises.mkdir(newMail, { recursive: true });
    await pool(objs, 8, async (o) => {
      if (!(await getToFile(RAW_BUCKET, o.key, path.join(newMail, 'mail', o.key)))) {
        fail(`could not fetch ${o.key}`);
      }
    });

    const M = day.slice(0, 7);
    const Y = day.slice(0, 4);
    let touched;
    if (yearlyNames.has(`yearly/${Y}.zip`)) {
      touched = await intoFold(work, newMail, day, [`yearly/${Y}.zip`, `${M}.zip`]);
    } else if (monthlyNames.has(`monthly/${M}.zip`)) {
      touched = await intoFold(work, newMail, day, [`monthly/${M}.zip`]);
    } else {
      touched = await intoExtra(work, newMail, day, dailyNames);
    }
    archives.add(touched);
    log(`  -> ${touched}`);

    for (const o of objs) index.add(o.key);
    await saveIndex(index);
    objects += objs.length;
    bytes += dayBytes;
    rmrf(work);
  }
  return { days: days.size, objects, bytes, archives: [...archives] };
}

/**
 * Fold a set of finished archives into one. Stored, never recompressed: the members are already
 * 7z, and running a compressor over compressed bytes spends minutes to make the file bigger.
 */
async function fold(kind, name, srcPrefix, members) {
  if (!members.length) {
    log(`${name}: nothing to fold, skipping`);
    return null;
  }
  const work = path.join(WORK, name);
  rmrf(work);
  await fs.promises.mkdir(work, { recursive: true });
  for (const m of members) {
    log(`  fetching ${m.key}`);
    if (!(await getToFile(BK_BUCKET, m.key, path.join(work, path.basename(m.key))))) {
      fail(`could not fetch ${m.key}; stopping the fold with nothing deleted`);
    }
  }
  await fs.promises.writeFile(path.join(work, 'manifest.json'), JSON.stringify({
    name, kind, at: Date.now(),
    members: members.map((m) => path.basename(m.key)),
    note: 'A stored zip: its members are already-compressed archives, taken in as they are.',
  }, null, 2));

  const out = path.join(WORK, `${name}.zip`);
  rmrf(out);
  log('packing (zip -0, stored)...');
  run('zip', ['-0', '-r', '-q', out, '.'], work);
  // Read the size before anything deletes the file -- asking afterwards reports zero, which then
  // travels all the way to the console as "0 MB" for an archive that is fine.
  const size = (await fs.promises.stat(out)).size;
  await putFile(BK_BUCKET, `${kind}/${name}.zip`, out, 'application/zip', IA);
  log(`wrote ${kind}/${name}.zip (${(size / 1048576).toFixed(1)} MB)`);

  // Only now, with the fold safely uploaded, do the members go.
  for (const m of members) {
    await del(BK_BUCKET, m.key);
    log(`  deleted ${m.key}`);
  }
  rmrf(work);
  rmrf(out);
  return { members: members.length, size };
}

async function main() {
  const mode = process.argv[2] || env.BACKUP_MODE || 'daily';
  const day = process.argv[3] || env.BACKUP_DAY || dayOf(Date.now() - 24 * 3600 * 1000);
  await fs.promises.mkdir(WORK, { recursive: true });

  if (mode === 'catchup') {
    log(`starting: catchup${process.argv[3] ? ' ' + process.argv[3] : ''}`);
    const result = { mode };
    // The optional day argument narrows the run to one day -- an operator's tool, not part of
    // the normal flow, where the control plane sends no day at all.
    Object.assign(result, await catchup(process.argv[3] || ''));
    log('done: ' + JSON.stringify(result));
    console.log('CFMAIL_BACKUP_RESULT ' + JSON.stringify({ ok: true, ...result }));
    return;
  }

  log(`starting: ${mode} ${day}`);
  const result = { mode, day };
  if (mode === 'daily' || mode === 'all') {
    Object.assign(result, await dailyBackup(day));
  }

  // The folds follow the calendar of the day the run happens on, which is the day after the one
  // being backed up.
  const runDay = new Date(Date.parse(day + 'T00:00:00Z') + 24 * 3600 * 1000);
  if (mode === 'all' || mode === 'fold') {
    if (runDay.getUTCDate() === 1) {
      const m = day.slice(0, 7);
      const members = (await listAll(BK_BUCKET, `daily/${m}-`)).filter((o) => o.key.endsWith('.7z'));
      members.sort((a, b) => (a.key < b.key ? -1 : 1));
      result.monthly = await fold('monthly', m, 'daily/', members);
    }
    if (runDay.getUTCMonth() === 0 && runDay.getUTCDate() === 2) {
      const y = String(runDay.getUTCFullYear() - 1);
      const members = (await listAll(BK_BUCKET, `monthly/${y}-`)).filter((o) => o.key.endsWith('.zip'));
      members.sort((a, b) => (a.key < b.key ? -1 : 1));
      result.yearly = await fold('yearly', y, 'monthly/', members);
    }
  }

  log('done: ' + JSON.stringify(result));
  // The control plane reads this line and nothing else
  console.log('CFMAIL_BACKUP_RESULT ' + JSON.stringify({ ok: true, ...result }));
}

main().catch((e) => fail(String(e?.stack || e)));
