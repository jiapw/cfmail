-- Audit trail for sensitive administrator actions. actor_email is stored redundantly
-- so the actor is still identifiable after the user account is deleted.
-- 管理员敏感操作审计。actor_email 冗余存一份:用户被删之后仍然追得到是谁做的。
-- IP addresses are deliberately not recorded -- nothing else in the application layer
-- logs an IP either, and this stays consistent with that. (Platform logs are separate.)
-- 有意不记录 IP -- 应用层其余地方也不落 IP,保持一致(平台层日志另算)。
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  actor_id    TEXT,
  actor_email TEXT,
  -- Lets domain admins see only their own domain's records / 便于域管理员只看自己域的记录
  domain_id   TEXT,
  -- Shaped like mailbox.purge / user.delete / 形如 mailbox.purge / user.delete
  action      TEXT NOT NULL,
  -- Human-readable subject, e.g. someone@example.com / 人类可读的对象
  target      TEXT,
  -- JSON, extra fields / JSON,补充字段
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_domain ON audit_log(domain_id, at DESC);
