// End-to-end encryption of a meeting's media, one frame at a time.
//
// Every frame a browser sends is encrypted here after the encoder and before the packetizer, and
// every frame it receives is decrypted here before the decoder. What travels through Cloudflare
// is therefore ciphertext: the SFU forwards packets it cannot read, which is all it ever needed to
// do.
//
// WHERE THE KEY COMES FROM
// An encrypted meeting has a secret that the server never sees. It is made in the organiser's
// browser when the meeting is, carried in the meeting's link after the `#` -- a part of an
// address that browsers never send anywhere -- kept on each device that opened that link, and
// passed from person to person however they like: the organiser sends the link themselves.
// The page hands this worker the secret as a key it can derive from and cannot read back, and
// every sender's frames are encrypted with a key of their own, derived from the secret and the
// sender's seat in the room:
//     frame key = HKDF-SHA-256(secret, salt = meeting code, info = "cfmail meet e2ee v1 " + seat)
// One key per sender and per sitting keeps each key's use far below what AES-GCM with random IVs
// can bear, even in a room that stays open for months.
//
// WHAT STAYS IN THE CLEAR
// A few bytes at the front of each frame, because the network needs them: the first 10 bytes of
// a VP8 key frame and 3 of a delta frame carry what an SFU reads to tell a key frame from the
// rest; the first byte of an Opus frame says how it is laid out. Those bytes are still
// authenticated, as additional data, so they cannot be changed in transit either.
//
// The layout of an encrypted frame:
//   [clear header][AES-256-GCM ciphertext + 16-byte tag][12-byte IV][1-byte format]
//
// Without the secret nothing is sent. A frame that cannot be encrypted is dropped, never passed
// on as it was -- an encrypted meeting that falls back to plaintext for a second is not one.
//
// 会议媒体的端到端加密,一帧一帧地做。
//
// 浏览器发出的每一帧,都在编码器之后、打包之前在这里加密;收到的每一帧,都在解码器之前在这里解密。
// 于是经过 Cloudflare 的是密文:SFU 转发它读不懂的包,而这本来就是它唯一需要做的事。
//
// 钥匙从哪来
// 加密会议有一个服务端永远看不到的秘密。它在组织者创建会议时由他的浏览器生成,放在会议链接的 `#` 之后
// —— 地址里浏览器从不发往任何地方的那一段 —— 保存在每台打开过这条链接的设备上,并由人们自己想办法彼此传递:
// 链接由组织者亲手发出去。页面把这个秘密以"可用来派生、却读不回来"的钥匙形式交给这个 worker,
// 每个发送者的帧都用他自己的一把钥匙加密,由秘密和他在房间里的座位派生:
//     帧钥匙 = HKDF-SHA-256(秘密, salt = 会议短码, info = "cfmail meet e2ee v1 " + 座位)
// 每个发送者、每次入座各用一把钥匙,使每把钥匙的使用量远低于随机 IV 的 AES-GCM 所能承受的上限,
// 即使一间会议室连开几个月也是如此。
//
// 什么留在明文
// 每帧开头的几个字节,因为网络需要它们:VP8 关键帧的前 10 个字节、普通帧的前 3 个字节,
// 是 SFU 分辨关键帧要读的东西;Opus 帧的第一个字节说明它的结构。这几个字节仍作为附加数据参与认证,
// 所以传输途中同样改不得。
//
// 加密后一帧的样子:
//   [明文头][AES-256-GCM 密文 + 16 字节标签][12 字节 IV][1 字节格式号]
//
// 没有秘密就什么都不发。加密不了的帧会被丢掉,绝不原样放行 —— 一场"有一秒是明文"的加密会议,不算加密会议。

const FORMAT = 1;
let base = null;   // the secret, as an HKDF key / 秘密,以 HKDF 钥匙的形式
let salt = null;
const derived = new Map(); // seat -> Promise<CryptoKey>
const pipes = new Map();   // id -> the options a pipe reads on every frame / 每帧都会去读的那份选项
const stats = { encrypted: 0, decrypted: 0, failed: 0, noKey: 0 };

function keyFor(seat) {
  let k = derived.get(seat);
  if (!k) {
    k = crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(`cfmail meet e2ee v1 ${seat}`) },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    derived.set(seat, k);
  }
  return k;
}

function clearBytes(kind, frame) {
  if (kind === 'audio') return 1;
  return frame.type === 'key' ? 10 : 3;
}

async function encrypt(o, frame, controller) {
  if (!base || !o.peer) { stats.noKey++; return; }
  const key = await keyFor(o.peer);
  const data = new Uint8Array(frame.data);
  const n = Math.min(clearBytes(o.kind, frame), data.byteLength);
  // Random per frame: a counter would have to survive every renegotiation to stay unique.
  // 每帧随机:计数器得熬过每一次重协商才能保证不重复。
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: data.subarray(0, n) }, key, data.subarray(n)));
  const out = new Uint8Array(n + sealed.byteLength + 13);
  out.set(data.subarray(0, n), 0);
  out.set(sealed, n);
  out.set(iv, n + sealed.byteLength);
  out[out.byteLength - 1] = FORMAT;
  frame.data = out.buffer;
  stats.encrypted++;
  controller.enqueue(frame);
}

async function decrypt(o, frame, controller) {
  if (!base || !o.peer) { stats.noKey++; return; }
  const data = new Uint8Array(frame.data);
  const n = clearBytes(o.kind, frame);
  if (data.byteLength < n + 16 + 13 || data[data.byteLength - 1] !== FORMAT) { stats.failed++; return; }
  const iv = data.subarray(data.byteLength - 13, data.byteLength - 1);
  try {
    const key = await keyFor(o.peer);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: data.subarray(0, n) }, key, data.subarray(n, data.byteLength - 13)));
    const out = new Uint8Array(n + plain.byteLength);
    out.set(data.subarray(0, n), 0);
    out.set(plain, n);
    frame.data = out.buffer;
    stats.decrypted++;
    controller.enqueue(frame);
  } catch {
    // A different secret, a damaged frame, or a frame that was never encrypted. Dropped: the
    // decoder is better off waiting for the next key frame than chewing on noise.
    // 不同的秘密、损坏的帧,或者根本没加密过的一帧。丢掉:解码器与其嚼一堆噪声,不如等下一个关键帧。
    stats.failed++;
  }
}

function pipe(readable, writable, o) {
  if (o.id) pipes.set(o.id, o);
  const work = o.operation === 'encrypt' ? encrypt : decrypt;
  readable
    .pipeThrough(new TransformStream({
      transform: (frame, controller) => {
        // An empty frame carries nothing to hide. / 空帧里没有要藏的东西。
        if (!frame.data || frame.data.byteLength === 0) { controller.enqueue(frame); return undefined; }
        return work(o, frame, controller);
      },
    }))
    .pipeTo(writable)
    .catch(() => { /* the track ended / 轨道结束了 */ });
}

// The standard way: the browser hands each transform to this worker by itself.
// 标准做法:浏览器自己把每个变换交给这个 worker。
self.onrtctransform = (event) => {
  const t = event.transformer;
  pipe(t.readable, t.writable, t.options || {});
};

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'secret') {
    base = m.key;
    salt = new TextEncoder().encode(String(m.salt || ''));
    derived.clear();
  } else if (m.type === 'streams') {
    // The older Chrome way: the page takes the streams out and posts them here.
    // 旧版 Chrome 的做法:页面把流取出来、再投递到这里。
    pipe(m.readable, m.writable, { operation: m.operation, kind: m.kind, peer: m.peer, id: m.id });
  } else if (m.type === 'retarget') {
    // The same receiver now carries somebody else's frames. / 同一个接收端现在承载的是别人的帧。
    const o = pipes.get(m.id);
    if (o) o.peer = m.peer;
  } else if (m.type === 'stats') {
    self.postMessage({ type: 'stats', id: m.id, stats: { ...stats, ready: !!base } });
  }
};
