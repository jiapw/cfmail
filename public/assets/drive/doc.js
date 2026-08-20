// Shared document extraction for Drive previews and thumbnails: type detection, docx and pptx
// unpacking (ranged, through rzip.js), drawio decompression and drawing, mhtml via the
// already-vendored postal-mime. Every function is defensive -- a parse failure means "no
// preview", never a broken page.
// 网盘预览与缩略图共用的文档解析层:类型判定、docx/pptx 解包(经 rzip.js 按 Range 读)、
// drawio 解压与绘制、mhtml 复用已自托管的 postal-mime。所有函数都保守处理 ——
// 解析失败等于"没有预览",绝不炸页面。
import { openZip, zipPart, zipText } from './rzip.js';

// A .docx keeps its whole text in one part, word/document.xml, and its pictures in another the
// text parser never opens. Read by ranges, that means a 50 MB document costs its central
// directory plus a couple of hundred kilobytes of XML -- the photographs are simply not
// fetched. There is nothing to paginate: pages are something Word computes when it lays the
// document out, and the file has no notion of them at all.
// 一份 .docx 把全部正文放在 word/document.xml 这一个部件里,图片放在另一个 —— 文本解析器
// 从不打开它。按 Range 读,一份 50 MB 的文档只需付出中央目录加两百来 KB 的 XML,
// 照片根本不会被取下来。这里没有"分页"可做:页是 Word 排版时算出来的,文件里没有这个概念。
const DOCX_CAP = 32 * 1024 * 1024;
const DOCX_IMG_MAX = 16 * 1024 * 1024;
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// OOXML measures in EMU: 914400 to the inch, so 9525 to a CSS pixel at 96dpi.
// OOXML 用 EMU 计量:每英寸 914400,于是 96dpi 下每 CSS 像素 9525。
const EMU_PX = 9525;
const IMG_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
};

// ---------- Type detection ----------
// ---------- 类型判定 ----------

// Code-ish extensions rendered in monospace, as broad as reasonable
// 等宽字体渲染的代码类扩展名。尽量宽
const CODE_EXTS = new Set([
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'ino',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'map',
  'xml', 'xsl', 'xsd', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'psd1',
  'py', 'pyw', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'cs', 'fs', 'vb',
  'm', 'mm', 'lua', 'pl', 'pm', 'r', 'jl', 'scala', 'dart', 'groovy', 'gradle',
  'sql', 'graphql', 'gql', 'proto', 'thrift', 'tf', 'hcl',
  'css', 'scss', 'less', 'styl', 'vue', 'svelte', 'astro',
  'asm', 's', 'f', 'f90', 'f95', 'ex', 'exs', 'erl', 'hs', 'elm', 'clj', 'cljs', 'edn',
  'lisp', 'scm', 'ml', 'mli', 'nim', 'zig', 'v', 'd', 'pas', 'vbs', 'ahk',
  'diff', 'patch', 'cmake', 'mk', 'ninja', 'bazel', 'bzl', 'nix', 'dockerfile',
  'log', 'lock', 'ipynb', 'rst', 'tex', 'bib',
  // JSON Lines and its neighbours. One record per line is the whole point of the format, so
  // they belong here, in the monospace reader that shows lines -- not with the documents.
  // A .jsonl used to match nothing at all and came out as "cannot preview".
  // JSON Lines 及其同类。一行一条记录正是这个格式的全部意义，
  // 所以它们属于这里 —— 那个按行展示的等宽阅读器，而不是文档那边。
  // 一个 .jsonl 过去什么都匹配不上，直接出“无法预览”。
  'jsonl', 'ndjson', 'jsonlines', 'har',
  // Log-ish suffixes people actually use / 人们真在用的日志后缀
  'out', 'err', 'trace', 'syslog',
  // Text formats that were simply missing / 单纯是漏掉的文本格式
  'mts', 'cts', 'pyi', 'awk', 'po', 'pot', 'plist', 'reg',
  // Certificates and public keys are PEM text; a private key is deliberately not listed
  // 证书与公钥是 PEM 文本；私钥有意不列入
  'pem', 'crt', 'cer', 'csr',
]);
// Files that are code by NAME rather than extension / 按文件名而非扩展名识别的代码文件
const CODE_NAMES = new Set(['makefile', 'dockerfile', 'cmakelists.txt', 'rakefile', 'gemfile', 'procfile', 'vagrantfile', 'jenkinsfile', '.gitignore', '.gitattributes', '.editorconfig', '.env']);

export const ext = (name) => (/\.([A-Za-z0-9]{1,12})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();

// Audio by extension, for files the browser gives no MIME type (.aac and friends)
// 按扩展名识别音频。浏览器对 .aac 之类常常不给 MIME
export const AUD_EXTS = new Set(['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'weba', 'wma', 'mka', 'aiff', 'aif']);

/** Document kind for preview/thumbnail dispatch; media types (image/video/audio/pdf) are
 *  handled by the callers themselves. null = no rich handling.
 *  预览/缩略图分发用的文档类型。媒体类(图/音/视频/PDF)由调用方自行处理。null=不认识。 */
export function kindOf(name, mime) {
  const m = String(mime || '').toLowerCase().split(';')[0];
  const e = ext(name);
  const base = String(name || '').toLowerCase();
  if (m.startsWith('audio/') || AUD_EXTS.has(e)) return 'audio';
  if (e === 'md' || e === 'markdown' || m === 'text/markdown') return 'md';
  if (e === 'docx' || m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (e === 'pptx' || m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  // Delimited text is a grid, not code. It used to fall through to the monospace renderer,
  // which prints the commas and lets nothing line up -- the one thing a table has to do.
  // 带分隔符的文本是网格,不是代码。它过去落到等宽渲染器,把逗号原样打出来、什么也对不齐 ——
  // 而"对齐"恰是表格唯一必须做到的事。
  if (SHEET_EXTS.has(e) || m === XLSX_MIME || m === 'text/csv' || m === 'text/tab-separated-values') return 'sheet';
  if (e === 'svg' || m === 'image/svg+xml') return 'svg';
  if (e === 'drawio') return 'drawio';
  if (e === 'mht' || e === 'mhtml' || m === 'multipart/related' || m === 'message/rfc822') return 'mhtml';
  if (e === 'html' || e === 'htm' || e === 'xhtml' || m === 'text/html') return 'html';
  if (CODE_EXTS.has(e) || CODE_NAMES.has(base)) return 'code';
  if (e === 'txt' || e === 'text' || SUB_EXTS.has(e) || TEXT_NAMES.has(base) || m.startsWith('text/')) return 'txt';
  return null;
}

// Subtitles and lyrics read as plain text / 字幕与歌词按纯文本读
const SUB_EXTS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub', 'lrc']);

// Files a project keeps at its root with no extension at all. They are prose, not code, so
// they read in the interface font rather than monospace.
// 项目根目录下那些根本没有扩展名的文件。它们是散文而非代码，
// 所以用界面字体而不是等宽字体来读。
const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'copying', 'notice', 'authors',
  'changelog', 'changes', 'todo', 'install', 'news', 'contributing']);

// Spreadsheets. `xls` is deliberately absent: the pre-2007 binary format shares nothing with
// these but the icon, and claiming it here would promise a preview that cannot be delivered.
// 电子表格。有意不含 `xls`:2007 之前的二进制格式除了图标之外与这些毫无共通之处,
// 在此认领它等于承诺一个交付不了的预览。
const SHEET_EXTS = new Set(['xlsx', 'xlsm', 'xltx', 'csv', 'tsv', 'tab']);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------- Small helpers ----------
// ---------- 小工具 ----------

/** Visible text of an HTML string, without executing or loading anything (DOMParser documents
 *  are inert: no scripts run, no subresources fetch).
 *  从 HTML 字符串提取可见文本。不执行不加载(DOMParser 的文档是惰性的:脚本不跑、资源不取)。 */
export function htmlText(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('script,style,noscript,template').forEach((n) => n.remove());
    return (doc.body?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
}

const NS = (root, local) => [...root.getElementsByTagNameNS('*', local)];

// ---------- docx ----------

/** A prefixed attribute, read both ways. A document that declares the prefix answers to the
 *  qualified name; one that binds the namespace differently answers to the namespace lookup.
 *  一个带前缀的属性,两种方式都试。声明了该前缀的文档认得限定名;
 *  以别的方式绑定命名空间的文档认得命名空间查找。 */
const attrNS = (el, prefix, ns, name) =>
  el.getAttribute(`${prefix}:${name}`) || el.getAttributeNS(ns, name) || '';

/** Relationship id -> path inside the package. Targets are written relative to the part that
 *  owns the .rels file, so they are resolved against word/ before anything looks them up.
 *  关系 id → 包内路径。Target 是相对于"拥有这个 .rels 的部件"书写的,
 *  所以在任何人拿它去查之前,先按 word/ 解析成完整路径。 */
async function docxRels(zip) {
  const map = new Map();
  const xml = await zipText(zip, 'word/_rels/document.xml.rels', 1 << 20);
  if (!xml) return map;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  for (const el of [...doc.getElementsByTagName('*')]) {
    if (el.localName !== 'Relationship') continue;
    // An external target is a URL to somewhere else entirely; there is nothing in the package
    // to read, and following it would fetch off-origin on the reader's behalf.
    // 外部 target 是指向别处的 URL;包里没有任何东西可读,
    // 而跟过去等于代读者去拉一个跨源资源。
    if (el.getAttribute('TargetMode') === 'External') continue;
    const id = el.getAttribute('Id');
    const target = el.getAttribute('Target') || '';
    if (!id || !target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const out = [];
    for (const seg of (target.startsWith('/') ? target.slice(1) : `word/${target}`).split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    if (out.length) map.set(id, out.join('/'));
  }
  return map;
}

/** The picture a run carries, if it carries one. Both spellings: the modern DrawingML blip and
 *  the older VML imagedata that Word still emits for some pasted content.
 *  一个 run 所携带的图片(如果它带了的话)。两种写法都认:现代 DrawingML 的 blip,
 *  以及 Word 至今仍会为某些粘贴内容吐出的老式 VML imagedata。 */
function docxImage(r) {
  const blip = NS(r, 'blip')[0];
  const vml = NS(r, 'imagedata')[0];
  const rid = blip ? attrNS(blip, 'r', REL_NS, 'embed') : vml ? attrNS(vml, 'r', REL_NS, 'id') : '';
  if (!rid) return null;
  const ext = NS(r, 'extent')[0];
  const w = Math.round(parseInt(ext?.getAttribute('cx') || '0', 10) / EMU_PX) || 0;
  const h = Math.round(parseInt(ext?.getAttribute('cy') || '0', 10) / EMU_PX) || 0;
  // Rotation is in sixtieths of a degree. It is not decoration: a page of photographs off a
  // phone is mostly rotated frames, and dropping the angle shows every one of them on its side.
  // 旋转角以 1/60 度为单位。它不是装饰:一页手机照片多半整页都是旋转过的框,
  // 丢掉这个角度,等于把每一张都侧着放出来。
  const xfrm = NS(r, 'xfrm')[0];
  const deg = Math.round(parseInt(xfrm?.getAttribute('rot') || '0', 10) / 60000);
  return { kind: 'img', rid, w, h, rot: ((deg % 360) + 360) % 360 };
}

/**
 * Paragraph model out of word/document.xml. Enough for a readable sheet: heading levels,
 * bold and italic runs, list bullets, simple tables, and the pictures in between.
 * 从 word/document.xml 抽段落模型。读得下去就够:标题层级、粗斜体、列表圆点、简单表格。
 * @returns {Promise<{blocks: any[], text: string}|null>}
 */
export async function docxParse(source) {
  try {
    const zip = await openZip(source);
    const docXml = await zipText(zip, 'word/document.xml', DOCX_CAP);
    if (!docXml) return null;
    const rels = await docxRels(zip);
    const xml = new DOMParser().parseFromString(docXml, 'application/xml');
    const body = NS(xml, 'body')[0];
    if (!body) return null;
    const blocks = [];
    const texts = [];
    // A paragraph is a sequence, not a thing: text, then a picture, then more text, in the
    // order Word wrote them. Returning one block per paragraph was fine while only the text was
    // being read; a picture has to land where it stands, so this yields as many blocks as the
    // paragraph has parts.
    // 一个段落是一串东西,而不是一个东西:文字、图片、再文字,按 Word 写下的顺序。
    // 只读文字时"一段一块"没问题;而图片必须落在它所在的位置,
    // 所以这里按段落的组成部分产出相应数量的块。
    const readPara = (p) => {
      const styleEl = NS(p, 'pStyle')[0];
      const style = styleEl?.getAttribute('w:val') || styleEl?.getAttributeNS('*', 'val') || '';
      const listed = NS(p, 'numPr').length > 0;
      const hm = /^Heading([1-6])$/i.exec(style) || /^[1-6]$/.exec(style);
      const h = hm ? parseInt(hm[1] || hm[0], 10) : 0;
      const out = [];
      let runs = [];
      const flush = () => {
        if (!runs.length) return;
        const text = runs.map((x) => x.t).join('');
        if (text) texts.push(text);
        out.push({ kind: 'p', h, listed, runs });
        runs = [];
      };
      for (const r of NS(p, 'r')) {
        const img = docxImage(r);
        if (img) {
          flush();
          out.push(img);
          continue;
        }
        const t = NS(r, 't').map((x) => x.textContent).join('');
        if (!t) continue;
        // w:sz is in half-points; carry it so the preview can restore the document's own sizes
        // w:sz 的单位是半磅。带出来让预览按文档自己的字号还原
        const szEl = NS(r, 'sz')[0];
        const sz = szEl ? parseInt(szEl.getAttribute('w:val') || '0', 10) / 2 : 0;
        runs.push({ t, b: NS(r, 'b').length > 0, i: NS(r, 'i').length > 0, sz });
      }
      flush();
      // An empty paragraph is a blank line the author put there on purpose
      // 空段落是作者有意留下的一个空行
      if (!out.length) out.push({ kind: 'p', h, listed, runs: [] });
      return out;
    };
    for (const el of body.children) {
      const local = el.localName;
      if (local === 'p') {
        blocks.push(...readPara(el));
      } else if (local === 'tbl') {
        const rows = [];
        for (const tr of NS(el, 'tr')) {
          const cells = [];
          for (const tc of [...tr.children].filter((x) => x.localName === 'tc')) {
            const parts = NS(tc, 'p').map((p) => NS(p, 't').map((x) => x.textContent).join(''));
            const cellText = parts.filter(Boolean).join('\n');
            cells.push(cellText);
            if (cellText) texts.push(cellText);
          }
          if (cells.length) rows.push(cells);
        }
        if (rows.length) blocks.push({ kind: 'table', rows });
      }
      if (blocks.length > 2000) break; // enough for any preview / 预览用途足够了
    }
    // The zip stays open behind this: pictures are read one at a time, when something asks
    // for one, over the same ranged source the text came from. A document of twenty photographs
    // is twenty megabytes, and a reader who opens it to check a date should not pay for them.
    // zip 在这之后仍开着:图片一次读一张,在有人要的时候读,走的是取正文时的同一个 Range 源。
    // 一份二十张照片的文档有二十兆,而一个打开它只为核对日期的读者,不该为它们买单。
    const image = async (rid) => {
      const path = rels.get(rid);
      if (!path) return null;
      const bytes = await zipPart(zip, path, DOCX_IMG_MAX);
      if (!bytes || !bytes.length) return null;
      return { bytes, mime: IMG_MIME[ext(path)] || 'application/octet-stream' };
    };
    return { blocks, text: texts.join('\n'), image };
  } catch {
    return null;
  }
}
// ---------- pptx: moved to pptx.js, loaded on demand ----------
// ---------- pptx引擎已移到 pptx.js。按需加载 ----------
// ---------- drawio ----------

/** Inflate one <diagram> payload: base64 -> raw-deflate -> URI-decode (that is how drawio
 *  packs it). Uncompressed child XML passes straight through.
 *  解一个 <diagram>:base64 → raw-deflate 解压 → URI 解码(drawio 就是这么打包的)。
 *  未压缩的子 XML 直接透传。 */
async function drawioInflate(diagramEl) {
  const inner = diagramEl.querySelector('mxGraphModel');
  if (inner) return inner;
  const b64 = (diagramEl.textContent || '').trim();
  if (!b64) return null;
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ds = new DecompressionStream('deflate-raw');
  const buf = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
  const xml = decodeURIComponent(new TextDecoder().decode(buf).replace(/\+/g, '%20')
    .replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return doc.querySelector('mxGraphModel');
}

/**
 * Pages of a .drawio file as flat cell lists ready to draw.
 * 把 .drawio 文件的每一页解析成可直接绘制的图元列表。
 * @returns {Promise<Array<{name: string, cells: any[]}>>}
 */
export async function drawioPages(text, maxPages = 20) {
  const out = [];
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    let diagrams = [...doc.querySelectorAll('diagram')].slice(0, maxPages);
    // A bare mxGraphModel file (no mxfile wrapper) is also valid
    // 也有不带 mxfile 外壳、直接就是 mxGraphModel 的文件
    const models = diagrams.length
      ? await Promise.all(diagrams.map((d) => drawioInflate(d).catch(() => null)))
      : [doc.querySelector('mxGraphModel')];
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      if (!model) continue;
      const cells = [];
      const byId = new Map();
      for (const c of model.querySelectorAll('mxCell')) {
        const g = c.querySelector(':scope > mxGeometry');
        const cell = {
          id: c.getAttribute('id') || '',
          vertex: c.getAttribute('vertex') === '1',
          edge: c.getAttribute('edge') === '1',
          style: c.getAttribute('style') || '',
          label: htmlText(c.getAttribute('value') || ''),
          source: c.getAttribute('source') || '',
          target: c.getAttribute('target') || '',
          x: g ? parseFloat(g.getAttribute('x') || '0') : 0,
          y: g ? parseFloat(g.getAttribute('y') || '0') : 0,
          w: g ? parseFloat(g.getAttribute('width') || '0') : 0,
          h: g ? parseFloat(g.getAttribute('height') || '0') : 0,
          points: g
            ? [...g.querySelectorAll('mxPoint')]
                .filter((p) => p.getAttribute('as') !== 'sourcePoint' || true)
                .map((p) => ({
                  x: parseFloat(p.getAttribute('x') || '0'),
                  y: parseFloat(p.getAttribute('y') || '0'),
                  as: p.getAttribute('as') || '',
                }))
            : [],
        };
        cells.push(cell);
        byId.set(cell.id, cell);
      }
      out.push({ name: diagrams[i]?.getAttribute('name') || `Page ${i + 1}`, cells, byId });
    }
  } catch {}
  return out;
}

const styleVal = (style, key) => {
  const m = new RegExp(`(?:^|;)${key}=([^;]*)`).exec(style || '');
  return m ? m[1] : null;
};

/** Draw one drawio page onto a canvas, scaled to fit. Vertices become rectangles, ellipses or
 *  rhombi with centred labels; edges become lines through their waypoints. Faithful enough to
 *  recognise a diagram, deliberately nothing more.
 *  把一页 drawio 画到 canvas 上并缩放适配。节点画成矩形/椭圆/菱形加居中标签,连线沿途经点画折线。
 *  以"认得出是哪张图"为度,有意不做更多。 */
export function drawioDraw(page, canvas, cssWidth, dpr = 1) {
  const verts = page.cells.filter((c) => c.vertex && c.w > 0 && c.h > 0);
  const edges = page.cells.filter((c) => c.edge);
  if (!verts.length && !edges.length) return false;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const v of verts) {
    x0 = Math.min(x0, v.x);
    y0 = Math.min(y0, v.y);
    x1 = Math.max(x1, v.x + v.w);
    y1 = Math.max(y1, v.y + v.h);
  }
  for (const e of edges) {
    for (const p of e.points) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  if (!Number.isFinite(x0)) return false;
  const pad = 20;
  const bw = x1 - x0 + pad * 2;
  const bh = y1 - y0 + pad * 2;
  const scale = Math.min(cssWidth / bw, 4000 / bh, 2);
  const W = Math.round(bw * scale * dpr);
  const H = Math.round(bh * scale * dpr);
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = Math.round(bw * scale) + 'px';
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.scale(scale * dpr, scale * dpr);
  g.translate(-x0 + pad, -y0 + pad);
  const center = (c) => ({ cx: c.x + c.w / 2, cy: c.y + c.h / 2 });
  g.strokeStyle = '#666';
  g.lineWidth = 1.2;
  for (const e of edges) {
    const s = page.byId.get(e.source);
    const t = page.byId.get(e.target);
    const way = e.points.filter((p) => !p.as);
    const pts = [];
    if (s) pts.push(center(s));
    else {
      const sp = e.points.find((p) => p.as === 'sourcePoint');
      if (sp) pts.push({ cx: sp.x, cy: sp.y });
    }
    for (const p of way) pts.push({ cx: p.x, cy: p.y });
    if (t) pts.push(center(t));
    else {
      const tp = e.points.find((p) => p.as === 'targetPoint');
      if (tp) pts.push({ cx: tp.x, cy: tp.y });
    }
    if (pts.length < 2) continue;
    g.beginPath();
    g.moveTo(pts[0].cx, pts[0].cy);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].cx, pts[i].cy);
    g.stroke();
  }
  for (const v of verts) {
    const fill = styleVal(v.style, 'fillColor') || '#ffffff';
    const stroke = styleVal(v.style, 'strokeColor') || '#36393d';
    g.fillStyle = fill === 'none' ? 'rgba(0,0,0,0)' : fill;
    g.strokeStyle = stroke === 'none' ? 'rgba(0,0,0,0)' : stroke;
    g.lineWidth = 1.3;
    g.beginPath();
    if (/(^|;)ellipse/.test(v.style)) {
      g.ellipse(v.x + v.w / 2, v.y + v.h / 2, v.w / 2, v.h / 2, 0, 0, Math.PI * 2);
    } else if (/(^|;)rhombus/.test(v.style)) {
      g.moveTo(v.x + v.w / 2, v.y);
      g.lineTo(v.x + v.w, v.y + v.h / 2);
      g.lineTo(v.x + v.w / 2, v.y + v.h);
      g.lineTo(v.x, v.y + v.h / 2);
      g.closePath();
    } else if (styleVal(v.style, 'rounded') === '1') {
      g.roundRect(v.x, v.y, v.w, v.h, Math.min(8, v.h / 4));
    } else {
      g.rect(v.x, v.y, v.w, v.h);
    }
    if (fill !== 'none') g.fill();
    if (stroke !== 'none') g.stroke();
    if (v.label) {
      g.fillStyle = styleVal(v.style, 'fontColor') || '#1f1f1f';
      const fs = Math.min(14, Math.max(9, v.h / 3));
      g.font = `${fs}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const label = v.label.length > 40 ? v.label.slice(0, 39) + '…' : v.label;
      g.fillText(label, v.x + v.w / 2, v.y + v.h / 2, Math.max(v.w - 6, 20));
    }
  }
  return true;
}

// ---------- mhtml ----------

// A dedicated MHTML parser. Mail parsers are the wrong tool here: saved pages use
// Content-Transfer-Encoding: binary (which mail never has, and which byte-mangles through a
// text pipeline) and reference parts by Content-Location URL (which mail parsers do not
// surface) -- often via RELATIVE src attributes that need resolving against the document's
// own location. Latin1 string round-trips are byte-exact, so splitting happens on a latin1
// view and bodies convert back losslessly.
// 专用的 MHTML 解析器。邮件解析器干不了这活:网页存档用 binary 编码(邮件世界没有,
// 走文本管道字节会坏),部件靠 Content-Location URL 引用(邮件解析器不暴露),
// 而且 HTML 里常是相对路径,要按主文档位置换算。latin1 字符串与字节一一对应,
// 切分在 latin1 视图上做,正文可无损还原成字节。

const latin1Of = (u8) => {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return s;
};
const bytesOf = (latin1) => {
  const out = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) out[i] = latin1.charCodeAt(i) & 0xff;
  return out;
};
const b64Of = (u8) => btoa(latin1Of(u8));

function mhtmlHeaders(raw) {
  const h = {};
  let last = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      h[last] += ' ' + line.trim();
    } else {
      const m = /^([\w-]+):\s*(.*)$/.exec(line);
      if (m) {
        last = m[1].toLowerCase();
        h[last] = m[2];
      }
    }
  }
  return h;
}

function mhtmlDecode(body, cte) {
  if (cte === 'base64') {
    try {
      return bytesOf(atob(body.replace(/[\s\r\n]+/g, '')));
    } catch {
      return bytesOf(body);
    }
  }
  if (cte === 'quoted-printable') {
    const qp = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));
    return bytesOf(qp);
  }
  // binary / 8bit / 7bit: the bytes are already the bytes / 字节本身就是内容
  return bytesOf(body);
}

/**
 * The main HTML document of an .mht/.mhtml archive with its image parts swapped to data: URLs.
 * Matches cid: references, absolute Content-Location URLs AND the relative form those URLs take
 * against the main document's own location. Returns { html, text }.
 * 取 .mht/.mhtml 的主 HTML 文档,图片部件换成 data: URL。同时匹配 cid: 引用、
 * Content-Location 绝对 URL、以及相对主文档位置的相对写法。返回 { html, text }。
 */
export async function mhtmlParse(buf) {
  try {
    const bin = latin1Of(new Uint8Array(buf));
    const bm = /boundary="?([^"\r\n;]+)"?/i.exec(bin.slice(0, 8192));
    if (!bm) return null;
    const bound = '--' + bm[1];
    const parts = [];
    for (const chunk of bin.split(bound).slice(1)) {
      if (chunk.startsWith('--')) break; // terminator / 结束标记
      const c = chunk.replace(/^\r?\n/, '');
      const he = c.search(/\r?\n\r?\n/);
      if (he < 0) continue;
      const headers = mhtmlHeaders(c.slice(0, he));
      // The CRLF before the next boundary belongs to the boundary, not the body
      // 下一个 boundary 前的换行属于 boundary,不属于正文
      const body = c.slice(he).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
      const ctype = headers['content-type'] || '';
      parts.push({
        type: ctype.split(';')[0].trim().toLowerCase(),
        charset: /charset="?([\w-]+)/i.exec(ctype)?.[1] || 'utf-8',
        location: (headers['content-location'] || '').trim(),
        cid: (headers['content-id'] || '').replace(/[<>\s]/g, ''),
        bytes: mhtmlDecode(body, (headers['content-transfer-encoding'] || 'binary').toLowerCase()),
      });
    }
    const main = parts.find((p) => p.type === 'text/html');
    if (!main) return null;
    let html;
    try {
      html = new TextDecoder(main.charset).decode(main.bytes);
    } catch {
      html = new TextDecoder().decode(main.bytes);
    }
    // Base directory of the main document, for resolving relative src references
    // 主文档所在目录。用于换算相对 src 引用
    const baseDir = main.location.includes('/') ? main.location.slice(0, main.location.lastIndexOf('/') + 1) : '';
    for (const p of parts) {
      if (!/^image\//.test(p.type) || !p.bytes.length) continue;
      const dataUrl = `data:${p.type};base64,${b64Of(p.bytes)}`;
      if (p.cid) html = html.split(`cid:${p.cid}`).join(dataUrl);
      if (p.location) {
        html = html.split(p.location).join(dataUrl);
        if (baseDir && p.location.startsWith(baseDir)) {
          html = html.split(p.location.slice(baseDir.length)).join(dataUrl);
        }
      }
    }
    return { html, text: htmlText(html) };
  } catch {
    return null;
  }
}
