// API wrapper: one place for error handling; a 401 sends the user to the sign-in page
// API 封装:统一错误处理;401 时跳登录
import { tErr } from './i18n.js';

export class ApiError extends Error {
  /**
   * @param status HTTP status
   * @param code   the e_* code the server returned, kept for callers that branch on it
   * @param args   values to splice into the message
   * message is already translated -- the server only ever sends codes.
   * message 是翻译好的文本;服务端只回码,不回句子。code 保留下来,方便调用方按错误类型分支。
   */
  constructor(status, code, args = []) {
    super(tErr(code, args));
    this.status = status;
    this.code = code;
    this.args = args;
  }
}

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const res = await fetch(path, opts);
  let data = null;
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !location.hash.startsWith('#/login') && !location.hash.startsWith('#/invite')) {
      window.dispatchEvent(new CustomEvent('cfmail:unauthorized'));
    }
    // No code at all (a proxy error page, say) still has to say something sensible.
    // 完全拿不到码时(比如被中间层挡下返回了错误页),也得给出一句像样的提示。
    if (!data?.error) throw new ApiError(res.status, 'e_request_failed', [res.status]);
    throw new ApiError(res.status, data.error, data.args || []);
  }
  return data;
}
