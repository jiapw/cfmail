# CFMail — Enterprise Webmail on Cloudflare / 基于 Cloudflare 的企业 Webmail

Run your company's email **and its file storage** on your own Cloudflare account. Receiving, storage and the web client all live inside **your** account — nothing is hosted by anyone else.

把公司的邮件系统**和网盘**跑在**你自己的** Cloudflare 账号里。收信、存储、网页客户端,全部在你的账号内,没有任何一部分托管在别人那里。

MIT licensed ([LICENSE](LICENSE)). Data-flow and privacy details in [PRIVACY.md](PRIVACY.md).
MIT 授权,数据流与隐私说明见 [PRIVACY.md](PRIVACY.md)。

> **No telemetry, no phone-home, no license server.** Grep the source and see for yourself.
> **没有遥测、没有回家调用、没有 License 校验服务器。** 可以全文搜索验证。

---

## What you get / 功能

Four peer subsystems behind one sign-in and one nav bar: **Mail**, **Forms**, **Drive** and **Meetings**.
一次登录、一条导航栏,后面是四个平级的子系统:**邮件**、**表单**、**网盘**和**会议**。

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

### Forms / 表单

- **Surveys and feedback sheets, answered by mail / 问卷与反馈表,答复以邮件送达** — design a form, hand out one permanent link, and every answer arrives in the inboxes you named as a message from the person who filled it in: their local time and time zone, the form version, their IP address with the country and city Cloudflare resolves it to, and every question with its answer. Nothing is stored anywhere else.
  设计一份表单、发出一条永久链接,每份答复都以填写者的名义作为一封邮件送达你指定的收件箱:本地时间与时区、表单版本、IP 及 Cloudflare 解析出的国家和城市,以及每道题与答案。答复不另存于任何地方。
- **Fourteen question types / 十四种题型** — short and long text, yes/no, single and multiple choice (each option with its own explanation), whole and decimal numbers, date, country, address, one or several files, one or several images. Every question can carry an explanation behind a **?** button.
  单行/多行文本、是/否、单选/多选(每个选项可带解释)、整数/小数、日期、国家、地址、单个/多个文件、单张/多张图片。每道题都可以带一个点 **?** 展开的解释。
- **Public or internal / 公开或内部** — a public form takes a name and an email address, optionally proven by a code at submit time; an internal form is for signed-in members and fills their address in for them.
  公开表单填姓名和邮箱,可选在提交时用验证码证明地址;内部表单仅限登录成员,地址自动填入。
- **Subject templates / 主题模板** — `{sender}`, `{email}`, `{form}`, `{version}` and the key of any short-answer question, so the inbox sorts itself.
  主题可引用 `{sender}`、`{email}`、`{form}`、`{version}` 和任何短答题的标识,收件箱自然就分好了类。
- **Where the answers go / 答复保存方式** — per form: mail only (nothing kept), keep in CFMail with a link in the mail, or keep and mail everything. Kept answers, files included, open from the form's own list for the designer and for whoever holds a recipient mailbox, and stay until deleted.
  按表单选择:只发邮件(不保存)、保存在 CFMail 且邮件只带链接、或保存并把完整内容发邮件。保存的答复(含文件)由设计者和持有接收邮箱的人从表单列表打开,一直保留到删除。
- **Multilingual by itself / 自动多语言** — tick the languages to offer; a Workers AI model translates your texts (which model and which prompt is set once, under Admin → Models), the fill page opens in the visitor's browser language and lets them switch, and links can pre-fill answers (`#/f/<token>?name=…&q1=…`).
  勾选要提供的语言,由 Workers AI 模型翻译你的文本(用哪个模型、什么提示词在 后台 → 大模型 里统一设定);填写页按访问者浏览器语言打开、可切换;链接可带参数预填(`#/f/<token>?name=…&q1=…`)。
- **Versions, on/off, permanent links / 版本、停用、永久链接** — every saved change bumps the version and the answer mail says which one it was written against; a disabled form shows a notice at the same link; deleting is the only thing that ends a link. The fill page is shown in the look the designer chose -- palette, light or dark, typeface, text size -- and visitors pick only their language. A new form starts with the settings of the one made before it.
  每次保存改动都递增版本号,答复邮件写明对应版本;停用后同一链接显示停用提示;只有删除才会让链接失效。填写页默认跟随设计者的明暗模式,访问者可自行切换。

### Meetings / 会议

Off on every domain until an administrator switches it on (admin console → Meetings), and broadcast meetings have a switch of their own there. A deployment that has not been given what meetings need — a Realtime app, see the permissions below — shows no Meetings entry at all.
每个域名都默认关闭,由管理员在后台 → 会议 里按域名打开;直播会议在那里另有一个开关。部署还没拿到会议所需的东西(Realtime app,见下文权限)时,界面上根本不出现「会议」入口。

- **Voice, optional video, one screen at a time / 语音、可选视频、同一时刻一块屏幕** — a meeting for up to 32 people (the ceiling is set per domain) on Cloudflare's Realtime SFU. Media goes browser to Cloudflare and nowhere else; the Worker only does the signalling, and nothing about who was in a call is stored.
  最多 32 人的会议(上限按域名设定),跑在 Cloudflare 的 Realtime SFU 上。媒体只在浏览器与 Cloudflare 之间流动;Worker 只做信令,也不记录谁参加了哪一场。
- **Everybody the same, and as large as fits / 人人等大,尽量大** — no "main speaker" and nothing to ask for: everybody's camera is the same kind of picture, laid out as the largest equal tiles the window allows (two people side by side on a wide screen, one above the other on a phone). The resolution chosen when the meeting is made — 480p, 720p or 1080p — is what a camera is sent at while two people talk; with more on screen it steps down by itself, so the traffic does not grow with the square of the room. One person at a time can share a screen, which then takes the large area with everybody beside it. A meeting can also be made audio-only.
  没有「主讲人」,也没有什么需要申请:每个人的摄像头都是同一种画面,排成窗口放得下的最大等大格子(宽屏上两人左右并排,手机上上下叠放)。创建会议时选定的画幅(480p / 720p / 1080p)是两人对谈时摄像头的发送清晰度;同屏人数多了会自动降档,流量不会随人数平方增长。同一时刻可以有一个人共享屏幕,屏幕占大区,其余人排在旁边。会议也可以设成纯音频。
- **End-to-end encryption / 端到端加密** — a switch on a small meeting. The organiser's browser makes a secret and puts it in the meeting's link after the `#`, the part of an address browsers never send to a server; it is kept only on the devices that open that link, and the organiser passes the full link on themselves, by whatever way they trust. Sound and pictures are encrypted frame by frame in each browser (AES-256-GCM, a key per sender derived from the secret), so neither Cloudflare nor this server can read them. Invitation mails go out without the secret. Not available for broadcasts, and there are no minutes of an encrypted meeting.
  小组会议的一个开关。组织者的浏览器生成一个秘密,放在会议链接 `#` 之后 —— 地址里浏览器从不发给服务器的那一段;它只保存在打开过这条链接的设备上,完整链接由组织者自己用信任的方式转交。声音和画面在每个浏览器里逐帧加密(AES-256-GCM,每个发送者一把由秘密派生的钥匙),Cloudflare 和这台服务器都读不到。邀请邮件不带秘密。直播会议不能加密,加密会议也不能生成纪要。
- **Guests, by link / 访客凭链接加入** — off by default. Switched on for a meeting, people with no account join by a separate guest link, either straight in or waiting at the door until the host lets them in.
  默认关闭。为某场会议打开后,没有账号的人凭一条单独的访客链接加入:直接进,或在门口等主持人放行。
- **The host's tools / 主持人的工具** — let in or turn away, ask people to mute, remove somebody, lock the meeting, stop somebody's screen share, end it for everyone. Chat and raised hands for all; none of it is saved.
  放行或拒绝、请人静音、移出某人、锁定会议、停止某人的屏幕共享、为所有人结束会议。人人可聊天、举手;这些都不保存。
- **Broadcast meetings / 直播会议** — up to eight speakers in the room, and any number of people watching one composited picture (the speakers as equal tiles, or a shared screen with the speakers beside it; names under each) through Cloudflare Stream, about ten seconds behind. The organiser chooses who may watch — anybody with the link, or signed-in colleagues only, enforced on the video itself by signed playback addresses — and whether Stream's recording is kept. Off until the deployment is given a Stream token and a compositor image; see the permissions table below.
  房间里最多八位发言人,不限人数的旁观者经 Cloudflare Stream 观看一路合成画面(发言人等大宫格,或共享屏幕加旁边一列发言人;每格压名字),延迟约十秒。谁可以旁观由组织者选定 —— 任何持有链接的人,或仅已登录的同事,靠签名播放地址落实到视频本身 —— 是否保留 Stream 的录像也由组织者选。在部署拿到 Stream 令牌与合成器镜像之前保持关闭,见下文权限表。
- **The audience can talk and ask to speak / 旁观者聊天与申请发言** — beside the picture, a chat among the viewers and with the stage (hosts and speakers read and answer it in an "Audience" tab of the room's chat), a head count, and a button to ask to speak. A host who says yes sends that one viewer a ticket; it walks them into the room as a speaker — past the guest switch, the waiting room and a locked door, though not past the speaker limit — and back to watching when they leave. Viewers who are not signed in give a name and pass Turnstile once before they can say anything, and their names are marked as a guest's. Hosts can take a line down or silence whoever wrote it. The chat can be switched off per meeting; asking to speak stays.
  画面旁边是观众之间、观众与台上的聊天(主持人和发言人在房间聊天的「观众」页签里看和回)、在看人数,以及「申请发言」按钮。主持人点「允许」,就给这一位观众发一张入场券:凭它以发言人身份走进会场 —— 不看访客开关、不进等候室、不受锁定限制,但受发言人上限 —— 离开会场就回到观看。未登录的观众要先留名并过一次 Turnstile 才能说话,名字旁标「访客」。主持人可以撤下一句,或禁言说这句的人。聊天可按会议关掉;申请发言照常。
- **Invitations that are mail / 邀请就是邮件** — sent from the organiser's own mailbox: straight into the inbox of anybody with an account here, out through the sending channel for anybody else, with a calendar file (`.ics`) when the meeting has a time. A meeting can be scheduled, or be a permanent room whose link never stops working.
  邀请从组织者自己的邮箱发出:在这里有账号的人直投收件箱,其余人走发信通道;定了时间的会议附带日历文件(`.ics`)。会议可以预约,也可以是一间链接长期有效的常驻会议室。
- **Recording into the host's Drive / 录制进主持人的网盘** — off unless the organiser allows it. The host's browser records the gallery (or the shared screen, while there is one) with everybody's sound, at the meeting's resolution, as an MP4 that is uploaded *while* it is being made — a laptop closed on the way out costs the last few seconds, not the meeting. Everybody sees a "Recording" mark while it runs.
  默认关闭,须由组织者允许。主持人的浏览器按会议的画幅录下画廊(有人共享屏幕时录屏幕)和所有人的声音,录成 MP4,并且**边录边传** —— 散会时合上笔记本,丢的是最后几秒,而不是整场会。录制期间所有人都能看到「正在录制」标记。
- **Transcript and minutes / 文字稿与纪要** — a separate tick when starting a recording. The sound is put into words by the speech model on Workers AI (silence is filtered out first, so nothing is invented for it), summed up by the domain's chat model into summary, points, decisions and action items, and saved as Markdown next to the recording. The host reads the minutes first, and mails them to the invitees with one click if they are fit to send.
  开始录制时单独勾选。声音由 Workers AI 的语音模型转成文字(先滤掉静音,所以不会为沉默编造内容),再由该域名的对话模型写成摘要、要点、决定与待办,以 Markdown 存在录像旁边。主持人先过目,觉得可以发,再一键寄给受邀人。

### Both / 两边共用

- **Admin console / 管理后台** — per-domain stats, mailbox and alias management, branding, Drive quotas, unrouted-mail inspection, audit log.
  分域名统计、邮箱与别名管理、品牌设置、网盘配额、未匹配来信查看、审计日志。
- **Migration tools / 迁移工具** — import `.eml` from Zoho / Outlook / anywhere, export mailboxes back to a local folder. Includes a PowerShell script that pulls a Microsoft 365 mailbox via the Microsoft Graph API.
  从 Zoho / Outlook 等导入 `.eml`,也能把邮箱导出回本地。附带一个用 Microsoft Graph API 拉取 Microsoft 365 邮箱的 PowerShell 脚本。
- **9 UI languages / 9 种界面语言**, 30 built-in themes, light/dark/auto, and a font picker for interface and body text.
  30 套内置主题,明暗自动切换,界面与正文字体可自选。
- **A phone layout of its own / 手机有自己的版式** — drawers instead of sidebars, bottom action
  sheets instead of context menus, an album-style photo viewer with edge-to-edge swiping, the
  system share sheet for saving files, and a top bar that rides the scroll. Landscape is treated
  as a phone, not a small desktop.
  抽屉代替侧栏、底部动作单代替右键菜单、相册式看图左右滑、保存走系统分享面板、
  顶栏跟着滚动收放。横屏按手机对待,而不是当成一台小桌面。

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
| Meetings / 会议 | ✅ Runs on the free tier / 免费额度即可跑 | Realtime gives each account 1,000 GB of outgoing media a month, then $0.05/GB. Six people at 720p use about 6 GB an hour; thirty-two use about 60 / Realtime 每账号每月 1000 GB 出向流量免费,之后 $0.05/GB。6 人 720p 约 6 GB/小时;32 人约 60 GB/小时 |
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
npm install --omit=dev
npm run deploy -- --token <your API token> --domain example.com --entry mail
```

That is the whole installation. The third command creates the database and the storage bucket, writes your `wrangler.jsonc`, applies the migrations, publishes the Worker, turns on Email Routing for the domain and points its catch-all at CFMail. Then open `https://mail.example.com` and create the first admin account.

这就是全部安装过程。第三条命令会建数据库和存储桶、生成你的 `wrangler.jsonc`、跑迁移、发布 Worker、为该域名启用 Email Routing 并把 catch-all 指向 CFMail。之后打开 `https://mail.example.com` 创建第一个管理员账号。

`--omit=dev` skips what only development needs (TypeScript, test tooling, the theme-palette source) — everything installing and deploying require, `wrangler` and the build of the browser bundles included, is a regular dependency. To work on the code, run plain `npm install` instead; either way the install ends by syncing `public/vendor/` and telling you what it did.

`--omit=dev` 跳过只有开发才需要的东西(TypeScript、测试工具、主题色板源)——安装和部署所需的一切,包括 `wrangler` 和浏览器端 bundle 的构建,都是正式依赖。要改代码就直接 `npm install`;两种装法结束时都会同步 `public/vendor/` 并逐步说明它做了什么。

- **The token is not stored — unless you ask.** By default it is used for this one run and passed to `wrangler` through the child process's environment — not written to `wrangler.jsonc`, not to a dotfile, not to the log; closing the terminal is enough to be rid of it. (`CLOUDFLARE_API_TOKEN` in the environment works too, if you would rather not have it in your shell history.) When you type the token in interactively, the script offers — once it has validated — to save it to `.env.deploy.token` so the next run does not ask; the file is gitignored by name, stays on your machine, loses to `--token` and the environment variable, and deleting it undoes the choice.
  **token 默认不保存 —— 除非你要求。** 默认它只用于这一次运行,通过子进程的环境变量交给 `wrangler`,不写进 `wrangler.jsonc`、不写进任何 dotfile、不打印到日志,关掉终端就没了。(不想让它留在 shell 历史里,也可以放在环境变量 `CLOUDFLARE_API_TOKEN` 里。)交互式输入 token 时,脚本会在验证通过后问一句要不要存到 `.env.deploy.token`,下次就不再问;这个文件按名字写进了 .gitignore、只留在你机器上、优先级低于 `--token` 和环境变量,删掉它即撤销。
- **Running it again is safe.** Every step checks the account first: an existing database or bucket is reused, never recreated; migrations only add. That is also how you upgrade — `git pull` and run the same command.
  **重复运行是安全的。** 每一步都先查账号:已有的数据库和存储桶直接复用,绝不重建;迁移只做加法。升级也是这么做 —— `git pull` 之后跑同一条命令。
- **Adding a domain** is the same command with a different `--domain`; `--entry` is remembered, so you only pass it the first time.
  **加域名**就是换个 `--domain` 再跑一次;`--entry` 会被记住,只需在第一次给。
- **Meetings and broadcasts** are set up by the same command, as far as the token allows: with **Account API Tokens · Edit** completely, without it after asking you how (see "When the deploy token cannot create tokens"). They are off on every domain until an administrator switches them on.
  **会议与直播**也由这同一条命令办好,办到 token 允许的程度:有 **Account API Tokens · Edit** 就全部办好,没有就先问你怎么办(见「部署令牌不能建令牌时」)。每个域名都默认关闭,由管理员打开。
- **`--dry-run`** reports exactly what it would do and changes nothing.
  **`--dry-run`** 会把打算做的事完整报一遍,不做任何改动。
- **In a terminal, the arguments are optional.** Plain `npm run deploy` asks for whatever is missing — the token, the domain and entry host on a first install — pauses for a yes before migrations and before publishing (`--yes` skips the pauses), and when something has to be fixed in the Cloudflare dashboard (a token permission, a domain not added yet, the Workers Paid plan for outward sending) it says exactly which switch, waits, and re-checks after you flip it. Outside a terminal it behaves exactly as before: arguments required, no pauses.
  **在终端里,参数都可以不带。**直接 `npm run deploy` 会把缺的信息逐个问你 —— token、首次安装的域名和入口子域;在跑迁移和发布前停下来等你确认(`--yes` 跳过确认);遇到必须去 Cloudflare 后台才能解决的事(token 权限、域名还没加进账号、对外发信要的 Workers 付费版),它会说清楚要拨哪个开关,等你弄好后回来按回车重新检查。不在终端里跑则与从前完全一致:必须带参数,全程不停。

> **What are `npx` and `wrangler`?** `npx` ships with Node.js (18+) — it runs a command-line tool out of `node_modules` without installing anything globally. `wrangler` is Cloudflare's official CLI; it is a regular dependency of this project, so the install already put it there. `npm run deploy` drives it for you; the `npx wrangler …` commands further down are for the occasional thing you do by hand. There is nothing extra to install, and nothing to log into — the token you pass is what authenticates.
>
> **`npx` 和 `wrangler` 是什么?** `npx` 是 Node.js(18+)自带的命令,作用是直接运行 `node_modules` 里的命令行工具,不用全局安装。`wrangler` 是 Cloudflare 官方 CLI,是本项目的正式依赖,安装时就装好了。`npm run deploy` 会替你调用它;后文那些 `npx wrangler …` 是留给偶尔手工操作用的。不需要另外装任何东西,也不需要登录 —— 认证靠你传进去的那个 token。

Where the token comes from: **Cloudflare Dashboard → My Profile → API Tokens → Create Token → Custom token**, with the permissions in the table below. An account-owned token (Manage Account → API Tokens) works just as well.
token 从哪来:**Cloudflare Dashboard → My Profile → API Tokens → Create Token → Custom token**,权限按下面的表格勾。账号级 token(Manage Account → API Tokens)同样可用。

Adding more domains later, and upgrading, are the same command:
之后加域名、升级,都是同一条命令:

```bash
npm run deploy -- --token <token> --domain another.com   # --entry 沿用第一次的前缀
git pull && npm install --omit=dev && npm run deploy -- --token <token>
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

### The short way: one permission / 省事的办法:只勾一项

Ticking a dozen boxes by hand is the most tedious part of an install, and it comes back every time a new feature needs another. So there is a shortcut: give the token **Account · Account API Tokens · Edit** (on a user-owned token: **User · API Tokens · Edit**) and nothing else has to be ticked. `npm run deploy` reads the token's own policy, **adds to the token whatever it finds missing** — naming each permission on the screen as it adds it — and carries on; when a later version needs one more, the next deploy adds that too. The same ability lets it make the narrow second token that broadcast meetings keep inside the Worker, so that one never has to be made by hand either.

手工勾十几项权限是安装里最烦人的一步,而且每当新功能多要一项,就得再来一次。所以有一条捷径:给 token 加上 **Account · Account API Tokens · Edit**(用户级 token 则是 **User · API Tokens · Edit**),其余一项都不用勾。`npm run deploy` 会读这个 token 自己的策略,**发现缺什么就往 token 上加什么** —— 每加一项都在屏幕上报出名字 —— 然后继续;以后的版本多要一项,下一次部署也会自己补上。靠同一项能力,它还会自己建好直播会议留在 Worker 里的那个窄权限 token,那个也不必手工去建。

> What this costs: a token that may edit tokens can give itself anything its owner could, so it is the key to the whole account and wants keeping like one — in `.env.deploy` on your own machine, never in CI logs or chat. Nothing it does is quiet: every permission it adds is printed, and the token's policy in the dashboard always shows the result. Prefer to grant each permission yourself? Leave this one off: the deploy then only *names* what is missing, waits while you add it, and checks again — the tables below are the full list.
>
> 代价是什么:有权编辑 token 的 token 能给自己它的主人能给的一切,所以它就是整个账号的钥匙,要按钥匙来保管 —— 放在你自己机器的 `.env.deploy` 里,绝不进 CI 日志或聊天记录。它做的事没有一件是悄悄的:每加一项权限都会打印出来,dashboard 里这个 token 的策略也始终如实显示结果。更愿意每项权限都自己给?那就别加这一项:部署脚本只会**报出**缺什么、等你加好、再查一遍 —— 下面几张表就是完整清单。

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
| Account | **Calls** | Edit | Meetings. `npm run deploy` creates the Realtime SFU app and the TURN key that meetings need and stores them in the Worker. Newer dashboards list this permission as **Realtime** / 会议功能。`npm run deploy` 会创建会议所需的 Realtime SFU app 与 TURN key 并存入 Worker。新版面板把这项权限列为 **Realtime** |

**When the deploy token cannot create tokens.** With **Account API Tokens · Edit** (see "The short way" above) the deploy sets meetings and broadcasts up by itself. Without it, and with something they need still missing, a deploy run in a terminal asks how to go on — before anything is created:

1. **A second token, just for meetings and broadcasts** — with **Account · Calls · Edit** (meetings: creates the Realtime app, used once) and **Account · Stream · Edit** (broadcasts: kept in the Worker), and nothing else; only the ones still missing are asked for. The deploy checks what the token can do and says so. In advance: `--meet-token <token>`.
2. **Switch them off on this deployment** — recorded in the configuration (`vars.MEETINGS`: `off`, or `no-live` to keep meetings without broadcasts) and read by the Worker, so the question is not asked again. In advance: `--meetings off` / `--meetings no-live`; `--meetings on` brings them back.
3. **Add Account API Tokens · Edit to the deploy token** — the deploy waits while you do it in the dashboard, checks, and then makes everything itself.

Outside a terminal nothing is asked: the three ways are printed with their flags, and whatever is missing stays off for that run. Mail, Drive and everything else install either way.

**部署令牌不能建令牌时。**有 **Account API Tokens · Edit**(见上文「省事的办法」)时,部署会自己把会议和直播办好。没有它、而会议所需的东西还缺着时,在终端里运行的部署会先问你怎么走 —— 在创建任何东西之前:

1. **另交一个会议/直播专用的令牌** —— 给它 **Account · Calls · Edit**(会议:用来建 Realtime app,只用一次)和 **Account · Stream · Edit**(直播:留在 Worker 里),别的都不要;只会要还缺的那几项。部署会查明这个令牌能做什么并说出来。事先指定:`--meet-token <令牌>`。
2. **在这套部署上关掉它们** —— 记在配置里(`vars.MEETINGS`:`off`;或 `no-live`,保留会议、不要直播),Worker 也读它,以后不再问。事先指定:`--meetings off` / `--meetings no-live`;`--meetings on` 可以再打开。
3. **给部署令牌加上 Account API Tokens · Edit** —— 部署会等你在 dashboard 里改好,查一遍,然后自己把一切建好。

不在终端里时什么都不问:把三条路连同参数打印出来,缺的部分这一次保持关闭。邮件、网盘和其余一切照常安装。

**Broadcast meetings** (a few speakers, any number of people watching) need two more things, and like the backup they are asked for separately because they end up *inside* the Worker:

**直播会议**(少数发言人 + 不限人数的旁观者)还需要两样东西;和备份一样,它们是单独要的,因为它们最终会留在 Worker **里面**:

| What / 是什么 | How / 怎么给 | Why / 为什么 |
|---|---|---|
| A second API token for meetings and broadcasts: **Account · Stream · Edit**, plus **Account · Calls · Edit** only if it also has to create the meetings' Realtime app / 会议/直播专用的第二个 API token:**Account · Stream · Edit**;只有在还要由它来建会议的 Realtime app 时,才再加 **Account · Calls · Edit** | Nothing, if the deploy token may edit tokens (see "The short way" above): the deploy makes it. Otherwise the deploy asks (see "When the deploy token cannot create tokens" above), or give it in advance with `npm run deploy -- --meet-token <token>` (formerly `--stream-token`), once / 部署 token 有权编辑 token 时什么都不用做(见上文「省事的办法」),部署会自己建;否则部署会问你(见上文「部署令牌不能建令牌时」),或者事先用 `npm run deploy -- --meet-token <token>`(旧名 `--stream-token`)给一次即可 | The Worker makes a Stream live input for each broadcast, signs the playback addresses, and deletes recordings nobody asked to keep. It is stored as a Worker secret, so it is deliberately **not** the deploy token, which can rewrite the whole deployment. The same run creates the Stream signing key and the key the compositor's entry ticket is signed with / Worker 要为每场直播建一个 Stream live input、给播放地址签名、删除没人要保留的录像。它作为 Worker secret 存放,所以刻意**不是**部署 token —— 后者能改写整套部署。同一次运行还会创建 Stream 签名钥匙和给合成器入场券签名的钥匙 |
| The compositor image / 合成器镜像 | Nothing, once `container-meet/published.json` exists: the published image is used by default, and a deployment still on an image the deploy itself put there moves to it. `npm run deploy -- --meet-image <ref>` points at another one (once; the configuration remembers it) / `container-meet/published.json` 存在之后什么都不用做:默认用已发布的镜像,仍在用部署脚本自己放进去的镜像的部署也会换过去。`npm run deploy -- --meet-image <引用>` 可指向别的镜像(一次即可,配置会记住) | The audience watches one picture, composited in a container from `container-meet/` (GStreamer; no browser in it; the H.264 encoder is Cisco's OpenH264 binary, downloaded by the container when it starts). Without a published image there is no default: build it and push it somewhere Cloudflare can pull from — `npx wrangler containers build container-meet -t cfmail-meet:<tag> -p` puts it in your own account's registry. Licences: [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md#4-container-images--容器镜像) / 旁观者看的是一路画面,由 `container-meet/` 构建的容器合成(GStreamer;里面没有浏览器;H.264 编码器是 Cisco 的 OpenH264 二进制,由容器启动时下载)。没有已发布的镜像时就没有默认值:自行构建并推到 Cloudflare 拉得到的地方 —— `npx wrangler containers build container-meet -t cfmail-meet:<tag> -p` 会把它放进你自己账号的镜像仓库。许可见 THIRD-PARTY-NOTICES 第 4 节 |

> Stream has to be enabled on the account (dashboard → Stream) and is billed by minutes stored and minutes watched. **Stream records every broadcast it lets people watch** — a live input with recording off serves no video at all — so a broadcast counts against the account's stored minutes while it runs; afterwards the recording is kept or deleted as the organiser chose. The container runs only while a meeting is on air.
> Stream 需要先在账号上开通(dashboard → Stream),按存储分钟与观看分钟计费。**凡是允许人观看的直播,Stream 都会录像** —— 关闭录制的 live input 根本不出视频 —— 所以直播进行期间会计入账号的存储分钟;结束后录像按组织者的选择保留或删除。容器只在会议开播期间运行。

> A brand-new Cloudflare account has never taken its `<name>.workers.dev` subdomain, and
> Cloudflare accepts no Worker at all until it does — the deploy would stop with *"You need a
> workers.dev subdomain in order to proceed"* (10063). `npm run deploy` now takes it for you,
> asking what to call it (the name is permanent and shared by everything else you later host on
> that account; nothing of CFMail is served from it — the mail client lives on your own domain).
>
> 全新的 Cloudflare 账号还没占下自己的 `<名字>.workers.dev` 子域,而在占下它之前 Cloudflare
> 根本不收 Worker —— 部署会停在 *"You need a workers.dev subdomain in order to proceed"*(10063)。
> `npm run deploy` 现在会替你占,并问一句叫什么(这个名字是永久的,该账号今后托管的其他东西
> 也共用它;CFMail 本身不从它提供任何服务 —— 邮件客户端住在你自己的域名上)。

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
| Meetings and broadcasts: how they will be set up / 会议与直播:打算怎么办 | Read-only unless you answer. A token with Account API Tokens · Edit is asked nothing; one without it, when something they need is missing, is asked to choose — a second token for them, switching them off (`vars.MEETINGS`), or adding that permission (see "When the deploy token cannot create tokens") / 不回答就只读。带 Account API Tokens · Edit 的 token 什么都不问;不带的,在会议所需的东西还缺着时让你三选一 —— 另交一个专用 token、关掉它们(`vars.MEETINGS`)、或加上那项权限(见「部署令牌不能建令牌时」) |
| Create the D1 database and the R2 bucket / 建 D1 与 R2 | Only when missing; an existing one is reused, with its data / 只在缺失时建;已有的直接复用,数据不动 |
| Write `wrangler.jsonc` / 写配置文件 | Generated from the template and your arguments. Fills `account_id`, `database_id`, `APP_ORIGIN`, appends the route, and adds the two containers — the backup and the broadcast compositor — pointing at their published public images (`container/published.json`, `container-meet/published.json`), so nothing is built / 由模板加你的参数生成:填好 `account_id`、`database_id`、`APP_ORIGIN`,追加 route,并加上两个容器 —— 备份与直播合成器 —— 指向它们已发布的公共镜像(`container/published.json`、`container-meet/published.json`),所以什么都不用构建 |
| Keep live custom domains / 保住线上已有的入口域 | Anything bound on the account but missing from `routes` is added back, so a fresh clone cannot detach domains it never knew about / 线上绑了但配置里没有的,补回数组 —— 新 clone 不会把它没见过的域名摘掉 |
| Apply migrations / 跑迁移 | Migrations only add; `wrangler` runs just the ones not yet applied, and the script re-checks afterwards that none are left / 迁移只做加法;wrangler 只跑没跑过的,脚本事后再查一遍确认没有遗留 |
| Publish the Worker / 发布 Worker | Same code, same result / 同样的代码,同样的结果 |
| Meetings: the Realtime app and TURN key; broadcasts: the Stream token, its signing key, the compositor's ticket key / 会议:Realtime app 与 TURN key;直播:Stream token、签名钥匙、合成器入场券钥匙 | Each is made only when the Worker does not already hold it, and stored the moment it is received — they are handed out once. Skipped where meetings or broadcasts are switched off / 只在 Worker 里还没有时才建,一拿到就存 —— 它们只发一次。会议或直播已关闭的部署跳过 |
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
| **Meetings / 会议** | Turn meetings on per domain; set how many people one may hold and the highest video resolution / 按域名开启会议;设定一场会议的人数上限与视频画幅上限 |
| **Unrouted / 未匹配来信** | Mail sent to addresses that don't exist. Remote images stripped before display / 发给不存在地址的邮件,展示前剥掉远程图片 |
| **Import / 导入工具** | Bring in `.eml` archives from an old provider / 把旧服务商导出的 `.eml` 搬进来 |
| **Export / 导出工具** | Write mailboxes back out to a local folder as `.eml` / 把邮箱写回本地目录 |
| **Audit log / 审计日志** | Who did what, downloadable as CSV or JSONL / 谁做了什么,可下载 CSV 或 JSONL |
| **Backup / 备份** | Switch the nightly backup on, pick the hour, download any archive, or sync them all into a local folder / 打开每晚的自动备份、选时刻、下载任意一份包,或把它们全部同步到本地目录 |

### As a user / 普通用户

Sign in with **either** the personal email used at signup **or** a company address you own — both share one password. Colleagues who have no address to sign up with do not need one: an administrator creates the mailbox with a login, and the company address itself is the account.
用**注册时的个人邮箱**或**你作为所有者的企业邮箱**登录都行 —— 两者共用同一个密码。
没有邮箱可用来注册的同事不必去弄一个:管理员建邮箱时一并建登录,企业地址本身就是账号。

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
daily/2026-08-23.7z   本月中的一天:整库 SQL(22 张表)+ 属于这一天的邮件原件(含附件)
monthly/2026-07.7z    本年中一个已结束的月份,内部形状与日包完全相同
yearly/2025.7z        一个已结束的年份,同上
```

Every archive has the same shape inside -- `database.sql`, `manifest.json`, and `mail/` holding
the message files flat -- so any archive restores the same way. Mail is filed by the date each
message itself shows (the one on it in the mail interface), not by when its bytes arrived: an
import of ten years of mail files into ten years of archives, not into one giant file named after
an afternoon. Each message appears in exactly one archive. On the first of a month last month's
dailies are opened, tipped out flat and recompressed as one monthly; on 2 January the same fold
makes a year. All archives are written to R2's Infrequent Access storage class.

每个包内部形状一致 —— `database.sql`、`manifest.json`,加上摊平放着邮件原件的 `mail/` ——
所以任何一个包的恢复方式都一样。邮件按它自己显示的时间归档(就是邮件界面上那个时间),
而不是字节落地的日子:导入十年的邮件,归进十年的包,而不是一个以某个下午命名的巨型文件。
每封信只出现在一个包里。每月 1 号把上月各日包解开摊平、重新压成一个月包;
每年 1 月 2 号同样折出年包。所有存档都写入 R2 的低频访问(Infrequent Access)存储类别。

Imported mail never enters the archives on its own: it waits for the Backup tab's **catch-up**,
which shows what is in no archive yet -- imports, and mail from any days the automatic backup
missed -- and files it into the archives its own dates place it in, merging into existing
archives where they already exist.

导入的邮件不会自动进包:它等着备份页的**补档**。补档会列出还不在任何包里的邮件 ——
导入的,以及自动备份错过的日子 —— 按每封信自己的时间归入所属的包;包已存在就并进去。

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

Give the deploy a backup token and it does the rest:

给部署一个备份 token,其余它自己来:

```sh
node scripts/deploy.mjs --token <deploy token> --backup-token <backup token>
```

**No Docker, no registry account, nothing to build.** The container image is published for
everybody at the reference in `container/published.json`, and Cloudflare pulls it itself — public
images need no credentials, and the pull happens on Cloudflare's machines, not yours.

**不需要 Docker、不需要镜像仓库账号、没有东西要构建。** 容器镜像已经为所有人发布好了,
引用写在 `container/published.json` 里,由 Cloudflare 自己去拉 ——
公共镜像不需要任何凭据,而且拉取发生在 Cloudflare 的机器上,不在你这里。

That file also records the hash of `container/` as it was when the image was pushed. Change
anything in `container/` and the deploy says the published image no longer stands for what is in
your checkout — then carries on with it, because that is a message for whoever made the change
rather than a reason to stop an install. `--backup-image <ref>` points at an image you built and
published yourself. Nothing is ever built by the deploy.

那个文件还记着推送镜像时 `container/` 的哈希。你改动了 `container/` 里任何东西,
部署会说一句"发布的镜像已不代表你 checkout 里的源码",然后照旧用它 ——
因为那句话是说给改动它的人听的,不是让一次安装停下来的理由。
`--backup-image <引用>` 指向你自己构建并发布的镜像。**部署自己从不构建任何东西。**

Publishing that image is a maintainer's job, done when `container/` changes:
发布那个镜像是维护者的事,只在 `container/` 变动时做:

```sh
node scripts/publish-image.mjs --repo docker.io/<namespace>/cfmail-backup
```

The broadcast compositor (`container-meet/`) is published the same way, when it changes; the
command writes `container-meet/published.json`, and from then on a deploy uses that image unless
told otherwise (`--meet-image`):
直播合成器(`container-meet/`)也照此发布,在它变动时做;命令会写下 `container-meet/published.json`,
此后部署默认用那个镜像,除非另行指定(`--meet-image`):

```sh
node scripts/publish-image.mjs --image meet --repo docker.io/<namespace>/cfmail-meet
```

`--backup-token` is separate from `--token` on purpose: the deploy token lives only in the memory
of that one run, while the backup token stays in the Worker as a secret. Give the backup one only
**Account → D1 · Read** and **Account → Workers R2 Storage · Edit**; it needs nothing else.

`--backup-token` 与 `--token` 分开是有意的:部署 token 只活在那一次运行的内存里,
而备份 token 会作为 secret 长期留在 Worker 里。给它 **Account → D1 · Read** 和
**Account → Workers R2 Storage · Edit** 就够,别的一概不需要。

Without the token, the console says so and the switch stays off. The container is written into
the configuration only once there is an image that really exists — one naming an image nobody
pushed fails the whole deploy, mail and all, with an error about a Worker version that has
nothing to do with the cause. The container, the binding and the migration are written together,
the moment there is something for them to point at.

Once the container is in the configuration, **`wrangler dev` wants an API token in the
environment** even when you are not working on the backup. `.env.deploy` is enough; local
development still needs no Docker.

备份 token 没给,后台会直说,开关也开不起来。而容器是**等到确实有一个存在的镜像**才写进配置的:
指向没人推送过的镜像会让**整个部署失败** —— 连收发信一起 —— 报出来的还是一句关于 Worker 版本、
与真正原因毫不相干的错。容器、绑定与 migration 三样一起写入,就在它们有东西可指的那一刻。

容器一旦进了配置,**即使你不碰备份,`wrangler dev` 也要环境里有 API token**。
有 `.env.deploy` 就够了;本地开发仍然不需要 Docker。

### Restoring / 恢复

```sh
node scripts/restore.mjs --token <token> --from daily/2026-08-23 --dry-run
```

It fetches the archive, opens it, puts the rows back, puts the message files back under the
storage keys they had, and rebuilds the search index. It never deletes: running it over a live
database repairs what is missing and leaves anything newer alone. Start with `--dry-run`.

它取回压缩包、打开、写回行数据、把邮件原件按原始存储 key 放回去,最后重建全文索引。
**它从不删除**:对着活库跑是补上缺的,更新的东西原样留着。先用 `--dry-run` 看一眼。

Nothing about the archive requires that script, though. `database.sql` is a plain SQL dump and
`mail/` is just files, so any archiver and one wrangler command will do:

不过这个包不依赖那个脚本。`database.sql` 就是普通 SQL dump,`mail/` 就是一堆文件,
任何解压工具加一条 wrangler 命令也够:

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
- A mailbox can be given a login of its own, with no personal email involved: creating one with
  **Create a login too**, or **Reset password** on an existing one, makes an account whose name is
  the company address and hands you a generated password once. Resetting ends that account's open
  sessions. There is no self-service recovery for such an account — its own reset mail would be
  delivered to the mailbox it cannot open — so recovery is an administrator resetting it again.
  邮箱可以拥有自己的登录,整件事不牵涉任何私人邮箱:新建时勾「同时创建登录」,
  或对已有邮箱点「重置密码」,就会得到一个以企业地址为账号名的账户,并把生成的密码给你看一次。
  重置会同时结束该账号所有会话。这类账号**没有自助找回** —— 找回信会投进它自己打不开的那个邮箱 ——
  所以找回的方式是让管理员再重置一次。
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

## Browser support / 浏览器支持

Desktop **Chrome, Edge, Firefox and Safari**; tablets running **iPadOS or Android**; and phones,
which get a layout of their own rather than a squeezed desktop. Every browser on iOS and iPadOS
is the system WebKit whatever its name says, so an iPad is tested once and that covers Safari,
Chrome, Edge and Firefox there.

桌面 **Chrome、Edge、Firefox、Safari**;平板 **iPadOS 与 Android**;手机有自己的版式,
不是把桌面挤小。iOS/iPadOS 上无论叫什么名字都是系统的 WebKit,所以 iPad 测一次,
Safari / Chrome / Edge / Firefox 就都覆盖了。

### The phone layout / 手机版式

A phone is a phone in both orientations — landscape is not mistaken for a small desktop. The
sidebars become drawers with a scrim; context menus rise from the foot of the screen as
thumb-height action sheets; a tap opens what a double-click used to; the top bar slides away as
you scroll down and back as you scroll up. Pictures open album-style — full screen, neighbours
riding along with the drag, preloaded a pair ahead. Saving goes through the system share sheet
("Save Image" / "Save to Files"), with a spinner while the bytes fetch and a toast when the
sheet reports done; where the sheet is unavailable the plain download remains. The first screen
costs 264 KB where it used to cost 974: dictionaries load one language at a time, and the
composer and the admin console load when reached for. Navigation replaces only the content pane
— the chrome is built once and stands still.

手机横竖都是手机 —— 横屏不会被误当成一台小桌面。侧栏变成带遮罩的抽屉;右键菜单变成从屏幕
脚下升起的拇指高动作单;过去要双击的,点一下就开;顶栏随下滚收起、随上滚拉回。图片按相册
方式打开 —— 满屏、相邻的跟着拖动一起走、提前预载一对。保存走系统分享面板(「存储图像」/
「存储到文件」),取字节时有转圈、面板办完有提示;没有分享面板的地方,普通下载仍在。
首屏从 974 KB 降到 264 KB:词典按语言一次载一种,写信器和管理后台点到才加载。
导航只替换内容区 —— 外壳建一次就站着不动。

### What is not everywhere / 并非处处都有的能力

Two capabilities are missing on some platforms, and the interface says which is which rather
than leaving a button that does nothing:

有两项能力在部分平台缺席,界面会说明是哪一种,而不是留下一个按下去没反应的按钮:

- **Writing into a folder you choose** (File System Access) exists only in desktop Chromium.
  Exporting mailboxes, backup sync and the Gmail import say so and name a browser that can;
  downloading several files falls back to one download each. Importing `.eml` works everywhere:
  it takes a multi-select of files, so a tablet or phone can feed it too.
  **写入你指定的目录**(File System Access)只有桌面 Chromium 有。导出邮箱、备份同步、Gmail
  导入会说明并点名可用的浏览器;多文件下载退化为逐个下载。导入 `.eml` 则处处可用:
  它收的是多选文件,平板和手机同样喂得进。
- **Rebuilding a media stream in the browser** (MediaSource) is absent on iPhone — iPad has it.
  An `.mkv` or a `.wma` there says the stream cannot be rebuilt and suggests downloading for a
  local player, rather than spinning; formats the browser opens by itself are unaffected.
  **在浏览器里重建媒体流**(MediaSource)在 iPhone 上没有 —— iPad 有。那里的 `.mkv` / `.wma`
  会明确说"不支持流式重建,可下载后用本机播放器打开",而不是一直转圈;
  浏览器自己就能打开的格式不受影响。

Anything that had a substitute is substituted silently. The archive cache falls back to decoding
per request where the browser cannot write to its private storage. Thumbnails are encoded down a
format ladder — WebP where the canvas can encode it, JPEG where it cannot (Safari never learned
WebP), AVIF ready the day a canvas learns it — and the server accepts whichever arrives by its
magic bytes. Actions a mouse reaches by hovering or right-clicking are reachable on a touch
screen too: every row carries a menu button, and the Drive has a select mode that makes a tap
add to the selection.

凡是有替代品的一律静默替换。浏览器写不了私有存储时,压缩包缓存退回按请求解码。
缩略图沿一把格式梯子编码 —— 画布会编 WebP 就用 WebP,不会(Safari 从来没学会)就用 JPEG,
AVIF 在梯子上等着哪天有画布学会;服务端按魔数收下到达的那种。鼠标靠悬停和右键够到的动作,
触摸屏上同样够得到:每一行都带一个菜单按钮,网盘还有一个"选择模式",让点一下变成加选。

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

Release checklist / 发布清单: edit code → run `build-themes.mjs` if themes changed → `npm run typecheck` → `npm run deploy -- --token <token>` (it applies any new migrations first, and stops before publishing if one fails). Working on the code needs the full `npm install` — `typecheck` and `build-themes.mjs` live on dev dependencies. Forgetting the themes step is caught: `themes.css` carries a fingerprint of its sources, and the deploy stops if it no longer matches.
改代码 → 动过主题就跑 `build-themes.mjs` → `npm run typecheck` → `npm run deploy -- --token <token>`(它会先跑新迁移;迁移失败就停在发布之前)。改代码需要完整的 `npm install` —— `typecheck` 和 `build-themes.mjs` 依赖 dev 依赖。忘跑主题这步会被拦住:`themes.css` 带着其来源的指纹,对不上时部署会停下。

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
  sync-vendor.mjs              # sync public/vendor/ from node_modules (postinstall); verifies the
                               # committed builds (libav, themes) still match their sources
                               # 同步 public/vendor/(postinstall);并校验入库构建(libav、主题)未漂移
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
