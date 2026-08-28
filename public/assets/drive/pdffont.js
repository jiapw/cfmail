// Which font can write the characters somebody just typed, and where to get it.
//
// A PDF almost never carries a font. It carries the part of a font that the document happened to
// use: measured across seven real files, every one of fifty-eight fonts was a subset, and the
// subsets were small in a way their glyph counts hide -- one deck's "Microsoft YaHei" has slots
// for 30,209 glyphs and outlines for 44. So the moment an edit introduces a character the author
// never typed, there is nothing in the file to draw it with.
//
// Two obvious answers are both wrong.
//
// Filling the gap by adding glyphs to the embedded subset means renumbering glyph ids and
// rewriting the maps and widths that depend on them, for no gain: a page may carry as many font
// resources as it likes, and a second resource of the same typeface renders identically to a
// repaired first one.
//
// Replacing the embedded font wholesale is worse. Under Identity-H the content stream addresses
// glyphs by number, and glyph numbers are private to a font program -- across two real faces, of
// ten characters checked, zero shared a glyph id. Swapping the program turns every glyph already
// on the page into a different glyph.
//
// So the answer is neither repair nor replacement but addition, and the only real question is
// which file to add. This module answers it in four steps, each a strictly worse fidelity than
// the last, and says which one it took so the interface can be honest about it.
//
// 刚打进去的这些字,该用哪个字体来写,以及去哪儿拿。
//
// 一份 PDF 几乎从不携带一款字体。它携带的是这份文档恰好用到的那一部分:七份真实文件里
// 五十八个字体无一例外都是子集,而子集之小,被它们的字形数掩盖了 ——
// 某份汇报里的"微软雅黑"有 30,209 个字形槽位,有轮廓的是 44 个。
// 所以一次编辑只要引入了作者从未打过的字,文件里就没有任何东西能把它画出来。
//
// 两个显而易见的答案都是错的。
//
// 往内嵌子集里加字形来补缺口,意味着重编字形编号,并改写所有依赖这些编号的映射与宽度表,
// 而且毫无所得:一页想带多少个字体资源都行,而同一款字的第二个资源,
// 与一个"被修好的第一个"渲染得一模一样。
//
// 整体替换内嵌字体更糟。Identity-H 下内容流按编号寻址字形,而字形编号是某个字体程序的私事 ——
// 在两款真实字体上验过,十个字符里编号相同的是零个。换掉字体程序,
// 会把页面上已有的每一个字形都变成另一个字形。
//
// 所以答案既不是修补也不是替换,而是添加;唯一真正的问题是添加哪一个文件。
// 本模块分四步作答,一步比一步字面更远,并说明自己走到了第几步,好让界面能诚实地讲出来。

import { readFont } from '/vendor/pdfedit/pdfedit.entry.js';

/** The six-letter tag a subsetter puts in front of the name it subsetted. It says nothing about
 *  the typeface and would only ever fail to match a candidate.
 *  子集器加在被子集字体名前面的六个字母。它与字面本身无关,留着只会让候选永远匹配不上。 */
export const familyOf = (baseFont) => String(baseFont || '').replace(/^[A-Z]{6}\+/, '');

/** Normalised for comparing one font's name with another's. Vendors disagree about spaces and
 *  hyphens in ways that are not differences: "Microsoft YaHei" and "MicrosoftYaHei" are one face.
 *  用于把两个字体名放在一起比较。厂商在空格和连字符上的分歧不构成差别:
 *  "Microsoft YaHei" 与 "MicrosoftYaHei" 是同一款。 */
export const nameKey = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');

// ---------- what a font program can write ----------
// ---------- 一个字体程序写得出什么 ----------

/**
 * A font program, asked the only question the editor has for it.
 *
 * `.notdef` is a glyph like any other and has an outline -- the hollow box everyone recognises --
 * so "does this draw something" is not the test. Glyph zero is the test.
 *
 * 一个字体程序,以及编辑器唯一要问它的那个问题。
 *
 * `.notdef` 和别的字形一样是个字形,也有轮廓 —— 就是那个人人认得的空框 ——
 * 所以"它画不画得出东西"不是判据。判据是"字形编号是不是 0"。
 */
export function openFace(bytes, postscriptName) {
  let font;
  try {
    font = readFont(bytes, postscriptName);
  } catch {
    return null;
  }
  if (!font || !font.numGlyphs) return null;
  const cache = new Map();
  const gidFor = (ch) => {
    const cp = ch.codePointAt(0);
    if (cache.has(cp)) return cache.get(cp);
    let gid = 0;
    try {
      gid = font.glyphForCodePoint(cp)?.id || 0;
    } catch { /* a font that cannot answer has not got it */ }
    cache.set(cp, gid);
    return gid;
  };
  return {
    font,
    bytes,
    postscriptName: font.postscriptName || '',
    family: font.familyName || '',
    unitsPerEm: font.unitsPerEm || 1000,
    numGlyphs: font.numGlyphs,
    gidFor,
    has: (ch) => gidFor(ch) > 0,
    /** Which of these it cannot write, in the order given, without repeats.
     *  这些字里它写不出的那些,按给定顺序,不重复。 */
    missing(text) {
      const out = [];
      const seen = new Set();
      for (const ch of String(text)) {
        if (seen.has(ch) || ch === '\n' || ch === '\r') continue;
        seen.add(ch);
        if (!this.has(ch)) out.push(ch);
      }
      return out;
    },
  };
}

// ---------- is this candidate the face the document was made with ----------
// ---------- 这个候选,是不是文档当初用的那款字 ----------

/**
 * Compare outlines, not names.
 *
 * A subset carries real outlines for the glyphs it kept, and those outlines came from somewhere.
 * If a candidate draws the same characters the same way, down to the coordinate, it is that
 * somewhere -- this is a check with an answer, not a guess with a confidence. Measured on three
 * documents against their true faces: 59 of 59, 10 of 10, 60 of 60 identical, and against wrong
 * faces of the same script: none.
 *
 * Coordinates are scaled to a common em, because the same outline drawn at 1000 and at 2048 units
 * is the same outline.
 *
 * 比轮廓,不比名字。
 *
 * 子集为它保留下来的字形携带着真实的轮廓,而这些轮廓总是从某处来的。若一个候选把同样的字
 * 画成同样的样子,精确到坐标,那它就是那个"某处" —— 这是一次有答案的检验,
 * 而不是一次带着置信度的猜测。在三份文档上对着它们真正的字体量过:59/59、10/10、60/60 完全一致;
 * 对着同种文字的错误字体:一个都不一致。
 *
 * 坐标会被缩放到同一个 em,因为同一条轮廓画在 1000 单位和 2048 单位下,仍是同一条轮廓。
 */
export function sameFace(subset, candidate, limit = 24) {
  if (!subset || !candidate) return { verdict: 'unknown', matched: 0, checked: 0 };
  const chars = [];
  for (const cp of subset.font.characterSet || []) {
    if (cp > 0x20 && chars.length < limit * 3) chars.push(String.fromCodePoint(cp));
  }
  let matched = 0;
  let differed = 0;
  for (const ch of chars) {
    if (matched + differed >= limit) break;
    const a = outlineOf(subset, ch);
    const b = outlineOf(candidate, ch);
    if (!a || !b) continue;
    if (a === b) matched++;
    else differed++;
  }
  const verdict = !matched && !differed ? 'unknown' : differed ? 'different' : 'same';
  return { verdict, matched, checked: matched + differed };
}

function outlineOf(face, ch) {
  const gid = face.gidFor(ch);
  if (!gid) return null;
  let cmds;
  try {
    cmds = face.font.getGlyph(gid)?.path?.commands;
  } catch {
    return null;
  }
  if (!cmds || !cmds.length) return null;
  const k = 1000 / (face.unitsPerEm || 1000);
  const parts = [];
  for (const c of cmds) {
    parts.push(c.command);
    for (const a of c.args) parts.push(Math.round(a * k));
  }
  return parts.join(' ');
}

// ---------- a collection is not a font ----------
// ---------- 字体集合不是字体 ----------

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** Is this a TrueType Collection -- several faces sharing one file, as almost every CJK system
 *  font is shipped? / 这是不是一个 TrueType 集合 —— 几张脸共用一个文件,
 *  几乎每一款系统中文字体都是这么发的? */
export const isTTC = (b) => b.length > 4 && b[0] === 0x74 && b[1] === 0x74 && b[2] === 0x63 && b[3] === 0x66;

/**
 * One face out of a collection, as a file that stands on its own.
 *
 * Every tool downstream expects a font, and a collection is not one: handed a .ttc, the subsetter
 * reports that the thing it was given has no method for making subsets, which is true and
 * unhelpful. The faces inside share their glyph data by pointing at the same bytes, so lifting one
 * out is a matter of writing a new table directory over the tables that face names, in order,
 * with corrected offsets -- the tables themselves are copied untouched.
 *
 * 从集合里取出一张脸,成为一个能独立存在的文件。
 *
 * 下游每一样工具要的都是一个字体,而集合不是:把 .ttc 递给子集器,它会说"这东西没有做子集的方法",
 * 这话没错,也没用。集合内部各张脸靠指向同一段字节来共享字形数据,
 * 所以取出一张,无非是照着那张脸点名的那些表,按顺序写一份新的表目录、把偏移改对 ——
 * 表本身原样照抄。
 */
export function faceFromTTC(bytes, want = 0) {
  if (!isTTC(bytes)) return bytes;
  const count = u32(bytes, 8);
  let index = typeof want === 'number' ? want : 0;
  if (typeof want === 'string') {
    index = -1;
    for (let i = 0; i < count; i++) {
      const face = openFace(faceFromTTC(bytes, i));
      if (face && (nameKey(face.postscriptName) === nameKey(want) || nameKey(face.family) === nameKey(want))) {
        index = i;
        break;
      }
    }
    if (index < 0) index = 0;
  }
  if (index < 0 || index >= count) index = 0;

  const off = u32(bytes, 12 + index * 4);
  const numTables = u16(bytes, off + 4);
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const rec = off + 12 + i * 16;
    dir.push({
      tag: bytes.subarray(rec, rec + 4),
      checksum: u32(bytes, rec + 4),
      offset: u32(bytes, rec + 8),
      length: u32(bytes, rec + 12),
    });
  }
  // Tables are padded to four bytes, and a directory that says otherwise produces a font every
  // parser rejects for a reason none of them explain well.
  // 表按四字节对齐,而一份说法不同的表目录,会产出一个所有解析器都拒绝、
  // 却谁也讲不清缘由的字体。
  const pad = (n) => (n + 3) & ~3;
  const headerSize = 12 + numTables * 16;
  let total = headerSize;
  for (const t of dir) total += pad(t.length);

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, numTables);
  // The three fields after the count describe a binary search over the directory. Getting them
  // wrong is harmless in every parser that matters and wrong in the file, so they are computed.
  // 计数之后的三个字段描述的是在表目录上做二分查找。写错了在所有要紧的解析器里都无害,
  // 但文件本身是错的,所以照算不误。
  let sel = 0;
  while ((1 << (sel + 1)) <= numTables) sel++;
  dv.setUint16(6, (1 << sel) * 16);
  dv.setUint16(8, sel);
  dv.setUint16(10, (numTables - (1 << sel)) * 16);

  let at = headerSize;
  dir.forEach((t, i) => {
    const rec = 12 + i * 16;
    out.set(t.tag, rec);
    dv.setUint32(rec + 4, t.checksum);
    dv.setUint32(rec + 8, at);
    dv.setUint32(rec + 12, t.length);
    out.set(bytes.subarray(t.offset, t.offset + t.length), at);
    at += pad(t.length);
  });
  return out;
}

// ---------- the four steps ----------
// ---------- 四步 ----------

export const LAYERS = {
  OWN: 'own',            // the document's own font already has these characters
  ORIGINAL: 'original',  // the same typeface, found elsewhere and verified against the subset
  BUNDLED: 'bundled',    // a typeface we ship, standing in for one we could not find
  FALLBACK: 'fallback',  // a typeface we ship, standing in for one we could not even identify
};

/**
 * Which font to write with, and how far from the document's own it is.
 *
 * The order is fidelity, and each step is taken only because the one before it could not be. The
 * first costs nothing at all -- no bytes are added to the file, and the result is the document's
 * own font because it IS the document's own font -- and it covers more than it sounds like it
 * would: correcting a typo, changing a number, deleting words. Only typing something new goes
 * further down.
 *
 * `sources` supplies candidate files by family name. It is a function rather than a table because
 * the interesting source is the reader's own font library, which cannot be enumerated without
 * asking them first, and should not be asked until there is a reason.
 *
 * 用哪个字体来写,以及它离文档自己的那个有多远。
 *
 * 这个顺序就是字面的忠实度,每一步都只因为上一步走不通才被走到。第一步分文不取 ——
 * 文件里不增加任何字节,而结果就是文档自己的字体,因为它本来就是 ——
 * 而且它覆盖的情况比听上去多:改错别字、改数字、删字。只有打进新东西才会往下走。
 *
 * `sources` 按字体名提供候选文件。它是个函数而不是一张表,因为真正有意思的来源是读者自己的
 * 字体库,而那个不先征得同意就无法枚举,并且在没有理由之前不该去问。
 */
export async function resolveFont(text, pdfFace, baseFont, sources) {
  const family = familyOf(baseFont);
  const missing = pdfFace ? pdfFace.missing(text) : [...new Set(String(text))];

  if (pdfFace && !missing.length) {
    return { layer: LAYERS.OWN, face: pdfFace, family, missing: [], exact: true };
  }

  // Named, and found under that name somewhere we can read. Verified before it is trusted: a name
  // is what a file calls itself, and two files may agree on a name and disagree on every outline.
  // 有名字,而且在某个我们读得到的地方按这个名字找到了。信任之前先验证:
  // 名字只是一个文件对自己的称呼,两个文件可以在名字上一致而在每一条轮廓上都不一致。
  if (family) {
    for (const bytes of await candidates(sources, family)) {
      const face = openFace(faceFromTTC(bytes, family));
      if (!face) continue;
      const check = pdfFace ? sameFace(pdfFace, face) : { verdict: 'unknown' };
      const still = face.missing(text);
      if (still.length) continue;                       // it cannot write this either
      if (check.verdict === 'different') continue;      // same name, another face
      return {
        layer: LAYERS.ORIGINAL, face, family, missing: [],
        exact: check.verdict === 'same', verified: check,
      };
    }
  }

  // The stand-in should at least match the weight: a name that says bold asks for the bold cut.
  // 替身至少要对上字重:名字里写着粗体,要的就是粗体那一刀。
  const bold = /bold|black|heavy|semibold|demibold|demi\b/i.test(String(baseFont || ''));
  const shipped = await candidates(sources, null, { bold });
  for (const bytes of shipped) {
    const face = openFace(faceFromTTC(bytes, 0));
    if (!face) continue;
    const still = face.missing(text);
    if (still.length && shipped.length > 1) continue;
    return {
      layer: family ? LAYERS.BUNDLED : LAYERS.FALLBACK,
      face, family, missing: still, exact: false,
    };
  }
  return { layer: null, face: null, family, missing, exact: false };
}

async function candidates(sources, family, opts) {
  if (typeof sources !== 'function') return [];
  try {
    const got = await sources(family, opts);
    return (Array.isArray(got) ? got : [got]).filter(Boolean);
  } catch {
    return [];
  }
}
