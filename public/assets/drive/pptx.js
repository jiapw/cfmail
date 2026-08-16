// The pptx engine, split out on its own: theme colours, geometry, fills, the shape-tree
// walker and layout/master inheritance. Loaded on demand only when a pptx file is actually
// previewed or thumbnailed -- txt previews should not pay for any of this.
// pptx 引擎单独成文件。主题色、几何、填充、形状树遍历与版式/母版继承。
// 仅在真正预览或生成 pptx 缩略图时按需加载 —— 预览个 txt 不该为这些付费。
import { openZip, zipPart, zipText } from './rzip.js';
import { ext } from './doc.js';

// No single part of a deck should be this big; a picture that is has stopped being a slide.
// 一套幻灯片的任何单个部件都不该这么大;真有那么大的图片,它已经不是一页幻灯片了。
const PART_CAP = 64 * 1024 * 1024;

const NS = (root, local) => [...root.getElementsByTagNameNS('*', local)];

const EMU = 914400; // EMUs per inch / 每英寸的 EMU 数

const childNS = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const firstChildNS = (el, name) => childNS(el, name)[0] || null;

/** Resolve a relationship target ('../media/x.png') against the part that declared it
 *  把关系目标(如 '../media/x.png')解析到声明它的部件所在目录 */
function relPath(fromPart, target) {
  const parts = fromPart.split('/').slice(0, -1).concat(String(target || '').split('/'));
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

// Decodable-in-browser media only; EMF/WMF/TIFF have no browser decoder and stay out
// 只收浏览器解得开的媒体。EMF/WMF/TIFF 浏览器没有解码器,继续排除
const PPTX_IMG_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', jpe: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
};

// -- colour machinery / 颜色机制 --

const hexRgb = (hex) => {
  const h = String(hex || '808080').replace('#', '');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
};

/** Luminance-space adjustment via HSL, used by lumMod/lumOff (the theme's lighter/darker variants)
 *  经 HSL 做亮度域调整。lumMod/lumOff 就是主题色的加深减淡 */
function adjustLum(r, g, b, fn) {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  let l = (mx + mn) / 2;
  const d = mx - mn;
  let hDeg = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const rr = r / 255;
    const gg = g / 255;
    const bb = b / 255;
    if (mx === rr) hDeg = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
    else if (mx === gg) hDeg = ((bb - rr) / d + 2) / 6;
    else hDeg = ((rr - gg) / d + 4) / 6;
  }
  l = Math.min(1, Math.max(0, fn(l)));
  const hue2rgb = (p, q, t2) => {
    let t = t2;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, hDeg + 1 / 3) * 255, hue2rgb(p, q, hDeg) * 255, hue2rgb(p, q, hDeg - 1 / 3) * 255];
}

const CLRMAP_FALLBACK = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };

function resolveScheme(name, theme) {
  const mapped = theme.clrMap[name] || CLRMAP_FALLBACK[name] || name;
  return theme.colors[mapped] || theme.colors[name] || null;
}

/** One CSS colour out of a container holding srgbClr/schemeClr/sysClr plus its transform children
 *  从含 srgbClr/schemeClr/sysClr 的容器解析出一个 CSS 颜色。连同其变换子元素 */
function colorFrom(el, theme) {
  if (!el) return null;
  let node = null;
  let hex = null;
  for (const c of el.children) {
    const ln = c.localName;
    if (ln === 'srgbClr') { hex = c.getAttribute('val'); node = c; break; }
    if (ln === 'schemeClr') { hex = resolveScheme(c.getAttribute('val'), theme); node = c; break; }
    if (ln === 'sysClr') { hex = c.getAttribute('lastClr') || 'FFFFFF'; node = c; break; }
    if (ln === 'prstClr') { hex = { black: '000000', white: 'FFFFFF', gray: '808080', red: 'FF0000' }[c.getAttribute('val')] || '808080'; node = c; break; }
  }
  if (!hex) return null;
  let [r, g, b] = hexRgb(hex);
  let a = 1;
  for (const t of node.children) {
    const v = parseInt(t.getAttribute('val') || '0', 10) / 100000;
    switch (t.localName) {
      case 'alpha': a = v; break;
      case 'shade': r *= v; g *= v; b *= v; break;
      case 'tint': r = 255 - (255 - r) * v; g = 255 - (255 - g) * v; b = 255 - (255 - b) * v; break;
      case 'lumMod': [r, g, b] = adjustLum(r, g, b, (l) => l * v); break;
      case 'lumOff': [r, g, b] = adjustLum(r, g, b, (l) => l + v); break;
      default: break;
    }
  }
  r = Math.round(Math.min(255, Math.max(0, r)));
  g = Math.round(Math.min(255, Math.max(0, g)));
  b = Math.round(Math.min(255, Math.max(0, b)));
  return a < 0.999 ? `rgba(${r},${g},${b},${a.toFixed(3)})` : `rgb(${r},${g},${b})`;
}

function srcRectOf(fillEl) {
  const sr = NS(fillEl, 'srcRect')[0];
  if (!sr) return null;
  const f = (n) => (parseInt(sr.getAttribute(n) || '0', 10) || 0) / 100000;
  const rect = { l: f('l'), t: f('t'), r: f('r'), b: f('b') };
  return rect.l || rect.t || rect.r || rect.b ? rect : null;
}

/** custGeom path list to an SVG path scaled by its declared coordinate space
 *  把 custGeom 的路径表转成 SVG path。按其声明的坐标空间缩放 */
function custGeomPath(spPr) {
  const cg = firstChildNS(spPr, 'custGeom');
  const pl = cg && firstChildNS(cg, 'pathLst');
  if (!pl) return null;
  let d = '';
  let W = 0;
  let H = 0;
  let maxX = 1;
  let maxY = 1;
  for (const p of childNS(pl, 'path')) {
    W = Math.max(W, parseInt(p.getAttribute('w') || '0', 10));
    H = Math.max(H, parseInt(p.getAttribute('h') || '0', 10));
    for (const cmd of p.children) {
      const pts = NS(cmd, 'pt').map((pt) => {
        const x = parseInt(pt.getAttribute('x') || '0', 10);
        const y = parseInt(pt.getAttribute('y') || '0', 10);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        return `${x} ${y}`;
      });
      switch (cmd.localName) {
        case 'moveTo': d += `M${pts[0]}`; break;
        case 'lnTo': d += `L${pts[0]}`; break;
        case 'cubicBezTo': d += `C${pts.join(' ')}`; break;
        case 'quadBezTo': d += `Q${pts.join(' ')}`; break;
        case 'close': d += 'Z'; break;
        default: break; // arcTo omitted; the shape closes without that arc / 省略 arcTo。少一段弧但形状仍闭合
      }
    }
  }
  if (!d) return null;
  return { d, w: W || maxX, h: H || maxY };
}

/** Fill of an spPr/bgPr: solid, gradient, picture or explicit none. null = nothing declared.
 *  spPr/bgPr 的填充。实色、渐变、图片或显式无填充。null 表示什么都没声明。 */
function fillOf(prEl, theme, media) {
  for (const c of prEl?.children || []) {
    switch (c.localName) {
      case 'noFill': return { type: 'none' };
      case 'solidFill': {
        const css = colorFrom(c, theme);
        return css ? { type: 'solid', css } : { type: 'none' };
      }
      case 'gradFill': {
        const stops = [];
        for (const gs of NS(c, 'gs')) {
          stops.push({ pos: (parseInt(gs.getAttribute('pos') || '0', 10) || 0) / 1000, css: colorFrom(gs, theme) || '#fff' });
        }
        if (!stops.length) return { type: 'none' };
        stops.sort((x, y) => x.pos - y.pos);
        const lin = firstChildNS(c, 'lin');
        const deg = lin ? Math.round(90 + parseInt(lin.getAttribute('ang') || '0', 10) / 60000) : 180;
        return { type: 'grad', css: `linear-gradient(${deg}deg, ${stops.map((s) => `${s.css} ${s.pos.toFixed(1)}%`).join(', ')})` };
      }
      case 'blipFill': {
        const m = media(c);
        return m ? { type: 'img', ...m, srcRect: srcRectOf(c) } : { type: 'none' };
      }
      default: break;
    }
  }
  return null;
}

/** Outline of a shape. null = not declared, type none = explicitly none.
 *  形状描边。null 表示没声明。type none 表示显式无描边。 */
function lineOf(spPr, theme) {
  const ln = spPr && firstChildNS(spPr, 'ln');
  if (!ln) return null;
  if (firstChildNS(ln, 'noFill')) return { type: 'none' };
  const css = colorFrom(firstChildNS(ln, 'solidFill'), theme);
  if (!css) return null;
  const w = (parseInt(ln.getAttribute('w') || '9525', 10) || 9525) / 12700; // pt
  const dashEl = firstChildNS(ln, 'prstDash');
  return { css, w, dash: /dash|dot/i.test(dashEl?.getAttribute('val') || '') ? 'dashed' : 'solid' };
}

/** Theme style references on the shape. Used only where spPr stays silent.
 *  形状上的主题样式引用。仅在 spPr 没写时兜底。 */
function styleColors(spEl, theme) {
  const st = firstChildNS(spEl, 'style');
  if (!st) return {};
  const pick = (name) => {
    const ref = firstChildNS(st, name);
    if (!ref || parseInt(ref.getAttribute('idx') || '0', 10) === 0) return null;
    return colorFrom(ref, theme);
  };
  return { fill: pick('fillRef'), line: pick('lnRef'), font: colorFrom(firstChildNS(st, 'fontRef'), theme) };
}

/**
 * Open a deck. The shared parts -- presentation, master, theme -- are read now; a slide and the
 * pictures on it wait until someone looks at that slide.
 *
 * A deck's size is almost entirely its media, and the media of slide forty is of no interest to
 * a reader who has seen three. Parsing all of them up front was what made a 105 MB deck take
 * the best part of a minute to show its title page.
 *
 * 打开一套幻灯片。共享部件 —— presentation、母版、主题 —— 现在就读;
 * 某一页及其上的图片,要等有人看那一页时才读。
 *
 * 一套幻灯片的体积几乎全是媒体,而第四十页的媒体对一个只看了三页的读者毫无意义。
 * 一开始就把它们全解析一遍,正是 105 MB 的样本要花将近一分钟才显示出标题页的原因。
 *
 * @returns {Promise<{w: number, h: number, count: number, cover: Blob|null,
 *                    slide(i: number): Promise<object>}|null>}
 */
export async function pptxOpen(source) {
  try {
    const zip = await openZip(source);
    let w = 12192000 / EMU;
    let h = 6858000 / EMU;
    const xmlCache = new Map();
    const loadXml = async (path) => {
      if (!xmlCache.has(path)) {
        const t = await zipText(zip, path, PART_CAP);
        xmlCache.set(path, t ? new DOMParser().parseFromString(t, 'application/xml') : null);
      }
      return xmlCache.get(path);
    };
    // A media reference is a promise of bytes, not the bytes: the renderer calls it when the
    // picture is about to be shown, and a slide never scrolled to never costs its pictures.
    // 媒体引用是"字节的承诺"而非字节本身:渲染器在图片即将显示时才调用它,
    // 一页从未被滚动到,它上面的图片就一分钱不花。
    const mediaOf = (target, mime) => {
      const e = zip.stat(target);
      return e && !e.isDir && mime ? { read: () => zipPart(zip, target, PART_CAP), mime } : null;
    };
    const relsOf = async (path) => {
      const doc2 = await loadXml(path.replace(/([^/]+)$/, '_rels/$1.rels'));
      const m = new Map();
      if (doc2) {
        for (const r of NS(doc2, 'Relationship')) {
          m.set(r.getAttribute('Id'), {
            target: relPath(path, r.getAttribute('Target')),
            type: r.getAttribute('Type') || '',
          });
        }
      }
      return m;
    };
    const px = await loadXml('ppt/presentation.xml');
    const szEl = px && NS(px, 'sldSz')[0];
    if (szEl) {
      w = parseInt(szEl.getAttribute('cx'), 10) / EMU || w;
      h = parseInt(szEl.getAttribute('cy'), 10) / EMU || h;
    }

    // Theme: colour scheme and fonts come from the master's theme part; the master also carries
    // the colour map (bg1 to lt1 and friends).
    // 主题。配色与字体在母版关联的 theme 部件里。母版上还有 bg1 映射 lt1 那张颜色映射表。
    const presRels = await relsOf('ppt/presentation.xml');
    const masterRel = [...presRels.values()].find((r) => r.type.endsWith('/slideMaster'));
    const masterPath = masterRel ? masterRel.target : 'ppt/slideMasters/slideMaster1.xml';
    const masterXml = await loadXml(masterPath);
    const theme = { colors: {}, clrMap: {}, fonts: { mjLt: '', mjEa: '', mnLt: '', mnEa: '' } };
    const cm = masterXml && NS(masterXml, 'clrMap')[0];
    if (cm) for (const a of cm.attributes) theme.clrMap[a.name] = a.value;
    const mRels = await relsOf(masterPath);
    const themeRel = [...mRels.values()].find((r) => r.type.endsWith('/theme'));
    const themeXml = await loadXml(themeRel ? themeRel.target : 'ppt/theme/theme1.xml');
    const scheme = themeXml && NS(themeXml, 'clrScheme')[0];
    if (scheme) {
      for (const c of scheme.children) {
        const v = firstChildNS(c, 'srgbClr')?.getAttribute('val')
          || firstChildNS(c, 'sysClr')?.getAttribute('lastClr');
        if (v) theme.colors[c.localName] = v;
      }
    }
    const fsch = themeXml && NS(themeXml, 'fontScheme')[0];
    if (fsch) {
      const mj = firstChildNS(fsch, 'majorFont');
      const mn = firstChildNS(fsch, 'minorFont');
      theme.fonts = {
        mjLt: firstChildNS(mj, 'latin')?.getAttribute('typeface') || '',
        mjEa: firstChildNS(mj, 'ea')?.getAttribute('typeface') || '',
        mnLt: firstChildNS(mn, 'latin')?.getAttribute('typeface') || '',
        mnEa: firstChildNS(mn, 'ea')?.getAttribute('typeface') || '',
      };
    }
    const themeFont = (name) => {
      if (!name) return '';
      if (name === '+mj-lt') return theme.fonts.mjLt;
      if (name === '+mj-ea') return theme.fonts.mjEa || theme.fonts.mjLt;
      if (name === '+mn-lt') return theme.fonts.mnLt;
      if (name === '+mn-ea') return theme.fonts.mnEa || theme.fonts.mnLt;
      return name;
    };

    const xfrmOf = (el) => {
      const pr = firstChildNS(el, 'spPr') || firstChildNS(el, 'grpSpPr') || el;
      const xf = firstChildNS(pr, 'xfrm') || (el.localName === 'graphicFrame' ? firstChildNS(el, 'xfrm') : null);
      if (!xf) return null;
      const off = firstChildNS(xf, 'off');
      const extEl = firstChildNS(xf, 'ext');
      if (!off || !extEl) return null;
      return {
        x: parseInt(off.getAttribute('x'), 10) / EMU, y: parseInt(off.getAttribute('y'), 10) / EMU,
        w: parseInt(extEl.getAttribute('cx'), 10) / EMU, h: parseInt(extEl.getAttribute('cy'), 10) / EMU,
        rot: (parseInt(xf.getAttribute('rot') || '0', 10) || 0) / 60000,
        flipH: xf.getAttribute('flipH') === '1', flipV: xf.getAttribute('flipV') === '1',
        chOff: firstChildNS(xf, 'chOff'), chExt: firstChildNS(xf, 'chExt'),
      };
    };
    const applyXf = (xf, b) => (b && xf ? { x: xf.tx + b.x * xf.sx, y: xf.ty + b.y * xf.sy, w: b.w * xf.sx, h: b.h * xf.sy } : b);

    // Inverted layouts: a layout (or slide) can override the master's colour map wholesale --
    // that is how section-divider layouts swap tx1 to lt1 so titles go white on dark. Colours
    // must resolve against the effective map of the part chain they render on.
    // 倒色版式。版式(或幻灯片)可以整张覆盖母版的颜色映射表 —— 分节版式就是这样把 tx1 换成 lt1,
    // 深底上标题变白。解析颜色必须用所在部件链的有效映射表。
    const themeWith = (ovr) => (ovr ? { ...theme, clrMap: ovr } : theme);
    const ovrOf = (xmlDoc) => {
      const o = xmlDoc && NS(xmlDoc, 'overrideClrMapping')[0];
      if (!o) return null;
      const m = {};
      for (const a of o.attributes) m[a.name] = a.value;
      return m;
    };
    const layoutThemeCache = new Map();
    const layoutThemeOf = async (layoutPath) => {
      if (!layoutThemeCache.has(layoutPath)) {
        layoutThemeCache.set(layoutPath, themeWith(ovrOf(await loadXml(layoutPath))));
      }
      return layoutThemeCache.get(layoutPath);
    };

    // Per-level default run properties out of an lstStyle-like element (colour, size, bold)
    // 从 lstStyle 类元素提取按级别的默认 run 属性(颜色、字号、加粗)
    const lvlStylesOf = (holder, th) => {
      const lvls = {};
      if (!holder) return lvls;
      for (const p of holder.children) {
        const m = /^lvl([1-9])pPr$/.exec(p.localName);
        if (!m) continue;
        const defRPr = firstChildNS(p, 'defRPr');
        if (!defRPr) continue;
        const color = colorFrom(firstChildNS(defRPr, 'solidFill'), th);
        const sz = parseInt(defRPr.getAttribute('sz') || '0', 10) / 100;
        // b is tri-state: unset must keep falling through the rings, unlike color/sz where
        // empty already means unset / b 是三态。没写就要继续沿环下钻。color/sz 用空值即可表达
        const bAttr = defRPr.getAttribute('b');
        lvls[parseInt(m[1], 10) - 1] = { color: color || '', sz: sz || 0, b: bAttr == null ? null : bAttr === '1' };
      }
      return lvls;
    };

    // Placeholder inheritance from layout and master: geometry AND text styles. The master's
    // txStyles (title/body/other) is the outermost fallback ring, keyed as @title / @body.
    // 占位符自版式与母版的继承:几何与文字样式都要。母版 txStyles(标题/正文/其它)是最外圈兜底,
    // 以 @title / @body 为键。
    const phMapCache = new Map();
    const phMapOf = async (layoutPath) => {
      if (phMapCache.has(layoutPath)) return phMapCache.get(layoutPath);
      const map = new Map();
      const th = await layoutThemeOf(layoutPath);
      const harvest = async (path) => {
        const x = await loadXml(path);
        if (!x) return null;
        for (const sp of NS(x, 'sp')) {
          const ph = NS(sp, 'ph')[0];
          if (!ph) continue;
          const box = xfrmOf(sp);
          const body = firstChildNS(sp, 'txBody');
          const lvls = lvlStylesOf(body && firstChildNS(body, 'lstStyle'), th);
          const type = ph.getAttribute('type') || 'body';
          const idx = ph.getAttribute('idx') || '';
          for (const k of [`${type}#${idx}`, idx ? `#${idx}` : null, `${type}#`]) {
            if (!k) continue;
            const cur = map.get(k) || {};
            map.set(k, {
              box: cur.box || box,
              lvls: { ...lvls, ...(cur.lvls || {}) }, // inner ring wins / 内圈优先
            });
          }
        }
        return x;
      };
      await harvest(layoutPath);
      const lrels = layoutPath ? await relsOf(layoutPath) : new Map();
      const master = [...lrels.values()].find((r) => r.type.endsWith('/slideMaster'));
      if (master) {
        const mx = await harvest(master.target);
        const txStyles = mx && NS(mx, 'txStyles')[0];
        if (txStyles) {
          map.set('@title', { box: null, lvls: lvlStylesOf(firstChildNS(txStyles, 'titleStyle'), th) });
          map.set('@body', {
            box: null,
            lvls: { ...lvlStylesOf(firstChildNS(txStyles, 'otherStyle'), th), ...lvlStylesOf(firstChildNS(txStyles, 'bodyStyle'), th) },
          });
        }
      }
      phMapCache.set(layoutPath, map);
      return map;
    };
    const phEntry = (map, type, idx) => {
      const alias = type === 'ctrTitle' ? 'title' : type === 'subTitle' ? 'body' : type;
      return map.get(`${type}#${idx}`) || map.get(`${alias}#${idx}`) || (idx ? map.get(`#${idx}`) : null)
        || map.get(`${type}#`) || map.get(`${alias}#`) || null;
    };
    const phBox = (map, type, idx) => phEntry(map, type, idx)?.box || null;
    /** Level style with the master's category ring behind the layout's placeholder ring
     *  级别样式。版式占位符圈在前,母版类别圈殿后 */
    const phLvl = (map, type, idx, lvl) => {
      const own = phEntry(map, type, idx)?.lvls || {};
      const cat = map.get(/title/i.test(type || '') ? '@title' : '@body')?.lvls || {};
      const pick = (src) => src[lvl] || src[0] || null;
      const a = pick(own);
      const c = pick(cat);
      return { color: a?.color || c?.color || '', sz: a?.sz || c?.sz || 0, b: a?.b ?? c?.b ?? null };
    };

    const scaleOf = (sp) => {
      const fit = NS(sp, 'normAutofit')[0];
      const raw = fit?.getAttribute('fontScale');
      if (!raw) return 1;
      const n = parseFloat(raw);
      if (!Number.isFinite(n) || n <= 0) return 1;
      return String(raw).includes('%') ? n / 100 : n / 100000;
    };
    const szOf = (rPr) => (rPr ? parseInt(rPr.getAttribute('sz') || '0', 10) / 100 : 0);
    const defaultSz = (type, lvl) => (/title/i.test(type || '') ? 36 : [22, 20, 18, 16, 15][Math.min(lvl, 4)]);

    /** Font family for a run. The run's own ea/latin first, theme references resolved.
     *  一个 run 的字体族。优先取它自己的 ea/latin。主题引用一并解析。 */
    const fontOf = (rPr) => {
      const ea = themeFont(firstChildNS(rPr, 'ea')?.getAttribute('typeface') || '');
      const lt = themeFont(firstChildNS(rPr, 'latin')?.getAttribute('typeface') || '');
      const fam = [...new Set([ea, lt].filter(Boolean))];
      return fam.length ? fam.map((f) => `"${f}"`).join(',') + ',sans-serif' : '';
    };

    /** First stop of a run-level gradient fill, as the readable approximation of text gradients
     *  run 级渐变填充的第一个停靠色。文字渐变的可读近似 */
    const runGradColor = (rPr, th) => {
      const gf = rPr && firstChildNS(rPr, 'gradFill');
      const gs = gf && NS(gf, 'gs')[0];
      return (gs && colorFrom(gs, th)) || '';
    };

    const parseBody = (sp, phType, inheritColor, phStyle, th) => {
      const body = firstChildNS(sp, 'txBody');
      if (!body) return { lines: [], anchor: 't' };
      const fontScale = scaleOf(sp);
      const bodyPr = firstChildNS(body, 'bodyPr');
      const anchor = bodyPr?.getAttribute('anchor') || 't';
      // The shape's own txBody lstStyle sits between the paragraph and the placeholder chain,
      // and beats the style fontRef -- a plain box often carries its real text colour here.
      // 形状自己 txBody 里的 lstStyle 介于段落与占位符链之间,并且优先于 style 的 fontRef ——
      // 普通文本框的真实文字颜色经常就写在这里。
      const ownLvls = lvlStylesOf(firstChildNS(body, 'lstStyle'), th);
      const lines = [];
      for (const p of childNS(body, 'p')) {
        const pPr = firstChildNS(p, 'pPr');
        const lvl = pPr ? parseInt(pPr.getAttribute('lvl') || '0', 10) : 0;
        const ownS = ownLvls[lvl] || null;
        const phS = phStyle ? phStyle(lvl) : null;
        const algn = pPr?.getAttribute('algn') || 'l';
        const defRPr = firstChildNS(pPr, 'defRPr');
        const defSz = szOf(defRPr);
        const defClr = colorFrom(firstChildNS(defRPr, 'solidFill'), th);
        // Line spacing and space-before / 行距与段前距
        const spcPct = firstChildNS(firstChildNS(pPr, 'lnSpc'), 'spcPct');
        const lnSpc = spcPct ? (parseInt(spcPct.getAttribute('val') || '100000', 10) || 100000) / 100000 : 0;
        const spcPts = firstChildNS(firstChildNS(pPr, 'spcBef'), 'spcPts');
        const spcBef = spcPts ? (parseInt(spcPts.getAttribute('val') || '0', 10) || 0) / 100 : 0;
        // Bullets only when declared; guessing produces dots where the deck has none
        // 只认显式声明的项目符号。乱猜会在人家没点的地方点一个点
        let bullet = '';
        const buChar = firstChildNS(pPr, 'buChar');
        if (buChar) bullet = buChar.getAttribute('char') || '';
        else if (firstChildNS(pPr, 'buAutoNum')) bullet = '#';
        let runs = [];
        const flush = () => {
          if (runs.length) lines.push({ runs, lvl, algn, lnSpc, spcBef, bullet });
          runs = [];
        };
        for (const el of p.children) {
          if (el.localName === 'r' || el.localName === 'fld') {
            const rPr = firstChildNS(el, 'rPr');
            const t2 = childNS(el, 't').map((x) => x.textContent).join('');
            if (!t2) continue;
            const sz = (szOf(rPr) || defSz || (ownS && ownS.sz) || (phS && phS.sz) || defaultSz(phType, lvl)) * fontScale;
            // Explicit b="0" must win over inherited bold / 显式 b="0" 要压过继承来的加粗
            const bAttr = rPr?.getAttribute('b') ?? defRPr?.getAttribute('b');
            runs.push({
              t: t2, sz,
              b: bAttr != null ? bAttr === '1' : !!(ownS?.b ?? phS?.b),
              i: rPr?.getAttribute('i') === '1',
              u: !!rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none',
              strike: !!rPr?.getAttribute('strike') && rPr.getAttribute('strike') !== 'noStrike',
              // Colour resolution ring, innermost first: the run itself, its gradient, the
              // paragraph default, the shape's own lstStyle, the placeholder styles from layout
              // and master, the shape's theme fontRef.
              // 颜色解析环,由内向外:run 自身、其渐变、段落默认、形状自带 lstStyle、
              // 版式与母版的占位符样式、形状的主题 fontRef。
              color: colorFrom(firstChildNS(rPr, 'solidFill'), th) || runGradColor(rPr, th)
                || defClr || (ownS && ownS.color) || (phS && phS.color) || inheritColor || '',
              font: fontOf(rPr),
            });
          } else if (el.localName === 'br') {
            flush();
          }
        }
        flush();
      }
      return { lines, anchor };
    };

    // One walker per part. Decoration passes over layout and master skip placeholders.
    // th is the effective theme of the part chain (layout colour-map override applied).
    // 每个部件一个遍历器。扫版式和母版的装饰趟不收占位符。
    // th 是该部件链的有效主题(已套用版式的颜色映射覆盖)。
    const makeWalker = ({ rels, phMap, items, texts, includePh, th }) => {
      const media = (scope) => {
        const blip = NS(scope, 'blip')[0];
        const rid = blip?.getAttribute('r:embed')
          || blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
        const rel = rid && rels.get(rid);
        if (!rel) return null;
        return mediaOf(rel.target, PPTX_IMG_MIME[ext(rel.target)]);
      };
      const walk = (tree, xf) => {
        for (const el of tree.children) {
          const ln = el.localName;
          if (ln === 'AlternateContent') {
            const pick = firstChildNS(el, 'Fallback') || firstChildNS(el, 'Choice');
            if (pick) walk(pick, xf);
          } else if (ln === 'sp') {
            const ph = NS(el, 'ph')[0];
            if (ph && !includePh) continue;
            const phType = ph?.getAttribute('type') || (ph ? 'body' : '');
            const own = xfrmOf(el);
            const box = own ? applyXf(xf, own) : ph && phMap ? phBox(phMap, phType || 'body', ph.getAttribute('idx') || '') : null;
            const spPr = firstChildNS(el, 'spPr');
            const styleC = styleColors(el, th);
            let fill = fillOf(spPr, th, media);
            if (!fill && styleC.fill) fill = { type: 'solid', css: styleC.fill };
            let line = lineOf(spPr, th);
            if (!line && styleC.line) line = { css: styleC.line, w: 1, dash: 'solid' };
            const geomEl = firstChildNS(spPr, 'prstGeom');
            const prst = geomEl ? geomEl.getAttribute('prst') || 'rect' : 'rect';
            const custom = custGeomPath(spPr);
            const phStyle = ph && phMap
              ? (lvl) => phLvl(phMap, phType || 'body', ph.getAttribute('idx') || '', lvl)
              : null;
            const { lines, anchor } = parseBody(el, phType, styleC.font, phStyle, th);
            // A "line" geometry is a stroke, not a box -- a border would draw a rectangle
            // line 几何是一根线段而不是盒子。画成边框就成矩形了
            if ((prst === 'line' || prst === 'straightConnector1' || prst === 'bentConnector3') && !lines.length) {
              if (box && line && line.type !== 'none') {
                items.push({ kind: 'cxn', box, line, bent: prst.startsWith('bent'), flipH: !!own?.flipH, flipV: !!own?.flipV });
              }
              continue;
            }
            const visible = (fill && fill.type !== 'none') || (line && line.type !== 'none') || lines.length;
            if (!visible) continue;
            for (const l of lines) texts.push(l.runs.map((r) => r.t).join(''));
            items.push({
              kind: 'shape', box, isTitle: /title/i.test(phType), anchor, lines,
              fill, line, prst, custom,
              rot: own?.rot || 0, flipH: !!own?.flipH, flipV: !!own?.flipV,
            });
          } else if (ln === 'pic') {
            const bf = firstChildNS(el, 'blipFill');
            const m = bf && media(bf);
            if (!m) continue;
            const ph = NS(el, 'ph')[0];
            if (ph && !includePh) continue;
            const own = xfrmOf(el);
            const box = own ? applyXf(xf, own) : ph && phMap ? phBox(phMap, ph.getAttribute('type') || 'pic', ph.getAttribute('idx') || '') : null;
            // Embedded video: the pic is its poster frame; carry the media part so the preview
            // can offer actual playback.
            // 内嵌视频。这个 pic 是它的海报帧。把媒体部件一起带上,预览就能真的播放。
            let video = null;
            const vf = NS(el, 'videoFile')[0];
            const vrid = vf && (vf.getAttribute('r:link')
              || vf.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'link'));
            const vrel = vrid && rels.get(vrid);
            if (vrel) {
              const vmime = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' }[ext(vrel.target)];
              video = mediaOf(vrel.target, vmime);
            }
            items.push({
              kind: 'image', box, ...m, srcRect: srcRectOf(bf), video,
              rot: own?.rot || 0, flipH: !!own?.flipH, flipV: !!own?.flipV,
            });
          } else if (ln === 'cxnSp') {
            const own = xfrmOf(el);
            if (!own) continue;
            const spPr = firstChildNS(el, 'spPr');
            const styleC = styleColors(el, th);
            let line = lineOf(spPr, th);
            if (!line && styleC.line) line = { css: styleC.line, w: 1, dash: 'solid' };
            if (!line || line.type === 'none') continue;
            const geomEl = firstChildNS(spPr, 'prstGeom');
            items.push({
              kind: 'cxn', box: applyXf(xf, own), line,
              bent: /bent|elbow/i.test(geomEl?.getAttribute('prst') || ''),
              flipH: !!own.flipH, flipV: !!own.flipV,
            });
          } else if (ln === 'grpSp') {
            const g = xfrmOf(el);
            let childXf = xf;
            if (g && g.chExt) {
              const chW = parseInt(g.chExt.getAttribute('cx'), 10) / EMU || g.w;
              const chH = parseInt(g.chExt.getAttribute('cy'), 10) / EMU || g.h;
              const chX = g.chOff ? parseInt(g.chOff.getAttribute('x'), 10) / EMU : 0;
              const chY = g.chOff ? parseInt(g.chOff.getAttribute('y'), 10) / EMU : 0;
              const sx = chW ? g.w / chW : 1;
              const sy = chH ? g.h / chH : 1;
              const outer = applyXf(xf, { x: g.x, y: g.y, w: g.w, h: g.h });
              const pxf = xf || { sx: 1, sy: 1, tx: 0, ty: 0 };
              childXf = {
                sx: sx * pxf.sx, sy: sy * pxf.sy,
                tx: outer.x - chX * sx * pxf.sx, ty: outer.y - chY * sy * pxf.sy,
              };
            }
            walk(el, childXf);
          } else if (ln === 'graphicFrame') {
            const tbl = NS(el, 'tbl')[0];
            if (!tbl) continue;
            const own = xfrmOf(el);
            const lines = [];
            for (const tr of NS(tbl, 'tr')) {
              const cells = childNS(tr, 'tc').map((tc) => NS(tc, 't').map((x) => x.textContent).join(''));
              const rowText = cells.filter(Boolean).join('  |  ');
              if (rowText) {
                lines.push({ runs: [{ t: rowText, sz: 12, b: false, color: '', font: '' }], lvl: 0, algn: 'l', lnSpc: 0, spcBef: 0, bullet: '' });
                texts.push(rowText);
              }
            }
            if (lines.length) {
              items.push({
                kind: 'shape', box: own ? applyXf(xf, own) : null, isTitle: false, anchor: 't', lines,
                fill: null, line: null, prst: 'rect', custom: null, rot: 0, flipH: false, flipV: false,
              });
            }
          }
        }
      };
      return walk;
    };

    /** Background fill of one part document / 一个部件文档声明的背景填充 */
    const bgOf = (xmlDoc, rels, th) => {
      const bg = xmlDoc && NS(xmlDoc, 'bg')[0];
      if (!bg) return null;
      const bgPr = firstChildNS(bg, 'bgPr');
      if (bgPr) {
        const media = (scope) => {
          const blip = NS(scope, 'blip')[0];
          const rid = blip?.getAttribute('r:embed')
            || blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
          const rel = rid && rels.get(rid);
          if (!rel) return null;
          return mediaOf(rel.target, PPTX_IMG_MIME[ext(rel.target)]);
        };
        return fillOf(bgPr, th, media);
      }
      const bgRef = firstChildNS(bg, 'bgRef');
      const css = bgRef && colorFrom(bgRef, th);
      return css ? { type: 'solid', css } : null;
    };

    // Decorations and background of a layout and its master, cached per layout
    // 版式与其母版的装饰形状和背景。按版式缓存
    const decoCache = new Map();
    const decoOf = async (layoutPath) => {
      if (decoCache.has(layoutPath)) return decoCache.get(layoutPath);
      const out = { items: [], bg: null };
      const parts = [];
      const lx = await loadXml(layoutPath);
      if (lx) {
        const th = await layoutThemeOf(layoutPath);
        const lrels = await relsOf(layoutPath);
        const master = [...lrels.values()].find((r) => r.type.endsWith('/slideMaster'));
        if (master) parts.push({ path: master.target });
        parts.push({ path: layoutPath });
        for (const part of parts) {
          const xmlDoc = await loadXml(part.path);
          if (!xmlDoc) continue;
          const rels = await relsOf(part.path);
          // The layout wins over the master visually, so its bg check runs last on purpose:
          // actual order is master bg unless layout declares one.
          // 视觉上版式盖过母版。背景取用顺序是母版的先记下,版式声明了就覆盖。
          const bgHere = bgOf(xmlDoc, rels, th);
          if (bgHere) out.bg = bgHere;
          const tree = NS(xmlDoc, 'spTree')[0];
          if (tree) {
            makeWalker({ rels, phMap: null, items: out.items, texts: [], includePh: false, th })(tree, null);
          }
        }
      }
      decoCache.set(layoutPath, out);
      return out;
    };

    // Slide ORDER comes from the presentation's own list, not from the numbers in the file
    // names: slide7.xml is not reliably the seventh slide, and a deck reordered in PowerPoint
    // proves it every time.
    // 幻灯片的"顺序"取自 presentation 自己的列表，而不是文件名里的数字：
    // slide7.xml 并不可靠地就是第七页，一套在 PowerPoint 里重排过的幻灯片每次都能证明这一点。
    let names = [];
    const idLst = px && NS(px, 'sldIdLst')[0];
    if (idLst) {
      for (const sld of idLst.children) {
        const rid = sld.getAttribute('r:id')
          || sld.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        const rel = rid && presRels.get(rid);
        if (rel) names.push(rel.target);
      }
    }
    if (!names.length) {
      // No list to go by: fall back to the folder, in numeric order
      // 无表可依：退回按目录取，按数字排序
      names = (zip.dir('ppt/slides') || [])
        .filter((n) => !n.isDir && /^slide[0-9]+[.]xml$/.test(n.name))
        .sort((a, b) => parseInt(a.name.slice(5), 10) - parseInt(b.name.slice(5), 10))
        .map((n) => 'ppt/slides/' + n.name);
    }

    const readSlide = async (name) => {
      {
      try {
        const xml = await loadXml(name);
        const rels = await relsOf(name);
        const layout = [...rels.values()].find((r) => r.type.endsWith('/slideLayout'));
        const layoutPath = layout ? layout.target : '';
        const phMap = await phMapOf(layoutPath);
        const deco = await decoOf(layoutPath);
        // Slide colours resolve under the slide's own map override if present, else the layout's
        // 幻灯片颜色按其自带的映射覆盖解析。没有就用版式的
        const sOvr = ovrOf(xml);
        const th = sOvr ? themeWith(sOvr) : await layoutThemeOf(layoutPath);
        const ownItems = [];
        const texts = [];
        const tree = NS(xml, 'spTree')[0];
        if (tree) makeWalker({ rels, phMap, items: ownItems, texts, includePh: true, th })(tree, null);
        const bg = bgOf(xml, rels, th) || deco.bg;
        // Legacy views for thumbnails and search: the slide's own text shapes and pictures
        // 缩略图与搜索用的旧视图。只含本页自己的文字形状与图片
        const shapes = ownItems.filter((it) => it.kind === 'shape' && it.lines.length);
        const images = ownItems.filter((it) => it.kind === 'image');
        return { items: [...deco.items, ...ownItems], bg, shapes, images, text: texts.join('\n') };
      } catch (e) {
        console.warn('pptx slide parse failed', name, e);
        return { items: [], bg: null, shapes: [], images: [], text: '', broken: true };
      }
      }
    };

    // The deck's own backdrop, taken from the master. A slide that has not been parsed yet has
    // to be waited on somewhere, and waiting on a white rectangle in front of a dark deck is a
    // flash of the wrong document. Only a flat colour or a gradient is usable here -- a picture
    // background would mean fetching its bytes, which is the very thing being deferred.
    // 整套幻灯片自己的底色，取自母版。尚未解析的那一页总得在某个地方等，
    // 而在一套深色幻灯片前面等一块白矩形，闪的是另一份文档。
    // 此处只能用纯色或渐变 —— 图片底意味着要去取它的字节，
    // 而那正是此刻要推迟的事。
    let deckBg = null;
    try {
      const mb = masterXml && bgOf(masterXml, mRels, theme);
      if (mb && (mb.type === 'solid' || mb.type === 'grad')) deckBg = mb.css;
    } catch { /* a deck with no usable master background simply has none / 没有可用母版底色就是没有 */ }

    const cache = new Map();
    // The cover is for thumbnails; a preview never wants it. Leaving it as a thunk keeps its
    // hundred kilobytes off every deck that is merely being read.
    // 封面是给缩略图用的,预览从不需要它。留成一个 thunk,它那一百来 KB 就不会
    // 压在每一套"只是被读一读"的幻灯片头上。
    return {
      w,
      h,
      bg: deckBg,
      count: names.length,
      async cover() {
        const b = (await zipPart(zip, 'docProps/thumbnail.jpeg', PART_CAP))
          || (await zipPart(zip, 'docProps/thumbnail.png', PART_CAP));
        return b ? new Blob([b], { type: 'image/jpeg' }) : null;
      },
      async slide(i) {
        if (!names[i]) return null;
        if (!cache.has(i)) cache.set(i, await readSlide(names[i]));
        return cache.get(i);
      },
    };
  } catch (e) {
    // Soft-fail for the UI, but leave a trace for whoever opens devtools with a broken file
    // 界面软着陆,但给拿着问题文件开 devtools 的人留个线索
    console.warn('pptx parse failed', e);
    return null;
  }
}

