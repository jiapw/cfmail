#!/usr/bin/env node
// One command to put CFMail on a Cloudflare account, and the same command to upgrade it later.
//
//   node scripts/deploy.mjs [--token <API token>] [--domain example.com] [--entry mail]
//
// Everything it needs arrives as an argument -- or, in a terminal, is asked for when missing:
// the token, the account when the token can see several, the domain and entry host on a first
// install. A wrong answer is not the end either: an invalid token can be pasted again, and a
// missing permission names itself, waits while the token is edited in the dashboard, and is
// probed again. Nothing is created until every check passes.
//
// The token is held in memory and passed to wrangler through the child process's environment.
// By default it is written nowhere -- not to wrangler.jsonc, not to a dotfile, not to the log --
// and losing the terminal loses the token: the operator keeps custody. The one exception is
// opt-in: a typed-in token may, with an explicit yes, be saved to .env.deploy.token (gitignored,
// this machine only) so the next run does not ask. Deleting that file unmakes the choice.
//
// Every step reads the account's current state before it changes anything, so running this twice
// is the same as running it once. That is not a convenience -- it is what makes it safe to run
// against an account that already has CFMail on it, which is the normal case for an upgrade.
// The two steps that change what is live -- migrations, publishing -- pause for a yes first;
// --yes skips the pauses. Outside a terminal (CI, a pipe, the .env.deploy* two-account routine)
// nothing asks and nothing pauses: exactly the old behaviour, arguments required.
//

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grantSelf, grantedNames, mintToken, ownToken } from './cf-token.mjs';
import { containerImage, hasPlaceholderContainer, setVar, stripJsonc, withBackupContainer, withBucket, withDevContainersOff, withDurableObject, withEntryRoute, withMeetContainer, withReconciledMigrations, withVar, withoutBackupContainer } from './wrangler-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_CONFIG = path.join(ROOT, 'wrangler.jsonc');
/**
 * Which configuration file this run belongs to. One checkout can be asked to deploy into more
 * than one Cloudflare account, and wrangler.jsonc holds the identity of exactly one of them:
 * its account, its database, its entry hosts. Reading somebody else's file would carry another
 * account's database_id and APP_ORIGIN into this deployment; writing over it would destroy the
 * only copy of a configuration that is not in git.
 *
 * So the default file is used when it is free or already ours, and a second account gets a file
 * of its own, named after it. Neither can reach the other.
 */
let CONFIG = MAIN_CONFIG;
const TEMPLATE = path.join(ROOT, 'wrangler.example.jsonc');
const API = 'https://api.cloudflare.com/client/v4';

const WORKER = 'cfmail';
const D1_NAME = 'cfmail';
const R2_NAME = 'cfmail-raw';
const BK_NAME = 'cfmail-backup';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help) usage(0);

// In a terminal, whatever is missing is asked for, and whatever the dashboard has to fix can be
// fixed and re-checked without starting over. Anywhere else -- CI, a pipe, the two-account
// .env.deploy* routine -- the old contract holds unchanged: arguments or nothing, no pauses.
// CFMAIL_INTERACTIVE=1/0 overrides the detection, for terminal wrappers that hide the TTY.
const INTERACTIVE = process.env.CFMAIL_INTERACTIVE
  ? process.env.CFMAIL_INTERACTIVE === '1'
  : !!(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;

// Where a typed-in token may be saved, with consent, so the next run does not ask. Explicit
// arguments and the environment always win over it -- the two-account .env.deploy* routine
// keeps working untouched -- and deleting the file is how the consent is withdrawn.
const TOKEN_FILE = path.join(ROOT, '.env.deploy.token');
const TOKEN_BASENAME = path.basename(TOKEN_FILE);

function readSavedToken() {
  try {
    const lines = fs.readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/);
    const get = (k) => (lines.find((l) => l.startsWith(k + '=')) || '').slice(k.length + 1).trim();
    const token = get('CLOUDFLARE_API_TOKEN');
    return token ? { token, accountId: get('CLOUDFLARE_ACCOUNT_ID') } : null;
  } catch { return null; }
}

let TOKEN = args.token || process.env.CLOUDFLARE_API_TOKEN || '';
// Where the token came from decides what may be offered later: only a typed-in token is ever
// offered a save, and only a saved one gets the "delete the file to switch" hint.
let tokenSource = args.token ? 'arg' : TOKEN ? 'env' : '';
let savedAccountId = '';
if (!TOKEN) {
  const saved = readSavedToken();
  if (saved) { TOKEN = saved.token; savedAccountId = saved.accountId; tokenSource = 'file'; }
}
const DRY = !!args['dry-run'];
let domain = (args.domain || '').trim().toLowerCase();
let entryArg = (args.entry || '').trim().toLowerCase();

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
if (domain && !DOMAIN_RE.test(domain)) {
  die(`--domain "${domain}" does not look like a domain name`);
}
if (entryArg && !LABEL_RE.test(entryArg)) {
  die(`--entry "${entryArg}" is not a valid DNS label`);
}
if (args.meetings !== undefined && !['on', 'no-live', 'off'].includes(String(args.meetings))) {
  die('--meetings takes one of: on, no-live, off');
}

function usage(code) {
  console.log(`
Usage:
  node scripts/deploy.mjs [--token <API token>] [--domain <domain>] [--entry <subdomain>]

  Run in a terminal, it asks for whatever is missing (the token, the domain and entry host on
  a first install), pauses for a yes before migrations and before publishing, and when a fix
  is needed in the Cloudflare dashboard it says which one and re-checks after you make it.
  Run anywhere else (CI, a pipe), it asks nothing and pauses nowhere; arguments are required.

  --token <t>     Cloudflare API token. May also be given as the CLOUDFLARE_API_TOKEN
                  environment variable, or typed in when asked. Not saved unless you say so:
                  a typed-in token is offered a save to .env.deploy.token (gitignored) so the
                  next run does not ask; argument and environment always take precedence over
                  that file, and deleting it undoes the save.
  --domain <d>    The company domain to connect. Needed the first time; run this again
                  with a different one for every further domain.
  --entry <e>     Entry subdomain, e.g. mail -> https://mail.<domain>.
                  Needed the first time; read back from the configuration afterwards.
  --yes           Answer yes to every pause (migrations, publishing). What was asked and
                  answered stays printed either way.
  --account <id>  Account id. Only needed when this token can see more than one.
  --adopt         The account already has a Worker / database / bucket by these names but this
                  checkout has no configuration proving they are the same deployment. Pass this
                  to say "yes, take them over"; without it the script refuses to touch them.
  --backup-token <t>
                  Token for the automatic backup. Separate from --token on purpose: this one
                  is stored in the Worker as a secret and stays there, while --token lives only
                  in the memory of this run. It needs Account D1 Read and Workers R2 Storage
                  Edit, and nothing else.
  --backup-image <ref>
                  Use an image you built and pushed yourself, instead of the published
                  one that Cloudflare pulls. Nothing is built here either way.
                  Once a container is in the configuration, wrangler dev wants an API
                  token in the environment even when you are not working on the backup.
  --meet-token <t>
                  A second token, just for meetings and broadcasts, for when --token may not
                  create tokens (Account API Tokens Edit) and so cannot make one itself. Give it
                  Account Calls Edit (meetings: creates the Realtime app, used once) and Account
                  Stream Edit (broadcasts: kept in the Worker as a secret), and nothing else.
                  Stream has to be enabled on the account. --stream-token is its older name.
  --meetings <m>  on | no-live | off: meetings and broadcasts on this deployment. Remembered
                  in the configuration, and read by the Worker; "off" and "no-live" also stop
                  the deploy from asking about them. A terminal run whose token cannot set them
                  up asks instead -- this flag is that answer, given in advance.
  --meet-image <ref>
                  The image broadcast meetings are composited in (container-meet/). Until a
                  public one is published there is no default: build it and push it to a
                  registry Cloudflare can pull from, then name it here once -- the
                  configuration remembers it.
  --prune-domains Let this deploy detach custom domains that are live but absent from the
                  configuration. Without it they are kept.
  --dry-run       Report what would happen and change nothing.
  --help          Show this text.

Permissions: the token needs Account (Workers Scripts / D1 / Workers R2 Storage - Edit) and
      Zone (Zone - Read, DNS / Email Routing Rules / Email Sending / Workers Routes - Edit).
      Every one of them is checked before anything is created, and a missing one is named.
      Optional: meetings and broadcasts. A token with Account (Account API Tokens - Edit) sets
      them up by itself; without it a terminal run asks how to go on -- a second token for
      them (--meet-token), switching them off (--meetings off), or adding that one permission.
      Everything else installs either way. See "API token permissions" in the README.
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

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function die(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}
const step = (s) => console.log('\n▸ ' + s);
const log = (s) => console.log('  ' + s);
const skip = (s) => console.log('  · ' + s);
const plan = (s) => console.log('  + ' + s);

// --- Interactive plumbing ---------------------------------------------------
// Small on purpose: one question at a time, a default in brackets, Enter takes it.
// Every call sits behind INTERACTIVE, so none of this exists for CI.

/** One shared readline for the whole run, with its lines queued here rather than taken through
 *  question(). Two failure shapes force that design. Piped answers arrive all at once, and a
 *  line that lands between questions -- while the script is off validating the previous answer
 *  -- would be dropped by an interface with no question pending; the queue keeps it. And when
 *  stdin ends, a question that can never be answered must stop the run rather than hang the
 *  top-level await -- but not from inside the close event, where an answer already given may
 *  still be in flight as a microtask. So the end is only recorded, and the next unanswerable
 *  question is the thing that says so and stops. */
let rlShared = null;
let inputEnded = false;
let markEnded;
const endedSignal = new Promise((r) => { markEnded = r; });
const pendingLines = [];
let lineWaiter = null;
function rl() {
  if (!rlShared) {
    rlShared = readline.createInterface({ input: process.stdin, output: process.stdout });
    rlShared.on('SIGINT', () => { console.log(''); process.exit(130); });
    rlShared.on('close', () => { inputEnded = true; markEnded(); });
    rlShared.on('line', (l) => {
      if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); }
      else pendingLines.push(l);
    });
  }
  return rlShared;
}

/** One line in, one answer out. Empty answer takes the default. */
async function ask(q, def = '') {
  rl();
  process.stdout.write('  ? ' + q + (def ? ` [${def}] ` : ' '));
  let a;
  if (pendingLines.length) {
    a = pendingLines.shift();
    process.stdout.write(a + '\n');   // echo the queued answer so the transcript stays readable
  } else if (inputEnded) {
    a = null;
  } else {
    // The ended branch must not touch the queue: a .then() still runs after losing the race,
    // and a shift() in it would steal the line a later question is owed.
    a = await Promise.race([
      new Promise((r) => { lineWaiter = r; }),
      endedSignal.then(() => null),
    ]);
    if (a === null) {
      lineWaiter = null;
      if (pendingLines.length) a = pendingLines.shift();
    }
  }
  if (a === null) {
    console.error('\n✗ input ended before this question could be answered; stopping. Nothing further was changed.');
    process.exit(1);
  }
  return a.trim() || def;
}

/** A yes/no pause before something that changes live state. Non-interactive runs and --yes
 *  answer yes silently -- the old automatic behaviour. */
async function confirm(q, def = true) {
  if (!INTERACTIVE || args.yes) return true;
  const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return a === '' ? def : a === 'y' || a === 'yes';
}

/** Something only the dashboard can do was just explained above this call. Wait while the
 *  person does it, then tell the caller to check again. Returns false to give up --
 *  which is the only answer outside a terminal. */
async function fixAndRetry(what = 'When that is done') {
  if (!INTERACTIVE) return false;
  const a = (await ask(`${what} -- press Enter to check again, or q to stop:`)).toLowerCase();
  return a !== 'q' && a !== 'quit';
}

/** The person said no to a pause. Not an error and nothing is broken -- but the deploy did
 *  not finish, and a chained command (deploy && deploy) must not sail on. */
function stopped(msg) {
  console.log('\n■ ' + msg + '\n');
  process.exit(1);
}

async function cf(method, p, body) {
  return cfAs(TOKEN, method, p, body);
}

/** The same call, made with another token -- the second one meetings may be given.
 *  同样的调用,换一个令牌来做 —— 会议可能被交给的那第二个令牌。 */
async function cfAs(token, method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data.success !== false, data };
}

/** The first error Cloudflare gave, short enough to read. Never echo the request -- it carries the token.
 */
const why = (r) => {
  const e = r.data?.errors?.[0];
  return e ? `${e.code ? e.code + ' ' : ''}${e.message}` : `HTTP ${r.status}`;
};

/** Run wrangler with the token in the child's environment only. Returns the exit code.
 */
function wrangler(argv, { input } = {}) {
  const r = spawnSync(process.execPath, [wranglerBin(), ...argv], {
    cwd: ROOT,
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      // wrangler asks for confirmation on some commands; with a piped stdin it takes the
      // documented fallback instead of hanging -- and CI makes that choice explicit.
      CI: 'true',
    },
  });
  if (r.error) die('could not start wrangler: ' + r.error.message);
  return r.status ?? 1;
}

/** wrangler lives in node_modules; run its bin directly so this works without a global install.
 */
function wranglerBin() {
  const bin = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!fs.existsSync(bin)) die('wrangler not found -- run: npm install');
  return bin;
}

/** Same as wrangler(), but captures stdout so a check can read it.
 */
function wranglerOut(argv) {
  const r = spawnSync(process.execPath, [wranglerBin(), ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    input: 'y\n',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: accountId, CI: 'true' },
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------

console.log('\n=== CFMail deploy ===');
if (DRY) console.log('    (--dry-run: report only, change nothing)');

// --- 1. Token and account --------------------------------------------------

step('Token and account');
if (tokenSource === 'file') {
  log(`using the token saved in ${TOKEN_BASENAME} (pass --token, set CLOUDFLARE_API_TOKEN, or`);
  log('delete that file to use a different one)');
}
if (!TOKEN) {
  if (!INTERACTIVE) {
    console.error('\n✗ No API token given.\n');
    usage(1);
  }
  log('No token was given. Everything here is driven by a Cloudflare API token you create once:');
  log('  Cloudflare dashboard -> My Profile -> API Tokens -> Create Token -> Custom token');
  log('  (an account-owned token from Manage Account -> API Tokens works the same)');
  log('The permissions it needs are in the "API token permissions" table in the README. An');
  log('imperfect token is fine to start with: every missing permission is found and named');
  log('here, before anything is created, and you can fix the token and continue.');
  TOKEN = (await ask('Paste the API token (q to stop):')).trim();
  if (!TOKEN || TOKEN.toLowerCase() === 'q') stopped('No token -- nothing was created or changed.');
  tokenSource = 'asked';
}

// Listing accounts is both the validity check and the account lookup. The obvious endpoint,
// /user/tokens/verify, is the wrong one here: a token created under Account API Tokens is not
// owned by a user, and that endpoint answers "Invalid API Token" for a perfectly good one.
let accList;
for (;;) {
  const accounts = await cf('GET', '/accounts');
  accList = accounts.ok ? (accounts.data.result || []) : null;
  if (accList && accList.length) break;
  const reason = accList ? 'it is valid but can see no accounts at all' : why(accounts);
  const advice = 'this token does not work: ' + reason +
      '\n  Check that it was copied whole, that it has not expired, and that it carries at' +
      '\n  least one account-scope permission -- that is what makes accounts visible to it.' +
      '\n  A just-edited token takes about a minute to change behaviour.';
  if (!INTERACTIVE) die(advice);
  if (tokenSource === 'file') log(`(this token came from ${TOKEN_BASENAME} -- a new answer replaces it for this run)`);
  console.error('\n  ✗ ' + advice.replace(/\n {2}/g, '\n    '));
  const again = (await ask('Paste a corrected token, or press Enter to re-check this one (q to stop):')).trim();
  if (again.toLowerCase() === 'q') stopped('The token never validated; nothing was created or changed.');
  if (again) { TOKEN = again; tokenSource = 'asked'; }
}
log('token accepted');

let accountId = args.account || process.env.CLOUDFLARE_ACCOUNT_ID || savedAccountId || '';
let accountName = '';
if (accountId) {
  const hit = accList.find((a) => a.id === accountId);
  if (hit) {
    accountName = hit.name || '';
  } else {
    const listing = accList.map((a) => `    ${a.id}  ${a.name}`).join('\n');
    if (!INTERACTIVE) die(`this token cannot see account ${accountId}. It can see:\n` + listing);
    log(`⚠ this token cannot see account ${accountId}; picking from the ones it can see instead`);
    accountId = '';
  }
}
if (!accountId) {
  if (accList.length === 1) {
    accountId = accList[0].id;
    accountName = accList[0].name || '';
  } else if (!INTERACTIVE) {
    die('this token can see several accounts; name one with --account:\n' +
        accList.map((a) => `    ${a.id}  ${a.name}`).join('\n'));
  } else {
    log('this token can see several accounts:');
    accList.forEach((a, i) => log(`  ${i + 1}) ${a.id}  ${a.name}`));
    for (;;) {
      const pick = (await ask(`Deploy to which one? (1-${accList.length}, or paste an account id):`)).trim();
      const hit = /^\d+$/.test(pick) ? accList[Number(pick) - 1] : accList.find((a) => a.id === pick);
      if (hit) { accountId = hit.id; accountName = hit.name || ''; break; }
      log(`"${pick}" is neither a number in range nor a listed account id -- try again`);
    }
  }
}
log(`account ${accountId}${accountName ? ' (' + accountName + ')' : ''}`);

// A typed-in token can be kept for next time -- but only by explicit consent, which is why
// this does not go through confirm(): --yes speaks for deploy pauses, not for writing a
// credential to disk. The file is this machine's alone and .gitignore lists it by name;
// deleting it is how the choice is unmade. A saved token that stopped working and was
// re-typed defaults the other way -- the choice to keep one on disk was already made, and
// leaving a dead credential in the file helps nobody.
if (INTERACTIVE && tokenSource === 'asked') {
  const updating = fs.existsSync(TOKEN_FILE);
  const q = updating
    ? `The token saved in ${TOKEN_BASENAME} did not work; replace it with this one? (Y/n)`
    : `Save this token and account to ${TOKEN_BASENAME}, so the next run does not ask?\n` +
      `    It stays on this machine only, git ignores it, and deleting the file undoes this. (y/N)`;
  const a = (await ask(q)).toLowerCase();
  const yes = a === '' ? updating : (a === 'y' || a === 'yes');
  if (yes) {
    fs.writeFileSync(TOKEN_FILE, [
      '# Saved by scripts/deploy.mjs at your request, so the next deploy does not ask for a token.',
      '# Delete this file to be asked again. Never commit it -- .gitignore lists it by name.',
      `CLOUDFLARE_API_TOKEN=${TOKEN}`,
      `CLOUDFLARE_ACCOUNT_ID=${accountId}`,
      '',
    ].join('\n'), { mode: 0o600 });
    log(`${updating ? 'updated' : 'saved to'} ${TOKEN_BASENAME}`);
  } else if (updating) {
    log(`left ${TOKEN_BASENAME} as it is -- the stale token in it will be reported again next run`);
  }
}

// --- 1b. Token permissions -------------------------------------------------
//
// Every permission is probed, not assumed, and all of them are probed before anything is created.
// Finding out halfway through that the token cannot make a bucket leaves an account with a
// database and no bucket, and a person with a half-built deployment and an error about the part
// they were not thinking about.
//
// A token cannot be asked what it may do -- reading its own policy needs a permission a deploy
// token has no business holding. So each one is tested by making the smallest possible call that
// the permission gates. Where a read would not prove the right to write, the probe is a write
// with deliberately invalid input: the API answers "unauthorized" when the permission is missing
// and "invalid property" when it is present, and those two are easy to tell apart.

const AUTH_DENIED = (r) => r.status === 403 || [9109, 9106, 10000].includes(r.data?.errors?.[0]?.code);

async function probe(method, path, body) {
  const r = await cf(method, path, body);
  return !AUTH_DENIED(r);
}

/**
 * What this deployment needs, in the words the Cloudflare dashboard uses, each with the reason it
 * is needed. A missing permission is reported by both -- the name to look for, and what stops
 * working without it.
 */
async function checkPermissions(zoneId, quiet = false) {
  const checks = zoneId ? [] : [
    {
      name: 'Account · Workers Scripts · Edit',
      group: 'Workers Scripts Write',
      why: 'upload the Worker that is the mail system',
      run: () => probe('GET', `/accounts/${accountId}/workers/scripts`),
    },
    {
      name: 'Account · D1 · Edit',
      group: 'D1 Write',
      why: 'create the database and apply migrations to it',
      run: () => probe('POST', `/accounts/${accountId}/d1/database`, {}),
    },
    {
      name: 'Account · Workers R2 Storage · Edit',
      group: 'Workers R2 Storage Write',
      why: 'create the buckets that hold message bodies and backups',
      run: () => probe('POST', `/accounts/${accountId}/r2/buckets`, {}),
    },
  ];

  if (zoneId) {
    checks.push(
      {
        name: 'Zone · Zone · Read',
        group: 'Zone Read',
        why: 'find your domain in this account',
        run: () => probe('GET', `/zones/${zoneId}`),
      },
      {
        name: 'Zone · DNS · Edit',
        group: 'DNS Write',
        why: 'point the entry host at the Worker and write the mail records',
        run: () => probe('POST', `/zones/${zoneId}/dns_records`, {}),
      },
      {
        name: 'Zone · Workers Routes · Edit',
        group: 'Workers Routes Write',
        why: 'attach the entry host to the Worker',
        run: () => probe('GET', `/zones/${zoneId}/workers/routes`),
      },
      {
        name: 'Zone · Email Routing Rules · Edit',
        group: 'Email Routing Rules Write',
        why: 'deliver incoming mail to the Worker',
        run: () => probe('GET', `/zones/${zoneId}/email/routing`),
      },
    );
  }

  const missing = [];
  for (const c of checks) {
    const ok = await c.run().catch(() => false);
    if (ok) { if (!quiet) skip(c.name); }
    else { missing.push(c); if (!quiet) log('✗ ' + c.name); }
  }
  if (quiet) return missing;

  // Sending is checked apart from the rest because it is the one that can fail for a reason that
  // is not a permission at all: an account that is not on Workers Paid is refused with the same
  // word, "Unauthorized". Saying so here saves an afternoon of auditing a token that was fine.
  if (zoneId) {
    let send = await cf('GET', `/zones/${zoneId}/email/sending/subdomains`);
    // A token that can read its own policy settles which of the two causes it is, and mends the
    // one that is a permission. / 读得到自己策略的令牌能分清是两种原因里的哪一种,并把"权限"那一种补上。
    if (AUTH_DENIED(send)) {
      const own = await ownToken(cf, accountId);
      if (own && grantedNames(own).has('Email Sending Write')) {
        log('⚠ Email Sending: this token HAS the permission, so the refusal is the plan -- outward');
        log('  sending needs Workers Paid. Everything else installs; the "Sending mail" step says more.');
        return missing;
      }
      if (own && await addToToken([{ name: 'Account · Email Sending · Edit', group: 'Email Sending Write', why: 'send mail to the outside world' }])) {
        send = await cf('GET', `/zones/${zoneId}/email/sending/subdomains`);
      }
    }
    if (AUTH_DENIED(send)) {
      log('⚠ Zone · Email Sending · Edit -- absent, or this account is not on Workers Paid.');
      log('  Everything still installs and the domain still receives mail; only sending to the');
      log('  outside world needs this, and the API answers "Unauthorized" for both causes alike.');
      log('  If sending out matters to you, either fix works and can be made now or later:');
      log('    plan:  dashboard -> Workers & Pages -> Plans -> Workers Paid ($5/month --');
      log('           receiving and internal mail stay free, only outward sending needs it)');
      log('    token: add Account · Email Sending · Edit (it lives under Account scope,');
      log('           not under Zone, where a similarly named receiving permission sits)');
      log('  The "Sending mail" step at the end tries again and waits there if it still cannot.');
    } else {
      skip('Zone · Email Sending · Edit');
    }
  }

  return missing;
}

/**
 * Permissions are a thing the dashboard fixes and this script can only name. So naming them is
 * done as precisely as possible, and then -- in a terminal -- the script waits, lets the person
 * edit the token, and probes again, as many times as it takes. Nothing exists yet at this point,
 * so patience costs nothing.
 */
/**
 * Add permissions to the token this run is using, when it is a token that may: one carrying
 * "Account API Tokens · Edit" can mend itself, and then nobody has to go to the dashboard. Each
 * addition is named on the screen as it is made. Returns true when something was added (and, not
 * under --dry-run, has had a moment to take effect); false when the token may not do this or
 * nothing could be added, which sends the caller back to naming the permission and asking.
 *
 * 给本次运行所用的令牌加权限 —— 前提是它有这个资格:带着 "Account API Tokens · Edit" 的令牌可以自己补自己,
 * 于是不必有人跑一趟 dashboard。每加一项,都在加的那一刻把名字打在屏幕上。
 * 加上了就返回 true(非 --dry-run 时还会等它生效片刻);令牌没这个资格、或什么都没加上,返回 false ——
 * 调用方于是退回到"报出权限名、请人去加"。
 */
async function addToToken(items, settled = null) {
  const res = await grantSelf(cf, accountId, items.map((m) => m.group), { dry: DRY });
  if (res.denied) return false;
  if (res.why) { log('⚠ this token may edit tokens, but adding to it failed: ' + res.why); return false; }
  if (res.unknown?.length) log('⚠ Cloudflare lists no permission called ' + res.unknown.join(', ') + '; it has to be added by hand');
  if (!res.added?.length) return false;
  for (const m of items) if (res.added.includes(m.group)) plan(`${DRY ? 'would add' : 'added'} to this token: ${m.name} -- needed to ${m.why}`);
  if (DRY) return true;
  // A fresh grant takes a little while to be honoured everywhere. / 新加的权限要过一会儿才会处处生效。
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, i ? 8000 : 3000));
    if (!settled || await settled()) return true;
  }
  return true;
}

async function ensurePermissions(zoneId) {
  let mended = false;
  for (;;) {
    const missing = await checkPermissions(zoneId);
    if (!missing.length) return;
    if (!mended) {
      mended = true;
      const did = await addToToken(missing, async () => !(await checkPermissions(zoneId, true)).length);
      if (did) { if (DRY) return; log('probing again'); continue; }
    }
    const advice = 'This token is missing ' + missing.length + ' permission' + (missing.length > 1 ? 's' : '') + ':\n\n'
      + missing.map((m) => `    ${m.name}\n      needed to ${m.why}`).join('\n\n')
      + '\n\n  Add them at Cloudflare dashboard -> My Profile -> API Tokens -> your token -> Edit'
      + '\n  (an account-owned token lives at Manage Account -> API Tokens instead).'
      + '\n  Account-scope permissions are in the "Account Resources" section, zone-scope ones in'
      + '\n  "Zone Resources"; several exist in both lists and only one of the two counts.'
      + '\n  Changes take about a minute to take effect. Nothing has been created yet.'
      + '\n\n  Or add just ONE: Account · Account API Tokens · Edit (User · API Tokens · Edit on a'
      + '\n  user-owned token). A token that has it is given everything else by this script, which'
      + '\n  names each permission as it adds it -- now and whenever a later version needs another.';
    if (!INTERACTIVE) die(advice);
    console.error('\n  ✗ ' + advice.replace(/\n/g, '\n  '));
    if (!(await fixAndRetry('Edit the token there'))) {
      stopped('Permissions still missing -- nothing was created or changed.');
    }
    log('probing again (a fresh edit can take about a minute to show up)');
  }
}

/**
 * Claim the account's workers.dev subdomain, if it has never claimed one.
 *
 * Every account has exactly one <name>.workers.dev, and Cloudflare refuses to accept a Worker at
 * all until the account has taken its name -- a brand-new account's first deploy stops with
 * "You need a workers.dev subdomain in order to proceed" (10063). The dashboard claims it as a
 * side effect of opening the Workers page for the first time, which is a strange thing to make
 * somebody go and do, so this asks for it directly.
 *
 * The name is nearly beside the point here: this deployment serves the mail client from the entry
 * hosts and leaves the Worker's own workers.dev route switched off, so nothing is ever reachable
 * at the name that is being taken. It has to exist; it does not have to be pretty. An account
 * that already has one keeps it -- the name is global and somebody may be using it.
 *
 *
 *
 */
/** What is in an image's directory (container/ unless told otherwise), as twelve hex characters
 *  -- the same twelve the publisher recorded, so the two can tell whether the published image
 *  still stands for the source in this checkout.
 *  镜像目录(默认 container/)里有什么,压成十二个十六进制字符 —— 与发布者记下的是同样的十二个,
 *  于是两边分得清"已发布的镜像是否仍代表这份 checkout 里的源码"。
  */
function containerHash(name = 'container') {
  const dir = path.join(ROOT, name);
  // published.json is a note about this hash, so it cannot be part of it -- writing the note
  // would change the answer it records, and the published image would never match again.
  // Files only: a cache directory left by running something locally is not source.
  // 只算文件:在本地跑过点什么留下的缓存目录不是源码。
  const names = fs.readdirSync(dir).filter((n) => n !== 'published.json' && fs.statSync(path.join(dir, n)).isFile()).sort();
  const h = crypto.createHash('sha256');
  for (const n of names) {
    h.update(n);
    h.update(fs.readFileSync(path.join(dir, n)));
  }
  return h.digest('hex').slice(0, 12);
}

/**
 * The image published for everybody, and the container sources it was built from.
 *
 * Cloudflare pulls public images itself, so an installation referencing one needs no Docker, no
 * registry account and no build -- the file below is the whole of what makes that true. It
 * records the hash of container/ as it was when the image was pushed, and a deploy uses the
 * image only while that still matches what is in this checkout: an image is a promise about
 * source, and the moment the source moves on, the promise is void and the deploy builds instead.
 *
 *
 */
function publishedImage() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'container', 'published.json'), 'utf8'));
    return p && typeof p.image === 'string' && typeof p.source === 'string' ? p : null;
  } catch {
    return null;
  }
}

async function backupImage(text) {
  const configured = containerImage(text);
  const published = publishedImage();
  // An image this script put there is one it may replace -- that is the published reference, or
  // a tag it built back when it still built things. Anything else was chosen by a person and
  // stays chosen: an operator managing their own image does not want it renamed underneath them.
  const repo = published ? published.image.split(':')[0] : '';
  const ours = /:[0-9a-f]{12}$/.test(configured) || (repo && configured.startsWith(repo + ':'));
  if (configured && !ours) return configured;

  if (!published) {
    log('⚠ container/published.json is missing, so there is no image to point the backup at.');
    log('  Everything else installs; the Backup tab will say the backup is unavailable.');
    return '';
  }
  // The published image is a claim about container/. When this checkout has moved on, the claim
  // is stale -- which matters to whoever changed it, not to somebody installing, so it is said
  // plainly and the install carries on with the image that does exist.
  if (published.source !== containerHash()) {
    log('⚠ container/ differs from what the published image was built from.');
    log(`  Using ${published.image} anyway. To ship your own changes, publish them:`);
    log('    node scripts/publish-image.mjs --repo <your public repository>');
    log('  or pass --backup-image <ref> to point at an image you built yourself.');
  }
  if (configured !== published.image) plan(`backup image -> ${published.image} (pulled by Cloudflare; no Docker here)`);
  return published.image;
}

async function ensureWorkersSubdomain() {
  const cur = await cf('GET', `/accounts/${accountId}/workers/subdomain`);
  const have = cur.ok && cur.data?.result?.subdomain;
  if (have) return skip(`workers.dev subdomain: ${have}`);

  // The name is taken once and kept: the API refuses to change it afterwards (10036), and every
  // Worker this account ever hosts is named under it. Nothing here is served from it, but the
  // next thing on the account might want to be, so in a terminal the choice is offered rather
  // than made -- with a name derived from the account id for anyone who does not care.
  const fallback = 'cfmail-' + accountId.slice(0, 12);
  let want = fallback;
  if (INTERACTIVE) {
    log('This account has never taken its workers.dev subdomain, and Cloudflare will not accept');
    log('a Worker until it does. The mail client is served from your own domain, so nothing will');
    log('be reachable at this name -- but it is permanent, and shared by anything else you host');
    log('on this account later.');
    want = (await ask('workers.dev subdomain', fallback)).trim().toLowerCase() || fallback;
  }
  const res = await cf('PUT', `/accounts/${accountId}/workers/subdomain`, { subdomain: want });
  if (res.ok) return plan(`workers.dev subdomain -> ${want} (nothing is served from it)`);

  die('this account has no workers.dev subdomain, and claiming one failed: ' + why(res)
    + `\n  Cloudflare will not accept a Worker until the account has one (error 10063).`
    + `\n  Take one by hand -- either is enough, and both take a moment:`
    + `\n    dashboard: Workers & Pages -> opening the page claims one automatically`
    + `\n    or a name of your choosing: Workers & Pages -> Subdomain`
    + `\n  Then run this again. Nothing has been created yet.`);
}

// --- 2. Existing state ----------------------------------------------------

step('Token permissions');
await ensurePermissions(null);

step('Account setup');
await ensureWorkersSubdomain();

step('What the account already has');
const readCfg = (file, label) => {
  try {
    return JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    die(`${label} is not valid JSONC and cannot be read: ${e.message}
  Fix it, or move it aside and run this again.`);
  }
};
/** The account a config claims, ignoring the template's placeholder */
const ownerOf = (c) => (typeof c?.account_id === 'string' && !c.account_id.includes('<') ? c.account_id : '');
const mainCfg = fs.existsSync(MAIN_CONFIG) ? readCfg(MAIN_CONFIG, 'wrangler.jsonc') : null;
const mainOwner = ownerOf(mainCfg);
let existing = null;
if (!mainCfg || !mainOwner || mainOwner === accountId) {
  CONFIG = MAIN_CONFIG;
  existing = mainCfg;
} else {
  CONFIG = path.join(ROOT, `wrangler.acct-${accountId}.jsonc`);
  existing = fs.existsSync(CONFIG) ? readCfg(CONFIG, path.basename(CONFIG)) : null;
}
const CFG_NAME = path.basename(CONFIG);
const haveConfig = !!existing;

const svc = await cf('GET', `/accounts/${accountId}/workers/services/${WORKER}`);
const workerExists = svc.status !== 404 && svc.ok;
// The tag this account last applied, and the Durable Object classes it already has. A migration
// that creates a class can run once; knowing which ones are done is what keeps a configuration
// from asking for them twice, which Cloudflare refuses -- permanently, and for the whole deploy.
const appliedTag = svc.data?.result?.default_environment?.script?.migration_tag || null;
const doClasses = workerExists
  ? ((await cf('GET', `/accounts/${accountId}/workers/durable_objects/namespaces`)).data?.result || [])
    .filter((n) => n.script === WORKER)
    .map((n) => n.class)
  : [];

const d1list = await cf('GET', `/accounts/${accountId}/d1/database?name=${D1_NAME}`);
if (!d1list.ok) die('could not list D1 databases: ' + why(d1list));
const d1 = (d1list.data.result || []).find((d) => d.name === D1_NAME) || null;

const r2list = await cf('GET', `/accounts/${accountId}/r2/buckets`);
if (!r2list.ok) die('could not list R2 buckets: ' + why(r2list));
const r2 = (r2list.data.result?.buckets || []).find((b) => b.name === R2_NAME) || null;
const bk = (r2list.data.result?.buckets || []).find((b) => b.name === BK_NAME) || null;

log(`Worker "${WORKER}"      ${workerExists ? 'exists' : 'not there'}`);
log(`D1 "${D1_NAME}"         ${d1 ? 'exists ' + d1.uuid : 'not there'}`);
log(`R2 "${R2_NAME}"     ${r2 ? 'exists' : 'not there'}`);
log(`R2 "${BK_NAME}"  ${bk ? 'exists' : 'not there'}`);
log(`local ${CFG_NAME.padEnd(14)} ${haveConfig ? 'found' : 'none'}`);
if (CONFIG !== MAIN_CONFIG) {
  log(`  wrangler.jsonc belongs to account ${mainOwner}, not this one -- using ${CFG_NAME} instead, leaving that file alone`);
  log('  (npm run dev and npm run deploy:worker still read wrangler.jsonc, and are unrelated to this deploy)');
}

// The dangerous combination is exactly one: this account already carries something by these
// names, but this checkout has no configuration proving it is the same deployment. Deploying
// anyway would publish over somebody else's Worker and adopt their database. Everything else --
// both present, or both absent -- is an ordinary upgrade or an ordinary first install.
//
// In a terminal the question is asked outright, and it is the one question --yes does not
// answer: adopting somebody else's deployment by reflex is the exact accident this guard is for,
// so the yes has to be typed (or given as --adopt, which is the same deliberate act).
if (!haveConfig && (workerExists || d1 || r2)) {
  if (args.adopt) {
    log('--adopt: taking over the existing resources; their data is untouched');
  } else if (INTERACTIVE) {
    log(`⚠ this account already holds resources by these names, but there is no ${CFG_NAME} here`);
    log('  to prove they are the same deployment.');
    log('  If they are a CFMail you installed earlier: adopting keeps all their data, and this');
    log('  run becomes an ordinary upgrade. If you are not sure what they are, answer no and');
    log('  look at the account first -- publishing over somebody else\'s Worker is not undoable.');
    const a = (await ask('Adopt these existing resources? (yes/No)')).toLowerCase();
    if (a !== 'y' && a !== 'yes') {
      stopped('Left the existing resources untouched. Run again and answer yes (or pass --adopt) once you are sure they are yours.');
    }
    log('adopting: their data is untouched');
  } else {
    die(`this account already holds resources by these names, but there is no ${CFG_NAME} here to prove they are the same deployment.\n` +
        '  If this is a CFMail you installed earlier and you mean to keep it (all data is preserved), run again with --adopt:\n' +
        `    node scripts/deploy.mjs --token <token> --domain ${domain || '<domain>'} --entry ${entryArg || '<subdomain>'} --adopt\n` +
        '  If it is not, change these names or use another account -- otherwise this would overwrite somebody else\'s.');
  }
}

// A first install has no routes to read the domain and entry host back from, so they have to
// come from somewhere -- and in a terminal, "somewhere" can be a question with an explanation,
// rather than an error naming a flag.
const routesKnown = (existing?.routes || []).filter((r) => r?.custom_domain && typeof r.pattern === 'string' && !r.pattern.includes('<'));
if (INTERACTIVE && !routesKnown.length && !domain) {
  log('');
  log('This looks like a first install: no entry host is configured yet. One domain is needed');
  log('to start -- mail will be received on it, and the web client served from a subdomain.');
  log('The domain must already be in this Cloudflare account as a full zone (the domain using');
  log('Cloudflare\'s nameservers); if it is not there yet, the next step says how to add it.');
  for (;;) {
    const d = (await ask('Domain to connect (e.g. example.com; q to stop):')).trim().toLowerCase();
    if (d === 'q') stopped('A first install needs a domain. Nothing has been created or changed yet.');
    if (DOMAIN_RE.test(d)) { domain = d; break; }
    log(`"${d}" does not look like a domain name -- letters, digits, dots and dashes only`);
  }
}
if (INTERACTIVE && !routesKnown.length && domain && !entryArg) {
  for (;;) {
    const e = (await ask(`Entry subdomain -- the web client will live at https://<this>.${domain}`, 'mail')).trim().toLowerCase();
    if (LABEL_RE.test(e)) { entryArg = e; break; }
    log(`"${e}" is not a valid DNS label -- letters, digits and dashes only`);
  }
  log(`the entry host will be ${entryArg}.${domain}`);
}

// --- 2b. Meetings and broadcasts ------------------------------------------
// Meetings need a Realtime app, created once by a token that may create one; broadcasts need a
// token for Stream that lives in the Worker. A deploy token carrying "Account API Tokens · Edit"
// sees to both by itself once the Worker is published: it adds the Calls permission to itself
// and makes the Stream token. A token without it cannot, and then the person deploying chooses
// -- here, before anything is created:
//   1) hand over a second token, just for meetings and broadcasts;
//   2) switch them off on this deployment -- remembered in the configuration (and read by the
//      Worker), so the question is not asked again; --meetings on brings them back;
//   3) add that one permission to the deploy token, and let this script make the second token.
// Outside a terminal, and under --yes, nothing is asked: the three ways are printed with their
// flags, and whatever is missing stays off for this run. (A --dry-run in a terminal does ask:
// the answer changes nothing, and it is how the choice can be tried out.)
//
// 会议需要一个 Realtime app,由有权创建它的令牌建一次;直播需要一个留在 Worker 里的 Stream 令牌。
// 带 "Account API Tokens · Edit" 的部署令牌会在 Worker 发布之后自己把两样都办好:给自己加上 Calls 权限,
// 再建那个 Stream 令牌。不带它的令牌办不到,于是由部署的人来选 —— 就在这里、在任何东西被创建之前:
//   1) 另交一个会议/直播专用的令牌;
//   2) 在这套部署上关掉它们 —— 记在配置里(Worker 也读它),以后不再问;--meetings on 可以再打开;
//   3) 给部署令牌加上那一项权限,让本脚本自己建那个专用令牌。
// 不在终端里、或带 --yes 时什么都不问:把三条路连同参数打印出来,缺的部分这一次保持关闭。
// (在终端里跑 --dry-run 照样会问:回答什么都不改动,正好用来试一试这个选择。)

const MEET_MODES = ['on', 'no-live', 'off'];
const savedMeetMode = MEET_MODES.includes(String(existing?.vars?.MEETINGS || '')) ? String(existing.vars.MEETINGS) : '';
let meetMode = args.meetings !== undefined ? String(args.meetings) : savedMeetMode || 'on';
// --stream-token is the older name of --meet-token. / --stream-token 是 --meet-token 的旧名字。
let meetToken = String(args['meet-token'] || args['stream-token'] || '').trim();
const REALTIME_SECRETS = ['REALTIME_APP_ID', 'REALTIME_APP_SECRET', 'TURN_KEY_ID', 'TURN_KEY_TOKEN'];

/** Whether this run's token may create tokens -- and so add to itself, and make the second one.
 *  本次运行的令牌能否创建令牌 —— 也就能给自己加权限、能建第二个令牌。 */
async function tokenMakesTokens() {
  const own = await ownToken(cf, accountId);
  return !!own && [...grantedNames(own)].some((n) => /API Tokens Write$/i.test(n));
}

/** What a token can do for meetings: create the Realtime app, and reach Stream.
 *  一个令牌在会议上能做什么:建 Realtime app、够得着 Stream。 */
async function meetReach(token) {
  const calls = await cfAs(token, 'GET', `/accounts/${accountId}/calls/apps`);
  const stream = await cfAs(token, 'GET', `/accounts/${accountId}/stream/live_inputs`);
  return {
    calls: calls.ok,
    stream: stream.ok ? 'ok' : AUTH_DENIED(stream) || stream.status === 400 || stream.status === 401 ? 'denied' : 'error',
    streamWhy: stream.ok ? '' : why(stream),
  };
}

step('Meetings and broadcasts');
if (meetMode === 'off') {
  skip('switched off on this deployment (npm run deploy -- --meetings on brings them back)');
} else {
  const listedEarly = workerExists ? await cf('GET', `/accounts/${accountId}/workers/scripts/${WORKER}/secrets`) : null;
  const had = new Set((listedEarly?.ok ? listedEarly.data?.result || [] : []).map((s) => s.name));
  for (;;) {
    const needMeet = !REALTIME_SECRETS.every((n) => had.has(n));
    const needLive = meetMode === 'on' && !had.has('STREAM_API_TOKEN');
    if (!needMeet && !needLive) {
      skip(meetMode === 'on' ? 'meetings and broadcasts are set up' : 'meetings are set up; broadcasts are switched off on this deployment');
      break;
    }
    if (await tokenMakesTokens()) {
      skip('this token may create tokens: what meetings still need is made after the Worker is published');
      break;
    }
    const deployCalls = !needMeet || (await cf('GET', `/accounts/${accountId}/calls/apps`)).ok;
    const given = meetToken ? await meetReach(meetToken) : null;
    if (given) {
      // Read-only probes on purpose: a create with an empty body might create something.
      // 刻意只做只读探测:一次空请求体的"创建"可能真的建出东西来。
      log('the token given for meetings ' + (given.calls ? 'reaches' : 'does not reach') + ' Realtime (Calls), and '
        + (given.stream === 'ok' ? 'reaches Stream' : given.stream === 'denied' ? 'has no Stream permission' : `Stream answers it: ${given.streamWhy}`));
    }
    const meetOk = !needMeet || deployCalls || !!given?.calls;
    const liveOk = !needLive || given?.stream === 'ok';
    if (meetOk && liveOk) {
      if (given) log('it is used after the Worker is published' + (needLive ? ', and kept in the Worker for Stream' : ''));
      break;
    }

    const what = [!meetOk && 'meetings', !liveOk && 'broadcasts'].filter(Boolean).join(' and ');
    log(`This token cannot create API tokens (it lacks Account · Account API Tokens · Edit), so it`);
    log(`cannot set up ${what} by itself. What ${what} need:`);
    if (!meetOk) log('    Account · Calls · Edit       (newer dashboards call it "Realtime"; used once, to create the app)');
    if (!liveOk) log('    Account · Stream · Edit      (kept in the Worker: broadcasts use it while they run)');
    log('Three ways on:');
    log('  1) give a second token, just for meetings and broadcasts, with the permission' + (!meetOk && !liveOk ? 's' : '') + ' above and nothing else');
    log(`  2) switch ${what} off on this deployment -- remembered, so this is not asked again`);
    log('     (npm run deploy -- --meetings on brings them back)');
    log('  3) add ONE permission to this deploy token, and this script makes the rest:');
    log('       Account · Account API Tokens · Edit      (User · API Tokens · Edit on a user-owned token)');
    if (!INTERACTIVE || args.yes) {
      log(`Not asked here (${args.yes ? '--yes' : 'not a terminal'}): ${what} stay off for this run. Next time:`);
      log(`  1) --meet-token <token>    2) --meetings ${meetOk ? 'no-live' : 'off'}    3) edit the token, then run this again`);
      break;
    }
    const pick = (await ask('Which one? (1, 2 or 3):')).trim();
    if (pick === '1') {
      const t = (await ask('Paste the token for meetings and broadcasts (Enter to go back):')).trim();
      if (!t) continue;
      if (t === TOKEN) { log('that is the deploy token itself -- the one that cannot do this; give another'); continue; }
      meetToken = t;
      continue;
    }
    if (pick === '2') {
      meetMode = meetOk ? 'no-live' : 'off';
      log(meetMode === 'off' ? 'meetings and broadcasts will be switched off on this deployment' : 'broadcasts will be switched off on this deployment; meetings stay');
      log('(npm run deploy -- --meetings on brings them back)');
      break;
    }
    if (pick === '3') {
      log('Cloudflare dashboard -> My Profile -> API Tokens -> this token -> Edit');
      log('(an account-owned token is under Manage Account -> API Tokens), and add the one permission.');
      log('A fresh edit takes about a minute to take effect.');
      let ready = false;
      while (await fixAndRetry('Add it there')) {
        if ((ready = await tokenMakesTokens())) break;
        log('not there yet (a fresh edit can take a minute)');
      }
      if (ready) {
        log('this token may now create tokens: the rest is made after the Worker is published');
        break;
      }
      continue;
    }
    log('answer 1, 2 or 3');
  }
}

// --- 3. Resources ---------------------------------------------------------

step('Database and buckets');
let databaseId = d1?.uuid || existing?.d1_databases?.[0]?.database_id || '';
if (databaseId && databaseId.includes('<')) databaseId = '';   // a placeholder from the template does not count

if (d1) {
  skip(`D1 "${D1_NAME}" exists, using it (${d1.uuid})`);
  databaseId = d1.uuid;
} else if (DRY) {
  plan(`create D1 "${D1_NAME}"`);
} else {
  const made = await cf('POST', `/accounts/${accountId}/d1/database`, { name: D1_NAME });
  if (!made.ok) die('could not create the D1 database: ' + why(made));
  databaseId = made.data.result.uuid;
  log(`created D1 "${D1_NAME}" (${databaseId})`);
}

if (r2) skip(`R2 bucket "${R2_NAME}" exists, using it`);
else if (DRY) plan(`create R2 bucket "${R2_NAME}"`);
else {
  const made = await cf('POST', `/accounts/${accountId}/r2/buckets`, { name: R2_NAME });
  if (!made.ok) die('could not create the R2 bucket: ' + why(made));
  log(`created R2 bucket "${R2_NAME}"`);
}

// The backup lives in a bucket of its own, so that the application's own delete paths --
// emptying a trash, purging a mailbox, removing a user -- cannot reach it.
if (bk) skip(`R2 bucket "${BK_NAME}" exists, using it`);
else if (DRY) plan(`create R2 bucket "${BK_NAME}" (for the automatic backup)`);
else {
  const made = await cf('POST', `/accounts/${accountId}/r2/buckets`, { name: BK_NAME });
  if (!made.ok) die('could not create the backup bucket: ' + why(made));
  log(`created R2 bucket "${BK_NAME}"`);
}

// --- 4. Zone --------------------------------------------------------------

let zone = null;
if (domain) {
  step(`Domain ${domain}`);
  // Three of the four ways this lookup fails are fixed in the dashboard, not here -- adding the
  // domain to Cloudflare, converting it to a full zone, widening the token. So each failure says
  // exactly what to do there, and in a terminal the script waits and looks again.
  for (;;) {
    const zones = await cf('GET', `/zones?name=${encodeURIComponent(domain)}`);
    if (!zones.ok) {
      log('✗ could not look up the zone: ' + why(zones));
      log('  The token needs Zone · Zone · Read -- in the token editor it sits under');
      log('  "Zone Resources" (scope it to all zones or at least to this one).');
      if (INTERACTIVE && (await fixAndRetry('Edit the token'))) continue;
      die('the zone could not be looked up; see above for the fix. The database and buckets already created are reused by the next run.');
    }
    zone = (zones.data.result || [])[0];
    if (!zone) {
      log(`✗ ${domain} is not in this Cloudflare account yet. Adding it is a dashboard step:`);
      log('    dashboard -> Add a site -> enter the domain -> Free plan is fine ->');
      log('    then set the two nameservers it shows at your domain registrar.');
      log('  The zone shows up here the moment it is added; mail starts flowing only after the');
      log('  nameservers take effect, but the deploy does not need to wait for that part.');
      if (INTERACTIVE && (await fixAndRetry('Add it there'))) continue;
      die(`${domain} is not in this account. Add it to Cloudflare first, then run this again -- everything created so far is reused.`);
    }
    if (zone.account?.id && zone.account.id !== accountId) {
      die(`${domain} belongs to account ${zone.account.id} (${zone.account.name || '?'}), not to the one being deployed to (${accountId}).\n` +
          '  Either deploy into that account instead (--account, or the matching token), or move the\n' +
          '  domain between accounts in the dashboard first.');
    }
    // Email Routing needs the zone's own nameservers. A partial (CNAME) setup cannot receive mail,
    // and finding that out after everything else is built is a poor way to learn it.
    if (zone.type && zone.type !== 'full') {
      log(`✗ ${domain} is set up as a "${zone.type}" zone, and Email Routing needs a full one --`);
      log('  the domain using Cloudflare\'s own nameservers, not a CNAME setup.');
      log('  Converting is a dashboard action: the domain -> Overview -> convert to full setup,');
      log('  then update the nameservers at the registrar.');
      if (INTERACTIVE && (await fixAndRetry('Convert it there'))) continue;
      die(`${domain} is a "${zone.type}" zone. Email Routing needs a full zone -- convert it, then run this again.`);
    }
    break;
  }
  if (zone.status !== 'active') log(`⚠ this zone's status is "${zone.status}"; mail will not arrive until the nameservers take effect`);
  log(`zone ${zone.id}(${zone.status})`);
  // The zone-scope permissions can only be probed once there is a zone to probe them against --
  // and like the account-scope ones, a missing one is named, fixed in the dashboard, re-probed.
  await ensurePermissions(zone.id);
}

// --- 5. Configuration -----------------------------------------------------

step(`Configuration ${CFG_NAME}`);
let text = haveConfig ? fs.readFileSync(CONFIG, 'utf8') : fs.readFileSync(TEMPLATE, 'utf8');
if (!haveConfig) {
  log('generating it from wrangler.example.jsonc');
  // Rebuilding from the template recovers everything the account can be asked about, and
  // nothing else. Optional settings that live only in this file -- the Turnstile sitekey, a
  // non-default sending channel -- go back to their defaults, and saying so now is better than
  // having someone notice weeks later that the captcha quietly stopped appearing.
  if (workerExists) {
    log('⚠ the configuration was rebuilt from the template: only what the account can be asked about came back.');
    log('  The Turnstile sitekey and any non-default sending channel are back at their defaults -- set them again if you need them.');
  }
}

// The entry prefix has exactly one home: the routes already in the file. An argument overrides
// it, and on a first install there is nothing to read, so one must be given.
const routesNow = (existing?.routes || []).filter((r) => r?.custom_domain && typeof r.pattern === 'string' && !r.pattern.includes('<'));
const derived = routesNow.length ? routesNow[0].pattern.split('.')[0] : '';
const entry = entryArg || derived;
if (domain && !entry) {
  die('the first deploy needs --entry to name the entry subdomain, e.g. --entry mail -> https://mail.' + domain);
}
// A first install with no domain would deploy a Worker nobody can reach and leave APP_ORIGIN a
// placeholder, so the invite links it later mints would point nowhere.
if (!domain && !routesNow.length) {
  die('the first deploy needs --domain to name a domain, e.g.:\n' +
      '    node scripts/deploy.mjs --token <token> --domain example.com --entry mail');
}
const host = domain ? `${entry}.${domain}` : '';

text = text
  .replace(/"account_id"\s*:\s*"[^"]*"/, `"account_id": "${accountId}"`)
  .replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${databaseId}"`);

// A configuration written before the backup bucket existed has no binding for it, and would
// deploy a Worker that can never back anything up.
{
  const withBk = withBucket(text, 'BACKUP', BK_NAME);
  if (withBk === null) die(`no r2_buckets array in ${CFG_NAME}`);
  if (withBk !== text) { text = withBk; plan(`r2_buckets gains BACKUP -> ${BK_NAME}`); }
}
// --- Backup container -----------------------------------------------------
// The container goes in whether or not this deployment has switched backups on. Writing it in
// later, only for those who ask, means two shapes of configuration to reason about and a feature
// that is missing in a way nobody notices until they need it. One shape, one prerequisite: a
// deployment carries the container, and `wrangler dev` therefore wants an API token.
//
{
  // The backup needs a container, a container needs an image, and the image is built from
  // container/ in this repository -- so the deploy builds it rather than asking somebody to go
  // and do it first. What it will not do is write down an image nobody made: a container naming
  // one that does not exist fails the entire deploy, mail and all, with an error about a Worker
  // version that has nothing to do with the cause.
  //
  const image = args['backup-image'] || await backupImage(text);
  if (image) {
    const withBk = withBackupContainer(text, image);
    if (withBk === null) log('⚠ no durable_objects / migrations in the configuration; skipping the backup container');
    else if (withBk !== text) { text = withBk; plan(`backup container -> ${image}`); }
  } else if (hasPlaceholderContainer(text)) {
    // Nothing to point the container at, and it is already written down: take it out, or the
    // deploy fails on it. Refusing to edit is the fallback -- a mangled config is not.
    const without = withoutBackupContainer(text);
    if (without) { text = without; plan('backup container removed (no image to point it at)'); }
    else {
      die('this configuration carries a backup container with no image, and it could not be\n'
        + '  removed automatically. Deploying it fails inside the container rollout, with an error\n'
        + '  about a Worker version that has nothing to do with the cause.\n\n'
        + `  Delete these three from ${path.basename(CONFIG)} by hand:\n`
        + '    the "containers" array,\n'
        + '    the { "name": "BACKUP_CONTAINER", ... } line under durable_objects,\n'
        + '    and the migrations entry naming "BackupContainer"\n\n'
        + '  Everything else then works; the Backup tab says the backup is unavailable.');
    }
  } else {
    skip('backup container: not configured (see "Backups" in the README)');
  }
  const v1 = withVar(text, 'CF_ACCOUNT_ID', accountId);
  const v2 = v1 && withVar(v1, 'CF_D1_DATABASE_ID', databaseId);
  if (v2) text = v2;
  const withDev = withDevContainersOff(text);
  if (withDev && withDev !== text) { text = withDev; plan('dev.enable_containers = false (local development will not pull the image)'); }
}

// --- Meetings: the room ---------------------------------------------------
// A configuration written before meetings existed has no binding for the room a meeting is held
// in, and the template is only ever read on a first install. Without this the Worker deploys,
// the binding is simply absent, and meetings report themselves unavailable for a reason nobody
// can see. The SFU app that meetings also need is made further down, once the Worker exists.
{
  const withMeet = withDurableObject(text, 'MEET_ROOM', 'MeetRoom');
  if (withMeet === null) log('⚠ no durable_objects / migrations in the configuration; meetings stay off');
  else if (withMeet !== text) { text = withMeet; plan('durable_objects gains MEET_ROOM (the room a meeting is held in)'); }
  // A broadcast's audience -- its chat, its queue to speak -- has objects of its own. Without
  // them viewers can still watch; they just cannot say anything.
  // 直播的观众 —— 聊天、申请发言 —— 有自己的对象。没有它们,观众照样能看,只是说不了话。
  const withAud = withMeet === null ? null : withDurableObject(text, 'MEET_AUDIENCE', 'MeetAudience');
  if (withAud && withAud !== text) { text = withAud; plan('durable_objects gains MEET_AUDIENCE (a broadcast\'s chat and its queue to speak)'); }
  // What was decided about meetings above, kept for the next run and read by the Worker. A
  // configuration that never said is left saying nothing: absent means "on".
  // 上面对会议做的决定,留给下一次运行,也由 Worker 读取。从没写过的配置就继续不写:缺省即 "on"。
  if (meetMode !== 'on' || savedMeetMode) {
    const v = setVar(text, 'MEETINGS', meetMode);
    if (v === null) log('⚠ no "vars" in the configuration; the meetings setting could not be recorded');
    else if (v !== text) { text = v; plan(`vars.MEETINGS = "${meetMode}"`); }
  }
}

// --- Meetings: the compositor ----------------------------------------------
// A broadcast meeting's audience watches one picture, and that picture is made in a container
// (container-meet/). Like the backup's, the container names an image rather than building one
// here: --meet-image points at one, a configuration that already names one keeps it, and
// container-meet/published.json -- once a public image exists -- is the default for everybody
// else. With none of the three there is no container, broadcasts report themselves unavailable,
// and everything else is untouched. A container naming an image that does not exist would fail
// the whole deploy, so an image is never guessed at.
//
// 直播会议的旁观者看的是一路画面,而这路画面是在容器(container-meet/)里做出来的。和备份的容器一样,
// 它指向一个镜像而不是在这里构建:--meet-image 指定一个;已经写着镜像的配置保留原样;
// container-meet/published.json —— 等公共镜像有了之后 —— 是其余所有人的默认值。三样都没有就没有容器,
// 直播会报告自己不可用,其余一切不受影响。指向不存在镜像的容器会让整个部署失败,所以镜像从不靠猜。
{
  let published = '';
  let publishedFrom = '';
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'container-meet', 'published.json'), 'utf8'));
    if (p && typeof p.image === 'string') { published = p.image; publishedFrom = String(p.source || ''); }
  } catch { /* no public image yet / 还没有公共镜像 */ }
  const chosen = args['meet-image'] ? String(args['meet-image']) : '';
  const current = containerImage(text, 'MeetCompositor');
  // An image this project's own tooling put there gives way to the published one: the published
  // repository itself, or a cfmail-meet build tagged with a source hash -- what --meet-image was
  // given before a public image existed. Anything else was chosen by a person and stays chosen.
  // 本项目自己的工具放进去的镜像,让位给已发布的那个:已发布的仓库本身,或以源码哈希为标签的
  // cfmail-meet 构建 —— 公共镜像出现之前 --meet-image 指过去的就是这种。其余的都是人选的,保持不动。
  const pubRepo = published ? published.split(':')[0] : '';
  const ours = !!current && ((pubRepo && current.startsWith(pubRepo + ':')) || /\/cfmail-meet:[0-9a-f]{12}$/.test(current));
  const image = chosen || (current && !(ours && published) ? current : '') || published;
  // The same promise as the backup's image, and the same plain word when the source has moved
  // on: said to whoever changed it, and no reason to stop an install.
  // 与备份镜像同一句承诺;源码变了,也同样直说一句:说给改动它的人听,不是让安装停下来的理由。
  if (image && image === published && publishedFrom && publishedFrom !== containerHash('container-meet')) {
    log('⚠ container-meet/ differs from what the published compositor image was built from.');
    log(`  Using ${published} anyway. To ship your own changes, publish them:`);
    log('    node scripts/publish-image.mjs --image meet --repo <your public repository>');
    log('  or pass --meet-image <ref> to point at an image you built yourself.');
  }
  if (!image) {
    skip('broadcast compositor: no image (pass --meet-image <ref>); broadcast meetings stay off');
  } else if (meetMode !== 'on' && !current) {
    // Broadcasts are switched off here: no compositor is added for them. One already in the
    // configuration stays, so that switching them back on needs nothing more than the switch.
    // 这里的直播是关着的:不为它新加合成器。配置里已有的保留,这样重新打开时只需要拨回开关。
    skip(`broadcast compositor: not added (broadcasts are switched off on this deployment)`);
  } else {
    const next = withMeetContainer(text, image, { replace: !!chosen || (ours && image === published) });
    if (next === null) log('⚠ the broadcast compositor could not be written into the configuration; broadcast meetings stay off');
    else if (next !== text) { text = next; plan(`broadcast compositor -> ${image}`); }
    else skip(`broadcast compositor already points at ${current}`);
  }
}

// APP_ORIGIN is what invite and password-reset links are built from. It is set from the first
// entry host and never left as a placeholder -- a link pointing at "<entry-subdomain>" reaches
// nobody, and the failure surfaces days later in somebody's inbox.
const originHost = routesNow.length ? routesNow[0].pattern : host;
if (originHost) {
  text = text.replace(/"APP_ORIGIN"\s*:\s*"[^"]*"/, `"APP_ORIGIN": "https://${originHost}"`);
}

if (host) {
  const already = routesNow.some((r) => r.pattern === host);
  if (already) skip(`routes already has ${host}`);
  else {
    const next = withEntryRoute(text, host);
    if (!next) die(`no routes array in ${CFG_NAME}; cannot write the entry host`);
    text = next;
    plan(`routes gains ${host}`);
  }
}

// A custom domain that is live but absent from routes would be detached by this deploy. That is
// how one is meant to be removed -- deliberately -- but it must never happen as a side effect of
// someone re-cloning the repository and deploying with an empty routes array.
const live = await cf('GET', `/accounts/${accountId}/workers/domains?service=${WORKER}&environment=production`);
const liveHosts = (live.data?.result || []).map((d) => d.hostname).filter(Boolean);
const parsedNow = JSON.parse(stripJsonc(text));
const configured = new Set((parsedNow.routes || []).map((r) => r?.pattern));
const orphans = liveHosts.filter((h) => !configured.has(h));
if (orphans.length) {
  if (args['prune-domains']) {
    log(`⚠ --prune-domains: this deploy will detach ${orphans.join(', ')}`);
  } else {
    for (const h of orphans) {
      const next = withEntryRoute(text, h);
      if (next) text = next;
    }
    log(`keeping the entry hosts already live: ${orphans.join(', ')} (use --prune-domains to detach them)`);
  }
}

// --- Migrations, settled last ---------------------------------------------
// Last, and that is the whole point. A migration that creates a class the account already has
// cannot be applied, and Cloudflare refuses the entire deploy for it -- every time, forever.
// Reconciling earlier does not work: the backup container writes its own migration entry, so
// anything removed before that step was put straight back. Two fixes died that way.
//
// What wrangler will send decides what has to go: entries after the applied tag, or -- when the
// account has no tag at all, which is what a deploy interrupted mid-upload leaves behind -- every
// entry there is.
if (workerExists) {
  // Said out loud, because two rounds of this were diagnosed from logs that did not contain it.
  log(`migrations: account is at ${appliedTag ? `tag "${appliedTag}"` : 'no tag'}`
    + `, classes it already has: ${doClasses.length ? doClasses.join(', ') : 'none'}`);
  const fixed = withReconciledMigrations(text, { applied: appliedTag, existing: doClasses });
  if (fixed !== text) {
    text = fixed;
    const left = (JSON.parse(stripJsonc(fixed)).migrations || []).length;
    plan(`migrations reconciled: dropped the entries that would recreate a class this account has`);
    if (!left) {
      log('  nothing is left to apply, so wrangler will warn that the Durable Objects have no');
      log('  migration. That warning is expected here and the deploy goes through.');
    }
  }
}

if (DRY) {
  // Parse what would have been written, so a dry run proves the result is usable rather than
  // only describing the intent
  let preview;
  try {
    preview = JSON.parse(stripJsonc(text));
  } catch (e) {
    die('the configuration this produced is not valid JSON: ' + e.message);
  }
  plan(`write ${CFG_NAME} (--dry-run wrote nothing); it would say:`);
  log(`    account_id   ${preview.account_id}`);
  log(`    database_id  ${preview.d1_databases?.[0]?.database_id}`);
  log(`    APP_ORIGIN   ${preview.vars?.APP_ORIGIN}`);
  log(`    routes       ${(preview.routes || []).map((r) => r.pattern).join(', ') || '(none)'}`);
  log(`    migrations   ${(preview.migrations || []).map((m) => m.tag + ' ' + [...(m.new_sqlite_classes || []), ...(m.new_classes || [])].join('/')).join(', ') || '(none)'}`);
} else {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (e) {
    die('the configuration this produced is not valid JSON; nothing was written: ' + e.message);
  }
  if (parsed.account_id !== accountId) die('the configuration this produced has the wrong account_id; nothing was written');
  if (parsed.d1_databases?.[0]?.database_id !== databaseId) die('the configuration this produced has the wrong database_id; nothing was written');
  if (workerExists && withReconciledMigrations(text, { applied: appliedTag, existing: doClasses }) !== text) {
    die('this configuration still asks to create a Durable Object class the account already has.\n'
      + '  Deploying it fails with error 10074 and takes the whole deploy with it, so nothing was\n'
      + '  written. Something between the reconciliation and this check added a migration back.');
  }
  fs.writeFileSync(CONFIG, text);
  log(`wrote ${CFG_NAME}`);
}

if (DRY) {
  console.log('\n--dry-run stops here. Nothing was changed.\n');
  process.exit(0);
}

// --- 6. Migrations --------------------------------------------------------

step('Database migrations');
// Migrations only ever add; none of them drops or rewrites existing rows, which is what makes
// re-running this against a live deployment safe. wrangler applies just the ones not yet applied.
{
  const before = wranglerOut(['d1', 'migrations', 'list', D1_NAME, '--remote', '-c', CONFIG]);
  if (/No migrations to apply/i.test(before.out)) {
    skip('no migrations to apply');
  } else {
    // Show what is about to run before asking. wrangler prints the pending list as a table;
    // the file names are the rows worth repeating here.
    const pending = before.out.split('\n')
      .filter((l) => l.includes('.sql'))
      .map((l) => l.replace(/[\u2500-\u257F|]/g, '').trim())
      .filter(Boolean);
    log(`migrations to apply to the remote database${pending.length ? ` (${pending.length})` : ''}:`);
    for (const m of pending) log('    ' + m);
    log('Migrations only ever add tables, columns and indexes -- none rewrites or deletes existing');
    log('rows, the running Worker keeps working while they apply, and applied ones are recorded');
    log('and never run twice.');
    if (!(await confirm('Apply them now?', true))) {
      stopped('Stopped before the migrations. The database and the deployed code are exactly as they were; run this again when ready.');
    }
    const code = wrangler(['d1', 'migrations', 'apply', D1_NAME, '--remote', '-c', CONFIG], { input: 'y\n' });
    if (code !== 0) {
      die('a migration failed -- wrangler\'s own error is above this line. Stopping here: no new\n' +
          '  code has been deployed, and the running Worker is untouched.\n' +
          '  What to look at:\n' +
          '    - the failing statement is named in the error above\n' +
          `    - the database\'s view of it:  npx wrangler d1 migrations list ${D1_NAME} --remote -c ${CFG_NAME}\n` +
          '    - a migration that conflicts with existing data (say, a new UNIQUE index over rows\n' +
          '      that already duplicate) has to be fixed in migrations/ before this can continue\n' +
          '  Migrations that did apply are recorded and will not run twice -- fix the failing one\n' +
          '  and run this again; it picks up exactly where it stopped.');
    }
    // wrangler prints its confirmation blurb and exits 0 even when it applied nothing, so the
    // only trustworthy check is to ask again.
    // Ask again, and be willing to ask more than once.
    //
    // The apply reported success for every migration in the list, but the list read back straight
    // afterwards can still show them pending: what was written and what this next query reads are
    // not guaranteed to be the same moment. Dying on the first disagreement turns that into an
    // aborted deployment against a database that is, in fact, fully migrated -- which is what
    // happened once, and cost a deploy.
    //
    // Each attempt is a network round trip, so the retries are spaced by their own cost. If it
    // still disagrees after three, the disagreement is real and stopping is right: the one thing
    // worse than not deploying is deploying code against a schema that cannot hold it.
    //
    //
    //
    let settled = false;
    for (let i = 0; i < 3 && !settled; i++) {
      const after = wranglerOut(['d1', 'migrations', 'list', D1_NAME, '--remote', '-c', CONFIG]);
      settled = /No migrations to apply/i.test(after.out);
      if (!settled && i < 2) log('the migration list has not settled yet; asking again');
    }
    if (!settled) {
      die('migrations are still pending after applying them; stopping here, before any new code\n' +
          '  is published against a schema that may not hold it. Look for yourself:\n' +
          `    npx wrangler d1 migrations list ${D1_NAME} --remote -c ${CFG_NAME}\n` +
          '  If that says "No migrations to apply", the disagreement was momentary -- run this\n' +
          '  again and it will sail through. If migrations are truly still pending, apply them\n' +
          '  by hand with the same command s/list/apply/ and watch the error.');
    }
    log('migrations applied');
  }
}

// --- 7. Deploy ------------------------------------------------------------

step('Deploy the Worker');
// Vendored browser libraries are copies of what is in node_modules; they must be refreshed
// before the assets are uploaded or the deployed frontend can drift from the installed version.
// --strict: a committed build (libav, themes) that no longer matches its sources stops the
// publish here, instead of shipping the stale build and surfacing as a bug weeks later.
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-vendor.mjs'), '--strict'], { cwd: ROOT, stdio: 'inherit' });
  if ((r.status ?? 1) !== 0) die('public/vendor/ could not be brought in sync -- the deploy stops before publishing.\n  The message above names what is stale and the command that fixes it.');
}
// The last pause before anything goes live: what is about to be published, and where.
{
  let routes = [];
  try { routes = (JSON.parse(stripJsonc(fs.readFileSync(CONFIG, 'utf8'))).routes || []).map((r) => r?.pattern).filter(Boolean); } catch { /* summary only */ }
  log('about to publish:');
  log(`    Worker    ${WORKER}`);
  log(`    account   ${accountId}${accountName ? ' (' + accountName + ')' : ''}`);
  log(`    config    ${CFG_NAME}`);
  log(`    routes    ${routes.join(', ') || '(none)'}`);
  if (!(await confirm('Publish now?', true))) {
    stopped('Stopped before publishing. Migrations already applied stay applied -- they only add, and the running version does not mind them. The Worker itself is unchanged; run this again to publish.');
  }
}
if (wrangler(['deploy', '-c', CONFIG]) !== 0) {
  die('wrangler deploy failed -- its own error is above this line. The token, resources and\n' +
      '  configuration all checked out earlier, so the usual causes are:\n' +
      '    - a transient Cloudflare or network error: running this again is safe, and often enough\n' +
      '    - the Worker bundle itself (a syntax error, the size limit): the error above names it\n' +
      `    - a binding in ${CFG_NAME} pointing at something that was deleted by hand\n` +
      '  To watch the same deploy with wrangler\'s full output:\n' +
      `    npx wrangler deploy -c ${CFG_NAME}\n` +
      '  Migrations already applied are fine to leave as they are: they only add, and the running\n' +
      '  version is untouched by them.');
}

// --- Backup credentials ---------------------------------------------------
// The container has no bindings, so it needs a token of its own to reach D1 and R2 with. It is
// deliberately not the token this script was given: that one lives only in the memory of this
// run, while this one stays in the Worker as a secret, and the two should not be the same key.
//

if (args['backup-token']) {
  step('Backup credentials');
  const bt = String(args['backup-token']);
  const idRes = await fetch(`${API}/accounts/${accountId}/tokens/verify`, {
    headers: { Authorization: `Bearer ${bt}` },
  });
  const idJson = await idRes.json().catch(() => ({}));
  const tokenId = idJson?.result?.id;
  if (!tokenId) die('--backup-token could not be verified, so its id is unknown: ' + JSON.stringify(idJson.errors || idJson).slice(0, 300));
  if (DRY) {
    plan(`store secrets BACKUP_TOKEN_ID / BACKUP_TOKEN_VALUE (token ${tokenId.slice(0, 8)}...)`);
  } else {
    const put = (name, value) => wrangler(['secret', 'put', name, '-c', CONFIG], { input: value });
    if (put('BACKUP_TOKEN_ID', tokenId) !== 0) die('could not store BACKUP_TOKEN_ID');
    if (put('BACKUP_TOKEN_VALUE', bt) !== 0) die('could not store BACKUP_TOKEN_VALUE');
    log('both secrets stored; the backup can now be switched on in the admin console');
  }
}

// --- Meetings: Cloudflare Realtime ------------------------------------------
// A meeting's audio and video go through Cloudflare's SFU, and the SFU serves whoever holds an
// app's secret. So each deployment gets an app of its own -- made here, once, and kept in the
// Worker as secrets, because the secret is handed over exactly once, when the app is created,
// and there is no asking for it again. The TURN key beside it is for networks that block UDP;
// used together with the SFU it costs nothing.
//
// Optional in every sense: the permission is one most tokens do not have, and without it the
// rest of the install is untouched and meetings stay switched off. Nothing here is a reason to
// stop a deploy that has already published.
{
  step('Meetings (Cloudflare Realtime)');
  const NEED = ['REALTIME_APP_ID', 'REALTIME_APP_SECRET', 'TURN_KEY_ID', 'TURN_KEY_TOKEN'];
  const listed = await cf('GET', `/accounts/${accountId}/workers/scripts/${WORKER}/secrets`);
  const have = new Set((listed.data?.result || []).map((s) => s.name));
  const put = (name, value) => wrangler(['secret', 'put', name, '-c', CONFIG], { input: value });
  // The Realtime calls go out with whichever token may make them: this run's own, or the one
  // given for meetings. / Realtime 的调用用哪个令牌能做就用哪个:本次运行自己的,或交给会议的那一个。
  let callsAs = TOKEN;
  const callsCf = (method, p, body) => cfAs(callsAs, method, p, body);
  if (meetMode === 'off') {
    skip('switched off on this deployment (npm run deploy -- --meetings on brings them back)');
  } else if (!listed.ok) {
    log('⚠ could not read the Worker\'s secrets (' + why(listed) + '); leaving meetings as they are');
  } else if (NEED.every((n) => have.has(n))) {
    skip('the SFU app and the TURN key are already in the Worker');
  } else {
    let probeCalls = await cf('GET', `/accounts/${accountId}/calls/apps`);
    if (AUTH_DENIED(probeCalls) && await addToToken(
      [{ name: 'Account · Calls · Edit', group: 'Calls Write', why: 'create the Realtime SFU app and the TURN key meetings run on' }],
      async () => !AUTH_DENIED(await cf('GET', `/accounts/${accountId}/calls/apps`)))) {
      probeCalls = DRY ? { status: 200, data: {} } : await cf('GET', `/accounts/${accountId}/calls/apps`);
    }
    if (AUTH_DENIED(probeCalls) && meetToken && meetToken !== TOKEN) {
      const viaMeet = await cfAs(meetToken, 'GET', `/accounts/${accountId}/calls/apps`);
      if (viaMeet.ok) { probeCalls = viaMeet; callsAs = meetToken; log('using the token given for meetings to create the Realtime app'); }
    }
    if (AUTH_DENIED(probeCalls)) {
      log('· meetings stay off: neither this token nor one given for meetings can create the Realtime app.');
      log('  Three ways on, next time: run this in a terminal and choose; or pass --meet-token <a token');
      log('  with Account · Calls · Edit>; or add Account · Account API Tokens · Edit to this token.');
      log('  To stop being told: --meetings off. Everything else is installed and working.');
    } else if (DRY) {
      if (!have.has('REALTIME_APP_SECRET')) plan('create a Realtime SFU app "cfmail" and store REALTIME_APP_ID / REALTIME_APP_SECRET');
      if (!have.has('TURN_KEY_TOKEN')) plan('create a TURN key "cfmail" and store TURN_KEY_ID / TURN_KEY_TOKEN');
    } else {
      // Each secret is written the moment it is received. A run that dies between the two halves
      // leaves a finished half, and the next run does only the other.
      if (!have.has('REALTIME_APP_ID') || !have.has('REALTIME_APP_SECRET')) {
        const app = await callsCf('POST', `/accounts/${accountId}/calls/apps`, { name: 'cfmail' });
        const r = app.data?.result;
        if (!app.ok || !r?.uid || !r?.secret) {
          log('⚠ could not create the Realtime app: ' + why(app) + ' -- meetings stay off; running this again retries');
        } else if (put('REALTIME_APP_ID', r.uid) !== 0 || put('REALTIME_APP_SECRET', r.secret) !== 0) {
          log('⚠ the Realtime app was created but its secret could not be stored. The secret cannot be');
          log(`  read back, so that app (${String(r.uid).slice(0, 8)}…) is of no use: delete it in the dashboard under`);
          log('  Realtime -> SFU, and run this again to make another.');
        } else {
          log(`Realtime SFU app created (${String(r.uid).slice(0, 8)}…) and stored in the Worker`);
        }
      }
      if (!have.has('TURN_KEY_ID') || !have.has('TURN_KEY_TOKEN')) {
        const key = await callsCf('POST', `/accounts/${accountId}/calls/turn_keys`, { name: 'cfmail' });
        const r = key.data?.result;
        // The API has called this field both `key` and `secret`; either is the bearer token.
        const token = r?.secret || r?.key;
        if (!key.ok || !r?.uid || !token) {
          log('⚠ could not create the TURN key: ' + why(key) + ' -- meetings work without it, except on networks that block UDP');
        } else if (put('TURN_KEY_ID', r.uid) !== 0 || put('TURN_KEY_TOKEN', token) !== 0) {
          log('⚠ the TURN key was created but could not be stored; delete it under Realtime -> TURN and run this again');
        } else {
          log(`TURN key created (${String(r.uid).slice(0, 8)}…) and stored in the Worker`);
        }
      }
      log('meetings are available: switch them on per domain in the admin console -> Meetings');
    }
  }

  // --- Broadcast meetings ---------------------------------------------------
  // Three more things, all on the Stream side. The Worker makes a live input for each broadcast
  // and deletes recordings nobody asked to keep, so it needs a token of its own for Stream --
  // and, as with the backup's, deliberately not the token this script was given: that one can
  // rewrite the whole deployment and lives only in the memory of this run; the Worker's can touch
  // Stream and nothing else. Playback tokens are signed with a key Stream hands out once. And the
  // compositor walks into the room on a ticket signed with a key nobody but the Worker holds.
  //
  // 直播会议还需要三样东西,都在 Stream 这一侧。Worker 要为每场直播建一个 live input、
  // 并删除没人要保留的录像,所以它需要一个自己的 Stream 令牌 —— 和备份的那个一样,
  // 刻意不是交给本脚本的这个:这个能改写整套部署、只活在这次运行的内存里;Worker 的那个只能碰 Stream。
  // 播放令牌用 Stream 只发一次的钥匙来签。而合成器凭一张入场券走进房间,签它的钥匙只有 Worker 持有。
  if (listed.ok && meetMode === 'no-live') {
    step('Broadcast meetings (Cloudflare Stream)');
    skip('switched off on this deployment (npm run deploy -- --meetings on brings them back)');
  } else if (listed.ok && meetMode === 'on') {
    step('Broadcast meetings (Cloudflare Stream)');
    // The token given for meetings, from --meet-token (or --stream-token) or pasted earlier.
    // 交给会议的那个令牌:来自 --meet-token(或 --stream-token),或前面粘贴的。
    const st = meetToken;
    let streamAuth = '';
    if (st) {
      if (st === TOKEN) {
        log('⚠ the token given for meetings is the same token this script runs with. That token can rewrite');
        log('  the whole deployment and does not belong inside the Worker: give one with only what meetings need.');
      } else {
        const probe = await fetch(`${API}/accounts/${accountId}/stream/live_inputs`, { headers: { Authorization: `Bearer ${st}` } });
        const pj = await probe.json().catch(() => ({}));
        if (!probe.ok || !pj?.success) {
          log('⚠ the token given for meetings cannot reach Stream on this account (' + JSON.stringify(pj?.errors || probe.status).slice(0, 160) + '); not stored');
        } else if (DRY) {
          plan('store secret STREAM_API_TOKEN');
          streamAuth = st;
        } else if (put('STREAM_API_TOKEN', st) !== 0) {
          log('⚠ STREAM_API_TOKEN could not be stored');
        } else {
          have.add('STREAM_API_TOKEN');
          streamAuth = st;
          log('STREAM_API_TOKEN stored in the Worker');
        }
      }
    }
    // Nobody handed one over: make it. A deploy token that may create tokens is asked for a
    // second token that can touch Stream and nothing else, and that one -- never this script's
    // own -- is what goes into the Worker. Nothing to click in the dashboard.
    // 没人给:那就自己建。部署 token 若有权创建令牌,就让它再建一个只能碰 Stream 的令牌,
    // 存进 Worker 的是那一个 —— 永远不是本脚本自己的这个。dashboard 里什么都不用点。
    if (!have.has('STREAM_API_TOKEN') && !streamAuth) {
      const minted = await mintToken(cf, accountId, 'cfmail stream (kept in the Worker)', ['Stream Write'], { dry: DRY });
      if (minted.denied) {
        // said below, with both ways out / 下面会说,两条出路都列上
      } else if (!minted.value) {
        log('⚠ could not create a token for Stream: ' + minted.why);
      } else if (DRY) {
        plan('create an API token with Stream Edit only, and store it as STREAM_API_TOKEN');
      } else if (put('STREAM_API_TOKEN', minted.value) !== 0) {
        log('⚠ a Stream token was created but could not be stored; delete "cfmail stream (kept in the Worker)"');
        log('  under Manage Account -> API Tokens and run this again');
      } else {
        have.add('STREAM_API_TOKEN');
        streamAuth = minted.value;
        log(`a token with Stream Edit only was created (${String(minted.id).slice(0, 8)}…) and stored in the Worker`);
      }
    }
    if (!have.has('STREAM_API_TOKEN') && !streamAuth) {
      log('· broadcast meetings stay off: the Worker has no token for Stream. Three ways on, next time:');
      log('    run this in a terminal and choose; or pass --meet-token <a token with Account · Stream · Edit>;');
      log('    or add Account · Account API Tokens · Edit to the deploy token, and this script makes one.');
      log('  To stop being told: --meetings no-live. Stream itself has to be enabled on the account');
      log('  (dashboard -> Stream); it is billed by minutes stored and watched.');
    } else {
      if (!have.has('MEET_BOT_KEY')) {
        if (DRY) plan('store secret MEET_BOT_KEY (random)');
        else if (put('MEET_BOT_KEY', crypto.randomBytes(32).toString('hex')) === 0) log('MEET_BOT_KEY created and stored in the Worker');
        else log('⚠ MEET_BOT_KEY could not be stored');
      }
      if (!have.has('STREAM_SIGNING_KEY_ID') || !have.has('STREAM_SIGNING_JWK')) {
        if (DRY) plan('create a Stream signing key and store STREAM_SIGNING_KEY_ID / STREAM_SIGNING_JWK');
        else {
          // Made with whichever token can: the one just given, or this script's own.
          // 用哪个令牌能建就用哪个:刚给的那个,或本脚本自己的。
          const auth = streamAuth || TOKEN;
          const kr = await fetch(`${API}/accounts/${accountId}/stream/keys`, { method: 'POST', headers: { Authorization: `Bearer ${auth}` } });
          const kj = await kr.json().catch(() => ({}));
          const k = kj?.result;
          if (!kr.ok || !k?.id || !k?.jwk) {
            log('⚠ could not create a Stream signing key (' + JSON.stringify(kj?.errors || kr.status).slice(0, 160) + '); broadcasts stay off; running this again retries');
          } else if (put('STREAM_SIGNING_KEY_ID', k.id) !== 0 || put('STREAM_SIGNING_JWK', k.jwk) !== 0) {
            log('⚠ the signing key was created but could not be stored; delete it (Stream -> keys) and run this again');
          } else {
            log(`Stream signing key created (${String(k.id).slice(0, 8)}…) and stored in the Worker`);
          }
        }
      } else {
        skip('the Stream signing key is already in the Worker');
      }
      log('broadcast meetings: switch them on per domain in the admin console -> Meetings');
    }
  }
}

// --- 8. Mail routing ------------------------------------------------------
// Deliberately after the deploy: the catch-all rule points at a Worker, so the Worker has to
// exist before the rule can name it.

if (zone) {
  step(`Receiving mail for ${domain}`);
  // Everything here the script does itself; the dashboard is only ever the fallback, and when
  // it is needed the loop says which switch to flip there and checks again afterwards.
  let routingOn = false;
  for (;;) {
    const st = await cf('GET', `/zones/${zone.id}/email/routing`);
    if (st.ok && st.data.result?.enabled) {
      skip('Email Routing is on');
      routingOn = true;
      break;
    }
    const en = await cf('POST', `/zones/${zone.id}/email/routing/enable`);
    if (en.ok) {
      log('Email Routing switched on; MX and SPF records were written for you');
      routingOn = true;
      break;
    }
    log('⚠ could not switch Email Routing on: ' + why(en));
    log('  It can be switched on by hand: dashboard -> the domain -> Email -> Email Routing ->');
    log('  Get started / Enable. That is the switch that makes Cloudflare accept mail for the');
    log('  domain at all; without it nothing arrives.');
    if (INTERACTIVE && (await fixAndRetry('Flip it there, or fix the cause named above'))) continue;
    log('  Continuing without it: everything else deploys, but mail will not arrive until it is');
    log('  on. Running this again later finishes the job.');
    break;
  }

  for (;;) {
    const ca = await cf('PUT', `/zones/${zone.id}/email/routing/rules/catch_all`, {
      name: `catch-all to ${WORKER}`,
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [WORKER] }],
    });
    if (ca.ok) { log(`catch-all → Worker "${WORKER}"`); break; }
    log('⚠ could not set the catch-all rule: ' + why(ca));
    log('  This is the rule that hands every incoming message to CFMail. It usually fails only');
    log('  when Email Routing itself is not on yet (see above), or the token lacks');
    log('  Zone · Email Routing Rules · Edit.');
    if (INTERACTIVE && (await fixAndRetry(routingOn ? 'Fix the cause' : 'Fix Email Routing first'))) continue;
    log('  Continuing: set it by hand at dashboard -> the domain -> Email -> Email Routing ->');
    log(`  Routing rules -> Catch-all -> Send to a Worker -> ${WORKER}, or run this again.`);
    break;
  }

  // --- Sending -----------------------------------------------------------
  // Receiving and sending are two different services on the same domain, and a domain that can
  // receive is not thereby allowed to send. Until it is onboarded to Email Sending, the
  // send_email binding falls back to Email Routing's rule -- only verified destination
  // addresses -- so the first thing that breaks is the verification code sent to a new
  // colleague's personal mailbox, with an error nobody would connect to a missing onboarding.
  step(`Sending mail from ${domain}`);
  // Receiving and sending are different services, and only sending has a price: outward mail
  // needs the account on Workers Paid. Everything the script can do itself it does (the
  // onboarding call, re-checking DNS); what it cannot do -- pay, or widen the token -- it
  // names, and in a terminal it waits and tries the onboarding again.
  for (;;) {
    if (await sendingReady(zone.id, domain)) {
      skip('Email Sending is on; the bounce and DKIM records are in place');
      break;
    }
    const r = wranglerOut(['email', 'sending', 'enable', domain, '--zone-id', zone.id]);
    // Cloudflare publishes the records itself when the zone is on its own DNS, which is a
    // precondition here -- so their presence is the honest check that it actually took.
    if (await sendingReady(zone.id, domain)) {
      log('Email Sending switched on; the DKIM, SPF, DMARC and bounce records were written');
      break;
    }
    if (/already exists|2040/i.test(r.out)) {
      // Onboarded on the service side but the records are not in DNS. Refusing to guess why is
      // the point -- this is not the permission problem below, and saying so would send someone
      // to fix the wrong thing.
      log('⚠ this domain is known to Email Sending, but the bounce and DKIM records are missing');
      log('  from DNS, so sending will still fail.');
      log(`  See which records it wants:  npx wrangler email sending dns get ${domain}`);
      log('  (add them at dashboard -> the domain -> DNS -> Records if they do not appear on their own)');
    } else {
      // "Unauthorized" here is usually about money, not about the token. A free account gets a
      // permission-shaped refusal for a billing-shaped reason, and a token with every box ticked
      // will keep getting it -- so the plan is named first, and the error text is not to be
      // trusted about which of the two it is.
      log('⚠ Email Sending could not be switched on. The domain receives mail fine; it cannot');
      log('  send to the outside world yet. Two causes, in the order they actually happen:');
      log('    - the account is not on Workers Paid, which outward sending requires:');
      log('        dashboard -> Workers & Pages -> Plans -> Workers Paid ($5/month).');
      log('      Receiving and internal mail stay free -- only sending out needs the plan, and');
      log('      the API answers "Unauthorized" for this, which reads like a permission problem');
      log('      and is not one.');
      log('    - the token is missing Account · Email Sending · Edit. It lives under Account');
      log('      scope in the token editor, not under Zone -- the similarly named entry there');
      log('      (Email Routing Rules) is receiving, and does not help.');
      log('  The dashboard can also do the onboarding itself, once, with no token involved:');
      log('    Compute -> Email Service -> Email Sending -> Onboard Domain.');
    }
    if (INTERACTIVE && (await fixAndRetry('Fix one of these'))) continue;
    log('  Continuing: receiving works now, and running this again after the fix switches');
    log('  sending on. Nothing else is held up by it.');
    break;
  }
}

/**
 * Is this domain onboarded for sending? Asked of DNS rather than of the Email Sending API,
 * because the answer has to be available to a token that cannot read that API -- and because
 * the records are what actually make mail from this domain deliverable.
 */
async function sendingReady(zoneId, name) {
  const r = await cf('GET', `/zones/${zoneId}/dns_records?per_page=200`);
  if (!r.ok) return false;
  const rec = r.data.result || [];
  const bounceMx = rec.some((x) => x.type === 'MX' && x.name === `cf-bounce.${name}`);
  const bounceKey = rec.some((x) => x.type === 'TXT' && x.name === `cf-bounce._domainkey.${name}`);
  return bounceMx && bounceKey;
}

// --- Done -----------------------------------------------------------------

const entryUrl = 'https://' + (originHost || liveHosts[0] || host);
console.log(`

Done.

  Entry        ${entryUrl}
  First run    open that address and create the first administrator account
  More domains run this again with a different --domain (--entry stays "${entry || derived}")
  Upgrades     git pull, then the same command; data is left alone${CONFIG === MAIN_CONFIG ? '' : `
  This config  ${CFG_NAME} (wrangler.jsonc belongs to another account and was not touched)`}

  Optional: bot protection  node scripts/setup-turnstile.mjs
            (run it again after connecting a domain, so the widget knows the new entry host)
`);
// stdin was resumed if anything was asked; without this the process would sit open.
process.exit(0);
