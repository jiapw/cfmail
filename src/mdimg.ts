// Images a Markdown document points at somewhere else on the web.
//
// A document can name any picture on the internet, and the naive way to show one is to put the
// author's URL straight into an <img>. That makes every reader's browser call a host the author
// chose: the reader's address, their user agent, and the page they were on all arrive at a
// stranger, once per picture, and nobody asked them. It also fails in the ordinary case -- a
// document written years ago names an http:// picture, and a browser on an https:// page will not
// load it -- so the pictures that break are exactly the old ones nobody can re-upload.
//
// So the fetch is made from here instead. One host is contacted by the reader (this one), the
// remote host sees only a Cloudflare address, and the bytes come back over the connection the
// reader already has. GitHub has done this since 2010 for the same two reasons.
//
// Markdown 文档指向别处的图片。
//
// 一个文档可以指名互联网上任何一张图,而最朴素的显示方式是把作者写的 URL 直接放进 <img>。
// 那会让每个读者的浏览器去呼叫一台作者挑的主机:读者的地址、他的 User-Agent、他正在看的页面,
// 每张图一次,悉数送到一个陌生人手里 —— 而没有人问过他。
// 它在寻常情形下还会直接失败:多年前写的文档指着一张 http:// 的图,
// 而 https:// 页面上的浏览器不会加载它 —— 于是坏掉的恰恰是那些没人再补得上的旧图。
//
// 所以这一次取回改由这里发出。读者只联系一台主机(就是这一台),远端只看见一个 Cloudflare 地址,
// 而字节沿着读者本来就有的那条连接回来。GitHub 从 2010 年起就这么做,理由是同样这两条。
import type { Context } from 'hono';
import { HttpError } from './errors';

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

// SVG is an image everywhere except in the one place that matters here: fetched on its own it is a
// document, and a document served from our origin may script against it. It stays out, the same
// way it stays out of the inline-preview whitelist, and for the same reason the /cid endpoint
// taught us once already.
// SVG 处处都算图片,唯独在这里最要紧的那个位置不算:单独取用时它是一份文档,
// 而从本站源供出的文档可以对着本站执行脚本。它进不来 —— 一如它进不了内联预览白名单,
// 理由正是 /cid 端点早已教过我们的那一条。
const OK_TYPE = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|tiff)$/;

/** Addresses that are not the public internet. A Worker's fetch leaves Cloudflare's network and so
 *  cannot reach the machine this code runs on, but it can reach anything the DNS name resolves to,
 *  and the names below are the ones whose whole purpose is to mean "not out there". Refusing them
 *  by name costs nothing and keeps this endpoint from being the thing that makes a private address
 *  reachable through a public one.
 *  不属于公共互联网的地址。Worker 的 fetch 从 Cloudflare 的网络出去,够不到运行这段代码的机器,
 *  但它够得到 DNS 名字解析出来的任何东西 —— 而下面这些名字,存在的全部意义就是"不在外面"。
 *  按名字拒掉它们不花什么代价,却能让这个端点不至于成为
 *  "让一个私有地址经由一个公开地址变得可达"的那样东西。 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6, including the ::ffff:10.0.0.1 form that hides a v4 address inside a v6 literal
  // IPv6,含 ::ffff:10.0.0.1 这种把 v4 地址藏在 v6 字面量里的写法
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
    const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    return v4 ? isPrivateHost(v4[1]) : false;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return true;   // not an address at all / 根本不是个地址
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)                                // link-local, and the cloud metadata address / 链路本地,以及云厂商的元数据地址
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)                      // carrier NAT / 运营商级 NAT
    || a >= 224;                                               // multicast and above / 组播及以上
}

/** Fetch one remote image and hand it back. Everything about the answer is decided here rather
 *  than taken from the remote: its type is checked against a list, its size is capped while it
 *  streams, and it is served with nosniff so that whatever it turns out to be, the browser treats
 *  it as the picture it was asked for and nothing else.
 *  取回一张远端图片再交出去。关于这个回答的一切都在这里决定,而不是照搬远端所说:
 *  类型对着一张表核过,大小在流式传输途中就被封顶,并且带 nosniff 供出 ——
 *  于是无论它最后是什么东西,浏览器都只把它当作被请求的那张图片,别的一概不是。 */
export async function mdImage(c: Context): Promise<Response> {
  const raw = String(c.req.query('u') || '');
  if (!raw || raw.length > 2048) throw new HttpError(400, 'e_bad_request');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'e_bad_request');
  }
  // http is accepted and then not used: the request leaves here over https where the remote host
  // offers it, and the reader's page never learns the difference. That is the whole reason an old
  // document's pictures come back to life.
  // http 被接受,然后并不被使用:只要远端主机提供 https,这里就以 https 发出请求,
  // 而读者的页面自始至终不知道其中的差别。这正是一份旧文档的图片得以复活的全部理由。
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'e_md_img_scheme');
  if (isPrivateHost(url.hostname)) throw new HttpError(400, 'e_md_img_host');
  if (url.hostname === new URL(c.req.url).hostname) throw new HttpError(400, 'e_md_img_host');

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: 'image/*',
        // No referer, and a user agent that is this service rather than the reader. The remote
        // host is entitled to know something is fetching; it is not entitled to know who.
        // 不发 Referer,User-Agent 说的是这个服务而不是那位读者。
        // 远端有权知道有人在取;它无权知道那是谁。
        'User-Agent': 'CFMail-Image-Proxy',
      },
    });
  } catch {
    throw new HttpError(502, 'e_md_img_fetch');
  }
  if (!res.ok || !res.body) throw new HttpError(502, 'e_md_img_fetch');
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!OK_TYPE.test(type)) throw new HttpError(415, 'e_md_img_type');
  const declared = parseInt(res.headers.get('Content-Length') || '', 10);
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new HttpError(413, 'e_md_img_big');

  // A declared length is a claim, so the cap is enforced on the bytes themselves as they pass.
  // Cutting the stream mid-picture leaves a broken image, which is the correct outcome: the
  // alternative is holding an unbounded body to find out how big it was.
  // 声明的长度只是一种说法,所以上限要落在真正流过的字节上。
  // 中途切断留下一张破图,而这正是对的结果:另一种做法是把一个无界的响应体攥住,只为弄清它有多大。
  let seen = 0;
  const capped = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > MAX_BYTES) ctl.terminate();
      else ctl.enqueue(chunk);
    },
  }));

  const h = new Headers();
  h.set('Content-Type', type);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', "default-src 'none'; sandbox");
  h.set('Content-Disposition', 'inline');
  // A remote picture is a fixed thing at a fixed address; a day of freshness saves the reader a
  // round trip per picture per document, and the address is the cache key, so a different picture
  // is a different address.
  // 远端图片是固定地址上的固定东西;一天的新鲜期为读者省下"每篇文档每张图一次往返",
  // 而地址就是缓存键 —— 换一张图就是换一个地址。
  h.set('Cache-Control', 'private, max-age=86400');
  return new Response(capped, { headers: h });
}
