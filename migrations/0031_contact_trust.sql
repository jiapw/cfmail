-- A contact's safety was a switch with a hidden third position: on, off, and "nothing said yet",
-- which was stored as NULL and then guessed from whether the address was local. The guess was
-- doing two jobs at once -- "we know this is a colleague" and "you told us this one is fine" --
-- and it left everyone else branded unsafe for the sole crime of being external.
--
-- Three named states instead, and nothing derived: trusted, unknown, risk. Unknown is the default
-- and means exactly what it says. Risk is now something a person decides on purpose, which is what
-- makes it worth showing.
--
-- The backfill keeps every existing contact exactly as they were treated yesterday, including the
-- colleagues who were trusted only by inference.
--
-- 联系人的安全性原本是个带隐藏第三档的开关:开、关,以及"还没人说过" —— 后者存成 NULL,
-- 再按地址是不是站内猜一个。那次猜测同时干了两件事:"我们知道这是同事"和"你说过这个人没问题",
-- 而其余所有人仅仅因为身在外部就被判为不安全。
--
-- 改成三个有名字的状态,不再推导:可信、未知、隐患。未知是默认值,字面意思。
-- 隐患从此是有人特意做的判断 —— 这才让它值得被显示出来。
--
-- 回填让每一个现有联系人保持昨天受到的同等待遇,包括那些仅靠推断而可信的同事。
ALTER TABLE contacts ADD COLUMN trust TEXT NOT NULL DEFAULT 'unknown';

UPDATE contacts SET trust = CASE
  WHEN safe = 1 THEN 'trusted'
  WHEN safe = 0 THEN 'risk'
  WHEN internal = 1 THEN 'trusted'
  ELSE 'unknown'
END;

ALTER TABLE contacts DROP COLUMN safe;
