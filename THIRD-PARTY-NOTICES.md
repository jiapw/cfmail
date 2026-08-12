# Third-party notices / 第三方组件许可声明

CFMail itself is MIT licensed (see [LICENSE](LICENSE)). This file lists the third-party components distributed with, or pulled in at build time by, this project, along with their licence requirements.

CFMail 本体以 MIT 授权(见 [LICENSE](LICENSE))。本文件列出随本项目分发或在构建时引入的第三方组件及其许可要求。

All components are permissively licensed (MIT / MIT-0 / BSD-3-Clause / Apache-2.0). **No copyleft, no commercially licensed components.**

全部组件均为宽松许可,不含 copyleft,不含商业授权组件。

---

## 1. Components loaded directly by the browser / 浏览器直接加载的组件

These live under `public/vendor/` at runtime and are served to end users, so **their copyright notices must be preserved**. They are **not** committed to this repository — `scripts/sync-vendor.mjs` copies them from `node_modules` (see [README](README.md#local-development--本地开发)).

这些组件在运行时位于 `public/vendor/`,会随部署发给终端用户,**它们的版权声明必须保留**。它们**不在本仓库里** —— 由 `scripts/sync-vendor.mjs` 从 `node_modules` 拷贝。

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

## 4. The Cloudflare platform / Cloudflare 平台

This project runs on the operator's **own** Cloudflare account. Use of Workers / D1 / R2 / Email Routing / Email Sending / Workers AI / Turnstile is governed by the agreement between the operator and Cloudflare, and falls outside the scope of this project's licence. Data flows are documented in [PRIVACY.md](PRIVACY.md).

本项目运行在部署方**自己的** Cloudflare 账号上。相关服务的使用受部署方与 Cloudflare 之间的协议约束,不属于本项目的授权范围。数据流向见 [PRIVACY.md](PRIVACY.md)。
