-- The public share page is seen by people with no account here, so it cannot read any of the
-- viewer-side preferences the signed-in app relies on. Two things have to travel with the link
-- instead of being looked up at view time:
--
--   1. How it should look. Palette is a company-level setting and can be read from the domain,
--      but light/dark is a per-user choice, so the sharer's resolved mode is recorded on the
--      share. Otherwise a link made by someone working in dark mode opens blindingly light.
--   2. Whether the sharer's address may be shown. That is a disclosure decision, so it belongs
--      to the administrator rather than to whoever creates the link -- one company may consider
--      the address harmless internal metadata, another may consider it a leak to the outside.
--
-- 公开分享页面向本处没有账号的人,因此读不到登录态应用所依赖的任何浏览者偏好。
-- 有两样东西必须随链接一起走,而不能在浏览时现查:
--
--   1. 它该长什么样。配色是企业级设置,可从域名读到;但明暗是每个用户自己的选择,
--      所以把分享者当时解析出的模式记在这条分享上。否则在暗色模式下做的链接,
--      打开时会白得刺眼。
--   2. 分享者的地址是否可以显示。这是一个"披露"决定,归管理员而不归创建链接的人 ——
--      有的企业认为地址只是无害的内部元数据,有的则视之为对外泄露。

ALTER TABLE drive_shares ADD COLUMN theme TEXT;   -- palette name at creation / 创建时的配色名
ALTER TABLE drive_shares ADD COLUMN mode TEXT;    -- 'dark' | 'light' / 明暗

-- Off by default: showing an address to anyone holding a link is the more revealing choice, so
-- it should be something an administrator turns on deliberately, never a silent default.
-- 默认关闭:把地址显示给任何拿到链接的人是更外露的选择,应当由管理员有意开启,
-- 绝不能是一个无声的默认值。
ALTER TABLE domains ADD COLUMN drive_share_show_owner INTEGER NOT NULL DEFAULT 0;
