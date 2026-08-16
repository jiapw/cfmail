-- A shared invite link: one URL an administrator can hand to a whole team, good for any
-- number of registrations until it expires. The single-use claim (invites.used_by) cannot
-- express that, so multi-use links are never claimed -- each redemption is recorded in
-- invite_uses instead, which both counts them and stops one person taking several mailboxes.
-- 共享邀请链接:管理员发一条给一整队人用,在过期之前不限注册人数。
-- 单次认领(invites.used_by)表达不了这个,所以多人链接从不被认领 ——
-- 每次兑换改记在 invite_uses 里,既能计数,也拦住同一个人反复领邮箱。
ALTER TABLE invites ADD COLUMN multi_use INTEGER NOT NULL DEFAULT 0;

-- Rolling window behind the code-sending limit. A single-use link is capped by its lifetime
-- total (send_count); a shared one has no total to cap, so it is capped by rate instead --
-- otherwise an open link would be a free relay for mailing codes at arbitrary addresses.
-- 发码限流用的滚动窗口。单人链接靠总量封顶(send_count);共享链接没有总量可封,
-- 就改成限速 —— 否则一条开放链接等于一个免费的验证码群发中继。
ALTER TABLE invites ADD COLUMN send_window_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN send_window_n INTEGER NOT NULL DEFAULT 0;

-- One row per account opened through a shared link. The primary key is what makes a
-- redemption idempotent per user, and the row is what the administrator sees as "N joined".
-- 共享链接每开出一个账号记一行。主键让同一用户的兑换幂等,
-- 管理员看到的"已加入 N 人"也来自这里。
CREATE TABLE invite_uses (
  invite_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (invite_id, user_id)
);
CREATE INDEX idx_invite_uses_at ON invite_uses(invite_id, created_at DESC);
