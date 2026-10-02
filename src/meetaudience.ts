// The audience of a broadcast meeting: what they say, who wants to speak, how many are watching.
//
// The people watching a broadcast are not in the room. They may be thousands, and a room that
// had to tell each of them about every line of chat would spend its time doing that instead of
// the one thing only it can do, which is negotiate with the SFU. So the audience has objects of
// its own, four per meeting:
//
//   the hall     `<meeting id>:0`. Only the people in the room connect here -- hosts and
//                speakers, holding a pass the room gave them. It numbers every line said, keeps
//                the last fifty, holds the queue of people asking to speak, knows who has been
//                silenced, and adds up how many are watching.
//   the shards   `<meeting id>:1..3`. Every viewer lands on one of them by a hash of their viewer
//                id. A shard checks what its viewers say (a name, the chat switch, their own
//                pace), passes it to the hall, and hands on what the hall sends out.
//
// A line of chat therefore costs about four requests between objects however many are
// watching, and each shard carries a third of the crowd. Sockets hibernate: a viewer who is only
// watching costs nothing between lines.
//
// WHO SOMEBODY IS
// Decided at the door by the Worker and written on the socket; nothing a client says later can
// change it. A signed-in viewer is their account. A viewer who is not signed in may watch without
// a name, and to say anything or ask to speak must first give one and pass Turnstile, for which
// the Worker hands back a card -- viewer id and name, signed -- that every reconnect then shows.
// Their name is marked as a guest's: it is self-declared, and anybody can call themselves "Host".
//
// THE PAPERS
// Three kinds, all "payload + HMAC" under the key the compositor's ticket is signed with, each
// signed under its own prefix so that none can pass for another:
//   pass   the room gives one to everybody seated in a broadcast meeting: this is how the room's
//          page connects to the hall, and why its lines carry "host" or "speaker"
//   aud    a viewer who is not signed in, named and past Turnstile
//   spk    the hall gives one to a single viewer when a host lets them speak: with it the door of
//          the room lets them in without a guest link, the waiting room or Turnstile
//
// 一场直播会议的观众:他们说了什么、谁想发言、多少人在看。
//
// 看直播的人不在房间里。他们可能有几千人,而一个要把每句聊天都转告给每一个人的房间,就会把时间花在这件事上,
// 而不是只有它才能做的那件事 —— 与 SFU 协商。所以观众有自己的对象,每场会议四个:
//
//   总台   `<会议 id>:0`。只有房间里的人连到这里 —— 主持人和发言人,凭房间给的后台证。
//          它给每一句话编号、留最近五十句、管着申请发言的队列、记着谁被禁言、汇总在看人数。
//   分片   `<会议 id>:1..3`。每个观众按自己观众 id 的哈希落到其中一个。分片检查它的观众说的话
//          (有没有名字、聊天开没开、说得是不是太快),交给总台,并把总台发出来的东西转给自己的观众。
//
// 于是一句聊天,不论多少人在看,都只花大约四次对象间的请求;每个分片扛三分之一的人。
// socket 一律休眠:只看不说的观众,两句话之间什么都不花。
//
// 谁是谁
// 在门口由 Worker 判定并写在 socket 上;客户端之后说什么都改不了它。已登录的观众就是他的账号。
// 未登录的观众可以不留名只看;要说话或申请发言,得先留个名字并过 Turnstile,Worker 为此回一张卡
// —— 观众 id 加名字,签过名 —— 之后每次重连都出示它。他的名字标着「访客」:那是自报的,谁都可以叫自己"主持人"。
//
// 凭证
// 三种,都是"载荷 + HMAC",用给合成器入场券签名的同一把钥匙,各带自己的前缀签名,于是谁也冒充不了谁:
//   pass   房间发给直播会议里入座的每个人:房间页凭它连到总台,它说的话也因此带着「主持人」「发言人」
//   aud    未登录、留了名、过了 Turnstile 的观众
//   spk    主持人让某位观众发言时,总台只发给这一个人:凭它,房间的门不要访客链接、不进等候室、不过 Turnstile
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import { b64decode, b64url, now } from './util';

/** One hall and three shards for viewers. A constant: a meeting cannot move its viewers between
 *  shards while they are connected, so the number is decided once, here.
 *  一个总台加三个观众分片。是常量:观众连着的时候没法在分片之间搬家,所以这个数只在这里定一次。 */
export const AUD_SHARDS = 4;

const HIST = 50;
const TEXT_MAX = 500;
export const AUD_NAME_MAX = 32;
const HANDS_MAX = 200;
/** A viewer may say three things at once and then one every three seconds; somebody in the room,
 *  ten and then two a second. / 观众起手可以连说三句,之后每三秒一句;台上的人起手十句,之后每秒两句。 */
const VIEWER = { burst: 3, everyMs: 3000 };
const STAFF = { burst: 10, everyMs: 500 };
/** All viewers together: twenty at once, then five a second. / 全体观众合计:起手二十句,之后每秒五句。 */
const CROWD = { burst: 20, everyMs: 200 };
const COUNT_DELAY_MS = 2000;
const IDLE_MS = 6 * 3600 * 1000;
export const PASS_TTL_MS = 12 * 3600 * 1000;
export const CARD_TTL_MS = 24 * 3600 * 1000;
export const TICKET_TTL_MS = 4 * 3600 * 1000;

export type Badge = 'host' | 'speaker' | 'user' | 'guest';

/** Who a socket is, as the Worker decided at the door. / 一条 socket 是谁 —— 由 Worker 在门口判定。 */
export interface AudWho {
  /** A viewer's id, or `p:<seat>` for somebody in the room. / 观众 id;房间里的人是 `p:<座位号>`。 */
  vid: string;
  /** Empty until a viewer who is not signed in gives one. / 未登录的观众留名之前为空。 */
  name: string;
  uid: string;
  badge: Badge;
  /** The meeting. / 会议 id。 */
  m: string;
  /** Whether the organiser let viewers chat. / 组织者是否允许观众聊天。 */
  chat: boolean;
}

/** What is kept on a socket. / socket 上存着的东西。 */
interface Seat extends AudWho {
  sh: number;
  hand: boolean;
  /** Its own pace: tokens left, and when they were counted. / 它自己的节奏:剩几个令牌、何时数的。 */
  tk: number;
  at: number;
}

interface Line { id: number; at: number; name: string; badge: Badge; text: string; vid: string; uid: string }
interface Ask { vid: string; name: string; badge: Badge; uid: string; shard: number; at: number; invited?: number }

/** Everything the hall keeps. / 总台留着的全部。 */
interface Hall {
  m: string;
  seq: number;
  hist: Line[];
  hands: Ask[];
  counts: Record<string, number>;
  /** `v:<viewer id>` or `u:<account>`. / 被禁言的人。 */
  blocked: string[];
  /** Passes of people removed from the room. / 被请出房间的人的后台证。 */
  revoked: string[];
  live: '' | 'on' | 'off';
  touched: number;
  /** The total last sent out. / 上一次广播出去的总数。 */
  shown: number;
}

const HALL_KEYS: (keyof Hall)[] = ['m', 'seq', 'hist', 'hands', 'counts', 'blocked', 'revoked', 'live', 'touched', 'shown'];

// ---------- The papers ----------
// ---------- 凭证 ----------

export type PaperKind = 'pass' | 'aud' | 'spk';
const enc = new TextEncoder();

async function mac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg))));
}

export async function signPaper(env: Env, kind: PaperKind, body: Record<string, unknown>, ttlMs: number): Promise<string> {
  if (!env.MEET_BOT_KEY) throw new Error('no MEET_BOT_KEY');
  const payload = b64url(enc.encode(JSON.stringify({ ...body, e: now() + ttlMs })));
  return `${payload}.${await mac(env.MEET_BOT_KEY, `${kind}.${payload}`)}`;
}

/** The payload, or null for anything forged, of another kind, or out of date.
 *  返回载荷;伪造的、别的种类的、过期的一律为 null。 */
export async function readPaper(env: Env, kind: PaperKind, paper: unknown): Promise<any | null> {
  const s = String(paper || '');
  if (!env.MEET_BOT_KEY || !s || s.length > 2048) return null;
  const dot = s.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = s.slice(0, dot);
  const want = await mac(env.MEET_BOT_KEY, `${kind}.${payload}`);
  const got = s.slice(dot + 1);
  // Equal lengths, compared to the end whatever they hold. / 等长,不论内容都比到最后一位。
  if (want.length !== got.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff) return null;
  try {
    const std = payload.replace(/-/g, '+').replace(/_/g, '/');
    const body = JSON.parse(new TextDecoder().decode(b64decode(std + '='.repeat((4 - (std.length % 4)) % 4))));
    return body && typeof body === 'object' && Number(body.e) > now() ? body : null;
  } catch {
    return null;
  }
}

// ---------- Where people go ----------
// ---------- 人落在哪 ----------

export const VID_RE = /^[A-Za-z0-9_-]{8,40}$/;

/** A viewer's shard: FNV-1a of their id, over shards 1..3. / 观众落在哪个分片:对 id 做 FNV-1a,落到 1..3。 */
export function viewerShard(vid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < vid.length; i++) { h ^= vid.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 1 + (h % (AUD_SHARDS - 1));
}

export function audienceStub(env: Env, meetingId: string, shard: number) {
  const ns = env.MEET_AUDIENCE!;
  return ns.get(ns.idFromName(`${meetingId}:${shard}`));
}

/** Tell the hall something from the room or from the Worker. Never throws: the audience is a
 *  courtesy the room extends, and it must not be able to break the room.
 *  从房间或 Worker 告诉总台一件事。从不抛错:观众是房间顺带的礼数,不能让它弄坏房间。 */
export async function tellHall(env: Env, meetingId: string, op: string, body: Record<string, unknown> = {}): Promise<void> {
  if (!env.MEET_AUDIENCE) return;
  try {
    await audienceStub(env, meetingId, 0).fetch(`https://aud/h/${op}`, { method: 'POST', body: JSON.stringify({ ...body, m: meetingId }) });
  } catch (e: any) {
    console.log('meet audience: could not tell the hall', op, String(e?.message || e).slice(0, 200));
  }
}

/** A name as it may appear to strangers: no control or direction-changing characters, no longer
 *  than a name. / 可以给陌生人看的名字:没有控制字符和改变书写方向的字符,不比名字长。 */
export function cleanName(s: unknown): string {
  return String(s ?? '').replace(/\p{Bidi_Control}/gu, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, AUD_NAME_MAX);
}

function cleanText(s: unknown): string {
  return String(s ?? '').replace(/\p{Bidi_Control}/gu, '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, TEXT_MAX);
}

/** What the hall answers. / 总台的回答。 */
type Reply = { ok?: boolean; error?: string; [k: string]: unknown };

const isStaff = (b: Badge) => b === 'host' || b === 'speaker';
const pub = (l: Line) => ({ id: l.id, at: l.at, name: l.name, badge: l.badge, text: l.text });
const askPub = (a: Ask) => ({ vid: a.vid, name: a.name, badge: a.badge, at: a.at, invited: !!a.invited });

function refuse(code: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  try {
    pair[1].send(JSON.stringify({ t: 'refused', error: code, args: [] }));
    pair[1].close(4400, code.slice(0, 100));
  } catch { /* the other end already gave up / 对端已经放弃 */ }
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export class MeetAudience extends DurableObject<Env> {
  /** The hall's record, read once per wake. / 总台的记录,每次醒来读一次。 */
  private hall?: Hall;
  private loading?: Promise<Hall>;
  /** Which meeting and which shard this is, learned from the first request of each wake.
   *  这是哪场会议的哪个分片 —— 每次醒来从第一个请求得知。 */
  private meta?: { m: string; shard: number };
  /** A shard's copy of what a newcomer is shown. / 分片手里那份"给新来者看的东西"。 */
  private cache?: { hist: ReturnType<typeof pub>[]; count: number; live: string };
  /** Lines pushed while the copy was still on its way, and lines deleted meanwhile.
   *  副本还在路上时推来的句子,以及期间被删掉的句子。 */
  private early: ReturnType<typeof pub>[] = [];
  private gone = new Set<number>();
  /** The whole crowd's pace, kept by the hall. A wake refills it, which is fine.
   *  全场观众的节奏,由总台记着。醒来会重新装满,无妨。 */
  private crowd = { tk: CROWD.burst, at: 0 };

  // ----- bookkeeping -----

  private async learn(m: string, shard: number): Promise<void> {
    if (!m || !(shard >= 0 && shard < AUD_SHARDS)) return;
    if (!this.meta) this.meta = ((await this.ctx.storage.get('meta')) as { m: string; shard: number } | undefined) || undefined;
    if (this.meta?.m === m && this.meta.shard === shard) return;
    this.meta = { m, shard };
    await this.ctx.storage.put('meta', this.meta);
  }

  private async whoAmI(): Promise<{ m: string; shard: number } | undefined> {
    if (!this.meta) this.meta = ((await this.ctx.storage.get('meta')) as { m: string; shard: number } | undefined) || undefined;
    return this.meta;
  }

  private load(): Promise<Hall> {
    if (this.hall) return Promise.resolve(this.hall);
    this.loading ??= (async () => {
      const got = await this.ctx.storage.get(HALL_KEYS as string[]);
      const g = (k: keyof Hall, d: unknown) => (got.has(k) ? got.get(k) : d);
      // Line numbers start from the clock, so that numbers from before a wipe can never come
      // back and be taken for new lines. / 句子编号从时钟起步,清空之前的编号就永远不会回来被当成新句子。
      this.hall = {
        m: g('m', '') as string, seq: g('seq', now()) as number, hist: g('hist', []) as Line[], hands: g('hands', []) as Ask[],
        counts: g('counts', {}) as Record<string, number>, blocked: g('blocked', []) as string[], revoked: g('revoked', []) as string[],
        live: g('live', '') as Hall['live'], touched: g('touched', now()) as number, shown: g('shown', 0) as number,
      };
      return this.hall;
    })();
    return this.loading;
  }

  private async save(h: Hall, ...keys: (keyof Hall)[]): Promise<void> {
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = h[k];
    await this.ctx.storage.put(out);
  }

  private send(ws: WebSocket, msg: unknown): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* on its way out / 正在离场 */ }
  }

  /** Change what a socket carries, read fresh and written back with nothing in between.
   *  改 socket 上存的东西:现读、现改、现写回,中间没有别的。 */
  private patch(ws: WebSocket, change: (s: Seat) => void): Seat | null {
    const s = ws.deserializeAttachment() as Seat | null;
    if (!s) return null;
    change(s);
    try { ws.serializeAttachment(s); } catch { /* likewise / 同上 */ }
    return s;
  }

  private spend(ws: WebSocket): boolean {
    let ok = false;
    this.patch(ws, (s) => {
      const pace = isStaff(s.badge) ? STAFF : VIEWER;
      const t = now();
      s.tk = Math.min(pace.burst, s.tk + (t - s.at) / pace.everyMs);
      s.at = t;
      if (s.tk >= 1) { s.tk -= 1; ok = true; }
    });
    return ok;
  }

  private async hallCall(op: string, body: Record<string, unknown>): Promise<any> {
    const me = await this.whoAmI();
    if (!me) return { error: 'e_meet_live_unavailable' };
    try {
      const r = await audienceStub(this.env, me.m, 0).fetch(`https://aud/h/${op}`, { method: 'POST', body: JSON.stringify({ ...body, m: me.m }) });
      return await r.json();
    } catch {
      return { error: 'e_meet_aud_busy' };
    }
  }

  private async shardCall(m: string, shard: number, op: string, body: Record<string, unknown>): Promise<any> {
    try {
      const r = await audienceStub(this.env, m, shard).fetch(`https://aud/s/${op}`, { method: 'POST', body: JSON.stringify(body) });
      return await r.json();
    } catch {
      return null;
    }
  }

  // ----- arriving -----

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') === 'websocket') return this.arrive(req);
    const url = new URL(req.url);
    const [, side, op] = url.pathname.split('/');
    const body: any = await req.json().catch(() => ({}));
    if (side === 'h') return Response.json(await this.hallOp(String(op || ''), body));
    if (side === 's') return Response.json(await this.shardOp(String(op || ''), body));
    return new Response('not found', { status: 404 });
  }

  private async arrive(req: Request): Promise<Response> {
    // Written by our own Worker; nothing outside it can address this object.
    // 由我们自己的 Worker 写下;Worker 之外的任何东西都寻址不到这个对象。
    let who: AudWho;
    let shard: number;
    try {
      who = JSON.parse(decodeURIComponent(req.headers.get('x-aud-who') || ''));
      shard = Number(req.headers.get('x-aud-shard'));
    } catch {
      return new Response('bad who', { status: 400 });
    }
    if (!(shard >= 0 && shard < AUD_SHARDS) || !who?.vid || !who.m) return new Response('bad who', { status: 400 });
    await this.learn(who.m, shard);
    const staff = isStaff(who.badge);

    let hello: Record<string, unknown>;
    if (shard === 0) {
      const h = await this.load();
      if (!h.m) { h.m = who.m; await this.save(h, 'm'); }
      if (h.revoked.includes(who.vid)) return refuse('e_meet_kicked');
      hello = { hist: h.hist.map(pub), count: h.shown, live: h.live, ...(who.badge === 'host' ? { hands: h.hands.map(askPub) } : {}) };
    } else {
      hello = { ...(await this.copy()) };
    }

    const seat: Seat = { ...who, sh: shard, hand: false, tk: (staff ? STAFF : VIEWER).burst, at: now() };
    const pair = new WebSocketPair();
    const tags = [`v:${who.vid}`, staff ? 'staff' : 'viewer'];
    if (who.badge === 'host') tags.push('host');
    this.ctx.acceptWebSocket(pair[1], tags);
    pair[1].serializeAttachment(seat);
    this.send(pair[1], { t: 'hello', you: { vid: who.vid, name: who.name, badge: who.badge }, chat: who.chat, hand: false, ...hello });
    if (!staff) await this.countSoon();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** What a shard shows a newcomer: its own copy, fetched from the hall once per wake.
   *  分片给新来者看的东西:它自己的副本,每次醒来向总台取一次。 */
  private async copy(): Promise<{ hist: ReturnType<typeof pub>[]; count: number; live: string }> {
    if (!this.cache) {
      const snap = await this.hallCall('snapshot', {});
      if (!this.cache) {
        const byId = new Map<number, ReturnType<typeof pub>>();
        for (const l of [...(snap?.hist || []), ...this.early]) if (!this.gone.has(l.id)) byId.set(l.id, l);
        this.cache = { hist: [...byId.values()].sort((a, b) => a.id - b.id).slice(-HIST), count: Number(snap?.count) || 0, live: String(snap?.live || '') };
        this.early = [];
      }
    }
    return this.cache;
  }

  // ----- what sockets say -----

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 4096) return;
    const s = ws.deserializeAttachment() as Seat | null;
    if (!s) return;
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const t = String(m?.t || '');
    const err = (code: string) => this.send(ws, { t: 'err', code });

    if (t === 'say') {
      const text = cleanText(m.text);
      if (!text) return;
      if (!isStaff(s.badge) && !s.chat) return err('e_meet_aud_chat_off');
      if (!s.name) return err('e_meet_aud_name');
      if (!this.spend(ws)) return err('e_meet_aud_slow');
      const who = { vid: s.vid, name: s.name, uid: s.uid, badge: s.badge };
      const res = s.sh === 0 ? await this.hallSay(who, text) : await this.hallCall('say', { who, text });
      if (res?.error) err(res.error);
      // Lines carry no viewer ids, so the one who said it is told which it was.
      // 句子里不带观众 id,所以要单独告诉说话的人:哪一句是他的。
      else if (res?.id) this.send(ws, { t: 'said', id: res.id });
      return;
    }
    if (t === 'hand') {
      if (isStaff(s.badge)) return;
      const on = !!m.on;
      if (on && !s.name) return err('e_meet_aud_name');
      if (!this.spend(ws)) return err('e_meet_aud_slow');
      const res = await this.hallCall('hand', { who: { vid: s.vid, name: s.name, uid: s.uid, badge: s.badge }, on, shard: s.sh });
      const now2 = on && !res?.error;
      this.patch(ws, (x) => { x.hand = now2; });
      this.send(ws, { t: 'hand', on: now2 });
      if (res?.error) err(res.error);
      return;
    }
    // Hosts only, and hosts are only ever on the hall. / 仅主持人;而主持人只会在总台上。
    if (t === 'hide' || t === 'block' || t === 'admit' || t === 'deny') {
      if (s.badge !== 'host' || s.sh !== 0) return;
      const res = await this.hallMod(t, m, s);
      if (res?.error) err(res.error);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> { await this.leave(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { await this.leave(ws); }

  private async leave(ws: WebSocket): Promise<void> {
    const s = ws.deserializeAttachment() as Seat | null;
    if (!s) return;
    if (!isStaff(s.badge)) {
      // Somebody who asked to speak and then left -- or walked into the room -- is no longer asking.
      // 申请了发言然后离开的人 —— 或者走进了会场的人 —— 就不再是在申请了。
      const still = this.ctx.getWebSockets(`v:${s.vid}`).some((w) => w !== ws);
      if (s.hand && !still) await this.hallCall('gone', { vid: s.vid });
      await this.countSoon();
    }
    if (s.sh === 0 && !this.ctx.getWebSockets().some((w) => w !== ws)) await this.idleSoon();
  }

  // ----- counting heads -----

  private async countSoon(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    if (at == null || at > now() + COUNT_DELAY_MS) await this.ctx.storage.setAlarm(now() + COUNT_DELAY_MS);
  }

  private async idleSoon(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(now() + IDLE_MS);
  }

  async alarm(): Promise<void> {
    const me = await this.whoAmI();
    if (!me) return;
    if (me.shard !== 0) {
      await this.hallCall('count', { shard: me.shard, n: this.ctx.getWebSockets('viewer').length });
      return;
    }
    const h = await this.load();
    const total = Object.values(h.counts).reduce((a, b) => a + (Number(b) || 0), 0);
    if (total !== h.shown) {
      h.shown = total;
      await this.save(h, 'shown');
      await this.fanout({ t: 'count', n: total });
    }
    // Nobody connected and nothing said for hours: what the hall kept is no longer anybody's.
    // 几个小时没人连着、也没人说话:总台留着的东西已不再属于任何人。
    if (!this.ctx.getWebSockets().length) {
      if (now() - h.touched > IDLE_MS) {
        await this.ctx.storage.deleteAll();
        this.hall = undefined;
        this.loading = undefined;
        this.meta = undefined;
        return;
      }
      await this.ctx.storage.setAlarm(h.touched + IDLE_MS);
    }
  }

  // ----- the hall -----

  /** Send to everybody: the people in the room here, the viewers through their shards.
   *  发给所有人:房间里的人在这里,观众经由他们的分片。 */
  private async fanout(msg: Record<string, unknown>): Promise<void> {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(text); } catch { /* leaving / 正在离场 */ } }
    const h = await this.load();
    if (!h.m) return;
    const jobs: Promise<unknown>[] = [];
    for (let k = 1; k < AUD_SHARDS; k++) jobs.push(this.shardCall(h.m, k, 'push', { msg }));
    await Promise.all(jobs);
  }

  private tellHosts(h: Hall): void {
    const text = JSON.stringify({ t: 'hands', list: h.hands.map(askPub) });
    for (const ws of this.ctx.getWebSockets('host')) { try { ws.send(text); } catch { /* leaving / 正在离场 */ } }
  }

  private blocked(h: Hall, who: { vid: string; uid?: string }): boolean {
    return h.blocked.includes(`v:${who.vid}`) || (!!who.uid && h.blocked.includes(`u:${who.uid}`));
  }

  private async hallOp(op: string, b: any): Promise<Reply> {
    const h = await this.load();
    if (b?.m && !h.m) { h.m = String(b.m); await this.save(h, 'm'); await this.learn(h.m, 0); }
    switch (op) {
      case 'snapshot':
        return { hist: h.hist.map(pub), count: h.shown, live: h.live };
      case 'say':
        return this.hallSay(b.who || {}, cleanText(b.text));
      case 'hand':
        return this.hallHand(b.who || {}, !!b.on, Number(b.shard));
      case 'gone': {
        const i = h.hands.findIndex((a) => a.vid === String(b.vid || ''));
        if (i >= 0) { h.hands.splice(i, 1); await this.save(h, 'hands'); this.tellHosts(h); }
        return { ok: true };
      }
      case 'count': {
        const k = String(Number(b.shard) | 0);
        const n = Math.max(0, Number(b.n) | 0);
        if (h.counts[k] !== n) { h.counts[k] = n; await this.save(h, 'counts'); await this.countSoon(); }
        return { ok: true };
      }
      case 'live': {
        const state = b.state === 'on' ? 'on' : 'off';
        if (h.live !== state) { h.live = state; await this.save(h, 'live'); }
        await this.fanout({ t: 'live', state });
        return { ok: true };
      }
      case 'reset': {
        // The sitting is over: nobody is asking to speak any more. The meeting is over: nothing
        // said is kept either. / 这一场结束了:不再有人在申请发言。会议结束了:说过的话也不再留着。
        h.hands = [];
        const keys: (keyof Hall)[] = ['hands'];
        if (b.full) { h.hist = []; h.blocked = []; h.revoked = []; h.live = 'off'; keys.push('hist', 'blocked', 'revoked', 'live'); }
        await this.save(h, ...keys);
        this.tellHosts(h);
        await this.fanout({ t: 'reset', full: !!b.full, ended: !!b.ended });
        return { ok: true };
      }
      case 'drop': {
        // Somebody was removed from the room: their pass stops working, here and now.
        // 有人被请出了房间:他的后台证就此失效,当场生效。
        const vid = String(b.vid || '');
        if (vid && !h.revoked.includes(vid)) { h.revoked.push(vid); await this.save(h, 'revoked'); }
        for (const ws of this.ctx.getWebSockets(`v:${vid}`)) { try { ws.close(4400, 'kicked'); } catch { /* gone / 已走 */ } }
        return { ok: true };
      }
    }
    return { error: 'e_bad_request' };
  }

  private async hallSay(who: { vid?: string; name?: string; uid?: string; badge?: Badge }, text: string): Promise<Reply> {
    const h = await this.load();
    const badge: Badge = (['host', 'speaker', 'user', 'guest'] as Badge[]).includes(who.badge as Badge) ? (who.badge as Badge) : 'guest';
    if (!text) return { error: 'e_bad_request' };
    if (!isStaff(badge)) {
      if (this.blocked(h, { vid: String(who.vid || ''), uid: who.uid })) return { error: 'e_meet_aud_blocked' };
      const t = now();
      this.crowd.tk = Math.min(CROWD.burst, this.crowd.tk + (t - this.crowd.at) / CROWD.everyMs);
      this.crowd.at = t;
      if (this.crowd.tk < 1) return { error: 'e_meet_aud_busy' };
      this.crowd.tk -= 1;
    }
    h.seq = Math.max(h.seq + 1, 1);
    const line: Line = { id: h.seq, at: now(), name: cleanName(who.name) || '?', badge, text, vid: String(who.vid || ''), uid: String(who.uid || '') };
    h.hist.push(line);
    if (h.hist.length > HIST) h.hist.splice(0, h.hist.length - HIST);
    h.touched = now();
    await this.save(h, 'seq', 'hist', 'touched');
    await this.fanout({ t: 'chat', msgs: [pub(line)] });
    return { ok: true, id: line.id };
  }

  private async hallHand(who: { vid?: string; name?: string; uid?: string; badge?: Badge }, on: boolean, shard: number): Promise<Reply> {
    const h = await this.load();
    const vid = String(who.vid || '');
    if (!VID_RE.test(vid) || !(shard >= 1 && shard < AUD_SHARDS)) return { error: 'e_bad_request' };
    const i = h.hands.findIndex((a) => a.vid === vid);
    if (on) {
      if (this.blocked(h, { vid, uid: who.uid })) return { error: 'e_meet_aud_blocked' };
      if (i < 0) {
        if (h.hands.length >= HANDS_MAX) return { error: 'e_meet_aud_queue_full' };
        h.hands.push({ vid, name: cleanName(who.name) || '?', badge: who.badge === 'user' ? 'user' : 'guest', uid: String(who.uid || ''), shard, at: now() });
      } else {
        h.hands[i].shard = shard;
      }
    } else {
      if (i < 0) return { ok: true };
      h.hands.splice(i, 1);
    }
    h.touched = now();
    await this.save(h, 'hands', 'touched');
    this.tellHosts(h);
    return { ok: true };
  }

  /** What a host may do from the room. / 主持人在房间里能做的事。 */
  private async hallMod(op: string, m: any, host: Seat): Promise<Reply> {
    const h = await this.load();
    if (op === 'hide') {
      const id = Number(m.id);
      const i = h.hist.findIndex((l) => l.id === id);
      if (i < 0) return { ok: true };
      h.hist.splice(i, 1);
      await this.save(h, 'hist');
      await this.fanout({ t: 'del', ids: [id] });
      return { ok: true };
    }
    if (op === 'block') {
      // Silence whoever said this line: everything they said goes, and they can say no more.
      // 让说这句话的人闭嘴:他说过的全部删掉,之后也说不了了。
      const line = h.hist.find((l) => l.id === Number(m.id));
      if (!line || isStaff(line.badge)) return { ok: true };
      const key = line.uid ? `u:${line.uid}` : `v:${line.vid}`;
      if (!h.blocked.includes(key)) h.blocked.push(key);
      const same = (l: Line) => (line.uid ? l.uid === line.uid : l.vid === line.vid);
      const ids = h.hist.filter(same).map((l) => l.id);
      h.hist = h.hist.filter((l) => !same(l));
      const asks = h.hands.filter((a) => (line.uid ? a.uid === line.uid : a.vid === line.vid));
      h.hands = h.hands.filter((a) => !asks.includes(a));
      await this.save(h, 'blocked', 'hist', 'hands');
      this.tellHosts(h);
      await this.fanout({ t: 'del', ids });
      const shards = new Set([line.vid ? viewerShard(line.vid) : 0, ...asks.map((a) => a.shard)]);
      for (const k of shards) if (k > 0) await this.shardCall(h.m, k, 'to', { vid: line.vid, uid: line.uid, msg: { t: 'blocked' } });
      return { ok: true };
    }
    const a = h.hands.find((x) => x.vid === String(m.vid || ''));
    if (!a) return { error: 'e_meet_aud_gone' };
    if (op === 'deny') {
      h.hands = h.hands.filter((x) => x !== a);
      await this.save(h, 'hands');
      this.tellHosts(h);
      await this.shardCall(h.m, a.shard, 'to', { vid: a.vid, msg: { t: 'declined' } });
      return { ok: true };
    }
    if (op === 'admit') {
      // The ticket goes to this one viewer and to nobody else; the room's door honours it.
      // 入场券只给这一位观众,不给任何别人;房间的门认它。
      const ticket = await signPaper(this.env, 'spk', { m: host.m, v: a.vid, n: a.name, u: a.uid }, TICKET_TTL_MS);
      const r = await this.shardCall(h.m, a.shard, 'to', { vid: a.vid, msg: { t: 'invite', ticket } });
      if (!r?.n) {
        h.hands = h.hands.filter((x) => x !== a);
        await this.save(h, 'hands');
        this.tellHosts(h);
        return { error: 'e_meet_aud_gone' };
      }
      a.invited = now();
      await this.save(h, 'hands');
      this.tellHosts(h);
      return { ok: true };
    }
    return { error: 'e_bad_request' };
  }

  // ----- a shard -----

  private async shardOp(op: string, b: any): Promise<Reply> {
    if (op === 'push') {
      const msg = b?.msg;
      if (!msg || typeof msg.t !== 'string') return { ok: false };
      if (msg.t === 'chat') {
        const lines = Array.isArray(msg.msgs) ? msg.msgs : [];
        if (this.cache) {
          const have = new Set(this.cache.hist.map((l) => l.id));
          for (const l of lines) if (!have.has(l.id)) this.cache.hist.push(l);
          if (this.cache.hist.length > HIST) this.cache.hist.splice(0, this.cache.hist.length - HIST);
        } else {
          this.early.push(...lines);
        }
      } else if (msg.t === 'del') {
        const ids = new Set<number>((msg.ids || []).map(Number));
        for (const id of ids) this.gone.add(id);
        if (this.cache) this.cache.hist = this.cache.hist.filter((l) => !ids.has(l.id));
      } else if (msg.t === 'count') {
        if (this.cache) this.cache.count = Number(msg.n) || 0;
      } else if (msg.t === 'live') {
        if (this.cache) this.cache.live = String(msg.state || '');
      } else if (msg.t === 'reset') {
        if (msg.full && this.cache) this.cache.hist = [];
        if (msg.full) this.early = [];
        for (const ws of this.ctx.getWebSockets('viewer')) this.patch(ws, (s) => { s.hand = false; });
      }
      const text = JSON.stringify(msg);
      for (const ws of this.ctx.getWebSockets('viewer')) { try { ws.send(text); } catch { /* leaving / 正在离场 */ } }
      return { ok: true };
    }
    if (op === 'to') {
      // To one viewer: somebody who asked to speak has a name, so only a named socket with that
      // id can be the one meant. A blocked account is reached by its account as well.
      // 发给某一位观众:申请过发言的人都有名字,所以只有"有名字且 id 相符"的 socket 才可能是要找的人。
      // 被禁言的账号,也按账号找。
      const msg = b?.msg;
      const vid = String(b?.vid || '');
      const uid = String(b?.uid || '');
      let n = 0;
      for (const ws of this.ctx.getWebSockets('viewer')) {
        const s = ws.deserializeAttachment() as Seat | null;
        if (!s || !s.name || !(s.vid === vid || (uid && s.uid === uid))) continue;
        if (msg?.t === 'declined' || msg?.t === 'blocked') this.patch(ws, (x) => { x.hand = false; });
        this.send(ws, msg);
        n++;
      }
      return { n };
    }
    return { ok: false };
  }
}
