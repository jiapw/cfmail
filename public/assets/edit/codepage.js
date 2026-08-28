// Which bytes mean which characters, decided once for the preview and both editors.
//
// A text file does not say what encoding it is in. A BOM says it outright; everything else is
// judgement: bytes that form strictly valid multi-byte UTF-8 are UTF-8, because no ANSI-codepage
// text ever passes that test by accident, and everything that fails it is read the way the
// reader's own Windows would read it -- through the locale's ANSI codepage. That judgement can be
// wrong, which is why every place that shows a text also shows a selector: the reader picks, the
// bytes are read again, nothing is written anywhere.
//
// Saving is the half that browsers do not provide. TextDecoder reads every codepage; TextEncoder
// writes only UTF-8. So the encoder for a codepage is built out of its decoder: every one- and
// two-byte sequence is decoded once, and the table of answers, read backwards, is the encoder.
// A character with no place in the table is reported, never silently mangled -- and a file is
// always written back in the codepage it was read in, because converting a file's encoding is a
// decision that belongs to its owner, not to a save button.
//
// 哪些字节是哪些字,给预览和两个编辑器在同一个地方断定一次。
//
// 文本文件不会自报编码。BOM 是明说;其余靠判断:严格合法的多字节 UTF-8 就是 UTF-8 ——
// 没有哪段 ANSI 代码页的文本会碰巧通过这个检验;通不过的,就按读者自己的 Windows
// 会怎么读来读 —— 用系统 locale 的 ANSI 代码页。判断可能出错,所以每个显示文本的地方
// 都同时给一枚选择器:读者来挑,字节重读一遍,任何东西都不落盘。
//
// 保存是浏览器缺的那一半。TextDecoder 什么代码页都认得,TextEncoder 只会写 UTF-8。
// 于是代码页的编码器用它的解码器造出来:把每个一字节、两字节序列各解一遍,
// 那张答案表倒过来读,就是编码器。表里没有位置的字符会被指出来,绝不悄悄弄坏 ——
// 而文件永远按它被读入的代码页写回去,因为改一个文件的编码是它主人的决定,
// 轮不到一个保存按钮。
import { t, lang } from '../i18n.js';
import { esc, confirmDialog } from '../ui.js';

/** The codepages worth offering by name. Decoder labels on the left, the names people know them
 *  by on the right. gb18030 is listed once for both of its names: the WHATWG decoder for either
 *  label is the same superset, and one entry that answers to both beats two that disagree.
 *  值得按名字提供的代码页。左边是解码器的标签,右边是人们叫它们的名字。
 *  gb18030 用一条列出它的两个名字:两个标签在 WHATWG 里是同一个超集解码器,
 *  一条能应两个名字的,好过两条会互相打架的。 */
export const CODEPAGES = [
  { v: 'utf-8', label: 'UTF-8' },
  { v: 'gb18030', label: 'GB18030 / GBK' },
  { v: 'big5', label: 'Big5' },
  { v: 'shift_jis', label: 'Shift_JIS' },
  { v: 'euc-kr', label: 'EUC-KR' },
  { v: 'euc-jp', label: 'EUC-JP' },
  { v: 'windows-1252', label: 'Windows-1252' },
  { v: 'windows-1251', label: 'Windows-1251' },
  { v: 'utf-16le', label: 'UTF-16 LE' },
  { v: 'utf-16be', label: 'UTF-16 BE' },
];

const labelOf = (enc) => CODEPAGES.find((c) => c.v === enc)?.label || enc;

/** The three byte orders a file can open with. Nothing else counts as a BOM here.
 *  文件可能用来开头的三种字节序标记。除此之外这里一概不算 BOM。 */
export function sniffBom(u8) {
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return 'utf-8';
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return 'utf-16le';
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return 'utf-16be';
  return null;
}

/** A language tag's ANSI codepage, or null for the tags (English among them) that say nothing
 *  useful about one.
 *  一个语言标签对应的 ANSI 代码页;答不出什么的标签(英语在内)返回 null。 */
const CP_BY_LANG = {
  ja: 'shift_jis', ko: 'euc-kr', th: 'windows-874', vi: 'windows-1258',
  tr: 'windows-1254', az: 'windows-1254', he: 'windows-1255',
  ar: 'windows-1256', fa: 'windows-1256', ur: 'windows-1256', el: 'windows-1253',
  ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251',
  mk: 'windows-1251', be: 'windows-1251', kk: 'windows-1251',
  pl: 'windows-1250', cs: 'windows-1250', sk: 'windows-1250', hu: 'windows-1250',
  hr: 'windows-1250', sl: 'windows-1250', ro: 'windows-1250', sq: 'windows-1250', bs: 'windows-1250',
  et: 'windows-1257', lv: 'windows-1257', lt: 'windows-1257',
};
function cpForTag(tag) {
  if (!tag) return null;
  if (tag.startsWith('zh')) return /(tw|hk|mo|hant)/.test(tag) ? 'big5' : 'gb18030';
  return CP_BY_LANG[tag.split('-')[0]] || null;
}

/** The ANSI codepage this reader's Windows would read an unmarked file through. A browser is not
 *  told the real one, so it is guessed from languages -- the interface language first, because a
 *  person chose that one, and a Chinese-system reader running an English-language browser is
 *  common enough to matter; then whatever the browser lists. Tags that name no codepage (English
 *  names none) are passed over rather than allowed to end the search.
 *  这位读者的 Windows 会用哪个 ANSI 代码页读一份没有标记的文件。浏览器打听不到真的那一个,
 *  于是从语言里猜 —— 界面语言优先,因为那是人亲手选的,而"中文系统配英文浏览器"的读者
 *  多到不能不算;然后才轮到浏览器列出的那些。说不出代码页的标签(英语就说不出)
 *  被跳过,而不是让它终止这场查找。 */
export function localeCodepage() {
  const cands = [lang(), ...(navigator.languages || []), navigator.language || ''];
  for (const c of cands) {
    const cp = cpForTag(String(c || '').toLowerCase());
    if (cp) return cp;
  }
  return 'windows-1252';
}

/** What encoding these bytes are in, as far as bytes can say.
 *
 *  A BOM settles it. Without one, bytes that use the high range AND form strictly valid UTF-8 are
 *  UTF-8: codepage text never passes that test by accident, and reading real UTF-8 through a
 *  codepage garbles it with certainty. Everything else -- pure ASCII included -- is the locale's
 *  ANSI codepage, which is how the file would open in Notepad on the machine it probably came
 *  from. The validity check runs in stream mode so that a window boundary cutting a sequence in
 *  half does not turn a verdict of "valid" into "broken".
 *
 *  这些字节是什么编码 —— 在字节所能回答的范围内。
 *
 *  有 BOM 听 BOM 的。没有,则"用到了高位区、且是严格合法 UTF-8"的就是 UTF-8:
 *  代码页文本不会碰巧通过这个检验,而把真 UTF-8 按代码页读则必然读碎。
 *  其余的 —— 包括纯 ASCII —— 都算 locale 的 ANSI 代码页,那正是这份文件
 *  在它多半来自的那台机器上被记事本打开的样子。合法性检验用流式跑,
 *  免得窗口边界把一个序列拦腰斩断,让"合法"被误判成"坏了"。 */
export function detect(u8) {
  const bomEnc = sniffBom(u8);
  if (bomEnc) return { enc: bomEnc, bom: true };
  let high = false;
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] >= 0x80) { high = true; break; }
  }
  if (high) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(u8, { stream: true });
      return { enc: 'utf-8', bom: false };
    } catch { /* not UTF-8; fall through to the codepage / 不是 UTF-8,落到代码页 */ }
  }
  return { enc: localeCodepage(), bom: false };
}

/** Bytes to text, forgivingly: this is the reading side, and a wrong guess should come out as
 *  mojibake somebody can recognise and correct, not as an error page. The decoder strips the BOM
 *  of its own encoding by itself.
 *  字节变文字,从宽:这是"读"的那一边,猜错了该显示成人认得出、改得掉的乱码,
 *  而不是一页报错。解码器会自己剥掉属于它那种编码的 BOM。 */
export const decodeBytes = (u8, enc) => new TextDecoder(enc).decode(u8);

// ---------- The write side / 写的那一边 ----------

/** char -> bytes for one codepage, built by running its decoder over every sequence it could
 *  accept. Where two byte sequences decode to the same character, the first one wins -- the same
 *  preference the standard encoders state. Built once, on the first save or switch that needs it;
 *  the loop is ~25k decodes and lands well under human notice.
 *  某个代码页的 字 -> 字节 表,用"把它可能接受的每个序列都拿它的解码器跑一遍"造出来。
 *  两个字节序列解出同一个字时,先到的赢 —— 与标准编码器声明的偏好相同。
 *  只造一次,造在第一次用得上它的保存或切换里;那个循环约两万五千次解码,远在人的知觉之下。 */
const tables = new Map();
function table(enc) {
  let m = tables.get(enc);
  if (m) return m;
  m = new Map();
  const dec = new TextDecoder(enc, { fatal: true });
  const b1 = new Uint8Array(1);
  const b2 = new Uint8Array(2);
  for (let a = 0x80; a <= 0xff; a++) {
    b1[0] = a;
    try {
      const s = dec.decode(b1);
      if (s.length === 1 && !m.has(s)) m.set(s, [a]);
    } catch { /* not a lone byte here / 在这里不是单独成字的字节 */ }
  }
  // Two-byte space of every codepage this list offers. Sequences a codepage rejects throw and are
  // skipped; a single-byte codepage answers with two characters and is filtered by length. What a
  // codepage keeps in longer sequences (gb18030's four-byte plane, euc-jp's third byte) stays out
  // of the table on purpose: those characters then count as unencodable and get pointed at, which
  // is the honest answer for a file that was in a two-byte codepage to begin with.
  // 这份清单上每个代码页的双字节空间。代码页不认的序列会抛错、被跳过;
  // 单字节代码页会答出两个字,被长度滤掉。代码页藏在更长序列里的那些
  // (gb18030 的四字节面、euc-jp 的第三个字节)有意不进表:那些字将算作编不出去、被指出来 ——
  // 对一份本来就是双字节代码页的文件,这是诚实的回答。
  for (let a = 0x81; a <= 0xfe; a++) {
    for (let b = 0x40; b <= 0xfe; b++) {
      b2[0] = a;
      b2[1] = b;
      try {
        const s = dec.decode(b2);
        if (s.length === 1 && !m.has(s)) m.set(s, [a, b]);
      } catch { /* not a pair here / 在这里不成对 */ }
    }
  }
  tables.set(enc, m);
  return m;
}

const BOM8 = [0xef, 0xbb, 0xbf];

/** Text to bytes in `enc`. Returns { bytes, bad }: `bad` lists, once each, the characters that
 *  have no place in that codepage -- each stands as '?' in `bytes`, but nothing is written until
 *  a caller has shown the list to a person and been told to go on. `bom` is obeyed for UTF-8;
 *  UTF-16 always leads with one, because a UTF-16 file without it is a guess nobody should be
 *  left to make.
 *  把文字写成 `enc` 的字节。返回 { bytes, bad }:`bad` 把在那个代码页里没有位置的字符
 *  一样列一个 —— 它们在 `bytes` 里各占一个 '?',但在调用方把这份清单给人看过、
 *  并被告知继续之前,什么都不会写下去。`bom` 对 UTF-8 照办;UTF-16 一律先写一个 ——
 *  没有它的 UTF-16 文件,是不该留给任何人去猜的谜。 */
export function encodeText(text, enc, bom) {
  if (enc === 'utf-8') {
    const body = new TextEncoder().encode(text);
    if (!bom) return { bytes: body, bad: [] };
    const out = new Uint8Array(body.length + 3);
    out.set(BOM8);
    out.set(body, 3);
    return { bytes: out, bad: [] };
  }
  if (enc === 'utf-16le' || enc === 'utf-16be') {
    const le = enc === 'utf-16le';
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = le ? 0xff : 0xfe;
    out[1] = le ? 0xfe : 0xff;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[2 + i * 2] = le ? c & 0xff : c >> 8;
      out[3 + i * 2] = le ? c >> 8 : c & 0xff;
    }
    return { bytes: out, bad: [] };
  }
  const m = table(enc);
  const out = [];
  const bad = [];
  const seen = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    const b = m.get(ch);
    if (b) {
      for (const x of b) out.push(x);
    } else {
      out.push(0x3f);
      if (!seen.has(ch)) {
        seen.add(ch);
        bad.push(ch);
      }
    }
  }
  return { bytes: Uint8Array.from(out), bad };
}

/** The text as it will actually be saved: unencodable characters already turned to '?'. Written
 *  as decode(encode(...)) so the box and the file cannot disagree about what was kept.
 *  文字被真正保存下来的样子:编不出去的字符已经换成 '?'。写成 decode(encode(...)),
 *  好让输入框与文件对"留下了什么"没有分歧的余地。 */
export const lossyText = (text, enc) => decodeBytes(encodeText(text, enc, false).bytes, enc);

/** Read the same bytes as another codepage. The document's own record -- base, cp -- moves with
 *  it, so dirty checks and merges keep telling the truth; the hash does not move, because the
 *  bytes did not. Only files without a BOM ever get here: a BOM is the file stating its encoding
 *  itself, and the selector for such a file is locked.
 *  把同一份字节按另一个代码页来读。文档自己的记录 —— base、cp —— 随之移动,
 *  于是脏检查与合并说的仍是实话;哈希不动,因为字节没动。只有无 BOM 的文件会走到这里:
 *  BOM 是文件在自报编码,那样的文件,选择器是锁着的。 */
export function recode(doc, enc) {
  doc.cp = { enc, bom: false };
  doc.base = decodeBytes(doc.raw, enc);
  return doc.base;
}

// ---------- The selector, shared by every place that shows one ----------
// ---------- 选择器,给每个要摆一枚的地方共用 ----------

/** The selector as markup. The current encoding is selected; one the list does not carry (a rarer
 *  locale codepage) is added rather than misreported. A BOM locks the control: the file has
 *  already said what it is, and offering to read it as something else is offering to misread it.
 *  选择器的标记。当前编码被选中;清单上没有的(较少见的 locale 代码页)补进去,而不是错报。
 *  BOM 会把控件锁住:文件已经自己说了它是什么,再提议按别的读,就是在提议读错它。 */
export function encSelectHtml(cp) {
  const list = CODEPAGES.some((c) => c.v === cp.enc) ? CODEPAGES : [...CODEPAGES, { v: cp.enc, label: cp.enc }];
  const opts = list.map((c) => {
    const label = c.v === cp.enc && cp.bom ? `${c.label} · BOM` : c.label;
    return `<option value="${esc(c.v)}"${c.v === cp.enc ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const title = cp.bom ? t('enc_bom_locked') : t('enc_label');
  return `<select class="enc-sel"${cp.bom ? ' disabled' : ''} title="${esc(title)}"
    aria-label="${esc(t('enc_label'))}">${opts}</select>`;
}

/** An editor's half of a selector change: ask before discarding unsaved work, re-read on yes, put
 *  the selector back on no. Returns the re-read text, or null when nothing is to change.
 *  编辑器那一半的换挡:有没保存的活先问,答应了重读,不答应把选择器拨回去。
 *  返回重读出的文本;什么都不该变时返回 null。 */
export async function pickEnc(sel, doc, dirty) {
  const enc = sel.value;
  if (!doc || enc === doc.cp.enc) return null;
  if (dirty && !(await confirmDialog(t('enc_reload_ask', labelOf(enc)), t('enc_reload_use')))) {
    sel.value = doc.cp.enc;
    return null;
  }
  return recode(doc, enc);
}

/** Whether to go on with a save that would turn these characters into '?'. The person sees which
 *  characters and which codepage before anything is written.
 *  一次会把这些字符写成 '?' 的保存,还继不继续。在任何东西被写下之前,
 *  当事人会看到是哪些字符、哪个代码页。 */
export function confirmLossy(bad, enc) {
  const sample = bad.slice(0, 6).join(' ');
  return confirmDialog(t('enc_bad_ask', bad.length, labelOf(enc), sample), t('enc_bad_use'));
}
