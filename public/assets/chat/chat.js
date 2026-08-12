// AI assistant interface: the session list (grouped) on the left, the message stream plus the composer (model picker, attachments, stop) on the right
// Streaming protocol: POST /api/chat/sessions/:id/send returns SSE; the events are defined in src/chat/agent.ts
// AI 助手界面:左侧会话列表(分组),右侧消息流 + 输入框(选模型/附件/停止)
// 流式协议:POST /api/chat/sessions/:id/send 返回 SSE,事件见 src/chat/agent.ts
import { api } from '../api.js';
import { esc, icon, qs, toast, confirmDialog, showModal, closeModal, fmtDate, fileIcon, copyText } from '../ui.js';
import { t, tErr, lang } from '../i18n.js';
import { store, navigate, show } from '../app.js';
import { renderMarkdown } from './markdown.js';

const cs = {
  config: null,
  sessions: [],
  sid: null,
  msgs: [],
  summary: '',
  running: false,   // 服务端是否有未完成的生成(历史加载时)
  model: '',
  files: [],        // 待发送附件
  streaming: false,
  collapsed: JSON.parse(localStorage.getItem('cfmail_chat_grp') || '{}'),
};

let cssLoaded = false;
function ensureCss() {
  if (cssLoaded || qs('link[href^="/assets/chat/chat.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  // The version query stops the browser's heuristic cache handing back stale styles
  // 带版本号防浏览器启发式缓存拿到旧样式
  l.href = '/assets/chat/chat.css?v=' + encodeURIComponent(store.brand?.version || '');
  document.head.appendChild(l);
  cssLoaded = true;
}

function modelOf(id) {
  return (cs.config?.models || []).find((m) => m.id === id) || null;
}
function currentModel() {
  return modelOf(cs.model) || modelOf(cs.config?.default_model) || (cs.config?.models || [])[0] || null;
}

// ---------- Entry point ----------
// ---------- 入口 ----------

export async function renderChat(sid) {
  if (!store.me?.chat_enabled) return navigate('#/');
  ensureCss();
  if (!cs.config) {
    try {
      cs.config = await api('GET', '/api/chat/config');
    } catch (e) {
      toast(e.message, true);
      return navigate('#/');
    }
    cs.model = localStorage.getItem('cfmail_chat_model') || cs.config.default_model;
    if (!modelOf(cs.model)) cs.model = cs.config.default_model;
  }
  try {
    cs.sessions = (await api('GET', '/api/chat/sessions')).sessions;
  } catch {
    cs.sessions = [];
  }

  cs.sid = sid && cs.sessions.find((s) => s.id === sid) ? sid : null;
  cs.msgs = [];
  cs.summary = '';
  cs.running = false;
  cs.streaming = false;
  cs.files = [];
  if (cs.sid) {
    const sess = cs.sessions.find((s) => s.id === cs.sid);
    if (sess?.model && modelOf(sess.model)) cs.model = sess.model;
    try {
      const h = await api('GET', `/api/chat/sessions/${cs.sid}/messages`);
      cs.msgs = h.messages || [];
      cs.summary = h.summary || '';
      cs.running = !!h.running;
    } catch (e) {
      toast(e.message, true);
    }
  }
  renderPage();
}

// ---------- Page skeleton ----------
// ---------- 页面骨架 ----------

function renderPage() {
  document.title = `${t('c_title')} - ${store.brand?.name || 'CFMail'}`;
  show(`
  <div class="chat-shell">
    <aside class="chat-side" id="chat-side">
      <div class="chat-side-head">
        <wa-button class="icon" appearance="plain" href="#/" aria-label="${esc(t('c_back_mail'))}" title="${esc(t('c_back_mail'))}">${icon('back', 20)}</wa-button>
        <span class="chat-logo">${icon('sparkle', 20)}<span>${esc(t('c_title'))}</span></span>
        <wa-button class="icon" appearance="plain" id="btn-memory" aria-label="${esc(t('c_mem_title'))}" title="${esc(t('c_mem_title'))}">${icon('memory', 19)}</wa-button>
      </div>
      <wa-button class="chat-new-btn" id="btn-newchat">${icon('plus', 18)}<span>${esc(t('c_new'))}</span></wa-button>
      <div class="chat-sess-list" id="sess-list"></div>
    </aside>
    <main class="chat-main">
      <header class="chat-head">
        <wa-button class="icon" appearance="plain" id="btn-side" aria-label="menu">${icon('menu', 20)}</wa-button>
        <h2 id="chat-title"></h2>
        <span id="head-actions"></span>
      </header>
      <div class="chat-msgs" id="chat-msgs"><div class="chat-msgs-inner" id="msgs-inner"></div></div>
      <footer class="chat-composer">
        <div class="chat-composer-inner">
          <div class="pending-atts" id="pending-atts" style="display:none"></div>
          <div class="composer-box">
            <textarea id="chat-input" rows="1" placeholder="${esc(t('c_input_ph'))}"></textarea>
            <div class="composer-bar">
              <wa-button class="icon" appearance="plain" id="btn-attach" aria-label="${esc(t('c_attach'))}" title="${esc(t('c_attach'))}">${icon('attach', 19)}</wa-button>
              <input type="file" id="file-input" multiple hidden>
              <wa-dropdown id="model-dd" placement="top-start">
                <wa-button slot="trigger" class="model-pick" appearance="outlined" size="small" with-caret></wa-button>
              </wa-dropdown>
              <span class="spacer"></span>
              <wa-button class="send-btn" variant="brand" id="btn-send" aria-label="${esc(t('c_send'))}"></wa-button>
            </div>
          </div>
          <div class="chat-note">${esc(t('c_gen_note'))}</div>
        </div>
      </footer>
    </main>
  </div>`);
  renderSessList();
  renderTitle();
  renderMsgs();
  renderModelPicker();
  renderSendBtn();
  bindComposer();
  bindSide();
  // Read-aloud buttons (delegated on the container, so redrawing the message area does not lose the listener)
  // 朗读按钮(消息区重绘不丢监听,委托在容器上)
  qs('#msgs-inner').addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-speak]');
    if (b) speakMessage(b.dataset.speak, b);
  });
}

// ---------- Session list ----------
// ---------- 会话列表 ----------

function groupSessions() {
  const groups = new Map();
  for (const s of cs.sessions) {
    const g = s.grp || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const named = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh'));
  return { ungrouped: groups.get('') || [], named, groups };
}

function sessItemHtml(s) {
  const title = s.title || t('c_untitled');
  return `
  <div class="chat-sess ${s.id === cs.sid ? 'active' : ''}" data-sid="${esc(s.id)}">
    <span class="st" title="${esc(title)}">${esc(title)}</span>
    <wa-dropdown class="sess-menu" placement="bottom-end">
      <wa-button slot="trigger" class="icon" appearance="plain" size="small" aria-label="menu">${icon('dots-v', 16)}</wa-button>
      <wa-dropdown-item value="rename">${icon('pencil', 16)} ${esc(t('c_rename'))}</wa-dropdown-item>
      <wa-dropdown-item value="group">${icon('folder', 16)} ${esc(t('c_move_group'))}</wa-dropdown-item>
      <wa-dropdown-item value="del">${icon('trash', 16)} ${esc(t('c_del_session'))}</wa-dropdown-item>
    </wa-dropdown>
  </div>`;
}

function renderSessList() {
  const el = qs('#sess-list');
  if (!el) return;
  const { ungrouped, named, groups } = groupSessions();
  let html = ungrouped.map(sessItemHtml).join('');
  for (const g of named) {
    const closed = !!cs.collapsed[g];
    const list = groups.get(g);
    html += `
    <div class="chat-group-head ${closed ? 'closed' : ''}" data-grp="${esc(g)}">
      <wa-icon class="caret" name="expand-less" style="font-size:14px;transform:rotate(${closed ? -90 : 180}deg)"></wa-icon>
      <span>${esc(g)}</span><span class="cnt">${list.length}</span>
      <wa-dropdown class="grp-menu" placement="bottom-end">
        <wa-button slot="trigger" class="icon" appearance="plain" size="small" aria-label="menu">${icon('dots-v', 14)}</wa-button>
        <wa-dropdown-item value="grename">${icon('pencil', 16)} ${esc(t('c_rename_group'))}</wa-dropdown-item>
        <wa-dropdown-item value="gdissolve">${icon('close', 16)} ${esc(t('c_dissolve_group'))}</wa-dropdown-item>
      </wa-dropdown>
    </div>
    <div class="chat-grp-body" data-grpbody="${esc(g)}" ${closed ? 'style="display:none"' : ''}>${list.map(sessItemHtml).join('')}</div>`;
  }
  el.innerHTML = html;

  el.querySelectorAll('.chat-sess').forEach((node) => {
    node.addEventListener('click', (e) => {
      if (e.target.closest('.sess-menu')) return;
      const id = node.dataset.sid;
      if (id !== cs.sid) navigate(`#/chat/${id}`);
    });
    node.querySelector('.sess-menu')?.addEventListener('wa-select', (e) => {
      sessAction(node.dataset.sid, e.detail?.item?.value);
    });
  });
  el.querySelectorAll('.chat-group-head').forEach((node) => {
    node.addEventListener('click', (e) => {
      if (e.target.closest('.grp-menu')) return;
      const g = node.dataset.grp;
      cs.collapsed[g] = !cs.collapsed[g];
      localStorage.setItem('cfmail_chat_grp', JSON.stringify(cs.collapsed));
      renderSessList();
    });
    node.querySelector('.grp-menu')?.addEventListener('wa-select', (e) => {
      groupAction(node.dataset.grp, e.detail?.item?.value);
    });
  });
}

async function sessAction(id, action) {
  const sess = cs.sessions.find((s) => s.id === id);
  if (!sess) return;
  if (action === 'del') {
    if (!(await confirmDialog(t('c_del_confirm'), t('delete')))) return;
    try {
      await api('DELETE', `/api/chat/sessions/${id}`);
      cs.sessions = cs.sessions.filter((s) => s.id !== id);
      if (cs.sid === id) return navigate('#/chat');
      renderSessList();
    } catch (e) {
      toast(e.message, true);
    }
    return;
  }
  if (action === 'rename') {
    promptModal(t('c_rename'), sess.title || '', async (v) => {
      await api('PATCH', `/api/chat/sessions/${id}`, { title: v });
      sess.title = v;
      renderSessList();
      renderTitle();
    });
    return;
  }
  if (action === 'group') {
    const existing = [...new Set(cs.sessions.map((s) => s.grp).filter(Boolean))];
    promptModal(t('c_move_group'), sess.grp || '', async (v) => {
      await api('PATCH', `/api/chat/sessions/${id}`, { grp: v });
      sess.grp = v;
      renderSessList();
    }, { datalist: existing, placeholder: t('c_group_name_ph'), allowEmpty: true });
  }
}

async function groupAction(g, action) {
  if (action === 'gdissolve') {
    if (!(await confirmDialog(t('c_dissolve_confirm', g)))) return;
    try {
      await api('POST', '/api/chat/groups', { action: 'dissolve', from: g });
      cs.sessions.forEach((s) => { if (s.grp === g) s.grp = ''; });
      renderSessList();
    } catch (e) {
      toast(e.message, true);
    }
    return;
  }
  if (action === 'grename') {
    promptModal(t('c_rename_group'), g, async (v) => {
      if (!v || v === g) return;
      await api('POST', '/api/chat/groups', { action: 'rename', from: g, to: v });
      cs.sessions.forEach((s) => { if (s.grp === g) s.grp = v; });
      renderSessList();
    });
  }
}

/** Small single-field dialog (rename, group name)
 *  单输入框小弹窗(重命名/分组名) */
function promptModal(label, value, onOk, { datalist = null, placeholder = '', allowEmpty = false } = {}) {
  const dlId = 'pm-dl-' + Date.now();
  const d = showModal(`
    <div class="modal-body form-col">
      <h3 style="margin:0 0 4px">${esc(label)}</h3>
      <input id="pm-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="60" ${datalist ? `list="${dlId}"` : ''}>
      ${datalist ? `<datalist id="${dlId}">${datalist.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>` : ''}
    </div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
      <wa-button appearance="plain" data-x="cancel">${esc(t('cancel'))}</wa-button>
      <wa-button variant="brand" data-x="ok">${esc(t('confirm'))}</wa-button>
    </div>`);
  const submit = async () => {
    const v = qs('#pm-input', d).value.trim().slice(0, 60);
    if (!v && !allowEmpty) return;
    try {
      await onOk(v);
      closeModal();
    } catch (e) {
      toast(e.message, true);
    }
  };
  d.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-x]');
    if (!b) return;
    if (b.dataset.x === 'ok') submit();
    else closeModal();
  });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'pm-input') submit();
  });
  setTimeout(() => qs('#pm-input', d)?.focus(), 150);
}

// ---------- Message rendering ----------
// ---------- 消息渲染 ----------

function renderTitle() {
  const sess = cs.sessions.find((s) => s.id === cs.sid);
  const el = qs('#chat-title');
  if (el) el.textContent = sess ? (sess.title || t('c_untitled')) : t('c_new');
}

function fileUrl(id) {
  return `/api/chat/files/${encodeURIComponent(id)}`;
}

function userPartsHtml(m) {
  let html = '';
  const texts = m.parts.filter((p) => p.type === 'text');
  const files = m.parts.filter((p) => p.type === 'file');
  for (const f of files) {
    if (f.kind === 'image' || f.kind === 'gen') {
      html += `<img class="att-img" src="${fileUrl(f.file_id)}" alt="${esc(f.filename)}" loading="lazy">`;
    } else if (f.kind === 'audio') {
      html += `<audio controls preload="none" src="${fileUrl(f.file_id)}"></audio>`;
    } else {
      html += `<span class="att-chip">${fileIcon(f.filename, 22)}<span class="an">${esc(f.filename)}</span></span>`;
    }
  }
  for (const p of texts) html += `<div class="bubble">${esc(p.text)}</div>`;
  return html;
}

function toolLabel(name) {
  return { web_search: t('c_tool_search'), open_url: t('c_tool_open_url'), generate_image: t('c_tool_image'), save_memory: t('c_tool_memory') }[name] || name;
}
function toolIcon(name) {
  return { web_search: 'globe', open_url: 'globe', generate_image: 'image', save_memory: 'memory' }[name] || 'gear';
}

function fmtTok(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

/** One tool record inside the process area: a single plain-text line (small icon, name, arguments, status), with search and page results listed as small links
 *  过程区里的一条工具记录:纯文本一行(小图标 + 名称 + 参数 + 状态),搜索/网页结果作为小链接列出 */
function procToolHtml(p) {
  const q = p.input?.query || p.input?.url || p.input?.prompt || p.input?.fact || '';
  const status = p.running
    ? '<wa-spinner style="font-size:11px"></wa-spinner>'
    : p.error ? '<span class="pt-err">✕</span>' : '<span class="pt-ok">✓</span>';
  let extra = '';
  if (p.error) {
    extra = `<div class="proc-hits pt-err">${esc(p.error)}</div>`;
  } else if (p.name === 'web_search' && Array.isArray(p.output) && p.output.length) {
    extra = `<div class="proc-hits">${p.output.map((h) => `<a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.title || h.url)}</a>`).join('')}</div>`;
  } else if (p.name === 'open_url' && p.output?.url) {
    extra = `<div class="proc-hits"><a href="${esc(p.output.url)}" target="_blank" rel="noopener noreferrer">${esc(p.output.title || p.output.url)}</a></div>`;
  }
  return `<div class="proc-tool">${icon(toolIcon(p.name), 13)}<span class="pt-label">${esc(toolLabel(p.name))}</span><span class="pt-q" title="${esc(String(q))}">${esc(String(q).slice(0, 80))}</span>${status}</div>${extra}`;
}

/** Process area: reasoning, tool calls and the asides between tools, in chronological order, tucked behind one expandable plain-text line (no frame, no background)
 *  过程区:思考 + 工具调用 + 工具间旁白,按时间顺序收在一行可展开的纯文本后面(无框无背景) */
function processHtml(steps, meta, live) {
  const bits = [];
  if (meta?.think_ms) bits.push((meta.think_ms / 1000).toFixed(1) + 's');
  // Platforms do not always report reasoning tokens separately, so fall back to output tokens when they are missing
  // 平台不一定单独报思考 token,缺失时用输出 token 兜底
  const tok = meta?.usage?.reasoning ?? meta?.usage?.output;
  if (tok) bits.push(fmtTok(tok) + ' tokens');
  const label = t('c_thinking') + (bits.length ? ' · ' + bits.join(' · ') : '');
  let inner = '';
  for (const s of steps) {
    if (s.type === 'reasoning') inner += `<div class="proc-think">${esc(s.text)}</div>`;
    else if (s.type === 'note') inner += `<div class="proc-think proc-note">${esc(s.text)}</div>`;
    else inner += procToolHtml(s);
  }
  return `<details class="chat-proc"${live ? ' open' : ''}>
    <summary class="${live ? 'think-pulse' : ''}">${icon('memory', 13)}<span>${esc(label)}</span></summary>
    <div class="proc-body">${inner}</div>
  </details>`;
}

/** Process area (the plain-text lines outside the bubble): reasoning, every tool, and the asides before the last tool
 *  过程区(气泡外的纯文本行):思考 + 全部工具 + 最后一个工具之前的旁白 */
function aiProcessHtml(m, streaming = false) {
  const parts = m.parts;
  const meta = parts.find((p) => p.type === 'meta');
  let lastToolIdx = -1;
  parts.forEach((p, i) => {
    if (p.type === 'tool') lastToolIdx = i;
  });
  const steps = [];
  parts.forEach((p, i) => {
    if (p.type === 'reasoning' || p.type === 'tool') steps.push(p);
    else if (p.type === 'text' && i < lastToolIdx && p.text.trim()) steps.push({ type: 'note', text: p.text });
  });
  return steps.length ? processHtml(steps, meta, streaming) : '';
}

/** Body: the text after the last tool plus any error goes into the bubble; generated images stand alone outside it
 *  正文:最后一个工具之后的文本 + 错误(进气泡);生成的图片单独裸图(不进气泡) */
function aiAnswerHtml(m) {
  const parts = m.parts;
  let lastToolIdx = -1;
  parts.forEach((p, i) => {
    if (p.type === 'tool') lastToolIdx = i;
  });
  let bubble = '';
  let images = '';
  parts.forEach((p, i) => {
    if (p.type === 'text' && i > lastToolIdx) bubble += `<div class="md-part">${renderMarkdown(p.text)}</div>`;
    else if (p.type === 'tool' && p.name === 'generate_image' && p.output?.file_id) {
      images += `<img class="gen-img" src="${fileUrl(p.output.file_id)}" alt="" loading="lazy">`;
    } else if (p.type === 'error') bubble += `<div class="chat-err">${esc(p.code ? tErr(p.code) : p.text)}</div>`;
  });
  return { bubble, images };
}

function aiMsgHtml(m) {
  const mLabel = modelOf(m.model)?.label || '';
  const hasText = m.parts.some((p) => p.type === 'text' && p.text.trim());
  const { bubble, images } = aiAnswerHtml(m);
  return `
  <div class="cmsg-ai" data-mid="${esc(m.id || '')}">
    <span class="ai-avatar">${icon('sparkle', 16)}</span>
    <div class="ai-col">
      ${aiProcessHtml(m)}
      ${bubble ? `<div class="ai-body">${bubble}</div>` : ''}
      ${images}
      <div class="ai-meta">
        ${mLabel ? `<span class="ai-model">${esc(mLabel)}</span>` : ''}
        ${hasText ? `<button class="msg-speak" data-speak="${esc(m.id || '')}" title="${esc(t('c_speak'))}" aria-label="${esc(t('c_speak'))}">${icon('speaker', 15)}</button>` : ''}
      </div>
    </div>
  </div>`;
}

// ---------- Read aloud (TTS; the model is configured per domain) ----------
// ---------- 朗读(TTS,模型按域配置) ----------

let speakAudio = null;
let speakBtn = null;

function stopSpeak() {
  if (speakAudio) {
    speakAudio.pause();
    speakAudio = null;
  }
  if (speakBtn) {
    speakBtn.innerHTML = icon('speaker', 15);
    speakBtn.classList.remove('speaking');
    speakBtn = null;
  }
}

async function speakMessage(mid, btn) {
  if (speakBtn === btn) return stopSpeak(); // 再点一次 = 停止
  stopSpeak();
  const m = cs.msgs.find((x) => x.id === mid);
  const text = (m?.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
  if (!text) return;
  speakBtn = btn;
  btn.innerHTML = '<wa-spinner style="font-size:13px"></wa-spinner>';
  try {
    const res = await fetch('/api/chat/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 1500) }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await res.blob());
    if (speakBtn !== btn) return URL.revokeObjectURL(url); // 期间被切走了
    speakAudio = new Audio(url);
    btn.innerHTML = icon('stop', 15);
    btn.classList.add('speaking');
    speakAudio.addEventListener('ended', () => {
      URL.revokeObjectURL(url);
      stopSpeak();
    });
    speakAudio.addEventListener('error', () => stopSpeak());
    await speakAudio.play();
  } catch (e) {
    stopSpeak();
    toast(e.message, true);
  }
}

function renderMsgs() {
  const inner = qs('#msgs-inner');
  if (!inner) return;
  if (!cs.msgs.length) {
    inner.innerHTML = `
    <div class="chat-welcome">
      ${icon('sparkle', 44)}
      <h2>${esc(t('c_welcome_title'))}</h2>
      <p>${esc(t('c_welcome'))}</p>
    </div>`;
    return;
  }
  let html = '';
  if (cs.summary) html += `<div class="chat-compact-chip" title="${esc(cs.summary.slice(0, 500))}">${esc(t('c_compact_note'))}</div>`;
  for (const m of cs.msgs) {
    html += m.role === 'user' ? `<div class="cmsg-user" data-mid="${esc(m.id || '')}">${userPartsHtml(m)}</div>` : aiMsgHtml(m);
  }
  inner.innerHTML = html;
  bindMdCopy(inner);
  scrollBottom(true);
}

function bindMdCopy(root) {
  root.querySelectorAll('.md-copy').forEach((b) => {
    if (b._bound) return;
    b._bound = true;
    b.addEventListener('click', () => {
      copyText(b.closest('.md-code')?.querySelector('code')?.textContent || '');
      toast(t('t_copied'));
    });
  });
}

function scrollBottom(force = false) {
  const box = qs('#chat-msgs');
  if (!box) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if (force || near) box.scrollTop = box.scrollHeight;
}

// ---------- Composer ----------
// ---------- 输入区 ----------

function renderModelPicker() {
  const dd = qs('#model-dd');
  if (!dd) return;
  const m = currentModel();
  const trigger = dd.querySelector('[slot="trigger"]');
  trigger.innerHTML = `${icon('sparkle', 14)}<span>${esc(m?.label || '?')}</span>`;
  dd.querySelectorAll('wa-dropdown-item').forEach((n) => n.remove());
  for (const x of cs.config?.models || []) {
    const item = document.createElement('wa-dropdown-item');
    item.value = x.id;
    item.type = 'checkbox';
    item.checked = x.id === (m?.id || '');
    item.innerHTML = `<div class="model-item">
      <span class="mi-name">${esc(x.label)}<span class="model-caps">${x.reasoning ? `<span class="cap">${esc(t('c_cap_think'))}</span>` : ''}${x.vision ? `<span class="cap">${esc(t('c_cap_vision'))}</span>` : ''}${x.tools ? `<span class="cap">${esc(t('c_cap_tools'))}</span>` : ''}</span></span>
      <span class="mi-desc">${esc(t(x.desc))}</span></div>`;
    dd.appendChild(item);
  }
  if (!dd._bound) {
    dd._bound = true;
    dd.addEventListener('wa-select', async (e) => {
      const id = e.detail?.item?.value;
      if (!id || !modelOf(id)) return;
      cs.model = id;
      localStorage.setItem('cfmail_chat_model', id);
      renderModelPicker();
      if (cs.sid) api('PATCH', `/api/chat/sessions/${cs.sid}`, { model: id }).catch(() => {});
    });
  }
}

function renderSendBtn() {
  const b = qs('#btn-send');
  if (!b) return;
  b.innerHTML = cs.streaming ? icon('stop', 18) : icon('arrow-up', 20);
  b.setAttribute('aria-label', cs.streaming ? t('c_stop') : t('c_send'));
}

function renderPendingAtts() {
  const box = qs('#pending-atts');
  if (!box) return;
  if (!cs.files.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = '';
  box.innerHTML = cs.files.map((f, i) => `
    <span class="pending-att">
      ${f.kind === 'image' && f.localUrl ? `<img src="${esc(f.localUrl)}" alt="">` : fileIcon(f.filename, 26)}
      <span class="pa-name">${esc(f.filename)}</span>
      ${f.uploading ? '<wa-spinner style="font-size:14px"></wa-spinner>' : ''}
      <span class="pa-x" data-i="${i}">${icon('close', 15)}</span>
    </span>`).join('');
  box.querySelectorAll('.pa-x').forEach((x) => {
    x.addEventListener('click', () => {
      cs.files.splice(+x.dataset.i, 1);
      renderPendingAtts();
    });
  });
}

function bindComposer() {
  const input = qs('#chat-input');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  qs('#btn-send').addEventListener('click', () => {
    if (cs.streaming) abortRun();
    else sendMessage();
  });
  qs('#btn-attach').addEventListener('click', () => qs('#file-input').click());
  qs('#file-input').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  // Dropping and pasting images
  // 拖放与粘贴图片
  const box = qs('.composer-box');
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  qs('#btn-newchat').addEventListener('click', () => navigate('#/chat'));
  qs('#btn-memory').addEventListener('click', openMemoryPanel);
  setTimeout(() => input.focus(), 100);
}

function bindSide() {
  const side = qs('#chat-side');
  qs('#btn-side').addEventListener('click', () => {
    if (matchMedia('(max-width: 760px)').matches) {
      const shown = side.style.display === 'flex';
      if (shown) {
        side.style.display = '';
        qs('.chat-side-backdrop')?.remove();
      } else {
        side.style.display = 'flex';
        const bd = document.createElement('div');
        bd.className = 'chat-side-backdrop';
        bd.addEventListener('click', () => {
          side.style.display = '';
          bd.remove();
        });
        qs('.chat-shell').appendChild(bd);
      }
    } else {
      side.classList.toggle('hidden');
    }
  });
  // The sidebar is hidden by default on mobile
  // 移动端默认隐藏侧栏
  if (matchMedia('(max-width: 760px)').matches) side.style.display = '';
}

async function addFiles(files) {
  for (const f of files) {
    if (cs.files.length >= 8) {
      toast(t('c_too_many_files'), true);
      break;
    }
    const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('audio/') ? 'audio' : 'file';
    const entry = {
      id: null, kind, filename: f.name, mime: f.type, uploading: true,
      localUrl: kind === 'image' ? URL.createObjectURL(f) : null,
    };
    cs.files.push(entry);
    renderPendingAtts();
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await api('POST', '/api/chat/uploads', fd);
      entry.id = r.id;
      entry.kind = r.kind;
      entry.uploading = false;
    } catch (e) {
      cs.files = cs.files.filter((x) => x !== entry);
      toast(t('t_upload_fail', e.message), true);
    }
    renderPendingAtts();
  }
}

// ---------- Sending and streaming ----------
// ---------- 发送与流式接收 ----------

let streamCtl = null;

async function sendMessage() {
  const input = qs('#chat-input');
  const text = input.value.trim();
  if (cs.streaming) return;
  if (!text && !cs.files.filter((f) => f.id).length) return;
  if (cs.files.some((f) => f.uploading)) return toast(t('atts_uploading'), true);

  // A new conversation: store it first to obtain an id, then replace the address without triggering the router
  // 新对话:先落库拿 id,替换地址但不触发路由
  if (!cs.sid) {
    try {
      const s = await api('POST', '/api/chat/sessions', { model: cs.model });
      cs.sessions.unshift(s);
      cs.sid = s.id;
      history.replaceState(null, '', `#/chat/${s.id}`);
      store.routeKey = location.hash;
      renderSessList();
    } catch (e) {
      return toast(e.message, true);
    }
  }

  const files = cs.files.filter((f) => f.id);
  const optimistic = {
    id: 'local-' + Date.now(),
    role: 'user',
    parts: [
      ...(text ? [{ type: 'text', text }] : []),
      ...files.map((f) => ({ type: 'file', file_id: f.id, kind: f.kind, filename: f.filename, mime: f.mime })),
    ],
  };
  if (!cs.msgs.length) qs('#msgs-inner').innerHTML = cs.summary ? qs('#msgs-inner').innerHTML : '';
  qs('.chat-welcome')?.remove();
  cs.msgs.push(optimistic);
  qs('#msgs-inner').insertAdjacentHTML('beforeend', `<div class="cmsg-user" data-mid="${esc(optimistic.id)}">${userPartsHtml(optimistic)}</div>`);
  input.value = '';
  input.style.height = 'auto';
  cs.files = [];
  renderPendingAtts();
  scrollBottom(true);

  cs.streaming = true;
  renderSendBtn();
  streamCtl = new AbortController();

  // Container for the streaming assistant message
  // 流式助手消息容器
  const streamMsg = { id: 'streaming', role: 'assistant', parts: [], model: cs.model };
  qs('#msgs-inner').insertAdjacentHTML('beforeend', `
    <div class="cmsg-ai" id="streaming-msg">
      <span class="ai-avatar">${icon('sparkle', 16)}</span>
      <div class="ai-col" id="streaming-col"><div class="ai-body"><span class="stream-caret"></span></div></div>
    </div>`);
  scrollBottom(true);

  try {
    const res = await fetch(`/api/chat/sessions/${cs.sid}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, files: files.map((f) => f.id), model: cs.model, lang: lang() }),
      signal: streamCtl.signal,
    });
    if (!res.ok || !res.headers.get('Content-Type')?.includes('event-stream')) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }
    await readStream(res.body, streamMsg);
  } catch (e) {
    if (e.name !== 'AbortError') {
      streamMsg.parts.push({ type: 'error', text: e.message });
      toast(e.message, true);
    }
  }
  finishStream(streamMsg);
}

async function readStream(body, streamMsg) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop();
    for (const ch of chunks) {
      const line = ch.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      handleEvent(ev, streamMsg);
    }
  }
}

let mdTimer = null;
function handleEvent(ev, streamMsg) {
  if (!qs('#streaming-col')) return;
  if (ev.t === 'user') {
    // The user message the server has already stored, replacing the local placeholder id
    // 服务端已入库的 user 消息,替换本地占位 id
    const local = cs.msgs.findLast?.((m) => m.role === 'user') || cs.msgs[cs.msgs.length - 1];
    if (local && ev.message?.id) local.id = ev.message.id;
    return;
  }
  if (ev.t === 'delta') {
    const last = streamMsg.parts[streamMsg.parts.length - 1];
    if (last && last.type === ev.kind) last.text += ev.text;
    else streamMsg.parts.push({ type: ev.kind, text: ev.text });
    scheduleStreamRender(streamMsg);
    return;
  }
  if (ev.t === 'tool') {
    streamMsg.parts.push({ type: 'tool', call_id: ev.call_id, name: ev.name, input: ev.input, running: true });
    renderStreaming(streamMsg);
    return;
  }
  if (ev.t === 'tool_result' || ev.t === 'tool_error') {
    const p = streamMsg.parts.find((x) => x.type === 'tool' && x.call_id === ev.call_id);
    if (p) {
      p.running = false;
      if (ev.t === 'tool_result') p.output = ev.output;
      else p.error = ev.error;
    }
    renderStreaming(streamMsg);
    return;
  }
  if (ev.t === 'title') {
    const sess = cs.sessions.find((s) => s.id === cs.sid);
    if (sess) {
      sess.title = ev.title;
      renderSessList();
      renderTitle();
    }
    return;
  }
  if (ev.t === 'done') {
    streamMsg.final = ev.message;
    return;
  }
  if (ev.t === 'error') {
    streamMsg.parts.push({ type: 'error', text: ev.error });
    renderStreaming(streamMsg);
  }
}

function scheduleStreamRender(streamMsg) {
  if (mdTimer) return;
  mdTimer = requestAnimationFrame(() => {
    mdTimer = null;
    renderStreaming(streamMsg);
  });
}

function renderStreaming(streamMsg) {
  const col = qs('#streaming-col');
  if (!col) return;
  const proc = aiProcessHtml(streamMsg, true);
  const { bubble, images } = aiAnswerHtml(streamMsg);
  let html = proc;
  if (bubble) html += `<div class="ai-body">${bubble}<span class="stream-caret"></span></div>`;
  else if (!proc) html += `<div class="ai-body"><span class="stream-caret"></span></div>`;
  html += images;
  col.innerHTML = html;
  // The process area scrolls itself to the bottom
  // 过程区自动滚到底
  const tb = col.querySelector('details[open] .proc-body');
  if (tb) tb.scrollTop = tb.scrollHeight;
  bindMdCopy(col);
  scrollBottom();
}

function finishStream(streamMsg) {
  cs.streaming = false;
  streamCtl = null;
  renderSendBtn();
  if (mdTimer) {
    cancelAnimationFrame(mdTimer);
    mdTimer = null;
  }
  const el = qs('#streaming-msg');
  const finalMsg = streamMsg.final || { id: 'local-a-' + Date.now(), role: 'assistant', parts: streamMsg.parts, model: cs.model };
  cs.msgs.push(finalMsg);
  if (el) el.outerHTML = aiMsgHtml(finalMsg);
  bindMdCopy(qs('#msgs-inner'));
  scrollBottom();
  // Move the session to the top
  // 会话排到最前
  const sess = cs.sessions.find((s) => s.id === cs.sid);
  if (sess) {
    sess.updated_at = Date.now();
    cs.sessions.sort((a, b) => b.updated_at - a.updated_at);
    renderSessList();
  }
}

async function abortRun() {
  if (!cs.sid) return;
  try {
    await api('POST', `/api/chat/sessions/${cs.sid}/abort`);
  } catch {}
}

// ---------- Memory panel ----------
// ---------- 记忆面板 ----------

async function openMemoryPanel() {
  let memories = [];
  try {
    memories = (await api('GET', '/api/chat/memories')).memories;
  } catch (e) {
    return toast(e.message, true);
  }
  const listHtml = () =>
    memories.length
      ? `<div class="mem-list">${memories.map((m) => `
          <div class="mem-item" data-id="${esc(m.id)}">
            <span class="mc">${esc(m.content)}</span>
            <span class="md">${fmtDate(m.updated_at)}</span>
            <wa-button class="icon" appearance="plain" size="small" data-del="${esc(m.id)}" aria-label="${esc(t('delete'))}">${icon('trash', 15)}</wa-button>
          </div>`).join('')}</div>`
      : `<p class="dim">${esc(t('c_mem_empty'))}</p>`;
  const d = showModal(`
    <div class="modal-body">
      <h3 style="margin:0 0 6px;display:flex;align-items:center;gap:8px">${icon('memory', 18)} ${esc(t('c_mem_title'))}</h3>
      <p class="dim" style="margin:0 0 10px;font-size:12.5px">${esc(t('c_mem_note'))}</p>
      <div id="mem-box">${listHtml()}</div>
    </div>
    <div slot="footer" style="display:flex;gap:8px;justify-content:space-between">
      <wa-button appearance="plain" data-x="clear" ${memories.length ? '' : 'disabled'}>${esc(t('c_mem_clear'))}</wa-button>
      <wa-button variant="brand" data-x="close">${esc(t('confirm'))}</wa-button>
    </div>`);
  d.addEventListener('click', async (e) => {
    const del = e.target.closest?.('[data-del]');
    if (del) {
      const id = del.dataset.del;
      try {
        await api('DELETE', `/api/chat/memories/${id}`);
        memories = memories.filter((m) => m.id !== id);
        qs('#mem-box', d).innerHTML = listHtml();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    const b = e.target.closest?.('[data-x]');
    if (!b) return;
    if (b.dataset.x === 'clear') {
      if (!(await confirmDialog(t('c_mem_clear_confirm'), t('c_mem_clear')))) return;
      try {
        await api('DELETE', '/api/chat/memories');
        memories = [];
        qs('#mem-box', d).innerHTML = listHtml();
      } catch (err) {
        toast(err.message, true);
      }
    } else closeModal();
  });
}
