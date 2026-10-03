-- Who came through a share, and what they did there.
--
-- A share that has a door -- an internal one, or a public one asking for an email -- knows who
-- is on the other side. This lets the sharer ask to be told: each entry becomes a visit, and
-- what the visitor does inside it becomes a line of events under that visit. Opening a file,
-- how long it stayed open, which pages of a document were read and for how long, how much of a
-- film or a song was played and whether to the end, what was downloaded, where they were when
-- they left; and about the visitor, what the request itself says -- system, device, browser,
-- address, and the city Cloudflare resolves it to.
--
-- Two tables rather than one wide row, because a visit is one thing and what happens in it is
-- many. The sharer's list reads visits; opening one reads its events. Nothing is summarised at
-- write time: with a visitor a minute, every question can be asked of the rows as they are.
--
-- 谁经过了一条分享,在里面做了什么。
--
-- 带门的分享 —— 内部分享,或者要邮箱的公开分享 —— 知道门那边站的是谁。这让分享者可以要求
-- 被告知:每一次进入成为一次到访,访客在里面做的事成为这次到访之下的一行行事件。
-- 打开了哪个文件、开了多久,一份文档读到了哪几页、每页多久,一部片子或一首歌放了多少、
-- 有没有放完,下载了什么,离开时停在哪里;还有关于访客本身、请求自己说出来的那些 ——
-- 系统、设备、浏览器、地址,以及 Cloudflare 把它解析到的那座城市。
--
-- 两张表而不是一行宽表,因为一次到访是一件事,而其中发生的事是许多件。
-- 分享者的列表读到访;点开一次到访读它的事件。写入时不做任何汇总:
-- 一分钟一个访客的量级,任何问题都可以直接问这些行。
ALTER TABLE drive_shares ADD COLUMN track INTEGER NOT NULL DEFAULT 0;

CREATE TABLE drive_share_visits (
  id          TEXT PRIMARY KEY,
  share_id    TEXT NOT NULL,
  viewer_kind TEXT NOT NULL,                 -- 'email' (public, verified) | 'user' (internal, signed in)
  viewer      TEXT NOT NULL,                 -- the address, or the user id / 地址,或用户 id
  viewer_name TEXT NOT NULL DEFAULT '',
  started_at  INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,              -- the last sign of life / 最后一次活着的迹象
  ended_at    INTEGER,                       -- when the page said goodbye, if it did / 页面道别的时刻,如果它道了别
  ua          TEXT NOT NULL DEFAULT '',
  os          TEXT NOT NULL DEFAULT '',
  device      TEXT NOT NULL DEFAULT '',
  browser     TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  region      TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  tz          TEXT NOT NULL DEFAULT '',
  exit_where  TEXT NOT NULL DEFAULT ''       -- JSON: what was on screen when they left / 离开时屏幕上是什么
);
CREATE INDEX idx_drive_share_visits_share ON drive_share_visits(share_id, started_at);

CREATE TABLE drive_share_events (
  id       TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,                    -- enter | open | close | page | media | download | leave | resume
  node_id  TEXT NOT NULL DEFAULT '',
  name     TEXT NOT NULL DEFAULT '',         -- the node's name at the time / 当时的名字
  detail   TEXT NOT NULL DEFAULT ''          -- JSON, shaped by the kind / JSON,形状随 kind 而定
);
CREATE INDEX idx_drive_share_events_visit ON drive_share_events(visit_id, at);
