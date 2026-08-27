// Which language the interface speaks, and the function that speaks it.
//
// The words themselves are not here. There are nine sets of them and every reader uses one, so
// keeping all nine in this file meant sending half a megabyte to deliver fifty kilobytes' worth
// -- on a phone, more bytes than everything else on the page put together. They live in
// ./i18n/<lang>.js now and the one in use is fetched on demand.
//
// That makes the dictionary arrive a moment after this module does, which is the one thing every
// caller has to know about. dictReady() is the promise it arrives on; route() waits on it before
// drawing anything, and it is already in flight by then because the fetch starts at the bottom of
// this file rather than at the first call. A t() that somehow runs before it lands returns the
// key -- visibly wrong rather than quietly English.
//
// 界面说哪种语言,以及说话的那个函数。
//
// 词本身不在这里。词有九套而每个读者用一套,把九套都放在这个文件里,
// 就是为了送到五十千字节而发出去半兆 —— 在手机上,这比整页其余东西加起来还多。
// 它们现在住在 ./i18n/<语言>.js 里,用到哪套取哪套。
//
// 这意味着词典比这个模块晚到一步,而这是每个调用方都必须知道的唯一一件事。
// dictReady() 就是它到达的那个承诺;route() 在画任何东西之前等它,
// 而那时它早已在路上 —— 因为取词典是在本文件末尾发起的,不是等到第一次调用。
// 万一有个 t() 抢在它落地之前跑了,返回的是键名 —— 明显地错,而不是悄悄地变成英文。

export const LANG_OPTIONS = [
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['ru', 'Русский'],
];

const LANGS = new Set(LANG_OPTIONS.map(([code]) => code));

function detectLang() {
  const saved = localStorage.getItem('cfmail_lang');
  if (saved && LANGS.has(saved)) return saved;
  const nav = (navigator.language || 'en').toLowerCase();
  if (nav.startsWith('zh')) return nav.includes('tw') || nav.includes('hk') || nav.includes('hant') ? 'zh-TW' : 'zh-CN';
  for (const [code] of LANG_OPTIONS) {
    if (nav.startsWith(code.toLowerCase().slice(0, 2)) && code !== 'zh-CN' && code !== 'zh-TW') return code;
  }
  return 'en';
}

let current = detectLang();
let dict = null;      // the words in use / 正在用的那套词
let dictLang = null;  // which language they are / 那套词是哪种语言
let pending = null;   // a fetch in flight, and for what / 在途的取词,以及取的是哪种

/**
 * The words for the language in force, fetched if they are not here yet.
 *
 * Safe to call as often as you like: an arrival already in hand resolves at once, and a fetch
 * already in flight for the same language is joined rather than started again. A language
 * switched away from mid-fetch loses the race on purpose -- the reply is dropped instead of
 * overwriting the words for the language somebody has since chosen.
 *
 * A fetch that fails leaves the previous words in place. That is the better of the two bad
 * outcomes: the interface goes on speaking the language it was speaking, rather than turning
 * into a page of key names because one file did not arrive.
 *
 * 当前生效语言的那套词,还没到就去取。
 *
 * 想调多少次都行:已经在手上的立刻兑现,同一种语言已经在途的会合流而不是再发一次。
 * 取到一半又切走的语言会故意输掉这场竞速 —— 那份答复被丢弃,
 * 而不是去覆盖某人此后选定的那种语言的词。
 *
 * 取失败则原地保留上一套词。这是两个坏结果里较好的那个:界面继续说它本来在说的语言,
 * 而不是因为一个文件没到就变成一页键名。
 */
export function dictReady() {
  const want = current;
  if (dictLang === want) return Promise.resolve(dict);
  if (pending && pending.lang === want) return pending.p;
  const p = import(`./i18n/${want}.js`)
    .then((m) => {
      if (current !== want) return dict;   // 期间又切了,让后来的那次说了算
      dict = m.default;
      dictLang = want;
      return dict;
    })
    .catch(() => dict);                    // 取不到就维持现状
  pending = { lang: want, p };
  return p;
}

export function lang() {
  return current;
}

/** `persist` is what separates a choice from a borrowing. The public share page renders in the
 *  sharer's language, but that is this one page speaking, not the visitor changing their mind --
 *  writing it down would leave a stranger's link having reset the visitor's own interface.
 *  Returns the language in effect before the call, so a borrower can hand it back. The words
 *  themselves follow a moment later; await dictReady() before drawing with them.
 *  persist 区分的是"选择"与"借用"。公开分享页用分享者的语言渲染,但那是这一个页面在说话,
 *  不是访问者改了主意 —— 若记下来,一条陌生人的链接就把访问者自己的界面语言改掉了。
 *  返回调用前生效的语言,以便借用者归还。词本身稍后才到;要用它们画东西,先 await dictReady()。 */
export function setLang(l, persist = true) {
  const prev = current;
  if (!LANGS.has(l)) return prev;
  current = l;
  if (persist) localStorage.setItem('cfmail_lang', l);
  void dictReady();
  return prev;
}

export function t(key, ...args) {
  let s = dict?.[key] ?? key;
  for (let i = 0; i < args.length; i++) s = s.replaceAll(`{${i}}`, String(args[i]));
  return s;
}

/**
 * Render a server error. The API answers with { error: 'e_*', args: [...] } and never with
 * prose, so this is where a code becomes a sentence. An argument may itself be a code (a
 * nested cause) and gets translated too; anything a dictionary does not know -- a message
 * quoted verbatim from a sending provider, say -- passes through unchanged. A code we have
 * no entry for would otherwise surface as raw `e_something`, so fall back to a generic line.
 *
 * 渲染服务端错误。API 只回 { error: 'e_*', args: [...] },从不回句子,所以"码变人话"就发生在这里。
 * 参数本身也可能是个码(嵌套原因),照样翻译;词典里没有的(比如发信通道原样吐回来的报错)原样透出。
 * 万一遇到没有词条的码,直接显示 `e_xxx` 太难看,退回一句通用提示。
 */
export function tErr(code, args = []) {
  if (!code) return t('e_generic');
  const vals = args.map((a) => (typeof a === 'string' && /^e_[a-z0-9_]+$/.test(a) ? t(a) : a));
  if (!dict || !(code in dict)) return t('e_generic');
  // A placeholder nobody filled must not reach the screen. It happens when an error is thrown
  // from a path that does not know the value -- "cannot play {0} here" with the {0} showing is
  // a message about the software, not about the file. The slot goes, along with the space that
  // was holding a seat for it.
  // 没人来填的占位符不许上屏。这发生在"抛错的那条路并不知道那个值"的时候 ——
  // 「放不了 {0} 编码的声音」连着 {0} 一起亮出来,说的就成了软件自己,而不是那个文件。
  // 空槽拿掉,连同为它占着座的那个空格。
  return t(code, ...vals).replace(/ ?\{\d+\} ?/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Diagnostics that were stored rather than returned (outbox.last_error). Ours carry a marker
 * and get translated; text that came straight from a provider is shown as it arrived.
 * 存下来而非直接返回的诊断信息(outbox.last_error)。我们自己写的带标记,翻译;
 * 发信通道原样返回的,原样显示。
 */
export function tStored(s) {
  if (!s || s[0] !== '\u0001') return s || '';
  const [code, ...args] = s.slice(1).split('\u001f');
  return tErr(code, args);
}

// Start fetching now rather than at the first t(). Whoever imports this module is on their way to
// drawing something, and the words have a network round trip to make; beginning it here overlaps
// that trip with everything else the page is already doing.
// 现在就开始取,而不是等到第一次 t()。会 import 这个模块的人,正在去画点什么的路上,
// 而那些词要走一趟网络;在这里就出发,这一趟便与页面此刻正在做的其余一切重叠起来。
void dictReady();
