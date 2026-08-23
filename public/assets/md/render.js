// Markdown, turned into something a page can hold.
//
// Two places show a Markdown file: the editor, where it is being written, and the drive's preview,
// where it is being looked at. They used to use different renderers, which meant the same document
// had two appearances -- headings at different levels, footnotes in one and not the other, a
// relative image that resolved on one side and broke on the other. Whichever you were looking at,
// you could not be sure it was what the other would show.
//
// So the rendering lives here and both call it. What differs between the two is what surrounds the
// document, which is as it should be: an editor has an editor around it and a preview does not.
//
// 把 Markdown 变成一页纸装得下的东西。
//
// 有两个地方会显示一个 Markdown 文件:正在写它的编辑器,和正在看它的网盘预览。
// 从前它们用的是不同的渲染器,于是同一份文档有两副面孔 —— 标题层级不同、
// 脚注一边有一边没有、一张相对路径的图片这边解析得开、那边打不开。
// 无论你正在看哪一边,都没法确定它就是另一边会显示的东西。
//
// 所以渲染住在这里,两边都来调它。两者之间不同的是文档周围的东西,
// 而那本就该不同:编辑器周围有一个编辑器,预览周围没有。
import { api } from '../api.js';
import { tErr } from '../i18n.js';
import { qs, toast } from '../ui.js';
import { store } from '../app.js';

const V = () => encodeURIComponent(store.brand?.version || '');

export const MD_RE = /\.(md|markdown|mdown|mkd)$/i;

let libs = null; // { marked, purify }

/** The stylesheet that says what a rendered document looks like, injected once and waited for.
 *  A document painted before it arrives is a flash of unstyled Markdown -- serif headings, blue
 *  underlined links, no spacing -- which is exactly the appearance this file exists to make
 *  identical in both places.
 *  规定"一份渲染好的文档长什么样"的那份样式表,只注入一次,并且等它到齐。
 *  在它到达之前就画出来的文档,是一瞬间没有样式的 Markdown —— 衬线标题、蓝色带下划线的链接、
 *  没有间距 —— 而"长什么样"恰恰是这个文件存在所要让两边一致的东西。 */
let cssReady = null;
export function ensureCss() {
  if (cssReady) return cssReady;
  if (qs('link[href^="/assets/md/md.css"]')) {
    cssReady = Promise.resolve();
    return cssReady;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/assets/md/md.css?v=' + V();
  cssReady = new Promise((done) => {
    l.addEventListener('load', done, { once: true });
    l.addEventListener('error', done, { once: true });
  });
  document.head.appendChild(l);
  return cssReady;
}

/** Both libraries, fetched once. They are the reason this route is loaded on demand: a person who
 *  never edits a document never pays for them.
 *  两个库,只取一次。它们正是这条路由按需加载的理由:从不编辑文档的人,不为它们付账。 */
export async function loadLibs() {
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
export async function mdFragment(src, base) {
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

/**
 * What a click on a rendered document means.
 *
 * Three kinds of link, and only one of them is an ordinary one. An anchor scrolls to its target
 * and leaves the address bar alone -- the address names the document being read, and letting a
 * footnote overwrite it would mean a reload lands somewhere else entirely. A relative link is
 * resolved now rather than when it was rendered, because where it leads is a question about the
 * drive and the answer can be "another document", which opens where documents are written. An
 * outside link already carries target=_blank and needs nothing.
 *
 * 点在一份渲染好的文档上,意味着什么。
 *
 * 三种链接,其中只有一种是普通的。锚点滚到它的目标,并且不碰地址栏 ——
 * 地址指名的是"正在读的这份文档",让一条脚注把它覆盖掉,意味着刷新之后会落到完全不相干的地方。
 * 相对链接是此刻才解析的,而不是渲染时 —— 因为"它通向哪里"是一个关于网盘的问题,
 * 而答案可能是"另一份文档",那就该在"写文档的地方"打开。
 * 外部链接本来就带着 target=_blank,不需要这里做什么。
 */
export async function docClick(e, root, base) {
  const a = e.target.closest?.('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href.startsWith('#')) {
    e.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const el = id && root?.querySelector(`[id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const rel = a.getAttribute('data-rel');
  if (!rel || !base) return;
  e.preventDefault();
  try {
    const r = await api('GET', `/api/drive/rel?base=${encodeURIComponent(base)}`
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
