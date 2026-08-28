// Pointing at a page and changing it.
//
// A PDF page shows a reader no seams. Nothing about a printed-looking page suggests that the
// heading is a separate thing from the paragraph under it, and until somebody's cursor is over
// it, nothing should: the first job here is to teach, by outlining whatever is under the pointer,
// that this page is made of things at all. Everything else follows from that -- click to take
// one, press a key to remove it, double-click to retype it.
//
// The engine underneath (pdfedit.js) keeps a list of changes rather than a changed document, so
// this layer never has to track what a page currently looks like. It asks for a fresh document
// whenever one is due and hands it to the viewer to draw. Between an edit and that redraw it
// shows its own mark over the page -- a struck-out box, the new words in place of the old -- so
// the page answers immediately and then agrees with itself a moment later.
//
// 指着一页,然后改动它。
//
// 一页 PDF 不向读者显露任何接缝。一张看起来像印出来的页面,没有任何地方暗示标题与它下面那段
// 是两个东西;而在有人的光标移上去之前,也不该有。这里的头一件差事就是教会人 ——
// 靠把指针底下那个东西描出边来 —— 这一页原来是由一个个东西组成的。其余的都由此而来:
// 点一下拿住一个,按一个键把它拿掉,双击重打它。
//
// 底下的引擎(pdfedit.js)持有的是一串改动而不是一份改过的文档,所以这一层从不需要跟踪
// 一页此刻长什么样。该要一份新文档的时候它就去要一份,交给查看器去画。
// 而在一次编辑与那次重画之间,它把自己的记号盖在页面上 —— 划掉的框、顶替旧字的新字 ——
// 于是页面立刻作出回应,过一会儿再与自己达成一致。

import { objectsAt, openPdf } from './pdfedit.js';
import { LAYERS } from './pdffont.js';
import * as localfont from './localfont.js';
import { toast } from '../ui.js';

/** How long to wait after a change before asking for the page to be drawn again. Long enough that
 *  a burst of typing costs one redraw, short enough that it feels like the same gesture.
 *  一次改动之后,等多久再去要求重画这一页。长到让一阵连打只花一次重画,
 *  短到让人觉得那还是同一个动作。 */
const REDRAW_AFTER = 450;

/** The size a text box gets when nobody said. Twelve points is what a document is
 *  usually set in, and a new line should look like it belongs.
 *  没人说的时候,一个文本框用多大。十二点是一份文档通常的正文大小,
 *  而新加的一行应当看起来像是本来就在那儿的。 */
const NEW_TEXT_SIZE = 12;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * One editing session over one file.
 *
 * @param box     the element the pages are laid out in
 * @param bytes   the whole file -- editing cannot work off ranges, because a change to page one
 *                is written into a document that must be complete to be written at all
 * @param viewer  { repaint(pageNo), swapDoc(bytes), holders() } -- drawing stays where drawing
 *                already was, and this asks it for what it needs
 * @param ui      { t, icon } from the application, so this module carries no dictionary of its own
 *
 * 对一个文件的一次编辑会话。
 *
 * @param box     页面排布所在的那个元素
 * @param bytes   整个文件 —— 编辑没法在 Range 上做,因为对第一页的改动要写进一份文档,
 *                而那份文档必须是完整的才写得出来
 * @param viewer  绘制的事仍留在它本来就在的地方,这里只向它要它需要的东西
 * @param ui      来自应用的 { t, icon },于是本模块不必自带一本词典
 */
export async function editSession({ box, bytes, viewer, ui, onDirty }) {
  const t = ui.t;
  const icon = ui.icon;
  const ed = await openPdf(bytes, { local: localSource() });

  let tool = 'pick';                 // pick | text | image
  let selection = null;              // { pageNo, obj }
  let hover = null;
  let redrawTimer = 0;
  const dirtyPages = new Set();
  const layers = new Map();          // pageNo -> { el, page, scale, state }
  let note = null;                   // the last thing worth telling the reader about a font
  let editing = null;                // the open inline editor, if any
  let align = 'left';                // where new text lines start: left | center | right
  let pendingImage = null;           // a picture picked and waiting for a click to place it
  let placeEl = null;                // the live preview of it, riding under the pointer / 骑在指针下的实时预览
  let placePage = 0;
  let drag = null;                   // { pageNo, obj, sx, sy, dx, dy, moved }
  let clickWasDrag = false;          // the click a finished drag leaves behind must not select
  let lastPtrType = 'mouse';         // what pressed last -- a finger asks for different manners / 上一次按下的是什么 —— 手指要另一套礼数
  let assetsVeil = null;             // the stamp/signature shelf, when it is open / 开着的图章签名架

  const bar = document.createElement('div');
  bar.className = 'pdfe-bar';
  if (ui.barHost) ui.barHost.appendChild(bar);
  else box.parentElement.insertBefore(bar, box);
  paintBar();

  // Three things only the document can hear: a press outside the typing box commits it, and a
  // drag keeps following the pointer after it has left the page that started it.
  // 只有 document 听得到的三件事:在打字框外按下,等于写完了;
  // 一次拖动在指针离开起始页之后,仍要继续跟着它。
  // Pointer events rather than mouse events, so a finger counts as a press too; a cancelled
  // touch (the browser reclaiming the gesture) ends the drag the same way lifting does.
  // 用 pointer 事件而不是 mouse 事件,手指的按下才算数;一次被打断的触摸
  // (浏览器把手势收回去了)结束拖动的方式,与抬起相同。
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragUp);
  document.addEventListener('pointercancel', onDragUp);

  /**
   * The reader's own font library, offered to the search but never opened behind their back.
   *
   * Enumerating somebody's fonts says things about them, so the browser makes it a permission and
   * this asks for it only from a button. Until then the search does without, which it can.
   *
   * 读者自己的字体库,提供给搜索使用,但绝不背着他们打开。
   *
   * 枚举一个人装了哪些字体是会说出些什么的,所以浏览器把它设成一项权限,
   * 而这里只从一个按钮去要它。在那之前搜索就不用它 —— 它不用也行。
   */
  function localSource() {
    return async (family) => (localfont.isOpen() ? localfont.source()(family) : []);
  }

  function paintBar() {
    const canUndo = ed.changes.length > 0;
    // The host may carry changes of its own -- a password set but not yet saved -- and Save
    // must wake for those too. / 宿主可能带着它自己的改动 —— 设了还没存的密码 ——
    // 保存也得为它们醒着。
    const canSave = canUndo || !!ui.extraDirty?.();
    const alignBtn = (a) => `<button class="pdfe-t${align === a ? ' on' : ''}" data-align="${a}"
      title="${esc(t('tt_align_' + a))}">${icon('align' + a[0].toUpperCase() + a.slice(1), 18)}</button>`;
    bar.innerHTML = `
      <div class="pdfe-tools">
        <button class="pdfe-t${tool === 'pick' ? ' on' : ''}" data-tool="pick" title="${esc(t('pdfe_pick'))}">${icon('select', 18)}</button>
        <button class="pdfe-t${tool === 'text' ? ' on' : ''}" data-tool="text" title="${esc(t('pdfe_addtext'))}">${icon('textFormat', 18)}</button>
        <button class="pdfe-t${tool === 'image' ? ' on' : ''}" data-act="image" title="${esc(t('tt_image'))}">${icon('image', 18)}</button>
        <button class="pdfe-t" data-act="stamp" title="${esc(t('pdfe_stamp'))}">${icon('stamp', 18)}</button>
        <button class="pdfe-t" data-act="sign" title="${esc(t('pdfe_sign'))}">${icon('signature', 18)}</button>
        <span class="pdfe-sep"></span>
        ${alignBtn('left')}${alignBtn('center')}${alignBtn('right')}
        <span class="pdfe-sep"></span>
        <button class="pdfe-t" data-act="rotate" ${selection?.obj?.added && selection.obj.kind === 'image' ? '' : 'disabled'}
          title="${esc(t('pdfe_rotate'))}">${icon('refresh', 18)}</button>
        <button class="pdfe-t" data-act="delete" ${selection ? '' : 'disabled'} title="${esc(t('pdfe_delete'))}">${icon('trash', 18)}</button>
        <button class="pdfe-t" data-act="undo" ${canUndo ? '' : 'disabled'} title="${esc(t('pdfe_undo'))}">${icon('restore', 18)}</button>
      </div>
      <div class="pdfe-say">${note ? esc(note) : ''}</div>
      <div class="pdfe-tools">
        ${localfont.available() && !localfont.isOpen()
          ? `<button class="pdfe-t wide" data-act="fonts" title="${esc(t('pdfe_fonts_why'))}">${icon('textFormat', 16)}<span>${esc(t('pdfe_fonts'))}</span></button>` : ''}
        ${ui.password ? `<button class="pdfe-t${ui.hasPassword?.() ? ' on' : ''}" data-act="lock" title="${esc(t('pdfe_pw'))}">${icon('lock', 18)}</button>` : ''}
        <button class="pdfe-t wide primary" data-act="save" ${canSave ? '' : 'disabled'}><span>${esc(t('pdfe_save'))}</span></button>
      </div>`;
  }

  bar.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.align) {
      align = b.dataset.align;
      // The open box follows at once; the page follows when it is committed. A selected block
      // follows right now -- somebody who selected a thing and chose an alignment meant that
      // thing, this moment.
      // 开着的框立刻跟上;页面等它写完时再跟。已选中的块此刻就跟 ——
      // 一个先选中了东西再挑对齐的人,指的就是这个东西、就是此刻。
      if (editing) editing.el.style.textAlign = align;
      else if (selection) await realignSelected();
      paintBar();
      return;
    }
    // Any other button means the typing is over; the box commits before the action runs.
    // 按下其余任何按钮,都表示字打完了;先让框落定,动作再执行。
    if (editing) await closeEditor(true);
    if (b.dataset.tool) { tool = b.dataset.tool; clearPending(); select(null); paintBar(); return; }
    const act = b.dataset.act;
    if (act === 'delete') removeSelected();
    else if (act === 'rotate') rotateSelected();
    else if (act === 'undo') await undo();
    else if (act === 'image') await pickImage();
    else if (act === 'stamp') openAssets('stamp');
    else if (act === 'sign') openAssets('signature');
    else if (act === 'lock') { await ui.password?.(); paintBar(); }
    else if (act === 'fonts') await openFonts();
    else if (act === 'save') await save();
  };

  /** A quarter turn about the picture's own centre: the shown box swaps its sides, the centre
   *  stays where the eye left it. / 绕图自己的中心转四分之一圈:显示框调换长短边,
   *  中心留在眼睛离开它的地方。 */
  function rotateSelected() {
    const sel = selection;
    const e0 = sel?.obj?.edit;
    if (!e0?.img) return;
    const g = e0.img;
    g.rot = ((g.rot || 0) + 90) % 360;
    const cx = g.x + g.w / 2;
    const cy = g.y + g.h / 2;
    [g.w, g.h] = [g.h, g.w];
    g.x = cx - g.w / 2;
    g.y = cy - g.h / 2;
    e0.box = [g.x, g.y, g.x + g.w, g.y + g.h];
    e0.fresh = true;
    changed(sel.pageNo);
  }

  /**
   * Re-hang the selected block from the newly chosen anchor. Its text is what the reader last
   * typed into it, or failing that what the file can read back out of it; a block whose text
   * cannot be known cannot be re-laid, and is left alone.
   *
   * 把选中的块挂到刚选定的锚上。它的文字,取读者最后打进去的那份;
   * 没有的话,取文件自己读得出来的那份。文字无从得知的块没法重排,原样不动。
   */
  async function realignSelected() {
    const sel = selection;
    if (!sel || sel.obj.kind !== 'text') return;
    const L = layers.get(sel.pageNo);
    let got = null;
    if (sel.obj.added) {
      const e0 = sel.obj.edit;
      ed.undo(L.st, e0);
      got = await ed.addText(L.st, {
        text: e0.write.text, x: e0.write.tm[4], y: e0.write.tm[5], size: e0.write.size, align,
      });
      if (got) selection = { pageNo: sel.pageNo, obj: ghostOf(got) };
    } else {
      const prior = L.st.edits.find((e) => e.what === 'retype' && e.obj === sel.obj);
      const text = prior?.write.text ?? ed.textOf(L.st, sel.obj);
      if (text == null || text === '') return;
      got = await ed.retype(L.st, sel.obj, text, align);
    }
    if (got) {
      got.fresh = true;
      changed(sel.pageNo);
    }
  }

  /**
   * Choose a picture, then a place for it. The picker is the browser's own; the place is the
   * next click on a page. PNG and JPEG go in as they are -- those are the two shapes a PDF can
   * hold -- and anything else is redrawn into a PNG first.
   *
   * 先挑一张图,再挑它落脚的地方。挑图用浏览器自己的;落脚点是下一次在页面上的点击。
   * PNG 和 JPEG 原样放进去 —— PDF 装得下的就这两种 —— 其余的先重画成一张 PNG。
   */
  /** A picture file as bytes a PDF can hold: PNG and JPEG as they are, anything else redrawn
   *  into a PNG. `asPng` forces the redraw for every non-PNG -- the asset shelf keeps only PNG,
   *  because transparency is the point of what it keeps.
   *  一张图片文件,化作 PDF 装得下的字节:PNG 与 JPEG 原样,其余重画成 PNG。
   *  `asPng` 让所有非 PNG 一律重画 —— 架子上只放 PNG,透明正是架上之物的意义。 */
  async function readImage(f, asPng) {
    const bmp = await createImageBitmap(f);
    const keep = asPng ? f.type === 'image/png' : (f.type === 'image/png' || f.type === 'image/jpeg');
    if (keep) {
      return { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type, w: bmp.width, h: bmp.height };
    }
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', w: bmp.width, h: bmp.height };
  }

  /** Hand a picture to the next click on a page. Until that click it rides under the pointer at
   *  the exact size it would land, and Ctrl with the wheel grows or shrinks it in place.
   *  把一张图交给下一次在页面上的点击。在那一下点击之前,它以将要落下的尺寸骑在指针底下;
   *  按住 Ctrl 滚动滚轮,就地放大缩小。 */
  function usePending(img) {
    clearPending();
    pendingImage = img;
    pendingImage.scale = 1;
    try {
      pendingImage.url = URL.createObjectURL(new Blob([img.bytes], { type: img.mime }));
    } catch { /* no preview is still placeable / 没有预览也照样放得下 */ }
    tool = 'image';
    select(null);
    paintBar();
  }

  function clearPending() {
    if (pendingImage?.url) {
      try { URL.revokeObjectURL(pendingImage.url); } catch { /* already gone / 已经没了 */ }
    }
    placeEl?.remove();
    placeEl = null;
    pendingImage = null;
  }

  /** The width the picture would land with, in page points -- one answer for the preview and
   *  for the landing itself. / 这张图落下时会有的宽,按页面的点算 ——
   *  预览与真正落下,用的是同一个答案。 */
  function pendingWidth(st) {
    const pageW = st.width || 612;
    return Math.min(pendingImage.w * 0.75, pageW / 2) * (pendingImage.scale || 1);
  }

  /** Keep the preview under the pointer, on whichever page the pointer is over.
   *  让预览一直待在指针底下,指针在哪一页,它就在哪一页。 */
  function movePlace(pageNo, e) {
    if (!pendingImage?.url) return;
    const L = layers.get(pageNo);
    const [x, y] = pointIn(pageNo, e);
    const w = pendingWidth(L.st);
    const h = (w * pendingImage.h) / pendingImage.w;
    const r = rectOf(pageNo, [x - w / 2, y - h / 2, x + w / 2, y + h / 2]);
    if (!placeEl) {
      placeEl = document.createElement('img');
      placeEl.className = 'pdfe-place';
      placeEl.src = pendingImage.url;
    }
    placeEl.style.left = r.left + '%';
    placeEl.style.top = r.top + '%';
    placeEl.style.width = r.width + '%';
    placeEl.style.height = r.height + '%';
    placeEl.style.display = '';
    if (placeEl.parentElement !== L.el) L.el.appendChild(placeEl);
    placePage = pageNo;
  }

  function onWheel(pageNo, e) {
    if (!(tool === 'image' && pendingImage) || !e.ctrlKey) return;
    e.preventDefault();
    const k = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    pendingImage.scale = Math.min(8, Math.max(0.1, (pendingImage.scale || 1) * k));
    movePlace(pageNo, e);
  }

  async function pickImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const img = await readImage(f, false);
        if (img) usePending(img);
      } catch { /* a file that is not a picture places nothing / 不是图的文件放不出东西 */ }
    };
    input.click();
  }

  // ---------- the stamp and signature shelf ----------
  // ---------- 图章与签名的架子 ----------

  /**
   * The account's own shelf of stamps or signatures: pick one to place, add one from a file or
   * a drop, draw a signature by hand. Everything picked or added becomes an ordinary placed
   * picture -- draggable, resizable, turnable, deletable -- because that is all a stamp is.
   *
   * 账号自己的图章或签名架:挑一枚去盖,从文件或拖拽里添一枚,签名还能手写一枚。
   * 挑中或添上的,都成为一张普通的已放置图片 —— 能拖、能缩、能转、能删 ——
   * 因为图章本来就只是这么一回事。
   */
  function openAssets(kind) {
    closeAssets();
    const veil = document.createElement('div');
    veil.className = 'pdfa-veil';
    veil.innerHTML = `
      <div class="pdfa-panel">
        <div class="pdfa-head">
          <span>${esc(t(kind === 'signature' ? 'pdfe_sign' : 'pdfe_stamp'))}</span>
          <button class="pdfe-t" data-a="close">${icon('close', 18)}</button>
        </div>
        <div class="pdfa-grid"></div>
        <div class="pdfa-foot">
          <button class="pdfe-t wide" data-a="upload">${icon('upload', 16)}<span>${esc(t('pdfe_asset_add'))}</span></button>
          ${kind === 'signature' ? `<button class="pdfe-t wide" data-a="draw">${icon('signature', 16)}<span>${esc(t('pdfe_asset_draw'))}</span></button>` : ''}
        </div>
      </div>`;
    document.body.appendChild(veil);
    assetsVeil = veil;

    const grid = veil.querySelector('.pdfa-grid');
    const paint = async () => {
      const got = await fetch(`/api/drive/pdfassets?kind=${kind}`).then((r) => r.json()).catch(() => null);
      const items = got?.assets || [];
      grid.innerHTML = items.length
        ? items.map((a) => `
          <div class="pdfa-item" data-id="${esc(a.id)}" data-w="${a.w}" data-h="${a.h}">
            <img src="/api/drive/pdfassets/${esc(a.id)}" alt="">
            <button class="pdfa-del" title="${esc(t('pdfe_delete'))}">${icon('close', 13)}</button>
          </div>`).join('')
        : `<div class="pdfa-empty">${esc(t('pdfe_asset_empty'))}</div>`;
    };
    paint();

    /**
     * A new picture goes on the shelf, and the shelf shows it at once -- silence after an
     * upload reads as failure, whatever actually happened. Only a hand-drawn signature skips
     * the shelf view and goes straight to placing: the person who just wrote it means to use
     * it this moment.
     *
     * 新图上架,架子立刻把它亮出来 —— 上传之后的沉默,不管实际发生了什么,读起来都是失败。
     * 只有手写的签名跳过架子直接去盖:刚写完它的人,此刻就是要用它。
     */
    const add = async (file, andUse) => {
      try {
        const img = await readImage(file, true);
        if (!img) { toast(t('e_bad_request'), true); return; }
        const q = `kind=${kind}&w=${img.w}&h=${img.h}&name=${encodeURIComponent(file.name || '')}`;
        const res = await fetch(`/api/drive/pdfassets?${q}`, { method: 'POST', body: img.bytes });
        if (!res.ok) { toast(t('e_request_failed'), true); return; }
        if (andUse) {
          usePending(img);
          closeAssets();
        } else {
          paint();
        }
      } catch { toast(t('e_bad_request'), true); }
    };

    veil.addEventListener('click', async (e) => {
      if (e.target === veil) { closeAssets(); return; }
      const del = e.target.closest('.pdfa-del');
      if (del) {
        e.stopPropagation();
        await fetch(`/api/drive/pdfassets/${del.parentElement.dataset.id}`, { method: 'DELETE' });
        paint();
        return;
      }
      const item = e.target.closest('.pdfa-item');
      if (item) {
        const r = await fetch(`/api/drive/pdfassets/${item.dataset.id}`);
        if (!r.ok) return;
        usePending({
          bytes: new Uint8Array(await r.arrayBuffer()), mime: 'image/png',
          w: +item.dataset.w || 300, h: +item.dataset.h || 150,
        });
        closeAssets();
        return;
      }
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'close') closeAssets();
      else if (b.dataset.a === 'upload') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => { if (input.files?.[0]) add(input.files[0]); };
        input.click();
      } else if (b.dataset.a === 'draw') {
        openDrawPad((f) => add(f, true));
      }
    });
    // Dropping a picture onto the shelf is the same gesture as uploading it.
    // 把一张图拖到架子上,与上传是同一个手势。
    veil.addEventListener('dragover', (e) => e.preventDefault());
    veil.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
      if (f) add(f);
    });
  }

  function closeAssets() {
    assetsVeil?.remove();
    assetsVeil = null;
  }

  /**
   * The signature pad: a mouse writes, midpoints smooth the line, and what is kept is only the
   * ink -- cropped to its own bounds, on nothing at all.
   *
   * 手写签名板:鼠标来写,取中点把线抹顺;留下的只有墨迹 ——
   * 裁到它自己的边界,底下什么也没有。
   */
  function openDrawPad(onDone) {
    const veil = document.createElement('div');
    veil.className = 'pdfa-veil';
    veil.innerHTML = `
      <div class="pdfa-draw">
        <div class="pdfa-head"><span>${esc(t('pdfe_draw_hint'))}</span>
          <button class="pdfe-t" data-a="close">${icon('close', 18)}</button></div>
        <canvas width="640" height="280"></canvas>
        <div class="pdfa-foot">
          ${[1.5, 2.5, 4.5].map((w) => `<button class="pdfe-t pdfa-pen${w === 2.5 ? ' on' : ''}" data-w="${w}"
            aria-label="${esc(t('pdfe_draw_width'))}" title="${esc(t('pdfe_draw_width'))}"><i style="width:${Math.round(w * 2.2)}px;height:${Math.round(w * 2.2)}px"></i></button>`).join('')}
          <span class="pdfe-sep"></span>
          <button class="pdfe-t wide" data-a="clear">${esc(t('pdfe_draw_clear'))}</button>
          <button class="pdfe-t wide" data-a="undo" title="${esc(t('pdfe_undo'))}">${icon('restore', 16)}</button>
          <span style="flex:1"></span>
          <button class="pdfe-t wide primary" data-a="ok" disabled>${esc(t('confirm'))}</button>
        </div>
      </div>`;
    document.body.appendChild(veil);
    const canvas = veil.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const strokes = [];        // each stroke remembers its own width / 每一笔记着它自己的粗细
    let cur = null;
    let penW = 2.5;

    const repaint = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of strokes) trace(ctx, s);
      veil.querySelector('[data-a="ok"]').disabled = !strokes.length;
    };
    const trace = (g, s) => {
      const pts = s.pts;
      g.lineWidth = s.w;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#111';
      if (pts.length < 2) {
        g.beginPath();
        g.arc(pts[0][0], pts[0][1], s.w / 2, 0, Math.PI * 2);
        g.fillStyle = '#111';
        g.fill();
        return;
      }
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      const last = pts[pts.length - 1];
      g.lineTo(last[0], last[1]);
      g.stroke();
    };
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      // A zero-sized rect (a hidden window) must not turn every stroke into NaN.
      // 零尺寸的矩形(窗口被藏起来时)不能把每一笔都变成 NaN。
      const kx = r.width ? canvas.width / r.width : 1;
      const ky = r.height ? canvas.height / r.height : 1;
      return [(e.clientX - r.left) * kx, (e.clientY - r.top) * ky];
    };
    canvas.onpointerdown = (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers have no capture / 合成指针没有捕获可言 */ }
      cur = { pts: [at(e)], w: penW };
      strokes.push(cur);
    };
    canvas.onpointermove = (e) => {
      if (!cur) return;
      cur.pts.push(at(e));
      repaint();
    };
    canvas.onpointerup = () => {
      cur = null;
      repaint();
    };

    veil.addEventListener('click', async (e) => {
      const pen = e.target.closest('[data-w]');
      if (pen) {
        penW = parseFloat(pen.dataset.w);
        veil.querySelectorAll('[data-w]').forEach((p) => p.classList.toggle('on', p === pen));
        return;
      }
      const b = e.target.closest('[data-a]');
      if (e.target === veil || b?.dataset.a === 'close') { veil.remove(); return; }
      if (!b) return;
      if (b.dataset.a === 'clear') { strokes.length = 0; repaint(); }
      else if (b.dataset.a === 'undo') { strokes.pop(); repaint(); }
      else if (b.dataset.a === 'ok' && strokes.length) {
        // Only the ink survives: its bounding box, a margin the widest stroke fits in, a
        // transparent ground. / 活下来的只有墨迹:它的包围盒,一圈装得下最粗那笔的边距,
        // 一块透明的底。
        let x0 = 1e9; let y0 = 1e9; let x1 = -1e9; let y1 = -1e9;
        let widest = 0;
        for (const s of strokes) {
          widest = Math.max(widest, s.w);
          for (const [x, y] of s.pts) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          }
        }
        const pad = Math.max(8, Math.ceil(widest));
        const w = Math.max(1, Math.ceil(x1 - x0 + pad * 2));
        const h = Math.max(1, Math.ceil(y1 - y0 + pad * 2));
        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        const g = out.getContext('2d');
        g.translate(pad - x0, pad - y0);
        for (const s of strokes) trace(g, s);
        const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
        veil.remove();
        if (blob) onDone(new File([blob], 'signature.png', { type: 'image/png' }));
      }
    });
  }

  /** Opening the library is a decision made by a person, in the click that makes it.
   *  打开字体库是由一个人做出的决定,就在做出这个决定的那一次点击里。 */
  async function openFonts() {
    const ok = await localfont.open();
    note = ok ? t('pdfe_fonts_on') : t('pdfe_fonts_no');
    paintBar();
  }

  // ---------- the layer over one page ----------

  /** Called by the viewer each time a page has been drawn. The layer is rebuilt rather than kept,
   *  because a redraw may have happened at a different width.
   *  查看器每画完一页就调用这里。层是重建而不是留用的,因为一次重画可能是按另一个宽度画的。 */
  async function attach(holder, pageProxy, scale) {
    const pageNo = pageProxy.pageNumber;
    const st = await ed.page(pageNo - 1);
    const vp = pageProxy.getViewport({ scale });
    let el = holder.querySelector('.pdfe-layer');
    if (!el) {
      el = document.createElement('div');
      el.className = 'pdfe-layer';
      holder.appendChild(el);
    }
    layers.set(pageNo, { el, holder, page: pageProxy, vp, st });
    // A finger sends no hover worth drawing: its moves exist only mid-gesture, and an outline
    // that blinks under a scroll is noise. / 手指发不出值得画的悬停:它的移动只存在于手势中途,
    // 一圈随滚动闪烁的描边只是噪音。
    el.onpointermove = (e) => { if (e.pointerType !== 'touch') onMove(pageNo, e); };
    el.onwheel = (e) => onWheel(pageNo, e);
    el.onpointerleave = () => {
      hover = null;
      if (placeEl) placeEl.style.display = 'none';
      paintLayer(pageNo);
    };
    el.onpointerdown = (e) => onDown(pageNo, e);
    el.onclick = (e) => onClick(pageNo, e);
    el.ondblclick = (e) => onDouble(pageNo, e);
    paintLayer(pageNo);
  }

  // ---------- what can be pointed at ----------
  // ---------- 什么是可以指着的 ----------

  /** A pending addition, wearing enough of an object's shape to be hovered, dragged and deleted.
   *  The box is read through, not copied, so it follows the edit wherever it is moved.
   *  一笔尚未落地的新增,披上对象的形状,好被悬停、拖动和删除。
   *  框是透过去读的而不是抄来的,于是它挪到哪儿,框就跟到哪儿。 */
  const ghostOf = (e) => (e.ghost ||= {
    kind: e.kind || 'text',
    added: true,
    edit: e,
    get box() { return e.box; },
  });

  /** Is this object already struck from the page? Something removed cannot be picked again --
   *  that is what removing it meant.
   *  这个对象是不是已经从页面上划掉了?删掉的东西不能再被选中 —— 删掉它,说的就是这个意思。 */
  const removedHere = (st, o) => st.edits.some((e) => e.what === 'remove' && e.obj === o);

  /** The thing under a point: pending additions first -- they were drawn last, so they are on
   *  top -- then the page's own objects, the removed ones passed over.
   *  一个点底下的东西:先看未落地的新增 —— 它们最后画,所以在最上面 ——
   *  再看页面自己的对象,已删除的略过。 */
  function hitAt(st, x, y) {
    for (let i = st.edits.length - 1; i >= 0; i--) {
      const e = st.edits[i];
      if (e.what !== 'add' || !e.box) continue;
      if (x >= e.box[0] && x <= e.box[2] && y >= e.box[1] && y <= e.box[3]) return ghostOf(e);
    }
    return objectsAt(st.objects, x, y).find((o) => !removedHere(st, o)) || null;
  }

  /**
   * Between the page's coordinates and the layer's, in both directions.
   *
   * Everything the layer draws is placed in per cent rather than pixels, and everything it reads
   * is scaled by how wide the layer actually is. The page is drawn into a canvas that CSS may
   * shrink to fit -- a narrow window, a reader dragging the divider -- and a box measured in
   * pixels at one width is in the wrong place at any other. A proportion is right at every width.
   *
   * 在页面坐标与本层坐标之间,来回两个方向。
   *
   * 本层画出来的一切都以百分比而不是像素定位,读进来的一切都按"本层此刻实际有多宽"来换算。
   * 页面被画进一张 canvas,而 CSS 可能把它缩小以便放得下 —— 窗口窄了、读者拖了分隔条 ——
   * 于是一个在某个宽度下按像素量出来的框,在别的任何宽度下都在错的地方。比例在每个宽度下都对。
   */
  function pointIn(pageNo, e) {
    const L = layers.get(pageNo);
    const r = L.el.getBoundingClientRect();
    if (!r.width || !r.height) return [0, 0];
    return L.vp.convertToPdfPoint(
      ((e.clientX - r.left) / r.width) * L.vp.width,
      ((e.clientY - r.top) / r.height) * L.vp.height,
    );
  }

  function rectOf(pageNo, pdfBox) {
    const L = layers.get(pageNo);
    // Two opposite corners are enough. A page is only ever rotated by a quarter turn at a time,
    // and a quarter turn takes an upright rectangle to an upright rectangle -- so the box around
    // the two mapped corners is the box around all four.
    // 两个对角点就够了。一页的旋转永远只以四分之一圈为单位,
    // 而四分之一圈把一个正放的矩形变成一个正放的矩形 —— 于是围住那两个映射后角点的框,
    // 就是围住全部四个的框。
    const a = L.vp.convertToViewportPoint(pdfBox[0], pdfBox[1]);
    const b = L.vp.convertToViewportPoint(pdfBox[2], pdfBox[3]);
    return {
      left: (Math.min(a[0], b[0]) / L.vp.width) * 100,
      top: (Math.min(a[1], b[1]) / L.vp.height) * 100,
      width: (Math.abs(b[0] - a[0]) / L.vp.width) * 100,
      height: (Math.abs(b[1] - a[1]) / L.vp.height) * 100,
    };
  }

  /** How many screen pixels one of the page's own points is worth right now.
   *  此刻,页面自己坐标系里的一个点值多少个屏幕像素。 */
  function pixelsPerPoint(pageNo) {
    const L = layers.get(pageNo);
    const r = L.el.getBoundingClientRect();
    return (r.width || L.vp.width) / (L.vp.width / L.vp.scale);
  }

  function onMove(pageNo, e) {
    const L = layers.get(pageNo);
    if (ed.isDropped(L.st)) return;
    // A page waiting for a placing click says so from the cursor -- silence here is what made
    // a successful upload look like nothing had happened.
    // 等着被点一下放东西的页面,由光标把这话说出来 —— 这里的沉默,
    // 正是让一次成功的上传看起来什么都没发生的原因。
    L.el.classList.toggle('placing', tool === 'text' || (tool === 'image' && !!pendingImage));
    if (tool === 'image' && pendingImage) {
      movePlace(pageNo, e);
      return;
    }
    if (tool !== 'pick' || editing || drag) return;
    const [x, y] = pointIn(pageNo, e);
    const hit = hitAt(L.st, x, y);
    L.el.classList.toggle('can-grab', !!hit);
    if (hit === hover?.obj) return;
    hover = hit ? { pageNo, obj: hit } : null;
    paintLayer(pageNo);
  }

  // ---------- dragging a thing somewhere else ----------
  // ---------- 把一样东西拖到别处 ----------

  function onDown(pageNo, e) {
    lastPtrType = e.pointerType || 'mouse';
    // A drag's leftover click arrives before the next press or not at all -- a finger that
    // dragged leaves no click behind, and the stale flag would eat the next honest tap.
    // 拖动残留的那下点击,要么赶在下一次按下之前到,要么根本不来 ——
    // 拖过的手指不留点击,这面过期的旗子会吃掉下一次老实的轻点。
    clickWasDrag = false;
    if (tool !== 'pick' || editing || e.button !== 0) return;
    const L = layers.get(pageNo);
    if (ed.isDropped(L.st)) return;
    const [x, y] = pointIn(pageNo, e);
    const hit = hitAt(L.st, x, y);
    if (!hit) return;
    drag = { pageNo, obj: hit, sx: x, sy: y, dx: 0, dy: 0, moved: false, ptrId: e.pointerId };
    // Only a mouse press is defused here. WebKit answers a defused touch by never sending the
    // tap's click, and the click is how a finger selects at all; what keeps a touch from
    // scrolling is the selection box's own touch-action, not this.
    // 这里只拆鼠标按下的引信。WebKit 对被拆了引信的触摸,回应是不再送出这一点的 click,
    // 而 click 正是手指赖以选中的全部;不让触摸变成滚动的,是选中框自己的 touch-action,不是这句。
    if (e.pointerType === 'mouse') e.preventDefault();
  }

  /** Begin a corner drag: the opposite corner holds still, the proportions hold themselves.
   *  开始捏角拖动:对角按住不动,比例自己守着自己。 */
  function startResize(pageNo, ev) {
    if (!selection?.obj?.added) return;
    const [x, y] = pointIn(pageNo, ev);
    drag = {
      mode: 'resize', pageNo, obj: selection.obj,
      sx: x, sy: y, dx: 0, dy: 0, moved: false, box0: [...selection.obj.box],
      ptrId: ev.pointerId,
    };
  }

  function onDragMove(e) {
    if (!drag) return;
    const [x, y] = pointIn(drag.pageNo, e);
    drag.dx = x - drag.sx;
    drag.dy = y - drag.sy;
    // The finger's stream is pinned to the layer at the first real move -- the box under it is
    // about to be redrawn, and an uncaptured pointer would land on whatever replaced it. Not at
    // the press: a press captured that early costs WebKit the tap's click.
    // 手指的事件流在第一次真移动时才钉到层上 —— 指下的框马上要被重画,
    // 没被捕获的指针会落到顶替它的东西上。不在按下时钉:钉得那么早,WebKit 会把这一点的 click 赔进去。
    if (!drag.moved && e.pointerType !== 'mouse' && Math.abs(drag.dx) + Math.abs(drag.dy) > 1.5) {
      try { layers.get(drag.pageNo)?.el.setPointerCapture(drag.ptrId); } catch { /* synthetic pointers have no capture / 合成指针没有捕获可言 */ }
    }
    if (drag.mode === 'resize') {
      const [x0, y0, x1, y1] = drag.box0;
      const w0 = x1 - x0;
      const s = Math.max(0.05, (w0 + drag.dx) / w0);
      drag.ghostBox = [x0, y1 - (y1 - y0) * s, x0 + w0 * s, y1];
      if (!drag.moved && Math.abs(drag.dx) + Math.abs(drag.dy) > 1.5) drag.moved = true;
      if (drag.moved) paintLayer(drag.pageNo);
      return;
    }
    // Shift makes the drag honest about one axis: whichever way it mostly goes is the only way
    // it goes at all.
    // 按住 Shift,这次拖动就只认一条轴:主要往哪边走,就只往哪边走。
    if (e.shiftKey) {
      if (Math.abs(drag.dx) >= Math.abs(drag.dy)) drag.dy = 0;
      else drag.dx = 0;
    }
    if (!drag.moved && Math.abs(drag.dx) + Math.abs(drag.dy) > 1.5) {
      drag.moved = true;
      layers.get(drag.pageNo)?.el.classList.add('grabbing');
    }
    if (drag.moved) paintLayer(drag.pageNo);
  }

  function onDragUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    const L = layers.get(d.pageNo);
    L?.el.classList.remove('grabbing');
    if (d.mode === 'resize') {
      if (!d.moved || !d.ghostBox) return;
      clickWasDrag = true;
      const e0 = d.obj.edit;
      const g = e0.img;
      const b = d.ghostBox;
      g.x = b[0];
      g.y = b[1];
      g.w = b[2] - b[0];
      g.h = b[3] - b[1];
      e0.box = [...b];
      e0.fresh = true;
      selection = { pageNo: d.pageNo, obj: d.obj };
      changed(d.pageNo);
      return;
    }
    if (!d.moved || (!d.dx && !d.dy)) return;
    clickWasDrag = true;
    if (d.obj.added) {
      // A pending addition owns its coordinates outright; moving it is editing the note.
      // 一笔未落地的新增,坐标就是它自己的;挪动它,就是改那张便条。
      const e0 = d.obj.edit;
      e0.box = [e0.box[0] + d.dx, e0.box[1] + d.dy, e0.box[2] + d.dx, e0.box[3] + d.dy];
      if (e0.write?.tm) {
        const m = e0.write.tm;
        e0.write.tm = [m[0], m[1], m[2], m[3], m[4] + d.dx, m[5] + d.dy];
      }
      if (e0.img) { e0.img.x += d.dx; e0.img.y += d.dy; }
      e0.fresh = true;
    } else {
      const got = ed.move(L.st, d.obj, d.dx, d.dy);
      if (got) got.fresh = true;
    }
    selection = { pageNo: d.pageNo, obj: d.obj };
    changed(d.pageNo);
  }

  function onClick(pageNo, e) {
    if (editing) return;
    // The click a finished drag leaves behind is the tail of the drag, not a choice.
    // 一次拖动结束时残留的那下点击,是拖动的尾巴,不是一次选择。
    if (clickWasDrag) { clickWasDrag = false; return; }
    const L = layers.get(pageNo);
    if (ed.isDropped(L.st)) return;
    const [x, y] = pointIn(pageNo, e);
    if (tool === 'text') {
      openEditor(pageNo, null, '', [x, y]);
      return;
    }
    if (tool === 'image' && pendingImage) {
      placeImage(pageNo, x, y);
      return;
    }
    const hit = hitAt(L.st, x, y);
    // Touch has no double-click, so the second tap serves: tapping the text that is already
    // selected opens it for typing. / 触摸没有双击,于是第二下顶上:
    // 再点一下已经选中的那段文字,就把它打开来改。
    if (lastPtrType !== 'mouse' && hit && hit === selection?.obj && editText(pageNo, hit)) return;
    select(hit ? { pageNo, obj: hit } : null);
  }

  /** The picture lands centred on the click, at most half the page wide, pixels read as points.
   *  图落在点击处的正中,至多占半页宽;像素按点来读。 */
  function placeImage(pageNo, x, y) {
    const L = layers.get(pageNo);
    const img = pendingImage;
    const w = pendingWidth(L.st);
    const h = (w * img.h) / img.w;
    clearPending();
    tool = 'pick';
    const edit = ed.addImage(L.st, { bytes: img.bytes, mime: img.mime, x: x - w / 2, y: y - h / 2, w, h });
    edit.fresh = true;
    selection = { pageNo, obj: ghostOf(edit) };
    changed(pageNo);
  }

  function onDouble(pageNo, e) {
    if (tool !== 'pick' || editing) return;
    const L = layers.get(pageNo);
    if (ed.isDropped(L.st)) return;
    const [x, y] = pointIn(pageNo, e);
    editText(pageNo, hitAt(L.st, x, y));
  }

  /** Open the words behind a text object for typing, fresh addition or original alike.
   *  把一个文字对象背后的字打开来改,新加的与原有的一视同仁。 */
  function editText(pageNo, hit) {
    if (!hit || hit.kind !== 'text') return false;
    if (hit.added) openEditor(pageNo, hit, hit.edit.write.text, null);
    else openEditor(pageNo, hit, ed.textOf(layers.get(pageNo).st, hit) ?? '', null);
    return true;
  }

  function select(next) {
    selection = next;
    paintBar();
    for (const n of layers.keys()) paintLayer(n);
  }

  /**
   * What the layer shows: an outline under the pointer, a firmer one around the selection, a
   * mark over everything already changed, and a little bar of things to do to what is selected.
   *
   * 这一层显示的东西:指针底下的一圈描边、选中之物周围更实的一圈、
   * 已经被改过的每样东西上面的一个记号,以及一小条"可以对选中之物做的事"。
   */
  const at = (r) => `left:${r.left}%;top:${r.top}%;width:${r.width}%;height:${r.height}%`;

  function paintLayer(pageNo) {
    const L = layers.get(pageNo);
    if (!L) return;
    const parts = [];
    // Marks are shown only while a change has not yet reached the drawn page. Once the page is
    // redrawn with the change in it, the page itself is the evidence, and a mark that stayed
    // would say the thing is still half-done when it is done.
    // 记号只在"改动还没落到画出来的页面上"时显示。页面按含着改动的文档重画之后,
    // 页面本身就是凭据 —— 一个赖着不走的记号,会把办完的事说成办到一半。
    for (const e of L.st.edits) {
      if (!e.fresh) continue;
      const b = e.what === 'add' ? e.box : e.obj?.box;
      if (!b) continue;
      const r = rectOf(pageNo, b);
      parts.push(`<div class="${e.what === 'remove' ? 'pdfe-gone' : 'pdfe-was'}" style="${at(r)}"></div>`);
    }
    // A drag in flight shows where the thing would land -- or, resizing, how large it would be.
    // 一次进行中的拖动,显示这样东西将会落在哪里 —— 缩放时,则显示它将会有多大。
    if (drag?.pageNo === pageNo && drag.moved && (drag.ghostBox || drag.obj.box)) {
      const b = drag.ghostBox
        || [drag.obj.box[0] + drag.dx, drag.obj.box[1] + drag.dy, drag.obj.box[2] + drag.dx, drag.obj.box[3] + drag.dy];
      parts.push(`<div class="pdfe-ghost" style="${at(rectOf(pageNo, b))}"></div>`);
    }
    if (hover?.pageNo === pageNo && hover.obj !== selection?.obj && hover.obj.box) {
      const r = rectOf(pageNo, hover.obj.box);
      parts.push(`<div class="pdfe-hover" style="${at(r)}"></div>`);
    }
    if (selection?.pageNo === pageNo && selection.obj.box) {
      const r = rectOf(pageNo, selection.obj.box);
      parts.push(`<div class="pdfe-sel" style="${at(r)}"></div>`);
      parts.push(`<div class="pdfe-act" style="left:${r.left}%;top:${r.top}%">
        <span class="what">${esc(t('pdfe_kind_' + selection.obj.kind))}</span>
      </div>`);
      // A placed picture grows and shrinks by its corner, the proportions its own.
      // 放上去的图,捏着角放大缩小,比例是它自己的。
      if (selection.obj.added && selection.obj.kind === 'image') {
        parts.push(`<div class="pdfe-grip" style="left:${r.left + r.width}%;top:${r.top + r.height}%"></div>`);
      }
    }
    // The page's own two verbs, at its corner -- and, struck from the document, its shroud with
    // the one verb left: coming back.
    // 这一页自己的两个动词,停在页角 —— 而被划掉之后,盖上罩,只剩一个动词:回来。
    if (ed.isDropped(L.st)) {
      parts.push(`<div class="pdfe-pagegone">
        <button data-pg="restore">${icon('restore', 16)}<span>${esc(t('pdfe_page_restore'))}</span></button>
      </div>`);
    } else {
      parts.push(`<div class="pdfe-pagectl">
        <button data-pg="rot" title="${esc(t('pdfe_rotate'))}">${icon('refresh', 15)}</button>
        <button data-pg="del" title="${esc(t('pdfe_page_del'))}" ${ed.liveCount <= 1 ? 'disabled' : ''}>${icon('trash', 15)}</button>
      </div>`);
    }
    L.el.innerHTML = parts.join('');
    const grip = L.el.querySelector('.pdfe-grip');
    if (grip) {
      grip.onpointerdown = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        startResize(pageNo, ev);
      };
    }
    L.el.querySelectorAll('[data-pg]').forEach((b) => {
      b.onpointerdown = (ev) => ev.stopPropagation();
      b.onclick = (ev) => {
        ev.stopPropagation();
        pageAction(pageNo, b.dataset.pg);
      };
    });
    if (editing?.pageNo === pageNo) L.el.appendChild(editing.el);
    // The placing preview survives a layer repaint the same way the typing box does.
    // 放置预览挺过一次层重画的方式,和打字框一样。
    if (placeEl && placePage === pageNo && tool === 'image' && pendingImage) L.el.appendChild(placeEl);
  }

  /** Turn, strike, or bring back one page. All three are ordinary notes underneath, so undo,
   *  the dirty flag and the save already know about them.
   *  转一页、划掉一页,或把它带回来。三者在底下都是普通便条,
   *  于是撤销、脏标记和保存本来就认得它们。 */
  function pageAction(pageNo, act) {
    const L = layers.get(pageNo);
    if (act === 'rot') {
      const e = ed.rotatePage(L.st);
      e.fresh = false;
      select(null);
      changed(pageNo);
      return;
    }
    if (act === 'del') {
      if (ed.liveCount <= 1) return;
      ed.dropPage(L.st);
      select(null);
      paintBar();
      for (const n of layers.keys()) paintLayer(n);
      return;
    }
    if (act === 'restore') {
      const e = L.st.edits.find((x) => x.what === 'droppage');
      if (e) ed.undo(L.st, e);
      paintBar();
      for (const n of layers.keys()) paintLayer(n);
    }
  }

  // ---------- changing things ----------

  /** Strike a thing from the page. A pending addition is not struck but withdrawn -- the note
   *  that would have added it is dropped, and nothing of it remains anywhere.
   *  把一样东西从页面上划掉。未落地的新增不是被划掉而是被撤回 ——
   *  那张本要添上它的便条被丢弃,它在任何地方都不再留下什么。 */
  function removeSelected() {
    if (!selection) return;
    const L = layers.get(selection.pageNo);
    if (selection.obj.added) {
      ed.undo(L.st, selection.obj.edit);
    } else {
      const e = ed.remove(L.st, selection.obj);
      if (e) e.fresh = true;
    }
    changed(selection.pageNo);
    select(null);
  }

  /** Take back the last change, whichever page it was on -- including a page that has since been
   *  scrolled away from, which has no layer here but still has its changes in the engine.
   *  收回最后一次改动,不管它在哪一页 —— 包括一页已经被滚走了的:
   *  它在这里没有层了,但它的改动仍在引擎里。 */
  async function undo() {
    const last = ed.changes[ed.changes.length - 1];
    if (!last) return;
    ed.undo(await ed.page(last.page));
    changed(last.page + 1);
    select(null);
  }

  /**
   * The box you type in.
   *
   * Laid over the words it is replacing, at the size they were drawn, so that what is being
   * changed is plain without a dialogue having to say it. A new box has nothing under it and
   * shows a caret where the page was clicked.
   *
   * 你打字的那个框。
   *
   * 盖在它要顶替的那些字上面,大小照它们被画出来时的大小,
   * 于是"正在改的是什么"不必靠一个对话框来说明。一个新框底下什么都没有,
   * 在页面被点中的地方显示一个光标。
   */
  function openEditor(pageNo, obj, text, at) {
    const L = layers.get(pageNo);
    const run = obj?.runs?.find((r) => r.box) || null;
    const k = pixelsPerPoint(pageNo);
    const pt = obj?.added ? obj.edit.write.size : run ? run.size : NEW_TEXT_SIZE;
    const size = Math.max(9, Math.abs(pt * k));
    const r = obj?.box ? rectOf(pageNo, obj.box) : rectOf(pageNo, [at[0], at[1], at[0], at[1]]);
    const el = document.createElement('div');
    el.className = 'pdfe-type';
    el.contentEditable = 'plaintext-only';
    el.spellcheck = false;
    el.innerText = text;
    el.style.left = r.left + '%';
    el.style.top = obj ? r.top + '%' : `calc(${r.top}% - ${size}px)`;
    el.style.minWidth = obj ? r.width + '%' : '140px';
    el.style.fontSize = size + 'px';
    el.style.textAlign = obj?.added ? (obj.edit.align || 'left') : align;
    // A new box hangs from the click the way the alignment says: by its left edge, its centre,
    // or its right edge. / 新框按对齐所说的方式挂在点击处:挂左缘、挂中心,或挂右缘。
    if (!obj && align !== 'left') el.style.transform = `translateX(${align === 'center' ? '-50%' : '-100%'})`;
    if (obj) el.style.minHeight = r.height + '%';
    editing = { pageNo, obj, el, at, was: text };
    paintLayer(pageNo);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
      // Enter commits. Shift+Enter breaks the line -- only in a NEW box, where the block's own
      // layout is this editor's to decide; a rewritten block keeps the shape its page gave it.
      // 回车表示写完了。Shift+回车换行 —— 只在"新框"里,那一块怎么排是这个编辑器说了算;
      // 重写的块保持它那一页给它的形状。
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeEditor(true); }
    };
  }

  /** A press outside the box commits it; inside, the caret goes where it is put. Without this
   *  the box died on the first click into it, which made placing a caret impossible.
   *  在框外按下,等于写完了;在框里,光标点到哪儿就到哪儿。
   *  没有这一条,框会死在点进它的第一下上 —— 想放个光标都不可能。 */
  function onDocDown(e) {
    if (!editing) return;
    if (editing.el.contains(e.target)) return;
    // The bar is not "outside": a press there means the box AND the button -- switching the
    // alignment of what is being typed, most of all. Actions that need the text committed
    // commit it themselves.
    // 工具条不算"外面":按在那里,要的是框与按钮两个都在 —— 首先就是给正在打的字换对齐。
    // 需要文字先落定的动作,会自己去落定它。
    if (bar.contains(e.target)) return;
    closeEditor(true);
  }

  async function closeEditor(commit) {
    if (!editing) return;
    const { pageNo, obj, el, at, was } = editing;
    // innerText keeps the line breaks textContent flattens; a rewritten block is one line by
    // nature, so its breaks become spaces.
    // innerText 留得住 textContent 会抹平的换行;重写的块天生是一行,它的换行就化作空格。
    const raw = el.innerText.replace(/\s+$/, '');
    const text = obj && !obj.added ? raw.replace(/\n+/g, ' ') : raw;
    editing = null;
    const L = layers.get(pageNo);
    const committing = commit && text && text !== was;
    // The tool disarms before the first await, not after: the press that carried this commit
    // sends its click while the font work is still running, and an armed tool would answer
    // that click with a fresh empty box.
    // 工具要在第一个 await 之前收回,而不是之后:载着这次落定的那一按,
    // 会在字体的活儿还没干完时把 click 送到;一件还架着的工具,会用一个崭新的空框去应它。
    if (committing && !obj) tool = 'pick';
    if (committing) {
      let got;
      if (obj?.added) {
        // Re-typing a pending box is withdrawing the note and writing a fresh one in its place,
        // aligned the way the bar says now -- the reader who just picked an alignment meant it.
        // 重打一个未落地的框,就是撤回那张便条,在原处另写一张新的,
        // 按工具条此刻所说的方式对齐 —— 刚选了对齐的那位读者,选的就是这个意思。
        const e0 = obj.edit;
        ed.undo(L.st, e0);
        got = await ed.addText(L.st, {
          text, x: e0.write.tm[4], y: e0.write.tm[5], size: e0.write.size, align,
        });
      } else if (obj) {
        got = await ed.retype(L.st, obj, text, align);
      } else {
        got = await ed.addText(L.st, { text, x: at[0], y: at[1], size: NEW_TEXT_SIZE, align });
      }
      note = got ? layerNote(got.layer) : t('pdfe_nofont');
      if (got) {
        got.fresh = true;
        changed(pageNo);
      }
    }
    select(null);
    paintBar();
    paintLayer(pageNo);
  }

  /** Which of the four places the font came from, said plainly, because a reader deserves to know
   *  whether they are still writing in the document's own typeface or in a stand-in.
   *  这款字来自那四个地方中的哪一个,直说 ——
   *  因为读者有权知道自己此刻是仍在用文档自己的字面写,还是在用一个替身。 */
  function layerNote(layer) {
    if (layer === LAYERS.OWN) return t('pdfe_font_own');
    if (layer === LAYERS.ORIGINAL) return t('pdfe_font_found');
    return t('pdfe_font_sub');
  }

  function changed(pageNo) {
    dirtyPages.add(pageNo);
    onDirty?.(ed.changes.length);
    paintBar();
    for (const n of layers.keys()) paintLayer(n);
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(redraw, REDRAW_AFTER);
  }

  /** Hand the viewer a document that has the changes in it, and let it draw the pages that moved.
   *  把一份含有这些改动的文档交给查看器,让它去画那些变了的页。 */
  async function redraw() {
    const pages = [...dirtyPages];
    dirtyPages.clear();
    try {
      // The preview's document keeps removed pages in place, shrouded -- real removal would
      // renumber every page under the holders. Only the save builds without them.
      // 预览用的文档让被删的页蒙着罩留在原地 —— 真删会把每个页格底下的页码都挪一遍。
      // 只有保存时才搭一份没有它们的。
      await viewer.swapDoc(await ed.build({ keepRemoved: true }));
      for (const n of pages) await viewer.repaint(n);
      // The changes are on the page now; the marks that stood in for them stand down.
      // 改动如今已在页面上;那些替它们站岗的记号就此撤哨。
      for (const L of layers.values()) for (const e of L.st.edits) delete e.fresh;
      for (const n of layers.keys()) paintLayer(n);
    } catch {
      note = t('pdfe_redraw_fail');
      paintBar();
    }
  }

  async function save() {
    bar.classList.add('busy');
    try {
      const out = await ed.build();
      await ui.saveAs(out);
    } finally {
      bar.classList.remove('busy');
    }
  }

  function keys(e) {
    if (editing) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(); return true; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { undo(); return true; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      if (ed.changes.length) save();
      return true;
    }
    if (e.key === 'Escape' && selection) { select(null); return true; }
    return false;
  }

  const api = {
    attach,
    keys,
    get changeCount() { return ed.changes.length; },
    /** Repaint the bar when a fact it shows changed outside this module -- the password, say.
     *  当工具条展示的某个事实在本模块之外变了 —— 比如密码 —— 就重画它。 */
    refresh: paintBar,
    close() { ui.exit(); },
    destroy() {
      clearTimeout(redrawTimer);
      closeAssets();
      clearPending();
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('pointermove', onDragMove);
      document.removeEventListener('pointerup', onDragUp);
      document.removeEventListener('pointercancel', onDragUp);
      bar.remove();
      for (const L of layers.values()) L.el.remove();
      layers.clear();
    },
  };
  return api;
}
