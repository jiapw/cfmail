-- Receiving aliases: alias address -> target mailbox. Affects inbound routing only;
-- outgoing mail still uses the primary address.
-- 收信别名:alias 地址 -> 目标邮箱(仅影响收信路由,发信仍用主地址)
-- An alias belongs to a domain (controlled by that domain's admins); the target
-- mailbox may live under any domain.
-- 别名属于某个域名(由该域名的域管理员控制),目标邮箱可以在任意域名下
CREATE TABLE aliases (
  id         TEXT PRIMARY KEY,
  -- Domain the alias lives under / 别名所在域名
  domain_id  TEXT NOT NULL,
  -- The part before @ (lowercase) / @ 前部分(小写)
  local_part TEXT NOT NULL,
  -- Delivery target / 投递目标邮箱
  mailbox_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(domain_id, local_part)
);
CREATE INDEX idx_aliases_mb ON aliases(mailbox_id);
