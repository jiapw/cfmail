-- Sharing, generalised. Three things change at once, and they are entangled enough that
-- splitting them would leave the table in a state no code path could serve:
--
--   1. A share carries a SET of nodes instead of exactly one. The old `node_id UNIQUE` made
--      "one link per folder" a schema-level law; recipients now land on a virtual root that
--      lists whatever was selected -- files and folders mixed.
--   2. A share names its AUDIENCE. `internal` requires a signed-in account on this instance
--      holding a mailbox under `domain_id` (the domain is how a department is expressed here);
--      `public` is the bare link, no account, and is pinned to read-only in both the API and
--      the UI -- an unauthenticated editor would be an open write endpoint.
--   3. A share can EXPIRE or be REVOKED. Both are checked on every access rather than swept by
--      cron, so a link stops working the moment it should, not at the next tick.
--
-- 共享的通用化。三件事必须一起改,它们互相咬合,拆开会让表停在没有任何代码路径能服务的状态:
--
--   1. 一条共享携带一"组"节点,而不是恰好一个。旧的 node_id UNIQUE 把"每个文件夹一条链接"
--      写成了库级铁律;接收方现在落在一个虚拟根上,里面平铺所选内容 —— 文件与目录混装。
--   2. 一条共享要指明"受众"。internal 要求本实例的登录账号,且在 domain_id 下持有信箱
--      (域名就是此处表达部门的方式);public 是裸链接,无需账号,并在 API 与界面两侧都钉死为
--      只读 —— 未经认证的可编辑等于开放写入端点。
--   3. 一条共享可以"过期"或"撤销"。两者在每次访问时判定,而不是靠 cron 清扫,
--      于是链接在该失效的那一刻就失效,而不是等到下一次扫描。

-- SQLite cannot drop the old UNIQUE(node_id) in place, so the table is rebuilt and the
-- existing rows are carried over: every old share becomes a one-item internal share, which is
-- exactly what it already was.
-- SQLite 无法就地删掉旧的 UNIQUE(node_id),因此重建表并搬运存量:每条旧共享变成"只含一项的
-- 内部共享",这本来就是它的语义。
ALTER TABLE drive_shares RENAME TO drive_shares_old;

CREATE TABLE drive_shares (
  id         TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  owner_id   TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer',    -- viewer | editor
  -- internal: signed-in on this instance, mailbox under domain_id (NULL = any domain)
  -- public:   link only, no account, always viewer
  -- internal:本实例登录账号,且持有 domain_id 下的信箱(NULL = 不限域)
  -- public:  仅凭链接,无账号,恒为 viewer
  audience   TEXT NOT NULL DEFAULT 'internal',
  domain_id  TEXT,
  expires_at INTEGER,                           -- NULL = never / NULL 表示永不过期
  revoked_at INTEGER,                           -- non-NULL = dead / 非空即已撤销
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- What a share contains. A node may appear in several shares; a share may hold many nodes.
-- 共享包含什么。一个节点可出现在多条共享里,一条共享也可含多个节点。
CREATE TABLE drive_share_items (
  share_id TEXT NOT NULL,
  node_id  TEXT NOT NULL,
  PRIMARY KEY (share_id, node_id)
);
CREATE INDEX idx_drive_share_items_node ON drive_share_items(node_id);

INSERT INTO drive_shares (id, token, owner_id, role, audience, domain_id, expires_at, revoked_at, note, created_at)
  SELECT id, token, owner_id, role, 'internal', NULL, NULL, NULL, '', created_at FROM drive_shares_old;
INSERT INTO drive_share_items (share_id, node_id)
  SELECT id, node_id FROM drive_shares_old;

DROP TABLE drive_shares_old;

CREATE INDEX idx_drive_shares_owner ON drive_shares(owner_id);
