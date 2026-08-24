/**
 * Automatic backup: the mail side of this deployment, copied into a bucket of its own.
 *
 * WHAT IS IN IT
 * Everything an administrator or a user can produce through this application, minus Drive and the
 * assistant: accounts, domains and their settings, mailboxes, folders, messages, labels, drafts,
 * contacts, invites, the audit trail -- and the original bytes of every message, which is where
 * attachments live too, since they are never stored apart from the .eml they arrived in.
 *
 * Sessions and the short-lived tokens beside them are deliberately absent. Restoring a live login
 * is not restoring data, and a password-reset token that comes back from a year-old backup is a
 * key somebody once mailed to an inbox.
 *
 * TWO KINDS OF DATA, TWO STRATEGIES
 * Rows are dumped whole, every day. A true row-level increment would have to know what changed,
 * and most of these tables carry no modification time and no tombstone for a deleted row -- so an
 * increment would silently miss deletions, and a chain of them would restore to something that
 * never existed. A whole dump is a few tens of megabytes; correctness is worth more than that.
 *
 * Message bytes are copied once and never again. They are immutable from the moment they are
 * written, so the pool under mail/ only ever grows, and no daily, monthly or yearly consolidation
 * ever moves them. Moving them would mean reading and rewriting a gigabyte to save nothing, and
 * every move restarts the minimum-duration clock on infrequent-access storage.
 *
 * ROLLUP
 * Daily runs are kept until the month they belong to is over; then the last of them becomes that
 * month's copy and the rest are deleted. Twelve months later the last month becomes the year's
 * copy and the months are deleted. The pool of message bytes is untouched by all of it.
 *
 * 自动备份:把这套部署的邮件一侧,复制到一个自己的桶里。
 *
 * 备了什么
 * 除网盘和 AI 助手之外,管理员和用户能产生的一切:账号、域名及其设置、邮箱、文件夹、邮件、标签、
 * 草稿、通讯录、邀请、审计记录 —— 以及每封信的原始字节;附件也在里面,因为附件从来不与它所在的
 * .eml 分开存放。
 *
 * 会话和它旁边那几种短命令牌有意不备。恢复一个还活着的登录态不叫恢复数据,
 * 而一份从一年前的备份里回来的密码重置令牌,是一把曾经被寄进某个收件箱的钥匙。
 *
 * 两类数据,两种策略
 * 行数据每天整份导出。真正的行级增量得知道"什么变了",而这些表大多没有修改时间、
 * 删掉的行也不留墓碑 —— 增量会悄悄漏掉删除,一串增量叠起来会还原出一个从未存在过的状态。
 * 整份导出不过几十兆,正确性比这几十兆值钱。
 *
 * 邮件字节只复制一次,此后再不搬动。它们写入即不可变,所以 mail/ 下面那个池只增不减,
 * 日、月、年三级合并都不碰它。搬它意味着为了省下零而读写一个 GB,
 * 而且每搬一次都把低频存储的最短计费期重新归零。
 *
 * 合并
 * 日备份保留到它所属的那个月结束,然后其中最后一份成为该月的副本,其余删除。
 * 十二个月后,最后一个月成为该年的副本,月备份删除。邮件池全程不受影响。
 */
import type { Env } from './types';
import { now } from './util';

/**
 * Tables that go into a backup, in an order that a restore can replay top to bottom without
 * tripping over a reference that is not there yet.
 *
 * Absent on purpose: sessions / password_resets / pending_regs (live credentials, see above);
 * messages_fts and its shadow tables (an index over message_texts, rebuilt with one statement);
 * d1_migrations, _cf_KV, sqlite_sequence (the infrastructure's own); chat_* and drive_* (out of
 * scope -- and a Drive tree restored without its bytes would be worse than no Drive at all).
 *
 * 进备份的表,顺序排成"从上往下重放不会撞见还不存在的引用"。
 * 有意不含:sessions / password_resets / pending_regs(活的凭据,理由见上);
 * messages_fts 及其影子表(message_texts 上的索引,一条语句就能重建);
 * d1_migrations、_cf_KV、sqlite_sequence(基础设施自己的);chat_* 与 drive_*(不在范围内 ——
 * 一棵没有字节的网盘目录树,比没有网盘更糟)。
 */
export const BACKUP_TABLES = [
  'users',
  'domains',
  'domain_admins',
  'mailboxes',
  'aliases',
  'grants',
  'folders',
  'labels',
  'messages',
  'message_texts',
  'attachments',
  'message_labels',
  'drafts',
  'outbox',
  'contacts',
  'invites',
  'invite_uses',
  'suppressions',
  'unrouted',
  'uploads',
  'audit_log',
  'meta',
] as const;

/** R2 prefixes whose objects are part of the mail data. brand/ is a domain's logo -- small, and
 *  a restored deployment that has forgotten what the company looks like is a poor restore.
 *  属于邮件数据的 R2 前缀。brand/ 是各域的 logo —— 很小,而一套忘了公司长什么样的恢复不算恢复。 */
export const BACKUP_PREFIXES = ['import/', 'raw/', 'unrouted/', 'brand/'] as const;

const STATE_KEY = 'backup_state';
const ENABLED_KEY = 'backup_enabled';
/** UTC hour the daily run starts. One hour before the trash purge, so a backup always holds the
 *  mail that purge is about to delete.
 *  日备份的启动时刻(UTC)。比清空回收站早一小时,于是备份里总是留着那批即将被删掉的邮件。 */
const START_HOUR = 18;
/** Rows per part file. Small enough that one part is built, compressed and written well inside a
 *  single invocation, even for message_texts, whose rows carry whole message bodies.
 *  每个分片的行数。小到足以在一次调用里完成"取出、压缩、写入" —— 哪怕是每行都带着整封正文的 message_texts。 */
const ROWS_PER_PART = 500;
/** Message objects copied per tick. The cap is wall-clock, not size: each one is a read and a
 *  write, and the run has all day to finish.
 *  每次 tick 复制的邮件对象数。限制的是墙上时间而不是体积:每个对象一读一写,而这次运行有一整天可用。 */
const OBJECTS_PER_TICK = 40;

export type BackupPhase = 'idle' | 'rows' | 'mail' | 'finishing';

export interface BackupState {
  phase: BackupPhase;
  /** The day this run belongs to, as YYYY-MM-DD in UTC / 这次运行属于哪一天(UTC) */
  day: string;
  startedAt: number;
  /** Index into BACKUP_TABLES / 走到第几张表 */
  table: number;
  /** Rows already written for the current table / 当前表已写出的行数 */
  rowOffset: number;
  part: number;
  /** Where the listing of the current prefix stopped / 当前前缀列到哪儿了 */
  prefix: number;
  cursor?: string;
  parts: Record<string, number>;
  copied: number;
  skipped: number;
  bytes: number;
  lastError?: string;
  /** Set when the previous run finished, for the console to show / 上一次跑完时留下的,给后台显示 */
  finishedAt?: number;
  finishedDay?: string;
}

const EMPTY: BackupState = {
  phase: 'idle', day: '', startedAt: 0, table: 0, rowOffset: 0, part: 0,
  prefix: 0, parts: {}, copied: 0, skipped: 0, bytes: 0,
};

export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const utcMonth = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

async function readMeta(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key=?1').bind(key).first<any>();
  return row?.value ?? null;
}

async function writeMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2'
  ).bind(key, value).run();
}

export async function backupEnabled(env: Env): Promise<boolean> {
  return (await readMeta(env, ENABLED_KEY)) === '1';
}

export async function setBackupEnabled(env: Env, on: boolean): Promise<void> {
  await writeMeta(env, ENABLED_KEY, on ? '1' : '0');
}

export async function loadState(env: Env): Promise<BackupState> {
  const raw = await readMeta(env, STATE_KEY);
  if (!raw) return { ...EMPTY };
  try {
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY };
  }
}

async function saveState(env: Env, s: BackupState): Promise<void> {
  await writeMeta(env, STATE_KEY, JSON.stringify(s));
}

/** Ask for a run now, whatever the hour. Refuses while one is already going.
 *  不管几点,现在就跑一次。已经在跑时拒绝。 */
export async function startBackupNow(env: Env): Promise<{ started: boolean; reason?: string }> {
  const s = await loadState(env);
  if (s.phase !== 'idle') return { started: false, reason: 'e_backup_running' };
  await saveState(env, { ...EMPTY, phase: 'rows', day: utcDay(), startedAt: now() });
  return { started: true };
}

const gzip = async (text: string): Promise<ArrayBuffer> => {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([text]).stream().pipeThrough(cs);
  return await new Response(stream).arrayBuffer();
};

/**
 * One slice of work, sized to finish inside a single cron invocation. Called every minute; does
 * nothing at all unless a run is in progress or it is time to start one.
 * 一次可以在单次 cron 调用里跑完的工作切片。每分钟调用一次;没有正在进行的运行、也不到点时,什么都不做。
 */
export async function backupTick(env: Env): Promise<void> {
  if (!env.BACKUP) return;                       // 没绑定备份桶(旧部署),静默跳过
  if (!(await backupEnabled(env))) return;
  const s = await loadState(env);

  if (s.phase === 'idle') {
    const d = new Date();
    if (d.getUTCHours() !== START_HOUR || d.getUTCMinutes() !== 0) return;
    if (s.finishedDay === utcDay()) return;      // 今天已经跑过
    await saveState(env, { ...EMPTY, phase: 'rows', day: utcDay(), startedAt: now(), finishedAt: s.finishedAt, finishedDay: s.finishedDay });
    return;
  }

  try {
    if (s.phase === 'rows') await stepRows(env, s);
    else if (s.phase === 'mail') await stepMail(env, s);
    else if (s.phase === 'finishing') await stepFinish(env, s);
  } catch (e: any) {
    // A failed slice must not wedge the run: record it and let the next minute try the same slice
    // again. Only the state is written, so nothing half-done is ever recorded as done.
    // 一次切片失败不该让整次运行卡死:记下来,下一分钟再试同一片。
    // 只写状态,所以做了一半的东西绝不会被记成做完了。
    s.lastError = String(e?.message || e).slice(0, 300);
    await saveState(env, s);
  }
}

async function stepRows(env: Env, s: BackupState): Promise<void> {
  const table = BACKUP_TABLES[s.table];
  if (!table) {
    s.phase = 'mail';
    s.prefix = 0;
    s.cursor = undefined;
    await saveState(env, s);
    return;
  }
  const rows = await env.DB.prepare(`SELECT * FROM ${table} LIMIT ?1 OFFSET ?2`)
    .bind(ROWS_PER_PART, s.rowOffset).all<any>();
  const list = rows.results || [];
  if (list.length) {
    const body = list.map((r: any) => JSON.stringify(r)).join('\n') + '\n';
    const key = `daily/${s.day}/rows/${table}.${String(s.part).padStart(4, '0')}.ndjson.gz`;
    await env.BACKUP!.put(key, await gzip(body), {
      httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
    });
    s.parts[table] = s.part + 1;
    s.part += 1;
    s.rowOffset += list.length;
  }
  // A short page is the last page. An exactly-full one may or may not be, so it costs one more
  // query to find out -- which is cheaper than being wrong.
  // 不满一页就是最后一页。刚好满页的可能是也可能不是,多问一次才知道 —— 这比猜错便宜。
  if (list.length < ROWS_PER_PART) {
    if (!list.length && s.part === 0) s.parts[table] = 0;   // 空表也要留个记号
    s.table += 1;
    s.rowOffset = 0;
    s.part = 0;
  }
  await saveState(env, s);
}

async function stepMail(env: Env, s: BackupState): Promise<void> {
  const prefix = BACKUP_PREFIXES[s.prefix];
  if (!prefix) {
    s.phase = 'finishing';
    await saveState(env, s);
    return;
  }
  const listed = await env.RAW.list({ prefix, cursor: s.cursor, limit: OBJECTS_PER_TICK });
  for (const obj of listed.objects) {
    const dest = `mail/${obj.key}`;
    // Already in the pool: nothing to do, ever. These objects do not change.
    // 池子里已经有了:此后永远无需再做。这些对象不会变。
    const have = await env.BACKUP!.head(dest);
    if (have) { s.skipped += 1; continue; }
    const src = await env.RAW.get(obj.key);
    if (!src) { s.skipped += 1; continue; }      // 刚被删掉,不是错误
    await env.BACKUP!.put(dest, src.body, {
      httpMetadata: src.httpMetadata,
      customMetadata: { ...(src.customMetadata || {}), backedUpAt: String(now()) },
    });
    s.copied += 1;
    s.bytes += obj.size;
  }
  s.cursor = listed.truncated ? listed.cursor : undefined;
  if (!listed.truncated) { s.prefix += 1; s.cursor = undefined; }
  await saveState(env, s);
}

async function stepFinish(env: Env, s: BackupState): Promise<void> {
  const manifest = {
    day: s.day,
    startedAt: s.startedAt,
    finishedAt: now(),
    tables: s.parts,
    mail: { copied: s.copied, alreadyThere: s.skipped, bytes: s.bytes },
    note: 'rows/*.ndjson.gz 是当天的整份行数据;邮件字节在共用的 mail/ 池里,不随日期复制。',
  };
  await env.BACKUP!.put(`daily/${s.day}/manifest.json`, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
  await rollup(env);
  await saveState(env, { ...EMPTY, finishedAt: manifest.finishedAt, finishedDay: s.day });
}

/**
 * Fold finished periods into one copy each. Runs after every daily run, and does nothing at all
 * on the days when there is nothing to fold -- which is most days.
 *
 * The last day of a month becomes that month; the last month of a year becomes that year. What is
 * folded is copied first and deleted second, so a failure between the two leaves a duplicate
 * rather than a hole.
 *
 * 把已经结束的时段各折成一份。每次日备份之后运行,而在没什么可折的日子里什么也不做 —— 那是大多数日子。
 * 某月的最后一天成为该月,某年的最后一个月成为该年。折叠时先复制后删除,
 * 于是中途失败留下的是一份重复,而不是一个窟窿。
 */
async function rollup(env: Env): Promise<void> {
  const thisMonth = utcMonth();
  const days = await listDirs(env, 'daily/');
  const months = new Set(days.map((d) => d.slice(0, 7)));
  for (const m of months) {
    if (m >= thisMonth) continue;                // 当月还没结束,不动
    const mine = days.filter((d) => d.startsWith(m)).sort();
    const keep = mine[mine.length - 1];
    if (!(await env.BACKUP!.head(`monthly/${m}/manifest.json`))) {
      await copyTree(env, `daily/${keep}/`, `monthly/${m}/`);
    }
    for (const d of mine) await deleteTree(env, `daily/${d}/`);
  }

  const thisYear = String(new Date().getUTCFullYear());
  const got = await listDirs(env, 'monthly/');
  const years = new Set(got.map((m) => m.slice(0, 4)));
  for (const y of years) {
    if (y >= thisYear) continue;
    const mine = got.filter((m) => m.startsWith(y)).sort();
    const keep = mine[mine.length - 1];
    if (!(await env.BACKUP!.head(`yearly/${y}/manifest.json`))) {
      await copyTree(env, `monthly/${keep}/`, `yearly/${y}/`);
    }
    for (const m of mine) await deleteTree(env, `monthly/${m}/`);
  }
}

/** The immediate children of a prefix, e.g. daily/ -> ['2026-08-21', ...]
 *  某个前缀下的直接子目录,例如 daily/ → ['2026-08-21', …] */
async function listDirs(env: Env, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const r: any = await env.BACKUP!.list({ prefix, delimiter: '/', cursor, limit: 500 });
    for (const p of r.delimitedPrefixes || []) out.push(String(p).slice(prefix.length).replace(/\/$/, ''));
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return out;
}

/**
 * Copy one period's small files into their consolidated home, in infrequent-access storage.
 *
 * Only rows and manifests are ever copied here -- tens of megabytes, read perhaps never. That is
 * exactly what the cheaper class is for, and the thirty-day minimum it charges is no cost at all
 * on something kept for a year. The message pool never comes this way; it is written once, in the
 * standard class, and left alone.
 *
 * 把某个时段那几个小文件复制到它合并后的位置,用低频访问存储。
 * 走这条路的只有行数据和清单 —— 几十兆,也许永远不会被读。这正是便宜那一档的用途,
 * 而它收的三十天最短计费期,对一份要留一年的东西等于不收。邮件池不走这条路:
 * 它只写一次、用标准存储、此后不再动它。
 */
async function copyTree(env: Env, from: string, to: string): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const r = await env.BACKUP!.list({ prefix: from, cursor, limit: 200 });
    for (const o of r.objects) {
      const src = await env.BACKUP!.get(o.key);
      if (!src) continue;
      await env.BACKUP!.put(to + o.key.slice(from.length), src.body, {
        httpMetadata: src.httpMetadata,
        storageClass: 'InfrequentAccess',
      });
    }
    if (!r.truncated) break;
    cursor = r.cursor;
  }
}

async function deleteTree(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const r = await env.BACKUP!.list({ prefix, cursor, limit: 500 });
    const keys = r.objects.map((o) => o.key);
    if (keys.length) await env.BACKUP!.delete(keys);
    if (!r.truncated) break;
    cursor = r.cursor;
  }
}

/** What the console shows: the switch, what is running, and what is stored.
 *  后台要显示的东西:开关、正在跑什么、以及存下了什么。 */
export async function backupStatus(env: Env): Promise<any> {
  const enabled = await backupEnabled(env);
  const state = await loadState(env);
  const out: any = {
    enabled,
    bound: !!env.BACKUP,
    phase: state.phase,
    day: state.day,
    started_at: state.startedAt || null,
    finished_at: state.finishedAt || null,
    finished_day: state.finishedDay || null,
    last_error: state.lastError || null,
    table: state.phase === 'rows' ? BACKUP_TABLES[state.table] || null : null,
    copied: state.copied,
    skipped: state.skipped,
    start_hour_utc: START_HOUR,
    tables: BACKUP_TABLES.length,
  };
  if (!env.BACKUP) return out;
  out.daily = await listDirs(env, 'daily/');
  out.monthly = await listDirs(env, 'monthly/');
  out.yearly = await listDirs(env, 'yearly/');
  // What the pool holds. Counted, not listed -- there are as many objects as there are messages.
  // 池子里有什么。只数不列 —— 它的对象数与邮件数一样多。
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  for (let guard = 0; guard < 40; guard++) {
    const r = await env.BACKUP.list({ prefix: 'mail/', cursor, limit: 1000 });
    objects += r.objects.length;
    for (const o of r.objects) bytes += o.size;
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  out.pool = { objects, bytes };
  return out;
}
