// Asking people to a meeting.
//
// An invitation is a piece of mail, and this is a mail system, so it is sent the way mail is sent
// here: from the organiser's own mailbox, through queueSend -- straight into the inbox of anybody
// who has one on this deployment, out through the sending channel for anybody who does not, and
// with a copy in the organiser's Sent like everything else they wrote. Nothing about it is a
// "system notification".
//
// Two mails at most, because there are two kinds of people and they need different links.
// Somebody with an account here comes in as themselves, by the meeting's own link. Somebody
// without one can only come in as a guest, by the guest link -- and only if the meeting lets
// guests in at all, which the caller is told about rather than quietly papering over.
//
// A meeting with a time also carries a calendar file, so that it lands in the calendar of
// whatever the recipient reads mail with.
//
// 请人来开会。
//
// 邀请就是一封邮件,而这里是一个邮件系统,所以它按这里发邮件的方式发出:从组织者自己的邮箱、
// 经 queueSend —— 在这套部署上有邮箱的人,直投收件箱;没有的人,走发信通道;
// 组织者的「已发送」里照例留一份。它没有哪一点是"系统通知"。
//
// 最多两封,因为有两种人,而他们需要不同的链接。在这里有账号的人以本人身份进来,用会议自己的链接。
// 没有账号的人只能以访客身份进来,用访客链接 —— 而且前提是这场会议允许访客;
// 不允许时,会如实告诉调用方,而不是悄悄糊弄过去。
//
// 定了时间的会议还会带一个日历文件,好让它落进收件人读邮件的那个程序的日历里。
import type { Addr, Env, User } from './types';
import type { MailboxRow } from './parse';
import { HttpError } from './errors';
import { queueSend } from './send';
import { normalizeAddr, now, parseAddrList, uid } from './util';

// ---------- Words ----------
// ---------- 措辞 ----------

interface Words {
  subject: (title: string) => string;
  lead: (who: string, title: string) => string;
  when: string;
  anytime: string;
  join: string;
  guest: string;
  note: string;
  e2ee: string;
  untitled: string;
}

const W: Record<string, Words> = {
  'zh-CN': { subject: (t) => `会议邀请:${t}`, lead: (w, t) => `${w} 邀请你参加会议「${t}」。`, when: '时间', anytime: '随时可以加入', join: '加入会议', guest: '你没有这里的账号,请用上面这条访客链接加入,无需登录。', note: '附言', e2ee: '这是一场端到端加密的会议。上面的链接不含密钥,光凭它进不了会议;组织者会用别的方式另外把完整链接发给你。', untitled: '未命名会议' },
  'zh-TW': { subject: (t) => `會議邀請:${t}`, lead: (w, t) => `${w} 邀請你參加會議「${t}」。`, when: '時間', anytime: '隨時可以加入', join: '加入會議', guest: '你沒有這裡的帳號,請用上面這條訪客連結加入,無需登入。', note: '附言', e2ee: '這是一場端對端加密的會議。上面的連結不含金鑰,光憑它進不了會議;組織者會用別的方式另外把完整連結傳給你。', untitled: '未命名會議' },
  en: { subject: (t) => `Invitation: ${t}`, lead: (w, t) => `${w} invites you to the meeting “${t}”.`, when: 'When', anytime: 'Join at any time', join: 'Join the meeting', guest: 'You have no account here; the link above is a guest link and needs no sign-in.', note: 'Note', e2ee: 'This meeting is end-to-end encrypted. The link above does not carry the key and is not enough to join; the organiser will send you the full link by another way.', untitled: 'Untitled meeting' },
  ja: { subject: (t) => `会議への招待:${t}`, lead: (w, t) => `${w} さんから会議「${t}」への招待が届きました。`, when: '日時', anytime: 'いつでも参加できます', join: '会議に参加', guest: 'こちらのアカウントをお持ちでないため、上のゲストリンクからサインインなしで参加できます。', note: 'メッセージ', e2ee: 'この会議はエンドツーエンドで暗号化されています。上のリンクには鍵が含まれておらず、それだけでは参加できません。完全なリンクは主催者から別の方法で届きます。', untitled: '無題の会議' },
  ko: { subject: (t) => `회의 초대: ${t}`, lead: (w, t) => `${w} 님이 회의 “${t}”에 초대했습니다.`, when: '시간', anytime: '언제든 참가할 수 있습니다', join: '회의 참가', guest: '이곳의 계정이 없으므로 위의 게스트 링크로 로그인 없이 참가하세요.', note: '메모', e2ee: '이 회의는 종단 간 암호화되어 있습니다. 위 링크에는 키가 없어 그것만으로는 참가할 수 없으며, 전체 링크는 주최자가 다른 방법으로 보내 드립니다.', untitled: '제목 없는 회의' },
  de: { subject: (t) => `Einladung: ${t}`, lead: (w, t) => `${w} lädt Sie zur Besprechung „${t}“ ein.`, when: 'Wann', anytime: 'Beitritt jederzeit möglich', join: 'Der Besprechung beitreten', guest: 'Sie haben hier kein Konto; der Link oben ist ein Gastlink und erfordert keine Anmeldung.', note: 'Nachricht', e2ee: 'Diese Besprechung ist Ende-zu-Ende-verschlüsselt. Der Link oben enthält den Schlüssel nicht und reicht zum Beitreten nicht aus; den vollständigen Link sendet Ihnen der Organisator auf anderem Weg.', untitled: 'Unbenannte Besprechung' },
  fr: { subject: (t) => `Invitation : ${t}`, lead: (w, t) => `${w} vous invite à la réunion « ${t} ».`, when: 'Quand', anytime: 'Vous pouvez rejoindre à tout moment', join: 'Rejoindre la réunion', guest: 'Vous n’avez pas de compte ici ; le lien ci-dessus est un lien invité et ne demande aucune connexion.', note: 'Message', e2ee: 'Cette réunion est chiffrée de bout en bout. Le lien ci-dessus ne contient pas la clé et ne suffit pas pour rejoindre ; l’organisateur vous enverra le lien complet par un autre moyen.', untitled: 'Réunion sans titre' },
  es: { subject: (t) => `Invitación: ${t}`, lead: (w, t) => `${w} te invita a la reunión «${t}».`, when: 'Cuándo', anytime: 'Puedes unirte en cualquier momento', join: 'Unirse a la reunión', guest: 'No tienes cuenta aquí; el enlace de arriba es de invitado y no requiere iniciar sesión.', note: 'Nota', e2ee: 'Esta reunión está cifrada de extremo a extremo. El enlace de arriba no lleva la clave y no basta para unirse; el organizador te enviará el enlace completo por otra vía.', untitled: 'Reunión sin título' },
  ru: { subject: (t) => `Приглашение: ${t}`, lead: (w, t) => `${w} приглашает вас на встречу «${t}».`, when: 'Когда', anytime: 'Присоединиться можно в любое время', join: 'Присоединиться к встрече', guest: 'У вас нет здесь учётной записи; ссылка выше — гостевая и не требует входа.', note: 'Сообщение', e2ee: 'Эта встреча защищена сквозным шифрованием. Ссылка выше не содержит ключа, и по ней одной войти нельзя; полную ссылку организатор пришлёт другим способом.', untitled: 'Встреча без названия' },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));

/** The time as a person in any zone can read it: UTC, stated as such. The calendar file carries
 *  the exact instant, and the recipient's own calendar shows it in their zone; a mail body cannot
 *  know where its reader is. / 时间写成任何时区的人都读得懂的样子:UTC,并写明是 UTC。
 *  精确的时刻由日历文件携带,收件人自己的日历会按他的时区显示;邮件正文无从得知读者身在何处。 */
function whenText(ms: number, minutes: number | null): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
  return minutes ? `${base} (${minutes} min)` : base;
}

// ---------- The calendar file ----------
// ---------- 日历文件 ----------

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** RFC 5545 asks for lines of at most 75 OCTETS, continued with a leading space. Counted in
 *  bytes and cut between characters, because a title in Chinese is three bytes a character and a
 *  fold in the middle of one turns it into two pieces of nonsense.
 *  RFC 5545 要求每行不超过 75 个**字节**,续行以一个空格开头。按字节计、在字符之间切,
 *  因为中文标题一个字三个字节,从字的中间折开,得到的是两截乱码。 */
function icsFold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function meetingIcs(o: { uid: string; title: string; start: number; minutes: number; link: string; organiser: Addr; attendees: Addr[]; lead: string }): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CFMail//Meetings//EN', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${o.uid}`,
    `DTSTAMP:${icsTime(now())}`,
    `DTSTART:${icsTime(o.start)}`,
    `DTEND:${icsTime(o.start + o.minutes * 60000)}`,
    `SUMMARY:${icsText(o.title)}`,
    `DESCRIPTION:${icsText(`${o.lead}\n${o.link}`)}`,
    `LOCATION:${icsText(o.link)}`,
    `URL:${o.link}`,
    `ORGANIZER;CN=${icsText(o.organiser.name || o.organiser.addr)}:mailto:${o.organiser.addr}`,
    ...o.attendees.map((a) => `ATTENDEE;CN=${icsText(a.name || a.addr)};ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${a.addr}`),
    'SEQUENCE:0', 'STATUS:CONFIRMED', 'TRANSP:OPAQUE',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// ---------- Sending ----------
// ---------- 发送 ----------

/** Whether an address belongs to somebody who can sign in here: their own sign-in address, or a
 *  mailbox they own. / 一个地址是否属于能在这里登录的某个人:他自己的登录地址,或他名下的邮箱。 */
export async function userIdForAddress(env: Env, address: string): Promise<string | null> {
  const addr = normalizeAddr(address);
  const at = addr.lastIndexOf('@');
  if (at < 1) return null;
  const byEmail = (await env.DB.prepare('SELECT id FROM users WHERE email=?1 AND disabled=0').bind(addr).first()) as any;
  if (byEmail) return byEmail.id;
  const byBox = (await env.DB.prepare(
    `SELECT u.id FROM users u
       JOIN grants g ON g.user_id=u.id AND g.role='owner'
       JOIN mailboxes mb ON mb.id=g.mailbox_id AND mb.disabled=0
       JOIN domains d ON d.id=mb.domain_id
     WHERE mb.local_part=?1 AND d.name=?2 AND u.disabled=0 LIMIT 1`
  ).bind(addr.slice(0, at), addr.slice(at + 1)).first()) as any;
  return byBox?.id || null;
}

/** The mailbox an invitation goes out from: the one asked for if the organiser may write from
 *  it, otherwise their own in the meeting's domain, otherwise any they can write from.
 *  邀请从哪个邮箱发出:指定的那个(只要组织者有权用它发信),否则是他在会议所属域名下自己的邮箱,
 *  再否则是任何一个他能发信的邮箱。 */
export async function senderMailbox(env: Env, user: User, domainId: string, wanted?: string): Promise<MailboxRow | null> {
  const rows = await env.DB.prepare(
    `SELECT g.role, mb.id, mb.domain_id, mb.local_part, mb.display_name, mb.disabled, d.name AS domain_name
     FROM grants g JOIN mailboxes mb ON mb.id=g.mailbox_id JOIN domains d ON d.id=mb.domain_id
     WHERE g.user_id=?1 AND mb.disabled=0 AND g.role != 'readonly'
     ORDER BY (mb.id = ?2) DESC, (mb.domain_id = ?3) DESC, (g.role = 'owner') DESC, d.name, mb.local_part LIMIT 1`
  ).bind(user.id, wanted || '', domainId).all();
  return ((rows.results || [])[0] as unknown as MailboxRow | undefined) || null;
}

export interface InviteResult { internal: string[]; external: string[]; guests_off: boolean; sent: number }

export async function sendInvitations(env: Env, user: User, o: {
  meeting: any; link: string; guestLink: string | null; people: Addr[]; note: string; lang: string; mailboxId?: string;
}): Promise<InviteResult> {
  const w = W[o.lang] || W.en;
  const m = o.meeting;
  const mb = await senderMailbox(env, user, m.domain_id, o.mailboxId);
  if (!mb) throw new HttpError(400, 'e_meet_no_mailbox');
  const organiser: Addr = { name: user.name || mb.display_name || '', addr: `${mb.local_part}@${mb.domain_name}` };

  const internal: Addr[] = [];
  const external: Addr[] = [];
  for (const p of o.people) ((await userIdForAddress(env, p.addr)) ? internal : external).push(p);

  const title = m.title || w.untitled;
  const lead = w.lead(organiser.name || organiser.addr, title);
  const whenLine = m.starts_at ? `${w.when}: ${whenText(m.starts_at, m.duration_min)}` : w.anytime;
  const note = o.note.trim();

  let sent = 0;
  const post = async (to: Addr[], link: string, isGuest: boolean) => {
    if (!to.length) return;
    // An encrypted meeting's secret never passes through here, so neither does it pass through this
    // mail; the reader is told where the rest of the link will come from.
    // 加密会议的秘密从不经过这里,所以也不会出现在这封邮件里;读信的人会被告知链接的其余部分从哪来。
    const locked = m.e2ee ? ['', w.e2ee] : [];
    const text = [lead, '', whenLine, `${w.join}: ${link}`, ...(isGuest ? ['', w.guest] : []), ...locked, ...(note ? ['', `${w.note}: ${note}`] : [])].join('\n');
    const html = `<p>${esc(lead)}</p><p>${esc(whenLine)}</p><p><a href="${esc(link)}">${esc(w.join)}</a><br><span style="color:#666;font-size:12px">${esc(link)}</span></p>`
      + (isGuest ? `<p style="color:#666">${esc(w.guest)}</p>` : '') + (m.e2ee ? `<p style="color:#666">&#128274; ${esc(w.e2ee)}</p>` : '') + (note ? `<p>${esc(w.note)}: ${esc(note).replace(/\n/g, '<br>')}</p>` : '');
    const attachmentIds: string[] = [];
    if (m.starts_at) {
      // An attachment is an upload, and an upload is a row and an object; the hourly sweep takes
      // both away after two days like any other. / 附件就是一次上传,而一次上传是一行加一个对象;
      // 每小时的清扫会像对待其他上传一样,两天后把两者都带走。
      const ics = meetingIcs({
        uid: `${m.id}@${mb.domain_name}`, title, start: m.starts_at, minutes: m.duration_min || 60,
        link, organiser, attendees: to, lead,
      });
      const id = uid();
      const key = `uploads/${id}`;
      const bytes = new TextEncoder().encode(ics);
      await env.RAW.put(key, bytes);
      await env.DB.prepare('INSERT INTO uploads (id, user_id, filename, mime, size, r2_key, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)')
        .bind(id, user.id, 'invite.ics', 'text/calendar', bytes.length, key, now()).run();
      attachmentIds.push(id);
    }
    await queueSend(env, user, mb, { to, cc: [], bcc: [], subject: w.subject(title), text, html, attachmentIds });
    sent += 1;
  };

  await post(internal, o.link, false);
  // Somebody with no account can only come in as a guest. If the meeting has no guest door,
  // mailing them a link that will refuse them helps nobody, so they are not mailed, and the
  // caller is told why. / 没有账号的人只能以访客身份进来。会议若没开访客这扇门,
  // 给他们寄一条注定被拒的链接对谁都没有帮助,所以不寄,并把原因告诉调用方。
  const guestsOff = external.length > 0 && !o.guestLink;
  if (!guestsOff) await post(external, o.guestLink || o.link, true);

  return { internal: internal.map((a) => a.addr), external: external.map((a) => a.addr), guests_off: guestsOff, sent };
}

export { parseAddrList };
