// Meetings: the list, and the dialog a meeting is made in.
//
// A meeting is made of decisions that cannot sensibly be changed once people are in it -- how
// many, whether there is video at all, how large the large picture is, who may walk in without an
// account. So they are asked here, once, with defaults that make the common case one click: a
// meeting right now, with video, for colleagues. Everything the host can change mid-meeting
// (who holds the large picture, whether the door is locked) is not here; it is on the room's bar.
//
// The room itself is another module (room.js) at another address (#/meet/<code>), because it has
// to open for people who cannot see this page at all.
//
// 会议:列表,以及创建会议的那个对话框。
//
// 一场会议由这样一些决定构成:人一旦进来,它们就不宜再改 —— 多少人、到底有没有视频、大画面多大、
// 谁可以不带账号走进来。所以它们在这里问、只问一次,并且默认值让最常见的情形一键完成:
// 一场此刻就开、有视频、面向同事的会议。主持人能在会中改变的一切(大画面在谁手上、门锁没锁)
// 不在这里,在房间的控制条上。
//
// 房间本身是另一个模块(room.js)、另一个地址(#/meet/<code>),因为它必须对根本看不到这一页的人打开。
import { api } from '../api.js';
import { t, lang } from '../i18n.js';
import { esc, icon, qs, qsa, toast, confirmDialog, copyText, loadCss, showModal, closeModal } from '../ui.js';
import { bindTopbar, store, navigate, show, topbarHtml, setTitle, syncSidebar } from '../app.js';
import { forgetSecret, newSecret, recallSecret, rememberSecret, withSecret } from './e2ee.js';

/** The link to give out, secret included when this device holds it; `null` for an encrypted
 *  meeting whose secret is not here -- a link without it would open nothing.
 *  要发出去的链接,本机有秘密时带上秘密;加密会议而本机没有秘密时为 `null` —— 不带秘密的链接什么都打不开。 */
function linkToGive(m) {
  const plain = m.guest_link || m.link;
  if (!m.e2ee) return plain;
  const s = recallSecret(m.code);
  return s ? withSecret(plain, s) : null;
}

async function copyMeetingLink(m) {
  const link = linkToGive(m);
  if (!link) return toast(t('mt_e2ee_no_key_here'), true, 8000);
  await copyText(link);
  toast(t(m.e2ee ? 'mt_e2ee_link_copied' : 'mt_link_copied'), false, m.e2ee ? 7000 : 0);
}

const st = { view: 'upcoming', q: '', list: [], cfg: null };

let cssReady = null;
function ensureCss() {
  if (!cssReady) cssReady = loadCss(`/assets/meet/meet.css?v=${encodeURIComponent(store.brand?.version || '')}`);
  return cssReady;
}

const NAV = [
  { key: 'upcoming', icon: 'videocam', hash: '#/meet' },
  { key: 'mine', icon: 'person', hash: '#/meet/mine' },
  { key: 'over', icon: 'clock', hash: '#/meet/over' },
];

export async function renderMeet(seg) {
  await ensureCss();
  if (!qs('#app > .shell.mt-page')) {
    show(frame());
    bindFrame();
  } else {
    syncSidebar();
  }
  st.view = ['mine', 'over'].includes(seg[0]) ? seg[0] : 'upcoming';
  setTitle(t('mt_title'));
  qsa('.mt-nav-item').forEach((a) => a.classList.toggle('active', a.dataset.key === st.view));
  await load();
  recoverRecording();
}

/** A recording whose tab went away before it could finish: what it had sent is still up there,
 *  and this is the page its host comes back to.
 *  一份还没收尾、标签页就没了的录制:它已经送上去的部分还在那里,而这一页正是它的主持人会回来的地方。 */
async function recoverRecording() {
  let pending = null;
  try { pending = localStorage.getItem('cf_meet_rec_pending'); } catch { /* private mode / 隐私模式 */ }
  if (!pending || !store.me?.drive_enabled) return;
  try {
    const mod = await import(`./record.js?v=${encodeURIComponent(store.brand?.version || '')}`);
    const res = await mod.recoverPending();
    if (res?.node) toast(t('mt_rec_recovered', t('mt_rec_folder')), false, 8000);
  } catch { /* next visit / 下次再说 */ }
}

function frame() {
  return `
  <div class="shell mt-page">
    ${topbarHtml({ page: 'meet', searchId: 'mt-search', searchInputId: 'mt-search-input', searchPh: t('mt_search_ph'), searchValue: st.q })}
    <div class="mt-body">
      <nav class="mt-nav">
        <wa-button class="compose-btn mt-new" id="mt-new">${icon('plus', 20)}<span>${esc(t('mt_new'))}</span></wa-button>
        ${NAV.map((n) => `<a class="mt-nav-item" data-key="${n.key}" href="${n.hash}">${icon(n.icon, 20)}<span class="lbl">${esc(t('mt_nav_' + n.key))}</span></a>`).join('')}
      </nav>
      <main class="mt-list" id="mt-list"><div class="loading">${esc(t('loading'))}</div></main>
    </div>
  </div>`;
}

function bindFrame() {
  bindTopbar();
  qs('#mt-new')?.addEventListener('click', () => openEditor(null));
  qs('#mt-search')?.addEventListener('submit', (e) => { e.preventDefault(); });
  qs('#mt-search-input')?.addEventListener('input', (e) => { st.q = e.target.value.trim(); draw(); });
  qs('#mt-list').addEventListener('click', onListClick);
  qs('#mt-list').addEventListener('submit', (e) => {
    if (e.target.id !== 'mt-joinform') return;
    e.preventDefault();
    const raw = String(qs('#mt-joincode').value || '').trim();
    // People paste the whole link as often as the code. / 人们粘贴整条链接和粘贴短码一样常见。
    const m = /#\/meet\/([^\s?]+)(\?[^\s]*)?/.exec(raw);
    const code = (m ? m[1] : raw).toLowerCase();
    if (code) navigate(`#/meet/${code}${m?.[2] || ''}`);
  });
}

async function load() {
  try {
    const [list, cfg] = await Promise.all([api('GET', '/api/meet'), st.cfg ? null : api('GET', '/api/meet/config').catch(() => null)]);
    st.list = list.meetings || [];
    if (cfg) st.cfg = cfg;
  } catch (e) {
    qs('#mt-list').innerHTML = `<div class="mt-empty">${esc(e.message)}</div>`;
    return;
  }
  draw();
}

function when(m) {
  const at = m.starts_at || m.created_at;
  const d = new Date(at);
  const loc = lang();
  const day = d.toLocaleDateString(loc, { month: 'short', day: 'numeric', weekday: 'short' });
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

function draw() {
  const main = qs('#mt-list');
  if (!main) return;
  const q = st.q.toLowerCase();
  let list = st.list.filter((m) => !q || (m.title || '').toLowerCase().includes(q) || m.code.includes(q));
  if (st.view === 'upcoming') list = list.filter((m) => !m.ended_at);
  else if (st.view === 'mine') list = list.filter((m) => m.mine && !m.ended_at);
  else list = list.filter((m) => !!m.ended_at);
  // In progress first. Then the ones with a time, soonest first -- that is a calendar. Then the
  // ones without, newest first -- that is a list of things just made.
  // 进行中的在前。其次是定了时间的,最近的在前 —— 那是日程。再次是没定时间的,最新的在前 —— 那是刚建的东西。
  const rank = (m) => (m.in_progress ? 0 : m.starts_at ? 1 : 2);
  list.sort((a, b) => (st.view === 'over'
    ? (b.ended_at || 0) - (a.ended_at || 0)
    : rank(a) - rank(b) || (a.starts_at ? a.starts_at - b.starts_at : b.created_at - a.created_at)));

  const head = `
    <div class="mt-listhead">
      <h2>${esc(t('mt_nav_' + st.view))}</h2><span class="sp"></span>
      <form class="mt-joinbox" id="mt-joinform">
        <wa-input id="mt-joincode" size="small" placeholder="${esc(t('mt_code_ph'))}" autocomplete="off"></wa-input>
        <wa-button type="submit" size="small" appearance="outlined">${esc(t('mt_join'))}</wa-button>
      </form>
    </div>`;
  if (!list.length) {
    main.innerHTML = `${head}<div class="mt-empty">${icon('videocam', 48)}<div class="mt-empty-t">${esc(t(st.view === 'over' ? 'mt_empty_over' : 'mt_empty'))}</div>
      ${st.view === 'over' ? '' : `<wa-button variant="brand" data-do="new">${icon('plus', 18)} ${esc(t('mt_new'))}</wa-button>`}</div>`;
    return;
  }
  main.innerHTML = `${head}<div class="mt-cards">${list.map(card).join('')}</div>`;
}

function card(m) {
  const over = !!m.ended_at;
  const guests = { off: '', lobby: t('mt_guests_lobby'), open: t('mt_guests_open') }[m.guest_mode] || '';
  return `
  <div class="mt-card ${over ? 'over' : ''}" data-id="${esc(m.id)}">
    <div class="mt-card-t">${m.in_progress ? '<span class="mt-live-dot"></span>' : ''}<span class="nm">${esc(m.title || t('mt_untitled'))}</span></div>
    <div class="mt-card-m">
      <span>${icon('clock', 14)} ${esc(m.in_progress ? t('mt_in_progress') : over ? t('mt_ended_at', when({ starts_at: m.ended_at })) : m.starts_at ? when(m) : t('mt_anytime'))}</span>
      <span class="mt-code">${esc(m.code)}</span>
      <span>${icon(m.video ? 'videocam' : 'mic', 14)} ${esc(m.video ? `${m.resolution}p` : t('mt_audio_only'))}</span>
      <span>${icon('people', 14)} ${esc(String(m.max_people))}</span>
      ${guests ? `<span>${icon('link', 14)} ${esc(guests)}</span>` : ''}
      ${m.kind === 'live' ? `<span>${icon('globe', 14)} ${esc(t('mt_kind_live'))}</span>` : ''}
      ${m.e2ee ? `<span title="${esc(t('mt_e2ee_on'))}">${icon('shield', 14)} ${esc(t('mt_e2ee_short'))}</span>` : ''}
    </div>
    <div class="mt-card-a">
      ${over ? '' : `<wa-button size="small" variant="brand" data-do="join">${esc(t(m.in_progress ? 'mt_join' : m.mine ? 'mt_start' : 'mt_join'))}</wa-button>
      <wa-button class="icon sm" appearance="plain" data-do="copy" title="${esc(t('mt_copy_link'))}">${icon('link', 18)}</wa-button>`}
      <span class="sp"></span>
      ${m.mine && !over ? `<wa-button class="icon sm" appearance="plain" data-do="invite" title="${esc(t('mt_invite'))}">${icon('mail', 18)}</wa-button>
        <wa-button class="icon sm" appearance="plain" data-do="edit" title="${esc(t('mt_edit'))}">${icon('pencil', 18)}</wa-button>
        ${m.in_progress ? `<wa-button class="icon sm" appearance="plain" data-do="end" title="${esc(t('mt_end'))}">${icon('stop', 18)}</wa-button>` : ''}` : ''}
      ${m.mine ? `<wa-button class="icon sm" appearance="plain" data-do="delete" title="${esc(t('delete'))}">${icon('trash', 18)}</wa-button>` : ''}
    </div>
  </div>`;
}

async function onListClick(e) {
  const b = e.target.closest?.('[data-do]');
  if (!b) return;
  const what = b.dataset.do;
  if (what === 'new') return openEditor(null);
  const m = st.list.find((x) => x.id === b.closest('.mt-card')?.dataset.id);
  if (!m) return;
  if (what === 'join') return navigate(`#/meet/${m.code}`);
  // One button, one link. While the meeting lets guests in that is the guest link: it lets a
  // colleague in as themselves just the same, and the plain one would send anybody else to a
  // sign-in page. / 一个按钮,一条链接。会议允许访客时就是访客链接:同事点它照样以本人身份进来,
  // 而普通链接会把其他所有人送到登录页。
  if (what === 'copy') return copyMeetingLink(m);
  if (what === 'edit') return openEditor(m);
  if (what === 'invite') return openInvite(m);
  try {
    if (what === 'end') {
      if (!(await confirmDialog(t('mt_end_confirm'), t('mt_end')))) return;
      await api('POST', `/api/meet/${m.id}/end`);
    } else if (what === 'delete') {
      if (!(await confirmDialog(t('mt_delete_confirm', m.title || m.code), t('delete')))) return;
      await api('DELETE', `/api/meet/${m.id}`);
    }
    await load();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Asking people ----------
// ---------- 请人 ----------

async function openInvite(m) {
  let detail;
  try { detail = (await api('GET', `/api/meet/${m.id}`)).meeting; } catch (e) { return toast(e.message, true); }
  const dlg = showModal(`
    <h3 style="margin:0 0 14px">${esc(t('mt_invite_title'))} · ${esc(m.title || t('mt_untitled'))}</h3>
    <div class="mt-form">
      <label>${esc(t('mt_invite_emails'))}</label>
      <wa-textarea id="mi-emails" rows="3" resize="none" placeholder="${esc(t('mt_invite_emails_ph'))}"></wa-textarea>
      <label>${esc(t('mt_invite_role'))}</label>
      <wa-select id="mi-role" value="speaker">
        <wa-option value="speaker" selected>${esc(t('mt_role_speaker'))}</wa-option>
        <wa-option value="cohost">${esc(t('mt_role_cohost'))}</wa-option>
      </wa-select>
      <label>${esc(t('mt_invite_note'))}</label>
      <wa-textarea id="mi-note" rows="2" resize="none" maxlength="2000"></wa-textarea>
      ${detail.guest_mode === 'off' ? `<div class="hint dim">${esc(t('mt_invite_guest_hint'))}</div>` : ''}
      ${detail.e2ee ? `<div class="hint mt-e2ee-hint">${icon('shield', 14)} ${esc(t('mt_invite_e2ee_hint'))}
        <wa-button size="small" appearance="outlined" id="mi-copy-full">${icon('link', 16)} ${esc(t('mt_e2ee_copy_link'))}</wa-button></div>` : ''}
    </div>
    <div class="mt-invited" id="mi-list"></div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button appearance="plain" id="mi-cancel">${esc(t('close'))}</wa-button>
      <wa-button variant="brand" id="mi-send">${icon('send', 18)} ${esc(t('mt_invite_send'))}</wa-button>
    </div>`);
  dlg.style.setProperty('--width', 'min(600px, 94vw)');
  const $ = (id) => dlg.querySelector(id);
  const drawList = () => {
    const list = detail.invitees || [];
    $('#mi-list').innerHTML = list.length ? `<div class="mt-sec">${esc(t('mt_invited_list'))} · ${list.length}</div>` + list.map((p) => `
      <div class="mt-person"><span class="nm">${esc(p.email)}${p.role === 'cohost' ? ` <span class="mt-tag">${esc(t('mt_role_cohost'))}</span>` : ''}</span>
        <wa-button class="icon sm" appearance="plain" data-rm="${esc(p.email)}" title="${esc(t('mt_remove'))}">${icon('close', 16)}</wa-button></div>`).join('') : '';
  };
  drawList();
  $('#mi-list').addEventListener('click', async (e) => {
    const email = e.target.closest?.('[data-rm]')?.dataset.rm;
    if (!email) return;
    try {
      await api('DELETE', `/api/meet/${m.id}/invitees/${encodeURIComponent(email)}`);
      detail.invitees = detail.invitees.filter((p) => p.email !== email);
      drawList();
    } catch (err) { toast(err.message, true); }
  });
  $('#mi-cancel').addEventListener('click', closeModal);
  $('#mi-copy-full')?.addEventListener('click', () => copyMeetingLink(detail));
  $('#mi-send').addEventListener('click', async () => {
    const emails = String($('#mi-emails').value || '').trim();
    if (!emails) return toast(t('e_no_recipients'), true);
    const btn = $('#mi-send');
    btn.loading = true;
    try {
      const res = await api('POST', `/api/meet/${m.id}/invite`, { emails, role: $('#mi-role').value, note: String($('#mi-note').value || '') });
      // Said plainly: a link that would have refused them was not sent. / 明说:一条注定会拒绝他们的链接,没有寄出去。
      if (res.guests_off) toast(t('mt_invite_guests_off', res.external.join(', ')), true, 9000);
      if (res.sent) toast(t('mt_invite_sent', res.internal.length + (res.guests_off ? 0 : res.external.length)));
      detail = (await api('GET', `/api/meet/${m.id}`)).meeting;
      $('#mi-emails').value = '';
      drawList();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.loading = false;
    }
  });
}

// ---------- The dialog ----------
// ---------- 对话框 ----------

/** A datetime-local value in the browser's own zone, which is the zone the person is thinking in.
 *  浏览器本地时区下的 datetime-local 值 —— 那正是此人脑子里想的那个时区。 */
function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openEditor(m) {
  const c = st.cfg || { max_group: 32, max_speakers: 8, max_resolution: 1080, live: false, e2ee: false };
  const isNew = !m;
  const v = m || { title: '', kind: 'group', starts_at: null, duration_min: 60, video: true, resolution: Math.min(720, c.max_resolution), max_people: c.max_group, guest_mode: 'off' };
  const opt = (val, label, cur) => `<wa-option value="${esc(String(val))}" ${String(cur) === String(val) ? 'selected' : ''}>${esc(label)}</wa-option>`;
  const resOpts = [480, 720, 1080].filter((r) => r <= c.max_resolution);
  const dlg = showModal(`
    <h3 style="margin:0 0 14px">${esc(t(isNew ? 'mt_new_title' : 'mt_edit_title'))}</h3>
    <div class="mt-form" id="mt-form">
      <label>${esc(t('mt_f_title'))}</label>
      <wa-input id="mf-title" maxlength="120" value="${esc(v.title || '')}" placeholder="${esc(t('mt_f_title_ph'))}"></wa-input>

      <label>${esc(t('mt_f_when'))}</label>
      <div class="mt-frow">
        <wa-select id="mf-when" value="${v.starts_at ? 'later' : 'now'}" style="width:160px">
          ${opt('now', t('mt_when_now'), v.starts_at ? 'later' : 'now')}${opt('later', t('mt_when_later'), v.starts_at ? 'later' : 'now')}
        </wa-select>
        <input type="datetime-local" id="mf-at" class="mt-dt" value="${esc(toLocalInput(v.starts_at || Date.now() + 3600_000))}" ${v.starts_at ? '' : 'hidden'}>
      </div>

      ${isNew && c.live ? `<label>${esc(t('mt_f_kind'))}</label>
      <wa-select id="mf-kind" value="${esc(v.kind)}">${opt('group', t('mt_kind_group'), v.kind)}${opt('live', t('mt_kind_live'), v.kind)}</wa-select>
      <div class="hint dim" id="mf-kind-hint"></div>` : ''}

      <label>${esc(t('mt_f_video'))}</label>
      <div class="mt-frow"><wa-switch id="mf-video" ${v.video ? 'checked' : ''}></wa-switch><span class="dim" id="mf-video-hint"></span></div>

      <label data-v>${esc(t('mt_f_resolution'))}</label>
      <wa-select id="mf-res" data-v value="${esc(String(v.resolution))}">${resOpts.map((r) => opt(r, `${r}p`, v.resolution)).join('')}</wa-select>
      <div class="hint dim" data-v>${esc(t('mt_f_resolution_hint'))}</div>

      <label>${esc(t('mt_f_max'))}</label>
      <wa-input id="mf-max" type="number" min="2" max="${c.max_group}" value="${esc(String(v.max_people))}" style="width:120px"></wa-input>

      <label>${esc(t('mt_f_guests'))}</label>
      <wa-select id="mf-guests" value="${esc(v.guest_mode)}">
        ${opt('off', t('mt_guests_off'), v.guest_mode)}${opt('lobby', t('mt_guests_lobby'), v.guest_mode)}${opt('open', t('mt_guests_open'), v.guest_mode)}
      </wa-select>
      <div class="hint dim">${esc(t('mt_f_guests_hint'))}</div>

      <label>${esc(t('mt_f_persistent'))}</label>
      <div class="mt-frow"><wa-switch id="mf-persistent" ${v.persistent ? 'checked' : ''}></wa-switch><span class="dim">${esc(t('mt_f_persistent_hint'))}</span></div>

      <label data-l>${esc(t('mt_f_audience'))}</label>
      <wa-select id="mf-audience" data-l value="${esc(v.audience_access || 'link')}">
        ${opt('link', t('mt_audience_link'), v.audience_access || 'link')}${opt('signin', t('mt_audience_signin'), v.audience_access || 'link')}
      </wa-select>
      <label data-l>${esc(t('mt_f_aud_chat'))}</label>
      <div class="mt-frow" data-l><wa-switch id="mf-aud-chat" ${v.audience_chat === false ? '' : 'checked'}></wa-switch><span class="dim">${esc(t('mt_f_aud_chat_hint'))}</span></div>
      <label data-l>${esc(t('mt_f_stream_rec'))}</label>
      <div class="mt-frow" data-l><wa-switch id="mf-stream-rec" ${v.record_mode === 'stream' ? 'checked' : ''}></wa-switch><span class="dim">${esc(t('mt_f_stream_rec_hint'))}</span></div>

      ${c.e2ee ? `<label data-g>${esc(t('mt_f_e2ee'))}</label>
      <div class="mt-frow" data-g><wa-switch id="mf-e2ee" ${v.e2ee ? 'checked' : ''}></wa-switch><span class="dim">${esc(t('mt_f_e2ee_hint'))}</span></div>` : ''}

      <label data-g>${esc(t('mt_f_record'))}</label>
      <div class="mt-frow" data-g><wa-switch id="mf-record" ${v.record_mode === 'local' ? 'checked' : ''}></wa-switch><span class="dim">${esc(t(c.minutes ? 'mt_f_record_hint_ai' : 'mt_f_record_hint'))}</span></div>
    </div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button appearance="plain" id="mf-cancel">${esc(t('cancel'))}</wa-button>
      <wa-button variant="brand" id="mf-ok">${esc(t(isNew ? (v.starts_at ? 'mt_create' : 'mt_create_join') : 'save'))}</wa-button>
    </div>`);

  // The dialog is as wide as the form needs, not as wide as a confirmation is. / 对话框按表单所需的宽度来,而不是按一句确认的宽度。
  dlg.style.setProperty('--width', 'min(600px, 94vw)');
  const $ = (id) => dlg.querySelector(id);
  const sync = () => {
    const later = $('#mf-when').value === 'later';
    $('#mf-at').hidden = !later;
    const video = $('#mf-video').checked;
    dlg.querySelectorAll('[data-v]').forEach((el) => { el.style.display = video ? '' : 'none'; });
    $('#mf-video-hint').textContent = video ? '' : t('mt_audio_only_hint');
    const kind = $('#mf-kind')?.value || v.kind;
    // A small meeting is recorded by its host's browser; a broadcast is recorded elsewhere.
    // 小组会议由主持人的浏览器来录;直播会议的录制在别处。
    dlg.querySelectorAll('[data-g]').forEach((el) => { el.style.display = kind === 'group' ? '' : 'none'; });
    dlg.querySelectorAll('[data-l]').forEach((el) => { el.style.display = kind === 'live' ? '' : 'none'; });
    const cap = kind === 'live' ? c.max_speakers : c.max_group;
    const max = $('#mf-max');
    max.setAttribute('max', String(cap));
    if (Number(max.value) > cap) max.value = String(cap);
    const hint = $('#mf-kind-hint');
    if (hint) hint.textContent = kind === 'live' ? t('mt_kind_live_hint') : '';
    // Only when the words change. Leaving a field fires this, and the very next thing is usually
    // a press on this button: rewriting it mid-press takes the press away (the click never lands).
    // 只在文字真的变了时才改。离开输入框会触发这里,而紧接着的往往就是按这个按钮:
    // 在按下的过程中重写它,会把这次按下弄丢(点击根本落不到按钮上)。
    const label = t(later ? 'mt_create' : 'mt_create_join');
    if (isNew && $('#mf-ok').textContent !== label) $('#mf-ok').textContent = label;
  };
  dlg.addEventListener('change', sync);
  dlg.addEventListener('input', sync);
  customElements.whenDefined('wa-select').then(() => setTimeout(sync, 0));
  $('#mf-cancel').addEventListener('click', closeModal);
  $('#mf-ok').addEventListener('click', async () => {
    const later = $('#mf-when').value === 'later';
    const at = later ? new Date($('#mf-at').value).getTime() : null;
    if (later && !Number.isFinite(at)) return toast(t('mt_bad_time'), true);
    const body = {
      title: String($('#mf-title').value || '').trim(),
      starts_at: at,
      video: $('#mf-video').checked,
      resolution: Number($('#mf-res').value || v.resolution),

      max_people: Number($('#mf-max').value),
      guest_mode: $('#mf-guests').value || 'off',
      persistent: $('#mf-persistent').checked,
    };
    if (isNew) body.kind = $('#mf-kind')?.value || 'group';
    if ((body.kind || v.kind) === 'group') {
      body.record_mode = $('#mf-record').checked ? 'local' : 'off';
      if ($('#mf-e2ee')) body.e2ee = $('#mf-e2ee').checked;
    } else {
      body.record_mode = $('#mf-stream-rec').checked ? 'stream' : 'off';
      body.audience_access = $('#mf-audience').value || 'link';
      body.audience_chat = $('#mf-aud-chat').checked;
    }
    const ok = $('#mf-ok');
    ok.loading = true;
    try {
      const res = isNew ? await api('POST', '/api/meet', body) : await api('PATCH', `/api/meet/${m.id}`, body);
      closeModal();
      // The secret is made here, now, and kept on this device; the server has already answered
      // and will never be told it. / 秘密就在这里、此刻生成,保存在本机;服务端已经答复完毕,永远不会被告知它。
      const made = res.meeting;
      if (made.e2ee && !recallSecret(made.code)) rememberSecret(made.code, newSecret());
      if (!made.e2ee) forgetSecret(made.code);
      if (isNew && !later) return navigate(`#/meet/${made.code}`);
      if (isNew) { await copyText(linkToGive(made)); toast(t(made.e2ee ? 'mt_e2ee_created_copied' : 'mt_created_copied'), false, made.e2ee ? 9000 : 0); }
      await load();
    } catch (err) {
      ok.loading = false;
      toast(err.message, true);
    }
  });
}
