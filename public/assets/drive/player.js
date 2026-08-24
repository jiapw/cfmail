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
import { icon } from '../ui.js';
import { t } from '../i18n.js';

const QUIET_AFTER = 2600;
const NUDGE = 5;
const VOL_STEP = 0.05;

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
 * Put a set of controls on a film.
 *
 * `box` is the positioned element the film sits inside; the controls are laid over the film's own
 * rectangle, which is smaller than the box and moves when the window does. Returns a handle: a
 * slot for controls this module does not own, and a way to take the whole thing down again.
 *
 * 给一部片子装上一套控件。
 *
 * `box` 是片子所在的那个定位元素;控件铺在片子自己的矩形上 ——
 * 那个矩形比盒子小,而且会随窗口移动。返回一个把手:一个留给"本模块不拥有的控件"的位置,
 * 以及一个把整套东西再拆下来的办法。
 */
export function mountPlayer(video, box) {
  if (!video || !box || box.querySelector('.drv-pl')) return null;
  video.removeAttribute('controls');
  video.controls = false;

  const el = document.createElement('div');
  el.className = 'drv-pl';
  el.innerHTML = `
    <div class="drv-pl-tap"></div>
    <div class="drv-pl-big">${icon('play', 34)}</div>
    <div class="drv-pl-bar">
      <button class="drv-pl-b" data-pl="play"></button>
      <div class="drv-pl-seek"><div class="rail"><div class="buf"></div><div class="cur"></div></div><div class="knob"></div></div>
      <div class="drv-pl-time"><span class="now">0:00</span><span class="sep">/</span><span class="all">--:--</span></div>
      <div class="drv-pl-vol">
        <button class="drv-pl-b" data-pl="mute"></button>
        <div class="drv-pl-volbar"><div class="rail"><div class="cur"></div></div></div>
      </div>
      <span class="drv-pl-slot"></span>
      <button class="drv-pl-b" data-pl="full"></button>
    </div>`;
  box.appendChild(el);

  const q = (s) => el.querySelector(s);
  const bPlay = q('[data-pl="play"]');
  const bMute = q('[data-pl="mute"]');
  const bFull = q('[data-pl="full"]');
  const seek = q('.drv-pl-seek');
  const seekCur = q('.drv-pl-seek .cur');
  const seekBuf = q('.drv-pl-seek .buf');
  const knob = q('.drv-pl-seek .knob');
  const volBar = q('.drv-pl-volbar');
  const volCur = q('.drv-pl-volbar .cur');
  const tNow = q('.drv-pl-time .now');
  const tAll = q('.drv-pl-time .all');
  const big = q('.drv-pl-big');

  // ---- what the buttons currently say ----
  const paint = () => {
    const ended = video.ended;
    bPlay.innerHTML = icon(ended ? 'replay' : video.paused ? 'play' : 'pause', 20);
    bPlay.title = t(video.paused ? 'drv_pl_play' : 'drv_pl_pause');
    bPlay.setAttribute('aria-label', bPlay.title);
    const off = video.muted || !video.volume;
    bMute.innerHTML = icon(off ? 'muted' : 'volume', 20);
    bMute.title = t(off ? 'drv_pl_unmute' : 'drv_pl_mute');
    bMute.setAttribute('aria-label', bMute.title);
    volCur.style.width = pct(off ? 0 : video.volume);
    const full = document.fullscreenElement === box;
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
    const at = video.currentTime;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      const s = video.buffered.start(i);
      const e = video.buffered.end(i);
      if (at >= s - 0.5 && at <= e + 0.5) { lo = s; hi = e; break; }
      if (!hi) { lo = s; hi = e; }
    }
    seekBuf.style.left = pct(lo / d);
    seekBuf.style.width = pct((hi - lo) / d);
  };

  // ---- the controls come and go with the pointer ----
  let sleep = null;
  const quiet = () => {
    if (!el.isConnected) return;
    if (video.paused || video.ended || scrubbing || document.querySelector('.drv-menu')) {
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

  // ---- the film's own rectangle, which is not the box's ----
  const place = () => {
    if (!el.isConnected) return;
    const r = video.getBoundingClientRect();
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
  const fullscreen = () => {
    if (document.fullscreenElement === box) document.exitFullscreen?.();
    else box.requestFullscreen?.().catch(() => {});
  };

  // ---- dragging a rail ----
  /** One rail, dragged. The value follows the pointer from the moment it goes down, including
   *  outside the rail, because a pointer that leaves a slider is still holding it.
   *  一条轨道,被拖动。取值从指针按下的那一刻起就跟着它走,离开轨道也算 ——
   *  因为一个离开了滑块的指针,手里还攥着它。 */
  const draggable = (rail, onMove, onDone) => {
    // Measured against the painted rail, not against the box it sits in: the volume box is
    // clipped to nothing until the pointer is near it, and a width of zero turns every position
    // into the far end.
    // 按画出来的那条轨道量,而不是按装着它的盒子量:音量盒在指针靠近之前被裁成没有宽度,
    // 而宽度为零会把每一个位置都算成最右端。
    const frac = (e) => {
      const r = (rail.querySelector('.rail') || rail).getBoundingClientRect();
      if (!r.width) return 0;
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
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
  });

  bPlay.addEventListener('click', (e) => { e.stopPropagation(); toggle(); wake(); });
  bMute.addEventListener('click', (e) => { e.stopPropagation(); video.muted = !video.muted; paint(); wake(); });
  bFull.addEventListener('click', (e) => { e.stopPropagation(); fullscreen(); wake(); });
  big.addEventListener('click', (e) => { e.stopPropagation(); toggle(); wake(); });
  q('.drv-pl-tap').addEventListener('click', (e) => { e.stopPropagation(); toggle(); wake(); });
  q('.drv-pl-tap').addEventListener('dblclick', (e) => { e.stopPropagation(); fullscreen(); });
  el.querySelector('.drv-pl-bar').addEventListener('click', (e) => e.stopPropagation());

  const on = (target, name, fn) => { target.addEventListener(name, fn); return [target, name, fn]; };
  const bound = [
    on(video, 'play', paint), on(video, 'pause', paint), on(video, 'ended', paint),
    on(video, 'volumechange', paint), on(video, 'ratechange', paint),
    on(video, 'timeupdate', () => { clockUp(); bufUp(); }),
    on(video, 'durationchange', clockUp), on(video, 'loadedmetadata', () => { clockUp(); place(); }),
    on(video, 'progress', bufUp), on(video, 'seeked', () => { clockUp(); bufUp(); }),
    on(video, 'resize', place),
    on(box, 'mousemove', wake), on(box, 'mouseenter', wake),
    on(document, 'fullscreenchange', () => { paint(); place(); wake(); }),
    on(window, 'resize', place),
  ];

  const eye = new ResizeObserver(place);
  eye.observe(video);
  eye.observe(box);

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
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const to = e.target;
    if (to && (to.isContentEditable || /^(input|textarea|select)$/i.test(to.tagName || ''))) return false;
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
    destroy() {
      clearTimeout(sleep);
      eye.disconnect();
      for (const [target, name, fn] of bound) target.removeEventListener(name, fn);
      el.remove();
    },
  };
}
