// Archive streaming service worker. Registered with scope '/' but touches ONLY
// /arc-stream/<fileId>/<archiveSize>/<archiveExt>/<entry path> -- everything else falls
// through to the network untouched. Two tiers:
//   1. stored entries (zip method 0, 7z Copy blocks): the player's own Range requests are
//      translated by plain offset arithmetic onto the drive's /dl endpoint -- true ranged
//      streaming, zero decode, zero buffering;
//   2. compressed entries: a sequential decode stream (native DecompressionStream for
//      deflate, the resumable lzma.js machines for 7z), emitted as the response body with
//      backpressure; a non-zero range start is served by decode-and-skip.
// Readers are opened lazily from the URL alone and cached in worker memory; if the browser
// kills the worker, the next request rebuilds them for the cost of one listing read.
// 压缩包流式 Service Worker。以 '/' 为 scope 注册,但只处理
// /arc-stream/<文件id>/<档案大小>/<档案扩展名>/<条目路径>,其余请求原样放行网络。两档:
//   1. 直存条目(zip method 0、7z Copy 块):播放器自己的 Range 请求做纯偏移平移转发到
//      网盘 /dl 端点 —— 真正的按段流式,零解码零缓冲;
//   2. 压缩条目:顺序解码流(deflate 走原生 DecompressionStream,7z 走 lzma.js 可续传
//      状态机),作为响应体带背压吐出;非零起点用"解到即弃"跳过。
// 读取器仅凭 URL 惰性打开并缓存在 worker 内存;浏览器杀掉 worker 后,下个请求以一次
// 目录读取的代价重建。
// Every import here MUST be static: a service worker is forbidden from calling dynamic
// import() ("disallowed on ServiceWorkerGlobalScope by the HTML specification"), and because
// the failure surfaces only when the decode actually runs, it hides as a 200 response whose
// body errors out mid-stream.
// 这里的 import 必须全部是静态的:service worker 禁止调用动态 import()(HTML 规范明令),
// 而这个失败只在真正解码时才冒出来,伪装成一个 200 响应、body 却中途出错。
import { openZip, httpSource } from './rzip.js';
import { open7z } from './r7z.js';
import { ZipCrypto } from './arcrypto.js';

const PREFIX = '/arc-stream/';
const dlUrl = (id) => `/api/drive/files/${encodeURIComponent(id)}/dl?inline=1`;
const readers = new Map(); // fileId -> Promise<reader> / 读取器缓存
const READER_CACHE = 4;

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska', mka: 'audio/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
  m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', pdf: 'application/pdf',
};
const extOf = (name) => (/\.([A-Za-z0-9]{1,12})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();

// Media formats do their own internal seeking (an MP4 with a trailing moov probes the tail
// before anything plays). For COMPRESSED entries each such probe would restart the whole
// block decode -- so media decodes exactly once into a segmented disk cache (OPFS) and every
// range request is served from the durable segments, waiting for them if need be.
// 媒体格式自己就要内部随机访问(moov 在尾部的 MP4 开播前先探尾)。压缩条目每次这种探测都会
// 让整块从头重解 —— 所以媒体只解一次,分段落进 OPFS 磁盘缓存,所有 Range 请求从已落盘的
// 分段供给,未到的就等。
const MEDIA_EXTS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'mka', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus']);
const SEG = 8 * 1024 * 1024;               // cache segment size / 缓存分段大小
const FILL_CAP = 4 * 1024 * 1024 * 1024;   // decoded entry ceiling / 解出条目上限
const BLOCK_CAP = 2 * 1024 * 1024 * 1024;  // decoded solid-block cache ceiling / 固实块缓存上限
// A parked decode holds no network connection (driveFolder drops it after IDLE_NET_MS), so it
// can stay resumable for a long while -- long enough to look at an image before opening the
// next one in the same solid block, which is the whole point of keeping it alive.
// 停泊的解码不占网络连接(driveFolder 在 IDLE_NET_MS 后放掉),所以可以长时间保持可恢复 ——
// 足够看完一张图再打开同一固实块里的下一张,这正是留着它的意义。
const IDLE_NET_MS = 3000;                  // park -> release the connection / 停泊后放掉连接
const IDLE_ABORT_MS = 90000;               // park -> give up the decoder state / 停泊后丢弃解码状态

// Passwords for encrypted archives, handed over by the page via postMessage. They live only
// in this worker's memory and are used to decrypt locally; they are never forwarded anywhere.
// 加密压缩包的密码,由页面经 postMessage 交来。只存在于本 worker 内存,用于本地解密,绝不转发。
const passwords = new Map();
self.addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.type === 'arc-pw' && m.id) {
    // Only a CHANGED password invalidates readers. The page re-pushes the same password on
    // every open, and dropping the reader each time would re-read the header from the network.
    // 只有密码变了才作废 reader。页面每次打开都会重推同一个密码,每次都丢会导致重新联网读头。
    if (passwords.get(m.id) !== m.pw) {
      passwords.set(m.id, m.pw);
      for (const k of [...readers.keys()]) if (k.startsWith(m.id + ':')) readers.delete(k);
    }
    // Acknowledge so the page can wait until the password is really in before streaming
    // 回执,让页面在流式前等到密码确实到位,消除竞态
    e.ports?.[0]?.postMessage({ ok: true });
  }
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  await self.clients.claim();
  // stale cache from a previous worker life is unusable / 上一世 worker 的缓存残段无用
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('arc-cache', { recursive: true }).catch(() => {});
  } catch {}
})()));

// Ring buffer of what this worker was actually asked for. `destination` distinguishes a media
// element's own request ("video"/"audio") from a scripted fetch (""), which is the one thing
// that cannot be told apart from the page side -- and without it, "the player is stuck" and
// "the worker never got the request" look identical.
// 记录这个 worker 究竟收到过哪些请求的环形缓冲。destination 能区分媒体元素自己发的请求
// ("video"/"audio")与脚本 fetch("") —— 这恰恰是页面侧无法分辨的一点;没有它,
// "播放器卡住了"和"worker 压根没收到请求"看起来一模一样。
const reqLog = [];
function logReq(req, url) {
  reqLog.push({
    t: Date.now(),
    path: url.pathname.slice(url.pathname.lastIndexOf('/') + 1).slice(0, 24),
    dest: req.destination || 'fetch',
    range: req.headers.get('Range') || '',
    stat: url.searchParams.get('stat') === '1',
  });
  if (reqLog.length > 40) reqLog.shift();
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(PREFIX)) return; // untouched / 放行
  logReq(e.request, url);
  e.respondWith(handle(e.request, url).catch((err) => new Response(String(err && err.message || 'e_arc_fetch'), { status: 502 })));
});

// Packed-byte chunk cache: Chrome's HTTP cache is unreliable for ranged 206 fetches out of
// a service worker, so identical region reads are deduplicated deterministically through
// Cache Storage -- one bucket per archive, two most-recent archives kept.
// 压缩字节的分块缓存:Chrome 的 HTTP 缓存对 SW 里的 206 Range fetch 靠不住,同一区段的
// 重复读取改用 Cache Storage 确定性去重 —— 每个归档一个桶,只保留最近两个归档的。
const PACKED_PREFIX = 'arc-packed:';
let cacheCleanup = Promise.resolve();

function cachingSource(url, size, bucket) {
  const base = httpSource(url, size);
  return {
    size,
    async read(off, len) {
      let c = null;
      try {
        c = await caches.open(bucket);
        const hit = await c.match(`https://arc.local/${off}-${len}`);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
      } catch {}
      const bytes = await base.read(off, len);
      if (c && bytes.length >= 4096) {
        c.put(`https://arc.local/${off}-${len}`, new Response(bytes.slice())).catch(() => {});
      }
      return bytes;
    },
  };
}

function openReader(id, size, arcExt) {
  const key = `${id}:${size}`;
  if (readers.has(key)) return readers.get(key);
  const bucket = PACKED_PREFIX + key;
  cacheCleanup = cacheCleanup.then(async () => {
    // keep this archive's bucket plus the most recent other one / 本归档加最近一个,其余清掉
    try {
      const names = (await caches.keys()).filter((n) => n.startsWith(PACKED_PREFIX) && n !== bucket);
      for (const n of names.slice(0, Math.max(0, names.length - 1))) await caches.delete(n);
    } catch {}
  });
  const p = (async () => {
    const src = cachingSource(dlUrl(id), size, bucket);
    const pw = passwords.get(id);
    return arcExt === '7z' ? open7z(src, pw) : openZip(src, pw);
  })();
  p.catch(() => readers.delete(key));
  readers.set(key, p);
  if (readers.size > READER_CACHE) readers.delete(readers.keys().next().value);
  return p;
}

// ---------- Decode throughput / 解码吞吐 ----------
// Measured on DECODED bytes, per fill -- NOT on bytes arriving from the network. Packed data
// that is already in the browser's HTTP cache "arrives" at gigabytes per second: true, and
// useless, because what the user is waiting for is the decoder, not the wire. Bytes decoded
// per second is the only rate that predicts how much longer this takes, and it is the same
// quantity the percentage is computed from, so the two can never disagree.
// 按解出的字节计,每个 fill 各自统计 —— 不是按从网络到达的字节。已在浏览器 HTTP 缓存里的
// 压缩数据会以每秒若干 GB "到达":真实,但无用 —— 用户等的是解码器,不是网线。每秒解出多少
// 字节,才是唯一能预示还要多久的速率;它与百分比同源,两者永远不会自相矛盾。
const RATE_WINDOW_MS = 4000;
const RATE_MAX_SAMPLES = 300;
function rateTick(f) {
  const now = Date.now();
  if (!f.rate) f.rate = [];
  f.rate.push({ t: now, c: f.decoded });
  while (f.rate.length > 2 && (f.rate[0].t < now - RATE_WINDOW_MS || f.rate.length > RATE_MAX_SAMPLES)) {
    f.rate.shift();
  }
}
function rateBps(f) {
  const s = f.rate;
  if (!s || s.length < 2) return 0;
  const a = s[0];
  const b = s[s.length - 1];
  // Too short a window is noise; a stale last sample means decoding has stopped, not slowed.
  // 窗口太短只是噪声;末样本过期说明解码已停下,而不是变慢了。
  if (b.t - a.t < 250 || Date.now() - b.t > 2500) return 0;
  return ((b.c - a.c) * 1000) / (b.t - a.t);
}

/** One long-lived ranged fetch surfaced as a pull-reader with per-chunk net sampling
 *  单条长连接 Range 请求,包成逐块拉取的 reader,每块采样网络吞吐 */
async function streamFetch(id, absOff, absEndEx, signal) {
  const r = await fetch(dlUrl(id), { headers: { Range: `bytes=${absOff}-${absEndEx - 1}` }, signal });
  if (!r.ok || !r.body) throw new Error('e_arc_fetch');
  const rd = r.body.getReader();
  return {
    async read() {
      const { done, value } = await rd.read();
      if (done) return null;
      return value;
    },
    cancel() {
      rd.cancel().catch(() => {});
    },
  };
}

// ---------- Single-flight decoded cache, lazy and durable / 解码的单飞磁盘缓存,惰性且持久 ----------
// Two rules make this cheap:
//   1. LAZY -- decoding stops as soon as it has passed the furthest byte anyone asked for
//      (`want`). Showing the first image of a 35MB solid block downloads the bytes for that
//      image, not the whole block; the decode parks and resumes only if something needs more.
//   2. DURABLE -- closing the archive parks the decode but KEEPS the segments on disk, and a
//      new worker life re-adopts them by scanning the directory. Re-opening the same archive
//      serves the already-decoded prefix straight off disk instead of pulling it again.
// 两条规则让它变便宜:
//   1. 惰性 —— 一旦解过所有人要的最远字节(`want`)就停。看 35MB 固实块里的第一张图,只下载那张
//      图需要的字节,而不是整块;解码就地停泊,有人要更多才继续。
//   2. 持久 —— 关掉压缩包只是停泊解码,分段仍留在磁盘上,worker 重启后扫目录即可重新认领。
//      再次打开同一个压缩包,已解出的前缀直接从磁盘供给,不再重新拉一遍。

const fills = new Map(); // key -> fill state / 填充状态
const FILL_KEEP = 64;                              // hard cap on tracked fills / 跟踪的 fill 个数硬上限
const FILL_BYTES_CAP = 3 * 1024 * 1024 * 1024;     // decoded bytes kept on disk / 磁盘上保留的解出字节

async function cacheDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('arc-cache', { create: true });
}

/** 64-bit-ish name so two different entries never share a cache directory
 *  近 64 位的目录名,不同条目绝不会共用同一个缓存目录 */
function hashStr(s) {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = ((Math.imul(b, 33) ^ c) >>> 0);
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Take stock of what is actually on disk: adopts a previous run's segments, and re-anchors a
 *  fill whose cache the browser reclaimed. Always reports the truth, never a stale figure.
 *  盘点磁盘上真正有什么:既认领上一轮写下的分段,也在浏览器回收缓存后重新对齐。
 *  始终反映实况,不留旧数。 */
async function scanFill(f) {
  let n = 0;
  let tail = 0;
  try {
    const dir = await (await cacheDir()).getDirectoryHandle(f.dirName);
    for (;;) {
      let fh;
      try {
        fh = await dir.getFileHandle('s' + n);
      } catch {
        break;
      }
      const sz = (await fh.getFile()).size;
      if (sz === SEG) {
        n++;
        continue;
      }
      tail = sz;
      break;
    }
  } catch { /* nothing cached yet / 尚无缓存 */ }
  f.written = n * SEG + tail;
  f.decoded = f.written;
  f.done = f.written >= f.total;
}

/** Evict by total BYTES, not by count: entries differ by orders of magnitude (a thumbnail-sized
 *  image against a 60MB solid block), so a plain count either throws away hundreds of cheap
 *  images or hoards a handful of huge ones. A fill that is still being read or still decoding
 *  is never a candidate -- dropping it would delete the very segments in flight and leave the
 *  progress readout reporting "idle" while work is plainly still happening.
 *  按总字节淘汰,而非按个数:条目大小相差几个数量级(缩略图大小的图 vs 60MB 固实块),
 *  单纯计数要么扔掉几百张廉价的图,要么囤着几个巨大的块。正在被读或仍在解码的 fill 永不入选 ——
 *  丢掉它会删掉正在使用的分段,还会让进度读数报 "idle",而活儿明明还在干。 */
function evictFills(keep) {
  for (;;) {
    let bytes = 0;
    for (const v of fills.values()) bytes += v.written || 0;
    if (bytes <= FILL_BYTES_CAP && fills.size <= FILL_KEEP) return;
    let oldK = null;
    let oldT = Infinity;
    for (const [k, v] of fills) {
      if (k === keep || v.readers > 0 || v.running) continue;
      if ((v.at || 0) < oldT) { oldT = v.at || 0; oldK = k; }
    }
    if (!oldK) return;
    const v = fills.get(oldK);
    fills.delete(oldK);
    v.abort?.abort();
    cacheDir().then((d) => d.removeEntry(v.dirName, { recursive: true })).catch(() => {});
  }
}

/** One decode per entry, shared by every request; segments become durable as they close.
 *  每个条目只解一次,所有请求共享;分段文件关闭即持久可读。 */
async function ensureFill(key, entry, pump) {
  let f = fills.get(key);
  if (!f) {
    f = {
      total: entry.size, want: 0, decoded: 0, written: 0, done: false, err: null,
      readers: 0, idleTimer: 0, abort: null, running: false, at: Date.now(),
      dirName: 'f' + hashStr(key),
    };
    fills.set(key, f);
    await scanFill(f); // reuse a previous life's segments / 复用上一世的分段
    evictFills(key);
  }
  f.pump = pump; // the reader instance may have been rebuilt / reader 实例可能已重建
  f.at = Date.now();
  if (f.err) { // a previous attempt failed; let this one start clean / 上次尝试失败,这次从头来过
    f.err = null;
    await scanFill(f);
  }
  return f;
}

/** Start (or restart) the decode. A restart re-decodes the cached prefix and throws it away,
 *  so it appends where the last run stopped instead of duplicating the disk cache.
 *  启动(或重启)解码。重启会把已缓存的前缀重解一遍丢掉,于是从上次停下处续写,而不是重复落盘。 */
function runFill(key, f) {
  if (f.running || f.done || f.err || !f.pump) return;
  // Everything asked for is already decoded. Starting here would re-decode the whole cached
  // prefix just to discover there is nothing to add.
  // 要的都已解好。此时启动只会把整段已缓存的前缀重解一遍,然后发现无事可做。
  if (f.decoded >= f.want) return;
  f.running = true;
  const ac = new AbortController();
  f.abort = ac;
  const signal = ac.signal;
  (async () => {
    const dir = await (await cacheDir()).getDirectoryHandle(f.dirName, { create: true });
    const skip = f.written;
    let segIdx = Math.floor(skip / SEG);
    let curLen = skip - segIdx * SEG;
    const cur = new Uint8Array(SEG);
    if (curLen) { // reload the half-written tail segment / 取回半截分段
      try {
        const b = new Uint8Array(await (await (await dir.getFileHandle('s' + segIdx)).getFile()).arrayBuffer());
        cur.set(b.subarray(0, curLen), 0);
      } catch {
        curLen = 0;
        f.written = segIdx * SEG;
      }
    }
    let dirty = false;
    const writeSeg = async (full) => {
      const fh = await dir.getFileHandle('s' + segIdx, { create: true });
      const w = await fh.createWritable();
      await w.write(full ? cur : cur.subarray(0, curLen));
      await w.close(); // close makes it visible to readers / 关闭后读者才可见
      f.written = segIdx * SEG + (full ? SEG : curLen);
      if (full) { segIdx++; curLen = 0; }
      dirty = false;
    };
    let pos = 0; // decode position from the entry's byte 0 / 从条目字节 0 起的解码位置
    await f.pump(async (chunk) => {
      if (signal.aborted) throw new Error('e_arc_park');
      let c = chunk;
      if (pos < skip) { // already on disk: decode past it without rewriting / 已落盘:解过去但不重写
        const drop = Math.min(skip - pos, c.length);
        pos += drop;
        c = c.subarray(drop);
        if (!c.length) return;
      }
      let o = 0;
      while (o < c.length) {
        const take = Math.min(SEG - curLen, c.length - o);
        cur.set(c.subarray(o, o + take), curLen);
        curLen += take;
        o += take;
        pos += take;
        f.decoded = pos; // fine-grained display progress / 细粒度的显示进度
        dirty = true;
        if (curLen === SEG) await writeSeg(true);
      }
      rateTick(f); // one sample per decoded chunk / 每解出一块采样一次
      // Park while nobody needs more, flushing first so the tail is readable. serveFill wakes
      // this the moment it raises `want`; the timer is only a safety net.
      // 无人索取就地停泊,先落盘让尾部可读。serveFill 抬高 want 时会立刻唤醒,定时器只是兜底。
      while (f.decoded >= f.want && f.decoded < f.total && !signal.aborted) {
        if (dirty) await writeSeg(false);
        await new Promise((res) => {
          let fired = false;
          const wake = () => {
            if (fired) return;
            fired = true;
            clearTimeout(tm);
            f.wake = null;
            res();
          };
          const tm = setTimeout(wake, 1000);
          f.wake = wake;
        });
      }
      if (signal.aborted) throw new Error('e_arc_park');
    }, signal);
    if (dirty) await writeSeg(false);
    f.done = f.decoded >= f.total;
    f.running = false;
  })().catch(async (e) => {
    f.running = false;
    if (signal.aborted || String(e && e.message) === 'e_arc_park') return; // parked, segments stay / 停泊,分段保留
    // Keep the fill so the reason survives: dropping it here made a failed decode look
    // identical to one that never started, which is exactly the state that is impossible to
    // diagnose from outside. ensureFill() clears the error before the next attempt.
    // 保留 fill,让失败原因留存:在这里丢掉它,会让"解码失败"和"从未开始"看起来一模一样,
    // 而那正是从外部完全无法诊断的状态。下次尝试前由 ensureFill() 清除错误。
    f.err = e;
    f.written = 0;
    f.decoded = 0;
    f.done = false;
    cacheDir().then((d) => d.removeEntry(f.dirName, { recursive: true })).catch(() => {});
  });
}

function fillRetain(f) {
  f.readers++;
  f.at = Date.now();
  if (f.idleTimer) {
    clearTimeout(f.idleTimer);
    f.idleTimer = 0;
  }
}

function fillRelease(key, f) {
  f.readers = Math.max(0, f.readers - 1);
  if (f.readers === 0 && !f.done) {
    // Nobody is watching. Pull the target back to what is already decoded so the pump parks on
    // its next chunk -- a media player asks for the whole entry up front, so without this,
    // closing the preview leaves a decode grinding through hundreds of megabytes that nobody
    // will ever read. The segments and the decoder state stay: re-opening resumes in place.
    // 没人在看了。把目标收回到已解出的位置,pump 下一块就会停泊 —— 媒体播放器一上来就索取整个
    // 条目,没有这一步,关掉预览后解码会继续嚼掉几百 MB,而这些没有任何人会去读。
    // 分段与解码器状态都保留:重新打开可以就地续上。
    f.want = f.decoded;
    f.idleTimer = setTimeout(() => {
      if (f.readers === 0 && !f.done) f.abort?.abort();
    }, IDLE_ABORT_MS);
  }
}

/** Serve [start, endEx) out of the growing segment files / 从渐增的分段文件供给 [start, endEx) */
function serveFill(key, f, start, endEx) {
  fillRetain(f);
  f.want = Math.max(f.want, endEx); // ask the decode for exactly this much / 只向解码要这么多
  // Where this reader actually wants to start. Everything decoded before it is thrown away --
  // a compressed stream cannot be entered halfway, so a seek has to chew through the gap. That
  // is a different wait from buffering and the UI says so.
  // 这个读者真正想从哪里开始。在此之前解出的数据都会被丢弃 —— 压缩流无法从中途切入,
  // 跳转就得把中间这段嚼完。这与缓冲是两种等待,界面上要分开讲。
  f.serveFrom = start;
  f.wake?.();                       // a parked decode resumes at once / 停泊的解码立刻恢复
  runFill(key, f);
  let pos = start;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      fillRelease(key, f);
    }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (f.err) throw f.err;
          if (pos >= endEx) {
            controller.close();
            release();
            return;
          }
          if (pos >= f.written) {
            if (f.done) throw new Error('e_arc_bad');
            runFill(key, f); // resume a parked decode / 唤醒停泊的解码
            await new Promise((res) => setTimeout(res, 60)); // buffering / 缓冲中
            continue;
          }
          const dir = await (await cacheDir()).getDirectoryHandle(f.dirName);
          const segIdx = Math.floor(pos / SEG);
          const segOff = pos - segIdx * SEG;
          let bytes = null;
          try {
            const file = await (await dir.getFileHandle('s' + segIdx)).getFile();
            const end = Math.min(file.size, segOff + (endEx - pos), segOff + SEG);
            if (end > segOff) bytes = new Uint8Array(await file.slice(segOff, end).arrayBuffer());
          } catch { /* segment gone / 分段已不在 */ }
          if (!bytes || !bytes.length) {
            // The browser reclaimed cached segments under storage pressure. Resync to what is
            // really on disk and decode the gap again instead of failing the request.
            // 浏览器在存储吃紧时回收了缓存分段。按磁盘实况重新对齐并重解缺口,而不是让请求失败。
            await scanFill(f);
            f.abort?.abort(); // the running writer's position is stale / 运行中写入者的位置已失效
            await new Promise((res) => setTimeout(res, 60));
            continue;
          }
          controller.enqueue(bytes);
          pos += bytes.length;
          return;
        }
      } catch (e) {
        release();
        controller.error(e);
      }
    },
    cancel() {
      release();
    },
  });
}

function parseRange(req, size) {
  const h = req.headers.get('Range');
  const m = h && /^bytes=(\d+)-(\d*)/.exec(h);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
  if (start >= size || end < start) return { bad: true };
  return { start, endEx: end + 1 };
}

function headersFor(name, size, range) {
  const h = {
    'Content-Type': MIME_BY_EXT[extOf(name)] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (range) {
    h['Content-Range'] = `bytes ${range.start}-${range.endEx - 1}/${size}`;
    h['Content-Length'] = String(range.endEx - range.start);
  } else {
    h['Content-Length'] = String(size);
  }
  return h;
}

async function handle(req, url) {
  const segs = url.pathname.slice(PREFIX.length).split('/').map(decodeURIComponent);
  const [id, sizeStr, arcExt, ...rest] = segs;
  const arcSize = parseInt(sizeStr, 10);
  const entryPath = rest.join('/');
  if (!id || !Number.isFinite(arcSize) || !entryPath) return new Response('bad url', { status: 400 });

  // Diagnostic: what has this worker been asked for? Answered before anything can block.
  // 诊断:这个 worker 都被要求过什么?在任何可能阻塞的操作之前作答。
  if (url.searchParams.get('swlog') === '1') {
    return new Response(JSON.stringify(reqLog), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const reader = await openReader(id, arcSize, arcExt);
  const entry = reader.stat(entryPath);
  if (!entry || entry.isDir) return new Response('not found', { status: 404 });

  // Fill progress probe for the preview UI -- never starts a fill by itself. A 7z entry served
  // from a solid-block cache reports that block's decode progress.
  // 给预览界面的填充进度探针 —— 本身绝不触发填充。走固实块缓存的 7z 条目报告该块的解码进度。
  if (url.searchParams.get('stat') === '1') {
    const blk = arcExt === '7z' && reader.blockOf ? reader.blockOf(entry) : null;
    const f = fills.get(blk ? `${id}:blk:${blk.index}` : `${id}:${arcSize}:${entryPath}`);
    const total = blk ? blk.blockSize : entry.size;
    // Progress is measured against what is actually being fetched (`want`), not the whole
    // block -- a lazy decode that stops early is finished, not stuck at 6%.
    // 进度按真正在取的量(`want`)计,而不是整块 —— 惰性解码提前停下是完成了,不是卡在 6%。
    // Still short of where the reader wants to begin? Then this is the skip-ahead phase, and
    // the meaningful progress is "how far through the gap", not "how much of the file".
    // 还没到读者想开始的位置?那就处于跳过阶段,有意义的进度是"跳完了多少",而不是"解了文件的多少"。
    const skipping = !!f && f.decoded < (f.serveFrom || 0);
    const goal = f
      ? (skipping ? f.serveFrom : Math.min(f.want || total, f.total || total))
      : total;
    return new Response(JSON.stringify(f
      ? { written: f.decoded, total: goal, done: !skipping && (f.done || f.decoded >= goal),
          skipping, bps: rateBps(f), err: f.err ? String(f.err.message || f.err) : undefined }
      : { written: 0, total, done: false, idle: true, bps: 0 }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const range = parseRange(req, entry.size);
  if (range?.bad) return new Response('range', { status: 416 });

  // 7z solid blocks: many files share one compressed block, and reaching any of them decodes
  // the block from its start. Cache the DECODED BLOCK once (to disk) and serve every file in it
  // from that cache -- so browsing a folder of images in a solid archive decodes the block a
  // single time instead of once per image. Plain Copy blocks skip this (tier-1 serves them
  // directly); blocks too large to cache fall back to per-entry decode below.
  // 7z 固实块:多个文件共用一个压缩块,读取其中任意一个都要从块首解起。把解好的整块缓存一次
  // (落盘),块内所有文件都从缓存供给 —— 于是浏览固实档案里一整个文件夹的图,块只解一次,
  // 而不是每张图都解一遍。直存(Copy)块跳过(第一档直接供给);块太大无法缓存的退回下方逐条解码。
  if (arcExt === '7z' && navigator.storage?.getDirectory && reader.blockOf) {
    const blk = reader.blockOf(entry);
    if (blk && !reader.copySpan(entry) && blk.blockSize <= BLOCK_CAP) {
      const key = `${id}:blk:${blk.index}`;
      const pump = (onBytes, signal) => reader.streamBlock(blk.index, onBytes, signal,
        { openStream: (a, b) => streamFetch(id, a, b, signal), idleCancelMs: IDLE_NET_MS });
      const f = await ensureFill(key, { size: blk.blockSize, name: 'block' }, pump);
      const from = blk.off + (range ? range.start : 0);
      const to = blk.off + (range ? range.endEx : entry.size);
      return new Response(serveFill(key, f, from, to), {
        status: range ? 206 : 200,
        headers: headersFor(entry.name, entry.size, range),
      });
    }
  }

  // Encrypted ZIP entries chain from byte 0 (ZipCrypto), so they cannot be range-served
  // directly -- but they CAN be decrypted incrementally as bytes arrive, into the single-flight
  // disk cache. That keeps the live progress % and throughput readout working for them too.
  // (7z encryption is already handled by the block cache above.)
  // 加密 ZIP 条目从第 0 字节链式(ZipCrypto),无法直接按段供给 —— 但可以边到边增量解密,
  // 灌进单飞磁盘缓存。这样实时百分比和速率显示对它也照常有效。(7z 加密已由上面的块缓存处理。)
  const isEnc = arcExt === '7z' ? false : !!entry.encrypted;
  if (isEnc && navigator.storage?.getDirectory) {
    if (entry.size > FILL_CAP) return new Response('too big', { status: 502 });
    const key = `${id}:${arcSize}:${entryPath}`;
    const pump = arcExt === '7z'
      ? (onBytes, signal) => reader.streamSlice(entry, 0, entry.size, onBytes, signal,
        { openStream: (a, b) => streamFetch(id, a, b, signal), idleCancelMs: IDLE_NET_MS })
      : async (onBytes, signal) => {
        // ZipCrypto: stream the compressed span, byte-stream decrypt (drop the 12-byte header),
        // then native inflate -- all incremental, so progress and rate stay live.
        // ZipCrypto:流式拉压缩区间,字节流解密(丢掉 12 字节头),再原生解压 —— 全增量,进度速率不断。
        const sp = await reader.span(entry, passwords.get(id));
        const st2 = await streamFetch(id, sp.off, sp.off + sp.len, signal);
        const zc = new ZipCrypto(passwords.get(id));
        let dropped = 0;
        const decStream = new ReadableStream({
          async pull(c) {
            const v = await st2.read();
            if (!v) { c.close(); return; }
            const dv = zc.decrypt(v.slice());
            if (dropped < 12) { // skip the encryption header / 跳过加密头
              const skip = Math.min(12 - dropped, dv.length);
              dropped += skip;
              if (skip < dv.length) c.enqueue(dv.subarray(skip));
            } else c.enqueue(dv);
          },
          cancel() { st2.cancel(); },
        });
        if (sp.method === 0) {
          const rd = decStream.getReader();
          for (;;) { const { done, value } = await rd.read(); if (done) return; await onBytes(value); }
        }
        const rd = decStream.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) return; await onBytes(value); }
      };
    const f = await ensureFill(key, entry, pump);
    return new Response(serveFill(key, f, range ? range.start : 0, range ? range.endEx : entry.size), {
      status: range ? 206 : 200,
      headers: headersFor(entry.name, entry.size, range),
    });
  }

  // Tier 1: contiguous stored bytes -- pure offset translation onto /dl
  // 第一档:连续直存字节 —— 纯偏移平移转发 /dl
  const span = arcExt === '7z'
    ? reader.copySpan(entry)
    : await (async () => {
      const s = await reader.span(entry).catch(() => null);
      return s && s.method === 0 ? s : null;
    })();
  if (span) {
    const from = span.off + (range ? range.start : 0);
    const to = span.off + (range ? range.endEx : entry.size) - 1;
    const up = await fetch(dlUrl(id), { headers: { Range: `bytes=${from}-${to}` } });
    if (!up.ok) return new Response('upstream', { status: 502 });
    return new Response(up.body, { status: range ? 206 : 200, headers: headersFor(entry.name, entry.size, range) });
  }

  // Tier 2: sequential decode stream / 第二档:顺序解码流
  const start = range ? range.start : 0;
  const endEx = range ? range.endEx : entry.size;

  // Compressed media goes through the single-flight disk cache: containers seek internally
  // (MP4 tail moov etc.), and re-decoding the block per range request would loop forever.
  // 压缩媒体走单飞磁盘缓存:容器格式内部要随机访问(MP4 尾部 moov 等),按请求重解会没完没了。
  if (MEDIA_EXTS.has(extOf(entry.name)) && navigator.storage?.getDirectory) {
    if (entry.size > FILL_CAP) return new Response('too big', { status: 502 });
    const key = `${id}:${arcSize}:${entryPath}`;
    const pump = arcExt === '7z'
      ? (onBytes, signal) => reader.streamSlice(entry, 0, entry.size, onBytes, signal,
        { openStream: (a, b) => streamFetch(id, a, b, signal), idleCancelMs: IDLE_NET_MS })
      : async (onBytes, signal) => {
        const sp = await reader.span(entry);
        const st2 = await streamFetch(id, sp.off, sp.off + sp.len, signal);
        // re-wrap as a stream for the native inflater, keeping per-chunk net sampling
        // 重新包成流喂原生解压器,保持逐块网络采样
        const counted = new ReadableStream({
          async pull(c) {
            const v = await st2.read();
            if (!v) c.close();
            else c.enqueue(v);
          },
          cancel() {
            st2.cancel();
          },
        });
        const rd = counted.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) return;
          await onBytes(value);
        }
      };
    const f = await ensureFill(key, entry, pump);
    return new Response(serveFill(key, f, start, endEx), {
      status: range ? 206 : 200,
      headers: headersFor(entry.name, entry.size, range),
    });
  }

  let cancelled = false;
  const abort = new AbortController();

  let body;
  if (arcExt === '7z') {
    body = new ReadableStream({
      start(controller) {
        (async () => {
          let gate = Promise.resolve();
          await reader.streamSlice(entry, start, endEx, async (chunk) => {
            if (cancelled) throw new Error('cancelled');
            controller.enqueue(chunk.slice());
            // backpressure: wait while the consumer is behind / 背压:消费方落后就等
            while (controller.desiredSize !== null && controller.desiredSize <= 0 && !cancelled) {
              await new Promise((res) => setTimeout(res, 15));
            }
          }, abort.signal);
          controller.close();
        })().catch((e) => {
          if (!cancelled) controller.error(e);
        });
      },
      cancel() {
        cancelled = true;
        abort.abort();
      },
    }, { highWaterMark: 8 * 1024 * 1024, size: (c) => c.byteLength });
  } else {
    // zip deflate: ranged fetch of the compressed span, native streaming inflate, skip+clip.
    // A manual pump so the response closes cleanly BEFORE the upstream fetch is aborted.
    // zip 的 deflate:按段拉压缩区间,原生流式解压,跳过前缀、裁剪到目标。
    // 手动泵:先干净地收尾响应,再中止上游拉取,避免中止错误窜进响应体。
    const span2 = await reader.span(entry); // throws for encrypted/unsupported / 加密与不支持在此抛出
    const up = await fetch(dlUrl(id), { headers: { Range: `bytes=${span2.off}-${span2.off + span2.len - 1}` }, signal: abort.signal });
    if (!up.ok || !up.body) return new Response('upstream', { status: 502 });
    const infReader = up.body.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    let seen = 0;
    body = new ReadableStream({
      async pull(controller) {
        for (;;) {
          let step;
          try {
            step = await infReader.read();
          } catch {
            step = { done: true };
          }
          if (step.done) {
            controller.close();
            return;
          }
          const prev = seen;
          seen += step.value.length;
          const a = Math.max(start, prev);
          const b = Math.min(endEx, seen);
          if (b > a) controller.enqueue(step.value.subarray(a - prev, b - prev));
          if (seen >= endEx) {
            controller.close();
            abort.abort();
            infReader.cancel().catch(() => {});
            return;
          }
          if (b > a) return; // emitted; wait for the next pull / 已产出,等下一次 pull
        }
      },
      cancel() {
        cancelled = true;
        abort.abort();
        infReader.cancel().catch(() => {});
      },
    });
  }
  return new Response(body, { status: range ? 206 : 200, headers: headersFor(entry.name, entry.size, range) });
}
