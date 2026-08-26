// Taking a PDF page apart into things you can point at, and putting it back together without them.
//
// A page is not a document tree. It is one long tape of drawing instructions -- move here, set
// this font, show these glyph codes, paint that image -- and there is no object called "the
// heading" or "the logo" anywhere in it. Every editor that lets you click a picture and press
// delete has to invent that object first, out of the tape.
//
// This module invents it twice over, because neither half can do the other's job:
//
//   The tape's own bytes, tokenised here, are what editing needs. Removing a picture means
//   removing the exact byte range that drew it, leaving everything before and after untouched --
//   PDF has no other way to delete, and rewriting the stream from a model would relayout a page
//   whose author never agreed to be relaid out.
//
//   Where each instruction lands is computed here for everything except text. A picture, a form
//   and a path are placed by the transform stack alone, and tracking that stack is a page of
//   arithmetic with no font in it.
//
//   Text is the exception and gets its box from pdf.js, because where a line of text ends is
//   decided by the width of every glyph in it, and knowing those means reading the font
//   programs -- a text engine, written to draw a selection rectangle.
//
//   Text is also the one kind where that hand-off is safe. Asked to line up the two lists by
//   order, text and images agree object for object on every file tested; paths do not, because
//   pdf.js batches a run of them by rules of its own. So order is relied on only where it was
//   measured to hold, and the rest is not asked of it.
//
// 把一页 PDF 拆成"可以指着的东西",再把它不带那些东西重新装回去。
//
// 一页不是一棵文档树。它是一长条绘制指令的带子 —— 移到这儿、设这个字体、显示这串字形码、
// 画那张图 —— 带子里没有任何一处叫做"标题"或"logo"的对象。凡是能让你点中一张图再按删除的
// 编辑器,都得先从这条带子里把那个对象发明出来。
//
// 本模块把它发明了两遍,因为两边谁也干不了对方的活:
//
//   带子自身的字节,在这里被切成记号,是"编辑"所需要的。删掉一张图,就是删掉画它的那一段
//   确切字节,前后分毫不动 —— PDF 没有别的删除方式,而从模型重新生成整条流,
//   等于把一页从未同意被重排的版面重排一遍。
//
//   除文本之外,每条指令落在何处都在这里算。一张图、一个 form、一条路径,位置只由变换栈决定,
//   而跟踪那个栈不过是一页算术,里面没有字体。
//
//   文本是例外,它的框来自 pdf.js:一行文字到哪儿为止,由其中每个字形的宽度决定,
//   而要知道那些宽度就得去读字体程序 —— 那是一个排版引擎,为了画一个选择框而写。
//
//   文本也恰好是唯一"这样交接是安全的"那一类。让两份清单按顺序对齐时,
//   在测过的每个文件上,文本与图像都逐个吻合;路径不吻合,因为 pdf.js 按它自己的规矩
//   把连续的路径成批处理。所以顺序只在量过它成立的地方被依赖,别处不向它要这个。

/** Bytes that end a token. PDF calls them delimiters; everything else is regular.
 *  终结一个记号的字节。PDF 管它们叫分隔符,其余都是常规字符。 */
const DELIM = '()<>[]{}/%';
const isWS = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';

/**
 * Split a content stream into tokens. Latin-1 throughout: a content stream is bytes, and the
 * strings inside it are glyph codes rather than text -- decoding them as UTF-8 would corrupt
 * every two-byte CID into a replacement character and make the byte offsets lie.
 * 把内容流切成记号。全程 Latin-1:内容流是字节,里面的字符串是字形码而不是文字 ——
 * 按 UTF-8 解会把每个双字节 CID 毁成替换字符,并让字节偏移全部对不上。
 */
function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (isWS(c)) { i++; continue; }
    if (c === '%') {                                   // comment to end of line / 注释到行尾
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    const at = i;
    if (c === '(') {                                   // literal string: nested, escapable
      let depth = 0;
      do {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      } while (i < n && depth > 0);
      toks.push({ t: 'str', v: src.slice(at, i), at, end: i });
      continue;
    }
    if (c === '<' && src[i + 1] !== '<') {             // hex string
      const close = src.indexOf('>', i);
      i = close < 0 ? n : close + 1;
      toks.push({ t: 'str', v: src.slice(at, i), at, end: i });
      continue;
    }
    if (c === '<' || c === '>') {                      // dictionary bracket
      i += 2;
      toks.push({ t: c === '<' ? '<<' : '>>', v: src.slice(at, i), at, end: i });
      continue;
    }
    if (c === '[' || c === ']') {
      i++;
      toks.push({ t: c, v: c, at, end: i });
      continue;
    }
    if (c === '/') {
      i++;
      while (i < n && !isWS(src[i]) && !DELIM.includes(src[i])) i++;
      toks.push({ t: 'name', v: src.slice(at, i), at, end: i });
      continue;
    }
    while (i < n && !isWS(src[i]) && !DELIM.includes(src[i])) i++;
    const raw = src.slice(at, i);
    if (!raw) { i++; continue; }                       // a lone delimiter we do not model
    toks.push({ t: /^[-+.\d]/.test(raw) ? 'num' : 'op', v: raw, at, end: i });
  }
  return toks;
}

/**
 * Group tokens into operations: the operands that were pushed, the operator that consumed them,
 * and the byte range covering both. That range is the unit of editing -- everything this module
 * removes or keeps is a whole number of these.
 * 把记号归成"操作":压进去的操作数、消费它们的操作符,以及覆盖两者的字节范围。
 * 那个范围就是编辑的单位 —— 本模块删掉或留下的,永远是整数个这样的操作。
 */
export function parseOps(src) {
  const toks = tokenize(src);
  const ops = [];
  let args = [];
  let from = -1;
  for (const tk of toks) {
    if (from < 0) from = tk.at;
    // An inline image is the one place the tape stops being tokens: BI ... ID <raw bytes> EI.
    // Scanning it as tokens would read compressed image data as operators.
    // 内联图像是带子上唯一不再是记号的地方:BI ... ID <原始字节> EI。
    // 按记号扫下去,会把压缩的图像数据读成操作符。
    if (tk.t === 'op' && tk.v === 'BI') {
      const end = findInlineEnd(src, tk.end);
      ops.push({ op: 'BI', args: [], from, to: end });
      args = [];
      from = -1;
      continue;
    }
    if (tk.t === 'op') {
      ops.push({ op: tk.v, args, from, to: tk.end });
      args = [];
      from = -1;
    } else {
      args.push(tk);
    }
  }
  return ops;
}

/** Where an inline image ends: the first EI that stands alone after the ID marker.
 *  内联图像在哪儿结束:ID 标记之后,第一个独立成词的 EI。 */
function findInlineEnd(src, from) {
  const id = src.indexOf('ID', from);
  let i = (id < 0 ? from : id + 2) + 1;               // one whitespace byte follows ID
  while (i < src.length) {
    const k = src.indexOf('EI', i);
    if (k < 0) return src.length;
    const before = src[k - 1];
    const after = src[k + 2];
    if (isWS(before) && (after === undefined || isWS(after) || DELIM.includes(after))) return k + 2;
    i = k + 2;
  }
  return src.length;
}

/**
 * The pickable things on a page, in the order they are painted.
 *
 * A text block is BT..ET -- the unit an author would call a text box, and the unit that can be
 * removed without leaving a dangling font or matrix behind. An image is a single Do of an image
 * XObject, or one inline image. Everything else drawn is a path; consecutive path operations
 * under the same transform are gathered into one, because a logo is fifty curves and nobody
 * wants to delete it fifty times.
 *
 * 一页上可以被指中的东西,按绘制顺序排列。
 *
 * 文本块是 BT..ET —— 作者会称之为"文本框"的那个单位,也是可以整体拿掉而不留下悬空字体或
 * 悬空矩阵的那个单位。图像是一次画图像 XObject 的 Do,或一张内联图。其余画出来的都是路径;
 * 同一变换下连续的路径操作会被并成一个,因为一个 logo 是五十条曲线,没人想删五十次。
 */
/**
 * The bytes inside a string token, which are glyph codes and not text.
 *
 * What they mean depends on the font: one byte per glyph for a simple font, two for the CID
 * fonts that CJK needs. Decoding stops here, at bytes, because deciding is the font's business
 * and this only has to hand them over intact.
 *
 * 一个字符串记号里面的字节 —— 它们是字形码,不是文字。
 *
 * 它们表示什么取决于字体:简单字体一个字节一个字形,中日韩要用的 CID 字体是两个。
 * 解码到字节为止,因为"表示什么"是字体的事,这里只负责把它们原样交出去。
 */
export function stringBytes(tok) {
  const v = tok.v;
  const out = [];
  if (v[0] === '<') {                                  // hex: <0048 0065>, odd digit padded with 0
    let hi = -1;
    for (let i = 1; i < v.length && v[i] !== '>'; i++) {
      const d = parseInt(v[i], 16);
      if (Number.isNaN(d)) continue;
      if (hi < 0) hi = d;
      else { out.push(hi * 16 + d); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    return out;
  }
  const ESC = { n: 10, r: 13, t: 9, b: 8, f: 12 };
  for (let i = 1; i < v.length - 1; i++) {
    const c = v[i];
    if (c !== '\\') { out.push(v.charCodeAt(i)); continue; }
    const nx = v[++i];
    if (nx >= '0' && nx <= '7') {                      // up to three octal digits
      let oct = nx;
      while (oct.length < 3 && v[i + 1] >= '0' && v[i + 1] <= '7') oct += v[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (nx === '\n') { /* line continuation: the newline is not in the string */ }
    else if (nx === '\r') { if (v[i + 1] === '\n') i++; }
    else if (ESC[nx] !== undefined) out.push(ESC[nx]);
    else out.push(v.charCodeAt(i));                    // \( , \) , \\ -- and anything else stands for itself
  }
  return out;
}

/**
 * What a font has to be able to say for text to be measured and, later, rewritten.
 *
 * Widths come from the PDF's own font dictionary rather than from the embedded font program.
 * The file is required to carry them and required to keep them consistent with the program, and
 * they are the numbers the original layout was computed from -- so they are both cheaper to read
 * and more faithful to the page than anything recovered from the glyph outlines.
 *
 * 要能量出文本、并在之后重写它,一个字体至少得说出这些。
 *
 * 宽度取自 PDF 自己的字体字典,而不是取自嵌入的字体程序。文件被要求携带它们,
 * 也被要求让它们与字体程序保持一致,而且当初的版面就是照这些数算出来的 ——
 * 所以比起从字形轮廓里还原出来的东西,它们既更省事,也更忠于这一页。
 */
export const DEFAULT_FONT = { bytes: 1, ascent: 0.75, descent: -0.25, width: () => 500 };

/**
 * Matrices as PDF writes them: [a b c d e f], standing for [[a b 0], [c d 0], [e f 1]], and
 * multiplied in the order the operator implies -- cm concatenates onto the left, so the new
 * matrix maps into the space the old one already established.
 * 矩阵按 PDF 的写法:[a b c d e f],代表 [[a b 0], [c d 0], [e f 1]];
 * 相乘的顺序照操作符的含义 —— cm 是往左侧串接,于是新矩阵映射进旧矩阵已经确立的那个空间。
 */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

export const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const emptyBox = () => [Infinity, Infinity, -Infinity, -Infinity];

const grow = (b, x, y) => {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
};

/** A box nothing ever grew is not a box. / 从没被撑开过的框不是框。 */
const realBox = (b) => (b[0] <= b[2] && b[1] <= b[3] ? b : null);

/** The four corners of a rectangle after a transform. Not the transformed rectangle -- a rotation
 *  turns one into a diamond -- but the upright box around it, which is what a selection needs.
 *  一个矩形经变换后的四角。不是"变换后的矩形" —— 旋转会把它变成菱形 —— 而是围住它的正框,
 *  那才是一次选中所需要的。 */
function boxOf(m, rect) {
  const [x0, y0, x1, y1] = rect;
  const b = emptyBox();
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    const [px, py] = apply(m, x, y);
    grow(b, px, py);
  }
  return b;
}

const nums = (args) => args.map((a) => parseFloat(a.v) || 0);

/** How much a transform stretches, taken as the larger of the two axes. Used only to widen a box
 *  by a stroke's half-width, where erring large is erring safely.
 *  一次变换把东西拉大了多少,取两轴中较大的那个。仅用于按线宽的一半把框撑开,
 *  这种地方宁可估大。 */
const scaleOf = (m) => Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));

const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);

/** The path-construction operators, and which of their operands are coordinate pairs.
 *  路径构造操作符,以及它们的操作数里哪些是坐标对。 */
const PATH_POINTS = { m: [0], l: [0], c: [0, 2, 4], v: [0, 2], y: [0, 2], h: [] };

const STROKE_PAINT = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);

/**
 * The pickable things on a page, each with the bytes that draw it and the box it draws inside.
 *
 * @param ops   what parseOps returned
 * @param res   how to look things up in the page's resources:
 *                xobj(name) -> 'image' | 'form' | {kind, bbox, matrix}. A form's BBox and Matrix
 *                  are the only way to know how much page it covers; a caller that cannot resolve
 *                  them may return the kind alone, and forms will have no box.
 *                font(name) -> {bytes, ascent, descent, width(code)}, shaped like DEFAULT_FONT
 *                gs(name)   -> {ca, CA, lineWidth} for one ExtGState, or null
 *              A bare function is accepted in place of the object and taken as xobj.
 * @param base  the transform already in force when this stream starts.
 *
 * 一页上可以被指中的东西,每个都带着"画出它的那些字节"和"它画在哪个框里"。
 *
 * @param res   如何在这一页的资源里查东西:
 *                xobj(name) —— 一个 form 盖住多大地方,只能从它的 BBox 和 Matrix 得知;
 *                  解析不了这两项的调用方可以只返回种类,那样 form 就没有框。
 *                font(name) —— 形状照 DEFAULT_FONT
 *                gs(name)   —— 某个 ExtGState 的 {ca, CA, lineWidth},没有就 null
 *              也接受直接传一个函数,那会被当作 xobj。
 * @param base  这条流开始时已经生效的变换。
 */
export function pageObjects(ops, res = {}, base = IDENTITY) {
  const xobjOf = typeof res === 'function' ? res : (res.xobj || (() => 'image'));
  const fontOf = (typeof res === 'object' && res.font) || (() => DEFAULT_FONT);
  const gsOf = (typeof res === 'object' && res.gs) || (() => null);

  const out = [];
  let path = null;
  let pathBox = null;
  let stroked = false;
  let painted = false;

  // The graphics state, kept only as far as geometry and visibility care about it.
  // 图形状态,只留几何与可见性关心的那部分。
  let ctm = base;
  let lineWidth = 1;
  let fillA = 1;
  let strokeA = 1;
  const stack = [];

  // The text state, which lives only between BT and ET.
  // 文本状态,只活在 BT 与 ET 之间。
  let text = null;
  let tm = IDENTITY;
  let tlm = IDENTITY;
  let fontName = '';
  let font = DEFAULT_FONT;
  let size = 0;
  let charSp = 0;
  let wordSp = 0;
  let hscale = 1;
  let leading = 0;
  let rise = 0;
  let mode = 0;

  const flushPath = () => {
    if (path) {
      if (pathBox && painted) {
        // A stroke is centred on the path, so it reaches half a line-width past it on both sides.
        // 描边以路径为中心,所以两侧各越出半个线宽。
        const pad = stroked ? (lineWidth * scaleOf(ctm)) / 2 : 0;
        path.box = realBox([pathBox[0] - pad, pathBox[1] - pad, pathBox[2] + pad, pathBox[3] + pad]);
      } else path.box = null;
      path.paints = painted;
      out.push(path);
    }
    path = null;
    pathBox = null;
    stroked = false;
    painted = false;
  };

  const applyGS = (o) => {
    const st = gsOf(o.args.length ? o.args[o.args.length - 1].v : '');
    if (!st) return;
    if (typeof st.ca === 'number') fillA = st.ca;
    if (typeof st.CA === 'number') strokeA = st.CA;
    if (typeof st.lineWidth === 'number') lineWidth = st.lineWidth;
  };

  const newline = () => { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; };

  /** Whether glyphs drawn right now would leave a mark. Mode 3 draws nothing and mode 7
   *  only clips; the rest depends on whether the ink is transparent.
   *  此刻画出的字形会不会留下痕迹。模式 3 什么也不画,模式 7 只裁剪;
   *  其余取决于墨水是不是透明的。 */
  const visible = () => mode !== 3 && mode !== 7
    && ((mode === 1 || mode === 5) ? strokeA > 0 : fillA > 0);

  /**
   * Walk one run of glyph codes, growing the box and advancing the text matrix.
   *
   * Every glyph is boxed from its own baseline out to the font's ascent and descent rather than
   * to its own outline. That is deliberately generous: it makes a line of text one even band,
   * the height a person would draw it, instead of a ragged strip that dips wherever a comma sits.
   *
   * 走完一段字形码,把框撑开并推进文本矩阵。
   *
   * 每个字形的框是从它自己的基线量到字体的 ascent 和 descent,而不是量到它自己的轮廓。
   * 这是有意估宽:它让一行文字成为一条齐整的带子 —— 一个人会那样去画它 ——
   * 而不是一条哪里有逗号就往下塌一块的破边。
   */
  const showCodes = (codes, box) => {
    for (let k = 0; k + font.bytes <= codes.length; k += font.bytes) {
      const code = font.bytes === 2 ? codes[k] * 256 + codes[k + 1] : codes[k];
      const w0 = font.width(code) / 1000;
      if (visible()) {
        const trm = mul(mul([size * hscale, 0, 0, size, 0, rise], tm), ctm);
        const gb = boxOf(trm, [0, font.descent, w0, font.ascent]);
        grow(box, gb[0], gb[1]);
        grow(box, gb[2], gb[3]);
      }
      // Word spacing applies to the single byte 32, and to nothing in a two-byte font -- a rule
      // that exists because a CID font may legitimately use 0x0020 as half of some other glyph.
      // 词间距只作用于单字节的 32,在双字节字体里谁也不作用 ——
      // 这条规矩的存在是因为 CID 字体完全可以正当地把 0x0020 用作别的字形的一半。
      const tx = (w0 * size + charSp + (font.bytes === 1 && code === 32 ? wordSp : 0)) * hscale;
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    }
  };

  /** One show operator, recorded whole: what it drew, where, and which bytes said so.
   *  一次显示操作,整个记下来:它画了什么、画在哪儿、以及是哪些字节这么说的。 */
  const showOp = (o, i) => {
    const box = emptyBox();
    const at = tm;
    const codes = [];
    for (const a of o.args) {
      if (a.t === 'str') {
        const b = stringBytes(a);
        for (const c of b) codes.push(c);
        showCodes(b, box);
      } else if (a.t === 'num') {
        // A number between strings nudges the next one back by that many thousandths of an em.
        // 夹在字符串之间的数字,把下一段往回推那么多个千分之一 em。
        const tx = (-parseFloat(a.v) / 1000) * size * hscale;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    }
    const run = {
      at: i, op: o.op, from: o.from, to: o.to,
      font: fontName, size, mode, codes,
      // Where the pen stood when this run began, and the text state it stood in. Enough to lay
      // the run down again somewhere else, or to lay different words down in its place.
      // 这一段开始时笔停在哪里,以及它当时所处的文本状态。
      // 足够把这一段重新放置到别处,或者把别的字放到它原来的位置上。
      tm: at, charSp, wordSp, hscale, rise,
      trm: mul(mul([size * hscale, 0, 0, size, 0, rise], at), ctm),
      box: realBox(box),
    };
    text.runs.push(run);
    if (run.box) {
      grow(text._box, run.box[0], run.box[1]);
      grow(text._box, run.box[2], run.box[3]);
    }
    if (visible()) text.paints = true;
  };

  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const v = o.args.map((a) => (a.t === 'num' ? parseFloat(a.v) || 0 : 0));

    if (o.op === 'BT') {
      flushPath();
      tm = IDENTITY;
      tlm = IDENTITY;
      text = { kind: 'text', from: o.from, to: o.to, ops: [i], runs: [], paints: false, box: null, ctm, _box: emptyBox() };
      continue;
    }
    if (text) {
      text.ops.push(i);
      switch (o.op) {
        case 'ET':
          text.to = o.to;
          text.box = realBox(text._box);
          delete text._box;
          out.push(text);
          text = null;
          break;
        case 'Tf':
          fontName = o.args.length > 1 ? o.args[o.args.length - 2].v : '';
          size = v.length ? v[v.length - 1] : 0;
          font = fontOf(fontName) || DEFAULT_FONT;
          break;
        case 'Td': tlm = mul([1, 0, 0, 1, v[0], v[1]], tlm); tm = tlm; break;
        case 'TD': leading = -v[1]; tlm = mul([1, 0, 0, 1, v[0], v[1]], tlm); tm = tlm; break;
        case 'Tm': if (v.length >= 6) { tlm = v.slice(0, 6); tm = tlm; } break;
        case 'T*': newline(); break;
        case 'TL': leading = v[0]; break;
        case 'Tc': charSp = v[0]; break;
        case 'Tw': wordSp = v[0]; break;
        case 'Tz': hscale = (o.args.length ? v[v.length - 1] : 100) / 100; break;
        case 'Ts': rise = v[0]; break;
        case 'Tr': mode = v[0]; break;
        // Legal inside a text object, and the Word exporter puts it there: the alpha that makes
        // a whole page of words invisible is set between BT and the first Tj.
        // 在文本对象内部是合法的,而 Word 导出器正是把它放在那儿:
        // 那个让整页文字隐形的透明度,设在 BT 与第一个 Tj 之间。
        case 'gs': applyGS(o); break;
        case 'w': if (v.length) lineWidth = v[0]; break;
        case 'Tj': case 'TJ': showOp(o, i); break;
        case "'": newline(); showOp(o, i); break;
        case '"': wordSp = v[0]; charSp = v[1]; newline(); showOp(o, i); break;
        default: break;
      }
      continue;
    }
    if (o.op === 'Do') {
      const name = o.args.length ? o.args[o.args.length - 1].v : '';
      const got = xobjOf(name);
      const info = typeof got === 'string' ? { kind: got } : (got || { kind: 'image' });
      flushPath();
      // An image XObject is drawn into the unit square and shaped entirely by the transform; a
      // form carries its own box and its own matrix, applied inside the transform.
      // 图像 XObject 画在单位正方形里,形状完全由变换决定;
      // form 自带它的框和它的矩阵,在变换内部生效。
      const m = info.matrix ? mul(info.matrix, ctm) : ctm;
      const rect = info.kind === 'form' ? info.bbox : [0, 0, 1, 1];
      out.push({
        kind: info.kind === 'form' ? 'form' : 'image',
        from: o.from, to: o.to, ops: [i], name, ctm, paints: fillA > 0,
        box: rect ? realBox(boxOf(m, rect)) : null,
      });
      continue;
    }
    if (o.op === 'BI') {
      flushPath();
      out.push({
        kind: 'image', from: o.from, to: o.to, ops: [i], name: '', inline: true, ctm, paints: fillA > 0,
        box: realBox(boxOf(ctm, [0, 0, 1, 1])),
      });
      continue;
    }
    if (PATH_BUILD.has(o.op) || PATH_PAINT.has(o.op)) {
      if (!path) { path = { kind: 'path', from: o.from, to: o.to, ops: [] }; pathBox = emptyBox(); }
      path.to = o.to;
      path.ops.push(i);
      path.ctm = ctm;
      if (o.op === 're') {
        // A rectangle is x y w h, and w or h may be negative.
        // 矩形是 x y w h,而 w 或 h 可以是负的。
        for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const [px, py] = apply(ctm, v[0] + dx * v[2], v[1] + dy * v[3]);
          grow(pathBox, px, py);
        }
      } else if (PATH_POINTS[o.op]) {
        // A curve is bounded by the hull of its control points, so taking the points gives a box
        // that certainly contains the curve and sometimes more than it -- the safe direction for
        // something a person is going to click on.
        // 一条曲线被它控制点的凸包所包围,所以直接取这些点,得到的框一定包住曲线,
        // 有时还多包一点 —— 对一个待会儿要被人点中的东西来说,这是安全的那个方向。
        for (const at of PATH_POINTS[o.op]) {
          const [px, py] = apply(ctm, v[at], v[at + 1]);
          grow(pathBox, px, py);
        }
      }
      if (STROKE_PAINT.has(o.op)) stroked = true;
      // n paints nothing. A path built only to be painted with it exists to set a clip, and a
      // clip is not a mark on the page -- there is nothing there for anybody to click on.
      // n 什么也不画。只为用它上色而构造的路径,存在的意义是设一个裁剪区,
      // 而裁剪不是画在页面上的痕迹 —— 那里没有任何东西可供点中。
      if (PATH_PAINT.has(o.op) && o.op !== 'n') {
        painted = STROKE_PAINT.has(o.op) ? strokeA > 0 : fillA > 0;
        if (o.op === 'B' || o.op === 'B*' || o.op === 'b' || o.op === 'b*') painted = fillA > 0 || strokeA > 0;
      }
      if (PATH_PAINT.has(o.op) && ops[i + 1] && !PATH_BUILD.has(ops[i + 1].op)
        && ops[i + 1].op !== 'W' && ops[i + 1].op !== 'W*') flushPath();
      continue;
    }
    if (o.op === 'q') { stack.push([ctm, lineWidth, fillA, strokeA]); flushPath(); continue; }
    if (o.op === 'Q') { const st = stack.pop(); if (st) { [ctm, lineWidth, fillA, strokeA] = st; } flushPath(); continue; }
    if (o.op === 'cm') { if (v.length >= 6) ctm = mul(v.slice(0, 6), ctm); flushPath(); continue; }
    if (o.op === 'w') { if (v.length) lineWidth = v[0]; continue; }
    if (o.op === 'gs') {
      // A graphics state can turn a thing invisible without removing it, and a page whose text
      // was put there to be searched rather than seen does exactly that -- a scan with an OCR
      // layer over it, or the Word export that draws its words at zero alpha above a picture.
      // Such an object is still in the file and still worth listing, but it is not something a
      // person can point at, so it is marked rather than dropped.
      // 一个图形状态可以让东西隐形而不必删掉它,而一份"文字是放来被搜索、不是放来被看"的页面
      // 正是这么干的 —— 盖着 OCR 层的扫描件,或者把字以零透明度画在图片之上的 Word 导出。
      // 这样的对象仍在文件里、仍值得列出,但它不是一个人指得中的东西,
      // 所以给它做个记号,而不是把它扔掉。
      applyGS(o);
      flushPath();
      continue;
    }
    // Anything else -- colours, other state -- belongs to whatever comes next, so a run of paths
    // does not survive it as one object.
    // 其余的东西 —— 颜色、别的状态 —— 属于随后而来的内容,
    // 所以一串路径不会跨过它们仍算一个对象。
  }
  flushPath();
  if (text) {                                          // unterminated BT: keep it pickable
    text.box = realBox(text._box);
    delete text._box;
    out.push(text);
  }
  return out;
}

/**
 * The stream with a list of edits applied: each one replaces a byte range with whatever should
 * stand there instead, and an empty replacement is a deletion.
 *
 * Every edit is measured against the *original* stream, never against the result of the edits
 * before it, and they are all applied in one pass. That is what makes an edit list a document
 * model rather than a sequence of mutations: the offsets in it never go stale, so an edit can be
 * dropped from the middle of the list and the rest still mean what they meant. Undo is that
 * removal, and costs nothing to implement.
 *
 * Overlapping edits are resolved by taking the first and skipping what the later one would have
 * touched, because two edits to the same bytes is a question about intent and this is not the
 * place to guess at one.
 *
 * 一条流,应用了一串编辑之后的样子:每一条把一段字节换成应当站在那儿的东西,
 * 换成空的就是删除。
 *
 * 每一条编辑都是相对*原始*那条流来量的,绝不相对它之前那些编辑的结果,而且一次过全部应用。
 * 正是这一点让"一张编辑表"成为一个文档模型,而不是一串改动:表里的偏移永不过期,
 * 于是可以从中间抽掉一条,其余的仍然还是原来的意思。撤销就是那次抽掉,实现起来不花一分钱。
 *
 * 相互重叠的编辑,取先来的那条,后来那条要碰的部分跳过 ——
 * 两条编辑动同一段字节,那是一个关于意图的问题,而这里不是猜测意图的地方。
 */
export function applyEdits(src, edits) {
  if (!edits || !edits.length) return src;
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  const parts = [];
  let at = 0;
  for (const e of sorted) {
    // Wholly inside a previous edit. An insertion -- a range of no length -- is not inside
    // anything, so several of them at the same point all land, in the order they were made.
    // 完全落在前一条编辑里面。而插入 —— 一段长度为零的范围 —— 不在任何东西里面,
    // 所以同一个点上的好几次插入会全部落下,按它们被做出来的顺序。
    if (e.to < at || (e.to === at && e.from < at)) continue;
    if (e.from > at) parts.push(src.slice(at, e.from));
    parts.push(e.text || '');
    at = Math.max(at, e.to);
  }
  parts.push(src.slice(at));
  return parts.join('');
}

/** Deleting is replacing with nothing. / 删除就是换成空的。 */
export const cutRanges = (src, ranges) => applyEdits(src, ranges.map(([from, to]) => ({ from, to, text: '' })));

/** Latin-1 both ways: the only encoding under which a content stream's bytes survive a round
 *  trip through a JavaScript string.
 *  两个方向都用 Latin-1:内容流的字节唯有在这种编码下,才能原样走完一次 JS 字符串的往返。 */
export const bytesToStr = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
};

export const strToBytes = (s) => {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
};
