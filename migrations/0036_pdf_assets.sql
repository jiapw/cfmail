-- Stamps and signatures for the PDF editor: small transparent pictures a person places again and
-- again, so they belong to the account rather than to any one document. The bytes live in R2
-- under pdfassets/<user>/<id>.png; this table is the shelf they are found on.
-- PDF 编辑器的图章与签名:一些会被反复盖下去的小透明图,所以它们属于账号,
-- 而不属于任何一份文档。字节存在 R2 的 pdfassets/<user>/<id>.png 下;这张表是找到它们的那层架子。
CREATE TABLE pdf_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stamp', 'signature')),
  name TEXT NOT NULL DEFAULT '',
  w INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_pdf_assets_user ON pdf_assets(user_id, kind, created_at DESC);
