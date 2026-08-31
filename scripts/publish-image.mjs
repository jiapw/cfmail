#!/usr/bin/env node
// Publish the backup container image, so that nobody installing CFMail has to build one.
//
//   node scripts/publish-image.mjs --repo docker.io/<namespace>/cfmail-backup
//
// This is a maintainer's command, run when container/ changes and at no other time. It builds the
// image, pushes it to a PUBLIC repository, and writes container/published.json -- which is what
// every deploy then reads instead of reaching for Docker.
//
// WHY A PUBLIC REGISTRY AND NOT THIS REPOSITORY
// The image is a couple of hundred megabytes of Alpine and 7-Zip. Committing that would put it in
// every clone forever, for a file that changes a few times a year and that Git cannot diff. A
// registry is the thing built for shipping binaries; Cloudflare pulls public images itself, with
// no credentials, which is what lets an installation need neither Docker nor an account.
//
// WHY THE HASH IS RECORDED WITH IT
// A published image is a claim about source. published.json carries the hash of container/ at the
// moment of the push, and the deploy honours the image only while that hash still matches its own
// checkout. Edit container/ without publishing and deploys quietly go back to building locally --
// which is right, because by then the published image is somebody else's code.
//
// 发布备份容器镜像,好让装 CFMail 的人都不必自己构建。
//
// 这是维护者的命令,只在 container/ 变动时跑。它构建镜像、推到**公共**仓库,
// 并写下 container/published.json —— 此后每次部署读的就是它,而不是去找 Docker。
//
// 为什么用公共镜像仓库而不是提交进本仓库
// 这个镜像是两百来兆的 Alpine 加 7-Zip。提交进去等于让此后每一次 clone 都永远背着它,
// 而这个文件一年只变几次、Git 还没法对它做差分。镜像仓库正是为分发二进制而生的东西;
// 公共镜像由 Cloudflare 自己去拉、不需要任何凭据 —— 这才使得一套安装既不需要 Docker、也不需要账号。
//
// 为什么要把哈希一起记下来
// 已发布的镜像是一句关于源码的断言。published.json 记着推送那一刻 container/ 的哈希,
// 而部署只在这个哈希仍等于自己 checkout 里的哈希时才认这个镜像。
// 改了 container/ 却没发布,部署就自动退回本地构建 —— 这是对的,因为那时那个镜像装的已是别人的代码。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'container');
const PIN = path.join(DIR, 'published.json');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
  else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[a.slice(2)] = process.argv[++i];
  else args[a.slice(2)] = true;
}

const die = (m) => { console.error('\n✗ ' + m + '\n'); process.exit(1); };
const log = (s) => console.log('  ' + s);
const step = (s) => console.log('\n▸ ' + s);

if (args.help || !args.repo) {
  console.log(`
Usage:
  node scripts/publish-image.mjs --repo docker.io/<namespace>/cfmail-backup [--tag <tag>]

  --repo <r>   Public repository to push to. Cloudflare can pull from Docker Hub, Amazon ECR
               and Google Artifact Registry; a public image needs no credentials to pull.
  --tag <t>    Tag to publish. Defaults to the hash of container/, which is what makes a tag
               mean one exact source tree.
  --docker <c> The docker command, if it is not "docker" (e.g. "wsl -d Debian docker").
  --dry-run    Say what would happen and change nothing.

  Push access is your own: run docker login first. Nobody installing CFMail needs an account
  here -- public images are pulled anonymously, by Cloudflare, not by them.
`);
  process.exit(args.help ? 0 : 1);
}

/** The same hash the deploy computes, so the two always agree about what "this source" is */
function containerHash() {
  const names = fs.readdirSync(DIR).filter((n) => n !== 'published.json').sort();
  const h = crypto.createHash('sha256');
  for (const n of names) {
    h.update(n);
    h.update(fs.readFileSync(path.join(DIR, n)));
  }
  return h.digest('hex').slice(0, 12);
}

const hash = containerHash();
const tag = args.tag || hash;
const image = `${String(args.repo).replace(/:.*$/, '')}:${tag}`;
const docker = String(args.docker || 'docker').split(' ');

console.log('\n=== Publish the backup container image ===');
log(`source hash  ${hash}`);
log(`image        ${image}`);
if (args['dry-run']) {
  console.log('\n--dry-run stops here. Nothing was built, pushed or written.\n');
  process.exit(0);
}

const run = (argv) => {
  const r = spawnSync(docker[0], [...docker.slice(1), ...argv], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) die(`could not run ${docker.join(' ')}: ${r.error.message}`);
  return r.status ?? 1;
};

step('Build');
// linux/amd64 explicitly: Containers run there, and a maintainer on an ARM laptop would otherwise
// publish an image that fails to start for everybody -- once, quietly, and only in production.
// 明确 linux/amd64:容器跑在那上面,而用 ARM 笔记本的维护者若不指定,
// 会发布一个所有人都起不来的镜像 —— 只错一次、悄无声息,而且只在生产上现形。
if (run(['build', '--platform', 'linux/amd64', '-t', image, 'container']) !== 0) die('the build failed');

step('Push');
if (run(['push', image]) !== 0) {
  die('the push failed. Public repositories still need push rights: docker login, and make sure\n'
    + '  the repository exists and is public.');
}

step('Record it');
fs.writeFileSync(PIN, JSON.stringify({ image, source: hash }, null, 2) + '\n', 'utf8');
log(`container/published.json -> ${image}`);
console.log('\nDone. Commit container/published.json: from now on a deploy pulls this image and');
console.log('nobody needs Docker to install CFMail.\n');
