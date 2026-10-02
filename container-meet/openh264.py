# Fetch Cisco's OpenH264 binary when the container starts, and refuse anything that is not it.
#
# WHY IT IS FETCHED AND NOT SHIPPED
# H.264 is patented. Cisco pays the pool's fees for the binary CISCO distributes, on the condition
# that whoever uses it downloads it from Cisco at install time -- a copy passed along by a third
# party is not covered. So this image carries no H.264 encoder at all: each container, on the
# machine of whoever deployed it, gets its own copy from Cisco before the first frame is encoded.
# That is the arrangement Firefox and Fedora use, for the same reason.
#
# WHY THE HASH IS PINNED
# The download is plain HTTP by Cisco's design (the https name serves the same bytes), and even if
# it were not, "whatever that URL returns today" is not something to load into a process. The
# SHA-256 below is of the decompressed library, taken from a download whose MD5 matched the value
# Cisco publishes beside it (libopenh264-2.4.1-linux64.7.so.signed.md5.txt). A mismatch is fatal:
# a broadcast that cannot start is a nuisance, a broadcast encoded by an unknown library is not
# something anyone agreed to.
#
# The version is not a preference either. Ubuntu 24.04's GStreamer plugin was built against
# libopenh264 2.4.1 with soname .7, and this is that exact ABI.
#
# 容器启动时去取 Cisco 的 OpenH264 二进制,并且只认它。
#
# 为什么是取来的而不是带着的
# H.264 有专利。Cisco 为**它自己分发**的二进制支付专利池费用,条件是使用者在安装时从 Cisco
# 直接下载 —— 第三方转手的副本不在此列。所以这个镜像里根本没有 H.264 编码器:每个容器、
# 在部署者自己的机器上、在编码第一帧之前,各自从 Cisco 取一份。Firefox 和 Fedora 出于同样的
# 理由用的是同一种安排。
#
# 为什么要钉死哈希
# 这个下载按 Cisco 的设计就是明文 HTTP(https 那个名字给出的是同样的字节);就算不是,
# "那个地址今天返回什么就是什么"也不是该往进程里装的东西。下面的 SHA-256 是解压后的库的,
# 取自一次 MD5 与 Cisco 在旁边公布的值(…so.signed.md5.txt)相符的下载。对不上就是致命错误:
# 开不了播只是麻烦,而由一个来历不明的库编码的直播,是没有任何人同意过的事。
#
# 版本也不是偏好。Ubuntu 24.04 的 GStreamer 插件是对着 libopenh264 2.4.1、soname .7 构建的,
# 这里取的正是那个 ABI。
import bz2
import hashlib
import os
import sys
import time
import urllib.request

VERSION = '2.4.1'
SONAME = 'libopenh264.so.7'
URLS = (
    'http://ciscobinary.openh264.org/libopenh264-2.4.1-linux64.7.so.bz2',
    'https://ciscobinary.openh264.org/libopenh264-2.4.1-linux64.7.so.bz2',
)
SO_SHA256 = '1392d21466bc638e68151b716d5b2086d54cd812afd43253f1adb5b6e0185f51'
SO_SIZE = 1731112

# The wording Cisco's binary licence asks a product to show. / Cisco 的二进制许可要求产品展示的措辞。
NOTICE = 'OpenH264 Video Codec provided by Cisco Systems, Inc.'


class OpenH264Error(RuntimeError):
    pass


def target_path() -> str:
    return os.path.join(os.environ.get('OPENH264_DIR', '/opt/openh264'), SONAME)


def _ok(path: str) -> bool:
    try:
        if os.path.getsize(path) != SO_SIZE:
            return False
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        return h.hexdigest() == SO_SHA256
    except OSError:
        return False


def ensure(log=print) -> str:
    """Make sure the library is in place, downloading it if it is not. Returns its path.

    The directory must already exist when the calling process started (the image makes it): the
    dynamic loader decides at startup which LD_LIBRARY_PATH entries are worth searching, so a
    directory made here would hold a library this very process can never load.

    确保库已就位,没有就下载。返回它的路径。

    那个目录必须在调用方进程启动时就已存在(镜像里建好了):动态加载器在启动那一刻就决定了
    LD_LIBRARY_PATH 里哪些项值得搜索,在这里现建的目录里放的库,恰恰是本进程永远加载不了的。"""
    path = target_path()
    if _ok(path):
        return path
    if not os.path.isdir(os.path.dirname(path)):
        raise OpenH264Error(f'{os.path.dirname(path)} does not exist; it has to be there before this process starts')
    last = None
    for attempt in range(3):
        for url in URLS:
            try:
                t0 = time.time()
                with urllib.request.urlopen(url, timeout=20) as r:
                    packed = r.read(8 << 20)
                raw = bz2.decompress(packed)
                digest = hashlib.sha256(raw).hexdigest()
                if len(raw) != SO_SIZE or digest != SO_SHA256:
                    raise OpenH264Error(f'hash mismatch from {url}: got {digest} ({len(raw)} bytes)')
                tmp = path + '.part'
                with open(tmp, 'wb') as f:
                    f.write(raw)
                os.chmod(tmp, 0o755)
                os.replace(tmp, path)
                log(f'[openh264] {VERSION} fetched from Cisco in {time.time() - t0:.1f}s -- {NOTICE}')
                return path
            except OpenH264Error:
                # Wrong bytes are not a network hiccup; trying again would only ask the same
                # question of the same server. / 字节不对不是网络抖动,再试只是向同一台服务器再问一遍。
                raise
            except Exception as e:  # noqa: BLE001 -- every failure here is "could not fetch"
                last = e
        time.sleep(1 + attempt)
    raise OpenH264Error(f'could not download OpenH264 from Cisco: {last}')


if __name__ == '__main__':
    try:
        print(ensure())
    except OpenH264Error as e:
        print(f'[openh264] {e}', file=sys.stderr)
        sys.exit(1)
