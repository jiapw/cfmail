// One chat session = one ChatAgent Durable Object instance (Agents SDK), with messages stored in the DO's own SQLite.
// Every request is authenticated in routes.ts and forwarded through a stub; the DO is never exposed directly.
// 每个聊天会话 = 一个 ChatAgent Durable Object 实例(Agents SDK),消息存 DO 内 SQLite。
// 所有请求都经 routes.ts 鉴权后经 stub 转发,DO 不对外暴露。
import { Agent } from 'agents';
import { generateText, stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { getWorkersAI } from './provider';
import { z } from 'zod';
import type { Env } from '../types';
import { now, uid } from '../util';
import { getChatModel, DEFAULT_IMAGE, DEFAULT_MODEL, DEFAULT_VISION, UTILITY_MODEL, type ChatModel } from './models';
import { generateImageFile, openUrl, webSearch } from './tools';
import { extractMemories, loadMemories, memoryPromptBlock, saveMemory } from './memory';

// ---------- Message shapes ----------
// ---------- 消息结构 ----------

export type MsgPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; call_id: string; name: string; input: unknown; output?: unknown; error?: string }
  | { type: 'file'; file_id: string; kind: string; filename: string; mime: string }
  // text = verbatim text (usually a third-party or runtime error, which we cannot translate);
  // code = an e_* key the client renders in the reader's language.
  // text = 原样文本(多为第三方或运行时报错,翻不了);code = e_* 词条码,由前端按语言渲染。
  | { type: 'error'; text?: string; code?: string }
  // Per-turn statistics (not rendered as content): thinking time and token usage, shown by the frontend on the "reasoning" row
  // 本轮统计(不渲染为内容):思考耗时 + token 用量,前端在"思考过程"行上展示
  | { type: 'meta'; think_ms?: number; usage?: { input?: number; output?: number; reasoning?: number } };

export interface StoredMsg {
  seq: number;
  id: string;
  role: 'user' | 'assistant';
  parts: MsgPart[];
  model: string | null;
  created_at: number;
}

interface SendBody {
  text: string;
  model: string;
  files: { id: string; kind: string; filename: string; mime: string; extract: string | null }[];
  user: { id: string; name: string; email: string; lang: string };
  session_id: string;
  // The configuration of the domain the message was sent from (resolved by the routing layer from the Host and passed in; the DO knows nothing about domains)
  // 发送时所在域名的配置(路由层按 Host 解析后传入,DO 不感知域名)
  settings: { default_model: string; search_key: string; web_search: boolean; vision_model: string; image_model: string };
}

interface PostTurnData {
  user_id: string;
  user_text: string;
  assistant_text: string;
  model_ctx: number;
}

const MAX_STEPS = 8;              // 一轮最多的模型调用步数(工具循环)
const RUN_TIMEOUT_MS = 240_000;   // 整轮硬超时
const KEEP_TAIL = 8;              // 压缩时保留不动的最近消息数
const HIST_FILE_TEXT_CAP = 12_000;

export class ChatAgent extends Agent<Env> {
  private running = false;
  private aborter: AbortController | null = null;

  private ensureTables() {
    this.sql`CREATE TABLE IF NOT EXISTS msgs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE, role TEXT NOT NULL, parts TEXT NOT NULL,
      model TEXT, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
  }

  private kvGet(k: string): string | null {
    const rows = this.sql<{ v: string }>`SELECT v FROM kv WHERE k = ${k}`;
    return rows.length ? rows[0].v : null;
  }
  private kvSet(k: string, v: string) {
    this.sql`INSERT INTO kv (k, v) VALUES (${k}, ${v}) ON CONFLICT(k) DO UPDATE SET v = ${v}`;
  }

  private loadMsgs(afterSeq = 0): StoredMsg[] {
    const rows = this.sql<any>`SELECT seq, id, role, parts, model, created_at FROM msgs WHERE seq > ${afterSeq} ORDER BY seq`;
    return rows.map((r: any) => ({ ...r, parts: JSON.parse(r.parts) }));
  }

  private saveMsg(role: 'user' | 'assistant', parts: MsgPart[], model: string | null): StoredMsg {
    const id = uid();
    const t = now();
    this.sql`INSERT INTO msgs (id, role, parts, model, created_at) VALUES (${id}, ${role}, ${JSON.stringify(parts)}, ${model}, ${t})`;
    const seq = this.sql<{ seq: number }>`SELECT seq FROM msgs WHERE id = ${id}`[0].seq;
    return { seq, id, role, parts, model, created_at: t };
  }

  // ---------- Internal HTTP entry point (Worker forwarding only) ----------
  // ---------- 内部 HTTP 入口(仅 Worker 转发) ----------

  async onRequest(request: Request): Promise<Response> {
    this.ensureTables();
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/history') {
        const compactSeq = parseInt(this.kvGet('compact_seq') || '0', 10);
        return json({
          messages: this.loadMsgs(0),
          summary: this.kvGet('summary') || '',
          compact_seq: compactSeq,
          running: this.running,
        });
      }
      if (path === '/send' && request.method === 'POST') {
        const body = (await request.json()) as SendBody;
        return this.handleSend(body);
      }
      if (path === '/abort' && request.method === 'POST') {
        this.aborter?.abort();
        return json({ ok: true });
      }
      if (path === '/wipe' && request.method === 'POST') {
        this.aborter?.abort();
        await this.destroy();
        return json({ ok: true });
      }
      return json({ error: 'e_not_found' }, 404);
    } catch (e: any) {
      console.log('chat agent error', path, e);
      return json({ error: String(e?.message || e) }, 500);
    }
  }

  // ---------- Sending and streaming execution ----------
  // ---------- 发送与流式执行 ----------

  private handleSend(body: SendBody): Response {
    if (this.running) return json({ error: 'e_reply_in_progress' }, 409);
    const text = String(body.text || '').slice(0, 32_000);
    const files = Array.isArray(body.files) ? body.files.slice(0, 8) : [];
    if (!text.trim() && !files.length) return json({ error: 'e_empty_message' }, 400);

    this.kvSet('owner', body.user.id);
    this.kvSet('session_id', body.session_id);

    const userParts: MsgPart[] = [];
    if (text.trim()) userParts.push({ type: 'text', text });
    for (const f of files) {
      userParts.push({ type: 'file', file_id: f.id, kind: f.kind, filename: f.filename, mime: f.mime });
    }
    const userMsg = this.saveMsg('user', userParts, null);

    this.running = true;
    this.aborter = new AbortController();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    let clientGone = false;
    const emit = async (ev: Record<string, unknown>) => {
      if (clientGone) return;
      try {
        await writer.write(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      } catch {
        clientGone = true;
        // Client disconnected: stop generating, but store whatever was produced
        // 客户端断开:停止生成,已生成部分照常入库
        this.aborter?.abort();
      }
    };

    // Handed to waitUntil to stay alive, so the response stream can return immediately
    // 交给 waitUntil 保活,响应流立即返回
    this.ctx.waitUntil(
      (async () => {
        const timeout = setTimeout(() => this.aborter?.abort(), RUN_TIMEOUT_MS);
        try {
          await emit({ t: 'user', message: userMsg });
          await this.runTurn(body, userMsg, emit);
        } catch (e: any) {
          console.log('chat run failed', e);
          await emit({ t: 'error', error: String(e?.message || e).slice(0, 500) });
        } finally {
          clearTimeout(timeout);
          this.running = false;
          this.aborter = null;
          try {
            await writer.close();
          } catch {}
        }
      })()
    );

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }

  private async runTurn(body: SendBody, userMsg: StoredMsg, emit: (ev: Record<string, unknown>) => Promise<void>) {
    const env = this.env;
    const model =
      getChatModel(body.model) || getChatModel(body.settings?.default_model || '') || getChatModel(DEFAULT_MODEL)!;
    const searchKey = body.settings?.search_key || '';
    // Internet access is a per-domain switch, off by default. While it is off these two tools are never
    // registered -- the model cannot see them, so it cannot send mail-derived queries to Brave or DuckDuckGo.
    // 联网能力按域开关,默认关。关着就根本不注册这两个工具 —— 模型看不到、也就不会
    // 把邮件衍生的查询词发给 Brave / DuckDuckGo
    const webSearchOn = body.settings?.web_search === true;
    const memories = await loadMemories(env, body.user.id);
    const workersai = getWorkersAI(env);

    const system = this.buildSystem(body.user, model, memoryPromptBlock(memories), webSearchOn);
    const visionModel = body.settings?.vision_model || DEFAULT_VISION;
    const imageModel = body.settings?.image_model || DEFAULT_IMAGE;
    const messages = await this.buildModelMessages(model, visionModel);

    // Tools: push an event to the frontend both before and after execution
    // 工具:执行前后都往前端推事件
    const sessionId = body.session_id;
    const tools: Record<string, any> | undefined = model.tools
      ? {
          generate_image: tool({
            description: 'Generate an image from a text description. The result is shown to the user automatically -- never invent an image URL.',
            inputSchema: z.object({
              prompt: z.string().describe('English description of the image; more detail gives a better result'),
            }),
            execute: async ({ prompt }: { prompt: string }) => {
              const r = await generateImageFile(env, body.user.id, sessionId, prompt, imageModel);
              return { ok: true, file_id: r.file_id, filename: r.filename, note: 'Image generated and shown to the user' };
            },
          }),
          save_memory: tool({
            description: 'Store something important about the user in long-term memory (when they ask you to remember it, or reveal a stable fact or preference).',
            inputSchema: z.object({ fact: z.string().describe('A single-sentence fact, under 60 characters') }),
            execute: async ({ fact }: { fact: string }) => {
              const saved = await saveMemory(env, body.user.id, fact, 'tool');
              return { saved };
            },
          }),
        }
      : undefined;
    // These two send content outside the account (Brave / DuckDuckGo), so they are mounted behind the
    // per-domain switch and are absent by default.
    // Not mounted = the model cannot see them at all; every other tool stays inside this account.
    // 联网这两个会把内容发到域外(Brave / DuckDuckGo),按域开关挂载,默认不挂。
    // 不挂 = 模型压根看不到这两个工具,其余工具都在本账号内闭环。
    if (tools && webSearchOn) {
      tools.web_search = tool({
        description: 'Search the web. Use it for current information, news, or facts you are unsure about.',
        inputSchema: z.object({
          query: z.string().describe('Search keywords'),
          count: z.number().int().min(1).max(8).optional().describe('How many results, default 5'),
        }),
        execute: async ({ query, count }: { query: string; count?: number }) => {
          const hits = await webSearch(env, searchKey, query, count || 5);
          return hits.length ? hits : { note: 'No results; try different keywords' };
        },
      });
      tools.open_url = tool({
        description: 'Open a web page and read its text. Usually used on a web_search result.',
        inputSchema: z.object({ url: z.string().describe('http/https URL') }),
        execute: async ({ url }: { url: string }) => await openUrl(url),
      });
    }

    const parts: MsgPart[] = [];
    const splitter = model.thinkTag ? new ThinkSplitter() : null;
    // Thinking time: the sum of consecutive reasoning segments; usage is the whole turn's total
    // 思考耗时:连续 reasoning 段的时间累加;usage 取整轮汇总
    let thinkMs = 0;
    let thinkStart = 0;
    let usage: { input?: number; output?: number; reasoning?: number } | null = null;
    const noteKind = (kind: 'reasoning' | 'other') => {
      if (kind === 'reasoning') {
        if (!thinkStart) thinkStart = Date.now();
      } else if (thinkStart) {
        thinkMs += Date.now() - thinkStart;
        thinkStart = 0;
      }
    };
    const appendDelta = async (kind: 'text' | 'reasoning', delta: string) => {
      if (!delta) return;
      noteKind(kind === 'reasoning' ? 'reasoning' : 'other');
      const last = parts[parts.length - 1];
      if (last && last.type === kind) (last as any).text += delta;
      else parts.push({ type: kind, text: delta } as MsgPart);
      await emit({ t: 'delta', kind, text: delta });
    };

    const result = streamText({
      model: workersai(model.id),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: this.aborter!.signal,
    });

    let aborted = false;
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta': {
            if (splitter) {
              for (const seg of splitter.push(part.text)) await appendDelta(seg.kind, seg.text);
            } else {
              await appendDelta('text', part.text);
            }
            break;
          }
          case 'reasoning-delta':
            await appendDelta('reasoning', part.text);
            break;
          case 'tool-call': {
            noteKind('other');
            const p: MsgPart = { type: 'tool', call_id: part.toolCallId, name: part.toolName, input: part.input };
            parts.push(p);
            await emit({ t: 'tool', call_id: part.toolCallId, name: part.toolName, input: part.input });
            break;
          }
          case 'finish': {
            const u = part.totalUsage;
            if (u) {
              usage = {
                input: u.inputTokens,
                output: u.outputTokens,
                reasoning: u.outputTokenDetails?.reasoningTokens,
              };
            }
            break;
          }
          case 'tool-result': {
            const p = parts.find((x) => x.type === 'tool' && x.call_id === part.toolCallId) as any;
            const uiOut = compactToolOutput(part.toolName, part.output);
            if (p) p.output = uiOut;
            await emit({ t: 'tool_result', call_id: part.toolCallId, name: part.toolName, output: uiOut });
            break;
          }
          case 'tool-error': {
            const p = parts.find((x) => x.type === 'tool' && x.call_id === part.toolCallId) as any;
            const msg = String((part as any).error?.message || (part as any).error || 'e_tool_failed').slice(0, 300);
            if (p) p.error = msg;
            await emit({ t: 'tool_error', call_id: part.toolCallId, name: part.toolName, error: msg });
            break;
          }
          case 'abort':
            aborted = true;
            break;
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String((part as any).error));
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError' || this.aborter?.signal.aborted) aborted = true;
      else {
        // A model-side error: keep whatever content already arrived and surface the error as one more part
        // 模型侧错误:已有内容照常保存,把错误作为一个 part 展示
        parts.push({ type: 'error', text: String(e?.message || e).slice(0, 500) });
        await emit({ t: 'error', error: String(e?.message || e).slice(0, 500) });
      }
    }
    if (splitter) for (const seg of splitter.end()) await appendDelta(seg.kind, seg.text);
    noteKind('other'); // 收尾:思考段可能一直持续到结束
    if (aborted) parts.push({ type: 'error', code: 'e_stopped' });

    if (!parts.length) parts.push({ type: 'error', code: 'e_no_content' });
    // Some reasoning models occasionally emit thinking and no answer (seen with gpt-oss on short tasks); show a visible note instead of nothing
    // 个别推理模型偶尔只出思考不出正文(gpt-oss 短任务踩过),给一句可见的提示
    else if (!aborted && !parts.some((p) => p.type === 'text' || p.type === 'error')) {
      parts.push({ type: 'error', code: 'e_thinking_only' });
    }
    if (thinkMs > 300 || usage) parts.push({ type: 'meta', think_ms: thinkMs || undefined, usage: usage || undefined });
    const assistantMsg = this.saveMsg('assistant', parts, model.id);

    // Update the session index (message count and timestamp)
    // 会话索引更新(消息数/时间)
    await env.DB.prepare('UPDATE chat_sessions SET msg_count = msg_count + 2, updated_at = ?1 WHERE id = ?2')
      .bind(now(), sessionId).run();

    // Generate a title once the first exchange completes
    // 首轮结束后生成标题
    const assistantText = parts.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n');
    if (!this.kvGet('title_done')) {
      const title = await this.makeTitle(body, assistantText).catch(() => '');
      if (title) {
        await env.DB.prepare('UPDATE chat_sessions SET title = ?1 WHERE id = ?2').bind(title, sessionId).run();
        this.kvSet('title_done', '1');
        await emit({ t: 'title', title });
      }
    }

    await emit({ t: 'done', message: assistantMsg });

    // Background work: memory extraction and history compaction (scheduled through a DO alarm, so it still runs reliably after the response closes)
    // 后台:记忆提取 + 历史压缩(schedule 走 DO alarm,响应关闭后也可靠执行)
    const userText = userMsg.parts.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n');
    await this.schedule<PostTurnData>(1, 'postTurn', {
      user_id: body.user.id,
      user_text: userText,
      assistant_text: assistantText,
      model_ctx: model.ctx,
    });
  }

  private buildSystem(user: SendBody['user'], model: ChatModel, memoryBlock: string, webSearchOn: boolean): string {
    // UTC only. A fixed offset would be wrong for everyone outside that one zone, and the
    // server does not know the reader's -- if the local time matters, the user can say so.
    // 只给 UTC。写死某个时区对其他地方的人一律是错的,而服务端并不知道使用者在哪;
    // 真要用本地时间,用户自己说一声即可。
    const t = new Date();
    const lines = [
      'You are the assistant built into CFMail, a company webmail system, running on Cloudflare Workers AI.',
      `Current user: ${user.name || user.email} <${user.email}>.`,
      `Current time: ${t.toISOString()} (UTC).`,
      'Always answer in the language the user writes in. Format with Markdown, put code in code blocks, and break the text into paragraphs.',
      'If you reason before answering: always produce the actual answer afterwards. Never leave the answer inside the reasoning.',
    ];
    if (model.tools) {
      // When the internet tools are not mounted, do not mention them in the prompt, or the model will try to call a tool that does not exist
      // 联网工具没挂载时别在提示词里提它,否则模型会去调一个不存在的工具
      lines.push(
        'Tools: ' +
          (webSearchOn
            ? 'use web_search for current information or facts you are unsure about, and open_url to read a result in full; '
            : 'internet access is switched off on this deployment, so web_search/open_url are unavailable -- say plainly that you cannot look it up; ') +
          'use generate_image when the user asks for a picture (it is displayed automatically -- never output a made-up link); ' +
          'use save_memory when the user asks you to remember something or reveals a stable fact or preference about themselves.'
      );
    } else {
      lines.push('This model cannot call tools, so you have no web search or image generation. Say so when a question needs live information.');
    }
    const summary = this.kvGet('summary');
    if (summary) lines.push(`\n[Summary of earlier messages in this chat]\n${summary}`);
    if (memoryBlock) lines.push(memoryBlock);
    return lines.join('\n');
  }

  /** Turn the DO's stored history into model messages. Images from the current turn go to a vision model as-is; everywhere else they go as text descriptions.
   *  把 DO 里的历史消息转换成模型消息;当前轮的图片对视觉模型走原图,其余场景走描述文字 */
  private async buildModelMessages(model: ChatModel, visionModel: string): Promise<ModelMessage[]> {
    const compactSeq = parseInt(this.kvGet('compact_seq') || '0', 10);
    const msgs = this.loadMsgs(compactSeq);
    const out: ModelMessage[] = [];
    const lastSeq = msgs.length ? msgs[msgs.length - 1].seq : 0;

    for (const m of msgs) {
      if (m.role === 'assistant') {
        const text = m.parts
          .map((p) => {
            if (p.type === 'text') return p.text;
            if (p.type === 'tool' && p.name === 'generate_image') return '[an image was generated and shown to the user]';
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .slice(0, 16_000);
        if (text) out.push({ role: 'assistant', content: text });
        continue;
      }
      // user message: text plus attachments
      // user 消息:文本 + 附件
      const textParts: string[] = [];
      const imageParts: { type: 'image'; image: Uint8Array }[] = [];
      for (const p of m.parts) {
        if (p.type === 'text') {
          textParts.push(p.text);
        } else if (p.type === 'file') {
          const rendered = await this.renderFilePart(p, model, m.seq === lastSeq, visionModel);
          if (rendered.image) imageParts.push({ type: 'image', image: rendered.image });
          if (rendered.text) textParts.push(rendered.text);
        }
      }
      const text = textParts.join('\n\n');
      if (imageParts.length) {
        out.push({ role: 'user', content: [...(text ? [{ type: 'text' as const, text }] : []), ...imageParts] });
      } else {
        out.push({ role: 'user', content: text || '(empty)' });
      }
    }
    return out;
  }

  /** Attachment -> something the model can read. Images: the original goes to a vision model on the current turn (up to 4), otherwise a description (generated lazily and cached).
   *  附件 → 模型可读内容。图片:视觉模型且当前轮给原图(≤4张),否则给描述(懒生成并缓存) */
  private async renderFilePart(
    p: Extract<MsgPart, { type: 'file' }>,
    model: ChatModel,
    isCurrent: boolean,
    visionModel: string
  ): Promise<{ text?: string; image?: Uint8Array }> {
    const env = this.env;
    const row = await env.DB.prepare('SELECT kind, filename, mime, r2_key, extract FROM chat_files WHERE id=?1')
      .bind(p.file_id).first<any>();
    if (!row) return { text: `[attachment ${p.filename} no longer exists]` };

    if (row.kind === 'image' || row.kind === 'gen') {
      if (model.vision && isCurrent) {
        const obj = await env.RAW.get(row.r2_key);
        if (obj) return { image: new Uint8Array(await obj.arrayBuffer()) };
      }
      const caption = row.extract || (await this.captionImage(p.file_id, row, visionModel).catch(() => null));
      return { text: caption ? `[image ${row.filename}]: ${caption}` : `[image ${row.filename} (this model cannot see it)]` };
    }
    if (row.kind === 'audio') {
      return { text: row.extract ? `[transcript of audio ${row.filename}]:\n${row.extract}` : `[audio ${row.filename}, transcription failed]` };
    }
    if (row.extract) {
      return { text: `[contents of ${row.filename}]:\n${String(row.extract).slice(0, HIST_FILE_TEXT_CAP)}` };
    }
    return { text: `[file ${row.filename} (${row.mime}); contents unreadable, only the name is known]` };
  }

  /** When a non-vision model needs one, generate the image description with the domain's configured vision model and cache it on chat_files.extract
   *  非视觉模型需要时,用按域配置的识图模型生成图片描述并缓存到 chat_files.extract */
  private async captionImage(fileId: string, row: any, visionModel: string): Promise<string | null> {
    const env = this.env;
    const obj = await env.RAW.get(row.r2_key);
    if (!obj) return null;
    const workersai = getWorkersAI(env);
    const { text } = await generateText({
      model: workersai(visionModel),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image factually in two or three sentences, including any text it contains. Output the description only.' },
            { type: 'image', image: new Uint8Array(await obj.arrayBuffer()) },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(60_000),
    });
    const caption = (text || '').trim().slice(0, 1000);
    if (caption) {
      await env.DB.prepare('UPDATE chat_files SET extract=?1 WHERE id=?2').bind(caption, fileId).run();
    }
    return caption || null;
  }

  private async makeTitle(body: SendBody, assistantText: string): Promise<string> {
    const workersai = getWorkersAI(this.env);
    const { text } = await generateText({
      model: workersai(UTILITY_MODEL, { reasoning_effort: null }),
      system: 'Give this conversation a short title: at most 16 characters, in the same language as the conversation, no quotes and no punctuation. Output the title only.',
      prompt: `User: ${body.text.slice(0, 500)}\nAssistant: ${assistantText.slice(0, 300)}`,
      abortSignal: AbortSignal.timeout(30_000),
    });
    return (text || '').trim().replace(/^["'「『]|["'」』]$/g, '').split('\n')[0].slice(0, 24);
  }

  // ---------- Per-turn background work (scheduled by a DO alarm, so it runs reliably) ----------
  // ---------- 每轮后台任务(DO alarm 调度,可靠执行) ----------

  async postTurn(data: PostTurnData) {
    this.ensureTables();
    try {
      await extractMemories(this.env, data.user_id, data.user_text, data.assistant_text);
    } catch (e) {
      console.log('memory extract failed', e);
    }
    try {
      await this.compactIfNeeded(data.model_ctx);
    } catch (e) {
      console.log('compact failed', e);
    }
  }

  /** Once the uncompacted part exceeds half the model's context (roughly estimated at 3 characters per token), fold the older messages into a rolling summary
   *  未压缩部分超过模型上下文的一半(按 3 字符/token 粗估)时,把旧消息合并进滚动摘要 */
  private async compactIfNeeded(modelCtx: number) {
    const compactSeq = parseInt(this.kvGet('compact_seq') || '0', 10);
    const msgs = this.loadMsgs(compactSeq);
    if (msgs.length <= KEEP_TAIL + 4) return;
    const totalChars = msgs.reduce((a, m) => a + JSON.stringify(m.parts).length, 0);
    const budgetChars = Math.min(modelCtx, 131_000) * 3 * 0.5;
    if (totalChars < budgetChars) return;

    const toSummarize = msgs.slice(0, msgs.length - KEEP_TAIL);
    const oldSummary = this.kvGet('summary') || '';
    const transcript = toSummarize
      .map((m) => {
        const text = m.parts
          .map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? `[attachment: ${p.filename}]` : p.type === 'tool' ? `[tool: ${p.name}]` : ''))
          .filter(Boolean)
          .join(' ');
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 1500)}`;
      })
      .join('\n');

    const workersai = getWorkersAI(this.env);
    const { text } = await generateText({
      model: workersai(UTILITY_MODEL, { reasoning_effort: null }),
      system:
        'Compress the transcript into a summary. Keep: topics discussed and their conclusions, the user requests and preferences, important facts and figures, and anything left unfinished. ' +
        'Use the same language as the conversation, as a list, under 1500 characters. Output the summary only.',
      prompt: (oldSummary ? `[existing summary]\n${oldSummary}\n\n[new messages]\n` : '') + transcript.slice(0, 60_000),
      abortSignal: AbortSignal.timeout(90_000),
    });
    const summary = (text || '').trim().slice(0, 6000);
    if (!summary) return;
    this.kvSet('summary', summary);
    this.kvSet('compact_seq', String(toSummarize[toSummarize.length - 1].seq));
  }
}

// ---------- Trimmed-down tool output for the frontend ----------
// ---------- 工具输出给前端的精简版 ----------

function compactToolOutput(name: string, output: unknown): unknown {
  try {
    if (name === 'web_search' && Array.isArray(output)) {
      return output.map((h: any) => ({ title: h.title, url: h.url })).slice(0, 8);
    }
    if (name === 'open_url' && output && typeof output === 'object') {
      const o = output as any;
      return { title: o.title, url: o.url, chars: (o.text || '').length };
    }
    return output && typeof output === 'object'
      ? JSON.parse(JSON.stringify(output).slice(0, 2000) + '') // 截断防超大
      : output;
  } catch {
    return { note: '(result too large, omitted)' };
  }
}

// ---------- <think> tag splitter (qwen3 / deepseek-r1 mix reasoning into the body) ----------
// ---------- <think> 标签拆分器(qwen3 / deepseek-r1 把思考混在正文里) ----------

class ThinkSplitter {
  private buf = '';
  private mode: 'detect' | 'think' | 'text' = 'detect';

  push(chunk: string): { kind: 'text' | 'reasoning'; text: string }[] {
    this.buf += chunk;
    const out: { kind: 'text' | 'reasoning'; text: string }[] = [];
    for (;;) {
      if (this.mode === 'detect') {
        const lead = this.buf.replace(/^\s+/, '');
        if (!lead.length) return out;
        if (lead.startsWith('<think>')) {
          this.buf = lead.slice(7);
          this.mode = 'think';
          continue;
        }
        if ('<think>'.startsWith(lead)) return out; // 还看不出来,等更多字节
        this.mode = 'text';
        continue;
      }
      if (this.mode === 'think') {
        const idx = this.buf.indexOf('</think>');
        if (idx >= 0) {
          if (idx > 0) out.push({ kind: 'reasoning', text: this.buf.slice(0, idx) });
          this.buf = this.buf.slice(idx + 8).replace(/^\s+/, '');
          this.mode = 'text';
          continue;
        }
        // Hold back 8 characters so a closing tag cannot be split across two chunks
        // 留 8 个字符防止闭合标签被拆在两个 chunk 里
        if (this.buf.length > 8) {
          out.push({ kind: 'reasoning', text: this.buf.slice(0, this.buf.length - 8) });
          this.buf = this.buf.slice(this.buf.length - 8);
        }
        return out;
      }
      // text mode: emit everything
      // text 模式:全部吐出
      if (this.buf) {
        out.push({ kind: 'text', text: this.buf });
        this.buf = '';
      }
      return out;
    }
  }

  end(): { kind: 'text' | 'reasoning'; text: string }[] {
    const rest = this.buf;
    this.buf = '';
    if (!rest) return [];
    return [{ kind: this.mode === 'think' ? 'reasoning' : 'text', text: rest }];
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
