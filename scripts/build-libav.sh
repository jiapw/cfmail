#!/usr/bin/env bash
# Build the one libav.js variant this project needs and cannot get from npm.
#
# Everything else under public/vendor/ is copied from node_modules by sync-vendor.mjs. This one
# cannot be, because upstream does not publish it: the codecs it turns on are the ones whose
# patents make a maintainer decline to ship binaries, so the configuration exists in the repository
# and the build does not. So it is built here, once, and the result is committed -- see
# THIRD-PARTY-NOTICES.md for what that obliges.
#
# Needs Docker. Nothing else: the image is upstream's emsdk with pkg-config added, which is the
# whole of the build environment.
#
#   ./scripts/build-libav.sh                 # build into public/vendor/libav-full/
#   LIBAV_VERSION=6.10.9 ./scripts/build-libav.sh
#
# 构建这个项目唯一需要、却又从 npm 拿不到的那个 libav.js 变体。
#
# public/vendor/ 下的其余一切都由 sync-vendor.mjs 从 node_modules 拷贝。这一个不行,
# 因为上游不发布它:它开启的那些编码,其专利状况让维护者不愿分发二进制 ——
# 于是配置存在于仓库里,而构建不存在。所以在这里构建一次,把结果提交进来 ——
# 这带来什么义务,见 THIRD-PARTY-NOTICES.md。
#
# 需要 Docker,别的都不需要:那个镜像是上游的 emsdk 加一个 pkg-config,构建环境仅此而已。
set -euo pipefail

VERSION="${LIBAV_VERSION:-6.10.9}"
VARIANT="cfmail"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/public/vendor/libav-full"
WORK="${LIBAV_WORK:-$HERE/.libav-build}"

# The fragments, and why each one is there.
#
# The first line is what the stock `webcodecs` variant already is: containers this can open, parsers
# for the codecs the browser decodes itself, and Opus/FLAC/wav for sound it can handle without help.
# Everything after it is what upstream will not ship.
#
#   demuxer-avi/asf/flv  the boxes libav's published builds cannot open at all
#   decoder-ac3, -dca    the sound on a disc rip, which no browser decodes
#   encoder-aac          what that sound is turned into, because every browser plays AAC
#   avfilter, swresample the machinery those filters are made of. audio-filters names the
#                        filters; without the library and the resampler underneath them, the
#                        binding for building a filter graph is simply not there
#   audio-filters        the resampling and downmixing on the way -- 5.1 at 48k is not stereo
#   decoder-mpeg4/msmpeg4v3  Xvid and DivX: enough to draw a thumbnail of an old AVI. No
#                        colour conversion is built in with them -- the decoded planes go to
#                        WebCodecs as an I420 VideoFrame and the browser converts, in hardware.
#   decoder-wmav1/2/pro/lossless  a music folder from the Windows Media years. The wrapper is
#                        the part no browser reads, so the sound has to come out of it and go
#                        back in somewhere else -- and coming out means decoding it here.
#   decoder-mp3          not for MP3 files, which every browser plays. For the ones inside a
#                        .wma: several of these hold an ordinary MP3 stream, and the file is
#                        still unopenable, because what cannot be read is the box.
#   decoder-alac         Apple Lossless in an .m4a, for the browsers that decline it.
#
# 各个片段,以及每一个为什么在这里。
#
# 第一行就是现成的 `webcodecs` 变体本身:能打开的容器、浏览器自己会解的那些编码的解析器,
# 以及不需要帮忙就能处理的 Opus/FLAC/wav。它之后的每一样,都是上游不会分发的。
#
#   demuxer-avi/asf/flv  libav 已发布的构建根本打不开的那些盒子
#   decoder-ac3, -dca    碟版片源的声音,没有浏览器解得了
#   encoder-aac          那些声音被转成什么 —— 因为每个浏览器都放得了 AAC
#   avfilter, swresample 那些滤镜赖以构成的机器。audio-filters 点的是滤镜的名字;
#                        底下没有这个库和这个重采样器,"建一张滤镜图"的那个绑定根本就不存在
#   audio-filters        路上要做的重采样与缩混 —— 48k 的 5.1 不是立体声
#   decoder-mpeg4/msmpeg4v3  Xvid 与 DivX:够画出一张老 AVI 的缩略图。不随它们带色彩转换 ——
#                        解出来的平面作为 I420 的 VideoFrame 交给 WebCodecs,由浏览器硬件转换。
#   decoder-wmav1/2/pro/lossless  一个来自 Windows Media 年代的音乐文件夹。没有浏览器读得懂
#                        那层包装,所以声音必须从里面出来、再装进别处 —— 而"出来"就意味着在这里解码。
#   decoder-mp3          不是为了 MP3 文件,那个每个浏览器都放得了。是为了 .wma 里面的那些:
#                        这里好几个 .wma 装着一条普普通通的 MP3 流,而文件依然打不开 ——
#                        因为读不懂的是那个盒子。
#   decoder-alac         .m4a 里的 Apple Lossless,给那些不肯收它的浏览器。
FRAGMENTS='[
  "avformat","avcodec","avfilter","swresample",
  "format-ogg","format-webm","format-mp4",
  "parser-opus","codec-libopus","format-flac","parser-flac","codec-flac",
  "format-wav","codec-pcm_f32le",
  "parser-aac","parser-vp8","parser-vp9","parser-av1","parser-h264","parser-hevc",
  "bsf-extract_extradata","bsf-vp9_metadata","bsf-av1_metadata",
  "bsf-h264_metadata","bsf-hevc_metadata",
  "demuxer-avi","demuxer-asf","demuxer-flv",
  "parser-ac3","decoder-ac3","parser-dca","decoder-dca",
  "encoder-aac","audio-filters",
  "decoder-mpeg4","decoder-msmpeg4v3",
  "decoder-wmav1","decoder-wmav2","decoder-wmapro","decoder-wmalossless",
  "decoder-mp3","decoder-alac"
]'

# Docker may be next door rather than here.
#
# On Windows the shell that runs this has no `docker`, but the Linux beside it very well may: a
# WSL distribution is where Docker Engine lives when nobody wanted Docker Desktop. So if there is
# no docker here and there is one there, this goes there and runs again -- once, and only when the
# hop would actually help.
#
# The work directory moves too, and that is not a detail. A clone plus an FFmpeg build on /mnt is
# every file crossing the boundary between two filesystems, which turns a long build into a much
# longer one. Inside the distribution's own filesystem it is an ordinary build; the only thing that
# has to cross is the handful of files at the end.
#
# Docker 可能在隔壁,而不在这里。
#
# 在 Windows 上,跑这个脚本的 shell 没有 `docker`,但它旁边那个 Linux 很可能有:
# 当没人想要 Docker Desktop 时,Docker Engine 就住在某个 WSL 发行版里。
# 所以这里没有、那里有的话,就到那边去、再跑一遍 —— 只跳一次,而且只在这一跳真有帮助时跳。
#
# 工作目录也跟着搬,而这不是细节。在 /mnt 上做一次克隆加一次 FFmpeg 编译,
# 意味着每一个文件都要穿过两个文件系统之间的那道界,把一次长编译变成一次长得多的编译。
# 放进那个发行版自己的文件系统里,它就是一次普通的编译;需要穿界的只有最后那几个文件。
if ! command -v docker >/dev/null 2>&1; then
  if command -v wsl.exe >/dev/null 2>&1 && wsl.exe -e sh -c 'command -v docker' >/dev/null 2>&1; then
    # wsl.exe writes its own notices to stderr in UTF-16, so that stream is dropped and what is
    # left is stripped of nulls and carriage returns: the answer, not the commentary around it.
    # wsl.exe 会把它自己的提示以 UTF-16 写进 stderr,所以那个流被丢掉,
    # 剩下的再去掉空字节与回车:留下答案,不留它周围的旁白。
    there="$(wsl.exe -e wslpath -a "$(cd "$HERE" && pwd -W 2>/dev/null || echo "$HERE")" 2>/dev/null \
      | tr -d '\000\r' | grep -a . | tail -n 1)"
    [ -n "$there" ] || { echo "算不出 WSL 里的路径 / could not map this path into WSL" >&2; exit 1; }
    echo "▸ 本机没有 docker,改到 WSL 里跑 / no docker here, running in WSL"
    exec wsl.exe -e bash -c "LIBAV_WORK=\"\$HOME/.cfmail-libav\" bash '$there/scripts/build-libav.sh'"
  fi
  echo "需要 docker,没找到 / docker is required and was not found" >&2
  exit 1
fi

echo "▸ 取源码 / fetching sources (libav.js v$VERSION)"
mkdir -p "$WORK"
if [ ! -d "$WORK/libav.js" ]; then
  # The tag carries a build number the npm version does not: 6.10.9 on npm is v6.10.9.0 here,
  # and it is the same number that ends up in the built filenames.
  # 标签上多带一个 npm 版本号里没有的构建号:npm 上的 6.10.9 在这里是 v6.10.9.0,
  # 而那也正是最终出现在产物文件名里的那个号。
  git clone --depth 1 --branch "v$VERSION.0" https://github.com/Yahweasel/libav.js "$WORK/libav.js"
fi
cd "$WORK/libav.js"
git submodule update --init --recursive

echo "▸ 生成配置 / making the configuration ($VARIANT)"
docker run --rm -v "$PWD:/src" -w /src/configs emscripten/emsdk \
  node ./mkconfig.js "$VARIANT" "$(echo "$FRAGMENTS" | tr -d '\n ')"

echo "▸ 构建 / building — this takes a while"
docker build -f Dockerfile.development -t libavjs-build .
docker run --rm -v "$PWD:/src" -w /src libavjs-build \
  bash -c "make build-$VARIANT -j\$(nproc)"

echo "▸ 收取产物 / collecting"
mkdir -p "$OUT"
for f in "libav-$VERSION.0-$VARIANT.mjs" \
         "libav-$VERSION.0-$VARIANT.wasm.mjs" \
         "libav-$VERSION.0-$VARIANT.wasm.wasm"; do
  [ -f "dist/$f" ] || { echo "缺少产物 / missing build output: dist/$f" >&2; exit 1; }
  cp "dist/$f" "$OUT/$f"
  printf '  %8s KB  %s\n' "$(( $(stat -c%s "$OUT/$f") / 1024 ))" "$f"
done

# What this build is, written down beside it. Without it the only way to know whether the binary
# matches the fragment list above is to read the binary, and the failure it would otherwise hide is
# the quiet one: somebody adds a codec here, forgets to rebuild, and finds out months later that a
# file will not play for a reason that is nowhere in the code.
# 这份构建是什么,写在它旁边。没有它,想知道这个二进制与上面那份片段清单是否相符,
# 只能去读那个二进制;而它本会掩盖的那种失败恰恰是无声的那种:
# 有人在这里加了一个编码、忘了重建,几个月后才发现某个文件放不了,
# 而原因在代码里任何地方都找不到。
node -e '
  const fs = require("fs"), crypto = require("crypto");
  const frags = JSON.parse(process.argv[1]);
  fs.writeFileSync(process.argv[2] + "/build.json", JSON.stringify({
    version: process.argv[3],
    variant: process.argv[4],
    fragments: frags,
    fingerprint: crypto.createHash("sha256")
      .update(process.argv[3] + "\n" + [...frags].sort().join(",")).digest("hex").slice(0, 16),
    built_at: new Date().toISOString(),
  }, null, 2) + "\n");
' "$(echo "$FRAGMENTS" | tr -d '\n ')" "$OUT" "$VERSION" "$VARIANT"
printf '  %8s     %s\n' "-" "build.json"
echo
echo "✓ 建好了 / built into public/vendor/libav-full/"
echo "  这些文件要提交进仓库:npm 上没有它们,sync-vendor 也生不出来。"
echo "  Commit them: npm does not have them and sync-vendor cannot make them."
