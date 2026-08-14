// Hand-written LZMA1 / LZMA2 decoder (decode only), after Igor Pavlov's reference decoder.
// Resumable by design: the machines pause at clean SYMBOL boundaries whenever the rolling
// input buffer runs low ('input') or the window holds enough undrained output ('drain'), and
// continue exactly where they stopped once the driver feeds bytes in or drains bytes out.
// That keeps the per-bit hot path free of promises AND keeps memory bounded: input rolls
// through a compacting buffer, output lives in a circular dictionary window that is flushed
// to a sink -- a gigabyte-scale solid block streams through a few dozen MB of RAM.
// 手写 LZMA1/LZMA2 解码器(只解压),对照 Igor Pavlov 的参考实现。天生可续传:状态机只在
// 干净的符号边界暂停 —— 滚动输入不足时给 'input',窗口攒够未排水输出时给 'drain',
// 驱动方喂入或排出后从暂停点精确继续。每比特热路径完全无 Promise,内存亦有界:输入在
// 可压实的滚动缓冲里流过,输出住在环形字典窗口里、随排水流向接收器 —— GB 级 solid 块
// 只occupies 几十 MB 内存就能流过去。

// ---------- Rolling input / 滚动输入 ----------

export class In {
  constructor() {
    this.b = new Uint8Array(0);
    this.p = 0;
    this.abs = 0;      // absolute stream offset of b[0] / b[0] 的绝对流偏移
    this.eof = false;
  }
  /** Append fresh bytes, dropping what was already consumed / 追加新字节,丢弃已消费部分 */
  feed(u8) {
    const rest = this.b.subarray(this.p);
    const nb = new Uint8Array(rest.length + u8.length);
    nb.set(rest);
    nb.set(u8, rest.length);
    this.abs += this.p;
    this.b = nb;
    this.p = 0;
  }
  avail() {
    return this.b.length - this.p;
  }
  pos() {
    return this.abs + this.p;
  }
  /** Jump to an absolute offset already inside the buffer / 跳到缓冲内的绝对偏移 */
  seek(absPos) {
    const p = absPos - this.abs;
    if (p < 0 || p > this.b.length) throw new Error('e_arc_bad');
    this.p = p;
  }
}

// Pause guard: the largest number of input bytes one symbol can consume (worst-case bits
// plus range-coder normalisations), rounded well up.
// 暂停守卫:单个符号最多消耗的输入字节数(最坏比特数加区间归一化),取足余量。
const SYM_LOOKAHEAD = 64;

// ---------- Output window / 输出窗口 ----------

export class OutWindow {
  /** stopAt: hard stop for decoding; sink gets every produced byte between drains
   *  stopAt:解码硬停点。sink 在每次排水时收到新产出的字节 */
  constructor(winSize, stopAt) {
    this.size = Math.max(4096, winSize);
    this.buf = new Uint8Array(this.size);
    this.pos = 0;
    this.total = 0;
    this.drained = 0;
    // Drain in modest steps rather than half-a-window. The ring keeps the full dictionary
    // history either way, so this costs nothing in correctness -- but it lets the consumer see
    // output (and stop asking for more) long before a 64MB window fills.
    // 按小步排水,而不是攒够半个窗口。环形缓冲无论如何都保留完整字典历史,所以这不影响正确性 ——
    // 但能让消费方远早于 64MB 窗口填满就看到输出(并及时喊停)。
    this.drainAt = Math.min(this.size >> 1, 1 << 20);
    this.stopAt = stopAt;
    this.sink = null;
  }
  putByte(b) {
    this.buf[this.pos] = b;
    this.total++;
    if (++this.pos === this.size) this.pos = 0;
  }
  getByte(dist) {
    let i = this.pos - dist;
    if (i < 0) i += this.size;
    return this.buf[i];
  }
  copyMatch(dist, len) {
    for (let i = 0; i < len; i++) this.putByte(this.getByte(dist));
  }
  /** Copy undrained bytes out of the circle to the sink / 把未排水字节从环里拷给接收器 */
  drainNow() {
    let n = this.total - this.drained;
    if (n <= 0) return;
    if (n > this.size) throw new Error('e_arc_bad'); // guard kept it impossible / 守卫保证不会发生
    const out = new Uint8Array(n);
    let start = this.pos - n;
    if (start < 0) start += this.size;
    const first = Math.min(n, this.size - start);
    out.set(this.buf.subarray(start, start + first), 0);
    if (first < n) out.set(this.buf.subarray(0, n - first), first);
    const at = this.drained;
    this.drained = this.total;
    if (this.sink) this.sink(out, at);
  }
}

// ---------- Range decoder / 区间解码器 ----------

class RC {
  /** Needs 5 bytes available at construction / 构造时要求已有 5 字节 */
  constructor(inn) {
    this.inn = inn;
    inn.p++; // first byte is always 0 / 首字节恒为 0
    this.range = 0xffffffff >>> 0;
    this.code = 0;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | inn.b[inn.p++]) >>> 0;
  }
  bit(p, i) {
    const v = p[i];
    const bound = (this.range >>> 11) * v;
    let sym;
    if ((this.code >>> 0) < bound) {
      p[i] = v + ((2048 - v) >> 5);
      this.range = bound >>> 0;
      sym = 0;
    } else {
      p[i] = v - (v >> 5);
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      sym = 1;
    }
    if (this.range < 16777216) {
      const inn = this.inn;
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | inn.b[inn.p++]) >>> 0;
    }
    return sym;
  }
  direct(n) {
    let res = 0;
    do {
      this.range = this.range >>> 1;
      this.code = (this.code - this.range) >>> 0;
      const t = 0 - (this.code >>> 31);
      this.code = (this.code + (this.range & t)) >>> 0;
      if (this.range < 16777216) {
        const inn = this.inn;
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | inn.b[inn.p++]) >>> 0;
      }
      res = ((res << 1) + t + 1) >>> 0;
    } while (--n);
    return res >>> 0;
  }
  tree(p, base, nbits) {
    let m = 1;
    for (let i = 0; i < nbits; i++) m = (m << 1) + this.bit(p, base + m);
    return m - (1 << nbits);
  }
  rtree(p, base, nbits) {
    let m = 1;
    let res = 0;
    for (let i = 0; i < nbits; i++) {
      const b = this.bit(p, base + m);
      m = (m << 1) + b;
      res |= b << i;
    }
    return res;
  }
}

// Probability array layout (offsets into one Uint16Array) / 概率表布局(单数组内偏移)
const IS_MATCH = 0;          // 12 * 16
const IS_REP = 192;          // 12
const IS_REP_G0 = 204;
const IS_REP_G1 = 216;
const IS_REP_G2 = 228;
const IS_REP0_LONG = 240;    // 12 * 16
const POS_SLOT = 432;        // 4 * 64
const SPEC_POS = 688;        // 115
const ALIGN = 803;           // 16
const MATCH_LEN = 819;       // 2 + 128 + 128 + 256 = 514
const REP_LEN = 1333;        // 514
const LITERAL = 1847;        // 0x300 << (lc + lp)

/** Decoder state that survives across LZMA2 chunks / 跨 LZMA2 分块存续的解码器状态 */
export class LzmaState {
  // Window total at the last dictionary reset: position contexts (posState, literal
  // context) and distance validity all count from here, not from the folder start.
  // 上次字典重置时的窗口总量:位置上下文(posState、字面量上下文)与距离合法性
  // 都从这里起算,而不是块的绝对起点。
  dicBase = 0;
  setProps(propByte) {
    if (propByte >= 9 * 5 * 5) throw new Error('e_arc_bad');
    this.lc = propByte % 9;
    const r = (propByte / 9) | 0;
    this.lp = r % 5;
    this.pb = (r / 5) | 0;
    this.pbMask = (1 << this.pb) - 1;
    this.lpMask = (1 << this.lp) - 1;
    this.probs = new Uint16Array(LITERAL + (0x300 << (this.lc + this.lp)));
    this.resetState();
  }
  resetState() {
    this.probs.fill(1024);
    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
  }
}

function decodeLen(rc, p, base, posState) {
  if (rc.bit(p, base) === 0) return 2 + rc.tree(p, base + 2 + (posState << 3), 3);
  if (rc.bit(p, base + 1) === 0) return 10 + rc.tree(p, base + 130 + (posState << 3), 3);
  return 18 + rc.tree(p, base + 258, 8);
}

/** Run the LZMA1 machine towards `limit` produced bytes. Pauses only at symbol boundaries.
 *  Returns 'input' | 'drain' | 'end' (end marker) | 'limit'.
 *  朝 limit 产出字节数运行 LZMA1 状态机,只在符号边界暂停。 */
export function lzmaRun(st, rc, inn, win, limit) {
  const p = st.probs;
  for (;;) {
    if (win.total >= limit) return 'limit';
    if (win.total >= win.stopAt) return 'limit';
    if (inn.avail() < SYM_LOOKAHEAD && !inn.eof) return 'input';
    if (win.total - win.drained >= win.drainAt) return 'drain';
    const rel = win.total - st.dicBase;
    const posState = rel & st.pbMask;
    if (rc.bit(p, IS_MATCH + (st.state << 4) + posState) === 0) {
      const prev = rel ? win.getByte(1) : 0;
      const base = LITERAL + 0x300 * (((rel & st.lpMask) << st.lc) + (prev >> (8 - st.lc)));
      let sym = 1;
      if (st.state >= 7) {
        let mb = win.getByte(st.rep0 + 1);
        do {
          const mbit = (mb >> 7) & 1;
          mb = (mb << 1) & 0xff;
          const b = rc.bit(p, base + ((1 + mbit) << 8) + sym);
          sym = (sym << 1) | b;
          if (mbit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(p, base + sym);
      win.putByte(sym & 0xff);
      st.state = st.state < 4 ? 0 : st.state < 10 ? st.state - 3 : st.state - 6;
      continue;
    }
    let len;
    if (rc.bit(p, IS_REP + st.state) !== 0) {
      if (rel === 0) throw new Error('e_arc_bad');
      if (rc.bit(p, IS_REP_G0 + st.state) === 0) {
        if (rc.bit(p, IS_REP0_LONG + (st.state << 4) + posState) === 0) {
          st.state = st.state < 7 ? 9 : 11;
          win.putByte(win.getByte(st.rep0 + 1));
          continue;
        }
      } else {
        let dist;
        if (rc.bit(p, IS_REP_G1 + st.state) === 0) dist = st.rep1;
        else {
          if (rc.bit(p, IS_REP_G2 + st.state) === 0) dist = st.rep2;
          else {
            dist = st.rep3;
            st.rep3 = st.rep2;
          }
          st.rep2 = st.rep1;
        }
        st.rep1 = st.rep0;
        st.rep0 = dist;
      }
      len = decodeLen(rc, p, REP_LEN, posState);
      st.state = st.state < 7 ? 8 : 11;
    } else {
      st.rep3 = st.rep2;
      st.rep2 = st.rep1;
      st.rep1 = st.rep0;
      len = decodeLen(rc, p, MATCH_LEN, posState);
      st.state = st.state < 7 ? 7 : 10;
      const posSlot = rc.tree(p, POS_SLOT + ((len < 6 ? len - 2 : 3) << 6), 6);
      if (posSlot < 4) st.rep0 = posSlot;
      else {
        const nd = (posSlot >> 1) - 1;
        let dist = ((2 | (posSlot & 1)) << nd) >>> 0;
        if (posSlot < 14) dist = (dist + rc.rtree(p, SPEC_POS + dist - posSlot - 1, nd)) >>> 0;
        else {
          dist = (dist + ((rc.direct(nd - 4) << 4) >>> 0)) >>> 0;
          dist = (dist + rc.rtree(p, ALIGN, 4)) >>> 0;
        }
        if (dist === 0xffffffff) return 'end'; // end marker / 结束标记
        st.rep0 = dist;
      }
    }
    // Distances reach back at most to the last dictionary reset / 距离最远只能回到上次字典重置
    if (st.rep0 + 1 > rel || st.rep0 + 1 > win.size) throw new Error('e_arc_bad');
    win.copyMatch(st.rep0 + 1, Math.min(len, limit - win.total));
  }
}

/** LZMA2 dictionary size out of its one-byte property / LZMA2 单字节属性里的字典大小 */
export function lzma2DictSize(propByte) {
  if (propByte > 40) throw new Error('e_arc_bad');
  if (propByte === 40) return 0xffffffff;
  return ((2 | (propByte & 1)) << (propByte / 2 + 11)) >>> 0;
}

// ---------- Machines: uniform run(inn, win) -> 'input' | 'drain' | 'end' ----------
// ---------- 状态机:统一的 run(inn, win),返回 'input' | 'drain' | 'end' ----------

/** LZMA2: a sequence of chunks, each with its own range coder; probs/dict persist per flags
 *  LZMA2:分块序列,每块独立的区间编码器;概率与字典按标志位跨块存续 */
export class Lzma2Machine {
  constructor() {
    this.st = new LzmaState();
    this.haveProps = false;
    this.phase = 'ctrl';
    this.rc = null;
    this.chunkTarget = 0;   // window total at chunk end / 本块结束时的窗口总量
    this.chunkEndAbs = 0;   // absolute input offset of chunk end / 本块压缩数据结束的绝对输入位
    this.copyLeft = 0;
  }
  run(inn, win) {
    for (;;) {
      if (win.total >= win.stopAt) return 'end';
      // Yield at a steady output granularity whatever mix of chunk types the stream uses. The
      // per-symbol check inside lzmaRun cannot see a run of small uncompressed chunks, each of
      // which completes and loops straight back here -- so output would pile up unseen.
      // 无论流里是哪种块型混合,都按稳定的输出粒度让出。lzmaRun 内部的逐符号检查看不到连续的
      // 小未压缩块 —— 每块完成后直接跳回这里,输出会一路堆积无人知晓。
      if (win.total - win.drained >= win.drainAt) return 'drain';
      if (this.phase === 'ctrl') {
        if (inn.avail() < 1) {
          if (inn.eof) return 'end';
          return 'input';
        }
        // control byte + worst-case chunk header / 控制字节加最坏情况的块头
        if (inn.avail() < 10 && !inn.eof) return 'input';
        const ctrl = inn.b[inn.p++];
        if (ctrl === 0) return 'end';
        if (ctrl < 3) {
          if (inn.avail() < 2) throw new Error('e_arc_bad');
          this.copyLeft = ((inn.b[inn.p] << 8) | inn.b[inn.p + 1]) + 1;
          inn.p += 2;
          if (ctrl === 1) this.st.dicBase = win.total; // uncompressed chunk with dict reset / 带字典重置的未压缩块
          this.phase = 'copy';
        } else if (ctrl >= 0x80) {
          if (inn.avail() < 4) throw new Error('e_arc_bad');
          const unpack = (((ctrl & 0x1f) << 16) | (inn.b[inn.p] << 8) | inn.b[inn.p + 1]) + 1;
          const pack = ((inn.b[inn.p + 2] << 8) | inn.b[inn.p + 3]) + 1;
          inn.p += 4;
          const mode = (ctrl >> 5) & 3;
          if (mode >= 2) {
            if (inn.avail() < 1) throw new Error('e_arc_bad');
            this.st.setProps(inn.b[inn.p++]);
            this.haveProps = true;
            if (mode === 3) this.st.dicBase = win.total; // dict reset / 字典重置
          } else {
            if (!this.haveProps) throw new Error('e_arc_bad');
            if (mode === 1) this.st.resetState();
          }
          this.chunkTarget = win.total + unpack;
          this.chunkEndAbs = inn.pos() + pack;
          this.phase = 'rcinit';
        } else throw new Error('e_arc_bad');
      } else if (this.phase === 'copy') {
        const n = Math.min(this.copyLeft, inn.avail(), win.stopAt - win.total, win.size - (win.total - win.drained));
        for (let i = 0; i < n; i++) win.putByte(inn.b[inn.p + i]);
        inn.p += n;
        this.copyLeft -= n;
        if (!this.copyLeft) {
          this.phase = 'ctrl';
          continue;
        }
        if (win.total - win.drained >= win.drainAt) return 'drain';
        if (!inn.avail()) {
          if (inn.eof) throw new Error('e_arc_bad');
          return 'input';
        }
      } else if (this.phase === 'rcinit') {
        if (inn.avail() < 5 && !inn.eof) return 'input';
        this.rc = new RC(inn);
        this.phase = 'lzma';
      } else if (this.phase === 'skip') {
        // Align onto the declared chunk end; its padding bytes may still be in flight
        // 对齐到声明的块尾。填充字节可能尚未抵达
        if (inn.abs + inn.b.length < this.chunkEndAbs) {
          if (inn.eof) throw new Error('e_arc_bad');
          return 'input';
        }
        inn.seek(this.chunkEndAbs);
        this.rc = null;
        this.phase = 'ctrl';
      } else {
        const r = lzmaRun(this.st, this.rc, inn, win, this.chunkTarget);
        if (r === 'input' || r === 'drain') return r;
        // chunk complete: pack size is authoritative for where the next one starts
        // 块完成。下一块起点以声明的 pack 大小为准
        if (r === 'limit' && win.total < this.chunkTarget) return 'end'; // stopAt hit / 到达停点
        if (win.total !== this.chunkTarget && r !== 'end') throw new Error('e_arc_bad');
        this.phase = 'skip';
      }
    }
  }
}

/** Raw LZMA1 stream with 5-byte props on the coder (7z 030101)
 *  裸 LZMA1 流,5 字节属性在编码器上(7z 的 030101) */
export class Lzma1Machine {
  constructor(props5, unpackSize) {
    this.props5 = props5;
    this.unpackSize = unpackSize;
    this.st = null;
    this.rc = null;
  }
  run(inn, win) {
    if (!this.st) {
      if (inn.avail() < 5 && !inn.eof) return 'input';
      this.st = new LzmaState();
      this.st.setProps(this.props5[0]);
      this.rc = new RC(inn);
    }
    const r = lzmaRun(this.st, this.rc, inn, win, this.unpackSize);
    return r === 'limit' ? 'end' : r;
  }
}

/** Stored data, straight through / 直存数据,原样过 */
export class CopyMachine {
  constructor(unpackSize) {
    this.left = unpackSize;
  }
  run(inn, win) {
    for (;;) {
      if (!this.left || win.total >= win.stopAt) return 'end';
      // Copy at most up to the next drain point, so a big input feed still yields in steps
      // 一次最多拷到下一个排水点,大块输入喂进来也仍然分步让出
      const room = Math.max(1, win.drainAt - (win.total - win.drained));
      const n = Math.min(this.left, inn.avail(), win.stopAt - win.total, win.size - (win.total - win.drained), room);
      for (let i = 0; i < n; i++) win.putByte(inn.b[inn.p + i]);
      inn.p += n;
      this.left -= n;
      if (win.total - win.drained >= win.drainAt) return 'drain';
      if (!inn.avail() && this.left) {
        if (inn.eof) throw new Error('e_arc_bad');
        return 'input';
      }
    }
  }
}

// ---------- 7z filters (decode direction) / 7z 过滤器(解码方向) ----------

/** Delta decode in place / 原地 delta 解码 */
export function deltaDecode(buf, dist) {
  for (let i = dist; i < buf.length; i++) buf[i] = (buf[i] + buf[i - dist]) & 0xff;
}

/** BCJ x86 decode in place, after 7-Zip's Bra86 / 原地 BCJ x86 解码,对照 7-Zip Bra86 */
export function bcjX86(buf, ip0 = 0) {
  const test = (b) => b === 0 || b === 0xff;
  let prevMask = 0;
  let i = 0;
  const size = buf.length;
  if (size < 5) return;
  let prevPos = -1;
  while (i + 4 < size) {
    if ((buf[i] & 0xfe) !== 0xe8) {
      i++;
      continue;
    }
    const d = i - prevPos;
    prevPos = i;
    if (d > 3) prevMask = 0;
    else {
      prevMask = (prevMask << (d - 1)) & 7;
      if (prevMask !== 0) {
        const b = buf[i + 4 - kMaskToBitNumber[prevMask]];
        if (!kMaskToAllowedStatus[prevMask] || test(b)) {
          prevMask = ((prevMask << 1) & 7) | 1;
          i++;
          continue;
        }
      }
    }
    if (test(buf[i + 4])) {
      let src = ((buf[i + 4] << 24) | (buf[i + 3] << 16) | (buf[i + 2] << 8) | buf[i + 1]) >>> 0;
      let dest;
      for (;;) {
        dest = (src - (ip0 + i + 5)) >>> 0; // decode direction / 解码方向
        if (prevMask === 0) break;
        const idx = kMaskToBitNumber[prevMask] * 8;
        const b = (dest >>> (24 - idx)) & 0xff;
        if (!test(b)) break;
        src = (dest ^ (((1 << (32 - idx)) >>> 0) - 1)) >>> 0;
      }
      buf[i + 4] = (~(((dest >>> 24) & 1) - 1)) & 0xff;
      buf[i + 3] = (dest >>> 16) & 0xff;
      buf[i + 2] = (dest >>> 8) & 0xff;
      buf[i + 1] = dest & 0xff;
      i += 5;
    } else {
      prevMask = ((prevMask << 1) & 7) | 1;
      i++;
    }
  }
}
const kMaskToAllowedStatus = [1, 1, 1, 0, 1, 0, 0, 0];
const kMaskToBitNumber = [0, 1, 2, 2, 3, 3, 3, 3];
