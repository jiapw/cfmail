-- Web forms: a survey or a feedback sheet somebody designs, hands out as a link, and receives
-- the answers to as mail.
--
-- The answers are NOT stored here. A filled form becomes one message, written straight into the
-- inbox of every recipient the designer named, exactly as if the person had mailed it in. The
-- mailbox is where the company already reads, searches, labels and archives things; a second
-- store of the same answers would be one more place to secure and one more thing to forget to
-- delete. What this table keeps is the design, and enough about each design to know which
-- version of it a given answer was written against.
--
-- 网页表单:某人设计一份问卷或反馈表,以链接发出去,答复以邮件的形式收回来。
--
-- 答复**不**存在这里。一份填好的表单变成一封邮件,直接写进设计者指定的每个接收邮箱的收件箱,
-- 与那个人亲自寄来一封无异。邮箱是这家公司本来就在读、搜、贴标签、归档的地方;
-- 把同一份答复再存一份,只是多一处要防守、多一样忘了删的东西。
-- 这张表保存的是设计,以及关于每份设计的足够信息 —— 好知道某条答复是对着它的哪个版本写下的。

CREATE TABLE forms (
  id              TEXT PRIMARY KEY,
  -- The permanent address. Fixed at creation and never rotated: the link a form was handed out
  -- under stays good until the form is deleted, and disabling shows a notice rather than a 404.
  -- 永久地址。创建时定下、从不轮换:表单以哪条链接发出去,那条链接就一直有效,直到表单被删除;
  -- 停用时显示一条说明,而不是 404。
  token           TEXT NOT NULL UNIQUE,
  owner_id        TEXT NOT NULL,                    -- users.id
  domain_id       TEXT,                             -- the company domain it belongs to / 所属企业域名(品牌、验证码发件域)
  kind            TEXT NOT NULL DEFAULT 'survey',   -- survey | feedback
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  -- public: anybody holding the link; internal: signed-in members only, whose address is filled in for them
  -- public:持链接者皆可;internal:仅登录成员,地址由系统代填
  audience        TEXT NOT NULL DEFAULT 'public',
  -- Public forms only: the address must be proven before the answers are accepted
  -- 仅公开表单:提交前必须先证明地址是自己的
  verify_email    INTEGER NOT NULL DEFAULT 0,
  src_lang        TEXT NOT NULL DEFAULT 'en',       -- the language the designer wrote in / 设计者书写的语言
  langs_json      TEXT NOT NULL DEFAULT '[]',       -- languages the fill page is offered in / 填写页提供的语言
  fields_json     TEXT NOT NULL DEFAULT '[]',       -- the questions / 题目定义
  i18n_json       TEXT NOT NULL DEFAULT '{}',       -- machine translations of the designer's text / 设计者文本的机器翻译
  subject_tpl     TEXT NOT NULL DEFAULT '',         -- mail subject template with {placeholders} / 邮件主题模板
  recipients_json TEXT NOT NULL DEFAULT '[]',       -- internal addresses that receive each answer / 接收答复的站内地址
  theme           TEXT,                             -- the designer's palette at last save / 上次保存时设计者的配色
  mode            TEXT,                             -- 'light' | 'dark': the designer's mode, the fill page's default / 明暗,填写页默认值
  version         INTEGER NOT NULL DEFAULT 1,
  disabled        INTEGER NOT NULL DEFAULT 0,
  submissions     INTEGER NOT NULL DEFAULT 0,
  last_submit_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_forms_owner ON forms(owner_id, updated_at);

-- Every version of every design. A fill page loaded yesterday may be submitted today against a
-- design that changed in between; the answer is rendered with the questions the person actually
-- saw, and the mail says which version that was.
-- 每份设计的每个版本。昨天打开的填写页可能今天才提交,而设计在中间改过;
-- 答复按那个人真正看到的题目来呈现,邮件里写明是哪个版本。
CREATE TABLE form_versions (
  form_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  spec_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (form_id, version)
);

-- Address verification for public forms. A code is mailed, checked, and the row marked verified;
-- the submission then consumes the row. Nothing about the answers is here.
-- 公开表单的地址验证。寄出验证码、校验、把这一行标记为已验证;随后的提交消费掉这一行。
-- 这里没有任何关于答复的内容。
CREATE TABLE form_codes (
  id         TEXT PRIMARY KEY,
  form_id    TEXT NOT NULL,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  verified   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_form_codes ON form_codes(form_id, email, created_at);

-- Rolling windows for the public endpoints, keyed by what is being limited (a form and an
-- address, a form and a hashed IP). The key is opaque; the IP itself is never written.
-- 公开端点的滚动窗口,键是被限的对象(表单+地址、表单+IP 哈希)。键不可逆;IP 本身从不落库。
CREATE TABLE form_throttle (
  key       TEXT PRIMARY KEY,
  window_at INTEGER NOT NULL,
  n         INTEGER NOT NULL
);
