// Subtitles: the words, wherever somebody kept them.
//
// They are kept in two places and neither is inside the picture. A Matroska carries them as their
// own streams alongside the film -- most often ASS, which is a stage-play script with fonts and
// positions, sometimes SubRip, which is just the words. And a folder carries them as files sitting
// next to the film, named after it, one per language, which is how anything ripped from a disc
// before the container could hold them was shipped.
//
// What arrives here is text either way. A DVD's subtitles are not words at all -- the .idx and
// .sub pair holds them as bitmaps -- and that is a different problem with a different answer,
// which lives in vobsub.js. This file finds them and says which language each is; it does not
// pretend to read them.
//
// The two things this has to get right, and both of them are about somebody else's file rather
// than about subtitles: which bytes are which characters, and which of the nine fields on a line
// is the one people read.
//
// 字幕:那些字,不论有人把它们放在了哪里。
//
// 它们被放在两个地方,而这两个地方都不在画面里面。Matroska 把它们作为独立的流与片子并排携带 ——
// 多数是 ASS(那是一份带字体和位置的舞台剧本),有时是 SubRip(那就只是那些字)。
// 而一个文件夹把它们作为文件放在片子旁边,以片子命名,一种语言一个 ——
// 在容器还装不下它们的年代,从碟上抓下来的东西就是这么发行的。
//
// 到达这里的两条路上,都是文本。一张 DVD 的字幕根本就不是字 —— 那一对 .idx 和 .sub
// 把它们存成位图 —— 那是另一个问题、另一种答案,住在 vobsub.js 里。
// 这个文件负责找到它们、说出每一条是哪种语言;它不假装自己读得懂它们。
//
// 这里必须做对的两件事,而它们都关于"别人的文件",而非关于字幕本身:
// 哪些字节对应哪些字,以及一行上的九个字段里,哪一个是人真正在读的那个。

/** What a file has to be called to be words. `.sub` is in here and is not always words -- the
 *  same three letters were used for a text format and for the bitmaps of a DVD -- so what it
 *  actually is gets decided by looking, in `looksBinary`.
 *  一个文件要叫什么,才可能是字。`.sub` 也在这里,而它并不总是字 ——
 *  同样这三个字母既被一种文本格式用过,也被 DVD 的位图用着 ——
 *  所以它到底是什么,由 `looksBinary` 去看一眼再定。 */
export const SUB_EXTS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub', 'idx']);

/** Text subtitle encodings as libav names them. The rest of a film's streams are pictures or
 *  sound; these are the ones whose packets are words already.
 *  libav 给文字字幕编码起的名字。一部片子其余的流是画面或声音;
 *  而这几种的包里装的本来就是字。 */
export const SUB_CODECS = new Set(['ass', 'ssa', 'subrip', 'srt', 'text', 'webvtt', 'mov_text']);

/**
 * The same tags, as codes rather than names.
 *
 * A language picked once has to be recognisable when it comes back spelled differently -- chs and
 * zh-CN and zh-Hans are one choice, not three -- and it has to be comparable with what the browser
 * says this person reads, which is written in a third way again. So both sides are put through
 * here first.
 *
 * 同样那些标签,写成代码而不是名字。
 *
 * 一种被选过一次的语言,必须在换一种拼法回来的时候还认得出 —— chs、zh-CN、zh-Hans 是同一个选择,
 * 不是三个 —— 而且它必须能和"浏览器说这个人读什么"比较,而那边又是第三种写法。
 * 所以两边都先从这里过一遍。
 */
const CODE = {
  chs: 'zh-Hans', gb: 'zh-Hans', sc: 'zh-Hans', zhs: 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-sg': 'zh-Hans', 'zh-hans': 'zh-Hans',
  cht: 'zh-Hant', big5: 'zh-Hant', tc: 'zh-Hant', zht: 'zh-Hant', 'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant', 'zh-mo': 'zh-Hant', 'zh-hant': 'zh-Hant',
  chi: 'zh', zho: 'zh', zh: 'zh',
  eng: 'en', en: 'en',
  jpn: 'ja', ja: 'ja', jp: 'ja',
  kor: 'ko', ko: 'ko',
  fra: 'fr', fre: 'fr', fr: 'fr',
  deu: 'de', ger: 'de', de: 'de',
  spa: 'es', es: 'es',
  rus: 'ru', ru: 'ru',
  ita: 'it', it: 'it',
  por: 'pt', pt: 'pt',
  ara: 'ar', ar: 'ar',
  tha: 'th', th: 'th',
  vie: 'vi', vi: 'vi',
  ind: 'id', id: 'id',
  rum: 'ro', ron: 'ro', ro: 'ro',
};

export function codeOf(tag) {
  const k = String(tag || '').trim().toLowerCase().replace(/_/g, '-');
  if (!k) return '';
  if (CODE[k]) return CODE[k];
  const head = k.split('-')[0];
  if (CODE[head]) return CODE[head];
  return /^[a-z]{2,3}$/.test(head) ? head : '';
}

/** Languages by the name they call themselves, because a menu of subtitles is read by the person
 *  who wants that language, not by everybody else. Anything not here shows the tag it came with,
 *  which is better than guessing.
 *  语言用它们自称的名字,因为一份字幕菜单是给"想要那种语言的人"读的,不是给其余所有人读的。
 *  不在这里的,就显示它自己带来的那个标签 —— 那好过瞎猜。 */
const ENDONYM = {
  chs: '简体中文', gb: '简体中文', sc: '简体中文', zhs: '简体中文', 'zh-cn': '简体中文', 'zh-hans': '简体中文',
  cht: '繁體中文', big5: '繁體中文', tc: '繁體中文', zht: '繁體中文', 'zh-tw': '繁體中文', 'zh-hant': '繁體中文',
  chi: '中文', zho: '中文', zh: '中文',
  eng: 'English', en: 'English',
  jpn: '日本語', ja: '日本語', jp: '日本語',
  kor: '한국어', ko: '한국어',
  fra: 'Français', fre: 'Français', fr: 'Français',
  deu: 'Deutsch', ger: 'Deutsch', de: 'Deutsch',
  spa: 'Español', es: 'Español',
  rus: 'Русский', ru: 'Русский',
  ita: 'Italiano', it: 'Italiano',
  por: 'Português', pt: 'Português',
  ara: 'العربية', ar: 'العربية',
  tha: 'ไทย', th: 'ไทย',
  vie: 'Tiếng Việt', vi: 'Tiếng Việt',
  ind: 'Bahasa Indonesia', id: 'Bahasa Indonesia',
  rum: 'Română', ron: 'Română', ro: 'Română',
};

/** What to call a track. 一条轨该叫什么。 */
export function labelOf(tag, fallback = '') {
  const key = String(tag || '').trim().toLowerCase();
  return ENDONYM[key] || tag || fallback;
}

const BOMS = [
  [[0xef, 0xbb, 0xbf], 'utf-8', 3],
  [[0xff, 0xfe], 'utf-16le', 2],
  [[0xfe, 0xff], 'utf-16be', 2],
];

/**
 * Bytes into characters, for a file that does not say which it used.
 *
 * A subtitle file from before this was settled carries no mark and no declaration -- the one here
 * is Chinese in GBK, written in 2006 -- so the encoding has to be worked out. UTF-8 answers for
 * itself: it is strict enough that text which is not UTF-8 almost never decodes as UTF-8 without
 * an invalid sequence, so it is tried first and believed when it succeeds. After that the
 * candidates are dense enough to accept nearly any bytes without complaint, so which one is tried
 * first is decided by what the file is called -- a name with `cht` in it is more likely Big5 than
 * GBK, and the file next to it named `chs` is the other way round.
 *
 * That is a guess. It is the same guess every player makes, and the name is the only evidence
 * anybody has.
 *
 * 把字节变成字 —— 对一个不说自己用了哪种编码的文件。
 *
 * 一个在这件事定下来之前做的字幕文件,既没有标记也没有声明 ——
 * 这里这个是 2006 年写的、GBK 的中文 —— 所以编码只能推。UTF-8 会为自己作答:
 * 它严格到"不是 UTF-8 的文本几乎不可能不出现非法序列",所以先试它,成了就信它。
 * 在那之后,那些候选一个比一个能收,几乎什么字节都不吭声地接下来 ——
 * 于是先试哪一个,由这个文件叫什么来定:名字里带 cht 的更可能是 Big5 而不是 GBK,
 * 而它旁边那个叫 chs 的正相反。
 *
 * 那是一次猜测。每一个播放器做的都是同一次猜测,而那个名字是任何人手上唯一的证据。
 */
export function readText(bytes, hint = '') {
  for (const [mark, enc, skip] of BOMS) {
    if (mark.every((b, i) => bytes[i] === b)) {
      return new TextDecoder(enc).decode(bytes.subarray(skip));
    }
  }
  const traditional = /cht|big5|zh[-_]?(tw|hk|hant)|繁/i.test(hint);
  const order = traditional
    ? ['utf-8', 'big5', 'gb18030', 'shift_jis', 'euc-kr']
    : ['utf-8', 'gb18030', 'big5', 'shift_jis', 'euc-kr'];
  for (const enc of order) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch { /* not this one */ }
  }
  // Nothing was clean. Windows-1252 maps every byte to something, so this always answers, and
  // what it answers is at least readable where the file is Latin.
  // 没有一个是干净的。windows-1252 把每一个字节都映射到某个东西,所以它总有答复;
  // 而在文件本来就是拉丁文的地方,它的答复至少读得出来。
  return new TextDecoder('windows-1252').decode(bytes);
}

/** Whether this is bitmaps rather than words: a DVD's subtitles are an MPEG stream, and its first
 *  bytes say so. 这是位图而不是字吗:一张 DVD 的字幕是一条 MPEG 流,它开头几个字节就说明了。 */
export function looksBinary(bytes) {
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1) return true;
  // A run of zero bytes is not something any text encoding produces.
  // 一串零字节,不是任何一种文本编码会产出的东西。
  let zeros = 0;
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) if (!bytes[i]) zeros++;
  return zeros > 16;
}

const clock = (s) => {
  // hh:mm:ss,mmm and hh:mm:ss.mmm and h:mm:ss.cc are all in use, and all mean the same thing.
  // hh:mm:ss,mmm、hh:mm:ss.mmm、h:mm:ss.cc 都有人用,而它们说的是同一件事。
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(s);
  if (!m) return null;
  const frac = m[4].length === 2 ? Number(m[4]) * 10 : Number(m[4].padEnd(3, '0'));
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac / 1000;
};

/**
 * The words on an ASS dialogue line, without the stage directions.
 *
 * ASS carries the styling inline, in braces: a colour, a font, a position, a rotation, an
 * animation. None of it survives here, because what survives here goes into the browser's own
 * subtitle rendering, which draws words. Dropping it is visible -- a karaoke line loses its sweep,
 * a sign loses its placement -- and it is the difference between reading the film and not.
 *
 * 一行 ASS 对白上的字,不含那些舞台指示。
 *
 * ASS 把样式内嵌在花括号里:颜色、字体、位置、旋转、动画。这里一样都留不下来,
 * 因为留在这里的东西要交给浏览器自己的字幕渲染,而它画的是字。
 * 丢掉它们是看得见的 —— 一行卡拉 OK 失去它的扫光,一块招牌失去它的位置 ——
 * 而它也是"读得到这部片子"与"读不到"之间的差别。
 */
export function assText(s) {
  return String(s || '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

/**
 * One ASS dialogue line, as far as the text: the fields before it are stepped over, and the text
 * keeps every comma in it.
 *
 * How many fields come first depends on where the line came from, and the two places disagree. In
 * the file it is ten: layer, start, end, style, name, three margins, effect, text. In a Matroska
 * it is nine: the start and end are gone -- the packet carries them -- and a read-order number has
 * been put at the front. Counting the file's ten on a packet takes the first comma out of the
 * words, which reads as a sentence starting a word late.
 *
 * 一行 ASS 对白,取到文本为止:文本之前的字段被跨过去,而文本里的每一个逗号都留着。
 *
 * 前面有多少个字段,取决于这一行是从哪儿来的,而这两处并不一致。在文件里是十个:
 * layer、start、end、style、name、三个边距、effect、text。在 Matroska 里是九个:
 * start 和 end 没了(包自己带着它们),而队首多了一个读取顺序号。
 * 拿文件的十个去数一个包,会从字里切走第一个逗号 —— 读起来像一句话晚了一个词才开始。
 */
export function assDialogue(raw, textAt = 8) {
  const s = String(raw || '');
  let at = -1;
  for (let i = 0; i < textAt; i++) {
    at = s.indexOf(',', at + 1);
    if (at < 0) return assText(s);
  }
  return assText(s.slice(at + 1));
}

/** SubRip and WebVTT, which differ in a header nobody needs and a comma where a full stop goes.
 *  SubRip 与 WebVTT —— 两者的区别是一个没人需要的头,以及一个本该是句点的地方写了逗号。 */
function fromSrt(text) {
  const out = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const from = clock(a);
    const to = clock(b || '');
    if (from === null || to === null) continue;
    const words = lines.slice(at + 1).join('\n').trim();
    if (words) out.push({ from, to, text: words });
  }
  return out;
}

/** ASS and SSA. The Format line says which column is which, because they are not always in the
 *  same order and a file is allowed to say so.
 *  ASS 与 SSA。Format 那一行说明哪一列是什么 —— 因为它们并不总是同一个顺序,
 *  而一个文件是被允许这么说的。 */
function fromAss(text) {
  const out = [];
  let start = 1;
  let end = 2;
  let textAt = 9;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*Format\s*:/i.test(line)) {
      const cols = line.slice(line.indexOf(':') + 1).split(',').map((c) => c.trim().toLowerCase());
      if (cols.includes('text')) {
        start = cols.indexOf('start');
        end = cols.indexOf('end');
        textAt = cols.indexOf('text');
      }
      continue;
    }
    if (!/^\s*Dialogue\s*:/i.test(line)) continue;
    const body = line.slice(line.indexOf(':') + 1);
    const fields = body.split(',');
    const from = clock(fields[start] || '');
    const to = clock(fields[end] || '');
    if (from === null || to === null) continue;
    const words = assDialogue(body, textAt);
    if (words) out.push({ from, to, text: words });
  }
  return out;
}

/**
 * Whatever this file is, as cues.
 *
 * The extension is a hint and the contents are the evidence: a file called .srt that opens with
 * `[Script Info]` is an ASS file somebody renamed, and there are a great many of those.
 *
 * 不管这个文件是什么,都变成一组字幕条目。
 *
 * 扩展名是提示,内容才是证据:一个叫 .srt、开头却是 `[Script Info]` 的文件,
 * 是一个被谁改了名的 ASS 文件 —— 而这样的东西非常多。
 */
export function cuesOf(text, ext = '') {
  const looksAss = /^\s*(\[Script Info\]|\[V4\+? Styles\])/i.test(text) || /^\s*Dialogue\s*:/im.test(text);
  const cues = looksAss || ext === 'ass' || ext === 'ssa' ? fromAss(text) : fromSrt(text);
  cues.sort((a, b) => a.from - b.from);
  return cues;
}

const extOf = (name) => (/\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();
const stem = (name) => String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '');

/**
 * The subtitle files in this folder that belong to this film.
 *
 * They belong to it by being named after it: the film's name without its extension, then whatever
 * says which language this one is, then the subtitle's own extension. A file named exactly after
 * the film with no tag in between belongs to it too and has nothing to say about its language.
 *
 * The tag is what goes in the menu. It is the only thing these files carry -- there is no header
 * in an SRT and no metadata anywhere -- so a folder that names them `chs` and `cht` has told you
 * everything it is going to.
 *
 * 这个文件夹里属于这部片子的字幕文件。
 *
 * 它们靠"以它命名"而属于它:片子的名字去掉扩展名,然后是说明这一个是哪种语言的那一小段,
 * 然后是字幕自己的扩展名。一个与片子同名、中间什么都没有的文件同样属于它,
 * 只是它对自己的语言无话可说。
 *
 * 那一小段就是进菜单的东西。这些文件所携带的只有它 —— SRT 里没有头,任何地方都没有元数据 ——
 * 所以一个把它们命名为 chs 和 cht 的文件夹,已经把它要说的都说了。
 */
export function sidecarsFor(filmName, siblings) {
  const base = stem(filmName).toLowerCase();
  const all = (siblings || []).filter((n) => n.kind === 'file');
  // A .sub with a .idx beside it is a DVD's subtitles: an index and a reel of bitmaps, and the
  // three letters it shares with a text format are a coincidence of the nineteen-nineties. Left
  // out here rather than offered and then found to be empty.
  // 一个旁边还躺着 .idx 的 .sub,是一张 DVD 的字幕:一份索引加一卷位图 ——
  // 而它与某种文本格式共用的那三个字母,是九十年代的一次巧合。
  // 在这里就略过,而不是先端上来、被选中之后才发现里面什么都没有。
  const paired = new Set(all.filter((n) => extOf(n.name) === 'idx').map((n) => stem(n.name).toLowerCase()));
  const out = [];
  for (const n of all) {
    if (n.name === filmName) continue;
    const ext = extOf(n.name);
    if (!SUB_EXTS.has(ext)) continue;
    const low = stem(n.name).toLowerCase();
    if (low !== base && !low.startsWith(base + '.') && !low.startsWith(base + '_') && !low.startsWith(base + '-')) continue;
    if (ext === 'sub' && paired.has(low)) continue;
    // An .idx is the half of a DVD's subtitles that says when; the pictures are in the .sub
    // beside it, and one is no use without the other.
    // 一个 .idx 是一张 DVD 字幕里"说什么时候"的那一半;图画在它旁边的 .sub 里,
    // 而两者缺一都没用。
    let mate = null;
    if (ext === 'idx') {
      mate = all.find((x) => extOf(x.name) === 'sub' && stem(x.name).toLowerCase() === low) || null;
      if (!mate) continue;
    }
    const tag = stem(n.name).slice(base.length).replace(/^[._-]+/, '');
    out.push({ node: n, ext, tag, pictures: ext === 'idx', mate, label: labelOf(tag, ext.toUpperCase()) });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
