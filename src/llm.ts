// The large model as a utility, and the console page that configures it.
//
// The assistant has its own settings, per domain, because the assistant reads mail and a company
// may not want a model near its mail. This is the other kind of use: a one-off question with a
// short answer -- today, translating the texts of a form -- which sends nothing but what the
// designer typed. It is configured once for the whole deployment, by a global administrator:
// which model answers, and what it is told. Both live in the meta table, so that a deployment
// that never opens the page runs on the defaults below.
//
// 作为工具来用的大模型,以及配置它的那个后台页。
//
// 助手有自己的、按域名的设置,因为助手读邮件,而一家公司可能不想让模型靠近它的邮件。
// 这里是另一种用法:一次性的短问答 —— 眼下是翻译一份表单的文本 —— 送出去的只有设计者自己敲的字。
// 它对整套部署配置一次,由全局管理员来配:哪个模型作答、对它说什么。
// 两样都存在 meta 表里,于是一套从未打开过这一页的部署,跑的就是下面的默认值。
import { Hono } from 'hono';
import type { Env, User } from './types';
import { HttpError } from './errors';
import { audit } from './audit';
import { CHAT_MODELS } from './chat/models';

type Ctx = { Bindings: Env; Variables: { user: User } };

export const FORM_LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru'];
export const LANG_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', en: 'English', ja: 'Japanese',
  ko: 'Korean', de: 'German', fr: 'French', es: 'Spanish', ru: 'Russian',
};

/** Qwen by default: the strongest hand at Chinese, Japanese and Korean among the models on offer,
 *  fast, and told in the prompt not to think out loud -- the marker is Qwen's own convention and
 *  harmless to every other model.
 *  默认 Qwen:在可选模型里中日韩最稳、也快;提示词里叮嘱它别把思考写出来 ——
 *  那个标记是 Qwen 自己的约定,对其他模型无害。 */
export const DEFAULT_TRANSLATE_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const DEFAULT_TRANSLATE_PROMPT =
  'You translate the text of a web form into {lang}. ' +
  'The input is a JSON object whose values are labels, questions, options and help notes. ' +
  'Return a JSON object with exactly the same keys, each value translated naturally for a form. ' +
  'Keep placeholders such as {name} and {email} exactly as they are, keep line breaks, do not add, drop or merge entries, do not comment. ' +
  'Output only the JSON object. /no_think';

export interface LlmSettings {
  translate_model: string;
  /** System prompt; {lang} becomes the target language's English name / 系统提示词;{lang} 换成目标语言的英文名 */
  translate_prompt: string;
}

const KEY_MODEL = 'llm.translate_model';
const KEY_PROMPT = 'llm.translate_prompt';
const MODEL_RE = /^@cf\/[A-Za-z0-9._/-]{3,120}$/;
const PROMPT_MAX = 4000;

export async function getLlmSettings(env: Env): Promise<LlmSettings> {
  const rows = await env.DB.prepare('SELECT key, value FROM meta WHERE key IN (?1, ?2)').bind(KEY_MODEL, KEY_PROMPT).all();
  const m: Record<string, string> = {};
  for (const r of (rows.results || []) as any[]) m[r.key] = String(r.value || '');
  return {
    translate_model: MODEL_RE.test(m[KEY_MODEL] || '') ? m[KEY_MODEL] : DEFAULT_TRANSLATE_MODEL,
    translate_prompt: (m[KEY_PROMPT] || '').includes('{lang}') ? m[KEY_PROMPT] : DEFAULT_TRANSLATE_PROMPT,
  };
}

async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2').bind(key, value).run();
}

/** Whether there is a model to ask at all: the binding in production, the REST credentials in
 *  local development (wrangler's binding proxy fails, see chat/provider.ts).
 *  到底有没有模型可问:生产是 binding,本地开发是 REST 凭据(wrangler 的 binding 代理会失败,见 chat/provider.ts)。 */
export function aiAvailable(env: Env): boolean {
  return !!env.AI || !!(env.AI_DEV_API_TOKEN && env.AI_DEV_ACCOUNT_ID);
}

/** The text of a Workers AI chat answer, whichever of its shapes came back: an OpenAI-style
 *  choice, a plain `response` string, or -- when the model was asked for JSON -- `response`
 *  already parsed into an object.
 *  一次 Workers AI 对话回答里的文本,不论回来的是哪种形状:OpenAI 式的 choice、
 *  单纯的 response 字符串,或者 —— 要它输出 JSON 时 —— 已被解析成对象的 response。 */
export function textOf(res: any): string {
  if (typeof res === 'string') return res;
  const c = res?.choices?.[0]?.message?.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('');
  const r = res?.response;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') return JSON.stringify(r);
  return '';
}

export function parseJsonObject(text: string): Record<string, string> | null {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/**
 * One question to the model, answered as text. Over REST in local development and through the
 * binding everywhere else. Given a fixed time and no more: nothing that calls this may hang on
 * a model.
 * 问模型一个问题,以文本作答。本地开发走 REST,其余场合走 binding。只给固定的时间:
 * 调用它的任何东西都不能吊死在模型上。
 */
export async function aiComplete(env: Env, model: string, system: string, prompt: string, timeoutMs: number): Promise<string> {
  const input = { messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: 4096 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    if (env.AI_DEV_API_TOKEN && env.AI_DEV_ACCOUNT_ID) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.AI_DEV_ACCOUNT_ID}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.AI_DEV_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: ctl.signal,
      });
      const j: any = await r.json();
      if (!r.ok || !j?.success) throw new Error(JSON.stringify(j?.errors || r.status).slice(0, 200));
      return textOf(j.result);
    }
    if (!env.AI) throw new Error('no AI binding');
    const res = await Promise.race([
      env.AI.run(model as any, input as any),
      new Promise<never>((_, rej) => ctl.signal.addEventListener('abort', () => rej(new Error('timeout')))),
    ]);
    return textOf(res);
  } finally {
    clearTimeout(timer);
  }
}

/** One language, one request, at most this many strings per request. */
/** 一种语言一次请求,每次最多这么多条。 */
const TR_CHUNK = 40;

export const renderPrompt = (tpl: string, target: string) => tpl.replace(/\{lang\}/g, LANG_NAMES[target] || target);

/** Translate a table of strings into one language with the configured model. Whatever the model
 *  fails to answer is simply absent from the result; the caller keeps the original.
 *  用配置的模型把一张字符串表翻译成一种语言。模型没答上的就不在结果里;调用方保留原文。 */
export async function translateInto(
  env: Env, target: string, items: Record<string, string>, settings?: LlmSettings
): Promise<Record<string, string>> {
  const s = settings || (await getLlmSettings(env));
  const system = renderPrompt(s.translate_prompt, target);
  const entries = Object.entries(items);
  const out: Record<string, string> = {};
  for (let i = 0; i < entries.length; i += TR_CHUNK) {
    const chunk = Object.fromEntries(entries.slice(i, i + TR_CHUNK));
    // Logged, not thrown: a save must succeed even when the model does not answer.
    // 记日志、不抛出:模型不答话,保存也必须成功。
    const res = await aiComplete(env, s.translate_model, system, JSON.stringify(chunk), 40_000).catch((e) => {
      console.log('translate failed', target, s.translate_model, String(e?.message || e).slice(0, 300));
      return '';
    });
    const got = parseJsonObject(res);
    if (!got) {
      if (res) console.log('translate: unparseable answer', target, res.slice(0, 200));
      continue;
    }
    for (const k of Object.keys(chunk)) if (got[k] && got[k].trim()) out[k] = got[k].trim().slice(0, 4000);
  }
  return out;
}

// ---------- The console page ----------
// ---------- 后台页 ----------

export const llmAdminApp = new Hono<Ctx>();

function requireGlobal(c: any): User {
  const user = c.get('user') as User;
  if (!user?.is_admin) throw new HttpError(403, 'e_global_admin_only');
  return user;
}

llmAdminApp.get('/', async (c) => {
  requireGlobal(c);
  const settings = await getLlmSettings(c.env);
  return c.json({
    settings,
    defaults: { translate_model: DEFAULT_TRANSLATE_MODEL, translate_prompt: DEFAULT_TRANSLATE_PROMPT },
    models: CHAT_MODELS.map((m) => ({ id: m.id, label: m.label })),
    available: aiAvailable(c.env),
    langs: FORM_LANGS,
  });
});

llmAdminApp.put('/', async (c) => {
  const me = requireGlobal(c);
  const body = await c.req.json<any>().catch(() => ({}));
  const model = String(body.translate_model || '').trim();
  const prompt = String(body.translate_prompt || '').replace(/\r\n?/g, '\n').trim();
  if (!MODEL_RE.test(model)) throw new HttpError(400, 'e_llm_bad_model');
  if (!prompt.includes('{lang}') || prompt.length > PROMPT_MAX) throw new HttpError(400, 'e_llm_bad_prompt');
  await setMeta(c.env, KEY_MODEL, model);
  await setMeta(c.env, KEY_PROMPT, prompt);
  await audit(c.env, me, 'llm.settings', model, { prompt_len: prompt.length });
  return c.json({ settings: await getLlmSettings(c.env) });
});

/** Try the configuration on a few form-like strings before trusting it with real forms. Unsaved
 *  values from the page are used when given, so a change can be tried before it is saved.
 *  先拿几条表单式的字符串试试这套配置,再让它去碰真正的表单。页面上未保存的值若给了就用它,
 *  这样一个改动可以先试后存。 */
llmAdminApp.post('/test', async (c) => {
  requireGlobal(c);
  if (!aiAvailable(c.env)) throw new HttpError(503, 'e_llm_unavailable');
  const body = await c.req.json<any>().catch(() => ({}));
  const target = FORM_LANGS.includes(String(body.lang)) ? String(body.lang) : 'en';
  const saved = await getLlmSettings(c.env);
  const model = MODEL_RE.test(String(body.translate_model || '')) ? String(body.translate_model) : saved.translate_model;
  const promptIn = String(body.translate_prompt || '').trim();
  const prompt = promptIn.includes('{lang}') && promptIn.length <= PROMPT_MAX ? promptIn : saved.translate_prompt;
  const sample = String(body.text || '').trim().slice(0, 500);
  const items: Record<string, string> = sample
    ? { text: sample }
    : { title: 'Customer satisfaction survey', q1: 'How did you hear about us?', help: 'Pick the closest answer', opt: 'Word of mouth' };
  const t0 = Date.now();
  const got = await translateInto(c.env, target, items, { translate_model: model, translate_prompt: prompt });
  return c.json({ ok: Object.keys(got).length > 0, ms: Date.now() - t0, model, lang: target, input: items, output: got });
});
