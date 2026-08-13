// Drive UI, Google-Drive-flavoured. One folder view with list and grid layouts, selection,
// context menus, drag-drop uploads with a progress panel, a media preview overlay, folder
// sharing and a trash. All data comes from /api/drive/*; texts come from i18n keys drv_*.
// 网盘界面。Google Drive 风格。同一套文件夹视图支持列表/网格两种布局、多选、右键菜单、
// 拖拽上传加进度面板、媒体预览层、文件夹共享与回收站。数据全部走 /api/drive/*。
import { api } from '../api.js';
import { t, tErr } from '../i18n.js';
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
  if (seg[0] === 's' && seg[1]) return joinShare(seg[1]);
  dst.q = '';
  if (!seg[0]) {
    dst.view = 'my';
    dst.folderId = null;
  } else if (seg[0] === 'folder' && seg[1]) {
    dst.view = 'folder';
    dst.folderId = seg[1];
  } else if (['shared', 'recent', 'starred', 'trash'].includes(seg[0])) {
    dst.view = seg[0];
    dst.folderId = null;
  } else if (seg[0] === 'search' && seg[1]) {
    dst.view = 'search';
    dst.q = seg[1];
  } else {
    return navigate('#/drive');
  }
  dst.sel.clear();
  dst.lastIdx = -1;
  show(frame());
  bindFrame();
  refreshState();
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
      <span class="drv-crumb ${last ? 'here' : ''}" ${last ? '' : `data-nav="#/drive/folder/${esc(p.id)}"`}>${esc(p.name)}</span>`;
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
}

function barHtml() {
  const selN = dst.sel.size;
  return selN
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
  else openPreview(n);
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
    if (single.kind === 'folder' && own) out.push({ ic: 'share', label: t('drv_share'), fn: () => shareDialog(single) });
    out.push('-');
    if (canEdit && !editorOnRoot) out.push({ ic: 'pencil', label: t('drv_rename'), fn: () => renameDialog(single) });
  }
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
  const a = document.createElement('a');
  a.href = dlUrl(n.id);
  document.body.appendChild(a);
  a.click();
  a.remove();
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

async function shareDialog(node) {
  const d = showModal(`
    <div class="modal-body" id="drv-share-body"><div class="loading">${esc(t('loading'))}</div></div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button appearance="plain" data-x="close">${esc(t('close'))}</wa-button>
    </div>`);
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) closeModal();
  });
  const paint = async () => {
    const box = qs('#drv-share-body', d);
    let data;
    try {
      data = await api('GET', `/api/drive/nodes/${node.id}/shares`);
    } catch (e) {
      box.innerHTML = `<div class="drv-move-empty">${esc(e.message)}</div>`;
      return;
    }
    const s = data.share;
    const roleSel = (v) => `
      <wa-select id="drv-share-role" value="${esc(v)}" size="small" style="width:140px">
        <wa-option value="viewer">${esc(t('drv_role_viewer'))}</wa-option>
        <wa-option value="editor">${esc(t('drv_role_editor'))}</wa-option>
      </wa-select>`;
    if (!s) {
      box.innerHTML = `
        <h3 style="margin:0 0 10px">${esc(t('drv_share_title', node.name))}</h3>
        <p class="drv-dim" style="margin:0 0 14px;font-size:13px">${esc(t('drv_share_none'))}</p>
        <div style="display:flex;gap:10px;align-items:center">
          ${roleSel('viewer')}
          <wa-button variant="brand" size="small" id="drv-share-create">${icon('link', 16)} ${esc(t('drv_share_create'))}</wa-button>
        </div>`;
      qs('#drv-share-create', d)?.addEventListener('click', async () => {
        try {
          const role = qs('#drv-share-role', d)?.value || 'viewer';
          await api('POST', `/api/drive/nodes/${node.id}/shares`, { role });
          await paint();
          reloadSoon();
        } catch (e) {
          toast(e.message, true);
        }
      });
      return;
    }
    const url = `${location.origin}/#/drive/s/${s.token}`;
    const members = (s.members || []).map((m) => `
      <div class="drv-member">
        ${avatar(m.name || m.email, 30)}
        <div class="who"><div>${esc(m.name || m.email)}</div><div class="em">${esc(m.email)} · ${fmtDate(m.joined_at)}</div></div>
        <wa-button class="icon" appearance="plain" data-rm="${esc(m.user_id)}" title="${esc(t('drv_member_remove'))}">${icon('close', 16)}</wa-button>
      </div>`).join('');
    box.innerHTML = `
      <h3 style="margin:0 0 10px">${esc(t('drv_share_title', node.name))}</h3>
      <div class="drv-share-link">
        <input readonly value="${esc(url)}" onclick="this.select()">
        <wa-button size="small" id="drv-share-copy">${icon('copy', 15)} ${esc(t('drv_copy_link'))}</wa-button>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin:4px 0 14px">
        <span style="font-size:13px">${esc(t('drv_role'))}</span>
        ${roleSel(s.role)}
        <span style="flex:1"></span>
        <wa-button size="small" appearance="outlined" id="drv-share-stop" style="--wa-color-brand-fill-loud:#e5484d">${esc(t('drv_share_stop'))}</wa-button>
      </div>
      <h4 style="margin:0 0 6px;font-size:13.5px">${esc(t('drv_share_members'))}</h4>
      ${members || `<div class="drv-dim" style="font-size:13px">${esc(t('drv_share_nobody'))}</div>`}`;
    qs('#drv-share-copy', d)?.addEventListener('click', async () => {
      await copyText(url);
      toast(t('drv_link_copied'));
    });
    qs('#drv-share-role', d)?.addEventListener('change', async (e) => {
      try {
        await api('PUT', `/api/drive/shares/${s.id}`, { role: e.target.value });
        toast(t('t_saved'));
      } catch (err) {
        toast(err.message, true);
        paint();
      }
    });
    qs('#drv-share-stop', d)?.addEventListener('click', async () => {
      if (!(await confirmDialog(t('drv_share_stop_confirm'), t('drv_share_stop')))) return;
      try {
        await api('DELETE', `/api/drive/shares/${s.id}`);
        await paint();
        reloadSoon();
      } catch (e) {
        toast(e.message, true);
      }
    });
    qsa('[data-rm]', d).forEach((b) => b.addEventListener('click', async () => {
      try {
        await api('DELETE', `/api/drive/shares/${s.id}/members/${b.dataset.rm}`);
        paint();
      } catch (e) {
        toast(e.message, true);
      }
    }));
  };
  await paint();
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
  const files = dst.shown.filter((n) => n.kind === 'file');
  const idx = Math.max(0, files.findIndex((n) => n.id === node.id));
  pv?.el?.remove();
  pv = { list: files.length ? files : [node], idx, el: document.createElement('div') };
  pv.el.className = 'drv-view';
  document.body.appendChild(pv.el);
  paintPreview();
  window.addEventListener('keydown', pvKeys);
}

function closePreview() {
  destroyPdfPreview();
  pvRich?.destroy?.();
  pvRich = null;
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
    pvRich = await mod.renderPreview(n, box, kind, dlUrl(n.id, true));
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
    const r = await fetch(dlUrl(node.id, true));
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

function pvStep(d) {
  if (!pv || pv.list.length < 2) return;
  pv.idx = (pv.idx + d + pv.list.length) % pv.list.length;
  paintPreview();
}

async function paintPreview() {
  const n = pv.list[pv.idx];
  destroyPdfPreview();
  pvRich?.destroy?.();
  pvRich = null;
  const mime = (n.mime || '').toLowerCase();
  const src = dlUrl(n.id, true);
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(n.name);
  const isAudio = AUD_RE.test(mime) || AUD_EXTS.has(extOf(n.name));
  let body;
  if (IMG_RE.test(mime)) body = `<img src="${esc(src)}" alt="">`;
  else if (VID_RE.test(mime)) body = `<video controls autoplay src="${esc(src)}"></video>`;
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
    </div>`;
  } else if (isPdf) body = `<div class="drv-doc"><div class="drv-docc"><div class="drv-pdf drv-docwin">${spinnerHtml()}</div></div></div>`;
  else body = `<div class="drv-doc"><div class="drv-docc"><div class="drv-docwin">${spinnerHtml()}</div></div></div>`;
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
      <div class="drv-up-item" data-tid="${x.id}">
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
