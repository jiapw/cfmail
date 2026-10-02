#!/usr/bin/env python3
# The meeting, as one picture and one sound, for the people who are only watching.
#
# A broadcast meeting has a handful of speakers and any number of watchers, and the watchers get
# what a television audience gets: one stream. This is the thing that makes it. It walks into the
# room through the same door as everybody else, as a guest of a particular kind (`bot`: it may ask
# the SFU for tracks and may do nothing else -- it cannot speak, cannot be seen, is on nobody's
# roster), subscribes to what the room is showing, lays it out, encodes it once, and pushes it to
# wherever it was told to.
#
# There is no browser in here. The pictures come in through GStreamer's own WebRTC stack
# (webrtcbin), are decoded by whichever decoder the track needs, and are placed by `compositor`;
# the voices meet in `audiomixer`. One H.264 encoder, one AAC encoder, one FLV muxer, one RTMP
# connection. Everything that changes during a meeting -- who holds the large picture, who is in
# the column of small ones, who has left -- changes the INPUT side of that pipeline while the
# output side keeps running, because a stream that stops is a stream the audience has to reload.
#
# The layout is the one the room itself uses: everybody the same size, in a grid as large as the
# picture allows; while somebody shares a screen, the screen takes most of the picture and the
# speakers are a column beside it. Somebody with no camera is a card with their name on it.
#
# 把一场会议变成一路画面、一路声音,给那些只是来看的人。
#
# 直播会议有少数几位发言人和不限数量的旁观者,而旁观者拿到的就是电视观众拿到的东西:一路流。
# 制作这路流的就是这里。它和所有人走同一扇门进入房间,身份是一种特殊的来客(`bot`:可以向 SFU 要轨道,
# 除此之外什么都不能做 —— 不能说话、不会被看见、不在任何人的名册上),订阅房间正在展示的东西,
# 排好版,编码一次,推到它被告知的地方。
#
# 这里面没有浏览器。画面经 GStreamer 自己的 WebRTC 栈(webrtcbin)进来,由该轨道所需的解码器解开,
# 由 `compositor` 摆放;人声在 `audiomixer` 里汇合。一个 H.264 编码器、一个 AAC 编码器、一个 FLV
# 封装器、一条 RTMP 连接。会议中会变的一切 —— 大画面在谁手上、右边那一列小画面里有谁、谁走了 ——
# 改动的都是这条管线的**输入侧**,输出侧一直在跑,因为一路停下来的流,就是一路要观众刷新页面的流。
#
# 版式就是房间自己用的那个:人人一样大,排成画面放得下的最大宫格;有人共享屏幕时,屏幕占去画面的大部分,
# 发言人排成它旁边的一列。没开摄像头的人是一张写着名字的卡片。
import argparse
import asyncio
import json
import os
import signal
import sys
import threading
import time
import urllib.parse

import openh264

RETRY_MS = [250, 400, 600, 900, 1300, 2000]
MAX_TILES = 8
CARD_COLOURS = [0xFF2F4A7F, 0xFF7F3A35, 0xFF245E49, 0xFF6E5216, 0xFF553C80, 0xFF1F5A70, 0xFF7A3760, 0xFF3F5417]


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def even(n):
    return max(2, int(n) // 2 * 2)


def narrow_offer(sdp, codec_by_mid):
    """Cut each m-section of the SFU's offer down to the one codec its track really travels in.
    The SFU offers every codec it knows and forwards whichever the publisher sends; webrtcbin
    answers with exactly one codec per m-line -- the first on offer -- and the SFU refuses an
    answer that lacks the track's real codec. The room knows the real codec (it saw the SFU
    accept the publisher's offer), so the list is cut to it, and to its retransmission payload,
    before webrtcbin ever sees it. A section whose codec is unknown is left alone.
    把 SFU offer 里每个 m 段裁剪到该轨道真正使用的那一种编码。SFU 会列出它认识的每一种编码,
    转发的却是发布者实际发送的那一种;webrtcbin 对每条 m-line 只答一种编码 —— offer 里的第一种 ——
    而 SFU 会拒绝不含轨道真实编码的应答。房间知道真实编码(它亲眼看到 SFU 接受了发布者的 offer),
    所以在 webrtcbin 看到之前,就把列表裁到只剩它和它的重传 payload。编码未知的段原样不动。"""
    eol = '\r\n' if '\r\n' in sdp else '\n'
    head, *secs = sdp.replace('\r\n', '\n').split('\nm=')
    out = [head]
    for sec in secs:
        # "ccm fir" goes, everywhere. Offered both, GStreamer asks for keyframes with FIR and
        # never with PLI, and the SFU passes on PLI only: measured, 78 FIRs sent, no keyframe,
        # a picture that took twenty seconds to start. Without FIR on offer it sends PLI.
        # "ccm fir" 一律去掉。两样都有的时候,GStreamer 要关键帧只用 FIR、从不用 PLI,而 SFU 只转发 PLI:
        # 实测发了 78 个 FIR,一个关键帧都没换来,画面二十秒才出来。offer 里没有 FIR,它就改发 PLI。
        lines = [ln for ln in ('m=' + sec).split('\n') if not (ln.startswith('a=rtcp-fb:') and ln.rstrip().endswith('ccm fir'))]
        mid = next((ln[6:].strip() for ln in lines if ln.startswith('a=mid:')), None)
        codec = (codec_by_mid.get(mid) or '').lower()
        if not codec:
            out.append('\n'.join(lines))
            continue
        names, apt = {}, {}
        for ln in lines:
            if ln.startswith('a=rtpmap:'):
                pt, rest = ln[9:].split(' ', 1)
                names[pt] = rest.split('/')[0].lower()
            elif ln.startswith('a=fmtp:') and 'apt=' in ln:
                pt, rest = ln[7:].split(' ', 1)
                apt[pt] = rest.split('apt=')[1].split(';')[0].strip()
        keep = [pt for pt, n in names.items() if n == codec]
        keep += [pt for pt, n in names.items() if n == 'rtx' and apt.get(pt) in keep]
        if not keep:
            out.append('\n'.join(lines))
            continue
        m = lines[0].split(' ')
        lines[0] = ' '.join(m[:3] + [pt for pt in m[3:] if pt in keep])
        kept = [lines[0]]
        for ln in lines[1:]:
            tag = ln.split(':', 1)[0]
            if tag in ('a=rtpmap', 'a=fmtp', 'a=rtcp-fb'):
                pt = ln.split(':', 1)[1].split(' ', 1)[0]
                if pt not in keep:
                    continue
            kept.append(ln)
        out.append('\n'.join(kept))
    return '\nm='.join([out[0]] + [s[2:] for s in out[1:]]).replace('\n', eol)


def layout(w, h, has_screen, n_tiles):
    """Where everything goes. / 各就各位。
    Nobody shares a screen: everybody the same size, in the largest grid that fits. Somebody does:
    the speakers are a column on the right -- a quarter of the height each while there are four or
    fewer, an eighth when all eight are there -- and the screen takes what is left.
    没人共享屏幕:人人一样大,排成放得下的最大宫格。有人共享:发言人排成右侧一列 ——
    四个以内每格高为画幅的四分之一,八个到齐时为八分之一 —— 余下的归屏幕。"""
    boxes = {}
    if has_screen:
        rows = max(4, n_tiles)
        th = even(h / rows) if n_tiles else 0
        tw = even(th * 16 / 9) if n_tiles else 0
        boxes['screen'] = (0, 0, even(w - tw), even(h))
        top = (h - th * n_tiles) // 2 if n_tiles else 0
        for i in range(n_tiles):
            boxes[i] = (w - tw, top + i * th, tw, th)
        return boxes
    if not n_tiles:
        return boxes
    cols = 1
    while cols * cols < n_tiles:
        cols += 1
    rows = (n_tiles + cols - 1) // cols
    gap = even(h / 90)
    cw = min((w - gap * (cols + 1)) / cols, ((h - gap * (rows + 1)) / rows) * 16 / 9)
    cw = even(cw)
    ch = even(cw * 9 / 16)
    y0 = (h - (rows * ch + (rows - 1) * gap)) // 2
    for i in range(n_tiles):
        row = i // cols
        in_row = n_tiles - row * cols if row == rows - 1 else cols
        x0 = (w - (in_row * cw + (in_row - 1) * gap)) // 2
        boxes[i] = (x0 + (i % cols) * (cw + gap), y0 + row * (ch + gap), cw, ch)
    return boxes


class Branch:
    """One thing on the screen or in the mix: an arriving track, or a name card.
    屏幕上或混音里的一样东西:一条到达的轨道,或一张名字卡片。"""

    def __init__(self, key, peer, kind, name='', colour=0):
        self.key = key            # 'peer:kind'
        self.peer = peer
        self.kind = kind          # 'mic' | 'cam' | 'screen' | 'card'
        self.name = name
        self.colour = colour
        self.mid = None
        self.codec = ''
        self.tries = 0
        self.retry_at = 0.0
        self.since = time.time()
        self.webrtc_pad = None
        self.head = None          # first element after webrtcbin / webrtcbin 之后的第一个元件
        self.tail = None          # the bin that ends at the mixer / 终于混合器的那个 bin
        self.mixpad = None
        self.shown = False
        self.box = None
        self.elements = []
        # Set when the branch is being taken out. A track's pads turn up on GStreamer's own
        # threads, whenever its first packets do -- which can be after the room has already
        # changed its mind about wanting it. / 分支正在被摘除时置位。轨道的 pad 由 GStreamer 自己的线程
        # 在第一批包到达时才冒出来 —— 那时房间可能早已改了主意、不要它了。
        self.dead = False


class Mixer:
    """The pipeline. Its output half is built once; its input half is rebuilt as the room changes.
    管线。输出那一半只建一次;输入那一半随房间的变化而重建。"""

    def __init__(self, Gst, GstWebRTC, GstSdp, GLib, args, on_shown):
        self.Gst, self.GstWebRTC, self.GstSdp, self.GLib = Gst, GstWebRTC, GstSdp, GLib
        self.args = args
        self.on_shown = on_shown
        self.lock = threading.RLock()
        self.webrtc = None
        self.by_mid = {}
        # Every mid this connection has ever carried, and its codec: the SFU's offers are
        # cumulative, so a section has to be cut the same way every time it comes round again.
        # 这条连接承载过的每一个 mid 及其编码:SFU 的 offer 是累积的,所以同一个段每次再出现时都得按同样的方式裁。
        self.codec_memo = {}
        w, h, fps = args.width, args.height, args.fps
        threads = max(1, min(4, os.cpu_count() or 1))
        bitrate = args.bitrate or (4_500_000 if h >= 1080 else 2_500_000 if h >= 720 else 1_200_000)
        encoder = os.environ.get('H264_ENCODER', 'openh264')
        if encoder == 'x264':
            enc = f'x264enc name=enc bitrate={bitrate // 1000} key-int-max={fps * 2} bframes=0 speed-preset=veryfast tune=zerolatency threads={threads}'
        else:
            enc = (f'openh264enc name=enc bitrate={bitrate} max-bitrate={bitrate * 3 // 2} gop-size={fps * 2} rate-control=bitrate '
                   f'complexity=low multi-thread={threads} slice-mode=n-slices num-slices={threads} usage-type=camera')
        out = args.out
        if out.startswith('rtmp'):
            sink = f'rtmp2sink name=out location="{out}" async-connect=true'
        else:
            sink = f'filesink name=out location="{out}"'
        desc = '  '.join([
            f'compositor name=mix background=black ! video/x-raw,format=I420,width={w},height={h},framerate={fps}/1 ! queue max-size-buffers=4 ! {enc} ! h264parse config-interval=-1 ! queue ! mux.',
            'audiomixer name=amix ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 ! voaacenc bitrate=128000 ! aacparse ! queue ! mux.',
            # Half a second for the slower of the two encoders to catch up, so that what goes out
            # is in the order of its timestamps. / 给两个编码器里慢的那个半秒钟追上来,让送出去的东西按时间戳排好序。
            f'flvmux name=mux streamable=true latency=500000000 ! queue ! {sink}',
            # Always there, so that the picture and the sound never run out of inputs.
            # 永远在场,于是画面和声音永远不会没有输入。
            f'videotestsrc is-live=true pattern=black ! video/x-raw,width={w},height={h},framerate={fps}/1 ! queue ! mix.sink_0',
            'audiotestsrc is-live=true wave=silence ! audio/x-raw,rate=48000,channels=2 ! queue ! amix.sink_0',
        ])
        self.pipeline = Gst.parse_launch(desc)
        self.mix = self.pipeline.get_by_name('mix')
        self.amix = self.pipeline.get_by_name('amix')
        self.frames = 0
        self.pipeline.get_by_name('enc').get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, self._count)

    def _count(self, _pad, _info):
        self.frames += 1
        return self.Gst.PadProbeReturn.OK

    def start(self):
        self.pipeline.set_state(self.Gst.State.PLAYING)

    def stop(self):
        """End the file properly if the pipeline lets us; never wait on it for long. The caller
        leaves the process right after, so a pipeline that will not wind down is not waited for.
        管线肯配合的话,就把文件好好收尾;但绝不久等。调用方随后就退出进程,所以不肯收场的管线不等它。"""
        def wind_down():
            try:
                self.pipeline.send_event(self.Gst.Event.new_eos())
                time.sleep(0.7)
                self.pipeline.set_state(self.Gst.State.NULL)
            except Exception as e:  # noqa: BLE001
                log('stop:', str(e)[:120])
        t = threading.Thread(target=wind_down, daemon=True)
        t.start()
        t.join(4.0)

    # ----- the receiving connection / 接收连接 -----

    def new_connection(self, ice):
        """A fresh webrtcbin. Any branch that hung off the old one is gone with it.
        一个新的 webrtcbin。挂在旧的那个上面的分支随它一起消失。"""
        Gst = self.Gst
        with self.lock:
            old = self.webrtc
            for b in list(self.by_mid.values()):
                self._drop_elements(b)
            self.by_mid.clear()
            self.codec_memo = {}
            if old is not None:
                old.set_state(Gst.State.NULL)
                self.pipeline.remove(old)
            wb = Gst.ElementFactory.make('webrtcbin', None)
            wb.set_property('bundle-policy', 'max-bundle')
            wb.set_property('latency', 150)
            stun = None
            for srv in ice or []:
                urls = srv.get('urls') or []
                urls = [urls] if isinstance(urls, str) else urls
                for u in urls:
                    if u.startswith('stun:') and not stun:
                        stun = 'stun://' + u[5:]
                    elif u.startswith(('turn:', 'turns:')) and srv.get('username'):
                        scheme, rest = u.split(':', 1)
                        host, _, query = rest.partition('?')
                        cred = f"{urllib.parse.quote(srv['username'], safe='')}:{urllib.parse.quote(srv.get('credential', ''), safe='')}"
                        wb.emit('add-turn-server', f'{scheme}://{cred}@{host}' + (f'?{query}' if query else ''))
            wb.set_property('stun-server', stun or 'stun://stun.cloudflare.com:3478')
            wb.connect('pad-added', self._on_pad)
            wb.connect('on-new-transceiver', self._on_transceiver)
            wb.connect('notify::ice-connection-state', lambda o, _p: log('ice', o.get_property('ice-connection-state').value_nick))
            self.pipeline.add(wb)
            wb.sync_state_with_parent()
            self.webrtc = wb

    def _on_transceiver(self, _wb, trans):
        """Say which codecs can be decoded here -- ALL of them, not the first. The SFU's offer
        lists every codec it knows and forwards whichever one the publisher happens to send; left
        to itself webrtcbin answers with the first on the list, and the SFU then refuses the
        answer for not containing the codec the track is actually in.
        说清这里能解哪些编码 —— **全部**,而不是第一个。SFU 的 offer 列出它认识的每一种编码,
        转发的却是发布者实际在发的那一种;webrtcbin 若自行其是,只会答列表里的第一个,
        然后 SFU 就以"应答里没有这条轨实际使用的编码"为由拒绝它。"""
        kind = trans.get_property('kind')
        if kind == self.GstWebRTC.WebRTCKind.VIDEO:
            # Ask for lost packets again; without this webrtcbin leaves rtx out of its answer.
            # 丢了的包要重传;不设这个,webrtcbin 的应答里就不带 rtx。
            trans.set_property('do-nack', True)

    def answer(self, offer_sdp):
        """Take the SFU's offer, give back our answer. Blocking; call it off the event loop.
        收下 SFU 的 offer,交回我们的 answer。会阻塞;别在事件循环里调。"""
        Gst, GstWebRTC, GstSdp = self.Gst, self.GstWebRTC, self.GstSdp
        with self.lock:
            codecs = {mid: b.codec for mid, b in self.by_mid.items()}
        codecs.update(self.codec_memo)
        self.codec_memo = dict(codecs)
        offer_sdp = narrow_offer(offer_sdp, codecs)
        self.n_offers = getattr(self, 'n_offers', 0) + 1
        dump = os.environ.get('MEET_DEBUG_SDP')
        if dump:
            with open(os.path.join(dump, f'offer-{self.n_offers}.sdp'), 'w') as f:
                f.write(offer_sdp)
        _res, msg = GstSdp.SDPMessage.new_from_text(offer_sdp)
        offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, msg)
        p = Gst.Promise.new()
        self.webrtc.emit('set-remote-description', offer, p)
        p.wait()
        p = Gst.Promise.new()
        self.webrtc.emit('create-answer', None, p)
        p.wait()
        reply = p.get_reply()
        if reply is None or not reply.has_field('answer'):
            raise RuntimeError(f'no answer: {reply.to_string() if reply else "none"}')
        ans = reply.get_value('answer')
        p = Gst.Promise.new()
        self.webrtc.emit('set-local-description', ans, p)
        p.wait()
        text = ans.sdp.as_text()
        if dump:
            with open(os.path.join(dump, f'answer-{self.n_offers}.sdp'), 'w') as f:
                f.write(text)
        return text

    # ----- branches / 分支 -----

    def expect(self, branch):
        with self.lock:
            self.by_mid[branch.mid] = branch

    def _on_pad(self, _wb, pad):
        Gst = self.Gst
        if pad.get_direction() != Gst.PadDirection.SRC:
            return
        trans = pad.get_property('transceiver')
        mid = trans.get_property('mid') if trans is not None else None
        with self.lock:
            b = self.by_mid.get(mid)
            if b is None or b.dead:
                log('pad for a mid nobody wants:', mid)
                self._to_nowhere(pad)
                return
            caps = pad.get_current_caps()
            log('arriving', b.key, 'mid', mid, (caps.to_string()[:160] if caps else 'no caps yet'))
            b.webrtc_pad = pad
            q = Gst.ElementFactory.make('queue', None)
            dec = Gst.ElementFactory.make('decodebin', None)
            dec.connect('pad-added', self._on_decoded, b)
            dec.connect('deep-element-added', self._tune)
            for e in (q, dec):
                self.pipeline.add(e)
                b.elements.append(e)
            q.link(dec)
            for e in (q, dec):
                e.sync_state_with_parent()
            b.head = q
            res = pad.link(q.get_static_pad('sink'))
            if res != Gst.PadLinkReturn.OK:
                log('could not link', b.key, res.value_nick)
        if b.kind in ('cam', 'screen'):
            self.GLib.timeout_add(150, self._ask_keyframe, b, 0)

    def _tune(self, _bin, _sub, el):
        f = el.get_factory()
        name = f.get_name() if f else ''
        if name in ('rtpvp8depay', 'rtph264depay', 'rtpvp9depay'):
            for k in ('request-keyframe', 'wait-for-keyframe'):
                try:
                    el.set_property(k, True)
                except Exception:
                    pass

    def _on_decoded(self, _dec, pad, b):
        Gst = self.Gst
        caps = pad.get_current_caps() or pad.query_caps(None)
        kind = caps.get_structure(0).get_name() if caps and caps.get_size() else ''
        log('decoded', b.key, kind)
        with self.lock:
            if b.dead:
                self._to_nowhere(pad)
                return
            self._attach(b, pad, kind, caps)

    def _attach(self, b, pad, kind, caps):
        Gst = self.Gst
        if kind.startswith('audio/'):
            tail = self._bin('audioconvert name=in ! audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=2 ! queue name=out')
            mixer = self.amix
        elif kind.startswith('video/'):
            tail = self._video_tail(b)
            mixer = self.mix
        else:
            # decodebin hands over what it could not decode as it came. Left unlinked it would
            # stop the whole receiving side, so it goes nowhere instead.
            # decodebin 会把它解不了的东西原样交出来。不接的话会让整个接收侧停摆,所以接到"无处"。
            log('cannot decode', b.key, (caps.to_string()[:200] if caps else ''))
            self._to_nowhere(pad)
            return
        self.pipeline.add(tail)
        b.elements.append(tail)
        b.tail = tail
        mixpad = mixer.request_pad_simple('sink_%u')
        b.mixpad = mixpad
        if mixer is self.mix:
            mixpad.set_property('alpha', 0.0)
            self._place(b)
            mixpad.add_probe(Gst.PadProbeType.BUFFER, self._first_frame, b)
        r1 = tail.get_static_pad('src').link(mixpad)
        tail.sync_state_with_parent()
        r2 = pad.link(tail.get_static_pad('sink'))
        if r1 != Gst.PadLinkReturn.OK or r2 != Gst.PadLinkReturn.OK:
            log('could not link the decoded', b.key, r1.value_nick, r2.value_nick)

    def _bin(self, desc, sink=True):
        """A bin from a description, with its ends named by hand. Left to find the loose ends
        itself the parser picks textoverlay's TEXT input as the way in, and the picture, offered
        to a pad that only takes words, has nowhere to go.
        由描述造一个 bin,两端由我们亲手指定。让解析器自己去找没接上的端口,它会把 textoverlay 的**文字**输入
        当成入口 —— 而画面被递给一个只收文字的 pad,自然无处可去。"""
        Gst = self.Gst
        b = Gst.parse_bin_from_description(desc, False)
        if sink:
            b.add_pad(Gst.GhostPad.new('sink', b.get_by_name('in').get_static_pad('sink')))
        b.add_pad(Gst.GhostPad.new('src', b.get_by_name('out').get_static_pad('src')))
        return b

    def _video_tail(self, b):
        crop = 'aspectratiocrop aspect-ratio=16/9 ! ' if b.kind in ('cam', 'card') else ''
        font = 'Noto Sans CJK SC'
        label = (f'textoverlay name=label text="" font-desc="{font} 14" valignment=bottom halignment=left xpad=10 ypad=8 '
                 'shaded-background=true shading-value=120 auto-resize=false')
        return self._bin(
            f'videoconvert name=in ! {crop}videoscale add-borders=true ! video/x-raw,pixel-aspect-ratio=1/1 ! capsfilter name=size ! {label} ! queue name=out max-size-buffers=3 leaky=downstream')

    def _ask_keyframe(self, b, n=0):
        """A picture starts at a keyframe, and a sender makes one only when asked. Ask, and keep
        asking once a second until there is a picture.
        画面从关键帧开始,而发送方只在被要求时才出关键帧。去要,并且每秒再要一次,直到有画面为止。"""
        if b.shown or b.webrtc_pad is None or b.head is None or n > 12:
            return False
        try:
            from gi.repository import GstVideo
            # all_headers=False: that is a PLI on the wire. True would be a FIR, which the SFU
            # does not pass on. / all_headers=False:线上发出去的是 PLI。True 会变成 FIR,而 SFU 不转发它。
            ok = b.webrtc_pad.send_event(GstVideo.video_event_new_upstream_force_key_unit(self.Gst.CLOCK_TIME_NONE, False, n))
            if n == 0 or not ok:
                log('asked for a keyframe', b.key, 'ok' if ok else 'refused')
        except Exception as e:  # noqa: BLE001
            log('keyframe request:', str(e)[:120])
        self.GLib.timeout_add(1000, self._ask_keyframe, b, n + 1)
        return False

    def add_card(self, b):
        """Somebody with no camera: their name, on a colour. / 没开摄像头的人:一块颜色上的名字。"""
        Gst = self.Gst
        src = self._bin(
            f'videotestsrc is-live=true pattern=solid-color foreground-color={b.colour} ! video/x-raw,width=320,height=180,framerate=5/1 ! '
            'capsfilter name=size ! textoverlay name=label text="" font-desc="Noto Sans CJK SC 22" valignment=center halignment=center auto-resize=false ! queue name=out', sink=False)
        self.pipeline.add(src)
        b.elements.append(src)
        b.tail = src
        b.mixpad = self.mix.request_pad_simple('sink_%u')
        b.shown = True
        self._place(b)
        src.get_static_pad('src').link(b.mixpad)
        src.sync_state_with_parent()

    def _first_frame(self, _pad, _info, b):
        if not b.shown:
            b.shown = True
            b.mixpad.set_property('alpha', 1.0)
            log('showing', b.key)
            self.on_shown(b)
        return self.Gst.PadProbeReturn.REMOVE

    def _place(self, b):
        if b.mixpad is None or b.box is None or b.tail is None:
            return
        x, y, w, h = b.box
        size = b.tail.get_by_name('size')
        if size is not None and b.kind != 'card':
            size.set_property('caps', self.Gst.Caps.from_string(f'video/x-raw,width={w},height={h}'))
        label = b.tail.get_by_name('label')
        if label is not None:
            label.set_property('text', b.name or '')
            # The name grows with the picture, within reason: a speaker alone on the screen does
            # not need a headline. / 名字随画面变大,但有分寸:独自占满画面的发言人,用不着标题那么大的字。
            pts = max(10, min(28, int(h / 22)))
            if b.kind == 'card':
                pts = 22
            label.set_property('font-desc', f'Noto Sans CJK SC {pts}')
        for k, v in (('xpos', x), ('ypos', y), ('width', w), ('height', h), ('zorder', 2 if b.kind == 'screen' else 3)):
            b.mixpad.set_property(k, v)

    def place(self, b, box):
        b.box = box
        self._place(b)

    def hide(self, b):
        if b.mixpad is not None and b.kind != 'mic':
            b.mixpad.set_property('alpha', 0.0)

    def unhide(self, b):
        if b.mixpad is not None and b.kind != 'mic' and b.shown:
            b.mixpad.set_property('alpha', 1.0)

    def _to_nowhere(self, pad):
        Gst = self.Gst
        sink = Gst.ElementFactory.make('fakesink', None)
        sink.set_property('sync', False)
        sink.set_property('async', False)
        self.pipeline.add(sink)
        sink.sync_state_with_parent()
        pad.link(sink.get_static_pad('sink'))

    def _drop_elements(self, b):
        """Take what a branch was made of out of the pipeline. What it was made of is taken from
        it under the lock, so that two callers cannot both dispose of the same elements.
        把一个分支的构成物从管线里拿掉。构成物是在锁内从分支身上取走的,于是两个调用者不会处置同一批元件。"""
        Gst = self.Gst
        with self.lock:
            elements, b.elements = b.elements, []
            mixpad, b.mixpad = b.mixpad, None
            b.head = b.tail = None
        if mixpad is not None:
            mixer = mixpad.get_parent_element()
            peer = mixpad.get_peer()
            if peer is not None:
                peer.unlink(mixpad)
            if mixer is not None:
                mixer.release_request_pad(mixpad)
        for e in elements:
            e.set_state(Gst.State.NULL)
            self.pipeline.remove(e)

    def remove(self, b):
        """Take a branch out while everything else keeps playing. The track's pad on webrtcbin
        cannot be removed -- an m-line is for life -- so it is pointed at nothing instead.
        在其余一切继续播放的同时摘掉一个分支。webrtcbin 上那条轨道的 pad 是摘不掉的 ——
        一条 m-line 终身有效 —— 所以改为把它接到"无处"。"""
        Gst = self.Gst
        with self.lock:
            b.dead = True
            if b.mid is not None and self.by_mid.get(b.mid) is b:
                # The entry stays, marked dead: a pad that turns up late still has to be told
                # where to go. / 条目留着、标记为已死:迟到的 pad 仍然需要有人告诉它该去哪。
                pass
            pad = b.webrtc_pad
        if pad is None:
            self.GLib.idle_add(lambda: (self._drop_elements(b), False)[1])
            return

        def idle(_pad, _info):
            with self.lock:
                if b.head is not None and pad.is_linked():
                    pad.unlink(b.head.get_static_pad('sink'))
                    self._to_nowhere(pad)
            self.GLib.idle_add(lambda: (self._drop_elements(b), False)[1])
            return Gst.PadProbeReturn.REMOVE

        pad.add_probe(Gst.PadProbeType.IDLE, idle)


class Director:
    """Reads the room, decides what should be on screen, and makes it so.
    读房间,决定屏幕上该有什么,然后让它成真。"""

    def __init__(self, args, mods):
        self.args = args
        self.Gst, self.GstWebRTC, self.GstSdp, self.GLib = mods
        self.loop = asyncio.get_event_loop()
        self.mixer = Mixer(*mods, args, self._shown)
        self.ws = None
        self.rid = 0
        self.waiting = {}
        self.me = None
        self.cfg = {}
        self.room = None
        self.branches = {}
        self.kick = asyncio.Event()
        self.stopping = False
        self.status = {'state': 'starting', 'since': time.time()}

    def _shown(self, _branch):
        self.loop.call_soon_threadsafe(self.kick.set)

    # ----- the socket / 连接 -----

    async def rpc(self, op, **payload):
        self.rid += 1
        rid = self.rid
        fut = self.loop.create_future()
        self.waiting[rid] = fut
        await self.ws.send(json.dumps({'t': 'sfu', 'rid': rid, 'op': op, **payload}))
        try:
            return await asyncio.wait_for(fut, 20)
        finally:
            self.waiting.pop(rid, None)

    async def run(self):
        import websockets
        self.mixer.start()
        worker = asyncio.ensure_future(self.work())
        backoff = 1.0
        while not self.stopping:
            try:
                headers = {'Origin': self.args.origin} if self.args.origin else {}
                try:
                    conn = websockets.connect(self.args.ws, extra_headers=headers, max_size=2 ** 20, ping_interval=20)
                except TypeError:
                    conn = websockets.connect(self.args.ws, additional_headers=headers, max_size=2 ** 20, ping_interval=20)
                async with conn as ws:
                    self.ws = ws
                    backoff = 1.0
                    async for raw in ws:
                        await self.on_message(json.loads(raw))
            except Exception as e:  # noqa: BLE001 -- whatever it was, the answer is the same: come back
                log('socket:', type(e).__name__, str(e)[:200])
            self.ws = None
            for fut in self.waiting.values():
                if not fut.done():
                    fut.set_exception(RuntimeError('offline'))
            if self.stopping or self.status.get('state') == 'ended':
                break
            self.status['state'] = 'reconnecting'
            await asyncio.sleep(backoff)
            backoff = min(15.0, backoff * 2)
        worker.cancel()
        self.mixer.stop()

    async def on_message(self, m):
        t = m.get('t')
        if t in ('welcome', 'admitted'):
            self.me = m.get('you')
            self.cfg = m.get('cfg') or {}
            self.room = m.get('room')
            # A new seat is a new SFU session: everything that was arriving has stopped.
            # 新座位就是新的 SFU 会话:此前到达的一切都已经停了。
            for b in list(self.branches.values()):
                if b.kind != 'card':
                    self.mixer.remove(b)
                    del self.branches[b.key]
            await self.loop.run_in_executor(None, self.mixer.new_connection, m.get('ice'))
            self.status['state'] = 'live'
            log('seated as', self.me, 'title:', self.cfg.get('title'))
            self.kick.set()
        elif t == 'room':
            self.room = m
            self.kick.set()
        elif t in ('sfu_ok', 'sfu_err'):
            fut = self.waiting.get(m.get('rid'))
            if fut and not fut.done():
                if t == 'sfu_ok':
                    fut.set_result(m)
                else:
                    fut.set_exception(RuntimeError(f"sfu: {m.get('code')} {str(m.get('detail'))[:200]}"))
        elif t in ('ended', 'kicked', 'refused'):
            log('the room says:', t, m.get('error') or m.get('why') or '')
            self.status['state'] = 'ended'
            self.stopping = True
            if self.ws is not None:
                await self.ws.close()

    # ----- what should be on / 该上什么 -----

    def plan(self):
        room = self.room or {}
        peers = room.get('peers') or []
        video = bool(self.cfg.get('video', True))
        want = {}
        for p in peers:
            if 'mic' in p.get('pub', []):
                want[f"{p['peer']}:mic"] = ('mic', p)
        # A shared screen, if there is one, is the one thing drawn large. / 共享的屏幕(如果有)是唯一画大的东西。
        sp = room.get('screen') if video else None
        screen_peer = next((p for p in peers if p['peer'] == sp and 'screen' in p.get('pub', [])), None)
        if screen_peer:
            want[f"{sp}:screen"] = ('screen', screen_peer)
        tiles = []
        for p in peers:
            if len(tiles) >= MAX_TILES:
                break
            kind = 'cam' if video and 'cam' in p.get('pub', []) else 'card'
            key = f"{p['peer']}:{kind}"
            want[key] = (kind, p)
            tiles.append(key)
        return want, tiles, (f"{sp}:screen" if screen_peer else None)

    async def work(self):
        while True:
            await self.kick.wait()
            self.kick.clear()
            if self.ws is None or self.me is None:
                continue
            try:
                await self.reconcile()
            except Exception as e:  # noqa: BLE001
                log('reconcile:', type(e).__name__, str(e)[:300])
                await asyncio.sleep(1.0)
                self.kick.set()

    async def reconcile(self):
        now = time.time()
        want, tiles, screen_key = self.plan()

        # Additions first: make before break. / 先加后减:先接后断。
        ask = []
        for key, (kind, p) in want.items():
            b = self.branches.get(key)
            if b is None:
                b = self.branches[key] = Branch(key, p['peer'], kind, p.get('name', ''), CARD_COLOURS[int(p.get('color', 0)) % len(CARD_COLOURS)])
                if kind == 'card':
                    self.mixer.add_card(b)
                    continue
            b.name = p.get('name', '')
            if kind != 'card' and b.mid is None and b.retry_at <= now:
                ask.append(b)
        if ask:
            res = await self.rpc('pull', tracks=[{'peer': b.peer, 'kind': b.kind} for b in ask])
            for b, r in zip(ask, res.get('tracks') or []):
                if r.get('error') or not r.get('mid'):
                    b.tries += 1
                    wait = RETRY_MS[min(b.tries - 1, len(RETRY_MS) - 1)] if r.get('error') == 'not_ready' else 2500
                    b.retry_at = time.time() + wait / 1000
                else:
                    b.mid = r['mid']
                    b.codec = r.get('codec') or ('opus' if b.kind == 'mic' else '')
                    log('pulled', b.key, 'mid', b.mid, 'codec', b.codec or '?')
                    self.mixer.expect(b)
            if res.get('offer'):
                answer = await self.loop.run_in_executor(None, self.mixer.answer, res['offer'])
                await self.rpc('renegotiate', answer=answer)

        # Removals. / 减。
        drop = [b for key, b in self.branches.items() if key not in want]
        mids = []
        for b in drop:
            del self.branches[b.key]
            if b.mid:
                mids.append(b.mid)
            self.mixer.remove(b)
        if mids:
            try:
                await self.rpc('close', side='sub', mids=mids)
            except Exception as e:  # noqa: BLE001
                log('close:', str(e)[:120])

        # The layout, for what is actually there: the grid stays until the screen has a frame to
        # show, so nobody watches an empty box while it connects.
        # 按真正在场的东西排版:屏幕出第一帧之前宫格保持不变,于是它连接期间没人对着一个空框看。
        screen = self.branches.get(screen_key) if screen_key else None
        front = screen if screen is not None and screen.shown else None
        tile_branches = [self.branches[k] for k in tiles if k in self.branches]
        boxes = layout(self.args.width, self.args.height, front is not None, len(tile_branches))
        if screen is not None and 'screen' in boxes:
            self.mixer.place(screen, boxes['screen'])
        if front is not None:
            self.mixer.unhide(front)
        for i, b in enumerate(tile_branches):
            self.mixer.place(b, boxes[i])

        retry = [b.retry_at for b in self.branches.values() if b.kind != 'card' and b.mid is None]
        if retry:
            delay = max(0.05, min(retry) - time.time())
            self.loop.call_later(delay, self.kick.set)
        self.status.update({'tiles': len(tile_branches), 'screen': front.key if front else None, 'mics': sum(1 for b in self.branches.values() if b.kind == 'mic' and b.mid), 'frames': self.mixer.frames})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ws', default=os.environ.get('MEET_WS', ''), help='the room door, bot ticket included')
    ap.add_argument('--origin', default=os.environ.get('MEET_ORIGIN', ''))
    ap.add_argument('--out', default=os.environ.get('MEET_OUT', '/tmp/meet.flv'), help='rtmp(s):// location, or a file')
    ap.add_argument('--width', type=int, default=int(os.environ.get('MEET_WIDTH', '1280')))
    ap.add_argument('--height', type=int, default=int(os.environ.get('MEET_HEIGHT', '720')))
    ap.add_argument('--fps', type=int, default=int(os.environ.get('MEET_FPS', '30')))
    ap.add_argument('--bitrate', type=int, default=int(os.environ.get('MEET_BITRATE', '0')))
    ap.add_argument('--seconds', type=int, default=0, help='stop by itself after this long (tests)')
    args = ap.parse_args()
    if not args.ws:
        print('MEET_WS is required', file=sys.stderr)
        return 2

    if os.environ.get('H264_ENCODER', 'openh264') == 'openh264':
        log('openh264:', json.dumps(openh264.ensure()))

    import gi
    gi.require_version('Gst', '1.0')
    gi.require_version('GstWebRTC', '1.0')
    gi.require_version('GstSdp', '1.0')
    gi.require_version('GstVideo', '1.0')
    from gi.repository import GLib, Gst, GstSdp, GstVideo, GstWebRTC  # noqa: F401 -- GstVideo is used by name later
    Gst.init(None)

    glib_loop = GLib.MainLoop()
    threading.Thread(target=glib_loop.run, daemon=True).start()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    director = Director(args, (Gst, GstWebRTC, GstSdp, GLib))

    failed = {'error': None}

    def on_bus(_bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            failed['error'] = f'{err.message} | {(dbg or "")[:300]}'
            log('pipeline error:', failed['error'])
            director.stopping = True
            loop.call_soon_threadsafe(lambda: asyncio.ensure_future(director.ws.close()) if director.ws else None)
        elif msg.type == Gst.MessageType.WARNING:
            err, _dbg = msg.parse_warning()
            log('pipeline warning:', err.message[:200])

    bus = director.mixer.pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect('message', on_bus)

    def shutdown(*_a):
        director.stopping = True
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(director.ws.close()) if director.ws else None)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    if args.seconds:
        loop.call_later(args.seconds, shutdown)

    sent = {'packets': 0, 'bytes': 0, 'probed': False}

    def probe_sender():
        # Diagnostic: how much leaves through the ICE socket. A receiver that sends nothing is a
        # receiver whose keyframe requests go nowhere.
        # 诊断用:有多少东西经 ICE 套接字发了出去。什么都不发的接收端,它的关键帧请求也就无处可去。
        wb = director.mixer.webrtc
        if wb is None or sent['probed']:
            return
        it = wb.iterate_recurse()
        while True:
            ok, el = it.next()
            if ok != Gst.IteratorResult.OK:
                break
            f = el.get_factory()
            if f is not None and f.get_name() == 'nicesink':
                def count(_pad, info):
                    buf = info.get_buffer()
                    if buf is not None:
                        sent['packets'] += 1
                        sent['bytes'] += buf.get_size()
                    else:
                        lst = info.get_buffer_list()
                        if lst is not None:
                            sent['packets'] += lst.length()
                    return Gst.PadProbeReturn.OK
                el.get_static_pad('sink').add_probe(Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, count)
                sent['probed'] = True

    async def report():
        while True:
            await asyncio.sleep(5)
            director.status['frames'] = director.mixer.frames
            if os.environ.get('MEET_DEBUG_SDP'):
                probe_sender()
                director.status['sent'] = dict(sent)
                try:
                    rtpbin = director.mixer.webrtc.get_by_name('rtpbin')
                    sess = rtpbin.emit('get-internal-session', 0)
                    rows = []
                    for src in sess.get_property('sources'):
                        st = src.get_property('stats')
                        if st.get_value('internal'):
                            continue
                        rows.append({k: st.get_value(k) for k in ('ssrc', 'packets-received', 'sent-pli-count', 'sent-fir-count', 'sent-nack-count') if st.has_field(k)})
                    director.status['rtp'] = rows
                except Exception as e:  # noqa: BLE001
                    director.status['rtp'] = str(e)[:120]
            log('status', json.dumps(director.status, ensure_ascii=False))

    loop.create_task(report())
    try:
        loop.run_until_complete(director.run())
    finally:
        glib_loop.quit()
    log('done', json.dumps({**director.status, 'frames': director.mixer.frames, 'error': failed['error']}, ensure_ascii=False))
    return 1 if failed['error'] else 0


if __name__ == '__main__':
    code = main()
    sys.stdout.flush()
    # Streaming threads that are stuck in a network read do not answer to anything gentler.
    # 卡在网络读取里的流线程,对任何更温和的办法都没有反应。
    os._exit(code)
