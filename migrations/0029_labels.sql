-- Stars become labels: named, coloured, and several to a message. They are not folders --
-- a labelled message stays wherever it lives, which is what makes them able to carry the
-- categories a Gmail export brings with it (Category *, Important, custom labels) without
-- shuffling mail between inbox and archive.
--
-- 星标变成标签:有名字、有颜色,一封信可以有多个。它们不是文件夹 ——
-- 打了标签的邮件还待在原处,正因如此才装得下 Gmail 导出里带来的那些分类
-- (Category *、Important、自定义标签),而不必把邮件在收件箱和归档之间搬来搬去。
--
-- The built-in "Important" is deliberately NOT a row here. It is the existing flag_flagged
-- bit -- IMAP's \Flagged -- surfaced through the same interface. Storing it twice would mean
-- keeping two truths in step, and would demand a backfill for every message ever starred.
-- 内置的「重要」故意不在这张表里。它就是现有的 flag_flagged(IMAP 的 \Flagged),
-- 只是用同一套界面呈现。存两份就意味着要让两个真相保持一致,还得把历史上每封加过星的信回填一遍。
CREATE TABLE labels (
  id         TEXT PRIMARY KEY,
  -- Labels belong to the mailbox, like folders and contacts: the members of a shared mailbox
  -- share one taxonomy, because three private taxonomies in one mailbox classify nothing.
  -- 标签属于邮箱,和文件夹、联系人一致:共享邮箱的成员共用一套分类 ——
  -- 一个邮箱里三套私人分类,等于没有分类。
  mailbox_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL,               -- key into the label icon set / 标签图标集里的键名
  color      TEXT NOT NULL,               -- key into the fixed palette / 固定调色板里的键名
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(mailbox_id, name)
);

CREATE TABLE message_labels (
  message_id TEXT NOT NULL,
  label_id   TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id)
);

-- Reading a label's mail walks it from the label end, so that direction needs the index;
-- the primary key already covers the other one.
-- 按标签查邮件是从标签这头走的,所以这个方向要索引;另一个方向主键已经覆盖了。
CREATE INDEX idx_message_labels_label ON message_labels(label_id);
