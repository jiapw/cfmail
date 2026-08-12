-- Signup email verification: a submitted registration is parked here first, and the
-- account is only created once the code checks out.
-- 注册邮箱验证:提交注册后先存待验证记录,验证码通过后才真正建账号
CREATE TABLE pending_regs (
  id         TEXT PRIMARY KEY,
  invite_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  -- Already hashed; the plaintext is never stored / 已哈希,不存明文
  pw_hash    TEXT NOT NULL,
  -- sha256 of the verification code / sha256(验证码)
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_regs_invite ON pending_regs(invite_id, email);
