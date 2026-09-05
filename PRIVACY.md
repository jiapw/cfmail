# Data flows and privacy / 数据流与隐私

What data CFMail handles, where it lives, and under what circumstances anything leaves your own Cloudflare account.

本文件说明 CFMail 处理哪些数据、存在哪里、什么情况下会有数据离开你自己的 Cloudflare 账号。

Written for **the operator** — you run this code in your own Cloudflare account, so you are the controller of this data.

面向的是**部署方** —— 你把这套代码跑在自己的 CF 账号里,你就是这些数据的控制者。

---

## 1. The three things that matter most / 先说最重要的三句

1. **No telemetry, no phone-home, no license server.** Not a single line of it — grep the source to verify. The author receives nothing and can see nothing about your deployment.
   **没有遥测,没有回家调用,没有 License 校验服务器。** 代码里一处都没有,可以全文搜索验证。作者不接收任何数据,也拿不到你的任何信息。
2. **All mail data stays in your own Cloudflare account** — bodies and attachments in your R2, metadata and indexes in your D1.
   **所有邮件数据只存在你自己的 Cloudflare 账号里**:正文和附件在你的 R2,元数据和索引在你的 D1。
3. **On default settings the only outbound connection is mail delivery itself.** Everything else is optional and off by default.
   **默认配置下,唯一的对外连接是收发邮件本身**。其余全部是可选项,且默认关闭。

---

## 2. Where data lives / 数据存在哪里

All inside the operator's own Cloudflare account:
全部在部署方自己的 Cloudflare 账号内:

| Data / 数据 | Location / 位置 | Notes / 说明 |
|---|---|---|
| Raw messages (full MIME, attachments, inline images) / 邮件原文 | **R2** | One object per message / 一封一个对象 |
| Message metadata, body text, full-text index / 元数据、正文文本、全文索引 | **D1** | `messages` / `message_texts` / `messages_fts` |
| Users, sessions, mailboxes, grants, invites / 用户、会话、邮箱、授权、邀请 | **D1** | Passwords are PBKDF2-SHA256 hashes at 100,000 iterations, not reversible / 密码为不可逆哈希 |
| Contacts / 通讯录 | **D1** | Collected automatically from correspondence / 从往来邮件自动采集 |
| Mail to non-existent addresses / 发给不存在地址的来信 | **D1** `unrouted` | Purged automatically on a schedule / 定期自动清理 |
| Drafts, in-flight uploads / 草稿、上传中的附件 | **D1** + **R2** | |
| AI conversations and long-term memory / AI 对话记录与长期记忆 | **Durable Object** + D1 | Only when the assistant is enabled / 仅启用 AI 时 |
| Font cache / 字体文件缓存 | **R2** | See "Fonts" below / 见下方"字体" |

Other personal data that gets stored:
其它会落库的个人数据:

- **`sessions.ua`** — the User-Agent of a signed-in device, kept 30 days (the session lifetime), so users can recognise their own devices.
  登录设备的 User-Agent,保留 30 天(会话有效期),用于让用户辨认自己的登录设备。
- **Failed-login counters and lockout timestamps** on `users`, used for rate limiting.
  登录失败计数与锁定时间,存在 `users` 上,用于限速。
- **No IP addresses are recorded.** The application layer never writes an IP anywhere. (Cloudflare's own platform logs are separate and governed by your agreement with them.)
  **不记录访问 IP。** 应用层没有任何 IP 落库(Cloudflare 自身的日志另算,那受你和 CF 的协议约束)。
- **Forms are the one deliberate exception, and the IP goes into mail, not into a table.** When somebody fills in a form, the answer mail delivered to the recipients the designer chose carries the submitter's IP address and the country/region/city Cloudflare resolved it to, alongside their local time and time zone — the designer asked for exactly that, and the person filling the form is told nothing less than the recipients are. The IP is not written to the database: the public form endpoints rate-limit by a salted hash of it (`form_throttle`), swept after two hours. Verification codes for public forms go out as ordinary system mail. Automatic translation of a form's texts sends the **designer's** texts (never the answers) to Workers AI whenever the designer ticks a second language; the model and the prompt are set by a global administrator under Admin → Models, independently of the assistant's per-domain switch. A designer may also choose, per form, to **keep the answers in CFMail** (D1 for the answers, R2 for uploaded files, IP and location included); kept answers can be opened by the designer and by anyone holding a recipient mailbox, and stay until the designer deletes them or the form.
  **表单是唯一有意为之的例外,而且 IP 进的是邮件、不是表。** 有人填写表单时,送达设计者指定收件箱的那封答复邮件会带上填写者的 IP 和 Cloudflare 解析出的国家/地区/城市,连同其本地时间与时区 —— 这正是设计者要求的。IP 不落库:公开表单端点按其加盐哈希限速(`form_throttle`),两小时后清扫。公开表单的验证码走普通系统邮件。表单文本的自动翻译只把**设计者**的文本(绝不含答复)送到 Workers AI,只要设计者勾选了第二种语言就会发生;用哪个模型、什么提示词由全局管理员在 后台 → 大模型 里设定,与 AI 助手的按域开关无关。设计者还可以按表单选择**把答复保存在 CFMail 里**(答复进 D1、上传的文件进 R2,含 IP 与位置);保存的答复由设计者和持有接收邮箱的人查看,一直保留到设计者删除它或删除表单。

---

## 3. When data leaves your account / 什么情况下数据会离开你的账号

### Always on — inherent to being an email system / 默认就有的

| Destination / 目的地 | What is sent / 送出什么 | Trigger / 触发条件 | Can it be turned off? / 能否关闭 |
|---|---|---|---|
| The recipient's mail server / 收件人的邮件服务器 | Mail you send / 你发出去的邮件 | A user sends mail / 用户发信 | That *is* the email system / 这就是邮件系统本身 |
| Cloudflare Email Routing / Email Sending | Mail in and out / 收发的邮件 | Always / 一直 | No — it is the platform / 否,是平台本身 |

### Optional — off by default / 默认关闭或可选的

| Destination / 目的地 | What is sent / 送出什么 | Trigger / 触发条件 | How to disable / 怎么关 |
|---|---|---|---|
| **Brave Search / DuckDuckGo** | **Search queries the model writes from conversation content** / 模型根据对话内容生成的**搜索词** | AI enabled **and** "internet access" enabled / AI 已开 **且** 联网能力已开 | **Off by default.** Admin → AI assistant → Internet access / **默认就是关的** |
| **Any website** (`open_url`) / 任意网站 | Target URL + your Worker's egress IP / 目标 URL + Worker 出口 IP | Same as above / 同上 | Same switch / 同一个开关 |
| **Cloudflare Workers AI** | Conversation content, and the mail a user asks the assistant to read / 对话内容,以及用户让 AI 读的邮件 | AI enabled / AI 已开 | Turn the assistant off per domain / 按域名关掉 AI |
| **challenges.cloudflare.com** | Turnstile token + **the end user's IP** (`remoteip`) / Turnstile token + **终端用户 IP** | Turnstile configured / 配了 Turnstile | Delete `TURNSTILE_SITEKEY` from `wrangler.jsonc` and redeploy / 删掉该项重新部署 |
| **Amazon SES / Resend** | Full outbound messages / 你发出去的邮件全文 | Either chosen as the sending channel / 选了这两个发信通道 | Use `MAIL_PROVIDER=cf` / 改用 CF 通道 |
| **fonts.googleapis.com / fonts.gstatic.com** | A font name — **no user information** / 字体名,**不含**任何用户信息 | A user picks a non-system font / 用户选了非系统字体 | See below / 见下 |

### Fonts / 关于字体

Fonts are fetched **server-side by the Worker** and cached in your own R2. **The browser never contacts Google**, so end users' IP addresses, Referer and cookies never reach them — Google only ever sees your Worker's egress IP.

字体由 **Worker 服务端代理**获取,文件缓存进你自己的 R2。**浏览器从不直连 Google**,因此终端用户的 IP、Referer、Cookie 都不会到达 Google;Google 只会看到你的 Worker 的出口 IP。

This is deliberate: in 2022 a German court (LG München) held that embedding Google Fonts directly in the frontend leaked visitor IPs in breach of the GDPR. The proxy design sidesteps that problem.

这一点是有意设计的:2022 年德国慕尼黑地方法院曾判决网站前端直接引用 Google Fonts 泄露访客 IP 违反 GDPR。本项目的代理式实现规避了这个问题。

### The AI assistant / 关于 AI

- Cloudflare states it [does not use customer content to train the models on Workers AI](https://developers.cloudflare.com/workers-ai/platform/data-usage/), and acts as a processor under its [Customer DPA](https://www.cloudflare.com/cloudflare-customer-dpa/).
  Cloudflare 声明不使用客户内容训练模型,并在其 DPA 中作为数据处理者。
- The assistant can only read **mailboxes the signed-in user already has permission for**. An administrator cannot use it to read someone else's mail — this is a deliberate design line, because in many jurisdictions viewing another person's communications on their behalf constitutes interception.
  AI 只能读**当前登录用户自己有权限的**邮箱。管理员无法通过 AI 读别人的邮件 —— 这是有意的设计红线,在很多法域,代他人查看通信内容构成通信拦截。
- **Internet search is off by default.** It is the only feature that sends mail-derived content to a third party; confirm your own compliance position before enabling it.
  **联网搜索默认关闭**。这是唯一会把邮件衍生内容发给第三方的功能,开启前请确认你的合规立场。

---

## 4. Deletion and export / 删除与导出

| Capability / 能力 | Where / 位置 |
|---|---|
| Export selected mailboxes as `.eml` to a local folder / 导出邮箱为 `.eml` 到本地目录 | Admin → Import/Export tools / 后台 → 导入导出工具 |
| Erase everything in a mailbox (messages, attachments, R2 objects, indexes, contacts) / 清空某邮箱的全部内容 | Admin → Mailboxes → Erase contents / 后台 → 邮箱 → 清空内容 |
| Delete a mailbox and its user account / 注销整个邮箱及其用户 | Admin → Mailboxes → Delete / 后台 → 邮箱 → 注销 |
| Users deleting their own mail / 用户自行删除邮件 | Mail UI; permanent deletion after Trash / 邮箱界面,进回收站后可永久删除 |

**This project does not auto-expire mail.** Messages are kept until someone explicitly deletes them. If your jurisdiction requires storage limitation (e.g. GDPR Art. 5(1)(e)), you must define and apply a retention policy yourself.

**本项目不做自动保留期清理。** 邮件会一直保留,直到有人显式删除。如果你所在的法域要求存储限制,需要你自己制定并执行保留政策。

`unrouted` (mail sent to addresses that don't exist) is the exception — it is purged on a schedule. Those senders never intentionally contacted you, so it should not be kept indefinitely.

`unrouted` 是例外,会定期自动清理 —— 这些人并没有主动联系你,不该长期留存。

---

## 5. Audit / 审计

Sensitive administrator actions — creating and deleting mailboxes, erasing contents, exporting, revoking sessions, changing permissions, viewing unrouted mail — are recorded in the `audit_log` table and can be viewed and downloaded from the admin console.

管理员的敏感操作(建/删邮箱、清空内容、导出、撤销登录、改权限、查看未匹配来信等)记录在 `audit_log` 表,后台可查看和下载。

---

## 6. Who is responsible for what / 责任划分

```
You (the operator)  = Data Controller / 数据控制者
Cloudflare          = Data Processor (see the Cloudflare Customer DPA) / 数据处理者
The author          = neither — never touches any data / 不接触任何数据,既非控制者也非处理者
```

This project is **software, not a service**. The author never receives, stores or accesses any of your data, so **there is no DPA to sign with the author**.

本项目是**软件**,不是服务。作者从不接收、存储或访问你的任何数据,因此**无需与作者签署 DPA**。

Your relationship with Cloudflare is governed by the [Cloudflare Customer DPA](https://www.cloudflare.com/cloudflare-customer-dpa/). Cloudflare provides ISO/IEC 27001 and SOC 2 Type II audit reports and participates in the Data Privacy Framework.

你与 Cloudflare 之间的关系由 Cloudflare Customer DPA 约束,CF 提供 ISO/IEC 27001、SOC 2 Type II 等审计报告,并参与 Data Privacy Framework。

If you need data kept in a particular region, set the location when creating D1 and R2 (D1 supports a location hint, R2 supports jurisdictional restrictions such as the EU). That is configured in your own Cloudflare account and is unrelated to this project's code.

如果你需要把数据限制在特定地区,请在创建 D1 和 R2 时设置位置(D1 支持 location hint,R2 支持 EU 等司法辖区限制),这是在你的 Cloudflare 账号里配置的,与本项目代码无关。

---

*This document describes how the software behaves. It is not legal advice — consult your own counsel about your specific obligations.*

*本文件描述软件行为,不构成法律意见。具体合规义务请咨询你自己的法律顾问。*
