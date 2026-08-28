// Client-side thumbnail generation, run by the uploader at upload time (the Workers runtime
// cannot decode images, and this project deliberately keeps CPU-heavy work in the browser --
// same reasoning as the mail-import parser).
//   images     -> centre cover-crop
//   videos     -> sample frames at several positions, keep the one with mid-range brightness
//                 (not blown out, not black) and the strongest mean |Laplacian| (most detail)
//   PDFs       -> render page 1 with self-hosted pdf.js, crop from the top
//   markdown   -> typeset the first lines onto a white sheet
//   text/code  -> a small picture of the code editor showing it, in the theme in force
//   films      -> a frame, after putting the opening into a box the browser opens if need be
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
import { fileSource } from './rzip.js';
import { toMp4, verdict } from './remux.js';

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
    // Longer than the others on purpose: a film in the wrong box has to have its opening put into
    // the right one first, and that is a read plus a write before a single frame is looked at.
    // 比其它几种给的时间长,是有意的:一部装错盒子的片子,得先把开头放进对的盒子里 ——
    // 那是在看第一帧之前的一读一写。
    if (verdict(file.name, mime)) return await withTimeout(fromFilm(file), 25000);
    if (mime === 'application/pdf' || ext(file.name) === 'pdf') return await withTimeout(fromPdf(file), 12000);
    switch (kindOf(file.name, mime)) {
      case 'audio': return await withTimeout(fromAudio(file), 15000);
      // Markdown is prose and has a prose editor, so its thumbnail stays a sheet of paper.
      // Everything else that is text opens in the code editor, and its thumbnail is that editor.
      // Markdown 是散文,也有一个散文编辑器,所以它的缩略图仍是一张纸。
      // 其余是文本的东西都在代码编辑器里打开,而它们的缩略图就是那个编辑器。
      case 'md': return await fromText(file, themeColours());
      case 'txt': case 'code': return await withTimeout(fromSourceFile(file), 10000);
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

/**
 * Which format this browser's canvas will actually encode.
 *
 * WebP is asked for first; Safari -- every browser on iOS included -- has never learned to
 * encode it, and the specification's answer to an unsupported type is a PNG wearing the wrong
 * request. PNG is useless here twice over: it has no quality dial for the ladder below, and a
 * photographic thumbnail in PNG blows straight through the byte cap. So the fallback is JPEG,
 * which every canvas encodes and the quality ladder can actually steer. Probed once, because
 * the answer cannot change while the page lives.
 *
 * 这个浏览器的画布究竟肯编哪种格式。
 *
 * 先要 WebP;Safari —— 包括 iOS 上的每一个浏览器 —— 从来没学会编它,而规范对"不支持的类型"
 * 的回答,是一张顶着错误名号的 PNG。PNG 在这里没用要没用两回:下面那把质量阶梯拧不动它,
 * 一张照片内容的 PNG 缩略图又直接冲破字节上限。所以退路是 JPEG —— 每个画布都会编,
 * 阶梯也真的拧得动。只探一次,因为页面活着的时候答案不会变。
 */
// The formats worth asking for, best first. WebP leads because every canvas that encodes it
// does so quickly; AVIF stands behind it so that the day some browser's canvas learns to
// encode it, this ladder picks it up without a code change -- today the probe simply falls
// through. JPEG is not on the list because it is not a candidate: it is the floor, the format
// every canvas encodes and the ladder lands on when nothing better answers.
// 值得开口要的格式,最好的排前面。WebP 领头,因为凡是会编它的画布都编得快;
// AVIF 站在它身后 —— 哪天哪个浏览器的画布学会了编它,这把梯子不改一行代码就能用上,
// 而在今天,探测只是落空而已。JPEG 不在名单上,因为它不是候选:它是地板 ——
// 每个画布都会编的那种,梯子在没有更好的应答时落脚的地方。
const THUMB_CANDIDATES = ['image/webp', 'image/avif'];
let fmtProbe = null;
function thumbFormat() {
  if (!fmtProbe) {
    fmtProbe = (async () => {
      const c = document.createElement('canvas');
      c.width = 2;
      c.height = 2;
      for (const type of THUMB_CANDIDATES) {
        const got = await new Promise((res) => c.toBlob((b) => res(b && b.type), type));
        if (got === type) return type;
      }
      return 'image/jpeg';
    })();
  }
  return fmtProbe;
}

async function toBlob(canvas, q) {
  const type = await thumbFormat();
  // The candidates all carry alpha; only the JPEG floor needs flattening below.
  // 候选格式全都带透明通道;只有兜底的 JPEG 需要下面那一步压平。
  if (type !== 'image/jpeg') {
    return new Promise((res) => canvas.toBlob(res, type, q));
  }
  // JPEG has no alpha: whatever the canvas left transparent turns black in the encode. Flatten
  // onto the panel's own ground first, so a PNG logo's thumbnail matches the tile behind it.
  // JPEG 没有透明:画布上留白的地方一编码就成了黑。先压平到面板自己的底色上,
  // 一张 PNG 标志的缩略图才和它身后的卡片是一个底。
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const g = flat.getContext('2d');
  g.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff';
  g.fillRect(0, 0, flat.width, flat.height);
  g.drawImage(canvas, 0, 0);
  return new Promise((res) => flat.toBlob(res, 'image/jpeg', q));
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

/** How much of a film to read before drawing its picture. A thumbnail wants the opening and
 *  nothing else; reading a two-gigabyte file to the end to get one frame is the kind of thing that
 *  reads as the upload having hung.
 *  为了画出一部片子的图,要读它多少。缩略图要的是开头、别的都不要;
 *  为了拿一帧而把一个两吉字节的文件读到尾,正是那种会被读成"上传卡死了"的事。 */
const FILM_HEAD_BYTES = 12 * 1024 * 1024;
const FILM_HEAD_SECONDS = 12;

/**
 * A picture of a film, whatever box it came in.
 *
 * A file the browser can open goes straight to the frame picker. One it cannot open but whose
 * codec it can decode has its opening put into a box it can open, and then goes to the same frame
 * picker -- so a Matroska file gets the thumbnail it would have got as an MP4, chosen the same way,
 * rather than none at all. One whose codec it cannot decode gets nothing, which is the truth.
 *
 * 一部片子的图,不管它装在什么盒子里。
 *
 * 浏览器打得开的文件直接交给选帧那一步。打不开、但编码它解得了的文件,
 * 会把开头放进一个它打得开的盒子里,然后交给同一个选帧那一步 ——
 * 于是一个 Matroska 文件拿到的缩略图,与它作为 MP4 时会拿到的那张一样,挑法也一样,
 * 而不是根本没有。编码解不了的,什么都拿不到,而那就是实情。
 */
async function fromFilm(file) {
  const what = verdict(file.name, file.type);
  if (what === 'no') return null;
  if (what !== 'remux') return fromVideo(file);
  const { blob: head } = await toMp4(file, { limit: FILM_HEAD_BYTES, seconds: FILM_HEAD_SECONDS });
  return fromVideo(head);
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
/** Loading options for pdf.js. Given a URL and the file's length it uses its own ranged
 *  transport: the cross-reference table comes off the tail, then only the objects a rendered
 *  page actually needs. `disableAutoFetch` is what keeps it from quietly pulling the rest in
 *  the background -- without it the ranged start is undone a second later.
 *  Given bytes instead, it works from those, which is what a local File leaves us with.
 *  pdf.js 的加载参数。给它 URL 与文件长度,它会启用自带的 Range 传输:先从文件尾取交叉引用表,
 *  之后只取渲染某一页真正需要的对象。disableAutoFetch 是防止它在后台悄悄把其余部分拉完 ——
 *  少了这一项,刚省下的开头会在一秒后被抵消掉。
 *  若给的是字节,就按字节来 —— 本地 File 只能给到这个。 */
export function pdfDocOpts(src, length) {
  const base = {
    isEvalSupported: false,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  };
  return typeof src === 'string'
    ? {
      ...base,
      url: src,
      length,
      rangeChunkSize: 1 << 18,
      // Both switches, or neither does much. `disableStream` stops pdf.js opening a whole-file
      // stream to discover that ranges work -- with it off, the file arrives anyway while the
      // ranged path is being set up. `disableAutoFetch` stops it from reading ahead once the
      // first page is up. Together they mean: the tail, then whatever a rendered page asks for.
      // 两个开关缺一不可。disableStream 阻止 pdf.js 为"探明支持 Range"而开一条整文件流 ——
      // 不关它,ranged 那条路还在搭建,文件已经到齐了。disableAutoFetch 阻止它在首页出来后
      // 继续预读。两者合起来才是:先读文件尾,再按渲染出的页面的需要去取。
      disableStream: true,
      disableAutoFetch: true,
    }
    : { ...base, data: src };
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

/** A page somebody saved: white, with dark text, in every theme. A docx is a page and so is an
 *  HTML file, and that is what those look like whatever the application is wearing.
 *  某人存下来的一页纸:白底深字,任何主题下都如此。docx 是一页纸,HTML 文件也是,
 *  无论应用穿着什么,它们看起来就是那样。 */
const PAPER = { bg: '#ffffff', ink: '#3c4043' };

/** The colours the application is wearing right now.
 *  Read rather than restated, and read at the moment the picture is made -- which is the only
 *  moment a stored image gets to know anything about the theme.
 *  应用此刻穿着的那套颜色。
 *  是读出来的而不是重述的,并且是在画这张图的那一刻读 ——
 *  那是一张存起来的图唯一有机会知道主题是什么的时刻。 */
function themeColours() {
  const st = getComputedStyle(document.documentElement);
  const v = (k, fb) => (st.getPropertyValue(k) || '').trim() || fb;
  return { bg: v('--bg', '#ffffff'), ink: v('--text', '#3c4043') };
}

/** Typeset prose onto a sheet. Which sheet is the caller's to say: a document is paper, and a
 *  Markdown file is a note written in this application and wears what the application wears.
 *  把散文排到一张纸上。是哪一张由调用方决定:文档是纸,
 *  而一个 Markdown 文件是写在这个应用里的一则笔记,应用穿什么它就穿什么。 */
function typesetText(raw, colours = PAPER) {
  if (!raw || !raw.trim()) return null;
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const g = c.getContext('2d');
  g.fillStyle = colours.bg;
  g.fillRect(0, 0, TW, TH);
  g.fillStyle = colours.ink;
  g.font = '16px system-ui, "Segoe UI", sans-serif';
  g.textBaseline = 'top';
  const lines = raw.replace(/\r/g, '').split('\n').filter((_, i) => i < 16);
  lines.forEach((ln, i) => g.fillText(ln.replace(/\t/g, '    ').slice(0, 64), 24, 26 + i * 20));
  return encode(c);
}

/**
 * A small picture of the code editor showing this file.
 *
 * Drawn rather than screenshotted: the grammar is a parser and needs no view to run, so the text
 * is cut into coloured runs and the runs are painted onto a canvas in the editor's own colours,
 * read from the page at the moment the picture is made. What comes out is what the editor would
 * have shown -- the same keywords in the same purple, the same comments in the same grey, the same
 * gutter down the left -- at the size of a tile.
 *
 * The colours are the ones in force when the thumbnail is made, because a stored image has one set
 * of colours and the theme has two. A file saved in the dark theme keeps a dark thumbnail until it
 * is saved again; that is a property of storing a picture rather than a decision made here.
 *
 * 一张"代码编辑器正显示着这个文件"的小图。
 *
 * 是画出来的而不是截出来的:文法就是一个解析器,不需要视图就能跑,
 * 于是文本被切成一段段带颜色的片段,再用编辑器自己的颜色画到画布上 ——
 * 那些颜色在画这张图的那一刻从页面上读取。出来的东西就是编辑器本会显示的样子:
 * 同样的关键字、同样的紫色,同样的注释、同样的灰,左边同样的一道行号槽 —— 只是缩到了一格的大小。
 *
 * 颜色取的是生成缩略图当时生效的那一套,因为一张存起来的图只有一套颜色,而主题有两套。
 * 一个在深色主题下保存的文件,会一直带着深色缩略图直到它再次被保存;
 * 这是"把图存起来"这件事本身的性质,不是这里做的决定。
 */
async function fromSource(raw, name) {
  if (!raw || !raw.trim()) return null;
  const mod = await import('../code/view.js?v=' + encodeURIComponent(store.brand?.version || ''));
  const pal = await mod.palette();

  const SIZE = 15;
  const LH = 24;
  const TOP = 12;
  const ROWS = Math.floor((TH - TOP) / LH);
  // Only the lines that will be drawn are parsed. A grammar handed eight kilobytes to find the
  // colours of sixteen lines is doing most of its work for a part of the file nobody will see.
  // 只解析将要被画出来的那些行。让一个文法读进八千字节、只为求出十六行的颜色,
  // 是在为文件中没人会看见的那一部分做掉大半的工。
  const lines = raw.replace(/\r/g, '').split('\n').slice(0, ROWS);
  // A grammar that throws costs the colours, not the picture. Everything else about this drawing
  // -- the lines, the gutter, the ink -- is true whether or not anything managed to parse.
  // 一个抛错的文法赔掉的是颜色,不是这张图。这张图的其余部分 —— 行、行号槽、墨色 ——
  // 无论有没有谁解析成功,都照样为真。
  const src = lines.join('\n');
  const runs = await mod.runsOf(src, name).catch(() => [{ text: src, cls: null }]);

  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const g = c.getContext('2d');
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, TW, TH);
  g.font = `${SIZE}px ${pal.font}`;
  g.textBaseline = 'top';

  // The gutter is sized to the widest number it will hold, the way the editor sizes its own.
  // 行号槽的宽度由它将要容纳的最大数字决定 —— 与编辑器给自己定宽的方式相同。
  const digits = String(lines.length).length;
  const GUT = 16 + g.measureText('0'.repeat(digits)).width + 10;
  g.fillStyle = pal.gutterBg;
  g.fillRect(0, 0, GUT, TH);
  g.fillStyle = pal.border;
  g.fillRect(GUT, 0, 1, TH);

  g.fillStyle = pal.gutter;
  g.textAlign = 'right';
  for (let i = 0; i < lines.length; i++) g.fillText(String(i + 1), GUT - 10, TOP + i * LH);
  g.textAlign = 'left';

  // The runs are walked once, and the pen moves with them: a run that spans a line break ends one
  // line and starts the next, so the newline is where the pen returns rather than something to
  // strip out first. Tabs become four spaces, as they do in the typeset renderer next door.
  // 片段只走一遍,笔随之移动:一个跨越换行的片段,是上一行的结束与下一行的开始 ——
  // 于是换行是笔回车的地方,而不是要先剔掉的东西。制表符变成四个空格,与隔壁那个排版渲染器一致。
  let x = GUT + 10;
  let row = 0;
  for (const r of runs) {
    g.fillStyle = pal.ink[r.cls] || pal.ink.null;
    for (const [i, piece] of r.text.split('\n').entries()) {
      if (i) { row++; x = GUT + 10; }
      if (row >= ROWS) break;
      if (!piece) continue;
      const s = piece.replace(/\t/g, '    ');
      g.fillText(s, x, TOP + row * LH);
      x += g.measureText(s).width;
    }
    if (row >= ROWS) break;
  }
  return encode(c);
}

/** Read the head of a text file, refusing what only claims to be one.
 *  读取一个文本文件的开头,并拒收那些只是自称文本的东西。 */
async function textHead(file) {
  const raw = await file.slice(0, 8192).text();
  // Too many replacement characters = binary in disguise; a thumbnail of mojibake helps nobody
  // 替换字符过多说明是伪装成文本的二进制。乱码缩略图毫无意义
  if ((raw.match(/\ufffd/g) || []).length > 20) return null;
  return raw;
}

/** Prose: a white sheet, or the theme's own, depending on what it is prose for.
 *  散文:一张白纸,或者应用自己的那一套 —— 取决于这是给什么写的散文。 */
async function fromText(file, colours) {
  const raw = await textHead(file);
  return raw ? typesetText(raw, colours) : null;
}

/** Source and plain text: the editor they open in. / 源码与纯文本:它们会在其中打开的那个编辑器。 */
async function fromSourceFile(file) {
  const raw = await textHead(file);
  return raw ? fromSource(raw, file.name) : null;
}

// ---------- docx / pptx / html / mhtml / svg / drawio ----------

async function fromDocx(file) {
  const parsed = await docxParse(fileSource(file));
  return parsed ? typesetText(parsed.text.slice(0, 4096), false) : null;
}

/** pptx: the embedded cover image when the file carries one, otherwise a composite of slide 1
 *  (its first picture on top, title and text below).
 *  pptx:文件自带封面图就直接用;否则用第一页合成 —— 首图在上、标题正文在下。 */
async function fromPptx(file) {
  const { pptxOpen } = await loadPptx();
  const deck = await pptxOpen(fileSource(file));
  if (!deck) return null;
  const cover = await deck.cover();
  if (cover) {
    try {
      const bmp = await createImageBitmap(cover);
      const out = await drawCover(bmp, bmp.width, bmp.height, false);
      bmp.close();
      if (out) return out;
    } catch {}
  }
  const slide = await deck.slide(0);
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
      const bytes = await slide.images[0].read();
      const bmp = await createImageBitmap(new Blob([bytes], { type: slide.images[0].mime }));
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
    // Ranged over the File itself: a thumbnail of an 80 MB workbook reads its directory and
    // one worksheet, not eighty megabytes.
    // 直接在 File 上按 Range 读:一本 80 MB 工作簿的缩略图,读的是它的目录和一张工作表,
    // 而不是八十兆字节。
    const book = await mod.xlsxOpen(fileSource(file));
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

/** The picture in the front of a song, wherever this format put it.
 *
 *  Four formats, four places, one question. Exported because the preview asks it too and there is
 *  no reason for two answers: the parsers read a header, cost a few kilobytes of the file, and
 *  need no decoder -- where the alternative is three and a half megabytes of WebAssembly opened to
 *  read a JPEG that was sitting in plain sight.
 *
 *  一首歌开头的那张图,不论这种格式把它放在了哪里。
 *
 *  四种格式、四个地方、一个问题。导出它,是因为预览也要问同一个问题,而没有理由有两个答案:
 *  这些解析器读的是一段头部,代价是文件的几千字节,而且不需要任何解码器 ——
 *  另一条路则是打开三兆半的 WebAssembly,去读一张本来就摆在明面上的 JPEG。 */
export function coverIn(u8) {
  return id3Cover(u8) || mp4Cover(u8) || flacCover(u8) || asfCover(u8);
}

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
/**
 * The picture in a Windows Media file: WM/Picture, in one of the two objects that can hold it.
 *
 * A folder from those years is where this matters -- seventy songs, three of them with a cover,
 * and none of the three reachable by any of the parsers above. The header is a list of objects,
 * each naming itself with a GUID and stating its own length, so it is walked rather than searched:
 * a scan for the name would also find it inside the audio, on the file where somebody happened to
 * sing about pictures.
 *
 * The two objects differ only in how their records are laid out, and both carry the same value: a
 * type, a length, a MIME string and a description in UTF-16, and then the image file as it was
 * put in.
 *
 * Windows Media 文件里的那张图:WM/Picture,在两个装得下它的对象之一里。
 *
 * 一个那些年代的文件夹正是这件事要紧的地方 —— 七十首歌,其中三首有封面,
 * 而这三首用上面任何一个解析器都够不到。头部是一串对象,每个用 GUID 报出自己是谁、
 * 自己有多长,所以这里是"走"过去而不是"搜"过去:按名字去搜,也会在音频里搜到它 ——
 * 在那个恰好有人唱到"图片"的文件上。
 *
 * 那两个对象只在记录的排布上不同,装的是同一样东西:一个类型、一个长度、
 * 一个 UTF-16 的 MIME 串和一段说明,然后是那个图像文件,原样。
 */
const ASF_HEADER = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
const ASF_EXTENDED = [0x40, 0xa4, 0xd0, 0xd2, 0x07, 0xe3, 0xd2, 0x11, 0x97, 0xf0, 0x00, 0xa0, 0xc9, 0x5e, 0xa8, 0x50];
const ASF_LIBRARY = [0x94, 0x1c, 0x23, 0x44, 0x98, 0x94, 0xd1, 0x49, 0xa1, 0x41, 0x1d, 0x13, 0x4e, 0x45, 0x70, 0x54];

function asfCover(u8) {
  const is = (at, want) => want.every((b, i) => u8[at + i] === b);
  const n16 = (at) => u8[at] | (u8[at + 1] << 8);
  const n32 = (at) => (u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16) | (u8[at + 3] << 24)) >>> 0;
  // Lengths are eight bytes wide. Nothing here is four gigabytes, but the high half is read all
  // the same, so that a file which claims to be says something impossible rather than something
  // small. 长度是八个字节宽。这里没有四吉字节的东西,但高的那一半照读 ——
  // 好让一个声称自己有那么大的文件说出一件不可能的事,而不是说出一件小事。
  const n64 = (at) => n32(at) + n32(at + 4) * 4294967296;
  const utf16 = (at, len) => {
    let out = '';
    for (let i = 0; i + 1 < len; i += 2) {
      const c = n16(at + i);
      if (!c) break;
      out += String.fromCharCode(c);
    }
    return out;
  };
  const value = (at, len) => {
    if (len < 9) return null;
    const size = n32(at + 1);
    const end = at + len;
    let q = at + 5;
    const past = () => { while (q + 1 < end && n16(q)) q += 2; q += 2; };
    const from = q;
    past();
    const mime = utf16(from, q - from);
    past();
    if (size <= 64 || q + size > end) return null;
    return new Blob([u8.slice(q, q + size)], { type: /png/i.test(mime) ? 'image/png' : 'image/jpeg' });
  };

  if (u8.length < 30 || !is(0, ASF_HEADER)) return null;
  const objects = n32(24);
  let p = 30;
  for (let i = 0; i < objects && p + 24 <= u8.length; i++) {
    const size = n64(p + 16);
    if (size < 24 || p + size > u8.length) break;
    const body = p + 24;
    if (is(p, ASF_EXTENDED)) {
      let q = body + 2;
      for (let k = n16(body); k > 0 && q + 6 <= u8.length; k--) {
        const nameLen = n16(q);
        const type = n16(q + 2 + nameLen);
        const valLen = n16(q + 4 + nameLen);
        const val = q + 6 + nameLen;
        if (type === 1 && utf16(q + 2, nameLen) === 'WM/Picture') {
          const hit = value(val, valLen);
          if (hit) return hit;
        }
        q = val + valLen;
      }
    } else if (is(p, ASF_LIBRARY)) {
      let q = body + 2;
      for (let k = n16(body); k > 0 && q + 12 <= u8.length; k--) {
        const nameLen = n16(q + 4);
        const type = n16(q + 6);
        const dataLen = n32(q + 8);
        const val = q + 12 + nameLen;
        if (type === 1 && utf16(q + 12, nameLen) === 'WM/Picture') {
          const hit = value(val, dataLen);
          if (hit) return hit;
        }
        q = val + dataLen;
      }
    }
    p += size;
  }
  return null;
}

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



async function fromAudio(file) {
  // Covers live near the start except in rare rear-moov mp4 files; cap what we read
  // 封面一般在文件开头。罕见的 moov 在尾部的 mp4 除外。读取量设上限
  const buf = await (file.size <= 48 * 1024 * 1024 ? file : file.slice(0, 8 * 1024 * 1024)).arrayBuffer();
  const u8 = new Uint8Array(buf);
  // Only the picture that is actually in there. A song with no cover gets no thumbnail: a
  // waveform is a picture of nothing anybody recognises, the same grey scribble for every track,
  // and a folder of those is worse to look at than a folder of file icons.
  // 只要真的在里面的那张图。一首没有封面的歌就不给缩略图:
  // 波形是一张"谁也认不出是什么"的图,每一轨都是同一团灰色涂鸦,
  // 而一整个文件夹的那种东西,比一整个文件夹的文件图标还难看。
  const cover = coverIn(u8);
  if (!cover) return null;
  try {
    const bmp = await createImageBitmap(cover);
    const out = await drawCover(bmp, bmp.width, bmp.height, false);
    bmp.close();
    return out;
  } catch {
    return null;
  }
}
