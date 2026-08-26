// Admin console "Export": write every message from the selected mailboxes as .eml into a folder on the administrator's machine.
// Layout: <chosen folder>/<mailbox address>/<folder>/<sequence>.eml
// The server only supplies the manifest and one raw message at a time; packing and writing happen
// entirely in the browser -- zipping a multi-gigabyte mailbox inside a Worker would exceed both the
// memory and the CPU limits, and would also force the user to download one huge file and unzip it.
// 管理后台「导出工具」:把选中邮箱的全部邮件写成 .eml 落到管理员本地目录。
// 结构:<所选目录>/<邮箱地址>/<文件夹>/<序号>.eml
// 服务端只给清单和单封原文,打包/落盘全在浏览器做 —— 几 GB 的邮箱在 Worker 里打 zip
// 既超内存也超 CPU,而且用户还得先下一个大文件再解压。
import { api } from './api.js';
import { esc, qs, qsa, toast, fmtSize, fmtDuration, CAP } from './ui.js';
import { t } from './i18n.js';

const FOLDER_DIRS = {
  inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts',
  archive: 'Archive', spam: 'Spam', trash: 'Trash',
};

// Characters Windows forbids in filenames, plus spaces, all become underscores
// Windows 文件名禁用字符 + 空格,统一换成下划线
const BAD_NAME_CHARS = /[<>:"\/\\|?* -]/g;

/** Filename sanitising: strip illegal characters, cap the length so paths do not overflow, and drop trailing dots and spaces, which Windows also rejects
 *  文件名净化:去掉非法字符,掐长度免得路径超限,尾部的点和空格 Windows 也不接受 */
const safeName = (s) =>
  String(s || '').replace(BAD_NAME_CHARS, '_').replace(/[. ]+$/, '').slice(0, 60) || 'unnamed';

export async function tabExport(body) {
  const { domains } = await api('GET', '/api/admin/domains');
  const boxes = [];
  for (const d of domains) {
    const { mailboxes } = await api('GET', `/api/admin/domains/${d.id}/mailboxes`);
    for (const m of mailboxes) {
      boxes.push({ id: m.id, address: `${m.local_part}@${d.name}`, count: m.msg_count || 0, bytes: m.bytes || 0 });
    }
  }
  boxes.sort((a, b) => b.count - a.count);

  const supported = CAP.dirHandle;

  body.innerHTML = `
    <section class="card">
      <h3>${esc(t('exp_title'))}</h3>
      <p class="dim">${esc(t('exp_note'))}</p>
      ${supported ? '' : `<p class="dim" style="color:var(--wa-color-warning-on-quiet)">${esc(t('exp_unsupported'))}</p>`}
      ${boxes.length ? `
      <div class="tblwrap"><table class="table" id="exp-list">
        <thead><tr>
          <th style="width:36px"><input type="checkbox" id="exp-all"></th>
          <th>${esc(t('exp_th_mailbox'))}</th>
          <th>${esc(t('exp_th_count'))}</th>
          <th>${esc(t('exp_th_size'))}</th>
        </tr></thead>
        <tbody>
          ${boxes.map((b) => `
          <tr>
            <td><input type="checkbox" class="exp-pick" data-id="${esc(b.id)}" data-addr="${esc(b.address)}"></td>
            <td>${esc(b.address)}</td>
            <td>${b.count}</td>
            <td>${esc(fmtSize(b.bytes))}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      <div class="form-row" style="margin-top:14px;padding-left:10px" id="exp-go-row">
        <wa-button variant="brand" id="exp-go" ${supported ? '' : 'disabled'}>${esc(t('exp_start'))}</wa-button>
        <span class="dim" id="exp-picked"></span>
        <span class="run-summary" id="exp-result"></span>
      </div>
      <div id="exp-running" hidden>
        <div class="imp-bar"><div class="imp-bar-fill" id="exp-fill" style="width:0%"></div></div>
        <div class="imp-status">
          <span id="exp-progress"></span>
          <span class="imp-eta" id="exp-eta"></span>
          <span class="flex1"></span>
          <wa-button appearance="outlined" size="small" id="exp-cancel">${esc(t('imp_cancel'))}</wa-button>
        </div>
      </div>
      <div id="exp-fails"></div>
      ` : `<p class="dim">${esc(t('exp_no_mailbox'))}</p>`}
    </section>`;

  if (!boxes.length) return;

  let cancelled = false;
  const picked = () => qsa('.exp-pick:checked');
  const refreshPicked = () => {
    const n = picked().length;
    qs('#exp-picked').textContent = n ? t('exp_picked', n) : '';
  };

  qs('#exp-all').addEventListener('change', (e) => {
    qsa('.exp-pick').forEach((cb) => { cb.checked = e.target.checked; });
    refreshPicked();
  });
  qsa('.exp-pick').forEach((cb) => cb.addEventListener('change', refreshPicked));

  qs('#exp-cancel').addEventListener('click', () => {
    cancelled = true;
    qs('#exp-progress').textContent = t('imp_cancelling');
  });

  qs('#exp-go').addEventListener('click', async () => {
    const sel = picked().map((cb) => ({ id: cb.dataset.id, address: cb.dataset.addr }));
    if (!sel.length) return toast(t('exp_pick_first'), true);

    let root;
    try {
      root = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch {
      return; // 用户取消
    }

    qs('#exp-go-row').hidden = true;
    qs('#exp-running').hidden = false;
    qs('#exp-result').textContent = '';
    qs('#exp-fails').innerHTML = '';
    cancelled = false;

    const prog = qs('#exp-progress');
    const eta = qs('#exp-eta');
    const fill = qs('#exp-fill');
    const started = Date.now();
    const stat = { ok: 0, fail: 0 };
    const fails = [];

    // Fetch the manifests for every selected mailbox first, so the total and the progress are known
    // 先把所有选中邮箱的清单拉齐,才能算总数和进度
    const jobs = [];
    for (const mb of sel) {
      prog.textContent = t('exp_listing', mb.address);
      let page = 0;
      for (;;) {
        const r = await api('GET', `/api/admin/mailboxes/${mb.id}/export-list?page=${page}`);
        for (const it of r.items) jobs.push({ mb, item: it });
        if (!r.has_more) break;
        page++;
      }
    }
    const total = jobs.length;
    if (!total) {
      qs('#exp-running').hidden = true;
      qs('#exp-go-row').hidden = false;
      qs('#exp-result').textContent = t('exp_empty');
      return;
    }

    // Directory handle cache: getDirectoryHandle runs once per mailbox/folder pair
    // 目录句柄缓存:同一个邮箱/文件夹只 getDirectoryHandle 一次
    const dirCache = new Map();
    const dirFor = async (addr, folder) => {
      const key = `${addr}/${folder}`;
      if (dirCache.has(key)) return dirCache.get(key);
      const mbDir = await root.getDirectoryHandle(safeName(addr), { create: true });
      const fDir = await mbDir.getDirectoryHandle(FOLDER_DIRS[folder] || safeName(folder || 'Other'), { create: true });
      dirCache.set(key, fDir);
      return fDir;
    };
    const seq = new Map(); // 每个目录各自的序号

    for (let i = 0; i < jobs.length; i++) {
      if (cancelled) break;
      const { mb, item } = jobs[i];
      try {
        const res = await fetch(`/api/admin/messages/${encodeURIComponent(item.id)}/raw`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const dir = await dirFor(mb.address, item.folder);
        const key = `${mb.address}/${item.folder}`;
        const n = (seq.get(key) || 0) + 1;
        seq.set(key, n);
        // The sequence number goes first so the folder sorts chronologically; the subject is only for humans, so it is shortened and cleaned of illegal characters
        // 序号在前保证目录里按时间有序;主题只是给人看的,截短并去掉非法字符
        const fname = `${String(n).padStart(6, '0')}_${safeName(item.subject || 'no-subject')}.eml`;
        const fh = await dir.getFileHandle(fname, { create: true });
        const w = await fh.createWritable();
        await w.write(buf);
        await w.close();
        stat.ok++;
      } catch (err) {
        stat.fail++;
        if (fails.length < 20) fails.push(`${mb.address} / ${item.subject || '(no subject)'}: ${err.message}`);
      }
      const done = i + 1;
      fill.style.width = ((done / total) * 100).toFixed(1) + '%';
      prog.textContent = t('exp_progress', done, total, stat.ok, stat.fail);
      if (done >= 3 && done < total) {
        const per = (Date.now() - started) / done;
        eta.textContent = t('imp_eta', fmtDuration(per * (total - done)));
      } else if (done >= total) {
        eta.textContent = '';
      }
    }

    // An export carries every message out of the system, so each mailbox gets its own audit record
    // 导出等于把全部通信内容带离系统,按邮箱各记一条审计
    for (const mb of sel) {
      await api('POST', `/api/admin/mailboxes/${mb.id}/export-done`, {
        ok: stat.ok, failed: stat.fail, cancelled,
      }).catch(() => {});
    }

    qs('#exp-running').hidden = true;
    qs('#exp-go-row').hidden = false;
    // Clear the checkboxes when it finishes, so a stray click cannot export everything a second time
    // 跑完把勾选清掉,免得手一抖又导一遍
    qsa('.exp-pick').forEach((cb) => { cb.checked = false; });
    qs('#exp-all').checked = false;
    refreshPicked();
    // The single-line result sits to the right of the button; the failure detail is multi-line and keeps its own block
    // 结果一行放在按钮右边;失败明细是多行的,仍然单独占一块
    qs('#exp-result').textContent = cancelled
      ? t('exp_cancelled', stat.ok, stat.fail)
      : t('exp_done', stat.ok, stat.fail);
    qs('#exp-fails').innerHTML = fails.length
      ? `<pre class="dim" style="white-space:pre-wrap;font-size:12px">${esc(fails.join('\n'))}</pre>`
      : '';
  });
}
