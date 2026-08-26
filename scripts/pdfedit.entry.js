// What the PDF editor needs from the outside world, gathered into one browser module.
//
// pdf-lib reads and rewrites the file's structure; fontkit reads font programs and cuts subsets
// out of them. pdf-lib ships browser-ready ESM and could be vendored on its own, but fontkit
// arrives as ten bare imports into its own dependency tree, so both come through the bundler
// together rather than one of them arriving by a different door.
//
// PDF 编辑器需要从外面拿的东西,汇总成一个浏览器模块。
//
// pdf-lib 读写文件结构;fontkit 读字体程序并从中裁出子集。pdf-lib 本身就发浏览器可用的 ESM,
// 单独 vendor 也行;但 fontkit 带着十个指向自身依赖树的裸导入,所以两者一起走打包这道门,
// 而不是其中一个从另一扇门进来。

import * as fontkit from 'fontkit';

export {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFRawStream,
  PDFRef, PDFStream, StandardFonts, rgb, degrees, decodePDFRawStream,
} from 'pdf-lib';

/**
 * fontkit with the one method pdf-lib still asks it for.
 *
 * pdf-lib 1.17 was written against fontkit 1.x, whose subsets handed their bytes over as a Node
 * stream; fontkit 2 returns them from `encode()` instead. The gap is one adapter wide -- and it
 * is worth crossing rather than staying on the old fork, because the old fork's subsetter
 * silently produces a broken font program for at least one real CJK face: fontTools cannot
 * decompile the `glyf` table it writes, and the page renders as a row of empty boxes. A subset
 * that is wrong in a way nothing reports is the worst kind of wrong.
 *
 * 给 fontkit 补上 pdf-lib 仍然要问它要的那一个方法。
 *
 * pdf-lib 1.17 是照着 fontkit 1.x 写的 —— 那时子集通过 Node 流交出字节;fontkit 2 改成从
 * `encode()` 返回。中间的缝只有一个适配器那么宽,而这道缝值得跨过去,不该赖在旧分支上:
 * 旧分支的子集器对至少一款真实的中文字体会静默产出损坏的字体程序 ——
 * fontTools 连它写出的 `glyf` 表都解不开,页面渲染成一排空框。
 * 一个"错了却没有任何人报告"的子集,是最糟的那种错。
 */
export const subsetFontkit = {
  create(buf, postscriptName) {
    return adapt(fontkit.create(buf, postscriptName));
  },
  openSync(...args) {
    return adapt(fontkit.openSync(...args));
  },
};

function adapt(font) {
  if (!font || typeof font.createSubset !== 'function') return font;
  const original = font.createSubset.bind(font);
  font.createSubset = () => {
    const subset = original();
    if (typeof subset.encodeStream === 'function') return subset;
    // The shape pdf-lib listens to: chainable .on('data'|'end'|'error'). Deliberately not a
    // Node stream -- there is no such thing here, and a whole font arrives in one piece anyway.
    // pdf-lib 要听的形状:可链式的 .on('data'|'end'|'error')。有意不做成 Node 流 ——
    // 这里根本没有那种东西,而且一份字体本来就是一次性到齐的。
    subset.encodeStream = () => {
      const on = {};
      const api = {
        on(event, cb) {
          on[event] = cb;
          return api;
        },
      };
      queueMicrotask(() => {
        try {
          on.data?.(new Uint8Array(subset.encode()));
          on.end?.();
        } catch (err) {
          on.error?.(err);
        }
      });
      return api;
    };
    return subset;
  };
  return font;
}

/** Reading a font program without meaning to embed it -- coverage, names, outlines.
 *  只是读一个字体程序而不打算嵌入它 —— 覆盖范围、名字、轮廓。 */
export const readFont = (buf, postscriptName) => fontkit.create(buf, postscriptName);
