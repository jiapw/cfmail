#!/usr/bin/env node
// Sync the third-party libraries the browser loads directly from node_modules into public/vendor/.
// 把浏览器直接加载的第三方库从 node_modules 同步到 public/vendor/。
//
// Why this script exists:
//   1. public/vendor/ is 600+ files of third-party copies and does not belong in git
//   2. **postal-mime must be the same version on both sides** -- the Worker imports
//      'postal-mime' (bundled from node_modules), the browser imports
//      '../vendor/postal-mime/postal-mime.js'. Once they drift, attachment part_index
//      misaligns and downloads pull the wrong part. Hand-copying cannot prevent drift;
//      generating both from one node_modules structurally can.
// 为什么要有这个脚本:
//   1. public/vendor/ 是 600 多个文件的第三方拷贝,不该进 git
//   2. **postal-mime 必须两端同版本** —— Worker 侧 import 'postal-mime'(wrangler 打包
//      node_modules 里的),浏览器侧 import '../vendor/postal-mime/postal-mime.js'。
//      两边版本一旦漂移,附件的 part_index 就会错位,下载附件时定位到错误的部件。
//      手工拷贝挡不住漂移,由本脚本从同一份 node_modules 生成才能结构性保证一致。
//
// When it runs:
//   - automatically after npm install (the postinstall hook)
//   - before npm run deploy (idempotent; does nothing when nothing changed)
//   - by hand after upgrading dependencies: npm run vendor
// 什么时候跑:
//   - npm install 之后自动跑(package.json 的 postinstall)
//   - npm run deploy 会先跑一遍(幂等,没变化就什么都不做)
//   - 升级依赖后手动跑:npm run vendor
//
// Usage: node scripts/sync-vendor.mjs [--check]
//   --check verifies without writing, exiting non-zero if anything is missing (for CI)
// 用法:node scripts/sync-vendor.mjs [--check]
//   --check 只校验不写入,缺文件就非零退出(CI 用)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const VENDOR = path.join(ROOT, 'public', 'vendor');
const CHECK_ONLY = process.argv.includes('--check');

/**
 * Each entry: what to copy from node_modules, and where it lands under vendor.
 * exts null means the whole directory; otherwise only these extensions. Web Awesome's
 * .d.ts / react / ssr are useless to the browser and would add 2MB and hundreds of
 * files to the Cloudflare static assets for nothing.
 * 每一项:从 node_modules 的哪里拷到 vendor 的哪里。
 * include 为 null 表示整目录;否则只拷这些扩展名(Web Awesome 的 .d.ts / react / ssr
 * 浏览器用不到,拷进去白白多传 2MB 和几百个文件到 CF 静态资产)。
 */
const SPECS = [
  {
    name: 'Web Awesome',
    from: '@awesome.me/webawesome/dist-cdn',
    to: 'wa',
    // Only these top-level entries; everything else (types/react/ssr/skills/*.json/*.txt) is skipped.
    // 只要这些顶层条目,其余(types/react/ssr/skills/*.json/*.txt)一律不拷
    roots: ['chunks', 'components', 'events', 'internal', 'styles', 'translations', 'utilities',
            'webawesome.js', 'webawesome.loader.js', 'webawesome.ssr-loader.js'],
    exts: ['.js', '.css'],
  },
  {
    name: 'Quill',
    from: 'quill/dist',
    to: 'quill',
    roots: ['quill.js', 'quill.snow.css'],
    exts: null,
  },
  {
    name: 'postal-mime',
    from: 'postal-mime/src',
    to: 'postal-mime',
    roots: null,          // 整个 src
    exts: ['.js'],        // 排除包自带的 package.json
  },
  {
    // Renders PDF page 1 for Drive thumbnails (loaded on demand by assets/drive/thumb.js).
    // cmaps and standard_fonts keep CJK and non-embedded-font PDFs rendering.
    // 网盘缩略图渲染 PDF 首页用(assets/drive/thumb.js 按需加载)。
    // cmaps 与 standard_fonts 保证中日韩及未内嵌字体的 PDF 也能渲出来。
    name: 'pdf.js',
    from: 'pdfjs-dist',
    to: 'pdfjs',
    roots: ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'cmaps', 'standard_fonts', 'LICENSE'],
    exts: null,
  },
  {
    // Markdown for the editor (assets/md/), which promises GitHub's semantics rather than a
    // reasonable approximation of them. GitHub's dialect is a specification with a test suite,
    // and the interesting parts of it are the edge cases -- how far a nested list may be
    // indented before it stops being nested, where a table's alignment row is allowed to be
    // ragged, when an underscore inside a word is emphasis and when it is a word. Guessing at
    // those is how a renderer comes to disagree with the site it claims to match.
    // 编辑器(assets/md/)的 Markdown。它承诺的是 GitHub 的语义,而不是对它的合理近似。
    // GitHub 的方言是一份带测试套件的规范,而其中有意思的部分恰恰是边角 ——
    // 嵌套列表缩进到第几格就不再算嵌套、表格的对齐行可以参差到什么程度、
    // 词中间的下划线什么时候是强调什么时候只是个词。靠猜这些,正是一个渲染器
    // 与它声称要对齐的那个站点渐行渐远的方式。
    name: 'marked',
    from: 'marked/lib',
    to: 'marked',
    roots: ['marked.esm.js'],
    exts: null,
  },
  {
    // Footnotes, which marked leaves out of its core and GitHub does not. Without this a document
    // that uses them shows its machinery -- a literal [^1] where a number belongs, and the notes
    // themselves stranded at the bottom as an ordinary paragraph.
    // 脚注。marked 的核心里没有它,而 GitHub 有。缺了这个,用脚注的文档会把自己的机械外露 ——
    // 该出现数字的地方是一个字面的 [^1],而那些注释本身孤零零地留在末尾,成了普通段落。
    name: 'marked-footnote',
    from: 'marked-footnote/dist',
    to: 'marked-footnote',
    roots: ['index.js'],
    exts: null,
  },
  {
    // GitHub's dialect passes inline HTML through, so something has to decide what may pass.
    // That decision is a security boundary -- a document is written by whoever hands you one --
    // and it is the kind of boundary where a hand-written blocklist is wrong on the day it
    // matters. Only the ESM build ships; the UMD and CJS copies would be dead weight.
    // GitHub 的方言允许内联 HTML 通过,于是总得有谁来决定什么可以通过。
    // 这个决定是一道安全边界 —— 文档的作者,就是把文档递给你的那个人 ——
    // 而这类边界上,手写的黑名单会在最要紧的那天出错。
    // 只发 ESM 构建;UMD 与 CJS 那两份是纯粹的负重。
    name: 'DOMPurify',
    from: 'dompurify',
    to: 'dompurify',
    roots: ['dist/purify.es.mjs', 'LICENSE', 'LICENSE-MPL'],
    exts: null,
  },
];

/**
 * The one library that cannot be copied, only built.
 *
 * Everything else in SPECS ships as a finished ES module. CodeMirror is several dozen packages
 * importing one another by bare name, so a browser handed those files resolves nothing. Bundling
 * is therefore not an optimisation here -- it is what turns the package into something that can
 * be loaded at all.
 *
 * Split rather than bundled flat, because the entry reaches its languages through dynamic import:
 * esbuild gives each of them a chunk, and opening a shell script fetches the shell grammar and
 * not the other thirty.
 *
 * 唯一一个拷不过去、只能构建的库。
 *
 * SPECS 里其余每一项都是发布好的 ES 模块。CodeMirror 是几十个彼此用裸名互相引用的包,
 * 把那些文件直接交给浏览器,它一个也解析不出来。所以在这里,打包不是优化 ——
 * 它是把这个包变成根本能被加载的东西的那一步。
 *
 * 用拆分而不是打成一坨,因为入口是用动态 import 去够它的那些语言的:
 * esbuild 会给每种语言一块自己的 chunk,于是打开一个 shell 脚本时取回的是 shell 文法,
 * 而不是另外三十种。
 */
async function buildCodeMirror() {
  const entry = path.join(ROOT, 'scripts', 'codemirror.entry.js');
  const out = path.join(VENDOR, 'codemirror');
  if (CHECK_ONLY) {
    if (!fs.existsSync(path.join(out, 'codemirror.entry.js'))) {
      missing++;
      console.error('  缺失:vendor/codemirror/(跑 npm run vendor 生成)');
    }
    return;
  }
  const esbuild = await import('esbuild');
  fs.rmSync(out, { recursive: true, force: true });
  const r = await esbuild.build({
    entryPoints: [entry],
    outdir: out,
    bundle: true,
    format: 'esm',
    splitting: true,
    minify: true,
    sourcemap: false,
    target: ['es2022'],
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
  });
  if (r.errors?.length) {
    console.error('✗ CodeMirror 打包失败');
    for (const e of r.errors) console.error('  ' + e.text);
    process.exit(1);
  }
  writeBundleLicense(out, r.metafile);
  const files = collect(out, '', null);
  assertNothingLeftBare(out, files);
  const bytes = files.reduce((n2, rel) => n2 + fs.statSync(path.join(out, rel)).size, 0);
  console.log(`  CodeMirror  ${String(files.length).padStart(3)} 文件  (已打包 ${Math.round(bytes / 1024)} KB)`);
}

/**
 * The bundle must not still be asking for anything by npm name.
 *
 * A bundler resolves the imports it can read. Handed a computed one -- `import(base + name)` -- it
 * cannot read it, so it writes the expression out untouched and reports success. The result loads
 * fine and then fails the first time somebody opens a file of that kind, with an error about a
 * bare specifier, weeks later, in a browser.
 *
 * So the output is read back. Nothing in this directory should name a package, because naming one
 * is precisely what the browser cannot do -- and that is a property of finished files, which is
 * something a build can check about itself.
 *
 * 打出来的包里,不该还有任何东西在用 npm 包名要东西。
 *
 * 打包器解析的是它读得懂的 import。给它一个拼出来的 —— `import(base + name)` ——
 * 它读不懂,于是原样把表达式写出去,并报成功。产物能正常加载,
 * 然后在某人第一次打开那类文件时失败,报一个关于裸模块名的错 —— 几周之后,在浏览器里。
 *
 * 所以把产物读回来看。这个目录下不该有任何东西点名一个包,因为点名恰恰是浏览器做不到的事 ——
 * 而这是成品文件的一条性质,是一次构建可以拿来检查自己的东西。
 */
function assertNothingLeftBare(out, files) {
  const bare = [];
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const s = fs.readFileSync(path.join(out, rel), 'utf8');
    for (const m of s.matchAll(/["'`](@[a-z0-9-]+\/[a-z0-9.-]+|crelt|style-mod|w3c-keyname)[^"'`]*["'`]/g)) {
      bare.push(`${rel}: ${m[0]}`);
    }
    if (/import\(\s*[^)'"`]/.test(s)) bare.push(`${rel}: 计算出来的 import(),打包器跟不进去`);
  }
  if (bare.length) {
    console.error('✗ CodeMirror 产物里仍有解析不了的模块引用:');
    for (const b of [...new Set(bare)].slice(0, 10)) console.error('  ' + b);
    process.exit(1);
  }
}

/**
 * The notice the bundle would otherwise not carry.
 *
 * Every package that goes into it is MIT, and MIT asks that its notice travel with the copy. A
 * copied file brings its own; a bundle brings none, because minification is the act of throwing
 * away everything that is not code. So the notices are gathered back and written beside the
 * chunks.
 *
 * The list comes from the metafile rather than from package.json, because package.json says what
 * may be reached and the metafile says what was actually reached. A grammar dropped from the entry
 * would otherwise go on being credited here forever, and one added would never be.
 *
 * 这个包本来不会带上的那份声明。
 *
 * 打进去的每一个包都是 MIT,而 MIT 要求它的声明随副本一起走。拷过去的文件自己带着声明;
 * 打出来的包一份也不带,因为压缩这件事本身,就是把一切不是代码的东西丢掉。
 * 于是把那些声明重新收集起来,写在 chunk 旁边。
 *
 * 名单取自 metafile 而不是 package.json,因为 package.json 说的是"可以够到什么",
 * 而 metafile 说的是"实际够到了什么"。否则,一种从入口里删掉的文法会在这儿被永远地继续鸣谢,
 * 而一种新加的则永远不会。
 */
function writeBundleLicense(out, metafile) {
  const pkgs = new Set();
  for (const input of Object.keys(metafile?.inputs || {})) {
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) pkgs.add(m[1]);
  }
  const parts = [
    'CodeMirror 6 与 Lezer,自源码打包 / bundled from source',
    '',
    'The bundle in this directory is built from the packages listed below. Each is reproduced',
    'with its own notice, as its licence requires.',
    '本目录下的包由下列各包构建而成。每一份声明按其许可要求原样附上。',
    '',
  ];
  for (const name of [...pkgs].sort()) {
    const dir = path.join(ROOT, 'node_modules', ...name.split('/'));
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { /* 无版本可报 */ }
    let text = '';
    for (const f of ['LICENSE', 'LICENSE.md', 'LICENCE', 'license']) {
      try { text = fs.readFileSync(path.join(dir, f), 'utf8').trim(); break; } catch { /* 换下一个名字 */ }
    }
    if (!text) {
      console.error(`✗ ${name} 没有可随包分发的许可文本`);
      process.exit(1);
    }
    parts.push('='.repeat(76), `${name}${version ? ' ' + version : ''}`, '', text, '');
  }
  fs.writeFileSync(path.join(out, 'LICENSE'), parts.join('\n') + '\n');
}

let copied = 0;
let missing = 0;
let removed = 0;

/** Recursively collect paths relative to base, filtered by extension.
 *  递归收集相对路径(相对 base),按扩展名过滤 */
function collect(base, rel = '', exts, out = []) {
  const abs = path.join(base, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return out; }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs)) collect(base, path.join(rel, e), exts, out);
  } else if (!exts || exts.includes(path.extname(rel))) {
    out.push(rel);
  }
  return out;
}

for (const spec of SPECS) {
  const src = path.join(NM, spec.from);
  const dst = path.join(VENDOR, spec.to);
  if (!fs.existsSync(src)) {
    console.error(`✗ 找不到 ${spec.name} 的源目录:${path.relative(ROOT, src)}`);
    console.error('  先跑 npm install');
    process.exit(1);
  }

  const rels = spec.roots
    ? spec.roots.flatMap((r) => collect(src, r, spec.exts))
    : collect(src, '', spec.exts);

  const want = new Set(rels.map((r) => r.split(path.sep).join('/')));
  let specCopied = 0;

  for (const rel of rels) {
    const a = path.join(src, rel);
    const b = path.join(dst, rel);
    const same = fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
    if (same) continue;
    if (CHECK_ONLY) { missing++; console.error(`  缺失或过期:vendor/${spec.to}/${rel}`); continue; }
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.copyFileSync(a, b);
    specCopied++;
  }

  // Drop leftovers vendor still holds but the source no longer ships (components removed by an upgrade).
  // 清掉 vendor 里源已不再提供的残留(升级后删掉的组件不该留在部署产物里)
  if (!CHECK_ONLY && fs.existsSync(dst)) {
    for (const rel of collect(dst, '', null)) {
      if (!want.has(rel.split(path.sep).join('/'))) {
        fs.rmSync(path.join(dst, rel));
        removed++;
      }
    }
  }

  copied += specCopied;
  const ver = readVersion(spec.from);
  console.log(`  ${spec.name.padEnd(12)} ${String(rels.length).padStart(4)} 文件` +
    (CHECK_ONLY ? '' : specCopied ? `  (更新 ${specCopied})` : '  (已是最新)') +
    (ver ? `  v${ver}` : ''));
}

function readVersion(from) {
  // `from` looks like 'quill/dist' -- the package name is its first segment, or the first two when scoped.
  // from 形如 'quill/dist' → 包名是第一段(带 scope 时是前两段)
  const parts = from.split('/');
  const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  try {
    return JSON.parse(fs.readFileSync(path.join(NM, pkg, 'package.json'), 'utf8')).version;
  } catch { return null; }
}

await buildCodeMirror();

if (CHECK_ONLY) {
  if (missing) {
    console.error(`\n✗ public/vendor/ 有 ${missing} 个文件缺失或过期,跑 npm run vendor 修复`);
    process.exit(1);
  }
  console.log('\n✓ public/vendor/ 与 node_modules 一致');
} else {
  console.log(`\n✓ vendor 同步完成${copied ? `,更新 ${copied} 个文件` : '(无变化)'}${removed ? `,清理 ${removed} 个残留` : ''}`);
}
