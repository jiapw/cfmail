-- The assistant's internet tools (web_search / open_url) become an explicit per-domain
-- switch, off by default.
-- AI 助手的联网能力(web_search / open_url)改成按域名显式开关,默认关闭。
-- They used to be mounted unconditionally: with no Brave key configured they scraped
-- html.duckduckgo.com, and the queries were written by the model from mail content --
-- so mail-derived data flowed to a third party by default.
-- 此前这两个工具是无条件挂载的:没配 Brave key 就去抓 html.duckduckgo.com,
-- 而查询词是模型从邮件内容里生成的 -- 等于邮件衍生数据默认流向第三方。
ALTER TABLE domains ADD COLUMN chat_web_search INTEGER NOT NULL DEFAULT 0;
