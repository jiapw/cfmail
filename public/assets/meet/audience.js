// A seat in a broadcast's audience: one WebSocket to the audience's objects, kept open.
//
// Two pages hold one. The watching page, as a viewer: the chat, asking to speak, the head count,
// and word of the broadcast starting and stopping. The room's page, as somebody on the stage,
// holding the pass the room gave them: the same chat seen from the other side and, for a host,
// the queue of people asking to speak.
//
// Like the room's socket it comes back by itself when the network drops, and a refusal arrives
// as a message -- a browser cannot read why a handshake failed -- after which it stays down.
// Who the socket is decided by what `query()` returns at each attempt, so a viewer who has just
// given a name reconnects as themselves by calling `reopen()`.
//
// 直播观众席上的一个座位:一条连到观众对象的 WebSocket,一直开着。
//
// 两种页面各持一条。旁观页,以观众身份:聊天、申请发言、在看人数,以及开播与停播的消息。
// 房间页,以台上的人的身份,手持房间给的后台证:从另一侧看同一场聊天;主持人还能看到申请发言的队列。
//
// 与房间的 socket 一样,网络断了它会自己回来;拒绝以消息的形式到达 —— 浏览器读不到握手为什么失败 ——
// 之后它就不再重连。这条 socket 是谁,由每次尝试时 `query()` 返回什么决定,
// 所以刚留了名的观众调用 `reopen()`,就以新的身份重新连上。

import { esc, icon } from '../ui.js';
import { t } from '../i18n.js';

/** Close codes after which coming back is not this module's call. / 出现这些关闭码之后,要不要回来不由本模块决定。 */
const FINAL = new Set([1000, 4400]);

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const two = (n) => String(n).padStart(2, '0');

/** One line of the audience's chat, drawn the same way on both sides. Names say what they are:
 *  a host, a speaker, or a guest -- the last because a guest's name is only what they typed.
 *  With `mod`, a host's tools: take the line down, or silence whoever said it.
 *  观众聊天里的一句,两边画法相同。名字旁注明身份:主持人、发言人或访客 —— 最后一种,因为访客的名字只是他自己打的字。
 *  带 `mod` 时是主持人的工具:撤下这一句,或让说这句的人闭嘴。 */
export function audLineHtml(m, { mine = false, mod = false } = {}) {
  const staff = m.badge === 'host' || m.badge === 'speaker';
  const tag = m.badge === 'host' ? t('mt_host') : m.badge === 'speaker' ? t('mt_speaker') : m.badge === 'guest' ? t('mt_guest') : '';
  const at = new Date(m.at);
  const body = esc(m.text).replace(URL_RE, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow ugc">${u}</a>`);
  const tools = mod ? `<span class="mt-msg-tools">
      <button type="button" data-aud-do="hide" data-id="${Number(m.id)}" title="${esc(t('mt_aud_hide'))}" aria-label="${esc(t('mt_aud_hide'))}">${icon('trash', 14)}</button>
      ${staff ? '' : `<button type="button" data-aud-do="block" data-id="${Number(m.id)}" data-name="${esc(m.name)}" title="${esc(t('mt_aud_block'))}" aria-label="${esc(t('mt_aud_block'))}">${icon('stop', 14)}</button>`}
    </span>` : '';
  return `<div class="mt-msg ${mine ? 'mine' : ''} ${staff ? 'staff' : ''}">
    <div class="mt-msg-h"><b>${esc(mine ? t('mt_you') : m.name)}</b>${tag ? `<span class="mt-tag ${m.badge === 'guest' ? 'dim' : ''}">${esc(tag)}</span>` : ''}
      <span class="dim">${two(at.getHours())}:${two(at.getMinutes())}</span>${tools}</div>
    <div class="mt-msg-b">${body}</div></div>`;
}

/** Merge lines into a list kept in order, each once. / 把句子并进一个有序、不重复的列表。 */
export function mergeLines(list, lines, max = 200) {
  const have = new Set(list.map((l) => l.id));
  for (const l of lines || []) if (l && !have.has(l.id)) { list.push(l); have.add(l.id); }
  list.sort((a, b) => a.id - b.id);
  if (list.length > max) list.splice(0, list.length - max);
  return list;
}

/**
 * @param opts.code     the meeting's code / 会议短码
 * @param opts.query    () => object: the query for each attempt (vid, who, pass) / 每次尝试的查询参数
 * @param opts.on       (message) => void
 * @param opts.onState  (up, info) => void: up is whether the socket is open; info.final and
 *                      info.refused as the room's socket gives them / socket 是否开着;info 同房间的 socket
 */
export function joinAudience({ code, query, on, onState }) {
  let ws = null;
  let gen = 0;
  let tries = 0;
  let timer = 0;
  let closed = false;

  function open() {
    const my = ++gen;
    let refused = null;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query() || {})) if (v) q.set(k, v);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = ws = new WebSocket(`${proto}//${location.host}/api/meet-pub/live/${encodeURIComponent(code)}/ws?${q}`);
    sock.onopen = () => { if (my === gen) { tries = 0; onState?.(true, {}); } };
    sock.onmessage = (e) => {
      if (my !== gen) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'refused') refused = { error: m.error, args: m.args || [] };
      on(m);
    };
    sock.onclose = (e) => {
      if (my !== gen || closed) return;
      const final = FINAL.has(e.code) || !!refused;
      onState?.(false, { final, refused });
      if (final) return;
      tries += 1;
      timer = setTimeout(() => { if (my === gen && !closed) open(); }, Math.min(15000, 500 * 2 ** Math.min(tries, 5)));
    };
    sock.onerror = () => { /* onclose follows / 随后会有 onclose */ };
  }

  open();

  return {
    send(m) {
      if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(m)); return true; }
      return false;
    },
    /** Connect again at once, as whoever `query()` now says. / 立刻重新连接,身份以 `query()` 此刻的回答为准。 */
    reopen() {
      clearTimeout(timer);
      const old = ws;
      gen += 1;
      try { old?.close(1000, 'again'); } catch { /* already down / 已经断了 */ }
      tries = 0;
      open();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      gen += 1;
      try { ws?.close(1000, 'bye'); } catch { /* already down / 已经断了 */ }
    },
    get open() { return !!ws && ws.readyState === WebSocket.OPEN; },
  };
}
