// The player's own controls.
//
// A browser draws a row of controls for a <video> and every browser draws a different one: the
// buttons are in a different order, the volume slider appears or does not, the captions button
// exists or does not, and none of it can be positioned, styled, or reasoned about. A subtitle
// track that is a canvas rather than a text track has nowhere to appear in it at all. So the
// controls are drawn here instead, and the browser is asked to draw none.
//
// What that buys, beyond the layout: the same behaviour on every platform, one place where a jump
// is turned into a currentTime, and room for the controls this application actually has.
//
// 播放器自己的那套控件。
//
// 浏览器会为 <video> 画一排控件,而每种浏览器画的都不一样:按钮次序不同,音量条有的有有的没有,
// 字幕按钮有的有有的没有,而这一切都无法定位、无法设置样式、也无从推理。
// 一条"是画布而不是文字轨"的字幕,在那排控件里根本没有地方可以出现。
// 所以控件改在这里画,而浏览器被要求一个都不要画。
//
// 除了布局之外这换来的是:每个平台上同一种行为,一个"把跳转变成 currentTime"的唯一地点,
// 以及给这个应用真正拥有的那些控件留出的位置。
import { icon, fmtSize, settleAfterFullscreen } from '../ui.js';
import { t } from '../i18n.js';

const QUIET_AFTER = 2600;
const NUDGE = 5;
const VOL_STEP = 0.05;
const SAMPLE = 500;

/** h:mm:ss when a film is that long, m:ss when it is not. An unknown length is not zero.
 *  片长到了小时就写 h:mm:ss,没到就写 m:ss。未知的长度不是零。 */
function clock(s) {
  if (!isFinite(s) || s < 0) return '--:--';
  const n = Math.floor(s);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const sec = n % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

const pct = (x) => `${Math.max(0, Math.min(1, x)) * 100}%`;

/**
 * The rectangle the picture actually occupies inside its element.
 *
 * Usually the two are the same: a film is given no width and no height, so the element takes the
 * size of what is in it. Filling the screen is the exception -- there the element is the whole
 * screen and the picture is centred inside it with bars at the sides or above and below -- and
 * everything laid over the film has to follow the picture rather than the element, or the
 * subtitles end up in the bars.
 *
 * 画面在它的元素内部真正占据的那个矩形。
 *
 * 通常两者是同一个:片子没有被指定宽高,于是元素就是它内容的大小。铺满屏幕是例外 ——
 * 那时元素是整块屏幕,而画面居中在里面、两侧或上下留着黑边 ——
 * 于是一切叠在片子上的东西都必须跟着画面走而不是跟着元素走,否则字幕会落到黑边里。
 */
export function pictureOf(video) {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || !r.width || !r.height) return r;
  const k = Math.min(r.width / vw, r.height / vh);
  const w = vw * k;
  const h = vh * k;
  const left = r.left + (r.width - w) / 2;
  const top = r.top + (r.height - h) / 2;
  return { left, top, width: w, height: h, right: left + w, bottom: top + h };
}

/**
 * Put a set of controls on a film.
 *
 * `box` is the positioned element the film sits inside; the controls are laid over the picture,
 * which is smaller than the box and moves when the window does. `opts.bytes` returns how many
 * bytes of the source have been fetched so far, if anybody is counting -- it is what turns a
 * spinner into an answer.
 *
 * 给一部片子装上一套控件。
 *
 * `box` 是片子所在的那个定位元素;控件铺在画面上,而画面比盒子小、并且会随窗口移动。
 * `opts.bytes` 返回"到目前为止取回了多少源字节",如果有人在数的话 ——
 * 正是它把一个转圈变成一个答复。
 */
export function mountPlayer(video, box, opts = {}) {
  if (!video || !box || box.querySelector('.drv-pl')) return null;
  video.removeAttribute('controls');
  video.controls = false;

  const el = document.createElement('div');
  el.className = 'drv-pl';
  el.innerHTML = `
    <div class="drv-pl-tap"></div>
    <div class="drv-pl-stall"><div class="drv-spin"></div><span class="rate"></span></div>
    <div class="drv-pl-big">${icon('play', 34)}</div>
    <div class="drv-pl-bar">
      <button class="drv-pl-b" data-pl="play"></button>
      <div class="drv-pl-seek"><div class="rail"><div class="buf"></div><div class="cur"></div></div><div class="knob"></div></div>
      <div class="drv-pl-time"><span class="now">0:00</span><span class="sep">/</span><span class="all">--:--</span></div>
      <div class="drv-pl-vol">
        <button class="drv-pl-b" data-pl="vol"></button>
        <div class="drv-pl-volpop">
          <div class="drv-pl-volbar"><div class="rail"><div class="cur"></div></div></div>
          <button class="drv-pl-b" data-pl="mute"></button>
        </div>
      </div>
      <span class="drv-pl-slot"></span>
      <button class="drv-pl-b" data-pl="full"></button>
    </div>`;
  box.appendChild(el);

  const q = (s) => el.querySelector(s);
  const bPlay = q('[data-pl="play"]');
  const bVol = q('[data-pl="vol"]');
  const bMute = q('[data-pl="mute"]');
  const bFull = q('[data-pl="full"]');
  const seek = q('.drv-pl-seek');
  const seekCur = q('.drv-pl-seek .cur');
  const seekBuf = q('.drv-pl-seek .buf');
  const knob = q('.drv-pl-seek .knob');
  const vol = q('.drv-pl-vol');
  const volBar = q('.drv-pl-volbar');
  const volCur = q('.drv-pl-volbar .cur');
  const tNow = q('.drv-pl-time .now');
  const tAll = q('.drv-pl-time .all');
  const rate = q('.drv-pl-stall .rate');

  // ---- what the buttons currently say ----
  const paint = () => {
    const ended = video.ended;
    bPlay.innerHTML = icon(ended ? 'replay' : video.paused ? 'play' : 'pause', 20);
    bPlay.title = t(video.paused ? 'drv_pl_play' : 'drv_pl_pause');
    bPlay.setAttribute('aria-label', bPlay.title);
    const off = video.muted || !video.volume;
    bVol.innerHTML = icon(off ? 'muted' : 'volume', 20);
    bVol.title = t('drv_pl_volume');
    bVol.setAttribute('aria-label', bVol.title);
    bMute.innerHTML = icon(off ? 'volume' : 'muted', 18);
    bMute.title = t(off ? 'drv_pl_unmute' : 'drv_pl_mute');
    bMute.setAttribute('aria-label', bMute.title);
    volCur.style.height = pct(off ? 0 : video.volume);
    const full = fsEl() === box;
    bFull.innerHTML = icon(full ? 'windowed' : 'fullscreen', 20);
    bFull.title = t(full ? 'drv_pl_windowed' : 'drv_pl_fullscreen');
    bFull.setAttribute('aria-label', bFull.title);
    el.classList.toggle('playing', !video.paused && !ended);
  };

  // ---- where we are ----
  let scrubbing = false;
  const clockUp = () => {
    const d = video.duration;
    tAll.textContent = clock(d);
    if (scrubbing) return;
    tNow.textContent = clock(video.currentTime);
    const at = d ? video.currentTime / d : 0;
    seekCur.style.width = pct(at);
    knob.style.left = pct(at);
  };
  // The buffer is a window around where we are, not a stretch from the beginning: this film is
  // being converted as it plays, and what has been made is only what is nearby.
  // 缓冲是围绕"我们所在之处"的一个窗口,而不是从开头铺过来的一段:
  // 这部片子是边放边转的,已经做好的只有近处那一点。
  const bufUp = () => {
    const d = video.duration;
    if (!d || !video.buffered.length) { seekBuf.style.left = '0%'; seekBuf.style.width = '0%'; return; }
    const now = video.currentTime;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      const s = video.buffered.start(i);
      const e = video.buffered.end(i);
      if (now >= s - 0.5 && now <= e + 0.5) { lo = s; hi = e; break; }
      if (!hi) { lo = s; hi = e; }
    }
    seekBuf.style.left = pct(lo / d);
    seekBuf.style.width = pct((hi - lo) / d);
  };

  /**
   * Waiting, and what the waiting is worth.
   *
   * A spinner says only that something is happening. What somebody wants to know while a film
   * stops is whether it is coming -- so the bytes actually arriving are counted and shown. It is
   * the rate off the network, not the rate of the film: this pipeline fetches a stretch of the
   * source, converts it, and comes back for more, so the two are not the same number, and the
   * first is the one that answers "is this going to work".
   *
   * 等待,以及这次等待值多少。
   *
   * 一个转圈只说明"有事在发生"。片子停住时人想知道的是它还来不来 ——
   * 所以把真正到达的字节数出来给人看。这是网络上的速率,不是片子的速率:
   * 这条流水线取一段源、转一段、再回头取,两者不是同一个数字,
   * 而"这事儿到底成不成"要靠前一个来回答。
   */
  const WINDOW = 3000;
  let marks = [];
  let ever = false;
  const sample = () => {
    const got = opts.bytes?.();
    if (typeof got !== 'number') return;
    const now = performance.now();
    marks.push({ at: now, got });
    while (marks.length > 2 && now - marks[0].at > WINDOW) marks.shift();
  };
  // Over the last few seconds rather than the last half-second, and as a plain division rather
  // than a running average. A window of the source is fetched in one burst and then nothing
  // happens until the converter wants more, so any measure short enough to sit inside one of
  // those gaps reports a stopped network on a film that is arriving perfectly well.
  // 按最近这几秒来算,而不是按最近半秒;用一次直白的除法,而不是滚动平均。
  // 一个源窗口是一口气取回来的,之后直到转换器再要之前什么都不发生 ——
  // 于是任何短到能整个落进那些间隙里的测量,都会在一部下得好好的片子上报出"网络停了"。
  const rateNow = () => {
    if (marks.length < 2) return 0;
    const first = marks[0];
    const last = marks[marks.length - 1];
    const dt = last.at - first.at;
    return dt > 0 ? ((last.got - first.got) * 1000) / dt : 0;
  };
  const stallUp = () => {
    if (!el.isConnected) return;
    if (video.readyState >= 3) ever = true;
    // Before the film has ever run, the veil over the whole preview is what is speaking; two
    // spinners at once say less than one.
    // 在片子第一次跑起来之前,说话的是盖住整个预览的那层遮罩;两个转圈一起转,说的比一个还少。
    const stuck = ever && (!video.paused || video.seeking) && video.readyState < 3;
    el.classList.toggle('stalled', stuck);
    if (!stuck) return;
    const bps = rateNow();
    rate.textContent = bps > 1 ? `${fmtSize(bps)}/s` : '';
  };

  // ---- the controls come and go with the pointer ----
  let sleep = null;
  const quiet = () => {
    if (!el.isConnected) return;
    if (video.paused || video.ended || scrubbing
      || vol.classList.contains('open') || document.querySelector('.drv-menu')) {
      sleep = setTimeout(quiet, 1200);
      return;
    }
    el.classList.remove('awake');
  };
  const wake = () => {
    if (!el.isConnected) return;
    el.classList.add('awake');
    clearTimeout(sleep);
    sleep = setTimeout(quiet, QUIET_AFTER);
  };

  // ---- over the picture, which is not the element once the screen is full ----
  const place = () => {
    if (!el.isConnected) return;
    const r = pictureOf(video);
    const b = box.getBoundingClientRect();
    el.style.left = `${Math.round(r.left - b.left)}px`;
    el.style.top = `${Math.round(r.top - b.top)}px`;
    el.style.width = `${Math.round(r.width)}px`;
    el.style.height = `${Math.round(r.height)}px`;
  };

  const toggle = () => {
    if (video.ended) { video.currentTime = 0; video.play?.().catch(() => {}); return; }
    if (video.paused) video.play?.().catch(() => {}); else video.pause();
  };
  const nudge = (by) => {
    const d = video.duration || 0;
    video.currentTime = Math.max(0, Math.min(d ? d - 0.1 : Infinity, video.currentTime + by));
    wake();
  };
  const louder = (by) => {
    video.muted = false;
    video.volume = Math.max(0, Math.min(1, video.volume + by));
    paint();
    wake();
  };
  // Three generations of the same API, oldest reachable last. iPadOS spells it with the webkit
  // prefix and nothing else -- the optional call on the unprefixed name resolved to undefined
  // and did NOTHING, which is exactly a button that ignores being pressed. The iPhone has no
  // element fullscreen under either name; what it has is the video's own native fullscreen,
  // which loses these controls but plays the film large, and that is what the button is for.
  // 同一个 API 的三代拼法,最老的那个放最后够。iPadOS 只认带 webkit 前缀的写法 ——
  // 无前缀名字上的可选调用解析成 undefined,于是什么也不做,而这恰恰就是"按了没反应的按钮"。
  // iPhone 上两种拼法的元素全屏都没有;它有的是视频自己的原生全屏 ——
  // 这套控件会丢,但片子放大了,而那才是这个按钮存在的目的。
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  // Shared with the full-window preview: see settleAfterFullscreen in ui.js.
  // 与全窗预览共用:见 ui.js 的 settleAfterFullscreen。
  const settle = settleAfterFullscreen;
  const fullscreen = () => {
    if (fsEl() === box) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      return;
    }
    const native = () => video.webkitEnterFullscreen?.();
    if (box.requestFullscreen) box.requestFullscreen().catch(native);
    else if (box.webkitRequestFullscreen) { try { box.webkitRequestFullscreen(); } catch { native(); } }
    else native();
  };
  const openVol = (on) => {
    const now = on === undefined ? !vol.classList.contains('open') : !!on;
    vol.classList.toggle('open', now);
    // Two things hanging off one row of controls, and only one of them at a time. Whoever mounted
    // this owns the other one, so they are the one who can put it away.
    // 一排控件上挂着两样东西,而一次只该有一样。另一样归"挂载这套控件的人"所有,
    // 所以能把它收起来的也是那个人。
    if (now) opts.onOpen?.();
    wake();
  };

  // ---- dragging a rail ----
  /** One rail, dragged. The value follows the pointer from the moment it goes down, including
   *  outside the rail, because a pointer that leaves a slider is still holding it. Measured
   *  against the painted rail rather than the box around it, and a rail that stands up is read
   *  from its foot.
   *  一条轨道,被拖动。取值从指针按下的那一刻起就跟着它走,离开轨道也算 ——
   *  因为一个离开了滑块的指针,手里还攥着它。按画出来的那条轨道量,而不是按装着它的盒子量;
   *  而竖着的那条,从脚下往上读。 */
  const draggable = (rail, onMove, onDone, upright) => {
    const frac = (e) => {
      const r = (rail.querySelector('.rail') || rail).getBoundingClientRect();
      if (upright) return r.height ? Math.max(0, Math.min(1, (r.bottom - e.clientY) / r.height)) : 0;
      return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
    };
    rail.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Refused for a pointer the browser is not tracking, and a refusal here must not take the
      // drag down with it -- the capture is a convenience, not the mechanism.
      // 对一个浏览器并未在跟踪的指针,这个请求会被拒绝,而这里的一次拒绝不该把整个拖动一起带走 ——
      // 捕获只是图个方便,不是这件事赖以成立的机制。
      try { rail.setPointerCapture?.(e.pointerId); } catch { /* not tracked / 没在跟踪 */ }
      onMove(frac(e), true);
      const move = (ev) => onMove(frac(ev), false);
      const up = (ev) => {
        rail.removeEventListener('pointermove', move);
        rail.removeEventListener('pointerup', up);
        rail.removeEventListener('pointercancel', up);
        onDone?.(frac(ev));
      };
      rail.addEventListener('pointermove', move);
      rail.addEventListener('pointerup', up);
      rail.addEventListener('pointercancel', up);
    });
  };

  draggable(seek, (f) => {
    scrubbing = true;
    const d = video.duration || 0;
    seekCur.style.width = pct(f);
    knob.style.left = pct(f);
    tNow.textContent = clock(f * d);
    wake();
  }, (f) => {
    scrubbing = false;
    const d = video.duration || 0;
    if (d) video.currentTime = f * d;
    wake();
  });

  draggable(volBar, (f) => {
    video.muted = false;
    video.volume = f;
    paint();
    wake();
  }, null, true);

  const tap = q('.drv-pl-tap');
  bPlay.addEventListener('click', (e) => { e.stopPropagation(); toggle(); wake(); });
  bVol.addEventListener('click', (e) => { e.stopPropagation(); openVol(); });
  bMute.addEventListener('click', (e) => { e.stopPropagation(); video.muted = !video.muted; paint(); wake(); });
  bFull.addEventListener('click', (e) => { e.stopPropagation(); fullscreen(); wake(); });
  q('.drv-pl-big').addEventListener('click', (e) => { e.stopPropagation(); toggle(); wake(); });
  tap.addEventListener('click', (e) => { e.stopPropagation(); openVol(false); toggle(); wake(); });
  tap.addEventListener('dblclick', (e) => { e.stopPropagation(); fullscreen(); });
  q('.drv-pl-bar').addEventListener('click', (e) => e.stopPropagation());

  const on = (target, name, fn) => { target.addEventListener(name, fn); return [target, name, fn]; };
  const bound = [
    on(video, 'play', paint), on(video, 'pause', paint), on(video, 'ended', paint),
    on(video, 'volumechange', paint), on(video, 'ratechange', paint),
    on(video, 'timeupdate', () => { clockUp(); bufUp(); }),
    on(video, 'durationchange', clockUp),
    on(video, 'loadedmetadata', () => { clockUp(); place(); }),
    on(video, 'progress', () => { bufUp(); stallUp(); }),
    on(video, 'seeked', () => { clockUp(); bufUp(); stallUp(); }),
    on(video, 'seeking', stallUp), on(video, 'waiting', stallUp),
    on(video, 'playing', () => { ever = true; stallUp(); }),
    on(video, 'canplay', stallUp), on(video, 'stalled', stallUp),
    on(video, 'resize', place),
    on(box, 'mousemove', wake), on(box, 'mouseenter', wake),
    on(document, 'fullscreenchange', () => { paint(); place(); wake(); if (!fsEl()) settle(); }),
    on(document, 'webkitfullscreenchange', () => { paint(); place(); wake(); if (!fsEl()) settle(); }),
    // The iPhone's native player says goodbye on the video itself, not on the document
    // iPhone 的原生播放器是在 video 元素上、而不是在 document 上道别的
    on(video, 'webkitendfullscreen', settle),
    on(document, 'pointerdown', (e) => { if (!vol.contains(e.target)) openVol(false); }),
    on(window, 'resize', place),
  ];

  const eye = new ResizeObserver(place);
  eye.observe(video);
  eye.observe(box);
  const beat = setInterval(() => { sample(); stallUp(); place(); }, SAMPLE);

  paint();
  clockUp();
  bufUp();
  place();
  wake();

  /** The keys a film answers to. Returns true when the key was taken, so whatever else listens
   *  for it -- stepping to the next file, for one -- knows to leave it alone.
   *  一部片子听得懂的按键。被接下时返回 true,好让其余在听同一个键的东西 ——
   *  比如"翻到下一个文件" —— 知道这一下不归它。 */
  const keys = (e) => {
    if (!el.isConnected) return false;
    const to = e.target;
    if (to && (to.isContentEditable || /^(input|textarea|select)$/i.test(to.tagName || ''))) return false;
    // The one combination that is a combination. Everywhere else Alt+Enter has meant this.
    // 唯一一个带修饰键的组合。别处的 Alt+Enter 一直是这个意思。
    if (e.altKey && e.key === 'Enter') { fullscreen(); e.preventDefault(); wake(); return true; }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case ' ': case 'k': case 'K': toggle(); break;
      case 'ArrowLeft': nudge(-NUDGE); break;
      case 'ArrowRight': nudge(NUDGE); break;
      case 'ArrowUp': louder(VOL_STEP); break;
      case 'ArrowDown': louder(-VOL_STEP); break;
      case 'm': case 'M': video.muted = !video.muted; paint(); wake(); break;
      case 'f': case 'F': fullscreen(); break;
      default: return false;
    }
    e.preventDefault();
    wake();
    return true;
  };

  return {
    el,
    slot: q('.drv-pl-slot'),
    keys,
    place,
    closeVolume: () => openVol(false),
    picture: () => pictureOf(video),
    destroy() {
      clearTimeout(sleep);
      clearInterval(beat);
      eye.disconnect();
      for (const [target, name, fn] of bound) target.removeEventListener(name, fn);
      el.remove();
    },
  };
}
