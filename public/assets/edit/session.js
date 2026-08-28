// One document being edited, and the four things that are true of every editor that edits one.
//
// This exists because there is now more than one editor. The rules a save follows are not obvious
// -- which token names the version being replaced, when a save is not worth making, what happens
// when somebody else got there first, who has to be told afterwards -- and every one of them was
// arrived at by being got wrong once. Two copies of that would agree on the day they were written
// and drift apart quietly afterwards, and the drift would show up as somebody's work going
// missing, which is the one failure this whole path exists to prevent.
//
// The editors keep their own state and their own interface. What lives here is only the protocol.
//
// 一份正在被编辑的文档,以及"任何编辑它的编辑器"都成立的那四件事。
//
// 它之所以存在,是因为现在不止一个编辑器。保存所遵循的规则并不显然 ——
// 用哪个令牌指认"正在被替换的那一版"、什么时候一次保存不值得做、
// 别人抢先了怎么办、事后该告诉谁 —— 而其中每一条,都是先弄错过一次才得出的。
// 两份副本会在写下的那天彼此一致,此后悄悄走岔,而走岔会以"某人的成果不见了"的形式浮现 ——
// 那正是这整条路径存在所要防的唯一一种失败。
//
// 编辑器各自保有自己的状态与界面。住在这里的,只有协议。
import { api } from '../api.js';
import { announceChange } from '../drive/fsrc.js';
import { detect, decodeBytes, encodeText } from './codepage.js';

export const MAX_BYTES = 2 * 1024 * 1024;

export const sha256Hex = async (bytes) => {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** The token that names the version a write is replacing.
 *
 *  A file that keeps history has a version to name. One that keeps none has only the moment it
 *  last changed -- which serves, because it moves whenever the bytes do. The server computes the
 *  same two ways round; if these ever disagree, every conditional write is refused.
 *
 *  指认"一次写入正在替换哪一版"的那个令牌。
 *
 *  保留历史的文件有版本可指名;不保留的只有它上次改动的那一刻 —— 这也够用,
 *  因为字节一动它就动。服务端用的是同样这两条;两边一旦不一致,所有条件写都会被拒。 */
export const tokenOf = (node) => node.ver_head || `${node.id}-${node.updated_at}`;

/** The same fact, used the other way round: as the part of an address that must change when the
 *  file does, or a browser answers the next request out of the copy it already has.
 *  同一个事实的另一种用法:作为地址中"必须随文件一起改变"的那一部分 ——
 *  否则浏览器下一次就用它手上那份副本作答。 */
export const stampOf = (node) => node.ver_head || node.updated_at || '';

const dlUrlFor = (id, stamp) =>
  `/api/drive/files/${encodeURIComponent(id)}/dl?inline=1${stamp ? `&v=${encodeURIComponent(stamp)}` : ''}`;

/** Fetch a document and everything needed to write it back.
 *  取回一份文档,以及把它写回去所需的一切。 */
export async function openDoc(id) {
  const meta = await api('GET', `/api/drive/nodes/${encodeURIComponent(id)}/meta`);
  const node = meta.node;
  if (node.kind !== 'file') throw new Error('e_drive_not_file');
  if ((node.size || 0) > MAX_BYTES) throw new Error('e_md_too_big');
  const r = await fetch(dlUrlFor(id, stampOf(node)));
  if (!r.ok) throw new Error('e_drive_not_found');
  const buf = new Uint8Array(await r.arrayBuffer());
  // Judged from the bytes, not assumed: a BOM speaks for itself, valid multi-byte UTF-8 is
  // UTF-8, and everything else is read the way this reader's Windows would read it. The raw
  // bytes stay on the document so a person who disagrees can have them re-read another way.
  // 从字节里断定,而不是假定:BOM 自己作数,合法的多字节 UTF-8 就是 UTF-8,
  // 其余按这位读者的 Windows 会怎么读来读。原始字节留在文档上,
  // 不同意这个判断的人可以让它们按别的方式重读一遍。
  const cp = detect(buf);
  return {
    id,
    name: node.name,
    // Where the document lives, which is what a relative address inside it is relative to.
    // 文档住在哪儿 —— 它内部的相对地址,相对的正是这个。
    parent: node.parent_id || 'root',
    // The common ancestor. Kept from here on, advanced on every successful save, and handed to a
    // merge when one is needed -- it is the only copy of it left anywhere once the server moves on.
    // 共同祖先。从此刻起留住,每次保存成功后推进,需要合并时交出去 ——
    // 服务器一旦向前走,它就是这份内容在世上仅剩的一份。
    base: decodeBytes(buf, cp.enc),
    hash: await sha256Hex(buf),
    token: tokenOf(node),
    cp,
    raw: buf,
  };
}

/** Write it back.
 *
 *  Three answers rather than two, because "nothing happened" and "somebody else was here" are not
 *  failures and should not be reported as one.
 *
 *  写回去。
 *
 *  三种答复而不是两种,因为"什么都没发生"和"别人先到过"都不是失败,不该被当成失败报出去。 */
export async function saveDoc(doc, text, mime) {
  // Written back in the codepage it was read in. Converting a file's encoding is its owner's
  // decision, made at the selector; a save never makes it. Characters the codepage cannot carry
  // come back as a fourth answer instead of bytes: nothing is written until a person has seen
  // which characters and said to go on.
  // 按读入时的代码页写回去。改文件的编码是它主人的决定,在选择器上做;保存从不代劳。
  // 代码页装不下的字符不会变成字节,而是变成第四种答复:
  // 在人看过是哪些字符、说了继续之前,什么都不会写。
  const cp = doc.cp || { enc: 'utf-8', bom: false };
  const { bytes, bad } = encodeText(text, cp.enc, cp.bom);
  if (bad.length) return { status: 'badchars', bad };
  if (bytes.byteLength > MAX_BYTES) return { status: 'too-big' };
  const hash = await sha256Hex(bytes);
  // The comparison the uploader makes, for the same reason: a save that changes nothing should
  // cost neither an upload nor a version that says nothing.
  // 与上传器做的是同一个比较,理由相同:什么都没改的一次保存,
  // 不该花掉一次上传,也不该留下一个什么都没说的版本。
  if (hash === doc.hash) return { status: 'unchanged' };

  const q = `node=${encodeURIComponent(doc.id)}&mime=${encodeURIComponent(mime || 'text/plain')}&hash=${hash}`;
  const res = await fetch(`/api/drive/upload?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': mime || 'text/plain', ...(doc.token ? { 'If-Match': `"${doc.token}"` } : {}) },
    body: bytes,
  });
  if (res.status === 412) return { status: 'conflict' };
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'e_request_failed');

  doc.base = text;
  doc.hash = hash;
  doc.raw = bytes;
  doc.token = data?.ver_head || `${doc.id}-${data?.updated_at || Date.now()}`;
  // Any listing open in another tab is still stamping this file's address with the moment it last
  // knew about, and everything it needs in order to stop doing that came back with the write.
  // 别的标签页里开着的列表,仍在用"它最后一次知道的那一刻"给这个文件的地址盖戳,
  // 而让它不再这么做所需的一切,都随这次写入一起回来了。
  announceChange(doc.id, {
    updated_at: data?.updated_at || Date.now(),
    ver_head: data?.ver_head || null,
    size: bytes.byteLength,
    thumb: false,
    bumpVersions: !!data?.ver_head,
  });
  return { status: 'saved' };
}

/** Put the two sets of edits back together.
 *
 *  Called when a save came back refused. The other side is fetched, the merge runs against the
 *  ancestor this session has been holding all along, and the document is moved onto the other
 *  side's version -- because that is what the server holds, and it is what the next save must name
 *  and the next merge must start from.
 *
 *  把两边的改动重新合到一起。
 *
 *  在一次保存被拒之后调用。取回对方那一份,拿本会话一直攥着的那个祖先去合,
 *  并把文档移到对方那一版上 —— 因为那是服务器持有的东西,
 *  也是下一次保存必须指名、下一次合并必须从之出发的东西。 */
export async function mergeDoc(doc, mine, labels) {
  const meta = await api('GET', `/api/drive/nodes/${encodeURIComponent(doc.id)}/meta`);
  const node = meta.node;
  const r = await fetch(dlUrlFor(doc.id, stampOf(node)));
  if (!r.ok) throw new Error('e_drive_not_found');
  // Their bytes, read through the same codepage this session is reading in. The hash is taken
  // from the bytes as they came, so "unchanged" keeps meaning what the server would say it means.
  // 对方的字节,按本会话正在用的同一个代码页读出来。哈希取自字节原样,
  // 于是"没有变化"的含义与服务器口中的保持一致。
  const bufT = new Uint8Array(await r.arrayBuffer());
  const theirs = decodeBytes(bufT, doc.cp?.enc || 'utf-8');
  const mod = await import('../md/merge.js');
  const out = mod.merge3(doc.base, mine, theirs, labels);
  out.first = mod.firstConflict(out.text);
  doc.base = theirs;
  doc.hash = await sha256Hex(bufT);
  doc.raw = bufT;
  doc.token = tokenOf(node);
  return out;
}

/** What is in the box, kept where a crashed tab cannot take it. Dropped the moment it agrees with
 *  what the server holds -- a draft that matches the file is not a draft, it is clutter that will
 *  one day offer to restore nothing.
 *  框里的东西,存在一个崩掉的标签页带不走的地方。一旦它与服务端所存一致就丢弃 ——
 *  与文件一致的草稿不是草稿,只是一堆将来会提出"要不要恢复"却什么也恢复不了的杂物。 */
const key = (id) => 'cf_edit_draft_' + id;

/** Where the Markdown editor kept its drafts before there was a second editor to share with.
 *  Read but never written, so it empties itself: whoever had a draft under the old name is offered
 *  it once and it is saved or dropped under the new one. Deletable once nobody could still be
 *  carrying one -- a draft only outlives its tab when the tab did not close on purpose.
 *  在有第二个编辑器可共享之前,Markdown 编辑器把草稿存在这儿。只读不写,所以它会自己清空:
 *  在旧名字下存着草稿的人会被提出一次,然后它就以新名字被保存或丢弃。
 *  等到不可能还有人揣着一份时即可删掉 —— 草稿只有在标签页不是被特意关掉时才会活过它。 */
const was = (id) => 'cf_md_draft_' + id;

export const draft = {
  write(doc, text) {
    try {
      // Clearing means clearing: a draft left under the old name would be offered again
      // every time this file is opened, forever.
      // 清就要清干净:留在旧名字下的一份草稿,会在这个文件每次被打开时被重新提出来,永远。
      if (text === doc.base) { localStorage.removeItem(key(doc.id)); localStorage.removeItem(was(doc.id)); }
      else localStorage.setItem(key(doc.id), JSON.stringify({ text, at: Date.now() }));
    } catch { /* a full quota is not worth an error here / 配额满了,不值得在这里报错 */ }
  },
  read(id) {
    try {
      const d = JSON.parse(localStorage.getItem(key(id)) || localStorage.getItem(was(id)) || 'null');
      return d && typeof d.text === 'string' ? d : null;
    } catch {
      return null;
    }
  },
  clear(id) {
    try { localStorage.removeItem(key(id)); localStorage.removeItem(was(id)); } catch { /* nothing to clear / 没什么可清 */ }
  },
};

/** Redraw the little picture the file list shows. Generated the same way the uploader generates
 *  one, from the same bytes, so a file edited here looks in the listing exactly as it would have
 *  if it had been uploaded. Failure is silent: a missing thumbnail is a missing thumbnail, and it
 *  is not worth casting doubt on a save that succeeded.
 *  重画文件列表里的那张小图。生成方式与上传器相同、字节也相同,
 *  于是一份在这里编辑过的文件,在列表里的样子与它被上传上来时应有的样子一模一样。
 *  失败是静默的:少一张缩略图就是少一张缩略图,不值得让一次已经成功的保存显得可疑。 */
export async function refreshThumb(doc, text, mime, v) {
  try {
    const mod = await import(`../drive/thumb.js?v=${v}`);
    const blob = await mod.makeThumb(new File([text], doc.name || 'doc.txt', { type: mime || 'text/plain' }));
    if (!blob) return;
    await fetch(`/api/drive/files/${encodeURIComponent(doc.id)}/thumb`, { method: 'POST', body: blob });
    announceChange(doc.id, { thumb: true });
  } catch { /* said above / 见上 */ }
}
