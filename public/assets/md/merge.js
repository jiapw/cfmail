// Putting two people's edits back together.
//
// The three things a merge needs are base, mine and theirs, and the awkward one is base -- the
// text as it stood before either of us touched it. It is not on the server: the server holds only
// what it holds now. It is not in the file's history either, for a file that keeps none.
//
// It is in the tab. An editor that loaded a document kept exactly what it loaded, and has kept it
// through every save since, because that is what it compares against to know whether anything
// changed. So the client that is about to lose a race is the one client in the system still
// holding the common ancestor, and a merge is possible for every file -- history or no history.
//
// 把两个人的改动重新合到一起。
//
// 合并需要 base、mine、theirs 三份,而麻烦的是 base —— 我们俩谁都还没动过它时,那份文本。
// 它不在服务器上:服务器只持有它此刻所持有的。对于不保留历史的文件,它也不在历史里。
//
// 它在标签页里。一个载入过文档的编辑器,原样留着它载入的那一份,并且此后每次保存都在更新它 ——
// 因为它正是靠这一份来判断"有没有改动过"。
// 于是,那个即将在竞争中落败的客户端,恰恰是整个系统里唯一还攥着共同祖先的地方;
// 合并因此对每个文件都成立 —— 有没有历史都一样。
//
// The diff below is Myers, the merge is diff3. Both are line-based: a document is edited in lines,
// two people who touched different paragraphs touched different lines, and a merge that works at
// that grain resolves the overwhelmingly common case without ever guessing inside a sentence.
// 下面的差分是 Myers,合并是 diff3。两者都以行为单位:文档是按行编辑的,
// 两个改了不同段落的人改的是不同的行,而在这个粒度上工作的合并,
// 能解决绝大多数情形,且从不在一句话内部去猜。

/** Split the way a text file is actually made of lines: a trailing newline ends the last line
 *  rather than starting an empty one, and the fact that it was there is remembered so the merged
 *  text can end the same way.
 *  按一份文本文件真正的构成来切分:末尾的换行是最后一行的结束,而不是又一个空行的开始;
 *  并记住它曾在那里,好让合并结果以同样的方式收尾。 */
function split(s) {
  const t = String(s ?? '');
  const nl = t.endsWith('\n');
  const lines = (nl ? t.slice(0, -1) : t).split('\n');
  return { lines, nl };
}

/** Myers' difference algorithm: the shortest edit script from a to b.
 *
 *  Returned as the matched pairs rather than as edits, because what diff3 needs to know is where
 *  the two texts still agree -- everything between two agreements is a change, and that is the
 *  shape the merge walks.
 *
 *  Myers 差分算法:从 a 到 b 的最短编辑脚本。
 *
 *  返回的是"配对上的行"而不是编辑动作,因为 diff3 要知道的是两份文本仍然一致的地方 ——
 *  两处一致之间的一切就是一次改动,而合并正是沿着这个形状走的。 */
function matches(a, b) {
  const N = a.length;
  const M = b.length;
  const out = [];
  // Common ends are matched without searching. Two edits to one long document usually leave most
  // of it untouched at both ends, and trimming them first is what keeps the search small.
  // 两端相同的部分不必搜索。对一份长文档的两次编辑,通常两头的大部分原封不动,
  // 先把它们剪掉,正是让搜索保持小规模的办法。
  let lo = 0;
  while (lo < N && lo < M && a[lo] === b[lo]) { out.push([lo, lo]); lo++; }
  let hiA = N;
  let hiB = M;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }
  const tail = [];
  for (let i = 0; i < N - hiA; i++) tail.push([hiA + i, hiB + i]);

  const n = hiA - lo;
  const m = hiB - lo;
  if (n > 0 && m > 0) {
    const max = n + m;
    const v = new Int32Array(2 * max + 1);
    const trace = [];
    let done = -1;
    for (let d = 0; d <= max; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max]))
          ? v[k + 1 + max]
          : v[k - 1 + max] + 1;
        let y = x - k;
        while (x < n && y < m && a[lo + x] === b[lo + y]) { x++; y++; }
        v[k + max] = x;
        if (x >= n && y >= m) { done = d; break; }
      }
      if (done >= 0) break;
    }
    // Walk the trace back, collecting the diagonal runs -- those are the lines that matched.
    // 沿着轨迹回走,收集其中的对角线段 —— 那些就是配对上的行。
    const found = [];
    let x = n;
    let y = m;
    for (let d = done; d > 0; d--) {
      const vv = trace[d];
      const k = x - y;
      const prevK = (k === -d || (k !== d && vv[k - 1 + max] < vv[k + 1 + max])) ? k + 1 : k - 1;
      const prevX = vv[prevK + max];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { x--; y--; found.push([lo + x, lo + y]); }
      x = prevX;
      y = prevY;
    }
    while (x > 0 && y > 0) { x--; y--; found.push([lo + x, lo + y]); }
    found.reverse();
    out.push(...found);
  }
  out.push(...tail);
  return out;
}

/** The changes one text makes to another, as replacements of base line ranges.
 *  一份文本对另一份所做的改动,表述为对 base 行区间的替换。 */
function changes(base, other) {
  const m = matches(base, other);
  const out = [];
  let bi = 0;
  let oi = 0;
  const flush = (be, oe) => {
    if (be > bi || oe > oi) out.push({ bs: bi, be, lines: other.slice(oi, oe) });
  };
  for (const [b, o] of m) {
    flush(b, o);
    bi = b + 1;
    oi = o + 1;
  }
  flush(base.length, other.length);
  return out;
}

const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

/** Three texts in, one out, plus a count of the places nobody could decide.
 *
 *  Where only one side touched a stretch of the original, that side's version is taken -- there is
 *  nothing to weigh. Where both touched the same stretch and wrote different things, nothing is
 *  chosen: the two versions are written out one above the other between markers, because a merge
 *  that picks for you is a merge that loses something without saying so.
 *
 *  三份文本进,一份出,外加一个"没有谁能定夺之处"的计数。
 *
 *  原文的某一段只有一方动过,就取那一方的 —— 没有什么可权衡的。
 *  两方都动了同一段、写的又不一样,就什么都不选:两份版本夹在标记之间一上一下写出来 ——
 *  因为一个替你做主的合并,是一个不声不响丢掉东西的合并。 */
export function merge3(baseText, mineText, theirsText, labels = {}) {
  const B = split(baseText);
  const A = split(mineText);
  const T = split(theirsText);
  const mineLabel = labels.mine || 'mine';
  const theirsLabel = labels.theirs || 'theirs';

  const ca = changes(B.lines, A.lines);
  const ct = changes(B.lines, T.lines);
  const out = [];
  let conflicts = 0;
  let at = 0;
  let i = 0;
  let j = 0;

  while (i < ca.length || j < ct.length) {
    const x = ca[i];
    const y = ct[j];
    // Whichever change reaches furthest back into the original comes next; the untouched lines in
    // front of it belong to both sides equally and are simply carried over.
    // 谁的改动在原文里起点更靠前,谁就排在下一个;它前面那些没人动过的行,
    // 两边同样拥有,原样带过去即可。
    const start = x && y ? Math.min(x.bs, y.bs) : (x ? x.bs : y.bs);
    if (start > at) out.push(...B.lines.slice(at, start));

    const takeX = x && x.bs <= start;
    const takeY = y && y.bs <= start;
    if (takeX && takeY) {
      // Both reached into the same place. They may still agree -- two people can make the same
      // edit -- and agreement is not a conflict.
      // 两边伸向了同一处。它们仍然可能一致 —— 两个人可以做出同一处修改 —— 而一致不是冲突。
      const end = Math.max(x.be, y.be);
      if (x.bs === y.bs && x.be === y.be && same(x.lines, y.lines)) {
        out.push(...x.lines);
      } else {
        conflicts++;
        out.push(`<<<<<<< ${mineLabel}`);
        out.push(...B.lines.slice(start, x.bs), ...x.lines, ...B.lines.slice(x.be, end));
        out.push('=======');
        out.push(...B.lines.slice(start, y.bs), ...y.lines, ...B.lines.slice(y.be, end));
        out.push(`>>>>>>> ${theirsLabel}`);
      }
      at = end;
      i++;
      j++;
    } else if (takeX) {
      out.push(...x.lines);
      at = x.be;
      i++;
    } else {
      out.push(...y.lines);
      at = y.be;
      j++;
    }
  }
  if (at < B.lines.length) out.push(...B.lines.slice(at));

  // The ending newline follows whoever still has one: taking it away from a file that had it would
  // be a change neither person made.
  // 末尾的换行跟着"还留着它的那一方":从一个本来有它的文件上把它拿掉,
  // 是一处没有任何人做过的改动。
  const nl = A.nl || T.nl;
  return { text: out.join('\n') + (nl ? '\n' : ''), conflicts };
}

/** Where the first unresolved place begins, as a character offset -- so the editor can put the
 *  caret in it rather than leaving somebody to go looking.
 *  第一处未决之地从哪里开始,按字符偏移给出 —— 于是编辑器可以把光标放进去,
 *  而不是让人自己去找。 */
export function firstConflict(text) {
  const i = String(text ?? '').indexOf('<<<<<<< ');
  return i < 0 ? -1 : i;
}
