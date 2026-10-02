// The secret of an end-to-end encrypted meeting, on this side of the wire only.
//
// The secret is made here, in the organiser's browser, when an encrypted meeting is made. It
// lives in two places and nowhere else: after the `#` of the meeting's link, which browsers never
// send to any server, and in the local storage of each device that has opened that link. The
// server stores that a meeting is encrypted, and never anything that would let it read one --
// it never sees the secret, so it cannot hand it out either: an invitation mailed through it goes
// without the secret, and the organiser passes the full link on by some other way they trust.
//
// What the page does with the secret is give it to the frame worker (e2ee-worker.js) as a key it
// can derive from, and attach that worker to every sender and receiver of the meeting.
//
// 端到端加密会议的秘密,只存在于线路的这一头。
//
// 秘密在组织者创建加密会议时,由他的浏览器在这里生成。它只存在于两个地方,别无他处:会议链接的 `#` 之后
// —— 浏览器从不把这一段发往任何服务器 —— 以及每台打开过这条链接的设备的本地存储里。服务端只记得
// "这场会议是加密的",从不保存任何能让它读懂会议的东西 —— 它看不到秘密,所以也发不出去:
// 经由它寄出的邀请邮件不含秘密,完整链接由组织者用他自己信任的别的方式转交。
//
// 页面拿秘密做的事,是把它以"可用来派生"的钥匙形式交给帧 worker(e2ee-worker.js),
// 并把这个 worker 挂到会议的每一个发送端和接收端上。
import { store } from '../app.js';

const KEY = (code) => `cf_meet_e2ee_${code}`;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** Whether this browser can encrypt media frames at all. / 这个浏览器到底能不能加密媒体帧。 */
export function e2eeSupported() {
  return typeof window.RTCRtpScriptTransform === 'function'
    || typeof window.RTCRtpSender?.prototype?.createEncodedStreams === 'function';
}

/** Thirty-two random bytes, as the 43 characters that go in a link. / 32 个随机字节,写成放进链接的 43 个字符。 */
export function newSecret() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export const validSecret = (s) => SECRET_RE.test(String(s || ''));

export function rememberSecret(code, secret) {
  if (!validSecret(secret)) return;
  try { localStorage.setItem(KEY(code), secret); } catch { /* private mode: the link still carries it / 隐私模式:链接里仍带着它 */ }
}

export function recallSecret(code) {
  try { const s = localStorage.getItem(KEY(code)) || ''; return validSecret(s) ? s : ''; } catch { return ''; }
}

export function forgetSecret(code) {
  try { localStorage.removeItem(KEY(code)); } catch { /* nothing to forget / 无可忘 */ }
}

/** The secret in whatever somebody pasted: a whole link, the query of one, or the secret alone.
 *  从别人粘贴的任何东西里取出秘密:整条链接、链接的查询部分,或单独的秘密。 */
export function secretFrom(text) {
  const s = String(text || '').trim();
  if (validSecret(s)) return s;
  // A whole link, or just the query the router hands over (which starts without its `?`).
  // 整条链接,或者路由交过来的那段查询字符串(开头没有 `?`)。
  const m = /(?:^|[?&])e2ee=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(s);
  return m ? m[1] : '';
}

/** A meeting link with the secret added after the `#`, where it stays on the devices it is given to.
 *  在 `#` 之后加上秘密的会议链接 —— 秘密留在收到它的设备上。 */
export function withSecret(link, secret) {
  if (!secret) return link;
  const hash = link.indexOf('#');
  if (hash < 0) return link;
  return `${link}${link.indexOf('?', hash) >= 0 ? '&' : '?'}e2ee=${secret}`;
}

/** A short fingerprint of the secret, for people to compare out loud when somebody sees nothing:
 *  two different fingerprints are two different secrets. It says nothing about the secret itself.
 *  秘密的简短指纹,供"有人什么都看不到"时大家口头对一对:指纹不同,秘密就不同。它不泄露秘密本身。 */
export async function fingerprint(secret) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cfmail meet e2ee fingerprint ${secret}`)));
  return [...h.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase().replace(/(.{4})/, '$1-');
}

/** The frame worker, holding one meeting's secret. / 帧 worker,持有一场会议的秘密。 */
export class Crypt {
  constructor(code, secret) {
    this.legacy = typeof window.RTCRtpScriptTransform !== 'function';
    this.worker = new Worker(`/assets/meet/e2ee-worker.js?v=${encodeURIComponent(store.brand?.version || '')}`);
    this.pending = new Map();
    this.seq = 0;
    /** sender/receiver -> { id, peer }: what each end was attached as. / 每个发送端、接收端当初以什么身份挂上去的。 */
    this.attached = new WeakMap();
    this.worker.onmessage = (e) => {
      const m = e.data || {};
      const done = this.pending.get(m.id);
      if (done) { this.pending.delete(m.id); done(m.stats); }
    };
    // Imported so that it cannot be read back out, even by this page. / 以连本页都读不回来的方式导入。
    this.ready = crypto.subtle.importKey('raw', unb64url(secret), 'HKDF', false, ['deriveKey'])
      .then((key) => { this.worker.postMessage({ type: 'secret', key, salt: code }); });
  }

  /** Every frame this sender sends is encrypted, under the sender's own seat. / 这个发送端发出的每一帧都加密,用发送者自己的座位派生钥匙。 */
  attachSend(sender, kind, peer) { this.attach(sender, 'encrypt', kind, peer); }

  /** Every frame from `peer` is decrypted before the decoder sees it. / 来自 `peer` 的每一帧,在解码器看到之前先解密。 */
  attachRecv(receiver, kind, peer) { this.attach(receiver, 'decrypt', kind, peer); }

  /** Once per end. A receiver can be announced again by a later negotiation; its frames are
   *  already going through the worker, and the older Chrome API refuses to be asked twice. If the
   *  end now carries somebody else's track, the worker is told whose key to use from here on.
   *  每个端只挂一次。后来的协商可能再次宣告同一个接收端;它的帧早已在经过 worker,
   *  而旧版 Chrome 的接口也不允许被要两次。如果这个端现在承载的是别人的轨道,就告诉 worker 从此改用谁的钥匙。 */
  attach(end, operation, kind, peer) {
    const had = this.attached.get(end);
    if (had) {
      if (had.peer === peer) return;
      had.peer = peer;
      if (this.legacy) { this.worker.postMessage({ type: 'retarget', id: had.id, peer }); return; }
    }
    const rec = had || { id: ++this.seq, peer };
    this.attached.set(end, rec);
    const options = { operation, kind, peer, id: rec.id };
    if (!this.legacy) {
      end.transform = new window.RTCRtpScriptTransform(this.worker, options);
      return;
    }
    const { readable, writable } = end.createEncodedStreams();
    this.worker.postMessage({ type: 'streams', ...options, readable, writable }, [readable, writable]);
  }

  stats() {
    return new Promise((ok) => {
      const id = ++this.seq;
      this.pending.set(id, ok);
      this.worker.postMessage({ type: 'stats', id });
      setTimeout(() => { if (this.pending.delete(id)) ok(null); }, 1000);
    });
  }

  stop() {
    try { this.worker.terminate(); } catch { /* gone / 已无 */ }
  }
}
