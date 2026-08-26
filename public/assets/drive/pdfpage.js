// Reading a page out of a PDF file, and putting an edited one back.
//
// pdfobj.js knows what a content stream means but nothing about the file around it -- deliberately,
// because that keeps the hard part testable without a document. This is the other half: the
// resource dictionaries a page points at, turned into the plain lookups that module asks for.
//
// Most of it is about fonts, and about a fact that shapes the whole editor: a PDF does not store
// its text. It stores glyph codes, which are numbers with no agreed meaning -- the font decides
// what number 43 draws, and a subset font invents its own numbering as it is built. What the file
// does store, when it was made by a tool that cared, is a ToUnicode map saying which characters
// those numbers were standing in for. Reading text out of a page means reading that map, and a
// page whose maker left it out is a page whose text can be moved and deleted but not read.
//
// 把一页从 PDF 文件里读出来,再把改过的放回去。
//
// pdfobj.js 懂一条内容流的含义,却对它周围的文件一无所知 —— 这是有意的,
// 那样最难的那部分不需要一份文档就能测。这里是另一半:一页所指向的那些资源字典,
// 化成那个模块要的几个简单查询。
//
// 其中大半关于字体,也关于一个决定了整个编辑器形状的事实:PDF 并不存它的文字。
// 它存的是字形码 —— 一串没有公认含义的数字:数字 43 画出什么由字体说了算,
// 而一个子集字体是在被造出来的过程中自行编号的。文件真正存下来的,
// 如果做它的工具还算上心,是一张 ToUnicode 表,说明那些数字当初代表哪些字符。
// 从一页里读出文字,就是去读那张表;而一份做的人没留下这张表的文件,
// 它的文字可以被移动、被删除,但读不出来。

import { PDFName, PDFRawStream, decodePDFRawStream } from '/vendor/pdfedit/pdfedit.entry.js';
import { DEFAULT_FONT, bytesToStr, strToBytes } from './pdfobj.js';

const num = (x) => (typeof x?.asNumber === 'function' ? x.asNumber() : undefined);
const arr = (x) => x?.asArray?.();

/** A page's drawing instructions. Several streams are one stream with newlines between them, which
 *  is what the specification says they are, and what every offset in this module counts against.
 *  一页的绘制指令。几条流就是中间夹换行的一条流 —— 规范就是这么说的,
 *  本模块里每一个偏移也都是照这个数的。 */
export function contentOf(page) {
  const c = page.node.Contents();
  if (!c) return '';
  // Asked what it is by what it can do, not by what its class is called. The library arrives here
  // minified, where every class is named by one letter and no two builds agree on which -- a
  // check against a class name passes in a test run and fails in the shipped one, which is the
  // worst way for a check to be wrong.
  // 靠"它会做什么"来问它是什么,而不是靠"它的类叫什么"。这个库到这里时是压缩过的,
  // 每个类都只剩一个字母的名字,而且没有哪两次构建会在"是哪个字母"上取得一致 ——
  // 一个照类名去比的判断,在测试里通过、在发出去的那份里失败,而这是一个判断能错的最坏方式。
  const list = typeof c.asArray === 'function'
    ? c.asArray().map((r) => page.node.context.lookup(r))
    : [c];
  return list.filter(Boolean)
    .map((st) => (st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : st.getContents()))
    .map(bytesToStr)
    .join(String.fromCharCode(10));
}

/** Put an edited stream back as the page's only stream, compressed.
 *  把改过的流作为这一页唯一的流放回去,压缩存放。 */
export function setContent(doc, page, str) {
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(strToBytes(str))));
}

/** Which XObjects a page can draw, and how much room each one takes.
 *  一页能画哪些 XObject,以及每个占多大地方。 */
export function xobjOf(page) {
  const map = {};
  const xo = page.node.Resources()?.lookup?.(PDFName.of('XObject'));
  if (xo?.entries) {
    for (const [k, ref] of xo.entries()) {
      const st = page.node.context.lookup(ref);
      const d = st?.dict;
      if (!d) continue;
      const isForm = String(d.lookup(PDFName.of('Subtype'))).includes('Form');
      map['/' + k.asString().replace(/^\//, '')] = isForm
        ? { kind: 'form', bbox: arr(d.lookup(PDFName.of('BBox')))?.map(num), matrix: arr(d.lookup(PDFName.of('Matrix')))?.map(num), ref }
        : { kind: 'image', ref };
    }
  }
  return (name) => map[name] || { kind: 'image' };
}

/** The widths a Type0 font declares, from the /W array: runs written either as one start code and
 *  a list, or as a first and last code sharing one width.
 *  一个 Type0 字体声明的宽度,来自 /W 数组:每段要么写成"起始码 + 一串宽度",
 *  要么写成"首码 尾码 共用一个宽度"。 */
function cidWidths(w, dw) {
  const table = new Map();
  if (w) {
    for (let i = 0; i < w.length;) {
      const first = num(w[i]);
      const second = w[i + 1];
      const list = arr(second);
      if (list) {
        list.forEach((x, k) => table.set(first + k, num(x)));
        i += 2;
      } else {
        const last = num(second);
        const width = num(w[i + 2]);
        // A range may be enormous and is not worth expanding; kept as a range and searched.
        // 一个区间可能极大,不值得展开;留作区间去查。
        table.set('r' + table.size, [first, last, width]);
        i += 3;
      }
    }
  }
  const ranges = [...table.entries()].filter(([k]) => typeof k === 'string').map(([, v]) => v);
  return (code) => {
    const hit = table.get(code);
    if (typeof hit === 'number') return hit;
    for (const [a, b, width] of ranges) if (code >= a && code <= b) return width;
    return dw;
  };
}

/**
 * How far a font's glyphs reach above and below the baseline, in fractions of an em.
 *
 * The font bounding box, not Ascent and Descent. Those two are typographic advice -- where lines
 * should be spaced -- and glyphs routinely go past them: a dollar sign dips below the declared
 * descent, an underscore sits lower still, and a CJK face fills more height than its own Ascent
 * admits. Measured against a renderer, using them put the box inside the ink on eleven of
 * thirty-six text blocks, by as much as seven points. The bounding box is what the outlines
 * actually fit in, which is the question being asked.
 *
 * It is generous in the other direction, and that is the right way to be wrong here: a selection
 * a little taller than its letters is a line box, which is what a person drawing a rectangle
 * around a line of text would draw anyway.
 *
 * 一个字体的字形在基线上下各伸出多远,以 em 的比例计。
 *
 * 用字体包围盒,而不是 Ascent 和 Descent。那两个是排版上的建议 —— 行距该怎么定 ——
 * 而字形经常越过它们:美元符号伸到声明的 descent 以下,下划线还要更低,
 * 中日韩字面填满的高度超过它自己承认的 Ascent。对着渲染器量过:用那两个值,
 * 三十六个文本块里有十一个把框画进了墨迹内部,最多差七个点。
 * 包围盒才是轮廓真正装得进去的地方,而这正是被问的那个问题。
 *
 * 它在另一个方向上偏宽,而这里就该往那个方向错:比字母略高一点的选区就是一个行框,
 * 而一个人要给一行字画方框,画出来的本来也是那个。
 */
function heights(desc) {
  const bbox = arr(desc?.lookup(PDFName.of('FontBBox')))?.map(num);
  if (bbox && bbox.length === 4 && bbox[3] > bbox[1]) {
    return capped(bbox[3] / 1000, bbox[1] / 1000);
  }
  const a = num(desc?.lookup(PDFName.of('Ascent')));
  const d = num(desc?.lookup(PDFName.of('Descent')));
  if (a !== undefined && d !== undefined && a !== 0) return { ascent: a / 1000, descent: d / 1000 };
  return { ascent: DEFAULT_FONT.ascent, descent: DEFAULT_FONT.descent };
}

/**
 * What a simple font's one-byte codes mean when the file never says.
 *
 * A composite font has to carry a ToUnicode map to be readable at all, and the tools that make
 * them do. A simple font often carries none, because it does not need one: its codes are an
 * encoding every reader already knows, and 65 has meant A since before PDF existed. Word exports
 * exactly this way -- a whole page of Latin text with not one ToUnicode stream in it.
 *
 * WinAnsi is Windows code page 1252; MacRoman is what the Apple tools emit; Standard differs from
 * WinAnsi only in places no modern document reaches. All three agree on ASCII, which is where
 * almost every code in a file like that lands.
 *
 * 一个简单字体的单字节码位,在文件从不说明时,表示什么。
 *
 * 复合字体不带 ToUnicode 就根本读不出来,而造它们的工具都带。简单字体则常常一张也不带,
 * 因为它不需要:它的码位是每个阅读器早就认识的编码,而 65 表示 A 这件事比 PDF 本身还早。
 * Word 导出正是这样 —— 整整一页拉丁文字,里面一条 ToUnicode 流都没有。
 *
 * WinAnsi 就是 Windows 代码页 1252;MacRoman 是苹果那套工具产出的;
 * Standard 与 WinAnsi 的分歧只发生在当今文档到不了的地方。三者在 ASCII 上一致,
 * 而这种文件里几乎每一个码位都落在 ASCII。
 */
const CP1252_HIGH = '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž�'
  + '�‘’“”•–—˜™š›œ�žŸ';

const MACROMAN_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

function highTable(str) {
  const out = new Map();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '�') out.set(0x80 + i, ch);
  }
  return out;
}

const ENCODINGS = {
  WinAnsiEncoding: highTable(CP1252_HIGH),
  MacRomanEncoding: highTable(MACROMAN_HIGH),
};

/** The glyph names a /Differences array is likely to use. Names outside this are read as uniXXXX
 *  when they say so and given up on when they do not -- a private name like g43 stands for a
 *  glyph in one particular font program and means nothing on its own.
 *  一个 /Differences 数组可能用到的字形名。此外的名字:写成 uniXXXX 的照读,
 *  没写的就放弃 —— 像 g43 这样的私有名字只在某一个特定字体程序里指某个字形,单独拿出来没有意义。 */
const GLYPH_NAMES = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: '+',
  comma: ',', hyphen: '-', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<',
  equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\',
  bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”',
  quotesinglbase: '‚', quotedblbase: '„', endash: '–', emdash: '—',
  bullet: '•', ellipsis: '…', fi: 'ﬁ', fl: 'ﬂ', dagger: '†',
  daggerdbl: '‡', perthousand: '‰', trademark: '™', Euro: '€',
  nbspace: ' ', currency: '¤', degree: '°',
};

function glyphChar(name) {
  if (GLYPH_NAMES[name]) return GLYPH_NAMES[name];
  if (name.length === 1) return name;
  let m = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  return undefined;
}

/** One simple font's code -> character table, from its base encoding and its Differences.
 *  一个简单字体的"码位 -> 字符"表,由它的基础编码和它的 Differences 得出。 */
function simpleEncoding(ctx, encEntry) {
  let baseName = 'StandardEncoding';
  let diffs = null;
  const e = ctx.lookup(encEntry);       // a lookup of something that is not a reference is that thing
  if (e?.lookup) {
    baseName = String(e.lookup(PDFName.of('BaseEncoding')) || '').replace(/^\//, '') || baseName;
    diffs = arr(e.lookup(PDFName.of('Differences')));
  } else if (e) {
    baseName = String(e).replace(/^\//, '');
  }
  const high = ENCODINGS[baseName] || ENCODINGS.WinAnsiEncoding;
  const table = new Map(high);
  if (diffs) {
    let code = 0;
    for (const item of diffs) {
      const n = num(item);
      if (n !== undefined) { code = n; continue; }
      const ch = glyphChar(String(item).replace(/^\//, ''));
      if (ch !== undefined) table.set(code, ch);
      code++;
    }
  }
  return (code) => {
    const hit = table.get(code);
    if (hit !== undefined) return hit;
    // ASCII is ASCII in every encoding a PDF may name.
    // 在 PDF 能叫得出名字的每一种编码里,ASCII 都是 ASCII。
    if (code >= 0x20 && code < 0x7f) return String.fromCharCode(code);
    if (code >= 0xa0 && code <= 0xff) return String.fromCharCode(code);   // Latin-1 upper half
    return undefined;
  };
}

/**
 * How tall a Type3 font's glyphs are, which its own dictionary says and its descriptor does not.
 *
 * A Type3 font is not a font program at all -- each glyph is a little content stream, and the
 * font carries its own coordinate system to draw them in. So the bounding box sits on the font
 * dictionary rather than on a descriptor, and it is in that private coordinate system, which the
 * FontMatrix maps into text space. The matrix is often a y-flip, and then the box's stated top is
 * its bottom.
 *
 * These fonts are not a curiosity. Chrome's print-to-PDF turns every CJK glyph it cannot embed
 * into one, so a page printed from a Chinese web page can be sixty Type3 fonts and nothing else.
 * Read as if they were ordinary fonts, all sixty fall back to a guess shaped like Latin type, and
 * every selection box on the page is short at the top by the amount a Latin ascender falls short
 * of a full-width character.
 *
 * 一个 Type3 字体的字形有多高 —— 这件事它自己的字典说了,而它的描述符没说。
 *
 * Type3 字体根本不是一个字体程序:每个字形都是一小段内容流,而字体自带一套用来画它们的坐标系。
 * 于是包围盒长在字体字典上而不是描述符上,而且是在那套私有坐标系里,由 FontMatrix 映射进文本空间。
 * 那个矩阵常常是一次 y 翻转,于是盒子写着的"上"其实是它的下。
 *
 * 这类字体不是什么稀奇玩意。Chrome 的打印成 PDF 会把每一个它嵌不进去的中日韩字形变成一个,
 * 所以一张从中文网页打印出来的页面可以是六十个 Type3 字体、别无他物。
 * 若按普通字体去读,这六十个会齐齐退回一个照拉丁字形状来的猜测,
 * 而这一页上每一个选择框的顶部,都会短掉"拉丁字母上伸部比一个全角字矮的那一截"。
 */
/**
 * A bounding box is the box every glyph in the font fits in, which is not the box the glyphs on
 * this page fit in. A large CJK family reaches nearly three em from top to bottom to make room
 * for arrows, boxed numerals and combining marks -- none of which appear in a line of prose, and
 * a selection three times the height of its own letters swallows the lines above and below it.
 *
 * So the box is taken but not followed off the edge. The limits are set past every real face
 * measured here -- Arial reaches 1.04, Microsoft YaHei 1.06, Deng Xian 0.80 -- and well short of
 * what a font claims when it is describing its rarities.
 *
 * 一个包围盒是这个字体里每一个字形都装得下的框,而不是这一页上的这些字形装得下的框。
 * 一款大的中日韩字体从上到下能有将近三个 em,那是为箭头、带框数字和组合符号留的地方 ——
 * 这些都不会出现在一行散文里,而一个有自身字母三倍高的选区,会把上下两行一并吞掉。
 *
 * 所以框照取,但不跟着它冲出边界。这两个上限设在此处量过的每一张真实字面之外 ——
 * Arial 到 1.04,微软雅黑 1.06,等线 0.80 —— 又远不到一个字体在描述它那些稀罕货时所声称的地方。
 */
const capped = (ascent, descent) => ({
  ascent: Math.min(ascent, 1.25),
  descent: Math.max(descent, -0.5),
});

function type3Heights(dict, fm) {
  const bbox = arr(dict.lookup(PDFName.of('FontBBox')))?.map(num);
  if (!bbox || bbox.length !== 4 || !fm || fm.length < 6) return heights(null);
  if (bbox[0] === 0 && bbox[1] === 0 && bbox[2] === 0 && bbox[3] === 0) return heights(null);
  const ys = [];
  for (const [x, y] of [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]) {
    ys.push(fm[1] * x + fm[3] * y + fm[5]);
  }
  return capped(Math.max(...ys), Math.min(...ys));
}

/**
 * Everything about one font that measuring and editing need.
 *
 * 量文本和改文本所需要的、关于一个字体的全部。
 */
function readFont(ctx, dict) {
  if (!dict) return DEFAULT_FONT;
  const subtype = String(dict.lookup(PDFName.of('Subtype')));
  const baseFont = String(dict.lookup(PDFName.of('BaseFont')) || '').replace(/^\//, '');
  const toUnicode = readToUnicode(ctx, dict.lookup(PDFName.of('ToUnicode')));

  if (subtype.includes('Type0')) {
    const desc0 = arr(dict.lookup(PDFName.of('DescendantFonts')))?.[0];
    const df = desc0 ? ctx.lookup(desc0) : null;
    const desc = df?.lookup(PDFName.of('FontDescriptor'));
    const enc = String(dict.lookup(PDFName.of('Encoding')) || '');
    const width = cidWidths(arr(df?.lookup(PDFName.of('W'))), num(df?.lookup(PDFName.of('DW'))) ?? 1000);
    return {
      // Every CMap this editor is likely to meet is two bytes wide; the one-byte CMaps exist but
      // belong to encodings no current tool emits.
      // 本编辑器可能遇到的每一种 CMap 都是双字节;单字节的 CMap 存在,
      // 但属于当今没有工具还在产出的那些编码。
      bytes: 2, ...heights(desc), width, toUnicode, baseFont, subtype, dict, descendant: df,
      identity: enc.includes('Identity'),
      // A composite font's codes mean whatever its own CMap decided, so without a ToUnicode map
      // there is nothing to read them with. This is why a CJK page from a careless tool can be
      // moved around but not retyped.
      // 复合字体的码位表示什么,由它自己的 CMap 当初决定;没有 ToUnicode 表就无从读起。
      // 这就是为什么一份出自粗心工具的中文页面可以被搬动,却没法重打。
      toChar: (code) => toUnicode?.of(code),
    };
  }

  const first = num(dict.lookup(PDFName.of('FirstChar'))) ?? 0;
  const widths = arr(dict.lookup(PDFName.of('Widths')))?.map(num);
  const desc = dict.lookup(PDFName.of('FontDescriptor'));
  const missing = num(desc?.lookup(PDFName.of('MissingWidth'))) ?? 0;
  // A Type3 font measures in its own glyph space, which its FontMatrix maps into text space.
  // Type3 字体在它自己的字形空间里量,由它的 FontMatrix 映射进文本空间。
  const fm = arr(dict.lookup(PDFName.of('FontMatrix')))?.map(num);
  const isType3 = subtype.includes('Type3');
  const scale = isType3 && fm ? fm[0] * 1000 : 1;
  const encoded = simpleEncoding(ctx, dict.lookup(PDFName.of('Encoding')));
  return {
    bytes: 1, ...(isType3 ? type3Heights(dict, fm) : heights(desc)),
    toUnicode, baseFont, subtype, dict, encoded, fontMatrix: fm,
    // The map when there is one, the encoding when there is not. A file that carries both and
    // disagrees with itself is trusting the map, which is the one it wrote on purpose.
    // 有表就用表,没表就用编码。一份两样都带、而且自相矛盾的文件,信它的表 ——
    // 那是它特意写下来的那个。
    toChar: (code) => toUnicode?.of(code) ?? encoded(code),
    width: (code) => {
      const w = widths?.[code - first];
      // No Widths array at all means one of the fourteen fonts every reader is required to have,
      // whose metrics live in the reader rather than the file. Half an em is the average of them
      // and wrong for each -- accepted, because a box for a standard font is the one case where
      // being a little off costs nothing that can be seen.
      // 完全没有 Widths 数组,说明它是每个阅读器都必须自带的那十四款字体之一,
      // 它们的度量在阅读器里而不在文件里。半个 em 是这些字体的平均值,对每一款都不准 ——
      // 接受这一点,因为标准字体的框恰恰是"差一点也看不出代价"的那个情形。
      if (w === undefined || w === null) return widths ? missing : 500;
      return w * scale;
    },
  };
}

/**
 * The ToUnicode CMap: which characters a font's glyph codes were standing in for.
 *
 * Parsed by pattern rather than by running the PostScript it technically is, because the shape
 * these maps come in is fixed -- every producer writes the same two kinds of section -- and a
 * PostScript interpreter to read a lookup table would be a large amount of machinery for a use
 * nobody has.
 *
 * ToUnicode CMap:一个字体的字形码当初代表的是哪些字符。
 *
 * 按模式解析,而不是去运行它严格来说所属的那种 PostScript,因为这些表的形状是固定的 ——
 * 每一个生产者都只写那两类段落 —— 而为了读一张查找表去写一个 PostScript 解释器,
 * 是为一个没人有的用途搭一大堆机器。
 */
export function readToUnicode(ctx, stream) {
  const st = ctx.lookup(stream);        // likewise
  if (!st) return null;
  let text;
  try {
    text = bytesToStr(st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : st.getContents());
  } catch { return null; }

  const map = new Map();
  const hex = (h) => {
    // A destination is UTF-16BE, and may be several code units for one glyph -- a ligature.
    // 目标值是 UTF-16BE,而且可以是一个字形对应好几个码元 —— 那是连字。
    let s = '';
    for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  const CHAR = /beginbfchar([\s\S]*?)endbfchar/g;
  const RANGE = /beginbfrange([\s\S]*?)endbfrange/g;
  const PAIR = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
  for (const m of text.matchAll(CHAR)) {
    for (const p of m[1].matchAll(PAIR)) map.set(parseInt(p[1], 16), hex(p[2]));
  }
  for (const m of text.matchAll(RANGE)) {
    const body = m[1];
    const TRIPLE = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([\s\S<>0-9a-fA-F]*?)\])/g;
    for (const r of body.matchAll(TRIPLE)) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      if (r[3] !== undefined) {
        // One destination for the range, incrementing with the code.
        // 整段共用一个目标值,随码递增。
        const base = hex(r[3]);
        const tail = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi && c - lo < 0x10000; c++) {
          map.set(c, base.slice(0, -1) + String.fromCharCode(tail + (c - lo)));
        }
      } else {
        const list = [...(r[4] || '').matchAll(/<([0-9a-fA-F]*)>/g)];
        list.forEach((x, k) => map.set(lo + k, hex(x[1])));
      }
    }
  }
  if (!map.size) return null;
  const reverse = new Map();
  for (const [code, ch] of map) if (!reverse.has(ch)) reverse.set(ch, code);
  return { of: (code) => map.get(code), codeFor: (ch) => reverse.get(ch), size: map.size };
}

/** The fonts a page can set, by the name the stream calls them.
 *  一页可以设定的字体,按内容流里叫它们的那个名字索引。 */
export function fontsOf(page) {
  const ctx = page.node.context;
  const cache = new Map();
  const dicts = page.node.Resources()?.lookup?.(PDFName.of('Font'));
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const key = name.replace(/^\//, '');
    let got = DEFAULT_FONT;
    try {
      const d = dicts?.lookup?.(PDFName.of(key));
      if (d) got = readFont(ctx, d);
    } catch { /* a font we cannot read is a font we measure with the default */ }
    cache.set(name, got);
    return got;
  };
}

/**
 * The graphics states a page can switch to, reduced to what visibility depends on.
 *
 * Only the alpha values and the line width, because those are the parts of a graphics state that
 * change whether something can be seen or how far it reaches. The rest -- blend modes, halftones,
 * transfer functions -- changes how it looks, and this is not a renderer.
 *
 * 一页可以切换到的那些图形状态,缩减成"可见性所依赖的部分"。
 *
 * 只取两个透明度和线宽,因为图形状态里只有这几项会改变"东西看不看得见"或"它伸出多远"。
 * 其余的 —— 混合模式、半调、传递函数 —— 改变的是它长什么样,而这里不是一个渲染器。
 */
export function gsOf(page) {
  const map = {};
  const dicts = page.node.Resources()?.lookup?.(PDFName.of('ExtGState'));
  if (dicts?.entries) {
    for (const [k, ref] of dicts.entries()) {
      const d = page.node.context.lookup(ref);
      if (!d?.lookup) continue;
      map['/' + k.asString().replace(/^\//, '')] = {
        ca: num(d.lookup(PDFName.of('ca'))),
        CA: num(d.lookup(PDFName.of('CA'))),
        lineWidth: num(d.lookup(PDFName.of('LW'))),
      };
    }
  }
  return (name) => map[name] || null;
}

/** All three lookups at once, in the shape pageObjects wants.
 *  三个查询一起给,形状照 pageObjects 的要求。 */
export const resourcesOf = (page) => ({ xobj: xobjOf(page), font: fontsOf(page), gs: gsOf(page) });

/**
 * The font program a document carries inside itself, if it carries one.
 *
 * This is the only copy of the document's actual typeface that exists anywhere for certain, and
 * it is usually a subset -- the characters this document happened to use and no others. It is
 * wanted for two opposite reasons: to ask whether it can already write something, and, when it
 * cannot, to hold a candidate face up against it and see whether the outlines match. A name is
 * not evidence; two files can agree on a name and disagree on every curve.
 *
 * A font that is not embedded returns nothing, which is the honest answer -- the document is
 * relying on the reader's machine to supply that typeface, and what it supplies is not knowable
 * from the file.
 *
 * 文档随身带着的那个字体程序,如果它带了的话。
 *
 * 这是"文档真正那款字面"在任何地方唯一确定存在的一份副本,而且通常是一个子集 ——
 * 这份文档恰好用到的那些字符,别的一个也没有。想要它有两个相反的理由:
 * 问它是不是已经写得出某样东西;以及在它写不出的时候,把一个候选字面举到它旁边,
 * 看轮廓对不对得上。名字不算证据 —— 两个文件可以在名字上一致而在每一条曲线上都不一致。
 *
 * 没有嵌入的字体返回空,这是诚实的答案 —— 文档指望读者的机器来提供那款字面,
 * 而它会提供什么,从文件里是看不出来的。
 */
export function fontProgram(font) {
  const dict = font?.subtype?.includes('Type0') ? font.descendant : font?.dict;
  const desc = dict?.lookup?.(PDFName.of('FontDescriptor'));
  if (!desc?.lookup) return null;
  for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
    const st = desc.lookup(PDFName.of(key));
    if (!st) continue;
    try {
      return st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : st.getContents();
    } catch { return null; }
  }
  return null;
}

/** What a run of glyph codes says, as far as the file is willing to tell.
 *  一段字形码说的是什么 —— 以文件肯说的为限。 */
export function runText(run, font) {
  if (!font?.toChar) return null;
  let s = '';
  for (let k = 0; k + font.bytes <= run.codes.length; k += font.bytes) {
    const code = font.bytes === 2 ? run.codes[k] * 256 + run.codes[k + 1] : run.codes[k];
    const ch = font.toChar(code);
    // A gap makes the whole run untrustworthy: the characters around it would still read, but
    // handing back a string with something quietly missing from the middle is worse than saying
    // this run cannot be read.
    // 一个缺口让整段都不可信:周围的字仍然读得出来,但交回一个中间悄悄少了点什么的字符串,
    // 比说一句"这段读不出来"更糟。
    if (ch === undefined || ch === null) return null;
    s += ch;
  }
  return s;
}

/** Which codes to write to make a font say this text, or null if it cannot say all of it.
 *  This is the direction editing needs, and the direction a subset font is worst at: it carries
 *  the characters the document already used and no others.
 *  要让一个字体说出这段文字,该写哪些码位;说不全就返回 null。
 *  这是编辑所需要的方向,也是子集字体最不擅长的方向:
 *  它带着文档已经用过的那些字符,别的一个也没有。 */
export function codesFor(text, font) {
  if (!font) return null;
  const out = [];
  for (const ch of text) {
    let code;
    if (font.toUnicode?.codeFor) code = font.toUnicode.codeFor(ch);
    if (code === undefined && font.encoded) {
      // Search the encoding rather than invert it: a simple font has 256 codes at most, and a
      // table built for the rare case of typing into one would be built far more often than used.
      // 与其把编码反过来建表,不如直接搜:一个简单字体最多 256 个码位,
      // 而"往里打字"这种少见情形所需要的表,建起来的次数会远多于用到的次数。
      for (let c = 0; c < 256; c++) if (font.encoded(c) === ch) { code = c; break; }
    }
    if (code === undefined) return null;
    out.push(code);
  }
  return out;
}
