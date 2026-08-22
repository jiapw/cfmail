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

### CodeMirror 6 → `public/vendor/codemirror/`

```
MIT License
Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
```

Built from source rather than copied. CodeMirror 6 is published as several dozen npm packages that import one another by bare name, which no browser can resolve, so `npm run vendor` bundles them with esbuild into this directory — 37 packages in all, every one of them MIT, including the grammars (`@lezer/*`) and three small dependencies of the view (`crelt`, `style-mod`, `w3c-keyname`). Because minification discards everything that is not code, the notices are gathered back and written to `public/vendor/codemirror/LICENSE`, generated from the list of packages the bundler actually reached rather than from a list kept by hand. Split by language: opening a shell script fetches the shell grammar and not the other thirty-four. Loaded on demand, and only by the source editor (`assets/code/`). This project does not modify its code.

自源码构建,而非拷贝。CodeMirror 6 以几十个 npm 包发布,彼此用裸名互相引用,而浏览器解析不了裸名,于是 `npm run vendor` 用 esbuild 把它们打进本目录 —— 共 37 个包,每一个都是 MIT,其中包括各种文法(`@lezer/*`)与视图的三个小依赖(`crelt`、`style-mod`、`w3c-keyname`)。由于压缩会丢掉一切不是代码的东西,那些声明被重新收集,写入 `public/vendor/codemirror/LICENSE` —— 名单取自打包器实际够到的那些包,而不是一份手工维护的清单。按语言分块:打开一个 shell 脚本取回的是 shell 文法,而不是另外三十四种。按需加载,且只由源码编辑器(`assets/code/`)加载。本项目未修改其源码。

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
