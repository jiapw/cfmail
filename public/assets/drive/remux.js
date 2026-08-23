// Changing the box a film is in, without touching the film.
//
// A browser plays a handful of containers and refuses the rest. What it refuses is not always
// something it could not decode: a Matroska file very often holds H.264 or VP9 or AV1 -- codecs
// every browser has decoders for, sometimes in hardware. The only thing missing is the ability to
// open the box. So the box is changed here, in the browser, and what comes out goes to the same
// <video> element as an ordinary file. Not one pixel is decoded or re-encoded on the way.
//
// This does not help a file whose *codec* the browser cannot decode -- an AVI full of Xvid stays
// unplayable no matter what box it is in, and that is a different and far more expensive problem.
// It is not attempted. What this can and cannot do is stated plainly by `verdict()`, so the drive
// can tell somebody which of the two they have rather than showing them a spinner either way.
//
// 换掉一部片子所在的盒子,而不碰那部片子。
//
// 浏览器只认少数几种容器,其余一概拒收。而它拒收的东西,并不总是它解不了的东西:
// 一个 Matroska 文件里装的往往是 H.264、VP9 或 AV1 —— 每个浏览器都有这些编码的解码器,
// 有时还是硬件的。缺的只是打开那个盒子的能力。所以就在这里、在浏览器里把盒子换掉,
// 换出来的东西交给与普通文件同一个 <video>。整个过程没有一个像素被解码或重新编码。
//
// 这救不了"编码本身浏览器就解不了"的文件 —— 一个装满 Xvid 的 AVI,换什么盒子都还是放不了,
// 那是另一个、且昂贵得多的问题,这里不做。能做什么、不能做什么由 verdict() 明说,
// 于是网盘可以告诉人他手上的是哪一种,而不是两种都给他看一个转圈。
import { store } from '../app.js';

/** Past this, changing the box stops being a preview.
 *
 *  The whole film has to be read before the new box can be closed, and the new box is built in
 *  memory because MP4 writes its index last and puts it first. So the cost is roughly the size of
 *  the file, in RAM, on whatever device is looking at it. A ceiling that says "not here" is a
 *  better answer than a minute of waiting followed by a tab that ran out of memory.
 *
 *  超过这个大小,换盒子就不再算是预览了。
 *
 *  新盒子封口之前必须把整部片子读完,而新盒子是在内存里搭起来的 ——
 *  因为 MP4 的索引最后才写、却要放在最前面。于是代价大约是这个文件那么大的内存,
 *  在正看着它的那台设备上。一个直说"这里不行"的上限,好过等上一分钟、然后标签页内存耗尽。 */
export const REMUX_MAX = 512 * 1024 * 1024;

const V = () => encodeURIComponent(store.brand?.version || '');
const BASE = '/vendor/libav';
const ENTRY = `${BASE}/libav-6.10.9.0-webcodecs.mjs`;

/** What a browser plays without help. Kept as the one list, because two lists would eventually
 *  disagree about .mov and somebody would get a converted file they did not need.
 *  浏览器不需要帮助就能放的东西。只留这一份名单,因为两份名单迟早会在 .mov 上吵起来,
 *  然后就会有人拿到一个他本来不需要的转换结果。 */
const NATIVE = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'qt', '3gp', '3g2']);

/** Boxes this can open. Matroska is the whole point of the exercise; the rest are here because
 *  libav opens them too and it costs nothing to say so.
 *  这里打得开的盒子。Matroska 是这件事的全部意义;其余几个在这儿,
 *  是因为 libav 顺带也打得开,说出来不花什么。 */
const CHANGEABLE = new Set(['mkv', 'mk3d', 'mks']);

/** Everything that is a film, whichever of the three it turns out to be. Asked first, because a
 *  question about which container a spreadsheet is in has no useful answer.
 *  一切是片子的东西,无论它最终属于三者中的哪一种。先问这个,
 *  因为"一份表格装在什么容器里"这个问题没有有用的答案。 */
const VIDEO = new Set([...NATIVE, ...CHANGEABLE,
  'avi', 'divx', 'wmv', 'asf', 'flv', 'f4v', 'rm', 'rmvb', 'vob', 'ogm',
  'mpg', 'mpeg', 'm2v', 'ts', 'm2ts', 'mts', 'dv', 'amv']);

const extOf = (name) => (/\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();

/**
 * Which of the three a file is: playable as it stands, playable once the box is changed, or not
 * playable here at all.
 *
 * The third answer matters as much as the second. A file the browser cannot decode used to get a
 * file icon and no explanation, which reads as "this application is broken" rather than "this
 * format needs a different program".
 *
 * 一个文件属于三者中的哪一种:照现在这样就能放、换掉盒子之后能放、或者在这里根本放不了。
 *
 * 第三个答案与第二个同样要紧。一个浏览器解不了的文件,过去只会得到一个文件图标、外加零解释 ——
 * 那读起来像"这个应用坏了",而不是"这个格式需要另一个程序"。
 */
export function verdict(name, mime) {
  const e = extOf(name);
  const m = String(mime || '').toLowerCase();
  // Null rather than 'no': "this is not a film" and "this is a film that will not play here" are
  // different answers, and only one of them is worth telling somebody about.
  // 返回 null 而不是 'no':"这不是片子"与"这是一部在这里放不了的片子"是两个不同的答案,
  // 而其中只有一个值得告诉人。
  if (!VIDEO.has(e) && !m.startsWith('video/')) return null;
  if (NATIVE.has(e) || /^video\/(mp4|webm|ogg|quicktime)$/.test(m)) return 'native';
  if (CHANGEABLE.has(e) || /^video\/x-matroska$/.test(m)) return 'remux';
  return 'no';
}

let mod = null;
let lib = null;
/** One instance, made once and kept. It carries a WebAssembly module and a worker; a second one
 *  would cost both again for no gain, and nothing here is re-entrant enough to want two.
 *  一个实例,造一次就留着。它带着一个 WebAssembly 模块和一个 worker;
 *  再造一个要把这两样再付一遍而毫无收益,而且这里没有任何东西可重入到需要两个。 */
async function libav() {
  if (lib) return lib;
  if (!mod) mod = await import(`${ENTRY}?v=${V()}`);
  const LibAV = mod.default || mod.LibAV || mod;
  // The threaded build needs SharedArrayBuffer, which needs the whole site to be cross-origin
  // isolated. It is not, so the plain build is the one that ships and the one asked for here.
  // 线程版需要 SharedArrayBuffer,而那需要整个站点处于跨源隔离状态。它不是,
  // 所以发出去的是普通构建,这里要的也是它。
  lib = await (LibAV.LibAV || LibAV)({ base: BASE, nothreads: true, variant: 'webcodecs' });
  return lib;
}

/**
 * Read a file's packets and write them into an MP4.
 *
 * `seconds`, when given, stops after that much of the film. A thumbnail needs the opening of a
 * two-gigabyte file and nothing else, and converting the whole of it to get one frame is the kind
 * of thing that reads as the application having hung.
 *
 * 读出一个文件的各个包,写进一个 MP4。
 *
 * 给了 `seconds` 就在那么多片长之后停下。一张缩略图要的是一个两吉字节文件的开头、别的都不要,
 * 而为了拿一帧去转换它的全部,正是那种会被读成"这个应用卡死了"的事。
 */
export async function toMp4(file, { seconds = 0, limit = 0 } = {}) {
  const av = await libav();
  const inName = 'in-' + Math.floor(performance.now()) + '.dat';
  const outName = inName + '.mp4';
  let out = new Uint8Array(0);

  await av.mkreadaheadfile(inName, file);
  try {
    const [ctx, streams] = await av.ff_init_demuxer_file(inName);
    if (!streams.length) throw new Error('e_drive_no_streams');
    // Codec type 0 is video. Which streams are video decides where the timestamps get rewritten
    // below, so it is worked out once, from what the demuxer said, rather than guessed from the
    // stream order.
    // 编码类型 0 是视频。哪些流是视频,决定了下面在哪里重写时间戳,
    // 所以只算一次、依据解复用器的说法,而不是从流的顺序去猜。
    const video = new Set(streams.filter((s) => s.codec_type === 0).map((s) => s.index));

    const pkt = await av.av_packet_alloc();
    // Read as one list in file order. Read stream by stream, a whole video track arrives before
    // the first sound and the muxer has to reorder around it.
    // 按文件顺序读成一份清单。若按流分别读,整条视频轨会在第一声之前到达,
    // muxer 就得围着它重排。
    // `limit` stops the reading, `seconds` trims what was read. Both are needed and they are not
    // the same lever: without the byte limit, asking for the first ten seconds of a two-gigabyte
    // film still reads two gigabytes and then throws almost all of it away.
    // `limit` 让读取停下,`seconds` 修剪已经读到的东西。两者都需要,而且不是同一个杠杆:
    // 没有字节上限的话,"要一部两吉字节片子的头十秒"仍然会把两吉字节读完,再把其中几乎全部扔掉。
    const [, byStream] = await av.ff_read_frame_multi(ctx, pkt,
      limit > 0 ? { unify: true, limit } : { unify: true });
    let packets = byStream[0] || [];

    if (seconds > 0) {
      const tb = streams[0].time_base_den / (streams[0].time_base_num || 1);
      const until = seconds * tb;
      const cut = packets.findIndex((p) => (p.pts || 0) > until);
      if (cut > 0) packets = packets.slice(0, cut);
    }

    // ---- the one thing that is not a straight copy ----
    //
    // Matroska stores presentation times and no decode times. MP4 requires decode times. So the
    // demuxer hands over a decode time it reconstructed, and for video -- which is reordered,
    // because that is what B-frames are -- that reconstruction does not always advance. The MP4
    // muxer drops every packet whose decode time does not advance, and it does so as a warning
    // while still producing a file that plays: the first version of this lost sixteen of
    // seventy-five pictures and looked perfectly fine.
    //
    // Handing over no decode time at all lets the muxer work the order out for itself, which it
    // can, because it has the presentation times and knows the codec. Only video: sound is not
    // reordered, its decode time is already right, and taking it away loses a packet.
    //
    // ---- 唯一一处不是直接照搬的地方 ----
    //
    // Matroska 存的是呈现时间,不存解码时间。MP4 要求解码时间。于是解复用器交出来的是它重建的
    // 解码时间 —— 而对视频来说(视频是重排过的,B 帧就是这么回事),那份重建并不总是递增。
    // MP4 muxer 会丢掉每一个解码时间没有前进的包,而且它是以警告的方式丢、同时照样产出一个能播的
    // 文件:这段代码的第一版丢掉了七十五帧里的十六帧,看起来毫无问题。
    //
    // 干脆一个解码时间都不给,muxer 就会自己把顺序推出来 —— 它推得出来,
    // 因为它有呈现时间、也知道编码。只对视频这么做:声音没有重排,它的解码时间本来就是对的,
    // 拿掉反而会少一个包。
    packets = packets.map((p) => (video.has(p.stream_index) ? { ...p, dts: null, dtshi: null } : p));

    await av.mkwriterdev(outName);
    const chunks = [];
    let end = 0;
    // MP4 is written out of order: the index goes in after the film, at the front. So the writes
    // are collected by position and assembled once, rather than appended.
    // MP4 是乱序写出来的:索引在片子之后才写,却要放在最前面。
    // 所以这些写入按位置收集、最后一次性拼起来,而不是一路追加。
    av.onwrite = (nm, pos, data) => {
      if (nm !== outName) return;
      chunks.push({ pos, data: data.slice(0) });
      end = Math.max(end, pos + data.length);
    };

    const [oc, , pb] = await av.ff_init_muxer(
      { filename: outName, format_name: 'mp4', open: true, codecpars: true },
      streams.map((s) => [s.codecpar, s.time_base_num, s.time_base_den]));
    await av.avformat_write_header(oc, 0);
    const wpkt = await av.av_packet_alloc();
    await av.ff_write_multi(oc, wpkt, packets, false);
    await av.av_write_trailer(oc);
    await av.ff_free_muxer(oc, pb);
    await av.av_packet_free_js(wpkt);
    await av.av_packet_free_js(pkt);
    await av.avformat_close_input_js(ctx);
    av.onwrite = null;
    await av.unlink(outName).catch(() => {});

    out = new Uint8Array(end);
    for (const c of chunks) out.set(c.data, c.pos);
  } finally {
    await av.unlinkreadaheadfile(inName).catch(() => {});
  }
  if (!out.byteLength) throw new Error('e_drive_remux_failed');
  return new Blob([out], { type: 'video/mp4' });
}
