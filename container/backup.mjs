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
 * that this script does not need: it has a disk, and 7z.
 *
 * WHAT IT PRODUCES
 *   daily/YYYY-MM-DD.7z   a day of the current month
 *   monthly/YYYY-MM.7z    a finished month of the current year
 *   yearly/YYYY.7z        a finished year
 *
 * Every archive has the same shape inside -- database.sql, manifest.json, and mail/ holding the
 * message files flat under their storage keys -- so any archive restores the same way, and a fold
 * is not a container of smaller archives but the same thing at a coarser grain: it opens the finer
 * ones, tips the mail out, and compresses the lot again as one.
 *
 * WHICH ARCHIVE A MESSAGE BELONGS TO
 * The date the message itself shows -- the one on it in the mail interface -- not the day its
 * bytes happened to land in the bucket. An import of ten years of mail files into ten years of
 * archives, not into one giant file named after an afternoon. Objects that are not messages
 * (unrouted mail, brand images) and dates too broken to trust fall back to the arrival day.
 * Each message lives in exactly one archive either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';

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
 * Returns false only for "not there". Any other failure is retried twice and then thrown:
 * a merge that mistook a flaky 500 for "no archive yet" would create a fresh archive over a
 * full one, and that is the one mistake this file must never make.
 */
async function getToFile(bucket, key, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { url, headers } = sign('GET', bucket, key, {}, sha256hex(Buffer.alloc(0)));
      const res = await fetch(url, { headers });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`GET ${bucket}/${key}: HTTP ${res.status}`);
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
 * this file. Folds move mail between archives but never un-archive anything, so the index only
 * grows, and it survives them untouched.
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
// Filing: which archive a message belongs to
// ---------------------------------------------------------------------------

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

function run(cmd, args, cwd) {
  // stdout is dropped: 7z narrates every file it touches, and the console's status line shows the
  // last line of output -- which should be this script saying what it is doing, not a 7z banner.
  // stderr still comes through; a failing 7z says why there.
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.error) fail(`could not run ${cmd}: ${r.error.message} (is it in the image?)`);
  if ((r.status ?? 1) !== 0) fail(`${cmd} exited with ${r.status}`);
}

/**
 * 7-Zip with its percentage read off stdout. Compressing a large archive is the one place a run
 * spends whole minutes with nothing to say; -bsp1 makes 7z report progress even into a pipe, and
 * the percentage is relogged in steps of ten so the console's status line moves instead of
 * standing still. Everything else 7z prints is dropped; a failing 7z still says why on stderr.
 */
function sevenZipProgress(args, cwd, say) {
  return new Promise((resolve) => {
    const child = spawn('7z', [...args, '-bsp1'], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    let tail = '';
    let last = -10;
    child.stdout.on('data', (d) => {
      // Progress arrives as carriage-returned fragments, so keep a byte tail and read the last
      // percentage out of it rather than waiting for line breaks that never come.
      tail = (tail + d.toString('latin1')).slice(-256);
      const m = tail.match(/(\d{1,3})%[^%]*$/);
      if (m) {
        const p = Math.min(100, parseInt(m[1], 10));
        if (p >= last + 10) {
          last = p;
          say(p);
        }
      }
    });
    child.on('error', (e) => fail(`could not run 7z: ${e.message} (is it in the image?)`));
    child.on('exit', (code) => {
      if (code !== 0) fail(`7z exited with ${code}`);
      resolve();
    });
  });
}

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

/**
 * The archive a given day's mail goes into, by the calendar alone: a finished year is one yearly
 * file, a finished month of the current year one monthly file, and only the current month is cut
 * day by day. Never by what happens to exist -- an archive created here for a month the fold has
 * not reached yet is simply found by the fold and taken in.
 */
function targetFor(day, today) {
  if (day.slice(0, 4) < today.slice(0, 4)) return `yearly/${day.slice(0, 4)}.7z`;
  if (day.slice(0, 7) < today.slice(0, 7)) return `monthly/${day.slice(0, 7)}.7z`;
  return `daily/${day}.7z`;
}

/**
 * Every message's own date, keyed by its storage key -- the same date column the mail interface
 * shows. One paged read of two columns, and filing stops depending on when bytes happened to
 * arrive.
 */
async function loadContentDates() {
  const map = new Map();
  const PAGE = 2000;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await d1(`SELECT r2_key, date FROM messages WHERE r2_key IS NOT NULL LIMIT ${PAGE} OFFSET ${offset}`);
    for (const r of rows) map.set(r.r2_key, r.date);
    if (rows.length < PAGE) break;
  }
  return map;
}

/** A Date header is whatever the sender wrote. One claiming 1980, or the day after tomorrow,
 *  would mint an archive for a period that never happened -- those fall back to the arrival day,
 *  as does everything that is not a message at all (unrouted mail, brand images). */
const EARLIEST = Date.parse('2000-01-01T00:00:00Z');
function contentDayOf(o, dates) {
  const t = dates.get(o.key);
  if (typeof t === 'number' && t >= EARLIEST && t <= Date.now() + 2 * 24 * 3600 * 1000) return dayOf(t);
  return dayOf(o.modified);
}

// ---------------------------------------------------------------------------
// The archives themselves
// ---------------------------------------------------------------------------

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
}

function writeManifest(dir, kind, period, dbAt) {
  const files = walkLocal(path.join(dir, 'mail'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    kind, period, at: Date.now(), db_at: dbAt || null,
    mail_objects: files.length,
    mail_bytes: files.reduce((n, f) => n + fs.statSync(f).size, 0),
    note: 'database.sql is a dump of the application tables, taken when this archive was first '
        + 'created; later merges add mail and leave it alone. mail/ holds message files under '
        + 'their original storage keys, filed by the date each message itself shows. Each message '
        + 'lives in exactly one archive.',
  }, null, 2));
}

/** One database dump per run, made the first time an archive needs one and copied ever after. */
const dump = { file: null, at: 0 };
async function ensureDump() {
  if (dump.file) return;
  const f = path.join(WORK, 'database.sql');
  log('exporting the database...');
  const bytes = await exportD1(f);
  log(`  database.sql ${(bytes / 1048576).toFixed(1)} MB`);
  dump.file = f;
  dump.at = Date.now();
}

/**
 * Put a batch of mail into one archive: fetch the archive if it exists, unpack it, lay the new
 * messages in beside the old, and compress the whole again. A new archive also receives this
 * run's database snapshot; a merge never touches the one already inside.
 *
 * The read-modify-write is safe because the control plane runs one job at a time, and idempotent
 * because a message already inside is recognized by its path and skipped -- a run cut short after
 * uploading but before the index was saved just does that archive's work again for nothing.
 */
async function fileInto(targetKey, objs, index) {
  const kind = targetKey.split('/')[0];
  const period = path.basename(targetKey, '.7z');
  const work = path.join(WORK, 'file-' + period);
  rmrf(work);
  const dir = path.join(work, 'a');
  await fs.promises.mkdir(path.join(dir, 'mail'), { recursive: true });

  const cur = path.join(work, 'cur.7z');
  const exists = await getToFile(BK_BUCKET, targetKey, cur);
  let dbAt = 0;
  if (exists) {
    run('7z', ['x', cur, '-o' + dir, '-y']);
    const man = readManifest(dir);
    dbAt = man?.db_at || man?.at || 0;
    rmrf(cur);
  }

  let added = 0;
  let bytes = 0;
  let seen = 0;
  await pool(objs, 8, async (o) => {
    seen++;
    if (seen % 200 === 0) log(`  fetching ${seen}/${objs.length}...`);
    const f = path.join(dir, 'mail', o.key);
    if (fs.existsSync(f)) return;
    if (!(await getToFile(RAW_BUCKET, o.key, f))) fail(`could not fetch ${o.key}`);
    added++;
    bytes += o.size;
  });
  if (exists && !added) {
    rmrf(work);
    return null;
  }

  if (!exists) {
    await ensureDump();
    await fs.promises.copyFile(dump.file, path.join(dir, 'database.sql'));
    dbAt = dump.at;
  }
  writeManifest(dir, kind, period, dbAt);

  const out = path.join(work, 'out.7z');
  await sevenZipProgress(['a', '-t7z', `-mx=${LEVEL}`, '-mmt=on', out, '.'], dir,
    (p) => log(`  compressing ${targetKey}: ${p}%`));
  const size = (await fs.promises.stat(out)).size;
  log(`  uploading ${targetKey} (${(size / 1048576).toFixed(1)} MB)...`);
  await putFile(BK_BUCKET, targetKey, out, 'application/x-7z-compressed', IA);
  log(`  ${exists ? 'merged into' : 'created'} ${targetKey} (${(size / 1048576).toFixed(1)} MB)`);
  for (const o of objs) index.add(o.key);
  await saveIndex(index);
  rmrf(work);
  return { added, bytes, size };
}

/**
 * File everything that is in no archive yet into the archive it belongs to, oldest period first.
 * The index is saved after every committed archive, so a run cut short loses nothing and repeats
 * nothing: the next run simply has less to do.
 *
 * imports:  whether import/ is considered. The nightly never takes it -- imported mail enters the
 *           archives only through the operator's catch-up. For everything else, mail whose own day
 *           has not ended yet is left for a later run.
 * ensureDay: the nightly's target day. Its archive is created even with no mail in it, because it
 *           is also the day's database snapshot.
 * onlyDay:  narrow a catch-up to one content day -- an operator's tool, not part of the normal
 *           flow, where the control plane sends no day at all.
 */
async function sweep({ imports = false, ensureDay = '', onlyDay = '' } = {}) {
  const index = await loadIndex();
  const today = dayOf(Date.now());
  log('reading message dates...');
  const dates = await loadContentDates();
  log(`  ${dates.size} message(s) in the database`);

  const groups = new Map();
  const prefixes = imports ? ['import/', 'raw/', 'unrouted/', 'brand/'] : ['raw/', 'unrouted/', 'brand/'];
  for (const prefix of prefixes) {
    for (const o of await listAll(RAW_BUCKET, prefix)) {
      if (index.has(o.key)) continue;
      const day = contentDayOf(o, dates);
      if (prefix !== 'import/' && day >= today) continue;
      if (onlyDay && day !== onlyDay) continue;
      const target = targetFor(day, today);
      let g = groups.get(target);
      if (!g) groups.set(target, (g = []));
      g.push(o);
    }
  }
  if (ensureDay && !onlyDay) {
    const t = targetFor(ensureDay, today);
    if (!groups.has(t)) groups.set(t, []);
  }

  const periodOf = (k) => path.basename(k, '.7z');
  const targets = [...groups.keys()].sort((a, b) => (periodOf(a) < periodOf(b) ? -1 : 1));
  let objects = 0;
  let bytes = 0;
  let size = 0;
  let k = 0;
  const archives = [];
  for (const target of targets) {
    const objs = groups.get(target);
    k++;
    log(`[${k}/${targets.length}] ${target}: ${objs.length} message(s), ${(objs.reduce((n, o) => n + o.size, 0) / 1048576).toFixed(1)} MB`);
    const r = await fileInto(target, objs, index);
    if (!r) continue;
    objects += r.added;
    bytes += r.bytes;
    size += r.size;
    archives.push(target);
  }
  return { objects, bytes, size, archives };
}

// ---------------------------------------------------------------------------
// Folds
// ---------------------------------------------------------------------------

/** Move every file under src into dst, directories merged. Renames, not copies: the pieces of a
 *  fold are on the same disk, and a month of mail is worth not writing twice. */
function mergeMove(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) mergeMove(s, d);
    else fs.renameSync(s, d);
  }
}

/**
 * Fold finished archives into one coarser one: open every member, tip the mail out flat, keep the
 * newest of their database snapshots, and compress the lot as a single archive. The members are
 * deleted only after the fold is safely uploaded. If a catch-up already created the fold's own
 * file -- filing old mail creates coarse archives directly -- its contents join the rest and the
 * file is replaced, never deleted.
 */
async function fold(kind, name, members) {
  if (!members.length) {
    log(`${name}: nothing to fold, skipping`);
    return null;
  }
  const ownKey = `${kind}/${name}.7z`;
  const work = path.join(WORK, 'fold-' + name);
  rmrf(work);
  const dir = path.join(work, 'a');
  await fs.promises.mkdir(path.join(dir, 'mail'), { recursive: true });

  const best = { at: 0, file: null };
  const takeIn = async (key) => {
    const f = path.join(work, 'member.7z');
    if (!(await getToFile(BK_BUCKET, key, f))) return false;
    const x = path.join(work, 'x');
    rmrf(x);
    run('7z', ['x', f, '-o' + x, '-y']);
    rmrf(f);
    const man = readManifest(x);
    const at = man?.db_at || man?.at || 0;
    const db = path.join(x, 'database.sql');
    if (fs.existsSync(db) && at >= best.at) {
      const keep = path.join(work, 'db.sql');
      fs.renameSync(db, keep);
      best.at = at;
      best.file = keep;
    }
    if (fs.existsSync(path.join(x, 'mail'))) mergeMove(path.join(x, 'mail'), path.join(dir, 'mail'));
    rmrf(x);
    return true;
  };

  await takeIn(ownKey);
  for (const m of members) {
    log(`  taking in ${m.key}`);
    if (!(await takeIn(m.key))) fail(`could not fetch ${m.key}; stopping the fold with nothing deleted`);
  }
  if (best.file) fs.renameSync(best.file, path.join(dir, 'database.sql'));
  writeManifest(dir, kind, name, best.at);

  const out = path.join(work, 'out.7z');
  await sevenZipProgress(['a', '-t7z', `-mx=${LEVEL}`, '-mmt=on', out, '.'], dir,
    (p) => log(`compressing ${ownKey}: ${p}%`));
  const size = (await fs.promises.stat(out)).size;
  log(`uploading ${ownKey} (${(size / 1048576).toFixed(1)} MB)...`);
  await putFile(BK_BUCKET, ownKey, out, 'application/x-7z-compressed', IA);
  log(`wrote ${ownKey} (${(size / 1048576).toFixed(1)} MB)`);

  // Only now, with the fold safely uploaded, do the members go.
  for (const m of members) {
    await del(BK_BUCKET, m.key);
    log(`  deleted ${m.key}`);
  }
  rmrf(work);
  return { members: members.length, size };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function main() {
  const mode = process.argv[2] || env.BACKUP_MODE || 'daily';
  const day = process.argv[3] || env.BACKUP_DAY || dayOf(Date.now() - 24 * 3600 * 1000);
  await fs.promises.mkdir(WORK, { recursive: true });

  if (mode === 'catchup') {
    log(`starting: catchup${process.argv[3] ? ' ' + process.argv[3] : ''}`);
    const result = { mode, ...(await sweep({ imports: true, onlyDay: process.argv[3] || '' })) };
    log('done: ' + JSON.stringify(result));
    console.log('CFMAIL_BACKUP_RESULT ' + JSON.stringify({ ok: true, ...result }));
    return;
  }

  log(`starting: ${mode} ${day}`);
  const result = { mode, day };
  if (mode === 'daily' || mode === 'all') {
    Object.assign(result, await sweep({ imports: false, ensureDay: day }));
  }

  // The folds follow the calendar of the day the run happens on, which is the day after the one
  // being backed up.
  const runDay = new Date(Date.parse(day + 'T00:00:00Z') + 24 * 3600 * 1000);
  if (mode === 'all' || mode === 'fold') {
    if (runDay.getUTCDate() === 1) {
      const m = day.slice(0, 7);
      const members = (await listAll(BK_BUCKET, `daily/${m}-`)).filter((o) => o.key.endsWith('.7z'));
      members.sort((a, b) => (a.key < b.key ? -1 : 1));
      result.monthly = await fold('monthly', m, members);
    }
    if (runDay.getUTCMonth() === 0 && runDay.getUTCDate() === 2) {
      const y = String(runDay.getUTCFullYear() - 1);
      const members = (await listAll(BK_BUCKET, `monthly/${y}-`)).filter((o) => o.key.endsWith('.7z'));
      members.sort((a, b) => (a.key < b.key ? -1 : 1));
      result.yearly = await fold('yearly', y, members);
    }
  }

  log('done: ' + JSON.stringify(result));
  // The control plane reads this line and nothing else
  console.log('CFMAIL_BACKUP_RESULT ' + JSON.stringify({ ok: true, ...result }));
}

main().catch((e) => fail(String(e?.stack || e)));
