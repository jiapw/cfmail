-- The recipient of a public link has no account here, so the page falls back to whatever their
-- browser asks for -- which can leave a document shared by a Chinese team reading in German
-- because the visitor happens to be travelling. The sharer knows the audience; the browser does
-- not. Record the language the link was made in and open it that way.
-- 公开链接的接收方在本处没有账号,页面于是退回浏览器要求的语言 —— 一份中文团队分享的文档
-- 可能因为访问者正在出差而以德语打开。分享者了解受众,浏览器不了解。
-- 记下链接创建时所用的语言,并以该语言打开它。

ALTER TABLE drive_shares ADD COLUMN lang TEXT;   -- interface language at creation / 创建时的界面语言
