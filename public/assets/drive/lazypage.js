// Deciding WHICH page to build next, for previews whose pages are built one at a time.
//
// A plain observer turns every page that sweeps past during a fast scroll into a job, and each
// job is a parse, a decode, a picture fetched. Flick through a hundred-slide deck and a hundred
// jobs queue up, ninety-nine of them for pages the reader has already left; the one they are
// actually looking at waits behind all of them.
//
// So nothing is queued. A couple of jobs run at a time, and whenever a worker is free it looks
// at where the viewport is NOW and takes the nearest page that has not been built. A page that
// was interesting a moment ago and is no longer on screen is simply never chosen. The effect is
// that a fast scroll builds nothing in the middle and builds what you land on first.
//
// The viewport is the source of truth, not a set of remembered notifications. An observer that
// fires late, or not at all -- a window that is not being painted reports no intersections --
// cannot strand the reader on an unbuilt page, because the next scroll asks the question again
// from scratch.
//
// 决定"下一个该建哪一页" —— 给那些逐页构建的预览用。
//
// 光有观察器,快速滚动时掠过的每一页都会变成一个任务,而每个任务都是一次解析、一次解码、
// 一次取图。在一套百页幻灯片里一划就排起一百个任务,其中九十九个属于读者早已离开的页面;
// 他真正在看的那一页排在所有人后面。
//
// 所以这里不排队。同一时刻跑两个任务,worker 每次空闲都去看视口"此刻"在哪,
// 取最近的、尚未构建的那一页。片刻之前还值得建、如今已不在屏上的页面,根本不会被选中。
// 效果是:快速滚动中途什么都不建,先建你停下来看的那一页。
//
// 真相之源是视口,而不是一堆记下来的通知。观察器迟报、乃至完全不报(没在绘制的窗口
// 不上报任何相交),都不会把读者困在一张没建的页上 —— 下一次滚动会把这个问题重新问一遍。

/**
 * @param {object} o
 * @param {Element|null} o.root the scrolling container, or null when the page itself scrolls and
 *                              the window is the viewport / 滚动容器;页面自身滚动时传 null,视口即窗口
 * @param {Element[]} o.items   one element per page, in document order / 每页一个元素,按文档顺序
 * @param {(el: Element, i: number) => Promise<any>} o.render
 * @param {number} [o.margin]   how far outside the viewport still counts as worth building / 视口外多远仍值得构建
 * @param {number} [o.concurrency]  how many pages may be in flight at once / 同时可有几页在建
 * @returns {{ destroy(): void }}
 */
export function lazyPages({ root, items, render, margin = 600, concurrency = 2 }) {
  // Claimed the moment it is chosen, not when it finishes: with more than one job in flight,
  // marking it only at the end would let the second worker pick the page the first is on.
  // 一经选中即认领,而不是等它完成:同时有多于一个任务在飞时,
  // 若等结束才标记,第二个 worker 会挑中第一个正在做的那一页。
  const taken = new Set();
  let running = 0;
  let dead = false;

  const mid = (el) => {
    const b = el.getBoundingClientRect();
    return b.top + b.height / 2;
  };

  /** The page nearest the middle of the viewport that has not been built, or null when every
   *  page within reach is already there. Found by bisection so a thousand-page document costs
   *  ten measurements, not a thousand.
   *  离视口中线最近、且尚未构建的那一页;射程内都建好了就返回 null。
   *  用二分法找,于是一份千页文档花十次测量而不是一千次。 */
  const pick = () => {
    const r = root ? root.getBoundingClientRect() : { top: 0, height: window.innerHeight };
    const centre = r.top + r.height / 2;
    const limit = r.height / 2 + margin;
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (mid(items[m]) < centre) lo = m + 1;
      else hi = m;
    }
    // Walk outward from there, nearest first, and stop once both directions are out of reach
    // 从那里向两侧走,由近及远,两个方向都出了射程就停
    for (let step = 0; step < items.length; step++) {
      for (const i of step === 0 ? [lo] : [lo - step, lo + step]) {
        if (i < 0 || i >= items.length) continue;
        const el = items[i];
        if (taken.has(el)) continue;
        if (Math.abs(mid(el) - centre) > limit) continue;
        return { el, i };
      }
      if (lo - step < 0 && lo + step >= items.length) break;
    }
    return null;
  };

  // Two at a time, not one and not many. Each job is part waiting on the network -- a ranged
  // read, a picture -- and part work on the main thread; only the waiting overlaps, so a third
  // worker buys nothing and merely delays the first page. Two also matches what a reader can
  // see at once, and keeps the number of already-passed pages that can still land small.
  // 一次两个,不是一个,也不是很多。每个任务一半在等网络(一次 Range 读、一张图),
  // 一半在主线程上干活;只有"等"能重叠,所以第三个 worker 什么也换不来,只会推迟第一页。
  // 二也正好对应读者一眼能看到的页数,并把"已经划过去却仍会落地"的页数压得很小。
  const pump = () => {
    while (!dead && running < concurrency) {
      const next = pick();
      if (!next) return;
      taken.add(next.el);
      running++;
      Promise.resolve()
        .then(() => render(next.el, next.i))
        .catch(() => { /* one page failing must not stop the rest / 一页失败不该拖住其余 */ })
        .finally(() => {
          running--;
          if (!dead) pump();
        });
    }
  };

  // The observer is a nudge, not a record: it says "things moved, look again".
  // 观察器只是一记提醒,而不是一份记录:它说的是"有东西动了,再看一眼"。
  // A null root hands the observer the browser viewport, which is exactly what page-level
  // scrolling means; the scroll events then come from the window for the same reason.
  // root 为 null 时,观察器拿到的就是浏览器视口 —— 页面级滚动的意思正是如此;
  // 同理,滚动事件这时来自窗口。
  const io = new IntersectionObserver(() => pump(), { root: root || null, rootMargin: `${margin}px` });
  for (const el of items) io.observe(el);
  const onScroll = () => pump();
  const st = root || window;
  st.addEventListener('scroll', onScroll, { passive: true });
  pump();

  return {
    destroy() {
      dead = true;
      io.disconnect();
      st.removeEventListener('scroll', onScroll);
    },
  };
}
