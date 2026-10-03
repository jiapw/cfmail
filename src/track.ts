// Who came through a share, and what they did there -- the server half.
//
// A visit begins when a tracked share is opened by someone it can name: a signed-in member of
// an internal share, or the verified address behind a public one. Everything after that arrives
// as events from the visitor's own page -- which file was opened and for how long, which pages
// of it were on screen, how much of a film was played, what was downloaded, and where they were
// when the page said goodbye. About the visitor themselves, only what the request already says:
// the user agent read for a system, device and browser; the address; and the city Cloudflare
// resolves it to on the way in.
//
// Nothing is summarised at write time. The assumption is a visitor a minute, not a thousand a
// second, and at that rate the honest thing is to keep every event as it came and answer the
// sharer's questions from the rows. A visit that has shown no sign of life for thirty minutes is
// treated as over whether or not its page ever said so -- a closed laptop sends nothing.
//
// 谁经过了一条分享,在里面做了什么 —— 服务端这一半。
//
// 一次到访从"一条开了追踪的分享被某个它叫得出名字的人打开"开始:内部分享的登录成员,
// 或公开分享门后那个验证过的地址。此后的一切都以事件的形式从访客自己的页面送来 ——
// 打开了哪个文件、开了多久,它的哪几页出现在屏幕上,一部片子放了多少,下载了什么,
// 以及页面道别时他们停在哪里。关于访客本身,只记请求自己已经说出来的:
// 从 user agent 读出的系统、设备、浏览器;地址;以及 Cloudflare 在入口处把它解析到的城市。
//
// 写入时不做任何汇总。这里假定的量级是一分钟一个访客,不是一秒一千个;
// 在这个量级上,诚实的做法是把每个事件照来时的样子留着,分享者的问题直接问这些行。
// 三十分钟没有任何活着迹象的到访视为已结束,不管它的页面有没有道过别 —— 合上的笔记本什么都不会发。
import type { Env } from './types';
import { HttpError } from './errors';
import { now, uid } from './util';

export type Who = { kind: 'email' | 'user'; id: string; name: string };

/** After this long without a heartbeat a visit is over. / 这么久没有心跳,到访就算结束了。 */
export const VISIT_IDLE_MS = 30 * 60 * 1000;
const KINDS = new Set(['enter', 'open', 'close', 'page', 'media', 'download', 'leave', 'resume']);
const BATCH_MAX = 50;
const NAME_MAX = 300;
const DETAIL_MAX = 2000;

/**
 * System, device and browser, read off a user agent string with the few tests that still tell
 * them apart. Safari on an iPad calls itself a Mac; the page sends how many fingers the screen
 * takes, and a Mac that takes more than one is an iPad.
 * 从 user agent 字符串里用那几条仍然分得清的判断读出系统、设备和浏览器。
 * iPad 上的 Safari 自称是 Mac;页面会报告屏幕吃几根手指,吃一根以上的 Mac 就是 iPad。
 */
export function describeUA(ua: string, hints: any = {}): { os: string; device: string; browser: string } {
  const u = String(ua || '');
  const touch = Number(hints?.touch || 0);
  let os = '';
  if (/Windows NT/.test(u)) os = 'Windows';
  else if (/iPhone|iPod/.test(u)) os = 'iOS';
  else if (/iPad/.test(u)) os = 'iPadOS';
  else if (/Mac OS X/.test(u)) os = touch > 1 ? 'iPadOS' : 'macOS';
  else if (/Android/.test(u)) os = 'Android';
  else if (/CrOS/.test(u)) os = 'ChromeOS';
  else if (/Linux/.test(u)) os = 'Linux';
  let device = 'desktop';
  if (os === 'iPadOS' || /Tablet|iPad/.test(u) || (/Android/.test(u) && !/Mobile/.test(u))) device = 'tablet';
  else if (os === 'iOS' || /Mobile/.test(u) || hints?.mobile) device = 'phone';
  let browser = '';
  if (/Edg\//.test(u)) browser = 'Edge';
  else if (/OPR\//.test(u)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(u)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(u)) browser = 'Chrome';
  else if (/Safari\//.test(u)) browser = 'Safari';
  return { os, device, browser };
}

/** Where the request came from, as Cloudflare saw it arrive. / 请求从哪里来,照 Cloudflare 看见它到达时的样子。 */
export function placeOf(req: Request): { ip: string; country: string; region: string; city: string; tz: string } {
  const cf: any = (req as any).cf || {};
  const ip = String(req.headers.get('CF-Connecting-IP') || (req.headers.get('X-Forwarded-For') || '').split(',')[0] || '').trim();
  return {
    ip: ip.slice(0, 64),
    country: String(cf.country || '').slice(0, 8),
    region: String(cf.region || '').slice(0, 100),
    city: String(cf.city || '').slice(0, 100),
    tz: String(cf.timezone || '').slice(0, 64),
  };
}

export async function startVisit(env: Env, req: Request, shareId: string, who: Who, hints: any): Promise<{ id: string; started_at: number }> {
  const t = now();
  const id = uid();
  const ua = String(req.headers.get('User-Agent') || '').slice(0, 500);
  const d = describeUA(ua, hints || {});
  const p = placeOf(req);
  const tz = String(hints?.tz || p.tz || '').slice(0, 64);
  await env.DB.prepare(
    `INSERT INTO drive_share_visits (id, share_id, viewer_kind, viewer, viewer_name, started_at, last_at,
       ua, os, device, browser, ip, country, region, city, tz)
     VALUES (?1,?2,?3,?4,?5,?6,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
  ).bind(id, shareId, who.kind, who.id.slice(0, 254), who.name.slice(0, NAME_MAX), t,
    ua, d.os, d.device, d.browser, p.ip, p.country, p.region, p.city, tz).run();
  return { id, started_at: t };
}

/**
 * Events for one visit, each checked for shape and trimmed to size. A 'beat' carries nothing and
 * only says the page is still open; a 'leave' closes the visit and keeps what was on screen; a
 * 'resume' after a leave reopens it -- a tab brought back from the background was never gone.
 * 一次到访的事件,逐条验形状、裁大小。'beat' 不带任何东西,只说页面还开着;
 * 'leave' 结束到访并留下当时屏幕上的东西;leave 之后的 'resume' 把它重新打开 ——
 * 从后台拉回来的标签页从来没有走过。
 */
export async function appendEvents(env: Env, shareId: string, visitId: string, events: unknown): Promise<{ ok: true; n: number }> {
  const v: any = await env.DB.prepare('SELECT id, share_id FROM drive_share_visits WHERE id=?1').bind(visitId).first();
  if (!v || v.share_id !== shareId) throw new HttpError(404, 'e_drive_share_not_found');
  const list: any[] = Array.isArray(events) ? events.slice(0, BATCH_MAX) : [];
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  let left = false;
  let resumed = false;
  let exitWhere = '';
  for (const raw of list) {
    const kind = String(raw?.kind || '');
    if (!KINDS.has(kind)) continue;
    const node = String(raw?.node || '').slice(0, 64);
    const name = String(raw?.name || '').slice(0, NAME_MAX);
    const detail = raw?.detail && typeof raw.detail === 'object' ? JSON.stringify(raw.detail).slice(0, DETAIL_MAX) : '';
    if (kind === 'leave') { left = true; exitWhere = detail; }
    if (kind === 'resume') resumed = true;
    stmts.push(env.DB.prepare(
      'INSERT INTO drive_share_events (id, visit_id, share_id, at, kind, node_id, name, detail) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)'
    ).bind(uid(), visitId, shareId, t, kind, node, name, detail));
  }
  const n = stmts.length;
  if (left) {
    stmts.push(env.DB.prepare('UPDATE drive_share_visits SET last_at=?1, ended_at=?1, exit_where=?2 WHERE id=?3').bind(t, exitWhere, visitId));
  } else if (resumed) {
    stmts.push(env.DB.prepare('UPDATE drive_share_visits SET last_at=?1, ended_at=NULL WHERE id=?2').bind(t, visitId));
  } else {
    stmts.push(env.DB.prepare('UPDATE drive_share_visits SET last_at=?1 WHERE id=?2').bind(t, visitId));
  }
  await env.DB.batch(stmts);
  return { ok: true, n };
}

function parseJson(s: unknown): any {
  try { return s ? JSON.parse(String(s)) : null; } catch { return null; }
}

function visitJson(v: any): any {
  const t = now();
  return {
    id: v.id, viewer_kind: v.viewer_kind, viewer: v.viewer, viewer_name: v.viewer_name || '',
    started_at: v.started_at, last_at: v.last_at, ended_at: v.ended_at || null,
    // Alive: no goodbye yet, and a heartbeat recently enough to believe the page is still open.
    // 活着:还没道别,而且心跳近得足以相信页面还开着。
    live: !v.ended_at && v.last_at > t - VISIT_IDLE_MS,
    os: v.os, device: v.device, browser: v.browser,
    ip: v.ip, country: v.country, region: v.region, city: v.city, tz: v.tz,
    exit_where: parseJson(v.exit_where),
    opens: v.opens || 0, downloads: v.downloads || 0, events: v.events || 0,
  };
}

/** The sharer's list: every visit to one share, newest first, with a few counts to read at a glance.
 *  分享者的列表:一条分享的每一次到访,最新在前,带几个一眼能读的计数。 */
export async function listVisits(env: Env, shareId: string): Promise<any[]> {
  const rows = await env.DB.prepare(
    `SELECT v.*,
       (SELECT COUNT(*) FROM drive_share_events e WHERE e.visit_id=v.id AND e.kind='open') AS opens,
       (SELECT COUNT(*) FROM drive_share_events e WHERE e.visit_id=v.id AND e.kind='download') AS downloads,
       (SELECT COUNT(*) FROM drive_share_events e WHERE e.visit_id=v.id) AS events
     FROM drive_share_visits v WHERE v.share_id=?1 ORDER BY v.started_at DESC LIMIT 500`
  ).bind(shareId).all();
  return ((rows.results || []) as any[]).map(visitJson);
}

/** One visit with everything that happened in it, in the order it happened.
 *  一次到访,连同其中发生的一切,按发生的顺序。 */
export async function visitEvents(env: Env, shareId: string, visitId: string): Promise<{ visit: any; events: any[] }> {
  const v: any = await env.DB.prepare('SELECT * FROM drive_share_visits WHERE id=?1 AND share_id=?2').bind(visitId, shareId).first();
  if (!v) throw new HttpError(404, 'e_drive_share_not_found');
  const rows = await env.DB.prepare(
    'SELECT id, at, kind, node_id, name, detail FROM drive_share_events WHERE visit_id=?1 ORDER BY at, rowid LIMIT 2000'
  ).bind(visitId).all();
  return {
    visit: visitJson(v),
    events: ((rows.results || []) as any[]).map((e) => ({ id: e.id, at: e.at, kind: e.kind, node: e.node_id, name: e.name, detail: parseJson(e.detail) })),
  };
}
