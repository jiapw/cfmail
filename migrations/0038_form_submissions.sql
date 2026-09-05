-- Where a form's answers go, and the answers themselves when the designer chooses to keep them.
--
-- Until now every answer was a message and nothing else. The designer may now choose, per form,
-- to have CFMail keep the answer -- with its files -- so that it can be opened from the form's
-- own list, with the mail carrying a link to it (and, at the designer's option, the complete
-- answer as well). Kept answers stay until somebody deletes them: there is no expiry, in keeping
-- with the rest of this system, which never throws data away on a timer.
--
-- 表单的答复去哪儿,以及设计者选择保留时的答复本身。
--
-- 此前每份答复只是一封邮件,别无他物。现在设计者可以按表单选择让 CFMail 保留答复 —— 连同文件 ——
-- 好从表单自己的列表里打开它;邮件则带上它的链接(设计者愿意的话,也可以同时带上完整答复)。
-- 保留的答复一直留到有人删除:没有过期,与这套系统的其余部分一致 —— 它从不按计时器扔数据。

-- mail: the message carries everything, nothing is kept (the original behaviour)
-- store: kept here; the message carries a link only
-- both: kept here; the message carries the complete answer and a link
-- mail:邮件带上全部,什么都不留(原来的行为);store:留在这里,邮件只带链接;both:留在这里,邮件带完整答复和链接
ALTER TABLE forms ADD COLUMN store TEXT NOT NULL DEFAULT 'mail';

CREATE TABLE form_submissions (
  id           TEXT PRIMARY KEY,
  form_id      TEXT NOT NULL,
  version      INTEGER NOT NULL,                -- the design the person actually saw / 那个人真正看到的那版设计
  sender_name  TEXT NOT NULL DEFAULT '',
  sender_addr  TEXT NOT NULL DEFAULT '',
  lang         TEXT,                            -- the language the form was filled in / 填写时用的语言
  local_time   TEXT,                            -- the browser's own word for when / 浏览器自己说的时间
  tz           TEXT,
  tz_offset    INTEGER,
  -- The address and Cloudflare's reading of it. The designer asked for these on every answer;
  -- when answers are kept, they are kept with them.
  -- 地址与 Cloudflare 对它的判读。设计者要求每份答复都带上;答复被保留时,它们随之保留。
  ip           TEXT,
  geo          TEXT,
  answers_json TEXT NOT NULL,                   -- {key: answer}, files by index into files_json / 答案,文件按 files_json 的序号引用
  files_json   TEXT NOT NULL DEFAULT '[]',      -- [{n, key, name, mime, size, r2_key}]
  subject      TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_form_subs ON form_submissions(form_id, created_at);
