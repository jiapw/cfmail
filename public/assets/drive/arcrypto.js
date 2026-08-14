// Archive decryption primitives, shared by the page and the service worker. Everything here
// runs locally: passwords never leave the browser. 7z AES-256 keys come from 7-Zip's KDF
// (one continuous SHA-256 over 2^N iterations of salt|password|counter); the cipher runs
// through WebCrypto AES-CBC with the appended-pad-block trick, since 7z streams carry no
// PKCS#7 padding of their own. Legacy zip encryption (ZipCrypto) is the classic three-key
// byte stream cipher.
// 压缩包解密原语,页面与 service worker 共用。全部本地运行:密码绝不离开浏览器。
// 7z 的 AES-256 密钥来自 7-Zip 的 KDF(对 salt|密码|计数器 连续做 2^N 轮 SHA-256);
// 解密走 WebCrypto AES-CBC 配"补一块假填充"技巧,因为 7z 流本身没有 PKCS#7 填充。
// zip 传统加密(ZipCrypto)是经典的三密钥字节流密码。

// ---------- Incremental SHA-256 (pure JS) / 增量 SHA-256(纯 JS) ----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.lenLo = 0;
    this.lenHi = 0;
    this.w = new Uint32Array(64);
  }
  update(data) {
    let p = 0;
    const n = data.length;
    this.lenLo += n;
    if (this.lenLo > 0xffffffff) {
      this.lenHi += Math.floor(this.lenLo / 0x100000000);
      this.lenLo = this.lenLo >>> 0;
    }
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, n);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      p = take;
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (p + 64 <= n) {
      this.block(data, p);
      p += 64;
    }
    if (p < n) {
      this.buf.set(data.subarray(p), 0);
      this.bufLen = n - p;
    }
    return this;
  }
  block(d, o) {
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < 16; i++) {
      w[i] = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
      o += 4;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0]; let b = h[1]; let c = h[2]; let dd = h[3];
    let e = h[4]; let f = h[5]; let g = h[6]; let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (dd + t1) | 0;
      dd = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + dd) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  digest() {
    const lenLo = this.lenLo;
    const lenHi = this.lenHi;
    this.update(new Uint8Array([0x80]));
    while (this.bufLen !== 56) this.update(new Uint8Array(1));
    const len = new Uint8Array(8);
    const bitsHi = (lenHi * 8 + Math.floor((lenLo * 8) / 0x100000000)) >>> 0;
    const bitsLo = (lenLo * 8) >>> 0;
    len[0] = bitsHi >>> 24; len[1] = (bitsHi >>> 16) & 0xff; len[2] = (bitsHi >>> 8) & 0xff; len[3] = bitsHi & 0xff;
    len[4] = bitsLo >>> 24; len[5] = (bitsLo >>> 16) & 0xff; len[6] = (bitsLo >>> 8) & 0xff; len[7] = bitsLo & 0xff;
    this.update(len);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = this.h[i] >>> 24;
      out[i * 4 + 1] = (this.h[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (this.h[i] >>> 8) & 0xff;
      out[i * 4 + 3] = this.h[i] & 0xff;
    }
    return out;
  }
}

// ---------- 7z key derivation / 7z 密钥推导 ----------

/** 7-Zip's KDF: one running SHA-256 fed salt|password(UTF-16LE)|counter(LE64) for 2^N rounds
 *  7-Zip 的 KDF:单个 SHA-256 连续吃 2^N 轮的 salt|密码(UTF-16LE)|计数器(LE64) */
export function derive7zKey(password, salt, numCyclesPower) {
  const pw = new Uint8Array(password.length * 2);
  for (let i = 0; i < password.length; i++) {
    const c = password.charCodeAt(i);
    pw[i * 2] = c & 0xff;
    pw[i * 2 + 1] = c >> 8;
  }
  if (numCyclesPower >= 0x3f) {
    // degenerate no-hash mode / 罕见的免哈希模式
    const key = new Uint8Array(32);
    key.set(salt.subarray(0, Math.min(32, salt.length)));
    key.set(pw.subarray(0, Math.max(0, 32 - salt.length)), salt.length);
    return key;
  }
  const sha = new Sha256();
  // Each round hashes salt | password | counter(8 LE). The block passed to update() must be a
  // FRESH, immutable value per round -- reusing one array and mutating its counter tail in
  // place feeds the running digest inconsistently and derives the wrong key.
  // 每轮哈希 salt | password | 计数器(8 字节小端)。传给 update() 的块每轮必须是全新、不可变的
  // 值 —— 复用同一数组、原地改计数器尾部会让滚动摘要吃到不一致的数据,推出错误密钥。
  const rounds = Math.pow(2, numCyclesPower);
  const prefix = new Uint8Array(salt.length + pw.length);
  prefix.set(salt, 0);
  prefix.set(pw, salt.length);
  const tail = prefix.length;
  for (let i = 0; i < rounds; i++) {
    const block = new Uint8Array(tail + 8);
    block.set(prefix, 0);
    let v = i;
    for (let k = 0; k < 8; k++) {
      block[tail + k] = v & 0xff;
      v = Math.floor(v / 256);
    }
    sha.update(block);
  }
  return sha.digest();
}

// ---------- AES-CBC without padding, via WebCrypto / 无填充 AES-CBC(WebCrypto) ----------

export async function importAesKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
}

/** Decrypt whole 16-byte blocks with no padding semantics: append the encryption of one full
 *  PKCS#7 pad block chained off the last cipher block, let WebCrypto strip it.
 *  解密整数个 16 字节块且无填充语义:在末尾接上一个以最后密文块为 IV 加密出的整块假填充,
 *  让 WebCrypto 把它剥掉。 */
export async function cbcDecryptNoPad(key, iv, data) {
  if (data.length === 0) return new Uint8Array(0);
  if (data.length % 16) throw new Error('e_arc_bad');
  const last = data.subarray(data.length - 16);
  const padBlock = new Uint8Array(16).fill(16);
  const padCipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, key, padBlock)).subarray(0, 16);
  const full = new Uint8Array(data.length + 16);
  full.set(data);
  full.set(padCipher, data.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, full));
}

/** Streaming CBC decryptor: 16-byte aligned carry, IV chained across chunks
 *  流式 CBC 解密器。16 字节对齐进位,IV 跨块串联 */
export class CbcStream {
  constructor(key, iv) {
    this.key = key;
    this.iv = iv.slice();
    this.carry = new Uint8Array(0);
  }
  async push(chunk) {
    let data = chunk;
    if (this.carry.length) {
      data = new Uint8Array(this.carry.length + chunk.length);
      data.set(this.carry);
      data.set(chunk, this.carry.length);
    }
    const usable = data.length - (data.length % 16);
    this.carry = data.slice(usable);
    if (!usable) return new Uint8Array(0);
    const body = data.subarray(0, usable);
    const plain = await cbcDecryptNoPad(this.key, this.iv, body);
    this.iv = body.slice(usable - 16);
    return plain;
  }
}

/** 7z AES coder properties: cycles, salt, iv / 7z AES 编码器属性:轮数、盐、IV */
export function parse7zAesProps(props) {
  if (!props.length) throw new Error('e_arc_bad');
  const b0 = props[0];
  const numCyclesPower = b0 & 0x3f;
  let saltSize = (b0 >> 7) & 1;
  let ivSize = (b0 >> 6) & 1;
  let p = 1;
  if (saltSize + ivSize) {
    const b1 = props[1];
    saltSize += b1 >> 4;
    ivSize += b1 & 0x0f;
    p = 2;
  }
  const salt = props.slice(p, p + saltSize);
  p += saltSize;
  const ivRaw = props.slice(p, p + ivSize);
  const iv = new Uint8Array(16);
  iv.set(ivRaw.subarray(0, 16));
  return { numCyclesPower, salt, iv };
}

// ---------- ZipCrypto (legacy zip encryption) / ZipCrypto(zip 传统加密) ----------

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crcByte = (c, b) => (CRC_T[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;

export class ZipCrypto {
  constructor(password) {
    this.k0 = 0x12345678;
    this.k1 = 0x23456789;
    this.k2 = 0x34567890;
    for (let i = 0; i < password.length; i++) this.updateKeys(password.charCodeAt(i) & 0xff);
  }
  updateKeys(b) {
    this.k0 = crcByte(this.k0, b);
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = crcByte(this.k2, this.k1 >>> 24);
  }
  decryptByte() {
    const t = (this.k2 | 2) & 0xffff;
    return (Math.imul(t, t ^ 1) >> 8) & 0xff;
  }
  /** In-place stream decrypt / 原地流解密 */
  decrypt(buf) {
    for (let i = 0; i < buf.length; i++) {
      const p = buf[i] ^ this.decryptByte();
      this.updateKeys(p);
      buf[i] = p;
    }
    return buf;
  }
}
