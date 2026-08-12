-- Font settings: brand font per domain, interface and body fonts per user
-- 字体设置:品牌文字字体(按域名)、界面字体与正文字体(按用户)
ALTER TABLE domains ADD COLUMN brand_font TEXT;
ALTER TABLE users ADD COLUMN ui_font TEXT;
ALTER TABLE users ADD COLUMN body_font TEXT;
