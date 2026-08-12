-- Invites from the old model (attached to an existing mailbox, carrying grants_json)
-- are all voided. No backward compatibility is offered.
-- 旧模型的邀请(挂在"已存在的邮箱"上,带 grants_json)一律作废,不做兼容。
-- How to tell: 0011 backfilled existing rows with mailbox_mode='fixed', while every
-- newly created fixed invite always has a local_part. So fixed + local_part IS NULL
-- identifies a link issued before the rework.
-- 判据:0011 给存量行填的默认值是 mailbox_mode='fixed',而新建的 fixed 邀请一定有 local_part。
-- 所以 fixed + local_part IS NULL 就是改造之前发出的链接。
UPDATE invites
   SET revoked = 1
 WHERE revoked = 0
   AND used_by IS NULL
   AND mailbox_mode = 'fixed'
   AND local_part IS NULL;
