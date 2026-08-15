// Archive-as-folder browsing, lazy-loaded only when the user steps into an archive. The
// format readers (rzip.js, r7z.js) are ranged: listing costs a couple of tail reads, entry
// extraction fetches only that entry's bytes. Everything is read-only and thumbnail-less;
// previews reuse the main preview overlay through blob URLs.
// 压缩包当目录浏览,仅在用户点进压缩包时才懒加载。格式读取器(rzip.js、r7z.js)全是
// Range 式:列目录只读文件尾几次,取条目只拉该条目的字节。整个视图只读、无缩略图;
// 预览通过 blob URL 复用主预览层。
import { t, tErr } from '../i18n.js';
import { esc, icon, qs, qsa, toast, fmtSize, fmtDate, fileIcon, showModal, closeModal } from '../ui.js';
import { store, navigate } from '../app.js';
import {
  arcHash, arcSeed, dlUrl as srcDl, folderHash, fsrc, inArc, metaUrl, preview, streamQuery,
} from './fsrc.js';

const dlUrl = (id) => srcDl(id, true);

export { arcHash };
const ARC_PV_CAP = 256 * 1024 * 1024;  // extraction cap for preview / 在线预览的解出上限
const READER_CACHE = 3;                // open listings kept around / 缓存几份已开的目录

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
  m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', pdf: 'application/pdf',
};
const extOf = (name) => (/\.([A-Za-z0-9]{1,12})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();

const readers = new Map(); // fileId -> Promise<{ reader, name, size }>
let cur = null;            // { id, name, size, reader, path, urls: Map, sort }

// Download meter for the OPEN phase (header decode + password probe). Opening a big or
// header-compressed archive pulls real data before the listing shows; this drives a
// progress + rate readout there, the same way the preview note does for extraction.
// 打开阶段(头解码 + 密码探测)的下载计量。打开大档案或压缩头档案会在列目录前拉真实数据;
// 用它在那里显示进度 + 速率,与预览提示对解出所做的一样。
// Progress is reported as a PERCENTAGE of the read in flight, not as a byte total. Opening an
// archive is a handful of ranged reads whose sizes are known up front (signature header, then
// the directory), so "62%" is both true and useful; a byte counter, by contrast, sits at
// "1 KB" through the entire wait and then jumps -- which reads as frozen, not as working.
// 进度按"进行中那次读取的百分比"报告,不是字节总量。打开压缩包就是几次大小已知的 Range 读取
// (签名头,然后是目录),所以"62%"既真实又有用;而字节计数器会在整个等待期间停在"1 KB"然后
// 突然跳完 —— 那看起来是卡死,不是在工作。
const openMeter = { samples: [], got: 0, want: 0, active: false };
function openMeterReset() {
  openMeter.samples = [{ t: performance.now(), c: 0 }];
  openMeter.got = 0;
  openMeter.want = 0;
  openMeter.active = true;
}
function openMeterProgress(got, want) {
  openMeter.got = got;
  openMeter.want = want;
  const now = performance.now();
  openMeter.samples.push({ t: now, c: (openMeter.samples[openMeter.samples.length - 1]?.c || 0) + got });
  while (openMeter.samples.length > 2 && openMeter.samples[0].t < now - 5000) openMeter.samples.shift();
}
function openMeterStop() { openMeter.active = false; }
function openMeterInfo() {
  if (!openMeter.active || !openMeter.want) return null;
  const s = openMeter.samples;
  let bps = 0;
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if (b.t - a.t > 150) bps = ((b.c - a.c) * 1000) / (b.t - a.t);
  }
  return { pct: Math.min(100, (openMeter.got / openMeter.want) * 100), bps };
}

// Passwords for encrypted archives live only in the browser: the whole archive is decrypted
// locally, the plaintext password is never sent to the server. Session memory always; the
// browser's localStorage only if the user ticks "remember".
// 加密压缩包的密码只留在浏览器:整个压缩包在本地解密,明文密码绝不发往服务器。始终存会话内存;
// 用户勾选"记住"才另存浏览器 localStorage。
const PW_KEY = 'cf_arc_pw';
const pwCache = new Map(); // fileId -> password / 会话内存缓存
function savedPw(id) {
  if (pwCache.has(id)) return pwCache.get(id);
  try {
    const store2 = JSON.parse(localStorage.getItem(PW_KEY) || '{}');
    return store2[id] || null;
  } catch {
    return null;
  }
}
function rememberPw(id, pw, persist) {
  pwCache.set(id, pw);
  if (persist) {
    try {
      const store2 = JSON.parse(localStorage.getItem(PW_KEY) || '{}');
      store2[id] = pw;
      localStorage.setItem(PW_KEY, JSON.stringify(store2));
    } catch {}
  }
}
function forgetPw(id) {
  pwCache.delete(id);
  try {
    const store2 = JSON.parse(localStorage.getItem(PW_KEY) || '{}');
    if (store2[id]) {
      delete store2[id];
      localStorage.setItem(PW_KEY, JSON.stringify(store2));
    }
  } catch {}
}

/** Prompt for an archive password. States the local-only guarantee and offers to remember it.
 *  Resolves to { password, persist } or null if cancelled.
 *  弹出压缩包密码框。声明"仅本地解密"并可选择记住。返回 { password, persist } 或取消时 null。 */
function promptPassword(name, retry) {
  return new Promise((resolve) => {
    const d = showModal(`
      <div style="font-size:16px;font-weight:600;margin-bottom:4px">${esc(t('drv_arc_pw_title'))}</div>
      <div class="drv-dim" style="font-size:13px;margin-bottom:10px;word-break:break-all">${esc(name)}</div>
      ${retry ? `<div style="color:var(--danger,#d33);font-size:13px;margin-bottom:8px">${esc(tErr('e_arc_password'))}</div>` : ''}
      <wa-input type="password" id="arc-pw-in" autofocus placeholder="${esc(t('drv_arc_pw_ph'))}" style="width:100%"></wa-input>
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="arc-pw-save"> ${esc(t('drv_arc_pw_save'))}
      </label>
      <div class="drv-dim" style="display:flex;gap:6px;align-items:flex-start;font-size:12px;margin-top:10px;line-height:1.5">
        ${icon('shield', 15)}<span>${esc(t('drv_arc_pw_note'))}</span>
      </div>
      <div slot="footer" style="display:flex;gap:8px;justify-content:flex-end">
        <wa-button appearance="plain" data-x="cancel">${esc(t('cancel'))}</wa-button>
        <wa-button variant="brand" data-x="ok">${esc(t('confirm'))}</wa-button>
      </div>`);
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
      closeModal();
    };
    const submit = () => {
      const v = d.querySelector('#arc-pw-in')?.value || '';
      if (!v) return;
      finish({ password: v, persist: !!d.querySelector('#arc-pw-save')?.checked });
    };
    d.addEventListener('click', (e) => {
      const b = e.target.closest?.('[data-x]');
      if (b) (b.dataset.x === 'ok' ? submit() : finish(null));
    });
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    d.addEventListener('wa-hide', (e) => {
      if (e.target === d) finish(null);
    });
    setTimeout(() => d.querySelector('#arc-pw-in')?.focus(), 60);
  });
}

// Self-cleaning: when the hash leaves this archive, blob URLs die with the visit
// 自清理。hash 一离开这个压缩包,blob URL 随访问一起释放
window.addEventListener('hashchange', () => {
  if (cur && !inArc(cur.id)) leave();
});

function leave() {
  if (!cur) return;
  for (const u of cur.urls.values()) URL.revokeObjectURL(u);
  cur = null;
  qs('.drv-new')?.removeAttribute('disabled');
}

/** Full seed (name, size, breadcrumb prefix, access) from the meta endpoint -- deep links
 *  and reloads rebuild the path bar with it.
 *  从 meta 端点取完整种子(名称、大小、路径前缀、权限)。深链与刷新靠它重建路径条。 */
async function probe(id) {
  const r = await fetch(metaUrl(id), { credentials: 'include' });
  if (!r.ok) throw new Error('e_drive_not_found');
  const j = await r.json();
  return { name: j.node.name, size: j.node.size, crumbs: j.path || [], access: j.access };
}

async function openReader(id) {
  if (readers.has(id)) return readers.get(id);
  const p = (async () => {
    let seed = arcSeed.get(id);
    if (!seed || !seed.crumbs) {
      seed = await probe(id);
      arcSeed.set(id, seed); // crumbs() reads it later / crumbs() 之后要用
    }
    const ext = extOf(seed.name);
    const mod = ext === '7z'
      ? await import('./r7z.js?v=' + encodeURIComponent(store.brand?.version || ''))
      : await import('./rzip.js?v=' + encodeURIComponent(store.brand?.version || ''));
    const { httpSource } = await import('./rzip.js?v=' + encodeURIComponent(store.brand?.version || ''));
    const src = () => httpSource(dlUrl(id), seed.size, openMeterProgress);
    const openWith = (pw) => (ext === '7z' ? mod.open7z(src(), pw) : mod.openZip(src(), pw));
    // Open, prompting for a password when the archive (or its header) is encrypted and none
    // works yet. A wrong password loops the prompt; cancelling aborts.
    // 打开压缩包;若加密(或头加密)且尚无可用密码则弹框。密码错就循环再问,取消即中止。
    let pw = savedPw(id);
    let reader;
    let retry = false;
    for (;;) {
      try {
        reader = await openWith(pw);
        // Encrypted archives (7z content, or zip entries with the ZipCrypto bit) open and list
        // fine; the encryption only bites on extraction. Verify the password now so a missing or
        // wrong one prompts here rather than failing at first preview. The check is cheap: 7z
        // decodes only a small prefix (never deep into a solid block), zip checks the smallest
        // file's ZipCrypto header. Header-encrypted 7z is already proven by opening it.
        // 加密压缩包(7z 内容,或带 ZipCrypto 位的 zip 条目)能正常打开列目录,加密只在解出时生效。
        // 现在就校验密码,让缺失/错误的密码在此弹框而非首个预览才失败。校验很便宜:7z 只解一小段
        // 前缀(绝不深入固实块),zip 查最小文件的 ZipCrypto 头。头加密 7z 打开成功即已证明。
        if (reader.encrypted) {
          if (reader.verifyPassword) await reader.verifyPassword();
          else {
            const probe2 = smallestFileEntry(reader); // zip: cheap header check on a small file
            if (probe2) await reader.extract(probe2);
          }
        }
        break;
      } catch (e) {
        const msg = e && e.message;
        if (msg !== 'e_arc_encrypted' && msg !== 'e_arc_password') throw e;
        const res = await promptPassword(seed.name, retry);
        if (!res) throw new Error('arc_pw_cancel'); // user cancelled / 用户取消
        pw = res.password;
        rememberPw(id, pw, res.persist);
        retry = true;
      }
    }
    if (pw) {
      rememberPw(id, pw, false); // keep in session memory / 存会话内存
      pushPwToSw(id, pw); // the streaming worker needs it too / 流式 worker 也要用
    }
    return { reader, ...seed };
  })();
  p.catch(() => readers.delete(id));
  readers.set(id, p);
  // Tiny LRU: drop the oldest listing beyond the cap / 简易 LRU,超额挤掉最老的
  if (readers.size > READER_CACHE) readers.delete(readers.keys().next().value);
  return p;
}

/** The smallest file entry to extract for a password check. Prefers an actually-encrypted
 *  entry (zip archives can mix encrypted and plain files), so the probe genuinely needs the
 *  password; falls back to the smallest file when none is flagged (e.g. 7z content encryption).
 *  用于校验密码的最小文件条目。优先选真正加密的条目(zip 可混装加密与明文),让试探确实要密码;
 *  没有标记加密的(如 7z 内容加密)则退回最小文件。 */
function smallestFileEntry(reader) {
  let bestEnc = null;
  let bestAny = null;
  const walk = (path) => {
    for (const k of reader.dir(path) || []) {
      const full = path ? path + '/' + k.name : k.name;
      if (k.isDir) { walk(full); continue; }
      const e = reader.stat(full);
      if (!e) continue;
      if (!bestAny || (e.size || 0) < (bestAny.size || 0)) bestAny = e;
      if (e.encrypted && (!bestEnc || (e.size || 0) < (bestEnc.size || 0))) bestEnc = e;
    }
  };
  walk('');
  return bestEnc || bestAny;
}

/** Hand the archive password to the streaming service worker and wait until it confirms
 *  receipt -- so a stream fetch that follows never races ahead of the password. Never leaves
 *  the browser. Resolves false if there is no worker or it does not answer quickly.
 *  把压缩包密码交给流式 service worker 并等它确认收到 —— 随后的流式请求就不会抢在密码前面。
 *  绝不离开浏览器。无 worker 或未及时回执则返回 false。 */
function pushPwToSw(id, pw) {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw || !pw) return resolve(false);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => done(true);
      sw.postMessage({ type: 'arc-pw', id, pw }, [ch.port2]);
      setTimeout(() => done(false), 1500);
    } catch {
      done(false);
    }
  });
}

/** Entry point, called by drive.js routing / 入口,由 drive.js 路由调用 */
export async function renderArc(id, path, mainEl) {
  const main = mainEl || qs('#drv-main');
  if (!main) return;
  ensureSw(); // warm up while the listing loads / 列目录的同时预热 SW
  qs('.drv-new')?.setAttribute('disabled', '');
  // Resolve just the name/size/crumbs first, so the path bar switches to the archive state
  // IMMEDIATELY -- before the (possibly slow, possibly failing) reader open. Whatever happens
  // next, the bar already shows "inside this archive".
  // 先只解析名称/大小/面包屑,让路径 bar 立刻切到压缩包状态 —— 早于(可能慢、可能失败的)
  // 读取器打开。无论后续成败,路径 bar 已显示"在这个压缩包内"。
  let seed = arcSeed.get(id);
  if (!seed || !seed.crumbs) {
    try {
      seed = await probe(id);
      arcSeed.set(id, seed);
    } catch (e) {
      main.innerHTML = `<div class="drv-empty">${icon('fileZip', 48)}<div>${esc(tErr(e && e.message))}</div></div>`;
      return;
    }
  }
  if (cur && cur.id !== id) leave();
  if (!cur) cur = { id, name: seed.name, size: seed.size, reader: null, path: '', urls: new Map(), sort: { key: 'name', dir: 1 } };
  cur.name = seed.name;
  cur.size = seed.size;
  cur.path = path || '';
  // Path bar + read-only marker up front; body shows loading while the reader opens
  // 路径 bar 与只读标记先就位;读取器打开期间,内容区显示加载中
  paintShell(main, `<div class="drv-loading" style="margin:auto"><div class="drv-spin"></div><span>${esc(t('loading'))}</span><span class="drv-arcmeter"></span></div>`);
  // Opening reads real bytes (header decode, and for encrypted archives a short block probe),
  // which on a big archive is a visible wait -- so show how much has come down and how fast,
  // the same readout the preview gives while extracting.
  // 打开会读真实字节(头解码,加密档案还要探一小段块),大档案上是肉眼可见的等待 —— 所以显示
  // 已下多少、多快,与预览解出时给的读数一致。
  openMeterReset();
  const meterTimer = setInterval(() => {
    const el = qs('.drv-arcmeter', main);
    const inf = openMeterInfo();
    if (!el || !inf) return;
    el.textContent = `${inf.pct.toFixed(0)}%${inf.bps ? ` · ${fmtSize(inf.bps)}/s` : ''}`;
  }, 250);
  let opened;
  try {
    opened = await openReader(id);
  } catch (e) {
    if (!inArc(cur.id)) return; // navigated away / 已离开
    // Cancelling the password prompt just backs out to where the archive was opened from
    // 取消密码框就退回打开压缩包的来路
    if (e && e.message === 'arc_pw_cancel') {
      const back = arcSeed.get(cur.id)?.crumbs?.slice(-1)[0];
      leave();
      navigate(back ? folderHash(back.id) : fsrc.root);
      return;
    }
    // Keep the archive path bar; report the failure inside the content area
    // 保留压缩包路径 bar;失败在内容区内报告
    paintShell(main, `<div class="drv-empty">${icon('fileZip', 48)}<div>${esc(tErr(e && e.message))}</div></div>`);
    return;
  } finally {
    clearInterval(meterTimer);
    openMeterStop();
  }
  cur.reader = opened.reader;
  cur.name = opened.name;
  cur.size = opened.size;
  paint(main);
}

/** Frame with the archive path bar + read-only marker, and an arbitrary body (loading / error /
 *  listing). Rendering the bar first is what keeps it in the archive state on any outcome.
 *  含压缩包路径 bar 与只读标记的框架,body 任意(加载/错误/列表)。先渲染 bar 就能在任何
 *  结局下保持压缩包状态。 */
function paintShell(main, bodyHtml) {
  main.innerHTML = `
    <div id="drv-bar"><div class="drv-crumbbar"><div class="drv-crumbs">${crumbs()}</div><span class="sp"></span></div></div>
    <div class="drv-ctx drv-arcbar">${icon('fileZip', 18)}<span>${esc(t('drv_arc_readonly'))}</span></div>
    <div class="drv-scroll">${bodyHtml}</div>`;
  qsa('#drv-bar .drv-crumb[data-nav]', main).forEach((el) =>
    el.addEventListener('click', () => navigate(el.dataset.nav)));
}

function paint(main) {
  const { reader, path } = cur;
  const kids = reader.dir(path);
  if (!kids) {
    toast(t('drv_arc_bad'), true);
    navigate(arcHash(cur.id, ''));
    return;
  }
  const nodes = kids.map(toNode).sort(cmp);
  cur.shown = nodes;
  const layout = localStorage.getItem('cf_drive_layout') || 'list';
  paintShell(main, nodes.length
    ? (layout === 'grid' ? grid(nodes) : table(nodes))
    : `<div class="drv-empty">${icon('fileZip', 64)}<div>${esc(t('drv_empty_folder'))}</div></div>`);
  bind(main);
}

function toNode(k) {
  const entryPath = cur.path ? cur.path + '/' + k.name : k.name;
  return {
    id: 'arc:' + entryPath,
    kind: k.isDir ? 'folder' : 'file',
    name: k.name,
    size: k.size || 0,
    tree_bytes: k.isDir ? k.size || 0 : 0,
    updated_at: k.mtime || 0,
    mime: MIME_BY_EXT[extOf(k.name)] || '',
    arc: true,
    arcPath: entryPath,
    arcGet: k.isDir ? null : () => entryUrl(entryPath, k),
    // Escape hatch when a streamed URL will not load: extract in the page instead
    // 流式 URL 加载不出来时的退路:改在页面内解出
    arcBlob: k.isDir ? null : () => entryUrl(entryPath, k, true),
    // Live read counter for the no-worker fallback, where arcGet() extracts the whole entry
    // up front and can sit there a while on a big solid block.
    // 无 worker 回退路径的实时读取计数 —— 那条路 arcGet() 会先整体解出条目,
    // 碰上大固实块会卡上一阵。
    arcMeter: openMeterInfo,
  };
}

const cmp = (a, b) => {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  const { key, dir } = cur.sort;
  let r = 0;
  if (key === 'size') r = a.size - b.size;
  else if (key === 'updated_at') r = a.updated_at - b.updated_at;
  if (!r) r = String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
  return r * dir;
};

/** Streaming service worker: registered once, scope '/', touches only /arc-stream/*.
 *  With it, entries get a URL that streams on demand -- ranged passthrough for stored
 *  bytes, sequential decode for compressed ones -- and nothing is pre-extracted at all.
 *  流式 Service Worker:注册一次,scope '/',只碰 /arc-stream/*。有它在,条目拿到的是
 *  按需流动的 URL —— 直存字节按段直通,压缩字节顺序解码 —— 完全不用预先解出。 */
let swReady = null;
function ensureSw() {
  // A controller that is here NOW settles it, whatever an earlier probe concluded. The first
  // probe runs while the archive listing loads, often before the worker has claimed the page;
  // caching that "no" would pin the whole session to the in-page fallback, which extracts every
  // entry in full -- ruinous for large ones, and outright refused past the preview cap.
  // 此刻有 controller 就够了,不管先前那次探测得出什么结论。首次探测是在列压缩包目录时跑的,
  // 常常早于 worker 接管页面;把那个"否"缓存下来,会把整个会话钉死在页内回退路径 ——
  // 它要把条目整个解出来,大文件代价惨重,超过预览上限更是直接拒绝。
  if (navigator.serviceWorker?.controller) return Promise.resolve(true);
  if (swReady !== null) return swReady;
  swReady = (async () => {
    if (!('serviceWorker' in navigator)) return false;
    try {
      await navigator.serviceWorker.register(
        '/assets/drive/arc-sw.js?v=' + encodeURIComponent(store.brand?.version || ''),
        { scope: '/', type: 'module' },
      );
      await navigator.serviceWorker.ready;
      // clients.claim() lands a beat later; give it a moment / clients.claim() 稍晚生效,等一拍
      for (let i = 0; i < 20 && !navigator.serviceWorker.controller; i++) {
        await new Promise((res) => setTimeout(res, 100));
      }
      return !!navigator.serviceWorker.controller;
    } catch {
      return false;
    }
  })();
  return swReady;
}

const streamUrl = (entryPath) =>
  `/arc-stream/${encodeURIComponent(cur.id)}/${cur.size}/${extOf(cur.name)}/`
  + entryPath.split('/').map(encodeURIComponent).join('/') + streamQuery();

/** URL for an entry: the streaming URL when the worker took control, else a blob of the
 *  client-side extraction (capped). Cached per visit.
 *  条目的 URL。SW 接管则给流式 URL,否则退回客户端解出的 blob(有上限)。按访问缓存。 */
async function entryUrl(entryPath, k, forceBlob) {
  const key = forceBlob ? entryPath + ' blob' : entryPath;
  if (cur.urls.has(key)) return cur.urls.get(key);
  let url;
  // The streaming worker handles encrypted entries too (incremental AES/ZipCrypto decrypt), so
  // they keep the live progress + rate readout. Fall back to a client-side blob only without a
  // worker. The password is handed to the worker (and confirmed) before any stream fetch.
  // 流式 worker 也处理加密条目(增量 AES/ZipCrypto 解密),因此保留实时进度与速率。仅在没有
  // worker 时才回退到客户端 blob。任何流式请求前,密码已交给 worker 并确认到位。
  // `controller` is re-checked here, not just inside ensureSw(): its result is cached for the
  // page's life, but the controller itself comes and goes as the worker updates. Handing out a
  // stream URL while nothing is controlling the page sends the request to the network, which
  // has no answer for it.
  // 这里重新检查 controller,不能只靠 ensureSw():它的结果整页缓存,但 controller 会随 worker
  // 更新而来去。页面无人控制时还发流式 URL,请求就落到网络上,而网络给不出答案。
  if (!forceBlob && await ensureSw() && navigator.serviceWorker.controller) {
    if (cur.reader.encrypted) await pushPwToSw(cur.id, savedPw(cur.id));
    url = streamUrl(entryPath);
  } else {
    openMeterReset(); // feeds the preview's progress readout while this runs / 供预览在此期间显示进度
    try {
      const { bytes } = await cur.reader.extract(k.entry || k, ARC_PV_CAP);
      url = URL.createObjectURL(new Blob([bytes], { type: MIME_BY_EXT[extOf(entryPath)] || 'application/octet-stream' }));
    } finally {
      openMeterStop();
    }
  }
  cur.urls.set(key, url);
  return url;
}

function crumbs() {
  const seed = arcSeed.get(cur.id);
  // Ancestor prefix from the seed (stashed on entry, or fetched from /meta on deep links).
  // Share members get the shared-root base. Every crumb carries a title so an ellipsized
  // name still shows in full on hover.
  // 祖先前缀来自种子(进入时暂存,深链时从 /meta 取)。共享成员以"共享"为根。
  // 每个面包屑都带 title,被省略的名字悬停仍可看全。
  const shared = seed?.access && seed.access !== 'owner';
  // On a share page the root is the sharer's selection, and the crumb chain the server sends
  // is already cut there -- nothing above the shared item can be named, let alone navigated to.
  // 在分享页上,根就是分享者选出的那批条目,服务端给的面包屑链也已在那里截断 ——
  // 共享条目之上的任何东西都无法被命名,更谈不上跳过去。
  let out = fsrc.token
    ? `<span class="drv-crumb" data-nav="${esc(fsrc.root)}">${esc(t('drv_share_root'))}</span>`
    : shared
      ? `<span class="drv-crumb" data-nav="#/drive/shared">${esc(t('drv_shared'))}</span>`
      : `<span class="drv-crumb" data-nav="#/drive">${esc(t('drv_my'))}</span>`;
  for (const p of seed?.crumbs || []) {
    out += `<span class="drv-crumb-sep">${icon('next', 14)}</span>
      <span class="drv-crumb" title="${esc(p.name)}" data-nav="${esc(folderHash(p.id))}">${esc(p.name)}</span>`;
  }
  const segs = cur.path ? cur.path.split('/') : [];
  const last = !segs.length;
  out += `<span class="drv-crumb-sep">${icon('next', 14)}</span>
    <span class="drv-crumb arc ${last ? 'here' : ''}" title="${esc(cur.name)}" ${last ? '' : `data-nav="${esc(arcHash(cur.id, ''))}"`}>${icon('fileZip', 15)}<span class="ct">${esc(cur.name)}</span></span>`;
  segs.forEach((s, i) => {
    const here = i === segs.length - 1;
    const sub = segs.slice(0, i + 1).join('/');
    out += `<span class="drv-crumb-sep">${icon('next', 14)}</span>
      <span class="drv-crumb arcin ${here ? 'here' : ''}" title="${esc(s)}" ${here ? '' : `data-nav="${esc(arcHash(cur.id, sub))}"`}>${esc(s)}</span>`;
  });
  return out;
}

function table(nodes) {
  const arrow = (k) => (cur.sort.key === k ? `<span class="arr">${cur.sort.dir > 0 ? '▲' : '▼'}</span>` : '');
  const rows = nodes.map((n, i) => `
    <tr class="drv-row" data-i="${i}">
      <td><div class="drv-name">${n.kind === 'folder' ? `<wa-icon class="fold" name="folder" style="font-size:22px"></wa-icon>` : fileIcon(n.name, 22)}<span class="nm">${esc(n.name)}</span></div></td>
      <td class="c-time drv-dim">${n.updated_at ? fmtDate(n.updated_at) : '—'}</td>
      <td class="drv-dim">${fmtSize(n.size)}</td>
      <td></td>
    </tr>`).join('');
  return `
  <table class="drv-table">
    <colgroup><col><col class="c-time"><col class="c-size"><col class="c-menu"></colgroup>
    <thead><tr>
      <th data-sort="name">${esc(t('drv_th_name'))}${arrow('name')}</th>
      <th data-sort="updated_at" class="c-time">${esc(t('drv_th_modified'))}${arrow('updated_at')}</th>
      <th data-sort="size">${esc(t('drv_th_size'))}${arrow('size')}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function grid(nodes) {
  return `<div class="drv-grid">${nodes.map((n, i) => `
    <div class="drv-card ${n.kind}" data-i="${i}">
      <div class="thumb">${n.kind === 'folder' ? icon('folder', 56) : fileIcon(n.name, 44)}</div>
      <div class="cap">${n.kind === 'folder' ? `<wa-icon class="fold" name="folder" style="font-size:22px"></wa-icon>` : fileIcon(n.name, 22)}<span class="nm" title="${esc(n.name)}">${esc(n.name)}</span></div>
    </div>`).join('')}</div>`;
}

function bind(main) {
  // Crumb nav is already bound by paintShell / 面包屑导航已由 paintShell 绑定
  qsa('th[data-sort]', main).forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (cur.sort.key === k) cur.sort.dir = -cur.sort.dir;
    else cur.sort = { key: k, dir: k === 'updated_at' ? -1 : 1 };
    paint(main);
  }));
  const open = (n) => {
    if (n.kind === 'folder') navigate(arcHash(cur.id, n.arcPath));
    else preview.open?.(cur.shown.filter((x) => x.kind === 'file'), n);
  };
  // Double-click in the Drive, where a single click means "select". A share page has no
  // selection at all -- one click opens its folders and files -- so requiring two inside an
  // archive would make the same page answer a click two different ways.
  // 网盘里用双击,因为在那儿单击意味着"选中"。分享页根本没有选择这回事 ——
  // 它的目录与文件都是一击即开 —— 压缩包里若要两下,同一个页面就会对同一个动作给出两种答复。
  const evt = fsrc.token ? 'click' : 'dblclick';
  qsa('[data-i]', main).forEach((el) => el.addEventListener(evt, () => {
    const n = cur.shown[parseInt(el.dataset.i, 10)];
    if (n) open(n);
  }));
}
