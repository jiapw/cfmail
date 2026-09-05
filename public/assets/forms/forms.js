// Forms -- the designer's side. A list of the forms this person made, and an editor for one of
// them. Texts come from i18n keys fm_*; data from /api/forms/*. The fill page a link opens is
// fill.js, and it is a different world: no account, no store.me, its own look.
// 表单 —— 设计者一侧。这个人做过的表单列表,以及其中一份的编辑器。词条 fm_*,数据走 /api/forms/*。
// 链接打开的填写页是 fill.js,那是另一个世界:没有账号、没有 store.me、有自己的观感。
import { api } from '../api.js';
import { t, lang, LANG_OPTIONS } from '../i18n.js';
import { esc, icon, qs, qsa, toast, fmtDateTime, fmtSize, confirmDialog, copyText, loadCss } from '../ui.js';
import { bindTopbar, store, navigate, show, topbarHtml, setTitle, syncSidebar } from '../app.js';

/** Question types, in the order the "add" menu offers them. Names live in fm_type_<type>.
 *  题型,按「添加」菜单的顺序。名字在 fm_type_<type>。 */
const TYPES = ['text', 'textarea', 'bool', 'single', 'multi', 'int', 'float', 'date', 'country', 'address', 'file', 'files', 'image', 'images'];
const OPT_TYPES = new Set(['single', 'multi']);
/** Questions whose answer is short enough to sit in a subject line
 *  答案短到能放进主题行的题型 */
const SUBJECT_TYPES = new Set(['text', 'int', 'float', 'date', 'single', 'country']);
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED = new Set(['name', 'email', 'sender', 'form', 'version', 'lang']);

const st = { view: 'all', q: '', forms: [] };
/** The form being edited, in the shape the editor binds to. Null on the list.
 *  正在编辑的表单,按编辑器绑定的形状。在列表页时为 null。 */
let ed = null;

/** Resolves once the stylesheet is in; awaited before the first paint (see loadCss in ui.js).
 *  样式表就位后兑现;第一次绘制之前先等它(见 ui.js 的 loadCss)。 */
function ensureCss() {
  return loadCss('/assets/forms/forms.css?v=' + encodeURIComponent(store.brand?.version || ''));
}

// ---------- Entry ----------
// ---------- 入口 ----------

export async function renderForms(seg) {
  await ensureCss();
  // The frame is built once and stands; walking around replaces only #fm-main -- the same
  // arrangement as the mail shell and the drive.
  // 框架建一次就立在那儿,走动只换 #fm-main —— 和邮件外壳、网盘同一套安排。
  if (!qs('#app > .shell.fm-page')) {
    show(frame());
    bindFrame();
  } else {
    syncSidebar();
  }
  if (seg[0] === 'new') return renderEditor(null);
  if (seg[0] === 'edit' && seg[1]) return renderEditor(seg[1]);
  // Kept answers: the list of a form's, and one of them
  // 保留的答复:某份表单的清单,以及其中一份
  if (seg[0] === 'subs' && seg[1]) return renderSubs(seg[1]);
  if (seg[0] === 'sub' && seg[1] && seg[2]) return renderSub(seg[1], seg[2]);
  st.view = ['all', 'active', 'disabled'].includes(seg[0]) ? seg[0] : 'all';
  ed = null;
  setTitle(t('fm_title'));
  syncRail();
  await loadList();
}

const NAV = [
  { key: 'all', icon: 'fileText', hash: '#/forms' },
  { key: 'active', icon: 'play', hash: '#/forms/active' },
  { key: 'disabled', icon: 'pause', hash: '#/forms/disabled' },
];

function frame() {
  return `
  <div class="shell fm-page">
    ${topbarHtml({
      page: 'forms',
      searchId: 'fm-search',
      searchInputId: 'fm-search-input',
      searchPh: t('fm_search_ph'),
      searchValue: st.q,
    })}
    <div class="fm-body">
      <nav class="fm-nav">
        <wa-button class="compose-btn fm-new" id="fm-new">${icon('plus', 20)}<span>${esc(t('fm_new'))}</span></wa-button>
        ${NAV.map((n) => `
          <a class="fm-nav-item ${st.view === n.key ? 'active' : ''}" href="${n.hash}">
            ${icon(n.icon, 20)}<span class="lbl">${esc(t('fm_' + n.key))}</span>
          </a>`).join('')}
      </nav>
      <main class="fm-main" id="fm-main"><div class="loading">${esc(t('loading'))}</div></main>
    </div>
  </div>`;
}

function syncRail() {
  qsa('.fm-nav-item').forEach((a) => {
    const key = a.getAttribute('href') === '#/forms' ? 'all' : (a.getAttribute('href') || '').split('/')[2];
    a.classList.toggle('active', !ed && key === st.view);
  });
}

function bindFrame() {
  bindTopbar();
  qs('#fm-new')?.addEventListener('click', () => navigate('#/forms/new'));
  // The search narrows the list in place; it is a filter, not a place, so the address stays.
  // 搜索就地收窄列表;它是一个筛选、不是一个地方,所以地址不变。
  const form = qs('#fm-search');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    st.q = qs('#fm-search-input').value.trim();
    if (ed) navigate('#/forms');
    else drawList();
  });
  qs('#fm-search-input')?.addEventListener('input', (e) => {
    st.q = e.target.value.trim();
    if (!ed) drawList();
  });
  qs('#fm-main').addEventListener('click', onMainClick);
  qs('#fm-main').addEventListener('input', onMainInput);
  qs('#fm-main').addEventListener('change', onMainInput);
}

// ---------- The list ----------
// ---------- 列表 ----------

async function loadList() {
  const main = qs('#fm-main');
  try {
    const r = await api('GET', '/api/forms');
    st.forms = (r.forms || []).map((f) => ({ ...f, link: linkFor(f.token) }));
    drawList();
  } catch (e) {
    if (main) main.innerHTML = `<div class="fm-empty">${icon('spam', 40)}<div>${esc(e.message)}</div></div>`;
  }
}

function drawList() {
  const main = qs('#fm-main');
  if (!main || ed) return;
  const q = st.q.toLowerCase();
  let rows = st.forms.filter((f) => st.view === 'all' || (st.view === 'active' ? !f.disabled : f.disabled));
  if (q) rows = rows.filter((f) => f.title.toLowerCase().includes(q));
  if (!st.forms.length) {
    main.innerHTML = `
      <div class="fm-empty">
        ${icon('fileText', 48)}
        <div class="fm-empty-t">${esc(t('fm_empty'))}</div>
        <div class="dim">${esc(t('fm_empty_hint'))}</div>
        <wa-button variant="brand" id="fm-empty-new">${icon('plus', 18)} ${esc(t('fm_new'))}</wa-button>
      </div>`;
    qs('#fm-empty-new')?.addEventListener('click', () => navigate('#/forms/new'));
    return;
  }
  if (!rows.length) {
    main.innerHTML = `<div class="fm-empty">${icon('search', 40)}<div>${esc(t('fm_none_match'))}</div></div>`;
    return;
  }
  main.innerHTML = `
    <div class="fm-listhead"><h2>${esc(t('fm_' + st.view))}</h2><span class="dim">${rows.length}</span></div>
    <div class="fm-card tblwrap">
      <table class="table fm-table">
        <thead><tr>
          <th>${esc(t('fm_col_title'))}</th><th>${esc(t('fm_col_status'))}</th><th>${esc(t('fm_col_version'))}</th>
          <th>${esc(t('fm_col_submissions'))}</th><th>${esc(t('fm_col_updated'))}</th><th></th>
        </tr></thead>
        <tbody>${rows.map(rowHtml).join('')}</tbody>
      </table>
    </div>`;
}

function rowHtml(f) {
  const kept = f.store === 'store' || f.store === 'both';
  const meta = [
    t('fm_kind_' + f.kind),
    t(f.audience === 'public' ? 'fm_public' : 'fm_internal'),
    f.verify_email ? t('fm_verify_email') : '',
    kept ? t(f.store === 'both' ? 'fm_store_both' : 'fm_store_store') : '',
    (f.langs || []).join(', '),
  ].filter(Boolean);
  // A kept form's count is the way into its answers; a mail-only form has nothing behind it.
  // 保留答复的表单,计数就是进入答复的门;只发邮件的表单,后面什么都没有。
  const count = kept
    ? `<a class="fm-t" href="#/forms/subs/${esc(f.id)}">${f.submissions}</a>`
    : `${f.submissions}`;
  return `
    <tr data-id="${esc(f.id)}">
      <td>
        <a class="fm-t" href="#/forms/edit/${esc(f.id)}">${esc(f.title)}</a>
        <div class="fm-sub dim">${meta.map(esc).join(' · ')}</div>
      </td>
      <td>${f.disabled
        ? `<span class="chip chip-warn">${esc(t('fm_status_off'))}</span>`
        : `<span class="chip chip-ok">${esc(t('fm_status_on'))}</span>`}</td>
      <td>v${f.version}</td>
      <td class="fm-subs-cell">${count}${f.last_submit_at ? `<span class="dim fm-subs-when">${esc(fmtDateTime(f.last_submit_at))}</span>` : ''}</td>
      <td class="dim fm-nowrap">${esc(fmtDateTime(f.updated_at))}</td>
      <td class="fm-acts">
        ${kept ? `<wa-button class="icon" appearance="plain" href="#/forms/subs/${esc(f.id)}" title="${esc(t('fm_subs'))}" aria-label="${esc(t('fm_subs'))}">${icon('inbox', 18)}</wa-button>` : ''}
        <wa-button class="icon" appearance="plain" data-act="copy" title="${esc(t('fm_copy_link'))}" aria-label="${esc(t('fm_copy_link'))}">${icon('link', 18)}</wa-button>
        <wa-button class="icon" appearance="plain" href="${esc(f.link)}" target="_blank" rel="noopener" title="${esc(t('fm_open'))}" aria-label="${esc(t('fm_open'))}">${icon('expand', 18)}</wa-button>
        <wa-button class="icon" appearance="plain" data-act="edit" title="${esc(t('fm_edit'))}" aria-label="${esc(t('fm_edit'))}">${icon('pencil', 18)}</wa-button>
        <wa-button class="icon" appearance="plain" data-act="toggle" title="${esc(t(f.disabled ? 'fm_enable' : 'fm_disable'))}" aria-label="${esc(t(f.disabled ? 'fm_enable' : 'fm_disable'))}">${icon(f.disabled ? 'play' : 'pause', 18)}</wa-button>
        <wa-button class="icon" appearance="plain" data-act="del" title="${esc(t('fm_delete'))}" aria-label="${esc(t('fm_delete'))}">${icon('trash', 18)}</wa-button>
      </td>
    </tr>`;
}

async function onMainClick(e) {
  const btn = e.target.closest?.('[data-act]');
  if (btn) {
    const id = btn.closest('tr')?.dataset.id;
    const f = st.forms.find((x) => x.id === id);
    if (!f) return;
    const act = btn.dataset.act;
    if (act === 'copy') { await copyText(f.link); toast(t('fm_link_copied')); }
    else if (act === 'edit') navigate(`#/forms/edit/${f.id}`);
    else if (act === 'toggle') {
      try {
        const r = await api('POST', `/api/forms/${f.id}/state`, { disabled: !f.disabled });
        f.disabled = r.disabled;
        toast(t(f.disabled ? 'fm_disabled_toast' : 'fm_enabled_toast'));
        drawList();
      } catch (err) { toast(err.message, true); }
    } else if (act === 'del') {
      if (!(await confirmDialog(t('fm_delete_confirm', f.title), t('fm_delete')))) return;
      try {
        await api('DELETE', `/api/forms/${f.id}`);
        st.forms = st.forms.filter((x) => x.id !== f.id);
        toast(t('fm_deleted'));
        drawList();
      } catch (err) { toast(err.message, true); }
    }
    return;
  }
  if (ed) onEditorClick(e);
}

function onMainInput(e) {
  if (ed) onEditorInput(e);
}

// ---------- The editor ----------
// ---------- 编辑器 ----------

function blank() {
  const l = lang();
  return {
    id: null, token: null, link: null, version: 0, disabled: false, submissions: 0,
    kind: 'survey', title: '', description: '', audience: 'public', verify_email: false,
    src_lang: l, langs: [l], fields: [], subject_tpl: '{form} - {sender}', recipients: '', store: 'mail',
  };
}

/** The fill page's address, on the host this browser is using -- the designer copies the link
 *  from where they stand, and this is the one host they know works.
 *  填写页的地址,按这个浏览器正在用的主机 —— 设计者从他所在之处复制链接,而这是他唯一确知能用的主机。 */
const linkFor = (token) => `${location.origin}/#/f/${token}`;

function fromServer(f) {
  return {
    id: f.id, token: f.token, link: linkFor(f.token), version: f.version, disabled: f.disabled, submissions: f.submissions,
    kind: f.kind, title: f.title, description: f.description, audience: f.audience, verify_email: !!f.verify_email,
    src_lang: f.src_lang, langs: f.langs || [f.src_lang], fields: (f.fields || []).map((q) => ({ ...q, options: q.options || [] })),
    subject_tpl: f.subject_tpl || '', recipients: (f.recipients || []).join('\n'), store: f.store || 'mail',
  };
}

async function renderEditor(id) {
  const main = qs('#fm-main');
  main.innerHTML = `<div class="loading">${esc(t('loading'))}</div>`;
  if (id) {
    try {
      const r = await api('GET', `/api/forms/${id}`);
      ed = fromServer(r.form);
    } catch (e) {
      main.innerHTML = `<div class="fm-empty">${icon('spam', 40)}<div>${esc(e.message)}</div></div>`;
      return;
    }
  } else {
    ed = blank();
  }
  setTitle(ed.id ? ed.title : t('fm_new_title'));
  syncRail();
  main.innerHTML = editorHtml();
  drawQuestions();
  qs('#fm-save')?.addEventListener('click', () => save());
  qs('#fm-retr')?.addEventListener('click', () => save({ retranslate: true }));
  qs('#fm-addq')?.addEventListener('wa-select', (e) => addQuestion(e.detail?.item?.value));
  qs('#fm-copylink')?.addEventListener('click', async () => { await copyText(ed.link); toast(t('fm_link_copied')); });
  bindRecipientAc();
  // Prevent the browser's own "leave page" on Enter inside single-line inputs
  // 单行输入里按回车不让浏览器提交任何东西
  qs('#fm-ed')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
  });
}

/**
 * Address completion for the recipients field. The token under the caret -- whatever follows the
 * last comma, semicolon or line break -- is looked up in the company directory, and the pick
 * replaces that token. Arrow keys walk the list, Enter or Tab takes the lit entry, Escape closes.
 * 收件人栏的地址补全。光标下的那一段 —— 最后一个逗号、分号或换行之后的内容 —— 拿去公司通讯录里查,
 * 选中项替换掉那一段。方向键在列表里走,回车或 Tab 取亮着的那条,Esc 关闭。
 */
function bindRecipientAc() {
  const ta = qs('#fm-rcpts');
  const box = qs('#fm-ac');
  if (!ta || !box) return;
  let items = [];
  let on = -1;
  let seq = 0;
  let timer = null;
  const close = () => { box.hidden = true; items = []; on = -1; };
  const tokenAt = () => {
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const m = /[^,;\s]*$/.exec(before);
    return { token: m ? m[0] : '', start: pos - (m ? m[0].length : 0), pos };
  };
  const draw = () => {
    if (!items.length) { close(); return; }
    box.innerHTML = items.map((p, i) => `
      <div class="fm-ac-it ${i === on ? 'on' : ''}" data-i="${i}">
        ${p.name ? `<span>${esc(p.name)}</span>` : ''}<span class="ad ${p.name ? 'dim' : ''}">${esc(p.address)}</span>
      </div>`).join('');
    box.hidden = false;
  };
  const pick = (i) => {
    const p = items[i];
    if (!p) return;
    const { start, pos } = tokenAt();
    const after = ta.value.slice(pos);
    const sep = /^\s*[,;\n]/.test(after) ? '' : ', ';
    ta.value = ta.value.slice(0, start) + p.address + sep + after;
    const caret = start + p.address.length + sep.length;
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    ta.focus();
  };
  const lookup = () => {
    const { token } = tokenAt();
    if (!token) { close(); return; }
    const my = ++seq;
    api('GET', `/api/forms/directory?q=${encodeURIComponent(token)}`).then((r) => {
      if (my !== seq) return;  // a later keystroke already asked / 后面的按键已经另问了一次
      const typed = token.toLowerCase();
      items = (r.people || []).filter((p) => p.address !== typed);
      on = items.length ? 0 : -1;
      draw();
    }).catch(() => close());
  };
  ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(lookup, 120); });
  ta.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { on = (on + 1) % items.length; draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { on = (on - 1 + items.length) % items.length; draw(); e.preventDefault(); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && on >= 0) { pick(on); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  });
  // mousedown, not click: a click lands after blur has already closed the list.
  // 用 mousedown 而不是 click:click 到达时,blur 已经把列表关掉了。
  box.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.fm-ac-it');
    if (!it) return;
    e.preventDefault();
    pick(Number(it.dataset.i));
  });
  ta.addEventListener('blur', () => setTimeout(close, 150));
}

// ---------- Kept answers ----------
// ---------- 保留的答复 ----------

const senderLine = (s) => (s.sender_name ? `${s.sender_name} <${s.sender_addr}>` : s.sender_addr);

function fmtOffset(min) {
  const sign = min >= 0 ? '+' : '-';
  const a = Math.abs(Math.round(min));
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** The answers kept for one form, newest first, a page at a time. */
/** 一份表单保留的答复,最新在前,一页一页来。 */
async function renderSubs(formId) {
  ed = null;
  syncRail();
  const main = qs('#fm-main');
  main.innerHTML = `<div class="loading">${esc(t('loading'))}</div>`;
  let d;
  try {
    d = await api('GET', `/api/forms/${encodeURIComponent(formId)}/subs`);
  } catch (e) {
    main.innerHTML = `<div class="fm-empty">${icon('spam', 40)}<div>${esc(e.message)}</div></div>`;
    return;
  }
  setTitle(t('fm_subs_of', d.title));
  let subs = d.subs || [];
  let more = !!d.more;
  const row = (s) => `
    <tr data-sid="${esc(s.id)}">
      <td class="dim">${esc(fmtDateTime(s.created_at))}</td>
      <td>${esc(senderLine(s))}</td>
      <td class="fm-subj" title="${esc(s.subject || '')}">${esc(s.subject || '')}</td>
      <td>v${s.version}</td>
      <td class="fm-acts">
        <wa-button class="icon" appearance="plain" href="#/forms/sub/${esc(formId)}/${esc(s.id)}" title="${esc(t('fm_sub_open'))}" aria-label="${esc(t('fm_sub_open'))}">${icon('expand', 18)}</wa-button>
        ${d.can_delete ? `<wa-button class="icon" appearance="plain" data-sub="del" title="${esc(t('fm_delete'))}" aria-label="${esc(t('fm_delete'))}">${icon('trash', 18)}</wa-button>` : ''}
      </td>
    </tr>`;
  const draw = () => {
    main.innerHTML = `
      <div class="fm-listhead">
        <wa-button class="icon" appearance="plain" href="#/forms" aria-label="${esc(t('back'))}">${icon('back', 20)}</wa-button>
        <h2>${esc(t('fm_subs_of', d.title))}</h2><span class="dim">${subs.length}${more ? '+' : ''}</span>
      </div>
      ${d.store === 'mail' ? `<p class="dim fm-note" style="padding:0 8px 10px">${esc(t('fm_subs_not_kept'))}</p>` : ''}
      ${subs.length ? `
      <div class="fm-card tblwrap">
        <table class="table fm-table">
          <thead><tr><th>${esc(t('fm_col_when'))}</th><th>${esc(t('fm_col_sender'))}</th><th>${esc(t('fm_subject'))}</th><th>${esc(t('fm_col_version'))}</th><th></th></tr></thead>
          <tbody>${subs.map(row).join('')}</tbody>
        </table>
      </div>
      ${more ? `<div class="fm-more"><wa-button appearance="outlined" id="fm-more">${esc(t('fm_more'))}</wa-button></div>` : ''}`
      : `<div class="fm-empty">${icon('inbox', 44)}<div>${esc(t('fm_subs_empty'))}</div></div>`}`;
    qs('#fm-more')?.addEventListener('click', async () => {
      const last = subs[subs.length - 1];
      const r = await api('GET', `/api/forms/${encodeURIComponent(formId)}/subs?before=${last.created_at}`).catch(() => null);
      if (!r) return;
      subs = subs.concat(r.subs || []);
      more = !!r.more;
      draw();
    });
    qsa('[data-sub="del"]', main).forEach((b) => b.addEventListener('click', async () => {
      const sid = b.closest('tr').dataset.sid;
      if (!(await confirmDialog(t('fm_sub_delete_confirm'), t('fm_delete')))) return;
      try {
        await api('DELETE', `/api/forms/${encodeURIComponent(formId)}/subs/${encodeURIComponent(sid)}`);
        subs = subs.filter((s) => s.id !== sid);
        toast(t('fm_sub_deleted'));
        draw();
      } catch (e) {
        toast(e.message, true);
      }
    }));
  };
  draw();
}

/** One kept answer, laid out like the mail it was: the questions as they stood in that version,
 *  the answers, the files to download and the pictures to look at.
 *  一份保留的答复,按它当初那封邮件的样子排开:那一版的题目、答案、可下载的文件、可看的图片。 */
async function renderSub(formId, subId) {
  ed = null;
  syncRail();
  const main = qs('#fm-main');
  main.innerHTML = `<div class="loading">${esc(t('loading'))}</div>`;
  let d;
  try {
    d = await api('GET', `/api/forms/${encodeURIComponent(formId)}/subs/${encodeURIComponent(subId)}`);
  } catch (e) {
    main.innerHTML = `<div class="fm-empty">${icon('spam', 40)}<div>${esc(e.message)}</div></div>`;
    return;
  }
  const s = d.sub;
  setTitle(t('fm_sub_title', s.sender_name || s.sender_addr));
  const fileUrl = (n) => `/api/forms/${encodeURIComponent(formId)}/subs/${encodeURIComponent(subId)}/files/${n}`;
  const IMG = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/;
  const val = (a) => {
    if (!a || a.kind === 'empty') return '<span class="dim">—</span>';
    switch (a.kind) {
      case 'text': return esc(a.text).replace(/\n/g, '<br>');
      case 'num': return esc(a.text);
      case 'bool': return a.on ? `&#10003; ${esc(t('fm_yes'))}` : `&#10007; ${esc(t('fm_no'))}`;
      case 'opts': return a.labels.length > 1 ? `<ul class="fm-ul">${a.labels.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : esc(a.labels[0] || '');
      case 'lines': return a.lines.map(esc).join('<br>');
      case 'files': return `<div class="fm-sfiles">${a.files.map((f) => IMG.test(f.mime)
        ? `<a class="fm-sfile img" href="${fileUrl(f.n)}" target="_blank" rel="noopener" title="${esc(f.name)}"><img src="${fileUrl(f.n)}" alt="${esc(f.name)}"><span class="fm-thumb-sz">${esc(fmtSize(f.size))}</span></a>`
        : `<a class="fm-sfile" href="${fileUrl(f.n)}" download="${esc(f.name)}">${icon('attach', 16)}<span class="nm">${esc(f.name)}</span><span class="dim">${esc(fmtSize(f.size))}</span></a>`).join('')}</div>`;
    }
    return '';
  };
  const tzs = [s.tz, Number.isFinite(s.tz_offset) ? fmtOffset(s.tz_offset) : ''].filter(Boolean).join(', ');
  const meta = [
    [t('fm_m_by'), senderLine(s)],
    [t('fm_m_local'), s.local_time ? `${s.local_time}${tzs ? ` (${tzs})` : ''}` : '—'],
    [t('fm_m_received'), fmtDateTime(s.created_at)],
    [t('fm_m_ip'), s.ip || '—'],
    [t('fm_m_loc'), s.geo || '—'],
    [t('fm_m_version'), String(s.version)],
    [t('fm_m_lang'), s.lang || '—'],
  ];
  main.innerHTML = `
    <div class="fm-listhead">
      <wa-button class="icon" appearance="plain" href="#/forms/subs/${esc(formId)}" aria-label="${esc(t('back'))}">${icon('back', 20)}</wa-button>
      <h2>${esc(d.title)}</h2><span class="chip">v${s.version}</span>
      <span class="sp"></span>
      ${d.can_delete ? `<wa-button appearance="outlined" id="fm-sub-del">${icon('trash', 16)} ${esc(t('fm_delete'))}</wa-button>` : ''}
    </div>
    <section class="card fm-subview">
      <div class="fm-submeta">${meta.map(([k, v]) => `<div><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</div>
      <table class="fm-qa">${(d.fields || []).map((f) => `<tr><td class="q">${esc(f.label)}</td><td class="a">${val(s.answers?.[f.key])}</td></tr>`).join('')}</table>
    </section>`;
  qs('#fm-sub-del')?.addEventListener('click', async () => {
    if (!(await confirmDialog(t('fm_sub_delete_confirm'), t('fm_delete')))) return;
    try {
      await api('DELETE', `/api/forms/${encodeURIComponent(formId)}/subs/${encodeURIComponent(subId)}`);
      toast(t('fm_sub_deleted'));
      navigate(`#/forms/subs/${formId}`);
    } catch (e) {
      toast(e.message, true);
    }
  });
}

function editorHtml() {
  const langOpts = LANG_OPTIONS.map(([c, n]) => `<option value="${c}" ${c === ed.src_lang ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const langChecks = LANG_OPTIONS.map(([c, n]) => `
    <label class="fm-check fm-langcb">
      <input type="checkbox" class="fm-lang-cb" value="${c}" ${ed.langs.includes(c) ? 'checked' : ''} ${c === ed.src_lang ? 'disabled' : ''}>
      <span>${esc(n)}</span>
    </label>`).join('');
  return `
  <div class="fm-ed" id="fm-ed">
    <div class="fm-edhead">
      <wa-button class="icon" appearance="plain" href="#/forms" aria-label="${esc(t('back'))}">${icon('back', 20)}</wa-button>
      <h2>${esc(ed.id ? t('fm_edit_title') : t('fm_new_title'))}</h2>
      <span class="fm-edmeta" id="fm-edmeta">${edMetaHtml()}</span>
      <span class="sp"></span>
      ${ed.id ? `<wa-button appearance="outlined" id="fm-copylink">${icon('link', 18)} ${esc(t('fm_copy_link'))}</wa-button>` : ''}
      ${ed.id ? `<wa-button appearance="outlined" href="${esc(ed.link)}" target="_blank" rel="noopener">${icon('expand', 18)} ${esc(t('fm_open'))}</wa-button>` : ''}
      <wa-button variant="brand" id="fm-save">${icon('check', 18)} ${esc(t('fm_save'))}</wa-button>
    </div>
    <div class="fm-edbody">
      <section class="card">
        <h3>${esc(t('fm_basics'))}</h3>
        <div class="fm-grid2">
          <label class="fm-fld">${esc(t('fm_kind'))}
            <span class="fm-selw"><select id="fm-kind" class="fm-select">
              <option value="survey" ${ed.kind === 'survey' ? 'selected' : ''}>${esc(t('fm_kind_survey'))}</option>
              <option value="feedback" ${ed.kind === 'feedback' ? 'selected' : ''}>${esc(t('fm_kind_feedback'))}</option>
            </select></span>
          </label>
          <label class="fm-fld">${esc(t('fm_form_title'))}<input id="fm-title" maxlength="200" value="${esc(ed.title)}"></label>
        </div>
        <label class="fm-fld">${esc(t('fm_description'))}<textarea id="fm-desc" rows="3" maxlength="4000">${esc(ed.description)}</textarea></label>
      </section>

      <section class="card">
        <h3>${esc(t('fm_audience'))}</h3>
        <div class="fm-radios">
          <label class="fm-radio"><input type="radio" name="fm-aud" value="internal" ${ed.audience === 'internal' ? 'checked' : ''}>
            <span><b>${esc(t('fm_internal'))}</b><small>${esc(t('fm_audience_internal_hint'))}</small></span></label>
          <label class="fm-radio"><input type="radio" name="fm-aud" value="public" ${ed.audience === 'public' ? 'checked' : ''}>
            <span><b>${esc(t('fm_public'))}</b><small>${esc(t('fm_audience_public_hint'))}</small></span></label>
          <label class="fm-check fm-verify-cb ${ed.audience === 'internal' ? 'off' : ''}" id="fm-verify-w">
            <input type="checkbox" id="fm-verify" ${ed.verify_email ? 'checked' : ''}>
            <span>${esc(t('fm_verify_email'))}<small class="dim">${esc(t('fm_verify_email_hint'))}</small></span>
          </label>
        </div>
        <label class="fm-fld fm-ac-host">${esc(t('fm_recipients'))}
          <textarea id="fm-rcpts" rows="2" autocomplete="off" spellcheck="false" placeholder="${esc(t('fm_recipients_ph'))}">${esc(ed.recipients)}</textarea>
          <div class="fm-ac" id="fm-ac" hidden></div>
          <small class="dim">${esc(t('fm_recipients_hint'))}</small>
        </label>
      </section>

      <section class="card">
        <h3>${esc(t('fm_store'))}</h3>
        <div class="fm-radios fm-radios-3">
          ${[['mail', 'fm_store_mail', 'fm_store_mail_hint'], ['store', 'fm_store_store', 'fm_store_store_hint'], ['both', 'fm_store_both', 'fm_store_both_hint']].map(([v, l, h]) => `
          <label class="fm-radio"><input type="radio" name="fm-store" value="${v}" ${ed.store === v ? 'checked' : ''}>
            <span><b>${esc(t(l))}</b><small>${esc(t(h))}</small></span></label>`).join('')}
        </div>
        <p class="dim fm-note">${esc(t('fm_store_note'))}</p>
      </section>

      <section class="card">
        <h3>${esc(t('fm_languages'))}</h3>
        <label class="fm-fld fm-fld-short">${esc(t('fm_src_lang'))}<span class="fm-selw"><select id="fm-src" class="fm-select">${langOpts}</select></span></label>
        <div class="fm-fld"><span>${esc(t('fm_langs_offered'))}</span><div class="fm-langs" id="fm-langs">${langChecks}</div></div>
        <p class="dim fm-note">${esc(t('fm_lang_note'))}</p>
        ${ed.id ? `<wa-button size="small" appearance="outlined" id="fm-retr">${icon('refresh', 16)} ${esc(t('fm_retranslate'))}</wa-button>` : ''}
      </section>

      <section class="card">
        <h3>${esc(t('fm_subject'))}</h3>
        <label class="fm-fld"><input id="fm-subject" maxlength="300" value="${esc(ed.subject_tpl)}" placeholder="{form} - {sender}"></label>
        <div class="fm-vars" id="fm-vars">${varsHtml()}</div>
        <p class="dim fm-note">${esc(t('fm_subject_hint'))}</p>
      </section>

      <section class="card">
        <div class="fm-qshead">
          <h3>${esc(t('fm_questions'))}</h3>
          ${addMenuHtml('fm-addq')}
        </div>
        <div id="fm-qs"></div>
        <div id="fm-qs-foot" class="fm-qs-foot"></div>
      </section>
    </div>
  </div>`;
}

function edMetaHtml() {
  if (!ed.id) return '';
  return `<span class="chip">${esc(t('fm_version', ed.version))}</span>` +
    (ed.disabled ? `<span class="chip chip-warn">${esc(t('fm_status_off'))}</span>` : '');
}

/** The placeholders the subject may use: the fixed four, and every short-answer question.
 *  主题可用的占位符:固定四个,加上每一道短答题。 */
function varsHtml() {
  const vars = [['sender', t('fm_var_sender')], ['email', t('fm_var_email')], ['form', t('fm_var_form')], ['version', t('fm_var_version')]];
  for (const q of ed.fields) if (SUBJECT_TYPES.has(q.type) && KEY_RE.test(q.key)) vars.push([q.key, q.label || q.key]);
  return vars.map(([k, n]) => `<button type="button" class="fm-var" data-var="${esc(k)}" title="${esc(n)}">{${esc(k)}}</button>`).join('');
}

/** The "add question" menu. Built once for the card's head and again under the list, so that a
 *  long form does not send the designer back to the top for every question.
 *  「添加题目」菜单。卡片头部一份、列表底下再一份,免得长表单每加一题都要滚回顶部。 */
function addMenuHtml(id) {
  return `
    <wa-dropdown id="${id}" placement="bottom-end">
      <wa-button slot="trigger" appearance="outlined">${icon('plus', 18)} ${esc(t('fm_add_question'))}</wa-button>
      ${TYPES.map((ty) => `<wa-dropdown-item value="${ty}">${esc(t('fm_type_' + ty))}</wa-dropdown-item>`).join('')}
    </wa-dropdown>`;
}

function drawQuestions() {
  const box = qs('#fm-qs');
  if (!box) return;
  if (!ed.fields.length) {
    box.innerHTML = `<div class="fm-noq dim">${esc(t('fm_no_questions'))}</div>`;
  } else {
    box.innerHTML = ed.fields.map(questionHtml).join('');
  }
  // The second menu exists only under a list that has something in it: with no questions the
  // head's menu is right there, and two identical buttons a few pixels apart read as a mistake.
  // 第二个菜单只在列表非空时出现:没有题目时头部那个就在眼前,两个一样的按钮挨着放像个错误。
  const foot = qs('#fm-qs-foot');
  if (foot) {
    foot.innerHTML = ed.fields.length ? addMenuHtml('fm-addq2') : '';
    qs('#fm-addq2')?.addEventListener('wa-select', (e) => addQuestion(e.detail?.item?.value));
  }
  const vars = qs('#fm-vars');
  if (vars) vars.innerHTML = varsHtml();
}

function questionHtml(q, i) {
  return `
  <div class="fm-q" data-i="${i}">
    <div class="fm-qhead">
      <span class="fm-qn">${i + 1}</span>
      <span class="fm-selw inline"><select class="fm-select fm-qtype" data-f="type">
        ${TYPES.map((ty) => `<option value="${ty}" ${ty === q.type ? 'selected' : ''}>${esc(t('fm_type_' + ty))}</option>`).join('')}
      </select></span>
      <span class="sp"></span>
      <wa-button class="icon" appearance="plain" data-q="up" title="${esc(t('fm_q_up'))}" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up', 18)}</wa-button>
      <wa-button class="icon rot180" appearance="plain" data-q="down" title="${esc(t('fm_q_down'))}" ${i === ed.fields.length - 1 ? 'disabled' : ''}>${icon('arrow-up', 18)}</wa-button>
      <wa-button class="icon" appearance="plain" data-q="del" title="${esc(t('fm_q_remove'))}">${icon('trash', 18)}</wa-button>
    </div>
    <div class="fm-grid2">
      <label class="fm-fld">${esc(t('fm_q_label'))}<input data-f="label" maxlength="200" value="${esc(q.label)}"></label>
      <label class="fm-fld">${esc(t('fm_q_key'))}<input data-f="key" class="mono" maxlength="32" value="${esc(q.key)}" spellcheck="false"><small class="dim">${esc(t('fm_q_key_hint'))}</small></label>
    </div>
    <label class="fm-fld">${esc(t('fm_q_help'))}<textarea data-f="help" rows="2" maxlength="1000">${esc(q.help || '')}</textarea></label>
    <label class="fm-check"><input type="checkbox" data-f="required" ${q.required ? 'checked' : ''}><span>${esc(t('fm_q_required'))}</span></label>
    ${OPT_TYPES.has(q.type) ? optionsHtml(q) : ''}
  </div>`;
}

function optionsHtml(q) {
  return `
  <div class="fm-opts-ed">
    <div class="fm-opts-t">${esc(t('fm_q_options'))}</div>
    ${q.options.map((o, j) => `
      <div class="fm-opt-row" data-j="${j}">
        <input data-o="value" class="mono" maxlength="40" value="${esc(o.value)}" placeholder="${esc(t('fm_q_opt_value'))}" spellcheck="false">
        <input data-o="label" maxlength="200" value="${esc(o.label)}" placeholder="${esc(t('fm_q_opt_label'))}">
        <input data-o="help" maxlength="500" value="${esc(o.help || '')}" placeholder="${esc(t('fm_q_opt_help'))}">
        <wa-button class="icon" appearance="plain" data-q="odel" title="${esc(t('remove'))}">${icon('close', 16)}</wa-button>
      </div>`).join('')}
    <wa-button size="small" appearance="outlined" data-q="oadd">${icon('plus', 16)} ${esc(t('fm_q_add_option'))}</wa-button>
  </div>`;
}

function nextKey() {
  let n = ed.fields.length + 1;
  while (ed.fields.some((q) => q.key === `q${n}`)) n++;
  return `q${n}`;
}

function nextOpt(q) {
  let n = q.options.length + 1;
  while (q.options.some((o) => o.value === `o${n}`)) n++;
  return `o${n}`;
}

function addQuestion(type) {
  if (!TYPES.includes(type)) return;
  const q = { key: nextKey(), type, label: '', help: '', required: false, options: [] };
  if (OPT_TYPES.has(type)) q.options = [{ value: 'o1', label: '', help: '' }, { value: 'o2', label: '', help: '' }];
  ed.fields.push(q);
  drawQuestions();
  qs(`.fm-q[data-i="${ed.fields.length - 1}"] input[data-f="label"]`)?.focus();
}

function onEditorClick(e) {
  const v = e.target.closest?.('.fm-var');
  if (v) { insertVar(v.dataset.var); return; }
  const b = e.target.closest?.('[data-q]');
  if (!b) return;
  const card = b.closest('.fm-q');
  const i = Number(card?.dataset.i);
  const q = ed.fields[i];
  if (!q) return;
  const act = b.dataset.q;
  if (act === 'del') ed.fields.splice(i, 1);
  else if (act === 'up' && i > 0) [ed.fields[i - 1], ed.fields[i]] = [ed.fields[i], ed.fields[i - 1]];
  else if (act === 'down' && i < ed.fields.length - 1) [ed.fields[i + 1], ed.fields[i]] = [ed.fields[i], ed.fields[i + 1]];
  else if (act === 'oadd') q.options.push({ value: nextOpt(q), label: '', help: '' });
  else if (act === 'odel') {
    const j = Number(b.closest('.fm-opt-row')?.dataset.j);
    if (q.options.length > 1) q.options.splice(j, 1);
  } else return;
  drawQuestions();
}

/** Every typed character lands in the state at once, so a redraw of the question list (after a
 *  move or an added option) never loses what was written into the fields around it.
 *  每个敲进去的字符立刻落到状态里,于是题目列表的一次重画(移动、加选项之后)
 *  不会丢掉写在周围字段里的东西。 */
function onEditorInput(e) {
  const el = e.target;
  if (!el) return;
  if (el.id === 'fm-title') { ed.title = el.value; return; }
  if (el.id === 'fm-desc') { ed.description = el.value; return; }
  if (el.id === 'fm-kind') { ed.kind = el.value; return; }
  if (el.id === 'fm-subject') { ed.subject_tpl = el.value; return; }
  if (el.id === 'fm-rcpts') { ed.recipients = el.value; return; }
  if (el.id === 'fm-verify') { ed.verify_email = el.checked; return; }
  if (el.name === 'fm-aud') {
    ed.audience = el.value;
    // Hidden, not removed: the checkbox keeps its column so the row does not reflow.
    // 隐藏而不移除:复选框仍占着它那一列,这一行不会重排。
    qs('#fm-verify-w')?.classList.toggle('off', ed.audience === 'internal');
    return;
  }
  if (el.name === 'fm-store') { ed.store = el.value; return; }
  if (el.id === 'fm-src') {
    ed.src_lang = el.value;
    if (!ed.langs.includes(ed.src_lang)) ed.langs.push(ed.src_lang);
    qsa('.fm-lang-cb').forEach((cb) => {
      cb.disabled = cb.value === ed.src_lang;
      if (cb.value === ed.src_lang) cb.checked = true;
    });
    return;
  }
  if (el.classList.contains('fm-lang-cb')) {
    ed.langs = qsa('.fm-lang-cb').filter((cb) => cb.checked || cb.value === ed.src_lang).map((cb) => cb.value);
    return;
  }
  const card = el.closest('.fm-q');
  if (!card) return;
  const q = ed.fields[Number(card.dataset.i)];
  if (!q) return;
  if (el.dataset.f) {
    const f = el.dataset.f;
    if (f === 'required') q.required = el.checked;
    else if (f === 'type') {
      q.type = el.value;
      if (OPT_TYPES.has(q.type) && !q.options.length) q.options = [{ value: 'o1', label: '', help: '' }, { value: 'o2', label: '', help: '' }];
      drawQuestions();
    } else q[f] = el.value;
    if (f === 'label' || f === 'key') { const vars = qs('#fm-vars'); if (vars) vars.innerHTML = varsHtml(); }
    return;
  }
  if (el.dataset.o) {
    const o = q.options[Number(el.closest('.fm-opt-row')?.dataset.j)];
    if (o) o[el.dataset.o] = el.value;
  }
}

function insertVar(k) {
  const inp = qs('#fm-subject');
  if (!inp) return;
  const s = inp.selectionStart ?? inp.value.length;
  const e = inp.selectionEnd ?? s;
  inp.value = inp.value.slice(0, s) + `{${k}}` + inp.value.slice(e);
  ed.subject_tpl = inp.value;
  inp.focus();
  inp.selectionStart = inp.selectionEnd = s + k.length + 2;
}

/** Say what is wrong before asking the server, in the reader's words and pointing at the
 *  question. Returns false when something is.
 *  在问服务器之前先说出哪里不对,用读者的话、指着那道题。有问题时返回 false。 */
function validate() {
  if (!ed.title.trim()) { toast(t('fm_title_required'), true); qs('#fm-title')?.focus(); return false; }
  if (!ed.recipients.split(/[\s,;]+/).filter(Boolean).length) { toast(t('fm_rcpts_required'), true); qs('#fm-rcpts')?.focus(); return false; }
  const seen = new Set();
  for (let i = 0; i < ed.fields.length; i++) {
    const q = ed.fields[i];
    q.key = (q.key || '').trim();
    if (!q.label.trim()) return bad(i, 'label', t('fm_q_label_bad', i + 1));
    if (!KEY_RE.test(q.key) || RESERVED.has(q.key) || seen.has(q.key)) return bad(i, 'key', t('fm_q_key_bad', i + 1));
    seen.add(q.key);
    if (OPT_TYPES.has(q.type)) {
      const vals = new Set();
      for (const o of q.options) {
        o.value = (o.value || '').trim();
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(o.value) || vals.has(o.value)) return bad(i, null, t('fm_q_opts_bad', i + 1));
        vals.add(o.value);
      }
      if (!q.options.length) return bad(i, null, t('fm_q_opts_bad', i + 1));
    }
  }
  return true;
}

function bad(i, field, msg) {
  toast(msg, true);
  const card = qs(`.fm-q[data-i="${i}"]`);
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (field) qs(`[data-f="${field}"]`, card)?.focus();
  return false;
}

/**
 * A sheet over the page while a save is in progress, saying what is being done: first the save
 * itself, then each language being translated, ticked off as its answer arrives. Saving is fast
 * and translating is not, and a page that goes quiet for ten seconds looks broken.
 * 保存进行期间盖在页面上的一层,说明正在做什么:先是保存本身,然后是正在翻译的每一种语言,
 * 答复一到就打上勾。保存很快而翻译不快,一张十秒钟没动静的页面看起来就像坏了。
 */
function showBusy(title) {
  const el = document.createElement('div');
  el.className = 'fm-busy';
  el.innerHTML = `<div class="fm-busy-card"><div class="fm-busy-head"><span class="fm-spin"></span><span class="fm-busy-title">${esc(title)}</span></div><div class="fm-busy-list"></div><div class="fm-busy-hint dim">${esc(t('fm_busy_hint'))}</div></div>`;
  document.body.appendChild(el);
  const list = el.querySelector('.fm-busy-list');
  const label = (l) => (LANG_OPTIONS.find(([c]) => c === l) || [l, l])[1];
  return {
    title(s) { el.querySelector('.fm-busy-title').textContent = s; },
    // Every language is listed at once, so the whole of what is coming is visible; only the one
    // in flight spins, the rest wait with a dot.
    // 所有语言一次列出,来的是什么一目了然;只有正在进行的那一种转圈,其余的用一个点等着。
    langs(ls) {
      list.innerHTML = ls.map((l) => `<div class="fm-busy-row pending" data-lang="${esc(l)}"><span class="fm-busy-mark">·</span><span>${esc(label(l))}</span></div>`).join('');
    },
    active(l) {
      const row = [...list.children].find((r) => r.dataset.lang === l);
      if (!row) return;
      row.classList.remove('pending');
      row.innerHTML = `<span class="fm-spin sm"></span><span>${esc(t('fm_translating', label(l)))}</span>`;
    },
    done(l, ok) {
      const row = [...list.children].find((r) => r.dataset.lang === l);
      if (!row) return;
      row.innerHTML = `<span class="fm-busy-mark ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span><span>${esc(ok ? t('fm_translated', label(l)) : t('fm_translate_failed', label(l)))}</span>`;
    },
    close() { el.remove(); },
  };
}

async function save(extra = {}) {
  if (!validate()) return;
  const h = document.documentElement;
  const body = {
    kind: ed.kind, title: ed.title, description: ed.description, audience: ed.audience, verify_email: ed.verify_email,
    src_lang: ed.src_lang, langs: ed.langs, fields: ed.fields, subject_tpl: ed.subject_tpl,
    recipients: ed.recipients.split(/[\s,;]+/).filter(Boolean),
    store: ed.store,
    // The look the fill page opens with, unless the visitor picks otherwise
    // 填写页默认以此观感打开,除非访问者另选
    theme: h.dataset.theme || '', mode: h.classList.contains('wa-dark') ? 'dark' : 'light',
    ...extra,
  };
  const btn = qs('#fm-save');
  if (btn) btn.loading = true;
  const isNew = !ed.id;
  const busy = showBusy(t('fm_saving'));
  try {
    const r = isNew ? await api('POST', '/api/forms', body) : await api('PUT', `/api/forms/${ed.id}`, body);
    ed = fromServer(r.form);
    // The save is in; now the languages, each its own request, so each can be reported as it lands.
    // 保存已经落地;接下来是各语言,一种一个请求,于是每一种都能在到达时被报告。
    const missing = r.translate === 'off' ? [] : (r.missing_langs || []);
    let failed = 0;
    if (missing.length) {
      busy.title(t('fm_saved', ed.version));
      busy.langs(missing);
      // One language at a time: the sheet then says exactly which is in flight, and no two
      // answers race each other into the same row.
      // 一次一种语言:那张纸上说的就是此刻正在进行的那一种,也不会有两份答复抢着写同一行。
      for (const l of missing) {
        busy.active(l);
        try {
          const tr = await api('POST', `/api/forms/${ed.id}/translate`, { lang: l });
          busy.done(l, !!tr.done);
          if (!tr.done) failed++;
        } catch {
          busy.done(l, false);
          failed++;
        }
      }
      // Leave the ticks on screen for a beat, so the last one can be seen landing.
      // 让勾号在屏幕上停一拍,好看见最后一个落下。
      await new Promise((ok) => setTimeout(ok, 600));
    }
    const note = failed ? ' ' + t('fm_tr_partial') : r.translate === 'off' ? ' ' + t('fm_tr_off') : '';
    toast(t('fm_saved', ed.version) + note, false, note ? 6000 : 0);
    if (isNew) navigate(`#/forms/edit/${ed.id}`);
    else {
      const meta = qs('#fm-edmeta');
      if (meta) meta.innerHTML = edMetaHtml();
      setTitle(ed.title);
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy.close();
    if (btn) btn.loading = false;
  }
}
