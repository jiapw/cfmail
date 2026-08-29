// The editor for everything that is text but is not a document.
//
// A Markdown file is written to be read as prose, so its editor shows the prose. A shell script is
// not: what a person needs while editing one is to see its structure -- where a block begins, what
// is a string and what is a keyword, and which parts can be got out of the way. So this is the
// same window, the same saving, the same conflict handling, with the preview and the outline taken
// out and a real code editor put in their place.
//
// It opens plain text as well, and that is deliberate rather than incidental: a file whose
// extension nobody recognises still gets line numbers, search, undo and folding by indentation. It
// is only the colours that need a grammar, and only the colours that go missing without one.
//
// 给"是文本、却不是文档"的一切用的编辑器。
//
// 一个 Markdown 文件是写来当散文读的,所以它的编辑器展示那篇散文。一个 shell 脚本不是:
// 编辑它的人需要看见的是它的结构 —— 一个块从哪里开始、什么是字符串什么是关键字、
// 哪些部分可以先收起来。所以这里是同一扇窗、同一套保存、同一套冲突处理,
// 只是把预览与大纲取走,换上一个真正的代码编辑器。
//
// 它同样打开纯文本,而这是有意为之而非顺带:一个没人认得出扩展名的文件,
// 照样有行号、搜索、撤销,以及按缩进的折叠。需要文法的只有颜色,
// 而没有文法时缺席的也只有颜色。
import { t, tErr } from '../i18n.js';
import { esc, icon, qs, toast, confirmDialog, fmtDateTime } from '../ui.js';
import { store, setTitle } from '../app.js';
import { openDoc, saveDoc, mergeDoc, draft, refreshThumb, MAX_BYTES } from '../edit/session.js';
import { encSelectHtml, pickEnc, confirmLossy, lossyText } from '../edit/codepage.js';
import { extOf } from '../edit/kinds.js';
import { ensureCss, foldingLineNumbers, langFor, loadCm, themeStyle } from './view.js';

const V = () => encodeURIComponent(store.brand?.version || '');
// Shared with the Markdown editor on purpose: soft wrap is one preference about reading, and a
// person who wants their lines wrapped wants them wrapped in both places.
// 与 Markdown 编辑器共用,是有意的:软折行是关于"怎么读"的同一条偏好,
// 想让行折起来的人,在两个地方都想让它折起来。
const WRAP_KEY = 'cf_md_wrap';

let ed = null; // { doc, view, cm, dirty, saving, wrap, mime }

const mimeFor = (name) => (extOf(name) === 'csv' ? 'text/csv' : 'text/plain');

// ---------- The editor ----------
// ---------- 编辑器 ----------

async function buildView(text) {
  const cm = await loadCm();
  const { lang, folding } = await langFor(cm, ed.doc.name);
  // Plain text: the stylesheet may drop the gutter on a phone / 纯文本:手机上样式表可收掉边栏
  document.querySelector('.code-app')?.classList.toggle('code-plain', !lang);
  const wrapOn = ed.wrap;
  const ext = [
    foldingLineNumbers(cm),
    cm.highlightActiveLineGutter(),
    cm.highlightSpecialChars(),
    cm.history(),
    cm.drawSelection(),
    cm.dropCursor(),
    cm.indentOnInput(),
    cm.bracketMatching(),
    cm.codeFolding(),
    cm.foldGutter(),
    cm.highlightActiveLine(),
    cm.highlightSelectionMatches(),
    cm.search({ top: true }),
    cm.syntaxHighlighting(themeStyle(cm), { fallback: true }),
    cm.indentUnit.of('  '),
    cm.keymap.of([
      // Saving belongs to the document, not to the browser's idea of saving a page.
      // 保存属于这份文档,而不属于浏览器所理解的"保存网页"。
      { key: 'Mod-s', preventDefault: true, run: () => { doSave(); return true; } },
      // Tab indents here. A key that leaves the box is a key that cannot indent a block.
      // Tab 在这里是缩进。一个会跳出编辑框的键,是一个没法用来缩进一个块的键。
      cm.indentWithTab,
      ...cm.defaultKeymap, ...cm.historyKeymap, ...cm.foldKeymap, ...cm.searchKeymap,
    ]),
    cm.EditorView.updateListener.of((u) => {
      if (!u.docChanged || !ed) return;
      const now = u.state.doc.toString();
      markDirty(now !== ed.doc.base);
      draft.write(ed.doc, now);
    }),
    ed.wrapCompartment.of(wrapOn ? cm.EditorView.lineWrapping : []),
    // The language and the folding that suits it, together, so that changing one changes the
    // other. Which folding suits which language is decided in view.js, where the preview asks
    // the same question and has to get the same answer.
    // 语言与适合它的折叠放在一起,于是换掉一个就换掉另一个。
    // 哪种折叠配哪种语言,是在 view.js 里定的 —— 预览问的是同一个问题,必须得到同一个答案。
    ed.langCompartment.of(folding),
  ];
  ed.view = new cm.EditorView({
    state: cm.EditorState.create({ doc: text, extensions: ext }),
    parent: qs('#code-box'),
  });
}

// ---------- Window ----------
// ---------- 窗口 ----------

function shell() {
  return `
  <div class="code-app">
    <div class="code-head">
      <span class="code-name" id="code-name"></span>
      <span class="code-dot" id="code-dot" title=""></span>
      <span id="code-enc"></span>
      <span class="code-sp"></span>
      <wa-button class="icon" appearance="plain" id="code-wrap" aria-label="${esc(t('md_wrap'))}"
        title="${esc(t('md_wrap'))}">${icon('wrapText', 18)}</wa-button>
      <wa-button size="small" variant="brand" id="code-save">${esc(t('md_save'))}</wa-button>
    </div>
    <div class="code-body" id="code-box"></div>
  </div>`;
}

function markDirty(on) {
  if (!ed) return;
  ed.dirty = on;
  const dot = qs('#code-dot');
  if (dot) {
    dot.classList.toggle('on', on);
    dot.title = on ? t('md_unsaved') : '';
  }
}

const textOf = () => ed.view.state.doc.toString();

function replaceAll(text, caret) {
  ed.view.dispatch({
    changes: { from: 0, to: ed.view.state.doc.length, insert: text },
    selection: caret >= 0 ? { anchor: caret } : undefined,
    scrollIntoView: caret >= 0,
  });
}

async function setWrap(on) {
  if (!ed) return;
  ed.wrap = !!on;
  localStorage.setItem(WRAP_KEY, ed.wrap ? '1' : '0');
  qs('#code-wrap')?.classList.toggle('on', ed.wrap);
  if (ed.view) {
    const cm = await loadCm();
    ed.view.dispatch({
      effects: ed.wrapCompartment.reconfigure(ed.wrap ? cm.EditorView.lineWrapping : []),
    });
  }
}

// ---------- Saving ----------
// ---------- 保存 ----------

async function doSave() {
  if (!ed || ed.saving) return;
  ed.saving = true;
  try {
    let text = textOf();
    let r = await saveDoc(ed.doc, text, ed.mime);
    // Characters the file's codepage cannot carry. On a yes they become '?' -- in the box first,
    // then in the file, so the screen and the disk cannot end up telling two stories.
    // 文件的代码页装不下的字符。答应之后它们变成 '?' —— 先在框里,再进文件,
    // 免得屏幕与磁盘各说各话。
    if (r.status === 'badchars') {
      if (!(await confirmLossy(r.bad, ed.doc.cp.enc))) return;
      text = lossyText(text, ed.doc.cp.enc);
      replaceAll(text, -1);
      r = await saveDoc(ed.doc, text, ed.mime);
    }
    if (r.status === 'too-big') return toast(t('md_too_big'), true);
    if (r.status === 'unchanged') {
      markDirty(false);
      draft.write(ed.doc, text);
      return toast(t('md_unchanged'));
    }
    if (r.status === 'conflict') return conflict();
    markDirty(false);
    draft.write(ed.doc, text);
    toast(t('md_saved'));
    void refreshThumb(ed.doc, text, ed.mime, V());
  } catch (e) {
    toast(tErr(e), true);
  } finally {
    ed.saving = false;
  }
}

/** Somebody else wrote to this file while it was open here. The two sets of edits are put back
 *  together rather than one being chosen over the other; where they cannot be, the disagreement is
 *  written into the text and the caret is put in the first one. Nothing is saved automatically.
 *  在这里开着的这段时间里,有别人写过这个文件。两边的改动被重新合到一起而不是二选一;
 *  合不了的地方,分歧被写进正文,光标停在第一处。什么都不会被自动保存。 */
async function conflict() {
  try {
    const out = await mergeDoc(ed.doc, textOf(), {
      mine: t('md_merge_mine'),
      theirs: t('md_merge_theirs'),
    });
    replaceAll(out.text, out.conflicts ? out.first : -1);
    markDirty(true);
    draft.write(ed.doc, out.text);
    if (out.conflicts) toast(t('md_merged_conflicts', out.conflicts), true);
    else toast(t('md_merged'));
  } catch {
    toast(t('md_conflict_stay'), true);
  }
}

// ---------- Entry ----------
// ---------- 入口 ----------

export async function renderCodeEditor(id) {
  // Nothing is painted until the stylesheet is here. Both halves of this window are styled by
  // it -- the frame around the editor as much as the editor -- so painting early shows the
  // whole thing unstyled: a bare toolbar above light-on-white CodeMirror, in a dark window.
  // The wait is one round trip and only the first time; after that it is already in the page.
  // 样式表到齐之前什么都不画。这扇窗的两半都由它来排 —— 编辑器周围的框架和编辑器本身一样 ——
  // 所以画早了就是整扇窗都没有样式:一条光秃秃的工具条,底下是白底浅色的 CodeMirror,
  // 装在一扇深色窗里。这一等只有一个往返,而且只在第一次;此后它已经在页面里了。
  const [cm] = await Promise.all([loadCm(), ensureCss()]);
  document.body.classList.add('code-open');
  (qs('#app') || document.body).innerHTML = shell();
  ed = {
    doc: null,
    view: null,
    dirty: false,
    saving: false,
    wrap: localStorage.getItem(WRAP_KEY) === '1',
    mime: 'text/plain',
    wrapCompartment: new cm.Compartment(),
    langCompartment: new cm.Compartment(),
  };
  qs('#code-save').addEventListener('click', doSave);
  qs('#code-wrap').addEventListener('click', () => setWrap(!ed.wrap));
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onLeave);
  window.addEventListener('hashchange', onHash);

  try {
    ed.doc = await openDoc(id);
    ed.mime = mimeFor(ed.doc.name);
    qs('#code-name').textContent = ed.doc.name;
    setTitle(ed.doc.name);
    qs('#code-wrap').classList.toggle('on', ed.wrap);
    // The codepage the file was read through, changeable while it has no BOM. Switching re-reads
    // the same bytes; the view update that follows notices the text now matches base and clears
    // the dirty mark and the draft on its own.
    // 文件被读入时经过的代码页,没有 BOM 时可换。换挡是把同一份字节重读一遍;
    // 随之而来的视图更新会发现文本与 base 一致,自己清掉脏标记和草稿。
    const encBox = qs('#code-enc');
    encBox.innerHTML = encSelectHtml(ed.doc.cp);
    encBox.querySelector('select')?.addEventListener('change', async (e) => {
      const reread = await pickEnc(e.target, ed.doc, ed.dirty);
      if (reread !== null) replaceAll(reread, -1);
    });

    let text = ed.doc.base;
    // A draft outliving its tab means the tab did not close on purpose. Offering it is worth doing
    // only while it still says something the file does not.
    // 一份活过了它那个标签页的草稿,意味着那个标签页不是被特意关掉的。
    // 只有当它仍然说着文件所没有的东西时,提出它才有意义。
    const d = draft.read(id);
    if (d && d.text !== text) {
      if (await confirmDialog(t('md_draft_ask', fmtDateTime(d.at)), t('md_draft_use'))) text = d.text;
      else draft.clear(id);
    }
    await buildView(text);
    markDirty(text !== ed.doc.base);
    ed.view.focus();
  } catch (e) {
    qs('#code-box').innerHTML = `<p class="code-err">${esc(tErr(e))}</p>`;
  }
}

function onKey(e) {
  // The editor has its own binding; this catches the same keystroke while focus is elsewhere in
  // the window -- on the toolbar, say, or nowhere at all.
  // 编辑器自己有一份绑定;这一份接住的是"焦点在窗口别处"时的同一次按键 ——
  // 比如在工具栏上,或者哪儿都不在。
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    doSave();
  }
}

function onLeave(e) {
  if (!ed?.dirty) return;
  e.preventDefault();
  e.returnValue = '';
}

function onHash() {
  const h = location.hash;
  if (h.startsWith('#/') && !h.startsWith('#/code/')) closeCodeEditor();
}

export function closeCodeEditor() {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', onLeave);
  window.removeEventListener('hashchange', onHash);
  ed?.view?.destroy();
  document.body.classList.remove('code-open');
  ed = null;
}

export { MAX_BYTES };
