// A meeting, from the door to the room.
//
// One address (#/meet/<code>) serves everybody who can come: the owner, a signed-in colleague
// holding the link, a guest holding the guest link. Which of those you are is decided by the
// server when the socket opens; this page asks the front of the meeting what it should show
// before that, and then shows three things in turn -- a place to check your microphone and
// camera, a wait at the door if the host is letting people in by hand, and the room.
//
// The room draws itself from the room's own description and only from it. The server sends the
// whole room on every change; every tile, badge and button here is a function of the latest
// snapshot plus what this browser itself is doing (is my microphone on, which page of tiles am I
// looking at). Nothing is inferred from a sequence of events, so nothing can be wrong for having
// missed one.
//
// 一场会议,从门口到房间。
//
// 同一个地址(#/meet/<code>)服务所有能来的人:创建者、持有链接的已登录同事、持有访客链接的访客。
// 你是其中哪一种,由服务端在 socket 打开时判定;在那之前,这个页面先问会议的"门面"该显示什么,
// 然后依次显示三样:检查麦克风和摄像头的地方、主持人手动放行时在门口的等待、以及房间。
//
// 房间从"房间自己的描述"画出自己,并且只从它。服务端每次变化都发来整个房间;这里的每一格、
// 每个徽标、每个按钮,都是"最新快照 + 这个浏览器自己正在做什么(我的麦开着吗、我在看第几页小格)"
// 的函数。没有任何东西是从一串事件里推断出来的,所以也就不会因为漏了一个而出错。
import { api } from '../api.js';
import { t, tErr, lang } from '../i18n.js';
import { esc, icon, qs, qsa, toast, confirmDialog, copyText, loadCss, avatar, showModal, closeModal } from '../ui.js';
import { store, navigate, show, setTitle, refreshMe } from '../app.js';
import { joinRoom } from './signal.js';
import { Rtc } from './rtc.js';
import { Crypt, e2eeSupported, fingerprint, recallSecret, rememberSecret, secretFrom, withSecret } from './e2ee.js';
import { audLineHtml, joinAudience, mergeLines } from './audience.js';

const PAGE = 16;
const LS = { mic: 'cf_meet_mic', cam: 'cf_meet_cam', name: 'cf_meet_name', micOn: 'cf_meet_mic_on', camOn: 'cf_meet_cam_on', recKeep: 'cf_meet_rec_keep', recMinutes: 'cf_meet_rec_minutes' };
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode / 隐私模式 */ } };

let cssReady = null;
function ensureCss() {
  if (!cssReady) cssReady = loadCss(`/assets/meet/meet.css?v=${encodeURIComponent(store.brand?.version || '')}`);
  return cssReady;
}

/** Everything about the meeting this tab is in. Rebuilt on every visit; `null` when not in one.
 *  这个标签页所在会议的全部。每次进入重建;不在会议里时为 `null`。 */
let R = null;

// A way for a test (or a developer's console) to look inside, on localhost only.
// 让测试(或开发者的控制台)能往里看一眼,仅限 localhost。
if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__cfMeet = () => R;

/** Leaving the address leaves the meeting: a hash change away from #/meet/<code> is a person
 *  walking out, and the camera must not stay on behind a page about something else.
 *  离开这个地址就是离开会议:hash 从 #/meet/<code> 变走,就是人走出去了,
 *  摄像头不能在一张讲别的事的页面背后继续开着。 */
window.addEventListener('hashchange', () => {
  if (R && !location.hash.startsWith(`#/meet/${R.code}`)) teardown();
});
window.addEventListener('pagehide', () => { if (R) teardown(); });

function teardown() {
  const r = R;
  R = null;
  if (!r) return;
  clearInterval(r.clock);
  try { r.fit?.disconnect(); } catch { /* gone / 已无 */ }
  // Walking out ends the recording, but not the saving of it: that carries on without the room.
  // 走出去会结束录制,但不会结束"保存":那件事不需要房间,会自己继续做完。
  if (r.recorder?.active) r.recorder.stop('left');
  try { r.preview?.getTracks().forEach((x) => x.stop()); } catch { /* gone / 已无 */ }
  try { r.rtc?.stop(); } catch { /* gone / 已无 */ }
  try { r.crypt?.stop(); } catch { /* gone / 已无 */ }
  try { r.aud?.sock.close(); } catch { /* gone / 已无 */ }
  try { r.signal?.leave(); } catch { /* gone / 已无 */ }
  try { r.wake?.release(); } catch { /* gone / 已无 */ }
  document.body.classList.remove('mt-in-room');
}

// ---------- The door ----------
// ---------- 门口 ----------

/** A speaker's ticket from the audience, if this tab was handed one: kept in the tab by the
 *  watching page, or -- where a tab cannot keep anything -- in the address. Only what is on it
 *  is read here (the name, the expiry); whether it is genuine is the server's question.
 *  这个标签页若拿到了观众席上的发言入场券,就在这里:旁观页把它存在标签页里,存不了的地方则放在地址里。
 *  这里只读券面(名字、到期时间);真伪是服务端的事。 */
function ticketFor(code, query) {
  let s = '';
  try { s = sessionStorage.getItem(`cf_meet_ticket_${code}`) || ''; } catch { /* private mode / 隐私模式 */ }
  s = s || new URLSearchParams(query || '').get('st') || '';
  if (!s) return null;
  try {
    const p = s.slice(0, s.lastIndexOf('.')).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
    const body = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (!(Number(body.e) > Date.now())) { forgetTicket(code); return null; }
    return { paper: s, name: String(body.n || '') };
  } catch {
    forgetTicket(code);
    return null;
  }
}

function forgetTicket(code) {
  try { sessionStorage.removeItem(`cf_meet_ticket_${code}`); } catch { /* private mode / 隐私模式 */ }
}

export async function renderMeetRoom(code, query) {
  await ensureCss();
  teardown();
  const k = new URLSearchParams(query || '').get('k') || '';
  const ticket = ticketFor(code, query);
  let info;
  try {
    info = await api('GET', `/api/meet-pub/${encodeURIComponent(code)}`);
  } catch (e) {
    return showNotice('close', e.message || t('mt_not_found'), [{ label: t('mt_back_list'), hash: '#/meet', signedInOnly: true }]);
  }
  // Known to the server as somebody: fetch who, so the page can offer the way back to the list.
  // A guest is never asked -- the answer would be a 401 and a trip to the sign-in page.
  // 服务端认得此人:取回他是谁,好让页面给出回到列表的路。访客则从不去问 —— 答案会是 401 加一趟登录页。
  if (info.signed_in && !store.me) await refreshMe().catch(() => {});
  setTitle(info.title || t('mt_title'));
  if (info.ended) return showNotice('clock', t('mt_ended'), [{ label: t('mt_back_list'), hash: '#/meet', signedInOnly: true }]);
  // Somebody a host let up from the audience needs neither an account nor a guest link.
  // 被主持人从观众席请上来的人,既不需要账号,也不需要访客链接。
  if (!info.signed_in && !ticket) {
    if (info.guest_mode === 'off' || !k) {
      // The way back here after signing in is remembered the same way a kept form answer's is.
      // 登录之后回到这里的路,用与"保留的表单答复"相同的办法记住。
      try { sessionStorage.setItem('cf_after_login', location.hash); } catch { /* private mode / 隐私模式 */ }
      return showNotice('lock', t(info.guest_mode === 'off' ? 'mt_signin_needed' : 'mt_guest_link_needed'),
        [{ label: t('mt_signin'), hash: '#/login' }]);
    }
  }
  // An encrypted meeting needs its secret on this device: from the link that brought us here, or
  // from an earlier visit. It is read from the part of the address after the `#` and kept in this
  // browser, and it goes nowhere else -- nothing below ever sends it.
  // 加密会议需要它的秘密在这台设备上:来自把我们带到这里的链接,或者来自之前的某次访问。
  // 它从地址 `#` 之后的部分读出、保存在这个浏览器里,此外哪儿都不去 —— 下面没有任何代码会把它发出去。
  let secret = '';
  if (info.e2ee) {
    if (!e2eeSupported()) return showNotice('lock', t('mt_e2ee_unsupported'), [{ label: t('mt_back_list'), hash: '#/meet', signedInOnly: true }]);
    const given = secretFrom(query);
    if (given) rememberSecret(code, given);
    secret = given || recallSecret(code);
    if (!secret) return askSecret(code, query);
  }
  R = {
    code, info, guestKey: info.signed_in || ticket ? '' : k, e2ee: secret, crypt: null,
    ticket: ticket?.paper || '', ticketName: ticket?.name || '', aud: null, chatTab: 'room',
    micOn: lsGet(LS.micOn) !== '0', camOn: info.video && lsGet(LS.camOn) === '1',
    preview: null, signal: null, rtc: null, me: null, cfg: null, room: null,
    tiles: new Map(), audios: new Map(), remoteTracks: new Map(),
    page: 0, panel: null, chat: [], unread: 0, hand: false, speaking: new Map(),
    down: false, clock: 0, wake: null, cap: null, recorder: null,
  };
  return renderPrejoin();
}

/** An encrypted meeting reached without its secret -- from an invitation mail, say, which never
 *  carries it. The full link comes from the organiser, by whatever way they chose.
 *  没带秘密就来到了一场加密会议 —— 比如点的是邀请邮件里的链接,而邮件从不携带秘密。完整链接要找组织者,由他选的方式送来。 */
function askSecret(code, query) {
  show(`
  <div class="mt-notice">${icon('lock', 48)}
    <div class="mt-notice-t">${esc(t('mt_e2ee_need_key'))}</div>
    <div class="dim" style="max-width:460px;text-align:center">${esc(t('mt_e2ee_need_key_hint'))}</div>
    <form class="mt-keyform" id="mt-keyform">
      <wa-input id="mt-key-in" autocomplete="off" placeholder="${esc(t('mt_e2ee_paste'))}"></wa-input>
      <wa-button type="submit" variant="brand">${esc(t('mt_continue'))}</wa-button>
    </form>
  </div>`);
  qs('#mt-keyform')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const s = secretFrom(qs('#mt-key-in')?.value);
    if (!s) return toast(t('mt_e2ee_bad_key'), true);
    rememberSecret(code, s);
    renderMeetRoom(code, query);
  });
}

function showNotice(ic, text, actions = []) {
  const btns = actions
    .filter((a) => !a.signedInOnly || store.me)
    .map((a) => `<wa-button variant="brand" href="${esc(a.hash)}">${esc(a.label)}</wa-button>`).join('');
  show(`<div class="mt-notice">${icon(ic, 48)}<div class="mt-notice-t">${esc(text)}</div><div class="mt-notice-a">${btns}</div></div>`);
}

async function renderPrejoin() {
  const r = R;
  // Somebody with a ticket already has a name -- the one the host said yes to -- and needs no
  // Turnstile: the host was the check. / 持券的人已经有名字 —— 主持人答应的就是它 —— 也不用过 Turnstile:主持人就是那道检查。
  const guest = !r.info.signed_in && !r.ticket;
  show(`
  <div class="mt-pre">
    <div class="mt-pre-card">
      <h1 class="mt-pre-title">${esc(r.info.title || t('mt_title'))}</h1>
      <div class="mt-pre-sub">${r.info.host ? esc(t('mt_hosted_by', r.info.host)) : ''}${r.info.video ? '' : ` · ${esc(t('mt_audio_only'))}`}</div>
      ${r.ticket ? `<div class="mt-pre-ticket">${icon('hand', 16)} ${esc(t('mt_on_stage_as', r.info.signed_in ? (store.me?.name || store.me?.email || '') : r.ticketName))}</div>` : ''}
      <div class="mt-pre-view ${r.info.video ? '' : 'audio'}">
        <video id="mt-pre-video" muted playsinline autoplay></video>
        <div class="mt-pre-off" id="mt-pre-off">${icon(r.info.video ? 'videocamOff' : 'mic', 40)}</div>
        <div class="mt-pre-level"><i id="mt-pre-level"></i></div>
      </div>
      <div class="mt-pre-ctl">
        <wa-button class="icon mt-round" id="mt-pre-mic" appearance="filled" aria-label="${esc(t('mt_microphone'))}"></wa-button>
        ${r.info.video ? `<wa-button class="icon mt-round" id="mt-pre-cam" appearance="filled" aria-label="${esc(t('mt_camera'))}"></wa-button>` : ''}
      </div>
      <div class="mt-pre-dev" id="mt-pre-dev"></div>
      ${guest ? `<wa-input id="mt-pre-name" maxlength="32" placeholder="${esc(t('mt_your_name'))}" value="${esc(lsGet(LS.name))}"></wa-input>
                 <div id="mt-pre-cap" class="mt-pre-cap"></div>` : ''}
      <wa-button variant="brand" size="large" id="mt-pre-join">${esc(t('mt_join'))}</wa-button>
      <div class="mt-pre-err dim" id="mt-pre-err"></div>
    </div>
  </div>`);

  if (guest && store.brand?.turnstile) {
    import('../turnstile.js').then(({ mountTurnstile }) =>
      mountTurnstile(qs('#mt-pre-cap'), store.brand.turnstile, { lang: lang() })).then((cap) => { if (R === r) r.cap = cap; }).catch(() => {});
  }

  const paint = () => {
    const mic = qs('#mt-pre-mic'); const cam = qs('#mt-pre-cam');
    if (mic) { mic.innerHTML = icon(r.micOn ? 'mic' : 'micOff', 22); mic.classList.toggle('off', !r.micOn); }
    if (cam) { cam.innerHTML = icon(r.camOn ? 'videocam' : 'videocamOff', 22); cam.classList.toggle('off', !r.camOn); }
    qs('#mt-pre-off')?.classList.toggle('show', !r.camOn);
  };
  paint();

  // The preview is what the person is about to send. It asks for the devices only when there is
  // something to show, so a meeting joined muted with the camera off never lights the camera.
  // 预览就是此人即将发出去的东西。只有在确有东西要显示时才去要设备,
  // 所以以静音、关摄像头的状态加入的会议,摄像头的灯从头到尾不会亮。
  let meter = 0;
  const refresh = async () => {
    try { r.preview?.getTracks().forEach((x) => x.stop()); } catch { /* gone / 已无 */ }
    r.preview = null;
    cancelAnimationFrame(meter);
    const want = { audio: r.micOn ? { deviceId: lsGet(LS.mic) ? { ideal: lsGet(LS.mic) } : undefined } : false,
      video: r.camOn ? { deviceId: lsGet(LS.cam) ? { ideal: lsGet(LS.cam) } : undefined, width: { ideal: 640 }, height: { ideal: 360 } } : false };
    const err = qs('#mt-pre-err');
    if (err) err.textContent = '';
    if (want.audio || want.video) {
      try {
        r.preview = await navigator.mediaDevices.getUserMedia(want);
      } catch (e) {
        if (err) err.textContent = mediaErrorText(e, want.video ? 'cam' : 'mic');
        if (want.video && want.audio) { r.camOn = false; paint(); return refresh(); }
        r.micOn = false; r.camOn = false; paint();
      }
    }
    if (R !== r) { r.preview?.getTracks().forEach((x) => x.stop()); return; }
    const v = qs('#mt-pre-video');
    if (v) v.srcObject = r.preview && r.preview.getVideoTracks().length ? r.preview : null;
    drawDevices();
    const a = r.preview?.getAudioTracks()[0];
    if (a) {
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const an = ac.createAnalyser();
        an.fftSize = 256;
        ac.createMediaStreamSource(new MediaStream([a])).connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const tick = () => {
          if (R !== r || !r.preview || r.signal) { ac.close().catch(() => {}); return; }
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (const b of buf) peak = Math.max(peak, Math.abs(b - 128));
          const bar = qs('#mt-pre-level');
          if (bar) bar.style.width = `${Math.min(100, peak * 2)}%`;
          meter = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* a meter, not a need / 只是个音量表 */ }
    }
  };

  const drawDevices = async () => {
    const box = qs('#mt-pre-dev');
    if (!box) return;
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch { /* none / 无 */ }
    const named = list.filter((d) => d.label);
    const sel = (kind, key, cur) => {
      const opts = named.filter((d) => d.kind === kind);
      if (opts.length < 2) return '';
      return `<wa-select size="small" data-k="${key}" value="${esc(cur)}">${opts.map((d) =>
        `<wa-option value="${esc(d.deviceId)}">${esc(d.label)}</wa-option>`).join('')}</wa-select>`;
    };
    const curMic = r.preview?.getAudioTracks()[0]?.getSettings().deviceId || '';
    const curCam = r.preview?.getVideoTracks()[0]?.getSettings().deviceId || '';
    box.innerHTML = (r.micOn ? sel('audioinput', LS.mic, curMic) : '') + (r.camOn ? sel('videoinput', LS.cam, curCam) : '');
  };

  qs('#mt-pre-dev')?.addEventListener('change', (e) => {
    const el = e.target.closest?.('wa-select');
    if (!el) return;
    lsSet(el.dataset.k, el.value);
    refresh();
  });
  qs('#mt-pre-mic')?.addEventListener('click', () => { r.micOn = !r.micOn; lsSet(LS.micOn, r.micOn ? '1' : '0'); paint(); refresh(); });
  qs('#mt-pre-cam')?.addEventListener('click', () => { r.camOn = !r.camOn; lsSet(LS.camOn, r.camOn ? '1' : '0'); paint(); refresh(); });
  qs('#mt-pre-join')?.addEventListener('click', () => {
    let name = '';
    if (guest) {
      name = String(qs('#mt-pre-name')?.value || '').trim();
      if (!name) { qs('#mt-pre-err').textContent = t('mt_name_required'); return; }
      if (store.brand?.turnstile && !r.cap?.token()) { qs('#mt-pre-err').textContent = t('captcha_wait'); return; }
      lsSet(LS.name, name);
    }
    enter(name);
  });
  refresh();
}

function mediaErrorText(e, which) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return t(which === 'cam' ? 'mt_cam_denied' : 'mt_mic_denied');
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return t(which === 'cam' ? 'mt_no_cam' : 'mt_no_mic');
  if (n === 'NotReadableError') return t('mt_device_busy');
  return t('mt_device_failed');
}

// ---------- Coming in ----------
// ---------- 进门 ----------

function enter(name) {
  const r = R;
  // The preview's devices are let go first: some cameras refuse a second capture while the
  // first is open, and the room is about to ask for its own. / 先放掉预览占着的设备:
  // 有的摄像头在第一路采集还开着时拒绝第二路,而房间马上要去要它自己的那一路。
  try { r.preview?.getTracks().forEach((x) => x.stop()); } catch { /* gone / 已无 */ }
  r.preview = null;
  show(`<div class="mt-notice"><wa-spinner style="font-size:40px"></wa-spinner><div class="mt-notice-t">${esc(t('mt_joining'))}</div></div>`);
  r.signal = joinRoom({
    code: r.code, guestKey: r.guestKey, name, ticket: r.ticket,
    turnstile: r.guestKey && store.brand?.turnstile ? async () => {
      const tk = r.cap?.token() || '';
      r.cap?.reset();
      return tk;
    } : null,
    on: (m) => { if (R === r) onMessage(m); },
    onDown: (d) => { if (R === r) onDown(d); },
  });
}

function onDown({ final, refused }) {
  const r = R;
  if (refused) {
    const text = tErr(refused.error, refused.args);
    // A ticket that was turned away is not worth trying again; the way back is to the broadcast.
    // 被拒之门外的券不值得再试;回去的路是直播。
    const back = r.ticket ? [{ label: t('mt_back_to_live'), hash: `#/live/${r.code}` }] : [{ label: t('mt_back_list'), hash: '#/meet', signedInOnly: true }];
    if (r.ticket) forgetTicket(r.code);
    teardown();
    return showNotice('close', text, back);
  }
  if (final) return; // the message that caused it has already drawn the page / 造成它的那条消息已经画过页面了
  // The socket dropped under us. The seat is gone with it, so what is on screen is stale: stop
  // the media, say so, and let the next welcome rebuild. / socket 在我们脚下断了。座位随之没了,
  // 屏幕上的东西已经过时:停掉媒体、说明情况,让下一次 welcome 来重建。
  r.down = true;
  try { r.rtc?.stop(); } catch { /* gone / 已无 */ }
  r.rtc = null;
  clearRemote();
  qs('#mt-banner')?.classList.add('show');
}

function clearRemote() {
  const r = R;
  for (const a of r.audios.values()) a.remove();
  r.audios.clear();
  r.remoteTracks.clear();
  for (const tile of r.tiles.values()) setTileVideo(tile, null);
}

async function onMessage(m) {
  const r = R;
  switch (m.t) {
    case 'welcome':
    case 'admitted':
      r.me = m.you;
      if (m.you.waiting) return renderWaiting();
      r.cfg = m.cfg;
      r.room = m.room;
      openAud(r, m.aud || '');
      return startRoom(m.ice);
    case 'room':
      r.room = m;
      return syncAll();
    case 'chat':
      r.chat.push(m);
      if (r.chat.length > 500) r.chat.shift();
      if ((r.panel !== 'chat' || r.chatTab !== 'room') && m.from !== r.me?.peer) r.unread += 1;
      drawChat();
      syncBadges();
      return;
    case 'denied':
      teardown();
      return showNotice('close', t('mt_denied'));
    case 'kicked':
      teardown();
      // Off the stage is not out of the audience: somebody who came up from it can go back to watching.
      // 下了台不等于出了观众席:从观众席上来的人,可以回去接着看。
      if (r.ticket) { forgetTicket(r.code); return showNotice('close', t('mt_kicked'), [{ label: t('mt_back_to_live'), hash: `#/live/${r.code}` }]); }
      return showNotice('close', t('mt_kicked'), [{ label: t('mt_back_list'), hash: '#/meet', signedInOnly: true }]);
    case 'ended':
      if (r.ticket) forgetTicket(r.code);
      teardown();
      return showNotice('clock', t('mt_ended'), [{ label: t('mt_back_list'), hash: '#/meet', signedInOnly: true }]);
    case 'replaced':
      // The same ticket came through the door somewhere else; that seat is the one that counts now.
      // 同一张券在别处又进了一次门;现在算数的是那边的座位。
      teardown();
      return showNotice('close', t('mt_replaced'));
    case 'muted':
      if (r.micOn) { r.micOn = false; await r.rtc?.setMic(false).catch(() => {}); toast(t('mt_muted_by_host')); syncControls(); syncTiles(); }
      return;
    case 'notice':
      return toast(tErr(m.code, []), true);
    case 'live_manual':
      // A developer's machine has no container to start: the orders are left where whoever is
      // running the test can pick them up. / 开发机上没有容器可启动:把指令放在跑测试的人拿得到的地方。
      if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__cfMeetLiveOrder = m.order;
      return;
    case 'screen_stop':
      // A host asked for the shared screen to come down. / 主持人请共享的屏幕撤下来。
      await r.rtc?.stopScreen().catch(() => {});
      toast(t('mt_screen_stopped_by_host'));
      return syncAll();
  }
}

function renderWaiting() {
  show(`
  <div class="mt-notice">
    <wa-spinner style="font-size:40px"></wa-spinner>
    <div class="mt-notice-t">${esc(t('mt_waiting_title'))}</div>
    <div class="dim">${esc(t('mt_waiting_hint'))}</div>
    <div class="mt-notice-a"><wa-button appearance="outlined" id="mt-wait-cancel">${esc(t('cancel'))}</wa-button></div>
  </div>`);
  qs('#mt-wait-cancel')?.addEventListener('click', () => { teardown(); showNotice('back', t('mt_left')); });
}

// ---------- The room ----------
// ---------- 房间 ----------

async function startRoom(ice) {
  const r = R;
  const again = !!qs('#mt-room');
  // One worker per meeting, kept across reconnects; each new seat keys its own frames.
  // 每场会议一个 worker,重连也沿用;每个新座位用自己的钥匙加密自己的帧。
  if (r.e2ee && !r.crypt) r.crypt = new Crypt(r.code, r.e2ee);
  await r.crypt?.ready;
  if (!again) {
    drawRoom();
    document.body.classList.add('mt-in-room');
    try { r.wake = await navigator.wakeLock?.request('screen'); } catch { /* not granted / 没给 */ }
  }
  r.down = false;
  r.lastIce = ice;
  // The address bar is where people copy a link from without thinking about it, so it says the
  // same thing the menu does. replaceState: the page does not navigate, the room is not left.
  // 地址栏是人们不假思索就去复制链接的地方,所以它和菜单说的是同一条。用 replaceState:页面不跳转,房间也不会被离开。
  try {
    const want = shareLink(r).slice(location.origin.length + 1);
    if ((r.cfg?.guest_key || r.e2ee) && location.hash !== want) history.replaceState(null, '', `${location.pathname}${location.search}${want}`);
  } catch { /* the link in the menu still works / 菜单里的链接照样能用 */ }
  qs('#mt-banner')?.classList.remove('show');
  await startMedia(false);
}

/** The one link to hand to anybody. While the meeting lets guests in it carries the guest key --
 *  a colleague who follows it is still let in as themselves, so there is never a reason to
 *  give out the other one, and the person who was sent it never meets a sign-in page they have
 *  no account for. / 那一条"给谁都行"的链接。会议允许访客时它带着访客钥匙 ——
 *  同事点它照样以本人身份进来,所以没有任何理由去发另一条;收到它的人,也不会撞上一个自己没有账号的登录页。 */
function shareLink(r) {
  // An encrypted meeting's link carries its secret after the `#`: this is the link the organiser
  // passes on by hand, and it never goes through the server. / 加密会议的链接在 `#` 之后带着秘密:
  // 这正是组织者亲手转交的那条链接,它从不经过服务端。
  return withSecret(`${location.origin}/#/meet/${r.code}${r.cfg?.guest_key ? `?k=${encodeURIComponent(r.cfg.guest_key)}` : ''}`, r.e2ee);
}

function sendState() {
  R?.signal?.send({ t: 'state', mic: R.micOn, cam: R.camOn });
}

/** Build the media half, from nothing. Called on the way in, again after the socket came back
 *  (a new seat, so a new SFU session anyway), and with `fresh` when the seat is fine but the
 *  connection to the SFU died under it.
 *  从零搭起媒体这一半。进门时调一次;socket 重连回来后再调(新座位,本来就是新的 SFU 会话);
 *  座位没事、但通往 SFU 的连接在它脚下死了的时候,带 `fresh` 调。 */
async function startMedia(fresh) {
  const r = R;
  try { r.rtc?.stop(); } catch { /* gone / 已无 */ }
  clearRemote();
  const rtc = r.rtc = new Rtc({
    signal: r.signal, ice: r.lastIce || [{ urls: 'stun:stun.cloudflare.com:3478' }], cfg: r.cfg,
    e2ee: r.crypt ? { crypt: r.crypt, peer: r.me.peer } : null,
    hooks: {
      remote: (peer, kind, track) => { if (R === r && r.rtc === rtc) onRemote(peer, kind, track); },
      local: () => { if (R === r && r.rtc === rtc) { syncTiles(); syncShare(); syncControls(); syncRecAudio(); } },
      levels: (map) => { if (R === r && r.rtc === rtc) onLevels(map); },
      trouble: (code) => { if (R === r && r.rtc === rtc) onTrouble(code); },
    },
  });
  try {
    await rtc.start(fresh);
    // What the person chose at the door -- and, after a reconnect, what they had on when it
    // dropped. / 此人在门口选好的状态;重连之后,则是断线那一刻的状态。
    if (r.micOn) await rtc.setMic(true, lsGet(LS.mic) || undefined).catch((e) => { console.warn('[meet] mic', e); r.micOn = false; toast(mediaErrorText(e, 'mic'), true); });
    if (r.camOn) await rtc.setCam(true, lsGet(LS.cam) || undefined).catch((e) => { console.warn('[meet] cam', e); r.camOn = false; toast(mediaErrorText(e, 'cam'), true); });
  } catch {
    if (R === r && r.rtc === rtc) toast(t('mt_connect_failed'), true);
  }
  if (R !== r || r.rtc !== rtc) return;
  sendState();
  // A new seat does not know that this browser is still recording. / 新座位并不知道这个浏览器还在录。
  if (r.recorder?.active) r.signal.send({ t: 'rec', on: true });
  syncAll();
}

async function onTrouble(code) {
  const r = R;
  qs('#mt-banner')?.classList.toggle('show', !!code || r.down);
  if (code !== 'ice_failed' || r.rebuilding || r.down) return;
  // The seat is fine and the media path is dead: build a new one on a new SFU session.
  // 座位没事,媒体通路死了:用一个新的 SFU 会话重建一条。
  r.rebuilding = true;
  try { await startMedia(true); } finally { r.rebuilding = false; }
  if (R === r) qs('#mt-banner')?.classList.remove('show');
}

function drawRoom() {
  const r = R;
  show(`
  <div class="mt-room ${r.cfg.video ? '' : 'audio'}" id="mt-room">
    <header class="mt-top">
      <div class="mt-top-title" title="${esc(r.cfg.title)}">${esc(r.cfg.title || t('mt_title'))}</div>
      <span class="mt-rec" id="mt-rec">${icon('record', 14)}<span>${esc(t('mt_rec_on'))}</span></span>
      <span class="mt-onair" id="mt-onair"></span>
      <span class="mt-watch" id="mt-watch" hidden></span>
      <span class="mt-lockmark" id="mt-lockmark" title="${esc(t('mt_locked_note'))}">${icon('lock', 16)}</span>
      ${r.e2ee ? `<button type="button" class="mt-e2ee" id="mt-e2ee" title="${esc(t('mt_e2ee_on'))}">${icon('shield', 14)}<span>${esc(t('mt_e2ee_on'))}</span></button>` : ''}
      <span class="sp"></span>
      <span class="mt-clock dim" id="mt-clock"></span>
    </header>
    <div class="mt-banner" id="mt-banner">${esc(t('mt_reconnecting'))}</div>
    <div class="mt-main">
      <div class="mt-scene" id="mt-scene">
        <div class="mt-share" id="mt-share">
          <video id="mt-share-v" muted playsinline autoplay></video>
          <div class="mt-share-note" id="mt-share-note"></div>
          <div class="mt-share-name" id="mt-share-name"></div>
        </div>
        <div class="mt-strip" id="mt-strip"></div>
        <div class="mt-pager" id="mt-pager">
          <wa-button class="icon" appearance="plain" id="mt-prev" aria-label="${esc(t('mt_page_prev'))}">${icon('back', 18)}</wa-button>
          <span id="mt-pageno" class="dim"></span>
          <wa-button class="icon" appearance="plain" id="mt-next" aria-label="${esc(t('mt_page_next'))}">${icon('next', 18)}</wa-button>
        </div>
      </div>
      <aside class="mt-side" id="mt-side">
        <div class="mt-side-head">
          <span id="mt-side-title"></span><span class="sp"></span>
          <wa-button class="icon" appearance="plain" id="mt-side-close" aria-label="${esc(t('close'))}">${icon('close', 18)}</wa-button>
        </div>
        <div class="mt-side-body" id="mt-people"></div>
        <div class="mt-side-body" id="mt-chat">
          <div class="mt-chat-tabs" id="mt-chat-tabs" hidden>
            <button type="button" data-tab="room">${esc(t('mt_chat_room'))}<span class="mt-tab-n" data-n="room"></span></button>
            <button type="button" data-tab="aud">${esc(t('mt_chat_audience'))}<span class="mt-tab-n" data-n="aud"></span></button>
          </div>
          <div class="mt-chat-log" id="mt-chat-log"></div>
          <form class="mt-chat-form" id="mt-chat-form">
            <wa-input id="mt-chat-input" maxlength="2000" autocomplete="off" placeholder="${esc(t('mt_chat_ph'))}"></wa-input>
            <wa-button class="icon" type="submit" appearance="plain" aria-label="${esc(t('send'))}">${icon('send', 20)}</wa-button>
          </form>
        </div>
      </aside>
    </div>
    <footer class="mt-bar" id="mt-bar"></footer>
    <div id="mt-audio" hidden></div>
  </div>`);

  const started = Date.now();
  r.clock = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    const el = qs('#mt-clock');
    if (el) el.textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  qs('#mt-bar').addEventListener('click', onBarClick);
  qs('#mt-e2ee')?.addEventListener('click', showE2eeInfo);
  // Five quick taps on the clock: what this device is actually receiving. There is no console
  // to open on a phone, and "I hear them but see nobody" needs numbers to be answered.
  // 在时钟上快速点五下:这台设备实际在接收什么。手机上没有控制台可开,而"听得到、看不到"需要数字才答得了。
  let taps = [];
  qs('#mt-clock').addEventListener('click', () => {
    const t = Date.now();
    taps = taps.filter((x) => t - x < 2500).concat(t);
    if (taps.length >= 5) { taps = []; toggleDiag(); }
  });
  qs('#mt-people').addEventListener('click', onPeopleClick);
  qs('#mt-side-close').addEventListener('click', () => setPanel(null));
  qs('#mt-prev').addEventListener('click', () => { R.page = Math.max(0, R.page - 1); syncAll(); });
  qs('#mt-next').addEventListener('click', () => { R.page += 1; syncAll(); });
  qs('#mt-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = qs('#mt-chat-input');
    const text = String(inp.value || '').trim();
    if (!text) return;
    // Which tab is open is who hears it: the people in the room, or everybody watching.
    // 开着哪个页签,就说给谁听:会场里的人,还是所有在看的人。
    if (R.chatTab === 'aud' && R.aud) {
      if (!R.aud.sock.send({ t: 'say', text })) return toast(t('mt_live_offline'), true);
    } else {
      R.signal.send({ t: 'chat', text });
    }
    inp.value = '';
  });
  qs('#mt-chat-tabs').addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-tab]');
    if (!b || !R) return;
    R.chatTab = b.dataset.tab === 'aud' && R.aud ? 'aud' : 'room';
    drawChat();
    syncControls();
    setTimeout(() => qs('#mt-chat-input')?.focus(), 50);
  });
  qs('#mt-chat-log').addEventListener('click', onAudTool);
  // The gallery is laid out for the space it has, and the space changes: a window resized, a
  // phone turned, the side panel opened. / 画廊按它拥有的空间来排版,而空间会变:窗口缩放、手机转向、侧栏打开。
  try {
    r.fit = new ResizeObserver(() => fitGallery());
    r.fit.observe(qs('#mt-scene'));
  } catch { /* old browsers: laid out once per change of the room / 旧浏览器:房间每变一次排一次 */ }
}

// ----- remote media -----

function onRemote(peer, kind, track) {
  const r = R;
  const key = `${peer}:${kind}`;
  if (kind === 'mic') {
    let a = r.audios.get(peer);
    if (!track) { a?.remove(); r.audios.delete(peer); return; }
    if (!a) {
      a = document.createElement('audio');
      a.autoplay = true;
      qs('#mt-audio')?.appendChild(a);
      r.audios.set(peer, a);
    }
    a.srcObject = new MediaStream([track]);
    a.play?.().catch(() => {});
    syncRecAudio();
    return;
  }
  if (track) r.remoteTracks.set(key, track); else r.remoteTracks.delete(key);
  if (kind === 'cam') { const tile = r.tiles.get(peer); if (tile) setTileVideo(tile, track); }
  if (kind === 'screen') syncShare();
}

/** A tile's picture. The element is given the track at once and is always laid out -- the
 *  avatar simply sits on top of it -- and the avatar steps aside when the element has a frame to
 *  show. Hiding the element until then (display: none) is what an iPhone answers by never
 *  decoding the track at all.
 *  一格小画面。元素立刻拿到轨道,并且始终参与布局 —— 头像只是盖在它上面 —— 等元素有一帧可显示了,头像才让开。
 *  在那之前把元素藏起来(display: none),iPhone 的回应是:这条轨干脆不解码。 */
function setTileVideo(tile, track) {
  const v = tile.video;
  const cur = v.srcObject?.getVideoTracks?.()[0] || null;
  if (cur === (track || null)) return;
  tile.el.classList.remove('has-video');
  v.srcObject = track ? new MediaStream([track]) : null;
  if (!track) return;
  const painted = () => {
    if (v.srcObject?.getVideoTracks?.()[0] !== track || !v.videoWidth) return;
    tile.el.classList.add('has-video');
    tile.el.classList.toggle('portrait', v.videoHeight > v.videoWidth);
  };
  v.onloadeddata = painted;
  v.onresize = painted;
  v.onplaying = painted;
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(painted);
  playEl(v);
}

/** Anything that should be playing and is not, is asked to again. A phone pauses media when the
 *  page goes to the background, and does not always start it again by itself.
 *  该在播而没在播的,再请它播一次。手机在页面转到后台时会暂停媒体,回来之后并不总会自己续上。 */
function nudgePlayback() {
  for (const el of qsa('#mt-room video, #mt-room audio')) {
    if (el.srcObject && el.paused) el.play?.().then(() => showTapHint(false)).catch(() => {});
  }
}
document.addEventListener('visibilitychange', () => { if (R && !document.hidden) nudgePlayback(); });
// A phone may refuse to start a video nobody touched -- an iPhone in Low Power Mode refuses even
// silent ones. Any touch inside the room is that permission, so every touch is used as one.
// 手机可能拒绝播放一段"没人碰过"的视频 —— 低电量模式下的 iPhone 连静音的也拒绝。
// 在房间里的任何一次触碰都算是那份许可,所以每一次触碰都拿来用。
for (const type of ['pointerdown', 'touchend', 'click']) {
  document.addEventListener(type, () => { if (R && qs('#mt-room')) nudgePlayback(); }, { capture: true, passive: true });
}

/** Start an element playing, and say so on the screen if the browser will not let us.
 *  让一个元素开始播放;浏览器不允许时,在屏幕上说出来。 */
function playEl(v) {
  const p = v.play?.();
  if (p?.catch) p.catch((e) => { if (e?.name === 'NotAllowedError' && R) showTapHint(true); });
}

function showTapHint(on) {
  let el = qs('#mt-taphint');
  if (!on) { el?.remove(); return; }
  if (el || !qs('#mt-room')) return;
  el = document.createElement('button');
  el.id = 'mt-taphint';
  el.className = 'mt-taphint';
  el.textContent = t('mt_tap_to_play');
  el.addEventListener('click', () => { nudgePlayback(); el.remove(); });
  qs('#mt-room').appendChild(el);
}

function onLevels(map) {
  const r = R;
  const now = Date.now();
  for (const [peer, lvl] of map) if (lvl > 0.04) r.speaking.set(peer || r.me.peer, now);
  for (const [peer, tile] of r.tiles) tile.el.classList.toggle('speaking', now - (r.speaking.get(peer) || 0) < 900);
}

// ----- drawing from the snapshot -----

function peersOrdered() {
  const r = R;
  const list = [...(r.room?.peers || [])];
  const rank = (p) => (p.peer === r.me.peer ? 0 : p.peer === r.room.screen ? 1 : p.role === 'host' ? 2 : 3);
  return list.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

function syncAll() {
  if (!R || !R.room || !qs('#mt-room')) return;
  syncTiles();
  syncShare();
  syncWant();
  syncControls();
  drawPeople();
  syncRecAudio();
  qs('#mt-rec')?.classList.toggle('show', !!R.room.rec);
  const air = qs('#mt-onair');
  if (air) {
    const live = R.room.live || 'off';
    air.classList.toggle('show', live !== 'off');
    air.classList.toggle('pending', live === 'starting' || live === 'stopping');
    air.textContent = live === 'on' ? t('mt_on_air') : live === 'off' ? '' : t('mt_live_preparing');
  }
  qs('#mt-lockmark')?.classList.toggle('show', !!R.room.locked);
  // What each camera is worth sending follows how many pictures share the screen -- and while a
  // screen is up, every camera is a small one beside it.
  // 每路摄像头值得发多大,取决于有多少路画面同屏 —— 而有屏幕共享时,每路摄像头都只是它旁边的一小格。
  const n = Math.min(PAGE, R.room.peers.length);
  R.rtc?.setCrowd(R.room.screen ? Math.max(n, 10) : n);
}

function syncTiles() {
  const r = R;
  const strip = qs('#mt-strip');
  if (!strip || !r.room) return;
  const all = peersOrdered();
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  r.page = Math.min(r.page, pages - 1);
  const visible = all.slice(r.page * PAGE, r.page * PAGE + PAGE);
  r.visible = new Set(visible.map((p) => p.peer));

  for (const [peer, tile] of r.tiles) {
    if (!r.visible.has(peer)) { tile.el.remove(); r.tiles.delete(peer); }
  }
  visible.forEach((p, idx) => {
    let tile = r.tiles.get(p.peer);
    if (!tile) {
      const el = document.createElement('div');
      el.className = 'mt-tile';
      el.dataset.peer = p.peer;
      el.innerHTML = `<video muted playsinline autoplay></video><div class="mt-tile-av"></div>
        <div class="mt-tile-foot"><span class="mt-tile-mic"></span><span class="mt-tile-name"></span></div>
        <span class="mt-tile-hand">${icon('hand', 16)}</span><span class="mt-tile-share">${icon('screenShare', 14)}</span>`;
      tile = { el, video: el.querySelector('video') };
      r.tiles.set(p.peer, tile);
    }
    if (strip.children[idx] !== tile.el) strip.insertBefore(tile.el, strip.children[idx] || null);
    const mine = p.peer === r.me.peer;
    tile.el.classList.toggle('me', mine);
    tile.el.style.setProperty('--peer', `var(--peer-${p.color % 8}, var(--primary))`);
    tile.el.querySelector('.mt-tile-name').textContent = mine ? `${p.name} (${t('mt_you')})` : p.name;
    tile.el.querySelector('.mt-tile-av').innerHTML = avatar(p.name, 56);
    const micOn = mine ? r.micOn : p.mic;
    tile.el.querySelector('.mt-tile-mic').innerHTML = micOn ? '' : icon('micOff', 14);
    tile.el.classList.toggle('hand', !!p.hand);
    tile.el.classList.toggle('presenting', r.room.screen === p.peer);
    setTileVideo(tile, mine ? (r.rtc?.camTrack || null) : (r.remoteTracks.get(`${p.peer}:cam`) || null));
  });

  const pager = qs('#mt-pager');
  pager?.classList.toggle('show', pages > 1);
  const no = qs('#mt-pageno');
  if (no) no.textContent = `${r.page + 1} / ${pages}`;
  qs('#mt-room')?.classList.toggle('sharing', !!r.room.screen && !!r.cfg.video);
  strip.dataset.count = String(visible.length);
  fitGallery();
}

/** Everybody the same size, and that size as large as the space allows. Every number of columns
 *  is tried and the one that gives each 16:9 picture the most width wins: two people on a wide
 *  window sit side by side, the same two on a phone held upright sit one above the other.
 *  While a screen is shared the pictures are a column beside it, laid out by the stylesheet.
 *  人人一样大,而且在空间允许的范围内尽可能大。每一种列数都试一遍,让每路 16:9 画面拿到最大宽度的那种胜出:
 *  两个人在一扇宽窗里左右并排,同样两个人在竖着拿的手机上上下叠放。
 *  有屏幕共享时,画面是它旁边的一列,由样式表来排。 */
function fitGallery() {
  const strip = qs('#mt-strip');
  const room = qs('#mt-room');
  if (!strip || !room) return;
  if (room.classList.contains('sharing')) { strip.style.removeProperty('--tile-w'); return; }
  const n = Math.max(1, strip.children.length);
  const cs = getComputedStyle(strip);
  const gap = parseFloat(cs.columnGap) || 10;
  const W = strip.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const H = strip.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  if (W <= 0 || H <= 0) return;
  let best = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
    if (w > best) best = w;
  }
  // Without pictures there is nothing to make large: a name does not get better at twice the size.
  // 没有画面就没什么可放大的:一个名字放大两倍并不会更好看。
  if (room.classList.contains('audio')) best = Math.min(best, 300);
  strip.style.setProperty('--tile-w', `${Math.max(80, Math.floor(best))}px`);
}

/** The shared screen, when there is one: one picture, shown as large as the room allows, with
 *  everybody beside it. / 共享的屏幕(如果有):一路画面,在房间允许的范围内尽可能大,所有人排在它旁边。 */
function syncShare() {
  const r = R;
  const v = qs('#mt-share-v');
  if (!v || !r.room) return;
  const peer = r.cfg.video ? r.room.screen : null;
  const who = peer ? r.room.peers.find((p) => p.peer === peer) : null;
  const mine = peer && peer === r.me.peer;
  const track = !peer ? null : mine ? r.rtc?.screenTrack || null : r.remoteTracks.get(`${peer}:screen`) || null;
  const cur = v.srcObject?.getVideoTracks?.()[0] || null;
  if (cur !== track) {
    v.srcObject = track ? new MediaStream([track]) : null;
    if (track) playEl(v);
  }
  const note = qs('#mt-share-note');
  if (note) note.textContent = peer && !track ? t('mt_connecting_screen', who?.name || '') : '';
  const nm = qs('#mt-share-name');
  if (nm) nm.textContent = !who ? '' : mine ? t('mt_you_are_sharing') : t('mt_screen_of', who.name);
}

function syncWant() {
  const r = R;
  if (!r.rtc || !r.room) return;
  const out = [];
  for (const p of r.room.peers) {
    if (p.peer === r.me.peer) continue;
    if (p.pub.includes('mic')) out.push({ peer: p.peer, kind: 'mic' });
    if (r.cfg.video && r.visible?.has(p.peer) && p.pub.includes('cam')) out.push({ peer: p.peer, kind: 'cam' });
    if (r.cfg.video && r.room.screen === p.peer && p.pub.includes('screen')) out.push({ peer: p.peer, kind: 'screen' });
  }
  r.rtc.want(out);
}

// ----- the bar -----

function syncControls() {
  const r = R;
  const bar = qs('#mt-bar');
  if (!bar || !r.room) return;
  const host = r.me.role === 'host';
  const sharing = !!r.rtc?.screenTrack;
  const canShare = r.cfg.video && !!navigator.mediaDevices?.getDisplayMedia;
  const btn = (act, ic, label, cls = '', badge = '') =>
    `<wa-button class="icon mt-round ${cls}" appearance="filled" data-act="${act}" aria-label="${esc(label)}" title="${esc(label)}">${icon(ic, 22)}${badge ? `<span class="mt-badge">${esc(badge)}</span>` : ''}</wa-button>`;
  bar.innerHTML = `
    <div class="mt-bar-g">
      ${btn('mic', r.micOn ? 'mic' : 'micOff', t(r.micOn ? 'mt_mute' : 'mt_unmute'), r.micOn ? '' : 'off')}
      ${r.cfg.video ? btn('cam', r.camOn ? 'videocam' : 'videocamOff', t(r.camOn ? 'mt_cam_stop' : 'mt_cam_start'), r.camOn ? '' : 'off') : ''}
      ${canShare ? btn('screen', sharing ? 'screenShareStop' : 'screenShare', t(sharing ? 'mt_stop_share' : 'mt_share_screen'), sharing ? 'active' : '') : ''}
      ${btn('hand', 'hand', t(r.hand ? 'mt_lower_hand' : 'mt_raise_hand'), r.hand ? 'active' : '')}
    </div>
    <div class="mt-bar-g">
      ${btn('people', 'people', t('mt_people'), r.panel === 'people' ? 'active' : '', peopleBadge(r))}
      ${btn('chat', 'chat', t('mt_chat'), r.panel === 'chat' ? 'active' : '', chatBadge(r))}
      <wa-dropdown placement="top-end" id="mt-more">
        <wa-button slot="trigger" class="icon mt-round" appearance="filled" aria-label="${esc(t('mt_more'))}" title="${esc(t('mt_more'))}">${icon('more', 22)}</wa-button>
        ${canShare ? `<wa-dropdown-item class="mt-narrow-only" value="act_screen">${icon('screenShare', 18)} ${esc(t(sharing ? 'mt_stop_share' : 'mt_share_screen'))}</wa-dropdown-item>` : ''}
        <wa-dropdown-item class="mt-narrow-only" value="act_hand">${icon('hand', 18)} ${esc(t(r.hand ? 'mt_lower_hand' : 'mt_raise_hand'))}</wa-dropdown-item>
        <wa-dropdown-item value="link">${icon('link', 18)} ${esc(t('mt_copy_link'))}</wa-dropdown-item>
        <wa-dropdown-item value="diag">${icon('info', 18)} ${esc(t('mt_diag'))}</wa-dropdown-item>
        ${host && r.cfg.record_mode === 'local' && (r.recorder?.active || !r.room.rec) ? `
          <wa-dropdown-item value="${r.recorder?.active ? 'rec_stop' : 'rec_start'}">${icon('record', 18)} ${esc(t(r.recorder?.active ? 'mt_rec_stop' : 'mt_rec_start'))}</wa-dropdown-item>` : ''}
        ${r.cfg.kind === 'live' ? `<wa-dropdown-item value="live_link">${icon('link', 18)} ${esc(t('mt_live_copy_link'))}</wa-dropdown-item>` : ''}
        ${host && r.cfg.kind === 'live' ? `
          <wa-dropdown-item value="${(r.room.live || 'off') === 'off' ? 'live_start' : 'live_stop'}">${icon('videocam', 18)} ${esc(t((r.room.live || 'off') === 'off' ? 'mt_live_start' : 'mt_live_stop'))}</wa-dropdown-item>` : ''}
        ${host ? `
          <wa-dropdown-item value="mute_all">${icon('micOff', 18)} ${esc(t('mt_mute_all'))}</wa-dropdown-item>
          <wa-dropdown-item value="lock">${icon(r.room.locked ? 'lockOpen' : 'lock', 18)} ${esc(t(r.room.locked ? 'mt_unlock' : 'mt_lock'))}</wa-dropdown-item>
          <wa-dropdown-item value="end" variant="danger">${icon('stop', 18)} ${esc(t('mt_end'))}</wa-dropdown-item>` : ''}
      </wa-dropdown>
    </div>
    <div class="mt-bar-g">
      <wa-button class="mt-leave" variant="danger" data-act="leave" aria-label="${esc(t('mt_leave'))}" title="${esc(t('mt_leave'))}">${icon('callEnd', 22)}</wa-button>
    </div>`;
  qs('#mt-more')?.addEventListener('wa-select', onMoreSelect);
}

/** A dot beside the head count when somebody is waiting on a host: at the door, or in the
 *  audience asking to speak. / 有人在等主持人时,人数旁边加一个点:等在门口的,或观众席上申请发言的。 */
function peopleBadge(r) {
  const host = r.me?.role === 'host';
  const asks = host && r.aud ? r.aud.hands.filter((a) => !a.invited).length : 0;
  return String((r.room?.peers || []).length) + (host && (r.room?.lobby?.length || asks) ? ' •' : '');
}

function chatBadge(r) {
  const n = r.unread + (r.aud?.unread || 0);
  return n ? String(Math.min(99, n)) : '';
}

/** Just the two numbers on the bar. The audience can talk far more often than the bar should be
 *  rebuilt -- rebuilding it closes a menu somebody has open.
 *  只改控制条上那两个数字。观众说话的频率远高于控制条该重建的频率 —— 重建会关掉别人正开着的菜单。 */
function syncBadges() {
  const r = R;
  if (!r?.room) return;
  const set = (act, text) => {
    const b = qs(`#mt-bar [data-act="${act}"]`);
    if (!b) return;
    let s = b.querySelector('.mt-badge');
    if (!text) { s?.remove(); return; }
    if (!s) { s = document.createElement('span'); s.className = 'mt-badge'; b.appendChild(s); }
    s.textContent = text;
  };
  set('people', peopleBadge(r));
  set('chat', chatBadge(r));
}

function onBarClick(e) {
  const b = e.target.closest?.('[data-act]');
  if (b && R) doAct(b.dataset.act);
}

/** One place for what a control does, because on a narrow screen two of them live in the menu
 *  instead of on the bar. / 每个控件做什么只写一处,因为在窄屏上其中两个住在菜单里而不是控制条上。 */
async function doAct(act) {
  const r = R;
  try {
    if (act === 'mic') {
      r.micOn = !r.micOn;
      lsSet(LS.micOn, r.micOn ? '1' : '0');
      try { await r.rtc.setMic(r.micOn, lsGet(LS.mic) || undefined); } catch (err) { r.micOn = false; toast(mediaErrorText(err, 'mic'), true); }
      sendState();
    } else if (act === 'cam') {
      r.camOn = !r.camOn;
      lsSet(LS.camOn, r.camOn ? '1' : '0');
      try { await r.rtc.setCam(r.camOn, lsGet(LS.cam) || undefined); } catch (err) { r.camOn = false; toast(mediaErrorText(err, 'cam'), true); }
      sendState();
    } else if (act === 'screen') {
      if (r.rtc?.screenTrack) await r.rtc.stopScreen();
      else if (r.room.screen && r.room.screen !== r.me.peer) toast(t('mt_screen_busy', r.room.peers.find((p) => p.peer === r.room.screen)?.name || ''), true);
      else {
        // The browser's picker opens from this click; the room may still say no, if somebody
        // else got there first. / 浏览器的选择框由这次点击打开;要是别人抢先一步,房间仍然会说不。
        try { await r.rtc.startScreen(); } catch (err) {
          if (err?.code === 'screen_busy') toast(t('mt_screen_busy', ''), true);
          else if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') { /* the picker was cancelled / 选择框被取消了 */ }
          else toast(t('mt_share_failed'), true);
        }
      }
    } else if (act === 'hand') {
      r.hand = !r.hand;
      r.signal.send({ t: 'hand', on: r.hand });
    } else if (act === 'people' || act === 'chat') {
      setPanel(r.panel === act ? null : act);
    } else if (act === 'leave') {
      // Somebody who came up from the audience steps back down into it.
      // 从观众席上来的人,走下台就回到观众席。
      if (r.ticket) { forgetTicket(r.code); teardown(); navigate(`#/live/${r.code}`); return; }
      const back = store.me ? '#/meet' : '';
      teardown();
      if (back) navigate(back); else showNotice('back', t('mt_left'));
      return;
    }
  } finally {
    if (R === r) { syncControls(); syncTiles(); }
  }
}

async function onMoreSelect(e) {
  const r = R;
  const v = e.detail?.item?.value;
  if (!r || !v) return;
  if (v.startsWith('act_')) return doAct(v.slice(4));
  if (v === 'link') { await copyText(shareLink(r)); toast(t(r.e2ee ? 'mt_e2ee_link_copied' : 'mt_link_copied'), false, r.e2ee ? 7000 : 0); }
  else if (v === 'diag') toggleDiag();
  else if (v === 'live_link') { await copyText(`${location.origin}/#/live/${r.code}`); toast(t('mt_link_copied')); }
  else if (v === 'live_start') r.signal.send({ t: 'live_start' });
  else if (v === 'live_stop') { if (await confirmDialog(t('mt_live_stop_confirm'), t('mt_live_stop'))) r.signal.send({ t: 'live_stop' }); }
  else if (v === 'rec_start') openRecordDialog();
  else if (v === 'rec_stop') r.recorder?.stop('');
  else if (v === 'mute_all') r.signal.send({ t: 'mute', peer: 'all' });
  else if (v === 'lock') r.signal.send({ t: 'lock', on: !r.room.locked });
  else if (v === 'end') { if (await confirmDialog(t('mt_end_confirm'), t('mt_end'))) r.signal.send({ t: 'end' }); }
}

// ----- the lock on the door -----
// ----- 门上的锁 -----

/** What "end-to-end encrypted" means here, the fingerprint to compare when somebody sees nothing,
 *  and the full link to pass on. / 这里的"端到端加密"意味着什么、有人什么都看不到时拿来对的指纹,以及要转交的完整链接。 */
async function showE2eeInfo() {
  const r = R;
  if (!r?.e2ee) return;
  const fp = await fingerprint(r.e2ee);
  const dlg = showModal(`
    <h3 style="margin:0 0 10px">${icon('shield', 20)} ${esc(t('mt_e2ee_on'))}</h3>
    <p style="margin:0 0 10px;line-height:1.6">${esc(t('mt_e2ee_explain'))}</p>
    <p style="margin:0 0 6px" class="dim">${esc(t('mt_e2ee_fingerprint'))}</p>
    <div class="mt-fp">${esc(fp)}</div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button appearance="outlined" id="e2-copy">${icon('link', 18)} ${esc(t('mt_e2ee_copy_link'))}</wa-button>
      <wa-button variant="brand" id="e2-close">${esc(t('close'))}</wa-button>
    </div>`);
  dlg.style.setProperty('--width', 'min(520px, 94vw)');
  dlg.querySelector('#e2-close').addEventListener('click', closeModal);
  dlg.querySelector('#e2-copy').addEventListener('click', async () => { await copyText(shareLink(r)); toast(t('mt_e2ee_link_copied'), false, 7000); });
}

// ----- looking inside -----
// ----- 往里看一眼 -----

function toggleDiag() {
  const r = R;
  const old = qs('#mt-diag');
  if (old) { clearInterval(r.diagTimer); old.remove(); return; }
  const box = document.createElement('pre');
  box.id = 'mt-diag';
  box.className = 'mt-diag';
  qs('#mt-room')?.appendChild(box);
  const draw = async () => {
    if (R !== r || !qs('#mt-diag')) return clearInterval(r.diagTimer);
    const d = await r.rtc?.diag().catch(() => null);
    const box2 = (el) => { const b = el.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}`; };
    const els = qsa('#mt-room video').filter((v) => v.srcObject).map((v) => `${v.closest('.mt-tile')?.dataset.peer || 'screen'} frame=${v.videoWidth}x${v.videoHeight} box=${box2(v)} ready=${v.readyState} ${v.paused ? 'PAUSED' : 'playing'}${v.closest('.mt-tile')?.classList.contains('has-video') ? ' shown' : ''}`);
    els.unshift(`window ${innerWidth}x${innerHeight} · scene ${qs('#mt-scene') ? box2(qs('#mt-scene')) : '-'} · share ${qs('#mt-share') ? box2(qs('#mt-share')) : '-'} · gallery ${qs('#mt-strip') ? box2(qs('#mt-strip')) : '-'} · mic ${r.micOn ? 'on' : 'off'} cam ${r.camOn ? 'on' : 'off'}`);
    box.textContent = [
      `${navigator.userAgent.replace(/^.*?\) /, '').slice(0, 60)}`,
      `v${store.brand?.version || '?'} · ice ${d?.ice} · conn ${d?.conn} · sig ${d?.sig}`,
      ...(r.crypt ? [`e2ee ${JSON.stringify(await r.crypt.stats())}`] : []),
      ...(d?.rows || []).map((x) => `${x.key.slice(0, 8)}${x.key.slice(x.key.indexOf(':'))} mid=${x.mid} ${x.muted ? 'MUTED' : 'unmuted'} ${x.codec.replace('video/', '').replace('audio/', '')} ${Math.round(x.bytes / 1024)}KB dec=${x.decoded ?? '-'} drop=${x.dropped ?? '-'} ${x.size} pli=${x.pli ?? '-'} ${x.decoder}`),
      '— elements —', ...els,
    ].join('\n');
  };
  draw();
  r.diagTimer = setInterval(draw, 1500);
}

// ----- keeping it -----
// ----- 留下它 -----

/** What the recorder should be looking at and listening to, asked of the page every frame.
 *  录制器该看什么,每一帧都来问页面一次。 */
function sceneOf(r) {
  if (R !== r || !r.room) return null;
  const v = qs('#mt-share-v');
  const who = r.room.screen ? r.room.peers.find((p) => p.peer === r.room.screen) : null;
  return {
    // A shared screen fills the recording; otherwise everybody does, as they do on the screen.
    // 有共享屏幕时,它占满录像;否则就是所有人,和屏幕上一样。
    stage: who && v?.srcObject ? { video: v, name: t('mt_screen_of', who.name) } : null,
    tiles: peersOrdered().slice(0, PAGE).map((p) => {
      const tile = r.tiles.get(p.peer);
      return { video: tile?.el.classList.contains('has-video') ? tile.video : null, name: p.name, color: p.color };
    }),
  };
}

function syncRecAudio() {
  const r = R;
  if (!r?.recorder?.active) return;
  r.recorder.syncAudio([r.rtc?.micTrack, ...[...r.audios.values()].map((a) => a.srcObject?.getAudioTracks?.()[0])]);
}

function openRecordDialog() {
  const r = R;
  const drive = !!store.me?.drive_enabled;
  const audioOnly = !r.cfg.video;
  const keep0 = lsGet(LS.recKeep) !== '0';
  const min0 = !!r.cfg.minutes && lsGet(LS.recMinutes) === '1';
  const dlg = showModal(`
    <h3 style="margin:0 0 14px">${esc(t('mt_rec_title'))}</h3>
    <div class="mt-recopts">
      <wa-checkbox id="rc-keep" ${keep0 || !r.cfg.minutes ? 'checked' : ''} ${r.cfg.minutes ? '' : 'disabled'}>${esc(t(audioOnly ? 'mt_rec_keep_audio' : 'mt_rec_keep'))}</wa-checkbox>
      <div class="hint dim">${esc(drive ? t('mt_rec_keep_hint', t('mt_rec_folder')) : t('mt_rec_keep_local'))}</div>
      ${r.cfg.minutes ? `<wa-checkbox id="rc-minutes" ${min0 ? 'checked' : ''}>${esc(t('mt_rec_minutes'))}</wa-checkbox>
      <div class="hint dim">${esc(t('mt_rec_minutes_hint'))}</div>` : ''}
    </div>
    <div class="hint dim" style="margin-top:14px">${esc(t('mt_rec_everyone'))}</div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button appearance="plain" id="rc-cancel">${esc(t('cancel'))}</wa-button>
      <wa-button variant="brand" id="rc-go">${icon('record', 18)} ${esc(t('mt_rec_start'))}</wa-button>
    </div>`);
  dlg.style.setProperty('--width', 'min(520px, 94vw)');
  dlg.querySelector('#rc-cancel').addEventListener('click', closeModal);
  dlg.querySelector('#rc-go').addEventListener('click', async () => {
    const keep = !!dlg.querySelector('#rc-keep')?.checked;
    const minutes = !!dlg.querySelector('#rc-minutes')?.checked;
    if (!keep && !minutes) return toast(t('mt_rec_nothing'), true);
    lsSet(LS.recKeep, keep ? '1' : '0');
    lsSet(LS.recMinutes, minutes ? '1' : '0');
    const btn = dlg.querySelector('#rc-go');
    btn.loading = true;
    try { await startRecording({ keep, minutes }); } finally { btn.loading = false; }
    closeModal();
  });
}

async function startRecording({ keep, minutes }) {
  const r = R;
  if (!r || r.recorder?.busy) return;
  let mod;
  try { mod = await import(`./record.js?v=${encodeURIComponent(store.brand?.version || '')}`); } catch { return toast(t('mt_rec_unsupported'), true); }
  if (!mod.recordingSupported()) return toast(t('mt_rec_unsupported'), true);
  const meeting = { id: r.cfg.id, title: r.cfg.title };
  const rec = new mod.MeetRecorder({
    meeting, video: !!r.cfg.video, resolution: r.cfg.resolution, keep, minutes, drive: !!store.me?.drive_enabled,
    scene: () => sceneOf(r),
    onState: (state, info) => onRecState(r, rec, meeting, state, info),
  });
  try {
    await rec.start();
  } catch (e) {
    return toast(t('mt_rec_failed', e?.message || ''), true);
  }
  if (R !== r) { rec.stop('left'); return; }
  r.recorder = rec;
  r.signal.send({ t: 'rec', on: true });
  syncRecAudio();
  syncControls();
}

/** The recorder's own account of itself. Everything after 'recording' may arrive when the room
 *  is long gone, so none of it may touch the room without asking whether it is still there.
 *  录制器对自己状态的陈述。'recording' 之后的每一条,都可能在房间早已不在时才到,
 *  所以哪一条都不能不先问一句"房间还在吗"就去碰房间。 */
let savingRecorders = 0;
function onRecState(r, rec, meeting, state, info) {
  const here = R === r && r.recorder === rec;
  if (state === 'saving') {
    savingRecorders += 1;
    savingChip(t('mt_rec_saving'));
    if (here) { r.signal?.send({ t: 'rec', on: false }); syncControls(); }
    if (info?.reason === 'quota') toast(t('mt_rec_quota_stop'), true, 9000);
  } else if (state === 'minutes') {
    savingChip(t('mt_rec_saving_minutes'));
  } else if (state === 'done' || state === 'failed') {
    savingRecorders = Math.max(0, savingRecorders - 1);
    if (!savingRecorders) savingChip('');
    if (here) { r.recorder = null; syncControls(); }
    if (state === 'failed') toast(t('mt_rec_failed', info?.error?.message || ''), true, 9000);
    else showRecResult(meeting, info);
  }
}

/** A small mark that outlives the room: the file is still on its way up.
 *  一个比房间活得久的小标记:文件还在往上传。 */
function savingChip(text) {
  let el = document.getElementById('mt-saving');
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'mt-saving';
    el.className = 'mt-saving';
    el.innerHTML = '<wa-spinner></wa-spinner><span></span>';
    document.body.appendChild(el);
  }
  el.querySelector('span').textContent = text;
}

// Closing the tab now would cut the file short. / 现在关掉标签页,文件就会被截短。
window.addEventListener('beforeunload', (e) => {
  if (!savingRecorders && !R?.recorder?.active) return;
  e.preventDefault();
  e.returnValue = '';
});

function showRecResult(meeting, res) {
  if (!res) return;
  const o = res.options || {};
  if (res.failure) toast(t('mt_rec_failed', res.failure.message || ''), true, 9000);
  else if (res.node) toast(t('mt_rec_saved', t('mt_rec_folder')), false, 6000);
  else if (res.local && !res.markdown) toast(t('mt_rec_saved_local'), false, 6000);
  if (o.minutes && !res.said) toast(t('mt_minutes_none'), true, 7000);
  if (!res.markdown) return;
  const folder = res.folder?.id && store.me?.drive_enabled ? `#/drive/folder/${res.folder.id}` : '';
  const dlg = showModal(`
    <h3 style="margin:0 0 8px">${esc(t('mt_minutes_title'))} · ${esc(meeting.title || t('mt_untitled'))}</h3>
    <div class="hint dim">${esc(t(res.minutesNode ? 'mt_minutes_hint' : 'mt_minutes_hint_local'))}${res.lost ? ' ' + esc(t('mt_minutes_partial', res.lost)) : ''}</div>
    <pre class="mt-minutes">${esc(res.summary || res.markdown.slice(0, 6000))}</pre>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      ${folder ? `<wa-button appearance="outlined" id="mn-open">${icon('cloud', 18)} ${esc(t('mt_rec_open_drive'))}</wa-button>` : ''}
      ${res.summary ? `<wa-button appearance="outlined" id="mn-mail">${icon('mail', 18)} ${esc(t('mt_minutes_send'))}</wa-button>` : ''}
      <wa-button variant="brand" id="mn-close">${esc(t('close'))}</wa-button>
    </div>`);
  dlg.style.setProperty('--width', 'min(680px, 94vw)');
  dlg.querySelector('#mn-close').addEventListener('click', closeModal);
  dlg.querySelector('#mn-open')?.addEventListener('click', () => { closeModal(); navigate(folder); });
  dlg.querySelector('#mn-mail')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.loading = true;
    try {
      const out = await api('POST', `/api/meet/${meeting.id}/minutes/mail`, { summary: res.summary, markdown: res.markdown });
      toast(t('mt_minutes_sent', out.sent));
      btn.disabled = true;
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.loading = false;
    }
  });
}

// ----- the side panel -----

function setPanel(which) {
  const r = R;
  r.panel = which;
  const side = qs('#mt-side');
  side?.classList.toggle('open', !!which);
  qs('#mt-people')?.classList.toggle('show', which === 'people');
  qs('#mt-chat')?.classList.toggle('show', which === 'chat');
  const title = qs('#mt-side-title');
  if (title) title.textContent = which === 'chat' ? t('mt_chat') : t('mt_people');
  if (which === 'chat') { drawChat(); setTimeout(() => qs('#mt-chat-input')?.focus(), 50); }
  if (which === 'people') drawPeople();
  syncControls();
}

function drawPeople() {
  const r = R;
  const box = qs('#mt-people');
  if (!box || !r.room) return;
  const host = r.me.role === 'host';
  const roleTag = (p) => (p.role === 'host' ? `<span class="mt-tag">${esc(t('mt_host'))}</span>` : p.role === 'guest' ? `<span class="mt-tag dim">${esc(t('mt_guest'))}</span>` : '');
  const lobby = host && r.room.lobby?.length ? `
    <div class="mt-sec">${esc(t('mt_lobby'))} · ${r.room.lobby.length}</div>
    ${r.room.lobby.map((p) => `<div class="mt-person">${avatar(p.name, 32)}<span class="nm">${esc(p.name)}</span>
      <wa-button size="small" variant="brand" data-do="admit" data-peer="${esc(p.peer)}">${esc(t('mt_admit'))}</wa-button>
      <wa-button size="small" appearance="plain" data-do="deny" data-peer="${esc(p.peer)}">${esc(t('mt_deny'))}</wa-button></div>`).join('')}` : '';
  // Viewers asking to speak. "Let up" is grey while the stage is full; the door would say no anyway.
  // 申请发言的观众。台上满员时「允许」是灰的;就算不灰,门口也会拒绝。
  const full = (r.room.peers || []).length >= (r.cfg?.max_people || 0);
  const asks = host && r.aud?.hands?.length ? `
    <div class="mt-sec">${esc(t('mt_asks'))} · ${r.aud.hands.length}</div>
    ${r.aud.hands.map((a) => `<div class="mt-person">${avatar(a.name, 32)}
      <span class="nm">${esc(a.name)} ${a.badge === 'guest' ? `<span class="mt-tag dim">${esc(t('mt_guest'))}</span>` : ''}</span>
      ${a.invited
        ? `<span class="dim mt-ask-state">${esc(t('mt_ask_invited'))}</span>
           <wa-button class="icon" size="small" appearance="plain" data-do="aud_deny" data-vid="${esc(a.vid)}" title="${esc(t('mt_ask_withdraw'))}" aria-label="${esc(t('mt_ask_withdraw'))}">${icon('close', 18)}</wa-button>`
        : `<wa-button size="small" variant="brand" data-do="aud_admit" data-vid="${esc(a.vid)}" ${full ? `disabled title="${esc(t('mt_ask_full'))}"` : ''}>${esc(t('mt_ask_allow'))}</wa-button>
           <wa-button size="small" appearance="plain" data-do="aud_deny" data-vid="${esc(a.vid)}">${esc(t('mt_deny'))}</wa-button>`}
    </div>`).join('')}` : '';
  const people = peersOrdered().map((p) => {
    const mine = p.peer === r.me.peer;
    const acts = host && !mine ? `
      ${r.room.screen === p.peer ? `<wa-button class="icon" size="small" appearance="plain" data-do="screen_stop" data-peer="${esc(p.peer)}" title="${esc(t('mt_stop_their_share'))}">${icon('screenShareStop', 18)}</wa-button>` : ''}
      <wa-button class="icon" size="small" appearance="plain" data-do="mute" data-peer="${esc(p.peer)}" title="${esc(t('mt_mute_one'))}">${icon('micOff', 18)}</wa-button>
      ${p.role !== 'host' ? `<wa-button class="icon" size="small" appearance="plain" data-do="kick" data-peer="${esc(p.peer)}" data-name="${esc(p.name)}" title="${esc(t('mt_kick'))}">${icon('close', 18)}</wa-button>` : ''}` : '';
    return `<div class="mt-person">${avatar(p.name, 32)}
      <span class="nm">${esc(p.name)}${mine ? ` (${esc(t('mt_you'))})` : ''} ${roleTag(p)}</span>
      <span class="st">${p.hand ? icon('hand', 16) : ''}${r.room.screen === p.peer ? icon('screenShare', 16) : ''}${(mine ? r.micOn : p.mic) ? '' : icon('micOff', 16)}</span>
      ${acts}</div>`;
  }).join('');
  box.innerHTML = `${asks}${lobby}<div class="mt-sec">${esc(t('mt_in_meeting'))} · ${r.room.peers.length}</div>${people}`;
}

async function onPeopleClick(e) {
  const b = e.target.closest?.('[data-do]');
  if (!b || !R) return;
  const { do: what, peer, name, vid } = b.dataset;
  // A viewer's request is answered at the audience's hall, not in the room.
  // 观众的申请在观众总台答复,而不是在房间里。
  if (what === 'aud_admit' || what === 'aud_deny') { R.aud?.sock.send({ t: what === 'aud_admit' ? 'admit' : 'deny', vid }); return; }
  if (what === 'kick' && !(await confirmDialog(t('mt_kick_confirm', name || ''), t('mt_kick')))) return;
  R?.signal.send({ t: what, peer });
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/** A link in the chat. One that leads to a document being shown from this same deployment says
 *  what it is rather than where it is: in a meeting, "open the presentation" is the thing people
 *  are looking for, and a line of address is not.
 *  聊天里的一条链接。通向"本部署上正在被展示的文档"的那种,说的是它是什么,而不是它在哪:
 *  在会议里,人们要找的是"打开演示",而不是一行地址。 */
function chatLink(u) {
  let doc = false;
  try {
    const x = new URL(u.replace(/&amp;/g, '&'));
    doc = x.origin === location.origin && /^#\/(p|watch|view)\//.test(x.hash);
  } catch { /* not an address after all / 终究不是个地址 */ }
  return doc
    ? `<a class="mt-doc" href="${u}" target="_blank" rel="noopener noreferrer" title="${u}">${icon('present', 16)}<span>${esc(t('mt_open_doc'))}</span></a>`
    : `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`;
}
function drawChat() {
  const r = R;
  const log = qs('#mt-chat-log');
  if (!log) return;
  // Two conversations in a broadcast meeting: the room's, and the audience's (when the organiser
  // let the audience talk). / 直播会议里有两场对话:会场的,和观众的(组织者允许观众说话时)。
  const audOn = !!(r.aud && r.aud.chat);
  if (!audOn) r.chatTab = 'room';
  const tabs = qs('#mt-chat-tabs');
  if (r.panel === 'chat') { if (r.chatTab === 'aud') r.aud.unread = 0; else r.unread = 0; }
  if (tabs) {
    tabs.hidden = !audOn;
    tabs.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === r.chatTab));
    const n = (v) => (v ? ` ${Math.min(99, v)}` : '');
    tabs.querySelector('[data-n="room"]').textContent = n(r.unread);
    tabs.querySelector('[data-n="aud"]').textContent = n(r.aud?.unread || 0);
  }
  const inp = qs('#mt-chat-input');
  if (inp) inp.placeholder = t(r.chatTab === 'aud' ? 'mt_chat_ph_aud' : 'mt_chat_ph');
  const switched = log.dataset.tab !== r.chatTab;
  log.dataset.tab = r.chatTab;
  if (r.chatTab === 'aud') {
    if (!r.aud.lines.length) { log.innerHTML = `<div class="mt-chat-empty dim">${esc(t('mt_live_chat_empty'))}</div>`; return; }
    const stick = switched || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const mod = r.me?.role === 'host';
    log.innerHTML = r.aud.lines.map((m) => audLineHtml(m, { mine: r.aud.mine.has(m.id), mod })).join('');
    if (stick) log.scrollTop = log.scrollHeight;
    return;
  }
  if (!r.chat.length) { log.innerHTML = `<div class="mt-chat-empty dim">${esc(t('mt_chat_empty'))}</div>`; return; }
  const stick = switched || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = r.chat.map((m) => {
    const mine = m.from === r.me?.peer;
    const body = esc(m.text).replace(URL_RE, chatLink);
    const at = new Date(m.at);
    return `<div class="mt-msg ${mine ? 'mine' : ''}"><div class="mt-msg-h"><b>${esc(mine ? t('mt_you') : m.name)}</b>
      <span class="dim">${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}</span></div><div class="mt-msg-b">${body}</div></div>`;
  }).join('');
  if (stick) log.scrollTop = log.scrollHeight;
}

// ---------- the audience, seen from the stage ----------
// ---------- 从台上看观众席 ----------

/** In a broadcast meeting the room hands each seat a pass to the audience's hall. With it this
 *  page hears the audience's chat and can answer in it, sees how many are watching, and -- for a
 *  host -- sees the queue of viewers asking to speak. A new seat (a reconnect) brings a new pass.
 *  直播会议里,房间给每个座位一张去观众总台的后台证。凭它,这个页面听得到观众的聊天、能在里面回话、
 *  看得到多少人在看;主持人还能看到申请发言的观众队列。换了座位(重连)就换一张新证。 */
function openAud(r, pass) {
  if (!pass) {
    try { r.aud?.sock.close(); } catch { /* gone / 已无 */ }
    r.aud = null;
    return;
  }
  if (r.aud?.pass === pass) return;
  const was = r.aud;
  try { was?.sock.close(); } catch { /* gone / 已无 */ }
  const a = {
    pass, sock: null, chat: was?.chat || false, lines: was?.lines || [], mine: was?.mine || new Set(),
    hands: was?.hands || [], count: was?.count || 0, unread: was?.unread || 0,
  };
  r.aud = a;
  a.sock = joinAudience({
    code: r.code,
    query: () => ({ pass: a.pass }),
    on: (m) => { if (R === r && r.aud === a) onAud(r, a, m); },
  });
}

function onAud(r, a, m) {
  switch (m.t) {
    case 'hello':
      a.chat = !!m.chat;
      a.lines = mergeLines([], m.hist);
      a.count = Number(m.count) || 0;
      if (Array.isArray(m.hands)) a.hands = m.hands;
      break;
    case 'chat': {
      const have = new Set(a.lines.map((x) => x.id));
      const fresh = (m.msgs || []).filter((x) => !have.has(x.id)).length;
      mergeLines(a.lines, m.msgs);
      if (r.panel !== 'chat' || r.chatTab !== 'aud') a.unread += fresh;
      break;
    }
    case 'said':
      a.mine.add(m.id);
      break;
    case 'del': {
      const ids = new Set(m.ids || []);
      a.lines = a.lines.filter((x) => !ids.has(x.id));
      break;
    }
    case 'count':
      a.count = Number(m.n) || 0;
      break;
    case 'hands': {
      const before = new Set(a.hands.map((x) => x.vid));
      const added = (m.list || []).filter((x) => !before.has(x.vid) && !x.invited);
      a.hands = m.list || [];
      if (r.me?.role === 'host' && added.length) toast(t('mt_ask_new', added[added.length - 1].name));
      break;
    }
    case 'reset':
      a.hands = [];
      if (m.full) a.lines = [];
      break;
    case 'err':
      toast(tErr(m.code, []), true);
      return;
    default:
      return;
  }
  if (r.panel === 'chat') drawChat();
  if (r.panel === 'people') drawPeople();
  paintWatch();
  syncBadges();
}

/** A host's two tools on a viewer's line. / 主持人对观众某一句的两样工具。 */
async function onAudTool(e) {
  const b = e.target.closest?.('[data-aud-do]');
  if (!b || !R?.aud || R.me?.role !== 'host') return;
  const id = Number(b.dataset.id);
  if (b.dataset.audDo === 'block') {
    if (!(await confirmDialog(t('mt_aud_block_confirm', b.dataset.name || ''), t('mt_aud_block')))) return;
    R?.aud?.sock.send({ t: 'block', id });
  } else {
    R.aud.sock.send({ t: 'hide', id });
  }
}

function paintWatch() {
  const el = qs('#mt-watch');
  if (!el) return;
  const n = R?.aud?.count || 0;
  el.hidden = !(R?.aud && n > 0);
  el.title = t('mt_live_watching', n);
  el.innerHTML = `${icon('eye', 14)}<span>${n}</span>`;
}

void qsa;
