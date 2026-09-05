// The pen you talk over.
//
// Somebody is explaining a document out loud and wants to point at part of it. That is all this
// is: a line drawn round a paragraph, an arrow at a sentence, a box round a table. It is a gesture
// rather than a mark -- it belongs to the sentence being spoken, and when that sentence is over it
// has served its purpose. So every stroke fades five seconds after the pen lifts, and nothing is
// ever saved, sent to the server for keeping, or restored to anyone who arrives later.
//
// That decision is what makes this file small. There is no store to reconcile, no history to
// replay for a latecomer, nothing to persist and nothing to clean up: a stroke that arrives after
// its author has left the room still draws, because it carries its own colour, and then it fades
// like every other one. A message lost in transit costs a stroke nobody will miss.
//
// 你一边讲、一边用的那支笔。
//
// 有人正在口头讲解一份文档,想指着其中某处。它就只是这么回事:圈住一段的一条线、
// 指着一句话的一个箭头、框住一张表的一个方框。它是一个手势,不是一个标记 ——
// 它属于正在说的那句话,那句话说完,它的使命也就完成了。
// 所以每一笔在抬笔五秒后淡去,并且从不保存、不送去服务端留着、也不向后来的人回放。
//
// 正是这个决定让这个文件很小。没有存储要对账、没有历史要为迟到者重放、
// 没有东西要持久化、也没有东西要清理:一笔在作者已经离开房间之后才到达的笔迹,照样画得出来 ——
// 因为它自带颜色 —— 然后像其余每一笔那样淡去。途中丢掉一条消息,代价是一笔没人会想念的笔迹。
import { inkPaint } from './present.js';

/** How long a stroke lives after the pen lifts, and how much of that is spent fading. Five
 *  seconds is about one spoken sentence, which is the unit this thing actually belongs to.
 *  一笔在抬笔之后活多久,其中有多久花在淡出上。五秒大约是口头说的一句话,
 *  而"一句话"正是这东西真正所属的单位。 */
const LIFE = 5000;
const FADE = 1200;
/** New points go out in batches. Often enough that watchers see the line being drawn rather than
 *  appearing finished -- watching it grow is most of what makes it a gesture.
 *  新的点成批发出。频率足以让旁观者看见线正在被画出来,而不是看见它已经画完 ——
 *  "看着它长出来"正是它之所以是个手势的大半原因。 */
const FLUSH_MS = 50;

/** A host may be an ordinary scroll container, or the page itself (document.body) when the
 *  surface scrolls at window level. The three differences -- where scrollTop lives, what size
 *  the sheet is, and who emits scroll events -- are settled here so the rest never asks.
 *  host 可以是普通滚动容器,也可以是页面本身(document.body)—— 当界面用窗口级滚动时。
 *  三处不同 —— scrollTop 在哪、这张膜多大、滚动事件谁发 —— 都在这里定夺,其余代码不再过问。 */
const isPage = (h) => h === document.body;
const scrollTopOf = (h) => (isPage(h) ? (document.scrollingElement || document.documentElement).scrollTop : h.scrollTop);
const scrollTarget = (h) => (isPage(h) ? window : h);

/** Draw ink over an editor's rendered document.
 *
 *  `ink` is how this reaches into an editor without knowing which one it is:
 *
 *    host()        -> the scrolling container the ink covers
 *    box()         -> the content box inside it, whose width the ink is measured against
 *    lineAt(y)     -> content-space y to the editor's own anchor unit
 *    topOf(line)   -> and back again
 *
 *  在编辑器渲染出来的文档上画墨水。
 *
 *  ink 是这个文件在不知道对方是谁的情况下伸进编辑器的手:上面四件事。 */
export function attachInk(session, ink) {
  /** Every stroke currently on screen, mine and everybody else's alike. Keyed by an id that is
   *  unique per author, so two people drawing at once never collide.
   *  此刻屏幕上的每一笔,我的和别人的一视同仁。键是按作者唯一的 id,
   *  于是两个人同时画也绝不会撞上。 */
  const live = new Map();
  let canvas = null, cx = null, raf = 0, tool = null, drawing = null, mine = 0;
  let flushTimer = 0, pending = null;

  function fit() {
    const host = ink.host();
    if (!host || !canvas) return;
    // The page host's "window onto the content" is the viewport itself.
    // 页面宿主的"看向内容的窗口",就是视口本身。
    const r = isPage(host)
      ? { width: window.innerWidth, height: window.innerHeight }
      : host.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    // The sheet is exactly the size of the visible box, and then takes back the room it just
    // occupied: it is a layer over the document, not a first paragraph pushing it down.
    // 这张膜正好是可见区域的大小,然后把它刚占掉的位置还回去:
    // 它是盖在文档上的一层,不是把文档往下推的第一段。
    const cssH = Math.round(r.height);
    canvas.style.width = Math.round(r.width) + 'px';
    canvas.style.height = cssH + 'px';
    canvas.style.marginBottom = isPage(host) ? '' : -cssH + 'px';
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Where a stroke's anchor lands right now. Recomputed every frame rather than stored, because
   *  the document underneath it scrolls, re-renders and reflows -- and a gesture that pointed at a
   *  paragraph should go on pointing at that paragraph, not at the place the paragraph used to be.
   *  一笔的锚点此刻落在哪里。每帧重算而不是存下来,因为它底下的文档会滚动、会重渲染、会重排 ——
   *  而一个指着某段话的手势,应该继续指着那段话,不是指着那段话曾经在的位置。 */
  function place(s) {
    const host = ink.host(), box = ink.box();
    if (!host || !box) return null;
    const hr = host.getBoundingClientRect(), br = box.getBoundingClientRect();
    const bw = br.width || 1;
    return {
      x: (br.left - (isPage(host) ? 0 : hr.left)) + s.a.x * bw,
      // The line, plus however far past it the pen actually was.
      //
      // A line number alone cannot say "here" everywhere on the page. The map only knows where
      // blocks begin, and it answers anything outside its range with its nearest end -- so the
      // whole empty stretch below the last paragraph, which can be most of the window, resolves
      // to that paragraph. Ink dropped there would jump hundreds of pixels up the page.
      //
      // Carrying the leftover distance fixes that and buys something else: the stroke stays
      // pinned to the block it was drawn against, and moves with it when the document reflows.
      //
      // 行号,加上笔当时实际超出它多远。
      //
      // 光靠行号说不出页面上任意一处的"这里"。那份映射只知道块从哪里开始,
      // 而范围之外的一律用最近的端点作答 —— 于是最后一段以下那整片空白
      // (它可能占了窗口的大半)全都解析成那一段。落在那里的墨水会往上跳几百像素。
      //
      // 带上剩下的那段距离既修好了它,又顺带买到另一样东西:
      // 笔迹钉在它所对着的那个块上,文档重排时跟着一起走。
      y: ink.topOf(s.a.line) + (s.a.dy || 0) - scrollTopOf(host),
      // The author's box may have been a different width from this one. Scaling by the ratio
      // keeps the shape of the gesture; it is the shape that carries the meaning.
      // 作者那边的盒子宽度可能与这边不同。按比例缩放,保住手势的形状 —— 承载意思的正是形状。
      k: bw / (s.w || bw),
    };
  }

  function stroke(s, alpha) {
    const p = place(s);
    if (!p) return;
    const pts = s.pts;
    if (!pts.length) return;
    cx.save();
    cx.globalAlpha = alpha;
    cx.strokeStyle = s.css;
    cx.lineWidth = s.k === 'rect' ? 2 : 3;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    if (s.k === 'rect') {
      const [dx, dy] = pts[pts.length - 1];
      cx.strokeRect(p.x, p.y, dx * p.k, dy * p.k);
      cx.globalAlpha = alpha * 0.12;
      cx.fillStyle = s.css;
      cx.fillRect(p.x, p.y, dx * p.k, dy * p.k);
    } else {
      cx.beginPath();
      cx.moveTo(p.x, p.y);
      for (const [dx, dy] of pts) cx.lineTo(p.x + dx * p.k, p.y + dy * p.k);
      cx.stroke();
    }
    cx.restore();
  }

  function frame() {
    raf = 0;
    if (!canvas || !cx) return;
    fit();
    cx.clearRect(0, 0, canvas.width, canvas.height);
    const now = performance.now();
    for (const [id, s] of live) {
      // A stroke still being drawn has no age: it is alive as long as the pen is down, however
      // long that takes.
      // 还在画的笔迹没有年龄:笔按着,它就活着,不管按多久。
      const age = s.done ? now - s.done : 0;
      if (age >= LIFE) { live.delete(id); continue; }
      stroke(s, age > LIFE - FADE ? Math.max(0, (LIFE - age) / FADE) : 1);
    }
    if (live.size) raf = requestAnimationFrame(frame);
  }

  const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };

  /** Take one message off the wire and put it on screen. Strokes arrive in pieces -- the first
   *  carries the anchor, the rest carry more points -- so an unknown id with no anchor is a
   *  fragment of something whose beginning was lost, and is dropped rather than guessed at.
   *  从线上取一条消息,放到屏幕上。笔迹是分片到达的 —— 第一片带锚点,其余带更多的点 ——
   *  所以"没见过的 id 又不带锚点"是某个开头已经丢失的东西的碎片:丢掉,而不是去猜。 */
  function incoming(m) {
    const id = String(m.id || '');
    if (!id) return;
    if (m.t === 'ink_end') {
      const s = live.get(id);
      if (s) { s.done = performance.now(); wake(); }
      return;
    }
    let s = live.get(id);
    if (!s) {
      if (!m.a) return;
      s = { a: m.a, w: m.w || 0, k: m.k === 'rect' ? 'rect' : 'pen', pts: [], done: 0,
            css: inkPaint(m.seat, m.color) };
      live.set(id, s);
    }
    if (Array.isArray(m.pts)) {
      // A rectangle is two corners, not a path: the newest point replaces the last rather than
      // extending it, so dragging one out redraws it instead of leaving a trail of boxes.
      // 矩形是两个角而不是一条路径:新的点替换掉上一个而不是接在后面,
      // 于是拖出一个方框是在重画它,而不是留下一串方框。
      if (s.k === 'rect') s.pts = m.pts.slice(-1);
      else for (const p of m.pts) s.pts.push(p);
    }
    wake();
  }

  // ---------- Drawing ----------
  // ---------- 画 ----------

  const flush = () => {
    flushTimer = 0;
    if (!pending) return;
    session.ink(pending);
    pending = null;
  };

  function push(msg) {
    // Points accumulate between flushes so that a fast hand costs one message per fifty
    // milliseconds rather than one per pointer event.
    // 两次发送之间点会累积,于是手快的人每五十毫秒花一条消息,而不是每个指针事件一条。
    if (pending && pending.id === msg.id && msg.t === 'ink' && !msg.a) {
      if (msg.k === 'rect') pending.pts = msg.pts;
      else pending.pts = pending.pts.concat(msg.pts);
    } else {
      if (pending) { session.ink(pending); pending = null; }
      pending = msg;
    }
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  // The fingers currently on the canvas, and where the pair of them last stood.
  //
  // One finger is a pen; two are a hand moving the page. The moment a second finger lands, the
  // stroke the first one started stops being a stroke -- it was the beginning of a grab -- so it
  // is ended on the spot, and from then until every finger lifts, movement scrolls the document
  // instead of drawing on it. The scrolling is done here by hand because the canvas has
  // touch-action:none while the pen is armed: the browser was told to keep its hands off, so the
  // browser cannot be the one to pan.
  //
  // 此刻按在画布上的手指,以及那一对手指上次站的位置。
  //
  // 一根手指是笔;两根是挪动页面的手。第二根手指落下的那一刻,第一根开始的那一笔就不再是一笔 ——
  // 它是一次抓握的开头 —— 所以当场收笔;从那时起直到所有手指抬起,移动滚的是文档,不是画。
  // 滚动在这里手工做,因为笔架起时画布是 touch-action:none:
  // 已经请浏览器把手拿开,平移这件事就不能再指望浏览器来做。
  const fingers = new Map();   // pointerId -> clientY
  let panFrom = null;          // the pair's last average Y / 两指上次的平均 Y
  const pairPan = () => {
    if (fingers.size < 2) { panFrom = null; return; }
    const ys = [...fingers.values()];
    const avg = (ys[0] + ys[1]) / 2;
    const host = ink.host();
    if (panFrom !== null && host) host.scrollTop -= avg - panFrom;
    panFrom = avg;
  };

  function down(e) {
    if (e.pointerType === 'touch') {
      fingers.set(e.pointerId, e.clientY);
      if (fingers.size > 1) {
        if (drawing) up();
        pairPan();
        return;
      }
    }
    if (!tool || !session.state.canInk || e.button !== 0) return;
    const host = ink.host(), box = ink.box();
    if (!host || !box) return;
    const hr = host.getBoundingClientRect(), br = box.getBoundingClientRect();
    const cyc = e.clientY - hr.top + (isPage(host) ? 0 : host.scrollTop);
    const cxc = e.clientX - br.left;
    const line = ink.lineAt(cyc);
    if (line === null || line === undefined) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not fatal / 不致命 */ }
    const id = `${session.state.me || 'me'}-${++mine}`;
    const s = {
      a: { line, x: cxc / (br.width || 1), dy: Math.round(cyc - ink.topOf(line)) },
      w: br.width || 0,
      k: tool,
      pts: [],
      done: 0,
      css: inkPaint(session.state.seat, session.state.color),
    };
    live.set(id, s);
    drawing = { id, s, sx: cxc, sy: cyc, host, box };
    push({ t: 'ink', id, a: s.a, w: s.w, k: s.k, pts: [] });
    wake();
  }

  function move(e) {
    if (e.pointerType === 'touch' && fingers.has(e.pointerId)) {
      fingers.set(e.pointerId, e.clientY);
      if (fingers.size > 1) { pairPan(); return; }
    }
    if (!drawing) return;
    const { host, box, s, sx, sy, id } = drawing;
    const hr = host.getBoundingClientRect(), br = box.getBoundingClientRect();
    // Content-space, so that a document scrolling under a moving pen does not bend the line.
    // 用内容坐标,于是"笔在动、文档在底下滚"不会把线画弯。
    const dx = (e.clientX - br.left) - sx;
    const dy = (e.clientY - hr.top + (isPage(host) ? 0 : host.scrollTop)) - sy;
    const pt = [Math.round(dx), Math.round(dy)];
    if (s.k === 'rect') s.pts = [pt];
    else s.pts.push(pt);
    push({ t: 'ink', id, k: s.k, pts: [pt] });
    wake();
  }

  function up(e) {
    if (e && e.pointerType === 'touch') {
      fingers.delete(e.pointerId);
      if (fingers.size < 2) panFrom = null;
    }
    if (!drawing) return;
    const { id, s } = drawing;
    drawing = null;
    s.done = performance.now();
    flush();
    session.ink({ t: 'ink_end', id });
    wake();
  }

  function build() {
    const host = ink.host();
    if (!host || canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'pr-ink';
    cx = canvas.getContext('2d');
    // A page host gets a viewport-fixed sheet; a container gets the sticky first child that
    // holds still from the top of its document.
    // 页面宿主拿到一张固定在视口上的膜;容器拿到那个从它文档顶部起就不动的 sticky 首子元素。
    if (isPage(host)) {
      canvas.style.position = 'fixed';
      canvas.style.top = '0';
      canvas.style.left = '0';
      document.body.appendChild(canvas);
    } else {
      host.insertBefore(canvas, host.firstChild);
    }
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    fit();
  }

  build();
  session.on('ink', incoming);
  // The ink is anchored to the document, so anything that moves the document moves the ink.
  // 墨水锚在文档上,于是任何让文档移动的事,都会让墨水跟着移动。
  const onScroll = () => wake();
  const st = ink.host() ? scrollTarget(ink.host()) : null;
  st?.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  return {
    /** null puts the pen away and lets clicks reach the document again.
     *  null 收起笔,让点击重新落到文档上。 */
    setTool(k) {
      tool = k === 'pen' || k === 'rect' ? k : null;
      if (canvas) canvas.classList.toggle('on', !!tool);
      return tool;
    },
    tool: () => tool,
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(flushTimer);
      st?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      canvas?.remove();
      canvas = null; cx = null;
      live.clear();
    },
  };
}
