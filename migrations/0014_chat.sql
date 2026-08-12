-- AI assistant (chat subsystem): global settings, session index, user memories, files.
-- AI 助手(chat 子系统):全局设置、会话索引、用户记忆、聊天文件
-- Message bodies live in each session's Durable Object SQLite; D1 only holds the
-- index and the cross-session data.
-- 消息正文存在每个会话的 Durable Object SQLite 里,D1 只做索引与跨会话数据

-- Global key/value settings (chat_enabled / chat_default_model / chat_search_key ...)
-- 全局键值设置(chat_enabled / chat_default_model / chat_search_key 等)
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE chat_sessions (
  -- Doubles as the Durable Object instance name / 同时是 DO 实例名
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  -- Group name; '' means ungrouped / 分组名,'' = 未分组
  grp        TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  msg_count  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC);

-- Long-term per-user memory across sessions (auto-extracted plus written by a model
-- tool). Users can review and delete entries.
-- 跨会话的用户长期记忆(自动提取 + 模型工具写入),用户可查看/删除
CREATE TABLE chat_memories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'auto',      -- auto | tool
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_memories_user ON chat_memories(user_id, updated_at DESC);

-- Chat attachments and generated images; bytes live in R2 under the chat/ prefix
-- 聊天附件与生成的图片,字节存 R2(chat/ 前缀)
CREATE TABLE chat_files (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  session_id TEXT,
  kind       TEXT NOT NULL DEFAULT 'file',      -- image | audio | file | gen
  filename   TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  r2_key     TEXT NOT NULL,
  -- Audio transcription / extracted text-file content / 音频转写 / 文本文件抽取内容
  extract    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_files_user ON chat_files(user_id, created_at DESC);
CREATE INDEX idx_chat_files_session ON chat_files(session_id);
