// Admin console "Import": bring in a directory of .eml files exported from an old provider (Zoho, Outlook and friends).
// Flow: choose a directory -> scan the headers, tallying recipients and subdirectories -> the administrator confirms the target mailbox and where each subdirectory goes -> upload one by one.
// 管理后台「导入工具」:把旧邮箱(Zoho / Outlook 等)导出的 .eml 目录搬进来。
// 流程:选目录 → 扫描表头,统计收件人和子目录 → 管理员确认目标邮箱和每个子目录的去向 → 逐封上传。
import { api } from './api.js';
import { esc, icon, qs, qsa, toast, fmtSize, fmtDuration, confirmDialog } from './ui.js';
import { tabGmail } from './admin-gmail.js';
import { t } from './i18n.js';
// Same parser, same version as the Worker: the attachment order must match, because downloads locate parts by part_index in the original
// 和 Worker 用同一个解析器同一版本:附件顺序必须一致,下载时是按 part_index 回原文里定位的
import PostalMime from '../vendor/postal-mime/postal-mime.js';

/**
 * Parse an .eml locally into the fields the server needs for storage.
 * Attachments keep metadata only -- the bytes stay in the raw MIME uploaded alongside, rather than being sent twice.
 * 在本地把 .eml 解析成服务端入库所需的字段。
 * 附件只留元数据 —— 内容仍在随后上传的原始 MIME 里,不重复传一遍。
 */
async function parseLocally(file) {
  const p = await new PostalMime().parse(await file.arrayBuffer());
  return {
    from: p.from ? { name: p.from.name || '', address: p.from.address || '' } : null,
    to: p.to || [],
    cc: p.cc || [],
    bcc: p.bcc || [],
    replyTo: p.replyTo || [],
    subject: p.subject || '',
    text: (p.text || '').slice(0, 40000),
    html: p.html ? p.html.slice(0, 40000) : '',
    date: p.date || '',
    messageId: p.messageId || '',
    inReplyTo: p.inReplyTo || '',
    references: p.references || '',
    attachments: (p.attachments || []).map((a) => ({
      filename: a.filename || '',
      mimeType: a.mimeType || 'application/octet-stream',
      size: a.content?.byteLength ?? 0,
      contentId: a.contentId || '',
      disposition: a.disposition || '',
    })),
  };
}

// Common export directory names -> our folder roles. Unrecognised ones preselect the inbox, and the administrator can change each in the interface.
// 常见导出目录名 → 我们的文件夹角色。认不出的预选收件箱,管理员可在界面上逐个改。
const FOLDER_MAP = {
  inbox: 'inbox', '收件箱': 'inbox', '收件夾': 'inbox',
  sent: 'sent', 'sent items': 'sent', 'sent mail': 'sent',
  '已发送': 'sent', '已發送': 'sent', '已发邮件': 'sent', '寄件備份': 'sent',
  drafts: 'drafts', draft: 'drafts', '草稿': 'drafts', '草稿箱': 'drafts',
  archive: 'archive', archives: 'archive', '归档': 'archive', '封存': 'archive',
  spam: 'spam', junk: 'spam', 'junk email': 'spam', '垃圾邮件': 'spam', '垃圾郵件': 'spam',
  trash: 'trash', deleted: 'trash', 'deleted items': 'trash', '已删除': 'trash', '回收站': 'trash',
};
const FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'];
const ROOT = ' root'; // 根目录下直接放着 .eml 时的分组键

const folderLabel = (role) =>
  ({ inbox: t('f_inbox'), sent: t('f_sent'), drafts: t('f_drafts'), archive: t('f_archive'), spam: t('f_spam'), trash: t('f_trash') }[role] || role);

/** Guess which folder a directory name maps to; unrecognised names return inbox
 *  猜这个目录名对应哪个文件夹;认不出返回 inbox */
const guessRole = (dir) => FOLDER_MAP[String(dir).trim().toLowerCase()] || 'inbox';

/** Read only the first 16KB of the header: recipients, Message-ID, and the read/starred markers a few exports include
 *  只读文件头 16KB:收件人、Message-ID,以及少数导出会带的已读/星标标记 */
async function peekEml(file) {
  const txt = new TextDecoder('utf-8', { fatal: false }).decode(await file.slice(0, 16384).arrayBuffer());
  const end = txt.search(/\r?\n\r?\n/);
  const h = end > 0 ? txt.slice(0, end) : txt;
  const grab = (n) => {
    const m = new RegExp(`^${n}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)$`, 'im').exec(h);
    return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
  };
  const addrs = (s) => [...String(s).matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((m) => m[0].toLowerCase());
  const status = (grab('status') + ' ' + grab('x-status')).trim();
  const moz = grab('x-mozilla-status');
  let seen = null;
  let flagged = null;
  if (status) { seen = /R/.test(status); flagged = /F/.test(status); }
  if (moz) {
    const n = parseInt(moz, 16);
    if (!Number.isNaN(n)) { seen = !!(n & 0x1); flagged = !!(n & 0x4); }
  }
  return {
    messageId: (grab('message-id').match(/<[^>]+>/) || [''])[0],
    rcpts: addrs(`${grab('to')} ${grab('cc')} ${grab('delivered-to')} ${grab('x-original-to')}`),
    seen,
    flagged,
  };
}

/**
 * The import tab is a choice of source before it is a tool. Gmail comes first because a Takeout is
 * what most people arrive holding; the directory of .eml files is what you fall back to when the
 * old provider had no export of its own.
 * 导入工具页签首先是"选来源",然后才是工具。Gmail 排在第一位,因为大多数人手里拿着的就是
 * 一份 Takeout;.eml 目录是旧服务商没有自家导出时的退路。
 */
export async function tabImport(body) {
  const SOURCES = [
    { key: 'gmail', icon: 'mail', name: () => t('imp_src_gmail'), note: () => t('imp_src_gmail_note') },
    { key: 'eml', icon: 'folder', name: () => t('imp_src_eml'), note: () => t('imp_src_eml_note') },
  ];
  let picked = 'gmail';
  body.innerHTML = '<div class="src-tiles" id="imp-src"></div><div id="imp-host"></div>';
  const host = body.querySelector('#imp-host');
  const paint = async () => {
    body.querySelector('#imp-src').innerHTML = SOURCES.map((sx) => `
      <button type="button" class="src-tile ${sx.key === picked ? 'on' : ''}" data-src="${sx.key}">
        ${icon(sx.icon, 22)}
        <span class="src-name">${esc(sx.name())}</span>
        <span class="src-note dim">${esc(sx.note())}</span>
      </button>`).join('');
    body.querySelectorAll('.src-tile').forEach((b) =>
      b.addEventListener('click', () => { picked = b.dataset.src; paint(); }));
    host.innerHTML = `<div class="loading">${esc(t('loading'))}</div>`;
    if (picked === 'gmail') await tabGmail(host);
    else await emlImport(host);
  };
  await paint();
}

async function emlImport(body) {
  const { domains } = await api('GET', '/api/admin/domains');
  const boxes = [];
  for (const d of domains) {
    const { mailboxes } = await api('GET', `/api/admin/domains/${d.id}/mailboxes`);
    // The id travels with the address: the address is what the administrator picks, the id is
    // what reports the finished run.
    // id 跟着地址一起带上:管理员挑的是地址,回报这次运行用的是 id。
    for (const m of mailboxes) if (!m.disabled) boxes.push({ addr: `${m.local_part}@${d.name}`, id: m.id });
  }

  // Outlook on the web has no bulk export, so give the administrator a way to obtain .eml first, then feed it into the directory import above
  // Outlook 网页版没有批量导出,先给管理员一条能拿到 .eml 的路,再接上面的目录导入
  const O365_CMD = 'powershell -ExecutionPolicy Bypass -File .\\Export-Mailbox.ps1';

  body.innerHTML = `
    <section class="card">
      <h3>${esc(t('imp_o365_title'))}</h3>
      <p class="dim">${esc(t('imp_o365_intro'))}</p>
      <ol class="imp-steps">
        <li>${esc(t('imp_o365_s1'))}
          <div style="margin:6px 0">
            <wa-button appearance="outlined" size="small" id="imp-o365-dl">${esc(t('imp_o365_dl'))}</wa-button>
          </div>
        </li>
        <li>${esc(t('imp_o365_s2'))}
          <div class="imp-cmd">
            <code id="imp-o365-cmd">${esc(O365_CMD)}</code>
            <wa-button appearance="outlined" size="small" id="imp-o365-copy">${esc(t('imp_o365_copy'))}</wa-button>
          </div>
        </li>
        <li>${esc(t('imp_o365_s3'))}</li>
        <li>${esc(t('imp_o365_s4'))}</li>
      </ol>
      <p class="dim" style="margin-top:10px">${esc(t('imp_o365_note'))}</p>
    </section>
    <section class="card">
      <h3>${esc(t('imp_title'))}</h3>
      <p class="dim">${esc(t('imp_note'))}</p>
      <div class="form-row">
        <label>${esc(t('imp_pick_dir'))}</label>
        <wa-button appearance="outlined" id="imp-pick">${esc(t('imp_pick_dir'))}</wa-button>
        <span class="dim" id="imp-dirname"></span>
        <input type="file" id="imp-dir" webkitdirectory directory multiple hidden>
      </div>
      <div id="imp-scan">${boxes.length ? '' : `<p class="dim">${esc(t('imp_no_mailbox'))}</p>`}</div>
    </section>
    <section class="card" id="imp-run" hidden>
      <h3>${esc(t('imp_target'))}</h3>
      <div class="form-row">
        <label>${esc(t('imp_mailbox'))}</label>
        <wa-select id="imp-mb" value="${esc(boxes[0]?.addr || '')}" style="width:300px">${boxes.map((b) => `<wa-option value="${esc(b.addr)}">${esc(b.addr)}</wa-option>`).join('')}</wa-select>
        <span class="dim" id="imp-guess"></span>
      </div>
      <p class="dim" style="margin:14px 0 6px">${esc(t('imp_map_note'))}</p>
      <table class="table" id="imp-map">
        <thead><tr><th>${esc(t('imp_th_dir'))}</th><th>${esc(t('imp_th_count'))}</th><th>${esc(t('imp_th_folder'))}</th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="form-row" style="margin-top:14px" id="imp-go-row">
        <label></label>
        <wa-button variant="brand" id="imp-go">${esc(t('imp_start'))}</wa-button>
        <span class="run-summary" id="imp-result"></span>
      </div>
      <div id="imp-running" hidden>
        <div class="imp-bar"><div class="imp-bar-fill" id="imp-fill" style="width:0%"></div></div>
        <div class="imp-status">
          <span id="imp-progress"></span>
          <span class="imp-eta" id="imp-eta"></span>
          <span class="flex1"></span>
          <wa-button appearance="outlined" size="small" id="imp-cancel">${esc(t('imp_cancel'))}</wa-button>
        </div>
      </div>
      <div id="imp-fails"></div>
    </section>`;

  // wa-button does not forward download, and .ps1 gets no Content-Type, so a temporary <a download> is the reliable way to land the file
  // wa-button 不透传 download,而 .ps1 又拿不到 Content-Type;用临时 <a download> 稳妥落盘
  qs('#imp-o365-dl').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/tools/Export-Mailbox.ps1';
    a.download = 'Export-Mailbox.ps1';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  qs('#imp-o365-copy').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(O365_CMD);
    } catch {
      // Clipboard refused (not https, or no permission): fall back to selecting the whole line so the user can press Ctrl+C
      // 剪贴板被拒(非 https / 无权限):退回选中整段,用户自己 Ctrl+C
      const r = document.createRange();
      r.selectNodeContents(qs('#imp-o365-cmd'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    btn.textContent = t('imp_o365_copied');
    setTimeout(() => { btn.textContent = t('imp_o365_copy'); }, 1500);
  });

  let picked = [];
  let cancelled = false;

  // Prefer File System Access: once the directory is authorised, walk it lazily instead of pulling the whole
  // tree of file objects into memory at once.
  // Browsers without it (Firefox, Safari) fall back to a webkitdirectory input.
  // 优先用 File System Access:拿到目录授权后惰性遍历,不把整棵树的文件对象一次性塞进内存。
  // 不支持的浏览器(Firefox/Safari)回落到 webkitdirectory 输入框。
  qs('#imp-pick').addEventListener('click', async () => {
    if (!window.showDirectoryPicker) return qs('#imp-dir').click();
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'read' });
    } catch {
      return; // 用户取消
    }
    qs('#imp-dirname').textContent = handle.name;
    const scan = qs('#imp-scan');
    scan.innerHTML = `<p class="dim">${esc(t('imp_scanning', '…'))}</p>`;
    await runScan(await walkDir(handle));
  });

  qs('#imp-dir').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    qs('#imp-dirname').textContent = (files[0]?.webkitRelativePath || '').split('/')[0] || '';
    await runScan(fromInput(files));
  });

  /** Walk the directory handle recursively, descending into every subdirectory. Contents are not read yet -- getFile() happens on demand.
   *  递归遍历目录句柄,子目录全都要进去;内容不立刻读,用到时才 getFile() */
  async function walkDir(dirHandle, prefix = '') {
    const out = [];
    for await (const [name, h] of dirHandle.entries()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (h.kind === 'directory') out.push(...(await walkDir(h, rel)));
      else if (/\.eml$/i.test(name)) out.push({ rel, dir: rel.includes('/') ? rel.split('/')[0] : ROOT, getFile: () => h.getFile() });
    }
    return out;
  }

  /** Fallback path: webkitdirectory hands over a flat file list with the subdirectory inside relativePath
   *  回落路径:webkitdirectory 给的是扁平文件列表,relativePath 里带着子目录 */
  function fromInput(files) {
    return files
      .filter((f) => /\.eml$/i.test(f.name))
      .map((f) => {
        // The first segment of webkitRelativePath is the chosen directory itself, so drop it
        // webkitRelativePath 的第一段是所选目录本身,去掉
        const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
        return { rel, dir: rel.includes('/') ? rel.split('/')[0] : ROOT, getFile: async () => f };
      });
  }

  async function runScan(all) {
    const scan = qs('#imp-scan');
    qs('#imp-run').hidden = true;
    if (!all.length) {
      scan.innerHTML = `<p class="dim">${esc(t('imp_no_eml'))}</p>`;
      return;
    }
    const byDir = new Map(); // 顶层子目录 → 封数
    const byRcpt = {};
    let bytes = 0;
    picked = [];
    for (let i = 0; i < all.length; i++) {
      const it = all[i];
      const f = await it.getFile();
      const meta = await peekEml(f); // 只读头 16KB,全程在本地
      picked.push({ ...it, ...meta });
      byDir.set(it.dir, (byDir.get(it.dir) || 0) + 1);
      for (const a of new Set(meta.rcpts)) byRcpt[a] = (byRcpt[a] || 0) + 1;
      bytes += f.size;
      if (i % 100 === 0) {
        scan.innerHTML = `<p class="dim">${esc(t('imp_scanning', `${i}/${all.length}`))}</p>`;
        await new Promise((r) => setTimeout(r, 0)); // 让出主线程,别把界面卡死
      }
    }

    const topRcpts = Object.entries(byRcpt).sort((a, b) => b[1] - a[1]).slice(0, 8);
    scan.innerHTML = `
      <p><b>${esc(t('imp_found', all.length, fmtSize(bytes)))}</b></p>
      <p class="dim">${esc(t('imp_rcpts'))}</p>
      <div>${topRcpts.map(([a, n]) => `<span class="chip">${esc(a)} · ${n}</span>`).join(' ') || `<span class="dim">${esc(t('none'))}</span>`}</div>`;

    // Subdirectory mapping table: recognised ones are preselected, unrecognised ones land in the inbox, and the administrator can change any row
    // 子目录映射表:认得出的预选好,认不出的落收件箱,管理员逐行可改
    qs('#imp-map tbody').innerHTML = [...byDir.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([dir, n]) => {
        const guessed = dir === ROOT ? 'inbox' : guessRole(dir);
        // The root does not count as "unrecognised" -- it never had a directory name to recognise
        // 根目录不算"认不出",它本来就没有目录名可认
        const unknown = dir !== ROOT && !FOLDER_MAP[dir.trim().toLowerCase()];
        return `<tr>
          <td>${dir === ROOT ? `<span class="dim">${esc(t('imp_root'))}</span>` : esc(dir)}
              ${unknown ? `<span class="chip chip-warn">${esc(t('imp_unknown'))}</span>` : ''}</td>
          <td>${n}</td>
          <td><wa-select class="imp-role" data-dir="${esc(dir)}" value="${guessed}" style="width:180px">
            ${FOLDER_ROLES.map((r) => `<wa-option value="${r}">${esc(folderLabel(r))}</wa-option>`).join('')}
          </wa-select></td>
        </tr>`;
      })
      .join('');

    if (boxes.length) qs('#imp-run').hidden = false;
    // If exactly one existing company address shows up among the recipients, preselect it for the administrator
    // 收件人里正好有一个已存在的企业邮箱就替管理员预选上
    const hit = topRcpts.map(([a]) => a).find((a) => boxes.some((b) => b.addr === a));
    if (hit) {
      qs('#imp-mb').value = hit;
      qs('#imp-guess').textContent = t('imp_guessed', hit);
    }
  }

  qs('#imp-go').addEventListener('click', async () => {
    if (!picked.length) return;
    const mailbox = qs('#imp-mb').value;
    if (!mailbox) return toast(t('imp_pick_mailbox'), true);
    const mailboxId = boxes.find((b) => b.addr === mailbox)?.id;
    const roleByDir = {};
    for (const sel of qsa('.imp-role')) roleByDir[sel.dataset.dir] = sel.value;
    if (!(await confirmDialog(t('imp_confirm', picked.length, mailbox), t('imp_start')))) return;

    // Once it is running, hide the button and show a progress bar plus cancel instead
    // 跑起来之后按钮收掉,换成进度条 + 取消
    qs('#imp-go-row').hidden = true;
    qs('#imp-running').hidden = false;
    qs('#imp-result').textContent = '';
    qs('#imp-fails').innerHTML = '';
    cancelled = false;
    const prog = qs('#imp-progress');
    const eta = qs('#imp-eta');
    const fill = qs('#imp-fill');
    const started = Date.now();
    const stat = { ok: 0, dup: 0, fail: 0 };
    const fails = [];
    let done = 0;
    for (let i = 0; i < picked.length; i++) {
      if (cancelled) break;
      const it = picked[i];
      const q = new URLSearchParams({ mailbox, folder: roleByDir[it.dir] || 'inbox' });
      // Exported mail rarely carries read state; default to read so hundreds do not land unread
      // 导出件普遍不带已读标记,默认按已读进,免得一进来几百封未读
      q.set('seen', it.seen === false ? '0' : '1');
      if (it.flagged) q.set('flagged', '1');
      if (it.messageId) q.set('message_id', it.messageId);
      try {
        const file = await it.getFile(); // 到这一步才真正读文件内容
        // Parsing happens locally: the server only stores to R2 and inserts rows, and never parses the MIME a second time
        // 解析在本地做,服务端只负责存 R2 和插库,不再跑一遍 MIME 解析
        const fd = new FormData();
        fd.append('meta', JSON.stringify(await parseLocally(file)));
        fd.append('eml', file, 'message.eml');
        const res = await fetch(`/api/admin/import?${q}`, { method: 'POST', body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        if (j.skipped) stat.dup++;
        else stat.ok++;
      } catch (err) {
        stat.fail++;
        if (fails.length < 20) fails.push(`${it.rel}: ${err.message}`);
      }
      done++;
      fill.style.width = ((done / picked.length) * 100).toFixed(1) + '%';
      prog.textContent = t('imp_progress', done, picked.length, stat.ok, stat.dup, stat.fail);
      // The rate over the first few messages is noisy, so wait for enough samples before reporting a remaining time
      // 头几封的速率不稳,攒够样本再报剩余时间
      if (done >= 3 && done < picked.length) {
        const per = (Date.now() - started) / done;
        eta.textContent = t('imp_eta', fmtDuration(per * (picked.length - done)));
      } else if (done >= picked.length) {
        eta.textContent = '';
      }
    }
    qs('#imp-running').hidden = true;
    qs('#imp-go-row').hidden = false; // 取消或跑完都放回按钮,可以接着导(重复的会自动跳过)
    // The single-line result sits to the right of the button; the failure detail is multi-line and keeps its own block
    // 结果一行放在按钮右边;失败明细是多行的,仍然单独占一块
    // Importing carries a whole archive of somebody's mail into the system, so the run leaves a
    // trace even when it was cancelled. Reported once, not once per message.
    // 导入等于把别人的一整批邮件搬进系统,所以哪怕中途取消,这次运行也要留痕。
    // 只回报一次,不是每封一次。
    if (mailboxId && (stat.ok || stat.dup || stat.fail)) {
      await api('POST', `/api/admin/mailboxes/${mailboxId}/import-done`, {
        ok: stat.ok, duplicate: stat.dup, failed: stat.fail, cancelled,
      }).catch(() => {});
    }
    qs('#imp-result').textContent = cancelled
      ? t('imp_cancelled', stat.ok, stat.dup, stat.fail)
      : t('imp_done', stat.ok, stat.dup, stat.fail);
    qs('#imp-fails').innerHTML = fails.length
      ? `<pre class="dim" style="white-space:pre-wrap;font-size:12px">${esc(fails.join('\n'))}</pre>`
      : '';
  });

  qs('#imp-cancel').addEventListener('click', () => {
    cancelled = true;
    qs('#imp-progress').textContent = t('imp_cancelling');
  });
}
