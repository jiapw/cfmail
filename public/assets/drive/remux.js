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
// None of it waits for the end. The film is read a piece at a time out of a range request, changed
// a piece at a time, and handed over a piece at a time, so a two-hour file starts playing in about
// as long as a two-minute one and neither is ever held in memory. That is the shape of this file,
// and everything in it that looks roundabout is there because something had to be worked out from
// a window rather than from the whole:
//
//   * MP4 writes its index last and puts it first, which cannot be streamed at all. A fragmented
//     MP4 does not have one: it opens with a header that promises nothing, and then every piece is
//     complete when it is written. Nothing is ever patched, which is the property that matters,
//     because bytes handed to a MediaSource cannot be taken back.
//   * Decode order used to be worked out by sorting every timestamp in the file. It is now a delay
//     line a few frames long, which gives the same numbers -- see `reorder`.
//   * The browser has to be told what is in the stream before it will accept the first byte of it,
//     so the header the muxer produced is read back and the answer taken from there.
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
// 这里没有任何一步在等结尾。片子从一个 Range 请求里一块一块读进来、一块一块换掉、一块一块交出去,
// 于是一个两小时的文件开始播放所花的时间,和一个两分钟的差不多,而两者都不会被整个搬进内存。
// 这就是这份文件的形状;它里面一切看起来绕的地方,都是因为某样东西必须从一个窗口里推出来,
// 而不是从整体:
//
//   * MP4 的索引最后才写、却要放在最前面 —— 这件事根本没法流式。分片 MP4 没有那个索引:
//     它以一个什么都不承诺的头开场,此后每一块在写下来的时候就已经完整。没有任何东西会被回头修补,
//     而这正是要紧的那条性质 —— 交给 MediaSource 的字节收不回来。
//   * 解码顺序过去是靠把文件里每一个时间戳排序推出来的。现在它是一条几帧长的延迟线,
//     给出的是同样的数字 —— 见 `reorder`。
//   * 浏览器在收下第一个字节之前,必须先被告知这条流里装的是什么,
//     所以 muxer 产出的那个头会被读回来,答案从那里取。
//
// 这里仍然做不到的,是"浏览器解不了的画面"。一个装满 Xvid 的 AVI 现在打得开了,
// 它的帧甚至也解得出来 —— 足够画一张缩略图 —— 但要播放它就意味着把每一帧重新编码,
// 而那不是预览。一个文件属于三者中的哪一种由 `verdict()` 说明,
// 于是网盘可以告诉人他手上的是哪一种,而不是两种都给他看一个转圈。
import { store } from '../app.js';

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
const AVERROR_EOF = -541478725;
const NOPTS_HI = -2147483648;
const told = (hi) => hi !== NOPTS_HI;
/** EAGAIN and EWOULDBLOCK: a read that stopped because it was told to, which is not an end.
 *  EAGAIN 与 EWOULDBLOCK:一次因为被叫停而停下的读,那不是结束。 */
const paused = (res) => res === -6 || res === -11;

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

// ---------------------------------------------------------------------------------------------
// Getting the bytes
// ---------------------------------------------------------------------------------------------

/** How much is fetched when a few kilobytes are asked for.
 *
 *  libav reads through a buffer that asks for about thirty kilobytes at a time. Answered literally
 *  over the network that is one request per thirty kilobytes -- a hundred thousand of them for a
 *  film -- so a request that misses fetches a window around it, and the reads that follow, which
 *  are nearly always the next ones along, are already in hand.
 *
 *  当有人只要几十千字节时,实际取回来多少。
 *
 *  libav 是透过一个缓冲区读的,它一次大约要三十千字节。照字面在网络上作答,
 *  那就是每三十千字节一个请求 —— 一部片子十万个 —— 所以一次落空的请求会取回它周围的一个窗口,
 *  而随后那些读(几乎总是紧挨着的下一批)已经在手上了。 */
const WINDOW = 4 * 1024 * 1024;
/** What the first one is, before anything is known about how this is going to be read. A film
 *  should start playing after half a megabyte, not after four; the window doubles from here, so
 *  reading straight through costs the same as it would have and starting costs an eighth.
 *  第一个窗口有多大 —— 在还不知道接下来会被怎么读的时候。一部片子应当在半兆字节之后开始播,
 *  而不是四兆之后;窗口从这里开始翻倍,于是"一路读到底"的代价和原来一样,而"开始"的代价是八分之一。 */
const FIRST = 512 * 1024;
/** Enough windows that the picture and the sound, which are read from two places at once, do not
 *  evict each other. 窗口留够,好让"画面和声音"这两处同时进行的读不至于互相挤掉。 */
const WINDOWS = 4;

/** Where a film's bytes come from: something already in hand, or a URL that honours Range.
 *  一部片子的字节从哪儿来:一样已经在手上的东西,或者一个支持 Range 的 URL。 */
function bytesOf(source) {
  const size = Number(source?.size) || 0;
  const held = [];
  const pull = source instanceof Blob
    ? async (at, len) => new Uint8Array(await source.slice(at, at + len).arrayBuffer())
    : async (at, len) => {
      const r = await fetch(source.url, { headers: { Range: `bytes=${at}-${at + len - 1}` } });
      if (!r.ok && r.status !== 206) throw new Error('e_drive_not_found');
      return new Uint8Array(await r.arrayBuffer());
    };
  let span = FIRST;
  return {
    size,
    served: 0,
    async read(at, len) {
      if (at >= size) return new Uint8Array(0);
      // A read that starts inside a window is answered from it even if it runs off the end. Short
      // answers are ordinary -- the reader asks again for the rest -- whereas fetching a fresh
      // window for every read that straddles a boundary means fetching the whole film twice.
      // 一次落在某个窗口里的读,就由那个窗口作答,即使它越到了窗口末尾之外。
      // 短的答复是寻常事 —— 读的一方会再来要剩下的 —— 而"每遇到一次跨边界的读就取一个新窗口",
      // 意味着把整部片子取两遍。
      let at0 = held.findIndex((w) => at >= w.at && at < w.at + w.data.length);
      if (at0 < 0) {
        const data = await pull(at, Math.min(span, size - at));
        if (!data.length) return new Uint8Array(0);
        span = Math.min(WINDOW, span * 2);
        this.served += data.length;
        held.push({ at, data });
        if (held.length > WINDOWS) held.shift();
        at0 = held.length - 1;
      }
      const win = held[at0];
      const from = at - win.at;
      return win.data.subarray(from, Math.min(win.data.length, from + Math.min(len, size - at)));
    },
  };
}

/** One handler for every device, routed by name. libav has a single callback for the whole
 *  instance, and the instance is shared -- a thumbnail is very often being made for one file while
 *  another is playing.
 *  所有设备共用一个处理函数,按名字分发。libav 整个实例只有一个回调,而这个实例是共用的 ——
 *  一边在给某个文件做缩略图、一边在放另一个,这种情况非常常见。 */
const sources = new Map();
const sinks = new Map();
function route(av) {
  if (av.onblockread) return;
  av.onblockread = (name, pos, len) => {
    const src = sources.get(name);
    // Every read is answered, including one for a film nobody is watching any more. A read that is
    // simply not answered is not an error anywhere -- it is a wait that never ends, and because one
    // library serves every film in the tab, the next one queues behind it and the one after that,
    // and what somebody sees is a spinner that never stops on a file that was never the problem.
    // 每一次读都要作答,包括为一部已经没人在看的片子发出的读。一次干脆不作答的读,
    // 在任何地方都不算错误 —— 它只是一场永不结束的等待;而因为这个标签页里所有片子共用一个库,
    // 下一部会排在它后面,再下一部又排在那之后 ——
    // 而人看到的,是一个永远停不下来的转圈,出现在一个本来毫无问题的文件上。
    if (!src) { av.ff_block_reader_dev_send(name, pos, new Uint8Array(0)); return; }
    src.read(pos, len).then(
      (data) => av.ff_block_reader_dev_send(name, pos, data),
      // A range that will not come is an end of file, not a hang. Something has to be sent back
      // or the read never returns. 一个来不了的区间是文件结束,不是卡住。
      // 必须回一点东西,否则那次读永远不返回。
      () => av.ff_block_reader_dev_send(name, pos, new Uint8Array(0)));
  };
  av.onwrite = (name, pos, data) => {
    const out = sinks.get(name);
    if (out) out.push(data.slice(0));
  };
}

// ---------------------------------------------------------------------------------------------
// Decode order
// ---------------------------------------------------------------------------------------------

/** How far reordering is ever allowed to reach. FFmpeg's own limit, and past it something is wrong
 *  with the file rather than deep. 重排最多允许够到多远。ffmpeg 自己的上限;
 *  越过它,说明这个文件有毛病,而不是它排得深。 */
const MAX_REACH = 16;

/**
 * Decode times for a container that does not carry them.
 *
 * MP4 wants both a presentation time and a decode time for every packet. Containers supply one or
 * the other, and which one depends on the container rather than on the film:
 *
 *   Matroska stores presentation times and no decode times. The pictures arrive reordered, because
 *   that is what a B-frame is, and the decode order has to be worked out.
 *
 *   AVI stores decode times and no presentation times, and carries no reordering information at
 *   all. There is nothing to work out, and nothing here tries: handed a packet with no presentation
 *   time the muxer fills it in from the decode time, which is exactly what ffmpeg itself writes
 *   copying an AVI into an MP4 -- frame for frame and timestamp for timestamp.
 *
 * The Matroska case is this: decode order is display order delayed by however far the reordering
 * reaches, so hold the last `reach + 1` presentation times and the oldest of them is the decode
 * time of the packet that arrived `reach` ago. It used to be done by sorting every timestamp in the
 * file, which gives the same numbers and needs the last packet before the first one can be written.
 * A window gives them without seeing the future, which is the difference between this playing once
 * the whole file has been converted and it playing now.
 *
 * How far the reordering reaches is measured over the opening and then left to correct itself: a
 * presentation time that turns up below one already handed out means the window was too short, so
 * it grows by one and that packet waits a turn. Growing costs one held frame; being wrong costs the
 * packet, because a muxer handed a decode time it cannot use drops it -- silently, still producing
 * a file that plays. Sixteen of seventy-five pictures went that way once.
 *
 * 为一种不携带解码时间的容器推出解码时间。
 *
 * MP4 要求每个包同时有呈现时间和解码时间。容器只给其中一个,而给哪一个取决于容器,与这部片子无关:
 *
 *   Matroska 存呈现时间,不存解码时间。画面是乱序到达的 —— B 帧就是这么回事 —— 解码顺序必须推出来。
 *
 *   AVI 存解码时间,不存呈现时间,而且完全不带重排信息。这里没有什么可推的,也不去推:
 *   收到一个没有呈现时间的包时,muxer 会拿解码时间把它补上 ——
 *   而那正是 ffmpeg 自己把 AVI 拷进 MP4 时写下的东西,逐帧一致,时间戳也一致。
 *
 * Matroska 那一种是这样:解码顺序就是显示顺序按"重排能够到多远"往后延,
 * 于是留住最近的 `reach + 1` 个呈现时间,其中最老的那个,就是 `reach` 个之前那个包的解码时间。
 * 过去这件事是靠把文件里每一个时间戳排序做的 —— 数字一样,但要等到最后一个包,第一个包才写得出去。
 * 一个窗口不必看见未来就能给出同样的数字,而这正是"整个文件转换完才播"与"现在就播"之间的差别。
 *
 * 重排能够到多远,在开头量一次,之后交给它自我修正:若冒出一个比已经发出去的还早的呈现时间,
 * 说明窗口太短,于是它长一格,那个包等一轮。长一格的代价是多扣住一帧;
 * 而弄错的代价是丢掉那个包 —— muxer 收到一个它用不了的解码时间就会丢,静默地丢,
 * 而且照样产出一个能播的文件。曾经就这样走掉了七十五帧里的十六帧。
 */
function reorder(from) {
  const win = [];
  const held = [];
  let reach = from || 0;
  let gap = 1;
  let last = null;
  return {
    /** How far it is reaching now. Worth carrying across a jump: a film does not change how deeply
     *  it reorders because somebody scrubbed it, and two seconds measured out of the middle is a
     *  worse answer than one already arrived at.
     *  它现在够到多远。这个值值得带过一次跳转:一部片子不会因为有人拖动它就改变它重排得多深,
     *  而"从中间量出来的两秒钟",是一个比"已经得到的答案"更差的答案。 */
    get reach() { return reach; },
    /** Measured over the opening, before anything is written. 在写出任何东西之前,从开头量出来。 */
    measure(seq) {
      const sorted = [...seq].sort((x, y) => x - y);
      const place = new Map(sorted.map((v, i) => [v, i]));
      seq.forEach((v, i) => { reach = Math.max(reach, place.get(v) - i); });
      if (sorted.length > 1) gap = (sorted[sorted.length - 1] - sorted[0]) / (sorted.length - 1) || 1;
    },
    /** One packet in; nothing, or that packet and anything that was waiting on it, out.
     *  进去一个包;出来的是"什么都没有",或者那个包连同一直等着它的那些。 */
    push(p, pts) {
      let at = win.length;
      while (at > 0 && win[at - 1] > pts) at--;
      win.splice(at, 0, pts);
      if (win.length <= reach) { held.push(p); return []; }
      if (last !== null && win[0] <= last && reach < MAX_REACH) { reach++; held.push(p); return []; }
      const before = last;
      const v = win.shift();
      const out = [];
      if (held.length) {
        // At the very start there is nothing to borrow a time from, so the gap between pictures is
        // extended backwards to reach the ones decoded before anything is shown. Later on -- which
        // only happens when the window has grown -- the held ones are spaced between the last time
        // handed out and this one, because there they have neighbours on both sides.
        // 一开始没有时间可借,于是把帧间距往回延,去够到那些"在任何显示之前就被解码"的帧。
        // 之后(只在窗口长过之后才会发生)被扣住的那些,排在"上一个发出去的时间"与这一个之间 ——
        // 因为在那里它们两侧都有邻居。
        const n = held.length;
        held.forEach((h, i) => out.push({
          p: h,
          dts: before === null ? v - (n - i) * gap : before + ((v - before) * (i + 1)) / (n + 1),
        }));
        held.length = 0;
      }
      last = v;
      out.push({ p, dts: v });
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The sound
// ---------------------------------------------------------------------------------------------

/**
 * Decode a sound track this build understands and re-encode it as one the browser does, a piece at
 * a time.
 *
 * The filter graph is built from the frames rather than from the stream header, because the header
 * is what the file claims and the frames are what came out. For a codec that only settles its
 * layout once decoding starts -- which several do -- asking the header gives a graph configured for
 * something the frames are not. That is also why the muxer cannot open until some sound has been
 * through here: what the new track is cannot be described until it exists.
 *
 * Nothing here touches the picture. This is the sound only, and it is the one part of the
 * conversion that is not a copy: everything else in this file moves bytes between boxes.
 *
 * 把一条这份构建懂的音轨解出来,再编码成浏览器懂的那一种 —— 一块一块地做。
 *
 * 滤镜图是照着帧建的,不是照着流头建的 —— 因为流头是这个文件的说法,而帧是实际出来的东西。
 * 对于那些"开始解码之后才定下声道布局"的编码(有好几种如此),照流头去问,
 * 建出来的图配置的是帧并不具备的那种东西。这也正是为什么在有声音经过这里之前 muxer 打不开:
 * 新的那条轨是什么,在它存在之前无从描述。
 *
 * 这里不碰画面。这里只有声音,而它是整次转换中唯一不是拷贝的部分:
 * 这个文件里其余的一切,只是把字节从一个盒子搬到另一个盒子。
 */
function sound(av, track) {
  let dc = 0; let dpkt = 0; let dframe = 0;
  let ec = 0; let eframe = 0; let epkt = 0;
  let graph = 0; let src = 0; let sink = 0;
  let par = 0;
  let at = null;
  return {
    get par() { return par; },
    async take(packets, last) {
      if (!dc) [, dc, dpkt, dframe] = await av.ff_init_decoder(track.s.codec_id, track.s.codecpar);
      // Where this track begins, counted in the samples it is about to become. Taken from the
      // packet rather than from a decoded frame, because a packet's time is stated in the file and
      // a frame's is whatever the decoder made of it.
      // 这条轨从哪里开始,按它即将变成的那些采样来计。取自包而不是取自解出来的帧 ——
      // 因为包的时间是文件里写着的,而帧的时间是解码器自己弄出来的东西。
      if (at === null && packets.length) {
        const p = packets[0];
        const tick = told(p.ptshi) ? av.i64tof64(p.pts, p.ptshi) : av.i64tof64(p.dts, p.dtshi);
        const secs = (tick * (track.s.time_base_num || 1)) / (track.s.time_base_den || 1);
        at = Math.max(0, Math.round(secs * AAC_RATE));
      }
      const raw = await av.ff_decode_multi(dc, dpkt, dframe, packets, !!last);
      if (!raw.length && !ec) return [];
      if (!ec) {
        const first = raw[0];
        [, ec, eframe, epkt] = await av.ff_init_encoder('aac', {
          ctx: {
            bit_rate: AAC_BITS,
            sample_rate: AAC_RATE,
            sample_fmt: av.AV_SAMPLE_FMT_FLTP,
            channel_layout: AV_CH_STEREO,
          },
          // Counted in samples, like the stream it is about to be written into. Left alone the
          // encoder counts in milliseconds, and a track whose packets are stated in one unit and
          // written into a stream measured in another is a track that plays at the wrong speed.
          // 以采样计,和它即将被写进去的那条流一样。放着不管的话编码器按毫秒计 ——
          // 而一条"包用一种单位陈述、却被写进以另一种单位计量的流"的轨,是一条会放错速度的轨。
          time_base: [1, AAC_RATE],
        });
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
          frame_size: await av.AVCodecContext_frame_size(ec),
        });
        // The muxer is given parameters, not a context: a context belongs to the encoder and dies
        // with it, and these have to outlive it by exactly as long as the writing takes.
        // 交给 muxer 的是参数而不是上下文:上下文属于编码器、与它同生共死,
        // 而这些参数必须比它多活恰好"写完"那么久。
        par = await av.avcodec_parameters_alloc();
        await av.avcodec_parameters_from_context(par, ec);
      }
      // What comes out of the filter is a contiguous run of frames of one fixed length, so where
      // each one sits is a matter of counting rather than of asking. Asking gets the times the
      // decoder put on its frames, and those are stated in the file's own unit while the samples
      // they carry are at the rate the sound is played at -- the two agree for some codecs and not
      // for others, and where they do not, the times fall behind the samples until two frames land
      // on the same instant and the muxer drops one of them. Counting cannot drift.
      // 从滤镜出来的是一连串长度固定、首尾相接的帧,所以每一帧坐在哪里,是数出来的事,不是问出来的事。
      // 问,得到的是解码器给它的帧打上的时间,而那些时间是以文件自己的单位陈述的,
      // 它们所携带的采样却是按这段声音被播放的速率来的 —— 两者对某些编码一致、对另一些不一致;
      // 而不一致的地方,时间会一点点落在采样后面,直到两帧落在同一刻上,muxer 丢掉其中一个。
      // 数出来的东西不会漂。
      const even = await av.ff_filter_multi(src, sink, dframe, raw, !!last);
      const timed = even.map((f) => {
        const [pts, ptshi] = av.f64toi64(at);
        at += f.nb_samples;
        return { ...f, pts, ptshi };
      });
      return av.ff_encode_multi(ec, eframe, epkt, timed, !!last);
    },
    async close() {
      // Emptied before it is let go of, and what comes out is dropped. There is always a frame or
      // two still inside -- an encoder works a little behind what it is fed -- and freeing it with
      // them in there is a thing it says out loud, which would then be one more line to read past
      // every time something worth reading did appear.
      // 放手之前先把它腾空,而腾出来的东西丢掉。里面总还剩着一两帧 ——
      // 编码器干活总比喂给它的东西慢一点 —— 而带着它们释放,是一件它会出声说出来的事;
      // 那样此后每次真有值得一读的东西出现时,都要多读过一行。
      if (ec) await av.ff_encode_multi(ec, eframe, epkt, [], true).catch(() => {});
      if (graph) await av.avfilter_graph_free_js(graph).catch(() => {});
      if (ec) await av.ff_free_encoder(ec, eframe, epkt).catch(() => {});
      if (dc) await av.ff_free_decoder(dc, dpkt, dframe).catch(() => {});
      graph = 0; ec = 0; dc = 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Telling the browser what it is about to be handed
// ---------------------------------------------------------------------------------------------

/** Walk the boxes of an MP4 between two offsets. Every box is a length, a four-letter name, and its
 *  contents; the two lengths that mean something else are the only special cases.
 *  在两个偏移之间走一遍 MP4 的盒子。每个盒子都是"一个长度、一个四字母名字、它的内容";
 *  只有那两个另有含义的长度值是特例。 */
function* boxes(b, from, to) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = from;
  while (at + 8 <= to) {
    let len = view.getUint32(at);
    let head = 8;
    if (len === 1) { if (at + 16 > to) return; len = Number(view.getBigUint64(at + 8)); head = 16; }
    else if (len === 0) len = to - at;
    if (len < head || at + len > to) return;
    yield {
      type: String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]),
      body: at + head,
      end: at + len,
    };
    at += len;
  }
}

/** Follow a path of box names down from one box. 从一个盒子出发,沿一串盒子名字往下走。 */
function dig(b, box, path) {
  let here = box;
  for (const want of path) {
    let found = null;
    for (const x of boxes(b, here.body, here.end)) if (x.type === want) { found = x; break; }
    if (!found) return null;
    here = found;
  }
  return here;
}

const hex2 = (n) => (n & 255).toString(16).padStart(2, '0');
const dec2 = (n) => String(n).padStart(2, '0');

/**
 * The names the browser wants for what is in the stream.
 *
 * MediaSource will not take a byte until it has been told, and it wants the exact profile and level
 * rather than the family -- `avc1.640028`, not `avc1`. Those digits live in the configuration box
 * the muxer just wrote, so the answer is read back out of the header rather than worked out from
 * the source: they are then the same bytes the browser is about to parse, which is a stronger thing
 * to be right about than a guess from the input file. An AVI, for one, can carry H.264 in a shape
 * where those bytes are not there at all until the muxer has rewritten them.
 *
 * 浏览器想知道这条流里装的东西叫什么。
 *
 * MediaSource 在被告知之前一个字节都不收,而且它要的是确切的 profile 和 level,不是那个大类 ——
 * 是 `avc1.640028`,不是 `avc1`。那几位数字就在 muxer 刚写下的那个配置盒子里,
 * 所以答案是从那个头里读回来的,而不是从源文件推出来的:这样它们就是浏览器马上要解析的同一批字节 ——
 * 而"在这件事上是对的",比"从输入文件猜对了"要强。举一个例子:AVI 可以用一种形状装 H.264,
 * 在 muxer 把它改写之前,那几个字节根本就不在那儿。
 */
export function codecsOf(init) {
  const out = [];
  for (const moov of boxes(init, 0, init.length)) {
    if (moov.type !== 'moov') continue;
    for (const trak of boxes(init, moov.body, moov.end)) {
      if (trak.type !== 'trak') continue;
      const hdlr = dig(init, trak, ['mdia', 'hdlr']);
      const kind = hdlr && hdlr.body + 12 <= hdlr.end
        ? String.fromCharCode(init[hdlr.body + 8], init[hdlr.body + 9], init[hdlr.body + 10], init[hdlr.body + 11])
        : '';
      const stsd = dig(init, trak, ['mdia', 'minf', 'stbl', 'stsd']);
      if (!stsd) continue;
      // A sample entry is a box whose contents open with a fixed run of fields nobody here needs;
      // what is wanted is the configuration box after them, and how far after depends on whether
      // this is a picture or a sound.
      // 一个 sample entry 是这样一个盒子:它的内容以一串这里谁都不需要的固定字段开头;
      // 要找的是它们后面的那个配置盒子,而"后面多远"取决于这是画面还是声音。
      for (const entry of boxes(init, stsd.body + 8, stsd.end)) {
        out.push(codecOf(init, entry, kind === 'soun' ? 28 : 78));
        break;
      }
    }
  }
  return out;
}

function codecOf(init, entry, skip) {
  const four = entry.type;
  const from = entry.body + skip;
  const cfg = (want) => {
    for (const x of boxes(init, from, entry.end)) if (x.type === want) return init.subarray(x.body, x.end);
    return null;
  };

  if (four === 'avc1' || four === 'avc3') {
    const c = cfg('avcC');
    // Profile, the constraint flags, and level, in that order, straight out of the record.
    // profile、约束标志、level,按这个顺序,直接取自那条记录。
    return c && c.length > 3 ? `${four}.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}` : four;
  }
  if (four === 'hvc1' || four === 'hev1') {
    const c = cfg('hvcC');
    if (!c || c.length < 13) return four;
    const space = (c[1] >> 6) & 3;
    const tier = (c[1] >> 5) & 1;
    const profile = c[1] & 31;
    // The compatibility flags are stored most significant bit first and named the other way round,
    // so the thirty-two bits are reversed before they are printed.
    // 兼容标志是按最高位在前存的,而它被叫出来时顺序正相反,所以那三十二位在打印之前先翻转。
    let bits = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0;
    let rev = 0;
    for (let i = 0; i < 32; i++) { rev = ((rev << 1) | (bits & 1)) >>> 0; bits >>>= 1; }
    const cons = [...c.subarray(6, 12)];
    while (cons.length && !cons[cons.length - 1]) cons.pop();
    return [
      four,
      (space ? String.fromCharCode(64 + space) : '') + profile,
      rev.toString(16),
      (tier ? 'H' : 'L') + c[12],
      ...cons.map(hex2),
    ].join('.');
  }
  if (four === 'vp08' || four === 'vp09') {
    const c = cfg('vpcC');
    return c && c.length >= 7 ? `${four}.${dec2(c[4])}.${dec2(c[5])}.${dec2(c[6] >> 4)}` : four;
  }
  if (four === 'av01') {
    const c = cfg('av1C');
    if (!c || c.length < 3) return four;
    const tier = (c[2] >> 7) & 1;
    const depth = ((c[2] >> 6) & 1) ? (((c[2] >> 5) & 1) ? 12 : 10) : 8;
    return `${four}.${(c[1] >> 5) & 7}.${dec2(c[1] & 31)}${tier ? 'H' : 'M'}.${dec2(depth)}`;
  }
  if (four === 'mp4a') {
    const c = cfg('esds');
    const d = c && c.length > 4 && descriptors(c.subarray(4));
    if (!d) return 'mp4a.40.2';
    // An AAC track says which kind of AAC it is in the first five bits of its own configuration;
    // everything else says it in the one byte that names the encoding.
    // 一条 AAC 轨用它自己那份配置的头五位说明它是哪一种 AAC;
    // 其余的东西,用那个"给编码起名字"的字节说明。
    return d.object === 0x40 && d.config?.length
      ? `mp4a.40.${(d.config[0] >> 3) || 2}`
      : `mp4a.${d.object.toString(16)}`;
  }
  return four;
}

/** The one thing inside an esds worth reading: which encoding, and its own private configuration.
 *  Lengths there are seven bits at a time, with the eighth saying "there is more".
 *  esds 里唯一值得读的东西:是哪种编码,以及它自己那份私有配置。
 *  那里的长度是每次七位,第八位表示"后面还有"。 */
function descriptors(b) {
  let at = 0;
  const len = () => {
    let n = 0;
    for (let i = 0; i < 4 && at < b.length; i++) {
      const x = b[at++];
      n = (n << 7) | (x & 127);
      if (!(x & 128)) break;
    }
    return n;
  };
  let object = 0;
  let config = null;
  while (at + 2 <= b.length) {
    const tag = b[at++];
    const n = len();
    const to = Math.min(b.length, at + n);
    if (tag === 3) { at += 3; continue; }                    // the stream: step over its id and flags
    if (tag === 4) { object = b[at]; at += 13; continue; }    // which encoding, then sizes and rates
    if (tag === 5) { config = b.subarray(at, to); break; }    // the encoding's own configuration
    at = to;
  }
  return object || config ? { object, config } : null;
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------

/** How much of the source one turn of the handle reads. Small enough that the first piece comes out
 *  quickly, large enough that a film is not a hundred thousand turns.
 *  摇一圈把手,从源里读多少。小到第一块很快就出来,大到一部片子不至于要摇十万圈。 */
const ROUND = 1024 * 1024;
/** How many pictures the opening is measured over before anything is written.
 *
 *  Every one of them is a picture read before anything plays, so this is the wait at the start and
 *  it wants to be small. Two seconds is well past enough to see how far a reordering reaches --
 *  three frames is deep, sixteen is the most ffmpeg will allow -- and the window grows on its own
 *  if a later stretch of the film reaches further.
 *
 *  在写出任何东西之前,拿开头的多少帧来量。
 *
 *  它们每一帧都是"播放开始之前就得先读的画面",所以这就是开头那段等待,而它该短。
 *  两秒钟远远够看出重排够到多远了 —— 三帧就算深,十六是 ffmpeg 允许的上限 ——
 *  而万一片子后面某一段够得更远,那个窗口会自己长。 */
const OPENING = 48;

/** How much film a piece holds at most, in milliseconds. It is what the player waits for at the
 *  start and after every jump, and what it holds in memory ahead of itself, so it wants to be
 *  short -- and there is no cost to it being short beyond a few dozen bytes of box per piece.
 *  一块最多装多少片长,毫秒。它是播放器在开头、以及每次跳转之后所等的东西,
 *  也是它提前攥在内存里的东西,所以它该短 —— 而短的代价,不过是每块几十个字节的盒子头。 */
const PIECE = 2000;

let serial = 0;

/**
 * Open a film and hand it over a piece at a time.
 *
 * `pull` gives back the next stretch of MP4, or null when there is no more. Nothing is produced
 * until it is asked for, which is what keeps a two-hour film from converting itself into memory
 * while somebody watches the first minute of it.
 *
 * `seek` moves the read head and starts a new stretch: what comes back from the next `pull` begins
 * with a fresh header, because a decoder that has been jumped is not continuing anything.
 *
 * 打开一部片子,一块一块交出去。
 *
 * `pull` 交回下一段 MP4,没有了就是 null。不被要就什么都不产出 ——
 * 而正是这一点,使得一部两小时的片子不会在别人看头一分钟的时候,把自己整个转换进内存。
 *
 * `seek` 移动读取位置,并开启新的一段:下一次 `pull` 交回的东西以一个新的头开始,
 * 因为一个被跳过的解码器,并不是在接着任何东西往下走。
 */
export async function stream(source, { seconds = 0, limit = 0 } = {}) {
  const av = await libav();
  route(av);
  const inName = `in-${++serial}.dat`;
  const outName = `${inName}.mp4`;
  const bytes = bytesOf(source);
  sources.set(inName, bytes);

  let ctx = 0;
  let pkt = 0;
  let wpkt = 0;
  let oc = 0;
  let pb = 0;
  let snd = null;
  let shut = false;

  const drop = async () => {
    sources.delete(inName);
    sinks.delete(outName);
    if (oc) await av.ff_free_muxer(oc, pb).catch(() => {});
    if (wpkt) await av.av_packet_free_js(wpkt).catch(() => {});
    if (pkt) await av.av_packet_free_js(pkt).catch(() => {});
    if (snd) await snd.close().catch(() => {});
    if (ctx) await av.avformat_close_input_js(ctx).catch(() => {});
    await av.unlink(inName).catch(() => {});
    await av.unlink(outName).catch(() => {});
  };

  try {
    await av.mkblockreaderdev(inName, bytes.size);
    let streams;
    [ctx, streams] = await av.ff_init_demuxer_file(inName);
    if (!streams.length) throw new Error('e_drive_no_streams');
    const kept = await choose(av, streams);
    let silent = kept.silent;

    const vid = kept.take.find((k) => k.s.codec_type === AV_VIDEO).s;
    const tb = vid.time_base_den / (vid.time_base_num || 1);
    const renumber = new Map(kept.take.map((k, i) => [k.s.index, i]));
    const madeAt = kept.convert ? kept.take.length : -1;
    const stop = seconds > 0 ? seconds * tb : 0;

    pkt = await av.av_packet_alloc();
    wpkt = await av.av_packet_alloc();

    let eof = false;
    const round = async () => {
      if (eof) return [];
      const [res, by] = await av.ff_read_frame_multi(ctx, pkt, { unify: true, limit: ROUND });
      if (res === AVERROR_EOF || (res < 0 && !paused(res))) eof = true;
      return by[0] || [];
    };

    // ---- the working half ----
    //
    // Everything from here down is set up, torn down and set up again, because that is what a seek
    // is. The demuxer survives it -- it is the file, and the file has not changed -- but the muxer
    // cannot: it has been writing an increasing sequence of decode times, and a jump backwards
    // hands it one that is smaller than the last, which it answers by dropping the packet. So a
    // jump builds a new one, and what comes out of it opens with a new header. A MediaSource takes
    // a header in the middle of a stream the same way it takes the first.
    //
    // The sound is rebuilt with it. An encoder that was fed a film up to minute twelve and is then
    // fed minute forty has to be told so somehow, and starting again is both the cheapest way to
    // say it and the only one that cannot be subtly wrong.
    //
    // ---- 干活的那一半 ----
    //
    // 从这里往下的一切都会被搭起来、拆掉、再搭起来 —— 因为定位就是这么回事。
    // 解复用器熬得过去(它就是那个文件,而文件没变),muxer 熬不过去:
    // 它一直在写一串递增的解码时间,而一次往回跳会递给它一个比上一个更小的,
    // 它对此的回应是把那个包丢掉。所以一次跳转会建一个新的,而从它出来的东西以一个新的头开场。
    // MediaSource 在流中间收下一个头,与它收下第一个头的方式是一样的。
    //
    // 声音跟着一起重建。一个刚被喂到第十二分钟、接着被喂第四十分钟的编码器,
    // 总得有人告诉它这件事;而重新开始,既是说这句话最便宜的方式,也是唯一不会微妙地出错的方式。
    let snd = null;
    let order = null;
    let reached = 0;
    let began = 0;
    let busy = null;
    let codecs = [];
    let queue = [];
    let lastDts = null;
    let done = false;

    const out = [];
    sinks.set(outName, out);
    // Made once and reopened, not made again: a device that already exists cannot be created a
    // second time, and a seek would otherwise try to. Nothing about it needs resetting, because
    // where a write lands is never looked at -- the pieces go out in the order they are produced.
    // 造一次、之后重开,而不是再造一次:一个已经存在的设备没法被创建第二次,
    // 而定位若不这样就会去创建它。它身上也没有什么需要重置的,因为"一次写落在哪里"从来没人看 ——
    // 各块是按产出的顺序出去的。
    await av.mkstreamwriterdev(outName);

    /** Whatever the muxer produced since the last look, as one piece.
     *  自上次查看以来 muxer 产出的东西,合成一块。 */
    const taken = () => {
      if (!out.length) return null;
      const piece = join(out);
      out.length = 0;
      return piece;
    };

    const disarm = async () => {
      // Whatever it ended up reaching, including anything it worked out for itself after the
      // opening, is what the next one starts from.
      // 它最终够到了多远 —— 包括开头之后它自己想明白的那些 —— 就是下一个的起点。
      if (order) reached = Math.max(reached, order.reach);
      if (oc) await av.ff_free_muxer(oc, pb).catch(() => {});
      if (snd) await snd.close().catch(() => {});
      oc = 0; pb = 0; snd = null;
      out.length = 0;
      lastDts = null;
      done = false;
    };

    const write = async (raw, made, last) => {
      let extra = made;
      if (!extra && snd) {
        const heard = raw.filter((p) => p.stream_index === kept.convert.s.index);
        extra = (heard.length || last) ? await snd.take(heard, last).catch(() => []) : [];
      }
      const list = [];
      const add = (p, dts) => {
        const q = { ...p, stream_index: renumber.get(p.stream_index) };
        // A packet with no presentation time is shown when it is decoded. The muxer works that out
        // for itself and writes the same thing, but it says so once per packet and calls it
        // deprecated, and a hundred and ninety lines of that would bury a complaint worth reading.
        // 一个没有呈现时间的包,在它被解码的那一刻显示。muxer 自己也能推出这一点、写出来的东西一样,
        // 但它每个包说一次、还管这叫已废弃 —— 而一百九十行那种东西,
        // 会把真正值得一读的抱怨埋掉。
        if (!told(q.ptshi)) { q.pts = q.dts; q.ptshi = q.dtshi; }
        if (dts === undefined) { list.push(q); return; }
        // Rounding two reconstructed times onto the same tick would make the muxer drop one of
        // them, so the sequence is pushed apart rather than allowed to collide.
        // 两个推算出来的时间若四舍五入到同一刻,muxer 会丢掉其中一个 ——
        // 所以这里把序列推开,而不是任由它们撞上。
        let v = Math.round(dts);
        // Nothing is shown before it is decoded. The window can reach past what it was measured
        // over -- most easily just after a jump, where the opening it measured is a couple of
        // seconds out of the middle of a film -- and a picture whose own presentation time turns
        // out to be earlier than the time worked out for decoding it is that, stated.
        // 没有东西会在被解码之前显示。那个窗口有可能够到它所量的范围之外 ——
        // 最容易发生在一次跳转之后,因为它量的"开头"是从片子中间取的两秒钟 ——
        // 而一帧"自己的呈现时间竟早于为它算出的解码时间",说的就是这件事。
        if (told(q.ptshi)) v = Math.min(v, av.i64tof64(q.pts, q.ptshi));
        if (lastDts !== null && v <= lastDts) v = lastDts + 1;
        lastDts = v;
        const [lo, hi] = av.f64toi64(v);
        list.push({ ...q, dts: lo, dtshi: hi });
      };
      for (const p of raw) {
        if (!renumber.has(p.stream_index)) continue;
        if (p.stream_index !== vid.index || !told(p.ptshi)) { add(p); continue; }
        for (const r of order.push(p, av.i64tof64(p.pts, p.ptshi))) add(r.p, r.dts);
      }
      for (const p of extra || []) list.push({ ...p, stream_index: madeAt });
      // Interleaved, so the muxer orders the picture and the sound against each other. A fragment
      // is cut at a keyframe and has to carry the sound that belongs with it; handed the two
      // separately it would carry a film and then, much later, its soundtrack.
      // 交错写,好让 muxer 把画面与声音相互排序。一块分片是在关键帧处切开的,
      // 它必须带着与之相配的那段声音;若把两者分开递进去,它会先带走一部片子,
      // 然后在很久以后,再带走它的原声。
      if (list.length) await av.ff_write_multi(oc, wpkt, list, true);
      // Nothing has really been handed over until it has left the buffer libav writes through. It
      // holds about thirty kilobytes, which for a whole-file conversion is a detail and here is the
      // difference between the player having something and the player waiting.
      // 在东西离开 libav 写入所经的那个缓冲区之前,并没有真的交出去什么。
      // 那个缓冲区装大约三十千字节 —— 对整份文件的转换来说这是个细节,
      // 而在这里,它是"播放器手上有东西"与"播放器在等"之间的差别。
      await av.avio_flush(pb);
      const piece = taken();
      if (piece) queue.push(piece);
    };

    /** Trim a round to the opening, when only the opening was asked for.
     *  若要的只是开头,就在那里把一轮剪断。 */
    // A picture past the point asked for ends the film as far as anything here is concerned. Only
    // filtering them out would leave the reading to run to the end of a two-hour file to produce
    // twelve seconds of it.
    // 一帧越过了所要的那个点,对这里的一切来说,片子就到此为止。只是把它们滤掉的话,
    // 读取会一路跑到一个两小时文件的结尾,只为产出它的十二秒。
    const when = (p) => (told(p.ptshi) ? av.i64tof64(p.pts, p.ptshi) : av.i64tof64(p.dts, p.dtshi));
    const trim = (raw) => {
      if (!stop) return raw;
      const cut = raw.filter((p) => p.stream_index !== vid.index || when(p) <= stop);
      if (cut.length < raw.length) eof = true;
      return cut;
    };

    /**
     * Read the opening, then open the box.
     *
     * Two questions have to be answered before the first byte can be written: how far the pictures
     * are reordered, and -- when the sound is being remade -- what the remade track is, which
     * cannot be described until some of it exists. Both are answered by reading, so what was read
     * while finding out is kept alongside the sound that came out of it, and written once the box
     * is open. Decoding it a second time instead would hand the encoder the same seconds twice, and
     * an encoder handed the same seconds twice produces timestamps that go backwards, which the
     * muxer answers by dropping nearly all of them.
     *
     * 先读开头,再打开盒子。
     *
     * 有两个问题必须在第一个字节写出去之前有答案:画面被重排到多远;以及,当声音正在被重做时,
     * 重做出来的那条轨是什么(而它在有一部分存在之前无从描述)。两个问题都靠读来回答,
     * 所以为了弄清而读进来的东西,连同由它产出的声音一起留着,等盒子打开之后再写。
     * 若改成再解码一遍,就等于把同样的几秒钟递给编码器两次 ——
     * 而一个被递了同样几秒钟两次的编码器,产出的时间戳会往回走,muxer 对此的回应是几乎全部丢掉。
     */
    const arm = async () => {
      if (kept.convert) snd = sound(av, kept.convert);
      const opening = [];
      const early = [];
      let seen = 0;
      while (!eof && (seen < OPENING || (snd && !snd.par))) {
        const raw = trim(await round());
        if (!raw.length) break;
        for (const p of raw) if (p.stream_index === vid.index) { seen++; early.push(p); }
        let made = null;
        if (snd) {
          const heard = raw.filter((p) => p.stream_index === kept.convert.s.index);
          made = heard.length ? await snd.take(heard, false).catch(() => []) : [];
        }
        opening.push({ raw, made });
      }
      if (snd && !snd.par) {
        // It could not be remade. The film is still the film, and naming the codec that was left
        // behind is better than a silent video with no explanation.
        // 它重做不出来。片子还是那部片子,而说出被留下的是哪一种编码,
        // 好过一段没有解释的无声视频。
        await snd.close().catch(() => {});
        snd = null;
        silent = kept.convert.name;
      }

      // Where this stretch belongs in the film. A muxer states a fragment's time relative to the
      // first thing it was given, so every stretch after a jump calls itself zero -- correct
      // within itself, and forty minutes wrong to anyone assembling them into one timeline. What
      // that zero really was is the earliest picture in the stretch, and it is worked out here
      // because after this the packets have been handed over and the answer is gone.
      // 这一段在整部片子里该坐在哪里。muxer 陈述一块分片的时间时,是相对它最先收到的东西说的,
      // 于是每一段跳转之后的片段都管自己叫零 —— 在它自己内部是对的,
      // 而对一个要把它们拼成同一条时间轴的人来说,错了四十分钟。
      // 那个零真正是什么,就是这一段里最早的那一帧画面;在这里算,是因为再往后,
      // 包已经递出去了,答案也就没了。
      began = early.length ? Math.min(...early.map((p) => when(p))) / tb : 0;

      order = reorder(reached);
      if (early.length && early.every((p) => told(p.ptshi))) {
        order.measure(early.map((p) => av.i64tof64(p.pts, p.ptshi)));
      }
      reached = order.reach;

      [oc, , pb] = await av.ff_init_muxer(
        { filename: outName, format_name: 'mp4', open: true, codecpars: true },
        [
          ...kept.take.map((k) => [k.s.codecpar, k.s.time_base_num, k.s.time_base_den]),
          ...(snd ? [[snd.par, 1, AAC_RATE]] : []),
        ]);
      // A fragmented MP4, asked for by the three names that make it one: a header that promises
      // nothing, a new piece at every keyframe, and pieces that carry their own offsets so each can
      // be read without the ones before it. The third is called default_base_moof -- the longer
      // spelling is the sentence ffmpeg uses to describe it, and asking by that name is refused
      // exactly like asking for a word that does not exist. Which is why the answer is read: a
      // refused option is silent, and the first packet then divides by a timescale of zero
      // somewhere far away from the mistake.
      // 一个分片 MP4,由使它成为分片的那三个名字点名要来:一个什么都不承诺的头、
      // 每个关键帧起一块新的、以及每块自带偏移量因而不必依赖它前面的那些就能读。
      // 第三个叫 default_base_moof —— 那个更长的拼法是 ffmpeg 用来描述它的句子,
      // 拿那个当名字去要,被拒的方式和要一个根本不存在的词一模一样。这也正是这里要读返回值的原因:
      // 被拒的选项不出声,而随后第一个包会在离错误很远的地方,除以一个为零的时间刻度。
      if (await av.av_opt_set(oc, 'movflags', 'frag_keyframe+empty_moov+delay_moov+default_base_moof', 1) < 0) {
        throw new Error('e_drive_remux_failed');
      }
      // And a piece is at most this long, however far apart the keyframes are. Left to keyframes
      // alone a piece is a whole keyframe interval -- eight seconds and seven megabytes on the
      // disc rip here, and it is the unit in which everything happens: nothing is handed over, and
      // nothing can be waited on, until a piece is finished.
      // 而且一块最长就这么长,无论关键帧隔得多远。只交给关键帧去定,一块就是一整个关键帧间隔 ——
      // 在这里这份碟版片源上是八秒钟、七兆字节 —— 而它是一切发生的单位:
      // 在一块完成之前,没有东西交得出去,也没有东西等得到。
      await av.av_opt_set(oc, 'frag_duration', String(PIECE * 1000), 1);
      if (await av.avformat_write_header(oc) < 0) throw new Error('e_drive_remux_failed');
      await av.avio_flush(pb);

      // The header comes out once the first piece of film has been written, not when the muxer
      // opens, and that is asked for on purpose. Written at once it would describe each track as
      // starting at that track's own first decode time -- and a picture that was reordered is
      // decoded before it is shown, so its track would begin a few frames after the sound and the
      // film would play out of step with itself for its whole length. Left until the first piece
      // is closed, the header can say where each track really begins, and the two agree. It costs
      // one piece of film at the start, which is the wait already being spent measuring the
      // opening.
      // 头是在第一块片子写出去之后才出来的,不是在 muxer 打开的时候 —— 而且这是有意要它这样。
      // 若当场就写,它会把每条轨说成"从该轨自己的第一个解码时间开始";
      // 而一帧被重排过的画面,是在它被显示之前就被解码的,于是它那条轨会比声音晚开始几帧,
      // 这部片子会在它整个长度上与自己不同步。等到第一块封口再写,头就能说出每条轨真正从哪里开始,
      // 两者于是一致。代价是开头的一块片子 —— 而那正是已经花在"量开头"上的那段等待。
      queue = [];
      for (const { raw, made } of opening) await write(raw, made, false);
      while (!eof && !codecsOf(join(queue)).length) await write(trim(await round()), null, false);
      let head = join(queue);
      if (!codecsOf(head).length) {
        // The film ran out before a piece closed. Closing the box writes everything still owed.
        // 片子在一块封口之前就没了。把盒子封上,会把所有还欠着的东西写出来。
        done = true;
        await write([], null, true);
        await av.av_write_trailer(oc).catch(() => {});
        await av.avio_flush(pb).catch(() => {});
        head = join(queue);
      }
      const named = codecsOf(head);
      if (!named.length) throw new Error('e_drive_remux_failed');
      queue = [head];
      if (!codecs.length) codecs = named;
    };

    await arm();
    const [lo, hi] = [await av.AVFormatContext_duration(ctx), await av.AVFormatContext_durationhi(ctx)];

    return {
      /** What the browser has to be told before it will take any of this.
       *  浏览器在收下这里任何东西之前,必须被告知的那句话。 */
      mime: `video/mp4; codecs="${codecs.join(',')}"`,
      /** How long the film is, in seconds, or zero when the file does not say. Asked of the file
       *  rather than counted, and in microseconds whatever the streams use.
       *  片长,秒;文件没说就是零。是问文件要的、不是数出来的;而且不管流用什么单位,它都是微秒。 */
      duration: told(hi) && (lo || hi) ? av.i64tof64(lo, hi) / 1e6 : 0,
      /** The codec of a sound track nothing here could remake, or nothing at all.
       *  一条这里重做不出来的音轨的编码名;没有就是空。 */
      get silent() { return silent; },
      /** How much of the source has actually been fetched. 实际取回来了多少源字节。 */
      get fetched() { return bytes.served; },
      /** Where the pieces coming out now belong, in seconds from the start of the film. Zero
       *  until somebody jumps; after that it is where they jumped to, because a fragment states
       *  its time relative to the stretch it is part of and knows nothing of the ones before it.
       *  现在出来的这些块,该坐在片子从头算起的第几秒。在有人跳转之前是零;
       *  此后就是他跳到的地方 —— 因为一块分片陈述的时间是相对它所属的那一段说的,
       *  而它对它前面的那些一无所知。 */
      get at() { return began; },
      async pull() {
        if (shut) return null;
        busy = (async () => {
        while (!queue.length) {
          if (done) return null;
          if (eof || (limit && bytes.served >= limit)) {
            // The last piece. Anything the sound encoder is still holding comes out here, and the
            // trailer closes the box -- which for a fragmented file is an index of the pieces, not
            // a rewrite of anything already handed over.
            // 最后一块。声音编码器还攥着的东西在这里出来,而 trailer 把盒子封上 ——
            // 对分片文件来说那是一份"各块在哪里"的索引,而不是对已交出去的东西的改写。
            done = true;
            await write([], null, true);
            await av.av_write_trailer(oc).catch(() => {});
            await av.avio_flush(pb).catch(() => {});
            const piece = taken();
            if (piece) queue.push(piece);
            continue;
          }
          await write(trim(await round()), null, false);
        }
        return queue.shift();
        })();
        try { return await busy; } finally { busy = null; }
      },
      /** Move to a time and start again from there. 移到某个时刻,从那里重新开始。 */
      async seek(at) {
        if (shut) return;
        busy = (async () => {
          await disarm();
          queue = [];
          eof = false;
          await av.avformat_seek_file_approx(ctx, vid.index, Math.round(at * tb), 0).catch(() => {});
          await arm();
        })();
        try { await busy; } finally { busy = null; }
      },
      async close() {
        if (shut) return;
        shut = true;
        // Whatever is in flight finishes first. Closing frees a demuxer, a muxer and the buffers
        // they are reading and writing through, and a piece of work still holding those does not
        // find out that they are gone -- it walks into the memory where they were. Somebody
        // clicking past a film while it converts is the ordinary way to arrive here.
        // 先让手上飞着的那一件事做完。关闭会释放一个解复用器、一个 muxer,
        // 以及它们正在读写所经的那些缓冲区;而一件仍攥着这些东西的活儿不会得知它们没了 ——
        // 它会一头走进它们曾经所在的那块内存。有人在一部片子还在转换时点到了下一个 ——
        // 这就是走到这里来的寻常方式。
        await busy?.catch(() => {});
        await drop();
      },
    };
  } catch (e) {
    await drop();
    throw e;
  }
}

function join(parts) {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return all;
}

/**
 * The whole of a film, or the opening of one, in memory.
 *
 * A thumbnail wants the first few seconds of a two-gigabyte file and nothing else, and it wants
 * them as something a <video> element can be pointed at and moved around in. That is what this is
 * for; playing a film does not come through here, because playing a film should not need the whole
 * of it in memory before it starts.
 *
 * 一部片子的全部,或者它的开头,放在内存里。
 *
 * 一张缩略图要的是一个两吉字节文件的头几秒、别的都不要,而且它要的形式是"能把一个 <video>
 * 指过去、还能在里面来回移动"的东西。这就是这个函数的用途;放片子不走这里 ——
 * 因为放一部片子不该在开始之前就把它整个搬进内存。
 */
export async function toMp4(file, { seconds = 0, limit = 0 } = {}) {
  const film = await stream(file, { seconds, limit });
  const parts = [];
  try {
    for (;;) {
      const piece = await film.pull();
      if (!piece) break;
      parts.push(piece);
    }
  } finally {
    await film.close();
  }
  if (!parts.reduce((a, p) => a + p.length, 0)) throw new Error('e_drive_remux_failed');
  // The sound that was left behind comes out with the film, because the person watching is about to
  // notice its absence and should be told why rather than left to wonder.
  // 被留下的那路声音随片子一起交出去,因为正在看的人马上就会察觉它不在,
  // 而他应该被告知原因,而不是被留在那儿猜。
  return { blob: new Blob(parts, { type: 'video/mp4' }), silent: film.silent };
}
