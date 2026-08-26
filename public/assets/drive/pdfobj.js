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
//   Where each instruction lands on the page comes from pdf.js, which already resolves the
//   transform stack, the fonts and the glyph widths that decide it. Recomputing that here would
//   mean reimplementing a text engine to draw a selection rectangle.
//
//   The two are joined by order alone: pdf.js walks the same tape we do, so the nth image draw
//   it reports is the nth image draw we tokenised. Measured on a real file -- 62 text blocks,
//   263 glyph runs, 106 font changes -- the two counts agree exactly.
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
//   每条指令落在页面何处,来自 pdf.js:变换栈、字体、字形宽度这些决定位置的东西,它已经解好了。
//   在这里重算一遍,等于为了画一个选择框而重写一个排版引擎。
//
//   两者仅靠顺序对齐:pdf.js 和我们走的是同一条带子,所以它报的第 n 次画图,
//   就是我们切出的第 n 次画图。在真实文件上量过 —— 62 个文本块、263 段字形、106 次换字体 ——
//   两边计数完全一致。

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
const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);

export function pageObjects(ops, xobjKind = () => 'image') {
  const out = [];
  let text = null;
  let path = null;
  const flushPath = () => {
    if (path) out.push(path);
    path = null;
  };
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.op === 'BT') {
      flushPath();
      text = { kind: 'text', from: o.from, to: o.to, ops: [i], runs: 0 };
      continue;
    }
    if (o.op === 'ET' && text) {
      text.to = o.to;
      text.ops.push(i);
      out.push(text);
      text = null;
      continue;
    }
    if (text) {
      text.ops.push(i);
      if (o.op === 'Tj' || o.op === 'TJ' || o.op === "'" || o.op === '"') text.runs++;
      continue;
    }
    if (o.op === 'Do') {
      const name = o.args.length ? o.args[o.args.length - 1].v : '';
      const kind = xobjKind(name);
      // A form XObject is somebody else's whole content stream. It is pickable as one thing,
      // which is right -- it was placed as one thing.
      // form XObject 是别人的一整条内容流。它作为一个整体可被指中,这是对的 ——
      // 它当初也是作为一个整体被放上来的。
      flushPath();
      out.push({ kind: kind === 'form' ? 'form' : 'image', from: o.from, to: o.to, ops: [i], name });
      continue;
    }
    if (o.op === 'BI') {
      flushPath();
      out.push({ kind: 'image', from: o.from, to: o.to, ops: [i], name: '', inline: true });
      continue;
    }
    if (PATH_BUILD.has(o.op) || PATH_PAINT.has(o.op)) {
      if (!path) path = { kind: 'path', from: o.from, to: o.to, ops: [] };
      path.to = o.to;
      path.ops.push(i);
      // A clip is not a mark on the page, it is a promise about later marks; ending the group
      // here would split a shape from the clip that shapes it.
      // 裁剪不是画在页面上的痕迹,而是对后续痕迹的约束;在这里断组,
      // 会把一个形状与"决定它形状的那次裁剪"拆开。
      if (PATH_PAINT.has(o.op) && ops[i + 1] && !PATH_BUILD.has(ops[i + 1].op)
        && ops[i + 1].op !== 'W' && ops[i + 1].op !== 'W*') flushPath();
      continue;
    }
    // Anything else -- transforms, colours, state -- belongs to whatever comes next, so a run of
    // paths does not survive it as one object.
    // 其余的东西 —— 变换、颜色、图形状态 —— 属于随后而来的内容,
    // 所以一串路径不会跨过它们仍算一个对象。
    if (o.op === 'q' || o.op === 'Q' || o.op === 'cm' || o.op === 'gs') flushPath();
  }
  flushPath();
  if (text) out.push(text);                            // unterminated BT: keep it pickable
  return out;
}

/**
 * The stream with those byte ranges gone.
 *
 * They are blanked rather than spliced out: every other offset in the caller's model stays
 * valid, so a second delete does not need the first one's arithmetic, and a page can be edited
 * repeatedly without reparsing. Whitespace is what a content stream reads between operations
 * anyway, so the result is a stream that says nothing there rather than a stream with a hole.
 *
 * 把那些字节范围拿掉之后的流。
 *
 * 是抹白而不是剪接:调用方模型里其余的偏移全部照旧有效,于是第二次删除不必做第一次的算术,
 * 一页也可以被反复编辑而无须重新解析。反正内容流在操作之间读到的本来就是空白,
 * 所以结果是一条"那里什么也没说"的流,而不是一条带窟窿的流。
 */
export function cutRanges(src, ranges) {
  if (!ranges.length) return src;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const parts = [];
  let at = 0;
  for (const [from, to] of sorted) {
    if (to <= at) continue;                            // already inside a previous cut
    const start = Math.max(from, at);
    parts.push(src.slice(at, start));
    parts.push(' '.repeat(to - start));
    at = to;
  }
  parts.push(src.slice(at));
  return parts.join('');
}

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
