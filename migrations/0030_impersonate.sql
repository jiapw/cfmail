-- A session that a global administrator opened as somebody else. The column holds the
-- administrator who opened it, and is NULL for every ordinary sign-in -- so "who is really at the
-- keyboard" is a property of the session itself, not something the front end is trusted to report.
--
-- 全局管理员以他人身份打开的会话。这一列记的是打开它的管理员,普通登录一律为 NULL ——
-- 于是"键盘后面真正坐着谁"是会话自身的属性,而不是靠前端自觉上报。
ALTER TABLE sessions ADD COLUMN impersonator_id TEXT;
