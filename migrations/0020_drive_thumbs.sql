-- Per-file thumbnails, generated client-side at upload time and stored as WebP next to the
-- original (R2 key = <r2_key>.t). The flag lets listings render <img> only where one exists,
-- instead of probing with 404s.
-- 每文件缩略图。上传时由客户端生成,WebP 存在原文件旁(R2 键 = <r2_key>.t)。
-- 有这个标记,列表就只在确有缩略图时渲染 <img>,不用靠 404 试探。
ALTER TABLE drive_nodes ADD COLUMN has_thumb INTEGER NOT NULL DEFAULT 0;
