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
// 一条命令把 CFMail 装到某个 Cloudflare 账号上,之后升级也是同一条命令。
//
// 需要的东西全部由参数传入。token 只活在内存里,通过子进程的环境变量交给 wrangler,
// 不写进 wrangler.jsonc、不写进任何 dotfile、不打印到日志。关掉这个终端 token 就没了 ——
// 这正是想要的性质:token 的保管权始终在操作者手上。
//
// 每一步动手之前都先读账号当前状态,所以跑两次和跑一次结果一样。这不是为了省事,
// 而是为了让"对着一个已经装了 CFMail 的账号再跑一次"是安全的 —— 升级时本来就是这个情形。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripJsonc, withEntryRoute } from './wrangler-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');
const TEMPLATE = path.join(ROOT, 'wrangler.example.jsonc');
const API = 'https://api.cloudflare.com/client/v4';

const WORKER = 'cfmail';
const D1_NAME = 'cfmail';
const R2_NAME = 'cfmail-raw';

// ---------------------------------------------------------------------------
// Arguments / 参数
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help) usage(0);

const TOKEN = args.token || process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error('✗ 缺少 API token。\n');
  usage(1);
}
const DRY = !!args['dry-run'];
const domain = (args.domain || '').trim().toLowerCase();
const entryArg = (args.entry || '').trim().toLowerCase();

if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
  die(`--domain "${domain}" 不像一个域名`);
}
if (entryArg && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(entryArg)) {
  die(`--entry "${entryArg}" 不是合法的 DNS 标签`);
}

function usage(code) {
  console.log(`
用法 / Usage:
  node scripts/deploy.mjs --token <API token> [--domain <域名>] [--entry <入口子域>]

  --token <t>     Cloudflare API token(必填)。只用于本次运行,不会被保存。
                  也可以放在环境变量 CLOUDFLARE_API_TOKEN 里。
  --domain <d>    要接入的企业域名。第一次部署必填;之后每接一个新域名再跑一次。
  --entry <e>     入口子域前缀,例如 mail → https://mail.<域名>。
                  第一次必填,之后从已有配置里读回来。
  --account <id>  账号 id。仅当这个 token 能看到多个账号时才需要。
  --adopt         账号里已经有同名的 Worker / 数据库 / 存储桶,但本地没有配置文件时,
                  用它明确表示"就是要接管这一套",否则脚本拒绝动手。
  --prune-domains 允许这次部署摘掉线上有、配置里没有的自定义域(默认是保留它们)。
  --dry-run       只打印将要做什么,不做任何改动。
  --help          显示本说明。

权限:token 需要 Account(Workers Scripts / D1 / Workers R2 Storage · Edit)
      与 Zone(Zone · Read,DNS / Email Routing Rules / Workers Routes · Edit)。
      详见 README 的「API token permissions」。
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
// Plumbing / 基础设施
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
 *  取 Cloudflare 返回的第一条错误,短到能读。绝不回显请求本身 —— 那里面有 token。 */
const why = (r) => {
  const e = r.data?.errors?.[0];
  return e ? `${e.code ? e.code + ' ' : ''}${e.message}` : `HTTP ${r.status}`;
};

/** Run wrangler with the token in the child's environment only. Returns the exit code.
 *  跑 wrangler,token 只进子进程的环境变量。返回退出码。 */
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
      // 有些 wrangler 子命令会要确认;stdin 是管道时它走文档里的默认值而不是干等,
      // CI 让这个选择变得明确。
      CI: 'true',
    },
  });
  if (r.error) die('无法启动 wrangler:' + r.error.message);
  return r.status ?? 1;
}

/** wrangler lives in node_modules; run its bin directly so this works without a global install.
 *  wrangler 在 node_modules 里,直接跑它的入口,不依赖全局安装。 */
function wranglerBin() {
  const bin = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!fs.existsSync(bin)) die('找不到 wrangler,先运行:npm install');
  return bin;
}

/** Same as wrangler(), but captures stdout so a check can read it.
 *  同上,但捕获 stdout,给需要读输出的检查用。 */
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

console.log('\n=== CFMail 部署 ===');
if (DRY) console.log('    (--dry-run:只报告,不改动)');

// --- 1. Token and account -------------------------------------------------
// --- 1. token 与账号 -------------------------------------------------------

step('校验 token 与账号');
// Listing accounts is both the validity check and the account lookup. The obvious endpoint,
// /user/tokens/verify, is the wrong one here: a token created under Account API Tokens is not
// owned by a user, and that endpoint answers "Invalid API Token" for a perfectly good one.
// 列账号这一步同时兼作有效性校验。看起来更对口的 /user/tokens/verify 在这里是错的:
// 在 Account API Tokens 下创建的 token 不属于任何用户,拿一个完全正常的 token 去问它,
// 得到的回答是 "Invalid API Token"。
const accounts = await cf('GET', '/accounts');
if (!accounts.ok) {
  die('token 不可用:' + why(accounts) +
      '\n  检查 token 是否拼全、是否已过期,以及是否至少有一项 Account 级权限' +
      '(改完权限约 1 分钟生效)。');
}
const accList = accounts.data.result || [];
log('token 有效');
let accountId = args.account || process.env.CLOUDFLARE_ACCOUNT_ID || '';
if (accountId) {
  const hit = accList.find((a) => a.id === accountId);
  if (!hit && accList.length) die(`这个 token 看不到账号 ${accountId}。它能看到的是:\n` + accList.map((a) => `    ${a.id}  ${a.name}`).join('\n'));
  log(`账号:${accountId}${hit ? ' (' + hit.name + ')' : ''}`);
} else if (accList.length === 1) {
  accountId = accList[0].id;
  log(`账号:${accountId} (${accList[0].name})`);
} else if (accList.length === 0) {
  die('这个 token 看不到任何账号,请检查 Account 级权限。');
} else {
  die('这个 token 能看到多个账号,请用 --account 指定一个:\n' + accList.map((a) => `    ${a.id}  ${a.name}`).join('\n'));
}

// --- 2. Existing state ----------------------------------------------------
// --- 2. 账号里已有什么 ------------------------------------------------------

step('检查账号现状');
const haveConfig = fs.existsSync(CONFIG);
const existing = haveConfig ? JSON.parse(stripJsonc(fs.readFileSync(CONFIG, 'utf8'))) : null;

const svc = await cf('GET', `/accounts/${accountId}/workers/services/${WORKER}`);
const workerExists = svc.status !== 404 && svc.ok;

const d1list = await cf('GET', `/accounts/${accountId}/d1/database?name=${D1_NAME}`);
if (!d1list.ok) die('读取 D1 列表失败:' + why(d1list));
const d1 = (d1list.data.result || []).find((d) => d.name === D1_NAME) || null;

const r2list = await cf('GET', `/accounts/${accountId}/r2/buckets`);
if (!r2list.ok) die('读取 R2 列表失败:' + why(r2list));
const r2 = (r2list.data.result?.buckets || []).find((b) => b.name === R2_NAME) || null;

log(`Worker "${WORKER}"      ${workerExists ? '已存在' : '不存在'}`);
log(`D1 "${D1_NAME}"         ${d1 ? '已存在 ' + d1.uuid : '不存在'}`);
log(`R2 "${R2_NAME}"     ${r2 ? '已存在' : '不存在'}`);
log(`本地 wrangler.jsonc  ${haveConfig ? '有' : '没有'}`);

// The dangerous combination is exactly one: this account already carries something by these
// names, but this checkout has no configuration proving it is the same deployment. Deploying
// anyway would publish over somebody else's Worker and adopt their database. Everything else --
// both present, or both absent -- is an ordinary upgrade or an ordinary first install.
// 唯一危险的组合就是这一种:账号里已经有这些名字的东西,而本地又没有配置文件能证明
// 它们就是同一套部署。这时硬发,等于把别人的 Worker 覆盖掉、把别人的库接管过来。
// 其余情况(都有 / 都没有)不是升级就是首装,都正常。
if (!haveConfig && (workerExists || d1 || r2) && !args.adopt) {
  die('这个账号里已经有同名的资源,但本地没有 wrangler.jsonc 可以证明它们属于同一套部署。\n' +
      '  如果这确实是你自己之前装的 CFMail,想接着用它们(数据都保留),加上 --adopt 重跑:\n' +
      `    node scripts/deploy.mjs --token <token> --domain ${domain || '<域名>'} --entry ${entryArg || '<入口子域>'} --adopt\n` +
      '  如果不是,请先改掉这些名字或换一个账号 —— 否则会覆盖掉别人的东西。');
}
if (!haveConfig && (workerExists || d1 || r2) && args.adopt) {
  log('--adopt:接管账号里已有的同名资源,数据保持不动');
}

// --- 3. Resources ---------------------------------------------------------
// --- 3. 资源:有就用,没有才建 -----------------------------------------------

step('数据库与存储桶');
let databaseId = d1?.uuid || existing?.d1_databases?.[0]?.database_id || '';
if (databaseId && databaseId.includes('<')) databaseId = '';   // 模板占位符不算数

if (d1) {
  skip(`D1 "${D1_NAME}" 已存在,直接用(${d1.uuid})`);
  databaseId = d1.uuid;
} else if (DRY) {
  plan(`创建 D1 "${D1_NAME}"`);
} else {
  const made = await cf('POST', `/accounts/${accountId}/d1/database`, { name: D1_NAME });
  if (!made.ok) die('创建 D1 失败:' + why(made));
  databaseId = made.data.result.uuid;
  log(`已创建 D1 "${D1_NAME}"(${databaseId})`);
}

if (r2) skip(`R2 桶 "${R2_NAME}" 已存在,直接用`);
else if (DRY) plan(`创建 R2 桶 "${R2_NAME}"`);
else {
  const made = await cf('POST', `/accounts/${accountId}/r2/buckets`, { name: R2_NAME });
  if (!made.ok) die('创建 R2 桶失败:' + why(made));
  log(`已创建 R2 桶 "${R2_NAME}"`);
}

// --- 4. Zone --------------------------------------------------------------
// --- 4. 域名 ---------------------------------------------------------------

let zone = null;
if (domain) {
  step(`检查域名 ${domain}`);
  const zones = await cf('GET', `/zones?name=${encodeURIComponent(domain)}`);
  if (!zones.ok) die('查询 zone 失败:' + why(zones) + '\n  token 需要 Zone · Zone · Read。');
  zone = (zones.data.result || [])[0];
  if (!zone) die(`这个账号下找不到 ${domain}。请先把域名添加到 Cloudflare 并使用它的 NS。`);
  if (zone.account?.id && zone.account.id !== accountId) {
    die(`${domain} 属于账号 ${zone.account.id}(${zone.account.name || '?'}),与本次部署的账号不是同一个。`);
  }
  // Email Routing needs the zone's own nameservers. A partial (CNAME) setup cannot receive mail,
  // and finding that out after everything else is built is a poor way to learn it.
  // Email Routing 要求域名用 Cloudflare 自己的 NS。partial(CNAME)接入根本收不了信,
  // 把这件事留到最后才发现,是最差的知道方式。
  if (zone.type && zone.type !== 'full') {
    die(`${domain} 是 "${zone.type}" 接入方式,Email Routing 只支持完整 zone(域名的 NS 指向 Cloudflare)。`);
  }
  if (zone.status !== 'active') log(`⚠ zone 状态是 "${zone.status}",NS 还没生效前收信不会工作`);
  log(`zone ${zone.id}(${zone.status})`);
}

// --- 5. Configuration -----------------------------------------------------
// --- 5. 配置文件 -----------------------------------------------------------

step('配置文件 wrangler.jsonc');
let text = haveConfig ? fs.readFileSync(CONFIG, 'utf8') : fs.readFileSync(TEMPLATE, 'utf8');
if (!haveConfig) {
  log('从 wrangler.example.jsonc 生成');
  // Rebuilding from the template recovers everything the account can be asked about, and
  // nothing else. Optional settings that live only in this file -- the Turnstile sitekey, a
  // non-default sending channel -- go back to their defaults, and saying so now is better than
  // having someone notice weeks later that the captcha quietly stopped appearing.
  // 照模板重建,只能恢复"能从账号里问出来"的东西。只存在于这个文件里的可选项 ——
  // Turnstile sitekey、非默认的发信通道 —— 会回到默认值。现在说清楚,
  // 好过几周后才有人发现验证码悄悄不见了。
  if (workerExists) {
    log('⚠ 配置是照模板重建的:只有能从账号查到的信息被恢复。');
    log('  Turnstile(sitekey)和非默认的发信通道会回到默认值,需要的话重新设置一次。');
  }
}

// The entry prefix has exactly one home: the routes already in the file. An argument overrides
// it, and on a first install there is nothing to read, so one must be given.
// 入口前缀只有一个归宿:文件里已有的 routes。参数可以覆盖它;首装时无处可读,必须给一个。
const routesNow = (existing?.routes || []).filter((r) => r?.custom_domain && typeof r.pattern === 'string' && !r.pattern.includes('<'));
const derived = routesNow.length ? routesNow[0].pattern.split('.')[0] : '';
const entry = entryArg || derived;
if (domain && !entry) {
  die('第一次部署必须用 --entry 指定入口子域,例如 --entry mail → https://mail.' + domain);
}
// A first install with no domain would deploy a Worker nobody can reach and leave APP_ORIGIN a
// placeholder, so the invite links it later mints would point nowhere.
// 首装时不给域名,等于部署出一个谁也访问不到的 Worker,APP_ORIGIN 还留着占位符 ——
// 之后签发的邀请链接哪儿也去不了。
if (!domain && !routesNow.length) {
  die('第一次部署必须用 --domain 指定一个域名,例如:\n' +
      '    node scripts/deploy.mjs --token <token> --domain example.com --entry mail');
}
const host = domain ? `${entry}.${domain}` : '';

text = text
  .replace(/"account_id"\s*:\s*"[^"]*"/, `"account_id": "${accountId}"`)
  .replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${databaseId}"`);

// APP_ORIGIN is what invite and password-reset links are built from. It is set from the first
// entry host and never left as a placeholder -- a link pointing at "<entry-subdomain>" reaches
// nobody, and the failure surfaces days later in somebody's inbox.
// APP_ORIGIN 是邀请链接和密码重置链接的拼接来源。它取自第一个入口域,绝不能留成占位符 ——
// 指向 "<entry-subdomain>" 的链接谁也打不开,而这个错误要等几天后在别人的收件箱里才暴露。
const originHost = routesNow.length ? routesNow[0].pattern : host;
if (originHost) {
  text = text.replace(/"APP_ORIGIN"\s*:\s*"[^"]*"/, `"APP_ORIGIN": "https://${originHost}"`);
}

if (host) {
  const already = routesNow.some((r) => r.pattern === host);
  if (already) skip(`routes 里已有 ${host}`);
  else {
    const next = withEntryRoute(text, host);
    if (!next) die('wrangler.jsonc 里找不到 routes 数组,无法写入入口域');
    text = next;
    plan(`routes 追加 ${host}`);
  }
}

// A custom domain that is live but absent from routes would be detached by this deploy. That is
// how one is meant to be removed -- deliberately -- but it must never happen as a side effect of
// someone re-cloning the repository and deploying with an empty routes array.
// 线上已绑定、而 routes 里没有的自定义域,会被这次部署摘掉。删域名本来就该这么删 —— 但那是
// 刻意的动作,绝不能因为"有人重新 clone 了仓库、拿着空 routes 部署"而顺手发生。
const live = await cf('GET', `/accounts/${accountId}/workers/domains?service=${WORKER}&environment=production`);
const liveHosts = (live.data?.result || []).map((d) => d.hostname).filter(Boolean);
const parsedNow = JSON.parse(stripJsonc(text));
const configured = new Set((parsedNow.routes || []).map((r) => r?.pattern));
const orphans = liveHosts.filter((h) => !configured.has(h));
if (orphans.length) {
  if (args['prune-domains']) {
    log(`⚠ --prune-domains:这次部署会摘掉 ${orphans.join('、')}`);
  } else {
    for (const h of orphans) {
      const next = withEntryRoute(text, h);
      if (next) text = next;
    }
    log(`保留线上已有的入口域:${orphans.join('、')}(要下线请用 --prune-domains)`);
  }
}

if (DRY) {
  // Parse what would have been written, so a dry run proves the result is usable rather than
  // only describing the intent
  // 把"本来要写的内容"解析一遍,让 --dry-run 证明结果可用,而不只是描述意图
  let preview;
  try {
    preview = JSON.parse(stripJsonc(text));
  } catch (e) {
    die('生成的配置不是合法 JSON:' + e.message);
  }
  plan('写入 wrangler.jsonc(--dry-run 未写),内容会是:');
  log(`    account_id   ${preview.account_id}`);
  log(`    database_id  ${preview.d1_databases?.[0]?.database_id}`);
  log(`    APP_ORIGIN   ${preview.vars?.APP_ORIGIN}`);
  log(`    routes       ${(preview.routes || []).map((r) => r.pattern).join('、') || '(空)'}`);
} else {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (e) {
    die('生成的配置不是合法 JSON,已放弃写入:' + e.message);
  }
  if (parsed.account_id !== accountId) die('生成的配置里 account_id 不对,已放弃写入');
  if (parsed.d1_databases?.[0]?.database_id !== databaseId) die('生成的配置里 database_id 不对,已放弃写入');
  fs.writeFileSync(CONFIG, text);
  log('已写入 wrangler.jsonc');
}

if (DRY) {
  console.log('\n--dry-run 到此为止,没有任何改动发生。\n');
  process.exit(0);
}

// --- 6. Migrations --------------------------------------------------------
// --- 6. 数据库迁移 ---------------------------------------------------------

step('数据库迁移');
// Migrations only ever add; none of them drops or rewrites existing rows, which is what makes
// re-running this against a live deployment safe. wrangler applies just the ones not yet applied.
// 迁移只做加法,没有任何一条会删表或改写既有数据 —— 这正是"对着线上再跑一次"安全的原因。
// wrangler 只会执行还没执行过的那些。
{
  const before = wranglerOut(['d1', 'migrations', 'list', D1_NAME, '--remote']);
  if (/No migrations to apply/i.test(before.out)) {
    skip('没有待应用的迁移');
  } else {
    const code = wrangler(['d1', 'migrations', 'apply', D1_NAME, '--remote'], { input: 'y\n' });
    if (code !== 0) die('迁移失败,已中止(此时还没有部署新代码)');
    // wrangler prints its confirmation blurb and exits 0 even when it applied nothing, so the
    // only trustworthy check is to ask again.
    // wrangler 就算一条都没执行也会打印那段说明并以 0 退出,所以唯一可信的检查是再问一次。
    const after = wranglerOut(['d1', 'migrations', 'list', D1_NAME, '--remote']);
    if (!/No migrations to apply/i.test(after.out)) {
      die('迁移之后仍有未应用的项,已中止。请手动查看:\n' +
          '    npx wrangler d1 migrations list ' + D1_NAME + ' --remote');
    }
    log('迁移已应用');
  }
}

// --- 7. Deploy ------------------------------------------------------------
// --- 7. 部署 ---------------------------------------------------------------

step('部署 Worker');
// Vendored browser libraries are copies of what is in node_modules; they must be refreshed
// before the assets are uploaded or the deployed frontend can drift from the installed version.
// 前端自托管的第三方库是 node_modules 的副本,必须在上传静态资产之前同步,
// 否则线上前端会和已安装的版本漂移。
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-vendor.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if ((r.status ?? 1) !== 0) die('同步 public/vendor/ 失败');
}
if (wrangler(['deploy']) !== 0) die('部署失败');

// --- 8. Mail routing ------------------------------------------------------
// --- 8. 收信 ---------------------------------------------------------------
// Deliberately after the deploy: the catch-all rule points at a Worker, so the Worker has to
// exist before the rule can name it.
// 刻意放在部署之后:catch-all 规则要指向一个 Worker,得先有这个 Worker 才指得上。

if (zone) {
  step(`接收邮件:${domain}`);
  const st = await cf('GET', `/zones/${zone.id}/email/routing`);
  if (st.ok && st.data.result?.enabled) {
    skip('Email Routing 已启用');
  } else {
    const en = await cf('POST', `/zones/${zone.id}/email/routing/enable`);
    if (en.ok) log('Email Routing 已启用(MX/SPF 自动下发)');
    else {
      log('⚠ 自动启用 Email Routing 失败:' + why(en));
      log('  请到 Dashboard → 该域名 → Email → Email Routing 手动启用,然后重跑本命令');
    }
  }

  const ca = await cf('PUT', `/zones/${zone.id}/email/routing/rules/catch_all`, {
    name: `catch-all to ${WORKER}`,
    enabled: true,
    matchers: [{ type: 'all' }],
    actions: [{ type: 'worker', value: [WORKER] }],
  });
  if (ca.ok) log(`catch-all → Worker "${WORKER}"`);
  else log('⚠ 设置 catch-all 失败:' + why(ca));
}

// --- Done -----------------------------------------------------------------

const entryUrl = 'https://' + (originHost || liveHosts[0] || host);
console.log(`

完成。

  入口地址   ${entryUrl}
  首次使用   打开上面的地址,创建第一个管理员账号
  加域名     再跑一次本命令,换 --domain(--entry 会沿用现在的 "${entry || derived}")
  升级       git pull 之后跑同一条命令即可,数据不动

  另外两件与本脚本无关、需要你自己决定的事:
    · 对外发信要在 Dashboard → Compute → Email Service → Email Sending 里
      为每个发信域名点一次 Onboard Domain(需要 Workers 付费版)
    · 人机验证(可选):node scripts/setup-turnstile.mjs
`);
