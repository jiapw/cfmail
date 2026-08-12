import { Hono } from 'hono';
import PostalMime from 'postal-mime';
import type { Env, User, FolderRole } from './types';
import {
  clearLoginFailures,
  createSession,
  createUser,
  destroySession,
  hashPassword,
  originCheck,
  registerLoginFailure,
  requireAuth,
  revokeAllSessions,
  userFromRequest,
  verifyPassword,
} from './auth';
import { createSystemFolders, deleteMessageDerived, findMailboxByAddress, getFolder, allocUid, ingestEml, insertFailedPlaceholder, logUnrouted, type MailboxRow } from './parse';
import { HttpError, queueSend, sendSystemMail, MAX_CONTENT_BYTES } from './send';
import { adminApp, LOCAL_PART_RE } from './admin';
import { verifyMail, resetMail } from './mailtpl';
import { fontsApp, isKnownFont } from './fonts';
import { chatApp } from './chat/routes';
import { chatDomainForHost } from './chat/settings';
import { VERSION } from './version';
import { ftsQuery, hasCJK, isEmail, jsonTry, normalizeAddr, now, parseAddrList, randomToken, sha256Hex, uid } from './util';

export const UI_LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru'];

type Ctx = { Bindings: Env; Variables: { user: User } };

export const app = new Hono<Ctx>();

app.use('/api/*', originCheck);

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  if (err instanceof SyntaxError) return c.json({ error: '请求格式错误' }, 400);
  console.log('unhandled', err);
  return c.json({ error: '服务器内部错误' }, 500);
});

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));

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

const CAPTCHA_FAIL = { error: '人机验证未通过,请重试' };

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
  if ((r?.n || 0) > 0) return c.json({ error: '系统已初始化' }, 400);
  const body = await c.req.json<any>();
  const email = normalizeAddr(String(body.email || ''));
  const name = String(body.name || '').trim().slice(0, 80);
  const password = String(body.password || '');
  if (!isEmail(email)) return c.json({ error: '邮箱格式不正确' }, 400);
  if (password.length < 8) return c.json({ error: '密码至少 8 位' }, 400);
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
  if (!u) return c.json({ error: '邮箱或密码错误' }, 401);
  if (u.disabled) return c.json({ error: '账号已被停用' }, 403);
  if (u.locked_until && u.locked_until > now()) return c.json({ error: '尝试次数过多,请 15 分钟后再试' }, 429);
  // The lockout window has passed: clear the failure counter first, otherwise it stays at >=10 forever and a single failure after the window re-locks the account instantly
  // 锁定窗口已过:先把失败计数清零,否则计数永远停在 >=10,窗口一过随便一次失败又立刻重新锁上
  if (u.locked_until && u.locked_until <= now()) {
    await clearLoginFailures(c.env, u.id);
    u.failed_logins = 0;
  }
  const ok = await verifyPassword(password, u.pw_hash);
  if (!ok) {
    await registerLoginFailure(c.env, u.id, u.failed_logins || 0);
    return c.json({ error: '邮箱或密码错误' }, 401);
  }
  await clearLoginFailures(c.env, u.id);
  await createSession(c as any, u.id);
  return c.json({ ok: true });
});

app.post('/api/auth/logout', async (c) => {
  await destroySession(c as any);
  return c.json({ ok: true });
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
  if (!row || row.used_at || row.expires_at < now()) return c.json({ error: '链接无效或已过期' }, 400);
  const u = await c.env.DB.prepare('SELECT email FROM users WHERE id=?1').bind(row.user_id).first<any>();
  return c.json({ ok: true, email: u?.email || '' });
});

app.post('/api/auth/reset/confirm', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const pw = String(body.password || '');
  if (pw.length < 8) return c.json({ error: '密码至少 8 位' }, 400);
  const row = await c.env.DB.prepare('SELECT * FROM password_resets WHERE token_hash=?1')
    .bind(await sha256Hex(String(body.token || ''))).first<any>();
  if (!row || row.used_at || row.expires_at < now()) return c.json({ error: '链接无效或已过期' }, 400);
  // Atomic consumption: under concurrency only one request can flip used_at away from NULL, and a failed claim never changes the password
  // 原子消费:并发下只有一次能把 used_at 从 NULL 翻上,认领失败就不改密码
  const claim = await c.env.DB.prepare('UPDATE password_resets SET used_at=?1 WHERE id=?2 AND used_at IS NULL')
    .bind(now(), row.id).run();
  if (!(claim.meta as any)?.changes) return c.json({ error: '链接无效或已过期' }, 400);
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
  if (!inv) return { error: '邀请不存在' };
  if (inv.revoked) return { error: '邀请已被撤销' };
  if (inv.used_by) return { error: '邀请已被使用' };
  if (inv.expires_at < now()) return { error: '邀请已过期' };
  // Links issued before the rework (attached to an existing mailbox) are all refused; ask the administrator for a new one
  // 改造前发出的链接(挂在已存在邮箱上)一律不认,请管理员重新生成
  if ((inv.mailbox_mode || 'fixed') === 'fixed' && !inv.local_part) {
    return { error: '该邀请链接已失效,请向管理员索取新的链接' };
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
  if (!inv || (inv.mailbox_mode || 'fixed') !== 'choose') return c.json({ error: '不适用' }, 400);
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

  if (!isEmail(email)) return c.json({ error: '邮箱格式不正确' }, 400);
  if (inv.email && normalizeAddr(inv.email) !== email) return c.json({ error: `该邀请仅限 ${inv.email} 使用` }, 403);
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?1').bind(email).first<any>();
  if (exists) return c.json({ error: '该邮箱已注册,请先登录后再打开此邀请链接' }, 409);
  if (password.length < 8) return c.json({ error: '密码至少 8 位' }, 400);

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
  // Cap the total codes one invite may send: an invite is single-use, so it has no business mailing many different addresses. This blocks using one link to blast codes at arbitrary mailboxes.
  // 单个邀请的发码总数封顶:邀请单次使用,不该给一堆不同邮箱发码;拦住向任意邮箱轰炸验证码
  if ((inv.send_count || 0) >= 10) {
    return c.json({ error: '该邀请的验证码发送次数已达上限,请让管理员重新生成邀请' }, 429);
  }

  // Mailbox name not pinned: settle and check the name here, so we do not discover it was taken only after verification
  // 不限定邮箱名:先在这一步把名字定下来并查重,免得验证完了才发现被占
  let mailboxName: string | null = null;
  if ((inv.mailbox_mode || 'fixed') === 'choose') {
    mailboxName = String(body.mailbox_name || '').trim().toLowerCase();
    if (!LOCAL_PART_RE.test(mailboxName)) return c.json({ error: '邮箱名格式不正确' }, 400);
    if (await mailboxNameTaken(c.env, inv.domain_id, mailboxName)) return c.json({ error: '该邮箱名已被占用' }, 409);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const id = uid();
  const { domain, brand } = await inviteBrand(c.env, inv);
  if (!domain) return c.json({ error: '系统尚未配置发信域名,无法发送验证码' }, 500);

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
    return c.json({ error: `验证码发送失败:${sent.error || '未知错误'}` }, 502);
  }
  await c.env.DB.prepare('UPDATE invites SET send_count=send_count+1 WHERE id=?1').bind(inv.id).run();
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
  if (!reg) return c.json({ error: '验证会话不存在,请重新提交' }, 400);
  if (reg.expires_at < now()) {
    await c.env.DB.prepare('DELETE FROM pending_regs WHERE id=?1').bind(regId).run();
    return c.json({ error: '验证码已过期,请重新获取' }, 400);
  }
  if (reg.attempts >= CODE_MAX_ATTEMPTS) {
    await c.env.DB.prepare('DELETE FROM pending_regs WHERE id=?1').bind(regId).run();
    return c.json({ error: '尝试次数过多,请重新获取验证码' }, 429);
  }
  if ((await sha256Hex(code)) !== reg.code_hash) {
    await c.env.DB.prepare('UPDATE pending_regs SET attempts=attempts+1 WHERE id=?1').bind(regId).run();
    return c.json({ error: '验证码不正确', remaining: CODE_MAX_ATTEMPTS - reg.attempts - 1 }, 400);
  }
  // Race backstop: the address may have been registered while verification was in flight
  // 竞态兜底:验证期间该邮箱可能已被注册
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?1').bind(reg.email).first<any>();
  if (exists) {
    await c.env.DB.prepare('DELETE FROM pending_regs WHERE id=?1').bind(regId).run();
    return c.json({ error: '该邮箱已注册,请直接登录' }, 409);
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
    return c.json({ error: e?.message || '开通邮箱失败,请重试' }, e?.status || 400);
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
  if (!me) return c.json({ error: '请先登录,或使用注册流程' }, 401);
  if (inv.email && normalizeAddr(inv.email) !== me.email) {
    return c.json({ error: `该邀请指定给 ${inv.email},当前登录的是 ${me.email}` }, 403);
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
  if (!inv.domain_id) throw new HttpError(400, '邀请数据不完整,请重新生成链接');
  // Atomic claim: under concurrency only one request can flip used_by from NULL to this user, so one invite can never be redeemed into several accounts
  // 原子认领:并发下只有一个请求能把 used_by 从 NULL 翻成本人,杜绝一条邀请被同时兑换成多个账号
  const claim = await env.DB.prepare(
    'UPDATE invites SET used_by=?1, used_at=?2 WHERE id=?3 AND used_by IS NULL AND revoked=0'
  ).bind(userId, now(), inv.id).run();
  if (!(claim.meta as any)?.changes) throw new HttpError(409, '邀请已被使用');
  try {
    const localPart = mode === 'choose' ? String(chosenName || '').trim().toLowerCase() : String(inv.local_part || '');
    if (!LOCAL_PART_RE.test(localPart)) throw new HttpError(400, '邮箱名格式不正确');
    const role = mode === 'choose' ? 'owner' : ['owner', 'member', 'readonly'].includes(inv.role) ? inv.role : 'owner';

    let mb = await env.DB.prepare('SELECT id FROM mailboxes WHERE domain_id=?1 AND local_part=?2')
      .bind(inv.domain_id, localPart).first<any>();
    if (!mb) {
      if (await mailboxNameTaken(env, inv.domain_id, localPart)) throw new HttpError(409, '该邮箱名已被占用');
      const mbId = uid();
      await env.DB.prepare(
        'INSERT INTO mailboxes (id, domain_id, local_part, display_name, created_at) VALUES (?1,?2,?3,?4,?5)'
      ).bind(mbId, inv.domain_id, localPart, '', now()).run();
      await createSystemFolders(env, mbId);
      mb = { id: mbId };
    } else if (mode === 'choose') {
      throw new HttpError(409, '该邮箱名已被占用'); // 自取名时撞上已存在的邮箱,必须换一个
    }
    await env.DB.prepare(
      'INSERT INTO grants (user_id, mailbox_id, role, created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(user_id, mailbox_id) DO UPDATE SET role=?3'
    ).bind(userId, mb.id, role, now()).run();
  } catch (e) {
    // Provisioning failed (a self-chosen name collided, say): hand the claim back so the user can retry with another name instead of burning the invite
    // 开通失败(如自取名撞车):把认领退回去,让用户换个名字重试,不至于白白作废邀请
    await env.DB.prepare('UPDATE invites SET used_by=NULL, used_at=NULL WHERE id=?1').bind(inv.id).run();
    throw e;
  }
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
  const langRow = await c.env.DB.prepare('SELECT lang, appearance, ui_font, body_font FROM users WHERE id=?1')
    .bind(user.id).first<any>();
  // The AI assistant switch is per entry host
  // AI 助手开关按访问域名生效(intl-mail.<域名>)
  const chatDom = await chatDomainForHost(c.env, new URL(c.req.url).hostname).catch(() => null);
  return c.json({
    user: {
      id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin,
      lang: langRow?.lang || null, appearance: langRow?.appearance || null,
      ui_font: langRow?.ui_font || null, body_font: langRow?.body_font || null,
    },
    domain_admin_of: (da.results || []).map((r: any) => r.domain_id),
    mailboxes,
    send_enabled: c.env.MAIL_PROVIDER !== 'dev',
    provider: c.env.MAIL_PROVIDER,
    max_content_bytes: MAX_CONTENT_BYTES, // 前端实时估算用,和发送校验同一个数
    chat_enabled: !!chatDom?.enabled, // 当前访问域名是否开启 AI 助手
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
  if (ui === undefined || bodyFont === undefined) return c.json({ error: 'unknown font' }, 400);
  await c.env.DB.prepare('UPDATE users SET ui_font=?1, body_font=?2 WHERE id=?3')
    .bind(ui, bodyFont, c.get('user').id).run();
  return c.json({ ok: true });
});

app.post('/api/me/appearance', async (c) => {
  const body = await c.req.json<any>();
  const v = String(body.appearance || '');
  if (!['light', 'dark', 'auto'].includes(v)) return c.json({ error: 'bad appearance' }, 400);
  await c.env.DB.prepare('UPDATE users SET appearance=?1 WHERE id=?2').bind(v, c.get('user').id).run();
  return c.json({ ok: true });
});

app.post('/api/me/lang', async (c) => {
  const body = await c.req.json<any>();
  const lang = String(body.lang || '');
  if (!UI_LANGS.includes(lang)) return c.json({ error: 'unsupported language' }, 400);
  await c.env.DB.prepare('UPDATE users SET lang=?1 WHERE id=?2').bind(lang, c.get('user').id).run();
  return c.json({ ok: true });
});

app.post('/api/me/password', async (c) => {
  const body = await c.req.json<any>();
  const u = await c.env.DB.prepare('SELECT pw_hash FROM users WHERE id=?1').bind(c.get('user').id).first<any>();
  if (!u || !(await verifyPassword(String(body.old || ''), u.pw_hash))) return c.json({ error: '原密码错误' }, 400);
  const npw = String(body.new || '');
  if (npw.length < 8) return c.json({ error: '新密码至少 8 位' }, 400);
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
  if (!row || row.disabled) throw new HttpError(403, '无权访问该邮箱');
  if (write && row.role === 'readonly') throw new HttpError(403, '只读权限,不能执行此操作');
  return { mb: row as MailboxRow, role: row.role };
}

async function requireMessage(c: any, messageId: string, write = false) {
  const msg = await c.env.DB.prepare('SELECT * FROM messages WHERE id=?1').bind(messageId).first();
  if (!msg) throw new HttpError(404, '邮件不存在');
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
      `SELECT addr, name, internal, times, last_seen, safe FROM contacts
       WHERE mailbox_id=?1 AND (addr LIKE ?2 OR name LIKE ?2)
       ORDER BY times DESC, last_seen DESC LIMIT ?3`
    ).bind(mb.id, like, limit).all();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT addr, name, internal, times, last_seen, safe FROM contacts
       WHERE mailbox_id=?1 ORDER BY internal DESC, times DESC, last_seen DESC LIMIT ?2`
    ).bind(mb.id, limit).all();
  }
  return c.json({ contacts: rows.results || [] });
});

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
        subject: p.subject || '(无主题)',
        snippet: (p.text || '').slice(0, 120),
        from_name: '草稿',
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
        WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam') AND ${hitWhere}
      ), t AS (SELECT thread_id, MAX(date) AS last_date, COUNT(*) AS cnt FROM hit GROUP BY thread_id)
      SELECT t.thread_id, t.last_date, t.cnt,
        (SELECT SUM(CASE WHEN flag_seen=0 THEN 1 ELSE 0 END) FROM messages WHERE mailbox_id=?1 AND thread_id=t.thread_id) AS unread,
        (SELECT MAX(flag_flagged) FROM messages WHERE mailbox_id=?1 AND thread_id=t.thread_id) AS starred,
        MAX(m.has_attachments) AS hasatt, m.subject, m.snippet, m.from_addr, m.from_name, m.direction, m.to_json
      FROM t JOIN messages m ON m.mailbox_id=?1 AND m.thread_id=t.thread_id AND m.date=t.last_date
      GROUP BY t.thread_id ORDER BY t.last_date DESC LIMIT ?3 OFFSET ?4`;
    binds = [mb.id, like || ftsQuery(q), PAGE_SIZE + 1, page * PAGE_SIZE];
    countSql = `SELECT COUNT(DISTINCT m.thread_id) AS n FROM messages m
        JOIN message_texts mt ON mt.message_id = m.id
        JOIN messages_fts ON messages_fts.rowid = mt.mrow
        JOIN folders f ON f.id = m.folder_id
        WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam') AND ${hitWhere}`;
    countBinds = [mb.id, like || ftsQuery(q)];
  } else if (folder === 'starred') {
    // Conversations aggregate across folders (Gmail semantics): one starred message selects the whole conversation, and counts and unread totals span it
    // 会话跨文件夹聚合(Gmail 语义):任一封被星标即入选,数量/未读按整个会话算
    sql = `WITH tw AS (
        SELECT m.thread_id, MAX(m.date) AS last_date, COUNT(*) AS cnt,
          SUM(CASE WHEN m.flag_seen=0 THEN 1 ELSE 0 END) AS unread, 1 AS starred, MAX(m.has_attachments) AS hasatt
        FROM messages m JOIN folders f ON f.id=m.folder_id
        WHERE m.mailbox_id=?1 AND f.role NOT IN ('trash','spam')
        GROUP BY m.thread_id HAVING MAX(m.flag_flagged)=1)
      SELECT tw.*, m.subject, m.snippet, m.from_addr, m.from_name, m.direction, m.to_json
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
        m.subject, m.snippet, m.from_addr, m.from_name, m.direction, m.to_json
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
  return c.json({
    threads: list.slice(0, PAGE_SIZE),
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
  if (!msgs.length) throw new HttpError(404, '会话不存在');

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
  if (!obj) throw new HttpError(404, '原始邮件已不存在');
  const buf = await obj.arrayBuffer();
  return await new PostalMime().parse(buf);
}

/** Is this sender trusted? An explicit setting on the contact wins; otherwise local senders are safe by default and external ones are not
 *  该发件人是否可信:联系人显式设置优先,否则站内默认安全、外部默认不安全 */
async function senderIsSafe(c: any, mailboxId: string, addr: string): Promise<boolean> {
  const a = normalizeAddr(addr || '');
  if (!a) return false;
  const row: any = await c.env.DB.prepare('SELECT safe, internal FROM contacts WHERE mailbox_id=?1 AND addr=?2')
    .bind(mailboxId, a).first();
  if (row && row.safe !== null && row.safe !== undefined) return !!row.safe;
  if (row) return !!row.internal;
  // Not in the address book yet: decide from whether the address is local
  // 通讯录里还没有这个人:按是否站内地址判断
  const mb = await findMailboxByAddress(c.env, a).catch(() => null);
  return !!mb;
}

app.get('/api/messages/:id/body', async (c) => {
  const { msg } = await requireMessage(c, c.req.param('id'));
  const parsed: any = await loadParsed(c, msg);
  let html: string | null = parsed.html || null;
  let blocked = 0;
  // ?images=1 means the user clicked "show images" in the interface -- allow them this once
  // ?images=1 表示用户在界面上点了"显示图片",本次放行
  const force = c.req.query('images') === '1';
  const safe = force || (await senderIsSafe(c, msg.mailbox_id, msg.from_addr));

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
  return c.json({ html, text: parsed.text || null, images_blocked: blocked, sender_safe: safe });
});

/** Set a contact's safety switch (safe: true / false / null = back to the default)
 *  设置某个联系人的安全开关(safe: true/false/null=恢复默认) */
app.post('/api/mailboxes/:mb/contacts/safe', async (c) => {
  const { mb } = await requireGrant(c, c.req.param('mb'), true);
  const body = await c.req.json<any>();
  const addr = normalizeAddr(String(body.addr || ''));
  if (!isEmail(addr)) return c.json({ error: '地址格式不正确' }, 400);
  const safe = body.safe === null ? null : body.safe ? 1 : 0;
  const exists = await c.env.DB.prepare('SELECT id FROM contacts WHERE mailbox_id=?1 AND addr=?2')
    .bind(mb.id, addr).first<any>();
  if (exists) {
    await c.env.DB.prepare('UPDATE contacts SET safe=?1 WHERE id=?2').bind(safe, exists.id).run();
  } else {
    const internal = (await findMailboxByAddress(c.env, addr).catch(() => null)) ? 1 : 0;
    await c.env.DB.prepare(
      'INSERT INTO contacts (id, mailbox_id, addr, name, internal, times, last_seen, safe) VALUES (?1,?2,?3,?4,?5,0,?6,?7)'
    ).bind(uid(), mb.id, addr, '', internal, now(), safe).run();
  }
  return c.json({ ok: true, safe });
});

app.get('/api/messages/:id/raw', async (c) => {
  const { msg } = await requireMessage(c, c.req.param('id'));
  const obj = await c.env.RAW.get(msg.r2_key);
  if (!obj) throw new HttpError(404, '原始邮件已不存在');
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
  if (!meta) throw new HttpError(404, '附件不存在');
  const parsed: any = await loadParsed(c, msg);
  const atts = (parsed.attachments || []).filter((a: any) => a && a.content);
  const att = atts[idx];
  if (!att) throw new HttpError(404, '附件不存在');
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

app.post('/api/messages/:id/flags', async (c) => {
  const { msg } = await requireMessage(c, c.req.param('id'), true);
  const body = await c.req.json<any>();
  const sets: string[] = [];
  const binds: any[] = [];
  if (typeof body.seen === 'boolean') { sets.push(`flag_seen=?${binds.length + 1}`); binds.push(body.seen ? 1 : 0); }
  if (typeof body.flagged === 'boolean') { sets.push(`flag_flagged=?${binds.length + 1}`); binds.push(body.flagged ? 1 : 0); }
  if (!sets.length) return c.json({ ok: true });
  binds.push(msg.id);
  await c.env.DB.prepare(`UPDATE messages SET ${sets.join(',')} WHERE id=?${binds.length}`).bind(...binds).run();
  return c.json({ ok: true });
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
    case 'star': {
      const latest = await c.env.DB.prepare(
        'SELECT id FROM messages WHERE mailbox_id=?1 AND thread_id=?2 ORDER BY date DESC LIMIT 1'
      ).bind(mb.id, tid).first<any>();
      if (latest) await c.env.DB.prepare('UPDATE messages SET flag_flagged=1 WHERE id=?1').bind(latest.id).run();
      break;
    }
    case 'unstar':
      await c.env.DB.prepare('UPDATE messages SET flag_flagged=0 WHERE mailbox_id=?1 AND thread_id=?2').bind(mb.id, tid).run();
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
      throw new HttpError(400, '未知操作');
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
  if (!row) throw new HttpError(404, '草稿不存在');
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
  if (payload.length > 900000) return c.json({ error: '草稿内容过大,请精简后再保存' }, 413);
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
  if (!(f instanceof File)) throw new HttpError(400, '缺少文件');
  if (f.size > 20 * 1024 * 1024) throw new HttpError(400, '单个附件不能超过 20MB');
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
  if (!row) throw new HttpError(404, '文件不存在');
  const obj = await c.env.RAW.get(row.r2_key);
  if (!obj) throw new HttpError(404, '文件不存在');
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
  if (c.env.DEV_MODE !== '1') return c.json({ error: 'not available' }, 404);
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

app.route('/api/admin', adminApp);
