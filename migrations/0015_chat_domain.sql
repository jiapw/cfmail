-- The AI assistant becomes a per-domain switch and configuration, following whichever
-- entry host the user visited. Each domain is independent.
-- AI 助手改为按域名开关与配置:跟随用户访问的入口域名,每个域名独立
-- (The global app_settings approach from 0014 is abandoned; the table is dropped.)
-- (原 0014 的全局 app_settings 方案弃用,表一并删除)
ALTER TABLE domains ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domains ADD COLUMN chat_default_model TEXT;
ALTER TABLE domains ADD COLUMN chat_search_key TEXT;
DROP TABLE app_settings;
