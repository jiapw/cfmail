// A preview with the window to itself.
//
// The overlay preview is a place you pass through: it sits on the file list, it is sized to be
// got out of. This is the same preview given a tab of its own -- an address that can be sent to
// somebody, reloaded, and stayed in. Every file the overlay can show, this can show, because it
// IS the overlay, opened over an empty page instead of over the list.
//
// It is also where a presentation happens for everything that is not prose. The editor presents
// Markdown; every other kind of file is presented from here -- the presenter's scroll and pen
// travel, watchers follow. What does NOT travel is the document itself: unlike the Markdown room
// there is no text stream, because nothing here can be edited. Everybody loads the same bytes and
// the room only moves their view.
//
// The anchors are the crude, honest kind. Markdown gets source lines; a docx sheet, a slide deck
// or a picture has no lines to offer, so the view anchor is the scroll position as a fraction,
// and ink anchors to content-space pixels normalised by the container's width. On surfaces that
// scale with width -- sheets, slides, pictures, which is what gets presented from here -- that
// lands where it was drawn; on reflowing text it is approximate, and approximate is what a
// pointing gesture needs.
//
// 一个独占窗口的预览。
//
// 浮层预览是一个路过的地方:压在文件列表上,尺寸是为了便于退出。这里是同一个预览,
// 给了它自己的标签页 —— 一个可以发给别人、可以刷新、可以待着的地址。
// 浮层能显示的每一种文件,这里都能,因为它"就是"那个浮层,只是开在一张空页之上,
// 而不是开在列表之上。
//
// 它也是一切"不是散文"的东西被演示的地方。编辑器演示 Markdown;
// 其余每一种文件从这里演示 —— 演示者的滚动与笔会传过去,旁观者跟着走。
// 不会传的是文档本身:与 Markdown 的房间不同,这里没有文本流,因为这里没有可编辑的东西。
// 所有人加载同样的字节,房间只移动他们的视线。
//
// 锚点是粗糙而诚实的那种。Markdown 有源码行号;一张 docx 纸、一套幻灯片、一张图片
// 没有行可给,于是视口锚点是滚动位置的比例,墨水锚到"按容器宽度归一化的内容坐标"。
// 在随宽度等比缩放的界面上 —— 纸、幻灯片、图片,恰恰是会从这里演示的东西 ——
// 它落在画下的地方;在会重排的文本上它是近似的,而"指一下"要的正是近似。
import { t, tErr } from '../i18n.js';
import { esc, icon, qs, settleAfterFullscreen } from '../ui.js';
import { store, navigate } from '../app.js';
import { metaUrl, usePubSource, useDriveSource } from './fsrc.js';
import { joinPresentation } from '../edit/present.js';
import { attachInk } from '../edit/annot.js';
import { attachPresentBar } from '../edit/prbar.js';

const v = () => encodeURIComponent(store.brand?.version || '');

/** The overlay's whole layout -- fixed, full-window, dark ground -- lives in drive.css, which a
 *  fresh tab opened straight at #/view/ has never loaded. Without it the "overlay" is an
 *  unstyled div in normal flow, hiding underneath the backdrop -- a page that looks like it
 *  never showed the document at all.
 *  浮层的整个布局 —— fixed、全窗、深色底 —— 都住在 drive.css 里,而一个直接开在 #/view/
 *  的新标签页从没加载过它。没有它,"浮层"只是普通文档流里的一个无样式 div,
 *  躲在背景页底下 —— 看起来就像根本没显示文档。 */
function ensureDriveCss() {
  if (document.querySelector('link[href^="/assets/drive/drive.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/assets/drive/drive.css?v=' + v();
  document.head.appendChild(l);
}

let fv = null;

/** The solo tab scrolls at PAGE level (see the fv-solo rules in drive.css): the window's own
 *  scrollbar carries the document, and the head is pinned to the window top. So the scrolling
 *  element is always the page's.
 *  独占标签页用页面级滚动(见 drive.css 的 fv-solo 规则):窗口自己的滚动条承载文档,
 *  顶栏钉死在窗口顶部。所以滚动元素永远是页面的那一个。 */
const pageEl = () => document.scrollingElement || document.documentElement;

/** The column the document actually occupies -- what ink coordinates are normalised against.
 *  文档真正占据的那一栏 —— 墨水坐标以它的宽度归一。 */
const inkBox = () => document.querySelector('.drv-view-body .drv-doc') || document.querySelector('.drv-view-body');

/** View anchor: how far down, as a fraction. The one measure that survives two windows of
 *  different sizes showing the same file.
 *  视口锚点:滚了多深,用比例表示。这是唯一能在两扇不同大小的窗口之间成立的量法。 */
const viewFrac = () => {
  const h = pageEl();
  const span = h.scrollHeight - h.clientHeight;
  return span > 0 ? h.scrollTop / span : 0;
};

const adapter = {
  // Nothing here edits, so the text stream never has anything to say.
  // 这里没有能编辑的东西,文本流从头到尾无话可说。
  getContent: () => '',
  applyContent() {},
  getAnchor: viewFrac,
  scrollToAnchor(f) {
    if (typeof f !== 'number') return;
    const h = pageEl();
    fv && (fv.syncing = true);
    h.scrollTop = f * (h.scrollHeight - h.clientHeight);
    requestAnimationFrame(() => { fv && (fv.syncing = false); });
  },
};

/** Ink anchors in width-normalised units: y expressed as a share of the container's width. On
 *  anything that scales with width, the same share lands on the same spot.
 *  墨水锚点用"宽度归一"的单位:y 表示为容器宽度的份额。
 *  凡是随宽度等比缩放的东西,同一份额就落在同一处。 */
const inkAdapter = {
  host: () => document.body,
  box: inkBox,
  lineAt(y) {
    const w = inkBox()?.clientWidth || 1;
    return y / w;
  },
  topOf(l) {
    const w = inkBox()?.clientWidth || 1;
    return l * w;
  },
};

function join() {
  if (!fv) return;
  joinPresentation({
    id: fv.id,
    share: fv.token,
    name: fv.token ? fv.name : '',
    lead: !!fv.lead,
    adapter,
    version: store.brand?.version || '',
  }).then((s) => {
    if (!fv) { s.leave(); return; }
    fv.pres = s;
    fv.ink = attachInk(s, inkAdapter);
    fv.bar = attachPresentBar(s, {
      ink: fv.ink,
      guestPath: 'view',
      guest: !!fv.token,
      // Stopping turns the tab back into a plain full-window preview. The address is rewritten
      // without a navigation, so the preview is not reloaded under the person using it.
      // 停下,让这个标签页变回普通的全窗预览。地址改写但不导航,
      // 预览不会在正用着它的人手底下重新加载。
      onStop: fv.lead ? () => {
        fv.unscroll?.();
        fv.bar?.destroy();
        fv.ink?.destroy();
        fv.pres?.leave();
        fv.bar = fv.ink = fv.pres = null;
        fv.lead = false;
        if (location.hash.endsWith('/present')) {
          history.replaceState(null, '', location.pathname + location.hash.replace(/\/present$/, ''));
        }
      } : null,
      name: fv.name,
      onRename(name) {
        fv.name = name;
        try { localStorage.setItem('cf_present_name', name); } catch { /* private mode / 隐私模式 */ }
        fv.pres?.leave();
        fv.ink?.destroy();
        fv.bar?.destroy();
        join();
      },
    });
    // A leader's scroll is the presentation; a watcher scrolling has chosen to look elsewhere.
    // The page is what scrolls here, so the window is what says so.
    // 主持者的滚动就是演示本身;旁观者一滚,就是选择了看别处。
    // 这里滚动的是页面,所以出声的是窗口。
    const onScroll = () => {
      if (!fv || fv.syncing || !fv.pres) return;
      if (fv.pres.state.seat === 'presenter') return;
      if (fv.pres.state.following) fv.pres.follow(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    fv.unscroll = () => window.removeEventListener('scroll', onScroll);
  }).catch(() => { /* the file is still viewable / 文件照样看得了 */ });
}

/** Open one file full-window. `token` empty means signed-in; `present` asks for the chair.
 *  全窗打开一个文件。token 为空表示登录态;present 表示要那把椅子。 */
export async function renderFullView(token, id, present) {
  if (token) usePubSource(token); else useDriveSource();
  ensureDriveCss();
  const app = qs('#app');
  let node;
  try {
    const meta = await (await fetch(metaUrl(id))).json();
    node = meta.node || meta;
    if (!node || node.kind !== 'file') throw new Error('e_drive_not_found');
  } catch (e) {
    app.innerHTML = `<div class="pub-wrap"><p class="md-err">${esc(tErr(e))}</p></div>`;
    return;
  }

  let name = '';
  try { name = localStorage.getItem('cf_present_name') || ''; } catch { /* private mode / 隐私模式 */ }
  fv = { token: token || '', id, lead: !!present, name, node,
         pres: null, ink: null, bar: null, syncing: false, unscroll: null };
  document.title = node.name;

  // The preview IS the page: there is nothing behind it, so there is no backdrop, and the frame
  // the overlay wears when it floats over a file list is taken off (see the fv-solo rules in
  // drive.css). Closing it -- the X, or Escape -- is therefore leaving the tab's subject, and
  // navigates back to where the file lives instead of stranding an empty page.
  // 预览就是这一页:它背后没有任何东西,所以没有底板;浮在文件列表之上时穿的那圈外框,
  // 在这里也脱掉(见 drive.css 的 fv-solo 规则)。于是"关掉它"(叉,或 Escape)
  // 就是离开这个标签页的主题 —— 导航回文件所在的地方,而不是搁浅在一张空页上。
  app.innerHTML = '';
  document.body.classList.add('fv-solo');

  // After drive.js's own close has run, this tab has nothing left to show.
  // 等 drive.js 自己的关闭跑完,这个标签页就没有可显示的东西了。
  fv.onAway = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    // In fullscreen, Escape belongs to leaving fullscreen; the browser is already using it.
    // 全屏时 Escape 属于"退出全屏" —— 浏览器已经在用它了。
    if (e.type === 'keydown' && document.fullscreenElement) return;
    if (e.type === 'click' && !e.target.closest?.('.drv-view [data-close]')) return;
    setTimeout(() => { if (fv) navigate(fv.token ? `#/p/${encodeURIComponent(fv.token)}` : '#/drive'); }, 0);
  };
  document.addEventListener('click', fv.onAway, true);
  window.addEventListener('keydown', fv.onAway);
  window.addEventListener('hashchange', onHash);

  // ---- Fullscreen: the document alone on the actual screen ----
  // ---- 全屏:只有文档,占据真正的屏幕 ----
  fv.onFs = () => {
    const on = !!document.fullscreenElement;
    document.body.classList.toggle('fv-fs', on);
    if (!on) {
      document.body.classList.remove('fv-peek');
      // An iPad hands the page back a status bar too high after this; put it where it belongs.
      // iPad 在这之后会把页面交还得高出一个状态栏;把它放回原位。
      settleAfterFullscreen();
    }
    // Slides fit the screen by their own ratio; it is read off the first slide and handed to the
    // stylesheet, because CSS can hold an aspect but cannot divide by one.
    // 幻灯片按自己的比例适配屏幕;比例从第一张上读出来交给样式表 ——
    // CSS 装得下一个比例,却不会用它做除法。
    if (on) {
      const sl = document.querySelector('.drv-slide');
      const m = sl && /^\s*([\d.]+)\s*\/\s*([\d.]+)/.exec(getComputedStyle(sl).aspectRatio || '');
      if (m && +m[2] > 0) document.body.style.setProperty('--fs-sar', String((+m[1]) / (+m[2])));
    }
    const b = document.querySelector('[data-fs]');
    if (b) {
      b.innerHTML = icon(on ? 'windowed' : 'fullscreen', 20);
      b.title = t(on ? 'drv_pl_windowed' : 'drv_pl_fullscreen');
    }
  };
  document.addEventListener('fullscreenchange', fv.onFs);

  /** Page flips, for documents that have pages. Left/right and PageUp/PageDown move one page;
   *  everything else keeps its native meaning. Continuous documents fall through untouched.
   *  翻页,给"有页"的文档。左右与 PageUp/Down 走一页;其余按键保持原义。
   *  连续排布的文档原样放行。 */
  fv.onPage = (e) => {
    if (!document.body.classList.contains('fv-fs')) return;
    const fwd = e.key === 'ArrowRight' || e.key === 'PageDown';
    const back = e.key === 'ArrowLeft' || e.key === 'PageUp';
    if (!fwd && !back) return;
    const pages = [...document.querySelectorAll('.drv-pdf-page, .drv-slidewrap, .drv-canvaspage')];
    if (pages.length < 2) return;
    e.preventDefault();
    const sc = document.scrollingElement || document.documentElement;
    const tops = pages.map((el) => Math.round(el.getBoundingClientRect().top + sc.scrollTop));
    const here = sc.scrollTop;
    // The next page is the first top clearly below where we stand; the previous, the last one
    // clearly above. "Clearly" absorbs the sub-pixel noise a fitted page sits on.
    // 下一页是第一个明显低于此处的页顶;上一页是最后一个明显高于此处的。
    // "明显"吃掉的是适配后页面身上那点亚像素噪声。
    const next = tops.find((y) => y > here + 8);
    const prev = [...tops].reverse().find((y) => y < here - 8);
    const to = fwd ? next : prev;
    if (to !== undefined) sc.scrollTop = to;
  };
  window.addEventListener('keydown', fv.onPage);

  // The head hides in fullscreen and peeks back when the pointer visits the top edge.
  // 顶栏在全屏时藏起,指针到访顶缘时探出来。
  let peekRaf = 0;
  fv.onMove = (e) => {
    if (!document.body.classList.contains('fv-fs') || peekRaf) return;
    peekRaf = requestAnimationFrame(() => {
      peekRaf = 0;
      document.body.classList.toggle('fv-peek', e.clientY < 60);
    });
  };
  window.addEventListener('mousemove', fv.onMove);

  const drv = await import(`./drive.js?v=${v()}`);
  drv.openPreviewFor([node], node);
  // Guests join always -- their link exists for the meeting. Signed-in tabs join only when they
  // came to present: a popped-out preview is a reading posture, not an appearance in a room.
  // 访客一律进房间 —— 他们的链接就是为这场会而存在的。登录标签页只在"来演示"时才进:
  // 弹出的全窗预览是一种阅读姿态,不是在某个房间里露面。
  if (fv.token || fv.lead) join();
}

function onHash() {
  if (!/#\/(view|p)\//.test(location.hash) || !location.hash.includes(encodeURIComponent(fv?.id || ''))) close();
}

function close() {
  document.body.classList.remove('fv-solo', 'fv-fs', 'fv-peek');
  if (fv?.onFs) document.removeEventListener('fullscreenchange', fv.onFs);
  if (fv?.onPage) window.removeEventListener('keydown', fv.onPage);
  if (fv?.onMove) window.removeEventListener('mousemove', fv.onMove);
  if (fv?.onAway) {
    document.removeEventListener('click', fv.onAway, true);
    window.removeEventListener('keydown', fv.onAway);
  }
  window.removeEventListener('hashchange', onHash);
  fv?.unscroll?.();
  fv?.bar?.destroy();
  fv?.ink?.destroy();
  fv?.pres?.leave();
  fv = null;
}
