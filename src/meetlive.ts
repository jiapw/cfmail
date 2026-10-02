// Putting a meeting on air, and letting people watch it.
//
// Three things have to exist for a broadcast: somewhere to push the picture (a live input),
// something to make the picture (the compositor container), and an address the audience can play.
// This file arranges all three and knows nothing about media.
//
// Where the picture goes is Cloudflare Stream: the compositor pushes RTMPS to a live input made
// for this sitting, and the audience plays its HLS manifest. Every live input is made with
// `requireSignedURLs`, so the manifest's bare address plays nothing; what plays is a token this
// Worker signs, for a few hours, for somebody it has decided may watch -- anybody with the link,
// or only somebody signed in, as the organiser chose. "Company only" is therefore a property of
// the video itself, not of the page around it.
//
// On a developer's machine there is no Stream. Two variables (MEET_DEV_RTMP, MEET_DEV_HLS) name
// any RTMP-in, HLS-out server instead -- MediaMTX in the tests -- and the compositor is started by
// whoever runs the test, from the address this file hands back, rather than by a container
// binding the machine does not have. Everything else is the same code.
//
// 让一场会议开播,并让人来看。
//
// 一场直播需要三样东西同时存在:一个可以推画面的去处(live input)、一个制作画面的东西(合成容器)、
// 一个旁观者可以播放的地址。这个文件把三样都安排好,而对媒体本身一无所知。
//
// 画面的去处是 Cloudflare Stream:合成器向为这一场新建的 live input 推 RTMPS,旁观者播放它的 HLS 清单。
// 每个 live input 创建时都带 `requireSignedURLs`,所以清单的裸地址什么都播不了;播得了的,
// 是这个 Worker 为"它认定可以看的人"签出的、几小时有效的令牌 —— 这个人可以是任何持有链接的人,
// 也可以只是已登录的人,由组织者选定。于是"仅本公司可看"是视频本身的属性,而不是它外面那张网页的属性。
//
// 开发者的机器上没有 Stream。两个变量(MEET_DEV_RTMP、MEET_DEV_HLS)指向任意一个"RTMP 进、HLS 出"的服务器
// —— 测试里用的是 MediaMTX —— 合成器则由跑测试的人按这个文件交回的地址去启动,而不是由这台机器上并不存在的
// 容器绑定来启动。其余全是同一份代码。
import { Container } from '@cloudflare/containers';
import type { Env } from './types';
import { HttpError } from './errors';

/**
 * The container a broadcast is made in: one instance per meeting, named after it, so that two
 * meetings on air at once never share a pipeline. It is asked how it is doing while it runs,
 * which is what keeps it awake; a broadcast that ends stops it, and one that is forgotten puts
 * itself to sleep.
 * 制作直播的容器:每场会议一个实例、以会议命名,于是同时开播的两场会议绝不会共用一条管线。
 * 运行期间会有人来问它进展如何,这正是让它保持清醒的东西;直播结束会停掉它,被遗忘的则自己去休眠。
 */
export class MeetCompositor extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10m';
}

export interface LiveTarget {
  /** Stream live input uid; 'dev' on a developer's machine. / Stream live input 的 uid;开发机上为 'dev'。 */
  uid: string;
  /** Where the compositor pushes. Carries the stream key: never sent to a browser, never logged.
   *  合成器往哪推。含推流密钥:绝不发给浏览器,绝不写日志。 */
  push: string;
}

const API = 'https://api.cloudflare.com/client/v4';

export function liveProvider(env: Env): 'stream' | 'dev' | null {
  if (env.MEET_DEV_RTMP && env.MEET_DEV_HLS && env.DEV_MODE === '1') return 'dev';
  if (env.STREAM_API_TOKEN && env.CF_ACCOUNT_ID) return 'stream';
  return null;
}

const KEY_CUSTOMER = 'stream.customer';

/** The "customer-<code>" part of this account's playback host. Stream never states it by itself;
 *  it is read off the first live input's addresses and remembered, so that the page that hands
 *  out playback addresses does not have to ask Stream anything.
 *  本账号播放主机名里 "customer-<code>" 的那一段。Stream 不会单独把它说出来;
 *  它是从第一个 live input 的地址里读到并记下来的,于是发放播放地址的那一页什么都不必去问 Stream。 */
async function customerCode(env: Env): Promise<string> {
  if (env.STREAM_CUSTOMER_CODE) return env.STREAM_CUSTOMER_CODE;
  const row: any = await env.DB.prepare('SELECT value FROM meta WHERE key=?1').bind(KEY_CUSTOMER).first();
  return String(row?.value || '');
}

async function stream(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}/stream${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text().catch(() => '');
  // A delete that worked answers with nothing at all. / 删除成功时,回答是空的。
  if (r.ok && !text.trim()) return null;
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON: treated as a failure below / 不是 JSON:下面按失败处理 */ }
  if (!r.ok || !j?.success) {
    console.log('stream api', method, path, r.status, JSON.stringify(j?.errors || '').slice(0, 300));
    throw new HttpError(502, 'e_meet_live_failed');
  }
  return j.result;
}

/** A place to push this sitting's picture.
 *
 *  Stream records every broadcast it lets people watch: measured, an input made with recording
 *  "off" takes the push and then serves no manifest at all (HTTP 204) -- "off" means ingest for
 *  re-streaming elsewhere, not "live without keeping it". So recording is always on, and `keep`
 *  -- the organiser's choice, made with the meeting -- decides what becomes of the recording
 *  afterwards: it stays as a video, or the hourly sweep deletes it. While it exists it counts
 *  against the account's Stream storage, the broadcast in progress included.
 *
 *  为这一场准备一个推画面的去处。
 *
 *  Stream 对"允许人观看"的每一场直播都会录像:实测,以 recording "off" 创建的 input 会收下推流,
 *  却完全不提供清单(HTTP 204)—— "off" 的意思是"只接收、转推到别处",而不是"直播但不留存"。
 *  所以录制恒开,而 `keep` —— 组织者在创建会议时的选择 —— 决定录像事后的去向:作为视频留下,
 *  或由每小时的清扫删除。它存在期间计入账号的 Stream 存储,正在进行的直播也算。 */
export async function provisionLive(env: Env, m: { code: string; title: string; session?: string }, keep: boolean): Promise<LiveTarget> {
  const kind = liveProvider(env);
  if (kind === 'dev') return { uid: 'dev', push: `${String(env.MEET_DEV_RTMP).replace(/\/$/, '')}/${m.code}` };
  if (kind !== 'stream') throw new HttpError(503, 'e_meet_live_unavailable');
  const res = await stream(env, 'POST', '/live_inputs', {
    meta: { name: `cfmail meeting ${m.code}`, cfmail: '1', code: m.code, session: m.session || '', keep: keep ? '1' : '0' },
    recording: { mode: 'automatic', requireSignedURLs: true, timeoutSeconds: 20 },
  });
  const url = String(res?.rtmps?.url || '');
  const key = String(res?.rtmps?.streamKey || '');
  if (!res?.uid || !url || !key) throw new HttpError(502, 'e_meet_live_failed');
  const code = (String(res?.webRTCPlayback?.url || res?.webRTC?.url || '').match(/customer-([a-z0-9]+)\.cloudflarestream\.com/) || [])[1];
  if (code) {
    await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2').bind(KEY_CUSTOMER, code).run().catch(() => {});
  }
  return { uid: String(res.uid), push: `${url.replace(/\/$/, '')}/${key}` };
}

/** The sitting is over. The input is switched off at once -- its stream key stops working --
 *  and marked as finished; it is not deleted here, because the recording Stream made of it is
 *  still being written for some seconds after the push stops, and cannot be touched until it is
 *  done. The hourly sweep finishes the job.
 *  这一场结束了。input 立即停用 —— 推流密钥随即失效 —— 并标记为已结束;这里不删它,
 *  因为推流停止后的若干秒里 Stream 仍在写那份录像,写完之前碰不得。收尾交给每小时的清扫。 */
export async function retireLive(env: Env, uid: string): Promise<void> {
  if (!uid || uid === 'dev' || liveProvider(env) !== 'stream') return;
  const cur = await stream(env, 'GET', `/live_inputs/${encodeURIComponent(uid)}`).catch(() => null);
  if (!cur) return;
  await stream(env, 'PUT', `/live_inputs/${encodeURIComponent(uid)}`, {
    meta: { ...(cur.meta || {}), ended: String(Date.now()) }, enabled: false, recording: cur.recording,
  }).catch(() => {});
}

/** What is left of broadcasts that are over: their recordings are kept (and written down as
 *  recordings of the sitting) or deleted, as the organiser chose, and then the input goes. An
 *  input whose recording is still being finished is left for the next hour.
 *  已结束的直播留下的东西:录像按组织者的选择留下(并登记为该场的录像)或删除,然后 input 删掉。
 *  录像仍在收尾的 input,留到下一个小时。 */
export async function sweepLive(env: Env): Promise<void> {
  if (liveProvider(env) !== 'stream') return;
  const inputs: any[] = await stream(env, 'GET', '/live_inputs').catch(() => []);
  for (const it of Array.isArray(inputs) ? inputs : []) {
    const meta = it?.meta || {};
    if (meta.cfmail !== '1') continue;
    const ended = Number(meta.ended || 0);
    // Never marked as ended: the room went away without saying so. A day is longer than any broadcast.
    // 从未被标记为结束:房间没打招呼就没了。一天比任何一场直播都长。
    const stale = !ended && Date.parse(it.created || '') < Date.now() - 24 * 3600 * 1000;
    if (!(ended && ended < Date.now() - 5 * 60 * 1000) && !stale) continue;
    const vids: any[] = await stream(env, 'GET', `/live_inputs/${it.uid}/videos`).catch(() => null as any);
    if (!Array.isArray(vids)) continue;
    let pending = false;
    for (const v of vids) {
      if (v?.status?.state !== 'ready') { pending = true; continue; }
      if (meta.keep === '1') {
        if (meta.session) {
          const at = Date.parse(v.created || '') || Date.now();
          await env.DB.prepare(
            `INSERT INTO meeting_recordings (id, session_id, kind, stream_uid, started_at, ended_at)
             SELECT ?1,?2,'stream',?3,?4,?5 WHERE NOT EXISTS (SELECT 1 FROM meeting_recordings WHERE stream_uid=?3)`
          ).bind(crypto.randomUUID(), meta.session, v.uid, at, at + Math.round((v.duration || 0) * 1000)).run().catch(() => {});
        }
      } else {
        await stream(env, 'DELETE', `/${v.uid}`).catch(() => { pending = true; });
      }
    }
    if (!pending) await stream(env, 'DELETE', `/live_inputs/${it.uid}`).catch(() => {});
  }
}

// ---------- Tokens ----------
// ---------- 令牌 ----------

const b64url = (bytes: Uint8Array | string): string => {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A playback token, signed here with the key Stream gave us once (STREAM_SIGNING_KEY_ID and
 *  STREAM_SIGNING_JWK, a base64 JWK, as Stream's /keys endpoint returns it). No call to Stream is
 *  made per viewer: ten thousand people opening the page cost ten thousand signatures and nothing
 *  else. / 播放令牌,用 Stream 只给过我们一次的那把钥匙在本地签出(STREAM_SIGNING_KEY_ID 与
 *  STREAM_SIGNING_JWK,后者是 base64 的 JWK,即 Stream 的 /keys 接口返回的样子)。每来一个观众并不去问 Stream:
 *  一万个人打开页面,花掉的是一万次签名,仅此而已。 */
async function signPlayback(env: Env, uid: string, ttlSec: number): Promise<string> {
  if (!env.STREAM_SIGNING_KEY_ID || !env.STREAM_SIGNING_JWK) throw new HttpError(503, 'e_meet_live_unavailable');
  const jwk = JSON.parse(atob(env.STREAM_SIGNING_JWK));
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: env.STREAM_SIGNING_KEY_ID }));
  const body = b64url(JSON.stringify({ sub: uid, kid: env.STREAM_SIGNING_KEY_ID, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

/** Four hours: longer than most broadcasts, and the page asks again before it runs out.
 *  四小时:比多数直播都长,而且页面会在它到期前再来要一次。 */
export const PLAY_TTL_SEC = 4 * 3600;

/** What one viewer plays. / 一位观众播放的地址。 */
export async function playbackUrl(env: Env, uid: string, code: string): Promise<string> {
  if (uid === 'dev') return `${String(env.MEET_DEV_HLS).replace(/\/$/, '')}/${code}/index.m3u8`;
  const customer = await customerCode(env);
  if (!customer) throw new HttpError(503, 'e_meet_live_unavailable');
  const token = await signPlayback(env, uid, PLAY_TTL_SEC);
  return `https://customer-${customer}.cloudflarestream.com/${token}/manifest/video.m3u8?protocol=llhls`;
}

// ---------- The compositor ----------
// ---------- 合成器 ----------

export interface LaunchOrder { ws: string; origin: string; out: string; width: number; height: number; fps: number }

const SIZES: Record<number, [number, number]> = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080] };

export function launchOrder(origin: string, code: string, ticket: string, target: LiveTarget, resolution: number): LaunchOrder {
  const [width, height] = SIZES[resolution] || SIZES[720];
  return {
    ws: `${origin.replace(/^http/, 'ws')}/api/meet-pub/${code}/ws?bot=${encodeURIComponent(ticket)}`,
    origin, out: target.push, width, height, fps: 30,
  };
}

function compositor(env: Env, meetingId: string): DurableObjectStub | null {
  // On a developer's machine the binding can be there while containers are switched off for
  // local development; whoever runs the test starts the compositor. / 开发机上,绑定可以在、
  // 而本地开发的容器是关着的;合成器由跑测试的人来启动。
  if (liveProvider(env) === 'dev') return null;
  const ns = env.MEET_COMPOSITOR;
  return ns ? ns.get(ns.idFromName(meetingId)) : null;
}

/** Start the container for this meeting and hand it its orders. With no container binding (a
 *  developer's machine) nothing is started and the caller is told so.
 *  为这场会议启动容器并把指令交给它。没有容器绑定时(开发机)什么都不启动,并如实告诉调用方。 */
export async function startCompositor(env: Env, meetingId: string, order: LaunchOrder): Promise<'started' | 'manual'> {
  const stub = compositor(env, meetingId);
  if (!stub) return 'manual';
  const r = await stub.fetch('http://compositor/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order) });
  if (!r.ok && r.status !== 409) {
    console.log('compositor start', r.status, (await r.text().catch(() => '')).slice(0, 200));
    throw new HttpError(502, 'e_meet_live_failed');
  }
  return 'started';
}

export async function stopCompositor(env: Env, meetingId: string): Promise<void> {
  const stub = compositor(env, meetingId);
  if (stub) await stub.fetch('http://compositor/stop', { method: 'POST' }).catch(() => {});
}

export async function compositorStatus(env: Env, meetingId: string): Promise<any | null> {
  const stub = compositor(env, meetingId);
  if (!stub) return null;
  const r = await stub.fetch('http://compositor/status').catch(() => null);
  return r && r.ok ? r.json().catch(() => null) : null;
}
