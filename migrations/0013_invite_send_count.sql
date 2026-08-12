-- Counts verification codes sent through an invite. An invite is single-use, so there
-- is no legitimate reason to send codes to many different addresses; the cap stops
-- someone using one open invite to blast codes at arbitrary mailboxes.
-- 邀请驱动的验证码发送次数计数。邀请本就单次使用,没有理由给很多不同邮箱发码;
-- 封顶用来拦住"拿到一个开放邀请链接就向任意邮箱刷验证码轰炸"的滥用。
ALTER TABLE invites ADD COLUMN send_count INTEGER NOT NULL DEFAULT 0;
