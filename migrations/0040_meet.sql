-- Meetings.
--
-- What is stored is the part of a meeting that outlives the call: what was agreed when it was
-- created, who was asked, and where its recordings went. What happens DURING the call -- who is
-- in the room, who holds the large picture, who is waiting at the door -- lives in the room's
-- Durable Object and is gone when the last person leaves. None of it is the kind of thing anybody
-- looks up afterwards, and a table of it would be a table of who was where and when.
--
-- 会议。
--
-- 落库的是一场会议里"比通话活得久"的那部分:创建时约定了什么、请了谁、录制去了哪儿。
-- 通话**期间**发生的事 —— 谁在房间里、大画面在谁手上、谁等在门口 —— 住在房间的 Durable Object 里,
-- 最后一个人离开就没了。那些都不是事后有人会去查的东西,而把它们存成表,
-- 存下的就是一张"谁在何时何地"的表。

-- Per-domain switches and ceilings, the same way Drive and the assistant have theirs. Live
-- meetings get a switch of their own because they are the one part of this that costs money in
-- proportion to use (Stream minutes, container hours).
-- 按域名的开关与上限,写法同网盘与助手。直播会议单独一个开关,
-- 因为它是这里唯一按用量花钱的部分(Stream 的观看分钟、容器的运行小时)。
ALTER TABLE domains ADD COLUMN meet_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domains ADD COLUMN meet_live_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domains ADD COLUMN meet_max_group INTEGER NOT NULL DEFAULT 32;
ALTER TABLE domains ADD COLUMN meet_max_speakers INTEGER NOT NULL DEFAULT 8;
ALTER TABLE domains ADD COLUMN meet_max_resolution INTEGER NOT NULL DEFAULT 1080;

CREATE TABLE meetings (
  id            TEXT PRIMARY KEY,               -- uid(); the room is idFromName(id) / 房间 = idFromName(id)
  -- What the link carries. Anybody signed in who holds it may come in, so it is long enough not
  -- to be guessed and is never listed anywhere but to the people it was made for.
  -- 链接里带的那一段。持有它的已登录用户即可进入,所以它长到猜不出,也只对该看到的人列出。
  code          TEXT NOT NULL UNIQUE,
  owner_id      TEXT NOT NULL,
  -- The domain it was created under: branding, the switches above and the ceilings all come from
  -- it, and keep coming from it if the owner later gains a mailbox somewhere else.
  -- 创建时所在的域名:品牌、上面的开关与上限都取自它;创建者日后在别处又有了邮箱,也仍取自它。
  domain_id     TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'group',  -- 'group' | 'live'
  title         TEXT NOT NULL DEFAULT '',
  persistent    INTEGER NOT NULL DEFAULT 0,     -- a personal room that is never "over" / 个人常驻会议室,没有"结束"
  starts_at     INTEGER,                        -- scheduled start; NULL = right now / 预约时间;NULL = 即时
  duration_min  INTEGER,
  video         INTEGER NOT NULL DEFAULT 1,     -- 0 = an audio-only meeting: no video track is ever made / 纯音频会议:根本不建视频轨
  resolution    INTEGER NOT NULL DEFAULT 720,   -- 480 | 720 | 1080 -- of the ONE large picture / 唯一那路大画面的画幅
  stage_policy  TEXT NOT NULL DEFAULT 'free',   -- 'free' | 'approve' | 'host'
  max_people    INTEGER NOT NULL,               -- group: everybody; live: speakers / group:总人数;live:发言人数
  guest_mode    TEXT NOT NULL DEFAULT 'off',    -- 'off' | 'lobby' | 'open'
  -- Kept as written, the way a Drive share's token is: the host opens this meeting again tomorrow
  -- and needs the same guest link back, and a hash cannot give it to them.
  -- 照原样存,同网盘分享的 token 一样:主持人明天再打开这场会议,要拿回的是同一条访客链接,
  -- 而哈希还不出它来。
  guest_token   TEXT,
  e2ee          INTEGER NOT NULL DEFAULT 0,     -- group only / 仅 group
  record_mode   TEXT NOT NULL DEFAULT 'off',    -- group: 'off'|'local'; live: 'off'|'stream' (Stream's own recording, whole meeting / Stream 侧录像,整场)
  drive_record  INTEGER NOT NULL DEFAULT 0,     -- live only: whether "record to Drive" starts switched on; the host may flip it mid-meeting / 仅 live:开播时「录制到网盘」的初始状态,会中可随时开关
  audience_access TEXT NOT NULL DEFAULT 'link', -- live only: 'link' | 'signin'
  audience_chat INTEGER NOT NULL DEFAULT 1,     -- live only / 仅 live
  audience_token TEXT,                          -- live only / 仅 live
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX idx_meetings_owner ON meetings(owner_id, created_at);

CREATE TABLE meeting_invitees (
  meeting_id TEXT NOT NULL,
  email      TEXT NOT NULL,                     -- lowercase / 小写
  user_id    TEXT,                              -- set when the address belongs to somebody here / 该地址属于站内某人时填
  role       TEXT NOT NULL DEFAULT 'speaker',   -- 'cohost' | 'speaker' | 'viewer'
  PRIMARY KEY (meeting_id, email)
);
CREATE INDEX idx_meeting_invitees_user ON meeting_invitees(user_id);

-- One row each time a meeting is actually held. It records that it happened and how big it got,
-- not who came.
-- 一场会议每实际开一次就有一行。它记下"开过"和"开到多大",不记谁来了。
CREATE TABLE meeting_sessions (
  id              TEXT PRIMARY KEY,
  meeting_id      TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  peak_people     INTEGER NOT NULL DEFAULT 0,
  live_input_uid  TEXT,                         -- Stream live input
  transcript_node TEXT                          -- the transcript, in the owner's Drive / 文字稿,在创建者的网盘里
);
CREATE INDEX idx_meeting_sessions ON meeting_sessions(meeting_id, started_at);

-- A meeting can be recorded in pieces: every time the host switches recording on and off again
-- is one of them.
-- 一场会可以分段录:主持人每开关一次录制,就是一段。
CREATE TABLE meeting_recordings (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,                    -- 'local' (host's browser) | 'drive' (the compositor) | 'stream' (Stream's own)
  node_id     TEXT,                             -- Drive file (local / drive) / 网盘文件
  stream_uid  TEXT,                             -- Stream video (stream) / Stream 视频
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX idx_meeting_recordings ON meeting_recordings(session_id, started_at);

-- Rolling windows for the doors that stand outside the sign-in: looking a meeting up by its code,
-- and knocking as a guest. Same shape as the forms' table and for the same reason -- the key is a
-- hash of what is being limited, and the address it was derived from is never written.
-- 登录之外那几扇门的滚动窗口:按短码查会议、以访客身份敲门。形状与表单那张表相同,理由也相同 ——
-- 键是被限对象的哈希,而它所出自的那个地址从不落库。
CREATE TABLE meet_throttle (
  key       TEXT PRIMARY KEY,
  window_at INTEGER NOT NULL,
  n         INTEGER NOT NULL
);
