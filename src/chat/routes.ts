// HTTP routes for the assistant: sessions, messages, attachments, memories, plus the admin settings
// Mounted twice: api.ts mounts /api/chat (signed-in users, gated by the switch); admin.ts mounts /api/admin/chat (global admins only)
// AI 助手 HTTP 路由:会话/消息/附件/记忆 + 管理端设置
// 挂载:api.ts 挂 /api/chat(登录用户,受全局开关限制);admin.ts 挂 /api/admin/chat(仅全局管理员)
import { Hono } from 'hono';
import { getAgentByName } from 'agents';
import { generateSpeech } from 'ai';
import type { Env, User } from '../types';
import { requireAuth } from '../auth';
import { HttpError } from '../send';
import { now, uid } from '../util';
import {
  ASR_MODELS, CHAT_MODELS, IMAGE_MODELS, TTS_MODELS, VISION_MODELS, getChatModel,
} from './models';
import { chatDomainById, chatDomainForHost, updateChatDomain, type ChatDomain, type ChatDomainPatch } from './settings';
import { getChatFile, handleChatUpload } from './attachments';
import { getWorkersAI } from './provider';
import type { ChatAgent } from './agent';

type Ctx = { Bindings: Env; Variables: { user: User } };

const MAX_SESSIONS = 500; // 每用户会话上限

async function agentStub(env: Env, sessionId: string) {
  return await getAgentByName(env.CHAT_AGENT as unknown as DurableObjectNamespace<ChatAgent>, sessionId);
}

async function ownedSession(c: any, id: string): Promise<any> {
  const row = await c.env.DB.prepare('SELECT * FROM chat_sessions WHERE id=?1 AND user_id=?2')
    .bind(id, c.get('user').id).first();
  if (!row) throw new HttpError(404, '会话不存在');
  return row;
}

function publicModels(allowed?: string[]) {
  return CHAT_MODELS.filter((m) => !allowed || allowed.includes(m.id)).map((m) => ({
    id: m.id, label: m.label, desc: m.desc, ctx: m.ctx,
    tools: m.tools, vision: m.vision, reasoning: m.reasoning,
  }));
}

/** Use body.model when it is valid and on this domain's allow-list, otherwise fall back to the domain default
 *  body.model 合法且在该域允许清单内则用之,否则回落该域默认模型 */
function resolveAllowedModel(d: ChatDomain, requested: string): string {
  const m = getChatModel(requested);
  return m && d.models.includes(m.id) ? m.id : d.default_model;
}

// ---------- User side ----------
// ---------- 用户侧 ----------

export const chatApp = new Hono<Ctx>();

chatApp.use('*', requireAuth);
// Read the switch and configuration for the domain being visited; anything but enabled is a 403
// 按访问域名(intl-mail.<域名>)取该域的开关与配置,未开启一律 403
chatApp.use('*', async (c, next) => {
  const d = await chatDomainForHost(c.env, new URL(c.req.url).hostname);
  if (!d || !d.enabled) return c.json({ error: 'AI 助手未开启' }, 403);
  (c as any).set('chatDomain', d);
  await next();
});

const chatDom = (c: any): ChatDomain => c.get('chatDomain');

chatApp.get('/config', async (c) => {
  const d = chatDom(c);
  return c.json({ models: publicModels(d.models), default_model: d.default_model });
});

chatApp.get('/sessions', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, title, grp, model, msg_count, created_at, updated_at FROM chat_sessions WHERE user_id=?1 ORDER BY updated_at DESC LIMIT ?2'
  ).bind(c.get('user').id, MAX_SESSIONS).all();
  return c.json({ sessions: rows.results || [] });
});

chatApp.post('/sessions', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<any>().catch(() => ({}));
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE user_id=?1')
    .bind(user.id).first<{ n: number }>();
  if ((cnt?.n || 0) >= MAX_SESSIONS) throw new HttpError(400, '会话数量已达上限,请先删除一些旧会话');
  const grp = String(body.grp || '').trim().slice(0, 40);
  const modelId = resolveAllowedModel(chatDom(c), String(body.model || ''));
  const id = uid();
  const t = now();
  await c.env.DB.prepare(
    'INSERT INTO chat_sessions (id, user_id, title, grp, model, msg_count, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,0,?6,?6)'
  ).bind(id, user.id, '', grp, modelId, t).run();
  return c.json({ id, title: '', grp, model: modelId, msg_count: 0, created_at: t, updated_at: t });
});

chatApp.patch('/sessions/:id', async (c) => {
  const sess = await ownedSession(c, c.req.param('id'));
  const body = await c.req.json<any>();
  const sets: string[] = [];
  const vals: any[] = [];
  if (typeof body.title === 'string') {
    sets.push(`title=?${vals.length + 1}`);
    vals.push(body.title.trim().slice(0, 60));
  }
  if (typeof body.grp === 'string') {
    sets.push(`grp=?${vals.length + 1}`);
    vals.push(body.grp.trim().slice(0, 40));
  }
  if (typeof body.model === 'string') {
    const m = getChatModel(body.model);
    if (!m) throw new HttpError(400, '模型无效');
    sets.push(`model=?${vals.length + 1}`);
    vals.push(m.id);
  }
  if (!sets.length) return c.json({ ok: true });
  vals.push(sess.id);
  await c.env.DB.prepare(`UPDATE chat_sessions SET ${sets.join(',')} WHERE id=?${vals.length}`).bind(...vals).run();
  return c.json({ ok: true });
});

chatApp.delete('/sessions/:id', async (c) => {
  const sess = await ownedSession(c, c.req.param('id'));
  // Clear the DO (the messages) first, then the D1 index and the associated files (R2 objects and rows)
  // 先清 DO(消息),再清 D1 索引与关联文件(R2 + 行)
  try {
    const stub = await agentStub(c.env, sess.id);
    await stub.fetch('https://agent/wipe', { method: 'POST' });
  } catch (e) {
    console.log('chat wipe failed', sess.id, e);
  }
  const files = await c.env.DB.prepare('SELECT id, r2_key FROM chat_files WHERE session_id=?1 AND user_id=?2')
    .bind(sess.id, c.get('user').id).all<any>();
  for (const f of files.results || []) {
    await c.env.RAW.delete(f.r2_key).catch(() => {});
  }
  await c.env.DB.prepare('DELETE FROM chat_files WHERE session_id=?1 AND user_id=?2')
    .bind(sess.id, c.get('user').id).run();
  await c.env.DB.prepare('DELETE FROM chat_sessions WHERE id=?1').bind(sess.id).run();
  return c.json({ ok: true });
});

// Bulk group actions: rename, or dissolve (dissolving returns the group's sessions to ungrouped)
// 分组批量操作:重命名 / 解散(解散 = 组内会话回到未分组)
chatApp.post('/groups', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<any>();
  const from = String(body.from || '').trim().slice(0, 40);
  if (!from) throw new HttpError(400, '缺少分组名');
  const action = String(body.action || '');
  const to = action === 'rename' ? String(body.to || '').trim().slice(0, 40) : '';
  if (action === 'rename' && !to) throw new HttpError(400, '缺少新分组名');
  if (!['rename', 'dissolve'].includes(action)) throw new HttpError(400, '不支持的操作');
  await c.env.DB.prepare('UPDATE chat_sessions SET grp=?1 WHERE user_id=?2 AND grp=?3')
    .bind(to, user.id, from).run();
  return c.json({ ok: true });
});

chatApp.get('/sessions/:id/messages', async (c) => {
  const sess = await ownedSession(c, c.req.param('id'));
  const stub = await agentStub(c.env, sess.id);
  const resp = await stub.fetch('https://agent/history');
  return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
});

chatApp.post('/sessions/:id/send', async (c) => {
  const user = c.get('user');
  const sess = await ownedSession(c, c.req.param('id'));
  const d = chatDom(c);
  const body = await c.req.json<any>();

  const model = getChatModel(resolveAllowedModel(d, String(body.model || sess.model || '')))!;
  if (model.id !== sess.model) {
    await c.env.DB.prepare('UPDATE chat_sessions SET model=?1 WHERE id=?2').bind(model.id, sess.id).run();
  }

  const fileIds: string[] = Array.isArray(body.files) ? body.files.slice(0, 8).map(String) : [];
  const files: any[] = [];
  for (const fid of fileIds) {
    const f = await getChatFile(c.env, user.id, fid);
    if (!f) throw new HttpError(400, '附件无效或已过期');
    files.push({ id: f.id, kind: f.kind, filename: f.filename, mime: f.mime, extract: f.extract });
    // Attachments belong to a session, so they are cleaned up when the session is deleted
    // 附件归属会话,会话删除时一并清理
    await c.env.DB.prepare('UPDATE chat_files SET session_id=?1 WHERE id=?2').bind(sess.id, f.id).run();
  }

  const stub = await agentStub(c.env, sess.id);
  const resp = await stub.fetch('https://agent/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: String(body.text || ''),
      model: model.id,
      files,
      session_id: sess.id,
      // The configuration of the domain being visited rides along with the request into the DO (everything is per domain)
      // 当前访问域名的配置随请求传入 DO(全部按域生效)
      settings: {
        default_model: d.default_model,
        search_key: d.search_key,
        web_search: d.web_search,
        vision_model: d.vision_model,
        image_model: d.image_model,
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        lang: String(body.lang || 'zh-CN').slice(0, 10),
      },
    }),
  });
  return new Response(resp.body, {
    status: resp.status,
    headers: {
      'Content-Type': resp.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
});

chatApp.post('/sessions/:id/abort', async (c) => {
  const sess = await ownedSession(c, c.req.param('id'));
  const stub = await agentStub(c.env, sess.id);
  await stub.fetch('https://agent/abort', { method: 'POST' });
  return c.json({ ok: true });
});

// ---------- Attachments ----------
// ---------- 附件 ----------

chatApp.post('/uploads', async (c) => {
  const form = await c.req.formData();
  return c.json(await handleChatUpload(c.env, c.get('user'), form, chatDom(c).asr_model));
});

// Read a piece of text aloud (an assistant reply); the model is configured per domain
// 朗读一段文字(助手回复),模型按域配置
chatApp.post('/tts', async (c) => {
  const d = chatDom(c);
  const body = await c.req.json<any>();
  const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!text) throw new HttpError(400, '没有可朗读的内容');
  const workersai = getWorkersAI(c.env);
  try {
    const { audio } = await generateSpeech({
      model: workersai.speech(d.tts_model),
      text,
      abortSignal: AbortSignal.timeout(60_000),
    });
    return c.body(audio.uint8Array as any, 200, {
      'Content-Type': audio.mediaType || 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  } catch (e: any) {
    console.log('tts failed', d.tts_model, e);
    throw new HttpError(502, '语音合成失败,请稍后再试或让管理员更换语音模型');
  }
});

// Raster images and audio render inline; everything else is returned as a download attachment, blocking same-origin XSS (the same policy as the /cid endpoint)
// 位图与音频内联展示;其余一律按下载附件返回,防同源 XSS(与 /cid 端点同一策略)
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

chatApp.get('/files/:id', async (c) => {
  const f = await getChatFile(c.env, c.get('user').id, c.req.param('id'));
  if (!f) throw new HttpError(404, '文件不存在');
  const obj = await c.env.RAW.get(f.r2_key);
  if (!obj) throw new HttpError(404, '文件不存在');
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    ETag: obj.httpEtag,
  };
  if (c.req.header('If-None-Match') === obj.httpEtag) return c.body(null, 304, headers);
  const inline = INLINE_IMAGE.test(f.mime) || /^audio\//i.test(f.mime);
  headers['Content-Type'] = inline ? f.mime : 'application/octet-stream';
  headers['Content-Disposition'] = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename || 'file')}`;
  return c.body(obj.body as any, 200, headers);
});

// ---------- Memory management ----------
// ---------- 记忆管理 ----------

chatApp.get('/memories', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, content, source, created_at, updated_at FROM chat_memories WHERE user_id=?1 ORDER BY updated_at DESC LIMIT 300'
  ).bind(c.get('user').id).all();
  return c.json({ memories: rows.results || [] });
});

chatApp.delete('/memories/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM chat_memories WHERE id=?1 AND user_id=?2')
    .bind(c.req.param('id'), c.get('user').id).run();
  return c.json({ ok: true });
});

chatApp.delete('/memories', async (c) => {
  await c.env.DB.prepare('DELETE FROM chat_memories WHERE user_id=?1').bind(c.get('user').id).run();
  return c.json({ ok: true });
});

// ---------- Admin side (mounted at /api/admin/chat; adminApp already checked authentication) ----------
// Each domain is configured independently: global admins manage every domain, domain admins only their own
// ---------- 管理端(挂 /api/admin/chat,adminApp 已做登录校验) ----------
// 每个域名独立配置;全局管理员管所有域,域管理员只管自己的域

export const chatAdminApp = new Hono<Ctx>();

async function checkChatAdmin(c: any, domainId: string): Promise<void> {
  const user: User = c.get('user');
  if (user.is_admin) return;
  const row = await c.env.DB.prepare('SELECT 1 AS x FROM domain_admins WHERE user_id=?1 AND domain_id=?2')
    .bind(user.id, domainId).first();
  if (!row) throw new HttpError(403, '无权管理该域名');
}

chatAdminApp.get('/:domainId/settings', async (c) => {
  const d = await chatDomainById(c.env, c.req.param('domainId'));
  if (!d) throw new HttpError(404, '域名不存在');
  await checkChatAdmin(c, d.id);
  const out: any = {
    domain: d.name,
    enabled: d.enabled,
    default_model: d.default_model,
    has_search_key: !!d.search_key,
    web_search: d.web_search,
    models: publicModels(),          // 全部对话模型(勾选清单用)
    enabled_models: d.models,        // 该域允许的模型 id
    vision_model: d.vision_model,
    asr_model: d.asr_model,
    tts_model: d.tts_model,
    image_model: d.image_model,
    vision_models: VISION_MODELS,
    asr_models: ASR_MODELS,
    tts_models: TTS_MODELS,
    image_models: IMAGE_MODELS,
  };
  // Sessions are not scoped to a domain (they follow the person), so the site-wide statistics are shown to global admins only
  // 会话不分域(跟人走),统计只给全局管理员看全站的
  if (c.get('user').is_admin) {
    const stat = await c.env.DB.prepare(
      'SELECT COUNT(*) AS sessions, COALESCE(SUM(msg_count),0) AS messages, COUNT(DISTINCT user_id) AS users FROM chat_sessions'
    ).first<any>();
    const fstat = await c.env.DB.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM chat_files').first<any>();
    out.stats = {
      sessions: stat?.sessions || 0,
      messages: stat?.messages || 0,
      users: stat?.users || 0,
      files: fstat?.files || 0,
      file_bytes: fstat?.bytes || 0,
    };
  }
  return c.json(out);
});

chatAdminApp.put('/:domainId/settings', async (c) => {
  const d = await chatDomainById(c.env, c.req.param('domainId'));
  if (!d) throw new HttpError(404, '域名不存在');
  await checkChatAdmin(c, d.id);
  const body = await c.req.json<any>();
  const patch: ChatDomainPatch = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (Array.isArray(body.models)) {
    const ids = [...new Set(body.models.map(String))].filter((id) => CHAT_MODELS.some((m) => m.id === id));
    if (!ids.length) throw new HttpError(400, '至少保留一个可选模型');
    patch.models = ids as string[];
    // When the default model is removed from the list, switch automatically to the first one still on it
    // 默认模型被移出清单时,自动切到清单里的第一个
    if (!ids.includes(d.default_model)) patch.default_model = ids[0] as string;
  }
  if (typeof body.default_model === 'string') {
    const m = getChatModel(body.default_model);
    if (!m) throw new HttpError(400, '模型无效');
    const allowed = patch.models || d.models;
    if (!allowed.includes(m.id)) throw new HttpError(400, '默认模型必须在勾选的模型里');
    patch.default_model = m.id;
  }
  // search_key: an empty string clears it; omitting the field leaves it untouched
  // search_key:传空串 = 清除;不传 = 不动
  if (typeof body.search_key === 'string') patch.search_key = body.search_key.trim().slice(0, 200);
  if (typeof body.web_search === 'boolean') patch.web_search = body.web_search;
  const cap = (field: 'vision_model' | 'asr_model' | 'tts_model' | 'image_model', list: { id: string }[]) => {
    const v = body[field];
    if (typeof v !== 'string') return;
    if (!list.some((m) => m.id === v)) throw new HttpError(400, '模型无效');
    patch[field] = v;
  };
  cap('vision_model', VISION_MODELS);
  cap('asr_model', ASR_MODELS);
  cap('tts_model', TTS_MODELS);
  cap('image_model', IMAGE_MODELS);
  await updateChatDomain(c.env, d.id, patch);
  return c.json({ ok: true });
});
