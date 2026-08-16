// Spreadsheets for Drive previews and thumbnails: xlsx/xlsm through the same zero-dependency
// zip reader the other Office formats use, and csv/tsv straight from text.
//
// A workbook is opened lazily. The header parts -- workbook.xml, sharedStrings.xml, styles.xml
// -- are small and read up front; each worksheet is inflated and parsed only when someone looks
// at that tab. That is what makes an 80 MB book with seventeen sheets and 2.5 MB of sheet XML
// open in the time it takes to read its tab names, instead of parsing every cell nobody asked
// for. The same reasoning as pptx: judge the work by the parts actually read, never by the
// file's size, which here is mostly embedded pictures the parser never touches.
//
// 网盘预览与缩略图的电子表格支持:xlsx/xlsm 走与其它 Office 格式同一个零依赖 zip 读取器,
// csv/tsv 直接从文本来。
//
// 工作簿是惰性打开的。头部件 —— workbook.xml、sharedStrings.xml、styles.xml —— 都不大,
// 一开始就读;每张工作表则要等有人点开那个标签页才解压、才解析。正是这一点,让一本 80 MB、
// 十七张表、2.5 MB 表格 XML 的簿子,在"读出标签名"的时间内就能打开,而不是把没人要看的
// 单元格全解析一遍。与 pptx 同一个道理:工作量按"真正读到的部件"衡量,绝不按文件大小 ——
// 这里的大小主要是解析器根本不碰的内嵌图片。

import { fileSource, httpSource, memSource, openZip, zipText } from './rzip.js';

export { fileSource, httpSource, memSource };

// No single part of a workbook should be this big; one that is has stopped being a spreadsheet.
// 工作簿的任何单个部件都不该这么大;真有那么大的,它已经不是一张电子表格了。
const PART_CAP = 64 * 1024 * 1024;
const partText = (zip, path) => zipText(zip, path, PART_CAP);

// A preview is something you glance at, not a spreadsheet application. These caps are what
// keep a 200k-row export from locking the tab while it builds a table nobody will scroll.
// 预览是用来"扫一眼"的,不是一个电子表格应用。这些上限是为了不让一份 20 万行的导出
// 在构建一张没人会滚到底的表格时把标签页卡死。
export const ROW_CAP = 800;
export const COL_CAP = 60;

// ---------- Small helpers / 小工具 ----------

/** "AB12" -> 27 (zero-based column). Letters only; the row part is ignored.
 *  "AB12" -> 27(列号,从 0 起)。只看字母部分,行号忽略。 */
export function colOf(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** 0 -> "A", 26 -> "AA". The column headings a reader expects above a grid.
 *  0 -> "A",26 -> "AA"。读者期望出现在表格上方的列标。 */
export function colName(n) {
  let s = '';
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

const kids = (el, name) => {
  const out = [];
  for (let c = el?.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === name) out.push(c);
  }
  return out;
};
const kid = (el, name) => {
  for (let c = el?.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
  return null;
};
const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A part's relationships, id -> target resolved against the part's own folder. Every reference
 *  between OOXML parts goes through one of these, and the targets are relative.
 *  某个部件的关系表,id -> 目标(相对该部件所在目录解析)。OOXML 部件之间的每一处引用
 *  都要经过它,而目标都是相对路径。 */
async function relsOf(zip, partPath) {
  const dir = partPath.slice(0, partPath.lastIndexOf('/'));
  const xml = await partText(zip, `${dir}/_rels/${partPath.slice(dir.length + 1)}.rels`);
  const map = new Map();
  if (!xml) return map;
  for (const r of kids(parseXml(xml).documentElement, 'Relationship')) {
    const t = r.getAttribute('Target') || '';
    map.set(r.getAttribute('Id'), t.startsWith('/') ? t.slice(1) : norm(`${dir}/${t}`));
  }
  return map;
}

/** Collapse the ../ segments a relationship target uses to climb out of its own folder.
 *  把关系目标里用来跳出自身目录的 ../ 折叠掉。 */
function norm(path) {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

// ---------- Colours / 颜色 ----------

// Excel's legacy indexed palette, for the handful of files that still use it. Only the entries
// that actually appear in practice; anything else falls through to no colour at all.
// Excel 的遗留索引调色板,给少数仍在用它的文件。只列实际会出现的那些,其余一概按"无颜色"处理。
const INDEXED = {
  0: '000000', 1: 'FFFFFF', 2: 'FF0000', 3: '00FF00', 4: '0000FF', 5: 'FFFF00', 6: 'FF00FF',
  7: '00FFFF', 8: '000000', 9: 'FFFFFF', 10: 'FF0000', 11: '00FF00', 12: '0000FF', 13: 'FFFF00',
  14: 'FF00FF', 15: '00FFFF', 64: '000000', 65: 'FFFFFF',
};

/** Apply Excel's tint to a hex colour: positive lightens toward white, negative darkens toward
 *  black, on each channel independently. Without it, theme-coloured fills all come out as the
 *  same six base hues and a banded table loses its banding.
 *  对十六进制颜色施加 Excel 的 tint:正值向白、负值向黑,各通道独立。
 *  不做这一步,主题色填充会全部塌成同样的六种基色,带斑马纹的表格就没了斑马纹。 */
function tinted(hex, tint) {
  if (!tint) return hex;
  const ch = (i) => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    const out = tint > 0 ? v * (1 - tint) + 255 * tint : v * (1 + tint);
    return Math.max(0, Math.min(255, Math.round(out))).toString(16).padStart(2, '0');
  };
  return ch(0) + ch(2) + ch(4);
}

/** A <color> element in any of the four flavours Excel writes.
 *  Excel 会写出的四种 <color> 写法。 */
function colorOf(el, theme) {
  if (!el) return null;
  const tint = parseFloat(el.getAttribute('tint') || '0') || 0;
  const rgb = el.getAttribute('rgb');
  if (rgb) return '#' + tinted(rgb.length === 8 ? rgb.slice(2) : rgb, tint);
  const th = el.getAttribute('theme');
  if (th != null && theme && theme[+th]) return '#' + tinted(theme[+th], tint);
  const ix = el.getAttribute('indexed');
  if (ix != null && INDEXED[+ix]) return '#' + tinted(INDEXED[+ix], tint);
  return null;
}

/** The workbook's six scheme colours plus the two light/dark pairs, in the order style records
 *  index them -- which is NOT the order theme1.xml lists them in: lt1/dk1 and lt2/dk2 are
 *  swapped. Getting that wrong paints every "dark text on light fill" the other way round.
 *  工作簿的六个方案色加两对明暗色,按样式记录索引它们的顺序 —— 而这个顺序与 theme1.xml
 *  的列出顺序"不同":lt1/dk1 与 lt2/dk2 是对调的。搞错这一点,所有"浅底深字"都会反过来。 */
function themeColors(xml) {
  try {
    const scheme = kid(parseXml(xml).documentElement, 'themeElements');
    const clr = kid(scheme, 'clrScheme');
    if (!clr) return null;
    const pick = (name) => {
      const el = kid(clr, name);
      const c = kid(el, 'srgbClr') || kid(el, 'sysClr');
      return c?.getAttribute('val') || c?.getAttribute('lastClr') || null;
    };
    const [dk1, lt1, dk2, lt2] = ['dk1', 'lt1', 'dk2', 'lt2'].map(pick);
    const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map(pick);
    return [lt1, dk1, lt2, dk2, ...accents, pick('hlink'), pick('folHlink')];
  } catch {
    return null;
  }
}

// ---------- Number formats / 数字格式 ----------

// The built-in codes, by id. Excel stores these by number and writes no code for them.
// 内置格式代码,按 id。Excel 只存编号,不写代码。
const BUILTIN = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0',
  48: '##0.0E+0', 49: '@',
};

/** Does this format code mean a date or a time? Only characters OUTSIDE quoted literals and
 *  outside [colour]/[condition] brackets count -- a currency code like "元"#,##0 contains an
 *  m and a d in some locales and must not be mistaken for a date.
 *  这个格式代码表示日期或时间吗?只有位于引号字面量之外、且不在 [颜色]/[条件] 方括号内的
 *  字符才算 —— 某些语言下的货币代码(如 "元"#,##0)里含有 m 或 d,绝不能被当成日期。 */
function isDateCode(code) {
  let q = false;
  let br = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') { q = !q; continue; }
    if (q) continue;
    if (c === '[') { br = true; continue; }
    if (c === ']') { br = false; continue; }
    if (br) continue;
    if (c === '\\') { i++; continue; }
    if ('ymdhs'.includes(c.toLowerCase())) return true;
  }
  return false;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Excel's day number -> a Date. The epoch is 1899-12-30 because serial 60 is the 29th of
 *  February 1900, a day that never existed; counting from the 30th absorbs the phantom day so
 *  every real date after it lands correctly. 1904-based books shift by 1462 days.
 *  Excel 的日序号 -> Date。纪元取 1899-12-30,因为序号 60 是"1900 年 2 月 29 日"——
 *  一个从未存在过的日子;从 30 日起算正好吸收掉这一天,其后每个真实日期才落得准。
 *  以 1904 为基准的簿子整体偏移 1462 天。 */
function serialDate(v, base1904) {
  const ms = Math.round((v + (base1904 ? 1462 : 0)) * 86400000);
  return new Date(Date.UTC(1899, 11, 30) + ms);
}

/** Tokenise a date format so each run of letters can be judged as a unit. Literals -- quoted
 *  text, escaped characters, [bracketed] sections -- come through as themselves.
 *  把日期格式切成词,好让每一段字母作为整体来判断。字面量 —— 引号文本、转义字符、
 *  [方括号] 段 —— 原样通过。 */
function dateTokens(code) {
  const out = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const lc = c.toLowerCase();
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      out.push({ k: 'lit', s: code.slice(i + 1, end < 0 ? code.length : end) });
      i = end < 0 ? code.length : end + 1;
    } else if (c === '[') {
      i = code.indexOf(']', i) + 1 || code.length;
    } else if (c === '\\') {
      out.push({ k: 'lit', s: code[i + 1] || '' });
      i += 2;
    } else if (/am\/pm|a\/p/i.test(code.slice(i, i + 5))) {
      const n = /^am\/pm/i.test(code.slice(i)) ? 5 : 3;
      out.push({ k: 'ampm' });
      i += n;
    } else if ('ymdhs'.includes(lc)) {
      let n = 0;
      while (code[i + n] && code[i + n].toLowerCase() === lc) n++;
      out.push({ k: lc, n });
      i += n;
    } else {
      out.push({ k: 'lit', s: c });
      i++;
    }
  }
  return out;
}

function fmtDateCode(d, code) {
  const toks = dateTokens(code);
  const ampm = toks.some((t) => t.k === 'ampm');
  const Y = d.getUTCFullYear();
  const h24 = d.getUTCHours();
  const h = ampm ? (h24 % 12 || 12) : h24;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const FULLDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const FULLMONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  // "m" is the one ambiguous letter in the whole language: minutes right after an hour or right
  // before a second, months everywhere else. Judged between TOKENS, not characters, so the
  // separators in "h:mm:ss" and "yyyy/m/d" do not confuse it.
  // "m" 是整套语言里唯一有歧义的字母:紧跟小时之后、或紧接秒之前时是分钟,其余一律是月份。
  // 判断在"词"之间进行而非字符之间,"h:mm:ss" 与 "yyyy/m/d" 里的分隔符便不会干扰它。
  const nearest = (i, step) => {
    for (let j = i + step; j >= 0 && j < toks.length; j += step) if (toks[j].k !== 'lit') return toks[j].k;
    return '';
  };
  return toks.map((t, i) => {
    if (t.k === 'lit') return t.s;
    if (t.k === 'ampm') return h24 < 12 ? 'AM' : 'PM';
    if (t.k === 'y') return t.n <= 2 ? pad(Y % 100) : String(Y);
    if (t.k === 'h') return pad(h, t.n);
    if (t.k === 's') return pad(d.getUTCSeconds(), t.n);
    // Three letters is the abbreviation, four or more the full name -- for weekdays and
    // months alike. "dddd" asking for Wednesday and getting Wed is the classic slip.
    // 三个字母是缩写,四个及以上是全称 —— 星期与月份同理。
    // "dddd" 要的是 Wednesday 却拿到 Wed,是这里的经典失手。
    if (t.k === 'd') {
      if (t.n >= 4) return FULLDAYS[d.getUTCDay()];
      if (t.n === 3) return DAYS[d.getUTCDay()];
      return pad(d.getUTCDate(), t.n);
    }
    const minute = nearest(i, -1) === 'h' || nearest(i, 1) === 's';
    if (minute) return pad(d.getUTCMinutes(), t.n);
    if (t.n >= 4) return FULLMONTHS[d.getUTCMonth()];
    if (t.n === 3) return MONTHS[d.getUTCMonth()];
    return pad(d.getUTCMonth() + 1, t.n);
  }).join('').trim();
}

/** Format a numeric cell for display. A pragmatic subset of Excel's format language: dates and
 *  times properly, percentages, thousands separators and decimal places; everything else falls
 *  back to the number itself, trimmed. Enough that a preview reads like the sheet does.
 *  为显示格式化数值单元格。Excel 格式语言的务实子集:日期时间照做,百分比、千分位、
 *  小数位照做;其余一律退回数字本身并去掉冗余。够让预览读起来与原表一致。 */
export function fmtCell(v, code, base1904) {
  if (!Number.isFinite(v)) return String(v);
  if (!code || code === 'General') {
    // Long floats are float noise more often than intent / 过长的小数多半是浮点噪声而非本意
    const r = Math.abs(v) < 1e15 ? Math.round(v * 1e10) / 1e10 : v;
    return String(r);
  }
  if (code === '@') return String(v);
  // Only the positive section applies to what a preview shows / 预览只用得到正数那一节
  const section = code.split(';')[0];
  if (isDateCode(section)) {
    const d = serialDate(v, base1904);
    return Number.isNaN(d.getTime()) ? String(v) : fmtDateCode(d, section);
  }
  const pct = section.includes('%');
  let n = pct ? v * 100 : v;
  const dec = (/\.(0+)/.exec(section) || ['', ''])[1].length;
  const group = /[#0],[#0]/.test(section);
  let s = dec ? Math.abs(n).toFixed(dec) : String(Math.round(Math.abs(n)));
  if (group) {
    const [int, frac] = s.split('.');
    s = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '');
  }
  if (n < 0) s = '-' + s;
  // A currency symbol quoted in the code belongs on the value / 代码里引起来的货币符号属于这个值
  const cur = (/"([^"]+)"/.exec(section) || ['', ''])[1] || (/^[$￥€£¥]/.exec(section) || [''])[0];
  return (cur || '') + s + (pct ? '%' : '');
}

// ---------- xlsx ----------

/**
 * Open a workbook. Header parts now, worksheets on demand.
 * 打开一个工作簿。头部件立刻读,工作表按需读。
 * @returns {Promise<{sheets: {name: string}[], read(i: number): Promise<object>}|null>}
 */
export async function xlsxOpen(source, keepUrl) {
  let zip;
  try {
    zip = await openZip(source);
  } catch {
    return null;
  }
  const wbXml = await partText(zip, 'xl/workbook.xml');
  if (!wbXml) return null;

  const wb = parseXml(wbXml);
  const base1904 = /date1904="(1|true)"/i.test(kid(wb.documentElement, 'workbookPr')?.outerHTML || '');

  // Sheet order and names come from workbook.xml; the file each one lives in comes from the
  // relationship id, because sheetN.xml is not reliably the Nth sheet.
  // 表的顺序与名称取自 workbook.xml;每张表实际在哪个文件里,要靠关系 id 查 ——
  // sheetN.xml 并不可靠地就是第 N 张表。
  const rels = new Map();
  const relXml = await partText(zip, 'xl/_rels/workbook.xml.rels');
  if (relXml) {
    for (const r of kids(parseXml(relXml).documentElement, 'Relationship')) {
      rels.set(r.getAttribute('Id'), r.getAttribute('Target').replace(/^\/?xl\//, '').replace(/^\.\//, ''));
    }
  }
  const sheets = kids(kid(wb.documentElement, 'sheets'), 'sheet')
    .map((s) => ({
      name: s.getAttribute('name') || '',
      hidden: (s.getAttribute('state') || 'visible') !== 'visible',
      path: 'xl/' + (rels.get(s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')) || ''),
    }))
    .filter((s) => !s.hidden);
  if (!sheets.length) return null;

  // The only parts read to open a workbook: a couple of kilobytes of names, the string pool
  // and the style table. The worksheets -- and the pictures -- wait until someone asks.
  // 打开一个工作簿只读这几个部件:几 KB 的名称、字符串池、样式表。
  // 工作表 —— 以及图片 —— 要等有人开口才读。
  const themeXml = await partText(zip, 'xl/theme/theme1.xml');
  const sharedXml = await partText(zip, 'xl/sharedStrings.xml');
  const stylesXml = await partText(zip, 'xl/styles.xml');
  const theme = themeXml ? themeColors(themeXml) : null;
  const shared = sharedXml ? sharedStrings(sharedXml) : [];
  const styles = stylesXml ? parseStyles(stylesXml, theme) : { xfs: [], fmts: new Map() };
  const ctx = { shared, styles, base1904 };

  const cache = new Map();
  return {
    sheets: sheets.map((s) => ({ name: s.name })),
    async read(i) {
      if (cache.has(i)) return cache.get(i);
      const path = sheets[i]?.path;
      const xml = path ? await partText(zip, path) : null;
      const grid = xml ? parseSheet(xml, ctx) : null;
      // Pictures are their own part, referenced from the sheet -- and only worth inflating for
      // a caller that can hold the blob URLs and release them again.
      // 图片是独立部件,由工作表引用 —— 且只有在调用方能持有 blob URL 并负责释放时才值得解压。
      if (grid && grid.drawing && keepUrl) {
        try {
          grid.images = await readDrawing(zip, path, grid.drawing, keepUrl);
        } catch { grid.images = []; }
      }
      cache.set(i, grid);
      return grid;
    },
  };
}

// EMU is the unit every OOXML measurement uses: 914400 to the inch, against 96 CSS pixels
// EMU 是 OOXML 一切尺寸的单位:每英寸 914400,而 CSS 每英寸 96 像素
const EMU = 9525;
// One picture is worth inflating; a sheet's worth of full-resolution photographs is not. The
// sample that prompted this carries 78 MB of them, and a preview that unpacks all of it to
// show thumbnails of thirty-one pictures has mistaken thoroughness for usefulness.
// 解压一张图片是值得的;整张表的全分辨率照片则不然。促成这项支持的样本带了 78 MB 图片,
// 一个为了展示三十一张图的缩样而把它们全解压的预览,是把"周全"错当成了"有用"。
const IMG_MAX = 8 * 1024 * 1024;
const IMG_TOTAL = 48 * 1024 * 1024;

/** Pictures anchored to cells: where each sits, how big it is, and a blob URL for its bytes.
 *  Both anchor shapes carry a `from` cell; a two-cell anchor also names where it ends, which is
 *  the only way to know its size when no explicit extent is given.
 *  锚定在单元格上的图片:各自的位置、尺寸,以及其字节的 blob URL。
 *  两种锚点都带 `from` 单元格;双单元格锚点还给出终点 —— 在没有显式尺寸时,那是唯一的依据。 */
async function readDrawing(zip, sheetPath, relId, keepUrl) {
  const sheetRels = await relsOf(zip, sheetPath);
  const drawPath = sheetRels.get(relId);
  const drawXml = drawPath && await partText(zip, drawPath);
  if (!drawXml) return [];
  const drawRels = await relsOf(zip, drawPath);
  const doc = parseXml(drawXml);
  const out = [];
  let spent = 0;
  for (let a = doc.documentElement.firstElementChild; a; a = a.nextElementSibling) {
    if (a.localName !== 'oneCellAnchor' && a.localName !== 'twoCellAnchor') continue;
    const from = kid(a, 'from');
    const r = +(kid(from, 'row')?.textContent || -1);
    const c = +(kid(from, 'col')?.textContent || -1);
    if (r < 0 || c < 0 || r >= ROW_CAP || c >= COL_CAP) continue;
    const pic = kid(a, 'pic');
    const blip = kid(kid(pic, 'blipFill'), 'blip');
    const target = blip && drawRels.get(blip.getAttributeNS(REL_NS, 'embed'));
    const media = target && zip.stat(target);
    if (!media || media.isDir || media.size > IMG_MAX || spent + media.size > IMG_TOTAL) continue;
    let w = 0;
    let h = 0;
    const extent = kid(a, 'ext');
    if (extent) {
      w = +extent.getAttribute('cx') / EMU;
      h = +extent.getAttribute('cy') / EMU;
    } else {
      const off = kid(kid(kid(pic, 'spPr'), 'xfrm'), 'ext');
      if (off) { w = +off.getAttribute('cx') / EMU; h = +off.getAttribute('cy') / EMU; }
    }
    spent += media.size;
    const type = /\.png$/i.test(target) ? 'image/png' : /\.gif$/i.test(target) ? 'image/gif'
      : /\.webp$/i.test(target) ? 'image/webp' : 'image/jpeg';
    const bytes = (await zip.extract(media, IMG_MAX)).bytes;
    out.push({ r, c, w: Math.round(w) || 0, h: Math.round(h) || 0, url: keepUrl(new Blob([bytes], { type })) });
  }
  return out;
}

/** sharedStrings.xml: one string per <si>, rich-text runs flattened into it.
 *  sharedStrings.xml:每个 <si> 一个字符串,富文本 run 拼接进去。 */
function sharedStrings(xml) {
  const out = [];
  const doc = parseXml(xml);
  for (const si of kids(doc.documentElement, 'si')) {
    let s = '';
    for (let c = si.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === 't') s += c.textContent;
      else if (c.localName === 'r') s += kid(c, 't')?.textContent || '';
    }
    out.push(s);
  }
  return out;
}

function parseStyles(xml, theme) {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  const fmts = new Map();
  for (const f of kids(kid(root, 'numFmts'), 'numFmt')) {
    fmts.set(+f.getAttribute('numFmtId'), f.getAttribute('formatCode') || '');
  }
  const fonts = kids(kid(root, 'fonts'), 'font').map((f) => ({
    b: !!kid(f, 'b'), i: !!kid(f, 'i'),
    color: colorOf(kid(f, 'color'), theme),
    sz: parseFloat(kid(f, 'sz')?.getAttribute('val') || '') || 0,
  }));
  const fills = kids(kid(root, 'fills'), 'fill').map((f) => {
    const p = kid(f, 'patternFill');
    if (!p || (p.getAttribute('patternType') || 'none') === 'none') return null;
    return colorOf(kid(p, 'fgColor'), theme);
  });
  const xfs = kids(kid(root, 'cellXfs'), 'xf').map((x) => {
    const a = kid(x, 'alignment');
    return {
      numFmtId: +(x.getAttribute('numFmtId') || 0),
      font: fonts[+(x.getAttribute('fontId') || 0)] || null,
      fill: fills[+(x.getAttribute('fillId') || 0)] || null,
      align: a?.getAttribute('horizontal') || '',
      wrap: a?.getAttribute('wrapText') === '1',
    };
  });
  return { fmts, xfs };
}

/** One worksheet into a dense grid, capped. Walks the DOM by sibling rather than collecting
 *  every <c> at once: a 850 KB sheet holds tens of thousands of cells, and a per-row
 *  getElementsByTagName over the whole document would be quadratic.
 *  把一张工作表解析成稠密网格,带上限。按兄弟节点遍历 DOM,而不是一次性收集全部 <c>:
 *  一个 850 KB 的表有数万个单元格,若逐行对整篇文档 getElementsByTagName,复杂度是平方级。 */
function parseSheet(xml, ctx) {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  const data = kid(root, 'sheetData');
  if (!data) return null;

  const widths = [];
  for (const c of kids(kid(root, 'cols'), 'col')) {
    const min = +c.getAttribute('min') - 1;
    const max = Math.min(+c.getAttribute('max') - 1, COL_CAP);
    const w = parseFloat(c.getAttribute('width') || '') || 0;
    for (let i = min; i <= max; i++) if (i >= 0) widths[i] = w;
  }

  // Rows are collected by their own index, not by arrival order, and the dense grid is built
  // afterwards from the last row that actually holds something. Filling the gaps as they came
  // was the bug: Excel keeps styled-but-empty rows a thousand lines below the content, so the
  // filler ran to the cap and every sheet reported itself truncated at 800 rows.
  // 行按它自己的行号收集,而不是按到达顺序;稠密网格随后从"最后一行真有东西的"往回建。
  // 边走边补空档正是那个 bug:Excel 会在内容下方一千行处保留"有样式无内容"的行,
  // 于是补空档一路补到上限,每张表都自称在 800 行处被截断。
  const byIdx = new Map();
  let ncols = 0;
  let cut = false;
  let maxRow = -1;
  let seen = 0;
  for (let r = data.firstElementChild; r; r = r.nextElementSibling) {
    if (r.localName !== 'row') continue;
    const idx = +(r.getAttribute('r') || 0) - 1;
    const cells = [];
    for (let c = r.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName !== 'c') continue;
      const ref = c.getAttribute('r') || '';
      const col = ref ? colOf(ref) : cells.length;
      if (col < 0) continue;
      // Parse before judging the column, so the cap is only reported as a truncation when
      // something real was dropped. Excel styles empty cells hundreds of columns to the right
      // of the content; counting those as "trimmed" told every sheet it had been cut short.
      // 先解析再判断列号,只有真丢了东西才算截断。Excel 会给内容右侧几百列的空单元格
      // 加上样式;把那些算作"被裁掉",会让每一张表都自称遭到了删减。
      const cell = cellOf(c, ctx);
      if (!cell) continue;
      if (col >= COL_CAP) { cut = true; continue; }
      cells[col] = cell;
      if (col + 1 > ncols) ncols = col + 1;
    }
    if (!cells.some(Boolean)) continue;
    // Rows arrive in ascending order, so the first one out of range ends the sheet
    // 行是按升序到达的,第一个超出范围的就是这张表的终点
    if (idx < 0 || idx >= ROW_CAP || seen >= ROW_CAP) { cut = true; break; }
    byIdx.set(idx, cells);
    if (idx > maxRow) maxRow = idx;
    seen++;
  }
  const rows = Array.from({ length: maxRow + 1 }, (_, i) => byIdx.get(i) || []);
  const drawing = kid(root, 'drawing')?.getAttributeNS(REL_NS, 'id') || '';

  const merges = kids(kid(root, 'mergeCells'), 'mergeCell').map((m) => {
    const [a, b] = (m.getAttribute('ref') || '').split(':');
    if (!a || !b) return null;
    const r0 = parseInt(a.replace(/\D/g, ''), 10) - 1;
    const r1 = parseInt(b.replace(/\D/g, ''), 10) - 1;
    return { r: r0, c: colOf(a), rs: r1 - r0 + 1, cs: colOf(b) - colOf(a) + 1 };
  }).filter((m) => m && m.r >= 0 && m.c >= 0 && m.c < COL_CAP);

  return { rows, ncols, widths, merges, cut, drawing, images: [] };
}

function cellOf(c, ctx) {
  const t = c.getAttribute('t') || 'n';
  const xf = ctx.styles.xfs[+(c.getAttribute('s') || 0)] || null;
  let v = '';
  if (t === 'inlineStr') {
    v = kid(kid(c, 'is'), 't')?.textContent || '';
    for (const r of kids(kid(c, 'is'), 'r')) v += kid(r, 't')?.textContent || '';
  } else {
    const raw = kid(c, 'v')?.textContent;
    if (raw == null || raw === '') return null;
    if (t === 's') v = ctx.shared[+raw] ?? '';
    else if (t === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
    else if (t === 'e' || t === 'str') v = raw;
    else {
      const code = xf ? (ctx.styles.fmts.get(xf.numFmtId) ?? BUILTIN[xf.numFmtId] ?? '') : '';
      v = fmtCell(parseFloat(raw), code, ctx.base1904);
    }
  }
  if (!v && !xf?.fill) return null;
  const num = t === 'n' || t === '';
  return {
    v,
    a: xf?.align || (num ? 'right' : ''),
    b: xf?.font?.b || false,
    i: xf?.font?.i || false,
    fg: xf?.font?.color || '',
    bg: xf?.fill || '',
    w: xf?.wrap || false,
  };
}

// ---------- csv / tsv ----------

/** Split delimited text, honouring RFC 4180 quoting: doubled quotes are a literal quote, and a
 *  delimiter or newline inside quotes is data. A naive split on the delimiter tears every
 *  quoted address and every "1,234" in half.
 *  切分带分隔符的文本,遵守 RFC 4180 的引号规则:两个连续引号表示一个字面引号,
 *  引号内的分隔符与换行都是数据。照分隔符裸切,会把每个带引号的地址和每个 "1,234" 撕成两半。 */
export function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') { q = true; continue; }
    if (ch === delim) { row.push(cur); cur = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      rows.push(row);
      row = [];
      if (rows.length >= ROW_CAP) return rows;
      continue;
    }
    cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** Which character separates the columns. A .csv exported by a European or Chinese Excel is
 *  semicolon-delimited more often than not, so the extension is a hint, not the answer: count
 *  candidates over the first few lines and take the winner.
 *  哪个字符在分隔列。欧洲或中文环境的 Excel 导出的 .csv 多半是分号分隔,
 *  所以扩展名只是提示而非答案:在前几行里数一数各候选字符,谁多算谁。 */
export function sniffDelim(text, ext) {
  if (ext === 'tsv' || ext === 'tab') return '\t';
  const head = text.split(/\r?\n/).slice(0, 8).join('\n');
  const count = (ch) => (head.split(ch).length - 1);
  const best = [',', ';', '\t', '|'].map((ch) => [ch, count(ch)]).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/** Decode a text file that may not be UTF-8. Chinese and Japanese exports are routinely GBK or
 *  Shift_JIS, and those decoded as UTF-8 are a wall of replacement characters -- worse than
 *  useless, because it looks like the file is corrupt rather than merely differently encoded.
 *  解码可能不是 UTF-8 的文本文件。中日文导出常见 GBK 或 Shift_JIS,若按 UTF-8 解会得到
 *  满屏替换字符 —— 比没用还糟,因为它看起来像文件损坏,而不是"只是编码不同"。 */
export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(u8.subarray(3));
  }
  const utf8 = new TextDecoder('utf-8').decode(u8);
  const bad = (utf8.match(/�/g) || []).length;
  if (bad < 3) return utf8;
  for (const enc of ['gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
    try {
      const s = new TextDecoder(enc, { fatal: false }).decode(u8);
      if ((s.match(/�/g) || []).length < bad / 4) return s;
    } catch { /* decoder not available here / 此处没有这个解码器 */ }
  }
  return utf8;
}

/** csv/tsv into the same grid shape a worksheet produces, so one renderer draws both.
 *  把 csv/tsv 转成与工作表相同的网格结构,一个渲染器即可画两者。 */
export function delimitedGrid(text, ext) {
  const raw = parseDelimited(text, sniffDelim(text, ext));
  let ncols = 0;
  const rows = raw.map((r) => {
    const cells = r.slice(0, COL_CAP).map((v) => (v === '' ? null : { v, a: /^-?[\d.,]+%?$/.test(v) ? 'right' : '' }));
    if (cells.length > ncols) ncols = cells.length;
    return cells;
  });
  while (rows.length && !rows[rows.length - 1].some(Boolean)) rows.pop();
  return { rows, ncols, widths: [], merges: [], cut: raw.length >= ROW_CAP };
}

/** Plain text of a grid, for thumbnails and anything that just wants the words.
 *  网格的纯文本形式,给缩略图以及任何只想要文字的地方。 */
export function gridText(grid, maxRows = 24) {
  if (!grid) return '';
  return grid.rows.slice(0, maxRows)
    .map((r) => Array.from(r, (c) => (c?.v ?? '')).join('\t').replace(/\t+$/, ''))
    .join('\n');
}

// ---------- Markup ----------
// ---------- 标记 ----------

// Its own escaper: this module is the spreadsheet, end to end, and pulling in the interface
// layer for four characters would tie a parser to the app it happens to run in.
// 自带转义:本模块从头到尾就是"电子表格"这件事,为了四个字符去引入界面层,
// 等于把一个解析器绑死在它碰巧运行于其中的应用上。
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The grid itself: column letters and row numbers around it, the file's own column widths,
 *  merges as rowspan/colspan, and the cell's own fill, weight and alignment. Cells covered by
 *  a merge are skipped -- emitting them too would push every later column one place right.
 *  网格本身:四周是列标与行号,列宽用文件自己的,合并区走 rowspan/colspan,
 *  单元格的填充、字重与对齐照搬。被合并覆盖的单元格要跳过 —— 一并输出会把其后每一列右挤一格。 */
export function gridHtml(grid, cutLabel) {
  const ncols = Math.max(grid.ncols, 1);
  // A picture is often anchored well below the last row that holds text -- in the sample, four
  // hundred rows below. Reaching it means the grid has to run that far, exactly as the sheet
  // does in Excel; stopping at the last word would drop the pictures entirely.
  // 图片常常锚定在最后一行文字之下很远处 —— 样本里是四百行之下。要够到它,网格就得铺那么长,
  // 与在 Excel 中所见一致;停在最后一个字上,等于把图片整个丢掉。
  const pics = new Map();
  for (const im of grid.images || []) {
    const key = im.r + ':' + im.c;
    if (!pics.has(key)) pics.set(key, []);
    pics.get(key).push(im);
  }
  const nrows = Math.max(grid.rows.length, ...[...pics.values()].map((v) => v[0].r + 1), 0);
  const covered = new Set();
  const span = new Map();
  for (const m of grid.merges) {
    span.set(m.r + ':' + m.c, m);
    for (let r = m.r; r < m.r + m.rs; r++) {
      for (let c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) covered.add(r + ':' + c);
    }
  }
  // Excel's width unit is "characters of the default font"; ~7px each is the conversion Excel
  // itself documents, and it keeps a sheet laid out for A4 looking laid out.
  // Excel 的宽度单位是"默认字体的字符数";每字符约 7px 是 Excel 自己给出的换算,
  // 沿用它,为 A4 排过版的表格看起来仍然是排过版的。
  const colw = (i) => (grid.widths[i] ? Math.max(28, Math.min(Math.round(grid.widths[i] * 7), 460)) : 92);
  // The table is exactly as wide as its columns need, and no wider: a window stretched past
  // that leaves empty space on the right rather than inflating every column to fill it. A
  // spreadsheet's column widths are a decision someone made; honouring them beats using them.
  // 表格恰好是列宽之和那么宽,不再多一分:窗口拉得更宽时,右侧留白,而不是把每一列吹大去填满。
  // 电子表格的列宽是有人做过的决定;尊重它,胜过拿它当参考。
  const RN = 44;
  const total = RN + Array.from({ length: ncols }, (_, i) => colw(i)).reduce((a, b) => a + b, 0);
  const head = `<tr><th class="corner" style="width:${RN}px"></th>${
    Array.from({ length: ncols }, (_, i) => `<th style="width:${colw(i)}px">${esc(colName(i))}</th>`).join('')}</tr>`;
  const body = Array.from({ length: nrows }, (_, r) => {
    const row = grid.rows[r] || [];
    let out = `<tr><th class="rn">${r + 1}</th>`;
    for (let c = 0; c < ncols; c++) {
      if (covered.has(r + ':' + c)) continue;
      const m = span.get(r + ':' + c);
      const cell = row[c];
      const here = pics.get(r + ':' + c);
      const st = [];
      if (cell?.bg) st.push(`background:${cell.bg}`);
      if (cell?.fg) st.push(`color:${cell.fg}`);
      if (cell?.a) st.push(`text-align:${cell.a}`);
      if (cell?.b) st.push('font-weight:600');
      if (cell?.i) st.push('font-style:italic');
      if (cell?.w) st.push('white-space:pre-wrap');
      // A picture in Excel floats above the grid at its own size, overlapping whatever is to
      // its right. Reproducing that -- rather than squeezing it into one narrow column -- is
      // the difference between seeing the picture and seeing a 28-pixel smudge.
      // Excel 里的图片以自身尺寸浮在网格之上,盖住右侧的一切。照此再现 ——
      // 而不是把它挤进一个窄列 —— 就是"看见这张图"与"看见一块 28 像素污渍"的分别。
      let inner = esc(cell?.v || '');
      if (here) inner += here.map((im) => imgHtml(im)).join('');
      out += `<td${m ? ` rowspan="${m.rs}" colspan="${m.cs}"` : ''}${here ? ' class="pic"' : ''}${
        st.length ? ` style="${esc(st.join(';'))}"` : ''}>${inner}</td>`;
    }
    return out + '</tr>';
  }).join('');
  const note = cutLabel ? `<div class="drv-trunc">${esc(cutLabel)}</div>` : '';
  return `${note}<table class="drv-grid-tbl" style="width:${total}px"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}


// Big enough to read, small enough that a row of them does not become the whole preview.
// 大到能看清,小到不会让一排图占满整个预览。
const PIC_MAX_W = 460;
const PIC_MAX_H = 340;

function imgHtml(im) {
  let w = im.w || 0;
  let h = im.h || 0;
  if (w && h) {
    const k = Math.min(1, PIC_MAX_W / w, PIC_MAX_H / h);
    w = Math.round(w * k);
    h = Math.round(h * k);
  }
  const size = w && h ? `width:${w}px;height:${h}px` : `max-width:${PIC_MAX_W}px;max-height:${PIC_MAX_H}px`;
  return `<img class="drv-cellpic" loading="lazy" src="${esc(im.url)}" style="${size}" alt="">`;
}

// ---------- Enlarging a cell picture ----------
// ---------- 放大单元格里的图片 ----------

/** Wire the pictures in a rendered grid so a click enlarges them. Kept here with the markup
 *  that produced them, and free of any app dependency: the caller passes the container.
 *  给渲染好的网格里的图片接线,点击即放大。与产出这些标记的代码放在一处,
 *  且不依赖任何应用层:容器由调用方传入。 */
export function bindGrid(root) {
  const pics = [...root.querySelectorAll('img.drv-cellpic')];
  pics.forEach((im, i) => im.addEventListener('click', (e) => {
    // The cell beneath must not also react -- in the grid a click on a cell selects nothing,
    // but a picture overlaps its neighbours and the click would otherwise land on both.
    // 下面的单元格不应一并响应 —— 网格里点单元格本不选中什么,
    // 但图片会盖住邻格,不拦住的话这一下会同时落在两者上。
    e.stopPropagation();
    lightbox(pics.map((p) => p.getAttribute('src')), i);
  }));
}

/** A viewer of its own rather than the Drive's preview overlay: that overlay is already open
 *  showing this workbook, and reusing it would replace the sheet instead of covering it, so
 *  closing the picture would drop the reader back at the file listing.
 *  自带一个查看器,而不复用网盘的预览层:那一层此刻正开着、显示的就是这本工作簿,
 *  复用它会"替换"掉表格而不是"盖住"它 —— 关掉图片时,读者会一路掉回文件列表。 */
function lightbox(srcs, start) {
  let i = start;
  const el = document.createElement('div');
  el.className = 'drv-piclb';
  el.innerHTML = `<img alt="">${srcs.length > 1
    ? '<button class="nav prev" aria-label="prev">‹</button><button class="nav next" aria-label="next">›</button>' : ''}`;
  const img = el.querySelector('img');
  const show = () => { img.src = srcs[i]; };
  show();
  const close = () => {
    el.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const step = (d) => { i = (i + d + srcs.length) % srcs.length; show(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  };
  // Capture phase: the preview overlay listens for Escape too, and whoever hears it first
  // would close the whole workbook instead of just the picture.
  // 捕获阶段:预览层同样监听 Escape,谁先听到谁就关 —— 那会关掉整本工作簿而不是这张图。
  window.addEventListener('keydown', onKey, true);
  el.addEventListener('click', (e) => {
    const nav = e.target.closest('.nav');
    if (nav) { e.stopPropagation(); return step(nav.classList.contains('prev') ? -1 : 1); }
    close();
  });
  document.body.appendChild(el);
}
