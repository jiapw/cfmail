// What the assistant's tools actually do (agent.ts wraps these into AI SDK tools)
// AI 助手工具的实际执行逻辑(供 agent.ts 包装成 AI SDK tools)
import { generateImage as aiGenerateImage } from 'ai';
import { getWorkersAI } from './provider';
import type { Env } from '../types';
import { now, uid } from '../util';
import { DEFAULT_IMAGE } from './models';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

// ---------- Web search: Brave when a key is configured, otherwise DuckDuckGo HTML ----------
// ---------- 联网搜索:优先 Brave(后台配 key),否则 DuckDuckGo HTML ----------

export async function webSearch(env: Env, searchKey: string, query: string, count = 5): Promise<SearchHit[]> {
  count = Math.min(Math.max(count || 5, 1), 8);
  if (searchKey) {
    try {
      return await braveSearch(searchKey, query, count);
    } catch (e) {
      console.log('brave search failed, fallback ddg', e);
    }
  }
  return await ddgSearch(query, count);
}

async function braveSearch(key: string, query: string, count: number): Promise<SearchHit[]> {
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', query);
  u.searchParams.set('count', String(count));
  const res = await fetch(u, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const data: any = await res.json();
  return ((data?.web?.results || []) as any[]).slice(0, count).map((r) => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    snippet: stripTags(String(r.description || '')).slice(0, 300),
  }));
}

async function ddgSearch(query: string, count: number): Promise<SearchHit[]> {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'text/html',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`ddg ${res.status}`);
  const html = await res.text();
  const hits: SearchHit[] = [];
  // Result block: <a class="result__a" href="...">title</a> ... <a class="result__snippet">snippet</a>
  // 结果块:<a class="result__a" href="...">标题</a> ... <a class="result__snippet">摘要</a>
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < count) {
    let url = decodeEntities(m[1]);
    // DDG redirect links look like /l/?uddg=<real URL>
    // DDG 的跳转链接:/l/?uddg=<真实URL>
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    hits.push({
      title: stripTags(decodeEntities(m[2])).trim().slice(0, 200),
      url,
      snippet: stripTags(decodeEntities(m[3] || '')).trim().slice(0, 300),
    });
  }
  return hits;
}

// ---------- Open a page and pull out its text ----------
// ---------- 打开网页取正文 ----------

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|\[?::1\]?)$/i;

export async function openUrl(url: string): Promise<{ url: string; title: string; text: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('URL 无效');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https');
  if (BLOCKED_HOST.test(u.hostname)) throw new Error('该地址不允许访问');
  const res = await fetch(u.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`网页返回 ${res.status}`);
  const ct = (res.headers.get('Content-Type') || '').toLowerCase();
  if (!/text\/|json|xml|xhtml/.test(ct)) throw new Error('不是文本类型的网页');
  let body = await res.text();
  if (body.length > 800_000) body = body.slice(0, 800_000);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] || '').trim().slice(0, 200);
  let text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|footer|header|aside|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n');
  text = stripTags(text);
  text = decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim()
    .slice(0, 8000);
  return { url: u.toString(), title: decodeEntities(title), text };
}

// ---------- Image generation (flux-1-schnell) ----------
// ---------- 生成图片(flux-1-schnell) ----------

export async function generateImageFile(
  env: Env,
  ownerId: string,
  sessionId: string,
  prompt: string,
  modelId?: string
): Promise<{ file_id: string; filename: string }> {
  const workersai = getWorkersAI(env);
  const { images } = await aiGenerateImage({
    model: workersai.image(modelId || DEFAULT_IMAGE),
    prompt: prompt.slice(0, 2000),
  });
  const img = images[0];
  if (!img) throw new Error('图片生成失败');
  const bytes = img.uint8Array;
  const id = uid();
  const filename = `gen-${id.slice(0, 8)}.png`;
  const key = `chat/gen/${id}.png`;
  await env.RAW.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
  await env.DB.prepare(
    'INSERT INTO chat_files (id, user_id, session_id, kind, filename, mime, size, r2_key, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)'
  ).bind(id, ownerId, sessionId, 'gen', filename, 'image/png', bytes.byteLength, key, now()).run();
  return { file_id: id, filename };
}

// ---------- Small helpers ----------
// ---------- 小工具 ----------

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function safeChar(code: number): string {
  try {
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
}
