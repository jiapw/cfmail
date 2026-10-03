-- An email at the door of a public link.
--
-- A public share is a bare link: whoever holds it is in, and nobody knows who that was. This
-- adds an optional door to it. Before the listing is shown, the visitor names an email address
-- and proves it by typing back a code that was sent there. What they get for it is a signed
-- proof -- their address and an expiry under the server's own key -- which their browser keeps
-- and presents on every request after. The server holds no session for them: the proof is the
-- whole of what it knows, and a forged one fails the signature.
--
-- It is a door, not a lock on the file. The share stays read-only, stays revocable, and stays
-- public in the sense that no account is needed; what changes is that opening it costs a
-- verified address. Whether anything is recorded about who came through is a separate decision
-- and is not made here.
--
-- 公开链接门口的一道邮箱验证。
--
-- 公开分享是一条裸链接:谁拿着谁就能进,而没人知道进来的是谁。这里给它加一道可选的门。
-- 在看到内容之前,访客先报一个邮箱地址,再把发到那个地址的验证码敲回来证明它是自己的。
-- 换来的是一份签名凭证 —— 用服务端自己的密钥签下的地址与过期时间 ——
-- 由浏览器保管,此后每次请求都出示。服务端不为访客保存任何会话:
-- 它知道的全部就是那份凭证,伪造的凭证过不了签名。
--
-- 这是一道门,不是文件上的锁。分享仍然只读、仍然可撤销、仍然是"无需账号"意义上的公开;
-- 变化的只是打开它要付出一个验证过的地址。至于要不要记下谁进来过,是另一个决定,不在这里做。
ALTER TABLE drive_shares ADD COLUMN email_gate INTEGER NOT NULL DEFAULT 0;

-- A code waiting to be typed back: one live row per (share, address), the code kept as a hash,
-- a counted number of wrong guesses, and a short life.
-- 一个等着被敲回来的验证码:每个 (分享, 地址) 只留一行,码只存哈希,数着猜错的次数,活不长。
CREATE TABLE drive_share_codes (
  id         TEXT PRIMARY KEY,
  share_id   TEXT NOT NULL,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_drive_share_codes_share_email ON drive_share_codes(share_id, email);

-- Rolling windows for the doors outside the sign-in, keyed by a hash so that no address -- IP or
-- email -- is ever written down.
-- 登录之外那几扇门的滚动窗口限速;键是哈希,于是任何地址 —— IP 或邮箱 —— 都不会被写下来。
CREATE TABLE drive_throttle (
  key       TEXT PRIMARY KEY,
  window_at INTEGER NOT NULL,
  n         INTEGER NOT NULL
);
