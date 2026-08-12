// Error codes, not sentences. The server never produces human-readable text: it answers with a
// stable code plus any values that belong in the message, and the browser renders it in the
// reader's own language from public/assets/i18n.js. That keeps one translation table for the
// whole product instead of a second one on the server, and keeps the API usable from anything.
//
// 只回代码,不回句子。服务端不产出任何给人看的文本 —— 只给一个稳定的错误码,外加要嵌进句子里的值,
// 由浏览器按使用者的语言渲染(词条在 public/assets/i18n.js)。这样全产品只有一份翻译表,
// 服务端不必再维护第二份,API 也更容易被其他客户端使用。
//
// Wire format / 传输格式:  { "error": "e_mailbox_not_found", "args": ["a@b.com"] }
// The frontend looks up t(error, ...args); an unknown code falls back to a generic message.
// 前端用 t(error, ...args) 取词;词典里没有的码会退回一句通用提示。

/** Values interpolated into a message ({0}, {1} ...). Anything a translation cannot own:
 *  addresses, sizes, or verbatim text from a third party such as a sending provider.
 *  要插进句子里的值({0}、{1} …)。凡是翻译管不到的都走这里:地址、大小,
 *  以及第三方(比如发信通道)原样返回的文本。 */
export type ErrArg = string | number;

export class HttpError extends Error {
  status: number;
  args: ErrArg[];
  /** @param message an error code from the e_* namespace, never a sentence / e_* 命名空间下的错误码,不是句子 */
  constructor(status: number, message: string, ...args: ErrArg[]) {
    super(message);
    this.status = status;
    this.args = args;
  }
}

/** Body for c.json(): E('e_bad_email') or E('e_owner_exists', addr).
 *  给 c.json() 用的响应体:E('e_bad_email') 或 E('e_owner_exists', addr)。 */
export function E(code: string, ...args: ErrArg[]) {
  return args.length ? { error: code, args } : { error: code };
}

/**
 * Diagnostics that get stored rather than returned -- outbox.last_error is the only one.
 * A stored string mixes our own codes with verbatim provider output, so ours are tagged with a
 * leading marker and the frontend translates only those; provider text passes through untouched.
 *
 * 存起来、而不是直接返回的诊断信息 —— 目前只有 outbox.last_error。
 * 这个字段里既有我们自己的话,也有发信通道原样吐出来的内容,所以我们的部分加个前缀标记,
 * 前端只翻译带标记的;通道原文原样透出。
 */
export const ERR_MARK = '\u0001';
export const ERR_SEP = '\u001f';
export function storedErr(code: string, ...args: ErrArg[]) {
  return ERR_MARK + [code, ...args].join(ERR_SEP);
}
