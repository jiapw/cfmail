-- Records which light/dark mode the admin was in when the logo was uploaded. That
-- mode is treated as the logo's native one and is never inverted; only the other
-- mode gets a lightness flip. Empty (historical logos) is treated as light, which
-- matches the previous behaviour.
-- 记录 logo 上传时管理员所处的明暗模式:该模式视为 logo 的"原生"模式(不反色),
-- 另一模式下才做明度反转。留空(历史 logo)按 light 处理,行为与之前一致。
ALTER TABLE domains ADD COLUMN brand_logo_mode TEXT;
