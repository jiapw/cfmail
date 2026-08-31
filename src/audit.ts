// Audit trail for sensitive administrator actions. Writing never throws -- failing to record a log line should not fail the operation itself.
// 管理员敏感操作审计。写入永不抛错 —— 记不上日志不该把正常操作也一起弄失败。
import type { Env, User } from './types';
import { now, uid } from './util';

/** Audit action names, listed in one place so nobody typos a string literal somewhere else.
 *  审计动作名。集中列出来,免得各处拼字符串拼出错别字 */
export type AuditAction =
  | 'mailbox.create' | 'mailbox.update' | 'mailbox.purge' | 'mailbox.delete'
  | 'mailbox.login_create' | 'mailbox.login_reset'
  | 'alias.create' | 'alias.delete'
  | 'grant.add' | 'grant.remove'
  | 'user.status' | 'user.delete' | 'user.logout_all' | 'user.impersonate' | 'user.impersonate_end'
  | 'invite.create' | 'invite.revoke'
  | 'domain.create' | 'domain.admin_add' | 'domain.admin_remove'
  | 'brand.update'
  | 'chat.settings'
  | 'drive.settings' | 'drive.quota' | 'drive.versioning'
  | 'mail.import' | 'mail.export'
  | 'backup.settings' | 'backup.run'
  | 'unrouted.view' | 'unrouted.delete';

export async function audit(
  env: Env,
  actor: User | null,
  action: AuditAction,
  target?: string,
  detail?: Record<string, unknown>,
  domainId?: string | null
): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO audit_log (id, at, actor_id, actor_email, domain_id, action, target, detail) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)'
    )
      .bind(
        uid(), now(), actor?.id || null, actor?.email || null, domainId || null,
        action, target ? String(target).slice(0, 200) : null,
        detail ? JSON.stringify(detail).slice(0, 2000) : null
      )
      .run();
  } catch {
    // A failed audit write must not break the main flow
    // 审计写失败不影响主流程
  }
}
