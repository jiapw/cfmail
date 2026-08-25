/**
 * Automatic backup: the control plane. The work itself happens in a container, in container/.
 *
 * WHY THE WORK IS NOT HERE
 * A Worker gets thirty seconds of CPU, a hundred and twenty-eight megabytes, and no LZMA. The job
 * compresses a gigabyte with 7-Zip and takes as long as it takes. So this file starts a container,
 * asks it once a minute how it is going, writes down the answer, and stops it the moment it is
 * done -- a container that is still running is a container still being charged for.
 *
 * That once-a-minute question is doing double duty. An instance sleeps after a stretch with no
 * requests, and a job compressing a gigabyte makes no requests at all, so asking is also what
 * says "still needed".
 *
 * WHAT THE CONTAINER PRODUCES
 *   daily/YYYY-MM-DD.7z        database as SQL, plus the mail that arrived that day
 *   daily/YYYY-MM-DD.extra.7z  the catch-up: imported mail, and days the nightly missed
 *   monthly/YYYY-MM.zip        that month's dailies, stored, not recompressed
 *   yearly/YYYY.zip            that year's monthlies, likewise
 *
 * Each message appears in exactly one archive, the one for the day it arrived; imported mail
 * never enters on its own and waits for the catch-up. Everything is written as Infrequent Access.
 *
 * 自动备份:控制面。真正干活的在容器里,见 container/。
 *
 * 为什么活儿不在这里
 * Worker 有三十秒 CPU、一百二十八兆内存,而且没有 LZMA。这个任务要用 7-Zip 压一个 GB,
 * 该跑多久跑多久。所以本文件只做四件事:起一个容器、每分钟问一次进展、把回答记下来、
 * 一做完立刻把它停掉 —— 还在跑的容器是还在计费的容器。
 *
 * 那句每分钟一问是一举两得的。实例在一段时间没有请求之后会休眠,
 * 而一个正在压一个 GB 的任务根本不发请求 —— 所以"问"本身也在说"还要用"。
 *
 * 容器产出什么
 *   daily/YYYY-MM-DD.7z    整库 SQL,加上当天到达的 .eml
 *   monthly/YYYY-MM.zip    当月各份日备份,store 不重压
 *   yearly/YYYY.zip        当年各份月备份,同上
 *
 * 每封信只出现在它到达那一天的日包里;月包是日包的容器,年包是月包的容器。没有一封信被存过两次。
 */
import { Container, getContainer } from '@cloudflare/containers';
import type { Env } from './types';
import { now } from './util';

const STATE_KEY = 'backup_state';
const ENABLED_KEY = 'backup_enabled';
const HOUR_KEY = 'backup_hour';
/** Default start hour, UTC. Late enough that the day being backed up is over everywhere.
 *  默认启动时刻(UTC)。晚到被备份的那一天在各地都已经结束。 */
const DEFAULT_HOUR = 2;

/**
 * The container this deployment runs its backups in. One instance, always the same one, because
 * two backups at once would fight over the same archive names.
 * 这套部署跑备份用的容器。只有一个实例,而且永远是同一个 —— 两次备份同时跑会为同一批包名打架。
 */
export class BackupContainer extends Container<Env> {
  defaultPort = 8080;
  /** Long enough to survive a slow minute between polls, short enough that a container nobody
   *  stopped does not sit there for an hour.
   *  长到熬得过两次轮询之间偶尔慢下来的一分钟,短到"没人停它"的容器不会在那儿待一小时。 */
  sleepAfter = '5m';
}

/**
 * Which instance the job runs in. The name carries a number because a stopped instance is kept
 * and reused, and a reused instance keeps the image it was created from: after pushing a new
 * image and deploying it, the application said version 2 while the job still ran the code from
 * version 1 -- visible only because the new code logs per table and the output stayed empty.
 * Bumping this name is how an instance is retired on purpose.
 */
const CONTAINER_ID = 'cfmail-backup-2';

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

export async function backupHour(env: Env): Promise<number> {
  const v = parseInt((await readMeta(env, HOUR_KEY)) || '', 10);
  return Number.isInteger(v) && v >= 0 && v <= 23 ? v : DEFAULT_HOUR;
}

export async function setBackupSettings(env: Env, on: boolean, hour: number): Promise<void> {
  await writeMeta(env, ENABLED_KEY, on ? '1' : '0');
  const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_HOUR;
  await writeMeta(env, HOUR_KEY, String(h));
}

export interface BackupState {
  /** running while the container has the job; idle otherwise / 容器手上有任务时是 running,否则 idle */
  state: 'idle' | 'running';
  day: string;
  mode: string;
  startedAt: number;
  /** The container's last line of output, for the console to show / 容器最后一行输出,给后台显示 */
  line?: string;
  finishedAt?: number;
  finishedDay?: string;
  result?: any;
  lastError?: string;
  /** The day the last automatic launch went for, tried once per day whether or not it succeeded
   *  上一次自动启动瞄准的是哪一天;无论成败,每天只试一次 */
  attemptDay?: string;
}

const EMPTY: BackupState = { state: 'idle', day: '', mode: '', startedAt: 0 };

export async function loadState(env: Env): Promise<BackupState> {
  const raw = await readMeta(env, STATE_KEY);
  if (!raw) return { ...EMPTY };
  try {
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY };
  }
}

const saveState = (env: Env, s: BackupState) => writeMeta(env, STATE_KEY, JSON.stringify(s));

const dayBefore = (t: number) => new Date(t - 24 * 3600 * 1000).toISOString().slice(0, 10);

/** Everything the container needs to reach Cloudflare on its own. It has no bindings: R2 goes
 *  through the S3 API and D1 through the REST API, both on one token.
 *  容器自己够到 Cloudflare 所需的一切。它没有 binding:R2 走 S3 接口,D1 走 REST 接口,
 *  两者共用一个 token。 */
function jobEnv(env: Env): Record<string, string> | null {
  const id = env.BACKUP_TOKEN_ID;
  const value = env.BACKUP_TOKEN_VALUE;
  const account = env.CF_ACCOUNT_ID;
  const db = env.CF_D1_DATABASE_ID;
  if (!id || !value || !account || !db) return null;
  return {
    CF_ACCOUNT_ID: account,
    CF_D1_DATABASE_ID: db,
    CF_TOKEN_ID: id,
    CF_TOKEN_VALUE: value,
    R2_RAW_BUCKET: env.R2_RAW_BUCKET || 'cfmail-raw',
    R2_BACKUP_BUCKET: env.R2_BACKUP_BUCKET || 'cfmail-backup',
    SEVENZ_LEVEL: env.SEVENZ_LEVEL || '9',
  };
}

/** Is this deployment able to back up at all? / 这套部署到底具不具备备份能力? */
export function backupReady(env: Env): { ok: boolean; why?: string } {
  if (!env.BACKUP_CONTAINER) return { ok: false, why: 'e_backup_no_container' };
  if (!jobEnv(env)) return { ok: false, why: 'e_backup_no_credentials' };
  return { ok: true };
}

const container = (env: Env) => getContainer(env.BACKUP_CONTAINER!, CONTAINER_ID);

/** Ask for a run now, whatever the hour. Refuses while one is already going.
 *  不管几点,现在就跑一次。已经在跑时拒绝。 */
export async function startBackupNow(env: Env, mode = 'all'): Promise<{ started: boolean; reason?: string }> {
  const ready = backupReady(env);
  if (!ready.ok) return { started: false, reason: ready.why };
  const s = await loadState(env);
  if (s.state === 'running') return { started: false, reason: 'e_backup_running' };
  // A catch-up has no single day: it sweeps every day with unarchived mail. Sending one anyway
  // would make the container treat it as a filter and quietly skip the rest.
  // 补档没有"某一天":它扫过所有还有未归档邮件的日子。硬塞一个日期,
  // 容器会把它当成过滤条件,把其余的日子悄悄跳过。
  const day = mode === 'catchup' ? '' : dayBefore(Date.now());
  return await launch(env, day, mode, s);
}

async function launch(env: Env, day: string, mode: string, prev: BackupState, attemptDay?: string) {
  const c = container(env);
  const res = await c.containerFetch('http://c/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, day, env: jobEnv(env) }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!j.started) return { started: false, reason: j.reason || 'e_backup_running' };
  await saveState(env, {
    state: 'running', day, mode, startedAt: now(),
    finishedAt: prev.finishedAt, finishedDay: prev.finishedDay, result: prev.result,
    attemptDay: attemptDay ?? prev.attemptDay,
  });
  return { started: true };
}

/**
 * One minute's worth of attention. Starts the day's run when the hour comes round, and otherwise
 * keeps an eye on one that is already going -- which is also what keeps the container from
 * deciding it is idle.
 * 一分钟份的照看。到点了就起当天那一次,否则就盯着已经在跑的那一次 ——
 * 而这一盯,也正是让容器不至于认为自己闲着的原因。
 */
export async function backupTick(env: Env): Promise<void> {
  if (!backupReady(env).ok) return;
  const s = await loadState(env);

  // A running job is watched whatever the switch says: a catch-up may be going with the
  // automatic backup off, and switching off mid-run must not orphan a run in progress.
  // 正在跑的任务无论开关如何都要盯着:补档可能在自动备份关着的时候进行,
  // 而中途关掉开关不该把一次进行中的运行晾成没人管。
  if (s.state === 'running') {
    await poll(env, s);
    return;
  }
  if (!(await backupEnabled(env))) return;

  // Any minute past the hour will do, once per target day. Insisting on minute zero exactly
  // meant that a catch-up still running at that moment silently cost a night's backup.
  // 过了整点的任何一分钟都行,每个目标日只试一次。非得掐在零分那一下,
  // 意味着那一刻恰好还在跑的补档,会悄悄吃掉一晚的备份。
  if (new Date().getUTCHours() < (await backupHour(env))) return;
  const target = dayBefore(Date.now());
  if (s.finishedDay === target || s.attemptDay === target) return;
  await launch(env, target, 'all', s, target).catch(() => {});
}

async function poll(env: Env, s: BackupState): Promise<void> {
  let j: any;
  try {
    const res = await container(env).containerFetch('http://c/status');
    j = await res.json();
  } catch (e: any) {
    // The container is gone -- evicted, restarted, or never came up. The run is over either way,
    // and saying so is better than leaving the console showing a job that nobody is running.
    // 容器没了 —— 被回收、重启,或者根本没起来。无论哪种,这次运行都结束了;
    // 说出来,好过让后台一直显示着一个没有人在跑的任务。
    await saveState(env, {
      ...s, state: 'idle', lastError: '容器失联:' + String(e?.message || e).slice(0, 200),
    });
    return;
  }

  if (j.state === 'running') {
    await saveState(env, { ...s, line: j.line || '' });
    return;
  }

  const done = j.state === 'done';
  await saveState(env, {
    state: 'idle',
    day: s.day,
    mode: s.mode,
    startedAt: s.startedAt,
    finishedAt: now(),
    // A catch-up finishing is not a daily finishing: writing its empty day here would clear the
    // record and make the next tick re-run a night that already happened.
    // 补档跑完不等于日备份跑完:把它那个空的 day 写进来会抹掉记录,
    // 让下一次 tick 把已经跑过的那一晚再跑一遍。
    finishedDay: done && s.mode !== 'catchup' ? s.day : s.finishedDay,
    result: done ? j.result : s.result,
    lastError: done ? undefined : String(j.error || `exit code ${j.code}`).slice(0, 2000),
    attemptDay: s.attemptDay,
  });
  // Destroy it the moment there is nothing left to do. A container kept alive out of politeness is
  // billed by the second like any other -- and a merely stopped one is kept and started again as
  // it was, image included, so a stopped instance would go on running yesterday's code after a
  // new image had been deployed. The job has already exited by now; there is nothing to interrupt.
  // 一做完就销毁。出于客气留着的容器和别的容器一样按秒计费 —— 而仅仅"停下"的实例会被留着、
  // 并原样重新启动,镜像也照旧,于是新镜像部署之后它还在跑昨天的代码。
  // 走到这一步任务已经退出,没有什么可打断的。
  await container(env).destroy().catch(() => {});
}

/** The archives that exist, newest first / 现有的包,新的在前 */
async function listArchives(env: Env, prefix: string, ext: string): Promise<any[]> {
  if (!env.BACKUP) return [];
  const out: any[] = [];
  let cursor: string | undefined;
  for (;;) {
    const r = await env.BACKUP.list({ prefix, cursor, limit: 500 });
    for (const o of r.objects) {
      if (!o.key.endsWith(ext)) continue;
      out.push({
        name: o.key.slice(prefix.length, -ext.length),
        key: o.key,
        size: o.size,
        at: +new Date(o.uploaded),
      });
    }
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

const INDEX_KEY = 'index/archived.txt.gz';

/** Every R2 key that is inside some archive, as the container's index records it.
 *  已在某个包里的全部 R2 key,以容器维护的索引为准。 */
async function loadArchiveIndex(env: Env): Promise<Set<string>> {
  if (!env.BACKUP) return new Set();
  const obj = await env.BACKUP.get(INDEX_KEY);
  if (!obj) return new Set();
  const text = await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return new Set(text.split('\n').filter(Boolean));
}

/**
 * What is in no archive yet, grouped by arrival day, with the archive each day's mail would go
 * into. This is the preview the console shows before a catch-up; the container recomputes the
 * same answer for itself when the run actually starts.
 *
 * 还不在任何包里的邮件,按到达日分组,并标出每一天会进哪个包。
 * 这是后台在补档前展示的预览;真正开跑时,容器会自己把同一个答案再算一遍。
 */
export async function backupPending(env: Env): Promise<any> {
  const index = await loadArchiveIndex(env);
  const today = new Date().toISOString().slice(0, 10);
  const days = new Map<string, { count: number; bytes: number }>();
  for (const prefix of ['import/', 'raw/', 'unrouted/', 'brand/']) {
    let cursor: string | undefined;
    for (;;) {
      const r = await env.RAW.list({ prefix, cursor, limit: 1000 });
      for (const o of r.objects) {
        if (index.has(o.key)) continue;
        const day = new Date(o.uploaded).toISOString().slice(0, 10);
        // Today's ordinary mail is tonight's run's business; only imports are pending on arrival
        // 今天的普通来信是今晚那一次的事;只有导入的邮件一到就算待补
        if (prefix !== 'import/' && day >= today) continue;
        const g = days.get(day) || { count: 0, bytes: 0 };
        g.count += 1;
        g.bytes += o.size;
        days.set(day, g);
      }
      if (!r.truncated) break;
      cursor = r.cursor;
    }
  }

  const have = new Set<string>();
  if (env.BACKUP) {
    for (const prefix of ['daily/', 'monthly/', 'yearly/']) {
      let cursor: string | undefined;
      for (;;) {
        const r = await env.BACKUP.list({ prefix, cursor, limit: 500 });
        for (const o of r.objects) have.add(o.key);
        if (!r.truncated) break;
        cursor = r.cursor;
      }
    }
  }

  let count = 0;
  let bytes = 0;
  const rows = [...days.entries()].sort().map(([day, g]) => {
    count += g.count;
    bytes += g.bytes;
    const M = day.slice(0, 7);
    const Y = day.slice(0, 4);
    let target = `daily/${day}.extra.7z`;
    let action = 'create';
    if (have.has(`yearly/${Y}.zip`)) { target = `yearly/${Y}.zip`; action = 'add'; }
    else if (have.has(`monthly/${M}.zip`)) { target = `monthly/${M}.zip`; action = 'add'; }
    else if (have.has(target)) { action = 'add'; }
    return { day, count: g.count, bytes: g.bytes, target, action };
  });
  return { count, bytes, days: rows };
}

export async function backupStatus(env: Env): Promise<any> {
  const ready = backupReady(env);
  const s = await loadState(env);
  const out: any = {
    enabled: await backupEnabled(env),
    hour: await backupHour(env),
    ready: ready.ok,
    why: ready.why || null,
    state: s.state,
    mode: s.mode || null,
    day: s.day,
    line: s.line || null,
    started_at: s.startedAt || null,
    finished_at: s.finishedAt || null,
    finished_day: s.finishedDay || null,
    result: s.result || null,
    last_error: s.lastError || null,
  };
  if (!env.BACKUP) return out;
  out.daily = await listArchives(env, 'daily/', '.7z');
  out.monthly = await listArchives(env, 'monthly/', '.zip');
  out.yearly = await listArchives(env, 'yearly/', '.zip');
  return out;
}
