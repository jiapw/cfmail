// Verification-code email templates, picked by the user's interface language, falling back to English
// 验证码邮件模板(按用户界面语言选择,回落英文)

type Tpl = { subject: string; body: (code: string, brand: string, mins: number) => string };

const T: Record<string, Tpl> = {
  'zh-CN': {
    subject: '验证码',
    body: (c, b, m) => `你正在注册 ${b} 的邮箱账号。\n\n验证码:${c}\n\n${m} 分钟内有效。如果这不是你本人的操作,请忽略本邮件。`,
  },
  'zh-TW': {
    subject: '驗證碼',
    body: (c, b, m) => `你正在註冊 ${b} 的信箱帳號。\n\n驗證碼:${c}\n\n${m} 分鐘內有效。如果這不是你本人的操作,請忽略本郵件。`,
  },
  en: {
    subject: 'Verification code',
    body: (c, b, m) => `You are creating an account on ${b}.\n\nVerification code: ${c}\n\nIt expires in ${m} minutes. If this wasn't you, please ignore this email.`,
  },
  ja: {
    subject: '確認コード',
    body: (c, b, m) => `${b} のアカウントを作成しています。\n\n確認コード: ${c}\n\n${m} 分間有効です。心当たりがない場合はこのメールを無視してください。`,
  },
  ko: {
    subject: '인증 코드',
    body: (c, b, m) => `${b} 계정을 만들고 있습니다.\n\n인증 코드: ${c}\n\n${m}분간 유효합니다. 본인이 아니라면 이 메일을 무시하세요.`,
  },
  de: {
    subject: 'Bestätigungscode',
    body: (c, b, m) => `Du erstellst ein Konto bei ${b}.\n\nBestätigungscode: ${c}\n\nGültig für ${m} Minuten. Falls du das nicht warst, ignoriere diese E-Mail.`,
  },
  fr: {
    subject: 'Code de vérification',
    body: (c, b, m) => `Vous créez un compte sur ${b}.\n\nCode de vérification : ${c}\n\nValable ${m} minutes. Si ce n'est pas vous, ignorez cet e-mail.`,
  },
  es: {
    subject: 'Código de verificación',
    body: (c, b, m) => `Estás creando una cuenta en ${b}.\n\nCódigo de verificación: ${c}\n\nCaduca en ${m} minutos. Si no has sido tú, ignora este correo.`,
  },
  ru: {
    subject: 'Код подтверждения',
    body: (c, b, m) => `Вы создаёте аккаунт в ${b}.\n\nКод подтверждения: ${c}\n\nДействует ${m} минут. Если это были не вы, проигнорируйте письмо.`,
  },
};

export function verifyMail(lang: string, code: string, brand: string, mins: number) {
  const tpl = T[lang] || T.en;
  return { subject: `${tpl.subject}: ${code}`, text: tpl.body(code, brand, mins) };
}

// Password reset email
// 密码重置邮件
type ResetTpl = { subject: string; body: (url: string, brand: string, mins: number) => string };

const R: Record<string, ResetTpl> = {
  'zh-CN': {
    subject: '重置密码',
    body: (u, b, m) => `你正在重置 ${b} 账号的密码。\n\n点击下面的链接设置新密码:\n${u}\n\n${m} 分钟内有效,只能使用一次。如果这不是你本人的操作,请忽略本邮件,你的密码不会有任何变化。`,
  },
  'zh-TW': {
    subject: '重設密碼',
    body: (u, b, m) => `你正在重設 ${b} 帳號的密碼。\n\n點擊下面的連結設定新密碼:\n${u}\n\n${m} 分鐘內有效,只能使用一次。如果這不是你本人的操作,請忽略本郵件,你的密碼不會有任何變化。`,
  },
  en: {
    subject: 'Reset your password',
    body: (u, b, m) => `You asked to reset the password for your ${b} account.\n\nOpen this link to set a new password:\n${u}\n\nIt expires in ${m} minutes and can only be used once. If this wasn't you, ignore this email — your password stays unchanged.`,
  },
  ja: {
    subject: 'パスワードの再設定',
    body: (u, b, m) => `${b} アカウントのパスワード再設定が要求されました。\n\n次のリンクから新しいパスワードを設定してください:\n${u}\n\n${m} 分間有効で、一度だけ使用できます。心当たりがない場合はこのメールを無視してください。パスワードは変更されません。`,
  },
  ko: {
    subject: '비밀번호 재설정',
    body: (u, b, m) => `${b} 계정의 비밀번호 재설정이 요청되었습니다.\n\n아래 링크에서 새 비밀번호를 설정하세요:\n${u}\n\n${m}분간 유효하며 한 번만 사용할 수 있습니다. 본인이 아니라면 이 메일을 무시하세요. 비밀번호는 변경되지 않습니다.`,
  },
  de: {
    subject: 'Passwort zurücksetzen',
    body: (u, b, m) => `Du hast angefordert, das Passwort deines ${b}-Kontos zurückzusetzen.\n\nÖffne diesen Link, um ein neues Passwort zu setzen:\n${u}\n\nGültig für ${m} Minuten, nur einmal verwendbar. Falls du das nicht warst, ignoriere diese E-Mail — dein Passwort bleibt unverändert.`,
  },
  fr: {
    subject: 'Réinitialiser votre mot de passe',
    body: (u, b, m) => `Vous avez demandé la réinitialisation du mot de passe de votre compte ${b}.\n\nOuvrez ce lien pour définir un nouveau mot de passe :\n${u}\n\nValable ${m} minutes, utilisable une seule fois. Si ce n'est pas vous, ignorez cet e-mail : votre mot de passe reste inchangé.`,
  },
  es: {
    subject: 'Restablecer tu contraseña',
    body: (u, b, m) => `Has solicitado restablecer la contraseña de tu cuenta de ${b}.\n\nAbre este enlace para definir una nueva contraseña:\n${u}\n\nCaduca en ${m} minutos y solo se puede usar una vez. Si no has sido tú, ignora este correo: tu contraseña no cambiará.`,
  },
  ru: {
    subject: 'Сброс пароля',
    body: (u, b, m) => `Запрошен сброс пароля для вашего аккаунта ${b}.\n\nОткройте эту ссылку, чтобы задать новый пароль:\n${u}\n\nСсылка действует ${m} минут и работает один раз. Если это были не вы, проигнорируйте письмо — пароль останется прежним.`,
  },
};

// The code for somebody at the door of a shared link. Not the registration wording: that one
// tells the reader they are creating an account, and this reader is not.
// 发给站在分享链接门口的人的验证码。不用注册的那套措辞:那套告诉读者"你正在创建账号",而这位读者不是。
const G: Record<string, Tpl> = {
  'zh-CN': {
    subject: '打开分享链接的验证码',
    body: (c, b, m) => `有人通过 ${b} 分享了文件给你。打开这条分享链接之前,需要先验证这个邮箱。\n\n验证码:${c}\n\n${m} 分钟内有效。如果你没有打开过这样的链接,请忽略本邮件。`,
  },
  'zh-TW': {
    subject: '開啟分享連結的驗證碼',
    body: (c, b, m) => `有人透過 ${b} 分享了檔案給你。開啟這條分享連結之前,需要先驗證這個信箱。\n\n驗證碼:${c}\n\n${m} 分鐘內有效。如果你沒有開啟過這樣的連結,請忽略本郵件。`,
  },
  en: {
    subject: 'Your code to open a shared link',
    body: (c, b, m) => `Someone shared files with you through ${b}. To open the link, this address needs to be verified first.\n\nVerification code: ${c}\n\nIt expires in ${m} minutes. If you did not open such a link, please ignore this email.`,
  },
  ja: {
    subject: '共有リンクを開くための確認コード',
    body: (c, b, m) => `${b} を通じてファイルが共有されました。リンクを開くには、このメールアドレスの認証が必要です。\n\n確認コード: ${c}\n\n${m} 分間有効です。心当たりがない場合はこのメールを無視してください。`,
  },
  ko: {
    subject: '공유 링크 열기 인증 코드',
    body: (c, b, m) => `누군가 ${b}을(를) 통해 파일을 공유했습니다. 링크를 열려면 먼저 이 이메일 주소를 인증해야 합니다.\n\n인증 코드: ${c}\n\n${m}분간 유효합니다. 이런 링크를 연 적이 없다면 이 메일을 무시하세요.`,
  },
  de: {
    subject: 'Dein Code zum Öffnen eines geteilten Links',
    body: (c, b, m) => `Jemand hat über ${b} Dateien mit dir geteilt. Um den Link zu öffnen, muss diese Adresse zuerst bestätigt werden.\n\nBestätigungscode: ${c}\n\nGültig für ${m} Minuten. Falls du keinen solchen Link geöffnet hast, ignoriere diese E-Mail.`,
  },
  fr: {
    subject: 'Votre code pour ouvrir un lien partagé',
    body: (c, b, m) => `Quelqu’un a partagé des fichiers avec vous via ${b}. Pour ouvrir le lien, cette adresse doit d’abord être vérifiée.\n\nCode de vérification : ${c}\n\nValable ${m} minutes. Si vous n’avez pas ouvert un tel lien, ignorez cet e-mail.`,
  },
  es: {
    subject: 'Tu código para abrir un enlace compartido',
    body: (c, b, m) => `Alguien compartió archivos contigo a través de ${b}. Para abrir el enlace, primero hay que verificar esta dirección.\n\nCódigo de verificación: ${c}\n\nCaduca en ${m} minutos. Si no abriste un enlace así, ignora este correo.`,
  },
  ru: {
    subject: 'Код для открытия ссылки',
    body: (c, b, m) => `Кто-то поделился с вами файлами через ${b}. Чтобы открыть ссылку, нужно сначала подтвердить этот адрес.\n\nКод подтверждения: ${c}\n\nДействует ${m} минут. Если вы не открывали такую ссылку, проигнорируйте письмо.`,
  },
};

export function shareCodeMail(lang: string, code: string, brand: string, mins: number) {
  const tpl = G[lang] || G.en;
  return { subject: tpl.subject, text: tpl.body(code, brand, mins) };
}

export function resetMail(lang: string, url: string, brand: string, mins: number) {
  const tpl = R[lang] || R.en;
  return { subject: tpl.subject, text: tpl.body(url, brand, mins) };
}
