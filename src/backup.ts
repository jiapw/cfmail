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
 *   daily/YYYY-MM-DD.7z    the whole database as SQL, plus the .eml that arrived that day
 *   monthly/YYYY-MM.zip    that month's dailies, stored, not recompressed
 *   yearly/YYYY.zip        that year's monthlies, likewise
 *
 * Each message appears in exactly one daily, the one for the day it arrived; a monthly is a
 * container of dailies and a yearly a container of monthlies. No message is stored twice.
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

const CONTAINER_ID = 'cfmail-backup';

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
  return await launch(env, dayBefore(Date.now()), mode, s);
}

async function launch(env: Env, day: string, mode: string, prev: BackupState) {
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
  if (!(await backupEnabled(env))) return;
  const s = await loadState(env);

  if (s.state === 'running') {
    await poll(env, s);
    return;
  }
  const d = new Date();
  if (d.getUTCHours() !== (await backupHour(env)) || d.getUTCMinutes() !== 0) return;
  const target = dayBefore(Date.now());
  if (s.finishedDay === target) return;          // 昨天那份已经做过了
  await launch(env, target, 'all', s).catch(() => {});
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
    finishedDay: done ? s.day : s.finishedDay,
    result: done ? j.result : s.result,
    lastError: done ? undefined : (j.error || `退出码 ${j.code}`),
  });
  // Stop it the moment there is nothing left to do. A container kept alive out of politeness is
  // billed by the second like any other.
  // 一旦没事可做立刻停掉。出于客气留着的容器,和别的容器一样按秒计费。
  await container(env).stop().catch(() => {});
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

export async function backupStatus(env: Env): Promise<any> {
  const ready = backupReady(env);
  const s = await loadState(env);
  const out: any = {
    enabled: await backupEnabled(env),
    hour: await backupHour(env),
    ready: ready.ok,
    why: ready.why || null,
    state: s.state,
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
