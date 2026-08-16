// Range-based zip reader: list a huge archive by fetching only its tail (EOCD + central
// directory), then pull individual entries by offset. Nothing is ever downloaded in full.
// Sources are pluggable so a nested zip can read through its parent: stored entries become a
// plain offset translation (still ranged all the way down), deflated ones inflate to memory.
// Range 式 zip 读取器:只拉文件尾部(EOCD + 中央目录)就能列出巨型压缩包,单个条目按偏移取,
// 从不整包下载。数据源可插拔,嵌套 zip 借父级源读取:store 存放的条目纯偏移平移(Range 一路
// 到底),deflate 的解到内存。

// Static, not a lazy import(): this module is loaded by the archive service worker, and a
// service worker may not call dynamic import() at all -- the failure only appears when an
// encrypted entry is actually decoded, disguised as a body that errors mid-stream.
// 静态导入,不用惰性 import():本模块会被压缩包 service worker 加载,而 service worker
// 根本不允许调用动态 import() —— 该失败只在真正解密某个加密条目时才出现,
// 伪装成一个中途出错的响应体。
import { ZipCrypto } from './arcrypto.js';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;

const CD_CAP = 64 * 1024 * 1024;      // central directory sanity cap / 中央目录理智上限
const TAIL = 68 * 1024;               // EOCD scan window (max comment 64KB) / EOCD 扫描窗口

// ---------- Sources / 数据源 ----------

/** HTTP source over the drive dl endpoint; the caller supplies the known size.
 *  走网盘下载端点的 HTTP 源。总大小由调用方提供(节点上有)。 */
/** onProgress(received, expected) fires as the bytes of ONE read arrive, so a caller can show a
 *  real percentage instead of a running byte count -- a count is meaningless without a total
 *  and reads as "stuck" whenever a read is slow.
 *  onProgress(已收, 应收) 在单次 read 的字节到达过程中触发,调用方因此能显示真实百分比,
 *  而不是一个不断增长的字节数 —— 没有总量的字节数毫无意义,读得一慢就像卡死了。 */
export function httpSource(url, size, onProgress) {
  return {
    size,
    async read(off, len) {
      const end = Math.min(off + len, size) - 1;
      if (end < off) return new Uint8Array(0);
      const r = await fetch(url, { headers: { Range: `bytes=${off}-${end}` } });
      if (!r.ok) throw new Error('e_arc_fetch');
      const want = end - off + 1;
      // A 206 body starts at `off`; a 200 means the server ignored the Range and sent the whole
      // object from zero, so the wanted span has to be cut out of the middle. Trimming from the
      // front either way was silently wrong for every read but the first -- the tail read that
      // finds the central directory would have come back as the file's opening bytes.
      // 206 的响应体从 off 开始;200 则说明服务器无视了 Range、从 0 发来整个对象,
      // 所要的那一段得从中间截出来。无论如何都从头裁,对除第一次以外的每次读取都是
      // 静默错误 —— 用来找中央目录的那次尾部读取,拿回来的会是文件开头的字节。
      const base = r.status === 206 ? 0 : off;
      const cut = (u8) => (u8.length > base + want ? u8.subarray(base, base + want) : u8.subarray(base));
      if (!onProgress || !r.body) {
        return cut(new Uint8Array(await r.arrayBuffer()));
      }
      const rd = r.body.getReader();
      const parts = [];
      let got = 0;
      onProgress(0, want);
      for (;;) {
        const step = await rd.read();
        if (step.done) break;
        parts.push(step.value);
        got += step.value.length;
        onProgress(got, want);
      }
      const u8 = new Uint8Array(got);
      let o = 0;
      for (const p of parts) {
        u8.set(p, o);
        o += p.length;
      }
      return cut(u8);
    },
  };
}

export function memSource(u8) {
  return {
    size: u8.byteLength,
    async read(off, len) {
      return u8.subarray(off, Math.min(off + len, u8.byteLength));
    },
  };
}

/** Window into a parent source: how a stored nested archive keeps ranged access
 *  父源上的窗口。store 存放的嵌套压缩包靠它保持 Range 访问 */
export function sliceSource(src, base, size) {
  return {
    size,
    read: (off, len) => src.read(base + off, Math.min(len, Math.max(0, size - off))),
  };
}

// ---------- Parsing helpers / 解析辅助 ----------

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const u64 = (b, o) => {
  const lo = u32(b, o);
  const hi = u32(b, o + 4);
  if (hi > 0x1fffff) throw new Error('e_arc_bad'); // > 2^53, not addressable / 超出安全整数
  return hi * 0x100000000 + lo;
};

/** Filename bytes to string: the UTF-8 flag decides; without it, strict UTF-8 first and GBK
 *  as the fallback -- the overwhelmingly common legacy encoding for Chinese archives.
 *  文件名字节转字符串:有 UTF-8 标志位听它的;没有则先严格试 UTF-8,失败回退 GBK ——
 *  中文压缩包最常见的旧编码。 */
function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

const dosDate = (d, tm) => {
  const y = 1980 + ((d >> 9) & 0x7f);
  const mo = Math.max(0, ((d >> 5) & 0xf) - 1);
  const day = d & 0x1f || 1;
  return new Date(y, mo, day, (tm >> 11) & 0x1f, (tm >> 5) & 0x3f, (tm & 0x1f) * 2).getTime();
};

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const resp = new Response(new Blob([u8]).stream().pipeThrough(ds));
  return new Uint8Array(await resp.arrayBuffer());
}

// ---------- The reader / 读取器 ----------

/** Open a zip over a source. Two or three ranged reads produce the full listing.
 *  Returns { entries, dir(path), stat(path), extract(entry) }.
 *  在一个源上打开 zip。两三次 Range 读取就得到完整目录。 */
export async function openZip(source, password) {
  const size = source.size;
  if (size < 22) throw new Error('e_arc_bad');
  const tailLen = Math.min(TAIL, size);
  const tail = await source.read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('e_arc_bad');
  let total = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOff = u32(tail, eocd + 16);

  // zip64: the locator sits right before the EOCD / zip64 的定位器紧贴在 EOCD 前面
  if ((total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) && eocd >= 20
    && u32(tail, eocd - 20) === SIG_EOCD64_LOC) {
    const recOff = u64(tail, eocd - 20 + 8);
    const rec = await source.read(recOff, 56);
    if (u32(rec, 0) !== SIG_EOCD64) throw new Error('e_arc_bad');
    total = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOff = u64(rec, 48);
  }
  if (cdSize > CD_CAP || cdOff + cdSize > size) throw new Error('e_arc_bad');
  const cd = await source.read(cdOff, cdSize);

  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && u32(cd, p) === SIG_CEN) {
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const mtimeRaw = u16(cd, p + 12); // DOS time, for the ZipCrypto check byte / ZipCrypto 校验字节用
    const mtime = dosDate(u16(cd, p + 14), mtimeRaw);
    const crc = u32(cd, p + 16);
    let compSize = u32(cd, p + 20);
    let uncompSize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const cmtLen = u16(cd, p + 32);
    const extAttr = u32(cd, p + 38);
    let lho = u32(cd, p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    // zip64 extra field patches the 0xffffffff placeholders, in declaration order
    // zip64 扩展字段按声明顺序补齐 0xffffffff 占位
    let q = p + 46 + nameLen;
    const qEnd = q + extraLen;
    while (q + 4 <= qEnd) {
      const id = u16(cd, q);
      const len = u16(cd, q + 2);
      if (id === 0x0001) {
        let r = q + 4;
        if (uncompSize === 0xffffffff) { uncompSize = u64(cd, r); r += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, r); r += 8; }
        if (lho === 0xffffffff) { lho = u64(cd, r); r += 8; }
      }
      q += 4 + len;
    }
    let name = decodeName(nameBytes, !!(flags & 0x800)).replace(/\\/g, '/').replace(/^\.\//, '');
    const isDir = name.endsWith('/') || !!(extAttr & 0x10);
    name = name.replace(/\/+$/, '');
    // zip-slip and absolute paths stay out of the tree / 越界路径与绝对路径不入树
    if (name && !name.split('/').some((s) => s === '..') && !name.startsWith('/')) {
      entries.push({
        name, isDir, size: uncompSize, compSize, method, mtime, mtimeRaw, crc, lho,
        encrypted: !!(flags & 1), flags,
      });
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }

  // Directory tree with synthesized intermediate dirs and per-dir subtree totals
  // 目录树。补出中间目录,并顺手算好每个目录的子树总量
  const dirs = new Map(); // path -> { children: Map(name -> node), bytes }
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
  for (const e of entries) {
    const i = e.name.lastIndexOf('/');
    const dirPath = i < 0 ? '' : e.name.slice(0, i);
    const nm = i < 0 ? e.name : e.name.slice(i + 1);
    if (e.isDir) {
      dirOf(e.name);
      const node = dirOf(dirPath).children.get(nm);
      if (node) node.mtime = node.mtime || e.mtime;
    } else {
      // Children carry their bare name; the entry keeps everything extract() needs
      // 子项用裸名。解压所需字段随展开一起带上
      dirOf(dirPath).children.set(nm, { ...e, name: nm });
      // Every ancestor's subtree grows / 每个祖先目录的子树都长大
      for (let path = dirPath; ; ) {
        dirOf(path).bytes += e.size;
        if (!path) break;
        const j = path.lastIndexOf('/');
        path = j < 0 ? '' : path.slice(0, j);
      }
    }
  }

  return {
    source,
    count: entries.length,
    /** Children of a directory as plain objects / 一个目录的子项 */
    dir(path) {
      const d = dirs.get(path || '');
      if (!d) return null;
      return [...d.children.values()].map((n) => (n.isDir
        ? { name: n.name, isDir: true, size: dirs.get(join(path, n.name))?.bytes || 0, mtime: n.mtime || 0 }
        : n));
    },
    stat(path) {
      const i = String(path).lastIndexOf('/');
      const d = dirs.get(i < 0 ? '' : path.slice(0, i));
      return d?.children.get(i < 0 ? path : path.slice(i + 1)) || null;
    },
    encrypted: entries.some((e) => e.encrypted),
    password,
    /** Entry bytes. Stored entries can instead expose a sub-source for ranged nesting.
     *  Encrypted entries (legacy ZipCrypto) decrypt in memory with the password first.
     *  条目字节。store 条目另可暴露子源,嵌套时继续 Range。加密条目(传统 ZipCrypto)
     *  先用密码在内存里解密。 */
    async extract(entry, cap) {
      if (entry.method !== 0 && entry.method !== 8) throw new Error('e_arc_method');
      if (cap && entry.size > cap) throw new Error('e_arc_too_big');
      const head = await source.read(entry.lho, 30);
      if (u32(head, 0) !== 0x04034b50) throw new Error('e_arc_bad');
      const dataOff = entry.lho + 30 + u16(head, 26) + u16(head, 28);
      if (entry.encrypted) {
        if (!password) throw new Error('e_arc_encrypted');
        // WinZip AES (method 99) uses a different scheme we do not support / 不支持 WinZip AES
        if (entry.method === 99) throw new Error('e_arc_method');
        const raw = await source.read(dataOff, entry.compSize);
        const zc = new ZipCrypto(password);
        const buf = zc.decrypt(raw.slice());
        // The 12-byte encryption header's last byte must match the check value, else wrong pw
        // 12 字节加密头的最后一字节须与校验值相符,否则密码错
        const check = entry.flags & 0x8 ? (entry.mtimeRaw >> 8) & 0xff : (entry.crc >>> 24) & 0xff;
        if (buf[11] !== check) throw new Error('e_arc_password');
        const body = buf.subarray(12);
        return { bytes: entry.method === 0 ? body : await inflateRaw(body) };
      }
      if (entry.method === 0) {
        return { bytes: await source.read(dataOff, entry.size) };
      }
      const comp = await source.read(dataOff, entry.compSize);
      return { bytes: await inflateRaw(comp) };
    },
    /** Ranged sub-source for a stored entry, null for compressed ones
     *  store 条目的 Range 子源。压缩条目返回 null */
    async subSource(entry) {
      if (entry.method !== 0 || entry.encrypted) return null;
      const head = await source.read(entry.lho, 30);
      if (u32(head, 0) !== 0x04034b50) return null;
      const dataOff = entry.lho + 30 + u16(head, 26) + u16(head, 28);
      return sliceSource(source, dataOff, entry.size);
    },
    /** Where the entry's (compressed, possibly encrypted) bytes live. For an encrypted entry the
     *  caller decrypts the returned span itself; passing a password only gates the encrypted case.
     *  条目压缩(可能加密)字节在档案里的位置。加密条目由调用方自行解密返回的区间;
     *  传密码只用于放行加密情形。 */
    async span(entry, password) {
      if (entry.encrypted && !password) throw new Error('e_arc_encrypted');
      if (entry.method !== 0 && entry.method !== 8) throw new Error('e_arc_method');
      const head = await source.read(entry.lho, 30);
      if (u32(head, 0) !== 0x04034b50) throw new Error('e_arc_bad');
      const off = entry.lho + 30 + u16(head, 26) + u16(head, 28);
      return { off, len: entry.compSize, method: entry.method, size: entry.size };
    },
  };
}

const join = (a, b) => (a ? a + '/' + b : b);
