// AI assistant settings, all stored per domain (domains.chat_*) and resolved from the request Host.
// Every domain is independent: the switch, the list of selectable chat models, the default model, the search key, and the vision / ASR / TTS / image models.
// AI 助手设置:全部按域名存储(domains.chat_*),跟随请求的 Host(<入口>.<域名>)生效。
// 每个域名独立:开关/允许的对话模型清单/默认模型/搜索 Key/识图/语音识别/语音合成/文生图。
import type { Env } from '../types';
import { domainFromHost, jsonTry } from '../util';
import {
  ASR_MODELS, CHAT_MODELS, DEFAULT_ASR, DEFAULT_IMAGE, DEFAULT_MODEL, DEFAULT_TTS, DEFAULT_VISION,
  IMAGE_MODELS, TTS_MODELS, VISION_MODELS, pickCap,
} from './models';

export interface ChatDomain {
  id: string;
  name: string;
  enabled: boolean;
  models: string[];        // 允许用户选用的对话模型 id(已校验非空)
  default_model: string;   // 一定在 models 里
  search_key: string;
  web_search: boolean;      // 联网搜索/取网页,默认关 —— 开了才会把查询词发给第三方
  vision_model: string;
  asr_model: string;
  tts_model: string;
  image_model: string;
}

function normalizeRow(row: any): ChatDomain | null {
  if (!row) return null;
  const raw = jsonTry<string[] | null>(row.chat_models, null);
  let models: string[] = Array.isArray(raw) ? raw.filter((id: any) => CHAT_MODELS.some((m) => m.id === id)) : [];
  if (!models.length) models = CHAT_MODELS.map((m) => m.id); // 未配置 = 全部允许
  const dm = String(row.chat_default_model || '');
  const default_model = models.includes(dm) ? dm : models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0];
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.chat_enabled,
    models,
    default_model,
    search_key: String(row.chat_search_key || ''),
    web_search: !!row.chat_web_search,
    vision_model: pickCap(VISION_MODELS, row.chat_vision_model, DEFAULT_VISION),
    asr_model: pickCap(ASR_MODELS, row.chat_asr_model, DEFAULT_ASR),
    tts_model: pickCap(TTS_MODELS, row.chat_tts_model, DEFAULT_TTS),
    image_model: pickCap(IMAGE_MODELS, row.chat_image_model, DEFAULT_IMAGE),
  };
}

const COLS =
  'id, name, chat_enabled, chat_models, chat_default_model, chat_search_key, chat_web_search, chat_vision_model, chat_asr_model, chat_tts_model, chat_image_model';

/** Resolve the current domain's chat configuration from the Host being visited.
 *  Production is always <entry-subdomain>.<domain>; local development (localhost) falls back to the
 *  earliest created domain, the same "no match, take the first" idea as currentDomainId in admin.js.
 *  按访问 Host 解析当前域名的 chat 配置。
 *  生产恒为 <入口>.<域名>(入口由部署决定);本地开发(localhost)回落到最早创建的域名,
 *  与 admin.js currentDomainId 的"匹配不上回落第一个"同思路。 */
export async function chatDomainForHost(env: Env, hostname: string): Promise<ChatDomain | null> {
  const h = (hostname || '').toLowerCase();
  const dn = domainFromHost(env, h);
  if (dn) {
    const row = await env.DB.prepare(`SELECT ${COLS} FROM domains WHERE name=?1`).bind(dn).first<any>();
    return normalizeRow(row);
  }
  if (h === 'localhost' || h === '127.0.0.1') {
    const row = await env.DB.prepare(`SELECT ${COLS} FROM domains ORDER BY created_at LIMIT 1`).first<any>();
    return normalizeRow(row);
  }
  return null;
}

export async function chatDomainById(env: Env, domainId: string): Promise<ChatDomain | null> {
  const row = await env.DB.prepare(`SELECT ${COLS} FROM domains WHERE id=?1`).bind(domainId).first<any>();
  return normalizeRow(row);
}

export interface ChatDomainPatch {
  enabled?: boolean;
  models?: string[];
  default_model?: string;
  search_key?: string;
  web_search?: boolean;
  vision_model?: string;
  asr_model?: string;
  tts_model?: string;
  image_model?: string;
}

export async function updateChatDomain(env: Env, domainId: string, patch: ChatDomainPatch): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  const add = (col: string, v: any) => {
    sets.push(`${col}=?${vals.length + 1}`);
    vals.push(v);
  };
  if (patch.enabled !== undefined) add('chat_enabled', patch.enabled ? 1 : 0);
  if (patch.models !== undefined) add('chat_models', JSON.stringify(patch.models));
  if (patch.default_model !== undefined) add('chat_default_model', patch.default_model);
  if (patch.search_key !== undefined) add('chat_search_key', patch.search_key);
  if (patch.web_search !== undefined) add('chat_web_search', patch.web_search ? 1 : 0);
  if (patch.vision_model !== undefined) add('chat_vision_model', patch.vision_model);
  if (patch.asr_model !== undefined) add('chat_asr_model', patch.asr_model);
  if (patch.tts_model !== undefined) add('chat_tts_model', patch.tts_model);
  if (patch.image_model !== undefined) add('chat_image_model', patch.image_model);
  if (!sets.length) return;
  vals.push(domainId);
  await env.DB.prepare(`UPDATE domains SET ${sets.join(',')} WHERE id=?${vals.length}`).bind(...vals).run();
}
