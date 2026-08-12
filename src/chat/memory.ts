// Long-term user memory: injected into the system prompt, and extracted in the background after each exchange
// 用户长期记忆:注入系统提示词 + 每轮对话后台自动提取
import { generateText } from 'ai';
import { getWorkersAI } from './provider';
import type { Env } from '../types';
import { now, uid } from '../util';
import { UTILITY_MODEL } from './models';

const MAX_MEMORIES = 300;      // 每用户上限,超出淘汰最旧
const INJECT_LIMIT = 60;       // 注入提示词的条数上限

export interface MemoryRow {
  id: string;
  content: string;
  source: string;
  created_at: number;
  updated_at: number;
}

export async function loadMemories(env: Env, userId: string, limit = INJECT_LIMIT): Promise<MemoryRow[]> {
  const rows = await env.DB.prepare(
    'SELECT id, content, source, created_at, updated_at FROM chat_memories WHERE user_id=?1 ORDER BY updated_at DESC LIMIT ?2'
  ).bind(userId, limit).all<MemoryRow>();
  return rows.results || [];
}

export function memoryPromptBlock(memories: MemoryRow[]): string {
  if (!memories.length) return '';
  const lines = memories.map((m) => `- ${m.content}`).join('\n');
  return `\n\n[Long-term memory about this user, gathered from earlier chats, for reference]\n${lines}`;
}

export async function saveMemory(env: Env, userId: string, content: string, source: string): Promise<boolean> {
  content = content.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (content.length < 4) return false;
  // Identical content only refreshes the timestamp instead of storing a duplicate
  // 完全相同的内容只刷新时间,不重复存
  const dup = await env.DB.prepare('SELECT id FROM chat_memories WHERE user_id=?1 AND content=?2')
    .bind(userId, content).first<{ id: string }>();
  const t = now();
  if (dup) {
    await env.DB.prepare('UPDATE chat_memories SET updated_at=?1 WHERE id=?2').bind(t, dup.id).run();
    return false;
  }
  await env.DB.prepare(
    'INSERT INTO chat_memories (id, user_id, content, source, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)'
  ).bind(uid(), userId, content, source, t).run();
  await env.DB.prepare(
    `DELETE FROM chat_memories WHERE user_id=?1 AND id NOT IN
     (SELECT id FROM chat_memories WHERE user_id=?1 ORDER BY updated_at DESC LIMIT ?2)`
  ).bind(userId, MAX_MEMORIES).run();
  return true;
}

/** After an exchange, extract in the background whatever is worth remembering about the user long term (0-2 items)
 *  一轮对话结束后,后台从这轮内容里提取值得长期记住的用户信息(0-2 条) */
export async function extractMemories(env: Env, userId: string, userText: string, assistantText: string): Promise<void> {
  userText = userText.slice(0, 3000);
  assistantText = assistantText.slice(0, 1500);
  if (userText.replace(/\s/g, '').length < 6) return;
  const existing = await loadMemories(env, userId, 80);
  const workersai = getWorkersAI(env);
  const { text } = await generateText({
    model: workersai(UTILITY_MODEL, { reasoning_effort: null }),
    system:
      'You are a memory extractor. From the exchange below, pull out what is worth remembering long-term about the user themselves: who they are, their preferences, what they are working on, and anything they explicitly asked you to remember. ' +
      'Only take stable facts the user volunteered. Skip one-off questions, general knowledge, and anything the assistant said. ' +
      'Each entry under 60 characters, in the language the user writes in. At most 2 entries; output an empty array if there are none.' +
      'Do not repeat anything already covered by an existing memory. Output only a JSON array, e.g. ["the user is a designer"] or [].' +
      (existing.length ? `\nExisting memories:\n${existing.map((m) => `- ${m.content}`).join('\n')}` : ''),
    prompt: `User said:\n${userText}\n\nAssistant replied (excerpt):\n${assistantText}`,
  });
  const arr = parseJsonArray(text);
  for (const item of arr.slice(0, 2)) {
    if (typeof item === 'string') await saveMemory(env, userId, item, 'auto');
  }
}

function parseJsonArray(text: string): unknown[] {
  const m = /\[[\s\S]*\]/.exec(text || '');
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
