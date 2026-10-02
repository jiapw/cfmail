// A seat in a meeting's room: one WebSocket, and the two things built on it.
//
// The first is the room as the room describes it. The server sends the whole room on every
// change -- who is here, who holds the large picture, what the host has locked -- so this module
// keeps nothing of its own to fall out of step with; it hands each snapshot on as it arrives.
//
// The second is a way to ask the SFU for something. The browser never talks to the SFU's API: it
// hands an SDP to the room, the room decides whether this person may do that, and answers. So a
// request here is a message with a number on it and a promise waiting for the reply with the same
// number -- an RPC over a socket that was there anyway.
//
// A refusal arrives as a message too. A browser cannot read why a WebSocket handshake failed, so
// the server accepts, says why in one line, and closes; `refused` is that line.
//
// 会议房间里的一个座位:一条 WebSocket,以及建在它上面的两样东西。
//
// 第一样是房间自己描述的房间。服务端每次变化都发来整个房间 —— 谁在、大画面在谁手上、
// 主持人锁了什么 —— 所以本模块自己什么都不留,也就没有东西会与之走样;快照来一份,转交一份。
//
// 第二样是向 SFU 提要求的办法。浏览器从不直接与 SFU 的 API 对话:它把 SDP 交给房间,
// 房间判断此人能否这么做,然后作答。于是这里的一次请求,就是一条带编号的消息,
// 加一个等着同号回复的 promise —— 借一条反正已经在那儿的 socket 做的 RPC。
//
// 拒绝同样以消息的形式到达。浏览器读不到 WebSocket 握手为什么失败,所以服务端先接受、
// 用一行说明原因、再关闭;`refused` 就是那一行。

const RPC_TIMEOUT_MS = 20000;

/** `localStorage.cf_meet_debug = 1` prints every negotiation step. It is how a meeting that will
 *  not connect on somebody's network gets diagnosed from a screenshot of their console.
 *  `localStorage.cf_meet_debug = 1` 会打印每一步协商。某人的网络上会议连不上时,
 *  靠的就是他控制台的一张截图来诊断。 */
export const DEBUG = (() => { try { return localStorage.getItem('cf_meet_debug') === '1'; } catch { return false; } })();
export const dbg = (...a) => { if (DEBUG) console.log('[meet]', ...a); };

/** Close codes after which coming back is not this module's call to make.
 *  出现这些关闭码之后,要不要回来不由本模块决定。 */
const FINAL = new Set([1000, 4001, 4003, 4009, 4400]);

/**
 * @param opts.code      the meeting's code / 会议短码
 * @param opts.guestKey  the `k` of a guest link, or '' / 访客链接里的 k,没有则 ''
 * @param opts.name      a guest's chosen name / 访客自报的名字
 * @param opts.ticket    a speaker's ticket from the audience, or '' / 观众席上拿到的发言入场券,没有则 ''
 * @param opts.turnstile () => Promise<string>: a fresh Turnstile token for each attempt, guests only
 *                       每次尝试取一个新的 Turnstile token,仅访客需要
 * @param opts.on        (message) => void: every message from the room that is not an RPC reply
 *                       房间发来的、不属于 RPC 回复的每一条消息
 * @param opts.onDown    (info) => void: the socket is gone. info.final says whether a retry is
 *                       coming; info.refused carries the server's reason, if it gave one.
 *                       socket 没了。info.final 表示是否还会重试;info.refused 是服务端给的原因(如果给了)。
 */
export function joinRoom(opts) {
  const { code, guestKey = '', name = '', ticket = '', turnstile = null, on, onDown } = opts;
  let ws = null;
  let closedByUs = false;
  let tries = 0;
  let nextRid = 1;
  let refused = null;
  const pending = new Map();

  const failAll = (why) => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.no(new Error(why)); }
    pending.clear();
  };

  async function open() {
    refused = null;
    const q = new URLSearchParams();
    // Shown on every attempt: a reconnect on the same ticket takes back the same seat.
    // 每次尝试都出示:凭同一张券重连,拿回的是同一个座位。
    if (ticket) q.set('st', ticket);
    if (guestKey) {
      q.set('k', guestKey);
      q.set('name', name);
      // A token is good for one use, so every attempt -- the first and each reconnect -- asks
      // for its own. / token 只能用一次,所以每次尝试 —— 第一次以及每次重连 —— 都各取各的。
      if (turnstile) q.set('ts', (await turnstile().catch(() => '')) || '');
    }
    if (closedByUs) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = q.toString();
    ws = new WebSocket(`${proto}//${location.host}/api/meet-pub/${encodeURIComponent(code)}/ws${qs ? '?' + qs : ''}`);
    ws.onopen = () => { tries = 0; };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'sfu_ok' || m.t === 'sfu_err') {
        const p = pending.get(m.rid);
        if (!p) return;
        pending.delete(m.rid);
        clearTimeout(p.timer);
        if (m.t === 'sfu_ok') p.ok(m);
        else p.no(Object.assign(new Error(m.code || 'sfu'), { code: m.code, detail: m.detail }));
        return;
      }
      if (m.t === 'refused') refused = { error: m.error, args: m.args || [] };
      on(m);
    };
    ws.onclose = (e) => {
      failAll('closed');
      if (closedByUs) return;
      const final = FINAL.has(e.code) || !!refused;
      onDown({ final, code: e.code, refused });
      if (final) return;
      // Everything the room knew about this seat went with the socket, so coming back is
      // arriving again: a new seat, a new SFU session. The caller rebuilds on the next welcome.
      // 房间对这个座位所知的一切都随 socket 一起没了,所以回来就是重新到达:
      // 新的座位、新的 SFU 会话。调用方在下一次 welcome 上重建。
      tries += 1;
      setTimeout(() => { if (!closedByUs) open(); }, Math.min(8000, 400 * 2 ** Math.min(tries, 5)));
    };
    ws.onerror = () => { /* onclose follows and does the work / 随后会有 onclose,活在那边干 */ };
  }

  open();

  return {
    send(m) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    /** Ask the room to ask the SFU. Resolves with the reply, rejects with an Error carrying
     *  `.code`. / 请房间去问 SFU。以回复兑现;失败时以带 `.code` 的 Error 拒绝。 */
    rpc(op, payload = {}) {
      return new Promise((ok, no) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return no(Object.assign(new Error('offline'), { code: 'offline' }));
        const rid = nextRid++;
        const t0 = performance.now();
        dbg('rpc >', rid, op, payload.tracks ? JSON.stringify(payload.tracks) : payload.mids ? JSON.stringify(payload.mids) : '');
        const timer = setTimeout(() => {
          pending.delete(rid);
          dbg('rpc ! timeout', rid, op);
          no(Object.assign(new Error('timeout'), { code: 'timeout' }));
        }, RPC_TIMEOUT_MS);
        const done = (fn) => (v) => { dbg('rpc <', rid, op, Math.round(performance.now() - t0) + 'ms', v?.code || (v?.tracks ? JSON.stringify(v.tracks) : 'ok')); fn(v); };
        ok = done(ok);
        no = done(no);
        pending.set(rid, { ok, no, timer });
        ws.send(JSON.stringify({ t: 'sfu', rid, op, ...payload }));
      });
    },
    get open() { return !!ws && ws.readyState === WebSocket.OPEN; },
    leave() {
      closedByUs = true;
      failAll('left');
      try { ws?.send(JSON.stringify({ t: 'bye' })); } catch { /* already down / 已经断了 */ }
      try { ws?.close(1000, 'bye'); } catch { /* likewise / 同上 */ }
    },
  };
}
