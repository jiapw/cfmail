#Requires -Version 5.1
<#
.SYNOPSIS
    Export a Microsoft 365 / Outlook mailbox to .eml files, ready to import into CFMail.

.DESCRIPTION
    Signs in with the official Microsoft Graph Command Line Tools public client using
    delegated read-only permissions, walks every mail folder recursively, and saves each
    message as a complete .eml (attachments included). No app registration, no client
    secret, no PowerShell modules required.

    Interrupted runs resume: finished messages are checkpointed and skipped on re-run.

.PARAMETER Output
    Where to write the export. Defaults to an "export" folder next to this script.

.PARAMETER Lang
    UI language. "auto" (default) follows the Windows display language.

.EXAMPLE
    .\Export-Mailbox.ps1

.EXAMPLE
    .\Export-Mailbox.ps1 -Output "D:\mail-backup" -Lang zh-CN
#>
[CmdletBinding()]
param(
    [string]$Output = (Join-Path $PSScriptRoot "export"),
    [ValidateRange(1, 999)]
    [int]$PageSize = 100,
    [string]$TenantId,
    [ValidateSet('auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru')]
    [string]$Lang = 'auto',
    [switch]$NoHidden,
    [switch]$FoldersOnly
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Localization. One table per language; L <key> returns the format string.
# ---------------------------------------------------------------------------

$Messages = @{
    'en' = @{
        net_oauth_fail  = 'Could not connect to Microsoft OAuth: {0}'
        no_token        = 'Microsoft OAuth did not return an access token.'
        dev_session_fail = 'Microsoft OAuth could not create a device sign-in session: {0}'
        no_dev_code     = 'Microsoft OAuth did not return a device sign-in code.'
        browser_open    = 'The Microsoft sign-in page will open in your browser.'
        signin_code     = 'Sign-in code: {0}'
        signin_hint     = 'Sign in to the mailbox you want to export, then approve the read-only User.Read and Mail.Read permissions.'
        clip_ok         = 'The sign-in code has been copied to the clipboard.'
        declined        = 'Authorization was declined on the Microsoft sign-in page.'
        code_expired    = 'The Microsoft sign-in code expired. Run the script again.'
        oauth_fail      = 'Microsoft OAuth failed: {0}'
        signin_timeout  = 'Microsoft sign-in timed out. Run the script again.'
        refresh_fail    = 'Could not refresh the Microsoft access token: {0}'
        path_outside    = 'Path is outside the export directory: {0}'
        graph_retry     = 'Graph returned HTTP {0}. Retrying in {1} seconds.'
        graph_http      = 'Graph HTTP {0}: {1}'
        graph_net_retry = 'Graph network request failed. Retrying in {0} seconds: {1}'
        mime_retry      = 'MIME download returned Graph HTTP {0}. Retrying in {1} seconds.'
        mime_net_retry  = 'MIME network download failed. Retrying in {0} seconds: {1}'
        estimating      = 'estimating...'
        activity        = 'Exporting Microsoft 365 mailbox'
        overall_status  = '{0:N1}% | {1:N0} / {2:N0} messages | downloaded {3:N0}, skipped {4:N0}, failed {5:N0} | ETA {6}'
        folder_status   = '{0:N0} / {1:N0} messages'
        folder_label    = 'Folder: {0}'
        signed_in       = 'Signed in as: {0}'
        discovering     = 'Discovering mail folders recursively...'
        found_folders   = 'Found {0} mail folders.'
        bad_checkpoint  = 'Ignored a corrupt checkpoint record.'
        estimate        = 'Estimated mailbox size: {0:N0} messages; {1:N0} already complete; {2:N0} remaining.'
        folder_head     = '[{0}/{1}] {2} ({3:N0} messages reported by Graph)'
        preparing       = 'Preparing folder...'
        skipping        = 'Skipping existing file: {0}'
        no_subject      = '(no subject)'
        no_length       = 'The MIME download did not return a file length.'
        failed_item     = 'Failed {0}: {1}'
        done            = 'Export complete: {0:N0} downloaded, {1:N0} skipped, {2:N0} failed, {3:N2} MiB added.'
        outdir          = 'Output directory: {0}'
        interrupted     = 'Export interrupted. Completed messages and checkpoints were preserved; run the script again to resume.'
    }
    'zh-CN' = @{
        net_oauth_fail  = '无法连接 Microsoft OAuth: {0}'
        no_token        = 'Microsoft OAuth 没有返回访问令牌。'
        dev_session_fail = 'Microsoft OAuth 无法创建设备登录会话: {0}'
        no_dev_code     = 'Microsoft OAuth 没有返回设备登录代码。'
        browser_open    = '即将在浏览器中打开 Microsoft 登录页面。'
        signin_code     = '登录代码: {0}'
        signin_hint     = '请登录你要导出的那个邮箱、然后同意 User.Read 和 Mail.Read 两项只读权限。'
        clip_ok         = '登录代码已复制到剪贴板。'
        declined        = '已在 Microsoft 登录页面拒绝授权。'
        code_expired    = 'Microsoft 登录代码已过期。请重新运行脚本。'
        oauth_fail      = 'Microsoft OAuth 失败: {0}'
        signin_timeout  = 'Microsoft 登录超时。请重新运行脚本。'
        refresh_fail    = '无法刷新 Microsoft 访问令牌: {0}'
        path_outside    = '路径不在导出目录内: {0}'
        graph_retry     = 'Graph 返回 HTTP {0}。{1} 秒后重试。'
        graph_http      = 'Graph HTTP {0}: {1}'
        graph_net_retry = 'Graph 网络请求失败。{0} 秒后重试: {1}'
        mime_retry      = 'MIME 下载返回 Graph HTTP {0}。{1} 秒后重试。'
        mime_net_retry  = 'MIME 网络下载失败。{0} 秒后重试: {1}'
        estimating      = '估算中...'
        activity        = '正在导出 Microsoft 365 邮箱'
        overall_status  = '{0:N1}% | {1:N0} / {2:N0} 封 | 已下载 {3:N0}、已跳过 {4:N0}、失败 {5:N0} | 预计剩余 {6}'
        folder_status   = '{0:N0} / {1:N0} 封'
        folder_label    = '文件夹: {0}'
        signed_in       = '已登录: {0}'
        discovering     = '正在递归枚举邮件文件夹...'
        found_folders   = '共发现 {0} 个邮件文件夹。'
        bad_checkpoint  = '已忽略一条损坏的断点记录。'
        estimate        = '邮箱预计 {0:N0} 封、已完成 {1:N0} 封、剩余 {2:N0} 封。'
        folder_head     = '[{0}/{1}] {2} (Graph 报告 {3:N0} 封)'
        preparing       = '正在准备文件夹...'
        skipping        = '跳过已存在的文件: {0}'
        no_subject      = '(无主题)'
        no_length       = 'MIME 下载没有返回文件长度。'
        failed_item     = '失败 {0}: {1}'
        done            = '导出完成: 新增 {0:N0} 封、跳过 {1:N0} 封、失败 {2:N0} 封、新增 {3:N2} MiB。'
        outdir          = '输出目录: {0}'
        interrupted     = '导出已中断。已完成的邮件和断点都已保留、重新运行脚本即可续传。'
    }
    'zh-TW' = @{
        net_oauth_fail  = '無法連線 Microsoft OAuth: {0}'
        no_token        = 'Microsoft OAuth 沒有回傳存取權杖。'
        dev_session_fail = 'Microsoft OAuth 無法建立裝置登入工作階段: {0}'
        no_dev_code     = 'Microsoft OAuth 沒有回傳裝置登入代碼。'
        browser_open    = '即將在瀏覽器中開啟 Microsoft 登入頁面。'
        signin_code     = '登入代碼: {0}'
        signin_hint     = '請登入你要匯出的那個信箱、然後同意 User.Read 與 Mail.Read 兩項唯讀權限。'
        clip_ok         = '登入代碼已複製到剪貼簿。'
        declined        = '已在 Microsoft 登入頁面拒絕授權。'
        code_expired    = 'Microsoft 登入代碼已過期。請重新執行指令碼。'
        oauth_fail      = 'Microsoft OAuth 失敗: {0}'
        signin_timeout  = 'Microsoft 登入逾時。請重新執行指令碼。'
        refresh_fail    = '無法重新整理 Microsoft 存取權杖: {0}'
        path_outside    = '路徑不在匯出目錄內: {0}'
        graph_retry     = 'Graph 回傳 HTTP {0}。{1} 秒後重試。'
        graph_http      = 'Graph HTTP {0}: {1}'
        graph_net_retry = 'Graph 網路請求失敗。{0} 秒後重試: {1}'
        mime_retry      = 'MIME 下載回傳 Graph HTTP {0}。{1} 秒後重試。'
        mime_net_retry  = 'MIME 網路下載失敗。{0} 秒後重試: {1}'
        estimating      = '估算中...'
        activity        = '正在匯出 Microsoft 365 信箱'
        overall_status  = '{0:N1}% | {1:N0} / {2:N0} 封 | 已下載 {3:N0}、已略過 {4:N0}、失敗 {5:N0} | 預計剩餘 {6}'
        folder_status   = '{0:N0} / {1:N0} 封'
        folder_label    = '資料夾: {0}'
        signed_in       = '已登入: {0}'
        discovering     = '正在遞迴列舉郵件資料夾...'
        found_folders   = '共發現 {0} 個郵件資料夾。'
        bad_checkpoint  = '已忽略一筆損壞的檢查點記錄。'
        estimate        = '信箱預計 {0:N0} 封、已完成 {1:N0} 封、剩餘 {2:N0} 封。'
        folder_head     = '[{0}/{1}] {2} (Graph 回報 {3:N0} 封)'
        preparing       = '正在準備資料夾...'
        skipping        = '略過已存在的檔案: {0}'
        no_subject      = '(無主旨)'
        no_length       = 'MIME 下載沒有回傳檔案長度。'
        failed_item     = '失敗 {0}: {1}'
        done            = '匯出完成: 新增 {0:N0} 封、略過 {1:N0} 封、失敗 {2:N0} 封、新增 {3:N2} MiB。'
        outdir          = '輸出目錄: {0}'
        interrupted     = '匯出已中斷。已完成的郵件與檢查點都已保留、重新執行指令碼即可續傳。'
    }
    'ja' = @{
        net_oauth_fail  = 'Microsoft OAuth に接続できません: {0}'
        no_token        = 'Microsoft OAuth がアクセストークンを返しませんでした。'
        dev_session_fail = 'Microsoft OAuth がデバイスサインインセッションを作成できませんでした: {0}'
        no_dev_code     = 'Microsoft OAuth がデバイスサインインコードを返しませんでした。'
        browser_open    = 'ブラウザーで Microsoft のサインインページを開きます。'
        signin_code     = 'サインインコード: {0}'
        signin_hint     = 'エクスポートしたいメールボックスでサインインし、読み取り専用の User.Read と Mail.Read を承認してください。'
        clip_ok         = 'サインインコードをクリップボードにコピーしました。'
        declined        = 'Microsoft のサインインページで承認が拒否されました。'
        code_expired    = 'Microsoft のサインインコードが期限切れです。スクリプトを再実行してください。'
        oauth_fail      = 'Microsoft OAuth が失敗しました: {0}'
        signin_timeout  = 'Microsoft のサインインがタイムアウトしました。スクリプトを再実行してください。'
        refresh_fail    = 'Microsoft のアクセストークンを更新できません: {0}'
        path_outside    = 'パスがエクスポートディレクトリの外にあります: {0}'
        graph_retry     = 'Graph が HTTP {0} を返しました。{1} 秒後に再試行します。'
        graph_http      = 'Graph HTTP {0}: {1}'
        graph_net_retry = 'Graph のネットワーク要求が失敗しました。{0} 秒後に再試行します: {1}'
        mime_retry      = 'MIME ダウンロードが Graph HTTP {0} を返しました。{1} 秒後に再試行します。'
        mime_net_retry  = 'MIME のネットワークダウンロードが失敗しました。{0} 秒後に再試行します: {1}'
        estimating      = '推定中...'
        activity        = 'Microsoft 365 メールボックスをエクスポート中'
        overall_status  = '{0:N1}% | {1:N0} / {2:N0} 通 | ダウンロード {3:N0}、スキップ {4:N0}、失敗 {5:N0} | 残り {6}'
        folder_status   = '{0:N0} / {1:N0} 通'
        folder_label    = 'フォルダー: {0}'
        signed_in       = 'サインイン中: {0}'
        discovering     = 'メールフォルダーを再帰的に列挙しています...'
        found_folders   = 'メールフォルダーが {0} 個見つかりました。'
        bad_checkpoint  = '破損したチェックポイント記録を無視しました。'
        estimate        = 'メールボックスの推定 {0:N0} 通、完了済み {1:N0} 通、残り {2:N0} 通。'
        folder_head     = '[{0}/{1}] {2} (Graph 報告 {3:N0} 通)'
        preparing       = 'フォルダーを準備しています...'
        skipping        = '既存のファイルをスキップ: {0}'
        no_subject      = '(件名なし)'
        no_length       = 'MIME ダウンロードがファイル長を返しませんでした。'
        failed_item     = '失敗 {0}: {1}'
        done            = 'エクスポート完了: ダウンロード {0:N0}、スキップ {1:N0}、失敗 {2:N0}、追加 {3:N2} MiB。'
        outdir          = '出力ディレクトリ: {0}'
        interrupted     = 'エクスポートが中断されました。完了したメールとチェックポイントは保持されています。再実行すれば再開します。'
    }
    'ko' = @{
        net_oauth_fail  = 'Microsoft OAuth에 연결할 수 없습니다: {0}'
        no_token        = 'Microsoft OAuth가 액세스 토큰을 반환하지 않았습니다.'
        dev_session_fail = 'Microsoft OAuth가 장치 로그인 세션을 만들지 못했습니다: {0}'
        no_dev_code     = 'Microsoft OAuth가 장치 로그인 코드를 반환하지 않았습니다.'
        browser_open    = '브라우저에서 Microsoft 로그인 페이지를 엽니다.'
        signin_code     = '로그인 코드: {0}'
        signin_hint     = '내보낼 사서함으로 로그인한 뒤 읽기 전용 User.Read 및 Mail.Read 권한을 승인하세요.'
        clip_ok         = '로그인 코드를 클립보드에 복사했습니다.'
        declined        = 'Microsoft 로그인 페이지에서 권한 부여가 거부되었습니다.'
        code_expired    = 'Microsoft 로그인 코드가 만료되었습니다. 스크립트를 다시 실행하세요.'
        oauth_fail      = 'Microsoft OAuth 실패: {0}'
        signin_timeout  = 'Microsoft 로그인 시간이 초과되었습니다. 스크립트를 다시 실행하세요.'
        refresh_fail    = 'Microsoft 액세스 토큰을 갱신할 수 없습니다: {0}'
        path_outside    = '경로가 내보내기 디렉터리 밖에 있습니다: {0}'
        graph_retry     = 'Graph가 HTTP {0}을 반환했습니다. {1}초 후에 다시 시도합니다.'
        graph_http      = 'Graph HTTP {0}: {1}'
        graph_net_retry = 'Graph 네트워크 요청이 실패했습니다. {0}초 후에 다시 시도합니다: {1}'
        mime_retry      = 'MIME 다운로드가 Graph HTTP {0}을 반환했습니다. {1}초 후에 다시 시도합니다.'
        mime_net_retry  = 'MIME 네트워크 다운로드가 실패했습니다. {0}초 후에 다시 시도합니다: {1}'
        estimating      = '추정 중...'
        activity        = 'Microsoft 365 사서함 내보내는 중'
        overall_status  = '{0:N1}% | {1:N0} / {2:N0}통 | 다운로드 {3:N0}, 건너뜀 {4:N0}, 실패 {5:N0} | 남은 시간 {6}'
        folder_status   = '{0:N0} / {1:N0}통'
        folder_label    = '폴더: {0}'
        signed_in       = '로그인됨: {0}'
        discovering     = '메일 폴더를 재귀적으로 검색하는 중...'
        found_folders   = '메일 폴더 {0}개를 찾았습니다.'
        bad_checkpoint  = '손상된 체크포인트 레코드를 무시했습니다.'
        estimate        = '사서함 추정 {0:N0}통, 완료 {1:N0}통, 남음 {2:N0}통.'
        folder_head     = '[{0}/{1}] {2} (Graph 보고 {3:N0}통)'
        preparing       = '폴더를 준비하는 중...'
        skipping        = '기존 파일 건너뜀: {0}'
        no_subject      = '(제목 없음)'
        no_length       = 'MIME 다운로드가 파일 길이를 반환하지 않았습니다.'
        failed_item     = '실패 {0}: {1}'
        done            = '내보내기 완료: 다운로드 {0:N0}, 건너뜀 {1:N0}, 실패 {2:N0}, 추가 {3:N2} MiB.'
        outdir          = '출력 디렉터리: {0}'
        interrupted     = '내보내기가 중단되었습니다. 완료된 메일과 체크포인트는 보존되었습니다. 다시 실행하면 이어서 진행됩니다.'
    }
    'de' = @{
        net_oauth_fail  = 'Verbindung zu Microsoft OAuth nicht moeglich: {0}'
        no_token        = 'Microsoft OAuth hat kein Zugriffstoken zurueckgegeben.'
        dev_session_fail = 'Microsoft OAuth konnte keine Geraeteanmeldung starten: {0}'
        no_dev_code     = 'Microsoft OAuth hat keinen Geraete-Anmeldecode zurueckgegeben.'
        browser_open    = 'Die Microsoft-Anmeldeseite wird im Browser geoeffnet.'
        signin_code     = 'Anmeldecode: {0}'
        signin_hint     = 'Melden Sie sich mit dem Postfach an, das exportiert werden soll, und bestaetigen Sie die Leserechte User.Read und Mail.Read.'
        clip_ok         = 'Der Anmeldecode wurde in die Zwischenablage kopiert.'
        declined        = 'Die Autorisierung wurde auf der Microsoft-Anmeldeseite abgelehnt.'
        code_expired    = 'Der Microsoft-Anmeldecode ist abgelaufen. Starten Sie das Skript erneut.'
        oauth_fail      = 'Microsoft OAuth fehlgeschlagen: {0}'
        signin_timeout  = 'Zeitueberschreitung bei der Microsoft-Anmeldung. Starten Sie das Skript erneut.'
        refresh_fail    = 'Microsoft-Zugriffstoken konnte nicht erneuert werden: {0}'
        path_outside    = 'Pfad liegt ausserhalb des Exportverzeichnisses: {0}'
        graph_retry     = 'Graph hat HTTP {0} zurueckgegeben. Neuer Versuch in {1} Sekunden.'
        graph_http      = 'Graph HTTP {0}: {1}'
        graph_net_retry = 'Graph-Netzwerkanfrage fehlgeschlagen. Neuer Versuch in {0} Sekunden: {1}'
        mime_retry      = 'MIME-Download hat Graph HTTP {0} zurueckgegeben. Neuer Versuch in {1} Sekunden.'
        mime_net_retry  = 'MIME-Netzwerkdownload fehlgeschlagen. Neuer Versuch in {0} Sekunden: {1}'
        estimating      = 'wird geschaetzt...'
        activity        = 'Microsoft 365-Postfach wird exportiert'
        overall_status  = '{0:N1}% | {1:N0} / {2:N0} Nachrichten | geladen {3:N0}, uebersprungen {4:N0}, fehlgeschlagen {5:N0} | Restzeit {6}'
        folder_status   = '{0:N0} / {1:N0} Nachrichten'
        folder_label    = 'Ordner: {0}'
        signed_in       = 'Angemeldet als: {0}'
        discovering     = 'E-Mail-Ordner werden rekursiv ermittelt...'
        found_folders   = '{0} E-Mail-Ordner gefunden.'
        bad_checkpoint  = 'Ein beschaedigter Checkpoint-Eintrag wurde ignoriert.'
        estimate        = 'Geschaetzte Postfachgroesse: {0:N0} Nachrichten; {1:N0} bereits fertig; {2:N0} verbleibend.'
        folder_head     = '[{0}/{1}] {2} ({3:N0} Nachrichten laut Graph)'
        preparing       = 'Ordner wird vorbereitet...'
        skipping        = 'Vorhandene Datei uebersprungen: {0}'
        no_subject      = '(kein Betreff)'
        no_length       = 'Der MIME-Download hat keine Dateilaenge zurueckgegeben.'
        failed_item     = 'Fehlgeschlagen {0}: {1}'
        done            = 'Export abgeschlossen: {0:N0} geladen, {1:N0} uebersprungen, {2:N0} fehlgeschlagen, {3:N2} MiB hinzugefuegt.'
        outdir          = 'Ausgabeverzeichnis: {0}'
        interrupted     = 'Export unterbrochen. Fertige Nachrichten und Checkpoints bleiben erhalten; starten Sie das Skript erneut, um fortzusetzen.'
    }
    'fr' = @{
        net_oauth_fail  = 'Impossible de se connecter a Microsoft OAuth : {0}'
        no_token        = 'Microsoft OAuth n''a pas renvoye de jeton d''acces.'
        dev_session_fail = 'Microsoft OAuth n''a pas pu creer de session de connexion par appareil : {0}'
        no_dev_code     = 'Microsoft OAuth n''a pas renvoye de code de connexion par appareil.'
        browser_open    = 'La page de connexion Microsoft va s''ouvrir dans votre navigateur.'
        signin_code     = 'Code de connexion : {0}'
        signin_hint     = 'Connectez-vous a la boite aux lettres a exporter, puis approuvez les autorisations en lecture seule User.Read et Mail.Read.'
        clip_ok         = 'Le code de connexion a ete copie dans le presse-papiers.'
        declined        = 'L''autorisation a ete refusee sur la page de connexion Microsoft.'
        code_expired    = 'Le code de connexion Microsoft a expire. Relancez le script.'
        oauth_fail      = 'Echec de Microsoft OAuth : {0}'
        signin_timeout  = 'Delai de connexion Microsoft depasse. Relancez le script.'
        refresh_fail    = 'Impossible de renouveler le jeton d''acces Microsoft : {0}'
        path_outside    = 'Le chemin est hors du repertoire d''export : {0}'
        graph_retry     = 'Graph a renvoye HTTP {0}. Nouvelle tentative dans {1} secondes.'
        graph_http      = 'Graph HTTP {0} : {1}'
        graph_net_retry = 'Echec de la requete reseau Graph. Nouvelle tentative dans {0} secondes : {1}'
        mime_retry      = 'Le telechargement MIME a renvoye Graph HTTP {0}. Nouvelle tentative dans {1} secondes.'
        mime_net_retry  = 'Echec du telechargement MIME. Nouvelle tentative dans {0} secondes : {1}'
        estimating      = 'estimation...'
        activity        = 'Export de la boite aux lettres Microsoft 365'
        overall_status  = '{0:N1}% | {1:N0} / {2:N0} messages | telecharges {3:N0}, ignores {4:N0}, echoues {5:N0} | temps restant {6}'
        folder_status   = '{0:N0} / {1:N0} messages'
        folder_label    = 'Dossier : {0}'
        signed_in       = 'Connecte en tant que : {0}'
        discovering     = 'Recherche recursive des dossiers de courrier...'
        found_folders   = '{0} dossiers de courrier trouves.'
        bad_checkpoint  = 'Un enregistrement de reprise corrompu a ete ignore.'
        estimate        = 'Taille estimee de la boite : {0:N0} messages ; {1:N0} deja termines ; {2:N0} restants.'
        folder_head     = '[{0}/{1}] {2} ({3:N0} messages signales par Graph)'
        preparing       = 'Preparation du dossier...'
        skipping        = 'Fichier existant ignore : {0}'
        no_subject      = '(sans objet)'
        no_length       = 'Le telechargement MIME n''a pas renvoye de taille de fichier.'
        failed_item     = 'Echec {0} : {1}'
        done            = 'Export termine : {0:N0} telecharges, {1:N0} ignores, {2:N0} echoues, {3:N2} Mio ajoutes.'
        outdir          = 'Repertoire de sortie : {0}'
        interrupted     = 'Export interrompu. Les messages termines et les points de reprise sont conserves ; relancez le script pour continuer.'
    }
    'es' = @{
        net_oauth_fail  = 'No se pudo conectar con Microsoft OAuth: {0}'
        no_token        = 'Microsoft OAuth no devolvio un token de acceso.'
        dev_session_fail = 'Microsoft OAuth no pudo crear una sesion de inicio por dispositivo: {0}'
        no_dev_code     = 'Microsoft OAuth no devolvio un codigo de inicio por dispositivo.'
        browser_open    = 'La pagina de inicio de sesion de Microsoft se abrira en el navegador.'
        signin_code     = 'Codigo de inicio de sesion: {0}'
        signin_hint     = 'Inicia sesion con el buzon que quieres exportar y aprueba los permisos de solo lectura User.Read y Mail.Read.'
        clip_ok         = 'El codigo de inicio de sesion se copio al portapapeles.'
        declined        = 'Se rechazo la autorizacion en la pagina de inicio de sesion de Microsoft.'
        code_expired    = 'El codigo de inicio de sesion de Microsoft caduco. Vuelve a ejecutar el script.'
        oauth_fail      = 'Microsoft OAuth fallo: {0}'
        signin_timeout  = 'Se agoto el tiempo de inicio de sesion de Microsoft. Vuelve a ejecutar el script.'
        refresh_fail    = 'No se pudo renovar el token de acceso de Microsoft: {0}'
        path_outside    = 'La ruta esta fuera del directorio de exportacion: {0}'
        graph_retry     = 'Graph devolvio HTTP {0}. Reintentando en {1} segundos.'
        graph_http      = 'Graph HTTP {0}: {1}'
        graph_net_retry = 'Fallo la solicitud de red de Graph. Reintentando en {0} segundos: {1}'
        mime_retry      = 'La descarga MIME devolvio Graph HTTP {0}. Reintentando en {1} segundos.'
        mime_net_retry  = 'Fallo la descarga MIME por red. Reintentando en {0} segundos: {1}'
        estimating      = 'estimando...'
        activity        = 'Exportando buzon de Microsoft 365'
        overall_status  = '{0:N1}% | {1:N0} / {2:N0} mensajes | descargados {3:N0}, omitidos {4:N0}, fallidos {5:N0} | tiempo restante {6}'
        folder_status   = '{0:N0} / {1:N0} mensajes'
        folder_label    = 'Carpeta: {0}'
        signed_in       = 'Sesion iniciada como: {0}'
        discovering     = 'Explorando carpetas de correo de forma recursiva...'
        found_folders   = 'Se encontraron {0} carpetas de correo.'
        bad_checkpoint  = 'Se ignoro un registro de punto de control danado.'
        estimate        = 'Tamano estimado del buzon: {0:N0} mensajes; {1:N0} ya completados; {2:N0} restantes.'
        folder_head     = '[{0}/{1}] {2} ({3:N0} mensajes segun Graph)'
        preparing       = 'Preparando la carpeta...'
        skipping        = 'Se omite el archivo existente: {0}'
        no_subject      = '(sin asunto)'
        no_length       = 'La descarga MIME no devolvio la longitud del archivo.'
        failed_item     = 'Fallo {0}: {1}'
        done            = 'Exportacion completada: {0:N0} descargados, {1:N0} omitidos, {2:N0} fallidos, {3:N2} MiB anadidos.'
        outdir          = 'Directorio de salida: {0}'
        interrupted     = 'Exportacion interrumpida. Los mensajes completados y los puntos de control se conservaron; vuelve a ejecutar el script para continuar.'
    }
    'ru' = @{
        net_oauth_fail  = 'Не удалось подключиться к Microsoft OAuth: {0}'
        no_token        = 'Microsoft OAuth не вернул токен доступа.'
        dev_session_fail = 'Microsoft OAuth не смог создать сеанс входа с устройства: {0}'
        no_dev_code     = 'Microsoft OAuth не вернул код входа с устройства.'
        browser_open    = 'Страница входа Microsoft откроется в браузере.'
        signin_code     = 'Код входа: {0}'
        signin_hint     = 'Войдите в почтовый ящик, который нужно выгрузить, и подтвердите разрешения только для чтения User.Read и Mail.Read.'
        clip_ok         = 'Код входа скопирован в буфер обмена.'
        declined        = 'Авторизация отклонена на странице входа Microsoft.'
        code_expired    = 'Код входа Microsoft истёк. Запустите скрипт заново.'
        oauth_fail      = 'Сбой Microsoft OAuth: {0}'
        signin_timeout  = 'Время ожидания входа Microsoft истекло. Запустите скрипт заново.'
        refresh_fail    = 'Не удалось обновить токен доступа Microsoft: {0}'
        path_outside    = 'Путь находится вне каталога выгрузки: {0}'
        graph_retry     = 'Graph вернул HTTP {0}. Повтор через {1} с.'
        graph_http      = 'Graph HTTP {0}: {1}'
        graph_net_retry = 'Сетевой запрос к Graph не удался. Повтор через {0} с: {1}'
        mime_retry      = 'Загрузка MIME вернула Graph HTTP {0}. Повтор через {1} с.'
        mime_net_retry  = 'Сетевая загрузка MIME не удалась. Повтор через {0} с: {1}'
        estimating      = 'оценка...'
        activity        = 'Выгрузка почтового ящика Microsoft 365'
        overall_status  = '{0:N1}% | {1:N0} / {2:N0} писем | загружено {3:N0}, пропущено {4:N0}, ошибок {5:N0} | осталось {6}'
        folder_status   = '{0:N0} / {1:N0} писем'
        folder_label    = 'Папка: {0}'
        signed_in       = 'Выполнен вход: {0}'
        discovering     = 'Рекурсивный обход почтовых папок...'
        found_folders   = 'Найдено почтовых папок: {0}.'
        bad_checkpoint  = 'Повреждённая запись контрольной точки пропущена.'
        estimate        = 'Оценка размера ящика: {0:N0} писем; {1:N0} уже готово; {2:N0} осталось.'
        folder_head     = '[{0}/{1}] {2} (по данным Graph писем: {3:N0})'
        preparing       = 'Подготовка папки...'
        skipping        = 'Существующий файл пропущен: {0}'
        no_subject      = '(без темы)'
        no_length       = 'Загрузка MIME не вернула длину файла.'
        failed_item     = 'Ошибка {0}: {1}'
        done            = 'Выгрузка завершена: загружено {0:N0}, пропущено {1:N0}, ошибок {2:N0}, добавлено {3:N2} МиБ.'
        outdir          = 'Каталог вывода: {0}'
        interrupted     = 'Выгрузка прервана. Готовые письма и контрольные точки сохранены; запустите скрипт заново, чтобы продолжить.'
    }
}

function Resolve-Language {
    param([string]$Requested)

    if ($Requested -and $Requested -ne 'auto') { return $Requested }
    $culture = [Globalization.CultureInfo]::CurrentUICulture
    $name = [string]$culture.Name
    if ($script:Messages.ContainsKey($name)) { return $name }
    # Chinese comes in many tags (zh-Hans-CN, zh-HK, zh-Hant-TW); split by script, not region
    if ($name -like 'zh*') {
        if ($name -match 'Hant|TW|HK|MO') { return 'zh-TW' }
        return 'zh-CN'
    }
    $two = [string]$culture.TwoLetterISOLanguageName
    if ($script:Messages.ContainsKey($two)) { return $two }
    return 'en'
}

$ActiveLang = Resolve-Language -Requested $Lang
$Strings = $Messages[$ActiveLang]
$FallbackStrings = $Messages['en']

# Returns the format string for a key; callers apply -f themselves so that
# PowerShell's own format specifiers ({0:N0}) keep working per language.
function L {
    param([Parameter(Mandatory)] [string]$Key)

    if ($script:Strings.ContainsKey($Key)) { return [string]$script:Strings[$Key] }
    if ($script:FallbackStrings.ContainsKey($Key)) { return [string]$script:FallbackStrings[$Key] }
    return $Key
}

# ---------------------------------------------------------------------------

$GraphRoot = "https://graph.microsoft.com/v1.0"
$GraphPowerShellClientId = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
$OAuthTenant = if ($TenantId) { $TenantId } else { "organizations" }
$OAuthScope = "openid profile offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read"
$TokenEndpoint = "https://login.microsoftonline.com/$OAuthTenant/oauth2/v2.0/token"
$DeviceCodeEndpoint = "https://login.microsoftonline.com/$OAuthTenant/oauth2/v2.0/devicecode"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$InvalidFileChars = '[<>:"/\\|?*\x00-\x1f]'
$ReservedNames = @('CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9')
$AccessToken = $null
$RefreshToken = $null
$TokenExpiresAt = [DateTimeOffset]::MinValue
$HttpHandler = [Net.Http.HttpClientHandler]::new()
# Some Windows networks cannot reach the certificate revocation endpoint. Certificate
# chain and host-name validation stay enabled; only the online revocation lookup is off.
$HttpHandler.CheckCertificateRevocationList = $false
$HttpClient = [Net.Http.HttpClient]::new($HttpHandler)
$HttpClient.Timeout = [TimeSpan]::FromMinutes(10)

function Invoke-FormPost {
    param([Parameter(Mandatory)] [string]$Uri, [Parameter(Mandatory)] [hashtable]$Fields)

    for ($attempt = 0; $attempt -le 4; $attempt++) {
        $pairs = [Collections.Generic.List[Collections.Generic.KeyValuePair[string,string]]]::new()
        foreach ($entry in $Fields.GetEnumerator()) {
            $pairs.Add([Collections.Generic.KeyValuePair[string,string]]::new([string]$entry.Key, [string]$entry.Value))
        }
        $content = [Net.Http.FormUrlEncodedContent]::new($pairs)
        $response = $null
        try {
            $response = $script:HttpClient.PostAsync($Uri, $content).GetAwaiter().GetResult()
            $raw = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $json = if ($raw) { $raw | ConvertFrom-Json } else { $null }
            return [pscustomobject]@{
                IsSuccess = $response.IsSuccessStatusCode
                StatusCode = [int]$response.StatusCode
                Json = $json
                Raw = $raw
            }
        }
        catch {
            if ($attempt -eq 4) { throw ((L 'net_oauth_fail') -f $_.Exception.Message) }
            Start-Sleep -Seconds ([Math]::Min(10, [Math]::Pow(2, $attempt)))
        }
        finally {
            if ($response) { $response.Dispose() }
            $content.Dispose()
        }
    }
}

function Set-OAuthToken {
    param([Parameter(Mandatory)] $TokenResponse)

    if (-not $TokenResponse.access_token) {
        throw (L 'no_token')
    }
    $script:AccessToken = [string]$TokenResponse.access_token
    if ($TokenResponse.refresh_token) { $script:RefreshToken = [string]$TokenResponse.refresh_token }
    $lifetime = if ($TokenResponse.expires_in) { [int]$TokenResponse.expires_in } else { 3600 }
    $script:TokenExpiresAt = [DateTimeOffset]::UtcNow.AddSeconds($lifetime)
}

function Start-MicrosoftDeviceLogin {
    $deviceResult = Invoke-FormPost -Uri $script:DeviceCodeEndpoint -Fields @{
        client_id = $script:GraphPowerShellClientId
        scope = $script:OAuthScope
    }
    if (-not $deviceResult.IsSuccess) {
        throw ((L 'dev_session_fail') -f $deviceResult.Json.error_description)
    }
    $device = $deviceResult.Json
    if (-not $device.device_code -or -not $device.user_code) {
        throw (L 'no_dev_code')
    }

    Write-Host ''
    Write-Host (L 'browser_open') -ForegroundColor Cyan
    Write-Host ((L 'signin_code') -f $device.user_code) -ForegroundColor Yellow
    Write-Host (L 'signin_hint') -ForegroundColor Cyan
    try { Set-Clipboard -Value $device.user_code -ErrorAction Stop; Write-Host (L 'clip_ok') }
    catch { }
    Start-Process ([string]$device.verification_uri)

    $interval = if ($device.interval) { [int]$device.interval } else { 5 }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds([int]$device.expires_in)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds $interval
        $tokenResult = Invoke-FormPost -Uri $script:TokenEndpoint -Fields @{
            client_id = $script:GraphPowerShellClientId
            grant_type = 'urn:ietf:params:oauth:grant-type:device_code'
            device_code = [string]$device.device_code
        }
        if ($tokenResult.IsSuccess) {
            Set-OAuthToken -TokenResponse $tokenResult.Json
            return
        }
        $oauthError = $tokenResult.Json
        switch ([string]$oauthError.error) {
            'authorization_pending' { continue }
            'slow_down' { $interval += 5; continue }
            'authorization_declined' { throw (L 'declined') }
            'expired_token' { throw (L 'code_expired') }
            default { throw ((L 'oauth_fail') -f $oauthError.error_description) }
        }
    }
    throw (L 'signin_timeout')
}

function Update-OAuthToken {
    if (-not $script:RefreshToken) {
        Start-MicrosoftDeviceLogin
        return
    }
    $tokenResult = Invoke-FormPost -Uri $script:TokenEndpoint -Fields @{
        client_id = $script:GraphPowerShellClientId
        grant_type = 'refresh_token'
        refresh_token = $script:RefreshToken
        scope = $script:OAuthScope
    }
    if (-not $tokenResult.IsSuccess) {
        throw ((L 'refresh_fail') -f $tokenResult.Json.error_description)
    }
    Set-OAuthToken -TokenResponse $tokenResult.Json
}

function Get-OAuthAccessToken {
    param([switch]$ForceRefresh)

    if ($ForceRefresh -or -not $script:AccessToken -or [DateTimeOffset]::UtcNow -ge $script:TokenExpiresAt.AddMinutes(-2)) {
        Update-OAuthToken
    }
    return $script:AccessToken
}

function Write-JsonAtomic {
    param([Parameter(Mandatory)] [string]$Path, [Parameter(Mandatory)] $Value)

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $temporary = "$Path.tmp"
    $json = ConvertTo-Json -InputObject $Value -Depth 30
    [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, $script:Utf8NoBom)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-RelativeExportPath {
    param([Parameter(Mandatory)] [string]$Root, [Parameter(Mandatory)] [string]$Path)

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $pathFull = [IO.Path]::GetFullPath($Path)
    if (-not $pathFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw ((L 'path_outside') -f $pathFull)
    }
    return $pathFull.Substring($rootFull.Length + 1).Replace('\', '/')
}

function Get-StableHash {
    param([Parameter(Mandatory)] [string]$Text)

    $sha1 = [Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha1.ComputeHash($bytes)
        return ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()).Substring(0, 8)
    }
    finally {
        $sha1.Dispose()
    }
}

function Get-SafeComponent {
    param([Parameter(Mandatory)] [string]$Name, [Parameter(Mandatory)] [string]$StableId)

    $value = ([regex]::Replace($Name, $script:InvalidFileChars, '_')).Trim().TrimEnd('.', ' ')
    if ([string]::IsNullOrWhiteSpace($value)) { $value = 'unnamed' }
    if ($script:ReservedNames -contains $value.ToUpperInvariant()) { $value = "_$value" }
    if ($value.Length -gt 80) {
        $value = $value.Substring(0, 70).TrimEnd() + '--' + (Get-StableHash $StableId)
    }
    return $value
}

function Invoke-GraphJson {
    param([Parameter(Mandatory)] [string]$Uri)

    $refreshed = $false
    for ($attempt = 0; $attempt -le 7; $attempt++) {
        $request = $null
        $response = $null
        $status = $null
        try {
            $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Uri)
            [void]$request.Headers.TryAddWithoutValidation('Authorization', 'Bearer ' + (Get-OAuthAccessToken))
            [void]$request.Headers.TryAddWithoutValidation('Prefer', 'IdType="ImmutableId"')
            $response = $script:HttpClient.SendAsync($request).GetAwaiter().GetResult()
            $status = [int]$response.StatusCode
            $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

            if ($status -eq 401 -and -not $refreshed) {
                [void](Get-OAuthAccessToken -ForceRefresh)
                $refreshed = $true
                continue
            }
            if ($status -in @(429, 500, 502, 503, 504) -and $attempt -lt 7) {
                $delay = [Math]::Min(60, [Math]::Pow(2, $attempt))
                Write-Warning ((L 'graph_retry') -f $status, $delay)
                Start-Sleep -Seconds $delay
                continue
            }
            if (-not $response.IsSuccessStatusCode) {
                try { $detail = ($body | ConvertFrom-Json).error.message }
                catch { $detail = $body }
                throw ((L 'graph_http') -f $status, $detail)
            }
            return $body | ConvertFrom-Json
        }
        catch {
            if ($null -ne $status -or $attempt -eq 7) { throw }
            $delay = [Math]::Min(60, [Math]::Pow(2, $attempt))
            Write-Warning ((L 'graph_net_retry') -f $delay, $_.Exception.Message)
            Start-Sleep -Seconds $delay
        }
        finally {
            if ($response) { $response.Dispose() }
            if ($request) { $request.Dispose() }
        }
    }
}

function Get-GraphCollection {
    param([Parameter(Mandatory)] [string]$Uri)

    $items = [Collections.Generic.List[object]]::new()
    $next = $Uri
    while ($next) {
        $response = Invoke-GraphJson -Uri $next
        foreach ($item in @($response.value)) { $items.Add($item) }
        $next = $response.'@odata.nextLink'
    }
    return $items
}

function Save-GraphMime {
    param(
        [Parameter(Mandatory)] [string]$MessageId,
        [Parameter(Mandatory)] [string]$Destination
    )

    $encodedId = [Uri]::EscapeDataString($MessageId)
    $uri = "$script:GraphRoot/me/messages/$encodedId/`$value"
    $temporary = "$Destination.part"

    $refreshed = $false
    for ($attempt = 0; $attempt -le 7; $attempt++) {
        $request = $null
        $response = $null
        $fileStream = $null
        $status = $null
        try {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
            $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $uri)
            [void]$request.Headers.TryAddWithoutValidation('Authorization', 'Bearer ' + (Get-OAuthAccessToken))
            [void]$request.Headers.TryAddWithoutValidation('Prefer', 'IdType="ImmutableId"')
            [void]$request.Headers.TryAddWithoutValidation('Accept', 'message/rfc822')
            $response = $script:HttpClient.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            $status = [int]$response.StatusCode

            if ($status -eq 401 -and -not $refreshed) {
                [void](Get-OAuthAccessToken -ForceRefresh)
                $refreshed = $true
                continue
            }
            if ($status -in @(429, 500, 502, 503, 504) -and $attempt -lt 7) {
                $delay = [Math]::Min(60, [Math]::Pow(2, $attempt))
                Write-Warning ((L 'mime_retry') -f $status, $delay)
                Start-Sleep -Seconds $delay
                continue
            }
            if (-not $response.IsSuccessStatusCode) {
                $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                try { $detail = ($body | ConvertFrom-Json).error.message }
                catch { $detail = $body }
                throw ((L 'graph_http') -f $status, $detail)
            }

            $fileStream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $response.Content.CopyToAsync($fileStream).GetAwaiter().GetResult()
            $fileStream.Flush($true)
            $fileStream.Dispose()
            $fileStream = $null
            [IO.File]::Move($temporary, $Destination)
            return (Get-Item -LiteralPath $Destination).Length
        }
        catch {
            if ($fileStream) { $fileStream.Dispose(); $fileStream = $null }
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
            if ($null -ne $status -or $attempt -eq 7) { throw }
            $delay = [Math]::Min(60, [Math]::Pow(2, $attempt))
            Write-Warning ((L 'mime_net_retry') -f $delay, $_.Exception.Message)
            Start-Sleep -Seconds $delay
        }
        finally {
            if ($fileStream) { $fileStream.Dispose() }
            if ($response) { $response.Dispose() }
            if ($request) { $request.Dispose() }
        }
    }
}

function Get-MailFolders {
    param([Parameter(Mandatory)] [string]$OutputRoot, [bool]$IncludeHidden)

    $select = 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount,isHidden'
    $folders = [Collections.Generic.List[object]]::new()
    $queue = [Collections.Generic.Queue[object]]::new()
    $queue.Enqueue([pscustomobject]@{ ParentId = $null; FolderPath = ''; OutputPath = $OutputRoot })

    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        if ($null -eq $parent.ParentId) {
            $baseUri = "$script:GraphRoot/me/mailFolders"
        }
        else {
            $encodedParent = [Uri]::EscapeDataString([string]$parent.ParentId)
            $baseUri = "$script:GraphRoot/me/mailFolders/$encodedParent/childFolders"
        }
        $uri = $baseUri + '?includeHiddenFolders=' + $IncludeHidden.ToString().ToLowerInvariant() + '&$select=' + [Uri]::EscapeDataString($select) + '&$top=200'
        $children = @(Get-GraphCollection -Uri $uri | Sort-Object @{ Expression = { $_.displayName.ToLowerInvariant() } }, id)
        $used = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

        foreach ($child in $children) {
            $name = if ([string]::IsNullOrWhiteSpace([string]$child.displayName)) { 'unnamed' } else { [string]$child.displayName }
            $component = Get-SafeComponent -Name $name -StableId ([string]$child.id)
            if (-not $used.Add($component)) {
                $component = $component.Substring(0, [Math]::Min(69, $component.Length)) + '--' + (Get-StableHash ([string]$child.id))
                [void]$used.Add($component)
            }
            $folderPath = if ($parent.FolderPath) { "$($parent.FolderPath)/$name" } else { $name }
            $folderOutput = Join-Path $parent.OutputPath $component
            $folder = [pscustomobject]@{
                Id = [string]$child.id
                DisplayName = $name
                FolderPath = $folderPath
                OutputPath = $folderOutput
                GraphData = $child
            }
            $folders.Add($folder)
            $queue.Enqueue([pscustomobject]@{ ParentId = $child.id; FolderPath = $folderPath; OutputPath = $folderOutput })
        }
    }
    return $folders
}

function Get-FolderManifest {
    param([Parameter(Mandatory)] $Folders, [Parameter(Mandatory)] [string]$OutputRoot)

    return @(
        foreach ($folder in $Folders) {
            [ordered]@{
                id = $folder.Id
                displayName = $folder.DisplayName
                parentFolderId = $folder.GraphData.parentFolderId
                childFolderCount = $folder.GraphData.childFolderCount
                totalItemCount = $folder.GraphData.totalItemCount
                unreadItemCount = $folder.GraphData.unreadItemCount
                isHidden = $folder.GraphData.isHidden
                folderPath = $folder.FolderPath
                outputDirectory = Get-RelativeExportPath -Root $OutputRoot -Path $folder.OutputPath
            }
        }
    )
}

function New-MessageRecord {
    param($Message, $Folder, [string]$RelativeFile, [int]$Sequence)

    return [pscustomobject][ordered]@{
        id = [string]$Message.id
        internetMessageId = $Message.internetMessageId
        folderId = $Folder.Id
        folderPath = $Folder.FolderPath
        emlFile = $RelativeFile
        receivedDateTime = $Message.receivedDateTime
        sentDateTime = $Message.sentDateTime
        createdDateTime = $Message.createdDateTime
        lastModifiedDateTime = $Message.lastModifiedDateTime
        isRead = $Message.isRead
        isDraft = $Message.isDraft
        importance = $Message.importance
        categories = @($Message.categories)
        flag = $Message.flag
        subject = $Message.subject
        hasAttachments = $Message.hasAttachments
        conversationId = $Message.conversationId
        _sequence = $Sequence
    }
}

function Add-JournalRecord {
    param([Parameter(Mandatory)] [string]$Path, [Parameter(Mandatory)] $Record)

    $line = $Record | ConvertTo-Json -Depth 15 -Compress
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = $script:Utf8NoBom.GetBytes($line + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally {
        $stream.Dispose()
    }
}

function Write-MessagesManifest {
    param([hashtable]$Completed, [string]$OutputRoot)

    $records = @(
        @(
            foreach ($record in $Completed.Values) {
                if ($record.emlFile -and (Test-Path -LiteralPath (Join-Path $OutputRoot $record.emlFile))) {
                    $record | Select-Object * -ExcludeProperty _sequence
                }
            }
        ) | Sort-Object folderPath, emlFile
    )
    Write-JsonAtomic -Path (Join-Path $OutputRoot 'messages.json') -Value @($records)
}

function Format-RemainingTime {
    param([double]$Seconds)

    if ([double]::IsNaN($Seconds) -or [double]::IsInfinity($Seconds) -or $Seconds -lt 0) {
        return (L 'estimating')
    }
    $duration = [TimeSpan]::FromSeconds([Math]::Ceiling($Seconds))
    if ($duration.TotalDays -ge 1) {
        return ('{0}d {1:00}:{2:00}:{3:00}' -f [Math]::Floor($duration.TotalDays), $duration.Hours, $duration.Minutes, $duration.Seconds)
    }
    return ('{0:00}:{1:00}:{2:00}' -f $duration.Hours, $duration.Minutes, $duration.Seconds)
}

function Write-ExportProgress {
    param(
        [long]$OverallProcessed,
        [long]$OverallTotal,
        [int]$Downloaded,
        [int]$Skipped,
        [int]$Failed,
        [long]$RemainingAtStart,
        [Nullable[DateTimeOffset]]$WorkStartedAt,
        [string]$FolderPath,
        [long]$FolderProcessed,
        [long]$FolderTotal,
        [string]$CurrentItem
    )

    $boundedProcessed = [Math]::Min([Math]::Max(0, $OverallProcessed), [Math]::Max(0, $OverallTotal))
    $overallPercent = if ($OverallTotal -gt 0) { [Math]::Min(100, 100.0 * $boundedProcessed / $OverallTotal) } else { 100 }
    $workDone = $Downloaded + $Failed
    $eta = L 'estimating'
    if ($workDone -gt 0 -and $WorkStartedAt.HasValue) {
        $elapsedSeconds = ([DateTimeOffset]::Now - $WorkStartedAt.Value).TotalSeconds
        $remainingWork = [Math]::Max(0, $RemainingAtStart - $workDone)
        $eta = Format-RemainingTime (($elapsedSeconds / $workDone) * $remainingWork)
    }
    elseif ($RemainingAtStart -le 0) {
        $eta = '00:00:00'
    }

    $overallStatus = ((L 'overall_status') -f `
        $overallPercent, $boundedProcessed, $OverallTotal, $Downloaded, $Skipped, $Failed, $eta)
    Write-Progress -Id 1 -Activity (L 'activity') -Status $overallStatus -PercentComplete $overallPercent -CurrentOperation $CurrentItem

    $boundedFolderProcessed = [Math]::Min([Math]::Max(0, $FolderProcessed), [Math]::Max(0, $FolderTotal))
    $folderPercent = if ($FolderTotal -gt 0) { [Math]::Min(100, 100.0 * $boundedFolderProcessed / $FolderTotal) } else { 100 }
    $folderStatus = ((L 'folder_status') -f $boundedFolderProcessed, $FolderTotal)
    Write-Progress -Id 2 -ParentId 1 -Activity ((L 'folder_label') -f $FolderPath) -Status $folderStatus -PercentComplete $folderPercent -CurrentOperation $CurrentItem
}

try {
    Start-MicrosoftDeviceLogin
    $userProfile = Invoke-GraphJson -Uri "$GraphRoot/me?`$select=userPrincipalName,mail,displayName"
    $account = if ($userProfile.userPrincipalName) { $userProfile.userPrincipalName } elseif ($userProfile.mail) { $userProfile.mail } else { $userProfile.displayName }
    Write-Host ((L 'signed_in') -f $account) -ForegroundColor Green

    $outputRoot = [IO.Path]::GetFullPath($Output)
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    $stateDir = Join-Path $outputRoot '.state'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $journalPath = Join-Path $stateDir 'completed.jsonl'
    if (-not (Test-Path -LiteralPath $journalPath)) { [IO.File]::WriteAllText($journalPath, '', $Utf8NoBom) }

    Write-Host (L 'discovering') -ForegroundColor Cyan
    $folders = @(Get-MailFolders -OutputRoot $outputRoot -IncludeHidden (-not $NoHidden))
    Write-JsonAtomic -Path (Join-Path $outputRoot 'folders.json') -Value @(Get-FolderManifest -Folders $folders -OutputRoot $outputRoot)
    Write-Host ((L 'found_folders') -f $folders.Count) -ForegroundColor Green
    if ($FoldersOnly) { exit 0 }

    $completed = @{}
    $sequenceByFolder = @{}
    foreach ($line in Get-Content -LiteralPath $journalPath -Encoding UTF8) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $record = $line | ConvertFrom-Json }
        catch { Write-Warning (L 'bad_checkpoint'); continue }
        if (-not $record.id) { continue }
        $completed[[string]$record.id] = $record
        $folderId = [string]$record.folderId
        $sequence = [int]$record._sequence
        if (-not $sequenceByFolder.ContainsKey($folderId) -or $sequence -gt $sequenceByFolder[$folderId]) {
            $sequenceByFolder[$folderId] = $sequence
        }
    }

    $failures = [Collections.Generic.List[object]]::new()
    $downloaded = 0
    $skipped = 0
    $failed = 0
    [long]$downloadedBytes = 0
    $messageSelect = 'id,internetMessageId,parentFolderId,receivedDateTime,sentDateTime,createdDateTime,lastModifiedDateTime,isRead,isDraft,importance,categories,flag,subject,hasAttachments,conversationId'

    [long]$estimatedTotal = 0
    foreach ($folderItem in $folders) {
        $estimatedTotal = $estimatedTotal + [long]$folderItem.GraphData.totalItemCount
    }
    $preCountedIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($record in $completed.Values) {
        if ($record.emlFile -and (Test-Path -LiteralPath (Join-Path $outputRoot $record.emlFile))) {
            [void]$preCountedIds.Add([string]$record.id)
        }
    }
    [long]$overallProcessed = [Math]::Min($estimatedTotal, $preCountedIds.Count)
    [long]$remainingAtStart = [Math]::Max(0, $estimatedTotal - $overallProcessed)
    [Nullable[DateTimeOffset]]$workStartedAt = $null
    Write-Host ((L 'estimate') -f $estimatedTotal, $overallProcessed, $remainingAtStart) -ForegroundColor Cyan

    for ($folderIndex = 0; $folderIndex -lt $folders.Count; $folderIndex++) {
        $folder = $folders[$folderIndex]
        [long]$folderTotal = [long]$folder.GraphData.totalItemCount
        [long]$folderProcessed = 0
        New-Item -ItemType Directory -Path $folder.OutputPath -Force | Out-Null
        Write-Host ((L 'folder_head') -f ($folderIndex + 1), $folders.Count, $folder.FolderPath, $folderTotal)
        Write-ExportProgress -OverallProcessed $overallProcessed -OverallTotal $estimatedTotal `
            -Downloaded $downloaded -Skipped $skipped -Failed $failed -RemainingAtStart $remainingAtStart `
            -WorkStartedAt $workStartedAt -FolderPath $folder.FolderPath -FolderProcessed $folderProcessed `
            -FolderTotal $folderTotal -CurrentItem (L 'preparing')
        $encodedFolder = [Uri]::EscapeDataString($folder.Id)
        $uri = "$GraphRoot/me/mailFolders/$encodedFolder/messages?`$select=$([Uri]::EscapeDataString($messageSelect))&`$top=$PageSize"

        while ($uri) {
            $page = Invoke-GraphJson -Uri $uri
            foreach ($message in @($page.value)) {
                $messageId = [string]$message.id
                if ($completed.ContainsKey($messageId)) {
                    $existing = $completed[$messageId]
                    if ($existing.emlFile -and (Test-Path -LiteralPath (Join-Path $outputRoot $existing.emlFile))) {
                        $skipped = $skipped + 1
                        $folderProcessed = $folderProcessed + 1
                        if (-not $preCountedIds.Remove($messageId)) {
                            $overallProcessed = $overallProcessed + 1
                        }
                        $currentItem = ((L 'skipping') -f $existing.emlFile)
                        Write-ExportProgress -OverallProcessed $overallProcessed -OverallTotal $estimatedTotal `
                            -Downloaded $downloaded -Skipped $skipped -Failed $failed -RemainingAtStart $remainingAtStart `
                            -WorkStartedAt $workStartedAt -FolderPath $folder.FolderPath -FolderProcessed $folderProcessed `
                            -FolderTotal $folderTotal -CurrentItem $currentItem
                        continue
                    }
                }

                $sequence = if ($sequenceByFolder.ContainsKey($folder.Id)) { [int]$sequenceByFolder[$folder.Id] + 1 } else { 1 }
                do {
                    $destination = Join-Path $folder.OutputPath ('{0:D6}.eml' -f $sequence)
                    if (Test-Path -LiteralPath $destination) { $sequence++ }
                } while (Test-Path -LiteralPath $destination)
                $sequenceByFolder[$folder.Id] = $sequence
                $relativeFile = Get-RelativeExportPath -Root $outputRoot -Path $destination
                $subject = if ($message.subject) { [string]$message.subject } else { (L 'no_subject') }
                $subject = ($subject -replace '[\r\n\t]+', ' ').Trim()
                if ($subject.Length -gt 100) { $subject = $subject.Substring(0, 97) + '...' }
                $currentItem = "$relativeFile | $subject"
                if (-not $workStartedAt.HasValue) { $workStartedAt = [DateTimeOffset]::Now }

                try {
                    # PowerShell can aggregate incidental function output into Object[]. The
                    # final emitted value is the MIME file length; explicitly scalarize it.
                    $downloadResult = @(Save-GraphMime -MessageId $messageId -Destination $destination)
                    if ($downloadResult.Count -eq 0) { throw (L 'no_length') }
                    $byteCount = [long]$downloadResult[$downloadResult.Count - 1]
                    $record = New-MessageRecord -Message $message -Folder $folder -RelativeFile $relativeFile -Sequence $sequence
                    Add-JournalRecord -Path $journalPath -Record $record
                    $completed[$messageId] = $record
                    $downloaded = $downloaded + 1
                    $downloadedBytes = [long]$downloadedBytes + $byteCount
                }
                catch {
                    $failed = $failed + 1
                    $failure = [pscustomobject][ordered]@{
                        id = $messageId
                        internetMessageId = $message.internetMessageId
                        folderId = $folder.Id
                        folderPath = $folder.FolderPath
                        destination = $relativeFile
                        error = $_.Exception.Message
                        scriptStackTrace = $_.ScriptStackTrace
                    }
                    $failures.Add($failure)
                    Write-Warning ((L 'failed_item') -f $relativeFile, $_.Exception.Message)
                }
                $folderProcessed = $folderProcessed + 1
                $overallProcessed = $overallProcessed + 1
                Write-ExportProgress -OverallProcessed $overallProcessed -OverallTotal $estimatedTotal `
                    -Downloaded $downloaded -Skipped $skipped -Failed $failed -RemainingAtStart $remainingAtStart `
                    -WorkStartedAt $workStartedAt -FolderPath $folder.FolderPath -FolderProcessed $folderProcessed `
                    -FolderTotal $folderTotal -CurrentItem $currentItem
            }
            Write-MessagesManifest -Completed $completed -OutputRoot $outputRoot
            Write-JsonAtomic -Path (Join-Path $outputRoot 'failures.json') -Value @($failures)
            $uri = $page.'@odata.nextLink'
        }
        Write-Progress -Id 2 -ParentId 1 -Activity ((L 'folder_label') -f $folder.FolderPath) -Completed
    }

    Write-Progress -Id 1 -Activity (L 'activity') -Completed
    Write-MessagesManifest -Completed $completed -OutputRoot $outputRoot
    Write-JsonAtomic -Path (Join-Path $outputRoot 'failures.json') -Value @($failures)
    $mib = $downloadedBytes / 1MB
    Write-Host ((L 'done') -f $downloaded, $skipped, $failed, $mib) -ForegroundColor Green
    Write-Host ((L 'outdir') -f $outputRoot)
    if ($failed -gt 0) { exit 2 }
    exit 0
}
catch [Management.Automation.PipelineStoppedException] {
    Write-Warning (L 'interrupted')
    exit 130
}
catch {
    Write-Error $_
    exit 1
}
finally {
    $AccessToken = $null
    $RefreshToken = $null
    if ($HttpClient) { $HttpClient.Dispose() }
    if ($HttpHandler) { $HttpHandler.Dispose() }
}
