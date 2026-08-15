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
import { store, navigate, show } from '../app.js';

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

// Archives browsable as read-only folders (arc.js, lazy). Extensions map to ranged readers:
// the zip family shares one, 7z has its own.
// 可当只读目录浏览的压缩包(arc.js,懒加载)。扩展名对应 Range 式读取器:
// zip 家族共用一个,7z 单独一个。
const ARC_EXTS = new Set(['zip', 'jar', 'apk', 'epub', '7z']);
/** Node info stashed for arc.js so entering an archive needs no extra request
 *  为 arc.js 暂存的节点信息。进压缩包不用再发请求 */
export const arcSeed = new Map();

const dst = {
  view: 'my',            // my | folder | shared | recent | starred | trash | search
  folderId: null,
  q: '',
  nodes: [],
  shown: [],             // 排序后的当前列表
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

const dlUrl = (id, inline) => `/api/drive/files/${encodeURIComponent(id)}/dl${inline ? '?inline=1' : ''}`;

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
  } else if (['shared', 'recent', 'starred', 'trash', 'links'].includes(seg[0])) {
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

async function joinShare(token) {
  try {
    const r = await api('POST', '/api/drive/shares/join', { token });
    toast(t('drv_share_joined', r.name));
    navigate(`#/drive/folder/${r.node_id}`);
  } catch (e) {
    toast(e.message, true);
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
  { key: 'trash', icon: 'trash', hash: '#/drive/trash' },
];

function frame() {
  const active = (k) => (dst.view === k || (k === 'my' && dst.view === 'folder') ? 'active' : '');
  return `
  <div class="page drv-page">
    <header class="page-head">
      <wa-button class="icon" appearance="plain" href="#/" aria-label="${esc(t('back_mail'))}">${icon('back', 20)}</wa-button>
      <h1 style="display:flex;align-items:center;gap:10px">${icon('cloud', 24)}${esc(t('drv_title'))}</h1>
      <form class="searchbar" id="drv-search" style="max-width:560px">
        ${icon('search', 20)}
        <input type="text" placeholder="${esc(t('drv_search_ph'))}" value="${esc(dst.view === 'search' ? dst.q : '')}" autocomplete="off">
      </form>
      <div style="flex:1"></div>
      <wa-button class="icon" appearance="plain" id="drv-layout" title="${esc(dst.layout === 'list' ? t('drv_view_grid') : t('drv_view_list'))}">
        ${icon(dst.layout === 'list' ? 'grid' : 'view-list', 20)}
      </wa-button>
    </header>
    <div class="drv-body">
      <nav class="drv-nav">
        <wa-dropdown id="drv-new-dd">
          <wa-button slot="trigger" class="drv-new" variant="brand">${icon('plus', 20)}<span>${esc(t('drv_new'))}</span></wa-button>
          <wa-dropdown-item value="folder">${icon('folder-plus', 18)} ${esc(t('drv_new_folder'))}</wa-dropdown-item>
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
  qs('#drv-search')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = qs('#drv-search input').value.trim();
    if (v) navigate(`#/drive/search/${encodeURIComponent(v)}`);
  });
  qs('#drv-layout')?.addEventListener('click', () => {
    dst.layout = dst.layout === 'list' ? 'grid' : 'list';
    localStorage.setItem('cf_drive_layout', dst.layout);
    renderDrive(currentSeg());
  });
  qs('#drv-new-dd')?.addEventListener('wa-select', (e) => {
    const v = e.detail?.item?.value;
    if (v === 'folder') newFolderDialog();
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
      dst.path = data.path || [];
      dst.access = data.access || 'owner';
      dst.shareRoot = data.share_root || null;
      dst.inTrash = !!data.in_trash;
      renderFolderView(main);
    } else if (dst.view === 'shared') {
      const data = await api('GET', '/api/drive/shared');
      renderSharedView(main, data.shares || []);
    } else if (dst.view === 'links') {
      const data = await api('GET', '/api/drive/shares');
      renderLinksView(main, data.shares || []);
    } else {
      const ep = { recent: '/api/drive/recent', starred: '/api/drive/starred', trash: '/api/drive/trash', search: `/api/drive/search?q=${encodeURIComponent(dst.q)}` }[dst.view];
      const data = await api('GET', ep);
      dst.nodes = data.nodes;
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
      ${dst.shown.length ? (dst.layout === 'grid' ? gridHtml() : tableHtml(arrow)) : emptyHtml()}
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
        <span class="cnt">${selN}</span>
        ${selActionsHtml()}
      </div>`
    : `<div class="drv-crumbbar"><div class="drv-crumbs">${crumbsHtml()}</div><span class="sp"></span>
        <wa-button class="icon" appearance="plain" id="drv-refresh" aria-label="${esc(t('refresh'))}">${icon('refresh', 18)}</wa-button></div>`;
}

function bindBar(main) {
  qsa('#drv-bar .drv-crumb[data-nav]', main).forEach((el) =>
    el.addEventListener('click', () => navigate(el.dataset.nav)));
  qs('#drv-refresh', main)?.addEventListener('click', reload);
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

function selActionsHtml() {
  const nodes = selNodes();
  const trashCtx = dst.view === 'trash' || dst.inTrash;
  const single = nodes.length === 1 ? nodes[0] : null;
  if (trashCtx) {
    return `
      <wa-button class="icon" appearance="plain" data-act="restore" title="${esc(t('drv_restore'))}">${icon('restore', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" data-act="delete" title="${esc(t('drv_delete_forever'))}">${icon('trash', 20)}</wa-button>`;
  }
  const canEdit = dst.access !== 'viewer';
  const own = dst.access === 'owner';
  return `
    ${single && single.kind === 'file' ? `<wa-button class="icon" appearance="plain" data-act="download" title="${esc(t('drv_download'))}">${icon('download', 20)}</wa-button>` : ''}
    ${own ? `<wa-button class="icon" appearance="plain" data-act="star" title="${esc(t('drv_star'))}">${icon('star', 20)}</wa-button>` : ''}
    ${canEdit ? `<wa-button class="icon" appearance="plain" data-act="move" title="${esc(t('drv_move'))}">${icon('folder-move', 20)}</wa-button>` : ''}
    ${canEdit ? `<wa-button class="icon" appearance="plain" data-act="trash" title="${esc(t('drv_trash_it'))}">${icon('trash', 20)}</wa-button>` : ''}`;
}

function nodeIconHtml(n, size = 22) {
  if (n.kind === 'folder') return `<wa-icon class="fold" name="folder" style="font-size:${size}px"></wa-icon>`;
  return fileIcon(n.name, size);
}

function badgesHtml(n) {
  const out = [];
  if (n.shared) out.push(icon('folder-shared', 15));
  if (n.starred && dst.view !== 'starred') out.push(icon('starFill', 14));
  return out.length ? `<span class="drv-badges">${out.join('')}</span>` : '';
}

function tableHtml(arrow) {
  const trashCtx = dst.view === 'trash';
  const rows = dst.shown.map((n, i) => `
    <tr class="drv-row ${dst.sel.has(n.id) ? 'sel' : ''}" data-id="${esc(n.id)}" data-i="${i}">
      <td><div class="drv-name">${nodeIconHtml(n)}<span class="nm">${esc(n.name)}</span>${badgesHtml(n)}</div></td>
      <td class="c-time drv-dim">${fmtDate(trashCtx ? n.updated_at : n.updated_at)}</td>
      <td class="drv-dim">${fmtSize(effSize(n))}</td>
      <td><wa-button class="icon rowbtn" appearance="plain" data-menu="${esc(n.id)}" aria-label="menu">${icon('dots-v', 18)}</wa-button></td>
    </tr>`).join('');
  return `
  <table class="drv-table">
    <colgroup><col><col class="c-time"><col class="c-size"><col class="c-menu"></colgroup>
    <thead><tr>
      <th data-sort="name">${esc(t('drv_th_name'))}${arrow('name')}</th>
      <th data-sort="updated_at" class="c-time">${esc(t('drv_th_modified'))}${arrow('updated_at')}</th>
      <th data-sort="size">${esc(t('drv_th_size'))}${arrow('size')}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function gridHtml() {
  return `<div class="drv-grid">${dst.shown.map((n, i) => {
    // Prefer the stored thumbnail. Images from before the thumbnail era still show full-size
    // (as they always did) and carry data-bf so the backfill can mint them a real one.
    // 优先用存好的缩略图。缩略图时代之前的图片仍显示原图(一直如此),并带上 data-bf
    // 让回填顺手给它补一张。
    const oldImg = !n.thumb && n.kind === 'file' && IMG_RE.test(n.mime) && n.size < 20 * 1024 * 1024;
    const bf = oldImg && dst.access !== 'viewer' ? ` data-bf="${esc(n.id)}"` : '';
    const media = n.thumb
      ? `<img loading="lazy" src="/api/drive/files/${esc(n.id)}/thumb" alt="">`
      : oldImg
        ? `<img loading="lazy" src="${dlUrl(n.id, true)}"${bf} alt="">`
        : fileIcon(n.name, 44);
    return `
    <div class="drv-card ${n.kind} ${dst.sel.has(n.id) ? 'sel' : ''}" data-id="${esc(n.id)}" data-i="${i}">
      <div class="thumb">${n.kind === 'file' ? media : icon('folder', 56)}</div>
      <div class="cap">${nodeIconHtml(n, 22)}<span class="nm" title="${esc(n.name)}">${esc(n.name)}</span>${badgesHtml(n)}
        <wa-button class="icon rowbtn" appearance="plain" data-menu="${esc(n.id)}" aria-label="menu">${icon('dots-v', 16)}</wa-button></div>
    </div>`;
  }).join('')}</div>`;
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
    if (e.target.closest('[data-menu]')) return;
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
    } else if (e.shiftKey && dst.lastIdx >= 0) {
      const [a, b] = [Math.min(dst.lastIdx, i), Math.max(dst.lastIdx, i)];
      dst.sel.clear();
      for (let j = a; j <= b; j++) dst.sel.add(dst.shown[j].id);
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
      box.classList.add('droppable');
    });
    box.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        box.classList.remove('droppable');
      }
    });
    box.addEventListener('dragover', (e) => e.preventDefault());
    box.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      box.classList.remove('droppable');
      const items = await filesFromDataTransfer(e.dataTransfer);
      enqueueFiles(items);
    });
  }
}

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
  if (act === 'download') downloadFile(nodes[0]);
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
window.addEventListener('keydown', (e) => {
  if (!qs('.drv-body')) return;
  if (e.key === 'Escape') closeMenu();
  if (e.key === 'Delete' && dst.sel.size && !e.target.closest('input,textarea,wa-dialog')) {
    const trashCtx = dst.view === 'trash' || dst.inTrash;
    if (trashCtx) deleteForever(selNodes());
    else if (dst.access !== 'viewer') trashNodes(selNodes());
  }
});

function openMenu(x, y, nodes) {
  closeMenu();
  const items = menuItems(nodes);
  if (!items.length) return;
  menuEl = document.createElement('div');
  menuEl.className = 'drv-menu';
  menuEl.innerHTML = items.map((it, i) => it === '-'
    ? '<div class="sep"></div>'
    : `<div class="mi ${it.danger ? 'danger' : ''}" data-mi="${i}">${icon(it.ic, 18)}<span>${esc(it.label)}</span></div>`
  ).join('');
  document.body.appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menuEl.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  menuEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const el = e.target.closest('[data-mi]');
    if (!el) return;
    const it = items[parseInt(el.dataset.mi, 10)];
    closeMenu();
    it.fn();
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
    { ic: 'upload', label: t('drv_upload_files'), fn: () => qs('#drv-file-input')?.click() },
    { ic: 'upload', label: t('drv_upload_folder'), fn: () => qs('#drv-dir-input')?.click() },
  ];
}

function menuItems(nodes) {
  if (!nodes.length) return emptyMenuItems();
  const single = nodes.length === 1 ? nodes[0] : null;
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
    if (single.kind === 'file') out.push({ ic: 'download', label: t('drv_download'), fn: () => downloadFile(single) });
    out.push('-');
    if (canEdit && !editorOnRoot) out.push({ ic: 'pencil', label: t('drv_rename'), fn: () => renameDialog(single) });
  }
  // Share whatever is selected: files, folders, or any mix of them
  // 选中什么就分享什么:文件、目录,或者两者混装
  if (own) out.push({ ic: 'share', label: t('drv_share'), fn: () => shareDialog(nodes) });
  if (canEdit && !editorOnRoot) out.push({ ic: 'folder-move', label: t('drv_move'), fn: () => moveDialog(nodes) });
  if (own) {
    const allStar = nodes.every((n) => n.starred);
    out.push({ ic: allStar ? 'star' : 'starFill', label: t(allStar ? 'drv_unstar' : 'drv_star'), fn: () => starNodes(nodes, !allStar) });
  }
  if (canEdit && !editorOnRoot) {
    out.push('-');
    out.push({ ic: 'trash', label: t('drv_trash_it'), danger: true, fn: () => trashNodes(nodes) });
  }
  return out.filter((x, i, a) => !(x === '-' && (i === 0 || a[i - 1] === '-' || i === a.length - 1)));
}

function downloadFile(n) {
  if (n.arc) return downloadArcEntry(n);
  const a = document.createElement('a');
  a.href = dlUrl(n.id);
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
  const rows = shares.map((s) => {
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
      ${rows || `<div class="drv-empty">${icon('link', 48)}<div>${esc(t('drv_share_none_yet'))}</div></div>`}
    </div>`;
  bindBar(main);

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
// ---------- Shared-with-me view ----------
// ---------- 共享给我 ----------

function renderSharedView(main, shares) {
  const rows = shares.map((s) => `
    <tr class="drv-row" data-nid="${esc(s.node_id)}" data-share="${esc(s.share_id)}">
      <td><div class="drv-name">${icon('folder-shared', 22)}<span class="nm">${esc(s.name)}</span></div></td>
      <td class="c-owner drv-dim">${esc(s.owner_name || s.owner_email)}</td>
      <td class="drv-dim">${esc(t(s.role === 'editor' ? 'drv_role_editor' : 'drv_role_viewer'))}</td>
      <td class="c-time drv-dim">${fmtDate(s.joined_at)}</td>
      <td><wa-button class="icon rowbtn" appearance="plain" data-leave="${esc(s.share_id)}" title="${esc(t('drv_leave_share'))}">${icon('close', 16)}</wa-button></td>
    </tr>`).join('');
  main.innerHTML = `
    <div class="drv-crumbbar"><div class="drv-crumbs"><span class="drv-crumb here">${esc(t('drv_shared'))}</span></div><span class="sp"></span>
      <wa-button class="icon" appearance="plain" id="drv-refresh">${icon('refresh', 18)}</wa-button></div>
    <div class="drv-scroll">
      ${shares.length ? `
      <table class="drv-table">
        <colgroup><col><col class="c-owner"><col class="c-size"><col class="c-time"><col class="c-menu"></colgroup>
        <thead><tr><th>${esc(t('drv_th_name'))}</th><th>${esc(t('drv_th_owner'))}</th><th>${esc(t('drv_th_role'))}</th><th class="c-time">${esc(t('drv_th_joined'))}</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : emptyHtml()}
    </div>`;
  qs('#drv-refresh', main)?.addEventListener('click', reload);
  qsa('[data-leave]', main).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await confirmDialog(t('drv_leave_confirm'), t('drv_leave_share')))) return;
    try {
      await api('DELETE', `/api/drive/shares/${b.dataset.leave}/members/${store.me.user.id}`);
      reload();
    } catch (err) {
      toast(err.message, true);
    }
  }));
  qsa('[data-nid]', main).forEach((r) => r.addEventListener('dblclick', () => navigate(`#/drive/folder/${r.dataset.nid}`)));
  qsa('[data-nid]', main).forEach((r) => r.addEventListener('click', (e) => {
    if (e.detail === 1 && !e.target.closest('[data-leave]')) navigate(`#/drive/folder/${r.dataset.nid}`);
  }));
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
  pv = { list: files.length ? files : [node], idx, el: document.createElement('div') };
  pv.el.className = 'drv-view';
  document.body.appendChild(pv.el);
  paintPreview();
  window.addEventListener('keydown', pvKeys);
}

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

function closePreview() {
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

function noprevHtml(n) {
  return `<div class="noprev" style="margin:auto">${fileIcon(n.name, 72)}<div>${esc(t('drv_no_preview'))}</div></div>`;
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
    const kind = mod.kindOf(n.name, n.mime);
    if (!kind) {
      box.innerHTML = noprevHtml(n);
      return;
    }
    pvRich = await mod.renderPreview(n, box, kind, n.arcUrl || dlUrl(n.id, true));
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
  pvPdf.io?.disconnect();
  // v6: cleanup goes through the loading task (PDFDocumentProxy lost its destroy())
  // v6 的清理走 loading task(PDFDocumentProxy 已没有 destroy())
  pvPdf.task?.destroy?.().catch?.(() => {});
  pvPdf = null;
}

async function renderPdfPreview(node, box) {
  destroyPdfPreview();
  const my = { task: null, io: null, gen: 0 };
  pvPdf = my;
  const gen = my.gen;
  try {
    const mod = await loadThumbMod();
    const lib = await mod.pdfjs();
    const r = await fetch(node.arcUrl || dlUrl(node.id, true));
    if (!r.ok) throw new Error('fetch');
    const task = lib.getDocument(mod.pdfDocOpts(await r.arrayBuffer()));
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
      d.className = 'drv-pdf-page';
      d.dataset.page = i;
      d.style.width = width + 'px';
      d.style.height = estH + 'px';
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
        holder.replaceChildren(c);
      } catch {}
    };
    my.io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) renderPage(e.target);
    }, { root: box, rootMargin: '600px' });
    for (const d of box.children) my.io.observe(d);
    // First pages paint immediately; the observer takes over from there
    // 前几页立即渲染,后面的交给观察器
    for (const d of [...box.children].slice(0, 2)) renderPage(d);
  } catch {
    if (pvPdf === my && box.isConnected) {
      box.innerHTML = `<div class="noprev" style="margin-top:60px">${fileIcon(node.name, 72)}<div>${esc(t('drv_no_preview'))}</div></div>`;
    }
  }
}

function pvKeys(e) {
  if (!pv) return;
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
  paintPreview();
}

/** Overlay chrome shared by the normal path and the extract-in-progress state
 *  预览层外壳。正常路径与"解出中"状态共用 */
function paintPvShell(n, body) {
  pv.el.innerHTML = `
    <div class="drv-view-head">
      <wa-button class="icon" appearance="plain" data-close aria-label="${esc(t('close'))}">${icon('close', 20)}</wa-button>
      ${fileIcon(n.name, 20)}<span class="nm">${esc(n.name)}</span>
      <span class="drv-dim" style="color:#aaa;font-size:12.5px">${fmtSize(n.size)}</span>
      <wa-button class="icon" appearance="plain" data-dl aria-label="${esc(t('drv_download'))}">${icon('download', 20)}</wa-button>
    </div>
    <div class="drv-view-body">
      ${pv.list.length > 1 ? `<wa-button class="icon drv-view-nav prev" appearance="plain" data-nav="-1">${icon('back', 22)}</wa-button>` : ''}
      ${body}
      ${pv.list.length > 1 ? `<wa-button class="icon drv-view-nav next" appearance="plain" data-nav="1">${icon('next', 22)}</wa-button>` : ''}
    </div>`;
  pv.el.onclick = (e) => {
    if (e.target.closest('[data-close]')) closePreview();
    else if (e.target.closest('[data-dl]')) downloadFile(n);
    else if (e.target.closest('[data-nav]')) pvStep(parseInt(e.target.closest('[data-nav]').dataset.nav, 10));
    else if (e.target === pv.el.querySelector('.drv-view-body')) closePreview();
  };
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
  const mime = (n.mime || '').toLowerCase();
  const src = n.arcUrl || dlUrl(n.id, true);
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(n.name);
  const isAudio = AUD_RE.test(mime) || AUD_EXTS.has(extOf(n.name));
  let body;
  // Keep a loading veil over the image until the bitmap actually decodes. The src is handed
  // over long before the bytes exist -- the worker may still be decompressing a whole solid
  // block -- so swapping the spinner straight out for the <img> leaves an unexplained blank
  // frame, which reads as "it failed" rather than "it is still coming".
  // 图片解出来之前一直盖着加载遮罩。src 交出去时字节往往还不存在 —— worker 可能正在解一整个
  // 固实块 —— 直接把加载图换成 <img> 会留下无从解释的空白,看起来像"失败了"而不是"还在来"。
  if (IMG_RE.test(mime)) body = `<img src="${esc(src)}" alt=""><div class="drv-pvwait">${spinnerHtml()}</div>`;
  else if (VID_RE.test(mime)) body = `<video controls autoplay src="${esc(src)}"></video><div class="drv-pvwait">${spinnerHtml()}</div>`;
  else if (isAudio) {
    // Cover-art card: the stored thumbnail doubles as the artwork
    // 封面卡片。存好的缩略图直接当专辑封面用
    body = `
    <div class="drv-audio">
      ${n.thumb
        ? `<img class="art" src="/api/drive/files/${esc(n.id)}/thumb" alt="">`
        : `<div class="art fallback">${icon('fileAudio', 72)}</div>`}
      <div class="anm">${esc(n.name)}</div>
      <audio controls autoplay src="${esc(src)}"></audio>
    </div>
    <div class="drv-pvwait">${spinnerHtml()}</div>`;
  } else if (isPdf) body = `<div class="drv-doc"><div class="drv-docc"><div class="drv-pdf drv-docwin">${spinnerHtml()}</div></div></div>`;
  else body = `<div class="drv-doc"><div class="drv-docc"><div class="drv-docwin">${spinnerHtml()}</div></div></div>`;
  paintPvShell(n, body);
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
  if (up.tasks.some((x) => x.status === 'up' || x.status === 'wait')) {
    e.preventDefault();
    e.returnValue = '';
  }
});
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

async function filesFromDataTransfer(dt) {
  const out = [];
  const entries = [...(dt.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map((f) => ({ file: f, rel: f.webkitRelativePath || '' }));
  for (const e of entries) await walkEntry(e, '', out);
  return out;
}

function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => {
        out.push({ file: f, rel: prefix ? `${prefix}/${f.name}` : '' });
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
          for (const e of batch) await walkEntry(e, sub, out);
          loop();
        }, () => resolve());
      })();
    } else resolve();
  });
}

async function enqueueFiles(items) {
  if (dst.view === 'arc') return; // archives are read-only / 压缩包内只读
  if (!items.length) return;
  if (!canWriteHere()) {
    toast(tErr('e_drive_forbidden'), true);
    return;
  }
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
        task.node = node; // where it landed: id + parent_id, for click-to-locate / 落点,供点击定位
        queueThumb(task.file, node);
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
        refreshState();
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
      queueThumb(m.file, node);
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

async function uploadOne(f, parent, task, base) {
  const st = dst.state || { single_max: 90 * 1024 * 1024, part_size: 32 * 1024 * 1024 };
  const prog = (extra) => (loaded) => {
    task.sent = base + extra + loaded;
    paintTask(task);
  };
  if (f.size <= st.single_max) {
    const q = `parent=${encodeURIComponent(parent)}&name=${encodeURIComponent(f.name)}&mime=${encodeURIComponent(f.type || '')}`;
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
    const r = await xhrSend('PUT', `/api/drive/upload/${init.id}/part?n=${n}`, chunk, prog(sent), task);
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
    if (task.srvId) api('POST', `/api/drive/upload/${task.srvId}/abort`).catch(() => {});
  }
  renderUpPanel();
}

function renderUpPanel() {
  const live = up.tasks.filter((x) => x.status === 'wait' || x.status === 'up');
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
  const head = live.length ? t('drv_up_title', live.length) : t('drv_up_done', up.tasks.filter((x) => x.status === 'ok').length);
  const status = (x) => {
    if (x.status === 'ok') return `<span class="st st-ok">${icon('check', 18)}</span>`;
    if (x.status === 'err') return `<span class="st st-err" title="${esc(x.err || '')}">${esc(t('drv_up_failed'))}</span>`;
    if (x.status === 'cancel') return `<span class="st st-cancel">${esc(t('drv_up_canceled'))}</span>`;
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
      <wa-button class="icon" appearance="plain" data-up="close" ${live.length ? 'disabled' : ''}>${icon('close', 16)}</wa-button>
    </div>
    <div class="drv-up-list">
      ${up.tasks.map((x) => `
      <div class="drv-up-item${x.status === 'ok' && (x.node || x.topId) ? ' goto' : ''}" data-tid="${x.id}"${x.status === 'ok' && (x.node || x.topId) ? ` data-goto="${x.id}" title="${esc(t('drv_up_locate'))}"` : ''}>
        ${x.group ? `<span class="gfold">${icon('folder', 22)}</span>` : fileIcon(x.name, 24)}
        <span class="nm" title="${esc(x.name)}">${esc(x.name)}</span>
        ${x.group ? `<span class="gcnt">${x.done}/${x.total}</span>` : ''}
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
  const itemId = task.group ? task.topId : task.node?.id;
  const folderId = task.group ? task.parent : (task.node?.parent_id || 'root');
  if (!itemId) return;
  dst.selectAfterLoad = itemId;
  const hash = folderId && folderId !== 'root' ? `#/drive/folder/${folderId}` : '#/drive';
  if (location.hash === hash) reload(); // already there -- re-list so the item is fresh / 已在此,重列
  else navigate(hash);
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
