import PostalMime from 'postal-mime';
import type { Env, FolderRole, Addr } from './types';
import { FOLDER_ROLES } from './types';
import { jsonTry, normalizeSubject, now, normalizeAddr, routingAddr, snippetOf, uid } from './util';

export interface MailboxRow {
  id: string;
  domain_id: string;
  local_part: string;
  display_name: string;
  disabled: number;
  domain_name: string;
}

export async function findMailboxByAddress(env: Env, address: string): Promise<MailboxRow | null> {
  const addr = routingAddr(address);
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const direct = await env.DB.prepare(
    `SELECT mb.id, mb.domain_id, mb.local_part, mb.display_name, mb.disabled, d.name AS domain_name
     FROM mailboxes mb JOIN domains d ON d.id = mb.domain_id
     WHERE d.name=?1 AND mb.local_part=?2`
  )
    .bind(domain, local)
    .first<MailboxRow>();
  if (direct) return direct;
  // Receiving alias -> target mailbox (returns the target mailbox and the domain it lives under)
  // 收信别名 → 目标邮箱(返回的是目标邮箱及其所在域名)
  return await env.DB.prepare(
    `SELECT mb.id, mb.domain_id, mb.local_part, mb.display_name, mb.disabled, d2.name AS domain_name
     FROM aliases a
     JOIN domains d ON d.id = a.domain_id
     JOIN mailboxes mb ON mb.id = a.mailbox_id
     JOIN domains d2 ON d2.id = mb.domain_id
     WHERE d.name=?1 AND a.local_part=?2`
  )
    .bind(domain, local)
    .first<MailboxRow>();
}

export async function createSystemFolders(env: Env, mailboxId: string): Promise<void> {
  const validity = Math.floor(now() / 1000);
  const stmts = FOLDER_ROLES.map((f) =>
    env.DB.prepare('INSERT INTO folders (id, mailbox_id, name, role, uidvalidity, uidnext) VALUES (?1,?2,?3,?4,?5,1)').bind(
      uid(),
      mailboxId,
      f.name,
      f.role,
      validity
    )
  );
  await env.DB.batch(stmts);
}

export async function getFolder(env: Env, mailboxId: string, role: FolderRole): Promise<{ id: string } | null> {
  return await env.DB.prepare('SELECT id FROM folders WHERE mailbox_id=?1 AND role=?2').bind(mailboxId, role).first();
}

/** Take the next uid from the destination folder (atomically)
 *  从目标文件夹取下一个 uid(原子) */
export async function allocUid(env: Env, folderId: string): Promise<number> {
  const r = await env.DB.prepare('UPDATE folders SET uidnext=uidnext+1 WHERE id=?1 RETURNING uidnext-1 AS u')
    .bind(folderId)
    .first<{ u: number }>();
  if (!r) throw new Error('folder not found: ' + folderId);
  return r.u;
}

function addrsOf(list: any): Addr[] {
  if (!Array.isArray(list)) return [];
  const out: Addr[] = [];
  for (const it of list) {
    if (it && typeof it.address === 'string') {
      out.push({ name: it.name || '', addr: normalizeAddr(it.address) });
    } else if (it && Array.isArray(it.group)) {
      for (const g of it.group) {
        if (g && typeof g.address === 'string') out.push({ name: g.name || '', addr: normalizeAddr(g.address) });
      }
    }
  }
  return out;
}

function parseRefs(refs: unknown): string[] {
  if (!refs) return [];
  const s = Array.isArray(refs) ? refs.join(' ') : String(refs);
  return (s.match(/<[^<>\s]+>/g) || []).slice(-10);
}

/** Merge into a conversation using In-Reply-To / References
 *  根据 In-Reply-To/References 归并会话 */
async function resolveThread(env: Env, mailboxId: string, messageId: string | null, refs: string[]): Promise<string | null> {
  if (!refs.length) return null;
  const qs = refs.map((_, i) => `?${i + 2}`).join(',');
  const row = await env.DB.prepare(
    `SELECT thread_id FROM messages WHERE mailbox_id=?1 AND message_id IN (${qs}) ORDER BY date DESC LIMIT 1`
  )
    .bind(mailboxId, ...refs)
    .first<{ thread_id: string }>();
  return row ? row.thread_id : null;
}

export interface IngestOptions {
  mailboxId: string;
  buf: ArrayBuffer;
  r2Key: string;
  size: number;
  folderRole?: FolderRole; // 默认 inbox(且可能被垃圾判定改写为 spam)
  direction?: 'in' | 'out';
  seen?: boolean;
  flagged?: boolean;
  outboxId?: string | null;
  threadIdHint?: string | null;
  envelopeFrom?: string;
  /** Migration import: keep the Date header as the timestamp, carry internal_date along with it, and skip spam classification
   *  迁移导入:保留 Date 头作为时间、internal_date 也跟着走、不做垃圾判定 */
  keepDate?: boolean;
}

/** Parse and store. Returns the message id. Parse errors propagate; the caller writes a "failed" placeholder row.
 *  解析 + 入库。返回 message id。解析异常抛出,由调用方落"failed"占位行 */
/**
 * When the browser has already parsed the message with the same postal-mime build, the result
 * is passed straight in so the Worker never parses it twice -- the CPU saved across a migration
 * of tens of thousands of messages is substantial.
 * Field names match postal-mime's output, and the attachment order must match too (downloads
 * locate parts by part_index).
 * 浏览器端已经用同一个 postal-mime 解析过时,把结果直接喂进来,
 * Worker 就不必再解析一遍 —— 批量迁移几万封时省下的 CPU 很可观。
 * 字段名与 postal-mime 的输出保持一致,附件顺序也必须一致(下载按 part_index 定位)。
 */
export interface PreParsed {
  from?: { name?: string; address?: string } | null;
  to?: any;
  cc?: any;
  bcc?: any;
  replyTo?: any;
  subject?: string;
  text?: string;
  html?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: { filename?: string; mimeType?: string; size?: number; contentId?: string; disposition?: string }[];
}

export async function ingestEml(env: Env, o: IngestOptions & { pre?: PreParsed }): Promise<string> {
  // With a parse result already in hand, skip parsing; o.buf still goes into R2 as usual
  // 有现成的解析结果就不再解析;o.buf 仍然照常存进 R2
  const parsed: any = o.pre ?? (await new PostalMime().parse(o.buf));

  const from: Addr = parsed.from
    ? { name: parsed.from.name || '', addr: normalizeAddr(parsed.from.address || '') }
    : { name: '', addr: normalizeAddr(o.envelopeFrom || '') };
  const to = addrsOf(parsed.to);
  const cc = addrsOf(parsed.cc);
  const bcc = addrsOf((parsed as any).bcc);
  const replyTo = addrsOf((parsed as any).replyTo);
  const subject = (parsed.subject || '').slice(0, 500);
  const snippet = snippetOf(parsed.text || undefined, parsed.html || undefined);
  // A migration import must keep the original timestamp: even for "sent" mail, never fall back to now()
  // 迁移导入时必须保留原始时间:即使是"已发送",也不能按 now() 算
  let date = o.keepDate
    ? Date.parse(parsed.date || '') || now()
    : o.direction === 'out'
    ? now()
    : Date.parse(parsed.date || '') || now();
  // A Date header in the future is treated as the receive time, so it cannot pin itself to the top of the list
  // 未来时间的 Date 头按接收时间算,避免排序被顶到最上面
  if (date > now() + 24 * 3600 * 1000) date = now();

  let folderRole: FolderRole = o.folderRole || 'inbox';
  // Imported old mail skips spam classification: put it wherever it was filed originally
  // 导入的老邮件不再做垃圾判定:当年怎么归的就怎么放
  if (!o.keepDate && folderRole === 'inbox' && (o.direction || 'in') === 'in') {
    const auth = (parsed.headers || []).find((h: any) => h.key === 'authentication-results');
    if (auth && /dmarc=fail/i.test(String(auth.value || ''))) folderRole = 'spam';
  }

  const messageId = (parsed.messageId || '').slice(0, 300) || null;
  const inReplyTo = ((parsed as any).inReplyTo || '').slice(0, 300) || null;
  const refs = [...new Set([...(inReplyTo ? [inReplyTo] : []), ...parseRefs((parsed as any).references)])];
  const { norm: subjectNorm, prefixed } = normalizeSubject(subject);

  let threadId = o.threadIdHint || (await resolveThread(env, o.mailboxId, messageId, refs));
  // When References does not match: a subject differing only by a short prefix (Re:, Fwd:, ...) counts as the same conversation, within a 90-day window
  // References 匹配不到时:主题仅多了短前缀(Re:/回复:/转发: 等)视为同一会话,90 天窗口
  if (!threadId && prefixed && subjectNorm) {
    const row = await env.DB.prepare(
      `SELECT thread_id FROM messages WHERE mailbox_id=?1 AND subject_norm=?2 AND date > ?3 ORDER BY date DESC LIMIT 1`
    )
      .bind(o.mailboxId, subjectNorm, now() - 90 * 24 * 3600 * 1000)
      .first<{ thread_id: string }>();
    if (row) threadId = row.thread_id;
  }
  const id = uid();
  if (!threadId) threadId = id;

  const folder = await getFolder(env, o.mailboxId, folderRole);
  if (!folder) throw new Error('missing folder ' + folderRole);
  const u = await allocUid(env, folder.id);

  // Pre-parsed attachments carry metadata only (the bytes stay in the raw MIME in R2), so we must not require content
  // 预解析的附件只带元数据(内容仍在 R2 的原始 MIME 里),所以不能要求有 content
  const atts = (parsed.attachments || []).filter((a: any) => a && (o.pre || a.content));
  const realAtts = atts.filter((a: any) => a.disposition !== 'inline' || a.filename);

  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, folder_id, uid, thread_id, message_id, in_reply_to, subject, subject_norm,
       from_addr, from_name, to_json, cc_json, bcc_json, reply_to, snippet, date, internal_date, size, r2_key,
       has_attachments, direction, outbox_id, flag_seen, flag_answered, parse_status)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?24,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,0,'ok')`
  )
    .bind(
      id,
      o.mailboxId,
      folder.id,
      u,
      threadId,
      messageId,
      inReplyTo,
      subject,
      from.addr,
      from.name,
      JSON.stringify(to),
      JSON.stringify(cc),
      JSON.stringify(bcc),
      replyTo.length ? replyTo[0].addr : null,
      snippet,
      date,
      o.keepDate ? date : now(),
      o.size,
      o.r2Key,
      realAtts.length ? 1 : 0,
      o.direction || 'in',
      o.outboxId || null,
      o.seen ? 1 : 0,
      subjectNorm
    )
    .run();

  // Attachment metadata (the bytes stay in the raw MIME in R2 and are extracted by part_index on download)
  // 附件元数据(内容仍在 R2 的原始 MIME 里,下载时按 part_index 提取)
  if (atts.length) {
    const stmts = atts.map((a: any, i: number) =>
      env.DB.prepare(
        'INSERT INTO attachments (id, message_id, part_index, filename, mime, size, content_id) VALUES (?1,?2,?3,?4,?5,?6,?7)'
      ).bind(
        uid(),
        id,
        i,
        (a.filename || '').slice(0, 300),
        a.mimeType || 'application/octet-stream',
        a.content?.byteLength ?? a.size ?? 0,
        a.contentId ? String(a.contentId).replace(/[<>]/g, '') : null
      )
    );
    await env.DB.batch(stmts);
  }

  // Search text + FTS (kept in sync by application code)
  // 搜索文本 + FTS(应用层维护)
  const bodyText = (parsed.text || (parsed.html ? snippetOf(undefined, parsed.html) : '') || '').slice(0, 20000);
  const addrsText = [from, ...to, ...cc]
    .map((a) => `${a.name} ${a.addr}`)
    .join(' ')
    .slice(0, 2000);
  const ins = await env.DB.prepare('INSERT INTO message_texts (message_id, subject, body, addrs) VALUES (?1,?2,?3,?4)')
    .bind(id, subject, bodyText, addrsText)
    .run();
  const mrow = ins.meta.last_row_id;
  await env.DB.prepare('INSERT INTO messages_fts (rowid, subject, body, addrs) VALUES (?1,?2,?3,?4)')
    .bind(mrow, subject, bodyText, addrsText)
    .run();

  if (o.flagged) {
    await env.DB.prepare('UPDATE messages SET flag_flagged=1 WHERE id=?1').bind(id).run();
  }

  // Collect contacts; a failure here must not block storage. Use this message's timestamp so importing history does not push last_seen to today.
  // 通讯录采集(失败不影响入库)。用这封信的时间,导入历史邮件才不会把 last_seen 顶成今天
  try {
    await recordContacts(env, o.mailboxId, [from, ...to, ...cc], date);
  } catch {}

  return id;
}

/** Placeholder row for a failed parse; cron retries it later. The subject is left empty on
 *  purpose -- the client labels the row from parse_status, so no language is baked in here.
 *  解析失败时的占位行,cron 会重试。主题故意留空:前端按 parse_status 打标签,
 *  这里不写死任何一种语言的文字。 */
export async function insertFailedPlaceholder(
  env: Env,
  o: { mailboxId: string; r2Key: string; size: number; envelopeFrom: string }
): Promise<void> {
  const folder = await getFolder(env, o.mailboxId, 'inbox');
  if (!folder) return;
  const u = await allocUid(env, folder.id);
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, folder_id, uid, thread_id, subject, from_addr, snippet, date, internal_date,
       size, r2_key, direction, parse_status, parse_attempts)
     VALUES (?1,?2,?3,?4,?1,'',?5,'',?6,?6,?7,?8,'in','failed',1)`
  )
    .bind(id, o.mailboxId, folder.id, u, normalizeAddr(o.envelopeFrom), now(), o.size, o.r2Key)
    .run();
}

/** cron: retry messages that failed to parse
 *  cron:重试解析失败的邮件 */
export async function retryFailedParses(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, mailbox_id, r2_key, size, from_addr FROM messages WHERE parse_status='failed' AND parse_attempts < 5 LIMIT 5`
  ).all<any>();
  for (const row of rows.results || []) {
    try {
      const obj = await env.RAW.get(row.r2_key);
      if (!obj) {
        await env.DB.prepare("UPDATE messages SET parse_status='gone', parse_attempts=parse_attempts+1 WHERE id=?1").bind(row.id).run();
        continue;
      }
      const buf = await obj.arrayBuffer();
      const fresh = await ingestEml(env, {
        mailboxId: row.mailbox_id,
        buf,
        r2Key: row.r2_key,
        size: row.size,
        envelopeFrom: row.from_addr,
      });
      // The placeholder is not being deleted so much as replaced: it is the same message, parsed
      // properly this time. Anything a person said about it while it sat there unreadable --
      // which is what a label is -- belongs to the message, so it moves across rather than
      // vanishing with the row that happened to be holding it.
      // 这里的占位行与其说是被删除,不如说是被替换:同一封信,这次解析成功了。
      // 它还读不出来的那段时间里,有人对它做过的判断(标签就是这种判断)属于这封信本身,
      // 所以要跟着搬过去,而不是随着那个恰好承载它的行一起消失。
      await env.DB.prepare(
        'INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ?1, label_id FROM message_labels WHERE message_id=?2'
      ).bind(fresh, row.id).run();
      await env.DB.prepare('DELETE FROM message_labels WHERE message_id=?1').bind(row.id).run();
      await env.DB.prepare('DELETE FROM messages WHERE id=?1').bind(row.id).run();
    } catch (e) {
      await env.DB.prepare('UPDATE messages SET parse_attempts=parse_attempts+1 WHERE id=?1').bind(row.id).run();
      console.log('retry parse failed', row.id, e);
    }
  }
}

/** Nobody owns this recipient address: file a copy (the caller still refuses with 550) for administrators to review
 *  收件地址无人认领:留档(仍由调用方按 550 拒收),供管理员在后台查看 */
export async function logUnrouted(
  env: Env,
  o: { toAddr: string; envelopeFrom: string; buf: ArrayBuffer; r2Key: string; size: number }
): Promise<void> {
  const addr = normalizeAddr(o.toAddr);
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  const d = await env.DB.prepare('SELECT id FROM domains WHERE name=?1').bind(domain).first<any>();

  let subject = '';
  let fromAddr = normalizeAddr(o.envelopeFrom || '');
  let snippet = '';
  try {
    const parsed: any = await new PostalMime().parse(o.buf);
    subject = (parsed.subject || '').slice(0, 500);
    if (parsed.from?.address) fromAddr = normalizeAddr(parsed.from.address);
    snippet = snippetOf(parsed.text || undefined, parsed.html || undefined);
  } catch {
    // File it even when parsing failed -- it just lacks a subject and snippet
    // 解析失败也要留档,只是少了主题/摘要
  }

  await env.DB.prepare(
    `INSERT INTO unrouted (id, domain_id, to_addr, from_addr, subject, snippet, size, r2_key, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
  )
    .bind(uid(), d?.id || null, addr, fromAddr, subject, snippet, o.size, o.r2Key, now())
    .run();
}

/** cron: purge unrouted mail older than 30 days, together with the raw copy in R2
 *  cron:清理超过 30 天的未匹配来信(连同 R2 原件) */
export async function purgeOldUnrouted(env: Env): Promise<void> {
  const rows = await env.DB.prepare('SELECT id, r2_key FROM unrouted WHERE created_at < ?1 LIMIT 200')
    .bind(now() - 30 * 24 * 3600 * 1000)
    .all<any>();
  for (const r of rows.results || []) {
    await env.RAW.delete(r.r2_key).catch(() => {});
    await env.DB.prepare('DELETE FROM unrouted WHERE id=?1').bind(r.id).run();
  }
}

/** Contacts: record one exchange. Local versus external is decided automatically; the mailbox's own address is skipped.
 *  通讯录:记录一次往来。自动判定站内/外部;跳过邮箱自己的地址 */
/**
 * Collect contacts. seenAt carries this message's own timestamp: when importing history, last_seen
 * must not be written as "now", or a contact from ten years ago shows up as "contacted today" and
 * every ordering breaks. MAX guarantees the value only ever moves forward.
 * 采集通讯录。seenAt 传这封信的时间:导入历史邮件时不能把 last_seen 写成"现在",
 * 否则十年前的联系人会变成"今天刚联系过",排序全乱。用 MAX 保证只会往新的方向走。
 */
export async function recordContacts(env: Env, mailboxId: string, people: Addr[], seenAt?: number): Promise<void> {
  const ts = seenAt || now();
  const seen = new Set<string>();
  for (const p of people) {
    const addr = normalizeAddr(p.addr || '');
    if (!addr || !addr.includes('@') || seen.has(addr)) continue;
    seen.add(addr);
    let internal = 0;
    try {
      const mb = await findMailboxByAddress(env, addr);
      if (mb) {
        if (mb.id === mailboxId) continue; // 自己
        internal = 1;
      }
    } catch {}
    // A colleague is written down as trusted, because the deployment already knows who they are.
    // Everybody else starts unknown and stays there until the owner says something -- being
    // external is not itself a reason for suspicion. Once said, what was said is never overwritten.
    // 同事直接记为可信 —— 这套部署本来就知道他是谁。其余所有人从未知开始,
    // 在主人开口之前一直是未知 —— 身在外部本身不构成怀疑的理由。一旦开过口,说过的话不再被覆盖。
    await env.DB.prepare(
      `INSERT INTO contacts (id, mailbox_id, addr, name, internal, times, last_seen, trust)
       VALUES (?1,?2,?3,?4,?5,1,?6,?7)
       ON CONFLICT(mailbox_id, addr) DO UPDATE SET
         times = times + 1, last_seen = MAX(last_seen, ?6), internal = ?5,
         name = CASE WHEN ?4 != '' THEN ?4 ELSE name END`
    )
      .bind(uid(), mailboxId, addr, (p.name || '').slice(0, 80), internal, ts, internal ? 'trusted' : 'unknown')
      .run();
  }
}

const CONTACTS_CURSOR = 'contacts_backfill_cursor';

/** cron: backfill contacts from existing mail (the cursor lives in meta; once finished this idles)
 *  cron:从存量邮件回填通讯录(游标存 meta,跑完后为空转) */
export async function backfillContacts(env: Env): Promise<void> {
  const cur = await env.DB.prepare('SELECT value FROM meta WHERE key=?1').bind(CONTACTS_CURSOR).first<any>();
  if (cur?.value === 'done') return;
  const from = parseInt(cur?.value || '0', 10) || 0;
  const rows = await env.DB.prepare(
    `SELECT rowid AS rid, mailbox_id, from_addr, from_name, to_json, cc_json FROM messages WHERE rowid > ?1 ORDER BY rowid LIMIT 100`
  ).bind(from).all<any>();
  const list = rows.results || [];
  let last = from;
  for (const r of list) {
    last = r.rid;
    const people: Addr[] = [
      { name: r.from_name || '', addr: r.from_addr || '' },
      ...jsonTry<Addr[]>(r.to_json, []),
      ...jsonTry<Addr[]>(r.cc_json, []),
    ];
    try {
      await recordContacts(env, r.mailbox_id, people);
    } catch {}
  }
  const value = list.length < 100 ? 'done' : String(last);
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2')
    .bind(CONTACTS_CURSOR, value)
    .run();
}

/** cron: backfill subject_norm on existing mail (a partial index makes this free once complete)
 *  cron:回填存量邮件的 subject_norm(回填完成后借部分索引零开销) */
export async function backfillSubjectNorm(env: Env): Promise<void> {
  const rows = await env.DB.prepare('SELECT id, subject FROM messages WHERE subject_norm IS NULL LIMIT 100').all<any>();
  for (const r of rows.results || []) {
    const { norm } = normalizeSubject(r.subject || '');
    await env.DB.prepare('UPDATE messages SET subject_norm=?1 WHERE id=?2').bind(norm, r.id).run();
  }
}

/** Delete a message's derived data (FTS / texts / attachments). Whether R2 is also cleaned is up to the caller.
 *  删除消息的派生数据(FTS/texts/attachments),R2 是否删除由调用方决定 */
export async function deleteMessageDerived(env: Env, messageIds: string[]): Promise<void> {
  if (!messageIds.length) return;
  for (const mid of messageIds) {
    const t = await env.DB.prepare('SELECT mrow, subject, body, addrs FROM message_texts WHERE message_id=?1')
      .bind(mid)
      .first<any>();
    if (t) {
      await env.DB.prepare("INSERT INTO messages_fts (messages_fts, rowid, subject, body, addrs) VALUES ('delete',?1,?2,?3,?4)")
        .bind(t.mrow, t.subject, t.body, t.addrs)
        .run();
      await env.DB.prepare('DELETE FROM message_texts WHERE mrow=?1').bind(t.mrow).run();
    }
    await env.DB.prepare('DELETE FROM attachments WHERE message_id=?1').bind(mid).run();
    await env.DB.prepare('DELETE FROM message_labels WHERE message_id=?1').bind(mid).run();
  }
}

