// PDF passwords, done by qpdf.
//
// Neither library in this editor can do this. pdf.js can DECODE an encrypted file for display
// but never hands the plaintext back; pdf-lib cannot open one at all, and can write none. qpdf
// can do both, and its CLI compiled to WASM is a smaller dependency than a hand-written
// implementation of the PDF standard security handler would be a liability.
//
// Everything here works bytes-to-bytes: an encrypted file goes in with its password and comes
// out plain, for the editing pipeline that must be able to read every object; the built document
// goes in plain and comes out encrypted, AES-256, on its way back to the Drive. The module is
// loaded only when a password is actually met or asked for -- the wasm is 1.7 MB that most
// documents never need.
//
// PDF 密码,交给 qpdf 办。
//
// 这个编辑器里的两个库都办不了这件事。pdf.js 能"解开"一份加密文件用于显示,
// 却从不把明文交回来;pdf-lib 干脆打不开,更一份也写不出。qpdf 两样都行,
// 而它编译成 WASM 的命令行,比一份手写的 PDF 标准安全处理器实现要小得多 —— 后者是负债。
//
// 这里的一切都是字节进、字节出:加密文件带着密码进来,出去是明文,
// 给必须读得到每个对象的编辑管线;搭好的文档以明文进来,出去是 AES-256 密文,
// 在回网盘的路上。本模块只在真正遇到或要设密码时才加载 —— 那 1.7 MB 的 wasm,
// 大多数文档一辈子用不上。

let factory = null;

async function run(args, inBytes) {
  if (!factory) factory = (await import('/vendor/qpdf/qpdf.mjs')).default;
  const errs = [];
  const mod = await factory({
    noInitialRun: true,
    print: () => {},
    printErr: (s) => errs.push(String(s)),
  });
  mod.FS.writeFile('/in.pdf', inBytes);
  const code = mod.callMain([...args, '/in.pdf', '/out.pdf']);
  let out = null;
  try {
    out = mod.FS.readFile('/out.pdf');
  } catch { /* no output means the run failed, and code says so / 没有产出即失败,退出码会说 */ }
  return { code, out, errs };
}

/** Whether pdf.js refused this file for want of a password. The exception is the authority --
 *  scanning bytes for /Encrypt would take a string in some page's content for a lock.
 *  pdf.js 是不是因为缺密码而拒开这份文件。以异常为准 ——
 *  在字节里扫 /Encrypt,会把某页内容里的一个字符串错当成一把锁。 */
export const needsPassword = (e) => e?.name === 'PasswordException';

/**
 * The file, laid open. A wrong password is an answer, not an error: the caller asks again.
 * 这份文件,摊开来。密码不对是一个回答,不是一个错误:调用方再问一次就是。
 */
export async function decrypt(bytes, password) {
  const { code, out, errs } = await run(
    [`--password=${password}`, '--decrypt'],
    bytes,
  );
  if (code === 0 && out) return { ok: true, bytes: out };
  const bad = errs.some((s) => /invalid password/i.test(s));
  return { ok: false, badPassword: bad, error: errs.join('; ') };
}

/**
 * The file, locked. One password for reading and for owning alike -- two tiers of secret on one
 * document is a distinction this editor does not sell.
 * 这份文件,上锁。阅读与所有用同一个密码 —— 在一份文档上卖两层秘密,
 * 不是这个编辑器做的生意。
 */
export async function encrypt(bytes, password) {
  const { code, out, errs } = await run(
    ['--encrypt', password, password, '256', '--'],
    bytes,
  );
  if (code === 0 && out) return { ok: true, bytes: out };
  return { ok: false, error: errs.join('; ') };
}
