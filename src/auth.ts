import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, User } from './types';
import { b64decode, b64encode, now, randomToken, sha256Hex, timingSafeEqual, uid } from './util';

// WebCrypto in the Workers production runtime caps PBKDF2 at 100000 iterations
// Workers 生产环境 WebCrypto 对 PBKDF2 的硬上限是 100000 次迭代
const PBKDF2_ITER = 100000;
const SESSION_TTL = 30 * 24 * 3600 * 1000;
export const COOKIE = 'sid';

async function pbkdf2(pw: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pw, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  const salt = b64decode(parts[2]);
  const expect = b64decode(parts[3]);
  const got = await pbkdf2(pw, salt, iter);
  return timingSafeEqual(got, expect);
}

export async function createSession(c: Context<any>, userId: string): Promise<void> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const t = now();
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, ua, created_at, expires_at) VALUES (?1,?2,?3,?4,?5)')
    .bind(id, userId, (c.req.header('User-Agent') || '').slice(0, 200), t, t + SESSION_TTL)
    .run();
  await c.env.DB.prepare('UPDATE users SET last_login=?1 WHERE id=?2').bind(t, userId).run();
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL / 1000,
  });
}

/** Invalidate a user's sessions on every device at once (admin revoke, password change and password reset all come through here)
 *  让某个用户在所有设备上的登录立刻失效(管理员强制下线、改密码、重置密码都走这里) */
export async function revokeAllSessions(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare('DELETE FROM sessions WHERE user_id=?1').bind(userId).run();
  return (r.meta as any)?.changes || 0;
}

export async function destroySession(c: Context<any>): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) {
    const id = await sha256Hex(token);
    await c.env.DB.prepare('DELETE FROM sessions WHERE id=?1').bind(id).run();
  }
  deleteCookie(c, COOKIE, { path: '/' });
}

export async function userFromRequest(c: Context<any>): Promise<User | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = (await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, u.disabled
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id=?1 AND s.expires_at > ?2`
  )
    .bind(id, now())
    .first()) as User | null;
  if (!row || row.disabled) return null;
  return row;
}

type Vars = { Variables: { user: User }; Bindings: Env };

/** Origin check on state-changing requests, to block CSRF. Fail-closed: missing or mismatched is refused.
 *  Browsers always send Origin on non-GET/HEAD fetches (independent of Referrer-Policy -- even no-referrer sends it);
 *  the only non-browser caller (scripts/import-eml.mjs) sets it explicitly. So a missing Origin is treated as CSRF.
 *  变更类请求校验 Origin,防 CSRF —— fail-closed:缺失或不匹配一律拒。
 *  浏览器 fetch 对非 GET/HEAD 必带 Origin(与 Referrer-Policy 无关,no-referrer 也照发);
 *  唯一的非浏览器调用方(scripts/import-eml.mjs)显式带了 Origin。所以缺 Origin 直接判 CSRF。 */
export async function originCheck(c: Context<any>, next: Next) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (!origin || origin !== new URL(c.req.url).origin) {
      return c.json({ error: 'e_origin_check' }, 403);
    }
  }
  await next();
}

export async function requireAuth(c: Context<Vars>, next: Next) {
  const user = await userFromRequest(c);
  if (!user) return c.json({ error: 'e_unauthorized' }, 401);
  c.set('user', user);
  await next();
}

/** Login rate limit: 10 failures locks the account for 15 minutes
 *  登录失败限速:10 次错误锁 15 分钟 */
export async function registerLoginFailure(env: Env, userId: string, failed: number): Promise<void> {
  const lock = failed + 1 >= 10 ? now() + 15 * 60 * 1000 : null;
  await env.DB.prepare('UPDATE users SET failed_logins=failed_logins+1, locked_until=COALESCE(?1, locked_until) WHERE id=?2')
    .bind(lock, userId)
    .run();
}

export async function clearLoginFailures(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?1').bind(userId).run();
}

/** Shared path for creating a new user
 *  新用户通用创建 */
export async function createUser(env: Env, email: string, name: string, password: string, isAdmin = false): Promise<string> {
  const id = uid();
  const pw = await hashPassword(password);
  await env.DB.prepare(
    'INSERT INTO users (id, email, name, pw_hash, is_admin, created_at) VALUES (?1,?2,?3,?4,?5,?6)'
  )
    .bind(id, email, name, pw, isAdmin ? 1 : 0, now())
    .run();
  return id;
}
