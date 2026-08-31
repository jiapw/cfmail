import type { Addr } from './types';

export const uid = () => crypto.randomUUID();
export const now = () => Date.now();

/**
 * The label the web client is served under -- the "mail" in mail.example.com.
 *
 * It is not a constant. Whoever deployed this chose it (--entry) and it went into APP_ORIGIN, so
 * that is where it is read back from. It used to be written out as "intl-mail" in half a dozen
 * places, which is the subdomain this was developed under: every one of those places worked
 * perfectly for the deployment they were written in and quietly did the wrong thing in anybody
 * else's -- invite links pointing at a host that does not exist, branding that never resolved.
 *
 * 提供网页客户端的那一段标签 —— mail.example.com 里的 "mail"。
 *
 * 它不是常量。部署的人选了它(--entry),它进了 APP_ORIGIN,所以就从那儿读回来。
 * 从前它以 "intl-mail" 的字面量散落在五六个地方 —— 那是本项目开发时用的子域:
 * 每一处在写它的那套部署里都完美工作,而在别人的部署里悄悄做错事 ——
 * 邀请链接指向一个不存在的主机、品牌永远解析不出来。
 */
export function entryLabel(env: { APP_ORIGIN?: string }): string {
  try {
    const host = new URL(env.APP_ORIGIN || '').hostname;
    // A host with no dot is somebody's localhost, which has no entry label to speak of.
    // 不带点的主机是某人的 localhost,谈不上入口标签。
    return host.includes('.') ? host.split('.')[0] : '';
  } catch {
    return '';
  }
}

/** The company domain whose entry host this is, or '' when the host is not one of them.
 *  这个 Host 属于哪个企业域名;它若不是某个入口主机则返回 ''。 */
export function domainFromHost(env: { APP_ORIGIN?: string }, host: string): string {
  const entry = entryLabel(env);
  const h = String(host || '').toLowerCase().split(':')[0];
  if (!entry) return '';
  return h.startsWith(entry + '.') ? h.slice(entry.length + 1) : '';
}

export function b64encode(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * A password for somebody who will read it off one screen and type it into another.
 *
 * So the alphabet leaves out the characters that are read wrong when that happens -- l and I and
 * 1, O and 0 -- which costs a few bits and saves the support call. What is left still gives
 * ninety-odd bits at this length, far past anything the login can be made to answer for: it is
 * rate-limited, locked after five wrong tries, and hashed with a hundred thousand rounds.
 *
 * The draw is rejection-sampled rather than a modulo of a random byte. Taking 256 % 55 as a
 * shortcut would make the first 36 letters of the alphabet slightly likelier than the rest --
 * a small bias, cheaply avoided, and the sort that survives for years once written.
 *
 * 给人看着一块屏幕、往另一块屏幕上敲的密码。
 *
 * 所以字母表里去掉了在这个过程中会被认错的字符 —— l 和 I 和 1、O 和 0 —— 少几个比特,
 * 省一通求助电话。剩下的在这个长度上仍有九十多比特,远超登录这道门能被逼问出来的极限:
 * 它有限流、错五次锁定,而且哈希跑十万轮。
 *
 * 取值用拒绝采样,而不是拿随机字节对 55 取模。图省事那么写,会让字母表前 36 个字符
 * 比其余的略微更常出现 —— 偏差不大、避开也不贵,而这种东西一旦写下就会活很多年。
 */
export function randomPassword(len = 16): string {
  const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < len) {
    const buf = crypto.getRandomValues(new Uint8Array(len));
    for (const b of buf) {
      if (b >= limit) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return out;
}

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const isEmail = (s: string) => EMAIL_RE.test(s);

/** Lowercase and trim; used for every address comparison
 *  小写、去空白;用于所有地址比较 */
export function normalizeAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

/** Delivery address with any +tag removed, used to match a mailbox account
 *  去掉 +tag 的投递地址,用于匹配邮箱账号 */
export function routingAddr(addr: string): string {
  const a = normalizeAddr(addr);
  const at = a.lastIndexOf('@');
  if (at < 0) return a;
  let local = a.slice(0, at);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  return `${local}@${a.slice(at + 1)}`;
}

/** Parse an address list shaped like "Name <a@b>, c@d"
 *  解析 "Name <a@b>, c@d" 形式的地址串 */
export function parseAddrList(input: string): Addr[] {
  const out: Addr[] = [];
  if (!input) return out;
  const re = /(?:"([^"]*)"\s*|([^<>,;"]*?)\s*)?<([^<>\s,;]+@[^<>\s,;]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const addr = normalizeAddr(m[3] || m[4] || '');
    if (!isEmail(addr)) continue;
    const name = (m[1] || m[2] || '').trim();
    out.push({ name, addr });
  }
  return out;
}

export function snippetOf(text: string | undefined, html: string | undefined): string {
  let t = (text || '').trim();
  if (!t && html) t = htmlToText(html);
  return t.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function jsonTry<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * Subject normalisation: repeatedly strip "short prefix + colon" (Re: / Fwd: / and their
 * Chinese equivalents, Re[2]: and so on, full-width colons included).
 * prefixed=true means the original subject carried a prefix, i.e. it is a reply or forward
 * and may take part in subject-based conversation merging.
 * 主题归一化:循环剥掉"短前缀 + 冒号"(Re: / Fwd: / 回复: / 转发: / Re[2]: 等,支持全角冒号)。
 * prefixed=true 表示原主题带前缀(是回复/转发类),可参与按主题归并会话。
 */
const SUBJECT_PREFIX_RE = /^(?:re|fw|fwd|aw|wg|sv|回复|回覆|答复|答覆|转发|轉發|回信)(?:\s*\[\d+\])?\s*[:：]\s*/i;
export function normalizeSubject(s: string): { norm: string; prefixed: boolean } {
  let t = (s || '').trim();
  let prefixed = false;
  while (SUBJECT_PREFIX_RE.test(t)) {
    t = t.replace(SUBJECT_PREFIX_RE, '');
    prefixed = true;
  }
  return { norm: t.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300), prefixed };
}

/** Queries containing CJK, or too short, go through LIKE; everything else through FTS
 *  含 CJK 或过短的查询走 LIKE,其余走 FTS */
export function hasCJK(s: string): boolean {
  return /[぀-ヿ㐀-鿿가-힯豈-﫿]/.test(s);
}

/** Build a safe FTS5 MATCH expression: quote each term and make it a prefix match
 *  组一个安全的 FTS5 MATCH 表达式:每个词加引号做前缀匹配 */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');
}
