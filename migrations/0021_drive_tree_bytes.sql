-- Folder subtree sizes, materialised. tree_bytes on a folder = total bytes of every
-- non-trashed file reachable beneath it without crossing a trashed node. Kept current by
-- O(depth) ancestor-chain increments on every mutation; this backfill computes the standing
-- data once.
-- 文件夹子树大小,物化列。文件夹的 tree_bytes = 其下所有"不经过回收站边界可达"的未回收
-- 文件字节总和。此后每次变动沿祖先链做 O(深度) 增量维护;本回填一次性算清存量。
ALTER TABLE drive_nodes ADD COLUMN tree_bytes INTEGER NOT NULL DEFAULT 0;

WITH RECURSIVE reach(root, id, kind, size, depth) AS (
  SELECT f.id, c.id, c.kind, c.size, 1 FROM drive_nodes f
    JOIN drive_nodes c ON c.parent_id = f.id AND c.trashed = 0
  WHERE f.kind = 'folder'
  UNION ALL
  SELECT r.root, c.id, c.kind, c.size, r.depth + 1 FROM reach r
    JOIN drive_nodes c ON c.parent_id = r.id AND c.trashed = 0
  WHERE r.kind = 'folder' AND r.depth < 64
)
UPDATE drive_nodes SET tree_bytes = COALESCE(
  (SELECT SUM(size) FROM reach WHERE reach.root = drive_nodes.id AND reach.kind = 'file'), 0)
WHERE kind = 'folder';
