// Public share landing page. Reached without an account, so it may not touch anything that
// assumes a signed-in session (no store.me, no /api/drive/*). Everything it can do is read:
// list the shared items, walk into shared folders, preview and download files.
// 公开分享落地页。无账号即可抵达,因此不能碰任何以"已登录会话"为前提的东西
// (没有 store.me,不用 /api/drive/*)。它能做的一切都是读:列出被分享的条目、
// 进入被分享的目录、预览与下载文件。

import { t, tErr, setLang } from '../i18n.js';
import { esc, icon, qs, qsa, fmtSize, fmtDate, fileIcon } from '../ui.js';
import { store, navigate } from '../app.js';

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

const dlUrl = (token, id, inline) =>
  `/api/pub/${encodeURIComponent(token)}/files/${encodeURIComponent(id)}/dl${inline ? '?inline=1' : ''}`;
const thumbUrl = (token, id) =>
  `/api/pub/${encodeURIComponent(token)}/files/${encodeURIComponent(id)}/thumb`;

/** Same rule as the signed-in drive: a folder's size is the rollup of everything under it.
 *  与登录端一致的口径:目录的大小是其下全部内容的上卷值。 */
const effSize = (n) => (n.kind === 'file' ? n.size || 0 : n.tree_bytes || 0);

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
  return `<div class="pub-brand">${logo}<span>${esc(name)}</span></div>`;
}

// ---------- Listing ----------
// ---------- 列表 ----------

const layout = () => (localStorage.getItem('cf_drive_layout') === 'grid' ? 'grid' : 'list');

function rowsHtml(token, nodes) {
  return nodes.map((n) => `
    <div class="pub-row pub-it" data-id="${esc(n.id)}" data-kind="${esc(n.kind)}" data-name="${esc(n.name)}"
         data-mime="${esc(n.mime || '')}">
      <span class="ic">${n.kind === 'folder' ? icon('folder', 22) : fileIcon(n.name, 22)}</span>
      <span class="nm">${esc(n.name)}</span>
      <span class="sz drv-dim">${esc(fmtSize(effSize(n)))}</span>
      <span class="dt drv-dim">${esc(fmtDate(n.updated_at))}</span>
      ${n.kind === 'file' ? `<a class="dl" href="${esc(dlUrl(token, n.id, false))}" download title="${esc(t('drv_download'))}">${icon('download', 18)}</a>` : ''}
    </div>`).join('');
}

function cardsHtml(token, nodes) {
  return `<div class="pub-gridwrap"><div class="drv-grid">${nodes.map((n) => {
    // Files uploaded before thumbnails existed have none to serve, and nobody visiting a public
    // link may mint one -- small images fall back to the original, everything else to its icon.
    // 缩略图时代之前上传的文件没有缩略图可发,而公开链接的访问者无权生成 ——
    // 小图退回原图,其余退回类型图标。
    const old = !n.thumb && n.kind === 'file' && IMG_RE.test((n.mime || '').toLowerCase()) && n.size < 20 * 1024 * 1024;
    const media = n.thumb
      ? `<img loading="lazy" src="${esc(thumbUrl(token, n.id))}" alt="">`
      : old ? `<img loading="lazy" src="${esc(dlUrl(token, n.id, true))}" alt="">`
        : fileIcon(n.name, 44);
    return `
    <div class="drv-card pub-it ${esc(n.kind)}" data-id="${esc(n.id)}" data-kind="${esc(n.kind)}"
         data-name="${esc(n.name)}" data-mime="${esc(n.mime || '')}">
      <div class="thumb">${n.kind === 'folder' ? icon('folder', 56) : media}</div>
      <div class="cap">
        ${n.kind === 'folder' ? `<wa-icon class="fold" name="folder" style="font-size:22px"></wa-icon>` : fileIcon(n.name, 22)}
        <span class="nm" title="${esc(n.name)}">${esc(n.name)}</span>
        <span class="drv-dim sz">${esc(fmtSize(effSize(n)))}</span>
      </div>
    </div>`;
  }).join('')}</div></div>`;
}

/** @param {string} token @param {string[]} rest path segments below the share root */
export async function renderPubShare(token, rest) {
  ensureCss();
  const app = qs('#app');
  const parent = rest && rest.length ? rest[rest.length - 1] : '';
  app.innerHTML = `<div class="pub-wrap"><div class="drv-loading" style="margin:60px auto"><div class="drv-spin"></div><span>${esc(t('loading'))}</span></div></div>`;

  let head;
  let data;
  try {
    head = await api(`/api/pub/${encodeURIComponent(token)}`);
    data = await api(`/api/pub/${encodeURIComponent(token)}/list${parent ? '?parent=' + encodeURIComponent(parent) : ''}`);
  } catch (e) {
    app.innerHTML = `
      <div class="pub-wrap"><div class="pub-card">
        <div class="drv-empty">${icon('link', 48)}<div>${esc(tErr(e && e.message))}</div></div>
      </div></div>`;
    return;
  }
  applyShareLook(head);

  const crumbs = [`<span class="drv-crumb" data-go="">${esc(t('drv_share_root'))}</span>`]
    .concat((data.path || []).map((p, i, arr) => `
      <span class="drv-crumb-sep">${icon('next', 14)}</span>
      <span class="drv-crumb ${i === arr.length - 1 ? 'here' : ''}" data-go="${esc(p.id)}">${esc(p.name)}</span>`))
    .join('');

  const nodes = data.nodes || [];
  const meta = [
    t('drv_share_readonly_note'),
    head.expires_at ? t('drv_share_until', fmtDate(head.expires_at)) : '',
    // Present only where an administrator turned the disclosure on; the server decides, and
    // sends an empty string otherwise, so there is nothing here to leak by accident.
    // 只有管理员开启披露时才有值;由服务端决定,否则回空串,此处不会有可意外泄露的东西。
    head.owner_email ? t('drv_share_by', head.owner_email) : '',
  ].filter(Boolean);

  app.innerHTML = `
    <div class="pub-wrap">
      <div class="pub-head">
        ${brandHtml()}
        <div class="pub-meta drv-dim">${meta.map(esc).join(' · ')}</div>
      </div>
      <div class="pub-card">
        <div class="pub-bar">
          <div class="drv-crumbs">${crumbs}</div>
          <wa-button class="icon" appearance="plain" id="pub-layout"
                     title="${esc(layout() === 'list' ? t('drv_view_grid') : t('drv_view_list'))}">
            ${icon(layout() === 'list' ? 'grid' : 'view-list', 20)}
          </wa-button>
        </div>
        ${head.note ? `<div class="drv-ctx">${esc(head.note)}</div>` : ''}
        ${nodes.length
          ? (layout() === 'grid' ? cardsHtml(token, nodes) : `<div class="pub-list">${rowsHtml(token, nodes)}</div>`)
          : `<div class="drv-empty">${icon('folder', 44)}<div>${esc(t('drv_empty_folder'))}</div></div>`}
      </div>
    </div>`;

  qs('#pub-layout', app).addEventListener('click', () => {
    localStorage.setItem('cf_drive_layout', layout() === 'list' ? 'grid' : 'list');
    renderPubShare(token, rest);
  });

  qsa('.drv-crumb[data-go]', app).forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.go;
    navigate(id ? `#/p/${encodeURIComponent(token)}/${encodeURIComponent(id)}` : `#/p/${encodeURIComponent(token)}`);
  }));

  qsa('.pub-it', app).forEach((row) => row.addEventListener('click', (e) => {
    if (e.target.closest('.dl')) return; // the download link handles itself / 下载链接自己处理
    const { id, kind, name, mime } = row.dataset;
    if (kind === 'folder') return navigate(`#/p/${encodeURIComponent(token)}/${encodeURIComponent(id)}`);
    openPubPreview(token, { id, name, mime });
  }));
}

const IMG_RE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/;
const VID_RE = /^video\/(mp4|webm|ogg|quicktime)$/;

/** A deliberately small preview: images, media and PDF inline, everything else downloads.
 *  The rich in-page renderers live behind the signed-in bundle and stay there.
 *  刻意做小的预览:图片、音视频与 PDF 内嵌显示,其余一律下载。
 *  富渲染器属于登录后的那套包,就留在那边。 */
function openPubPreview(token, n) {
  const src = dlUrl(token, n.id, true);
  const mime = (n.mime || '').toLowerCase();
  let body;
  if (IMG_RE.test(mime)) body = `<img src="${esc(src)}" alt="">`;
  else if (VID_RE.test(mime)) body = `<video controls autoplay src="${esc(src)}"></video>`;
  else if (mime.startsWith('audio/')) body = `<audio controls autoplay src="${esc(src)}"></audio>`;
  else if (mime === 'application/pdf') body = `<iframe src="${esc(src)}" title="${esc(n.name)}"></iframe>`;
  else {
    window.location.href = dlUrl(token, n.id, false);
    return;
  }
  const el = document.createElement('div');
  el.className = 'drv-view';
  el.innerHTML = `
    <div class="drv-view-head">
      <wa-button class="icon" appearance="plain" data-close aria-label="${esc(t('close'))}">${icon('close', 20)}</wa-button>
      ${fileIcon(n.name, 20)}<span class="nm">${esc(n.name)}</span>
      <a class="drv-pub-dl" href="${esc(dlUrl(token, n.id, false))}" download>${icon('download', 20)}</a>
    </div>
    <div class="drv-view-body">${body}</div>`;
  document.body.appendChild(el);
  const close = () => {
    el.querySelectorAll('video,audio').forEach((m) => { try { m.pause(); } catch {} m.removeAttribute('src'); });
    el.remove();
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  window.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === el.querySelector('.drv-view-body')) close();
  });
}
