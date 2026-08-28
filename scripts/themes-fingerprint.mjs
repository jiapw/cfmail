// The one definition of "what the committed themes were built from".
//
// Two scripts need the same answer: build-themes.mjs stamps it into themes.css when it
// generates, and sync-vendor.mjs recomputes it to check that the committed output still
// matches its inputs. Living in one module is what keeps the two from drifting -- the same
// reason the fingerprint exists at all.
//
// The inputs are the @radix-ui/colors version and the full text of build-themes.mjs: the
// theme list, the token bridge and every rule about them live in that script, so hashing it
// whole is what makes "any change to the themes" the trigger, without maintaining a list of
// which parts count. Line endings are normalised first -- a CRLF checkout must not disagree
// with an LF one about content that is identical.
//
// "已提交的主题产物是用什么造出来的"——这件事的唯一定义。
//
// 两个脚本需要同一个答案:build-themes.mjs 生成时把它盖进 themes.css,
// sync-vendor.mjs 重算它来校验入库产物是否仍与输入一致。住在同一个模块里,
// 两边才不会漂移 —— 这也正是指纹本身存在的理由。
//
// 输入是 @radix-ui/colors 的版本号加 build-themes.mjs 的全文:主题清单、token 桥、
// 以及关于它们的每一条规则都住在那个脚本里,整体哈希才能让"主题的任何改动"都成为触发点,
// 而不用维护一份"哪些部分算数"的清单。先归一化行尾 ——
// CRLF 的 checkout 不该和 LF 的 checkout 对同一份内容各执一词。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} root  repository root
 * @returns {{version: string, hash: string} | null}  null when an input cannot be read
 *          (typically @radix-ui/colors not installed -- a deploy-only checkout)
 */
export function themesFingerprint(root) {
  let version, source;
  try {
    version = JSON.parse(fs.readFileSync(
      path.join(root, 'node_modules', '@radix-ui', 'colors', 'package.json'), 'utf8')).version;
    source = fs.readFileSync(path.join(root, 'scripts', 'build-themes.mjs'), 'utf8');
  } catch {
    return null;
  }
  const hash = crypto.createHash('sha256')
    .update(version + '\n' + source.replace(/\r\n/g, '\n'))
    .digest('hex').slice(0, 16);
  return { version, hash };
}

/** Read the fingerprint stamped into a generated themes.css; null when absent or unreadable. */
export function stampedFingerprint(root) {
  try {
    const head = fs.readFileSync(path.join(root, 'public', 'assets', 'themes.css'), 'utf8').slice(0, 300);
    const m = /source @radix-ui\/colors@(\S+) fp=([0-9a-f]{16})/.exec(head);
    return m ? { version: m[1], hash: m[2] } : null;
  } catch {
    return null;
  }
}
