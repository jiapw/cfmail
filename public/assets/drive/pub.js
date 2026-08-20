// Public share landing page. Reached without an account, so it may not touch anything that
// assumes a signed-in session (no store.me, no /api/drive/*). Everything it can do is read:
// list the shared items, walk into shared folders and archives, preview and download files.
//
// The reading half is not reimplemented here. The preview overlay and the archive browser are
// the Drive's own, pointed at /api/pub/<token> through fsrc.js -- so a text file, a docx, a
// slide deck or an encrypted 7z behaves for a recipient exactly as it does for the sharer.
// What IS this page's own is the frame around them: the brand lockup, the share's terms, and
// a listing with no selection, no menus and nothing to write with.
//
// 公开分享落地页。无账号即可抵达,因此不能碰任何以"已登录会话"为前提的东西
// (没有 store.me,不用 /api/drive/*)。它能做的一切都是读:列出被分享的条目、
// 进入被分享的目录与压缩包、预览与下载文件。
//
// "读"的那一半没有在这里重写。预览层与压缩包浏览器就是网盘自己的那套,经 fsrc.js 指向
// /api/pub/<token> —— 于是一个文本、一份 docx、一套幻灯片、一个加密 7z,
// 在接收方那里的行为与在分享者那里完全一致。属于本页自己的是它们外面的框:
// 品牌组合、这条分享的条款,以及一个没有选择、没有菜单、无处可写的列表。

import { t, tErr, setLang } from '../i18n.js';
import { esc, icon, qs, qsa, fmtSize, fmtDate, fileIcon, toast } from '../ui.js';
import { store, navigate } from '../app.js';
import { arcHash, arcSeed, dlUrl, folderHash, thumbUrl, usePubSource } from './fsrc.js';

let cssDone = false;
function ensureCss() {
  if (cssDone) return;
  cssDone = true;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/assets/drive/drive.css?v=' + encodeURIComponent(store.brand?.version || '');
  document.head.appendChild(l);
}

const api = async (path) => {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'e_generic');
  return j;
};

const v = () => encodeURIComponent(store.brand?.version || '');
const loadDrive = () => import('./drive.js?v=' + v());
const loadArc = () => import('./arc.js?v=' + v());

/** Same rule as the signed-in drive: a folder's size is the rollup of everything under it.
 *  与登录端一致的口径:目录的大小是其下全部内容的上卷值。 */
const effSize = (n) => (n.kind === 'file' ? n.size || 0 : n.tree_bytes || 0);
const extOf = (name) => (/\.([A-Za-z0-9]{1,12})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();
const ARC_EXTS = new Set(['zip', 'jar', 'apk', 'epub', '7z']);
const IMG_RE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/;

// ---------- Look and feel ----------
// ---------- 观感 ----------

// Palette, light/dark and language are all borrowed from the sharer for the duration of this
// page. The palette is a company setting the page could resolve from its own host, but the
// other two are personal and travel on the share record. None of the three is written to
// localStorage: a visitor who also has an account here would otherwise find their own app
// repainted -- and relabelled -- by a stranger's link.
// 配色、明暗与语言,在本页存续期间都是向分享者借来的。配色是企业设置,页面凭自身主机名
// 也能解析;另外两项则是个人的,随分享记录传来。三者一律不写 localStorage:
// 否则一个在本处也有账号的访问者,会发现自己的应用被一条陌生人的链接重新粉刷、还改了语言。
let lookGuard = null;
function applyShareLook(head) {
  const h = document.documentElement;
  if (!lookGuard) {
    // Remember what this browser looked like before the link touched it, and put it back the
    // moment the visitor leaves the public route.
    // 记下链接介入之前这个浏览器的样子,访问者一离开公开路由就还原回去。
    const saved = { theme: h.dataset.theme, dark: h.classList.contains('wa-dark'), lang: null };
    lookGuard = () => {
      if (/^#\/p\//.test(location.hash)) return;
      h.dataset.theme = saved.theme || 'blue';
      h.classList.toggle('wa-dark', saved.dark);
      h.classList.toggle('wa-light', !saved.dark);
      if (saved.lang) setLang(saved.lang, false);
      window.removeEventListener('hashchange', lookGuard);
      lookGuard = null;
    };
    lookGuard.saved = saved;
    window.addEventListener('hashchange', lookGuard);
  }
  if (head.theme) h.dataset.theme = head.theme;
  if (head.mode) {
    h.classList.toggle('wa-dark', head.mode === 'dark');
    h.classList.toggle('wa-light', head.mode !== 'dark');
  }
  if (head.lang) {
    const prev = setLang(head.lang, false);
    // Keep the FIRST language seen -- walking deeper into the share calls this again, and
    // overwriting would record the borrowed language as the one to restore.
    // 保留"最先见到的"那个语言 —— 在分享里往深处走会再次调到这里,
    // 覆盖的话会把借来的语言记成待还原的语言。
    if (!lookGuard.saved.lang) lookGuard.saved.lang = prev;
  }
}

/** Brand lockup: logo and name at the same visual weight, the name in the brand face.
 *  品牌组合:logo 与名称视觉分量相当,名称使用品牌字体。 */
function brandHtml() {
  const name = store.brand?.name || 'CFMail';
  // 42/32 is the top bar's own logo-to-text ratio (26/20), kept so the lockup on this page is
  // the enlarged version of the one recipients see everywhere else.
  // 42/32 就是顶栏自身的 logo 与文字之比(26/20),沿用它,这个组合便是各处那一个的放大版。
  const logo = store.brand?.logo_url
    ? `<img class="brand-logo" data-logo-mode="${esc(store.brand.logo_mode || 'light')}" style="height:42px" src="${esc(store.brand.logo_url)}" alt="">`
    : icon('cloud', 38);
  return `<div class="brand-lockup pub-brand">${logo}<span>${esc(name)}</span></div>`;
}

/** Header + card frame shared by the listing and the archive browser, so stepping into a zip
 *  changes only what is inside the card.
 *  列表与压缩包浏览器共用的页眉与卡片外框 —— 点进一个 zip,只有卡片内部会变。 */
function frame(head, inner) {
  const meta = [
    t('drv_share_readonly_note'),
    head.expires_at ? t('drv_share_until', fmtDate(head.expires_at)) : '',
    // Present only where an administrator turned the disclosure on; the server decides, and
    // sends an empty string otherwise, so there is nothing here to leak by accident.
    // 只有管理员开启披露时才有值;由服务端决定,否则回空串,此处不会有可意外泄露的东西。
    head.owner_email ? t('drv_share_by', head.owner_email) : '',
  ].filter(Boolean);
  // Keeping the share is about the whole link, not about whichever folder is on screen, so it
  // belongs beside the brand at the top of the page rather than inside the listing's own bar.
  // "留下这条分享"针对的是整条链接,而不是屏幕上碰巧是哪个目录,
  // 因此它属于页顶品牌旁边,而不是列表自己那条 bar 里面。
  return `
    <div class="pub-wrap">
      <div class="pub-head">
        <div class="pub-id">
          ${brandHtml()}
          <div class="pub-meta drv-dim">${meta.map(esc).join(' · ')}</div>
        </div>
        <wa-button class="pub-keep" id="pub-keep" appearance="outlined" hidden>
          ${icon('folder-shared', 20)} <span>${esc(t('drv_share_save'))}</span>
        </wa-button>
      </div>
      <div class="pub-card">${inner}</div>
    </div>`;
}

/** Offered only to someone who has a drive to keep it in. Resolved after the frame paints, so
 *  an anonymous visitor -- the common case -- waits for nothing.
 *  只提供给"有网盘可放"的人。在外框渲染之后才解析,匿名访问者(常态)因此毫无等待。 */
function bindKeep(app, token) {
  hasSession().then((yes) => {
    const btn = qs('#pub-keep', app);
    if (!yes || !btn) return;
    btn.removeAttribute('hidden');
    btn.addEventListener('click', () => keepShare(token, btn));
  });
}

// ---------- Listing ----------
// ---------- 列表 ----------

const layout = () => (localStorage.getItem('cf_drive_layout') === 'grid' ? 'grid' : 'list');

function rowsHtml(nodes) {
  return nodes.map((n, i) => `
    <div class="pub-row pub-it" data-i="${i}">
      <span class="ic">${n.kind === 'folder' ? icon('folder', 22) : fileIcon(n.name, 22)}</span>
      <span class="nm">${esc(n.name)}</span>
      <span class="sz drv-dim">${esc(fmtSize(effSize(n)))}</span>
      <span class="dt drv-dim">${esc(fmtDate(n.updated_at))}</span>
      ${n.kind === 'file' ? `<a class="dl" href="${esc(dlUrl(n.id))}" download title="${esc(t('drv_download'))}">${icon('download', 18)}</a>` : ''}
    </div>`).join('');
}

function cardsHtml(nodes) {
  return `<div class="pub-gridwrap"><div class="drv-grid">${nodes.map((n, i) => {
    // Files uploaded before thumbnails existed have none to serve, and nobody visiting a public
    // link may mint one -- small images fall back to the original, everything else to its icon.
    // 缩略图时代之前上传的文件没有缩略图可发,而公开链接的访问者无权生成 ——
    // 小图退回原图,其余退回类型图标。
    const old = !n.thumb && n.kind === 'file' && IMG_RE.test((n.mime || '').toLowerCase()) && n.size < 20 * 1024 * 1024;
    const media = n.thumb
      ? `<img loading="lazy" src="${esc(thumbUrl(n.id, n.ver_head))}" alt="">`
      : old ? `<img loading="lazy" src="${esc(dlUrl(n.id, true))}" alt="">`
        : fileIcon(n.name, 44);
    return `
    <div class="drv-card pub-it ${esc(n.kind)}" data-i="${i}">
      <div class="thumb">${n.kind === 'folder' ? icon('folder', 56) : media}</div>
      <div class="cap">
        ${n.kind === 'folder' ? `<wa-icon class="fold" name="folder" style="font-size:22px"></wa-icon>` : fileIcon(n.name, 22)}
        <span class="nm" title="${esc(n.name)}">${esc(n.name)}</span>
        <span class="drv-dim sz">${esc(fmtSize(effSize(n)))}</span>
      </div>
    </div>`;
  }).join('')}</div></div>`;
}

// ---------- Keeping the link ----------
// ---------- 留下这条链接 ----------

/** Is anyone signed in? Asked with a bare fetch on purpose: refreshMe() would apply the
 *  visitor's own language and light/dark, undoing the look this page borrowed from the sharer.
 *  Nothing here needs the payload -- only whether a session answered.
 *  有人登录着吗?特意用裸 fetch 问:refreshMe() 会套用访问者自己的语言与明暗,
 *  把本页向分享者借来的观感抹掉。此处不需要返回体 —— 只需要知道会话是否作答。 */
let signedIn = null;
async function hasSession() {
  if (signedIn !== null) return signedIn;
  if (store.me) return (signedIn = true);
  try {
    signedIn = (await fetch('/api/me', { headers: { accept: 'application/json' } })).ok;
  } catch {
    signedIn = false;
  }
  return signedIn;
}

/** Keep a public link: record the membership so the items sit under "shared items" from now
 *  on. Nothing is copied -- what is kept is a pointer to the sharer's live files, so this
 *  costs the recipient no quota and shows them the sharer's latest state. It also grants
 *  nothing new: a public share is read-only whether opened or kept.
 *  留下一条公开链接:记下成员身份,此后这些条目就待在"共享给我"下。不复制任何东西 ——
 *  留下的是指向分享者实时文件的指针,因此不占接收方配额,看到的始终是分享者的最新状态。
 *  它也不授予任何新东西:公开分享无论是打开还是留下,都是只读。 */
async function keepShare(token, btn) {
  btn.setAttribute('loading', '');
  try {
    const r = await fetch('/api/drive/shares/join', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'e_generic');
    const items = j.items || [];
    toast(t('drv_share_joined',
      items.length === 1 ? items[0].name : t('drv_share_n_items', String(items.length))));
    navigate(j.owner ? '#/drive' : '#/drive/shared');
  } catch (e) {
    btn.removeAttribute('loading');
    toast(tErr(e && e.message), true);
  }
}

/** The part of the card the view toggle owns. Everything else on screen -- the brand, the
 *  share's terms, the breadcrumb -- is unaffected by which layout is chosen, so it stays put.
 *  视图切换所管辖的那一块。屏幕上其余的东西 —— 品牌、分享条款、面包屑 ——
 *  与选了哪种布局无关,因此原地不动。 */
const bodyHtml = (nodes) => (nodes.length
  ? (layout() === 'grid' ? cardsHtml(nodes) : `<div class="pub-list">${rowsHtml(nodes)}</div>`)
  : `<div class="drv-empty">${icon('folder', 44)}<div>${esc(t('drv_empty_folder'))}</div></div>`);

/** The toggle shows the view it would switch TO, so it repaints whenever the layout changes.
 *  切换按钮显示的是"按下去会变成哪种视图",因此布局一变它就重画。 */
function paintToggle(btn) {
  if (!btn) return;
  btn.innerHTML = icon(layout() === 'list' ? 'grid' : 'view-list', 20);
  btn.setAttribute('title', layout() === 'list' ? t('drv_view_grid') : t('drv_view_list'));
}

const headCache = new Map(); // token -> landing payload / token -> 落地数据

async function shareHead(token) {
  if (headCache.has(token)) return headCache.get(token);
  const h = await api(`/api/pub/${encodeURIComponent(token)}`);
  headCache.set(token, h);
  return h;
}

function errorPage(app, head, e) {
  app.innerHTML = head
    ? frame(head, `<div class="drv-empty">${icon('link', 48)}<div>${esc(tErr(e && e.message))}</div></div>`)
    : `<div class="pub-wrap"><div class="pub-card">
         <div class="drv-empty">${icon('link', 48)}<div>${esc(tErr(e && e.message))}</div></div>
       </div></div>`;
}

/** @param {string} token @param {string[]} rest path segments below the share root */
export async function renderPubShare(token, rest) {
  ensureCss();
  usePubSource(token);
  const app = qs('#app');
  const segs = rest || [];
  if (segs[0] === 'arc' && segs[1]) return renderPubArc(token, segs[1], segs.slice(2).join('/'));

  const parent = segs.length ? segs[segs.length - 1] : '';
  // Same first frame as the app's own boot screen: the company, centred, with the spinner under
  // it. A recipient arriving from outside should see whose files these are before anything else.
  // 与应用自身启动屏同样的第一帧:企业居中,加载动画在其下。
  // 从外部前来的接收方,理应先看到这是谁家的东西。
  app.innerHTML = `<div class="boot-loading">${brandHtml()}</div>`;

  let head;
  let data;
  try {
    head = await shareHead(token);
    data = await api(`/api/pub/${encodeURIComponent(token)}/list${parent ? '?parent=' + encodeURIComponent(parent) : ''}`);
  } catch (e) {
    return errorPage(app, head, e);
  }
  applyShareLook(head);

  const crumbs = [`<span class="drv-crumb" data-go="">${esc(t('drv_share_root'))}</span>`]
    .concat((data.path || []).map((p, i, arr) => `
      <span class="drv-crumb-sep">${icon('next', 14)}</span>
      <span class="drv-crumb ${i === arr.length - 1 ? 'here' : ''}" data-go="${esc(p.id)}">${esc(p.name)}</span>`))
    .join('');

  const nodes = data.nodes || [];
  app.innerHTML = frame(head, `
    <div class="pub-bar">
      <div class="drv-crumbs">${crumbs}</div>
      <wa-button class="icon" appearance="plain" id="pub-layout"
                 title="${esc(layout() === 'list' ? t('drv_view_grid') : t('drv_view_list'))}">
        ${icon(layout() === 'list' ? 'grid' : 'view-list', 20)}
      </wa-button>
    </div>
    ${head.note ? `<div class="drv-ctx">${esc(head.note)}</div>` : ''}
    <div id="pub-body">${bodyHtml(nodes)}</div>`);

  bindKeep(app, token);

  const bindItems = () => qsa('.pub-it', app).forEach((el) => el.addEventListener('click', async (e) => {
    if (e.target.closest('.dl')) return; // the download link handles itself / 下载链接自己处理
    const n = nodes[parseInt(el.dataset.i, 10)];
    if (!n) return;
    if (n.kind === 'folder') return navigate(folderHash(n.id));
    // An archive opens as a folder, exactly as it does in the Drive. The seed spares the
    // browser a /meta round-trip and gives it the breadcrumb it should show above the zip.
    // 压缩包像在网盘里一样以目录形式打开。种子省掉一次 /meta 往返,
    // 并把该显示在 zip 之上的面包屑交给它。
    if (ARC_EXTS.has(extOf(n.name))) {
      arcSeed.set(n.id, {
        name: n.name, size: n.size, access: 'viewer',
        crumbs: (data.path || []).map((p) => ({ id: p.id, name: p.name })),
      });
      return navigate(arcHash(n.id, ''));
    }
    const drv = await loadDrive();
    drv.openPreviewFor(nodes.filter((x) => x.kind === 'file'), n);
  }));

  // Switching view is not navigation: the listing is already in hand, so only the listing is
  // rebuilt. Re-rendering the page would refetch the share, rebuild the header and blink the
  // brand -- a whole page's worth of work to change how the same rows are drawn.
  // 切换视图不是导航:列表数据已经在手,因此只重建列表。重渲整页会再取一遍分享、重建页眉、
  // 让品牌闪一下 —— 为了换一种画法,付出整页的代价。
  const toggle = qs('#pub-layout', app);
  toggle.addEventListener('click', () => {
    localStorage.setItem('cf_drive_layout', layout() === 'list' ? 'grid' : 'list');
    qs('#pub-body', app).innerHTML = bodyHtml(nodes);
    paintToggle(toggle);
    bindItems();
  });

  qsa('.drv-crumb[data-go]', app).forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.go;
    navigate(id ? folderHash(id) : `#/p/${encodeURIComponent(token)}`);
  }));

  bindItems();
}

/** Archive browsing on a public link: the Drive's own arc.js, painting into this page's card.
 *  公开链接里的压缩包浏览:网盘自己的 arc.js,渲进本页的卡片。 */
async function renderPubArc(token, id, path) {
  const app = qs('#app');
  let head;
  try {
    head = await shareHead(token);
  } catch (e) {
    return errorPage(app, null, e);
  }
  applyShareLook(head);
  // Rebuild the frame only when arriving from elsewhere; walking around inside the archive
  // must not throw away the container arc.js is painting into.
  // 只有从别处过来时才重建外框;在压缩包内部走动不能把 arc.js 正在渲染的容器扔掉。
  let box = qs('#pub-arc', app);
  if (!box) {
    app.innerHTML = frame(head, '<div id="pub-arc" class="pub-arc"></div>');
    box = qs('#pub-arc', app);
    bindKeep(app, token);
  }
  // drive.js first: it is what registers the preview overlay the archive browser opens
  // entries through, and arc.js no longer pulls it in on its own.
  // 先加载 drive.js:压缩包浏览器打开条目所用的预览层由它登记,
  // 而 arc.js 已不再自行引入它。
  await loadDrive();
  const arc = await loadArc();
  await arc.renderArc(id, path, box);
}
