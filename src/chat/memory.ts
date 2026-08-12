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
  return `\n\n[关于该用户的长期记忆,来自过往对话,供参考]\n${lines}`;
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
      '你是记忆提取器。从下面这轮对话中提取"值得长期记住的关于用户本人的信息"(身份、偏好、正在做的事、明确要求记住的内容)。' +
      '只提取用户主动透露的稳定事实,不要提取一次性问题、常识、助手的回答内容。' +
      '每条不超过 60 字,用用户使用的语言。最多 2 条,没有就输出空数组。' +
      '已有记忆里出现过的意思不要重复。只输出 JSON 数组,如 ["用户是设计师"] 或 []。' +
      (existing.length ? `\n已有记忆:\n${existing.map((m) => `- ${m.content}`).join('\n')}` : ''),
    prompt: `用户说:\n${userText}\n\n助手答(节选):\n${assistantText}`,
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
