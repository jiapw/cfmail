-- Theme (chosen per domain by its admins) and appearance (light/dark/auto, per user)
-- 主题(域管理员按域名选)与外观(用户选 light/dark/auto)
ALTER TABLE domains ADD COLUMN brand_theme TEXT;
ALTER TABLE users ADD COLUMN appearance TEXT;
