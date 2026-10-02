// Turnstile, in a module of its own so that more than one door can ask it. It used to live in
// api.ts beside the three sign-in endpoints that were its only callers; the guest door of a
// meeting is a fourth, and it cannot import api.ts without importing the whole application.
// Turnstile 单独成模块,好让不止一扇门能来问它。它原本住在 api.ts 里,挨着仅有的三个调用方
// (登录那几个端点);会议的访客入口是第四个,而它若去 import api.ts,就等于 import 了整个应用。
import type { Env } from './types';

// ---------- Turnstile human verification ----------
// ---------- Turnstile 人机验证 ----------

/** Active only when the sitekey and the secret are both configured; missing either turns it off entirely (the frontend renders nothing, the backend lets requests through)
 *  sitekey 和 secret 都配置了才启用;少任何一个都整体关闭(前端不渲染、后端放行) */
export function turnstileEnabled(env: Env): boolean {
  return !!(env.TURNSTILE_SITEKEY && env.TURNSTILE_SECRET);
}

/**
 * Validate the turnstile token supplied by the frontend. When the feature is off, everything
 * passes. When it is on, a missing token, a failed siteverify, or an unreachable siteverify all
 * count as a failure (fail-closed).
 * Tokens are single-use and valid for 5 minutes; after a 403 the frontend must reset the widget and fetch a new one.
 * 校验前端带来的 turnstile token。未启用直接放行;启用时无 token、
 * siteverify 不通过、或 siteverify 不可达,一律算不过(fail-closed)。
 * token 一次性,5 分钟内有效;前端在收到 403 后需 reset widget 重新取。
 */
export async function verifyTurnstile(env: Env, token: unknown, ip?: string): Promise<boolean> {
  if (!turnstileEnabled(env)) return true;
  const t = String(token || '');
  if (!t || t.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: t });
  if (ip) form.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const j: any = await res.json();
    return !!j?.success;
  } catch {
    return false;
  }
}
