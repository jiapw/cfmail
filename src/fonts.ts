import { Hono } from 'hono';
import type { Env } from './types';

/**
 * Self-hosting for Google Fonts:
 *  1. /api/fonts/css/:family  fetches Google's CSS, rewrites the gstatic URLs to point at us, and caches it in D1
 *  2. /api/fonts/f/:ref       on first hit downloads the font file from origin into R2, and serves it from R2 afterwards
 * Only families in the catalogue are allowed, the gstatic hostname is hardcoded, and arbitrary external URLs are refused.
 * Google Fonts 自托管:
 *  1. /api/fonts/css/:family  取 Google 的 CSS,把 gstatic 地址改写成本站地址后缓存(D1)
 *  2. /api/fonts/f/:ref       首次访问时回源下载该字体文件并存入 R2,之后直接从 R2 提供
 * 只允许目录里的字体族,gstatic 主机名硬编码,不接受任意外部地址。
 */

// Curated font catalogue, all from Google Fonts. Entries marked cjk cover Chinese/Japanese/Korean.
// 精选字体目录(全部来自 Google Fonts)。cjk 标记的支持中日韩。
export interface FontDef { name: string; cat: 'sans' | 'serif' | 'mono' | 'display' | 'script'; cjk?: boolean }

export const FONT_CATALOG: FontDef[] = [
  // Sans-serif
  // 无衬线
  { name: 'Inter', cat: 'sans' },
  { name: 'Roboto', cat: 'sans' },
  { name: 'Open Sans', cat: 'sans' },
  { name: 'Lato', cat: 'sans' },
  { name: 'Montserrat', cat: 'sans' },
  { name: 'Poppins', cat: 'sans' },
  { name: 'Source Sans 3', cat: 'sans' },
  { name: 'Nunito', cat: 'sans' },
  { name: 'Nunito Sans', cat: 'sans' },
  { name: 'Work Sans', cat: 'sans' },
  { name: 'Rubik', cat: 'sans' },
  { name: 'Karla', cat: 'sans' },
  { name: 'Manrope', cat: 'sans' },
  { name: 'DM Sans', cat: 'sans' },
  { name: 'Public Sans', cat: 'sans' },
  { name: 'Figtree', cat: 'sans' },
  { name: 'Plus Jakarta Sans', cat: 'sans' },
  { name: 'Outfit', cat: 'sans' },
  { name: 'Barlow', cat: 'sans' },
  { name: 'Mulish', cat: 'sans' },
  { name: 'Raleway', cat: 'sans' },
  { name: 'Quicksand', cat: 'sans' },
  { name: 'Cabin', cat: 'sans' },
  { name: 'Asap', cat: 'sans' },
  { name: 'Heebo', cat: 'sans' },
  { name: 'Overpass', cat: 'sans' },
  { name: 'Archivo', cat: 'sans' },
  { name: 'Assistant', cat: 'sans' },
  { name: 'Jost', cat: 'sans' },
  { name: 'Lexend', cat: 'sans' },
  { name: 'Onest', cat: 'sans' },
  { name: 'Geist', cat: 'sans' },
  // Serif
  // 衬线
  { name: 'Merriweather', cat: 'serif' },
  { name: 'Playfair Display', cat: 'serif' },
  { name: 'Lora', cat: 'serif' },
  { name: 'PT Serif', cat: 'serif' },
  { name: 'Source Serif 4', cat: 'serif' },
  { name: 'Libre Baskerville', cat: 'serif' },
  { name: 'Crimson Text', cat: 'serif' },
  { name: 'EB Garamond', cat: 'serif' },
  { name: 'Bitter', cat: 'serif' },
  { name: 'Cardo', cat: 'serif' },
  { name: 'Spectral', cat: 'serif' },
  { name: 'Zilla Slab', cat: 'serif' },
  { name: 'Newsreader', cat: 'serif' },
  { name: 'Fraunces', cat: 'serif' },
  { name: 'Literata', cat: 'serif' },
  // Monospace
  // 等宽
  { name: 'JetBrains Mono', cat: 'mono' },
  { name: 'Fira Code', cat: 'mono' },
  { name: 'Source Code Pro', cat: 'mono' },
  { name: 'IBM Plex Mono', cat: 'mono' },
  { name: 'Roboto Mono', cat: 'mono' },
  { name: 'Space Mono', cat: 'mono' },
  { name: 'Inconsolata', cat: 'mono' },
  { name: 'DM Mono', cat: 'mono' },
  // Display / headline (good for brand names)
  // 展示/标题(适合品牌名)
  { name: 'Bebas Neue', cat: 'display' },
  { name: 'Oswald', cat: 'display' },
  { name: 'Righteous', cat: 'display' },
  { name: 'Comfortaa', cat: 'display' },
  { name: 'Josefin Sans', cat: 'display' },
  { name: 'Orbitron', cat: 'display' },
  { name: 'Exo 2', cat: 'display' },
  { name: 'Audiowide', cat: 'display' },
  { name: 'Sora', cat: 'display' },
  { name: 'Chakra Petch', cat: 'display' },
  // Script / handwriting
  // 花体 / 手写体
  { name: 'Dancing Script', cat: 'script' },
  { name: 'Great Vibes', cat: 'script' },
  { name: 'Pacifico', cat: 'script' },
  { name: 'Satisfy', cat: 'script' },
  { name: 'Caveat', cat: 'script' },
  { name: 'Sacramento', cat: 'script' },
  { name: 'Parisienne', cat: 'script' },
  { name: 'Allura', cat: 'script' },
  { name: 'Alex Brush', cat: 'script' },
  { name: 'Tangerine', cat: 'script' },
  { name: 'Cookie', cat: 'script' },
  { name: 'Yellowtail', cat: 'script' },
  { name: 'Courgette', cat: 'script' },
  { name: 'Lobster', cat: 'script' },
  { name: 'Lobster Two', cat: 'script' },
  { name: 'Kaushan Script', cat: 'script' },
  { name: 'Italianno', cat: 'script' },
  { name: 'Pinyon Script', cat: 'script' },
  { name: 'Petit Formal Script', cat: 'script' },
  { name: 'Mrs Saint Delafield', cat: 'script' },
  { name: 'Herr Von Muellerhoff', cat: 'script' },
  { name: 'Monsieur La Doulaise', cat: 'script' },
  { name: 'Mr De Haviland', cat: 'script' },
  { name: 'Style Script', cat: 'script' },
  { name: 'League Script', cat: 'script' },
  { name: 'Norican', cat: 'script' },
  { name: 'Marck Script', cat: 'script' },
  { name: 'Bad Script', cat: 'script' },
  { name: 'Charm', cat: 'script' },
  { name: 'Charmonman', cat: 'script' },
  { name: 'Grand Hotel', cat: 'script' },
  { name: 'Berkshire Swash', cat: 'script' },
  { name: 'Rouge Script', cat: 'script' },
  { name: 'Yesteryear', cat: 'script' },
  { name: 'Niconne', cat: 'script' },
  { name: 'Damion', cat: 'script' },
  { name: 'Meddon', cat: 'script' },
  { name: 'Qwigley', cat: 'script' },
  { name: 'Updock', cat: 'script' },
  { name: 'Send Flowers', cat: 'script' },
  { name: 'Birthstone', cat: 'script' },
  { name: 'Moon Dance', cat: 'script' },
  { name: 'Beau Rivage', cat: 'script' },
  { name: 'Passions Conflict', cat: 'script' },
  { name: 'Water Brush', cat: 'script' },
  { name: 'Ephesis', cat: 'script' },
  // Handwriting / notepad style
  // 手写 / 便签风
  { name: 'Shadows Into Light', cat: 'script' },
  { name: 'Indie Flower', cat: 'script' },
  { name: 'Kalam', cat: 'script' },
  { name: 'Handlee', cat: 'script' },
  { name: 'Patrick Hand', cat: 'script' },
  { name: 'Architects Daughter', cat: 'script' },
  { name: 'Gloria Hallelujah', cat: 'script' },
  { name: 'Permanent Marker', cat: 'script' },
  { name: 'Rock Salt', cat: 'script' },
  { name: 'Homemade Apple', cat: 'script' },
  { name: 'Amatic SC', cat: 'script' },
  { name: 'Nothing You Could Do', cat: 'script' },
  { name: 'Just Another Hand', cat: 'script' },
  { name: 'Reenie Beanie', cat: 'script' },
  { name: 'Covered By Your Grace', cat: 'script' },
  { name: 'Caveat Brush', cat: 'script' },
  // CJK handwriting / brush
  // 中日韩 手写 / 毛笔
  { name: 'Liu Jian Mao Cao', cat: 'script', cjk: true },
  { name: 'Zhi Mang Xing', cat: 'script', cjk: true },
  { name: 'Yuji Syuku', cat: 'script', cjk: true },
  { name: 'Yuji Boku', cat: 'script', cjk: true },
  { name: 'Yuji Mai', cat: 'script', cjk: true },
  { name: 'Hachi Maru Pop', cat: 'script', cjk: true },
  { name: 'Yomogi', cat: 'script', cjk: true },
  { name: 'Klee One', cat: 'script', cjk: true },
  { name: 'Nanum Pen Script', cat: 'script', cjk: true },
  { name: 'Nanum Brush Script', cat: 'script', cjk: true },
  { name: 'Gaegu', cat: 'script', cjk: true },
  { name: 'Gamja Flower', cat: 'script', cjk: true },
  // CJK
  // 中日韩
  { name: 'Noto Sans SC', cat: 'sans', cjk: true },
  { name: 'Noto Sans TC', cat: 'sans', cjk: true },
  { name: 'Noto Sans JP', cat: 'sans', cjk: true },
  { name: 'Noto Sans KR', cat: 'sans', cjk: true },
  { name: 'Noto Serif SC', cat: 'serif', cjk: true },
  { name: 'Noto Serif TC', cat: 'serif', cjk: true },
  { name: 'Noto Serif JP', cat: 'serif', cjk: true },
  { name: 'Noto Serif KR', cat: 'serif', cjk: true },
  { name: 'Ma Shan Zheng', cat: 'display', cjk: true },
  { name: 'ZCOOL XiaoWei', cat: 'display', cjk: true },
  { name: 'ZCOOL QingKe HuangYou', cat: 'display', cjk: true },
  { name: 'Long Cang', cat: 'display', cjk: true },
  { name: 'LXGW WenKai TC', cat: 'serif', cjk: true },
  { name: 'Zen Maru Gothic', cat: 'sans', cjk: true },
  { name: 'M PLUS Rounded 1c', cat: 'sans', cjk: true },
  { name: 'Kosugi Maru', cat: 'sans', cjk: true },
  { name: 'ZCOOL KuaiLe', cat: 'display', cjk: true },
  { name: 'Shippori Mincho', cat: 'serif', cjk: true },
  { name: 'Kaisei Decol', cat: 'display', cjk: true },
  { name: 'Dela Gothic One', cat: 'display', cjk: true },
  { name: 'RocknRoll One', cat: 'sans', cjk: true },
  { name: 'Jua', cat: 'display', cjk: true },
  { name: 'Do Hyeon', cat: 'display', cjk: true },
  { name: 'Black Han Sans', cat: 'display', cjk: true },
  { name: 'Song Myung', cat: 'serif', cjk: true },
  { name: 'Gowun Dodum', cat: 'sans', cjk: true },
];

const BY_NAME = new Map(FONT_CATALOG.map((f) => [f.name, f]));
export const isKnownFont = (name: string) => BY_NAME.has(name);

/** Whether a font is one of the fixed-width ones.
 *  Asked before a font is accepted as the code font: a proportional face in a source file does
 *  not merely look wrong, it breaks the one thing source code uses columns for.
 *  某个字体是不是等宽的那一类。
 *  在一个字体被接受为代码字体之前问这一句:源码文件里的比例字体不只是不好看,
 *  它破坏的是源码使用列对齐所要的那唯一一件事。 */
export const isMonoFont = (name: string) => BY_NAME.get(name)?.cat === 'mono';

const UA_MODERN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const b64urlEncode = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) =>
  atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const fontsApp = new Hono<{ Bindings: Env }>();

fontsApp.get('/catalog', (c) => c.json({ fonts: FONT_CATALOG }));

/** CSS for a font family: fetched from Google and rewritten on first use, served from the D1 cache afterwards
 *  字体族的 CSS:首次从 Google 拉取并改写,之后走 D1 缓存 */
fontsApp.get('/css/:family', async (c) => {
  const family = decodeURIComponent(c.req.param('family'));
  if (!isKnownFont(family)) return c.text('/* unknown font */', 404, { 'Content-Type': 'text/css' });

  const cacheKey = `fontcss:${family}`;
  const cached = await c.env.DB.prepare('SELECT value FROM meta WHERE key=?1').bind(cacheKey).first<any>();
  if (cached?.value) {
    return c.body(cached.value, 200, { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=604800' });
  }

  const url =
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}` +
    `:wght@400;500;700&display=swap`;
  const res = await fetch(url, { headers: { 'User-Agent': UA_MODERN } });
  if (!res.ok) return c.text('/* upstream error */', 502, { 'Content-Type': 'text/css' });
  const raw = await res.text();

  // Rewrite every gstatic URL to our own on-demand origin path
  // 把所有 gstatic 地址改写成本站按需回源地址
  const rewritten = raw.replace(/https:\/\/fonts\.gstatic\.com\/([^)"']+)/g, (_m, path: string) => {
    return `/api/fonts/f/${b64urlEncode(path)}`;
  });

  await c.env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2')
    .bind(cacheKey, rewritten)
    .run();
  return c.body(rewritten, 200, { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=604800' });
});

/** Font file: served straight from R2 when present, otherwise downloaded from gstatic and stored (self-hosted)
 *  字体文件:R2 里有就直接给,没有则回源 gstatic 下载后存起来(自托管) */
fontsApp.get('/f/:ref', async (c) => {
  let path: string;
  try {
    path = b64urlDecode(c.req.param('ref'));
  } catch {
    return c.text('bad ref', 400);
  }
  // Accept only gstatic-shaped paths, so nothing can make us fetch an arbitrary URL
  // 只接受 gstatic 的路径形态,杜绝任意地址回源
  if (!/^[A-Za-z0-9/._-]+$/.test(path) || path.includes('..')) return c.text('bad ref', 400);

  const key = `fonts/${await sha256Hex(path)}`;
  const hit = await c.env.RAW.get(key);
  const type = path.endsWith('.woff2')
    ? 'font/woff2'
    : path.endsWith('.woff')
      ? 'font/woff'
      : path.endsWith('.ttf')
        ? 'font/ttf'
        : 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' };
  if (hit) return c.body(hit.body as any, 200, headers);

  const res = await fetch(`https://fonts.gstatic.com/${path}`, { headers: { 'User-Agent': UA_MODERN } });
  if (!res.ok) return c.text('upstream error', 502);
  const buf = await res.arrayBuffer();
  await c.env.RAW.put(key, buf, { httpMetadata: { contentType: type } });
  return c.body(buf, 200, headers);
});
