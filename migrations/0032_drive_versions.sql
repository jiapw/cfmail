-- File versioning, opt-in per file.
--
-- The one decision everything else follows from: a versioned file never overwrites its own bytes.
-- Each write lands on an R2 key of its own and the node's pointer moves to it, so every earlier
-- version stays exactly where it already was. Nothing is copied to keep history, and a file that
-- moves across the tree is still just a parent_id -- the keys never said where a file lived, only
-- whose it was.
--
-- This records what a file has been, in order. It is not a backup: there is no move here that puts
-- a file back, and nothing below stores what would be needed to offer one.
--
-- 文件版本,按文件开启。
--
-- 其余一切都由这一个决定推导而来:开了版本的文件永不覆盖自己的字节。每次写入落到它自己的 R2 键上,
-- 节点的指针再移过去,于是每个更早的版本仍原地待着。保留历史不拷贝;
-- 而跨目录移动的文件依旧只是改一个 parent_id —— 键从来没说过文件住在哪儿,只说过它属于谁。
--
-- 它记录一个文件曾经是什么、以什么顺序。它不是备份:这里没有哪个动作能把文件放回去,
-- 下面也没有存下任何足以支撑那种动作的东西。

-- Files: history is kept for this one. Folders: files created anywhere beneath this one are born
-- versioned. The policy is read off the ancestor chain at creation time and never again -- a file's
-- own flag is the truth from then on. That is what keeps moving a folder free: moving it changes
-- where future files are born, and changes nothing about the ones already inside.
-- 文件:为它保留历史。文件夹:在它之下任何位置新建的文件,一出生就是有版本的。
-- 该策略只在创建那一刻从祖先链上读一次,此后再不读 —— 文件自己的标记从此就是事实。
-- 正是这一点让移动目录不花钱:移动它改变的是"以后在哪儿出生",
-- 对已经在里面的东西一个字都不改。
ALTER TABLE drive_nodes ADD COLUMN versioned  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drive_nodes ADD COLUMN ver_policy INTEGER NOT NULL DEFAULT 0;

-- The version the node's bytes currently are. Also the file's ETag, which is how a conditional
-- write names the thing it believes it is writing on top of.
-- 节点当前那份字节是哪个版本。它同时就是该文件的 ETag ——
-- 条件写正是用它来指认"我自以为写在谁头上"。
ALTER TABLE drive_nodes ADD COLUMN ver_head   TEXT;

-- One row per version. `parent_id` is the lineage, and its absence is the whole point:
--
--   * seq = 1, parent NULL      -- the beginning, there was nothing to be based on
--   * seq > 1, parent set       -- the writer named its base, and the base was current
--   * seq > 1, parent NULL      -- the writer named no base: the chain is cut here
--
-- The third case is not an error and is not refused. It is what a mounted volume or a plain curl
-- does, and those have to keep working. But it is recorded as what it is, because "this version
-- was written by someone who never saw the one before it" is exactly the fact a person needs when
-- two devices disagree -- and it is a fact that cannot be recovered later from timestamps.
--
-- 每个版本一行。parent_id 是血缘,而它的缺席恰恰是重点:
--
--   * seq = 1、parent 为空   —— 开端,本来就无所依据
--   * seq > 1、parent 有值   —— 写者指认了它的基准,且该基准正是当时的最新
--   * seq > 1、parent 为空   —— 写者没有指认基准:演化链条在此被切断
--
-- 第三种不是错误,也不会被拒绝。挂载的卷、朴素的 curl 干的就是这个,它们必须继续能用。
-- 但它会被如实记下,因为"这一版出自一个从没见过上一版的人之手"正是两台设备打架时人所需要的那个事实 ——
-- 而这个事实事后从时间戳里再也捞不回来。
CREATE TABLE drive_versions (
  id         TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,                  -- 1-based, monotonic per node / 按节点单调递增,从 1 起
  parent_id  TEXT,                              -- the version this was written onto / 写在谁头上
  -- Every version owns its key outright: one row, one object, and no two rows ever name the same
  -- bytes. That is what makes removing a version a local act -- nothing has to be asked before
  -- the object goes.
  -- 每个版本独占自己的键:一行一个对象,绝无两行指向同一份字节。
  -- 正因如此,移除一个版本才是一件局部的事 —— 对象离场之前,不必先去问过谁。
  r2_key     TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  mime       TEXT NOT NULL DEFAULT '',
  origin     TEXT NOT NULL DEFAULT '',          -- init | web | link / 从哪扇门进来的
  author_id  TEXT,                              -- NULL for link writes: a token is not a person / 链接写入为空:令牌不是人
  created_at INTEGER NOT NULL
);

-- Two writers racing for the same seq is a lost update wearing a disguise; the index makes the
-- second one fail loudly instead of quietly landing beside the first.
-- 两个写者抢同一个 seq,是丢失更新换了身衣服;有这个索引,后到的那个会响亮地失败,
-- 而不是悄悄挨着前一个落地。
CREATE UNIQUE INDEX idx_drive_versions_seq ON drive_versions(node_id, seq);
CREATE INDEX idx_drive_versions_node ON drive_versions(node_id);
