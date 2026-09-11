-- How a form's fill page looks is the designer's decision, made once in the editor and kept
-- with the form. The palette and light-or-dark were already recorded; the typeface and the
-- text size join them. The page no longer offers the visitor a switch: it is shown the way it
-- was designed, to everyone, and the only thing a visitor chooses is their language.
--
-- 表单填写页长什么样,由设计者决定:在编辑器里定一次,随表单保存。配色与明暗此前已经记录;
-- 字体与字号现在加入。页面不再给访问者开关:对每个人都按设计的样子呈现,访问者唯一能选的是语言。

ALTER TABLE forms ADD COLUMN font TEXT NOT NULL DEFAULT '';           -- a catalogue font name, or '' for the system face / 字体目录里的名字,'' 为系统字体
ALTER TABLE forms ADD COLUMN text_size TEXT NOT NULL DEFAULT 'md';    -- sm | md | lg | xl
