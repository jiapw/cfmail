#!/usr/bin/env python3
# Pull still frames out of what the compositor made, to look at.
#   frames.py <file.flv> <out-prefix> <second> [<second> ...]
# Prints one JSON line: how long the file is, what is in it, which frames were written.
#
# 从合成器产出的文件里抽出几帧静止画面,用来目检。
# 输出一行 JSON:文件多长、里面有什么、写出了哪几帧。
import json
import struct
import sys
import zlib

import openh264


def write_png(path, w, h, rows):
    """RGB rows to a PNG, by hand: the image has no imaging library and needs none for this.
    把 RGB 行写成 PNG,手写:镜像里没有图像库,为这点事也用不着装一个。"""
    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)
    raw = b''.join(b'\x00' + r for r in rows)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


def main():
    src, prefix, seconds = sys.argv[1], sys.argv[2], [float(s) for s in sys.argv[3:]]
    openh264.ensure()
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst
    Gst.init(None)
    out = {'file': src, 'frames': []}
    pipe = Gst.parse_launch(
        f'filesrc location="{src}" ! flvdemux name=d  d.video ! queue ! h264parse ! openh264dec ! videoconvert ! '
        'video/x-raw,format=RGB ! appsink name=v sync=false max-buffers=2 drop=false  d.audio ! queue ! aacparse ! fakesink name=a sync=false')
    sink = pipe.get_by_name('v')
    audio = {'buffers': 0}
    pipe.get_by_name('a').get_static_pad('sink').add_probe(Gst.PadProbeType.BUFFER, lambda _p, _i: (audio.__setitem__('buffers', audio['buffers'] + 1), Gst.PadProbeReturn.OK)[1])
    pipe.set_state(Gst.State.PLAYING)
    want = sorted(seconds)
    last_pts = 0.0
    n = 0
    while True:
        sample = sink.emit('try-pull-sample', 5 * Gst.SECOND)
        if sample is None:
            break
        buf = sample.get_buffer()
        n += 1
        pts = buf.pts / Gst.SECOND if buf.pts != Gst.CLOCK_TIME_NONE else last_pts
        last_pts = pts
        if want and pts >= want[0]:
            want.pop(0)
            caps = sample.get_caps().get_structure(0)
            w, h = caps.get_value('width'), caps.get_value('height')
            ok, info = buf.map(Gst.MapFlags.READ)
            if ok:
                path = f'{prefix}-{int(pts):03d}.png'
                stride = (w * 3 + 3) // 4 * 4
                data = bytes(info.data)
                write_png(path, w, h, [data[y * stride:y * stride + w * 3] for y in range(h)])
                buf.unmap(info)
                out['frames'].append({'at': round(pts, 2), 'path': path, 'size': f'{w}x{h}'})
    pipe.set_state(Gst.State.NULL)
    out.update({'video_frames': n, 'seconds': round(last_pts, 2), 'audio_buffers': audio['buffers']})
    print(json.dumps(out))


if __name__ == '__main__':
    main()
