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

  let tool = 'pick';                 // pick | text
  let selection = null;              // { pageNo, obj }
  let hover = null;
  let redrawTimer = 0;
  const dirtyPages = new Set();
  const layers = new Map();          // pageNo -> { el, page, scale, state }
  let note = null;                   // the last thing worth telling the reader about a font
  let editing = null;                // the open inline editor, if any

  const bar = document.createElement('div');
  bar.className = 'pdfe-bar';
  box.parentElement.insertBefore(bar, box);
  paintBar();

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
    bar.innerHTML = `
      <div class="pdfe-tools">
        <button class="pdfe-t${tool === 'pick' ? ' on' : ''}" data-tool="pick" title="${esc(t('pdfe_pick'))}">${icon('select', 18)}</button>
        <button class="pdfe-t${tool === 'text' ? ' on' : ''}" data-tool="text" title="${esc(t('pdfe_addtext'))}">${icon('textFormat', 18)}</button>
        <span class="pdfe-sep"></span>
        <button class="pdfe-t" data-act="delete" ${selection ? '' : 'disabled'} title="${esc(t('pdfe_delete'))}">${icon('trash', 18)}</button>
        <button class="pdfe-t" data-act="undo" ${canUndo ? '' : 'disabled'} title="${esc(t('pdfe_undo'))}">${icon('restore', 18)}</button>
      </div>
      <div class="pdfe-say">${note ? esc(note) : ''}</div>
      <div class="pdfe-tools">
        ${localfont.available() && !localfont.isOpen()
          ? `<button class="pdfe-t wide" data-act="fonts" title="${esc(t('pdfe_fonts_why'))}">${icon('textFormat', 16)}<span>${esc(t('pdfe_fonts'))}</span></button>` : ''}
        <button class="pdfe-t wide primary" data-act="save" ${canUndo ? '' : 'disabled'}>${icon('check', 16)}<span>${esc(t('pdfe_save'))}</span></button>
        <button class="pdfe-t wide" data-act="close">${icon('close', 16)}<span>${esc(t('pdfe_done'))}</span></button>
      </div>`;
  }

  bar.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) { tool = b.dataset.tool; select(null); paintBar(); return; }
    const act = b.dataset.act;
    if (act === 'delete') removeSelected();
    else if (act === 'undo') await undo();
    else if (act === 'fonts') await openFonts();
    else if (act === 'save') await save();
    else if (act === 'close') api.close();
  };

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
    el.onmousemove = (e) => onMove(pageNo, e);
    el.onmouseleave = () => { hover = null; paintLayer(pageNo); };
    el.onclick = (e) => onClick(pageNo, e);
    el.ondblclick = (e) => onDouble(pageNo, e);
    paintLayer(pageNo);
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
    if (tool !== 'pick' || editing) return;
    const L = layers.get(pageNo);
    const [x, y] = pointIn(pageNo, e);
    const hit = objectsAt(L.st.objects, x, y)[0] || null;
    if (hit === hover?.obj) return;
    hover = hit ? { pageNo, obj: hit } : null;
    paintLayer(pageNo);
  }

  function onClick(pageNo, e) {
    if (editing) return;
    const [x, y] = pointIn(pageNo, e);
    if (tool === 'text') {
      openEditor(pageNo, null, '', [x, y]);
      return;
    }
    const L = layers.get(pageNo);
    const hit = objectsAt(L.st.objects, x, y)[0] || null;
    select(hit ? { pageNo, obj: hit } : null);
  }

  function onDouble(pageNo, e) {
    if (tool !== 'pick' || editing) return;
    const L = layers.get(pageNo);
    const [x, y] = pointIn(pageNo, e);
    const hit = objectsAt(L.st.objects, x, y)[0];
    if (hit?.kind === 'text') openEditor(pageNo, hit, ed.textOf(L.st, hit) ?? '', null);
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
    for (const e of L.st.edits) {
      if (e.what === 'remove') {
        const r = rectOf(pageNo, e.obj.box || [0, 0, 0, 0]);
        parts.push(`<div class="pdfe-gone" style="${at(r)}"></div>`);
      } else if (e.what === 'retype' && e.obj.box) {
        const r = rectOf(pageNo, e.obj.box);
        parts.push(`<div class="pdfe-was" style="${at(r)}"></div>`);
      }
    }
    if (hover?.pageNo === pageNo && hover.obj !== selection?.obj && hover.obj.box) {
      const r = rectOf(pageNo, hover.obj.box);
      parts.push(`<div class="pdfe-hover" style="${at(r)}"></div>`);
    }
    if (selection?.pageNo === pageNo && selection.obj.box) {
      const r = rectOf(pageNo, selection.obj.box);
      const readable = selection.obj.kind === 'text' && ed.textOf(L.st, selection.obj) !== null;
      parts.push(`<div class="pdfe-sel" style="${at(r)}"></div>`);
      parts.push(`<div class="pdfe-act" style="left:${r.left}%;top:${r.top}%">
        <span class="what">${esc(t('pdfe_kind_' + selection.obj.kind))}</span>
        ${readable ? `<button data-do="edit" title="${esc(t('pdfe_retype'))}">${icon('pencil', 15)}</button>` : ''}
        <button data-do="del" title="${esc(t('pdfe_delete'))}">${icon('trash', 15)}</button>
      </div>`);
    }
    L.el.innerHTML = parts.join('');
    const act = L.el.querySelector('.pdfe-act');
    if (act) {
      act.onclick = (e) => {
        e.stopPropagation();
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.do === 'del') removeSelected();
        else openEditor(pageNo, selection.obj, ed.textOf(L.st, selection.obj) ?? '', null);
      };
    }
    if (editing?.pageNo === pageNo) L.el.appendChild(editing.el);
  }

  // ---------- changing things ----------

  function removeSelected() {
    if (!selection) return;
    const L = layers.get(selection.pageNo);
    ed.remove(L.st, selection.obj);
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
    const size = Math.max(9, Math.abs((run ? run.size : NEW_TEXT_SIZE) * k));
    const r = obj?.box ? rectOf(pageNo, obj.box) : rectOf(pageNo, [at[0], at[1], at[0], at[1]]);
    const el = document.createElement('div');
    el.className = 'pdfe-type';
    el.contentEditable = 'plaintext-only';
    el.spellcheck = false;
    el.textContent = text;
    el.style.left = r.left + '%';
    el.style.top = obj ? r.top + '%' : `calc(${r.top}% - ${size}px)`;
    el.style.minWidth = obj ? r.width + '%' : '140px';
    el.style.fontSize = size + 'px';
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
      // Enter commits. A line break inside a PDF text object is not a character but another
      // text object, so there is nothing sensible for it to mean here.
      // 回车表示写完了。PDF 的文本对象里,换行不是一个字符而是另一个文本对象,
      // 所以在这里它没有什么说得通的含义。
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeEditor(true); }
    };
    el.onblur = () => closeEditor(true);
  }

  async function closeEditor(commit) {
    if (!editing) return;
    const { pageNo, obj, el, at, was } = editing;
    const text = el.textContent.replace(/\s+$/, '');
    editing = null;
    const L = layers.get(pageNo);
    if (commit && text && text !== was) {
      const got = obj
        ? await ed.retype(L.st, obj, text)
        : await ed.addText(L.st, { text, x: at[0], y: at[1], size: NEW_TEXT_SIZE });
      note = got ? layerNote(got.layer) : t('pdfe_nofont');
      if (got) changed(pageNo);
      if (!obj) { tool = 'pick'; }
    }
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
      await viewer.swapDoc(await ed.build());
      for (const n of pages) await viewer.repaint(n);
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
    if (e.key === 'Escape' && selection) { select(null); return true; }
    return false;
  }

  const api = {
    attach,
    keys,
    get changeCount() { return ed.changes.length; },
    close() { ui.exit(); },
    destroy() {
      clearTimeout(redrawTimer);
      bar.remove();
      for (const L of layers.values()) L.el.remove();
      layers.clear();
    },
  };
  return api;
}
