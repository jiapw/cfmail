#!/usr/bin/env node
// One command to put CFMail on a Cloudflare account, and the same command to upgrade it later.
//
//   node scripts/deploy.mjs --token <API token> [--domain example.com] [--entry mail]
//
// Everything it needs arrives as an argument. The token is held in memory, passed to wrangler
// through the environment of the child process, and never written anywhere -- not to
// wrangler.jsonc, not to a dotfile, not to the log. Losing this terminal loses the token, which
// is the intended property: the operator keeps custody of it.
//
// Every step reads the account's current state before it changes anything, so running this twice
// is the same as running it once. That is not a convenience -- it is what makes it safe to run
// against an account that already has CFMail on it, which is the normal case for an upgrade.
//

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripJsonc, withBackupContainer, withBucket, withDevContainersOff, withEntryRoute, withVar } from './wrangler-config.mjs';

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

const TOKEN = args.token || process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error('\n✗ No API token given.\n');
  usage(1);
}
const DRY = !!args['dry-run'];
const domain = (args.domain || '').trim().toLowerCase();
const entryArg = (args.entry || '').trim().toLowerCase();

if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
  die(`--domain "${domain}" does not look like a domain name`);
}
if (entryArg && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(entryArg)) {
  die(`--entry "${entryArg}" is not a valid DNS label`);
}

function usage(code) {
  console.log(`
Usage:
  node scripts/deploy.mjs --token <API token> [--domain <domain>] [--entry <subdomain>]

  --token <t>     Cloudflare API token (required). Used for this run only; never saved.
                  May also be given as the CLOUDFLARE_API_TOKEN environment variable.
  --domain <d>    The company domain to connect. Required the first time; run this again
                  with a different one for every further domain.
  --entry <e>     Entry subdomain, e.g. mail -> https://mail.<domain>.
                  Required the first time; read back from the configuration afterwards.
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
                  Image for the backup container. Defaults to
                  registry.cloudflare.com/<account>/cfmail-backup:1.
                  Build and push it once first -- the only step that wants Docker:
                    wrangler containers build ./container --tag <ref> --push
                  The container is in the configuration whether or not backups are switched on,
                  so wrangler dev wants an API token in the environment either way.
  --prune-domains Let this deploy detach custom domains that are live but absent from the
                  configuration. Without it they are kept.
  --dry-run       Report what would happen and change nothing.
  --help          Show this text.

Permissions: the token needs Account (Workers Scripts / D1 / Workers R2 Storage - Edit) and
      Zone (Zone - Read, DNS / Email Routing Rules / Email Sending / Workers Routes - Edit).
      Every one of them is checked before anything is created, and a missing one is named.
      See "API token permissions" in the README.
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

async function cf(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
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

// --- 1. Token and account -------------------------------------------------
// --- 1. Token and account --------------------------------------------------

step('Token and account');
// Listing accounts is both the validity check and the account lookup. The obvious endpoint,
// /user/tokens/verify, is the wrong one here: a token created under Account API Tokens is not
// owned by a user, and that endpoint answers "Invalid API Token" for a perfectly good one.
const accounts = await cf('GET', '/accounts');
if (!accounts.ok) {
  die('this token does not work: ' + why(accounts) +
      '\n  Check that it was copied whole, that it has not expired, and that it carries at' +
      '\n  least one account-scope permission. Permission changes take about a minute.');
}
const accList = accounts.data.result || [];
log('token accepted');
let accountId = args.account || process.env.CLOUDFLARE_ACCOUNT_ID || '';
if (accountId) {
  const hit = accList.find((a) => a.id === accountId);
  if (!hit && accList.length) die(`this token cannot see account ${accountId}. It can see:\n` + accList.map((a) => `    ${a.id}  ${a.name}`).join('\n'));
  log(`account ${accountId}${hit ? ' (' + hit.name + ')' : ''}`);
} else if (accList.length === 1) {
  accountId = accList[0].id;
  log(`account ${accountId} (${accList[0].name})`);
} else if (accList.length === 0) {
  die('this token can see no accounts at all -- check its account-scope permissions.');
} else {
  die('this token can see several accounts; name one with --account:\n' + accList.map((a) => `    ${a.id}  ${a.name}`).join('\n'));
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
async function checkPermissions(zoneId) {
  const checks = zoneId ? [] : [
    {
      name: 'Account · Workers Scripts · Edit',
      why: 'upload the Worker that is the mail system',
      run: () => probe('GET', `/accounts/${accountId}/workers/scripts`),
    },
    {
      name: 'Account · D1 · Edit',
      why: 'create the database and apply migrations to it',
      run: () => probe('POST', `/accounts/${accountId}/d1/database`, {}),
    },
    {
      name: 'Account · Workers R2 Storage · Edit',
      why: 'create the buckets that hold message bodies and backups',
      run: () => probe('POST', `/accounts/${accountId}/r2/buckets`, {}),
    },
  ];

  if (zoneId) {
    checks.push(
      {
        name: 'Zone · Zone · Read',
        why: 'find your domain in this account',
        run: () => probe('GET', `/zones/${zoneId}`),
      },
      {
        name: 'Zone · DNS · Edit',
        why: 'point the entry host at the Worker and write the mail records',
        run: () => probe('POST', `/zones/${zoneId}/dns_records`, {}),
      },
      {
        name: 'Zone · Workers Routes · Edit',
        why: 'attach the entry host to the Worker',
        run: () => probe('GET', `/zones/${zoneId}/workers/routes`),
      },
      {
        name: 'Zone · Email Routing Rules · Edit',
        why: 'deliver incoming mail to the Worker',
        run: () => probe('GET', `/zones/${zoneId}/email/routing`),
      },
    );
  }

  const missing = [];
  for (const c of checks) {
    const ok = await c.run().catch(() => false);
    if (ok) skip(c.name);
    else { missing.push(c); log('✗ ' + c.name); }
  }

  // Sending is checked apart from the rest because it is the one that can fail for a reason that
  // is not a permission at all: an account that is not on Workers Paid is refused with the same
  // word, "Unauthorized". Saying so here saves an afternoon of auditing a token that was fine.
  if (zoneId) {
    const send = await cf('GET', `/zones/${zoneId}/email/sending/subdomains`);
    if (AUTH_DENIED(send)) {
      log('⚠ Zone · Email Sending · Edit -- absent, or this account is not on Workers Paid.');
      log('  Either way the deployment works and receives mail; only sending out is affected,');
      log('  and the API says "Unauthorized" for both causes, so the message cannot tell them apart.');
    } else {
      skip('Zone · Email Sending · Edit');
    }
  }

  if (missing.length) {
    die('This token is missing ' + missing.length + ' permission' + (missing.length > 1 ? 's' : '') + ':\n\n'
      + missing.map((m) => `    ${m.name}\n      needed to ${m.why}`).join('\n\n')
      + '\n\n  Add them at Cloudflare dashboard -> My Profile -> API Tokens -> your token -> Edit.'
      + '\n  Account-scope permissions are in the "Account Resources" section, zone-scope ones in'
      + '\n  "Zone Resources"; several exist in both lists and only one of the two counts.'
      + '\n  Changes take about a minute to take effect. Nothing has been created yet.');
  }
}

// --- 2. Existing state ----------------------------------------------------

step('Token permissions');
await checkPermissions(null);

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
if (!haveConfig && (workerExists || d1 || r2) && !args.adopt) {
  die(`this account already holds resources by these names, but there is no ${CFG_NAME} here to prove they are the same deployment.\n` +
      '  If this is a CFMail you installed earlier and you mean to keep it (all data is preserved), run again with --adopt:\n' +
      `    node scripts/deploy.mjs --token <token> --domain ${domain || '<domain>'} --entry ${entryArg || '<subdomain>'} --adopt\n` +
      '  If it is not, change these names or use another account -- otherwise this would overwrite somebody else\'s.');
}
if (!haveConfig && (workerExists || d1 || r2) && args.adopt) {
  log('--adopt: taking over the existing resources; their data is untouched');
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
  const zones = await cf('GET', `/zones?name=${encodeURIComponent(domain)}`);
  if (!zones.ok) die('could not look up the zone: ' + why(zones) + '\n  The token needs Zone - Zone - Read.');
  zone = (zones.data.result || [])[0];
  if (!zone) die(`${domain} is not in this account. Add it to Cloudflare first and point the domain at its nameservers.`);
  if (zone.account?.id && zone.account.id !== accountId) {
    die(`${domain} belongs to account ${zone.account.id} (${zone.account.name || '?'}), which is not the one being deployed to.`);
  }
  // Email Routing needs the zone's own nameservers. A partial (CNAME) setup cannot receive mail,
  // and finding that out after everything else is built is a poor way to learn it.
  if (zone.type && zone.type !== 'full') {
    die(`${domain} is set up as a "${zone.type}" zone. Email Routing needs a full zone -- the domain's nameservers pointing at Cloudflare.`);
  }
  if (zone.status !== 'active') log(`⚠ this zone's status is "${zone.status}"; mail will not arrive until the nameservers take effect`);
  log(`zone ${zone.id}(${zone.status})`);
  // The zone-scope permissions can only be probed once there is a zone to probe them against,
  // and this is still before anything has been created.
  await checkPermissions(zone.id);
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
  const image = args['backup-image']
    || `registry.cloudflare.com/${accountId}/cfmail-backup:1`;
  const withBk = withBackupContainer(text, image);
  if (withBk === null) log('⚠ no durable_objects / migrations in the configuration; skipping the backup container');
  else if (withBk !== text) { text = withBk; plan(`backup container -> ${image}`); }
  const v1 = withVar(text, 'CF_ACCOUNT_ID', accountId);
  const v2 = v1 && withVar(v1, 'CF_D1_DATABASE_ID', databaseId);
  if (v2) text = v2;
  const withDev = withDevContainersOff(text);
  if (withDev && withDev !== text) { text = withDev; plan('dev.enable_containers = false (local development will not pull the image)'); }
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
} else {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (e) {
    die('the configuration this produced is not valid JSON; nothing was written: ' + e.message);
  }
  if (parsed.account_id !== accountId) die('the configuration this produced has the wrong account_id; nothing was written');
  if (parsed.d1_databases?.[0]?.database_id !== databaseId) die('the configuration this produced has the wrong database_id; nothing was written');
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
    const code = wrangler(['d1', 'migrations', 'apply', D1_NAME, '--remote', '-c', CONFIG], { input: 'y\n' });
    if (code !== 0) die('a migration failed; stopping here -- no new code has been deployed yet');
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
      die('migrations are still pending after applying them; stopping here. Look for yourself:\n' +
          '    npx wrangler d1 migrations list ' + D1_NAME + ' --remote');
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
if (wrangler(['deploy', '-c', CONFIG]) !== 0) die('the deploy failed');

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

// --- 8. Mail routing ------------------------------------------------------
// Deliberately after the deploy: the catch-all rule points at a Worker, so the Worker has to
// exist before the rule can name it.

if (zone) {
  step(`Receiving mail for ${domain}`);
  const st = await cf('GET', `/zones/${zone.id}/email/routing`);
  if (st.ok && st.data.result?.enabled) {
    skip('Email Routing is already on');
  } else {
    const en = await cf('POST', `/zones/${zone.id}/email/routing/enable`);
    if (en.ok) log('Email Routing switched on; MX and SPF records were written for you');
    else {
      log('⚠ could not switch Email Routing on: ' + why(en));
      log('  Switch it on by hand at Dashboard -> the domain -> Email -> Email Routing, then run this again');
    }
  }

  const ca = await cf('PUT', `/zones/${zone.id}/email/routing/rules/catch_all`, {
    name: `catch-all to ${WORKER}`,
    enabled: true,
    matchers: [{ type: 'all' }],
    actions: [{ type: 'worker', value: [WORKER] }],
  });
  if (ca.ok) log(`catch-all → Worker "${WORKER}"`);
  else log('⚠ could not set the catch-all rule: ' + why(ca));

  // --- Sending -----------------------------------------------------------
  // Receiving and sending are two different services on the same domain, and a domain that can
  // receive is not thereby allowed to send. Until it is onboarded to Email Sending, the
  // send_email binding falls back to Email Routing's rule -- only verified destination
  // addresses -- so the first thing that breaks is the verification code sent to a new
  // colleague's personal mailbox, with an error nobody would connect to a missing onboarding.
  step(`Sending mail from ${domain}`);
  if (await sendingReady(zone.id, domain)) {
    skip('Email Sending is already on; the bounce and DKIM records are in place');
  } else {
    const r = wranglerOut(['email', 'sending', 'enable', domain, '--zone-id', zone.id]);
    // Cloudflare publishes the records itself when the zone is on its own DNS, which is a
    // precondition here -- so their presence is the honest check that it actually took.
    if (await sendingReady(zone.id, domain)) {
      log('Email Sending switched on; the DKIM, SPF, DMARC and bounce records were written');
    } else if (/already exists|2040/i.test(r.out)) {
      // Onboarded on the service side but the records are not in DNS. Refusing to guess why is
      // the point -- this is not the permission problem below, and saying so would send someone
      // to fix the wrong thing.
      log('⚠ this domain is known to Email Sending, but the bounce and DKIM records are missing from DNS, so sending will still fail.');
      log(`  See which records it wants: npx wrangler email sending dns get ${domain}`);
    } else {
      // "Unauthorized" here is usually about money, not about the token. A free account gets a
      // permission-shaped refusal for a billing-shaped reason, and a token with every box ticked
      // will keep getting it -- so the plan is named first, and the error text is not to be
      // trusted about which of the two it is.
      log('⚠ Email Sending could not be switched on. This domain can receive mail but not send any.');
      log('  Two causes, in the order they actually happen:');
      log('    - the account is not on Workers Paid, which sending out requires.');
      log('      Note that the API answers "Unauthorized" for this, which reads like a permission problem and is not one.');
      log('    - the token is missing Email Sending - Edit. Note that it lives under Account scope,');
      log('      not under Zone (All Domains) -- that column only has Email Routing Rules, which is receiving.');
      log('  You can also click it once at Dashboard -> Compute -> Email Service -> Email Sending -> Onboard Domain,');
      log(`  or run it on its own: npx wrangler email sending enable ${domain}`);
    }
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
