// Cloudflare Turnstile mounting helper.
// The sitekey comes from /api/brand (the server only sends one when both the sitekey and the secret are configured); without it the whole feature stays off.
// The challenges.cloudflare.com script loads once, and widgets are rendered explicitly per container.
// Cloudflare Turnstile 挂载助手。
// sitekey 由 /api/brand 下发(服务端 sitekey+secret 都配置了才给),没有就整体不启用。
// challenges.cloudflare.com 的脚本只加载一次,widget 按容器显式渲染。

let loader = null;

function loadScript() {
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => { loader = null; reject(new Error('turnstile load failed')); };
      document.head.appendChild(s);
    });
  }
  return loader;
}

// Our language codes -> the codes Turnstile understands; the default auto follows the browser
// 我们的语言代码 → Turnstile 支持的代码;缺省 auto 跟浏览器
const TS_LANG = {
  'zh-CN': 'zh-cn', 'zh-TW': 'zh-tw',
  en: 'en', ja: 'ja', ko: 'ko', de: 'de', fr: 'fr', es: 'es', ru: 'ru',
};

/**
 * Render a widget inside el and return { token(), reset() }.
 * Tokens are single-use: after the server rejects a request, call reset() to obtain a new one.
 * 在 el 里渲染 widget,返回 { token(), reset() }。
 * token 一次性:请求被服务端拒绝后要 reset() 重新取。
 */
export async function mountTurnstile(el, sitekey, { theme = 'auto', lang = '' } = {}) {
  const ts = await loadScript();
  let token = '';
  const id = ts.render(el, {
    sitekey,
    theme,
    language: TS_LANG[lang] || 'auto',
    size: 'flexible',
    callback: (t) => { token = t; },
    'expired-callback': () => { token = ''; },
    'error-callback': () => { token = ''; },
  });
  return {
    token: () => token,
    reset: () => { token = ''; try { ts.reset(id); } catch { /* widget 已被移出 DOM */ } },
  };
}
