import { AwsClient } from 'aws4fetch';
import { EmailMessage } from 'cloudflare:email';
import type { Env, Addr, User } from './types';
import type { MailboxRow } from './parse';
import { buildMime, type MimeAttachment } from './mime';
// Inline images and regular attachments share the MimeAttachment shape; a cid is what tells them apart
// 内联图片与普通附件都用 MimeAttachment 结构,区别在于是否带 cid
import { findMailboxByAddress, getFolder, allocUid, ingestEml, recordContacts } from './parse';
import { b64encode, jsonTry, now, snippetOf, uid } from './util';
import { HttpError, storedErr } from './errors';

const MAX_ATTEMPTS = 8;
// Cloudflare Email Sending per-message hard limit (a platform limit, not configurable)
// Cloudflare Email Sending 单封硬上限(平台限制,不可配置)
export const CF_MAX_RAW_BYTES = 5 * 1024 * 1024;
// Per-message content limit (attachments + inline images + body, in raw bytes). base64 inflates
// this by roughly 1.37x, which leaves enough headroom to stay under 5MiB.
// Local and external recipients are treated alike: the same message should not be sendable or not depending on who receives it.
// 单封内容上限(附件+内联图+正文的原始字节)。base64 后约 1.37 倍,留足余量压在 5MiB 之内。
// 站内外一视同仁:同一封信不该因为收件人是谁而能发或不能发。
export const MAX_CONTENT_BYTES = Math.floor(3.6 * 1024 * 1024);
// A backstop on the finished MIME; under normal conditions it is never reached
// 成品 MIME 的兜底闸,正常情况下够不着
export const MAX_MESSAGE_BYTES = CF_MAX_RAW_BYTES;

const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/** HTTP send channels: 4xx (except 429) is a permanent failure and is not retried; 5xx and 429 back off and retry
 *  HTTP 发信通道:4xx(除 429)视为永久失败,不再重试;5xx/429 走退避重试 */
const isPermanentHttp = (status: number) => status >= 400 && status < 500 && status !== 429;

export interface SendRequest {
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  text: string;
  html?: string;
  replyToMessageId?: string | null; // messages.id
  attachmentIds: string[];
  /** Inline images referenced by the body: uploads.id -> cid
   *  正文里引用的内联图片:uploads.id → cid */
  inlineImages?: { upload_id: string; cid: string }[];
}

export interface SendResult {
  sentMessageRowId: string;
  internalDelivered: number;
  external: number;
  queued: boolean;
}

/** Send entry point: build the MIME -> deliver locally -> queue external recipients -> write the Sent copy
 *  发送入口:构 MIME → 站内直投 → 外部进 outbox → 写已发送副本 */
export async function queueSend(env: Env, user: User, mailbox: MailboxRow, req: SendRequest): Promise<SendResult> {
  const allRcpts = [...req.to, ...req.cc, ...req.bcc];
  if (!allRcpts.length) throw new HttpError(400, 'e_no_recipients');

  // Suppression list
  // 黑名单
  for (const r of allRcpts) {
    const sup = await env.DB.prepare('SELECT reason FROM suppressions WHERE email=?1').bind(r.addr).first<any>();
    if (sup) throw new HttpError(400, 'e_suppressed', r.addr, sup.reason);
  }

  // Reply context
  // 回复上下文
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadIdHint: string | null = null;
  if (req.replyToMessageId) {
    const orig = await env.DB.prepare(
      'SELECT message_id, in_reply_to, thread_id FROM messages WHERE id=?1 AND mailbox_id=?2'
    )
      .bind(req.replyToMessageId, mailbox.id)
      .first<any>();
    if (orig) {
      threadIdHint = orig.thread_id;
      if (orig.message_id) {
        inReplyTo = orig.message_id;
        references = [orig.in_reply_to, orig.message_id].filter(Boolean).join(' ');
      }
    }
  }

  // Attachments
  // 附件
  const atts: MimeAttachment[] = [];
  let attBytes = 0;
  for (const aid of req.attachmentIds || []) {
    const up = await env.DB.prepare('SELECT * FROM uploads WHERE id=?1 AND user_id=?2').bind(aid, user.id).first<any>();
    if (!up) throw new HttpError(400, 'e_upload_gone');
    const obj = await env.RAW.get(up.r2_key);
    if (!obj) throw new HttpError(400, 'e_upload_expired');
    const data = new Uint8Array(await obj.arrayBuffer());
    attBytes += data.byteLength;
    atts.push({ filename: up.filename, mime: up.mime, data });
  }
  // Inline images referenced from the body (cid)
  // 正文里的内联图片(cid)
  const inlineImages: MimeAttachment[] = [];
  for (const im of req.inlineImages || []) {
    const up = await env.DB.prepare('SELECT * FROM uploads WHERE id=?1 AND user_id=?2').bind(im.upload_id, user.id).first<any>();
    if (!up) continue; // 正文引用了已过期的图片就跳过,不阻断发送
    const obj = await env.RAW.get(up.r2_key);
    if (!obj) continue;
    const data = new Uint8Array(await obj.arrayBuffer());
    attBytes += data.byteLength;
    inlineImages.push({ filename: up.filename || 'image', mime: up.mime, data, cid: im.cid });
  }
  // The site-wide per-message limit: attachments + inline images + body, counted in raw bytes.
  // base64 inflates that by about 1.37x, so 3.6MB lands just inside Cloudflare Email Sending's 5MiB hard cap.
  // 全站统一的单封上限:附件 + 内联图 + 正文,按原始字节算。
  // base64 会把这些撑到约 1.37 倍,3.6MB 正好压在 Cloudflare Email Sending 的 5MiB 硬顶之内。
  const bodyBytes = new TextEncoder().encode((req.text || '') + (req.html || '')).byteLength;
  const contentBytes = attBytes + bodyBytes;
  if (contentBytes > MAX_CONTENT_BYTES) {
    throw new HttpError(
      400,
      'e_mail_too_big', fmtMB(contentBytes), fmtMB(MAX_CONTENT_BYTES)
    );
  }

  const fromAddr = `${mailbox.local_part}@${mailbox.domain_name}`;
  const from: Addr = { name: mailbox.display_name || user.name || '', addr: fromAddr };

  const built = buildMime({
    from,
    to: req.to,
    cc: req.cc,
    subject: req.subject,
    text: req.text,
    html: req.html || undefined,
    inReplyTo,
    references,
    attachments: atts,
    inlineImages,
    domain: mailbox.domain_name,
  });
  if (built.raw.byteLength > MAX_MESSAGE_BYTES) {
    throw new HttpError(400, 'e_encoded_too_big', fmtMB(built.raw.byteLength));
  }

  const outboxId = uid();

  // Split the recipients: local mailboxes are delivered directly, external ones go through a sending channel
  // 收件人分流:站内邮箱直接投递,外部走发信通道
  const internal: { rcpt: Addr; mb: MailboxRow }[] = [];
  const external: Addr[] = [];
  for (const r of allRcpts) {
    const mb = await findMailboxByAddress(env, r.addr);
    if (mb && !mb.disabled) internal.push({ rcpt: r, mb });
    else external.push(r);
  }


  // The Sent copy
  // 已发送副本
  const sentKey = `raw/${outboxId}-sent.eml`;
  await env.RAW.put(sentKey, built.raw);
  const sentRowId = await ingestEml(env, {
    mailboxId: mailbox.id,
    buf: built.raw.buffer.slice(built.raw.byteOffset, built.raw.byteOffset + built.raw.byteLength) as ArrayBuffer,
    r2Key: sentKey,
    size: built.raw.byteLength,
    folderRole: 'sent',
    direction: 'out',
    seen: true,
    outboxId: external.length ? outboxId : null,
    threadIdHint,
  });
  if (req.replyToMessageId) {
    await env.DB.prepare('UPDATE messages SET flag_answered=1 WHERE id=?1').bind(req.replyToMessageId).run();
  }
  try {
    await recordContacts(env, mailbox.id, allRcpts);
  } catch {}

  // Direct local delivery (deduplicated by mailbox)
  // 站内直投(去重邮箱)
  const seenMb = new Set<string>();
  let delivered = 0;
  for (const { mb } of internal) {
    if (seenMb.has(mb.id)) continue;
    seenMb.add(mb.id);
    const key = `raw/${uid()}.eml`;
    await env.RAW.put(key, built.raw);
    try {
      await ingestEml(env, {
        mailboxId: mb.id,
        buf: built.raw.buffer.slice(built.raw.byteOffset, built.raw.byteOffset + built.raw.byteLength) as ArrayBuffer,
        r2Key: key,
        size: built.raw.byteLength,
        folderRole: 'inbox',
        direction: 'in',
        envelopeFrom: fromAddr,
      });
      delivered++;
    } catch (e) {
      console.log('internal delivery failed', mb.id, e);
    }
  }

  // Queue the external recipients
  // 外部收件人入队
  if (external.length) {
    await env.DB.prepare(
      `INSERT INTO outbox (id, mailbox_id, user_id, r2_key, rcpts_json, payload_json, status, next_attempt, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,'queued',?7,?7)`
    )
      .bind(
        outboxId,
        mailbox.id,
        user.id,
        sentKey,
        JSON.stringify(external.map((r) => r.addr)),
        JSON.stringify({
          from: { name: from.name, addr: from.addr },
          to: req.to,
          cc: req.cc,
          bcc: req.bcc,
          subject: req.subject,
          text: req.text,
          attachment_uploads: req.attachmentIds || [],
          message_id: built.messageId,
        }),
        now()
      )
      .run();
  }

  return { sentMessageRowId: sentRowId, internalDelivered: delivered, external: external.length, queued: external.length > 0 };
}

// HttpError now lives in errors.ts alongside the code helpers; re-exported here so the
// existing import sites keep working.
// HttpError 已挪到 errors.ts,和错误码工具放在一起;这里再导出一次,原有 import 路径不用改。
export { HttpError };

interface ProviderResult {
  ok: boolean;
  error?: string;
  permanent?: boolean;
}

/**
 * Cloudflare Email Sending: the raw MIME is delivered once per recipient (separate envelopes,
 * headers preserved intact). On partial success the remaining recipients are returned so the
 * caller can narrow the envelope and retry, which avoids delivering twice.
 * Cloudflare Email Sending:原始 MIME 逐个收件人投递(信封独立,头部完整保留)。
 * 部分成功时返回剩余未投递的收件人,由调用方缩小信封后重试,避免重复投递。
 */
async function sendViaCf(
  env: Env,
  fromAddr: string,
  rcpts: string[],
  raw: ArrayBuffer
): Promise<ProviderResult & { remaining?: string[] }> {
  if (!env.EMAIL) return { ok: false, error: storedErr('e_no_email_binding'), permanent: false };
  if (raw.byteLength > CF_MAX_RAW_BYTES) {
    return { ok: false, error: storedErr('e_cf_too_big', raw.byteLength), permanent: true };
  }
  const rawStr = new TextDecoder().decode(raw);
  const remaining = [...rcpts];
  while (remaining.length) {
    const rcpt = remaining[0];
    try {
      await env.EMAIL.send(new EmailMessage(fromAddr, rcpt, rawStr));
      remaining.shift();
    } catch (e: any) {
      const code = String(e?.code || '');
      const msg = `CF Email ${code}: ${String(e?.message || e).slice(0, 300)}(rcpt: ${rcpt})`;
      // Domain not onboarded or a bad parameter -> permanent failure; quota, rate limit or network -> retry
      // 域名未 onboard / 参数问题 → 永久失败;限额/限速/网络 → 重试
      const permanent = /E_SENDER_NOT_VERIFIED|E_VALIDATION/i.test(code + String(e?.message || ''));
      return {
        ok: false,
        error: permanent ? storedErr('e_cf_send_failed', msg) : msg,
        permanent,
        remaining,
      };
    }
  }
  return { ok: true };
}

async function sendViaSes(env: Env, fromAddr: string, rcpts: string[], raw: Uint8Array): Promise<ProviderResult> {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_REGION) {
    return { ok: false, error: storedErr('e_ses_not_configured'), permanent: false };
  }
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
    service: 'ses',
  });
  const res = await aws.fetch(`https://email.${env.AWS_REGION}.amazonaws.com/v2/email/outbound-emails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      FromEmailAddress: fromAddr,
      Destination: { ToAddresses: rcpts },
      Content: { Raw: { Data: b64encode(raw) } },
    }),
  });
  if (res.ok) return { ok: true };
  const text = (await res.text()).slice(0, 500);
  // 4xx is permanent (a parameter or permission problem), 5xx and 429 retry
  // 4xx 视为永久失败(参数/权限问题),5xx/429 重试
  const permanent = isPermanentHttp(res.status);
  return { ok: false, error: `SES ${res.status}: ${text}`, permanent };
}

async function sendViaResend(env: Env, payload: any, rcpts: string[]): Promise<ProviderResult> {
  if (!env.RESEND_API_KEY) return { ok: false, error: storedErr('e_resend_not_configured'), permanent: false };
  const attachments: any[] = [];
  for (const aid of payload.attachment_uploads || []) {
    const up = await env.DB.prepare('SELECT * FROM uploads WHERE id=?1').bind(aid).first<any>();
    if (!up) continue;
    const obj = await env.RAW.get(up.r2_key);
    if (!obj) continue;
    attachments.push({ filename: up.filename, content: b64encode(new Uint8Array(await obj.arrayBuffer())) });
  }
  const fmt = (a: any) => (a.name ? `${a.name} <${a.addr}>` : a.addr);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fmt(payload.from),
      to: (payload.to || []).map(fmt),
      cc: (payload.cc || []).length ? payload.cc.map(fmt) : undefined,
      bcc: (payload.bcc || []).length ? payload.bcc.map(fmt) : undefined,
      subject: payload.subject,
      text: payload.text,
      attachments: attachments.length ? attachments : undefined,
    }),
  });
  if (res.ok) return { ok: true };
  const text = (await res.text()).slice(0, 500);
  const permanent = isPermanentHttp(res.status);
  return { ok: false, error: `Resend ${res.status}: ${text}`, permanent };
}

/**
 * System mail such as verification codes: never queued, sent synchronously through the channel.
 * The sender is no-reply@<domain>, which must already be onboarded in Email Sending.
 * 系统邮件(验证码等):不入 outbox,直接走通道同步发送。
 * 发件人用 no-reply@<域名>,该域名需已在 Email Sending 里 onboard。
 */
export async function sendSystemMail(
  env: Env,
  domainName: string,
  to: string,
  subject: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const from: Addr = { name: 'CFMail', addr: `no-reply@${domainName}` };
  const built = buildMime({ from, to: [{ name: '', addr: to }], subject, text, domain: domainName });
  try {
    if (env.MAIL_PROVIDER === 'cf') {
      const r = await sendViaCf(
        env,
        from.addr,
        [to],
        built.raw.buffer.slice(built.raw.byteOffset, built.raw.byteOffset + built.raw.byteLength) as ArrayBuffer
      );
      return { ok: r.ok, error: r.error };
    }
    if (env.MAIL_PROVIDER === 'ses') {
      const r = await sendViaSes(env, from.addr, [to], built.raw);
      return { ok: r.ok, error: r.error };
    }
    if (env.MAIL_PROVIDER === 'resend') {
      const r = await sendViaResend(env, { from, to: [{ name: '', addr: to }], cc: [], bcc: [], subject, text }, [to]);
      return { ok: r.ok, error: r.error };
    }
    console.log('[dev provider] verification mail not actually sent ->', to, subject);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

/** cron: drain the outbox
 *  cron:投递 outbox */
export async function processOutbox(env: Env): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT * FROM outbox WHERE status IN ('queued') AND next_attempt <= ?1 ORDER BY created_at LIMIT 10`
  )
    .bind(now())
    .all<any>();

  for (const job of due.results || []) {
    await env.DB.prepare("UPDATE outbox SET status='sending' WHERE id=?1").bind(job.id).run();
    const payload = jsonTry<any>(job.payload_json, {});
    const rcpts = jsonTry<string[]>(job.rcpts_json, []);
    let result: ProviderResult & { remaining?: string[] };

    try {
      if (env.MAIL_PROVIDER === 'cf') {
        const obj = await env.RAW.get(job.r2_key);
        if (!obj) throw new Error('raw mime missing');
        result = await sendViaCf(env, payload.from?.addr || '', rcpts, await obj.arrayBuffer());
        // Partial success: narrow the envelope and retry only the recipients still outstanding
        // 部分成功:缩小信封,重试只补发剩余收件人
        if (!result.ok && result.remaining && result.remaining.length < rcpts.length) {
          await env.DB.prepare('UPDATE outbox SET rcpts_json=?2 WHERE id=?1')
            .bind(job.id, JSON.stringify(result.remaining))
            .run();
        }
      } else if (env.MAIL_PROVIDER === 'ses') {
        const obj = await env.RAW.get(job.r2_key);
        if (!obj) throw new Error('raw mime missing');
        result = await sendViaSes(env, payload.from?.addr || '', rcpts, new Uint8Array(await obj.arrayBuffer()));
      } else if (env.MAIL_PROVIDER === 'resend') {
        result = await sendViaResend(env, payload, rcpts);
      } else {
        console.log('[dev provider] pretending to send', job.id, 'rcpts=', rcpts.join(','));
        result = { ok: true };
      }
    } catch (e: any) {
      result = { ok: false, error: String(e?.message || e).slice(0, 300) };
    }

    if (result.ok) {
      const note = env.MAIL_PROVIDER === 'dev' ? storedErr('e_dev_channel') : null;
      await env.DB.prepare("UPDATE outbox SET status='sent', last_error=?2, attempts=attempts+1 WHERE id=?1")
        .bind(job.id, note)
        .run();
    } else {
      const attempts = (job.attempts || 0) + 1;
      const dead = result.permanent || attempts >= MAX_ATTEMPTS;
      const backoff = Math.min(2 ** attempts, 120) * 60 * 1000;
      await env.DB.prepare(
        `UPDATE outbox SET status=?2, attempts=?3, last_error=?4, next_attempt=?5 WHERE id=?1`
      )
        .bind(job.id, dead ? 'failed' : 'queued', attempts, result.error || 'unknown', now() + backoff)
        .run();
    }
  }
}
