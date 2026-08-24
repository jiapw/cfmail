# CFMail — Enterprise Webmail on Cloudflare / 基于 Cloudflare 的企业 Webmail

Run your company's email **and its file storage** on your own Cloudflare account. Receiving, storage and the web client all live inside **your** account — nothing is hosted by anyone else.

把公司的邮件系统**和网盘**跑在**你自己的** Cloudflare 账号里。收信、存储、网页客户端,全部在你的账号内,没有任何一部分托管在别人那里。

MIT licensed ([LICENSE](LICENSE)). Data-flow and privacy details in [PRIVACY.md](PRIVACY.md).
MIT 授权,数据流与隐私说明见 [PRIVACY.md](PRIVACY.md)。

> **No telemetry, no phone-home, no license server.** Grep the source and see for yourself.
> **没有遥测、没有回家调用、没有 License 校验服务器。** 可以全文搜索验证。

---

## What you get / 功能

Two peer subsystems behind one sign-in and one nav bar: **Mail** and **Drive**.
一次登录、一条导航栏,后面是两个平级的子系统:**邮件**和**网盘**。

### Mail / 邮件

- **Multi-domain / 多域名** — one deployment serves any number of company domains, each with its own branding and theme.
  一次部署服务任意多个公司域名,每个域名有独立的品牌和主题。
- **Gmail-style client / Gmail 风格客户端** — threaded conversations, full-text search, folders, starring, shift-click range selection, batch actions, drag-and-drop attachments, a rich-text composer with inline images and multiple minimisable windows.
  会话聚合、全文搜索、文件夹、星标、shift 连选、批量操作、拖拽附件,富文本编辑器支持内嵌图片和多窗口最小化。
- **Shared mailboxes / 共享邮箱** — one mailbox can be granted to several people (owner / member / read-only).
  一个邮箱可授权给多人(所有者 / 成员 / 只读)。
- **Invite-based signup / 邀请制注册** — single-use links for one hire, or a shared link a whole team registers through until it expires. Email verification either way.
  单人一次性链接用于招一个人;共享链接发给一整队人,在过期前不限注册人数。两种都要验证邮箱。
- **Aliases and catch-all / 别名与 catch-all** — inbound addresses that map onto a real mailbox, plus a view of mail that matched nothing.
  可把额外地址映射到真实邮箱,未匹配的来信也能查看。

### Drive / 网盘

- **Per-domain, off by default / 按域名开启,默认关闭** — a domain admin turns it on and sets the default quota; individual users can be raised or lowered.
  域管理员开启并设定默认配额,可单独调高或调低某个用户。
- **Google-Drive-style client / Google Drive 风格客户端** — grid and list views, breadcrumbs, drag to move (single tile or a whole selection, with a stacked drag image), marquee selection, shift-range and ctrl-marquee, right-click menus everywhere including empty space, starred / recent / shared-with-me / trash.
  网格与列表视图、路径面包屑、拖拽移动(单个或整组,带叠层拖影)、框选、shift 连选与 ctrl 加选、包括空白处在内的右键菜单,以及已加星标 / 最近使用 / 共享给我 / 回收站。
- **Drag a folder in / 整个文件夹拖进来** — the directory tree is walked and recreated; big files go multipart (90 MB single-shot, 32 MB parts above that) straight into R2.
  目录树会被递归还原;大文件走分片直传 R2(90MB 以内单次,超过按 32MB 分片)。
- **Rich previews, no download / 不下载即预览** — text and code, Markdown, **docx** typeset onto a sheet, **pptx** drawn slide by slide, **xlsx/xlsm/csv/tsv** as a tabbed workbook, PDF, images, video, SVG, drawio, MHTML, and HTML in a fully sandboxed frame.
  纯文本与代码、Markdown、**docx** 排版成白纸、**pptx** 逐页绘制、**xlsx/xlsm/csv/tsv** 带工作表标签、PDF、图片、视频、SVG、drawio、MHTML,以及进全沙箱框架的 HTML。
- **Archives as folders / 压缩包当文件夹** — step into a `.zip` or `.7z` and browse it, preview what is inside, play a video straight out of it. Encrypted archives (7z AES-256, legacy ZipCrypto) open with a password that never leaves the browser.
  点进 `.zip` / `.7z` 直接浏览、预览里面的文件、甚至直接播放里面的视频。加密压缩包(7z AES-256、传统 ZipCrypto)输入密码即可打开,密码绝不离开浏览器。
- **Sharing / 分享** — a link per selection, either **internal** (signed-in, optionally restricted to one domain, viewer or editor) or **public** (no account, always read-only). Optional expiry, a note, revocation, and — for internal links — a list of which colleagues have joined, each removable one at a time.
  按所选内容生成链接:**内部**(需登录,可限定单一域名,只读或可编辑)或**公开**(无需账号,恒为只读)。可设过期、备注、随时撤销;内部链接还会列出哪些同事已加入,可逐个移除。
- **Thumbnails for everything / 全类型缩略图** — images, video frames, PDF first pages and text files all get one, generated in the browser at upload time.
  图片、视频抽帧、PDF 首页、文本文件都有缩略图,上传时在浏览器里生成。

### Both / 两边共用

- **Admin console / 管理后台** — per-domain stats, mailbox and alias management, branding, Drive quotas, unrouted-mail inspection, audit log.
  分域名统计、邮箱与别名管理、品牌设置、网盘配额、未匹配来信查看、审计日志。
- **Migration tools / 迁移工具** — import `.eml` from Zoho / Outlook / anywhere, export mailboxes back to a local folder. Includes a PowerShell script that pulls a Microsoft 365 mailbox via the Microsoft Graph API.
  从 Zoho / Outlook 等导入 `.eml`,也能把邮箱导出回本地。附带一个用 Microsoft Graph API 拉取 Microsoft 365 邮箱的 PowerShell 脚本。
- **9 UI languages / 9 种界面语言**, 30 built-in themes, light/dark/auto, and a font picker for interface and body text.
  30 套内置主题,明暗自动切换,界面与正文字体可自选。

---

## The parts we are proud of / 值得一说的地方

Most of these exist because the Workers runtime cannot decode an image, cannot spend a second
of CPU on a parse, and charges for every byte it moves. The way out was to stop moving bytes
that nobody reads, and to do the heavy work in the browser that is already looking at the file.
下面这些之所以存在,是因为 Workers 运行时解不了图、不能拿一秒 CPU 去解析、并且搬多少字节
就计多少费。出路是别去搬没人会读的字节,把重活交给那台已经在看这个文件的浏览器。

- **Mail between your own people never leaves your account.** A message from one mailbox to
  another in the same deployment is delivered directly — no sending provider, no egress, nothing
  billed, and nothing about it visible to a third party.
  **自己人之间的邮件根本不出你的账号。** 同一部署内邮箱之间的信直接投递 ——
  不走发信通道、没有出网流量、不计费,也不会有第三方看到它。
- **A partial send never turns into a double send.** Outbound mail goes through an outbox table
  that retries with exponential backoff and, when a send is accepted for some recipients and
  refused for others, re-sends only to the ones still outstanding.
  **部分失败不会变成重复投递。** 外发走 outbox 表,自带指数退避重试;
  一封信部分收件人成功、部分失败时,只补发还没成的那几个。
- **Importing an old mailbox costs the server nothing.** The `.eml` files are parsed in the
  browser, by the same parser at the same version the Worker uses — so attachment order matches
  and downloads can still locate parts by index in the original message.
  **搬迁旧邮箱不花服务端一分 CPU。** `.eml` 在浏览器里解析,用的是和 Worker 同一个解析器的同一版本 ——
  这样附件顺序一致,下载时仍能按索引回到原文里定位。
- **A 50 MB Word document costs a few hundred kilobytes.** docx, pptx and xlsx are zip packages,
  and they are read over HTTP Range: the tail of the file gives the central directory, then only
  the parts actually needed are fetched. The photographs inside are never downloaded, because the
  text lives in a different part. Judge the work by the parts read, never by the file's size.
  **一份 50MB 的 Word 文档只花几百 KB。** docx / pptx / xlsx 本质是 zip 包,全部按 HTTP Range 读:
  先读文件尾拿到中央目录,再只取真正需要的部件。里面的照片从不下载,因为正文在另一个部件里。
  开销应该按"读了哪些部件"算,而不是按文件大小算。
- **An 80 MB workbook opens in the time it takes to read its tab names.** Only the small header
  parts are read up front; each worksheet is inflated and parsed when someone actually clicks
  that tab. Seventeen sheets cost one sheet's work.
  **一本 80MB 的工作簿,打开只用读出标签名的时间。** 开头只读那几个很小的头部部件,
  每张工作表等到有人点它才解压解析。十七张表只付一张表的成本。
- **A flick through a hundred slides builds two pages, not a hundred.** A page observer would
  queue every slide that sweeps past, ninety-nine of them already behind the reader. So nothing
  is queued: two builders run at a time, and each one, when free, asks where the viewport is
  *now* and takes the nearest page not yet built — found by bisection, so a thousand pages cost
  ten measurements.
  **在一百页幻灯片里猛甩一下,只会构建两页,而不是一百页。** 用监听器的话,划过的每一页都会
  排进队列,其中九十九页早已被读者甩在身后。所以这里不排队:两个构建器并行,谁空下来就问
  一次"视口**现在**在哪",取最近的未构建页 —— 用二分查找定位,一千页也只要十次测量。
- **Gigabyte solid blocks stream through a few dozen megabytes of RAM.** The LZMA1/LZMA2 decoder
  is hand-written and resumable: it pauses at clean symbol boundaries when the rolling input runs
  low or the dictionary window holds enough undrained output, and continues exactly where it
  stopped. The per-bit hot path never touches a promise.
  **GB 级 solid 块只用几十 MB 内存就流过去了。** LZMA1/LZMA2 解码器是手写的,且天生可续传:
  滚动输入不够或字典窗口攒够待排水的输出时,它在干净的符号边界暂停,之后从暂停点精确继续。
  每比特的热路径上完全没有 Promise。
- **Play a video straight out of a zip.** A service worker owns a private URL space and answers
  the player's own Range requests: for stored entries by plain offset arithmetic onto R2 — true
  ranged streaming, zero decode, zero buffering — and for compressed ones with a sequential
  decode stream under backpressure.
  **压缩包里的视频可以直接播。** 一个 service worker 掌管私有的 URL 空间,直接应答播放器自己
  发出的 Range 请求:store 存放的条目纯偏移平移到 R2 —— 真正的 Range 流式播放,零解码零缓冲;
  压缩过的则用带背压的顺序解码流。
- **Encrypted archives open, and the password stays in the tab.** 7-Zip's own KDF (one continuous
  SHA-256 over 2^N iterations) plus WebCrypto AES-CBC, and the classic three-key ZipCrypto stream
  for legacy zips. Nothing about the password is sent anywhere.
  **加密压缩包能打开,而密码留在这个标签页里。** 7-Zip 自家的 KDF(对 2^N 轮做一次连续的
  SHA-256)配 WebCrypto AES-CBC,老式 zip 走经典的三密钥 ZipCrypto 流。
  密码相关的东西一个字节都不外发。
- **Thumbnails are made by the uploader, not the server.** Images get a centre cover-crop; a video
  is sampled at several positions and the frame kept is the one that is neither blown out nor
  black *and* has the strongest mean |Laplacian|, i.e. the most detail; PDFs render page one
  through self-hosted pdf.js; text files are typeset onto a white sheet. Output is always WebP
  480×360 under 100 KB — and the server re-checks both.
  **缩略图由上传端生成,不由服务端。** 图片居中 cover 裁切;视频在多个位置抽帧,留下的那一帧
  既不过曝也不发黑,**并且**平均 |拉普拉斯| 最大(细节最多);PDF 用自托管的 pdf.js 渲染首页;
  文本文件排版到一张白纸上。产物固定是 WebP 480×360、不超过 100KB —— 两项服务端都会复核。
- **One reading stack, two doors.** The signed-in Drive and the public share page read the same
  nodes through different endpoints, so everything downstream of the listing — preview overlay,
  archive browser, streaming worker — is the same code on the same bytes. A docx, a slide deck or
  an encrypted 7z behaves for a link recipient exactly as it does for the owner.
  **一套读取栈,两扇门。** 登录态网盘和公开分享页透过不同端点读同一批节点,
  于是列表之后的一切 —— 预览层、压缩包浏览器、流式 worker —— 都是同一份代码在同一批字节上跑。
  一个 docx、一套幻灯片、一个加密 7z,收到链接的人看到的行为和所有者完全一致。
- **The API returns codes, never prose.** A failure is `{"error": "e_bad_email"}`; the sentence is
  rendered by the reader's browser in the reader's language. One translation table serves the whole
  product in nine languages, and the API stays clean enough for any other client to use.
  **API 只回错误码,不回句子。** 失败一律是 `{"error": "e_bad_email"}`,句子由读者的浏览器
  按读者的语言渲染。全产品九种语言只有一份翻译表,API 也干净得可以给其它客户端直接用。
- **None of the above is a dependency.** No zip library, no LZMA library, no Office library, no
  bundler and no transpiler — `public/` is plain ES modules served as written. The only vendored
  browser code is Web Awesome (components), Quill (the composer), pdf.js and postal-mime.
  **上面这些全都不是依赖。** 没有 zip 库、没有 LZMA 库、没有 Office 库、没有打包器、没有转译器,
  `public/` 就是照原样送出的 ES 模块。自托管的第三方浏览器代码只有 Web Awesome(控件)、
  Quill(编辑器)、pdf.js 和 postal-mime。

---

## Requirements / 前置条件

| | EN | 中文 |
|---|---|---|
| **Cloudflare account** | Domains must use **Cloudflare DNS** (full zone). Email Routing does not work on partial/CNAME setups | 域名必须用 **Cloudflare DNS**(完整 zone)。Email Routing 不支持 partial/CNAME 接入 |
| **Workers plan** | The free plan runs everything except sending to outside recipients — see below | 免费版能跑起全部功能,唯独对外发信不行 —— 见下表 |
| **Node.js** | 18 or newer, to run `wrangler` and the setup scripts | 18 以上,用来跑 `wrangler` 和配置脚本 |
| **Docker** | Only to rebuild the media codecs (`npm run libav`). A clone already has the built file, so installing and deploying need nothing here | 只有重建媒体编解码器(`npm run libav`)时才要。克隆下来就已经带着建好的文件,安装和部署都用不到 |

### Free plan vs paid / 免费版够不够

| Component / 组成 | Workers Free | Notes / 说明 |
|---|---|---|
| Receiving mail (Email Routing) / 收信 | ✅ Free, unlimited / 免费无限 | |
| Web client, API, D1, R2 / 网页端、API、D1、R2 | ✅ Generous free tier / 免费额度很宽 | D1 5 GB, R2 10 GB |
| Drive / 网盘 | ✅ Runs on the free tier / 免费额度即可跑 | Shares the same R2 bucket, so the 10 GB is shared with mail storage / 与邮件共用同一个 R2 桶,10 GB 是两边合计 |
| **Sending to outside recipients / 发信给外部收件人** | ❌ **Needs Workers Paid / 需要付费版** | [Email Sending requires the paid plan](https://developers.cloudflare.com/email-service/platform/pricing/) for arbitrary recipients / 发给任意收件人要求付费版 |

Internal mail and receiving work on the free plan. To send to the outside world you need **Workers Paid ($5/mo, 3,000 emails included)** — or plug in SES / Resend and stay free. **If you already pay for Cloudflare Workers, this adds no new subscription** — CFMail runs inside the plan you have. Rough cost for a small team starting fresh: **$5/month** plus R2 overage beyond 10 GB ($0.015/GB·month). Mail between mailboxes in the same deployment never touches a sending provider and is not billed.

收信和站内互发在免费版上完全可用。要给外部世界发信,需要 **Workers 付费版(每月 $5,含 3000 封)** —— 或者改接 SES / Resend,继续留在免费版。**如果你本来就在用 Cloudflare Workers 付费版,那么不会增加任何订阅费用** —— CFMail 跑在你已有的套餐里。从零开始的小团队大致成本:**每月 $5**,加上 R2 超过 10 GB 的部分。同一部署内邮箱之间的往来邮件不走发信通道,不计费。

---

## Quick start / 快速开始

Everything below is **shell commands** — type them in a terminal, one line at a time. They are written for bash/zsh (macOS, Linux, Git Bash, WSL) and work as-is in PowerShell too, except that Windows PowerShell 5.1 does not understand `&&` — run those two commands separately.

下面全部是**终端命令**,在命令行里一行一行敲。写法按 bash/zsh(macOS、Linux、Git Bash、WSL),PowerShell 里也能直接用,只有一点:Windows PowerShell 5.1 不认 `&&`,把那两条拆开分别执行。

Three commands, start to finish:
从头到尾三条命令:

```bash
git clone https://github.com/jiapw/cfmail.git
cd cfmail
npm install
npm run deploy -- --token <your API token> --domain example.com --entry mail
```

That is the whole installation. The third command creates the database and the storage bucket, writes your `wrangler.jsonc`, applies the migrations, publishes the Worker, turns on Email Routing for the domain and points its catch-all at CFMail. Then open `https://mail.example.com` and create the first admin account.

这就是全部安装过程。第三条命令会建数据库和存储桶、生成你的 `wrangler.jsonc`、跑迁移、发布 Worker、为该域名启用 Email Routing 并把 catch-all 指向 CFMail。之后打开 `https://mail.example.com` 创建第一个管理员账号。

- **The token is never stored.** It is used for this one run and passed to `wrangler` through the child process's environment — it is not written to `wrangler.jsonc`, not to a dotfile, not to the log. Closing the terminal is enough to be rid of it. (`CLOUDFLARE_API_TOKEN` in the environment works too, if you would rather not have it in your shell history.)
  **token 不会被保存。** 它只用于这一次运行,通过子进程的环境变量交给 `wrangler`,不写进 `wrangler.jsonc`、不写进任何 dotfile、不打印到日志。关掉终端就没了。(不想让它留在 shell 历史里,也可以放在环境变量 `CLOUDFLARE_API_TOKEN` 里。)
- **Running it again is safe.** Every step checks the account first: an existing database or bucket is reused, never recreated; migrations only add. That is also how you upgrade — `git pull` and run the same command.
  **重复运行是安全的。** 每一步都先查账号:已有的数据库和存储桶直接复用,绝不重建;迁移只做加法。升级也是这么做 —— `git pull` 之后跑同一条命令。
- **Adding a domain** is the same command with a different `--domain`; `--entry` is remembered, so you only pass it the first time.
  **加域名**就是换个 `--domain` 再跑一次;`--entry` 会被记住,只需在第一次给。
- **`--dry-run`** reports exactly what it would do and changes nothing.
  **`--dry-run`** 会把打算做的事完整报一遍,不做任何改动。

> **What are `npx` and `wrangler`?** `npx` ships with Node.js (18+) — it runs a command-line tool out of `node_modules` without installing anything globally. `wrangler` is Cloudflare's official CLI; it is listed in this project's `devDependencies`, so `npm install` already put it there. `npm run deploy` drives it for you; the `npx wrangler …` commands further down are for the occasional thing you do by hand. There is nothing extra to install, and nothing to log into — the token you pass is what authenticates.
>
> **`npx` 和 `wrangler` 是什么?** `npx` 是 Node.js(18+)自带的命令,作用是直接运行 `node_modules` 里的命令行工具,不用全局安装。`wrangler` 是 Cloudflare 官方 CLI,已写在本项目的 `devDependencies` 里,`npm install` 时就装好了。`npm run deploy` 会替你调用它;后文那些 `npx wrangler …` 是留给偶尔手工操作用的。不需要另外装任何东西,也不需要登录 —— 认证靠你传进去的那个 token。

Where the token comes from: **Cloudflare Dashboard → My Profile → API Tokens → Create Token → Custom token**, with the permissions in the table below. An account-owned token (Manage Account → API Tokens) works just as well.
token 从哪来:**Cloudflare Dashboard → My Profile → API Tokens → Create Token → Custom token**,权限按下面的表格勾。账号级 token(Manage Account → API Tokens)同样可用。

Adding more domains later, and upgrading, are the same command:
之后加域名、升级,都是同一条命令:

```bash
npm run deploy -- --token <token> --domain another.com   # --entry 沿用第一次的前缀
git pull && npm install && npm run deploy -- --token <token>
```

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

- You pick the prefix with `--entry` the first time. Every later run reads it back out of `routes`, so every domain gets the same one and you never pass it again.
  前缀由第一次的 `--entry` 决定。之后每次运行都从 `routes` 里读回来,保证各域名一致,你也不用再传第二遍。
- Deploying reconciles live custom domains against `routes`, so a domain missing from that array would be detached. `npm run deploy` protects you from doing that by accident: any host that is live but absent from the file is added back before publishing. Pass `--prune-domains` when detaching is what you actually mean — that is how a domain is taken offline.
  部署会拿 `routes` 跟线上自定义域对账,不在数组里的域名会被摘掉。`npm run deploy` 会防止你误伤:线上有、文件里没有的入口域,发布前会被补回数组。确实要下线某个域名时,加 `--prune-domains`。
- `APP_ORIGIN` is what invite and password-reset links point at; `npm run deploy` keeps it equal to the first entry, so it is not something you maintain by hand.
  `APP_ORIGIN` 是邀请链接和密码重置链接的指向;`npm run deploy` 会让它始终等于第一条 route,不用你手工维护。
- The pattern must be `<subdomain>.<zone>`: the scripts derive the Cloudflare zone by dropping the leftmost label.
  格式必须是 `<子域>.<域名>`:脚本靠"去掉最左一段"推导 Cloudflare zone。

---

## API token permissions / API Token 权限

Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Custom token**. An account-owned token from **Manage Account → API Tokens** works too.
Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Custom token**;**Manage Account → API Tokens** 下创建的账号级 token 同样可用。

### Required / 必需

| Scope | Permission | Access | Used for / 用来做什么 |
|---|---|---|---|
| Account | **Workers Scripts** | Edit | `wrangler deploy`, `wrangler secret put` |
| Account | **D1** | Edit | Create the database, run migrations / 建库、跑 migrations |
| Account | **Workers R2 Storage** | Edit | Create the bucket, store raw messages / 建桶、读写原始邮件 |
| Zone | **Zone** | Read | Look up zone ids by domain name / 按域名查 zone id |
| Zone | **DNS** | Edit | Bind the entry custom domain, publish mail records / 绑定入口自定义域、下发邮件记录 |
| Zone | **Email Routing Rules** | Edit | Enable Email Routing, point catch-all at the Worker / 启用 Email Routing、设 catch-all |
| Zone | **Email Sending** | Edit | Onboard the domain so it may send to outside recipients / 开通对外发信 |
| Zone | **Workers Routes** | Edit | Attach custom domains to the Worker / 把自定义域挂到 Worker 上 |

> Without **Email Sending**, everything else still works and the domain still receives mail — but it cannot send to the outside world, and the first thing to break is the verification code mailed to a new colleague's personal address. `npm run deploy` says so plainly when it hits that.
> 少了 **Email Sending** 这项,其余一切照常、收信也正常 —— 但这个域名发不出信,最先坏掉的是发往新同事私人邮箱的那封验证码。`npm run deploy` 遇到这种情况会明确说出来。

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

### 1. What `npm run deploy` does / 它到底做了什么

In order, checking the account's current state before each step so that running it twice is the same as running it once:
按顺序,每一步动手前先读账号当前状态 —— 所以跑两次和跑一次结果一样:

| Step / 步骤 | Idempotent because / 为什么可重复 |
|---|---|
| Verify the token and resolve the account / 校验 token、确定账号 | Read-only. Refuses to guess when the token can see several accounts — pass `--account` / 只读。token 能看到多个账号时拒绝猜,要你用 `--account` 指定 |
| Look for a Worker, database and bucket already named `cfmail` / 查有没有同名的 Worker、数据库、存储桶 | Read-only. If they exist but this checkout has no `wrangler.jsonc`, it stops rather than publish over somebody else's deployment — `--adopt` says you mean it / 只读。若它们存在而本地没有 `wrangler.jsonc`,脚本停下来,不会覆盖别人的部署 —— 确实是你的,用 `--adopt` |
| Create the D1 database and the R2 bucket / 建 D1 与 R2 | Only when missing; an existing one is reused, with its data / 只在缺失时建;已有的直接复用,数据不动 |
| Write `wrangler.jsonc` / 写配置文件 | Generated from the template and your arguments. Fills `account_id`, `database_id`, `APP_ORIGIN`, appends the route / 由模板加你的参数生成:填好 `account_id`、`database_id`、`APP_ORIGIN`,追加 route |
| Keep live custom domains / 保住线上已有的入口域 | Anything bound on the account but missing from `routes` is added back, so a fresh clone cannot detach domains it never knew about / 线上绑了但配置里没有的,补回数组 —— 新 clone 不会把它没见过的域名摘掉 |
| Apply migrations / 跑迁移 | Migrations only add; `wrangler` runs just the ones not yet applied, and the script re-checks afterwards that none are left / 迁移只做加法;wrangler 只跑没跑过的,脚本事后再查一遍确认没有遗留 |
| Publish the Worker / 发布 Worker | Same code, same result / 同样的代码,同样的结果 |
| Enable Email Routing, point catch-all at the Worker / 启用 Email Routing、catch-all 指向 Worker | Enabling is skipped when already on; the catch-all rule is a `PUT` / 已开启就跳过;catch-all 本身是 `PUT` |

`wrangler.jsonc` is **not** in the repository — it holds your account id, database id and domains, and `npm run deploy` generates it. Losing it costs nothing: the next run rebuilds it from the account.
`wrangler.jsonc` **不在仓库里** —— 它含你的 account_id、database_id 和域名,由 `npm run deploy` 生成。丢了也不要紧:下次运行会照着账号里的现状重建。

### 2. Connect another domain / 再接一个域名

```bash
npm run deploy -- --token <token> --domain another.com
```

Same command, different `--domain`. It enables Email Routing (publishing MX/SPF), points the catch-all at the Worker, adds `<entry>.<domain>` to `routes` and republishes, which is what binds the custom domain.
同一条命令,换个 `--domain`。它会启用 Email Routing(下发 MX/SPF)、把 catch-all 指向 Worker、把 `<入口子域>.<域名>` 加进 `routes` 并重新发布 —— 自定义域就是这样绑上去的。

> **Careful**: enabling Email Routing takes over that domain's MX records, and the catch-all rule is repointed at the Worker. If the domain already receives mail — forwarding to a personal address, say — that stops. Check the domain's existing Email Routing rules before connecting it.
> **注意**:启用 Email Routing 会接管该域名的 MX 记录,catch-all 也会被改指向 Worker。如果这个域名原本在收信(比如转发到某个私人邮箱),那就会停。接入前先看一眼该域名现有的 Email Routing 规则。

If you use Turnstile, run `node scripts/setup-turnstile.mjs` again after connecting a domain: a widget only answers for the hostnames on its own allowlist, and a new entry host is not on it yet. The script syncs the list and leaves the sitekey alone, so no redeploy is needed.
用了 Turnstile 的话,接完域名再跑一次 `node scripts/setup-turnstile.mjs`:widget 只对自己允许列表里的主机名作答,新的入口主机还不在里面。脚本会同步列表且不动 sitekey,不需要重新部署。

### 3. Hardening / 加固(可选,但建议做)

```bash
export CLOUDFLARE_API_TOKEN=<token>   # PowerShell: $env:CLOUDFLARE_API_TOKEN="<token>"
node scripts/setup-turnstile.mjs      # create the widget, wire up both halves
node scripts/push-ratelimit.mjs       # push edge rate-limit rules to every zone
npm run deploy -- --token $CLOUDFLARE_API_TOKEN
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
| **Invites / 邀请** | Generate signup links. Pick the kind first — one person once, or a link a whole team registers through until it expires — then, for a single-use link, whether the mailbox name is pinned and who may use it / 生成注册链接。先选类型:单人一次性,或整队人共用直到过期;单人链接再选限不限定邮箱名、限不限定使用者 |
| **Drive / 网盘** | Turn the Drive on per domain, set the default quota, override it for one user / 按域名开启网盘、设默认配额、单独调整某个用户 |
| **Unrouted / 未匹配来信** | Mail sent to addresses that don't exist. Remote images stripped before display / 发给不存在地址的邮件,展示前剥掉远程图片 |
| **Import / 导入工具** | Bring in `.eml` archives from an old provider / 把旧服务商导出的 `.eml` 搬进来 |
| **Export / 导出工具** | Write mailboxes back out to a local folder as `.eml` / 把邮箱写回本地目录 |
| **Audit log / 审计日志** | Who did what, downloadable as CSV or JSONL / 谁做了什么,可下载 CSV 或 JSONL |
| **Backup / 备份** | Switch the nightly backup on, pick the hour, download any archive, or sync them all into a local folder / 打开每晚的自动备份、选时刻、下载任意一份包,或把它们全部同步到本地目录 |

### As a user / 普通用户

Sign in with **either** the personal email used at signup **or** a company address you own — both share one password.
用**注册时的个人邮箱**或**你作为所有者的企业邮箱**登录都行 —— 两者共用同一个密码。

Beyond ordinary mail: full-text search, conversation threading, rich-text composing with client-side image resizing, per-user interface and body fonts, light/dark/auto, 9 interface languages.
除常规收发外:全文搜索、会话聚合、富文本编辑(图片在浏览器端缩放)、每用户可选字体、明暗自动、9 种界面语言。

Where the domain has the Drive enabled, the nav bar carries an entry to it — the two subsystems sit side by side rather than one inside the other, and either entry can be right-clicked to open in a new window. Your Drive space is your own across every domain you hold a mailbox in.
如果所在域名开了网盘,导航栏上会有网盘入口 —— 两个子系统是并列关系,不是一个套在另一个里面;任一入口都可以右键在新窗口打开。你的网盘空间跨域名归你个人,不随邮箱域名分裂。

### Adding people / 加人进来

1. Admin console → **Invites** → generate a link / 管理后台 → **邀请** → 生成链接
2. Send the link to your colleague / 把链接发给同事
3. They set a password, confirm a code sent to their personal email, and they're in / 对方设密码、输入发到其个人邮箱的验证码,就进来了

---

## Backup / 备份

Off by default. Turn it on in the admin console under **Backup**, pick the hour, and once a day
the mail side of the deployment is packed into one file you can download and keep anywhere.

默认关闭。在后台 **备份** 页签打开、选好时刻,此后每天邮件一侧的数据会被打成一个文件,
你可以下载下来放到任何地方。

### What is in an archive / 包里有什么

```
daily/2026-08-23.7z      整库 SQL(22 张表)+ 当天新到与当天导入的邮件原件(含附件)
monthly/2026-08.zip      当月各份日包,原样收进来(zip store,不重压)
yearly/2026.zip          当年各份月包,同上
```

Each message appears in exactly one daily -- the one for the day it arrived -- so nothing is
stored twice. A monthly is a container of that month's dailies and a yearly a container of that
year's monthlies, so restoring any given day means opening at most three nested files. On the
first of a month last month's dailies are folded and deleted; on 2 January the same fold makes a
year.

每封信只出现在它到达那一天的日包里,所以没有任何东西被存两次。月包是当月日包的容器,
年包是当年月包的容器,于是要恢复某一天,最多打开三层文件。每月 1 号折叠并删除上月日包,
每年 1 月 2 号同样折出年包。

Days are cut at **UTC+0**, and a run backs up the day that has just ended. Not included:
Drive, the AI assistant, live sessions, and short-lived tokens -- restoring a login is not
restoring data.

按 **UTC+0** 切分,每次备份的是刚结束的那一天。不含网盘、AI 助手、登录态和短期令牌 ——
恢复一个登录态不叫恢复数据。

### Where it runs / 跑在哪儿

In a container, not in the Worker. A Worker has thirty seconds of CPU, 128 MB, and no LZMA; this
job compresses with 7-Zip and takes as long as it takes. The Worker starts the container, asks
once a minute how it is going, and stops it the moment it reports done -- a container still
running is a container still being charged for.

在容器里,不在 Worker 里。Worker 只有三十秒 CPU、128 MB 内存,而且没有 LZMA;
这个任务用 7-Zip 压缩,该跑多久跑多久。Worker 负责起容器、每分钟问一次进展、
一做完立刻停掉 —— 还在跑的容器是还在计费的容器。

The container has no bindings, so it reaches Cloudflare on its own: R2 over the S3 API, D1 over
REST, both on one token. R2 derives its S3 credentials rather than issuing them -- the access key
is the token's id and the secret is the SHA-256 of its value -- so one token is enough.

容器没有 binding,所以它自己够到 Cloudflare:R2 走 S3 接口,D1 走 REST,共用一个 token。
R2 的 S3 凭据是推导出来的(access key = token 的 id,secret = token value 的 SHA-256),
所以一个 token 就够。

### Turning it on / 怎么开起来

The image has to be built and pushed once. **This is the only step that needs Docker** -- ordinary
deploys reference the image from the registry and do not.

镜像要先构建推送一次。**这是唯一需要 Docker 的一步** —— 日常部署引用仓库里的镜像,不需要 Docker。

```sh
# 1. 构建并推送镜像(需要 Docker;Windows 上用 WSL 里的 Docker 也可以)
npx wrangler containers build ./container \
  --tag registry.cloudflare.com/<account-id>/cfmail-backup:1 --push

# 2. 部署时带上备份用的 token,它会被存成 wrangler secret
node scripts/deploy.mjs --token <deploy token> --backup-token <backup token>
```

`--backup-token` is separate from `--token` on purpose: the deploy token lives only in the memory
of that one run, while the backup token stays in the Worker as a secret. Give the backup one only
**Account → D1 · Read** and **Account → Workers R2 Storage · Edit**; it needs nothing else.

`--backup-token` 与 `--token` 分开是有意的:部署 token 只活在那一次运行的内存里,
而备份 token 会作为 secret 长期留在 Worker 里。给它 **Account → D1 · Read** 和
**Account → Workers R2 Storage · Edit** 就够,别的一概不需要。

Without the image, or without the token, the console says so and the switch stays off. A
deployment with neither is simply a deployment without backups.

镜像没构建、或 token 没给,后台会直说,开关也开不起来。两样都没有的部署,就是一套没有备份的部署。

### Restoring / 恢复

Open the archive. `database.sql` is a plain SQL dump -- `wrangler d1 execute <db> --remote
--file=database.sql` puts it back -- and `mail/` holds the message files under their original
storage keys. Afterwards rebuild the search index:

打开包。`database.sql` 就是普通的 SQL dump,`wrangler d1 execute <db> --remote --file=database.sql`
即可写回;`mail/` 下面是按原始存储 key 排好的邮件原件。之后重建一次全文索引:

```sh
npx wrangler d1 execute cfmail --remote \
  --command "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"
```

The index is deliberately not in the backup: it is derived from `message_texts`, and D1 refuses to
export a database that contains a virtual table at all -- which is why the backup names its
twenty-two tables explicitly rather than asking for everything.

索引有意不进备份:它是从 `message_texts` 派生的,而且 D1 根本拒绝导出含虚拟表的数据库 ——
这也正是备份显式点名那 22 张表、而不是"全都要"的原因。

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
- Storage: one D1 database (accounts, permissions, message metadata, FTS5 index, Drive tree, audit log), one R2 bucket (raw MIME, attachments, uploads, Drive contents, font cache).
  存储:D1 一个库,R2 一个桶。
- No Queues — an outbox table plus Cron is simpler at this scale.
  不用 Queues,当前量级 outbox 表 + Cron 更简单。
- **The Drive keeps its bytes in R2 and its shape in D1.** Contents live under one prefix per user, so a person's files stay together across every domain they hold a mailbox in; the folder tree, quotas, shares and trash are rows. Uploads go straight to R2 (multipart above 90 MB) and downloads are served with Range support, so the Worker never buffers a file.
  **网盘的字节在 R2,形状在 D1。** 内容按用户各占一个前缀,所以一个人的文件跨域名聚在一起;
  目录树、配额、分享、回收站都是表里的行。上传直传 R2(超过 90MB 走分片),下载支持 Range,
  Worker 从不把文件缓进内存。
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
- Each sending domain must be onboarded once, which `npm run deploy` does for you (`wrangler email sending enable <domain>`); DKIM/SPF/DMARC and bounce records publish automatically. If the token lacks **Email Sending · Edit** it says so and you can click it instead: Dashboard → **Compute → Email Service → Email Sending → Onboard Domain**.
  每个发信域名要开通一次,`npm run deploy` 会替你做(`wrangler email sending enable <域名>`),DKIM/SPF/DMARC 和 bounce 记录自动下发。token 少了 **Email Sending · Edit** 时它会说明,你也可以到 Dashboard → **Compute → Email Service → Email Sending → Onboard Domain** 点一次。
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
- Drive previews inherit the same rule: HTML and MHTML render in a fully sandboxed frame with no scripts and no network, SVG is always an image, and a wrong guess at a file id returns 404 rather than 403 — a share link never reveals what exists behind it.
  网盘预览沿用同一套规则:HTML/MHTML 进无脚本无联网的全沙箱框架,SVG 一律当图片,猜错文件 id 返回 404 而不是 403 —— 分享链接不会泄露背后有什么。
- Archive passwords are used in the tab and never sent: the key derivation and the cipher both run in the browser through WebCrypto.
  压缩包密码只在标签页内使用、从不外发:密钥派生与解密都在浏览器里经 WebCrypto 完成。
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
- CJK search uses LIKE, Latin search uses FTS5. Drive search matches file and folder names, not their contents.
  中日韩搜索走 LIKE,拉丁文走 FTS5。网盘搜索匹配文件与文件夹名,不搜内容。
- The export tool needs the File System Access API — Chrome or Edge only.
  导出工具依赖 File System Access API,只支持 Chrome / Edge。
- Drive: single-shot upload caps at 90 MB, larger files go multipart in 32 MB parts. Trash self-purges after 30 days and counts against quota until it does — emptying it releases the space immediately.
  网盘:单次上传上限 90MB,更大的走 32MB 分片。回收站 30 天后自动清空,在此之前仍占配额 —— 手动清空立即释放。
- Archives are read-only, and thumbnail-less inside. zip is fully supported including nesting and ZipCrypto; 7z covers Copy, LZMA1, LZMA2 and AES-256 with the delta and x86 filters, while PPMd, bzip2 and BCJ2 report a clean "unsupported". rar is not read.
  压缩包只读,内部不生成缩略图。zip 完整支持,含嵌套与 ZipCrypto;7z 支持 Copy、LZMA1、LZMA2、AES-256 及 delta/x86 过滤器,PPMd、bzip2、BCJ2 明确报"不支持"。不支持 rar。
- Previews are renderers, not the original applications: a docx keeps its text, tables and pictures but not Word's pagination (the file has no notion of pages); a pptx is drawn from its shape tree; a workbook shows values and basic formats, capped at 800 rows per sheet with a note when it is cut. SVG is always rendered as an image, never inlined.
  预览是渲染器,不是原应用:docx 保留文字、表格和图片,但没有 Word 的分页(文件里根本没有"页"这个概念);pptx 按形状树绘制;工作簿显示值和基本格式,每张表最多 800 行,截断时会给出提示。SVG 一律按图片渲染,绝不内联。

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

Release checklist / 发布清单: edit code → run `build-themes.mjs` if themes changed → `npm run typecheck` → `npm run deploy -- --token <token>` (it applies any new migrations first, and stops before publishing if one fails).
改代码 → 动过主题就跑 `build-themes.mjs` → `npm run typecheck` → `npm run deploy -- --token <token>`(它会先跑新迁移;迁移失败就停在发布之前)。

---

## Layout / 目录结构

```
migrations/                    # D1 schema, applied in order / D1 schema,按序号递增
src/
  index.ts                     # fetch / email / scheduled entry points / 三入口
  api.ts                       # application API (Hono) / 业务 API
  drive.ts                     # Drive API: tree, quotas, uploads, shares / 网盘 API:目录树、配额、上传、分享
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
  assets/drive/                # the Drive client: previews, thumbnails, archive readers
                               # 网盘前端:预览、缩略图、压缩包读取器
    preview.js doc.js pptx.js sheet.js thumb.js    # renderers / 各类渲染器
    rzip.js r7z.js lzma.js arcrypto.js arc.js      # ranged zip/7z, LZMA, decryption / Range 读取与解密
    arc-sw.js lazypage.js fsrc.js pub.js           # streaming worker, page scheduler, byte source, share page
  vendor/                      # third-party browser libs, not committed / 不入库
  tools/Export-Mailbox.ps1     # Microsoft 365 mailbox exporter / M365 导出脚本
scripts/
  sync-vendor.mjs              # sync public/vendor/ from node_modules (postinstall)
  deploy.mjs                   # install and upgrade: resources, config, migrations, publish, mail routing
                               # 安装与升级:建资源、生成配置、跑迁移、发布、接收信
  wrangler-config.mjs          # reads wrangler.jsonc, feeds domains/zones to other scripts
  setup-turnstile.mjs          # create the Turnstile widget / 建 Turnstile widget
  push-ratelimit.mjs           # push edge rate-limit rules / 推限速规则
  build-themes.mjs             # generate themes / 生成主题
  import-eml.mjs               # command-line import / 命令行导入
```

---

## License / 许可

MIT — see [LICENSE](LICENSE). Third-party components and their notices are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
MIT,第三方组件及其声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
