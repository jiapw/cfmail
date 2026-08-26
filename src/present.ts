// The room a document is presented in.
//
// One person edits and everybody else watches it happen -- the text as it is typed, the place in
// the document being looked at, and a pen that can be drawn with while talking. It exists for the
// half hour a video call lasts and for nothing longer, which is why it stores nothing at all.
//
// That last part is worth being explicit about, because it is what makes the whole thing cheap and
// safe: this Durable Object is a pipe, not a shelf. The document itself lives where it always did,
// in R2 behind the ordinary conditional write, and every save made during a presentation is the
// same save the editor has always made. Nothing here is the only copy of anything. So the room can
// be thrown away the moment the last person leaves, a crash costs a reconnect and not a word of
// text, and there is no checkpoint to schedule, no log to replay and no state to restore on wake.
//
// Everything the room knows is therefore kept on the sockets themselves, through the hibernation
// attachment: who is here, what they are allowed to do, and which colour is theirs. Ask the sockets
// and you have the roster; there is no second place where it could disagree.
//
// 一份文档被演示时所在的房间。
//
// 一个人编辑,其余的人看着它发生 —— 正在敲出来的文本、正在看的位置,
// 以及一支可以边讲边画的笔。它只为一通视频会议的那半小时而存在,不为更久,
// 所以它什么都不存。
//
// 最后这一点值得说明白,因为整件事的便宜与安全都系于此:这个 Durable Object 是一根管子,
// 不是一个架子。文档本身仍住在它一直住的地方 —— R2,走那条一直以来的条件写 ——
// 演示途中的每一次保存,都还是编辑器一直以来做的那次保存。
// 这里没有任何东西是某样东西的唯一副本。于是最后一个人离开时房间可以直接扔掉、
// 一次崩溃的代价是重连而不是丢字,并且没有 checkpoint 要安排、没有日志要重放、
// 醒来时也没有状态要恢复。
//
// 因此房间所知的一切都存在 socket 自己身上,经由 hibernation 的 attachment:
// 谁在、他被允许做什么、哪个颜色是他的。问 socket 就得到名册;
// 不存在第二个地方能与它说法不一。
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import { HttpError } from './errors';
import { presentSeat } from './drive';
import { userFromRequest } from './auth';
import type { Env, User } from './types';

/** Where somebody sits. Not a permission -- the permissions were settled before the socket was
 *  ever accepted, and are carried alongside. This is what the person is doing right now.
 *  某人坐在哪儿。它不是权限 —— 权限在 socket 被接受之前就已了结,并随行携带。
 *  这里说的是此刻这个人正在做什么。 */
export type Seat = 'presenter' | 'annotator' | 'viewer';

/** Everything about one connection, kept on the socket so hibernation cannot lose it.
 *  一条连接的全部,存在 socket 上,好让休眠带不走它。 */
interface Who {
  peer: string;
  user: string;
  name: string;
  seat: Seat;
  /** Index into the palette the browser holds. -1 for somebody who cannot draw and needs no colour.
   *  浏览器手上那份调色板的下标。画不了的人不需要颜色,记 -1。 */
  color: number;
  canEdit: boolean;
  canInk: boolean;
}

/** How many people can be told apart by colour at once. Past this everybody still gets in; they
 *  just share the far end of the palette, which is better than refusing them the room.
 *  同时能靠颜色分辨的人数。超过之后所有人照样进得来,只是共用调色板的末尾 ——
 *  那也好过把人挡在门外。 */
const IN_COLOUR = 8;

/** What a presenter may send, and what merely being in the room lets you send. Kept as two lists
 *  rather than one check per handler, so that adding a message type forces the question to be
 *  answered rather than defaulted.
 *  演示者能发什么,以及"只是在场"能让你发什么。写成两份清单而不是每个分支里各判一次,
 *  这样新增一种消息时,这个问题会被逼着回答,而不是被默认掉。 */
const PRESENTER_ONLY = new Set(['text', 'view', 'full', 'saved', 'sel']);
const INK_MESSAGES = new Set(['ink', 'ink_end']);

export class PresentRoom extends DurableObject<Env> {
  /** Every live socket with the person on the other end of it. A socket whose attachment cannot be
   *  read has not finished its handshake and is not part of the room yet.
   *  每条活着的 socket,连同它另一端的那个人。attachment 读不出来的 socket
   *  还没走完握手,尚不算房间的一部分。 */
  private seats(except?: WebSocket): { ws: WebSocket; who: Who }[] {
    const out: { ws: WebSocket; who: Who }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const who = ws.deserializeAttachment() as Who | null;
      if (who && who.peer) out.push({ ws, who });
    }
    return out;
  }

  private send(ws: WebSocket, msg: unknown): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* a socket on its way out / 一条正在离场的 socket */ }
  }

  private tell(msg: unknown, except?: WebSocket): void {
    const s = JSON.stringify(msg);
    for (const { ws } of this.seats(except)) {
      try { ws.send(s); } catch { /* likewise / 同上 */ }
    }
  }

  /** The roster as everybody else needs to see it: enough to draw a row of dots and to colour
   *  somebody's ink, and nothing about what they are permitted to do.
   *  名册,按其他人需要看到的样子:够画出一排色点、够给某人的笔迹上色,
   *  不包含任何关于"他被允许做什么"的信息。 */
  private roster(except?: WebSocket) {
    return this.seats(except).map(({ who }) => ({
      peer: who.peer, name: who.name, seat: who.seat, color: who.color,
    }));
  }

  private presenter(except?: WebSocket): { ws: WebSocket; who: Who } | null {
    return this.seats(except).find((s) => s.who.seat === 'presenter') || null;
  }

  /** Tell the room who is in it. Sent whenever anything about the roster changes, as one whole
   *  list rather than a join/leave delta: a client that missed one delta would be wrong until it
   *  reconnected, and the list is a few dozen bytes.
   *
   *  `gone` is a socket that is leaving, and it is left out of BOTH the list and the sending --
   *  it is on its way off and is not part of the room being described. Nobody else is left out.
   *  In particular a socket that has just arrived is sent to and listed like everybody else: it
   *  already has the same roster inside its welcome, so the second copy costs nothing and the
   *  alternative -- leaving it out of the list -- describes a room it is standing in.
   *
   *  把"谁在房间里"告诉房间。名册一有变动就发,并且发整份而不是加入/离开的增量:
   *  漏掉一次增量的客户端会一直错到重连为止,而整份名单不过几十字节。
   *
   *  `gone` 是一条正在离开的 socket,它既不进名单也不接收 —— 它正在离场,
   *  不属于被描述的这个房间。除此之外不排除任何人。
   *  尤其是刚到的那一条:它照样收、照样被列进去 —— 它的 welcome 里本来就有同一份名册,
   *  多这一份不花什么;而另一种做法(把它从名单里漏掉)描述的是一个"它正站在里面"的房间。 */
  private announce(gone?: WebSocket): void {
    const pres = this.presenter(gone);
    this.tell({ t: 'peers', peers: this.roster(gone), presenter: pres?.who.peer || null }, gone);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // These headers were written by our own router after it did the asking. The object is not
    // routable from outside the Worker, so there is nobody else who could have written them.
    // 这些 header 由我们自己的路由在问过之后写下。这个对象在 Worker 之外无法寻址,
    // 因此不存在别人能写下它们。
    const canEdit = req.headers.get('x-present-edit') === '1';
    const canInk = canEdit || req.headers.get('x-present-ink') === '1';
    const who: Who = {
      peer: crypto.randomUUID().slice(0, 8),
      user: req.headers.get('x-present-user') || '',
      // A display name is a person's own text and will not survive a header as itself.
      // 显示名是人自己写的文本,原样过不了 header。
      name: decodeURIComponent(req.headers.get('x-present-name') || '').slice(0, 64),
      seat: 'viewer',
      color: -1,
      canEdit,
      canInk,
    };

    const here = this.seats();
    // The second person with the right to edit does not get to edit. Somebody is already
    // presenting this document to a room, and two people typing into one presentation is the
    // thing this whole design exists to not be. They are given the pen instead, and the way back
    // to editing is a separate tab holding a separate copy -- which the client offers by name.
    // 第二个有编辑权的人,不会拿到编辑权。已经有人正在把这份文档演示给一屋子人,
    // 而"两个人往同一场演示里打字"正是这整套设计存在所要避免的。
    // 他拿到的是那支笔;回到编辑的路是另开一个标签页、另持一份副本 —— 客户端会指名提供它。
    const taken = here.some((s) => s.who.seat === 'presenter');
    who.seat = canEdit && !taken ? 'presenter' : canInk ? 'annotator' : 'viewer';
    if (who.seat !== 'viewer') who.color = this.freeColour(here);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(who);

    // Said to the newcomer alone: who they turned out to be, and who was already here.
    // 只对新来的人说:他成了谁,以及原本谁在这儿。
    this.send(pair[1], {
      t: 'welcome',
      you: { peer: who.peer, seat: who.seat, color: who.color, canEdit: who.canEdit, canInk: who.canInk },
      peers: this.roster(),
      presenter: this.presenter()?.who.peer || null,
    });
    this.announce();

    // What the newcomer has just loaded from R2 is the last version somebody saved, and the
    // presenter is very likely past that by now. Only the presenter holds the difference, so it
    // is asked for rather than kept here.
    // 新来的人刚从 R2 载入的是"最后一次被保存的那一版",而演示者此刻多半已经走在它前面。
    // 那段差额只在演示者手上,所以是去问他要,而不是留在这里。
    const pres = this.presenter(pair[1]);
    if (pres) this.send(pres.ws, { t: 'need_full', for: who.peer });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** The lowest colour nobody is using. Runs out gracefully: past the palette everybody gets the
   *  last slot rather than no slot, because an uncoloured pen still has to draw.
   *  没人在用的最小色位。用尽时优雅收场:超出调色板的人拿最后一格而不是拿不到 ——
   *  一支没有颜色的笔仍然得画得出来。 */
  private freeColour(here: { who: Who }[]): number {
    const used = new Set(here.map((s) => s.who.color));
    for (let i = 0; i < IN_COLOUR; i++) if (!used.has(i)) return i;
    return IN_COLOUR - 1;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    const who = ws.deserializeAttachment() as Who | null;
    if (!who) return;
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const t = String(m?.t || '');

    // Whoever is presenting is the only source of the document and of where it is being looked
    // at. Asking this once, here, is what keeps every other branch from having to remember to.
    // 正在演示的那个人,是文档内容与"正在看哪里"的唯一来源。
    // 在这里问这一次,是为了让其余每个分支都不必记得去问。
    if (PRESENTER_ONLY.has(t) && who.seat !== 'presenter') return;
    if (INK_MESSAGES.has(t) && !who.canInk) return;

    switch (t) {
      case 'text':
      case 'view':
      case 'sel':
        // Straight through, stamped with nothing: the presenter is the only one who can send
        // these, so there is no question of which one of several it came from.
        //
        // A selection is unlike ink in the one way that matters here: it does not expire. It is
        // not a gesture made while saying a sentence, it is "this is the part we are on", and it
        // stands until the presenter moves it or clears it. The room still keeps no copy -- it
        // is a highlight on somebody's screen, and somebody who arrives later simply missed it.
        //
        // 选区与墨水的差别恰在此处要紧的一点上:它不过期。它不是说一句话时做的手势,
        // 而是"我们现在在这一段",它一直立着,直到演示者把它挪走或取消。
        // 房间照样不留副本 —— 它是别人屏幕上的一处高亮,而后来的人,就是错过了。
        this.tell({ ...m, t }, ws);
        break;

      case 'ink':
      case 'ink_end':
        // Ink carries its own colour rather than only its author, because it is thrown away after
        // five seconds and may well outlive its author's presence in the room. A stroke that
        // arrived after somebody left would otherwise have nothing to look its colour up in.
        // 笔迹自带颜色,而不只带作者,因为它五秒后就消失,很可能比作者在场的时间还长。
        // 否则一条在人已离开之后才到的笔画,将无处可查它的颜色。
        this.tell({ ...m, t, by: who.peer, color: who.color, seat: who.seat }, ws);
        break;

      case 'full': {
        // The answer to one newcomer's need_full. Sent to that person only -- everybody else is
        // already up to date and would be made to redraw for nothing.
        // 对某个新人 need_full 的答复。只发给那一个人 ——
        // 其余的人本来就是最新的,发给他们只会让他们白重画一次。
        const to = this.seats().find((s) => s.who.peer === String(m.for || ''));
        if (to) this.send(to.ws, { t: 'full', text: String(m.text ?? ''), seq: m.seq | 0 });
        break;
      }

      case 'rejoin': {
        // Anybody may ask, because anybody can end up unsure of what they are holding -- a
        // reconnect, a gap in the numbering. There is exactly one place the answer can come from.
        // 谁都可以问,因为谁都可能落到"不确定自己手上是什么"的地步 —— 一次重连、一处编号断档。
        // 而答案只有一个地方出得来。
        const pres = this.presenter(ws);
        if (pres) this.send(pres.ws, { t: 'need_full', for: who.peer });
        break;
      }

      case 'saved':
        // The presenter wrote the file. Everybody watching now holds a stale token, and the ones
        // who came in through a solo tab need to know their next save will have to merge.
        // 演示者把文件写下去了。此刻所有旁观者手上的令牌都过期了,
        // 而那些另开独立标签页的人需要知道:他们下一次保存将要经过合并。
        this.tell({ t: 'saved', at: Date.now() }, ws);
        break;

      case 'claim': {
        // Taking the empty chair. Only ever the empty one: a presentation in progress is not
        // something a second person gets to end by pressing a button.
        // 坐上那把空椅子。永远只能是空的那把:一场正在进行的演示,
        // 不是第二个人按一下按钮就能结束的东西。
        if (!who.canEdit || this.presenter()) return;
        who.seat = 'presenter';
        ws.serializeAttachment(who);
        this.send(ws, { t: 'seat', seat: who.seat, color: who.color });
        this.announce();
        break;
      }

      case 'bye':
        // Said on purpose by somebody leaving the room but not the page -- opening a solo copy,
        // for one. Closing the socket is the honest way to say it.
        // 由"离开房间但没离开页面"的人特意说出 —— 比如去开一份独立副本。
        // 关掉 socket 是说这句话的诚实方式。
        try { ws.close(1000, 'bye'); } catch { /* already gone / 已经走了 */ }
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  /** Somebody's socket ended. If it was the presenter's, the chair is left empty rather than
   *  handed to the next person in the list: being made to present because somebody else's network
   *  dropped is not something to do to a person who is sitting and watching.
   *  某人的 socket 结束了。如果那是演示者的,椅子就空着,而不是交给名单上的下一个人:
   *  "因为别人掉线所以你现在开始演示"这种事,不该发生在一个正安静旁观的人身上。 */
  private async leave(ws: WebSocket): Promise<void> {
    const rest = this.seats(ws);
    if (!rest.length) {
      // The room is empty, so the room is over. Nothing here was the only copy of anything, and
      // an object that keeps nothing has nothing to be resumed from.
      // 房间空了,房间就结束了。这里没有任何东西是某样东西的唯一副本,
      // 而一个什么都不留的对象,也没有什么可供恢复。
      await this.ctx.storage.deleteAll().catch(() => {});
      return;
    }
    this.announce(ws);
  }
}

// ---------- The way in ----------
// ---------- 入口 ----------

type Ctx = { Bindings: Env; Variables: { user: User } };

export const presentApp = new Hono<Ctx>();

/** Join the room for one document.
 *
 *  Everything that decides what the visitor may do happens here, in the Worker, where the
 *  database is. What crosses into the object is the verdict and nothing else -- four headers,
 *  every one of them overwritten unconditionally, so a client that sends its own copies of them
 *  is sending them to be discarded.
 *
 *  加入某份文档的房间。
 *
 *  决定访问者能做什么的一切,都发生在这里 —— Worker 里,数据库所在的地方。
 *  越过边界进入那个对象的只有结论:四个 header,每一个都被无条件覆写,
 *  所以自带这几个 header 的客户端,只是把它们送去被丢掉。 */
presentApp.get('/:id/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') throw new HttpError(426, 'e_bad_request');
  const id = String(c.req.param('id') || '');
  if (!id) throw new HttpError(404, 'e_drive_not_found');
  // A signed-in visitor is judged as themselves even when they arrived holding a link; presentSeat
  // decides which of the two answers applies.
  // 已登录的访问者按他自己判定,哪怕他是持着链接来的;由 presentSeat 决定采用两个答案中的哪一个。
  const user = await userFromRequest(c);
  if (user) c.set('user', user);
  const seat = await presentSeat(c, id, c.req.query('share') || '', c.req.query('name') || '');

  const ns = c.env.PRESENT_ROOM;
  if (!ns) throw new HttpError(503, 'e_server');
  const stub = ns.get(ns.idFromName(id));
  const h = new Headers(c.req.raw.headers);
  h.set('x-present-user', seat.user);
  // A display name is the person's own text, and a header carries only ASCII.
  // 显示名是人自己写的文本,而 header 只运得了 ASCII。
  h.set('x-present-name', encodeURIComponent(seat.name));
  h.set('x-present-edit', seat.canEdit ? '1' : '0');
  h.set('x-present-ink', seat.canInk ? '1' : '0');
  return stub.fetch(new Request(c.req.raw.url, { method: 'GET', headers: h }));
});

/** What this document's room would let the caller do, without joining it. The editor asks before
 *  it decides whether to show a pen, a presence row, or nothing at all -- and asks again, of the
 *  room, on every stroke that actually goes out.
 *  这份文档的房间会允许调用者做什么 —— 不必真的加入。编辑器在决定"要不要显示一支笔、
 *  一排在场的人,还是什么都不显示"之前先问一次;而每一笔真正发出去时,还会再问房间一次。 */
presentApp.get('/:id/seat', async (c) => {
  const id = String(c.req.param('id') || '');
  const user = await userFromRequest(c);
  if (user) c.set('user', user);
  const seat = await presentSeat(c, id, c.req.query('share') || '', '');
  return c.json({ can_edit: seat.canEdit, can_ink: seat.canInk, guest: seat.guest, name: seat.name });
});
