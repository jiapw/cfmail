// Keeping a meeting: the host's browser records it, and the file goes into the host's own Drive.
//
// What is recorded is what the room is looking at -- everybody, as equal tiles, or a shared
// screen while there is one -- and everything anybody says. What is on screen changes during a
// meeting, and a recorder cannot be given a different track halfway through a file, so the
// picture is drawn onto a canvas of a fixed size and the canvas is what gets recorded: one track
// from the first frame to the last, whoever is on it.
// The sound is every microphone in the room, the host's included, summed in a WebAudio graph
// that goes nowhere near a loudspeaker.
//
// The file is sent up WHILE it is being made, in parts of one fixed size, through the same
// multipart door every large Drive upload uses. A two-hour recording that only starts its upload
// when the meeting ends is a recording lost to the first person who closes their laptop on the
// way out; this way the most that can be lost is the part still being filled, and what was sent
// can be put together the next time the meetings page is opened (see recoverPending).
//
// Optionally the same sound is also cut into pieces of five minutes, each a complete little
// file, and each is sent to be put into words. The words are kept here, in this tab, until the
// recording stops; then they are summed up once and filed next to the recording as Markdown.
// A piece in which nobody made a sound is never sent: a speech model asked to transcribe
// silence invents a sentence.
//
// 留下一场会议:由主持人的浏览器来录,文件进主持人自己的网盘。
//
// 录下来的是整个房间正在看的东西 —— 等大排列的所有人,或者有人共享时的那块屏幕 —— 以及所有人说的话。
// 屏幕上的内容在会议中会变,而录制器不可能在一个文件的半途换一条轨道,所以画面先画到一块固定尺寸的
// canvas 上,真正被录的是这块 canvas:从第一帧到最后一帧都是同一条轨,不管上面是谁。
// 声音是房间里的每一支麦克风(含主持人自己的),在一张 WebAudio 图里相加,这张图不通向任何扬声器。
//
// 文件是**边录边传**的,按固定大小分片,走网盘所有大文件上传都走的那扇分片之门。
// 一份两小时的录像如果等会议结束才开始上传,那么第一个合上笔记本走人的主持人就会把它弄丢;
// 这样做,最多丢掉正在填的那一片,而已经送上去的部分,下次打开会议页时还能拼起来(见 recoverPending)。
//
// 可选地,同一份声音还会被切成五分钟一段、每段都是一个完整的小文件,逐段送去转成文字。
// 文字留在这里、留在这个标签页里,直到录制停止;然后一次性写成摘要,以 Markdown 存在录像旁边。
// 没人出声的那一段从不送出:让语音模型去转写沉默,它会编出一句话来。
import { api, ApiError } from '../api.js';
import { t } from '../i18n.js';

/** Every part but the last must be the same size (R2's rule), and at least 5 MiB.
 *  除最后一片外,每一片必须一样大(R2 的规矩),且不小于 5 MiB。 */
const PART = 8 * 1024 * 1024;
/** What the upload is declared as before anybody knows how long the meeting will run. Only the
 *  first quota check reads it; the real size is checked when the parts are put together.
 *  在没人知道会开多久之前,这次上传先申报成多大。只有第一道配额检查会读它;
 *  真实大小在拼装分片时再核对。 */
const DECLARED = 32 * 1024 * 1024;
const FPS = 24;
const PIECE_MS = 5 * 60 * 1000;
const SIZES = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080] };
const VIDEO_BPS = { 480: 1_000_000, 720: 2_000_000, 1080: 3_500_000 };
const PENDING_KEY = 'cf_meet_rec_pending';
const PALETTE = ['#4f7cff', '#e0625a', '#2fa37a', '#c48a1b', '#9b6be0', '#2b9fc4', '#d45c9c', '#6b8e23'];

// MP4 first: it is the file everything plays. The profile in the string has to admit 1080p or
// the recorder refuses the size rather than the string.
// 先 MP4:它是什么都能播的那种文件。字符串里的 profile 必须容得下 1080p,
// 否则录制器拒绝的会是尺寸,而不是这个字符串。
const VIDEO_TYPES = [
  'video/mp4;codecs="avc1.640028,mp4a.40.2"', 'video/mp4;codecs="avc1.4d0028,mp4a.40.2"', 'video/mp4',
  'video/webm;codecs="vp9,opus"', 'video/webm;codecs="vp8,opus"', 'video/webm',
];
const AUDIO_TYPES = ['audio/mp4;codecs="mp4a.40.2"', 'audio/webm;codecs="opus"', 'audio/webm', 'audio/mp4'];
// The pieces are for a model, not for a person: Opus in WebM is a fifth the size of anything else.
// 分段是给模型的,不是给人的:WebM 里的 Opus 只有其他任何格式的五分之一大。
const PIECE_TYPES = ['audio/webm;codecs="opus"', 'audio/webm', 'audio/mp4;codecs="mp4a.40.2"', 'audio/mp4'];

const pick = (list) => list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
const extOf = (mime) => (mime.startsWith('video/mp4') ? 'mp4' : mime.startsWith('video/') ? 'webm' : mime.startsWith('audio/mp4') ? 'm4a' : 'webm');
const bare = (mime) => mime.split(';')[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lsGet = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } };
const lsSet = (v) => { try { if (v) localStorage.setItem(PENDING_KEY, JSON.stringify(v)); else localStorage.removeItem(PENDING_KEY); } catch { /* private mode / 隐私模式 */ } };

export function recordingSupported() {
  return typeof MediaRecorder !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext) && !!pick(AUDIO_TYPES);
}

const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/** A name a file can have anywhere it may end up, a Windows download folder included.
 *  一个放到哪儿都能当文件名的名字,包括 Windows 的下载文件夹。 */
const fileBase = (title, at) => `${String(title || t('mt_untitled')).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)} ${stamp(at)}`;

/** A timer that keeps its pace in a tab nobody is looking at. A page's own timers are slowed to
 *  once a second the moment it is hidden, and a host who switches to their slides would record
 *  one frame a second; a worker's are not.
 *  一个在没人看的标签页里也不掉拍子的定时器。页面自己的定时器一旦被隐藏就降到每秒一次,
 *  主持人切去看自己的幻灯片,录下来的就成了每秒一帧;worker 的定时器不受此限。 */
function ticker(ms, fn) {
  let worker = null;
  let timer = 0;
  let url = '';
  try {
    url = URL.createObjectURL(new Blob([`setInterval(()=>postMessage(0),${Math.round(ms)})`], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = fn;
  } catch {
    timer = setInterval(fn, ms);
  }
  return () => {
    try { worker?.terminate(); } catch { /* gone / 已无 */ }
    if (url) URL.revokeObjectURL(url);
    clearInterval(timer);
  };
}

// ---------- Where the file goes ----------
// ---------- 文件的去处 ----------

async function ensureFolder() {
  return api('POST', '/api/drive/folders', { name: t('mt_rec_folder'), parent: 'root' });
}

/** Into the Drive, a part at a time. / 进网盘,一次一片。 */
export class DriveSink {
  constructor(name, mime, meetingId, startedAt) {
    this.name = name; this.mime = mime; this.meetingId = meetingId; this.startedAt = startedAt;
    this.buf = []; this.buffered = 0; this.sent = 0; this.parts = []; this.n = 0;
    this.busy = null; this.closing = false; this.error = null; this.free = Infinity;
  }

  async open() {
    this.folder = await ensureFolder();
    const st = await api('GET', '/api/drive/state').catch(() => null);
    if (st) this.free = Math.max(0, st.quota - st.used);
    const up = await api('POST', '/api/drive/upload/init', { parent: this.folder.id, name: this.name, mime: bare(this.mime), size: Math.min(DECLARED, Math.max(1, this.free)) });
    this.id = up.id;
    this.remember();
  }

  /** What would be needed to finish this upload from another page load. / 换一次页面加载之后,要把这次上传收尾所需的全部。 */
  remember() {
    lsSet({ id: this.id, parts: this.parts, name: this.name, meeting: this.meetingId, folder: this.folder?.id, started: this.startedAt, beat: Date.now() });
  }

  get total() { return this.sent + this.buffered; }
  /** Whether what is already made still fits. / 已经录出来的这些,还装不装得下。 */
  get full() { return this.total + PART > this.free; }

  push(blob) {
    if (this.error) return;
    this.buf.push(blob);
    this.buffered += blob.size;
    this.pump();
  }

  /** One part at a time, in order. The run clears `busy` from OUTSIDE itself: a run with nothing
   *  to do finishes before the assignment below has happened, and one that cleared the flag
   *  itself would then leave its own finished promise in it for good.
   *  一次一片,按顺序。`busy` 由这一轮的**外面**来清:没活可干的一轮,会在下面那句赋值发生之前就结束,
   *  如果由它自己清标记,它那个已经完成的 promise 就会永远留在标记里。 */
  pump() {
    if (this.busy) return this.busy;
    const run = (async () => {
      try {
        while (!this.error && (this.buffered >= PART || (this.closing && this.buffered > 0))) {
          const all = new Blob(this.buf);
          const part = all.slice(0, PART);
          const rest = all.slice(PART);
          this.buf = rest.size ? [rest] : [];
          this.buffered = rest.size;
          const n = ++this.n;
          const done = await this.put(n, part);
          this.parts.push(done);
          this.sent += part.size;
          this.remember();
        }
      } catch (e) {
        this.error = e;
      }
    })();
    this.busy = run;
    run.then(() => { if (this.busy === run) this.busy = null; });
    return run;
  }

  async put(n, part) {
    let last = null;
    for (let i = 0; i < 6; i++) {
      let res = null;
      try { res = await fetch(`/api/drive/upload/${this.id}/part?n=${n}`, { method: 'PUT', body: part }); } catch (e) { last = e; }
      if (res) {
        const j = await res.json().catch(() => null);
        if (res.ok && j?.etag) return { n: j.n, etag: j.etag };
        last = new ApiError(res.status, j?.error || 'e_request_failed', j?.args || [res.status]);
        // Refused is refused; only a server having a bad moment is worth asking again.
        // 被拒绝就是被拒绝;只有"服务端一时不顺"才值得再问一次。
        if (res.status < 500 && res.status !== 429 && res.status !== 408) throw last;
      }
      await sleep(Math.min(15000, 1000 * 2 ** i));
    }
    throw last || new ApiError(0, 'e_request_failed', [0]);
  }

  async close() {
    this.closing = true;
    // A run that was already going may have looked at `closing` while it was still false.
    // 正在跑的那一轮,上次看 `closing` 的时候它可能还是 false。
    do { await this.pump(); } while (this.buffered > 0 && !this.error);
    if (this.error || !this.parts.length) {
      await api('POST', `/api/drive/upload/${this.id}/abort`).catch(() => {});
      lsSet(null);
      if (this.error) throw this.error;
      return null;
    }
    const node = await api('POST', `/api/drive/upload/${this.id}/complete`, { parts: this.parts });
    lsSet(null);
    return node;
  }

  beat() { if (this.id && !this.closing) this.remember(); }
}

/** No Drive: the file is kept by the browser and handed over as a download at the end.
 *  没有网盘:文件先由浏览器留着,结束时以下载的方式交出来。 */
class DownloadSink {
  constructor(name, mime) { this.name = name; this.mime = mime; this.buf = []; this.total = 0; this.full = false; }
  async open() { /* nothing to arrange / 无需准备 */ }
  push(blob) { this.buf.push(blob); this.total += blob.size; }
  beat() { /* nothing to remember / 无可记 */ }
  async close() {
    if (!this.total) return null;
    saveLocally(new Blob(this.buf, { type: bare(this.mime) }), this.name);
    return { local: true, name: this.name };
  }
}

function saveLocally(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- The recorder ----------
// ---------- 录制器 ----------

export class MeetRecorder {
  /**
   * @param o.meeting   { id, title }
   * @param o.video     whether the meeting has pictures at all / 这场会议到底有没有画面
   * @param o.resolution 480 | 720 | 1080
   * @param o.keep      save the recording itself / 保存录像本身
   * @param o.minutes   put what is said into words / 把说的话转成文字
   * @param o.drive     whether this person has a Drive to save into / 此人有没有网盘可存
   * @param o.scene     () => { stage: { video, name } | null, tiles: [{ video, name, color }] }
   *                    stage: a shared screen, drawn over the whole canvas / 共享的屏幕,铺满整块画布
   * @param o.onState   (state, info) => void; state: 'recording' | 'saving' | 'minutes' | 'done' | 'failed'
   */
  constructor(o) {
    this.o = o;
    this.state = 'idle';
    this.lines = [];
    this.pending = [];
    this.lost = 0;
    this.sources = new Map();
    this.finished = null;
  }

  get active() { return this.state === 'recording'; }
  get busy() { return this.state === 'recording' || this.state === 'saving' || this.state === 'minutes'; }

  set(state, info) {
    this.state = state;
    try { this.o.onState?.(state, info); } catch { /* the page's problem / 页面自己的问题 */ }
  }

  async start() {
    if (this.state !== 'idle') return;
    const o = this.o;
    this.startedAt = Date.now();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC();
    await ctx.resume().catch(() => {});
    this.dest = ctx.createMediaStreamDestination();
    this.bus = ctx.createGain();
    this.bus.connect(this.dest);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.bus.connect(this.analyser);
    this.levelBuf = new Float32Array(this.analyser.fftSize);
    // A source that is always there: a graph with no input makes no samples, and a file whose
    // sound starts late has its picture start late with it.
    // 一个永远在的源:没有输入的图不产出采样,而声音晚开始的文件,画面也会跟着晚开始。
    try { this.keepAlive = ctx.createConstantSource(); this.keepAlive.offset.value = 0; this.keepAlive.connect(this.bus); this.keepAlive.start(); } catch { /* old Safari / 旧版 Safari */ }

    try {
      if (o.keep) {
        const mime = this.mime = pick(o.video ? VIDEO_TYPES : AUDIO_TYPES);
        if (!mime) throw new Error(t('mt_rec_unsupported'));
        const name = `${fileBase(o.meeting.title, this.startedAt)}.${extOf(mime)}`;
        this.sink = o.drive ? new DriveSink(name, mime, o.meeting.id, this.startedAt) : new DownloadSink(name, mime);
        await this.sink.open();
        const tracks = [this.dest.stream.getAudioTracks()[0]];
        if (o.video) {
          const [w, h] = SIZES[o.resolution] || SIZES[720];
          const cv = this.canvas = document.createElement('canvas');
          cv.width = this.w = w;
          cv.height = this.h = h;
          this.g = cv.getContext('2d', { alpha: false, desynchronized: true });
          this.draw();
          tracks.unshift(cv.captureStream(FPS).getVideoTracks()[0]);
        }
        const rec = this.main = new MediaRecorder(new MediaStream(tracks), {
          mimeType: mime, audioBitsPerSecond: 96000, ...(o.video ? { videoBitsPerSecond: VIDEO_BPS[o.resolution] || VIDEO_BPS[720] } : {}),
        });
        rec.ondataavailable = (e) => { if (e.data?.size) this.sink.push(e.data); };
        rec.onerror = () => this.stop('error');
        rec.start(2000);
      }
      if (o.minutes) {
        this.pieceMime = pick(PIECE_TYPES);
        if (this.pieceMime) this.startPiece();
      }
    } catch (e) {
      this.cleanup();
      this.state = 'idle';
      throw e;
    }
    let n = 0;
    const every = o.keep && o.video ? 1000 / FPS : 250;
    const levelEvery = Math.max(1, Math.round(250 / every));
    this.stopTicker = ticker(every, () => {
      if (this.state !== 'recording') return;
      n += 1;
      if (this.g) this.draw();
      if (n % levelEvery === 0) this.sampleLevel();
      if (n % (levelEvery * 40) === 0) {
        this.sink?.beat();
        // Out of room: stop while what has been made can still be saved.
        // 空间不够了:趁已经录下的还存得进去,停下。
        if (this.sink?.full) this.stop('quota');
        else if (this.sink?.error) this.stop('error');
      }
      if (this.piece && Date.now() - this.piece.startedMs >= PIECE_MS) this.rotatePiece();
    });
    this.set('recording');
  }

  /** The microphones that should be in the mix right now. / 此刻应该在混音里的那些麦克风。 */
  syncAudio(tracks) {
    if (!this.ctx || this.state !== 'recording') return;
    const want = new Set(tracks.filter(Boolean));
    for (const [track, node] of this.sources) {
      if (want.has(track) && track.readyState === 'live') continue;
      try { node.disconnect(); } catch { /* gone / 已无 */ }
      this.sources.delete(track);
    }
    for (const track of want) {
      if (this.sources.has(track) || track.readyState !== 'live') continue;
      try {
        const node = this.ctx.createMediaStreamSource(new MediaStream([track]));
        node.connect(this.bus);
        this.sources.set(track, node);
      } catch { /* a track that cannot be mixed is left out / 混不进来的轨道就不混 */ }
    }
  }

  sampleLevel() {
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
    if (Math.sqrt(sum / this.levelBuf.length) > 0.012 && this.piece) this.piece.voiced += 1;
  }

  // ----- the picture / 画面 -----

  fit(video, x, y, cw, ch, cover) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;
    if (cover) {
      const s = Math.max(cw / vw, ch / vh);
      const sw = cw / s;
      const sh = ch / s;
      this.g.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, cw, ch);
    } else {
      const s = Math.min(cw / vw, ch / vh);
      this.g.drawImage(video, x + (cw - vw * s) / 2, y + (ch - vh * s) / 2, vw * s, vh * s);
    }
    return true;
  }

  label(text, x, y, size) {
    if (!text) return;
    const g = this.g;
    g.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const pad = size * 0.5;
    const tw = Math.min(g.measureText(text).width, this.w * 0.5);
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y - size - pad, tw + pad * 2, size + pad, size * 0.35); else g.rect(x, y - size - pad, tw + pad * 2, size + pad);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(text, x + pad, y - (size + pad) / 2, this.w * 0.5);
  }

  draw() {
    const { g, w, h } = this;
    g.fillStyle = '#0f1115';
    g.fillRect(0, 0, w, h);
    let sc = null;
    try { sc = this.o.scene?.(); } catch { /* the room is gone / 房间已不在 */ }
    const st = sc?.stage;
    const ready = (v) => v && v.readyState >= 2 && v.videoWidth > 0;
    if (ready(st?.video)) {
      this.fit(st.video, 0, 0, w, h, false);
      this.label(st.name, w * 0.02, h - w * 0.02, Math.round(h / 32));
      return;
    }
    const tiles = (sc?.tiles || []).slice(0, 16);
    if (!tiles.length) return this.card();
    const cols = Math.ceil(Math.sqrt(tiles.length));
    const rows = Math.ceil(tiles.length / cols);
    const gap = Math.round(h / 90);
    const cw = Math.min((w - gap * (cols + 1)) / cols, ((h - gap * (rows + 1)) / rows) * (16 / 9));
    const ch = cw * (9 / 16);
    const x0 = (w - (cols * cw + (cols - 1) * gap)) / 2;
    const y0 = (h - (rows * ch + (rows - 1) * gap)) / 2;
    tiles.forEach((tile, i) => {
      // The last row is centred, like the room's own grid. / 最后一行居中,和房间自己的宫格一样。
      const row = Math.floor(i / cols);
      const inRow = row === rows - 1 ? tiles.length - row * cols : cols;
      const rx = x0 + ((cols - inRow) * (cw + gap)) / 2;
      const x = rx + (i % cols) * (cw + gap);
      const y = y0 + row * (ch + gap);
      g.save();
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, cw, ch, ch * 0.04); else g.rect(x, y, cw, ch);
      g.clip();
      g.fillStyle = '#1b1f27';
      g.fillRect(x, y, cw, ch);
      if (!ready(tile.video) || !this.fit(tile.video, x, y, cw, ch, true)) {
        const r = ch * 0.22;
        g.fillStyle = PALETTE[(tile.color || 0) % PALETTE.length];
        g.beginPath();
        g.arc(x + cw / 2, y + ch / 2, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fff';
        g.font = `600 ${Math.round(r)}px system-ui, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText([...String(tile.name || '?').trim()][0]?.toUpperCase() || '?', x + cw / 2, y + ch / 2 + r * 0.05);
      }
      g.restore();
      this.label(tile.name, x + ch * 0.04, y + ch - ch * 0.04, Math.max(12, Math.round(ch / 12)));
    });
  }

  card() {
    const { g, w, h } = this;
    g.fillStyle = '#e8eaee';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `600 ${Math.round(h / 16)}px system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`;
    g.fillText(String(this.o.meeting.title || t('mt_untitled')).slice(0, 60), w / 2, h / 2, w * 0.86);
  }

  // ----- the words / 文字 -----

  startPiece() {
    const rec = new MediaRecorder(new MediaStream([this.dest.stream.getAudioTracks()[0]]), { mimeType: this.pieceMime, audioBitsPerSecond: 32000 });
    const piece = { rec, chunks: [], at: (Date.now() - this.startedAt) / 1000, startedMs: Date.now(), voiced: 0 };
    rec.ondataavailable = (e) => { if (e.data?.size) piece.chunks.push(e.data); };
    rec.onstop = () => this.sendPiece(piece);
    rec.start();
    this.piece = piece;
  }

  /** The next piece starts before this one stops, so that no word falls between two files.
   *  下一段先开始,这一段才停,免得有哪个字掉进两个文件之间的缝里。 */
  rotatePiece() {
    const old = this.piece;
    this.startPiece();
    try { old.rec.stop(); } catch { /* already stopped / 已经停了 */ }
  }

  sendPiece(piece) {
    const blob = new Blob(piece.chunks, { type: bare(this.pieceMime) });
    // About a second of anything louder than a room's own hum. / 约一秒钟比房间底噪更响的任何声音。
    if (piece.voiced < 4 || blob.size < 1500) return;
    this.pending.push((async () => {
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch(`/api/meet/${this.o.meeting.id}/transcribe`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
          if (res.ok) {
            const j = await res.json();
            const segs = Array.isArray(j.segments) && j.segments.length ? j.segments : j.text ? [{ start: 0, text: j.text }] : [];
            for (const s of segs) if (String(s.text || '').trim()) this.lines.push({ at: piece.at + (Number(s.start) || 0), text: String(s.text).trim() });
            return;
          }
          if (res.status !== 429 && res.status < 500) break;
        } catch { /* the network; ask again / 网络问题;再问一次 */ }
        await sleep(2500 * (i + 1));
      }
      this.lost += 1;
    })());
  }

  // ----- the end / 收尾 -----

  cleanup() {
    try { this.stopTicker?.(); } catch { /* gone / 已无 */ }
    for (const node of this.sources.values()) { try { node.disconnect(); } catch { /* gone / 已无 */ } }
    this.sources.clear();
    try { this.keepAlive?.stop(); } catch { /* gone / 已无 */ }
    try { this.ctx?.close(); } catch { /* gone / 已无 */ }
    this.ctx = null;
    this.canvas = null;
    this.g = null;
  }

  /** Stop, and see everything through: the last part, the last piece, the summary, the files.
   *  The room may be gone by the time this finishes; nothing in here needs it.
   *  停下,并把一切做完:最后一片、最后一段、摘要、文件。
   *  这件事做完的时候房间可能已经不在了;这里没有任何一步需要它。 */
  stop(reason = '') {
    if (this.finished) return this.finished;
    if (this.state !== 'recording') return Promise.resolve(null);
    this.set('saving', { reason });
    this.finished = this.finish(reason).then(
      (result) => { this.set('done', result); return result; },
      (error) => { this.set('failed', { error, reason }); return null; },
    );
    return this.finished;
  }

  async finish(reason) {
    const o = this.o;
    const endedAt = Date.now();
    try { this.stopTicker?.(); } catch { /* gone / 已无 */ }
    const stopped = (rec) => new Promise((res) => {
      if (!rec || rec.state === 'inactive') return res();
      rec.addEventListener('stop', () => res(), { once: true });
      try { rec.stop(); } catch { res(); }
    });
    await Promise.all([stopped(this.main), stopped(this.piece?.rec)]);
    this.piece = null;
    this.cleanup();

    const result = { reason, options: { keep: !!o.keep, minutes: !!o.minutes }, node: null, folder: this.sink?.folder || null, minutesNode: null, summary: '', markdown: '', lost: 0, local: false, said: false };
    let failure = null;
    if (this.sink) {
      try {
        const node = await this.sink.close();
        if (node?.local) result.local = true; else result.node = node;
      } catch (e) { failure = e; }
    }

    if (o.minutes) {
      this.set('minutes', { reason });
      await Promise.all(this.pending);
      result.lost = this.lost;
      this.lines.sort((a, b) => a.at - b.at);
      const transcript = this.lines.map((l) => `[${clock(l.at)}] ${l.text}`).join('\n');
      if (transcript.trim().length >= 40) {
        result.said = true;
        try { result.summary = (await api('POST', `/api/meet/${o.meeting.id}/minutes`, { transcript })).summary || ''; } catch { /* the words alone are still worth keeping / 光有文字稿也值得留下 */ }
        const title = o.meeting.title || t('mt_untitled');
        result.markdown = [
          `# ${title} · ${t('mt_minutes')}`, '',
          `${new Date(this.startedAt).toLocaleString()} – ${new Date(endedAt).toLocaleTimeString()}`, '',
          ...(result.summary ? [result.summary, ''] : []),
          `## ${t('mt_transcript')}`, '', transcript, '',
        ].join('\n');
        const name = `${fileBase(o.meeting.title, this.startedAt)} ${t('mt_minutes')}.md`;
        if (o.drive) {
          try {
            const folder = result.folder || (result.folder = await ensureFolder());
            const res = await fetch(`/api/drive/upload?parent=${encodeURIComponent(folder.id)}&name=${encodeURIComponent(name)}&mime=${encodeURIComponent('text/markdown')}`, { method: 'POST', body: new Blob([result.markdown], { type: 'text/markdown' }) });
            if (res.ok) result.minutesNode = await res.json();
          } catch { /* offered as a download below / 下面改为下载 */ }
        }
        if (!result.minutesNode) { saveLocally(new Blob([result.markdown], { type: 'text/markdown' }), name); result.local = true; }
      }
    }

    // One line on the server: this file is a recording of that meeting.
    // 服务端的一行记录:这个文件是那场会议的录像。
    if (result.node) {
      await api('POST', `/api/meet/${o.meeting.id}/recordings`, { node_id: result.node.id, started_at: this.startedAt, ended_at: endedAt, transcript_node: result.minutesNode?.id || undefined }).catch(() => {});
    } else if (result.minutesNode) {
      await api('POST', `/api/meet/${o.meeting.id}/transcript`, { node_id: result.minutesNode.id }).catch(() => {});
    }
    if (failure && !result.minutesNode && !result.markdown) throw failure;
    result.failure = failure;
    return result;
  }
}

// ---------- A recording that was cut short ----------
// ---------- 被打断的录制 ----------

/** Put together what a recording had sent up before its tab went away. The file ends where the
 *  last whole part ended; a player reads it to that point and stops, which is what a recording
 *  of a meeting somebody walked out of should do.
 *  把一次录制在它的标签页消失之前已经送上去的部分拼起来。文件终止于最后一个完整分片的末尾;
 *  播放器读到那里便停下 —— 对一份"录到一半人走了"的会议录像来说,这正是它该有的样子。 */
export async function recoverPending() {
  const p = lsGet();
  if (!p?.id) return null;
  // Fresh means a tab is still recording into it. / 还新鲜,说明有个标签页仍在往里录。
  if (Date.now() - (p.beat || 0) < 45000) return null;
  lsSet(null);
  if (!Array.isArray(p.parts) || !p.parts.length) {
    await api('POST', `/api/drive/upload/${p.id}/abort`).catch(() => {});
    return null;
  }
  try {
    const node = await api('POST', `/api/drive/upload/${p.id}/complete`, { parts: p.parts });
    if (p.meeting) await api('POST', `/api/meet/${p.meeting}/recordings`, { node_id: node.id, started_at: p.started, ended_at: p.beat }).catch(() => {});
    return { node, folder: p.folder || null };
  } catch {
    return null;
  }
}
