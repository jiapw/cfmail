// What a label may look like, and the id reserved for the one that is not a row.
//
// Two routers need these: the user-facing label API in api.ts, and the admin one in admin.ts that
// the Gmail importer talks to. They live here rather than in either of those so that neither has
// to import the other -- and so there is one list to add a colour to, not two that drift.
//
// 标签可以长成什么样,以及那个"不是一行数据"的标签所占用的保留 id。
//
// 有两个路由需要它们:api.ts 里面向用户的标签接口,和 admin.ts 里给 Gmail 导入器用的那套。
// 放在这里而不是放进其中任何一个,是为了让两边都不必反过来引对方 ——
// 也为了加一种颜色时只有一份清单要改,而不是两份各改各的。

/**
 * The built-in label is not a row anywhere. It is flag_flagged -- IMAP's \Flagged, the bit that
 * has always backed the star -- handed to the interface under this reserved id so that one list
 * and one call cover it and the labels people create alike.
 * 内置标签在任何地方都不是一行数据。它就是 flag_flagged(IMAP 的 \Flagged,一直以来星标背后的
 * 那一位),用这个保留 id 交给界面,于是一份列表、一次调用同时管住它和用户自建的标签。
 */
export const FLAGGED = 'flagged';

// Closed sets, checked on the server. A free colour picker guarantees somebody eventually picks
// the one shade invisible in dark mode, and a free icon field guarantees a broken glyph.
// 封闭集合,服务端校验。开放取色的结局,必然是有人选中在暗色主题下看不见的那一档;
// 开放图标名的结局,必然是画不出来的字形。
export const LABEL_ICONS = ['tag', 'flag', 'bookmark', 'bell', 'pin', 'heart', 'bolt', 'leaf',
  'fire', 'cube', 'eye', 'clock', 'check', 'person', 'globe', 'folder'];
export const LABEL_COLORS = ['amber', 'red', 'orange', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink', 'gray'];

export const pickIcon = (v: unknown) => (LABEL_ICONS.includes(String(v)) ? String(v) : LABEL_ICONS[0]);
export const pickColor = (v: unknown) => (LABEL_COLORS.includes(String(v)) ? String(v) : LABEL_COLORS[0]);
