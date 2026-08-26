// Where a place in the source lands on the page, and back again.
//
// A rendered document and its source agree about content and about nothing else: a heading is one
// line of Markdown and eighty pixels of page, a picture is one line and four hundred. So anything
// that wants to say "here" across the two of them needs a map, and this is that map.
//
// It was written for the editor's two panes, which have to scroll together. It lives on its own
// now because a presentation needs exactly the same answer for a different pair of things: what
// the presenter is looking at, said in a unit that means the same on somebody else's screen. A
// source line is that unit -- it survives a different window width, a different font, a different
// theme, and a reader who has the outline hidden -- and everything here exists to convert to and
// from it.
//
// 源码里的某个位置落在页面的哪里,以及反过来。
//
// 渲染出的文档与它的源码,只在"内容"上一致,别的都不一致:一个标题是一行 Markdown、
// 八十像素的页面;一张图片是一行、四百像素。所以任何想跨这两者说"这里"的东西都需要一份映射,
// 而这就是那份映射。
//
// 它本是为编辑器那两个必须一起滚动的面板写的。如今它独立成篇,是因为一场演示需要的是
// 同一个答案,只是对象换了一对:演示者正在看的地方,用一个"在别人屏幕上含义相同"的单位说出来。
// 源码行号就是那个单位 —— 它经得起不同的窗口宽度、不同的字体、不同的主题,
// 以及一位把大纲收起来的读者 —— 而这里的一切,都是为了与它互相转换。

/** Token types that occupy source lines and render nothing where they stand. See scanBlocks.
 *  占着源码行、却不在它们所站的位置渲染任何东西的 token 类型。见 scanBlocks。 */
const SKIP_BLOCKS = new Set(['space', 'def', 'footnotes', 'footnote']);

/** Every top-level block of the document, and the source line it starts on.
 *
 *  文档的每一个顶层块,以及它在源码里起始的行号。 */
export function scanBlocks(marked, src) {
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

/** Tag each rendered top-level element with the source line its token began on.
 *
 *  The two lists line up because one top-level token becomes one top-level element; where they
 *  stop lining up -- a fragment of raw HTML that came apart, an element the sanitiser removed --
 *  the tail simply goes untagged, and asking about a position there falls back to the last thing
 *  that was known.
 *
 *  给每个渲染出的顶层元素标上它那个 token 起始的源码行号。
 *
 *  两份列表能对齐,是因为一个顶层 token 变成一个顶层元素;而在它们对不齐的地方 ——
 *  一段散开的裸 HTML、一个被消毒器移走的元素 —— 尾巴就是没有标记,
 *  在那里问位置会退回到"最后一处已知"。 */
export function tagLines(frag, lines) {
  let i = 0;
  for (const el of frag.children) {
    if (i < lines.length) el.dataset.line = String(lines[i++]);
  }
  return frag;
}

/** Where each tagged block sits in its scrolling box, measured rather than assumed. Rebuild it
 *  after every render: a picture that finished loading moves everything below it.
 *  每个带标记的块在它的滚动框里的位置,是量出来的而不是算出来的。
 *  每次渲染之后重建:一张刚加载完的图片会把它下面的一切都挪走。 */
export function measure(view, box) {
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
 *  is known on either side. It is not exact and does not need to be: what a reader wants is to be
 *  looking at the same part of the document, not at the same pixel.
 *  两个带标记的块之间一无所知,于是答案就是在两侧已知点之间拉一条直线。
 *  它不精确,也不需要精确:读者想要的是正看着文档的同一处,而不是同一个像素。 */
export function lerp(list, from, to, v) {
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
