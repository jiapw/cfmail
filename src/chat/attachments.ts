// Chat attachment handling: store in R2 and pre-process (audio transcription, text extraction). Messages reference them by file_id when sent.
// 聊天附件上传处理:入 R2 + 预处理(音频转写、文本抽取),消息发送时按 file_id 引用
import { transcribe } from 'ai';
import { getWorkersAI } from './provider';
import type { Env, User } from '../types';
import { HttpError } from '../send';
import { now, uid } from '../util';
import { DEFAULT_ASR } from './models';

export type ChatFileKind = 'image' | 'audio' | 'file' | 'gen';

export interface ChatFileRow {
  id: string;
  user_id: string;
  session_id: string | null;
  kind: ChatFileKind;
  filename: string;
  mime: string;
  size: number;
  r2_key: string;
  extract: string | null;
  created_at: number;
}

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_AUDIO = 20 * 1024 * 1024;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_EXTRACT_CHARS = 60_000;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonc|yml|yaml|xml|html|htm|css|scss|js|mjs|ts|tsx|jsx|py|java|c|h|cpp|go|rs|rb|php|sh|bat|ps1|sql|toml|ini|conf|log|eml)$/i;

export function classifyKind(mime: string, filename: string): ChatFileKind {
  if (/^image\//i.test(mime)) return 'image';
  if (/^audio\//i.test(mime) || /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(filename)) return 'audio';
  return 'file';
}

export async function handleChatUpload(env: Env, user: User, form: FormData, asrModel?: string): Promise<any> {
  const f = form.get('file');
  if (!(f instanceof File)) throw new HttpError(400, '缺少文件');
  const filename = (f.name || 'file').slice(0, 160);
  const mime = f.type || 'application/octet-stream';
  const kind = classifyKind(mime, filename);
  const cap = kind === 'image' ? MAX_IMAGE : kind === 'audio' ? MAX_AUDIO : MAX_FILE;
  if (f.size > cap) throw new HttpError(413, `文件超过上限 ${(cap / 1024 / 1024).toFixed(0)}MB`);
  const buf = await f.arrayBuffer();

  const id = uid();
  const key = `chat/up/${id}`;
  await env.RAW.put(key, buf, { httpMetadata: { contentType: mime } });

  let extract: string | null = null;
  if (kind === 'audio') {
    extract = await transcribeAudio(env, buf, asrModel || DEFAULT_ASR).catch((e) => {
      console.log('chat transcribe failed', e);
      return null;
    });
  } else if (kind === 'file' && isTextLike(mime, filename)) {
    try {
      extract = new TextDecoder('utf-8').decode(buf.slice(0, 512 * 1024)).slice(0, MAX_EXTRACT_CHARS);
      // Backstop against misdetecting binary: too many control characters means this is not text
      // 二进制误判兜底:控制字符太多说明不是文本
      const bad = (extract.slice(0, 2000).match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g) || []).length;
      if (bad > 20) extract = null;
    } catch {
      extract = null;
    }
  }

  await env.DB.prepare(
    'INSERT INTO chat_files (id, user_id, session_id, kind, filename, mime, size, r2_key, extract, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)'
  ).bind(id, user.id, null, kind, filename, mime, buf.byteLength, key, extract, now()).run();

  return {
    id, kind, filename, mime, size: buf.byteLength,
    has_extract: !!extract,
    extract_preview: extract ? extract.slice(0, 120) : null,
  };
}

async function transcribeAudio(env: Env, buf: ArrayBuffer, asrModel: string): Promise<string | null> {
  const workersai = getWorkersAI(env);
  const { text } = await transcribe({
    model: workersai.transcription(asrModel),
    audio: new Uint8Array(buf),
  });
  const s = (text || '').trim();
  return s ? s.slice(0, MAX_EXTRACT_CHARS) : null;
}

function isTextLike(mime: string, filename: string): boolean {
  return /^text\//i.test(mime) || /json|xml|yaml|javascript|typescript|x-sh|csv/i.test(mime) || TEXT_EXT.test(filename);
}

export async function getChatFile(env: Env, userId: string, id: string): Promise<ChatFileRow | null> {
  const row = await env.DB.prepare('SELECT * FROM chat_files WHERE id=?1 AND user_id=?2')
    .bind(id, userId).first<ChatFileRow>();
  return row || null;
}
