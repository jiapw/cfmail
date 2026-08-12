# CFMail — Enterprise Webmail on Cloudflare / 基于 Cloudflare 的企业 Webmail

Run your company's email on your own Cloudflare account. Receiving, storage and the web client all live inside **your** account — nothing is hosted by anyone else.

把公司的邮件系统跑在**你自己的** Cloudflare 账号里。收信、存储、网页客户端,全部在你的账号内,没有任何一部分托管在别人那里。

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
- **Migration tools / 迁移工具** — import `.eml` from Zoho / Outlook / anywhere, export mailboxes back to a local folder. Includes a PowerShell script that pulls a Microsoft 365 mailbox via the Microsoft Graph API.
  从 Zoho / Outlook 等导入 `.eml`,也能把邮箱导出回本地。附带一个用 Microsoft Graph API 拉取 Microsoft 365 邮箱的 PowerShell 脚本。
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
| **Sending to outside recipients / 发信给外部收件人** | ❌ **Needs Workers Paid / 需要付费版** | [Email Sending requires the paid plan](https://developers.cloudflare.com/email-service/platform/pricing/) for arbitrary recipients / 发给任意收件人要求付费版 |

Internal mail and receiving work on the free plan. To send to the outside world you need **Workers Paid ($5/mo, 3,000 emails included)** — or plug in SES / Resend and stay free. **If you already pay for Cloudflare Workers, this adds no new subscription** — CFMail runs inside the plan you have. Rough cost for a small team starting fresh: **$5/month** plus R2 overage beyond 10 GB ($0.015/GB·month). Mail between mailboxes in the same deployment never touches a sending provider and is not billed.

收信和站内互发在免费版上完全可用。要给外部世界发信,需要 **Workers 付费版(每月 $5,含 3000 封)** —— 或者改接 SES / Resend,继续留在免费版。**如果你本来就在用 Cloudflare Workers 付费版,那么不会增加任何订阅费用** —— CFMail 跑在你已有的套餐里。从零开始的小团队大致成本:**每月 $5**,加上 R2 超过 10 GB 的部分。同一部署内邮箱之间的往来邮件不走发信通道,不计费。

---

## Quick start / 快速开始

Everything below is **shell commands** — type them in a terminal, one line at a time. They are written for bash/zsh (macOS, Linux, Git Bash, WSL) and work as-is in PowerShell too, except that Windows PowerShell 5.1 does not understand `&&` — run those two commands separately.

下面全部是**终端命令**,在命令行里一行一行敲。写法按 bash/zsh(macOS、Linux、Git Bash、WSL),PowerShell 里也能直接用,只有一点:Windows PowerShell 5.1 不认 `&&`,把那两条拆开分别执行。

```bash
git clone https://github.com/jiapw/cfmail.git
cd cfmail
npm install                              # also syncs public/vendor/ from node_modules
cp wrangler.example.jsonc wrangler.jsonc # then fill in the <placeholders>
```

> **What are `npx` and `wrangler`?** `npx` ships with Node.js (18+) — it runs a command-line tool out of `node_modules` without installing anything globally. `wrangler` is Cloudflare's official CLI; it is listed in this project's `devDependencies`, so `npm install` already put it there. That is why every command below is `npx wrangler …` and why there is nothing extra to install. First run may ask you to log in — you don't need to: the token in `.env.deploy` is what authenticates.
>
> **`npx` 和 `wrangler` 是什么?** `npx` 是 Node.js(18+)自带的命令,作用是直接运行 `node_modules` 里的命令行工具,不用全局安装。`wrangler` 是 Cloudflare 官方 CLI,已写在本项目的 `devDependencies` 里,`npm install` 时就装好了 —— 所以下面一律写成 `npx wrangler …`,不需要你另外装任何东西。首次运行它可能提示登录,不用管:认证走 `.env.deploy` 里的 token。

Create an API token (permissions below) and put it in `.env.deploy` — that is a plain text file you create in the project root, not a command:
创建 API Token(权限见下),写进 `.env.deploy` —— 这是你在项目根目录新建的一个纯文本文件,不是命令:

```ini
CLOUDFLARE_API_TOKEN=<your token>
CLOUDFLARE_ACCOUNT_ID=<your account id>
```

Load it into the current shell, then create the resources and ship it:
把它载入当前终端,然后创建资源并上线:

```bash
set -a && . ./.env.deploy && set +a       # PowerShell: Get-Content .env.deploy | %{ $k,$v = $_ -split '=',2; Set-Item "env:$k" $v }
npx wrangler d1 create cfmail             # paste the database_id it prints into wrangler.jsonc
npx wrangler r2 bucket create cfmail-raw
npm run migrate:remote
npm run deploy                            # first deploy has no domains yet — that is expected
```

Wire up each domain (once per domain). The second argument is the **entry subdomain** — the host people will actually visit:
接入域名(每个域名跑一次)。第二个参数是**入口子域**,也就是用户实际访问的那个主机名:

```bash
node scripts/setup-zone.mjs example.com mail    # -> https://mail.example.com
node scripts/setup-zone.mjs another.com         # reuses "mail", no need to repeat it
npm run deploy                                  # publish the routes the script just added
```

Open `https://mail.example.com` and create the first admin account. Done.
打开 `https://mail.example.com`,创建第一个管理员账号。完成。

### Where the entry subdomain is set / 入口子域在哪里指定

There is **one** source of truth: the `routes` array in `wrangler.jsonc`. Everything else follows from it.
只有**一处**权威来源:`wrangler.jsonc` 里的 `routes` 数组,其余都跟着它走。

```jsonc
"vars": {
  "APP_ORIGIN": "https://mail.example.com"      // used in invite and reset links / 邀请、重置链接里用它
},
"routes": [
  { "pattern": "mail.example.com", "custom_domain": true },
  { "pattern": "mail.another.com", "custom_domain": true }
]
```

- You pick the prefix the first time you run `setup-zone.mjs` (the optional second argument). The script binds the custom domain and appends the route to `wrangler.jsonc` for you; later runs read the prefix back out of `routes`, so every domain gets the same one.
  前缀由你第一次跑 `setup-zone.mjs` 时的第二个参数决定。脚本会绑定自定义域并把 route 追加进 `wrangler.jsonc`;之后再跑就从 `routes` 里读回同一个前缀,保证各域名一致。
- `npm run deploy` reconciles live custom domains against `routes`. A domain missing from that array gets detached on the next deploy — which is also how you remove one.
  `npm run deploy` 会拿 `routes` 跟线上自定义域对账。不在数组里的域名,下次部署就会被摘掉 —— 想下线某个域名,也正是这么做。
- `APP_ORIGIN` must match the first entry; it is what invite and password-reset links point at.
  `APP_ORIGIN` 要和第一条保持一致 —— 邀请链接和密码重置链接都指向它。
- The pattern must be `<subdomain>.<zone>`: the scripts derive the Cloudflare zone by dropping the leftmost label.
  格式必须是 `<子域>.<域名>`:脚本靠"去掉最左一段"推导 Cloudflare zone。

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
| Account | **Turnstile Sites** | Edit | Running `scripts/setup-turnstile.mjs`. The dashboard calls it "Turnstile Sites" / Dashboard 里就叫这个名字 |
| Zone | **Zone WAF** | Edit | Running `scripts/push-ratelimit.mjs` |

> Set **Zone Resources to All zones**, or at least every domain you plan to connect — zone-level permissions are needed each time you add one. Permission changes take about a minute to apply; don't retry immediately.
>
> **Zone Resources 选 All zones**,或至少包含你要接入的全部域名。改完权限约 1 分钟生效,别急着重试。

---

## Deployment in detail / 部署细节

### 1. Configuration / 配置文件

`wrangler.jsonc` is **not** in the repository — it holds your account id, database id and domains. Copy the template and replace every `<placeholder>`: `account_id`, `database_id` and `APP_ORIGIN`. Leave `routes` empty; `setup-zone.mjs` fills it in as you connect domains.
`wrangler.jsonc` **不在仓库里** —— 它含你的 account_id、database_id 和域名。从模板复制一份,把所有 `<占位符>` 替换掉:`account_id`、`database_id`、`APP_ORIGIN`。`routes` 留空即可,接域名时由 `setup-zone.mjs` 自动填。

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Since it is not in git, **keep your own copy somewhere safe** — losing it means rebuilding the account and database ids by hand.
因为它不入库,**自己另存一份** —— 丢了就得手工把 account_id、database_id 一个个找回来。

### 2. Connect a domain / 接入域名

```bash
node scripts/setup-zone.mjs example.com [entry-subdomain]
npm run deploy
```

The script does four things: enables Email Routing (publishing MX/SPF), points the catch-all rule at the cfmail Worker, binds `<entry-subdomain>.<domain>` as a custom domain, and writes that route into `wrangler.jsonc`. The second argument is only needed the first time — after that the prefix is read back out of `routes`. Deploy afterwards so the new route is published.
脚本做四件事:启用 Email Routing(下发 MX/SPF)、把 catch-all 指向 cfmail Worker、绑定 `<入口子域>.<域名>` 自定义域、把这条 route 写进 `wrangler.jsonc`。第二个参数只有第一次需要,之后从 `routes` 里读回同一个前缀。跑完记得部署一次,新 route 才会生效。

> **Careful**: enabling Email Routing takes over that domain's MX records. If the domain already has mail service, confirm before switching.
> **注意**:启用 Email Routing 会接管该域名的 MX 记录。如域名原有邮件服务,切换前先确认。

### 3. Hardening / 加固(可选,但建议做)

```bash
node scripts/setup-turnstile.mjs   # create the widget, wire up both halves
node scripts/push-ratelimit.mjs    # push edge rate-limit rules to every zone
npm run deploy
```

- **Turnstile** protects login, password reset and invite signup. The script handles both halves itself: the secret goes into the Worker via `wrangler secret` (never printed, never on disk) and the public sitekey is written into `wrangler.jsonc` under `vars` — nothing to copy by hand. **Both must be present for it to activate**, so to disable in a hurry, delete `TURNSTILE_SITEKEY` and redeploy.
  保护登录、密码重置、邀请注册三处。两半都由脚本自己搞定:secret 经 `wrangler secret` 灌进 Worker(不打印、不落盘),公开的 sitekey 由脚本写进 `wrangler.jsonc` 的 `vars`,不需要手动粘贴。**两者齐了才启用** —— 想紧急停用,删掉 `TURNSTILE_SITEKEY` 重新部署即可。
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
- No Queues — an outbox table plus Cron is simpler at this scale.
  不用 Queues,当前量级 outbox 表 + Cron 更简单。
- **IMAP-ready schema**: `folders` carry `uidvalidity`/`uidnext`, `messages` carry a per-folder monotonic `uid` and standard IMAP flags. Adding an IMAP gateway later needs no data migration.
  **数据模型 IMAP-ready**,将来加 IMAP 网关不用迁数据。
- **The API returns error codes, never prose.** A failure is `{"error": "e_bad_email"}`, with an `args` array when the message has values in it. The browser renders the sentence in the reader's language. One translation table serves the whole product, and the API stays usable from any client.
  **API 只回错误码,不回句子。** 失败一律是 `{"error": "e_bad_email"}`,句子里要填值时带一个 `args` 数组,由浏览器按使用者的语言渲染成文字。全产品只有一份翻译表,API 也便于被其他客户端使用。

### Error codes / 错误码

```
src/errors.ts             HttpError(status, code, ...args) and E(code, ...args)
public/assets/i18n.js     the e_* entries, nine languages, at the end of the file
```

Adding one: throw `new HttpError(400, 'e_your_code', value)`, then add `e_your_code` to all nine dictionaries. A code with no entry falls back to a generic line rather than leaking `e_your_code` to the user.
新增一个:`throw new HttpError(400, 'e_your_code', value)`,再把 `e_your_code` 加进九套词典。没有词条的码会退回一句通用提示,不会把 `e_your_code` 直接显示给用户。

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

## Migration and admin tools / 迁移与管理工具

- **Import / 导入** — point it at a folder of `.eml` files. Parsing happens entirely in the browser, so it costs no Worker CPU. Ships with [Export-Mailbox.ps1](public/tools/Export-Mailbox.ps1), a PowerShell script that pulls a Microsoft 365 mailbox through the Microsoft Graph API (read-only scopes, resumable, 9 languages).
  指向一个装着 `.eml` 的目录。解析全在浏览器做,不烧 Worker CPU。附带用 Microsoft Graph API 只读权限拉取 Microsoft 365 邮箱的 PowerShell 脚本(可断点续传)。
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
- Webmail only. No IMAP/POP/SMTP client access yet — the schema is already built for it and support is planned.
  纯 webmail,暂无 IMAP/POP/SMTP 客户端接入;数据模型已为此预留,后续计划开发支持。
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
- Themes: `node scripts/build-themes.mjs` generates 30 light/dark pairs from `@radix-ui/colors`.
  主题由脚本从 `@radix-ui/colors` 生成 30 套明暗成对。
- Domain admins pick a theme per domain; users pick light/dark/auto and their own interface and body fonts.
  域管理员按域名选主题;用户自己选明暗和字体。
- Interface strings live in `public/assets/i18n.js` — all 9 dictionaries must stay in sync.
  界面文案在 `public/assets/i18n.js`,9 套词典需同步维护。

---

## Versioning and release / 版本与发布

`major.feature.fix`. The current version lives in `src/version.ts` and shows up in the account menu and settings page. Bump it before each deploy.
规则 `主版本.功能.修复`。当前版本在 `src/version.ts`,每次部署前更新。

Release checklist / 发布清单: edit code → run `build-themes.mjs` if themes changed → `npm run typecheck` → `npm run migrate:remote` if there are new migrations → `npm run deploy`.

---

## Layout / 目录结构

```
migrations/                    # D1 schema, applied in order / D1 schema,按序号递增
src/
  index.ts                     # fetch / email / scheduled entry points / 三入口
  api.ts                       # application API (Hono) / 业务 API
  admin.ts                     # admin API: stats, members, invites, export, audit / 管理后台 API
  auth.ts                      # sessions, PBKDF2 passwords, CSRF / 会话、密码、CSRF
  audit.ts                     # admin action audit trail / 管理员操作审计
  errors.ts                    # error codes + HttpError / 错误码与 HttpError
  parse.ts                     # inbound parsing and storage / 收信解析入库
  send.ts                      # send pipeline + CF/SES/Resend/dev / 发送管道
  mime.ts                      # outbound MIME building / 出站 MIME 构建
  fonts.ts                     # server-side Google Fonts proxy / 字体服务端代理
  chat/                        # experimental chat agent (Durable Object) / 实验性会话 agent
public/                        # Gmail-style SPA, no bundler / 无打包无转译
  vendor/                      # third-party browser libs, not committed / 不入库
  tools/Export-Mailbox.ps1     # Microsoft 365 mailbox exporter / M365 导出脚本
scripts/
  sync-vendor.mjs              # sync public/vendor/ from node_modules (postinstall)
  wrangler-config.mjs          # reads wrangler.jsonc, feeds domains/zones to other scripts
  setup-zone.mjs               # connect a domain, write its route / 接入域名并写回 route
  setup-turnstile.mjs          # create the Turnstile widget / 建 Turnstile widget
  push-ratelimit.mjs           # push edge rate-limit rules / 推限速规则
  build-themes.mjs             # generate themes / 生成主题
  import-eml.mjs               # command-line import / 命令行导入
```

---

## License / 许可

MIT — see [LICENSE](LICENSE). Third-party components and their notices are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
MIT,第三方组件及其声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
