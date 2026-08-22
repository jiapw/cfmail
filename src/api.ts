import { Hono } from 'hono';
import PostalMime from 'postal-mime';
import { pickTrust, type Env, type User, type FolderRole, type Trust } from './types';
import {
  clearLoginFailures,
  createSession,
  createUser,
  destroySession,
  endImpersonation,
  hashPassword,
  originCheck,
  registerLoginFailure,
  requireAuth,
  revokeAllSessions,
  userFromRequest,
  verifyPassword,
} from './auth';
import { createSystemFolders, deleteMessageDerived, findMailboxByAddress, getFolder, allocUid, ingestEml, insertFailedPlaceholder, logUnrouted, type MailboxRow } from './parse';
import { queueSend, sendSystemMail, MAX_CONTENT_BYTES } from './send';
import { HttpError, E } from './errors';
import { audit } from './audit';
import { adminApp, LOCAL_PART_RE } from './admin';
import { verifyMail, resetMail } from './mailtpl';
import { fontsApp, isKnownFont, isMonoFont } from './fonts';
import { chatApp } from './chat/routes';
import { chatDomainForHost } from './chat/settings';
import { driveAgentApp, driveApp, drivePubApp } from './drive';
import { VERSION } from './version';
import { ftsQuery, hasCJK, isEmail, jsonTry, normalizeAddr, now, parseAddrList, randomToken, sha256Hex, uid } from './util';
import { FLAGGED, pickColor, pickIcon } from './labels';

export const UI_LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru'];

type Ctx = { Bindings: Env; Variables: { user: User } };

export const app = new Hono<Ctx>();

app.use('/api/*', originCheck);

// Every failure leaves here as an e_* code plus whatever values belong inside the sentence.
// The browser turns that into text in the reader's own language -- see src/errors.ts.
// 所有失败都以 e_* 错误码 + 句子里要用到的值的形式回出去,
// 由浏览器按使用者的语言渲染成文字,详见 src/errors.ts。
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json(E(err.message, ...err.args), err.status as any);
  if (err instanceof SyntaxError) return c.json(E('e_bad_request'), 400);
  console.log('unhandled', err);
  return c.json(E('e_server'), 500);
});

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));

// Archive entries are served entirely inside the browser by the streaming service worker; this
// URL space has no server-side meaning. A request that actually arrives here means the worker
// is not in control -- still installing, mid-update, or unsupported. Answer with a plain error
// so the page can fall back to extracting in-page: without this the SPA fallback returns
// index.html with a 200, an <img> "loads" that HTML, decoding fails, and the preview is blank
// with nothing in the network log to suggest anything went wrong.
// 压缩包条目完全由流式 service worker 在浏览器内供给,这段 URL 空间在服务端没有含义。
// 请求真的到了这里,说明 worker 没在控制页面 —— 还在安装、正在更新,或不受支持。给一个
// 明确的错误,页面才好回退到本地解出:否则 SPA 兜底会以 200 返回 index.html,<img> 把这段
// HTML "加载成功"后解码失败,预览一片空白,而网络日志里看不出任何异常。
app.all('/arc-stream/*', (c) => c.json(E('e_arc_no_worker'), 503));

// Font catalogue / CSS / files (public -- the sign-in page needs the brand font too)
// 字体目录 / CSS / 文件(公开,登录页也要用品牌字体)
app.route('/api/fonts', fontsApp);

// ---------- Branding (public, resolved from the host being visited) ----------
// ---------- 品牌(公开,按访问域名生效) ----------

async function brandDomain(c: any, override?: string | null) {
  let dn = (override || '').toLowerCase().trim();
  if (!dn) {
    const host = new URL(c.req.url).hostname.toLowerCase();
    if (host.startsWith('intl-mail.')) dn = host.slice('intl-mail.'.length);
  }
  if (!dn) return null;
  return await c.env.DB.prepare(
    'SELECT id, name, brand_name, brand_theme, brand_font, brand_logo_key, brand_logo_mime, brand_logo_mode FROM domains WHERE name=?1'
  )
    .bind(dn)
    .first();
}

app.get('/api/brand', async (c) => {
  const d: any = await brandDomain(c).catch(() => null);
  return c.json({
    name: d?.brand_name || null,
    theme: d?.brand_theme || null,
    font: d?.brand_font || null,
    logo_url: d?.brand_logo_key ? '/api/brand/logo' : null,
    logo_mode: d?.brand_logo_mode || 'light',
    version: VERSION,
    turnstile: turnstileEnabled(c.env) ? c.env.TURNSTILE_SITEKEY : null,
  });
});

// ---------- Turnstile human verification ----------
// ---------- Turnstile 人机验证 ----------

/** Active only when the sitekey and the secret are both configured; missing either turns it off entirely (the frontend renders nothing, the backend lets requests through)
 *  sitekey 和 secret 都配置了才启用;少任何一个都整体关闭(前端不渲染、后端放行) */
function turnstileEnabled(env: Env): boolean {
  return !!(env.TURNSTILE_SITEKEY && env.TURNSTILE_SECRET);
}

/**
 * Validate the turnstile token supplied by the frontend. When the feature is off, everything
 * passes. When it is on, a missing token, a failed siteverify, or an unreachable siteverify all
 * count as a failure (fail-closed).
 * Tokens are single-use and valid for 5 minutes; after a 403 the frontend must reset the widget and fetch a new one.
 * 校验前端带来的 turnstile token。未启用直接放行;启用时无 token、
 * siteverify 不通过、或 siteverify 不可达,一律算不过(fail-closed)。
 * token 一次性,5 分钟内有效;前端在收到 403 后需 reset widget 重新取。
 */
async function verifyTurnstile(env: Env, token: unknown, ip?: string): Promise<boolean> {
  if (!turnstileEnabled(env)) return true;
  const t = String(token || '');
  if (!t || t.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: t });
  if (ip) form.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const j: any = await res.json();
    return !!j?.success;
  } catch {
    return false;
  }
}

const CAPTCHA_FAIL = { error: 'e_captcha' };

app.get('/api/brand/logo', async (c) => {
  const d: any = await brandDomain(c, c.req.query('d'));
  if (!d?.brand_logo_key) throw new HttpError(404, 'no logo');
  const obj = await c.env.RAW.get(d.brand_logo_key);
  if (!obj) throw new HttpError(404, 'no logo');
  // ETag-based revalidation: a replaced logo takes effect immediately, an unchanged one returns 304 with no bytes
  // 用 ETag 协商缓存:换了 logo 立刻生效,没换则回 304 不传字节
  const etag = obj.httpEtag;
  if (c.req.header('If-None-Match') === etag) {
    return c.body(null, 304, { ETag: etag, 'Cache-Control': 'no-cache' });
  }
  c.header('Content-Type', d.brand_logo_mime || 'image/png');
  c.header('ETag', etag);
  c.header('Cache-Control', 'no-cache');
  return c.body(obj.body as any);
});

// ---------- Bootstrap and authentication ----------
// ---------- 初始化与认证 ----------

app.get('/api/bootstrap', async (c) => {
  const r = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return c.json({ needs_setup: (r?.n || 0) === 0 });
});

app.post('/api/bootstrap', async (c) => {
  const r = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if ((r?.n || 0) > 0) return c.json({ error: 'e_already_setup' }, 400);
  const body = await c.req.json<any>();
  const email = normalizeAddr(String(body.email || ''));
  const name = String(body.name || '').trim().slice(0, 80);
  const password = String(body.password || '');
  if (!isEmail(email)) return c.json({ error: 'e_bad_email' }, 400);
  if (password.length < 8) return c.json({ error: 'e_password_too_short' }, 400);
  const id = await createUser(c.env, email, name || email.split('@')[0], password, true);
  await createSession(c as any, id);
  return c.json({ ok: true });
});

/**
 * Login identifier: either the personal email used at signup, or a company address the user
 * **owns**. Both share one password (stored only on users.pw_hash). Aliases are deliberately
 * not accepted as identifiers -- otherwise one mailbox would have several login names, and
 * renaming an alias could lock someone out.
 * 登录标识符:注册用的个人邮箱,或者本人**作为所有者**的企业邮箱地址。
 * 两者共用同一份密码(密码只存在 users.pw_hash 上)。别名不作为登录标识,
 * 免得一个邮箱有多个登录名、改别名把人挡在门外。
 */
export async function findUserByLoginId(env: Env, id: string): Promise<any | null> {
  const addr = normalizeAddr(id);
  if (!addr) return null;
  const byEmail = await env.DB.prepare('SELECT * FROM users WHERE email=?1').bind(addr).first<any>();
  if (byEmail) return byEmail;
  const at = addr.lastIndexOf('@');
  if (at < 1) return null;
  return await env.DB.prepare(
    `SELECT u.* FROM users u
       JOIN grants g ON g.user_id = u.id AND g.role = 'owner'
       JOIN mailboxes mb ON mb.id = g.mailbox_id AND mb.disabled = 0
       JOIN domains d ON d.id = mb.domain_id
     WHERE mb.local_part = ?1 AND d.name = ?2
     LIMIT 1`
  ).bind(addr.slice(0, at), addr.slice(at + 1)).first<any>();
}

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<any>();
  // Human verification comes first: fail it and we never touch the database or run PBKDF2
  // 人机验证放在最前面:不过关就不查库、不跑 PBKDF2
  if (!(await verifyTurnstile(c.env, body.turnstile_token, c.req.header('CF-Connecting-IP')))) {
    return c.json(CAPTCHA_FAIL, 403);
  }
  const password = String(body.password || '');
  const u = await findUserByLoginId(c.env, String(body.email || ''));
  if (!u) return c.json({ error: 'e_bad_credentials' }, 401);
  if (u.disabled) return c.json({ error: 'e_account_disabled' }, 403);
  if (u.locked_until && u.locked_until > now()) return c.json({ error: 'e_locked_15m' }, 429);
  // The lockout window has passed: clear the failure counter first, otherwise it stays at >=10 forever and a single failure after the window re-locks the account instantly
  // 锁定窗口已过:先把失败计数清零,否则计数永远停在 >=10,窗口一过随便一次失败又立刻重新锁上
  if (u.locked_until && u.locked_until <= now()) {
    await clearLoginFailures(c.env, u.id);
    u.failed_logins = 0;
  }
  const ok = await verifyPassword(password, u.pw_hash);
  if (!ok) {
    await registerLoginFailure(c.env, u.id, u.failed_logins || 0);
    return c.json({ error: 'e_bad_credentials' }, 401);
  }
  await clearLoginFailures(c.env, u.id);
  await createSession(c as any, u.id);
  return c.json({ ok: true });
});

app.post('/api/auth/logout', async (c) => {
  await destroySession(c as any);
  return c.json({ ok: true });
});

/** Hand the borrowed session back. Open to any session, because the only session it can end is one
 *  that was borrowed -- and the way out must not depend on the borrowed identity having any rights.
 *  归还借来的会话。任何会话都能调,因为它只结束得了"借来的"那一个 ——
 *  而且退路不该依赖借来的那个身份有什么权限。 */
app.post('/api/auth/unimpersonate', async (c) => {
  const who = await userFromRequest(c as any);
  const back = await endImpersonation(c as any);
  if (who?.impersonator_id) {
    const admin = await c.env.DB.prepare('SELECT id, email, name, is_admin, disabled FROM users WHERE id=?1')
      .bind(who.impersonator_id).first<User>();
    await audit(c.env, admin, 'user.impersonate_end', who.email, { user_id: who.id });
  }
  return c.json({ ok: true, restored: back });
});

// ---------- Password reset ----------
// ---------- 密码重置 ----------

const RESET_TTL_MIN = 30;

/** Which domain sends the mail and which branding shows: both follow the entry host the user visited
 *  用哪个域名发信、显示什么品牌:跟着用户访问的入口域名走 */
async function brandForHost(env: Env, host: string): Promise<{ domain: string; brand: string }> {
  const bare = host.replace(/^intl-mail\./, '').split(':')[0];
  let d: any = await env.DB.prepare('SELECT name, brand_name FROM domains WHERE name=?1').bind(bare).first();
  if (!d) d = await env.DB.prepare('SELECT name, brand_name FROM domains ORDER BY created_at LIMIT 1').first();
  return { domain: d?.name || '', brand: d?.brand_name || d?.name || 'CFMail' };
}

/**
 * Start a reset. The identifier works like login (signup email, or a company address the user owns),
 * but the mail **only ever goes to the signup address** -- you reset precisely because you cannot get
 * into the company mailbox, so sending it there would be useless.
 * The response is ok whether or not the account exists, so nothing leaks.
 * 发起重置。标识符和登录一样(注册邮箱或本人作为所有者的企业邮箱),
 * 但信**只发到注册邮箱** —— 企业邮箱进不去才要重置,发那儿等于没发。
 * 无论账号在不在,一律返回 ok,不泄露账号是否存在。
 */
app.post('/api/auth/reset/request', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  if (!(await verifyTurnstile(c.env, body.turnstile_token, c.req.header('CF-Connecting-IP')))) {
    return c.json(CAPTCHA_FAIL, 403);
  }
  const u = await findUserByLoginId(c.env, String(body.email || ''));
  // Already sent one within the last minute? Do not send again, or this becomes a way to flood someone else's inbox
  // 一分钟内已经发过就不再发,免得被人拿来刷别人的收件箱
  const recent = u
    ? await c.env.DB.prepare(
        'SELECT id FROM password_resets WHERE user_id=?1 AND used_at IS NULL AND created_at > ?2'
      ).bind(u.id, now() - 60 * 1000).first<any>()
    : null;
  if (u && !u.disabled && !recent) {
    await c.env.DB.prepare('DELETE FROM password_resets WHERE user_id=?1 AND used_at IS NULL').bind(u.id).run();
    const token = randomToken(32);
    const t = now();
    await c.env.DB.prepare(
      'INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES (?1,?2,?3,?4,?5)'
    ).bind(uid(), u.id, await sha256Hex(token), t, t + RESET_TTL_MIN * 60 * 1000).run();

    const host = c.req.header('Host') || new URL(c.req.url).host;
    const { domain, brand } = await brandForHost(c.env, host);
    const url = `${new URL(c.req.url).protocol}//${host}/#/reset/${token}`;
    const mail = resetMail(u.lang || 'en', url, brand, RESET_TTL_MIN);
    if (domain) await sendSystemMail(c.env, domain, u.email, mail.subject, mail.text).catch(() => {});
  }
  // Whether or not the account exists, the response body is byte-identical -- it leaks neither the
  // account's existence nor any fragment of the destination address. If mail really went out the
  // user will find it in their signup inbox; this endpoint must not act as an existence oracle.
  // 不管账号在不在,响应体完全一致 —— 不泄露账号是否存在,也不泄露收件地址片段。
  // 真发出去了,用户自会在注册邮箱里看到;这个接口不该充当存在性预言机。
  return c.json({ ok: true });
});

app.get('/api/auth/reset/:token', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM password_resets WHERE token_hash=?1')
    .bind(await sha256Hex(c.req.param('token'))).first<any>();
  if (!row || row.used_at || row.expires_at < now()) return c.json({ error: 'e_link_invalid' }, 400);
  const u = await c.env.DB.prepare('SELECT email FROM users WHERE id=?1').bind(row.user_id).first<any>();
  return c.json({ ok: true, email: u?.email || '' });
});

app.post('/api/auth/reset/confirm', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const pw = String(body.password || '');
  if (pw.length < 8) return c.json({ error: 'e_password_too_short' }, 400);
  const row = await c.env.DB.prepare('SELECT * FROM password_resets WHERE token_hash=?1')
    .bind(await sha256Hex(String(body.token || ''))).first<any>();
  if (!row || row.used_at || row.expires_at < now()) return c.json({ error: 'e_link_invalid' }, 400);
  // Atomic consumption: under concurrency only one request can flip used_at away from NULL, and a failed claim never changes the password
  // 原子消费:并发下只有一次能把 used_at 从 NULL 翻上,认领失败就不改密码
  const claim = await c.env.DB.prepare('UPDATE password_resets SET used_at=?1 WHERE id=?2 AND used_at IS NULL')
    .bind(now(), row.id).run();
  if (!(claim.meta as any)?.changes) return c.json({ error: 'e_link_invalid' }, 400);
  await c.env.DB.prepare('UPDATE users SET pw_hash=?1, failed_logins=0, locked_until=NULL WHERE id=?2')
    .bind(await hashPassword(pw), row.user_id).run();
  // A password change signs every device out, including any session that may already have been stolen
  // 改了密码就把所有端踢下线,包括可能已被他人窃取的会话
  await revokeAllSessions(c.env, row.user_id);
  return c.json({ ok: true });
});

// ---------- Invites (public) ----------
// ---------- 邀请(公开访问) ----------

async function loadInvite(env: Env, token: string) {
  const hash = await sha256Hex(token);
  const inv = await env.DB.prepare('SELECT * FROM invites WHERE token_hash=?1').bind(hash).first<any>();
  if (!inv) return { error: 'e_invite_not_found' };
  if (inv.revoked) return { error: 'e_invite_revoked' };
  // A shared link is never claimed, so only a single-use one can be spent
  // 共享链接从不被认领,所以只有单人链接会被"用掉"
  if (!inv.multi_use && inv.used_by) return { error: 'e_invite_used' };
  if (inv.expires_at < now()) return { error: 'e_invite_expired' };
  // Links issued before the rework (attached to an existing mailbox) are all refused; ask the administrator for a new one
  // 改造前发出的链接(挂在已存在邮箱上)一律不认,请管理员重新生成
  if ((inv.mailbox_mode || 'fixed') === 'fixed' && !inv.local_part) {
    return { error: 'e_invite_dead' };
  }
  return { inv };
}

app.get('/api/invites/:token', async (c) => {
  const { inv, error } = await loadInvite(c.env, c.req.param('token'));
  if (!inv) return c.json({ error }, 400);
  const inviter = await c.env.DB.prepare('SELECT name, email FROM users WHERE id=?1').bind(inv.created_by).first<any>();
  const dom = inv.domain_id
    ? await c.env.DB.prepare('SELECT name FROM domains WHERE id=?1').bind(inv.domain_id).first<any>()
    : null;
  const mode = inv.mailbox_mode || 'fixed';
  const me = await userFromRequest(c as any);
  return c.json({
    email: inv.email,                       // 限定的注册邮箱(可为空)
    mailbox_mode: mode,                     // fixed=地址已定 / choose=注册时自己取名
    domain: dom?.name || null,
    address: mode === 'fixed' && inv.local_part && dom ? `${inv.local_part}@${dom.name}` : null,
    role: mode === 'choose' ? 'owner' : inv.role || 'owner',
    inviter: inviter ? inviter.name || inviter.email : '',
    expires_at: inv.expires_at,
    logged_in_as: me ? me.email : null,
  });
});

/** Live availability check on the signup page, used when the mailbox name is not pinned
 *  不限定邮箱名时,注册页实时查重 */
app.get('/api/invites/:token/check', async (c) => {
  const { inv } = await loadInvite(c.env, c.req.param('token'));
  if (!inv || (inv.mailbox_mode || 'fixed') !== 'choose') return c.json({ error: 'e_not_applicable' }, 400);
  const lp = String(c.req.query('name') || '').trim().toLowerCase();
  if (!LOCAL_PART_RE.test(lp)) return c.json({ ok: false, reason: 'format' });
  const taken = await mailboxNameTaken(c.env, inv.domain_id, lp);
  return c.json({ ok: !taken, reason: taken ? 'taken' : null });
});

/** Is this mailbox name taken? Both mailboxes and aliases under the same domain count
 *  邮箱名是否已被占用:同域名下的邮箱或别名都算 */
async function mailboxNameTaken(env: Env, domainId: string, localPart: string): Promise<boolean> {
  const mb = await env.DB.prepare('SELECT id FROM mailboxes WHERE domain_id=?1 AND local_part=?2')
    .bind(domainId, localPart).first<any>();
  if (mb) return true;
  const al = await env.DB.prepare('SELECT id FROM aliases WHERE domain_id=?1 AND local_part=?2')
    .bind(domainId, localPart).first<any>();
  return !!al;
}

const CODE_TTL_MIN = 15;
const CODE_MAX_ATTEMPTS = 5;
// Rate window for verification codes sent through a shared invite. Twenty an hour is more
// than any real intake needs -- people register over days, not in one burst -- while a script
// pointed at the link runs out after twenty addresses and has to wait an hour for twenty more.
// 共享邀请发验证码的限流窗口。每小时 20 封远超真实入职节奏(人是几天里陆续注册的,
// 不会一拥而上),而拿脚本刷这条链接的,发满 20 个地址就得等一小时才有下一批。
const CODE_WINDOW_MS = 60 * 60 * 1000;
const CODE_WINDOW_MAX = 20;

/** The domain an invite belongs to (drives the verification sender domain and the brand name)
 *  邀请所属域名(用于验证码发件域与品牌名) */
async function inviteBrand(env: Env, inv: any): Promise<{ domain: string; brand: string }> {
  let d: any = null;
  if (inv.domain_id) d = await env.DB.prepare('SELECT name, brand_name FROM domains WHERE id=?1').bind(inv.domain_id).first();
  if (!d) d = await env.DB.prepare('SELECT name, brand_name FROM domains ORDER BY created_at LIMIT 1').first();
  return { domain: d?.name || '', brand: d?.brand_name || d?.name || 'CFMail' };
}

/** Step one: validate the details, then mail a code to that address. No account is created yet.
 *  第一步:校验资料 → 发验证码到该邮箱(不建账号) */
app.post('/api/invites/:token/register', async (c) => {
  const { inv, error } = await loadInvite(c.env, c.req.param('token'));
  if (!inv) return c.json({ error }, 400);
  const body = await c.req.json<any>().catch(() => ({}));
  if (!(await verifyTurnstile(c.env, body.turnstile_token, c.req.header('CF-Connecting-IP')))) {
    return c.json(CAPTCHA_FAIL, 403);
  }
  const email = normalizeAddr(String(body.email || inv.email || ''));
  const name = String(body.name || '').trim().slice(0, 80);
  const password = String(body.password || '');
  const lang = String(body.lang || 'en');

  if (!isEmail(email)) return c.json({ error: 'e_bad_email' }, 400);
  if (inv.email && normalizeAddr(inv.email) !== email) return c.json(E('e_invite_email_only', inv.email), 403);
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?1').bind(email).first<any>();
  if (exists) return c.json({ error: 'e_email_registered_login_first' }, 409);
  if (password.length < 8) return c.json({ error: 'e_password_too_short' }, 400);

  // A code was already sent for this invite+email within 60 seconds: reuse the pending record instead of
  // sending again or re-running PBKDF2. This sits ahead of the expensive hashing and mailing, so duplicate
  // requests are stopped at the door.
  // 60 秒内对同一邀请+邮箱已经发过码:直接复用上一条待验证记录,既不重发也不再跑 PBKDF2。
  // 放在昂贵的哈希/发信之前,把重复请求挡在门外。
  const prior = await c.env.DB.prepare(
    'SELECT id, created_at FROM pending_regs WHERE invite_id=?1 AND email=?2 ORDER BY created_at DESC LIMIT 1'
  ).bind(inv.id, email).first<any>();
  if (prior && prior.created_at > now() - 60 * 1000) {
    return c.json({ reg_id: prior.id, email, expires_min: CODE_TTL_MIN });
  }
  // Two shapes of the same defence: an open link must not become a free relay for mailing
  // codes to addresses of the sender's choosing. A single-use link has a lifetime total to
  // cap, since it has no business mailing many different addresses at all. A shared link has
  // no such total -- capping it would cap the registrations it exists to allow -- so it is
  // capped by rate: a burst is refused, an ordinary intake of a team over days is not.
  // 同一道防线的两种形态:开放链接不能变成"给任意邮箱发验证码"的免费中继。
  // 单人链接有总量可封,它本来就不该给很多不同邮箱发码;共享链接没有总量可封
  // (封了就等于封掉它存在的意义),所以改为限速:挡住突发,不挡一个团队几天内陆续注册。
  if (inv.multi_use) {
    const fresh = (inv.send_window_at || 0) > now() - CODE_WINDOW_MS;
    if (fresh && (inv.send_window_n || 0) >= CODE_WINDOW_MAX) {
      return c.json({ error: 'e_invite_rate_limited' }, 429);
    }
  } else if ((inv.send_count || 0) >= 10) {
    return c.json({ error: 'e_invite_code_limit' }, 429);
  }

  // Mailbox name not pinned: settle and check the name here, so we do not discover it was taken only after verification
  // 不限定邮箱名:先在这一步把名字定下来并查重,免得验证完了才发现被占
  let mailboxName: string | null = null;
  if ((inv.mailbox_mode || 'fixed') === 'choose') {
    mailboxName = String(body.mailbox_name || '').trim().toLowerCase();
    if (!LOCAL_PART_RE.test(mailboxName)) return c.json({ error: 'e_bad_mailbox_name' }, 400);
    if (await mailboxNameTaken(c.env, inv.domain_id, mailboxName)) return c.json({ error: 'e_mailbox_name_taken' }, 409);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const id = uid();
  const { domain, brand } = await inviteBrand(c.env, inv);
  if (!domain) return c.json({ error: 'e_no_send_domain' }, 500);

  // Keep only the newest pending record per invite+email
  // 同一邀请+邮箱只保留最新一条待验证记录
  await c.env.DB.prepare('DELETE FROM pending_regs WHERE invite_id=?1 AND email=?2').bind(inv.id, email).run();
  await c.env.DB.prepare(
    `INSERT INTO pending_regs (id, invite_id, email, name, pw_hash, code_hash, mailbox_name, created_at, expires_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
  ).bind(
    id, inv.id, email, name, await hashPassword(password), await sha256Hex(code), mailboxName,
    now(), now() + CODE_TTL_MIN * 60 * 1000
  ).run();

  const tpl = verifyMail(lang, code, brand, CODE_TTL_MIN);
  const sent = await sendSystemMail(c.env, domain, email, tpl.subject, tpl.text);
  if (!sent.ok) {
    await c.env.DB.prepare('DELETE FROM pending_regs WHERE id=?1').bind(id).run();
    return c.json(E('e_code_send_failed', sent.error || 'e_unknown'), 502);
  }
  // send_count is the lifetime total; the window pair rolls forward in the same statement so
  // two requests arriving together cannot both read a stale window and both reset it.
  // send_count 是生涯总数;窗口那对字段在同一条语句里滚动,
  // 免得两个并发请求各自读到过期窗口、各自把它重置一遍。
  await c.env.DB.prepare(
    `UPDATE invites SET send_count = send_count + 1,
       send_window_n  = CASE WHEN send_window_at > ?2 THEN send_window_n + 1 ELSE 1 END,
       send_window_at = CASE WHEN send_window_at > ?2 THEN send_window_at ELSE ?3 END
     WHERE id = ?1`
  ).bind(inv.id, now() - CODE_WINDOW_MS, now()).run();
  // Local development returns the code directly, which makes self-testing easy
  // 本地开发直接回传验证码,方便自测
  return c.json({ reg_id: id, email, expires_min: CODE_TTL_MIN, dev_code: c.env.DEV_MODE === '1' ? code : undefined });
});

/** Step two: check the code, then create the account and grant access
 *  第二步:校验验证码 → 建账号并授权 */
app.post('/api/invites/:token/verify', async (c) => {
  const { inv, error } = await loadInvite(c.env, c.req.param('token'));
  if (!inv) return c.json({ error }, 400);
  const body = await c.req.json<any>().catch(() => ({}));
  const regId = String(body.reg_id || '');
  const code = String(body.code || '').trim();

  const reg = await c.env.DB.prepare('SELECT * FROM pending_regs WHERE id=?1 AND invite_id=?2').bind(regId, inv.id).first<any>();
  if (!reg) return c.json({ error: 'e_verify_session_gone' }, 400);
  if (reg.expires_at < now()) {
    await c.env.DB.prepare('DELETE FROM pending_regs WHERE id=?1').bind(regId).run();
    return c.json({ error: 'e_code_expired' }, 400);
  }
  if (reg.attempts >= CODE_MAX_ATTEMPTS) {
    await c.env.DB.prepare('DELETE FROM pending_regs WHERE id=?1').bind(regId).run();
    return c.json({ error: 'e_code_attempts' }, 429);
  }
  if ((await sha256Hex(code)) !== reg.code_hash) {
    await c.env.DB.prepare('UPDATE pending_regs SET attempts=attempts+1 WHERE id=?1').bind(regId).run();
    return c.json({ error: 'e_code_wrong', remaining: CODE_MAX_ATTEMPTS - reg.attempts - 1 }, 400);
  }
  // Race backstop: the address may have been registered while verification was in flight
  // 竞态兜底:验证期间该邮箱可能已被注册
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?1').bind(reg.email).first<any>();
  if (exists) {
    await c.env.DB.prepare('DELETE FROM pending_regs WHERE id=?1').bind(regId).run();
    return c.json({ error: 'e_email_registered' }, 409);
  }

  const userId = uid();
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, name, pw_hash, is_admin, created_at) VALUES (?1,?2,?3,?4,0,?5)'
  ).bind(userId, reg.email, reg.name || reg.email.split('@')[0], reg.pw_hash, now()).run();
  await c.env.DB.prepare('DELETE FROM pending_regs WHERE id=?1').bind(regId).run();
  try {
    await applyInvite(c.env, inv, userId, reg.mailbox_name);
  } catch (e: any) {
    // Creating the mailbox failed (say the name was taken in the meantime): roll the freshly created account back rather than leaving half a user behind
    // 建邮箱这一步失败(比如名字刚好被人抢走),把刚建的账号回滚掉,不留半个用户
    await c.env.DB.prepare('DELETE FROM users WHERE id=?1').bind(userId).run();
    return c.json(E(e?.message || 'e_open_mailbox_failed', ...(e?.args || [])), e?.status || 400);
  }
  await createSession(c as any, userId);
  return c.json({ ok: true });
});

/** A signed-in user binds an invite directly -- no code needed, their identity is already established
 *  已登录用户直接绑定邀请(无需验证码,身份已确认) */
app.post('/api/invites/:token/accept', async (c) => {
  const { inv, error } = await loadInvite(c.env, c.req.param('token'));
  if (!inv) return c.json({ error }, 400);
  const me = await userFromRequest(c as any);
  if (!me) return c.json({ error: 'e_login_or_register' }, 401);
  if (inv.email && normalizeAddr(inv.email) !== me.email) {
    return c.json(E('e_invite_other_user', inv.email, me.email), 403);
  }
  const body = await c.req.json<any>().catch(() => ({}));
  await applyInvite(c.env, inv, me.id, body.mailbox_name);
  return c.json({ ok: true });
});

/**
 * Apply an invite: settle the company mailbox (creating it when absent), grant access, mark it used.
 * chosenName is only used when the mailbox name is not pinned, and is supplied by the registrant.
 * 应用邀请:确定企业邮箱(不存在就新建)→ 授权 → 标记已使用。
 * chosenName 只在"不限定邮箱名"时用到,由注册者提供。
 */
async function applyInvite(env: Env, inv: any, userId: string, chosenName?: string) {
  const mode = inv.mailbox_mode || 'fixed';
  if (!inv.domain_id) throw new HttpError(400, 'e_invite_incomplete');
  if (inv.multi_use) await claimShared(env, inv, userId);
  else await claimOnce(env, inv, userId);
  try {
    const localPart = mode === 'choose' ? String(chosenName || '').trim().toLowerCase() : String(inv.local_part || '');
    if (!LOCAL_PART_RE.test(localPart)) throw new HttpError(400, 'e_bad_mailbox_name');
    const role = mode === 'choose' ? 'owner' : ['owner', 'member', 'readonly'].includes(inv.role) ? inv.role : 'owner';

    let mb = await env.DB.prepare('SELECT id FROM mailboxes WHERE domain_id=?1 AND local_part=?2')
      .bind(inv.domain_id, localPart).first<any>();
    if (!mb) {
      if (await mailboxNameTaken(env, inv.domain_id, localPart)) throw new HttpError(409, 'e_mailbox_name_taken');
      const mbId = uid();
      await env.DB.prepare(
        'INSERT INTO mailboxes (id, domain_id, local_part, display_name, created_at) VALUES (?1,?2,?3,?4,?5)'
      ).bind(mbId, inv.domain_id, localPart, '', now()).run();
      await createSystemFolders(env, mbId);
      mb = { id: mbId };
    } else if (mode === 'choose') {
      throw new HttpError(409, 'e_mailbox_name_taken'); // 自取名时撞上已存在的邮箱,必须换一个
    }
    await env.DB.prepare(
      'INSERT INTO grants (user_id, mailbox_id, role, created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(user_id, mailbox_id) DO UPDATE SET role=?3'
    ).bind(userId, mb.id, role, now()).run();
  } catch (e) {
    // Provisioning failed (a self-chosen name collided, say): hand the claim back so the user can retry with another name instead of burning the invite
    // 开通失败(如自取名撞车):把认领退回去,让用户换个名字重试,不至于白白作废邀请
    if (inv.multi_use) {
      await env.DB.prepare('DELETE FROM invite_uses WHERE invite_id=?1 AND user_id=?2').bind(inv.id, userId).run();
    } else {
      await env.DB.prepare('UPDATE invites SET used_by=NULL, used_at=NULL WHERE id=?1').bind(inv.id).run();
    }
    throw e;
  }
}

/** Atomic claim: under concurrency only one request can flip used_by from NULL to this user,
 *  so one invite can never be redeemed into several accounts
 *  原子认领:并发下只有一个请求能把 used_by 从 NULL 翻成本人,杜绝一条邀请被同时兑换成多个账号 */
async function claimOnce(env: Env, inv: any, userId: string) {
  const claim = await env.DB.prepare(
    'UPDATE invites SET used_by=?1, used_at=?2 WHERE id=?3 AND used_by IS NULL AND revoked=0'
  ).bind(userId, now(), inv.id).run();
  if (!(claim.meta as any)?.changes) throw new HttpError(409, 'e_invite_used');
}

/**
 * A shared link is not spent by being used, so there is nothing to claim -- what is recorded
 * is the redemption. The primary key admits each user once: a second attempt by the same
 * person changes no row, which is what stops one signed-in user farming mailboxes from a link
 * meant for a team.
 *
 * The insert is guarded by the invite's own state rather than by the check in loadInvite,
 * because a verification code lives for fifteen minutes and the link can be revoked -- or
 * simply expire -- while one is in flight.
 *
 * 共享链接不会因为被使用而消耗掉,所以没有什么可认领的,要记的是"兑换"这件事。
 * 主键让每个用户只进得来一次:同一个人再来一次改不动任何行,
 * 这就挡住了已登录用户拿一条给团队用的链接反复领邮箱。
 *
 * 插入用邀请自身的状态做条件,而不是依赖 loadInvite 里那次检查 ——
 * 验证码有 15 分钟寿命,这期间链接可能被吊销,也可能就是到期了。
 */
async function claimShared(env: Env, inv: any, userId: string) {
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO invite_uses (invite_id, user_id, created_at)
     SELECT ?1, ?2, ?3 WHERE EXISTS (
       SELECT 1 FROM invites WHERE id=?1 AND multi_use=1 AND revoked=0 AND expires_at > ?3
     )`
  ).bind(inv.id, userId, now()).run();
  if ((claim.meta as any)?.changes) return;
  const mine = await env.DB.prepare('SELECT 1 FROM invite_uses WHERE invite_id=?1 AND user_id=?2')
    .bind(inv.id, userId).first<any>();
  throw new HttpError(409, mine ? 'e_invite_already_joined' : 'e_invite_expired');
}

// ---------- Current user ----------
// ---------- 当前用户 ----------

app.use('/api/me', requireAuth);
app.use('/api/me/*', requireAuth);

app.get('/api/me', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT mb.id, mb.local_part, mb.display_name, d.name AS domain_name, g.role
     FROM grants g JOIN mailboxes mb ON mb.id=g.mailbox_id JOIN domains d ON d.id=mb.domain_id
     WHERE g.user_id=?1 AND mb.disabled=0 ORDER BY d.name, mb.local_part`
  ).bind(user.id).all<any>();
  const mailboxes = [] as any[];
  for (const r of rows.results || []) {
    const unread = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.mailbox_id=?1 AND f.role='inbox' AND m.flag_seen=0`
    ).bind(r.id).first<any>();
    const aliases = await c.env.DB.prepare(
      `SELECT a.local_part, d.name AS dn FROM aliases a JOIN domains d ON d.id=a.domain_id WHERE a.mailbox_id=?1 ORDER BY d.name, a.local_part`
    ).bind(r.id).all();
    mailboxes.push({
      id: r.id,
      address: `${r.local_part}@${r.domain_name}`,
      display_name: r.display_name,
      role: r.role,
      unread: unread?.n || 0,
      aliases: (aliases.results || []).map((a: any) => `${a.local_part}@${a.dn}`),
    });
  }
  const da = await c.env.DB.prepare('SELECT domain_id FROM domain_admins WHERE user_id=?1').bind(user.id).all<any>();
  const langRow = await c.env.DB.prepare('SELECT lang, appearance, ui_font, body_font, code_font FROM users WHERE id=?1')
    .bind(user.id).first<any>();
  // The AI assistant switch is per entry host
  // AI 助手开关按访问域名生效(intl-mail.<域名>)
  const chatDom = await chatDomainForHost(c.env, new URL(c.req.url).hostname).catch(() => null);
  // Drive follows the user, not the host: it is one cross-domain store per user,
  // available as soon as any of their domains switches it on
  // 网盘跟人不跟 Host:每用户跨域名一份,所属任一域名开启即可用
  const driveDom = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM domains d WHERE d.drive_enabled=1 AND d.id IN
     (SELECT mb.domain_id FROM grants g JOIN mailboxes mb ON mb.id=g.mailbox_id WHERE g.user_id=?1) LIMIT 1`
  ).bind(user.id).first();
  // Who is really at the keyboard. Read off the session row, never off anything the page says.
  // 键盘后面真正坐着谁。从会话行上读,绝不听页面自己说。
  const imp = user.impersonator_id
    ? await c.env.DB.prepare('SELECT email FROM users WHERE id=?1').bind(user.impersonator_id).first<any>()
    : null;
  return c.json({
    impersonated_by: imp?.email || null,
    user: {
      id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin,
      lang: langRow?.lang || null, appearance: langRow?.appearance || null,
      ui_font: langRow?.ui_font || null, body_font: langRow?.body_font || null,
      code_font: langRow?.code_font || null,
    },
    domain_admin_of: (da.results || []).map((r: any) => r.domain_id),
    mailboxes,
    send_enabled: c.env.MAIL_PROVIDER !== 'dev',
    provider: c.env.MAIL_PROVIDER,
    max_content_bytes: MAX_CONTENT_BYTES, // 前端实时估算用,和发送校验同一个数
    chat_enabled: !!chatDom?.enabled, // 当前访问域名是否开启 AI 助手
    drive_enabled: !!driveDom,
  });
});

app.post('/api/me/profile', async (c) => {
  const body = await c.req.json<any>();
  const name = String(body.name || '').trim().slice(0, 80);
  await c.env.DB.prepare('UPDATE users SET name=?1 WHERE id=?2').bind(name, c.get('user').id).run();
  return c.json({ ok: true });
});

app.post('/api/me/fonts', async (c) => {
  const body = await c.req.json<any>();
  const pick = (v: any) => {
    const s = String(v ?? '').trim();
    if (!s) return null;                       // 空 = 用系统默认字体
    return isKnownFont(s) ? s : undefined;     // undefined = 非法,拒绝
  };
  const ui = pick(body.ui_font);
  const bodyFont = pick(body.body_font);
  const code = pick(body.code_font);
  if (ui === undefined || bodyFont === undefined || code === undefined) return c.json({ error: 'e_unknown_font' }, 400);
  // A known font is not enough for this one. The picker only offers fixed-width faces, but the
  // picker is not what decides -- whatever arrives here does, and it can arrive from anywhere.
  // 对这一个来说,"是个认得的字体"还不够。选择器只提供等宽字体,但作数的不是选择器 ——
  // 作数的是到达这里的东西,而它可以从任何地方到达。
  if (code && !isMonoFont(code)) return c.json({ error: 'e_font_not_mono' }, 400);
  await c.env.DB.prepare('UPDATE users SET ui_font=?1, body_font=?2, code_font=?3 WHERE id=?4')
    .bind(ui, bodyFont, code, c.get('user').id).run();
  return c.json({ ok: true });
});

app.post('/api/me/appearance', async (c) => {
  const body = await c.req.json<any>();
  const v = String(body.appearance || '');
  if (!['light', 'dark', 'auto'].includes(v)) return c.json({ error: 'e_bad_appearance' }, 400);
  await c.env.DB.prepare('UPDATE users SET appearance=?1 WHERE id=?2').bind(v, c.get('user').id).run();
  return c.json({ ok: true });
});

app.post('/api/me/lang', async (c) => {
  const body = await c.req.json<any>();
  const lang = String(body.lang || '');
  if (!UI_LANGS.includes(lang)) return c.json({ error: 'e_unsupported_language' }, 400);
  await c.env.DB.prepare('UPDATE users SET lang=?1 WHERE id=?2').bind(lang, c.get('user').id).run();
  return c.json({ ok: true });
});

app.post('/api/me/password', async (c) => {
  const body = await c.req.json<any>();
  const u = await c.env.DB.prepare('SELECT pw_hash FROM users WHERE id=?1').bind(c.get('user').id).first<any>();
  if (!u || !(await verifyPassword(String(body.old || ''), u.pw_hash))) return c.json({ error: 'e_old_password_wrong' }, 400);
  const npw = String(body.new || '');
  if (npw.length < 8) return c.json({ error: 'e_new_password_too_short' }, 400);
  const uidNow = c.get('user').id;
  await c.env.DB.prepare('UPDATE users SET pw_hash=?1 WHERE id=?2').bind(await hashPassword(npw), uidNow).run();
  // Changing the password signs every device out; issue this one a fresh session so the user does not lock themselves out
  // 改密码 = 所有端下线;当前这台重新发一个会话,免得自己被踢出去
  await revokeAllSessions(c.env, uidNow);
  await createSession(c as any, uidNow);
  return c.json({ ok: true });
});

// ---------- Mailbox access helpers ----------
// ---------- 邮箱访问辅助 ----------

async function requireGrant(c: any, mailboxId: string, write = false): Promise<{ mb: MailboxRow; role: string }> {
  const user: User = c.get('user');
  const row = await c.env.DB.prepare(
    `SELECT g.role, mb.id, mb.domain_id, mb.local_part, mb.display_name, mb.disabled, d.name AS domain_name
     FROM grants g JOIN mailboxes mb ON mb.id=g.mailbox_id JOIN domains d ON d.id=mb.domain_id
     WHERE g.user_id=?1 AND g.mailbox_id=?2`
  ).bind(user.id, mailboxId).first();
  if (!row || row.disabled) throw new HttpError(403, 'e_no_mailbox_access');
  if (write && row.role === 'readonly') throw new HttpError(403, 'e_readonly');
  return { mb: row as MailboxRow, role: row.role };
}

async function requireMessage(c: any, messageId: string, write = false) {
  const msg = await c.env.DB.prepare('SELECT * FROM messages WHERE id=?1').bind(messageId).first();
  if (!msg) throw new HttpError(404, 'e_message_not_found');
  const g = await requireGrant(c, msg.mailbox_id, write);
  return { msg, ...g };
}

const VALID_FOLDERS = ['inbox', 'starred', 'sent', 'drafts', 'spam', 'trash', 'archive'];

// ---------- Folders and conversation lists ----------
// ---------- 文件夹与会话列表 ----------

app.use('/api/mailboxes/*', requireAuth);
app.use('/api/messages/*', requireAuth);
app.use('/api/uploads', requireAuth);
app.use('/api/uploads/*', requireAuth);
app.use('/api/drafts/*', requireAuth);

// Contacts: the automatically collected address book. q drives recipient autocomplete.
// 通讯录:自动收集的联系人;q 用于收件人自动补全
app.get('/api/mailboxes/:mb/contacts', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'));
  const q = String(c.req.query('q') || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '500', 10) || 500, 1), 500);
  let rows;
  if (q) {
    const like = `%${q.replace(/[%_]/g, ' ')}%`;
    rows = await c.env.DB.prepare(
      `SELECT addr, name, internal, times, last_seen, trust FROM contacts
       WHERE mailbox_id=?1 AND (addr LIKE ?2 OR name LIKE ?2)
       ORDER BY times DESC, last_seen DESC LIMIT ?3`
    ).bind(mb.id, like, limit).all();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT addr, name, internal, times, last_seen, trust FROM contacts
       WHERE mailbox_id=?1 ORDER BY internal DESC, times DESC, last_seen DESC LIMIT ?2`
    ).bind(mb.id, limit).all();
  }
  const colleagues = await directoryOf(c.env, mb, q);
  const seen = new Set(colleagues.map((x: any) => x.addr));
  const rest = (rows.results || []).filter((x: any) => !seen.has(x.addr));
  return c.json({ contacts: [...colleagues, ...rest].slice(0, limit) });
});

/**
 * The addresses in your own company, which the deployment has known since the day they were
 * created. Waiting for a message to pass before offering to complete a colleague's address makes
 * the address book useless in exactly the situation it is needed most: a mailbox opened this
 * morning, whose owner wants to write to the person sitting next to them.
 *
 * Scoped to the domain of the mailbox being written from, not to every domain the user holds a
 * mailbox in -- writing as sales@company-a is not an occasion to be shown who works at company-b.
 *
 * 你自己公司里的地址 —— 从它们被创建那天起,这套部署就知道。
 * 非要等双方通过一次信才肯补全同事的地址,恰恰让通讯录在最需要它的场景里失效:
 * 今天早上刚开的邮箱,主人想给旁边那位同事写封信。
 *
 * 范围取"正在用哪个邮箱写信"的那个域名,而不是该用户持有邮箱的所有域名 ——
 * 以 sales@甲公司 的身份写信,不构成让你看到乙公司有哪些人的理由。
 */
async function directoryOf(env: Env, mb: any, q: string) {
  const rows = await env.DB.prepare(
    `SELECT mb2.local_part AS lp, mb2.display_name AS name, d.name AS domain
       FROM mailboxes mb2 JOIN domains d ON d.id=mb2.domain_id
      WHERE mb2.domain_id=?1 AND mb2.disabled=0 AND mb2.id<>?2
     UNION ALL
     SELECT a.local_part AS lp, tgt.display_name AS name, d.name AS domain
       FROM aliases a JOIN domains d ON d.id=a.domain_id
       JOIN mailboxes tgt ON tgt.id=a.mailbox_id
      WHERE a.domain_id=?1 AND tgt.disabled=0 AND tgt.id<>?2`
  ).bind(mb.domain_id, mb.id).all<any>();

  const out = (rows.results || []).map((r: any) => ({
    addr: `${r.lp}@${r.domain}`,
    name: r.name || '',
    internal: 1,
    times: 0,
    last_seen: 0,
    trust: 'trusted',
    // Says this came from the company directory rather than from correspondence, so the
    // interface can avoid reporting "0 messages exchanged" as though it were a fact about a person
    // 标明它来自公司通讯录而不是往来记录,界面才不会把"往来 0 次"当成关于某个人的事实来报
    directory: 1,
  }));
  const hit = q
    ? out.filter((x) => x.addr.toLowerCase().includes(q) || x.name.toLowerCase().includes(q))
    : out;
  return hit.sort((a, b) => a.addr.localeCompare(b.addr));
}

app.get('/api/mailboxes/:mb/folders', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'));
  const rows = await c.env.DB.prepare(
    `SELECT f.id, f.name, f.role,
       SUM(CASE WHEN m.flag_seen=0 THEN 1 ELSE 0 END) AS unread, COUNT(m.id) AS total
     FROM folders f LEFT JOIN messages m ON m.folder_id=f.id
     WHERE f.mailbox_id=?1 GROUP BY f.id`
  ).bind(mb.id).all<any>();
  const drafts = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM drafts WHERE mailbox_id=?1 AND user_id=?2')
    .bind(mb.id, c.get('user').id).first<any>();
  const starred = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m JOIN folders f ON f.id=m.folder_id
     WHERE m.mailbox_id=?1 AND m.flag_flagged=1 AND f.role NOT IN ('trash','spam')`
  ).bind(mb.id).first<any>();
  return c.json({
    folders: (rows.results || []).map((r: any) => ({ id: r.id, role: r.role, unread: r.unread || 0, total: r.total || 0 })),
    drafts_count: drafts?.n || 0,
    starred_count: starred?.n || 0,
  });
});

// ---------- Labels ----------
// ---------- 标签 ----------

// FLAGGED and the two closed sets live in ./labels: the admin router needs them too, and putting
// them where both can reach keeps either from having to import the other.
// FLAGGED 和那两个封闭集合放在 ./labels 里:管理后台的路由同样需要它们,
// 放在两边都够得着的地方,谁也不必反过来引对方。

/** Threads carrying each label, and how many of them hold something unread. Trash and spam are
 *  excluded so a label's count matches what its view actually lists.
 *  每个标签下有多少会话、其中多少含未读。排除回收站和垃圾邮件,让数字与该标签视图里看到的一致。 */
async function labelCounts(env: Env, mailboxId: string) {
  const rows = await env.DB.prepare(
    `SELECT ml.label_id AS id, COUNT(DISTINCT m.thread_id) AS n,
            COUNT(DISTINCT CASE WHEN m.flag_seen=0 THEN m.thread_id END) AS unread
       FROM message_labels ml
       JOIN messages m ON m.id=ml.message_id
       JOIN folders f ON f.id=m.folder_id
      WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam')
      GROUP BY ml.label_id`
  ).bind(mailboxId).all<any>();
  const map = new Map<string, { n: number; unread: number }>();
  for (const r of rows.results || []) map.set(r.id, { n: r.n || 0, unread: r.unread || 0 });
  return map;
}

app.get('/api/mailboxes/:mb/labels', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'));
  const [rows, counts, flagged] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, icon, color, sort FROM labels WHERE mailbox_id=?1 ORDER BY sort, name')
      .bind(mb.id).all<any>(),
    labelCounts(c.env, mb.id),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT m.thread_id) AS n,
              COUNT(DISTINCT CASE WHEN m.flag_seen=0 THEN m.thread_id END) AS unread
         FROM messages m JOIN folders f ON f.id=m.folder_id
        WHERE m.mailbox_id=?1 AND m.flag_flagged=1 AND f.role NOT IN ('trash','spam')`
    ).bind(mb.id).first<any>(),
  ]);
  const labels = [
    { id: FLAGGED, name: '', icon: 'star', color: 'amber', builtin: 1, sort: -1, n: flagged?.n || 0, unread: flagged?.unread || 0 },
    ...(rows.results || []).map((r: any) => ({
      ...r, builtin: 0, n: counts.get(r.id)?.n || 0, unread: counts.get(r.id)?.unread || 0,
    })),
  ];
  return c.json({ labels });
});

app.post('/api/mailboxes/:mb/labels', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'), true);
  const b = await c.req.json<any>();
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return c.json({ error: 'e_label_name_required' }, 400);
  const icon = pickIcon(b.icon);
  const color = pickColor(b.color);
  const dup = await c.env.DB.prepare('SELECT id FROM labels WHERE mailbox_id=?1 AND name=?2')
    .bind(mb.id, name).first<any>();
  if (dup) return c.json({ error: 'e_label_exists' }, 409);
  const id = uid();
  const next = await c.env.DB.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM labels WHERE mailbox_id=?1')
    .bind(mb.id).first<any>();
  await c.env.DB.prepare(
    'INSERT INTO labels (id, mailbox_id, name, icon, color, sort, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)'
  ).bind(id, mb.id, name, icon, color, next?.s || 1, now()).run();
  return c.json({ id, name, icon, color });
});

app.post('/api/mailboxes/:mb/labels/:id', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'), true);
  // The built-in has nothing to edit: renaming it would break the translation it is rendered
  // from, and it is the one label every mailbox is guaranteed to have.
  // 内置标签没有可改之处:改名会打断它赖以渲染的那份翻译,而它是每个邮箱都保证存在的那一个。
  if (c.req.param('id') === FLAGGED) return c.json({ error: 'e_label_builtin' }, 400);
  const row = await c.env.DB.prepare('SELECT * FROM labels WHERE id=?1 AND mailbox_id=?2')
    .bind(c.req.param('id'), mb.id).first<any>();
  if (!row) return c.json({ error: 'e_label_not_found' }, 404);
  const b = await c.req.json<any>();
  const name = b.name === undefined ? row.name : String(b.name || '').trim().slice(0, 40);
  if (!name) return c.json({ error: 'e_label_name_required' }, 400);
  const icon = b.icon === undefined ? row.icon : pickIcon(b.icon);
  const color = b.color === undefined ? row.color : pickColor(b.color);
  const sort = Number.isFinite(b.sort) ? Math.trunc(b.sort) : row.sort;
  if (name !== row.name) {
    const dup = await c.env.DB.prepare('SELECT id FROM labels WHERE mailbox_id=?1 AND name=?2')
      .bind(mb.id, name).first<any>();
    if (dup) return c.json({ error: 'e_label_exists' }, 409);
  }
  await c.env.DB.prepare('UPDATE labels SET name=?1, icon=?2, color=?3, sort=?4 WHERE id=?5')
    .bind(name, icon, color, sort, row.id).run();
  return c.json({ ok: true });
});

app.delete('/api/mailboxes/:mb/labels/:id', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'), true);
  if (c.req.param('id') === FLAGGED) return c.json({ error: 'e_label_builtin' }, 400);
  const row = await c.env.DB.prepare('SELECT id FROM labels WHERE id=?1 AND mailbox_id=?2')
    .bind(c.req.param('id'), mb.id).first<any>();
  if (!row) return c.json({ error: 'e_label_not_found' }, 404);
  // Deleting a label unclassifies mail; it never deletes mail.
  // 删标签是取消分类,绝不删邮件。
  await c.env.DB.prepare('DELETE FROM message_labels WHERE label_id=?1').bind(row.id).run();
  await c.env.DB.prepare('DELETE FROM labels WHERE id=?1').bind(row.id).run();
  return c.json({ ok: true });
});

/** Resolve a label id against this mailbox, or null when it is not one of ours
 *  把标签 id 解析到本邮箱,不属于本邮箱则返回 null */
async function ownLabel(env: Env, mailboxId: string, id: string) {
  if (id === FLAGGED) return { id: FLAGGED, builtin: true };
  const row = await env.DB.prepare('SELECT id FROM labels WHERE id=?1 AND mailbox_id=?2')
    .bind(id, mailboxId).first<any>();
  return row ? { id: row.id, builtin: false } : null;
}

/**
 * Put a label on a conversation, or take it off. Applying marks the latest message and removing
 * clears the whole conversation -- exactly what starring has always done, so a conversation that
 * shows a label keeps showing it until you take it off, no matter which message a reply lands on.
 * 给会话打标签或取消。打标签作用于最新一封,取消作用于整个会话 —— 星标一直就是这个行为,
 * 于是一个显示着某标签的会话会一直显示,直到你取消它,与新回复落在哪一封无关。
 */
app.post('/api/mailboxes/:mb/threads/:tid/label', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'), true);
  const tid = c.req.param('tid');
  const b = await c.req.json<any>();
  const label = await ownLabel(c.env, mb.id, String(b.label || ''));
  if (!label) return c.json({ error: 'e_label_not_found' }, 404);
  const on = !!b.on;
  if (label.builtin) {
    if (on) {
      const latest = await c.env.DB.prepare(
        'SELECT id FROM messages WHERE mailbox_id=?1 AND thread_id=?2 ORDER BY date DESC LIMIT 1'
      ).bind(mb.id, tid).first<any>();
      if (latest) await c.env.DB.prepare('UPDATE messages SET flag_flagged=1 WHERE id=?1').bind(latest.id).run();
    } else {
      await c.env.DB.prepare('UPDATE messages SET flag_flagged=0 WHERE mailbox_id=?1 AND thread_id=?2')
        .bind(mb.id, tid).run();
    }
    return c.json({ ok: true });
  }
  if (on) {
    const latest = await c.env.DB.prepare(
      'SELECT id FROM messages WHERE mailbox_id=?1 AND thread_id=?2 ORDER BY date DESC LIMIT 1'
    ).bind(mb.id, tid).first<any>();
    if (latest) {
      await c.env.DB.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?1,?2)')
        .bind(latest.id, label.id).run();
    }
  } else {
    await c.env.DB.prepare(
      `DELETE FROM message_labels WHERE label_id=?1 AND message_id IN
         (SELECT id FROM messages WHERE mailbox_id=?2 AND thread_id=?3)`
    ).bind(label.id, mb.id, tid).run();
  }
  return c.json({ ok: true });
});

/** The same, for one message -- what the reading pane acts on
 *  同上,但作用于单封邮件 —— 阅读区操作的就是这个 */
app.post('/api/messages/:id/labels', async (c) => {
  const user = await userFromRequest(c as any);
  if (!user) return c.json({ error: 'e_login_required' }, 401);
  const msg = await c.env.DB.prepare('SELECT id, mailbox_id FROM messages WHERE id=?1')
    .bind(c.req.param('id')).first<any>();
  if (!msg) return c.json({ error: 'e_message_not_found' }, 404);
  const { mb } = await requireGrant(c, msg.mailbox_id, true);
  const b = await c.req.json<any>();
  const label = await ownLabel(c.env, mb.id, String(b.label || ''));
  if (!label) return c.json({ error: 'e_label_not_found' }, 404);
  const on = !!b.on;
  if (label.builtin) {
    await c.env.DB.prepare('UPDATE messages SET flag_flagged=?1 WHERE id=?2').bind(on ? 1 : 0, msg.id).run();
  } else if (on) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?1,?2)')
      .bind(msg.id, label.id).run();
  } else {
    await c.env.DB.prepare('DELETE FROM message_labels WHERE message_id=?1 AND label_id=?2')
      .bind(msg.id, label.id).run();
  }
  return c.json({ ok: true });
});

const PAGE_SIZE = 50;

app.get('/api/mailboxes/:mb/threads', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'));
  const folder = String(c.req.query('folder') || 'inbox');
  const q = String(c.req.query('q') || '').trim();
  const page = Math.max(0, parseInt(c.req.query('page') || '0', 10) || 0);
  if (!VALID_FOLDERS.includes(folder) && !q) throw new HttpError(400, 'bad folder');

  // Drafts come from the drafts table
  // 草稿箱来自 drafts 表
  if (folder === 'drafts' && !q) {
    const rows = await c.env.DB.prepare(
      'SELECT id, payload, updated_at FROM drafts WHERE mailbox_id=?1 AND user_id=?2 ORDER BY updated_at DESC LIMIT 200'
    ).bind(mb.id, c.get('user').id).all<any>();
    const threads = (rows.results || []).map((r: any) => {
      const p = jsonTry<any>(r.payload, {});
      return {
        draft_id: r.id,
        thread_id: null,
        subject: p.subject || '',
        snippet: (p.text || '').slice(0, 120),
        from_name: '',
        from_addr: '',
        last_date: r.updated_at,
        cnt: 1, unread: 0, starred: 0, hasatt: (p.attachment_ids || []).length ? 1 : 0,
      };
    });
    // Drafts are fetched 200 at a time with no paging, so it is always page 1 of 1
    // 草稿一次取满 200 条不分页,所以永远是第 1 页共 1 页
    return c.json({ threads, page: 0, has_more: false, total: threads.length, pages: 1 });
  }

  let sql: string;
  let binds: any[];
  // Same filters as the main query but counting conversations only, to work out the page count. Both go out in one batch, saving a round trip.
  // 与 sql 同一套过滤条件、只数会话数,用来算总页数;两条一起 batch 出去,省一个往返
  let countSql: string;
  let countBinds: any[];

  // A label narrows whatever is being listed rather than replacing it, so it composes with a
  // search instead of competing with it. The clause is generated per query because the
  // placeholder number depends on how many binds that particular query already has.
  // 标签是把正在列的东西收窄,而不是取而代之,所以它与搜索是叠加关系而非二选一。
  // 子句按查询生成,因为占位符编号取决于那条查询本身已经有几个绑定值。
  const labelId = String(c.req.query('label') || '');
  const labelFilter = (idx: number) =>
    !labelId ? ''
      : labelId === FLAGGED
        ? ' AND m.thread_id IN (SELECT thread_id FROM messages WHERE mailbox_id=?1 AND flag_flagged=1)'
        : ` AND m.thread_id IN (SELECT m2.thread_id FROM message_labels ml
             JOIN messages m2 ON m2.id=ml.message_id WHERE ml.label_id=?${idx} AND m2.mailbox_id=?1)`;
  const labelBind = labelId && labelId !== FLAGGED ? [labelId] : [];

  if (q) {
    const like = !hasCJK(q) && q.length >= 3 ? null : `%${q.replace(/[%_]/g, ' ')}%`;
    const hitWhere = like
      ? '(mt.subject LIKE ?2 OR mt.body LIKE ?2 OR mt.addrs LIKE ?2)'
      : 'messages_fts MATCH ?2';
    sql = `WITH hit AS (
        SELECT m.thread_id, m.date FROM messages m
        JOIN message_texts mt ON mt.message_id = m.id
        JOIN messages_fts ON messages_fts.rowid = mt.mrow
        JOIN folders f ON f.id = m.folder_id
        WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam') AND ${hitWhere}${labelFilter(5)}
      ), t AS (SELECT thread_id, MAX(date) AS last_date, COUNT(*) AS cnt FROM hit GROUP BY thread_id)
      SELECT t.thread_id, t.last_date, t.cnt,
        (SELECT SUM(CASE WHEN flag_seen=0 THEN 1 ELSE 0 END) FROM messages WHERE mailbox_id=?1 AND thread_id=t.thread_id) AS unread,
        (SELECT MAX(flag_flagged) FROM messages WHERE mailbox_id=?1 AND thread_id=t.thread_id) AS starred,
        MAX(m.has_attachments) AS hasatt, m.subject, m.snippet, m.from_addr, m.from_name, m.direction, m.to_json, m.parse_status
      FROM t JOIN messages m ON m.mailbox_id=?1 AND m.thread_id=t.thread_id AND m.date=t.last_date
      GROUP BY t.thread_id ORDER BY t.last_date DESC LIMIT ?3 OFFSET ?4`;
    binds = [mb.id, like || ftsQuery(q), PAGE_SIZE + 1, page * PAGE_SIZE, ...labelBind];
    countSql = `SELECT COUNT(DISTINCT m.thread_id) AS n FROM messages m
        JOIN message_texts mt ON mt.message_id = m.id
        JOIN messages_fts ON messages_fts.rowid = mt.mrow
        JOIN folders f ON f.id = m.folder_id
        WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam') AND ${hitWhere}${labelFilter(3)}`;
    countBinds = [mb.id, like || ftsQuery(q), ...labelBind];
  } else if (labelId) {
    // One labelled message selects the whole conversation, and its counts span every folder the
    // conversation reaches -- the same rule the star has always followed.
    // 任一封带该标签即整个会话入选,数量按会话跨文件夹统计 —— 与星标一直以来的规则相同。
    sql = `WITH tw AS (
        SELECT m.thread_id, MAX(m.date) AS last_date, COUNT(*) AS cnt,
          SUM(CASE WHEN m.flag_seen=0 THEN 1 ELSE 0 END) AS unread,
          MAX(m.flag_flagged) AS starred, MAX(m.has_attachments) AS hasatt
        FROM messages m JOIN folders f ON f.id=m.folder_id
        WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam')${labelFilter(4)}
        GROUP BY m.thread_id)
      SELECT tw.*, m.subject, m.snippet, m.from_addr, m.from_name, m.direction, m.to_json, m.parse_status
      FROM tw JOIN messages m ON m.mailbox_id=?1 AND m.thread_id=tw.thread_id AND m.date=tw.last_date
      GROUP BY tw.thread_id ORDER BY tw.last_date DESC LIMIT ?2 OFFSET ?3`;
    binds = [mb.id, PAGE_SIZE + 1, page * PAGE_SIZE, ...labelBind];
    countSql = `SELECT COUNT(DISTINCT m.thread_id) AS n FROM messages m JOIN folders f ON f.id=m.folder_id
        WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam')${labelFilter(2)}`;
    countBinds = [mb.id, ...labelBind];
  } else if (folder === 'starred') {
    // Conversations aggregate across folders (Gmail semantics): one starred message selects the whole conversation, and counts and unread totals span it
    // 会话跨文件夹聚合(Gmail 语义):任一封被星标即入选,数量/未读按整个会话算
    sql = `WITH tw AS (
        SELECT m.thread_id, MAX(m.date) AS last_date, COUNT(*) AS cnt,
          SUM(CASE WHEN m.flag_seen=0 THEN 1 ELSE 0 END) AS unread, 1 AS starred, MAX(m.has_attachments) AS hasatt
        FROM messages m JOIN folders f ON f.id=m.folder_id
        WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam')
        GROUP BY m.thread_id HAVING MAX(m.flag_flagged)=1)
      SELECT tw.*, m.subject, m.snippet, m.from_addr, m.from_name, m.direction, m.to_json, m.parse_status
      FROM tw JOIN messages m ON m.mailbox_id=?1 AND m.thread_id=tw.thread_id AND m.date=tw.last_date
      GROUP BY tw.thread_id ORDER BY tw.last_date DESC LIMIT ?2 OFFSET ?3`;
    binds = [mb.id, PAGE_SIZE + 1, page * PAGE_SIZE];
    countSql = `SELECT COUNT(*) AS n FROM (
        SELECT m.thread_id FROM messages m JOIN folders f ON f.id=m.folder_id
        WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam')
        GROUP BY m.thread_id HAVING MAX(m.flag_flagged)=1)`;
    countBinds = [mb.id];
  } else {
    const f = await getFolder(c.env, mb.id, folder as FolderRole);
    if (!f) throw new HttpError(400, 'bad folder');
    // t = membership and unread count inside this folder; tw = count, starred flag and latest timestamp for the whole conversation across folders
    // t = 该文件夹内的会话成员资格与未读数;tw = 整个会话(跨文件夹)的数量/星标/最新时间
    const inJunk = folder === 'trash' || folder === 'spam';
    const twWhere = inJunk ? 'm.folder_id=?2' : `f.role NOT IN ('trash','spam')`;
    sql = `WITH t AS (
        SELECT thread_id, SUM(CASE WHEN flag_seen=0 THEN 1 ELSE 0 END) AS unread
        FROM messages WHERE mailbox_id=?1 AND folder_id=?2 GROUP BY thread_id),
      tw AS (
        SELECT m.thread_id, MAX(m.date) AS last_date, COUNT(*) AS cnt,
          MAX(m.flag_flagged) AS starred, MAX(m.has_attachments) AS hasatt
        FROM messages m JOIN folders f ON f.id=m.folder_id
        WHERE m.mailbox_id=?1 AND ${twWhere} AND m.thread_id IN (SELECT thread_id FROM t)
        GROUP BY m.thread_id)
      SELECT tw.thread_id, tw.last_date, tw.cnt, tw.starred, tw.hasatt, t.unread,
        m.subject, m.snippet, m.from_addr, m.from_name, m.direction, m.to_json, m.parse_status
      FROM tw JOIN t ON t.thread_id=tw.thread_id
      JOIN messages m ON m.mailbox_id=?1 AND m.thread_id=tw.thread_id AND m.date=tw.last_date
      GROUP BY tw.thread_id ORDER BY tw.last_date DESC LIMIT ?3 OFFSET ?4`;
    binds = [mb.id, f.id, PAGE_SIZE + 1, page * PAGE_SIZE];
    // The result set is tw JOIN t, and tw covers every conversation in t, so t's cardinality is the total
    // 结果集是 tw JOIN t,而 tw 覆盖 t 的全部会话,所以 t 的基数就是总数
    countSql = 'SELECT COUNT(DISTINCT thread_id) AS n FROM messages WHERE mailbox_id=?1 AND folder_id=?2';
    countBinds = [mb.id, f.id];
  }
  const [rows, cnt] = await c.env.DB.batch<any>([
    c.env.DB.prepare(sql).bind(...binds),
    c.env.DB.prepare(countSql).bind(...countBinds),
  ]);
  const list = rows.results || [];
  const hasMore = list.length > PAGE_SIZE;
  const total = Number((cnt.results?.[0] as any)?.n || 0);
  const page1 = list.slice(0, PAGE_SIZE);
  // Labels for the conversations on this page only. Joining them into the query above would
  // multiply its rows; a second query bounded by the page size costs one round trip and stays
  // the same size no matter how large the mailbox is.
  // 只取本页会话的标签。并进上面那条查询会让行数翻倍;单独查一次的代价是一个往返,
  // 而它的规模由页大小决定,和邮箱有多大无关。
  if (page1.length) {
    const ids = page1.map((r: any) => r.thread_id).filter(Boolean);
    if (ids.length) {
      const marks = ids.map((_: any, i: number) => `?${i + 2}`).join(',');
      const lr = await c.env.DB.prepare(
        `SELECT DISTINCT m.thread_id AS tid, ml.label_id AS id
           FROM message_labels ml JOIN messages m ON m.id=ml.message_id
          WHERE m.mailbox_id=?1 AND m.thread_id IN (${marks})`
      ).bind(mb.id, ...ids).all<any>();
      const byThread = new Map<string, string[]>();
      for (const r of lr.results || []) {
        if (!byThread.has(r.tid)) byThread.set(r.tid, []);
        byThread.get(r.tid)!.push(r.id);
      }
      for (const th of page1 as any[]) th.labels = byThread.get(th.thread_id) || [];
    }
  }
  return c.json({
    threads: page1,
    page,
    has_more: hasMore,
    total,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
});

app.get('/api/mailboxes/:mb/threads/:tid', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'));
  const tid = c.req.param('tid');
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.uid, m.subject, m.from_addr, m.from_name, m.to_json, m.cc_json, m.reply_to, m.snippet,
       m.date, m.size, m.has_attachments, m.direction, m.flag_seen, m.flag_flagged, m.flag_answered, m.parse_status,
       f.role AS folder_role, o.status AS outbox_status, o.last_error AS outbox_error
     FROM messages m JOIN folders f ON f.id=m.folder_id
     LEFT JOIN outbox o ON o.id=m.outbox_id
     WHERE m.mailbox_id=?1 AND m.thread_id=?2 ORDER BY m.date ASC LIMIT 200`
  ).bind(mb.id, tid).all<any>();
  const msgs = rows.results || [];
  if (!msgs.length) throw new HttpError(404, 'e_thread_not_found');

  // Labels hang off individual messages here, not off the conversation: the reading pane acts on
  // the message you are looking at, so it has to show what that one carries.
  // 这里标签挂在单封邮件上,而不是会话上:阅读区操作的是你正在看的这一封,
  // 那就得显示这一封身上有什么。
  {
    const qs2 = msgs.map((_: any, j: number) => `?${j + 1}`).join(',');
    const lr = await c.env.DB.prepare(
      `SELECT message_id AS mid, label_id AS id FROM message_labels WHERE message_id IN (${qs2})`
    ).bind(...msgs.map((m: any) => m.id)).all<any>();
    const byMsg = new Map<string, string[]>();
    for (const r of lr.results || []) {
      if (!byMsg.has(r.mid)) byMsg.set(r.mid, []);
      byMsg.get(r.mid)!.push(r.id);
    }
    for (const m of msgs as any[]) m.labels = byMsg.get(m.id) || [];
  }

  const attByMsg: Record<string, any[]> = {};
  for (let i = 0; i < msgs.length; i += 50) {
    const chunk = msgs.slice(i, i + 50);
    const qs = chunk.map((_: any, j: number) => `?${j + 1}`).join(',');
    const atts = await c.env.DB.prepare(
      `SELECT id, message_id, part_index, filename, mime, size, content_id FROM attachments WHERE message_id IN (${qs}) ORDER BY part_index`
    ).bind(...chunk.map((m: any) => m.id)).all<any>();
    for (const a of atts.results || []) {
      if (a.filename === '' && a.content_id) continue; // 纯内嵌图片不在附件列表显示
      (attByMsg[a.message_id] ||= []).push(a);
    }
  }
  return c.json({
    thread_id: tid,
    subject: msgs[msgs.length - 1].subject || msgs[0].subject,
    messages: msgs.map((m: any) => ({
      ...m,
      to: jsonTry(m.to_json, []),
      cc: jsonTry(m.cc_json, []),
      to_json: undefined, cc_json: undefined,
      attachments: attByMsg[m.id] || [],
    })),
  });
});

// ---------- Message bodies and attachments ----------
// ---------- 邮件正文/附件 ----------

async function loadParsed(c: any, msg: any) {
  const obj = await c.env.RAW.get(msg.r2_key);
  if (!obj) throw new HttpError(404, 'e_raw_gone');
  const buf = await obj.arrayBuffer();
  return await new PostalMime().parse(buf);
}

/** What the mailbox owner has said about this sender. Anyone not in the address book is either a
 *  colleague or a stranger; a stranger is unknown, which is a description, not an accusation.
 *  这个邮箱的主人对该发件人的看法。不在通讯录里的,要么是同事要么是陌生人;
 *  陌生人算「未知」—— 那是一句描述,不是一项指控。 */
async function senderTrust(c: any, mailboxId: string, addr: string): Promise<Trust> {
  const a = normalizeAddr(addr || '');
  if (!a) return 'unknown';
  const row: any = await c.env.DB.prepare('SELECT trust FROM contacts WHERE mailbox_id=?1 AND addr=?2')
    .bind(mailboxId, a).first();
  if (row) return pickTrust(row.trust);
  const mb = await findMailboxByAddress(c.env, a).catch(() => null);
  return mb ? 'trusted' : 'unknown';
}

app.get('/api/messages/:id/body', async (c) => {
  const { msg } = await requireMessage(c, c.req.param('id'));
  const parsed: any = await loadParsed(c, msg);
  let html: string | null = parsed.html || null;
  let blocked = 0;
  // ?images=1 means the user clicked "show images" in the interface -- allow them this once
  // ?images=1 表示用户在界面上点了"显示图片",本次放行
  const force = c.req.query('images') === '1';
  const trust = await senderTrust(c, msg.mailbox_id, msg.from_addr);
  // Only outright trust loads remote images by itself; unknown and risk both wait to be asked.
  // 只有明确的「可信」会自动加载远程图片;未知与隐患都等人开口。
  const safe = force || trust === 'trusted';

  if (html) {
    // cid: inline images are rewritten to our own API path (they ride along with the message, never phone out, so they are always allowed)
    // cid: 内嵌图片改写为本站 API 地址(这些随信附带,不外联,始终放行)
    html = html.replace(/(["'(])\s*cid:([^"')\s]+)/gi, (_m: string, p: string, cid: string) => `${p}/api/messages/${msg.id}/cid/${encodeURIComponent(cid)}`);
    if (!safe) {
      // Remote images: move src to data-blocked-src, and the frontend restores it after "show images"
      // 远程图片:src 挪到 data-blocked-src,点"显示图片"后前端再还原
      html = html.replace(/<img\b[^>]*>/gi, (tag: string) => {
        const m = tag.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const url = m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
        if (!url || url.startsWith('/api/messages/')) return tag; // cid 图片保留
        blocked++;
        return tag.replace(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, ` data-blocked-src="${url.replace(/"/g, '&quot;')}"`);
      });
      // Background images phone out just the same
      // 背景图同样会外联
      html = html.replace(/background-image\s*:\s*url\([^)]*\)/gi, () => { blocked++; return 'background-image:none'; });
    }
  }
  return c.json({ html, text: parsed.text || null, images_blocked: blocked, sender_safe: safe, sender_trust: trust });
});

/** Say what this mailbox thinks of a correspondent: trusted / unknown / risk
 *  记下这个邮箱对某位往来对象的看法:可信 / 未知 / 隐患 */
app.post('/api/mailboxes/:mb/contacts/trust', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'), true);
  const body = await c.req.json<any>();
  const addr = normalizeAddr(String(body.addr || ''));
  if (!isEmail(addr)) return c.json({ error: 'e_bad_address' }, 400);
  const trust = pickTrust(body.trust);
  const exists = await c.env.DB.prepare('SELECT id FROM contacts WHERE mailbox_id=?1 AND addr=?2')
    .bind(mb.id, addr).first<any>();
  if (exists) {
    await c.env.DB.prepare('UPDATE contacts SET trust=?1 WHERE id=?2').bind(trust, exists.id).run();
  } else {
    // Judging somebody you have never exchanged mail with is reason enough to write them down --
    // a colleague picked out of the company directory, most often.
    // 对一个还没通过信的人下判断,本身就足以让他进通讯录 —— 多半是从公司通讯录里挑出来的同事。
    const internal = (await findMailboxByAddress(c.env, addr).catch(() => null)) ? 1 : 0;
    await c.env.DB.prepare(
      'INSERT INTO contacts (id, mailbox_id, addr, name, internal, times, last_seen, trust) VALUES (?1,?2,?3,?4,?5,0,?6,?7)'
    ).bind(uid(), mb.id, addr, '', internal, now(), trust).run();
  }
  return c.json({ ok: true, trust });
});

app.get('/api/messages/:id/raw', async (c) => {
  const { msg } = await requireMessage(c, c.req.param('id'));
  const obj = await c.env.RAW.get(msg.r2_key);
  if (!obj) throw new HttpError(404, 'e_raw_gone');
  c.header('Content-Type', 'message/rfc822');
  c.header('Content-Disposition', `attachment; filename="${msg.id}.eml"`);
  return c.body(obj.body as any);
});

// Types that are safe to preview inline. Raster images and PDF cannot execute script under our origin;
// SVG and HTML must never enter this set -- returning them inline makes opening one a same-origin XSS
// (the very trap the /cid endpoint below fell into).
// 能安全内联预览的类型。位图和 PDF 都不会以本站源执行脚本;SVG 和 HTML 绝不能进这张表
// —— 内联返回后点开即是同源 XSS(和下面 /cid 端点栽过的是同一个坑)。
const PREVIEW_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp',
  'application/pdf',
]);

app.get('/api/messages/:id/att/:idx', async (c) => {
  const { msg } = await requireMessage(c, c.req.param('id'));
  const idx = parseInt(c.req.param('idx'), 10);
  const meta = await c.env.DB.prepare('SELECT * FROM attachments WHERE message_id=?1 AND part_index=?2')
    .bind(msg.id, idx).first<any>();
  if (!meta) throw new HttpError(404, 'e_attachment_not_found');
  const parsed: any = await loadParsed(c, msg);
  const atts = (parsed.attachments || []).filter((a: any) => a && a.content);
  const att = atts[idx];
  if (!att) throw new HttpError(404, 'e_attachment_not_found');
  const fname = meta.filename || 'attachment';
  const mime = String(meta.mime || '').toLowerCase().split(';')[0].trim();
  // Anything outside the whitelist is served as a download, no matter what the frontend asked for
  // 白名单之外的一律按下载给,哪怕前端传了 inline=1
  const inline = c.req.query('inline') === '1' && PREVIEW_MIMES.has(mime);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Type', inline ? mime : meta.mime || 'application/octet-stream');
  c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fname)}`);
  return c.body(att.content);
});

// Inline rendering is allowed for genuine raster images only. A text/html or SVG part carrying a
// Content-ID is collected into attachments by postal-mime, and returning it inline under our own
// origin with its declared MIME would let its script run in the application origin -- so anything
// that is not a raster image is forced to application/octet-stream + attachment + nosniff:
// downloadable, never inline.
// 内联渲染只放行真正的位图。带 Content-ID 的 text/html 或 SVG 会被 postal-mime 收进
// attachments,若照其声明的 MIME 以本站源内联返回,点开后脚本就能在应用源里执行 ——
// 所以非位图一律 application/octet-stream + attachment + nosniff,只能下载不能内联。
const CID_INLINE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
]);
app.get('/api/messages/:id/cid/:cid', async (c) => {
  const { msg } = await requireMessage(c, c.req.param('id'));
  const cid = decodeURIComponent(c.req.param('cid')).replace(/[<>]/g, '');
  const parsed: any = await loadParsed(c, msg);
  const att = (parsed.attachments || []).find((a: any) => a && String(a.contentId || '').replace(/[<>]/g, '') === cid);
  if (!att || !att.content) throw new HttpError(404, 'not found');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'private, max-age=3600');
  if (CID_INLINE_MIMES.has(String(att.mimeType || '').toLowerCase())) {
    c.header('Content-Type', att.mimeType);
  } else {
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', 'attachment');
  }
  return c.body(att.content);
});

// ---------- Conversation actions ----------
// ---------- 会话操作 ----------

async function moveThread(c: any, mb: MailboxRow, tid: string, fromRoles: string[] | null, target: FolderRole) {
  const tf = await getFolder(c.env, mb.id, target);
  if (!tf) throw new HttpError(400, 'bad target');
  let sql = `SELECT m.id FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.mailbox_id=?1 AND m.thread_id=?2`;
  if (fromRoles) sql += ` AND f.role IN (${fromRoles.map((r) => `'${r}'`).join(',')})`;
  const rows = await c.env.DB.prepare(sql).bind(mb.id, tid).all();
  for (const r of rows.results || []) {
    const u = await allocUid(c.env, tf.id);
    await c.env.DB.prepare('UPDATE messages SET folder_id=?1, uid=?2, flag_deleted=?3 WHERE id=?4')
      .bind(tf.id, u, target === 'trash' ? 1 : 0, r.id)
      .run();
  }
  return (rows.results || []).length;
}

app.post('/api/mailboxes/:mb/threads/:tid/action', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'), true);
  const tid = c.req.param('tid');
  const { action } = await c.req.json<any>();
  switch (action) {
    case 'read':
    case 'unread':
      await c.env.DB.prepare('UPDATE messages SET flag_seen=?1 WHERE mailbox_id=?2 AND thread_id=?3')
        .bind(action === 'read' ? 1 : 0, mb.id, tid).run();
      break;
    case 'trash':
      await moveThread(c, mb, tid, null, 'trash');
      break;
    case 'spam':
      await moveThread(c, mb, tid, ['inbox', 'archive'], 'spam');
      break;
    case 'archive':
      await moveThread(c, mb, tid, ['inbox'], 'archive');
      break;
    case 'inbox':
      await moveThread(c, mb, tid, ['trash', 'spam', 'archive'], 'inbox');
      break;
    case 'delete_forever': {
      const rows = await c.env.DB.prepare(
        `SELECT m.id, m.r2_key FROM messages m JOIN folders f ON f.id=m.folder_id
         WHERE m.mailbox_id=?1 AND m.thread_id=?2 AND f.role IN ('trash','spam')`
      ).bind(mb.id, tid).all<any>();
      const ids = (rows.results || []).map((r: any) => r.id);
      await deleteMessageDerived(c.env, ids);
      for (const r of rows.results || []) {
        await c.env.DB.prepare('DELETE FROM messages WHERE id=?1').bind(r.id).run();
        await c.env.RAW.delete(r.r2_key).catch(() => {});
      }
      break;
    }
    default:
      throw new HttpError(400, 'e_unknown_action');
  }
  return c.json({ ok: true });
});

// ---------- Sending / drafts / uploads ----------
// ---------- 发送 / 草稿 / 上传 ----------

app.post('/api/mailboxes/:mb/send', async (c) => {
  const user = c.get('user');
  const { mb } = await requireGrant(c, c.req.param('mb'), true);
  const body = await c.req.json<any>();
  const to = parseAddrList(String(body.to || ''));
  const cc = parseAddrList(String(body.cc || ''));
  const bcc = parseAddrList(String(body.bcc || ''));
  const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids.slice(0, 20) : [];
  const inlineImages = Array.isArray(body.inline_images)
    ? body.inline_images.slice(0, 50).map((x: any) => ({ upload_id: String(x.upload_id || ''), cid: String(x.cid || '') }))
        .filter((x: any) => x.upload_id && /^[A-Za-z0-9._@-]+$/.test(x.cid))
    : [];
  const result = await queueSend(c.env, user, mb, {
    to, cc, bcc,
    subject: String(body.subject || '').slice(0, 500),
    text: String(body.text || '').slice(0, 500000),
    html: body.html ? String(body.html).slice(0, 2000000) : undefined,
    replyToMessageId: body.reply_to_message_id || null,
    attachmentIds,
    inlineImages,
  });
  if (body.draft_id) {
    await c.env.DB.prepare('DELETE FROM drafts WHERE id=?1 AND user_id=?2').bind(body.draft_id, user.id).run();
  }
  // Drop inline uploads produced during this compose but not actually sent (originals replaced by a
  // resized copy, images pasted and then deleted).
  // Only ids this request references nowhere are removed -- the ones that did go out are read later
  // by the Resend channel in cron, so they must be left alone.
  // 清掉这次撰写里产生、但最终没随信发出的内联上传(被缩图取代的原图、粘了又删的图)。
  // 只删本请求完全没引用的 id —— 发出去的那份 Resend 通道要到 cron 里才读,不能碰。
  if (Array.isArray(body.discard_uploads) && body.discard_uploads.length) {
    const keep = new Set<string>([...attachmentIds.map(String), ...inlineImages.map((x: any) => x.upload_id)]);
    const ids = body.discard_uploads.slice(0, 100).map(String).filter((id: string) => id && !keep.has(id));
    for (const id of ids) {
      const up: any = await c.env.DB.prepare('SELECT r2_key FROM uploads WHERE id=?1 AND user_id=?2')
        .bind(id, user.id).first();
      if (!up) continue;
      await c.env.RAW.delete(up.r2_key).catch(() => {});
      await c.env.DB.prepare('DELETE FROM uploads WHERE id=?1 AND user_id=?2').bind(id, user.id).run();
    }
  }
  return c.json(result);
});

app.get('/api/mailboxes/:mb/drafts/:id', async (c) => {
  await requireGrant(c, c.req.param('mb'));
  const row = await c.env.DB.prepare('SELECT * FROM drafts WHERE id=?1 AND user_id=?2')
    .bind(c.req.param('id'), c.get('user').id).first<any>();
  if (!row) throw new HttpError(404, 'e_draft_not_found');
  return c.json({ id: row.id, payload: jsonTry(row.payload, {}), updated_at: row.updated_at });
});

app.post('/api/mailboxes/:mb/drafts', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'), true);
  const body = await c.req.json<any>();
  const id = body.id || uid();
  // Never slice serialised JSON -- cutting it mid-structure yields invalid JSON, and reading it back
  // silently empties the whole draft. Reject oversized payloads outright so the frontend can say so,
  // rather than quietly losing data.
  // 不能对序列化后的 JSON 做 slice —— 从中间截断会产生非法 JSON,读回时整条草稿静默变空。
  // 超限直接拒绝,让前端能提示,而不是悄悄丢数据。
  const payload = JSON.stringify(body.payload || {});
  if (payload.length > 900000) return c.json({ error: 'e_draft_too_big' }, 413);
  await c.env.DB.prepare(
    `INSERT INTO drafts (id, mailbox_id, user_id, payload, updated_at) VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(id) DO UPDATE SET payload=?4, updated_at=?5`
  ).bind(id, mb.id, c.get('user').id, payload, now()).run();
  return c.json({ id });
});

app.delete('/api/drafts/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM drafts WHERE id=?1 AND user_id=?2').bind(c.req.param('id'), c.get('user').id).run();
  return c.json({ ok: true });
});

app.post('/api/uploads', async (c) => {
  const user = c.get('user');
  const body = await c.req.parseBody();
  const f = body['file'];
  if (!(f instanceof File)) throw new HttpError(400, 'e_missing_file');
  if (f.size > 20 * 1024 * 1024) throw new HttpError(400, 'e_attach_too_big');
  const id = uid();
  const key = `uploads/${id}`;
  await c.env.RAW.put(key, await f.arrayBuffer());
  await c.env.DB.prepare(
    'INSERT INTO uploads (id, user_id, filename, mime, size, r2_key, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)'
  ).bind(id, user.id, f.name.slice(0, 200), f.type || 'application/octet-stream', f.size, key, now()).run();
  return c.json({ id, filename: f.name, size: f.size, mime: f.type });
});

// Fetch back a file you uploaded: inline images use it as their src while composing, and it keeps working when a draft is reopened
// 取回自己上传的文件:撰写时内联图片直接用它作 src,草稿重新打开也还能显示
app.get('/api/uploads/:id', async (c) => {
  const row: any = await c.env.DB.prepare('SELECT * FROM uploads WHERE id=?1 AND user_id=?2')
    .bind(c.req.param('id'), c.get('user').id)
    .first();
  if (!row) throw new HttpError(404, 'e_file_not_found');
  const obj = await c.env.RAW.get(row.r2_key);
  if (!obj) throw new HttpError(404, 'e_file_not_found');
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Length': String(row.size),
      'Cache-Control': 'private, max-age=86400',
    },
  });
});

// ---------- Development helper: inject a raw message ----------
// ---------- 开发辅助:注入一封原始邮件 ----------

app.post('/api/dev/ingest', async (c) => {
  if (c.env.DEV_MODE !== '1') return c.json({ error: 'e_not_available' }, 404);
  const rcpt = String(c.req.query('rcpt') || '');
  const mb = await findMailboxByAddress(c.env, rcpt);
  const envFrom = String(c.req.query('from') || 'unknown@example.com');
  if (!mb || mb.disabled) {
    // Behaves like the production email handler: file a copy, then refuse
    // 与线上 email handler 行为一致:留档 + 拒收
    const buf0 = await c.req.arrayBuffer();
    const key0 = `unrouted/${uid()}.eml`;
    await c.env.RAW.put(key0, buf0);
    await logUnrouted(c.env, { toAddr: rcpt, envelopeFrom: envFrom, buf: buf0, r2Key: key0, size: buf0.byteLength });
    return c.json({ ok: false, rejected: '550 no such recipient', logged_unrouted: true });
  }
  const buf = await c.req.arrayBuffer();
  const id = uid();
  const key = `raw/${id}.eml`;
  await c.env.RAW.put(key, buf);
  try {
    const mid = await ingestEml(c.env, {
      mailboxId: mb.id, buf, r2Key: key, size: buf.byteLength,
      folderRole: 'inbox', direction: 'in', envelopeFrom: String(c.req.query('from') || 'unknown@example.com'),
    });
    return c.json({ ok: true, message_id: mid });
  } catch (e: any) {
    await insertFailedPlaceholder(c.env, { mailboxId: mb.id, r2Key: key, size: buf.byteLength, envelopeFrom: 'unknown@example.com' });
    return c.json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Admin console ----------
// ---------- 管理后台 ----------

// AI assistant (signed-in users, gated by the admin switch)
// AI 助手(登录用户,受后台全局开关限制)
app.route('/api/chat', chatApp);

app.route('/api/drive', driveApp);

// Public share links: deliberately NOT behind requireAuth -- the whole point is that a
// recipient without an account can open them. Read-only by construction (see drive.ts).
// 公开共享链接:刻意不挂在 requireAuth 之后 —— 它的意义就在于没有账号的接收方也能打开。
// 按构造即只读(见 drive.ts)。
app.route('/api/pub', drivePubApp);

// Agent access links: no session, no Origin check, no /api prefix. The caller is a program that
// was handed one URL and nothing else, and everything it may do is expressed in that URL --
// which is exactly why this must sit outside the cookie-authenticated space. There is no
// ambient credential to ride on here, so there is no cross-site request to forge.
// 面向 AI 的访问链接:无会话、不查 Origin、不带 /api 前缀。调用者是一个只拿到一个 URL、
// 别无他物的程序,而它能做的一切都表达在那个 URL 里 —— 这正是它必须待在 cookie 认证空间
// 之外的原因。这里没有可搭便车的环境凭证,也就无从伪造跨站请求。
app.route('/agt', driveAgentApp);

app.route('/api/admin', adminApp);
