// Subtitles that are pictures.
//
// A DVD does not store its subtitles as words. It stores them as small bitmaps -- four colours,
// one of them transparent -- laid over the film at a stated place, because a disc has to show
// Japanese and Arabic and a signwriter's handwriting without carrying a font for any of them. A
// rip of one carries them out as a pair: an .idx listing when each appears and where in the other
// file it lives, and a .sub holding the pictures inside an MPEG stream, which is the shape they
// had on the disc and which nobody bothered to change.
//
// So there is nothing to hand a text track and nothing to decode with: this build of libav has no
// subtitle decoder in it, and the library exposes no way to call one. What there is instead is a
// format simple enough to read directly -- a run-length count and a colour, two bits each, one
// line at a time, alternating between the even lines and the odd ones because a DVD was interlaced.
//
// 那些本身就是图画的字幕。
//
// 一张 DVD 不把它的字幕存成字。它把它们存成小小的位图 —— 四种颜色,其中一种是透明 ——
// 铺在片子上某个说好的位置。因为一张碟必须能显示日文、阿拉伯文,以及一个招牌师傅的手写体,
// 而它不可能为其中任何一种带上一副字体。从碟上抓出来时,它们成对出现:
// 一个 .idx 列出每一张什么时候出现、以及它住在另一个文件的什么位置;
// 一个 .sub 把这些图画装在一条 MPEG 流里 —— 那是它们在碟上的形状,而没有人费心改过它。
//
// 所以这里既没有东西可以交给文字轨,也没有解码器可用:这份 libav 构建里没有字幕解码器,
// 而这个库也没有暴露调用它的办法。有的是另一样东西 —— 一种简单到可以直接读的格式:
// 一个游程长度加一个颜色,各两个比特,一次一行,而且在偶数行与奇数行之间交替 ——
// 因为一张 DVD 是隔行的。

/**
 * The index: what appears when, and where to find it.
 *
 * Sixteen colours for the whole disc, a frame size the positions are stated against, and then one
 * line per subtitle. A file may hold several languages, each with its own run of lines, which is
 * why the streams come back separately rather than as one list.
 *
 * 索引:什么时候出现什么,以及去哪里找它。
 *
 * 整张碟共用十六种颜色,一个"位置以它为准"的画幅尺寸,然后每条字幕一行。
 * 一个文件可以装好几种语言,各有自己的一串行 —— 这正是这些流分开交回、
 * 而不是并成一份清单的原因。
 */
export function readIndex(text) {
  const out = { size: { w: 720, h: 480 }, palette: [], streams: [] };
  let now = null;
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    let m = /^size:\s*(\d+)x(\d+)/i.exec(s);
    if (m) { out.size = { w: Number(m[1]), h: Number(m[2]) }; continue; }
    m = /^palette:\s*(.+)$/i.exec(s);
    if (m) {
      out.palette = m[1].split(',').map((c) => parseInt(c.trim(), 16) || 0);
      continue;
    }
    m = /^id:\s*([A-Za-z-]*)\s*,\s*index:\s*(\d+)/i.exec(s);
    if (m) { now = { lang: m[1] || '', index: Number(m[2]), cues: [] }; out.streams.push(now); continue; }
    m = /^timestamp:\s*(\d+):(\d+):(\d+):(\d+)\s*,\s*filepos:\s*([0-9a-f]+)/i.exec(s);
    if (m && now) {
      now.cues.push({
        at: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
        pos: parseInt(m[5], 16),
      });
    }
  }
  for (const st of out.streams) st.cues.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * One picture's bytes, pulled out of the stream they were shipped in.
 *
 * The .sub is a Program Stream, which is what a DVD is: a chain of packs, each holding packets,
 * one of which is the subtitle. A single picture is usually longer than one packet, so the pieces
 * are collected until as many bytes have arrived as the first two of them said there would be.
 *
 * 一张图画的字节,从它被装运时所在的那条流里取出来。
 *
 * .sub 是一条 Program Stream —— 一张 DVD 就是这个东西:一串 pack,每个装着若干 packet,
 * 其中之一是字幕。一张图画通常比一个 packet 长,所以这些片段会一直被收集,
 * 直到到达的字节数,等于最先那两个字节所说的数目。
 */
export function spuAt(b, pos) {
  let at = pos;
  const parts = [];
  let want = 0;
  let got = 0;
  while (at + 6 <= b.length) {
    if (b[at] !== 0 || b[at + 1] !== 0 || b[at + 2] !== 1) break;
    const kind = b[at + 3];
    if (kind === 0xba) {
      // A pack header, whose length depends on which MPEG this is; the last three bits say how
      // much padding follows. 一个 pack 头,长度取决于这是哪一代 MPEG;最后三个比特说明后面跟着多少填充。
      at += (b[at + 4] & 0xc0) === 0x40 ? 14 + (b[at + 13] & 7) : 12;
      continue;
    }
    if (kind === 0xb9) break;
    const len = (b[at + 4] << 8) | b[at + 5];
    if (kind !== 0xbd) { at += 6 + len; continue; }
    const skip = b[at + 8];
    let p = at + 9 + skip;
    p++;  // the substream number, which says which language this packet belongs to
    const payload = b.subarray(p, at + 6 + len);
    if (!parts.length) {
      if (payload.length < 2) break;
      want = (payload[0] << 8) | payload[1];
      if (!want) break;
    }
    parts.push(payload);
    got += payload.length;
    at += 6 + len;
    if (got >= want) break;
  }
  if (!want || !parts.length) return null;
  const out = new Uint8Array(want);
  let o = 0;
  for (const p of parts) {
    const n = Math.min(p.length, want - o);
    out.set(p.subarray(0, n), o);
    o += n;
    if (o >= want) break;
  }
  return o === want ? out : null;
}

/** How long a delay in the control stream is, in seconds. The clock is the disc's, and it counts
 *  in ninety-thousandths with a step of a thousand and twenty-four.
 *  控制流里的一个延时有多长,以秒计。那口钟是碟的钟,它按九万分之一计数,步长是一千零二十四。 */
const TICK = 1024 / 90000;

/**
 * A picture, its place on the screen, and when it comes and goes.
 *
 * The bytes are in two halves that do not look alike. The first is the picture, run-length coded:
 * a count and one of four colours, packed into as few four-bit pieces as the count will fit in,
 * and written twice over -- once for the even lines and once for the odd, because the screen it
 * was made for drew them at different moments.
 *
 * The second half is a little program: set the palette, set the transparency, set the rectangle,
 * show it now, hide it in two and a half seconds. That is where the timing comes from -- the index
 * says when a picture starts, and the picture itself says how long it stays.
 *
 * 一张图画、它在屏幕上的位置,以及它何时来、何时去。
 *
 * 这些字节分成互不相像的两半。前一半是图画,游程编码:一个数目加四种颜色之一,
 * 挤进"这个数目装得下的最少几个四比特"里,而且写了两遍 —— 偶数行一遍、奇数行一遍,
 * 因为它当年面对的那块屏幕,是在两个不同的时刻把它们画出来的。
 *
 * 后一半是一小段程序:设定调色板、设定透明度、设定矩形、现在显示、两秒半之后收起。
 * 时间就是从那里来的 —— 索引说一张图画什么时候开始,而图画自己说它停留多久。
 */
export function decodeSpu(spu, palette) {
  if (!spu || spu.length < 4) return null;
  const size = Math.min((spu[0] << 8) | spu[1], spu.length);
  let ctrl = (spu[2] << 8) | spu[3];
  let where = [0, 0];
  let colours = [0, 1, 2, 3];
  let alphas = [0, 0, 0, 15];
  let x1 = 0; let x2 = -1; let y1 = 0; let y2 = -1;
  let from = 0;
  let to = 0;
  let guard = 0;

  while (ctrl + 4 <= size && guard++ < 64) {
    const when = (((spu[ctrl] << 8) | spu[ctrl + 1]) >>> 0) * TICK;
    const next = (spu[ctrl + 2] << 8) | spu[ctrl + 3];
    let p = ctrl + 4;
    let end = false;
    while (p < size && !end) {
      const cmd = spu[p++];
      if (cmd === 0x00 || cmd === 0x01) from = when;
      else if (cmd === 0x02) { to = when; }
      // Four nibbles, and they run the other way: the first names the colour of the pixels
      // written as three, the last of those written as zero. Read in the order they are written,
      // the background gets the paint meant for the lettering and the picture comes out a solid
      // black rectangle with pale words on it -- which is exactly what it looked like.
      // 四个半字节,而它们的顺序是反的:第一个说明的是"写作 3 的那些像素"的颜色,
      // 最后一个才是"写作 0 的"。照写下来的顺序去读,背景会拿到本该给笔画的那份颜料,
      // 于是这张图变成一个纯黑的方块、上面浮着几个浅色的字 —— 而它当时看起来正是那样。
      else if (cmd === 0x03) { colours = [spu[p + 1] & 15, spu[p + 1] >> 4, spu[p] & 15, spu[p] >> 4]; p += 2; }
      else if (cmd === 0x04) { alphas = [spu[p + 1] & 15, spu[p + 1] >> 4, spu[p] & 15, spu[p] >> 4]; p += 2; }
      else if (cmd === 0x05) {
        x1 = (spu[p] << 4) | (spu[p + 1] >> 4);
        x2 = ((spu[p + 1] & 15) << 8) | spu[p + 2];
        y1 = (spu[p + 3] << 4) | (spu[p + 4] >> 4);
        y2 = ((spu[p + 4] & 15) << 8) | spu[p + 5];
        p += 6;
      } else if (cmd === 0x06) {
        where = [(spu[p] << 8) | spu[p + 1], (spu[p + 2] << 8) | spu[p + 3]];
        p += 4;
      } else if (cmd === 0x07) { p += 2 + ((spu[p] << 8) | spu[p + 1]); }
      else end = true;   // 0xff, and anything unrecognised, ends this sequence
    }
    if (next <= ctrl) break;
    ctrl = next;
  }

  const w = x2 - x1 + 1;
  const h = y2 - y1 + 1;
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return null;

  // Four colours and four transparencies, looked up once rather than per pixel.
  // 四种颜色、四种透明度,查一次就好,不必每个像素查一遍。
  const rgba = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    const c = palette[colours[i]] || 0;
    const a = Math.round((alphas[i] / 15) * 255);
    // Little-endian, which is how a canvas keeps its bytes.
    // 小端,那正是画布保存它的字节的方式。
    rgba[i] = (a << 24) | (((c) & 0xff) << 16) | (((c >> 8) & 0xff) << 8) | ((c >> 16) & 0xff);
  }

  let painted = false;
  const out = new Uint8ClampedArray(w * h * 4);
  const words = new Uint32Array(out.buffer);
  const nib = (i) => ((i & 1) ? (spu[i >> 1] & 15) : (spu[i >> 1] >> 4));
  let cursor = [where[0] * 2, where[1] * 2];

  for (let y = 0; y < h; y++) {
    const half = y & 1;
    let at = cursor[half];
    let x = 0;
    while (x < w && (at >> 1) < size) {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        v = (v << 4) | nib(at++);
        if (v >= (4 << (2 * i))) break;
      }
      let run = v >> 2;
      if (run === 0 || x + run > w) run = w - x;
      const colour = rgba[v & 3];
      if (colour >>> 24) painted = true;
      const row = y * w;
      for (let i = 0; i < run; i++) words[row + x + i] = colour;
      x += run;
    }
    // Every line starts on a whole byte. 每一行都从一个完整的字节开始。
    if (at & 1) at++;
    cursor[half] = at;
  }

  // A picture with nothing visible in it is not a picture. A reel of these opens with one --
  // a few pixels, shown for a fiftieth of a second -- and a player that draws it puts up an
  // empty box at the start of the film.
  // 一张里面什么都看不见的图,不是一张图。这样的一卷开头就有一个 ——
  // 几个像素,显示五十分之一秒 —— 而一个把它画出来的播放器,
  // 会在片子开头摆上一个空盒子。
  if (!painted) return null;
  return { x: x1, y: y1, w, h, data: out, from, to: to > from ? to : from + 5 };
}
