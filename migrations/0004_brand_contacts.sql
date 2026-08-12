-- Per-domain branding (name + logo in R2), language preference, contacts,
-- and a generic key/value meta table.
-- 品牌(按域名):名称 + logo(R2);语言偏好;通讯录;通用 meta 表
ALTER TABLE domains ADD COLUMN brand_name TEXT;
ALTER TABLE domains ADD COLUMN brand_logo_key TEXT;
ALTER TABLE domains ADD COLUMN brand_logo_mime TEXT;

ALTER TABLE users ADD COLUMN lang TEXT;

CREATE TABLE contacts (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  addr       TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  -- Local to this deployment, i.e. reachable as a mailbox or alias
  -- 是否站内(邮箱/别名可达)
  internal   INTEGER NOT NULL DEFAULT 0,
  -- Number of exchanges / 往来次数
  times      INTEGER NOT NULL DEFAULT 1,
  last_seen  INTEGER NOT NULL,
  UNIQUE(mailbox_id, addr)
);
CREATE INDEX idx_contacts_mb ON contacts(mailbox_id, times);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
