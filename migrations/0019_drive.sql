-- Drive (per-user cloud storage, Google-Drive-like). Content bytes live in R2 under
-- drive/<user_id>/<file_id>; the folder tree is metadata here, so rename/move never
-- touches R2 (R2 has no rename). The feature is switched per domain; a user gets Drive
-- when any of their domains enables it, and their files are one pool across domains.
-- 网盘(每用户一份,Google Drive 风格)。文件字节存 R2 的 drive/<user_id>/<file_id>;
-- 目录树是 D1 里的元数据,改名/移动不动 R2(R2 没有重命名)。开关按域名;
-- 用户所属任一域名开启即可用,存储跨域名同一份。

-- Per-domain switch (default off) and default per-user quota in MB
-- 按域名开关(默认关)与默认每用户配额(MB)
ALTER TABLE domains ADD COLUMN drive_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domains ADD COLUMN drive_quota_mb INTEGER NOT NULL DEFAULT 1024;

-- Per-user quota override (NULL = domain default; effective = min(value, 10240)) and a
-- denormalised usage counter maintained on upload/permanent-delete
-- 每用户配额覆盖(NULL=用域名默认;生效值封顶 10240)与冗余用量计数器(上传/彻底删除时维护)
ALTER TABLE users ADD COLUMN drive_quota_mb INTEGER;
ALTER TABLE users ADD COLUMN drive_bytes INTEGER NOT NULL DEFAULT 0;

-- One row per file or folder. Trash is a flag on the explicitly trashed node only;
-- descendants are implicitly trashed through their ancestor (Google semantics).
-- 每个文件/文件夹一行。回收站只在被删除的那个节点上打标;子孙经由祖先隐式进回收站(Google 语义)。
CREATE TABLE drive_nodes (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,                    -- users.id; quota is charged to the owner / 配额记在所有者头上
  parent_id  TEXT,                             -- NULL = root of the owner's drive / NULL=根目录
  kind       TEXT NOT NULL,                    -- folder | file
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,       -- files only / 仅文件
  r2_key     TEXT,                             -- files only: drive/<owner_id>/<id>
  starred    INTEGER NOT NULL DEFAULT 0,
  trashed    INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_drive_children ON drive_nodes(owner_id, parent_id);
CREATE INDEX idx_drive_trashed  ON drive_nodes(trashed, trashed_at);

-- Folder share links. One active link per folder; the token is stored in clear so the owner
-- can copy the link again later -- it is worthless without a signed-in account sharing a
-- domain with the owner, unlike invite tokens (which are hashed because they mint accounts).
-- 文件夹共享链接,每个文件夹一条。token 明文存储,方便所有者随时再复制 ——
-- 没有与所有者同域的登录账号,链接本身毫无用处(邀请 token 能开账号,所以才哈希)。
CREATE TABLE drive_shares (
  id         TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  node_id    TEXT NOT NULL UNIQUE,             -- the shared folder / 被共享的文件夹
  owner_id   TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer',   -- viewer | editor
  created_at INTEGER NOT NULL
);

-- Who opened the link (and therefore sees it under "Shared with me"). The owner can remove members.
-- 打开过链接的人(从而出现在其「共享给我」列表)。所有者可移除成员。
CREATE TABLE drive_share_members (
  share_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, user_id)
);
CREATE INDEX idx_drive_share_user ON drive_share_members(user_id);

-- In-flight multipart uploads: the server must know the declared size and target on its own
-- authority (never trusting the complete-call), and the hourly cron aborts stale ones.
-- 进行中的分片上传:声明的大小与落点必须由服务端自己记住(不信 complete 请求带来的),
-- 小时级 cron 负责中止过期未完成的。
CREATE TABLE drive_uploads (
  id         TEXT PRIMARY KEY,                 -- becomes the file node id on completion / 完成后即文件节点 id
  user_id    TEXT NOT NULL,                    -- uploader / 操作者
  owner_id   TEXT NOT NULL,                    -- whose drive and quota it lands in / 落入谁的网盘与配额
  parent_id  TEXT,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL,
  r2_key     TEXT NOT NULL,
  upload_id  TEXT NOT NULL,                    -- R2 multipart upload id
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_drive_uploads_age ON drive_uploads(created_at);
