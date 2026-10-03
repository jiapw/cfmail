// Watching what a visitor does with a share, for the person who shared it.
//
// A page cannot be asked afterwards what was read on it; it has to be told as it happens. So
// this module sits beside the preview and listens: a file opened and, when it closes, how long it
// was open; which page of a document is on screen, and for how long before the next one; how much
// of a film has actually played; what was downloaded; which folder was entered. It batches those
// into a short queue and sends the queue every few seconds, and once more on the way out --
// through sendBeacon, which is the one request a closing page is allowed to finish.
//
// Nothing here decides whether to watch. The server says so on the share, and the page that
// opens the share calls trackStart or does not; every function below is a no-op until it has.
//
// 替分享者看着访客在分享里做了什么。
//
// 一个页面没法在事后被问起上面读了什么;只能在发生的当下被告知。所以这个模块坐在预览旁边听着:
// 一个文件被打开,关上时它开了多久;一份文档的哪一页在屏幕上,换到下一页之前停了多久;
// 一部片子真正放了多少;下载了什么;进了哪个文件夹。它把这些攒进一个短队列,每隔几秒送一次,
// 临走再送一次 —— 走 sendBeacon,那是一个正在关闭的页面唯一被允许发完的请求。
//
// 这里不决定要不要看。分享上由服务端说了算,打开分享的那一页要么调 trackStart 要么不调;
// 下面每个函数在那之前都是空操作。

const HEARTBEAT_MS = 30 * 1000;
const FLUSH_MS = 4 * 1000;
const PAGE_MIN_MS = 400;          // a page glimpsed for less is not a page read / 看不到这么久的一页不算读过
const MEDIA_REPORT_MS = 10 * 1000;

let cur = null;

const json = (o) => JSON.stringify(o);
const nodeRef = (n) => ({ node: n?.id || '', name: n?.name || '' });

/** Begin a visit to one share, or carry on the one this browser session already has there.
 *  开始对一条分享的到访;这个浏览器会话里已经有一次的话,就接着那一次。 */
export async function trackStart({ base, key, hints = {} }) {
  if (cur && cur.key === key) return cur;
  if (cur) trackStop();
  const h = {
    ...hints,
    platform: navigator.userAgentData?.platform || navigator.platform || '',
    mobile: !!navigator.userAgentData?.mobile,
    touch: navigator.maxTouchPoints || 0,
    screen: [screen.width, screen.height],
    lang: navigator.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const me = { base, key, vid: null, queue: [], timer: 0, beat: 0, node: null, nodeAt: 0, page: 0, pageAt: 0, total: 0, screen: false, media: new Map(), undo: [] };
  cur = me;
  try {
    // A reload within the same browser session is the same person still here, not a new arrival.
    // 同一个浏览器会话里的一次刷新,是同一个人还在,不是又来了一个。
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('cf_visit:' + key) || 'null'); } catch { /* no session memory */ }
    if (saved?.vid) {
      const r = await fetch(`${base}/visit/${encodeURIComponent(saved.vid)}/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ events: [{ kind: 'resume' }] }),
      });
      if (r.ok) me.vid = saved.vid;
    }
    if (!me.vid) {
      const r = await fetch(`${base}/visit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ hints: h }) });
      if (!r.ok) { if (cur === me) cur = null; return null; }
      const j = await r.json();
      if (!j.id) { if (cur === me) cur = null; return null; }
      me.vid = j.id;
      try { sessionStorage.setItem('cf_visit:' + key, json({ vid: j.id })); } catch { /* then a reload is a new visit */ }
    }
  } catch {
    if (cur === me) cur = null;
    return null;
  }
  if (cur !== me) return null;                       // somebody started another share meanwhile
  const onHide = () => { if (document.visibilityState === 'hidden') { flushPage(); flushMedia(); flush(true); } };
  const onGone = () => leave();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onGone);
  me.undo.push(() => document.removeEventListener('visibilitychange', onHide), () => window.removeEventListener('pagehide', onGone));
  me.beat = setInterval(() => { if (document.visibilityState === 'visible') push({ kind: 'beat' }, true); }, HEARTBEAT_MS);
  return me;
}

/** The visitor is leaving the share: say goodbye with what was on screen, then forget everything.
 *  访客要离开这条分享了:带着屏幕上的东西道个别,然后把一切忘掉。 */
export function trackStop() {
  if (!cur) return;
  leave();
  teardown();
}

function teardown() {
  if (!cur) return;
  clearInterval(cur.beat);
  clearTimeout(cur.timer);
  for (const u of cur.undo) { try { u(); } catch { /* already gone */ } }
  cur = null;
}

/** What is on screen now: the open file and its page, or else the folder being looked at.
 *  此刻屏幕上是什么:开着的文件和它的页,否则就是正在看的那个文件夹。 */
function where() {
  if (!cur) return {};
  if (!cur.node) return cur.folder ? { node: cur.folder.id || '', name: cur.folder.name || '', folder: true } : {};
  const w = { ...nodeRef(cur.node) };
  if (cur.page) { w.page = cur.page; w.total = cur.total; if (cur.screen) w.screen = true; }
  return w;
}

function leave() {
  if (!cur || !cur.vid) return;
  closeCurrent();
  push({ kind: 'leave', detail: { where: where() } });
  flush(true);
}

function push(ev, now = false) {
  if (!cur || !cur.vid) return;
  cur.queue.push(ev);
  if (now) flush();
  else if (!cur.timer) cur.timer = setTimeout(() => flush(), FLUSH_MS);
}

function flush(beacon = false) {
  if (!cur || !cur.vid) return;
  clearTimeout(cur.timer);
  cur.timer = 0;
  const events = cur.queue.splice(0, 50);
  if (!events.length) return;
  const url = `${cur.base}/visit/${encodeURIComponent(cur.vid)}/events`;
  const body = json({ events });
  if (beacon && navigator.sendBeacon) {
    if (navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
  }
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

function flushPage() {
  if (!cur?.node || !cur.page) return;
  const ms = Date.now() - cur.pageAt;
  if (ms >= PAGE_MIN_MS) {
    push({ kind: 'page', ...nodeRef(cur.node), detail: { page: cur.page, total: cur.total, ms, ...(cur.screen ? { screen: true } : {}) } });
  }
  cur.pageAt = Date.now();
}

function flushMedia() {
  if (!cur) return;
  for (const m of cur.media.values()) m.report();
}

function dropWatchers() {
  if (!cur) return;
  for (const u of cur.undo.splice(2)) { try { u(); } catch { /* fine */ } }   // the first two are the page's own
  cur.media.clear();
}

function closeCurrent() {
  if (!cur?.node) return;
  flushPage();
  flushMedia();
  push({ kind: 'close', ...nodeRef(cur.node), detail: { ms: Date.now() - cur.nodeAt } });
  dropWatchers();
  cur.node = null;
  cur.page = 0;
  cur.total = 0;
  cur.screen = false;
}

export const track = {
  /** Is anybody being watched right now. / 此刻有没有在看着谁。 */
  active: () => !!cur?.vid,

  enter(folder) {
    if (cur) cur.folder = { id: folder?.id || '', name: folder?.name || '' };
    push({ kind: 'enter', ...nodeRef(folder) });
  },

  /** A file came on screen. The same file again -- a version switch, a redraw -- is not a new opening.
   *  一个文件上了屏幕。同一个文件再来一次 —— 换版本、重画 —— 不算又打开了一次。 */
  open(node) {
    if (!cur?.vid || !node) return;
    if (cur.node && cur.node.id === node.id) return;
    closeCurrent();
    cur.node = { id: node.id, name: node.name };
    cur.nodeAt = Date.now();
    push({ kind: 'open', ...nodeRef(node), detail: { mime: node.mime || '', size: node.size || 0, kind: node.kind || 'file' } });
  },

  close() {
    closeCurrent();
  },

  /** Page p of total is the one on screen now. Called by whoever knows: an observer over page
   *  elements, a scroller read in screenfuls, a workbook's tabs.
   *  第 p 页(共 total 页)此刻在屏幕上。由知道这件事的人来调:页元素上的观察器、按屏读的滚动条、工作簿的标签。 */
  page(node, p, total, screen = false) {
    if (!cur?.node || cur.node.id !== node.id) return;
    // The count of pages is learned as the document lays itself out, so the latest figure is the
    // one the page being closed is reported against -- not the figure known when it was opened.
    // 页数是文档排版的过程中逐步得知的,所以正要结束的那一页按最新的数来报,
    // 而不是按它刚打开时所知道的那个数。
    cur.total = total;
    if (p === cur.page) return;
    flushPage();
    cur.page = p;
    cur.screen = screen;
    cur.pageAt = Date.now();
  },

  /** Pages that are elements -- PDF pages, slides, diagram pages -- watched for which one fills
   *  the screen most. / 本身是元素的页 —— PDF 页、幻灯片、图表页 —— 看哪一张占屏最多。 */
  pages(node, root, selector) {
    if (!cur?.node || cur.node.id !== node.id || !root) return;
    const els = [...root.querySelectorAll(selector)];
    if (!els.length) return;
    // Two ways of asking the same question. The observer is the cheap one and answers between
    // frames; but a tab in the background draws no frames and the observer falls silent, so the
    // scroll itself is also read, by measuring, and whichever speaks first is believed -- the
    // same page twice is nothing.
    // 问同一个问题的两条路。观察器省力,在帧与帧之间作答;可后台的标签页不画帧,观察器就哑了,
    // 所以滚动本身也读,靠量 —— 谁先开口信谁,同一页说两遍等于没说。
    const ratio = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) ratio.set(e.target, e.intersectionRatio);
      let best = null;
      let most = 0.25;
      for (const [el, r] of ratio) if (r > most) { most = r; best = el; }
      if (best) track.page(node, els.indexOf(best) + 1, els.length);
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    els.forEach((el) => io.observe(el));
    cur.undo.push(() => io.disconnect());
    let scroller = els[0].parentElement;
    while (scroller && scroller !== document.body && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
    const frame = scroller && scroller !== document.body ? scroller : null;
    let timer = 0;
    const measure = () => {
      const top = frame ? frame.getBoundingClientRect().top : 0;
      const bottom = frame ? frame.getBoundingClientRect().bottom : innerHeight;
      let best = -1;
      let most = 0;
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const seen = Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top));
        if (seen > most) { most = seen; best = i; }
      });
      if (best >= 0 && most > 0) track.page(node, best + 1, els.length);
    };
    const onScroll = () => { if (!timer) timer = setTimeout(() => { timer = 0; measure(); }, 200); };
    (frame || window).addEventListener('scroll', onScroll, { passive: true });
    cur.undo.push(() => { (frame || window).removeEventListener('scroll', onScroll); clearTimeout(timer); });
    measure();
  },

  /** Prose and code are one long scroll; what was read is counted in screenfuls.
   *  散文和代码是一条长卷;读了多少按"屏"来数。 */
  scrollPages(node, scroller) {
    if (!cur?.node || cur.node.id !== node.id || !scroller) return;
    let timer = 0;
    const read = () => {
      const h = scroller.clientHeight || 1;
      const total = Math.max(1, Math.ceil((scroller.scrollHeight || h) / h));
      const p = Math.min(total, Math.floor((scroller.scrollTop || 0) / h) + 1);
      track.page(node, p, total, true);
    };
    const onScroll = () => { if (!timer) timer = setTimeout(() => { timer = 0; read(); }, 250); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    cur.undo.push(() => { scroller.removeEventListener('scroll', onScroll); clearTimeout(timer); });
    read();
  },

  /** A workbook's sheets are its pages; the lit tab says which is open.
   *  工作簿的工作表就是它的页;亮着的标签说明开着哪一张。 */
  tabs(node, root, selector, onSelector) {
    if (!cur?.node || cur.node.id !== node.id || !root) return;
    const tabs = [...root.querySelectorAll(selector)];
    if (!tabs.length) { track.page(node, 1, 1); return; }
    const read = () => {
      const i = tabs.findIndex((t) => t.matches(onSelector));
      track.page(node, (i < 0 ? 0 : i) + 1, tabs.length);
    };
    const mo = new MutationObserver(read);
    tabs.forEach((t) => mo.observe(t, { attributes: true, attributeFilter: ['class'] }));
    cur.undo.push(() => mo.disconnect());
    read();
  },

  /** A film or a song: how much of it actually played, counted while it was not paused, and
   *  whether it reached the end. Reported as a running total, so the last report is the truth.
   *  一部片子或一首歌:真正放了多少 —— 只在没暂停的时候计 —— 以及有没有放到头。
   *  报的是累计值,所以最后一次报告就是事实。 */
  media(node, el) {
    if (!cur?.node || cur.node.id !== node.id || !el || el.__tracked) return;
    el.__tracked = true;
    const st = { last: 0, played: 0, ended: false, sent: 0, reported: 0 };
    const report = () => {
      st.sent = Date.now();
      if (st.played < 0.5 && !st.ended) return;
      if (Math.round(st.played) === st.reported && !st.ended) return;
      st.reported = Math.round(st.played);
      push({ kind: 'media', ...nodeRef(node), detail: {
        pos: Math.round(el.currentTime || 0), dur: Math.round(el.duration || 0), played: Math.round(st.played), ended: st.ended,
      } });
    };
    const tick = () => {
      const t = el.currentTime || 0;
      if (!el.paused && st.last && t > st.last) st.played += Math.min(1.5, t - st.last);
      st.last = t;
      if (Date.now() - st.sent > MEDIA_REPORT_MS) report();
    };
    const onEnd = () => { st.ended = true; report(); };
    el.addEventListener('timeupdate', tick);
    el.addEventListener('pause', report);
    el.addEventListener('ended', onEnd);
    cur.media.set(el, { report });
    cur.undo.push(() => { el.removeEventListener('timeupdate', tick); el.removeEventListener('pause', report); el.removeEventListener('ended', onEnd); el.__tracked = false; });
  },

  download(node) {
    if (!cur?.vid || !node) return;
    push({ kind: 'download', ...nodeRef(node), detail: { mime: node.mime || '', size: node.size || 0, kind: node.kind || 'file' } }, true);
  },
};
