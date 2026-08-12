// API wrapper: one place for error handling; a 401 sends the user to the sign-in page
// API 封装:统一错误处理;401 时跳登录

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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
    throw new ApiError(res.status, data?.error || `请求失败(${res.status})`);
  }
  return data;
}
