-- Mail for unmatched recipients: when the address belongs to no mailbox or alias in
-- the domain, it is still refused with 550 (so the sender gets a bounce), but a copy
-- is filed here for administrators to inspect.
-- 未匹配收件人的来信:收件地址不属于本域下任何邮箱或别名时,
-- 仍按 550 拒收(发件人能收到退信),但留档供管理员查看
CREATE TABLE unrouted (
  id         TEXT PRIMARY KEY,
  -- Domain the recipient address belongs to, when it can be resolved
  -- 收件地址所属域名(能对上时)
  domain_id  TEXT,
  to_addr    TEXT NOT NULL,
  from_addr  TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',
  snippet    TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_unrouted_domain ON unrouted(domain_id, created_at);
