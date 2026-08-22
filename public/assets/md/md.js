// The Markdown editor: one document, one window, nothing else on screen.
//
// It is deliberately not the preview overlay. A preview is something you glance into and dismiss
// -- it sits on top of the file list, it is sized to be got out of, and everything in it assumes
// you are passing through. Editing is the opposite posture: you arrive on purpose, you stay, and
// the thing you are working on should be the only thing asking for your attention. So this opens
// as its own tab at its own address, and the file list is somewhere you came from rather than
// somewhere still underneath.
//
// Markdown 编辑器:一份文档,一个窗口,屏幕上别无他物。
//
// 它刻意不是那个预览浮层。预览是你瞥一眼就关掉的东西 —— 它压在文件列表上、尺寸是为了便于退出、
// 里面的一切都假定你只是路过。编辑是相反的姿态:你是特意来的、你会待下去,
// 而你正在做的那样东西,应该是唯一向你索取注意力的东西。
// 所以它以自己的地址、在自己的标签页里打开,而文件列表是你来时的出处,不是仍垫在下面的东西。
import { api } from '../api.js';
import { t, tErr } from '../i18n.js';
import { esc, icon, qs, toast, confirmDialog, fmtDateTime } from '../ui.js';
import { store } from '../app.js';
import { announceChange } from '../drive/fsrc.js';

const V = () => encodeURIComponent(store.brand?.version || '');
const DRAFT_KEY = (id) => 'cf_md_draft_' + id;
const MODE_KEY = 'cf_md_mode';
const SPLIT_KEY = 'cf_md_split';
const OUTLINE_KEY = 'cf_md_outline';
const WRAP_KEY = 'cf_md_wrap';
const MAX_BYTES = 2 * 1024 * 1024;
const MD_RE = /\.(md|markdown|mdown|mkd)$/i;
// Token types that occupy source lines and render nothing where they stand. See scanBlocks.
// 占着源码行、却不在它们所站的位置渲染任何东西的 token 类型。见 scanBlocks。
const SKIP_BLOCKS = new Set(['space', 'def', 'footnotes', 'footnote']);

let md = null;   // the open document / 当前打开的文档
let libs = null; // { marked, DOMPurify }

/** Both libraries, fetched once. They are the reason this route is loaded on demand: a person who
 *  never edits a document never pays for them.
 *  两个库,只取一次。它们正是这条路由按需加载的理由:从不编辑文档的人,不为它们付账。 */
async function loadLibs() {
  if (libs) return libs;
  const [m, d, f] = await Promise.all([
    import(`/vendor/marked/marked.esm.js?v=${V()}`),
    import(`/vendor/dompurify/dist/purify.es.mjs?v=${V()}`),
    import(`/vendor/marked-footnote/index.js?v=${V()}`),
  ]);
  m.marked.setOptions({
    gfm: true,
    // GitHub renders a single newline inside a paragraph as a space in a .md file, and as a line
    // break only in comment boxes. This is a file.
    // 在 .md 文件里,GitHub 把段落内的单个换行渲染成空格;只有在评论框里它才是换行。
    // 这里是文件。
    breaks: false,
  });
  // Footnotes are part of the dialect this editor claims to speak, and marked leaves them out of
  // its core. The extension puts them back in the shape GitHub renders them: a superscript number
  // that jumps down, and a note at the foot that jumps back.
  // 脚注属于这个编辑器声称会讲的那套方言,而 marked 的核心里没有它。
  // 这个扩展把它按 GitHub 的样子补回来:一个跳下去的上标数字,和一条能跳回来的注释。
  m.marked.use((f.default || f)());
  libs = { marked: m.marked, purify: d.default || d };
  return libs;
}

const sha256Hex = async (bytes) => {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// ---------- Rendering ----------
// ---------- 渲染 ----------

/** A heading's anchor, by the rule GitHub uses: lower-cased, punctuation dropped, spaces to
 *  hyphens. Documents link to their own headings, and a table of contents written for GitHub
 *  should land in the same places here.
 *  标题的锚点,按 GitHub 的规则:转小写、去标点、空格变连字符。
 *  文档会链接到自己的标题,而一份为 GitHub 写的目录,在这里也该落在同样的位置。 */
function slug(text, seen) {
  const base = String(text).toLowerCase().trim()
    .replace(/[ -⁯⸀-⹿'"!-/:-@[-`{-~]/g, '')
    .replace(/\s+/g, '-');
  let s = base || 'section';
  for (let i = 1; seen.has(s); i++) s = `${base}-${i}`;
  seen.add(s);
  return s;
}

/** Everything the sanitizer handed back, adjusted for where it is about to be shown. This runs on
 *  the DOM rather than on the HTML string on purpose: the string is the sanitizer's business, and
 *  reaching back into it with regular expressions is how a safe pipeline stops being one.
 *  从消毒器手里拿回来的东西,按"它即将出现在哪里"做调整。
 *  这一步刻意作用在 DOM 上而不是 HTML 字符串上:字符串是消毒器的事,
 *  而用正则去回头翻动它,正是一条安全的管线不再安全的方式。 */
function adjust(frag, base) {
  const seen = new Set();
  for (const h of frag.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    // A heading that arrived with an id already means something by it -- the footnote section's
    // label is pointed at by every footnote's aria-describedby, and an author writing inline HTML
    // may have chosen one on purpose. Anchors are for headings that have none.
    // 一个自带 id 到来的标题,是有所指的 —— 脚注区的标签正被每一条脚注的 aria-describedby 指着,
    // 而一个手写内联 HTML 的作者也可能是特意选了那个 id。锚点是给没有 id 的标题准备的。
    if (h.getAttribute('id')) continue;
    h.id = slug(h.textContent || '', seen);
  }
  for (const a of frag.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    // The same three kinds as a picture, and the same rule: beside or below, never above. What
    // differs is what happens on the way -- a link is followed rather than displayed, so where it
    // leads is settled when somebody clicks it, not now. See onDocClick.
    // 与图片是同样的三类,规则也相同:身旁或之下,绝不向上。
    // 不同的是路上发生的事 —— 链接是被跟随而不是被显示的,
    // 所以它通向哪里,在有人点它的那一刻才见分晓,不是现在。见 onDocClick。
    if (base && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) {
      a.setAttribute('href', `/api/drive/rel?base=${encodeURIComponent(base)}&p=${encodeURIComponent(href)}`);
      a.setAttribute('data-rel', href);
      continue;
    }
    if (/^https?:/i.test(href)) {
      // Somebody else's page, opened beside this one rather than instead of it -- there is
      // unsaved work here. noopener because the page it opens must not be able to reach back.
      // 别人的页面,开在这一页旁边而不是取代它 —— 这里有没保存的东西。
      // noopener 是因为被打开的那一页不能有办法反过来够到这一页。
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
  for (const img of frag.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') || '';
    // Three kinds of address, and each is somebody else's job.
    //
    // Out on the public web: fetched by us rather than by the reader, so that reading a document
    // does not tell a stranger who is reading it.
    //
    // Written the way a document writes one -- `img/logo.png`, beside or below the file itself --
    // resolved against the folder this document lives in, which is what such a path has always
    // meant and what makes a document written for a repository work here unchanged.
    //
    // Anything else already absolute (a data: picture, a path into this site): left exactly alone.
    // It already says where it is, and improving on that is how a working address gets broken.
    //
    // 三种地址,每一种都是别人的活儿。
    //
    // 在公网上的:由我们去取而不是让读者去取,于是"读一份文档"不会告诉某个陌生人是谁在读。
    //
    // 按文档的写法写的 —— `img/logo.png`,在文件身旁或之下 —— 按这份文档所在的目录解析,
    // 那本来就是这种路径一直以来的含义,也正是"为代码仓库写的文档在这里原样能用"的原因。
    //
    // 其余已经是绝对的(data: 图片、指进本站的路径):原封不动。
    // 它已经说清了自己在哪儿,而"替它说得更好"正是一个本来好用的地址被弄坏的方式。
    if (/^https?:\/\//i.test(src)) {
      img.setAttribute('src', `/api/drive/img?u=${encodeURIComponent(src)}`);
    } else if (base && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src)) {
      img.setAttribute('src', `/api/drive/rel?base=${encodeURIComponent(base)}&p=${encodeURIComponent(src)}`);
    }
    img.setAttribute('loading', 'lazy');
    img.setAttribute('referrerpolicy', 'no-referrer');
  }
  return frag;
}

/** Markdown to a fragment fit to insert. GitHub's dialect passes inline HTML through, so the
 *  sanitizer is not an optional hardening step here -- it is the thing standing between a document
 *  and the page it is being read on, and a document is written by whoever handed you one.
 *  把 Markdown 变成一段可以插入的片段。GitHub 的方言允许内联 HTML 通过,
 *  所以消毒器在这里不是可选的加固 —— 它就是挡在"一份文档"与"正在读它的这一页"之间的那样东西,
 *  而文档的作者,就是把文档递给你的那个人。 */
async function mdFragment(src, base) {
  const { marked, purify } = await loadLibs();
  const html = marked.parse(String(src || ''));
  const frag = purify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    // Task lists come out of GFM as disabled checkboxes, and they are the one input worth keeping.
    // 任务列表在 GFM 里就是一串禁用的复选框,而那是唯一值得留下的 input。
    ADD_ATTR: ['target', 'rel', 'loading', 'referrerpolicy', 'align', 'checked', 'disabled', 'type'],
  });
  return adjust(frag, base);
}

/** Every top-level block of the document, and the source line it starts on.
 *
 *  This one walk answers both of the questions the editor has about structure. The outline is the
 *  headings out of it; the scrolling is all of them. Asking twice would mean two answers that can
 *  disagree, and the whole point of tying the two panes together is that they agree.
 *
 *  文档的每一个顶层块,以及它在源码里起始的行号。
 *
 *  这一次行走同时回答了编辑器关于结构的两个问题:大纲是从中取出标题,滚动用的是全部。
 *  问两遍就意味着有两个可能互相矛盾的答案 —— 而把两个面板系在一起,图的正是它们不矛盾。 */
function scanBlocks(marked, src) {
  const out = [];
  let line = 0;
  for (const tk of marked.lexer(String(src || ''))) {
    const raw = tk.raw || '';
    // Counted, but not marked: these four occupy lines in the source and produce no element of
    // their own where they stand. Blank runs render as nothing. A link definition renders as
    // nothing -- it is consumed by the links that name it. A footnote definition renders at the
    // foot rather than here. And the extension prepends a `footnotes` container to the token list
    // whose section comes out at the very end, so of all the tokens it is the one furthest from
    // where it appears to be.
    //
    // Marking any of them would push every element after it onto the line of the block before,
    // and the two panes would scroll a paragraph apart from each other for the rest of the file.
    //
    // 照数,但不做标记:这四类在源码里占着行,却不在它们所站的位置产出任何元素。
    // 空行什么也不渲染。链接定义什么也不渲染 —— 它被那些引用它的链接吃掉了。
    // 脚注定义渲染在文末而不是此处。而扩展会往 token 流最前面塞一个 `footnotes` 容器,
    // 它的区块却出现在最末尾 —— 在所有 token 里,它离自己看起来所在的位置最远。
    //
    // 给它们中任何一个做标记,都会把其后每个元素推到"前一个块"的行上,
    // 于是两个面板会在这个文件余下的部分里,始终差着一个段落各滚各的。
    if (!SKIP_BLOCKS.has(tk.type)) out.push(line);
    line += (raw.match(/\n/g) || []).length;
  }
  return out;
}

/** Where each marked block sits in the rendered pane, measured rather than assumed. Rebuilt after
 *  every render because a picture that finished loading moves everything below it.
 *  每个带标记的块在渲染面板里的位置,是量出来的而不是算出来的。
 *  每次渲染之后重建,因为一张刚加载完的图片会把它下面的一切都挪走。 */
function marks() {
  const view = qs('.md-viewpane');
  const box = qs('#md-doc');
  if (!view || !box) return [];
  const vr = view.getBoundingClientRect();
  const out = [];
  for (const el of box.children) {
    const l = el.dataset?.line;
    if (l === undefined) continue;
    out.push({ line: +l, top: el.getBoundingClientRect().top - vr.top + view.scrollTop });
  }
  return out;
}

/** Between two marked blocks nothing is known, so the answer is a straight line drawn between what
 *  is known on either side. It is not exact and does not need to be: what a reader wants is the
 *  other pane looking at the same part of the document, not at the same pixel.
 *  两个带标记的块之间一无所知,于是答案就是在两侧已知点之间拉一条直线。
 *  它不精确,也不需要精确:读者想要的是另一个面板正看着文档的同一处,而不是同一个像素。 */
function lerp(list, from, to, v) {
  if (!list.length) return 0;
  if (v <= list[0][from]) return list[0][to];
  for (let i = 1; i < list.length; i++) {
    if (v <= list[i][from]) {
      const a = list[i - 1];
      const b = list[i];
      const span = b[from] - a[from];
      return span > 0 ? a[to] + ((v - a[from]) / span) * (b[to] - a[to]) : a[to];
    }
  }
  return list[list.length - 1][to];
}

/** The y of every source line, measured when the box wraps and computed when it does not.
 *
 *  Without wrapping a line is a row, so line n begins at n row-heights and there is nothing to
 *  measure. Switch wrapping on and that stops being true in the one way that matters: a paragraph
 *  now occupies as many rows as it needs, the count depends on the width of the box, and it
 *  changes when the split is dragged. Multiplying by a row height would then point at a line some
 *  distance from the one meant -- further with every wrapped paragraph above it -- and the two
 *  panes would drift apart down the length of the document.
 *
 *  So when it wraps, the answer is taken from a copy of the text laid out under the same rules and
 *  measured. The copy is hidden and is never typed into; it exists only to be asked where things
 *  ended up.
 *
 *  每一条源码行的 y。折行时靠测量得出,不折行时靠计算。
 *
 *  不折行时,一条行就是一排,于是第 n 行始于 n 个行高处,没有什么可测的。
 *  一旦打开折行,这一点就在最要紧的那个意义上不再成立:一个段落现在要占它需要的那么多排,
 *  排数取决于框有多宽,而且会随分栏被拖动而改变。
 *  这时再拿行高去乘,指到的会是离目标有一段距离的某一行 —— 它上面每多一个折行段落就更远一点 ——
 *  于是两个面板会沿着文档的长度渐行渐远。
 *
 *  所以折行时,答案取自一份按同样规则排布、然后被量过的文本副本。
 *  那份副本是隐藏的,永远不会被输入;它存在的唯一意义,就是被问"东西最后落在哪儿"。 */
function buildLineTops() {
  const mir = qs('#md-mirror');
  if (!md || !mir) return;
  if (!md.wrap) {
    md.lineTops = null;
    return;
  }
  // The width the text actually gets: the box minus its scrollbar. Reading it rather than
  // assuming it is what keeps the copy wrapping where the original wraps.
  // 文本真正拿到的宽度:框宽减去它的滚动条。去读而不是去假设,
  // 正是这份副本在与原件相同的位置折行的原因。
  mir.style.width = md.ta.clientWidth + 'px';
  const rows = md.ta.value.split('\n');
  mir.replaceChildren(...rows.map((line) => {
    const d = document.createElement('div');
    // An empty line is still a line and still has a height; with nothing in it, it would have none.
    // 空行仍然是一行,仍然占一个高度;里面什么都没有的话,它就没有高度了。
    d.textContent = line === '' ? '\u200b' : line;
    return d;
  }));
  md.lineTops = [...mir.children].map((d) => d.offsetTop);
}

const srcYForLine = (line) => {
  const t = md?.lineTops;
  if (!t || !t.length) return line * lineHeight();
  return t[Math.max(0, Math.min(t.length - 1, Math.floor(line)))];
};

const srcLineForY = (y) => {
  const t = md?.lineTops;
  if (!t || !t.length) return y / lineHeight();
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  // Part of the way through a line that wraps counts as part of the way through the line.
  // 走过一条折行行的一部分,就算走过这条行的相应部分。
  const next = lo + 1 < t.length ? t[lo + 1] : t[lo] + lineHeight();
  const span = next - t[lo];
  return lo + (span > 0 ? Math.min(1, Math.max(0, (y - t[lo]) / span)) : 0);
};

const lineHeight = () => {
  if (!md.lineH) {
    const h = parseFloat(getComputedStyle(md.ta).lineHeight);
    md.lineH = Number.isFinite(h) && h > 0 ? h : 20;
  }
  return md.lineH;
};

// One pane moving the other must not move the first one back. The flag is dropped a frame later,
// which is after the scroll it caused has been dispatched.
// 一个面板带动另一个,不能反过来又被带回来。这个标记在一帧之后放下 ——
// 那时它引发的那次滚动已经派发完毕。
let syncing = false;
const releaseSync = () => requestAnimationFrame(() => { syncing = false; });

/** At either end the two panes simply agree, and nothing is interpolated.
 *
 *  The top of a document is its top in both panes -- whatever padding sits above the first block
 *  in one and not the other. The bottom is the bottom, whatever the last block's height leaves
 *  under it. Interpolation there stops a little short of both, and a pane that will not quite
 *  reach the end while the other one has reads as a fault rather than as rounding.
 *
 *  在两端,两个面板直接一致,不做任何插值。
 *
 *  文档的顶就是两边的顶 —— 不管其中一边的首个块之上垫了多少留白而另一边没有。
 *  底就是底,不管最后一个块的高度在它下面剩了多少。
 *  在那里做插值,两头都会差一点点;而"另一边已经到底了,这一边却总也到不了"
 *  读起来是个毛病,不是四舍五入。 */
const EDGE = 2;
function agreeAtEdges(from, to) {
  if (from.scrollTop <= EDGE) {
    to.scrollTop = 0;
    return true;
  }
  if (from.scrollTop >= from.scrollHeight - from.clientHeight - EDGE) {
    to.scrollTop = to.scrollHeight - to.clientHeight;
    return true;
  }
  return false;
}

function syncFromSource() {
  if (syncing || !md?.marks?.length) return;
  const view = qs('.md-viewpane');
  if (!view) return;
  syncing = true;
  if (!agreeAtEdges(md.ta, view)) {
    view.scrollTop = lerp(md.marks, 'line', 'top', srcLineForY(md.ta.scrollTop));
  }
  releaseSync();
  highlightOutline();
}

function syncFromView() {
  if (syncing || !md?.marks?.length) return;
  const view = qs('.md-viewpane');
  if (!view) return;
  syncing = true;
  if (!agreeAtEdges(view, md.ta)) {
    md.ta.scrollTop = srcYForLine(lerp(md.marks, 'top', 'line', view.scrollTop));
  }
  releaseSync();
  highlightOutline();
}

// ---------- Outline ----------
// ---------- 大纲 ----------

function outlineHtml() {
  const items = md?.outline || [];
  if (!items.length) return `<div class="md-onone">${esc(t('md_outline_none'))}</div>`;
  // Indented by depth relative to the document's own shallowest heading, not to h1. A document
  // whose top level is h2 -- which is most documents that carry their title in the file name --
  // would otherwise sit indented as a whole, against nothing.
  // 缩进按"相对于这份文档自己最浅的那一级",而不是相对于 h1。
  // 一份以 h2 起头的文档 —— 也就是把标题放在文件名里的那大多数文档 ——
  // 否则会整体缩进,却没有任何东西与之对齐。
  const top = Math.min(...items.map((h) => h.level));
  return items.map((h, i) => `
    <button class="md-oitem" style="--d:${h.level - top}" data-oi="${i}" title="${esc(h.text)}"
      >${esc(h.text)}</button>`).join('');
}

function paintOutline() {
  const box = qs('#md-outline');
  if (box) box.innerHTML = outlineHtml();
  highlightOutline();
}

/** Which section is being looked at. The answer is the last heading at or above the top of the
 *  view, which is the same rule a reader uses without thinking about it.
 *  正在看的是哪一节。答案是"位于视口顶端或其上方的最后一个标题" ——
 *  这也正是读者不假思索时用的那条规则。 */
function highlightOutline() {
  const box = qs('#md-outline');
  if (!box || !md?.outline?.length) return;
  const view = qs('.md-viewpane');
  const y = view ? view.scrollTop : 0;
  let at = 0;
  for (let i = 0; i < md.outline.length; i++) {
    if (md.outline[i].top <= y + 8) at = i;
  }
  for (const b of box.querySelectorAll('.md-oitem')) {
    b.classList.toggle('on', +b.dataset.oi === at);
  }
}

function gotoOutline(i) {
  const h = md?.outline?.[i];
  if (!h) return;
  syncing = true;
  const view = qs('.md-viewpane');
  if (view) view.scrollTop = h.top;
  md.ta.scrollTop = srcYForLine(h.line);
  releaseSync();
  highlightOutline();

  // Going to a section means going there to write. The caret lands at the end of the heading's
  // own text -- past the hashes, before any trailing space -- which is where somebody who came
  // here to add a paragraph under this heading would have had to click anyway.
  // 去到一个小节,是去那里写东西。光标落在这个标题自己文字的末尾 ——
  // 越过那些井号,停在尾随空格之前 —— 而那正是一个"来这儿在这个标题下加一段"的人,
  // 本来无论如何都得点一下的位置。
  const rows = md.ta.value.split('\n');
  let at = 0;
  for (let k = 0; k < h.line && k < rows.length; k++) at += rows[k].length + 1;
  at += (rows[h.line] || '').replace(/\s+$/, '').length;
  md.ta.focus();
  md.ta.setSelectionRange(at, at);
  // Focusing scrolls the caret into view on its own terms; put the box back where the outline
  // meant to put it.
  // 聚焦会按浏览器自己的想法把光标滚进视野;把框放回大纲想让它待的地方。
  md.ta.scrollTop = srcYForLine(h.line);
}

// ---------- The window ----------
// ---------- 窗口 ----------

function shell() {
  const mode = localStorage.getItem(MODE_KEY) || 'split';
  return `
  <div class="md-app mode-${esc(mode)}">
    <div class="md-head">
      <span class="md-name" id="md-name"></span>
      <span class="md-dot" id="md-dot" title=""></span>
      <span class="md-sp"></span>
      <wa-button class="icon" appearance="plain" id="md-otoggle" aria-label="${esc(t('md_outline'))}"
        title="${esc(t('md_outline'))}">${icon('outline', 18)}</wa-button>
      <wa-button class="icon" appearance="plain" id="md-wtoggle" aria-label="${esc(t('md_wrap'))}"
        title="${esc(t('md_wrap'))}">${icon('wrapText', 18)}</wa-button>
      <div class="md-seg" id="md-seg">
        <button data-mode="src">${esc(t('md_mode_src'))}</button>
        <button data-mode="split">${esc(t('md_mode_split'))}</button>
        <button data-mode="view">${esc(t('md_mode_view'))}</button>
      </div>
      <wa-button size="small" variant="brand" id="md-save">${esc(t('md_save'))}</wa-button>
    </div>
    <div class="md-body" id="md-body">
      <nav class="md-outline" id="md-outline"></nav>
      <div class="md-panes" id="md-panes">
        <div class="md-srcpane">
          <textarea id="md-ta" spellcheck="false" wrap="off"></textarea>
          <div class="md-mirror" id="md-mirror" aria-hidden="true"></div>
        </div>
        <div class="md-gutter" id="md-gutter"></div>
        <div class="md-viewpane"><article class="md-doc" id="md-doc"></article></div>
      </div>
    </div>
  </div>`;
}

/** Render the preview, but never more often than a person can read. Parsing and sanitising a long
 *  document on every keystroke turns typing into something that stutters.
 *  渲染预览,但绝不比人读得过来更频繁。每敲一个键就解析并消毒一遍长文档,
 *  会让打字这件事变得一顿一顿的。 */
let paintTimer = null;
function schedulePaint() {
  clearTimeout(paintTimer);
  paintTimer = setTimeout(paint, 180);
}

async function paint() {
  if (!md) return;
  const box = qs('#md-doc');
  if (!box) return;
  const gen = ++md.gen;
  const src = md.ta.value;
  const { marked } = await loadLibs();
  const frag = await mdFragment(src, md.parent);
  if (!md || md.gen !== gen || !box.isConnected) return;

  // Each rendered block, given the source line its token began on. The two lists line up because
  // one top-level token becomes one top-level element; where they stop lining up -- a fragment of
  // raw HTML that came apart, an element the sanitiser removed -- the tail simply goes untagged,
  // and scrolling there falls back to the last thing that was known.
  // 每个渲染出的块,配上它那个 token 起始的源码行号。两份列表能对齐,是因为一个顶层 token
  // 变成一个顶层元素;而在它们对不齐的地方 —— 一段散开的裸 HTML、一个被消毒器移走的元素 ——
  // 尾巴就是没有标记,那里的滚动退回到"最后一处已知"。
  const lines = scanBlocks(marked, src);
  let i = 0;
  for (const el of frag.children) {
    if (i < lines.length) el.dataset.line = String(lines[i++]);
  }
  box.replaceChildren(frag);

  md.marks = marks();
  buildLineTops();
  const view = qs('.md-viewpane');
  const vr = view?.getBoundingClientRect();
  md.outline = [];
  for (const el of box.children) {
    if (!/^H[1-6]$/.test(el.tagName)) continue;
    md.outline.push({
      level: +el.tagName[1],
      text: (el.textContent || '').trim(),
      line: +(el.dataset.line || 0),
      top: vr ? el.getBoundingClientRect().top - vr.top + view.scrollTop : 0,
    });
  }
  paintOutline();
}

function markDirty(on) {
  if (!md) return;
  md.dirty = on;
  const dot = qs('#md-dot');
  if (dot) {
    dot.classList.toggle('on', on);
    dot.title = on ? t('md_unsaved') : '';
  }
}

/** What is in the box, kept where a crashed tab cannot take it. The draft is per document and is
 *  dropped the moment its text matches what the server holds -- a draft that agrees with the file
 *  is not a draft, it is clutter that will offer to restore nothing.
 *  框里的东西,存在一个崩掉的标签页带不走的地方。草稿按文档存,
 *  一旦它的文本与服务端所存一致就丢弃 —— 与文件一致的草稿不是草稿,
 *  只是一堆将来会提出"要不要恢复"却什么也恢复不了的杂物。 */
function saveDraft() {
  if (!md) return;
  try {
    if (md.ta.value === md.saved) localStorage.removeItem(DRAFT_KEY(md.id));
    else localStorage.setItem(DRAFT_KEY(md.id), JSON.stringify({ text: md.ta.value, at: Date.now() }));
  } catch { /* a full quota is not worth an error message here / 配额满了,不值得在这里报错 */ }
}

// ---------- Saving ----------
// ---------- 保存 ----------

async function doSave() {
  if (!md || md.saving) return;
  const text = md.ta.value;
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_BYTES) return toast(t('md_too_big'), true);
  const hash = await sha256Hex(bytes);
  // The same comparison the uploader makes, for the same reason: a save that changes nothing
  // should not cost an upload and should not leave a version that says nothing.
  // 与上传器做的是同一个比较,理由也相同:什么都没改的一次保存,
  // 不该花掉一次上传,也不该留下一个什么都没说的版本。
  if (hash === md.hash) {
    markDirty(false);
    saveDraft();
    return toast(t('md_unchanged'));
  }
  md.saving = true;
  try {
    const q = `node=${encodeURIComponent(md.id)}&mime=${encodeURIComponent('text/markdown')}&hash=${hash}`;
    const headers = { 'Content-Type': 'text/markdown' };
    // The version this text was written on top of. Without it the save is a blind overwrite; with
    // it, a save that would bury somebody else's is refused instead of performed.
    // 这段文本是写在哪一版之上的。不带它,这次保存就是一次盲写;
    // 带上它,一次会埋掉别人成果的保存,会被拒绝而不是被执行。
    if (md.etag) headers['If-Match'] = `"${md.etag}"`;
    const res = await fetch(`/api/drive/upload?${q}`, { method: 'POST', headers, body: bytes });
    if (res.status === 412) return conflict();
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'e_request_failed');
    md.saved = text;
    md.hash = hash;
    md.etag = data?.ver_head || `${md.id}-${data?.updated_at || Date.now()}`;
    markDirty(false);
    saveDraft();
    toast(t('md_saved'));
    // Any file list open in another tab is still stamping this file's address with the moment it
    // last knew about. Told now, it can go and find out; left alone, it goes on serving the copy
    // behind the old stamp until somebody thinks to reload it.
    // 别的标签页里开着的文件列表,仍在用"它最后一次知道的那一刻"给这个文件的地址盖戳。
    // 现在告诉它,它就能去问个明白;不告诉,它会继续供出旧戳背后的那份副本,
    // 直到有人想起来刷新一下。
    // Everything a file list needs in order to be right about this file again, taken from the
    // answer the save just gave. A version bumps the count it shows; a file that keeps none has
    // none to bump.
    // 一份文件列表要想重新对这个文件说得没错,所需要的一切 —— 全部取自这次保存刚给出的答复。
    // 一个新版本会让它显示的计数加一;不保留历史的文件没有计数可加。
    announceChange(md.id, {
      updated_at: data?.updated_at || Date.now(),
      ver_head: data?.ver_head || null,
      size: bytes.byteLength,
      thumb: false,
      bumpVersions: !!data?.ver_head,
    });
    // The drive's picture of this file was drawn from the bytes that have just been replaced, and
    // the save wiped the flag that says one exists. Nothing else will come back to this file to
    // make another, so it is made here -- after the toast, because a thumbnail is not worth
    // keeping anybody waiting for.
    // 网盘里这个文件的那张图,是从刚刚被替换掉的字节画出来的,而这次保存又抹掉了"存在缩略图"
    // 的标记。此后不会再有别人回到这个文件来重画一张,所以就在这里画 ——
    // 放在提示之后,因为一张缩略图不值得让谁多等。
    void refreshThumb(text);
  } catch (e) {
    toast(tErr(e), true);
  } finally {
    md.saving = false;
  }
}

/** Redraw the little picture of this document. It is generated the same way the uploader
 *  generates one -- the same module, from the same bytes -- so a document that was edited here
 *  looks in the file list exactly as it would have if it had been uploaded.
 *  重画这份文档的那张小图。它的生成方式与上传器完全相同 —— 同一个模块,同一份字节 ——
 *  于是一份在这里编辑过的文档,在文件列表里的样子,与它被上传上来时应有的样子一模一样。 */
async function refreshThumb(text) {
  try {
    const mod = await import(`/assets/drive/thumb.js?v=${V()}`);
    const blob = await mod.makeThumb(new File([text], md.name || 'doc.md', { type: 'text/markdown' }));
    if (!blob || !md) return;
    await fetch(`/api/drive/files/${encodeURIComponent(md.id)}/thumb`, { method: 'POST', body: blob });
    announceChange(md.id, { thumb: true });
  } catch {
    // A missing thumbnail is a missing thumbnail. It is not worth a message, and it is certainly
    // not worth casting doubt on a save that succeeded.
    // 少一张缩略图就是少一张缩略图。不值得为它弹一句话,更不值得让一次已经成功的保存显得可疑。
  }
}

/** Somebody else wrote to this file while it was open here. Nothing has been lost yet -- the
 *  refusal is what makes that true -- so the choice is offered before anything is decided.
 *  在这里开着的这段时间里,有别人写过这个文件。目前还什么都没丢 —— 那次拒绝正是这一点的保证 ——
 *  所以在任何事被决定之前,先把选择交出去。 */
async function conflict() {
  if (await confirmDialog(t('md_conflict'), t('md_conflict_reload'))) {
    md.dirty = false;             // the draft still holds this text / 草稿里仍然存着这段文本
    return load(md.id);
  }
  // Staying is not overwriting: the text is still here, the file is still theirs, and the next
  // save will be refused again until the base is refreshed on purpose.
  // 留下不等于覆盖:文本还在这儿,文件还是他们的,
  // 而在基准被特意刷新之前,下一次保存仍会被拒绝。
  toast(t('md_conflict_stay'));
}

// ---------- Loading ----------
// ---------- 加载 ----------

async function load(id) {
  const meta = await api('GET', `/api/drive/nodes/${encodeURIComponent(id)}/meta`);
  const node = meta.node;
  if (node.kind !== 'file') throw new Error('e_drive_not_file');
  if ((node.size || 0) > MAX_BYTES) throw new Error('e_md_too_big');
  // A file that keeps history names its version, and a new version is a new address. A file that
  // keeps none has no version to name -- but it still changes, and without something moving in
  // the address the browser answers the next request out of the copy it already has. An hour of
  // that is a save that took, followed by an editor that reopens showing what was replaced, which
  // is indistinguishable from a save that did not take.
  //
  // Its modification time is the token in that case: it moves every time the bytes do, which is
  // the whole of what a cache needs to be told.
  //
  // 保留历史的文件用版本指名自己,而新版本就是新地址。不保留历史的文件没有版本可指名 ——
  // 但它照样会变,而地址里若没有任何东西随之移动,浏览器下一次就用它手上那份副本作答。
  // 这样过一个小时,就是"保存明明成功了,编辑器再打开却显示着被替换掉的东西" ——
  // 而这与"保存根本没成功"从外面看毫无分别。
  //
  // 这种情况下,它的修改时间就是那个令牌:字节每变一次它就移动一次,
  // 而这正是一个缓存需要被告知的全部。
  const stamp = node.ver_head || node.updated_at || '';
  const url = `/api/drive/files/${encodeURIComponent(id)}/dl?inline=1`
    + (stamp ? `&v=${encodeURIComponent(stamp)}` : '');
  const r = await fetch(url);
  if (!r.ok) throw new Error('e_drive_not_found');
  const buf = await r.arrayBuffer();
  const text = new TextDecoder('utf-8').decode(buf);

  md.id = id;
  md.name = node.name;
  // Where the document lives, which is what a relative picture is relative to.
  // 文档住在哪儿 —— 一张相对路径的图片,相对的正是这个。
  md.parent = node.parent_id || 'root';
  md.saved = text;
  md.hash = await sha256Hex(new Uint8Array(buf));
  md.etag = node.ver_head || `${node.id}-${node.updated_at}`;
  md.ta.value = text;
  qs('#md-name').textContent = node.name;
  document.title = node.name;
  markDirty(false);

  // A draft outliving its tab means the tab did not close on purpose. Offering it is only worth
  // doing when it still says something the file does not.
  // 一份活过了它那个标签页的草稿,意味着那个标签页不是被特意关掉的。
  // 只有当它仍然说着文件所没有的东西时,提出它才有意义。
  try {
    const raw = localStorage.getItem(DRAFT_KEY(id));
    const d = raw ? JSON.parse(raw) : null;
    if (d && typeof d.text === 'string' && d.text !== text) {
      if (await confirmDialog(t('md_draft_ask', fmtDateTime(d.at)), t('md_draft_use'))) {
        md.ta.value = d.text;
        markDirty(true);
      } else {
        localStorage.removeItem(DRAFT_KEY(id));
      }
    }
  } catch { /* an unreadable draft is no draft / 读不出来的草稿就等于没有草稿 */ }
  paint();
}

// ---------- Entry ----------
// ---------- 入口 ----------

function ensureCss() {
  if (qs('link[href^="/assets/md/md.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/assets/md/md.css?v=' + V();
  document.head.appendChild(l);
}

export async function renderMdEditor(id) {
  ensureCss();
  document.body.classList.add('md-open');
  const app = qs('#app') || document.body;
  app.innerHTML = shell();
  md = {
    id, gen: 0, dirty: false, saving: false, ta: qs('#md-ta'),
    saved: '', hash: '', etag: '', name: '', parent: 'root',
    marks: [], outline: [], lineH: 0, lineTops: null, wrap: false,
  };

  md.ta.addEventListener('input', () => {
    markDirty(md.ta.value !== md.saved);
    schedulePaint();
    saveDraft();
  });
  // Tab belongs to the document here, not to the next control: a Markdown file is full of
  // indented blocks, and a key that leaves the box is a key that cannot indent one.
  // 在这里,Tab 属于文档而不是下一个控件:Markdown 文件里满是缩进的块,
  // 而一个会跳出输入框的键,是一个没法用来缩进的键。
  md.ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: n, value: v } = md.ta;
      md.ta.value = v.slice(0, s) + '  ' + v.slice(n);
      md.ta.selectionStart = md.ta.selectionEnd = s + 2;
      md.ta.dispatchEvent(new Event('input'));
    }
  });

  qs('#md-save').addEventListener('click', doSave);
  qs('#md-doc').addEventListener('click', onDocClick);
  qs('#md-outline').addEventListener('click', (e) => {
    const b = e.target.closest('[data-oi]');
    if (b) gotoOutline(+b.dataset.oi);
  });
  qs('#md-otoggle').addEventListener('click', () => {
    const app = qs('.md-app');
    const off = app.classList.toggle('no-outline');
    localStorage.setItem(OUTLINE_KEY, off ? '0' : '1');
  });
  if (localStorage.getItem(OUTLINE_KEY) === '0') qs('.md-app').classList.add('no-outline');
  qs('#md-wtoggle').addEventListener('click', () => setWrap(!md.wrap));
  setWrap(localStorage.getItem(WRAP_KEY) === '1');
  md.ta.addEventListener('scroll', syncFromSource, { passive: true });
  qs('.md-viewpane').addEventListener('scroll', syncFromView, { passive: true });
  // A picture that arrives late moves everything under it, so what was measured before it landed
  // is no longer where things are.
  // 一张迟到的图片会把它底下的一切挪走,于是在它落地之前量出来的位置,已经不是东西所在的位置。
  qs('#md-doc').addEventListener('load', () => {
    if (!md) return;
    md.marks = marks();
  }, true);
  // Both maps are measurements of a particular width. Change the width and they describe a layout
  // that no longer exists.
  // 两份映射都是在某个特定宽度下量出来的。宽度一变,它们描述的就是一个已经不存在的排布。
  window.addEventListener('resize', onResize);
  qs('#md-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    const mode = b.dataset.mode;
    localStorage.setItem(MODE_KEY, mode);
    // Swap only the mode. Rewriting the whole class list would take the outline and the wrap
    // setting with it -- three switches that have nothing to do with each other, and only one of
    // them was touched.
    // 只换模式那一个。整个重写类名会把大纲与折行一并带走 ——
    // 三个互不相干的开关,而被碰的只有其中一个。
    const app = qs('.md-app');
    app.classList.remove('mode-src', 'mode-split', 'mode-view');
    app.classList.add('mode-' + mode);
    if (mode !== 'src') paint();
  });
  bindGutter();

  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onLeave);
  window.addEventListener('hashchange', onHash);

  try {
    await load(id);
  } catch (e) {
    qs('#md-doc').innerHTML = `<p class="md-err">${esc(tErr(e))}</p>`;
  }
  applySplit();
}

function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    doSave();
  }
}

// The browser decides the wording; all it wants from us is that there is something to lose.
// 措辞由浏览器决定;它向我们要的只是"确有东西可失去"这一件事。
function onLeave(e) {
  if (!md?.dirty) return;
  e.preventDefault();
  e.returnValue = '';
}

/** Soft wrap, which is a way of looking at the source rather than anything about the file. Turning
 *  it on changes what a line is on screen without changing what a line is in the text, so the map
 *  from lines to positions has to be rebuilt -- see buildLineTops for why it cannot simply be
 *  multiplied out any more.
 *  软折行。它是看待源码的一种方式,与文件本身无关。打开它,会改变"屏幕上的一行"是什么,
 *  却不改变"文本里的一行"是什么 —— 所以从行到位置的那份映射必须重建。
 *  为什么它不能再靠乘法算出来,见 buildLineTops。 */
function setWrap(on) {
  if (!md) return;
  md.wrap = !!on;
  qs('.md-app')?.classList.toggle('wrap', md.wrap);
  md.ta.setAttribute('wrap', md.wrap ? 'soft' : 'off');
  localStorage.setItem(WRAP_KEY, md.wrap ? '1' : '0');
  qs('#md-wtoggle')?.classList.toggle('on', md.wrap);
  buildLineTops();
}

let resizeTimer = null;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!md) return;
    buildLineTops();
    md.marks = marks();
  }, 150);
}

/** The split, dragged and remembered. Stored as a percentage so it survives a window that changes
 *  size between visits.
 *  分栏,可拖动、会记住。按百分比存,于是两次访问之间窗口改了大小,它依然成立。 */
function applySplit() {
  const pct = Math.min(80, Math.max(20, parseFloat(localStorage.getItem(SPLIT_KEY) || '50')));
  const panes = qs('#md-panes');
  if (panes) panes.style.setProperty('--md-split', pct + '%');
}

function bindGutter() {
  const g = qs('#md-gutter');
  const body = qs('#md-panes');
  if (!g || !body) return;
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { g.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      const r = body.getBoundingClientRect();
      const pct = Math.min(80, Math.max(20, ((ev.clientX - r.left) / r.width) * 100));
      body.style.setProperty('--md-split', pct + '%');
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      const cur = body.style.getPropertyValue('--md-split');
      if (cur) localStorage.setItem(SPLIT_KEY, parseFloat(cur));
      // A narrower box wraps sooner, so where every line sits has just changed.
      // 框窄了就更早折行,于是每条行所在的位置刚刚全变了。
      buildLineTops();
      if (md) md.marks = marks();
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  });
}

/** Leaving for another route. The listeners are window-level, so they have to be taken back or
 *  they would guard a page this editor no longer occupies.
 *  离开去别的路由。那些监听挂在 window 上,必须收回 ——
 *  否则它们会去守卫一个这个编辑器已经不在的页面。 */
function onHash() {
  // Only a route counts as leaving. A document is full of addresses that begin with a hash --
  // every footnote, every heading link -- and treating one of those as navigation would tear the
  // editor down because somebody clicked a footnote.
  // 只有路由才算离开。一份文档里满是以井号开头的地址 —— 每一条脚注、每一个标题链接 ——
  // 把其中之一当成导航,会让编辑器因为有人点了个脚注而被拆掉。
  const h = location.hash;
  if (h.startsWith('#/') && !h.startsWith('#/md/')) closeMdEditor();
}

/** A click inside the rendered document. Three kinds of link end up here and each leaves
 *  differently -- or does not leave at all.
 *  在渲染出的文档里的一次点击。三种链接会走到这儿,每一种的离开方式都不同 —— 或者根本不离开。 */
async function onDocClick(e) {
  const a = e.target.closest?.('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  // An anchor within the document scrolls to its target and leaves the address bar alone. The
  // address here names the document being edited; letting a footnote overwrite it would mean a
  // reload lands somewhere else entirely.
  // 文档内部的锚点滚到它的目标,并且不碰地址栏。这里的地址指名的是"正在编辑的那份文档";
  // 让一条脚注把它覆盖掉,意味着刷新之后会落到完全不相干的地方。
  if (href.startsWith('#')) {
    e.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const el = id && qs('#md-doc')?.querySelector(`[id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const rel = a.getAttribute('data-rel');
  // An outside link already carries target=_blank and needs nothing from here.
  // 外部链接本来就带着 target=_blank,不需要这里做什么。
  if (!rel || !md) return;
  e.preventDefault();
  try {
    const r = await api('GET', `/api/drive/rel?base=${encodeURIComponent(md.parent)}`
      + `&p=${encodeURIComponent(rel)}&meta=1`);
    const node = r?.node;
    if (!node) throw new Error('e_drive_not_found');
    // Another document opens where documents are written. Anything else opens as itself.
    // 另一份文档,在"写文档的地方"打开。别的东西,以它自己的样子打开。
    window.open(MD_RE.test(node.name) ? `${location.pathname}#/md/${encodeURIComponent(node.id)}` : href,
      '_blank', 'noopener');
  } catch (err) {
    toast(tErr(err), true);
  }
}

export function closeMdEditor() {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', onLeave);
  window.removeEventListener('hashchange', onHash);
  window.removeEventListener('resize', onResize);
  clearTimeout(resizeTimer);
  clearTimeout(paintTimer);
  document.body.classList.remove('md-open');
  md = null;
}
