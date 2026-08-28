// The PDF editor as a window of its own.
//
// The Markdown and code editors settled what an editor is here: a tab with an address, opened
// beside the Drive rather than inside it, holding one document that can be left open, reloaded,
// and come back to. This gives the PDF editor the same standing. The machinery underneath is
// unchanged -- pdfui.js points at things and pdfedit.js keeps the list of changes -- and what
// this module adds is only what the preview used to provide around them: pages drawn by pdf.js,
// a save that writes back to the same file, and a window to stand in.
//
// The whole file is fetched before anything is drawn. Editing writes a document, and a document
// cannot be written from the parts of itself somebody happened to look at -- so unlike the
// preview, there is no ranged reading here, and the bytes fetched once serve both the drawing
// and the editing.
//
// 让 PDF 编辑器成为一扇自己的窗。
//
// Markdown 与代码编辑器已经定下了"编辑器"在这里是什么:一个有地址的标签页,
// 开在网盘旁边而不是网盘里面,装着一份可以一直开着、能刷新、能回来的文档。
// 这里给 PDF 编辑器同样的身份。底下的机器一件没换 —— pdfui.js 负责指着东西,
// pdfedit.js 负责持有那串改动 —— 本模块添上的,只是预览从前在它们周围提供的那些:
// pdf.js 画出的页面、一次写回同一文件的保存,以及一扇站立其中的窗。
//
// 画任何东西之前先取回整个文件。编辑要写出一份文档,而一份文档没法用
// "某人碰巧看过的那几块"写出来 —— 所以与预览不同,这里没有 Range 读取,
// 取回一次的字节同时供绘制与编辑使用。

import { t, tErr } from '../i18n.js';
import { esc, icon, qs, toast, confirmDialog, showModal, closeModal } from '../ui.js';
import { store, setTitle } from '../app.js';
import { api } from '../api.js';
import { sha256Hex, tokenOf, stampOf, refreshThumb } from '../edit/session.js';
import { announceChange } from '../drive/fsrc.js';

const V = () => encodeURIComponent(store.brand?.version || '');

let pe = null; // { id, node, token, savedCount, session, task, swapTask, pager, doc, repaint, swapDoc }

let cssReady = null;
/** The Drive's stylesheet, which is where every pdfe-* rule already lives. Loaded here because
 *  this tab opens without the Drive ever having been on this page.
 *  网盘的样式表 —— 所有 pdfe-* 规则本来就住在那里。在这里加载,
 *  是因为这个标签页打开时,这个页面上可能从来没有开过网盘。 */
function ensureCss() {
  if (cssReady) return cssReady;
  if (document.querySelector('link[href^="/assets/drive/drive.css"]')) {
    cssReady = Promise.resolve();
    return cssReady;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `/assets/drive/drive.css?v=${V()}`;
  cssReady = new Promise((done) => {
    l.addEventListener('load', done, { once: true });
    l.addEventListener('error', done, { once: true });
  });
  document.head.appendChild(l);
  return cssReady;
}

/** The page container carries the preview's own classes on purpose: every rule the layers and
 *  the pages need is written against them, and a second copy of those rules would drift.
 *  页面容器有意穿着预览的那身类名:层与页面需要的每一条规则都是对着它们写的,
 *  这些规则的第二份副本只会渐渐走样。 */
function shell() {
  return `
  <div class="pdft-app">
    <div class="pdft-head">
      <span class="pdft-name" id="pdft-name"></span>
      <span class="pdft-dot" id="pdft-dot" title=""></span>
    </div>
    <div class="pdft-bar" id="pdft-bar"></div>
    <div class="pdft-main" id="pdft-main">
      <div class="pdft-box drv-pdf editing" id="pdft-box"></div>
    </div>
  </div>`;
}

/** Unsaved work is edits on the pages OR a password decided but not yet written into the file.
 *  没存的活儿,要么是页面上的改动,要么是一个已经定了、还没写进文件里的密码。 */
const dirty = () => !!pe?.session
  && (pe.session.changeCount !== pe.savedCount || (pe.passTarget ?? null) !== (pe.password ?? null));

function paintDot() {
  const dot = qs('#pdft-dot');
  if (!dot) return;
  dot.classList.toggle('on', dirty());
  dot.title = dirty() ? t('md_unsaved') : '';
}

// ---------- Entry ----------
// ---------- 入口 ----------

export async function renderPdfEditor(id) {
  await ensureCss();
  destroyState();
  document.body.classList.add('pdft-open');
  (qs('#app') || document.body).innerHTML = shell();
  // Registered with the same function objects every time, which is what makes re-entry -- one
  // #/pdf/ address replaced by another -- add nothing twice.
  // 每次都用同样的那几个函数对象注册,于是重入 —— 一个 #/pdf/ 地址换成另一个 —— 不会加出第二份。
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onLeave);
  window.addEventListener('hashchange', onHash);
  pe = { id, savedCount: 0 };
  const my = pe;
  try {
    const meta = await api('GET', `/api/drive/nodes/${encodeURIComponent(id)}/meta`);
    // Refused at the door rather than at the save: an editor a viewer may fill with changes it
    // will never accept is a trap, not a permission model.
    // 在门口拒绝,而不是在保存时:一个任由只读访客改上半天、最后却一概不收的编辑器,
    // 是一个陷阱,不是一套权限模型。
    if (meta.access === 'viewer') throw new Error('e_drive_forbidden');
    if (meta.node.kind !== 'file') throw new Error('e_drive_not_file');
    if (pe !== my) return;
    my.node = meta.node;
    my.token = tokenOf(meta.node);
    qs('#pdft-name').textContent = meta.node.name;
    setTitle(meta.node.name);
    const r = await fetch(`/api/drive/files/${encodeURIComponent(id)}/dl?inline=1&v=${encodeURIComponent(stampOf(meta.node))}`);
    if (!r.ok) throw new Error('e_drive_not_found');
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (pe !== my) return;
    await buildEditor(my, bytes);
  } catch (e) {
    if (pe === my) qs('#pdft-box').innerHTML = `<div class="pdft-err">${esc(tErr(e))}</div>`;
  }
}

// ---------- The viewer, and the editor over it ----------
// ---------- 查看器,以及盖在它上面的编辑器 ----------

async function buildEditor(my, bytes) {
  const box = qs('#pdft-box');
  const scroller = qs('#pdft-main');
  const thumb = await import('../drive/thumb.js');
  const lib = await thumb.pdfjs();
  // A copy goes to pdf.js, because getDocument carries its buffer off to the worker and the
  // original still has an editing session to serve.
  // 交给 pdf.js 的是一份副本:getDocument 会把它的缓冲带去 worker,
  // 而原件还要伺候一场编辑会话。
  let task = lib.getDocument(thumb.pdfDocOpts(bytes.slice()));
  my.task = task;
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    // A locked file: pdf.js names the refusal, qpdf opens it. The editing pipeline must hold
    // plaintext -- every object gets read -- so the file is laid open once, here, and the
    // password remembered so the save can lock it again.
    // 一份上了锁的文件:pdf.js 说出这声拒绝,qpdf 把它打开。编辑管线必须攥着明文 ——
    // 每个对象都要被读到 —— 所以文件在这里摊开一次,密码记下,好让保存时再锁回去。
    task.destroy().catch(() => {});
    const crypt = await import('../drive/pdfcrypt.js');
    if (!crypt.needsPassword(e)) throw e;
    // A password this browser already knows opens the file without a question; one that has
    // stopped being right is forgotten on the spot and the question returns.
    // 这台浏览器已经记得的密码,开门不必再问;不再正确的那条,当场忘掉,问题重新回来。
    let opened = null;
    const stored = crypt.pwStore.get(my.id);
    if (stored) {
      const got = await crypt.decrypt(bytes, stored);
      if (pe !== my) return;
      if (got.ok) opened = { bytes: got.bytes, password: stored };
      else crypt.pwStore.set(my.id, null);
    }
    if (!opened) {
      opened = await unlockLoop(crypt, bytes);
      if (pe !== my) return;
      if (!opened) {
        box.innerHTML = `<div class="pdft-err">${esc(t('pdfe_pw_need'))}</div>`;
        return;
      }
      crypt.pwStore.set(my.id, opened.password);
    }
    bytes = opened.bytes;
    my.password = opened.password;
    my.passTarget = opened.password;
    task = lib.getDocument(thumb.pdfDocOpts(bytes.slice()));
    my.task = task;
    doc = await task.promise;
  }
  if (pe !== my) { task.destroy().catch(() => {}); return; }
  my.doc = doc;

  const width = Math.min(Math.max(360, scroller.clientWidth - 56), 900);
  const p1 = await doc.getPage(1);
  const vp1 = p1.getViewport({ scale: 1 });
  const estH = Math.round((width * vp1.height) / vp1.width);
  if (pe !== my) return;
  box.innerHTML = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const d = document.createElement('div');
    d.className = 'drv-pdf-page pending';
    d.dataset.page = i;
    d.style.width = width + 'px';
    d.style.height = estH + 'px';
    d.innerHTML = `<div class="drv-loading"><div class="drv-spin"></div></div>`;
    box.appendChild(d);
  }

  const renderPage = async (holder) => {
    if (holder.dataset.done || pe !== my) return;
    holder.dataset.done = '1';
    try {
      const page = await my.doc.getPage(parseInt(holder.dataset.page, 10));
      if (pe !== my) return;
      const scale = width / page.getViewport({ scale: 1 }).width;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: scale * dpr });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise;
      if (pe !== my) return;
      holder.style.height = 'auto';
      holder.classList.remove('pending');
      holder.replaceChildren(c);
      if (my.session) await my.session.attach(holder, page, scale);
    } catch { /* one page failing must not stop the rest / 一页失败不该拖住其余 */ }
  };
  my.repaint = async (pageNo) => {
    const holder = [...box.children].find((d) => +d.dataset.page === pageNo);
    if (!holder) return;
    delete holder.dataset.done;
    await renderPage(holder);
  };
  my.swapDoc = async (edited) => {
    const t2 = lib.getDocument(thumb.pdfDocOpts(edited.buffer
      ? edited.buffer.slice(edited.byteOffset, edited.byteOffset + edited.byteLength)
      : edited));
    const nd = await t2.promise;
    if (pe !== my) { t2.destroy().catch(() => {}); return; }
    const old = my.swapTask;
    my.swapTask = t2;
    my.doc = nd;
    old?.destroy?.().catch?.(() => {});
    for (const d of box.children) if (d.dataset.done) delete d.dataset.done;
  };

  // The session first, the pager second: every page is then drawn with an editor already there
  // to hand its layer to, and none has to be revisited.
  // 会话在先,翻页器在后:于是每一页画出来时,都已经有一个编辑器等着接过它那一层,
  // 一页都不必回头再补。
  const { editSession } = await import('../drive/pdfui.js');
  my.session = await editSession({
    box,
    bytes,
    viewer: { repaint: (no) => my.repaint(no), swapDoc: (b) => my.swapDoc(b) },
    ui: {
      t,
      icon,
      exit: exitEditor,
      saveAs: saveOut,
      barHost: qs('#pdft-bar'),
      hasPassword: () => !!pe?.passTarget,
      password: pwDialog,
      extraDirty: () => (pe ? (pe.passTarget ?? null) !== (pe.password ?? null) : false),
    },
    onDirty: paintDot,
  });
  if (pe !== my) { my.session.destroy(); return; }
  const { lazyPages } = await import('../drive/lazypage.js');
  my.pager = lazyPages({ root: scroller, items: [...box.children], margin: 600, render: renderPage });
}

// ---------- Saving ----------
// ---------- 保存 ----------

/** Write the edited document back as a new version of the same file -- the same rule every other
 *  way of writing to this file follows. The version token makes the write conditional: naming a
 *  version somebody else has already replaced is refused, and the refusal says what to do.
 *  把编辑后的文档写回同一个文件,作为它的一个新版本 —— 与写入这个文件的其他每条路遵循同一条
 *  规矩。版本令牌让这次写入是有条件的:指认一个别人已经换掉的版本会被拒绝,而拒绝会说明该怎么办。 */
async function saveOut(out) {
  const my = pe;
  if (!my?.session) return;
  // The document is built plain; the lock goes on at the door. A file that had a password
  // keeps it, one whose password was changed or removed gets what was decided.
  // 文档以明文搭好;锁在门口才上。原本有密码的保持有,改过或移除过的,按定下的来。
  let body = out;
  if (my.passTarget) {
    const crypt = await import('../drive/pdfcrypt.js');
    const enc = await crypt.encrypt(out, my.passTarget);
    if (pe !== my) return;
    if (!enc.ok) {
      toast(tErr('e_request_failed'), true);
      return;
    }
    body = enc.bytes;
  }
  const hash = await sha256Hex(body);
  const q = `node=${encodeURIComponent(my.id)}&mime=application%2Fpdf&hash=${hash}`;
  const res = await fetch(`/api/drive/upload?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', ...(my.token ? { 'If-Match': `"${my.token}"` } : {}) },
    body,
  });
  const data = await res.json().catch(() => null);
  if (pe !== my) return;
  if (!res.ok) {
    toast(tErr(data?.error || 'e_request_failed'), true);
    return;
  }
  my.token = data?.ver_head || `${my.id}-${data?.updated_at || Date.now()}`;
  my.savedCount = my.session.changeCount;
  // What the file is locked with now is what this browser remembers about it -- a removed
  // password removes the memory too.
  // 文件现在用什么上锁,这台浏览器就记住什么 —— 密码摘了,记忆也一并摘掉。
  if (my.passTarget || my.password) {
    const crypt = await import('../drive/pdfcrypt.js');
    crypt.pwStore.set(my.id, my.passTarget || null);
  }
  my.password = my.passTarget ?? null;
  paintDot();
  my.session.refresh();
  announceChange(my.id, {
    updated_at: data?.updated_at || Date.now(),
    ver_head: data?.ver_head || null,
    size: body.byteLength,
    thumb: false,
    bumpVersions: !!data?.ver_head,
  });
  toast(t('pdfe_saved'));
  // A locked file keeps its thumbnail to itself -- rendering one would put the first page of a
  // password-protected document on an open shelf.
  // 上了锁的文件,缩略图也不外露 —— 渲染一张,等于把带密码文档的第一页摆上敞开的架子。
  if (!my.passTarget) void refreshThumb({ id: my.id, name: my.node.name }, out, 'application/pdf', V());
}

// ---------- Passwords ----------
// ---------- 密码 ----------

/** One password field in a modal, resolved to the string (may be empty) or null for cancel --
 *  the two answers a password question actually has.
 *  模态里的一格密码输入,解析为字符串(可以为空)或表示取消的 null ——
 *  一个密码问题真正拥有的两种回答。 */
export function askPassword(title, hint) {
  // A document password is not a login: the browser's password manager must neither offer to
  // save it nor fill it in. Where the browser can mask a plain text field, that is what this is
  // -- a masked text field is invisible to the manager; elsewhere, new-password and a name that
  // never repeats keep it at arm's length.
  // 文档密码不是登录:浏览器的密码管家既不该提出保存,也不该往里填。
  // 浏览器会给普通文本框打码的地方,就用打了码的文本框 —— 管家看不见它;
  // 其余地方,用 new-password 和一个绝不重复的 name,把管家挡在一臂之外。
  const masked = typeof CSS !== 'undefined' && CSS.supports?.('-webkit-text-security', 'disc');
  return new Promise((resolve) => {
    const d = showModal(`
      <div class="modal-body">
        <h3 style="margin:0 0 10px;font-size:15px">${esc(title)}</h3>
        ${hint ? `<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">${esc(hint)}</p>` : ''}
        <input id="pdft-pw" type="${masked ? 'text' : 'password'}" name="pw-${Math.random().toString(36).slice(2)}"
          autocomplete="${masked ? 'off' : 'new-password'}" spellcheck="false" autocapitalize="off"
          style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text);font-size:14px${masked ? ';-webkit-text-security:disc' : ''}">
      </div>
      <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
        <wa-button appearance="plain" data-x="cancel">${esc(t('cancel'))}</wa-button>
        <wa-button variant="brand" data-x="ok">${esc(t('confirm'))}</wa-button>
      </div>`);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const submit = () => {
      const v = qs('#pdft-pw', d)?.value ?? '';
      closeModal();
      finish(v);
    };
    d.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      if (b.dataset.x === 'ok') submit();
      else {
        closeModal();
        finish(null);
      }
    });
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    d.addEventListener('wa-hide', (e) => {
      if (e.target === d) finish(null);
    });
    customElements.whenDefined('wa-dialog').then(async () => {
      await d.updateComplete;
      qs('#pdft-pw', d)?.focus();
    });
  });
}

/** Ask until the file opens or the person gives up. A wrong password is an answer to try again
 *  on, not an error to die of. / 一直问到文件打开,或人放弃为止。密码不对是"再试一次"的回答,
 *  不是可以死掉的错误。 */
async function unlockLoop(crypt, bytes) {
  let title = t('pdfe_pw_need');
  for (;;) {
    const pw = await askPassword(title);
    if (pw == null) return null;
    if (!pw) continue;
    const got = await crypt.decrypt(bytes, pw);
    if (got.ok) return { bytes: got.bytes, password: pw };
    if (!got.badPassword) {
      toast(tErr('e_request_failed'), true);
      return null;
    }
    title = t('pdfe_pw_wrong');
  }
}

/** The lock button's dialog: set a password, change it, or -- by leaving the field empty --
 *  remove it. Nothing touches the file until the next save.
 *  锁按钮的对话框:设密码、改密码,或者留空把它摘掉。在下一次保存之前,文件本身分毫不动。 */
async function pwDialog() {
  const my = pe;
  if (!my) return;
  const had = !!my.passTarget;
  const v = await askPassword(
    t(had ? 'pdfe_pw_change' : 'pdfe_pw_set'),
    had ? t('pdfe_pw_blank') : '',
  );
  if (pe !== my || v == null) return;
  if (v) my.passTarget = v;
  else if (had) my.passTarget = null;
  else return;
  toast(t(my.passTarget ? 'pdfe_pw_on' : 'pdfe_pw_off'));
  paintDot();
  my.session?.refresh();
}

// ---------- Leaving ----------
// ---------- 离开 ----------

/** The bar's way out. A tab this module opened closes itself; one somebody reached by address has
 *  no opener to close back to, and falls through to the Drive.
 *  工具条上的出口。本模块开出来的标签页把自己关掉;循地址而来的那种没有"开它的人"可以关回去,
 *  就退到网盘去。 */
async function exitEditor() {
  const my = pe;
  if (dirty() && !(await confirmDialog(t('pdfe_discard'), t('pdfe_discard_ok')))) return;
  if (pe !== my) return;
  my.savedCount = my.session?.changeCount ?? 0; // discarded on purpose; the unload guard stands down / 特意放弃了,卸载守卫就此立正稍息
  my.passTarget = my.password ?? null;
  window.close();
  setTimeout(() => { location.hash = '#/drive'; }, 150);
}

function onKey(e) {
  if (pe?.session?.keys(e)) e.preventDefault();
  // Saving belongs to the document; even with nothing to save, the browser's own dialog must not
  // appear over it. / 保存属于这份文档;即使没什么可存,浏览器自己的对话框也不该盖上来。
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') e.preventDefault();
}

function onLeave(e) {
  if (!dirty()) return;
  e.preventDefault();
  e.returnValue = '';
}

function onHash() {
  const h = location.hash;
  if (h.startsWith('#/') && !h.startsWith('#/pdf/')) closePdfEditor();
}

function destroyState() {
  pe?.pager?.destroy();
  pe?.session?.destroy();
  pe?.swapTask?.destroy?.().catch?.(() => {});
  pe?.task?.destroy?.().catch?.(() => {});
  pe = null;
}

export function closePdfEditor() {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', onLeave);
  window.removeEventListener('hashchange', onHash);
  destroyState();
  document.body.classList.remove('pdft-open');
}
