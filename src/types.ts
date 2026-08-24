export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  /** Automatic backup target; absent on a deployment that predates it / 自动备份的去处;早于这个功能的部署上没有它 */
  BACKUP?: R2Bucket;
  /** The container the backup job runs in; absent when the deployment was made without Docker
   *  跑备份任务的容器;部署时没有 Docker 的话不存在 */
  BACKUP_CONTAINER?: DurableObjectNamespace<import('./backup').BackupContainer>;
  /** One API token, doing two jobs: bearer for D1's export, and (id, sha256(value)) as R2's
   *  S3 key pair. Set as wrangler secrets by the deploy script.
   *  一个 API token 干两件事:D1 导出的 bearer,以及 (id, sha256(value)) 作为 R2 的 S3 密钥对。
   *  由部署脚本设成 wrangler secret。 */
  BACKUP_TOKEN_ID?: string;
  BACKUP_TOKEN_VALUE?: string;
  CF_ACCOUNT_ID?: string;
  CF_D1_DATABASE_ID?: string;
  R2_RAW_BUCKET?: string;
  R2_BACKUP_BUCKET?: string;
  SEVENZ_LEVEL?: string;
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

/**
 * What a mailbox owner has said about a correspondent. Three named states, none of them derived:
 * a stranger is unknown until somebody says otherwise, and risk is a judgement made on purpose.
 * Only 'trusted' loads remote images by itself.
 * 邮箱主人对某位往来对象的看法。三个有名字的状态,都不靠推导:
 * 陌生人在有人开口之前就是未知,而隐患是有人特意下的判断。只有 trusted 会自动加载远程图片。
 */
export type Trust = 'trusted' | 'unknown' | 'risk';
export const TRUSTS: Trust[] = ['trusted', 'unknown', 'risk'];
/** Anything unrecognised is unknown -- an unreadable stored value must not read as trusted
 *  认不出来的一律当未知 —— 存坏的值绝不能被读成可信 */
export const pickTrust = (v: unknown): Trust =>
  (TRUSTS as string[]).includes(String(v)) ? (String(v) as Trust) : 'unknown';

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash' | 'archive';
export const FOLDER_ROLES: { role: FolderRole; name: string }[] = [
  { role: 'inbox', name: 'INBOX' },
  { role: 'sent', name: 'Sent' },
  { role: 'drafts', name: 'Drafts' },
  { role: 'spam', name: 'Spam' },
  { role: 'trash', name: 'Trash' },
  { role: 'archive', name: 'Archive' },
];
