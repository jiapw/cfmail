// Where a file's bytes come from, and where its neighbours live in the URL bar.
//
// Two callers read the very same nodes through two different doors: the signed-in Drive
// (/api/drive/*, session cookie) and the public share page (/api/pub/<token>/*, no account at
// all). Everything downstream of the listing -- the preview overlay, the archive browser, the
// streaming worker -- is identical work on identical bytes, so it must not know which door it
// came through. This module is that seam: one mutable current source, set once per view.
//
// 一个文件的字节从哪里来,以及它的邻居在地址栏里住在哪里。
//
// 两个调用方透过两扇不同的门读同一批节点:登录态网盘(/api/drive/*,会话 cookie)与
// 公开分享页(/api/pub/<token>/*,根本没有账号)。列表之后的一切 —— 预览层、压缩包浏览器、
// 流式 worker —— 对同样的字节做同样的事,因此不该知道自己是从哪扇门进来的。
// 本模块就是那道接缝:一个可变的当前来源,每次进入视图时设定一次。

export const fsrc = {
  base: '/api/drive',   // API prefix for reads / 读取用的 API 前缀
  token: '',            // public share token, empty when signed in / 公开分享 token,登录态为空
  root: '#/drive',      // hash prefix this view navigates within / 本视图导航所在的 hash 前缀
};

export function useDriveSource() {
  fsrc.base = '/api/drive';
  fsrc.token = '';
  fsrc.root = '#/drive';
}

export function usePubSource(token) {
  const tk = encodeURIComponent(token);
  fsrc.base = `/api/pub/${tk}`;
  fsrc.token = token;
  fsrc.root = `#/p/${tk}`;
}

export const isPub = () => !!fsrc.token;

// A file's address used to be a fixed thing while its contents changed underneath it, which is
// exactly the shape of a stale preview: the browser is asked for a URL it already holds an answer
// to, and it answers without asking us. Naming the version in the address ends that -- new bytes,
// new URL, and nothing cached under the old one is ever requested again. The server ignores `v`;
// it is addressed to the cache, not to us. (This also repairs a browser that already holds a
// stale copy, which no change to our response headers can reach.)
// 文件的地址从前是个定数,而它的内容在底下悄悄换过 —— 这正是"预览是旧的"的形状:
// 浏览器被问到一个它已有答案的 URL,于是它不来问我们就自己答了。
// 把版本写进地址就终结了这件事:新字节,新 URL,旧地址下缓存的东西再也不会被请求。
// 服务端忽略 v —— 这个参数是说给缓存听的,不是说给我们听的。
// (这同时也救得回一个已经存着旧副本的浏览器,而那是任何响应头的改动都够不到的。)
const withVer = (base, parts, ver) => {
  const q = parts.slice();
  if (ver) q.push('v=' + encodeURIComponent(ver));
  return base + (q.length ? '?' + q.join('&') : '');
};

export const dlUrl = (id, inline, ver) =>
  withVer(`${fsrc.base}/files/${encodeURIComponent(id)}/dl`, inline ? ['inline=1'] : [], ver);
export const thumbUrl = (id, ver) =>
  withVer(`${fsrc.base}/files/${encodeURIComponent(id)}/thumb`, [], ver);

// One earlier version's bytes. The signed-in Drive alone answers here -- a public share hands out
// what a file is now, and its history is not part of what was handed out.
// 某个更早版本的字节。只有登录态网盘应答这里 —— 公开分享交出去的是"文件现在是什么",
// 而它的历史不在交出去的东西之内。
export const verUrl = (id, vid, inline) =>
  `${fsrc.base}/nodes/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}/dl${inline ? '?inline=1' : ''}`;
export const metaUrl = (id) => `${fsrc.base}/nodes/${encodeURIComponent(id)}/meta`;

// The two views spell folders differently: the Drive has other kinds of listing to distinguish
// (shared, trash, search) and so tags them, while a share page has nothing but folders.
// 两个视图对目录的拼法不同:网盘还有别种列表要区分(共享、回收站、搜索),所以加了标签;
// 而分享页除了目录别无他物。
export const folderHash = (id) =>
  fsrc.token ? `${fsrc.root}/${encodeURIComponent(id)}` : `#/drive/folder/${encodeURIComponent(id)}`;

export const arcHash = (id, path) =>
  `${fsrc.root}/arc/${encodeURIComponent(id)}`
  + (path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '');

/** True while the hash still points inside this archive -- used to decide when to let a
 *  visit's blob URLs go. Written against the current source's own prefix.
 *  hash 仍指在这个压缩包内时为真 —— 用于判断何时可以释放本次访问的 blob URL。
 *  按当前来源自己的前缀书写。 */
export const inArc = (id) => location.hash.startsWith(`${fsrc.root}/arc/${encodeURIComponent(id)}`);

/** Query the streaming worker must carry so it can fetch the archive through the same door.
 *  流式 worker 必须携带的查询串,好让它从同一扇门去取压缩包。 */
export const streamQuery = () => (fsrc.token ? '?t=' + encodeURIComponent(fsrc.token) : '');

// ---------- State the Drive and the archive browser must share ----------
// ---------- 网盘与压缩包浏览器必须共用的状态 ----------
//
// arc.js used to reach these out of drive.js directly. Both modules are loaded with a `?v=`
// cache-busting query, and a static `import './drive.js'` has no way to carry one -- so the
// two specifiers named two different URLs and the browser instantiated drive.js TWICE, giving
// arc.js a private copy of the seed map and of the preview overlay. Parking the shared pieces
// in this module, which nobody version-queries, is what makes them one thing again.
//
// arc.js 过去直接从 drive.js 里取这些东西。两个模块都带 `?v=` 破缓存查询,而静态
// `import './drive.js'` 无从携带 —— 于是两个说明符指向两个不同 URL,浏览器把 drive.js
// 实例化了两次,arc.js 拿到的是种子表与预览层的私有副本。把共用的部分停放在这个
// 谁都不加版本查询的模块里,它们才重新成为同一个东西。

/** Name/size/breadcrumb stashed when stepping into an archive, so the path bar can be drawn
 *  before the reader opens. Missing (a deep link, a reload) means fetch /meta instead.
 *  点进压缩包时暂存的名称/大小/面包屑,好在读取器打开前就画出路径条。
 *  没有(深链、刷新)就改从 /meta 取。 */
export const arcSeed = new Map();

/** The Drive registers its preview overlay here; the archive browser opens entries through it.
 *  网盘在此登记自己的预览层;压缩包浏览器经由它打开条目。 */
export const preview = { open: null };
export const setPreviewOpener = (fn) => { preview.open = fn; };
