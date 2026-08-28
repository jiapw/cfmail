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
  let drag = null;                   // { pageNo, obj, sx, sy, dx, dy, moved }
  let clickWasDrag = false;          // the click a finished drag leaves behind must not select

  const bar = document.createElement('div');
  bar.className = 'pdfe-bar';
  if (ui.barHost) ui.barHost.appendChild(bar);
  else box.parentElement.insertBefore(bar, box);
  paintBar();

  // Three things only the document can hear: a press outside the typing box commits it, and a
  // drag keeps following the pointer after it has left the page that started it.
  // 只有 document 听得到的三件事:在打字框外按下,等于写完了;
  // 一次拖动在指针离开起始页之后,仍要继续跟着它。
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragUp);

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
    const alignBtn = (a) => `<button class="pdfe-t${align === a ? ' on' : ''}" data-align="${a}"
      title="${esc(t('tt_align_' + a))}">${icon('align' + a[0].toUpperCase() + a.slice(1), 18)}</button>`;
    bar.innerHTML = `
      <div class="pdfe-tools">
        <button class="pdfe-t${tool === 'pick' ? ' on' : ''}" data-tool="pick" title="${esc(t('pdfe_pick'))}">${icon('select', 18)}</button>
        <button class="pdfe-t${tool === 'text' ? ' on' : ''}" data-tool="text" title="${esc(t('pdfe_addtext'))}">${icon('textFormat', 18)}</button>
        <button class="pdfe-t${tool === 'image' ? ' on' : ''}" data-act="image" title="${esc(t('tt_image'))}">${icon('image', 18)}</button>
        <span class="pdfe-sep"></span>
        ${alignBtn('left')}${alignBtn('center')}${alignBtn('right')}
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
    if (b.dataset.tool) { tool = b.dataset.tool; pendingImage = null; select(null); paintBar(); return; }
    if (b.dataset.align) {
      align = b.dataset.align;
      // The open box follows at once; the page follows when it is committed.
      // 开着的框立刻跟上;页面等它写完时再跟。
      if (editing && !editing.obj) editing.el.style.textAlign = align;
      paintBar();
      return;
    }
    const act = b.dataset.act;
    if (act === 'delete') removeSelected();
    else if (act === 'undo') await undo();
    else if (act === 'image') await pickImage();
    else if (act === 'fonts') await openFonts();
    else if (act === 'save') await save();
    else if (act === 'close') api.close();
  };

  /**
   * Choose a picture, then a place for it. The picker is the browser's own; the place is the
   * next click on a page. PNG and JPEG go in as they are -- those are the two shapes a PDF can
   * hold -- and anything else is redrawn into a PNG first.
   *
   * 先挑一张图,再挑它落脚的地方。挑图用浏览器自己的;落脚点是下一次在页面上的点击。
   * PNG 和 JPEG 原样放进去 —— PDF 装得下的就这两种 —— 其余的先重画成一张 PNG。
   */
  async function pickImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const bmp = await createImageBitmap(f);
        let bytes;
        let mime;
        if (f.type === 'image/png' || f.type === 'image/jpeg') {
          bytes = new Uint8Array(await f.arrayBuffer());
          mime = f.type;
        } else {
          const c = document.createElement('canvas');
          c.width = bmp.width;
          c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
          if (!blob) return;
          bytes = new Uint8Array(await blob.arrayBuffer());
          mime = 'image/png';
        }
        pendingImage = { bytes, mime, w: bmp.width, h: bmp.height };
        tool = 'image';
        select(null);
        paintBar();
      } catch { /* a file that is not a picture places nothing / 不是图的文件放不出东西 */ }
    };
    input.click();
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
    el.onmousemove = (e) => onMove(pageNo, e);
    el.onmouseleave = () => { hover = null; paintLayer(pageNo); };
    el.onmousedown = (e) => onDown(pageNo, e);
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
    if (tool !== 'pick' || editing || drag) return;
    const L = layers.get(pageNo);
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
    if (tool !== 'pick' || editing || e.button !== 0) return;
    const L = layers.get(pageNo);
    const [x, y] = pointIn(pageNo, e);
    const hit = hitAt(L.st, x, y);
    if (!hit) return;
    drag = { pageNo, obj: hit, sx: x, sy: y, dx: 0, dy: 0, moved: false };
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!drag) return;
    const [x, y] = pointIn(drag.pageNo, e);
    drag.dx = x - drag.sx;
    drag.dy = y - drag.sy;
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
    select(hit ? { pageNo, obj: hit } : null);
  }

  /** The picture lands centred on the click, at most half the page wide, pixels read as points.
   *  图落在点击处的正中,至多占半页宽;像素按点来读。 */
  function placeImage(pageNo, x, y) {
    const L = layers.get(pageNo);
    const img = pendingImage;
    pendingImage = null;
    tool = 'pick';
    const pageW = L.st.width || 612;
    const w = Math.min(img.w * 0.75, pageW / 2);
    const h = (w * img.h) / img.w;
    const edit = ed.addImage(L.st, { bytes: img.bytes, mime: img.mime, x: x - w / 2, y: y - h / 2, w, h });
    edit.fresh = true;
    selection = { pageNo, obj: ghostOf(edit) };
    changed(pageNo);
  }

  function onDouble(pageNo, e) {
    if (tool !== 'pick' || editing) return;
    const L = layers.get(pageNo);
    const [x, y] = pointIn(pageNo, e);
    const hit = hitAt(L.st, x, y);
    if (hit?.added && hit.kind === 'text') openEditor(pageNo, hit, hit.edit.write.text, null);
    else if (hit?.kind === 'text' && !hit.added) openEditor(pageNo, hit, ed.textOf(L.st, hit) ?? '', null);
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
    // A drag in flight shows where the thing would land.
    // 一次进行中的拖动,显示这样东西将会落在哪里。
    if (drag?.pageNo === pageNo && drag.moved && drag.obj.box) {
      const b = drag.obj.box;
      const r = rectOf(pageNo, [b[0] + drag.dx, b[1] + drag.dy, b[2] + drag.dx, b[3] + drag.dy]);
      parts.push(`<div class="pdfe-ghost" style="${at(r)}"></div>`);
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
    }
    L.el.innerHTML = parts.join('');
    if (editing?.pageNo === pageNo) L.el.appendChild(editing.el);
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
    el.style.textAlign = obj?.added ? (obj.edit.align || 'left') : obj ? '' : align;
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
    if (commit && text && text !== was) {
      let got;
      if (obj?.added) {
        // Re-typing a pending box is withdrawing the note and writing a fresh one in its place.
        // 重打一个未落地的框,就是撤回那张便条,在原处另写一张新的。
        const e0 = obj.edit;
        ed.undo(L.st, e0);
        got = await ed.addText(L.st, {
          text, x: e0.write.tm[4], y: e0.write.tm[5], size: e0.write.size, align: e0.align || 'left',
        });
      } else if (obj) {
        got = await ed.retype(L.st, obj, text);
      } else {
        got = await ed.addText(L.st, { text, x: at[0], y: at[1], size: NEW_TEXT_SIZE, align });
      }
      note = got ? layerNote(got.layer) : t('pdfe_nofont');
      if (got) {
        got.fresh = true;
        changed(pageNo);
      }
      if (!obj) { tool = 'pick'; }
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
      await viewer.swapDoc(await ed.build());
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
    close() { ui.exit(); },
    destroy() {
      clearTimeout(redrawTimer);
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragUp);
      bar.remove();
      for (const L of layers.values()) L.el.remove();
      layers.clear();
    },
  };
  return api;
}
