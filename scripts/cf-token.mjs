// What a deploy token can do about tokens: read its own policy, add to it, and make others.
//
// A Cloudflare token cannot normally be asked what it may do, and cannot be changed except by a
// person in the dashboard -- which is why the deploy probes every permission and, when one is
// missing, names it and waits. One permission changes that: "Account API Tokens · Edit" (for a
// user-owned token, "User · API Tokens · Edit"). A token that has it can read its own policy,
// so what is missing is known rather than inferred; can add a permission to itself, so nobody
// has to go and tick a box; and can make a second, narrower token for something that has to
// live inside the Worker. Everything here is that one capability, used three ways, and every
// function says plainly when the token does not have it -- the caller then falls back to
// naming the permission and asking, exactly as before.
//
// Such a token can give itself anything its owner could, so nothing here is done quietly: each
// permission added is named by the caller, on the screen, at the moment it is added.
//
// 部署令牌在"令牌"这件事上能做什么:读自己的策略、往里加权限、再建别的令牌。
//
// Cloudflare 的令牌通常既没法被问"你能做什么",也只能由人在 dashboard 里改 —— 所以部署脚本才要逐项探测,
// 缺了就报出名字、然后等人去改。有一项权限改变了这一切:"Account API Tokens · Edit"
// (用户级令牌则是 "User · API Tokens · Edit")。有它的令牌读得到自己的策略,于是缺什么是"知道"而不是"推断";
// 能给自己加权限,于是不必有人去勾选;还能为必须留在 Worker 里的用途另建一个更窄的令牌。
// 这里的全部内容就是这一项能力的三种用法;令牌没有这项能力时每个函数都会明说 ——
// 调用方于是退回到"报出权限名、请人去加",和从前一模一样。
//
// 这样的令牌能给自己它的主人能给的一切,所以这里没有任何事是悄悄做的:
// 每加一项权限,调用方都会在加的那一刻把它的名字打在屏幕上。

const ZONE_SCOPE = 'com.cloudflare.api.account.zone';

/**
 * The token this run is using, as Cloudflare describes it -- or null when the token may not look
 * at tokens. `cf` is the caller's request helper: (method, path, body) -> { ok, status, data }.
 * 本次运行所用的令牌,以 Cloudflare 的描述为准;令牌无权查看令牌时返回 null。
 */
export async function ownToken(cf, accountId) {
  for (const base of [`/accounts/${accountId}/tokens`, '/user/tokens']) {
    const v = await cf('GET', `${base}/verify`);
    const id = v.data?.result?.id;
    if (!v.ok || !id) continue;
    const t = await cf('GET', `${base}/${id}`);
    const g = await cf('GET', `${base}/permission_groups`);
    if (!t.ok || !g.ok || !Array.isArray(t.data?.result?.policies)) return null;
    return { base, id, token: t.data.result, groups: g.data?.result || [] };
  }
  return null;
}

/** The names of everything the token is allowed, as the API spells them ("D1 Write").
 *  令牌被允许的全部权限名,按 API 的写法("D1 Write")。 */
export function grantedNames(own) {
  const out = new Set();
  for (const p of own?.token?.policies || []) if (p.effect === 'allow') for (const g of p.permission_groups || []) out.add(g.name);
  return out;
}

const isZonePolicy = (p) => Object.entries(p.resources || {}).some(([k, v]) => k.startsWith(ZONE_SCOPE + '.') || (v && typeof v === 'object'));
const isAccountPolicy = (p, accountId) => Object.entries(p.resources || {}).some(([k, v]) => v === '*' && (k === `com.cloudflare.api.account.${accountId}` || k === 'com.cloudflare.api.account.*'));

/**
 * The policies the token would have with `names` added: each permission goes into the policy of
 * its own scope -- account permissions beside the account ones, zone permissions beside the zone
 * ones -- and a scope the token has no policy for yet gets one, covering this account only.
 * Pure: nothing is sent. Returns { policies, added, unknown }.
 * 加上 `names` 之后令牌会有的策略:每项权限进入它自己作用域的那条策略 —— 账号权限挨着账号权限,
 * 域名权限挨着域名权限 —— 令牌还没有对应策略的作用域则新建一条,只覆盖本账号。纯函数:不发任何请求。
 */
export function policiesWith(own, accountId, names) {
  const policies = JSON.parse(JSON.stringify(own.token.policies || []));
  const have = grantedNames(own);
  const added = [];
  const unknown = [];
  for (const name of names) {
    if (have.has(name) || added.includes(name)) continue;
    const g = own.groups.find((x) => x.name === name);
    if (!g) { unknown.push(name); continue; }
    const zone = (g.scopes || []).includes(ZONE_SCOPE);
    let p = policies.find((x) => x.effect === 'allow' && (zone ? isZonePolicy(x) : isAccountPolicy(x, accountId)));
    if (!p) {
      p = {
        effect: 'allow',
        resources: { [`com.cloudflare.api.account.${accountId}`]: zone ? { [`${ZONE_SCOPE}.*`]: '*' } : '*' },
        permission_groups: [],
      };
      policies.push(p);
    }
    p.permission_groups.push({ id: g.id, name: g.name });
    added.push(name);
  }
  return { policies, added, unknown };
}

/** Write a set of policies onto the token itself. Everything else about it -- name, expiry,
 *  address restrictions -- is sent back exactly as it was. The token's value does not change.
 *  把一组策略写到令牌自己身上。它的其他一切 —— 名字、有效期、来源地址限制 —— 原样送回。令牌的值不变。 */
export async function writePolicies(cf, own, policies) {
  const t = own.token;
  const body = {
    name: t.name,
    status: t.status || 'active',
    policies: policies.map((p) => ({ effect: p.effect, resources: p.resources, permission_groups: (p.permission_groups || []).map((g) => ({ id: g.id })) })),
    ...(t.expires_on ? { expires_on: t.expires_on } : {}),
    ...(t.not_before ? { not_before: t.not_before } : {}),
    ...(t.condition ? { condition: t.condition } : {}),
  };
  const r = await cf('PUT', `${own.base}/${own.id}`, body);
  if (r.ok && Array.isArray(r.data?.result?.policies)) own.token = r.data.result;
  return r;
}

/**
 * Add permissions to the token this run is using. Returns { added, unknown } on success,
 * { denied: true } when the token may not edit tokens, { why } for anything else.
 * 给本次运行所用的令牌加权限。成功返回 { added, unknown };令牌无权编辑令牌时返回 { denied: true };其余返回 { why }。
 */
export async function grantSelf(cf, accountId, names, { dry = false, own = null } = {}) {
  own = own || await ownToken(cf, accountId);
  if (!own) return { denied: true };
  const { policies, added, unknown } = policiesWith(own, accountId, names);
  if (!added.length || dry) return { added, unknown, own };
  const r = await writePolicies(cf, own, policies);
  if (r.status === 403) return { denied: true };
  if (!r.ok) return { why: JSON.stringify(r.data?.errors || r.status).slice(0, 300) };
  return { added, unknown, own };
}

/**
 * Make another token that can do exactly `names` on this account. Returns { value, id },
 * { denied: true }, or { why }.
 * 另建一个在本账号上恰好能做 `names` 这些事的令牌。返回 { value, id }、{ denied: true } 或 { why }。
 */
export async function mintToken(cf, accountId, name, names, { dry = false } = {}) {
  const own = await ownToken(cf, accountId);
  if (!own) return { denied: true };
  const account = [];
  const zone = [];
  for (const n of names) {
    const g = own.groups.find((x) => x.name === n);
    if (!g) return { why: `Cloudflare lists no permission group called "${n}"` };
    ((g.scopes || []).includes(ZONE_SCOPE) ? zone : account).push({ id: g.id });
  }
  if (dry) return { value: '<dry-run>', id: 'dry-run' };
  const key = `com.cloudflare.api.account.${accountId}`;
  const policies = [];
  if (account.length) policies.push({ effect: 'allow', resources: { [key]: '*' }, permission_groups: account });
  if (zone.length) policies.push({ effect: 'allow', resources: { [key]: { [`${ZONE_SCOPE}.*`]: '*' } }, permission_groups: zone });
  const made = await cf('POST', own.base, { name, policies });
  if (made.status === 403) return { denied: true };
  const r = made.data?.result;
  if (!made.ok || !r?.value) return { why: JSON.stringify(made.data?.errors || made.status).slice(0, 300) };
  return { value: r.value, id: r.id };
}
