// Showing a document to a room while you work on it.
//
// One person edits; everybody else watches the text appear, follows what is being looked at, and
// can draw on top of it while somebody talks. It is the document equivalent of sharing a screen,
// except that the watchers get real text -- selectable, their own theme, their own window size --
// instead of a video of somebody else's monitor.
//
// This is the protocol and nothing else, which is why it lives beside session.js rather than
// inside an editor. session.js knows how a document is written back; this knows how one is shown.
// An editor supplies an adapter -- how to read its content, how to put content in, where it is
// looking, and which box the ink goes over -- and everything else here is the same for every
// editor there will ever be.
//
// The one rule that shapes all of it: NOTHING HERE IS AUTHORITATIVE. The document lives in R2
// behind the same conditional write it always did, saving is the same save, and a presentation
// that collapses costs a reconnect. That is what lets the room be thrown away when it empties,
// and what lets this file be careless about losing a message -- there is always a way to ask again.
//
// 一边做事,一边把文档给一屋子人看。
//
// 一个人编辑,其余的人看着文字出现、跟着他正在看的地方走,并能在别人讲话时在上面画。
// 它相当于文档版的共享屏幕,只是旁观者拿到的是真的文本 —— 可选中、用自己的主题、
// 自己的窗口大小 —— 而不是别人显示器的一段视频。
//
// 这里只有协议,别无其他,所以它住在 session.js 旁边而不是住进某个编辑器。
// session.js 知道一份文档怎么写回去;这里知道一份文档怎么被看见。
// 编辑器交出一个适配器 —— 怎么读它的内容、怎么把内容放进去、它正在看哪里、
// 墨水该盖在哪个盒子上 —— 除此之外这里的一切,对将来任何一个编辑器都是同一套。
//
// 贯穿全篇的那一条规矩:这里没有任何东西是权威的。文档仍住在 R2、仍走那条一直以来的条件写、
// 保存仍是同一次保存,而一场垮掉的演示,代价是一次重连。
// 正是这一点,让房间空了就能扔掉,也让这个文件可以对"丢了一条消息"满不在乎 —— 总能再问一次。
import { t } from '../i18n.js';
import { esc } from '../ui.js';

// ---------- What changed ----------
// ---------- 变了什么 ----------

/** The difference between two versions of a string, as one replaced span.
 *
 *  Myers would find the smallest edit script; this finds the one edit a person just made, which
 *  is not the same problem and is a great deal cheaper. Between two samples a hundred milliseconds
 *  apart there is exactly one place where the text differs -- somebody was typing there -- so the
 *  common prefix and the common suffix bracket it, and everything between them is the change.
 *
 *  Pasting a page, deleting a selection and typing a character all come out of this correctly.
 *  Two edits in different places within one sample would come out as one span covering both, which
 *  is still correct, just bigger than it needed to be -- and a person cannot type in two places at
 *  once, so it does not happen.
 *
 *  两个版本的字符串之间的差别,表示成"被替换掉的那一段"。
 *
 *  Myers 求的是最小编辑脚本;这里求的是"某人刚刚做的那一次编辑",不是同一个问题,
 *  而且便宜得多。相隔一百毫秒的两次取样之间,文本只在一个地方不同 —— 有人正在那儿打字 ——
 *  于是公共前缀与公共后缀把它夹住,中间的就是这次改动。
 *
 *  粘贴一整页、删掉一段选中、敲进一个字符,从这里出来都是对的。
 *  一次取样内发生在两个不同地方的编辑,会合成一段把两处都盖住的区间 —— 那仍然是对的,
 *  只是比需要的大;而一个人没法同时在两个地方打字,所以它不会发生。 */
export function delta(a, b) {
  if (a === b) return null;
  const la = a.length, lb = b.length;
  const lim = Math.min(la, lb);
  let p = 0;
  while (p < lim && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < lim - p && a.charCodeAt(la - 1 - s) === b.charCodeAt(lb - 1 - s)) s++;
  return { at: p, del: la - p - s, ins: b.slice(p, lb - s) };
}

/** Apply one. The inverse of the above and the only thing a watcher ever does to its copy.
 *  应用一次。上面那个的逆,也是旁观者对自己那份副本做的唯一一件事。 */
export function patch(s, d) {
  if (!d) return s;
  return s.slice(0, d.at) + d.ins + s.slice(d.at + d.del);
}

// ---------- Colours ----------
// ---------- 颜色 ----------

/** How many people can be told apart. Matches the room's own count; the palette itself is in
 *  present.css, because which colour is which is a question about the stylesheet.
 *  能被分辨开的人数。与房间那边的数目一致;调色板本身在 present.css 里 ——
 *  "哪个颜色是哪个"是个属于样式表的问题。 */
export const IN_COLOUR = 8;

/** The colour somebody's ink is drawn in.
 *
 *  Deliberately NOT a theme variable. Everybody in the room picked their own theme out of thirty,
 *  and a stroke that took its colour from the reader's theme would arrive a different colour on
 *  every screen -- which would destroy the one thing the colour is for, which is knowing who drew
 *  it. So the palette is absolute, and only light and dark move it.
 *
 *  某人的笔迹用什么颜色画。
 *
 *  刻意不是主题变量。屋里每个人都从三十套主题里挑了自己那套,
 *  而一条从读者主题取色的笔迹,会在每块屏幕上呈现不同的颜色 ——
 *  那会毁掉这个颜色唯一的用途:知道是谁画的。所以调色板是绝对的,只有明暗会移动它。 */
const peerVar = (seat, color) =>
  seat === 'presenter' ? '--peer-lead' : `--peer-${((color | 0) + IN_COLOUR) % IN_COLOUR}`;

/** As a stylesheet says it: a var() reference, which follows light and dark on its own.
 *  样式表的说法:一个 var() 引用,它自己会跟着明暗走。 */
export const inkColour = (seat, color) => `var(${peerVar(seat, color)})`;

/** As a canvas needs it: an actual colour.
 *
 *  A 2D context resolves nothing. Handed `var(--peer-3)` it does not throw and does not warn --
 *  the assignment is simply ignored, the previous value stands, and every stroke comes out in the
 *  default black. So the variable is looked up here, against the document that is really on
 *  screen, and the colour that comes back is what gets stored on the stroke.
 *
 *  canvas 需要的说法:一个真的颜色。
 *
 *  2D 上下文不解析任何东西。把 `var(--peer-3)` 递给它,它不报错也不警告 ——
 *  那次赋值直接被忽略、上一个值继续有效,于是每一笔都画成默认的黑色。
 *  所以变量在这里查,对着真正在屏幕上的那份文档查,查回来的颜色才是记在笔迹上的东西。 */
export function inkPaint(seat, color) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(peerVar(seat, color)).trim();
  // A palette that has not loaded yet is worth drawing around rather than drawing in black:
  // grey says "somebody" without claiming to say which one.
  // 调色板还没加载好时,绕开它总好过画成黑色:
  // 灰色说的是"某个人",而不假装说出是哪一个。
  return v || '#8b8b8b';
}

let cssOnce = null;
function ensureCss(v) {
  if (cssOnce) return cssOnce;
  cssOnce = new Promise((resolve) => {
    const href = `/assets/edit/present.css?v=${encodeURIComponent(v || '')}`;
    if (document.querySelector(`link[data-present]`)) return resolve();
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.dataset.present = '1';
    l.onload = () => resolve();
    l.onerror = () => resolve();
    document.head.appendChild(l);
  });
  return cssOnce;
}

// ---------- The session ----------
// ---------- 会话 ----------

/** How often the presenter's text and viewport are sampled. Fast enough that a watcher sees
 *  sentences appear rather than paragraphs, slow enough that it is nothing next to what the
 *  editor already does on every keystroke.
 *  演示者的文本与视口多久取样一次。快到让旁观者看见的是一句句出现而不是一段段出现,
 *  慢到相比编辑器本来每次按键就要做的事微不足道。 */
const SAMPLE_MS = 120;
/** The viewport moves continuously while a wheel is spinning; this is the most anybody needs.
 *  滚轮转起来时视口是连续移动的;这个频率已经够任何人用了。 */
const VIEW_MS = 100;

/** Join the room for one document.
 *
 *  `adapter` is how this file reaches into an editor without knowing which one it is:
 *
 *    getContent()          -> the text as it stands
 *    applyContent(text)    -> put this text in and show it
 *    getAnchor()           -> where the presenter is looking, in the editor's own units
 *    scrollToAnchor(a)     -> look there
 *    inkHost()             -> the element ink is drawn over, or null for no ink
 *    lineAt(y) / topOf(l)  -> the two directions of the ink anchor, in the ink host's coordinates
 *
 *  加入某份文档的房间。
 *
 *  adapter 是这个文件在不知道对方是谁的情况下伸进编辑器的手:上面六件事。 */
export async function joinPresentation(opts) {
  const { id, share = '', name = '', adapter, version = '' } = opts || {};
  await ensureCss(version);

  const st = {
    id,
    seat: 'viewer',
    color: -1,
    canEdit: false,
    canInk: false,
    me: '',
    peers: [],
    presenter: null,
    /** Following the presenter's viewport. Lost the moment the watcher scrolls for themselves,
     *  because somebody who just scrolled has said where they want to be looking.
     *  是否跟随演示者的视口。旁观者自己一滚就失去 —— 刚滚过的人已经说明了他想看哪儿。 */
    following: true,
    live: false,
  };

  let ws = null;
  let closed = false;
  let tries = 0;
  let sent = '';          // 上一次发出去的文本 / the text as last sent
  let seq = 0;
  /** Whether this tab's copy is known to be the presenter's. False from the moment of joining
   *  until the presenter answers with the whole document: what was loaded from R2 is the last
   *  saved version, and patches measured against the presenter's copy do not fit it.
   *  这个标签页手上的副本是否确知就是演示者那一份。从加入起为假,直到演示者交回整份文档为止:
   *  从 R2 载入的是最后保存的那一版,而对着演示者副本量出来的补丁,套不到它身上。 */
  let synced = false;
  /** The last place the presenter was known to be looking, so that turning following back on
   *  goes somewhere instead of waiting for them to move -- which, if they are talking rather
   *  than scrolling, could be a long while.
   *  最后一次知道演示者在看哪儿。这样重新打开跟随时能真的去到某处,而不是干等他移动 ——
   *  要是他正在讲话而不是在滚,那可能要等很久。 */
  let lastSeenLine = null;
  let sampleTimer = null;
  let viewTimer = null;
  const handlers = { state: [], ink: [], saved: [], sel: [] };

  const fire = (k, v) => { for (const fn of handlers[k] || []) { try { fn(v); } catch { /* one listener must not stop the rest / 一个监听器不该拖住其余的 */ } } };
  const send = (m) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(m)); } catch { /* going away / 正在离场 */ } } };

  function connect() {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    if (share) q.set('share', share);
    if (name) q.set('name', name);
    ws = new WebSocket(`${proto}//${location.host}/api/present/${encodeURIComponent(id)}/ws?${q}`);

    ws.onopen = () => { tries = 0; };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case 'welcome':
          st.me = m.you.peer;
          st.seat = m.you.seat;
          st.color = m.you.color;
          st.canEdit = !!m.you.canEdit;
          st.canInk = !!m.you.canInk;
          st.peers = m.peers || [];
          st.presenter = m.presenter || null;
          st.live = true;
          // Whatever this tab holds was loaded from R2 and the presenter is probably past it.
          // Nothing is applied until they answer; showing a stale document and then jumping is
          // worse than showing the stale document a moment longer.
          // 这个标签页手上的东西是从 R2 载入的,而演示者多半已经走在它前面。
          // 在他答复之前什么都不应用 —— 先显示旧文档再跳一下,比多显示旧文档一会儿更糟。
          if (st.seat === 'presenter') { sent = adapter.getContent(); synced = true; }
          else if (!st.presenter) synced = true;   // 没人在演示,手上这份就是最新 / nobody presenting: what is here is current
          fire('state', st);
          break;

        case 'peers':
          st.peers = m.peers || [];
          st.presenter = m.presenter || null;
          fire('state', st);
          break;

        case 'seat':
          st.seat = m.seat;
          st.color = m.color;
          if (st.seat === 'presenter') { sent = adapter.getContent(); synced = true; }
          fire('state', st);
          break;

        case 'text':
          if (st.seat === 'presenter') break;
          // Until the presenter has handed over their copy, an offset measured against it means
          // nothing here. Waiting is right: the answer is already on its way.
          // 在演示者交出他那份副本之前,对着它量出来的偏移量在这里没有意义。
          // 等着是对的:答案已经在路上了。
          if (!synced) break;
          // A gap in the numbering means a message was lost, which a reliable socket only manages
          // by having been a different socket. Ask for the whole thing rather than patching a
          // document these offsets were no longer measured against.
          // 编号断档意味着丢了消息 —— 一条可靠的 socket 只有在"其实是另一条 socket"时才做得到。
          // 那就整份重要,而不是去修补一份"这些偏移量已不对着它量"的文档。
          if (m.seq !== seq + 1) { synced = false; needFull(); break; }
          seq = m.seq;
          adapter.applyContent(patch(adapter.getContent(), m.d));
          scheduleFollow(m.line);
          break;

        case 'full':
          seq = m.seq | 0;
          synced = true;
          adapter.applyContent(String(m.text ?? ''));
          break;

        case 'need_full':
          // Only the presenter is asked, and only they can answer.
          // 只有演示者会被问到,也只有他答得了。
          send({ t: 'full', for: m.for, text: adapter.getContent(), seq });
          break;

        case 'view':
          if (st.seat !== 'presenter') scheduleFollow(m.line);
          break;

        case 'ink':
        case 'ink_end':
          fire('ink', m);
          break;

        case 'sel':
          if (st.seat !== 'presenter') fire('sel', m);
          break;

        case 'saved':
          fire('saved', m);
          break;
      }
    };

    ws.onclose = () => {
      st.live = false;
      fire('state', st);
      if (closed) return;
      // A dropped socket is a network hiccup far more often than it is the end of anything.
      // Backing off keeps a server that is genuinely gone from being hammered.
      // 掉线绝大多数时候是网络打了个嗝,而不是什么东西结束了。
      // 退避是为了不去捶打一台真的已经不在的服务器。
      tries++;
      setTimeout(connect, Math.min(8000, 400 * 2 ** Math.min(tries, 5)));
    };

    ws.onerror = () => { try { ws.close(); } catch { /* it is already failing / 它已经在出错了 */ } };
  }

  /** Ask the presenter for the document as it stands. Costs one round trip and settles every
   *  question about what this tab is holding.
   *  向演示者要一份此刻的文档。花一个往返,了结关于"这个标签页手上是什么"的所有疑问。 */
  function needFull() { send({ t: 'rejoin' }); }

  // Following is deferred by a frame: several messages often arrive together, and scrolling once
  // at the end of them is both smoother and the only one of the positions that was still true.
  // 跟随推迟一帧:好几条消息常常一起到达,在它们结束时滚这一次,既更顺,
  // 也是那几个位置里唯一仍然成立的那个。
  let followAt = null, followRaf = 0;
  function scheduleFollow(line) {
    if (typeof line !== 'number') return;
    lastSeenLine = line;
    if (!st.following) return;
    followAt = line;
    if (followRaf) return;
    followRaf = requestAnimationFrame(() => {
      followRaf = 0;
      if (st.following && followAt !== null) adapter.scrollToAnchor(followAt);
    });
  }

  /** The presenter's side of the text stream. Sampling rather than hooking the editor's input
   *  event, because the two are not the same thing: an editor changes its text in ways that are
   *  not typing -- a merge, an undo, a tab inserted by a key handler -- and every one of them has
   *  to reach the room. Comparing what is there against what was last sent catches all of them
   *  without the editor having to remember to announce anything.
   *  文本流在演示者这一侧。取样,而不是挂到编辑器的 input 事件上 —— 因为两者不是一回事:
   *  编辑器改动文本的方式不只有打字(一次合并、一次撤销、一个按键处理器插进去的 Tab),
   *  而其中每一种都得抵达房间。拿"现在是什么"去比"上次发的是什么",可以一网打尽,
   *  且不需要编辑器记得去声明任何事。 */
  function sample() {
    if (st.seat !== 'presenter' || !st.live) return;
    const now = adapter.getContent();
    const d = delta(sent, now);
    if (!d) return;
    sent = now;
    seq++;
    send({ t: 'text', seq, d, line: safeAnchor() });
  }

  const safeAnchor = () => {
    try { const a = adapter.getAnchor(); return typeof a === 'number' ? a : null; } catch { return null; }
  };

  let lastLine = null;
  function sampleView() {
    if (st.seat !== 'presenter' || !st.live) return;
    const line = safeAnchor();
    if (line === null || line === lastLine) return;
    lastLine = line;
    send({ t: 'view', line });
  }

  sampleTimer = setInterval(sample, SAMPLE_MS);
  viewTimer = setInterval(sampleView, VIEW_MS);
  connect();

  return {
    state: st,
    on(k, fn) { (handlers[k] || (handlers[k] = [])).push(fn); return this; },
    /** Take the empty chair. Refused by the room unless it really is empty.
     *  坐上那把空椅子。除非它真的空着,否则房间会拒绝。 */
    claim() { send({ t: 'claim' }); },
    /** Say the file was written, so everybody's token is known to be stale.
     *  说一声文件被写下去了,好让所有人都知道自己的令牌过期了。 */
    saved() { send({ t: 'saved' }); },
    ink(m) { if (st.canInk) send(m); },
    /** Say what part of the document is being talked about. Only the presenter is heard.
     *  说出正在谈论的是文档的哪一部分。只有演示者说得出声。 */
    sel(m) { if (st.seat === 'presenter') send({ t: 'sel', ...m }); },
    follow(on) {
      st.following = !!on;
      fire('state', st);
      if (st.following && lastSeenLine !== null) adapter.scrollToAnchor(lastSeenLine);
    },
    leave() {
      closed = true;
      clearInterval(sampleTimer);
      clearInterval(viewTimer);
      try { ws && ws.close(1000, 'bye'); } catch { /* already gone / 已经走了 */ }
      ws = null;
      st.live = false;
    },
  };
}

// ---------- The row of who is here ----------
// ---------- 谁在这儿的那一排 ----------

/** Draw the roster into a container. Kept here rather than in an editor because every editor
 *  wants the same row, and a second copy of it would drift.
 *  把名册画进一个容器。放在这里而不是放进某个编辑器,因为每个编辑器要的都是同一排,
 *  而第二份副本会走样。 */
export function renderRoster(box, st) {
  if (!box) return;
  if (!st.live || !st.peers.length) { box.innerHTML = ''; return; }
  const bits = st.peers.map((p) => {
    const lead = p.seat === 'presenter';
    const style = p.color >= 0 || lead ? ` style="--dot:${inkColour(p.seat, p.color)}"` : '';
    const who = p.peer === st.me ? t('pr_you') : (p.name || t('pr_guest'));
    const what = lead ? t('pr_presenting') : p.seat === 'annotator' ? t('pr_can_draw') : t('pr_watching');
    return `<span class="pr-peer${lead ? ' lead' : ''}${p.seat === 'viewer' ? ' mute' : ''}"${style}
      title="${esc(who)} — ${esc(what)}"><i class="pr-dot"></i>${esc(who)}</span>`;
  });
  box.innerHTML = `<span class="pr-row">${bits.join('')}</span>`;
}
