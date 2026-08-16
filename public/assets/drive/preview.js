// Read-only rich previews for the Drive overlay: plain text in the interface font, code in
// monospace, rendered Markdown, docx as a typeset sheet, pptx as slide cards, HTML and MHTML in
// a fully sandboxed iframe (no scripts, no network -- CSP allows data: images only), SVG as an
// image, drawio on canvas. Everything renders into our own scroll container, so the themed
// scrollbars just apply. All renderers fail soft into the "no preview" card.
// 网盘预览层的只读富预览:纯文本用界面字体、代码用等宽、Markdown 渲染、docx 排版成白纸、
// pptx 逐页卡片、HTML/MHTML 进全沙箱 iframe(无脚本无联网 —— CSP 只放行 data: 图片)、
// SVG 按图片渲染、drawio 画到 canvas。全部渲进我们自己的滚动容器,主题滚动条自然生效。
// 任何渲染失败都软着陆到「无法预览」卡片。
import { esc, fileIcon } from '../ui.js';
import { t } from '../i18n.js';
import { renderMarkdown } from '../chat/markdown.js';
import { store } from '../app.js';
import { docxParse, drawioDraw, drawioPages, ext as extOf, kindOf, mhtmlParse } from './doc.js';

export { kindOf };

// The pptx engine is the heaviest parser by far -- it loads only when a pptx is actually opened
// pptx 引擎是最重的解析器。只在真的打开 pptx 时才加载
const loadPptx = () => import('./pptx.js?v=' + encodeURIComponent(store.brand?.version || ''));
const loadSheet = () => import('./sheet.js?v=' + encodeURIComponent(store.brand?.version || ''));

const TXT_CAP = 2 * 1024 * 1024;   // text fetched via Range / 文本走 Range 只取这么多
const DOC_CAP = 80 * 1024 * 1024;  // parseable document ceiling / 可解析文档的大小上限
// pptx files balloon on embedded fonts and video that the lazy unzip never even reads --
// judging them by total size threw away perfectly renderable decks (fonts alone can be 60MB+)
// pptx 的体积常被内嵌字体和视频撑大。而惰性解压根本不会去读那些字节。
// 按总大小一刀切会错杀完全可渲染的文件。光字体就能有 60MB+
const PPTX_CAP = 300 * 1024 * 1024;
// Delimited text is fetched by Range, never whole: a million-row export is a download, not a
// preview, and the first few thousand rows answer the question either way.
// 带分隔符的文本按 Range 取,绝不整取:百万行的导出属于下载而非预览,
// 而无论如何,头几千行就已回答了问题。
const CSV_CAP = 4 * 1024 * 1024;

const noprev = (node) => `
  <div class="noprev" style="margin:auto">${fileIcon(node.name, 72)}<div>${esc(t('drv_no_preview'))}</div></div>`;

// Everything scrolls inside the rounded document window, never at the overlay edge
// 一切滚动都发生在圆角文档窗口内部,绝不挂在遮罩边上
const win = (inner) => `<div class="drv-docwin">${inner}</div>`;

/**
 * Render `kind` for `node` into `box`. Returns { destroy() } to release blob URLs and the like;
 * the caller invokes it when the preview closes or moves to another file.
 * 把 node 按 kind 渲进 box。返回 { destroy() } 供释放 blob URL 等;关闭或翻页时由调用方执行。
 */
export async function renderPreview(node, box, kind, inlineUrl) {
  const urls = [];
  const keepUrl = (blob) => {
    const u = URL.createObjectURL(blob);
    urls.push(u);
    return u;
  };
  const dead = () => !box.isConnected;
  const destroy = () => urls.forEach((u) => URL.revokeObjectURL(u));
  try {
    if (kind === 'txt' || kind === 'code' || kind === 'md') {
      const r = await fetch(inlineUrl, { headers: { Range: `bytes=0-${TXT_CAP - 1}` } });
      if (!r.ok && r.status !== 206) throw new Error('fetch');
      const raw = new TextDecoder().decode(await r.arrayBuffer());
      if (dead()) return { destroy };
      const note = node.size > TXT_CAP
        ? `<div class="drv-trunc">${esc(t('drv_truncated', '2 MB'))}</div>` : '';
      if (kind === 'md') {
        box.innerHTML = win(`${note}<div class="drv-sheet drv-md">${renderMarkdown(raw)}</div>`);
      } else {
        // txt reads in the interface font; code stays monospace, no highlighting by design
        // txt 用界面字体;代码保持等宽,有意不做语法高亮
        box.innerHTML = win(`${note}<pre class="drv-txt ${kind === 'txt' ? 'uif' : 'mono'}"></pre>`);
        box.querySelector('pre').textContent = raw;
      }
      return { destroy };
    }

    if (kind !== 'pptx' && node.size > DOC_CAP) {
      box.innerHTML = noprev(node);
      return { destroy };
    }

    if (kind === 'svg') {
      const r = await fetch(inlineUrl);
      if (!r.ok) throw new Error('fetch');
      // As an <img>, SVG never runs script and never fetches subresources
      // 以 <img> 呈现的 SVG 不执行脚本、不加载子资源
      const u = keepUrl(new Blob([await r.arrayBuffer()], { type: 'image/svg+xml' }));
      if (dead()) return { destroy };
      box.innerHTML = win(`<div class="drv-svgwrap"><img class="drv-svgimg" src="${esc(u)}" alt=""></div>`);
      return { destroy };
    }

    if (kind === 'html' || kind === 'mhtml') {
      const r = await fetch(inlineUrl);
      if (!r.ok) throw new Error('fetch');
      const buf = await r.arrayBuffer();
      let html;
      if (kind === 'mhtml') {
        const parsed = await mhtmlParse(buf);
        if (!parsed) throw new Error('mhtml');
        html = parsed.html;
      } else {
        html = new TextDecoder().decode(buf);
      }
      if (dead()) return { destroy };
      box.innerHTML = `<iframe class="drv-html" sandbox="" title="preview"></iframe>`;
      box.querySelector('iframe').srcdoc = sealHtml(html);
      return { destroy };
    }

    if (kind === 'docx') {
      const r = await fetch(inlineUrl);
      if (!r.ok) throw new Error('fetch');
      const parsed = await docxParse(await r.arrayBuffer());
      if (!parsed || dead()) {
        if (!dead()) box.innerHTML = noprev(node);
        return { destroy };
      }
      box.innerHTML = win(`<div class="drv-sheet drv-docx">${docxHtml(parsed.blocks)}</div>`);
      return { destroy };
    }

    if (kind === 'pptx') {
      if (node.size > PPTX_CAP) {
        box.innerHTML = noprev(node);
        return { destroy };
      }
      const r = await fetch(inlineUrl);
      if (!r.ok) throw new Error('fetch');
      const { pptxParse } = await loadPptx();
      const deck = await pptxParse(await r.arrayBuffer());
      if (!deck || !deck.slides.length || dead()) {
        if (!dead()) box.innerHTML = noprev(node);
        return { destroy };
      }
      box.innerHTML = win('');
      const w = box.firstElementChild;
      for (const slide of deck.slides) {
        if (slide.broken) {
          const bad = document.createElement('div');
          bad.className = 'drv-slidewrap';
          bad.innerHTML = `<div class="drv-slide broken" style="aspect-ratio:${deck.w} / ${deck.h}">
            <span>${esc(t('drv_no_preview'))}</span></div>`;
          w.appendChild(bad);
          continue;
        }
        w.appendChild(await slideEl(slide, deck, keepUrl));
      }
      return { destroy };
    }

    if (kind === 'sheet') {
      const mod = await loadSheet();
      const e = extOf(node.name);
      let book;
      if (e === 'csv' || e === 'tsv' || e === 'tab') {
        const r = await fetch(inlineUrl, { headers: { Range: `bytes=0-${CSV_CAP - 1}` } });
        if (!r.ok && r.status !== 206) throw new Error('fetch');
        const grid = mod.delimitedGrid(mod.decodeText(await r.arrayBuffer()), e);
        book = { sheets: [{ name: node.name }], read: async () => grid };
      } else {
        // Ranged, never whole: opening reads the tail for the directory, then the handful of
        // small parts that name the sheets. The 79 MB sample answers in a few hundred kilobytes
        // and pulls a worksheet -- or a picture -- only when one is actually looked at.
        // 按 Range 读,绝不整取:打开时读文件尾取目录,再读那几个说明"有哪些表"的小部件。
        // 79 MB 的样本几百 KB 就能作答,只有当某张表、某张图真被看时才去拉它。
        // A blob URL is already bytes in this tab, and Chrome answers Range on one by handing
        // back the whole thing -- twelve ranged reads would fetch it twelve times over. Read it
        // once and range over memory. Everything else, including an archive entry served by the
        // streaming worker, ranges over the network as intended.
        // blob URL 的字节已经在本标签页里,而 Chrome 对它的 Range 请求是把整份还回来 ——
        // 十二次 Range 读会把它整取十二遍。读一次,然后在内存上做 Range。
        // 其余情形(包括由流式 worker 供给的压缩包内条目)照常在网络上按 Range 读。
        const src = inlineUrl.startsWith('blob:')
          ? mod.memSource(new Uint8Array(await (await fetch(inlineUrl)).arrayBuffer()))
          : mod.httpSource(inlineUrl, node.size);
        book = await mod.xlsxOpen(src, keepUrl);
      }
      if (!book || dead()) {
        if (!dead()) box.innerHTML = noprev(node);
        return { destroy };
      }
      await mountBook(box, book, mod, dead);
      return { destroy };
    }

    if (kind === 'drawio') {
      const r = await fetch(inlineUrl);
      if (!r.ok) throw new Error('fetch');
      const pages = await drawioPages(new TextDecoder().decode(await r.arrayBuffer()));
      if (!pages.length || dead()) {
        if (!dead()) box.innerHTML = noprev(node);
        return { destroy };
      }
      box.innerHTML = win('');
      const w = box.firstElementChild;
      const width = Math.min(Math.max(320, (box.clientWidth || 900) - 110), 1700);
      let drew = false;
      for (const page of pages) {
        const wrap = document.createElement('div');
        wrap.className = 'drv-canvaspage';
        if (pages.length > 1) {
          const cap = document.createElement('div');
          cap.className = 'drv-pagecap';
          cap.textContent = page.name;
          wrap.appendChild(cap);
        }
        const c = document.createElement('canvas');
        if (drawioDraw(page, c, width, Math.min(devicePixelRatio || 1, 2))) {
          wrap.appendChild(c);
          w.appendChild(wrap);
          drew = true;
        }
      }
      if (!drew) box.innerHTML = noprev(node);
      return { destroy };
    }

    box.innerHTML = noprev(node);
    return { destroy };
  } catch {
    if (!dead()) box.innerHTML = noprev(node);
    return { destroy };
  }
}

// ---------- Spreadsheet ----------
// ---------- 电子表格 ----------

/** Mount a workbook: one tab per sheet when there is more than one, and the grid below. Only
 *  the sheet being looked at is parsed -- switching tabs is what pulls the next one out of the
 *  zip, so a seventeen-sheet book costs one sheet to open.
 *  装载一个工作簿:多于一张表时每表一个标签页,网格在其下。只解析正在看的那一张 ——
 *  切换标签才会把下一张从 zip 里取出来,于是十七张表的簿子只花一张表的代价就能打开。 */
async function mountBook(box, book, mod, dead) {
  const many = book.sheets.length > 1;
  // Tabs below the grid, where a workbook keeps them. Above, they read as a filter applied to
  // the table; below, they read as the pages of the book -- which is what they are.
  // 标签在网格下方,工作簿本来就把它们放在那里。放在上方,它们读作"施加于表格的筛选";
  // 放在下方,它们读作"这本簿子的一页页" —— 而它们正是如此。
  box.innerHTML = win(`
    <div class="drv-gridwrap"><div class="drv-loading"><div class="drv-spin"></div></div></div>
    ${many ? `<div class="drv-sheettabs">${book.sheets.map((s, i) =>
      `<button class="tab${i ? '' : ' on'}" data-s="${i}">${esc(s.name)}</button>`).join('')}</div>` : ''}`);
  const wrap = box.querySelector('.drv-gridwrap');
  const show = async (i) => {
    wrap.innerHTML = `<div class="drv-loading"><div class="drv-spin"></div></div>`;
    let grid = null;
    try {
      grid = await book.read(i);
    } catch { /* one bad sheet must not take the workbook down / 一张坏表不该拖垮整本 */ }
    if (dead()) return;
    wrap.innerHTML = grid && grid.rows.length
      ? mod.gridHtml(grid, grid.cut ? t('drv_sheet_cut', String(grid.rows.length)) : '')
      : `<div class="drv-gridempty">${esc(t('drv_empty_folder'))}</div>`;
  };
  box.querySelectorAll('.drv-sheettabs .tab').forEach((b) => b.addEventListener('click', () => {
    box.querySelectorAll('.drv-sheettabs .tab').forEach((x) => x.classList.toggle('on', x === b));
    show(+b.dataset.s);
  }));
  await show(0);
}

/** Wrap untrusted HTML for the sandboxed iframe: a CSP that allows inline styles and data:
 *  images only. Together with sandbox="" (which already blocks every script) nothing can
 *  execute or phone home -- the same reasoning as the mail body iframe.
 *  给沙箱 iframe 包装不可信 HTML:CSP 只放行内联样式与 data: 图片。配合 sandbox=""
 *  (本身已禁一切脚本),既不能执行也不能外联 —— 与邮件正文 iframe 同一套思路。 */
function sealHtml(html) {
  const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
  // Theme variables cannot cross into the sandboxed document, so the app's scrollbar style is
  // baked in with the CURRENT theme's resolved colours -- the frame scrolls like the rest of
  // the app instead of falling back to the UA default.
  // 主题变量进不了沙箱文档。把应用的滚动条样式连同当前主题的解析色一起烘进去,
  // 让框内滚动条与全站同款,而不是退回 UA 默认。
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
  const thumb = v('--border-2', '#c1c4c9');
  const track = v('--hover', '#f0f1f3');
  const thumbHover = v('--text-3', '#9aa0a6');
  const BASE = `<style>
    body{margin:16px;font-family:system-ui,sans-serif;background:#fff;color:#1f1f1f}img{max-width:100%}
    html{scrollbar-color:${thumb} ${track}}
    ::-webkit-scrollbar{width:18px;height:18px}
    ::-webkit-scrollbar-track{background:${track};border-radius:999px}
    ::-webkit-scrollbar-thumb{background:${thumb};border-radius:999px;border:5px solid transparent;background-clip:content-box}
    ::-webkit-scrollbar-thumb:hover{background:${thumbHover};background-clip:content-box}
    ::-webkit-scrollbar-button{display:none;width:0;height:0}
    ::-webkit-scrollbar-corner{background:transparent}
  </style>`;
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.head.insertAdjacentHTML('afterbegin', CSP + BASE);
    return '<!doctype html>' + doc.documentElement.outerHTML;
  } catch {
    return `<!doctype html><html><head>${CSP}${BASE}</head><body>${html}</body></html>`;
  }
}

function docxHtml(blocks) {
  const out = [];
  let inList = false;
  for (const b of blocks) {
    if (b.kind === 'table') {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push('<table><tbody>');
      for (const row of b.rows) {
        out.push('<tr>' + row.map((c) => `<td>${esc(c).replace(/\n/g, '<br>')}</td>`).join('') + '</tr>');
      }
      out.push('</tbody></table>');
      continue;
    }
    const runs = b.runs.map((r) => {
      let s = esc(r.t);
      if (r.b) s = `<b>${s}</b>`;
      if (r.i) s = `<i>${s}</i>`;
      // Restore the document's own sizes: the 820px sheet stands in for a 612pt Letter page,
      // so 1pt is about 1.34px. Word's default body (11pt) lands at ~14.7px.
      // 按文档自己的字号还原:820px 的纸对应 612pt 的 Letter 页宽,1 磅约合 1.34px。
      // Word 默认正文 11 磅约等于 14.7px。
      if (r.sz) s = `<span style="font-size:${Math.min(54, Math.max(9, r.sz * 1.34)).toFixed(1)}px">${s}</span>`;
      return s;
    }).join('');
    if (b.listed) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${runs || '&nbsp;'}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (b.h) {
      out.push(`<h${Math.min(b.h, 6)}>${runs}</h${Math.min(b.h, 6)}>`);
    } else {
      out.push(`<p>${runs || '&nbsp;'}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

/** Preset geometries that a clip-path polygon approximates well enough to recognise
 *  用 clip-path 多边形就足够认出来的预设几何 */
const PRST_CLIP = {
  rtTriangle: 'polygon(0 0, 0 100%, 100% 100%)',
  triangle: 'polygon(50% 0, 100% 100%, 0 100%)',
  trapezoid: 'polygon(18% 0, 82% 0, 100% 100%, 0 100%)',
  parallelogram: 'polygon(20% 0, 100% 0, 80% 100%, 0 100%)',
  hexagon: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)',
  diamond: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
  pentagon: 'polygon(50% 0, 100% 38%, 82% 100%, 18% 100%, 0 38%)',
  snip1Rect: 'polygon(0 0, 85% 0, 100% 15%, 100% 100%, 0 100%)',
  snip2DiagRect: 'polygon(12% 0, 100% 0, 100% 88%, 88% 100%, 0 100%, 0 12%)',
  snip2SameRect: 'polygon(12% 0, 88% 0, 100% 12%, 100% 100%, 0 100%, 0 12%)',
  chevron: 'polygon(0 0, 78% 0, 100% 50%, 78% 100%, 0 100%, 22% 50%)',
  homePlate: 'polygon(0 0, 80% 0, 100% 50%, 80% 100%, 0 100%)',
  rightArrow: 'polygon(0 25%, 60% 25%, 60% 0, 100% 50%, 60% 100%, 60% 75%, 0 75%)',
};

const transformOf = (it) => {
  const t = [];
  if (it.rot) t.push(`rotate(${it.rot.toFixed(2)}deg)`);
  if (it.flipH) t.push('scaleX(-1)');
  if (it.flipV) t.push('scaleY(-1)');
  return t.join(' ');
};

const SVGNS = 'http://www.w3.org/2000/svg';

/** One pptx slide card: background, then every item in document order (that IS the z-order) --
 *  decorations from the master and layout arrive first in the list. Geometry, fills, outlines,
 *  transforms, cropped pictures, connectors, styled text runs.
 *  一页 pptx 卡片。先背景,再按文档顺序渲染每个条目。文档顺序就是 z 顺序,母版和版式的装饰
 *  排在列表最前。几何、填充、描边、变换、裁剪图片、连接线、带样式的文字 run 全部就位。 */
async function slideEl(slide, deck, keepUrl) {
  const wrap = document.createElement('div');
  wrap.className = 'drv-slidewrap';
  const el = document.createElement('div');
  el.className = 'drv-slide';
  el.style.aspectRatio = `${deck.w} / ${deck.h}`;
  const pct = (v, base) => ((v / base) * 100).toFixed(2) + '%';
  const cqwPerPt = 100 / (deck.w * 72);
  const flow = [];

  const mediaUrl = async (it) => {
    try {
      return keepUrl(new Blob([await it.entry.bytes()], { type: it.mime }));
    } catch {
      return null;
    }
  };

  if (slide.bg) {
    if (slide.bg.type === 'solid' || slide.bg.type === 'grad') {
      el.style.background = slide.bg.css;
    } else if (slide.bg.type === 'img') {
      const u = await mediaUrl(slide.bg);
      if (u) {
        const im = document.createElement('img');
        im.src = u;
        im.alt = '';
        im.className = 'shp';
        im.style.cssText = 'left:0;top:0;width:100%;height:100%;object-fit:cover';
        el.appendChild(im);
      }
    }
  }

  const placeBox = (node, box) => {
    node.style.left = pct(box.x, deck.w);
    node.style.top = pct(box.y, deck.h);
    node.style.width = pct(box.w, deck.w);
    node.style.height = pct(box.h, deck.h);
  };

  const buildImage = async (it) => {
    const u = await mediaUrl(it);
    if (!u) return;
    // An embedded video plays in place; the pic bytes serve as its poster frame
    // 内嵌视频原位可播。这张 pic 的字节就是它的海报帧
    if (it.video && it.box) {
      const vu = await mediaUrl(it.video);
      if (vu) {
        const vid = document.createElement('video');
        vid.controls = true;
        vid.playsInline = true;
        vid.preload = 'metadata';
        vid.poster = u;
        vid.src = vu;
        vid.className = 'shp';
        vid.style.objectFit = 'contain';
        vid.style.background = '#000';
        placeBox(vid, it.box);
        el.appendChild(vid);
        return;
      }
    }
    const im = document.createElement('img');
    im.src = u;
    im.alt = '';
    if (!it.box) {
      im.className = 'flowimg';
      flow.push(im);
      return;
    }
    const holder = document.createElement('div');
    holder.className = 'shp';
    holder.style.overflow = 'hidden';
    placeBox(holder, it.box);
    const tf = transformOf(it);
    if (tf) holder.style.transform = tf;
    if (it.srcRect) {
      // Crop: blow the image up so the kept region exactly fills the frame
      // 裁剪。把图放大到让保留区域恰好占满画框
      const { l, t: t2, r, b } = it.srcRect;
      const iw = Math.max(0.01, 1 - l - r);
      const ih = Math.max(0.01, 1 - t2 - b);
      im.style.cssText = `position:absolute;width:${(100 / iw).toFixed(2)}%;height:${(100 / ih).toFixed(2)}%;`
        + `left:${(-l / iw * 100).toFixed(2)}%;top:${(-t2 / ih * 100).toFixed(2)}%`;
    } else {
      im.style.cssText = 'width:100%;height:100%;object-fit:fill';
    }
    holder.appendChild(im);
    el.appendChild(holder);
  };

  const buildCxn = (it) => {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('shp');
    svg.style.overflow = 'visible';
    placeBox(svg, it.box);
    const x1 = it.flipH ? 100 : 0;
    const y1 = it.flipV ? 100 : 0;
    const x2 = 100 - x1;
    const y2 = 100 - y1;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', it.bent ? `M${x1} ${y1} L50 ${y1} L50 ${y2} L${x2} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', it.line.css);
    path.setAttribute('stroke-width', String(Math.max(1, it.line.w * 1.33)));
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    if (it.line.dash === 'dashed') path.setAttribute('stroke-dasharray', '6 4');
    svg.appendChild(path);
    el.appendChild(svg);
  };

  const buildShape = async (it) => {
    const d = document.createElement('div');
    const hasBox = !!it.box;
    if (hasBox) {
      d.className = 'shp sboxed';
      placeBox(d, it.box);
      // Rotation turns the whole shape, text included -- that matches PowerPoint. Flips do
      // NOT touch the text: PowerPoint mirrors the geometry only and keeps text readable,
      // so the flip transform goes on a dedicated geometry layer further down.
      // 旋转带着文字一起转,与 PowerPoint 一致。翻转绝不碰文字:PPT 只镜像几何、文字保持可读,
      // 所以翻转变换打在下面专门的几何层上。
      if (it.rot) d.style.transform = `rotate(${it.rot.toFixed(2)}deg)`;
    } else {
      d.className = 'flowtxt' + (it.isTitle ? ' title' : '');
    }
    const flip = [it.flipH ? 'scaleX(-1)' : '', it.flipV ? 'scaleY(-1)' : ''].filter(Boolean).join(' ');
    const fillVisible = it.fill && it.fill.type !== 'none';
    const lineVisible = it.line && it.line.type !== 'none';
    if (hasBox && it.custom && (fillVisible || lineVisible)) {
      // Custom geometry gets a real SVG path / 自定义几何画成真正的 SVG path
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${it.custom.w} ${it.custom.h}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.classList.add('geo');
      if (flip) svg.style.transform = flip;
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', it.custom.d);
      path.setAttribute('fill', fillVisible ? (it.fill.type === 'img' ? 'rgba(0,0,0,.06)' : firstColor(it.fill.css)) : 'none');
      if (lineVisible) {
        path.setAttribute('stroke', it.line.css);
        path.setAttribute('stroke-width', String(Math.max(1, it.line.w * 1.33)));
        path.setAttribute('vector-effect', 'non-scaling-stroke');
      }
      svg.appendChild(path);
      d.appendChild(svg);
    } else if (hasBox && (fillVisible || lineVisible)) {
      // Preset geometry paints on its own layer so a flip can mirror it without the text
      // 预设几何画在独立图层上,翻转镜像图形而不殃及文字
      const geo = document.createElement('div');
      geo.className = 'geo';
      if (flip) geo.style.transform = flip;
      if (fillVisible) {
        if (it.fill.type === 'img') {
          const u = await mediaUrl(it.fill);
          if (u) {
            geo.style.backgroundImage = `url("${u}")`;
            geo.style.backgroundSize = 'cover';
            geo.style.backgroundPosition = 'center';
          }
        } else {
          geo.style.background = it.fill.css;
        }
      }
      if (lineVisible) {
        geo.style.border = `${Math.max(0.08, it.line.w * cqwPerPt).toFixed(3)}cqw ${it.line.dash} ${it.line.css}`;
      }
      if (it.prst === 'ellipse') geo.style.borderRadius = '50%';
      else if (it.prst === 'roundRect' || it.prst === 'round2SameRect') geo.style.borderRadius = '1.4cqw';
      else if (PRST_CLIP[it.prst]) geo.style.clipPath = PRST_CLIP[it.prst];
      d.appendChild(geo);
    }
    if (it.lines.length) {
      const txt = document.createElement('div');
      txt.className = 'stext' + (it.anchor === 'ctr' ? ' mid' : it.anchor === 'b' ? ' low' : '');
      let autoNum = 1;
      for (const line of it.lines) {
        const ln = document.createElement('div');
        ln.style.textAlign = { l: 'left', ctr: 'center', r: 'right', just: 'justify' }[line.algn] || 'left';
        if (line.lnSpc) ln.style.lineHeight = line.lnSpc.toFixed(2);
        if (line.spcBef) ln.style.marginTop = (line.spcBef * cqwPerPt).toFixed(2) + 'cqw';
        if (line.lvl) ln.style.paddingLeft = (line.lvl * 1.8).toFixed(1) + 'cqw';
        const baseSz = line.runs[0] ? line.runs[0].sz : 12;
        if (line.bullet) {
          const bu = document.createElement('span');
          bu.className = 'bu';
          bu.textContent = line.bullet === '#' ? `${autoNum++}.` : line.bullet;
          bu.style.fontSize = (baseSz * cqwPerPt).toFixed(3) + 'cqw';
          if (line.runs[0]?.color) bu.style.color = line.runs[0].color;
          ln.appendChild(bu);
        }
        for (const run of line.runs) {
          const s = document.createElement('span');
          s.textContent = run.t;
          s.style.fontSize = (run.sz * cqwPerPt).toFixed(3) + 'cqw';
          if (run.color) s.style.color = run.color;
          if (run.font) s.style.fontFamily = run.font;
          if (run.b || it.isTitle) s.style.fontWeight = '600';
          if (run.i) s.style.fontStyle = 'italic';
          const deco = [run.u ? 'underline' : '', run.strike ? 'line-through' : ''].filter(Boolean).join(' ');
          if (deco) s.style.textDecoration = deco;
          ln.appendChild(s);
        }
        txt.appendChild(ln);
      }
      d.appendChild(txt);
    }
    if (hasBox) el.appendChild(d);
    else flow.push(d);
  };

  for (const it of slide.items) {
    if (it.kind === 'image') await buildImage(it);
    else if (it.kind === 'cxn') buildCxn(it);
    else await buildShape(it);
  }

  wrap.appendChild(el);
  if (flow.length) {
    const f = document.createElement('div');
    f.className = 'drv-slide-flow';
    flow.forEach((x) => f.appendChild(x));
    wrap.appendChild(f);
  }
  return wrap;
}

/** First colour of a gradient CSS string, for SVG paths that cannot take the gradient itself
 *  渐变 CSS 里的第一个颜色。给吃不下渐变字符串的 SVG path 用 */
function firstColor(css) {
  const m = /rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/.exec(String(css || ''));
  return m ? m[0] : '#cccccc';
}
