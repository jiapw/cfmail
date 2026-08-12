// Workers AI provider factory.
// In local dev the AI binding goes through wrangler's remote proxy, which in practice returns
// "internal error;reference=..." (the same account and model over plain REST works fine). So when
// .dev.vars supplies AI_DEV_API_TOKEN we switch to REST; production leaves those two unset and
// always uses the native binding, which needs no credentials at all.
// Workers AI provider 工厂。
// 本地 dev 的 AI binding 走 wrangler 远程代理,实测会报 "internal error;reference=..."
// (REST 直连同账号同模型正常)。所以 .dev.vars 配置了 AI_DEV_API_TOKEN 时改走 REST;
// 生产不配置这两个变量,一律用原生 binding(无需任何凭证)。
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../types';

export type WorkersAI = ReturnType<typeof createWorkersAI>;

export function getWorkersAI(env: Env): WorkersAI {
  if (env.AI_DEV_API_TOKEN && env.AI_DEV_ACCOUNT_ID) {
    return createWorkersAI({ accountId: env.AI_DEV_ACCOUNT_ID, apiKey: env.AI_DEV_API_TOKEN });
  }
  return createWorkersAI({ binding: env.AI });
}
