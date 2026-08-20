import { api } from './api.js';
import { esc, icon, qs, qsa, toast, fmtDate, fmtDateTime, fmtSize, fileIcon, avatar, confirmDialog, cleanSnippet, showModal, closeModal } from './ui.js';
import { t, tStored } from './i18n.js';
import { store, renderShell, bindShell, show, loadFolders, navigate, refreshMe, folderName } from './app.js';
import { openCompose } from './compose.js';
import { sanitizeQuoteHtml, htmlToPlainText } from './richtext.js';

// The three things a mailbox can say about a correspondent. Kept in step with Trust in
// src/types.ts; anything else read off the wire is treated as unknown, never as trusted.
// 一个邮箱对往来对象能说的三句话。与 src/types.ts 的 Trust 保持一致;
// 从网络上读到的其它值一律当未知,绝不当可信。
const TRUSTS = ['trusted', 'unknown', 'risk'];
const pickTrust = (v) => (TRUSTS.includes(v) ? v : 'unknown');
import {
  BUILTIN, allLabels, labelById, labelName, labelMark, chipHtml, rowLabelsHtml,
  openLabelMenu, lastLabel, loadLabels,
} from './labels.js';

// ---------- Conversation list ----------
// ---------- 会话列表 ----------

let listState = { page: 0, hasMore: false, folder: 'inbox', q: '' };
let sel = { active: false, ids: new Set() };
let currentThreads = [];
// The messages of the conversation on screen. The label controls read from it so that clicking
// one reflects immediately, without refetching the whole conversation.
// 当前屏幕上这个会话的邮件。标签控件从它读取,点一下就即时反映,不用重新拉整个会话。
let currentMsgs = [];

export async function renderList(folder, q, page = 0) {
  await loadFolders();
  // Leave multi-select when the folder or search changes
  // 切换文件夹/搜索时退出多选
  if (folder !== listState.folder || q !== listState.q) sel = { active: false, ids: new Set() };
  listState = { page, hasMore: false, folder, q };
  const params = new URLSearchParams();
  // "label:名字" narrows a search instead of replacing it, so it is lifted out of the query text
  // and sent alongside what remains. Resolving the name here rather than on the server is what
  // lets the built-in label be found by its translated name.
  // "label:名字" 是把搜索收窄而不是取代它,所以从查询文本里摘出来、与剩下的部分一起发。
  // 名字在这里解析而不是在服务端,内置标签才可能按它被翻译后的名字找到。
  const { text: qText, labelId: qLabel } = splitLabelQuery(q);
  if (qText) params.set('q', qText);
  else if (folder !== 'label') params.set('folder', folder === 'search' ? 'inbox' : folder);
  const activeLabel = folder === 'label' ? store.labelId : qLabel;
  if (activeLabel) params.set('label', activeLabel);
  params.set('page', String(page));
  let data;
  try {
    data = await api('GET', `/api/mailboxes/${store.mbId}/threads?${params}`);
  } catch (e) {
    show(renderShell(`<div class="empty">${esc(e.message)}</div>`));
    bindShell();
    return;
  }
  listState.hasMore = data.has_more;
  currentThreads = data.threads;
  const title = folder === 'label'
    ? labelName(labelById(store.labelId)) || t('lbl_title')
    : q ? t('search_title', q) : folderName(folder);
  const rows = data.threads.map((th) => rowHtml(th, folder)).join('');

  const normalBar = `
    <div class="list-toolbar">
      <wa-button class="icon" appearance="plain" id="btn-refresh" aria-label="${esc(t('refresh'))}">${icon('refresh', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" id="btn-multi" aria-label="${esc(t('multi_select'))}">${icon('select', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" id="btn-compose-sm" aria-label="${esc(t('compose'))}">${icon('pencil', 20)}</wa-button>
      <span class="list-title">${esc(title)}</span>
      <span class="flex1"></span>
      <span class="pageinfo">${esc(t('page_n', page + 1, data.pages || 1))}</span>
      <wa-button class="icon" appearance="plain" id="btn-prev" ${page === 0 ? 'disabled' : ''} aria-label="${esc(t('prev_page'))}">${icon('back', 18)}</wa-button>
      <wa-button class="icon" appearance="plain" id="btn-next" ${data.has_more ? '' : 'disabled'} aria-label="${esc(t('next_page'))}">${icon('next', 18)}</wa-button>
    </div>`;
  const selBar = `
    <div class="list-toolbar sel-toolbar">
      <wa-button class="icon" appearance="plain" id="btn-sel-exit" aria-label="${esc(t('exit_select'))}">${icon('close', 20)}</wa-button>
      <label class="sel-all-wrap"><input type="checkbox" id="sel-all"> <span class="list-title">${esc(t('selected_n', sel.ids.size))}</span></label>
      <span class="flex1"></span>
      ${folder !== 'archive' && folder !== 'trash' && folder !== 'spam' ? `<wa-button class="icon" appearance="plain" data-batch="archive" aria-label="${esc(t('archive'))}">${icon('archive', 20)}</wa-button>` : ''}
      ${folder === 'trash' || folder === 'spam' ? `<wa-button class="icon" appearance="plain" data-batch="inbox" aria-label="${esc(t('restore_inbox'))}">${icon('inbox', 20)}</wa-button>` : `<wa-button class="icon" appearance="plain" data-batch="spam" aria-label="${esc(t('report_spam'))}">${icon('spam', 20)}</wa-button><wa-button class="icon" appearance="plain" data-batch="trash" aria-label="${esc(t('delete'))}">${icon('trash', 20)}</wa-button>`}
      <wa-button class="icon" appearance="plain" data-batch="read" aria-label="${esc(t('mark_read'))}">${icon('markRead', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" data-batch="unread" aria-label="${esc(t('mark_unread'))}">${icon('mail', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" id="btn-sel-label" aria-label="${esc(t('lbl_title'))}">${icon('tag', 20)}</wa-button>
    </div>`;

  const content = `${sel.active ? selBar : normalBar}
    <div class="rows ${sel.active ? 'sel-mode' : ''}">${rows || `<div class="empty">${esc(q ? t('empty_search') : t('empty_folder'))}</div>`}</div>
    <div class="ctx-menu" id="ctx-menu" hidden></div>`;
  show(renderShell(content));
  bindShell();
  bindList(folder, q);
}

function safeParse(s) {
  try { return JSON.parse(s || '[]'); } catch { return []; }
}

/**
 * Pull a label: term out of a search box query. The name may be quoted, because label names
 * contain spaces as often as any other name does. An unmatched name is left in the text rather
 * than silently dropped -- searching for the literal words is a better answer than searching
 * for nothing.
 * 从搜索框的查询里摘出 label: 词。名字可以加引号 —— 标签名和别的名字一样,常常带空格。
 * 匹配不上的名字会留在文本里而不是被悄悄丢掉:按字面去搜,好过什么都不搜。
 */
function splitLabelQuery(q) {
  const raw = String(q || '');
  const m = raw.match(/(^|\s)label:("([^"]+)"|\S+)/i);
  if (!m) return { text: raw.trim(), labelId: '' };
  const name = (m[3] || m[2] || '').trim().toLowerCase();
  const hit = allLabels().find((l) => labelName(l).toLowerCase() === name);
  if (!hit) return { text: raw.trim(), labelId: '' };
  return { text: (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim(), labelId: hit.id };
}

function senderLine(th, folder) {
  if (th.draft_id) return `<span class="draft-red">${esc(t('draft'))}</span>`;
  if (folder === 'sent') {
    const tos = safeParse(th.to_json).map((a) => a.name || a.addr.split('@')[0]);
    return esc(t('sent_to', tos.slice(0, 3).join(', ') || t('no_subject')));
  }
  if (th.direction === 'out') return esc(t('me'));
  return esc(th.from_name || (th.from_addr || '').split('@')[0] || '?');
}

function rowHtml(th, folder) {
  const unread = (th.unread || 0) > 0;
  const cntSuffix = th.cnt > 1 ? ` <span class="cnt">(${th.cnt})</span>` : '';
  // Cleaning can empty the snippet entirely (a body that is just a link), in which case drop the separator too
  // 清洗后可能整条为空(正文只有一个链接),那就连分隔符一起省掉
  const snip = cleanSnippet(th.snippet);
  const snipHtml = snip ? `<span class="row-snip"> — ${esc(snip)}</span>` : '';
  if (th.draft_id) {
    return `
    <div class="row" data-draft="${esc(th.draft_id)}">
      <span class="row-star" style="width:32px"></span>
      <span class="row-from"><span class="draft-red">${esc(t('draft'))}</span></span>
      <span class="row-main"><span class="row-subj">${esc(th.subject || t('no_subject'))}</span>${snipHtml}</span>
      <span class="row-date">${fmtDate(th.last_date)}</span>
      <span class="row-actions"><wa-button class="icon sm" appearance="plain" data-act="discard" aria-label="${esc(t('discard_draft'))}">${icon('trash', 18)}</wa-button></span>
    </div>`;
  }
  const checked = sel.ids.has(th.thread_id);
  // The label cell stays in multi-select too: having picked a batch, the natural place to click
  // is the same cell you would click for one -- so it is there, and it acts on the whole batch.
  // 多选模式下标签位照样在:选好一批之后,你最自然会点的还是那一格 ——
  // 那就让它在,并且作用于整批。
  const lead = sel.active
    ? `<span class="row-check"><input type="checkbox" ${checked ? 'checked' : ''} tabindex="-1"></span>${rowLabelsHtml(th)}`
    : rowLabelsHtml(th);
  return `
  <div class="row ${unread ? 'unread' : ''} ${checked ? 'selected' : ''}" data-tid="${esc(th.thread_id)}">
    ${lead}
    <span class="row-from">${senderLine(th, folder)}${cntSuffix}</span>
    <span class="row-main">
      <span class="row-subj">${esc(th.subject || t(th.parse_status === 'failed' ? 'parsing' : 'no_subject'))}</span>${snipHtml}
    </span>
    ${th.hasatt ? `<span class="row-clip">${icon('attach', 16)}</span>` : ''}
    <span class="row-date">${fmtDate(th.last_date)}</span>
    <span class="row-actions">
      ${folder !== 'archive' && folder !== 'trash' && folder !== 'spam' ? `<wa-button class="icon sm" appearance="plain" data-act="archive" aria-label="${esc(t('archive'))}">${icon('archive', 18)}</wa-button>` : ''}
      ${folder === 'trash' || folder === 'spam' ? `<wa-button class="icon sm" appearance="plain" data-act="inbox" aria-label="${esc(t('restore_inbox'))}">${icon('inbox', 18)}</wa-button>` : `<wa-button class="icon sm" appearance="plain" data-act="trash" aria-label="${esc(t('delete'))}">${icon('trash', 18)}</wa-button>`}
      <wa-button class="icon sm" appearance="plain" data-act="forward" aria-label="${esc(t('forward'))}">${icon('forward', 18)}</wa-button>
      <wa-button class="icon sm" appearance="plain" data-act="${unread ? 'read' : 'unread'}" aria-label="${esc(unread ? t('mark_read') : t('mark_unread'))}">${icon(unread ? 'markRead' : 'mail', 18)}</wa-button>
    </span>
  </div>`;
}

const reRender = (folder, q) => renderList(folder, q, listState.page);

function bindList(folder, q) {
  qs('#btn-refresh')?.addEventListener('click', () => reRender(folder, q));
  qs('#btn-prev')?.addEventListener('click', () => renderList(folder, q, Math.max(0, listState.page - 1)));
  qs('#btn-next')?.addEventListener('click', () => renderList(folder, q, listState.page + 1));
  qs('#btn-compose-sm')?.addEventListener('click', () => openCompose({ mbId: store.mbId }));
  qs('#btn-multi')?.addEventListener('click', () => { sel = { active: true, ids: new Set() }; reRender(folder, q); });
  qs('#btn-sel-exit')?.addEventListener('click', () => { sel = { active: false, ids: new Set() }; reRender(folder, q); });

  // Multi-select: select all
  // 多选:全选
  qs('#sel-all')?.addEventListener('change', (e) => {
    if (e.target.checked) currentThreads.forEach((th) => th.thread_id && sel.ids.add(th.thread_id));
    else sel.ids.clear();
    reRender(folder, q);
  });
  // Multi-select: bulk actions
  // 多选:批量操作
  qs('#btn-sel-label')?.addEventListener('click', (e) => {
    const ids = [...sel.ids];
    if (!ids.length) return toast(t('selected_n', 0), true);
    const r = e.currentTarget.getBoundingClientRect();
    openThreadLabelMenu(r.left, r.bottom + 4, ids, folder, q);
  });
  qsa('[data-batch]').forEach((b) =>
    b.addEventListener('click', async () => {
      const action = b.dataset.batch;
      const ids = [...sel.ids];
      if (!ids.length) return toast(t('selected_n', 0), true);
      for (const tid of ids) await threadAction(tid, action);
      toast(t('action_done'));
      sel = { active: false, ids: new Set() };
      reRender(folder, q);
    })
  );

  const setRowSelected = (row, on) => {
    row.classList.toggle('selected', on);
    const cb = row.querySelector('.row-check input');
    if (cb) cb.checked = on;
    const label = qs('.sel-toolbar .list-title');
    if (label) label.textContent = t('selected_n', sel.ids.size);
  };

  /**
   * Shift-click: add everything between the clicked row and the nearer end of what is already
   * selected. Anchoring on the nearer end (rather than on the last row you touched) means the
   * gesture reads the same whether you are reaching upwards or downwards, and it never throws
   * away the existing selection -- it only ever grows it.
   *
   * shift 点击:把点击行与既有选区中较近的那一端之间的行全部选上。以"较近的一端"为锚点
   * (而不是"上一次点过的行"),向上够和向下够的手感就一致;并且只会扩大选区,不会清掉已选的。
   */
  const selectRangeTo = (tid) => {
    const rows = qsa('.row[data-tid]');
    const ids = rows.map((r) => r.dataset.tid);
    const hit = ids.indexOf(tid);
    if (hit < 0) return;
    const picked = ids.map((id, i) => (sel.ids.has(id) ? i : -1)).filter((i) => i >= 0);
    if (!picked.length) return;
    const lo = picked[0];
    const hi = picked[picked.length - 1];
    // Nearer end wins; inside the selection either end is equally close, so lo is as good as hi
    // 取较近的一端;点在选区内部时两端一样近,取 lo 即可
    const anchor = Math.abs(hit - lo) <= Math.abs(hit - hi) ? lo : hi;
    for (let i = Math.min(anchor, hit); i <= Math.max(anchor, hit); i++) sel.ids.add(ids[i]);
    rows.forEach((r) => setRowSelected(r, sel.ids.has(r.dataset.tid)));
  };

  qsa('.row').forEach((row) => {
    // Context menu (works in both modes)
    // 右键菜单(两种模式都支持)
    if (row.dataset.tid) {
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const tid = row.dataset.tid;
        // Right-clicking an unselected row while in multi-select: select it first, then act on the whole selection
        // 多选模式下右键未选中项:先把它选上,再对整个选区操作
        if (sel.active && !sel.ids.has(tid)) {
          sel.ids.add(tid);
          setRowSelected(row, true);
        }
        showRowMenu(e.clientX, e.clientY, tid, folder, q);
      });
    }
    // Multi-select: clicking anywhere on a row toggles it; shift-click extends from whichever
    // end of the existing selection is nearer to the row you clicked.
    // 多选模式:整行点击切换选中;shift 点击则从既有选区中离点击处较近的那一端延伸过来。
    if (sel.active && row.dataset.tid) {
      row.addEventListener('click', (e) => {
        const tid = row.dataset.tid;
        // Clicking the label cell is not a selection gesture. Aimed at a row inside the
        // selection it acts on the whole selection; aimed at one outside it, only on that row --
        // the same rule the right-click menu follows.
        // 点标签位不是"选择"这个动作。点在选区之内的行上,作用于整个选区;
        // 点在选区之外的行上,只作用于那一行 —— 与右键菜单同一条规则。
        const lb = e.target.closest('[data-act="labels"]');
        if (lb) {
          e.stopPropagation();
          const r = lb.getBoundingClientRect();
          const targets = sel.ids.has(tid) ? [...sel.ids] : [tid];
          openThreadLabelMenu(r.left, r.bottom + 4, targets, folder, q);
          return;
        }
        if (e.shiftKey && sel.ids.size) {
          selectRangeTo(tid);
          return;
        }
        if (sel.ids.has(tid)) sel.ids.delete(tid);
        else sel.ids.add(tid);
        setRowSelected(row, sel.ids.has(tid));
      });
      return;
    }
    // Ordinary click
    // 普通点击
    row.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      const draftId = row.dataset.draft;
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (draftId && act === 'discard') {
          await api('DELETE', `/api/drafts/${draftId}`);
          reRender(folder, q);
          return;
        }
        const tid = row.dataset.tid;
        if (act === 'forward') { await forwardThread(tid); return; }
        if (act === 'labels') {
          const r = btn.getBoundingClientRect();
          openThreadLabelMenu(r.left, r.bottom + 4, [tid], folder, q);
          return;
        }
        await threadAction(tid, act);
        reRender(folder, q);
        return;
      }
      if (draftId) {
        const d = await api('GET', `/api/mailboxes/${store.mbId}/drafts/${draftId}`);
        openCompose({ mbId: store.mbId, draftId, ...d.payload });
        return;
      }
      navigate(`#/mb/${store.mbId}/thread/${row.dataset.tid}`);
    });
  });
}

// ---------- Right-click context menu ----------
// ---------- 右键上下文菜单 ----------

/** One message's marks, for the head of its header row. Same shape as a list row's cell.
 *  单封邮件的记号,放在它标题行的头上。形状与列表行那一格一致。 */
function msgLabelsHtml(m) {
  const marks = [...(m.flag_flagged ? [BUILTIN] : []), ...(m.labels || [])].map(labelById).filter(Boolean);
  if (!marks.length) return `<span class="lb-empty">${icon('star', 18)}</span>`;
  return marks.map((l) => labelMark(l, 18)).join('');
}

/** The same labels with their names, shown above an opened message where there is room for them
 *  同样这些标签,带上名字,显示在展开的邮件正文上方 —— 那里放得下 */
function msgChipsHtml(m) {
  const marks = [...(m.flag_flagged ? [BUILTIN] : []), ...(m.labels || [])].map(labelById).filter(Boolean);
  if (!marks.length) return '<div class="msg-labels msg-chips"></div>';
  return `<div class="msg-labels msg-chips">${marks.map((l) => chipHtml(l, { removable: true })).join('')}</div>`;
}

const idsOfThread = (th) => new Set([...(th?.starred ? [BUILTIN] : []), ...(th?.labels || [])]);

function showRowMenu(x, y, tid, folder, q) {
  const menu = qs('#ctx-menu');
  if (!menu) return;
  // In multi-select act on the whole selection; otherwise only on the row that was right-clicked
  // 多选模式:对整个选区操作;否则只对右键那一项
  const targets = sel.active ? [...sel.ids] : [tid];
  const single = targets.length === 1;
  const th = currentThreads.find((t2) => t2.thread_id === targets[0]) || {};
  const unread = (th.unread || 0) > 0;
  const inJunk = folder === 'trash' || folder === 'spam';

  const items = [];
  if (sel.active) items.push({ head: t('selected_n', targets.length) });
  if (single) items.push({ act: 'open', icon: 'mail', label: t('open') });
  items.push(unread ? { act: 'read', icon: 'markRead', label: t('mark_read') } : { act: 'unread', icon: 'mail', label: t('mark_unread') });
  // One entry, no submenu: the label you used last, which is the one you are most likely to want
  // again. Anything else is one click away on the row's own label cell.
  // 就一条,没有二级菜单:你上次用过的那个标签,也就是你最可能再要一次的那个。
  // 要别的,点行首那一格,一下就到。
  const recent = lastLabel();
  if (recent) {
    const on = single && idsOfThread(th).has(recent.id);
    items.push({
      act: on ? 'unlabel' : 'label',
      mark: labelMark(recent, 18),
      label: t(on ? 'lbl_remove' : 'lbl_apply', labelName(recent)),
      arg: recent.id,
    });
  }
  if (single) items.push({ act: 'forward', icon: 'forward', label: t('forward') });
  items.push({ sep: true });
  if (!inJunk) {
    items.push({ act: 'archive', icon: 'archive', label: t('archive') });
    items.push({ act: 'spam', icon: 'spam', label: t('report_spam') });
    items.push({ act: 'trash', icon: 'trash', label: t('delete'), danger: true });
  } else {
    items.push({ act: 'inbox', icon: 'inbox', label: t('restore_inbox') });
    items.push({ act: 'delete_forever', icon: 'close', label: t('purge_forever'), danger: true });
  }
  menu.innerHTML = items
    .map((it) => {
      if (it.sep) return '<div class="ctx-sep"></div>';
      if (it.head) return `<div class="ctx-title">${esc(it.head)}</div>`;
      return `<button class="ctx-item ${it.danger ? 'danger' : ''}" data-act="${it.act}" ${it.arg ? `data-arg="${esc(it.arg)}"` : ''}>${it.mark || icon(it.icon, 18)}<span>${esc(it.label)}</span></button>`;
    })
    .join('');
  menu.hidden = false;
  // Positioning (keep it inside the viewport)
  // 定位(避免超出视口)
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, vw - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, vh - rect.height - 8) + 'px';

  const close = () => { menu.hidden = true; document.removeEventListener('click', close); document.removeEventListener('scroll', close, true); };
  menu.querySelectorAll('.ctx-item').forEach((b) =>
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      close();
      const act = b.dataset.act;
      if (act === 'label' || act === 'unlabel') {
        for (const id of targets) {
          await api('POST', `/api/mailboxes/${store.mbId}/threads/${id}/label`, { label: b.dataset.arg, on: act === 'label' })
            .catch((e) => toast(e.message, true));
        }
        if (sel.active) sel = { active: false, ids: new Set() };
        await loadLabels();
        return reRender(folder, q);
      }
      if (act === 'open') return navigate(`#/mb/${store.mbId}/thread/${targets[0]}`);
      if (act === 'forward') return forwardThread(targets[0]);
      if (act === 'delete_forever' && !(await confirmDialog(t('purge_confirm'), t('purge_forever')))) return;
      for (const id of targets) await threadAction(id, act);
      if (sel.active) sel = { active: false, ids: new Set() };
      reRender(folder, q);
    })
  );
  setTimeout(() => {
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);
  }, 0);
}

/**
 * The picker, aimed at one or more conversations. What each label shows -- on, off, or mixed --
 * is read from the conversations themselves, so with several selected you can tell at a glance
 * whether clicking will add the label or take it away.
 * 选择器,作用于一个或多个会话。每个标签显示"有/没有/部分有"是从会话本身读出来的,
 * 于是选中多个时,你一眼就知道点下去是加还是减。
 */
function openThreadLabelMenu(x, y, tids, folder, q) {
  const idsOf = (tid) => {
    const th = currentThreads.find((t2) => t2.thread_id === tid) || {};
    return new Set([...(th.starred ? [BUILTIN] : []), ...(th.labels || [])]);
  };
  const sets = tids.map(idsOf);
  openLabelMenu(x, y, {
    has: (id) => {
      const n = sets.filter((set) => set.has(id)).length;
      return n === 0 ? 'off' : n === sets.length ? 'on' : 'mixed';
    },
    toggle: async (id, on) => {
      for (const tid of tids) {
        await api('POST', `/api/mailboxes/${store.mbId}/threads/${tid}/label`, { label: id, on });
      }
    },
    onDone: async () => { await loadLabels(); reRender(folder, q); },
  });
}

async function threadAction(tid, action) {
  try {
    await api('POST', `/api/mailboxes/${store.mbId}/threads/${tid}/action`, { action });
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- Conversation detail ----------
// ---------- 会话详情 ----------

export async function renderThread(tid) {
  await loadFolders();
  let data;
  try {
    data = await api('GET', `/api/mailboxes/${store.mbId}/threads/${tid}`);
  } catch (e) {
    show(renderShell(`<div class="empty">${esc(e.message)}</div>`));
    bindShell();
    return;
  }
  const msgs = data.messages;
  currentMsgs = msgs;
  const anyUnread = msgs.some((m) => !m.flag_seen);
  const roles = new Set(msgs.map((m) => m.folder_role));
  const inTrash = roles.has('trash') || roles.has('spam');
  const backFolder = store.folder || 'inbox';

  const content = `
    <div class="list-toolbar">
      <wa-button class="icon" appearance="plain" id="btn-back" aria-label="${esc(t('back'))}">${icon('back', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" id="t-archive" aria-label="${esc(t('archive'))}">${icon('archive', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" id="t-spam" aria-label="${esc(t('report_spam'))}">${icon('spam', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" id="t-trash" aria-label="${esc(t('delete'))}">${icon('trash', 20)}</wa-button>
      <wa-button class="icon" appearance="plain" id="t-unread" aria-label="${esc(t('mark_unread'))}">${icon('mail', 20)}</wa-button>
      ${inTrash ? `<wa-button class="icon" appearance="plain" id="t-restore" aria-label="${esc(t('restore_inbox'))}">${icon('inbox', 20)}</wa-button>
      <wa-button class="icon danger" appearance="plain" id="t-purge" aria-label="${esc(t('purge_forever'))}">${icon('close', 20)}</wa-button>` : ''}
    </div>
    <div class="thread">
      <h1 class="t-subject">${esc(data.subject || t('no_subject'))}</h1>
      <div class="msgs">${msgs.map((m, i) => msgHtml(m, i === msgs.length - 1)).join('')}</div>
      <div class="replybox">
        <div class="replybox-inner">
          ${avatar(store.me.user.name || store.me.user.email, 36)}
          <div class="reply-main" id="reply-main">
            <textarea id="reply-text" rows="3" placeholder="${esc(t('reply_ph', lastInboundFrom(msgs)))}"></textarea>
            <div class="cp-atts" id="reply-atts" hidden></div>
            <div class="reply-actions">
              <wa-button variant="brand" id="btn-reply-send">${esc(t('send'))}</wa-button>
              <wa-button appearance="plain" id="btn-reply-full">${esc(t('edit_full_window'))}</wa-button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  show(renderShell(content));
  bindShell();
  bindThread(tid, msgs, backFolder);

  if (anyUnread) {
    api('POST', `/api/mailboxes/${store.mbId}/threads/${tid}/action`, { action: 'read' }).then(() => refreshMe());
  }
  qsa('.msg.open').forEach((el) => loadBody(el.dataset.mid));
}

function lastInboundFrom(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].direction === 'in') return msgs[i].from_name || msgs[i].from_addr;
  }
  const last = msgs[msgs.length - 1];
  return last ? last.from_name || last.from_addr : '';
}

function outboxChip(m) {
  if (m.direction !== 'out' || !m.outbox_status) return '';
  if (m.outbox_status === 'sent') {
    return m.outbox_error ? `<span class="chip chip-warn" title="${esc(tStored(m.outbox_error))}">${esc(t('chip_dev'))}</span>` : `<span class="chip chip-ok">${esc(t('chip_delivered'))}</span>`;
  }
  if (m.outbox_status === 'failed') return `<span class="chip chip-err" title="${esc(tStored(m.outbox_error))}">${esc(t('chip_failed'))}</span>`;
  return `<span class="chip">${esc(t('chip_sending'))}</span>`;
}

function msgHtml(m, expanded) {
  const open = expanded || !m.flag_seen;
  const toLine = (m.to || []).map((a) => a.name || a.addr).join(', ');
  return `
  <div class="msg ${open ? 'open' : ''}" data-mid="${esc(m.id)}" data-from="${esc(m.from_addr || '')}">
    <div class="msg-head">
      ${avatar(m.from_name || m.from_addr, 40)}
      <div class="msg-meta">
        <div class="msg-line1">
          <span class="msg-from">${esc(m.from_name || m.from_addr)}</span>
          <span class="msg-addr">&lt;${esc(m.from_addr)}&gt;</span>
          ${outboxChip(m)}
        </div>
        <div class="msg-line2" title="${esc(toLine)}">${esc(t('sent_to_line', toLine || '…'))}</div>
      </div>
      <div class="msg-right">
        ${m.has_attachments ? icon('attach', 16) : ''}
        <span class="msg-date">${fmtDateTime(m.date)}</span>
        <span class="row-labels" data-act="msglabels" style="width:auto">${msgLabelsHtml(m)}</span>
      </div>
    </div>
    <div class="msg-collapsed">${esc(cleanSnippet(m.snippet))}</div>
    <div class="msg-bodywrap">
      ${msgChipsHtml(m)}
      <div class="msg-body" id="body-${esc(m.id)}"><div class="loading">${esc(t('loading'))}</div></div>
      ${(m.attachments || []).length ? attHtml(m) : ''}
      <div class="msg-actions">
        <wa-button appearance="outlined" size="small" data-act="reply">${icon('reply', 16)} ${esc(t('reply'))}</wa-button>
        <wa-button appearance="outlined" size="small" data-act="forward">${icon('forward', 16)} ${esc(t('forward'))}</wa-button>
      </div>
    </div>
  </div>`;
}

// Types the browser can display directly and that cannot become same-origin XSS when returned inline.
// This must match PREVIEW_MIMES on the server (change both together). SVG and HTML are excluded --
// opening either inline would run script under our own origin.
// 浏览器能直接显示、且内联返回不会变成同源 XSS 的类型。必须和服务端 PREVIEW_MIMES 一致
// (两处改动请同步);SVG / HTML 不在内 —— 它们内联打开就能在本站源执行脚本
const PREVIEW_MIME_RE = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf)$/;
const attMime = (a) => String(a.mime || '').split(';')[0].trim().toLowerCase();
const canPreview = (a) => PREVIEW_MIME_RE.test(attMime(a));

function attHtml(m) {
  const chips = m.attachments
    .map((a) => {
      const name = a.filename || 'attachment';
      // Previewable attachments take over the left click and open the large window; the rest stay as-is and download on click
      // 能预览的接管左键点击走大窗;其余保持原样,点了直接下载
      const prev = canPreview(a);
      return `
    <a class="att-chip" href="/api/messages/${esc(m.id)}/att/${a.part_index}" download
       title="${esc(prev ? `${t('att_preview')} · ${name}` : name)}"${prev ? ` data-prev="${a.part_index}"` : ''}>
      <span class="att-name">${esc(name)}</span><span class="att-size">${fmtSize(a.size)}</span>${fileIcon(a.filename)}
    </a>`;
    })
    .join('');
  return `<div class="atts">${chips}</div>`;
}

/** Large attachment preview: filename, size, download and close, with the content rendered by img or iframe
 *  附件大窗预览:文件名 + 大小 + 下载 + 关闭,内容用 img / iframe 直接渲染 */
function openAttPreview(mid, a) {
  const url = `/api/messages/${encodeURIComponent(mid)}/att/${a.part_index}`;
  const name = a.filename || 'attachment';
  const viewer =
    attMime(a) === 'application/pdf'
      ? `<iframe src="${esc(url)}?inline=1" title="${esc(name)}"></iframe>`
      : `<img src="${esc(url)}?inline=1" alt="${esc(name)}">`;
  const d = showModal(`
    <div class="attprev">
      <div class="attprev-head">
        ${fileIcon(name, 18)}
        <span class="attprev-name" title="${esc(name)}">${esc(name)}</span>
        <span class="attprev-size">${fmtSize(a.size)}</span>
        <span class="flex1"></span>
        <wa-button class="icon sm" appearance="plain" data-x="full"
          aria-label="${esc(t('att_fullscreen'))}" title="${esc(t('att_fullscreen'))}">${icon('expand', 18)}</wa-button>
        <wa-button class="icon sm" appearance="plain" data-x="dl"
          aria-label="${esc(t('download'))}" title="${esc(t('download'))}">${icon('download', 18)}</wa-button>
        <wa-button class="icon sm" appearance="plain" data-x="close"
          aria-label="${esc(t('close'))}" title="${esc(t('close'))}">${icon('close', 18)}</wa-button>
      </div>
      <div class="attprev-body">${viewer}</div>
    </div>`);
  d.classList.add('attprev-dlg');
  d.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-x]');
    if (!b) return;
    if (b.dataset.x === 'full') {
      const full = d.classList.toggle('full');
      b.innerHTML = icon(full ? 'collapse' : 'expand', 18);
      const label = t(full ? 'att_exit_fullscreen' : 'att_fullscreen');
      b.setAttribute('aria-label', label);
      b.setAttribute('title', label);
      return;
    }
    if (b.dataset.x !== 'dl') return closeModal();
    // Without inline=1 the server returns Content-Disposition: attachment, so it lands on disk
    // 不带 inline=1:服务端回 Content-Disposition: attachment,直接落盘
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
}

/** Feed the current theme colours into the iframe (srcdoc is static, so custom properties do the linking)
 *  把当前主题色喂进 iframe(srcdoc 是静态的,靠自定义属性做联动) */
function applyFrameTheme(iframe) {
  const doc = iframe.contentDocument;
  if (!doc?.documentElement) return;
  const cs = getComputedStyle(document.documentElement);
  const set = (k, v) => doc.documentElement.style.setProperty(k, cs.getPropertyValue(v).trim());
  set('--cf-bg', '--panel');
  set('--cf-text', '--text');
  set('--cf-text2', '--text-2');
  set('--cf-link', '--link');
  set('--cf-border', '--border-2');
}

const parseRgb = (s) => {
  const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(s || '');
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : parseFloat(m[4]) } : null;
};
const isOpaque = (bg) => { const c = parseRgb(bg); return !!c && c.a >= 0.5; };
/** Relative luminance, used to decide whether this surface wants black or white text
 *  相对亮度,用来决定这个面上该配黑字还是白字 */
const isLightBg = (bg) => {
  const c = parseRgb(bg);
  return !c || (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 > 0.5;
};
/** WCAG relative luminance (with gamma expansion), used to compute contrast
 *  WCAG 相对亮度(带 gamma 展开),用于算对比度 */
const relLum = (c) => {
  const f = (v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrastRatio = (a, b) => {
  const l1 = relLum(a);
  const l2 = relLum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
// Below this contrast the text counts as unreadable. Deliberately set at 2.5 rather than WCAG's 3:1 --
// raising it starts catching footers and disclaimers a sender dimmed on purpose (#999 on white is 2.85),
// which were never a problem.
// 低于这个对比度就认定看不清。刻意压在 2.5 而不是 WCAG 的 3:1 —— 再往上调会开始误伤
// 浅色主题下发件方有意做淡的页脚/免责声明(#999 落在白底上是 2.85),那些本来就没问题
const MIN_CONTRAST = 2.5;

/**
 * An element that declares its own background is a surface the sender painted, so the text on it must
 * follow that surface's lightness rather than the theme (theme-light text on a light surface disappears).
 * Anywhere without a declared background keeps following the theme.
 * Note this has to include <html>: some templates set the base colour there, and missing it turns the
 * whole message into pale text on white.
 * 自己声明了背景的元素 = 发件方画的"面",它上面的文字要按这个面的明暗来配,
 * 而不是跟主题走(主题浅字落在浅色面上会看不见)。没声明背景的地方继续跟随主题。
 * 注意要连 <html> 一起看:有些模板把底色设在 html 上,漏掉就整封都是白底浅字。
 */
function markSurfaces(iframe) {
  const doc = iframe.contentDocument;
  if (!doc?.body) return;
  const themeColor = getComputedStyle(doc.documentElement).color; // 我们注入的主题文字色
  // The canvas is painted by us with the theme colour, so it is not a sender surface -- unless the message rewrote the html background itself
  // 画布是我们自己刷的主题色,不算发件方的"面";邮件若改写了 html 背景则另当别论
  const probe = doc.createElement('span');
  probe.style.color = doc.documentElement.style.getPropertyValue('--cf-bg');
  const ourBg = probe.style.color; // CSSOM 会规范化成 rgb(...),便于和计算值比对
  for (const el of [doc.documentElement, doc.body, ...doc.querySelectorAll('body *')]) {
    const cs = getComputedStyle(el);
    if (el === doc.documentElement && cs.backgroundColor === ourBg) continue;
    // A computed colour different from the injected one means the message set its own text colour (inline or in a <style>), and we leave it alone
    // 计算色不等于注入色 = 邮件自己定过文字色(行内或 <style> 里),一律不碰
    if (el !== doc.documentElement && cs.color !== themeColor) continue;
    if (!isOpaque(cs.backgroundColor) && cs.backgroundImage === 'none') continue;
    // Use a class rather than an inline style: that carries descendant link colours along too, and never rewrites the style attribute
    // 用 class 而不是行内样式:这样连子孙的链接色一起带上,也不会重写 style 属性
    el.classList.add(isLightBg(cs.backgroundColor) ? 'cf-surf-l' : 'cf-surf-d');
  }
}

/**
 * Is this text sitting on **our** canvas? Walk up looking for the first opaque background (or background image).
 * Hitting a surface the sender painted returns false -- the colours there are the sender's business, not ours.
 * 这段文字是不是坐在**我们的**画布上:向上找第一个不透明背景(或背景图)。
 * 中途撞到发件方铺的面就返回 false —— 那块地方的配色归发件方管,我们不插手。
 */
function onOurCanvas(el, doc) {
  for (let n = el; n; n = n.parentElement) {
    if (n === doc.documentElement) {
      // Only an html background we painted counts as our own canvas; if the message rewrote it, treat it as a sender surface
      // html 的底色是我们刷的才算自家画布;邮件改写过 html 背景就当成发件方的面
      return !n.classList.contains('cf-surf-l') && !n.classList.contains('cf-surf-d');
    }
    const cs = getComputedStyle(n);
    if (isOpaque(cs.backgroundColor) || cs.backgroundImage !== 'none') return false;
  }
  return true;
}

/**
 * markSurfaces only covers places where the sender painted a background. One case it cannot reach:
 * the sender **set a text colour but no background** (the From:/Sent:/To: block of an Outlook quote is
 * the classic example). That text lands directly on our canvas -- fine in the light theme, unreadable
 * in the dark one.
 * So this is the contrast backstop: anything on our own canvas without enough contrast has its colour
 * handed back to the theme.
 * It only ever adds the class, never removes it, and .cf-fix uses var(--cf-text) so it follows the
 * light/dark switch on its own.
 * markSurfaces 只管"发件方铺了背景"的地方。剩下一种情况它够不着:
 * 发件方**只指定了文字颜色、没铺背景**(Outlook 引用块的 From:/Sent:/To: 就是典型),
 * 这段字直接落在我们的画布上 —— 浅色主题下深色字没问题,深色主题下就糊成一团。
 * 所以这里按对比度兜底:落在自家画布上且对比度不够的,把颜色交还给主题。
 * 只加 class 不删,且 .cf-fix 用的是 var(--cf-text),明暗切换时自动跟着走。
 */
function fixCanvasText(iframe) {
  const doc = iframe.contentDocument;
  if (!doc?.body) return;
  const canvas = parseRgb(getComputedStyle(doc.documentElement).backgroundColor);
  if (!canvas) return;
  for (const el of doc.querySelectorAll('body, body *')) {
    if (el.classList.contains('cf-fix')) continue;
    // Only elements that directly contain text; pure layout wrappers are skipped
    // 只看自己直接带文字的元素,纯布局壳子跳过
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const c = parseRgb(getComputedStyle(el).color);
    if (!c || contrastRatio(c, canvas) >= MIN_CONTRAST) continue;
    if (!onOurCanvas(el, doc)) continue;
    el.classList.add('cf-fix');
  }
}

/** Light/dark switch: refresh the theme colours, then re-decide which text became unreadable in the new mode
 *  明暗切换:刷新主题色,并重新判一遍哪些文字在新模式下看不清了 */
window.addEventListener('cfmail:mode', () =>
  qsa('.mailframe').forEach((f) => {
    applyFrameTheme(f);
    fixCanvasText(f);
  })
);

/** The bar shown when remote images are blocked: show once, or trust this sender permanently
 *  远程图片被拦截时的提示条:本次显示 / 永久信任该发件人 */
function imgBlockBar(box, mid, blocked) {
  const from = box.closest('.msg')?.dataset.from || '';
  const bar = document.createElement('div');
  bar.className = 'imgblock';
  bar.innerHTML =
    `<span class="imgblock-txt">${esc(t('img_blocked', blocked))}</span>` +
    `<wa-button size="small" appearance="outlined" data-act="show">${esc(t('img_show_once'))}</wa-button>` +
    (from ? `<wa-button size="small" appearance="plain" data-act="trust">${esc(t('img_trust_sender'))}</wa-button>` : '');
  bar.querySelector('[data-act="show"]').onclick = () => loadBody(mid, true);
  const trust = bar.querySelector('[data-act="trust"]');
  if (trust)
    trust.onclick = async () => {
      try {
        await api('POST', `/api/mailboxes/${store.mbId}/contacts/trust`, { addr: from, trust: 'trusted' });
        toast(t('img_trusted', from));
        box.dataset.loaded = '';
        loadBody(mid);
      } catch (e) {
        toast(e.message, true);
      }
    };
  return bar;
}

async function loadBody(mid, showImages = false) {
  const box = qs(`#body-${CSS.escape(mid)}`);
  if (!box || (box.dataset.loaded && !showImages)) return;
  box.dataset.loaded = '1';
  // Pin the current height when reloading (after "show images" or "trust sender"). Otherwise emptying the
  // box collapses the card to 60px and then springs back to several thousand, and the whole page jolts.
  // The new iframe also starts from the old height, and is adjusted once, after load reports the real scrollHeight.
  // 重新加载(点"显示图片"或"信任发件人")时把当前高度钉住。否则清空 box 会让卡片
  // 瞬间塌成 60px 再弹回几千像素,整页跟着抖一下。新 iframe 也从旧高度起步,
  // 等 load 拿到真实 scrollHeight 时再一次性调整到位。
  const prevH = box.querySelector('.mailframe')?.offsetHeight || 0;
  if (prevH) box.style.minHeight = box.offsetHeight + 'px';
  const unpin = () => { box.style.minHeight = ''; };
  try {
    const b = await api('GET', `/api/messages/${mid}/body${showImages ? '?images=1' : ''}`);
    if (b.html) {
      const iframe = document.createElement('iframe');
      iframe.className = 'mailframe';
      // allow-popups-to-escape-sandbox is deliberately absent: with it, a link in the body could open a
      // top-level page outside the sandbox that runs script (which, combined with cid rewriting pointing at
      // our own origin, is an XSS). Popups still inherit the script-free sandbox.
      // 不加 allow-popups-to-escape-sandbox:否则正文里的链接能打开一个脱离沙箱、
      // 可执行脚本的顶层页(配合 cid 改写指向本站源即成 XSS)。弹窗仍继承无脚本沙箱。
      iframe.setAttribute('sandbox', 'allow-same-origin allow-popups');
      if (prevH) iframe.style.height = prevH + 'px'; // 别从默认的 150px 起跳
      box.innerHTML = '';
      // Say it where the mail is read. Marking somebody a risk and then showing their mail
      // exactly like everybody else's would make the mark worth nothing.
      // 在读信的地方说出来。把某人标为隐患,却把他的信显示得和别人一模一样,这个标记就等于没有。
      if (b.sender_trust === 'risk') {
        const warn = document.createElement('div');
        warn.className = 'risk-bar';
        warn.innerHTML = `${icon('warning', 15)}<span>${esc(t('trust_risk_warn'))}</span>`;
        box.appendChild(warn);
      }
      if (b.images_blocked > 0) box.appendChild(imgBlockBar(box, mid, b.images_blocked));
      box.appendChild(iframe);
      const bodyFont = store.me?.user?.body_font || '';
      const fontLink = bodyFont ? `<link rel="stylesheet" href="/api/fonts/css/${encodeURIComponent(bodyFont)}">` : '';
      const fontFamily = bodyFont
        ? `'${bodyFont.replace(/'/g, '')}',-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif`
        : `-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif`;
      // Transparent canvas, theme-coloured text: wherever the sender declared no background (forward headers,
      // plain paragraphs) follows light/dark, while anywhere they did declare one (brand cards, colour bands)
      // is preserved exactly and never inverted -- inverting destroys both the layout and the brand colours.
      // For untrusted senders a CSP cuts off every remote subresource at the root (remote images, srcset, CSS
      // backgrounds, url() in <style>, remote fonts, SVG and so on), allowing only our own origin (cid images,
      // body fonts) and inline styles. Clicking "show images" refetches with ?images=1, at which point
      // sender_safe is true and no CSP is applied, so the original images load. The sandbox already forbids
      // script; this is one more layer.
      // 画布透明、文字走主题:发件方没声明背景的地方(转发头、纯文字段落)跟随明暗;
      // 声明了背景的地方(品牌卡片、色带)原样保留,不反色 —— 反色会毁掉版式和品牌色
      // 不可信发件人:用 CSP 从根上掐断所有远程子资源(远程图、srcset、CSS 背景、<style> url()、
      // 远程字体、SVG 等),只放行本站源(cid 图、正文字体)与内联样式。点"显示图片"会带 ?images=1
      // 重新拉取(那时 sender_safe=true,不加 CSP),原图正常加载。沙箱已禁脚本,这里再兜一层。
      const csp = b.sender_safe
        ? ''
        : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:">`;
      iframe.srcdoc =
        // The canvas must be painted explicitly: html{background:transparent} only makes the <html> element
        // transparent, while the iframe's canvas keeps the UA default (white under color-scheme:light).
        // 画布必须显式上色:html{background:transparent} 只让 <html> 元素透明,
        // iframe 的画布底色仍取 UA 默认值(color-scheme:light 下就是白的)
        `${csp}<base target="_blank">${fontLink}<style>html{background:var(--cf-bg,#fff);color:var(--cf-text,#1f1f1f)}` +
        `body{font:14px/1.65 ${fontFamily};margin:0;padding:2px;word-break:break-word}` +
        `img{max-width:100%;height:auto}a{color:var(--cf-link,#0b57d0)}` +
        `blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid var(--cf-border,#dadce0);color:var(--cf-text2,#5f6368)}` +
        `pre{white-space:pre-wrap}` +
        // Surfaces the sender painted: text and links follow the surface's lightness rather than the theme
        // 发件方自己画的面:文字与链接按面的明暗配色,而不是跟主题
        `.cf-surf-l{color:#1f1f1f}.cf-surf-l a{color:#0b57d0}` +
        `.cf-surf-d{color:#f5f5f5}.cf-surf-d a{color:#70b8ff}` +
        // An iframe is a separate document and cannot see the outer scrollbar styling, so it gets its own copy
        // to keep the whole site consistent. The colours are mixed from the body text colour, so they show up
        // on light and dark backgrounds alike.
        // iframe 是独立文档,拿不到外面的滚动条样式,这里照抄一份保持全站一致。
        // 颜色从正文文字色调出来,浅底深底都能看见
        `::-webkit-scrollbar{width:18px;height:18px}` +
        `::-webkit-scrollbar-track{background:color-mix(in srgb,var(--cf-text,#1f1f1f) 8%,transparent);border-radius:999px}` +
        `::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--cf-text,#1f1f1f) 30%,transparent);border-radius:999px;border:5px solid transparent;background-clip:content-box}` +
        `::-webkit-scrollbar-button{display:none;width:0;height:0}` +
        // Sender colours are usually written as inline styles, so !important is needed to win
        // 发件方的颜色多半写在行内 style 上,不加 !important 压不住
        `.cf-fix{color:var(--cf-text,#1f1f1f)!important}a.cf-fix{color:var(--cf-link,#0b57d0)!important}</style>` +
        b.html;
      iframe.addEventListener('load', () => {
        try {
          applyFrameTheme(iframe);
          markSurfaces(iframe);
          fixCanvasText(iframe); // 必须在 markSurfaces 之后:要靠 cf-surf-* 判断哪块是发件方的面
          // Release the height before measuring, or scrollHeight is propped up by the height we just pinned and reads wrong
          // 先松开 height 再量,否则 scrollHeight 会被上面钉的旧高度撑住量不准
          iframe.style.height = '';
          const h = iframe.contentDocument.documentElement.scrollHeight;
          iframe.style.height = Math.min(Math.max(h + 24, 60), 10000) + 'px';
        } catch {}
        unpin();
      });
    } else {
      box.innerHTML = `<div class="plainbody">${esc(b.text || t('no_content'))}</div>`;
      unpin();
    }
  } catch (e) {
    box.innerHTML = `<div class="plainbody">${esc(t('load_fail', e.message))}</div>`;
    unpin();
  }
}

/** Wire up drag-and-drop upload: highlight el while a file is over it, then call back once per file on drop
 *  绑定拖拽上传:文件拖入 el 时高亮,drop 后逐个回调 */
export function bindDropZone(el, onFiles) {
  if (!el) return;
  const over = (e) => {
    e.preventDefault();
    el.classList.add('dragover');
  };
  el.addEventListener('dragover', over);
  el.addEventListener('dragenter', over);
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('dragover');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  });
}

export async function uploadAttachment(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error(t('t_too_big', file.name));
  const fd = new FormData();
  fd.append('file', file);
  return await api('POST', '/api/uploads', fd);
}

function bindThread(tid, msgs, backFolder) {
  // Attachments on the quick-reply box (drag and drop)
  // 快速回复框的附件(拖拽上传)
  const replyAtts = [];
  const attsBox = qs('#reply-atts');
  const renderReplyAtts = () => {
    if (!attsBox) return;
    attsBox.hidden = replyAtts.length === 0;
    attsBox.innerHTML = replyAtts
      .map(
        (a, i) => `
      <span class="att-chip ${a.done ? '' : 'uploading'}">
        ${icon('attach', 14)}<span class="att-name">${esc(a.filename)}</span>
        <span class="att-size">${a.done ? fmtSize(a.size) : esc(t('uploading'))}</span>
        <button class="att-x" data-i="${i}" title="${esc(t('remove'))}">${icon('close', 14)}</button>
      </span>`
      )
      .join('');
  };
  attsBox?.addEventListener('click', (e) => {
    const btn = e.target.closest('.att-x');
    if (!btn) return;
    replyAtts.splice(parseInt(btn.dataset.i, 10), 1);
    renderReplyAtts();
  });
  bindDropZone(qs('#reply-main'), async (files) => {
    for (const f of files) {
      const entry = { id: null, filename: f.name, size: f.size, done: false };
      replyAtts.push(entry);
      renderReplyAtts();
      try {
        const r = await uploadAttachment(f);
        entry.id = r.id;
        entry.done = true;
      } catch (err) {
        replyAtts.splice(replyAtts.indexOf(entry), 1);
        toast(err.message, true);
      }
      renderReplyAtts();
    }
  });

  const back = () => navigate(`#/mb/${store.mbId}/${backFolder}`);
  qs('#btn-back')?.addEventListener('click', back);
  const act = (a) => async () => {
    await api('POST', `/api/mailboxes/${store.mbId}/threads/${tid}/action`, { action: a }).catch((e) => toast(e.message, true));
    toast(t('action_done'));
    back();
  };
  qs('#t-archive')?.addEventListener('click', act('archive'));
  qs('#t-spam')?.addEventListener('click', act('spam'));
  qs('#t-trash')?.addEventListener('click', act('trash'));
  qs('#t-unread')?.addEventListener('click', act('unread'));
  qs('#t-restore')?.addEventListener('click', act('inbox'));
  qs('#t-purge')?.addEventListener('click', async () => {
    if (!(await confirmDialog(t('purge_confirm'), t('purge_forever')))) return;
    await api('POST', `/api/mailboxes/${store.mbId}/threads/${tid}/action`, { action: 'delete_forever' }).catch((e) => toast(e.message, true));
    back();
  });

  qsa('.msg').forEach((el) => {
    const mid = el.dataset.mid;
    const m = msgs.find((x) => x.id === mid);
    el.querySelector('.msg-head').addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      el.classList.toggle('open');
      if (el.classList.contains('open')) loadBody(mid);
    });
    el.querySelector('.msg-collapsed')?.addEventListener('click', () => {
      el.classList.add('open');
      loadBody(mid);
    });
    // The reading pane acts on the message in front of you, not on the conversation: this is
    // where a single message gets classified differently from its neighbours.
    // 阅读区操作的是眼前这一封,不是整个会话 —— 单封与同会话其它信分开归类,就发生在这里。
    const msgLabelMenu = (x, y) => {
      const m = (currentMsgs || []).find((z) => z.id === mid) || {};
      const have = new Set([...(m.flag_flagged ? [BUILTIN] : []), ...(m.labels || [])]);
      openLabelMenu(x, y, {
        has: (id) => (have.has(id) ? 'on' : 'off'),
        toggle: async (id, on) => {
          await api('POST', `/api/messages/${mid}/labels`, { label: id, on });
          if (id === BUILTIN) m.flag_flagged = on ? 1 : 0;
          else m.labels = on ? [...(m.labels || []), id] : (m.labels || []).filter((x2) => x2 !== id);
        },
        onDone: async () => {
          await loadLabels();
          el.querySelector('[data-act="msglabels"]').innerHTML = msgLabelsHtml(m);
          const wrap = el.querySelector('.msg-chips');
          if (wrap) wrap.outerHTML = msgChipsHtml(m);
        },
      });
    };
    el.querySelector('[data-act="msglabels"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      msgLabelMenu(r.left, r.bottom + 4);
    });
    el.querySelector('.msg-bodywrap')?.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-unlabel]');
      if (!x) return;
      e.stopPropagation();
      const m = (currentMsgs || []).find((z) => z.id === mid) || {};
      await api('POST', `/api/messages/${mid}/labels`, { label: x.dataset.unlabel, on: false })
        .catch((err) => toast(err.message, true));
      if (x.dataset.unlabel === BUILTIN) m.flag_flagged = 0;
      else m.labels = (m.labels || []).filter((z) => z !== x.dataset.unlabel);
      await loadLabels();
      el.querySelector('[data-act="msglabels"]').innerHTML = msgLabelsHtml(m);
      const wrap = el.querySelector('.msg-chips');
      if (wrap) wrap.outerHTML = msgChipsHtml(m);
    });
    el.querySelectorAll('.att-chip[data-prev]').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        // Middle-click and Ctrl/Cmd-click keep the browser's native behaviour (download or new tab); only a plain left click is taken over
        // 中键、Ctrl/Cmd+点击 保留浏览器原生行为(下载/新标签),只接管普通左键
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const att = (m.attachments || []).find((x) => String(x.part_index) === chip.dataset.prev);
        if (!att) return;
        e.preventDefault();
        openAttPreview(m.id, att);
      });
    });
    el.querySelector('[data-act="reply"]')?.addEventListener('click', () => replyTo(m));
    el.querySelector('[data-act="forward"]')?.addEventListener('click', () => forwardMsg(m));
  });

  qs('#btn-reply-send')?.addEventListener('click', async () => {
    const text = qs('#reply-text').value.trim();
    if (!text && !replyAtts.length) return toast(t('empty_reply'), true);
    if (replyAtts.some((a) => !a.done)) return toast(t('atts_uploading'), true);
    const last = [...msgs].reverse().find((x) => x.direction === 'in') || msgs[msgs.length - 1];
    const to = last.direction === 'in' ? last.from_addr : (last.to || []).map((a) => a.addr).join(', ');
    try {
      const r = await api('POST', `/api/mailboxes/${store.mbId}/send`, {
        to,
        subject: reSubject(last.subject),
        text,
        reply_to_message_id: last.id,
        attachment_ids: replyAtts.map((a) => a.id),
      });
      toast(sendToastText(r));
      renderThread(tid);
    } catch (e) {
      toast(e.message, true);
    }
  });
  qs('#btn-reply-full')?.addEventListener('click', () => {
    const last = [...msgs].reverse().find((x) => x.direction === 'in') || msgs[msgs.length - 1];
    replyTo(last, qs('#reply-text').value, replyAtts.filter((a) => a.done));
  });
}

export function sendToastText(r) {
  if (r.external > 0 && r.queued) return r.internalDelivered > 0 ? t('t_mixed') : t('t_queued');
  return t('t_sent');
}

function reSubject(s) {
  s = s || '';
  return /^re\s*[:：]/i.test(s) ? s : 'Re: ' + s;
}

/** Fetch the original as quoted content; failing that, degrade to no quote rather than blocking composition
 *  取原文作为引用内容;拿不到就退化成没有引用,不阻塞写信 */
async function fetchQuote(m, attribution) {
  try {
    const b = await api('GET', `/api/messages/${m.id}/body?images=1`);
    return { html: b.html ? sanitizeQuoteHtml(b.html) : '', text: b.text || htmlToPlainText(b.html), attribution };
  } catch {
    return { html: '', text: '', attribution };
  }
}

async function replyTo(m, text = '', atts = []) {
  const to = m.direction === 'in' ? m.from_addr : (m.to || []).map((a) => a.addr).join(', ');
  const quote = await fetchQuote(m, t('quote_attr', fmtDateTime(m.date), m.from_name || m.from_addr, m.from_addr));
  openCompose({
    mbId: store.mbId,
    to,
    subject: reSubject(m.subject),
    text,
    reply_to_message_id: m.id,
    atts,
    quote,
  });
}

/** Forward a conversation from the list: take its most recent message
 *  从列表转发会话:取该会话最新一封转发 */
async function forwardThread(tid) {
  try {
    const data = await api('GET', `/api/mailboxes/${store.mbId}/threads/${tid}`);
    const last = data.messages[data.messages.length - 1];
    if (last) await forwardMsg(last);
  } catch (e) {
    toast(e.message, true);
  }
}

async function forwardMsg(m) {
  const fw = /^fw[d]?\s*[:：]/i.test(m.subject || '') ? m.subject : 'Fwd: ' + (m.subject || '');
  const head =
    `${t('fwd_divider')}\n${t('fwd_from')}: ${m.from_name || ''} <${m.from_addr}>\n` +
    `${t('fwd_date')}: ${fmtDateTime(m.date)}\n${t('fwd_subject')}: ${m.subject || ''}`;
  const quote = await fetchQuote(m, head);
  openCompose({ mbId: store.mbId, subject: fw, quote });
}

// ---------- Contacts ----------
// ---------- 通讯录 ----------

export async function renderContacts() {
  await loadFolders();
  let data;
  try {
    data = await api('GET', `/api/mailboxes/${store.mbId}/contacts`);
  } catch (e) {
    show(renderShell(`<div class="empty">${esc(e.message)}</div>`));
    bindShell();
    return;
  }
  // Three states, chosen from a list rather than cycled through by clicking: with more than two
  // positions, a toggle stops telling you where you are without being pressed.
  // 三档,用列表选而不是点着轮换:超过两个位置的开关,不按一下就说不清自己现在在哪儿。
  const trustHtml = (ct) => {
    const cur = pickTrust(ct.trust);
    return `<wa-select class="ct-trust t-${cur}" size="small" value="${cur}"
        data-trust="${esc(ct.addr)}" title="${esc(t('trust_label'))}">
        ${TRUSTS.map((v) => `<wa-option value="${v}">${esc(t('trust_' + v))}</wa-option>`).join('')}
      </wa-select>`;
  };
  const groupHtml = (list, titleKey) => `
    <div class="contact-group">
      <div class="side-title">${esc(t(titleKey))} (${list.length})</div>
      ${list
        .map(
          (ct) => `
        <div class="contact-row" data-addr="${esc(ct.addr)}">
          ${avatar(ct.name || ct.addr, 36)}
          <div class="contact-main">
            <div class="contact-name">${esc(ct.name || ct.addr.split('@')[0])}</div>
            <div class="contact-addr">${esc(ct.addr)}</div>
          </div>
          <span class="dim">${ct.directory && !ct.times ? '' : esc(t('times_n', ct.times))}</span>
          ${trustHtml(ct)}
          <wa-button appearance="outlined" size="small" data-write="${esc(ct.addr)}">${icon('pencil', 14)} ${esc(t('write_to'))}</wa-button>
        </div>`
        )
        .join('') || `<div class="dim" style="padding:8px 12px">${esc(t('no_contacts'))}</div>`}
    </div>`;
  const contacts = data.contacts || [];
  const internal = contacts.filter((ct) => ct.internal);
  const external = contacts.filter((ct) => !ct.internal);
  const content = `
    <div class="list-toolbar">
      <span class="list-title">${esc(t('f_contacts'))}</span>
      <span class="flex1"></span>
      <form id="ct-search" class="searchbar" style="height:36px;width:260px">
        ${icon('search', 16)}<input id="ct-q" type="text" placeholder="${esc(t('search_contacts'))}" autocomplete="off">
      </form>
    </div>
    <div class="contacts-page" id="contacts-page">
      ${contacts.length ? groupHtml(internal, 'contacts_internal') + groupHtml(external, 'contacts_external') : `<div class="empty">${esc(t('no_contacts'))}</div>`}
    </div>`;
  show(renderShell(content));
  bindShell();
  const pageEl = qs('#contacts-page');
  const reload = async () => {
    const v = qs('#ct-q')?.value.trim() || '';
    const d2 = await api('GET', `/api/mailboxes/${store.mbId}/contacts${v ? `?q=${encodeURIComponent(v)}` : ''}`).catch(() => ({ contacts: [] }));
    const cs = d2.contacts || [];
    pageEl.innerHTML = cs.length
      ? groupHtml(cs.filter((x) => x.internal), 'contacts_internal') + groupHtml(cs.filter((x) => !x.internal), 'contacts_external')
      : `<div class="empty">${esc(t('no_contacts'))}</div>`;
  };
  const setTrust = async (addr, trust, el) => {
    try {
      await api('POST', `/api/mailboxes/${store.mbId}/contacts/trust`, { addr, trust });
      // Recolour in place instead of redrawing the page: the list is long, and rebuilding it under
      // the pointer takes the row you were looking at somewhere else.
      // 就地换色,不重画整页:列表很长,在指针底下重建一遍,会把你正看着的那一行挪到别处。
      if (el) el.className = `ct-trust t-${trust}`;
    } catch (e) {
      toast(e.message, true);
      await reload();
    }
  };
  pageEl.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-trust]');
    if (sel) setTrust(sel.dataset.trust, pickTrust(sel.value), sel);
  });
  pageEl.addEventListener('click', (e) => {
    // A click inside the dropdown is aimed at the dropdown, not at "write to this person"
    // 落在下拉框里的点击是冲着下拉框去的,不是"给这个人写信"
    if (e.target.closest('.ct-trust')) return;
    const w = e.target.closest('[data-write]');
    if (w) {
      openCompose({ mbId: store.mbId, to: w.dataset.write });
      return;
    }
    const row = e.target.closest('.contact-row');
    if (row) openCompose({ mbId: store.mbId, to: row.dataset.addr });
  });
  let ctTimer = null;
  qs('#ct-q').addEventListener('input', () => {
    clearTimeout(ctTimer);
    ctTimer = setTimeout(reload, 200);
  });
  qs('#ct-search').addEventListener('submit', (e) => e.preventDefault());
}
