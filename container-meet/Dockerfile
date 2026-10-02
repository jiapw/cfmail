# The machine a live meeting is composited on.
#
# A live meeting has a handful of speakers and an audience of any size. The speakers meet over
# WebRTC; the audience watches ONE stream from Cloudflare Stream. Somebody has to turn the first
# into the second -- decode every speaker, lay them out as one picture (everybody the same size,
# or a shared screen with the speakers beside it), mix the voices, encode once, push over RTMPS.
# That somebody is this image: GStreamer driven by a short Python program. There is no browser in
# here, by decision.
#
# WHAT IS DELIBERATELY NOT IN THIS IMAGE
# An H.264 encoder. Stream's RTMPS door takes nothing but H.264, so one is needed -- but it is
# fetched when the container starts, from Cisco, rather than shipped from here (openh264.py has
# the reasons and the pinned hash). Ubuntu's gst-plugins-bad hard-depends on three codec libraries
# this image has no use for and would rather not redistribute, so they are removed after the
# install: the distribution's own build of OpenH264 (it is Cisco's binary that carries Cisco's
# patent licence, not a rebuild of the same source), x265, and faad2. GStreamer shrugs at a plugin
# whose library is missing; it just does not load that plugin.
#
# Build with --build-arg H264=x264 to get x264 instead (better pictures per bit, GPL, no patent
# licence attached). That image is yours to build and yours to distribute; the published one is
# never built that way.
#
# 一场直播会议在这台机器上合成。
#
# 直播会议有少数发言人和人数不限的旁观者。发言人之间走 WebRTC;旁观者看的是 Cloudflare Stream
# 上的**一路**流。总得有谁把前者变成后者 —— 解码每个发言人、排成一张画面(人人等大,或共享屏幕加旁边一列发言人)、
# 混音、编码一次、用 RTMPS 推出去。这个镜像就是那个"谁":GStreamer,由一段不长的 Python 驱动。
# 这里面没有浏览器,这是定下来的。
#
# 这个镜像里刻意没有什么
# H.264 编码器。Stream 的 RTMPS 入口只收 H.264,所以需要一个 —— 但它是容器启动时从 Cisco
# 取来的,不是从这里发出去的(理由和钉死的哈希见 openh264.py)。Ubuntu 的 gst-plugins-bad
# 硬依赖三个编解码库,这个镜像用不着、也不想转发,所以装完即删:发行版自己构建的 OpenH264
# (带着 Cisco 专利许可的是 Cisco 的二进制,不是同一份源码的重编译)、x265、faad2。
# 某个插件缺了它的库,GStreamer 只是不加载那个插件而已。
#
# 用 --build-arg H264=x264 构建可换成 x264(同码率画质更好;GPL;不附带专利许可)。
# 那个镜像由你自己构建、自己分发;公开发布的那个永远不这样构建。
FROM ubuntu:24.04

ARG H264=openh264
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates glib-networking \
      gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
      gstreamer1.0-nice gstreamer1.0-x \
      python3 python3-gi python3-websockets \
      gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 gir1.2-gst-plugins-bad-1.0 \
      fontconfig fonts-noto-cjk \
 && if [ "$H264" = "x264" ]; then \
      apt-get install -y --no-install-recommends gstreamer1.0-plugins-ugly gstreamer1.0-libav; \
    fi \
 && dpkg --remove --force-depends libopenh264-7 libx265-199 libfaad2 \
 && rm -f /usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstx265.so \
          /usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstfaad.so \
 # One weight of one family is what a name label needs; the package brings seven weights of two.
 # 名字条只需要一个字族的一个字重;这个包带来的是两个字族各七个字重。
 && find /usr/share/fonts -name 'NotoSerifCJK*' -delete \
 && find /usr/share/fonts -name 'NotoSansCJK-*' ! -name 'NotoSansCJK-Regular.ttc' -delete \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# The directory the library is fetched into has to exist BEFORE the process that will use it
# starts. glibc looks at every LD_LIBRARY_PATH entry once, at startup, and crosses off the ones
# that are not there; a directory created a moment later is never searched, and the plugin that
# needs the library fails to load in a way that reads like something else entirely.
# 库要下载进去的那个目录,必须在使用它的进程启动**之前**就存在。glibc 只在启动时看一遍
# LD_LIBRARY_PATH 的每一项,不存在的当场划掉;晚一步才建出来的目录永远不会被搜索,
# 而需要那个库的插件会以一种看上去完全是别的毛病的方式加载失败。
RUN mkdir -p /opt/openh264

ENV H264_ENCODER=${H264} \
    OPENH264_DIR=/opt/openh264 \
    LD_LIBRARY_PATH=/opt/openh264 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY openh264.py selftest.py compositor.py server.py frames.py /app/

# The container answers on this port; the Worker starts a broadcast and asks how it is going.
# 容器在这个端口上应答;Worker 发起一场直播,然后问它进展如何。
EXPOSE 8080
CMD ["python3", "/app/server.py"]
