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

const AV_VIDEO = 0;
const AV_AUDIO = 1;

/** What a browser can decode once the box is open. Names as libav spells them.
 *
 *  This is the second half of the same idea the container list is the first half of. Opening the
 *  box gets you nothing if what is inside is a codec nobody here can read, and a film is two of
 *  those questions rather than one: a picture the browser knows and a sound it does not is very
 *  common, because the sound on a disc rip is usually DTS or AC-3 and no browser decodes either.
 *
 *  盒子打开之后浏览器解得了什么。名字按 libav 的拼法。
 *
 *  这是同一个想法的后半段,容器名单是它的前半段。若盒子里装的是这里没人读得懂的编码,
 *  那把盒子打开也一无所获;而一部片子要问的是两个这样的问题而不是一个:
 *  "画面浏览器认得、声音它不认得"极其常见 —— 因为碟版片源的声音通常是 DTS 或 AC-3,
 *  而这两样没有浏览器解得了。 */
const PLAYS_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const PLAYS_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac']);

/**
 * Which streams go into the new box, and what is left behind.
 *
 * One picture and one sound. Everything else is dropped, and dropping it is not a simplification --
 * it is the difference between a file and no file. MP4 cannot hold ASS subtitles at all, and handed
 * one it does not warn: it fails, and the whole conversion fails with it. A disc rip carries four
 * of them.
 *
 * Sound the browser cannot decode is left behind too, rather than carried along to be ignored. What
 * is carried is what will play; anything else is a track that exists to disappoint.
 *
 * 哪些流进入新盒子,以及什么被留下。
 *
 * 一路画面,一路声音。其余一律丢弃 —— 而丢弃它们不是一种简化,
 * 它是"有文件"与"没有文件"之间的差别。MP4 根本装不下 ASS 字幕,而交给它一条时它不会警告:
 * 它会失败,整次转换随之失败。一个碟版片源带着四条这样的字幕。
 *
 * 浏览器解不了的声音也被留下,而不是带上去让人无视。带走的都是会响的;
 * 其余的只是一条为了让人失望而存在的轨。
 */
async function choose(av, streams) {
  const named = [];
  for (const s of streams) named.push({ s, name: await av.avcodec_get_name(s.codec_id) });
  const first = (type, ok) => named.find((x) => x.s.codec_type === type && ok.has(x.name));
  const v = first(AV_VIDEO, PLAYS_VIDEO);
  const a = first(AV_AUDIO, PLAYS_AUDIO);
  if (!v) {
    // Nothing to show. Which codec it was is worth carrying out, because "this needs another
    // program" is a different sentence from "something went wrong".
    // 没有可展示的东西。是哪种编码值得带出去,因为"这个需要另一个程序"
    // 与"出了点问题"不是同一句话。
    const any = named.find((x) => x.s.codec_type === AV_VIDEO);
    const err = new Error('e_drive_video_codec');
    err.codec = any?.name || '';
    throw err;
  }
  const heard = named.find((x) => x.s.codec_type === AV_AUDIO);
  return { take: a ? [v, a] : [v], silent: !a && heard ? heard.name : '' };
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
  let silent = '';

  await av.mkreadaheadfile(inName, file);
  try {
    const [ctx, streams] = await av.ff_init_demuxer_file(inName);
    if (!streams.length) throw new Error('e_drive_no_streams');
    const kept = await choose(av, streams);
    silent = kept.silent;
    // Which of the kept streams is video decides where the timestamps get rewritten below, so it
    // is worked out from what the demuxer said rather than guessed from the stream order.
    // 留下来的流里哪一条是视频,决定了下面在哪里重写时间戳 ——
    // 所以这一点依据解复用器的说法得出,而不是从流的顺序去猜。
    const video = new Set(kept.take.filter((k) => k.s.codec_type === AV_VIDEO).map((k) => k.s.index));
    // Input stream numbers are not output stream numbers once anything has been left behind, and a
    // packet carries the number it had on the way in.
    // 一旦有东西被留下不带走,输入的流号就不再是输出的流号,而一个包带着的是它进来时的那个号。
    const renumber = new Map(kept.take.map((k, i) => [k.s.index, i]));

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
    // Matroska stores presentation times and no decode times. MP4 requires decode times. The
    // demuxer hands back AV_NOPTS for the first video packets and a reconstruction afterwards that
    // does not always advance -- and the MP4 muxer silently drops every packet whose decode time
    // went backwards. Sixteen of seventy-five pictures went that way the first time, and the file
    // still played.
    //
    // Handing over nothing is not the fix either. The muxer then writes zero for every picture,
    // which looks right for as long as some other stream is carrying the duration and collapses
    // the moment the film is video only: a two-minute clip four hundredths of a second long.
    //
    // So they are worked out here. Decode order is display order delayed by however far the
    // reordering reaches -- that is what a B-frame is -- so the depth of the reordering is measured
    // and each picture is given the presentation time of the one that far behind it. That sequence
    // never goes backwards, by construction, and no picture is ever decoded after it is shown.
    //
    // ---- 唯一一处不是直接照搬的地方 ----
    //
    // Matroska 存的是呈现时间,不存解码时间。MP4 要求解码时间。解复用器对最初几个视频包交回
    // AV_NOPTS,之后交回的重建值又不总是递增 —— 而 MP4 muxer 会**静默地**丢掉每一个解码时间
    // 倒退的包。第一次就这样走掉了七十五帧里的十六帧,而那个文件照样能播。
    //
    // 什么都不给也不是解法。muxer 会给每一帧写零,只要还有别的流扛着时长,它就看起来是对的;
    // 而一旦这部片子只剩视频,它立刻塌掉:两分钟的片段只剩四百分之一秒。
    //
    // 所以在这里把它们算出来。解码顺序就是显示顺序按"重排能够到多远"往后延 ——
    // B 帧就是这么回事 —— 于是量出重排的深度,再把"落后它那么多的那一帧的呈现时间"发给每一帧。
    // 这个序列按构造就不会倒退,而且没有任何一帧会在它被显示之后才被解码。
    const shown = new Map();
    for (const p of packets) {
      if (!video.has(p.stream_index)) continue;
      if (!shown.has(p.stream_index)) shown.set(p.stream_index, []);
      shown.get(p.stream_index).push(av.i64tof64(p.pts, p.ptshi));
    }
    const decodeAt = new Map();
    for (const [id, seq] of shown) {
      const sorted = [...seq].sort((x, y) => x - y);
      const place = new Map(sorted.map((v, i) => [v, i]));
      let depth = 0;
      seq.forEach((v, i) => { depth = Math.max(depth, place.get(v) - i); });
      // Before the first picture there is nothing to borrow a time from, so the gap between
      // pictures is extended backwards to reach the ones that are decoded ahead of anything shown.
      // 第一帧之前没有时间可借,于是把帧间距往回延,去够到那些"先于任何显示而被解码"的帧。
      const gap = sorted.length > 1 ? (sorted[sorted.length - 1] - sorted[0]) / (sorted.length - 1) : 1;
      decodeAt.set(id, seq.map((_, i) => (i >= depth ? sorted[i - depth] : sorted[0] - (depth - i) * gap)));
    }
    const nth = new Map([...decodeAt.keys()].map((k) => [k, 0]));

    packets = packets
      .filter((p) => renumber.has(p.stream_index))
      .map((p) => {
        const q = { ...p, stream_index: renumber.get(p.stream_index) };
        if (!video.has(p.stream_index)) return q;
        const i = nth.get(p.stream_index);
        nth.set(p.stream_index, i + 1);
        const [dts, dtshi] = av.f64toi64(Math.round(decodeAt.get(p.stream_index)[i]));
        return { ...q, dts, dtshi };
      });

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
      kept.take.map((k) => [k.s.codecpar, k.s.time_base_num, k.s.time_base_den]));
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
  // The sound that was left behind comes out with the film, because the person watching is
  // about to notice its absence and should be told why rather than left to wonder.
  // 被留下的那路声音随片子一起交出去,因为正在看的人马上就会察觉它不在,
  // 而他应该被告知原因,而不是被留在那儿猜。
  return { blob: new Blob([out], { type: 'video/mp4' }), silent };
}
