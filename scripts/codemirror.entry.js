// What the browser gets of CodeMirror, and nothing else.
//
// CodeMirror 6 is published as several dozen npm packages that import one another by bare name,
// which a browser cannot resolve. Everything else this project vendors is a finished file that
// could simply be copied; this one has to be assembled first. That is what this entry is for: it
// names the pieces actually used, and `npm run vendor` bundles them into public/vendor/codemirror/.
//
// The languages are reached through dynamic import on purpose. Bundled in, they would be most of
// the weight, and a person editing a shell script would be paying for Rust, PHP and SQL to arrive
// with it. Written this way the bundler splits each into a chunk of its own, fetched the moment a
// file of that kind is opened and never otherwise.
//
// 浏览器所拿到的 CodeMirror,仅此而已。
//
// CodeMirror 6 以几十个 npm 包发布,彼此用裸名互相引用,而浏览器解析不了裸名。
// 这个项目 vendor 的其它东西都是拷过去就能用的成品文件;唯独这一个必须先装配。
// 这个入口就是干这件事的:点名真正用到的部件,由 npm run vendor 打进 public/vendor/codemirror/。
//
// 语言是刻意用动态 import 取的。若一起打进来,它们会占掉大部分体积 ——
// 于是一个编辑 shell 脚本的人,要为随之而来的 Rust、PHP 和 SQL 付账。
// 写成这样,打包器会把每种语言拆成自己的一块,在打开该类文件的那一刻才取,其余时候永不。

export { EditorState, Compartment, EditorSelection } from '@codemirror/state';
export {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
  placeholder,
} from '@codemirror/view';
export {
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo,
} from '@codemirror/commands';
export {
  foldGutter, foldKeymap, codeFolding, foldService, foldAll, unfoldAll,
  foldCode, unfoldCode, foldedRanges,
  indentOnInput, indentUnit, bracketMatching, syntaxHighlighting, HighlightStyle,
  StreamLanguage, LanguageSupport,
} from '@codemirror/language';
export { searchKeymap, highlightSelectionMatches, search, openSearchPanel } from '@codemirror/search';
// Highlighting without an editor. The thumbnail generator needs the colours a grammar implies
// but has no view to put them in: it parses the text, walks the tree, and paints the spans onto
// a canvas. These three are that path -- the walk, the tag-to-name mapping it reports through,
// and the tags themselves.
// 不需要编辑器的着色。缩略图生成器要的是文法所蕴含的那些颜色,却没有一个视图可以安放它们:
// 它解析文本、走一遍语法树,把各段画到画布上。这三样就是那条路径 ——
// 走树、走树时用来报告结果的"标签到名字"的映射,以及标签本身。
export { tags, highlightTree, tagHighlighter } from '@lezer/highlight';

/** Every stream mode this editor can reach, each named outright.
 *
 *  Written as one import per line rather than as `import(base + name)`, because a bundler can only
 *  follow an import it can read. Given a computed one it emits the expression unchanged, and what
 *  ships is a browser asking for a bare package name -- which is the thing this whole file exists
 *  to prevent. It fails at the moment somebody opens a shell script, and nowhere earlier: not at
 *  build time, which reported success, and not at load time, which loaded.
 *
 *  这个编辑器能够到的每一种流式模式,逐一点名。
 *
 *  写成一行一个 import 而不是 `import(base + name)`,因为打包器只能跟随它读得懂的 import。
 *  给它一个拼出来的,它就原样把表达式吐出去,于是发出去的东西是"浏览器去要一个裸包名" ——
 *  而那正是这整个文件存在所要防的事。它会在某人打开一个 shell 脚本的那一刻失败,
 *  在此之前的任何地方都不会:构建时不会,它报的是成功;加载时也不会,它确实加载上了。 */
const STREAMS = {
  shell: () => import('@codemirror/legacy-modes/mode/shell'),
  yaml: () => import('@codemirror/legacy-modes/mode/yaml'),
  toml: () => import('@codemirror/legacy-modes/mode/toml'),
  go: () => import('@codemirror/legacy-modes/mode/go'),
  ruby: () => import('@codemirror/legacy-modes/mode/ruby'),
  lua: () => import('@codemirror/legacy-modes/mode/lua'),
  dockerfile: () => import('@codemirror/legacy-modes/mode/dockerfile'),
  properties: () => import('@codemirror/legacy-modes/mode/properties'),
  diff: () => import('@codemirror/legacy-modes/mode/diff'),
  powershell: () => import('@codemirror/legacy-modes/mode/powershell'),
  perl: () => import('@codemirror/legacy-modes/mode/perl'),
  swift: () => import('@codemirror/legacy-modes/mode/swift'),
  r: () => import('@codemirror/legacy-modes/mode/r'),
  clojure: () => import('@codemirror/legacy-modes/mode/clojure'),
  haskell: () => import('@codemirror/legacy-modes/mode/haskell'),
  erlang: () => import('@codemirror/legacy-modes/mode/erlang'),
  nginx: () => import('@codemirror/legacy-modes/mode/nginx'),
  octave: () => import('@codemirror/legacy-modes/mode/octave'),
  sass: () => import('@codemirror/legacy-modes/mode/sass'),
  vb: () => import('@codemirror/legacy-modes/mode/vb'),
  stex: () => import('@codemirror/legacy-modes/mode/stex'),
  clike: () => import('@codemirror/legacy-modes/mode/clike'),
};

const stream = async (file, name) => {
  const [mod, lang] = await Promise.all([STREAMS[file](), import('@codemirror/language')]);
  return lang.StreamLanguage.define(mod[name]);
};

/** The language for a file extension, fetched when it is wanted and not before.
 *
 *  Two kinds sit behind this. The first are CodeMirror's own grammars: a real parse tree, which is
 *  what gives those languages folding that knows where a function ends rather than where the
 *  indentation changes. The second are the older stream modes, one small tokeniser each, which
 *  colour correctly and leave folding to the indentation rule below -- worth having, because the
 *  long tail of a drive is shell scripts and YAML, not compilers.
 *
 *  Anything unrecognised gets null, and a file with no language is still a file with line numbers,
 *  search, undo and folding by indentation. That is the promise for plain text: everything except
 *  the colours.
 *
 *  某个扩展名对应的语言,在需要它的时候才取,不提前。
 *
 *  背后有两类。第一类是 CodeMirror 自己的文法:有真正的语法树,
 *  正因如此,那些语言的折叠知道一个函数在哪里结束,而不只是知道缩进在哪里变化。
 *  第二类是更早的流式模式,每种一个小巧的分词器,着色正确,折叠交给下面那条缩进规则 ——
 *  它们值得留着,因为一个网盘的长尾是 shell 脚本和 YAML,不是编译器。
 *
 *  认不出来的返回 null,而一个没有语言的文件,仍然是一个有行号、有搜索、有撤销、
 *  有按缩进折叠的文件。这就是给纯文本的承诺:除了颜色,别的都在。 */
export async function langFor(ext) {
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': {
      const m = await import('@codemirror/lang-javascript');
      return m.javascript({ jsx: ext === 'jsx' });
    }
    case 'ts': case 'tsx': case 'mts': case 'cts': {
      const m = await import('@codemirror/lang-javascript');
      return m.javascript({ typescript: true, jsx: ext === 'tsx' });
    }
    case 'py': case 'pyw': {
      const m = await import('@codemirror/lang-python');
      return m.python();
    }
    case 'html': case 'htm': case 'vue': case 'svelte': {
      const m = await import('@codemirror/lang-html');
      return m.html();
    }
    case 'css': case 'scss': case 'less': {
      const m = await import('@codemirror/lang-css');
      return m.css();
    }
    case 'json': case 'jsonc': case 'json5': case 'webmanifest': {
      const m = await import('@codemirror/lang-json');
      return m.json();
    }
    case 'md': case 'markdown': case 'mdown': case 'mkd': {
      const m = await import('@codemirror/lang-markdown');
      return m.markdown();
    }
    case 'xml': case 'svg': case 'xsl': case 'plist': case 'xaml': {
      const m = await import('@codemirror/lang-xml');
      return m.xml();
    }
    case 'sql': case 'psql': case 'mysql': {
      const m = await import('@codemirror/lang-sql');
      return m.sql();
    }
    case 'rs': {
      const m = await import('@codemirror/lang-rust');
      return m.rust();
    }
    case 'c': case 'h': case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh': case 'ino': {
      const m = await import('@codemirror/lang-cpp');
      return m.cpp();
    }
    case 'java': {
      const m = await import('@codemirror/lang-java');
      return m.java();
    }
    case 'php': case 'phtml': {
      const m = await import('@codemirror/lang-php');
      return m.php();
    }

    // The stream modes, one file each.
    // 流式模式,每种一个文件。
    case 'sh': case 'bash': case 'zsh': case 'ksh': case 'bashrc': return stream('shell', 'shell');
    case 'yml': case 'yaml': return stream('yaml', 'yaml');
    case 'toml': return stream('toml', 'toml');
    case 'go': return stream('go', 'go');
    case 'rb': case 'gemfile': case 'rake': return stream('ruby', 'ruby');
    case 'lua': return stream('lua', 'lua');
    case 'dockerfile': return stream('dockerfile', 'dockerFile');
    case 'ini': case 'conf': case 'cfg': case 'properties': case 'env': return stream('properties', 'properties');
    case 'diff': case 'patch': return stream('diff', 'diff');
    case 'ps1': case 'psm1': return stream('powershell', 'powerShell');
    case 'pl': case 'pm': return stream('perl', 'perl');
    case 'swift': return stream('swift', 'swift');
    case 'r': return stream('r', 'r');
    case 'clj': case 'cljs': case 'edn': return stream('clojure', 'clojure');
    case 'hs': return stream('haskell', 'haskell');
    case 'erl': return stream('erlang', 'erlang');
    case 'ex': case 'exs': return stream('erlang', 'erlang');
    case 'nginx': return stream('nginx', 'nginx');
    case 'm': case 'octave': return stream('octave', 'octave');
    case 'sass': case 'styl': return stream('sass', 'sass');
    case 'vb': case 'vbs': return stream('vb', 'vb');
    case 'tex': case 'latex': return stream('stex', 'stex');
    case 'cs': return stream('clike', 'csharp');
    case 'kt': case 'kts': return stream('clike', 'kotlin');
    case 'scala': case 'sc': return stream('clike', 'scala');
    case 'dart': return stream('clike', 'dart');
    case 'mm': return stream('clike', 'objectiveCpp');
    default: return null;
  }
}
