-- Invite model rework. On the mailbox side this moves from "grant an existing
-- mailbox" to "pin an address (creating it if needed) / leave it open (the invitee
-- picks their own name)".
-- 邀请模型改造:邮箱侧从"授权已存在的邮箱"改成"限定地址(可新建)/ 不限定(注册者自己取名)"
-- fixed  = pinned: local_part + domain_id. If the mailbox does not exist it is
--          created at registration, with the role taken from `role`.
--          限定:local_part + domain_id,注册时若邮箱不存在就新建,角色取 role
-- choose = open: only domain_id is pinned. The invitee picks an unused local_part
--          under that domain and always becomes owner.
--          不限定:只定 domain_id,注册者在该域名下自取不重名的 local_part,角色固定 owner
ALTER TABLE invites ADD COLUMN mailbox_mode TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE invites ADD COLUMN local_part TEXT;
ALTER TABLE invites ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';
-- domain_admin_of is kept as a column but no longer written, so old rows stay
-- readable without reshaping the table.
-- domain_admin_of 保留列但不再写入(旧数据仍可读),避免动老表结构

-- When the mailbox name is not pinned, the name the invitee picked rides along with
-- the pending registration; the mailbox is only created once verification passes.
-- 不限定邮箱名时,注册者自取的名字要跟着待验证记录一起存,验证通过才真正建邮箱
ALTER TABLE pending_regs ADD COLUMN mailbox_name TEXT;

-- Password reset: a single-use token mailed to the user's signup address
-- 密码重置:一次性 token,发到用户的注册邮箱
CREATE TABLE password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  -- sha256 of the token embedded in the link / sha256(链接里的 token)
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX idx_pwreset_user ON password_resets(user_id);
