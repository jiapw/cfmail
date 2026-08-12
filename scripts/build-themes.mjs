// Generate 30 themes (light/dark pairs) from @radix-ui/colors, plus the Web Awesome token bridge.
// Outputs:
//   public/assets/themes.css     - every theme variable
//   public/assets/themes-meta.js - the theme list (swatches) the frontend picker uses
//   src/themes-list.ts           - the theme names the backend validates against
// Usage: node scripts/build-themes.mjs
// 从 @radix-ui/colors 生成 30 套主题(明暗成对)+ Web Awesome token 桥接
// 产物:
//   public/assets/themes.css   — 全部主题变量
//   public/assets/themes-meta.js — 前端选择器用的主题清单(色板)
//   src/themes-list.ts         — 后端校验用的主题名列表
// 用法:node scripts/build-themes.mjs

import fs from 'node:fs';
import * as radix from '@radix-ui/colors';

// 25 colour themes (each paired with a neutral grey) + 5 monochrome ones (Notion-like, dark grey primary).
// bright = light-leaning hues whose solid step 9 needs dark text on top.
// 25 套彩色(配对中性灰) + 5 套单色(Notion 风,主按钮用深灰)
// bright = 亮色系,实色(step 9)上需要深色文字
const ACCENTS = [
  ['tomato', 'mauve'], ['red', 'mauve'], ['ruby', 'mauve'], ['crimson', 'mauve'],
  ['pink', 'mauve'], ['plum', 'mauve'], ['purple', 'mauve'], ['violet', 'mauve'],
  ['iris', 'slate'], ['indigo', 'slate'], ['blue', 'slate'], ['sky', 'slate', true], ['cyan', 'slate'],
  ['mint', 'sage', true], ['teal', 'sage'], ['jade', 'sage'], ['green', 'sage'],
  ['grass', 'olive'], ['lime', 'olive', true],
  ['yellow', 'sand', true], ['amber', 'sand', true], ['orange', 'sand'], ['brown', 'sand'], ['gold', 'sand'], ['bronze', 'sand'],
];
const MONOS = ['gray', 'mauve', 'slate', 'sage', 'sand'];

const scale = (name, dark) => {
  const obj = radix[name + (dark ? 'Dark' : '')];
  if (!obj) throw new Error('missing radix scale: ' + name + (dark ? 'Dark' : ''));
  const out = [];
  for (let i = 1; i <= 12; i++) out.push(obj[name + i]);
  return out;
};

function vars(prefix, arr) {
  return arr.map((v, i) => `  --x-${prefix}${i + 1}: ${v};`).join('\n');
}

function themeBlock(name, accentArr, grayArr, solidFg, mono) {
  const a = [...accentArr];
  if (mono) {
    a[8] = accentArr[11]; // 实色 → 深灰(step 12)
    a[9] = accentArr[10];
  }
  return `${vars('a', a)}\n${vars('g', grayArr)}\n  --x-solid-fg: ${solidFg};`;
}

let css = `/* 本文件由 scripts/build-themes.mjs 生成,勿手改 */\n\n`;

// Static bridge: application semantic tokens + Web Awesome tokens. Both modes share one reference and
// the raw values swap with the mode. [data-webawesome] raises specificity above WA's own .wa-light/.wa-dark rules for --wa-color-*.
// —— 静态桥接:应用语义 token + Web Awesome token(明暗共用同一引用,原始值随模式切换)
// 选择器带 [data-webawesome] 提高特异性,压过 WA 主题里 .wa-light/.wa-dark 对 --wa-color-* 的赋值 ——
css += `html[data-webawesome] {
  --bg: var(--x-a2);
  --panel: #ffffff;
  --panel-2: #ffffff;
  --text: var(--x-g12);
  --text-2: var(--x-g11);
  --text-3: var(--x-g10);
  --border: var(--x-g6);
  --border-2: var(--x-g7);
  --hover: var(--x-g3);
  --hover-2: var(--x-g4);
  --active: var(--x-g5);
  --tint: var(--x-a2);
  --accent-soft: var(--x-a3);
  --selected: var(--x-a4);
  --selected-2: var(--x-a5);
  --primary: var(--x-a9);
  --primary-2: var(--x-a10);
  --primary-fg: var(--x-solid-fg);
  --link: var(--x-a11);
  --accent-text: var(--x-a11);
  --star: #f4b400;

  --wa-color-brand-fill-quiet: var(--x-a3);
  --wa-color-brand-fill-normal: var(--x-a4);
  --wa-color-brand-fill-loud: var(--x-a9);
  --wa-color-brand-border-quiet: var(--x-a6);
  --wa-color-brand-border-normal: var(--x-a7);
  --wa-color-brand-border-loud: var(--x-a8);
  --wa-color-brand-on-quiet: var(--x-a11);
  --wa-color-brand-on-normal: var(--x-a11);
  --wa-color-brand-on-loud: var(--x-solid-fg);
  --wa-color-brand: var(--x-a9);
  --wa-color-brand-on: var(--x-solid-fg);

  --wa-color-neutral-fill-quiet: var(--x-g3);
  --wa-color-neutral-fill-normal: var(--x-g4);
  --wa-color-neutral-fill-loud: var(--x-g12);
  --wa-color-neutral-border-quiet: var(--x-g6);
  --wa-color-neutral-border-normal: var(--x-g7);
  --wa-color-neutral-border-loud: var(--x-g8);
  --wa-color-neutral-on-quiet: var(--x-g11);
  --wa-color-neutral-on-normal: var(--x-g12);
  --wa-color-neutral-on-loud: var(--x-g1);

  --wa-color-surface-default: var(--panel);
  --wa-color-surface-raised: var(--panel-2);
  --wa-color-surface-lowered: var(--bg);
  --wa-color-surface-border: var(--x-g6);
  --wa-color-text-normal: var(--x-g12);
  --wa-color-text-quiet: var(--x-g11);
  --wa-color-text-link: var(--x-a11);
  --wa-color-focus: var(--x-a8);
}
html[data-webawesome].wa-dark {
  --bg: var(--x-g1);
  --panel: var(--x-g2);
  --panel-2: var(--x-g3);
}
`;

const meta = [];
const names = [];

function emit(name, accentName, grayName, bright, mono) {
  const aL = scale(accentName, false);
  const aD = scale(accentName, true);
  const gL = scale(grayName, false);
  const gD = scale(grayName, true);
  // On light-leaning solids use dark text: the paired grey's light step 12, the same ink in both modes.
  // 亮色系实色上用深色文字(取配对灰的 light step 12,两种模式都用深墨色)
  const fgL = mono ? gL[0] : bright ? gL[11] : '#ffffff';
  const fgD = mono ? gD[0] : bright ? gL[11] : '#ffffff';
  css += `\nhtml[data-theme='${name}'] {\n${themeBlock(name, aL, gL, fgL, mono)}\n}\n`;
  css += `html[data-theme='${name}'].wa-dark {\n${themeBlock(name, aD, gD, fgD, mono)}\n}\n`;
  names.push(name);
  meta.push({ name, solid: mono ? aL[11] : aL[8], solidDark: mono ? aD[11] : aD[8], mono: !!mono });
}

for (const [accent, gray, bright] of ACCENTS) emit(accent, accent, gray, bright, false);
for (const g of MONOS) emit('mono-' + g, g, g, false, true);

fs.writeFileSync('public/assets/themes.css', css);
fs.writeFileSync(
  'public/assets/themes-meta.js',
  `// 由 scripts/build-themes.mjs 生成,勿手改\nexport const THEMES = ${JSON.stringify(meta, null, 2)};\n`
);
fs.writeFileSync(
  'src/themes-list.ts',
  `// 由 scripts/build-themes.mjs 生成,勿手改\nexport const THEME_NAMES = ${JSON.stringify(names)};\n`
);
console.log(`generated ${names.length} themes:`, names.join(', '));
