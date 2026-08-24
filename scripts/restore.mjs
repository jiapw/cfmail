#!/usr/bin/env node
// Put a backup back.
//
//   node scripts/restore.mjs --token <API token> --from daily/2026-08-24 [--dry-run]
//
// An archive holds two things: database.sql, a dump of the tables, and mail/, the message files
// laid out under the storage keys they had. Rows go back first, then the message files, then one
// statement rebuilds the search index -- which is not in the backup because it is derived, and
// because D1 refuses to export a database containing a virtual table at all.
//
// WHAT IT DOES NOT DO
// It does not recreate the deployment: no Worker, no DNS, no mail routing, no secrets. Point it at
// a deployment that already exists and works. It also never deletes: rows are written with INSERT
// OR REPLACE, so running it over a live database repairs what is missing and overwrites what
// collides, and leaves anything newer alone.
//
// A monthly or yearly archive is a stored zip holding the dailies. Unpack one level first and
// restore whichever day you want -- each daily stands on its own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BK_BUCKET = 'cfmail-backup';
const RAW_BUCKET = 'cfmail-raw';
const D1_NAME = 'cfmail';

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.from) usage(args.help ? 0 : 1);
const TOKEN = args.token || process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) die('no API token given (--token, or the CLOUDFLARE_API_TOKEN environment variable)');
const DRY = !!args['dry-run'];
const CONFIG = args.config ? path.resolve(args.config) : null;
const SEVENZ = args['7z'] || process.env.SEVENZ_BIN || '7z';

/** daily/2026-08-24 and daily/2026-08-24.7z both name the same archive */
const FROM = String(args.from).replace(/\.7z$|\.zip$/, '');
const EXT = FROM.startsWith('daily/') ? '.7z' : '.zip';

function usage(code) {
  console.log(`
Usage:
  node scripts/restore.mjs --token <API token> --from <archive> [options]

  --from <p>     Which archive to restore, e.g. daily/2026-08-24
  --token <t>    Cloudflare API token; may also be the CLOUDFLARE_API_TOKEN environment variable
  --config <f>   Which wrangler configuration to use (wrangler.acct-<id>.jsonc for a second account)
  --skip-mail    Restore the database and leave the message files alone
  --skip-db      Restore the message files and leave the database alone
  --7z <path>    Path to the 7z binary, if it is not on PATH
  --dry-run      Report what would be restored and change nothing

  Start with --dry-run: it fetches the archive, opens it, and says what is inside without
  writing anything back.

  A monthly or yearly archive is a stored zip of dailies. Unpack it and restore a day out of
  it -- each daily archive stands on its own.
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
const step = (s) => console.log('\n> ' + s);
const log = (s) => console.log('  ' + s);

function wranglerBin() {
  const bin = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!fs.existsSync(bin)) die('wrangler not found -- run: npm install');
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
  if (r.error) die('could not start wrangler: ' + r.error.message);
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

/** Every file under a directory, as paths relative to it */
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// ---------------------------------------------------------------------------

console.log('\n=== CFMail restore ===');
if (DRY) console.log('    (--dry-run: report only, change nothing)');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cfmail-restore-'));
const archive = path.join(work, 'archive' + EXT);

step(`Fetching ${FROM}${EXT}`);
{
  const r = wrangler(['r2', 'object', 'get', `${BK_BUCKET}/${FROM}${EXT}`,
    '--file', archive, '--remote'], { capture: true });
  if (r.code !== 0 || !fs.existsSync(archive)) {
    die(`could not fetch ${FROM}${EXT}\n${r.out.slice(-500)}`);
  }
  log(`${(fs.statSync(archive).size / 1048576).toFixed(1)} MB`);
}

step('Opening it');
const unpacked = path.join(work, 'x');
{
  const r = spawnSync(SEVENZ, ['x', archive, '-o' + unpacked, '-y'], { stdio: 'ignore' });
  if (r.error) {
    die(`could not run ${SEVENZ}: ${r.error.message}\n  Install 7-Zip, or point at it with --7z <path>.`);
  }
  if ((r.status ?? 1) !== 0) die(`${SEVENZ} exited with ${r.status}`);
}

const sql = path.join(unpacked, 'database.sql');
const mailDir = path.join(unpacked, 'mail');
const manifest = path.join(unpacked, 'manifest.json');
if (fs.existsSync(manifest)) {
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  // A folded archive is a container of other archives, and restoring it directly means nothing.
  // Saying which days are inside is more use than a complaint about the wrong file.
  if (m.members) {
    die('this is a monthly or yearly archive, which holds daily archives:\n'
      + m.members.map((x) => '    ' + x).join('\n')
      + '\n\n  Unpack it and restore one of those days.');
  }
  log(`archive for ${m.day || '?'}, made ${new Date(m.at || 0).toISOString()}`);
}
if (!fs.existsSync(sql)) die('no database.sql in this archive');
const files = fs.existsSync(mailDir) ? walk(mailDir) : [];
log(`database.sql ${(fs.statSync(sql).size / 1048576).toFixed(1)} MB, ${files.length} message file(s)`);

if (!args['skip-db']) {
  step('Database');
  if (DRY) {
    log(`would run: wrangler d1 execute ${D1_NAME} --remote --file database.sql`);
  } else {
    // The dump is INSERTs against the same schema, so replaying it over a live database repairs
    // rather than replaces. It goes in as one file: a statement at a time over the API would take
    // hours for a mailbox of any size.
    const r = wrangler(['d1', 'execute', D1_NAME, '--remote', '--file', sql, '-y'], { capture: true });
    if (r.code !== 0) die('restoring the database failed:\n' + r.out.slice(-1200));
    log('restored');
  }
}

if (!args['skip-mail'] && files.length) {
  step('Message files');
  if (DRY) {
    log(`would put ${files.length} file(s) back into ${RAW_BUCKET}`);
  } else {
    let done = 0;
    let failed = 0;
    for (const rel of files) {
      const r = wrangler(['r2', 'object', 'put', `${RAW_BUCKET}/${rel}`,
        '--file', path.join(mailDir, rel), '--remote'], { capture: true });
      if (r.code === 0) done++;
      else failed++;
      if ((done + failed) % 100 === 0) log(`  ${done + failed}/${files.length}`);
    }
    log(`${done} put back${failed ? `, ${failed} failed` : ''}`);
  }
}

if (!DRY && !args['skip-db']) {
  step('Rebuilding the search index');
  const r = wrangler(['d1', 'execute', D1_NAME, '--remote', '-y', '--command',
    "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"], { capture: true });
  log(r.code === 0 ? 'rebuilt' : '⚠ the rebuild failed; the same statement can be run by hand later');
}

fs.rmSync(work, { recursive: true, force: true });
console.log(DRY ? '\n--dry-run stops here. Nothing was changed.\n' : '\nDone.\n');
