# CFMail — Enterprise Webmail on Cloudflare / 基于 Cloudflare 的企业 Webmail

Run your company's email on your own Cloudflare account. Receiving, storage, the web client and the optional AI assistant all live inside **your** account — nothing is hosted by anyone else.

把公司的邮件系统跑在**你自己的** Cloudflare 账号里。收信、存储、网页客户端、可选的 AI 助手,全部在你的账号内,没有任何一部分托管在别人那里。

MIT licensed ([LICENSE](LICENSE)). Data-flow and privacy details in [PRIVACY.md](PRIVACY.md).
MIT 授权,数据流与隐私说明见 [PRIVACY.md](PRIVACY.md)。

> **No telemetry, no phone-home, no license server.** Grep the source and see for yourself.
> **没有遥测、没有回家调用、没有 License 校验服务器。** 可以全文搜索验证。

---

## What you get / 功能

- **Multi-domain webmail / 多域名企业邮箱** — one deployment serves any number of company domains, each with its own branding and theme.
  一次部署服务任意多个公司域名,每个域名有独立的品牌和主题。
- **Gmail-style client / Gmail 风格客户端** — threaded conversations, full-text search, folders, starring, batch actions, drag-and-drop attachments, rich-text composer.
  会话聚合、全文搜索、文件夹、星标、批量操作、拖拽附件、富文本编辑器。
- **Shared mailboxes / 共享邮箱** — one mailbox can be granted to several people (owner / member / read-only).
  一个邮箱可授权给多人(所有者 / 成员 / 只读)。
- **Invite-based signup / 邀请制注册** — admins generate a link, colleagues register themselves with email verification.
  管理员生成链接,同事自助注册并验证邮箱。
- **Admin console / 管理后台** — per-domain stats, mailbox and alias management, branding, unrouted-mail inspection, audit log.
  分域名统计、邮箱与别名管理、品牌设置、未匹配来信查看、审计日志。
- **Migration tools / 迁移工具** — import `.eml` from Zoho / Outlook / anywhere, export mailboxes back to a local folder. Includes a PowerShell script that pulls a Microsoft 365 mailbox via Graph.
  从 Zoho / Outlook 等导入 `.eml`,也能把邮箱导出回本地。附带一个用 Graph 拉取 Microsoft 365 邮箱的 PowerShell 脚本。
- **Optional AI assistant / 可选 AI 助手** — runs on Workers AI, off by default, per-domain switch.
  跑在 Workers AI 上,默认关闭,按域名开关。
- **9 UI languages / 9 种界面语言**, 30 built-in themes, light/dark/auto.
  30 套内置主题,明暗自动切换。

---

## Requirements / 前置条件

| | EN | 中文 |
|---|---|---|
| **Cloudflare account** | Domains must use **Cloudflare DNS** (full zone). Email Routing does not work on partial/CNAME setups | 域名必须用 **Cloudflare DNS**(完整 zone)。Email Routing 不支持 partial/CNAME 接入 |
| **Workers plan** | The free plan runs everything except sending to outside recipients — see below | 免费版能跑起全部功能,唯独对外发信不行 —— 见下表 |
| **Node.js** | 18 or newer, to run `wrangler` and the setup scripts | 18 以上,用来跑 `wrangler` 和配置脚本 |

### Free plan vs paid / 免费版够不够

| Component / 组成 | Workers Free | Notes / 说明 |
|---|---|---|
| Receiving mail (Email Routing) / 收信 | ✅ Free, unlimited / 免费无限 | |
| Web client, API, D1, R2 / 网页端、API、D1、R2 | ✅ Generous free tier / 免费额度很宽 | D1 5 GB, R2 10 GB |
| AI assistant (Durable Objects) / AI 助手 | ✅ Works / 可用 | [SQLite-backed DOs run on the free plan](https://developers.cloudflare.com/durable-objects/platform/limits/) — this project uses those / 本项目正是这种 |
| **Sending to outside recipients / 发信给外部收件人** | ❌ **Needs Workers Paid / 需要付费版** | [Email Sending requires the paid plan](https://developers.cloudflare.com/email-service/platform/pricing/) for arbitrary recipients / 发给任意收件人要求付费版 |

Internal mail and receiving work on the free plan. To send to the outside world you need **Workers Paid ($5/mo, 3,000 emails included)** — or plug in SES / Resend and stay free. Rough cost for a small team: **$5/month** plus R2 overage beyond 10 GB ($0.015/GB·month). Mail between mailboxes in the same deployment never touches a sending provider and is not billed.

收信和站内互发在免费版上完全可用。要给外部世界发信,需要 **Workers 付费版(每月 $5,含 3000 封)** —— 或者改接 SES / Resend,继续留在免费版。小团队大致成本:**每月 $5**,加上 R2 超过 10 GB 的部分。同一部署内邮箱之间的往来邮件不走发信通道,不计费。

---

## Quick start / 快速开始

```bash
git clone <this repo> && cd cfmail
npm install                              # also syncs public/vendor/ from node_modules
cp wrangler.example.jsonc wrangler.jsonc # then fill in the <placeholders>
```

Create an API token (permissions below) and put it in `.env.deploy`:
创建 API Token(权限见下),写进 `.env.deploy`:

```bash
CLOUDFLARE_API_TOKEN=<your token>
CLOUDFLARE_ACCOUNT_ID=<your account id>
```

Create the resources and ship it:
创建资源并上线:

```bash
npx wrangler d1 create cfmail            # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create cfmail-raw
npm run migrate:remote
npm run deploy
```

Wire up each domain (once per domain):
接入域名(每个域名跑一次):

```bash
node scripts/setup-zone.mjs example.com
```

Open `https://<entry-subdomain>.<your-domain>` and create the first admin account. Done.
打开 `https://<入口子域>.<你的域名>`,创建第一个管理员账号。完成。

---

## API token permissions / API Token 权限

Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Custom token**.

### Required / 必需

| Scope | Permission | Access | Used for / 用来做什么 |
|---|---|---|---|
| Account | **Workers Scripts** | Edit | `wrangler deploy`, `wrangler secret put` |
| Account | **D1** | Edit | Create the database, run migrations / 建库、跑 migrations |
| Account | **Workers R2 Storage** | Edit | Create the bucket, store raw messages / 建桶、读写原始邮件 |
| Zone | **Zone** | Read | Look up zone ids by domain name / 按域名查 zone id |
| Zone | **DNS** | Edit | Bind the entry custom domain, publish mail records / 绑定入口自定义域、下发邮件记录 |
| Zone | **Email Routing Rules** | Edit | Enable Email Routing, point catch-all at the Worker / 启用 Email Routing、设 catch-all |
| Zone | **Workers Routes** | Edit | Attach custom domains to the Worker / 把自定义域挂到 Worker 上 |

### Optional / 可选

| Scope | Permission | Access | Needed when / 什么时候需要 |
|---|---|---|---|
| Account | **Workers AI** | Read | AI assistant, **local development only** — production uses the native binding / AI 助手,**仅本地开发**需要 |
| Account | **Turnstile Sites** | Edit | Running `scripts/setup-turnstile.mjs`. The dashboard calls it "Turnstile Sites" / Dashboard 里就叫这个名字 |
| Zone | **Zone WAF** | Edit | Running `scripts/push-ratelimit.mjs` |

> Set **Zone Resources to All zones**, or at least every domain you plan to connect — zone-level permissions are needed each time you add one. Permission changes take about a minute to apply; don't retry immediately.
>
> **Zone Resources 选 All zones**,或至少包含你要接入的全部域名。改完权限约 1 分钟生效,别急着重试。

---

## Deployment in detail / 部署细节

### 1. Configuration / 配置文件

`wrangler.jsonc` is **not** in the repository — it holds your account id, database id and domains. Copy the template and edit it.
`wrangler.jsonc` **不在仓库里** —— 它含你的 account_id、database_id 和域名。从模板复制一份再改。

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

### 2. Connect a domain / 接入域名

```bash
node scripts/setup-zone.mjs example.com
```

The script does three things: enables Email Routing (publishing MX/SPF), points the catch-all rule at the cfmail Worker, and binds `<entry-subdomain>.<domain>` as a custom domain.
脚本做三件事:启用 Email Routing(下发 MX/SPF)、把 catch-all 指向 cfmail Worker、绑定 `<入口子域>.<域名>` 自定义域。

> **Careful**: enabling Email Routing takes over that domain's MX records. If the domain already has mail service, confirm before switching.
> **注意**:启用 Email Routing 会接管该域名的 MX 记录。如域名原有邮件服务,切换前先确认。

### 3. Hardening / 加固(可选,但建议做)

```bash
node scripts/setup-turnstile.mjs   # create a Turnstile widget, secret goes into the Worker
node scripts/push-ratelimit.mjs    # push edge rate-limit rules to every zone
```

- **Turnstile** protects login, password reset and invite signup. The sitekey goes in `wrangler.jsonc` under `vars`, the secret via `wrangler secret`. **Both must be present for it to activate** — to disable in a hurry, delete `TURNSTILE_SITEKEY` and redeploy.
  保护登录、密码重置、邀请注册三处。**两者齐了才启用** —— 想紧急停用,删掉 `TURNSTILE_SITEKEY` 重新部署即可。
- **Rate limiting**: 5 requests / 10 s per IP on the auth endpoints. The free plan allows one rule per zone with a fixed 10-second window; the script is written to that constraint.
  认证接口每 IP 5 次/10 秒。免费版每 zone 只允许 1 条规则、窗口固定 10 秒,脚本已按这个限制写好。

---

## Day-to-day operation / 日常使用

### As an administrator / 管理员

Open `https://<entry-subdomain>.<your-domain>/#/admin`.

| Tab | What it does / 能做什么 |
|---|---|
| **Overview / 总览** | Per-domain mailbox counts, message counts, storage, last activity / 分域名的邮箱数、邮件数、存储量、最后活动时间 |
| **Domains & mailboxes / 域名与邮箱** | Add domains, create mailboxes and aliases, grant access, set branding. Also **erase a mailbox's contents** or **delete a mailbox** outright / 添加域名、建邮箱和别名、授权成员、设品牌。也可**清空邮箱内容**或**注销整个邮箱** |
| **Users / 用户** | All registered users, revoke sessions everywhere, delete accounts / 全部用户、撤销所有设备登录、注销账号 |
| **Invites / 邀请** | Generate signup links. Two independent choices: pin the mailbox name (or let the invitee pick), and pin who may use the link / 生成注册链接。两个独立选项:限不限定邮箱名、限不限定使用者 |
| **Unrouted / 未匹配来信** | Mail sent to addresses that don't exist. Remote images stripped before display / 发给不存在地址的邮件,展示前剥掉远程图片 |
| **Import / 导入工具** | Bring in `.eml` archives from an old provider / 把旧服务商导出的 `.eml` 搬进来 |
| **Export / 导出工具** | Write mailboxes back out to a local folder as `.eml` / 把邮箱写回本地目录 |
| **Audit log / 审计日志** | Who did what, downloadable as CSV or JSONL / 谁做了什么,可下载 CSV 或 JSONL |
| **AI assistant / AI 助手** | Per-domain switch, model selection, internet access toggle / 按域名开关、挑模型、联网开关 |

### As a user / 普通用户

Sign in with **either** the personal email used at signup **or** a company address you own — both share one password.
用**注册时的个人邮箱**或**你作为所有者的企业邮箱**登录都行 —— 两者共用同一个密码。

Beyond ordinary mail: full-text search, conversation threading, rich-text composing with client-side image resizing, per-user interface and body fonts, light/dark/auto, 9 interface languages.
除常规收发外:全文搜索、会话聚合、富文本编辑(图片在浏览器端缩放)、每用户可选字体、明暗自动、9 种界面语言。

### Adding people / 加人进来

1. Admin console → **Invites** → generate a link / 管理后台 → **邀请** → 生成链接
2. Send the link to your colleague / 把链接发给同事
3. They set a password, confirm a code sent to their personal email, and they're in / 对方设密码、输入发到其个人邮箱的验证码,就进来了

---

## Local development / 本地开发

```bash
npm install          # also syncs third-party browser libraries into public/vendor/
npm run migrate:local
npm run dev          # http://127.0.0.1:8787
```

> `public/vendor/` (Web Awesome / Quill / postal-mime) is synced from `node_modules` and **is not committed**. `npm install` syncs it; after upgrading dependencies run `npm run vendor`.
> `public/vendor/` 从 `node_modules` 同步而来,**不入库**。`npm install` 会自动同步;升级依赖后手动跑 `npm run vendor`。
>
> `npm run dev` and `npm run deploy` verify it first and stop if anything is missing — don't bypass with `npx wrangler deploy`, you may ship a site with no frontend libraries.
> 两个命令都会先校验,缺文件会直接停下 —— 别用 `npx wrangler deploy` 绕过。
>
> **postal-mime must be the same version on both sides**: the Worker bundles it from `node_modules`, the browser loads `public/vendor/`. A version drift misaligns attachment `part_index`. Generating both from one `node_modules` is why vendor isn't committed.
> **postal-mime 必须两端同版本**:Worker 侧从 `node_modules` 打包,浏览器侧用 `public/vendor/`。版本漂移会让附件的 `part_index` 错位 —— 这是不把 vendor 入库的主要原因。

There is no real inbound path locally, so inject messages directly (needs `DEV_MODE=1` in `.dev.vars`):
本地没有真实收信入口,用注入接口模拟(需 `.dev.vars` 里 `DEV_MODE=1`):

```bash
curl -X POST --data-binary @test.eml "http://127.0.0.1:8787/api/dev/ingest?rcpt=you@example.com&from=someone@example.com"
```

Trigger cron by hand (outbound queue, retries, cleanup):
手动触发 cron(发件队列、重试、清理):

```bash
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

---

## Architecture / 架构

```
sender's MTA ──MX──▶ Email Routing (catch-all) ──▶ Email Worker
对方邮件服务器                                        │  raw .eml → R2
                                                     │  metadata/FTS → D1
browser ◀──HTTPS──▶ Worker (static SPA + Hono API) ──▶ D1 / R2
用户浏览器                    │
                              ├─ local recipient: delivered directly, never leaves CF
                              │  站内收件人:直接投递,不出 CF
                              └─ outside recipient: outbox table → cron → CF Email Sending / SES / Resend
                                 外部收件人:outbox 表 → cron → 发信通道
```

- One Worker, three entry points: `fetch` (site + API), `email` (inbound), `scheduled` (every minute: send queue, parse retries, cleanup).
  一个 Worker,三个入口:`fetch`、`email`、`scheduled`(每分钟:发件队列 / 解析重试 / 清理)。
- Storage: one D1 database (accounts, permissions, message metadata, FTS5 index, audit log), one R2 bucket (raw MIME, attachments, uploads, font cache).
  存储:D1 一个库,R2 一个桶。
- No Queues — an outbox table plus Cron is simpler at this scale. The AI assistant uses one Durable Object per chat session.
  不用 Queues,当前量级 outbox 表 + Cron 更简单。AI 助手每个会话一个 Durable Object。
- **IMAP-ready schema**: `folders` carry `uidvalidity`/`uidnext`, `messages` carry a per-folder monotonic `uid` and standard IMAP flags. Adding an IMAP gateway later needs no data migration.
  **数据模型 IMAP-ready**,将来加 IMAP 网关不用迁数据。

### Account model / 账号模型

```
users (sign up with an existing personal email) ──▶ grants (owner/member/readonly) ──▶ mailboxes ──▶ domains
users(用既有个人邮箱注册)                            grants(所有者/成员/只读)
```

- One user can hold several company mailboxes; one mailbox can be shared with several users.
  一个用户可挂多个企业邮箱;一个邮箱可授权多人。
- Login identifier is the signup email **or** a company address you own — one password either way.
  登录标识符 = 注册邮箱**或**本人作为所有者的企业邮箱,共用同一份密码。
- One global admin (created at setup) plus per-domain admins.
  一个全局管理员 + 每域名的域管理员。

---

## Sending mail / 发信通道

`MAIL_PROVIDER` accepts `cf` / `ses` / `resend` / `dev` (`dev` never sends externally; internal delivery always works).
`MAIL_PROVIDER` 支持 `cf` / `ses` / `resend` / `dev`(`dev` 不真实外发,站内互发始终可用)。

### Cloudflare Email Sending (default, public beta) / 默认通道

- Already wired via the `send_email` binding — no keys needed. / 已配好 binding,零密钥。
- Each sending domain must be onboarded once: Dashboard → **Compute → Email Service → Email Sending → Onboard Domain**. DKIM/SPF/DMARC and bounce records publish automatically.
  每个发信域名需在该处点一次,DKIM/SPF/DMARC 和退信记录自动下发。
- Billing: 3,000 messages/month included with Workers Paid, then $0.35 per thousand. / 付费版含 3000 封/月,超出 $0.35/千封。
- Limits: 5 MiB per message, 50 recipients per message. / 单封 5 MiB、50 收件人/封。
- Beta caveat: no SLA. The outbox retries with exponential backoff and, on partial failure, re-sends only to the remaining recipients — never duplicates.
  Beta 无 SLA。outbox 自带指数退避重试,部分失败时只补发剩余的,不重复投递。

### Amazon SES (~$0.10 per thousand) / 约 $0.10/千封

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put AWS_REGION            # e.g. us-east-1
# set MAIL_PROVIDER to "ses" in wrangler.jsonc and redeploy
```

On the SES side: verify each sending domain (three Easy DKIM CNAMEs), configure a custom MAIL FROM subdomain for SPF alignment, and request production access. Start DMARC at `p=none`.
SES 侧:验证每个发信域名、配置自定义 MAIL FROM 子域(SPF 对齐)、申请移出沙箱。DMARC 建议从 `p=none` 起步。

### Resend

```bash
npx wrangler secret put RESEND_API_KEY
# set MAIL_PROVIDER to "resend", verify your domains in Resend
```

Both are implemented in `src/send.ts`; switching is a config change.
两个通道都已实现,改配置即可切换。

---

## AI assistant (optional) / AI 助手(可选)

Runs on Workers AI. **Off by default**, enabled per domain in the admin console along with which models are offered.
跑在 Workers AI 上。**默认关闭**,在管理后台按域名启用并挑选可用模型。

- It can only read mailboxes **the signed-in user already has access to**. Admins cannot use it to read other people's mail — that is a deliberate design line.
  只能读**当前登录用户已有权限的**邮箱。管理员无法借它读别人的邮件 —— 这是有意的设计红线。
- **Internet access is off by default.** Turning it on gives the model `web_search` / `open_url`; queries are written by the model from conversation content and sent to a search engine (Brave if you supply a key, otherwise DuckDuckGo). This is the only feature that sends mail-derived content to a third party.
  **联网能力默认关闭。** 打开后模型才有 `web_search` / `open_url`,搜索词由模型根据对话内容生成并发往搜索引擎。这是唯一会把邮件衍生内容发给第三方的功能。
- Cloudflare states it [does not train models on customer content](https://developers.cloudflare.com/workers-ai/platform/data-usage/).
  Cloudflare 声明不使用客户内容训练模型。

**Local development note**: `wrangler dev`'s remote AI binding proxy returns `internal error`, so locally the code falls back to REST — set `AI_DEV_ACCOUNT_ID` and `AI_DEV_API_TOKEN` in `.dev.vars`. Production uses the native binding and is unaffected.
**本地开发注意**:`wrangler dev` 的远程 AI binding 代理会报 `internal error`,所以本地改走 REST。线上用原生 binding,不受影响。

---

## Migration and admin tools / 迁移与管理工具

- **Import / 导入** — point it at a folder of `.eml` files. Parsing happens entirely in the browser, so it costs no Worker CPU. Ships with [Export-Mailbox.ps1](public/tools/Export-Mailbox.ps1), a PowerShell script that pulls a Microsoft 365 mailbox through Graph (read-only scopes, resumable, 9 languages).
  指向一个装着 `.eml` 的目录。解析全在浏览器做,不烧 Worker CPU。附带用 Graph 只读权限拉取 Microsoft 365 邮箱的 PowerShell 脚本(可断点续传)。
- **Export / 导出** — writes selected mailboxes to a local folder as `<address>/<folder>/*.eml`. The server never builds an archive.
  把选中邮箱写成 `<邮箱地址>/<文件夹>/*.eml` 落到本地目录。服务端不打包。
- **Audit log / 审计日志** — mailbox creation and deletion, erasure, export, session revocation, unrouted-mail viewing. Downloadable as CSV or JSONL.
  建删邮箱、清空、导出、撤销登录、查看未匹配来信等,可下载 CSV / JSONL。
- **Mailbox lifecycle / 邮箱生命周期** — erase a mailbox's contents, or delete it together with its owner account.
  清空某个邮箱的内容,或连同所有者账号一起注销。

Command-line import / 命令行导入:
`node scripts/import-eml.mjs --dir <folder> --mailbox <address> --cookie "sid=..."`

---

## Security and privacy / 安全与隐私

- Passwords: PBKDF2-SHA256, 100,000 iterations (the Workers ceiling). Sessions are random 32-byte tokens stored as SHA-256 hashes; cookies are `httpOnly` + `secure` + `SameSite=Lax`.
  密码 PBKDF2-SHA256 十万轮。会话是 32 字节随机 token,库里只存 SHA-256。
- Message bodies render in a sandboxed iframe with no script execution; untrusted senders additionally get a CSP that blocks every remote subresource, so remote images cannot phone home.
  正文在沙箱 iframe 里渲染,不执行脚本;不可信发件人另加 CSP 掐断全部远程子资源。
- Attachments use a strict inline whitelist — only raster images and PDF render in-browser, everything else downloads. SVG and HTML attachments are never served inline (that would be same-origin XSS).
  附件走严格的内联白名单 —— 只有位图和 PDF 在浏览器里打开。SVG 和 HTML 绝不内联(那等于同源 XSS)。
- CSRF: `Origin` is checked fail-closed on every state-changing request.
  所有变更类请求校验 `Origin`,缺失也拒。
- **No IP addresses are logged** anywhere in the application layer.
  **应用层任何地方都不记录 IP。**
- Google Fonts are proxied **server-side** — the browser never contacts Google, so no visitor IP reaches them.
  Google Fonts 走**服务端代理**,浏览器从不直连,访客 IP 不会到达对方。

See [PRIVACY.md](PRIVACY.md) for exactly what data lives where and what can leave your account.
详见 [PRIVACY.md](PRIVACY.md)。

---

## Known limits / 已知边界

- Inbound messages cap at 25 MB (an Email Routing limit); larger mail bounces.
  入站单封上限 25MB,超限对方会收到退信。
- Outbound caps at 3.6 MB — derived from Cloudflare's 5 MiB hard limit and base64's ~1.37× expansion. Over-sized mail fails to send but still saves as a draft.
  外发单封上限 3.6MB。超限只在发送时报错,草稿照常保存。
- Webmail only. No IMAP/POP/SMTP client access yet — the schema is ready for it.
  纯 webmail,暂无 IMAP/POP/SMTP 客户端接入。
- Trash and spam self-purge after 30 days; temporary uploads after 48 hours. **Regular mail is never auto-deleted** — an admin has to do it explicitly.
  回收站和垃圾邮件 30 天后自动清空,临时上传 48 小时清理。**正文邮件不会自动删除。**
- CJK search uses LIKE, Latin search uses FTS5.
  中日韩搜索走 LIKE,拉丁文走 FTS5。
- The export tool needs the File System Access API — Chrome or Edge only.
  导出工具依赖 File System Access API,只支持 Chrome / Edge。

---

## Interface and themes / 界面与主题

- Components are Web Awesome v3.11 (Web Components), self-hosted in `public/vendor/wa/` and synced by `scripts/sync-vendor.mjs`. Icons are a hand-built set in `public/assets/icons.js` — no Font Awesome icon assets are involved.
  控件层是 Web Awesome v3.11,自托管并由脚本同步。图标是自建的,不涉及 Font Awesome 的图标资源。
- Themes: `node scripts/build-themes.mjs` generates 30 light/dark pairs from `@radix-ui/colors`. Edit the script, not the output.
  主题由脚本从 `@radix-ui/colors` 生成 30 套明暗成对。改脚本,别改产物。
- Domain admins pick a theme per domain; users pick light/dark/auto and their own interface and body fonts.
  域管理员按域名选主题;用户自己选明暗和字体。
- Interface strings live in `public/assets/i18n.js` — all 9 dictionaries must stay in sync.
  界面文案在 `public/assets/i18n.js`,9 套词典需同步维护。

---

## Versioning and release / 版本与发布

`major.feature.fix`. The current version lives in `src/version.ts` and shows up in the account menu and settings page. Bump it before each deploy.
规则 `主版本.功能.修复`。当前版本在 `src/version.ts`,每次部署前更新。

Release checklist / 发布清单: edit code → run `build-themes.mjs` if themes changed → `npm run typecheck` → `npm run migrate:remote` if there are new migrations → `npm run deploy`.

## Layout / 目录结构

```
migrations/                    # D1 schema, applied in order / D1 schema,按序号递增
src/
  index.ts                     # fetch / email / scheduled entry points / 三入口
  api.ts                       # application API (Hono) / 业务 API
  admin.ts                     # admin API: stats, members, invites, export, audit / 管理后台 API
  auth.ts                      # sessions, PBKDF2 passwords, CSRF / 会话、密码、CSRF
  audit.ts                     # admin action audit trail / 管理员操作审计
  parse.ts                     # inbound parsing and storage / 收信解析入库
  send.ts                      # send pipeline + CF/SES/Resend/dev / 发送管道
  mime.ts                      # outbound MIME building / 出站 MIME 构建
  fonts.ts                     # server-side Google Fonts proxy / 字体服务端代理
  chat/                        # AI assistant (Durable Object + tools) / AI 助手
public/                        # Gmail-style SPA, no bundler / 无打包无转译
  vendor/                      # third-party browser libs, not committed / 不入库
  tools/Export-Mailbox.ps1     # Microsoft 365 mailbox exporter / M365 导出脚本
scripts/
  sync-vendor.mjs              # sync public/vendor/ from node_modules (postinstall)
  wrangler-config.mjs          # reads wrangler.jsonc, feeds domains/zones to other scripts
  setup-zone.mjs               # connect a domain / 域名一键接入
  setup-turnstile.mjs          # create the Turnstile widget / 建 Turnstile widget
  push-ratelimit.mjs           # push edge rate-limit rules / 推限速规则
  build-themes.mjs             # generate themes / 生成主题
  import-eml.mjs               # command-line import / 命令行导入
```

## License / 许可

MIT — see [LICENSE](LICENSE). Third-party components and their notices are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
MIT,第三方组件及其声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
