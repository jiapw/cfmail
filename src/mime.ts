import type { Addr } from './types';
import { b64encode } from './util';

const CRLF = '\r\n';

function needsEncoding(s: string): boolean {
  return /[^\x20-\x7e]/.test(s);
}

/** RFC 2047 encoded-word(UTF-8/B) */
export function encWord(s: string): string {
  if (!needsEncoding(s)) return s;
  const bytes = new TextEncoder().encode(s);
  return `=?UTF-8?B?${b64encode(bytes)}?=`;
}

function fmtAddr(a: Addr): string {
  if (!a.name) return a.addr;
  const name = needsEncoding(a.name) ? encWord(a.name) : /[",<>@;:\\]/.test(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : a.name;
  return `${name} <${a.addr}>`;
}

function fmtAddrList(list: Addr[]): string {
  return list.map(fmtAddr).join(',' + CRLF + ' ');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function rfc5322Date(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Wrap base64 content at 76 columns
 *  base64 内容按 76 列换行 */
function b64lines(bytes: Uint8Array): string {
  const b = b64encode(bytes);
  const lines: string[] = [];
  for (let i = 0; i < b.length; i += 76) lines.push(b.slice(i, i + 76));
  return lines.join(CRLF);
}

export interface MimeAttachment {
  filename: string;
  mime: string;
  data: Uint8Array;
  cid?: string; // 内联图片的 Content-ID(不含尖括号)
}

export interface BuildMimeOptions {
  from: Addr;
  to: Addr[];
  cc?: Addr[];
  subject: string;
  text: string;         // 纯文本正文(有 html 时作为兜底)
  html?: string;        // 富文本正文
  inReplyTo?: string;   // 形如 <id@domain>
  references?: string;  // 空格分隔的 <id> 列表
  attachments?: MimeAttachment[];
  inlineImages?: MimeAttachment[];
  domain: string;       // 用于生成 Message-ID
  date?: Date;
}

export interface BuiltMime {
  raw: Uint8Array;
  messageId: string;
}

const newBoundary = () => `=_cfmail_${crypto.randomUUID().replace(/-/g, '')}`;

/** Wrap several sub-parts into one multipart part (returns the complete part text, including its own headers)
 *  把若干子部件包成一个 multipart 部件(返回完整部件文本,含自身头部) */
function multipart(subtype: string, parts: string[], extraParams = ''): string {
  const b = newBoundary();
  const body =
    parts.map((p) => `--${b}${CRLF}${p}`).join(CRLF) + `${CRLF}--${b}--${CRLF}`;
  return `Content-Type: multipart/${subtype}; boundary="${b}"${extraParams}${CRLF}${CRLF}${body}`;
}

function textPartOf(mime: string, content: string): string {
  return (
    `Content-Type: ${mime}; charset=utf-8${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    b64lines(new TextEncoder().encode(content))
  );
}

function filePartOf(att: MimeAttachment, inline = false): string {
  const fname = att.filename || 'attachment';
  const encName = needsEncoding(fname)
    ? `filename*=UTF-8''${encodeURIComponent(fname)}`
    : `filename="${fname.replace(/"/g, '')}"`;
  const cid = inline && att.cid ? `Content-ID: <${att.cid}>${CRLF}` : '';
  return (
    `Content-Type: ${att.mime || 'application/octet-stream'}${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}` +
    cid +
    `Content-Disposition: ${inline ? 'inline' : 'attachment'}; ${encName}${CRLF}${CRLF}` +
    b64lines(att.data)
  );
}

/**
 * Assemble the outbound MIME tree, nesting only as deep as needed:
 *   multipart/mixed              <- when there are regular attachments
 *   \-- multipart/related        <- when there are inline images
 *       \-- multipart/alternative <- when there is an HTML body (text/plain + text/html)
 * Plain text with no attachments stays a single text/plain, exactly as before.
 * 组装出站 MIME。按需嵌套,不多包一层:
 *   multipart/mixed            ← 有普通附件时
 *   └── multipart/related      ← 有内联图片时
 *       └── multipart/alternative  ← 有 HTML 正文时(text/plain + text/html)
 * 纯文本且无附件时就是单个 text/plain,和以前一致。
 */
export function buildMime(o: BuildMimeOptions): BuiltMime {
  const messageId = `<${crypto.randomUUID()}@${o.domain}>`;
  const date = o.date || new Date();
  const head: string[] = [];
  head.push(`Date: ${rfc5322Date(date)}`);
  head.push(`From: ${fmtAddr(o.from)}`);
  if (o.to.length) head.push(`To: ${fmtAddrList(o.to)}`);
  if (o.cc && o.cc.length) head.push(`Cc: ${fmtAddrList(o.cc)}`);
  head.push(`Subject: ${encWord(o.subject || '')}`);
  head.push(`Message-ID: ${messageId}`);
  if (o.inReplyTo) head.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references) head.push(`References: ${o.references}`);
  head.push('MIME-Version: 1.0');
  head.push('X-Mailer: cfmail');

  const inlines = (o.inlineImages || []).filter((a) => a.cid);
  const attachments = o.attachments || [];

  // 1) Body: with HTML it becomes an alternative (plain-text fallback first, HTML second)
  // 1) 正文:有 HTML 就是 alternative(纯文本兜底在前,HTML 在后)
  let part = o.html
    ? multipart('alternative', [textPartOf('text/plain', o.text || ''), textPartOf('text/html', o.html)])
    : textPartOf('text/plain', o.text || '');

  // 2) Inline images: wrap in related, with the type parameter pointing at the body part type
  // 2) 内联图片:包一层 related,type 参数指向正文部件类型
  if (inlines.length) {
    part = multipart(
      'related',
      [part, ...inlines.map((a) => filePartOf(a, true))],
      `; type="${o.html ? 'multipart/alternative' : 'text/plain'}"`
    );
  }

  // 3) Regular attachments: the outermost mixed
  // 3) 普通附件:最外层 mixed
  if (attachments.length) {
    part = multipart('mixed', [part, ...attachments.map((a) => filePartOf(a, false))]);
  }

  // The top-level part's headers are merged into the message headers
  // 顶层部件的头部并入邮件头
  const sep = part.indexOf(CRLF + CRLF);
  head.push(part.slice(0, sep));
  const body = part.slice(sep + 4);

  const rawStr = head.join(CRLF) + CRLF + CRLF + body;
  return { raw: new TextEncoder().encode(rawStr), messageId };
}
