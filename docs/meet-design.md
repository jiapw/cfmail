# 会议模块:设计、选型与开发计划

> 状态:**阶段 1(3.31.0)、阶段 2(3.32.0)已上线;阶段 3 主干随 3.33.0 上线但处于休眠(等 Stream 权限),本机已端到端跑通;阶段 4 未开始。** 进度见第 11 节。
> 日期:2026-09-19。基线版本:3.30.1。
> 这份文档是方案讨论的落盘。后续实现以它为准;实现中发现它与事实不符,先改文档再改代码。

## 0. 一页摘要

- 给 CFMail 加第四个平级子系统「会议」,形态类似 Zoom:音频、可选视频、屏幕共享、聊天、举手、访客、录制与纪要。
- 全部自建在 Cloudflare 上:**Realtime SFU** 转发媒体,**Durable Object** 做房间信令,界面自己写。不用 RealtimeKit。
- 两种会议分开建模:**小组会议**(人数有上限)与**直播会议**(少量发言人 + 不限人数的 Stream Live 旁观者)。
- **人人平等**(2026-09-20 用户改定,取代原来的「一大多小」):每个人发同一种摄像头画面,界面是等大的画廊,在空间允许的范围内尽可能大;没有「切到我」,也没有主画面。发送清晰度按同屏人数自动调整(两人时全幅,人多时降档),以免带宽随人数平方增长。屏幕共享仍在,同一时刻只有一块,共享时屏幕占大区、其余人排在旁边。
- 画幅 480p / 720p / 1080p 在创建会议时选定;视频可以整场关闭(纯音频会议)。
- 直播旁观:容器里的**原生合成管线**(GStreamer,**不起 Chrome**)订阅全部轨道,拼成一路画面(发言人等大宫格;有共享屏幕时屏幕占大区、发言人一列)并混音,用 RTMPS 推给 Stream Live;旁观者用 LL-HLS 看这一路。旁观页可设为仅登录用户可看。
- 端到端加密是会议级开关,只对小组会议开放;开了就没有直播、云端录制和转写。**密钥由组织者的浏览器生成,编码在会议链接 `#` 之后,只存本机、从不上服务器,由用户自行旁路传递**(2026-09-20 用户定,取代原来的 MLS 方案,见 4.5)。
- 访客(无账号、凭链接、主持人放行)是创建会议时的可选项,默认关闭。

## 1. 范围

### 1.1 两种会议

| | 小组会议 `group` | 直播会议 `live` |
|---|---|---|
| 参与者 | 全员进 SFU,人数有上限(默认 32) | 发言人进 SFU(默认上限 8);旁观者不限人数,只看 Stream Live |
| 谁能旁观 | 无此角色 | 凭链接公开,或仅登录用户(「仅本公司可看」) |
| 旁观者延迟 | 无此角色 | LL-HLS,约 3 秒 |
| 旁观者互动 | 无 | 聊天提问、申请发言;被批准后转为发言人进 SFU |
| 录制 | 主持人本地录制,存网盘;会中可随时开关 | Stream 侧录像(可选,整场);另有「录制到网盘」,会中可随时开关 |
| 端到端加密 | 可开 | 不可(合成容器必须解码) |
| 转写与纪要 | 可(未开 E2EE 时) | 可 |

### 1.2 明确不做的

| 不做 | 原因 |
|---|---|
| RealtimeKit | 按参与人分钟收费;界面是别人的组件;录像先落在它的桶里。用户已否决 |
| 容器里跑无头 Chromium 合成画面 | 用户已否决。合成改用原生管线 |
| 给旁观者分发多路小视频(多路进多路出) | 讨论过后放弃:链路复杂,且 Stream 按「路 x 分钟」计费,旁观成本乘以路数 |
| SFU 的 WebSocket adapter | 它把视频解码成 JPEG 帧、音频转成 PCM 推给 WebSocket 服务端,是给 AI 分析用的,不在通话链路上。本方案不用 |
| simulcast | 每人只发一路摄像头,清晰度由"同屏人数"决定、所有订阅者看到的格子大小相近,不需要订阅端选层。真要按观看者窗口分别选层时再议 |
| 原生 App | 只做浏览器(桌面与手机) |
| 多人协同编辑 | 与现有演示功能一致:单写者广播 |

## 2. 决定记录

| 日期 | 决定 | 理由 |
|---|---|---|
| 2026-09-18 | 自建,不用 RealtimeKit | 一切跑在自己账号里;界面、i18n、主题自己掌控;费用基本落在免费额度内 |
| 2026-09-18 | 支持 Stream Live;两种会议模型分开 | 日常小会与「少数人讲、很多人看」是两种不同的成本结构 |
| 2026-09-18 | 视频可选;画幅 480p / 720p / 1080p 可选 | 用户要求 |
| 2026-09-18 | 端到端加密做成会议级开关 | 加密与录制、转写、直播互斥,只能按会议取舍 |
| 2026-09-18 | 访客可行但可选,创建会议时设定 | 用户要求 |
| 2026-09-19 | ~~上传端一大多小、可切换~~ | 用户要求。上行带宽与编码开销只由一个人承担,下行可预测。**2026-09-20 用户撤销,见下一行** |
| 2026-09-20 | **取消大小视频,全部改成大视频;去掉「上大屏」按钮及相关代码** | 用户要求。实现为:人人发同一种 `cam` 轨,画廊等大且尽量大;每路的发送清晰度按同屏人数定档(≤2 人全幅、≤4 人 540、≤9 人 360、≤16 人 270、更多 180,且不超过会议画幅),共享屏幕时按"一列小格"算;屏幕共享保留为独立的 `screen` 轨,同一时刻一块 |
| 2026-09-19 | 旁观端单路合成;合成在容器里做,但不起 Chrome | 用户要求。单路使旁观成本不随发言人数增长 |
| 2026-09-19 | 小组会议上限 32 人;直播发言人上限 8 人 | 用户定。均为域名级默认值,管理员可调 |
| 2026-09-19 | 直播的「录制到网盘」是可选项,会议中可随时开启与关闭 | 用户定。由合成容器旁路写文件实现,不依赖会后从 Stream 搬运,见 4.6 |
| 2026-09-19 | 旁观页支持「仅本公司可看」的登录门槛 | 用户定。靠 Stream 的签名播放地址落到视频本身,见 4.4 |
| 2026-09-19 | H.264 编码器:默认 OpenH264,二进制不进镜像、启动时从 Cisco 下载;x264 作为自建镜像的构建选项 | 我方建议,用户 2026-09-19 同意。理由见 3.1 |
| 2026-09-20 | **端到端加密的密钥放在链接 `#` 之后,本机保存,不上服务器,用户自行旁路传递** | 用户定。取代原来的 MLS(OpenMLS WASM)方案:不需要 Rust/WASM 工具链、没有第三方代码的许可证问题,服务端完全不参与密钥,也就无从作中间人;代价是没有成员变动时的换钥(拿到过链接的人始终能解密),见 4.5 |
| 2026-10-02 | **部署令牌没有 "Account API Tokens · Edit" 时,部署过程中让用户三选一**:① 另交会议/直播专用令牌;② 在本部署上关闭会议/直播;③ 给部署令牌加上那项权限,让脚本自己建专用令牌 | 用户要求。见 8.2 |
| 2026-09-20 | 旁观者聊天、申请发言、主持人提升为发言人 | 用户要求。实现见 4.4「旁观者互动」:`MeetAudience` 分片(一个总台 + 三个观众分片);未登录观众要说话先留名并过一次 Turnstile;提升 = 主持人批准后签发一张只送给这位观众的发言入场券,凭券进会场不看访客开关、不进等候室 |

## 3. 选型

| 环节 | 选型 | 说明 |
|---|---|---|
| 媒体转发 | Cloudflare Realtime SFU | WebRTC,anycast 就近接入;只转发包,不解码不混音。每账号每月 1000 GB 出向免费,之后 $0.05/GB |
| 穿透 | Cloudflare Realtime TURN | 与 SFU 同用不计费;用于封 UDP 的网络 |
| 房间信令 | Durable Object `MeetRoom` | 照 `src/present.ts` 的 `PresentRoom` 写:hibernation WebSocket,名册即 socket attachment,不落盘 |
| SFU 协商 | 经 WebSocket 由 `MeetRoom` 代理到 SFU HTTPS API | app secret 不出 Worker;只有已入座者能协商;轨道目录由 DO 从 SFU 应答里得知,不靠客户端自报 |
| 连接数 | **每人两条 PeerConnection:一条只发布,一条只订阅**,各对应一个 SFU 会话 | 阶段 0 实测得出,原因见 4.2。会话在第一次用到时才创建 |
| SFU 客户端 | 自写(`public/assets/meet/rtc.js`) | SFU 的 HTTPS API 只有六个端点。官方的 partytracks 基于 RxJS,与本项目「无打包器、原样送出的 ES 模块」不合;重连与轨道修复的思路参考 Orange Meets |
| 视频编码 | 优先 H.264,不可用时 VP8;E2EE 会议固定 VP8 | H.264 硬件编码普及、Safari 友好;E2EE 的帧头明文方案是针对 VP8 的 |
| 音频编码 | Opus,开 DTX | |
| 旁观分发 | Stream Live:RTMPS 进,LL-HLS 出 | 约 3 秒延迟、不限人数、自动录像。$1/1000 观看分钟 |
| 旁观播放 | Safari 原生 HLS;其余浏览器用 vendor 的 hls.js | hls.js 为 Apache-2.0 |
| 画面合成 | 容器内 GStreamer 1.24 + Python 控制器 | webrtcbin 收流,compositor 拼图,audiomixer 混音,H.264 编码,flvmux 封装,rtmp2sink 推流。无浏览器 |
| H.264 编码器 | OpenH264(默认);x264(自建镜像的构建选项) | 见 3.1 |
| 旁观权限 | Stream 签名播放地址(Worker 用 RS256 自签 JWT) | live input 一律要求签名;令牌短时有效,由 Worker 按会议的旁观权限发放 |
| 直播录制到网盘 | 容器把已编码的音视频旁路写成分片 MP4,经 Worker 分片上传进网盘 | 不多做一次编码;容器不持有任何 R2 凭据 |
| 容器承载 | Cloudflare Containers,由 `MeetCompositor` DO 持有 | 与备份容器同一套机制(`@cloudflare/containers`);每场直播一个实例 |
| 端到端加密 | 秘密放在会议链接 `#` 之后(组织者浏览器生成、本机保存、用户旁路传递)+ WebRTC encoded transform(AES-256-GCM,每个发送者一把 HKDF 派生的钥匙) | 2026-09-20 用户改定,取代原定的 MLS;服务端不经手任何密钥,见 4.5 |
| 转写 | Workers AI `whisper-large-v3-turbo` | $0.0005/音频分钟 |
| 纪要 | 现有 AI 子系统按域名配置的聊天模型 | 复用 `src/llm.ts` / chat 的模型配置 |
| 持久数据 | D1(会议定义、场次、录制指针);R2(录制文件进网盘) | 房间运行态不落库 |

Stream 的两条管线互不相通,这是选 RTMPS 的原因:WHIP 进的流只能 WHEP 出(亚秒延迟,但不录像、没有 HLS);RTMPS 或 SRT 进的流走 LL-HLS(约 3 秒,自动录像)。合成容器自己编码,所以 RTMPS 的要求(H.264 + AAC、闭合 GOP 2 到 4 秒、无 B 帧、固定分辨率)天然满足。

### 3.1 H.264 编码器的选择

Stream Live 的 RTMPS 入口只收 H.264,所以合成容器里必须有一个 H.264 编码器。两个候选:

| | OpenH264(Cisco) | x264 |
|---|---|---|
| 源码许可 | BSD 两条款 | GPL-2.0 |
| 专利 | Cisco 为**它自己分发的二进制**支付 H.264 专利池费用;条件是使用方在安装时从 Cisco 的服务器直接下载,不能由第三方转发 | 不附带任何专利许可,分发者自行负责 |
| 档次 | 仅 Baseline,无 B 帧 | 全档次 |
| 同码率画质 | 较差 | 最好 |
| 实时性能 | 720p 在 2 核内可实时 | 同左,且更省 |

**建议:公共镜像默认用 OpenH264,且编码器二进制不打进镜像,容器启动时从 Cisco 的下载站获取(版本与 SHA-256 在镜像里钉死,校验不过就拒绝开播);x264 留作自建镜像时的构建选项。**

- 本项目以 MIT 公开发布,并提供公共镜像好让部署者不需要 Docker。按这个做法,我们分发的镜像里根本没有 H.264 编码器:没有 GPL 成分,专利费用由 Cisco 承担。Firefox 与 Fedora 用的是同一个模式。
- OpenH264 的短板在这里影响很小:只有 Baseline、没有 B 帧,恰好是 LL-HLS 要求的;Stream 收到后还会自己再转码一遍,x264 的画质优势到观众端大半被抹平。画质差距用码率补:合成输出 720p 给约 2 Mbps,1080p 给约 4 Mbps(送进 Stream 的流量不计费)。
- 代价:每次开播多一次约 1 MB 的下载;Cisco 的下载站不可达时开不了播,界面要给出明确的报错;需要验证发行版的 GStreamer openh264 插件与 Cisco 二进制的 ABI 吻合(风险 5)。
- 选 x264 的部署者:构建镜像时传一个参数即可切换。该镜像整体按 GPL 条款分发,THIRD-PARTY-NOTICES 里写明。仓库里的 Dockerfile 与控制器脚本仍是 MIT(与 GPL 兼容);Worker 与前端不受影响,它们与容器只通过网络通信。

这不是法律意见。公共镜像发布前,以 Cisco 二进制许可的原文为准。

## 4. 架构

### 4.1 总览

```
参会者浏览器 ──WebSocket 信令──▶ Worker ──▶ MeetRoom DO ──HTTPS(持密钥)──▶ SFU API
     │
     └────── WebRTC:mic / cam / screen ──────▶ Realtime SFU(只转发,不解码)
                                                     │
                                          仅直播会议:订阅全部轨道
                                                     ▼
                                     合成容器(GStreamer,无 Chrome)
                                     解码 → 宫格(或屏幕 + 一列)+ 混音 → H.264 + AAC
                                                     │ RTMPS,只有一路
                                                     ▼
                                               Stream Live ──LL-HLS──▶ 旁观者(不限人数)
```

三层:**媒体层**只有浏览器和 SFU 两方;**信令层**是我们自己的 Worker 与 DO;**旁观层**只在直播会议里存在。

### 4.2 媒体层

每个参会者与最近的 Cloudflare 节点建立**两条** PeerConnection:一条只发布(offer 永远由我们发),一条只订阅(offer 永远由 SFU 发),各对应一个 SFU 会话。

这是阶段 0 在真实 SFU 上测出来的,不是偏好。同一条连接一旦接受过 SFU 发来的 offer(它把负载类型 116/117 映射为 H.265 及其重传),SFU 对我们此后的 offer 的应答里,就会只列出那条重传条目、却不列它所属的编码,Chrome 于是拒掉整份应答(`Failed to set remote video description send parameters`)。换编码参数、去掉 DTX、改加轨方式都无济于事,五种组合全部失败。分开之后,两条连接各自只见过一种次序的协商 —— 这两种次序各自都验证过可行 —— 而且发布与订阅不再互相等待,入会更快。

另外两条同样来自实测:

- **SFU 会话要在第一次用到时才建。** 建好之后迟迟没有建立连接的会话会被 SFU 放弃(独自在房间里等一分多钟,之后的订阅会在阻塞 5 秒后失败)。所以发布会话在第一次发布时建,订阅会话在第一次订阅时建;订阅一侧若仍然失效,客户端整条重建并重新订阅。
- **刚发布的轨道立刻去订阅,会得到 `not_found_track_error`。** 发布方已协商但还没开始发包时就是这样,持续几百毫秒。一次订阅请求可以部分成功、部分失败;失败的按 250 ms 起步退避重试,服务端把它报成 `not_ready` 而不是错误。

**轨道模型**

| 轨道 | 谁发布 | 内容 | 默认参数 |
|---|---|---|---|
| `mic` | 每个开麦的人 | Opus,开 DTX | 约 32 kbps |
| `cam` | 每个开摄像头的人 | 摄像头,人人同一种 | 按会议画幅采集;发送清晰度按同屏人数定档,见下表 |
| `screen` | **全房间同一时刻只有一个人** | 共享的屏幕 | 不超过会议画幅,15 帧 |

**摄像头的发送档位**(2026-09-20 起;每个人的摄像头都是同一种画面,格子有多大就发多大)

| 同屏人数 | 发送高度(再受会议画幅封顶) | 码率上限 | 帧率 |
|---|---|---|---|
| 1~2 | 会议画幅(480 / 720 / 1080) | 0.7 / 1.5 / 3 Mbps | 30 |
| 3~4 | 540 | 约 0.9 Mbps | 30 |
| 5~9 | 360 | 约 450 kbps | 30 |
| 10~16 | 270 | 约 280 kbps | 24 |
| 更多,或有人共享屏幕时 | 270 / 180 | 约 280 / 150 kbps | 24 / 15 |

采集始终按会议画幅,换档只改编码参数(`scaleResolutionDownBy` + `maxBitrate`),所以从十六人回到两人时画面立即重新清晰,不需要重开摄像头。浏览器自己的带宽估计仍在其上起作用:刚开始时从低往上爬,实测三人会议约 10 秒爬到 540。

**屏幕共享**:点按钮时由浏览器的选择框取得屏幕,然后经 DO 发布 `screen` 轨。**同一时刻只有一块**:DO 在转给 SFU 之前检查是否已有人在发布 `screen`,并用一个 10 秒的占位挡住"两人同时按下"的情形,后到的得到 `screen_busy`,页面提示"X 正在共享屏幕"。主持人可以在名册里请共享者停止(`screen_stop`,由共享者的浏览器执行)。共享期间界面把屏幕放在大区、其余人排成旁边一列;直播合成器同理。

轨道按需创建而不预建,是因为 SFU 会回收 30 秒收不到媒体包的轨道。关摄像头就是关闭 `cam` 轨,再开时重建;静音则保留 `mic` 轨(DTX 会持续发舒适噪声包,不会被回收)。

**订阅规则**:全部 `mic`;当前页可见的 `cam`(每页 16 格,翻页即退订);有人共享时,那一路 `screen`。自己的格子直接用本地画面。

**流量估算**(720p;SFU 按出向计费)

| 规模 | 全房间出向 | 每月 1000 GB 免费额度可开 | 超出后 |
|---|---|---|---|
| 6 人 | 约 6 GB/小时 | 约 165 小时 | 约 $0.3/小时 |
| 32 人,每页 16 格 | 约 60 GB/小时 | 约 16 小时 | 约 $3/小时 |
| 6 人纯音频 | 不到 0.5 GB/小时 | 基本不限 | 可忽略 |

**TURN**:由 Worker 用 TURN key 换取短期凭据,放在入座时的 `welcome` 消息里下发。

### 4.3 信令层

**MeetRoom(Durable Object)** 的写法与 `PresentRoom` 保持一致:

- hibernation WebSocket;一条连接的全部信息(身份、角色、是否在等候室、发布了哪些轨道)存在 socket attachment 上,问 socket 就得到名册,没有第二处可能与之不一致的状态。"谁在共享屏幕"也是从各人发布了什么读出来的,而不是另记一份。
- 不落盘。会议设置由 Worker 在升级 WebSocket 时从 D1 读出,经请求头交给 DO(`present.ts` 的现成做法)。最后一人离开,房间自毁。
- 消息权限写成清单(主持人专用、入座者可发、等候者可发),新增消息类型时必须回答「谁能发」。

**SFU 协商经 WebSocket 由 DO 代理**。浏览器把 SDP 交给 DO,DO 带着 app secret 调 SFU 的 HTTPS API(`sessions/new`、`tracks/new`、`renegotiate`、`tracks/update`、`tracks/close`),再把应答回给浏览器。

因为发布与订阅在两条连接上并行,同一条 socket 会有两个协商处理过程交错运行(DO 在 `await fetch` 期间会处理下一条消息)。所以协商代码里对座位记录的每一次修改都是「现读、现改、现写回,中间没有 await」,否则后写的会抹掉先写的(实测中丢过刚建好的会话 id)。

**拒绝以消息送达。** 浏览器读不到 WebSocket 握手失败的状态码,所有拒绝在它看来都一样。所以会议已满、已锁定、访客链接不对、会议已结束这些情形,服务端都是先接受这条 socket、发一条 `refused{error}`、再关闭;页面据此显示原因。

**一扇门。** 已登录用户、访客、合成机器人都走同一个入口 `GET /api/meet-pub/:code/ws`,由服务端按来者手里的东西(会话 cookie、访客令牌、签名入场券)判定角色,与 `present.ts` 的做法一致。

**角色**

| 角色 | 来源 | 能力 |
|---|---|---|
| `host` | 会议创建者,及其指定的联席主持 | 放行、踢人、全员静音、请人停止共享屏幕、开停直播、结束会议 |
| `member` | 已登录用户,凭会议链接进入 | 发言、开视频、共享屏幕、聊天、举手 |
| `guest` | 无账号,凭访客链接 | 同 member,但须经等候室(按会议设置) |
| `bot` | 合成容器 | 只订阅,不发布,不出现在名册里;E2EE 房间拒绝该角色 |

`bot` 的鉴权:Worker 启动容器时签发一次性令牌(HMAC,含会议 id 与过期时间),容器带着它连入,Worker 验签后以请求头把角色交给 DO。容器拿不到 SFU 密钥,它的协商同样由 DO 代理。

同一把 `MEET_BOT_KEY` 还签另外三种凭证,都是"载荷 + HMAC",各带自己的前缀参与签名,所以谁也冒充不了谁(见 4.4「旁观者互动」):

| 凭证 | 谁签、给谁 | 内容 | 有效期 |
|---|---|---|---|
| 后台证 `pass` | 房间在 `welcome` 里给直播会议里的每个人 | 会议 id、座位号、角色、名字 | 12 小时;被踢出即作废 |
| 观众证 `aud` | Worker 给留了名、过了 Turnstile 的未登录观众 | 会议 id、观众 id、名字 | 24 小时 |
| 发言入场券 `spk` | 总台在主持人点「允许」时给那一位观众 | 会议 id、观众 id、名字、账号 id(若已登录) | 4 小时;被踢出即在这一场作废 |

**消息协议草案**(JSON,`t` 为类型,沿用 `present.ts` 的风格)

| 方向 | 消息 | 用途 |
|---|---|---|
| 入座者 → 房间 | `sfu{rid, op, ...}` | 协商 RPC:建会话、发布、订阅、重协商、关闭;房间回 `sfu_ok` / `sfu_err` |
| | `state{mic, cam}` | 自己的开关状态 |
| | `hand{on}`、`chat{text}` | 举手、聊天 |
| 主持人 → 房间 | `admit` / `deny` / `kick` / `mute` | 准入与秩序 |
| | `screen_stop{peer}` | 请某人停止共享屏幕(房间转给共享者,由他的浏览器执行) |
| | `live_start` / `live_stop` / `end` | 直播与结束会议 |
| | `rec{on}` | 开关录制(小组:主持人本地录制;直播:容器录制到网盘) |
| 房间 → 客户端 | `welcome{you, cfg, ice, room, aud?}` | 入座;直播会议里多一张后台证 `aud`,房间页凭它连到观众总台 |
| | `replaced` | 同一张发言入场券在别处又进了一次门,这个座位让给新的那个 |
| | `room{peers, screen, locked, rec, live, lobby?}`、`chat` | 名册(含各人发布了什么)、谁在共享屏幕等的整份广播(不发增量,理由同 `present.ts`) |
| | `lobby`(仅主持人)、`admitted` / `denied` / `kicked` / `muted` | 等候室与处置结果 |
| | `live{state}`、`rec{on}`、`ended` | 直播状态、录制状态(所有人都看得到「正在录制」)、会议结束 |

### 4.4 旁观层(仅直播会议)

**合成容器**

- 镜像:Ubuntu 24.04 + GStreamer 1.24(base / good / bad / ugly / libav / nice)+ Python 3 + PyGObject + Noto Sans CJK。控制器是一个 Python 脚本,没有浏览器。
- 管线示意:

```
webrtcbin ─┬─ 每路视频:RTP 解包 → 解码 → 缩放 ─▶ compositor ─▶ H.264 编码(GOP 2 秒,无 B 帧) ─┐
           └─ 每路音频:RTP 解包 → opusdec ─────▶ audiomixer ─▶ AAC ─────────────────────────────┴─▶ tee
                                                                                                     ├─▶ flvmux ─▶ rtmp2sink(RTMPS → Stream Live)
                                                                                                     └─▶ 分片 MP4 ─▶ 经 Worker 上传网盘(仅「录制到网盘」开着时)
```

- 布局(2026-09-20 起):画布等于会议画幅。平时发言人等大、排成放得下的最大宫格(一人时铺满,两人左右并排);有人共享屏幕时,屏幕占左侧大区,发言人排成右侧一列(四人以内每格高为画幅的四分之一,八人时八分之一)。屏幕出第一帧之前宫格保持不变。每格左下角压名字,字号随格子变大但封顶。没开摄像头的人显示纯色底加名字。
- 布局随房间的 `room` 消息实时改 compositor 各输入的位置与大小,**不重启管线**。
- 生命周期:主持人点「开始直播」→ Worker 创建 Stream live input(低延迟;是否录像按会议设置)→ 启动容器实例(实例 id = 会议 id)→ 容器以 `bot` 入会、订阅、推流 → 房间广播 `live{on}` → 旁观页可播。主持人停止或房间空了,容器送出 EOS 后退出。
- 规格(以阶段 0 实测为准):480p / 720p 用 standard-3(2 核 8 GB,约 $0.22/小时);1080p 用 standard-4(4 核 12 GB,约 $0.40/小时)。
- 冷启动预计 10 到 30 秒,界面显示「正在准备直播」。

**Stream Live**

- 输入:RTMPS,H.264 + AAC,闭合 GOP 2 秒,无 B 帧,分辨率固定为会议画幅。
- 输出:LL-HLS,约 3 秒;人数不限;录像自动生成,结束后约 1 分钟可用。
- live input 由 Worker 在开播时按需创建(数量无上限),需要一个带 Stream 编辑权限的 token 存为 Worker secret。
- live input 一律开启 `requireSignedURLs`:裸的播放地址无效,观众必须带 Worker 签发的令牌。令牌是 Worker 用 Stream signing key 自签的 JWT(RS256),有效期 1 小时,旁观页在到期前自动续签。Stream 侧的录像沿用同一道门。

**旁观页**

- 路由 `#/live/<code>`。
- 旁观权限 `audience_access`,创建会议时选定:`link`(凭链接公开;页面不在登录之后,领取播放令牌前过一次 Turnstile)或 `signin`(「仅本公司可看」:必须是本实例的已登录用户,未登录先去登录页再回来)。两种模式下视频都只认签名令牌,所以门槛落在视频本身,而不只是页面上。
- 内容:播放器、标题与主持人、在看人数、聊天(可由会议设置关闭)、「申请发言」。
- 旁观者不进 `MeetRoom`,聊天与申请发言走 `MeetAudience`,见下。

**旁观者互动**(2026-09-20 实现)

- **结构。** `MeetAudience` DO,每场会议四个实例:`<会议 id>:0` 是**总台**,只接房间里的人(主持人与发言人);`:1`~`:3` 是**观众分片**,观众按自己的观众 id(`vid`,每个标签页一个随机串)哈希落到其中一个。socket 一律 hibernation,闲着不计费。
- **一条观众消息怎么走。** 观众 → 所在分片(按人限速、查名字与聊天开关)→ 总台(编号、全场限速、查禁言名单、留最近 50 条)→ 总台发给自己的 socket(台上的人),并转给三个分片,各分片发给自己的观众。每条消息约 4 次 DO 请求,与观众人数无关;每个分片扛约三分之一的观众。
- **观众是谁。**
  - 已登录的(`signin` 模式下只能是这种):名字取账号的显示名,没有就取邮箱 `@` 前面那段 —— 公开的直播里不把完整地址亮给陌生人。
  - 未登录的(`link` 模式):可以只看不说。要聊天或申请发言,先留个名字并过一次 Turnstile(`POST /api/meet-pub/live/:code/name`),Worker 签发一张**观众证**(观众 id + 名字),之后重连都凭它,不再过 Turnstile。聊天里这类名字带「访客」标记,与已登录的区分开 —— 名字是自报的,谁都可以叫"主持人"。
  - 台上的人:入座时房间在 `welcome` 里给一张**后台证**,房间页凭它连到总台,消息带「主持人」「发言人」标记。发言人被踢出,后台证当场作废。
- **聊天。** 观众之间、观众与台上互相看得见(台上在聊天面板的「观众」页签里)。不做时间对齐(旁观画面比会场晚约 10 秒)。新来的人看到最近 50 条。限速:每个观众起手 3 条,之后每 3 秒 1 条;全场观众合计每秒至多 5 条,多出来的告诉说话的人"说话的人太多,稍后再发";每条至多 500 字。主持人可以删一条,或**禁言**说这条的人:删掉他说过的全部,之后他说不了话、也申请不了发言(未登录的按观众证,已登录的按账号)。会议设置「旁观者聊天」关掉时,观众页没有聊天区,台上也没有「观众」页签;申请发言照常。
- **申请发言 → 提升为发言人。**
  1. 观众点「申请发言」(需要先有名字)。总台把他排进队列(至多 200 人);主持人的名册里出现「申请发言 · n」,并收到一条提示。
  2. 主持人点「允许」:总台签发一张**发言入场券**,只送到这位观众的 socket。发言人已满时「允许」是灰的,门口也会再拦一次。点「拒绝」:观众看到"主持人暂时没有安排你发言"。
  3. 观众页弹出「主持人请你上台发言」,点「上台发言」:入场券存进这个标签页的 sessionStorage,跳到 `#/meet/<code>`,照常过设备预检(名字已定,不再问),凭券进门 —— **不看访客开关、不进等候室、不过 Turnstile、不受锁定限制**,但仍受发言人上限。已登录的仍以本人身份进(`member`),未登录的是 `guest`。
  4. 一张券同一时刻只占一个座位:同一张券再进一次门(刷新、重连、另开一个标签页)会顶掉旧的那个。主持人把他踢出后,这张券在这一场里作废。离开会场时页面回到旁观页。
  - 观众自己取消、关掉页面、或被批准后走进会场,他都会从队列里消失。
- **开播与停播由总台推给观众。** 房间在 `live` 变成 `on` / `off` 时告诉总台,总台转给所有观众;观众页据此立刻去领播放地址,不再每 6 秒问一次。只在连不上总台时每 30 秒看一眼门面。(原先"等开播时每 6 秒领一次播放令牌"会在第 6 分钟撞上每 IP 每小时 60 次的限额,之后一小时拿不到画面,见风险 26。)
- **在看人数。** 各分片在自己的观众数变化后 2 秒内合并上报给总台,总台汇总后广播;观众页与房间顶栏都显示"n 人在看"。
- **收尾。** 会议结束(主持人结束、从房间外结束或删除):总台清空聊天、队列与禁言名单,通知观众重置。最后一个人离开房间(这一场结束)只清空申请队列。总台 6 小时没有任何连接时清掉自己的存储。

### 4.5 端到端加密

**已实现(2026-09-20,3.35.0)。** 原计划的 MLS 方案由用户改定为下面的做法。

- **密钥从哪来。** 创建加密会议时,组织者的浏览器生成 32 字节随机秘密(`public/assets/meet/e2ee.js` 的 `newSecret`),写进本机 `localStorage`(`cf_meet_e2ee_<code>`)。**服务端只记得"这场会议是加密的",从不接触秘密。**
- **怎么传。** 秘密编码在会议链接 `#` 之后:`…/#/meet/<code>?k=<访客钥匙>&e2ee=<秘密>`。浏览器从不把 `#` 之后的部分发给任何服务器(不进请求、不进 Referer、不进日志)。**由用户自行旁路传递**:组织者复制完整链接,用自己信任的渠道发出去。经服务器寄出的邀请邮件不含秘密,并写明"光凭邮件进不了会,完整链接另行发送"。打开过完整链接的设备会把秘密存下来,之后不带秘密的链接在这台设备上也能用。
- **没有秘密的人。** 门口不给入会按钮,只给一个输入框:粘贴完整链接(或单独的秘密)即可。列表页"复制链接"在本机没有秘密时拒绝复制,提示先在本机打开一次完整链接。
- **帧加密。** `RTCRtpScriptTransform`(旧版 Chrome 退到 `createEncodedStreams`,两者互通已测),在编码之后、打包之前逐帧加密(`public/assets/meet/e2ee-worker.js`)。每个发送者用自己的钥匙:`HKDF-SHA-256(秘密, salt=会议短码, info="cfmail meet e2ee v1 "+座位号)` → AES-256-GCM,每帧随机 12 字节 IV。帧格式 `[明文头][密文+16 字节标签][IV][1 字节格式号]`;VP8 关键帧留 10 字节、普通帧 3 字节、Opus 1 字节明文(SFU 要读),明文头作为附加数据参与认证。**没有秘密就不发送**:加密不了的帧直接丢弃,绝不以明文放行。解不开的帧(不同的秘密、损坏)丢弃。E2EE 会议所有画面固定 VP8(H.264 的打包器要解析 NAL,加密后会坏)。
- **核对。** 房间顶栏的「端到端加密」标记可点开:说明、**密钥指纹**(秘密的 SHA-256 前 4 字节,十六进制),有人看不到画面时大家对一对,不一样就是拿到的不是同一条链接。
- **约束。** 仅小组会议;不可直播(合成器必须能解码)、不可转写与纪要(服务端拿不到声音);`bot` 被房间拒绝。主持人本地录制仍可用(录的是本机解密后的画面)。会议进行中不能切换加密开关(一半人发的另一半人读不了),服务端回 409。
- **不支持 encoded transform 的浏览器**进不了加密会议,门口直接说明(本机的 WebKit 无法测;iOS Safari 15.4 起支持 `RTCRtpScriptTransform`)。
- **安全性说明(如实)。** 服务端与 Cloudflare 都拿不到秘密,因此读不到内容,也无法做中间人(没有经服务器的密钥交换可供篡改)。代价:没有成员变动时的换钥 —— 任何拿到过完整链接的人始终能解密这场会议(但入会仍受房间控制:锁定、踢人、访客放行)。需要"踢出后立刻失效"时,组织者可以关掉加密再打开(生成新秘密)后重新分发链接 —— 这只能在会议没有进行时做。
- **测试**:`scratch/meet-test-e2ee.mjs`(22 项:正确密钥互相看得见、标准与旧版接口互通、错误密钥双向都解不开、无密钥挡在门口、粘贴链接后可入、指纹一致、所有页面发出的 617 个请求与 socket 里没有一个带秘密、邀请邮件不含秘密、进行中不能切换)、`scratch/meet-test-e2ee-dialog.mjs`(8 项:从创建对话框生成并保存秘密、复制链接带秘密、服务端从未收到秘密)。

### 4.6 录制与转写

| 场景 | 方式 | 去向 |
|---|---|---|
| 小组会议 | 主持人本地录制「当前主画面 + 混音」(MediaRecorder),会中随时开始与停止 | 走现有分片上传进主持人的网盘,计入配额 |
| 直播会议,Stream 侧 | Stream 自动录像(合成画面);创建会议时选择开或关,整场生效 | 留在 Stream,适合给很多人回放;会议记录里挂链接,播放同样要签名令牌 |
| 直播会议,网盘侧 | 「录制到网盘」:主持人在会议中随时开启与关闭;开着的每一段各成一个 MP4 | 主持人的网盘,计入配额 |
| 转写与纪要 | 录制时另存每 5 分钟一段的纯音频,逐段送 whisper,拼成带时间戳的文字稿;再用域名配置的聊天模型出摘要 | 文字稿与摘要存网盘,并以站内邮件发给受邀人 |

本地录制为了在主画面换人时保持同一条视频轨,要把当前主画面画到一块固定尺寸的 canvas 上再录。这只是单路拷贝,不是多路合成。

「录制到网盘」不是会后从 Stream 搬运,而是合成容器在编码器之后旁路写文件:开着的时候把已编码的 H.264 + AAC 写成分片 MP4,每攒够约 16 MB 就经 Worker 走网盘现有的分片上传送进 R2;关掉时收尾,并登记为主持人网盘里的一个文件。这样不多做一次编码,容器不持有任何 R2 凭据,容器中途崩溃也只丢最后不到 16 MB。开始录制前先核对主持人的网盘余量,录制中配额用尽则自动停止并提示。

无论哪种录制,开着的时候所有与会者都能看到「正在录制」标记。

### 4.7 访客与准入

- 会议设置 `guest_mode`:`off`(默认)/ `lobby`(主持人放行)/ `open`(持链接直接进)。
- 访客链接带令牌,库里只存它的 sha256。加入页要求填名字并通过 Turnstile;请求按 IP 限速,沿用 `src/forms.ts` 里 `allow` + `ipKey` 的写法。名字去控制字符并截断,与 `presentSeat` 的处理一致。
- 等候室:访客的 socket 先以等候身份挂着,主持人 `admit` 或 `deny`。
- 主持人可踢人、全员静音、锁定会议(之后谁也进不来)。

## 5. 数据模型(草案,migration `0040_meet.sql`)

```sql
-- 按域名的开关与上限,与 drive_enabled / chat_enabled 同一写法
ALTER TABLE domains ADD COLUMN meet_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domains ADD COLUMN meet_live_enabled INTEGER NOT NULL DEFAULT 0;  -- 直播要花钱(Stream + 容器),单独开
ALTER TABLE domains ADD COLUMN meet_max_group INTEGER NOT NULL DEFAULT 32;
ALTER TABLE domains ADD COLUMN meet_max_speakers INTEGER NOT NULL DEFAULT 8;
ALTER TABLE domains ADD COLUMN meet_max_resolution INTEGER NOT NULL DEFAULT 1080;

CREATE TABLE meetings (
  id            TEXT PRIMARY KEY,               -- uid();房间 = idFromName(id)
  code          TEXT NOT NULL UNIQUE,           -- 链接里的短码
  owner_id      TEXT NOT NULL,
  domain_id     TEXT NOT NULL,                  -- 创建时所在域名:品牌、开关、上限都取它
  kind          TEXT NOT NULL,                  -- 'group' | 'live'
  title         TEXT NOT NULL DEFAULT '',
  persistent    INTEGER NOT NULL DEFAULT 0,     -- 个人常驻会议室
  starts_at     INTEGER,                        -- 预约时间;NULL = 即时
  duration_min  INTEGER,
  video         INTEGER NOT NULL DEFAULT 1,     -- 0 = 纯音频会议
  resolution    INTEGER NOT NULL DEFAULT 720,   -- 480 | 720 | 1080
  stage_policy  TEXT NOT NULL DEFAULT 'free',   -- 'free' | 'approve' | 'host'
  max_people    INTEGER NOT NULL,               -- group:总人数;live:发言人数
  guest_mode    TEXT NOT NULL DEFAULT 'off',    -- 'off' | 'lobby' | 'open'
  guest_token   TEXT,                           -- 照原样存(同网盘分享的 token):主持人要能反复取回同一条访客链接
  e2ee          INTEGER NOT NULL DEFAULT 0,     -- 仅 group
  record_mode   TEXT NOT NULL DEFAULT 'off',    -- group:'off'|'local';live:'off'|'stream'(Stream 侧录像,整场)
  drive_record  INTEGER NOT NULL DEFAULT 0,     -- 仅 live:开播时「录制到网盘」的初始状态;会中可随时开关
  audience_access TEXT NOT NULL DEFAULT 'link', -- 仅 live:'link' | 'signin'
  audience_chat INTEGER NOT NULL DEFAULT 1,     -- 仅 live
  audience_token TEXT,                          -- 仅 live
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX idx_meetings_owner ON meetings(owner_id, created_at);

CREATE TABLE meeting_invitees (
  meeting_id TEXT NOT NULL,
  email      TEXT NOT NULL,
  user_id    TEXT,                              -- 站内用户则填
  role       TEXT NOT NULL DEFAULT 'speaker',   -- 'cohost' | 'speaker' | 'viewer'
  PRIMARY KEY (meeting_id, email)
);

CREATE TABLE meeting_sessions (                 -- 每次实际开会一条
  id              TEXT PRIMARY KEY,
  meeting_id      TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  peak_people     INTEGER NOT NULL DEFAULT 0,
  live_input_uid  TEXT,                         -- Stream live input
  transcript_node TEXT                          -- 网盘里的文字稿
);
CREATE INDEX idx_meeting_sessions ON meeting_sessions(meeting_id, started_at);

CREATE TABLE meeting_recordings (               -- 一场会可以有多段录制:会中每开关一次就是一段
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,                    -- 'local'(主持人本地)| 'drive'(容器录到网盘)| 'stream'(Stream 侧录像)
  node_id     TEXT,                             -- 网盘文件(local / drive)
  stream_uid  TEXT,                             -- Stream 视频(stream)
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX idx_meeting_recordings ON meeting_recordings(session_id, started_at);
```

隐私口径与全站一致:不记 IP;不落参会名单(会后纪要发给受邀人与创建者,而不是「实际到场的人」)。PRIVACY.md 需补一节,见 8.4。

## 6. API 草案

`meetApp` 挂在 `/api/meet`,在 `requireAuth` 之后;`meetPubApp` 挂在 `/api/meet-pub`,**刻意不在** `requireAuth` 之后(访客与旁观者没有账号),每个端点单独限速。

| 方法与路径 | 用途 |
|---|---|
| `GET /api/meet` | 我的会议列表(含预约与历史场次) |
| `POST /api/meet` | 创建会议(设定见 7.3) |
| `GET / PATCH / DELETE /api/meet/:id` | 读取、修改、删除 |
| `POST /api/meet/:id/invite` | 发邀请邮件(站内直投,外部走发信通道),附 .ics |
| `GET /api/meet/config` | 创建对话框可用的上限与功能开关 |
| `POST /api/meet/:id/end` | 从房间之外结束会议 |
| `POST /api/meet/:id/recordings` | 登记已上传到网盘的录制文件(可同时带上文字稿节点) |
| `POST /api/meet/:id/transcript` | 只有纪要、没有录像时,单独登记文字稿节点 |
| `POST /api/meet/:id/transcribe` | 请求体是一段音频(约 5 分钟,≤12 MB),返回带时间的文字;这一段只在本次请求内持有,不落任何地方 |
| `POST /api/meet/:id/minutes` | 请求体是整份文字稿,返回摘要(长会议先分块记笔记,再由笔记写纪要);服务端不保存文字稿 |
| `POST /api/meet/:id/minutes/mail` | 主持人过目之后,把纪要寄给受邀人与组织者,文字稿作为 `.md` 附件 |
| `GET /api/meet-pub/:code` | 加入页所需的公开信息(标题、主持人、是否需要等候) |
| `GET /api/meet-pub/:code/ws` | **所有人的入口**:已登录用户、访客、`bot`(带签名令牌) |
| `GET /api/meet-pub/live/:code` | 旁观页信息(标题、旁观权限、是否在播、聊天是否开启、能否互动) |
| `POST /api/meet-pub/live/:code/token` | 领取或续签播放令牌;`signin` 模式要求已登录 |
| `POST /api/meet-pub/live/:code/name` | 未登录观众留名:过 Turnstile,换一张观众证 |
| `GET /api/meet-pub/live/:code/ws` | 旁观者的 socket:聊天、申请发言、在看人数、开播通知;`signin` 模式要求已登录;台上的人凭后台证连到总台 |

旁观的几个端点按「IP + 会议」限速,额度按"一个办公室几百人共用一个出口 IP"来定:门面、播放令牌、socket 各每小时 3000 次,留名每小时 300 次(风险 26)。
| `PUT /api/meet-pub/:code/rec/...` | 合成容器分片上传录制文件(凭 bot 令牌),落到主持人的网盘 |

`/api/me` 增加 `meet_enabled` 与 `meet_live_enabled`,口径与 `drive_enabled` 相同:当前用户所在的域名里有任何一个开了即为真。缺少 DO 绑定或 SFU 密钥时一律为假,前端不显示入口(与 `PRESENT_ROOM?` 的降级方式一致)。

## 7. 前端

### 7.1 文件布局(纯 ES 模块,无构建)

```
public/assets/meet/
  meet.js      会议列表、创建与预约(renderMeet)
  room.js      房间界面:等大画廊(fitGallery 按空间算格子大小)、共享屏幕区、控制条、名册、聊天、等候室、设备预检
  signal.js    WebSocket 会话与重连(参照 edit/session.js)
  rtc.js       SFU 客户端:会话、发布、订阅、按同屏人数调发送档位、屏幕共享、重连与轨道修复
  record.js    本地录制与音频分段(阶段 2)
  live.js      旁观页:播放器、聊天、申请发言(阶段 3)
  audience.js  旁观 socket(观众页与房间页共用):重连、拒绝原因
  e2ee.js      端到端加密:秘密的来去、帧变换的挂接(阶段 4)
  e2ee-worker.js  逐帧加解密(阶段 4)
  meet.css
```

- 路由:`#/meet`(列表)、`#/meet/<code>`(入会;未登录时即访客加入页)、`#/live/<code>`(旁观)。后两者与 `#/f/<token>` 一样在登录判定之前处理。
- 导航:第四个平级入口「会议」,按 `me.meet_enabled` 显示;账号下拉里的子系统切换行同步增加。
- 模块 CSS 用 `ui.js` 的 `loadCss()`,并在第一次 `show()` 之前 `await`(3.25.3 起的约定)。
- i18n:九种语言同步;词条前缀 `mt_`,照 chat 的做法集中在 `i18n.js` 末尾用 `Object.assign` 注入。每次注入后做 node --check、行数、真实 import 三重校验。
- 主题:只用 `--primary`、`--link`、`--panel` 等现有变量;参会者颜色复用演示功能的 `--peer-*` 调色板。

### 7.2 房间界面要点

- 等大画廊:每一种列数都试一遍,取让每格 16:9 画面最宽的那种(两人在宽窗里左右并排,在竖着的手机上上下叠放)。每页 16 格,翻页退订。有人共享屏幕时,屏幕占大区、画廊变成旁边一列。
- 控制条:麦克风、摄像头、共享屏幕、举手、聊天、名册、录制、直播(主持人)、离开。**没有「切到我」**(2026-09-20 起)。
- 主持人面板:等候室、踢人、全员静音、锁定会议、请共享者停止共享;直播会议另有「申请发言」队列(允许 / 拒绝)。
- 直播会议的聊天面板分「会场」「观众」两个页签;顶栏显示在看人数。主持人在「观众」页签里可以删一条、禁言一个人。
- 正在说话的人用音量检测高亮(本地计算,不上报)。
- 手机:竖屏时画廊竖排;共享屏幕时屏幕在上、人每行两个;iOS 没有 `getDisplayMedia`,隐藏共享屏幕按钮;入会按钮即播放音频所需的用户手势;`playsinline`;可用时申请 Wake Lock;video 元素始终参与布局(iOS 不解码不可见的 video)。

### 7.3 创建会议时的设定

| 设定 | 取值 | 默认 |
|---|---|---|
| 类型 | 小组 / 直播 | 小组 |
| 标题、时间 | 即时 / 预约 | 即时 |
| 视频 | 允许 / 纯音频 | 允许 |
| 画幅 | 480p / 720p / 1080p(不超过域名上限) | 720p |
| 人数上限 | 不超过域名上限 | 小组 32;直播发言人 8 |
| 访客 | 关 / 主持人放行 / 持链接直接进 | 关 |
| 端到端加密 | 开 / 关(仅小组;开则禁用直播、云端录制、转写) | 关 |
| 录制 | 小组:是否允许主持人本地录制;直播:Stream 侧录像 开 / 关(整场) | 关 |
| 录制到网盘 | 仅直播。这里定的是开播时的初始状态,会议中主持人可随时开关 | 关 |
| 旁观权限 | 仅直播:凭链接公开 / 仅登录用户(「仅本公司可看」) | 凭链接公开 |
| 旁观者聊天 | 开 / 关(仅直播) | 开 |

## 8. 配置与部署

### 8.1 Worker 配置

`wrangler.jsonc` 是生成物,改动落在 `wrangler.example.jsonc` 与 `scripts/wrangler-config.mjs`。

| 类别 | 名称 | 阶段 |
|---|---|---|
| DO 绑定 | `MEET_ROOM`(`MeetRoom`,migrations 里加 `new_sqlite_classes`) | 1 |
| DO 绑定 | `MEET_AUDIENCE`(`MeetAudience`) | 3 |
| 容器 + DO | `MEET_COMPOSITOR`(`MeetCompositor`),由部署按已发布镜像写入,写法同 `withBackupContainer` | 3 |
| secrets | `REALTIME_APP_ID`、`REALTIME_APP_SECRET`、`TURN_KEY_ID`、`TURN_KEY_TOKEN` | 1 |
| secrets | `STREAM_API_TOKEN`(Stream 编辑权限)、`MEET_BOT_KEY`(签发 bot 令牌)、`STREAM_SIGNING_JWK`(签发播放令牌) | 3 |
| vars | `STREAM_SIGNING_KEY_ID`、`STREAM_CUSTOMER_CODE`(播放域名里的客户代码) | 3 |

`Env` 里这些都是可选字段。缺了就是「这里没开会议」,而不是一个起不来的 Worker。四项 Realtime 凭据全部存成 secret 而不分 var 与 secret:它们要等 Worker 发布之后才建得出来,而 var 写在配置里、要再发布一次才生效;secret 写入即生效。

### 8.2 deploy.mjs

- 配置阶段:用 `withDurableObject()` 给已有的 `wrangler.jsonc` 补上 `MEET_ROOM` 与 `MEET_AUDIENCE` 绑定及对应的 migration(模板只在首次安装时才读,已有配置不知道后来发明的类)。
- 发布之后新增可选步骤「Meetings」:先看 Worker 上是否已有那四个 secret;没有再探测 token 是否有 Calls 写权限;有则创建 SFU app(`POST /accounts/{id}/calls/apps`)与 TURN key(`POST /accounts/{id}/calls/turn_keys`,它的令牌字段名实测是 `secret`)。没有权限时只打印一段说明,部署照常完成。
- **SFU app 的 secret 只在创建时返回一次**:拿到后立刻写成 wrangler secret;若 app 已存在而 secret 不在 Worker 里,就新建一个 app。
- 阶段 3:幂等创建 Stream signing key(`POST /accounts/{id}/stream/keys`)。私钥同样只返回一次,立刻写成 secret。
- **部署令牌建不了会议所需的东西时的三选一(2026-10-02,用户要求)。** 新的「Meetings and broadcasts」一步放在创建任何资源之前:读出 Worker 已有的 secret,算出还缺什么(会议缺 Realtime app 的 4 个 secret;直播缺 `STREAM_API_TOKEN`)。部署令牌有 "API Tokens · Edit"(读自己的策略能看到 `… API Tokens Write`)就不问,发布后照旧给自己加 Calls、再铸一个只有 Stream 的令牌;能直接建 Realtime app、又不缺直播的也不问。否则在终端里列出缺的权限并让用户选:
  1. **另交一个会议/直播专用令牌**(`--meet-token`,旧名 `--stream-token`):当场用它探测 `calls/apps` 与 `stream/live_inputs`,报告能做什么;够了就继续,不够就回到菜单。发布后用它建 Realtime app 与 TURN key(部署令牌不行时),能用 Stream 的就存成 `STREAM_API_TOKEN` 并用它建签名钥匙。粘贴部署令牌本身会被拒绝。
  2. **关闭**:写进配置的 `vars.MEETINGS`(缺会议时 `off`,只缺直播时 `no-live`),以后不再问;Worker 的 `meetReady()` / `meetLiveReady()` 也读它,所以关闭在线上真的生效。`--meetings on|no-live|off` 是同一个选择的参数形式。
  3. **去 dashboard 给部署令牌加上那一项权限**:脚本等待、回车重查;查到了就继续,`q` 回到菜单。
  不在终端里或带 `--yes` 时不问,打印三条路和对应参数,缺的部分这一次保持关闭;在终端里跑 `--dry-run` 照样问(回答不改动任何东西,可用来试)。已用第二账号(无此权限)的令牌以试运行实测过三个选项与非终端输出,主账号(有此权限)不问。
- 阶段 3:合成镜像的引用与备份镜像同理,从 `container-meet/published.json` 读,部署不需要 Docker;记下的源码哈希与 checkout 不符时照用并提醒(与备份镜像同一规矩)。`scripts/publish-image.mjs --image meet --repo <公共仓库>` 发布合成镜像并写下该文件(2026-10-02 实现)。**已发布(2026-10-03):`docker.io/cfmail/cfmail-meet:8d2da049913a`**(公开仓库,匿名可拉;digest `sha256:8394a845…`;发布前在 WSL 里跑过 selftest:OpenH264 从 Cisco 取得并校验、元件齐全、720p 四路 0.44 核跟得上实时)。两个账号的部署都已改用它:主账号的容器应用从私有仓库镜像改到它(EDIT),第二账号新建了合成器容器(NEW)—— 后者走的正是全新安装的那条路。主账号私有镜像仓库里的旧合成镜像(`cfmail-meet:50ff0fa24d68`、`b20c92ad2117`)已无人引用,2026-10-03 经用户同意删除。全新安装生成的配置可离线核对:`scratch/meet-check-fresh-install.mjs`(两个容器都指向 Docker Hub 公共镜像;`no-live` 时不加合成器)。已有部署里由本项目工具放进去的镜像(已发布仓库的,或以 12 位源码哈希为标签的 `cfmail-meet` 构建,例如主账号原来那个私有仓库镜像)在有公共镜像后自动换成它;人为指定的其他镜像保持不动;`--meet-image` 永远优先。直播关闭(`no-live` / `off`)的部署不新加合成器容器(已有的保留)。(2026-10-03,用户要求安装与部署都用公共镜像)
- README 的 token 权限表在「可选」里加两行:Realtime(Calls)编辑、Stream 编辑。「免费版够不够」表加一行:小组会议可在免费额度内运行;直播会议需要 Workers Paid(容器)与 Stream。

### 8.3 两个账号

两套实例各自需要自己的 SFU app、TURN key 与 Stream token。`deploy.mjs` 已按 token 认账号、各用各的 wrangler 配置文件,新步骤沿用同一机制。每阶段上线的流程不变:递增 `src/version.ts` → 主账号 → 第二账号 → 两边 `/api/health` 核对版本。

### 8.4 文档与合规

- PRIVACY.md 补一节:媒体经 Cloudflare Realtime SFU 转发、不存储;录制文件存在哪里;转写会把音频交给同账号下的 Workers AI;E2EE 会议里服务端看不到内容;仍不记 IP。
- THIRD-PARTY-NOTICES.md(2026-10-02 已写):hls.js(Apache-2.0,LICENSE 随文件进 `public/vendor/hls/`)、`@cloudflare/containers`;第 4 节「容器镜像」:合成镜像里的 GStreamer(LGPL)等各组件、OpenH264 的 Cisco 署名与二进制许可原文链接(原文核对过)、x264(GPL)只出现在选了该构建选项的自建镜像里;顺带补上备份镜像(p7zip)。端到端加密不再用 OpenMLS,无需声明。
- 审计埋点:`meet.create`、`meet.end`、`meet.kick`、`meet.live_start`、`meet.live_stop`。

## 9. 费用

| 项目 | 价格 | 备注 |
|---|---|---|
| Realtime SFU 出向流量 | 每账号每月前 1000 GB 免费,之后 $0.05/GB | 小组会议的全部成本;估算见 4.2 |
| TURN | 与 SFU 同用免费 | |
| 合成容器 | 约 $0.22/小时(720p)到 $0.40/小时(1080p) | 只在直播进行时计费 |
| Stream 分发 | $1 / 1000 观看分钟 | 100 个旁观者看 1 小时约 $6;1000 个约 $60 |
| Stream 录像存储 | $5 / 1000 分钟 / 月 | 1 小时录像约 $0.30/月 |
| 录制到网盘 | 占主持人的网盘配额(R2 存储) | 720p 约 1 GB/小时 |
| whisper 转写 | $0.0005 / 音频分钟 | 1 小时约 $0.03 |
| 纪要(LLM) | 每场几分钱以内 | |

直播是唯一会随规模线性花钱的部分,所以单独设 `meet_live_enabled` 开关,后台开启处写明计费方式。

## 10. 风险与未验证项

| # | 风险 | 影响 | 验证或对策 | 阶段 |
|---|---|---|---|---|
| 1 | 容器出向 UDP 连不上 SFU | 直播不可用 | 已有旁证:2026-08-19 在 Cloudflare 容器上用真协议实测过,默认允许任意 TCP 端口与 UDP 出站。连 SFU 本身仍待实测 | 0 |
| 2 | webrtcbin 与 SFU 的重协商(轨道增减)不稳 | 发言人进出时合成中断 | **已验证(2026-09-19,本机 Docker 里的容器 ↔ 真实 SFU):** 订阅、逐次加轨重协商、退订、大画面两次易手、有人离场,全程输出不断;每路画面到达后约 1 秒内出图。前提是第 20~23 条的四个做法 | 0 |
| 3 | LL-HLS 实际延迟高于预期 | 旁观互动变差 | **已测(2026-09-19,主账号真实 Stream,本机容器推 RTMPS,Chrome + hls.js):** 画面里烧入的墙钟与截图时刻相差约 **10~12 秒**(开播十几秒时读数;WSL 与 Windows 时钟差约 ±1.5 秒);hls.js 自报离清单边缘 6.4 秒(LL-HLS)/ 8.0 秒(普通 HLS),其余是 Stream 自己的接收与转码。比原先设想的 8 秒差。已做:播放器开追帧(`maxLiveSyncPlaybackRate: 1.5`)让它向 4 秒的目标收敛。还可试:GOP 从 2 秒降到 1 秒。要亚秒级只能改 WHIP/WHEP(Stream 那条路不出 HLS、不录像),暂不做 | 0 |
| 4 | 合成的 CPU 超出容器规格 | 掉帧 | **已测(合成信号、本机):** 一大八小加名字条、混音、OpenH264、FLV 封装,720p30 用 0.43 核,1080p30 用 0.85 核,全部跟上实时。再算上解码与更慢的容器核,原定规格仍有余量 | 0 |
| 5 | OpenH264 运行时下载这条路没走过 | 开不了播 | **已验证:** Ubuntu 24.04 的 `gstreamer1.0-plugins-bad` 自带 openh264 插件,链接的正是 2.4.1 / soname 7,与 Cisco 发布的二进制完全一致;下载、SHA-256 校验、加载、编码全部成功。踩到的坑:库目录必须在进程启动**之前**就存在(glibc 只在启动时看一遍 `LD_LIBRARY_PATH`),已在镜像里预建。镜像里另要强制剔除发行版自带的 libopenh264、x265、faad2 | 0 / 3 |
| 6 | iOS Safari:自动播放、后台挂起、无屏幕共享、硬件编码限制 | 手机体验 | 真机测试清单;沿用上一轮手机适配的经验 | 1 |
| 7 | SFU 回收 30 秒无包的轨道 | 静音或关摄像头后轨道丢失 | 静音保留轨道(DTX 有包);关摄像头即关轨,再开重建 | 1 |
| 8 | 单个 DO 吞吐约每秒一千次请求 | 大房间聊天、旁观聊天 | 聊天限速;旁观 DO 分片。**已做(2026-09-20):** 一个总台 + 三个观众分片,按人与全场两级限速,见 4.4「旁观者互动」。分片数是常量,真到几万人再议 | 1 / 3 |
| 9 | SFU app secret 只返回一次 | 重新部署拿不回密钥 | 见 8.2:立即写入 secret,丢了就重建 app | 1 |
| 10 | Stream 的开通方式与最低消费 | 直播的前置条件 | 在 dashboard 确认后写进 README | 3 |
| 11 | Orange Meets 代码的许可证;Safari 的 encoded transform 行为;H.264 下的帧加密 | E2EE 的可移植性 | 动手前确认许可证;E2EE 固定 VP8;做浏览器兼容矩阵 | 4 |
| 12 | whisper 单次输入大小 | 长会议转写 | 录制时即按 5 分钟分段 | 2 |
| 13 | 容器冷启动 10 到 30 秒 | 开播等待 | 界面给出「正在准备直播」状态;预约的直播可提前预热 | 3 |
| 14 | Stream 的签名播放地址对直播输入是否生效(文档只明确写了点播视频;live input 的 `recording` 里有 `requireSignedURLs` 字段) | 「仅本公司可看」能否落到视频本身 | **已验证(2026-09-19):生效。** live input 带 `requireSignedURLs` 创建;令牌由我们用 `/stream/keys` 给的 JWK 在本地以 RS256 自签(与 Worker 里同一段 WebCrypto 代码),`sub` 填 live input 的 uid:裸地址 401、给别的 id 签的令牌被拒、过期令牌 401、有效令牌可播,`?protocol=llhls` 也可播 | 0 |
| 25 | **iPhone 入会有声音、看不到任何人**(2026-09-20 用户在 kvs4 首次线上试用时发现;主持人是 Windows Chrome) | iOS 上会议不可用 | **已改(3.33.3),待 iOS 复测:** 两处写法在 Chrome 上没事、在 WebKit 上是死结。① 订阅侧原先等远端轨道 `unmute` 才把它交给页面,而 WebKit 不解码"没有任何东西在显示"的远端视频轨,于是它永远 muted、永远不被交出去(声音不受影响,现象吻合)→ 改为 `ontrack` 当下就交付,"画面到了没有"改由 video 元素的首帧回答。② 等首帧的 video 被 `display:none`(小画面)/ `visibility:hidden`(大画面后备层)藏着,iOS 对不可见的 video 不解码或直接暂停 → 改为始终渲染:头像盖在小画面上、有帧才让开;两层大画面都可见,前面那层只是盖住后面那层;换层后与页面回到前台时补一次 `play()`。另加了一个手机上用的诊断面板:**在房间右上角的计时器上快速点五下**,显示每条轨的编码、字节数、已解码帧数、muted 状态和各 video 元素的尺寸与播放状态。本机没法复现(Playwright 的 WebKit 在 Windows 上没有 WebRTC) | 1 |
| 24 | **`recording.mode: "off"` 的 live input 根本没有 HLS**:推流被接受、状态 `connected`,清单却一直是 HTTP 204。"off" 的意思是"只接收、转推别处",不是"直播但不留存" | 原设计里「Stream 侧录像 开/关」的"关"做不到 | **阶段 0 发现并已改设计:** 录制恒为 `automatic`;「保留直播录像」开关决定的是**事后**的去向 —— 留下(登记进 `meeting_recordings`),或由每小时的清扫删掉(录像在推流停止后还要写几秒,`live-inprogress` 状态下删除会 409,所以不能在停播当下删)。停播当下只把 input 停用(`enabled:false`,推流密钥即失效)并在 meta 里记下结束时间。**录像存在期间计入账号的 Stream 存储分钟数,正在进行的直播也算** —— 主账号目前的额度是 100 分钟,一场长直播会顶到上限,需要用户留意 | 0 / 3 |
| 15 | 容器录制经 Worker 分片上传:单片大小、请求时长、配额的并发扣减 | 录制到网盘 | 复用网盘现有的分片上传与配额逻辑;每片约 16 MB;录制前预检余量 | 3 |
| 16 | 同一条连接上「先订阅、后发布」会被 Chrome 拒绝 | 除第一个人外谁都发不出视频 | **阶段 0 发现并已解决:** 发布与订阅分两条连接,见 4.2 | 0 |
| 17 | SFU 会话建好后不及时连上就会失效 | 独自等人一分钟后收不到任何人 | **阶段 0 发现并已解决:** 会话按需创建;订阅一侧失效可整条重建,见 4.2 | 0 |
| 18 | DO 在 `await` 期间交错处理同一条 socket 的消息 | 座位记录被后写者覆盖 | **阶段 1 发现并已解决:** 协商代码对记录的修改全部改为现读现写,见 4.3 | 1 |
| 19 | 订阅连接从不自己发 offer,退订的 m-line 留在原处不回收 | 超长会议里频繁翻页,SDP 越长越大 | 已知,暂不处理;真成问题时让订阅连接定期重建 | 1 |
| 20 | webrtcbin(1.24)对每条 m-line 只答**一种**编码(offer 里的第一种),而 SFU 的 offer 把它认识的编码全列上、转发的却是发布者实际在发的那一种;应答里没有那一种,SFU 就拒绝(`The subscriber's SDP is missing the published track's codec`) | 合成器一条视频都订不到 | **阶段 0 发现并已解决:** 房间在 `push` 时从 SFU 的应答里记下每条轨的编码(该 m 段第一个非 rtx/red/fec 的 payload),`pull` 的应答里带上 `codec`;合成器在把 offer 交给 webrtcbin 之前,把每个 m 段裁剪到只剩这一种编码和它的 rtx(`narrow_offer`)。offer 是累积的,所以每个 mid 的编码要记住,每次都按同样的方式裁 | 0 / 3 |
| 21 | SFU 把订阅会话的**第一份应答**当作"这个订阅者能解什么"的清单:第一份只答了 VP8,之后 offer 里新加的 m 段就只列 VP8,H.264 的轨道永远订不到 | 大画面(H.264)到不了旁观者 | **阶段 0 发现并已解决:** 直播会议里**所有**画面统一用 VP8(`rtc.js` 的 `preferCodec`,小画面也设,因为 Safari 默认发 H.264);小组会议不受影响,大画面仍优先 H.264。合成容器因此只需要 vp8dec,不需要 H.264 解码器 | 0 / 3 |
| 22 | offer 里同时有 `ccm fir` 与 `nack pli` 时,GStreamer 要关键帧只发 FIR、从不发 PLI,而 SFU 只转发 PLI(实测:发了 78 个 FIR,0 个关键帧,画面要等发布端自然出关键帧,4~20 秒) | 开播、换人时长时间无画面 | **阶段 0 发现并已解决:** 裁剪 offer 时把所有 `a=rtcp-fb:* ccm fir` 去掉,GStreamer 即改发 PLI;此外每条视频分支接上后主动发一次 force-key-unit,并每秒重试到出图为止。改后每路到达后约 1 秒出图 | 0 / 3 |
| 26 | **按 IP 限速与"一个办公室共用一个出口 IP"相冲突**:旁观页等开播时每 6 秒领一次播放令牌,而令牌端点每 IP 每小时只给 60 次 —— 提前 6 分钟以上打开页面的人,到开播时已被限住,之后一小时拿不到画面;同一个出口 IP 后面的几十位同事更是合用这 60 次 | 直播开始时大批观众黑屏 | **2026-09-20 发现并已改:** 开播改由总台推送,等待期间不再领令牌(连不上总台时才每 30 秒看一眼门面);门面、令牌、socket 的额度改为每 IP 每会议每小时 3000 次,留名 300 次 | 3 |
| 23 | GStreamer 动态管线的几个坑:`parse_bin_from_description(…, True)` 会把 textoverlay 的**文字**输入当成 bin 的入口(画面无处可去,`not-linked` 让整个接收侧停摆);decodebin 解不了的流会原样吐出来,不接就 `not-linked`;flvmux 不给延迟时音视频时间戳交错出(`Got backwards dts`);管线收尾可能卡死 | 合成器崩溃或输出不合规 | **已解决:** bin 两端手工建 ghost pad;解不了的流接 fakesink;`flvmux latency=500ms`(警告归零);收尾放线程里限时 4 秒,之后 `os._exit` | 0 / 3 |

## 11. 开发计划

每个阶段结束都走一遍:类型检查 → 本地验证 → 递增版本号(功能位)→ 两个账号部署 → `/api/health` 核对。

### 阶段 0:技术验证(不进主干)

目的:用最少的代码消掉第 10 节里会推翻方案的那几条风险。脚本都在 `scratch/`(不入库)。

**进度(2026-09-19):** 第 1、2、3 项通过(第 3 项是在本机 Docker 里跑的容器,不是 Cloudflare 的容器:出向 UDP 在 Cloudflare 容器上另有旁证,见风险 1);第 4 项的编码与封装部分通过,推 Stream 这一步还没做;第 5 项未做。后两步被账号条件卡住:主账号的部署 token 对 Calls 与 Stream 仍返回 403;第二账号的 Calls 已可用,Stream 返回 10002(像是账号尚未开通 Stream)。开发用的 SFU app 与 TURN key 建在第二账号上,名字都叫 `cfmail-dev`,凭据在本机 `.dev.vars`。

1. **SFU 基本回路** ✅:三个无头 Chrome 加假摄像头,走通发布、订阅、部分成功后的退避重试、两种关闭方式、TURN 强制中继。Firefox、Safari 与 iOS 真机还没测。
2. **主画面切换** ✅:新画面约 1 秒可见,交接约 1.2 秒,全程零黑帧。
3. **容器连 SFU** ✅:`container-meet/compositor.py` 以 `bot` 身份从同一扇门进入房间,用 webrtcbin 订阅真实 SFU 上三个 Chrome 发布的轨道,解码、排版(一大 + 右列小画面 / 无大画面时宫格 / 没开摄像头的人是名字卡片,中文名字正常)、混音、OpenH264 编码、FLV 封装,46 秒里经历大画面两次易手和一人离场,输出 30 fps 不断、封装器零警告。能跑通靠的是风险 20~23 的四个做法。测试脚本 `scratch/meet-test-compositor.mjs`(容器在 WSL 的 Docker 里,经 `scratch/meet-relay.mjs` 这个 TCP 中继访问只监听 Windows 回环的 dev server)。TURN 兜底与真正的 Cloudflare 容器上的运行还没测。
4. **容器推 Stream** ✅(2026-09-19 对主账号的真实 Stream 补测,`scratch/meet-spike-stream.mjs`):容器经 `rtmp2sink` 推 **RTMPS**(`rtmps://live.cloudflare.com:443/live/<key>`)被接受,100 秒无错、零封装警告、0.41 核;清单在容器启动后约 16 秒可用(含镜像启动与 OpenH264 下载);Stream 转出 4 档码率,hls.js 播放 1280×720(`avc1.64001f` + AAC)。延迟见风险 3,录制模式见风险 24。以下是此前对 MediaMTX 的记录:compositor + OpenH264 + flvmux 经 `rtmp2sink` 推 RTMP,已对本机的 MediaMTX(一个严格的第三方 RTMP/HLS 服务器,在这里顶替 Stream)验证:推流被接受并全程保持,封装器零警告。真实解码负载下的实测:720p30、一路大画面加两路小画面,**约 0.36 核、196 MiB 内存**(`docker stats`,限两核),与合成信号基准(0.43 核,八路小画面)相符,standard-3 的规格绰绰有余。还没做:推真正的 Stream(RTMPS)、hls.js 播放、LL-HLS 延迟实测 —— 等 Stream 权限。x264 对比不再做:编码器已定 OpenH264。
5. **签名播放地址** ✅:见风险 14。令牌到期续签时播放是否中断还没测(令牌有效期 4 小时,页面在到期前 10 分钟换新地址,但正在播放的会话不会被切换)。
6. **产出**:把结论追加到本文档第 10 节,给出继续或重议的判断。

### 阶段 1:小组会议核心

**进度(2026-09-19):已实现,本地测试全部通过,尚未部署。** 信令层 40 余项(门禁、等候室、放行与拒绝、发布权限、主画面三种规则、锁定与收回、人数上限、静音踢人、结束)用脚本客户端跑;界面端到端 20 项用真浏览器加真实 SFU 跑(一位主持人、两位访客、一台手机视口),含交接零黑帧。尚未做:Firefox / Safari / iOS 真机、断网重连的专项测试、录制(属阶段 2)。

- **后端**:`migrations/0040_meet.sql`;`src/meet.ts`(`meetApp`、`meetPubApp`、`MeetRoom`);`src/index.ts` 导出 DO;`src/api.ts` 挂载路由与 `/api/me` 标志;`src/admin.ts` 的域名开关与上限;`src/types.ts` 的 `Env`;审计埋点。
- **配置**:`wrangler.example.jsonc`、`scripts/wrangler-config.mjs`、`scripts/deploy.mjs`(建 SFU app 与 TURN key)。
- **前端**:`public/assets/meet/` 下除 `record.js`、`live.js`、`e2ee/` 之外的全部;导航入口;九语言词条;手机布局。
- **功能**:创建即时会议;凭链接入会;设备预检;音频、可选视频、屏幕共享;一大多小与「切到我」(三种切换规则);聊天、举手、名册;主持人放行、踢人、全员静音、锁定;访客与等候室;纯音频会议;断线重连。
- **测试**:Playwright 无头 + 假媒体设备,多个 context 进同一房间,断言轨道数、主画面归属、等候室、踢人、重连;手工测 iOS Safari、Android Chrome、Firefox。
- **验收**:6 人 720p 会议稳定 30 分钟;主画面切换黑屏不超过 1 秒;拔网线 10 秒内自动恢复;缺绑定的部署上入口不出现且其余功能不受影响。

### 阶段 2:打通邮件、网盘、录制与纪要

**进度(2026-09-19):已实现,本地测试全部通过。** 邀请 13 项(`scratch/meet-test-invite.mjs`);录制、转写、纪要、发信的接口级 26 项(`scratch/meet-test-keep.mjs`,语音模型与对话模型都是真的问);浏览器级 29 项(`scratch/meet-test-record.mjs`:真 Chrome、真 SFU,主持人的假麦克风播放一段 TTS 生成的讲话,访客中途拿走大画面)。尚未做:把文档作为主画面的一种 `kind`(第二步)。

- 邀请邮件(站内直投,外部走发信通道)与 .ics;预约会议;个人常驻会议室;会议列表与历史场次。
- 会中演示网盘文档:第一步是链接联动(会议聊天里出现演示入口,点开即现有的旁观页);第二步把文档作为主画面的一种 `kind`(仅小组会议,合成容器渲染不了文档)。
- 主持人本地录制进网盘;音频分段;whisper 转写;AI 纪要;会后邮件。

实现中定下来的几件事(与 4.6 的原始描述相比):

- **边录边传。** 录制器每 2 秒吐一块,前端攒满 8 MiB 就作为一个分片送走(R2 要求除最后一片外每片等大,所以按字节精确切)。`upload/init` 申报的大小只用于第一道配额检查(申报 32 MiB),真实大小在 `complete` 时核对;录制中每十秒左右看一眼余量,不够了就自动停并保存已录部分。
- **断了也不白录。** 每送完一片,就把「上传 id + 已完成的分片表」记进 `localStorage`;标签页没了的录制,下次打开会议列表页时用已送上去的分片直接 `complete`,文件终止在最后一个完整分片处(分片 MP4 从头播到那里为止)。45 秒内有心跳的记录视为仍在录,不去碰。
- **容器格式。** 优先 `video/mp4;codecs="avc1.640028,mp4a.40.2"`(Chrome 126+ 与 Safari;High@L4.0 才容得下 1080p),其次 WebM(VP9 / VP8 + Opus,Firefox)。纯音频会议录 `audio/mp4` 或 `audio/webm`。
- **画面。** 有大画面时录大画面(等比放进 16:9,左下角写持有者名字,不镜像);没人持有大画面时录主持人屏幕上现成的那页小画面宫格(最多 16 格),免得录成一小时空白。canvas 由 Worker 定时器驱动(24 fps),标签页切到后台也不掉帧。
- **声音。** 所有远端麦克风加主持人自己的麦克风,在 WebAudio 图里相加,只通向录制器;图里常驻一个恒零源,保证从第一帧起就有采样。
- **纪要是主持人开始录制时的第二个、单独的勾选**,也可以只要纪要不要录像。音频分段用 32 kbps Opus/WebM,五分钟一段,下一段先开、上一段再停(不丢字);整段几乎无声(约一秒以上的有效声音都没有)的不送。
- **whisper 直接调用、带 `vad_filter`。** SDK 不转交这个开关,而不开它时,静音会被转写成 "Thank you."、噪声会被转写成 "Obrigado."(实测)。其余 ASR 模型仍走 SDK。
- **服务端不保存文字稿。** 文字留在主持人的浏览器里直到录制停止,然后一次性送去写摘要,由浏览器自己把 Markdown 存进网盘「会议录制」文件夹。**纪要不会自动寄出**:主持人在结果对话框里过目后点「发给受邀人」才发(收件人 = 受邀人 + 组织者;一个都没有时寄给自己),文字稿作为 `.md` 附件。
- **「正在录制」标记记在房间里,并记着是谁在录**(`rec_by`):录制的人一离开标记就熄;另一位主持人既不能再叠一份录制,也关不掉别人的标记。断线重连后由浏览器重新声明。
- **没开通网盘的主持人**:录像与纪要改为在结束时下载到本机。
- **谁能录**:创建者,或以联席主持人身份受邀的同事;会议须在创建时打开「录制」(`record_mode='local'`)。

### 阶段 3:直播会议

**进度(2026-09-19,3.33.0):主干已实现,并在本机端到端跑通;线上处于休眠状态,等 Stream 权限。**

本机跑通的那条链路(`scratch/meet-test-live.mjs`,22 项全过):主持人点「开始直播」→ 房间显示「正在准备直播…」→ 合成容器以 `bot` 身份进门(点击后约 2 秒,本机容器是热的)→ 房间显示「直播中」→ 容器向 MediaMTX(顶替 Stream)推 RTMP → 一个**没有账号**的浏览器打开 `#/live/<code>`,用 hls.js 播放,**点击后约 9 秒出第一帧**,画面持续前进 → 主持人「结束直播」→ 合成器被请出房间、旁观页回到等待。`audience_access='signin'` 的会议,未登录者拿不到播放地址(401)。

已有的部件:

- `container-meet/compositor.py`(合成器本体,见阶段 0 第 3 项与风险 20~23)、`server.py`(容器的 HTTP 控制面:`/health`、`/start`、`/stop`、`/status`;合成器作为子进程,管线崩了控制面还在)、`frames.py`(从产物里抽帧目检)、Dockerfile 入口改为 `server.py`。
- `src/meetlive.ts`:`MeetCompositor` 容器 DO(每场会议一个实例);live input 的创建与回收(一律 `requireSignedURLs`);播放令牌在 Worker 本地用 RS256 自签(不为每位观众去问 Stream);合成器的启动、停止、状态查询。**提供方有一个接缝**:`liveProvider()` 在生产上是 `stream`,在开发机上(`DEV_MODE=1` 且设了 `MEET_DEV_RTMP` / `MEET_DEV_HLS`)是 `dev` —— 任意一个"RTMP 进、HLS 出"的服务器顶替 Stream,合成器由跑测试的人按房间交出的指令(`live_manual`)手工启动。其余全是同一份代码。
- `MeetRoom`:`live_start` / `live_stop`(仅主持人、仅直播会议);`live` 状态随 bot 进出在 `starting` / `on` 之间切换;结束会议、最后一人离开都会停播并回收 input;当前场次的 `live_input_uid` 记在 `meeting_sessions` 里,旁观接口据此判断是否在播。
- 旁观接口:`GET /api/meet-pub/live/:code`(门面)、`POST /api/meet-pub/live/:code/token`(发播放地址;`signin` 模式要求已登录;均按 IP 限速)。
- 前端:`public/assets/meet/live.js` 旁观页(未开播时每 6 秒再问一次,开播后自动播放;自动播放是静音的,给一个「点此打开声音」);房间 ⋮ 菜单里的「开始直播 / 结束直播 / 复制旁观链接」与顶栏「直播中」标记;创建对话框里直播会议的两项设置(谁可以旁观、直播录像)。hls.js(light 构建,Apache-2.0)经 `sync-vendor.mjs` 进 `public/vendor/hls/`。
- **旁观页一律优先 hls.js,只有 hls.js 跑不了的地方(iPhone)才用浏览器自带的 HLS。** 新版桌面 Chrome 自称能播 HLS(`canPlayType` 返回真),却解析不了低延迟清单(实测 `DEMUXER_ERROR_COULD_NOT_PARSE`)。
- 登录后回跳的白名单补上了 `#/meet/…` 与 `#/live/…`(此前未登录的同事点会议链接,登录后会落到收件箱而不是会议;3.31.0 起就有的疏漏)。

**部署接线(2026-09-19,3.33.2):**

- `scripts/wrangler-config.mjs`:`containerImage(text, className)` 改为解析后按类名查(容器可以不止一个了);新增 `withMeetContainer()`(containers 条目 + `MEET_COMPOSITOR` 绑定 + migration,带自检:结果必须是"原配置加上恰好这几样",否则返回 null);`withBackupContainer()` 遇到已有的 containers 数组时加入其中,而不是再写一个同名键。离线测试 `scratch/meet-test-wcfg.mjs`(模板、两种先后顺序、幂等、替换、两份真实配置只读校验)。写这段时自检真的拦下过一个错:按类名找 image 的正则先命中了绑定里的类名,差点改掉备份容器的镜像。
- `scripts/deploy.mjs`:`--meet-image <ref>`(配置会记住;没有公共镜像之前没有默认值)与 `--stream-token <t>`(Worker 运行时用的、只有 Stream·Edit 的令牌,**刻意不是部署 token**,与 `--backup-token` 同理;传入部署 token 本身会被拒绝)。带 `--stream-token` 的那次运行还会创建 Stream 签名钥匙(`STREAM_SIGNING_KEY_ID` / `STREAM_SIGNING_JWK`)和 `MEET_BOT_KEY`。README 的权限说明、PRIVACY 已同步。
- **主账号现状:** 合成镜像由 WSL 里的 `wrangler containers build -p` 推到了账号自己的镜像仓库(`registry.cloudflare.com/<account>/cfmail-meet:50ff0fa24d68`,Windows 上没有 docker);容器应用 `cfmail-meetcompositor`(standard-3,最多 4 个实例)与 `MEET_COMPOSITOR` 绑定已随 3.33.2 部署。**只差 `--stream-token`**:用户建一个只有 Account · Stream · Edit 的令牌,跑一次 `npm run deploy -- --stream-token <令牌>`,再到后台 → 会议里给域名打开直播。
- **到那时才会第一次真正执行、因而尚未验证的:** 容器 DO 的启动与 `/start` 调用、容器内向公网 Worker 的 wss 连接、Cloudflare 容器到 SFU 的出向 UDP(风险 1)、容器冷启动耗时、保活 alarm 与自动重启、每小时的录像清扫。
- 公共镜像:已于 2026-10-03 发布(`docker.io/cfmail/cfmail-meet:8d2da049913a`),`container-meet/published.json` 已写下,见 8.2。改了 `container-meet/` 之后要重新发布(`publish-image.mjs --image meet`),否则部署会提醒源码与镜像不符。

还没做、且都卡在 Stream / 容器平台上没法验证的(上面已覆盖的部分以上面为准):

- 部署接线:合成镜像的发布(`publish-image.mjs` 支持第二个镜像)、`wrangler` 的 containers 块与 `MEET_COMPOSITOR` 绑定及迁移、Stream 签名钥匙的创建与四个 secret(`STREAM_API_TOKEN`、`STREAM_CUSTOMER_CODE`、`STREAM_SIGNING_KEY_ID`、`STREAM_SIGNING_JWK`)、`MEET_BOT_KEY`、`CF_ACCOUNT_ID`;README 权限表的 **Account · Stream · Edit** 一行。
- 对真正的 Stream 验证:RTMPS 推流、LL-HLS 延迟、签名地址对 live input 是否生效(风险 14)、`?protocol=llhls` 清单在 hls.js 下的表现。
- 「录制到网盘」(容器旁路写分片 MP4 → 经 Worker 分片上传)。

**旁观者互动(2026-09-20):** 聊天、申请发言、提升为发言人、在看人数、开播推送,设计见 4.4「旁观者互动」。代码:`src/meetaudience.ts`(`MeetAudience` DO 与三种凭证的签发和校验)、`src/meet.ts`(旁观 socket 与留名两个端点、门口认发言入场券、房间发后台证 / 踢人作废 / 结束时通知总台)、`public/assets/meet/audience.js`、`live.js`(重写)、`room.js`(观众页签、申请队列、在看人数、凭券入座)。

3.33.1 补上了保活:直播期间房间每分钟(DO alarm)问一次合成器的状态 —— 这一问正是让容器不被休眠的东西(没人搭理的实例 10 分钟后休眠)—— 发现它没在跑,就用同一个 input、一张新入场券重新启动。推流地址(含密钥)只存在 DO 自己的存储里。会议无论从房间里还是房间外结束,直播都随之结束。这段逻辑在没有容器绑定的环境里是空转的,所以**还没有被真正执行过**。

- `container-meet/`:Dockerfile 与 Python 控制器;`publish-image.mjs` 支持第二个镜像;`MeetCompositor` DO;`wrangler-config.mjs` 增加对应的写入与移除函数。
- Stream live input 的创建与回收(一律要求签名地址);signing key;`live_start` / `live_stop`;Stream 侧录像登记到 `meeting_recordings`。
- 「录制到网盘」:容器旁路写分片 MP4、经 Worker 分片上传、会中开关(`rec`)、配额预检、「正在录制」标记。
- 旁观页 `#/live/<code>`;两种旁观权限(`link` / `signin`)与播放令牌的领取、续签;vendor hls.js(`scripts/sync-vendor.mjs`);`MeetAudience` DO 与分片;申请发言与提升。
- 后台:`meet_live_enabled` 开关与计费说明。
- 验收:8 位发言人、720p、直播 1 小时不中断;`signin` 模式下未登录者拿不到画面,裸播放地址无效;会中开关录制三次,得到三个可播放的文件;主画面换人在旁观端无缝;LL-HLS 延迟达到阶段 0 的实测值;容器在会议结束后 1 分钟内退出。

### 阶段 4:端到端加密

**已完成(2026-09-20,3.35.0)**,做法见 4.5(用户改定为"密钥在链接 `#` 之后、本机保存、旁路传递",不再移植 MLS)。未测:iOS/Safari/Firefox 真机上的加密会议。

## 12. 默认值与待定

已采用的默认值(用户未反对;均可由管理员按域名调整):

- 小组会议上限 32 人;直播发言人上限 8 人(用户 2026-09-19 定)。
- 访客默认关闭;画幅默认 720p(每个人摄像头的上限;人多时自动降档,见 4.2)。
- 旁观权限默认凭链接公开;「录制到网盘」默认关。

待定:

- H.264 编码器:已给出建议(3.1:默认 OpenH264 运行时下载,x264 为自建选项),等用户确认。
- 「仅本公司可看」目前的含义是「本实例的任何已登录用户」。是否要细到「只有会议所在域名的用户」,用到再加第三个取值。

## 13. 参考

- Realtime SFU:<https://developers.cloudflare.com/realtime/sfu/>(会话与轨道、HTTPS API、限制、定价)
- Realtime TURN:<https://developers.cloudflare.com/realtime/turn/>
- Stream Live 推流要求:<https://developers.cloudflare.com/stream/stream-live/start-stream-live/>
- Stream WebRTC(WHIP/WHEP):<https://developers.cloudflare.com/stream/webrtc-beta/>
- Stream 定价:<https://developers.cloudflare.com/stream/pricing/>
- Containers 定价与规格:<https://developers.cloudflare.com/containers/pricing/>
- Durable Objects 限制:<https://developers.cloudflare.com/durable-objects/platform/limits/>
- Workers AI 定价:<https://developers.cloudflare.com/workers-ai/platform/pricing/>
- Orange Meets(参考实现与 E2EE 设计):<https://github.com/cloudflare/orange>、<https://blog.cloudflare.com/orange-me2eets-we-made-an-end-to-end-encrypted-video-calling-app-and-it-was/>
- 本仓库内的先例:`src/present.ts`(房间 DO)、`src/backup.ts` 与 `container/`(容器)、`src/forms.ts`(不在登录之后的公开入口与限速)
