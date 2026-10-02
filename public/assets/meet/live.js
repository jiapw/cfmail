// Watching a broadcast meeting.
//
// The audience is not in the room. They are on nobody's roster, and there may be ten thousand of
// them; what they get is one video, the one the compositor makes, played from Stream. Beside it,
// when the organiser allows it, is the audience's chat -- with each other and with the people on
// the stage -- and a way to ask to speak: a host who says yes hands this one viewer a ticket, and
// the page walks them into the room.
//
// While the meeting is not on air the page waits. It does not keep asking: the audience's hall
// says when the broadcast starts and stops, and the page only goes to look for itself while it
// cannot reach the hall. (Asking every few seconds is what used to lock people out: an office
// that opened the page early had spent its hour's allowance before the broadcast began.)
//
// Like the room's own page it opens for people who are not signed in, and is handled before the
// sign-in gate. Whether such a person may watch is the organiser's choice, and it is enforced
// where it cannot be walked around: the address is only handed out to somebody allowed to have
// it, and the video refuses to play from any other.
//
// 旁观一场直播会议。
//
// 旁观者不在房间里。他们不在任何人的名册上,而且可能有一万人;他们拿到的是一路视频 —— 合成器做出来的那一路 ——
// 从 Stream 播放。组织者允许时,旁边是观众的聊天 —— 观众之间,以及与台上的人 —— 还有申请发言的办法:
// 主持人点头,就给这一位观众一张入场券,页面领着他走进会场。
//
// 会议还没开播时页面就等着。它不会一直去问:观众总台会说什么时候开播、什么时候停播;
// 只有连不上总台的时候,页面才自己去看一眼。(每隔几秒问一次,正是过去把人锁在外面的原因:
// 提前打开页面的一整个办公室,还没开播就用光了这一小时的额度。)
//
// 和房间自己的页面一样,它对未登录的人打开,并在登录判定之前处理。这样的人能不能看,是组织者的选择,
// 并且在一个绕不过去的地方被执行:地址只发给获准拥有它的人,而视频拒绝从任何别的地址播放。
import { api } from '../api.js';
import { t, tErr, lang } from '../i18n.js';
import { esc, icon, qs, loadCss, toast, showModal, closeModal } from '../ui.js';
import { store, show, setTitle } from '../app.js';
import { audLineHtml, joinAudience, mergeLines } from './audience.js';

/** How often the page looks for itself, while the hall cannot tell it. / 总台告诉不了它的时候,页面自己多久看一眼。 */
const POLL_MS = 30000;
const POLL_ALONE_MS = 10000;
const RETRY_MS = [2000, 3000, 4000, 6000, 8000];
let L = null;

// A way for a test to look inside, on localhost only. / 让测试能往里看一眼,仅限 localhost。
if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__cfLive = () => L;

window.addEventListener('hashchange', () => { if (L && !location.hash.startsWith(`#/live/${L.code}`)) stop(); });
window.addEventListener('pagehide', () => { if (L) stop(); });

function stop() {
  const l = L;
  L = null;
  if (!l) return;
  clearTimeout(l.poll);
  clearTimeout(l.retry);
  try { l.hls?.destroy(); } catch { /* gone / 已无 */ }
  try { l.aud?.close(); } catch { /* gone / 已无 */ }
}

function notice(ic, text, actions = '') {
  show(`<div class="mt-notice">${icon(ic, 48)}<div class="mt-notice-t">${esc(text)}</div><div class="mt-notice-a">${actions}</div></div>`);
}

const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode / 隐私模式 */ } };

/** Who this browser is in this meeting's audience: an id of its own, and -- once a name was
 *  given -- the card that says so. Kept on the device, so a reload is the same viewer.
 *  这个浏览器在这场会议的观众席上是谁:它自己的一个 id,以及 —— 留过名之后 —— 证明这一点的卡。
 *  存在本机,所以刷新之后还是同一个观众。 */
function kept(code) {
  let k = {};
  try { k = JSON.parse(lsGet(`cf_live_${code}`) || '{}') || {}; } catch { /* start over / 从头来 */ }
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(k.vid || '')) {
    const b = crypto.getRandomValues(new Uint8Array(12));
    k = { vid: btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
    lsSet(`cf_live_${code}`, JSON.stringify(k));
  }
  return k;
}

export async function renderLive(code) {
  await loadCss(`/assets/meet/meet.css?v=${encodeURIComponent(store.brand?.version || '')}`);
  stop();
  let info;
  try {
    info = await api('GET', `/api/meet-pub/live/${encodeURIComponent(code)}`);
  } catch (e) {
    return notice('close', e.message || t('mt_not_found'));
  }
  setTitle(info.title || t('mt_live'));
  if (info.ended) return notice('clock', t('mt_ended'));
  if (info.access === 'signin' && !info.signed_in) {
    try { sessionStorage.setItem('cf_after_login', location.hash); } catch { /* private mode / 隐私模式 */ }
    return notice('lock', t('mt_live_signin_needed'), `<wa-button variant="brand" href="#/login">${esc(t('mt_signin'))}</wa-button>`);
  }
  const k = kept(code);
  const l = L = {
    code, info, vid: k.vid, card: k.card || '',
    interactive: !!info.interactive, chatOn: !!info.interactive && !!info.chat,
    me: null, lines: [], mine: new Set(), count: 0, hand: false, blocked: false, invite: '', after: '',
    aud: null, up: false,
    onAir: !!info.on_air, url: '', renewAt: 0, hls: null, playing: false, starting: false, fails: 0, retry: 0, poll: 0,
  };
  draw(l);
  if (l.interactive) connect(l);
  else lookLater(l);
  ensurePlay(l);
}

// ---------- the page ----------
// ---------- 页面 ----------

function draw(l) {
  const { info } = l;
  show(`
  <div class="mt-live ${l.chatOn ? 'with-chat' : ''}" id="mt-live">
    <header class="mt-top">
      <div class="mt-top-title">${esc(info.title || t('mt_live'))}</div>
      <span class="mt-onair" id="mt-onair">${esc(t('mt_on_air'))}</span>
      <span class="mt-watch" id="mt-live-count" hidden></span>
      <span class="sp"></span>
      <span class="dim mt-live-host">${esc(info.host || '')}</span>
      ${l.interactive ? `<wa-button size="small" id="mt-live-ask" class="mt-live-ask" disabled>${icon('hand', 16)} <span>${esc(t('mt_live_ask'))}</span></wa-button>` : ''}
    </header>
    <div class="mt-live-main">
      <div class="mt-live-stage">
        <video id="mt-live-v" controls playsinline autoplay muted></video>
        <div class="mt-live-wait" id="mt-live-wait">${icon('videocam', 40)}<div>${esc(t('mt_live_waiting'))}</div></div>
        <wa-button class="mt-live-unmute" id="mt-live-unmute" variant="brand" hidden>${icon('volume', 18)} ${esc(t('mt_live_unmute'))}</wa-button>
      </div>
      ${l.chatOn ? `<aside class="mt-live-side">
        <div class="mt-live-side-head">${icon('chat', 16)} ${esc(t('mt_live_chat'))}</div>
        <div class="mt-chat-log" id="mt-live-log"></div>
        <div class="mt-live-foot" id="mt-live-foot"></div>
      </aside>` : ''}
    </div>
  </div>`);
  qs('#mt-live-unmute')?.addEventListener('click', () => { const v = qs('#mt-live-v'); if (v) { v.muted = false; qs('#mt-live-unmute').hidden = true; } });
  qs('#mt-live-ask')?.addEventListener('click', () => onAsk(l));
  drawLog(l);
  drawFoot(l);
}

function drawLog(l) {
  const log = qs('#mt-live-log');
  if (!log) return;
  if (!l.lines.length) { log.innerHTML = `<div class="mt-chat-empty dim">${esc(t('mt_live_chat_empty'))}</div>`; return; }
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = l.lines.map((m) => audLineHtml(m, { mine: l.mine.has(m.id) })).join('');
  if (stick) log.scrollTop = log.scrollHeight;
}

/** Under the chat: a way in for somebody with no name yet, the box to type in for somebody
 *  with one, and a plain word for somebody a host silenced.
 *  聊天区下方:还没名字的人,给一个进来的办法;有名字的人,给一个输入框;被主持人禁言的人,给一句明白话。 */
function drawFoot(l) {
  const foot = qs('#mt-live-foot');
  if (!foot) return;
  if (!l.me) { foot.innerHTML = ''; return; }
  if (l.blocked) { foot.innerHTML = `<div class="dim mt-live-note">${esc(t('mt_live_blocked'))}</div>`; return; }
  if (!l.me.name) {
    foot.innerHTML = `<wa-button id="mt-live-named" appearance="outlined" class="mt-live-join">${icon('chat', 16)} ${esc(t('mt_live_chat_join'))}</wa-button>`;
    qs('#mt-live-named').addEventListener('click', () => askName(l, 'chat'));
    return;
  }
  if (qs('#mt-live-form')) return;
  foot.innerHTML = `<form class="mt-chat-form" id="mt-live-form">
      <wa-input id="mt-live-in" maxlength="500" autocomplete="off" placeholder="${esc(t('mt_live_chat_ph', l.me.name))}"></wa-input>
      <wa-button class="icon" type="submit" appearance="plain" aria-label="${esc(t('send'))}">${icon('send', 20)}</wa-button>
    </form>`;
  qs('#mt-live-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = qs('#mt-live-in');
    const text = String(inp.value || '').trim();
    if (!text) return;
    if (!l.aud?.send({ t: 'say', text })) return toast(t('mt_live_offline'), true);
    inp.value = '';
  });
}

function paintAsk(l) {
  const b = qs('#mt-live-ask');
  if (!b) return;
  b.disabled = l.blocked || !l.up;
  const label = l.invite ? 'mt_live_go_on' : l.hand ? 'mt_live_ask_cancel' : 'mt_live_ask';
  b.setAttribute('variant', l.invite ? 'brand' : 'neutral');
  b.classList.toggle('on', l.hand && !l.invite);
  const span = b.querySelector('span');
  if (span) span.textContent = t(label);
}

function paintCount(l) {
  const el = qs('#mt-live-count');
  if (!el) return;
  el.hidden = !(l.count > 0);
  el.innerHTML = `${icon('eye', 14)}<span>${esc(t('mt_live_watching', l.count))}</span>`;
}

// ---------- the audience's socket ----------
// ---------- 观众席的 socket ----------

function connect(l) {
  l.aud = joinAudience({
    code: l.code,
    query: () => ({ vid: l.vid, who: l.card }),
    on: (m) => { if (L === l) onAud(l, m); },
    onState: (up, info) => {
      if (L !== l) return;
      l.up = up;
      paintAsk(l);
      // While the hall cannot say when the broadcast starts, the page looks for itself.
      // 总台说不了什么时候开播的时候,页面自己去看。
      if (up) clearTimeout(l.poll); else lookLater(l);
      if (info?.refused) {
        const e = info.refused.error;
        if (e === 'e_meet_ended') { stop(); return notice('clock', t('mt_ended')); }
        toast(tErr(e, info.refused.args), true);
      }
    },
  });
}

function onAud(l, m) {
  switch (m.t) {
    case 'hello': {
      l.me = m.you || null;
      l.lines = mergeLines([], m.hist);
      l.count = Number(m.count) || 0;
      l.hand = !!m.hand;
      if (m.live === 'on' || m.live === 'off') setOnAir(l, m.live === 'on');
      drawLog(l);
      qs('#mt-live-form')?.remove();
      drawFoot(l);
      paintAsk(l);
      paintCount(l);
      // Named just now, on the way to doing something: do it. / 刚留了名,本来是要做件事的:接着做。
      if (l.me?.name && l.after) {
        const what = l.after;
        l.after = '';
        if (what === 'hand') l.aud?.send({ t: 'hand', on: true });
        else setTimeout(() => qs('#mt-live-in')?.focus(), 50);
      }
      return;
    }
    case 'chat':
      mergeLines(l.lines, m.msgs);
      return drawLog(l);
    case 'said':
      l.mine.add(m.id);
      return drawLog(l);
    case 'del': {
      const ids = new Set(m.ids || []);
      l.lines = l.lines.filter((x) => !ids.has(x.id));
      return drawLog(l);
    }
    case 'count':
      l.count = Number(m.n) || 0;
      return paintCount(l);
    case 'live':
      return setOnAir(l, m.state === 'on');
    case 'hand':
      if (m.on && !l.hand) toast(t('mt_live_asked'));
      l.hand = !!m.on;
      if (!l.hand) l.invite = '';
      return paintAsk(l);
    case 'invite':
      l.invite = m.ticket || '';
      paintAsk(l);
      return showInvite(l);
    case 'declined':
      l.hand = false;
      l.invite = '';
      paintAsk(l);
      return toast(t('mt_live_declined'));
    case 'blocked':
      l.blocked = true;
      l.hand = false;
      l.invite = '';
      paintAsk(l);
      drawFoot(l);
      return toast(t('mt_live_blocked'), true);
    case 'reset':
      if (m.ended) { stop(); return notice('clock', t('mt_ended')); }
      l.hand = false;
      l.invite = '';
      if (m.full) { l.lines = []; l.blocked = false; drawLog(l); drawFoot(l); }
      return paintAsk(l);
    case 'err':
      return toast(tErr(m.code, []), true);
  }
}

// ---------- asking to speak ----------
// ---------- 申请发言 ----------

function onAsk(l) {
  if (l.invite) return goOnStage(l);
  if (l.hand) { l.aud?.send({ t: 'hand', on: false }); return; }
  if (!l.me?.name) return askName(l, 'hand');
  l.aud?.send({ t: 'hand', on: true });
}

/** A name, given once, with Turnstile once; the card that comes back is kept on this device.
 *  名字只留一次,Turnstile 只过一次;换回来的卡存在本机。 */
function askName(l, after) {
  const dlg = showModal(`
    <h3 style="margin:0 0 8px">${esc(t('mt_live_name_title'))}</h3>
    <p class="dim" style="margin:0 0 12px;line-height:1.6">${esc(t('mt_live_name_hint'))}</p>
    <wa-input id="ln-name" maxlength="32" autocomplete="nickname" placeholder="${esc(t('mt_your_name'))}" value="${esc(lsGet('cf_meet_name'))}"></wa-input>
    <div id="ln-cap" class="mt-pre-cap"></div>
    <div class="mt-pre-err dim" id="ln-err"></div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button appearance="plain" id="ln-cancel">${esc(t('cancel'))}</wa-button>
      <wa-button variant="brand" id="ln-ok">${esc(t('mt_continue'))}</wa-button>
    </div>`);
  dlg.style.setProperty('--width', 'min(440px, 94vw)');
  let cap = null;
  if (store.brand?.turnstile) {
    import('../turnstile.js').then(({ mountTurnstile }) => mountTurnstile(dlg.querySelector('#ln-cap'), store.brand.turnstile, { lang: lang() }))
      .then((c) => { cap = c; }).catch(() => {});
  }
  dlg.querySelector('#ln-cancel').addEventListener('click', closeModal);
  const ok = dlg.querySelector('#ln-ok');
  const submit = async () => {
    const errEl = dlg.querySelector('#ln-err');
    const name = String(dlg.querySelector('#ln-name').value || '').trim();
    if (!name) { errEl.textContent = t('mt_name_required'); return; }
    if (store.brand?.turnstile && !cap?.token()) { errEl.textContent = t('captcha_wait'); return; }
    ok.loading = true;
    try {
      const res = await api('POST', `/api/meet-pub/live/${encodeURIComponent(l.code)}/name`, { vid: l.vid, name, ts: cap?.token() || '' });
      if (L !== l) return;
      l.card = res.card;
      lsSet(`cf_live_${l.code}`, JSON.stringify({ vid: l.vid, card: res.card }));
      lsSet('cf_meet_name', res.name);
      l.after = after;
      closeModal();
      // Come back as the named viewer; the hello that follows finishes what was started.
      // 以留了名的观众身份重新连上;随后的 hello 会把开了头的事做完。
      l.aud?.reopen();
    } catch (e) {
      ok.loading = false;
      cap?.reset();
      errEl.textContent = e.message || t('e_generic');
    }
  };
  ok.addEventListener('click', submit);
  dlg.querySelector('#ln-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function showInvite(l) {
  // A viewer watching full screen would never see the question. / 全屏观看的人永远看不到这个问题。
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* not full screen / 不在全屏 */ }
  const dlg = showModal(`
    <h3 style="margin:0 0 8px">${icon('hand', 20)} ${esc(t('mt_live_invited_title'))}</h3>
    <p style="margin:0;line-height:1.6">${esc(t('mt_live_invited_hint', l.me?.name || ''))}</p>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button appearance="plain" id="li-no">${esc(t('mt_live_not_now'))}</wa-button>
      <wa-button variant="brand" id="li-go">${esc(t('mt_live_go_on'))}</wa-button>
    </div>`);
  dlg.style.setProperty('--width', 'min(460px, 94vw)');
  dlg.querySelector('#li-no').addEventListener('click', () => { closeModal(); l.aud?.send({ t: 'hand', on: false }); });
  dlg.querySelector('#li-go').addEventListener('click', () => { closeModal(); goOnStage(l); });
}

/** Into the room with the ticket. It is kept for this tab only, so a reload of the room is still
 *  the same seat, and nothing to copy out of the address bar.
 *  带着入场券走进会场。券只存在这个标签页里:刷新会场还是同一个座位,地址栏里也没有可以复制走的东西。 */
function goOnStage(l) {
  const ticket = l.invite;
  if (!ticket) return;
  let hash = `#/meet/${l.code}`;
  try { sessionStorage.setItem(`cf_meet_ticket_${l.code}`, ticket); } catch { hash += `?st=${encodeURIComponent(ticket)}`; }
  location.hash = hash;
}

// ---------- the broadcast ----------
// ---------- 直播 ----------

function lookLater(l) {
  clearTimeout(l.poll);
  if (L !== l || (l.interactive && l.up)) return;
  l.poll = setTimeout(async () => {
    if (L !== l || (l.interactive && l.up)) return;
    await lookNow(l);
    lookLater(l);
  }, l.interactive ? POLL_MS : POLL_ALONE_MS);
}

async function lookNow(l) {
  try {
    const info = await api('GET', `/api/meet-pub/live/${encodeURIComponent(l.code)}`);
    if (L !== l) return;
    if (info.ended) { stop(); notice('clock', t('mt_ended')); return; }
    setOnAir(l, !!info.on_air);
  } catch { /* next time / 下次再看 */ }
}

function setOnAir(l, on) {
  l.onAir = on;
  if (on) ensurePlay(l);
  else offAir(l);
}

async function ensurePlay(l) {
  if (L !== l || !l.onAir || l.playing || l.starting) return;
  l.starting = true;
  try {
    // An address in hand is kept until it is nearly spent. / 手里的地址一直用到快过期为止。
    if (!l.url || Date.now() > l.renewAt) {
      const res = await api('POST', `/api/meet-pub/live/${encodeURIComponent(l.code)}/token`);
      if (L !== l) return;
      if (!res.on_air || !res.hls) { l.onAir = false; return; }
      l.url = res.hls;
      l.renewAt = Date.now() + Math.max(60, (res.ttl || 3600) - 600) * 1000;
    }
    await play(l);
  } catch {
    retryLater(l);
  } finally {
    l.starting = false;
  }
}

/** The first seconds of a broadcast have no playlist yet, and a stream can hiccup: try again,
 *  a little slower each time, and every few tries ask whether it is still on at all.
 *  直播开头几秒还没有播放清单,流也会打嗝:再试,一次比一次慢一点;每隔几次问一下是不是还在播。 */
function retryLater(l) {
  clearTimeout(l.retry);
  if (L !== l || !l.onAir) return;
  l.fails += 1;
  l.retry = setTimeout(async () => {
    if (L !== l) return;
    if (l.fails % 4 === 0) await lookNow(l);
    ensurePlay(l);
  }, RETRY_MS[Math.min(l.fails - 1, RETRY_MS.length - 1)]);
}

function dropPlayer(l) {
  l.playing = false;
  try { l.hls?.destroy(); } catch { /* gone / 已无 */ }
  l.hls = null;
  const v = qs('#mt-live-v');
  if (v && v.getAttribute('src')) { try { v.removeAttribute('src'); v.load(); } catch { /* fine / 无妨 */ } }
  qs('#mt-live')?.classList.remove('on');
}

function offAir(l) {
  clearTimeout(l.retry);
  l.fails = 0;
  dropPlayer(l);
}

async function play(l) {
  const v = qs('#mt-live-v');
  if (!v) return;
  const started = () => {
    if (L !== l) return;
    l.playing = true;
    l.fails = 0;
    qs('#mt-live')?.classList.add('on');
    // Browsers start a video nobody clicked on only if it is silent; one tap gives it its voice.
    // 没人点过的视频,浏览器只肯静音着自动播;点一下,声音就回来。
    const btn = qs('#mt-live-unmute');
    if (btn) btn.hidden = !v.muted;
  };
  v.addEventListener('playing', started, { once: true });
  // hls.js wherever it can run, the browser's own HLS only where it cannot (an iPhone). A desktop
  // Chrome now says it plays HLS by itself, and then fails to parse a low-latency playlist
  // (DEMUXER_ERROR_COULD_NOT_PARSE, measured); asking the browser first is asking the wrong one.
  // 能跑 hls.js 的地方一律用 hls.js,只有跑不了的地方(iPhone)才用浏览器自带的 HLS。
  // 桌面 Chrome 现在自称能播 HLS,却解析不了低延迟清单(实测 DEMUXER_ERROR_COULD_NOT_PARSE);
  // 先去问浏览器,就是问错了对象。
  const { default: Hls } = await import(`/vendor/hls/dist/hls.light.min.mjs`);
  if (L !== l) return;
  if (!Hls.isSupported()) {
    if (!v.canPlayType('application/vnd.apple.mpegurl')) return notice('close', t('mt_live_unsupported'));
    v.addEventListener('error', () => { if (L === l) { dropPlayer(l); retryLater(l); } }, { once: true });
    v.src = l.url;
    v.play?.().catch(() => {});
    return;
  }
  try { l.hls?.destroy(); } catch { /* gone / 已无 */ }
  const hls = l.hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, maxLiveSyncPlaybackRate: 1.5, backBufferLength: 30 });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal || L !== l || l.hls !== hls) return;
    // The playlist is not there yet, or the broadcast paused: start over in a moment. An address
    // close to its end is not worth another try. / 清单还没出来,或者直播暂停了:过一会儿从头再来。快过期的地址不值得再试。
    dropPlayer(l);
    if (Date.now() > l.renewAt - 60_000) l.url = '';
    retryLater(l);
  });
  hls.loadSource(l.url);
  hls.attachMedia(v);
  hls.on(Hls.Events.MANIFEST_PARSED, () => v.play?.().catch(() => {}));
}
