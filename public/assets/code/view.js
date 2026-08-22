// The parts of the source view that do not depend on being editable.
//
// Two places show source code now: the editor, which can change it, and the drive's preview, which
// cannot. What they have in common is everything about how code looks -- the palette, the grammar,
// the folding rule that stands in when there is no grammar -- and none of that has anything to do
// with whether a keystroke would be accepted. Kept in one place so that a file looks the same in
// both, which is the only reason a preview of it is worth anything: a preview that renders a file
// differently from the editor is a preview of a different file.
//
// 源码视图中与"能不能编辑"无关的那些部分。
//
// 现在有两处显示源码:能改它的编辑器,和改不了它的网盘预览。它们共有的是"代码长什么样"的全部 ——
// 配色、文法、以及没有文法时顶上的那条折叠规则 —— 而这些没有一样与"一次按键会不会被接受"有关。
// 放在一处,好让同一份文件在两边看起来是同一份 ——
// 这也是预览它唯一有价值的理由:一份渲染得与编辑器不同的预览,预览的是另一个文件。
import { qs } from '../ui.js';
import { store } from '../app.js';
import { extOf } from '../edit/kinds.js';

const V = () => encodeURIComponent(store.brand?.version || '');

let cmMod = null;
export const loadCm = async () => {
  if (!cmMod) cmMod = await import(`/vendor/codemirror/codemirror.entry.js?v=${V()}`);
  return cmMod;
};

/** The stylesheet both views need, injected once, and waited for.
 *
 *  Waited for because a stylesheet arrives whenever it arrives, and CodeMirror mounted before it
 *  does is a moment of unstyled editor -- the library's own defaults, light-on-white, in the
 *  middle of a dark panel. It lasts one network round trip and only the first time, which is
 *  exactly long enough to be the first thing somebody sees of this feature.
 *
 *  A stylesheet that fails to load resolves too rather than hanging: a view with the wrong colours
 *  is worth more than a panel that never fills in.
 *
 *  两个视图都需要的那份样式表,只注入一次,并且等它到齐。
 *
 *  之所以等,是因为样式表什么时候到就什么时候到,而在它到达之前挂上的 CodeMirror
 *  会有一瞬间是没有样式的 —— 库自己的默认值,白底浅色,出现在一块深色面板中间。
 *  它只持续一个网络往返、也只在第一次出现,而这恰好足够长到成为某人看见这个功能的第一眼。
 *
 *  加载失败时也照样兑现而不是挂住:一个颜色不对的视图,比一块永远填不上的面板值钱。 */
let cssReady = null;
export function ensureCss() {
  if (cssReady) return cssReady;
  const had = qs('link[href^="/assets/code/code.css"]');
  if (had) {
    cssReady = Promise.resolve();
    return cssReady;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `/assets/code/code.css?v=${V()}`;
  cssReady = new Promise((done) => {
    l.addEventListener('load', done, { once: true });
    l.addEventListener('error', done, { once: true });
  });
  document.head.appendChild(l);
  return cssReady;
}

/** Colours named rather than chosen, so the editor is the same editor in both themes. CodeMirror
 *  wants values, and a custom property is a value -- which is the whole reason this can be one
 *  style rather than two.
 *  颜色是被指名的而不是被选定的,于是这个编辑器在两种主题下是同一个编辑器。
 *  CodeMirror 要的是值,而自定义属性就是一个值 —— 这正是它能只有一套样式而不是两套的全部原因。 */
export function themeStyle(cm) {
  const { HighlightStyle, tags: x } = cm;
  return HighlightStyle.define([
    { tag: [x.keyword, x.moduleKeyword, x.controlKeyword, x.operatorKeyword], color: 'var(--cm-keyword)' },
    { tag: [x.name, x.deleted, x.character, x.propertyName, x.macroName], color: 'var(--cm-name)' },
    { tag: [x.function(x.variableName), x.labelName], color: 'var(--cm-fn)' },
    { tag: [x.color, x.constant(x.name), x.standard(x.name)], color: 'var(--cm-const)' },
    { tag: [x.definition(x.name), x.separator], color: 'var(--cm-text)' },
    { tag: [x.typeName, x.className, x.number, x.changed, x.annotation, x.self, x.namespace], color: 'var(--cm-type)' },
    { tag: [x.operator, x.operatorKeyword, x.url, x.escape, x.regexp, x.link, x.special(x.string)], color: 'var(--cm-op)' },
    { tag: [x.meta, x.comment], color: 'var(--cm-comment)', fontStyle: 'italic' },
    { tag: x.strong, fontWeight: 'bold' },
    { tag: x.emphasis, fontStyle: 'italic' },
    { tag: x.strikethrough, textDecoration: 'line-through' },
    { tag: x.heading, fontWeight: 'bold', color: 'var(--cm-name)' },
    { tag: [x.atom, x.bool, x.special(x.variableName)], color: 'var(--cm-const)' },
    { tag: [x.processingInstruction, x.string, x.inserted], color: 'var(--cm-string)' },
    { tag: x.invalid, color: 'var(--cm-invalid)' },
  ]);
}

/** Folding for a file with no grammar to fold by.
 *
 *  A language with a parse tree knows where a function ends. Without one there is still something
 *  true to say: a line that is followed by more deeply indented lines is the head of something,
 *  and that something ends where the indentation comes back. It is how YAML, and a plain outline,
 *  and most configuration is shaped -- so the fold arrows appear for those too rather than only
 *  for the dozen languages that ship a grammar.
 *
 *  给"没有文法可依的文件"用的折叠。
 *
 *  有语法树的语言知道一个函数在哪里结束。没有语法树时,仍有一件为真的事可说:
 *  一行后面若跟着缩进更深的行,它就是某样东西的头,而那样东西在缩进退回来的地方结束。
 *  YAML、一份纯粹的提纲、以及大多数配置文件,都是这个形状 ——
 *  于是折叠箭头也会为它们出现,而不只为那十几种自带文法的语言。 */
export function indentFolding(cm) {
  return cm.foldService.of((state, from, to) => {
    const line = state.doc.lineAt(from);
    const width = (s) => s.length - s.replace(/^[ \t]*/, '').length;
    if (!line.text.trim()) return null;
    const base = width(line.text);
    let end = -1;
    for (let n = line.number + 1; n <= state.doc.lines; n++) {
      const l = state.doc.line(n);
      if (!l.text.trim()) continue;               // a blank line belongs to whatever surrounds it
      if (width(l.text) <= base) break;
      end = l.to;
    }
    return end > to ? { from: to, to: end } : null;
  });
}

/** The language for a file name, together with the folding that suits it.
 *
 *  A grammar brings its own folding; without one the indentation rule stands in. Both are wanted
 *  when there is a grammar that does not fold much -- a stream mode has no tree at all.
 *
 *  某个文件名对应的语言,连同适合它的折叠。
 *
 *  有文法就自带折叠;没有的话由缩进规则顶上。
 *  当文法本身折不了多少时两者都要 —— 流式模式根本没有语法树。 */
export async function langFor(cm, name) {
  const lang = await cm.langFor(extOf(name));
  return { lang, folding: lang ? [lang, indentFolding(cm)] : [indentFolding(cm)] };
}

/**
 * A view that shows source and does nothing else.
 *
 * Everything that could change the document is left out rather than switched off: no history, no
 * input handling, no keymap that writes. `editable` false takes away the caret and the typing, and
 * `readOnly` refuses a change even if something managed to dispatch one -- two answers to the same
 * question, because one of them is about the interface and the other is about the document.
 *
 * What stays is what makes source readable: the line numbers, the colours, and the fold arrows.
 * Folding is not editing -- the file is untouched by it -- and a preview of a thousand-line file
 * that cannot be collapsed is a preview you scroll through rather than read.
 *
 * Selection stays too. A preview you cannot copy out of is a preview you have to open the editor
 * to use.
 *
 * 一个只显示源码、别的什么都不做的视图。
 *
 * 一切可能改动文档的东西是被略去而不是被关掉:没有历史、没有输入处理、没有会写入的按键映射。
 * `editable` 为 false 拿走光标与键入,`readOnly` 则在真有谁派发了一次改动时拒绝它 ——
 * 同一个问题的两个答案,因为其中一个说的是界面,另一个说的是文档。
 *
 * 留下的是让源码可读的那些:行号、配色、折叠箭头。折叠不是编辑 —— 文件不因它而改变 ——
 * 而一份折不起来的千行文件预览,是拿来滚的,不是拿来读的。
 *
 * 选中也留着。一份复制不出内容的预览,是一份非得打开编辑器才能用的预览。
 */
export async function renderOnly({ parent, text, name }) {
  const [cm] = await Promise.all([loadCm(), ensureCss()]);
  const { folding } = await langFor(cm, name);
  return new cm.EditorView({
    state: cm.EditorState.create({
      doc: text,
      extensions: [
        cm.lineNumbers(),
        cm.highlightSpecialChars(),
        cm.codeFolding(),
        cm.foldGutter(),
        cm.syntaxHighlighting(themeStyle(cm), { fallback: true }),
        cm.EditorView.editable.of(false),
        cm.EditorState.readOnly.of(true),
        ...folding,
      ],
    }),
    parent,
  });
}

// ---------- Source without a view ----------
// ---------- 没有视图的源码 ----------

/** Which tag means which colour. The names on the right are the palette's, so this table and the
 *  highlight style above say the same thing twice in two shapes -- one for a view, which wants CSS
 *  classes it can style, and one for a canvas, which wants a name it can look a colour up by.
 *  哪个标签对应哪种颜色。右边的名字就是调色板里的名字,于是这张表与上面那份高亮样式
 *  用两种形状说了同一件事 —— 一份给视图,它要的是能被样式化的 CSS 类;
 *  一份给画布,它要的是一个可以据以查出颜色的名字。 */
const runHighlighter = (cm) => {
  const x = cm.tags;
  return cm.tagHighlighter([
    { tag: [x.keyword, x.moduleKeyword, x.controlKeyword, x.operatorKeyword], class: 'keyword' },
    { tag: [x.string, x.processingInstruction, x.inserted, x.special(x.string)], class: 'string' },
    { tag: [x.comment, x.meta], class: 'comment' },
    { tag: [x.typeName, x.className, x.number, x.annotation, x.self, x.namespace, x.changed], class: 'type' },
    { tag: [x.function(x.variableName), x.labelName], class: 'fn' },
    { tag: [x.atom, x.bool, x.constant(x.name), x.standard(x.name), x.color], class: 'const' },
    { tag: [x.operator, x.regexp, x.escape, x.url, x.link], class: 'op' },
    { tag: [x.propertyName, x.name, x.macroName, x.character, x.deleted], class: 'name' },
    { tag: x.invalid, class: 'invalid' },
  ]);
};

/**
 * Cut text into coloured runs, with no editor anywhere.
 *
 * A grammar is a parser, and a parser does not need a view to run. So the text is parsed, the tree
 * is walked, and what comes back is the same division into keywords and strings and comments that
 * the editor would show -- as data, which something that is not an editor can draw.
 *
 * The whole text comes back, not only the coloured parts. What a grammar has nothing to say about
 * is still text that has to appear, and a caller that had to work out the gaps for itself would be
 * a caller with its own second opinion about where the runs are.
 *
 * 把文本切成一段段带颜色的片段,全程不需要编辑器。
 *
 * 文法就是一个解析器,而解析器不需要视图才能跑。于是文本被解析、语法树被走一遍,
 * 回来的东西是"关键字、字符串、注释"的同一种划分 —— 编辑器会展示的那一种 ——
 * 只不过是数据形式,于是一个不是编辑器的东西也能把它画出来。
 *
 * 回来的是整段文本,而不只是有颜色的那些部分。文法无话可说的地方,仍然是必须出现的文本;
 * 而一个要自己算出这些空隙的调用方,就是一个对"片段在哪里"另有一套看法的调用方。
 */
export async function runsOf(text, name) {
  const cm = await loadCm();
  const { lang } = await langFor(cm, name);
  if (!lang) return [{ text, cls: null }];
  const tree = (lang.language || lang).parser.parse(text);
  const out = [];
  let at = 0;
  cm.highlightTree(tree, runHighlighter(cm), (from, to, cls) => {
    if (from < at) return;                      // nested ranges: the outer one already covered this
    if (from > at) out.push({ text: text.slice(at, from), cls: null });
    out.push({ text: text.slice(from, to), cls });
    at = to;
  });
  if (at < text.length) out.push({ text: text.slice(at), cls: null });
  return out;
}

/** The editor's colours as values, read from the page rather than restated here.
 *
 *  This is what makes a picture of source look like the editor: not a palette copied into the
 *  drawing code, but the same custom properties the editor is painted with, resolved at the moment
 *  the picture is made. Change a colour in code.css and the next thumbnail is drawn in it.
 *
 *  编辑器的那些颜色,作为值取回来,从页面上读而不是在这里重述一遍。
 *
 *  这正是一张源码的图看起来像编辑器的原因:不是把调色板抄进绘图代码,
 *  而是用编辑器所用的同一批自定义属性,在画这张图的那一刻求值。
 *  在 code.css 里改一个颜色,下一张缩略图就用新的画。 */
export async function palette() {
  await ensureCss();
  const s = getComputedStyle(document.documentElement);
  const v = (n, fb) => (s.getPropertyValue(n) || '').trim() || fb;
  return {
    // The editor's own two surfaces: the document sits on --bg and the gutter beside it on
    // --panel. Taking both means a thumbnail is a small picture of the editor rather than an
    // approximation of one that drifts every time the editor is restyled.
    // 编辑器自己的两块表面:文档坐在 --bg 上,旁边的行号槽坐在 --panel 上。
    // 两个都取,缩略图才是编辑器的一张小图,而不是一个每次编辑器改样式就走味的近似。
    bg: v('--bg', '#ffffff'),
    gutterBg: v('--panel', '#ffffff'),
    border: v('--border', '#e0e0e0'),
    gutter: v('--cm-gutter', '#9aa0a6'),
    font: v('--font-code', "ui-monospace, Consolas, monospace"),
    ink: {
      null: v('--cm-text', '#3c4043'),
      keyword: v('--cm-keyword', '#a626a4'),
      name: v('--cm-name', '#383a42'),
      fn: v('--cm-fn', '#4078f2'),
      const: v('--cm-const', '#986801'),
      type: v('--cm-type', '#c18401'),
      op: v('--cm-op', '#0184bc'),
      string: v('--cm-string', '#50a14f'),
      comment: v('--cm-comment', '#a0a1a7'),
      invalid: v('--cm-invalid', '#e45649'),
    },
  };
}
