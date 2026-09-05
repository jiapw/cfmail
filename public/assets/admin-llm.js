// The console's "Models" page: which model translates forms, and what it is told. One setting
// for the whole deployment, global administrators only; the server refuses everybody else.
// A "try it" box translates a few sample strings with the values currently on the page -- saved
// or not -- so a change can be judged before it is kept.
// 后台的「大模型」页:哪个模型给表单做翻译、对它说什么。整套部署一份设置,仅全局管理员;
// 其余人服务端直接拒绝。「试一试」用页面上此刻的值 —— 存没存都行 —— 翻几条样例,
// 好在留下一个改动之前先看它的成色。
import { api } from './api.js';
import { t, LANG_OPTIONS } from './i18n.js';
import { esc, qs, toast } from './ui.js';

const CUSTOM = '__custom';

export async function tabLlm(body) {
  let d;
  try {
    d = await api('GET', '/api/admin/llm');
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const listed = d.models.some((m) => m.id === d.settings.translate_model);
  body.innerHTML = `
    <section class="card">
      <h3>${esc(t('llm_translate'))}</h3>
      <p class="dim" style="margin:0 0 12px">${esc(t('llm_intro'))}</p>
      ${d.available ? '' : `<p class="chip chip-warn" style="display:inline-block;margin:0 0 12px">${esc(t('llm_unavailable'))}</p>`}
      <div class="form-row">
        <label>${esc(t('llm_model'))}</label>
        <wa-select id="llm-model" value="${esc(listed ? d.settings.translate_model : CUSTOM)}" style="width:420px">
          ${d.models.map((m) => `<wa-option value="${esc(m.id)}">${esc(m.label)} · ${esc(m.id)}</wa-option>`).join('')}
          <wa-option value="${CUSTOM}">${esc(t('llm_custom_model'))}</wa-option>
        </wa-select>
      </div>
      <div class="form-row" id="llm-custom-row" ${listed ? 'hidden' : ''}>
        <label>${esc(t('llm_custom_id'))}</label>
        <input id="llm-custom" class="llm-in" style="width:420px;max-width:100%" placeholder="@cf/vendor/model" value="${esc(listed ? '' : d.settings.translate_model)}" spellcheck="false">
      </div>
      <div class="form-row" style="align-items:flex-start">
        <label style="line-height:20px;padding-top:7px">${esc(t('llm_prompt'))}</label>
        <div style="flex:1;min-width:0;max-width:760px">
          <textarea id="llm-prompt" class="llm-prompt" rows="6" spellcheck="false">${esc(d.settings.translate_prompt)}</textarea>
          <p class="dim" style="margin:6px 0 0">${esc(t('llm_prompt_hint'))}</p>
        </div>
      </div>
      <div class="row-flex" style="margin-top:12px">
        <wa-button variant="brand" id="llm-save">${esc(t('save'))}</wa-button>
        <wa-button appearance="outlined" id="llm-reset">${esc(t('llm_reset'))}</wa-button>
      </div>
    </section>
    <section class="card">
      <h3>${esc(t('llm_test'))}</h3>
      <div class="form-row">
        <label>${esc(t('llm_test_lang'))}</label>
        <select id="llm-test-lang" style="width:200px">
          ${LANG_OPTIONS.map(([c, n]) => `<option value="${c}" ${c === 'en' ? 'selected' : ''}>${esc(n)}</option>`).join('')}
        </select>
        <input id="llm-test-text" class="llm-in" style="width:360px" placeholder="${esc(t('llm_test_ph'))}">
        <wa-button id="llm-test-run" ${d.available ? '' : 'disabled'}>${esc(t('llm_test_run'))}</wa-button>
      </div>
      <pre class="llm-out" id="llm-out" hidden></pre>
    </section>`;

  const modelValue = () => {
    const v = qs('#llm-model').value;
    return v === CUSTOM ? qs('#llm-custom').value.trim() : v;
  };
  qs('#llm-model').addEventListener('change', (e) => {
    qs('#llm-custom-row').hidden = e.target.value !== CUSTOM;
  });
  qs('#llm-save').addEventListener('click', async () => {
    const btn = qs('#llm-save');
    btn.loading = true;
    try {
      const r = await api('PUT', '/api/admin/llm', { translate_model: modelValue(), translate_prompt: qs('#llm-prompt').value });
      d.settings = r.settings;
      toast(t('t_saved'));
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.loading = false;
    }
  });
  qs('#llm-reset').addEventListener('click', () => {
    qs('#llm-model').value = d.defaults.translate_model;
    qs('#llm-custom-row').hidden = true;
    qs('#llm-custom').value = '';
    qs('#llm-prompt').value = d.defaults.translate_prompt;
  });
  qs('#llm-test-run').addEventListener('click', async () => {
    const btn = qs('#llm-test-run');
    const out = qs('#llm-out');
    btn.loading = true;
    try {
      const r = await api('POST', '/api/admin/llm/test', {
        lang: qs('#llm-test-lang').value,
        text: qs('#llm-test-text').value,
        translate_model: modelValue(),
        translate_prompt: qs('#llm-prompt').value,
      });
      const lines = Object.entries(r.input).map(([k, v]) => `${v}\n    → ${r.output[k] ?? '—'}`);
      out.textContent = `${r.ok ? t('llm_test_ok', r.ms) : t('llm_test_fail')}  ·  ${r.model}\n\n${lines.join('\n')}`;
      out.hidden = false;
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.loading = false;
    }
  });
}
