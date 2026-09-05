// The page a form's link opens.
//
// Reached without an account, so it touches nothing that assumes a signed-in session: no
// store.me, no /api/forms/*. It reads one design from /api/fill/<token>, draws it, and posts one
// set of answers back. Its look -- palette, light or dark, language -- is borrowed for the
// duration and given back on leaving: a visitor who also has an account here must not find their
// own app repainted by a stranger's form. The visitor's two choices (language, light/dark) are
// remembered in this browser under keys of their own, so that a second form opens the way the
// first was left, and neither touches the app's own settings.
//
// 表单链接打开的那一页。
//
// 无账号即可抵达,因此不碰任何以"已登录会话"为前提的东西:没有 store.me,不用 /api/forms/*。
// 它从 /api/fill/<token> 读一份设计、画出来、把一组答复寄回去。它的观感 —— 配色、明暗、语言 ——
// 都是借来的,离开时归还:一个在本处也有账号的访问者,不该发现自己的应用被陌生人的表单重新粉刷。
// 访问者自己的两个选择(语言、明暗)以专属的键记在这个浏览器里,好让第二份表单以第一份离开时的
// 样子打开,而且哪一个都不碰应用自己的设置。
import { t, tErr, setLang, dictReady, lang, LANG_OPTIONS } from '../i18n.js';
import { esc, icon, qs, qsa, toast, fmtSize, loadCss } from '../ui.js';
import { store, navigate, setTitle, show } from '../app.js';
import { countryOptions } from './countries.js';

const MODE_KEY = 'cf_form_mode';
const LANG_KEY = 'cf_form_lang';
const LANG_LABEL = Object.fromEntries(LANG_OPTIONS);
const FILE_TYPES = new Set(['file', 'files', 'image', 'images']);
/** Answers short enough to sit on the question's own line / 短到能与题目同行的答案 */
const INLINE_TYPES = new Set(['text', 'int', 'float', 'date', 'country']);

/** Everything about the form on screen. Null until one is loaded.
 *  屏幕上这份表单的一切。加载完之前为 null。 */
let fs = null;
let guard = null;

/** Resolves once the stylesheet is in; awaited before the first paint (see loadCss in ui.js).
 *  样式表就位后兑现;第一次绘制之前先等它(见 ui.js 的 loadCss)。 */
function ensureCss() {
  return loadCss('/assets/forms/forms.css?v=' + encodeURIComponent(store.brand?.version || ''));
}

// ---------- Look ----------
// ---------- 观感 ----------

function applyLook(theme, dark) {
  const h = document.documentElement;
  if (theme) h.dataset.theme = theme;
  h.classList.toggle('wa-dark', dark);
  h.classList.toggle('wa-light', !dark);
}

/** Remember how this browser looked before the form touched it, and put it back the moment the
 *  visitor leaves the fill route.
 *  记下表单介入之前这个浏览器的样子,访问者一离开填写路由就还原回去。 */
function armGuard() {
  if (guard) return;
  const h = document.documentElement;
  const saved = { theme: h.dataset.theme, dark: h.classList.contains('wa-dark'), lang: lang() };
  guard = () => {
    if (/^#\/f\//.test(location.hash)) return;
    h.dataset.theme = saved.theme || 'blue';
    h.classList.toggle('wa-dark', saved.dark);
    h.classList.toggle('wa-light', !saved.dark);
    setLang(saved.lang, false);
    window.removeEventListener('hashchange', guard);
    guard = null;
    fs = null;
  };
  window.addEventListener('hashchange', guard);
}

/** The language to open in: what this visitor chose before, else what their browser asked for
 *  (the server matched Accept-Language against the form's languages), else the designer's.
 *  以哪种语言打开:这位访问者此前选过的;否则他的浏览器要求的(服务端已拿 Accept-Language
 *  对过表单的语言);否则设计者的。 */
function pickLang(head) {
  const langs = head.langs?.length ? head.langs : [head.src_lang];
  let saved = '';
  try { saved = localStorage.getItem(LANG_KEY) || ''; } catch {}
  if (langs.includes(saved)) return saved;
  if (langs.includes(head.accept_lang)) return head.accept_lang;
  return langs.includes(head.src_lang) ? head.src_lang : langs[0];
}

/** The designer's text in the language on screen, or as written when no translation exists.
 *  屏幕上这种语言里的设计者文本;没有译文就按原文。 */
function tx(path, fallback) {
  if (!fs || fs.lang === fs.head.src_lang) return fallback;
  return fs.head.i18n?.[fs.lang]?.[path] || fallback;
}

// ---------- Entry ----------
// ---------- 入口 ----------

export async function renderFill(rest) {
  await ensureCss();
  armGuard();
  const qi = rest.indexOf('?');
  const token = qi < 0 ? rest : rest.slice(0, qi);
  // Answers carried in the address: #/f/<token>?name=Ann&q1=yes&q3=a,b
  // 地址里带来的答案:#/f/<token>?name=Ann&q1=yes&q3=a,b
  const prefill = {};
  new URLSearchParams(qi < 0 ? '' : rest.slice(qi + 1)).forEach((v, k) => { prefill[k] = v; });
  show(`<div class="fm-fill"><div class="loading">${esc(t('loading'))}</div></div>`);
  let head;
  try {
    const r = await fetch(`/api/fill/${encodeURIComponent(token)}`, { headers: { accept: 'application/json' } });
    head = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(head.error || 'e_generic');
  } catch (e) {
    show(`<div class="fm-fill">${topHtml(null)}<main class="fm-card-w"><div class="fm-notice">${icon('spam', 44)}<h2>${esc(tErr(e.message))}</h2></div></main></div>`);
    return;
  }
  fs = { token, head, prefill, urlPrefill: { ...prefill }, files: {}, codeId: null, codeEmail: '', verified: false, lang: pickLang(head), timer: null };
  setLang(fs.lang, false);
  await dictReady();
  let savedMode = '';
  try { savedMode = localStorage.getItem(MODE_KEY) || ''; } catch {}
  const dark = savedMode ? savedMode === 'dark' : head.mode ? head.mode === 'dark' : document.documentElement.classList.contains('wa-dark');
  applyLook(head.theme, dark);
  render();
}

/** The company named on the page is the one whose host the visitor is on -- the same rule as
 *  every other page here. The form's own domain is only the fallback for a host with no brand.
 *  页面上写的是访问者所在主机的那家公司 —— 与这里其余每一页同一条规则。
 *  表单自己的域名只在主机没有品牌时兜底。 */
function brandHtml() {
  const name = store.brand?.name || fs?.head?.brand || 'CFMail';
  const logo = store.brand?.logo_url
    ? `<img class="brand-logo" data-logo-mode="${esc(store.brand.logo_mode || 'light')}" style="height:34px" src="${esc(store.brand.logo_url)}" alt="">`
    : icon('fileText', 30);
  return `<div class="brand-lockup fm-brand">${logo}<span>${esc(name)}</span></div>`;
}

function topHtml(head) {
  const langs = head?.langs?.length > 1 ? head.langs : null;
  const dark = document.documentElement.classList.contains('wa-dark');
  return `
  <header class="fm-fill-top">
    ${brandHtml()}
    <div class="fm-fill-tools">
      ${langs ? `<span class="fm-selw inline"><select id="ff-lang" class="fm-select fm-langsel" aria-label="${esc(t('language'))}">
        ${langs.map((l) => `<option value="${l}" ${l === fs.lang ? 'selected' : ''}>${esc(LANG_LABEL[l] || l)}</option>`).join('')}
      </select></span>` : ''}
      <wa-button class="icon" appearance="plain" id="ff-mode" title="${esc(t('fm_mode_toggle'))}" aria-label="${esc(t('fm_mode_toggle'))}">${icon(dark ? 'sun' : 'moon', 20)}</wa-button>
    </div>
  </header>`;
}

function render() {
  const h = fs.head;
  const title = tx('title', h.title);
  setTitle(title);
  let body;
  if (h.disabled) {
    body = `<main class="fm-card-w"><div class="fm-notice">${icon('pause', 44)}<h2>${esc(title)}</h2><p>${esc(t('fm_disabled_notice'))}</p></div></main>`;
  } else if (h.need_login) {
    body = `<main class="fm-card-w"><div class="fm-notice">${icon('lock', 44)}<h2>${esc(title)}</h2>
      <p>${esc(t('fm_login_needed', store.brand?.name || h.brand || 'CFMail'))}</p>
      <wa-button variant="brand" id="ff-login">${esc(t('fm_sign_in'))}</wa-button></div></main>`;
  } else {
    body = formHtml();
  }
  show(`<div class="fm-fill">${topHtml(h)}${body}
    <div class="fm-foot">${esc(store.brand?.name ? `${store.brand.name} · Powered by CFMail` : t('powered'))}</div></div>`);
  bind();
}

// ---------- The form ----------
// ---------- 表单本体 ----------

function formHtml() {
  const h = fs.head;
  const desc = tx('description', h.description || '');
  return `
  <main class="fm-card-w">
    <div class="fm-kind">${esc(t('fm_kind_' + h.kind))}</div>
    <h1 class="fm-h1">${esc(tx('title', h.title))}</h1>
    ${desc ? `<p class="fm-desc">${esc(desc).replace(/\n/g, '<br>')}</p>` : ''}
    <form id="ff" novalidate>
      ${senderHtml()}
      ${h.fields.map(fieldHtml).join('')}
      <div class="fm-verify" id="ff-verify" hidden>
        <div class="fm-verify-t">${esc(t('fm_verify_title'))}</div>
        <p class="fm-verify-p" id="ff-verify-p"></p>
        <div class="fm-verify-row">
          <input id="ff-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="${esc(t('fm_verify_code_ph'))}">
          <wa-button variant="brand" id="ff-verify-btn">${esc(t('fm_verify_btn'))}</wa-button>
        </div>
        <div class="fm-verify-foot"><wa-button appearance="plain" size="small" id="ff-resend">${esc(t('fm_resend'))}</wa-button><span class="dim" id="ff-resend-in"></span></div>
        <div class="fm-err" id="ff-verify-err" hidden></div>
      </div>
      <div class="fm-actions">
        <span class="fm-req-note dim">${h.fields.some((f) => f.required) ? esc(t('fm_required_hint')) : ''}</span>
        <wa-button variant="brand" type="submit" id="ff-submit">${esc(t('fm_submit'))}</wa-button>
      </div>
    </form>
  </main>`;
}

function senderHtml() {
  const h = fs.head;
  const p = fs.prefill;
  if (h.audience === 'internal') {
    const me = h.me || { name: '', email: '', mailboxes: [] };
    const boxes = me.mailboxes || [];
    const emailCtl = boxes.length > 1
      ? `<span class="fm-selw"><select id="ff-mailbox" class="fm-select">${boxes.map((m) => `<option value="${esc(m.id)}">${esc(m.address)}</option>`).join('')}</select></span>`
      : `<input id="ff-email" value="${esc(boxes[0]?.address || me.email)}" readonly>`;
    return `
    <section class="fm-sender">
      <div class="fm-sender-t">${esc(t('fm_answer_as'))}</div>
      <div class="fm-grid2">
        <label class="fm-fld">${esc(t('fm_name'))}<input id="ff-name" maxlength="80" value="${esc(p.name ?? me.name)}"></label>
        <label class="fm-fld">${esc(t('fm_email'))}${emailCtl}</label>
      </div>
    </section>`;
  }
  return `
  <section class="fm-sender">
    <div class="fm-sender-t">${esc(t('fm_about_you'))}</div>
    <div class="fm-grid2">
      <label class="fm-fld"><span>${esc(t('fm_name'))} <span class="fm-req">*</span></span><input id="ff-name" maxlength="80" autocomplete="name" value="${esc(p.name || '')}"></label>
      <label class="fm-fld"><span>${esc(t('fm_email'))} <span class="fm-req">*</span></span><input id="ff-email" type="email" maxlength="200" autocomplete="email" value="${esc(p.email || '')}">
        ${h.verify_email ? `<small class="dim">${esc(t('fm_email_verify_note'))}</small>` : ''}</label>
    </div>
    <div class="fm-err" id="ff-sender-err" hidden></div>
  </section>`;
}

function helpBtn(id) {
  return `<button type="button" class="fm-help-btn" data-help="${esc(id)}" aria-label="${esc(t('fm_help'))}">?</button>`;
}
function helpBox(id, text) {
  return `<div class="fm-help" data-hb="${esc(id)}" hidden>${esc(text).replace(/\n/g, '<br>')}</div>`;
}

function countrySelect(name, value) {
  return `<span class="fm-selw"><select name="${esc(name)}" class="fm-select">
    <option value="">${esc(t('fm_choose'))}</option>
    ${countryOptions(fs.lang).map((c) => `<option value="${c.code}" ${c.code === value ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
  </select></span>`;
}

function fieldHtml(f) {
  const p = fs.prefill;
  const label = tx(`f.${f.key}.label`, f.label);
  const help = f.help ? tx(`f.${f.key}.help`, f.help) : '';
  const pre = p[f.key] ?? '';
  const k = esc(f.key);
  let ctl = '';
  switch (f.type) {
    case 'text': ctl = `<input name="${k}" maxlength="500" value="${esc(pre)}">`; break;
    case 'textarea': ctl = `<textarea name="${k}" rows="4" maxlength="20000">${esc(pre)}</textarea>`; break;
    case 'int': ctl = `<input name="${k}" type="number" step="1" inputmode="numeric" value="${esc(pre)}">`; break;
    case 'float': ctl = `<input name="${k}" type="number" step="any" inputmode="decimal" value="${esc(pre)}">`; break;
    case 'date': ctl = `<input name="${k}" type="date" value="${esc(pre)}">`; break;
    case 'bool': {
      // Three states, not two: a question nobody answered is not a "no". So it is a pair of
      // radios with neither picked, and "required" means one of them must be.
      // 三态,不是两态:没人回答的问题不等于"否"。所以是一对都不选中的单选,"必填"指必须选其一。
      const pv = String(pre).toLowerCase();
      const yes = /^(1|true|on|yes)$/.test(pv);
      const no = /^(0|false|off|no)$/.test(pv);
      ctl = `<div class="fm-opts fm-yn">
        <label class="fm-opt"><input type="radio" name="${k}" value="1" ${yes ? 'checked' : ''}><span>${esc(t('fm_yes'))}</span></label>
        <label class="fm-opt"><input type="radio" name="${k}" value="0" ${no ? 'checked' : ''}><span>${esc(t('fm_no'))}</span></label>
      </div>`;
      break;
    }
    case 'single': case 'multi': {
      const picked = new Set(String(pre).split(',').map((s) => s.trim()).filter(Boolean));
      const type = f.type === 'single' ? 'radio' : 'checkbox';
      ctl = `<div class="fm-opts">${(f.options || []).map((o) => {
        const ol = tx(`f.${f.key}.o.${o.value}.label`, o.label);
        const oh = o.help ? tx(`f.${f.key}.o.${o.value}.help`, o.help) : '';
        const id = `${f.key}.${o.value}`;
        return `<label class="fm-opt"><input type="${type}" name="${k}" value="${esc(o.value)}" ${picked.has(o.value) ? 'checked' : ''}><span>${esc(ol)}</span>${oh ? helpBtn(id) : ''}</label>${oh ? helpBox(id, oh) : ''}`;
      }).join('')}</div>`;
      break;
    }
    case 'country': ctl = countrySelect(f.key, String(pre).toUpperCase()); break;
    case 'address':
      ctl = `<div class="fm-addr">
        <input name="${k}.line1" maxlength="200" placeholder="${esc(t('fm_addr_line1'))}" autocomplete="address-line1" value="${esc(p[`${f.key}.line1`] || '')}">
        <input name="${k}.line2" maxlength="200" placeholder="${esc(t('fm_addr_line2'))}" autocomplete="address-line2" value="${esc(p[`${f.key}.line2`] || '')}">
        <div class="fm-addr-row">
          <input name="${k}.city" maxlength="120" placeholder="${esc(t('fm_addr_city'))}" autocomplete="address-level2" value="${esc(p[`${f.key}.city`] || '')}">
          <input name="${k}.state" maxlength="120" placeholder="${esc(t('fm_addr_state'))}" autocomplete="address-level1" value="${esc(p[`${f.key}.state`] || '')}">
          <input name="${k}.postal" maxlength="40" placeholder="${esc(t('fm_addr_postal'))}" autocomplete="postal-code" value="${esc(p[`${f.key}.postal`] || '')}">
          ${countrySelect(`${f.key}.country`, String(p[`${f.key}.country`] || '').toUpperCase())}
        </div>
      </div>`;
      break;
    case 'file': case 'files': case 'image': case 'images': {
      // The native control is kept but never shown: its "no file chosen" caption cannot be
      // silenced, and the list of what was picked is ours to draw -- with thumbnails, sizes and
      // a way to take one back. One picked file sits beside its button; many stack under it,
      // and picking again adds to them rather than starting over.
      // 原生控件留着但从不显示:它那句"未选择文件"关不掉,而选了什么的清单由我们来画 ——
      // 带缩略图、大小,以及撤回某一个的办法。单个文件挨着它的按钮;多个则在按钮下面排开,
      // 再选一次是追加,不是重来。
      const multi = f.type === 'files' || f.type === 'images';
      const image = f.type === 'image' || f.type === 'images';
      const pick = t(multi ? (image ? 'fm_pick_images' : 'fm_pick_files') : (image ? 'fm_pick_image' : 'fm_pick_file'));
      ctl = `<div class="fm-filebox ${multi ? 'multi' : 'single'}" data-key="${k}">
        <input type="file" name="${k}" ${multi ? 'multiple' : ''} ${image ? 'accept="image/*"' : ''} hidden>
        <div class="fm-file-row">
          <wa-button size="small" appearance="outlined" class="fm-pick">${icon(image ? 'image' : 'attach', 16)} ${esc(pick)}</wa-button>
          ${multi ? '' : `<div class="fm-files inline" data-files="${k}"></div>`}
        </div>
        ${multi ? `<div class="fm-files ${image ? 'wrap' : ''}" data-files="${k}"></div>` : ''}
      </div>`;
      break;
    }
  }
  // A short answer shares its line with the question; anything taller stands under it. For the
  // shared line the explanation follows the control, so that opening it does not push the
  // control off the line.
  // 短答案与题目同行;高一些的站在题目下面。同行时解释放在控件之后,
  // 展开它才不会把控件挤下这一行。
  const inline = INLINE_TYPES.has(f.type);
  return `
  <div class="fm-field ${inline ? 'inline' : ''}" data-key="${k}" data-type="${esc(f.type)}">
    <div class="fm-label">${esc(label)}${f.required ? '<span class="fm-req">*</span>' : ''}${help ? helpBtn(f.key) : ''}</div>
    ${help && !inline ? helpBox(f.key, help) : ''}
    ${ctl}
    ${help && inline ? helpBox(f.key, help) : ''}
    <div class="fm-err" hidden></div>
  </div>`;
}

// ---------- Wiring ----------
// ---------- 接线 ----------

function bind() {
  qs('#ff-lang')?.addEventListener('change', (e) => switchLang(e.target.value));
  qs('#ff-mode')?.addEventListener('click', () => {
    const dark = !document.documentElement.classList.contains('wa-dark');
    applyLook(null, dark);
    try { localStorage.setItem(MODE_KEY, dark ? 'dark' : 'light'); } catch {}
    const b = qs('#ff-mode');
    if (b) b.innerHTML = icon(dark ? 'sun' : 'moon', 20);
  });
  qs('#ff-login')?.addEventListener('click', () => {
    try { sessionStorage.setItem('cf_after_login', location.hash); } catch {}
    navigate('#/login');
  });
  const form = qs('#ff');
  if (!form) return;
  form.addEventListener('submit', onSubmit);
  form.addEventListener('click', (e) => {
    const pick = e.target.closest?.('.fm-pick');
    if (pick) {
      e.preventDefault();
      pick.closest('.fm-filebox')?.querySelector('input[type=file]')?.click();
      return;
    }
    const x = e.target.closest?.('.fm-file-x');
    if (x) {
      e.preventDefault();
      dropFile(x.closest('.fm-files')?.dataset.files, Number(x.dataset.x));
      return;
    }
    const th = e.target.closest?.('img.fm-thumb');
    if (th) {
      e.preventDefault();
      openLightbox(th.src, th.alt);
      return;
    }
    const b = e.target.closest?.('.fm-help-btn');
    if (!b) return;
    e.preventDefault();
    const box = qsa('.fm-help', form).find((el) => el.dataset.hb === b.dataset.help);
    if (box) box.hidden = !box.hidden;
  });
  form.addEventListener('change', (e) => {
    const inp = e.target;
    if (inp.type === 'file') {
      const key = inp.name;
      const picked = [...inp.files];
      const cur = fs.files[key] || [];
      const same = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
      if (inp.multiple) {
        // Picking again adds; the same file twice is once.
        // 再选一次是追加;同一个文件选两次算一次。
        fs.files[key] = [...cur, ...picked.filter((p) => !cur.some((c) => same(c, p)))];
      } else if (picked.length) {
        for (const c of cur) if (c._url) { try { URL.revokeObjectURL(c._url); } catch {} }
        fs.files[key] = picked.slice(0, 1);
      }
      // Cleared so that a file removed from the list can be picked again -- an unchanged
      // selection fires no change event.
      // 清空,好让从清单里删掉的文件还能再选 —— 选择没变的话不会触发 change。
      inp.value = '';
      drawFiles(key);
    }
    inp.closest('.fm-field')?.classList.remove('invalid');
  });
  form.addEventListener('input', (e) => e.target.closest?.('.fm-field, .fm-sender')?.classList.remove('invalid'));
  qs('#ff-verify-btn')?.addEventListener('click', verifyCode);
  qs('#ff-code')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); verifyCode(); } });
  qs('#ff-resend')?.addEventListener('click', () => requestCode(fs.codeEmail, true));
  // Files chosen before a language switch are still held; only their list needs redrawing.
  // 切换语言前选好的文件仍在手上;只需把清单重画出来。
  for (const k of Object.keys(fs.files)) drawFiles(k);
}

/** The picked files of one question: a thumbnail for a picture, the name, the size, and a
 *  way to take it back. The preview URL is made once per file and kept on the File object, so
 *  redrawing -- after a language switch, say -- does not decode every picture again.
 *  一道题选好的文件:图片给缩略图,加名字、大小,以及撤回它的办法。预览地址每个文件只造一次,
 *  挂在 File 对象上,于是重画(比如切换语言之后)不会把每张图再解码一遍。 */
function drawFiles(key) {
  const box = qsa('.fm-files').find((el) => el.dataset.files === key);
  if (!box) return;
  // The question's type decides the shape, not the file's: a picture question shows tiles, a
  // file question shows chips -- even for a picture somebody dropped into it.
  // 形状由题目的类型决定,不由文件决定:图片题显示瓷砖,文件题显示小条 —— 哪怕有人往里放的是图片。
  const type = fs.head.fields.find((f) => f.key === key)?.type;
  const asImage = type === 'image' || type === 'images';
  const files = fs.files[key] || [];
  box.innerHTML = files.map((f, i) => {
    const x = `<button type="button" class="fm-file-x" data-x="${i}" aria-label="${esc(t('fm_remove_file'))}" title="${esc(t('fm_remove_file'))}">×</button>`;
    if (asImage) {
      const isImg = /^image\//.test(f.type);
      if (isImg && !f._url) { try { f._url = URL.createObjectURL(f); } catch {} }
      // No name on a tile -- the picture is the name; the size rides on the picture's foot.
      // 瓷砖上不写名字 —— 图片就是名字;大小压在图片的脚上。
      const pic = isImg && f._url
        ? `<img class="fm-thumb" src="${esc(f._url)}" alt="${esc(f.name)}">`
        : `<div class="fm-thumb fm-thumb-none">${icon('image', 28)}</div>`;
      return `<div class="fm-file img" title="${esc(f.name)}"><div class="fm-thumbw">${pic}<span class="fm-thumb-sz">${esc(fmtSize(f.size))}</span></div>${x}</div>`;
    }
    return `<div class="fm-file">${icon('attach', 16)}<span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="dim sz">${esc(fmtSize(f.size))}</span>${x}</div>`;
  }).join('');
}

/** The picture at full size over the page. Anything -- a click, Escape -- puts it away.
 *  全尺寸的图片盖在页面上。随便什么 —— 一下点击、Esc —— 都把它收走。 */
function openLightbox(src, alt) {
  qs('.fm-lightbox')?.remove();
  const box = document.createElement('div');
  box.className = 'fm-lightbox';
  box.innerHTML = `<img src="${esc(src)}" alt="${esc(alt || '')}">${alt ? `<div class="cap">${esc(alt)}</div>` : ''}`;
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
}

function dropFile(key, i) {
  const list = fs.files[key] || [];
  const [gone] = list.splice(i, 1);
  if (gone?._url) { try { URL.revokeObjectURL(gone._url); } catch {} }
  drawFiles(key);
}

/** What the visitor has typed so far, in the shape the address prefill uses, so a redraw in
 *  another language starts from it instead of from nothing.
 *  访问者到目前为止填的东西,按地址预填的形状,让换一种语言重画时从它开始、而不是从零开始。 */
function collectRaw() {
  const out = {};
  const form = qs('#ff');
  if (!form) return out;
  const name = qs('#ff-name');
  if (name) out.name = name.value;
  const email = qs('#ff-email');
  if (email && !email.readOnly) out.email = email.value;
  for (const f of fs.head.fields) {
    if (FILE_TYPES.has(f.type)) continue;
    if (f.type === 'address') {
      for (const part of ['line1', 'line2', 'city', 'state', 'postal', 'country']) {
        const el = form.elements[`${f.key}.${part}`];
        if (el) out[`${f.key}.${part}`] = el.value;
      }
      continue;
    }
    const els = form.querySelectorAll(`[name="${f.key}"]`);
    if (!els.length) continue;
    if (f.type === 'bool' || f.type === 'single' || f.type === 'multi') out[f.key] = [...els].filter((el) => el.checked).map((el) => el.value).join(',');
    else out[f.key] = els[0].value;
  }
  return out;
}

async function switchLang(l) {
  if (!fs.head.langs.includes(l)) return;
  fs.prefill = { ...fs.prefill, ...collectRaw() };
  fs.lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch {}
  setLang(l, false);
  await dictReady();
  render();
}

// ---------- Answers ----------
// ---------- 答复 ----------

/** Read every answer off the page and check the ones that must be there. Marks the first
 *  problem and returns null; otherwise the payload the server expects.
 *  从页面上读出每个答案,检查必须有的那些。有问题就标出第一个并返回 null;否则返回服务端要的载荷。 */
function collect() {
  const h = fs.head;
  const form = qs('#ff');
  qsa('.invalid', form).forEach((el) => el.classList.remove('invalid'));
  qsa('.fm-err', form).forEach((el) => { el.hidden = true; el.textContent = ''; });
  let first = null;
  const fail = (box, msg) => {
    box.classList.add('invalid');
    const err = qs('.fm-err', box);
    if (err) { err.textContent = msg; err.hidden = false; }
    if (!first) first = box;
  };

  const sender = {};
  const senderBox = qs('.fm-sender', form);
  sender.name = (qs('#ff-name')?.value || '').trim();
  if (h.audience === 'internal') {
    sender.mailbox_id = qs('#ff-mailbox')?.value || h.me?.mailboxes?.[0]?.id || '';
  } else {
    sender.email = (qs('#ff-email')?.value || '').trim().toLowerCase();
    if (!sender.name) fail(senderBox, t('fm_name_required'));
    else if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(sender.email)) fail(senderBox, t('e_bad_email'));
  }

  const values = {};
  for (const f of h.fields) {
    const box = qsa('.fm-field', form).find((el) => el.dataset.key === f.key);
    const els = form.querySelectorAll(`[name="${f.key}"]`);
    const need = () => fail(box, t('fm_field_required'));
    if (FILE_TYPES.has(f.type)) {
      const files = fs.files[f.key] || [];
      if (f.required && !files.length) need();
      continue;
    }
    if (f.type === 'address') {
      const a = {};
      for (const part of ['line1', 'line2', 'city', 'state', 'postal', 'country']) a[part] = (form.elements[`${f.key}.${part}`]?.value || '').trim();
      if (f.required && !a.line1) need();
      values[f.key] = a;
      continue;
    }
    if (f.type === 'bool') {
      // '1', '0', or '' for unanswered -- which is what "required" refuses, not a "no".
      // '1'、'0',或未作答的 '' —— "必填"拒绝的是未作答,不是"否"。
      const v = [...els].find((el) => el.checked)?.value || '';
      if (f.required && !v) need();
      values[f.key] = v;
      continue;
    }
    if (f.type === 'single' || f.type === 'multi') {
      const picked = [...els].filter((el) => el.checked).map((el) => el.value);
      if (f.required && !picked.length) need();
      values[f.key] = f.type === 'single' ? (picked[0] || '') : picked;
      continue;
    }
    const v = (els[0]?.value || '').trim();
    if (f.required && !v) need();
    else if (v && f.type === 'int' && !/^-?\d{1,15}$/.test(v)) fail(box, t('fm_int_hint'));
    else if (v && f.type === 'float' && !Number.isFinite(Number(v))) fail(box, t('fm_float_hint'));
    values[f.key] = v;
  }
  if (first) {
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return null;
  }
  return { sender, values };
}

async function onSubmit(e) {
  e.preventDefault();
  const data = collect();
  if (!data) return;
  const h = fs.head;
  // A public form that wants the address proven: the code is asked for at the moment of
  // submitting, not before -- nobody is mailed for a form they then abandon.
  // 要求证明地址的公开表单:验证码在提交那一刻才要,不提前 —— 没人会为一份随后放弃的表单收到邮件。
  if (h.audience === 'public' && h.verify_email && !(fs.verified && fs.codeEmail === data.sender.email)) {
    fs.verified = false;
    return requestCode(data.sender.email, false);
  }
  await send(data);
}

async function requestCode(email, isResend) {
  if (!email) return;
  const panel = qs('#ff-verify');
  const err = qs('#ff-verify-err');
  try {
    const r = await fetch(`/api/fill/${encodeURIComponent(fs.token)}/code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, lang: fs.lang }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(tErr(j.error, j.args));
    fs.codeId = j.code_id;
    fs.codeEmail = email;
    panel.hidden = false;
    qs('#ff-verify-p').textContent = t('fm_verify_sent', email);
    const code = qs('#ff-code');
    code.value = j.dev_code || '';
    if (err) err.hidden = true;
    panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    code.focus();
    startCountdown(60);
    if (isResend) toast(t('fm_code_resent'));
  } catch (e2) {
    toast(e2.message, true);
  }
}

function startCountdown(secs) {
  clearInterval(fs.timer);
  const btn = qs('#ff-resend');
  const lbl = qs('#ff-resend-in');
  let left = secs;
  const tick = () => {
    if (!qs('#ff-resend')) { clearInterval(fs.timer); return; }
    if (left <= 0) { btn.disabled = false; lbl.textContent = ''; clearInterval(fs.timer); return; }
    btn.disabled = true;
    lbl.textContent = t('fm_resend_in', left);
    left--;
  };
  tick();
  fs.timer = setInterval(tick, 1000);
}

async function verifyCode() {
  const code = (qs('#ff-code')?.value || '').trim();
  const err = qs('#ff-verify-err');
  if (!/^\d{6}$/.test(code)) { err.textContent = t('fm_code_format'); err.hidden = false; return; }
  const btn = qs('#ff-verify-btn');
  btn.loading = true;
  try {
    const r = await fetch(`/api/fill/${encodeURIComponent(fs.token)}/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code_id: fs.codeId, code }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(tErr(j.error, j.args));
    fs.verified = true;
    err.hidden = true;
    qs('#ff-verify').hidden = true;
    clearInterval(fs.timer);
    // Verified: the submission the visitor asked for goes through now, without a second click.
    // 验证通过:访问者刚要求的那次提交现在就走,不用再点一次。
    const data = collect();
    if (data) await send(data);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.loading = false;
  }
}

async function send(data) {
  const btn = qs('#ff-submit');
  btn.loading = true;
  btn.disabled = true;
  try {
    const fd = new FormData();
    fd.append('meta', JSON.stringify({
      version: fs.head.version,
      lang: fs.lang,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      tz_offset: -new Date().getTimezoneOffset(),
      local_time: new Date().toLocaleString(fs.lang),
      sender: data.sender,
      code_id: fs.codeId,
      values: data.values,
    }));
    for (const [k, files] of Object.entries(fs.files)) for (const f of files) fd.append(`f_${k}`, f, f.name);
    const r = await fetch(`/api/fill/${encodeURIComponent(fs.token)}/submit`, { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // A used-up or expired verification has to be redone; anything else is just reported.
      // 用掉或过期的验证得重来;其余的只是报出来。
      if (j.error === 'e_form_verify_required') { fs.verified = false; fs.codeId = null; }
      throw new Error(tErr(j.error || 'e_request_failed', j.args || [r.status]));
    }
    renderThanks();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn.isConnected) { btn.loading = false; btn.disabled = false; }
  }
}

function renderThanks() {
  const main = qs('.fm-card-w');
  if (!main) return;
  main.innerHTML = `
    <div class="fm-thanks">
      ${icon('check', 52)}
      <h2>${esc(t('fm_thanks_title'))}</h2>
      <p>${esc(t('fm_thanks_body'))}</p>
      <wa-button appearance="outlined" id="ff-again">${esc(t('fm_fill_again'))}</wa-button>
    </div>`;
  qs('#ff-again')?.addEventListener('click', () => {
    fs.files = {};
    fs.codeId = null;
    fs.codeEmail = '';
    fs.verified = false;
    fs.prefill = { ...fs.urlPrefill };
    render();
  });
}
