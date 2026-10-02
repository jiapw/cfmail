# Third-party notices / 第三方组件许可声明

CFMail itself is MIT licensed (see [LICENSE](LICENSE)). This file lists the third-party components distributed with, or pulled in at build time by, this project, along with their licence requirements.

CFMail 本体以 MIT 授权(见 [LICENSE](LICENSE))。本文件列出随本项目分发或在构建时引入的第三方组件及其许可要求。

Most components are permissively licensed (MIT / MIT-0 / BSD-3-Clause / Apache-2.0). **No component carries a strong copyleft licence and none is commercially licensed.** Two are weak copyleft, both **LGPL-2.1**: FFmpeg, which reaches this project as libav.js, and GStreamer, inside the container image broadcast meetings are composited in. What LGPL asks for is that the source stay available and that the library stay replaceable — both hold here, and the entries below say how. One build option is GPL — x264, in a compositor image somebody builds for themselves (section 4); no image this project publishes is built that way.

多数组件为宽松许可(MIT / MIT-0 / BSD-3-Clause / Apache-2.0)。**没有任何组件带强 copyleft 许可,也没有任何商业授权组件。** 有两个是弱 copyleft,都是 **LGPL-2.1**:FFmpeg,经由 libav.js 进入本项目;GStreamer,在直播会议的合成容器镜像里。LGPL 所要求的是"源码保持可获取"与"库保持可被替换" —— 这两条在这里都成立,下文对应条目说明了是怎么成立的。有一个构建选项是 GPL —— 自己构建合成镜像时可选的 x264(见第 4 节);本项目发布的镜像从不这样构建。

---

## 1. Components loaded directly by the browser / 浏览器直接加载的组件

These live under `public/vendor/` at runtime and are served to end users, so **their copyright notices must be preserved**. All but one are **not** committed to this repository — `scripts/sync-vendor.mjs` copies them from `node_modules` (see [README](README.md#local-development--本地开发)). The exception is `libav-full/`, which no npm package contains and which therefore has to be built and committed; its entry below says why.

这些组件在运行时位于 `public/vendor/`,会随部署发给终端用户,**它们的版权声明必须保留**。除一个之外,它们都**不在本仓库里** —— 由 `scripts/sync-vendor.mjs` 从 `node_modules` 拷贝。那个例外是 `libav-full/`:没有任何 npm 包含有它,因此只能构建出来并提交入库;下文它的条目说明了原因。

### Web Awesome → `public/vendor/wa/`

```
MIT License
Copyright (c) 2025 Fonticons, Inc.
```

Copied from the `dist-cdn` folder of the npm package `@awesome.me/webawesome` v3.11.0. Only the free-tier components are used.

自 npm 包 `@awesome.me/webawesome` v3.11.0 的 `dist-cdn` 拷贝。仅使用免费版组件。

**Font Awesome icon assets are NOT included.** Font Awesome's free icons are CC BY 4.0 and its Pro icons are proprietary; this project ships its own hand-built icon set in `public/assets/icons.js` and does not use either.

**未包含 Font Awesome 图标资源。** 免费图标为 CC BY 4.0、Pro 图标为专有授权;本项目的图标是自建的 `public/assets/icons.js`,与 Font Awesome 无关。

### Quill → `public/vendor/quill/`

```
BSD 3-Clause License
Copyright (c) 2017-2024, Slab
Copyright (c) 2014, Jason Chen
Copyright (c) 2013, salesforce.com
```

v2.0.3. The BSD-3-Clause licence includes a no-endorsement clause: the names of the copyright holders and contributors may not be used to promote derived products.

v2.0.3。BSD-3-Clause 含"不得用原作者或贡献者名义为衍生产品背书"条款。

### postal-mime → `public/vendor/postal-mime/`

```
MIT-0 License
Copyright (c) 2021-2025 Andris Reinman
```

The ESM sources of v2.7.6. `base64-encoder.js` within it contains third-party code:

v2.7.6 的 ESM 源码。其中 `base64-encoder.js` 内含第三方代码:

```
MIT License
Copyright 2011 Jon Leighton
```

### pdf.js → `public/vendor/pdfjs/`

```
Apache License 2.0
Copyright Mozilla Foundation
```

From the npm package `pdfjs-dist` v6.2.108: `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, plus the `cmaps/` and `standard_fonts/` assets (needed for CJK and non-embedded-font PDFs). Used by the Drive feature to render PDF thumbnails and previews in the browser. The full licence text ships alongside at `public/vendor/pdfjs/LICENSE`; the package contains no NOTICE file, and this project does not modify its code.

自 npm 包 `pdfjs-dist` v6.2.108:`build/pdf.min.mjs`、`build/pdf.worker.min.mjs`,及 `cmaps/`、`standard_fonts/` 资源(中日韩与未内嵌字体的 PDF 需要)。网盘功能用它在浏览器渲染 PDF 缩略图与预览。完整许可文本随包分发于 `public/vendor/pdfjs/LICENSE`;该包无 NOTICE 文件,本项目未修改其源码。

### marked → `public/vendor/marked/`

```
MIT License
Copyright (c) 2018+, MarkedJS
Copyright (c) 2011-2018, Christopher Jeffrey
```

`lib/marked.esm.js` from the npm package `marked` v18.0.10. The Markdown editor (`assets/md/`) promises GitHub's dialect rather than an approximation of it, and that dialect is a specification with a test suite whose interesting parts are its edge cases. Loaded on demand: a person who never edits a document never fetches it. This project does not modify its code.

自 npm 包 `marked` v18.0.10 的 `lib/marked.esm.js`。Markdown 编辑器(`assets/md/`)承诺的是 GitHub 的方言本身而不是它的近似,而那份方言是一份带测试套件的规范,其中有意思的部分正是它的边角。按需加载:从不编辑文档的人不会取到它。本项目未修改其源码。

### marked-footnote → `public/vendor/marked-footnote/`

```
MIT License
A project by Stilearning (Beni Arisandi) © 2023-2024
```

`dist/index.js` from the npm package `marked-footnote` v1.4.0. Footnotes are part of GitHub's dialect and are not part of marked's core; without this, a document that uses them shows its machinery instead of its notes. The package ships no licence file of its own — the licence above is the one it declares in `package.json` and its readme. This project does not modify its code.

自 npm 包 `marked-footnote` v1.4.0 的 `dist/index.js`。脚注属于 GitHub 的方言,而不属于 marked 的核心;没有它,用脚注的文档展示的是自己的机械而不是自己的注释。该包不随附许可文件 —— 上面的许可取自它在 `package.json` 与自述文件中的声明。本项目未修改其源码。

### DOMPurify → `public/vendor/dompurify/`

```
DOMPurify 3.4.14 | (c) Cure53 and other contributors
Released under the Apache License 2.0 and Mozilla Public License 2.0 (dual-licensed)
```

`dist/purify.es.mjs` from the npm package `dompurify` v3.4.14. GitHub's dialect passes inline HTML through, so something must decide what may pass — a decision that is a security boundary, since a document is written by whoever hands you one. Both licence texts ship alongside at `public/vendor/dompurify/LICENSE` and `LICENSE-MPL`. This project does not modify its code.

自 npm 包 `dompurify` v3.4.14 的 `dist/purify.es.mjs`。GitHub 的方言允许内联 HTML 通过,于是总得有谁来决定什么可以通过 —— 而这个决定是一道安全边界,因为文档的作者就是把文档递给你的那个人。两份许可文本随包分发于 `public/vendor/dompurify/LICENSE` 与 `LICENSE-MPL`。本项目未修改其源码。

### qpdf (WASM) → `public/vendor/qpdf/`

```
qpdf, compiled to WebAssembly (npm package qpdf-wasm-esm-embedded)
Released under the Apache License 2.0
```

`qpdf.mjs` from the npm package `qpdf-wasm-esm-embedded` v1.1.1 — qpdf's command line compiled to WASM, in one self-contained ES module with the wasm embedded. The PDF editor loads it on demand, and only when a password is actually met or asked for: it lays an encrypted file open into bytes the editing pipeline can hold, and locks the built document again (AES-256) on its way back out. The licence text ships alongside at `public/vendor/qpdf/LICENSE`. This project does not modify its code.

自 npm 包 `qpdf-wasm-esm-embedded` v1.1.1 的 `qpdf.mjs` —— qpdf 的命令行编译为 WASM,单个自含 wasm 的 ES 模块。PDF 编辑器按需加载它,且只在真正遇到或要设密码时:它把加密文件摊开成编辑管线拿得住的字节,再在出门的路上把搭好的文档锁回去(AES-256)。许可文本随包分发于 `public/vendor/qpdf/LICENSE`。本项目未修改其源码。

### CodeMirror 6 → `public/vendor/codemirror/`

```
MIT License
Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
```

Built from source rather than copied. CodeMirror 6 is published as several dozen npm packages that import one another by bare name, which no browser can resolve, so `npm run vendor` bundles them with esbuild into this directory — 37 packages in all, every one of them MIT, including the grammars (`@lezer/*`) and three small dependencies of the view (`crelt`, `style-mod`, `w3c-keyname`). Because minification discards everything that is not code, the notices are gathered back and written to `public/vendor/codemirror/LICENSE`, generated from the list of packages the bundler actually reached rather than from a list kept by hand. Split by language: opening a shell script fetches the shell grammar and not the other thirty-four. Loaded on demand, and only by the source editor (`assets/code/`). This project does not modify its code.

自源码构建,而非拷贝。CodeMirror 6 以几十个 npm 包发布,彼此用裸名互相引用,而浏览器解析不了裸名,于是 `npm run vendor` 用 esbuild 把它们打进本目录 —— 共 37 个包,每一个都是 MIT,其中包括各种文法(`@lezer/*`)与视图的三个小依赖(`crelt`、`style-mod`、`w3c-keyname`)。由于压缩会丢掉一切不是代码的东西,那些声明被重新收集,写入 `public/vendor/codemirror/LICENSE` —— 名单取自打包器实际够到的那些包,而不是一份手工维护的清单。按语言分块:打开一个 shell 脚本取回的是 shell 文法,而不是另外三十四种。按需加载,且只由源码编辑器(`assets/code/`)加载。本项目未修改其源码。

### hls.js → `public/vendor/hls/`

```
Apache License 2.0
Copyright (c) 2017 Dailymotion (http://www.dailymotion.com)
src/remux/mp4-generator.js and src/demux/exp-golomb.ts are derived from the HLS library for
video.js (https://github.com/videojs/videojs-contrib-hls), also Apache-2.0:
Copyright (c) 2013-2015 Brightcove
```

The light build (`dist/hls.light.min.mjs`) of the npm package `hls.js` v1.7.3, which plays a broadcast meeting on the watching page (`public/assets/meet/live.js`). The package's `LICENSE` is copied beside it, since the minified file carries no notice of its own. The package contains no NOTICE file, and it is not modified.

npm 包 `hls.js` v1.7.3 的 light 构建(`dist/hls.light.min.mjs`),在旁观页(`public/assets/meet/live.js`)播放直播会议。包里的 `LICENSE` 随它一起拷过去,因为压缩后的文件本身不带版权声明。该包没有 NOTICE 文件,本项目也未修改它。

### libav.js, built here → `public/vendor/libav-full/`

```
LGPL-2.1-or-later
FFmpeg: Copyright (c) 2000-2025 the FFmpeg developers
libav.js: Copyright (c) 2019-2025 Yahweasel and contributors
```

**This one is our build, not upstream's**, and that is the only reason it exists. Upstream publishes every variant except those enabling codecs whose patent situation makes a maintainer decline to ship binaries — which is exactly the set needed here: the AVI demuxer, and decoders for the AC-3 and DTS that disc rips carry and no browser plays. The configuration is upstream's to begin with; the binary is not, so it is built by `scripts/build-libav.sh` and committed. It is the one thing under `public/vendor/` that `npm run vendor` cannot produce, which is why the ignore rule has an exception for it.

**Corresponding source.** Nothing here is patched. The build is FFmpeg and libav.js at upstream tag `v6.10.9.0` (<https://github.com/Yahweasel/libav.js>) with the feature selection in `scripts/build-libav.sh` — the fragment list in that file, recorded again in `public/vendor/libav-full/build.json` with a fingerprint the vendor step checks. Those two published things reproduce this exact binary; that is what LGPL asks for and all of it is in this repository.

It contains **no video decoders**. It opens boxes and decodes sound; the pictures are still the browser's to decode, in hardware. So an AVI holding H.264 plays and one holding Xvid does not, and that is deliberate rather than an oversight — decoding video in WebAssembly is a different and far more expensive thing than this project is doing.

**这一份是我们自己的构建,不是上游的**,而这也是它存在的唯一理由。上游发布了每一个变体,唯独不发那些启用了"专利状况让维护者不愿分发二进制"的编码的 —— 而那恰恰就是这里需要的那一组:AVI 解复用器,以及碟版片源所带、没有浏览器放得了的 AC-3 与 DTS 的解码器。配置本来就是上游的;二进制不是,所以由 `scripts/build-libav.sh` 构建并提交入库。它是 `public/vendor/` 下唯一一样 `npm run vendor` 造不出来的东西,忽略规则为它开例外正是这个原因。

**相应源码。** 这里没有任何补丁。这份构建是上游标签 `v6.10.9.0`(<https://github.com/Yahweasel/libav.js>)的 FFmpeg 与 libav.js,加上 `scripts/build-libav.sh` 里的特性选择 —— 那个文件里的片段清单,在 `public/vendor/libav-full/build.json` 里又记了一遍,带一个由 vendor 步骤核对的指纹。这两样已公开的东西就能复现出这个确切的二进制;LGPL 要的就是这个,而它们全部在这个仓库里。

它**不含任何视频解码器**。它负责打开盒子、解出声音;画面仍旧交给浏览器去解,而且是硬件解。所以一个装着 H.264 的 AVI 能放,装着 Xvid 的不能 —— 这是有意为之而不是疏漏:在 WebAssembly 里解视频,是另一件事,而且比这个项目正在做的事昂贵得多。

---

## 2. Build and runtime dependencies / 构建与运行期依赖

| Component | Version | Licence | Copyright |
|---|---|---|---|
| `agents` | 0.20.1 | MIT | Copyright (c) 2025 Cloudflare, Inc. |
| `ai` | 7.0.60 | **Apache-2.0** | Copyright 2023 Vercel, Inc. |
| `aws4fetch` | 1.0.20 | MIT | Copyright 2018 Michael Hart (michael.hart.au@gmail.com) |
| `hono` | 4.13.1 | MIT | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors |
| `postal-mime` | 2.7.6 | MIT-0 | Copyright (c) 2021-2025 Andris Reinman |
| `workers-ai-provider` | 4.0.0 | MIT | Copyright (c) 2025 Cloudflare, Inc. |
| `zod` | 4.4.3 | MIT | Copyright (c) 2025 Colin McDonnell |
| `@awesome.me/webawesome` | 3.11.0 | MIT | Copyright (c) 2025 Fonticons, Inc. |
| `@radix-ui/colors` | 3.0.0 | MIT | Copyright (c) 2021 Radix |
| `quill` | 2.0.3 | BSD-3-Clause | Copyright (c) 2017-2024, Slab |
| `pdfjs-dist` | 6.2.108 | **Apache-2.0** | Copyright Mozilla Foundation |
| `hls.js` | 1.7.3 | **Apache-2.0** | Copyright (c) 2017 Dailymotion; parts Copyright (c) 2013-2015 Brightcove |
| `@cloudflare/containers` | 0.3.7 | MIT OR Apache-2.0 | Cloudflare (<https://github.com/cloudflare/containers>); the package ships no licence text, only the declaration in its `package.json` |

### Note on the Apache-2.0 component (`ai`) / 关于 Apache-2.0 组件

`ai` (the Vercel AI SDK) is licensed under the Apache License 2.0. Per section 4 of that licence:

`ai`(Vercel AI SDK)以 Apache License 2.0 授权。按其第 4 条:

- The full licence text ships with the package at `node_modules/ai/LICENSE`.
  完整许可证文本随该包分发。
- The package contains **no NOTICE file**, so there is no NOTICE content to reproduce.
  该包**未包含 NOTICE 文件**,因此无需转载 NOTICE 内容。
- **This project does not modify the `ai` package** — it is consumed as a dependency only.
  **本项目未修改 `ai` 包的源码**,仅作为依赖调用。

---

## 3. Fetched at runtime, not distributed / 运行期获取、不随仓库分发

### Fonts / 字体

Interface and body fonts chosen by users are fetched by the Worker from Google Fonts (`src/fonts.ts`) and cached in the operator's own R2 bucket. Fonts served through Google Fonts are typically licensed under the SIL Open Font License 1.1 or Apache-2.0, both of which permit network distribution.

用户在设置里选择的界面/正文字体由 Worker 从 Google Fonts 代理获取,字体文件缓存在部署方自己的 R2 里。Google Fonts 收录的字体多为 SIL Open Font License 1.1 或 Apache-2.0,允许网络分发。

**Note**: this is a server-side proxy — the browser never connects to Google directly, so end users' IP addresses never reach them. See [PRIVACY.md](PRIVACY.md).

**注意**:是 Worker 服务端代理,浏览器从不直连 Google —— 终端用户 IP 不会到达 Google。

### Radix Colors

`@radix-ui/colors` is used only at build time to generate themes (`scripts/build-themes.mjs`). The output, `public/assets/themes.css`, contains colour values, not its source.

`@radix-ui/colors` 只在构建期用于生成主题,产物是色值,不含其源码。

---

## 4. Container images / 容器镜像

Two features run in a container on the operator's own account, each built from a directory of this repository: the automatic backup (`container/`) and the compositor broadcast meetings are made in (`container-meet/`). An installation either pulls a published image of them or builds its own; either way everything inside comes from the base image's distribution, unmodified, and the Dockerfile is the whole recipe.

有两项功能跑在部署方自己账号里的容器中,各由本仓库的一个目录构建:自动备份(`container/`)与直播会议的合成器(`container-meet/`)。一套安装要么拉取已发布的镜像,要么自己构建;无论哪种,里面的东西都原样来自基础镜像所属的发行版,Dockerfile 就是完整的构建配方。

### The broadcast compositor → `container-meet/`

Ubuntu 24.04 packages. The ones the compositor actually uses:

| Component | Licence | What it does here |
|---|---|---|
| GStreamer 1.24 (core, plugins-base, -good, -bad), `gstreamer1.0-nice` | LGPL-2.1-or-later | the pipeline: WebRTC (`webrtcbin`), decoding, layout (`compositor`), mixing, FLV, RTMP |
| libnice | MPL-1.1 or LGPL-2.1 | ICE for `webrtcbin` |
| libvpx | BSD-3-Clause | VP8 decoding |
| libopus | BSD-3-Clause | Opus decoding |
| VisualOn AAC encoder (vo-aacenc, `voaacenc`) | Apache-2.0 | the sound sent to Stream |
| Python 3, PyGObject | PSF-2.0, LGPL-2.1-or-later | the controller (`compositor.py`, `server.py`) |
| python3-websockets | BSD-3-Clause | the connection to the meeting's room |
| Noto Sans CJK (Regular only) | SIL OFL-1.1 | the names under each picture |

**Corresponding source** for every package is in Ubuntu's archive, at the version in the image (`apt-get source <package>`); nothing is patched. That, and the libraries staying ordinary shared objects that can be swapped, is what LGPL asks of whoever distributes the image.

**OpenH264 is not in the image.** When the container starts it downloads Cisco's binary of OpenH264 (2.4.1) from Cisco and checks it against the hash Cisco publishes (`container-meet/openh264.py`): Cisco's patent licence for H.264 covers the binary Cisco distributes, on the condition that it is fetched from Cisco. The attribution Cisco requires wherever licensing information is shown:

> OpenH264 Video Codec provided by Cisco Systems, Inc.

The binary is under the BSD licence; its source is at <https://www.openh264.org/>. Cisco's licence text for the binary — the BSD licence plus a notice of the AVC/H.264 patent portfolio licence — is at <https://www.openh264.org/BINARY_LICENSE.txt>, and Cisco asks that it be shown in the same place as the attribution. It also says that the patent licence passed on covers personal and non-remunerated use, and that content providers and broadcasters may need a separate licence from the patent pool — worth reading before broadcasting for paying viewers.

**The x264 build option** (`docker build --build-arg H264=x264`) adds x264 and FFmpeg's libraries through `gstreamer1.0-plugins-ugly` and `gstreamer1.0-libav`, which are **GPL** and carry no patent licence. An image built that way is its builder's to distribute under the GPL; images this project publishes are never built that way.

Ubuntu 24.04 的软件包。合成器实际用到的有:上表所列(GStreamer 1.24 及 libnice 为 LGPL;libvpx、libopus 为 BSD-3-Clause;vo-aacenc 为 Apache-2.0;Python / PyGObject;python3-websockets;Noto Sans CJK 为 OFL-1.1,只留 Regular 一个字重)。

**相应源码**:每个包都在 Ubuntu 的软件仓库里,与镜像中的版本对应(`apt-get source <包名>`),未打任何补丁。这一点,加上这些库都是可替换的普通共享库,就是 LGPL 对分发镜像者的要求。

**OpenH264 不在镜像里。**容器启动时从 Cisco 下载 OpenH264 的 Cisco 二进制(2.4.1),并用 Cisco 公布的哈希校验(`container-meet/openh264.py`):Cisco 为它自己分发的二进制提供 H.264 专利许可,条件是从 Cisco 那里取得。Cisco 要求在展示许可信息的地方给出上面引用的那一行署名。该二进制以 BSD 授权,源码见 <https://www.openh264.org/>。Cisco 对该二进制的许可原文 —— BSD 许可加一段 AVC/H.264 专利池许可的说明 —— 在 <https://www.openh264.org/BINARY_LICENSE.txt>,Cisco 要求它与署名出现在同一处。原文还指出:它转授的专利许可覆盖个人及不收费的使用,内容提供者与广播者可能需要另向专利池取得许可 —— 面向付费观众直播之前值得一读。

**x264 构建选项**(`docker build --build-arg H264=x264`)会经由 `gstreamer1.0-plugins-ugly` 与 `gstreamer1.0-libav` 加入 x264 与 FFmpeg 的库,它们是 **GPL**,且不附带任何专利许可。这样构建的镜像由构建者按 GPL 自行分发;本项目发布的镜像从不这样构建。

### The backup → `container/`

`node:22-alpine` (Node.js: MIT) and Alpine's `p7zip` (7-Zip: LGPL-2.1-or-later, with the unRAR licence restriction on its RAR code). The same holds as above: Alpine's archive has the corresponding source, and nothing is patched.

`node:22-alpine`(Node.js:MIT)加 Alpine 的 `p7zip`(7-Zip:LGPL-2.1-or-later,其 RAR 部分另受 unRAR 许可限制)。与上面同理:Alpine 的软件仓库里有相应源码,未打任何补丁。

---

## 5. The Cloudflare platform / Cloudflare 平台

This project runs on the operator's **own** Cloudflare account. Use of Workers / D1 / R2 / Email Routing / Email Sending / Workers AI / Turnstile is governed by the agreement between the operator and Cloudflare, and falls outside the scope of this project's licence. Data flows are documented in [PRIVACY.md](PRIVACY.md).

本项目运行在部署方**自己的** Cloudflare 账号上。相关服务的使用受部署方与 Cloudflare 之间的协议约束,不属于本项目的授权范围。数据流向见 [PRIVACY.md](PRIVACY.md)。
