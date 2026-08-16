// Client-side thumbnail generation, run by the uploader at upload time (the Workers runtime
// cannot decode images, and this project deliberately keeps CPU-heavy work in the browser --
// same reasoning as the mail-import parser).
//   images     -> centre cover-crop
//   videos     -> sample frames at several positions, keep the one with mid-range brightness
//                 (not blown out, not black) and the strongest mean |Laplacian| (most detail)
//   PDFs       -> render page 1 with self-hosted pdf.js, crop from the top
//   text/code  -> typeset the first lines onto a white sheet
// Output is always WebP at 480x360, capped at 100 KB (the server re-checks both).
//
// 缩略图在上传端生成(Workers 解不了码,本项目也一贯把烧 CPU 的活放浏览器 —— 与邮件导入解析同理)。
//   图片   -> 居中 cover 裁切
//   视频   -> 多个时间点抽帧,按亮度适中(不过曝、不全黑)+ 平均|拉普拉斯|最强(细节最多)选一帧
//   PDF    -> 自托管 pdf.js 渲染第一页,从顶部裁切
//   文本   -> 前若干行排版到白底画布
// 输出一律 480x360 WebP,上限 100KB(服务端会复核)。

import { store } from '../app.js';
import { docxParse, drawioDraw, drawioPages, ext, htmlText, kindOf, mhtmlParse } from './doc.js';

// The pptx engine loads only when a pptx thumbnail is actually being made
// pptx 引擎只在真的要做 pptx 缩略图时才加载
const loadPptx = () => import('./pptx.js?v=' + encodeURIComponent(store.brand?.version || ''));
const loadSheet = () => import('./sheet.js?v=' + encodeURIComponent(store.brand?.version || ''));

const TW = 480;
const TH = 360;
const MAX_BYTES = 100 * 1024;

const IMG_RE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/;

/** Entry point: a WebP Blob, or null when this type has no thumbnail (or generation failed).
 *  入口。返回 WebP Blob;该类型做不了或生成失败返回 null。 */
export async function makeThumb(file) {
  try {
    const mime = (file.type || '').toLowerCase();
    if (IMG_RE.test(mime)) return await fromImage(file);
    if (mime.startsWith('video/')) return await withTimeout(fromVideo(file), 10000);
    if (mime === 'application/pdf' || ext(file.name) === 'pdf') return await withTimeout(fromPdf(file), 12000);
    switch (kindOf(file.name, mime)) {
      case 'audio': return await withTimeout(fromAudio(file), 15000);
      case 'txt': case 'md': return await fromText(file, false);
      case 'code': return await fromText(file, true);
      case 'docx': return await withTimeout(fromDocx(file), 10000);
      case 'pptx': return await withTimeout(fromPptx(file), 12000);
      case 'html': return await fromHtml(file);
      case 'mhtml': return await withTimeout(fromMhtml(file), 8000);
      case 'svg': return await withTimeout(fromSvg(file), 6000);
      case 'drawio': return await withTimeout(fromDrawio(file), 8000);
      case 'sheet': return await withTimeout(fromSheet(file), 12000);
      default: return null;
    }
  } catch {
    return null;
  }
}

/** Backfill helper for images uploaded before thumbnails existed: the grid already shows the
 *  full-size <img>, so once it is loaded we can encode a thumbnail for free (same origin, the
 *  canvas is not tainted).
 *  给"缩略图功能上线前传的图片"补缩略图:网格已经在展示原图 <img>,加载完顺手编码一张即可。
 *  同源图片不会污染画布。 */
export function thumbFromImgEl(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return Promise.resolve(null);
  return drawCover(img, w, h, false);
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
}

function toBlob(canvas, q) {
  return new Promise((res) => canvas.toBlob(res, 'image/webp', q));
}

/** Quality ladder, then a half-size retry; give up rather than exceed the cap.
 *  质量阶梯,再试半尺寸;宁可放弃也不超上限。 */
async function encode(canvas) {
  for (const q of [0.82, 0.62, 0.45]) {
    const b = await toBlob(canvas, q);
    if (b && b.size <= MAX_BYTES) return b;
  }
  const c2 = document.createElement('canvas');
  c2.width = canvas.width >> 1;
  c2.height = canvas.height >> 1;
  c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
  const b2 = await toBlob(c2, 0.5);
  return b2 && b2.size <= MAX_BYTES ? b2 : null;
}

/** Cover-crop the source into 480x360. Documents crop from the top (the header is the
 *  recognisable part); everything else crops from the centre.
 *  把源画面 cover 裁进 480x360。文档从顶部裁(页眉才认得出),其余居中。 */
function drawCover(source, sw, sh, top = false) {
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const g = c.getContext('2d');
  const scale = Math.max(TW / sw, TH / sh);
  const cw = TW / scale;
  const ch = TH / scale;
  const sx = (sw - cw) / 2;
  const sy = top ? 0 : (sh - ch) / 2;
  g.drawImage(source, sx, sy, cw, ch, 0, 0, TW, TH);
  return encode(c);
}

// ---------- Images ----------
// ---------- 图片 ----------

async function fromImage(file) {
  // createImageBitmap applies EXIF orientation by default in Chromium
  // createImageBitmap 默认按 EXIF 方向摆正
  const bmp = await createImageBitmap(file);
  try {
    return await drawCover(bmp, bmp.width, bmp.height, false);
  } finally {
    bmp.close();
  }
}

// ---------- Videos: sample, score, pick ----------
// ---------- 视频:抽帧、打分、选帧 ----------

const evt = (el, name, ms = 4000) =>
  new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout')), ms);
    el.addEventListener(name, () => { clearTimeout(to); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(to); rej(new Error('media error')); }, { once: true });
  });

async function seek(v, t) {
  v.currentTime = t;
  await evt(v, 'seeked');
}

/** Mean luma plus mean |4-neighbour Laplacian| on a small grayscale frame.
 *  小尺寸灰度帧上的平均亮度 + 平均|四邻域拉普拉斯|。 */
function scoreFrame(img) {
  const { data, width: w, height: h } = img;
  const y = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; p < y.length; i += 4, p++) {
    const v = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    y[p] = v;
    sum += v;
  }
  const luma = sum / y.length;
  let lap = 0;
  let n = 0;
  for (let r = 1; r < h - 1; r++) {
    for (let x = 1; x < w - 1; x++) {
      const p = r * w + x;
      lap += Math.abs(4 * y[p] - y[p - 1] - y[p + 1] - y[p - w] - y[p + w]);
      n++;
    }
  }
  return { luma, lap: n ? lap / n : 0 };
}

const lumaOk = (s) => s.luma >= 25 && s.luma <= 230;

/** Brightness gate first (neither washed out nor black), then the most detail wins. If every
 *  candidate fails the gate, fall back to pure detail so we still return something.
 *  先过亮度闸(不过曝、不全黑),同档里细节最强的赢。全都过不了闸就退化成纯细节比较。 */
function better(a, b) {
  if (lumaOk(a) !== lumaOk(b)) return lumaOk(a);
  return a.lap > b.lap;
}

async function fromVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    v.src = url;
    await evt(v, 'loadedmetadata');
    if (!v.videoWidth || !v.videoHeight) return null;
    // MediaRecorder-made webm files report duration Infinity until you seek past the end --
    // a known Chrome quirk; screen recordings shared by users are exactly this kind of file
    // MediaRecorder 录出来的 webm 在 seek 过尾部之前 duration 是 Infinity(Chrome 已知怪癖)。
    // 用户随手分享的屏幕录像就是这种文件
    if (!Number.isFinite(v.duration)) {
      try {
        await seek(v, 1e10);
      } catch {}
    }
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const spots = dur > 0.5
      ? [0.1, 0.28, 0.5, 0.75].map((p) => Math.min(dur * p, Math.max(dur - 0.1, 0)))
      : [0];
    // Score at reduced size; 192px wide is plenty for luma and Laplacian statistics
    // 缩小到 192px 宽打分。算亮度和拉普拉斯统计足够了
    const sc = document.createElement('canvas');
    sc.width = 192;
    sc.height = Math.max(2, Math.round((192 * v.videoHeight) / v.videoWidth));
    const sg = sc.getContext('2d', { willReadFrequently: true });
    let best = null;
    for (const t of spots) {
      try {
        await seek(v, t);
      } catch {
        continue;
      }
      sg.drawImage(v, 0, 0, sc.width, sc.height);
      const s = scoreFrame(sg.getImageData(0, 0, sc.width, sc.height));
      const cand = { t, ...s };
      if (!best || better(cand, best)) best = cand;
    }
    if (!best) return null;
    if (v.currentTime !== best.t) await seek(v, best.t);
    return await drawCover(v, v.videoWidth, v.videoHeight, false);
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    v.load?.();
    URL.revokeObjectURL(url);
  }
}

// ---------- PDF: render page 1 with self-hosted pdf.js ----------
// ---------- PDF:自托管 pdf.js 渲第一页 ----------

let pdfjsMod = null;

/** Shared pdf.js loader (thumbnails here, the preview overlay in drive.js): one import, one worker.
 *  共享的 pdf.js 加载器(这里做缩略图,drive.js 的预览层也用):只 import 一次、共用一个 worker。 */
export async function pdfjs() {
  if (!pdfjsMod) {
    pdfjsMod = await import('/vendor/pdfjs/build/pdf.min.mjs');
    pdfjsMod.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
  }
  return pdfjsMod;
}

/** getDocument options shared by thumbnail and preview rendering
 *  缩略图与预览共用的 getDocument 选项 */
export function pdfDocOpts(data) {
  return {
    data,
    isEvalSupported: false,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  };
}

async function fromPdf(file) {
  const lib = await pdfjs();
  // v6: cleanup lives on the loading task -- PDFDocumentProxy itself has no destroy() anymore
  // v6 的清理入口在 loading task 上 —— PDFDocumentProxy 已没有 destroy() 方法
  const task = lib.getDocument(pdfDocOpts(await file.arrayBuffer()));
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 640 / vp1.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    // intent 'print' schedules by microtask instead of requestAnimationFrame -- rAF never fires
    // in a hidden tab, and thumbnails often finish generating after the user has switched away
    // intent 'print' 用微任务而非 requestAnimationFrame 调度 —— 隐藏标签页里 rAF 不触发,
    // 而缩略图常常是在用户切走标签页之后才轮到生成
    await page.render({ canvasContext: g, viewport: vp, intent: 'print' }).promise;
    return await drawCover(c, c.width, c.height, true);
  } finally {
    task.destroy().catch(() => {});
  }
}

// ---------- Text and code: typeset the first lines ----------
// ---------- 文本/代码:排版前若干行 ----------

/** Typeset plain text onto the white sheet: monospace for code, the system UI face otherwise.
 *  把文本排到白纸上。代码用等宽,其余用系统界面字体。 */
function typesetText(raw, mono) {
  if (!raw || !raw.trim()) return null;
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, TW, TH);
  // A document is a white sheet with dark text in every theme, like a paper preview
  // 文档就是白纸黑字,与主题无关。纸就该长这样
  g.fillStyle = '#3c4043';
  g.font = mono
    ? '15px ui-monospace, SFMono-Regular, Consolas, monospace'
    : '16px system-ui, "Segoe UI", sans-serif';
  g.textBaseline = 'top';
  const lines = raw.replace(/\r/g, '').split('\n').filter((_, i) => i < 16);
  lines.forEach((ln, i) => g.fillText(ln.replace(/\t/g, '    ').slice(0, mono ? 58 : 64), 24, 26 + i * 20));
  return encode(c);
}

async function fromText(file, mono) {
  const raw = await file.slice(0, 8192).text();
  // Too many replacement characters = binary in disguise; a thumbnail of mojibake helps nobody
  // 替换字符过多说明是伪装成文本的二进制。乱码缩略图毫无意义
  if ((raw.match(/�/g) || []).length > 20) return null;
  return typesetText(raw, mono);
}

// ---------- docx / pptx / html / mhtml / svg / drawio ----------

async function fromDocx(file) {
  const parsed = await docxParse(await file.arrayBuffer());
  return parsed ? typesetText(parsed.text.slice(0, 4096), false) : null;
}

/** pptx: the embedded cover image when the file carries one, otherwise a composite of slide 1
 *  (its first picture on top, title and text below).
 *  pptx:文件自带封面图就直接用;否则用第一页合成 —— 首图在上、标题正文在下。 */
async function fromPptx(file) {
  const { pptxParse } = await loadPptx();
  const deck = await pptxParse(await file.arrayBuffer(), 1);
  if (!deck) return null;
  if (deck.cover) {
    try {
      const bmp = await createImageBitmap(deck.cover);
      const out = await drawCover(bmp, bmp.width, bmp.height, false);
      bmp.close();
      if (out) return out;
    } catch {}
  }
  const slide = deck.slides[0];
  if (!slide) return null;
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, TW, TH);
  let y = 26;
  if (slide.images[0]) {
    try {
      const bmp = await createImageBitmap(new Blob([await slide.images[0].entry.bytes()], { type: slide.images[0].mime }));
      const scale = Math.min(TW / bmp.width, (TH * 0.55) / bmp.height);
      const w = bmp.width * scale;
      const h = bmp.height * scale;
      g.drawImage(bmp, (TW - w) / 2, 14, w, h);
      bmp.close();
      y = 14 + h + 18;
    } catch {}
  }
  g.fillStyle = '#202124';
  g.textBaseline = 'top';
  const lineText = (l) => l.runs.map((r) => r.t).join('');
  const title = [slide.shapes.find((s) => s.isTitle), slide.shapes[0]]
    .map((s) => s && s.lines[0] && lineText(s.lines[0])).find(Boolean) || '';
  if (title) {
    g.font = '600 22px system-ui, "Segoe UI", sans-serif';
    g.fillText(title.slice(0, 34), 24, y, TW - 48);
    y += 34;
  }
  g.font = '14px system-ui, "Segoe UI", sans-serif';
  g.fillStyle = '#4b4f55';
  const rest = slide.shapes.flatMap((s) => (s.isTitle ? [] : s.lines.map(lineText))).slice(0, 8);
  for (const line of rest) {
    if (y > TH - 24) break;
    g.fillText(line.slice(0, 56), 24, y, TW - 48);
    y += 20;
  }
  if (!title && !rest.length && !slide.images.length) return null;
  return encode(c);
}

async function fromHtml(file) {
  const raw = await file.slice(0, 512 * 1024).text();
  return typesetText(htmlText(raw).slice(0, 4096), false);
}

async function fromMhtml(file) {
  const parsed = await mhtmlParse(await file.arrayBuffer());
  return parsed ? typesetText(parsed.text.slice(0, 4096), false) : null;
}

/** SVG rasterises through an <img> -- scripts never run there and subresources never load.
 *  SVG 经 <img> 栅格化 —— 那个上下文里脚本不执行、子资源不加载。 */
async function fromSvg(file) {
  const url = URL.createObjectURL(new Blob([await file.arrayBuffer()], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('svg'));
    });
    const w = img.naturalWidth || 800;
    const h = img.naturalHeight || 600;
    // A foreignObject inside would taint the canvas; encode() then throws and we fall back to the icon
    // 内含 foreignObject 会污染画布。encode() 抛错后自然回落到图标
    const c = document.createElement('canvas');
    c.width = TW;
    c.height = TH;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, TW, TH);
    const scale = Math.min(TW / w, TH / h) * 0.92;
    const dw = w * scale;
    const dh = h * scale;
    g.drawImage(img, (TW - dw) / 2, (TH - dh) / 2, dw, dh);
    return await encode(c);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fromDrawio(file) {
  const pages = await drawioPages(await file.slice(0, 4 * 1024 * 1024).text(), 1);
  if (!pages.length) return null;
  const c = document.createElement('canvas');
  if (!drawioDraw(pages[0], c, 640, 1)) return null;
  return drawCover(c, c.width, c.height, false);
}

// ---------- Audio: embedded cover art, else a waveform ----------
// ---------- 音频:内嵌封面优先,否则画波形 ----------

// ---------- spreadsheet ----------

/** A spreadsheet thumbnail has to read as a spreadsheet at 480x360 -- ruled, with a header
 *  band -- or it is indistinguishable from a text file. So this draws an actual little grid
 *  rather than typesetting the values as lines of prose.
 *  电子表格的缩略图必须在 480x360 下"看起来就是电子表格" —— 有格线、有表头带 ——
 *  否则与文本文件毫无分别。因此这里画的是一张真的小网格,而不是把值排成一行行文字。 */
async function fromSheet(file) {
  const mod = await loadSheet();
  const e = ext(file.name);
  let grid = null;
  if (e === 'csv' || e === 'tsv' || e === 'tab') {
    grid = mod.delimitedGrid(mod.decodeText(await file.slice(0, 256 * 1024).arrayBuffer()), e);
  } else {
    const book = await mod.xlsxOpen(await file.arrayBuffer());
    if (book) grid = await book.read(0);
  }
  if (!grid || !grid.rows.length) return null;
  return drawGrid(grid);
}

function drawGrid(grid) {
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, TW, TH);

  const rowH = 26;
  const nRows = Math.min(grid.rows.length, Math.ceil(TH / rowH));
  // Columns are sized by what they hold, within reason: an all-narrow grid wastes the frame,
  // an all-wide one shows two columns of a twelve-column sheet.
  // 列宽按内容定,但有分寸:全窄会浪费画面,全宽则让十二列的表只露出两列。
  const want = [];
  for (let i = 0; i < Math.min(grid.ncols, 12); i++) {
    const w = grid.widths[i] ? grid.widths[i] * 7 : 92;
    want.push(Math.max(46, Math.min(w, 170)));
  }
  if (!want.length) want.push(TW);
  const total = want.reduce((a, b) => a + b, 0);
  const scale = total > TW ? TW / total : 1;
  const cols = want.map((w) => w * scale);

  g.font = '12px system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  g.textBaseline = 'middle';
  for (let r = 0; r < nRows; r++) {
    const y = r * rowH;
    let x = 0;
    for (let ci = 0; ci < cols.length; ci++) {
      const cell = grid.rows[r][ci];
      // The file's own fill first; failing that, the top row reads as a header band
      // 优先用文件自己的填充色;没有的话,首行以表头带呈现
      const bg = cell?.bg || (r === 0 ? '#f1f3f4' : '');
      if (bg) {
        g.fillStyle = bg;
        g.fillRect(x, y, cols[ci], rowH);
      }
      const v = cell?.v || '';
      if (v) {
        g.fillStyle = cell?.fg || '#3c4043';
        if (cell?.b || r === 0) g.font = 'bold 12px system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
        g.save();
        g.beginPath();
        g.rect(x + 4, y, cols[ci] - 8, rowH);
        g.clip();
        g.fillText(v, cell?.a === 'right' ? Math.max(x + 5, x + cols[ci] - 5 - g.measureText(v).width) : x + 5, y + rowH / 2);
        g.restore();
        g.font = '12px system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
      }
      x += cols[ci];
    }
  }
  // Rules last, so they sit over the fills rather than under them
  // 格线最后画,好压在填充之上而不是之下
  g.strokeStyle = '#dadce0';
  g.lineWidth = 1;
  g.beginPath();
  for (let r = 1; r <= nRows; r++) {
    g.moveTo(0, r * rowH - 0.5);
    g.lineTo(TW, r * rowH - 0.5);
  }
  let x = 0;
  for (const w of cols) {
    x += w;
    g.moveTo(Math.round(x) - 0.5, 0);
    g.lineTo(Math.round(x) - 0.5, nRows * rowH);
  }
  g.stroke();
  return encode(c);
}

const ascii = (u8, p, n) => String.fromCharCode(...u8.subarray(p, p + n));

/** ID3v2 APIC / PIC frame (mp3, and aac files carrying an ID3 prefix)
 *  ID3v2 的 APIC/PIC 帧。mp3 与带 ID3 前缀的 aac 都走这里 */
function id3Cover(u8) {
  if (u8.length < 20 || ascii(u8, 0, 3) !== 'ID3') return null;
  const ver = u8[3];
  const syn = (p) => (u8[p] << 21) | (u8[p + 1] << 14) | (u8[p + 2] << 7) | u8[p + 3];
  const end = Math.min(10 + syn(6), u8.length);
  let p = 10;
  while (p + 10 <= end) {
    let id;
    let fsize;
    let hdr;
    if (ver === 2) {
      id = ascii(u8, p, 3);
      fsize = (u8[p + 3] << 16) | (u8[p + 4] << 8) | u8[p + 5];
      hdr = 6;
    } else {
      id = ascii(u8, p, 4);
      fsize = ver >= 4 ? syn(p + 4) : (u8[p + 4] << 24) | (u8[p + 5] << 16) | (u8[p + 6] << 8) | u8[p + 7];
      hdr = 10;
    }
    if (!/^[A-Z0-9]+$/.test(id) || fsize <= 0 || p + hdr + fsize > end + 1) break;
    if (id === 'APIC' || id === 'PIC') {
      let q = p + hdr;
      const enc = u8[q++];
      let mime = 'image/jpeg';
      if (ver === 2) {
        mime = /png/i.test(ascii(u8, q, 3)) ? 'image/png' : 'image/jpeg';
        q += 3;
      } else {
        const z = u8.indexOf(0, q);
        if (z < 0) break;
        mime = ascii(u8, q, z - q).toLowerCase() || 'image/jpeg';
        q = z + 1;
      }
      q++; // picture type / 图片用途字节
      if (enc === 1 || enc === 2) {
        while (q + 1 < end && (u8[q] || u8[q + 1])) q += 2;
        q += 2;
      } else {
        while (q < end && u8[q]) q++;
        q++;
      }
      const data = u8.slice(q, p + hdr + fsize);
      return data.length > 64 ? new Blob([data], { type: /png/.test(mime) ? 'image/png' : 'image/jpeg' }) : null;
    }
    p += hdr + fsize;
  }
  return null;
}

/** The covr atom of m4a / audio-mp4: moov > udta > meta > ilst > covr > data
 *  m4a 与音频 mp4 的封面:moov > udta > meta > ilst > covr > data */
function mp4Cover(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const walk = (start, end, path) => {
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = ascii(u8, p + 4, 4);
      let hdr = 8;
      if (size === 1 && p + 16 <= end) {
        size = dv.getUint32(p + 8) * 2 ** 32 + dv.getUint32(p + 12);
        hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr || p + size > end) break;
      if (type === path[0]) {
        // The meta box carries 4 bytes of version+flags before its children
        // meta box 的子项前面还有 4 字节版本+标志
        const inner = p + hdr + (type === 'meta' ? 4 : 0);
        if (path.length === 1) return { p: p + hdr, end: p + size };
        const r = walk(inner, p + size, path.slice(1));
        if (r) return r;
      }
      p += size;
    }
    return null;
  };
  const covr = walk(0, u8.length, ['moov', 'udta', 'meta', 'ilst', 'covr']);
  if (!covr || covr.p + 16 > covr.end) return null;
  const size = dv.getUint32(covr.p);
  if (ascii(u8, covr.p + 4, 4) !== 'data' || covr.p + size > covr.end + 8) return null;
  const flavor = dv.getUint32(covr.p + 8) & 0xffffff;
  const data = u8.slice(covr.p + 16, covr.p + size);
  return data.length > 64 ? new Blob([data], { type: flavor === 14 ? 'image/png' : 'image/jpeg' }) : null;
}

/** FLAC METADATA_BLOCK_PICTURE (block type 6) / FLAC 的图片元数据块 */
function flacCover(u8) {
  if (u8.length < 8 || ascii(u8, 0, 4) !== 'fLaC') return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 4;
  while (p + 4 <= u8.length) {
    const head = u8[p];
    const len = (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
    p += 4;
    if ((head & 0x7f) === 6 && p + len <= u8.length) {
      let q = p + 4;
      const mlen = dv.getUint32(q);
      q += 4;
      const mime = ascii(u8, q, Math.min(mlen, 64)).toLowerCase();
      q += mlen;
      q += 4 + dv.getUint32(q); // description / 描述
      q += 16; // w, h, depth, colors
      const dlen = dv.getUint32(q);
      q += 4;
      const data = u8.slice(q, q + dlen);
      return data.length > 64 ? new Blob([data], { type: /png/.test(mime) ? 'image/png' : 'image/jpeg' }) : null;
    }
    p += len;
    if (head & 0x80) break;
  }
  return null;
}

/** No cover found: decode a bit of the audio and draw its waveform instead -- every audio file
 *  gets a meaningful tile.
 *  没有封面就解码音频画波形 —— 每个音频文件都有一张有意义的卡。 */
async function waveThumb(buf) {
  const octx = new OfflineAudioContext(1, 16000, 16000);
  const audio = await octx.decodeAudioData(buf);
  const ch = audio.getChannelData(0);
  if (!ch.length) return null;
  const BARS = 60;
  const seg = Math.max(1, Math.floor(ch.length / BARS));
  const peaks = [];
  let maxPeak = 0;
  for (let b = 0; b < BARS; b++) {
    let m = 0;
    const off = b * seg;
    // Sample within the segment; reading every value of long files buys nothing
    // 段内抽样即可。长文件逐点读没有意义
    const step = Math.max(1, Math.floor(seg / 400));
    for (let i = 0; i < seg; i += step) {
      const v = Math.abs(ch[off + i] || 0);
      if (v > m) m = v;
    }
    peaks.push(m);
    if (m > maxPeak) maxPeak = m;
  }
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const g = c.getContext('2d');
  g.fillStyle = '#202227';
  g.fillRect(0, 0, TW, TH);
  const bw = 4;
  const gap = (TW - 48 - BARS * bw) / (BARS - 1);
  g.fillStyle = '#7aa9f8';
  for (let b = 0; b < BARS; b++) {
    const h = Math.max(5, (peaks[b] / (maxPeak || 1)) * 240);
    const x = 24 + b * (bw + gap);
    g.beginPath();
    g.roundRect(x, TH / 2 - h / 2, bw, h, 2);
    g.fill();
  }
  return encode(c);
}

async function fromAudio(file) {
  // Covers live near the start except in rare rear-moov mp4 files; cap what we read
  // 封面一般在文件开头。罕见的 moov 在尾部的 mp4 除外。读取量设上限
  const buf = await (file.size <= 48 * 1024 * 1024 ? file : file.slice(0, 8 * 1024 * 1024)).arrayBuffer();
  const u8 = new Uint8Array(buf);
  const cover = id3Cover(u8) || mp4Cover(u8) || flacCover(u8);
  if (cover) {
    try {
      const bmp = await createImageBitmap(cover);
      const out = await drawCover(bmp, bmp.width, bmp.height, false);
      bmp.close();
      if (out) return out;
    } catch {}
  }
  if (file.size > 48 * 1024 * 1024) return null;
  try {
    return await waveThumb(buf.slice(0));
  } catch {
    return null;
  }
}
