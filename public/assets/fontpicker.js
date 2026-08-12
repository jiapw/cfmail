// A general font picker: dialog plus search plus lazy preview loading. Fonts are served from our own self-hosted copy of Google Fonts.
// 通用字体选择器:弹窗 + 搜索 + 懒加载预览。字体从本站自托管的 Google Fonts 提供。
import { esc, qs, qsa } from './ui.js';
import { t } from './i18n.js';

let catalog = null;
const loaded = new Set();

/** Inject one font's CSS on demand (once per font for the whole site)
 *  按需注入某字体的 CSS(全站只注入一次) */
export function ensureFont(family) {
  if (!family || loaded.has(family)) return;
  loaded.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `/api/fonts/css/${encodeURIComponent(family)}`;
  document.head.appendChild(link);
}

export async function fontCatalog() {
  if (!catalog) {
    try {
      catalog = (await fetch('/api/fonts/catalog').then((r) => r.json())).fonts || [];
    } catch {
      catalog = [];
    }
  }
  return catalog;
}

const SAMPLE_LATIN = 'The quick brown fox 0123';
const SAMPLE_CJK = '中文字体预览 ABC 0123';

/**
 * Open the font picker.
 * @returns Promise<string|null> the chosen font name; '' means the system default; null means cancelled
 * 打开字体选择器。
 * @returns Promise<string|null> 选中的字体名;'' 表示系统默认;null 表示取消
 */
export async function pickFont(current = '', title = '') {
  const fonts = await fontCatalog();
  const CATS = [
    ['', t('font_all')],
    ['sans', t('font_sans')],
    ['serif', t('font_serif')],
    ['script', t('font_script')],
    ['display', t('font_display')],
    ['mono', t('font_mono')],
    ['cjk', t('font_cjk')],
  ];

  return new Promise((resolve) => {
    const d = document.createElement('wa-dialog');
    d.setAttribute('label', title || t('choose_font'));
    d.classList.add('font-dialog');
    d.innerHTML = `
      <div class="fp-body">
        <div class="fp-left">
          <div class="fp-head">
            <input id="fp-q" type="text" placeholder="${esc(t('font_search'))}" autocomplete="off">
            <input id="fp-sample" type="text" placeholder="${esc(t('font_preview_ph'))}" autocomplete="off">
            <div class="fp-cats">${CATS.map(
              ([k, label], i) => `<button class="fp-cat ${i === 0 ? 'active' : ''}" data-cat="${k}">${esc(label)}</button>`
            ).join('')}</div>
          </div>
          <div class="fp-list" id="fp-list"></div>
        </div>
        <div class="fp-right">
          <div class="fp-right-head"><span id="fp-short-title"></span></div>
          <div class="fp-list fp-shortlist" id="fp-short"></div>
        </div>
      </div>
      <div slot="footer" class="fp-foot">
        <span class="dim" id="fp-current"></span>
        <span class="flex1"></span>
        <wa-button appearance="plain" id="fp-cancel">${esc(t('cancel'))}</wa-button>
        <wa-button variant="brand" id="fp-ok">${esc(t('confirm'))}</wa-button>
      </div>`;
    document.body.appendChild(d);

    let cat = '';
    let q = '';
    let sample = '';                 // 自定义预览文本;为空时按字体类型用默认示例
    let selected = current || '';    // 当前选定(两栏共用一个选中态)
    // The shortlist survives across openings
    // 预选清单跨次打开保留
    let shortlist = [];
    try {
      shortlist = JSON.parse(localStorage.getItem('cfmail_font_shortlist') || '[]').filter((n) => fonts.some((f) => f.name === n));
    } catch {}
    const saveShort = () => localStorage.setItem('cfmail_font_shortlist', JSON.stringify(shortlist));

    const sampleFor = (f) => sample || (f && f.cjk ? SAMPLE_CJK : SAMPLE_LATIN);
    const defOf = (name) => fonts.find((f) => f.name === name);

    /** Load only the fonts currently scrolled into view in one list
     *  只加载某个列表当前滚动可见范围内的字体 */
    const loadVisible = (listEl) => {
      if (!listEl) return;
      const top = listEl.scrollTop - listEl.clientHeight;
      const bottom = listEl.scrollTop + listEl.clientHeight * 2;
      qsa('[data-lazy]', listEl).forEach((el) => {
        if (el.offsetTop >= top && el.offsetTop <= bottom) ensureFont(el.dataset.lazy);
      });
    };

    const itemHtml = (f, side) => {
      const name = f ? f.name : '';
      const label = f ? esc(f.name) + (f.cjk ? ` <span class="chip">${esc(t('font_cjk'))}</span>` : '') : esc(t('font_default'));
      const action =
        side === 'left'
          ? f
            ? `<span class="fp-act" data-add="${esc(name)}" title="${esc(t('font_add'))}">+</span>`
            : ''
          : `<span class="fp-act" data-del="${esc(name)}" title="${esc(t('remove'))}">×</span>`;
      return `
        <div class="fp-item ${selected === name ? 'sel' : ''}" data-font="${esc(name)}">
          <span class="fp-name">${label}</span>
          <span class="fp-preview" ${f ? `data-lazy="${esc(name)}" style="font-family:'${esc(name)}',system-ui"` : ''}>${esc(sampleFor(f))}</span>
          ${action}
        </div>`;
    };

    const renderFooter = () => {
      const cur = qs('#fp-current', d);
      if (cur) cur.textContent = `${t('font_selected')}: ${selected || t('font_default')}`;
      const title2 = qs('#fp-short-title', d);
      if (title2) title2.textContent = `${t('font_shortlist')} (${shortlist.length})`;
    };

    const renderShort = () => {
      const el = qs('#fp-short', d);
      el.innerHTML = shortlist.length
        ? shortlist.map((n) => itemHtml(defOf(n), 'right')).join('')
        : `<div class="dim" style="padding:14px 12px">${esc(t('font_shortlist_empty'))}</div>`;
      loadVisible(el);
      el.onscroll = () => loadVisible(el);
      renderFooter();
    };

    const renderList = () => {
      const el = qs('#fp-list', d);
      const items = fonts.filter((f) => {
        if (cat === 'cjk' ? !f.cjk : cat && f.cat !== cat) return false;
        return !q || f.name.toLowerCase().includes(q);
      });
      el.innerHTML =
        itemHtml(null, 'left') +
        (items.map((f) => itemHtml(f, 'left')).join('') ||
          `<div class="dim" style="padding:16px">${esc(t('empty_search'))}</div>`);
      // Work the visible range out from offsetTop by hand -- IntersectionObserver does not fire inside a wa-dialog slot
      // 用 offsetTop 手算可见范围 —— IntersectionObserver 在 wa-dialog 的 slot 内不触发
      loadVisible(el);
      el.onscroll = () => loadVisible(el);
      renderFooter();
    };

    /** Refresh only the selection highlight, without rebuilding the DOM (which keeps the scroll position and the fonts already loaded)
     *  只刷新选中高亮,不重建 DOM(保留滚动位置与已加载字体) */
    const syncSelection = () => {
      qsa('.fp-item', d).forEach((it) => it.classList.toggle('sel', it.dataset.font === selected));
      renderFooter();
    };

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
      d.open = false;
    };

    // Event delegation: shared by both columns
    // 事件委托:两栏共用
    d.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) {
        e.stopPropagation();
        const n = add.dataset.add;
        if (!shortlist.includes(n)) { shortlist.push(n); saveShort(); renderShort(); }
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        shortlist = shortlist.filter((x) => x !== del.dataset.del);
        saveShort();
        renderShort();
        return;
      }
      const item = e.target.closest('.fp-item');
      if (item) {
        selected = item.dataset.font;
        syncSelection();
      }
    });
    // Double-click confirms straight away
    // 双击直接确认
    d.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.fp-item');
      if (item) finish(item.dataset.font);
    });

    qs('#fp-ok', d).addEventListener('click', () => finish(selected));
    qs('#fp-cancel', d).addEventListener('click', () => finish(null));

    qs('#fp-q', d).addEventListener('input', (e) => {
      q = e.target.value.trim().toLowerCase();
      renderList();
    });
    qs('#fp-sample', d).addEventListener('input', (e) => {
      sample = e.target.value;
      qsa('.fp-preview', d).forEach((prev) => {
        prev.textContent = sampleFor(defOf(prev.dataset.lazy));
      });
    });
    qsa('.fp-cat', d).forEach((b) =>
      b.addEventListener('click', () => {
        cat = b.dataset.cat;
        qsa('.fp-cat', d).forEach((x) => x.classList.toggle('active', x === b));
        renderList();
      })
    );
    d.addEventListener('wa-hide', (e) => {
      if (e.target === d) {
        if (!settled) { settled = true; resolve(null); }
        setTimeout(() => d.remove(), 250);
      }
    });

    renderList();
    renderShort();
    customElements.whenDefined('wa-dialog').then(async () => {
      try { await d.updateComplete; } catch {}
      d.open = true;
      setTimeout(() => {
        qs('#fp-q', d)?.focus();
        loadVisible(qs('#fp-list', d));
        loadVisible(qs('#fp-short', d));
      }, 150);
    });
  });
}

/** Font name -> a font-family value with fallbacks
 *  字体名 → 带回退的 font-family 值 */
export function fontStack(family, kind = 'ui') {
  const fallback =
    kind === 'mono'
      ? "ui-monospace, Consolas, monospace"
      : "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
  return family ? `'${family}', ${fallback}` : fallback;
}
