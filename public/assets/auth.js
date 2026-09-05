import { api } from './api.js';
import { esc, icon, qs, toast } from './ui.js';
import { t, setLang, lang, LANG_OPTIONS, dictReady } from './i18n.js';
import { store, navigate, refreshMe, show, applyMode, currentMode, setTitle, applyFonts } from './app.js';
import { pickFont } from './fontpicker.js';
import { mountTurnstile } from './turnstile.js';

/**
 * Human verification shared by sign-in, reset and invite signup. It renders only when brand carries a
 * sitekey (otherwise the container stays hidden).
 * The resolved {token,reset} handle is stashed in a closure variable; if mounting fails (a blocked
 * script, say) it stays null, in which case the server rejects the submission and the frontend does
 * not try to second-guess it.
 * 登录/重置/邀请注册共用的人机验证。brand 里有 sitekey 才渲染(否则容器保持隐藏)。
 * 返回句柄 {token,reset} 的 Promise 结果放进闭包变量;挂载失败(脚本被墙等)返回 null,
 * 此时提交会被服务端拒,前端不做二次拦截。
 */
function mountCaptcha(sel, setter) {
  const sitekey = store.brand?.turnstile;
  const el = qs(sel);
  if (!sitekey || !el) return;
  el.style.display = '';
  const mode = currentMode();
  mountTurnstile(el, sitekey, { theme: mode === 'auto' ? 'auto' : mode, lang: lang() })
    .then(setter)
    .catch(() => {});
}

/** Verification enabled but no token yet -> return the prompt text; ready to submit -> write the token into the payload and return an empty string
 *  启用了人机验证但 token 还没拿到 → 返回提示文案;可以提交 → 把 token 写进 payload 并返回空串 */
function captchaGate(cap, payload) {
  if (!store.brand?.turnstile) return '';
  const tk = cap ? cap.token() : '';
  if (!tk) return t('captcha_wait');
  payload.turnstile_token = tk;
  return '';
}

function brandBits() {
  const b = store.brand || {};
  const logo = b.logo_url
    ? `<img class="brand-logo auth-brand-logo" data-logo-mode="${esc(b.logo_mode || 'light')}" src="${esc(b.logo_url)}" alt="" style="height:34px">`
    : icon('mail', 34);
  return { logo, name: b.name || 'CFMail' };
}

function authCard(inner) {
  const { logo, name } = brandBits();
  return `
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-logo">${logo}<span>${esc(name)}</span></div>
      ${inner}
    </div>
    <div class="auth-foot">${esc(store.brand?.name ? `${store.brand.name} · Powered by CFMail` : t('powered'))}</div>
  </div>`;
}

export function renderLogin() {
  show(
    authCard(`
    <h2>${esc(t('login'))}</h2>
    <p class="auth-sub">${esc(t('login_sub'))}</p>
    <form id="f-login" class="auth-form">
      <input name="email" type="text" placeholder="${esc(t('login_id_ph'))}" required autocomplete="username">
      <input name="password" type="password" placeholder="${esc(t('password'))}" required autocomplete="current-password">
      <div class="ts-box" id="ts-login" style="display:none"></div>
      <div class="auth-err" id="login-err"></div>
      <wa-button variant="brand" type="submit" style="width:100%">${esc(t('login'))}</wa-button>
      <p class="auth-sub" style="margin-top:10px;text-align:center"><a href="#/forgot">${esc(t('forgot_pw'))}</a></p>
    </form>`)
  );
  let cap = null;
  mountCaptcha('#ts-login', (h) => (cap = h));
  qs('#f-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { email: fd.get('email'), password: fd.get('password') };
    const wait = captchaGate(cap, payload);
    if (wait) { qs('#login-err').textContent = wait; return; }
    try {
      await api('POST', '/api/auth/login', payload);
      await refreshMe();
      // A page that sent the visitor here to sign in (an internal form's fill page) gets them
      // back. Read once and cleared, so a stale note cannot redirect a later, unrelated sign-in.
      // 把访问者送来登录的那一页(内部表单的填写页)把他接回去。读一次即清,
      // 免得一条过期的记录把之后某次无关的登录也带偏。
      let back = '';
      try { back = sessionStorage.getItem('cf_after_login') || ''; sessionStorage.removeItem('cf_after_login'); } catch {}
      // Two kinds of page send people here: a form's fill page, and the link in an answer's
      // mail to a kept answer. Anything else goes to the inbox.
      // 两种页面会把人送来登录:表单的填写页,以及答复邮件里指向保留答复的链接。其余都回收件箱。
      navigate(/^#\/(f|forms\/sub)\//.test(back) ? back : '#/');
    } catch (err) {
      cap?.reset();
      qs('#login-err').textContent = err.message;
    }
  });
}

export function renderSetup() {
  show(
    authCard(`
    <h2>${esc(t('init_title'))}</h2>
    <p class="auth-sub">${esc(t('init_sub'))}</p>
    <form id="f-setup" class="auth-form">
      <input name="email" type="email" placeholder="${esc(t('admin_email'))}" required>
      <input name="name" type="text" placeholder="${esc(t('name_ph'))}">
      <input name="password" type="password" placeholder="${esc(t('pw_min'))}" required minlength="8" autocomplete="new-password">
      <div class="auth-err" id="setup-err"></div>
      <wa-button variant="brand" type="submit" style="width:100%">${esc(t('create_login'))}</wa-button>
    </form>`)
  );
  qs('#f-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/api/bootstrap', { email: fd.get('email'), name: fd.get('name'), password: fd.get('password') });
      await refreshMe();
      navigate('#/');
    } catch (err) {
      qs('#setup-err').textContent = err.message;
    }
  });
}

export async function renderInvite(token) {
  show(authCard(`<div class="loading">${esc(t('invite_loading'))}</div>`));
  let info;
  try {
    info = await api('GET', `/api/invites/${encodeURIComponent(token)}`);
  } catch (e) {
    show(authCard(`<h2>${esc(t('invite_invalid'))}</h2><p class="auth-sub">${esc(e.message)}</p><wa-button variant="brand" href="#/login" style="width:100%">${esc(t('go_login'))}</wa-button>`));
    return;
  }
  const choose = info.mailbox_mode === 'choose';
  // Pinned: show the address that will be created. Open: let the person pick a name under the given domain.
  // 限定:直接展示将要开通的地址;不限定:让本人在指定域名下取名
  const offer = choose
    ? `<p class="auth-sub">${esc(t('invite_pick_on', info.domain || ''))}</p>`
    : `<div class="invite-boxes"><span class="chip">${esc(info.address || '')}</span>
         <span class="chip">${esc(roleName(info.role))}</span></div>`;

  /** Name field plus live availability check; returns whether submitting is currently allowed
   *  取名输入框 + 实时查重,返回当前是否可提交 */
  const nameField = (value = '') => `
    <div class="name-pick">
      <input name="mailbox_name" type="text" placeholder="${esc(t('invite_name_ph'))}" value="${esc(value)}"
             autocomplete="off" spellcheck="false" required>
      <span class="name-suffix">@${esc(info.domain || '')}</span>
    </div>
    <div class="name-hint" id="name-hint"></div>`;

  function bindNameCheck() {
    const input = qs('input[name="mailbox_name"]');
    const hint = qs('#name-hint');
    if (!input || !hint) return;
    let timer = null, seq = 0;
    const run = async () => {
      const v = input.value.trim().toLowerCase();
      if (!v) { hint.textContent = ''; hint.className = 'name-hint'; return; }
      const my = ++seq;
      try {
        const r = await api('GET', `/api/invites/${encodeURIComponent(token)}/check?name=${encodeURIComponent(v)}`);
        if (my !== seq) return;
        hint.textContent = r.ok ? t('name_available') : r.reason === 'format' ? t('name_bad_format') : t('name_taken');
        hint.className = 'name-hint ' + (r.ok ? 'ok' : 'bad');
      } catch { /* 网络问题就不打扰,提交时后端还会再校验一次 */ }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  }

  if (info.logged_in_as) {
    show(
      authCard(`
      <h2>${esc(t('accept_invite'))}</h2>
      <p class="auth-sub">${esc(t('invite_from', info.inviter))}</p>
      ${offer}
      <form id="f-accept" class="auth-form">
        ${choose ? nameField() : ''}
        <p class="auth-sub">${esc(t('cur_login'))}<b>${esc(info.logged_in_as)}</b></p>
        <div class="auth-err" id="inv-err"></div>
        <wa-button variant="brand" type="submit" style="width:100%">${esc(t('bind_account'))}</wa-button>
      </form>`)
    );
    bindNameCheck();
    qs('#f-accept').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, { mailbox_name: fd.get('mailbox_name') });
        toast(t('t_bound'));
        await refreshMe();
        navigate('#/');
      } catch (err) {
        qs('#inv-err').textContent = err.message;
      }
    });
    return;
  }

  // Step one: fill in the details, then mail a code
  // 第一步:填资料 → 发验证码
  const renderStep1 = (prefill = {}) => {
    show(
      authCard(`
      <h2>${esc(t('accept_invite'))}</h2>
      <p class="auth-sub">${esc(t('invite_from', info.inviter))}</p>
      ${offer}
      <form id="f-inv" class="auth-form">
        ${choose ? nameField(prefill.mailbox_name || '') : ''}
        <input name="email" type="email" placeholder="${esc(t('your_email'))}" value="${esc(info.email || prefill.email || '')}" ${info.email ? 'readonly' : ''} required>
        <input name="name" type="text" placeholder="${esc(t('name_ph'))}" value="${esc(prefill.name || '')}">
        <input name="password" type="password" placeholder="${esc(t('set_pw'))}" required minlength="8" autocomplete="new-password">
        <div class="ts-box" id="ts-inv" style="display:none"></div>
        <div class="auth-err" id="inv-err"></div>
        <wa-button variant="brand" type="submit" id="inv-submit" style="width:100%">${esc(t('get_code'))}</wa-button>
        <p class="auth-sub" style="margin-top:10px">${esc(t('has_account'))}<a href="#/login">${esc(t('login_first'))}</a>${esc(t('reopen_link'))}</p>
      </form>`)
    );
    bindNameCheck();
    let cap = null;
    mountCaptcha('#ts-inv', (h) => (cap = h));
    qs('#f-inv').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        email: fd.get('email'), name: fd.get('name'), password: fd.get('password'),
        mailbox_name: fd.get('mailbox_name') || undefined, lang: lang(),
      };
      const wait = captchaGate(cap, payload);
      if (wait) { qs('#inv-err').textContent = wait; return; }
      const btn = qs('#inv-submit');
      btn.loading = true;
      qs('#inv-err').textContent = '';
      try {
        const r = await api('POST', `/api/invites/${encodeURIComponent(token)}/register`, payload);
        renderStep2(r, payload);
      } catch (err) {
        btn.loading = false;
        cap?.reset();
        qs('#inv-err').textContent = err.message;
      }
    });
  };

  // Step two: enter the code, then create the account
  // 第二步:输入验证码 → 建账号
  const renderStep2 = (reg, prev) => {
    show(
      authCard(`
      <h2>${esc(t('verify_title'))}</h2>
      <p class="auth-sub">${esc(t('verify_sent', reg.email))}</p>
      ${reg.dev_code ? `<p class="auth-sub"><b>dev code: ${esc(reg.dev_code)}</b></p>` : ''}
      <form id="f-code" class="auth-form">
        <input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
               placeholder="${esc(t('code_ph'))}" required style="letter-spacing:.3em;text-align:center;font-size:18px">
        <div class="auth-err" id="code-err"></div>
        <wa-button variant="brand" type="submit" id="code-submit" style="width:100%">${esc(t('verify_btn'))}</wa-button>
      </form>
      <p class="auth-sub" style="margin-top:12px">${esc(t('code_expires', reg.expires_min))}</p>
      <div class="ts-box" id="ts-inv2" style="display:none;margin-top:6px"></div>
      <div class="row-flex" style="justify-content:space-between;margin-top:6px">
        <wa-button appearance="plain" size="small" id="btn-back-edit">${esc(t('back_edit'))}</wa-button>
        <wa-button appearance="plain" size="small" id="btn-resend">${esc(t('resend'))}</wa-button>
      </div>`)
    );
    // Resending a code also goes through the register endpoint, and tokens are single-use, so this step needs a widget of its own
    // 重发验证码也会走 register 接口,token 一次性,所以这一步也要有自己的 widget
    let cap2 = null;
    mountCaptcha('#ts-inv2', (h) => (cap2 = h));
    qs('#f-code').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = new FormData(e.target).get('code');
      const btn = qs('#code-submit');
      btn.loading = true;
      qs('#code-err').textContent = '';
      try {
        await api('POST', `/api/invites/${encodeURIComponent(token)}/verify`, { reg_id: reg.reg_id, code });
        await refreshMe();
        toast(t('t_welcome'));
        navigate('#/');
      } catch (err) {
        btn.loading = false;
        qs('#code-err').textContent = err.message;
      }
    });
    qs('#btn-back-edit').addEventListener('click', () => renderStep1(prev));
    qs('#btn-resend').addEventListener('click', async () => {
      const payload = { ...prev };            // prev 里的 turnstile_token 已被消费,换新的
      const wait = captchaGate(cap2, payload);
      if (wait) { qs('#code-err').textContent = wait; return; }
      const btn = qs('#btn-resend');
      btn.loading = true;
      try {
        const r = await api('POST', `/api/invites/${encodeURIComponent(token)}/register`, payload);
        renderStep2(r, prev);
        toast(t('verify_sent', r.email));
      } catch (err) {
        btn.loading = false;
        cap2?.reset();
        qs('#code-err').textContent = err.message;
      }
    });
  };

  renderStep1();
}

/** Forgot password: the identifier works like sign-in, but the link only ever goes to the signup address
 *  忘记密码:标识符和登录一样,但链接只发到注册邮箱 */
export function renderForgot() {
  show(
    authCard(`
    <h2>${esc(t('reset_title'))}</h2>
    <p class="auth-sub">${esc(t('reset_sub'))}</p>
    <form id="f-forgot" class="auth-form">
      <input name="email" type="text" placeholder="${esc(t('login_id_ph'))}" required autocomplete="username">
      <div class="ts-box" id="ts-forgot" style="display:none"></div>
      <div class="auth-err" id="fg-err"></div>
      <wa-button variant="brand" type="submit" id="fg-submit" style="width:100%">${esc(t('send_reset'))}</wa-button>
      <p class="auth-sub" style="margin-top:10px;text-align:center"><a href="#/login">${esc(t('back_to_login'))}</a></p>
    </form>`)
  );
  let cap = null;
  mountCaptcha('#ts-forgot', (h) => (cap = h));
  qs('#f-forgot').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = { email: new FormData(e.target).get('email') };
    const wait = captchaGate(cap, payload);
    if (wait) { qs('#fg-err').textContent = wait; return; }
    const btn = qs('#fg-submit');
    btn.loading = true;
    try {
      await api('POST', '/api/auth/reset/request', payload);
      // Always show the same "if the account exists, a link has been sent" line, so nothing reveals whether it does
      // 一律展示同一句"若账号存在,链接已发到注册邮箱",不暴露账号是否存在
      show(
        authCard(`
        <h2>${esc(t('reset_title'))}</h2>
        <p class="auth-sub">${esc(t('reset_sent_generic'))}</p>
        <wa-button variant="brand" href="#/login" style="width:100%">${esc(t('back_to_login'))}</wa-button>`)
      );
    } catch (err) {
      btn.loading = false;
      cap?.reset();
      qs('#fg-err').textContent = err.message;
    }
  });
}

/** Arriving from the link in the mail: set a new password
 *  点邮件里的链接进来,设置新密码 */
export async function renderReset(token) {
  show(authCard(`<div class="loading">${esc(t('invite_loading'))}</div>`));
  let info;
  try {
    info = await api('GET', `/api/auth/reset/${encodeURIComponent(token)}`);
  } catch (e) {
    show(
      authCard(`<h2>${esc(t('reset_link_bad'))}</h2><p class="auth-sub">${esc(e.message)}</p>
      <wa-button variant="brand" href="#/forgot" style="width:100%">${esc(t('send_reset'))}</wa-button>`)
    );
    return;
  }
  show(
    authCard(`
    <h2>${esc(t('reset_new_pw'))}</h2>
    <p class="auth-sub">${esc(info.email)}</p>
    <form id="f-reset" class="auth-form">
      <input name="password" type="password" placeholder="${esc(t('set_pw'))}" required minlength="8" autocomplete="new-password">
      <div class="auth-err" id="rs-err"></div>
      <wa-button variant="brand" type="submit" id="rs-submit" style="width:100%">${esc(t('reset_new_pw'))}</wa-button>
    </form>`)
  );
  qs('#f-reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = qs('#rs-submit');
    btn.loading = true;
    qs('#rs-err').textContent = '';
    try {
      await api('POST', '/api/auth/reset/confirm', { token, password: new FormData(e.target).get('password') });
      toast(t('reset_done'));
      navigate('#/login');
    } catch (err) {
      btn.loading = false;
      qs('#rs-err').textContent = err.message;
    }
  });
}

export function renderNoMailbox() {
  const me = store.me;
  show(
    authCard(`
    <h2>${esc(t('no_mailbox'))}</h2>
    <p class="auth-sub">${esc(t('cur_login'))}${esc(me.user.email)}</p>
    <p class="auth-sub">${esc(t('contact_admin'))}</p>
    ${me.user.is_admin ? `<wa-button variant="brand" href="#/admin" style="width:100%">${esc(t('enter_admin'))}</wa-button>` : ''}
    <wa-button appearance="plain" id="btn-logout2" style="width:100%">${esc(t('logout'))}</wa-button>`)
  );
  qs('#btn-logout2')?.addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    store.me = null;
    navigate('#/login');
  });
}

export function renderSettings() {
  const me = store.me;
  setTitle(t('settings'));
  const langOptions = LANG_OPTIONS.map(
    ([code, label]) => `<wa-option value="${code}">${esc(label)}</wa-option>`
  ).join('');
  show(`
  <div class="page">
    <header class="page-head">
      <wa-button class="icon" appearance="plain" onclick="history.back()">${icon('back', 20)}</wa-button>
      <h1>${esc(t('settings'))}</h1>
    </header>
    <div class="page-body">
      <section class="card">
        <h3>${esc(t('profile'))}</h3>
        <div class="form-row"><label>${esc(t('login_email'))}</label><span>${esc(me.user.email)}</span></div>
        <form id="f-profile" class="form-row">
          <label>${esc(t('display_name'))}</label>
          <input name="name" type="text" value="${esc(me.user.name)}" style="width:260px">
          <wa-button variant="brand" type="submit">${esc(t('save'))}</wa-button>
        </form>
        <div class="form-row">
          <label>${esc(t('language'))}</label>
          <wa-select id="sel-lang" value="${esc(lang())}" style="width:260px">${langOptions}</wa-select>
        </div>
      </section>
      <section class="card">
        <h3>${esc(t('appearance'))}</h3>
        <div class="form-row">
          <label>${esc(t('mode'))}</label>
          <wa-select id="sel-mode" value="${esc(currentMode())}" style="width:260px">
            <wa-option value="auto">${esc(t('mode_auto'))}</wa-option>
            <wa-option value="light">${esc(t('mode_light'))}</wa-option>
            <wa-option value="dark">${esc(t('mode_dark'))}</wa-option>
          </wa-select>
        </div>
        <p class="dim" style="margin:10px 0 0">${esc(t('theme_by_admin'))}</p>
      </section>
      <section class="card">
        <h3>${esc(t('fonts_title'))}</h3>
        <div class="form-row">
          <label>${esc(t('ui_font'))}</label>
          <wa-button class="font-btn" appearance="outlined" id="btn-ui-font">
            <span class="fb-label" style="font-family:${me.user.ui_font ? `'${esc(me.user.ui_font)}',` : ''}var(--font-ui)">${esc(me.user.ui_font || t('font_default'))}</span>
          </wa-button>
        </div>
        <div class="form-row">
          <label>${esc(t('body_font'))}</label>
          <wa-button class="font-btn" appearance="outlined" id="btn-body-font">
            <span class="fb-label" style="font-family:${me.user.body_font ? `'${esc(me.user.body_font)}',` : ''}var(--font-body)">${esc(me.user.body_font || t('font_default'))}</span>
          </wa-button>
        </div>
        <div class="form-row">
          <label>${esc(t('code_font'))}</label>
          <wa-button class="font-btn" appearance="outlined" id="btn-code-font">
            <span class="fb-label" style="font-family:${me.user.code_font ? `'${esc(me.user.code_font)}',` : ''}var(--font-code)">${esc(me.user.code_font || t('font_default_mono'))}</span>
          </wa-button>
        </div>
        <p class="dim" style="margin:10px 0 0">${esc(t('font_note'))}</p>
      </section>
      <section class="card">
        <h3>${esc(t('change_pw'))}</h3>
        <form id="f-pw" class="form-col">
          <input name="old" type="password" placeholder="${esc(t('old_pw'))}" required autocomplete="current-password">
          <input name="new" type="password" placeholder="${esc(t('new_pw'))}" required minlength="8" autocomplete="new-password">
          <wa-button variant="brand" type="submit">${esc(t('change_pw'))}</wa-button>
        </form>
      </section>
      <section class="card">
        <h3>${esc(t('sys_status'))}</h3>
        <div class="form-row"><label>${esc(t('send_channel'))}</label><span>${esc(me.send_enabled ? t('ch_connected', me.provider.toUpperCase()) : t('ch_dev'))}</span></div>
        <div class="form-row"><label>${esc(t('my_mailboxes'))}</label><span>${me.mailboxes.map((m) => esc(m.address) + '(' + roleName(m.role) + ')' + ((m.aliases || []).length ? ',' + esc(t('alias_prefix')) + m.aliases.map(esc).join(' / ') : '')).join(' 、 ') || esc(t('none'))}</span></div>
        <div class="form-row"><label>${esc(t('version'))}</label><span>CFMail v${esc(store.brand?.version || '')}</span></div>
      </section>
    </div>
  </div>`);
  qs('#f-profile').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('POST', '/api/me/profile', { name: new FormData(e.target).get('name') });
    toast(t('t_saved'));
    refreshMe();
  });
  qs('#sel-lang').addEventListener('change', async (e) => {
    const l = e.target.value;
    setLang(l);
    await dictReady();
    await api('POST', '/api/me/lang', { lang: l }).catch(() => {});
    toast(t('t_lang_saved'));
    renderSettings();
  });
  qs('#sel-mode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    applyMode(mode);
    await api('POST', '/api/me/appearance', { appearance: mode }).catch(() => {});
    toast(t('t_mode_saved'));
  });

  /** Change one of the three fonts and leave the other two exactly as they are.
   *
   *  The endpoint takes all three every time, so the two that are not being changed have to be sent
   *  back unchanged -- a field left out is a field set to the system default, which would clear a
   *  setting the person never touched.
   *
   *  改三种字体中的一种,另外两种原封不动。
   *
   *  这个端点每次都要三个,所以没在改的那两个必须原样送回 ——
   *  漏掉一个字段就等于把它设成系统默认,那会清掉一个当事人根本没碰过的设置。 */
  const FONTS = {
    ui: { field: 'ui_font', label: 'ui_font', only: '' },
    body: { field: 'body_font', label: 'body_font', only: '' },
    // Fixed-width only. Source code in a proportional face stops lining up, which is the one thing
    // the columns in a source file are for.
    // 只给等宽。比例字体下的源码不再对齐,而对齐正是源码文件里那些列存在的意义。
    code: { field: 'code_font', label: 'code_font', only: 'mono' },
  };

  const setFont = async (which) => {
    const spec = FONTS[which];
    const picked = await pickFont(me.user[spec.field] || '', t(spec.label), spec.only);
    if (picked === null) return; // 取消
    const payload = {};
    for (const s of Object.values(FONTS)) payload[s.field] = me.user[s.field] || '';
    payload[spec.field] = picked;
    try {
      await api('POST', '/api/me/fonts', payload);
      for (const s of Object.values(FONTS)) me.user[s.field] = payload[s.field] || null;
      applyFonts();
      toast(t('t_font_saved'));
      renderSettings();
    } catch (err) {
      toast(err.message, true);
    }
  };
  qs('#btn-ui-font').addEventListener('click', () => setFont('ui'));
  qs('#btn-body-font').addEventListener('click', () => setFont('body'));
  qs('#btn-code-font').addEventListener('click', () => setFont('code'));
  qs('#f-pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/api/me/password', { old: fd.get('old'), new: fd.get('new') });
      toast(t('t_pw_changed'));
      e.target.reset();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

export function roleName(r) {
  return { owner: t('role_owner'), member: t('role_member'), readonly: t('role_readonly') }[r] || r;
}
