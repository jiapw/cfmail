// Meetings: voice, optional video, one shared screen at a time.
//
// Everybody sends one camera picture and all of them are shown the same size; how sharp each one
// is sent depends on how many share the screen with it -- two people get the meeting's full
// resolution, a gallery of sixteen gets 270 lines each. So there is no simulcast and no layer
// selection: every subscriber sees tiles of about the same size, and the sender picks the one
// size that suits them all. A screen is a track of its own, and one person at a time may put
// theirs up. The room says who, because the room is what forwards the request to the SFU.
//
// Three parties, and what each one is trusted with:
//
//   The browser  captures, encodes, and talks WebRTC to Cloudflare's SFU directly. Media never
//                passes through this Worker.
//   The SFU      forwards packets and decodes nothing. It will do whatever the holder of the app
//                secret asks, for any session, so the secret never leaves this file.
//   The room     (the Durable Object below) is the only thing that can ask the SFU for anything.
//                A browser hands it an SDP over the WebSocket it is seated on; the room decides
//                whether that person may publish that kind of track or subscribe to that peer,
//                and only then forwards the request. Which means the room also knows, first-hand
//                and not by anybody's say-so, which tracks exist.
//
// Like the room a document is presented in (present.ts), this one is a pipe and not a shelf:
// who is here, who is waiting at the door and whose screen is up all live on the sockets and in
// one small record, and the whole of it is thrown away when the last person leaves. What
// outlives a call is in D1 -- see migrations/0040_meet.sql. The audience of a broadcast has
// objects of its own (meetaudience.ts), so that thousands of viewers never queue behind the
// room's negotiations.
//
// 会议:语音、可选的视频、同一时刻一块共享屏幕。
//
// 每个人发一路摄像头画面,显示得一样大;每一路发得多清楚,取决于同屏有几个人 —— 两个人时是会议的全幅,
// 十六格的画廊每格 270 线。于是没有 simulcast、没有选层:每个订阅者看到的格子大小都差不多,
// 发送方只挑那一个对所有人都合适的尺寸。屏幕是单独的一条轨,同一时刻只能有一个人挂上来。
// 由房间说了算是谁,因为正是房间把请求转给 SFU 的。
//
// 三方,以及各自被托付了什么:
//
//   浏览器  采集、编码,并直接与 Cloudflare 的 SFU 讲 WebRTC。媒体从不经过这个 Worker。
//   SFU     只转发包,什么都不解码。持有 app secret 的人让它对任何会话做什么,它都照办,
//           所以这个 secret 永不离开本文件。
//   房间    (下面那个 Durable Object)是唯一能向 SFU 提要求的东西。浏览器经由自己入座的那条
//           WebSocket 把 SDP 交给它;由它判断此人能否发布这种轨道、能否订阅那个人,然后才转交。
//           这也意味着:有哪些轨道存在,房间是亲眼所见,而不是听谁说的。
//
// 与文档演示的房间(present.ts)一样,这里是管子不是架子:谁在场、谁等在门口、谁的屏幕挂着,
// 都住在 socket 上和一条很小的记录里,最后一个人离开时整个扔掉。比一通会活得久的东西在 D1 ——
// 见 migrations/0040_meet.sql。直播的观众有自己的对象(meetaudience.ts),
// 这样成千上万的观众永远不会排在房间的协商后面。
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { Env, User } from './types';
import { HttpError } from './errors';
import { requireAuth, userFromRequest } from './auth';
import { adminScope, checkDomainScope } from './admin';
import { audit } from './audit';
import { verifyTurnstile } from './turnstile';
import { parseAddrList, sendInvitations, userIdForAddress } from './meetinvite';
import { aiAvailable } from './llm';
import { compositorStatus, launchOrder, liveProvider, playbackUrl, provisionLive, retireLive, startCompositor, stopCompositor, sweepLive, PLAY_TTL_SEC } from './meetlive';
import { CARD_TTL_MS, PASS_TTL_MS, VID_RE, audienceStub, cleanName, readPaper, signPaper, tellHall, viewerShard, type AudWho } from './meetaudience';
import { domainFromHost, entryLabel, isEmail, normalizeAddr, now, randomToken, sha256Hex, uid } from './util';

type Ctx = { Bindings: Env; Variables: { user: User } };

// ---------- What a meeting is ----------
// ---------- 会议是什么 ----------

export type MeetKind = 'group' | 'live';
export type GuestMode = 'off' | 'lobby' | 'open';
export type Role = 'host' | 'member' | 'guest' | 'bot';
/** The three things a person can publish. There is no fourth: a meeting that grows one has to
 *  say, here, who may send it. / 一个人能发布的三样东西。没有第四样:哪天要加,就得在这里说清谁能发。 */
export type TrackKind = 'mic' | 'cam' | 'screen';

const KINDS = new Set<MeetKind>(['group', 'live']);
const GUEST_MODES = new Set<GuestMode>(['off', 'lobby', 'open']);
const RESOLUTIONS = [480, 720, 1080];
const TRACK_KINDS = new Set<TrackKind>(['mic', 'cam', 'screen']);

/** Whether this deployment can hold meetings at all. A deployment made before meetings existed
 *  has no room binding, and one that never created an SFU app has no secret; either way the
 *  honest answer is "not here", not an error halfway into a call.
 *  这套部署到底能不能开会。早于会议功能的部署没有房间绑定,没建过 SFU app 的没有 secret;
 *  两种情况下诚实的回答都是"这里没有",而不是通话进行到一半才报错。 */
export function meetReady(env: Env): boolean {
  // Or the person who deployed it switched meetings off (vars.MEETINGS, written by the deploy).
  // 或者部署它的人把会议关了(vars.MEETINGS,由部署脚本写入)。
  if (env.MEETINGS === 'off') return false;
  return !!(env.MEET_ROOM && env.REALTIME_APP_ID && env.REALTIME_APP_SECRET);
}

/** Live meetings need three more things: a compositor to make one picture of many, Stream to
 *  carry it, and a key to sign the bot's ticket with. / 直播会议还要三样:把多路合成一路的合成器、
 *  承载它的 Stream、以及给机器人的入场券签名的密钥。 */
export function meetLiveReady(env: Env): boolean {
  if (!meetReady(env) || !env.MEET_BOT_KEY || env.MEETINGS === 'no-live') return false;
  const p = liveProvider(env);
  // On a developer's machine whoever runs the test starts the compositor; everywhere else a
  // broadcast needs the container that makes it and the key its playback tokens are signed with.
  // 开发机上由跑测试的人来启动合成器;其余场合,直播需要制作它的容器,以及给播放令牌签名的那把钥匙。
  return p === 'dev' || (p === 'stream' && !!env.MEET_COMPOSITOR && !!env.STREAM_SIGNING_KEY_ID && !!env.STREAM_SIGNING_JWK);
}

/** Letters that survive being read aloud or copied by hand: no l/1/i, no o/0.
 *  经得起口述和手抄的字符:没有 l/1/i,没有 o/0。 */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A meeting's code: twelve characters in three groups. Rejection-sampled, for the reason
 *  randomPassword gives. / 会议短码:十二个字符分三组。用拒绝采样,理由见 randomPassword。 */
function newCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(24))) {
      if (b >= limit) continue;
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === 12) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

const CODE_RE = /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/;

interface DomainCaps {
  id: string;
  name: string;
  meet_enabled: number;
  meet_live_enabled: number;
  meet_max_group: number;
  meet_max_speakers: number;
  meet_max_resolution: number;
}

/** The domains this person may hold meetings under, the one they are visiting first.
 *  此人可以在其名下开会的域名,当前访问的那个排在最前。 */
async function meetDomains(c: any, user: User): Promise<DomainCaps[]> {
  const cols = 'd.id, d.name, d.meet_enabled, d.meet_live_enabled, d.meet_max_group, d.meet_max_speakers, d.meet_max_resolution';
  const rows = await c.env.DB.prepare(
    user.is_admin
      ? `SELECT ${cols} FROM domains d WHERE d.meet_enabled=1 ORDER BY d.name`
      : `SELECT ${cols} FROM domains d WHERE d.meet_enabled=1 AND d.id IN
           (SELECT mb.domain_id FROM grants g JOIN mailboxes mb ON mb.id=g.mailbox_id WHERE g.user_id=?1)
         ORDER BY d.name`
  ).bind(...(user.is_admin ? [] : [user.id])).all();
  const list = (rows.results || []) as DomainCaps[];
  const here = domainFromHost(c.env, new URL(c.req.url).hostname);
  return list.sort((a, b) => Number(b.name === here) - Number(a.name === here));
}

/** Whether the person has meetings at all -- the flag /api/me reports.
 *  此人到底有没有会议功能 —— /api/me 报告的就是这个。 */
export async function meetFlagsFor(c: any, user: User): Promise<{ meet_enabled: boolean; meet_live_enabled: boolean }> {
  if (!meetReady(c.env)) return { meet_enabled: false, meet_live_enabled: false };
  const list = await meetDomains(c, user).catch(() => [] as DomainCaps[]);
  return {
    meet_enabled: list.length > 0,
    meet_live_enabled: meetLiveReady(c.env) && list.some((d) => !!d.meet_live_enabled),
  };
}

/** Where a meeting's links point: the entry host of the domain it was created under.
 *  会议链接指向哪儿:创建它的那个域名的入口主机。 */
function meetOrigin(env: Env, domainName: string | null): string {
  const entry = entryLabel(env);
  return env.DEV_MODE === '1' || !domainName || !entry ? env.APP_ORIGIN : `https://${entry}.${domainName}`;
}

/** A meeting as its owner sees it. / 会议在创建者眼里的样子。 */
function meetingJson(env: Env, m: any, domainName: string | null, extra: Record<string, unknown> = {}) {
  const base = meetOrigin(env, domainName);
  return {
    id: m.id, code: m.code, kind: m.kind, title: m.title, persistent: !!m.persistent,
    starts_at: m.starts_at, duration_min: m.duration_min,
    video: !!m.video, resolution: m.resolution, max_people: m.max_people,
    guest_mode: m.guest_mode, e2ee: !!m.e2ee, record_mode: m.record_mode, drive_record: !!m.drive_record,
    audience_access: m.audience_access, audience_chat: !!m.audience_chat,
    created_at: m.created_at, ended_at: m.ended_at,
    link: `${base}/#/meet/${m.code}`,
    guest_link: m.guest_mode !== 'off' && m.guest_token ? `${base}/#/meet/${m.code}?k=${m.guest_token}` : null,
    ...extra,
  };
}

/** Read what a create or an edit asks for, against what the domain allows. Only the fields that
 *  were sent are returned, so the same function serves both.
 *  对照域名允许的范围,读出一次创建或修改所要求的内容。只返回被送来的字段,所以创建与修改共用它。 */
function readSettings(body: any, caps: DomainCaps, kind: MeetKind, env: Env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const bad = (f: string) => new HttpError(400, 'e_meet_bad_field', f);
  if (body.title !== undefined) out.title = String(body.title || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);
  if (body.starts_at !== undefined) {
    const t = body.starts_at === null ? null : Math.floor(Number(body.starts_at));
    if (t !== null && (!Number.isFinite(t) || t < now() - 86400_000 || t > now() + 366 * 86400_000)) throw bad('starts_at');
    out.starts_at = t;
  }
  if (body.duration_min !== undefined) {
    const d = body.duration_min === null ? null : Math.floor(Number(body.duration_min));
    if (d !== null && (!Number.isFinite(d) || d < 5 || d > 1440)) throw bad('duration_min');
    out.duration_min = d;
  }
  if (body.video !== undefined) out.video = body.video ? 1 : 0;
  if (body.resolution !== undefined) {
    const r = Number(body.resolution);
    if (!RESOLUTIONS.includes(r) || r > caps.meet_max_resolution) throw bad('resolution');
    out.resolution = r;
  }

  if (body.max_people !== undefined) {
    const cap = kind === 'live' ? caps.meet_max_speakers : caps.meet_max_group;
    const n = Math.floor(Number(body.max_people));
    if (!Number.isFinite(n) || n < 2 || n > cap) throw bad('max_people');
    out.max_people = n;
  }
  if (body.guest_mode !== undefined) {
    if (!GUEST_MODES.has(body.guest_mode)) throw bad('guest_mode');
    out.guest_mode = body.guest_mode;
  }
  if (body.e2ee !== undefined) {
    // End-to-end encryption is a promise, and a promise this build cannot keep yet is not one to
    // let somebody tick. / 端到端加密是一句承诺;这个版本还兑现不了的承诺,就不该让人勾选。
    if (body.e2ee && (kind !== 'group' || !MEET_E2EE_READY)) throw new HttpError(400, 'e_meet_e2ee_unavailable');
    out.e2ee = body.e2ee ? 1 : 0;
  }
  if (body.record_mode !== undefined) {
    const ok = kind === 'live' ? ['off', 'stream'] : ['off', 'local'];
    if (!ok.includes(body.record_mode)) throw bad('record_mode');
    out.record_mode = body.record_mode;
  }
  if (body.persistent !== undefined) out.persistent = body.persistent ? 1 : 0;
  if (kind === 'live') {
    if (body.drive_record !== undefined) out.drive_record = body.drive_record ? 1 : 0;
    if (body.audience_access !== undefined) {
      if (!['link', 'signin'].includes(body.audience_access)) throw bad('audience_access');
      out.audience_access = body.audience_access;
    }
    if (body.audience_chat !== undefined) out.audience_chat = body.audience_chat ? 1 : 0;
  }
  void env;
  return out;
}

/** Flipped when the encrypted path exists end to end. Until then the column is there and the
 *  switch is not. / 加密链路端到端就绪时翻开。在那之前,列在,开关不在。 */
const MEET_E2EE_READY = true;

// ---------- Rate limits for the doors outside the sign-in ----------
// ---------- 登录之外那几扇门的限速 ----------

function clientIp(c: any): string {
  return String(c.req.header('CF-Connecting-IP') || (c.req.header('X-Forwarded-For') || '').split(',')[0] || '').trim();
}

/** A rolling window per key; the key is a hash and the address behind it is never written.
 *  按键滚动的窗口;键是哈希,它背后的地址从不落库。 */
export async function allow(env: Env, key: string, max: number, windowMs: number): Promise<boolean> {
  const t = now();
  const row = (await env.DB.prepare('SELECT window_at, n FROM meet_throttle WHERE key=?1').bind(key).first()) as any;
  if (row && row.window_at > t - windowMs) {
    if (row.n >= max) return false;
    await env.DB.prepare('UPDATE meet_throttle SET n=n+1 WHERE key=?1').bind(key).run();
    return true;
  }
  await env.DB.prepare(
    'INSERT INTO meet_throttle (key, window_at, n) VALUES (?1,?2,1) ON CONFLICT(key) DO UPDATE SET window_at=?2, n=1'
  ).bind(key, t).run();
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM meet_throttle WHERE window_at < ?1').bind(t - 2 * 3600 * 1000).run().catch(() => {});
  }
  return true;
}

const ipKey = async (kind: string, scope: string, ip: string) => `${kind}:${scope}:${await sha256Hex(`${scope}|${ip}`)}`;

// ---------- The bot's ticket ----------
// ---------- 机器人的入场券 ----------

/** The compositor joins as a participant nobody sees. It cannot sign in and must not hold a
 *  guest link, so it is given a ticket instead: the meeting and an expiry, signed with a key only
 *  this Worker has. Stateless on purpose -- there is nowhere to look a ticket up, so there is
 *  nothing to leak and nothing to clean.
 *  合成器以一个没人看得见的参会者身份入会。它登录不了,也不该拿访客链接,所以给它一张入场券:
 *  会议 id 加过期时间,用只有这个 Worker 持有的密钥签名。刻意无状态 —— 入场券无处可查,
 *  于是无可泄露,也无需清理。 */
async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function botTicket(env: Env, meetingId: string, ttlMs = 12 * 3600 * 1000): Promise<string> {
  if (!env.MEET_BOT_KEY) throw new HttpError(503, 'e_meet_live_unavailable');
  const exp = now() + ttlMs;
  return `${exp}.${await hmacHex(env.MEET_BOT_KEY, `${meetingId}.${exp}`)}`;
}

async function botTicketOk(env: Env, meetingId: string, ticket: string): Promise<boolean> {
  if (!env.MEET_BOT_KEY) return false;
  const [expS, sig] = String(ticket || '').split('.');
  const exp = Number(expS);
  if (!Number.isFinite(exp) || exp < now() || !sig) return false;
  const want = await hmacHex(env.MEET_BOT_KEY, `${meetingId}.${exp}`);
  // Same length always, so a plain loop over both is constant-time enough for a hex digest.
  // 两者恒等长,所以对十六进制摘要来说,逐位走完的普通循环已足够恒时。
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ---------- Saying no over a WebSocket ----------
// ---------- 在 WebSocket 上说"不" ----------

/** A browser cannot read the status of a WebSocket handshake that failed: every refusal looks the
 *  same to it, a connection that did not open. So a refusal is delivered the only way the page can
 *  hear it -- the socket is accepted, told why in one message, and closed. Nothing else is ever
 *  sent on it, and the room never learns it existed.
 *  浏览器读不到一次失败的 WebSocket 握手的状态码:对它来说所有拒绝都一个样 —— 连接没打开。
 *  所以拒绝只能用页面听得见的方式送达:接受这条 socket、用一条消息说明原因、然后关掉。
 *  除此之外什么都不会在它上面发送,房间也从不知道它存在过。 */
export function refuseSocket(code: string, args: (string | number)[] = []): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  try {
    pair[1].send(JSON.stringify({ t: 'refused', error: code, args }));
    pair[1].close(4400, code.slice(0, 100));
  } catch { /* the other end already gave up / 对端已经放弃 */ }
  return new Response(null, { status: 101, webSocket: pair[0] });
}

// ---------- The room ----------
// ---------- 房间 ----------

/** What the room was told about the meeting by the Worker that let somebody in. Refreshed by
 *  every arrival, so an edit made while the meeting is on reaches the room with the next person.
 *  放人进来的那个 Worker 告诉房间的、关于这场会议的事。每来一个人刷新一次,
 *  所以会议进行中做的修改,会随着下一个人到达房间。 */
interface Cfg {
  id: string;
  code: string;
  kind: MeetKind;
  title: string;
  owner: string;
  video: boolean;
  resolution: number;
  max_people: number;
  e2ee: boolean;
  record_mode: string;
  /** Whether what is said can be put into words and summed up: there is a model, and the
   *  meeting is not an encrypted one. / 说的话能否转成文字并写成摘要:有模型可用,且会议未加密。 */
  minutes: boolean;
  persistent: boolean;
  /** Where this deployment is reached from outside: the compositor is sent here to find the door.
   *  这套部署从外面怎么访问:合成器要凭它找到那扇门。 */
  origin?: string;
  /** The key in the guest link, while guests are let in at all. People in the room are told it,
   *  so that "copy link" inside a meeting that admits guests gives a link a guest can use -- the
   *  plain one sends them to a sign-in page they have no account for. Nothing is given away:
   *  every guest in the room already has it in their address bar.
   *  访客链接里的那把钥匙(仅在允许访客时)。房间里的人会被告知它,于是在一场允许访客的会议里点"复制链接",
   *  得到的是访客用得了的链接 —— 普通链接会把他们送到一个他们根本没有账号的登录页。
   *  这并没有泄露什么:房间里的每位访客,地址栏里本来就有它。 */
  guest_key?: string;
}

/** Everything the room keeps that is not about one person. One record, read once per wake.
 *  房间留着的、不属于某一个人的全部东西。一条记录,每次醒来读一次。 */
interface RoomState {
  cfg: Cfg;
  /** Nobody new gets in. / 不再放新人进来。 */
  locked: boolean;
  /** Somebody is in the middle of putting their screen up. Who is sharing is otherwise read off
   *  what people publish; this only covers the moment between asking the SFU and hearing back,
   *  so that two people pressing the button together do not both get through.
   *  有人正在把屏幕放上来的途中。平时"谁在共享"是从各人发布了什么读出来的;
   *  这里只管"问了 SFU、还没等到回音"的那一刻,免得两个人同时按下按钮、两个都通过。 */
  screenBy?: string;
  screenAt?: number;
  rec: boolean;
  /** Whose browser is doing the recording, in a small meeting: the mark goes out when they do.
   *  小组会议里,是谁的浏览器在录:人走了,标记也跟着熄。 */
  recBy?: string;
  live: 'off' | 'starting' | 'on' | 'stopping';
  /** The live input this sitting pushes to, while it is on air. / 开播期间,这一场所推向的 live input。 */
  liveUid?: string;
  /** Where the compositor pushes, stream key included. Kept so that a compositor that died can
   *  be started again on the same input; it lives in this object's storage and goes nowhere else.
   *  合成器的推流地址,含推流密钥。留着它,是为了合成器死掉之后能在同一个 input 上重新启动;
   *  它只存在于这个对象的存储里,不去任何别的地方。 */
  livePush?: string;
  /** The meeting_sessions row for this sitting. / 这一场对应的 meeting_sessions 行。 */
  sessionRow: string;
  peak: number;
  /** Signed-in people a host removed; they do not get back in until the room is over.
   *  被主持人请出去的已登录用户;房间结束之前,他们进不来。 */
  kicked: string[];
}

/** Everything about one connection, kept on the socket so hibernation cannot lose it. The
 *  platform allows 2 KB here, which is why names are cut short at the door and track names are
 *  terse. / 一条连接的全部,存在 socket 上,好让休眠带不走它。平台在这里只给 2 KB,
 *  所以名字在门口就截短,轨道名也取得很短。 */
interface Who {
  peer: string;
  user: string;
  name: string;
  role: Role;
  /** Standing at the door. Sees nothing of the room and can say nothing to it.
   *  站在门口。看不到房间里的任何东西,也对它说不了任何话。 */
  waiting: boolean;
  color: number;
  mic: boolean;
  cam: boolean;
  hand: boolean;
  /** Their two SFU sessions, once they have them: `sid` only ever subscribes, `psid` only ever
   *  publishes. One connection doing both does not survive the real SFU -- after it has accepted
   *  an offer the SFU made, the SFU's answer to an offer of OURS carries a retransmission entry
   *  for a codec the answer does not list, and the browser refuses the whole answer. Two
   *  connections never negotiate against each other, so the question does not arise.
   *  他在 SFU 上的两个会话,有了之后才填:`sid` 只订阅,`psid` 只发布。一条连接两样都干,
   *  在真实的 SFU 上活不下来 —— 它接受过 SFU 发来的 offer 之后,SFU 对**我们的** offer 的应答里
   *  会带着一条"重传"条目,而它所指的编码并不在应答里,浏览器于是拒掉整份应答。
   *  两条连接从不互相协商,这个问题也就无从发生。 */
  sid: string;
  psid: string;
  /** What they publish: kind -> [track name, mid]. Written only from the SFU's own answer.
   *  他发布了什么:kind -> [轨道名, mid]。只根据 SFU 自己的应答来写。 */
  /** kind -> [track name at the SFU, mid, codec]. The codec is what the SFU agreed to receive
   *  this track in; a subscriber that can only answer with one codec needs to be told which.
   *  kind -> [SFU 上的轨道名, mid, 编码]。编码是 SFU 同意以之接收这条轨的那一种;
   *  只能以一种编码作答的订阅者,需要有人告诉它是哪一种。 */
  pub: Partial<Record<TrackKind, [string, string, string?]>>;
  lastChat?: number;
  /** Came in on a speaker's ticket from the audience: the ticket's viewer id. One ticket, one
   *  seat -- the same ticket coming through the door again takes this seat over.
   *  凭观众席上拿到的发言入场券进来的:券上的观众 id。一张券一个座位 —— 同一张券再进一次门,就接管这个座位。 */
  tk?: string;
}

const IN_COLOUR = 8;
const MAX_WAITING = 50;
const CHAT_MAX = 2000;
const CHAT_GAP_MS = 300;
const SCREEN_HOLD_MS = 10_000;

/** Who may say what. Three lists rather than a check in each branch, so that adding a message
 *  forces the question "who may send this" to be answered rather than defaulted.
 *  谁能说什么。写成三份清单而不是每个分支里各判一次,这样新增一种消息时,
 *  "谁能发它"这个问题会被逼着回答,而不是被默认掉。 */
const HOST_ONLY = new Set(['admit', 'deny', 'kick', 'mute', 'screen_stop', 'lock', 'end', 'rec', 'live_start', 'live_stop']);
const SEATED = new Set(['sfu', 'state', 'hand', 'chat']);
/** The bot watches; it publishes nothing and has no voice in the room. / 机器人只看;它什么都不发布,在房间里也没有发言权。 */
const BOT_MAY = new Set(['sfu', 'bye']);
const LIVE_CHECK_MS = 60_000;

/** The codec a published track travels in: the first real payload of its m-section in the SFU's
 *  answer (a sender uses the first codec the other side accepted). Retransmission and
 *  error-correction payloads are not codecs.
 *  一条已发布的轨道以什么编码传输:SFU 应答里它那个 m 段的第一个真正的 payload
 *  (发送方用的是对方接受的第一种编码)。重传与纠错的 payload 不算编码。 */
function codecOf(sdp: string, mid: string): string {
  for (const sec of String(sdp || '').split(/\r?\n(?=m=)/)) {
    if (!sec.startsWith('m=') || !new RegExp(`^a=mid:${mid.replace(/[^\w.-]/g, '')}\\s*$`, 'm').test(sec)) continue;
    const pts = (sec.split(/\r?\n/)[0] || '').split(' ').slice(3);
    for (const pt of pts) {
      const name = sec.match(new RegExp(`^a=rtpmap:${pt} ([^/\\s]+)`, 'm'))?.[1]?.toLowerCase() || '';
      if (name && !['rtx', 'red', 'ulpfec', 'flexfec-03'].includes(name)) return name;
    }
  }
  return '';
}

export class MeetRoom extends DurableObject<Env> {
  private state?: RoomState;

  // ----- the record -----

  private async room(): Promise<RoomState | undefined> {
    if (!this.state) this.state = (await this.ctx.storage.get('room')) as RoomState | undefined;
    return this.state;
  }

  private async save(): Promise<void> {
    if (this.state) await this.ctx.storage.put('room', this.state);
  }

  // ----- the sockets -----

  private all(except?: WebSocket): { ws: WebSocket; who: Who }[] {
    const out: { ws: WebSocket; who: Who }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const who = ws.deserializeAttachment() as Who | null;
      if (who && who.peer) out.push({ ws, who });
    }
    return out;
  }

  /** The people actually in the meeting: past the door, and people. / 真正在会议里的人:进了门的,而且是人。 */
  private seated(except?: WebSocket) {
    return this.all(except).filter((s) => !s.who.waiting && s.who.role !== 'bot');
  }

  private send(ws: WebSocket, msg: unknown): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* a socket on its way out / 一条正在离场的 socket */ }
  }

  private keep(ws: WebSocket, who: Who): void {
    try { ws.serializeAttachment(who); } catch { /* likewise / 同上 */ }
  }

  private freeColour(here: { who: Who }[]): number {
    const used = new Set(here.map((s) => s.who.color));
    for (let i = 0; i < IN_COLOUR; i++) if (!used.has(i)) return i;
    return IN_COLOUR - 1;
  }

  // ----- what the room looks like -----

  /** The whole room as one message. Sent on every change rather than as deltas: a client that
   *  missed one delta would be wrong until it reconnected, and thirty-two people is three
   *  kilobytes. Hosts get one extra list: who is at the door.
   *  整个房间,作为一条消息。每次有变化就发整份,而不是发增量:漏掉一次增量的客户端会一直错到重连,
   *  而三十二个人不过三千字节。主持人多拿一份名单:谁在门口。 */
  private snapshot(st: RoomState, forHost: boolean, gone?: WebSocket) {
    const everyone = this.all(gone);
    const msg: any = {
      t: 'room',
      peers: everyone.filter((s) => !s.who.waiting && s.who.role !== 'bot').map(({ who }) => ({
        peer: who.peer, name: who.name, role: who.role, color: who.color,
        mic: who.mic, cam: who.cam, hand: who.hand, pub: Object.keys(who.pub || {}),
      })),
      // Whose screen is up, if anybody's: the first person publishing one. / 谁的屏幕正挂着(如果有):第一个在发布屏幕的人。
      screen: everyone.find((s) => !s.who.waiting && s.who.pub?.screen)?.who.peer || null,
      locked: st.locked, rec: st.rec, rec_by: st.rec ? st.recBy || '' : '', live: st.live,
    };
    if (forHost) {
      msg.lobby = everyone.filter((s) => s.who.waiting).map(({ who }) => ({ peer: who.peer, name: who.name }));
    }
    return msg;
  }

  /** Tell everybody in the room what the room now is. `gone` is a socket that is leaving: it is
   *  neither listed nor told, for the reason present.ts gives at length.
   *  把房间此刻的样子告诉房间里的每个人。`gone` 是正在离开的 socket:既不列入也不通知,
   *  理由 present.ts 里说得很详细。 */
  private announce(st: RoomState, gone?: WebSocket): void {
    const plain = JSON.stringify(this.snapshot(st, false, gone));
    let forHosts: string | null = null;
    for (const { ws, who } of this.all(gone)) {
      if (who.waiting) continue;
      try {
        if (who.role === 'host') ws.send(forHosts ??= JSON.stringify(this.snapshot(st, true, gone)));
        else ws.send(plain);
      } catch { /* on its way out / 正在离场 */ }
    }
  }

  // ----- the SFU -----

  private async sfu(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const base = (this.env.REALTIME_API_BASE || 'https://rtc.live.cloudflare.com/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/apps/${this.env.REALTIME_APP_ID}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.env.REALTIME_APP_SECRET}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }

  /** Short-lived TURN credentials for one person, or plain STUN when no TURN key is configured.
   *  The credentials are what a network that blocks UDP needs; everybody else never uses them.
   *  给某一个人的短期 TURN 凭据;没配 TURN key 就只给 STUN。封了 UDP 的网络才用得上这些凭据,
   *  其余的人永远用不到。 */
  private async iceServers(): Promise<unknown[]> {
    const stun = [{ urls: 'stun:stun.cloudflare.com:3478' }];
    if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_TOKEN) return stun;
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.env.TURN_KEY_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 12 * 3600 }),
      });
      const j: any = await res.json();
      const list = Array.isArray(j?.iceServers) ? j.iceServers : [];
      // Browsers refuse to connect to port 53, and an ICE server list with one bad URL in it is
      // rejected whole by some of them. / 浏览器拒绝连 53 端口,而有的浏览器会因为列表里一个坏地址拒掉整份。
      const cleaned = list
        .map((s: any) => ({ ...s, urls: ([] as string[]).concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) }))
        .filter((s: any) => s.urls.length);
      return cleaned.length ? cleaned : stun;
    } catch {
      return stun;
    }
  }

  // ----- arriving -----

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // The owner ended or deleted the meeting from outside the room. / 创建者在房间之外结束或删除了会议。
    if (url.pathname.endsWith('/__end')) {
      await this.endAll('ended');
      return new Response('ok');
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    // Written by our own router after it did the asking; nothing outside the Worker can address
    // this object, so nobody else could have written them. / 由我们自己的路由在问过之后写下;
    // Worker 之外的任何东西都寻址不到这个对象,所以不存在别人能写下它们。
    const h = req.headers;
    let cfg: Cfg;
    try { cfg = JSON.parse(decodeURIComponent(h.get('x-meet-cfg') || '')); } catch { return new Response('bad cfg', { status: 400 }); }
    const role = (h.get('x-meet-role') || 'guest') as Role;
    const user = h.get('x-meet-user') || '';
    const name = decodeURIComponent(h.get('x-meet-name') || '').slice(0, 48);
    const mustWait = h.get('x-meet-wait') === '1';
    const ticket = h.get('x-meet-ticket') || '';

    let st = await this.room();
    const everyone = this.all();
    const fresh = !st || !everyone.length;
    if (!st || fresh) {
      st = this.state = {
        cfg, locked: false,
        rec: false, live: 'off', sessionRow: '', peak: 0, kicked: [],
      };
    } else {
      st.cfg = cfg;
    }

    const refuse = (code: string, _status = 403) => refuseSocket(code);
    if (role === 'bot') {
      if (cfg.e2ee) return refuse('e_meet_forbidden');
    } else {
      if (user && st.kicked.includes(user)) return refuse('e_meet_kicked');
      if (ticket && st.kicked.includes(`t:${ticket}`)) return refuse('e_meet_kicked');
      // A ticket from the audience is a host's own say-so, so it opens a locked door. It does not
      // make a room out of nothing: somebody let up to speak is let up to speak to somebody.
      // 观众席上的入场券是主持人亲口答应的,所以它能打开上了锁的门。但它不能凭空造出一个房间:
      // 被请上台发言的人,是被请来对着某些人说话的。
      if (ticket && role === 'guest' && !this.seated().some((s) => s.who.role === 'host')) return refuse('e_meet_host_absent');
      if (st.locked && role !== 'host' && !ticket) return refuse('e_meet_locked');
      // The same ticket again -- a reload, a reconnect, a second tab: the newcomer takes the seat.
      // 同一张券又来了 —— 刷新、重连、另开一个标签页:座位归新来的那个。
      const replaced = ticket ? everyone.filter((s) => s.who.tk === ticket) : [];
      for (const s of replaced) {
        this.send(s.ws, { t: 'replaced' });
        try { s.ws.close(4009, 'replaced'); } catch { /* gone / 已走 */ }
      }
      if (mustWait) {
        if (everyone.filter((s) => s.who.waiting).length >= MAX_WAITING) return refuse('e_meet_full', 409);
      } else if (this.seated().filter((s) => !replaced.some((r) => r.ws === s.ws)).length >= cfg.max_people && role !== 'host') {
        return refuse('e_meet_full', 409);
      }
    }

    const who: Who = {
      peer: crypto.randomUUID().slice(0, 8),
      user, name, role, waiting: mustWait && role === 'guest',
      color: this.freeColour(everyone), mic: false, cam: false, hand: false, sid: '', psid: '', pub: {},
      ...(ticket ? { tk: ticket } : {}),
    };
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.keep(pair[1], who);

    if (who.waiting) {
      // At the door: told only that they are waiting, and the hosts are told somebody is.
      // 在门口:只被告知"正在等";同时告诉主持人"有人在等"。
      this.send(pair[1], { t: 'welcome', you: { peer: who.peer, role: who.role, waiting: true }, cfg: { title: cfg.title } });
      await this.save();
      this.announce(st);
    } else {
      await this.seat(pair[1], who, st, 'welcome');
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Bring somebody into the room proper: first time through the door, or let in from it.
   *  把某人真正带进房间:第一次进门,或是从门口被放进来。 */
  private async seat(ws: WebSocket, who: Who, st: RoomState, t: 'welcome' | 'admitted'): Promise<void> {
    if (who.role !== 'bot' && !st.sessionRow) {
      st.sessionRow = uid();
      await this.env.DB.prepare('INSERT INTO meeting_sessions (id, meeting_id, started_at) VALUES (?1,?2,?3)')
        .bind(st.sessionRow, st.cfg.id, now()).run().catch(() => {});
    }
    st.peak = Math.max(st.peak, this.seated().length);
    // The compositor has walked in: from here on what the room shows is what goes out.
    // 合成器进门了:从此刻起,房间里展示的就是播出去的。
    const onAir = who.role === 'bot' && st.live === 'starting';
    if (onAir) st.live = 'on';
    await this.save();
    // ...and the audience is told, so their pages start playing without having to ask.
    // ……并且告诉观众,让他们的页面不必去问就开始播放。
    if (onAir) await tellHall(this.env, st.cfg.id, 'live', { state: 'on' });
    const ice = await this.iceServers();
    const c = st.cfg;
    // Everybody in a broadcast meeting gets a pass to the audience's hall: the viewers' chat, and
    // for a host the queue of viewers asking to speak. The name on it is what strangers will see,
    // so an address is cut down to the part before the @.
    // 直播会议里的每个人都拿到一张去观众总台的后台证:观众的聊天,主持人还有申请发言的队列。
    // 证上的名字是陌生人会看到的,所以邮箱地址只留 @ 前面那段。
    let aud = '';
    if (c.kind === 'live' && who.role !== 'bot' && this.env.MEET_AUDIENCE && this.env.MEET_BOT_KEY) {
      aud = await signPaper(this.env, 'pass', { m: c.id, p: who.peer, r: who.role === 'host' ? 'host' : 'speaker', n: who.name.split('@')[0] }, PASS_TTL_MS).catch(() => '');
    }
    this.send(ws, {
      t,
      you: { peer: who.peer, role: who.role, waiting: false, color: who.color },
      cfg: { id: c.id, kind: c.kind, title: c.title, video: c.video, resolution: c.resolution, e2ee: c.e2ee, record_mode: c.record_mode, minutes: !!c.minutes, max_people: c.max_people, guest_key: who.role === 'bot' ? '' : c.guest_key || '' },
      ice,
      room: this.snapshot(st, who.role === 'host'),
      ...(aud ? { aud } : {}),
    });
    this.announce(st);
  }

  // ----- messages -----

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 256 * 1024) return;
    const who = ws.deserializeAttachment() as Who | null;
    if (!who) return;
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const t = String(m?.t || '');
    const st = await this.room();
    if (!st) return;

    if (t === 'bye') { try { ws.close(1000, 'bye'); } catch { /* already gone / 已经走了 */ } return; }
    // Somebody at the door has no voice in the room. / 门口的人在房间里没有发言权。
    if (who.waiting) return;
    if (who.role === 'bot' && !BOT_MAY.has(t)) return;
    if (HOST_ONLY.has(t) && who.role !== 'host') return;
    if (!HOST_ONLY.has(t) && !SEATED.has(t)) return;

    switch (t) {
      case 'sfu': return this.onSfu(ws, who, st, m);

      case 'state': {
        who.mic = !!m.mic;
        who.cam = !!m.cam && st.cfg.video;
        this.keep(ws, who);
        this.announce(st);
        return;
      }
      case 'hand': {
        who.hand = !!m.on;
        this.keep(ws, who);
        this.announce(st);
        return;
      }
      case 'chat': {
        const text = String(m.text ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, CHAT_MAX).trim();
        const at = now();
        if (!text || (who.lastChat && at - who.lastChat < CHAT_GAP_MS)) return;
        who.lastChat = at;
        this.keep(ws, who);
        // Not kept anywhere: a chat line is said to the people who are here, like ink on a
        // presented page. Somebody who arrives later missed it. / 哪儿都不留:一句聊天是说给在场的人听的,
        // 同演示页面上的笔迹一样。后来的人,就是错过了。
        const msg = JSON.stringify({ t: 'chat', from: who.peer, name: who.name, text, at });
        for (const s of this.seated()) { try { s.ws.send(msg); } catch { /* leaving / 正在离场 */ } }
        return;
      }

      // ----- hosts only from here / 以下仅主持人 -----
      case 'admit':
      case 'deny': {
        const target = this.all().find((s) => s.who.peer === String(m.peer || '') && s.who.waiting);
        if (!target) return;
        if (t === 'deny') {
          this.send(target.ws, { t: 'denied' });
          try { target.ws.close(4003, 'denied'); } catch { /* gone / 已走 */ }
          return;
        }
        if (this.seated().length >= st.cfg.max_people) { this.send(ws, { t: 'notice', code: 'e_meet_full' }); return; }
        target.who.waiting = false;
        this.keep(target.ws, target.who);
        await this.seat(target.ws, target.who, st, 'admitted');
        return;
      }
      case 'kick': {
        const target = this.seated().find((s) => s.who.peer === String(m.peer || ''));
        // A host is not removed by another host: that is a quarrel, and a button is a poor way
        // to have one. / 主持人不会被另一位主持人移出:那是一场争执,而按钮不是解决争执的好办法。
        if (!target || target.who.role === 'host') return;
        if (target.who.user && !st.kicked.includes(target.who.user)) st.kicked.push(target.who.user);
        // Somebody who came up from the audience does not come back on the same ticket.
        // 从观众席上来的人,不能凭同一张券再回来。
        if (target.who.tk && !st.kicked.includes(`t:${target.who.tk}`)) st.kicked.push(`t:${target.who.tk}`);
        await this.save();
        this.send(target.ws, { t: 'kicked' });
        try { target.ws.close(4001, 'kicked'); } catch { /* gone / 已走 */ }
        // Their pass to the audience's hall goes with them. / 他去观众总台的后台证也一并作废。
        if (st.cfg.kind === 'live') await tellHall(this.env, st.cfg.id, 'drop', { vid: `p:${target.who.peer}` });
        return;
      }
      case 'mute': {
        // A request, not a switch: the microphone is in somebody else's browser. What the room
        // can do is ask, and show everybody that it asked. / 这是请求,不是开关:麦克风在别人的浏览器里。
        // 房间能做的是提出请求,并让所有人看到它提过。
        const all = m.peer === 'all';
        for (const s of this.seated(ws)) {
          if (!all && s.who.peer !== String(m.peer || '')) continue;
          if (s.who.role === 'host' && all) continue;
          s.who.mic = false;
          this.keep(s.ws, s.who);
          this.send(s.ws, { t: 'muted' });
        }
        this.announce(st);
        return;
      }
      case 'screen_stop': {
        // The host asks; the browser that is sharing is the one that stops. / 主持人提出;真正停下来的,是正在共享的那个浏览器。
        const target = this.seated().find((s) => s.who.peer === String(m.peer || '') && s.who.pub?.screen);
        if (target) this.send(target.ws, { t: 'screen_stop' });
        return;
      }
      case 'lock': st.locked = !!m.on; await this.save(); this.announce(st); return;
      case 'rec': {
        if (st.cfg.e2ee && st.cfg.kind === 'live') return;
        // The switch the organiser left off is off for the hosts in the room too.
        // 组织者没打开的开关,对房间里的主持人同样是关着的。
        if (m.on && st.cfg.record_mode === 'off') { this.send(ws, { t: 'notice', code: 'e_meet_rec_off' }); return; }
        if (st.cfg.kind === 'group') {
          // A small meeting is recorded by one host's browser. Somebody else's switch neither
          // starts a second recording on top of it nor turns off a mark that is still true.
          // 小组会议由某一位主持人的浏览器录制。别人的开关既不会在它上面再叠一份录制,
          // 也关不掉一个仍然属实的标记。
          const holder = st.rec && st.recBy && this.all().some((s) => s.who.peer === st.recBy) ? st.recBy : '';
          if (holder && holder !== who.peer) { if (m.on) this.send(ws, { t: 'notice', code: 'e_meet_rec_busy' }); return; }
          st.recBy = m.on ? who.peer : '';
        }
        st.rec = !!m.on;
        await this.save();
        this.announce(st);
        return;
      }
      case 'live_start': {
        if (st.cfg.kind !== 'live' || st.live !== 'off') return;
        if (!meetLiveReady(this.env)) { this.send(ws, { t: 'notice', code: 'e_meet_live_unavailable' }); return; }
        st.live = 'starting';
        await this.save();
        this.announce(st);
        try {
          const target = await provisionLive(this.env, { code: st.cfg.code, title: st.cfg.title, session: st.sessionRow }, st.cfg.record_mode === 'stream');
          const order = launchOrder(st.cfg.origin || this.env.APP_ORIGIN, st.cfg.code, await botTicket(this.env, st.cfg.id), target, st.cfg.resolution);
          const how = await startCompositor(this.env, st.cfg.id, order);
          const now2 = await this.room();
          if (!now2) return;
          now2.liveUid = target.uid;
          now2.livePush = target.push;
          await this.ctx.storage.setAlarm(Date.now() + LIVE_CHECK_MS);
          await this.env.DB.prepare('UPDATE meeting_sessions SET live_input_uid=?1 WHERE id=?2').bind(target.uid, now2.sessionRow).run().catch(() => {});
          await this.save();
          // No container on this machine: the one who asked is handed the orders, to start it
          // by hand. Only ever reached in local development. / 这台机器上没有容器:把指令交给发起的人,
          // 由他手工启动。只会在本地开发时走到这里。
          if (how === 'manual') this.send(ws, { t: 'live_manual', order });
        } catch (e: any) {
          const again = await this.room();
          if (again) { again.live = 'off'; await this.save(); this.announce(again); }
          this.send(ws, { t: 'notice', code: e?.code || 'e_meet_live_failed' });
        }
        return;
      }
      case 'live_stop': {
        if (st.live === 'off') return;
        await this.endLive(st);
        await this.save();
        this.announce(st);
        return;
      }
      case 'end': {
        await this.endLive(st);
        await this.endAll('ended');
        if (!st.cfg.persistent) {
          await this.env.DB.prepare('UPDATE meetings SET ended_at=?1 WHERE id=?2 AND ended_at IS NULL')
            .bind(now(), st.cfg.id).run().catch(() => {});
        }
        if (st.cfg.kind === 'live') await tellHall(this.env, st.cfg.id, 'reset', { full: true, ended: !st.cfg.persistent });
        return;
      }
    }
  }


  // ----- negotiation, on somebody's behalf -----

  /** Change one seat's record, atomically: read it fresh, change it, write it back, with no
   *  `await` in between. Everything else in this class may use the copy it was handed, because
   *  nothing else waits on the network between reading and writing. Negotiation does -- and since
   *  a browser publishes and subscribes on two connections at once, two of these handlers run
   *  interleaved for the same socket. Each holding its own copy across an await, the later write
   *  would erase what the earlier one had stored: a session id, a published track.
   *  原子地改一个座位的记录:现读、现改、现写回,中间没有 `await`。本类其余各处可以用交到手里的那份副本,
   *  因为它们在读与写之间都不等网络。协商则不然 —— 而且浏览器是在两条连接上同时发布与订阅的,
   *  于是同一条 socket 会有两个这样的处理过程交错运行。各自攥着一份副本跨过 await,
   *  后写的那个就会抹掉先写的那个存下的东西:一个会话 id、一条已发布的轨道。 */
  private patch(ws: WebSocket, change: (w: Who) => void): Who | null {
    const w = ws.deserializeAttachment() as Who | null;
    if (!w) return null;
    change(w);
    this.keep(ws, w);
    return w;
  }

  private async onSfu(ws: WebSocket, _who: Who, st: RoomState, m: any): Promise<void> {
    const rid = m.rid;
    const ok = (extra: Record<string, unknown>) => this.send(ws, { t: 'sfu_ok', rid, ...extra });
    const fail = (code: string, detail?: unknown) => this.send(ws, { t: 'sfu_err', rid, code, detail });
    /** The record as it is NOW, not as it was when this message arrived. / 记录**此刻**的样子,不是这条消息到达时的样子。 */
    const cur = () => (ws.deserializeAttachment() as Who | null) || _who;
    try {
      const op = String(m.op || '');
      // A session is made at the moment it is first needed and not before. The SFU gives up on a
      // session whose connection is not established soon after it is created -- a person alone
      // in a room for a minute, with nothing to subscribe to, would otherwise be holding a
      // session that is already dead by the time somebody arrives.
      // 会话在第一次用到的那一刻才建,不提前。SFU 会放弃一个"建好之后迟迟没有建立连接"的会话 ——
      // 否则一个人独自在房间里待上一分钟、无人可订阅,等到有人来时,他手里的会话早就死了。
      const session = async (side: 'sub' | 'pub'): Promise<string> => {
        const have = side === 'sub' ? cur().sid : cur().psid;
        if (have) return have;
        const r = await this.sfu('POST', '/sessions/new');
        if (!r.body?.sessionId) throw new Error(String(r.body?.errorDescription || r.status));
        const id = String(r.body.sessionId);
        this.patch(ws, (w) => { if (side === 'sub') w.sid = id; else w.psid = id; });
        return id;
      };
      /** Forget one side's session, and with the publishing side everything it published.
       *  忘掉某一侧的会话;若是发布那一侧,连同它发布过的一切。 */
      const forget = async (side: 'sub' | 'pub'): Promise<boolean> => {
        if (side === 'sub') { this.patch(ws, (w) => { w.sid = ''; }); return false; }
        const had = Object.keys(cur().pub || {}).length > 0;
        this.patch(ws, (w) => { w.psid = ''; w.pub = {}; });
        return had;
      };

      if (op === 'session' || op === 'reset') {
        // A browser whose connection to the SFU died while its seat here did not. `session` with
        // `fresh` starts both sides over; `reset` starts one. What the old publishing session
        // sent is gone with it, and the room is told.
        // 这是这样一个浏览器:它与 SFU 的连接死了,而它在这里的座位还在。带 `fresh` 的 `session`
        // 让两侧都重来;`reset` 只重来一侧。旧的发布会话发过的东西随之作废,并告知房间。
        let changed = false;
        if (op === 'reset') changed = await forget(m.side === 'pub' ? 'pub' : 'sub');
        else if (m.fresh) { await forget('sub'); changed = await forget('pub'); }
        ok({});
        if (changed) this.announce(st);
        return;
      }

      if (op === 'push') {
        if (cur().role === 'bot') return fail('forbidden');
        const asked: { mid: string; kind: TrackKind }[] = (Array.isArray(m.tracks) ? m.tracks : [])
          .map((x: any) => ({ mid: String(x?.mid ?? ''), kind: String(x?.kind || '') as TrackKind }))
          .filter((x: any) => x.mid && TRACK_KINDS.has(x.kind));
        if (!asked.length || asked.length > 3 || typeof m.offer !== 'string') return fail('bad_request');
        let sharing = false;
        for (const a of asked) {
          if (a.kind !== 'mic' && !st.cfg.video) return fail('audio_only');
          if (a.kind !== 'screen') continue;
          // One screen at a time. Everybody is equal in this room except in this: two shared
          // screens are two things to look at and no way to say which one is being talked about.
          // 同一时刻只有一块屏幕。这间房里人人平等,唯独这一点除外:两块共享屏幕就是两样要看的东西,
          // 而且没法说清正在讲的是哪一块。
          const me = cur().peer;
          const other = this.seated().find((s) => s.who.peer !== me && s.who.pub?.screen);
          const held = st.screenBy && st.screenBy !== me && now() - (st.screenAt || 0) < SCREEN_HOLD_MS;
          if (other || held) return fail('screen_busy');
          st.screenBy = me;
          st.screenAt = now();
          sharing = true;
        }
        const named = asked.map((a) => ({ ...a, name: `${a.kind}-${crypto.randomUUID().slice(0, 6)}` }));
        const r = await this.sfu('POST', `/sessions/${await session('pub')}/tracks/new`, {
          sessionDescription: { type: 'offer', sdp: m.offer },
          tracks: named.map((a) => ({ location: 'local', mid: a.mid, trackName: a.name })),
        });
        // From here on, who is sharing is read off what people publish. / 从这里起,"谁在共享"由各人发布了什么来回答。
        if (sharing) st.screenBy = '';
        if (r.body?.errorCode || !r.body?.sessionDescription) return fail('sfu', r.body?.errorDescription || r.status);
        const results = named.map((a, i) => {
          const tr = (r.body.tracks || [])[i] || {};
          return { mid: a.mid, kind: a.kind, name: a.name, sfuMid: String(tr.mid ?? a.mid), error: tr.errorCode || null };
        });
        const answer = String(r.body.sessionDescription.sdp || '');
        this.patch(ws, (w) => { for (const x of results) if (!x.error) w.pub[x.kind] = [x.name, x.sfuMid, codecOf(answer, x.mid)]; });
        ok({ answer: r.body.sessionDescription.sdp, tracks: results.map((x) => ({ mid: x.mid, kind: x.kind, error: x.error })) });
        this.announce(st);
        return;
      }

      if (op === 'pull') {
        const asked: { peer: string; kind: TrackKind }[] = (Array.isArray(m.tracks) ? m.tracks : [])
          .map((x: any) => ({ peer: String(x?.peer || ''), kind: String(x?.kind || '') as TrackKind }))
          .filter((x: any) => x.peer && TRACK_KINDS.has(x.kind)).slice(0, 64);
        if (!asked.length) return fail('bad_request');
        // Resolved HERE, from what the room saw the SFU confirm. A client never names a session
        // or a track, so it cannot subscribe to anything outside this room -- the app is shared
        // by every meeting on the deployment. / 在**这里**解析,依据是房间亲眼看到 SFU 确认过的东西。
        // 客户端从不指名会话或轨道,所以它订阅不到这间房之外的任何东西 —— 同一个 app 由这套部署上的所有会议共用。
        const me = cur().peer;
        const peers = new Map(this.seated().map((s) => [s.who.peer, s.who]));
        const refs: { i: number; sessionId: string; trackName: string }[] = [];
        const results: any[] = asked.map((a) => ({ peer: a.peer, kind: a.kind, mid: null, error: 'gone' }));
        asked.forEach((a, i) => {
          const src = peers.get(a.peer);
          const p = src?.pub?.[a.kind];
          if (src?.psid && p && a.peer !== me) { refs.push({ i, sessionId: src.psid, trackName: p[0] }); results[i].codec = p[2] || ''; }
        });
        if (!refs.length) return ok({ tracks: results });
        const r = await this.sfu('POST', `/sessions/${await session('sub')}/tracks/new`, {
          tracks: refs.map((x) => ({ location: 'remote', sessionId: x.sessionId, trackName: x.trackName })),
        });
        if (r.body?.errorCode) return fail('sfu', r.body?.errorDescription || r.status);
        refs.forEach((x, k) => {
          const tr = (r.body.tracks || [])[k] || {};
          // The SFU says "not found" for a track whose publisher has negotiated but is not yet
          // sending. That is a matter of a few hundred milliseconds, so it is reported as
          // something to ask again for, not as something that failed. / 发布方已协商、但还没开始发包的轨道,
          // SFU 会答"找不到"。那只是几百毫秒的事,所以报成"稍后再要",而不是"失败了"。
          results[x.i].error = tr.errorCode ? (tr.errorCode === 'not_found_track_error' ? 'not_ready' : String(tr.errorCode)) : null;
          results[x.i].mid = tr.errorCode ? null : String(tr.mid ?? '');
        });
        const any = results.some((x) => x.mid);
        return ok({
          tracks: results,
          // An offer with nothing new in it is not worth a round of negotiation. / 里面没有任何新东西的 offer,不值得协商一轮。
          offer: any && r.body.requiresImmediateRenegotiation && r.body.sessionDescription ? r.body.sessionDescription.sdp : null,
        });
      }

      if (op === 'renegotiate') {
        if (typeof m.answer !== 'string') return fail('bad_request');
        const sid = cur().sid;
        if (!sid) return fail('no_session');
        const r = await this.sfu('PUT', `/sessions/${sid}/renegotiate`, { sessionDescription: { type: 'answer', sdp: m.answer } });
        if (r.body?.errorCode) return fail('sfu', r.body?.errorDescription || r.status);
        return ok({});
      }

      if (op === 'close') {
        const mids: string[] = (Array.isArray(m.mids) ? m.mids : []).map((x: any) => String(x)).filter(Boolean).slice(0, 64);
        if (!mids.length) return fail('bad_request');
        // Which connection the mids belong to. The same number names different things on the two.
        // 这些 mid 属于哪条连接。同一个编号在两条连接上指的是不同的东西。
        const own = m.side === 'pub';
        const target = own ? cur().psid : cur().sid;
        // Nothing to close on a side that never opened. / 从没打开过的那一侧,无可关闭。
        if (!target) return ok({ answer: null });
        const body: any = { tracks: mids.map((mid) => ({ mid })), force: typeof m.offer !== 'string' };
        if (typeof m.offer === 'string') body.sessionDescription = { type: 'offer', sdp: m.offer };
        const r = await this.sfu('PUT', `/sessions/${target}/tracks/close`, body);
        if (r.body?.errorCode) return fail('sfu', r.body?.errorDescription || r.status);
        let changed = false;
        if (own) {
          const after = this.patch(ws, (w) => {
            for (const k of Object.keys(w.pub) as TrackKind[]) {
              if (mids.includes(w.pub[k]![1])) { delete w.pub[k]; changed = true; }
            }
          });
          if (changed && after && !after.pub.screen && st.screenBy === after.peer) st.screenBy = '';
        }
        ok({ answer: r.body?.sessionDescription?.type === 'answer' ? r.body.sessionDescription.sdp : null });
        if (changed) this.announce(st);
        return;
      }

      return fail('bad_request');
    } catch (e) {
      fail('sfu', String((e as Error)?.message || e).slice(0, 200));
    }
  }

  // ----- leaving -----

  async webSocketClose(ws: WebSocket): Promise<void> { await this.leave(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { await this.leave(ws); }

  private async leave(ws: WebSocket): Promise<void> {
    const st = await this.room();
    const who = ws.deserializeAttachment() as Who | null;
    const rest = this.all(ws);
    if (st && who && st.screenBy === who.peer) st.screenBy = '';
    // The recording was their browser's; with them gone, nothing is recording.
    // 录制是他那个浏览器在做的;他走了,就没有东西在录了。
    if (st && who && st.rec && st.recBy === who.peer) { st.rec = false; st.recBy = ''; }
    // The compositor dropped out mid-broadcast. It comes back by itself; until it does, nothing
    // is going out, and the room says so. / 合成器在播出中途掉线了。它会自己回来;在那之前没有东西在播出,房间如实显示。
    if (st && who?.role === 'bot' && st.live === 'on') st.live = 'starting';
    const people = rest.filter((s) => !s.who.waiting && s.who.role !== 'bot');
    if (st && !people.length) {
      await this.endLive(st);
      // Nobody is left who is a person. The sitting is over; anybody still at the door is told
      // so, and a bot with nobody to film goes home. / 已经没有"人"了。这一场结束;
      // 还在门口的人被告知,没人可拍的机器人也该回去了。
      await this.closeSession(st);
      for (const s of rest) {
        this.send(s.ws, { t: 'ended', why: 'empty' });
        try { s.ws.close(1000, 'empty'); } catch { /* gone / 已走 */ }
      }
      // Nobody is left to let anybody up: the queue of people asking to speak is over too.
      // 已经没人能请谁上台了:申请发言的队列也就此作罢。
      if (st.cfg.kind === 'live') await tellHall(this.env, st.cfg.id, 'reset', { full: false });
      this.state = undefined;
      await this.ctx.storage.deleteAll().catch(() => {});
      return;
    }
    if (st) {
      await this.save();
      this.announce(st, ws);
    }
  }

  /** While a broadcast runs, the room looks in on its compositor once a minute. The looking-in
   *  is what keeps the container awake -- an instance nobody talks to is put to sleep, and a
   *  compositor talks to nobody -- and it is also how a compositor that died gets started again,
   *  on the same input, with a fresh ticket for the door.
   *  直播期间,房间每分钟去看一眼它的合成器。这一眼正是让容器保持清醒的东西 —— 没人搭理的实例会被休眠,
   *  而合成器不搭理任何人 —— 同时也是"死掉的合成器被重新启动"的途径:同一个 input,一张新的入场券。 */
  async alarm(): Promise<void> {
    const st = await this.room();
    if (!st || st.live === 'off' || !st.liveUid) return;
    try {
      const s = await compositorStatus(this.env, st.cfg.id);
      if (s && s.running === false && st.livePush) {
        console.log('meet compositor not running; starting it again', st.cfg.code, s.code);
        const order = launchOrder(st.cfg.origin || this.env.APP_ORIGIN, st.cfg.code, await botTicket(this.env, st.cfg.id), { uid: st.liveUid, push: st.livePush }, st.cfg.resolution);
        await startCompositor(this.env, st.cfg.id, order).catch(() => {});
      }
    } catch (e: any) {
      console.log('meet compositor check failed', String(e?.message || e).slice(0, 200));
    }
    await this.ctx.storage.setAlarm(Date.now() + LIVE_CHECK_MS);
  }

  /** Off the air: the compositor is told to stop, its seat is taken away, and the input it was
   *  pushing to is retired along with its key.
   *  停播:让合成器停下,收回它的座位,它所推向的 input 连同推流密钥一并作废。 */
  private async endLive(st: RoomState): Promise<void> {
    if (st.live === 'off' && !st.liveUid) return;
    st.live = 'off';
    const uid = st.liveUid || '';
    st.liveUid = '';
    st.livePush = '';
    await this.ctx.storage.deleteAlarm().catch(() => {});
    for (const s of this.all()) {
      if (s.who.role !== 'bot') continue;
      this.send(s.ws, { t: 'ended', why: 'live_stop' });
      try { s.ws.close(1000, 'live_stop'); } catch { /* gone / 已走 */ }
    }
    await stopCompositor(this.env, st.cfg.id).catch(() => {});
    await retireLive(this.env, uid).catch(() => {});
    if (st.sessionRow) await this.env.DB.prepare('UPDATE meeting_sessions SET live_input_uid=NULL WHERE id=?1').bind(st.sessionRow).run().catch(() => {});
    await tellHall(this.env, st.cfg.id, 'live', { state: 'off' });
  }

  private async closeSession(st: RoomState): Promise<void> {
    if (!st.sessionRow) return;
    await this.env.DB.prepare('UPDATE meeting_sessions SET ended_at=?1, peak_people=?2 WHERE id=?3 AND ended_at IS NULL')
      .bind(now(), st.peak, st.sessionRow).run().catch(() => {});
    st.sessionRow = '';
  }

  private async endAll(why: string): Promise<void> {
    const st = await this.room();
    // However the meeting ends -- from the room or from outside it -- a broadcast ends with it.
    // 不管会议是怎么结束的 —— 从房间里,还是从房间外 —— 直播都随之结束。
    if (st) await this.endLive(st).catch(() => {});
    for (const s of this.all()) {
      this.send(s.ws, { t: 'ended', why });
      try { s.ws.close(1000, why); } catch { /* gone / 已走 */ }
    }
    if (st) await this.closeSession(st);
    this.state = undefined;
    await this.ctx.storage.deleteAll().catch(() => {});
  }
}

// ---------- The signed-in side ----------
// ---------- 登录之后的一侧 ----------

export const meetApp = new Hono<Ctx>();
meetApp.use('*', requireAuth);
meetApp.use('*', async (c, next) => {
  if (!meetReady(c.env)) throw new HttpError(503, 'e_meet_unavailable');
  await next();
});

/** What the create dialog may offer this person. / 创建对话框可以向此人提供什么。 */
meetApp.get('/config', async (c) => {
  const list = await meetDomains(c, c.get('user'));
  if (!list.length) throw new HttpError(403, 'e_meet_unavailable');
  const d = list[0];
  return c.json({
    domain: d.name,
    max_group: d.meet_max_group, max_speakers: d.meet_max_speakers, max_resolution: d.meet_max_resolution,
    live: meetLiveReady(c.env) && !!d.meet_live_enabled,
    e2ee: MEET_E2EE_READY,
    minutes: aiAvailable(c.env),
  });
});

/** Mine, and the ones I was asked to. Over ones fall off after thirty days.
 *  我创建的,以及请了我的。已结束的三十天后不再列出。 */
meetApp.get('/', async (c) => {
  const user = c.get('user');
  const since = now() - 30 * 86400_000;
  const rows = await c.env.DB.prepare(
    `SELECT m.*, d.name AS domain_name,
            (SELECT COUNT(*) FROM meeting_sessions s WHERE s.meeting_id=m.id AND s.ended_at IS NULL) AS open_sessions
     FROM meetings m LEFT JOIN domains d ON d.id=m.domain_id
     WHERE (m.owner_id=?1 OR m.id IN (SELECT meeting_id FROM meeting_invitees WHERE user_id=?1 OR email=?2))
       AND (m.ended_at IS NULL OR m.ended_at > ?3)
     ORDER BY (m.ended_at IS NOT NULL), COALESCE(m.starts_at, m.created_at) DESC LIMIT 200`
  ).bind(user.id, normalizeAddr(user.email), since).all();
  return c.json({
    meetings: (rows.results || []).map((m: any) =>
      meetingJson(c.env, m.owner_id === user.id ? m : { ...m, guest_token: null }, m.domain_name, {
        mine: m.owner_id === user.id, in_progress: (m.open_sessions || 0) > 0,
      })),
  });
});

meetApp.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<any>().catch(() => ({}));
  const list = await meetDomains(c, user);
  if (!list.length) throw new HttpError(403, 'e_meet_unavailable');
  const caps = list[0];
  const kind: MeetKind = KINDS.has(body.kind) ? body.kind : 'group';
  if (kind === 'live' && !(meetLiveReady(c.env) && caps.meet_live_enabled)) throw new HttpError(400, 'e_meet_live_unavailable');
  const s = readSettings(body, caps, kind, c.env) as any;
  const id = uid();
  const guestMode: GuestMode = s.guest_mode || 'off';
  // A code that collides is drawn again; twelve characters make that a formality.
  // 撞了的短码就重抽;十二个字符让这件事只是走个形式。
  let code = newCode();
  for (let i = 0; i < 4 && (await c.env.DB.prepare('SELECT 1 FROM meetings WHERE code=?1').bind(code).first()); i++) code = newCode();
  await c.env.DB.prepare(
    `INSERT INTO meetings (id, code, owner_id, domain_id, kind, title, persistent, starts_at, duration_min, video, resolution,
       max_people, guest_mode, guest_token, e2ee, record_mode, drive_record, audience_access, audience_chat,
       audience_token, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`
  ).bind(
    id, code, user.id, caps.id, kind, s.title || '', s.persistent || 0, s.starts_at ?? null, s.duration_min ?? null,
    s.video ?? 1, s.resolution || Math.min(720, caps.meet_max_resolution),
    s.max_people || (kind === 'live' ? caps.meet_max_speakers : caps.meet_max_group),
    guestMode, guestMode === 'off' ? null : randomToken(18), s.e2ee || 0, s.record_mode || 'off', s.drive_record || 0,
    s.audience_access || 'link', s.audience_chat ?? 1, kind === 'live' ? randomToken(18) : null, now()
  ).run();
  await audit(c.env, user, 'meet.create', code, { kind, guest_mode: guestMode }, caps.id);
  const row = await c.env.DB.prepare('SELECT * FROM meetings WHERE id=?1').bind(id).first();
  return c.json({ meeting: meetingJson(c.env, row, caps.name, { mine: true, in_progress: false }) });
});

async function ownedMeeting(c: any, id: string): Promise<any> {
  const m: any = await c.env.DB.prepare(
    'SELECT m.*, d.name AS domain_name FROM meetings m LEFT JOIN domains d ON d.id=m.domain_id WHERE m.id=?1'
  ).bind(id).first();
  if (!m) throw new HttpError(404, 'e_meet_not_found');
  if (m.owner_id !== c.get('user').id) throw new HttpError(403, 'e_meet_forbidden');
  return m;
}

meetApp.get('/:id', async (c) => {
  const m = await ownedMeeting(c, c.req.param('id'));
  const inv = await c.env.DB.prepare('SELECT email, role FROM meeting_invitees WHERE meeting_id=?1 ORDER BY email').bind(m.id).all();
  return c.json({ meeting: meetingJson(c.env, m, m.domain_name, { mine: true, invitees: inv.results || [] }) });
});

meetApp.patch('/:id', async (c) => {
  const m = await ownedMeeting(c, c.req.param('id'));
  const body = await c.req.json<any>().catch(() => ({}));
  const caps: any = await c.env.DB.prepare(
    'SELECT id, name, meet_enabled, meet_live_enabled, meet_max_group, meet_max_speakers, meet_max_resolution FROM domains WHERE id=?1'
  ).bind(m.domain_id).first();
  if (!caps?.meet_enabled) throw new HttpError(403, 'e_meet_unavailable');
  const s = readSettings(body, caps, m.kind, c.env) as Record<string, any>;
  // Encryption cannot change under people who are in the room: half of them would be sending what
  // the other half cannot read. / 加密与否不能在有人在场时改变:否则一半人发的,另一半人读不了。
  if (s.e2ee !== undefined && !!s.e2ee !== !!m.e2ee) {
    const open: any = await c.env.DB.prepare('SELECT 1 FROM meeting_sessions WHERE meeting_id=?1 AND ended_at IS NULL LIMIT 1').bind(m.id).first();
    if (open) throw new HttpError(409, 'e_meet_e2ee_in_progress');
  }
  // Turning guests on needs a token to exist; turning them off keeps it, so that switching back
  // on gives out the same link rather than silently breaking the one already sent.
  // 打开访客需要有 token;关掉时保留它 —— 这样再打开时给出的还是同一条链接,而不是悄悄废掉已经发出去的那条。
  if (s.guest_mode && s.guest_mode !== 'off' && !m.guest_token) s.guest_token = randomToken(18);
  if (body.reset_guest_link) s.guest_token = randomToken(18);
  const keys = Object.keys(s);
  if (keys.length) {
    await c.env.DB.prepare(`UPDATE meetings SET ${keys.map((k, i) => `${k}=?${i + 1}`).join(', ')} WHERE id=?${keys.length + 1}`)
      .bind(...keys.map((k) => s[k]), m.id).run();
  }
  const row: any = await c.env.DB.prepare('SELECT * FROM meetings WHERE id=?1').bind(m.id).first();
  return c.json({ meeting: meetingJson(c.env, row, m.domain_name, { mine: true }) });
});

/** Ask people to the meeting: remember who was asked, and mail them. Asking the same person
 *  twice updates their role and mails them again -- a second invitation is a thing people send
 *  on purpose, the day before.
 *  请人来开会:记下请了谁,并给他们发邮件。对同一个人请两次,会更新他的角色并再发一封 ——
 *  第二封邀请是人们在开会前一天特意发的东西。 */
meetApp.post('/:id/invite', async (c) => {
  const user = c.get('user');
  const m = await ownedMeeting(c, c.req.param('id'));
  if (m.ended_at) throw new HttpError(410, 'e_meet_ended');
  const body = await c.req.json<any>().catch(() => ({}));
  const people = parseAddrList(String(body.emails || '')).slice(0, 50);
  if (!people.length) throw new HttpError(400, 'e_no_recipients');
  const role = body.role === 'cohost' ? 'cohost' : 'speaker';
  for (const p of people) {
    await c.env.DB.prepare(
      `INSERT INTO meeting_invitees (meeting_id, email, user_id, role) VALUES (?1,?2,?3,?4)
       ON CONFLICT(meeting_id, email) DO UPDATE SET user_id=?3, role=?4`
    ).bind(m.id, p.addr, await userIdForAddress(c.env, p.addr), role).run();
  }
  const base = meetOrigin(c.env, m.domain_name);
  const lang: any = await c.env.DB.prepare('SELECT lang FROM users WHERE id=?1').bind(user.id).first();
  const res = await sendInvitations(c.env, user, {
    meeting: m,
    link: `${base}/#/meet/${m.code}`,
    guestLink: m.guest_mode !== 'off' && m.guest_token ? `${base}/#/meet/${m.code}?k=${m.guest_token}` : null,
    people, note: String(body.note || '').slice(0, 2000), lang: String(lang?.lang || 'en'),
    mailboxId: body.mailbox_id ? String(body.mailbox_id) : undefined,
  });
  return c.json(res);
});

meetApp.delete('/:id/invitees/:email', async (c) => {
  const m = await ownedMeeting(c, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM meeting_invitees WHERE meeting_id=?1 AND email=?2')
    .bind(m.id, normalizeAddr(decodeURIComponent(c.req.param('email')))).run();
  return c.json({ ok: true });
});

/** Tell the room, if there is one, that it is over. / 如果房间还在,告诉它结束了。 */
async function endRoom(env: Env, meetingId: string): Promise<void> {
  const ns = env.MEET_ROOM;
  if (!ns) return;
  await ns.get(ns.idFromName(meetingId)).fetch('https://room/__end').catch(() => {});
}

meetApp.post('/:id/end', async (c) => {
  const m = await ownedMeeting(c, c.req.param('id'));
  await endRoom(c.env, m.id);
  if (!m.persistent) await c.env.DB.prepare('UPDATE meetings SET ended_at=?1 WHERE id=?2 AND ended_at IS NULL').bind(now(), m.id).run();
  if (m.kind === 'live') await tellHall(c.env, m.id, 'reset', { full: true, ended: !m.persistent });
  await audit(c.env, c.get('user'), 'meet.end', m.code, undefined, m.domain_id);
  return c.json({ ok: true });
});

meetApp.delete('/:id', async (c) => {
  const m = await ownedMeeting(c, c.req.param('id'));
  await endRoom(c.env, m.id);
  if (m.kind === 'live') await tellHall(c.env, m.id, 'reset', { full: true, ended: true });
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM meeting_recordings WHERE session_id IN (SELECT id FROM meeting_sessions WHERE meeting_id=?1)').bind(m.id),
    c.env.DB.prepare('DELETE FROM meeting_sessions WHERE meeting_id=?1').bind(m.id),
    c.env.DB.prepare('DELETE FROM meeting_invitees WHERE meeting_id=?1').bind(m.id),
    c.env.DB.prepare('DELETE FROM meetings WHERE id=?1').bind(m.id),
  ]);
  await audit(c.env, c.get('user'), 'meet.delete', m.code, undefined, m.domain_id);
  return c.json({ ok: true });
});

// ---------- The door ----------
// ---------- 门 ----------

/** Deliberately NOT behind requireAuth: a guest has no account. What somebody outside the sign-in
 *  may do is small and enumerated -- read the front of one meeting, knock on its door -- and each
 *  is rate-limited on its own.
 *  刻意不挂在 requireAuth 之后:访客没有账号。登录之外的人能做的事很少且可数 ——
 *  读一场会议的门面、敲它的门 —— 每一件各自限速。 */
export const meetPubApp = new Hono<Ctx>();

async function meetingByCode(c: any, code: string): Promise<any> {
  if (!meetReady(c.env)) throw new HttpError(503, 'e_meet_unavailable');
  const k = String(code || '').toLowerCase();
  if (!CODE_RE.test(k)) throw new HttpError(404, 'e_meet_not_found');
  const m: any = await c.env.DB.prepare(
    `SELECT m.*, d.name AS domain_name, d.meet_enabled AS dom_on, u.name AS owner_name, u.email AS owner_email
     FROM meetings m LEFT JOIN domains d ON d.id=m.domain_id LEFT JOIN users u ON u.id=m.owner_id WHERE m.code=?1`
  ).bind(k).first();
  if (!m || !m.dom_on) throw new HttpError(404, 'e_meet_not_found');
  return m;
}

// ----- watching / 旁观 -----

/** How often one address may knock on each of the watching doors, per meeting and per hour. An
 *  office of several hundred people behind one address all opening the page as the broadcast
 *  starts is the case this is sized for; a flood from one address still runs into it.
 *  同一个地址每小时、每场会议能敲旁观的每一扇门多少次。按"几百人的办公室共用一个出口地址、开播时一起打开页面"来定;
 *  从一个地址来的洪水照样会撞上它。 */
const AUD_IP_HOURLY = 3000;

/** Whether viewers can talk and ask to speak here: the audience's objects exist, and there is a
 *  key to sign their papers with. / 观众在这里能不能说话、申请发言:观众的对象在,且有给凭证签名的钥匙。 */
function audienceReady(env: Env): boolean {
  return !!(env.MEET_AUDIENCE && env.MEET_BOT_KEY);
}

/** A signed-in viewer's name as strangers will see it: the display name, or failing that the part
 *  of the address before the @ -- a public broadcast does not show whole addresses around.
 *  已登录观众给陌生人看的名字:显示名;没有就取地址 @ 前面那段 —— 公开的直播不到处亮完整地址。 */
function audienceName(user: User): string {
  return user.name || String(user.email || '').split('@')[0];
}

/** The sitting that is on air right now, if any. / 此刻正在播出的那一场(如果有)。 */
async function onAir(env: Env, meetingId: string): Promise<string> {
  const row: any = await env.DB.prepare(
    'SELECT live_input_uid FROM meeting_sessions WHERE meeting_id=?1 AND ended_at IS NULL AND live_input_uid IS NOT NULL ORDER BY started_at DESC LIMIT 1'
  ).bind(meetingId).first();
  return String(row?.live_input_uid || '');
}

/** The front of a broadcast: what the watching page needs before it has anything to play.
 *  一场直播的门面:旁观页在有东西可播之前所需要的信息。 */
meetPubApp.get('/live/:code', async (c) => {
  const code = c.req.param('code');
  if (!(await allow(c.env, await ipKey('lf', code, clientIp(c)), AUD_IP_HOURLY, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
  const m = await meetingByCode(c, code);
  if (m.kind !== 'live') throw new HttpError(404, 'e_meet_not_found');
  const user = await userFromRequest(c);
  return c.json({
    title: m.title || '', host: m.owner_name || '', ended: !!m.ended_at, access: m.audience_access || 'link',
    signed_in: !!user, on_air: !m.ended_at && !!(await onAir(c.env, m.id)),
    chat: !!m.audience_chat, interactive: audienceReady(c.env),
  });
});

/** An address to play, for somebody allowed to watch. Asked for again by the page before it
 *  runs out. / 给一个获准观看的人一个可播放的地址。页面会在它到期之前再来要一次。 */
meetPubApp.post('/live/:code/token', async (c) => {
  const code = c.req.param('code');
  if (!(await allow(c.env, await ipKey('lt', code, clientIp(c)), AUD_IP_HOURLY, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
  const m = await meetingByCode(c, code);
  if (m.kind !== 'live' || m.ended_at) throw new HttpError(404, 'e_meet_not_found');
  if ((m.audience_access || 'link') === 'signin' && !(await userFromRequest(c))) throw new HttpError(401, 'e_meet_signin_required');
  const uid = await onAir(c.env, m.id);
  if (!uid) return c.json({ on_air: false });
  return c.json({ on_air: true, hls: await playbackUrl(c.env, uid, m.code), ttl: PLAY_TTL_SEC });
});

/** A viewer who is not signed in gives a name, once, and passes Turnstile, once; what comes back
 *  is a card to show on every reconnect after. / 未登录的观众留一次名字、过一次 Turnstile;
 *  换回来的是一张卡,之后每次重连出示它即可。 */
meetPubApp.post('/live/:code/name', async (c) => {
  const code = c.req.param('code');
  const ip = clientIp(c);
  if (!(await allow(c.env, await ipKey('ln', code, ip), 300, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
  if (!audienceReady(c.env)) throw new HttpError(503, 'e_meet_live_unavailable');
  const m = await meetingByCode(c, code);
  if (m.kind !== 'live' || m.ended_at) throw new HttpError(404, 'e_meet_not_found');
  if ((m.audience_access || 'link') === 'signin') throw new HttpError(401, 'e_meet_signin_required');
  const body = await c.req.json<any>().catch(() => ({}));
  const vid = String(body.vid || '');
  if (!VID_RE.test(vid)) throw new HttpError(400, 'e_bad_request');
  const name = cleanName(body.name);
  if (!name) throw new HttpError(400, 'e_meet_name_required');
  if (!(await verifyTurnstile(c.env, body.ts, ip))) throw new HttpError(403, 'e_captcha');
  return c.json({ card: await signPaper(c.env, 'aud', { m: m.id, v: vid, n: name }, CARD_TTL_MS), name });
});

/** A seat in the audience: the chat, the queue to speak, the count, and word of the broadcast
 *  starting and stopping. The people in the room come here too, holding the pass the room gave
 *  them. / 观众席上的一个座位:聊天、申请发言的队列、在看人数,以及开播、停播的消息。
 *  房间里的人也从这里来,手里拿着房间给的后台证。 */
meetPubApp.get('/live/:code/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') throw new HttpError(426, 'e_bad_request');
  try {
    return await openAudience(c);
  } catch (e) {
    if (e instanceof HttpError) return refuseSocket(e.message, e.args);
    throw e;
  }
});

async function openAudience(c: any): Promise<Response> {
  if (!audienceReady(c.env)) throw new HttpError(503, 'e_meet_live_unavailable');
  const code = c.req.param('code');
  if (!(await allow(c.env, await ipKey('lw', code, clientIp(c)), AUD_IP_HOURLY, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
  const m = await meetingByCode(c, code);
  if (m.kind !== 'live') throw new HttpError(404, 'e_meet_not_found');
  if (m.ended_at) throw new HttpError(410, 'e_meet_ended');
  const chat = !!m.audience_chat;
  let who: AudWho;
  let shard: number;
  const pass = c.req.query('pass');
  if (pass) {
    // Somebody in the room; the pass the room gave them says who. / 房间里的人;房间给的后台证说明他是谁。
    const p = await readPaper(c.env, 'pass', pass);
    if (!p || p.m !== m.id) throw new HttpError(403, 'e_meet_forbidden');
    who = { vid: `p:${String(p.p)}`, name: cleanName(p.n) || '?', uid: '', badge: p.r === 'host' ? 'host' : 'speaker', m: m.id, chat };
    shard = 0;
  } else {
    const user = await userFromRequest(c);
    if ((m.audience_access || 'link') === 'signin' && !user) throw new HttpError(401, 'e_meet_signin_required');
    // A card, if they have one, says who they are -- its viewer id included, so a name cannot be
    // borrowed by pairing somebody's card with another id. / 有卡就由卡说明他是谁 —— 连观众 id 一起,
    // 于是没法把别人的卡配上另一个 id 来借用名字。
    const card = !user && c.req.query('who') ? await readPaper(c.env, 'aud', c.req.query('who')) : null;
    const own = card && card.m === m.id ? card : null;
    const vid = own ? String(own.v) : String(c.req.query('vid') || '');
    if (!VID_RE.test(vid)) throw new HttpError(400, 'e_bad_request');
    who = user
      ? { vid, name: cleanName(audienceName(user)) || '?', uid: user.id, badge: 'user', m: m.id, chat }
      : { vid, name: own ? cleanName(own.n) : '', uid: '', badge: 'guest', m: m.id, chat };
    shard = viewerShard(vid);
  }
  // Overwritten unconditionally, like the room's own headers. / 与房间自己的那几个 header 一样,无条件覆写。
  const h = new Headers(c.req.raw.headers);
  h.set('x-aud-who', encodeURIComponent(JSON.stringify(who)));
  h.set('x-aud-shard', String(shard));
  return audienceStub(c.env, m.id, shard).fetch(new Request(c.req.raw.url, { method: 'GET', headers: h }));
}

/** The front of a meeting: enough to draw the page that asks for a name, and nothing about who
 *  is inside. / 会议的门面:够画出那张问名字的页面,不含任何"谁在里面"的信息。 */
meetPubApp.get('/:code', async (c) => {
  const code = c.req.param('code');
  if (!(await allow(c.env, await ipKey('f', code, clientIp(c)), 120, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
  const m = await meetingByCode(c, code);
  const user = await userFromRequest(c);
  return c.json({
    title: m.title, kind: m.kind, host: m.owner_name || '', video: !!m.video, e2ee: !!m.e2ee,
    starts_at: m.starts_at, ended: !!m.ended_at, guest_mode: m.guest_mode,
    signed_in: !!user, mine: !!user && user.id === m.owner_id,
  });
});

meetPubApp.get('/:code/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') throw new HttpError(426, 'e_bad_request');
  try {
    return await openDoor(c);
  } catch (e) {
    if (e instanceof HttpError) return refuseSocket(e.message, e.args);
    throw e;
  }
});

async function openDoor(c: any): Promise<Response> {
  const m = await meetingByCode(c, c.req.param('code'));
  if (m.ended_at) throw new HttpError(410, 'e_meet_ended');

  // A signed-in visitor is judged as themselves even when they arrived holding a guest link.
  // 已登录的访问者按他自己判定,哪怕他是持着访客链接来的。
  const user = await userFromRequest(c);
  // A speaker's ticket from the audience: a host said yes to this one person. Somebody signed in
  // as a different account than the one that asked is not that person.
  // 观众席上拿到的发言入场券:主持人对这一个人说了"好"。登录的账号与申请时不是同一个的,就不是那个人。
  const paper = c.req.query('st') ? await readPaper(c.env, 'spk', c.req.query('st')) : null;
  const ticket = paper && paper.m === m.id && (!user || !paper.u || paper.u === user.id) ? paper : null;
  let role: Role;
  let name: string;
  let wait = false;
  const bot = c.req.query('bot');
  if (bot) {
    if (!(await botTicketOk(c.env, m.id, bot))) throw new HttpError(403, 'e_meet_forbidden');
    role = 'bot';
    name = 'bot';
  } else if (user) {
    const inv: any = user.id === m.owner_id ? null : await c.env.DB.prepare(
      'SELECT role FROM meeting_invitees WHERE meeting_id=?1 AND (user_id=?2 OR email=?3)'
    ).bind(m.id, user.id, normalizeAddr(user.email)).first();
    role = user.id === m.owner_id || inv?.role === 'cohost' ? 'host' : 'member';
    name = user.name || user.email;
  } else if (ticket) {
    // Let in on a host's own say-so: no guest link, no waiting room, no Turnstile. The name is the
    // one they gave in the audience -- the one the host said yes to.
    // 凭主持人亲口答应进来:不要访客链接、不进等候室、不过 Turnstile。名字是他在观众席上留的那个 —— 主持人答应的正是它。
    if (!(await allow(c.env, await ipKey('g', m.id, clientIp(c)), 40, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
    role = 'guest';
    name = cleanName(ticket.n) || 'guest';
  } else {
    if (m.guest_mode === 'off') throw new HttpError(401, 'e_meet_signin_required');
    const ip = clientIp(c);
    if (!(await allow(c.env, await ipKey('g', m.id, ip), 40, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
    if (!m.guest_token || c.req.query('k') !== m.guest_token) throw new HttpError(403, 'e_meet_bad_guest_link');
    if (!(await verifyTurnstile(c.env, c.req.query('ts'), ip))) throw new HttpError(403, 'e_captcha');
    // Control characters would travel intact and land in somebody's roster as a broken line.
    // 控制字符会一路完好地抵达,然后以一行断掉的名册落在别人屏幕上。
    name = String(c.req.query('name') || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 32);
    if (!name) throw new HttpError(400, 'e_meet_name_required');
    role = 'guest';
    wait = m.guest_mode === 'lobby';
  }

  const ns = c.env.MEET_ROOM!;
  const stub = ns.get(ns.idFromName(m.id));
  const cfg: Cfg = {
    id: m.id, code: m.code, kind: m.kind, title: m.title, owner: m.owner_id, video: !!m.video,
    resolution: m.resolution, max_people: m.max_people, e2ee: !!m.e2ee, record_mode: m.record_mode,
    minutes: aiAvailable(c.env) && !m.e2ee, persistent: !!m.persistent,
    origin: meetOrigin(c.env, m.domain_name),
    guest_key: m.guest_mode !== 'off' && m.guest_token ? String(m.guest_token) : '',
  };
  // Every one of these is overwritten unconditionally, so a client that sends its own copies is
  // sending them to be discarded. / 每一个都被无条件覆写,所以自带这几个 header 的客户端,只是把它们送去被丢掉。
  const h = new Headers(c.req.raw.headers);
  h.set('x-meet-cfg', encodeURIComponent(JSON.stringify(cfg)));
  h.set('x-meet-role', role);
  h.set('x-meet-user', user?.id || '');
  h.set('x-meet-name', encodeURIComponent(name));
  h.set('x-meet-wait', wait ? '1' : '0');
  h.set('x-meet-ticket', ticket && role !== 'bot' ? String(ticket.v) : '');

  return stub.fetch(new Request(c.req.raw.url, { method: 'GET', headers: h }));
}

// ---------- Admin API (/api/admin/meet) ----------
// ---------- 管理端 API(/api/admin/meet) ----------

export const meetAdminApp = new Hono<Ctx>();

meetAdminApp.get('/domains', async (c) => {
  const scope = await adminScope(c);
  const rows = await c.env.DB.prepare(
    'SELECT id, name, meet_enabled, meet_live_enabled, meet_max_group, meet_max_speakers, meet_max_resolution FROM domains ORDER BY name'
  ).all();
  let list = (rows.results || []) as any[];
  if (scope) list = list.filter((d) => scope.has(d.id));
  return c.json({ domains: list, ready: meetReady(c.env), live_ready: meetLiveReady(c.env), hard_cap_group: HARD_CAP_GROUP, hard_cap_speakers: HARD_CAP_SPEAKERS });
});

/** What an administrator may raise the ceilings to. Above these the design stops being the one
 *  that was tested: a page of the gallery is sixteen, and the compositor lays out eight.
 *  管理员最多能把上限调到多少。超过这些数,设计就不再是被验证过的那个:画廊一页是十六格,
 *  而合成器排的是八格。 */
const HARD_CAP_GROUP = 64;
const HARD_CAP_SPEAKERS = 8;

meetAdminApp.post('/domains/:id', async (c) => {
  const id = c.req.param('id');
  await checkDomainScope(c, id);
  const body = await c.req.json<any>().catch(() => ({}));
  const sets: string[] = [];
  const vals: any[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col}=?${vals.length + 1}`); vals.push(v); };
  const int = (v: unknown, lo: number, hi: number, f: string) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, 'e_meet_bad_field', f);
    return n;
  };
  if (body.enabled !== undefined) put('meet_enabled', body.enabled ? 1 : 0);
  if (body.live_enabled !== undefined) put('meet_live_enabled', body.live_enabled ? 1 : 0);
  if (body.max_group !== undefined) put('meet_max_group', int(body.max_group, 2, HARD_CAP_GROUP, 'max_group'));
  if (body.max_speakers !== undefined) put('meet_max_speakers', int(body.max_speakers, 2, HARD_CAP_SPEAKERS, 'max_speakers'));
  if (body.max_resolution !== undefined) {
    if (!RESOLUTIONS.includes(Number(body.max_resolution))) throw new HttpError(400, 'e_meet_bad_field', 'max_resolution');
    put('meet_max_resolution', Number(body.max_resolution));
  }
  if (sets.length) {
    vals.push(id);
    await c.env.DB.prepare(`UPDATE domains SET ${sets.join(',')} WHERE id=?${vals.length}`).bind(...vals).run();
    await audit(c.env, c.get('user'), 'meet.settings', undefined, body, id);
  }
  return c.json({ ok: true });
});

// ---------- Housekeeping ----------
// ---------- 打扫 ----------

/** Hourly. A meeting that was never ended by hand is ended once it is well past; a sitting whose
 *  room vanished without saying goodbye (a deploy, a crash) is closed so it stops reading as
 *  "in progress". / 每小时。从未被手动结束的会议,过期很久之后替它结束;房间不辞而别(一次部署、一次崩溃)
 *  留下的那一场,替它关上,免得一直显示"进行中"。 */
export async function meetCronHourly(env: Env): Promise<void> {
  const t = now();
  await env.DB.prepare(
    'UPDATE meeting_sessions SET ended_at=?1 WHERE ended_at IS NULL AND started_at < ?2'
  ).bind(t, t - 24 * 3600 * 1000).run().catch(() => {});
  await env.DB.prepare(
    `UPDATE meetings SET ended_at=?1
     WHERE ended_at IS NULL AND persistent=0
       AND COALESCE(starts_at, created_at) + COALESCE(duration_min, 60) * 60000 < ?2
       AND NOT EXISTS (SELECT 1 FROM meeting_sessions s WHERE s.meeting_id=meetings.id AND s.ended_at IS NULL)`
  ).bind(t, t - 48 * 3600 * 1000).run().catch(() => {});
  await sweepLive(env).catch((e) => console.log('meet live sweep failed', String(e?.message || e).slice(0, 200)));
}

void isEmail;
