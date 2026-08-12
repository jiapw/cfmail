import { api } from './api.js';
import { esc, icon, qs, toast, fmtSize, debounce } from './ui.js';
import { t } from './i18n.js';
import { store, refreshMe } from './app.js';
import { sendToastText, bindDropZone } from './mail.js';
import { loadQuill, applyEditorLabels, deltaToEmailHtml, deltaToPlainText, buildQuoteHtml, downscaleImage } from './richtext.js';

// Single-instance compose window
// 单实例撰写窗口
let state = null;
let quill = null;
let mountSeq = 0;

const BAR_KEY = 'cf_compose_bar'; // 小窗口下工具栏是否常驻,记住用户上次的选择
const emptyDelta = (text = '') => ({ ops: [{ insert: (text || '') + '\n' }] });

// Formats the editor supports and the serialiser can reproduce faithfully; everything else (fonts, image dimensions and so on) is refused
// 编辑器支持、且序列化器能忠实还原的格式;其余(字体、图片尺寸等)一律不接受
const FORMATS = ['bold', 'italic', 'underline', 'strike', 'link', 'code', 'color', 'background',
  'size', 'header', 'list', 'blockquote', 'code-block', 'align', 'image', 'width'];

// Types treated as inline images when dropped into the body. Quill's uploader matches with includes,
// so the list has to be explicit; anything not on it bubbles out to the outer handler and is collected
// as a normal attachment, never lost.
// 拖进正文时按内联图处理的类型。Quill 的 uploader 用 includes 精确匹配,只能枚举;
// 不在表里的文件会照常冒泡到外层,被收成普通附件,不会丢。
const INLINE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/bmp', 'image/svg+xml', 'image/avif', 'image/heic', 'image/heif', 'image/tiff'];

// Scale steps for inline images: sending genuinely resamples at this ratio, it is not just a display width
// 内联图片的缩放档位:发送时按这个比例真正重采样,不是只改显示宽度
const IMG_SCALES = [1, 0.75, 0.5, 0.25];
// Automatic step on insert: get the resampled pixel count as close to this as possible
// 插入时自动选档:让重采样后的像素总数最接近这个值
const TARGET_PIXELS = 200000;

/** Pick the step from the table whose w*h*s^2 lands nearest TARGET_PIXELS
 *  从档位表里挑一个,使 w*h*s² 最接近 TARGET_PIXELS */
function bestScale(w, h) {
  if (!w || !h) return 1;
  const px = w * h;
  let best = 1, bestDiff = Infinity;
  for (const s of IMG_SCALES) {
    const d = Math.abs(px * s * s - TARGET_PIXELS);
    if (d < bestDiff) { bestDiff = d; best = s; }
  }
  return best;
}
const SCALE_ICON = { 1: 'scale100', 0.75: 'scale75', 0.5: 'scale50', 0.25: 'scale25' };
const MIN_RESIZABLE = 256; // 长宽都不超过这个尺寸的图不给缩放档位

export function openCompose(opts = {}) {
  bakeCache.clear(); // 上一封的重采样产物已随发送清理,别带进这一封
  bakedUploads.clear();
  state = {
    mbId: opts.mbId || store.mbId || store.me?.mailboxes[0]?.id,
    draftId: opts.draftId || null,
    to: opts.to || '',
    cc: opts.cc || '',
    bcc: opts.bcc || '',
    subject: opts.subject || '',
    text: opts.text || '',
    delta: opts.delta || emptyDelta(opts.text),
    inline: (opts.inline || []).slice(),
    quote: opts.quote || null,
    quoteOpen: false,
    reply_to_message_id: opts.reply_to_message_id || null,
    atts: opts.atts
      ? opts.atts.map((a) => ({ ...a, done: true }))
      : (opts.attachment_ids || []).map((id) => ({ id, filename: '📎', size: 0, done: true })),
    showCc: !!(opts.cc || opts.bcc),
    minimized: false,
    maximized: false,
    rich: true,
    showBar: localStorage.getItem(BAR_KEY) === '1',
    dirty: false,
    sending: false,
  };
  render();
}

function close(save = true) {
  if (save && state && state.dirty) saveDraft(true);
  state = null;
  quill = null;
  mountSeq++;
  qs('#compose-root').innerHTML = '';
}

const autoSave = debounce(() => saveDraft(false), 2500);

async function saveDraft(notify) {
  if (!state) return;
  const payload = collect();
  try {
    const r = await api('POST', `/api/mailboxes/${state.mbId}/drafts`, { id: state.draftId, payload });
    state.draftId = r.id;
    state.dirty = false;
    const el = qs('#compose-status');
    if (el) el.textContent = t('t_draft_status');
    if (notify) toast(t('t_draft_saved'));
  } catch (e) {
    if (notify) toast(t('t_draft_fail', e.message), true);
  }
}

function collect() {
  const delta = quill ? quill.getContents() : state.delta;
  return {
    to: qs('#cp-to')?.value ?? state.to,
    cc: qs('#cp-cc')?.value ?? state.cc,
    bcc: qs('#cp-bcc')?.value ?? state.bcc,
    subject: qs('#cp-subject')?.value ?? state.subject,
    text: quill ? deltaToPlainText(delta) : qs('#cp-text')?.value ?? state.text,
    delta,
    inline: state.inline,
    quote: state.quote,
    attachment_ids: state.atts.filter((a) => a.done).map((a) => a.id),
    reply_to_message_id: state.reply_to_message_id,
  };
}

// ---------- Rendering ----------
// ---------- 渲染 ----------

function attChipsHtml() {
  return state.atts
    .map(
      (a, i) => `
    <span class="att-chip ${a.done ? '' : 'uploading'}">
      ${icon('attach', 14)}<span class="att-name">${esc(a.filename)}</span>
      <span class="att-size">${a.done ? fmtSize(a.size) : esc(t('uploading'))}</span>
      <button class="att-x" data-i="${i}" title="${esc(t('remove'))}">${icon('close', 14)}</button>
    </span>`
    )
    .join('');
}

/** Refresh only the attachment strip -- rebuilding the whole window would take the editor and the caret with it
 *  只刷新附件区,避免整窗重建把编辑器和光标一起冲掉 */
function renderAtts() {
  const box = qs('#cp-atts');
  if (!box) return;
  box.innerHTML = attChipsHtml();
  box.hidden = state.atts.length === 0;
}

function toolbarHtml() {
  const g = (inner) => `<span class="ql-formats">${inner}</span>`;
  // An empty val must still emit value="", which is how Quill tells "align left" apart from "toggle off"
  // val 传空串也要输出 value="",Quill 靠它区分"左对齐"和"切换开关"
  const b = (cls, key, val) =>
    `<button class="${cls}"${val === undefined ? '' : ` value="${val}"`} title="${esc(t(key))}"></button>`;
  return (
    g(b('ql-bold', 'tt_bold') + b('ql-italic', 'tt_italic') + b('ql-underline', 'tt_underline') + b('ql-strike', 'tt_strike')) +
    g('<select class="ql-size"><option selected></option><option value="small"></option><option value="large"></option><option value="huge"></option></select>') +
    g('<select class="ql-color"></select><select class="ql-background"></select>') +
    g(b('ql-list', 'tt_ol', 'ordered') + b('ql-list', 'tt_ul', 'bullet') + b('ql-blockquote', 'tt_quote') + b('ql-code-block', 'tt_code')) +
    g(b('ql-align', 'tt_align_left', '') + b('ql-align', 'tt_align_center', 'center') + b('ql-align', 'tt_align_right', 'right')) +
    g(b('ql-link', 'tt_link') + b('ql-image', 'tt_image') + b('ql-clean', 'tt_clean'))
  );
}

/** Quill replaces the select with its own picker and the original title is lost, so put it back after initialisation
 *  下拉框会被 Quill 换成自绘的 picker,原来的 title 丢了,初始化后补回去 */
function applyPickerTitles() {
  const bar = qs('#cp-toolbar');
  if (!bar) return;
  [['.ql-size', 'tt_size'], ['.ql-color', 'tt_color'], ['.ql-background', 'tt_bg']].forEach(([sel, key]) => {
    const el = bar.querySelector(`${sel}.ql-picker`);
    if (el) el.title = t(key);
  });
}

function quoteHtmlBlock() {
  if (!state.quote) return '';
  return `
    <div class="cp-quote ${state.quoteOpen ? 'open' : ''}" id="cp-quote">
      <div class="cp-quote-bar">
        <button class="cp-quote-toggle" id="cp-quote-toggle" title="${esc(t('quote_toggle'))}">···</button>
        <span class="cp-quote-label">${esc(t('quote_included'))}</span>
        <button class="cp-quote-x" id="cp-quote-x" title="${esc(t('quote_remove'))}">${icon('close', 13)}</button>
      </div>
      <div class="cp-quote-body" ${state.quoteOpen ? '' : 'hidden'}>
        <div class="cp-quote-attr">${esc(state.quote.attribution || '')}</div>
        <pre class="cp-quote-text">${esc((state.quote.text || '').slice(0, 4000))}</pre>
      </div>
    </div>`;
}

function render() {
  if (!state) return;
  mountSeq++;
  quill = null;
  const me = store.me;
  const fromOptions = me.mailboxes
    .filter((m) => m.role !== 'readonly')
    .map((m) => `<wa-option value="${esc(m.id)}">${esc(m.display_name ? `${m.display_name} <${m.address}>` : m.address)}</wa-option>`)
    .join('');
  const barOn = state.maximized || state.showBar;

  qs('#compose-root').innerHTML = `
  <div class="compose ${state.minimized ? 'minimized' : ''} ${state.maximized ? 'maximized' : ''}">
    <div class="compose-head" id="cp-head">
      <span>${esc(state.reply_to_message_id ? t('reply') : t('new_mail'))}</span>
      <span class="flex1"></span>
      <span id="compose-status" class="cp-status"></span>
      <wa-button class="icon sm" appearance="plain" id="cp-min" aria-label="${esc(t('minimize'))}">${state.minimized ? icon('expandLess', 16) : icon('minimize', 16)}</wa-button>
      <wa-button class="icon sm" appearance="plain" id="cp-max" aria-label="${esc(state.maximized ? t('restore_window') : t('maximize_window'))}">${icon(state.maximized ? 'collapse' : 'expand', 15)}</wa-button>
      <wa-button class="icon sm" appearance="plain" id="cp-close" aria-label="${esc(t('save_close'))}">${icon('close', 16)}</wa-button>
    </div>
    <div class="compose-body">
      <div class="cp-row">
        <label>${esc(t('from'))}</label>
        <wa-select class="flat" id="cp-from" value="${esc(state.mbId)}" size="small">${fromOptions}</wa-select>
      </div>
      <div class="cp-row">
        <input id="cp-to" type="text" value="${esc(state.to)}" placeholder="${esc(t('to'))}" autocomplete="off">
        <wa-button appearance="plain" size="small" id="cp-showcc" ${state.showCc ? 'hidden' : ''}>${esc(t('cc_bcc'))}</wa-button>
      </div>
      <div class="cp-row" ${state.showCc ? '' : 'hidden'} id="row-cc">
        <input id="cp-cc" type="text" value="${esc(state.cc)}" placeholder="${esc(t('cc'))}" autocomplete="off">
      </div>
      <div class="cp-row" ${state.showCc ? '' : 'hidden'} id="row-bcc">
        <input id="cp-bcc" type="text" value="${esc(state.bcc)}" placeholder="${esc(t('bcc'))}" autocomplete="off">
      </div>
      <div class="cp-row">
        <input id="cp-subject" type="text" value="${esc(state.subject)}" placeholder="${esc(t('subject'))}" autocomplete="off">
      </div>
      <div class="cp-editwrap">
        <div class="cp-toolbar" id="cp-toolbar" ${barOn ? '' : 'hidden'}>${toolbarHtml()}</div>
        <div class="cp-editor" id="cp-editor"></div>
        ${quoteHtmlBlock()}
      </div>
      <div class="cp-atts" ${state.atts.length ? '' : 'hidden'} id="cp-atts">${attChipsHtml()}</div>
      <div class="compose-foot">
        <wa-button variant="brand" id="cp-send" ${state.sending ? 'loading' : ''}>${esc(t('send'))}</wa-button>
        <wa-button class="icon" appearance="plain" id="cp-fmt" ${state.maximized ? 'hidden' : ''}
          aria-label="${esc(t('fmt_toggle'))}" title="${esc(t('fmt_toggle'))}">${icon('textFormat', 20)}</wa-button>
        <wa-button class="icon" appearance="plain" id="cp-attach" aria-label="${esc(t('add_attach'))}">${icon('attach', 20)}</wa-button>
        <input type="file" id="cp-file" multiple hidden>
        <span class="cp-size" id="cp-size"></span>
        <span class="flex1"></span>
        <wa-button class="icon" appearance="plain" id="cp-discard" aria-label="${esc(t('discard_draft'))}">${icon('trash', 20)}</wa-button>
      </div>
      <div class="ac-drop" id="cp-ac" hidden></div>
    </div>
  </div>`;
  bind();
  if (!state.minimized) mountEditor();
}

function markDirty() {
  if (!state) return;
  state.dirty = true;
  const el = qs('#compose-status');
  if (el) el.textContent = '';
  autoSave();
}

// ---------- Editor ----------
// ---------- 编辑器 ----------

/** Image width is a property of the Image blot but is not in the format registry; register it, or the allow-list complains
 *  图片宽度是 Image blot 自带的属性,但不在格式注册表里;补注册一下,否则白名单会报错 */
function registerWidthFormat(Q) {
  if (Q.imports['formats/width']) return;
  const P = Q.import('parchment');
  Q.register({ 'formats/width': new P.Attributor('width', 'width', { scope: P.Scope.INLINE }) }, true);
}

async function mountEditor() {
  const seq = mountSeq;
  const host = qs('#cp-editor');
  if (!host) return;
  let Q;
  try {
    Q = await loadQuill();
  } catch {
    return fallbackTextarea();
  }
  if (seq !== mountSeq || !state) return; // 期间又重渲染了,放弃这次挂载
  registerWidthFormat(Q);
  applyEditorLabels();
  const q = new Q(host, {
    theme: 'snow',
    formats: FORMATS,
    placeholder: t('body_ph'),
    bounds: host, // 链接气泡按编辑器边界收边,不然会顶出窗口被裁掉
    modules: {
      toolbar: { container: qs('#cp-toolbar'), handlers: { image: pickInlineImage } },
      keyboard: { bindings: { 'send-shortcut': { key: 'Enter', shortKey: true, handler: () => { send(); return false; } } } },
      // Take over Quill's built-in drag-and-drop upload: the default implementation first inserts a base64
      // image (that is the "flash"), so we route straight to the upload path and insert at the drop point,
      // showing exactly one image throughout.
      // 接管 Quill 自带的拖放上传:默认实现会先塞一张 base64 图(就是那"闪一下"),
      // 我们改成直接走上传路径,插到落点处,全程只出现一张图
      uploader: { mimetypes: INLINE_MIMES, handler: (range, files) => insertInline(files, range?.index) },
    },
  });
  try {
    q.setContents(state.delta, 'silent');
  } catch {
    q.setText(state.text || '');
  }
  let imgCount = q.root.querySelectorAll('img').length;
  q.on('text-change', (_d, _o, source) => {
    if (source === 'user') markDirty();
    absorbDataImages();
    // Only adding or removing an image recomputes the size; plain typing does not
    // 图片增删才重算大小;纯打字不触发
    const n = q.root.querySelectorAll('img').length;
    if (n !== imgCount) {
      imgCount = n;
      recalcSize();
    }
  });
  q.root.addEventListener('paste', onEditorPaste, true);
  q.root.addEventListener('dragover', (e) => e.preventDefault());
  q.root.addEventListener('drop', onEditorDrop);
  quill = q;
  applyPickerTitles();
  bindImgResize(q.root);
  recalcSize(); // 打开草稿时也要立刻显示大小
  if (!state.to) qs('#cp-to')?.focus();
  else q.focus();
}

/** If Quill fails to load, fall back to a plain textarea so composing still works
 *  Quill 加载失败时退回纯文本框,功能不中断 */
function fallbackTextarea() {
  const host = qs('#cp-editor');
  if (!host || !state) return;
  state.rich = false;
  host.outerHTML = `<textarea id="cp-text" placeholder="${esc(t('body_ph'))}">${esc(state.text)}</textarea>`;
  qs('#cp-toolbar')?.setAttribute('hidden', '');
  qs('#cp-fmt')?.setAttribute('hidden', '');
  qs('#cp-text')?.addEventListener('input', markDirty);
}

/** Inline images: after upload the src is /api/uploads/<id>, which is swapped for cid: when sending
 *  内联图片:上传后用 /api/uploads/<id> 作 src,发送时再换成 cid: */
async function uploadInline(file) {
  const f = await downscaleImage(file);
  if (f.size > 10 * 1024 * 1024) {
    toast(t('t_too_big', f.name), true);
    return null;
  }
  // Read the dimensions locally, so the scale step can be chosen automatically on insert
  // 尺寸在本地读出来,插入时据此自动选缩放档
  let dim = { w: 0, h: 0 };
  try {
    const bmp = await createImageBitmap(f);
    dim = { w: bmp.width, h: bmp.height };
    bmp.close?.();
  } catch {}
  const fd = new FormData();
  fd.append('file', f);
  const r = await api('POST', '/api/uploads', fd);
  const entry = {
    upload_id: r.id,
    cid: `img${r.id.replace(/[^a-zA-Z0-9]/g, '')}@cfmail`,
    url: `/api/uploads/${r.id}`,
    filename: f.name,
    mime: f.type,
    size: f.size,
    w: dim.w,
    h: dim.h,
  };
  state.inline.push(entry);
  return entry;
}

async function insertInline(files, at) {
  let index = at ?? quill?.getSelection(true)?.index ?? quill?.getLength() ?? 0;
  for (const f of files) {
    if (!/^image\//.test(f.type)) continue;
    try {
      const entry = await uploadInline(f);
      if (!entry || !quill) continue;
      quill.insertEmbed(index, 'image', entry.url, 'user');
      // Land on the step whose pixel count is nearest 200k; GIFs are never resampled and keep their size
      // 自动落到像素数最接近 20 万的那一档;GIF 不重采样,保持原尺寸
      const s = entry.mime === 'image/gif' ? 1 : bestScale(entry.w, entry.h);
      if (s < 1) quill.formatText(index, 1, 'width', String(Math.max(16, Math.round(entry.w * s))), 'user');
      index += 1;
      quill.setSelection(index, 0, 'silent');
    } catch (e) {
      toast(t('t_upload_fail', e.message), true);
    }
  }
  markDirty();
  recalcSize();
}

function pickInlineImage() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.multiple = true;
  inp.onchange = () => insertInline([...inp.files]);
  inp.click();
}

function onEditorPaste(e) {
  const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  insertInline(files);
}

/**
 * Dropped into the body: the image itself is inserted by Quill's uploader (now our handler), so all
 * this does is stop the bubbling, or the outer attachment drop zone would collect the same image
 * a second time. Non-images pass through as usual.
 * 拖进正文:图片本身由 Quill 的 uploader(已换成我们的 handler)插入,
 * 这里只负责拦住冒泡,免得外层的附件拖放把同一张图再收一份;非图片照常放行。
 */
function onEditorDrop(e) {
  const files = [...(e.dataTransfer?.files || [])];
  const inline = files.filter((f) => INLINE_MIMES.includes(f.type));
  if (!inline.length) return; // 全是普通文件,交给外层的附件拖放
  e.stopPropagation();
  qs('.compose')?.classList.remove('dragover');
  files.filter((f) => !inline.includes(f)).forEach((f) => uploadFile(f));
}

// ---------- Inline image scaling ----------
// ---------- 内联图片缩放 ----------

let hoverImg = null;
let hideBarTimer = null;

function imgBar() {
  let bar = qs('#cp-imgbar');
  if (bar) return bar;
  const wrap = qs('.cp-editwrap');
  if (!wrap) return null;
  bar = document.createElement('div');
  bar.id = 'cp-imgbar';
  bar.className = 'cp-imgbar';
  bar.hidden = true;
  bar.innerHTML =
    IMG_SCALES.map((s) => `<button data-s="${s}" title="${Math.round(s * 100)}%">${icon(SCALE_ICON[s], 15)}</button>`).join('') +
    `<span class="cp-imgbar-sep"></span>` +
    `<button data-del class="del" title="${esc(t('remove'))}">${icon('trash', 15)}</button>`;
  bar.addEventListener('mousedown', (e) => e.preventDefault()); // 别把焦点从编辑器抢走
  bar.addEventListener('mouseenter', () => clearTimeout(hideBarTimer));
  bar.addEventListener('mouseleave', scheduleHideBar);
  bar.addEventListener('click', (e) => {
    if (e.target.closest('[data-del]')) return deleteHoverImg();
    const b = e.target.closest('[data-s]');
    if (b) setImgScale(parseFloat(b.dataset.s));
  });
  wrap.appendChild(bar);
  return bar;
}

function scheduleHideBar() {
  clearTimeout(hideBarTimer);
  hideBarTimer = setTimeout(() => {
    const bar = qs('#cp-imgbar');
    if (bar) bar.hidden = true;
    hoverImg = null;
  }, 250);
}

/** GIFs are not resampled when sending (it would kill the animation), so they get no scale steps either -- better than implying they shrank
 *  GIF 发送时不重采样(会把动画拍死),所以也不给缩放档位,免得以为缩了 */
function isGifImg(img) {
  const src = img.getAttribute('src') || '';
  const it = state?.inline.find((x) => x.url === src);
  return it ? it.mime === 'image/gif' : /\.gif(\?|$)/i.test(src);
}

function showImgBar(img) {
  const bar = imgBar();
  const wrap = qs('.cp-editwrap');
  if (!bar || !wrap) return;
  // No resampling for GIFs; and shrinking an image already within 256x256 is pointless, so neither gets steps
  // GIF 不重采样;256x256 以内的小图再缩没意义,都不给档位
  if (isGifImg(img) || (img.naturalWidth <= MIN_RESIZABLE && img.naturalHeight <= MIN_RESIZABLE)) {
    bar.hidden = true;
    return;
  }
  clearTimeout(hideBarTimer);
  hoverImg = img;
  const cur = curScale(img);
  bar.querySelectorAll('[data-s]').forEach((b) => b.classList.toggle('on', Math.abs(parseFloat(b.dataset.s) - cur) < 0.02));
  const i = img.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  bar.hidden = false;
  // Centre it horizontally against the image and clamp it inside the editor, so narrow images or ones near the edge do not overflow
  // 相对图片水平居中,并夹在编辑区内,窄图或贴边时不会溢出
  const bw = bar.offsetWidth;
  const left = i.left - w.left + (i.width - bw) / 2;
  bar.style.left = Math.round(Math.min(Math.max(0, left), Math.max(0, w.width - bw))) + 'px';
  bar.style.top = Math.max(0, Math.round(i.top - w.top + 6)) + 'px';
}

/** The current displayed width as a ratio of the original
 *  当前显示宽度相对原图的比例 */
function curScale(img) {
  const nat = img.naturalWidth || 0;
  const set = parseInt(img.getAttribute('width'), 10);
  return nat && set ? set / nat : 1;
}

function deleteHoverImg() {
  if (!hoverImg || !quill) return;
  const blot = window.Quill.find(hoverImg);
  if (!blot) return;
  quill.deleteText(quill.getIndex(blot), 1, 'user');
  markDirty();
  const bar = qs('#cp-imgbar');
  if (bar) bar.hidden = true;
  hoverImg = null;
}

function setImgScale(f) {
  if (!hoverImg || !quill) return;
  const nat = hoverImg.naturalWidth || 0;
  if (!nat) return;
  const blot = window.Quill.find(hoverImg);
  if (!blot) return;
  const index = quill.getIndex(blot);
  quill.formatText(index, 1, 'width', f >= 1 ? '' : String(Math.max(16, Math.round(nat * f))), 'user');
  markDirty();
  recalcSize(); // 换档位 → 重采样后的字节数会变,但图片数不变,得显式重算
  setTimeout(() => hoverImg && showImgBar(hoverImg), 0);
}

function bindImgResize(root) {
  root.addEventListener('mouseover', (e) => {
    const img = e.target.closest('img');
    if (img && root.contains(img)) showImgBar(img);
  });
  root.addEventListener('mouseout', (e) => {
    if (e.target.closest('img')) scheduleHideBar();
  });
  root.addEventListener('scroll', () => {
    const bar = qs('#cp-imgbar');
    if (bar) bar.hidden = true;
  });
}

/** Images pasted from a web page arrive as data: URIs -- bulky and impossible to send inline, so they are all converted into uploads
 *  从网页粘过来的图片会带 data: URI,体积大且无法内联发送,统一转成上传 */
const absorbDataImages = debounce(async () => {
  if (!quill) return;
  const ops = quill.getContents().ops || [];
  let index = 0;
  for (const op of ops) {
    if (typeof op.insert === 'string') { index += op.insert.length; continue; }
    const src = op.insert?.image;
    if (src && /^data:image\//i.test(src)) {
      const at = index;
      try {
        const blob = await (await fetch(src)).blob();
        const entry = await uploadInline(new File([blob], 'pasted.png', { type: blob.type || 'image/png' }));
        if (entry && quill) {
          quill.deleteText(at, 1, 'silent');
          quill.insertEmbed(at, 'image', entry.url, 'silent');
          markDirty();
          recalcSize();
        }
      } catch {}
      return; // 一次处理一张,剩下的由下一次 text-change 继续
    }
    index += 1;
  }
}, 300);

// ---------- Recipient autocomplete ----------
// ---------- 收件人自动补全 ----------

let acState = { items: [], index: -1, input: null };

function acClose() {
  const drop = qs('#cp-ac');
  if (drop) drop.hidden = true;
  acState = { items: [], index: -1, input: null };
}

function acRender() {
  const drop = qs('#cp-ac');
  if (!drop) return;
  if (!acState.items.length || !acState.input) {
    drop.hidden = true;
    return;
  }
  drop.innerHTML = acState.items
    .map(
      (ct, i) => `
    <div class="ac-item ${i === acState.index ? 'sel' : ''}" data-i="${i}">
      <div class="ac-main">
        <span class="ac-name">${esc(ct.name || ct.addr.split('@')[0])}</span>
        <span class="ac-addr">${esc(ct.addr)}</span>
      </div>
      <span class="chip ${ct.internal ? 'chip-ok' : ''}">${esc(ct.internal ? t('contacts_internal') : t('contacts_external'))}</span>
    </div>`
    )
    .join('');
  const body = qs('.compose-body');
  const top = acState.input.offsetTop + acState.input.offsetHeight + 4 - body.scrollTop;
  drop.style.top = top + 'px';
  drop.style.left = '52px';
  drop.hidden = false;
  drop.querySelectorAll('.ac-item').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      acPick(parseInt(el.dataset.i, 10));
    });
  });
}

function acPick(i) {
  const ct = acState.items[i];
  const input = acState.input;
  if (!ct || !input) return;
  const v = input.value;
  const lastSep = Math.max(v.lastIndexOf(','), v.lastIndexOf(';'), v.lastIndexOf('，'));
  const head = lastSep >= 0 ? v.slice(0, lastSep + 1) + ' ' : '';
  const insert = ct.name && !/[<>,;"]/.test(ct.name) ? `${ct.name} <${ct.addr}>` : ct.addr;
  input.value = head + insert + ', ';
  markDirty();
  acClose();
  input.focus();
}

const acFetch = debounce(async (input) => {
  if (!state) return;
  const v = input.value;
  const lastSep = Math.max(v.lastIndexOf(','), v.lastIndexOf(';'), v.lastIndexOf('，'));
  const seg = v.slice(lastSep + 1).trim();
  if (!seg) return acClose();
  try {
    const r = await api('GET', `/api/mailboxes/${state.mbId}/contacts?q=${encodeURIComponent(seg)}&limit=8`);
    if (document.activeElement !== input) return;
    acState = { items: (r.contacts || []).slice(0, 8), index: -1, input };
    acRender();
  } catch {
    acClose();
  }
}, 180);

function bindAC(input) {
  if (!input) return;
  input.addEventListener('input', () => acFetch(input));
  input.addEventListener('keydown', (e) => {
    if (qs('#cp-ac')?.hidden !== false) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acState.index = (acState.index + 1) % acState.items.length;
      acRender();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acState.index = (acState.index - 1 + acState.items.length) % acState.items.length;
      acRender();
    } else if (e.key === 'Enter') {
      if (acState.index >= 0) {
        e.preventDefault();
        acPick(acState.index);
      } else acClose();
    } else if (e.key === 'Escape') {
      acClose();
    }
  });
  input.addEventListener('blur', () => setTimeout(acClose, 150));
}

// ---------- Event wiring ----------
// ---------- 事件绑定 ----------

function bind() {
  qs('#cp-min').onclick = () => {
    Object.assign(state, collect());
    state.minimized = !state.minimized;
    render();
  };
  qs('#cp-max').onclick = () => {
    Object.assign(state, collect());
    state.maximized = !state.maximized;
    state.minimized = false;
    render();
  };
  qs('#cp-head').ondblclick = () => qs('#cp-max').click();
  qs('#cp-close').onclick = () => {
    Object.assign(state, collect());
    close(true);
  };
  qs('#cp-discard').onclick = async () => {
    if (state.draftId) await api('DELETE', `/api/drafts/${state.draftId}`).catch(() => {});
    state.dirty = false;
    close(false);
    toast(t('t_draft_discarded'));
  };
  qs('#cp-showcc').onclick = () => {
    Object.assign(state, collect());
    state.showCc = true;
    render();
  };
  qs('#cp-fmt').onclick = () => {
    state.showBar = !state.showBar;
    localStorage.setItem(BAR_KEY, state.showBar ? '1' : '0');
    const bar = qs('#cp-toolbar');
    if (bar) bar.hidden = !state.showBar; // 只切换显隐,编辑器实例保持不动
    quill?.focus();
  };
  qs('#cp-from').onchange = (e) => {
    state.mbId = e.target.value;
    state.draftId = null;
    markDirty();
  };
  ['cp-to', 'cp-cc', 'cp-bcc', 'cp-subject'].forEach((id) => {
    const el = qs('#' + id);
    if (el) el.addEventListener('input', markDirty);
  });
  bindAC(qs('#cp-to'));
  bindAC(qs('#cp-cc'));
  bindAC(qs('#cp-bcc'));
  qs('#cp-quote-toggle') &&
    (qs('#cp-quote-toggle').onclick = () => {
      state.quoteOpen = !state.quoteOpen;
      qs('#cp-quote').classList.toggle('open', state.quoteOpen);
      qs('.cp-quote-body').hidden = !state.quoteOpen;
    });
  qs('#cp-quote-x') &&
    (qs('#cp-quote-x').onclick = () => {
      state.quote = null;
      qs('#cp-quote').remove();
      markDirty();
    });
  qs('#cp-attach').onclick = () => qs('#cp-file').click();
  qs('#cp-file').onchange = async (e) => {
    for (const f of e.target.files) await uploadFile(f);
    e.target.value = '';
  };
  bindDropZone(qs('.compose'), async (files) => {
    if (state.minimized) {
      state.minimized = false;
      Object.assign(state, collect());
      render();
    }
    for (const f of files) await uploadFile(f);
  });
  qs('#cp-atts').addEventListener('click', (e) => {
    const btn = e.target.closest('.att-x');
    if (!btn) return;
    state.atts.splice(parseInt(btn.dataset.i, 10), 1);
    renderAtts();
    markDirty();
    recalcSize();
  });
  qs('#cp-send').onclick = send;
}

async function uploadFile(f) {
  if (f.size > 20 * 1024 * 1024) return toast(t('t_too_big', f.name), true);
  const entry = { id: null, filename: f.name, size: f.size, done: false };
  state.atts.push(entry);
  renderAtts();
  try {
    const fd = new FormData();
    fd.append('file', f);
    const r = await api('POST', '/api/uploads', fd);
    entry.id = r.id;
    entry.done = true;
    markDirty();
  } catch (e) {
    state.atts = state.atts.filter((a) => a !== entry);
    toast(t('t_upload_fail', e.message), true);
  }
  renderAtts();
  recalcSize();
}

// ---------- Sending ----------
// ---------- 发送 ----------

/** With no formatting and no images, send as plain text rather than pushing a pointless multipart at the recipient
 *  没有任何格式、也没有图片时,按纯文本发,不给收件端塞多余的 multipart */
function isPlainDelta(d) {
  return (d.ops || []).every((op) => typeof op.insert === 'string' && !Object.keys(op.attributes || {}).length);
}

function quoteAsText(q) {
  if (!q || (!q.text && !q.attribution)) return '';
  const body = q.text ? '\n' + q.text.split('\n').map((l) => '> ' + l).join('\n') : '';
  return `\n\n${q.attribution || ''}${body}`;
}

const bakeCache = new Map();
const bakedUploads = new Set(); // 重采样过程中新建的上传,最终只有一份会被发出去

function encodeAt(bmp, w, type, quality = 0.9) {
  const h = Math.max(1, Math.round(bmp.height * (w / bmp.width)));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff'; // JPEG 没有透明通道,不铺白底透明区会变黑
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  return new Promise((r) => cv.toBlob(r, type, quality));
}

/**
 * Before sending, genuinely resample the inline images at the chosen step, keeping the format unchanged
 * (png stays png, jpg stays jpg).
 * Choosing 1:1 sends the original with no re-encoding at all; GIFs are always sent as-is, because
 * re-encoding kills the animation.
 * 发送前按选定档位真正重采样内联图,格式保持不变(png 还是 png,jpg 还是 jpg)。
 * 选 1:1 就原样发,不做任何重编码;GIF 一律原样发,重编会把动画拍死。
 */
function bakeInlineImage(entry, targetWidth) {
  const key = `${entry.upload_id}@${targetWidth || 0}`;
  if (bakeCache.has(key)) return bakeCache.get(key);
  const p = (async () => {
    const blob = await (await fetch(entry.url)).blob();
    if (blob.type === 'image/gif') return { ...entry, bytes: blob.size };
    const bmp = await createImageBitmap(blob);
    if (!targetWidth || targetWidth >= bmp.width) return { ...entry, bytes: blob.size }; // 没要求缩小
    const type = /^image\/(png|jpeg|webp)$/.test(blob.type) ? blob.type : 'image/png';
    const out = await encodeAt(bmp, targetWidth, type);
    if (!out) return { ...entry, bytes: blob.size }; // 编码失败才退回原图
    const ext = type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg';
    const fd = new FormData();
    fd.append('file', new File([out], entry.filename.replace(/\.\w+$/, '') + ext, { type }));
    const r = await api('POST', '/api/uploads', fd);
    bakedUploads.add(r.id);
    return { ...entry, upload_id: r.id, bytes: out.size };
  })().catch(() => entry);
  bakeCache.set(key, p);
  return p;
}

/**
 * Estimate this message's size live. It runs the exact same resampling path used when sending
 * (bakeInlineImage caches), so the number shown is the byte count that will really go out, not a guess.
 * Called only on structural changes (paste, drop, delete, add attachment, change scale step) -- never while typing.
 * 实时估算这封信的大小。走的是和发送完全相同的重采样路径(bakeInlineImage 有缓存),
 * 所以显示的就是真正会发出去的字节数,不是拍脑袋的估计。
 * 只在结构变化时调用(粘贴/拖入/删除/加附件/换缩放档),打字时不动。
 */
const recalcSize = debounce(async () => {
  if (!state) return;
  const el = qs('#cp-size');
  if (!el) return;
  const seq = ++sizeSeq;
  const delta = quill ? quill.getContents() : state.delta;
  const used = [];
  const html = deltaToEmailHtml(delta, (src, attr) => {
    const it = state.inline.find((x) => x.url === src);
    if (it) {
      if (!used.some((u) => u.entry === it)) used.push({ entry: it, width: parseInt(attr?.width, 10) || 0 });
      return 'cid:' + it.cid;
    }
    return /^https?:/i.test(src) ? src : null;
  });
  const text = deltaToPlainText(delta) + quoteAsText(state.quote);
  const bodyBytes = new TextEncoder().encode(text + html + (state.quote?.html || '')).byteLength;
  const attBytes = state.atts.filter((a) => a.done).reduce((n, a) => n + (a.size || 0), 0);
  const hasPayload = state.atts.some((a) => a.done) || used.length > 0;
  if (!hasPayload) return renderSize(0); // 纯文字信不显示,几百字节的数字没意义
  const baked = await Promise.all(used.map((u) => bakeInlineImage(u.entry, u.width)));
  if (seq !== sizeSeq || !state) return; // 期间又改了,丢弃这次结果
  renderSize(attBytes + bodyBytes + baked.reduce((n, b) => n + (b.bytes ?? b.size ?? 0), 0));
}, 250);

let sizeSeq = 0;

function renderSize(total) {
  const el = qs('#cp-size');
  if (!el) return;
  const limit = store.me?.max_content_bytes || 0;
  if (!total || !limit) {
    el.textContent = '';
    el.classList.remove('over');
    el.removeAttribute('title');
    return;
  }
  const over = total > limit;
  el.textContent = `${fmtSize(total)} / ${fmtSize(limit)}`;
  el.classList.toggle('over', over);
  if (over) el.title = t('size_over_tip');
  else el.removeAttribute('title');
}

async function buildBody() {
  const delta = state.delta;
  const used = new Map(); // cid → { entry, width }
  const html = deltaToEmailHtml(delta, (src, attr) => {
    const it = state.inline.find((x) => x.url === src);
    if (it) {
      if (!used.has(it.cid)) used.set(it.cid, { entry: it, width: parseInt(attr?.width, 10) || 0 });
      return 'cid:' + it.cid;
    }
    return /^https?:/i.test(src) ? src : null; // 外链图保留,其余(data:/内部链接)丢弃
  });
  const baked = await Promise.all([...used.values()].map((u) => bakeInlineImage(u.entry, u.width)));
  const needHtml = state.rich && (!isPlainDelta(delta) || used.size > 0 || !!state.quote?.html);
  const text = deltaToPlainText(delta) + quoteAsText(state.quote);
  const sent = new Set(baked.map((b) => b.upload_id));
  return {
    text,
    html: needHtml ? html + (state.quote?.html ? buildQuoteHtml(state.quote.attribution || '', state.quote.html) : '') : undefined,
    inline_images: [...used.keys()].map((cid, i) => ({ upload_id: baked[i].upload_id, cid })),
    // Produced by this compose but never sent: originals replaced by a resized copy, images pasted then deleted, intermediates from changing the scale step
    // 这次撰写产生但没发出去的:被缩图取代的原图、粘了又删的图、换过档位的中间产物
    discard_uploads: [...state.inline.map((x) => x.upload_id), ...bakedUploads].filter((id) => !sent.has(id)),
  };
}

async function send() {
  if (!state || state.sending) return;
  Object.assign(state, collect());
  if (!state.to.trim() && !state.cc.trim() && !state.bcc.trim()) return toast(t('t_need_rcpt'), true);
  if (state.atts.some((a) => !a.done)) return toast(t('atts_uploading'), true);
  state.sending = true;
  qs('#cp-send')?.setAttribute('loading', '');
  try {
    // Resampling has to read, encode and re-upload each image, so it goes after the loading state is shown
    // 重采样要读图、编码、再传一次,放在 loading 之后
    const body = state.rich ? await buildBody() : { text: state.text, inline_images: [] };
    const r = await api('POST', `/api/mailboxes/${state.mbId}/send`, {
      to: state.to,
      cc: state.cc,
      bcc: state.bcc,
      subject: state.subject,
      text: body.text,
      html: body.html,
      inline_images: body.inline_images,
      discard_uploads: body.discard_uploads,
      reply_to_message_id: state.reply_to_message_id,
      attachment_ids: state.atts.filter((a) => a.done).map((a) => a.id),
      draft_id: state.draftId,
    });
    state.dirty = false;
    close(false);
    toast(sendToastText(r));
    refreshMe();
  } catch (e) {
    state.sending = false;
    qs('#cp-send')?.removeAttribute('loading');
    toast(e.message, true);
  }
}
