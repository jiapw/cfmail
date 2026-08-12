-- Normalised subject for conversation clustering: the subject with short prefixes
-- such as Re:/Fwd: stripped.
-- 会话聚类的主题归一化:去掉 Re:/回复:/转发: 等短前缀后的主题
-- When References does not match, messages sharing a subject_norm within 90 days
-- are merged into one conversation.
-- References 匹配不到时,凭 subject_norm 相同(90 天内)归并会话
ALTER TABLE messages ADD COLUMN subject_norm TEXT;
CREATE INDEX idx_msg_subjnorm ON messages(mailbox_id, subject_norm, date);
-- Partial index, so the backfill scan costs nothing once backfilling is done
-- 部分索引:让"待回填"扫描在回填完成后代价为零
CREATE INDEX idx_msg_subjnorm_null ON messages(id) WHERE subject_norm IS NULL;
