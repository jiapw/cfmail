import type { Env } from './types';
import { app } from './api';
import { backupTick } from './backup';
export { ChatAgent } from './chat/agent';
// The container's Durable Object class, likewise -- a binding names a class the
// entry module must actually export.
// 容器那个 Durable Object 类同理 —— 绑定点的名字,入口模块必须真的导出。
export { BackupContainer } from './backup';
import { backfillContacts, backfillSubjectNorm, findMailboxByAddress, ingestEml, insertFailedPlaceholder, logUnrouted, purgeOldUnrouted, retryFailedParses, deleteMessageDerived } from './parse';
import { driveCronDaily, driveCronHourly } from './drive';
import { processOutbox } from './send';
import { now, uid } from './util';

async function handleEmail(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
  const mb = await findMailboxByAddress(env, message.to);
  if (!mb || mb.disabled) {
    // The recipient belongs to no mailbox or alias in this domain: still refuse it (the sender gets a bounce), but keep a copy for administrators.
    // 收件地址不属于本域任何邮箱/别名:仍然拒收(发件人会收到退信),但留档供管理员查看
    try {
      const buf = await new Response(message.raw).arrayBuffer();
      const key = `unrouted/${uid()}.eml`;
      await env.RAW.put(key, buf);
      await logUnrouted(env, {
        toAddr: message.to,
        envelopeFrom: message.from,
        buf,
        r2Key: key,
        size: buf.byteLength,
      });
    } catch (e) {
      console.log('log unrouted failed', message.to, e);
    }
    message.setReject('550 5.1.1 No such recipient here');
    return;
  }
  const id = uid();
  const key = `raw/${id}.eml`;
  const buf = await new Response(message.raw).arrayBuffer();
  await env.RAW.put(key, buf);
  try {
    await ingestEml(env, {
      mailboxId: mb.id,
      buf,
      r2Key: key,
      size: buf.byteLength,
      folderRole: 'inbox',
      direction: 'in',
      envelopeFrom: message.from,
    });
  } catch (e) {
    console.log('parse failed, placeholder saved', key, e);
    await insertFailedPlaceholder(env, { mailboxId: mb.id, r2Key: key, size: buf.byteLength, envelopeFrom: message.from });
  }
}

async function runCron(env: Env): Promise<void> {
  await processOutbox(env);
  // Its own slice of work every minute; idle unless a run is going or it is time to start one
  // 每分钟一个切片;没有正在进行的运行、也不到点时是空转
  await backupTick(env).catch(() => {});
  await retryFailedParses(env);
  await backfillSubjectNorm(env);
  await backfillContacts(env);

  const d = new Date();
  if (d.getUTCMinutes() === 0) {
    // Hourly: drop expired sessions and uploads older than 48h. Expired invites need no cleanup -- they are judged by state.
    // 每小时:清理过期会话、过期邀请无需清理(状态判断),超 48h 的临时上传
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now()).run();
    const olds = await env.DB.prepare('SELECT id, r2_key FROM uploads WHERE created_at < ?1 LIMIT 100')
      .bind(now() - 48 * 3600 * 1000).all<any>();
    for (const u of olds.results || []) {
      await env.RAW.delete(u.r2_key).catch(() => {});
      await env.DB.prepare('DELETE FROM uploads WHERE id=?1').bind(u.id).run();
    }
    // Drive: abort multipart uploads that never completed
    // 网盘:中止一直没完成的分片上传
    await driveCronHourly(env);

    // Daily at 19:00 UTC: empty trash and spam older than 30 days
    // 每天(UTC 19 点 = 北京时间凌晨 3 点):清空 30 天前的垃圾箱/垃圾邮件
    if (d.getUTCHours() === 19) {
      const rows = await env.DB.prepare(
        `SELECT m.id, m.r2_key FROM messages m JOIN folders f ON f.id=m.folder_id
         WHERE f.role IN ('trash','spam') AND m.internal_date < ?1 LIMIT 200`
      ).bind(now() - 30 * 24 * 3600 * 1000).all<any>();
      const ids = (rows.results || []).map((r: any) => r.id);
      if (ids.length) {
        await deleteMessageDerived(env, ids);
        for (const r of rows.results || []) {
          await env.DB.prepare('DELETE FROM messages WHERE id=?1').bind(r.id).run();
          await env.RAW.delete(r.r2_key).catch(() => {});
        }
      }
      // Keep finished/failed outbox rows for 90 days
      // 已完成/失败的 outbox 记录保留 90 天
      await env.DB.prepare("DELETE FROM outbox WHERE status IN ('sent','failed') AND created_at < ?1")
        .bind(now() - 90 * 24 * 3600 * 1000).run();
      await purgeOldUnrouted(env);
      // Drive: trash older than 30 days goes away for good
      // 网盘:回收站超过 30 天的内容彻底清除
      await driveCronDaily(env);
    }
  }
}

export default {
  fetch: app.fetch,
  email: handleEmail,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
