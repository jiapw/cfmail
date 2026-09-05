// The watcher's surface: a document being presented, seen from the room.
//
// It is deliberately not the preview overlay -- a preview is something you glance into and
// dismiss, and this is something you sit in front of for half an hour while somebody talks. Two
// kinds of people arrive here: link holders with no account, and signed-in people who followed
// the same presentation from inside the drive. Both watch the same way; only the door differs.
//
// It follows -- the text as it is typed, the place being looked at -- and it can draw, exactly
// while the presenter says pens are out. It cannot edit and cannot save. One more thing it can
// do, on purpose: LEAD. A signed-in person who cannot edit the file still has things to say
// about it, and presenting-by-pointing needs no keyboard -- so opened with the present flag,
// this surface asks for the chair and drives the room's scroll and ink. The text stream simply
// never fires, there being nothing here that could produce an edit.
//
// 旁观界面:从房间这一侧,看一份正被演示的文档。
//
// 它刻意不是那个预览浮层 —— 预览是你瞥一眼就关掉的东西,而这是你会在它面前坐上半小时、
// 听人讲话的东西。到这里来的有两种人:持链接、没账号的,和从网盘里跟进同一场演示的登录用户。
// 两种人以同一种方式观看;不同的只是进来的门。
//
// 它跟着看 —— 正被敲出来的文字、正被看着的位置 —— 也能画,恰恰只在演示者说笔放开的那段时间。
// 它不能编辑、不能保存。它还特意能做一件事:主持。一个改不了文件的登录用户,
// 对这份文件仍然有话要说,而"靠指来演示"不需要键盘 —— 所以带着演示标记打开时,
// 这个界面会去要那把椅子,驱动全房间的滚动与墨水。文本流则根本不会触发:
// 这里没有任何能产生编辑的东西。
import { t, tErr } from '../i18n.js';
import { esc, icon, qs } from '../ui.js';
import { store, navigate } from '../app.js';
import { dlUrl, metaUrl, useDriveSource, usePubSource } from './fsrc.js';
import { lerp, measure, scanBlocks, tagLines } from '../md/anchor.js';
import { docClick, ensureCss as ensureMdCss, loadLibs, mdFragment } from '../md/render.js';
import { joinPresentation } from '../edit/present.js';
import { attachInk } from '../edit/annot.js';
import { attachMarks } from '../edit/mark.js';
import { attachPresentBar } from '../edit/prbar.js';

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
    </div>
    <div class="pw-body" id="pw-view"><article class="md-doc" id="pw-doc"></article></div>
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
  /** Where this surface is looking, as a source line. Only ever read while this tab leads.
   *  这个界面在看哪儿,用源码行号表示。只有本页主持时才会被读到。 */
  getAnchor() {
    const view = qs('#pw-view');
    if (!w || !view || !w.marks.length) return null;
    return lerp(w.marks, 'top', 'line', view.scrollTop);
  },
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
  w.bar?.destroy();
  w.bar = null;
  joinPresentation({
    id: w.id,
    share: w.token,
    name: w.token ? myName() : '',
    lead: !!w.lead,
    adapter,
    version: store.brand?.version || '',
  }).then((s) => {
    if (!w) { s.leave(); return; }
    w.pres = s;
    w.ink = attachInk(s, inkAdapter);
    // Selections are received here and, when this tab leads, gathered from the rendered page:
    // mark.js reads the DOM selection when there is no source box to ask.
    // 选区在这里被接收;本页主持时,也从渲染页上采集 ——
    // 没有源码框可问的时候,mark.js 读的是 DOM 选区。
    w.mark = attachMarks(s, { box: () => qs('#pw-doc') });
    w.bar = attachPresentBar(s, {
      ink: w.ink,
      guestPath: 'watch',
      guest: !!w.token,
      // Same shape as the editor's stop: the surface stays, only the chair is given up.
      // 与编辑器的结束同一个形状:界面留着,只交出那把椅子。
      onStop: w.lead ? () => {
        w.lead = false;
        if (location.hash.endsWith('/present')) {
          history.replaceState(null, '', location.pathname + location.hash.replace(/\/present$/, ''));
        }
        join();
      } : null,
      name: myName(),
      onRename(name) {
        try { localStorage.setItem(NAME_KEY, name); } catch { /* private mode / 隐私模式 */ }
        join();
      },
    });
  }).catch(() => { /* the room is unreachable; the document is still readable / 房间连不上,文档照样读得了 */ });
}

/** Open one document on the watcher surface. `token` empty means a signed-in visitor coming
 *  through the drive's own door; `lead` means this tab is here to present, not to watch.
 *  在旁观界面上打开一份文档。token 为空表示登录用户走网盘自己的门进来;
 *  lead 表示这一页是来演示的,不是来看的。 */
export async function renderWatch(token, id, lead) {
  if (token) usePubSource(token); else useDriveSource();
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
  w = { token: token || '', id, lead: !!lead, src, parent: node.parent_id || 'root',
        gen: 0, marks: [], syncing: false, pres: null, ink: null, mark: null, bar: null };
  document.title = node.name;

  qs('#pw-back').addEventListener('click', () =>
    navigate(token ? `#/p/${encodeURIComponent(token)}` : '#/drive'));
  qs('#pw-doc').addEventListener('click', (e) => docClick(e, qs('#pw-doc'), w.parent));
  // Scrolling for yourself is how you say you want to look somewhere else. A leader is exempt:
  // their scroll is not a departure from the presentation, it is the presentation.
  // 自己滚,就是在说"我想看别处"。主持者除外:他的滚动不是离开演示,它就是演示。
  qs('#pw-view').addEventListener('scroll', () => {
    if (!w || w.syncing || !w.pres) return;
    if (w.pres.state.seat === 'presenter') return;
    if (w.pres.state.following) w.pres.follow(false);
  }, { passive: true });
  window.addEventListener('hashchange', onHash);
  window.addEventListener('resize', onResize);

  await paint();
  // Everybody who arrives joins: this page exists for the meeting, and a room with nobody
  // presenting yet is still the place the meeting will happen.
  // 到了的人就进房间:这一页为会议而存在,而一间还没人演示的房,也已经是会议将要发生的地方。
  join();
}

/** The pub route's door, kept under its old name. / 公开路由的门,沿用旧名。 */
export const renderPubWatch = (token, id) => renderWatch(token, id, false);

let resizeTimer = null;
function onResize() {
  clearTimeout(resizeTimer);
  // The map is a measurement of a particular width; change the width and it describes a layout
  // that no longer exists.
  // 这份映射是在某个特定宽度下量出来的;宽度一变,它描述的就是一个已不存在的排布。
  resizeTimer = setTimeout(() => { if (w) w.marks = measure(qs('#pw-view'), qs('#pw-doc')); }, 150);
}

function onHash() {
  if (!location.hash.includes('/watch')) closeWatch();
}

export function closeWatch() {
  window.removeEventListener('hashchange', onHash);
  window.removeEventListener('resize', onResize);
  clearTimeout(resizeTimer);
  clearTimeout(paintTimer);
  w?.bar?.destroy();
  w?.mark?.destroy();
  w?.ink?.destroy();
  w?.pres?.leave();
  document.body.classList.remove('pw-open');
  w = null;
}
