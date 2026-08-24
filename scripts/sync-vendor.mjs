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
//   - before npm run deploy (idempotent; does nothing when nothing changed)
//   - by hand after upgrading dependencies: npm run vendor
//
// Usage: node scripts/sync-vendor.mjs [--check]
//   --check verifies without writing, exiting non-zero if anything is missing (for CI)

import crypto from 'node:crypto';
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
 *
 *
 */
async function buildCodeMirror() {
  const entry = path.join(ROOT, 'scripts', 'codemirror.entry.js');
  const out = path.join(VENDOR, 'codemirror');
  if (CHECK_ONLY) {
    if (!fs.existsSync(path.join(out, 'codemirror.entry.js'))) {
      missing++;
      console.error('  missing: vendor/codemirror/ (run npm run vendor to build it)');
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
    console.error('✗ bundling CodeMirror failed');
    for (const e of r.errors) console.error('  ' + e.text);
    process.exit(1);
  }
  writeBundleLicense(out, r.metafile);
  const files = collect(out, '', null);
  assertNothingLeftBare(out, files);
  const bytes = files.reduce((n2, rel) => n2 + fs.statSync(path.join(out, rel)).size, 0);
  console.log(`  CodeMirror  ${String(files.length).padStart(3)} files  (bundled, ${Math.round(bytes / 1024)} KB)`);
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
 *
 *
 */
function assertNothingLeftBare(out, files) {
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
    console.error('✗ the CodeMirror bundle still has module references that cannot be resolved:');
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
 *
 *
 */
function writeBundleLicense(out, metafile) {
  const pkgs = new Set();
  for (const input of Object.keys(metafile?.inputs || {})) {
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) pkgs.add(m[1]);
  }
  const parts = [
    'CodeMirror 6 and Lezer, bundled from source',
    '',
    'The bundle in this directory is built from the packages listed below. Each is reproduced',
    'with its own notice, as its licence requires.',
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
    if (!text) {
      console.error(`✗ ${name} has no licence text that can be shipped with it`);
      process.exit(1);
    }
    parts.push('='.repeat(76), `${name}${version ? ' ' + version : ''}`, '', text, '');
  }
  fs.writeFileSync(path.join(out, 'LICENSE'), parts.join('\n') + '\n');
}

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
 *
 *
 *
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
    console.error('  ✗ could not read the build settings out of scripts/build-libav.sh');
    missing++;
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

  const say = used.length
    ? (m) => { console.error('  ✗ ' + m); missing++; needsLibav = true; }
    : (m) => console.log('  · ' + m);
  if (!have) {
    say(`libav-full is not built${used.length ? ` (${used.join(', ')} need it)` : ' (nothing uses it yet)'}: run npm run libav`);
    return;
  }
  if (have.fingerprint !== want.fingerprint) {
    say(`libav-full does not match build-libav.sh (${have.version}/${have.fingerprint} != ${want.version}/${want.fingerprint}): run npm run libav to rebuild`);
    return;
  }
  const files = collect(dir, '', null).filter((f) => f !== 'build.json');
  const bytes = files.reduce((n2, rel) => n2 + fs.statSync(path.join(dir, rel)).size, 0);
  console.log(`  libav-full  ${String(files.length).padStart(3)} files  (built here, ${Math.round(bytes / 1024)} KB)  v${have.version}`);
}

let copied = 0;
// Set when what is missing is the build npm cannot supply, because the fix for that one is a
// different command and sending somebody to the wrong one wastes the trip.
let needsLibav = false;
let missing = 0;
let removed = 0;

/** Recursively collect paths relative to base, filtered by extension.
  */
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
    console.error(`✗ no source directory for ${spec.name}: ${path.relative(ROOT, src)}`);
    console.error('  run npm install first');
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
    if (CHECK_ONLY) { missing++; console.error(`  missing or stale: vendor/${spec.to}/${rel}`); continue; }
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
  console.log(`  ${spec.name.padEnd(12)} ${String(rels.length).padStart(4)} files` +
    (CHECK_ONLY ? '' : specCopied ? `  (${specCopied} updated)` : '  (up to date)') +
    (ver ? `  v${ver}` : ''));
}

function readVersion(from) {
  // `from` looks like 'quill/dist' -- the package name is its first segment, or the first two when scoped.
  const parts = from.split('/');
  const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  try {
    return JSON.parse(fs.readFileSync(path.join(NM, pkg, 'package.json'), 'utf8')).version;
  } catch { return null; }
}

await buildCodeMirror();
checkLibavFull();

if (CHECK_ONLY) {
  if (missing) {
    // Naming the command that can actually fix it. `npm run vendor` copies from node_modules and
    // cannot produce the one build that is not there, so sending somebody to it for that is
    // sending them to run something that will report the same problem again.
    const how = needsLibav
      ? (missing > 1 ? 'run npm run vendor and npm run libav to fix it' : 'run npm run libav to fix it')
      : 'run npm run vendor to fix it';
    console.error(`\n✗ public/vendor/ has ${missing} file(s) missing or stale. ${how}`);
    process.exit(1);
  }
  console.log('\n✓ public/vendor/ matches node_modules');
} else {
  console.log(`\n✓ vendor in sync${copied ? `, ${copied} file(s) updated` : ' (nothing changed)'}${removed ? `, ${removed} leftover(s) removed` : ''}`);
}
