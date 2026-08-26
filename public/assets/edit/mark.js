// "This bit here" -- the presenter's selection, shown on everybody else's copy.
//
// It is the other half of pointing. The pen is for gestures made while a sentence is being said,
// and it fades with the sentence. A selection is the opposite kind of statement: it says which
// part of the document we are on, and it has to stay there for as long as that is true -- through
// a paragraph of talking, through somebody scrolling away and coming back. So nothing here
// expires; the highlight stands until the presenter moves it or lets it go.
//
// The hard part is that the two ends are not the same document. The presenter may be selecting in
// the source, where `**bold**` is eight characters; the watcher is reading the rendered page,
// where it is four. There is no offset that means the same thing on both sides. What does travel
// is the text itself -- the words, with the markup taken out of them -- plus the block it started
// in, which narrows the search enough that the same phrase twice in a document does not confuse it.
//
// Failing to find the text is not a failure worth showing: the block gets a wash instead, which is
// still the right answer to "which part are we on", just a coarser one.
//
// 「就是这里」—— 演示者的选区,显示在其他每个人的副本上。
//
// 它是"指"的另一半。笔是说一句话时做的手势,随那句话一起淡去。
// 选区是相反的一种陈述:它说的是"我们现在在文档的哪一部分",
// 而只要这件事还成立,它就得一直待在那儿 —— 熬过一整段讲话、熬过某人滚开又滚回来。
// 所以这里没有任何东西会过期;高亮一直立着,直到演示者把它挪走或松开。
//
// 难的地方在于两端不是同一份文档。演示者可能在源码里选,那里 `**bold**` 是八个字符;
// 旁观者读的是渲染出来的页面,那里它是四个。不存在一个在两边含义相同的偏移量。
// 能过河的是文本本身 —— 那些词,去掉标记之后 —— 加上它起始的那个块,
// 后者把搜索范围收窄到"同一个短语在文档里出现两次也不会认错"。
//
// 找不到那段文字不算一个值得显示出来的失败:那就给整个块上一层底色 ——
// 对"我们在哪一部分"来说,那仍然是对的答案,只是粗一点。

/** The name the stylesheet knows this highlight by. One per page is enough: there is one
 *  presenter, and they are looking at one thing.
 *  样式表认得的这个高亮的名字。一页一个就够:演示者只有一个,而他正看着一样东西。 */
const HL = 'pr-sel';
const CAN_HL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

/** Everything that is markup rather than words. Rough on purpose: it does not have to reproduce
 *  what the renderer did, only to produce something the rendered text will contain.
 *  凡是标记而不是词的东西。故意做得粗:它不必复现渲染器做过的事,
 *  只需产出一段"渲染后的文本里会包含"的东西。 */
export function plainOf(src) {
  return String(src || '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The rendered text of a subtree, flattened to single spaces, with a way back to where each
 *  character really came from. Whitespace is the whole reason this exists: the renderer puts
 *  newlines and indentation between tags that the source never had, so the two only line up once
 *  both have been squeezed.
 *  一棵子树渲染出来的文本,压成单空格,并留着"每个字符究竟来自哪里"的回程。
 *  空白正是它存在的全部理由:渲染器会在标签之间放进源码从未有过的换行与缩进,
 *  两边只有在都被压过之后才对得上。 */
function flatten(root) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans = [];
  let raw = '';
  let n;
  while ((n = walk.nextNode())) {
    spans.push({ node: n, at: raw.length, len: n.nodeValue.length });
    raw += n.nodeValue;
  }
  let flat = '';
  const back = [];
  let space = false;
  for (let i = 0; i < raw.length; i++) {
    const ws = /\s/.test(raw[i]);
    if (ws && space) continue;
    flat += ws ? ' ' : raw[i];
    back.push(i);
    space = ws;
  }
  return { spans, flat, back };
}

/** Turn an offset into the flattened text back into a real position in the tree.
 *  把压平文本里的一个偏移,还原成树里一个真实的位置。 */
function locate(spans, at) {
  for (const s of spans) {
    if (at < s.at + s.len) return { node: s.node, offset: at - s.at };
  }
  const last = spans[spans.length - 1];
  return last ? { node: last.node, offset: last.len } : null;
}

/** Find a run of words inside a subtree. Returns a Range, or null.
 *  在一棵子树里找一串词。返回一个 Range,或 null。 */
function findRange(root, needle) {
  if (!root || !needle) return null;
  const { spans, flat, back } = flatten(root);
  if (!spans.length) return null;
  const at = flat.indexOf(needle);
  if (at < 0) return null;
  const a = locate(spans, back[at]);
  const b = locate(spans, back[Math.min(back.length - 1, at + needle.length - 1)] + 1);
  if (!a || !b) return null;
  const r = document.createRange();
  try {
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
  } catch {
    return null;
  }
  return r;
}

/** The rendered block a source line falls in: the last one that starts at or before it.
 *  某个源码行落在哪个渲染块里:最后一个"起始行号不晚于它"的块。 */
function blockAt(box, line) {
  if (!box) return null;
  let best = null;
  for (const el of box.children) {
    const l = Number(el.dataset?.line);
    if (Number.isNaN(l)) continue;
    if (l <= line) best = el;
    else break;
  }
  return best || box.firstElementChild;
}

/** Show the presenter's selection on this copy of the document.
 *
 *  `opts.box()` is the rendered document. `opts.source()` is the textarea, when the editor has
 *  one -- a watcher does not, and does not need one, because a watcher never sends.
 *
 *  在这一份文档副本上显示演示者的选区。
 *
 *  opts.box() 是渲染出来的文档。opts.source() 是那个 textarea —— 编辑器有,
 *  旁观者没有,也不需要:旁观者从不发送。 */
export function attachMarks(session, opts) {
  /** The last thing the presenter said they were on. Kept so that it can be put back after the
   *  document re-renders, which happens on every keystroke they make.
   *  演示者最后一次说他在看的东西。留着它,好在文档重渲染之后把高亮放回去 ——
   *  而他每敲一个键,文档就重渲染一次。 */
  let shown = null;
  let last = '';

  function clear() {
    shown = null;
    if (CAN_HL) CSS.highlights.delete(HL);
    for (const el of opts.box()?.querySelectorAll('.pr-selblock') || []) el.classList.remove('pr-selblock');
  }

  function draw() {
    const box = opts.box();
    if (!box) return;
    if (CAN_HL) CSS.highlights.delete(HL);
    for (const el of box.querySelectorAll('.pr-selblock')) el.classList.remove('pr-selblock');
    if (!shown || !shown.text) return;
    const start = blockAt(box, shown.line);
    // Inside the block it started in first, and only then the whole document: a phrase that
    // occurs twice should resolve to the one the presenter is actually on.
    // 先在它起始的那个块里找,然后才是整份文档:
    // 一个出现两次的短语,应该落在演示者真正所在的那一个上。
    const r = (start && findRange(start, shown.text)) || findRange(box, shown.text);
    if (r && CAN_HL) {
      CSS.highlights.set(HL, new Highlight(r));
      return;
    }
    // No range, or no Highlight API: wash the block instead. Still an answer to "which part".
    // 找不到范围,或者没有 Highlight API:那就给块上底色。对"哪一部分"来说仍然是个答案。
    if (start) start.classList.add('pr-selblock');
  }

  session.on('sel', (m) => {
    shown = m.text ? { line: Number(m.line) || 0, text: String(m.text) } : null;
    draw();
  });

  /** What the presenter has selected, in whichever pane they selected it.
   *
   *  Two places it can come from, and they are read differently. In the source box the selection
   *  is a pair of offsets into Markdown, so the markup has to come out of it. In the rendered
   *  page it is already the words, and the block it began in is asked of the DOM.
   *
   *  演示者选中了什么 —— 不论他是在哪个面板里选的。
   *
   *  它有两个可能的来源,读法不同。在源码框里,选区是一对 Markdown 上的偏移量,
   *  因此要把标记从中去掉。在渲染出的页面里,它本来就是那些词,
   *  而它起始于哪个块,是向 DOM 问出来的。 */
  function gather() {
    if (session.state.seat !== 'presenter') return null;
    const ta = opts.source?.();
    if (ta && document.activeElement === ta && ta.selectionStart !== ta.selectionEnd) {
      const src = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      const line = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
      return { line, text: plainOf(src) };
    }
    const sel = window.getSelection();
    const box = opts.box();
    if (!sel || sel.isCollapsed || !box || !sel.anchorNode || !box.contains(sel.anchorNode)) return null;
    const host = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    const block = host?.closest('[data-line]');
    return { line: Number(block?.dataset.line) || 0, text: plainOf(sel.toString()) };
  }

  /** Selection changes fire in bursts -- one per pixel while a mouse is dragging -- so what goes
   *  out is the state it settles in rather than every state it passes through.
   *  选区变化是成串触发的 —— 鼠标拖动时每一个像素一次 ——
   *  所以发出去的是它停下来时的状态,而不是它路过的每一个状态。 */
  let t = 0;
  function onSelect() {
    clearTimeout(t);
    t = setTimeout(() => {
      const now = gather();
      const key = now ? `${now.line}|${now.text}` : '';
      if (key === last) return;
      last = key;
      session.sel(now || { line: 0, text: '' });
    }, 160);
  }

  document.addEventListener('selectionchange', onSelect);

  return {
    /** Put it back after the document was rebuilt under it.
     *  文档在它底下被重建之后,把它放回去。 */
    redraw: draw,
    destroy() {
      document.removeEventListener('selectionchange', onSelect);
      clearTimeout(t);
      clear();
    },
  };
}
