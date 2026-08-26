import { api } from './api.js';
import { esc, icon, qs, avatar } from './ui.js';
import { t, setLang, lang, dictReady } from './i18n.js';
import { renderList, renderThread, renderContacts } from './mail.js';
import { renderLogin, renderSetup, renderInvite, renderSettings, renderNoMailbox, renderForgot, renderReset } from './auth.js';
import { ensureFont, fontStack } from './fontpicker.js';
import { loadLabels, allLabels, labelName, labelMark, openLabelManager } from './labels.js';

export const store = {
  me: null,
  brand: null, // { name, logo_url, version }
  mbId: null,
  folder: 'inbox',
  q: '',
  folders: null,
  labels: [],
  labelId: '',          // 当前正在看哪个标签(空 = 不按标签过滤)
  // Below 900px the sidebar stops taking a column of its own and lies over the list instead. Open
  // is the right first state for a rail that costs nothing to have out, and the wrong one for a
  // sheet that covers what you came to read -- so the first state is decided by which of the two
  // it is going to be.
  // 900px 以下,侧栏不再自占一栏,而是覆盖在列表上面。
  // 对一条摆在那儿也不碍事的导轨来说,展开是对的第一状态;
  // 对一张盖住你本来要读的东西的浮层来说,那就是错的 —— 所以第一状态由它将会是哪一种来决定。
  sidebarHidden: matchMedia('(max-width: 900px)').matches,
  routeKey: '',
};

// Whether the label group under the star is folded. It is a view preference, not data, so it
// lives in this browser -- and it is remembered, because refolding it on every page load would
// undo the choice as fast as it was made.
// 星标下面那组标签是否折叠。这是视图偏好不是数据,所以只存在这个浏览器里 ——
// 而且要记住,否则每次加载都重新折叠,等于刚做的选择立刻被撤销。
const LB_OPEN_KEY = 'cf_labels_open';
export const labelsOpen = () => localStorage.getItem(LB_OPEN_KEY) !== '0';
export const setLabelsOpen = (v) => localStorage.setItem(LB_OPEN_KEY, v ? '1' : '0');

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ---------------------------------------------------------------------------------------------
// What the first paint does not pay for
//
// Two subsystems used to ride in on the first screen's module graph and neither belongs there.
// The composer brings an editor and everything for turning rich text into mail; the admin
// console brings four modules and a whole MIME parser, to serve the one person in the company
// who opens it. Both now load when reached for. The version query is the same one every dynamic
// import here carries, so a deploy is picked up rather than served stale from cache.
//
// 第一屏不为之付费的东西。
//
// 过去有两个子系统搭着首屏的模块图进来,而哪个都不属于那里。写信窗带着一个编辑器和
// 把富文本变成邮件的全套东西;管理后台带着四个模块和一整个 MIME 解析器,
// 服务的是全公司只有一个会打开它的人。现在都改为伸手要时才来。
// 版本参数与这里每个动态 import 带的是同一个,于是一次部署会被取到,而不是从缓存里端出旧的。
const fresh = (p) => import(`${p}?v=${encodeURIComponent(store.brand?.version || '')}`);

export async function openCompose(opts) {
  return (await fresh('./compose.js')).openCompose(opts);
}

/**
 * The tab's title: where you are, then whose installation this is -- "Inbox - Acme - CFMail".
 * A tab is read out of the corner of an eye, from a row of a dozen others, and the row keeps
 * getting narrower, so what changes goes first and what never changes goes last.
 *
 * 标签页标题:先是你在哪儿,再是这是谁家的 —— 「收件箱 - Acme - CFMail」。
 * 标签页是在一排十几个里面用眼角余光扫的,而那一排只会越挤越窄,
 * 所以会变的部分排在前面,不变的排在最后。
 */
export function pageTitle(where) {
  return [where, store.brand?.name, 'CFMail'].filter(Boolean).join(' - ');
}

/** Say where the page has arrived. A renderer calls this again with a better answer once it has
 *  one -- a thread's subject, a Drive path, a file name -- so the title keeps up with the page.
 *  说出页面到了哪里。渲染器一旦拿到更确切的答案(邮件主题、网盘路径、文件名)会再叫一次,
 *  于是标题跟得上页面。 */
export function setTitle(where) {
  document.title = pageTitle(where);
}

/** A path written for a tab: deeper than three names and it keeps the last three, because those
 *  are the ones that answer where you are. "…/Projects/2026/Budget"
 *  写给标签页看的路径:超过三段就只留最后三段 —— 回答"你在哪儿"的正是那几段。 */
export function pathTitle(names) {
  const clean = names.filter(Boolean);
  return (clean.length > 3 ? ['…', ...clean.slice(-3)] : clean).join('/');
}

/**
 * What an address calls itself, as far as the address alone can say. It is the title that shows
 * while the page is still fetching: instant, never wrong, and replaced the moment a renderer
 * knows better. Without it, walking into a thread would leave the previous folder's name sitting
 * in the tab for as long as the request takes.
 *
 * 仅凭地址能说出的位置名。它是页面还在取数据时挂着的那个标题:立刻就有、不会说错,
 * 等渲染器知道得更准时即被替换。没有它,点进一封邮件时,上一个文件夹的名字
 * 会在标签页上一直挂到请求回来为止。
 */
function routeTitle(seg) {
  switch (seg[0]) {
    case 'settings': return t('settings');
    case 'admin': return t('admin');
    case 'chat': return t('c_title');
    case 'drive': {
      const v = seg[1];
      if (!v || v === 'folder') return t('drv_my');
      if (v === 'search' && seg[2]) return t('search_title', seg[2]);
      if (['shared', 'recent', 'starred', 'trash', 'links', 'agents'].includes(v)) return t('drv_' + v);
      return t('a_drive');
    }
    case 'mb': {
      if (seg[2] === 'thread') return '';
      if (seg[2] === 'search' && seg[3]) return t('search_title', seg[3]);
      if (seg[2] === 'label') return t('lbl_title');
      if (seg[2] === 'contacts') return t('f_contacts');
      return folderName(FOLDERS.find((f) => f.key === seg[2]) ? seg[2] : 'inbox');
    }
    // The editors and the signed-out pages name themselves: a file the moment it opens, and a
    // sign-in screen not at all -- it is nobody's location.
    // 编辑器和未登录的页面自己报名字:文件一打开就有名字,而登录页什么都不报 ——
    // 它不是谁的"位置"。
    default: return '';
  }
}

// ---------- Theme and appearance ----------
// ---------- 主题与外观 ----------

export function applyTheme(theme) {
  const h = document.documentElement;
  h.dataset.theme = theme || 'blue';
  localStorage.setItem('cfmail_theme', h.dataset.theme);
  syncThemeColor();
  // The panel colour changed, so already-open message bodies need their background realigned
  // 面板色变了,已打开的邮件正文底色需要重新对齐
  window.dispatchEvent(new CustomEvent('cfmail:mode'));
}

/**
 * Tell the phone what colour this page is.
 *
 * A mobile browser paints the strip above and below the page -- the address bar, the gesture
 * area -- and without being told it picks white, which under a dark theme leaves two bright
 * bands framing a dark page. The value is read back from the stylesheet rather than written
 * here, so a theme is defined in exactly one place and the thirty of them stay in step; the
 * meta tag is created on first use because index.html cannot know which theme will win.
 *
 * 告诉手机这一页是什么颜色。
 *
 * 手机浏览器会给页面上下那两条 —— 地址栏、手势区 —— 上色,没人告诉它就取白色,
 * 于是深色主题下,一个深色页面被两条亮边框着。这个值是从样式表里读回来的而不是写在这里,
 * 于是一套主题只在一个地方定义,三十套才不会走散;meta 标签在第一次用到时才建,
 * 因为 index.html 无从知道最后是哪套主题胜出。
 */
function syncThemeColor() {
  // Read the painted colour off <body>, not the custom property behind it. --bg is defined as
  // var(--x-a2) and a theme swaps the layer underneath; asking for the property can hand back
  // that reference rather than a colour, while a resolved background is always rgb().
  // 从 <body> 上读那个真正画出来的颜色,而不是它背后的自定义属性。--bg 的定义是 var(--x-a2),
  // 换主题换的是底下那一层;去问那个属性,拿回来的可能是那个引用而不是一个颜色,
  // 而一个已解析的背景色永远是 rgb()。
  const c = getComputedStyle(document.body).backgroundColor;
  if (!c || c === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(c)) return;
  let m = document.querySelector('meta[name="theme-color"]');
  if (!m) {
    m = document.createElement('meta');
    m.name = 'theme-color';
    document.head.appendChild(m);
  }
  m.content = c;
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
  syncThemeColor();
  window.dispatchEvent(new CustomEvent('cfmail:mode', { detail: { dark } }));
}
darkMedia.addEventListener('change', () => {
  if (currentMode() === 'auto') applyMode('auto');
});

/** Apply every font: the brand name (per domain), and the interface, body and code fonts
 *  (per user).
 *
 *  The code font asks for the mono stack rather than the usual one, and it asks for it even when
 *  the user picked nothing -- "system default" for code means the system fixed-width face, not
 *  the system interface face.
 *  应用全部字体:品牌名(按域名),以及界面、正文与代码(按用户)。
 *
 *  代码字体取的是等宽那一套回退栈而不是通常那一套,并且即便用户什么都没选也照样取 ——
 *  对代码而言,"系统默认"指的是系统的等宽字体,不是系统的界面字体。 */
export function applyFonts() {
  const h = document.documentElement;
  const brand = store.brand?.font || '';
  const ui = store.me?.user?.ui_font || '';
  const body = store.me?.user?.body_font || '';
  const code = store.me?.user?.code_font || '';
  [brand, ui, body, code].forEach((f) => f && ensureFont(f));
  h.style.setProperty('--font-brand', fontStack(brand));
  h.style.setProperty('--font-ui', fontStack(ui));
  h.style.setProperty('--font-body', fontStack(body));
  h.style.setProperty('--font-code', fontStack(code, 'mono'));
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
  // Leave the boot screen what it needs to paint this company on the NEXT visit's first frame,
  // before any request has come back. Everything here is public branding, already served to
  // anyone who loads the page.
  // 给启动屏留下它所需之物,好在下次访问的第一帧就画出这家企业 —— 早于任何请求返回。
  // 这里的一切都是公开的品牌信息,任何加载本页的人本就能拿到。
  try {
    localStorage.setItem('cfmail_brand', JSON.stringify({
      name: store.brand?.name || '',
      logo: store.brand?.logo_url || '',
      logoMode: store.brand?.logo_mode || 'light',
      font: getComputedStyle(document.documentElement).getPropertyValue('--font-brand').trim(),
    }));
  } catch {}
  // With a brand logo present, swap the favicon to match
  // 品牌 logo 存在时,同步替换 favicon
  const fav = document.querySelector('link[rel="icon"]');
  if (fav && store.brand?.logo_url) fav.href = store.brand.logo_url;
}

/**
 * A bar across the top of every page for as long as this session belongs to somebody else. It
 * lives on <body> rather than inside a page, because forgetting whose mailbox you are reading is
 * exactly the mistake it exists to prevent -- and pages come and go.
 * 只要这个会话属于别人,每一页顶上就横着这条。它挂在 <body> 上而不是页面里:
 * 忘了自己正在读谁的邮箱,正是它要防的那个错误 —— 而页面是会来会去的。
 */
function applyImpersonationBar() {
  const who = store.me?.impersonated_by ? store.me.user.email : '';
  document.body.classList.toggle('impersonating', !!who);
  let bar = qs('#actas-bar');
  if (!who) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'actas-bar';
    bar.className = 'actas-bar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `${icon('eye', 16)}<span>${esc(t('actas_bar', who))}</span>
    <wa-button size="small" appearance="filled" id="actas-out">${esc(t('actas_leave'))}</wa-button>`;
  qs('#actas-out').addEventListener('click', async () => {
    await api('POST', '/api/auth/unimpersonate', {}).catch(() => {});
    store.me = null;
    location.hash = '#/admin/users';
    location.reload();
  });
}

export async function refreshMe() {
  try {
    store.me = await api('GET', '/api/me');
    const ul = store.me?.user?.lang;
    // The words for the account's language have to be in hand before anything is drawn with
    // them, and this runs before the first render.
    // 这个账号所选语言的那套词,必须在有人用它画东西之前就位,而这里跑在第一次渲染之前。
    if (ul && ul !== lang()) { setLang(ul); await dictReady(); }
    const ap = store.me?.user?.appearance;
    if (ap && ap !== currentMode()) applyMode(ap);
    applyFonts();
  } catch {
    store.me = null;
  }
  applyImpersonationBar();
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
  await loadLabels(store.mbId).catch(() => {});
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
  // No door to the console while the session is borrowed -- the server refuses it anyway, and
  // offering a button that only produces an error is worse than not offering it.
  // 会话是借来的时候,后台没有门 —— 服务端本来就会拒,给一个只会报错的按钮不如不给。
  const canAdmin = !me.impersonated_by && (me.user.is_admin || (me.domain_admin_of || []).length > 0);
  const brandName = store.brand?.name || 'CFMail';
  const contactsItem = `
    <a class="side-item ${store.folder === 'contacts' ? 'active' : ''}" href="#/mb/${store.mbId}/contacts">
      ${icon('person', 20)}<span class="side-name">${esc(t('f_contacts'))}</span>
    </a>`;
  // Contacts sit right after the inbox
  // 通讯录紧跟在收件箱之后
  // The star row is a group header: clicking it folds and unfolds, and nothing else. What the
  // list shows is decided by the label you click inside it, so folding never changes the view.
  // 星标那一行是分组头:点它只管开合,别的什么都不做。右侧列什么由你在里面点的标签决定,
  // 所以折叠永远不会改变当前视图。
  const open = labelsOpen();
  const labelItems = !open ? '' : allLabels()
    .map((l) => `
    <a class="side-item side-label ${store.labelId === l.id ? 'active' : ''}" href="#/mb/${store.mbId}/label/${encodeURIComponent(l.id)}">
      ${labelMark(l, 17)}<span class="side-name">${esc(labelName(l))}</span>${l.n ? `<span class="side-count">${l.n}</span>` : ''}
    </a>`)
    .join('') +
    `<a class="side-item side-label side-manage" href="#" id="lb-manage-link">${icon('gear', 16)}<span class="side-name">${esc(t('lbl_manage'))}</span></a>`;

  const sideFolders = FOLDERS.map((f) => {
    if (f.key === 'starred') {
      return `
    <div class="side-item group ${open ? 'open' : ''}" id="lb-group" role="button" tabindex="0">
      ${icon(f.icon, 20)}<span class="side-name">${esc(t('lbl_title'))}</span><span class="side-caret">${icon('next', 16)}</span>
    </div>` + labelItems;
    }
    return `
    <a class="side-item ${store.folder === f.key && !store.q ? 'active' : ''}" href="#/mb/${store.mbId}/${f.key}">
      ${icon(f.icon, 20)}<span class="side-name">${esc(folderName(f.key))}</span>${folderBadge(f.key)}
    </a>` + (f.key === 'inbox' ? contactsItem : '');
  }).join('');
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
    ${topbarHtml({
      page: 'mail',
      searchId: 'search-form',
      searchInputId: 'search-input',
      searchPh: t('search_ph'),
      searchValue: store.q || '',
    })}
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

/**
 * The bar both subsystems wear. Mail and Drive are peers, not parent and child: identical
 * skeleton, identical right-hand icons, and both are listed on both pages -- neither sits
 * "inside" the other, which is also why neither carries a back button.
 *
 * 两个子系统共用的顶栏。邮件与网盘是平级、不是父子关系:骨架相同、右侧图标相同,
 * 且两个入口在两边都列出 —— 谁都不在谁"里面",所以谁也不带返回按钮。
 *
 * @param page          'mail' | 'drive' -- decides the home link and which entry reads as current
 * @param searchId      form id, so each page can bind its own submit handler
 * @param searchInputId input id (mail's handler looks it up by name)
 * @param extra         page-specific buttons, placed first in the right-hand group
 */
export function topbarHtml({ page, searchId, searchInputId, searchPh, searchValue = '', extra = '' }) {
  const me = store.me;
  // No door to the console while the session is borrowed -- the server refuses it anyway, and
  // offering a button that only produces an error is worse than not offering it.
  // 会话是借来的时候,后台没有门 —— 服务端本来就会拒,给一个只会报错的按钮不如不给。
  const canAdmin = !me.impersonated_by && (me.user.is_admin || (me.domain_admin_of || []).length > 0);
  const brandName = store.brand?.name || 'CFMail';
  // The logo goes to this subsystem's own home, never to the other one
  // 品牌 logo 回本子系统的首页,不会跳到对方那边
  const home = page === 'drive' ? '#/drive' : '#/';
  /**
   * Both subsystems are listed on both pages, so the pair reads as one switcher rather than
   * as "you are here, and there is a way out". A plain click switches in place; because these
   * are real anchors carrying an href, the browser's own "open in new tab/window" on
   * right-click keeps working -- which is the user's call to make, not ours.
   * 两个子系统在两边都列出来,这一对看起来才像一个切换器,而不是"你在这儿,那边是出口"。
   * 左键在本页切换;因为它们是带 href 的真实链接,右键"在新标签页/窗口打开"照常可用 ——
   * 要不要新开窗口是用户自己的决定,不该由我们替他定。
   */
  const entry = (self, href, label, ic) => {
    const current = page === self;
    return `<wa-button class="icon ${current ? 'current' : ''}" appearance="plain" href="${href}"
       ${current ? 'aria-current="page"' : ''}
       aria-label="${esc(label)}" title="${esc(label)}">${icon(ic, 20)}</wa-button>`;
  };
  const cross = entry('mail', '#/', t('mail_title'), 'mail')
    + (me.drive_enabled ? entry('drive', '#/drive', t('drv_title'), 'cloud') : '');
  return `
    <header class="topbar">
      <wa-button class="icon" appearance="plain" id="btn-menu" aria-label="${esc(t('toggle_sidebar'))}">${icon('menu', 22)}</wa-button>
      <a class="logo" href="${home}">${brandLogoHtml(26)}<span>${esc(brandName)}</span></a>
      <form class="searchbar" id="${searchId}">
        ${icon('search', 20)}
        <input id="${searchInputId}" type="text" placeholder="${esc(searchPh)}" value="${esc(searchValue)}" autocomplete="off">
      </form>
      <div class="topbar-right">
        ${extra}
        ${page === 'mail' && !me.send_enabled ? `<span class="chip chip-warn" title="${esc(t('no_channel_tip'))}">${esc(t('no_channel_chip'))}</span>` : ''}
        ${cross}
        ${me.chat_enabled ? `<wa-button class="icon" appearance="plain" href="#/chat" aria-label="${esc(t('c_title'))}" title="${esc(t('c_title'))}">${icon('sparkle', 20)}</wa-button>` : ''}
        ${canAdmin ? `<wa-button class="icon nav-extra" appearance="plain" href="#/admin" aria-label="${esc(t('admin'))}" title="${esc(t('admin'))}">${icon('shield', 20)}</wa-button>` : ''}
        <wa-button class="icon nav-extra" appearance="plain" href="#/settings" aria-label="${esc(t('settings'))}" title="${esc(t('settings'))}">${icon('gear', 20)}</wa-button>
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
    </header>`;
}

/**
 * Wiring shared by both top bars: the sidebar toggle and the account menu. Each page binds its
 * own search form, since what a search means differs.
 * 两个顶栏共用的接线:侧栏开关与账号菜单。搜索表单各自绑定 —— 搜什么本来就不一样。
 */
const NARROW = '(max-width: 900px)';

/**
 * Put the sidebar where the state says, and give it a backdrop when it needs one.
 *
 * Two different objects wear the same class. Above 900px it is a column: it pushes the list
 * aside, closing it is a preference, and there is nothing to dismiss. Below, it is a sheet lying
 * over the list -- and a sheet with no way out but the one small button that opened it is a trap,
 * particularly on a screen where that button is the width of a thumb. So the backdrop exists only
 * in the second case, and it is built here rather than in a template because both shells would
 * otherwise have to carry it, and the two shells belong to different subsystems.
 *
 * 把侧栏摆到状态所说的位置,并在它需要时给它一层背景。
 *
 * 同一个类名底下是两样不同的东西。900px 以上它是一栏:它把列表推开,关掉它是一种偏好,
 * 没有什么需要被"打发走"。以下,它是一张盖在列表上的浮层 —— 而一张除了"打开它的那个小按钮"
 * 之外无路可退的浮层是个陷阱,在那个按钮只有拇指宽的屏幕上尤其如此。
 * 所以背景只在第二种情形下存在;它在这里造而不是写进模板,是因为否则两个外壳都得各带一份,
 * 而那两个外壳分属不同的子系统。
 */
function syncSidebar() {
  const sheet = qs('.sidebar');
  const rail = qs('.drv-nav');
  // The Drive's rail is not the same object. Narrow, it shrinks to a column of icons rather than
  // lying over anything, so it costs nothing to leave out and there is no reason to close it on
  // arrival. Its template draws it open every time, and that -- not a state left behind by the
  // mail page -- is what it is.
  // 网盘那条不是同一样东西。窄屏时它缩成一列图标,并不压在任何东西上面,
  // 摆着也不碍事,没有理由一进来就把它关掉。它的模板每次都画成展开的,
  // 而那才是它的状态 —— 不是邮件页留下的那个。
  if (rail && !sheet) store.sidebarHidden = rail.classList.contains('hidden');
  sheet?.classList.toggle('hidden', store.sidebarHidden);
  const wanted = !!sheet && !store.sidebarHidden && matchMedia(NARROW).matches;
  const had = qs('#side-backdrop');
  if (wanted && !had) {
    const bd = document.createElement('div');
    bd.id = 'side-backdrop';
    bd.className = 'side-backdrop';
    bd.addEventListener('click', () => setSidebar(true));
    document.body.appendChild(bd);
  } else if (!wanted && had) {
    had.remove();
  }
}

function setSidebar(hidden) {
  store.sidebarHidden = hidden;
  qs('.drv-nav')?.classList.toggle('hidden', hidden);
  syncSidebar();
}

/** Narrow, the sidebar is a sheet over the list, and every link in it leads somewhere behind
 *  itself -- so following one closes it. Wide it is a column and stays exactly where it was.
 *  窄屏时侧栏是盖在列表上的一张浮层,而它里面的每一条链接都通向它自己背后的地方 ——
 *  所以跟着一条走,就把它关上。宽屏时它是一栏,原地不动。 */
export function closeSidebarOnNavigate() {
  if (matchMedia(NARROW).matches) store.sidebarHidden = true;
}

// Dragging a window across the breakpoint turns one of those two objects into the other. The rail
// somebody closed stays closed; what changes is only whether a backdrop belongs to it now.
// 把窗口拖过这个断点,那两样东西之中的一个就变成了另一个。
// 谁关掉的导轨仍旧关着;变的只是"现在它该不该有一层背景"。
matchMedia(NARROW).addEventListener('change', syncSidebar);
export function bindTopbar() {
  qs('#btn-menu')?.addEventListener('click', () => setSidebar(!store.sidebarHidden));
  syncSidebar();
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

export function bindShell() {
  bindTopbar();
  qs('#lb-group')?.addEventListener('click', () => {
    setLabelsOpen(!labelsOpen());
    // Re-render the shell only; the list on the right is untouched, which is the whole point of
    // this control being a fold rather than a link.
    // 只重绘外壳,右侧列表原样不动 —— 这个控件是"折叠"而不是"链接",要点就在这里。
    route();
  });
  qs('#lb-manage-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    openLabelManager(() => route());
  });
  qs('#btn-compose')?.addEventListener('click', () => openCompose({ mbId: store.mbId }));
  qs('#search-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = qs('#search-input').value.trim();
    if (v) navigate(`#/mb/${store.mbId}/search/${encodeURIComponent(v)}`);
  });
}

// ---------- Routing ----------
// ---------- 路由 ----------

async function route() {
  // Nothing is drawn before the words are here. The fetch began when this module loaded, so on
  // every route after the first this is already settled and costs a microtask.
  // 词到齐之前不画任何东西。取词在本模块加载时就出发了,所以除第一次之外的每一次路由,
  // 它早已落定,代价是一个微任务。
  await dictReady();
  const seg = location.hash.replace(/^#\/?/, '').split('/').map((s) => decodeURIComponent(s));
  store.routeKey = location.hash;
  closeSidebarOnNavigate();

  if (!store.brand) await loadBrand();
  setTitle(routeTitle(seg));
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
    // A rejected request is not the only way this comes back without an answer: api() resolves
    // to null for a response that carried no JSON, which is what a request cut short by a
    // navigation looks like -- Safari finishes it as an empty 200 where Chrome rejects it. The
    // catch alone therefore leaves a null here, and reading a field off it throws before the
    // login form is ever drawn, which is a blank page rather than a failed request.
    // 拿不到答案的方式不止"请求被拒"一种:响应里没有 JSON 时 api() 解析为 null,
    // 而一个被导航打断的请求正是这个样子 —— Safari 把它收尾成一个空的 200,Chrome 则拒绝它。
    // 所以光有 catch,这里仍会留下一个 null,而从它上面取一个字段会在登录表单画出来之前抛出,
    // 那是一张白页,不是一次失败的请求。
    const b = await api('GET', '/api/bootstrap').catch(() => null);
    if (b?.needs_setup) return renderSetup();
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
  if (seg[0] === 'admin') return (await fresh('./admin.js')).renderAdmin(seg[1] || 'overview');
  if (seg[0] === 'chat') {
    // The AI assistant is loaded on demand (never entered when the admin switch is off); the version query defeats stale browser caches of the module
    // AI 助手按需加载(后台开关未开时不进入);带版本号防浏览器缓存旧模块
    if (!store.me.chat_enabled) return navigate('#/');
    const mod = await import('./chat/chat.js?v=' + encodeURIComponent(store.brand?.version || ''));
    return mod.renderChat(seg[1] || null);
  }
  // The Markdown editor is its own address rather than a state of the Drive, which is what lets
  // it be opened as a tab: a tab is a thing with a URL, and a document being edited is a thing you
  // want to be able to leave open, reload, and come back to.
  // Markdown 编辑器有自己的地址,而不是网盘的某个状态 —— 正是这一点让它能作为标签页打开:
  // 标签页是"有 URL 的东西",而一份正在编辑的文档,恰恰是你希望能一直开着、能刷新、能回来的东西。
  if (seg[0] === 'md' && seg[1]) {
    if (!store.me.drive_enabled) return navigate('#/');
    const mod = await import('./md/md.js?v=' + encodeURIComponent(store.brand?.version || ''));
    return mod.renderMdEditor(seg[1]);
  }
  // Source, configuration, data and plain text -- everything that is text and is not prose.
  // 源码、配置、数据与纯文本 —— 一切"是文本、却不是散文"的东西。
  if (seg[0] === 'code' && seg[1]) {
    if (!store.me.drive_enabled) return navigate('#/');
    const mod = await import('./code/code.js?v=' + encodeURIComponent(store.brand?.version || ''));
    return mod.renderCodeEditor(seg[1]);
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
    if (seg[2] === 'label' && seg[3]) {
      store.q = '';
      store.folder = 'starred';
      store.labelId = decodeURIComponent(seg[3]);
      return renderList('label', '');
    }
    if (seg[2] === 'contacts') {
      store.q = '';
      store.folder = 'contacts';
      return renderContacts();
    }
    store.q = '';
    store.labelId = '';
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

// Safari's page pinch travels through its own GestureEvent, which touch-action does not govern
// on every version that is still out there -- so the belt gets braces. Nothing here fires on a
// mouse, and nothing inside the page uses these events for anything else.
// Safari 的整页捏合走它自家的 GestureEvent,而市面上仍在跑的版本里,touch-action 并不都管得住它 ——
// 所以系了腰带再加背带。鼠标上这些事件根本不会响,页面里面也没有任何东西拿它们另作他用。
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  window.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

export { route };
