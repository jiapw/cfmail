export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  ASSETS: Fetcher;
  AI: Ai;
  CHAT_AGENT: DurableObjectNamespace;
  EMAIL?: { send(message: unknown): Promise<unknown> }; // Cloudflare Email Sending binding
  MAIL_PROVIDER: string; // dev | cf | ses | resend
  APP_ORIGIN: string;
  DEV_MODE: string;
  // ses
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  // resend
  RESEND_API_KEY?: string;
  // Turnstile: enabled only when both the sitekey (public, in vars) and the secret (a wrangler secret) are present
  // Turnstile 人机验证:sitekey(vars,公开)+ secret(wrangler secret)都配置才启用
  TURNSTILE_SITEKEY?: string;
  TURNSTILE_SECRET?: string;
  // Local dev only (.dev.vars): when set, AI calls go over REST, sidestepping the internal error from wrangler's AI binding proxy
  // 仅本地 dev(.dev.vars):配置后 AI 调用走 REST,绕开 wrangler AI binding 代理的 internal error
  AI_DEV_ACCOUNT_ID?: string;
  AI_DEV_API_TOKEN?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  is_admin: number;
  disabled: number;
  /** Set when a global administrator opened this session as this user / 全局管理员以此人身份打开会话时,记下那位管理员 */
  impersonator_id?: string | null;
}

export interface Mailbox {
  id: string;
  domain_id: string;
  local_part: string;
  display_name: string;
  disabled: number;
  domain_name?: string;
}

export interface Addr {
  name: string;
  addr: string;
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash' | 'archive';
export const FOLDER_ROLES: { role: FolderRole; name: string }[] = [
  { role: 'inbox', name: 'INBOX' },
  { role: 'sent', name: 'Sent' },
  { role: 'drafts', name: 'Drafts' },
  { role: 'spam', name: 'Spam' },
  { role: 'trash', name: 'Trash' },
  { role: 'archive', name: 'Archive' },
];
