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
import { t, tErr } from '../i18n.js';
import { esc, icon, qs, toast, confirmDialog, fmtDateTime } from '../ui.js';
import { store } from '../app.js';
import { openDoc, saveDoc, mergeDoc, draft, refreshThumb } from '../edit/session.js';
import { docClick, ensureCss, loadLibs, mdFragment } from './render.js';

const V = () => encodeURIComponent(store.brand?.version || '');
const MODE_KEY = 'cf_md_mode';
const SPLIT_KEY = 'cf_md_split';
const OUTLINE_KEY = 'cf_md_outline';
const WRAP_KEY = 'cf_md_wrap';
// Token types that occupy source lines and render nothing where they stand. See scanBlocks.
// 占着源码行、却不在它们所站的位置渲染任何东西的 token 类型。见 scanBlocks。
const SKIP_BLOCKS = new Set(['space', 'def', 'footnotes', 'footnote']);

let md = null;   // the open document / 当前打开的文档

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
  if (md?.doc) draft.write(md.doc, md.ta.value);
}

// ---------- Saving ----------
// ---------- 保存 ----------

async function doSave() {
  if (!md || md.saving) return;
  md.saving = true;
  try {
    const text = md.ta.value;
    const r = await saveDoc(md.doc, text, 'text/markdown');
    if (r.status === 'too-big') return toast(t('md_too_big'), true);
    if (r.status === 'unchanged') {
      markDirty(false);
      saveDraft();
      return toast(t('md_unchanged'));
    }
    if (r.status === 'conflict') return conflict();
    markDirty(false);
    saveDraft();
    toast(t('md_saved'));
    // The drive's picture of this file was drawn from the bytes that have just been replaced, and
    // the save wiped the flag that says one exists. Nothing else will come back here to draw
    // another, so it is drawn now -- after the toast, because a thumbnail is not worth keeping
    // anybody waiting for.
    // 网盘里这个文件的那张图,是从刚刚被替换掉的字节画出来的,而这次保存又抹掉了"有缩略图"这个
    // 标记。此后不会再有别人回到这个文件来重画一张,所以就在这里画 ——
    // 放在提示之后,因为一张缩略图不值得让谁多等。
    void refreshThumb(md.doc, text, 'text/markdown', V());
  } catch (e) {
    toast(tErr(e), true);
  } finally {
    md.saving = false;
  }
}

/** Somebody else wrote to this file while it was open here. Nothing has been lost yet -- the
 *  refusal is what makes that true -- so the two sets of edits are put back together rather than
 *  one being chosen over the other.
 *
 *  Where the two of us worked on different parts of the document -- which is nearly always -- the
 *  result is simply both, and all that is left to do is look at it and press save. Where we wrote
 *  over each other, nothing is chosen: the disagreement is written into the text between markers
 *  and the caret is put in the first one.
 *
 *  The merge is not saved automatically. A document that changed under somebody without being
 *  asked is exactly the surprise this whole path exists to prevent.
 *
 *  在这里开着的这段时间里,有别人写过这个文件。目前还什么都没丢 —— 那次拒绝正是这一点的保证 ——
 *  所以两边的改动被重新合到一起,而不是二选一。
 *
 *  当我们俩改的是文档的不同部分时 —— 几乎总是如此 —— 结果就是两份都在,
 *  剩下要做的只是看一眼、按保存。而当我们写在了彼此身上时,什么都不选:
 *  分歧被夹在标记之间写进正文,光标停在第一处。
 *
 *  合并结果不会自动保存。一份没被问过就在人手底下变了的文档,
 *  正是这整条路径存在所要防的那种意外。 */
async function conflict() {
  let merged;
  try {
    merged = await mergeDoc(md.doc, md.ta.value, {
      mine: t('md_merge_mine'),
      theirs: t('md_merge_theirs'),
    });
  } catch {
    // The other side could not be read, so there is nothing to merge with. The old question is
    // still a true one: keep what is here, or go and get what is there.
    // 读不到对方那一份,也就无从合起。旧的那个问题依然成立:留住这里的,还是去取那边的。
    if (await confirmDialog(t('md_conflict'), t('md_conflict_reload'))) {
      md.dirty = false;
      return load(md.id);
    }
    return toast(t('md_conflict_stay'));
  }

  md.ta.value = merged.text;
  markDirty(true);
  saveDraft();
  schedulePaint();
  if (merged.conflicts) {
    // Put the caret where the disagreement is. A merge that says "3 conflicts" and leaves somebody
    // to hunt for them has done the arithmetic and none of the work.
    // 把光标放到分歧所在处。一次只报"3 处冲突"、却把人扔下去自己找的合并,
    // 算完了账,活一点没干。
    md.ta.focus();
    md.ta.setSelectionRange(merged.first, merged.first);
    md.ta.scrollTop = srcYForLine(md.ta.value.slice(0, merged.first).split('\n').length - 1);
    toast(t('md_merged_conflicts', merged.conflicts), true);
  } else {
    toast(t('md_merged'));
  }
}

// ---------- Loading ----------
// ---------- 加载 ----------

async function load(id) {
  md.doc = await openDoc(id);
  md.id = id;
  // Where the document lives, which is what a relative picture is relative to.
  // 文档住在哪儿 —— 一张相对路径的图片,相对的正是这个。
  md.parent = md.doc.parent;
  md.ta.value = md.doc.base;
  qs('#md-name').textContent = md.doc.name;
  document.title = md.doc.name;
  markDirty(false);

  // A draft outliving its tab means the tab did not close on purpose. Offering it is only worth
  // doing when it still says something the file does not.
  // 一份活过了它那个标签页的草稿,意味着那个标签页不是被特意关掉的。
  // 只有当它仍然说着文件所没有的东西时,提出它才有意义。
  const d = draft.read(id);
  if (d && d.text !== md.doc.base) {
    if (await confirmDialog(t('md_draft_ask', fmtDateTime(d.at)), t('md_draft_use'))) {
      md.ta.value = d.text;
      markDirty(true);
    } else {
      draft.clear(id);
    }
  }
  paint();
}

// ---------- Entry ----------
// ---------- 入口 ----------

export async function renderMdEditor(id) {
  // Nothing is painted until the stylesheet is here: the frame and the document are both styled
  // by it, so painting early shows the whole window unstyled for one round trip.
  // 样式表到齐之前什么都不画:框架与文档都由它来排,
  // 所以画早了会让整扇窗有一个往返的时间没有样式。
  await ensureCss();
  document.body.classList.add('md-open');
  const app = qs('#app') || document.body;
  app.innerHTML = shell();
  md = {
    id, gen: 0, dirty: false, saving: false, ta: qs('#md-ta'),
    doc: null, parent: 'root',
    marks: [], outline: [], lineH: 0, lineTops: null, wrap: false,
  };

  md.ta.addEventListener('input', () => {
    markDirty(md.ta.value !== (md.doc?.base ?? ''));
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
  qs('#md-doc').addEventListener('click', (e) => docClick(e, qs('#md-doc'), md.parent));
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
