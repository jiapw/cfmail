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
#   audio-filters        the resampling and downmixing on the way -- 5.1 at 48k is not stereo
#
# 各个片段,以及每一个为什么在这里。
#
# 第一行就是现成的 `webcodecs` 变体本身:能打开的容器、浏览器自己会解的那些编码的解析器,
# 以及不需要帮忙就能处理的 Opus/FLAC/wav。它之后的每一样,都是上游不会分发的。
#
#   demuxer-avi/asf/flv  libav 已发布的构建根本打不开的那些盒子
#   decoder-ac3, -dca    碟版片源的声音,没有浏览器解得了
#   encoder-aac          那些声音被转成什么 —— 因为每个浏览器都放得了 AAC
#   audio-filters        路上要做的重采样与缩混 —— 48k 的 5.1 不是立体声
FRAGMENTS='[
  "avformat","avcodec","format-ogg","format-webm","format-mp4",
  "parser-opus","codec-libopus","format-flac","parser-flac","codec-flac",
  "format-wav","codec-pcm_f32le",
  "parser-aac","parser-vp8","parser-vp9","parser-av1","parser-h264","parser-hevc",
  "bsf-extract_extradata","bsf-vp9_metadata","bsf-av1_metadata",
  "bsf-h264_metadata","bsf-hevc_metadata",
  "demuxer-avi","demuxer-asf","demuxer-flv",
  "parser-ac3","decoder-ac3","parser-dca","decoder-dca",
  "encoder-aac","audio-filters"
]'

command -v docker >/dev/null || { echo "需要 docker,没找到 / docker is required and was not found" >&2; exit 1; }

echo "▸ 取源码 / fetching sources (libav.js v$VERSION)"
mkdir -p "$WORK"
if [ ! -d "$WORK/libav.js" ]; then
  git clone --depth 1 --branch "v$VERSION" https://github.com/Yahweasel/libav.js "$WORK/libav.js"
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

echo
echo "✓ 建好了 / built into public/vendor/libav-full/"
echo "  这些文件要提交进仓库:npm 上没有它们,sync-vendor 也生不出来。"
echo "  Commit them: npm does not have them and sync-vendor cannot make them."
