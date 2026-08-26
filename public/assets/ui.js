// Basic UI helpers: escaping, icons, toasts, dialogs and formatting (the component layer is Web Awesome)
// 基础 UI 工具:转义、图标、toast、对话框、格式化(控件层为 Web Awesome)
import { t, lang } from './i18n.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

// warning shares the spam glyph: the triangle with an exclamation in it is one shape doing two
// jobs, and calling it 'spam' at a risk warning would read as a filing decision.
// warning 与 spam 共用字形:那个带感叹号的三角本来就一形两用,
// 而在隐患提示处写 'spam' 会被读成一次归档判断。
const ICON_ALIAS = { starFill: 'star-fill', expandLess: 'expand-less', markRead: 'mark-read', warning: 'spam' };

/** Remaining time: minutes and seconds are enough, and the hour field only appears past an hour
 *  剩余时间:分秒够用,超过一小时才带小时位 */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

export function icon(name, size = 20) {
  const n = ICON_ALIAS[name] || name;
  return `<wa-icon name="${esc(n)}" style="font-size:${size}px" aria-hidden="true"></wa-icon>`;
}

// Attachment extension -> icon plus colour tile. Unknown extensions fall back to "the extension written inside the tile".
// 附件扩展名 → 图标 + 色块。认不出的扩展名退化成"色块里写扩展名"
const FILE_KINDS = [
  { icon: 'image', color: '#8e5cf7', ext: 'png jpg jpeg gif webp bmp svg heic heif avif tif tiff ico psd ai sketch fig xcf' },
  { icon: 'filePdf', color: '#e5484d', ext: 'pdf' },
  { icon: 'fileDoc', color: '#2e6ff2', ext: 'doc docx odt pages rtf epub' },
  { icon: 'fileSheet', color: '#12a150', ext: 'xls xlsx xlsm xltx csv tsv tab ods numbers' },
  { icon: 'fileSlides', color: '#f2820d', ext: 'ppt pptx odp key' },
  { icon: 'fileZip', color: '#a1795c', ext: 'zip rar 7z gz tar bz2 xz jar apk iso dmg' },
  { icon: 'fileAudio', color: '#d6409f', ext: 'mp3 wav flac aac m4a ogg wma' },
  { icon: 'fileVideo', color: '#0e8ca8', ext: 'mp4 mov avi mkv webm wmv flv m4v' },
  { icon: 'fileText', color: '#7a828d', ext: 'txt md log out err trace syslog rst tex' },
  { icon: 'fileCode', color: '#1f9b8f', ext: 'js mjs cjs ts mts cts jsx tsx json jsonl ndjson har html htm css scss py pyi java c h cpp go rs rb php sh bat ps1 yml yaml toml ini xml sql po pot' },
  // A certificate is a credential, not a document, and the shield says so at a glance
  // 证书是凭证而不是文档，盾牌一眼就说清了
  { icon: 'shield', color: '#5b6ee1', ext: 'pem crt cer csr der p7b pfx' },
  { icon: 'textFormat', color: '#b06a2c', ext: 'ttf otf woff woff2 eot' },
];

// Files a project keeps at its root with no extension at all. Without these the tile has
// nothing to write in it and falls back to a question mark -- on exactly the files whose names
// are the most recognisable thing about them.
// 项目根目录下那些根本没有扩展名的文件。没有这张表，
// 色块里无字可写，只能退化成一个问号 ——
// 而这恰恰发生在“名字本身就是最显眼特征”的那批文件上。
const NAME_ICONS = {
  text: 'readme license licence copying notice authors changelog changes todo install news contributing',
  code: 'makefile dockerfile rakefile gemfile procfile vagrantfile jenkinsfile cmakelists.txt .gitignore .gitattributes .editorconfig .env .npmrc .nvmrc .prettierrc .eslintrc',
};
const NAME_KIND = {};
const EXT_KIND = {};
for (const k of FILE_KINDS) for (const e of k.ext.split(' ')) EXT_KIND[e] = k;
for (const [kind, names] of Object.entries(NAME_ICONS)) {
  const k = FILE_KINDS.find((f) => f.icon === (kind === 'text' ? 'fileText' : 'fileCode'));
  for (const n of names.split(' ')) NAME_KIND[n] = k;
}

export const fileExt = (name) => (/\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();

/** One consistent rounded square: a known type gets an icon, an unknown one gets its extension written in the tile
 *  统一的圆角小正方形:认识的类型给图标,不认识的把扩展名写在色块里 */
export function fileIcon(filename, size = 20) {
  const ext = fileExt(filename);
  const base = String(filename || '').toLowerCase();
  const kind = EXT_KIND[ext] || NAME_KIND[base];
  const box = `width:${size}px;height:${size}px`;
  if (kind) {
    const label = ext ? ext.toUpperCase() : String(filename || '');
    return `<span class="fileicon" style="${box};background:${kind.color}" title="${esc(label)}">${icon(kind.icon, Math.round(size * 0.62))}</span>`;
  }
  const label = (ext || '?').toUpperCase().slice(0, 4);
  const fs = Math.round(size * (label.length >= 4 ? 0.3 : label.length === 3 ? 0.36 : 0.44));
  return `<span class="fileicon" style="${box};background:#6b7280;font-size:${fs}px" title="${esc(label)}">${esc(label)}</span>`;
}

let fallbackTimer = null;
export function toast(msg, isError = false) {
  const stack = qs('#toast-stack');
  if (stack && typeof stack.create === 'function') {
    stack.create(String(msg), {
      variant: isError ? 'danger' : 'neutral',
      duration: isError ? 6000 : 3200,
    });
    return;
  }
  // Fallback for when Web Awesome is not ready yet
  // WA 未就绪时的兜底
  let el = qs('#toast-fallback');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-fallback';
    el.className = 'toast-fallback';
    document.body.appendChild(el);
  }
  el.textContent = String(msg);
  clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(() => el.remove(), isError ? 6000 : 3200);
}

function openDialog(inner, { label = '', lightDismiss = true } = {}) {
  const d = document.createElement('wa-dialog');
  if (label) d.setAttribute('label', label);
  else d.setAttribute('without-header', '');
  if (lightDismiss) d.setAttribute('light-dismiss', '');
  d.innerHTML = inner;
  document.body.appendChild(d);
  // Use wa-hide (fires as soon as closing is requested) rather than wa-after-hide, which waits for the animation and may never fire
  // 用 wa-hide(关闭请求即触发)而非 wa-after-hide(依赖动画完成,可能不触发)
  d.addEventListener('wa-hide', (e) => {
    if (e.target !== d) return;
    setTimeout(() => d.remove(), 250);
  });
  customElements.whenDefined('wa-dialog').then(async () => {
    try { await d.updateComplete; } catch {}
    d.open = true;
  });
  return d;
}

export function confirmDialog(msg, okText) {
  return new Promise((resolve) => {
    const d = openDialog(`
      <div class="modal-body">${esc(msg)}</div>
      <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
        <wa-button appearance="plain" data-x="cancel">${esc(t('cancel'))}</wa-button>
        <wa-button variant="brand" data-x="ok">${esc(okText || t('confirm'))}</wa-button>
      </div>`);
    let result = false;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(result); } };
    d.addEventListener('click', (e) => {
      const b = e.target.closest?.('[data-x]');
      if (!b) return;
      result = b.dataset.x === 'ok';
      d.open = false;
    });
    d.addEventListener('wa-hide', (e) => {
      if (e.target === d) finish();
    });
  });
}

let currentModal = null;
export function showModal(html) {
  closeModal();
  currentModal = openDialog(html);
  return currentModal;
}
export function closeModal() {
  if (currentModal) {
    const m = currentModal;
    currentModal = null;
    if (m.open) m.open = false;
    else m.remove();
  }
}

export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const nowD = new Date();
  try {
    if (d.toDateString() === nowD.toDateString()) {
      return new Intl.DateTimeFormat(lang(), { hour: '2-digit', minute: '2-digit' }).format(d);
    }
    if (d.getFullYear() === nowD.getFullYear()) {
      return new Intl.DateTimeFormat(lang(), { month: 'short', day: 'numeric' }).format(d);
    }
    return new Intl.DateTimeFormat(lang(), { year: 'numeric', month: 'numeric', day: 'numeric' }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

export function fmtDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  try {
    return new Intl.DateTimeFormat(lang(), {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function fmtSize(n) {
  if (n == null) return '';
  if (n <= 0) return '0 B';
  if (n < 1024) return '1 KB'; // 不足 1KB 一律按 1KB 显示,不出现字节数
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n < 1024 * 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  return (n / 1024 / 1024 / 1024 / 1024).toFixed(2) + ' TB';
}

// Every ASCII punctuation character (0x21-0x2F / 0x3A-0x40 / 0x5B-0x60 / 0x7B-0x7E)
// 全部 ASCII 标点(0x21-0x2F / 0x3A-0x40 / 0x5B-0x60 / 0x7B-0x7E)
const ASCII_PUNCT = '!-\\/:-@\\[-`{-~';
const SNIP_URL_BRACKETED = new RegExp(`[([<{"']\\s*(?:https?://|www\\.)[^\\s)\\]>}"']*\\s*[)\\]>}"']`, 'gi');
const SNIP_URL_BARE = /(?:https?:\/\/|www\.)\S+/gi;
// Two or more ASCII punctuation characters in a row (spaces allowed between): separator lines, ellipses, decorations
// 两个以上连成串的 ASCII 标点(中间可夹空格):分隔线、省略号、装饰符
const SNIP_PUNCT_RUN = new RegExp(`(?:[${ASCII_PUNCT}] *){2,}`, 'g');
const SNIP_EDGE = new RegExp(`^[\\s${ASCII_PUNCT}]+|[\\s${ASCII_PUNCT}]+$`, 'g');

/**
 * Clean up a list snippet. Marketing mail usually opens with things like "View in browser ( https://... )",
 * "- - - - -" or "=====", and showing that verbatim squeezes out the real content. URLs are removed together
 * with any brackets around them, so no empty pair is left behind.
 * This is presentation-layer only -- the stored snippet keeps the original text, so historical mail looks
 * clean immediately without any backfill.
 * 列表摘要清洗。营销邮件的正文开头往往是 "在浏览器中查看 ( https://... )"、"- - - - -"、"====="
 * 这类东西,原样显示会把真正的内容挤没。URL 连同包住它的括号一起去掉,免得留下一对空括号。
 * 只做展示层清洗 —— 库里存的 snippet 保持原文,历史邮件不用回填也能立刻变干净。
 */
export function cleanSnippet(s) {
  const out = String(s || '')
    .replace(SNIP_URL_BRACKETED, ' ')
    .replace(SNIP_URL_BARE, ' ')
    .replace(SNIP_PUNCT_RUN, ' ')
    .replace(/\s+/g, ' ')
    .replace(SNIP_EDGE, '')
    .trim();
  return dropOrphanBrackets(out);
}

/** The steps above often delete half a bracket pair, and the leftover half looks like a bug; if one kind of bracket is unbalanced, drop that kind entirely
 *  上面几步常把括号删掉一半,剩下的那半看着像 bug;某一种括号左右不配对就整类去掉 */
function dropOrphanBrackets(s) {
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    const opens = s.split(open).length - 1;
    const closes = s.split(close).length - 1;
    if (opens !== closes) s = s.split(open).join('').split(close).join('');
  }
  return s.replace(/\s+/g, ' ').trim();
}

const AV_COLORS = ['#1a73e8', '#188038', '#c5221f', '#7627bb', '#e37400', '#0b8043', '#a50e0e', '#5b2b8f', '#0277bd', '#616161'];
export function avatar(nameOrAddr, size = 40) {
  const s = String(nameOrAddr || '?').trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const color = AV_COLORS[h % AV_COLORS.length];
  const ch = s[0] ? s[0].toUpperCase() : '?';
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size * 0.45)}px">${esc(ch)}</span>`;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function copyText(text) {
  return navigator.clipboard?.writeText(text).then(() => true).catch(() => fallbackCopy(text)) || Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
  return true;
}

// ---------------------------------------------------------------------------------------------
// What this browser can and cannot do
//
// Everything here is a fact about the browser the page is running in, established once at load
// and never changing afterwards -- an API either exists or it does not. Two rules govern how it
// is used, and they divide the whole product between them.
//
// A capability that has a substitute is never mentioned. The archive cache falls back to memory,
// the highlighter falls back to a wrapped span, the folder import falls back to a file input --
// in each of those the person gets what they asked for and no announcement is owed to them.
//
// A capability that has no substitute is said out loud, at the moment of asking rather than at
// the moment of loading. Nothing is hidden merely because it will not work here: a menu entry
// that quietly disappears teaches the reader that the feature does not exist, when the truth is
// that it exists and this browser cannot reach it. So the entry stays, and pressing it says
// which browser can.
//
// Note what is NOT here. Whether a pointer can hover, whether a screen is narrow -- those change
// while the page is open, when a tablet is put in a keyboard case or a window is dragged wider.
// A constant would be wrong for them and CSS answers them better anyway, so they are decided in
// the stylesheet by media query and, where JavaScript must ask, by isTouch() below, which asks
// again every time.
//
// 这个浏览器做得到什么、做不到什么。
//
// 这里的每一条都是关于"页面正跑在其中的那个浏览器"的事实,加载时确定一次,此后不再变化 ——
// 一个 API 要么在,要么不在。使用它们的规矩有两条,而这两条把整个产品一分为二。
//
// 有替代品的能力,一个字都不提。压缩包缓存退回内存、高亮退回包一层 span、目录导入退回文件输入框 ——
// 这几处里,人要的东西他都拿到了,不欠他一句通告。
//
// 没有替代品的能力,要说出来,而且是在他动手要的那一刻说,不是在加载的那一刻说。
// 不因为"在这里跑不起来"就把东西藏掉:一个悄悄消失的菜单项,教给读者的是"没有这个功能",
// 而事实是它有,只是这个浏览器够不着。所以那一项留在原处,按下去时告诉他哪个浏览器够得着。
//
// 注意这里没有什么。指针能不能悬停、屏幕窄不窄 —— 那些在页面开着的时候就会变,
// 平板被插进键盘壳、窗口被拖宽的时候。用常量表达它们是错的,而且 CSS 本来就答得更好,
// 所以它们交给样式表里的媒体查询;JavaScript 非问不可的地方,问下面的 isTouch(),它每次都重新问。
// ---------------------------------------------------------------------------------------------

export const CAP = {
  /** Writing files into a folder on the machine. Chromium desktop only -- neither Firefox nor
   *  Safari has ever shipped it, and no browser on a tablet or a phone has either.
   *  往本机目录里写文件。只有桌面 Chromium 有 —— Firefox 与 Safari 从未实现,平板和手机上也没有。 */
  dirHandle: typeof window.showDirectoryPicker === 'function',

  /** Choosing a whole folder through a file input. The attribute is honoured by every desktop
   *  browser; on a tablet it is accepted and then ignored, because the system file picker there
   *  has no way to hand over a directory. So the attribute alone is not the answer -- a pointer
   *  that cannot hover means a touch file picker, and a touch file picker means no folders.
   *  用文件输入框选整个目录。桌面浏览器都认这个属性;平板上它被接受然后被忽略,
   *  因为那里的系统文件选择器根本给不出一个目录。所以光看属性不算数 ——
   *  一个不能悬停的指针意味着触摸式选择器,而触摸式选择器给不了目录。 */
  dirPick: typeof HTMLInputElement !== 'undefined'
    && 'webkitdirectory' in HTMLInputElement.prototype
    && !matchMedia('(pointer: coarse)').matches,

  /** Handing a player the pieces of a film as they are made. Everything that changes a container
   *  in the browser goes through it. Present everywhere except on the iPhone.
   *  一边做一边把片子的碎块交给播放器。一切在浏览器里换容器的事都要经过它。除 iPhone 外处处都有。 */
  mse: typeof window.MediaSource !== 'undefined',

  /** The origin's own private disk. Reading it is widely supported; writing to it through a
   *  stream arrived later, so both halves are asked for rather than just the first.
   *  本源自己的那块私有磁盘。读它支持得很广;用流写它来得晚些,所以两半都要问,而不是只问前一半。 */
  opfsWrite: typeof navigator !== 'undefined'
    && !!navigator.storage?.getDirectory
    && typeof FileSystemFileHandle !== 'undefined'
    && typeof FileSystemFileHandle.prototype.createWritable === 'function',
};

/** Whether the pointer in use right now cannot rest on a thing without pressing it. Asked fresh
 *  every time, because a tablet answers differently the moment a trackpad is attached.
 *  此刻正在用的指针,是不是那种"不按下去就没法停在东西上"的指针。每次都重新问,
 *  因为一块触控板插上去的那一刻,平板给的答案就变了。 */
export const isTouch = () => matchMedia('(hover: none)').matches;

/**
 * Whether a menu should rise from the foot of the screen instead of opening at the point asked.
 *
 * A context menu is built around where the pointer already is: the entries appear under a cursor
 * that is a few pixels from all of them. A phone inverts every part of that -- the finger is on
 * the row, the row is anywhere on the screen, and a floating box of 32px lines next to it is a
 * target nobody hits twice. At the foot of the screen the entries are full-width, thumb-height,
 * and in the one place a thumb already rests. A tablet keeps the floating menu: the screen is
 * big enough that a sheet would mean a hand travelling further, not less.
 *
 * 一个菜单该不该从屏幕脚下升起来,而不是在被要求的那个点上打开。
 *
 * 右键菜单是围绕"指针已经在哪儿"设计的:条目出现在光标底下,距离每一条都只有几个像素。
 * 手机把这里的每一环都反了过来 —— 手指在行上,行在屏幕任何地方,
 * 而旁边浮着的一盒 32px 高的行,是没人能连续按中两次的靶子。在屏幕脚下,
 * 条目是整宽的、拇指高的,并且就在拇指本来歇着的地方。平板保留浮动菜单:
 * 屏幕大到一张动作单反而意味着手要走更远,而不是更近。
 */
export const phoneSheet = () => matchMedia('(hover: none)').matches && matchMedia('(max-width: 700px)').matches;

/**
 * Turn a positioned menu into that sheet, backdrop included.
 *
 * The caller keeps ownership of the menu and of closing it; what is borrowed here is only the
 * shape. The backdrop closes by clicking, which reaches the caller through the document-level
 * close handler every menu already has -- so there is nothing to unteach. `cleanupSheet` is
 * called from the caller's own close path and is safe to call when there is no sheet.
 *
 * 把一个定点菜单变成那张动作单,连同它的背景。
 *
 * 菜单以及"关掉它"仍归调用方所有;这里借走的只是形状。背景靠点击关闭,
 * 而这一下会经由每个菜单本来就有的 document 级关闭监听传回调用方 —— 所以没有什么要反着教的。
 * `cleanupSheet` 由调用方自己的关闭路径来调,没有动作单时调它也无妨。
 */
export function asSheet(menuEl) {
  menuEl.classList.add('menu-sheet');
  const bd = document.createElement('div');
  bd.className = 'sheet-backdrop';
  menuEl.parentElement.insertBefore(bd, menuEl);
  return true;
}
export function cleanupSheet() {
  qsa('.sheet-backdrop').forEach((el) => el.remove());
}

/** Said when somebody reaches for a capability this browser does not have and nothing else here
 *  can stand in for it. One sentence, naming a browser that can -- an apology explains nothing.
 *  当有人伸手去够一样这个浏览器没有、而这里也没有东西能替它站的能力时说的话。
 *  一句话,并且点名一个够得着的浏览器 —— 道歉什么也说明不了。 */
export function needsBrowser(msgKey = 'exp_unsupported') {
  toast(t(msgKey), true);
  return false;
}
