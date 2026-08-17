-- WebDAV write locks, for the agent access links that a person has mounted as a drive.
--
-- Finder and Windows Explorer will not write to a share that cannot lock, so the lock had to
-- become real rather than a token handed back and forgotten. Real means two things: it is
-- stored, so a second writer can be told the file is busy; and it EXPIRES, so a client that
-- crashed, slept, or lost its network does not leave a file locked forever with nobody left to
-- unlock it. There is no session to hang the lock on -- every request stands alone -- so the
-- only thing that can end a lock when the holder vanishes is a clock.
--
-- Refreshing is what proves the holder is still there: a mounted volume re-issues LOCK long
-- before the timeout, and a dead one stops. The ceiling on the timeout is therefore the real
-- promise -- at most that long after a client disappears, its locks are gone.
--
-- WebDAV 写锁 —— 给那些被人挂载成网盘的 AI 访问链接用。
--
-- Finder 与 Windows 资源管理器不肯往一个不能加锁的共享里写,所以锁必须是真的,
-- 而不是发一个 token 出去就忘。"真"意味着两件事:它被存下来,于是第二个写者能被告知文件正忙;
-- 以及它会过期 —— 客户端崩了、睡了、断网了,不会留下一个永远锁着、再没人来解的文件。
-- 这里没有会话可以挂靠(每个请求都是独立的),因此持有者消失时,唯一能终结一把锁的东西是时钟。
--
-- "续租"就是持有者仍然在场的证明:挂载着的卷会远早于超时重新发 LOCK,而死掉的那个不会。
-- 于是超时的上限才是真正的承诺 —— 客户端消失之后,最多那么久,它的锁就没了。

CREATE TABLE drive_dav_locks (
  token      TEXT PRIMARY KEY,        -- opaquelocktoken:<uuid> / 不透明锁令牌
  share_id   TEXT NOT NULL,
  -- The path inside the link, decoded names joined by '/'. Empty string is the link's root.
  -- Locks live on paths rather than node ids because a client may lock a name that does not
  -- exist yet -- that is how both Finder and Explorer create a file.
  -- 链接内的路径,解码后的名字用 '/' 连接。空串是链接的根。
  -- 锁挂在路径上而不是节点 id 上,因为客户端可能锁一个尚不存在的名字 ——
  -- Finder 和资源管理器创建文件走的正是这条路。
  path       TEXT NOT NULL,
  depth      INTEGER NOT NULL DEFAULT 0,  -- 0 = this path only, 1 = it and everything under it
  owner      TEXT NOT NULL DEFAULT '',    -- the <owner> the client sent, echoed back / 客户端给的 owner,原样回显
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_drive_dav_locks_share ON drive_dav_locks(share_id, path);
CREATE INDEX idx_drive_dav_locks_exp ON drive_dav_locks(expires_at);
