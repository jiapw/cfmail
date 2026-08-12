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
];

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

if (CHECK_ONLY) {
  if (missing) {
    console.error(`\n✗ public/vendor/ 有 ${missing} 个文件缺失或过期,跑 npm run vendor 修复`);
    process.exit(1);
  }
  console.log('\n✓ public/vendor/ 与 node_modules 一致');
} else {
  console.log(`\n✓ vendor 同步完成${copied ? `,更新 ${copied} 个文件` : '(无变化)'}${removed ? `,清理 ${removed} 个残留` : ''}`);
}
