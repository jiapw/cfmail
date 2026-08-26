// The reader's own font library, as a place to look for the face a document was made with.
//
// This is the only way to end up with the document's actual typeface rather than something
// standing in for it. A PDF made in Word on Windows was made with a font that is still sitting on
// that Windows machine, and often on the machine reading it too -- so when an edit needs a
// character the file's subset never carried, the exact right glyph is usually already here,
// twenty centimetres away, and the alternative is to ship a stranger's approximation of it.
//
// It is also the most intrusive thing this editor does, so it is arranged to be asked for rather
// than assumed:
//
//   Enumerating somebody's fonts tells you things about them -- which office suite, which design
//   tools, which language they work in -- and a list of installed fonts has been a fingerprinting
//   surface for as long as it has been readable. The browser makes this a permission for that
//   reason, and this module never asks for it on its own account. It reports whether the door
//   exists and whether it is open; opening it is a decision made elsewhere, by someone who was
//   told what they are opening.
//
//   Nothing depends on it. Every step of the font search works without this, and the search
//   simply does better with it than without. A reader on Firefox, or one who says no, is not
//   presented with a broken editor -- they get the same editor writing in a font we ship.
//
// 读者自己的字体库,作为"寻找文档当初那款字"的一个去处。
//
// 这是唯一能拿到文档真正那款字面、而不是某个替身的路。一份在 Windows 上用 Word 做出来的 PDF,
// 用的那款字此刻仍躺在那台 Windows 上,而且往往也躺在正在读它的这台机器上 ——
// 于是当一次编辑需要一个文件子集里从未携带的字时,那个分毫不差的字形通常已经在这里了,
// 二十厘米之外;而备选方案是发一个陌生人的近似品过去。
//
// 它也是本编辑器所做的最具侵入性的一件事,因此被安排成"被请求"而非"被假定":
//
//   枚举一个人装了哪些字体,是会说出些什么的 —— 用哪套办公软件、哪些设计工具、
//   在用哪种语言工作 —— 而"已安装字体列表"自打可读那天起就是一个指纹面。
//   浏览器把它设成一项权限正是为此,而本模块从不为自己去要这项权限。
//   它只报告这扇门在不在、开没开;开门是别处的决定,由一个被告知了自己在开什么的人来做。
//
//   没有任何东西依赖它。字体搜索的每一步没有它都能走,有它只是走得更好。
//   一个用 Firefox 的读者,或者一个说"不"的读者,面对的不是一个坏掉的编辑器 ——
//   他们拿到的是同一个编辑器,用我们发的字体来写。

import { faceFromTTC, nameKey, openFace } from './pdffont.js';

/** Chromium has it; the others do not, and there is no shim for a permission.
 *  Chromium 有;别的没有,而一项权限是没法用垫片补出来的。 */
export const available = () => typeof window.queryLocalFonts === 'function';

/**
 * Whether the door is open, asked without knocking.
 *
 * 'granted', 'denied' or 'prompt' -- the last meaning nobody has been asked yet. Querying the
 * permission is not asking for it, so this can be called before deciding whether the question is
 * worth putting to somebody.
 *
 * 门开没开,不敲门就问一声。
 *
 * 'granted'、'denied' 或 'prompt' —— 最后一个意思是还没有人被问过。查询权限不等于申请权限,
 * 所以可以在"这个问题值不值得拿去问人"之前先调用它。
 */
export async function state() {
  if (!available()) return 'unsupported';
  try {
    const p = await navigator.permissions.query({ name: 'local-fonts' });
    return p.state;
  } catch {
    return 'prompt';
  }
}

let index = null;   // nameKey -> FontData[]

/**
 * Open the library. Must be called from something the reader did, because the browser will not
 * raise a permission prompt for code that nobody asked to run.
 * 打开字体库。必须从读者的某个动作里调用 —— 浏览器不会为"没人要求运行"的代码弹出权限提示。
 */
export async function open() {
  if (index) return true;
  if (!available()) return false;
  let list;
  try {
    list = await window.queryLocalFonts();
  } catch {
    return false;                                  // refused, or asked outside a gesture
  }
  index = new Map();
  for (const f of list) {
    // A face answers to several names, and a document may have recorded any of them. The
    // PostScript name is what a PDF usually carries; the family is what a person would say.
    // 一张脸有好几个名字,而文档记下的可能是其中任何一个。PostScript 名是 PDF 通常携带的那个,
    // 家族名是一个人会说出口的那个。
    for (const n of [f.postscriptName, f.fullName, f.family]) {
      const k = nameKey(n);
      if (!k) continue;
      if (!index.has(k)) index.set(k, []);
      const bucket = index.get(k);
      if (!bucket.includes(f)) bucket.push(f);
    }
  }
  return true;
}

export const isOpen = () => !!index;

/** Forget the library. The permission is the browser's to remember; this is only the copy held
 *  in this tab. / 忘掉这份字体库。权限归浏览器记着;这里放下的只是本标签页手里的那份副本。 */
export function close() {
  index = null;
}

/**
 * Files for a family name, most plausible first.
 *
 * A collection is handed back whole -- several faces sharing one file, as almost every CJK system
 * font is shipped -- and split by whoever needed a font rather than here, because which face of
 * the collection is wanted is the caller's question and not this module's.
 *
 * 按字体名取文件,最像的排在前面。
 *
 * 字体集合会被整个交回去 —— 几张脸共用一个文件,几乎每款系统中文字体都是这么发的 ——
 * 拆开这件事交给需要字体的那一方,而不是在这里做:集合里要哪张脸,是调用方的问题,不是本模块的。
 */
export async function find(family, limit = 4) {
  if (!index || !family) return [];
  const hits = index.get(nameKey(family)) || [];
  const out = [];
  for (const f of hits.slice(0, limit)) {
    try {
      const buf = await f.blob().then((b) => b.arrayBuffer());
      out.push(new Uint8Array(buf));
    } catch { /* a face that will not hand over its bytes is not a candidate */ }
  }
  return out;
}

/**
 * A source function for resolveFont, with the shape it expects.
 *
 * Asked for a family, it looks for that family. Asked for nothing -- which is how the font search
 * says it has given up on matching and wants something that can simply write -- it offers the
 * widest faces it can see, since at that point coverage is the only thing left that matters.
 *
 * 给 resolveFont 用的来源函数,形状照它的要求。
 *
 * 问某个字体名,就找那个名字。什么都不问 —— 字体搜索用这种方式表示它已放弃匹配、
 * 只想要一个"写得出来"的东西 —— 就把看得见的字体里覆盖最广的几个交出去,
 * 因为到那一步,除了覆盖范围之外已经没有别的还重要了。
 */
export function source(widest = ['Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'SimSun', 'Arial Unicode MS']) {
  return async (family) => {
    if (!index) return [];
    if (family) return find(family);
    for (const name of widest) {
      const got = await find(name, 1);
      if (got.length) return got;
    }
    return [];
  };
}

/** What the reader would see listed, if the interface wants to show what it found.
 *  界面若想展示"找到了什么",这就是读者会看到的那份清单。 */
export function describe(family) {
  if (!index || !family) return null;
  const hits = index.get(nameKey(family));
  if (!hits?.length) return null;
  return { family, faces: hits.map((f) => f.fullName || f.postscriptName).filter(Boolean) };
}

/** Read a candidate as a face, splitting a collection down to the name that was asked for.
 *  把一个候选读成一张脸,遇到集合就按所问的名字拆到那一张。 */
export const faceOf = (bytes, family) => openFace(faceFromTTC(bytes, family || 0));
