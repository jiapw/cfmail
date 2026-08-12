-- cfmail initial schema / cfmail 初始 schema
-- Design notes / 设计要点:
--  1. IMAP-ready: folders carry uidvalidity/uidnext, messages carry a per-folder
--     monotonic uid plus standard IMAP flags.
--     IMAP-ready:folders 带 uidvalidity/uidnext,messages 带文件夹内单调 uid,标准 IMAP flags
--  2. Bodies are not stored in the database: raw MIME lives in R2, D1 holds only
--     metadata plus searchable text.
--     正文不入库:原始 MIME 全部在 R2,D1 只存元数据 + 搜索文本
--  3. One user (registered with an existing email) maps to many company mailboxes
--     through grants.
--     一个用户(既有邮箱注册)通过 grants 多对多挂多个企业邮箱

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  -- Existing personal email used to sign in (lowercase) / 登录用的既有个人邮箱(小写)
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  pw_hash       TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,    -- Global administrator / 全局管理员
  disabled      INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  last_login    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                 -- sha256(token)
  user_id    TEXT NOT NULL,
  ua         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE domains (
  id         TEXT PRIMARY KEY,
  -- e.g. example.com (lowercase) / 如 example.com(小写)
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE domain_admins (
  user_id   TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  PRIMARY KEY (user_id, domain_id)
);

CREATE TABLE mailboxes (
  id           TEXT PRIMARY KEY,
  domain_id    TEXT NOT NULL,
  -- The part before @ (lowercase) / @ 前部分(小写)
  local_part   TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  UNIQUE(domain_id, local_part)
);

CREATE TABLE grants (
  user_id    TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',   -- owner | member | readonly
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mailbox_id)
);
CREATE INDEX idx_grants_mailbox ON grants(mailbox_id);

CREATE TABLE invites (
  id              TEXT PRIMARY KEY,
  -- sha256 of the token embedded in the link / sha256(链接里的 token)
  token_hash      TEXT NOT NULL UNIQUE,
  -- Optional: restrict which email may register / 可选:限定注册邮箱
  email           TEXT,
  grants_json     TEXT NOT NULL,               -- [{mailbox_id, role}]
  -- Domain the invite belongs to; the link is hosted on that domain's entry host
  -- 邀请归属的域名(邀请链接挂在该域名的入口地址上)
  domain_id       TEXT,
  -- Optional: also grant domain-admin rights / 可选:同时授予某域名的域管理员
  domain_admin_of TEXT,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked         INTEGER NOT NULL DEFAULT 0,
  used_by         TEXT,
  used_at         INTEGER
);

-- IMAP-ready: every mailbox gets the same six system folders
-- IMAP-ready:每个邮箱固定六个系统文件夹
CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,                   -- inbox|sent|drafts|spam|trash|archive
  uidvalidity INTEGER NOT NULL,
  uidnext     INTEGER NOT NULL DEFAULT 1,
  UNIQUE(mailbox_id, role)
);

CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  mailbox_id     TEXT NOT NULL,
  folder_id      TEXT NOT NULL,
  -- Monotonic within the folder (IMAP-ready) / 文件夹内单调递增(IMAP-ready)
  uid            INTEGER NOT NULL,
  thread_id      TEXT NOT NULL,
  message_id     TEXT,                         -- RFC Message-ID
  in_reply_to    TEXT,
  subject        TEXT NOT NULL DEFAULT '',
  from_addr      TEXT NOT NULL DEFAULT '',
  from_name      TEXT NOT NULL DEFAULT '',
  to_json        TEXT NOT NULL DEFAULT '[]',
  cc_json        TEXT NOT NULL DEFAULT '[]',
  bcc_json       TEXT NOT NULL DEFAULT '[]',
  reply_to       TEXT,
  snippet        TEXT NOT NULL DEFAULT '',
  -- Date header in ms; falls back to receive time when absent
  -- Date 头(ms),缺失时用接收时间
  date           INTEGER NOT NULL,
  -- When it entered the system, in ms / 进入系统的时间(ms)
  internal_date  INTEGER NOT NULL,
  size           INTEGER NOT NULL DEFAULT 0,
  r2_key         TEXT NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  direction      TEXT NOT NULL DEFAULT 'in',   -- in | out
  -- Links to the send task when direction=out / direction=out 时关联发送任务
  outbox_id      TEXT,
  flag_seen      INTEGER NOT NULL DEFAULT 0,   -- IMAP \Seen
  flag_flagged   INTEGER NOT NULL DEFAULT 0,   -- IMAP \Flagged (starred) / 星标
  flag_answered  INTEGER NOT NULL DEFAULT 0,   -- IMAP \Answered
  flag_draft     INTEGER NOT NULL DEFAULT 0,   -- IMAP \Draft
  -- IMAP \Deleted, reserved for two-phase delete / 两段式删除预留
  flag_deleted   INTEGER NOT NULL DEFAULT 0,
  parse_status   TEXT NOT NULL DEFAULT 'ok',   -- ok | failed
  parse_attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(folder_id, uid)
);
CREATE INDEX idx_msg_list   ON messages(mailbox_id, folder_id, date DESC);
CREATE INDEX idx_msg_thread ON messages(mailbox_id, thread_id, date);
CREATE INDEX idx_msg_msgid  ON messages(mailbox_id, message_id);
CREATE INDEX idx_msg_parse  ON messages(parse_status);

CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  -- Index within the parse result; the bytes are pulled from the MIME on demand
  -- 在解析结果中的序号,下载时按需从 MIME 提取
  part_index INTEGER NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  content_id TEXT
);
CREATE INDEX idx_att_msg ON attachments(message_id);

-- Searchable text (external-content table) + FTS5. The FTS index is kept in sync
-- by application code, deliberately not by triggers.
-- 搜索文本(外部内容表) + FTS5;FTS 同步由应用代码维护,不用触发器
CREATE TABLE message_texts (
  mrow       INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  addrs      TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, body, addrs,
  content='message_texts', content_rowid='mrow'
);

CREATE TABLE outbox (
  id           TEXT PRIMARY KEY,
  mailbox_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  -- The fully built MIME message / 构建好的完整 MIME
  r2_key       TEXT NOT NULL,
  -- External recipients (the envelope) / 外部收件人(信封)
  rcpts_json   TEXT NOT NULL,
  -- Structured content, for field-based channels such as Resend
  -- 结构化内容(Resend 等按字段的通道用)
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued|sending|sent|failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  next_attempt INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_outbox_due ON outbox(status, next_attempt);

CREATE TABLE drafts (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  -- {to,cc,bcc,subject,text,attachment_ids,reply_to_message_id}
  payload    TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_drafts_mb ON drafts(mailbox_id, user_id);

CREATE TABLE uploads (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Bounce/complaint suppression list (used once an SES webhook is wired up)
-- 退信/投诉黑名单(接入 SES webhook 后使用)
CREATE TABLE suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
