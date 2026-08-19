import { api } from './api.js';
import { esc, icon, qs, qsa, toast, fmtSize, fmtDateTime, confirmDialog, showModal, closeModal, copyText } from './ui.js';
import { t } from './i18n.js';
import { tabImport } from './admin-import.js';
import { tabExport } from './admin-export.js';
import { store, navigate, show, applyTheme, applyFonts, refreshMe } from './app.js';
import { pickFont, ensureFont } from './fontpicker.js';
import { roleName } from './auth.js';
import { THEMES } from './themes-meta.js';

/**
 * Preselect whichever domain matches the entry host being visited.
 * In local development, or when visiting some other host, nothing matches and it falls back to the first.
 * 默认选中当前入口域名(intl-mail.<域名>)对应的那个。
 * 本地开发或访问的是别的 host 时匹配不上,回落到第一个。
 */
function currentDomainId(domains) {
  const host = location.hostname.replace(/^intl-mail\./, '');
  return domains.find((d) => d.name === host)?.id || domains[0]?.id || '';
}

const TABS = () => [
  { key: 'overview', name: t('a_overview') },
  { key: 'domains', name: t('a_domains') },
  { key: 'users', name: t('a_users') },
  { key: 'invites', name: t('a_invites') },
  { key: 'unrouted', name: t('a_unrouted') },
  { key: 'import', name: t('a_import') },
  { key: 'export', name: t('a_export') },
  { key: 'audit', name: t('a_audit') },
  { key: 'ai', name: t('a_ai') },
  { key: 'drive', name: t('a_drive') },
];

export async function renderAdmin(tab) {
  const me = store.me;
  if (!me.user.is_admin && !(me.domain_admin_of || []).length) {
    navigate('#/');
    return;
  }
  const tabsHtml = TABS()
    .filter((x) => !x.globalOnly || me.user.is_admin)
    .map((x) => `<a class="tab ${x.key === tab ? 'active' : ''}" href="#/admin/${x.key}">${esc(x.name)}</a>`)
    .join('');
  show(`
  <div class="page">
    <header class="page-head">
      <wa-button class="icon" appearance="plain" href="#/" aria-label="${esc(t('back_mail'))}">${icon('back', 20)}</wa-button>
      <h1>${esc(t('admin'))}</h1>
      <nav class="tabs">${tabsHtml}</nav>
    </header>
    <div class="page-body wide" id="admin-body"><div class="loading">${esc(t('loading'))}</div></div>
  </div>`);
  const body = qs('#admin-body');
  try {
    if (tab === 'overview') await tabOverview(body);
    else if (tab === 'domains') await tabDomains(body);
    else if (tab === 'users') await tabUsers(body);
    else if (tab === 'invites') await tabInvites(body);
    else if (tab === 'unrouted') await tabUnrouted(body);
    else if (tab === 'import') await tabImport(body);
    else if (tab === 'export') await tabExport(body);
    else if (tab === 'audit') await tabAudit(body);
    else if (tab === 'ai') await tabAI(body);
    else if (tab === 'drive') await tabDrive(body);
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------- Overview ----------
// ---------- 总览 ----------

async function tabOverview(body) {
  const data = await api('GET', '/api/admin/overview');
  const rows = data.domains
    .map(
      (d) => `
    <tr>
      <td><b>${esc(d.name)}</b></td>
      <td>${d.mailbox_count}</td>
      <td>${d.member_count}</td>
      <td>${d.msg_count}<span class="dim">${esc(t('in_out', d.msg_in, d.msg_out))}</span></td>
      <td>${fmtSize(d.bytes)}</td>
      <td>${d.last_activity ? fmtDateTime(d.last_activity) : '—'}</td>
    </tr>`
    )
    .join('');
  const total = data.domains.reduce(
    (a, d) => ({ mb: a.mb + d.mailbox_count, msg: a.msg + d.msg_count, bytes: a.bytes + d.bytes }),
    { mb: 0, msg: 0, bytes: 0 }
  );
  const stName = { queued: t('st_queued'), sending: t('st_sending'), sent: t('st_sent'), failed: t('st_failed') };
  const outboxHtml = (data.outbox || [])
    .map((o) => `<span class="chip ${o.status === 'failed' ? 'chip-err' : o.status === 'queued' ? 'chip-warn' : 'chip-ok'}">${esc(stName[o.status] || o.status)} ${o.n}</span>`)
    .join(' ');
  body.innerHTML = `
    <section class="card">
      <h3>${esc(t('by_domain'))}</h3>
      <table class="table">
        <thead><tr><th>${esc(t('th_domain'))}</th><th>${esc(t('th_mb_count'))}</th><th>${esc(t('th_member_count'))}</th><th>${esc(t('th_msg_count'))}</th><th>${esc(t('th_storage'))}</th><th>${esc(t('th_last_active'))}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="dim">${esc(t('no_domains'))}</td></tr>`}</tbody>
        <tfoot><tr><td>${esc(t('sum_domains', data.domains.length))}</td><td>${total.mb}</td><td></td><td>${total.msg}</td><td>${fmtSize(total.bytes)}</td><td></td></tr></tfoot>
      </table>
    </section>
    <section class="card">
      <h3>${esc(t('outbox_title'))}</h3>
      <div>${outboxHtml || `<span class="dim">${esc(t('no_send_records'))}</span>`}</div>
    </section>`;
}

// ---------- Domains and mailboxes ----------
// ---------- 域名与邮箱 ----------

async function tabDomains(body) {
  const me = store.me;
  const { domains } = await api('GET', '/api/admin/domains');
  const sel = currentDomainId(domains);
  const domOptions = domains
    .map((d) => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}</option>`)
    .join('');
  body.innerHTML = `
    <section class="card">
      <div class="form-row">
        <label>${esc(t('domain_label'))}</label>
        <select id="dom-sel" style="width:260px">${domOptions}</select>
      </div>
      ${me.user.is_admin ? `
      <form id="f-dom" class="form-row">
        <label>${esc(t('add_domain'))}</label>
        <input name="name" type="text" placeholder="${esc(t('new_domain_ph'))}" style="width:260px">
        <wa-button appearance="outlined" type="submit">${icon('plus', 16)} ${esc(t('add_domain'))}</wa-button>
      </form>` : ''}
      <p class="dim" style="margin:8px 0 0">${esc(t('domain_note'))}</p>
    </section>
    <div id="dom-detail"><div class="loading">${esc(t('loading'))}</div></div>`;
  qs('#dom-sel')?.addEventListener('change', (e) => renderDomainDetail(e.target.value));
  qs('#f-dom')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim();
    if (!name) return;
    try {
      await api('POST', '/api/admin/domains', { name });
      toast(t('t_domain_added'));
      renderAdmin('domains');
    } catch (err) {
      toast(err.message, true);
    }
  });
  if (sel) await renderDomainDetail(sel);
  else qs('#dom-detail').innerHTML = `<div class="empty">${esc(t('pick_domain_first'))}</div>`;
}

async function renderDomainDetail(domainId) {
  const box = qs('#dom-detail');
  box.innerHTML = `<div class="loading">${esc(t('loading'))}</div>`;
  const [{ mailboxes }, { admins }, aliasData, optData, brand] = await Promise.all([
    api('GET', `/api/admin/domains/${domainId}/mailboxes`),
    api('GET', `/api/admin/domains/${domainId}/admins`),
    api('GET', `/api/admin/domains/${domainId}/aliases`),
    api('GET', '/api/admin/mailbox-options'),
    api('GET', `/api/admin/domains/${domainId}/brand`),
  ]);
  // Who may appoint a domain admin is decided on the server; the interface only stops offering
  // what would come back 403, so a domain admin sees the list without controls to change it.
  // 谁能任命域管理员由服务端说了算;界面只是不再提供注定 403 的操作 ——
  // 域管理员看得到名单,但没有改动它的控件。
  const isGlobal = !!store.me.user.is_admin;
  const rows = mailboxes
    .map(
      (m) => `
    <tr class="${m.disabled ? 'disabled-row' : ''}">
      <td><b>${esc(m.local_part)}</b>${m.disabled ? ` <span class="chip chip-err">${esc(t('chip_disabled'))}</span>` : ''}</td>
      <td>${esc(m.display_name || '')}</td>
      <td>${m.members.map((g) => `<span class="chip" title="${esc(g.email)}">${esc(g.name || g.email)}·${roleName(g.role)}<span class="chip-x" role="button" tabindex="0" data-ungrant="${esc(m.id)}:${esc(g.user_id)}">×</span></span>`).join(' ') || `<span class="dim">${esc(t('unassigned'))}</span>`}</td>
      <td>${m.msg_count}</td>
      <td>${fmtSize(m.bytes)}</td>
      <td class="nowrap">
        <wa-button appearance="plain" size="small" data-grant="${esc(m.id)}">${esc(t('grant_member'))}</wa-button>
        <wa-button appearance="plain" size="small" data-toggle="${esc(m.id)}:${m.disabled ? 0 : 1}">${esc(m.disabled ? t('enable') : t('disable'))}</wa-button>
        <wa-button appearance="plain" size="small" class="danger-btn" data-purge="${esc(m.id)}:${esc(m.local_part)}">${esc(t('mb_purge'))}</wa-button>
        <wa-button appearance="plain" size="small" class="danger-btn" data-dropmb="${esc(m.id)}:${esc(m.local_part)}">${esc(t('mb_drop'))}</wa-button>
      </td>
    </tr>`
    )
    .join('');
  const logoPreview = brand.has_logo
    ? `<img class="brand-logo" data-logo-mode="${esc(brand.logo_mode || 'light')}" src="/api/brand/logo?d=${encodeURIComponent(brand.domain)}&ts=${Date.now()}" style="height:40px;border-radius:8px;border:1px solid var(--border);padding:2px">`
    : `<span class="dim">${esc(t('none'))}</span>`;
  box.innerHTML = `
    <section class="card">
      <h3>${esc(t('mailboxes_title'))}</h3>
      <table class="table">
        <thead><tr><th>${esc(t('th_addr'))}</th><th>${esc(t('th_display'))}</th><th>${esc(t('th_members'))}</th><th>${esc(t('th_msg_count'))}</th><th>${esc(t('th_storage'))}</th><th>${esc(t('th_ops'))}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="dim">${esc(t('no_mb_admin'))}</td></tr>`}</tbody>
      </table>
      <form id="f-mb" class="form-row" style="margin-top:12px">
        <label>${esc(t('new_mailbox'))}</label>
        <input name="local" type="text" placeholder="${esc(t('local_ph'))}" required style="width:200px">
        <input name="dn" type="text" placeholder="${esc(t('display_ph'))}" style="width:200px">
        <wa-button variant="brand" type="submit">${icon('plus', 16)} ${esc(t('new_mailbox'))}</wa-button>
      </form>
    </section>
    <section class="card">
      <h3>${esc(t('alias_title'))}<span class="dim" style="font-weight:400;margin-left:8px">${esc(t('alias_note'))}</span></h3>
      <table class="table">
        <thead><tr><th>${esc(t('th_alias'))}</th><th>${esc(t('th_target'))}</th><th></th></tr></thead>
        <tbody>${(aliasData.aliases || [])
          .map((a) => `<tr><td><b>${esc(a.address)}</b></td><td>${esc(a.target)}</td><td><wa-button appearance="plain" size="small" class="danger" data-unalias="${esc(a.id)}">${esc(t('delete'))}</wa-button></td></tr>`)
          .join('') || `<tr><td colspan="3" class="dim">${esc(t('no_alias'))}</td></tr>`}</tbody>
      </table>
      <form id="f-alias" class="form-row" style="margin-top:12px">
        <label>${esc(t('add_alias'))}</label>
        <input name="local" type="text" placeholder="${esc(t('alias_ph'))}" required style="width:200px">
        <span class="dim">→</span>
        <select name="target" style="width:240px">${(optData.mailboxes || [])
          .map((m) => `<option value="${esc(m.id)}">${esc(m.address)}</option>`)
          .join('')}</select>
        <wa-button appearance="outlined" type="submit">${icon('plus', 16)} ${esc(t('add_alias'))}</wa-button>
      </form>
    </section>
    <section class="card">
      <h3>${esc(t('brand_title'))}<span class="dim" style="font-weight:400;margin-left:8px">${esc(t('brand_note', brand.domain))}</span></h3>
      <form id="f-brand" class="form-row">
        <label>${esc(t('brand_name_label'))}</label>
        <input name="bname" type="text" value="${esc(brand.brand_name || '')}" placeholder="${esc(t('brand_name_ph'))}" style="width:260px">
        <wa-button variant="brand" type="submit">${esc(t('save'))}</wa-button>
      </form>
      <div class="form-row">
        <label>${esc(t('brand_font'))}</label>
        <wa-button class="font-btn" appearance="outlined" id="btn-brand-font">
          <span class="fb-label" style="font-family:${brand.brand_font ? `'${esc(brand.brand_font)}',` : ''}var(--font-brand)">${esc(brand.brand_font || t('font_default'))}</span>
        </wa-button>
        <span class="dim ellip">${esc(t('brand_font_note'))}</span>
      </div>
      <div class="form-row">
        <label>${esc(t('brand_logo_label'))}</label>
        ${logoPreview}
        <wa-button appearance="outlined" id="btn-logo-up">${esc(t('upload_logo'))}</wa-button>
        ${brand.has_logo ? `<wa-button appearance="plain" class="danger" id="btn-logo-rm">${esc(t('remove_logo'))}</wa-button>` : ''}
        <input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden>
        ${brand.has_logo ? `<span class="chip">${esc(brand.logo_mode === 'dark' ? t('logo_mode_dark') : t('logo_mode_light'))}</span>` : ''}
        <span class="dim ellip">${esc(t('logo_hint'))}</span>
      </div>
      <p class="dim" style="margin:2px 0 0 130px">${esc(t('logo_mode_hint'))}</p>
      <div class="form-row" style="align-items:flex-start;margin-top:12px">
        <label>${esc(t('theme'))}</label>
        <div class="theme-grid" id="theme-grid">
          <button class="theme-swatch default-swatch ${!brand.brand_theme ? 'active' : ''}" data-theme="" title="${esc(t('theme_default_hint'))}"><span class="dot">A</span></button>
          ${THEMES.map((th) => `<button class="theme-swatch ${brand.brand_theme === th.name ? 'active' : ''}" data-theme="${esc(th.name)}" title="${esc(th.name)}"><span class="dot" style="background:${th.solid}"></span></button>`).join('')}
        </div>
      </div>
    </section>
    <section class="card">
      <h3>${esc(t('da_title'))}</h3>
      <div>${admins.map((a) => `<span class="chip">${esc(a.name || a.email)}${isGlobal ? `<span class="chip-x" role="button" tabindex="0" data-unadmin="${esc(a.id)}">×</span>` : ''}</span>`).join(' ') || `<span class="dim">${esc(t('none'))}</span>`}</div>
      ${isGlobal ? `
      <form id="f-da" class="form-row" style="margin-top:12px">
        <label>${esc(t('add_da'))}</label>
        <input name="email" type="email" placeholder="${esc(t('reg_email_ph'))}" required style="width:260px">
        <wa-button appearance="outlined" type="submit">${esc(t('add_da'))}</wa-button>
      </form>`
      : `<p class="dim" style="margin-top:12px">${esc(t('da_global_only'))}</p>`}
    </section>`;

  qs('#f-mb').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', `/api/admin/domains/${domainId}/mailboxes`, { local_part: fd.get('local'), display_name: fd.get('dn') });
      toast(t('t_mb_created'));
      renderDomainDetail(domainId);
    } catch (err) {
      toast(err.message, true);
    }
  });
  qs('#f-alias').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', `/api/admin/domains/${domainId}/aliases`, { local_part: fd.get('local'), mailbox_id: fd.get('target') });
      toast(t('t_alias_added'));
      renderDomainDetail(domainId);
    } catch (err) {
      toast(err.message, true);
    }
  });
  qs('#f-brand').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/admin/domains/${domainId}/brand`, { name: new FormData(e.target).get('bname') });
      toast(t('t_brand_saved'));
    } catch (err) {
      toast(err.message, true);
    }
  });
  qs('#theme-grid').addEventListener('click', async (e) => {
    const sw = e.target.closest('.theme-swatch');
    if (!sw) return;
    const theme = sw.dataset.theme;
    qsa('#theme-grid .theme-swatch').forEach((x) => x.classList.toggle('active', x === sw));
    // Preview immediately when this domain happens to be the entry currently being visited
    // 若该域名就是当前访问入口,即时预览
    if (store.brand && brand.domain && new URL(location.href).hostname.endsWith(brand.domain)) {
      applyTheme(theme || 'blue');
    }
    try {
      await api('POST', `/api/admin/domains/${domainId}/brand`, { theme });
      if (store.brand && brand.domain && new URL(location.href).hostname.endsWith(brand.domain)) store.brand.theme = theme || null;
      toast(t('t_theme_saved'));
    } catch (err) {
      toast(err.message, true);
    }
  });
  qs('#btn-brand-font').addEventListener('click', async () => {
    const picked = await pickFont(brand.brand_font || '', t('brand_font'));
    if (picked === null) return;
    try {
      await api('POST', `/api/admin/domains/${domainId}/brand`, { font: picked });
      if (picked) ensureFont(picked);
      // If the domain being viewed is the one being edited, apply it right away
      // 若正在访问的就是该域名,立即生效
      if (store.brand && new URL(location.href).hostname.endsWith(brand.domain)) {
        store.brand.font = picked || null;
        applyFonts();
      }
      toast(t('t_font_saved'));
      renderDomainDetail(domainId);
    } catch (err) {
      toast(err.message, true);
    }
  });
  qs('#btn-logo-up').addEventListener('click', () => qs('#logo-file').click());
  qs('#logo-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    // Record the light/dark mode at upload time as this logo's native mode
    // 记录上传时所处的明暗模式,作为该 logo 的原生模式
    fd.append('mode', document.documentElement.classList.contains('wa-dark') ? 'dark' : 'light');
    try {
      await api('POST', `/api/admin/domains/${domainId}/brand/logo`, fd);
      toast(t('t_logo_saved'));
      renderDomainDetail(domainId);
    } catch (err) {
      toast(err.message, true);
    }
  });
  qs('#btn-logo-rm')?.addEventListener('click', async () => {
    await api('DELETE', `/api/admin/domains/${domainId}/brand/logo`);
    toast(t('t_logo_removed'));
    renderDomainDetail(domainId);
  });
  qs('#f-da')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/admin/domains/${domainId}/admins`, { email: new FormData(e.target).get('email') });
      toast(t('t_added'));
      renderDomainDetail(domainId);
    } catch (err) {
      toast(err.message, true);
    }
  });
  box.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-grant]');
    if (g) return grantModal(g.dataset.grant, domainId);
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const [id, dis] = tg.dataset.toggle.split(':');
      await api('POST', `/api/admin/mailboxes/${id}`, { disabled: dis === '1' });
      renderDomainDetail(domainId);
      return;
    }
    const pg = e.target.closest('[data-purge]');
    if (pg) {
      const [id, name] = pg.dataset.purge.split(':');
      await purgeMailbox(id, name, () => renderDomainDetail(domainId));
      return;
    }
    const dp = e.target.closest('[data-dropmb]');
    if (dp) {
      const [id, name] = dp.dataset.dropmb.split(':');
      await dropMailbox(id, name, () => renderDomainDetail(domainId));
      return;
    }
    const ug = e.target.closest('[data-ungrant]');
    if (ug) {
      const [mbId, userId] = ug.dataset.ungrant.split(':');
      if (await confirmDialog(t('ungrant_confirm'))) {
        await api('DELETE', `/api/admin/mailboxes/${mbId}/grants/${userId}`);
        renderDomainDetail(domainId);
      }
      return;
    }
    const ua = e.target.closest('[data-unadmin]');
    if (ua) {
      if (await confirmDialog(t('da_del_confirm'))) {
        await api('DELETE', `/api/admin/domains/${domainId}/admins/${ua.dataset.unadmin}`);
        renderDomainDetail(domainId);
      }
      return;
    }
    const al = e.target.closest('[data-unalias]');
    if (al) {
      if (await confirmDialog(t('alias_del_confirm'))) {
        await api('DELETE', `/api/admin/aliases/${al.dataset.unalias}`);
        renderDomainDetail(domainId);
      }
    }
  });
}

function grantModal(mailboxId, domainId) {
  const m = showModal(`
    <h3 style="margin:0 0 12px">${esc(t('grant_title'))}</h3>
    <form id="f-grant" class="form-col">
      <input name="email" type="email" placeholder="${esc(t('reg_email_ph'))}" required>
      <select name="role">
        <option value="member">${esc(t('role_member_full'))}</option>
        <option value="owner">${esc(t('role_owner'))}</option>
        <option value="readonly">${esc(t('role_readonly'))}</option>
      </select>
      <div class="modal-foot">
        <wa-button appearance="plain" type="button" id="g-cancel">${esc(t('cancel'))}</wa-button>
        <wa-button variant="brand" type="submit">${esc(t('grant_btn'))}</wa-button>
      </div>
    </form>`);
  m.querySelector('#g-cancel').onclick = closeModal;
  m.querySelector('#f-grant').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', `/api/admin/mailboxes/${mailboxId}/grants`, { email: fd.get('email'), role: fd.get('role') });
      closeModal();
      toast(t('t_granted'));
      renderDomainDetail(domainId);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------- Members ----------
// ---------- 成员 ----------

async function tabUsers(body) {
  const me = store.me;
  const [{ users }, invData] = await Promise.all([
    api('GET', '/api/admin/users'),
    api('GET', '/api/admin/invites').catch(() => ({ invites: [] })),
  ]);
  const pending = (invData.invites || []).filter((i) => i.status === 'pending');
  const pendHtml = pending.length
    ? `<section class="card"><h3>${esc(t('pending_invites', pending.length))}</h3>
       ${pending.map((i) => `<div class="row-flex" style="padding:4px 0"><span>${esc(i.multi_use ? t('inv_kind_multi') : i.email || t('unlimited'))}</span><span class="dim">${esc(i.multi_use ? t('inv_joined', i.joined || 0) : i.legacy ? t('inv_legacy') : i.address || t('inv_self_pick', i.domain_name || ''))}</span><span class="flex1"></span><span class="dim">${esc(t('by_creator', i.creator || ''))}</span></div>`).join('')}
       <p class="dim">${esc(t('invites_hint'))}</p></section>`
    : '';
  const rows = users
    .map(
      (u) => `
    <tr class="${u.disabled ? 'disabled-row' : ''}">
      <td><b>${esc(u.name || '')}</b><div class="dim">${esc(u.email)}</div></td>
      <td>${u.is_admin ? `<span class="chip chip-ok">${esc(t('chip_global_admin'))}</span>` : ''}${u.disabled ? `<span class="chip chip-err">${esc(t('t_disabled'))}</span>` : `<span class="chip">${esc(t('chip_normal'))}</span>`}</td>
      <td>${u.grants.map((g) => `<span class="chip" title="${roleName(g.role)}">${esc(g.address)}<span class="chip-x" role="button" tabindex="0" title="${esc(t('revoke_grant'))}" data-ungrant="${esc(g.mailbox_id)}|${esc(u.id)}|${esc(g.address)}|${esc(u.email)}">×</span></span>`).join(' ') || `<span class="dim">${esc(t('none'))}</span>`}</td>
      <td>${u.msg_count}</td>
      <td>${fmtSize(u.bytes || 0)}</td>
      <td>${u.last_login ? fmtDateTime(u.last_login) : `<span class="dim">${esc(t('never_login'))}</span>`}</td>
      ${me.user.is_admin ? `
      <td class="nowrap">
        <wa-button appearance="plain" size="small" data-logoutall="${esc(u.id)}|${esc(u.email)}|${u.id === me.user.id ? 1 : 0}">${esc(t('logout_all'))}</wa-button>
        ${u.id !== me.user.id ? `
        <wa-button appearance="plain" size="small" data-status="${esc(u.id)}:${u.disabled ? 0 : 1}">${esc(u.disabled ? t('enable') : t('disable'))}</wa-button>
        <wa-button appearance="plain" size="small" class="danger" data-del="${esc(u.id)}:${esc(u.email)}">${esc(t('delete'))}</wa-button>` : ''}
      </td>` : '<td></td>'}
    </tr>`
    )
    .join('');
  body.innerHTML = `
    ${pendHtml}
    <section class="card">
      <h3>${esc(t('members_title', users.length))}<span class="dim" style="font-weight:400;margin-left:8px">${esc(t('usage_note'))}</span></h3>
      <table class="table members-table">
        <thead><tr><th>${esc(t('th_user'))}</th><th>${esc(t('th_status'))}</th><th class="col-mailboxes">${esc(t('th_mailboxes'))}</th><th>${esc(t('th_msg_count'))}</th><th>${esc(t('th_storage'))}</th><th class="col-lastlogin">${esc(t('th_last_login'))}</th><th>${esc(t('th_ops'))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  body.addEventListener('click', async (e) => {
    // Revoking one grant is the domain-scoped way to remove somebody: an account can hold
    // mailboxes in several domains, so disabling it is a global act and stays with the global
    // admin, while the door to THIS mailbox is the domain admin's own to close.
    // 撤销单条授权,是"按域"把人请出去的正确形态:一个账号可能在多个域持有邮箱,
    // 禁用账号是全局动作、留给全局管理员;而这个邮箱的门,归本域管理员自己关。
    const ug = e.target.closest('[data-ungrant]');
    if (ug) {
      const [mailboxId, userId, address, email] = ug.dataset.ungrant.split('|');
      if (!(await confirmDialog(t('revoke_grant_confirm', email, address), t('revoke_grant')))) return;
      try {
        await api('DELETE', `/api/admin/mailboxes/${mailboxId}/grants/${userId}`);
        toast(t('t_removed'));
        renderAdmin('users');
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    const lo = e.target.closest('[data-logoutall]');
    if (lo) {
      const [id, email, selfFlag] = lo.dataset.logoutall.split('|');
      const isSelf = selfFlag === '1';
      if (!(await confirmDialog(isSelf ? t('logout_all_self_confirm') : t('logout_all_confirm', email), t('logout_all')))) return;
      const r = await api('POST', `/api/admin/users/${id}/logout-all`, {});
      // Revoking your own sessions kills this device's session too, so go straight back to the sign-in page
      // 撤销的是自己:这台设备的会话也没了,直接回登录页
      if (isSelf) {
        location.hash = '#/login';
        location.reload();
        return;
      }
      toast(t('logout_all_done', r.revoked));
      return;
    }
    const s = e.target.closest('[data-status]');
    if (s) {
      const [id, dis] = s.dataset.status.split(':');
      const disable = dis === '1';
      if (disable && !(await confirmDialog(t('disable_confirm'), t('disable')))) return;
      await api('POST', `/api/admin/users/${id}/status`, { disabled: disable });
      toast(disable ? t('t_disabled') : t('t_enabled'));
      tabUsers(body);
      return;
    }
    const d = e.target.closest('[data-del]');
    if (d) {
      const [id, email] = d.dataset.del.split(':');
      if (!(await confirmDialog(t('del_user_confirm', email), t('delete')))) return;
      await api('DELETE', `/api/admin/users/${id}`);
      toast(t('t_deleted'));
      tabUsers(body);
    }
  });
}

// ---------- Mail for unmatched recipients ----------
// ---------- 未匹配收件人的来信 ----------

let unroutedPage = 0;

async function tabUnrouted(body) {
  const data = await api('GET', `/api/admin/unrouted?page=${unroutedPage}`);
  const items = data.items || [];
  const rows = items
    .map(
      (u) => `
    <tr>
      <td><b>${esc(u.to_addr)}</b></td>
      <td>${esc(u.from_addr || '—')}</td>
      <td class="ellip-cell">${esc(u.subject || t('no_subject'))}</td>
      <td class="dim nowrap">${fmtDateTime(u.created_at)}</td>
      <td class="nowrap">${fmtSize(u.size)}</td>
      <td class="nowrap">
        <wa-button appearance="plain" size="small" data-view="${esc(u.id)}">${esc(t('view'))}</wa-button>
        <wa-button appearance="plain" size="small" class="danger" data-drop="${esc(u.id)}">${esc(t('delete'))}</wa-button>
      </td>
    </tr>`
    )
    .join('');
  body.innerHTML = `
    <section class="card">
      <h3>${esc(t('a_unrouted'))}<span class="dim" style="font-weight:400;margin-left:8px">${esc(t('unrouted_note'))}</span></h3>
      <table class="table">
        <thead><tr><th>${esc(t('th_rcpt'))}</th><th>${esc(t('fwd_from'))}</th><th>${esc(t('fwd_subject'))}</th><th>${esc(t('th_created'))}</th><th>${esc(t('th_storage'))}</th><th>${esc(t('th_ops'))}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="dim">${esc(t('unrouted_empty'))}</td></tr>`}</tbody>
      </table>
      <div class="row-flex" style="margin-top:12px">
        <wa-button appearance="outlined" size="small" id="un-prev" ${unroutedPage === 0 ? 'disabled' : ''}>${esc(t('prev_page'))}</wa-button>
        <span class="dim">${esc(t('page_n', unroutedPage + 1))}</span>
        <wa-button appearance="outlined" size="small" id="un-next" ${data.has_more ? '' : 'disabled'}>${esc(t('next_page'))}</wa-button>
      </div>
      <p class="dim" style="margin:10px 0 0">${esc(t('unrouted_retention'))}</p>
    </section>`;

  qs('#un-prev')?.addEventListener('click', () => { unroutedPage = Math.max(0, unroutedPage - 1); renderAdmin('unrouted'); });
  qs('#un-next')?.addEventListener('click', () => { unroutedPage += 1; renderAdmin('unrouted'); });

  body.addEventListener('click', async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) return viewUnrouted(v.dataset.view);
    const dpt = e.target.closest('[data-drop]');
    if (dpt && (await confirmDialog(t('unrouted_del_confirm'), t('delete')))) {
      await api('DELETE', `/api/admin/unrouted/${dpt.dataset.drop}`);
      toast(t('t_deleted'));
      renderAdmin('unrouted');
    }
  });
}

async function viewUnrouted(id) {
  let d;
  try {
    d = await api('GET', `/api/admin/unrouted/${id}/body`);
  } catch (e) {
    return toast(e.message, true);
  }
  const m = showModal(`
    <h3 style="margin:0 0 10px">${esc(d.subject || t('no_subject'))}</h3>
    <div class="form-row"><label>${esc(t('th_rcpt'))}</label><span>${esc(d.to)}</span></div>
    <div class="form-row"><label>${esc(t('fwd_from'))}</label><span>${esc(d.from || '—')}</span></div>
    <div class="form-row"><label>${esc(t('fwd_date'))}</label><span>${fmtDateTime(d.created_at)}</span></div>
    <div class="unrouted-body" id="un-body"></div>
    <div class="modal-foot"><wa-button appearance="plain" id="un-close">${esc(t('close'))}</wa-button></div>`);
  const box = m.querySelector('#un-body');
  if (d.html) {
    // Rendered in a sandboxed iframe with script disabled; remote images were already stripped server-side
    // 沙箱 iframe 渲染,禁脚本;远程图片已在服务端剥离
    const f = document.createElement('iframe');
    f.className = 'mailframe';
    f.setAttribute('sandbox', '');
    box.appendChild(f);
    // Unrouted mail is mostly phishing and spam: a CSP cuts off every remote subresource (remote images,
    // srcset, CSS backgrounds, fonts) and leaves only inline styles, so simply opening one cannot send
    // back a read receipt and an IP. Stripping <img> on the server is one layer; this is the backstop.
    // 未匹配来信多是钓鱼/垃圾:CSP 掐断一切远程子资源(远程图、srcset、CSS 背景、字体),
    // 只留内联样式,避免管理员一打开就被回传阅读回执 + IP。服务端的 <img> 剥离只是其一,靠这层兜底。
    f.srcdoc =
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
      `<style>html,body{height:auto}body{font:14px/1.6 system-ui,sans-serif;color:#1f1f1f;background:#fff;margin:0;padding:10px;word-break:break-word;overflow-wrap:anywhere}` +
      `a{pointer-events:none;color:#0b57d0;text-decoration:underline}img{max-width:100%}` +
      // This viewer is a fixed 340px tall and always shows a scrollbar, so it matches the site-wide styling (an iframe cannot see the outer CSS)
      // 这个查看框是固定 340px 高、必定出滚动条的,样式和全站对齐(iframe 拿不到外面的 CSS)
      `::-webkit-scrollbar{width:18px;height:18px}` +
      `::-webkit-scrollbar-track{background:rgba(0,0,0,.06);border-radius:999px}` +
      `::-webkit-scrollbar-thumb{background:rgba(0,0,0,.28);border-radius:999px;border:5px solid transparent;background-clip:content-box}` +
      `::-webkit-scrollbar-button{display:none;width:0;height:0}</style>` +
      d.html;
  } else {
    box.innerHTML = `<div class="plainbody">${esc(d.text || t('no_content'))}</div>`;
  }
  m.querySelector('#un-close').onclick = closeModal;
}

// ---------- Invites ----------
// ---------- 邀请 ----------

async function tabInvites(body) {
  const me = store.me;
  const [{ domains }, invData] = await Promise.all([
    api('GET', '/api/admin/domains'),
    api('GET', '/api/admin/invites'),
  ]);
  // Invites no longer hang off an existing mailbox, so there is no need to pull each domain's mailbox list
  // 邀请不再挂在"已存在的邮箱"上,所以不用再把每个域名的邮箱列表拉下来
  const firstDomain = currentDomainId(domains);
  const domainOptions = domains.map((d) => `<wa-option value="${esc(d.id)}">${esc(d.name)}</wa-option>`).join('');
  const stText = { pending: t('inv_pending'), used: t('inv_used'), expired: t('inv_expired'), revoked: t('inv_revoked') };
  const rows = (invData.invites || [])
    .map(
      (i) => `
    <tr>
      <td>${i.multi_use ? `<span class="chip chip-ok">${esc(t('inv_kind_multi'))}</span>` : esc(i.email || t('unlimited'))}</td>
      <td>${i.legacy
        ? `<span class="chip chip-warn">${esc(t('inv_legacy'))}</span>`
        : i.address
        ? `<span class="chip">${esc(i.address)}·${roleName(i.role)}</span>`
        : `<span class="chip">${esc(t('inv_self_pick', i.domain_name || ''))}</span>`}</td>
      <td><span class="chip ${i.status === 'pending' ? 'chip-ok' : ''}">${esc(stText[i.status] || i.status)}</span></td>
      <td>${i.multi_use ? esc(t('inv_joined', i.joined || 0)) : i.used_by ? esc(i.used_by) : '—'}</td>
      <td class="dim">${fmtDateTime(i.created_at)}</td>
      <td>${i.status === 'pending' ? `<wa-button appearance="plain" size="small" class="danger" data-revoke="${esc(i.id)}">${esc(t('revoke'))}</wa-button>` : ''}</td>
    </tr>`
    )
    .join('');
  body.innerHTML = `
    <section class="card">
      <h3>${esc(t('gen_invite'))}</h3>
      <p class="dim">${esc(t('invite_note'))}</p>
      <form id="f-inv">
        <div class="form-row">
          <label>${esc(t('domain_label'))}</label>
          <wa-select id="inv-domain" value="${esc(firstDomain)}" style="width:260px">${domainOptions}</wa-select>
        </div>
        <div class="form-row">
          <label>${esc(t('inv_kind'))}</label>
          <wa-select id="inv-kind" value="single" style="width:260px">
            <wa-option value="single">${esc(t('inv_kind_single'))}</wa-option>
            <wa-option value="multi">${esc(t('inv_kind_multi'))}</wa-option>
          </wa-select>
          <span class="dim" id="inv-multi-note">${esc(t('inv_multi_note'))}</span>
        </div>
        <div class="form-row" id="row-mode">
          <label>${esc(t('inv_mb_mode'))}</label>
          <wa-select id="inv-mode" value="fixed" style="width:260px">
            <wa-option value="fixed">${esc(t('inv_mode_fixed'))}</wa-option>
            <wa-option value="choose">${esc(t('inv_mode_choose'))}</wa-option>
          </wa-select>
        </div>
        <div class="form-row" id="row-lp">
          <label>${esc(t('th_addr'))}</label>
          <div class="name-pick" style="width:260px">
            <input id="inv-lp" type="text" placeholder="${esc(t('invite_name_ph'))}" autocomplete="off" spellcheck="false">
            <span class="name-suffix" id="inv-suffix">@${esc(domains.find((d) => d.id === firstDomain)?.name || '')}</span>
          </div>
          <span class="dim">${esc(t('inv_lp_note'))}</span>
        </div>
        <div class="form-row" id="row-role">
          <label>${esc(t('role'))}</label>
          <wa-select id="inv-role" value="owner" style="width:260px"><wa-option value="owner">${esc(t('role_owner'))}</wa-option><wa-option value="member">${esc(t('role_member_full'))}</wa-option><wa-option value="readonly">${esc(t('role_readonly'))}</wa-option></wa-select>
        </div>
        <div class="form-row" id="row-email">
          <label>${esc(t('limit_email'))}</label>
          <input id="inv-email" type="email" placeholder="only-this@example.com" style="width:260px">
        </div>
        <div class="form-row">
          <label>${esc(t('validity'))}</label>
          <wa-select id="inv-hours" value="48" style="width:260px"><wa-option value="2">${esc(t('v_2h'))}</wa-option><wa-option value="48">${esc(t('v_48h'))}</wa-option><wa-option value="168">${esc(t('v_7d'))}</wa-option></wa-select>
        </div>
        <div class="form-row">
          <label></label>
          <wa-button variant="brand" type="submit">${esc(t('gen_invite'))}</wa-button>
        </div>
      </form>
    </section>
    <section class="card">
      <h3>${esc(t('records_title'))}</h3>
      <table class="table invites-table">
        <thead><tr><th>${esc(t('th_limit'))}</th><th class="col-grants">${esc(t('th_grants'))}</th><th>${esc(t('th_status'))}</th><th>${esc(t('th_used_by'))}</th><th>${esc(t('th_created'))}</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="dim">${esc(t('no_invites'))}</td></tr>`}</tbody>
      </table>
    </section>`;

  // Domain changed -> update the address suffix
  // 域名变更 → 更新地址后缀
  qs('#inv-domain')?.addEventListener('change', (e) => {
    const d = domains.find((x) => x.id === e.target.value);
    qs('#inv-suffix').textContent = '@' + (d?.name || '');
  });
  // When the mailbox name is not pinned, both the address and the role are decided by the
  // registrant, so those two rows go away. A shared link takes that further: it is for a whole
  // team, so there is no one address, no one role and no one email to restrict it to, and the
  // rows that would ask for them are hidden rather than left to be filled in and refused.
  // 不限定邮箱名时,地址和角色都由注册者决定,这两行藏起来。共享链接更进一步:
  // 它是给一整队人用的,没有唯一的地址、角色和限定邮箱,所以那几行直接不显示,
  // 免得填了再被拒。
  const syncMode = () => {
    const multi = qs('#inv-kind').value === 'multi';
    const choose = multi || qs('#inv-mode').value === 'choose';
    qs('#row-mode').hidden = multi;
    qs('#row-lp').hidden = choose;
    qs('#row-role').hidden = choose;
    qs('#row-email').hidden = multi;
    qs('#inv-multi-note').hidden = !multi;
  };
  qs('#inv-kind')?.addEventListener('change', syncMode);
  qs('#inv-mode')?.addEventListener('change', syncMode);
  syncMode();
  const validityLabel = (h) => (h === 2 ? t('v_2h') : h === 168 ? t('v_7d') : t('v_48h'));
  qs('#f-inv').addEventListener('submit', async (e) => {
    e.preventDefault();
    const multi = qs('#inv-kind').value === 'multi';
    const mode = multi ? 'choose' : qs('#inv-mode').value;
    try {
      const r = await api('POST', '/api/admin/invites', {
        domain_id: qs('#inv-domain').value,
        multi_use: multi,
        mailbox_mode: mode,
        local_part: mode === 'fixed' ? qs('#inv-lp').value.trim() : undefined,
        role: mode === 'fixed' ? qs('#inv-role').value : undefined,
        // A hidden field still holds whatever was typed before the kind was switched; sending
        // it would have the server refuse a link the form no longer claims to restrict
        // 切换类型前填的东西还留在隐藏的输入框里,原样发过去会让服务端
        // 拒绝一条表单已经不再声称要限定的链接
        email: (!multi && qs('#inv-email').value) || null,
        expires_hours: qs('#inv-hours').value,
      });
      const m = showModal(`
        <h3 style="margin:0 0 8px">${esc(t('url_title'))}</h3>
        <p class="dim">${esc(t('url_note', validityLabel(r.expires_hours)))}</p>
        ${r.multi_use ? `<p class="dim">${esc(t('inv_multi_note'))}</p>` : ''}
        <div class="invite-url" id="inv-url">${esc(r.url)}</div>
        <div class="modal-foot">
          <wa-button appearance="plain" id="iv-close">${esc(t('close'))}</wa-button>
          <wa-button variant="brand" id="iv-copy">${icon('copy', 16)} ${esc(t('copy_link'))}</wa-button>
        </div>`);
      m.querySelector('#iv-close').onclick = () => { closeModal(); renderAdmin('invites'); };
      m.querySelector('#iv-copy').onclick = async () => {
        await copyText(r.url);
        toast(t('t_copied'));
      };
    } catch (err) {
      toast(err.message, true);
    }
  });
  body.addEventListener('click', async (e) => {
    const rv = e.target.closest('[data-revoke]');
    if (rv && (await confirmDialog(t('revoke_confirm'), t('revoke')))) {
      await api('DELETE', `/api/admin/invites/${rv.dataset.revoke}`);
      renderAdmin('invites');
    }
  });
}

// ---------- AI assistant (configured per domain: global admins manage every domain, domain admins their own) ----------
// ---------- AI 助手(按域名配置:全局管理员管所有域,域管理员管自己的域) ----------

async function tabAI(body) {
  const { domains } = await api('GET', '/api/admin/domains');
  if (!domains.length) {
    body.innerHTML = `<div class="empty">${esc(t('no_domains'))}</div>`;
    return;
  }
  // Needs the statistics styles from chat.css (with a version query to defeat a stale cache)
  // 需要 chat.css 里的统计样式(带版本号防旧缓存)
  if (!qs('link[href^="/assets/chat/chat.css"]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/assets/chat/chat.css?v=' + encodeURIComponent(store.brand?.version || '');
    document.head.appendChild(l);
  }
  const sel = currentDomainId(domains);
  const domOptions = domains
    .map((d) => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}</option>`)
    .join('');
  body.innerHTML = `
  <section class="card">
    <h3>${esc(t('a_ai'))}</h3>
    <div class="form-row">
      <label>${esc(t('domain_label'))}</label>
      <select id="ai-dom" style="width:260px">${domOptions}</select>
    </div>
    <p class="dim" style="margin:8px 0 0">${esc(t('ai_enable_note'))}</p>
  </section>
  <div id="ai-dom-body"><div class="loading">${esc(t('loading'))}</div></div>`;
  qs('#ai-dom').addEventListener('change', (e) => renderAIDomain(e.target.value));
  await renderAIDomain(sel);
}

async function renderAIDomain(domainId) {
  const box = qs('#ai-dom-body');
  box.innerHTML = `<div class="loading">${esc(t('loading'))}</div>`;
  let data;
  try {
    data = await api('GET', `/api/admin/chat/${domainId}/settings`);
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const st = data.stats;
  const put = async (patch, rerender = false) => {
    try {
      await api('PUT', `/api/admin/chat/${domainId}/settings`, patch);
      toast(t('t_saved'));
      if (rerender) await renderAIDomain(domainId);
    } catch (err) {
      toast(err.message, true);
      await renderAIDomain(domainId); // 失败回读服务器状态
    }
  };
  const capBadges = (m) =>
    `<span class="model-caps">${m.reasoning ? `<span class="cap">${esc(t('c_cap_think'))}</span>` : ''}${m.vision ? `<span class="cap">${esc(t('c_cap_vision'))}</span>` : ''}${m.tools ? `<span class="cap">${esc(t('c_cap_tools'))}</span>` : ''}</span>`;
  const allowedModels = data.models.filter((m) => data.enabled_models.includes(m.id));
  const capSelect = (id, list, value) =>
    `<wa-select id="${id}" value="${esc(value)}" style="width:340px">
      ${list.map((m) => `<wa-option value="${esc(m.id)}">${esc(m.label)}</wa-option>`).join('')}
    </wa-select>`;

  box.innerHTML = `
  <section class="card">
    <div class="form-row">
      <label>${esc(t('ai_enable'))}</label>
      <wa-switch id="ai-enabled" ${data.enabled ? 'checked' : ''}></wa-switch>
      <span class="dim">intl-mail.${esc(data.domain)}</span>
    </div>
  </section>
  <section class="card">
    <h3>${esc(t('ai_models_pick'))}</h3>
    <div class="ai-model-checks">
      ${data.models.map((m) => `
      <label class="ai-mc">
        <input type="checkbox" data-mid="${esc(m.id)}" ${data.enabled_models.includes(m.id) ? 'checked' : ''}>
        <span>${esc(m.label)}</span>${capBadges(m)}
        <span class="mc-desc">${esc(t(m.desc))}</span>
      </label>`).join('')}
    </div>
    <p class="dim" style="margin:10px 0 12px">${esc(t('ai_models_note'))}</p>
    <div class="form-row">
      <label>${esc(t('ai_default_model'))}</label>
      ${capSelect('ai-model', allowedModels, data.default_model)}
    </div>
  </section>
  <section class="card">
    <h3>${esc(t('ai_cap_models'))}</h3>
    <div class="form-row">
      <label>${esc(t('ai_vision_default'))}</label>
      ${capSelect('ai-vision', data.vision_models, data.vision_model)}
    </div>
    <p class="dim" style="margin:2px 0 10px">${esc(t('ai_vision_note'))}</p>
    <div class="form-row">
      <label>${esc(t('ai_asr_default'))}</label>
      ${capSelect('ai-asr', data.asr_models, data.asr_model)}
    </div>
    <div class="form-row">
      <label>${esc(t('ai_tts_default'))}</label>
      ${capSelect('ai-tts', data.tts_models, data.tts_model)}
    </div>
    <div class="form-row">
      <label>${esc(t('ai_image_default'))}</label>
      ${capSelect('ai-image', data.image_models, data.image_model)}
    </div>
  </section>
  <section class="card">
    <h3>${esc(t('ai_web'))}</h3>
    <div class="form-row">
      <label>${esc(t('ai_web_enable'))}</label>
      <wa-switch id="ai-web" ${data.web_search ? 'checked' : ''}></wa-switch>
    </div>
    <p class="dim" style="margin:6px 0 10px">${esc(t('ai_web_note'))}</p>
    <div class="form-row">
      <label>${esc(t('ai_search_key'))}</label>
      <input id="ai-key" type="password" autocomplete="new-password" style="width:340px"
        placeholder="${esc(data.has_search_key ? t('ai_key_set') : t('ai_key_ph'))}">
      <wa-button id="ai-key-save">${esc(t('save'))}</wa-button>
    </div>
    <p class="dim" style="margin:6px 0 0">${esc(t('ai_search_key_note'))}</p>
  </section>
  ${st ? `
  <section class="card">
    <h3>${esc(t('ai_stats'))}</h3>
    <div class="ai-stats">
      <div class="stat"><b>${st.users || 0}</b><span>${esc(t('ai_stat_users'))}</span></div>
      <div class="stat"><b>${st.sessions || 0}</b><span>${esc(t('ai_stat_sessions'))}</span></div>
      <div class="stat"><b>${st.messages || 0}</b><span>${esc(t('ai_stat_msgs'))}</span></div>
      <div class="stat"><b>${st.files || 0}</b><span>${esc(t('ai_stat_files'))}</span></div>
      <div class="stat"><b>${fmtSize(st.file_bytes || 0)}</b><span>${esc(t('ai_stat_bytes'))}</span></div>
    </div>
  </section>` : ''}`;

  qs('#ai-enabled').addEventListener('change', async (e) => {
    await put({ enabled: !!e.target.checked });
    // The top-bar entry only changes immediately when the domain being edited is the one being visited; other domains take effect on the next visit
    // 只有改的是当前访问域名时,顶栏入口才会即时变化;其余域下次访问生效
    await refreshMe();
  });
  // The checkbox list submits the complete array on any change; when the default model is removed the server switches automatically, and the redraw picks that up
  // 勾选清单:任一变化就提交完整数组;默认模型被移出时服务端自动切换,重绘同步
  box.querySelectorAll('.ai-mc input').forEach((cb) => {
    cb.addEventListener('change', () => {
      const ids = [...box.querySelectorAll('.ai-mc input:checked')].map((x) => x.dataset.mid);
      if (!ids.length) {
        cb.checked = true;
        toast(t('ai_models_note'), true);
        return;
      }
      put({ models: ids }, true);
    });
  });
  qs('#ai-model').addEventListener('change', (e) => put({ default_model: e.target.value }));
  qs('#ai-vision').addEventListener('change', (e) => put({ vision_model: e.target.value }));
  qs('#ai-asr').addEventListener('change', (e) => put({ asr_model: e.target.value }));
  qs('#ai-tts').addEventListener('change', (e) => put({ tts_model: e.target.value }));
  qs('#ai-image').addEventListener('change', (e) => put({ image_model: e.target.value }));
  qs('#ai-web').addEventListener('change', (e) => put({ web_search: e.target.checked }, true));
  qs('#ai-key-save').addEventListener('click', () => put({ search_key: qs('#ai-key').value.trim() }, true));
}

// ---------- Erase / delete a mailbox ----------
// ---------- 清空 / 注销邮箱 ----------

/** Erasing runs in batches (the server deletes 300 at a time), so loop here until remaining reaches zero
 *  清空是分批的(服务端一次删 300 封),这里循环调用直到 remaining 归零 */
async function purgeMailbox(id, name, done) {
  if (!(await confirmDialog(t('mb_purge_confirm', name), t('mb_purge')))) return;
  const box = qs('#dom-detail');
  const bar = document.createElement('div');
  bar.className = 'card';
  bar.innerHTML = `<div class="imp-bar"><div class="imp-bar-fill" id="pg-fill" style="width:0%"></div></div>
    <div class="imp-status"><span id="pg-txt">${esc(t('mb_purging', name))}</span></div>`;
  box.prepend(bar);
  let deleted = 0;
  let first = -1;
  try {
    for (;;) {
      const r = await api('POST', `/api/admin/mailboxes/${id}/purge`);
      deleted += r.deleted;
      if (first < 0) first = deleted + r.remaining; // 首轮才知道总量
      const pct = first > 0 ? ((deleted / first) * 100).toFixed(0) : 100;
      qs('#pg-fill').style.width = pct + '%';
      qs('#pg-txt').textContent = t('mb_purge_prog', deleted, first);
      if (!r.remaining) break;
    }
    toast(t('mb_purge_done', deleted));
  } catch (e) {
    toast(e.message, true);
  }
  bar.remove();
  done?.();
}

/** Delete: erase first, then take the structure apart; optionally remove the mailbox owner's account along with it
 *  注销:先清空,再拆结构;可选连同该邮箱的所有者账号一起注销 */
async function dropMailbox(id, name, done) {
  if (!(await confirmDialog(t('mb_drop_confirm', name), t('mb_drop')))) return;
  const withUser = await confirmDialog(t('mb_drop_user_ask', name), t('mb_drop_user_yes'));
  try {
    // The server refuses to delete until the contents are gone, so run a full erase first
    // 服务端要求内容已清空才允许注销,所以先跑一轮清空
    for (;;) {
      const r = await api('POST', `/api/admin/mailboxes/${id}/purge`);
      if (!r.remaining) break;
    }
    const r = await api('DELETE', `/api/admin/mailboxes/${id}${withUser ? '?with_user=1' : ''}`);
    toast(r.removed_users?.length ? t('mb_drop_done_user', name, r.removed_users.join(', ')) : t('mb_drop_done', name));
  } catch (e) {
    toast(e.message, true);
  }
  done?.();
}

// ---------- Audit log ----------
// ---------- 审计日志 ----------

async function tabAudit(body) {
  let page = 0;
  let days = 90;

  async function render() {
    body.innerHTML = `<div class="loading">${esc(t('loading'))}</div>`;
    const d = await api('GET', `/api/admin/audit?page=${page}&days=${days}`);
    const rows = d.items
      .map(
        (r) => `
      <tr>
        <td class="nowrap">${esc(fmtDateTime(r.at))}</td>
        <td>${esc(r.actor_email || '—')}</td>
        <td>${esc(r.domain_name || '—')}</td>
        <td><code>${esc(r.action)}</code></td>
        <td>${esc(r.target || '')}</td>
        <td class="dim" style="font-size:12px">${esc(r.detail || '')}</td>
      </tr>`
      )
      .join('');
    body.innerHTML = `
      <section class="card">
        <h3>${esc(t('au_title'))}</h3>
        <p class="dim">${esc(t('au_note'))}</p>
        <div class="form-row">
          <label>${esc(t('au_range'))}</label>
          <select id="au-days" style="width:180px">
            <option value="7" ${days === 7 ? 'selected' : ''}>${esc(t('au_d7'))}</option>
            <option value="30" ${days === 30 ? 'selected' : ''}>${esc(t('au_d30'))}</option>
            <option value="90" ${days === 90 ? 'selected' : ''}>${esc(t('au_d90'))}</option>
            <option value="0" ${days === 0 ? 'selected' : ''}>${esc(t('au_all'))}</option>
          </select>
          <span class="flex1"></span>
          <wa-button appearance="outlined" size="small" id="au-csv">${icon('download', 16)} CSV</wa-button>
          <wa-button appearance="outlined" size="small" id="au-jsonl">${icon('download', 16)} JSONL</wa-button>
        </div>
        <table class="table">
          <thead><tr>
            <th>${esc(t('au_th_time'))}</th><th>${esc(t('au_th_actor'))}</th><th>${esc(t('au_th_domain'))}</th>
            <th>${esc(t('au_th_action'))}</th><th>${esc(t('au_th_target'))}</th><th>${esc(t('au_th_detail'))}</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="6" class="dim">${esc(t('au_empty'))}</td></tr>`}</tbody>
        </table>
        <div class="imp-status" style="margin-top:10px">
          <span class="dim">${esc(t('page_n', page + 1, d.pages || 1))}</span>
          <span class="flex1"></span>
          <wa-button appearance="outlined" size="small" id="au-prev" ${page === 0 ? 'disabled' : ''}>${icon('back', 16)}</wa-button>
          <wa-button appearance="outlined" size="small" id="au-next" ${d.has_more ? '' : 'disabled'}>${icon('next', 16)}</wa-button>
        </div>
      </section>`;
    qs('#au-days').addEventListener('change', (e) => { days = parseInt(e.target.value, 10); page = 0; render(); });
    qs('#au-prev').addEventListener('click', () => { if (page > 0) { page--; render(); } });
    qs('#au-next').addEventListener('click', () => { if (d.has_more) { page++; render(); } });
    // Downloading uses plain browser navigation -- the server already sends Content-Disposition: attachment
    // 下载走浏览器原生导航,服务端已带 Content-Disposition: attachment
    const dl = (fmt) => {
      const a = document.createElement('a');
      a.href = `/api/admin/audit/export?format=${fmt}&days=${days}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    qs('#au-csv').addEventListener('click', () => dl('csv'));
    qs('#au-jsonl').addEventListener('click', () => dl('jsonl'));
  }
  await render();
}

// ---------- Drive (per-domain switch, default quota, per-user quota) ----------
// ---------- 网盘。按域名开关与默认配额。可单独调整用户配额 ----------

async function tabDrive(body) {
  const data = await api('GET', '/api/admin/drive/domains');
  const domains = data.domains || [];
  if (!domains.length) {
    body.innerHTML = `<div class="empty">${esc(t('no_domains'))}</div>`;
    return;
  }
  const cap = data.hard_cap_mb || 10240;
  const sel = currentDomainId(domains);
  const domOptions = domains
    .map((d) => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}</option>`)
    .join('');
  body.innerHTML = `
  <section class="card">
    <h3>${esc(t('a_drive'))}</h3>
    <div class="form-row">
      <label>${esc(t('domain_label'))}</label>
      <select id="drv-dom" style="width:260px">${domOptions}</select>
    </div>
    <p class="dim" style="margin:8px 0 0">${esc(t('drv_a_enable_note'))}</p>
  </section>
  <div id="drv-dom-body"></div>
  <section class="card">
    <h3>${esc(t('drv_a_users'))}</h3>
    <div class="form-row">
      <input id="drv-uq" type="search" placeholder="${esc(t('drv_a_search_user'))}" style="width:280px">
    </div>
    <div id="drv-users"><div class="loading">${esc(t('loading'))}</div></div>
  </section>`;

  const paintDomain = () => {
    const d = domains.find((x) => x.id === qs('#drv-dom').value) || domains[0];
    qs('#drv-dom-body').innerHTML = `
    <section class="card">
      <div class="form-row">
        <label>${esc(t('drv_a_enable'))}</label>
        <wa-switch id="drv-enabled" ${d.drive_enabled ? 'checked' : ''}></wa-switch>
        <span class="dim">${esc(d.name)}</span>
      </div>
      <div class="form-row">
        <label>${esc(t('drv_a_default_quota'))}</label>
        <input id="drv-quota" type="number" min="1" max="${cap}" value="${d.drive_quota_mb}" style="width:120px"> MB
        <wa-button id="drv-quota-save" size="small">${esc(t('save'))}</wa-button>
        <span class="dim">${esc(t('drv_a_quota_cap', fmtSize(cap * 1024 * 1024)))}</span>
      </div>
      <div class="form-row">
        <label>${esc(t('drv_a_share_owner'))}</label>
        <wa-switch id="drv-show-owner" ${d.drive_share_show_owner ? 'checked' : ''}></wa-switch>
        <span class="dim">${esc(t('drv_a_share_owner_note'))}</span>
      </div>
    </section>`;
    // wa-switch dispatches a plain 'change' -- there is no 'wa-change'. Listening for the wrong
    // name left the toggle flipping visually while nothing was ever saved.
    // wa-switch 派发的是普通的 'change',没有 'wa-change'。监听错名字会让开关看着翻转了、
    // 实际什么都没保存。
    qs('#drv-enabled').addEventListener('change', async (e) => {
      try {
        await api('POST', `/api/admin/drive/domains/${d.id}`, { enabled: !!e.target.checked });
        d.drive_enabled = e.target.checked ? 1 : 0;
        toast(t('t_saved'));
        // The top-bar entry only changes immediately when the domain being edited is the one
        // being visited; other domains take effect on the next visit.
        // 只有改的是当前访问域名时,顶栏入口才会即时出现;其余域下次访问生效。
        await refreshMe();
        loadUsers();
      } catch (err) {
        toast(err.message, true);
        paintDomain();
      }
    });
    qs('#drv-show-owner').addEventListener('change', async (e) => {
      try {
        await api('POST', `/api/admin/drive/domains/${d.id}`, { share_show_owner: !!e.target.checked });
        d.drive_share_show_owner = e.target.checked ? 1 : 0;
        toast(t('t_saved'));
      } catch (err) {
        toast(err.message, true);
        paintDomain();
      }
    });
    qs('#drv-quota-save').addEventListener('click', async () => {
      const v = parseInt(qs('#drv-quota').value, 10);
      try {
        await api('POST', `/api/admin/drive/domains/${d.id}`, { quota_mb: v });
        d.drive_quota_mb = v;
        toast(t('t_saved'));
        loadUsers();
      } catch (err) {
        toast(err.message, true);
      }
    });
  };

  const fmtMb = (mb) => fmtSize((mb || 0) * 1024 * 1024);
  const loadUsers = async () => {
    const box = qs('#drv-users');
    if (!box) return;
    const q = qs('#drv-uq')?.value.trim() || '';
    try {
      const r = await api('GET', `/api/admin/drive/users${q ? '?q=' + encodeURIComponent(q) : ''}`);
      const rows = (r.users || []).map((u) => `
        <tr>
          <td><b>${esc(u.name || u.email)}</b><div class="dim" style="font-size:12px">${esc(u.email)}</div></td>
          <td>${u.enabled ? fmtSize(u.used) : `<span class="dim">${fmtSize(u.used)}</span>`}</td>
          <td>${u.files}</td>
          <td>${u.enabled
            ? (u.quota_mb != null
              ? `${fmtMb(u.effective_mb)} <span class="chip">${esc(t('drv_a_quota_custom'))}</span>`
              : esc(t('drv_a_quota_default', fmtMb(u.effective_mb))))
            : `<span class="chip chip-warn">${esc(t('drv_a_disabled_chip'))}</span>`}</td>
          <td><wa-button size="small" appearance="outlined" data-uid="${esc(u.id)}" data-uname="${esc(u.name || u.email)}" data-umb="${u.quota_mb ?? ''}">${esc(t('drv_a_set_quota'))}</wa-button></td>
        </tr>`).join('');
      box.innerHTML = `
      <table class="table">
        <thead><tr><th>${esc(t('drv_a_th_user'))}</th><th>${esc(t('drv_a_th_used'))}</th><th>${esc(t('drv_a_th_files'))}</th><th>${esc(t('drv_a_th_quota'))}</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="dim">—</td></tr>`}</tbody>
      </table>`;
      qsa('[data-uid]', box).forEach((b) => b.addEventListener('click', () => quotaDialog(b.dataset)));
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  };

  const quotaDialog = (ds) => {
    const d = showModal(`
      <div class="modal-body">
        <h3 style="margin:0 0 14px">${esc(t('drv_a_quota_title', ds.uname))}</h3>
        <div class="form-row">
          <label>${esc(t('drv_a_th_quota'))}</label>
          <input id="drv-user-quota" type="number" min="1" max="${cap}" value="${esc(ds.umb || '')}" placeholder="${esc(t('drv_a_quota_default', ''))}" style="width:130px"> MB
        </div>
        <p class="dim" style="margin:8px 0 0;font-size:12.5px">${esc(t('drv_a_quota_cap', fmtSize(cap * 1024 * 1024)))}</p>
      </div>
      <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
        <wa-button appearance="plain" data-x="clear">${esc(t('drv_a_quota_clear'))}</wa-button>
        <wa-button appearance="plain" data-x="cancel">${esc(t('cancel'))}</wa-button>
        <wa-button variant="brand" data-x="ok">${esc(t('save'))}</wa-button>
      </div>`);
    d.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      const x = b.dataset.x;
      if (x === 'cancel') {
        closeModal();
        return;
      }
      const v = x === 'clear' ? null : parseInt(qs('#drv-user-quota', d).value, 10);
      try {
        await api('POST', `/api/admin/drive/users/${ds.uid}`, { quota_mb: v });
        closeModal();
        toast(t('t_saved'));
        loadUsers();
      } catch (err) {
        toast(err.message, true);
      }
    });
  };

  qs('#drv-dom').addEventListener('change', paintDomain);
  let qtimer = null;
  qs('#drv-uq').addEventListener('input', () => {
    clearTimeout(qtimer);
    qtimer = setTimeout(loadUsers, 300);
  });
  paintDomain();
  await loadUsers();
}
