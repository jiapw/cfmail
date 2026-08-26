// Watching a document being presented, from a link and without an account.
//
// This is the other end of the meeting. The person presenting has the file open in the editor;
// everybody else was handed a link, and this is what that link opens into. It is deliberately not
// the preview overlay: a preview is something you glance into and dismiss, and this is something
// you sit in front of for half an hour while somebody talks.
//
// It can do exactly two things, and the second one is optional. It follows -- the text as it is
// typed, the place in the document being looked at -- and, if the link was given the meeting pen,
// it can draw. It cannot edit, cannot save, and cannot become the presenter, because the link it
// came from is read-only and stays read-only. None of that is enforced here; it is enforced where
// it has to be, in the room, against the share the visitor actually holds.
//
// 从一条链接、没有账号,看别人演示一份文档。
//
// 这是会议的另一端。演示的那个人在编辑器里开着这份文件;其余的人拿到的是一条链接,
// 而这就是那条链接打开的东西。它刻意不是那个预览浮层:预览是你瞥一眼就关掉的东西,
// 而这是你会在它面前坐上半小时、听人讲话的东西。
//
// 它只能做两件事,而且第二件是可选的。它跟着看 —— 正被敲出来的文字、正被看着的位置 ——
// 并且,如果那条链接被给了会议的笔,它还能画。它不能编辑、不能保存、也不能成为演示者,
// 因为它所来自的那条链接是只读的,并且继续只读。这些都不是在这里把关的;
// 把关在它必须发生的地方 —— 在房间里,对着访客真正持有的那条分享。
import { t, tErr } from '../i18n.js';
import { esc, icon, qs } from '../ui.js';
import { store, navigate } from '../app.js';
import { dlUrl, metaUrl } from './fsrc.js';
import { lerp, measure, scanBlocks, tagLines } from '../md/anchor.js';
import { docClick, ensureCss as ensureMdCss, loadLibs, mdFragment } from '../md/render.js';
import { joinPresentation, renderRoster } from '../edit/present.js';
import { attachInk } from '../edit/annot.js';
import { attachMarks } from '../edit/mark.js';

/** What a visitor calls themselves. There is no account to take it from, so it is theirs to say
 *  and theirs to change; it is kept per browser rather than per link, because it is a fact about
 *  the person and not about the document they were sent.
 *  访客自称什么。这里没有账号可取,所以它由他自己说、也由他自己改;
 *  它按浏览器存而不是按链接存,因为它是关于这个人的事实,不是关于他被发来的那份文档的。 */
const NAME_KEY = 'cf_present_name';
const myName = () => {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
};

let w = null;

function shell(name) {
  return `
  <div class="pw">
    <div class="pw-head">
      <wa-button class="icon" appearance="plain" id="pw-back" title="${esc(t('pr_back_files'))}">${icon('back', 18)}</wa-button>
      <span class="pw-name">${esc(name)}</span>
      <span class="pw-sp"></span>
      <span id="pw-peers"></span>
      <input id="pw-me" class="pw-me" maxlength="32" placeholder="${esc(t('pr_your_name'))}" value="${esc(myName())}">
      <wa-button class="icon pr-hide" appearance="plain" id="pw-pen" title="${esc(t('pr_pen'))}">${icon('pencil', 18)}</wa-button>
      <wa-button class="icon pr-hide" appearance="plain" id="pw-rect" title="${esc(t('pr_rect'))}">${icon('select', 18)}</wa-button>
    </div>
    <div class="pw-body" id="pw-view"><article class="md-doc" id="pw-doc"></article></div>
    <button type="button" class="pr-back" id="pw-follow">${icon('eye', 15)}${esc(t('pr_back'))}</button>
  </div>`;
}

let paintTimer = null;
const schedulePaint = () => { clearTimeout(paintTimer); paintTimer = setTimeout(paint, 140); };

/** Render what is currently held. Everything about how a Markdown document becomes a page is the
 *  editor's own -- the same parser, the same sanitiser, the same stylesheet -- so a recipient sees
 *  what the presenter sees rather than a second, nearly-identical rendering of it.
 *  渲染此刻手上的东西。"一份 Markdown 怎么变成一页"的全部,都是编辑器自己的那套 ——
 *  同一个解析器、同一个消毒器、同一份样式表 —— 于是接收方看到的是演示者看到的东西,
 *  而不是它的第二份、几乎一样的渲染。 */
async function paint() {
  if (!w) return;
  const box = qs('#pw-doc');
  if (!box) return;
  const gen = ++w.gen;
  const src = w.src;
  const { marked } = await loadLibs();
  const frag = await mdFragment(src, w.parent);
  if (!w || w.gen !== gen || !box.isConnected) return;
  box.replaceChildren(tagLines(frag, scanBlocks(marked, src)));
  w.marks = measure(qs('#pw-view'), box);
  // The document the highlight sat on has just been replaced.
  // 高亮所依附的那份文档刚刚被换掉了。
  w.mark?.redraw();
}

const adapter = {
  getContent: () => w?.src ?? '',
  applyContent(text) {
    if (!w || w.src === text) return;
    w.src = text;
    schedulePaint();
  },
  // A watcher is never the presenter, so nobody ever asks this one where they are looking.
  // 旁观者永远不是演示者,所以没有人会问这一个"你在看哪儿"。
  getAnchor: () => null,
  scrollToAnchor(line) {
    const view = qs('#pw-view');
    if (!w || !view || !w.marks.length || typeof line !== 'number') return;
    // Marked as ours so the scroll handler below does not read it as the visitor asking to look
    // somewhere else -- which is the one thing that turns following off.
    // 标记成"我们干的",好让下面那个滚动处理器不把它读成访客想看别处 ——
    // 而那正是唯一会关掉跟随的事。
    w.syncing = true;
    view.scrollTop = lerp(w.marks, 'line', 'top', line);
    requestAnimationFrame(() => { if (w) w.syncing = false; });
  },
};

const inkAdapter = {
  host: () => qs('#pw-view'),
  box: () => qs('#pw-doc'),
  lineAt: (y) => (w?.marks?.length ? lerp(w.marks, 'top', 'line', y) : null),
  topOf: (line) => (w?.marks?.length ? lerp(w.marks, 'line', 'top', line) : 0),
};

function applyState(st) {
  if (!w) return;
  renderRoster(qs('#pw-peers'), st);
  const room = st.live && st.peers.length > 1;
  qs('#pw-follow')?.classList.toggle('on', room && !st.following);
  // Same rule as the editor: the pen is a tool, not a thing that waits for company.
  // 与编辑器同一条规矩:笔是一件工具,不是一件要等人来了才出现的东西。
  const showInk = st.live && st.canInk;
  qs('#pw-pen')?.classList.toggle('pr-hide', !showInk);
  qs('#pw-rect')?.classList.toggle('pr-hide', !showInk);
  if (!showInk && w.ink) w.ink.setTool(null);
  paintTools();
}

function paintTools() {
  const cur = w?.ink?.tool() || null;
  qs('#pw-pen')?.classList.toggle('on', cur === 'pen');
  qs('#pw-rect')?.classList.toggle('on', cur === 'rect');
}

function pickTool(k) {
  if (!w?.ink) return;
  w.ink.setTool(w.ink.tool() === k ? null : k);
  paintTools();
}

/** Join, or join again under a new name. The name travels in the handshake, so changing it means
 *  arriving again -- which costs one socket and nothing else, the room having no memory to lose.
 *  加入,或换个名字重新加入。名字是在握手时递过去的,所以改名意味着重新到场一次 ——
 *  代价是一条 socket,别无其他:房间本来就没有记忆可丢。 */
function join() {
  if (!w) return;
  w.mark?.destroy();
  w.mark = null;
  w.ink?.destroy();
  w.ink = null;
  w.pres?.leave();
  w.pres = null;
  joinPresentation({
    id: w.id,
    share: w.token,
    name: myName(),
    adapter,
    version: store.brand?.version || '',
  }).then((s) => {
    if (!w) { s.leave(); return; }
    w.pres = s;
    s.on('state', applyState);
    w.ink = attachInk(s, inkAdapter);
    // No source pane here, so nothing to gather from: a watcher only ever receives a selection.
    // 这里没有源码面板,也就无从采集:旁观者只会收到选区,从不发出。
    w.mark = attachMarks(s, { box: () => qs('#pw-doc') });
  }).catch(() => { /* the room is unreachable; the document is still readable / 房间连不上,文档照样读得了 */ });
}

/** Open one shared document in watching mode.
 *  以观看模式打开一份被分享的文档。 */
export async function renderPubWatch(token, id, head) {
  ensureMdCss();
  const app = qs('#app');
  let node;
  let src;
  try {
    const meta = await (await fetch(metaUrl(id))).json();
    node = meta.node;
    if (!node || node.kind !== 'file') throw new Error('e_drive_not_found');
    const r = await fetch(dlUrl(id, 1, node.ver_head || node.updated_at || ''));
    if (!r.ok) throw new Error('e_drive_not_found');
    src = new TextDecoder('utf-8').decode(await r.arrayBuffer());
  } catch (e) {
    app.innerHTML = `<div class="pub-wrap"><p class="md-err">${esc(tErr(e))}</p></div>`;
    return;
  }

  document.body.classList.add('pw-open');
  app.innerHTML = shell(node.name);
  w = { token, id, src, parent: node.parent_id || 'root', gen: 0, marks: [], syncing: false, pres: null, ink: null, mark: null };
  document.title = node.name;

  qs('#pw-back').addEventListener('click', () => navigate(`#/p/${encodeURIComponent(token)}`));
  qs('#pw-doc').addEventListener('click', (e) => docClick(e, qs('#pw-doc'), w.parent));
  qs('#pw-pen').addEventListener('click', () => pickTool('pen'));
  qs('#pw-rect').addEventListener('click', () => pickTool('rect'));
  qs('#pw-follow').addEventListener('click', () => w?.pres?.follow(true));
  // Scrolling for yourself is how you say you want to look somewhere else.
  // 自己滚,就是在说"我想看别处"。
  qs('#pw-view').addEventListener('scroll', () => {
    if (!w || w.syncing || !w.pres) return;
    if (w.pres.state.following) w.pres.follow(false);
  }, { passive: true });
  const nameBox = qs('#pw-me');
  nameBox.addEventListener('change', () => {
    try { localStorage.setItem(NAME_KEY, nameBox.value.trim().slice(0, 32)); } catch { /* private mode / 隐私模式 */ }
    join();
  });
  window.addEventListener('hashchange', onHash);
  window.addEventListener('resize', onResize);

  await paint();
  // The pen is only offered when the link carries it, and the link is asked rather than assumed:
  // the same page serves links that have it and links that do not.
  // 只有链接带着那支笔时才提供它,而这要去问、不能假定:
  // 同一个页面既服务带笔的链接,也服务不带的。
  if (head?.meet) join();
}

let resizeTimer = null;
function onResize() {
  clearTimeout(resizeTimer);
  // The map is a measurement of a particular width; change the width and it describes a layout
  // that no longer exists.
  // 这份映射是在某个特定宽度下量出来的;宽度一变,它描述的就是一个已不存在的排布。
  resizeTimer = setTimeout(() => { if (w) w.marks = measure(qs('#pw-view'), qs('#pw-doc')); }, 150);
}

function onHash() {
  if (!location.hash.includes('/watch/')) closeWatch();
}

export function closeWatch() {
  window.removeEventListener('hashchange', onHash);
  window.removeEventListener('resize', onResize);
  clearTimeout(resizeTimer);
  clearTimeout(paintTimer);
  w?.mark?.destroy();
  w?.ink?.destroy();
  w?.pres?.leave();
  document.body.classList.remove('pw-open');
  w = null;
}
