// Drive UI, Google-Drive-flavoured. One folder view with list and grid layouts, selection,
// context menus, drag-drop uploads with a progress panel, a media preview overlay, folder
// sharing and a trash. All data comes from /api/drive/*; texts come from i18n keys drv_*.
// 网盘界面。Google Drive 风格。同一套文件夹视图支持列表/网格两种布局、多选、右键菜单、
// 拖拽上传加进度面板、媒体预览层、文件夹共享与回收站。数据全部走 /api/drive/*。
import { api } from '../api.js';
import { t, tErr, lang } from '../i18n.js';
import {
  esc, icon, qs, qsa, toast, fmtSize, fmtDate, fmtDateTime, confirmDialog, showModal, closeModal,
  copyText, fileIcon, avatar, debounce,
} from '../ui.js';
import { bindTopbar, store, navigate, show, topbarHtml } from '../app.js';
import { arcSeed, dlUrl, DRIVE_CHANNEL, isPub, setPreviewOpener, thumbUrl, useDriveSource, verUrl } from './fsrc.js';
import { editorFor, editorHash } from '../edit/kinds.js';
import { verdict } from './remux.js';
import { codeOf, cuesOf, labelOf, looksBinary, readText, sidecarsFor } from './subs.js';
import { decodeSpu, readIndex, spuAt } from './vobsub.js';
import { mountPlayer, pictureOf } from './player.js';

export { arcSeed };

// Client-side twin of the server's inline whitelist. Only used to decide which preview widget
// to try; the server stays the real gatekeeper.
// 服务端内联白名单的前端影子。只用来决定预览控件的形态。真正把关的仍是服务端。
const IMG_RE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/;
const VID_RE = /^video\/(mp4|webm|ogg|quicktime)$/;
const AUD_RE = /^audio\//;
// The browser often reports no MIME for audio (.aac and friends) -- recognise by extension too
// 浏览器对 .aac 等音频常常不报 MIME,按扩展名兜底识别
const AUD_EXTS = new Set(['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'weba', 'wma', 'mka', 'aiff', 'aif']);
const extOf = (name) => (/\.([A-Za-z0-9]{1,12})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();
// What to put in an address so that it changes when the file does. A versioned file has a version
// to name; one that keeps no history has only the moment it last changed, which serves the same
// purpose here -- a cache is being told the bytes moved, not which bytes they are.
// 往地址里放什么,才能让它随文件一起改变。有版本的文件有版本可指名;
// 不保留历史的只有"它上次改动的那一刻",而在这里两者作用相同 ——
// 我们是在告诉缓存"字节动过了",不是在告诉它那是哪一份字节。
const verTag = (n) => n.ver_head || n.updated_at || '';

// Archives browsable as read-only folders (arc.js, lazy). Extensions map to ranged readers:
// the zip family shares one, 7z has its own.
// 可当只读目录浏览的压缩包(arc.js,懒加载)。扩展名对应 Range 式读取器:
// zip 家族共用一个,7z 单独一个。
const ARC_EXTS = new Set(['zip', 'jar', 'apk', 'epub', '7z']);
/** Node info stashed for arc.js so entering an archive needs no extra request
 *  为 arc.js 暂存的节点信息。进压缩包不用再发请求 */


const dst = {
  view: 'my',            // my | folder | shared | recent | starred | trash | search
  folderId: null,
  q: '',
  nodes: [],
  shown: [],             // 排序后的当前列表
  folders: {},           // 搜索结果用:parent_id → 自根而下的路径 [{id,name}]
  path: [],
  access: 'owner',
  shareRoot: null,
  inTrash: false,
  state: null,           // { used, quota, single_max, part_size, trash_days }
  sort: { key: 'name', dir: 1 },
  layout: localStorage.getItem('cf_drive_layout') || 'list',
  sel: new Set(),
  lastIdx: -1,
};

// ---------- Entry ----------
// ---------- 入口 ----------

function ensureCss() {
  if (qs('link[href^="/assets/drive/drive.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/assets/drive/drive.css?v=' + encodeURIComponent(store.brand?.version || '');
  document.head.appendChild(l);
}

export async function renderDrive(seg) {
  if (!store.me?.drive_enabled) return navigate('#/');
  // Reads go through the signed-in door from here on. The public share page points the same
  // machinery at /api/pub/<token>, so whichever view ran last, claim it back on entry.
  // 从这里起,读取走登录态那扇门。公开分享页把同一套机器指向 /api/pub/<token>,
  // 因此不论上一次跑的是哪个视图,进来时都要把它认领回来。
  useDriveSource();
  ensureCss();
  closePreview(); // navigation never leaves a stray player behind / 路由变化不留悬空播放器
  if (seg[0] === 's' && seg[1]) return joinShare(seg[1]);
  dst.q = '';
  if (!seg[0]) {
    dst.view = 'my';
    dst.folderId = null;
  } else if (seg[0] === 'folder' && seg[1]) {
    dst.view = 'folder';
    dst.folderId = seg[1];
  } else if (['shared', 'recent', 'starred', 'trash', 'links', 'agents'].includes(seg[0])) {
    dst.view = seg[0];
    dst.folderId = null;
  } else if (seg[0] === 'search' && seg[1]) {
    dst.view = 'search';
    dst.q = seg[1];
  } else if (seg[0] === 'arc' && seg[1]) {
    dst.view = 'arc';
    dst.folderId = null;
  } else {
    return navigate('#/drive');
  }
  dst.sel.clear();
  dst.lastIdx = -1;
  show(frame());
  bindFrame();
  refreshState();
  if (dst.view === 'arc') {
    try {
      const mod = await import('./arc.js?v=' + encodeURIComponent(store.brand?.version || ''));
      await mod.renderArc(seg[1], seg.slice(2).join('/'));
    } catch (e) {
      const main = qs('#drv-main');
      if (main) main.innerHTML = `<div class="drv-empty">${icon('spam', 40)}<div>${esc(tErr(e))}</div></div>`;
    }
    return;
  }
  await loadView();
}

/** Opening an internal share link is how a recipient takes it into their own Drive: it records
 *  the membership, and from then on the items sit under "shared items" until the link is
 *  revoked or expires. What it does NOT do is copy anything -- the recipient is looking at the
 *  sharer's live files, so an edit by either side is seen by both.
 *  打开一条内部分享链接,就是接收方把它收进自己网盘的方式:记下成员身份,此后这些条目
 *  一直待在"共享给我"下,直到链接被撤销或过期。它不做的事是复制 —— 接收方看的是分享者的
 *  实时文件,任何一方的改动另一方都看得见。 */
async function joinShare(token) {
  try {
    const r = await api('POST', '/api/drive/shares/join', { token });
    const items = r.items || [];
    toast(t('drv_share_joined',
      items.length === 1 ? items[0].name : t('drv_share_n_items', String(items.length))));
    // One shared folder opens straight into it -- that is what the link was for. Anything else
    // goes to "shared items", the one place a mixed selection can be seen whole. The sharer's
    // own link has no membership behind it, so send them back to their drive instead.
    // 单个共享目录直接进去 —— 链接本就是为此。其余的去"共享给我",那是唯一能完整看到
    // 混合选择的地方。分享者自己的链接背后没有成员身份,因此把他送回自己的网盘。
    if (items.length === 1 && items[0].kind === 'folder') return navigate(`#/drive/folder/${items[0].id}`);
    navigate(r.owner ? '#/drive' : '#/drive/shared');
  } catch (e) {
    toast(tErr(e && e.message), true);
    navigate('#/drive');
  }
}

async function refreshState() {
  try {
    dst.state = await api('GET', '/api/drive/state');
  } catch {
    dst.state = null;
  }
  const box = qs('#drv-quota');
  if (!box || !dst.state) return;
  const pct = dst.state.quota ? Math.min(100, (dst.state.used / dst.state.quota) * 100) : 0;
  box.innerHTML = `
    <div class="drv-quota-bar"><i class="${pct > 90 ? 'warn' : ''}" style="width:${pct.toFixed(1)}%"></i></div>
    ${esc(t('drv_quota_used', fmtSize(dst.state.used), fmtSize(dst.state.quota)))}`;
}

// ---------- Frame ----------
// ---------- 页面框架 ----------

const NAV = [
  { key: 'my', icon: 'cloud', hash: '#/drive' },
  { key: 'shared', icon: 'folder-shared', hash: '#/drive/shared' },
  { key: 'recent', icon: 'clock', hash: '#/drive/recent' },
  { key: 'starred', icon: 'star', hash: '#/drive/starred' },
  { key: 'links', icon: 'link', hash: '#/drive/links' },
  { key: 'agents', icon: 'robot', hash: '#/drive/agents' },
  { key: 'trash', icon: 'trash', hash: '#/drive/trash' },
];

function frame() {
  const active = (k) => (dst.view === k || (k === 'my' && dst.view === 'folder') ? 'active' : '');
  return `
  <div class="shell drv-page">
    ${topbarHtml({
      page: 'drive',
      searchId: 'drv-search',
      searchInputId: 'drv-search-input',
      searchPh: t('drv_search_ph'),
      searchValue: dst.view === 'search' ? dst.q : '',
    })}
    <div class="drv-body">
      <nav class="drv-nav">
        <wa-dropdown id="drv-new-dd">
          <wa-button slot="trigger" class="compose-btn drv-new">${icon('plus', 20)}<span>${esc(t('drv_new'))}</span></wa-button>
          <wa-dropdown-item value="folder">${icon('folder-plus', 18)} ${esc(t('drv_new_folder'))}</wa-dropdown-item>
          <wa-dropdown-item value="md">${icon('fileText', 18)} ${esc(t('drv_new_md'))}</wa-dropdown-item>
          <wa-dropdown-item value="txt">${icon('fileText', 18)} ${esc(t('drv_new_txt'))}</wa-dropdown-item>
          <wa-dropdown-item value="files">${icon('upload', 18)} ${esc(t('drv_upload_files'))}</wa-dropdown-item>
          <wa-dropdown-item value="dir">${icon('upload', 18)} ${esc(t('drv_upload_folder'))}</wa-dropdown-item>
        </wa-dropdown>
        ${NAV.map((n) => `
          <a class="drv-nav-item ${active(n.key)}" href="${n.hash}">
            ${icon(n.icon, 20)}<span class="lbl">${esc(t('drv_' + n.key))}</span>
          </a>`).join('')}
        <div class="drv-quota" id="drv-quota"></div>
      </nav>
      <main class="drv-main" id="drv-main"><div class="loading">${esc(t('loading'))}</div></main>
    </div>
    <input type="file" id="drv-file-input" multiple hidden>
    <input type="file" id="drv-dir-input" webkitdirectory hidden>
  </div>`;
}

function bindFrame() {
  // Sidebar toggle and the account menu come from the shared top bar
  // 侧栏开关与账号菜单由共用顶栏统一接线
  bindTopbar();
  qs('#drv-search')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = qs('#drv-search input').value.trim();
    if (v) navigate(`#/drive/search/${encodeURIComponent(v)}`);
  });
  qs('#drv-new-dd')?.addEventListener('wa-select', (e) => {
    const v = e.detail?.item?.value;
    if (v === 'folder') newFolderDialog();
    else if (v === 'md') newMarkdownDialog();
    else if (v === 'txt') newTextDialog();
    else if (v === 'files') qs('#drv-file-input')?.click();
    else if (v === 'dir') qs('#drv-dir-input')?.click();
  });
  qs('#drv-file-input')?.addEventListener('change', (e) => {
    enqueueFiles([...e.target.files].map((f) => ({ file: f, rel: '' })));
    e.target.value = '';
  });
  qs('#drv-dir-input')?.addEventListener('change', (e) => {
    enqueueFiles([...e.target.files].map((f) => ({ file: f, rel: f.webkitRelativePath || '' })));
    e.target.value = '';
  });
}

function currentSeg() {
  return location.hash.replace(/^#\/?/, '').split('/').map((s) => decodeURIComponent(s)).slice(1);
}

/** The folder new content lands in. 'root' outside a folder view.
 *  新内容落进哪个文件夹。非文件夹视图时为根目录。 */
function currentParent() {
  return dst.view === 'folder' ? dst.folderId : 'root';
}

function canWriteHere() {
  if (dst.inTrash || dst.view === 'trash' || dst.view === 'shared') return false;
  if (dst.view === 'folder') return dst.access !== 'viewer';
  return dst.view === 'my' || dst.view === 'recent' || dst.view === 'starred' || dst.view === 'search';
}

// ---------- Views ----------
// ---------- 各视图 ----------

async function loadView() {
  const main = qs('#drv-main');
  if (!main) return;
  try {
    if (dst.view === 'my' || dst.view === 'folder') {
      const data = await api('GET', `/api/drive/list?parent=${encodeURIComponent(currentParent())}`);
      dst.nodes = data.nodes;
      dst.folders = {};
      dst.path = data.path || [];
      dst.access = data.access || 'owner';
      dst.shareRoot = data.share_root || null;
      dst.inTrash = !!data.in_trash;
      renderFolderView(main);
    } else if (dst.view === 'shared') {
      // Drawn by the folder renderer rather than a table of its own. That is what makes the
      // layout switch mean something here, and what gives these rows the preview, the download
      // and the menu that every other listing has -- three separate absences that were all the
      // same absence: this screen was not a listing, it was a report about one.
      // 交给文件夹渲染器来画,而不是自备一张表格。正是这一点让"切换视图"在这里有了含义,
      // 也让这些行有了别处每份列表都有的预览、下载和菜单 ——
      // 三处各自的缺失其实是同一处缺失:这块屏幕不是一份列表,而是一份关于列表的报告。
      const data = await api('GET', '/api/drive/shared');
      dst.nodes = data.shares || [];
      dst.folders = {};
      dst.path = [];
      // Someone else's nodes. Whatever this account may do inside a share it does inside it,
      // never to the share's own root from out here.
      // 别人的节点。本账号在共享内部能做什么就在内部做,绝不在这里对共享的根动手。
      dst.access = 'viewer';
      dst.shareRoot = null;
      dst.inTrash = false;
      renderFolderView(main);
    } else if (dst.view === 'links' || dst.view === 'agents') {
      const data = await api('GET', '/api/drive/shares');
      // One endpoint, two screens. The share list is the whole inventory of what this account
      // has handed out, agent links included but kept in a group of their own -- the question
      // "what have I exposed" wants everything in one place, while the question "which link is
      // that job using" wants only the ones a program holds. Same rows, same revoke, two
      // readings, so neither screen has to be the compromise between them.
      // 一个端点,两块屏。分享列表是本账号交出去的全部清单,AI 链接也在其中,但自成一组 ——
      // "我都暴露了什么"这个问题要的是所有东西在同一处,
      // "那个任务用的是哪条"要的只是程序持有的那些。同样的行、同样的撤销,两种读法,
      // 于是哪一块都不必是两者的折中。
      const all = data.shares || [];
      if (dst.view === 'agents') renderAgentsView(main, all.filter((s) => s.audience === 'agent'));
      else renderLinksView(main, all);
    } else {
      const ep = { recent: '/api/drive/recent', starred: '/api/drive/starred', trash: '/api/drive/trash', search: `/api/drive/search?q=${encodeURIComponent(dst.q)}` }[dst.view];
      const data = await api('GET', ep);
      dst.nodes = data.nodes;
      dst.folders = data.folders || {};
      dst.path = [];
      dst.access = 'owner';
      dst.shareRoot = null;
      dst.inTrash = dst.view === 'trash';
      renderFolderView(main);
    }
  } catch (e) {
    main.innerHTML = `<div class="drv-empty">${icon('spam', 40)}<div>${esc(e.message)}</div></div>`;
  }
}

const reload = () => loadView().then(refreshState);
const reloadSoon = debounce(reload, 600);

/** Effective size: a file's own bytes, a folder's materialised subtree total
 *  有效大小。文件是自身字节数,文件夹是物化的子树总量 */
const effSize = (n) => (n.kind === 'file' ? n.size || 0 : n.tree_bytes || 0);

function sortNodes(nodes) {
  const { key, dir } = dst.sort;
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    let r = 0;
    if (key === 'size') r = effSize(a) - effSize(b);
    else if (key === 'updated_at') r = (a.updated_at || 0) - (b.updated_at || 0);
    if (!r) r = String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
    return r * dir;
  });
}

function crumbsHtml() {
  if (dst.view !== 'my' && dst.view !== 'folder') {
    return `<span class="drv-crumb here">${esc(t('drv_' + dst.view))}${dst.view === 'search' ? ` · ${esc(dst.q)}` : ''}</span>`;
  }
  const root = dst.access === 'owner'
    ? `<span class="drv-crumb" data-nav="#/drive">${esc(t('drv_my'))}</span>`
    : `<span class="drv-crumb" data-nav="#/drive/shared">${esc(t('drv_shared'))}</span>`;
  const parts = dst.path.map((p, i) => {
    const last = i === dst.path.length - 1;
    return `<span class="drv-crumb-sep">${icon('next', 14)}</span>
      <span class="drv-crumb ${last ? 'here' : ''}" title="${esc(p.name)}" ${last ? '' : `data-nav="#/drive/folder/${esc(p.id)}"`}>${esc(p.name)}</span>`;
  }).join('');
  return root + parts;
}

function renderFolderView(main) {
  dst.shown = sortNodes(dst.nodes);
  // Search answers from everywhere at once, so it is shown gathered by address. shown is
  // rewritten in the grouped order and stays the one flat list every index refers to --
  // shift-select, marquee and drag all keep counting through the headings as if they were air.
  // 搜索是从四面八方一起答的,所以按地址归拢着显示。shown 按归拢后的顺序重写,
  // 并且仍是那唯一一份、所有下标都指向它的扁平列表 —— 范围选择、框选、拖动
  // 数过标题时就像数过空气一样。
  const groups = dst.view === 'search' ? groupByFolder(dst.shown) : null;
  if (groups) dst.shown = groups.flatMap((g) => g.nodes);
  const selN = dst.sel.size;
  const trashCtx = dst.view === 'trash' || dst.inTrash;
  const arrow = (k) => (dst.sort.key === k ? `<span class="arr">${dst.sort.dir > 0 ? '▲' : '▼'}</span>` : '');

  const banner = trashCtx && dst.view === 'trash'
    ? `<div class="drv-trashbar">${icon('trash', 18)}<span>${esc(t('drv_trash_note', dst.state?.trash_days || 30))}</span><span class="sp"></span>
        <wa-button size="small" appearance="outlined" id="drv-empty-trash" ${dst.nodes.length ? '' : 'disabled'}>${esc(t('drv_trash_empty_btn'))}</wa-button></div>`
    : dst.inTrash && dst.view === 'folder'
      ? `<div class="drv-trashbar">${icon('trash', 18)}<span>${esc(t('drv_in_trash_banner'))}</span></div>`
      : '';

  const shareBanner = dst.access !== 'owner' && (dst.view === 'folder')
    ? `<div class="drv-ctx">${icon('folder-shared', 18)}<span>${esc(t('drv_role'))} · ${esc(t(dst.access === 'editor' ? 'drv_role_editor' : 'drv_role_viewer'))}</span></div>`
    : '';

  main.innerHTML = `<div id="drv-bar">${barHtml()}</div>${banner}${shareBanner}
    <div class="drv-scroll" id="drv-drop">
      ${dst.shown.length ? (dst.layout === 'grid' ? gridHtml(groups) : tableHtml(arrow, groups)) : emptyHtml()}
    </div>`;
  bindFolderView(main);
  // A "locate uploaded item" jump lands here: select the target and scroll it into view
  // "定位已上传项"的跳转落到这里:选中目标并滚动到可见
  if (dst.selectAfterLoad) {
    const want = dst.selectAfterLoad;
    dst.selectAfterLoad = null;
    if (dst.shown.some((n) => n.id === want)) {
      dst.sel = new Set([want]);
      applySelection(main);
      const el = qs(`#drv-drop [data-id="${cssEsc(want)}"]`, main);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

/** CSS.escape with a plain fallback for attribute-selector safety / 属性选择器安全转义 */
const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

function barHtml() {
  const selN = dst.sel.size;
  // Only a multi-selection (2+) takes over the bar with batch actions; with 0 or 1 selected
  // the path bar stays put -- a single item's actions live on its row/card ⋮ menu.
  // 只有多选(≥2)才用批量操作栏接管;选中 0 或 1 个时路径 bar 保持不变 ——
  // 单个条目的操作在其行/卡片的 ⋮ 菜单里。
  return selN >= 2
    ? `<div class="drv-selbar">
        <wa-button class="icon" appearance="plain" id="drv-sel-clear" aria-label="${esc(t('cancel'))}">${icon('close', 20)}</wa-button>
        <span class="cnt">${esc(selN === 1 ? t('drv_sel_one') : t('drv_sel_n', selN))}</span>
        ${selActionsHtml()}
      </div>`
    : `<div class="drv-crumbbar"><div class="drv-crumbs">${crumbsHtml()}</div><span class="sp"></span>${barToolsHtml()}</div>`;
}

/** The buttons that sit at the right end of the path bar: view mode, then refresh.
 *  路径栏右端的按钮:视图切换,然后刷新。 */
function barToolsHtml() {
  return `<wa-button class="icon" appearance="plain" id="drv-layout" aria-label="${esc(dst.layout === 'list' ? t('drv_view_grid') : t('drv_view_list'))}" title="${esc(dst.layout === 'list' ? t('drv_view_grid') : t('drv_view_list'))}">${icon(dst.layout === 'list' ? 'grid' : 'view-list', 18)}</wa-button>
      <wa-button class="icon" appearance="plain" id="drv-refresh" aria-label="${esc(t('refresh'))}" title="${esc(t('refresh'))}">${icon('refresh', 18)}</wa-button>`;
}

function bindBar(main) {
  qsa('#drv-bar .drv-crumb[data-nav]', main).forEach((el) =>
    el.addEventListener('click', () => navigate(el.dataset.nav)));
  qs('#drv-refresh', main)?.addEventListener('click', reload);
  // View mode lives in the path bar now, so it is re-bound on every bar redraw
  // 视图切换现在在路径栏里,所以每次重绘这条栏都要重新绑定
  qs('#drv-layout', main)?.addEventListener('click', () => {
    dst.layout = dst.layout === 'list' ? 'grid' : 'list';
    localStorage.setItem('cf_drive_layout', dst.layout);
    renderDrive(currentSeg());
  });
  qs('#drv-sel-clear', main)?.addEventListener('click', () => {
    dst.sel.clear();
    applySelection(main);
  });
  qsa('#drv-bar [data-act]', main).forEach((b) => b.addEventListener('click', () => runSelAction(b.dataset.act)));
}

/** Selection changes patch classes and the toolbar in place -- rebuilding the scroll container
 *  would reset its scroll position and eat the second click of every double-click.
 *  选中变化只原地改 class 和工具条 —— 重建滚动容器会丢滚动位置,还会吃掉双击的第二击。 */
function applySelection(main) {
  qsa('#drv-drop [data-id]', main).forEach((el) => el.classList.toggle('sel', dst.sel.has(el.dataset.id)));
  const bar = qs('#drv-bar', main);
  if (bar) {
    bar.innerHTML = barHtml();
    bindBar(main);
  }
}

/**
 * Shift-click: add everything between the clicked index and the nearer end of what is already
 * selected. Anchoring on the nearer end rather than on the last item touched keeps reaching
 * up and reaching down symmetrical, and the existing selection is never thrown away.
 * shift 点击:把点击处与既有选区中较近的那一端之间的项全部选上。以"较近的一端"为锚点
 * (而不是"上一次点过的项"),向上够与向下够对称;已选的内容不会被清掉。
 */
function extendSelectionTo(hit) {
  const picked = dst.shown.map((n, i) => (dst.sel.has(n.id) ? i : -1)).filter((i) => i >= 0);
  if (!picked.length) {
    dst.sel.add(dst.shown[hit].id);
    return;
  }
  const lo = picked[0];
  const hi = picked[picked.length - 1];
  const anchor = Math.abs(hit - lo) <= Math.abs(hit - hi) ? lo : hi;
  for (let i = Math.min(anchor, hit); i <= Math.max(anchor, hit); i++) dst.sel.add(dst.shown[i].id);
}

/**
 * Rubber-band selection. Drag on empty space to sweep a rectangle: a plain drag replaces the
 * selection, ctrl/cmd-drag adds to it. Starting the drag on an item is left alone so that
 * click, double-click and drag-to-move keep working.
 *
 * 框选。在空白处按下拖动扫出一个矩形:普通拖动替换选区,ctrl/cmd 拖动追加。
 * 在条目上按下不接管 —— 那样点击、双击、拖动移动才不会被打断。
 */
// Set when a marquee drag finishes, read by the row click handler right after.
// 框选拖动结束时置位,紧接着由行点击处理读取。
// Our own drag type. It is what tells an item being moved inside the drive apart from a file
// dragged in from the desktop, so the upload drop zone and the move-into-folder drop never fight.
// 内部拖动专用的 MIME。靠它区分"网盘内移动条目"与"从桌面拖文件进来",
// 上传落点与移动落点因此不会互相抢。
const DRAG_MIME = 'application/x-cfmail-drive';
// The ids currently being dragged. dataTransfer is deliberately unreadable during dragover in
// most browsers, so the payload is kept here too and only read back from dataTransfer on drop.
// 正在拖动的 id。多数浏览器在 dragover 期间刻意不让读 dataTransfer,
// 因此这里另存一份,drop 时才从 dataTransfer 回读。
let dragIds = null;

let marqueeJustDragged = false;

/**
 * Drag items onto a folder to move them there. Dragging an unselected item picks it up on
 * its own; dragging a selected one carries the whole selection. A folder that is itself
 * being dragged cannot be its own destination, so selected folders never light up.
 *
 * 把条目拖到文件夹上即移动过去。拖一个未选中的条目,就只拖它自己;拖一个已选中的,
 * 整个选区一起走。正在被拖动的文件夹不能作为自己的落点,所以选中的文件夹不会高亮。
 */
/**
 * Drag image for a multi-selection: the real tiles, cloned whole -- background, thumbnail,
 * caption and all -- stacked with a small offset and topped with a count.
 *
 * Geometry is computed from the tile actually being dragged rather than hard-coded, so the
 * badge lands exactly on the top card's corner in either view: the stack occupies
 * tileW + (n-1)*OFF by tileH + (n-1)*OFF, the top card sits at (0, B/2), and the badge is
 * centred on that card's top-right corner. The container reserves B/2 on the top and right
 * for the badge, because anything outside the element's box is not part of the snapshot.
 *
 * 多选时的拖动影像:把真实 tile 整个克隆下来 —— 背景、缩略图、标题一并保留 ——
 * 错开叠放,右上角带数量。
 *
 * 几何尺寸取自正在被拖的那个 tile,而不是写死,所以两种视图里角标都正好压在最上层卡片的角上:
 * 整叠占 tileW + (n-1)*OFF 宽、tileH + (n-1)*OFF 高,最上层卡片位于 (0, B/2),
 * 角标以该卡片右上角为圆心。容器在上方和右侧各留 B/2 给角标 ——
 * 超出元素盒子的部分不会被截进影像。
 */
function setStackDragImage(e, ids, srcEl) {
  const SHOWN = 3;      // deeper stacks are clutter, not information / 再多层只是杂乱
  const OFF = 8;        // step between stacked cards / 每层错开
  const B = 20;         // badge diameter / 角标直径
  const MAXW = 340;     // list rows span the whole table; keep the ghost a sane size
                        // 列表行有整个表格那么宽,影像要收在合理尺寸内

  // The dragged tile goes on top; the rest fill in behind it
  // 被拖的那个放最上层,其余垫在后面
  const rest = ids.filter((id) => id !== srcEl.dataset.id)
    .map((id) => qs(`#drv-drop [data-id="${cssEsc(id)}"]`))
    .filter(Boolean);
  const els = [srcEl, ...rest].slice(0, SHOWN);
  const r = srcEl.getBoundingClientRect();
  const tileW = Math.min(r.width, MAXW);
  const tileH = r.height;
  if (!tileW || !tileH) return;
  const n = els.length;

  const ghost = document.createElement('div');
  ghost.className = 'drv-dragghost';
  ghost.style.width = `${tileW + (n - 1) * OFF + B / 2}px`;
  ghost.style.height = `${tileH + (n - 1) * OFF + B / 2}px`;

  // Last in the DOM paints on top, so walk the stack back to front
  // DOM 里靠后的画在上层,所以从最底层往最上层放
  els.slice().reverse().forEach((el, k) => {
    const depth = n - 1 - k;                     // 0 = topmost / 0 为最上层
    const slot = document.createElement('div');
    slot.className = 'gslot';
    slot.style.width = `${tileW}px`;
    slot.style.height = `${tileH}px`;
    slot.style.transform = `translate(${depth * OFF}px, ${B / 2 + depth * OFF}px)`;
    const clone = el.cloneNode(true);
    clone.classList.remove('sel');               // 影像里不要选中态的底色
    clone.removeAttribute('draggable');
    if (el.tagName === 'TR') {
      // A <tr> renders as nothing on its own -- it needs a table, and the original colgroup
      // to keep the columns the same width as what the user is looking at.
      // 单独一个 <tr> 什么都渲染不出来 —— 得给它一张表,并带上原来的 colgroup,
      // 列宽才和用户正看着的一致。
      const src = el.closest('table');
      const tbl = document.createElement('table');
      tbl.className = src?.className || 'drv-table';
      tbl.style.width = `${r.width}px`;
      const cg = src?.querySelector('colgroup');
      if (cg) tbl.appendChild(cg.cloneNode(true));
      const tb = document.createElement('tbody');
      tb.appendChild(clone);
      tbl.appendChild(tb);
      slot.appendChild(tbl);
    } else {
      slot.appendChild(clone);
    }
    ghost.appendChild(slot);
  });

  if (n > 1) {
    const badge = document.createElement('span');
    badge.className = 'gcount';
    badge.textContent = String(ids.length);
    // Centred on the top card's top-right corner: that card spans x:[0,tileW], y:[B/2, ...]
    // 以最上层卡片的右上角为圆心:该卡片横跨 x:[0,tileW],纵向自 y:B/2 起
    badge.style.left = `${tileW - B / 2}px`;
    badge.style.top = '0px';
    ghost.appendChild(badge);
  }

  document.body.appendChild(ghost);
  // Grab it just inside the top card so the stack tracks the pointer instead of trailing it
  // 抓取点落在最上层卡片内侧,整叠才跟着指针走、不拖在后面
  e.dataTransfer.setDragImage(ghost, 24, B / 2 + 20);
  // The snapshot is taken synchronously during this event; the node is only needed until the
  // current task ends.
  // 截图在本次事件里同步完成,节点只需活到当前任务结束。
  setTimeout(() => ghost.remove(), 0);
}

function bindItemDrag(box, main) {
  if (!canWriteHere()) return;

  box.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[data-id]');
    if (!el) return;
    const id = el.dataset.id;
    // Dragging something outside the selection replaces it -- the same as every file manager
    // 拖动选区之外的条目会替换选区 —— 与各家文件管理器一致
    if (!dst.sel.has(id)) {
      dst.sel.clear();
      dst.sel.add(id);
      applySelection(main);
    }
    dragIds = [...dst.sel];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_MIME, dragIds.join(','));
    // Some browsers refuse a drag with no text/plain payload
    // 有些浏览器在没有 text/plain 时不肯启动拖动
    e.dataTransfer.setData('text/plain', '');
    // The default ghost is only the tile under the cursor, which is a lie when several are
    // moving. Show the stack instead.
    // 默认的拖动影像只有指针下那一个,多选时是在骗人。改成显示整叠。
    if (dragIds.length > 1) setStackDragImage(e, dragIds, el);
  });

  box.addEventListener('dragend', () => {
    dragIds = null;
    qsa('.drv-dropinto', main).forEach((el) => el.classList.remove('drv-dropinto'));
  });

  /** The folder element under the pointer that this drag may legally land on.
   *  指针下方、本次拖动可以合法落入的那个文件夹元素。 */
  const dropTarget = (e) => {
    if (!dragIds) return null;
    const el = e.target.closest('[data-id]');
    if (!el) return null;
    const n = dst.shown.find((x) => x.id === el.dataset.id);
    if (!n || n.kind !== 'folder') return null;
    // Never into something that is itself moving / 不能落进正在被移动的东西里
    if (dragIds.includes(n.id)) return null;
    return el;
  };

  box.addEventListener('dragover', (e) => {
    const el = dropTarget(e);
    qsa('.drv-dropinto', main).forEach((x) => { if (x !== el) x.classList.remove('drv-dropinto'); });
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drv-dropinto');
  });

  box.addEventListener('drop', async (e) => {
    const el = dropTarget(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drv-dropinto');
    const ids = dragIds;
    const dest = el.dataset.id;
    dragIds = null;
    if (!ids?.length) return;
    try {
      for (const id of ids) await api('POST', `/api/drive/nodes/${id}/move`, { parent: dest });
      dst.sel.clear();
      toast(t('drv_moved_toast'));
      reload();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function bindMarquee(box, main) {
  // A drag cut short by a re-render can leave its rectangle behind on <body>; clear any stray.
  // 拖动中途被重绘打断,矩形会留在 <body> 上;这里先清掉任何残留。
  qsa('.drv-marquee').forEach((el) => el.remove());
  const THRESHOLD = 4; // px before a press counts as a drag, not a click / 超过这个距离才算拖动
  let start = null;
  let boxEl = null;
  let base = null;

  const hitTest = () => {
    const r = boxEl.getBoundingClientRect();
    for (const el of qsa('#drv-drop [data-id]', main)) {
      const b = el.getBoundingClientRect();
      const overlaps = b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
      const id = el.dataset.id;
      if (overlaps) dst.sel.add(id);
      else if (!base.has(id)) dst.sel.delete(id);
    }
    qsa('#drv-drop [data-id]', main).forEach((el) => el.classList.toggle('sel', dst.sel.has(el.dataset.id)));
  };

  const move = (e) => {
    if (!start) return;
    // The button is already up -- it was released outside the window, so mouseup never reached
    // us. Finish here, or the rectangle would hang on screen until the next render.
    // 按键已经是松开状态 —— 是在窗口外松的,mouseup 根本没送到这里。
    // 必须就地收尾,否则矩形会一直挂在屏幕上,直到下一次重绘。
    if (e.buttons === 0) { up(); return; }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!boxEl) {
      if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
      boxEl = document.createElement('div');
      boxEl.className = 'drv-marquee';
      document.body.appendChild(boxEl);
      // A plain drag starts from nothing; ctrl/cmd keeps what was already selected
      // 普通拖动从零开始;ctrl/cmd 保留原有选中
      if (!start.additive) dst.sel.clear();
      base = new Set(dst.sel);
    }
    boxEl.style.left = Math.min(start.x, e.clientX) + 'px';
    boxEl.style.top = Math.min(start.y, e.clientY) + 'px';
    boxEl.style.width = Math.abs(dx) + 'px';
    boxEl.style.height = Math.abs(dy) + 'px';
    hitTest();
    e.preventDefault();
  };

  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (boxEl) {
      boxEl.remove();
      boxEl = null;
      // Redraw the bar once at the end; doing it per mousemove would rebuild it constantly
      // 收尾时重绘一次工具栏;每次 mousemove 都重绘会不停地重建它
      applySelection(main);
      // Swallow the click that follows this drag, or it would land on empty space and clear
      // everything we just swept up. A flag rather than a one-shot listener: if the drag ends
      // somewhere that produces no click at all, a listener would stay armed and eat an
      // unrelated click later. The flag is cleared on the next mousedown, so it cannot linger.
      // 吞掉拖动后紧跟的那次 click,否则它会落在空白处、把刚框中的全部清掉。
      // 用标志位而不是一次性监听:万一拖动结束在不产生 click 的地方,监听会一直挂着、
      // 误吞掉之后某次无关的点击。标志位在下次 mousedown 时清掉,不可能残留。
      marqueeJustDragged = true;
    }
    start = null;
    base = null;
  };

  box.addEventListener('mousedown', (e) => {
    // Any fresh press means the previous drag is done being accounted for; the flag can
    // never survive into an unrelated interaction.
    // 只要有新的按下,上一次拖动的账就算结清了;标志不可能残留到无关的下一次交互。
    marqueeJustDragged = false;
    if (e.button !== 0) return;
    // Only from empty space -- pressing on an item, or on a folder heading, belongs to
    // click / dblclick / drag-move
    // 只从空白处起手 —— 按在条目上、或按在文件夹标题上,属于点击/双击/拖动移动
    if (e.target.closest('[data-id]') || e.target.closest('[data-gofolder]') || e.target.closest('button, wa-button, a, input')) return;
    start = { x: e.clientX, y: e.clientY, additive: e.ctrlKey || e.metaKey };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function selActionsHtml() {
  const nodes = selNodes();
  const trashCtx = dst.view === 'trash' || dst.inTrash;
  const single = nodes.length === 1 ? nodes[0] : null;
  if (dst.view === 'shared') {
    return nodes.length
      ? `<wa-button class="icon" appearance="plain" data-act="download" title="${esc(t('drv_download'))}">${icon('download', 20)}</wa-button>`
      : '';
  }
  if (trashCtx) {
    return `
      <wa-button class="icon" appearance="plain" data-act="restore" title="${esc(t('drv_restore'))}">${icon('restore', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" data-act="delete" title="${esc(t('drv_delete_forever'))}">${icon('trash', 20)}</wa-button>`;
  }
  const canEdit = dst.access !== 'viewer';
  const own = dst.access === 'owner';
  return `
    ${nodes.length ? `<wa-button class="icon" appearance="plain" data-act="download" title="${esc(t('drv_download'))}">${icon('download', 20)}</wa-button>` : ''}
    ${own ? `<wa-button class="icon" appearance="plain" data-act="share" title="${esc(t('drv_share'))}">${icon('share', 20)}</wa-button>` : ''}
    ${own ? `<wa-button class="icon" appearance="plain" data-act="star" title="${esc(t('drv_star'))}">${icon('star', 20)}</wa-button>` : ''}
    ${canEdit ? `<wa-button class="icon" appearance="plain" data-act="move" title="${esc(t('drv_move'))}">${icon('folder-move', 20)}</wa-button>` : ''}
    ${canEdit ? `<wa-button class="icon" appearance="plain" data-act="trash" title="${esc(t('drv_trash_it'))}">${icon('trash', 20)}</wa-button>` : ''}`;
}

function nodeIconHtml(n, size = 22) {
  if (n.kind === 'folder') {
    const name = dst.view === 'shared' ? 'folder-shared' : 'folder';
    return `<wa-icon class="fold" name="${name}" style="font-size:${size}px"></wa-icon>`;
  }
  return fileIcon(n.name, size);
}

/** What a listing already knows about a file's history -- the count and how far back it goes --
 *  both of which rode in with the row. Null for anything that keeps none, so the ordinary file
 *  stays as plain as it was.
 *  一个列表本来就知道的、关于某个文件历史的事 —— 有几版,以及最早追到哪儿 ——
 *  两者都是随行里一起来的。不保留历史的东西返回 null,于是普通文件还像从前一样素净。 */
function verInfo(n) {
  // Keeping history is the whole of it: a file that is not keeping any has none to show. It
  // could still be carrying rows from before switching off meant discarding them, and counting
  // those is what puts a version mark on a file whose menu offers to turn version history on.
  // "在不在保留"就是全部:一个不保留历史的文件,没有历史可展示。
  // 它身上可能还掋着一些行 —— 来自"关掉还不意味着丢掉"的那个年代 ——
  // 而把那些也算进来,正是"一个戴着版本标记、菜单却请你开启历史版本的文件"的由来。
  if (n.kind !== 'file' || !n.versioned) return null;
  const count = n.ver_count || 0;
  const first = n.ver_first || 0;
  return { count, first, title: t('drv_ver_badge', count, first ? fmtDateTime(first) : '—') };
}

/** The corner mark on a tile. A thumbnail says what the file looks like now; this says that now
 *  is not all there is of it.
 *  瓦片右上角的标记。缩略图说的是这个文件现在长什么样;这个标记说的是,现在并不是它的全部。 */
function verChipHtml(n) {
  const v = verInfo(n);
  if (!v) return '';
  return `<span class="drv-vchip" title="${esc(v.title)}">${icon('restore', 13)}${v.count > 1 ? `<b>${v.count}</b>` : ''}</span>`;
}

function badgesHtml(n, withVer = true) {
  const out = [];
  if (n.shared) out.push(icon('folder-shared', 15));
  if (n.starred && dst.view !== 'starred') out.push(icon('starFill', 14));
  const v = withVer && verInfo(n);
  if (v) {
    // The count and the date sit together because either alone is half an answer: five versions
    // could be five minutes or five years of work, and only the pair says which.
    // 个数与日期并排,因为单看哪一个都只是半个答案:五个版本可能是五分钟,也可能是五年的活儿,
    // 只有这一对放在一起才说得清是哪一种。
    out.push(`<span class="drv-vers" title="${esc(v.title)}">${icon('restore', 14)}${v.count > 1 ? `<b>${v.count}</b>` : ''}</span>`);
    if (v.first) out.push(`<span class="drv-vsince">${esc(t('drv_ver_since', fmtDate(v.first)))}</span>`);
  }
  return out.length ? `<span class="drv-badges">${out.join('')}</span>` : '';
}

/** Search hits gathered under the folder that holds them. The folders come out in the order
 *  their first hit does, so whatever the list is sorted by still decides what you read first.
 *  搜索结果按所在文件夹归拢。文件夹之间按各自第一条命中的先后排列,
 *  于是列表按什么排序,仍然决定你先读到什么。 */
function groupByFolder(nodes) {
  const by = new Map();
  for (const n of nodes) {
    const key = n.parent_id || '';
    if (!by.has(key)) by.set(key, { id: n.parent_id || null, path: dst.folders[key] || null, nodes: [] });
    by.get(key).nodes.push(n);
  }
  return [...by.values()];
}

/** The heading over one folder's hits, and the way into that folder.
 *  一个文件夹那批命中之上的标题,同时也是进入该文件夹的入口。 */
function groupHeadHtml(g) {
  // A folder whose path did not arrive still opens; it just cannot spell out where it sits.
  // 路径没送到的文件夹照样能打开,只是说不出自己在哪一层。
  const crumbs = g.id && !g.path ? [{ name: '…' }] : (g.path || []);
  const tail = crumbs.map((p) => `<span class="sep">${icon('next', 12)}</span><span>${esc(p.name)}</span>`).join('');
  return `<div class="drv-ghead" data-gofolder="${esc(g.id || '')}" title="${esc(t('drv_open'))}">
      ${icon('folder', 17)}<span class="pth"><span>${esc(t('drv_my'))}</span>${tail}</span>
      <span class="cnt">${g.nodes.length}</span>
    </div>`;
}

function tableHtml(arrow, groups) {
  const trashCtx = dst.view === 'trash';
  // Who shared it is the question this screen exists to answer, so it gets a column of its own
  // rather than being folded into the name.
  // "谁分享的"正是这块屏幕存在的理由,所以它独占一列,而不是被塞进名字里。
  const shared = dst.view === 'shared';
  const row = (n, i) => `
    <tr class="drv-row ${dst.sel.has(n.id) ? 'sel' : ''}" data-id="${esc(n.id)}" data-i="${i}" draggable="true">
      <td><div class="drv-name">${nodeIconHtml(n)}<span class="nm">${esc(n.name)}</span>${badgesHtml(n)}</div></td>
      ${shared ? `<td class="c-owner drv-dim">${esc(n.owner_name || n.owner_email || '')}</td>` : ''}
      <td class="c-time drv-dim">${fmtDate(trashCtx ? n.updated_at : n.updated_at)}</td>
      <td class="drv-dim">${fmtSize(effSize(n))}</td>
      <td><wa-button class="icon rowbtn" appearance="plain" data-menu="${esc(n.id)}" aria-label="menu">${icon('dots-v', 18)}</wa-button></td>
    </tr>`;
  let i = 0;
  const rows = groups
    ? groups.map((g) => `<tr class="drv-ghead-row"><td colspan="4">${groupHeadHtml(g)}</td></tr>${g.nodes.map((n) => row(n, i++)).join('')}`).join('')
    : dst.shown.map(row).join('');
  return `
  <table class="drv-table">
    <colgroup><col>${shared ? '<col class="c-owner">' : ''}<col class="c-time"><col class="c-size"><col class="c-menu"></colgroup>
    <thead><tr>
      <th data-sort="name">${esc(t('drv_th_name'))}${arrow('name')}</th>
      ${shared ? `<th class="c-owner">${esc(t('drv_th_owner'))}</th>` : ''}
      <th data-sort="updated_at" class="c-time">${esc(t('drv_th_modified'))}${arrow('updated_at')}</th>
      <th data-sort="size">${esc(t('drv_th_size'))}${arrow('size')}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function gridHtml(groups) {
  const card = (n, i) => {
    // Prefer the stored thumbnail. Images from before the thumbnail era still show full-size
    // (as they always did) and carry data-bf so the backfill can mint them a real one.
    // 优先用存好的缩略图。缩略图时代之前的图片仍显示原图(一直如此),并带上 data-bf
    // 让回填顺手给它补一张。
    const oldImg = !n.thumb && n.kind === 'file' && IMG_RE.test(n.mime) && n.size < 20 * 1024 * 1024;
    const bf = oldImg && dst.access !== 'viewer' ? ` data-bf="${esc(n.id)}"` : '';
    const media = n.thumb
      ? `<img loading="lazy" draggable="false" src="${esc(thumbUrl(n.id, verTag(n)))}" alt="">`
      : oldImg
        ? `<img loading="lazy" draggable="false" src="${dlUrl(n.id, true, verTag(n))}"${bf} alt="">`
        : fileIcon(n.name, 44);
    return `
    <div class="drv-card ${n.kind} ${dst.sel.has(n.id) ? 'sel' : ''}" data-id="${esc(n.id)}" data-i="${i}" draggable="true">
      <div class="thumb">${n.kind === 'file' ? media : icon('folder', 56)}${verChipHtml(n)}</div>
      <div class="cap">${nodeIconHtml(n, 22)}<span class="nm" title="${esc(n.name)}">${esc(n.name)}</span>${badgesHtml(n, false)}
        <wa-button class="icon rowbtn" appearance="plain" data-menu="${esc(n.id)}" aria-label="menu">${icon('dots-v', 16)}</wa-button></div>
      ${dst.view === 'shared' ? `<div class="who drv-dim">${esc(n.owner_name || n.owner_email || '')}</div>` : ''}
    </div>`;
  };
  let i = 0;
  const cells = groups
    ? groups.map((g) => `<div class="drv-ghead-cell">${groupHeadHtml(g)}</div>${g.nodes.map((n) => card(n, i++)).join('')}`).join('')
    : dst.shown.map(card).join('');
  return `<div class="drv-grid">${cells}</div>`;
}

function emptyHtml() {
  const map = {
    my: ['cloud', 'drv_empty_folder'], folder: ['folder', 'drv_empty_folder'],
    shared: ['folder-shared', 'drv_empty_shared'], recent: ['clock', 'drv_empty_recent'],
    starred: ['star', 'drv_empty_starred'], trash: ['trash', 'drv_empty_trash'],
    search: ['search', 'drv_empty_search'],
  };
  const [ic, key] = map[dst.view] || map.my;
  const hint = (dst.view === 'my' || dst.view === 'folder') && canWriteHere() ? `<div class="drv-dim">${esc(t('drv_drop_hint'))}</div>` : '';
  return `<div class="drv-empty">${icon(ic, 64)}<div>${esc(t(key))}</div>${hint}</div>`;
}

function selNodes() {
  return dst.shown.filter((n) => dst.sel.has(n.id));
}

function bindFolderView(main) {
  bindBar(main);
  qs('#drv-empty-trash', main)?.addEventListener('click', emptyTrash);
  qsa('th[data-sort]', main).forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (dst.sort.key === k) dst.sort.dir = -dst.sort.dir;
    else dst.sort = { key: k, dir: k === 'updated_at' ? -1 : 1 };
    renderFolderView(main);
  }));

  const box = qs('#drv-drop', main);
  if (!box) return;

  box.addEventListener('click', (e) => {
    // The click a finished marquee drag leaves behind would otherwise land on empty space
    // and wipe out what was just swept up.
    // 框选拖动结束后残留的那次 click,不拦掉会落在空白处、把刚框中的清空。
    if (marqueeJustDragged) { marqueeJustDragged = false; return; }
    if (e.target.closest('[data-menu]')) return;
    const gh = e.target.closest('[data-gofolder]');
    if (gh) return navigate(gh.dataset.gofolder ? `#/drive/folder/${gh.dataset.gofolder}` : '#/drive');
    const row = e.target.closest('[data-id]');
    if (!row) {
      dst.sel.clear();
      applySelection(main);
      return;
    }
    const id = row.dataset.id;
    const i = parseInt(row.dataset.i, 10);
    if (e.ctrlKey || e.metaKey) {
      dst.sel.has(id) ? dst.sel.delete(id) : dst.sel.add(id);
      dst.lastIdx = i;
    } else if (e.shiftKey && dst.sel.size) {
      // Extend from whichever end of the existing selection is nearer, and keep what was
      // already picked -- same gesture as the mail list.
      // 从既有选区中较近的那一端延伸过来,并保留已选的 —— 与邮件列表同一套手感。
      extendSelectionTo(i);
    } else {
      dst.sel.clear();
      dst.sel.add(id);
      dst.lastIdx = i;
    }
    applySelection(main);
  });

  box.addEventListener('dblclick', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const n = dst.shown.find((x) => x.id === row.dataset.id);
    if (n) openNode(n);
  });

  bindMarquee(box, main);
  bindItemDrag(box, main);

  box.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-id]');
    // Suppress the browser menu everywhere inside the drive, empty space included -- the
    // page has its own actions there and the system one only gets in the way.
    // 网盘区域内一律不弹浏览器菜单,空白处也是 —— 那里我们自己有动作,系统菜单只会碍事。
    e.preventDefault();
    if (!row) {
      // Right-click on empty space: act on the current folder rather than any selection
      // 空白处右键:针对当前文件夹,而不是任何选中项
      if (dst.sel.size) {
        dst.sel.clear();
        applySelection(main);
      }
      openMenu(e.clientX, e.clientY, []);
      return;
    }
    if (!dst.sel.has(row.dataset.id)) {
      dst.sel.clear();
      dst.sel.add(row.dataset.id);
      dst.lastIdx = parseInt(row.dataset.i, 10);
      applySelection(main);
    }
    openMenu(e.clientX, e.clientY, selNodes());
  });

  qsa('[data-menu]', main).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = b.dataset.menu;
    const r = b.getBoundingClientRect();
    if (!dst.sel.has(id)) {
      dst.sel.clear();
      dst.sel.add(id);
      applySelection(main);
    }
    openMenu(r.left, r.bottom + 4, selNodes());
  }));

  bindThumbBackfill(box);

  // Drag-drop upload / 拖拽上传
  if (canWriteHere()) {
    let depth = 0;
    box.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      depth++;
      dropFrameOn(box);
    });
    box.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        dropFrameOff();
      }
    });
    // Only claim the drag when it actually carries files. An item being moved inside the drive
    // must fall through to the folder drop below, or the upload zone would swallow it.
    // 只在确实拖着文件时接管。网盘内部移动的拖动要能落到下面的文件夹上,
    // 否则会被上传落点吞掉。
    box.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    });
    box.addEventListener('drop', async (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      depth = 0;
      dropFrameOff();
      dropUpload(e.dataTransfer);
    });
  }
}

/** The frame that says a drop will land here. It lives on the body rather than inside the list,
 *  for two reasons that both come from the list being a scrolling box.
 *
 *  A box positioned inside a scroller is placed against the top of its CONTENT, so it slid off
 *  the screen the moment anything scrolled -- exactly when it is needed, since the drags that
 *  take a while are the ones that scroll before they land. And an outline on the scroller itself,
 *  which does hold still, is painted underneath the tiles: it survived only in the gaps between
 *  them, which reads as a broken frame rather than a highlighted target.
 *
 *  Fixed to the viewport and above the list, it can do neither. The marquee next door has been
 *  drawn this way all along, for the same reason.
 *
 *  这个框告诉你"松手就落在这里"。它挂在 body 上而不是列表里面,
 *  两个理由都来自"列表是一个会滚动的盒子"。
 *
 *  放在滚动容器里的盒子,是相对它的"内容"顶端摆放的,于是一滚就滑出了屏幕 ——
 *  而那正是最需要它的时候:拖得久的那一下,总是滚过之后才落地。
 *  而画在滚动容器自身上的 outline 虽然不动,却被画在瓦片下面:
 *  它只在瓦片之间的缝里活下来,看上去像一个断掉的框,而不是一个被点亮的落点。
 *
 *  固定在视口上、压在列表之上,两样都不会发生。旁边的框选矩形一直就是这么画的,理由相同。 */
let dropFrameEl = null;

function dropFrameOn(box) {
  const r = box.getBoundingClientRect();
  if (!dropFrameEl) {
    dropFrameEl = document.createElement('div');
    dropFrameEl.className = 'drv-dropframe';
    document.body.appendChild(dropFrameEl);
  }
  dropFrameEl.style.left = `${r.left + 4}px`;
  dropFrameEl.style.top = `${r.top + 4}px`;
  dropFrameEl.style.width = `${Math.max(0, r.width - 8)}px`;
  dropFrameEl.style.height = `${Math.max(0, r.height - 8)}px`;
}

function dropFrameOff() {
  dropFrameEl?.remove();
  dropFrameEl = null;
}

// A drag that ends anywhere else never sends the list a dragleave, and a frame left standing
// over a page nobody is dragging onto is worse than one that flickers.
// 一次在别处结束的拖动,不会给列表发 dragleave;
// 而一个站在"没人往上拖"的页面上的框,比一个闪一下的框更糟。
window.addEventListener('dragend', dropFrameOff);
window.addEventListener('drop', dropFrameOff);

// A tab that wrote to a file says so, and it says what the file became. The row is corrected from
// the message itself: nothing here is fetched, because nothing here is unknown -- the tab that did
// the writing was told all of it by the write, and has just passed it along.
//
// Only a row already on screen. A file in some other folder has nothing here to correct, and a
// message arriving while the mail is showing has no listing to correct at all.
//
// 某个标签页写了一个文件,于是它说了一声,并且说清了这个文件变成了什么。
// 那一行是直接用这条消息改正的:这里什么都不去取,因为这里没有什么是未知的 ——
// 动手写的那个标签页,是被那次写入告知了全部,而它刚刚把这些一并传了过来。
//
// 只改屏幕上已有的行。别的目录里的文件在这里没有什么可改正,
// 而一条在看邮件时到达的消息,压根没有列表可改正。
try {
  const ch = new BroadcastChannel(DRIVE_CHANNEL);
  ch.addEventListener('message', (e) => {
    if (e.data?.type !== 'node-changed' || !qs('#drv-main')) return;
    const node = (dst.nodes || []).find((x) => x.id === e.data.id);
    if (!node) return;
    const p = e.data.patch || {};
    if (p.updated_at) node.updated_at = p.updated_at;
    if (p.size !== undefined) node.size = p.size;
    if ('ver_head' in p) node.ver_head = p.ver_head;
    if (p.thumb !== undefined) node.thumb = !!p.thumb;
    // The count is the one fact the writer could not read off its own answer, only reason about:
    // a save either made a version or was turned away before it could, and only the first sort
    // gets announced.
    // 计数是写入方唯一无法从自己那份答复里读出、只能推断出来的事实:
    // 一次保存要么造出了一个版本,要么在造出之前就被挡了回去,而只有前一种会被宣告。
    if (p.bumpVersions) node.ver_count = (node.ver_count || 0) + 1;
    renderFolderView(qs('#drv-main'));
  });
} catch { /* no channel here; the listing still refreshes on its next visit / 没有频道,列表下次进入时照样刷新 */ }

function openNode(n) {
  if (n.kind === 'folder') navigate(`#/drive/folder/${n.id}`);
  else if (!n.arc && ARC_EXTS.has(extOf(n.name)) && !(dst.view === 'trash' || dst.inTrash)) {
    arcSeed.set(n.id, {
      name: n.name, size: n.size, access: dst.access,
      crumbs: dst.view === 'folder' || dst.view === 'my' ? dst.path.map((p) => ({ id: p.id, name: p.name })) : null,
    });
    navigate(`#/drive/arc/${n.id}`);
  } else openPreview(n);
}

// ---------- Selection actions and context menu ----------
// ---------- 选中操作与右键菜单 ----------

async function runSelAction(act) {
  const nodes = selNodes();
  if (!nodes.length) return;
  if (act === 'download') downloadFiles(nodes);
  else if (act === 'share') shareDialog(nodes);
  else if (act === 'star') await starNodes(nodes, true);
  else if (act === 'move') moveDialog(nodes);
  else if (act === 'trash') await trashNodes(nodes);
  else if (act === 'restore') await restoreNodes(nodes);
  else if (act === 'delete') await deleteForever(nodes);
}

let menuEl = null;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
document.addEventListener('click', () => closeMenu());
document.addEventListener('scroll', () => closeMenu(), true);
// Navigation dismisses it too. Clicking a link happens to close it via the document click
// above, but the back button and any programmatic navigation do not -- and the menu would then
// hang over an unrelated screen (the mailbox, say) still offering to rename a file.
// 导航也要关掉它。点链接恰好会被上面的 document click 关掉,但后退键和任何程序化跳转不会 ——
// 菜单于是会悬在毫不相干的界面上(比如邮箱),还摆着"重命名文件"这种选项。
window.addEventListener('hashchange', () => closeMenu());
// Entering or leaving the full screen moves the ground the menu was standing on -- it belongs to
// whatever is filling the screen, and that just changed. Reopened where it now belongs, by hand.
// 进入或退出全屏,会把菜单脚下那块地挪走 —— 它归"正在铺满屏幕的东西"所有,而那件事刚刚变了。
// 让它就此收起,由人再打开一次,那时它会落在新的归属里。
document.addEventListener('fullscreenchange', () => closeMenu());
window.addEventListener('keydown', (e) => {
  if (!qs('.drv-body')) return;
  if (e.key === 'Escape') closeMenu();
  if (e.key === 'Delete' && dst.sel.size && !e.target.closest('input,textarea,wa-dialog')) {
    const trashCtx = dst.view === 'trash' || dst.inTrash;
    if (trashCtx) deleteForever(selNodes());
    else if (dst.access !== 'viewer') trashNodes(selNodes());
  }
});

/** The same menu, wherever it is opened from. Given a selection it works out what can be done to
 *  it; given a list outright it shows that -- which is how a control with its own choices, like
 *  the subtitle picker, gets the menu everything else uses instead of one of its own.
 *  同一份菜单,不论从哪里打开。给它一个选区,它自己推出能对它做什么;
 *  直接给它一份清单,它就显示那一份 —— 而这正是"一个自带选项的控件"(比如字幕选择器)
 *  用上其余一切都在用的那份菜单、而不是自己另造一份的办法。 */
function openMenu(x, y, nodes, own, above) {
  closeMenu();
  const items = own || menuItems(nodes);
  if (!items.length) return;
  menuEl = document.createElement('div');
  menuEl.className = 'drv-menu';
  menuEl.innerHTML = items.map((it, i) => it === '-'
    ? '<div class="sep"></div>'
    : `<div class="mi ${it.danger ? 'danger' : ''}${it.hint ? ' hint' : ''}" data-mi="${i}">${icon(it.ic, 18)}<span>${esc(it.label)}</span></div>`
  ).join('');
  // A film filling the screen is in the top layer, and the top layer is all there is: the rest of
  // the document is not painted at all, whatever its z-index says. So a menu goes inside whatever
  // is filling the screen, or it opens somewhere nobody can see. Position is unaffected -- fixed
  // is still measured against the viewport -- so only the parent changes.
  // 一部铺满屏幕的片子处在 top layer 里,而 top layer 就是全部:文档的其余部分根本不会被绘制,
  // 不管它的 z-index 写着什么。所以菜单要挂进"正在铺满屏幕的那个东西"里面,
  // 否则它会开在一个谁也看不见的地方。位置不受影响 —— fixed 仍然是相对视口量的 ——
  // 所以变的只有父节点。
  (document.fullscreenElement || document.body).appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  // A control at the foot of the player has no room below it. Asked to open above, the menu hangs
  // its bottom-right corner off the point it was given instead of its top-left.
  // 一个待在播放器底部的控件,下面没有地方。要它向上开时,
  // 菜单把右下角挂在给定的那个点上,而不是左上角。
  menuEl.style.left = (above
    ? Math.max(8, Math.min(x - r.width, innerWidth - r.width - 8))
    : Math.min(x, innerWidth - r.width - 8)) + 'px';
  menuEl.style.top = (above
    ? Math.max(8, y - r.height)
    : Math.min(y, innerHeight - r.height - 8)) + 'px';
  menuEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const el = e.target.closest('[data-mi]');
    if (!el) return;
    const it = items[parseInt(el.dataset.mi, 10)];
    closeMenu();
    it.fn?.();
  });
}

/** Actions for a right-click on empty space: they target the folder being viewed.
 *  空白处右键的动作:作用于当前所在的文件夹。 */
function emptyMenuItems() {
  if (dst.view === 'trash' || dst.inTrash) return [];
  // Only the two folder views can receive new content; the virtual ones (recent / starred /
  // shared / search) have no single folder to put it in.
  // 只有这两个视图能放东西;虚拟视图(最近/星标/共享/搜索)没有一个确定的落点文件夹。
  if (dst.view !== 'my' && dst.view !== 'folder') return [];
  if (dst.access === 'viewer') return [];
  return [
    { ic: 'folder-plus', label: t('drv_new_folder'), fn: () => newFolderDialog() },
    { ic: 'fileText', label: t('drv_new_md'), fn: () => newMarkdownDialog() },
    { ic: 'fileText', label: t('drv_new_txt'), fn: () => newTextDialog() },
    { ic: 'upload', label: t('drv_upload_files'), fn: () => qs('#drv-file-input')?.click() },
    { ic: 'upload', label: t('drv_upload_folder'), fn: () => qs('#drv-dir-input')?.click() },
  ];
}

/** Views whose items live somewhere else than the view itself / 条目并不住在视图本身的那些视图 */
const LOCATABLE = new Set(['search', 'recent', 'starred']);

/** Land on the folder that holds a node, with the node selected and scrolled to.
 *  落到某个节点所在的文件夹,选中它并滚动到它。 */
function gotoNode(itemId, folderId) {
  if (!itemId) return;
  dst.selectAfterLoad = itemId;
  const hash = folderId && folderId !== 'root' ? `#/drive/folder/${folderId}` : '#/drive';
  if (location.hash === hash) reload(); // already there -- re-list so the item is fresh / 已在此,重列
  else navigate(hash);
}

function menuItems(nodes) {
  if (!nodes.length) return emptyMenuItems();
  const single = nodes.length === 1 ? nodes[0] : null;
  // Someone else's item: open it, read it, take a copy, or stop being in the share. Renaming,
  // moving and binning are not offered because they are not yours to do from here -- the server
  // would refuse them, and an entry that only ever produces an error is worse than no entry.
  // 别人的东西:打开它、读它、拿一份副本,或者退出这个共享。改名、移动、扔掉都不提供,
  // 因为从这里做它们不属于你 —— 服务端会拒绝,而一个只会产生错误的菜单项比没有这一项更糟。
  if (dst.view === 'shared') {
    const out = [];
    if (single) {
      out.push(single.kind === 'folder'
        ? { ic: 'folder', label: t('drv_open'), fn: () => openNode(single) }
        : { ic: 'expand', label: t('drv_preview'), fn: () => openPreview(single) });
      out.push({ ic: 'download', label: t('drv_download'), fn: () => downloadFiles([single]) });
    } else if (nodes.length) {
      out.push({ ic: 'download', label: t('drv_download'), fn: () => downloadFiles(nodes) });
    }
    if (single?.share_id) {
      out.push('-');
      out.push({ ic: 'close', label: t('drv_leave_share'), danger: true, fn: () => leaveShare(single) });
    }
    return out.filter((x, i, a) => !(x === '-' && (i === 0 || a[i - 1] === '-' || i === a.length - 1)));
  }
  const trashCtx = dst.view === 'trash' || dst.inTrash;
  if (trashCtx) {
    return [
      { ic: 'restore', label: t('drv_restore'), fn: () => restoreNodes(nodes) },
      { ic: 'trash', label: t('drv_delete_forever'), danger: true, fn: () => deleteForever(nodes) },
    ];
  }
  const canEdit = dst.access !== 'viewer';
  const own = dst.access === 'owner';
  const editorOnRoot = !own && nodes.some((n) => n.id === dst.shareRoot);
  const out = [];
  if (single) {
    out.push(single.kind === 'folder'
      ? { ic: 'folder', label: t('drv_open'), fn: () => openNode(single) }
      : { ic: 'expand', label: t('drv_preview'), fn: () => openPreview(single) });
    // Editing opens away from here, in a window of its own. The list stays where it is: coming
    // back to it should not mean loading it again, and a document being written is not a thing to
    // do on top of something else.
    // 编辑在别处打开,在它自己的窗口里。列表留在原地:回到它不该意味着再加载一次,
    // 而"正在写一份文档"也不是一件该压在别的东西上面做的事。
    const editor = single.kind === 'file' && canEdit ? editorFor(single.name) : null;
    if (editor) {
      out.push({
        ic: 'pencil',
        label: t('md_edit'),
        fn: () => window.open(`${location.pathname}${editorHash(editor, single.id)}`, '_blank', 'noopener'),
      });
    }
    out.push({ ic: 'download', label: t('drv_download'), fn: () => downloadFiles([single]) });
    // The views that answer from everywhere at once owe you the address. In a folder you are
    // already standing in it, so the offer would be to go where you are.
    // 那些一次从四面八方作答的视图,欠你一个地址。在文件夹里你本来就站在那儿,
    // 这个入口只会请你去你已经在的地方。
    if (LOCATABLE.has(dst.view)) {
      out.push({ ic: 'folder', label: t('drv_up_locate'), fn: () => gotoNode(single.id, single.parent_id) });
    }
    // Everything known about one thing, for the moment before doing something to it.
    // 关于一样东西所知道的一切 —— 给动手之前的那一刻。
    out.push({ ic: 'info', label: t('drv_props'), fn: () => propsDialog(single) });
    out.push('-');
    if (canEdit && !editorOnRoot) out.push({ ic: 'pencil', label: t('drv_rename'), fn: () => renameDialog(single) });
  }
  // Whatever is selected can be taken away, folders included. Passing folders over used to be the
  // rule here, on the grounds that the files were the part of the question that had an answer --
  // but a folder somebody selected and asked for is a question with an answer too, and the answer
  // is the folder.
  // 选中什么就能带走什么,目录也算。这里过去的规矩是把目录略过,理由是"文件才是这个问题里
  // 有答案的那部分" —— 但一个被人选中、被人要走的目录,同样是一个有答案的问题,
  // 而那个答案就是这个目录。
  if (!single && nodes.length) {
    out.push({ ic: 'download', label: t('drv_download'), fn: () => downloadFiles(nodes) });
    out.push('-');
  }
  // Share whatever is selected: files, folders, or any mix of them
  // 选中什么就分享什么:文件、目录,或者两者混装
  if (own) out.push({ ic: 'share', label: t('drv_share'), fn: () => shareDialog(nodes) });
  // Its own entry, not a third setting inside Share. What this hands out is not a page for a
  // person to open -- it is a set of verbs for a program to use -- and burying that choice one
  // level inside the sharing dialog would make it look like a variation on sending someone a
  // link, which is the one thing it is not.
  // 单独一项,而不是"分享"里的第三个设置。它交出去的不是给人打开的页面,
  // 而是给程序使用的一组动词 —— 把这个选择埋进分享对话框里一层,
  // 会让它看起来像是"发条链接给谁"的一种变体,而这恰恰是它唯一不是的东西。
  if (own) out.push({ ic: 'robot', label: t('drv_agent_access'), fn: () => agentDialog(nodes) });
  if (canEdit && !editorOnRoot) out.push({ ic: 'folder-move', label: t('drv_move'), fn: () => moveDialog(nodes) });
  if (own) {
    const allStar = nodes.every((n) => n.starred);
    out.push({ ic: allStar ? 'star' : 'starFill', label: t(allStar ? 'drv_unstar' : 'drv_star'), fn: () => starNodes(nodes, !allStar) });
  }
  // Whether a thing keeps its own past is a property of the thing, so it sits among the other
  // properties -- starred, shared -- and not among the verbs that act on it this second.
  // 一样东西留不留得住自己的过去,是这样东西的属性,所以它和别的属性坐在一起 ——
  // 星标、分享 —— 而不是和那些此刻就动手的动词坐在一起。
  if (own && !editorOnRoot) {
    const allOn = nodes.every((x) => (x.kind === 'folder' ? x.ver_policy : x.versioned));
    out.push({ ic: 'restore', label: t(allOn ? 'drv_ver_off' : 'drv_ver_on'), fn: () => setVersioning(nodes, !allOn) });
  }
  if (canEdit && !editorOnRoot) {
    out.push('-');
    out.push({ ic: 'trash', label: t('drv_trash_it'), danger: true, fn: () => trashNodes(nodes) });
  }
  return out.filter((x, i, a) => !(x === '-' && (i === 0 || a[i - 1] === '-' || i === a.length - 1)));
}

/**
 * Whatever is selected, onto the machine.
 *
 * One file is one download, the way it has always been: the browser already knows where downloads
 * go, and asking permission for a folder to put a single file in is a question nobody wanted.
 *
 * Anything else -- a folder, or several things -- goes somewhere chosen instead. There is no
 * archive to hand over: zipping a selection would mean holding it in a worker that has neither the
 * memory nor the CPU for it. So the selection is written into a folder on the machine, keeping the
 * shape it had here, which is the thing an archive would have been for.
 *
 * Where that cannot be asked for -- Firefox and Safari have no way to hand over a folder -- files
 * fall back to one download each, spaced out. The gap is what keeps the browser from reading a
 * burst of clicks as a popup storm and dropping all but the first. Folders have no fallback, and
 * saying so is better than quietly leaving them out of what was asked for.
 *
 * 选中什么,就把什么放到本机上。
 *
 * 一个文件就是一次下载,一如既往:浏览器早就知道下载该去哪儿,
 * 而为了放一个文件去要一个目录的权限,是没人想要的一问。
 *
 * 其余情形 —— 一个目录,或者好几样东西 —— 则放进一个由人指定的地方。这里没有压缩包可交:
 * 把选区打包意味着让一个既没内存也没 CPU 的 worker 扛着它。
 * 所以选区被写进本机的一个目录里,保持它在这里的形状 —— 而那正是压缩包本来要用来做的事。
 *
 * 在要不到那个目录的地方 —— Firefox 和 Safari 没有交出目录的办法 —— 文件退回到"一个一次下载",
 * 彼此隔开。那点间隔正是为了不让浏览器把连发的点击读成弹窗风暴,从而只放行第一个。
 * 目录没有退路,而把这件事说出来,好过悄悄把它们从"被要求的东西"里漏掉。
 */
async function downloadFiles(nodes) {
  if (!nodes.length) return;
  // An entry inside an archive is not a node the server knows about -- its bytes exist only where
  // they were extracted -- so it keeps its own way out.
  // 压缩包里的条目不是服务端认得的节点 —— 它的字节只存在于它被解出来的地方 ——
  // 所以它保留它自己的那条出路。
  const arcs = nodes.filter((n) => n.arc);
  const real = nodes.filter((n) => !n.arc);
  const one = !arcs.length && real.length === 1 && real[0].kind === 'file';
  if (!one && real.length && canSaveInto()) {
    await downloadInto(real);
  } else {
    const folders = real.filter((n) => n.kind === 'folder');
    if (folders.length && !canSaveInto()) toast(t('drv_dl_nodir'), true);
    const files = [...arcs, ...real.filter((n) => n.kind === 'file')];
    for (const [i, n] of files.entries()) {
      downloadFile(n);
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 400));
    }
  }
}

function downloadFile(n, verId) {
  if (n.arc) return downloadArcEntry(n);
  const a = document.createElement('a');
  a.href = verId ? verUrl(n.id, verId) : dlUrl(n.id, false, verTag(n));
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Archive entries download from their client-side extraction / 压缩包条目从客户端解出的字节下载 */
async function downloadArcEntry(n) {
  try {
    if (!n.arcUrl) n.arcUrl = await n.arcGet();
    const a = document.createElement('a');
    a.href = n.arcUrl;
    a.download = n.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    toast(tErr(e), true);
  }
}

// ---------------------------------------------------------------------------------------------
// Downloading a selection into a folder on the machine
// ---------------------------------------------------------------------------------------------

/** What a file system will not take in a name, plus the trailing dot or space Windows rejects.
 *  Everything else is left alone: it is the name somebody gave the file, and a download that
 *  quietly renames things is a download somebody has to go and undo.
 *  文件系统不接受的字符,外加 Windows 不收的尾部句点和空格。其余一律不动:
 *  那是有人给这个文件起的名字,而一次悄悄改名的下载,是一次事后要有人去还原的下载。 */
const BAD_LOCAL = /[<>:"/\\|?*]/g;
const localName = (s) => {
  const clean = String(s || '').replace(BAD_LOCAL, '_').replace(/[. ]+$/, '');
  if (clean.length <= 150) return clean || 'unnamed';
  // Too long for some paths, so it is shortened -- from the middle. Cutting the end takes the
  // extension with it, and a file that arrives without one is a file the machine no longer knows
  // what to do with.
  // 对某些路径来说太长了,于是把它截短 —— 从中间截。从末尾截会连扩展名一起截掉,
  // 而一个到达时没有扩展名的文件,是一个这台机器不再知道该拿它怎么办的文件。
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
  return clean.slice(0, 150 - ext.length) + ext;
};

/** Whether this browser will hand over a folder to write into. Chrome and Edge will; Firefox and
 *  Safari have no such thing, and there is no polyfill for asking somebody for a directory.
 *  这个浏览器会不会交出一个可写的目录。Chrome 和 Edge 会;Firefox 和 Safari 没有这样东西,
 *  而"向人要一个目录"这件事没有垫片可打。 */
const canSaveInto = () => typeof window.showDirectoryPicker === 'function';

/**
 * Everything under one node, flattened, with paths relative to the selection.
 *
 * A folder costs one request per folder -- there is no endpoint that hands over a whole tree, and
 * inventing one would mean a walk of unknown depth inside a request that has a deadline.
 * Directories are collected alongside files, so a folder that happens to be empty still arrives on
 * the disk rather than silently not existing.
 *
 * 一个节点底下的一切,摊平,路径相对于选中的那个东西。
 *
 * 一个目录的代价是"每层一个请求" —— 没有哪个端点会一次交出整棵树,
 * 而造一个出来意味着在一个有时限的请求里做一次深度不定的遍历。
 * 目录与文件一同被收集,于是一个恰好是空的目录仍然会落到盘上,而不是悄无声息地不存在。
 */
async function walkNode(node, rel, out, prep) {
  const here = rel ? `${rel}/${localName(node.name)}` : localName(node.name);
  if (node.kind !== 'folder') {
    out.files.push({ node, rel: here });
    out.size += node.size || 0;
    if (prep) { prep.found = (prep.found || 0) + 1; paintPrep(prep); }
    return;
  }
  out.dirs.push(here);
  const data = await api('GET', `/api/drive/list?parent=${encodeURIComponent(node.id)}`);
  for (const child of data.nodes || []) await walkNode(child, here, out, prep);
}

/**
 * Ask for a folder, then put the selection in it.
 *
 * The permission is asked for first, before anything is counted, because a picker that appears
 * after a wait is a picker somebody has stopped looking at. What follows goes into the same panel
 * uploads use: a folder becomes one row with a counter, a file becomes one row with a ring, and
 * either can be cancelled where it stands.
 *
 * 先要一个目录,再把选中的东西放进去。
 *
 * 权限先要,而且在清点任何东西之前 —— 因为一个等了一会儿才冒出来的选择框,
 * 是一个人已经不再看着的选择框。此后的一切进入上传所用的同一个面板:
 * 一个目录成为带计数的一行,一个文件成为带进度环的一行,而两者都能就地取消。
 */
async function downloadInto(nodes) {
  let root;
  try {
    root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'cfmail-drive', startIn: 'downloads' });
  } catch {
    return; // the picker was dismissed, which is an answer / 选择框被关掉了,那也是一个答复
  }
  const prep = beginPrep(true);
  const made = [];
  try {
    for (const n of nodes) {
      const out = { files: [], dirs: [], size: 0 };
      await walkNode(n, '', out, prep);
      made.push({
        id: ++up.seq,
        down: true,
        root,
        group: n.kind === 'folder',
        name: n.name,
        files: out.files,
        dirs: out.dirs,
        size: out.size,
        sent: 0,
        done: 0,
        total: out.files.length,
        failed: 0,
        status: 'wait',
        abort: null,
        cancelled: false,
      });
    }
  } catch (e) {
    toast(tErr(e), true);
  } finally {
    up.tasks = up.tasks.filter((x) => x !== prep);
  }
  up.tasks.push(...made);
  renderUpPanel();
  pump();
}

/** One task: its folders first, so that an empty one exists, then its files in order.
 *  一个任务:先是它的目录,好让空目录也存在,然后是它的文件,按顺序。 */
async function runDownload(task) {
  const dirs = new Map();
  const dirFor = async (rel) => {
    if (!rel) return task.root;
    if (dirs.has(rel)) return dirs.get(rel);
    const cut = rel.lastIndexOf('/');
    const parent = await dirFor(cut >= 0 ? rel.slice(0, cut) : '');
    const h = await parent.getDirectoryHandle(cut >= 0 ? rel.slice(cut + 1) : rel, { create: true });
    dirs.set(rel, h);
    return h;
  };
  for (const rel of task.dirs) {
    if (task.cancelled) throw new Error('cancelled');
    await dirFor(rel);
  }
  let base = 0;
  for (const f of task.files) {
    if (task.cancelled) throw new Error('cancelled');
    try {
      await saveOne(f, dirFor, task, base);
    } catch (e) {
      if (task.cancelled) throw e;
      // One file that would not come down does not end the folder it is in. What it cost is
      // recorded and the rest carries on, the way a folder upload does.
      // 一个下不来的文件,不该终结它所在的那个目录。代价被记下来,其余的继续 ——
      // 和一次目录上传的做法一样。
      task.failed++;
      task.err = e?.message || String(e);
    }
    base += f.node.size || 0;
    task.sent = base;
    task.done++;
    paintTask(task);
  }
  if (task.failed) throw new Error(task.err || 'failed');
  return null;
}

/** The bytes of one file, straight from the network into the file it is going to be.
 *
 *  Nothing is held: the answer is read as it arrives and written as it is read, so a four-gigabyte
 *  file costs a buffer rather than four gigabytes. Which is also why the progress is real -- it
 *  counts what has actually landed.
 *
 *  一个文件的字节,从网络直接进入它将要成为的那个文件。
 *
 *  什么都不攥着:答复边到达边被读、边被读边被写,于是一个四吉字节的文件花掉的是一个缓冲区,
 *  而不是四吉字节。这也正是那个进度是真的的原因 —— 它数的是真正落了盘的东西。 */
async function saveOne(f, dirFor, task, base) {
  const cut = f.rel.lastIndexOf('/');
  const dir = await dirFor(cut >= 0 ? f.rel.slice(0, cut) : '');
  const name = cut >= 0 ? f.rel.slice(cut + 1) : f.rel;
  task.abort = new AbortController();
  let w = null;
  try {
    const res = await fetch(dlUrl(f.node.id, false, verTag(f.node)), { signal: task.abort.signal });
    if (!res.ok) throw new Error(tErr('e_request_failed', [res.status]));
    const fh = await dir.getFileHandle(name, { create: true });
    w = await fh.createWritable();
    if (res.body) {
      const reader = res.body.getReader();
      let got = 0;
      let painted = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await w.write(value);
        got += value.length;
        task.sent = base + got;
        // Ten times a second is already past what anybody reads, and this panel is redrawn by
        // hand rather than whenever the browser feels like it.
        // 一秒十次已经超过任何人读得过来的速度,而这个面板是手工重绘的,
        // 不是浏览器什么时候高兴什么时候重绘的。
        if (performance.now() - painted > 100) { paintTask(task); painted = performance.now(); }
      }
    }
    await w.close();
    w = null;
  } finally {
    if (w) await w.abort().catch(() => {});
    task.abort = null;
  }
}

/** Turn history on or off for a selection. A folder's switch speaks for files not yet born and
 *  reaches nothing already inside it: a file's own history is switched on that file, where the
 *  setting sits on the thing it describes. Off does not merely stop collecting more -- it takes
 *  the past with it -- which is why that is the half that has to ask first, and why it asks only
 *  when there is a file with something to lose.
 *  为选中项开启或关闭历史。目录的开关只为"尚未出生的文件"说话,够不到已经在里面的任何东西:
 *  一个文件自己的历史,在这个文件上开关 —— 设置就落在它所描述的那样东西身上。
 *  "关"不只是不再收集,它会把过去一并带走 —— 所以先问一句的是这一半,
 *  而且只在选中项里确有东西可失去时才问。 */
async function setVersioning(nodes, on) {
  // Off takes the past with it now, so it is asked about the way anything irreversible is. The
  // file keeps what it is; what it used to be does not survive the answer.
  // 现在"关掉"会把过去一并带走,所以它要像任何不可逆的事情那样先问一句。
  // 文件保住的是它现在的样子;它从前的样子,活不过这个回答。
  if (!on && nodes.some((x) => x.kind === 'file' && x.versioned)) {
    if (!(await confirmDialog(t('drv_ver_off_ask'), t('drv_ver_off')))) return;
  }
  try {
    for (const x of nodes) {
      await api('POST', `/api/drive/nodes/${encodeURIComponent(x.id)}/versioning`, { on });
    }
    toast(t(on ? 'drv_ver_on_done' : 'drv_ver_off_done'));
  } catch (e) {
    toast(tErr(e));
  }
  reload();
}

async function starNodes(nodes, on) {
  try {
    for (const n of nodes) await api('POST', `/api/drive/nodes/${n.id}/star`, { starred: on });
    reload();
  } catch (e) {
    toast(e.message, true);
  }
}

async function trashNodes(nodes) {
  try {
    for (const n of nodes) await api('POST', `/api/drive/nodes/${n.id}/trash`);
    dst.sel.clear();
    toast(t('drv_trashed_toast'));
    reload();
  } catch (e) {
    toast(e.message, true);
    reload();
  }
}

async function restoreNodes(nodes) {
  try {
    for (const n of nodes) await api('POST', `/api/drive/nodes/${n.id}/restore`);
    dst.sel.clear();
    toast(t('drv_restored_toast'));
    reload();
  } catch (e) {
    toast(e.message, true);
    reload();
  }
}

async function deleteForever(nodes) {
  const msg = nodes.length === 1 ? t('drv_delete_confirm', nodes[0].name) : t('drv_delete_confirm_n', nodes.length);
  if (!(await confirmDialog(msg, t('drv_delete_forever')))) return;
  try {
    for (const n of nodes) {
      let r = { remaining: 1 };
      for (let i = 0; r.remaining > 0 && i < 1000; i++) {
        r = await api('DELETE', `/api/drive/nodes/${n.id}`);
      }
    }
    dst.sel.clear();
    toast(t('drv_deleted_toast'));
    reload();
  } catch (e) {
    toast(e.message, true);
    reload();
  }
}

async function emptyTrash() {
  if (!(await confirmDialog(t('drv_trash_empty_confirm'), t('drv_trash_empty_btn')))) return;
  try {
    let r = { remaining: 1 };
    for (let i = 0; r.remaining > 0 && i < 2000; i++) {
      r = await api('POST', '/api/drive/trash/empty');
    }
    toast(t('drv_deleted_toast'));
    reload();
  } catch (e) {
    toast(e.message, true);
    reload();
  }
}

// ---------- Dialogs ----------
// ---------- 对话框 ----------

function promptDialog(title, initial, okLabel) {
  return new Promise((resolve) => {
    const d = showModal(`
      <div class="modal-body">
        <h3 style="margin:0 0 14px">${esc(title)}</h3>
        <input id="drv-prompt" type="text" value="${esc(initial)}" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text);font-size:14px">
      </div>
      <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
        <wa-button appearance="plain" data-x="cancel">${esc(t('cancel'))}</wa-button>
        <wa-button variant="brand" data-x="ok">${esc(okLabel || t('confirm'))}</wa-button>
      </div>`);
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const submit = () => {
      const v = qs('#drv-prompt', d)?.value.trim();
      closeModal();
      finish(v || null);
    };
    d.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      if (b.dataset.x === 'ok') submit();
      else {
        closeModal();
        finish(null);
      }
    });
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    d.addEventListener('wa-hide', (e) => {
      if (e.target === d) finish(null);
    });
    customElements.whenDefined('wa-dialog').then(async () => {
      try { await d.updateComplete; } catch {}
      setTimeout(() => {
        const inp = qs('#drv-prompt', d);
        inp?.focus();
        inp?.select();
      }, 60);
    });
  });
}

/** Make an empty document and go straight to writing it. The file is created here rather than
 *  in the editor so that it exists before the tab opens: a tab that has to create its own subject
 *  is a tab that shows an error when the creation fails, in a window that has nothing else in it.
 *  造一份空文档,然后直接去写它。文件在这里创建而不是在编辑器里创建,
 *  好让它在标签页打开之前就已经存在:一个要自己造出自己主题的标签页,
 *  会在创建失败时变成一扇除了错误什么都没有的窗。 */
const newMarkdownDialog = () => newTextish(t('drv_new_md'), t('drv_untitled_md'), '.md', 'text/markdown');
const newTextDialog = () => newTextish(t('drv_new_txt'), t('drv_untitled_txt'), '.txt', 'text/plain');

/** Make an empty file and go straight to writing it. The file is created here rather than in the
 *  editor so that it exists before the tab opens: a tab that has to create its own subject is a
 *  tab that shows an error when the creation fails, in a window with nothing else in it.
 *
 *  A suffix is only added when the name does not already carry one this editor would answer to --
 *  somebody typing `notes.conf` means `notes.conf`, and appending .txt to it would be correcting
 *  a person who was not wrong.
 *
 *  造一个空文件,然后直接去写它。文件在这里创建而不是在编辑器里创建,好让它在标签页打开之前
 *  就已经存在:一个要自己造出自己主题的标签页,会在创建失败时变成一扇除了错误什么都没有的窗。
 *
 *  只有当名字还没带上"这个编辑器认得的后缀"时才补一个 ——
 *  一个键入 `notes.conf` 的人,要的就是 `notes.conf`;给它加上 .txt,是在纠正一个没有错的人。 */
async function newTextish(title, placeholder, suffix, mime) {
  const raw = await promptDialog(title, placeholder, t('confirm'));
  if (!raw) return;
  const kind = editorFor(raw);
  const name = kind ? raw : raw + suffix;
  try {
    const q = `parent=${encodeURIComponent(currentParent())}&name=${encodeURIComponent(name)}`
      + `&mime=${encodeURIComponent(mime)}`;
    const res = await fetch(`/api/drive/upload?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: new Uint8Array(0),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'e_request_failed');
    reload();
    window.open(`${location.pathname}${editorHash(editorFor(name) || 'code', data.id)}`, '_blank', 'noopener');
  } catch (e) {
    toast(tErr(e), true);
  }
}

async function newFolderDialog() {
  if (!canWriteHere()) {
    toast(tErr('e_drive_forbidden'), true);
    return;
  }
  const name = await promptDialog(t('drv_new_folder'), t('drv_untitled_folder'), t('confirm'));
  if (!name) return;
  try {
    await api('POST', '/api/drive/folders', { parent: currentParent(), name });
    reload();
  } catch (e) {
    toast(e.message, true);
  }
}

/** Everything the drive knows about one thing, in one place.
 *
 *  Scattered through the interface already: the size is in the list, the date is in a column, the
 *  version count is a little chip on the tile, and where the thing actually lives is only knowable
 *  by looking at the breadcrumbs you happen to be standing in. None of that is wrong; it is just
 *  that there was nowhere to go and read the whole of it -- which is what somebody wants at the
 *  moment they are about to do something they cannot undo.
 *
 *  The path comes from the server rather than from the breadcrumbs, because the two are not always
 *  the same thing: a search result is shown from a folder you are not in, and its address is the
 *  one fact the row cannot tell you.
 *
 *  网盘关于一样东西所知道的一切,放在一处。
 *
 *  这些东西本来就散落在界面各处:大小在列表里,日期在某一列,版本数是磁贴上的一个小角标,
 *  而这样东西究竟住在哪儿 —— 只能靠看你恰好站着的那条面包屑推出来。这些都没有错,
 *  只是没有一个地方可以去把它们一次读完 —— 而那恰恰是一个人正要做某件无法撤销的事时想要的。
 *
 *  路径取自服务端而不是面包屑,因为两者并不总是同一回事:
 *  一条搜索结果是从一个你并不身处其中的目录里被展示出来的,而它的地址正是那一行说不出的那个事实。 */
async function propsDialog(n) {
  const d = showModal(`
    <div class="modal-body drv-props">
      <div class="hd">
        ${n.kind === 'folder' ? icon('folder', 40) : fileIcon(n.name, 40)}
        <div class="who">
          <div class="nm" title="${esc(n.name)}">${esc(n.name)}</div>
          <div class="pth dim" id="drv-pp-path">${esc(t('loading'))}</div>
        </div>
      </div>
      <dl id="drv-pp-rows"></dl>
    </div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button variant="brand" data-x="ok">${esc(t('close'))}</wa-button>
    </div>`);
  d.addEventListener('click', (e) => { if (e.target.closest('[data-x="ok"]')) closeModal(); });

  // Copying is offered for the two values nobody retypes: the address and the identifier. The
  // identifier is what the agent API is addressed by, so it is the one most likely to be wanted.
  // 只为那两个没人会照着重打的值提供复制:地址,和标识符。
  // 标识符是 agent API 用来寻址的东西,所以最可能被需要的就是它。
  const copyable = (text, label) => `<span class="cp" data-cp="${esc(text)}" title="${esc(label)}">`
    + `${esc(text)}${icon('copy', 13)}</span>`;
  d.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cp]');
    if (c) { copyText(c.dataset.cp); toast(t('t_copied')); }
  });

  // What is known without asking anyone is painted at once; the address needs a round trip and
  // arrives into the line that is holding its place.
  // 不问任何人就已经知道的东西立刻画出来;地址需要一次往返,到达后填进那行替它占着位的位置。
  const rows = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push([k, v]); };
  const yes = (b) => t(b ? 'drv_prop_yes' : 'drv_prop_no');

  add(t('drv_prop_kind'), n.kind === 'folder' ? t('drv_prop_folder') : (n.mime || t('drv_prop_file')));
  if (n.kind === 'file') {
    add(t('drv_prop_size'), `${fmtSize(n.size || 0)} · ${(n.size || 0).toLocaleString(lang())} ${t('drv_prop_bytes')}`);
  } else {
    // A folder's own size is nothing; what is worth knowing is what it is carrying.
    // 一个目录自身的大小什么都不是;值得知道的是它装着多少。
    add(t('drv_prop_contents'), `${fmtSize(n.tree_bytes || 0)}`);
  }
  add(t('drv_prop_created'), fmtDateTime(n.created_at));
  add(t('drv_prop_modified'), fmtDateTime(n.updated_at));

  const keeping = n.kind === 'folder' ? n.ver_policy : n.versioned;
  if (keeping && n.kind === 'file' && n.ver_count) {
    add(t('drv_prop_versions'), t('drv_prop_versions_since', n.ver_count, fmtDateTime(n.ver_first)));
  } else if (keeping) {
    add(t('drv_prop_versions'), t('drv_prop_versions_on'));
  }
  // The digest of what is in the file right now. Only files that keep their history have one --
  // it is recorded when a version is written, and a file that writes no versions records nothing.
  // 这个文件此刻内容的摘要。只有保留历史的文件才有 ——
  // 它是在写下一个版本时记的,而一个不写版本的文件什么也没记。
  if (n.ver_hash) add(t('drv_prop_hash'), `<code class="hs">${esc(n.ver_hash)}</code>`);
  if (n.shared) add(t('drv_prop_shared'), yes(true));
  if (n.starred) add(t('drv_prop_starred'), yes(true));
  add(t('drv_prop_id'), copyable(n.id, t('drv_prop_copy')));

  const paint = () => {
    const dl = qs('#drv-pp-rows', d);
    if (dl) dl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  };
  paint();

  try {
    const meta = await api('GET', `/api/drive/nodes/${encodeURIComponent(n.id)}/meta`);
    const where = '/' + (meta.path || []).map((p) => p.name).join('/');
    const el = qs('#drv-pp-path', d);
    if (el) el.innerHTML = copyable(where || '/', t('drv_prop_copy'));
  } catch {
    // The address is the one thing here that has to be asked for. Without it the rest is still
    // worth showing, so the line says so and the dialog stays.
    // 这里唯一需要开口去问的就是地址。没有它,其余部分照样值得展示,
    // 所以那一行如实说明,而这个对话框留着。
    const el = qs('#drv-pp-path', d);
    if (el) el.textContent = t('drv_prop_path_unknown');
  }
}

async function renameDialog(n) {
  const name = await promptDialog(t('drv_rename'), n.name, t('confirm'));
  if (!name || name === n.name) return;
  try {
    await api('POST', `/api/drive/nodes/${n.id}/rename`, { name });
    reload();
  } catch (e) {
    toast(e.message, true);
  }
}

async function moveDialog(nodes) {
  const excluded = new Set(nodes.map((n) => n.id));
  let cur = dst.access === 'owner' ? 'root' : dst.shareRoot;
  const d = showModal(`
    <div class="modal-body">
      <h3 style="margin:0 0 12px">${esc(t('drv_move_title', nodes.length))}</h3>
      <div class="drv-move-crumbs" id="drv-mv-crumbs"></div>
      <div class="drv-move-list" id="drv-mv-list"><div class="loading">${esc(t('loading'))}</div></div>
    </div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button appearance="plain" data-x="cancel">${esc(t('cancel'))}</wa-button>
      <wa-button variant="brand" data-x="ok">${esc(t('drv_move_here'))}</wa-button>
    </div>`);
  const level = async () => {
    const list = qs('#drv-mv-list', d);
    const crumbs = qs('#drv-mv-crumbs', d);
    list.innerHTML = `<div class="loading">${esc(t('loading'))}</div>`;
    try {
      const data = await api('GET', `/api/drive/list?parent=${encodeURIComponent(cur)}`);
      const folders = data.nodes.filter((n) => n.kind === 'folder');
      const rootLbl = dst.access === 'owner' ? t('drv_my') : t('drv_shared');
      const parts = [`<span class="drv-crumb ${cur === 'root' || !data.path?.length ? 'here' : ''}" data-go="root">${esc(rootLbl)}</span>`];
      (data.path || []).forEach((p, i) => {
        const last = i === data.path.length - 1;
        parts.push(`<span class="drv-crumb-sep">${icon('next', 12)}</span>
          <span class="drv-crumb ${last ? 'here' : ''}" data-go="${esc(p.id)}">${esc(p.name)}</span>`);
      });
      crumbs.innerHTML = parts.join('');
      list.innerHTML = folders.length
        ? folders.map((f) => `
          <div class="drv-move-item ${excluded.has(f.id) ? 'dis' : ''}" data-go="${excluded.has(f.id) ? '' : esc(f.id)}">
            ${icon('folder', 18)}<span>${esc(f.name)}</span>
          </div>`).join('')
        : `<div class="drv-move-empty">${esc(t('drv_move_no_sub'))}</div>`;
    } catch (e) {
      list.innerHTML = `<div class="drv-move-empty">${esc(e.message)}</div>`;
    }
  };
  d.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]');
    if (go && go.dataset.go) {
      cur = go.dataset.go === 'root' && dst.access !== 'owner' ? dst.shareRoot : go.dataset.go;
      await level();
      return;
    }
    const b = e.target.closest('[data-x]');
    if (!b) return;
    if (b.dataset.x === 'ok') {
      try {
        for (const n of nodes) await api('POST', `/api/drive/nodes/${n.id}/move`, { parent: cur });
        closeModal();
        dst.sel.clear();
        toast(t('drv_moved_toast'));
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    } else closeModal();
  });
  await level();
}

/** One-of-N picker. Used wherever a choice has few, mutually exclusive options that the user
 *  should be able to weigh at a glance -- a dropdown hides the alternatives behind a click and
 *  makes a two-way choice feel like a list.
 *  N 选 1 控件。用于选项少且互斥、且用户应当一眼权衡的场合 ——
 *  下拉框把备选藏在一次点击之后,会把"二选一"弄得像一份清单。
 *  @param {string} id  @param {{v:string,label:string}[]} opts  @param {string} value */
function segHtml(id, opts, value) {
  return `<div class="drv-seg" id="${esc(id)}" data-v="${esc(value)}">${opts.map((o) =>
    `<button type="button" class="opt ${o.v === value ? 'on' : ''}" data-v="${esc(o.v)}">${esc(o.label)}</button>`
  ).join('')}</div>`;
}

/** Wire a segmented control; `onChange` fires only on an actual change.
 *  给分段控件接线;onChange 只在真正变化时触发。 */
function segBind(root, id, onChange) {
  const el = qs('#' + id, root);
  if (!el) return;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.opt');
    if (!b || el.classList.contains('off') || b.dataset.v === el.dataset.v) return;
    el.dataset.v = b.dataset.v;
    qsa('.opt', el).forEach((x) => x.classList.toggle('on', x === b));
    onChange?.(b.dataset.v);
  });
}
const segGet = (root, id) => qs('#' + id, root)?.dataset.v || '';
/** Set the value from code, keeping the buttons in step / 由代码设值,按钮状态同步 */
function segSet(root, id, v) {
  const el = qs('#' + id, root);
  if (!el || el.dataset.v === v) return;
  el.dataset.v = v;
  qsa('.opt', el).forEach((x) => x.classList.toggle('on', x.dataset.v === v));
}
/** Greyed out, not hidden: the option stays visible so its irrelevance is legible, rather than
 *  the row silently changing shape. / 置灰而非隐藏:选项留在原处,让"此刻不适用"看得见,
 *  而不是让这一行悄悄改变形状。 */
const segDisable = (root, id, off) => qs('#' + id, root)?.classList.toggle('off', !!off);

/** Share whatever is selected -- one file, one folder, or any mix. The dialog composes a new
 *  link each time rather than editing "the" link of a node: a node can now sit in several
 *  shares at once, so there is no longer one canonical link to edit.
 *  分享选中的任意内容 —— 单个文件、单个目录,或任意混装。对话框每次组一条新链接,
 *  而不是编辑某个节点"那条"链接:一个节点如今可同时存在于多条共享里,已无唯一可编辑的链接。 */
async function shareDialog(nodes) {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  if (!list.length) return;
  const d = showModal(`
    <div class="modal-body" id="drv-share-body"><div class="loading">${esc(t('loading'))}</div></div>
    <div slot="footer" class="drv-share-foot" id="sh-foot">
      <wa-button variant="brand" id="sh-make">${icon('link', 16)} ${esc(t('drv_share_create'))}</wa-button>
    </div>`);
  d.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) closeModal(); });

  let domains = [];
  try { domains = (await api('GET', '/api/drive/share-domains')).domains || []; } catch {}

  // One item per line. A wrapped chip layout re-flows as names change length, which makes a
  // list of things you are about to hand out hard to scan; four lines then scroll keeps the
  // dialog a fixed size no matter how many were selected.
  // 一项一行。回绕的胶囊布局会随名字长短重新排布,让"即将交出去的东西"很难扫读;
  // 四行之后转为滚动,无论选了多少,对话框尺寸恒定。
  const items = list.map((n) => `
    <div class="it">${n.kind === 'folder' ? icon('folder', 22) : fileIcon(n.name, 22)}<span>${esc(n.name)}</span></div>`).join('');
  // Count and total sit below the list: with the list capped at four rows, the tally is the
  // only way to see the whole of what is going out once the rest has scrolled away. A folder
  // contributes its materialised subtree size, so the number means "this much will be readable".
  // 计数与总量放在列表下方:列表封顶四行,其余滚走之后,这行汇总是看清"总共要发出去多少"的
  // 唯一途径。目录按其物化的子树大小计入,因此这个数字的含义是"对方能读到这么多"。
  const total = list.reduce((s, n) => s + effSize(n), 0);

  const box = qs('#drv-share-body', d);
  box.innerHTML = `
    <div class="drv-dlg-head">
      <h3>${esc(t('drv_share'))}</h3>
      <button class="drv-x" data-x="close" aria-label="${esc(t('close'))}">${icon('close', 18)}</button>
    </div>
    <div class="drv-share-items">
      <div class="lst">${items}</div>
      <div class="sum">${esc(t('drv_share_n_items', String(list.length)))} · ${esc(fmtSize(total))}</div>
    </div>

    <div class="drv-share-line">
      <div class="f" id="f-aud">
        <label>${esc(t('drv_share_audience'))}</label>
        ${segHtml('sh-aud', [
          { v: 'internal', label: t('drv_share_aud_internal') },
          { v: 'public', label: t('drv_share_aud_public') },
        ], 'internal')}
      </div>
      <div class="f" id="f-role">
        <label>${esc(t('drv_role'))}</label>
        ${segHtml('sh-role', [
          { v: 'viewer', label: t('drv_role_viewer') },
          { v: 'editor', label: t('drv_role_editor') },
        ], 'viewer')}
      </div>
    </div>

    <div class="drv-share-line">
      <div class="f" id="f-dom">
        <label>${esc(t('drv_share_domain'))}</label>
        <wa-select id="sh-dom" value="" size="small" class="drv-share-sel">
          <wa-option value="">${esc(t('drv_share_domain_any'))}</wa-option>
          ${domains.map((x) => `<wa-option value="${esc(x.id)}">${esc(x.name)}</wa-option>`).join('')}
        </wa-select>
      </div>
      <div class="f" id="f-exp">
        <label>${esc(t('drv_share_expires'))}</label>
        <wa-select id="sh-exp" value="7" size="small" class="drv-share-sel">
          <wa-option value="2">${esc(t('drv_share_exp_48h'))}</wa-option>
          <wa-option value="7">${esc(t('drv_share_exp_7d'))}</wa-option>
          <wa-option value="30">${esc(t('drv_share_exp_30d'))}</wa-option>
          <wa-option value="0">${esc(t('drv_share_exp_never'))}</wa-option>
        </wa-select>
      </div>
    </div>

    <p class="drv-dim" id="sh-hint" style="margin:12px 0 0;font-size:12.5px"></p>`;

  // Public links are read-only, full stop: nobody is authenticated on the other end, so there
  // is no one to hold responsible for a write. The role control greys out rather than
  // vanishing, so the constraint is visible instead of the row quietly losing a field.
  // 公开链接一律只读:另一端没有任何已认证的人,写操作无从追责。
  // 权限控件置灰而非消失,于是这条约束是看得见的,而不是这一行悄悄少了个字段。
  const sync = () => {
    const pub = segGet(d, 'sh-aud') === 'public';
    // Snap the role back to viewer, not merely grey it out. A greyed control still showing
    // "editor" would be stating something the link will not do -- the request is forced to
    // viewer server-side either way, so the UI must not claim otherwise.
    // 把权限拨回查看者,而不只是置灰。一个置灰却仍显示"编辑者"的控件,是在陈述这条链接做不到的事 ——
    // 反正服务端也会强制为查看者,界面就不该说另一套。
    if (pub) segSet(d, 'sh-role', 'viewer');
    segDisable(d, 'sh-role', pub);
    // The domain field fades out label and all, but keeps its space: the row must not collapse
    // and reshuffle the remaining controls under the user's cursor.
    // 域名字段连标签一起淡出,但保留占位:这一行不能塌陷,
    // 否则会把剩下的控件在用户指针底下重新排一遍。
    qs('#f-dom', d).style.visibility = pub ? 'hidden' : '';
    qs('#sh-hint', d).textContent = t(pub ? 'drv_share_hint_public' : 'drv_share_hint_internal');
  };
  segBind(d, 'sh-aud', sync);
  segBind(d, 'sh-role');
  sync();

  qs('#sh-make', d).addEventListener('click', async () => {
    const audience = segGet(d, 'sh-aud');
    // Send the DURATION, never a computed deadline: this machine's clock has no authority over
    // when a link dies, and a skewed one would silently make the link permanent or short-lived.
    // 发送"时长",绝不发送算好的截止时刻:本机时钟无权决定链接何时失效,
    // 时钟偏了会悄无声息地把链接变成永久的、或早早失效的。
    const body = {
      nodes: list.map((n) => n.id),
      audience,
      role: audience === 'public' ? 'viewer' : segGet(d, 'sh-role'),
      domain_id: audience === 'internal' ? (qs('#sh-dom', d).value || null) : null,
      expires_days: parseInt(qs('#sh-exp', d).value, 10) || 0,
      // Carry the look along with the link. The palette is a company setting the public page can
      // look up for itself, but light/dark is this user's own choice and exists nowhere the
      // recipient can reach -- without recording it, a link made at night opens blindingly light.
      // 把观感一并带上。配色是企业设置,公开页自己就能查到;但明暗是本用户自己的选择,
      // 收件人那边无处可寻 —— 不记下来的话,深夜做的链接打开时会白得刺眼。
      theme: document.documentElement.dataset.theme || null,
      mode: document.documentElement.classList.contains('wa-dark') ? 'dark' : 'light',
      // The sharer knows who they are sending this to; the recipient's browser only knows where
      // that browser was installed. Language travels with the link for the same reason the
      // theme does.
      // 分享者清楚自己发给谁;接收方的浏览器只知道它自己装在哪儿。
      // 语言随链接同行,理由与主题相同。
      lang: lang(),
    };
    try {
      const s = await api('POST', '/api/drive/shares', body);
      const url = shareUrl(s);
      // The link takes over the button's own slot. There is exactly one thing to do at the
      // bottom of this dialog at any moment -- make the link, then take it -- and leaving a
      // spent "create" button sitting under the result invites a second, identical link.
      // 链接接管按钮自己的位置。此刻这个对话框底部只该有一件可做的事 —— 先造出链接,
      // 再把它拿走 —— 把用过的"创建"按钮留在结果下方,等于邀请再造一条一模一样的链接。
      qs('#sh-foot', d).innerHTML = `
        <div class="drv-share-link">
          <input readonly value="${esc(url)}" onclick="this.select()">
          <wa-button size="small" id="sh-copy">${icon('copy', 15)} ${esc(t('drv_copy_link'))}</wa-button>
        </div>`;
      qs('#sh-copy', d).addEventListener('click', async () => {
        await copyText(url);
        toast(t('drv_link_copied'));
      });
      reloadSoon();
    } catch (e) {
      toast(tErr(e && e.message), true);
    }
  });
}

/** Public links carry no account, so they get their own route; internal ones keep the
 *  join-then-browse flow. / 公开链接不带账号,因此走独立路由;内部链接沿用"加入后浏览"。 */
function shareUrl(s) {
  // An agent link is a real path, not a hash route: whatever fetches it never runs the app, so
  // the address has to mean something to a plain HTTP client.
  // 面向 AI 的链接是真实路径,而不是 hash 路由:取它的东西根本不会运行这个应用,
  // 于是这个地址必须对一个朴素的 HTTP 客户端就有意义。
  if (s.audience === 'agent') return `${location.origin}/agt/${s.token}`;
  return `${location.origin}/#/${s.audience === 'public' ? 'p' : 'drive/s'}/${s.token}`;
}

// ---------- Share links I created ----------
// ---------- 我创建的分享链接 ----------

/** The management list: every link this account handed out, what is in it, who it is for, and
 *  whether it still works. Revoking is one click and takes effect immediately -- the row stays
 *  behind as a tombstone so it is clear the link was killed rather than silently forgotten.
 *  管理列表:本账号发出的每条链接、里面装了什么、给谁、以及是否仍然有效。撤销一键完成、
 *  立刻生效 —— 该行会以墓碑形式留下,让人看清链接是被停掉了,而不是不声不响消失了。 */
function renderLinksView(main, shares) {
  const bots = shares.filter((s) => s.audience === 'agent');
  const rows = shares.filter((s) => s.audience !== 'agent').map((s) => {
    const dead = s.state !== 'ok';
    const url = shareUrl(s);
    const who = s.audience === 'public'
      ? t('drv_share_aud_public')
      : (s.domain_name ? t('drv_share_dom_only', s.domain_name) : t('drv_share_aud_internal'));
    const items = (s.items || []).map((n) =>
      `<span class="it">${icon(n.kind === 'folder' ? 'folder' : 'file', 14)}${esc(n.name)}</span>`).join('');
    const stateLbl = s.state === 'ok'
      ? (s.expires_at ? t('drv_share_until', fmtDate(s.expires_at)) : t('drv_share_exp_never'))
      : t(s.state === 'e_drive_share_revoked' ? 'drv_share_revoked' : 'drv_share_expired');
    return `
      <div class="drv-link-card ${dead ? 'dead' : ''}">
        <div class="hd">
          <span class="badge ${s.audience}">${esc(who)}</span>
          <span class="badge role">${esc(t(s.role === 'editor' ? 'drv_role_editor' : 'drv_role_viewer'))}</span>
          <span class="st">${esc(stateLbl)}</span>
          <span class="st">${esc(t('drv_share_created', fmtDate(s.created_at)))}${
            (s.members || []).length ? ' · ' + esc(t('drv_share_n_members', String(s.members.length))) : ''}</span>
          <span style="flex:1"></span>
          ${dead
            ? `<wa-button size="small" appearance="plain" data-forget="${esc(s.id)}">${esc(t('drv_share_forget'))}</wa-button>`
            : `<wa-button size="small" appearance="plain" data-copy="${esc(url)}">${icon('copy', 14)} ${esc(t('drv_copy_link'))}</wa-button>
               <wa-button size="small" appearance="plain" class="danger" data-stop="${esc(s.id)}">${esc(t('drv_share_stop'))}</wa-button>`}
        </div>
        <div class="items">${items || `<span class="drv-dim">${esc(t('drv_share_items_gone'))}</span>`}</div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div id="drv-bar">${barHtml()}</div>
    <div class="drv-scroll drv-links">
      ${rows}
      ${bots.length ? `
        <div class="drv-links-group">${icon('robot', 16)}<span>${esc(t('drv_agents'))}</span>
          <span class="sp"></span>
          <a class="more" href="#/drive/agents">${esc(t('drv_agent_manage'))}</a>
        </div>
        ${bots.map(agentCardHtml).join('')}` : ''}
      ${rows || bots.length ? '' : `<div class="drv-empty">${icon('link', 48)}<div>${esc(t('drv_share_none_yet'))}</div></div>`}
    </div>`;
  bindBar(main);
  bindLinkActions(main);
}

/** Copy, revoke, forget. The same three gestures on a share card and on an agent card -- the
 *  cards differ in what they say, never in what you can do about them.
 *  复制、撤销、移除。分享卡片与 AI 卡片上是同样这三个动作 ——
 *  两种卡片的差别在于它们说了什么,而不在于你能拿它们怎么办。 */
function bindLinkActions(main) {
  qsa('[data-copy]', main).forEach((b) => b.addEventListener('click', async () => {
    await copyText(b.dataset.copy);
    toast(t('drv_link_copied'));
  }));
  qsa('[data-stop]', main).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog(t('drv_share_stop_confirm'), t('drv_share_stop')))) return;
    try {
      await api('DELETE', `/api/drive/shares/${b.dataset.stop}`);
      reload();
    } catch (e) { toast(tErr(e && e.message), true); }
  }));
  qsa('[data-forget]', main).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('POST', `/api/drive/shares/${b.dataset.forget}/forget`);
      reload();
    } catch (e) { toast(tErr(e && e.message), true); }
  }));
}
// ---------- Agent access ----------
// ---------- 面向 AI 的访问 ----------

/** Hand a set of items to a program. Deliberately not a mode of the share dialog: there is no
 *  audience to pick, no domain, no expiry -- only how much the program may do -- and putting
 *  those absent fields on screen greyed out would say the choice exists.
 *  把一组条目交给一个程序。刻意不做成分享对话框的一种模式:这里没有受众可选、没有域名、
 *  没有有效期,只有"程序能做到多少" —— 把那些不存在的字段置灰摆在屏幕上,
 *  等于宣称这些选择是存在的。 */
async function agentDialog(nodes) {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  if (!list.length) return;
  const d = showModal(`
    <div class="modal-body" id="drv-agent-body"></div>
    <div slot="footer" class="drv-share-foot" id="ag-foot">
      <wa-button variant="brand" id="ag-make">${icon('robot', 16)} ${esc(t('drv_agent_create'))}</wa-button>
    </div>`);
  d.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) closeModal(); });

  const items = list.map((n) => `
    <div class="it">${n.kind === 'folder' ? icon('folder', 22) : fileIcon(n.name, 22)}<span>${esc(n.name)}</span></div>`).join('');
  const total = list.reduce((s, n) => s + effSize(n), 0);

  qs('#drv-agent-body', d).innerHTML = `
    <div class="drv-dlg-head">
      <h3>${icon('robot', 20)} ${esc(t('drv_agent_access'))}</h3>
      <button class="drv-x" data-x="close" aria-label="${esc(t('close'))}">${icon('close', 18)}</button>
    </div>
    <div class="drv-share-items">
      <div class="lst">${items}</div>
      <div class="sum">${esc(t('drv_share_n_items', String(list.length)))} · ${esc(fmtSize(total))}</div>
    </div>
    <div class="drv-share-line">
      <div class="f">
        <label>${esc(t('drv_agent_via'))}</label>
        ${segHtml('ag-via', [
          { v: 'dav', label: t('drv_agent_via_mount') },
          { v: 'http', label: t('drv_agent_via_url') },
        ], 'dav')}
      </div>
      <div class="f">
        <label>${esc(t('drv_agent_can'))}</label>
        ${segHtml('ag-role', [
          { v: 'viewer', label: t('drv_agent_ro') },
          { v: 'editor', label: t('drv_agent_rw') },
        ], 'viewer')}
      </div>
    </div>
    <p class="drv-dim" id="ag-hint" style="margin:12px 0 0;font-size:12.5px"></p>`;

  // Two sentences, one per control: what the agent will be holding, then what it may do with it.
  // Naming the protocols here would answer a question the person choosing is not asking --
  // they are deciding how their assistant should work, not which RFC it should speak.
  // 两句话,一个控件一句:代理最后握着的是什么,以及它可以拿它做什么。
  // 在这里报协议名,是在回答一个"做选择的人"根本没问的问题 ——
  // 他决定的是助手该怎么干活,而不是它该讲哪份 RFC。
  const sync = () => {
    const via = segGet(d, 'ag-via') === 'dav' ? 'drv_agent_hint_mount' : 'drv_agent_hint_url';
    const can = segGet(d, 'ag-role') === 'editor' ? 'drv_agent_hint_rw' : 'drv_agent_hint_ro';
    qs('#ag-hint', d).textContent = `${t(via)} ${t(can)}`;
  };
  segBind(d, 'ag-via', sync);
  segBind(d, 'ag-role', sync);
  sync();

  qs('#ag-make', d).addEventListener('click', async () => {
    try {
      // No theme, no mode, no language: nothing on the other end has an interface to match.
      // 不带主题、不带明暗、不带语言:另一端没有任何界面需要对齐。
      const s = await api('POST', '/api/drive/shares', {
        nodes: list.map((n) => n.id), audience: 'agent', role: segGet(d, 'ag-role'),
        agent_mode: segGet(d, 'ag-via'),
      });
      const url = shareUrl(s);
      // Say when the link is one that already existed. It looks identical to a fresh one, and
      // the difference matters: this address may already be in a config somewhere, and it was
      // created on a day the owner may want to go and look up.
      // 如果这条链接是本来就有的,要说出来。它和新造的一条看起来一模一样,而这个差别是要紧的:
      // 这个地址可能早已写在某处的配置里,而它的创建日期可能正是所有者想去查的那一天。
      if (s.reused) qs('#ag-hint', d).textContent = t('drv_agent_reused');
      qs('#ag-foot', d).innerHTML = `
        <div class="drv-share-link">
          <input readonly value="${esc(url)}" onclick="this.select()">
          <wa-button size="small" id="ag-copy">${icon('copy', 15)} ${esc(t('drv_copy_link'))}</wa-button>
        </div>`;
      qs('#ag-copy', d).addEventListener('click', async () => {
        await copyText(url);
        toast(t('drv_link_copied'));
      });
      reloadSoon();
    } catch (e) {
      toast(tErr(e && e.message), true);
    }
  });
}

/** The agent links this account handed out. Same management gestures as the share list, but on
 *  its own screen: what matters about one of these is what it can do and what it can reach, not
 *  who was invited -- there is nobody to invite.
 *  本账号发出的面向 AI 的链接。管理动作与分享列表相同,但自成一屏:
 *  这类链接要紧的是"能做什么、能碰到什么",而不是"邀请了谁" —— 这里没有人可邀请。 */
function agentCardHtml(s) {
  const dead = s.state !== 'ok';
  const url = shareUrl(s);
  const items = (s.items || []).map((n) =>
    `<span class="it">${icon(n.kind === 'folder' ? 'folder' : 'file', 14)}${esc(n.name)}</span>`).join('');
  return `
      <div class="drv-link-card ${dead ? 'dead' : ''}">
        <div class="hd">
          <span class="badge agent">${icon('robot', 14)}${esc(t(s.agent_mode === 'dav' ? 'drv_agent_via_mount' : 'drv_agent_via_url'))}</span>
          <span class="badge role">${esc(t(s.role === 'editor' ? 'drv_agent_rw' : 'drv_agent_ro'))}</span>
          <span class="st">${esc(dead ? t('drv_share_revoked') : t('drv_share_exp_never'))}</span>
          <span class="st">${esc(t('drv_share_created', fmtDate(s.created_at)))}</span>
          <span style="flex:1"></span>
          ${dead
            ? `<wa-button size="small" appearance="plain" data-forget="${esc(s.id)}">${esc(t('drv_share_forget'))}</wa-button>`
            : `<wa-button size="small" appearance="plain" data-copy="${esc(url)}">${icon('copy', 14)} ${esc(t('drv_copy_link'))}</wa-button>
               <wa-button size="small" appearance="plain" class="danger" data-stop="${esc(s.id)}">${esc(t('drv_share_stop'))}</wa-button>`}
        </div>
        ${dead ? '' : `<div class="url"><code>${esc(url)}</code></div>`}
        <div class="items">${items || `<span class="drv-dim">${esc(t('drv_share_items_gone'))}</span>`}</div>
      </div>`;
}

function renderAgentsView(main, shares) {
  const rows = shares.map(agentCardHtml).join('');

  main.innerHTML = `
    <div id="drv-bar">${barHtml()}</div>
    <div class="drv-scroll drv-links">
      ${rows || `<div class="drv-empty">${icon('robot', 48)}<div>${esc(t('drv_agent_none_yet'))}</div>
        <div class="drv-dim">${esc(t('drv_agent_none_hint'))}</div></div>`}
    </div>`;
  bindBar(main);
  bindLinkActions(main);
}

// ---------- Shared-with-me ----------
// ---------- 共享给我 ----------

/** Step out of a share. The share itself is untouched -- this only ends this account's
 *  membership of it, which is why it reads as leaving rather than as deleting.
 *  退出一个共享。共享本身分毫未动 —— 这里结束的只是本账号在其中的成员资格,
 *  所以它读作"离开"而不是"删除"。 */
async function leaveShare(n) {
  if (!(await confirmDialog(t('drv_leave_confirm'), t('drv_leave_share')))) return;
  try {
    await api('DELETE', `/api/drive/shares/${n.share_id}/members/${store.me.user.id}`);
    reload();
  } catch (e) {
    toast(tErr(e && e.message), true);
  }
}

// ---------- Preview overlay ----------
// ---------- 预览层 ----------

let pv = null; // { list, idx, el }

function openPreview(node) {
  openPreviewFor(dst.shown.filter((n) => n.kind === 'file'), node);
}

/** Same overlay for an arbitrary file list -- arc.js feeds archive entries through here
 *  同一预览层接受任意文件列表 —— arc.js 的压缩包条目走这里 */
export function openPreviewFor(files, node) {
  const idx = Math.max(0, files.findIndex((n) => n.id === node.id));
  pv?.el?.remove();
  pv = { list: files.length ? files : [node], idx, el: document.createElement('div'), vers: null, verSel: null };
  pv.el.className = 'drv-view';
  document.body.appendChild(pv.el);
  paintPreview();
  window.addEventListener('keydown', pvKeys);
}

// The archive browser opens entries through this same overlay. It registers rather than being
// imported so arc.js needs nothing from this module -- see the note in fsrc.js.
// 压缩包浏览器经由同一个预览层打开条目。用登记而非被引入的方式,
// arc.js 就不需要从本模块取任何东西 —— 缘由见 fsrc.js 中的说明。
setPreviewOpener(openPreviewFor);

/** Detached media elements keep streaming until src is cleared -- Chrome only tears the
 *  fetch down on an explicit load() with no source. Applies to every preview teardown.
 *  脱离 DOM 的媒体元素不清 src 会一直拉流 —— Chrome 要显式空源 load() 才断开。
 *  所有预览销毁路径都要过这一步。 */
function killMedia(rootEl) {
  rootEl?.querySelectorAll?.('video, audio').forEach((m) => {
    try {
      m.pause();
    } catch {}
    m.removeAttribute('src');
    try {
      m.load();
    } catch {}
  });
}

let pvPlayer = null;

function closePreview() {
  pvPlayer?.destroy();
  pvPlayer = null;
  dropPvBlob();
  destroyPdfPreview();
  pvRich?.destroy?.();
  pvRich = null;
  killMedia(pv?.el);
  pv?.el?.remove();
  pv = null;
  window.removeEventListener('keydown', pvKeys);
}

// Rich document previews (text/code/md/docx/pptx/html/mhtml/svg/drawio) live in preview.js,
// loaded on demand; it hands back a destroy() for blob URLs and friends.
// 富文档预览(文本/代码/md/docx/pptx/html/mhtml/svg/drawio)在 preview.js 里按需加载;
// 它返回 destroy() 用于释放 blob URL 等资源。
let pvRich = null;

function spinnerHtml() {
  return `<div class="drv-loading"><div class="drv-spin"></div><span>${esc(t('loading'))}</span></div>`;
}

// ---------- User-adjustable preview width ----------
// Symmetric drag: pulling one edge mirrors the other, so the flex-centred window never drifts
// off centre. The chosen width persists across sessions.
// ---------- 用户可调的预览宽度 ----------
// 对称拖拽。拉一边另一边镜像变化,flex 居中的窗口永不偏移。选定宽度跨会话记住。

const PVW_KEY = 'cf_drive_pvw';
const pvwClamp = (w) => Math.max(480, Math.min(Math.round(w), innerWidth - 64));

function applyPreviewWidth(doc) {
  const w = parseInt(localStorage.getItem(PVW_KEY) || '', 10);
  if (Number.isFinite(w) && w >= 480) doc.style.width = pvwClamp(w) + 'px';
}

function bindPreviewResize(doc) {
  for (const side of ['l', 'r']) {
    const h = document.createElement('div');
    h.className = 'drv-rsz ' + side;
    doc.appendChild(h);
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        h.setPointerCapture(e.pointerId);
      } catch {}
      h.classList.add('drag');
      const startX = e.clientX;
      const startW = doc.getBoundingClientRect().width;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        doc.style.width = pvwClamp(startW + (side === 'r' ? 2 * dx : -2 * dx)) + 'px';
      };
      const up = () => {
        h.classList.remove('drag');
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        localStorage.setItem(PVW_KEY, String(Math.round(doc.getBoundingClientRect().width)));
        // Canvas-based previews (pdf, drawio) re-render at the new width; DOM previews are fluid
        // 画布类预览(pdf、drawio)按新宽度重渲。DOM 类是流式的,无需重来
        if (pv?.el?.querySelector('.drv-pdf-page, .drv-canvaspage')) paintPreview();
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
  }
}

function noprevHtml(n, why) {
  return `<div class="noprev" style="margin:auto">${fileIcon(n.name, 72)}<div>${esc(why || t('drv_no_preview'))}</div></div>`;
}

async function richPreview(n) {
  // Renderers replace this inner container's innerHTML; the resize grips live on .drv-doc
  // itself and survive.
  // 渲染器整体替换这个内层容器的 innerHTML。宽度手柄挂在外层 .drv-doc 上,不受影响。
  const box = pv?.el?.querySelector('.drv-docc');
  if (!box) return;
  try {
    const mod = await import('./preview.js?v=' + encodeURIComponent(store.brand?.version || ''));
    if (!box.isConnected) return;
    const vn = verView(n);
    const kind = mod.kindOf(vn.name, vn.mime);
    if (!kind) {
      box.innerHTML = noprevHtml(n);
      return;
    }
    pvRich = await mod.renderPreview(vn, box, kind, n.arcUrl || pvSrc(n, true));
  } catch {
    if (box.isConnected) box.innerHTML = noprevHtml(n);
  }
}

// ---------- PDF preview via self-hosted pdf.js ----------
// The browser's built-in viewer lived in an iframe we could not style (its scrollbar ignored
// our theme); rendering pages onto our own canvases makes the scroll container ours, so the
// global themed scrollbar rules apply. Pages render lazily as they scroll into view.
// ---------- PDF 预览改用自托管 pdf.js ----------
// 浏览器内置查看器在 iframe 里,样式够不到(滚动条不跟主题)。改成把页面画到我们自己的
// canvas 上,滚动容器就是我们的,全局主题滚动条规则直接生效。页面滚到可视区才渲染。

let pvPdf = null; // { task, io, gen } 当前预览中的 PDF 加载任务与懒渲染观察器

function destroyPdfPreview() {
  if (!pvPdf) return;
  pvPdf.gen++;
  pvPdf.pager?.destroy();
  // v6: cleanup goes through the loading task (PDFDocumentProxy lost its destroy())
  // v6 的清理走 loading task(PDFDocumentProxy 已没有 destroy())
  pvPdf.task?.destroy?.().catch?.(() => {});
  pvPdf = null;
}

async function renderPdfPreview(node, box) {
  destroyPdfPreview();
  const my = { task: null, pager: null, gen: 0 };
  pvPdf = my;
  const gen = my.gen;
  try {
    const mod = await loadThumbMod();
    const lib = await mod.pdfjs();
    // Ranged when the bytes are behind a URL that answers Range: pdf.js then reads the tail
    // for the cross-reference table and pulls each page's objects as that page is rendered, so
    // a 200 MB scan shows its first page without downloading 200 MB. An archive entry is
    // excluded on purpose -- its bytes come from the streaming worker, where a scatter of small
    // ranges means decoding a compressed block over and over.
    // 当字节位于一个响应 Range 的 URL 之后时走 Range:pdf.js 先读文件尾取交叉引用表,
    // 再随每页渲染去取该页所需的对象,于是 200 MB 的扫描件不必下完 200 MB 就能显示第一页。
    // 压缩包内条目有意排除 —— 它的字节来自流式 worker,零散的小 Range 意味着
    // 同一个压缩块被反复解码。
    const url = node.arcUrl || dlUrl(node.id, true, verTag(node));
    // Only worth it above a size. Ranged loading trades one request for a dozen, and pdf.js
    // chases objects across the file to open it at all -- measured on a 2 MB PDF it still
    // pulled 88% of it, in nine round trips instead of one. The saving is the part of a big
    // file nobody scrolls to, so the threshold is where that part starts to be worth having.
    // 大到一定程度才划算。Range 加载把一次请求换成十几次,而 pdf.js 光是打开就要在文件里
    // 四处追对象 —— 在一个 2 MB 的 PDF 上实测仍拉了 88%,还多花了八个来回。
    // 省下的是大文件里没人滚到的那一部分,所以门槛设在"那一部分开始值得省"的地方。
    const PDF_RANGE_MIN = 8 * 1024 * 1024;
    const ranged = !node.arc && !url.startsWith('blob:') && node.size > PDF_RANGE_MIN;
    let opts;
    if (ranged) {
      opts = mod.pdfDocOpts(url, node.size);
    } else {
      const r = await fetch(url);
      if (!r.ok) throw new Error('fetch');
      opts = mod.pdfDocOpts(await r.arrayBuffer());
    }
    const task = lib.getDocument(opts);
    my.task = task;
    const doc = await task.promise;
    // The user may have moved on while we were loading
    // 加载期间用户可能已经翻走了
    if (pvPdf !== my || my.gen !== gen || !box.isConnected) {
      task.destroy().catch(() => {});
      return;
    }
    const width = Math.min(Math.max(360, box.clientWidth - 60), 1800);
    const p1 = await doc.getPage(1);
    const vp1 = p1.getViewport({ scale: 1 });
    const estH = Math.round((width * vp1.height) / vp1.width);
    box.innerHTML = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const d = document.createElement('div');
      d.className = 'drv-pdf-page pending';
      d.dataset.page = i;
      d.style.width = width + 'px';
      d.style.height = estH + 'px';
      // A page that has not been rasterised yet says so. Blank paper of the right size is
      // indistinguishable from a page that really is blank.
      // 尚未光栅化的页面要把这件事说出来。一张尺寸正确的空白纸,
      // 与一张真的空白的页面无从分辨。
      d.innerHTML = `<div class="drv-loading"><div class="drv-spin"></div></div>`;
      box.appendChild(d);
    }
    const renderPage = async (holder) => {
      if (holder.dataset.done || pvPdf !== my) return;
      holder.dataset.done = '1';
      try {
        const page = await doc.getPage(parseInt(holder.dataset.page, 10));
        if (pvPdf !== my) return;
        const scale = width / page.getViewport({ scale: 1 }).width;
        const dpr = Math.min(devicePixelRatio || 1, 2);
        const vp = page.getViewport({ scale: scale * dpr });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        // intent 'print' renders via microtasks, so pages keep completing even if the tab
        // gets hidden mid-scroll (default scheduling parks on requestAnimationFrame)
        // intent 'print' 用微任务推进渲染,滚动途中切走标签页也能画完
        // (默认调度停在 requestAnimationFrame 上)
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise;
        if (pvPdf !== my) return;
        holder.style.height = 'auto';
        holder.classList.remove('pending');
        holder.replaceChildren(c);
      } catch {}
    };
    // Which page to rasterise next is a decision, not a queue: during a fast scroll the pages
    // that swept past are dropped and the one the reader stopped on is taken first.
    // 下一个光栅化哪一页是一项决策,而不是一条队列:快速滚动中掠过的那些页被丢掉,
    // 读者停下来看的那一页最先被取。
    const { lazyPages } = await import('./lazypage.js?v=' + encodeURIComponent(store.brand?.version || ''));
    if (pvPdf !== my || my.gen !== gen || !box.isConnected) return;
    my.pager = lazyPages({ root: box, items: [...box.children], margin: 600, render: renderPage });
  } catch {
    if (pvPdf === my && box.isConnected) {
      box.innerHTML = `<div class="noprev" style="margin-top:60px">${fileIcon(node.name, 72)}<div>${esc(t('drv_no_preview'))}</div></div>`;
    }
  }
}

function pvKeys(e) {
  if (!pv) return;
  // A film answers to most of these itself -- space, the arrows, m, f -- and only what it does
  // not take goes on to mean "the next file".
  // 一部片子自己就听得懂这里的大部分按键 —— 空格、方向键、m、f ——
  // 只有它没接下的那些,才继续表示"下一个文件"。
  if (e.key !== 'Escape' && pvPlayer?.keys(e)) return;
  if (e.key === 'Escape') closePreview();
  else if (e.key === 'ArrowLeft') pvStep(-1);
  else if (e.key === 'ArrowRight') pvStep(1);
}

/** Show a "decompressing X% · Y MB/s" pill over an archive preview while the worker decodes,
 *  driven by its fill/stat counters. Works for a media element (hide on canplay, reappear on
 *  stall) and for an <img> (hide on load). The percentage tracks the whole solid block for 7z.
 *  在压缩包预览上显示"解压缓冲中 X% · Y MB/s"提示,数据取自 worker 的填充/stat 计数。
 *  媒体元素(可播即隐、停滞再现)与 <img>(载入即隐)都适用。7z 的百分比按整个固实块计。 */
function attachArcProgress(n, el) {
  if (!el) return;
  // The readout belongs directly under the spinner, sharing its column -- pinned to the bottom
  // of the frame it reads as an unrelated caption, and for media it floated over the controls.
  // 读数就该在加载动画正下方、与它同列 —— 钉在画面底部时像一句不相干的字幕,
  // 媒体预览时还会浮在控制条上面。
  const veil = pv.el.querySelector('.drv-pvwait');
  const note = document.createElement('div');
  note.className = 'drv-arcbuf';
  note.textContent = t('drv_arc_buffering');
  (veil || el.parentElement || pv.el.querySelector('.drv-view-body') || pv.el).appendChild(note);
  const statUrl = n.arcUrl + (n.arcUrl.includes('?') ? '&' : '?') + 'stat=1';
  const poll = async () => {
    if (note.style.display === 'none' || !note.isConnected) return;
    try {
      const s = await (await fetch(statUrl)).json();
      if (!s || !s.total || s.idle || s.done) return;
      const bw = s.bps > 0 ? ` · ${fmtSize(s.bps)}/s` : '';
      // Seeking into a compressed stream means decoding the gap and discarding it; say that
      // rather than calling it buffering, which suggests the wait is about to end.
      // 跳转进压缩流意味着把中间那段解出来再丢掉;如实说明,而不是叫它缓冲 ——
      // 那会让人以为马上就好了。
      const label = t(s.skipping ? 'drv_arc_skipping' : 'drv_arc_buffering');
      note.textContent = `${label} ${Math.min(100, (s.written / s.total) * 100).toFixed(0)}%${bw}`;
    } catch {}
  };
  const timer = setInterval(() => {
    if (!el.isConnected) {
      clearInterval(timer);
      note.remove();
      return;
    }
    poll();
  }, 800);
  poll();
  // Spinner, readout and player are one unit: the player only shows once it can actually play,
  // and goes back under the spinner on a stall. A visible-but-dead control bar just invites
  // clicking at it. / 加载动画、读数与播放器是一体的:真的能播了播放器才现身,卡顿了退回
  // 加载动画之下。露着一条按不动的控件条,只会招人反复去点。
  const hide = () => { note.style.display = 'none'; if (veil) veil.style.display = 'none'; el.classList.remove('drv-wait'); };
  const show = () => { note.style.display = ''; if (veil) veil.style.display = ''; el.classList.add('drv-wait'); poll(); }; // 只显形,数字靠轮询
  const isMedia = el.tagName === 'VIDEO' || el.tagName === 'AUDIO';
  if (isMedia) {
    el.addEventListener('canplay', hide);
    el.addEventListener('playing', hide);
    el.addEventListener('waiting', show);
    el.addEventListener('stalled', show);
  } else {
    el.addEventListener('load', hide, { once: true }); // <img> finished loading / 图片载入完成
  }
  el.addEventListener('error', () => {
    clearInterval(timer);
    note.remove();
    const body = pv.el.querySelector('.drv-view-body');
    if (body && pv.list[pv.idx] === n) body.innerHTML = noprevHtml(n);
  }, { once: true });
}

function pvStep(d) {
  if (!pv || pv.list.length < 2) return;
  pv.idx = (pv.idx + d + pv.list.length) % pv.list.length;
  // The next file's history is its own; carrying the last one's selection over would show you
  // version four of something that has three.
  // 下一个文件的历史是它自己的;把上一个的选择带过来,会让你看到一个只有三版的东西的第四版。
  pv.vers = null;
  pv.verSel = null;
  paintPreview();
}

/** The version currently on screen, or null while the file's own current bytes are.
 *  此刻显示在屏幕上的那一版;显示的是文件自身当前字节时为 null。 */
const pvVer = () => (pv?.verSel && pv.vers ? pv.vers.find((v) => v.id === pv.verSel) : null) || null;

/** The node as that version: same name and permissions, that version's size and type. The
 *  renderers read size to decide how much to fetch, so handing them the live one would have them
 *  reading past the end of an older, shorter file.
 *  以那一版的面目出现的节点:同样的名字与权限,那一版的大小与类型。
 *  渲染器靠 size 决定取多少字节,把当前那个交给它们,会让它们读过一个更旧更短的文件的末尾。 */
function verView(node) {
  const v = pvVer();
  return v ? { ...node, size: v.size, mime: v.mime || node.mime } : node;
}

const pvSrc = (node, inline) => (pv?.verSel ? verUrl(node.id, pv.verSel, inline) : dlUrl(node.id, inline, verTag(node)));

function pickVersion(id) {
  if (!pv) return;
  // Picking the newest is picking the file itself, not a copy of it that happens to match.
  // 选中最新的那一版,选中的就是文件本身,而不是一份恰好一模一样的副本。
  const head = pv.vers?.find((v) => v.head);
  pv.verSel = head && head.id === id ? null : id;
  paintPreview();
}

/** The rail down the left of the preview: every version this file kept, newest at the top.
 *  预览左侧的那一条:这个文件留下的每一版,最新的在上面。 */
function pvVersionsHtml() {
  const vs = pv?.vers;
  if (!vs?.length) return '';
  const cur = pv.verSel || vs.find((v) => v.head)?.id;
  // The chain is drawn where a version carried on from the one before it. A break gets no mark of
  // its own, because it already has the only one that matters: a link that is not there. A gap in
  // a column of chain links is found by the eye before anybody reads a single label -- and marking
  // breaks instead would put a warning on the ordinary way a mounted volume saves a file.
  // 链条画在"这一版承接了上一版"的地方。断裂不需要属于自己的标记,因为它已经有了唯一要紧的那个:
  // 一个没有出现的环。一列链环里的空缺,在任何人读到一个字之前就被眼睛找到了 ——
  // 而反过来去标记断裂,等于给"挂载的卷保存文件"这件再寻常不过的事挂上一个警告。
  const row = (v) => `
    <button class="vrow ${v.id === cur ? 'on' : ''}" data-ver="${esc(v.id)}">
      <span class="lk">${v.seq > 1 && !v.detached ? `<i title="${esc(t('drv_ver_link'))}">${icon('link', 12)}</i>` : ''}</span>
      <span class="sq">v${v.seq}</span>
      <span class="vt">${esc(fmtDateTime(v.created_at))}</span>
    </button>`;
  return `<div class="drv-pvvers"><div class="vhd">${esc(t('drv_ver_title', vs.length))}</div>${vs.map(row).join('')}</div>`;
}

/** Put the rail in without repainting the preview: the file may be a video that just started
 *  playing, and a repaint would take it back to zero to say something it could be told quietly.
 *  把左栏放进去,而不重绘预览:那个文件可能是一段刚开始播的视频,
 *  为了说一件本可以悄悄说的事而重绘,会把它退回到零秒。 */
function mountVersionRail() {
  const body = pv?.el?.querySelector('.drv-view-body');
  if (!body) return;
  body.querySelector('.drv-pvvers')?.remove();
  const html = pvVersionsHtml();
  if (html) body.insertAdjacentHTML('afterbegin', html);
}

async function loadVersions(node) {
  // Archive entries have no history, a public share does not serve one, and a file that keeps
  // none has nothing to list. None of those are worth a request that can only come back empty.
  // 压缩包条目没有历史,公开分享不供应历史,而不保留历史的文件没有什么可列。
  // 这几种都不值得为一个只可能空手而归的请求跑一趟。
  if (!pv || pv.vers !== null || isPub() || node.arc || !node.versioned) return;
  const id = node.id;
  try {
    const r = await api('GET', `/api/drive/nodes/${encodeURIComponent(id)}/versions`);
    if (!pv || pv.list[pv.idx]?.id !== id) return;
    pv.vers = r.versions || [];
    mountVersionRail();
  } catch {
    // Someone reading a share they may only view cannot read its drafts; the rail never appears,
    // and saying so out loud would be telling them about a door that is not theirs.
    // 一个只被允许查看某份共享的人,读不到它的草稿;左栏因此不出现,
    // 而把这件事说出口,等于告诉他有一扇不属于他的门。
    if (pv) pv.vers = [];
  }
}

/** Overlay chrome shared by the normal path and the extract-in-progress state
 *  预览层外壳。正常路径与"解出中"状态共用 */
function paintPvShell(n, body) {
  // Whatever was on the last film goes with the last film's shell.
  // 上一部片子上挂着的东西,随上一部片子的壳一起走。
  pvPlayer?.destroy();
  pvPlayer = null;
  const vn = verView(n);
  pv.el.innerHTML = `
    <div class="drv-view-head">
      <wa-button class="icon" appearance="plain" data-close aria-label="${esc(t('close'))}">${icon('close', 20)}</wa-button>
      ${fileIcon(n.name, 20)}<span class="nm">${esc(n.name)}</span>
      <span class="drv-dim" style="color:#aaa;font-size:12.5px">${fmtSize(vn.size)}</span>
      <wa-button class="icon" appearance="plain" data-dl aria-label="${esc(t('drv_download'))}">${icon('download', 20)}</wa-button>
    </div>
    <div class="drv-view-body">
      ${pvVersionsHtml()}
      ${pv.list.length > 1 ? `<wa-button class="icon drv-view-nav prev" appearance="plain" data-nav="-1">${icon('back', 22)}</wa-button>` : ''}
      ${body}
      ${pv.list.length > 1 ? `<wa-button class="icon drv-view-nav next" appearance="plain" data-nav="1">${icon('next', 22)}</wa-button>` : ''}
    </div>`;
  pv.el.onclick = (e) => {
    const vrow = e.target.closest('[data-ver]');
    if (e.target.closest('[data-close]')) closePreview();
    // What you are looking at is what you get -- the button downloads the selected version,
    // not whichever one happens to be current.
    // 你正在看的就是你会拿到的 —— 这个按钮下载的是选中的那一版,而不是碰巧最新的那一版。
    else if (e.target.closest('[data-dl]')) downloadFile(n, pv?.verSel || '');
    else if (vrow) pickVersion(vrow.dataset.ver);
    else if (e.target.closest('[data-nav]')) pvStep(parseInt(e.target.closest('[data-nav]').dataset.nav, 10));
    // A picture is left by clicking away from it, which is how every viewer works. A film is
    // not: the space beside a film is where a hand rests during two hours of watching, and one
    // stray click there should not end the film. The close button is the way out, and Escape.
    // 一张图片,靠"点开它旁边"来离开,所有看图的东西都是这么做的。一部片子不是:
    // 片子旁边那片空处,是人在两个小时的观看里搁手的地方,而那里一次无心的点击不该结束这部片子。
    // 出口是关闭按钮,以及 Escape。
    else if (e.target === pv.el.querySelector('.drv-view-body')
      && !pv.el.querySelector('.drv-view-body video, .drv-view-body audio')) closePreview();
  };
}

/** The film being watched, and the handle the browser watches it through.
 *
 *  One at a time. The film owns a demuxer, a muxer and a WebAssembly instance, and it goes on
 *  converting for as long as anybody is pulling from it -- so moving to the next preview has to let
 *  go of it, or two conversions run at once over one library and neither is watching the screen.
 *
 *  正在被看的那部片子,以及浏览器透过它去看的那个把手。
 *
 *  一次一部。片子持有一个解复用器、一个 muxer 和一个 WebAssembly 实例,而只要还有人向它取,
 *  它就一直在转 —— 所以换到下一个预览时必须把它放掉,
 *  否则两次转换会同时压在同一个库上,而其中没有一个在看着屏幕。 */
let pvBlob = null;
let pvFilm = null;
function dropPvBlob() {
  dropSubs();
  if (pvBlob) URL.revokeObjectURL(pvBlob);
  pvBlob = null;
  const film = pvFilm;
  pvFilm = null;
  if (film) void film.close().catch(() => {});
}

/** How far ahead of what is being watched the conversion is allowed to get, and how much of what
 *  has already been watched is kept behind it.
 *
 *  Both are there for the same reason: a four-gigabyte film converted as fast as it can be is four
 *  gigabytes in a tab. Ahead is what stops it running away; behind is what stops what it has done
 *  from piling up. Thirty seconds of each is enough to ride out a slow stretch of network and small
 *  enough that neither is ever more than a few tens of megabytes.
 *
 *  转换最多可以跑在"正在看的地方"前面多远,以及已经看过的东西在它后面留多少。
 *
 *  两者是为同一件事而设的:一部四吉字节的片子若以它能达到的最快速度转换,就是标签页里的四吉字节。
 *  "前面"是不让它跑掉的东西,"后面"是不让它做过的东西堆起来的东西。
 *  各三十秒,足以熬过一段慢网络,又小到两者都不会超过几十兆字节。 */
const AHEAD = 30;
const BEHIND = 30;

/** Wait for the buffer to finish whatever it is doing. Every operation on it is asynchronous and
 *  only one can be in flight, so this comes before each of them.
 *  等缓冲区把手上的事做完。它上面的每一个操作都是异步的,而且同时只能有一个在进行,
 *  所以每一个之前都要先来这一下。 */
const sbIdle = (sb) => (sb.updating
  ? new Promise((go) => sb.addEventListener('updateend', go, { once: true }))
  : Promise.resolve());

const sbHas = (sb, at) => {
  const b = sb.buffered;
  for (let i = 0; i < b.length; i++) if (at >= b.start(i) - 0.2 && at < b.end(i)) return true;
  return false;
};

/** How much film is ready after the point being watched. 正在看的那一点之后,还有多少片子备好了。 */
const sbAhead = (sb, v) => {
  const b = sb.buffered;
  for (let i = 0; i < b.length; i++) {
    if (v.currentTime >= b.start(i) - 0.2 && v.currentTime <= b.end(i)) return b.end(i) - v.currentTime;
  }
  return 0;
};

const sbDrop = async (sb, from, to) => {
  await sbIdle(sb);
  if (!(to > from)) return;
  try { sb.remove(from, to); } catch { return; }
  await sbIdle(sb);
};

/** Hand a piece over, making room for it if there is none.
 *
 *  A buffer that is full does not warn: it throws, on the append, and what has to happen then is
 *  that something already watched is thrown away and the piece offered again.
 *
 *  把一块交过去;若没地方了,就腾出地方来。
 *
 *  一个满了的缓冲区不会预警:它在 append 上抛出来 —— 而此时该做的事,
 *  是把已经看过的某些东西扔掉,再把这一块递一次。 */
async function sbPut(sb, piece, v) {
  for (let go = 0; go < 3; go++) {
    await sbIdle(sb);
    try {
      sb.appendBuffer(piece);
      await sbIdle(sb);
      return true;
    } catch (e) {
      if (e?.name !== 'QuotaExceededError') return false;
      await sbDrop(sb, 0, Math.max(0, v.currentTime - 5));
    }
  }
  return false;
}

/** Wait until something worth waking up for happens, or half a second, whichever comes first.
 *  等到有值得醒来的事发生,或者半秒钟,以先到者为准。 */
const sbRest = (v) => new Promise((go) => {
  let timer = 0;
  const done = () => {
    clearTimeout(timer);
    v.removeEventListener('timeupdate', done);
    v.removeEventListener('seeking', done);
    go();
  };
  timer = setTimeout(done, 500);
  v.addEventListener('timeupdate', done);
  v.addEventListener('seeking', done);
});

/**
 * A film in a box the browser will not open, put into one it will -- while it plays.
 *
 * Nothing is downloaded first and nothing is converted in advance. The film is read out of range
 * requests a couple of megabytes at a time, changed a piece at a time, and handed to a MediaSource
 * a piece at a time, so what decides how long the wait is at the start is the size of one piece and
 * not the size of the file. A four-gigabyte film starts in about as long as a four-megabyte one.
 *
 * Which is also why there is no ceiling any more. There used to be one, at half a gigabyte, and it
 * was there because the old way built the whole new file in memory before anything could be shown:
 * past that the honest answer was "not here". Nothing is held now, so there is nothing to be past.
 *
 * The conversion follows the person watching rather than the file. It stops when it is far enough
 * ahead, starts again when they catch up, and when they jump somewhere it has not reached it throws
 * away what it has and starts again from there -- which is a new header and a new muxer, because a
 * muxer that has been jumped backwards drops every packet it is then handed.
 *
 * 一部装在浏览器打不开的盒子里的片子,被放进一个它打得开的盒子 —— 而且是边放边换。
 *
 * 没有任何东西被预先下载,也没有任何东西被预先转换。片子从一个个 Range 请求里一次读几兆字节、
 * 一块一块换掉、一块一块交给 MediaSource,于是决定开头要等多久的,是一块的大小,而不是文件的大小。
 * 一部四吉字节的片子开始播放所花的时间,和一部四兆字节的差不多。
 *
 * 这也正是上限消失的原因。过去是有一个的,在半吉字节那里;它之所以存在,
 * 是因为老办法要在能展示任何东西之前把整个新文件在内存里搭起来 —— 超过那个数,诚实的答复是"这里不行"。
 * 而现在什么都不攥着,也就没有什么可超过的了。
 *
 * 转换跟着看的人走,而不是跟着文件走。跑够远了就停,人追上来了就再开;
 * 而当人跳到一个它还没到的地方,它就把手上的东西扔掉、从那里重新开始 ——
 * 那是一个新的头和一个新的 muxer,因为一个被往回跳过的 muxer,会把此后递给它的每一个包都丢掉。
 */
async function convertAndPlay(n, src) {
  const here = () => (pv && pv.list[pv.idx] === n ? pv.el : null);
  let film = null;
  try {
    const mod = await import('./remux.js?v=' + encodeURIComponent(store.brand?.version || ''));
    // An entry inside an archive has already been extracted and is in hand; everything else is a
    // URL the drive answers in ranges. Both are read the same way from here on.
    // 压缩包里的条目已经解出来、就在手上;其余一切都是网盘会按区间作答的 URL。
    // 从这里往后,两者的读法一模一样。
    const source = /^blob:/.test(src)
      ? await (await fetch(src)).blob()
      : { url: src, size: n.size || 0 };
    film = await mod.stream(source);
    const el = here();
    if (!el) throw new Error('e_drive_remux_failed');
    if (!window.MediaSource || !MediaSource.isTypeSupported(film.mime)) {
      throw new Error('e_drive_video_codec');
    }
    const v = el.querySelector('.drv-view-body video');
    if (!v) throw new Error('e_drive_remux_failed');
    dropPvBlob();
    pvFilm = film;

    const ms = new MediaSource();
    pvBlob = URL.createObjectURL(ms);
    v.src = pvBlob;
    await new Promise((go, no) => {
      ms.addEventListener('sourceopen', go, { once: true });
      ms.addEventListener('error', () => no(new Error('e_drive_remux_failed')), { once: true });
    });
    if (pvFilm !== film) return;
    const sb = ms.addSourceBuffer(film.mime);
    if (film.duration) { try { ms.duration = film.duration; } catch { /* it will grow / 它会自己长 */ } }
    // The film plays; the sound does not exist in a form anything here can read.
    // 片子会放;而那路声音,不存在于这里任何东西读得懂的形式里。
    if (film.silent) toast(t('drv_vid_silent', film.silent.toUpperCase()));

    // A jump is not acted on where it is noticed. It is noted, and the loop below deals with it at
    // a point where it is not in the middle of appending something.
    // 一次跳转不在它被察觉的地方处理。那里只是记下来,由下面那个循环在"手上没在追加东西"的时刻去办。
    let jumped = null;
    v.addEventListener('seeking', () => {
      if (!sbHas(sb, v.currentTime)) jumped = v.currentTime;
    });

    v.play?.().catch(() => { /* autoplay may be refused; the controls are there / 自动播放可能被拒,控件在那儿 */ });
    // The words this film carries, and the ones lying next to it. Not waited for: a film that
    // plays is the thing that was asked for, and the offer of subtitles arrives when it arrives.
    // 这部片子携带的字,以及躺在它旁边的那些。不等它:能播的片子才是被要的东西,
    // 而有字幕可选这件事,什么时候到就什么时候到。
    void offerSubs(n, v, film);

    // Where the next piece belongs. A fragment states its time relative to the stretch it is part
    // of, so every stretch after a jump arrives calling itself zero; without this the film would
    // be laid back over its own beginning, and the player -- asked for minute forty and handed
    // minute nought -- would give up and go to the end.
    // 下一块该坐在哪里。一块分片陈述的时间是相对它所属的那一段说的,
    // 于是每一段跳转之后的片段到来时都管自己叫零;没有这一步,片子会被铺回它自己的开头,
    // 而播放器 —— 要的是第四十分钟、拿到的是第零分钟 —— 会放弃,然后跳到片尾。
    let place = true;

    for (;;) {
      if (pvFilm !== film) return;
      if (jumped !== null) {
        const to = jumped;
        jumped = null;
        // What was half-said is unsaid, and nothing else is touched. The last thing handed over
        // before a jump is very often part of a piece -- a header whose contents have not arrived
        // -- and the reader is still waiting for the rest of it. A new stretch begins with a
        // header of its own, and handing one to a reader that is mid-sentence is not a new
        // sentence: it is a broken one, and the answer is that the film cannot be decoded.
        //
        // Only the parsing is reset. Emptying the buffer as well would leave the player holding
        // nothing at all for as long as the new stretch takes to arrive, and a player holding
        // nothing does not wait politely -- it decides playback is over and jumps to the end.
        // What is no longer wanted is thrown away below, once there is something to replace it.
        //
        // 说了一半的话收回,别的都不动。跳转之前最后交出去的东西,往往是某一块的一部分 ——
        // 一个内容还没到的头 —— 而读的一方仍在等它的下半截。新的一段以它自己的头开场,
        // 而把一个头递给一个话说到一半的读者,并不是一句新话:那是一句破碎的话,
        // 而它的回应是"这部片子解不了"。
        //
        // 被重置的只有解析。连缓冲一起清空,会让播放器在新的一段到来之前完全空着手 ——
        // 而一个空着手的播放器不会客气地等,它会认定播放结束、直接跳到片尾。
        // 不再需要的东西在下面扔掉 —— 等到有东西可以顶替它的时候。
        await sbIdle(sb);
        try { sb.abort(); } catch { /* it was not mid-sentence / 它本来就没有把话说到一半 */ }
        await film.seek(to);
        if (pvFilm !== film) return;
        place = true;
        continue;
      }
      if (sbAhead(sb, v) > AHEAD) { await sbRest(v); continue; }
      const piece = await film.pull();
      if (pvFilm !== film) return;
      if (!piece) {
        // The end of the film, which is not the end of watching it: somebody can still jump back
        // into what has already gone by, and that starts the whole thing up again.
        // 片子的结尾,并不是"看这部片子"的结尾:人还可以跳回已经过去的地方,
        // 而那会把整件事重新开动起来。
        try { if (ms.readyState === 'open') { await sbIdle(sb); ms.endOfStream(); } } catch { /* already ended / 已经结束了 */ }
        while (pvFilm === film && jumped === null) await sbRest(v);
        continue;
      }
      if (place) {
        await sbIdle(sb);
        try { sb.timestampOffset = film.at; } catch { /* it will land where it says / 那就按它自己说的落 */ }
        place = false;
      }
      if (!await sbPut(sb, piece, v)) throw new Error('e_drive_remux_failed');
      // What is far from where somebody is watching goes -- behind them and, after a jump, the
      // stretch they jumped away from. Never what is being watched, and never close to it: the cut
      // is a whole window back, so a small step backwards does not have to be converted twice.
      // 离"人正在看的地方"远的东西丢掉 —— 他身后的,以及一次跳转之后他跳离的那一段。
      // 绝不丢正在看的,也绝不丢挨着它的:切口留在整整一个窗口之前,
      // 于是往回走一小步,不必再转换一遍。
      const at = v.currentTime;
      if (at > BEHIND * 2) await sbDrop(sb, 0, at - BEHIND);
      const far = at + AHEAD * 3;
      if (film.duration && far < film.duration) await sbDrop(sb, far, film.duration + 3600);
    }
  } catch (e) {
    if (film && pvFilm !== film) await film.close().catch(() => {});
    else if (film && pvFilm === film) dropPvBlob();
    const el = here();
    const body = el?.querySelector('.drv-view-body');
    // The conversion is the only thing that failed. What is left to say is the same thing that is
    // said about a format nothing here can open, because from here on that is what it is.
    // 失败的只有转换这一件事。剩下能说的,与"这里打不开的格式"要说的是同一句话 ——
    // 因为从此刻起,它就是那种东西。
    if (body) body.innerHTML = noprevHtml(n, t('drv_vid_no_codec'));
  }
}

// ---------------------------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------------------------

/** The subtitles on offer for the film being watched, and which of them is being shown.
 *
 *  The lines are kept even while nobody is reading them, because a film carrying four languages
 *  hands over all four as it is read, and somebody who switches at minute twelve wants the
 *  eleven minutes that already went past -- not a track that starts where they clicked.
 *
 *  正在看的这部片子有哪些字幕可选,以及正在显示哪一条。
 *
 *  那些字在没人读它们的时候也留着 —— 因为一部带四种语言的片子在被读的过程中会把四种全交出来,
 *  而一个在第十二分钟才切过去的人,要的是已经过去的那十一分钟,
 *  而不是一条从他点下去的地方才开始的轨。 */
let pvSubs = null;

/**
 * Which language this person actually reads, learned rather than asked.
 *
 * Kept as a tally rather than a single last-used value, because somebody who watches Japanese
 * films with Chinese subtitles and English films with none has two habits, not one history; the
 * tally lets the second-favourite win on a film that does not carry the first. Only choices made
 * by hand are counted -- a choice made here on their behalf must not vote for itself.
 *
 * Nothing has been chosen yet on a new browser, and then the question is not what they have
 * picked but what they read, which the browser has been carrying all along.
 *
 * 这个人到底读哪种语言 -- 学出来的,不是问出来的。
 *
 * 存的是一份计数,而不是"上一次用的那个",因为一个"看日本片配中文字幕、看英文片不配"的人
 * 有两种习惯,而不是一段历史;有了计数,在没有第一名的片子上,第二名才赢得下来。
 * 只有亲手做出的选择才计数 -- 一个替他做的选择,不该给自己投票。
 *
 * 换一台浏览器就什么都还没选过,那时该问的就不是"他挑过什么",
 * 而是"他读什么" -- 那件事浏览器一直带在身上。
 */
const SUB_MEM = 'drv.subs.langs';

const subMemory = () => {
  try { return JSON.parse(localStorage.getItem(SUB_MEM) || '{}') || {}; } catch { return {}; }
};

const rememberSub = (code) => {
  if (!code) return;
  const m = subMemory();
  m[code] = (m[code] || 0) + 1;
  try { localStorage.setItem(SUB_MEM, JSON.stringify(m)); } catch { /* no room, no memory / 没地方存就不记 */ }
};

function preferredSub(tracks) {
  const coded = tracks.filter((x) => x.lang);
  if (!coded.length) return null;
  const m = subMemory();
  let best = null;
  let most = 0;
  for (const tr of coded) {
    if ((m[tr.lang] || 0) > most) { most = m[tr.lang]; best = tr; }
  }
  if (best) return best;
  // In the order the browser lists them, because that order is itself the answer.
  // 按浏览器列出来的次序,因为那个次序本身就是答案。
  const wants = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  for (const want of wants) {
    const w = codeOf(want);
    if (!w) continue;
    const hit = coded.find((tr) => tr.lang === w)
      || coded.find((tr) => tr.lang.split('-')[0] === w.split('-')[0]);
    if (hit) return hit;
  }
  return null;
}

function dropSubs() {
  pvSubs = null;
  document.querySelector('.drv-subpic')?.remove();
}

/**
 * Subtitles that are pictures, drawn over the film.
 *
 * These cannot go into a text track: there are no words in them. So a canvas is laid over the
 * video at exactly its size, and the picture for the moment being watched is drawn into it. The
 * canvas is made the size of the frame the subtitles were authored against -- seven hundred and
 * twenty by four hundred and eighty, whatever the film itself is -- so the positions in the file
 * can be used as they are and the browser does the scaling. A DVD's subtitles were placed by
 * somebody, and moving them is worse than stretching them.
 *
 * Only the picture on screen is decoded. There are eight hundred and fifty of them in this film
 * and each is a bitmap the size of the frame; decoding them all at the start would cost a hundred
 * megabytes to show one line of Japanese.
 *
 * 那些本身是图画的字幕,画在片子上面。
 *
 * 它们进不了文字轨:里面没有字。所以在视频上铺一块画布,大小与它分毫不差,
 * 再把"正在看的这一刻"那张图画进去。画布被做成"字幕当年所依据的画幅"的大小 ——
 * 七百二十乘四百八十,不管片子本身是多大 —— 这样文件里的位置就可以照用,
 * 缩放交给浏览器。一张 DVD 的字幕,位置是有人摆过的;挪动它,比拉伸它更糟。
 *
 * 只解码正在屏幕上的那一张。这部片子里有八百五十张,每一张都是一整幅画那么大的位图;
 * 开头就把它们全解出来,是为了显示一行日文而先花掉一百兆字节。
 */
function paintPictures(spec) {
  const v = pvSubs.video;
  const box = v.parentElement;
  const cv = document.createElement('canvas');
  cv.className = 'drv-subpic';
  cv.width = spec.pic.index.size.w;
  cv.height = spec.pic.index.size.h;
  box.appendChild(cv);
  const ctx = cv.getContext('2d');
  const cues = spec.pic.index.streams[spec.pic.stream].cues;
  const seen = new Map();
  let showing = -1;

  const tick = () => {
    if (!pvSubs || pvSubs.shown !== spec.id || !cv.isConnected) { cv.remove(); return; }
    // Over the film, not over the space around it: the video element is exactly as big as the
    // picture it is showing, so its own rectangle is the one to cover.
    // 盖在片子上,而不是盖在它周围的空处:视频元素恰好就是它所显示的画面那么大,
    // 所以要覆盖的就是它自己的那个矩形。
    const r = pictureOf(v);
    const b = box.getBoundingClientRect();
    cv.style.left = `${r.left - b.left}px`;
    cv.style.top = `${r.top - b.top}px`;
    cv.style.width = `${r.width}px`;
    cv.style.height = `${r.height}px`;

    const t = v.currentTime;
    let lo = 0;
    let hi = cues.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].at <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let pic = null;
    if (at >= 0) {
      if (!seen.has(at)) {
        const spu = spuAt(spec.pic.bytes, cues[at].pos);
        seen.set(at, spu ? decodeSpu(spu, spec.pic.index.palette) : null);
        // A few dozen kept, and the oldest let go: enough that stepping back a line costs nothing
        // and small enough that an hour of subtitles is not carried around.
        // 留住几十张,最老的放掉:足够让"往回退一行"不花什么代价,
        // 又小到不至于把一个小时的字幕一直背在身上。
        if (seen.size > 48) seen.delete(seen.keys().next().value);
      }
      const got = seen.get(at);
      if (got && t >= cues[at].at + got.from && t < cues[at].at + got.to) pic = got;
    }
    if (!pic) {
      if (showing !== -1) { ctx.clearRect(0, 0, cv.width, cv.height); showing = -1; }
    } else if (at !== showing) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.putImageData(new ImageData(pic.data, pic.w, pic.h), pic.x, pic.y);
      showing = at;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** What to call a track in the menu. A file that typed its own title has said it better than any
 *  table of language codes could, so that wins; a language tag is the next best; and a track that
 *  says neither is still a track, and gets a number.
 *  一条轨在菜单里叫什么。一个自己打了标题的文件,说得比任何语言代码表都好,所以它优先;
 *  语言标签次之;而一条两样都没说的轨仍然是一条轨,给它一个编号。 */
function subLabel(s, nth) {
  const title = String(s.title || '').trim();
  if (title) return title;
  const lang = labelOf(s.lang, '');
  if (lang) return lang;
  return t('drv_subs_track', nth);
}

/**
 * Everything that could put words on this film, and a way to switch between them.
 *
 * Two places, and neither is inside the picture. The film may carry its own tracks -- a disc rip
 * in Matroska usually carries three or four -- and those arrive as it is read, a little ahead of
 * the frames they belong to. And the folder may hold files named after the film, one per language,
 * which is how everything ripped before the container could hold them was shipped; those are
 * fetched whole the moment somebody asks for one.
 *
 * The button is only put up when there is something behind it. A film with no words anywhere
 * should not grow a control that opens a menu with nothing in it.
 *
 * 一切能给这部片子配上字的东西,以及在它们之间切换的办法。
 *
 * 两个地方,而且都不在画面里面。片子可能自带字幕轨 —— 一个 Matroska 的碟版片源通常带三四条 ——
 * 它们随着片子被读而到达,比它们所属的画面略早。而文件夹里可能放着以片子命名的文件,
 * 一种语言一个 —— 在容器还装不下它们的年代,从碟上抓下来的东西都是这么发行的;
 * 这些是在有人真的要其中一条的那一刻,整个取回来。
 *
 * 只有当按钮后面确实有东西时,它才会被摆出来。一部哪里都没有字的片子,
 * 不该长出一个"点开是一份空菜单"的控件。
 */
async function offerSubs(n, video, film) {
  if (!video || !pv || pv.list[pv.idx] !== n) return;
  const box = video.parentElement;
  if (!box || box.querySelector('[data-subs]')) return;

  // The control first, before anything that can fail.
  //
  // Looking for subtitles means asking the folder what is in it and reading files out of it, and
  // every one of those steps can go wrong. When one did, this function ended before it ever
  // reached the line that puts the button up, and the failure arrived as an absence -- which is
  // the one answer nobody can act on, because it is also what a film with no subtitles looks
  // like, and what a page running yesterday's code looks like. So the button exists from the
  // start and the menu behind it says which of those happened.
  //
  // 先摆控件,再做任何可能失败的事。
  //
  // 找字幕意味着问文件夹里有什么、再把文件读出来,而这里每一步都可能出岔子。
  // 出岔子的那一次,这个函数在够到"摆按钮"那一行之前就结束了,
  // 于是失败以"什么都没有"的样子到达 —— 而那恰恰是没人能据以行动的答案,
  // 因为一部本来就没有字幕的片子是这个样子,一页还跑着昨天的代码也是这个样子。
  // 所以按钮从一开始就在,由它背后的菜单去说,发生的是哪一种。
  pvSubs = { node: n, video, film, tracks: [], lines: new Map(), shown: null, made: new Map(),
    reading: true, trouble: null };
  const mine = pvSubs;
  // Where a subtitles control is looked for: on the player, at the end of the row of controls,
  // not up in the header among the things that are done to the file. Somebody who wants
  // subtitles is watching the film, and their eyes are on the film.
  // 一个字幕控件会被到哪里去找:在播放器上,在那一排控件的末端 ——
  // 而不是在顶栏里、混在"对这个文件做的事"当中。想要字幕的人正在看片子,而他的眼睛在片子上。
  const btn = document.createElement('button');
  btn.className = 'drv-pl-b';
  btn.setAttribute('data-subs', '');
  btn.setAttribute('aria-label', t('drv_subs'));
  btn.title = t('drv_subs');
  btn.innerHTML = icon('subtitles', 20);
  (pvPlayer?.slot || box).appendChild(btn);
  btn.addEventListener('click', (e) => {
    // A button that opens a menu closes it again. Everything else here is dismissed by clicking
    // away, but the click that lands on the button never reaches the document -- it has to be
    // stopped, or it would close the menu it is about to open -- so the second press has to be
    // recognised right here.
    // 一个打开菜单的按钮,再按一次就把它关上。这里其余的东西都靠"点别处"来消掉,
    // 但落在按钮上的那一下永远到不了 document —— 它必须被拦住,
    // 否则它会把自己正要打开的菜单关掉 —— 所以第二次按下只能在这里认出来。
    e.stopPropagation();
    if (menuEl?.dataset.subs) { closeMenu(); return; }
    closeMenu();
    pvPlayer?.closeVolume?.();
    const r = btn.getBoundingClientRect();
    openMenu(r.right + 12, r.top - 10, null, subsMenu(), true);
    if (menuEl) menuEl.dataset.subs = '1';
  });

  // Wired before the reading starts, because the film is already being read and its lines are
  // already arriving. 在开始找之前就接上,因为片子已经在被读了,它的字也已经在到达了。
  if (film) {
    film.onSub = (c) => {
      if (!pvSubs || pvSubs.film !== film) return;
      const key = 'in:' + c.index;
      const kept = pvSubs.lines.get(key) || [];
      // The same line arrives twice when somebody jumps back over ground already read. Matched on
      // when it starts, because that is what a player would show twice.
      // 有人跳回已经读过的地方时,同一行会到达两次。按"它从什么时候开始"来认 ——
      // 因为那正是播放器会显示两次的东西。
      if (kept.some((x) => Math.abs(x.from - c.from) < 0.01 && x.text === c.text)) return;
      kept.push(c);
      pvSubs.lines.set(key, kept);
      if (pvSubs.shown === key) addCue(pvSubs.made.get(key), c);
    };
  }

  const tracks = [];
  try {
    if (film) {
      film.subs.forEach((s, i) => tracks.push({
        id: 'in:' + s.index, label: subLabel(s, i + 1), lang: codeOf(s.lang), inside: s,
      }));
    }
    // The folder, asked for once. What is next to a film is not something the film knows.
    // 那个文件夹,只问一次。一部片子旁边有什么,不是这部片子知道的事。
    let beside = [];
    try {
      const data = await api('GET', `/api/drive/list?parent=${encodeURIComponent(n.parent_id || 'root')}`);
      beside = sidecarsFor(n.name, data.nodes || []);
    } catch (e) {
      // A folder that will not answer is not the same as a folder with nothing in it, and the
      // difference is worth a line in the menu.
      // 一个不肯作答的文件夹,不等于一个里面什么都没有的文件夹,这个区别值得在菜单里占一行。
      mine.trouble = tErr(e);
    }
    for (const f of beside) {
      if (!f.pictures) {
        tracks.push({ id: 'file:' + f.node.id, label: f.label, lang: codeOf(f.tag), file: f });
        continue;
      }
      // A DVD's subtitles say inside themselves which languages they hold, and the half that says
      // so is forty kilobytes. Read now, so the menu can offer 日本語 rather than IDX; the pictures
      // themselves are three megabytes and are left where they are until somebody asks.
      // 一张 DVD 的字幕,在自己内部说明它装着哪些语言,而"说这件事的那一半"是四十千字节。
      // 现在就读,好让菜单能给出"日本語"而不是"IDX";图画本身有三兆字节,
      // 在有人开口要之前,就让它待在原处。
      try {
        const res = await fetch(dlUrl(f.node.id, false, verTag(f.node)));
        if (!res.ok) throw new Error('e_drive_subs_empty');
        const index = readIndex(readText(new Uint8Array(await res.arrayBuffer()), f.node.name));
        index.streams.forEach((st, i) => {
          if (!st.cues.length) return;
          tracks.push({
            id: `pic:${f.node.id}:${i}`,
            label: labelOf(st.lang, f.label),
            lang: codeOf(st.lang),
            pic: { index, stream: i, mate: f.mate, bytes: null },
          });
        });
      } catch (e) { mine.trouble = `${f.node.name}: ${tErr(e)}`; }
    }
  } catch (e) { mine.trouble = tErr(e); }
  if (pvSubs !== mine) return;
  mine.tracks = tracks;
  mine.reading = false;
  // Nothing has been asked for, so ask on this person's behalf.
  // 还没有人开口要,那就替他开这个口。
  if (!mine.shown) {
    const pick = preferredSub(tracks);
    if (pick) void showSub(pick.id);
  }
}

/** The menu behind the button: off, then one entry per track, with the one being shown marked.
 *  按钮后面的那份菜单:先是关闭,然后每条轨一项,正在显示的那一条打上记号。 */
function subsMenu() {
  if (!pvSubs) return [];
  const out = [];
  if (pvSubs.tracks.length) {
    out.push({ ic: pvSubs.shown ? 'blank' : 'check', label: t('drv_subs_off'), fn: () => showSub(null) });
    for (const tr of pvSubs.tracks) {
      out.push({
        ic: pvSubs.shown === tr.id ? 'check' : 'blank',
        label: tr.label,
        fn: () => { rememberSub(tr.lang); showSub(tr.id); },
      });
    }
  }
  // Still looking, nothing found, or something went wrong -- three different things, and an empty
  // menu said all three at once.
  // 还在找、什么都没找到、出了错 —— 三件不同的事,而一份空菜单把它们说成了同一件。
  if (pvSubs.reading) out.push({ ic: 'subtitles', label: t('drv_subs_reading'), hint: true });
  else if (pvSubs.trouble) out.push({ ic: 'subtitles', label: pvSubs.trouble, hint: true });
  else if (!out.length) out.push({ ic: 'subtitles', label: t('drv_subs_none'), hint: true });
  return out;
}

const addCue = (track, c) => {
  if (!track) return;
  try { track.addCue(new VTTCue(c.from, Math.max(c.to, c.from + 0.2), c.text)); } catch { /* a line the browser would not take / 一行浏览器不肯收的字 */ }
};

/**
 * Show one track, or none.
 *
 * A track the browser has been given cannot be taken back, so each one is made once and then
 * turned on and off. Which is also why the lines are kept here rather than only in the track:
 * everything read so far goes in the moment a track is asked for, and everything read afterwards
 * goes in as it arrives.
 *
 * 显示一条轨,或者一条都不显示。
 *
 * 一条已经交给浏览器的轨收不回来,所以每一条只造一次,此后只是被打开和关上。
 * 这也正是那些字要留在这里、而不是只留在轨里的原因:
 * 一条轨被要到的那一刻,至今读到的一切都进去;此后读到的,到一条进一条。
 */
async function showSub(id) {
  if (!pvSubs) return;
  const v = pvSubs.video;
  for (const tr of v.textTracks) tr.mode = 'disabled';
  document.querySelector('.drv-subpic')?.remove();
  pvSubs.shown = id;
  if (!id) return;
  const spec = pvSubs.tracks.find((x) => x.id === id);
  // Pictures do not go into a text track, because there are no words in them to put there.
  // 图画进不了文字轨,因为里面没有字可以放进去。
  if (spec?.pic) {
    if (!spec.pic.bytes) {
      try {
        const res = await fetch(dlUrl(spec.pic.mate.id, false, verTag(spec.pic.mate)));
        if (!res.ok) throw new Error('e_drive_not_found');
        spec.pic.bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        toast(tErr(e), true);
        pvSubs.shown = null;
        return;
      }
    }
    if (pvSubs.shown === id) paintPictures(spec);
    return;
  }
  let track = pvSubs.made.get(id);
  if (!track) {
    track = v.addTextTrack('subtitles', spec.label, spec.inside?.lang || spec.file?.tag || '');
    pvSubs.made.set(id, track);
    // A file beside the film is fetched whole, now. It is tens of kilobytes and it is the whole
    // film's worth, so there is nothing to stream and nothing to wait for twice.
    // 片子旁边的那个文件,现在整个取回来。它是几十千字节,而且是整部片子的量 ——
    // 没有什么可流的,也没有什么值得等第二次。
    if (spec.file) {
      try {
        const res = await fetch(dlUrl(spec.file.node.id, false, verTag(spec.file.node)));
        if (!res.ok) throw new Error('e_drive_not_found');
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (looksBinary(bytes)) throw new Error('e_drive_subs_bitmap');
        const cues = cuesOf(readText(bytes, spec.file.node.name), spec.file.ext);
        if (!cues.length) throw new Error('e_drive_subs_empty');
        pvSubs.lines.set(id, cues);
      } catch (e) {
        toast(tErr(e), true);
        pvSubs.shown = null;
        return;
      }
    }
    for (const c of pvSubs.lines.get(id) || []) addCue(track, c);
  }
  if (pvSubs.shown === id) track.mode = 'showing';
}

async function paintPreview() {
  const n = pv.list[pv.idx];
  destroyPdfPreview();
  pvRich?.destroy?.();
  pvRich = null;
  killMedia(pv.el); // the outgoing preview's stream dies here / 旧预览的流在此断开
  // Archive entries extract client-side on first view: spinner shell first, then the real
  // preview off a blob URL. The archive readers fetch only this entry's byte range.
  // 压缩包条目首次预览时在客户端解出:先上加载壳,再用 blob URL 走正常预览。
  // 读取器只拉这个条目的字节区间。
  if (n.arc && n.arcGet && !n.arcUrl) {
    paintPvShell(n, `<div class="drv-doc"><div class="drv-docc">${spinnerHtml()}<div class="drv-arcbuf" style="position:static;margin:12px auto 0"></div></div></div>`);
    // Without the streaming worker this extracts the whole entry before anything renders, which
    // on a big solid block is a long silent wait. Report what is coming down while it runs.
    // 没有流式 worker 时,这里会先整体解出条目才渲染,大固实块上就是一段漫长的静默等待。
    // 进行期间把下行情况报出来。
    const tick = setInterval(() => {
      const el = pv?.el?.querySelector('.drv-arcbuf');
      const inf = n.arcMeter?.();
      if (!el || !inf) return;
      el.textContent = `${t('drv_arc_buffering')} ${inf.pct.toFixed(0)}%${inf.bps ? ` · ${fmtSize(inf.bps)}/s` : ''}`;
    }, 400);
    try {
      const u = await n.arcGet();
      if (!pv || pv.list[pv.idx] !== n) return;
      n.arcUrl = u;
    } catch (e) {
      const box = pv?.el?.querySelector('.drv-docc') || pv?.el?.querySelector('.drv-view-body');
      if (box && pv.list[pv.idx] === n) box.innerHTML = `<div class="noprev" style="margin:auto">${fileIcon(n.name, 72)}<div>${esc(tErr(e))}</div></div>`;
      return;
    } finally {
      clearInterval(tick);
    }
  }
  const mime = (verView(n).mime || '').toLowerCase();
  const src = n.arcUrl || pvSrc(n, true);
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(n.name);
  const isAudio = AUD_RE.test(mime) || AUD_EXTS.has(extOf(n.name));
  let body;
  // Keep a loading veil over the image until the bitmap actually decodes. The src is handed
  // over long before the bytes exist -- the worker may still be decompressing a whole solid
  // block -- so swapping the spinner straight out for the <img> leaves an unexplained blank
  // frame, which reads as "it failed" rather than "it is still coming".
  // 图片解出来之前一直盖着加载遮罩。src 交出去时字节往往还不存在 —— worker 可能正在解一整个
  // 固实块 —— 直接把加载图换成 <img> 会留下无从解释的空白,看起来像"失败了"而不是"还在来"。
  // The previous film goes before the next one arrives, or two of them are held at once.
  // 上一部片子在下一部到来之前先放掉,否则会同时攥着两部。
  dropPvBlob();
  const film = verdict(n.name, mime);
  if (IMG_RE.test(mime)) body = `<img src="${esc(src)}" alt=""><div class="drv-pvwait">${spinnerHtml()}</div>`;
  else if (film === 'native' || VID_RE.test(mime)) body = `<video autoplay playsinline src="${esc(src)}"></video><div class="drv-pvwait">${spinnerHtml()}</div>`;
  // A box that can be changed. How big it is does not come into it any more: the film is changed
  // a piece at a time while it plays, so a four-gigabyte one is the same wait as a small one.
  // 一个可以换掉的盒子。它有多大已经不在考虑之列了:片子是边放边一块一块换的,
  // 于是一部四吉字节的与一部小的,等的是同样久。
  else if (film === 'remux') {
    body = `<video playsinline></video><div class="drv-pvwait">${spinnerHtml()}<div class="drv-conv">${esc(t('drv_vid_converting'))}</div></div>`;
  }
  // Nothing here will open it, and saying so is the whole improvement: a file icon and silence
  // reads as "this application is broken" rather than "this format needs another program".
  // 这里没有东西打得开它,而把这句话说出来就是全部的改进:
  // 一个文件图标加沉默,读起来是"这个应用坏了",而不是"这个格式需要另一个程序"。
  else if (film === 'no') {
    body = noprevHtml(n, t('drv_vid_no_codec'));
  }
  else if (isAudio) {
    // Cover-art card: the stored thumbnail doubles as the artwork
    // 封面卡片。存好的缩略图直接当专辑封面用
    body = `
    <div class="drv-audio">
      ${n.thumb
        ? `<img class="art" src="${esc(thumbUrl(n.id, verTag(n)))}" alt="">`
        : `<div class="art fallback">${icon('fileAudio', 72)}</div>`}
      <div class="anm">${esc(n.name)}</div>
      <audio controls autoplay src="${esc(src)}"></audio>
    </div>
    <div class="drv-pvwait">${spinnerHtml()}</div>`;
  } else if (isPdf) body = `<div class="drv-doc"><div class="drv-docc"><div class="drv-pdf drv-docwin">${spinnerHtml()}</div></div></div>`;
  else body = `<div class="drv-doc"><div class="drv-docc"><div class="drv-docwin">${spinnerHtml()}</div></div></div>`;
  paintPvShell(n, body);
  loadVersions(n);
  // The controls belong to the film from the moment there is a film element, not from the moment
  // it has something to play: a conversion takes a while to start, and a player with nothing in
  // it yet is still the thing that will be reached for.
  // 控件从"有这个视频元素"的那一刻起就属于这部片子,而不是从"它有东西可放"的那一刻起:
  // 转换要过一会儿才开得起来,而一个还空着的播放器,仍然是人会伸手去够的那个东西。
  if (film === 'remux' || film === 'native') {
    const v = pv.el?.querySelector('.drv-view-body video');
    if (v) {
      pvPlayer = mountPlayer(v, v.parentElement, {
        bytes: () => pvFilm?.fetched,
        onOpen: () => closeMenu(),
      });
    }
  }
  if (film === 'remux') void convertAndPlay(n, src);
  // A film the browser opens by itself still has a folder around it, and the folder may hold the
  // words. Nothing here had to be converted for that to be true.
  // 一部浏览器自己就打得开的片子,周围一样有一个文件夹,而那个文件夹里可能放着那些字。
  // 这件事成立,不需要这里转换过任何东西。
  else if (film === 'native' && !n.arc) {
    void offerSubs(n, pv.el.querySelector('.drv-view-body video'), null);
  }
  // Media inside archives: sequential playback only, no seeking (compressed entries would
  // have to re-decode from the start on every jump).
  // 压缩包内媒体只允许顺序播放,禁止 seek(压缩条目每跳一次都得从头重解)。
  // In-archive media plays off the worker's single-flight disk cache, so seeking is free:
  // cached regions answer instantly, uncached ones just buffer -- no repeated decodes.
  // 压缩包内媒体经 worker 的单飞磁盘缓存播放,seek 零成本:已缓存区域即时响应,
  // 未缓存区域只是缓冲等待,不存在重复解码。
  // While the worker decodes (a whole solid 7z block, or a compressed/encrypted entry) the
  // preview shows a "decompressing X% · Y MB/s" pill driven by the worker's fill counters --
  // for images and other file kinds too, not only for media. Streamed previews only (a blob
  // URL means it is already fully extracted, nothing to report).
  // worker 解码期间(一整个固实 7z 块,或压缩/加密条目),预览显示"解压缓冲中 X% · Y MB/s"
  // 提示,数据来自 worker 的填充计数 —— 图片和其它类型也一样,不止媒体。仅对流式预览
  // (blob URL 表示已整体解出,无进度可报)。
  if (n.arc && n.arcUrl && !n.arcUrl.startsWith('blob:')) {
    attachArcProgress(n, pv.el.querySelector('video, audio') || pv.el.querySelector('img'));
  }
  // An <img> the browser cannot decode renders as NOTHING -- no broken-image box, no message,
  // just an empty frame that is indistinguishable from "still loading". Settle every image
  // preview explicitly: lift the veil on success, say "cannot preview" on failure. This has to
  // live here rather than in attachArcProgress, which only runs for streamed previews and so
  // left the blob fallback with no failure path at all.
  // 浏览器解不出来的 <img> 渲染结果是「什么都没有」—— 没有裂图框,没有提示,只有一片和
  // 「还在加载」无从区分的空白。所以每个图片预览都要明确收尾:成功就撤遮罩,失败就说无法预览。
  // 这段必须放在这里而不是 attachArcProgress —— 那个只对流式预览生效,blob 回退路径因此
  // 完全没有失败出口。
  // Media starts hidden behind the spinner and only appears once it can actually play. This
  // runs for every path, including the no-worker blob fallback where attachArcProgress -- which
  // owns the same handover during streaming -- is never wired up at all.
  // 媒体一开始藏在加载动画之后,真的能播了才出现。所有路径都要走这一步,包括没有 worker 的
  // blob 回退 —— 那条路上负责同一次交接的 attachArcProgress 根本不会接线。
  const med = pv.el.querySelector('.drv-view-body video, .drv-view-body audio');
  const medVeil = med ? pv.el.querySelector('.drv-pvwait') : null;
  if (med && medVeil) {
    med.classList.add('drv-wait');
    const ready = () => {
      medVeil.style.display = 'none';
      med.classList.remove('drv-wait');
    };
    if (med.readyState >= 3) ready();
    else med.addEventListener('canplay', ready, { once: true });
  }
  const im = IMG_RE.test(mime) ? pv.el.querySelector('.drv-view-body > img') : null;
  if (im) {
    const settle = async (ok) => {
      pv?.el?.querySelector('.drv-pvwait')?.remove();
      if (ok || !pv || pv.list[pv.idx] !== n) return;
      // A streamed URL that will not load means the service worker is not controlling the page
      // (installing, updating, unsupported), so the request went to the network, which cannot
      // serve it. Extract in the page instead -- slower, but the image still appears.
      // 流式 URL 加载不出来,说明 service worker 没在控制页面(安装中、更新中、或不受支持),
      // 请求落到了网络,而网络供不了。改成在页面内解出 —— 慢一些,但图还是能出来。
      if (n.arcBlob && !String(n.arcUrl || '').startsWith('blob:')) {
        try {
          const u = await n.arcBlob();
          if (!pv || pv.list[pv.idx] !== n) return;
          n.arcUrl = u;
          paintPreview();
          return;
        } catch { /* fall through to the message / 落到下面的提示 */ }
      }
      const b = pv?.el?.querySelector('.drv-view-body');
      if (b && pv.list[pv.idx] === n) b.innerHTML = noprevHtml(n);
    };
    if (im.complete) settle(im.naturalWidth > 0);
    else {
      im.addEventListener('load', () => settle(true), { once: true });
      im.addEventListener('error', () => settle(false), { once: true });
    }
  }
  const docBox = pv.el.querySelector('.drv-doc');
  if (docBox) {
    applyPreviewWidth(docBox);
    bindPreviewResize(docBox);
  }
  if (isPdf) {
    renderPdfPreview(n, pv.el.querySelector('.drv-pdf'));
  } else if (!IMG_RE.test(mime) && !VID_RE.test(mime) && !isAudio) {
    richPreview(n);
  }
}

// ---------- Upload manager ----------
// ---------- 上传管理 ----------

const up = { tasks: [], active: 0, panel: null, min: false, seq: 0 };

// Leaving the page kills every in-flight upload -- warn first. The browser shows its own
// generic dialog; the handler only has to flag the situation.
// 离开页面会杀掉所有进行中的上传,先警告。浏览器弹它自己的通用确认框,这里只负责标记。
window.addEventListener('beforeunload', (e) => {
  if (up.tasks.some((x) => x.status === 'up' || x.status === 'wait' || x.status === 'prep')) {
    e.preventDefault();
    e.returnValue = '';
  }
});
// A file is digested by reading it whole, so the ceiling here is memory, not patience. Above it
// an upload carries no digest: it cannot be skipped today and cannot be compared against tomorrow,
// which is the honest cost of not holding ninety megabytes in a tab to save a round trip.
// 算摘要要把文件整个读进来,所以这里的上限管的是内存,不是耐心。
// 超过它的上传不带摘要:今天省不掉,明天也无从比对 ——
// 这是"不为省一趟往返而在标签页里攥着九十兆"所要付的、诚实的代价。
const HASH_MAX = 64 * 1024 * 1024;

// Circumference of the r=8 progress ring in the upload panel
// 上传面板进度圆环的周长。半径 8
const RING_CIRC = 2 * Math.PI * 8;

// ---------- Upload throughput readout ----------
// After a batch has been running for 5 seconds, the panel caption gains recent bandwidth and an
// ETA -- computed from a sliding window of once-a-second samples of total bytes on the wire.
// ---------- 上传速率显示 ----------
// 批次跑满 5 秒后,面板标题追加近期带宽与预计剩余时间 —— 由每秒一次的总传输字节采样
// 滑动窗口计算得出。
const upStats = { timer: null, samples: [], startedAt: 0, text: '' };

function fmtEta(secIn) {
  const sec = Math.max(1, Math.round(secIn));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + 'm' + (s ? String(s).padStart(2, '0') + 's' : '');
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

function startUpStats() {
  if (upStats.timer) return;
  upStats.startedAt = performance.now();
  upStats.samples = [];
  upStats.text = '';
  upStats.timer = setInterval(upTick, 1000);
}

function stopUpStats() {
  clearInterval(upStats.timer);
  upStats.timer = null;
  upStats.text = '';
  const el = up.panel?.querySelector('.drv-up-stats');
  if (el) el.textContent = '';
}

function upTick() {
  const live = up.tasks.filter((x) => x.status === 'up' || x.status === 'wait');
  if (!live.length) {
    stopUpStats();
    return;
  }
  const now = performance.now();
  const onWire = up.tasks.reduce((s, x) => s + (x.status === 'ok' ? x.size : x.sent || 0), 0);
  upStats.samples.push({ t: now, b: onWire });
  while (upStats.samples.length > 8) upStats.samples.shift();
  if (now - upStats.startedAt < 5000 || upStats.samples.length < 2) return;
  const a = upStats.samples[0];
  const b = upStats.samples[upStats.samples.length - 1];
  const dt = (b.t - a.t) / 1000;
  const bps = dt > 0 ? (b.b - a.b) / dt : 0;
  if (bps <= 1) return;
  const remain = live.reduce((s, x) => s + Math.max(0, (x.size || 0) - (x.sent || 0)), 0);
  upStats.text = ` · ${fmtSize(bps)}/s · ~${fmtEta(remain / bps)}`;
  const el = up.panel?.querySelector('.drv-up-stats');
  if (el) el.textContent = upStats.text;
}

/** A dropped folder has to be walked before anything about it is known -- how many files, how
 *  deep, how large -- and the browser hands it over one batch at a time. That walk used to
 *  happen before the panel existed, so dropping ten thousand files looked exactly like dropping
 *  nothing: several seconds of a page that had not reacted. It is the same wait either way; the
 *  difference is whether it is visible. So the panel opens first, with a row that spins.
 *  一个拖进来的目录必须先走一遍才知道它是什么 —— 多少个文件、多深、多大 ——
 *  而浏览器是一批一批交出来的。这次遍历过去发生在面板存在之前,于是拖进一万个文件,
 *  看起来与什么都没拖完全一样:好几秒钟,页面毫无反应。等待时间两种做法一样长,
 *  区别只在于它是否被看见。所以先把面板打开,里面放一行转着圈的东西。 */
async function dropUpload(dt) {
  const prep = beginPrep();
  try {
    const items = await filesFromDataTransfer(dt, (n) => {
      prep.found = n;
      // Every twenty-fifth file, not every file: a big drop would otherwise spend more time
      // painting the count than reading the directory.
      // 每二十五个文件才画一次,而不是每个都画:否则一次大拖放花在画数字上的时间会超过读目录。
      if (n === 1 || n % 25 === 0) paintPrep(prep);
    });
    await enqueueFiles(items, prep);
  } finally {
    endPrep(prep);
  }
}

async function filesFromDataTransfer(dt, onFound) {
  const out = [];
  const entries = [...(dt.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map((f) => ({ file: f, rel: f.webkitRelativePath || '' }));
  for (const e of entries) await walkEntry(e, '', out, onFound);
  return out;
}

function walkEntry(entry, prefix, out, onFound) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => {
        out.push({ file: f, rel: prefix ? `${prefix}/${f.name}` : '' });
        onFound?.(out.length);
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const sub = prefix ? `${prefix}/${entry.name}` : entry.name;
      let first = true;
      // readEntries returns results in batches and must be called until it comes back empty
      // readEntries 按批返回。必须循环调用直到返回空批
      (function loop() {
        reader.readEntries(async (batch) => {
          if (!batch.length) {
            // An empty folder still gets created / 空文件夹也要建出来
            if (first) out.push({ dir: sub });
            resolve();
            return;
          }
          first = false;
          for (const e of batch) await walkEntry(e, sub, out, onFound);
          loop();
        }, () => resolve());
      })();
    } else resolve();
  });
}

/** `prep` is the spinning row the caller already put on screen. A drop passes its own so the
 *  walk and the folder building read as one phase; a file picker has nothing to pass and gets
 *  one made here -- building the skeleton is its own wait, one API call per new directory.
 *  `prep` 是调用方已经摆上屏幕的那一行转圈。拖放会把自己那一行传进来,
 *  好让"遍历"与"建目录"读作同一个阶段;文件选择器没有可传的,就在这里造一个 ——
 *  建骨架本身也是一段等待,每个新目录一次 API 调用。 */
async function enqueueFiles(items, prep) {
  if (dst.view === 'arc') return; // archives are read-only / 压缩包内只读
  if (!items.length) return;
  if (!canWriteHere()) {
    toast(tErr('e_drive_forbidden'), true);
    return;
  }
  const mine = prep || beginPrep();
  try {
    await buildUploads(items);
  } finally {
    if (!prep) endPrep(mine);
  }
}

async function buildUploads(items) {
  const base = currentParent();
  // Create the folder skeleton first, sequentially and cached per path
  // 先按路径把文件夹骨架建好。逐级建、同路径缓存
  const dirCache = new Map(); // path -> folder id
  const ensureDir = async (relDir) => {
    if (!relDir) return base;
    if (dirCache.has(relDir)) return dirCache.get(relDir);
    const idx = relDir.lastIndexOf('/');
    const parent = await ensureDir(idx >= 0 ? relDir.slice(0, idx) : '');
    const name = idx >= 0 ? relDir.slice(idx + 1) : relDir;
    const node = await api('POST', '/api/drive/folders', { parent, name });
    dirCache.set(relDir, node.id);
    return node.id;
  };
  try {
    // A dropped directory becomes ONE panel item: aggregate ring plus an x/n counter,
    // instead of flooding the list with every file inside.
    // 拖进来的目录在面板里只占一条:聚合进度环加 x/n 计数,不再把里面每个文件都摊开。
    const groups = new Map(); // top-level dir name -> group task / 顶层目录名 → 组任务
    const groupOf = (top) => {
      if (!groups.has(top)) {
        const g = {
          id: ++up.seq, group: true, name: top, files: [], size: 0, sent: 0,
          done: 0, total: 0, failed: 0, parent: base,
          status: 'wait', xhr: null, srvId: null, cancelled: false,
        };
        groups.set(top, g);
        up.tasks.push(g);
      }
      return groups.get(top);
    };
    for (const it of items) {
      if (it.dir !== undefined) {
        await ensureDir(it.dir);
        groupOf(it.dir.split('/')[0]);
        continue;
      }
      const rel = it.rel || '';
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const parent = await ensureDir(dir);
      if (dir) {
        const g = groupOf(dir.split('/')[0]);
        g.files.push({ file: it.file, parent });
        g.size += it.file.size;
        g.total++;
      } else {
        up.tasks.push({
          id: ++up.seq, file: it.file, name: it.file.name, size: it.file.size,
          parent, sent: 0, status: 'wait', xhr: null, srvId: null, cancelled: false,
        });
      }
    }
    // Each group's top-level folder id, for click-to-locate (its containing folder is g.parent)
    // 每个组的顶层文件夹 id,供点击定位(其所在文件夹是 g.parent)
    for (const g of groups.values()) g.topId = dirCache.get(g.name) || null;
  } catch (e) {
    toast(e.message, true);
  }
  renderUpPanel();
  pump();
  if (items.some((it) => it.dir !== undefined || (it.rel || '').includes('/'))) reloadSoon();
}

// ---------- The preparing row ----------
// ---------- 那一行"正在准备" ----------

/** Nothing here can be measured: the file system says what it found, never how much is left, so
 *  this spins rather than fills. The running count is not progress -- it has no denominator --
 *  it is only the difference between "working" and "hung", which for a folder that takes ten
 *  seconds to read is the whole question.
 *  这里没有任何东西可以度量:文件系统告诉你它找到了什么,从不告诉你还剩多少,
 *  所以这一行是转圈而不是填充。那个不断上涨的数字不是进度 —— 它没有分母 ——
 *  它只是"在动"与"卡死"之间的差别,而对一个要读十秒的目录来说,那就是全部的问题。 */
function beginPrep(down) {
  const task = {
    id: ++up.seq,
    prep: true,
    down: !!down,
    name: t(down ? 'drv_dl_preparing' : 'drv_up_preparing'),
    found: 0,
    status: 'prep',
  };
  up.tasks.unshift(task);
  renderUpPanel();
  return task;
}

function endPrep(task) {
  const i = up.tasks.indexOf(task);
  if (i >= 0) up.tasks.splice(i, 1);
  renderUpPanel();
}

function paintPrep(task) {
  const el = up.panel?.querySelector(`[data-tid="${task.id}"] .gcnt`);
  if (el) el.textContent = task.found || '';
}

function pump() {
  while (up.active < 3) {
    const task = up.tasks.find((x) => x.status === 'wait');
    if (!task) break;
    up.active++;
    task.status = 'up';
    startUpStats();
    runTask(task)
      .then((node) => {
        task.status = 'ok';
        task.sent = task.size;
        // A download landed on the machine, where this application cannot point at it and has
        // nothing to make a thumbnail of.
        // 一次下载落在了本机上 —— 这个应用没法指着那儿说"在这里",也没有什么可以拿来做缩略图。
        if (task.down) return;
        task.node = node; // where it landed: id + parent_id, for click-to-locate / 落点,供点击定位
        // Nothing was written, so nothing about the file went stale -- including its thumbnail.
        // 什么都没写,于是这个文件没有任何东西过期 —— 包括它的缩略图。
        if (!task.same) queueThumb(task.file, node);
      })
      .catch((e) => {
        if (task.status !== 'cancel') {
          task.status = 'err';
          task.err = e?.message || String(e);
        }
      })
      .finally(() => {
        up.active--;
        renderUpPanel();
        // Nothing here changed because something was read, so there is nothing to go and ask about.
        // 这里没有任何东西因为"有人读了它"而改变,所以没有什么可去打听的。
        if (!task.down) refreshState();
        if (task.status === 'ok' && task.parent === (dst.view === 'folder' ? dst.folderId : 'root')
          && (dst.view === 'my' || dst.view === 'folder')) reloadSoon();
        pump();
      });
    renderUpPanel();
  }
}

function xhrSend(method, url, blob, onProgress, task) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    if (task) task.xhr = x;
    x.open(method, url);
    x.responseType = 'json';
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded);
    };
    x.onload = () => {
      if (task) task.xhr = null;
      if (x.status >= 200 && x.status < 300) resolve(x.response || {});
      else reject(new Error(tErr(x.response?.error, x.response?.args || [])));
    };
    x.onerror = () => {
      if (task) task.xhr = null;
      reject(new Error(tErr('e_request_failed', [x.status || 0])));
    };
    x.onabort = () => {
      if (task) task.xhr = null;
      reject(new Error('cancelled'));
    };
    x.send(blob);
  });
}

async function runTask(task) {
  if (task.down) return runDownload(task);
  if (!task.group) return uploadOne(task.file, task.parent, task, 0);
  // Group: members go up sequentially; sent aggregates across them, done feeds the x/n badge.
  // Thumbnails queue per member here (pump only handles the single-file case).
  // 组任务:成员顺序上传。sent 跨成员累计,done 驱动 x/n 角标。
  // 缩略图在这里逐成员入队(pump 只处理单文件的情况)。
  let base = 0;
  for (const m of task.files) {
    if (task.cancelled) throw new Error('cancelled');
    try {
      const node = await uploadOne(m.file, m.parent, task, base);
      if (!task.same) queueThumb(m.file, node);
      task.same = false;
    } catch (e) {
      if (task.cancelled) throw e;
      task.failed++;
      task.err = e?.message || String(e);
    }
    base += m.file.size;
    task.sent = base;
    task.done++;
    paintTask(task);
  }
  if (task.failed) throw new Error(task.err || 'failed');
  return null;
}

/** The file's content digest, in the form the server and R2 both speak.
 *  文件内容的摘要,用服务端与 R2 都讲的那种写法。 */
async function sha256Hex(file) {
  if (file.size > HASH_MAX) return '';
  try {
    const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // No subtle crypto (an insecure origin), or the read failed. Either way the upload goes ahead
    // without a digest: an upload that happens is never the wrong answer here.
    // 没有 subtle crypto(非安全上下文),或者读取失败。两种情况都照常上传、不带摘要 ——
    // 在这里,"照样传了"永远不会是错的那个答案。
    return '';
  }
}

/** The file already sitting under this name, if this view is holding that folder's listing. The
 *  comparison is only ever made against a listing already in hand: fetching one to find out
 *  whether an upload can be skipped would spend the very round trip it is trying to save.
 *  已经占着这个名字的那个文件 —— 前提是当前视图正握着那个目录的列表。
 *  比对只对着手头已有的列表做:为了弄清一次上传能否省掉而去拉一次列表,
 *  花掉的正是它想省下的那趟往返。 */
function standingFile(f, parent) {
  // Only where the listing IS a folder. Search, recent and starred all report 'root' as the place
  // an upload lands, while what they are showing came from all over the drive -- so a name matched
  // there could belong to a file in another folder entirely, and skipping the upload on its
  // account would drop a save.
  // 只在"列表本身就是一个目录"时才作数。搜索、最近、星标都把上传落点报作 root,
  // 而它们展示的内容来自网盘各处 —— 在那里对上的名字很可能属于另一个目录里的文件,
  // 凭它跳过上传,丢掉的是一次保存。
  if (dst.view !== 'my' && dst.view !== 'folder') return null;
  if (parent !== currentParent()) return null;
  return dst.shown.find((x) => x.kind === 'file' && x.name === f.name) || null;
}

/** How many goes one part gets before it takes the whole file down with it.
 *  一片在把整个文件一起拖垮之前,有几次机会。 */
const PART_TRIES = 3;

const naptime = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One part of a multipart upload, with another go or two if the wire drops it.
 *
 * Retrying is worth more here than anywhere else in this file, because of what it costs not to. A
 * file only goes out in parts when it is too big to go in one, and without a retry a single
 * dropped connection anywhere in it throws away every part that already landed. The parts are
 * independent and each carries its own number, so the one that failed is the only one that has to
 * be sent again -- R2 is perfectly willing to be handed part five twice.
 *
 * The progress is put back to where the part started before each new attempt. Those bytes did not
 * land; a bar that keeps them is a bar that reaches the end before the file does.
 *
 * 分片上传中的一片,如果线路把它丢了,再给它一两次机会。
 *
 * 重试在这里比在这个文件的任何别处都值钱,因为不重试的代价在这里最大。
 * 一个文件只有在大到装不进一次请求时才会被分片发出,而没有重试的话,
 * 其中任何一次掉线都会把已经落地的每一片一起扔掉。各片是独立的、各自带着编号,
 * 所以失败的那一片是唯一需要重发的一片 —— 把第五片交给 R2 两次,它完全不介意。
 *
 * 每次新的尝试之前,进度会被放回这一片开始时的位置。那些字节没有落地;
 * 一个把它们留着的进度条,会在文件到达之前就走到头。
 */
async function sendPart(id, n, chunk, task, onProgress) {
  for (let attempt = 1; ; attempt++) {
    if (task.cancelled) throw new Error('cancelled');
    try {
      return await xhrSend('PUT', `/api/drive/upload/${id}/part?n=${n}`, chunk, onProgress, task);
    } catch (e) {
      // A cancel is not a failure to retry through; it is the answer.
      // 取消不是一个"重试穿过去"的失败,它就是答案本身。
      if (task.cancelled || e?.message === 'cancelled') throw e;
      if (attempt >= PART_TRIES) throw e;
      onProgress?.(0);
      await naptime(300 * attempt);
    }
  }
}

async function uploadOne(f, parent, task, base) {
  const st = dst.state || { single_max: 90 * 1024 * 1024, part_size: 32 * 1024 * 1024 };
  const prog = (extra) => (loaded) => {
    task.sent = base + extra + loaded;
    paintTask(task);
  };
  if (f.size <= st.single_max) {
    // Saving a file nobody changed should not cost an upload, and should not mint a version that
    // says nothing. Only the browser can decide that in time to matter: a server learns the two
    // are identical only after the bytes have crossed, by which point the upload is already spent.
    //
    // The digest is taken for every upload it can be taken for, not only where it might save this
    // one -- a comparison needs something to have been recorded to compare against, and the only
    // moment that can happen is while the bytes are here.
    //
    // 谁都没改却又保存了一次,不该花掉一次上传,也不该生出一个什么都没说的版本。
    // 只有浏览器能来得及做这个判断:服务端知道两者相同,是在字节过河之后 —— 那时上传已经花掉了。
    //
    // 凡是能取摘要的上传都取,而不只在"这一次可能省下"的时候取 ——
    // 比对需要先前记下过什么才谈得上比,而能记下的时刻只有"字节正在这里"这一刻。
    const hash = await sha256Hex(f);
    const prev = hash ? standingFile(f, parent) : null;
    if (prev && prev.size === f.size && prev.ver_hash === hash) {
      task.same = true;
      task.sent = base + f.size;
      paintTask(task);
      return prev;
    }
    const q = `parent=${encodeURIComponent(parent)}&name=${encodeURIComponent(f.name)}&mime=${encodeURIComponent(f.type || '')}`
      + (hash ? `&hash=${hash}` : '');
    return xhrSend('POST', `/api/drive/upload?${q}`, f, prog(0), task);
  }
  const init = await api('POST', '/api/drive/upload/init', {
    parent, name: f.name, mime: f.type || '', size: f.size,
  });
  task.srvId = init.id;
  const partSize = init.part_size || st.part_size;
  const parts = [];
  let sent = 0;
  for (let n = 1, off = 0; off < f.size; n++, off += partSize) {
    if (task.cancelled) throw new Error('cancelled');
    const chunk = f.slice(off, Math.min(off + partSize, f.size));
    const r = await sendPart(init.id, n, chunk, task, prog(sent));
    parts.push({ n: r.n, etag: r.etag });
    sent += chunk.size;
    task.sent = base + sent;
    paintTask(task);
  }
  if (task.cancelled) throw new Error('cancelled');
  return api('POST', `/api/drive/upload/${init.id}/complete`, { parts });
}

// ---------- Thumbnails (generated client-side, see thumb.js) ----------
// ---------- 缩略图(客户端生成,见 thumb.js) ----------

// One at a time: several videos decoding at once would fight over memory
// 串行生成。几个视频同时解码会互相抢内存
const thq = { q: [], busy: false };

function queueThumb(file, node) {
  if (!node?.id || node.kind !== 'file') return;
  thq.q.push({ file, node });
  if (!thq.busy) drainThumbs();
}

async function loadThumbMod() {
  return import('./thumb.js?v=' + encodeURIComponent(store.brand?.version || ''));
}

async function drainThumbs() {
  thq.busy = true;
  while (thq.q.length) {
    const { file, node } = thq.q.shift();
    try {
      const mod = await loadThumbMod();
      const blob = await mod.makeThumb(file);
      if (blob) {
        const r = await fetch(`/api/drive/files/${node.id}/thumb`, { method: 'POST', body: blob });
        if (r.ok) reloadSoon();
      }
    } catch {}
  }
  thq.busy = false;
}

/** Backfill for images uploaded before thumbnails existed: the grid is already showing the
 *  full image, so encode a thumbnail from the loaded <img> and post it once.
 *  给缩略图功能之前上传的图片补图:网格已经在展示原图,从加载完的 <img> 顺手编码一张传上去。 */
function bindThumbBackfill(box) {
  qsa('img[data-bf]', box).forEach((img) => {
    const id = img.dataset.bf;
    delete img.dataset.bf;
    const go = async () => {
      try {
        const mod = await loadThumbMod();
        const blob = await mod.thumbFromImgEl(img);
        if (blob) await fetch(`/api/drive/files/${id}/thumb`, { method: 'POST', body: blob });
        const n = dst.nodes.find((x) => x.id === id);
        if (n) n.thumb = true;
      } catch {}
    };
    if (img.complete && img.naturalWidth) go();
    else img.addEventListener('load', go, { once: true });
  });
}

function cancelTask(task) {
  if (task.status === 'wait') {
    task.status = 'cancel';
  } else if (task.status === 'up') {
    task.cancelled = true;
    task.status = 'cancel';
    task.xhr?.abort();
    task.abort?.abort();
    if (task.srvId) api('POST', `/api/drive/upload/${task.srvId}/abort`).catch(() => {});
  }
  renderUpPanel();
}

function renderUpPanel() {
  const live = up.tasks.filter((x) => x.status === 'wait' || x.status === 'up');
  // Counting a dropped tree is work in progress even though no bytes are moving yet, so the
  // panel must not offer to close and must not claim to be done.
  // 清点一棵拖进来的目录树是"正在进行",尽管还没有任何字节在动 ——
  // 所以面板此时既不能给出关闭,也不能宣称已经完成。
  const busy = live.length || up.tasks.some((x) => x.status === 'prep');
  if (!up.tasks.length) {
    up.panel?.remove();
    up.panel = null;
    return;
  }
  if (!up.panel) {
    up.panel = document.createElement('div');
    up.panel.className = 'drv-up';
    document.body.appendChild(up.panel);
  }
  up.panel.classList.toggle('min', up.min);
  // The panel carries both directions, so it says which one is happening -- and when both are, it
  // says the thing that is true of both rather than picking a side.
  // 这个面板同时承载两个方向,所以它说明正在发生的是哪一个 ——
  // 而当两个都在发生时,它说那句对两者都成立的话,而不是挑一边站。
  const done = up.tasks.filter((x) => x.status === 'ok');
  const word = (list, up1, down1, both) => {
    // Which direction to name comes from everything in the panel; only the count comes from the
    // list being described. A panel of downloads where none has finished has an empty "done"
    // list, and an empty list has no direction in it at all -- it fell through to the upload
    // wording and renamed the panel after something that never happened.
    // "该说哪个方向"由面板里有什么决定,只有那个数字来自被描述的那份名单。
    // 一个"一件都还没完成"的下载面板,它的 done 是空的,而一份空名单里根本没有方向可言 ——
    // 于是它掉进了上传的那句文案,把面板改名成了一件从未发生过的事。
    const from = list.length ? list : up.tasks;
    const u = from.some((x) => !x.down);
    const d = from.some((x) => x.down);
    return t(u && d ? both : d ? down1 : up1, list.length);
  };
  const head = live.length
    ? word(live, 'drv_up_title', 'drv_dl_title', 'drv_tx_title')
    : busy ? (up.tasks.find((x) => x.status === 'prep')?.name || t('drv_up_preparing'))
      : word(done, 'drv_up_done', 'drv_dl_done', 'drv_tx_done');
  const status = (x) => {
    // A file that went up and a file that did not need to are both successes, and they are not
    // the same success. Saying which one happened is the difference between "already saved" and
    // the silence that reads as "did that work?".
    // 传上去了,和"根本不需要传",都是成功,但不是同一种成功。
    // 说清楚是哪一种,正是"早就存好了"与那种让人怀疑"到底成没成"的沉默之间的差别。
    if (x.status === 'ok' && x.same) return `<span class="st st-ok" title="${esc(t('drv_up_same_tip'))}">${esc(t('drv_up_same'))}</span>`;
    if (x.status === 'ok') return `<span class="st st-ok">${icon('check', 18)}</span>`;
    if (x.status === 'err') return `<span class="st st-err" title="${esc(x.err || '')}">${esc(t('drv_up_failed'))}</span>`;
    if (x.status === 'cancel') return `<span class="st st-cancel">${esc(t('drv_up_canceled'))}</span>`;
    if (x.status === 'prep') return '<span class="st"><span class="upspin"></span></span>';
    // Progress as a closing ring (dashoffset shrinks to 0); paintTask updates it in place
    // 进度用逐渐闭合的圆环表示。dashoffset 收敛到 0。paintTask 原地更新
    const off = (RING_CIRC * (1 - Math.min(1, x.sent / (x.size || 1)))).toFixed(2);
    return `<svg class="ring" viewBox="0 0 20 20" aria-label="progress">
      <circle class="tr" cx="10" cy="10" r="8"/>
      <circle class="pr" cx="10" cy="10" r="8" stroke-dasharray="${RING_CIRC.toFixed(2)}" style="stroke-dashoffset:${off}"/>
    </svg>`;
  };
  up.panel.innerHTML = `
    <div class="drv-up-head">
      <span>${esc(head)}<span class="drv-up-stats">${esc(upStats.text)}</span></span><span class="sp"></span>
      <wa-button class="icon" appearance="plain" data-up="min">${icon(up.min ? 'expand-less' : 'minimize', 16)}</wa-button>
      <wa-button class="icon" appearance="plain" data-up="close" ${busy ? 'disabled' : ''}>${icon('close', 16)}</wa-button>
    </div>
    <div class="drv-up-list">
      ${up.tasks.map((x) => `
      <div class="drv-up-item${x.status === 'ok' && (x.node || x.topId) ? ' goto' : ''}" data-tid="${x.id}"${x.status === 'ok' && (x.node || x.topId) ? ` data-goto="${x.id}" title="${esc(t('drv_up_locate'))}"` : ''}>
        ${x.prep ? `<span class="gfold">${icon(x.down ? 'download' : 'upload', 22)}</span>` : x.group ? `<span class="gfold">${icon('folder', 22)}</span>` : fileIcon(x.name, 24)}
        <span class="nm" title="${esc(x.name)}">${esc(x.name)}</span>
        ${x.prep ? `<span class="gcnt">${x.found || ''}</span>` : x.group ? `<span class="gcnt">${x.done}/${x.total}</span>` : ''}
        ${status(x)}
        ${x.status === 'wait' || x.status === 'up' ? `<wa-button class="icon" appearance="plain" data-cancel="${x.id}" aria-label="${esc(t('cancel'))}">${icon('close', 14)}</wa-button>` : ''}
      </div>`).join('')}
    </div>`;
  // Keep the in-flight tasks in view: after each completion re-render, park the first
  // still-uploading item at the top of the list viewport so the active tail shows.
  // 让在传任务保持可见。每次完成触发重渲后,把第一个仍在上传的条目定位到列表可视区顶部,
  // 后面的活动任务就都露出来了。
  if (!up.min) {
    const listEl = up.panel.querySelector('.drv-up-list');
    const firstLive = listEl?.querySelector('.ring')?.closest('.drv-up-item');
    if (listEl && firstLive) {
      listEl.scrollTop = Math.max(0, firstLive.offsetTop - listEl.offsetTop - 6);
    }
  }
  up.panel.onclick = (e) => {
    const c = e.target.closest('[data-cancel]');
    if (c) {
      const task = up.tasks.find((x) => x.id === +c.dataset.cancel);
      if (task) cancelTask(task);
      return;
    }
    const g = e.target.closest('[data-goto]');
    if (g) {
      const task = up.tasks.find((x) => x.id === +g.dataset.goto);
      if (task) locateTask(task);
      return;
    }
    const b = e.target.closest('[data-up]');
    if (!b) return;
    if (b.dataset.up === 'min') {
      up.min = !up.min;
      renderUpPanel();
    } else if (b.dataset.up === 'close') {
      up.tasks = [];
      renderUpPanel();
    }
  };
}

/** Jump to a finished upload's containing folder and select the item. A group's item is the
 *  top-level folder it created; a single file's item is the file itself.
 *  跳到已完成上传所在的文件夹并选中该项。组任务的项是它建的顶层文件夹;单文件的项是文件本身。 */
function locateTask(task) {
  if (task.group) gotoNode(task.topId, task.parent);
  else gotoNode(task.node?.id, task.node?.parent_id || 'root');
}

function paintTask(task) {
  const el = up.panel?.querySelector(`[data-tid="${task.id}"]`);
  if (!el) return;
  const pr = el.querySelector('.ring .pr');
  if (pr && (task.status === 'up' || task.status === 'wait')) {
    pr.style.strokeDashoffset = (RING_CIRC * (1 - Math.min(1, task.sent / (task.size || 1)))).toFixed(2);
  }
  if (task.group) {
    const c = el.querySelector('.gcnt');
    if (c) c.textContent = `${task.done}/${task.total}`;
  }
}
