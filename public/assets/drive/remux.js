// Changing the box a film is in, and remaking the sound when the sound is the problem.
//
// A browser plays a handful of containers and refuses the rest. What it refuses is usually not
// something it could not decode: a Matroska or an AVI very often holds H.264 -- which every
// browser decodes, frequently in hardware. The only thing missing is the ability to open the box.
// So the box is changed here, in the browser, and what comes out goes to the same <video> element
// as an ordinary file. Not one pixel is decoded or re-encoded on the way.
//
// The sound is the exception, and it is the reason this uses a build of libav.js that had to be
// made rather than downloaded. A disc rip carries DTS or AC-3 and no browser plays either, so that
// track is decoded and re-encoded as AAC. Sound is cheap to convert in a way pictures are not --
// a whole film's audio is seconds of work where its video would be an hour of it.
//
// What this still cannot do is a picture the browser cannot decode. An AVI full of Xvid opens now,
// and its frames can even be decoded -- enough to draw a thumbnail -- but playing it would mean
// re-encoding every frame, which is not a preview. Which of the three a file is gets stated by
// `verdict()`, so the drive can say which one somebody has rather than showing a spinner either way.
//
// 换掉一部片子所在的盒子;而当出问题的是声音时,把声音重做一遍。
//
// 浏览器只认少数几种容器,其余一概拒收。而它拒收的东西,通常并不是它解不了的东西:
// 一个 Matroska 或一个 AVI 里装的往往是 H.264 —— 每个浏览器都解得了,还常常是硬件解。
// 缺的只是打开那个盒子的能力。所以就在这里、在浏览器里把盒子换掉,
// 换出来的东西交给与普通文件同一个 <video>。整个过程没有一个像素被解码或重新编码。
//
// 声音是那个例外,也正是这里用的 libav.js 必须自己构建、而不是下载下来的原因。
// 碟版片源带的是 DTS 或 AC-3,而这两样没有浏览器放得了,所以那条轨会被解出来、重新编码成 AAC。
// 声音的转换便宜,而画面的不便宜 —— 一整部片子的音频是几秒钟的活,而它的视频会是一个小时。
//
// 这里仍然做不到的,是"浏览器解不了的画面"。一个装满 Xvid 的 AVI 现在打得开了,
// 它的帧甚至也解得出来 —— 足够画一张缩略图 —— 但要播放它就意味着把每一帧重新编码,
// 而那不是预览。一个文件属于三者中的哪一种由 `verdict()` 说明,
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
const BASE = '/vendor/libav-full';
const ENTRY = `${BASE}/libav-6.10.9.0-cfmail.mjs`;

/** What a browser plays without help. Kept as the one list, because two lists would eventually
 *  disagree about .mov and somebody would get a converted file they did not need.
 *  浏览器不需要帮助就能放的东西。只留这一份名单,因为两份名单迟早会在 .mov 上吵起来,
 *  然后就会有人拿到一个他本来不需要的转换结果。 */
const NATIVE = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'qt', '3gp', '3g2']);

/** Boxes this can open. AVI is here because the build was made for it: no published libav.js has
 *  the demuxer, and half the films anybody actually has are in one.
 *  这里打得开的盒子。AVI 在这儿,是因为这份构建本来就是为它建的:
 *  没有任何已发布的 libav.js 带这个解复用器,而一个人手上真正有的片子,有一半装在里面。 */
const CHANGEABLE = new Set(['mkv', 'mk3d', 'mks', 'avi', 'divx', 'asf', 'wmv', 'flv', 'f4v']);

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
  if (CHANGEABLE.has(e) || /^video\/(x-matroska|x-msvideo|x-ms-(wmv|asf)|x-flv)$/.test(m)) return 'remux';
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
  lib = await (LibAV.LibAV || LibAV)({ base: BASE, nothreads: true, variant: 'cfmail' });
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

/** What the sound is turned into when it arrives as something a browser will not play.
 *
 *  AAC because every browser plays it, stereo because a preview is not a home cinema and a 5.1
 *  track downmixed is the same film, and 48 kHz because that is what the sources are and
 *  resampling for no reason is work that can only lose.
 *
 *  当声音以"浏览器不会放的形式"到来时,它被转成什么。
 *
 *  AAC,因为每个浏览器都放得了;立体声,因为预览不是家庭影院,而一条缩混过的 5.1 仍是同一部片子;
 *  48 kHz,因为片源本来就是,而毫无理由地重采样是一件只可能有损失的工作。 */
const AAC_RATE = 48000;
const AAC_BITS = 160000;
const AV_CH_STEREO = 3;

/**
 * Decode a sound track this build understands and re-encode it as one the browser does.
 *
 * The filter graph is built from the frames rather than from the stream header, because the header
 * is what the file claims and the frames are what came out. For a codec that only settles its
 * layout once decoding starts -- which several do -- asking the header gives a graph configured for
 * something the frames are not.
 *
 * Nothing here touches the picture. This is the sound only, and it is the one part of the
 * conversion that is not a copy: everything else in this file moves bytes between boxes.
 *
 * 把一条这份构建懂的音轨解出来,再编码成浏览器懂的那一种。
 *
 * 滤镜图是照着帧建的,不是照着流头建的 —— 因为流头是这个文件的说法,而帧是实际出来的东西。
 * 对于那些"开始解码之后才定下声道布局"的编码(有好几种如此),照流头去问,
 * 建出来的图配置的是帧并不具备的那种东西。
 *
 * 这里不碰画面。这里只有声音,而它是整次转换中唯一不是拷贝的部分:
 * 这个文件里其余的一切,只是把字节从一个盒子搬到另一个盒子。
 */
async function toAac(av, track, packets) {
  let dc = 0; let dpkt = 0; let dframe = 0;
  let ec = 0; let eframe = 0; let epkt = 0;
  let graph = 0;
  try {
    [, dc, dpkt, dframe] = await av.ff_init_decoder(track.s.codec_id, track.s.codecpar);
    const raw = await av.ff_decode_multi(dc, dpkt, dframe, packets, true);
    if (!raw.length) throw new Error('e_drive_audio_decode');

    const first = raw[0];
    [, ec, eframe, epkt] = await av.ff_init_encoder('aac', {
      ctx: {
        bit_rate: AAC_BITS,
        sample_rate: AAC_RATE,
        sample_fmt: av.AV_SAMPLE_FMT_FLTP,
        channel_layout: AV_CH_STEREO,
      },
    });
    const frameSize = await av.AVCodecContext_frame_size(ec);

    let src; let sink;
    [graph, src, sink] = await av.ff_init_filter_graph('aresample', {
      sample_rate: first.sample_rate,
      sample_fmt: first.format,
      channel_layout: first.channel_layout ?? first.channels,
    }, {
      sample_rate: AAC_RATE,
      sample_fmt: av.AV_SAMPLE_FMT_FLTP,
      channel_layout: AV_CH_STEREO,
      // The encoder takes a fixed number of samples at a time and the filter has to hand it
      // exactly that, or the last of every batch is a short frame the encoder refuses.
      // 编码器一次只收固定数量的采样,滤镜必须刚好给它那么多 ——
      // 否则每一批的最后一帧都是个短帧,而编码器不收。
      frame_size: frameSize,
    });
    const even = await av.ff_filter_multi(src, sink, dframe, raw, true);
    const out = await av.ff_encode_multi(ec, eframe, epkt, even, true);
    if (!out.length) throw new Error('e_drive_audio_encode');

    // The muxer is given parameters, not a context: a context belongs to the encoder and dies with
    // it, and these have to outlive it by exactly as long as the writing takes.
    // 交给 muxer 的是参数而不是上下文:上下文属于编码器、与它同生共死,
    // 而这些参数必须比它多活恰好"写完"那么久。
    const par = await av.avcodec_parameters_alloc();
    await av.avcodec_parameters_from_context(par, ec);
    return { par, packets: out, time_base_num: 1, time_base_den: AAC_RATE };
  } finally {
    if (graph) await av.avfilter_graph_free_js(graph).catch(() => {});
    if (ec) await av.ff_free_encoder(ec, eframe, epkt).catch(() => {});
    if (dc) await av.ff_free_decoder(dc, dpkt, dframe).catch(() => {});
  }
}

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
  const a = first(AV_AUDIO, PLAYS_AUDIO);
  if (a) return { take: [v, a], convert: null, silent: '' };

  // Sound the browser will not play. Whether anything can be done about it is asked of the build
  // rather than looked up in a list here: a list would be a second statement of what was compiled
  // in, and the two would disagree the first time the fragments in build-libav.sh changed.
  // 浏览器不会放的声音。能不能对它做点什么,是去问这份构建,而不是在这里查一份名单 ——
  // 一份名单会成为"编进去了什么"的第二处陈述,而它们会在 build-libav.sh 的片段第一次变动时就吵起来。
  const heard = named.find((x) => x.s.codec_type === AV_AUDIO);
  if (!heard) return { take: [v], convert: null, silent: '' };
  const canDecode = await av.avcodec_find_decoder(heard.s.codec_id).catch(() => 0);
  const canEncode = await av.avcodec_find_encoder_by_name('aac').catch(() => 0);
  if (canDecode && canEncode) return { take: [v], convert: heard, silent: '' };
  return { take: [v], convert: null, silent: heard.name };
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
    // Where the remade sound will sit: after everything carried over unchanged.
    // 重做出来的那条声音会坐在哪里:排在所有原样带过来的东西之后。
    const madeAt = kept.convert ? kept.take.length : -1;

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

    // ---- the sound, which is the one thing here that is not a copy ----
    //
    // Done before the packets are filtered and renumbered, because this is the last moment the
    // sound still has a number to be found by: what is about to happen drops every stream not
    // being carried over, and the track being converted is one of those -- it is not carried over,
    // it is replaced.
    //
    // The muxer has to be told what this stream is before it will open, and that cannot be known
    // until the encoder is configured, which cannot happen until something has been decoded. So
    // the whole of it happens here, and what comes out is a set of packets and a description.
    //
    // ---- 声音,这里唯一一样不是拷贝的东西 ----
    //
    // 在过滤与重编号之前做,因为这是"这条声音还有个号可以被找到"的最后一刻:
    // 接下来要发生的事会丢掉每一条不被带走的流,而正在被转换的这一条就是其中之一 ——
    // 它不是被带走,它是被替换。
    //
    // muxer 在打开之前必须被告知这条流是什么,而那在编码器配好之前无从知道,
    // 编码器又要等到有东西被解出来之后才配得了。所以整件事在这里做完,
    // 出来的是一组包和一份说明。
    let made = null;
    if (kept.convert) {
      const heard = packets.filter((p) => p.stream_index === kept.convert.s.index);
      try {
        if (!heard.length) throw new Error('e_drive_audio_decode');
        made = await toAac(av, kept.convert, heard);
      } catch {
        // It could not be remade. The film is still the film, and naming the codec that was left
        // behind is better than a silent video with no explanation.
        // 它重做不出来。片子还是那部片子,而说出被留下的是哪一种编码,
        // 好过一段没有解释的无声视频。
        silent = kept.convert.name;
      }
    }

    // ---- the one thing that is not a straight copy ----
    //
    // MP4 wants both a presentation time and a decode time for every packet. Containers supply one
    // or the other, and which one depends on the container rather than on the film:
    //
    //   Matroska stores presentation times and no decode times. The pictures arrive reordered,
    //   because that is what a B-frame is, and the decode order has to be worked out. Decode order
    //   is display order delayed by however far the reordering reaches, so the depth is measured
    //   and each picture takes the presentation time of the one that far behind it. That sequence
    //   never goes backwards and no picture is ever decoded after it is shown.
    //
    //   AVI stores decode times and no presentation times, and carries no reordering information at
    //   all. There is nothing to work out: the two are the same, which is also exactly what ffmpeg
    //   itself writes when it copies an AVI into an MP4.
    //
    // Neither can be skipped. Handing the muxer a decode time it cannot use makes it drop the
    // packet -- silently, as a warning, still producing a file that plays; sixteen of seventy-five
    // pictures went that way once. Handing it none makes it write zero for all of them, which looks
    // right for as long as another stream carries the duration and collapses to four hundredths of
    // a second when none does.
    //
    // ---- 唯一一处不是直接照搬的地方 ----
    //
    // MP4 要求每个包同时有呈现时间和解码时间。容器只给其中一个,而给哪一个取决于容器,
    // 与这部片子无关:
    //
    //   Matroska 存呈现时间,不存解码时间。画面是乱序到达的 —— B 帧就是这么回事 ——
    //   解码顺序必须推出来。解码顺序就是显示顺序按"重排能够到多远"往后延,
    //   于是量出那个深度,再把"落后它那么多的那一帧的呈现时间"发给每一帧。
    //   这个序列不会倒退,也没有任何一帧会在被显示之后才被解码。
    //
    //   AVI 存解码时间,不存呈现时间,而且完全不带重排信息。这里没有什么可推的:
    //   两者就是同一个东西 —— 而这也正是 ffmpeg 自己把 AVI 拷进 MP4 时所写的。
    //
    // 两者都不能省。给 muxer 一个它用不了的解码时间,它会丢掉那个包 ——
    // 静默地丢、以警告的形式,而且照样产出一个能播的文件;曾经就这样走掉了七十五帧里的十六帧。
    // 一个都不给,它会给所有帧写零,只要还有别的流扛着时长它就看起来是对的,
    // 而一旦没有,整条轨就塌成四百分之一秒。
    const NOPTS_HI = -2147483648;
    const told = (lo, hi) => hi !== NOPTS_HI;

    const shown = new Map();
    for (const p of packets) {
      if (!video.has(p.stream_index)) continue;
      if (!shown.has(p.stream_index)) shown.set(p.stream_index, []);
      shown.get(p.stream_index).push(told(p.pts, p.ptshi) ? av.i64tof64(p.pts, p.ptshi) : null);
    }
    const decodeAt = new Map();
    for (const [id, seq] of shown) {
      if (seq.some((v) => v === null)) continue;   // no presentation times: the AVI case, below
      const sorted = [...seq].sort((x, y) => x - y);
      const place = new Map(sorted.map((v, i) => [v, i]));
      let depth = 0;
      seq.forEach((v, i) => { depth = Math.max(depth, place.get(v) - i); });
      // Before the first picture there is nothing to borrow a time from, so the gap between
      // pictures is extended backwards to reach the ones decoded ahead of anything shown.
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
        const plan = decodeAt.get(p.stream_index);
        if (plan) {
          const i = nth.get(p.stream_index);
          nth.set(p.stream_index, i + 1);
          const [dts, dtshi] = av.f64toi64(Math.round(plan[i]));
          return { ...q, dts, dtshi };
        }
        // The other way round: a decode time and nothing to show for it.
        // 反过来的情形:有解码时间,却没有与之对应的呈现时间。
        return told(p.pts, p.ptshi) ? q : { ...q, pts: p.dts, ptshi: p.dtshi };
      });

    // The remade sound joins after that, and not before: the step above drops every packet whose
    // number is not in the map, and these carry the number of a stream that did not come from the
    // file. Added earlier, they are added and then thrown away -- which is what happened, and what
    // it looked like was a conversion that reported success and produced no sound.
    // 重做出来的声音在那之后才汇入,不能在之前:上面那一步会丢掉每一个"号不在映射里"的包,
    // 而这些包带的是一个并非来自这个文件的流的号。加早了,就是加进去再被扔掉 ——
    // 而那正是发生过的事,它看起来的样子是:一次报告成功、却没有声音的转换。
    if (made) {
      for (const p of made.packets) packets.push({ ...p, stream_index: madeAt });
    }

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
      [
        ...kept.take.map((k) => [k.s.codecpar, k.s.time_base_num, k.s.time_base_den]),
        ...(made ? [[made.par, made.time_base_num, made.time_base_den]] : []),
      ]);
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
