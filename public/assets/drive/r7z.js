// Ranged 7z reader. The listing costs three small reads: the 32-byte signature header (which
// points at the end header), the end header itself, and -- when that header is LZMA-packed,
// which 7z does by default -- its tiny packed stream. Extraction locates the solid block
// ("folder") holding the file and STREAMS its packed bytes through the resumable lzma.js
// machines in bounded chunks: input rolls in a few MB at a time, output drains out of the
// dictionary window, decoding stops the moment the wanted slice is complete. Gigabyte solid
// blocks therefore cost bounded memory and only the compressed prefix up to the file's end.
// PPMd, bzip2, BCJ2 and AES report clean unsupported/encrypted errors.
// Range 式 7z 读取器。列目录只要三次小读取:32 字节签名头(指向尾部头)、尾部头本体、
// 以及尾部头被 LZMA 打包时(7z 默认如此)它那一小段压缩流。提取时定位文件所在的 solid 块
// ("folder"),把它的压缩字节按有界分块流经 lzma.js 的可续传状态机:输入每次滚进几 MB,
// 输出从字典窗口排水而出,目标切片一满立即停止。GB 级 solid 块因此内存有界,流量只到
// 文件结尾处的压缩前缀为止。PPMd、bzip2、BCJ2、AES 给出明确的不支持/加密错误。
import {
  In, OutWindow, Lzma2Machine, Lzma1Machine, CopyMachine,
  lzma2DictSize, deltaDecode, bcjX86,
} from './lzma.js';
import { parse7zAesProps, derive7zKey, importAesKey, CbcStream } from './arcrypto.js';

const HEADER_CAP = 64 * 1024 * 1024;   // end-header sanity cap / 尾部头理智上限
const WIN_CAP = 256 * 1024 * 1024;     // dictionary window cap / 字典窗口上限
const IN_CHUNK = 8 * 1024 * 1024;      // packed input roll step / 压缩输入滚动步长

// Property ids / 属性号
const K = {
  End: 0x00, Header: 0x01, MainStreamsInfo: 0x04, FilesInfo: 0x05,
  PackInfo: 0x06, UnPackInfo: 0x07, SubStreamsInfo: 0x08,
  Size: 0x09, CRC: 0x0a, Folder: 0x0b, CodersUnpackSize: 0x0c, NumUnpackStream: 0x0d,
  EmptyStream: 0x0e, EmptyFile: 0x0f, Name: 0x11, MTime: 0x14, Attributes: 0x15,
  EncodedHeader: 0x17,
};

class Reader {
  constructor(buf) {
    this.b = buf;
    this.p = 0;
  }
  byte() {
    if (this.p >= this.b.length) throw new Error('e_arc_bad');
    return this.b[this.p++];
  }
  bytes(n) {
    if (this.p + n > this.b.length) throw new Error('e_arc_bad');
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  /** 7z variable-length number / 7z 变长数字 */
  num() {
    const first = this.byte();
    let mask = 0x80;
    let value = 0;
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) {
        value += (first & (mask - 1)) * 2 ** (8 * i);
        break;
      }
      value += this.byte() * 2 ** (8 * i);
      mask >>= 1;
    }
    if (!Number.isSafeInteger(value)) throw new Error('e_arc_bad');
    return value;
  }
  u32() {
    const v = this.b[this.p] | (this.b[this.p + 1] << 8) | (this.b[this.p + 2] << 16);
    const r = v + this.b[this.p + 3] * 0x1000000;
    this.p += 4;
    return r;
  }
  u64() {
    const lo = this.u32();
    const hi = this.u32();
    return hi * 0x100000000 + lo;
  }
  /** Bit vector, MSB first / 位向量,高位在前 */
  bits(n) {
    const out = new Array(n);
    let b = 0;
    let mask = 0;
    for (let i = 0; i < n; i++) {
      if (!mask) {
        b = this.byte();
        mask = 0x80;
      }
      out[i] = !!(b & mask);
      mask >>= 1;
    }
    return out;
  }
  definedBits(n) {
    return this.byte() ? new Array(n).fill(true) : this.bits(n);
  }
}

const idHex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');

function parseFolder(r) {
  const numCoders = r.num();
  if (!numCoders || numCoders > 8) throw new Error('e_arc_bad');
  const coders = [];
  let totalIn = 0;
  let totalOut = 0;
  for (let i = 0; i < numCoders; i++) {
    const flags = r.byte();
    const id = idHex(r.bytes(flags & 0x0f));
    let nIn = 1;
    let nOut = 1;
    if (flags & 0x10) {
      nIn = r.num();
      nOut = r.num();
    }
    let props = new Uint8Array(0);
    if (flags & 0x20) props = r.bytes(r.num()).slice();
    coders.push({ id, nIn, nOut, props, inFirst: totalIn, outFirst: totalOut });
    totalIn += nIn;
    totalOut += nOut;
  }
  const numBindPairs = totalOut - 1;
  const bindPairs = [];
  for (let i = 0; i < numBindPairs; i++) bindPairs.push({ inIndex: r.num(), outIndex: r.num() });
  const numPackStreams = totalIn - numBindPairs;
  const packedIndices = [];
  if (numPackStreams === 1) {
    for (let i = 0; i < totalIn; i++) {
      if (!bindPairs.some((bp) => bp.inIndex === i)) {
        packedIndices.push(i);
        break;
      }
    }
  } else {
    for (let i = 0; i < numPackStreams; i++) packedIndices.push(r.num());
  }
  return { coders, bindPairs, packedIndices, totalIn, totalOut, numPackStreams };
}

function parseStreamsInfo(r) {
  const info = { packPos: 0, packSizes: [], folders: [], numUnpack: [], subSizes: [], subCrcs: [] };
  for (;;) {
    const t = r.num();
    if (t === K.End) break;
    if (t === K.PackInfo) {
      info.packPos = r.num();
      const n = r.num();
      for (;;) {
        const t2 = r.num();
        if (t2 === K.End) break;
        if (t2 === K.Size) for (let i = 0; i < n; i++) info.packSizes.push(r.num());
        else if (t2 === K.CRC) {
          const def = r.definedBits(n);
          for (const d of def) if (d) r.u32();
        } else throw new Error('e_arc_bad');
      }
    } else if (t === K.UnPackInfo) {
      for (;;) {
        const t2 = r.num();
        if (t2 === K.End) break;
        if (t2 === K.Folder) {
          const n = r.num();
          if (r.byte() !== 0) throw new Error('e_arc_method');
          for (let i = 0; i < n; i++) info.folders.push(parseFolder(r));
        } else if (t2 === K.CodersUnpackSize) {
          for (const f of info.folders) {
            f.unpackSizes = [];
            for (let i = 0; i < f.totalOut; i++) f.unpackSizes.push(r.num());
          }
        } else if (t2 === K.CRC) {
          const def = r.definedBits(info.folders.length);
          info.folders.forEach((f, i) => {
            if (def[i]) f.crc = r.u32();
          });
        } else throw new Error('e_arc_bad');
      }
    } else if (t === K.SubStreamsInfo) {
      let counts = info.folders.map(() => 1);
      for (;;) {
        const t2 = r.num();
        if (t2 === K.End) break;
        if (t2 === K.NumUnpackStream) counts = info.folders.map(() => r.num());
        else if (t2 === K.Size) {
          info.folders.forEach((f, fi) => {
            let rest = folderUnpackSize(f);
            const sizes = [];
            for (let i = 0; i + 1 < counts[fi]; i++) {
              const s = r.num();
              sizes.push(s);
              rest -= s;
            }
            if (counts[fi] > 0) sizes.push(rest);
            info.subSizes.push(...sizes);
          });
        } else if (t2 === K.CRC) {
          let missing = 0;
          info.folders.forEach((f, fi) => {
            missing += counts[fi] === 1 && f.crc !== undefined ? 0 : counts[fi];
          });
          const def = r.definedBits(missing);
          for (const d of def) if (d) r.u32();
        } else throw new Error('e_arc_bad');
      }
      info.numUnpack = counts;
      if (!info.subSizes.length) {
        info.folders.forEach((f, fi) => {
          if (counts[fi] === 1) info.subSizes.push(folderUnpackSize(f));
          else if (counts[fi] > 1) throw new Error('e_arc_bad');
        });
      }
    } else throw new Error('e_arc_bad');
  }
  if (!info.numUnpack.length) {
    info.numUnpack = info.folders.map(() => 1);
    info.subSizes = info.folders.map((f) => folderUnpackSize(f));
  }
  return info;
}

/** The folder's final output size: the out-stream no bind pair consumes
 *  folder 的最终输出大小。即没有被 bind pair 消费的那路输出 */
function folderUnpackSize(f) {
  for (let o = f.totalOut - 1; o >= 0; o--) {
    if (!f.bindPairs.some((bp) => bp.outIndex === o)) return f.unpackSizes[o];
  }
  return f.unpackSizes[f.totalOut - 1];
}

const FILETIME_EPOCH = 11644473600000;

function parseFilesInfo(r, files) {
  const n = r.num();
  for (let i = 0; i < n; i++) files.push({ name: '', emptyStream: false, emptyFile: false, attrib: 0, mtime: 0 });
  for (;;) {
    const t = r.num();
    if (t === K.End) break;
    const size = r.num();
    const endPos = r.p + size;
    if (t === K.EmptyStream) {
      const bits = r.bits(n);
      files.forEach((f, i) => {
        f.emptyStream = bits[i];
      });
    } else if (t === K.EmptyFile) {
      const empties = files.filter((f) => f.emptyStream);
      const bits = r.bits(empties.length);
      empties.forEach((f, i) => {
        f.emptyFile = bits[i];
      });
    } else if (t === K.Name) {
      if (r.byte() !== 0) throw new Error('e_arc_method');
      const raw = r.bytes(endPos - r.p);
      let s = 0;
      let fi = 0;
      for (let i = 0; i + 1 < raw.length && fi < n; i += 2) {
        if (raw[i] === 0 && raw[i + 1] === 0) {
          files[fi++].name = new TextDecoder('utf-16le').decode(raw.subarray(s, i));
          s = i + 2;
        }
      }
    } else if (t === K.MTime) {
      const def = r.definedBits(n);
      if (r.byte() !== 0) throw new Error('e_arc_method');
      files.forEach((f, i) => {
        if (def[i]) f.mtime = r.u64() / 10000 - FILETIME_EPOCH;
      });
    } else if (t === K.Attributes) {
      const def = r.definedBits(n);
      if (r.byte() !== 0) throw new Error('e_arc_method');
      files.forEach((f, i) => {
        if (def[i]) f.attrib = r.u32();
      });
    }
    r.p = endPos;
  }
}

/** Machine for the folder's main decompressor. An AES coder needs a password; without one it
 *  is a clean "encrypted" error, with one it becomes an input-side CBC decrypt transform that
 *  the packed stream passes through before the LZMA machine sees it. PPMd/&c. stay unsupported.
 *  folder 主解压器对应的状态机。AES 编码器需要密码;没密码就干净地报"已加密",
 *  有密码则成为输入侧 CBC 解密变换,压缩流在进 LZMA 状态机前先过它。PPMd 等仍不支持。 */
function machineOf(f, unpackSize, password) {
  const aes = f.coders.find((c) => c.id === '06f10701');
  if (aes && !password) throw new Error('e_arc_encrypted');
  const main = f.coders.find((c) => c.id === '21' || c.id === '030101' || c.id === '00');
  if (!main) throw new Error('e_arc_method');
  const filters = f.coders.filter((c) => c !== main && c !== aes);
  for (const c of filters) {
    if (c.id !== '03' && c.id !== '04' && c.id !== '03030103') throw new Error('e_arc_method');
  }
  const machine = main.id === '00' ? new CopyMachine(unpackSize)
    : main.id === '21' ? new Lzma2Machine()
      : new Lzma1Machine(main.props, unpackSize);
  return { machine, filters, aes };
}

/** An input transform decrypting the packed stream from byte 0 (CBC chains from the start)
 *  从第 0 字节起解密压缩流的输入变换(CBC 从头串联) */
async function aesInputTransform(aes, password) {
  const { numCyclesPower, salt, iv } = parse7zAesProps(aes.props);
  const key = await importAesKey(derive7zKey(password, salt, numCyclesPower));
  const cbc = new CbcStream(key, iv);
  return (chunk) => cbc.push(chunk);
}

/** A decode failure on an encrypted block almost always means the wrong password: the AES
 *  output is garbage and the LZMA machine chokes on it. Surface that as a password error.
 *  加密块解码失败几乎必然是密码错:AES 输出是垃圾,LZMA 状态机嚼不动。翻成密码错误。 */
function mapPwError(e, encrypted) {
  if (encrypted && e && /e_arc_bad|e_arc_too_big/.test(e.message)) return new Error('e_arc_password');
  return e;
}

function dictOf(f) {
  const c21 = f.coders.find((c) => c.id === '21');
  if (c21) return lzma2DictSize(c21.props[0] || 0);
  const c1 = f.coders.find((c) => c.id === '030101');
  if (c1 && c1.props.length >= 5) {
    return (c1.props[1] | (c1.props[2] << 8) | (c1.props[3] << 16)) + c1.props[4] * 0x1000000;
  }
  return 1 << 24;
}

/** Drive one folder's machine over rolling packed input until win.stopAt is produced.
 *  Drained chunks flow to onBytes (awaited: natural backpressure).
 *  以滚动压缩输入驱动一个块的状态机,产出到 win.stopAt 为止。排水块流向 onBytes
 *  (逐块 await,天然背压)。 */
async function driveFolder(f, readPacked, packSize, total, win, onBytes, signal, openStream, password, idleCancelMs) {
  const { machine, filters, aes } = machineOf(f, total, password);
  if (filters.length) throw new Error('e_arc_filter_stream');
  const inn = new In();
  const dec = aes ? await aesInputTransform(aes, password) : null;
  // Packed bytes pass through AES-CBC decrypt (if any) before the LZMA machine sees them
  // 压缩字节在进 LZMA 状态机前先过 AES-CBC 解密(如有)
  const feed = async (bytes) => inn.feed(dec ? await dec(bytes) : bytes);
  const pending = [];
  win.sink = (chunk, at) => pending.push([chunk, at]);
  let stream = null;
  // A consumer that stops asking for output (an image is on screen, nothing else requested yet)
  // holds this loop inside onBytes. Let go of the network connection while that lasts -- the
  // decoder state stays intact, so resuming re-opens a ranged request exactly where it stopped
  // instead of re-decoding the block from its start.
  // 消费方不再要输出时(图已显示,暂时没别的请求),这个循环会停在 onBytes 里。期间先放掉网络
  // 连接 —— 解码器状态原封不动,恢复时从停下的位置重开 Range 请求,而不是把整块从头重解。
  const flush = async () => {
    for (const [c, a] of pending.splice(0)) {
      const t0 = Date.now();
      await onBytes(c, a);
      if (stream && idleCancelMs && Date.now() - t0 > idleCancelMs) {
        stream.cancel?.();
        stream = null;
      }
    }
  };
  let fed = 0;
  // First pull sized to the target: a small slice near the block head should not cost a
  // full 8MB of input. Later pulls use the full step.
  // 首次拉取按目标比例定大小:块头附近的小切片不该花整整 8MB 输入。后续按满步长。
  let step = Math.max(256 * 1024, Math.min(IN_CHUNK,
    Math.ceil(packSize * (win.stopAt / Math.max(1, total)) * 1.25) + 128 * 1024));
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('e_arc_fetch');
      const r = machine.run(inn, win);
      if (r === 'end' || win.total >= win.stopAt) {
        win.drainNow();
        await flush();
        return;
      }
      if (r === 'drain') {
        win.drainNow();
        await flush();
        continue;
      }
      // r === 'input'
      if (fed >= packSize) {
        // pad once so the range coder's tail reads stay defined, then signal EOF
        // 补一次零垫,让区间编码器的尾部读取有定义,然后宣告 EOF
        inn.feed(new Uint8Array(64));
        inn.eof = true;
        continue;
      }
      if (openStream) {
        // One long-lived ranged request; the decoder advances chunk by chunk as bytes land,
        // so progress readouts stay live in mid-request.
        // 一条长连接的 Range 请求。字节到多少解多少,进度在请求中间也是活的。
        if (!stream) stream = await openStream(fed);
        const chunk = await stream.read();
        if (!chunk || !chunk.length) {
          fed = packSize;
          continue;
        }
        const take = chunk.length > packSize - fed ? chunk.subarray(0, packSize - fed) : chunk;
        await feed(take);
        fed += take.length;
      } else {
        const n = Math.min(step, packSize - fed);
        await feed(await readPacked(fed, n));
        fed += n;
        step = IN_CHUNK;
      }
    }
  } finally {
    stream?.cancel?.();
  }
}

/** Whole-folder decode for filtered folders (needs history from byte 0) and small folders
 *  整块解出。带过滤器的块(需要从 0 起的历史)与小块用它 */
async function decodeWhole(f, readPacked, packSize, upTo, cap, password) {
  if (upTo > (cap || WIN_CAP)) throw new Error('e_arc_too_big');
  const { machine, filters, aes } = machineOf(f, folderUnpackSize(f), password);
  const win = new OutWindow(Math.min(Math.max(dictOf(f), 4096), WIN_CAP, upTo), upTo);
  const parts = [];
  win.sink = (chunk) => parts.push(chunk);
  const inn = new In();
  const dec = aes ? await aesInputTransform(aes, password) : null;
  const feed = async (bytes) => inn.feed(dec ? await dec(bytes) : bytes);
  let fed = 0;
  for (;;) {
    const r = machine.run(inn, win);
    if (r === 'end' || win.total >= win.stopAt) {
      win.drainNow();
      break;
    }
    if (r === 'drain') {
      win.drainNow();
      continue;
    }
    if (fed >= packSize) {
      inn.feed(new Uint8Array(64));
      inn.eof = true;
      continue;
    }
    const step = Math.min(IN_CHUNK, packSize - fed);
    await feed(await readPacked(fed, step));
    fed += step;
  }
  const out = new Uint8Array(win.total);
  let o = 0;
  for (const c of parts) {
    out.set(c.subarray(0, Math.min(c.length, out.length - o)), o);
    o += c.length;
  }
  for (const c of filters) {
    if (c.id === '03') deltaDecode(out, (c.props[0] || 0) + 1);
    else bcjX86(out, 0);
  }
  return out;
}

/** Decode one whole (small) folder to bytes -- used for the packed end header
 *  整体解出一个小 folder。用于解包压缩的尾部头 */
async function decodeFolderAll(source, baseOff, info, folderIndex, password) {
  const f = info.folders[folderIndex];
  const size = folderUnpackSize(f);
  if (size > HEADER_CAP) throw new Error('e_arc_bad');
  let packOff = info.packPos + baseOff;
  let idx = 0;
  for (let i = 0; i < folderIndex; i++) idx += info.folders[i].numPackStreams;
  for (let i = 0; i < idx; i++) packOff += info.packSizes[i];
  const packSize = info.packSizes[idx];
  return decodeWhole(f, (off, len) => source.read(packOff + off, len), packSize, size, HEADER_CAP, password);
}

export async function open7z(source, password) {
  const sig = await source.read(0, 32);
  if (sig.length < 32 || sig[0] !== 0x37 || sig[1] !== 0x7a || sig[2] !== 0xbc || sig[3] !== 0xaf || sig[4] !== 0x27 || sig[5] !== 0x1c) {
    throw new Error('e_arc_bad');
  }
  const sr = new Reader(sig);
  sr.p = 12;
  const nhOff = sr.u64();
  const nhSize = sr.u64();
  if (nhSize === 0 || nhSize > HEADER_CAP || 32 + nhOff + nhSize > source.size + 1) throw new Error('e_arc_bad');
  let hdr = await source.read(32 + nhOff, nhSize);

  let r = new Reader(hdr);
  let t = r.num();
  let headerEncrypted = false;
  if (t === K.EncodedHeader) {
    const si = parseStreamsInfo(r);
    // Header-encrypted archives (-mhe) need the password just to read the file list
    // 头加密档案(-mhe)连读文件清单都要密码
    const encHdr = si.folders.some((f) => f.coders.some((c) => c.id === '06f10701'));
    headerEncrypted = encHdr;
    try {
      hdr = await decodeFolderAll(source, 32, si, 0, password);
    } catch (e) {
      throw mapPwError(e, encHdr);
    }
    // A wrong header password often decodes to bytes that are not a valid header
    // 头密码错时,常解出一堆不成头结构的字节
    try {
      r = new Reader(hdr);
      const probe = r.num();
      r = new Reader(hdr);
      if (probe !== K.Header && probe !== K.EncodedHeader && encHdr) throw new Error('e_arc_password');
    } catch (e) {
      throw encHdr ? new Error('e_arc_password') : e;
    }
    t = r.num();
  }
  if (t !== K.Header) throw new Error('e_arc_bad');

  let streams = { packPos: 0, packSizes: [], folders: [], numUnpack: [], subSizes: [] };
  const files = [];
  for (;;) {
    const t2 = r.num();
    if (t2 === K.End) break;
    if (t2 === K.MainStreamsInfo) streams = parseStreamsInfo(r);
    else if (t2 === K.FilesInfo) {
      parseFilesInfo(r, files);
      break;
    } else throw new Error('e_arc_bad');
  }

  // Map files with content onto (folder, offset, size) / 把有内容的文件映射到(块,偏移,大小)
  let folderIdx = 0;
  let inFolder = 0;
  let folderOff = 0;
  let subIdx = 0;
  for (const f of files) {
    if (f.emptyStream) continue;
    while (folderIdx < streams.folders.length && inFolder >= streams.numUnpack[folderIdx]) {
      folderIdx++;
      inFolder = 0;
      folderOff = 0;
    }
    if (folderIdx >= streams.folders.length) throw new Error('e_arc_bad');
    f.size = streams.subSizes[subIdx++];
    f.folder = folderIdx;
    f.off = folderOff;
    folderOff += f.size;
    inFolder++;
  }

  // Pack stream offsets per folder / 每个块的压缩流绝对偏移
  const packBase = [];
  {
    let off = 32 + streams.packPos;
    let idx = 0;
    for (const f of streams.folders) {
      packBase.push({ off, size: streams.packSizes.slice(idx, idx + f.numPackStreams).reduce((a, b) => a + b, 0) });
      for (let i = 0; i < f.numPackStreams; i++) off += streams.packSizes[idx++];
    }
  }

  // Directory tree, same shape as rzip's / 目录树,与 rzip 同构
  const dirs = new Map();
  const dirOf = (path) => {
    if (dirs.has(path)) return dirs.get(path);
    const d = { children: new Map(), bytes: 0 };
    dirs.set(path, d);
    if (path) {
      const i = path.lastIndexOf('/');
      const parent = dirOf(i < 0 ? '' : path.slice(0, i));
      const nm = i < 0 ? path : path.slice(i + 1);
      if (!parent.children.has(nm)) parent.children.set(nm, { name: nm, isDir: true, size: 0, mtime: 0 });
    }
    return d;
  };
  dirOf('');
  let count = 0;
  for (const f of files) {
    const name = f.name.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!name || name.split('/').some((s) => s === '..') || name.startsWith('/')) continue;
    const isDir = (f.emptyStream && !f.emptyFile) || !!(f.attrib & 0x10);
    const i = name.lastIndexOf('/');
    const dirPath = i < 0 ? '' : name.slice(0, i);
    const nm = i < 0 ? name : name.slice(i + 1);
    if (isDir) {
      dirOf(name);
      const node = dirOf(dirPath).children.get(nm);
      if (node) node.mtime = node.mtime || f.mtime;
      continue;
    }
    count++;
    dirOf(dirPath).children.set(nm, {
      name: nm, isDir: false, size: f.size || 0, mtime: f.mtime,
      folder: f.folder, off: f.off || 0,
    });
    for (let path = dirPath; ; ) {
      dirOf(path).bytes += f.size || 0;
      if (!path) break;
      const j = path.lastIndexOf('/');
      path = j < 0 ? '' : path.slice(0, j);
    }
  }

  const join = (a, b) => (a ? a + '/' + b : b);
  // Any AES coder anywhere means the content is password-protected / 任一 AES 编码器即内容有密码
  const encryptedArchive = streams.folders.some((f) => f.coders.some((c) => c.id === '06f10701'));
  const self = {
    source,
    count,
    password,
    encrypted: encryptedArchive,
    headerEncrypted,
    /** Cheap password check: decode a small prefix of the first content block. A wrong AES key
     *  yields garbage the LZMA decoder rejects within the first chunk, so this never has to walk
     *  deep into a solid block. Header-encrypted archives are already proven by open() itself.
     *  廉价的密码校验:只解第一个内容块的一小段前缀。密码错时 AES 输出是垃圾,LZMA 在头一个
     *  分块内就拒绝,绝不用深入固实块。头加密档案在 open() 时已被证明,无需再验。 */
    async verifyPassword() {
      if (!encryptedArchive || headerEncrypted) return;
      const f = streams.folders.find((x) => x.coders.some((c) => c.id === '06f10701'));
      if (!f) return;
      const idx = streams.folders.indexOf(f);
      const probeLen = Math.min(64 * 1024, folderUnpackSize(f));
      try {
        let got = 0;
        await self.streamBlockUpto(idx, probeLen, () => { got += 1; });
      } catch (e) {
        throw mapPwError(e, true);
      }
    },
    /** Decode a solid block only up to `limit` output bytes (for the password probe)
     *  只把固实块解到 limit 个输出字节(供密码探测用) */
    async streamBlockUpto(folderIndex, limit, onBytes) {
      const f = streams.folders[folderIndex];
      const pack = packBase[folderIndex];
      const total = folderUnpackSize(f);
      const stop = Math.min(limit, total);
      const readPacked = (off, len) => this.source.read(pack.off + off, Math.min(len, pack.size - off));
      const win = new OutWindow(Math.min(Math.max(dictOf(f), 4096), WIN_CAP, stop), stop);
      await driveFolder(f, readPacked, pack.size, total, win, async (c) => onBytes(c), null, null, this.password);
    },
    _debug: { streams, packBase },
    dir(path) {
      const d = dirs.get(path || '');
      if (!d) return null;
      return [...d.children.values()].map((n) => (n.isDir
        ? { name: n.name, isDir: true, size: dirs.get(join(path || '', n.name))?.bytes || 0, mtime: n.mtime || 0 }
        : n));
    },
    stat(path) {
      const i = String(path).lastIndexOf('/');
      const d = dirs.get(i < 0 ? '' : path.slice(0, i));
      return d?.children.get(i < 0 ? path : path.slice(i + 1)) || null;
    },
    /** Contiguous byte span when the entry sits in a stored (Copy) block: perfect ranged
     *  streaming with zero decode. Null otherwise.
     *  条目在直存(Copy)块里时给出连续字节区间:零解码的完美 Range 流。否则 null。 */
    copySpan(entry) {
      if (entry.folder === undefined) return null;
      const f = streams.folders[entry.folder];
      // Encrypted or non-plain-Copy blocks have no directly-servable contiguous span
      // 加密块或非纯 Copy 块没有可直接供给的连续区间
      if (f.coders.length !== 1 || f.coders[0].id !== '00' || f.numPackStreams !== 1) return null;
      return { off: packBase[entry.folder].off + entry.off, len: entry.size };
    },
    /** Slice [start, endEx) of an entry, streamed to onBytes in decode order. opts.openStream
     *  (absOff, absEndEx) switches input to one long-lived streaming request.
     *  条目的 [start, endEx) 切片,按解码顺序流向 onBytes。opts.openStream 提供后,
     *  输入改走单条长连接流式请求。 */
    async streamSlice(entry, start, endEx, onBytes, signal, opts) {
      if (entry.folder === undefined) return;
      const f = streams.folders[entry.folder];
      const pack = packBase[entry.folder];
      const total = folderUnpackSize(f);
      const from = entry.off + start;
      const to = entry.off + Math.min(endEx, entry.size);
      if (to > total || from > to) throw new Error('e_arc_bad');
      const readPacked = (off, len) => this.source.read(pack.off + off, Math.min(len, pack.size - off));
      const encrypted = f.coders.some((c) => c.id === '06f10701');
      // driveFolder always decodes a block from its byte 0, so the streaming input opens at the
      // block start -- fine even when AES-CBC decrypts (the CBC chain begins at byte 0 too).
      // driveFolder 总是从块的字节 0 解起,流式输入也从块首打开 —— 即便 AES-CBC 解密也没问题
      // (CBC 链同样始于字节 0)。
      const openStream = opts?.openStream
        ? (off) => opts.openStream(pack.off + off, pack.off + pack.size)
        : null;
      try {
        const win = new OutWindow(Math.min(Math.max(dictOf(f), 4096), WIN_CAP, to), to);
        if (dictOf(f) > WIN_CAP) throw new Error('e_arc_too_big');
        await driveFolder(f, readPacked, pack.size, total, win, async (chunk, at) => {
          // clip the drained chunk to the wanted slice / 把排水块裁到目标切片
          const s = Math.max(from, at);
          const e = Math.min(to, at + chunk.length);
          if (e > s) await onBytes(chunk.subarray(s - at, e - at));
        }, signal, openStream, this.password, opts?.idleCancelMs);
      } catch (e) {
        if (e && e.message === 'e_arc_filter_stream') {
          // filtered folder: decode from 0, filter, then emit the slice
          // 带过滤器的块:从 0 解出、过滤,再发切片
          try {
            const out = await decodeWhole(f, readPacked, pack.size, to, WIN_CAP, this.password);
            await onBytes(out.subarray(from, to));
          } catch (e2) {
            throw mapPwError(e2, encrypted);
          }
        } else throw mapPwError(e, encrypted);
      }
    },
    /** Which solid block an entry lives in, its offset within it, and the block's unpacked size.
     *  Files sharing a block decode together, so a block-level cache serves them all at once.
     *  条目所在的固实块、块内偏移、块的解压总大小。同块文件一起解出,块级缓存一次喂全部。 */
    blockOf(entry) {
      if (entry.folder === undefined) return null;
      return { index: entry.folder, off: entry.off, size: entry.size, blockSize: folderUnpackSize(streams.folders[entry.folder]) };
    },
    /** Decode a whole solid block (folder) in order to onBytes -- the unit a block cache stores.
     *  按顺序解出整个固实块(folder)到 onBytes —— 块缓存存储的单位。 */
    async streamBlock(folderIndex, onBytes, signal, opts) {
      const f = streams.folders[folderIndex];
      const pack = packBase[folderIndex];
      const total = folderUnpackSize(f);
      const readPacked = (off, len) => this.source.read(pack.off + off, Math.min(len, pack.size - off));
      const encrypted = f.coders.some((c) => c.id === '06f10701');
      const openStream = opts?.openStream
        ? (off) => opts.openStream(pack.off + off, pack.off + pack.size)
        : null;
      try {
        const win = new OutWindow(Math.min(Math.max(dictOf(f), 4096), WIN_CAP, total), total);
        if (dictOf(f) > WIN_CAP) throw new Error('e_arc_too_big');
        await driveFolder(f, readPacked, pack.size, total, win, async (chunk) => onBytes(chunk), signal, openStream, this.password, opts?.idleCancelMs);
      } catch (e) {
        if (e && e.message === 'e_arc_filter_stream') {
          const out = await decodeWhole(f, readPacked, pack.size, total, WIN_CAP, this.password);
          await onBytes(out);
        } else throw mapPwError(e, encrypted);
      }
    },
    /** Entry bytes in one buffer / 条目字节一次给齐 */
    async extract(entry, cap) {
      if (entry.folder === undefined) return { bytes: new Uint8Array(0) };
      if (cap && entry.size > cap) throw new Error('e_arc_too_big');
      const parts = [];
      await self.streamSlice(entry, 0, entry.size, (c) => {
        parts.push(c.slice());
      });
      const out = new Uint8Array(entry.size);
      let o = 0;
      for (const c of parts) {
        out.set(c.subarray(0, Math.min(c.length, out.length - o)), o);
        o += c.length;
      }
      return { bytes: out };
    },
  };
  return self;
}
