import { api } from './api.js';
import { esc, icon, qs, qsa, toast, avatar } from './ui.js';
import { t, setLang, lang } from './i18n.js';
import { renderList, renderThread, renderContacts } from './mail.js';
import { openCompose } from './compose.js';
import { renderLogin, renderSetup, renderInvite, renderSettings, renderNoMailbox, renderForgot, renderReset } from './auth.js';
import { renderAdmin } from './admin.js';
import { ensureFont, fontStack } from './fontpicker.js';

export const store = {
  me: null,
  brand: null, // { name, logo_url, version }
  mbId: null,
  folder: 'inbox',
  q: '',
  folders: null,
  sidebarHidden: false,
  routeKey: '',
};

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/** Page title: with a brand name it reads "Company - CFMail"
 *  标题:有品牌名时显示「公司名 - CFMail」 */
export function pageTitle() {
  const n = store.brand?.name;
  return n ? `${n} - CFMail` : 'CFMail';
}

// ---------- Theme and appearance ----------
// ---------- 主题与外观 ----------

export function applyTheme(theme) {
  const h = document.documentElement;
  h.dataset.theme = theme || 'blue';
  localStorage.setItem('cfmail_theme', h.dataset.theme);
  // The panel colour changed, so already-open message bodies need their background realigned
  // 面板色变了,已打开的邮件正文底色需要重新对齐
  window.dispatchEvent(new CustomEvent('cfmail:mode'));
}

const darkMedia = matchMedia('(prefers-color-scheme: dark)');
export function currentMode() {
  return localStorage.getItem('cfmail_mode') || 'auto';
}
export function applyMode(mode) {
  localStorage.setItem('cfmail_mode', mode);
  const dark = mode === 'dark' || (mode === 'auto' && darkMedia.matches);
  const h = document.documentElement;
  h.classList.toggle('wa-dark', dark);
  h.classList.toggle('wa-light', !dark);
  window.dispatchEvent(new CustomEvent('cfmail:mode', { detail: { dark } }));
}
darkMedia.addEventListener('change', () => {
  if (currentMode() === 'auto') applyMode('auto');
});

/** Apply all three fonts: the brand name (per domain), the interface and the body (per user)
 *  应用三种字体:品牌名(按域名)、界面与正文(按用户) */
export function applyFonts() {
  const h = document.documentElement;
  const brand = store.brand?.font || '';
  const ui = store.me?.user?.ui_font || '';
  const body = store.me?.user?.body_font || '';
  [brand, ui, body].forEach((f) => f && ensureFont(f));
  h.style.setProperty('--font-brand', fontStack(brand));
  h.style.setProperty('--font-ui', fontStack(ui));
  h.style.setProperty('--font-body', fontStack(body));
  // Web Awesome components follow the interface font too
  // Web Awesome 组件内部也跟随界面字体
  h.style.setProperty('--wa-font-family-body', fontStack(ui));
  window.dispatchEvent(new CustomEvent('cfmail:fonts'));
}

export async function loadBrand() {
  try {
    store.brand = await api('GET', '/api/brand');
  } catch {
    store.brand = { name: null, logo_url: null, theme: null, version: '' };
  }
  document.title = pageTitle();
  applyTheme(store.brand?.theme || 'blue');
  applyFonts();
  // With a brand logo present, swap the favicon to match
  // 品牌 logo 存在时,同步替换 favicon
  const fav = document.querySelector('link[rel="icon"]');
  if (fav && store.brand?.logo_url) fav.href = store.brand.logo_url;
}

export async function refreshMe() {
  try {
    store.me = await api('GET', '/api/me');
    const ul = store.me?.user?.lang;
    if (ul && ul !== lang()) setLang(ul);
    const ap = store.me?.user?.appearance;
    if (ap && ap !== currentMode()) applyMode(ap);
    applyFonts();
  } catch {
    store.me = null;
  }
  return store.me;
}

export function currentMailbox() {
  return store.me?.mailboxes.find((m) => m.id === store.mbId) || null;
}

export const FOLDERS = [
  { key: 'inbox', icon: 'inbox' },
  { key: 'starred', icon: 'star' },
  { key: 'sent', icon: 'send' },
  { key: 'drafts', icon: 'draft' },
  { key: 'spam', icon: 'spam' },
  { key: 'trash', icon: 'trash' },
  { key: 'archive', icon: 'archive' },
];
export const folderName = (key) => t(`f_${key}`);

export function show(html) {
  qs('#app').innerHTML = html;
}

// ---------- Main frame (top bar + sidebar) ----------
// ---------- 主框架(顶栏 + 侧栏) ----------

export async function loadFolders() {
  if (!store.mbId) return null;
  try {
    store.folders = await api('GET', `/api/mailboxes/${store.mbId}/folders`);
  } catch {
    store.folders = null;
  }
  return store.folders;
}

function folderBadge(key) {
  const f = store.folders;
  if (!f) return '';
  let n = 0;
  if (key === 'drafts') n = f.drafts_count;
  else if (key === 'starred') n = 0;
  else {
    const row = (f.folders || []).find((x) => x.role === key);
    if (key === 'inbox' || key === 'spam') n = row?.unread || 0;
  }
  return n > 0 ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '';
}

function brandLogoHtml(size = 26) {
  if (store.brand?.logo_url) {
    // Fix the height and let the width follow the original aspect ratio, capped when very wide so it cannot squeeze the search box
    // 限定高度,宽度按原图比例自适应(过宽时封顶,避免挤压搜索框)
    return `<img class="brand-logo" data-logo-mode="${esc(store.brand.logo_mode || 'light')}" style="height:${size}px" src="${esc(store.brand.logo_url)}" alt="">`;
  }
  return icon('mail', size);
}

export function renderShell(contentHtml) {
  const me = store.me;
  const canAdmin = me.user.is_admin || (me.domain_admin_of || []).length > 0;
  const brandName = store.brand?.name || 'CFMail';
  const contactsItem = `
    <a class="side-item ${store.folder === 'contacts' ? 'active' : ''}" href="#/mb/${store.mbId}/contacts">
      ${icon('person', 20)}<span class="side-name">${esc(t('f_contacts'))}</span>
    </a>`;
  // Contacts sit right after the inbox
  // 通讯录紧跟在收件箱之后
  const sideFolders = FOLDERS.map(
    (f) => `
    <a class="side-item ${store.folder === f.key && !store.q ? 'active' : ''}" href="#/mb/${store.mbId}/${f.key}">
      ${icon(f.icon, 20)}<span class="side-name">${esc(folderName(f.key))}</span>${folderBadge(f.key)}
    </a>` + (f.key === 'inbox' ? contactsItem : '')
  ).join('');
  const accounts = me.mailboxes
    .map(
      (m) => `
    <a class="side-item acct ${m.id === store.mbId ? 'active' : ''}" href="#/mb/${m.id}/inbox" title="${esc(m.address)}">
      ${avatar(m.display_name || m.address, 24)}
      <span class="side-name">${esc(m.address)}</span>
      ${m.unread > 0 ? `<span class="badge">${m.unread > 99 ? '99+' : m.unread}</span>` : ''}
    </a>`
    )
    .join('');

  return `
  <div class="shell">
    <header class="topbar">
      <wa-button class="icon" appearance="plain" id="btn-menu" aria-label="${esc(t('toggle_sidebar'))}">${icon('menu', 22)}</wa-button>
      <a class="logo" href="#/">${brandLogoHtml(26)}<span>${esc(brandName)}</span></a>
      <form class="searchbar" id="search-form">
        ${icon('search', 20)}
        <input id="search-input" type="text" placeholder="${esc(t('search_ph'))}" value="${esc(store.q || '')}" autocomplete="off">
      </form>
      <div class="topbar-right">
        ${me.send_enabled ? '' : `<span class="chip chip-warn" title="${esc(t('no_channel_tip'))}">${esc(t('no_channel_chip'))}</span>`}
        ${me.drive_enabled ? `<wa-button class="icon" appearance="plain" href="#/drive" aria-label="${esc(t('drv_title'))}" title="${esc(t('drv_title'))}">${icon('cloud', 20)}</wa-button>` : ''}
        ${me.chat_enabled ? `<wa-button class="icon" appearance="plain" href="#/chat" aria-label="${esc(t('c_title'))}" title="${esc(t('c_title'))}">${icon('sparkle', 20)}</wa-button>` : ''}
        ${canAdmin ? `<wa-button class="icon" appearance="plain" href="#/admin" aria-label="${esc(t('admin'))}">${icon('shield', 20)}</wa-button>` : ''}
        <wa-button class="icon" appearance="plain" href="#/settings" aria-label="${esc(t('settings'))}">${icon('gear', 20)}</wa-button>
        <wa-dropdown id="user-dd" placement="bottom-end">
          <wa-button slot="trigger" class="icon" appearance="plain" aria-label="${esc(me.user.email)}">${avatar(me.user.name || me.user.email, 32)}</wa-button>
          <div class="um-head">
            ${avatar(me.user.name || me.user.email, 40)}
            <div><div class="um-name">${esc(me.user.name)}</div><div class="um-mail">${esc(me.user.email)}</div></div>
          </div>
          <wa-dropdown-item value="settings">${icon('gear', 18)} ${esc(t('settings'))}</wa-dropdown-item>
          ${canAdmin ? `<wa-dropdown-item value="admin">${icon('shield', 18)} ${esc(t('admin'))}</wa-dropdown-item>` : ''}
          <wa-dropdown-item value="logout">${icon('logout', 18)} ${esc(t('logout'))}</wa-dropdown-item>
          <div class="um-version">${store.brand?.name ? 'Powered by ' : ''}CFMail v${esc(store.brand?.version || '')}</div>
        </wa-dropdown>
      </div>
    </header>
    <div class="body">
      <nav class="sidebar ${store.sidebarHidden ? 'hidden' : ''}">
        <wa-button class="compose-btn" id="btn-compose">${icon('pencil', 20)}<span>${esc(t('compose'))}</span></wa-button>
        <div class="side-group">${sideFolders}</div>
        <div class="side-sep"></div>
        <div class="side-title">${esc(t('mail_accounts'))}</div>
        <div class="side-group">${accounts}</div>
      </nav>
      <main class="content" id="content">${contentHtml}</main>
    </div>
  </div>`;
}

export function bindShell() {
  qs('#btn-menu')?.addEventListener('click', () => {
    store.sidebarHidden = !store.sidebarHidden;
    qs('.sidebar')?.classList.toggle('hidden', store.sidebarHidden);
  });
  qs('#btn-compose')?.addEventListener('click', () => openCompose({ mbId: store.mbId }));
  qs('#search-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = qs('#search-input').value.trim();
    if (v) navigate(`#/mb/${store.mbId}/search/${encodeURIComponent(v)}`);
  });
  qs('#user-dd')?.addEventListener('wa-select', async (e) => {
    const v = e.detail?.item?.value;
    if (v === 'settings') navigate('#/settings');
    else if (v === 'admin') navigate('#/admin');
    else if (v === 'logout') {
      await api('POST', '/api/auth/logout');
      store.me = null;
      navigate('#/login');
    }
  });
}

// ---------- Routing ----------
// ---------- 路由 ----------

async function route() {
  const seg = location.hash.replace(/^#\/?/, '').split('/').map((s) => decodeURIComponent(s));
  store.routeKey = location.hash;

  if (!store.brand) await loadBrand();
  if (seg[0] === 'invite' && seg[1]) return renderInvite(seg[1]);
  // The two routes that must work while signed out
  // 未登录也要能走的两条路
  if (seg[0] === 'forgot') return renderForgot();
  if (seg[0] === 'reset' && seg[1]) return renderReset(seg[1]);
  // Public share links: the recipient has no account here by definition, so this must resolve
  // before the sign-in gate below -- otherwise the link would only ever show a login form.
  // 公开分享链接:接收方按定义在此没有账号,因此必须在下面的登录门槛之前解析 ——
  // 否则这条链接永远只能显示一个登录表单。
  if (seg[0] === 'p' && seg[1]) {
    const mod = await import('./drive/pub.js?v=' + encodeURIComponent(store.brand?.version || ''));
    return mod.renderPubShare(seg[1], seg.slice(2));
  }

  if (!store.me) await refreshMe();
  if (!store.me) {
    const b = await api('GET', '/api/bootstrap').catch(() => ({ needs_setup: false }));
    if (b.needs_setup) return renderSetup();
    return renderLogin();
  }

  if (seg[0] === 'login' || seg[0] === 'setup' || seg[0] === '') {
    if (seg[0] === 'login' || seg[0] === 'setup') return navigate('#/');
    if (!store.me.mailboxes.length) await refreshMe();
    const first = store.me.mailboxes[0];
    if (first) return navigate(`#/mb/${first.id}/inbox`);
    return renderNoMailbox();
  }
  if (seg[0] === 'settings') return renderSettings();
  if (seg[0] === 'admin') return renderAdmin(seg[1] || 'overview');
  if (seg[0] === 'chat') {
    // The AI assistant is loaded on demand (never entered when the admin switch is off); the version query defeats stale browser caches of the module
    // AI 助手按需加载(后台开关未开时不进入);带版本号防浏览器缓存旧模块
    if (!store.me.chat_enabled) return navigate('#/');
    const mod = await import('./chat/chat.js?v=' + encodeURIComponent(store.brand?.version || ''));
    return mod.renderChat(seg[1] || null);
  }
  if (seg[0] === 'drive') {
    // Drive loads on demand too, gated by the per-domain switch resolved in /api/me
    // 网盘同样按需加载。开关在 /api/me 里按域名解析
    if (!store.me.drive_enabled) return navigate('#/');
    const mod = await import('./drive/drive.js?v=' + encodeURIComponent(store.brand?.version || ''));
    return mod.renderDrive(seg.slice(1));
  }

  if (seg[0] === 'mb' && seg[1]) {
    if (!store.me.mailboxes.find((m) => m.id === seg[1])) {
      const first = store.me.mailboxes[0];
      return first ? navigate(`#/mb/${first.id}/inbox`) : renderNoMailbox();
    }
    store.mbId = seg[1];
    if (seg[2] === 'thread' && seg[3]) {
      store.q = '';
      return renderThread(seg[3]);
    }
    if (seg[2] === 'search' && seg[3]) {
      store.q = seg[3];
      return renderList('search', seg[3]);
    }
    if (seg[2] === 'contacts') {
      store.q = '';
      store.folder = 'contacts';
      return renderContacts();
    }
    store.q = '';
    store.folder = FOLDERS.find((f) => f.key === seg[2]) ? seg[2] : 'inbox';
    return renderList(store.folder, '');
  }
  navigate('#/');
}

// ---------- Polling ----------
// ---------- 轮询 ----------

let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible' || !store.me) return;
    const seg = location.hash.replace(/^#\/?/, '').split('/');
    if (seg[0] !== 'mb') return;
    await refreshMe();
    if (seg[2] && seg[2] !== 'thread' && seg[2] !== 'contacts') {
      route();
    }
  }, 30000);
}

window.addEventListener('cfmail:unauthorized', () => {
  store.me = null;
  navigate('#/login');
});
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  route();
  startPolling();
});
// Stop the browser from simply opening a file dropped outside a drop zone
// 防止文件拖到非投放区时被浏览器直接打开
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

export { route };
