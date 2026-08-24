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
 *
 *
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

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

/** Every object under a prefix, with its size and last-modified time.
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

async function getToFile(bucket, key, file) {
  const { url, headers } = sign('GET', bucket, key, {}, sha256hex(Buffer.alloc(0)));
  const res = await fetch(url, { headers });
  if (!res.ok) return false;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  return true;
}

/**
 * Upload a file, in parts when it is large. R2 takes a single PUT up to five gigabytes, but a
 * failure at four and a half means starting over; parts fail one at a time.
 */
const PART = 64 * 1024 * 1024;
async function putFile(bucket, key, file, contentType) {
  const size = (await fs.promises.stat(file)).size;
  if (size <= PART) {
    const body = await fs.promises.readFile(file);
    const res = await s3('PUT', bucket, key, { body, headers: { 'content-type': contentType } });
    if (!res.ok) fail(`could not upload ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return size;
  }
  const start = await s3('POST', bucket, key, { query: { uploads: '' }, headers: { 'content-type': contentType } });
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
 *
 */
const TABLES = [
  'users', 'domains', 'domain_admins', 'mailboxes', 'aliases', 'grants',
  'folders', 'labels', 'messages', 'message_texts', 'attachments', 'message_labels',
  'drafts', 'outbox', 'contacts', 'invites', 'invite_uses', 'suppressions',
  'unrouted', 'uploads', 'audit_log', 'meta',
];

/**
 * Ask D1 for those tables as SQL. The export is asynchronous: the same call is made again with the
 * bookmark it hands back until it says complete, and then there is a link, good for an hour, to
 * the finished dump.
 *
 * Two things about this API are easy to get wrong, and both cost twenty minutes to find out.
 * A fatal error arrives with status still reading "active" and the reason in a separate field, so
 * polling on status alone waits forever on a job that failed at the first second. And the link is
 * one level deeper than it looks: result.result.signed_url.
 *
 *
 */
async function exportD1(file) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/export`;
  let bookmark;
  for (let i = 0; i < 600; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN_VALUE}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        output_format: 'polling',
        dump_options: { tables: TABLES },
        current_bookmark: bookmark,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.success) fail('the D1 export failed: ' + JSON.stringify(j.errors || j).slice(0, 400));
    const r = j.result || {};
    // An error field is fatal whatever the status says beside it
    if (r.error) fail('the D1 export reported: ' + r.error);
    if (r.status === 'error') fail('the D1 export failed: ' + JSON.stringify(r.messages || ''));
    if (r.status === 'complete') {
      const url2 = r.result?.signed_url || r.signed_url;
      if (!url2) fail('the D1 export said complete but gave no download link');
      const dl = await fetch(url2);
      if (!dl.ok) fail(`could not download the D1 dump: HTTP ${dl.status}`);
      await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(file));
      return (await fs.promises.stat(file)).size;
    }
    bookmark = r.at_bookmark || bookmark;
    for (const m of r.messages || []) if (/Uploaded part/i.test(m)) log('  ' + m);
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  fail('gave up waiting for the D1 export');
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

/** The mail that arrived on this UTC day, whether it came in or was imported -- both are new to
 *  the archive, and neither has been in one before.
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

  log(`collecting the mail that arrived on ${day}...`);
  let picked = 0;
  let bytes = 0;
  for (const prefix of ['import/', 'raw/', 'unrouted/', 'brand/']) {
    const objs = (await listAll(RAW_BUCKET, prefix)).filter((o) => o.modified >= from && o.modified < to);
    for (const o of objs) {
      if (await getToFile(RAW_BUCKET, o.key, path.join(work, 'mail', o.key))) {
        picked++;
        bytes += o.size;
      }
      if (picked % 200 === 0 && picked) log(`  ${picked} so far...`);
    }
  }
  log(`  ${picked} messages, ${(bytes / 1048576).toFixed(1)} MB`);

  await fs.promises.writeFile(path.join(work, 'manifest.json'), JSON.stringify({
    day, kind: 'daily', at: Date.now(),
    database_bytes: sqlBytes, mail_objects: picked, mail_bytes: bytes,
    note: 'database.sql is a SQL dump of the tables listed above. mail/ holds the messages that '
        + 'arrived on this day, laid out under their original storage keys. Each message appears '
        + 'in the archive for the day it arrived and nowhere else.',
  }, null, 2));

  const out = path.join(WORK, `${day}.7z`);
  rmrf(out);
  log(`compressing (7z -mx=${LEVEL})...`);
  run('7z', ['a', '-t7z', `-mx=${LEVEL}`, '-mmt=on', out, '.'], work);
  const size = (await fs.promises.stat(out)).size;
  log(`  ${(size / 1048576).toFixed(1)} MB`);

  log(`uploading daily/${day}.7z...`);
  await putFile(BK_BUCKET, `daily/${day}.7z`, out, 'application/x-7z-compressed');
  rmrf(work);
  rmrf(out);
  return { objects: picked, bytes, size };
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
  await putFile(BK_BUCKET, `${kind}/${name}.zip`, out, 'application/zip');
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
