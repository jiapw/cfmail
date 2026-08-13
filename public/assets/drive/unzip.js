// A minimal ZIP reader on top of the native DecompressionStream -- enough to open docx and
// pptx containers without vendoring a zip library. Reads the end-of-central-directory record,
// walks the central directory, and inflates entries on demand. ZIP64 and encryption are out of
// scope (Office files of that size would be refused upstream anyway).
// 基于原生 DecompressionStream 的最小 ZIP 读取器 —— 够打开 docx/pptx 容器,不必再引入 zip 库。
// 读 EOCD、遍历中央目录、按需解压条目。不支持 ZIP64 与加密(那么大的 Office 文件上游早拒了)。

/**
 * @param {ArrayBuffer} buf
 * @returns {Map<string, { size: number, bytes(): Promise<Uint8Array>, text(): Promise<string> }>}
 *          keyed by the entry's full path inside the archive / 以包内完整路径为键
 */
export function unzip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  // EOCD signature 0x06054b50, searched backwards past a possible comment (max 64KB)
  // EOCD 签名 0x06054b50。注释最长 64KB,从尾部倒着找
  let eocd = -1;
  const lo = Math.max(0, u8.length - 65558);
  for (let i = u8.length - 22; i >= lo; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const map = new Map();
  if (eocd < 0) return map;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central directory offset / 中央目录偏移
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true); // local header offset / 本地头偏移
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directories carry no data / 目录项没有数据
    const entry = {
      size: usize,
      async bytes() {
        // The local header repeats name/extra lengths; the data follows it
        // 本地头重复了文件名/扩展区长度,数据紧随其后
        if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('zip: bad local header');
        const ln = dv.getUint16(lho + 26, true);
        const le = dv.getUint16(lho + 28, true);
        const start = lho + 30 + ln + le;
        const raw = u8.subarray(start, start + csize);
        if (method === 0) return raw.slice();
        if (method !== 8) throw new Error('zip: unsupported method ' + method);
        const ds = new DecompressionStream('deflate-raw');
        const out = new Response(new Blob([raw]).stream().pipeThrough(ds));
        return new Uint8Array(await out.arrayBuffer());
      },
      async text() {
        return new TextDecoder().decode(await this.bytes());
      },
    };
    map.set(name, entry);
  }
  return map;
}
