// Editing a PDF: what the reader asked for, expressed as a list of changes to bytes.
//
// The whole editor is one idea. A page is a tape of drawing instructions; pdfobj.js says which
// bytes on that tape draw which thing; so an edit is a note saying "these bytes become those
// bytes", and a document being edited is the original file plus a list of such notes. Nothing is
// ever modified in place. Deleting a picture is a note replacing its bytes with none; retyping a
// line is a note replacing its glyph codes with others; adding a text box is a note appending to
// the end of the tape.
//
// Three things follow from that, and they are the reason it is built this way:
//
//   Undo is dropping a note off the list. Not a stack of inverse operations, not a snapshot of
//   the file -- the list is the document, so shortening it is going back.
//
//   Nothing an edit does can invalidate another edit, because every note points into the
//   original tape, which never changes. Ten edits in any order mean the same thing.
//
//   What is not edited is byte-identical to what was there. A page is not re-laid-out, re-encoded
//   or regenerated from a model; the untouched instructions are the author's own bytes. This
//   matters more than it sounds: a PDF's appearance is the sum of a great many small decisions
//   its maker made, and an editor that rewrites the page to change one word has silently
//   overruled all of them.
//
// 编辑一份 PDF:把读者的要求,表达成一串对字节的改动。
//
// 整个编辑器只有一个想法。一页是一条绘制指令的带子;pdfobj.js 说得出带子上哪些字节画了哪样东西;
// 于是一次编辑就是一条便条,写着"这些字节变成那些字节",而一份正在被编辑的文档,
// 就是原始文件加上一叠这样的便条。任何东西都不会被就地修改。删掉一张图,是一条"把它的字节换成没有"
// 的便条;重打一行字,是一条"把它的字形码换成别的"的便条;加一个文本框,
// 是一条"往带子末尾续写"的便条。
//
// 由此得出三件事,而它们正是它被这样搭起来的原因:
//
//   撤销就是从这叠便条里抽掉一张。不是一摞逆操作,也不是一份文件快照 ——
//   这叠便条就是文档本身,所以把它变短就是往回走。
//
//   一次编辑做的任何事都不会让另一次编辑失效,因为每张便条指向的都是那条从不改变的原始带子。
//   十次编辑无论以什么顺序,含义都一样。
//
//   没被编辑的部分,与原来那里的东西逐字节相同。一页不会被重新排版、重新编码,
//   也不会从某个模型重新生成;没被碰过的指令就是作者自己的字节。这件事比听上去更要紧:
//   一份 PDF 的样子,是做它的人许许多多细小决定的总和,
//   而一个"为了改一个词就把整页重写一遍"的编辑器,已经悄悄推翻了那全部决定。

import { PDFDocument, PDFName, subsetFontkit } from '/vendor/pdfedit/pdfedit.entry.js';
import { applyEdits, pageObjects, parseOps } from './pdfobj.js';
import { codesFor, contentOf, fontProgram, resourcesOf, runText, setContent } from './pdfpage.js';
import { LAYERS, openFace, resolveFont } from './pdffont.js';

/** The face this editor ships, for when a document's own font cannot write what was typed and
 *  the face it was made with is nowhere to be found.
 *  本编辑器自带的那张脸,用于"文档自己的字体写不出刚打进去的字、而它原本那款字又无处可寻"时。 */
const BUNDLED = '/api/fonts/editor/noto-sans-sc';

let bundledBytes = null;

async function bundled() {
  if (!bundledBytes) {
    const res = await fetch(BUNDLED);
    if (!res.ok) throw new Error('no fallback font');
    bundledBytes = new Uint8Array(await res.arrayBuffer());
  }
  return bundledBytes;
}

/**
 * Where to look for a font, in the order that gives the best chance of the document's own.
 *
 * A named family is looked for by name in the reader's own library, if they opened it. Asked for
 * nothing -- which is how the search says it has given up on matching and wants something that
 * can simply write -- the shipped face answers, because at that point coverage is all that is
 * left to care about.
 *
 * 到哪里去找一款字,顺序按"最有机会找到文档原本那款"来排。
 *
 * 有名字的,就按名字去读者自己的字体库里找 —— 如果他们打开了它。什么都不问的时候 ——
 * 搜索用这种方式表示它已放弃匹配、只想要一个"写得出来"的东西 —— 由自带的那张脸来回答,
 * 因为到那一步,除了覆盖范围之外已经没有别的还重要了。
 */
export function fontSources(local) {
  return async (family) => {
    if (local) {
      try {
        const got = await local(family);
        if (got?.length) return got;
      } catch { /* a library that will not answer is a library we do without */ }
    }
    return family ? [] : [await bundled()];
  };
}

/** A resource name no document will have chosen for itself.
 *  一个不会被任何文档拿去当自己资源名的名字。 */
const fontKey = (n) => 'EdFont' + n;

const hexOf = (codes, bytes) => '<' + codes.map((c) => (bytes === 2
  ? c.toString(16).padStart(4, '0') : (c & 0xff).toString(16).padStart(2, '0'))).join('') + '>';

/** PDF numbers: short, and never in exponent form, which a content stream cannot read.
 *  PDF 里的数字:写短,而且绝不用指数形式 —— 内容流读不了那个。 */
const n6 = (x) => {
  const v = Math.round(x * 1e6) / 1e6;
  return Number.isFinite(v) ? String(v) : '0';
};

const NL = String.fromCharCode(10);

/**
 * One text object, written out.
 *
 * A new box is wrapped in q..Q and carries its own colour, because it is being added to the end
 * of the page and must not inherit or leave behind any state. A rewritten block is not wrapped:
 * it stands exactly where the old one stood, inside whatever colour and transform were already
 * in force there, which is how it keeps looking like the rest of the page.
 *
 * 一个文本对象,写出来的样子。
 *
 * 新框用 q..Q 包起来并自带颜色,因为它是被加在页面末尾的,不该继承任何状态,也不该留下任何状态。
 * 重写的块不包:它就站在旧的那个站过的地方,处在那里本来就已生效的颜色和变换之中 ——
 * 它正是靠这一点,才看上去仍和这一页的其余部分是一伙的。
 */
function textBlock(w, hex, rows, seq) {
  const lines = ['BT'];
  if (w.charSp) lines.push(`${n6(w.charSp)} Tc`);
  if (w.wordSp) lines.push(`${n6(w.wordSp)} Tw`);
  if (w.hscale && w.hscale !== 1) lines.push(`${n6(w.hscale * 100)} Tz`);
  if (w.rise) lines.push(`${n6(w.rise)} Ts`);
  if (w.color) lines.push(`${n6(w.color[0])} ${n6(w.color[1])} ${n6(w.color[2])} rg`);
  lines.push(`/${w.font} ${n6(w.size)} Tf`);
  if (seq) {
    // Stretches of one line, the pen advancing through them: the document's font by codes, the
    // stand-in only where a Tf has switched to it, and never a new matrix in between.
    // 同一行里的几段,笔从头写到尾:文档字体按码位写,替身只在 Tf 切过去的那几段出场,
    // 中间绝不另起矩阵。
    lines.push(`${w.tm.map(n6).join(' ')} Tm`);
    for (const p of seq) {
      lines.push(p.codes ? `/${w.font} ${n6(w.size)} Tf` : `/${w.subFont} ${n6(w.size)} Tf`);
      lines.push(`${p.codes ? hexOf(p.codes, w.bytes) : p.hex} Tj`);
    }
  } else if (rows) {
    // Several lines, each placed by its own matrix -- alignment is nothing but where each line
    // starts, decided when it was typed and carried here as an offset.
    // 好几行,每行由它自己的矩阵安放 —— 对齐无非是"每行从哪儿起笔",
    // 在打字时就已定下,带到这里只是一个偏移量。
    for (const r of rows) {
      lines.push(`${[w.tm[0], w.tm[1], w.tm[2], w.tm[3], w.tm[4] + r.dx, w.tm[5] + r.dy].map(n6).join(' ')} Tm`);
      lines.push(`${r.hex} Tj`);
    }
  } else {
    lines.push(`${w.tm.map(n6).join(' ')} Tm`);
    lines.push(`${hex} Tj`);
  }
  lines.push('ET');
  // A Tf outlives the text object that set it, so a block that had to switch fonts puts the
  // page's own font back for whatever comes after.
  // 一次 Tf 的效力比设定它的那个文本对象活得久,所以一个不得不换字体的块,
  // 会把页面自己的字体放回去,给随后而来的东西用。
  if (w.embedded && w.restore) lines.push(`${w.restore} ${n6(w.size)} Tf`);
  return w.block === 'new' ? ['q', ...lines, 'Q'].join(NL) : lines.join(NL);
}

/** What these codes add up to in width, in points, by the widths the file itself declares --
 *  the same numbers its own layout was computed from.
 *  这些码位加起来有多宽,单位是点,按文件自己声明的宽度 —— 它当初排版用的就是这些数。 */
function codesWidth(font, codes, size) {
  if (!font?.width || !font.measured) return null;
  let units = 0;
  for (const c of codes) units += font.width(c) || 0;
  return (units * size) / 1000;
}

/**
 * The width of text in a standard-14 font, measured by the browser.
 *
 * These fonts ship no widths -- their metrics live in the reader -- and the reader at hand IS a
 * browser, whose Arial, Times New Roman and Courier New are metrically compatible with
 * Helvetica, Times and Courier by design. So the canvas is asked, in the same pt-for-px scale,
 * and the answer is the one the page will actually be drawn with.
 *
 * 标准十四字体里一段文字的宽,由浏览器来量。
 *
 * 这些字体不带宽度 —— 它们的度量住在阅读器里 —— 而眼下这个阅读器就是浏览器,
 * 它的 Arial、Times New Roman 与 Courier New,与 Helvetica、Times、Courier 在度量上
 * 本就是按兼容设计的。所以去问 canvas,按点当像素的同一比例,得到的正是页面实际会被画出的那个答案。
 */
let stdCtx = null;
function stdWidth(baseFont, text, size) {
  const name = String(baseFont || '');
  const fam = /courier/i.test(name) ? '"Courier New", Courier, monospace'
    : /times/i.test(name) ? '"Times New Roman", Times, serif'
    : /helvetica|arial/i.test(name) ? 'Arial, Helvetica, sans-serif'
    : null;
  if (!fam) return null;
  try {
    stdCtx ||= document.createElement('canvas').getContext('2d');
    const b = /bold/i.test(name) ? 'bold ' : '';
    const i = /oblique|italic/i.test(name) ? 'italic ' : '';
    stdCtx.font = `${i}${b}${size}px ${fam}`;
    return stdCtx.measureText(String(text)).width;
  } catch {
    return null;
  }
}

/** How wide a line of text comes out in a face, in points. Advance widths are what the fonts
 *  themselves lay lines out by, so this is the same answer a renderer would reach.
 *  一行字在某张脸下写出来有多宽,单位是点。步进宽度正是字体自己排行的依据,
 *  所以这里得出的与渲染器会得出的是同一个答案。 */
function lineWidth(face, text, size) {
  if (!face?.font) return 0;
  let units = 0;
  for (const ch of text) {
    try {
      units += face.font.glyphForCodePoint(ch.codePointAt(0))?.advanceWidth || 0;
    } catch { /* a glyph it cannot measure adds nothing / 量不了的字形就不计宽 */ }
  }
  return (units * size) / (face.unitsPerEm || 1000);
}

/**
 * A document open for editing.
 *
 * Holds the original bytes and, per page, the list of changes made to it. It never holds a
 * half-modified document: building one happens on demand, from the original plus the list, so
 * there is no state that can drift out of step with what the reader has asked for.
 *
 * 一份打开待编辑的文档。
 *
 * 它持有原始字节,以及每一页上做过的那串改动。它从不持有一份改到一半的文档:
 * 要一份的时候现搭 —— 由原件加那串改动搭出来 —— 于是不存在任何"可能与读者所要求的脱节"的状态。
 */
export async function openPdf(bytes, { local = null } = {}) {
  const original = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const probe = await PDFDocument.load(original);
  const pageCount = probe.getPageCount();
  const sources = fontSources(local);

  const pages = new Map();          // index -> page state
  const fonts = new Map();          // key -> {key, bytes, face, family, layer}
  // A document edited before carries this editor's names in its resources already, and a name
  // reused is a resource overwritten: last session's EdFont1 replaced by this session's turns
  // every code written against the old one into a different glyph. Count past what is there.
  // 编辑过的文档,资源里已经带着这个编辑器起的名字;名字一旦复用就是资源被顶替 ——
  // 上一场的 EdFont1 被这一场的顶掉,当初按旧的写下的每个码位都变成另一个字形。
  // 所以计数从已有的名字之后起。
  let fontCount = 0;
  let imgCount = 0;
  for (let i = 0; i < pageCount; i++) {
    const node = probe.getPage(i).node;
    const scan = (dictName, re, bump) => {
      try {
        const dict = node.Resources()?.lookup(PDFName.of(dictName));
        if (!dict?.keys) return;
        for (const key of dict.keys()) {
          const m = re.exec(String(key).replace(/^\//, ''));
          if (m) bump(parseInt(m[1], 10));
        }
      } catch { /* a page whose resources cannot be read adds no names / 资源读不了的页,也贡献不了名字 */ }
    };
    scan('Font', /^EdFont(\d+)$/, (n) => { fontCount = Math.max(fontCount, n); });
    scan('XObject', /^EdImg(\d+)$/, (n) => { imgCount = Math.max(imgCount, n); });
  }

  /** Read one page into the model. Done once per page; the objects it returns are stable, because
   *  edits never move the original bytes they point at.
   *  把一页读进模型。每页只做一次;它交回的对象是稳定的,
   *  因为编辑从不挪动它们所指向的那些原始字节。 */
  async function page(index) {
    if (pages.has(index)) return pages.get(index);
    const pg = probe.getPage(index);
    const src = contentOf(pg);
    const res = resourcesOf(pg);
    const objects = pageObjects(parseOps(src), res);
    const mb = pg.getMediaBox();
    const st = {
      index, src, res, objects, edits: [],
      box: [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height],
      width: mb.width, height: mb.height,
      rotate: pg.getRotation().angle,
    };
    pages.set(index, st);
    return st;
  }

  /** What a text object says, as far as the file is willing to tell.
   *  一个文本对象说的是什么 —— 以文件肯说的为限。 */
  function textOf(st, obj) {
    if (obj.kind !== 'text') return null;
    const parts = obj.runs.map((r) => runText(r, st.res.font(r.font)));
    return parts.some((p) => p === null) ? null : parts.join('');
  }

  /**
   * Find a font that can write this text, walking the four places one might come from.
   *
   * The document's own, first: if the text only uses characters the page already has, nothing is
   * embedded and nothing changes about how the page looks. Then the same face from the reader's
   * font library, verified by comparing outlines rather than trusted by name. Then the face we
   * ship. The result says which of those it was, because the reader deserves to know whether they
   * are still writing in the document's typeface or in a stand-in.
   *
   * 找一款写得出这段文字的字体,把可能的四个来处走一遍。
   *
   * 先看文档自己的:如果这段文字只用到页面已经有的字符,那就什么都不必嵌入,
   * 页面看上去也毫无变化。其次是读者字体库里的同一张脸 —— 靠比对轮廓来验证,而不是凭名字去信。
   * 再次是我们自带的那张。结果会说明它是这四者中的哪一个,
   * 因为读者有权知道自己此刻是仍在用文档的字面写,还是在用一个替身。
   */
  async function resolve(text, { baseFont = '', pdfFace = null } = {}) {
    const got = await resolveFont(text, pdfFace, baseFont, sources);
    if (!got.face) return got;
    let entry = null;
    for (const f of fonts.values()) if (f.face.bytes === got.face.bytes) entry = f;
    if (!entry) {
      entry = { key: fontKey(++fontCount), bytes: got.face.bytes, face: got.face, texts: [], layer: got.layer };
      fonts.set(entry.key, entry);
    }
    return { ...got, font: entry };
  }

  /** Remove one object: its bytes become none.
   *  删掉一个对象:它的字节变成没有。 */
  function remove(st, obj) {
    st.edits.push({ from: obj.from, to: obj.to, text: '', what: 'remove', obj });
    return st.edits[st.edits.length - 1];
  }

  /**
   * Rewrite a block of text.
   *
   * The unit is the text object -- everything between BT and ET -- and not the show operator
   * inside it, because a show operator is not a unit of anything a reader recognises. In a page
   * from Word one of them holds a whole line; in a page from a design tool each one holds a
   * single character, positioned absolutely by a Td of its own. Replacing a show operator in the
   * second kind puts five characters where the file had planned for one, and the Td that follows
   * drops the next character straight back on top of them. The text object is the line in both
   * kinds, so it is the unit here.
   *
   * The block is written out afresh at the exact place its first glyph stood, in the same font
   * and size and text state. What is lost is the per-glyph positioning the original carried --
   * the tracking, the justification, the nudge on a particular pair. That loss is not a
   * shortcoming of this approach but of the request: those positions were computed for the old
   * words, and there is no honest way to carry them onto different ones.
   *
   * 重写一块文字。
   *
   * 单位是文本对象 —— BT 到 ET 之间的全部 —— 而不是它里面的某个显示操作,
   * 因为显示操作不是任何读者认得的东西的单位。一页来自 Word 的文档里,一个显示操作装着一整行;
   * 一页来自设计工具的文档里,每一个只装一个字,由它自己的 Td 绝对定位。
   * 在第二种里替换一个显示操作,等于把五个字塞进文件只为一个字留的位置,
   * 而紧随其后的那个 Td 会把下一个字原样丢回来,正压在它们身上。
   * 文本对象在两种文件里都是"一行",所以这里以它为单位。
   *
   * 这块文字会被重新写出来,就放在它第一个字形原本站的地方,用同一款字、同样的大小和文本状态。
   * 失去的是原件携带的逐字定位 —— 字距、两端对齐、某一对字之间的那点微调。
   * 那个损失不是这个做法的缺陷,而是这个要求本身的:那些位置是为旧的那些字算出来的,
   * 没有任何诚实的办法把它们搬到不一样的字上去。
   */
  async function retype(st, obj, text, align = 'left') {
    const first = obj.runs?.find((r) => r.codes.length) || obj.runs?.[0];
    if (!first) return null;
    // One block, one note. An earlier retype of this block is folded into this one -- and its
    // box put back first, so every alignment is anchored to the geometry the author drew, not
    // to whatever the last edit left. A move note folds in the same way: the rewritten text
    // carries the new place in its matrix, since the runs moved with the drag.
    // 一个块,一张便条。这个块早先的重打并进这一次 —— 先把它的框放回去,
    // 好让每一次对齐都锚在作者画下的几何上,而不是上一次编辑留下的什么上。
    // 挪动的便条同样并入:重写的文字在自己的矩阵里带着新位置,因为 runs 已随拖动挪过。
    for (let i = st.edits.length - 1; i >= 0; i--) {
      const e = st.edits[i];
      if ((e.what === 'move' || e.what === 'retype') && e.obj === obj) {
        if (e.boxWas) obj.box = e.boxWas;
        st.edits.splice(i, 1);
      }
    }
    const font = st.res.font(first.font);
    const own = codesFor(text, font);
    const write = {
      size: first.size, tm: first.tm, text,
      charSp: first.charSp, wordSp: first.wordSp, hscale: first.hscale, rise: first.rise,
      restore: first.font, block: 'inline',
    };
    // Where the new text starts is the alignment's to say, anchored to the box the old text
    // occupied: left keeps the pen where the author put it, right keeps the right edge still,
    // centre keeps the centre. Longer text then grows the way the anchor implies -- a
    // right-aligned figure grows leftward -- which is the whole point of asking.
    // 新文字从哪儿起笔,由对齐说了算,锚在旧文字占过的那个框上:居左,笔就留在作者放下的地方;
    // 居右,右缘纹丝不动;居中,中心不动。于是更长的文字朝锚所指的方向生长 ——
    // 一个右对齐的数字向左长 —— 这正是问这一句的全部意义。
    const k = align === 'center' ? 0.5 : align === 'right' ? 1 : 0;
    const hs = first.hscale || 1;
    const pad = (first.charSp || 0) * Math.max(0, [...text].length - 1)
      + (first.wordSp || 0) * (text.match(/ /g) || []).length;
    // The old text's width, by the same ruler the new text will be measured with -- advance
    // widths, run by run. Anchoring bbox against advance would miss by their disagreement.
    // 旧文字的宽,用与新文字同一把尺来量 —— 逐段累加的步进宽度。
    // 拿字形框去锚步进宽,会正好差出它们不一致的那一截。
    let oldAdv = k ? 0 : null;
    for (const r of (k && obj.runs) || []) {
      const f = st.res.font(r.font);
      let w = null;
      if (f?.width && f.measured) {
        let u = 0;
        for (let i = 0; i + f.bytes <= r.codes.length; i += f.bytes) {
          u += f.width(f.bytes === 2 ? r.codes[i] * 256 + r.codes[i + 1] : r.codes[i]) || 0;
        }
        w = (u * r.size) / 1000;
      } else {
        // No widths in the file: a standard-14 run, measured by the browser it will be drawn by.
        // 文件里没有宽度:这是标准十四字体的一段,交给将要画它的浏览器来量。
        const s = runText(r, f);
        if (s != null) w = stdWidth(f?.baseFont, s, r.size);
      }
      if (w == null) { oldAdv = null; break; }
      oldAdv += w * (r.hscale || 1);
    }
    const placed = (newW) => {
      const m = first.tm;
      if (!k || newW == null || oldAdv == null) return { tm: m, w: newW };
      const w = newW * hs + pad;
      const dx = (oldAdv - w) * k;
      return { tm: [m[0], m[1], m[2], m[3], m[4] + dx, m[5]], w, dx };
    };
    const settle = (edit, p) => {
      edit.boxWas = obj.box && [...obj.box];
      if (obj.box && p.dx !== undefined) {
        obj.box = [obj.box[0] + p.dx, obj.box[1], obj.box[0] + p.dx + p.w, obj.box[3]];
      }
      st.edits.push(edit);
      return edit;
    };
    if (own) {
      // The document's own font can say it: nothing is embedded, nothing about the page's
      // appearance changes except which letters are there.
      // 文档自己的字体说得出来:什么都不必嵌入,页面的样子除了"是哪几个字"之外毫无变化。
      const p = placed(codesWidth(font, own, first.size) ?? stdWidth(font.baseFont, text, first.size));
      return settle({ from: obj.from, to: obj.to, what: 'retype', obj, layer: LAYERS.OWN, align,
        write: { ...write, tm: p.tm, font: first.font, codes: own, bytes: font.bytes } }, p);
    }
    // It cannot say all of it -- but almost always it can say most of it, and every character it
    // can say should keep the document's own face. So the text is split into stretches: the
    // subset writes what it knows, and only the characters the author never used go to a
    // stand-in. A digit added to a price changes one glyph, not the look of the line.
    // 它说不全 —— 但几乎总能说出大半,而它说得出的每一个字,都该保持文档自己的字面。
    // 于是文字被切成几段:子集写它认得的,只有作者从未用过的那几个字符才交给替身。
    // 价格里添的一个数字,换的是一个字形,不是一整行的模样。
    const parts = [];
    let short = '';
    for (const ch of text) {
      const c = codesFor(ch, font);
      const last = parts[parts.length - 1];
      if (c) {
        if (last?.codes) { last.codes.push(...c); last.text += ch; }
        else parts.push({ codes: [...c], text: ch });
      } else {
        short += ch;
        if (last && !last.codes) last.text += ch;
        else parts.push({ text: ch });
      }
    }
    const mixed = parts.some((p) => p.codes);
    // The search runs for what is missing -- all of it when nothing could be said. The embedded
    // program is handed over not because it will be used -- it demonstrably cannot write this --
    // but so a candidate found elsewhere can be held against it and checked to be the same face.
    // 搜索只为缺的那部分而跑 —— 一个都说不出时,就是全部。把嵌入的那个程序交出去,
    // 不是因为它会被用上 —— 它明摆着写不出这个 —— 而是好让别处找到的候选者能举到它旁边,
    // 验一验是不是同一张脸。
    const program = fontProgram(font);
    const face = program ? openFace(program) : null;
    const got = await resolve(mixed ? short : text, { baseFont: font.baseFont, pdfFace: face });
    if (!got.font) return null;
    got.font.texts.push(mixed ? short : text);
    if (mixed) {
      let newW = 0;
      for (const p of parts) {
        const w = p.codes
          ? codesWidth(font, p.codes, first.size) ?? stdWidth(font.baseFont, p.text, first.size)
          : lineWidth(got.font.face, p.text, first.size);
        if (w == null) { newW = null; break; }
        newW += w;
      }
      const p = placed(newW);
      return settle({ from: obj.from, to: obj.to, what: 'retype', obj, layer: got.layer, align,
        write: { ...write, tm: p.tm, font: first.font, bytes: font.bytes, parts, subFont: got.font.key, embedded: true } }, p);
    }
    const p = placed(lineWidth(got.font.face, text, first.size));
    return settle({ from: obj.from, to: obj.to, what: 'retype', obj, layer: got.layer, align,
      write: { ...write, tm: p.tm, font: got.font.key, embedded: true } }, p);
  }

  /**
   * Put new text on the page, at a point in its own coordinates.
   *
   * Appended to the end of the tape, which is to say drawn last and therefore on top. It is its
   * own text object, so it carries no state into or out of the page's existing ones.
   *
   * 在页面上按它自己的坐标放一段新文字。
   *
   * 续在带子末尾,也就是最后画、因而画在最上面。它是它自己的一个文本对象,
   * 所以既不把状态带进页面已有的那些对象,也不从它们那里带出来。
   */
  async function addText(st, { text, x, y, size = 12, color = [0, 0, 0], family = '', align = 'left' }) {
    const got = await resolve(text, { baseFont: family });
    if (!got.font) return null;
    got.font.texts.push(text);
    // Several lines make a block, and alignment is decided here, where the widths are known:
    // each line is placed against the widest one, and what build() receives is offsets.
    // 几行合成一块,对齐就在这里决定 —— 这里知道每行的宽:
    // 每一行都对着最宽的那行安放,build() 拿到的只是偏移量。
    // The click is the anchor, and alignment says which part of the block hangs from it: its
    // left edge, its centre, or its right edge. Lines shorter than the widest follow suit.
    // 点击处是锚,对齐说的是块的哪一部分挂在锚上:左缘、中心,还是右缘。
    // 比最宽行短的行,也照此办理。
    const lineH = size * 1.2;
    const rows = String(text).replace(/\s+$/, '').split('\n');
    const widths = rows.map((ln) => lineWidth(got.font.face, ln, size));
    const wide = Math.max(...widths, 0);
    const k = align === 'center' ? 0.5 : align === 'right' ? 1 : 0;
    const lines = rows.map((ln, i) => ({ text: ln, dx: -widths[i] * k, dy: -lineH * i }));
    const edit = {
      from: st.src.length, to: st.src.length, what: 'add', kind: 'text', layer: got.layer, align,
      box: [x - wide * k, y - lineH * (rows.length - 1) - size * 0.25,
        x - wide * k + Math.max(wide, size), y + size],
      write: { font: got.font.key, size, text, lines, color, tm: [1, 0, 0, 1, x, y], block: 'new' },
    };
    st.edits.push(edit);
    return edit;
  }

  /**
   * Put a picture on the page. The program itself is embedded once per key at build time; what
   * the tape gains is four numbers and a name -- where, how large, and which picture.
   *
   * 在页面上放一张图。图的数据在搭建时按名字嵌入一次;
   * 带子上多出来的只有四个数字和一个名字 —— 在哪儿、多大、哪张图。
   */
  function addImage(st, { bytes, mime, x, y, w, h }) {
    const edit = {
      from: st.src.length, to: st.src.length, what: 'add', kind: 'image',
      box: [x, y, x + w, y + h],
      img: { key: 'EdImg' + (++imgCount), bytes, mime, x, y, w, h },
    };
    st.edits.push(edit);
    return edit;
  }

  /**
   * Slide an object somewhere else, original bytes untouched.
   *
   * The object's own instructions are left exactly as the author wrote them and wrapped in a
   * translation -- q cm .. Q -- appended at the end of the tape. Nothing inside is re-laid-out,
   * so the per-glyph spacing, the image sampling, whatever the block carried, all survive the
   * trip. What is lost is paint order: the moved thing now draws last, and so on top.
   *
   * 把一个对象挪到别处,原始字节一个不动。
   *
   * 对象自己的指令原样保留,包在一次平移里 —— q cm .. Q —— 续到带子末尾。
   * 内部什么都不重排,于是逐字的间距、图像的采样,这个块携带的一切都原样活着到达。
   * 失去的是绘制顺序:被挪的东西如今最后画,也就画在最上面。
   */
  function move(st, obj, dx, dy) {
    // A retyped block owns its position through its matrix; a second move just adds up.
    // 被重打过的块,位置由它自己的矩阵持有;再挪一次,不过是往上加。
    const rp = st.edits.find((e) => e.what === 'retype' && e.obj === obj);
    const prior = rp || st.edits.find((e) => e.what === 'move' && e.obj === obj);
    let edit;
    if (rp) {
      const m = rp.write.tm;
      rp.write.tm = [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy];
      edit = rp;
    } else if (prior) {
      prior.dx += dx;
      prior.dy += dy;
      edit = prior;
    } else {
      edit = { from: obj.from, to: obj.to, what: 'move', obj, dx, dy };
      st.edits.push(edit);
    }
    // The boxes follow, so the next grab -- and the next double-click -- find the thing where
    // it now is.
    // 框跟着走,于是下一次抓取 —— 以及下一次双击 —— 找到的是它现在所在的地方。
    shift(obj, dx, dy);
    edit.moved = [(edit.moved?.[0] || 0) + dx, (edit.moved?.[1] || 0) + dy];
    return edit;
  }

  /** Move an object's cached geometry, boxes and text matrices alike.
   *  平移一个对象缓存下来的几何 —— 包围框和文本矩阵一并。 */
  function shift(obj, dx, dy) {
    if (obj.box) obj.box = [obj.box[0] + dx, obj.box[1] + dy, obj.box[2] + dx, obj.box[3] + dy];
    for (const r of obj.runs || []) {
      if (r.box) r.box = [r.box[0] + dx, r.box[1] + dy, r.box[2] + dx, r.box[3] + dy];
      if (r.tm) r.tm = [r.tm[0], r.tm[1], r.tm[2], r.tm[3], r.tm[4] + dx, r.tm[5] + dy];
    }
  }

  /** Take back the last change, or a particular one. A change that had dragged its object
   *  somewhere puts the cached geometry back where it was.
   *  收回最后一次改动,或者某一次特定的改动。一次曾把对象拖到别处的改动,
   *  会把缓存的几何放回原地。 */
  function undo(st, edit) {
    let out;
    if (!edit) out = st.edits.pop() || null;
    else {
      const at = st.edits.indexOf(edit);
      out = at < 0 ? null : st.edits.splice(at, 1)[0];
    }
    if (out?.moved && out.obj) shift(out.obj, -out.moved[0], -out.moved[1]);
    if (out?.boxWas && out.obj) out.obj.box = out.boxWas;
    return out;
  }

  /**
   * Build the edited document.
   *
   * From the original bytes every time, never from the last one built. Fonts are embedded here
   * rather than when the reader typed, because a subset font's glyph codes are decided as it is
   * assembled -- so the codes to write into the stream are not knowable until this moment, and a
   * document built twice must be built the same way twice.
   *
   * 搭出编辑后的文档。
   *
   * 每次都从原始字节搭起,绝不从上一次搭出来的那份接着搭。字体在这里嵌入,
   * 而不是在读者打字的时候,因为一个子集字体的字形码是在它被拼装出来的过程中定下的 ——
   * 所以要写进流里的那些码,直到此刻才可知,而一份被搭两次的文档,两次必须搭得一样。
   */
  async function build() {
    const doc = await PDFDocument.load(original);
    doc.registerFontkit(subsetFontkit);

    for (const st of pages.values()) {
      if (!st.edits.length) continue;
      const pg = doc.getPage(st.index);

      // Embed only the fonts and pictures this page's edits actually reached for.
      // 只嵌入这一页的编辑真正用到的那些字体与图片。
      const used = new Map();
      for (const e of st.edits) {
        for (const key of [e.write?.font, e.write?.subFont]) {
          if (!key || used.has(key)) continue;
          const entry = fonts.get(key);
          if (!entry) continue;
          const embedded = await doc.embedFont(entry.bytes, { subset: true });
          pg.node.setFontDictionary(PDFName.of(entry.key), embedded.ref);
          used.set(entry.key, embedded);
        }
      }
      const imgs = new Set();
      for (const e of st.edits) {
        if (!e.img || imgs.has(e.img.key)) continue;
        const emb = e.img.mime === 'image/png'
          ? await doc.embedPng(e.img.bytes)
          : await doc.embedJpg(e.img.bytes);
        pg.node.setXObject(PDFName.of(e.img.key), emb.ref);
        imgs.add(e.img.key);
      }

      const edits = st.edits.flatMap((e) => {
        // A move is two strokes of the pen: the bytes fall silent where they were, and reappear
        // at the end of the tape inside a translation.
        // 一次挪动是笔下的两划:那些字节在原地归于沉默,又在带子末尾的一次平移里重新现身。
        if (e.what === 'move') {
          return [
            { from: e.obj.from, to: e.obj.to, text: '' },
            {
              from: st.src.length, to: st.src.length,
              text: NL + ['q', `1 0 0 1 ${n6(e.dx)} ${n6(e.dy)} cm`, st.src.slice(e.obj.from, e.obj.to), 'Q'].join(NL) + NL,
            },
          ];
        }
        if (e.img) {
          const g = e.img;
          return [{
            from: e.from, to: e.to,
            text: NL + ['q', `${n6(g.w)} 0 0 ${n6(g.h)} ${n6(g.x)} ${n6(g.y)} cm`, `/${g.key} Do`, 'Q'].join(NL) + NL,
          }];
        }
        if (!e.write) return [e];
        const w = e.write;
        // A mixed block: the document's font writes its stretches by code, the stand-in encodes
        // only the characters the subset never carried.
        // 一个混排的块:文档字体按码位写它那几段,替身只编码子集从未携带过的那几个字符。
        if (w.parts) {
          const f = used.get(w.subFont);
          if (!f) return [{ from: e.from, to: e.to, text: '' }];
          const seq = w.parts.map((p) => (p.codes
            ? { codes: p.codes }
            : { hex: f.encodeText(p.text).toString() }));
          return [{ from: e.from, to: e.to, text: NL + textBlock(w, null, null, seq) + NL }];
        }
        let hex;
        let rows = null;
        if (w.embedded || w.block === 'new') {
          const f = used.get(w.font);
          if (!f) return [{ from: e.from, to: e.to, text: '' }];
          // encodeText both produces the codes and records which glyphs the subset must carry,
          // which is why it happens here and not when the reader typed.
          // encodeText 既产出那些码,也记下这个子集必须携带哪些字形 ——
          // 这正是它发生在此处、而不是发生在读者打字那一刻的原因。
          if (w.lines) rows = w.lines.map((r) => ({ ...r, hex: f.encodeText(r.text).toString() }));
          else hex = f.encodeText(w.text).toString();
        } else {
          hex = hexOf(w.codes, w.bytes);
        }
        return [{ from: e.from, to: e.to, text: NL + textBlock(w, hex, rows) + NL }];
      });

      // The page's own instructions are wrapped, so that anything they left unbalanced -- an
      // unclosed q, a transform still in force -- cannot reach what was appended after them.
      // 页面自己的指令被包起来,好让它们留下的任何不平衡 —— 一个没关掉的 q、一次仍然生效的变换 ——
      // 够不着续在它们后面的东西。
      const inner = applyEdits(st.src, edits.filter((e) => e.from < st.src.length));
      const tail = applyEdits('', edits.filter((e) => e.from >= st.src.length)
        .map((e) => ({ ...e, from: 0, to: 0 })));
      setContent(doc, pg, 'q' + String.fromCharCode(10) + inner + String.fromCharCode(10) + 'Q' + tail);
    }
    return doc.save();
  }

  return {
    pageCount,
    page,
    textOf,
    resolve,
    remove,
    retype,
    addText,
    addImage,
    move,
    undo,
    build,
    get dirty() {
      for (const st of pages.values()) if (st.edits.length) return true;
      return false;
    },
    /** Every change made, newest last, so an interface can list or step through them.
     *  做过的每一次改动,最新的在最后,好让界面可以列出它们或者一步步走过去。 */
    get changes() {
      const all = [];
      for (const st of pages.values()) for (const e of st.edits) all.push({ page: st.index, ...e });
      return all;
    },
  };
}

/**
 * The object under a point, when several boxes contain it.
 *
 * The smallest one. Paint order says which is on top and would seem the better rule, but a page
 * is built background-first, so the thing on top is usually also the smallest, and where it is
 * not -- a caption over a photograph, a label inside a drawn box -- what somebody meant to click
 * is the small thing, not the large one it happens to sit on.
 *
 * 一个点底下的那个对象,当好几个框都包含它的时候。
 *
 * 取最小的那个。绘制顺序说明谁在上面,看起来是更好的规矩,但一页是从背景开始搭的,
 * 所以在上面的那个通常也是最小的那个;而在并非如此的地方 —— 照片上的一句说明、
 * 画出来的框里的一个标签 —— 一个人想点的是那个小的,不是它恰好坐在上面的那个大的。
 */
export function objectAt(objects, x, y) {
  const hits = objectsAt(objects, x, y);
  return hits.length ? hits[0] : null;
}

export function objectsAt(objects, x, y) {
  const hits = [];
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (!o.box || !o.paints) continue;
    if (x < o.box[0] || x > o.box[2] || y < o.box[1] || y > o.box[3]) continue;
    hits.push({ o, i, area: (o.box[2] - o.box[0]) * (o.box[3] - o.box[1]) });
  }
  hits.sort((a, b) => a.area - b.area || b.i - a.i);
  return hits.map((h) => h.o);
}

/** Which run of a text object a point falls in, for editing one line of several.
 *  一个点落在某个文本对象的哪一段里 —— 用于在好几行之中编辑其中一行。 */
export function runAt(obj, x, y) {
  if (obj?.kind !== 'text') return null;
  let best = null;
  for (const r of obj.runs) {
    if (!r.box) continue;
    if (x < r.box[0] || x > r.box[2] || y < r.box[1] || y > r.box[3]) continue;
    const area = (r.box[2] - r.box[0]) * (r.box[3] - r.box[1]);
    if (!best || area < best.area) best = { r, area };
  }
  return best ? best.r : (obj.runs.find((r) => r.box) || null);
}
