// The meeting's controls, in one floating bar.
//
// Presenting happens over many kinds of surface -- an editor, a watcher's page, a full-window
// preview -- and every one of them needs the same handful of things: who is here, the pen and the
// box, the presenter's switch that puts everybody's pens out, the way to take an empty chair, and
// the way to stop. Building those into each surface would mean the meeting looking different in
// every room it happens in. So they live here, on a bar that floats over whatever the surface is,
// and a surface that wants presenting mounts the bar instead of growing controls of its own.
//
// The bar draws itself from the session's state and only from it: it holds nothing, decides
// nothing, and every button is a message to the room. What the room refuses simply does not
// happen, and the bar repaints to whatever is actually true.
//
// 会议的控制件,集中在一条浮动条里。
//
// 演示发生在很多种界面之上 —— 编辑器、旁观页、全窗预览 —— 而每一种需要的是同一小把东西:
// 谁在场、笔和框、演示者那个放开所有人笔的开关、坐上空椅子的入口、以及停下来的办法。
// 把这些各自长进每个界面,会让同一场会在每间屋里长得都不一样。
// 所以它们住在这里:一条浮在任何界面之上的条。想要演示能力的界面挂上这条,
// 而不是自己长出控制件。
//
// 这条从会话状态画出自己,并且只从它:它什么都不持有、什么都不决定,
// 每个按钮都只是发给房间的一条消息。房间拒绝的事就是不会发生,而条会重画成真正成立的样子。
import { t, lang } from '../i18n.js';
import { api } from '../api.js';
import { copyText, esc, icon, qs, toast } from '../ui.js';
import { renderRoster } from './present.js';

/** The guest link, minted at most once per bar.
 *
 *  It is minted the FIRST time the presenter asks for it, not when presenting starts: a room of
 *  colleagues who all have their own way in needs no link, and a link nobody asked for is one
 *  more thing the owner later wonders about revoking. Asked again, the same link is shown again
 *  -- a link is an address, and a second address to the same meeting helps nobody.
 *
 *  Minting reuses a live presentation link for the same file when one has at least half a day
 *  left, so presenting the same document tomorrow does not grow a pile of near-twins.
 *
 *  访客链接,每条 bar 至多铸一次。
 *
 *  它在演示者第一次要它时才铸,而不是演示一开始就铸:一屋子本来就有门进来的同事不需要链接,
 *  而一条没人要过的链接,是所有者日后要多惦记一件"要不要撤销"的东西。
 *  再要一次,给的还是同一条 —— 链接是地址,同一场会的第二个地址帮不到任何人。
 *
 *  铸的时候会复用同一文件还剩至少半天寿命的演示链接,
 *  于是明天再演示同一份文档,不会堆出一摞近亲。 */
async function mintLink(id, guestPath) {
  let share = null;
  try {
    const all = (await api('GET', '/api/drive/shares')).shares || [];
    share = all.find((x) => x.audience === 'public' && x.meet && !x.revoked_at
      && (!x.expires_at || x.expires_at - Date.now() > 12 * 3600 * 1000)
      && (x.items || []).length === 1 && x.items[0].id === id) || null;
  } catch { /* minting below still answers / 下面照样能铸 */ }
  if (!share) {
    share = await api('POST', '/api/drive/shares', {
      nodes: [id], audience: 'public', role: 'viewer', expires_days: 1, meet: 1,
      theme: document.documentElement.dataset.theme || null,
      mode: document.documentElement.classList.contains('wa-dark') ? 'dark' : 'light',
      lang: lang(),
    });
  }
  return `${location.origin}${location.pathname}#/p/${encodeURIComponent(share.token)}/`
    + `${guestPath}/${encodeURIComponent(id)}`;
}

/** Mount the bar for one session.
 *
 *  opts.ink        -> the ink layer's controller ({setTool, tool}), or null for a surface with no ink
 *  opts.onStop     -> called when the presenter presses stop; its absence hides the button
 *  opts.onToolPicked -> told when a pen is taken up, so a surface can e.g. reveal its preview pane
 *  opts.guest      -> show the self-declared-name box (wired through opts.onRename)
 *
 *  为一个会话挂上这条。opts 的四件事如上。 */
export function attachPresentBar(session, opts = {}) {
  const el = document.createElement('div');
  el.className = 'pr-bar';
  el.innerHTML = `
    <span class="pr-bar-peers"></span>
    <wa-button class="icon pr-bar-follow pr-hide" appearance="plain"
      title="${esc(t('pr_back'))}">${icon('eye', 17)}</wa-button>
    ${opts.guest ? `<input class="pw-me pr-bar-name" maxlength="32" placeholder="${esc(t('pr_your_name'))}">` : ''}
    <span class="pr-bar-sep"></span>
    <wa-button class="icon pr-bar-pen" appearance="plain" title="${esc(t('pr_pen'))}">${icon('pencil', 17)}</wa-button>
    <wa-button class="icon pr-bar-rect" appearance="plain" title="${esc(t('pr_rect'))}">${icon('select', 17)}</wa-button>
    <span class="pr-bar-sep pr-bar-lead"></span>
    <label class="pr-bar-open pr-bar-lead"><input type="checkbox" class="pr-bar-ink">${esc(t('pr_allow_ink'))}</label>
    <wa-button class="icon pr-bar-link pr-bar-lead" appearance="plain" title="${esc(t('pr_invite'))}">${icon('link', 17)}</wa-button>
    <wa-button size="small" appearance="outlined" class="pr-bar-claim">${esc(t('pr_claim'))}</wa-button>
    <wa-button size="small" appearance="outlined" class="pr-bar-stop pr-bar-lead">${esc(t('pr_stop'))}</wa-button>
    <div class="pr-bar-pop pr-hide">
      <div class="pr-bar-pop-row">
        <input readonly class="pr-bar-url" onclick="this.select()">
        <wa-button size="small" class="pr-bar-copy">${icon('copy', 15)} ${esc(t('drv_copy_link'))}</wa-button>
      </div>
      <p class="pr-bar-pop-hint">${esc(t('pr_link_hint'))}</p>
    </div>`;
  document.body.appendChild(el);

  const $ = (sel) => qs(sel, el);

  const paintTools = () => {
    const cur = opts.ink?.tool() || null;
    $('.pr-bar-pen')?.classList.toggle('on', cur === 'pen');
    $('.pr-bar-rect')?.classList.toggle('on', cur === 'rect');
  };

  const pick = (k) => {
    if (!opts.ink) return;
    const on = opts.ink.setTool(opts.ink.tool() === k ? null : k);
    if (on) opts.onToolPicked?.(on);
    paintTools();
  };

  function paint(st) {
    // The bar exists while a meeting does: while this tab presents, or somebody else does. Alone
    // in the room and not presenting, there is nothing to control and nothing to show.
    // 这条在"有会"的时候存在:本页在演示,或别人在演示。屋里只有自己、又没在演示,
    // 就没有什么可控制,也没有什么可显示。
    const meeting = st.live && (st.seat === 'presenter' || !!st.presenter || st.peers.length > 1);
    el.classList.toggle('on', meeting);
    if (!meeting) return;
    renderRoster($('.pr-bar-peers'), st);
    const lead = st.seat === 'presenter';
    // The way back to following, for a watcher who scrolled off on their own. On the bar rather
    // than floating loose: every control of the meeting lives here.
    // 自己滚开了的旁观者回到跟随的那条路。放在条上而不是散落漂浮:会议的每个控制件都住这里。
    $('.pr-bar-follow').classList.toggle('pr-hide', lead || !st.presenter || st.following);
    $('.pr-bar-pen').classList.toggle('pr-hide', !st.canInk || !opts.ink);
    $('.pr-bar-rect').classList.toggle('pr-hide', !st.canInk || !opts.ink);
    // Everything in the presenter's cluster -- the separator, the audience switch, the invite
    // link, stop -- appears and disappears as one thing, because it is one thing: the chair.
    // 演示者那一簇 —— 分隔线、观众开关、邀请链接、结束 —— 一起出现一起消失,
    // 因为它们本来就是同一样东西:那把椅子。
    for (const n of Array.from(el.querySelectorAll('.pr-bar-lead'))) n.classList.toggle('pr-hide', !lead);
    $('.pr-bar-stop')?.classList.toggle('pr-hide', !lead || !opts.onStop);
    $('.pr-bar-link')?.classList.toggle('pr-hide', !lead || !opts.guestPath);
    $('.pr-bar-ink').checked = !!st.inkOpen;
    $('.pr-bar-claim').classList.toggle('pr-hide', lead || !st.canLead || !!st.presenter);
    if (!lead) $('.pr-bar-pop').classList.add('pr-hide');
    if (!st.canInk) { opts.ink?.setTool(null); }
    paintTools();
  }

  $('.pr-bar-follow').addEventListener('click', () => session.follow(true));
  $('.pr-bar-pen').addEventListener('click', () => pick('pen'));
  $('.pr-bar-rect').addEventListener('click', () => pick('rect'));
  $('.pr-bar-ink').addEventListener('change', (e) => session.setInkOpen(e.target.checked));
  // First press mints; every later press only shows what was minted. `minting` keeps a double
  // press from minting twice while the first request is still out.
  // 第一次按下才铸;之后每一次按下,只是把铸好的拿出来看。`minting` 挡住第一次请求
  // 还在路上时的连按,免得铸出两条。
  let link = '';
  let minting = false;
  $('.pr-bar-link').addEventListener('click', async () => {
    const pop = $('.pr-bar-pop');
    if (!pop.classList.contains('pr-hide')) { pop.classList.add('pr-hide'); return; }
    pop.classList.remove('pr-hide');
    if (link || minting) return;
    minting = true;
    const url = $('.pr-bar-url');
    url.value = t('loading');
    try {
      link = await mintLink(session.state.id, opts.guestPath);
      url.value = link;
    } catch {
      // Shares are the owner's to mint; an editor presenting sees why instead of a failure.
      // 分享归所有者铸;正在演示的编辑者看到的是原因,而不是一次失败。
      url.value = '';
      url.placeholder = t('pr_owner_link_only');
    } finally {
      minting = false;
    }
  });
  $('.pr-bar-copy').addEventListener('click', async () => {
    if (!link) return;
    await copyText(link);
    toast(t('drv_link_copied'));
  });
  $('.pr-bar-claim').addEventListener('click', () => session.claim());
  $('.pr-bar-stop').addEventListener('click', () => opts.onStop?.());
  const name = $('.pr-bar-name');
  if (name) {
    name.value = opts.name || '';
    name.addEventListener('change', () => opts.onRename?.(name.value.trim().slice(0, 32)));
  }

  session.on('state', paint);
  paint(session.state);

  return {
    destroy() {
      el.remove();
    },
  };
}
