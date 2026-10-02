// The media half of a meeting: one RTCPeerConnection to Cloudflare's SFU, and the bookkeeping
// that keeps it saying what the room says.
//
// WHAT IS SENT
// Three tracks at most:
//   mic     Opus, always alive once published; muting disables the track, it does not remove it,
//           because the SFU forgets a track that sends nothing for thirty seconds
//   cam     the camera. Everybody's is the same kind of picture -- nobody is "the large one" --
//           captured at the meeting's resolution and sent at whatever size a tile is worth right
//           now: the whole of it while two people talk, a third of it when sixteen share a screen
//   screen  a shared screen, one in the room at a time
//
// WHAT IS RECEIVED
// The room says who publishes what; the page says which of those it wants on screen; want()
// reconciles the two. One thing learned the hard way, from the real SFU: a track whose publisher
// has negotiated but is not sending yet is "not found". That lasts a few hundred milliseconds, so
// it is asked for again rather than reported as an error -- and one request can succeed for some
// tracks and fail for others.
//
// TWO CONNECTIONS, NOT ONE
// Publishing and subscribing each get their own RTCPeerConnection (and their own SFU session).
// A publish is an offer of ours; a subscribe is answered by the SFU with an offer of ITS own.
// Mixing the two on one connection breaks against the real SFU in a way no amount of care on
// this side fixes: once the connection has accepted an SFU-made offer (which maps payload types
// 116/117 to H.265 and its retransmission), the SFU's answer to a later offer of ours lists the
// retransmission entry without the codec it belongs to, and the browser throws the whole answer
// out ("Failed to set remote video description send parameters"). Kept apart, the publishing
// connection only ever sees our offers and the subscribing one only the SFU's -- the two orders
// that were each proven to work -- and they no longer wait for one another either: joining sends
// and receives at the same time.
//
// Within one connection every negotiation goes through one queue, because two offers in flight
// on the same connection is how a session gets wedged.
//
// 会议的媒体这一半:一条通向 Cloudflare SFU 的 RTCPeerConnection,以及让它与房间保持一致的那些簿记。
//
// 发什么
// 最多三条轨:
//   mic     Opus,发布之后一直活着;静音是禁用轨道而不是移除,因为 SFU 会忘掉三十秒不发包的轨
//   cam     摄像头。每个人的都是同一种画面 —— 没有谁是"大的那一路" —— 按会议画幅采集,
//           按"此刻一格值多大"来发:两个人对谈时发全幅,十六个人同屏时发三分之一
//   screen  共享的屏幕,整个房间同一时刻只有一块
//
// 收什么
// 房间说谁发布了什么;页面说其中哪些要上屏;want() 负责把两者对齐。有一件事是从真实的 SFU 上学来的:
// 发布方已协商但尚未开始发包的轨,会被答成"找不到"。那只持续几百毫秒,所以是再要一次,
// 而不是报错 —— 而且一次请求可以部分成功、部分失败。
//
// 两条连接,不是一条
// 发布与订阅各用各的 RTCPeerConnection(以及各自的 SFU 会话)。发布是我们的 offer;
// 订阅则由 SFU 用**它自己的** offer 来回答。两者混在一条连接上,在真实的 SFU 上会坏,
// 而且这一侧再小心也修不了:连接一旦接受过 SFU 发来的 offer(它把负载类型 116/117 映射为
// H.265 及其重传),SFU 对我们此后的 offer 的应答里,就会只列出那条重传条目、却不列它所属的编码,
// 浏览器于是把整份应答扔掉("Failed to set remote video description send parameters")。
// 分开之后,发布那条连接只见过我们的 offer,订阅那条只见过 SFU 的 —— 这两种次序各自都验证过可行 ——
// 而且它们不再互相等待:入会时收与发同时进行。
//
// 同一条连接之内,所有协商走同一条队列,因为同一条连接上同时飞着两个 offer,会话就是这么卡死的。

const SIZES = {
  480: { w: 854, h: 480, screen: 1_200_000 },
  720: { w: 1280, h: 720, screen: 2_000_000 },
  1080: { w: 1920, h: 1080, screen: 3_000_000 },
};
const RETRY_MS = [250, 400, 600, 900, 1300, 2000];

/** What a camera is worth sending, by how many people share the screen. Everybody sends the same
 *  kind of picture, and a picture is only ever as large as the tile it lands in: with two people
 *  that is the whole window and the whole resolution; with sixteen it is a sixteenth of one, and
 *  sending 1080p into it would cost every viewer sixteen such streams to download and decode for
 *  detail no tile can show. The height is a ceiling on top of the meeting's own.
 *  一路摄像头值得发多大,取决于多少人同屏。每个人发的是同一种画面,而一路画面最大也就是它落进去的那一格那么大:
 *  两个人时,那一格是整扇窗、全幅;十六个人时是窗口的十六分之一,往里发 1080p,
 *  等于让每位观看者下载并解码十六路这样的流,换来的细节却没有哪一格显示得出来。这里的高度是会议画幅之上的又一道上限。 */
function camTarget(resolution, people) {
  const full = (SIZES[resolution] || SIZES[720]).h;
  const h = Math.min(full, people <= 2 ? full : people <= 4 ? 540 : people <= 9 ? 360 : people <= 16 ? 270 : 180);
  const maxBitrate = h >= 1080 ? 3_000_000 : h >= 720 ? 1_500_000 : h >= 540 ? 900_000 : h >= 480 ? 700_000 : h >= 360 ? 450_000 : h >= 270 ? 280_000 : 150_000;
  return { h, maxBitrate, maxFramerate: h >= 360 ? 30 : h >= 270 ? 24 : 15 };
}

const keyOf = (peer, kind) => `${peer}:${kind}`;

/** Ask the encoder for Opus DTX: silence is sent as a trickle instead of at full rate, which is
 *  most of what thirty open microphones cost. Touches the one fmtp line it understands and
 *  nothing else; if the line is not there, the SDP goes out as it was.
 *  向编码器要 Opus DTX:静默时只发涓滴而不是满速率,三十个开着的麦克风的开销大半在这儿。
 *  只碰它认识的那一行 fmtp,别的不动;找不到那一行,SDP 原样出去。 */
function withDtx(sdp) {
  const m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
  if (!m) return sdp;
  const re = new RegExp(`a=fmtp:${m[1]} ([^\\r\\n]*)`);
  return re.test(sdp) ? sdp.replace(re, (line, p) => (/usedtx=/.test(p) ? line : `a=fmtp:${m[1]} ${p};usedtx=1`)) : sdp;
}

/** Put one codec first, when the browser lets us.
 *
 *  In a small meeting a shared screen asks for H.264: it is what most hardware encodes, and a
 *  1080p software encode is what makes a laptop's fan audible. Cameras are left to the browser.
 *
 *  In a broadcast meeting EVERY picture asks for VP8, cameras included. The compositor that
 *  makes the audience's stream answers the SFU with one codec per track, and the SFU takes a
 *  subscriber's first answer as the list of what it can decode: a room where one picture is VP8
 *  and the next H.264 is a room whose second picture never reaches the audience. (Measured; see
 *  docs/meet-design.md.) Safari, left alone, would send H.264.
 *
 *  浏览器允许的话,把某一种编码排在最前。
 *
 *  小组会议里,共享的屏幕要 H.264:多数硬件编的就是它,而 1080p 的软件编码正是让笔记本风扇响起来的那件事。摄像头交给浏览器自己定。
 *
 *  直播会议里,**每一路**画面都要 VP8,摄像头也不例外。给旁观者做流的合成器,对每条轨只用一种编码应答 SFU,
 *  而 SFU 把订阅者的第一份应答当作"它能解什么"的清单:一间房里这一路是 VP8、下一路是 H.264,
 *  第二路就永远到不了旁观者那里。(实测,见 docs/meet-design.md。)Safari 若不加干预,发的会是 H.264。 */
function preferCodec(tr, name) {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video');
    if (!caps || !tr.setCodecPreferences) return;
    const is = (c) => c.mimeType.toLowerCase() === `video/${name}`;
    const rank = (c) => (is(c) ? (name !== 'h264' || /packetization-mode=1/.test(c.sdpFmtpLine || '') ? 0 : 1) : 2);
    tr.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
  } catch { /* the default order still works / 默认顺序照样能用 */ }
}

export class Rtc {
  /**
   * @param o.signal  a seat from signal.js / signal.js 给的座位
   * @param o.ice     iceServers from the room's welcome / 房间 welcome 里的 iceServers
   * @param o.cfg     { video, resolution, e2ee }
   * @param o.hooks   { remote(peer, kind, track|null), local(), levels(Map), trouble(code) }
   * @param o.e2ee    { crypt, peer } in an encrypted meeting: every sender and receiver goes
   *                  through crypt, and what this seat sends is keyed to `peer`
   *                  加密会议里是 { crypt, peer }:每个发送端和接收端都经过 crypt,本座位发出的用 `peer` 派生钥匙
   */
  constructor({ signal, ice, cfg, hooks, e2ee = null }) {
    this.signal = signal;
    this.cfg = cfg;
    this.hooks = hooks;
    this.ice = ice;
    this.e2ee = e2ee;
    /** Receives. The object is made now; its SFU session only when there is first something to
     *  receive -- the SFU abandons a session whose connection does not come up soon after it is
     *  created, and somebody alone in a room has nothing to connect for.
     *  收。对象现在就建;它在 SFU 上的会话要等第一次有东西可收时才建 —— SFU 会放弃一个
     *  "建好之后迟迟连不上"的会话,而独自在房间里的人,并没有什么可连的。 */
    this.sub = this.newPc();
    this.subResets = [];
    /** Sends. Made when there is first something to send. / 发。第一次有东西要发时才建。 */
    this.pub = null;
    this.subChain = Promise.resolve();
    this.pubChain = Promise.resolve();
    this.ready = null;
    this.stopped = false;

    /** kind -> RTCRtpTransceiver, for what we publish / 我们发布的:kind -> transceiver */
    this.sent = { mic: null, cam: null, screen: null };
    this.micTrack = null;
    this.camTrack = null;
    this.screenTrack = null;
    /** How many people share the screen, as the page last said. / 多少人同屏,以页面上一次说的为准。 */
    this.crowd = 1;

    /** key -> { peer, kind, mid, track, live, tries, retryAt } */
    this.remote = new Map();
    this.desired = new Map();
    this.midKey = new Map();
    this.syncing = false;
    this.dirty = false;
    this.retryTimer = 0;

    this.sub.ontrack = (e) => this.onTrack(e);
    this.levelTimer = setInterval(() => this.sampleLevels(), 500);
  }

  newPc() {
    // The older Chrome way of reaching encoded frames has to be asked for when the connection is
    // made. / 旧版 Chrome 触及编码帧的方式,必须在建连接时就提出来。
    const legacy = !!this.e2ee?.crypt?.legacy;
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle', ...(legacy ? { encodedInsertableStreams: true } : {}) });
    pc.onconnectionstatechange = () => {
      if (this.stopped) return;
      // Either connection failing is the meeting failing, and the worse of the two is the news.
      // 两条连接中任何一条失败都是会议失败;两者之中更糟的那个才是要报的消息。
      const states = [this.sub, this.pub].filter(Boolean).map((x) => x.connectionState);
      if (states.includes('failed')) this.hooks.trouble?.('ice_failed');
      else if (states.includes('disconnected')) this.hooks.trouble?.('ice_unstable');
      else if (states.every((s) => s === 'connected')) this.hooks.trouble?.(null);
    };
    return pc;
  }

  serialSub(fn) {
    const p = this.subChain.then(() => (this.stopped ? undefined : fn()));
    this.subChain = p.catch(() => {});
    return p;
  }

  /** Publishing waits for the seat's session to exist, and then for its own queue.
   *  发布先等这个座位的会话建好,再排自己的队。 */
  serialPub(fn) {
    const p = this.pubChain.then(() => this.ready).then(() => (this.stopped ? undefined : fn()));
    this.pubChain = p.catch(() => {});
    return p;
  }

  /** First in the queue, so that whatever the room asks for while the session is still being
   *  made waits behind it instead of arriving at an SFU that has never heard of us.
   *  排在队列最前:会话还在建立时房间提出的任何要求,都排在它后面等,
   *  而不是先一步到达一个还从没听说过我们的 SFU。 */
  start(fresh = false) {
    this.ready = this.serialSub(() => this.signal.rpc('session', fresh ? { fresh: true } : {}));
    return this.ready;
  }

  // ---------- publishing ----------
  // ---------- 发布 ----------

  /** One offer for however many tracks are being added. / 一次加几条轨,就只发一个 offer。 */
  async push(specs) {
    return this.serialPub(async () => {
      if (!this.pub) this.pub = this.newPc();
      const pc = this.pub;
      const trs = specs.map((s) => {
        const tr = pc.addTransceiver(s.track, { direction: 'sendonly', sendEncodings: [s.encoding || {}] });
        // Before a single frame leaves: in an encrypted meeting nothing goes out in the clear.
        // 在第一帧离开之前:加密会议里没有任何东西以明文出去。
        if (this.e2ee) this.e2ee.crypt.attachSend(tr.sender, s.track.kind, this.e2ee.peer);
        if (s.track.kind === 'video') {
          if (this.cfg.kind === 'live' || this.cfg.e2ee) preferCodec(tr, 'vp8');
          else if (s.h264) preferCodec(tr, 'h264');
        }
        return tr;
      });
      const offer = await pc.createOffer();
      offer.sdp = withDtx(offer.sdp);
      await pc.setLocalDescription(offer);
      let res;
      try {
        res = await this.signal.rpc('push', {
          offer: pc.localDescription.sdp,
          tracks: trs.map((tr, i) => ({ mid: tr.mid, kind: specs[i].kind })),
        });
      } catch (e) {
        // The room said no (or went away). The transceivers must not be left half-offered, or
        // the next negotiation inherits them. / 房间说了不(或者不在了)。不能把这些 transceiver
        // 留在"offer 了一半"的状态,否则下一次协商会把它们继承过去。
        for (const tr of trs) { try { tr.sender.replaceTrack(null); tr.direction = 'inactive'; } catch { /* gone / 已无 */ } }
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        // The SFU itself refused: the publishing session is no good any more, and everything on
        // it goes with it. That is a rebuild, which is the page's business, not this method's.
        // SFU 自己拒绝了:这个发布会话已经不行了,挂在它上面的一切随之作废。
        // 那是一次重建,归页面管,不归这个方法管。
        if (e?.code === 'sfu' || e?.code === 'timeout') this.hooks.trouble?.('ice_failed');
        throw e;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: res.answer });
      specs.forEach((s, i) => {
        const r = (res.tracks || [])[i];
        if (r && !r.error) this.sent[s.kind] = trs[i];
      });
      return res;
    });
  }

  async unpush(kinds) {
    return this.serialPub(async () => {
      const trs = kinds.map((k) => this.sent[k]).filter(Boolean);
      if (!trs.length || !this.pub) return;
      const pc = this.pub;
      for (const tr of trs) { try { await tr.sender.replaceTrack(null); tr.direction = 'inactive'; } catch { /* gone / 已无 */ } }
      for (const k of kinds) this.sent[k] = null;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await this.signal.rpc('close', { side: 'pub', mids: trs.map((t) => t.mid), offer: pc.localDescription.sdp });
      if (res.answer) await pc.setRemoteDescription({ type: 'answer', sdp: res.answer });
      else await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
    });
  }

  /** @returns whether the microphone is now live / 麦克风此刻是否在用 */
  async setMic(on, deviceId) {
    if (on && !this.micTrack) {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micTrack = s.getAudioTracks()[0];
      this.micTrack.onended = () => { this.micTrack = null; this.hooks.local?.(); };
      await this.push([{ kind: 'mic', track: this.micTrack }]);
    }
    if (this.micTrack) this.micTrack.enabled = !!on;
    this.hooks.local?.();
    return !!(this.micTrack && this.micTrack.enabled);
  }

  async swapMic(deviceId) {
    if (!this.micTrack) return;
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const next = s.getAudioTracks()[0];
    next.enabled = this.micTrack.enabled;
    await this.sent.mic?.sender.replaceTrack(next);
    this.micTrack.stop();
    this.micTrack = next;
    this.hooks.local?.();
  }

  camConstraints(deviceId) {
    const size = SIZES[this.cfg.resolution] || SIZES[720];
    return {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: size.w }, height: { ideal: size.h }, aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 30, max: 30 },
    };
  }

  camEncoding() {
    const t = camTarget(this.cfg.resolution, this.crowd);
    const h = this.camTrack?.getSettings().height || t.h;
    return { maxBitrate: t.maxBitrate, maxFramerate: t.maxFramerate, scaleResolutionDownBy: Math.max(1, h / t.h) };
  }

  /** The room grew or shrank: send the camera at what a tile is worth now. The capture itself
   *  does not change, so going from sixteen people back to two is sharp again at once.
   *  房间里的人多了或少了:按此刻一格值多大来发摄像头。采集本身不变,所以从十六个人回到两个人,画面立刻重新清晰。 */
  async setCrowd(people) {
    const n = Math.max(1, people | 0);
    if (n === this.crowd) return;
    this.crowd = n;
    const tr = this.sent.cam;
    if (!tr) return;
    try {
      const p = tr.sender.getParameters();
      if (!p.encodings?.length) return;
      Object.assign(p.encodings[0], this.camEncoding());
      await tr.sender.setParameters(p);
    } catch { /* an encoder that refuses keeps its old numbers / 拒绝的编码器保持原参数 */ }
  }

  async setCam(on, deviceId) {
    if (!this.cfg.video) return false;
    if (on && !this.camTrack) {
      const s = await navigator.mediaDevices.getUserMedia({ video: this.camConstraints(deviceId) });
      this.camTrack = s.getVideoTracks()[0];
      this.camTrack.onended = () => { this.setCam(false).catch(() => {}); };
      await this.push([{ kind: 'cam', track: this.camTrack, encoding: this.camEncoding() }]);
    } else if (!on && this.camTrack) {
      // Off means off: the capture stops, the light goes out. / 关就是关:采集停止,指示灯熄灭。
      await this.unpush(['cam']);
      this.camTrack.onended = null;
      this.camTrack.stop();
      this.camTrack = null;
    }
    this.hooks.local?.();
    return !!this.camTrack;
  }

  async swapCam(deviceId) {
    if (!this.camTrack) return;
    const s = await navigator.mediaDevices.getUserMedia({ video: this.camConstraints(deviceId) });
    const next = s.getVideoTracks()[0];
    await this.sent.cam?.sender.replaceTrack(next);
    this.camTrack.onended = null;
    this.camTrack.stop();
    this.camTrack = next;
    this.camTrack.onended = () => { this.setCam(false).catch(() => {}); };
    this.hooks.local?.();
  }

  /** Put a screen up. Has to be called from the click itself -- the browser's picker opens only
   *  for a gesture -- and the room may still say no: one screen at a time.
   *  把一块屏幕放上来。必须在点击当场调用 —— 浏览器的选择框只为用户手势打开 ——
   *  而房间仍然可能说不:同一时刻只有一块屏幕。 */
  async startScreen() {
    if (this.screenTrack) return;
    const size = SIZES[this.cfg.resolution] || SIZES[720];
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: size.w }, height: { max: size.h }, frameRate: { ideal: 15, max: 15 } }, audio: false,
    });
    const track = s.getVideoTracks()[0];
    try { track.contentHint = 'detail'; } catch { /* a hint, not a need / 只是提示 */ }
    this.screenTrack = track;
    // The browser's own "stop sharing" bar ends the track; the room has to hear about it too.
    // 浏览器自己的"停止共享"条会结束这条轨;房间也得知道这件事。
    track.onended = () => { this.stopScreen().catch(() => {}); };
    try {
      await this.push([{ kind: 'screen', track, encoding: { maxBitrate: size.screen, maxFramerate: 15 }, h264: true }]);
      try {
        const p = this.sent.screen.sender.getParameters();
        p.degradationPreference = 'maintain-resolution';
        await this.sent.screen.sender.setParameters(p);
      } catch { /* a preference / 只是偏好 */ }
    } catch (e) {
      track.onended = null;
      track.stop();
      this.screenTrack = null;
      throw e;
    }
    this.hooks.local?.();
  }

  async stopScreen() {
    const track = this.screenTrack;
    if (!track) return;
    this.screenTrack = null;
    track.onended = null;
    if (this.sent.screen) await this.unpush(['screen']).catch(() => {});
    track.stop();
    this.hooks.local?.();
  }

  // ---------- subscribing ----------
  // ---------- 订阅 ----------

  /** What should be arriving, as the page sees it: [{peer, kind}]. Safe to call as often as the
   *  room changes; only the difference is acted on. / 页面认为此刻应当到达的东西:[{peer, kind}]。
   *  房间变多少次就可以调多少次;只对差异动手。 */
  want(list) {
    this.desired = new Map(list.map((x) => [keyOf(x.peer, x.kind), x]));
    this.kick();
  }

  kick() {
    if (this.stopped) return;
    if (this.syncing) { this.dirty = true; return; }
    this.syncing = true;
    this.serialSub(() => this.reconcile())
      .catch((e) => { if (e?.code !== 'offline' && e?.message !== 'closed') console.warn('[meet] reconcile', e); })
      .finally(() => {
        this.syncing = false;
        if (this.dirty) { this.dirty = false; this.kick(); }
      });
  }

  async reconcile() {
    const t = Date.now();

    // Additions first: make before break. / 先加后减:先接后断。
    const add = [];
    for (const [k, x] of this.desired) {
      const have = this.remote.get(k);
      if (!have) { this.remote.set(k, { ...x, mid: null, track: null, live: false, tries: 0, retryAt: 0 }); add.push(k); }
      else if (!have.mid && have.retryAt <= t) add.push(k);
    }
    if (add.length) {
      let res;
      try {
        res = await this.signal.rpc('pull', { tracks: add.map((k) => ({ peer: this.remote.get(k).peer, kind: this.remote.get(k).kind })) });
      } catch (e) {
        // The SFU would not serve this session -- it has expired, or its connection never came
        // up. Start the receiving side over and ask again.
        // SFU 不肯为这个会话服务 —— 它过期了,或者它的连接从来没建起来。把接收这一侧重来一遍,再要一次。
        if (e?.code === 'sfu' || e?.code === 'timeout') await this.resetSub();
        throw e;
      }
      (res.tracks || []).forEach((r, i) => {
        const ent = this.remote.get(add[i]);
        if (!ent) return;
        if (r.error || !r.mid) {
          ent.tries += 1;
          // "gone" is the room saying it has no such track right now; the roster will say when it
          // does, so that waits longer than a track that is merely warming up. / "gone" 是房间说
          // "此刻没有这条轨";等它有了名册自会说,所以这种情况比"轨道只是在预热"等得更久。
          const wait = r.error === 'not_ready' ? RETRY_MS[Math.min(ent.tries - 1, RETRY_MS.length - 1)] : 2500;
          ent.retryAt = Date.now() + wait;
        } else {
          ent.mid = r.mid;
          this.midKey.set(r.mid, add[i]);
        }
      });
      if (res.offer) {
        await this.sub.setRemoteDescription({ type: 'offer', sdp: res.offer });
        const answer = await this.sub.createAnswer();
        await this.sub.setLocalDescription(answer);
        await this.signal.rpc('renegotiate', { answer: this.sub.localDescription.sdp });
      }
    }

    // Removals. / 减。
    const drop = [];
    for (const [k] of this.remote) if (!this.desired.has(k)) drop.push(k);
    const mids = [];
    for (const k of drop) {
      const ent = this.remote.get(k);
      this.remote.delete(k);
      if (ent.mid) { mids.push(ent.mid); this.midKey.delete(ent.mid); }
      if (ent.track) this.hooks.remote?.(ent.peer, ent.kind, null);
    }
    if (mids.length) {
      // Let go without negotiating. The subscribing connection never makes an offer of its own --
      // that is the whole arrangement -- so the SFU is simply told to stop sending, and the
      // m-line stays where it is, silent. / 不经协商地放手。订阅那条连接从不自己发 offer ——
      // 整个安排的要点就在于此 —— 所以只是告诉 SFU 别再发了,那条 m-line 留在原处,不再出声。
      try {
        await this.signal.rpc('close', { side: 'sub', mids });
      } catch (e) {
        if (e?.code === 'offline') throw e;
      }
    }

    // Anything still warming up gets another look. / 还在预热的,稍后再看一眼。
    clearTimeout(this.retryTimer);
    let soon = Infinity;
    for (const ent of this.remote.values()) if (!ent.mid) soon = Math.min(soon, ent.retryAt);
    if (soon !== Infinity) this.retryTimer = setTimeout(() => this.kick(), Math.max(50, soon - Date.now()));
  }

  /** Throw the receiving connection away and make another. Everything that was arriving stops
   *  arriving, the page is told so, and want() brings it all back on the new connection. Done at
   *  most a few times in a row: past that the trouble is not this connection, and the page gets
   *  to decide.
   *  把接收那条连接扔掉、另建一条。正在到达的一切都停了,页面会被告知,want() 会在新连接上把它们全要回来。
   *  连续最多做几次:再多,问题就不在这条连接上了,交给页面定夺。 */
  async resetSub() {
    const t = Date.now();
    this.subResets = this.subResets.filter((x) => t - x < 30000);
    this.subResets.push(t);
    if (this.subResets.length > 3) { this.hooks.trouble?.('ice_failed'); return; }
    for (const ent of this.remote.values()) if (ent.track) this.hooks.remote?.(ent.peer, ent.kind, null);
    this.remote.clear();
    this.midKey.clear();
    try { this.sub.close(); } catch { /* gone / 已无 */ }
    this.sub = this.newPc();
    this.sub.ontrack = (e) => this.onTrack(e);
    await this.signal.rpc('reset', { side: 'sub' }).catch(() => {});
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.kick(), 600);
  }

  onTrack(e) {
    const k = this.midKey.get(e.transceiver.mid);
    const ent = k && this.remote.get(k);
    if (!ent) return;
    if (this.e2ee) this.e2ee.crypt.attachRecv(e.receiver, e.track.kind, ent.peer);
    ent.track = e.track;
    // Handed to the page at once, muted or not. Waiting for `unmute` first reads well and works
    // in Chrome, and on an iPhone it never ends: WebKit does not decode a remote video track
    // that nothing is showing, so the track stays muted until it is given to an element -- which
    // this code was waiting for `unmute` to do. Sound was unaffected, which is exactly how it
    // looked: people heard the meeting and saw nobody. Whether a picture has actually arrived is
    // the element's business (its first frame), and the page asks the element.
    // 立刻交给页面,不管它是不是 muted。先等 `unmute` 读起来很顺、在 Chrome 里也管用,
    // 在 iPhone 上却永远等不到:WebKit 不会去解码一条"没有任何东西在显示"的远端视频轨,
    // 于是这条轨在被交给某个元素之前一直是 muted —— 而这段代码正等着 `unmute` 才肯把它交出去。
    // 声音不受影响,现象也正是如此:听得到会,看不到人。画面到底来了没有,是元素的事(它的第一帧),页面去问元素。
    ent.live = true;
    this.hooks.remote?.(ent.peer, ent.kind, ent.track);
  }

  /** What the receiving side looks like from the inside, for the page's diagnostics panel: a
   *  phone has no console to open. / 接收侧从里面看是什么样,给页面的诊断面板用:手机上没有控制台可开。 */
  async diag() {
    const rows = [];
    const byMid = new Map();
    try {
      (await this.sub.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp') byMid.set(s.mid, s);
      });
    } catch { /* closed / 已关闭 */ }
    let codecs = null;
    try { codecs = await this.sub.getStats(); } catch { /* closed / 已关闭 */ }
    for (const [k, ent] of this.remote) {
      const s = ent.mid ? byMid.get(ent.mid) : null;
      const c = s?.codecId && codecs?.get ? codecs.get(s.codecId) : null;
      rows.push({
        key: k, mid: ent.mid, muted: ent.track?.muted, state: ent.track?.readyState,
        codec: c?.mimeType || '', bytes: s?.bytesReceived || 0, packets: s?.packetsReceived || 0,
        decoded: s?.framesDecoded, dropped: s?.framesDropped, size: s?.frameWidth ? `${s.frameWidth}x${s.frameHeight}` : '',
        pli: s?.pliCount, decoder: s?.decoderImplementation || '',
      });
    }
    return { ice: this.sub?.iceConnectionState, conn: this.sub?.connectionState, sig: this.sub?.signalingState, rows };
  }


  // ---------- who is talking ----------
  // ---------- 谁在说话 ----------

  async sampleLevels() {
    if (this.stopped || document.hidden || !this.hooks.levels) return;
    const levels = new Map();
    try {
      (await this.sub.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio' && typeof s.audioLevel === 'number') {
          const ent = this.remote.get(this.midKey.get(s.mid));
          if (ent) levels.set(ent.peer, s.audioLevel);
        }
      });
      if (this.pub) {
        (await this.pub.getStats()).forEach((s) => {
          if (s.type === 'media-source' && s.kind === 'audio' && typeof s.audioLevel === 'number') {
            levels.set('', this.micTrack?.enabled ? s.audioLevel : 0);
          }
        });
      }
    } catch { return; }
    if (!this.stopped) this.hooks.levels(levels);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.levelTimer);
    clearTimeout(this.retryTimer);
    for (const t of [this.micTrack, this.camTrack, this.screenTrack]) { try { if (t) { t.onended = null; t.stop(); } } catch { /* gone / 已无 */ } }
    this.micTrack = this.camTrack = this.screenTrack = null;
    for (const pc of [this.sub, this.pub]) { try { pc?.close(); } catch { /* gone / 已无 */ } }
  }
}
