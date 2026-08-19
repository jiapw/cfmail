// Admin console "Gmail import": bring a Google Takeout mail export into a mailbox.
//
// A Takeout is one enormous mbox -- a 930 MB file with eight thousand messages in the sample this
// was built against -- and every message carries an X-Gmail-Labels header listing what Gmail
// thought of it: Inbox, Sent, Unread, Starred, Category personal, and whatever the owner made up.
//
// Two different things have to come out of that one header. Which FOLDER a message lands in is a
// decision with one answer -- a message is in the inbox or it is archived, not both -- while
// LABELS are an index over mail that has already landed, and a message can carry any number of
// them. So the mapping is two tables, and the operator fills in both before anything is uploaded.
//
// The work is done here rather than on the server. Splitting the mbox, undoing its escaping,
// parsing every message and deciding its folder and labels all happen in this tab; the Worker
// receives an already-parsed message and writes rows. That is the same division the .eml importer
// uses, and it is what makes importing eight thousand messages cost the account almost no CPU.
//
// 管理后台「Gmail 导入」:把 Google Takeout 的邮件导出搬进某个邮箱。
//
// Takeout 是一个巨大的 mbox —— 开发时用的样本是 930MB、八千多封 —— 每封信头上都有一条
// X-Gmail-Labels,记着 Gmail 对它的看法:Inbox、Sent、Unread、Starred、Category personal,
// 以及主人自己起的任何名字。
//
// 从这一条头里要得出两种不同的东西。落到哪个**文件夹**是只有一个答案的判断 ——
// 一封信要么在收件箱要么已归档,不会同时在两处;而**标签**是对已经落好的邮件建的索引,
// 一封信可以有任意多个。所以映射是两张表,由操作者先填好,再开始上传。
//
// 活儿在这里干,不在服务端。切分 mbox、还原转义、解析每封信、判定文件夹与标签,全部发生在这个页签;
// Worker 收到的是已经解析好的邮件,只管写行。这与 .eml 导入是同一套分工,
// 也正是"导八千封信几乎不花账号 CPU"的原因。

import { api } from './api.js';
import { esc, icon, qs, qsa, toast, fmtSize, fmtDuration, confirmDialog } from './ui.js';
import { t } from './i18n.js';
import { LABEL_COLORS, LABEL_ICONS, openLookPicker } from './labels.js';
import PostalMime from '../vendor/postal-mime/postal-mime.js';

// Folders a Gmail label may be routed into. Drafts is deliberately absent: CFMail keeps drafts in
// their own table, and mail filed into the drafts folder would be listed by nothing.
// Gmail 标签可以路由到的文件夹。刻意不含草稿:CFMail 的草稿在单独的表里,
// 归到草稿文件夹的邮件不会被任何视图列出来。
const TARGET_FOLDERS = ['inbox', 'archive', 'sent', 'spam', 'trash'];

// Gmail's own labels, in the order they decide a folder: the first one a message carries wins.
// Trash and spam outrank everything, because a message in the bin is in the bin whatever else
// Gmail also thought about it.
// Gmail 自带的那些标签,按"谁先命中谁决定文件夹"的顺序排:回收站和垃圾邮件排在最前,
// 因为一封信进了垃圾桶就是进了垃圾桶,不管 Gmail 对它还有什么别的看法。
const SYSTEM_ORDER = [
  ['Trash', 'trash'],
  ['Spam', 'spam'],
  ['Sent', 'sent'],
  ['Draft', 'archive'],
  ['Drafts', 'archive'],
  ['Inbox', 'inbox'],
  ['Archived', 'archive'],
];

// Labels that say something about the message's state rather than its subject matter. They become
// flags, not labels: a folder full of things tagged "Unread" would be a folder full of nothing.
// 描述状态而非内容的标签。它们变成标记位,不变成标签:
// 一个装满"未读"标签的分类,等于一个什么也没说的分类。
const STATE_LABELS = new Set(['Unread', 'Opened', 'Starred', 'Important', 'IMAP_NotJunk', 'Archived']);

/**
 * The file is scanned one byte to one character so that offsets stay exact. That is right for
 * finding boundaries and wrong for reading text: a label named 客户 arrives as the bytes of its
 * UTF-8 encoding, one per character, and has to be put back together to survive the trip.
 *
 * Putting it back is not as simple as masking each code point. The decoder is asked for "latin1",
 * which the Encoding Standard defines as an alias for windows-1252, so byte 0x88 comes back as
 * U+02C6 rather than U+0088 and the mask would hand over the wrong byte. The mapping is still one
 * character per byte, though, so it can be inverted: decode all 256 bytes once with the very same
 * decoder and read the table backwards. Deriving the table from the decoder rather than assuming
 * one keeps this correct whatever that alias is taken to mean.
 *
 * 扫描时一字节对一字符,偏移量才精确。这对找边界是对的,对读文本是错的:
 * 名为「客户」的标签到手时,是它 UTF-8 编码的那几个字节,一字节一个字符,得拼回去才活得下来。
 *
 * 拼回去没有"把码点 & 0xff"那么简单。解码器要的是 "latin1",而按 Encoding 标准这是
 * windows-1252 的别名,于是字节 0x88 解出来是 U+02C6 而不是 U+0088,一 mask 就拿到错的字节。
 * 好在它仍是一字节一字符,那就反过来查:用同一个解码器把 256 个字节解一遍,倒着建表。
 * 表从解码器推导而来、而不是照抄一份,这样无论那个别名被解释成什么都不会错。
 */
const SCAN_DEC = new TextDecoder('latin1');
const BYTE_OF = new Map(
  [...SCAN_DEC.decode(new Uint8Array(Array.from({ length: 256 }, (_, i) => i)))].map((ch, i) => [ch, i])
);
const utf8 = (s) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = BYTE_OF.get(s[i]) ?? (s.charCodeAt(i) & 0xff);
  return new TextDecoder('utf-8').decode(b);
};

// Trimming before the bytes are decoded may only touch ASCII space and tab. String.trim() also
// strips U+00A0, and 0xA0 is an ordinary byte inside plenty of UTF-8 sequences -- letting it go
// would eat a byte out of the middle of somebody's label.
// 在字节还没解码之前做修剪,只能碰 ASCII 空格和制表符。String.trim() 连 U+00A0 一起剥,
// 而 0xA0 在许多 UTF-8 序列里就是普通的一个字节 —— 放它走,就等于从别人的标签中间啃掉一口。
const rawTrim = (s) => s.replace(/^[\x09\x20]+|[\x09\x20]+$/g, '');
const norm = (s) => utf8(s).trim();

// Gmail files its own tabs as "Category updates", "Category promotions" and so on. That prefix is
// Gmail's filing system talking about itself; what the label means is the word after it. The
// original still shows in the table, so nobody has to guess where the suggestion came from.
// Gmail 把自己的分类写成 "Category updates"、"Category promotions" 之类。那个前缀是 Gmail
// 在讲它自己的归档方式,标签的含义是后面那个词。表里仍然显示原名,不用猜这个建议是哪来的。
const suggestName = (s) => s.replace(/^Category\s+/i, '').trim() || s;

/** One pass over an mbox, remembering where every message starts and what Gmail said about it.
 *
 *  Nothing is kept but offsets and labels -- a few dozen bytes per message -- so a 930 MB file
 *  costs about half a megabyte of memory here, and the bytes of each message are read again only
 *  when it is its turn to be uploaded.
 *
 *  扫一遍 mbox,记住每封信从哪里开始、Gmail 说了它什么。
 *  只留偏移量和标签 —— 每封几十字节 —— 所以 930MB 的文件在这里大约占半兆内存,
 *  每封信的字节要等轮到它上传时才第二次读。 */
async function scanMbox(file, onProgress) {
  const CHUNK = 8 * 1024 * 1024;
  const dec = SCAN_DEC;   // 与 BYTE_OF 出自同一个解码器,还原时才对得上
  const msgs = [];
  const counts = new Map();

  let pos = 0;          // 已消费的绝对字节数
  let carry = '';       // 上一块末尾没读完的那半行
  let cur = null;       // 正在收集的这封信
  let inHeaders = false;
  let labelBuf = null;

  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  const flushLabels = () => {
    if (labelBuf === null || !cur) return;
    for (const l of labelBuf.split(',').map(norm).filter(Boolean)) {
      if (!cur.labels.includes(l)) cur.labels.push(l);
    }
    labelBuf = null;
  };
  const close = (end) => {
    if (!cur) return;
    flushLabels();
    cur.end = end;
    msgs.push(cur);
    for (const l of cur.labels) bump(l);
    cur = null;
  };

  // A separator is "From " at the start of a line followed by an envelope and an asctime date.
  // Body lines that would look like one are escaped in the file, so this does not need to guess.
  // 分隔行是行首的 "From " 加信封地址加 asctime 日期。正文里长得像的行在文件里是被转义过的,
  // 所以这里不需要猜。
  const SEP = /^From \S+ \w{3} \w{3} /;

  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = await file.slice(off, Math.min(off + CHUNK, file.size)).arrayBuffer();
    const text = carry + dec.decode(new Uint8Array(buf));
    const base = pos - carry.length;
    let lineStart = 0;
    for (;;) {
      const nl = text.indexOf('\n', lineStart);
      const last = nl < 0;
      if (last && off + CHUNK < file.size) break;            // 留给下一块
      const line = text.slice(lineStart, last ? text.length : nl).replace(/\r$/, '');
      const absStart = base + lineStart;
      if (SEP.test(line)) {
        close(absStart);
        cur = { start: absStart, end: file.size, labels: [] };
        inHeaders = true;
      } else if (cur && inHeaders) {
        if (line === '') { flushLabels(); inHeaders = false; }
        else if (labelBuf !== null && /^[ \t]/.test(line)) labelBuf += ' ' + rawTrim(line);
        else {
          flushLabels();
          if (/^X-Gmail-Labels:/i.test(line)) labelBuf = rawTrim(line.slice(line.indexOf(':') + 1));
        }
      }
      if (last) { lineStart = text.length; break; }
      lineStart = nl + 1;
    }
    carry = text.slice(lineStart);
    pos = off + buf.byteLength;
    onProgress?.(pos, file.size, msgs.length);
  }
  close(file.size);
  return { msgs, counts };
}

/**
 * The bytes of one message, with the mbox escaping undone.
 *
 * Gmail writes mboxrd: a body line beginning "From " is stored as ">From ", and one that already
 * began ">From " becomes ">>From ". Removing one ">" from any run is therefore the exact inverse.
 * Getting this wrong is not cosmetic -- it silently rewrites quoted replies.
 *
 * 取一封信的字节,并还原 mbox 转义。
 * Gmail 写的是 mboxrd:正文里以 "From " 开头的行存成 ">From ",本来就是 ">From " 的存成 ">>From "。
 * 所以从任意一串 ">" 里去掉一个,正是它的逆运算。这里搞错不是"不好看"的问题 ——
 * 它会悄悄改写引用的回信内容。
 */
async function readMessage(file, m) {
  const raw = new Uint8Array(await file.slice(m.start, m.end).arrayBuffer());
  // 跳过分隔行本身
  let i = 0;
  while (i < raw.length && raw[i] !== 10) i++;
  const body = raw.subarray(i + 1);

  const out = new Uint8Array(body.length);
  let w = 0;
  let atLineStart = true;
  for (let r = 0; r < body.length; r++) {
    if (atLineStart && body[r] === 62 /* > */) {
      // 数一串 '>' 后面是不是 "From "
      let k = r;
      while (k < body.length && body[k] === 62) k++;
      const isFrom = body[k] === 70 && body[k + 1] === 114 && body[k + 2] === 111 &&
                     body[k + 3] === 109 && body[k + 4] === 32;
      if (isFrom) r++;   // 丢掉一个 '>'
    }
    out[w++] = body[r];
    atLineStart = body[r] === 10;
  }
  return out.subarray(0, w);
}

/** The same fields the .eml importer sends, so the Worker never parses a second time
 *  与 .eml 导入发送的字段一致,Worker 不会再解析第二遍 */
async function parseLocally(bytes) {
  const p = await new PostalMime().parse(bytes);
  return {
    from: p.from ? { name: p.from.name || '', address: p.from.address || '' } : null,
    to: p.to || [], cc: p.cc || [], bcc: p.bcc || [], replyTo: p.replyTo || [],
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

/**
 * @param opts.onExclusive  called with true when the mapping takes over the page, false on the way
 *                          back -- the tab uses it to fold the other sources away
 * @param opts.onBack       return to the sources; the tab re-renders from scratch
 * onExclusive:映射表接管页面时传 true、返回时传 false —— 页签据此把另外两个来源收起来
 * onBack:回到来源列表;页签会整个重画
 */
export async function tabGmail(body, opts = {}) {
  let running = false;
  const { mailboxes } = await api('GET', '/api/admin/mailbox-options');
  let handle = null;
  let mboxes = [];        // [{name, file}]
  let index = null;       // scanMbox 的结果
  let cancelled = false;

  const supported = !!window.showDirectoryPicker;

  body.innerHTML = `
    <section class="card" id="gm-pick-card">
      <h3>${esc(t('gm_title'))}</h3>
      <p class="dim">${esc(t('gm_intro'))}</p>
      ${supported ? '' : `<p class="dim">${esc(t('exp_unsupported'))}</p>`}
      <div class="form-row">
        <label>${esc(t('gm_folder'))}</label>
        <wa-button appearance="outlined" id="gm-pick" ${supported ? '' : 'disabled'}>${icon('folder', 16)} ${esc(t('gm_pick'))}</wa-button>
        <span class="dim" id="gm-found"></span>
      </div>
      <div id="gm-scan" class="dim"></div>
    </section>
    <section class="card" id="gm-map" hidden></section>
    <section class="card" id="gm-run" hidden>
      <h3>${esc(t('gm_running'))}</h3>
      <div class="imp-bar"><div class="imp-bar-fill" id="gm-fill" style="width:0%"></div></div>
      <div class="row-flex">
        <span id="gm-progress" class="dim"></span><span class="flex1"></span>
        <span id="gm-eta" class="dim"></span>
        <wa-button appearance="plain" size="small" id="gm-cancel">${esc(t('cancel'))}</wa-button>
      </div>
      <div id="gm-fails"></div>
    </section>`;

  qs('#gm-pick').addEventListener('click', async () => {
    try {
      handle = await window.showDirectoryPicker({ mode: 'read' });
    } catch {
      return; // 用户取消
    }
    mboxes = await findMbox(handle);
    qs('#gm-found').textContent = mboxes.length
      ? t('gm_found', mboxes.length, fmtSize(mboxes.reduce((n, m) => n + m.file.size, 0)))
      : t('gm_none');
    if (!mboxes.length) return;
    await scanAll();
  });

  async function findMbox(dirHandle, prefix = '') {
    const out = [];
    for await (const [name, h] of dirHandle.entries()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (h.kind === 'directory') out.push(...(await findMbox(h, rel)));
      else if (/\.mbox$/i.test(name)) out.push({ rel, file: await h.getFile() });
    }
    return out;
  }

  async function scanAll() {
    const el = qs('#gm-scan');
    const all = { msgs: [], counts: new Map() };
    for (const m of mboxes) {
      const r = await scanMbox(m.file, (done, total, n) => {
        el.textContent = t('gm_scanning', m.rel, Math.round((done / total) * 100), n);
      });
      for (const x of r.msgs) all.msgs.push({ ...x, file: m.file });
      for (const [k, v] of r.counts) all.counts.set(k, (all.counts.get(k) || 0) + v);
    }
    index = all;
    el.textContent = t('gm_scanned', all.msgs.length, all.counts.size);
    renderMapping();
  }

  // ---------- Mapping ----------
  // ---------- 映射 ----------

  function renderMapping() {
    const total = index.msgs.length;
    const found = [...index.counts.entries()].sort((a, b) => b[1] - a[1]);
    const system = SYSTEM_ORDER.filter(([name]) => index.counts.has(name));
    const rest = found.filter(([name]) => !STATE_LABELS.has(name) && !SYSTEM_ORDER.some(([s]) => s === name));

    const folderRows = system.map(([name, def]) => `
      <tr>
        <td><code>${esc(name)}</code></td>
        <td class="dim">${index.counts.get(name)}</td>
        <td><wa-select class="gm-fold" data-label="${esc(name)}" value="${def}" style="width:150px">
          ${TARGET_FOLDERS.map((f) => `<wa-option value="${f}">${esc(t(`f_${f}`))}</wa-option>`).join('')}
        </wa-select></td>
      </tr>`).join('');

    // A label on nearly every message classifies nothing, so it starts unticked -- the Takeout
    // this was built against had three such labels, each on 99% of the mail.
    // 贴在几乎每封信上的标签什么也没分类,所以默认不勾 —— 开发用的那份 Takeout 里
    // 有三个这样的标签,每个都覆盖 99% 的邮件。
    const labelRows = rest.map(([name, n], i) => {
      const noisy = n / total > 0.9;
      return `
      <tr data-src="${esc(name)}">
        <td><input type="checkbox" class="gm-use" ${noisy ? '' : 'checked'}></td>
        <td><code>${esc(name)}</code></td>
        <td class="dim">${n}${noisy ? ` <span title="${esc(t('gm_noisy_hint'))}">⚠</span>` : ''}</td>
        <td><input type="text" class="gm-name" maxlength="40" value="${esc(suggestName(name))}" style="width:180px"></td>
        <td>
          <button type="button" class="gm-look" title="${esc(t('gm_look_hint'))}"
            data-color="${LABEL_COLORS[i % LABEL_COLORS.length]}" data-icon="${LABEL_ICONS[i % LABEL_ICONS.length]}"
            style="color:var(--lb-${LABEL_COLORS[i % LABEL_COLORS.length]})">${icon(LABEL_ICONS[i % LABEL_ICONS.length], 20)}</button>
        </td>
      </tr>`;
    }).join('');

    // The mapping is a step, not a panel: while you are filling it in, the other ways in are not
    // choices you are weighing, they are clutter. They come back when you go back.
    // 映射是一个步骤,不是一块面板:你在填它的时候,另外几条路不是待选项,只是干扰。
    // 返回时它们再回来。
    qs('#gm-pick-card').hidden = true;
    opts.onExclusive?.(true);
    qs('#gm-map').hidden = false;
    qs('#gm-map').innerHTML = `
      <div class="row-flex" style="margin-bottom:10px">
        <wa-button appearance="plain" size="small" id="gm-back">${icon('back', 16)} ${esc(t('back'))}</wa-button>
      </div>
      <h3>${esc(t('gm_map_folders'))}</h3>
      <p class="dim">${esc(t('gm_map_folders_note'))}</p>
      <table class="table"><thead><tr>
        <th>${esc(t('gm_gmail_label'))}</th><th>${esc(t('gm_count'))}</th><th>${esc(t('gm_target_folder'))}</th>
      </tr></thead><tbody>${folderRows || `<tr><td colspan="3" class="dim">${esc(t('gm_none_system'))}</td></tr>`}</tbody></table>
      <div class="form-row">
        <label>${esc(t('gm_default_folder'))}</label>
        <wa-select id="gm-default" value="archive" style="width:150px">
          ${TARGET_FOLDERS.map((f) => `<wa-option value="${f}">${esc(t(`f_${f}`))}</wa-option>`).join('')}
        </wa-select>
      </div>

      <h3 style="margin-top:20px">${esc(t('gm_map_labels'))}</h3>
      <p class="dim">${esc(t('gm_map_labels_note'))}</p>
      <table class="table"><thead><tr>
        <th></th><th>${esc(t('gm_gmail_label'))}</th><th>${esc(t('gm_count'))}</th>
        <th>${esc(t('gm_target_label'))}</th><th>${esc(t('gm_look'))}</th>
      </tr></thead><tbody>${labelRows || `<tr><td colspan="5" class="dim">${esc(t('gm_none_labels'))}</td></tr>`}</tbody></table>
      <p class="dim">${esc(t('gm_state_note'))}</p>

      <div class="form-row" style="margin-top:16px">
        <label>${esc(t('gm_into'))}</label>
        <wa-select id="gm-mb" value="${esc(mailboxes[0]?.id || '')}" style="width:300px">
          ${mailboxes.map((m) => `<wa-option value="${esc(m.id)}">${esc(m.address)}</wa-option>`).join('')}
        </wa-select>
      </div>
      <div class="form-row">
        <label></label>
        <wa-button variant="brand" id="gm-go">${esc(t('gm_start'))}</wa-button>
        <span class="dim">${esc(t('gm_dedup_note'))}</span>
      </div>`;
    // The mark is the control: click the coloured glyph and the popup changes that glyph. Two
    // dropdowns naming a colour and a shape describe the thing; the thing itself is quicker.
    // 记号本身就是控件:点那个彩色字形,浮层改的就是它。
    // 两个写着颜色名和形状名的下拉框是在"描述"它,而直接点它更快。
    qsa('#gm-map .gm-look').forEach((b) =>
      b.addEventListener('click', (e) => {
        const r = b.getBoundingClientRect();
        openLookPicker(r.left, r.bottom + 4, {
          color: b.dataset.color, icon: b.dataset.icon,
          onPick: ({ color, icon: ic }) => {
            b.dataset.color = color;
            b.dataset.icon = ic;
            b.style.color = `var(--lb-${color})`;
            b.innerHTML = icon(ic, 20);
          },
        });
      }));
    qs('#gm-back').addEventListener('click', () => { if (!running) opts.onBack?.(); });
    qs('#gm-go').addEventListener('click', run);
  }

  // ---------- Run ----------
  // ---------- 执行 ----------

  async function run() {
    const mbId = qs('#gm-mb').value;
    const mbAddr = mailboxes.find((m) => m.id === mbId)?.address || '';
    if (!mbId) return toast(t('imp_pick_mailbox'), true);

    const folderOf = new Map();
    qsa('.gm-fold').forEach((s) => folderOf.set(s.dataset.label, s.value));
    const fallback = qs('#gm-default').value;

    const wanted = [...qsa('#gm-map tbody tr[data-src]')]
      .filter((tr) => tr.querySelector('.gm-use').checked)
      .map((tr) => ({
        src: tr.dataset.src,
        name: tr.querySelector('.gm-name').value.trim() || tr.dataset.src,
        color: tr.querySelector('.gm-look').dataset.color,
        icon: tr.querySelector('.gm-look').dataset.icon,
      }));

    if (!(await confirmDialog(t('gm_confirm', index.msgs.length, mbAddr, wanted.length), t('gm_start')))) return;

    // Labels are created once, before anything is uploaded, so every message can name them by id
    // and the server never has to look one up by name.
    //
    // Through the admin API, not the user-facing one: the latter asks whether you hold a grant on
    // the mailbox, and an administrator importing into a mailbox they do not personally read holds
    // none -- which came back as "no access to that mailbox" for a mailbox they had just created.
    //
    // 标签在上传任何东西之前一次建好,于是每封信都能直接用 id 指名,服务端不必按名字去找。
    //
    // 走管理接口而不是面向用户的那套:后者问的是"你在这个邮箱上有没有授权",
    // 而管理员往一个自己并不阅读的邮箱里导入时并没有授权 ——
    // 于是会对着一个他刚建好的邮箱收到"无权访问该邮箱"。
    const existing = (await api('GET', `/api/admin/mailboxes/${mbId}/labels`)).labels || [];
    const idOf = new Map();
    for (const w of wanted) {
      const hit = existing.find((l) => l.name === w.name);
      if (hit) { idOf.set(w.src, hit.id); continue; }
      try {
        const r = await api('POST', `/api/admin/mailboxes/${mbId}/labels`, { name: w.name, icon: w.icon, color: w.color });
        idOf.set(w.src, r.id);
      } catch (e) {
        toast(e.message, true);
        return;
      }
    }

    qs('#gm-run').hidden = false;
    qs('#gm-fails').innerHTML = '';
    cancelled = false;
    // Going back mid-run would leave half an import behind with no way to see how far it got.
    // 跑到一半返回,会留下半次导入,而且再也看不到它跑到哪儿了。
    running = true;
    qs('#gm-back').disabled = true;
    const prog = qs('#gm-progress');
    const eta = qs('#gm-eta');
    const fill = qs('#gm-fill');
    const started = Date.now();
    const stat = { ok: 0, dup: 0, fail: 0 };
    const fails = [];

    for (let i = 0; i < index.msgs.length; i++) {
      if (cancelled) break;
      const m = index.msgs[i];
      try {
        const bytes = await readMessage(m.file, m);
        const meta = await parseLocally(bytes);

        let folder = fallback;
        for (const [name] of SYSTEM_ORDER) {
          if (m.labels.includes(name) && folderOf.has(name)) { folder = folderOf.get(name); break; }
        }
        const ids = m.labels.map((l) => idOf.get(l)).filter(Boolean);
        // Gmail's star is our built-in label, which is the flagged bit -- so it rides as a flag
        // rather than as one more id.
        // Gmail 的星标就是我们的内置标签,也就是 flagged 那一位 —— 所以它作为标记位传,
        // 而不是再多一个 id。
        const q2 = new URLSearchParams({ mailbox: mbAddr, folder });
        q2.set('seen', m.labels.includes('Unread') ? '0' : '1');
        if (m.labels.includes('Starred')) q2.set('flagged', '1');
        if (meta.messageId) q2.set('message_id', meta.messageId);
        if (ids.length) q2.set('labels', ids.join(','));

        const fd = new FormData();
        fd.append('meta', JSON.stringify(meta));
        fd.append('eml', new Blob([bytes]), 'message.eml');
        const res = await fetch(`/api/admin/import?${q2}`, { method: 'POST', body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        if (j.skipped) stat.dup++;
        else stat.ok++;
      } catch (err) {
        stat.fail++;
        if (fails.length < 20) fails.push(`#${i + 1}: ${err.message}`);
      }
      const done = i + 1;
      fill.style.width = ((done / index.msgs.length) * 100).toFixed(1) + '%';
      prog.textContent = t('imp_progress', done, index.msgs.length, stat.ok, stat.dup, stat.fail);
      if (done >= 3 && done < index.msgs.length) {
        const per = (Date.now() - started) / done;
        eta.textContent = t('imp_eta', fmtDuration(per * (index.msgs.length - done)));
      } else if (done >= index.msgs.length) {
        eta.textContent = '';
      }
    }

    // Importing carries a whole archive of somebody's mail into the system; the run leaves a trace
    // even when it was cancelled halfway.
    // 导入等于把别人的一整批邮件搬进系统;哪怕中途取消,这次运行也要留痕。
    if (stat.ok || stat.dup || stat.fail) {
      await api('POST', `/api/admin/mailboxes/${mbId}/import-done`, {
        ok: stat.ok, duplicate: stat.dup, failed: stat.fail, cancelled,
      }).catch(() => {});
    }
    running = false;
    const back = qs('#gm-back');
    if (back) back.disabled = false;
    prog.textContent = cancelled
      ? t('imp_cancelled', stat.ok, stat.dup, stat.fail)
      : t('imp_done', stat.ok, stat.dup, stat.fail);
    qs('#gm-fails').innerHTML = fails.length
      ? `<pre class="dim" style="white-space:pre-wrap;font-size:12px">${esc(fails.join('\n'))}</pre>`
      : '';
  }

  qs('#gm-cancel').addEventListener('click', () => { cancelled = true; });
}
