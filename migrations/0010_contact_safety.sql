-- Per-contact safety switch: whether their remote images load when reading mail.
-- 联系人安全开关:控制阅读邮件时是否加载其远程图片
-- NULL = follow the default (local senders safe, external unsafe); 1 = safe; 0 = unsafe.
-- NULL = 跟随默认(站内=安全,外部=不安全);1 = 安全;0 = 不安全
ALTER TABLE contacts ADD COLUMN safe INTEGER;
