#!/usr/bin/env node
// Sync the third-party libraries the browser loads directly from node_modules into public/vendor/.
//
// Why this script exists:
//   1. public/vendor/ is 600+ files of third-party copies and does not belong in git
//   2. **postal-mime must be the same version on both sides** -- the Worker imports
//      'postal-mime' (bundled from node_modules), the browser imports
//      '../vendor/postal-mime/postal-mime.js'. Once they drift, attachment part_index
//      misaligns and downloads pull the wrong part. Hand-copying cannot prevent drift;
//      generating both from one node_modules structurally can.
//
// When it runs:
//   - automatically after npm install (the postinstall hook)
//   - before npm run deploy (with --strict; a stale committed build stops the publish)
//   - by hand after upgrading dependencies: npm run vendor
//
// Everything it needs is a regular dependency, so it works the same after
// `npm install --omit=dev` -- a deploy-only checkout is a first-class citizen here.
//
// Usage: node scripts/sync-vendor.mjs [--check] [--strict]
//   --check   verify without writing; exit non-zero if anything is missing or stale (CI,
//             and the gate in front of npm run dev)
//   --strict  do the work, but exit non-zero if a committed build (libav, themes) no longer
//             matches its sources. npm run deploy uses this: publishing with a stale
//             committed build is exactly the drift this script exists to prevent. Without
//             it (the postinstall case) those are warnings, so npm install never fails over
//             something a fresh clone cannot fix mid-install.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampedFingerprint, themesFingerprint } from './themes-fingerprint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const VENDOR = path.join(ROOT, 'public', 'vendor');
const CHECK_ONLY = process.argv.includes('--check');
const STRICT = process.argv.includes('--strict');

/**
 * Each entry: what to copy from node_modules, and where it lands under vendor.
 * exts null means the whole directory; otherwise only these extensions. Web Awesome's
 * .d.ts / react / ssr are useless to the browser and would add 2MB and hundreds of
 * files to the Cloudflare static assets for nothing.
 */
const SPECS = [
  {
    name: 'Web Awesome',
    from: '@awesome.me/webawesome/dist-cdn',
    to: 'wa',
    // Only these top-level entries; everything else (types/react/ssr/skills/*.json/*.txt) is skipped.
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
    roots: null,          // the whole of src
    exts: ['.js'],        // leave the package's own package.json out
  },
  {
    // Renders PDF page 1 for Drive thumbnails (loaded on demand by assets/drive/thumb.js).
    // cmaps and standard_fonts keep CJK and non-embedded-font PDFs rendering.
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
    name: 'DOMPurify',
    from: 'dompurify',
    to: 'dompurify',
    roots: ['dist/purify.es.mjs', 'LICENSE', 'LICENSE-MPL'],
    exts: null,
  },
];

// ---------------------------------------------------------------------------
// Output. This runs inside npm install, where its lines are all a person gets to
// know what is happening to their checkout -- so every stage says what it is doing
// and why, and every failure explains itself and names the command that fixes it.
// ---------------------------------------------------------------------------

let copied = 0;
let removed = 0;
// Fatal problems: the sync itself cannot complete (a source package missing, a bundle
// that will not build). These end the run immediately in every mode.
// Flagged problems: the sync completed but something is stale or missing. Fatal under
// --check and --strict; a summarised warning otherwise, so npm install still succeeds.
const flagged = [];

function step(n, title, why) {
  console.log(`\n[${n}/4] ${title}`);
  if (why) for (const line of why.split('\n')) console.log('      ' + line);
}
const item = (s) => console.log('  ' + s);

/** A problem that ends the run: print what broke, why it matters, how to fix it -- then exit. */
function fatal(title, lines) {
  console.error(`\n✗ ${title}\n`);
  for (const l of lines) console.error('  ' + l);
  console.error('');
  process.exit(1);
}

/** A problem that fails --check/--strict but only warns after npm install. */
function flag(title, lines) {
  flagged.push({ title, lines });
  console.error('  ✗ ' + title);
  for (const l of lines) console.error('      ' + l);
}

const INSTALL_HELP = [
  'Most likely npm install has not run, was interrupted, or node_modules is stale',
  'after a package.json change. In order:',
  '  1. run: npm install        (with or without --omit=dev -- both install this)',
  '  2. still failing: delete node_modules and run npm install again',
  '  3. still failing: the checkout itself may be incomplete -- check git status',
];

// ---------------------------------------------------------------------------
// Stage 1: straight copies from node_modules
// ---------------------------------------------------------------------------

/** Recursively collect paths relative to base, filtered by extension. */
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

function readVersion(from) {
  // `from` looks like 'quill/dist' -- the package name is its first segment, or the first two when scoped.
  const parts = from.split('/');
  const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  try {
    return JSON.parse(fs.readFileSync(path.join(NM, pkg, 'package.json'), 'utf8')).version;
  } catch { return null; }
}

function copyLibraries() {
  for (const spec of SPECS) {
    const src = path.join(NM, spec.from);
    if (!fs.existsSync(src)) {
      fatal(`${spec.name} is not in node_modules (expected ${path.relative(ROOT, src)})`, [
        'This is one of the libraries the browser loads from public/vendor/, and the copy',
        'there is made from node_modules -- which does not have it.',
        '',
        ...INSTALL_HELP,
      ]);
    }
    const dst = path.join(VENDOR, spec.to);

    const rels = spec.roots
      ? spec.roots.flatMap((r) => collect(src, r, spec.exts))
      : collect(src, '', spec.exts);

    const want = new Set(rels.map((r) => r.split(path.sep).join('/')));
    let specCopied = 0;
    let specStale = 0;

    for (const rel of rels) {
      const a = path.join(src, rel);
      const b = path.join(dst, rel);
      const same = fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
      if (same) continue;
      if (CHECK_ONLY) { specStale++; continue; }
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(a, b);
      specCopied++;
    }

    // Drop leftovers vendor still holds but the source no longer ships (components removed by an upgrade).
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
    if (CHECK_ONLY && specStale) {
      flag(`${spec.name}: ${specStale} of ${rels.length} file(s) missing or stale in public/vendor/${spec.to}/`,
        ['run: npm run vendor']);
    } else {
      item(`${spec.name.padEnd(14)} ${String(rels.length).padStart(4)} files` +
        (CHECK_ONLY ? '  (up to date)' : specCopied ? `  (${specCopied} updated)` : '  (up to date)') +
        (ver ? `  v${ver}` : ''));
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 2 and 3: the two libraries that cannot be copied, only built
// ---------------------------------------------------------------------------

/** esbuild, or a full explanation of why the bundles cannot be made without it. */
async function loadEsbuild(what) {
  try {
    return await import('esbuild');
  } catch {
    fatal(`esbuild is not installed, so ${what} cannot be bundled`, [
      'esbuild is a regular dependency (deploying rebuilds these bundles too).',
      '',
      ...INSTALL_HELP,
      '',
      'If npm install succeeded and this still fails, the platform binary for this',
      'OS/architecture may be missing -- deleting node_modules and reinstalling fetches',
      'the right one.',
    ]);
  }
}

function reportBuildErrors(label, errors) {
  fatal(`bundling ${label} failed`, [
    ...errors.map((e) => e.text),
    '',
    'esbuild could not assemble the bundle from node_modules. This usually means the',
    'dependency tree is incomplete or has drifted from package-lock.json:',
    '  1. run: npm install, then try again (npm run vendor)',
    '  2. if a dependency was just upgraded, the entry file may need to catch up --',
    `     see scripts/${label === 'CodeMirror' ? 'codemirror' : 'pdfedit'}.entry.js`,
  ]);
}

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
 */
async function buildCodeMirror() {
  const entry = path.join(ROOT, 'scripts', 'codemirror.entry.js');
  const out = path.join(VENDOR, 'codemirror');
  if (CHECK_ONLY) {
    if (fs.existsSync(path.join(out, 'codemirror.entry.js'))) item('CodeMirror     bundle present');
    else flag('vendor/codemirror/ has not been built', ['run: npm run vendor']);
    return;
  }
  const esbuild = await loadEsbuild('CodeMirror');
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
  if (r.errors?.length) reportBuildErrors('CodeMirror', r.errors);
  writeBundleLicense(out, r.metafile);
  const files = collect(out, '', null);
  assertNothingLeftBare(out, files);
  const bytes = files.reduce((n2, rel) => n2 + fs.statSync(path.join(out, rel)).size, 0);
  item(`CodeMirror   ${String(files.length).padStart(4)} files  (bundled, ${Math.round(bytes / 1024)} KB)`);
}

/**
 * pdf-lib and fontkit, for editing a PDF rather than only drawing one.
 *
 * pdf-lib alone ships browser-ready ESM and would have been a copy like the others. fontkit does
 * not: its browser build opens with ten bare imports into its own dependency tree, and a browser
 * cannot follow those. So the two are bundled together from one entry, which is also where the
 * adapter between them lives -- see scripts/pdfedit.entry.js for why fontkit 2 rather than the
 * fork pdf-lib expects.
 *
 * Flat rather than split: there is one entry and everything in it is reached the moment the
 * editor opens, so chunking would buy an extra request and no laziness.
 *
 * pdf-lib 与 fontkit —— 用来编辑一份 PDF,而不只是画一份出来。
 *
 * 单独的 pdf-lib 本身就发浏览器可用的 ESM,本可以像其他库一样直接拷。fontkit 不行:
 * 它的浏览器构建开头就是十个指向自身依赖树的裸导入,而浏览器跟不过去。
 * 所以两者从同一个入口一起打包,而两者之间的适配器也住在那里 ——
 * 为什么用 fontkit 2 而不是 pdf-lib 期待的那个分支,见 scripts/pdfedit.entry.js。
 *
 * 打平而不拆分:只有一个入口,里面的东西在编辑器打开的那一刻全都要用上,
 * 拆块只会多换来一次请求,换不来任何惰性。
 */
async function buildPdfEdit() {
  const entry = path.join(ROOT, 'scripts', 'pdfedit.entry.js');
  const out = path.join(VENDOR, 'pdfedit');
  if (CHECK_ONLY) {
    if (fs.existsSync(path.join(out, 'pdfedit.entry.js'))) item('pdf edit       bundle present');
    else flag('vendor/pdfedit/ has not been built', ['run: npm run vendor']);
    return;
  }
  const esbuild = await loadEsbuild('the PDF editor');
  fs.rmSync(out, { recursive: true, force: true });
  const r = await esbuild.build({
    entryPoints: [entry],
    outdir: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    sourcemap: false,
    target: ['es2022'],
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
    plugins: [{
      // fontkit reaches for brotli only to open WOFF2, which nothing here produces or consumes.
      // Dropping it takes a dependency out of the bundle and a licence question with it.
      // fontkit 找 brotli 只为打开 WOFF2,而这里既不产生也不消费这种东西。
      // 去掉它,既从包里拿走一个依赖,也带走了一个许可证问题。
      name: 'no-woff2',
      setup(build) {
        const stub = path.join(ROOT, 'scripts', 'pdfedit.nowoff2.js');
        build.onResolve({ filter: /^brotli(\/|$)/ }, () => ({ path: stub }));
      },
    }],
  });
  if (r.errors?.length) reportBuildErrors('pdfedit', r.errors);
  writeBundleLicense(out, r.metafile);
  const files = collect(out, '', null);
  assertNothingLeftBare(out, files, 'pdfedit');
  const bytes = files.reduce((n2, rel) => n2 + fs.statSync(path.join(out, rel)).size, 0);
  item(`pdf edit     ${String(files.length).padStart(4)} files  (bundled, ${Math.round(bytes / 1024)} KB)`);
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
 */
function assertNothingLeftBare(out, files, label = 'CodeMirror') {
  const bare = [];
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const s = fs.readFileSync(path.join(out, rel), 'utf8');
    for (const m of s.matchAll(/["'`](@[a-z0-9-]+\/[a-z0-9.-]+|crelt|style-mod|w3c-keyname)[^"'`]*["'`]/g)) {
      bare.push(`${rel}: ${m[0]}`);
    }
    if (/import\(\s*[^)'"`]/.test(s)) bare.push(`${rel}: a computed import(), which no bundler can follow`);
  }
  if (bare.length) {
    fatal(`the ${label} bundle still has module references a browser cannot resolve`, [
      ...[...new Set(bare)].slice(0, 10),
      '',
      'This is the bundle checking itself: a bare package name in the output would load',
      'fine today and fail in a browser the first time that code path runs. It usually',
      'appears after upgrading or adding a dependency whose imports the bundler could not',
      `follow. Fix scripts/${label === 'pdfedit' ? 'pdfedit' : 'codemirror'}.entry.js (imports must be literal, never computed)`,
      'and run npm run vendor again. Nothing was published.',
    ]);
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
 */
function writeBundleLicense(out, metafile) {
  const pkgs = new Set();
  for (const input of Object.keys(metafile?.inputs || {})) {
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) pkgs.add(m[1]);
  }
  const parts = [
    'The bundles in this directory are built from the packages below. Each notice is reproduced as its licence requires.',
    '',
  ];
  for (const name of [...pkgs].sort()) {
    const dir = path.join(ROOT, 'node_modules', ...name.split('/'));
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { /* no version to report */ }
    let text = '';
    for (const f of ['LICENSE', 'LICENSE.md', 'LICENCE', 'license']) {
      try { text = fs.readFileSync(path.join(dir, f), 'utf8').trim(); break; } catch { /* try the next name */ }
    }
    // A few small packages declare a licence and ship no text for it. The notice cannot then be
    // reproduced, because upstream never wrote one down -- and inventing a copyright line to fill
    // the gap would be worse than the gap. What can be recorded truthfully is recorded: what the
    // package says its licence is, which version went in, and where it came from.
    // 有几个小包声明了许可证却不发正文。那份声明无法被复述,
    // 因为上游从未写下过 —— 而编一行版权声明来填这个缺口,比缺口本身更糟。
    // 能如实记下的就如实记下:包自称的许可证、进去的是哪个版本、以及它从哪里来。
    if (!text) {
      let declared = '';
      let repo = '';
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        declared = typeof pj.license === 'string' ? pj.license : '';
        repo = typeof pj.repository === 'string' ? pj.repository : (pj.repository?.url || '');
      } catch { /* nothing further to say about it */ }
      if (!declared) {
        fatal(`${name} states no licence at all and cannot be shipped`, [
          'Every bundled package must carry a notice; this one declares nothing and ships no',
          'text, so the bundle cannot lawfully include it. Remove it from the entry file or',
          'take it up with upstream.',
        ]);
      }
      text = `${declared}

The author ships no licence text with this package; this records what it`
        + ` declares.${repo ? `
Source: ${repo.replace(/^git\+|\.git$/g, '')}` : ''}`;
    }
    parts.push('='.repeat(76), `${name}${version ? ' ' + version : ''}`, '', text, '');
  }
  fs.writeFileSync(path.join(out, 'LICENSE'), parts.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Stage 4: the committed builds -- verified here, never made here
// ---------------------------------------------------------------------------

/**
 * The one build that is not copied from anywhere, checked rather than made.
 *
 * It is committed, so a fresh clone already has it and nobody needs Docker to install or deploy
 * this project. What this does is notice the two ways it can be wrong: absent, or present but built
 * before somebody changed which codecs go into it. The second is the one worth catching -- a binary
 * that no longer matches the list beside it fails months later, as a file that will not play, for a
 * reason that is nowhere in the code.
 *
 * Whether it is required is not stated here; it is asked of the application. While nothing imports
 * it, a missing build is worth mentioning and not worth stopping for. The moment something does,
 * the same absence becomes a broken deployment, and this says so.
 */
function checkLibavFull() {
  const dir = path.join(VENDOR, 'libav-full');
  const script = path.join(ROOT, 'scripts', 'build-libav.sh');
  let want;
  try {
    const s = fs.readFileSync(script, 'utf8');
    const version = /VERSION="\$\{LIBAV_VERSION:-([\d.]+)\}"/.exec(s)[1];
    const frags = JSON.parse(/FRAGMENTS='(\[[\s\S]*?\])'/.exec(s)[1]);
    want = {
      version,
      fingerprint: crypto.createHash('sha256')
        .update(version + '\n' + [...frags].sort().join(',')).digest('hex').slice(0, 16),
    };
  } catch {
    flag('could not read the build settings out of scripts/build-libav.sh', [
      'The committed libav build is verified against the VERSION and FRAGMENTS in that',
      'script; if they cannot be parsed the check cannot run. The script may have been',
      'edited into a shape this parser does not recognise -- see checkLibavFull() here.',
    ]);
    return;
  }

  // Asked of the application, not decided here.
  const used = (() => {
    const hits = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'vendor') continue;
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.js') && fs.readFileSync(path.join(d, e.name), 'utf8').includes('libav-full')) {
          hits.push(e.name);
        }
      }
    })(path.join(ROOT, 'public', 'assets'));
    return hits;
  })();

  let have = null;
  try { have = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8')); } catch { /* never built */ }

  const DOCKER_NOTE = [
    'This is the one vendor build that cannot be made from node_modules: upstream does not',
    'publish these codecs, so it is built once with Docker and committed to git. A normal',
    'clone already has it and never rebuilds it.',
    '',
    'To (re)build and commit:  npm run libav',
    '(needs Docker; on Windows, Docker inside WSL works)',
  ];

  if (!have) {
    if (used.length) {
      flag(`libav-full has never been built here, and ${used.join(', ')} depend on it`, [
        'Without it, opening those media files fails in the browser.',
        '',
        'A fresh clone has this build committed -- if it is missing, the checkout may be',
        'incomplete (check git status) or someone removed public/vendor/libav-full/.',
        '',
        ...DOCKER_NOTE,
      ]);
    } else {
      item('libav-full     not built (nothing uses it yet -- fine; npm run libav when something does)');
    }
    return;
  }
  if (have.fingerprint !== want.fingerprint) {
    flag('libav-full no longer matches scripts/build-libav.sh', [
      `committed build: v${have.version} fp=${have.fingerprint}`,
      `script says:     v${want.version} fp=${want.fingerprint}`,
      '',
      'The codec list or version in build-libav.sh changed after the committed binary was',
      'built. Deployed as-is, the mismatch surfaces months later as a media file that will',
      'not play, for a reason that is nowhere in the code.',
      '',
      ...DOCKER_NOTE,
    ]);
    return;
  }
  const files = collect(dir, '', null).filter((f) => f !== 'build.json');
  const bytes = files.reduce((n2, rel) => n2 + fs.statSync(path.join(dir, rel)).size, 0);
  item(`libav-full   ${String(files.length).padStart(4)} files  (committed build, ${Math.round(bytes / 1024)} KB)  v${have.version}  matches build-libav.sh`);
}

/**
 * The committed themes, held to the same standard as the committed libav build.
 *
 * public/assets/themes.css (and themes-meta.js, and src/themes-list.ts) are generated by
 * build-themes.mjs from @radix-ui/colors, and committed. Nothing at install or deploy time
 * rebuilds them -- which is correct, and also exactly how an upgraded palette or an edited
 * theme list could drift from the committed output with nothing noticing. So themes.css
 * carries a fingerprint of its inputs, and this recomputes it.
 *
 * @radix-ui/colors is a devDependency. When it is not installed (npm install --omit=dev),
 * the committed output is the only truth there is, and using it as-is is correct -- so the
 * check is skipped, and says so rather than failing a deploy-only checkout.
 *
 * 入库的主题产物,与入库的 libav 构建同一个标准对待。
 * @radix-ui/colors 是 devDependency:没装它(--omit=dev)时,入库产物就是唯一的真相,
 * 照用即对 —— 所以跳过校验并说明,而不是让一个纯部署 checkout 挂掉。
 */
function checkThemes() {
  const want = themesFingerprint(ROOT);
  if (!want) {
    item('themes         check skipped: @radix-ui/colors not installed (deploy-only install;');
    item('               the committed themes.css is used as-is, which is correct)');
    return;
  }

  const siblings = ['public/assets/themes-meta.js', 'src/themes-list.ts']
    .filter((p) => !fs.existsSync(path.join(ROOT, p)));
  const have = stampedFingerprint(ROOT);

  const REGEN = [
    'Regenerate and commit all three outputs together:',
    '  node scripts/build-themes.mjs',
    '(public/assets/themes.css, public/assets/themes-meta.js, src/themes-list.ts)',
  ];

  if (!have || siblings.length) {
    flag(!have
      ? 'public/assets/themes.css is missing or carries no source fingerprint'
      : `generated theme file(s) missing: ${siblings.join(', ')}`, [
      'The theme CSS, the picker metadata and the backend name list are generated from',
      '@radix-ui/colors by scripts/build-themes.mjs and committed; the deployed UI reads',
      'them as-is. An output that is absent -- or predates the fingerprint check -- cannot',
      'be verified against its sources.',
      '',
      ...REGEN,
    ]);
    return;
  }
  if (have.hash !== want.hash) {
    flag('the committed themes no longer match their sources', [
      `committed themes.css: @radix-ui/colors@${have.version} fp=${have.hash}`,
      `sources here:         @radix-ui/colors@${want.version} fp=${want.hash}`,
      '',
      'Either @radix-ui/colors was upgraded or scripts/build-themes.mjs was edited after',
      'themes.css was last generated. Deployed as-is, the UI silently keeps the old',
      'colours and theme list.',
      '',
      ...REGEN,
    ]);
    return;
  }
  const count = (fs.readFileSync(path.join(ROOT, 'public', 'assets', 'themes.css'), 'utf8')
    .match(/html\[data-theme='/g) || []).length / 2;
  item(`themes       ${String(count).padStart(4)} themes  (committed build)  @radix-ui/colors@${want.version}  matches build-themes.mjs`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`=== CFMail vendor sync${CHECK_ONLY ? ' (check only -- nothing is written)' : ''} ===`);
console.log('public/vendor/ is the third-party code the browser loads directly. It is not in');
console.log('git; this derives it from node_modules so the two can never drift apart.');

step(1, CHECK_ONLY ? 'Check the copied browser libraries' : 'Copy browser libraries into public/vendor/',
  'Finished ES modules, used by the browser exactly as published.');
copyLibraries();

step(2, CHECK_ONLY ? 'Check the CodeMirror bundle' : 'Bundle CodeMirror (the code editor)',
  'Published as ~30 packages importing each other by bare name, which a browser cannot\nresolve -- esbuild assembles them into loadable chunks, one per language.');
await buildCodeMirror();

step(3, CHECK_ONLY ? 'Check the PDF editor bundle' : 'Bundle the PDF editor (pdf-lib + fontkit)',
  'fontkit ships with bare imports into its own dependency tree, so both come through\nthe bundler together.');
await buildPdfEdit();

step(4, 'Verify the committed builds',
  'These live in git and are never rebuilt here -- this only proves they still match\nthe sources they were built from.');
checkLibavFull();
checkThemes();

if (flagged.length && (CHECK_ONLY || STRICT)) {
  console.error(`\n✗ ${flagged.length} problem(s) -- each is explained above with the command that fixes it.`);
  if (STRICT && !CHECK_ONLY) console.error('  (--strict: deploying would publish the stale build, so stopping here instead)');
  process.exit(1);
}
if (flagged.length) {
  console.error(`\n⚠ vendor synced, but ${flagged.length} check(s) failed above. npm install is not blocked`);
  console.error('  by this; npm run dev and npm run deploy will refuse until it is fixed.');
  process.exit(0);
}
console.log(CHECK_ONLY
  ? '\n✓ public/vendor/ matches node_modules, and the committed builds match their sources'
  : `\n✓ vendor in sync${copied ? `: ${copied} file(s) updated` : ' (nothing changed)'}${removed ? `, ${removed} leftover(s) removed` : ''}`);
