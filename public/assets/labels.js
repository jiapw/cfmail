// Labels: named, coloured marks that several of can sit on one message.
//
// They are not folders. A labelled message stays in whatever folder it lives in, which is what
// lets them carry the categories a Gmail export arrives with -- Category *, Important, custom
// labels -- without shuffling mail between inbox and archive.
//
// The built-in one is the star that has always been there: flag_flagged, IMAP's \Flagged, handed
// over under the reserved id "flagged" so that one list, one menu and one call cover both it and
// the labels people create. Its name is not stored anywhere -- it is translated here, the same
// way error codes are.
//
// 标签:有名字、有颜色的记号,一封信可以有多个。
//
// 它们不是文件夹。打了标签的邮件仍留在原来的文件夹里 —— 正因如此,它们装得下 Gmail 导出
// 带来的那些分类(Category *、Important、自定义标签),而不必把邮件在收件箱和归档之间搬。
//
// 内置的那个就是一直都在的星标:flag_flagged,IMAP 的 \Flagged,用保留 id "flagged" 交出来,
// 于是一份列表、一个菜单、一次调用同时管住它和用户自建的标签。
// 它的名字不存在任何地方 —— 在这里按语言翻译,和错误码一个路子。

import { api } from './api.js';
import { esc, icon, toast, showModal, closeModal, confirmDialog, phoneSheet, asSheet, cleanupSheet } from './ui.js';
import { t } from './i18n.js';
import { store } from './app.js';

export const BUILTIN = 'flagged';

// Both sets are closed, and both closures are enforced on the server as well. A free colour
// picker guarantees somebody eventually picks the one shade invisible in dark mode.
// 两个集合都是封闭的,服务端同样校验。开放取色的结局,必然是有人选中在暗色主题下看不见的那一档。
export const LABEL_COLORS = ['amber', 'red', 'orange', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink', 'gray'];
export const LABEL_ICONS = ['tag', 'flag', 'bookmark', 'bell', 'pin', 'heart', 'bolt', 'leaf',
  'fire', 'cube', 'eye', 'clock', 'check', 'person', 'globe', 'folder'];

export async function loadLabels(mbId = store.mbId) {
  if (!mbId) return [];
  const r = await api('GET', `/api/mailboxes/${mbId}/labels`).catch(() => ({ labels: [] }));
  store.labels = r.labels || [];
  return store.labels;
}

export const allLabels = () => store.labels || [];
export const labelById = (id) => allLabels().find((l) => l.id === id) || null;
export const labelName = (l) => (l ? (l.builtin ? t('lbl_important') : l.name) : '');

/** A label's mark: its glyph in its colour. Used everywhere one has to be recognised at a glance.
 *  标签的记号:它的字形,用它的颜色。凡是要一眼认出来的地方都用它。 */
export function labelMark(l, size = 17) {
  if (!l) return '';
  // The class is load-bearing: dropped into a menu row, a bare <span> is claimed by the layout
  // rule that makes the label text fill the row, and the icon rule that paints every glyph grey.
  // A mark has to keep its own colour and its own width wherever it is put.
  // 这个类名是承重的:光秃秃的 <span> 放进菜单行里,会被"让文字撑满整行"的布局规则
  // 和"把所有字形涂灰"的图标规则一并接管。记号无论放在哪,都得留住自己的颜色和自己的宽度。
  return `<span class="lb-mark" style="color:var(--lb-${l.color || 'gray'})">${icon(l.icon || 'tag', size)}</span>`;
}

export function chipHtml(l, { removable = false } = {}) {
  if (!l) return '';
  return `<span class="lb-chip" style="color:var(--lb-${l.color || 'gray'})" data-label="${esc(l.id)}">
    ${icon(l.icon || 'tag', 14)}<span>${esc(labelName(l))}</span>
    ${removable ? `<span class="lb-x" data-unlabel="${esc(l.id)}" role="button" tabindex="0">×</span>` : ''}
  </span>`;
}

/**
 * The cell at the head of a list row. It shows at most two marks and then a count, because the
 * row has a subject to show and three coloured glyphs already read as decoration rather than as
 * information. The full set is one click away, in the picker this cell opens.
 * 列表行首那一格。最多显示两个记号,再多就只报数量 —— 这一行还要显示主题,
 * 三个彩色字形排下去就从"信息"变成"装饰"了。完整的一套点开这一格就能看到。
 */
export function rowLabelsHtml(th) {
  const ids = [...(th.starred ? [BUILTIN] : []), ...(th.labels || [])];
  const marks = ids.map(labelById).filter(Boolean);
  if (!marks.length) {
    return `<span class="row-labels" data-act="labels"><span class="lb-empty">${icon('star', 17)}</span></span>`;
  }
  const shown = marks.slice(0, 2).map((l) => labelMark(l)).join('');
  const more = marks.length > 2 ? `<span class="lb-more">+${marks.length - 2}</span>` : '';
  const names = marks.map(labelName).join(', ');
  return `<span class="row-labels" data-act="labels" title="${esc(names)}">${shown}${more}</span>`;
}

// ---------- The label people used last ----------
// ---------- 上一次用过的那个标签 ----------
// Kept per mailbox in this browser. It is a matter of feel, not of record: relearning it on a
// new device costs one click, while a column in the database would cost a migration and a sync.
// 按邮箱记在这个浏览器里。这是手感,不是数据:换台设备重新学一次的代价是点一下,
// 而为它加一列则要迁移、要同步。

const lastKey = (mbId) => `cf_lastlabel_${mbId}`;
export const lastLabelId = (mbId = store.mbId) => localStorage.getItem(lastKey(mbId)) || BUILTIN;
export const rememberLabel = (id, mbId = store.mbId) => localStorage.setItem(lastKey(mbId), id);
/** The last label still has to exist; a deleted one falls back to the built-in.
 *  上次那个标签得还在;被删掉了就退回内置的那个。 */
export const lastLabel = (mbId = store.mbId) => labelById(lastLabelId(mbId)) || labelById(BUILTIN);

// ---------- Picker ----------
// ---------- 选择器 ----------

let menuEl = null;
let closer = null;

export function closeLabelMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  cleanupSheet();
  if (closer) { document.removeEventListener('pointerdown', closer, true); document.removeEventListener('keydown', closer, true); closer = null; }
}

/**
 * Open the picker at a point.
 *   has(id)  -> 'on' | 'off' | 'mixed'   what the targets currently carry
 *   toggle(id, on) -> Promise            applied to every target
 * The tri-state matters: with several conversations selected, "some of them have this" and "all
 * of them have this" have to look different, or you cannot tell whether clicking adds or removes.
 * 三态很重要:选中多个会话时,"部分有"和"全都有"必须长得不一样,
 * 否则你无从判断点下去是加还是减。
 */
export function openLabelMenu(x, y, { has, toggle, onDone } = {}) {
  closeLabelMenu();
  const labels = allLabels();
  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu lb-pick';
  menuEl.id = 'lb-menu';
  const item = (l) => {
    const st = has ? has(l.id) : 'off';
    return `<button class="ctx-item" data-lb="${esc(l.id)}" data-st="${st}">
      <span class="lb-box ${st === 'on' ? 'on' : st === 'mixed' ? 'mixed' : ''}">${st === 'on' ? icon('check', 12) : ''}</span>
      ${labelMark(l, 17)}<span>${esc(labelName(l))}</span>
    </button>`;
  };
  menuEl.innerHTML =
    labels.map(item).join('') +
    '<div class="ctx-sep"></div>' +
    `<button class="ctx-item" data-lb-new="1">${icon('plus', 18)}<span>${esc(t('lbl_add'))}</span></button>` +
    `<button class="ctx-item" data-lb-manage="1">${icon('gear', 18)}<span>${esc(t('lbl_manage'))}</span></button>`;
  document.body.appendChild(menuEl);

  // On a phone this is a sheet at the foot of the screen. Anywhere else, keep it on screen:
  // opened from a row near the bottom, a menu that runs off the viewport is a menu whose last
  // item cannot be clicked.
  // 手机上这是屏幕脚下的一张动作单。其余地方,保证它在屏幕内:
  // 从底部的行打开时,溢出视口的菜单等于最后几项点不到。
  if (phoneSheet()) {
    asSheet(menuEl);
  } else {
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }

  menuEl.addEventListener('click', async (e) => {
    const nu = e.target.closest('[data-lb-new]');
    if (nu) { closeLabelMenu(); await editLabel(null, onDone); return; }
    const mg = e.target.closest('[data-lb-manage]');
    if (mg) { closeLabelMenu(); await openLabelManager(onDone); return; }
    const btn = e.target.closest('[data-lb]');
    if (!btn) return;
    const id = btn.dataset.lb;
    const on = btn.dataset.st !== 'on';   // mixed 也按"补齐"处理
    closeLabelMenu();
    try {
      await toggle?.(id, on);
      if (on) rememberLabel(id);
    } catch (err) {
      toast(err.message, true);
    }
    onDone?.();
  });

  // pointerdown rather than mousedown: a finger produces one natively, while the mouse events a
  // touch may or may not be given afterwards are an emulation the browser is free to withhold --
  // and a menu that cannot be dismissed is a page that has stopped working.
  // 用 pointerdown 而不是 mousedown:手指会原生产生前者,
  // 而触摸之后"可能有、也可能没有"的鼠标事件是一层模拟,浏览器有权不给 ——
  // 一个关不掉的菜单,就是一个不动了的页面。
  closer = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'pointerdown' && menuEl?.contains(e.target)) return;
    closeLabelMenu();
  };
  document.addEventListener('pointerdown', closer, true);
  document.addEventListener('keydown', closer, true);
}

// ---------- Create / edit / delete ----------
// ---------- 新建 / 编辑 / 删除 ----------

/** The colour and glyph choosers, as markup. One definition, so the modal that creates a label and
 *  the popup that restyles one cannot drift apart.
 *  颜色与字形的选择器,只此一份 —— 建标签的弹窗和改外观的浮层不会各长各的。 */
export const swatchesHtml = () => LABEL_COLORS.map(
  (c) => `<button type="button" class="lb-swatch" data-color="${c}" aria-label="${c}" style="background:var(--lb-${c})"></button>`
).join('');
export const glyphsHtml = () => LABEL_ICONS.map(
  (g) => `<button type="button" class="lb-glyph" data-icon="${g}" aria-label="${g}">${icon(g, 18)}</button>`
).join('');

/** Wire a pair of chooser grids so the selected swatch and glyph show what they are
 *  给一对选择器网格接上联动,让选中的颜色和字形自己显示出来 */
export function bindLook(root, state, onChange) {
  const paint = () => {
    root.querySelectorAll('.lb-swatch').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
    root.querySelectorAll('.lb-glyph').forEach((b) => {
      b.classList.toggle('on', b.dataset.icon === state.icon);
      b.style.color = b.dataset.icon === state.icon ? `var(--lb-${state.color})` : '';
    });
  };
  root.querySelectorAll('.lb-swatch').forEach((b) =>
    b.addEventListener('click', () => { state.color = b.dataset.color; paint(); onChange?.(state); }));
  root.querySelectorAll('.lb-glyph').forEach((b) =>
    b.addEventListener('click', () => { state.icon = b.dataset.icon; paint(); onChange?.(state); }));
  paint();
  return paint;
}

/**
 * Change a label's colour and glyph in place, anchored to whatever was clicked. Used where a row
 * shows a mark and the mark itself is the control -- clicking the thing you want to change is a
 * shorter path than finding a pair of dropdowns that describe it.
 * 就地改一个标签的颜色和字形,浮层贴着被点的那个元素。用在"行里显示一个记号、记号本身就是控件"
 * 的地方 —— 点你想改的那个东西,比去找两个描述它的下拉框要短。
 */
export function openLookPicker(x, y, { color, icon: ic, onPick } = {}) {
  closeLabelMenu();
  const state = { color: color || LABEL_COLORS[0], icon: ic || LABEL_ICONS[0] };
  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu lb-look';
  menuEl.innerHTML = `
    <div class="lb-look-row"><span class="dim">${esc(t('lbl_color'))}</span><div class="lb-swatches">${swatchesHtml()}</div></div>
    <div class="lb-look-row"><span class="dim">${esc(t('lbl_icon'))}</span><div class="lb-glyphs">${glyphsHtml()}</div></div>`;
  document.body.appendChild(menuEl);
  bindLook(menuEl, state, (s) => onPick?.({ ...s }));

  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menuEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

  // pointerdown rather than mousedown: a finger produces one natively, while the mouse events a
  // touch may or may not be given afterwards are an emulation the browser is free to withhold --
  // and a menu that cannot be dismissed is a page that has stopped working.
  // 用 pointerdown 而不是 mousedown:手指会原生产生前者,
  // 而触摸之后"可能有、也可能没有"的鼠标事件是一层模拟,浏览器有权不给 ——
  // 一个关不掉的菜单,就是一个不动了的页面。
  closer = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'pointerdown' && menuEl?.contains(e.target)) return;
    closeLabelMenu();
  };
  document.addEventListener('pointerdown', closer, true);
  document.addEventListener('keydown', closer, true);
}

export async function editLabel(existing, onDone) {
  const cur = existing || { name: '', icon: LABEL_ICONS[0], color: LABEL_COLORS[0] };
  const swatches = swatchesHtml();
  const glyphs = glyphsHtml();
  const m = showModal(`
    <h3 style="margin:0 0 12px">${esc(existing ? t('lbl_edit_title') : t('lbl_new_title'))}</h3>
    <form id="f-lb">
      <div class="form-row">
        <label>${esc(t('lbl_name'))}</label>
        <input name="name" type="text" maxlength="40" required style="width:260px" value="${esc(cur.name)}">
      </div>
      <div class="form-row"><label>${esc(t('lbl_color'))}</label><div class="lb-swatches">${swatches}</div></div>
      <div class="form-row"><label>${esc(t('lbl_icon'))}</label><div class="lb-glyphs">${glyphs}</div></div>
      <div class="modal-foot">
        <wa-button appearance="plain" id="lb-cancel">${esc(t('cancel'))}</wa-button>
        <wa-button variant="brand" type="submit">${esc(t('save'))}</wa-button>
      </div>
    </form>`);
  const look = { color: cur.color, icon: cur.icon };
  bindLook(m, look);
  m.querySelector('#lb-cancel').onclick = () => closeModal();
  m.querySelector('#f-lb').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').toString().trim();
    try {
      const body = { name, icon: look.icon, color: look.color };
      if (existing) await api('POST', `/api/mailboxes/${store.mbId}/labels/${existing.id}`, body);
      else await api('POST', `/api/mailboxes/${store.mbId}/labels`, body);
      closeModal();
      await loadLabels();
      onDone?.();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

export async function openLabelManager(onDone) {
  const rows = allLabels()
    .filter((l) => !l.builtin)
    .map(
      (l) => `<div class="lb-row" data-id="${esc(l.id)}">
        ${labelMark(l, 18)}<span class="lb-row-name">${esc(l.name)}</span>
        <span class="dim">${l.n || 0}</span>
        <wa-button appearance="plain" size="small" data-edit="${esc(l.id)}">${icon('pencil', 15)}</wa-button>
        <wa-button appearance="plain" size="small" class="danger" data-del="${esc(l.id)}">${icon('trash', 15)}</wa-button>
      </div>`
    )
    .join('');
  const m = showModal(`
    <h3 style="margin:0 0 4px">${esc(t('lbl_manage'))}</h3>
    <p class="dim" style="margin:0 0 12px">${esc(t('lbl_manage_note'))}</p>
    <div class="lb-list">${rows || `<div class="dim">${esc(t('lbl_none'))}</div>`}</div>
    <div class="modal-foot">
      <wa-button appearance="plain" id="lb-close">${esc(t('close'))}</wa-button>
      <wa-button variant="brand" id="lb-new">${icon('plus', 16)} ${esc(t('lbl_add'))}</wa-button>
    </div>`);
  m.querySelector('#lb-close').onclick = () => { closeModal(); onDone?.(); };
  m.querySelector('#lb-new').onclick = async () => { closeModal(); await editLabel(null, onDone); };
  m.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { closeModal(); await editLabel(labelById(ed.dataset.edit), onDone); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      const l = labelById(del.dataset.del);
      if (!l) return;
      if (!(await confirmDialog(t('lbl_delete_confirm', l.name), t('delete')))) return;
      try {
        await api('DELETE', `/api/mailboxes/${store.mbId}/labels/${l.id}`);
        await loadLabels();
        closeModal();
        onDone?.();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });
}
