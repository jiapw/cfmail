// Rich-text bodies: lazily loaded Quill, plus Delta -> mail-safe HTML / plain text
// The key rule: outgoing HTML uses inline styles only -- no classes, no <style> blocks. Receiving
// clients (Gmail, Outlook) strip stylesheets and class names, and only inline styles survive.
// 富文本正文:Quill 懒加载 + Delta → 邮件安全 HTML / 纯文本
// 关键约定:发出去的 HTML 一律用内联样式,不含 class,不含 <style> 块 —— 收件端(Gmail/Outlook)
// 会剥离样式表和类名,只有内联样式可靠。

import { t } from './i18n.js';
import { esc } from './ui.js';

let loading = null;

/** Load Quill on demand (the UMD build, which lands on window.Quill), once only
 *  按需加载 Quill(UMD,挂在 window.Quill),只加载一次 */
export function loadQuill() {
  if (window.Quill) return Promise.resolve(window.Quill);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/quill/quill.snow.css';
    // It must be inserted before our own stylesheet: at equal specificity the later sheet wins, and otherwise the snow theme swallows every theme override
    // 必须插在本站样式表之前:同特异性时后加载的胜出,否则主题覆盖全被 snow 主题吃掉
    const appCss = document.querySelector('link[href="/assets/style.css"]');
    if (appCss) appCss.parentNode.insertBefore(css, appCss);
    else document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = '/vendor/quill/quill.js';
    s.onload = () => resolve(window.Quill);
    s.onerror = () => reject(new Error('failed to load editor'));
    document.head.appendChild(s);
  });
  return loading;
}

/** The snow theme hardcodes its link-bubble text in CSS content, so the only way to change it is a rule with the same selector
 *  snow 主题的链接气泡文案写死在 CSS 的 content 里,只能用同名规则顶掉 */
export function applyEditorLabels() {
  const q = (s) => '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';
  let el = document.getElementById('ql-i18n');
  if (!el) {
    el = document.createElement('style');
    el.id = 'ql-i18n';
    document.head.appendChild(el); // 放在最后,稳压 quill.snow.css
  }
  const size = (v, key) =>
    `.ql-snow .ql-picker.ql-size .ql-picker-label[data-value=${v}]::before,` +
    `.ql-snow .ql-picker.ql-size .ql-picker-item[data-value=${v}]::before{content:${q(t(key))}}`;
  el.textContent =
    `.ql-snow .ql-tooltip::before{content:${q(t('link_visit'))}}` +
    `.ql-snow .ql-tooltip[data-mode=link]::before{content:${q(t('link_enter'))}}` +
    `.ql-snow .ql-tooltip a.ql-action::after{content:${q(t('link_edit'))}}` +
    `.ql-snow .ql-tooltip.ql-editing a.ql-action::after{content:${q(t('link_save'))}}` +
    `.ql-snow .ql-tooltip a.ql-remove::before{content:${q(t('link_remove'))}}` +
    // The size dropdown: its unselected state has no data-value, so it needs its own rule
    // 字号下拉:未选中态没有 data-value,单独写
    `.ql-snow .ql-picker.ql-size .ql-picker-label::before,` +
    `.ql-snow .ql-picker.ql-size .ql-picker-item::before{content:${q(t('sz_normal'))}}` +
    size('small', 'sz_small') + size('large', 'sz_large') + size('huge', 'sz_huge');
}


// Root style for the mail body: give the font a complete fallback stack, since the recipient does not have our web fonts
// 邮件正文根样式:字体给出完整回退栈(收件端没有我们的 Web 字体)
const ROOT_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;" +
  'font-size:14px;line-height:1.6;color:#1f1f1f';
const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex';
const HEADER_SIZE = { 1: '1.6em', 2: '1.35em', 3: '1.15em' };

/** Inline attributes -> nested tags
 *  行内属性 → 嵌套标签 */
function inlineHtml(text, attr = {}) {
  let out = esc(text).replace(/\n/g, '');
  if (!out) return '';
  const styles = [];
  if (attr.color) styles.push(`color:${cssColor(attr.color)}`);
  if (attr.background) styles.push(`background-color:${cssColor(attr.background)}`);
  if (attr.size === 'small') styles.push('font-size:0.85em');
  if (attr.size === 'large') styles.push('font-size:1.25em');
  if (attr.size === 'huge') styles.push('font-size:1.6em');
  if (styles.length) out = `<span style="${styles.join(';')}">${out}</span>`;
  if (attr.code) out = `<code style="font-family:ui-monospace,Consolas,monospace;background:#f1f1f1;padding:0 3px;border-radius:3px">${out}</code>`;
  if (attr.bold) out = `<b>${out}</b>`;
  if (attr.italic) out = `<i>${out}</i>`;
  if (attr.underline) out = `<u>${out}</u>`;
  if (attr.strike) out = `<s>${out}</s>`;
  if (attr.link) {
    const href = safeUrl(attr.link);
    if (href) out = `<a href="${esc(href)}" style="color:#0b57d0" target="_blank" rel="noopener">${out}</a>`;
  }
  return out;
}

/** Allow http, https and mailto only, shutting out things like javascript:
 *  只允许 http/https/mailto,杜绝 javascript: 之类 */
function safeUrl(u) {
  const s = String(u || '').trim();
  return /^(https?:|mailto:)/i.test(s) ? s : /^[\w.-]+@[\w.-]+$/.test(s) ? 'mailto:' + s : '';
}
function cssColor(c) {
  const s = String(c || '').trim();
  return /^(#[0-9a-f]{3,8}|rgb\([\d\s,.%]+\)|rgba\([\d\s,.%]+\)|[a-z]+)$/i.test(s) ? s : 'inherit';
}

/** Cut a Delta into "lines": each is { parts:[{text,attr}|{image}], attrs: line attributes }
 *  把 Delta 切成"行":每行是 { parts:[{text,attr}|{image}], attrs: 行属性 } */
function deltaToLines(delta) {
  const lines = [];
  let cur = { parts: [], attrs: {} };
  for (const op of delta.ops || []) {
    if (typeof op.insert === 'string') {
      const chunks = op.insert.split('\n');
      chunks.forEach((chunk, i) => {
        if (chunk) cur.parts.push({ text: chunk, attr: op.attributes || {} });
        if (i < chunks.length - 1) {
          cur.attrs = op.attributes || {}; // 换行符上的属性描述整行
          lines.push(cur);
          cur = { parts: [], attrs: {} };
        }
      });
    } else if (op.insert && op.insert.image) {
      cur.parts.push({ image: op.insert.image, attr: op.attributes || {} });
    }
  }
  if (cur.parts.length) lines.push(cur);
  return lines;
}

/**
 * Delta -> mail HTML.
 * @param resolveImage (src, attrs) => string|null  turns an editor image URL into cid:xxx; returning null drops the image
 * Delta → 邮件 HTML。
 * @param resolveImage (src, attrs) => string|null  把编辑器里的图片地址换成 cid:xxx;返回 null 则丢弃该图
 */
export function deltaToEmailHtml(delta, resolveImage = (s) => s) {
  const lines = deltaToLines(delta);
  const out = [];
  let listType = null; // 'ul' | 'ol'

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    const a = line.attrs || {};
    let inner = line.parts
      .map((p) => {
        if (p.image) {
          const src = resolveImage(p.image, p.attr);
          if (!src) return '';
          // width goes in as an HTML attribute because that is all Outlook honours; the style repeats the proportional scaling as a backup
          // width 用 HTML 属性给,Outlook 只认这个;style 里再兜一遍等比缩放
          const w = parseInt(p.attr?.width, 10);
          const wAttr = w > 0 ? ` width="${w}"` : '';
          return `<img src="${esc(src)}"${wAttr} style="max-width:100%;height:auto" alt="">`;
        }
        return inlineHtml(p.text, p.attr);
      })
      .join('');

    const align = a.align && a.align !== 'left' ? `text-align:${a.align}` : '';

    if (a.list) {
      const want = a.list === 'ordered' ? 'ol' : 'ul';
      if (listType !== want) { closeList(); out.push(`<${want} style="margin:0 0 0 1.2em;padding:0">`); listType = want; }
      out.push(`<li${align ? ` style="${align}"` : ''}>${inner || '<br>'}</li>`);
      continue;
    }
    closeList();

    if (a['code-block']) {
      out.push(`<pre style="font-family:ui-monospace,Consolas,monospace;background:#f6f8fa;padding:10px;border-radius:6px;white-space:pre-wrap;margin:6px 0">${inner || ''}</pre>`);
      continue;
    }
    if (a.blockquote) {
      out.push(`<blockquote style="${QUOTE_STYLE}">${inner || '<br>'}</blockquote>`);
      continue;
    }
    if (a.header && HEADER_SIZE[a.header]) {
      out.push(`<div style="font-size:${HEADER_SIZE[a.header]};font-weight:bold;margin:8px 0 4px${align ? ';' + align : ''}">${inner || '<br>'}</div>`);
      continue;
    }
    out.push(`<div${align ? ` style="${align}"` : ''}>${inner || '<br>'}</div>`);
  }
  closeList();

  return `<div dir="ltr" style="${ROOT_STYLE}">${out.join('') || '<div><br></div>'}</div>`;
}

/** Delta -> plain-text fallback (list markers and link targets preserved)
 *  Delta → 纯文本兜底(保留列表符号与链接地址) */
export function deltaToPlainText(delta) {
  const lines = deltaToLines(delta);
  let n = 0;
  return lines
    .map((line) => {
      const a = line.attrs || {};
      let s = line.parts
        .map((p) => {
          if (p.image) return '[图片]';
          const t = p.text;
          const link = p.attr?.link ? safeUrl(p.attr.link) : '';
          return link && link !== t ? `${t} (${link})` : t;
        })
        .join('');
      if (a.list === 'ordered') { n += 1; s = `${n}. ${s}`; } else { n = 0; }
      if (a.list === 'bullet') s = `• ${s}`;
      if (a.blockquote) s = `> ${s}`;
      return s;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Reply quoting: follow Gmail's structure, which other clients recognise and collapse
 *  回复引用:沿用 Gmail 的结构,便于各家客户端识别并折叠 */
export function buildQuoteHtml(attribution, originalHtml) {
  const attr = esc(attribution).replace(/\n/g, '<br>');
  return (
    `<br><div class="gmail_quote">` +
    `<div dir="ltr" class="gmail_attr">${attr}<br></div>` +
    `<blockquote class="gmail_quote" style="${QUOTE_STYLE}">${originalHtml || ''}</blockquote>` +
    `</div>`
  );
}

/** HTML -> plain text; when the original had only text/html, this produces the plain-text half of the quote
 *  HTML → 纯文本;原邮件只有 text/html 时,用它凑出纯文本那一份引用 */
export function htmlToPlainText(html) {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    doc.querySelectorAll('script,style,head').forEach((el) => el.remove());
    doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
    doc.querySelectorAll('p,div,li,tr,blockquote,h1,h2,h3,h4,h5,pre').forEach((el) => el.append('\n'));
    return (doc.body.textContent || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return '';
  }
}

/**
 * Clean the original HTML before pulling it into a reply:
 * strip scripts, stylesheets and event attributes, restore the images that were blocked, and drop
 * image links pointing back at us (those are the proxy URLs we generate for cid, which the recipient
 * cannot open).
 * 清洗要带进回复里的原文 HTML:
 * 去掉脚本/样式表/事件属性,还原被拦下的远程图,丢掉指向本站的内部图片链接
 * (那是我们给 cid 生成的代理地址,收件人打不开)。
 */
export function sanitizeQuoteHtml(html) {
  if (!html) return '';
  let doc;
  try {
    doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  } catch {
    return '';
  }
  doc.querySelectorAll('script,style,link,meta,base,iframe,object,embed').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((a) => {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    });
  });
  doc.querySelectorAll('img[data-blocked-src]').forEach((el) => {
    el.setAttribute('src', el.getAttribute('data-blocked-src'));
    el.removeAttribute('data-blocked-src');
  });
  doc.querySelectorAll('img').forEach((el) => {
    const src = el.getAttribute('src') || '';
    if (!/^https?:/i.test(src)) el.remove(); // 相对地址/内部代理,对收件人无意义
  });
  return doc.body.innerHTML;
}

/** Downsample large images in the browser first, so base64 inflation cannot push the message past the send limit
 *  大图先在客户端降采样,避免 base64 膨胀后超出发信上限 */
export async function downscaleImage(file, maxEdge = 1600, quality = 0.85) {
  if (!/^image\//.test(file.type) || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  try {
    const bmp = await createImageBitmap(file);
    if (bmp.width <= maxEdge && bmp.height <= maxEdge && file.size < 400 * 1024) return file;
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((res) => cv.toBlob(res, type, quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, type === 'image/png' ? '.png' : '.jpg'), { type });
  } catch {
    return file;
  }
}
