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
