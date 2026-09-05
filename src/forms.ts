// Web forms.
//
// Somebody designs a survey or a feedback sheet, hands out one permanent link, and every answer
// arrives as a message in the inbox of the colleagues they named -- written there directly, the
// way site-internal mail already is, never through a sending channel. The answers live nowhere
// else: the mailbox is where this company reads, searches and files things, and a second copy
// would be a second thing to protect.
//
// Two halves. formsApp is the designer's side and sits behind the session like everything else.
// fillApp is the door the link opens, and it is deliberately not behind requireAuth: a public
// form is filled by people with no account here. What an anonymous visitor may do is small and
// enumerated -- read one design, prove one address, submit one set of answers -- and each of
// those is rate-limited on its own.
//
// 网页表单。
//
// 某人设计一份问卷或反馈表,发出一条永久链接,每一份答复都以一封邮件的形式抵达他指定的同事的
// 收件箱 —— 直接写进去,与站内邮件一直以来的方式相同,从不经过发信通道。答复不存在别处:
// 邮箱是这家公司读、搜、归档的地方,第二份副本只是第二件要保护的东西。
//
// 两半。formsApp 是设计者这一侧,和其余一切一样待在会话之后。fillApp 是链接打开的那扇门,
// 刻意不挂在 requireAuth 之后:公开表单由在此没有账号的人来填。匿名访问者能做的事很少且可数 ——
// 读一份设计、证明一个地址、提交一组答复 —— 每一件各自限速。
import { Hono } from 'hono';
import type { Addr, Env, User } from './types';
import { requireAuth, userFromRequest } from './auth';
import { HttpError, E } from './errors';
import { buildMime, type MimeAttachment } from './mime';
import { findMailboxByAddress, ingestEml } from './parse';
import { sendSystemMail } from './send';
import { aiAvailable, translateInto } from './llm';
import { domainFromHost, isEmail, jsonTry, normalizeAddr, now, randomToken, sha256Hex, uid } from './util';
import { countryLabel, isCountry } from './countries';

type Ctx = { Bindings: Env; Variables: { user: User } };

// ---------- The design ----------
// ---------- 设计 ----------

const FORM_LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru'];
const KINDS = new Set(['survey', 'feedback']);
const AUDIENCES = new Set(['public', 'internal']);
export const FIELD_TYPES = [
  'text', 'textarea', 'bool', 'multi', 'single', 'int', 'float',
  'file', 'files', 'image', 'images', 'date', 'country', 'address',
] as const;
type FieldType = (typeof FIELD_TYPES)[number];
const FILE_TYPES = new Set<FieldType>(['file', 'files', 'image', 'images']);
/** Names the link and the subject template already use; a question may not take them.
 *  链接与主题模板已经占用的名字;题目不得再用。 */
const RESERVED_KEYS = new Set(['name', 'email', 'sender', 'form', 'version', 'lang']);
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const OPT_RE = /^[A-Za-z0-9_-]{1,40}$/;

interface FieldOption { value: string; label: string; help: string }
interface Field {
  key: string;
  type: FieldType;
  label: string;
  help: string;
  required: boolean;
  options: FieldOption[];
}
/** Everything the person filling the form sees, plus the subject their answer will carry. This
 *  is what a version is a version of.
 *  填表的人会看到的一切,加上他的答复将带着的主题。版本号数的就是它。 */
interface Spec {
  kind: string;
  title: string;
  description: string;
  audience: string;
  verify_email: boolean;
  src_lang: string;
  langs: string[];
  fields: Field[];
  subject_tpl: string;
}
interface I18n {
  /** The designer's text at the time of the last translation, by path / 上次翻译时设计者的文本,按路径 */
  src: Record<string, string>;
  /** Translations by language, then path / 译文,先按语言再按路径 */
  tr: Record<string, Record<string, string>>;
}

const str = (v: unknown, max: number) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

/** Read a design off the wire, refusing anything malformed. Throws e_form_bad_spec with a hint.
 *  从请求里读出一份设计,拒绝任何畸形的东西。抛 e_form_bad_spec 并附提示。 */
function cleanSpec(body: any): Spec {
  const bad = (what: string): never => { throw new HttpError(400, 'e_form_bad_spec', what); };
  const kind = String(body.kind || 'survey');
  if (!KINDS.has(kind)) bad('kind');
  const title = str(body.title, 200);
  if (!title) bad('title');
  const description = str(body.description, 4000);
  const audience = String(body.audience || 'public');
  if (!AUDIENCES.has(audience)) bad('audience');
  const verify_email = audience === 'public' && !!body.verify_email;
  const src_lang = String(body.src_lang || 'en');
  if (!FORM_LANGS.includes(src_lang)) bad('src_lang');
  const langsIn = Array.isArray(body.langs) ? body.langs.map(String) : [];
  const langs = [src_lang, ...FORM_LANGS.filter((l) => l !== src_lang && langsIn.includes(l))];
  const subject_tpl = str(body.subject_tpl, 300).replace(/\n/g, ' ');

  if (!Array.isArray(body.fields) || body.fields.length > 60) bad('fields');
  const keys = new Set<string>();
  const fields: Field[] = body.fields.map((f: any, i: number) => {
    const key = String(f?.key || '').trim();
    if (!KEY_RE.test(key) || RESERVED_KEYS.has(key)) bad(`fields[${i}].key`);
    if (keys.has(key)) bad(`fields[${i}].key`);
    keys.add(key);
    const type = String(f.type || '') as FieldType;
    if (!(FIELD_TYPES as readonly string[]).includes(type)) bad(`fields[${i}].type`);
    const label = str(f.label, 200);
    if (!label) bad(`fields[${i}].label`);
    const help = str(f.help, 1000);
    let options: FieldOption[] = [];
    if (type === 'single' || type === 'multi') {
      if (!Array.isArray(f.options) || !f.options.length || f.options.length > 50) bad(`fields[${i}].options`);
      const seen = new Set<string>();
      options = f.options.map((o: any, j: number) => {
        const value = String(o?.value || '').trim();
        if (!OPT_RE.test(value) || seen.has(value)) bad(`fields[${i}].options[${j}]`);
        seen.add(value);
        const olabel = str(o.label, 200) || value;
        return { value, label: olabel, help: str(o.help, 500) };
      });
    }
    return { key, type, label, help, required: !!f.required, options };
  });
  return { kind, title, description, audience, verify_email, src_lang, langs, fields, subject_tpl };
}

/** Recipients must be mailboxes of this deployment: an answer is written into an inbox, never
 *  sent anywhere, so an outside address could not receive it. Each is resolved now so the
 *  designer learns of a typo at save time and not from silence later.
 *  接收者必须是本部署的邮箱:答复是写进收件箱的,从不外发,外部地址收不到。
 *  此刻逐个解析,让设计者在保存时就知道拼错了,而不是事后从沉默里知道。 */
async function cleanRecipients(env: Env, body: any): Promise<string[]> {
  const raw: string[] = Array.isArray(body.recipients)
    ? body.recipients.map(String)
    : String(body.recipients || '').split(/[\s,;]+/);
  const out: string[] = [];
  for (const r of raw) {
    const a = normalizeAddr(r);
    if (!a) continue;
    if (!isEmail(a)) throw new HttpError(400, 'e_form_rcpt_invalid', a);
    const mb = await findMailboxByAddress(env, a);
    if (!mb || mb.disabled) throw new HttpError(400, 'e_form_rcpt_not_internal', a);
    if (!out.includes(a)) out.push(a);
    if (out.length > 20) throw new HttpError(400, 'e_form_bad_spec', 'recipients');
  }
  if (!out.length) throw new HttpError(400, 'e_form_no_recipients');
  return out;
}

/** The look the designer had when saving; the fill page opens the same way by default.
 *  设计者保存时的观感;填写页默认以同样的样子打开。 */
function cleanLook(body: any): { theme: string | null; mode: string | null } {
  return {
    theme: String(body.theme || '').slice(0, 32) || null,
    mode: body.mode === 'dark' ? 'dark' : body.mode === 'light' ? 'light' : null,
  };
}

// ---------- Translation ----------
// ---------- 翻译 ----------

/** Every piece of designer-written text, addressed by a path stable across edits.
 *  设计者写下的每一段文本,以一条跨编辑稳定的路径寻址。 */
function srcStrings(spec: Spec): Record<string, string> {
  const out: Record<string, string> = { title: spec.title };
  if (spec.description) out.description = spec.description;
  for (const f of spec.fields) {
    out[`f.${f.key}.label`] = f.label;
    if (f.help) out[`f.${f.key}.help`] = f.help;
    for (const o of f.options) {
      out[`f.${f.key}.o.${o.value}.label`] = o.label;
      if (o.help) out[`f.${f.key}.o.${o.value}.help`] = o.help;
    }
  }
  return out;
}

/**
 * Bring the translations up to date with the design: strings whose source changed, or that a
 * newly added language has never seen, are translated; everything already in hand stays. The
 * source language's own text is never "translated" -- the fill page reads it off the design.
 * Returns the new table and whether anything is still missing.
 *
 * 让译文跟上设计:源文变了的、新加的语言从未见过的,都去翻译;已经在手的原样保留。
 * 源语言自己的文本从不"翻译" —— 填写页直接从设计上读。返回新表,以及是否仍有缺口。
 */
/** The paths of one language that still have no translation / 某种语言里仍没有译文的路径 */
function missingIn(src: Record<string, string>, tr: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(src).filter(([p]) => !tr?.[p]));
}

/**
 * Prune the translations to the design: what is still valid stays, what the source outgrew or
 * a new language never had is left empty for the translation calls that follow. Nothing here
 * asks the model -- a save must return in the time a save takes, and the languages listed as
 * missing are translated one request each, so the designer can watch which one is in flight.
 *
 * 把译文修剪到与设计一致:仍然有效的留下,源文改了或新语言从未有过的留空,等随后的翻译调用来填。
 * 这里不问模型 —— 保存必须在"保存"该花的时间内返回;列出来缺译的语言逐个请求翻译,
 * 设计者才看得见哪一种正在进行。
 */
function pruneI18n(env: Env, spec: Spec, prev: I18n, force: boolean): { i18n: I18n; missing: string[]; status: 'done' | 'pending' | 'off' | 'none' } {
  const src = srcStrings(spec);
  const targets = spec.langs.filter((l) => l !== spec.src_lang);
  const tr: Record<string, Record<string, string>> = {};
  // A change of source language makes every old translation a translation of the wrong thing.
  // 源语言一换,旧译文全成了对错误原文的翻译。
  const srcLangChanged = Object.keys(prev.tr || {}).includes(spec.src_lang);
  for (const l of targets) {
    const old = !force && !srcLangChanged ? (prev.tr?.[l] || {}) : {};
    const keep: Record<string, string> = {};
    for (const [path, text] of Object.entries(src)) {
      if (old[path] && prev.src?.[path] === text) keep[path] = old[path];
    }
    tr[l] = keep;
  }
  const missing = targets.filter((l) => Object.keys(missingIn(src, tr[l])).length > 0);
  const status = !targets.length ? 'none' : !missing.length ? 'done' : aiAvailable(env) ? 'pending' : 'off';
  return { i18n: { src, tr }, missing, status };
}

/** Translate whatever one language still lacks, with the model the administrator configured.
 *  Returns the table with the new strings folded in, and whether that language is now complete.
 *  把一种语言还缺的都翻出来,用管理员配置的模型。返回并入新译文的表,以及这种语言是否已齐。 */
async function translateLang(env: Env, spec: Spec, i18n: I18n, lang: string): Promise<{ i18n: I18n; done: boolean; translated: number }> {
  const src = srcStrings(spec);
  const tr = { ...i18n.tr, [lang]: { ...(i18n.tr[lang] || {}) } };
  const want = missingIn(src, tr[lang]);
  let translated = 0;
  if (Object.keys(want).length) {
    const got = await translateInto(env, lang, want).catch(() => ({}));
    Object.assign(tr[lang], got);
    translated = Object.keys(got).length;
  }
  const done = Object.keys(missingIn(src, tr[lang])).length === 0;
  return { i18n: { src, tr }, done, translated };
}

// ---------- Designer's side ----------
// ---------- 设计者一侧 ----------

export const formsApp = new Hono<Ctx>();
formsApp.use('*', requireAuth);

interface FormRow {
  id: string; token: string; owner_id: string; domain_id: string | null; kind: string; title: string;
  description: string; audience: string; verify_email: number; src_lang: string; langs_json: string;
  fields_json: string; i18n_json: string; subject_tpl: string; recipients_json: string;
  theme: string | null; mode: string | null; version: number; disabled: number; submissions: number;
  last_submit_at: number | null; created_at: number; updated_at: number;
  /** Where answers go: mail | store | both (see migration 0038) / 答复去哪儿:mail | store | both(见 0038 迁移) */
  store: string;
}

const STORE_MODES = new Set(['mail', 'store', 'both']);
const storeOf = (v: unknown): string => (STORE_MODES.has(String(v)) ? String(v) : 'mail');

function specOf(row: FormRow): Spec {
  return {
    kind: row.kind, title: row.title, description: row.description, audience: row.audience,
    verify_email: !!row.verify_email, src_lang: row.src_lang,
    langs: jsonTry<string[]>(row.langs_json, []), fields: jsonTry<Field[]>(row.fields_json, []),
    subject_tpl: row.subject_tpl || '',
  };
}

function i18nOf(row: FormRow): I18n {
  const o = jsonTry<any>(row.i18n_json, {});
  return { src: o?.src || {}, tr: o?.tr || {} };
}

/** The fill page's address on the host the designer is visiting. Built from the Host header
 *  rather than c.req.url: under wrangler dev the URL carries the first configured route's host
 *  while the browser is on localhost, and a link nobody can open is worse than none.
 *  填写页在设计者所访问主机上的地址。用 Host 头而不是 c.req.url 来拼:wrangler dev 下 URL 里
 *  写的是配置里第一条路由的主机,而浏览器其实在 localhost —— 一条谁也打不开的链接不如没有。 */
const linkOf = (c: any, token: string) => {
  const proto = new URL(c.req.url).protocol || 'https:';
  const host = c.req.header('Host') || new URL(c.req.url).host;
  return `${proto}//${host}/#/f/${token}`;
};

function summary(c: any, row: FormRow) {
  return {
    id: row.id, token: row.token, link: linkOf(c, row.token), kind: row.kind, title: row.title,
    audience: row.audience, verify_email: !!row.verify_email, disabled: !!row.disabled,
    version: row.version, submissions: row.submissions, last_submit_at: row.last_submit_at,
    langs: jsonTry<string[]>(row.langs_json, []), src_lang: row.src_lang,
    recipients: jsonTry<string[]>(row.recipients_json, []),
    store: storeOf(row.store),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function full(c: any, row: FormRow) {
  return { ...summary(c, row), ...specOf(row), i18n: i18nOf(row).tr, theme: row.theme, mode: row.mode };
}

async function ownForm(c: any): Promise<FormRow> {
  const row = await c.env.DB.prepare('SELECT * FROM forms WHERE id=?1 AND owner_id=?2')
    .bind(c.req.param('id'), c.get('user').id).first() as FormRow | null;
  if (!row) throw new HttpError(404, 'e_form_not_found');
  return row;
}

/** The company domain a designer's forms belong to. It supplies the sender of verification
 *  codes and the Message-ID of the answer mail. Of the domains the designer has a mailbox in,
 *  the one whose entry host they are working on wins -- a form made on kvs4's site belongs to
 *  kvs4 -- and only somebody with no mailbox there gets their first domain by name.
 *  设计者的表单归属哪个企业域名。它提供验证码的发件域和答复邮件的 Message-ID。
 *  在设计者拥有邮箱的域名里,他正在用的那个入口主机所属的域名胜出 —— 在 kvs4 的站上做的表单
 *  就属于 kvs4 —— 只有在那儿没有邮箱的人,才按名字取第一个。 */
async function ownerDomain(env: Env, userId: string, host: string): Promise<{ id: string; name: string; brand_name: string | null } | null> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT d.id, d.name, d.brand_name FROM grants g JOIN mailboxes mb ON mb.id=g.mailbox_id
       JOIN domains d ON d.id=mb.domain_id WHERE g.user_id=?1 ORDER BY d.name`
  ).bind(userId).all();
  const list = (rows.results || []) as any[];
  const visited = domainFromHost(env, host);
  return list.find((d) => d.name === visited) || list[0] || null;
}

const hostOf = (c: any): string => c.req.header('Host') || new URL(c.req.url).hostname;

formsApp.get('/', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM forms WHERE owner_id=?1 ORDER BY updated_at DESC')
    .bind(c.get('user').id).all();
  return c.json({ forms: (rows.results as any[] || []).map((r) => summary(c, r as FormRow)) });
});

/** The colleagues a designer may name as recipients, for the address field to complete: the
 *  mailboxes of the domains they themselves have a mailbox in. Registered before '/:id' so the
 *  word is not taken for an id.
 *  设计者可以指定为接收者的同事,供地址栏补全:他自己拥有邮箱的那些域名下的邮箱。
 *  注册在 '/:id' 之前,免得这个词被当成 id。 */
formsApp.get('/directory', async (c) => {
  const q = String(c.req.query('q') || '').trim().toLowerCase().slice(0, 64).replace(/[%_]/g, '');
  const rows = await c.env.DB.prepare(
    `SELECT mb.local_part, mb.display_name, d.name AS dn FROM mailboxes mb JOIN domains d ON d.id=mb.domain_id
      WHERE mb.disabled=0
        AND mb.domain_id IN (SELECT m2.domain_id FROM grants g JOIN mailboxes m2 ON m2.id=g.mailbox_id WHERE g.user_id=?1)
        AND (mb.local_part LIKE ?2 OR lower(mb.display_name) LIKE ?3 OR (mb.local_part || '@' || d.name) LIKE ?2)
      ORDER BY d.name, mb.local_part LIMIT 12`
  ).bind(c.get('user').id, `${q}%`, `%${q}%`).all();
  return c.json({
    people: ((rows.results || []) as any[]).map((r) => ({ address: `${r.local_part}@${r.dn}`, name: r.display_name || '' })),
  });
});

formsApp.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<any>();
  const spec = cleanSpec(body);
  const recipients = await cleanRecipients(c.env, body);
  const look = cleanLook(body);
  const dom = await ownerDomain(c.env, user.id, hostOf(c));
  if (spec.audience === 'public' && spec.verify_email && !dom) throw new HttpError(400, 'e_form_no_domain');
  const { i18n, status, missing } = pruneI18n(c.env, spec, { src: {}, tr: {} }, false);
  const id = uid();
  const token = randomToken(18);
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO forms (id, token, owner_id, domain_id, kind, title, description, audience, verify_email, src_lang, langs_json,
         fields_json, i18n_json, subject_tpl, recipients_json, theme, mode, store, version, disabled, submissions, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,1,0,0,?19,?19)`
    ).bind(
      id, token, user.id, dom?.id || null, spec.kind, spec.title, spec.description, spec.audience, spec.verify_email ? 1 : 0,
      spec.src_lang, JSON.stringify(spec.langs), JSON.stringify(spec.fields), JSON.stringify(i18n), spec.subject_tpl,
      JSON.stringify(recipients), look.theme, look.mode, storeOf(body.store), t
    ),
    c.env.DB.prepare('INSERT INTO form_versions (form_id, version, spec_json, created_at) VALUES (?1,1,?2,?3)')
      .bind(id, JSON.stringify(spec), t),
  ]);
  const row = await c.env.DB.prepare('SELECT * FROM forms WHERE id=?1').bind(id).first() as FormRow;
  return c.json({ form: full(c, row), translate: status, missing_langs: missing });
});

formsApp.get('/:id', async (c) => c.json({ form: full(c, await ownForm(c)) }));

formsApp.put('/:id', async (c) => {
  const row = await ownForm(c);
  const body = await c.req.json<any>();
  const spec = cleanSpec(body);
  const recipients = await cleanRecipients(c.env, body);
  const look = cleanLook(body);
  // The domain follows the designer, in case their mailboxes changed since the form was made.
  // 域名跟着设计者走,以防表单建好后他的邮箱变了。
  const dom = await ownerDomain(c.env, row.owner_id, hostOf(c));
  const domainId = dom?.id || row.domain_id;
  if (spec.audience === 'public' && spec.verify_email && !domainId) throw new HttpError(400, 'e_form_no_domain');
  const prevSpec = specOf(row);
  const changed = JSON.stringify(prevSpec) !== JSON.stringify(spec);
  const version = changed ? row.version + 1 : row.version;
  const { i18n, status, missing } = pruneI18n(c.env, spec, i18nOf(row), !!body.retranslate);
  const t = now();
  const stmts = [
    c.env.DB.prepare(
      `UPDATE forms SET domain_id=?2, kind=?3, title=?4, description=?5, audience=?6, verify_email=?7, src_lang=?8, langs_json=?9,
         fields_json=?10, i18n_json=?11, subject_tpl=?12, recipients_json=?13, theme=?14, mode=?15, version=?16, updated_at=?17, store=?18
       WHERE id=?1`
    ).bind(
      row.id, domainId, spec.kind, spec.title, spec.description, spec.audience, spec.verify_email ? 1 : 0, spec.src_lang,
      JSON.stringify(spec.langs), JSON.stringify(spec.fields), JSON.stringify(i18n), spec.subject_tpl,
      JSON.stringify(recipients), look.theme, look.mode, version, t, storeOf(body.store ?? row.store)
    ),
  ];
  if (changed) {
    stmts.push(
      c.env.DB.prepare('INSERT OR REPLACE INTO form_versions (form_id, version, spec_json, created_at) VALUES (?1,?2,?3,?4)')
        .bind(row.id, version, JSON.stringify(spec), t)
    );
  }
  await c.env.DB.batch(stmts);
  const fresh = await c.env.DB.prepare('SELECT * FROM forms WHERE id=?1').bind(row.id).first() as FormRow;
  return c.json({ form: full(c, fresh), translate: status, version_bumped: changed, missing_langs: missing });
});

/** Translate one language of a form -- whatever it still lacks. Called once per language after
 *  a save, by the designer's page, so that each request is short and the page can say which
 *  language it is waiting on.
 *  翻译一份表单的一种语言 —— 它还缺的那些。保存之后由设计者的页面按语言逐个调用,
 *  每个请求都短,页面也就说得出正在等哪一种。 */
formsApp.post('/:id/translate', async (c) => {
  const row = await ownForm(c);
  const body = await c.req.json<any>().catch(() => ({}));
  const spec = specOf(row);
  const lang = String(body.lang || '');
  if (!spec.langs.includes(lang) || lang === spec.src_lang) throw new HttpError(400, 'e_bad_request');
  if (!aiAvailable(c.env)) throw new HttpError(503, 'e_llm_unavailable');
  const { i18n, done, translated } = await translateLang(c.env, spec, i18nOf(row), lang);
  // Fold this language into the row as it is NOW, not as it was when the request began: another
  // language's answer may have landed in between, and writing back the older whole would lose it.
  // 把这种语言并进"此刻"的那一行,而不是请求开始时的那一行:期间可能有另一种语言的答复落地,
  // 把旧的整份写回去会把它弄丢。
  const fresh = (await c.env.DB.prepare('SELECT i18n_json FROM forms WHERE id=?1').bind(row.id).first()) as any;
  const cur = i18nOf({ i18n_json: fresh?.i18n_json || '{}' } as FormRow);
  const merged: I18n = { src: i18n.src, tr: { ...cur.tr, [lang]: i18n.tr[lang] } };
  await c.env.DB.prepare('UPDATE forms SET i18n_json=?2 WHERE id=?1').bind(row.id, JSON.stringify(merged)).run();
  return c.json({ lang, done, translated });
});

formsApp.post('/:id/state', async (c) => {
  const row = await ownForm(c);
  const body = await c.req.json<any>().catch(() => ({}));
  const disabled = body.disabled ? 1 : 0;
  await c.env.DB.prepare('UPDATE forms SET disabled=?2, updated_at=?3 WHERE id=?1').bind(row.id, disabled, now()).run();
  return c.json({ ok: true, disabled: !!disabled });
});

formsApp.delete('/:id', async (c) => {
  const row = await ownForm(c);
  // Kept answers go with the form, files included: a form nobody can open any more has no
  // business leaving its answers behind in the bucket.
  // 保留的答复随表单一起走,文件也在内:一份谁都打不开的表单,没有理由把答复留在桶里。
  const subs = await c.env.DB.prepare('SELECT files_json FROM form_submissions WHERE form_id=?1').bind(row.id).all();
  for (const s of (subs.results || []) as any[]) {
    for (const f of jsonTry<StoredFile[]>(s.files_json, [])) await c.env.RAW.delete(f.r2_key).catch(() => {});
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM form_submissions WHERE form_id=?1').bind(row.id),
    c.env.DB.prepare('DELETE FROM form_codes WHERE form_id=?1').bind(row.id),
    c.env.DB.prepare('DELETE FROM form_versions WHERE form_id=?1').bind(row.id),
    c.env.DB.prepare('DELETE FROM forms WHERE id=?1').bind(row.id),
  ]);
  return c.json({ ok: true });
});

// ---------- Kept answers ----------
// ---------- 保留的答复 ----------

/** One uploaded file of a kept answer, as recorded beside it / 保留的答复里的一个上传文件,记在它旁边 */
interface StoredFile { n: number; key: string; name: string; mime: string; size: number; r2_key: string }

/** Who may read a form's kept answers: the designer, and anybody holding one of the mailboxes
 *  the answers are delivered to -- they already receive every one of them by mail.
 *  谁能读一份表单保留的答复:设计者,以及持有答复送达邮箱的任何人 —— 他们本来就逐封收到。 */
async function readableForm(c: any): Promise<{ row: FormRow; owner: boolean }> {
  const user = c.get('user') as User;
  const row = (await c.env.DB.prepare('SELECT * FROM forms WHERE id=?1').bind(c.req.param('id')).first()) as FormRow | null;
  if (!row) throw new HttpError(404, 'e_form_not_found');
  if (row.owner_id === user.id) return { row, owner: true };
  const rcpts = new Set(jsonTry<string[]>(row.recipients_json, []));
  const mine = await c.env.DB.prepare(
    `SELECT mb.id, mb.local_part, d.name AS dn FROM grants g JOIN mailboxes mb ON mb.id=g.mailbox_id
       JOIN domains d ON d.id=mb.domain_id WHERE g.user_id=?1`
  ).bind(user.id).all();
  for (const m of (mine.results || []) as any[]) {
    if (rcpts.has(`${m.local_part}@${m.dn}`)) return { row, owner: false };
    const al = await c.env.DB.prepare(
      'SELECT a.local_part, d.name AS dn FROM aliases a JOIN domains d ON d.id=a.domain_id WHERE a.mailbox_id=?1'
    ).bind(m.id).all();
    if (((al.results || []) as any[]).some((a) => rcpts.has(`${a.local_part}@${a.dn}`))) return { row, owner: false };
  }
  throw new HttpError(404, 'e_form_not_found');
}

const PAGE = 50;

formsApp.get('/:id/subs', async (c) => {
  const { row, owner } = await readableForm(c);
  const before = Number(c.req.query('before')) || Number.MAX_SAFE_INTEGER;
  const rows = await c.env.DB.prepare(
    `SELECT id, version, sender_name, sender_addr, lang, subject, created_at FROM form_submissions
      WHERE form_id=?1 AND created_at < ?2 ORDER BY created_at DESC LIMIT ?3`
  ).bind(row.id, before, PAGE).all();
  const subs = (rows.results || []) as any[];
  return c.json({ title: row.title, store: storeOf(row.store), can_delete: owner, subs, more: subs.length === PAGE });
});

async function subOf(c: any, formId: string): Promise<any> {
  const sub = await c.env.DB.prepare('SELECT * FROM form_submissions WHERE id=?1 AND form_id=?2')
    .bind(c.req.param('sid'), formId).first();
  if (!sub) throw new HttpError(404, 'e_form_sub_not_found');
  return sub;
}

formsApp.get('/:id/subs/:sid', async (c) => {
  const { row, owner } = await readableForm(c);
  const sub = await subOf(c, row.id);
  // The questions as they stood when this answer was written, so a renamed or removed question
  // still reads against the answer it got.
  // 写下这份答复时题目的样子,好让改过名或已删掉的题目仍能对上它得到的答案。
  const v = (await c.env.DB.prepare('SELECT spec_json FROM form_versions WHERE form_id=?1 AND version=?2')
    .bind(row.id, sub.version).first()) as any;
  const spec = v ? jsonTry<Spec>(v.spec_json, specOf(row)) : specOf(row);
  return c.json({
    title: row.title, can_delete: owner,
    sub: {
      id: sub.id, version: sub.version, sender_name: sub.sender_name, sender_addr: sub.sender_addr, lang: sub.lang,
      local_time: sub.local_time, tz: sub.tz, tz_offset: sub.tz_offset, ip: sub.ip, geo: sub.geo, subject: sub.subject,
      created_at: sub.created_at,
      answers: jsonTry<Record<string, unknown>>(sub.answers_json, {}),
      files: jsonTry<StoredFile[]>(sub.files_json, []).map(({ n, key, name, mime, size }) => ({ n, key, name, mime, size })),
    },
    fields: spec.fields,
  });
});

/** Inline only for the bitmap types a browser can show harmlessly; everything else downloads.
 *  The same line the message viewer's cid endpoint draws, for the same reason: an HTML or SVG
 *  upload rendered inline would run on this origin.
 *  只有浏览器能无害显示的位图类型才内联;其余一律下载。与邮件查看器的 cid 端点划的是同一条线,
 *  理由也相同:内联渲染一个 HTML 或 SVG 上传件,等于让它跑在本源上。 */
const INLINE_IMG = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/;

formsApp.get('/:id/subs/:sid/files/:n', async (c) => {
  const { row } = await readableForm(c);
  const sub = await subOf(c, row.id);
  const f = jsonTry<StoredFile[]>(sub.files_json, []).find((x) => x.n === Number(c.req.param('n')));
  if (!f) throw new HttpError(404, 'e_form_sub_not_found');
  const obj = await c.env.RAW.get(f.r2_key);
  if (!obj) throw new HttpError(404, 'e_form_sub_not_found');
  const inline = INLINE_IMG.test(f.mime);
  const name = encodeURIComponent(f.name);
  return new Response(obj.body, {
    headers: {
      'Content-Type': inline ? f.mime : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

formsApp.delete('/:id/subs/:sid', async (c) => {
  const row = await ownForm(c);
  const sub = await subOf(c, row.id);
  for (const f of jsonTry<StoredFile[]>(sub.files_json, [])) await c.env.RAW.delete(f.r2_key).catch(() => {});
  await c.env.DB.prepare('DELETE FROM form_submissions WHERE id=?1').bind(sub.id).run();
  return c.json({ ok: true });
});

// ---------- The door the link opens ----------
// ---------- 链接打开的那扇门 ----------

export const fillApp = new Hono<Ctx>();

// Disabling and deleting must bite at once; nothing here may be served from a cache.
// 停用与删除必须立刻生效;这里没有任何东西可以从缓存里端出来。
fillApp.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

async function liveForm(c: any): Promise<FormRow> {
  const token = String(c.req.param('token') || '');
  const row = token
    ? (await c.env.DB.prepare('SELECT * FROM forms WHERE token=?1').bind(token).first()) as FormRow | null
    : null;
  if (!row) throw new HttpError(404, 'e_form_not_found');
  return row;
}

function clientIp(c: any): string {
  return String(c.req.header('CF-Connecting-IP') || (c.req.header('X-Forwarded-For') || '').split(',')[0] || '').trim();
}

/** A rolling window per key. The key is a hash, never the thing itself, and stale rows are
 *  swept opportunistically so the table stays small.
 *  按键滚动的窗口。键是哈希,从不是那样东西本身;过期行顺手清扫,表不会长大。 */
async function allow(env: Env, key: string, max: number, windowMs: number): Promise<boolean> {
  const t = now();
  const row = (await env.DB.prepare('SELECT window_at, n FROM form_throttle WHERE key=?1').bind(key).first()) as any;
  if (row && row.window_at > t - windowMs) {
    if (row.n >= max) return false;
    await env.DB.prepare('UPDATE form_throttle SET n=n+1 WHERE key=?1').bind(key).run();
    return true;
  }
  await env.DB.prepare(
    'INSERT INTO form_throttle (key, window_at, n) VALUES (?1,?2,1) ON CONFLICT(key) DO UPDATE SET window_at=?2, n=1'
  ).bind(key, t).run();
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM form_throttle WHERE window_at < ?1').bind(t - 2 * 3600 * 1000).run().catch(() => {});
  }
  return true;
}

const ipKey = async (kind: string, formId: string, ip: string) => `${kind}:${formId}:${await sha256Hex(`${formId}|${ip}`)}`;

/** The best of the form's languages for this browser, read off Accept-Language. The fill page
 *  starts here unless the visitor chose otherwise before.
 *  按 Accept-Language 在表单的语言里挑最合适的。访问者此前没另选过的话,填写页从这里开始。 */
function acceptLang(header: string | undefined, langs: string[], fallback: string): string {
  const prefs = String(header || '').split(',')
    .map((p, i) => {
      const [tag, ...params] = p.trim().split(';');
      const q = params.map((s) => /q=([\d.]+)/.exec(s)).find(Boolean);
      return { tag: tag.toLowerCase(), q: q ? parseFloat(q[1]) : 1, i };
    })
    .filter((p) => p.tag)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const p of prefs) {
    if (p.tag.startsWith('zh')) {
      const tw = /tw|hk|mo|hant/.test(p.tag) ? 'zh-TW' : 'zh-CN';
      if (langs.includes(tw)) return tw;
      const other = tw === 'zh-TW' ? 'zh-CN' : 'zh-TW';
      if (langs.includes(other)) return other;
      continue;
    }
    const hit = langs.find((l) => p.tag.split('-')[0] === l.toLowerCase().split('-')[0]);
    if (hit) return hit;
  }
  return fallback;
}

/** The identity the fill page shows a signed-in member: name and the mailboxes they may answer from.
 *  填写页展示给登录成员的身份:名字,以及他可以用来作答的邮箱。 */
async function memberIdentity(env: Env, user: User) {
  const rows = await env.DB.prepare(
    `SELECT mb.id, mb.local_part, mb.display_name, d.name AS dn FROM grants g JOIN mailboxes mb ON mb.id=g.mailbox_id
       JOIN domains d ON d.id=mb.domain_id WHERE g.user_id=?1 AND mb.disabled=0 ORDER BY d.name, mb.local_part`
  ).bind(user.id).all();
  return {
    name: user.name || '',
    email: user.email,
    mailboxes: (rows.results as any[] || []).map((r) => ({ id: r.id, address: `${r.local_part}@${r.dn}`, display_name: r.display_name || '' })),
  };
}

fillApp.get('/:token', async (c) => {
  const row = await liveForm(c);
  const spec = specOf(row);
  const look = { theme: row.theme, mode: row.mode, kind: row.kind, title: row.title, src_lang: row.src_lang, langs: spec.langs, i18n: i18nOf(row).tr };
  // The company named on the page is the one whose host is being visited, as on every other
  // page; the form's own domain only fills in for a host that is not one of them (localhost).
  // 页面上写的公司是正被访问的那个主机的,与其余每一页相同;
  // 表单自己的域名只在主机不属于任何企业域名时(localhost)顶上。
  const visited = domainFromHost(c.env, c.req.header('Host') || new URL(c.req.url).hostname);
  let brand: any = visited
    ? await c.env.DB.prepare('SELECT brand_name, name FROM domains WHERE name=?1').bind(visited).first()
    : null;
  if (!brand && row.domain_id) {
    brand = await c.env.DB.prepare('SELECT brand_name, name FROM domains WHERE id=?1').bind(row.domain_id).first();
  }
  const brandName = brand?.brand_name || brand?.name || null;
  if (row.disabled) return c.json({ ...look, disabled: true, brand: brandName });
  let me: any = null;
  if (spec.audience === 'internal') {
    const user = await userFromRequest(c);
    if (!user) return c.json({ ...look, need_login: true, audience: 'internal', brand: brandName });
    me = await memberIdentity(c.env, user);
  }
  return c.json({
    ...look,
    disabled: false,
    brand: brandName,
    description: spec.description,
    audience: spec.audience,
    verify_email: spec.verify_email,
    fields: spec.fields,
    version: row.version,
    accept_lang: acceptLang(c.req.header('Accept-Language'), spec.langs, spec.src_lang),
    me,
    dev: c.env.DEV_MODE === '1',
  });
});

// ---- Proving an address ----
// ---- 证明一个地址 ----

const CODE_TTL_MIN = 15;
const CODE_MAX_ATTEMPTS = 5;

/** The verification-code mail, in the language the visitor is filling the form in.
 *  验证码邮件,用访问者填表时所用的语言。 */
const CODE_TPL: Record<string, (code: string, form: string, mins: number) => { subject: string; text: string }> = {
  'zh-CN': (c, f, m) => ({ subject: `验证码:${c}`, text: `你正在填写「${f}」。\n\n验证码:${c}\n\n${m} 分钟内有效。如果这不是你本人的操作,请忽略本邮件。` }),
  'zh-TW': (c, f, m) => ({ subject: `驗證碼:${c}`, text: `你正在填寫「${f}」。\n\n驗證碼:${c}\n\n${m} 分鐘內有效。如果這不是你本人的操作,請忽略本郵件。` }),
  en: (c, f, m) => ({ subject: `Verification code: ${c}`, text: `You are filling in "${f}".\n\nVerification code: ${c}\n\nIt expires in ${m} minutes. If this wasn't you, please ignore this email.` }),
  ja: (c, f, m) => ({ subject: `確認コード: ${c}`, text: `「${f}」に回答しています。\n\n確認コード: ${c}\n\n${m} 分間有効です。心当たりがない場合はこのメールを無視してください。` }),
  ko: (c, f, m) => ({ subject: `인증 코드: ${c}`, text: `"${f}"을(를) 작성하고 있습니다.\n\n인증 코드: ${c}\n\n${m}분간 유효합니다. 본인이 아니라면 이 메일을 무시하세요.` }),
  de: (c, f, m) => ({ subject: `Bestätigungscode: ${c}`, text: `Du füllst gerade „${f}“ aus.\n\nBestätigungscode: ${c}\n\nGültig für ${m} Minuten. Falls du das nicht warst, ignoriere diese E-Mail.` }),
  fr: (c, f, m) => ({ subject: `Code de vérification : ${c}`, text: `Vous remplissez « ${f} ».\n\nCode de vérification : ${c}\n\nValable ${m} minutes. Si ce n'est pas vous, ignorez cet e-mail.` }),
  es: (c, f, m) => ({ subject: `Código de verificación: ${c}`, text: `Estás rellenando «${f}».\n\nCódigo de verificación: ${c}\n\nCaduca en ${m} minutos. Si no has sido tú, ignora este correo.` }),
  ru: (c, f, m) => ({ subject: `Код подтверждения: ${c}`, text: `Вы заполняете «${f}».\n\nКод подтверждения: ${c}\n\nДействует ${m} минут. Если это были не вы, проигнорируйте письмо.` }),
};

fillApp.post('/:token/code', async (c) => {
  const row = await liveForm(c);
  if (row.disabled) throw new HttpError(409, 'e_form_disabled');
  if (row.audience !== 'public' || !row.verify_email) throw new HttpError(400, 'e_bad_request');
  const body = await c.req.json<any>().catch(() => ({}));
  const email = normalizeAddr(String(body.email || ''));
  if (!isEmail(email)) throw new HttpError(400, 'e_bad_email');
  const lang = FORM_LANGS.includes(String(body.lang)) ? String(body.lang) : row.src_lang;
  const t = now();
  // Sent less than a minute ago: hand back the same session rather than mailing again.
  // 一分钟内刚发过:交回同一个会话,而不是再寄一封。
  const prior = (await c.env.DB.prepare(
    'SELECT id, created_at FROM form_codes WHERE form_id=?1 AND email=?2 AND verified=0 ORDER BY created_at DESC LIMIT 1'
  ).bind(row.id, email).first()) as any;
  if (prior && prior.created_at > t - 60 * 1000) return c.json({ code_id: prior.id, expires_min: CODE_TTL_MIN });
  // Two windows, so an open link cannot be turned into a relay for mailing codes to strangers:
  // per address, and per visitor.
  // 两道窗口,让一条开放链接不能被当成"给陌生人发验证码"的中继:按地址一道,按访问者一道。
  const perEmail = (await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM form_codes WHERE form_id=?1 AND email=?2 AND created_at > ?3'
  ).bind(row.id, email, t - 3600 * 1000).first()) as any;
  if ((perEmail?.n || 0) >= 5) throw new HttpError(429, 'e_form_rate_limited');
  if (!(await allow(c.env, await ipKey('c', row.id, clientIp(c)), 20, 3600 * 1000))) throw new HttpError(429, 'e_form_rate_limited');

  const dom = row.domain_id
    ? ((await c.env.DB.prepare('SELECT name, brand_name FROM domains WHERE id=?1').bind(row.domain_id).first()) as any)
    : null;
  if (!dom?.name) throw new HttpError(500, 'e_no_send_domain');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const id = uid();
  await c.env.DB.prepare('DELETE FROM form_codes WHERE form_id=?1 AND email=?2 AND verified=0').bind(row.id, email).run();
  await c.env.DB.prepare(
    'INSERT INTO form_codes (id, form_id, email, code_hash, attempts, verified, created_at, expires_at) VALUES (?1,?2,?3,?4,0,0,?5,?6)'
  ).bind(id, row.id, email, await sha256Hex(code), t, t + CODE_TTL_MIN * 60 * 1000).run();
  const tpl = (CODE_TPL[lang] || CODE_TPL.en)(code, row.title, CODE_TTL_MIN);
  const sent = await sendSystemMail(c.env, dom.name, email, tpl.subject, tpl.text);
  if (!sent.ok) {
    await c.env.DB.prepare('DELETE FROM form_codes WHERE id=?1').bind(id).run();
    return c.json(E('e_code_send_failed', sent.error || 'e_unknown'), 502);
  }
  return c.json({ code_id: id, expires_min: CODE_TTL_MIN, dev_code: c.env.DEV_MODE === '1' ? code : undefined });
});

fillApp.post('/:token/verify', async (c) => {
  const row = await liveForm(c);
  const body = await c.req.json<any>().catch(() => ({}));
  const id = String(body.code_id || '');
  const code = String(body.code || '').trim();
  const rec = (await c.env.DB.prepare('SELECT * FROM form_codes WHERE id=?1 AND form_id=?2').bind(id, row.id).first()) as any;
  if (!rec) throw new HttpError(400, 'e_verify_session_gone');
  if (rec.expires_at < now()) {
    await c.env.DB.prepare('DELETE FROM form_codes WHERE id=?1').bind(id).run();
    throw new HttpError(400, 'e_code_expired');
  }
  if (rec.attempts >= CODE_MAX_ATTEMPTS) {
    await c.env.DB.prepare('DELETE FROM form_codes WHERE id=?1').bind(id).run();
    throw new HttpError(429, 'e_code_attempts');
  }
  if ((await sha256Hex(code)) !== rec.code_hash) {
    await c.env.DB.prepare('UPDATE form_codes SET attempts=attempts+1 WHERE id=?1').bind(id).run();
    throw new HttpError(400, 'e_code_wrong');
  }
  await c.env.DB.prepare('UPDATE form_codes SET verified=1 WHERE id=?1').bind(id).run();
  return c.json({ ok: true });
});

// ---- The answers ----
// ---- 答复 ----

/** Raw bytes of files in one submission. Nothing here goes through a sending channel, so the
 *  3.6MB mail ceiling does not apply; what does is the Worker's memory, with room to spare.
 *  一次提交里文件的原始字节。这里的东西不经过发信通道,3.6MB 的邮件上限不适用;
 *  适用的是 Worker 的内存,留了余量。 */
const MAX_FILES_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_FIELD = 10;
const MAX_TEXT = 500;
const MAX_TEXTAREA = 20000;

/** The wording of the answer mail's own labels, in the designer's language: the mail is read
 *  by the designer's colleagues, not by the person who filled the form.
 *  答复邮件自己那些标签的措辞,用设计者的语言:读这封邮件的是设计者的同事,不是填表的人。 */
const ML: Record<string, Record<string, string>> = {
  en: { survey: 'Survey', feedback: 'Feedback', by: 'Submitted by', at: 'Local time', tz: 'Time zone', utc: 'Received (UTC)', ip: 'IP address', loc: 'Location', ver: 'Form version', lang: 'Filled in', yes: 'Yes', no: 'No', files: 'file(s)', none: '—', unknown: 'unknown' },
  'zh-CN': { survey: '问卷', feedback: '反馈', by: '提交人', at: '本地时间', tz: '时区', utc: '接收时间(UTC)', ip: 'IP 地址', loc: '位置', ver: '表单版本', lang: '填写语言', yes: '是', no: '否', files: '个文件', none: '—', unknown: '未知' },
  'zh-TW': { survey: '問卷', feedback: '回饋', by: '提交人', at: '本地時間', tz: '時區', utc: '接收時間(UTC)', ip: 'IP 位址', loc: '位置', ver: '表單版本', lang: '填寫語言', yes: '是', no: '否', files: '個檔案', none: '—', unknown: '未知' },
  ja: { survey: 'アンケート', feedback: 'フィードバック', by: '送信者', at: '現地時間', tz: 'タイムゾーン', utc: '受信時刻(UTC)', ip: 'IP アドレス', loc: '場所', ver: 'フォームのバージョン', lang: '記入言語', yes: 'はい', no: 'いいえ', files: '件のファイル', none: '—', unknown: '不明' },
  ko: { survey: '설문', feedback: '피드백', by: '제출자', at: '현지 시간', tz: '시간대', utc: '수신 시각(UTC)', ip: 'IP 주소', loc: '위치', ver: '양식 버전', lang: '작성 언어', yes: '예', no: '아니요', files: '개 파일', none: '—', unknown: '알 수 없음' },
  de: { survey: 'Umfrage', feedback: 'Feedback', by: 'Eingereicht von', at: 'Ortszeit', tz: 'Zeitzone', utc: 'Eingang (UTC)', ip: 'IP-Adresse', loc: 'Standort', ver: 'Formularversion', lang: 'Ausgefüllt in', yes: 'Ja', no: 'Nein', files: 'Datei(en)', none: '—', unknown: 'unbekannt' },
  fr: { survey: 'Enquête', feedback: 'Retour', by: 'Envoyé par', at: 'Heure locale', tz: 'Fuseau horaire', utc: 'Reçu (UTC)', ip: 'Adresse IP', loc: 'Lieu', ver: 'Version du formulaire', lang: 'Rempli en', yes: 'Oui', no: 'Non', files: 'fichier(s)', none: '—', unknown: 'inconnu' },
  es: { survey: 'Encuesta', feedback: 'Comentarios', by: 'Enviado por', at: 'Hora local', tz: 'Zona horaria', utc: 'Recibido (UTC)', ip: 'Dirección IP', loc: 'Ubicación', ver: 'Versión del formulario', lang: 'Rellenado en', yes: 'Sí', no: 'No', files: 'archivo(s)', none: '—', unknown: 'desconocido' },
  ru: { survey: 'Опрос', feedback: 'Отзыв', by: 'Отправитель', at: 'Местное время', tz: 'Часовой пояс', utc: 'Получено (UTC)', ip: 'IP-адрес', loc: 'Местоположение', ver: 'Версия формы', lang: 'Язык заполнения', yes: 'Да', no: 'Нет', files: 'файл(ов)', none: '—', unknown: 'неизвестно' },
};

/** The link line of a message whose answer is kept in CFMail, in the designer's language.
 *  答复留在 CFMail 里时邮件里那一行链接,用设计者的语言。 */
const ML_OPEN: Record<string, { open: string; kept: string }> = {
  en: { open: 'Open this answer', kept: 'The complete answer is kept in the backend database.' },
  'zh-CN': { open: '打开这份答复', kept: '完整答复保存在后台数据库中。' },
  'zh-TW': { open: '開啟這份回覆', kept: '完整回覆保存在後台資料庫中。' },
  ja: { open: 'この回答を開く', kept: '回答の全文はバックエンドのデータベースに保存されています。' },
  ko: { open: '이 답변 열기', kept: '전체 답변은 백엔드 데이터베이스에 보관되어 있습니다.' },
  de: { open: 'Diese Antwort öffnen', kept: 'Die vollständige Antwort ist in der Backend-Datenbank gespeichert.' },
  fr: { open: 'Ouvrir cette réponse', kept: 'La réponse complète est conservée dans la base de données.' },
  es: { open: 'Abrir esta respuesta', kept: 'La respuesta completa se conserva en la base de datos.' },
  ru: { open: 'Открыть этот ответ', kept: 'Полный ответ хранится в базе данных.' },
};

const escHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
const nl2br = (s: string) => escHtml(s).replace(/\n/g, '<br>');

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** UTC+08:00 from the browser's offset in minutes (east positive). */
/** 由浏览器给的分钟偏移(东为正)得到 UTC+08:00。 */
function fmtOffset(min: number): string {
  if (!Number.isFinite(min)) return '';
  const sign = min >= 0 ? '+' : '-';
  const a = Math.abs(Math.round(min));
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function safeFilename(name: string): string {
  const n = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return n || 'file';
}

interface Incoming { name: string; mime: string; data: Uint8Array }
type Answer =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'bool'; on: boolean }
  | { kind: 'opts'; labels: string[] }
  | { kind: 'num'; text: string }
  | { kind: 'lines'; lines: string[] }
  | { kind: 'files'; files: Incoming[] };

/** Check one answer against its question. Throws with the question's label so the person is
 *  told which one, in words they saw.
 *  按题目校验一个答案。抛错时带上题目的标签,让人知道是哪一题 —— 用他见过的措辞。 */
function readAnswer(f: Field, raw: unknown, files: Incoming[]): Answer {
  const required = (): never => { throw new HttpError(400, 'e_form_field_required', f.label); };
  const invalid = (): never => { throw new HttpError(400, 'e_form_field_invalid', f.label); };
  const s = raw == null ? '' : typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : '';
  switch (f.type) {
    case 'text': {
      const v = s.replace(/[\r\n]+/g, ' ').trim();
      if (v.length > MAX_TEXT) invalid();
      if (!v) return f.required ? required() : { kind: 'empty' };
      return { kind: 'text', text: v };
    }
    case 'textarea': {
      const v = s.replace(/\r\n?/g, '\n').trim();
      if (v.length > MAX_TEXTAREA) invalid();
      if (!v) return f.required ? required() : { kind: 'empty' };
      return { kind: 'text', text: v };
    }
    case 'bool': {
      // Three states. "No" is an answer; only silence is refused when the question is required.
      // 三态。"否"是一个答案;必填时被拒绝的只有没作答。
      const v = s.trim().toLowerCase();
      if (raw === true || ['1', 'true', 'on', 'yes'].includes(v)) return { kind: 'bool', on: true };
      if (raw === false || ['0', 'false', 'off', 'no'].includes(v)) return { kind: 'bool', on: false };
      return f.required ? required() : { kind: 'empty' };
    }
    case 'single': {
      if (!s) return f.required ? required() : { kind: 'empty' };
      const o = f.options.find((x) => x.value === s);
      if (!o) invalid();
      return { kind: 'opts', labels: [o!.label] };
    }
    case 'multi': {
      const arr = Array.isArray(raw) ? raw.map(String) : s ? s.split(',') : [];
      const picked = f.options.filter((o) => arr.includes(o.value));
      if (picked.length !== new Set(arr).size) invalid();
      if (!picked.length) return f.required ? required() : { kind: 'empty' };
      return { kind: 'opts', labels: picked.map((o) => o.label) };
    }
    case 'int': {
      const v = s.trim();
      if (!v) return f.required ? required() : { kind: 'empty' };
      if (!/^-?\d{1,15}$/.test(v)) invalid();
      return { kind: 'num', text: String(parseInt(v, 10)) };
    }
    case 'float': {
      const v = s.trim().replace(',', '.');
      if (!v) return f.required ? required() : { kind: 'empty' };
      const n = Number(v);
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) || !Number.isFinite(n)) invalid();
      return { kind: 'num', text: String(n) };
    }
    case 'date': {
      const v = s.trim();
      if (!v) return f.required ? required() : { kind: 'empty' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) invalid();
      return { kind: 'text', text: v };
    }
    case 'country': {
      const v = s.trim().toUpperCase();
      if (!v) return f.required ? required() : { kind: 'empty' };
      if (!isCountry(v)) invalid();
      return { kind: 'text', text: countryLabel(v) };
    }
    case 'address': {
      const a: any = raw && typeof raw === 'object' ? raw : {};
      const part = (k: string, max = 200) => String(a[k] ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
      const line1 = part('line1'), line2 = part('line2'), city = part('city', 120), state = part('state', 120), postal = part('postal', 40);
      const country = part('country', 2).toUpperCase();
      if (country && !isCountry(country)) invalid();
      const lines = [line1, line2, [city, state, postal].filter(Boolean).join(', '), country ? countryLabel(country) : ''].filter(Boolean);
      if (!lines.length) return f.required ? required() : { kind: 'empty' };
      if (f.required && !line1) required();
      return { kind: 'lines', lines };
    }
    case 'file': case 'files': case 'image': case 'images': {
      const single = f.type === 'file' || f.type === 'image';
      const image = f.type === 'image' || f.type === 'images';
      if (files.length > (single ? 1 : MAX_FILES_PER_FIELD)) invalid();
      if (image && files.some((x) => !/^image\//.test(x.mime))) invalid();
      if (!files.length) return f.required ? required() : { kind: 'empty' };
      return { kind: 'files', files };
    }
  }
  return { kind: 'empty' };
}

/** The subject, from the designer's template. {sender} {email} {form} {version} and the key of
 *  any short-text or number question; anything else is left blank rather than printed raw.
 *  主题,按设计者的模板。{sender} {email} {form} {version} 以及任何短文本/数字题的 key;
 *  其余占位符留空,而不是原样打印。 */
function renderSubject(spec: Spec, sender: Addr, values: Record<string, Answer>, version: number): string {
  const vars: Record<string, string> = {
    sender: sender.name || sender.addr, email: sender.addr, form: spec.title, version: String(version),
  };
  for (const f of spec.fields) {
    if (!['text', 'int', 'float', 'date', 'single', 'country'].includes(f.type)) continue;
    const a = values[f.key];
    vars[f.key] = a?.kind === 'text' || a?.kind === 'num' ? a.text : a?.kind === 'opts' ? a.labels.join(', ') : '';
  }
  const tpl = spec.subject_tpl || `{form} - {sender}`;
  const out = tpl.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, k) => (k in vars ? vars[k].replace(/\s+/g, ' ').slice(0, 80) : ''));
  return out.replace(/\s+/g, ' ').trim().slice(0, 300) || spec.title;
}

fillApp.post('/:token/submit', async (c) => {
  const row = await liveForm(c);
  if (row.disabled) throw new HttpError(409, 'e_form_disabled');
  const len = parseInt(c.req.header('Content-Length') || '0', 10);
  if (len > MAX_FILES_BYTES + 512 * 1024) throw new HttpError(413, 'e_form_too_big', fmtBytes(MAX_FILES_BYTES));
  const ip = clientIp(c);
  if (!(await allow(c.env, await ipKey('s', row.id, ip), 30, 3600 * 1000))) throw new HttpError(429, 'e_form_rate_limited');

  const fd = await c.req.formData().catch(() => null);
  if (!fd) throw new HttpError(400, 'e_bad_request');
  const meta = jsonTry<any>(String(fd.get('meta') || ''), null);
  if (!meta || typeof meta !== 'object') throw new HttpError(400, 'e_bad_request');

  // The design as the person saw it. A version that no longer exists means the client is lying;
  // fall back to the current one rather than refuse.
  // 那个人看到的那份设计。版本不存在说明客户端在胡说;退回当前版本,而不是拒绝。
  let version = Number(meta.version) || row.version;
  let spec = specOf(row);
  if (version !== row.version) {
    const v = (await c.env.DB.prepare('SELECT spec_json FROM form_versions WHERE form_id=?1 AND version=?2').bind(row.id, version).first()) as any;
    if (v) spec = jsonTry<Spec>(v.spec_json, spec);
    else version = row.version;
  }

  // Who is answering.
  // 谁在作答。
  let sender: Addr;
  let user: User | null = null;
  if (spec.audience === 'internal') {
    user = await userFromRequest(c);
    if (!user) throw new HttpError(401, 'e_form_login');
    const ident = await memberIdentity(c.env, user);
    const want = String(meta.sender?.mailbox_id || '');
    const mb = ident.mailboxes.find((m) => m.id === want) || ident.mailboxes[0];
    const name = String(meta.sender?.name || '').trim().slice(0, 80) || user.name || (mb?.display_name ?? '');
    sender = { name, addr: mb ? mb.address : user.email };
  } else {
    const name = String(meta.sender?.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    const addr = normalizeAddr(String(meta.sender?.email || ''));
    if (!name) throw new HttpError(400, 'e_form_name_required');
    if (!isEmail(addr)) throw new HttpError(400, 'e_bad_email');
    if (spec.verify_email) {
      const id = String(meta.code_id || '');
      const rec = (await c.env.DB.prepare('SELECT * FROM form_codes WHERE id=?1 AND form_id=?2').bind(id, row.id).first()) as any;
      if (!rec || !rec.verified || rec.email !== addr || rec.expires_at < now()) throw new HttpError(403, 'e_form_verify_required');
      await c.env.DB.prepare('DELETE FROM form_codes WHERE id=?1').bind(id).run();
    }
    sender = { name, addr };
  }

  // The answers, question by question, files included.
  // 逐题读答案,文件在内。
  const valuesIn: Record<string, unknown> = meta.values && typeof meta.values === 'object' ? meta.values : {};
  const values: Record<string, Answer> = {};
  let fileBytes = 0;
  for (const f of spec.fields) {
    let files: Incoming[] = [];
    if (FILE_TYPES.has(f.type)) {
      for (const part of fd.getAll(`f_${f.key}`)) {
        if (!(part instanceof File)) continue;
        if (!part.size) continue;
        fileBytes += part.size;
        if (fileBytes > MAX_FILES_BYTES) throw new HttpError(413, 'e_form_too_big', fmtBytes(MAX_FILES_BYTES));
        files.push({ name: safeFilename(part.name), mime: part.type || 'application/octet-stream', data: new Uint8Array(await part.arrayBuffer()) });
      }
    }
    values[f.key] = readAnswer(f, valuesIn[f.key], files);
  }

  // Where and when, as far as can be said. The location is Cloudflare's reading of the address;
  // the local time is the browser's own word.
  // 何时何地,能说多少说多少。位置是 Cloudflare 对这个地址的判读;本地时间是浏览器自己的说法。
  const cf: any = (c.req.raw as any).cf || {};
  const geo = [cf.country, cf.region, cf.city].filter(Boolean).map(String);
  const m = ML[spec.src_lang] || ML.en;
  const localTime = String(meta.local_time || '').replace(/[\r\n]+/g, ' ').slice(0, 80);
  const tzName = String(meta.tz || '').replace(/[^\w/+\-]/g, '').slice(0, 64);
  const tzOff = fmtOffset(Number(meta.tz_offset));
  const filledIn = FORM_LANGS.includes(String(meta.lang)) ? String(meta.lang) : spec.src_lang;
  const receivedUtc = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  // The mail itself.
  // 邮件本身。
  const inline: MimeAttachment[] = [];
  const atts: MimeAttachment[] = [];
  const cell = 'padding:8px 10px;border-top:1px solid #cfcfcf;vertical-align:top;';
  const rows: string[] = [];
  const textLines: string[] = [];
  for (const f of spec.fields) {
    const a = values[f.key];
    let html = escHtml(m.none);
    let text = m.none;
    switch (a.kind) {
      case 'text': html = nl2br(a.text); text = a.text; break;
      case 'num': html = escHtml(a.text); text = a.text; break;
      case 'bool': html = a.on ? `&#10003; ${escHtml(m.yes)}` : `&#10007; ${escHtml(m.no)}`; text = a.on ? m.yes : m.no; break;
      case 'opts':
        html = a.labels.length > 1 ? `<ul style="margin:0;padding-left:18px">${a.labels.map((l) => `<li>${escHtml(l)}</li>`).join('')}</ul>` : escHtml(a.labels[0]);
        text = a.labels.join(', ');
        break;
      case 'lines': html = a.lines.map(escHtml).join('<br>'); text = a.lines.join(', '); break;
      case 'files': {
        const parts: string[] = [];
        for (const file of a.files) {
          if (/^image\//.test(file.mime)) {
            const cid = `${uid()}@form`;
            inline.push({ filename: file.name, mime: file.mime, data: file.data, cid });
            parts.push(`<div style="margin:4px 0"><img src="cid:${cid}" alt="${escHtml(file.name)}" style="max-width:100%;max-height:480px;display:block"><span style="font-size:12px;opacity:.7">${escHtml(file.name)} (${fmtBytes(file.data.byteLength)})</span></div>`);
          } else {
            atts.push({ filename: file.name, mime: file.mime, data: file.data });
            parts.push(`<div>&#128206; ${escHtml(file.name)} <span style="font-size:12px;opacity:.7">(${fmtBytes(file.data.byteLength)})</span></div>`);
          }
        }
        html = parts.join('');
        text = a.files.map((x) => `${x.name} (${fmtBytes(x.data.byteLength)})`).join(', ');
        break;
      }
    }
    rows.push(`<tr><td style="${cell}width:34%;opacity:.75">${escHtml(f.label)}</td><td style="${cell}">${html}</td></tr>`);
    textLines.push(`${f.label}: ${text}`);
  }
  const senderLine = sender.name ? `${sender.name} <${sender.addr}>` : sender.addr;
  const metaRows: [string, string][] = [
    [m.by, senderLine],
    [m.at, localTime ? `${localTime}${tzName || tzOff ? ` (${[tzName, tzOff].filter(Boolean).join(', ')})` : ''}` : m.unknown],
    [m.utc, receivedUtc],
    [m.ip, ip || m.unknown],
    [m.loc, geo.length ? geo.join(', ') : m.unknown],
    [m.ver, String(version)],
    [m.lang, filledIn],
  ];
  const kindLabel = m[spec.kind] || spec.kind;
  const subject = renderSubject(spec, sender, values, version);

  // Keeping the answer, when the form says so: the files into the bucket, one object each, and
  // the answers into a row that points at them by number. Done before the mail is composed so
  // the mail can carry the link.
  // 表单要求保留时就保留:文件进桶,一个文件一个对象;答案进一行,按序号指向它们。
  // 放在组邮件之前,好让邮件带上链接。
  const mode = storeOf(row.store);
  let link = '';
  if (mode !== 'mail') {
    const subId = uid();
    const fileRecs: StoredFile[] = [];
    const stored: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const a = values[f.key];
      if (a.kind !== 'files') { stored[f.key] = a; continue; }
      const refs: { n: number; name: string; mime: string; size: number }[] = [];
      for (const file of a.files) {
        const n = fileRecs.length;
        const r2Key = `forms/${row.id}/${subId}/${n}`;
        await c.env.RAW.put(r2Key, file.data);
        fileRecs.push({ n, key: f.key, name: file.name, mime: file.mime, size: file.data.byteLength, r2_key: r2Key });
        refs.push({ n, name: file.name, mime: file.mime, size: file.data.byteLength });
      }
      stored[f.key] = { kind: 'files', files: refs };
    }
    await c.env.DB.prepare(
      `INSERT INTO form_submissions (id, form_id, version, sender_name, sender_addr, lang, local_time, tz, tz_offset, ip, geo,
         answers_json, files_json, subject, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
    ).bind(
      subId, row.id, version, sender.name, sender.addr, filledIn, localTime || null, tzName || null,
      Number.isFinite(Number(meta.tz_offset)) ? Math.round(Number(meta.tz_offset)) : null, ip || null, geo.join(', ') || null,
      JSON.stringify(stored), JSON.stringify(fileRecs), subject, now()
    ).run();
    link = `${new URL(c.req.url).protocol}//${c.req.header('Host') || new URL(c.req.url).host}/#/forms/sub/${row.id}/${subId}`;
  }

  const ml = ML_OPEN[spec.src_lang] || ML_OPEN.en;
  const linkHtml = link
    ? `<p style="margin:0 0 14px"><a href="${escHtml(link)}" style="display:inline-block;padding:7px 14px;border:1px solid #888;border-radius:8px;text-decoration:none;font-weight:600">${escHtml(ml.open)}</a>` +
      (mode === 'store' ? ` <span style="font-size:12.5px;opacity:.75">${escHtml(ml.kept)}</span>` : '') + `</p>`
    : '';
  const linkText = link ? `${ml.open}: ${link}\n${mode === 'store' ? ml.kept + '\n' : ''}\n` : '';
  // In store mode the message is a notice: the link, and who answered when. The answers and
  // the files stay in CFMail and reach nobody's mailbox.
  // store 模式下邮件只是一则通知:链接,以及谁在何时作答。答案与文件留在 CFMail 里,不进任何邮箱。
  const qa = mode === 'store' ? '' :
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;border-bottom:1px solid #cfcfcf">${rows.join('')}</table>`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;max-width:760px">` +
    `<div style="font-size:12px;opacity:.7">${escHtml(kindLabel)} · v${version}</div>` +
    `<h2 style="margin:4px 0 10px;font-size:20px;font-weight:600">${escHtml(spec.title)}</h2>` +
    (spec.description ? `<p style="margin:0 0 14px;opacity:.85">${nl2br(spec.description)}</p>` : '') +
    linkHtml + qa +
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px;font-size:12.5px;opacity:.8">` +
    metaRows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;white-space:nowrap">${escHtml(k)}</td><td style="padding:2px 0">${escHtml(v)}</td></tr>`).join('') +
    `</table></div>`;
  const text =
    `${kindLabel} · v${version}\n${spec.title}\n${spec.description ? spec.description + '\n' : ''}\n` + linkText +
    (mode === 'store' ? '' : textLines.join('\n') + '\n\n') + metaRows.map(([k, v]) => `${k}: ${v}`).join('\n');

  const recipients = jsonTry<string[]>(row.recipients_json, []);
  const dom = row.domain_id
    ? ((await c.env.DB.prepare('SELECT name FROM domains WHERE id=?1').bind(row.domain_id).first()) as any)
    : null;
  const built = buildMime({
    from: sender,
    to: recipients.map((addr) => ({ name: '', addr })),
    replyTo: [sender],
    subject,
    text,
    html,
    inlineImages: mode === 'store' ? [] : inline,
    attachments: mode === 'store' ? [] : atts,
    domain: dom?.name || new URL(c.req.url).hostname,
    headers: { 'X-CFMail-Form': row.token, 'X-CFMail-Form-Version': String(version) },
  });

  // Straight into each recipient's inbox, one copy per mailbox, the way site-internal mail goes.
  // 直接进每个接收者的收件箱,每个邮箱一份,与站内邮件同一条路。
  const seen = new Set<string>();
  let delivered = 0;
  for (const addr of recipients) {
    const mb = await findMailboxByAddress(c.env, addr);
    if (!mb || mb.disabled || seen.has(mb.id)) continue;
    seen.add(mb.id);
    const key = `raw/${uid()}.eml`;
    try {
      await c.env.RAW.put(key, built.raw);
      await ingestEml(c.env, {
        mailboxId: mb.id,
        buf: built.raw.buffer.slice(built.raw.byteOffset, built.raw.byteOffset + built.raw.byteLength) as ArrayBuffer,
        r2Key: key,
        size: built.raw.byteLength,
        folderRole: 'inbox',
        direction: 'in',
        envelopeFrom: sender.addr,
      });
      delivered++;
    } catch (e) {
      console.log('form delivery failed', mb.id, e);
    }
  }
  if (!delivered) throw new HttpError(502, 'e_form_delivery_failed');
  await c.env.DB.prepare('UPDATE forms SET submissions=submissions+1, last_submit_at=?2 WHERE id=?1').bind(row.id, now()).run();
  return c.json({ ok: true, delivered });
});
