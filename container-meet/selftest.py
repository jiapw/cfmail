#!/usr/bin/env python3
# Does this image do its job, and on how much machine?
#
# The real compositor takes its pictures from a meeting, which a build server does not have. This
# runs the same shape of pipeline on synthetic inputs instead -- one large picture, up to eight
# small ones, as many voices -- through the same compositor, the same encoder, the same muxer, and
# reports two things: whether every element the real thing needs is present, and whether the
# machine kept up with real time. It also moves the large picture to somebody else half way
# through, because a layout that can only be set once is not the layout a meeting has.
#
# It answers the questions that choose the container size, so it prints numbers, not opinions:
#   cores  = CPU seconds spent / wall seconds     (1.4 means "one and a half cores, busy")
#   frames = encoded / expected                   (below ~0.97 the machine did not keep up)
#
# 这个镜像能不能干它的活,要多大的机器?
#
# 真正的合成器从一场会议里取画面,而构建机上没有会议。这里改用合成信号跑同样形状的管线 ——
# 一路大画面、最多八路小画面、同样多路人声 —— 经过同一个 compositor、同一个编码器、同一个封装器,
# 然后回答两件事:真家伙需要的元件是否齐全;机器有没有跟上实时。跑到一半它还会把大画面换给别人,
# 因为只能设一次的布局不是一场会议的布局。
#
# 它回答的是"容器选多大"的问题,所以只打数字,不打意见:
#   cores  = 花掉的 CPU 秒 / 墙钟秒             (1.4 即"一个半核,忙着")
#   frames = 编出的帧 / 应有的帧                (低于约 0.97 就是没跟上)
import argparse
import json
import os
import sys
import time

import openh264

NEEDED = [
    # receiving the meeting / 接收会议
    'webrtcbin', 'nicesrc', 'dtlsdec', 'srtpdec', 'rtpopusdepay', 'opusdec',
    'rtpvp8depay', 'vp8dec', 'rtph264depay', 'h264parse',
    # making one picture and one sound of it / 合成一张画面、一路声音
    'compositor', 'audiomixer', 'videoconvert', 'videoscale', 'videorate', 'textoverlay',
    'audioconvert', 'audioresample',
    # sending it on / 送出去
    'voaacenc', 'aacparse', 'flvmux', 'rtmp2sink', 'mp4mux', 'splitmuxsink', 'tee', 'queue',
]


def layout(w, h, n_thumbs, has_stage=True):
    """Where everything goes. One column of small pictures on the right, each an eighth of the
    height, so eight speakers fill it exactly; the large picture takes what is left at 16:9.
    With no large picture the small ones become a grid.
    各就各位。右侧一列小画面,每格高为画幅的八分之一,八位发言人正好填满;大画面按 16:9 占余下的部分。
    没有大画面时,小画面排成宫格。"""
    boxes = {}
    if has_stage:
        th = h // 8
        tw = th * 16 // 9
        sw = w - tw
        sh = sw * 9 // 16
        boxes['stage'] = (0, (h - sh) // 2, sw, sh)
        for i in range(n_thumbs):
            boxes[f'thumb{i}'] = (sw, i * th, tw, th)
    else:
        cols = 1
        while cols * cols < max(1, n_thumbs):
            cols += 1
        rows = (n_thumbs + cols - 1) // cols
        cw, ch = w // cols, h // max(1, rows)
        for i in range(n_thumbs):
            boxes[f'thumb{i}'] = ((i % cols) * cw, (i // cols) * ch, cw, ch)
    return boxes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=int, default=20)
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--height', type=int, default=720)
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--speakers', type=int, default=8)
    ap.add_argument('--bitrate', type=int, default=0, help='bits/s; 0 picks one for the picture size')
    ap.add_argument('--threads', type=int, default=0, help='encoder threads; 0 = one per visible CPU, capped at 4')
    ap.add_argument('--out', default='/tmp/selftest.flv')
    ap.add_argument('--rtmp', default='', help='also push to this rtmp(s):// location')
    ap.add_argument('--clock', action='store_true', help='burn the wall clock into the large picture, to measure how late a viewer sees it')
    args = ap.parse_args()

    encoder = os.environ.get('H264_ENCODER', 'openh264')
    result = {'encoder': encoder, 'size': f'{args.width}x{args.height}@{args.fps}', 'speakers': args.speakers}

    if encoder == 'openh264':
        try:
            result['openh264'] = openh264.ensure()
        except openh264.OpenH264Error as e:
            result['error'] = str(e)
            print(json.dumps(result, ensure_ascii=False))
            return 2

    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import GLib, Gst
    Gst.init(None)
    result['gstreamer'] = Gst.version_string()

    enc_name = 'x264enc' if encoder == 'x264' else 'openh264enc'
    dec_name = 'avdec_h264' if encoder == 'x264' else 'openh264dec'
    missing = [n for n in NEEDED + [enc_name, dec_name] if Gst.ElementFactory.find(n) is None]
    result['missing'] = missing
    if enc_name in missing:
        print(json.dumps(result, ensure_ascii=False))
        return 3

    w, h, fps = args.width, args.height, args.fps
    threads = args.threads or max(1, min(4, os.cpu_count() or 1))
    bitrate = args.bitrate or (4_000_000 if h >= 1080 else 2_000_000 if h >= 720 else 1_000_000)
    result['threads'] = threads
    result['bitrate'] = bitrate

    if enc_name == 'openh264enc':
        enc = (f'openh264enc name=enc bitrate={bitrate} max-bitrate={bitrate * 3 // 2} gop-size={fps * 2} '
               f'rate-control=bitrate complexity=low multi-thread={threads} '
               f'slice-mode=n-slices num-slices={threads} usage-type=camera')
    else:
        enc = (f'x264enc name=enc bitrate={bitrate // 1000} key-int-max={fps * 2} bframes=0 '
               f'speed-preset=veryfast tune=zerolatency threads={threads}')

    n = max(0, min(8, args.speakers))
    boxes = layout(w, h, n)
    parts = [
        f'compositor name=mix background=black ! video/x-raw,format=I420,width={w},height={h},framerate={fps}/1 '
        f'! {enc} ! h264parse ! queue ! mux.',
        'audiomixer name=amix ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 '
        '! voaacenc bitrate=128000 ! aacparse ! queue ! mux.',
        'flvmux name=mux streamable=true latency=500000000 ! tee name=out',
        f'out. ! queue ! filesink location={args.out}',
        f'videotestsrc is-live=true pattern=ball ! video/x-raw,width={w},height={h},framerate={fps}/1 '
        + ('! clockoverlay time-format="%H:%M:%S" font-desc="Noto Sans CJK SC 40" halignment=center valignment=center shaded-background=true ' if args.clock else '')
        + '! queue ! mix.sink_0',
    ]
    if args.rtmp:
        parts.append(f'out. ! queue ! rtmp2sink location="{args.rtmp}"')
    patterns = ['smpte', 'snow', 'circular', 'blink', 'pinwheel', 'spokes', 'gradient', 'colors']
    for i in range(n):
        parts.append(
            f'videotestsrc is-live=true pattern={patterns[i]} ! video/x-raw,width=320,height=180,framerate=15/1 '
            f'! textoverlay text="发言人 {i + 1}" font-desc="Noto Sans CJK SC 14" valignment=bottom halignment=left '
            f'shaded-background=true ! queue ! mix.sink_{i + 1}')
        parts.append(
            f'audiotestsrc is-live=true wave=sine freq={220 + 55 * i} volume=0.03 '
            '! audio/x-raw,rate=48000,channels=1 ! queue ! amix.')

    pipeline = Gst.parse_launch('  '.join(parts))
    mix = pipeline.get_by_name('mix')

    def place(pad_index, box, z):
        pad = mix.get_static_pad(f'sink_{pad_index}')
        x, y, bw, bh = box
        for k, v in (('xpos', x), ('ypos', y), ('width', bw), ('height', bh), ('zorder', z)):
            pad.set_property(k, v)

    place(0, boxes['stage'], 1)
    for i in range(n):
        place(i + 1, boxes[f'thumb{i}'], 2)

    # Counted on the encoder's way out: what left it is what the audience gets.
    # 在编码器出口处计数:从那里出去的,就是旁观者拿到的。
    counts = {'frames': 0, 'bytes': 0, 'keyframes': 0}

    def on_encoded(_pad, info):
        buf = info.get_buffer()
        counts['frames'] += 1
        counts['bytes'] += buf.get_size()
        if not buf.has_flags(Gst.BufferFlags.DELTA_UNIT):
            counts['keyframes'] += 1
        return Gst.PadProbeReturn.OK

    pipeline.get_by_name('enc').get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, on_encoded)

    loop = GLib.MainLoop()
    state = {'error': None, 'swapped': False}

    def on_message(_bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            state['error'] = f'{err.message} | {dbg}'
            loop.quit()
        elif msg.type == Gst.MessageType.EOS:
            loop.quit()

    bus = pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect('message', on_message)

    def swap_stage():
        # Speaker 3 takes the large picture; the ball goes to speaker 3's slot. / 3 号发言人上台,球去 3 号的格子。
        if n >= 3:
            place(3, boxes['stage'], 1)
            place(0, boxes['thumb2'], 2)
            state['swapped'] = True
        return False

    def finish():
        pipeline.send_event(Gst.Event.new_eos())
        return False

    GLib.timeout_add_seconds(max(1, args.seconds // 2), swap_stage)
    GLib.timeout_add_seconds(args.seconds, finish)

    t0, c0 = time.monotonic(), os.times()
    pipeline.set_state(Gst.State.PLAYING)
    loop.run()
    wall = time.monotonic() - t0
    c1 = os.times()
    pipeline.set_state(Gst.State.NULL)

    cpu = (c1.user - c0.user) + (c1.system - c0.system)
    expected = args.seconds * fps
    result.update({
        'wall_s': round(wall, 2),
        'cpu_s': round(cpu, 2),
        'cores': round(cpu / wall, 2) if wall else None,
        'frames': counts['frames'],
        'frames_ratio': round(counts['frames'] / expected, 3) if expected else None,
        'keyframes': counts['keyframes'],
        'kbps': round(counts['bytes'] * 8 / 1000 / wall) if wall else None,
        'stage_swapped': state['swapped'],
        'out_bytes': os.path.getsize(args.out) if os.path.exists(args.out) else 0,
        'error': state['error'],
    })
    print(json.dumps(result, ensure_ascii=False))
    ok = not state['error'] and not missing and result['frames_ratio'] and result['frames_ratio'] >= 0.97
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
