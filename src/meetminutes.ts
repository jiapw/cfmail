// What is kept of a meeting: the recording the host made, and what was said.
//
// A small meeting is recorded by the host's own browser, and the file goes into the host's own
// Drive through the door every other upload uses; the server's part is one line in
// meeting_recordings that says "this file is a recording of that sitting". Nothing here ever
// holds the media.
//
// What was said is the one place where sound leaves the browser for somewhere other than the
// people in the room: while a recording runs, the host's browser may also cut the mixed sound
// into pieces of a few minutes and send each here to be put into words by the speech model of the
// meeting's domain -- Workers AI, in the same Cloudflare account. The piece is held for the length
// of that one request and written nowhere. The words go back to the browser that sent the sound,
// and stay there until the recording stops; then the same browser sends the whole text back once,
// for a summary, and files both in the host's Drive itself. The server keeps no transcript: a
// meeting's words exist in the host's Drive and, if the host chooses to send them, in a mail.
//
// An end-to-end encrypted meeting has none of this, because the promise it makes is that nothing
// but the people in it hears it.
//
// 一场会议留下来的东西:主持人录下的那份录像,以及会上说了什么。
//
// 小组会议由主持人自己的浏览器录制,文件经由其他所有上传都走的那扇门进入主持人自己的网盘;
// 服务端做的只是在 meeting_recordings 里记一行"这个文件是那一场的录像"。这里从不持有媒体本身。
//
// "说了什么"是声音离开浏览器、去往会场中人以外之处的唯一场合:录制进行时,主持人的浏览器可以同时
// 把混音切成几分钟一段,逐段送到这里,由会议所属域名的语音模型转成文字 —— Workers AI,
// 在同一个 Cloudflare 账号下。这一段只在那一次请求期间被持有,不写到任何地方。文字回到送来声音的
// 那个浏览器,并留在那里直到录制停止;之后由同一个浏览器把整份文字送回来一次,换取一份摘要,
// 再由它自己把两者存进主持人的网盘。服务端不保存文字稿:一场会议的文字只存在于主持人的网盘里,
// 以及 —— 如果主持人选择发送 —— 一封邮件里。
//
// 端到端加密的会议没有这一切,因为它许下的承诺正是:除了会中的人,没有任何东西听得到它。
import { Hono } from 'hono';
import { transcribe } from 'ai';
import type { Addr, Env, User } from './types';
import { HttpError } from './errors';
import { requireAuth } from './auth';
import { audit } from './audit';
import { queueSend } from './send';
import { aiAvailable, aiComplete } from './llm';
import { getWorkersAI } from './chat/provider';
import { chatDomainById } from './chat/settings';
import { DEFAULT_ASR, DEFAULT_MODEL } from './chat/models';
import { allow, meetReady } from './meet';
import { senderMailbox } from './meetinvite';
import { normalizeAddr, now, uid } from './util';

type Ctx = { Bindings: Env; Variables: { user: User } };

/** One piece of sound, as the browser cuts it: five minutes of mono Opus is about a megabyte.
 *  浏览器切出来的一段声音:五分钟单声道 Opus 大约一兆。 */
const PIECE_MAX = 12 * 1024 * 1024;
/** A whole transcript, as text. Eight hours of fast talk is well under this.
 *  一整份文字稿(文本)。八小时的快语速也远低于此。 */
const TEXT_MAX = 1024 * 1024;
/** How much transcript one question to the model carries. / 向模型提的一个问题里带多少文字稿。 */
const CHUNK_CHARS = 24_000;

export const meetKeepApp = new Hono<Ctx>();
meetKeepApp.use('*', requireAuth);
meetKeepApp.use('*', async (c, next) => {
  if (!meetReady(c.env)) throw new HttpError(503, 'e_meet_unavailable');
  await next();
});

/** A meeting, for somebody who hosts it: its owner, or a colleague invited as co-host.
 *  一场会议,给主持它的人:创建者,或以联席主持人身份受邀的同事。 */
async function hostedMeeting(c: any, id: string): Promise<any> {
  const user = c.get('user') as User;
  const m: any = await c.env.DB.prepare(
    'SELECT m.*, d.name AS domain_name FROM meetings m LEFT JOIN domains d ON d.id=m.domain_id WHERE m.id=?1'
  ).bind(id).first();
  if (!m) throw new HttpError(404, 'e_meet_not_found');
  if (m.owner_id !== user.id) {
    const inv: any = await c.env.DB.prepare(
      'SELECT role FROM meeting_invitees WHERE meeting_id=?1 AND (user_id=?2 OR email=?3)'
    ).bind(m.id, user.id, normalizeAddr(user.email)).first();
    if (inv?.role !== 'cohost') throw new HttpError(403, 'e_meet_forbidden');
  }
  return m;
}


// ---------- The recording ----------
// ---------- 录像 ----------

/** "This file in my Drive is a recording of that meeting." The file is already there -- it came
 *  in through Drive's own upload and was checked against the quota there -- so all that is asked
 *  here is that it is the caller's file.
 *  "我网盘里的这个文件,是那场会议的录像。"文件此时已经在了 —— 它经网盘自己的上传进来,
 *  配额也在那边核对过 —— 所以这里只要求一件事:它是调用者自己的文件。 */
meetKeepApp.post('/:id/recordings', async (c) => {
  const user = c.get('user');
  const m = await hostedMeeting(c, c.req.param('id'));
  if (m.record_mode !== 'local') throw new HttpError(400, 'e_meet_rec_off');
  const body = await c.req.json<any>().catch(() => ({}));
  const node: any = await c.env.DB.prepare(
    "SELECT id FROM drive_nodes WHERE id=?1 AND owner_id=?2 AND kind='file'"
  ).bind(String(body.node_id || ''), user.id).first();
  if (!node) throw new HttpError(400, 'e_bad_request');
  const t = now();
  const started = Math.floor(Number(body.started_at));
  const ended = Math.floor(Number(body.ended_at));
  const okTime = (n: number) => Number.isFinite(n) && n > t - 7 * 86400000 && n <= t + 60000;
  // The sitting it belongs to: the one in progress, or the last one if the room emptied while
  // the file was still on its way up. / 它属于哪一场:进行中的那一场;
  // 如果文件还在上传的路上房间就空了,则是最近的那一场。
  const ses: any = await c.env.DB.prepare(
    'SELECT id FROM meeting_sessions WHERE meeting_id=?1 ORDER BY started_at DESC LIMIT 1'
  ).bind(m.id).first();
  const id = uid();
  await c.env.DB.prepare(
    'INSERT INTO meeting_recordings (id, session_id, kind, node_id, started_at, ended_at) VALUES (?1,?2,?3,?4,?5,?6)'
  ).bind(id, ses?.id || '', 'local', node.id, okTime(started) ? started : t, okTime(ended) ? ended : t).run();
  if (body.transcript_node && ses?.id) {
    const tn: any = await c.env.DB.prepare(
      "SELECT id FROM drive_nodes WHERE id=?1 AND owner_id=?2 AND kind='file'"
    ).bind(String(body.transcript_node), user.id).first();
    if (tn) await c.env.DB.prepare('UPDATE meeting_sessions SET transcript_node=?1 WHERE id=?2').bind(tn.id, ses.id).run();
  }
  await audit(c.env, user, 'meet.record', m.code, { node: node.id }, m.domain_id);
  return c.json({ ok: true, id });
});

/** The minutes alone can be filed too: a meeting whose picture nobody wanted kept.
 *  纪要也可以单独登记:一场没人想留下画面的会议。 */
meetKeepApp.post('/:id/transcript', async (c) => {
  const user = c.get('user');
  const m = await hostedMeeting(c, c.req.param('id'));
  const body = await c.req.json<any>().catch(() => ({}));
  const tn: any = await c.env.DB.prepare(
    "SELECT id FROM drive_nodes WHERE id=?1 AND owner_id=?2 AND kind='file'"
  ).bind(String(body.node_id || ''), user.id).first();
  if (!tn) throw new HttpError(400, 'e_bad_request');
  const ses: any = await c.env.DB.prepare(
    'SELECT id FROM meeting_sessions WHERE meeting_id=?1 ORDER BY started_at DESC LIMIT 1'
  ).bind(m.id).first();
  if (ses?.id) await c.env.DB.prepare('UPDATE meeting_sessions SET transcript_node=?1 WHERE id=?2').bind(tn.id, ses.id).run();
  return c.json({ ok: true });
});

// ---------- Words ----------
// ---------- 文字 ----------

interface Heard { text: string; segments: { start: number; end: number; text: string }[]; language: string }

const TURBO = '@cf/openai/whisper-large-v3-turbo';

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Sound into words. The large model is asked directly rather than through the SDK, for one
 *  switch the SDK does not pass on: voice-activity filtering. A speech model handed a stretch of
 *  silence does not return nothing -- it returns "Thank you." -- and a meeting is full of
 *  stretches of silence. The smaller models have no such switch and go the usual way.
 *  声音变文字。大模型是直接问的,而不经 SDK,为的是 SDK 不转交的一个开关:语音活动过滤。
 *  把一段沉默交给语音模型,它回的不是"空",而是一句 "Thank you." —— 而会议里到处是一段一段的沉默。
 *  小一些的模型没有这个开关,照常走 SDK。 */
async function hear(env: Env, model: string, bytes: Uint8Array): Promise<Heard> {
  if (model !== TURBO) {
    const res = await transcribe({ model: getWorkersAI(env).transcription(model), audio: bytes, maxRetries: 1 });
    return {
      text: String(res.text || '').trim(),
      segments: (res.segments || []).map((s) => ({ start: Number(s.startSecond) || 0, end: Number(s.endSecond) || 0, text: String(s.text || '').trim() })),
      language: res.language || '',
    };
  }
  const input = { audio: base64(bytes), task: 'transcribe', vad_filter: true };
  let out: any;
  if (env.AI_DEV_API_TOKEN && env.AI_DEV_ACCOUNT_ID) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.AI_DEV_ACCOUNT_ID}/ai/run/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.AI_DEV_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || !j?.success) throw new Error(JSON.stringify(j?.errors || r.status).slice(0, 300));
    out = j.result;
  } else {
    if (!env.AI) throw new Error('no AI binding');
    out = await env.AI.run(model as any, input as any);
  }
  return {
    text: String(out?.text || '').trim(),
    segments: (Array.isArray(out?.segments) ? out.segments : []).map((s: any) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() })),
    language: String(out?.transcription_info?.language || ''),
  };
}

/** One piece of sound in, its words out. Held for this request and nowhere after it.
 *  进来一段声音,出去它的文字。只在这一次请求里持有,之后哪儿都不留。 */
meetKeepApp.post('/:id/transcribe', async (c) => {
  const m = await hostedMeeting(c, c.req.param('id'));
  if (m.record_mode !== 'local') throw new HttpError(400, 'e_meet_rec_off');
  if (m.e2ee) throw new HttpError(400, 'e_meet_e2ee_no_minutes');
  if (!aiAvailable(c.env)) throw new HttpError(503, 'e_llm_unavailable');
  // Twelve pieces an hour is a meeting; this many is a meeting and its retries, and no more.
  // 一小时十二段是一场会;这个数是一场会加上它的重试,再多就不是了。
  if (!(await allow(c.env, `tr:${m.id}`, 90, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
  const len = parseInt(c.req.header('Content-Length') || '0', 10);
  if (len > PIECE_MAX) throw new HttpError(413, 'e_meet_piece_too_big');
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, 'e_bad_request');
  if (buf.byteLength > PIECE_MAX) throw new HttpError(413, 'e_meet_piece_too_big');
  const dom = await chatDomainById(c.env, m.domain_id).catch(() => null);
  const model = dom?.asr_model || DEFAULT_ASR;
  let res: Heard;
  try {
    res = await hear(c.env, model, new Uint8Array(buf));
  } catch (e: any) {
    // Silence is not a failure: a piece with nobody talking in it comes back from the model as
    // an error about empty output, and the meeting simply had a quiet five minutes.
    // 沉默不是失败:一段没人说话的声音,模型会以"输出为空"的错误返回,而会议只是安静了五分钟。
    const msg = String(e?.message || e);
    if (/no transcript|empty/i.test(msg)) return c.json({ text: '', segments: [], language: '' });
    console.log('meet transcribe failed', model, msg.slice(0, 300));
    throw new HttpError(502, 'e_meet_transcribe_failed');
  }
  return c.json({ text: res.text, segments: res.segments.filter((s) => s.text), language: res.language });
});

const SUMMARY_SYSTEM =
  'You write the minutes of a meeting from its transcript. The transcript was made by speech recognition: ' +
  'it has no speaker names, and it contains misheard words -- read through them for what was meant. ' +
  'Write in the language the meeting was held in. Use Markdown, with these parts in this order, each under a short heading: ' +
  'a summary of three to six sentences; the main points discussed, as a list; decisions made, as a list; ' +
  'action items, as a list, naming who is to do each one only when the transcript says so. ' +
  'Leave a part out when the transcript has nothing for it. Invent nothing: no names, dates, numbers or decisions that are not in the transcript. ' +
  'Do not mention that this is a transcript or that you are a model. Output only the minutes. /no_think';

const NOTES_SYSTEM =
  'You are taking notes on one part of a long meeting from its transcript, which was made by speech recognition and contains misheard words. ' +
  'In the language the meeting was held in, list what was discussed, what was decided and what was assigned to whom, as terse bullet points. ' +
  'Invent nothing. Output only the bullet points. /no_think';

const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

/** Cut at line ends, so that no sentence is asked about in halves.
 *  在行尾处切,免得把一句话劈成两半去问。 */
function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > size) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line.slice(0, size);
  }
  if (cur) out.push(cur);
  return out;
}

/** The whole text in, a summary out. A long meeting is read a part at a time into notes, and the
 *  minutes are written from the notes -- one question to a model has room for an hour of talk,
 *  not for a day of it.
 *  整份文字进来,一份摘要出去。长会议先一部分一部分地读成笔记,再从笔记写出纪要 ——
 *  向模型提的一个问题装得下一小时的谈话,装不下一整天的。 */
meetKeepApp.post('/:id/minutes', async (c) => {
  const m = await hostedMeeting(c, c.req.param('id'));
  if (m.e2ee) throw new HttpError(400, 'e_meet_e2ee_no_minutes');
  if (!aiAvailable(c.env)) throw new HttpError(503, 'e_llm_unavailable');
  if (!(await allow(c.env, `mn:${m.id}`, 12, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
  const body = await c.req.json<any>().catch(() => ({}));
  const text = String(body.transcript || '').slice(0, TEXT_MAX).trim();
  if (text.length < 40) throw new HttpError(400, 'e_meet_nothing_said');
  const dom = await chatDomainById(c.env, m.domain_id).catch(() => null);
  const model = dom?.default_model || DEFAULT_MODEL;
  const head = m.title ? `Meeting: ${m.title}\n\n` : '';
  const parts = chunks(text, CHUNK_CHARS).slice(0, 24);
  let source = text;
  if (parts.length > 1) {
    const notes: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const n = await aiComplete(c.env, model, NOTES_SYSTEM, `${head}Part ${i + 1} of ${parts.length}:\n\n${parts[i]}`, 90_000).catch((e) => {
        console.log('meet notes failed', model, String(e?.message || e).slice(0, 200));
        return '';
      });
      if (stripThink(n)) notes.push(`## Part ${i + 1}\n${stripThink(n)}`);
    }
    if (!notes.length) throw new HttpError(502, 'e_meet_minutes_failed');
    source = notes.join('\n\n').slice(0, CHUNK_CHARS * 2);
  }
  const answer = await aiComplete(c.env, model, SUMMARY_SYSTEM, head + source, 120_000).catch((e) => {
    console.log('meet minutes failed', model, String(e?.message || e).slice(0, 200));
    return '';
  });
  const summary = stripThink(answer).slice(0, 40_000);
  if (!summary) throw new HttpError(502, 'e_meet_minutes_failed');
  return c.json({ summary, model });
});

// ---------- Sending the minutes ----------
// ---------- 发送纪要 ----------

interface MWords { subject: (t: string) => string; lead: (w: string, t: string) => string; attached: string; untitled: string; file: string }
const MW: Record<string, MWords> = {
  'zh-CN': { subject: (t) => `会议纪要:${t}`, lead: (w, t) => `${w} 发来了会议「${t}」的纪要。纪要由语音识别和模型自动整理,可能有误。`, attached: '完整文字稿见附件。', untitled: '未命名会议', file: '会议纪要' },
  'zh-TW': { subject: (t) => `會議紀要:${t}`, lead: (w, t) => `${w} 寄來了會議「${t}」的紀要。紀要由語音辨識和模型自動整理,可能有誤。`, attached: '完整文字稿見附件。', untitled: '未命名會議', file: '會議紀要' },
  en: { subject: (t) => `Minutes: ${t}`, lead: (w, t) => `${w} sent the minutes of the meeting “${t}”. They were put together automatically by speech recognition and a model, and may contain mistakes.`, attached: 'The full transcript is attached.', untitled: 'Untitled meeting', file: 'Minutes' },
  ja: { subject: (t) => `議事録:${t}`, lead: (w, t) => `${w} さんから会議「${t}」の議事録が届きました。音声認識とモデルによる自動作成のため、誤りを含むことがあります。`, attached: '全文の文字起こしを添付しています。', untitled: '無題の会議', file: '議事録' },
  ko: { subject: (t) => `회의록: ${t}`, lead: (w, t) => `${w} 님이 회의 “${t}”의 회의록을 보냈습니다. 음성 인식과 모델이 자동으로 작성한 것이라 오류가 있을 수 있습니다.`, attached: '전체 녹취록은 첨부 파일을 확인하세요.', untitled: '제목 없는 회의', file: '회의록' },
  de: { subject: (t) => `Protokoll: ${t}`, lead: (w, t) => `${w} hat das Protokoll der Besprechung „${t}“ gesendet. Es wurde automatisch per Spracherkennung und Modell erstellt und kann Fehler enthalten.`, attached: 'Die vollständige Mitschrift ist angehängt.', untitled: 'Unbenannte Besprechung', file: 'Protokoll' },
  fr: { subject: (t) => `Compte rendu : ${t}`, lead: (w, t) => `${w} a envoyé le compte rendu de la réunion « ${t} ». Il a été rédigé automatiquement par reconnaissance vocale et par un modèle, et peut contenir des erreurs.`, attached: 'La transcription complète est jointe.', untitled: 'Réunion sans titre', file: 'Compte rendu' },
  es: { subject: (t) => `Acta: ${t}`, lead: (w, t) => `${w} ha enviado el acta de la reunión «${t}». Se elaboró automáticamente con reconocimiento de voz y un modelo, y puede contener errores.`, attached: 'La transcripción completa va adjunta.', untitled: 'Reunión sin título', file: 'Acta' },
  ru: { subject: (t) => `Протокол: ${t}`, lead: (w, t) => `${w} прислал(а) протокол встречи «${t}». Он составлен автоматически с помощью распознавания речи и модели и может содержать ошибки.`, attached: 'Полная расшифровка — во вложении.', untitled: 'Встреча без названия', file: 'Протокол' },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));

/** The little Markdown a model writes minutes in -- headings, lists, bold -- as HTML a mail
 *  program will show. Everything is escaped first; nothing the model wrote is trusted as markup.
 *  模型写纪要时用到的那一点 Markdown —— 标题、列表、粗体 —— 转成邮件程序能显示的 HTML。
 *  一切先转义;模型写的任何东西都不被当作标记来信任。 */
export function minutesHtml(md: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | '' = '';
  const close = () => { if (list) { out.push(`</${list}>`); list = ''; } };
  const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    let mm: RegExpMatchArray | null;
    if (!line.trim()) { close(); continue; }
    if ((mm = line.match(/^#{1,6}\s+(.*)$/))) { close(); out.push(`<h3 style="margin:16px 0 6px;font-size:15px">${inline(mm[1])}</h3>`); continue; }
    if ((mm = line.match(/^\s*[-*+]\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(mm[1])}</li>`); continue; }
    if ((mm = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(mm[1])}</li>`); continue; }
    close();
    out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return out.join('');
}

/** The minutes, mailed: to everybody who was asked to the meeting and to its organiser, from the
 *  mailbox of whoever made them. Sent only when the host says so, after reading them -- a
 *  speech model's version of what somebody said is not something to put in forty inboxes unread.
 *  把纪要寄出去:寄给所有受邀的人以及组织者,从制作者的邮箱发出。只在主持人读过并明确要发的时候才发 ——
 *  语音模型版本的"某人说了什么",不是一件可以不经过目就放进四十个收件箱的东西。 */
meetKeepApp.post('/:id/minutes/mail', async (c) => {
  const user = c.get('user');
  const m = await hostedMeeting(c, c.req.param('id'));
  if (!(await allow(c.env, `mm:${m.id}`, 6, 3600 * 1000))) throw new HttpError(429, 'e_meet_rate_limited');
  const body = await c.req.json<any>().catch(() => ({}));
  const summary = String(body.summary || '').slice(0, 40_000).trim();
  const markdown = String(body.markdown || '').slice(0, TEXT_MAX);
  if (!summary) throw new HttpError(400, 'e_bad_request');
  const mb = await senderMailbox(c.env, user, m.domain_id, body.mailbox_id ? String(body.mailbox_id) : undefined);
  if (!mb) throw new HttpError(400, 'e_meet_no_mailbox');
  const self = normalizeAddr(`${mb.local_part}@${mb.domain_name}`);

  const inv = await c.env.DB.prepare('SELECT email FROM meeting_invitees WHERE meeting_id=?1 ORDER BY email').bind(m.id).all();
  const owner: any = m.owner_id === user.id ? null : await c.env.DB.prepare('SELECT email, name FROM users WHERE id=?1').bind(m.owner_id).first();
  const seen = new Set<string>();
  const to: Addr[] = [];
  const add = (addr: string, name = '') => {
    const a = normalizeAddr(addr);
    if (!a || seen.has(a)) return;
    seen.add(a);
    to.push({ name, addr: a });
  };
  for (const r of (inv.results || []) as any[]) add(r.email);
  if (owner?.email) add(owner.email, owner.name || '');
  // Nobody was asked: the minutes still go somewhere a person will find them -- their own inbox.
  // 没请过任何人:纪要仍然要去一个人找得到的地方 —— 他自己的收件箱。
  if (!to.length) add(self, user.name || '');

  const lang: any = await c.env.DB.prepare('SELECT lang FROM users WHERE id=?1').bind(user.id).first();
  const w = MW[String(lang?.lang || 'en')] || MW.en;
  const title = m.title || w.untitled;
  const lead = w.lead(user.name || self, title);
  const attachmentIds: string[] = [];
  if (markdown.trim()) {
    const id = uid();
    const key = `uploads/${id}`;
    const bytes = new TextEncoder().encode(markdown);
    await c.env.RAW.put(key, bytes);
    await c.env.DB.prepare('INSERT INTO uploads (id, user_id, filename, mime, size, r2_key, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)')
      .bind(id, user.id, `${w.file}.md`, 'text/markdown', bytes.length, key, now()).run();
    attachmentIds.push(id);
  }
  const tail = attachmentIds.length ? w.attached : '';
  const text = [lead, '', summary, ...(tail ? ['', tail] : [])].join('\n');
  const html = `<p style="color:#666">${esc(lead)}</p>${minutesHtml(summary)}${tail ? `<p style="color:#666">${esc(tail)}</p>` : ''}`;
  await queueSend(c.env, user, mb, { to, cc: [], bcc: [], subject: w.subject(title), text, html, attachmentIds });
  await audit(c.env, user, 'meet.minutes', m.code, { to: to.length }, m.domain_id);
  return c.json({ ok: true, sent: to.length });
});
