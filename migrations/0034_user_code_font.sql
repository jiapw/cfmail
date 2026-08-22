-- The typeface source code is shown in, chosen per user and separate from the other two.
-- A code font has one job the interface font does not: every character occupies the same width,
-- so that what lines up in the file lines up on the screen. Sharing a setting with the interface
-- would mean choosing between prose that reads well and code that is aligned.
-- 源码所用的字体,按用户选择,与另外两种分开。
-- 代码字体有一件界面字体没有的差事:每个字符占同样的宽度,
-- 好让文件里对齐的东西在屏幕上也对齐。与界面共用一个设置,
-- 就等于要在"散文好看"和"代码对齐"之间二选一。
ALTER TABLE users ADD COLUMN code_font TEXT;
