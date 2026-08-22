// Which editor opens which file, decided in one place.
//
// Three modules need this answer and they must not each have their own: the file list decides
// whether to offer Edit and where the entry points, the router decides which module to load, and
// the editors decide what they are willing to open. Three copies of one list is three chances for
// a menu entry to lead somewhere that will not have it.
//
// 哪个编辑器打开哪种文件,在一个地方决定。
//
// 有三个模块需要这个答案,而它们不能各持一份:文件列表要决定是否提供"编辑"、以及那一项指向哪里,
// 路由要决定加载哪个模块,编辑器要决定自己愿意打开什么。
// 同一份清单存三份,就是三次机会让一个菜单项通向一个不肯接待它的地方。

export const extOf = (name) => (/\.([A-Za-z0-9]{1,12})$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();

/** Written to be read as prose. / 写来当散文读的。 */
export const MD_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd']);

/** Text that is not prose: source, configuration, data, logs. The list is what the code editor
 *  will colour or at least count lines for -- and a name with no extension at all belongs to it,
 *  because that is what a Makefile, a LICENSE and a Dockerfile look like.
 *  不是散文的文本:源码、配置、数据、日志。这份清单是代码编辑器愿意着色、
 *  至少愿意为之标行号的东西 —— 完全没有扩展名的名字也属于它,
 *  因为 Makefile、LICENSE、Dockerfile 长的就是那个样子。 */
export const TEXT_EXTS = new Set([
  'txt', 'text', 'log', 'csv', 'tsv', 'srt', 'vtt', 'ass', 'me', 'nfo',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'json5', 'webmanifest',
  'py', 'pyw', 'rb', 'gemfile', 'rake', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'sc',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'ino', 'cs', 'swift', 'dart', 'm', 'mm',
  'php', 'phtml', 'pl', 'pm', 'lua', 'r', 'clj', 'cljs', 'edn', 'hs', 'erl', 'ex', 'exs',
  'sh', 'bash', 'zsh', 'ksh', 'bashrc', 'ps1', 'psm1', 'bat', 'cmd',
  'html', 'htm', 'vue', 'svelte', 'css', 'scss', 'less', 'sass', 'styl',
  'xml', 'svg', 'xsl', 'plist', 'xaml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg',
  'properties', 'env', 'sql', 'psql', 'mysql', 'diff', 'patch', 'dockerfile', 'nginx',
  'tex', 'latex', 'bib', 'vb', 'vbs', 'octave', 'gradle', 'lock', 'gitignore', 'editorconfig',
]);

/** 'md', 'code', or nothing at all. A file with no extension is taken as text: those are the ones
 *  that carry their kind in their name instead, and refusing them would refuse exactly the files
 *  somebody most often needs to open and look at.
 *  返回 'md'、'code',或者什么都不是。没有扩展名的文件按文本对待:
 *  这类文件是把自己的种类写在名字里的,而拒绝它们,恰恰是拒绝了人们最常需要打开看一眼的那些。 */
export function editorFor(name) {
  const e = extOf(name);
  if (MD_EXTS.has(e)) return 'md';
  if (!e || TEXT_EXTS.has(e)) return 'code';
  return null;
}

/** Where that editor lives, as an address. Editors are tabs, and a tab is a thing with a URL.
 *  那个编辑器住在哪儿,用地址表示。编辑器就是标签页,而标签页是有 URL 的东西。 */
export const editorHash = (kind, id) => `#/${kind}/${encodeURIComponent(id)}`;
