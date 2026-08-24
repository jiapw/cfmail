import { Hono } from 'hono';
import PostalMime from 'postal-mime';
import type { Env, User } from './types';
import { THEME_NAMES } from './themes-list';
import { isKnownFont } from './fonts';
import { beginImpersonation, requireAuth, revokeAllSessions } from './auth';
import { backupStatus, setBackupEnabled, startBackupNow } from './backup';
import { createSystemFolders, ingestEml, type PreParsed } from './parse';
import { HttpError, E } from './errors';
import { isEmail, jsonTry, normalizeAddr, now, randomToken, sha256Hex, uid } from './util';
import { chatAdminApp } from './chat/routes';
// Circular on purpose (drive.ts imports adminScope back); both sides only use hoisted function declarations
// 有意的循环引用(drive.ts 反向引 adminScope);两边用到的都是提升的函数声明,安全
import { driveAdminApp } from './drive';
import { audit } from './audit';
import { pickColor, pickIcon } from './labels';

type Ctx = { Bindings: Env; Variables: { user: User } };

/** The one rule for a company mailbox local part: lowercase letters and digits plus . _ -, and it
 *  must start and end alphanumeric.
 *  Everything (creating mailboxes, aliases, invitee-chosen names) shares this rule, so an address
 *  can never be "creatable by an admin but rejected at signup".
 *  企业邮箱 local part 唯一规则:小写字母/数字加 . _ - ,首尾必须是字母数字。
 *  全站(邮箱创建、别名、邀请自取名)共用这一条,避免"管理员能建、注册端却拒"的分歧。 */
export const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

/** A human-readable name for a mailbox in the audit log; falls back to local_part when the domain cannot be resolved
 *  审计日志里给邮箱一个人类可读的名字;拿不到域名就退回 local_part */
async function addrOf(env: Env, mb: any): Promise<string> {
  const d = await env.DB.prepare('SELECT name FROM domains WHERE id=?1').bind(mb.domain_id).first<any>();
  return d?.name ? `${mb.local_part}@${d.name}` : String(mb.local_part || '');
}

export const adminApp = new Hono<Ctx>();

adminApp.use('*', requireAuth);

/**
 * A borrowed session cannot enter the console. Everything else -- mail, Drive, chat, settings --
 * behaves exactly as it does for the person being looked at, which is the point; but an audit
 * line reading "she deleted the mailbox" when it was somebody else at the keyboard is the system
 * lying about itself, and the console is where those lines are written.
 *
 * 借来的会话进不了后台。其余一切 —— 邮件、网盘、助手、设置 —— 与被查看者本人完全一致,
 * 这正是这个功能的意义;但当键盘后面坐的是别人时,一条写着"她删掉了这个邮箱"的审计,
 * 是系统在对自己说谎 —— 而后台正是写这些记录的地方。
 */
adminApp.use('*', async (c, next) => {
  if (c.get('user')?.impersonator_id) throw new HttpError(403, 'e_impersonating');
  await next();
});

// AI assistant settings (global admins only -- chatAdminApp checks that itself)
// AI 助手设置(仅全局管理员,chatAdminApp 内部自查)
adminApp.route('/chat', chatAdminApp);

// Drive settings (domain admins manage their own domains; scoping inside)
// 网盘设置(域管理员可管自己的域,内部自查权限范围)
adminApp.route('/drive', driveAdminApp);

/** Invite links live on the matching company domain's entry host; local development uses APP_ORIGIN
 *  邀请链接挂在对应企业域名的 intl-mail.<domain> 上;本地开发用 APP_ORIGIN */
export function inviteUrl(env: Env, domainName: string | null, token: string): string {
  const base = env.DEV_MODE === '1' || !domainName ? env.APP_ORIGIN : `https://intl-mail.${domainName}`;
  return `${base}/#/invite/${token}`;
}

/** Returns null for a global admin (no domain limit); otherwise the set of manageable domain ids
 *  返回 null 表示全局管理员(不限域);否则为可管理的域名 id 集合 */
export async function adminScope(c: any): Promise<Set<string> | null> {
  const user: User = c.get('user');
  if (user.is_admin) return null;
  const rows = await c.env.DB.prepare('SELECT domain_id FROM domain_admins WHERE user_id=?1').bind(user.id).all();
  const set = new Set<string>((rows.results || []).map((r: any) => r.domain_id));
  if (!set.size) throw new HttpError(403, 'e_not_admin');
  return set;
}

function requireGlobalAdmin(c: any): User {
  const user: User = c.get('user');
  if (!user.is_admin) throw new HttpError(403, 'e_global_admin_only');
  return user;
}

export async function checkDomainScope(c: any, domainId: string): Promise<void> {
  const scope = await adminScope(c);
  if (scope && !scope.has(domainId)) throw new HttpError(403, 'e_no_domain_perm');
}

// ---------- Overview: statistics per domain ----------
// ---------- 总览:按域名统计 ----------

adminApp.get('/overview', async (c) => {
  const scope = await adminScope(c);
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.name, d.created_at,
      (SELECT COUNT(*) FROM mailboxes mb WHERE mb.domain_id=d.id) AS mailbox_count,
      (SELECT COUNT(DISTINCT g.user_id) FROM grants g JOIN mailboxes mb2 ON mb2.id=g.mailbox_id WHERE mb2.domain_id=d.id) AS member_count,
      COALESCE(s.msg_count,0) AS msg_count, COALESCE(s.msg_in,0) AS msg_in, COALESCE(s.msg_out,0) AS msg_out,
      COALESCE(s.bytes,0) AS bytes, s.last_activity
     FROM domains d LEFT JOIN (
       SELECT mb.domain_id AS did, COUNT(m.id) AS msg_count,
         SUM(CASE WHEN m.direction='in' THEN 1 ELSE 0 END) AS msg_in,
         SUM(CASE WHEN m.direction='out' THEN 1 ELSE 0 END) AS msg_out,
         SUM(m.size) AS bytes, MAX(m.internal_date) AS last_activity
       FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id GROUP BY mb.domain_id
     ) s ON s.did=d.id ORDER BY d.name`
  ).all<any>();
  let domains = rows.results || [];
  if (scope) domains = domains.filter((d: any) => scope.has(d.id));
  // The outbox is a site-wide send queue with no domain dimension, so it is shown to global admins only -- a domain admin should not see cross-domain send volumes
  // outbox 是全站发件队列聚合,没有域维度;只给全局管理员看,不泄露跨域发件总量给域管理员
  const outbox = scope
    ? { results: [] }
    : await c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all<any>();
  return c.json({ domains, outbox: outbox.results || [], is_global_admin: !!c.get('user').is_admin });
});

// ---------- Domains ----------
// ---------- 域名 ----------

adminApp.get('/domains', async (c) => {
  const scope = await adminScope(c);
  const rows = await c.env.DB.prepare('SELECT id, name, created_at FROM domains ORDER BY name').all<any>();
  let list = rows.results || [];
  if (scope) list = list.filter((d: any) => scope.has(d.id));
  return c.json({ domains: list });
});

adminApp.post('/domains', async (c) => {
  requireGlobalAdmin(c);
  const body = await c.req.json<any>();
  const name = normalizeAddr(String(body.name || ''));
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(name)) return c.json({ error: 'e_bad_domain' }, 400);
  const exists = await c.env.DB.prepare('SELECT id FROM domains WHERE name=?1').bind(name).first<any>();
  if (exists) return c.json({ error: 'e_domain_exists' }, 409);
  const id = uid();
  await c.env.DB.prepare('INSERT INTO domains (id, name, created_at) VALUES (?1,?2,?3)').bind(id, name, now()).run();
  // The creator is not made a domain admin of it. Only a global admin can get here, and a
  // global admin needs no such row -- adminScope lets them through on is_admin alone. The row
  // would only ever matter later, on the day that person stops being a global admin, and it
  // would quietly leave them administering every domain they ever created.
  // 创建者不会被写成该域的域管理员。能走到这里的只有全局管理员,而全局管理员根本不需要这一行 ——
  // adminScope 见到 is_admin 就直接放行。这一行唯一会起作用的时刻,是这个人不再是全局管理员的那天,
  // 那时它会让他悄悄保留着自己建过的每一个域的管理权。
  return c.json({ id, name });
});

adminApp.get('/domains/:id/admins', async (c) => {
  await checkDomainScope(c, c.req.param('id'));
  const rows = await c.env.DB.prepare(
    'SELECT u.id, u.email, u.name FROM domain_admins da JOIN users u ON u.id=da.user_id WHERE da.domain_id=?1'
  ).bind(c.req.param('id')).all<any>();
  return c.json({ admins: rows.results || [] });
});

/* Appointing is the global admin's alone: a domain admin who could appoint another could hand
 * out their own authority, and nothing above them would stop it. Reading the list stays open --
 * knowing who else administers your domain is not a privilege, it is how you know whom to ask.
 * 任命权只属于全局管理员:域管理员若能任命,就能把自己的权限复制出去,而上面没有任何东西拦得住。
 * 名单仍然对域管理员开放 —— 知道自己这个域还有谁在管,不是特权,而是你该找谁的常识。 */
adminApp.post('/domains/:id/admins', async (c) => {
  const domainId = c.req.param('id');
  const actor = requireGlobalAdmin(c);
  const body = await c.req.json<any>();
  const email = normalizeAddr(String(body.email || ''));
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE email=?1').bind(email).first<any>();
  if (!u) return c.json({ error: 'e_user_not_registered' }, 404);
  await c.env.DB.prepare('INSERT OR IGNORE INTO domain_admins (user_id, domain_id) VALUES (?1,?2)').bind(u.id, domainId).run();
  await audit(c.env, actor, 'domain.admin_add', email, undefined, domainId);
  return c.json({ ok: true });
});

adminApp.delete('/domains/:id/admins/:userId', async (c) => {
  const actor = requireGlobalAdmin(c);
  const gone = await c.env.DB.prepare('SELECT email FROM users WHERE id=?1')
    .bind(c.req.param('userId')).first<any>();
  await c.env.DB.prepare('DELETE FROM domain_admins WHERE domain_id=?1 AND user_id=?2')
    .bind(c.req.param('id'), c.req.param('userId')).run();
  await audit(c.env, actor, 'domain.admin_remove', gone?.email || c.req.param('userId'), undefined, c.req.param('id'));
  return c.json({ ok: true });
});

// ---------- Mailbox accounts ----------
// ---------- 邮箱账号 ----------

adminApp.get('/domains/:id/mailboxes', async (c) => {
  const domainId = c.req.param('id');
  await checkDomainScope(c, domainId);
  const rows = await c.env.DB.prepare(
    `SELECT mb.id, mb.local_part, mb.display_name, mb.disabled, mb.created_at,
       COALESCE(s.msg_count,0) AS msg_count, COALESCE(s.bytes,0) AS bytes, s.last_activity
     FROM mailboxes mb LEFT JOIN (
       SELECT mailbox_id, COUNT(*) AS msg_count, SUM(size) AS bytes, MAX(internal_date) AS last_activity
       FROM messages GROUP BY mailbox_id
     ) s ON s.mailbox_id=mb.id
     WHERE mb.domain_id=?1 ORDER BY mb.local_part`
  ).bind(domainId).all<any>();
  const grants = await c.env.DB.prepare(
    `SELECT g.mailbox_id, g.role, u.id AS user_id, u.email, u.name
     FROM grants g JOIN users u ON u.id=g.user_id JOIN mailboxes mb ON mb.id=g.mailbox_id
     WHERE mb.domain_id=?1`
  ).bind(domainId).all<any>();
  const byMb: Record<string, any[]> = {};
  for (const g of grants.results || []) (byMb[g.mailbox_id] ||= []).push(g);
  return c.json({ mailboxes: (rows.results || []).map((m: any) => ({ ...m, members: byMb[m.id] || [] })) });
});

adminApp.post('/domains/:id/mailboxes', async (c) => {
  const domainId = c.req.param('id');
  await checkDomainScope(c, domainId);
  const body = await c.req.json<any>();
  const local = normalizeAddr(String(body.local_part || ''));
  if (!LOCAL_PART_RE.test(local)) return c.json({ error: 'e_bad_local_part' }, 400);
  const exists = await c.env.DB.prepare('SELECT id FROM mailboxes WHERE domain_id=?1 AND local_part=?2')
    .bind(domainId, local).first<any>();
  if (exists) return c.json({ error: 'e_address_exists' }, 409);
  const aliasTaken = await c.env.DB.prepare('SELECT id FROM aliases WHERE domain_id=?1 AND local_part=?2')
    .bind(domainId, local).first<any>();
  if (aliasTaken) return c.json({ error: 'e_address_is_alias' }, 409);
  const id = uid();
  await c.env.DB.prepare(
    'INSERT INTO mailboxes (id, domain_id, local_part, display_name, created_at) VALUES (?1,?2,?3,?4,?5)'
  ).bind(id, domainId, local, String(body.display_name || '').slice(0, 80), now()).run();
  await createSystemFolders(c.env, id);
  await audit(c.env, c.get('user'), 'mailbox.create', await addrOf(c.env, { local_part: local, domain_id: domainId }), undefined, domainId);
  return c.json({ id });
});

// ---------- Branding (controlled by domain admins, applies to that domain's entry host) ----------
// ---------- 品牌(域管理员控制,作用于 intl-mail.<域名> 入口) ----------

adminApp.get('/domains/:id/brand', async (c) => {
  const domainId = c.req.param('id');
  await checkDomainScope(c, domainId);
  const d = await c.env.DB.prepare(
    'SELECT name, brand_name, brand_theme, brand_font, brand_logo_key, brand_logo_mode FROM domains WHERE id=?1'
  ).bind(domainId).first<any>();
  if (!d) throw new HttpError(404, 'e_domain_not_found');
  return c.json({
    domain: d.name, brand_name: d.brand_name || '', brand_theme: d.brand_theme || '',
    brand_font: d.brand_font || '', has_logo: !!d.brand_logo_key, logo_mode: d.brand_logo_mode || 'light',
  });
});

adminApp.post('/domains/:id/brand', async (c) => {
  const domainId = c.req.param('id');
  await checkDomainScope(c, domainId);
  const body = await c.req.json<any>();
  if (typeof body.name === 'string') {
    const name = body.name.trim().slice(0, 40);
    await c.env.DB.prepare('UPDATE domains SET brand_name=?1 WHERE id=?2').bind(name || null, domainId).run();
  }
  if (typeof body.theme === 'string') {
    const theme = body.theme.trim();
    if (theme && !THEME_NAMES.includes(theme)) return c.json({ error: 'e_unknown_theme' }, 400);
    await c.env.DB.prepare('UPDATE domains SET brand_theme=?1 WHERE id=?2').bind(theme || null, domainId).run();
  }
  if (typeof body.font === 'string') {
    const font = body.font.trim();
    if (font && !isKnownFont(font)) return c.json({ error: 'e_unknown_font' }, 400);
    await c.env.DB.prepare('UPDATE domains SET brand_font=?1 WHERE id=?2').bind(font || null, domainId).run();
  }
  return c.json({ ok: true });
});

adminApp.post('/domains/:id/brand/logo', async (c) => {
  const domainId = c.req.param('id');
  await checkDomainScope(c, domainId);
  const body = await c.req.parseBody();
  const f = body['file'];
  if (!(f instanceof File)) throw new HttpError(400, 'e_missing_file');
  if (f.size > 512 * 1024) throw new HttpError(400, 'e_logo_too_big');
  if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(f.type)) throw new HttpError(400, 'e_logo_type');
  // The mode the admin was in when uploading is the logo's native mode, and it is never inverted there
  // 上传时管理员所处的模式 = logo 的原生模式(该模式下不反色)
  const mode = String(body['mode'] || 'light') === 'dark' ? 'dark' : 'light';
  const key = `brand/${domainId}`;
  await c.env.RAW.put(key, await f.arrayBuffer());
  await c.env.DB.prepare('UPDATE domains SET brand_logo_key=?1, brand_logo_mime=?2, brand_logo_mode=?3 WHERE id=?4')
    .bind(key, f.type, mode, domainId).run();
  return c.json({ ok: true, logo_mode: mode });
});

adminApp.delete('/domains/:id/brand/logo', async (c) => {
  const domainId = c.req.param('id');
  await checkDomainScope(c, domainId);
  const d = await c.env.DB.prepare('SELECT brand_logo_key FROM domains WHERE id=?1').bind(domainId).first<any>();
  if (d?.brand_logo_key) await c.env.RAW.delete(d.brand_logo_key).catch(() => {});
  await c.env.DB.prepare('UPDATE domains SET brand_logo_key=NULL, brand_logo_mime=NULL, brand_logo_mode=NULL WHERE id=?1').bind(domainId).run();
  return c.json({ ok: true });
});

// ---------- Receiving aliases (controlled by domain admins) ----------
// ---------- 收信别名(域管理员控制) ----------

adminApp.get('/domains/:id/aliases', async (c) => {
  const domainId = c.req.param('id');
  await checkDomainScope(c, domainId);
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.local_part, a.mailbox_id, d.name AS domain_name,
       mb.local_part AS target_local, d2.name AS target_domain
     FROM aliases a
     JOIN domains d ON d.id=a.domain_id
     JOIN mailboxes mb ON mb.id=a.mailbox_id
     JOIN domains d2 ON d2.id=mb.domain_id
     WHERE a.domain_id=?1 ORDER BY a.local_part`
  ).bind(domainId).all<any>();
  return c.json({
    aliases: (rows.results || []).map((a: any) => ({
      id: a.id,
      address: `${a.local_part}@${a.domain_name}`,
      target: `${a.target_local}@${a.target_domain}`,
      mailbox_id: a.mailbox_id,
    })),
  });
});

adminApp.post('/domains/:id/aliases', async (c) => {
  const domainId = c.req.param('id');
  await checkDomainScope(c, domainId);
  const body = await c.req.json<any>();
  const local = normalizeAddr(String(body.local_part || ''));
  if (!LOCAL_PART_RE.test(local)) return c.json({ error: 'e_bad_local_part' }, 400);
  const target = await c.env.DB.prepare('SELECT id, domain_id, disabled FROM mailboxes WHERE id=?1')
    .bind(String(body.mailbox_id || '')).first<any>();
  if (!target || target.disabled) return c.json({ error: 'e_target_mailbox_bad' }, 400);
  const scope = await adminScope(c);
  if (scope && !scope.has(target.domain_id)) return c.json({ error: 'e_target_out_of_scope' }, 403);
  const mbTaken = await c.env.DB.prepare('SELECT id FROM mailboxes WHERE domain_id=?1 AND local_part=?2')
    .bind(domainId, local).first<any>();
  if (mbTaken) return c.json({ error: 'e_address_is_mailbox' }, 409);
  const exists = await c.env.DB.prepare('SELECT id FROM aliases WHERE domain_id=?1 AND local_part=?2')
    .bind(domainId, local).first<any>();
  if (exists) return c.json({ error: 'e_alias_exists' }, 409);
  const id = uid();
  await c.env.DB.prepare('INSERT INTO aliases (id, domain_id, local_part, mailbox_id, created_at) VALUES (?1,?2,?3,?4,?5)')
    .bind(id, domainId, local, target.id, now()).run();
  return c.json({ id });
});

adminApp.delete('/aliases/:id', async (c) => {
  const alias = await c.env.DB.prepare('SELECT domain_id FROM aliases WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!alias) throw new HttpError(404, 'e_alias_not_found');
  await checkDomainScope(c, alias.domain_id);
  await c.env.DB.prepare('DELETE FROM aliases WHERE id=?1').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

/** For the alias target dropdown: every mailbox inside the admin's scope
 *  别名目标下拉用:管理范围内所有可用邮箱 */
adminApp.get('/mailbox-options', async (c) => {
  const scope = await adminScope(c);
  const rows = await c.env.DB.prepare(
    `SELECT mb.id, mb.local_part, mb.domain_id, d.name AS domain_name
     FROM mailboxes mb JOIN domains d ON d.id=mb.domain_id
     WHERE mb.disabled=0 ORDER BY d.name, mb.local_part`
  ).all<any>();
  let list = rows.results || [];
  if (scope) list = list.filter((m: any) => scope.has(m.domain_id));
  return c.json({ mailboxes: list.map((m: any) => ({ id: m.id, address: `${m.local_part}@${m.domain_name}` })) });
});

adminApp.post('/mailboxes/:id', async (c) => {
  const mb = await c.env.DB.prepare('SELECT * FROM mailboxes WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);
  const body = await c.req.json<any>();
  if (typeof body.display_name === 'string') {
    await c.env.DB.prepare('UPDATE mailboxes SET display_name=?1 WHERE id=?2')
      .bind(body.display_name.slice(0, 80), mb.id).run();
  }
  if (typeof body.disabled === 'boolean') {
    await c.env.DB.prepare('UPDATE mailboxes SET disabled=?1 WHERE id=?2').bind(body.disabled ? 1 : 0, mb.id).run();
  }
  return c.json({ ok: true });
});

/**
 * Erase a mailbox's contents. One batch per call -- deleting tens of thousands of messages in one
 * request would blow through the Worker's CPU and subrequest limits.
 * So it is resumable: every call returns remaining, and the frontend loops until it hits zero,
 * which also gives it something to show progress with.
 * 清空邮箱内容。一次只处理一批 —— 几万封的邮箱一口气删会撞 Worker 的 CPU 和子请求上限,
 * 所以做成可续跑的:每次返回 remaining,前端循环调用直到归零,顺带能显示进度。
 */
const PURGE_BATCH = 300;

adminApp.post('/mailboxes/:id/purge', async (c) => {
  const mb = await c.env.DB.prepare('SELECT * FROM mailboxes WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);

  const rows = await c.env.DB.prepare('SELECT id, r2_key FROM messages WHERE mailbox_id=?1 LIMIT ?2')
    .bind(mb.id, PURGE_BATCH).all<any>();
  const list = rows.results || [];

  if (list.length) {
    const ids = list.map((r: any) => r.id);
    const keys = list.map((r: any) => r.r2_key).filter(Boolean);
    // R2 accepts a batch delete; a failure here does not block, since once the D1 rows are gone nothing references those objects
    // R2 支持一次删一批;失败不阻断,D1 记录清掉后这些对象也没人引用了
    if (keys.length) await c.env.RAW.delete(keys).catch(() => {});

    const qs = ids.map((_: any, i: number) => `?${i + 1}`).join(',');
    // FTS is an external-content table, so a delete must carry the original text and can only go row by row; batch packs them into a single round trip
    // FTS 是外部内容表,删除必须带上原文,只能逐行来;用 batch 打包成一个往返
    const texts = await c.env.DB.prepare(
      `SELECT mrow, subject, body, addrs FROM message_texts WHERE message_id IN (${qs})`
    ).bind(...ids).all<any>();
    const stmts: any[] = [];
    for (const t of texts.results || []) {
      stmts.push(
        c.env.DB.prepare("INSERT INTO messages_fts (messages_fts, rowid, subject, body, addrs) VALUES ('delete',?1,?2,?3,?4)")
          .bind(t.mrow, t.subject, t.body, t.addrs)
      );
    }
    stmts.push(c.env.DB.prepare(`DELETE FROM message_texts WHERE message_id IN (${qs})`).bind(...ids));
    stmts.push(c.env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${qs})`).bind(...ids));
    stmts.push(c.env.DB.prepare(`DELETE FROM message_labels WHERE message_id IN (${qs})`).bind(...ids));
    stmts.push(c.env.DB.prepare(`DELETE FROM messages WHERE id IN (${qs})`).bind(...ids));
    await c.env.DB.batch(stmts);
  }

  const left = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id=?1').bind(mb.id).first<any>();
  const remaining = Number(left?.n || 0);

  if (!remaining) {
    // The final batch: clear the mailbox-level extras too (uploads referenced by drafts are cleaned per user elsewhere)
    // 最后一批:把邮箱级的附属数据一并清掉(草稿里引用的上传件按 user 维度另行清理)
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM contacts WHERE mailbox_id=?1').bind(mb.id),
      c.env.DB.prepare('DELETE FROM drafts WHERE mailbox_id=?1').bind(mb.id),
      c.env.DB.prepare('DELETE FROM outbox WHERE mailbox_id=?1').bind(mb.id),
    ]);
    await audit(c.env, c.get('user'), 'mailbox.purge', await addrOf(c.env, mb), undefined, mb.domain_id);
  }
  return c.json({ deleted: list.length, remaining });
});

/**
 * Delete a mailbox. The contents must already be erased (the frontend loops purge first); this only
 * takes the structure apart.
 * With with_user=1, and only when that user holds no grant anywhere else, the account goes too.
 * 注销邮箱。要求内容已清空(前端先循环调 purge),这里只拆结构。
 * with_user=1 且该用户在别处已无任何授权时,连同用户账号一起注销。
 */
adminApp.delete('/mailboxes/:id', async (c) => {
  const mb = await c.env.DB.prepare('SELECT * FROM mailboxes WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);

  const left = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id=?1').bind(mb.id).first<any>();
  if (Number(left?.n || 0) > 0) throw new HttpError(409, 'e_empty_mailbox_first');

  const addr = await addrOf(c.env, mb);
  const withUser = c.req.query('with_user') === '1';
  // Who owns this mailbox -- deleting a user only considers owners, leaving member and readonly alone
  // 谁是这个邮箱的所有者 —— 注销用户时只认 owner,member/readonly 不动
  const owners = await c.env.DB.prepare("SELECT user_id FROM grants WHERE mailbox_id=?1 AND role='owner'")
    .bind(mb.id).all<any>();

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM aliases WHERE mailbox_id=?1').bind(mb.id),
    c.env.DB.prepare('DELETE FROM grants WHERE mailbox_id=?1').bind(mb.id),
    c.env.DB.prepare('DELETE FROM folders WHERE mailbox_id=?1').bind(mb.id),
    // Labels belong to the mailbox, so they go with it. Erasing a mailbox's contents does not
    // touch them -- that leaves the mailbox standing, and its taxonomy is configuration rather
    // than mail.
    // 标签属于邮箱,邮箱没了它们也没了。但"清空内容"不动它们 ——
    // 那时邮箱还在,而它的分类体系是配置,不是邮件。
    c.env.DB.prepare('DELETE FROM labels WHERE mailbox_id=?1').bind(mb.id),
    c.env.DB.prepare('DELETE FROM mailboxes WHERE id=?1').bind(mb.id),
  ]);

  const removedUsers: string[] = [];
  if (withUser) {
    const me: User = c.get('user');
    for (const o of owners.results || []) {
      const uidv = String(o.user_id);
      if (uidv === me.id) continue; // 不注销自己
      // Still granted on another mailbox: keep the account, they simply no longer own this one
      // 还在别的邮箱上有授权就留着,只是不再拥有这个邮箱
      const other = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM grants WHERE user_id=?1').bind(uidv).first<any>();
      if (Number(other?.n || 0) > 0) continue;
      const u = await c.env.DB.prepare('SELECT email FROM users WHERE id=?1').bind(uidv).first<any>();
      const ups = await c.env.DB.prepare('SELECT r2_key FROM uploads WHERE user_id=?1').bind(uidv).all<any>();
      const keys = (ups.results || []).map((x: any) => x.r2_key).filter(Boolean);
      if (keys.length) await c.env.RAW.delete(keys).catch(() => {});
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?1').bind(uidv),
        c.env.DB.prepare('DELETE FROM domain_admins WHERE user_id=?1').bind(uidv),
        c.env.DB.prepare('DELETE FROM drafts WHERE user_id=?1').bind(uidv),
        c.env.DB.prepare('DELETE FROM uploads WHERE user_id=?1').bind(uidv),
        c.env.DB.prepare('DELETE FROM users WHERE id=?1').bind(uidv),
      ]);
      if (u?.email) removedUsers.push(u.email);
    }
  }

  await audit(c.env, c.get('user'), 'mailbox.delete', addr, { removed_users: removedUsers }, mb.domain_id);
  return c.json({ ok: true, removed_users: removedUsers });
});

adminApp.post('/mailboxes/:id/grants', async (c) => {
  const mb = await c.env.DB.prepare('SELECT * FROM mailboxes WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);
  const body = await c.req.json<any>();
  const email = normalizeAddr(String(body.email || ''));
  const role = ['owner', 'member', 'readonly'].includes(body.role) ? body.role : 'member';
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE email=?1').bind(email).first<any>();
  if (!u) return c.json({ error: 'e_user_not_found_invite' }, 404);
  await c.env.DB.prepare(
    'INSERT INTO grants (user_id, mailbox_id, role, created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(user_id, mailbox_id) DO UPDATE SET role=?3'
  ).bind(u.id, mb.id, role, now()).run();
  await audit(c.env, c.get('user'), 'grant.add', await addrOf(c.env, mb), { user: email, role }, mb.domain_id);
  return c.json({ ok: true });
});

adminApp.delete('/mailboxes/:id/grants/:userId', async (c) => {
  const mb = await c.env.DB.prepare('SELECT * FROM mailboxes WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);
  const gone = await c.env.DB.prepare('SELECT email FROM users WHERE id=?1')
    .bind(c.req.param('userId')).first<any>();
  await c.env.DB.prepare('DELETE FROM grants WHERE mailbox_id=?1 AND user_id=?2')
    .bind(mb.id, c.req.param('userId')).run();
  await audit(c.env, c.get('user'), 'grant.remove', await addrOf(c.env, mb),
    { user: gone?.email || c.req.param('userId') }, mb.domain_id);
  return c.json({ ok: true });
});

// ---------- Members: per-user statistics, disable, delete ----------
// ---------- 成员:按用户统计 / 停用 / 删除 ----------

adminApp.get('/users', async (c) => {
  const scope = await adminScope(c);
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, u.disabled, u.created_at, u.last_login,
       COALESCE(s.mb_count,0) AS mb_count, COALESCE(s.msg_count,0) AS msg_count, COALESCE(s.bytes,0) AS bytes
     FROM users u LEFT JOIN (
       SELECT g.user_id AS gu, COUNT(DISTINCT g.mailbox_id) AS mb_count, COUNT(m.id) AS msg_count, SUM(m.size) AS bytes
       FROM grants g LEFT JOIN messages m ON m.mailbox_id=g.mailbox_id GROUP BY g.user_id
     ) s ON s.gu=u.id ORDER BY u.created_at`
  ).all<any>();
  const grants = await c.env.DB.prepare(
    `SELECT g.user_id, g.role, mb.id AS mailbox_id, mb.local_part, mb.domain_id, d.name AS domain_name
     FROM grants g JOIN mailboxes mb ON mb.id=g.mailbox_id JOIN domains d ON d.id=mb.domain_id`
  ).all<any>();
  const byUser: Record<string, any[]> = {};
  for (const g of grants.results || []) (byUser[g.user_id] ||= []).push(g);
  // Who administers which domain, so the list can say so next to the person rather than only
  // on the domain's own page
  // 谁管着哪个域,好让名单在人旁边就说清楚,而不是只能到那个域的页面上去看
  const das = await c.env.DB.prepare(
    `SELECT da.user_id, da.domain_id, d.name AS domain_name
     FROM domain_admins da JOIN domains d ON d.id=da.domain_id`
  ).all<any>();
  const adminBy: Record<string, any[]> = {};
  for (const r of das.results || []) (adminBy[r.user_id] ||= []).push(r);
  let users = (rows.results || []).map((u: any) => ({
    ...u,
    // Filtered the same way as the grants below: a domain admin learns nothing here about the
    // domains outside their own
    // 与下面的授权同样过滤:域管理员在这里也不会知道自己范围之外的域
    admin_of: (adminBy[u.id] || [])
      .filter((r: any) => !scope || scope.has(r.domain_id))
      .map((r: any) => ({ domain_id: r.domain_id, domain_name: r.domain_name })),
    grants: (byUser[u.id] || [])
      // A domain admin sees only the grants inside their own domains, never this user's addresses and roles elsewhere
      // 域管理员只能看到本域内的授权,不泄露该用户在其它域的邮箱地址与角色
      .filter((g: any) => !scope || scope.has(g.domain_id))
      .map((g: any) => ({
        mailbox_id: g.mailbox_id,
        address: `${g.local_part}@${g.domain_name}`,
        role: g.role,
        domain_id: g.domain_id,
      })),
  }));
  // Nothing in common with this admin's domains -- neither a mailbox nor an administrator seat
  // -- means the whole row is withheld. Someone who administers your domain without holding a
  // mailbox in it still belongs in your list; they are exactly the person you would want to see.
  // 与本管理员的域毫无交集(既没有邮箱,也不是管理员)= 整行不返回。
  // 有人管着你的域却没在里面开邮箱,他仍然该出现在你的名单里 —— 那正是你最该看见的人。
  if (scope) users = users.filter((u: any) => u.grants.length > 0 || u.admin_of.length > 0);
  return c.json({ users });
});

adminApp.post('/users/:id/status', async (c) => {
  requireGlobalAdmin(c);
  const targetId = c.req.param('id');
  if (targetId === c.get('user').id) throw new HttpError(400, 'e_cannot_disable_self');
  const body = await c.req.json<any>();
  const disabled = body.disabled ? 1 : 0;
  await c.env.DB.prepare('UPDATE users SET disabled=?1 WHERE id=?2').bind(disabled, targetId).run();
  if (disabled) await c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?1').bind(targetId).run();
  return c.json({ ok: true });
});

// ---------- Historical mail import (migrating from Zoho and friends) ----------
// ---------- 历史邮件导入(从 Zoho 等旧系统迁移) ----------

const IMPORT_FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'] as const;

/**
 * Import one historical message. The request body is the raw .eml; parameters ride on the query string:
 *   mailbox     target company address (must already exist)
 *   folder      inbox|sent|drafts|archive|spam|trash, default inbox
 *   flagged     1/0
 *   message_id  optional, used for deduplication. The script reads it out of the .eml headers, so a re-run never produces duplicates.
 * How this differs from normal receiving: no recipient matching, no spam classification, the timestamp
 * always comes from the Date header -- and everything arrives read.
 *
 * Read, because history is not news. A migration that preserves the old system's unread flags hands
 * somebody an inbox with five thousand bold lines in it, and no way to tell which of them ever
 * mattered; the first thing anyone does is select all and mark read. Starred still comes across --
 * that one was a decision somebody made on purpose.
 * 导入一封历史邮件。请求体就是原始 .eml,参数走 query:
 *   mailbox   目标企业邮箱地址(必须已存在)
 *   folder    inbox|sent|drafts|archive|spam|trash,默认 inbox
 *   message_id  可选,用于去重;由脚本从 .eml 头里读出来,重跑不会产生副本
 * 与正常收信的区别:不做收件人匹配、不做垃圾判定、时间一律取 Date 头 —— 而且一律按已读入库。
 *
 * 按已读,是因为历史不是新消息。忠实保留旧系统未读标记的迁移,交付的是一个五千行加粗的收件箱,
 * 而且没人分得清哪几行真的要紧;所有人的第一个动作都是全选、标为已读。星标照旧带过来 ——
 * 那个是有人当初特意做的决定。
 */
adminApp.post('/import', async (c) => {
  const addr = normalizeAddr(String(c.req.query('mailbox') || ''));
  const at = addr.lastIndexOf('@');
  if (at < 1) throw new HttpError(400, 'e_bad_mailbox_param');
  const mb = await c.env.DB.prepare(
    `SELECT mb.id, mb.domain_id FROM mailboxes mb JOIN domains d ON d.id=mb.domain_id
     WHERE mb.local_part=?1 AND d.name=?2`
  ).bind(addr.slice(0, at), addr.slice(at + 1)).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_missing_create', addr);
  // Scoped like everything else that writes into a mailbox: the target's domain has to be one
  // this administrator manages. The check comes after the lookup because the domain is a
  // property of the mailbox, not of the address the caller typed.
  // 与其它一切写入邮箱的操作同规:目标邮箱所在的域必须归本管理员管。
  // 检查放在查库之后,因为"哪个域"是邮箱的属性,不是调用方输入的地址说了算。
  await checkDomainScope(c, mb.domain_id);

  const folder = String(c.req.query('folder') || 'inbox');
  if (!IMPORT_FOLDERS.includes(folder as any)) throw new HttpError(400, 'e_unknown_folder');

  // Deduplication: skip when this Message-ID already exists in the mailbox, without writing to R2 again
  // 去重:同一邮箱里 Message-ID 已存在就跳过,不再写 R2
  const msgId = String(c.req.query('message_id') || '').slice(0, 300);
  if (msgId) {
    const dup = await c.env.DB.prepare('SELECT id FROM messages WHERE mailbox_id=?1 AND message_id=?2')
      .bind(mb.id, msgId).first<any>();
    if (dup) return c.json({ ok: true, skipped: 'duplicate', id: dup.id });
  }

  // Two shapes of request body:
  //   multipart -- the browser already parsed it with the same postal-mime build; meta is that result and the Worker does not parse again
  //   raw       -- the command-line script posts the original, and the Worker parses it
  // 两种请求体:
  //   multipart —— 浏览器已用同一个 postal-mime 解析过,meta 是解析结果,Worker 不再解析
  //   raw       —— 命令行脚本直传原文,由 Worker 解析
  let buf: ArrayBuffer;
  let pre: PreParsed | undefined;
  if ((c.req.header('Content-Type') || '').startsWith('multipart/form-data')) {
    const form = await c.req.parseBody();
    const f = form['eml'];
    if (!(f instanceof File)) throw new HttpError(400, 'e_missing_eml');
    buf = await f.arrayBuffer();
    if (form['meta']) {
      try {
        pre = JSON.parse(String(form['meta']));
      } catch {
        throw new HttpError(400, 'e_meta_bad_json');
      }
    }
  } else {
    buf = await c.req.arrayBuffer();
  }
  if (!buf.byteLength) throw new HttpError(400, 'e_empty_body');
  const key = `import/${uid()}.eml`;
  await c.env.RAW.put(key, buf);
  try {
    const id = await ingestEml(c.env, {
      mailboxId: mb.id,
      buf,
      pre,
      r2Key: key,
      size: buf.byteLength,
      folderRole: folder as any,
      direction: folder === 'sent' ? 'out' : 'in',
      seen: true,
      flagged: c.req.query('flagged') === '1',
      keepDate: true,
    });
    // Labels ride along on the same request. A Gmail export carries them per message, and asking
    // the browser to come back once per message to attach them would double the number of round
    // trips for eight thousand messages while the rows are two columns wide.
    // 标签搭同一趟车。Gmail 导出里标签本来就是逐封带的,让浏览器为此每封再回来一次,
    // 八千封就是把往返次数翻倍 —— 而要写的不过是两列宽的几行。
    const labelIds = String(c.req.query('labels') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
    if (labelIds.length) {
      const qs = labelIds.map((_, i) => `?${i + 2}`).join(',');
      const own = await c.env.DB.prepare(
        `SELECT id FROM labels WHERE mailbox_id=?1 AND id IN (${qs})`
      ).bind(mb.id, ...labelIds).all<any>();
      const stmts = (own.results || []).map((r: any) =>
        c.env.DB.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?1,?2)').bind(id, r.id));
      if (stmts.length) await c.env.DB.batch(stmts);
    }
    return c.json({ ok: true, id });
  } catch (e: any) {
    await c.env.RAW.delete(key).catch(() => {});
    throw new HttpError(400, 'e_parse_failed', e?.message || 'unknown');
  }
});

/**
 * Look at the system as one of its users -- their mail, their Drive, their permissions exactly.
 * "It works for me" is the hardest support answer to argue with; this is how you go and see.
 *
 * Kept to the global administrator, and only towards someone who is not themselves one: an
 * administrator borrowing another administrator's session could act in the console under that
 * name, and no audit trail survives that. Both ends of the visit are recorded.
 *
 * 以某个用户的身份看这套系统 —— 他的邮件、他的网盘、和他一模一样的权限。
 * "我这儿是好的"是最难反驳的一句支持答复;这就是过去亲眼看看的办法。
 *
 * 只给全局管理员,且对象不能也是全局管理员:借用另一位管理员的会话就能以他的名义在后台动手,
 * 那样的审计记录等于没有。进出两端都留痕。
 */
adminApp.post('/users/:id/impersonate', async (c) => {
  const me = requireGlobalAdmin(c);
  const targetId = c.req.param('id');
  if (targetId === me.id) throw new HttpError(400, 'e_impersonate_self');
  const tu = await c.env.DB.prepare('SELECT id, email, name, is_admin, disabled FROM users WHERE id=?1')
    .bind(targetId).first<any>();
  if (!tu) throw new HttpError(404, 'e_user_not_found');
  if (tu.disabled) throw new HttpError(400, 'e_impersonate_disabled');
  if (tu.is_admin) throw new HttpError(400, 'e_impersonate_admin');
  await beginImpersonation(c, tu.id, me.id);
  await audit(c.env, me, 'user.impersonate', tu.email, { user_id: tu.id });
  return c.json({ ok: true, email: tu.email, name: tu.name });
});

/** Force a user to sign in again on every device (sessions persist for a month locally, so this is how you stop the bleeding after a leak)
 *  强制某用户在所有设备上重新登录(会话本地留存一个月,泄露时靠这个止血) */
adminApp.post('/users/:id/logout-all', async (c) => {
  requireGlobalAdmin(c);
  const n = await revokeAllSessions(c.env, c.req.param('id'));
  const tu = await c.env.DB.prepare('SELECT email FROM users WHERE id=?1').bind(c.req.param('id')).first<any>();
  await audit(c.env, c.get('user'), 'user.logout_all', tu?.email || c.req.param('id'), { revoked: n });
  return c.json({ ok: true, revoked: n });
});

adminApp.delete('/users/:id', async (c) => {
  requireGlobalAdmin(c);
  const targetId = c.req.param('id');
  if (targetId === c.get('user').id) throw new HttpError(400, 'e_cannot_delete_self');
  const tu = await c.env.DB.prepare('SELECT email FROM users WHERE id=?1').bind(targetId).first<any>();
  const uploads = await c.env.DB.prepare('SELECT r2_key FROM uploads WHERE user_id=?1').bind(targetId).all<any>();
  for (const u of uploads.results || []) await c.env.RAW.delete(u.r2_key).catch(() => {});
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?1').bind(targetId),
    c.env.DB.prepare('DELETE FROM grants WHERE user_id=?1').bind(targetId),
    c.env.DB.prepare('DELETE FROM domain_admins WHERE user_id=?1').bind(targetId),
    c.env.DB.prepare('DELETE FROM drafts WHERE user_id=?1').bind(targetId),
    c.env.DB.prepare('DELETE FROM uploads WHERE user_id=?1').bind(targetId),
    c.env.DB.prepare('DELETE FROM users WHERE id=?1').bind(targetId),
  ]);
  await audit(c.env, c.get('user'), 'user.delete', tu?.email || targetId);
  return c.json({ ok: true });
});

// ---------- Mail for unmatched recipients ----------
// ---------- 未匹配收件人的来信 ----------

adminApp.get('/unrouted', async (c) => {
  const scope = await adminScope(c);
  const page = Math.max(0, parseInt(c.req.query('page') || '0', 10) || 0);
  const PAGE = 50;
  // Push the domain scope down into SQL: filtering afterwards lets cross-domain rows consume LIMIT/OFFSET slots, which under-fills the page and makes has_more wrong
  // 域范围下推进 SQL,否则跨域行会占掉 LIMIT/OFFSET 的名额,导致本域行分页不全、has_more 失真
  const ids = scope ? [...scope] : [];
  const where = scope ? `WHERE u.domain_id IN (${ids.map((_, i) => `?${i + 1}`).join(',')})` : '';
  const n = ids.length;
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.domain_id, u.to_addr, u.from_addr, u.subject, u.snippet, u.size, u.created_at, d.name AS domain_name
     FROM unrouted u LEFT JOIN domains d ON d.id=u.domain_id
     ${where}
     ORDER BY u.created_at DESC LIMIT ?${n + 1} OFFSET ?${n + 2}`
  ).bind(...ids, PAGE + 1, page * PAGE).all<any>();
  const list = rows.results || [];
  const hasMore = list.length > PAGE;
  return c.json({ items: list.slice(0, PAGE), page, has_more: hasMore });
});

/** Fetch the body, parsing the original out of R2 on demand
 *  取正文(按需解析 R2 里的原件) */
adminApp.get('/unrouted/:id/body', async (c) => {
  const scope = await adminScope(c);
  const row = await c.env.DB.prepare('SELECT * FROM unrouted WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!row) throw new HttpError(404, 'e_record_not_found');
  if (scope && !(row.domain_id && scope.has(row.domain_id))) throw new HttpError(403, 'e_no_view_perm');
  const obj = await c.env.RAW.get(row.r2_key);
  if (!obj) throw new HttpError(404, 'e_raw_gone');
  const parsed: any = await new PostalMime().parse(await obj.arrayBuffer());
  let html: string | null = parsed.html || null;
  if (html) {
    // Unrouted mail is mostly spam and phishing: strip remote images so no read receipt goes back
    // 未匹配来信多为垃圾/钓鱼:去掉远程图片,避免回传阅读回执
    html = html.replace(/<img\b[^>]*>/gi, '');
  }
  await audit(c.env, c.get('user'), 'unrouted.view', row.to_addr, { from: row.from_addr, subject: row.subject }, row.domain_id);
  return c.json({
    html,
    text: parsed.text || null,
    to: row.to_addr, from: row.from_addr, subject: row.subject, created_at: row.created_at,
  });
});

adminApp.delete('/unrouted/:id', async (c) => {
  const scope = await adminScope(c);
  const row = await c.env.DB.prepare('SELECT * FROM unrouted WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!row) throw new HttpError(404, 'e_record_not_found');
  if (scope && !(row.domain_id && scope.has(row.domain_id))) throw new HttpError(403, 'e_no_perm_action');
  await c.env.RAW.delete(row.r2_key).catch(() => {});
  await c.env.DB.prepare('DELETE FROM unrouted WHERE id=?1').bind(row.id).run();
  await audit(c.env, c.get('user'), 'unrouted.delete', row.to_addr, undefined, row.domain_id);
  return c.json({ ok: true });
});

// ---------- Export ----------
// ---------- 导出 ----------

/**
 * List every message to export from a mailbox (the manifest only, no bodies). The browser takes the
 * manifest, fetches each message and writes it to a local folder.
 * The server never builds an archive -- zipping a multi-gigabyte mailbox inside a Worker would blow
 * both the memory and the CPU limits.
 * 列出某邮箱要导出的全部邮件(只给清单,不给正文)。浏览器拿到清单后逐封取原文写本地目录,
 * 服务端不打包 —— 几 GB 的邮箱在 Worker 里打 zip 既超内存也超 CPU。
 */
/**
 * Labels, for an administrator acting on a mailbox rather than a member reading one.
 *
 * The user-facing label API asks whether you hold a grant on the mailbox, which is the right
 * question there and the wrong one here: an administrator importing somebody's Gmail archive into
 * a new mailbox has authority over that mailbox and no grant on it, and would be told they have
 * no access to a mailbox they just created. So these two answer the administrator's question --
 * is this mailbox in a domain you manage -- and do only what an import needs: read the list, and
 * add one.
 *
 * 标签接口的管理员版:面对的是"管理员在处理某个邮箱",而不是"成员在读自己的邮箱"。
 *
 * 面向用户的那套问的是"你在这个邮箱上有没有授权",在那边问得对,在这边问错了:
 * 管理员把别人的 Gmail 存档导进一个新建的邮箱时,他对这个邮箱有管辖权、却没有授权,
 * 结果会被告知"无权访问"一个他刚刚亲手建出来的邮箱。所以这两个接口问管理员该被问的问题 ——
 * 这个邮箱在不在你管的域里 —— 并且只做导入需要的两件事:读列表、加一个。
 */
adminApp.get('/mailboxes/:id/labels', async (c) => {
  const mb = await c.env.DB.prepare('SELECT id, domain_id FROM mailboxes WHERE id=?1')
    .bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);
  const rows = await c.env.DB.prepare(
    'SELECT id, name, icon, color, sort FROM labels WHERE mailbox_id=?1 ORDER BY sort, name'
  ).bind(mb.id).all<any>();
  return c.json({ labels: rows.results || [] });
});

adminApp.post('/mailboxes/:id/labels', async (c) => {
  const mb = await c.env.DB.prepare('SELECT id, domain_id FROM mailboxes WHERE id=?1')
    .bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);
  const b = await c.req.json<any>();
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return c.json({ error: 'e_label_name_required' }, 400);
  // An import runs twice more often than anyone admits, so a name that is already there is not an
  // error: hand back the label that exists and let the messages attach to it.
  // 导入被跑第二遍的次数比谁都愿意承认的要多,所以名字已存在不是错误:
  // 把已有的那个还回去,让邮件挂上去就是了。
  const dup = await c.env.DB.prepare('SELECT id, name, icon, color FROM labels WHERE mailbox_id=?1 AND name=?2')
    .bind(mb.id, name).first<any>();
  if (dup) return c.json(dup);
  const id = uid();
  const next = await c.env.DB.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM labels WHERE mailbox_id=?1')
    .bind(mb.id).first<any>();
  const icon = pickIcon(b.icon);
  const color = pickColor(b.color);
  await c.env.DB.prepare(
    'INSERT INTO labels (id, mailbox_id, name, icon, color, sort, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)'
  ).bind(id, mb.id, name, icon, color, next?.s || 1, now()).run();
  return c.json({ id, name, icon, color });
});

/**
 * Which of these messages are already here.
 *
 * An import of eight thousand messages gets interrupted -- the tab is closed, the laptop sleeps,
 * somebody wants the faster settings. Without this the second run re-uploads every message in
 * full and the server throws each one away on the Message-ID it already has: correct, and a
 * gigabyte of upload to reach the point where the first run stopped. Asking first turns resuming
 * into one indexed lookup per five hundred messages.
 *
 * 这些邮件里哪些已经在了。
 *
 * 八千封的导入总会被打断 —— 关了标签页、笔记本睡了、或者想换更快的设置。没有这个接口,
 * 第二遍会把每一封完整重传一次,服务端再按已有的 Message-ID 一封封丢掉:结果是对的,
 * 但为了走回上一遍停下的地方,要先传一 GB 上去。先问一句,续传就变成每五百封一次带索引的查询。
 */
adminApp.post('/mailboxes/:id/have', async (c) => {
  const mb = await c.env.DB.prepare('SELECT id, domain_id FROM mailboxes WHERE id=?1')
    .bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);
  const body = await c.req.json<any>().catch(() => ({}));
  const ids = (Array.isArray(body.message_ids) ? body.message_ids : [])
    .map((x: any) => String(x || '').slice(0, 300)).filter(Boolean).slice(0, 500);
  if (!ids.length) return c.json({ have: [] });
  // D1 refuses a statement with more than a hundred bound values, so the list is asked in
  // chunks -- sent as one batch, so a caller's five hundred ids still cost a single round trip.
  // D1 不接受绑定值超过一百个的语句,所以分块问 —— 但作为一个 batch 发出去,
  // 调用方的五百个 id 仍然只是一次往返。
  const CHUNK = 90;
  const stmts = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const qs = part.map((_: string, k: number) => `?${k + 2}`).join(',');
    stmts.push(c.env.DB.prepare(
      `SELECT message_id FROM messages WHERE mailbox_id=?1 AND message_id IN (${qs})`
    ).bind(mb.id, ...part));
  }
  const res = await c.env.DB.batch<any>(stmts);
  const have: string[] = [];
  for (const r of res) for (const row of r.results || []) have.push(row.message_id);
  return c.json({ have });
});

// ---------- Automatic backup (global administrator only) ----------
// ---------- 自动备份(仅全局管理员) ----------

adminApp.get('/backup', async (c) => {
  requireGlobalAdmin(c);
  return c.json(await backupStatus(c.env));
});

adminApp.post('/backup', async (c) => {
  const me = requireGlobalAdmin(c);
  const body = await c.req.json<any>().catch(() => ({}));
  const on = !!body.enabled;
  await setBackupEnabled(c.env, on);
  await audit(c.env, me, 'backup.settings', on ? 'on' : 'off');
  return c.json({ ok: true, enabled: on });
});

adminApp.post('/backup/run', async (c) => {
  const me = requireGlobalAdmin(c);
  if (!c.env.BACKUP) throw new HttpError(400, 'e_backup_no_bucket');
  const r = await startBackupNow(c.env);
  if (!r.started) throw new HttpError(409, r.reason || 'e_backup_running');
  await audit(c.env, me, 'backup.run');
  return c.json({ ok: true });
});

adminApp.get('/mailboxes/:id/export-list', async (c) => {
  const mb = await c.env.DB.prepare('SELECT * FROM mailboxes WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);
  const page = Math.max(0, parseInt(c.req.query('page') || '0', 10) || 0);
  const PAGE = 2000;
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.subject, m.date, m.size, f.role AS folder
     FROM messages m LEFT JOIN folders f ON f.id = m.folder_id
     WHERE m.mailbox_id=?1 ORDER BY m.date LIMIT ?2 OFFSET ?3`
  ).bind(mb.id, PAGE + 1, page * PAGE).all<any>();
  const list = rows.results || [];
  return c.json({
    address: await addrOf(c.env, mb),
    items: list.slice(0, PAGE),
    page,
    has_more: list.length > PAGE,
  });
});

/** Reported once by the frontend when an import run finishes. Import is per-message, so
 *  auditing inside it would write a row per email; the run is the unit worth recording.
 *  导入结束后由前端回报一次。导入是一封一请求,在里面写审计等于一封一行;
 *  值得记录的单位是"这一次导入",不是每封信。 */
adminApp.post('/mailboxes/:id/import-done', async (c) => {
  const mb = await c.env.DB.prepare('SELECT * FROM mailboxes WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);
  const body = await c.req.json<any>().catch(() => ({}));
  await audit(c.env, c.get('user'), 'mail.import', await addrOf(c.env, mb), {
    ok: Number(body.ok) || 0,
    duplicate: Number(body.duplicate) || 0,
    failed: Number(body.failed) || 0,
    cancelled: !!body.cancelled,
  }, mb.domain_id);
  return c.json({ ok: true });
});

/** Fetch one raw MIME message, written straight to a local .eml
 *  取单封原始 MIME,直接落成本地的 .eml */
adminApp.get('/messages/:id/raw', async (c) => {
  const msg = await c.env.DB.prepare(
    'SELECT m.id, m.r2_key, mb.domain_id FROM messages m JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE m.id=?1'
  ).bind(c.req.param('id')).first<any>();
  if (!msg) throw new HttpError(404, 'e_message_not_found');
  await checkDomainScope(c, msg.domain_id);
  const obj = await c.env.RAW.get(msg.r2_key);
  if (!obj) throw new HttpError(404, 'e_raw_gone');
  c.header('Content-Type', 'message/rfc822');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(obj.body as any);
});

/** Reported once by the frontend when an export finishes, so the export leaves a trace (exporting means carrying every message out of the system)
 *  导出结束后由前端回报一次,把这次导出留痕(导出等于把全部通信内容带离系统) */
adminApp.post('/mailboxes/:id/export-done', async (c) => {
  const mb = await c.env.DB.prepare('SELECT * FROM mailboxes WHERE id=?1').bind(c.req.param('id')).first<any>();
  if (!mb) throw new HttpError(404, 'e_mailbox_not_found');
  await checkDomainScope(c, mb.domain_id);
  const body = await c.req.json<any>().catch(() => ({}));
  await audit(c.env, c.get('user'), 'mail.export', await addrOf(c.env, mb), {
    ok: Number(body.ok) || 0,
    failed: Number(body.failed) || 0,
    cancelled: !!body.cancelled,
  }, mb.domain_id);
  return c.json({ ok: true });
});

// ---------- Audit log ----------
// ---------- 审计日志 ----------

/** A domain admin sees only their own domains' records; global actions with no domain attached are visible to global admins only
 *  域管理员只看得到自己域的记录;没有域归属的全局操作只有全局管理员能看到 */
function auditScopeSql(scope: Set<string> | null, from: number): { where: string; binds: any[] } {
  if (!scope) return { where: 'at >= ?1', binds: [from] };
  const ids = [...scope];
  const qs = ids.map((_, i) => `?${i + 2}`).join(',');
  return { where: `at >= ?1 AND domain_id IN (${qs})`, binds: [from, ...ids] };
}

/** Defaults to the last 90 days; days=0 means no limit
 *  默认回看 90 天;days=0 表示不限 */
function auditFrom(c: any): number {
  const days = parseInt(c.req.query('days') || '90', 10);
  return days > 0 ? now() - days * 86400 * 1000 : 0;
}

adminApp.get('/audit', async (c) => {
  const scope = await adminScope(c);
  const page = Math.max(0, parseInt(c.req.query('page') || '0', 10) || 0);
  const PAGE = 100;
  const { where, binds } = auditScopeSql(scope, auditFrom(c));
  const rows = await c.env.DB.prepare(
    `SELECT a.*, d.name AS domain_name FROM audit_log a
     LEFT JOIN domains d ON d.id = a.domain_id
     WHERE ${where} ORDER BY a.at DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
  ).bind(...binds, PAGE + 1, page * PAGE).all<any>();
  const list = rows.results || [];
  const cnt = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`).bind(...binds).first<any>();
  const total = Number(cnt?.n || 0);
  return c.json({
    items: list.slice(0, PAGE),
    page,
    has_more: list.length > PAGE,
    total,
    pages: Math.max(1, Math.ceil(total / PAGE)),
  });
});

/** Download the whole range. CSV for Excel, JSONL for machines.
 *  整段下载。CSV 给 Excel 看,JSONL 给机器读 */
adminApp.get('/audit/export', async (c) => {
  const scope = await adminScope(c);
  const fmt = c.req.query('format') === 'jsonl' ? 'jsonl' : 'csv';
  const { where, binds } = auditScopeSql(scope, auditFrom(c));
  // Audit volume is far smaller than mail volume, so one shot is fine; the cap is just a runaway guard
  // 审计量级远小于邮件,一次取完即可;设上限防跑飞
  const rows = await c.env.DB.prepare(
    `SELECT a.at, a.actor_email, a.action, a.target, a.detail, d.name AS domain_name
     FROM audit_log a LEFT JOIN domains d ON d.id = a.domain_id
     WHERE ${where} ORDER BY a.at DESC LIMIT 50000`
  ).bind(...binds).all<any>();
  const list = rows.results || [];
  const stamp = new Date().toISOString().slice(0, 10);

  let body: string;
  if (fmt === 'jsonl') {
    body = list.map((r: any) => JSON.stringify({ ...r, at: new Date(r.at).toISOString() })).join('\n') + '\n';
  } else {
    // Excel opens CSV in the local codepage by default, so without a BOM Chinese turns into mojibake
    // Excel 默认按本地编码打开 CSV,加 BOM 才不会把中文显示成乱码
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['time', 'actor', 'domain', 'action', 'target', 'detail'];
    body =
      '﻿' +
      [head.join(','), ...list.map((r: any) =>
        [new Date(r.at).toISOString(), r.actor_email, r.domain_name, r.action, r.target, r.detail].map(esc).join(',')
      )].join('\n') + '\n';
  }
  c.header('Content-Type', fmt === 'jsonl' ? 'application/x-ndjson; charset=utf-8' : 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="cfmail-audit-${stamp}.${fmt === 'jsonl' ? 'jsonl' : 'csv'}"`);
  return c.body(body);
});

// ---------- Invites ----------
// ---------- 邀请 ----------

adminApp.get('/invites', async (c) => {
  const scope = await adminScope(c);
  const rows = await c.env.DB.prepare(
    `SELECT i.*, u.email AS creator_email, uu.email AS used_email, d.name AS domain_name,
            (SELECT COUNT(*) FROM invite_uses iu WHERE iu.invite_id=i.id) AS joined
     FROM invites i LEFT JOIN users u ON u.id=i.created_by
     LEFT JOIN users uu ON uu.id=i.used_by
     LEFT JOIN domains d ON d.id=i.domain_id
     ORDER BY i.created_at DESC LIMIT 200`
  ).all<any>();
  let list = (rows.results || []).map((i: any) => {
    // A shared link is never spent, so it only ever leaves the pending state by being
    // revoked or by expiring -- the count of who joined is reported separately.
    // 共享链接不会被用掉,离开"待用"状态只有吊销和过期两条路 —— 加入了多少人另外报。
    const spent = !i.multi_use && i.used_by;
    const status = i.revoked ? 'revoked' : spent ? 'used' : i.expires_at < now() ? 'expired' : 'pending';
    const mode = i.mailbox_mode || 'fixed';
    return {
      id: i.id, email: i.email, status, created_at: i.created_at, expires_at: i.expires_at,
      creator: i.creator_email, used_by: i.used_email, used_at: i.used_at,
      domain_id: i.domain_id, domain_name: i.domain_name,
      multi_use: !!i.multi_use, joined: i.joined || 0,
      mailbox_mode: mode,
      role: mode === 'choose' ? 'owner' : i.role || 'owner',
      // Pinned invites carry the full address; open ones carry only the domain, and the name is settled at signup
      // 限定则给出完整地址;不限定则只有域名,注册时才定名
      address: mode === 'fixed' && i.local_part && i.domain_name ? `${i.local_part}@${i.domain_name}` : null,
      // Links issued before the rework were voided by a migration; flag them here so their state does not look inexplicable
      // 改造前发出的链接已在迁移里作废,这里标出来免得看着莫名其妙
      legacy: mode === 'fixed' && !i.local_part,
    };
  });
  if (scope) list = list.filter((i: any) => i.domain_id && scope.has(i.domain_id));
  return c.json({ invites: list });
});


adminApp.post('/invites', async (c) => {
  const user = c.get('user');
  const scope = await adminScope(c);
  const body = await c.req.json<any>();

  const domainId = String(body.domain_id || '');
  if (!domainId) return c.json({ error: 'e_pick_domain' }, 400);
  if (scope && !scope.has(domainId)) return c.json({ error: 'e_no_invite_perm' }, 403);
  const dom = await c.env.DB.prepare('SELECT id, name FROM domains WHERE id=?1').bind(domainId).first<any>();
  if (!dom) return c.json({ error: 'e_domain_not_found' }, 400);

  // A shared link is good for any number of registrations until it expires, so nothing about
  // it can name one person: no pinned address to hand out twice, no email to restrict it to.
  // Those are refused rather than quietly dropped -- an administrator who typed an address
  // into an open link should hear that it does not apply, not discover it later.
  // 共享链接在过期前不限注册人数,所以它身上不能有任何指向"某一个人"的东西:
  // 没有可以发两遍的固定地址,也没有把它限死的邮箱。这些是明确拒绝而不是悄悄忽略 ——
  // 管理员往开放链接里填了地址,应该当场知道它不适用,而不是事后才发现。
  const multiUse = !!body.multi_use;
  if (multiUse && (body.email || body.local_part)) return c.json({ error: 'e_invite_multi_open_only' }, 400);

  // fixed = a pinned address (created at signup when absent); choose = the registrant picks the name and always becomes owner
  // fixed = 限定邮箱地址(不存在则注册时新建);choose = 注册者自己取名,角色固定所有者
  const mode = multiUse || body.mailbox_mode === 'choose' ? 'choose' : 'fixed';
  let localPart: string | null = null;
  let role = 'owner';
  if (mode === 'fixed') {
    localPart = String(body.local_part || '').trim().toLowerCase();
    if (!LOCAL_PART_RE.test(localPart)) return c.json({ error: 'e_bad_mailbox_name' }, 400);
    role = ['owner', 'member', 'readonly'].includes(body.role) ? body.role : 'owner';
    // A mailbox that exists and already has an owner cannot be handed out with an "owner" invite, or it would silently change hands
    // 已存在且已有所有者的邮箱,不能再用"所有者"邀请别人,免得默默换主
    const existing = await c.env.DB.prepare('SELECT id FROM mailboxes WHERE domain_id=?1 AND local_part=?2')
      .bind(domainId, localPart).first<any>();
    if (existing && role === 'owner') {
      const owner = await c.env.DB.prepare("SELECT user_id FROM grants WHERE mailbox_id=?1 AND role='owner'")
        .bind(existing.id).first<any>();
      if (owner) return c.json(E('e_owner_exists', `${localPart}@${dom.name}`), 400);
    }
  }

  const email = body.email ? normalizeAddr(String(body.email)) : null;
  if (email && !isEmail(email)) return c.json({ error: 'e_bad_email' }, 400);
  // Three lifetimes: 2 hours / 48 hours / 7 days (168 hours)
  // 有效期三挡:2 小时 / 48 小时 / 7 天(168 小时)
  const ALLOWED_HOURS = [2, 48, 168];
  let hours = parseInt(body.expires_hours || '48', 10) || 48;
  if (!ALLOWED_HOURS.includes(hours)) hours = 48;

  const token = randomToken(24);
  const id = uid();
  await c.env.DB.prepare(
    `INSERT INTO invites (id, token_hash, email, grants_json, domain_id, mailbox_mode, local_part, role, multi_use, created_by, created_at, expires_at)
     VALUES (?1,?2,?3,'[]',?4,?5,?6,?7,?8,?9,?10,?11)`
  ).bind(
    id, await sha256Hex(token), email, domainId, mode, localPart, role, multiUse ? 1 : 0,
    user.id, now(), now() + hours * 3600 * 1000
  ).run();

  // A link anyone may register through is worth a line in the log even when nobody uses it
  // 一条谁都能拿去注册的链接,即便没人用过也值得在日志里留一行
  const target = multiUse ? `*@${dom.name}` : localPart ? `${localPart}@${dom.name}` : email || dom.name;
  await audit(c.env, user, 'invite.create', target, { multi_use: multiUse, mailbox_mode: mode, hours }, domainId);

  return c.json({ id, url: inviteUrl(c.env, dom.name, token), expires_hours: hours, multi_use: multiUse });
});

adminApp.delete('/invites/:id', async (c) => {
  const scope = await adminScope(c);
  const inv = await c.env.DB.prepare('SELECT domain_id, multi_use, local_part FROM invites WHERE id=?1')
    .bind(c.req.param('id')).first<any>();
  if (!inv) throw new HttpError(404, 'e_invite_not_found');
  if (scope && !(inv.domain_id && scope.has(inv.domain_id))) throw new HttpError(403, 'e_no_perm_action');
  await c.env.DB.prepare('UPDATE invites SET revoked=1 WHERE id=?1').bind(c.req.param('id')).run();
  // Revoking closes the door for everyone still holding the link; accounts already opened stay
  // 吊销只是把还拿着链接的人关在门外;已经开出来的账号照旧
  await audit(c.env, c.get('user'), 'invite.revoke', c.req.param('id'),
    { multi_use: !!inv.multi_use }, inv.domain_id);
  return c.json({ ok: true });
});
