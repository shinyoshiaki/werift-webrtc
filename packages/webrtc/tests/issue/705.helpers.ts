/**
 * Issue #705 (非対応 RTP m-line の拒否 / m-line 再利用) テストの Arrange 用ユーティリティ。
 * 705.test.ts と 705-reuse.test.ts から共有する。
 */
import {
  type MLineReuse,
  MediaStreamTrack,
  type PeerConfig,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  type RTCRtpTransceiver,
  RtpHeader,
  RtpPacket,
  SessionDescription,
  useOPUS,
} from "../../src";

/** remote SDP の m-line で使う codec */
export type TestCodec = "opus" | "PCMU" | "VP8" | "H264";

const codecLines: Record<TestCodec, { pt: number; rtpmap: string }> = {
  opus: { pt: 111, rtpmap: "opus/48000/2" },
  PCMU: { pt: 0, rtpmap: "PCMU/8000" },
  VP8: { pt: 96, rtpmap: "VP8/90000" },
  H264: { pt: 102, rtpmap: "H264/90000" },
};

export type RemoteSection = {
  kind: "audio" | "video" | "application";
  mid: string;
  /** 既定は 9 */
  port?: number;
  codec?: TestCodec;
  direction?: "sendrecv" | "sendonly" | "recvonly" | "inactive";
  ssrc?: number;
  /** 既定は session 共通の ufrag */
  ufrag?: string;
};

export const REMOTE_UFRAG = "remoteufrag";
const REMOTE_PWD = "remotepasswordwithenoughlength";
const FINGERPRINT =
  "sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF";

/**
 * ブラウザ相当の remote offer / answer SDP を組み立てる。
 * `bundle` / `bundles` を省略すると BUNDLE group を付けない (unbundled)。
 * `bundles` は複数の BUNDLE group を並べる場合に使う。
 */
export function buildRemoteSdp({
  sections,
  bundle,
  bundles = bundle ? [bundle] : [],
  setup = "actpass",
}: {
  sections: RemoteSection[];
  bundle?: string[];
  bundles?: string[][];
  setup?: "actpass" | "active" | "passive";
}) {
  const lines = ["v=0", "o=- 4611731400430051336 2 IN IP4 127.0.0.1", "s=-"];
  lines.push("t=0 0");
  for (const group of bundles) {
    lines.push(`a=group:BUNDLE ${group.join(" ")}`);
  }
  lines.push("a=msid-semantic: WMS *");

  for (const section of sections) {
    const port = section.port ?? 9;
    if (section.kind === "application") {
      lines.push(`m=application ${port} UDP/DTLS/SCTP webrtc-datachannel`);
    } else {
      const codec = codecLines[section.codec ?? "opus"];
      lines.push(`m=${section.kind} ${port} UDP/TLS/RTP/SAVPF ${codec.pt}`);
    }
    lines.push("c=IN IP4 0.0.0.0");
    lines.push(`a=ice-ufrag:${section.ufrag ?? REMOTE_UFRAG}`);
    lines.push(`a=ice-pwd:${REMOTE_PWD}`);
    lines.push("a=ice-options:trickle");
    lines.push(`a=fingerprint:${FINGERPRINT}`);
    lines.push(`a=setup:${setup}`);
    lines.push(`a=mid:${section.mid}`);
    if (section.kind === "application") {
      lines.push("a=sctp-port:5000");
      lines.push("a=max-message-size:262144");
      continue;
    }
    const codec = codecLines[section.codec ?? "opus"];
    lines.push(`a=${section.direction ?? "sendrecv"}`);
    lines.push(`a=msid:stream-${section.mid} track-${section.mid}`);
    lines.push("a=rtcp-mux");
    lines.push(`a=rtpmap:${codec.pt} ${codec.rtpmap}`);
    if (section.ssrc != undefined) {
      lines.push(`a=ssrc:${section.ssrc} cname:remote`);
    }
  }
  return lines.join("\r\n") + "\r\n";
}

/** 音声のみ扱える werift (デフォルト VP8 を残さない) */
export function audioOnlyConfig(
  config: Partial<RTCPeerConnectionConfig> = {},
): RTCPeerConnectionConfig {
  return {
    iceServers: [],
    ...config,
    codecs: { audio: [useOPUS()], video: [] },
  };
}

export function createAudioOnlyPeer(
  config: Partial<RTCPeerConnectionConfig> = {},
) {
  return new RTCPeerConnection(audioOnlyConfig(config));
}

/** STUN を待たずにローカル候補だけで接続するデフォルト構成の peer */
export function createPeer(config: Partial<RTCPeerConnectionConfig> = {}) {
  return new RTCPeerConnection({ iceServers: [], ...config });
}

export function parseSdp(sdp: string) {
  return SessionDescription.parse(sdp);
}

/** m-line の比較用サマリ */
export function mLines(sdp: string) {
  return parseSdp(sdp).media.map((media) => ({
    kind: media.kind,
    port: media.port,
    profile: media.profile,
    fmt: media.fmt.map((v) => v.toString()),
    mid: media.rtp.muxId,
  }));
}

export function bundleGroups(sdp: string) {
  return parseSdp(sdp)
    .group.filter((group) => group.semantic === "BUNDLE")
    .map((group) => group.items);
}

/** remote offer を適用して answer を確定させ、answer SDP を返す */
export async function answerRemoteOffer(pc: RTCPeerConnection, sdp: string) {
  await pc.setRemoteDescription({ type: "offer", sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return pc.localDescription!.sdp;
}

/** offer / answer を 1 往復させ、offer / answer の SDP を返す */
export async function negotiate(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
) {
  await offerer.setLocalDescription(await offerer.createOffer());
  const offer = offerer.localDescription!.sdp;
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  const answer = answerer.localDescription!.sdp;
  await offerer.setRemoteDescription(answerer.localDescription!);
  return { offer, answer };
}

/** trickle ICE の候補を互いに転送する */
export function exchangeIceCandidates(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
) {
  const forward = (from: RTCPeerConnection, to: RTCPeerConnection) => {
    from.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        return;
      }
      to.addIceCandidate(candidate).catch(() => {});
    });
  };
  forward(pc1, pc2);
  forward(pc2, pc1);
}

export async function waitForConnected(...pcs: RTCPeerConnection[]) {
  await Promise.all(
    pcs.map((pc) =>
      pc.connectionState === "connected"
        ? Promise.resolve()
        : pc.connectionStateChange.watch((state) => state === "connected"),
    ),
  );
}

/** ローカル候補の収集完了 (null candidate) まで待ち、候補を返す */
export function collectLocalCandidates(pc: RTCPeerConnection) {
  const candidates: { sdpMid?: string; sdpMLineIndex?: number }[] = [];
  const done = new Promise<typeof candidates>((resolve) => {
    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        resolve(candidates);
        return;
      }
      candidates.push({
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      });
    });
  });
  return done;
}

/** negotiationneeded の発火回数を数える */
export function countNegotiationNeeded(pc: RTCPeerConnection) {
  const counter = { count: 0 };
  pc.onNegotiationneeded.subscribe(() => {
    counter.count++;
  });
  return counter;
}

/** setImmediate で遅延する negotiationneeded を確定させるための待機 */
export function flushEvents() {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}

/** RtpRouter の SSRC 登録を観測する (テスト専用) */
export function routedSsrcs(pc: RTCPeerConnection) {
  const router = Reflect.get(pc, "router") as {
    ssrcTable: Record<number, unknown>;
  };
  return Object.keys(router.ssrcTable).map(Number);
}

export function remoteSsrcOf(transceiver: RTCRtpTransceiver) {
  return transceiver.receiver.tracks.map((track) => track.ssrc);
}

/**
 * `track` へ RTP を書き込み続け、`receiverTransceiver` の remote track で
 * payload を受信できるまで待つ。
 */
export async function expectRtpDelivered({
  track,
  receiverTransceiver,
  payload,
  timeoutMs = 10_000,
}: {
  track: MediaStreamTrack;
  receiverTransceiver: RTCRtpTransceiver;
  payload: string;
  timeoutMs?: number;
}) {
  let sequenceNumber = 0;
  const timer = setInterval(() => {
    track.writeRtp(
      new RtpPacket(
        new RtpHeader({ sequenceNumber: sequenceNumber++, timestamp: 0 }),
        Buffer.from(payload),
      ),
    );
  }, 20);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`RTP "${payload}" was not delivered`)),
        timeoutMs,
      );
      const check = () => {
        for (const remoteTrack of receiverTransceiver.receiver.tracks) {
          remoteTrack.onReceiveRtp.subscribe((rtp) => {
            if (rtp.payload.toString() === payload) {
              clearTimeout(timeout);
              resolve();
            }
          });
        }
      };
      if (receiverTransceiver.receiver.tracks.length > 0) {
        check();
      } else {
        receiverTransceiver.onTrack.once(() => check());
      }
    });
  } finally {
    clearInterval(timer);
  }
}

export function createTrack(kind: "audio" | "video") {
  return new MediaStreamTrack({ kind });
}

export type PeerConfigPatch = Partial<PeerConfig>;

export async function closeAll(...pcs: RTCPeerConnection[]) {
  await Promise.allSettled(pcs.map((pc) => pc.close()));
}

/** audio + video を交渉済みの werift ペアを作る */
export async function createNegotiatedPair({
  mLineReuse = "compatible",
  bundlePolicy,
  dataChannelFirst = false,
  connect = false,
}: {
  mLineReuse?: MLineReuse;
  bundlePolicy?: "disable";
  dataChannelFirst?: boolean;
  connect?: boolean;
} = {}) {
  const caller = createPeer({ mLineReuse, bundlePolicy });
  const callee = createPeer({ mLineReuse, bundlePolicy });
  if (connect) {
    exchangeIceCandidates(caller, callee);
  }
  if (dataChannelFirst) {
    // SCTP を先に交渉して m-line 0 に置く
    caller.createDataChannel("dc");
    await negotiate(caller, callee);
  }
  const audioTrack = createTrack("audio");
  const videoTrack = createTrack("video");
  const audio = caller.addTransceiver(audioTrack);
  const video = caller.addTransceiver(videoTrack);
  await negotiate(caller, callee);
  if (connect) {
    await waitForConnected(caller, callee);
  }
  return { caller, callee, audio, video, audioTrack, videoTrack };
}

export function transceiverByMid(
  pc: RTCPeerConnection,
  mid: string | undefined,
) {
  return pc.getTransceivers().find((t) => t.mid === mid);
}

/**
 * remote offerer が video (MID "1") を port 0 で停止し、その停止確定後に
 * werift 側が自分の offer 前に addTransceiver("video") で index 1 を予約した状態を作る。
 */
export async function createRemoteStoppedVideoReservation() {
  const pc = createPeer();
  await answerRemoteOffer(
    pc,
    buildRemoteSdp({
      sections: [
        { kind: "audio", mid: "0" },
        { kind: "video", mid: "1", codec: "VP8" },
      ],
      bundle: ["0", "1"],
    }),
  );
  await answerRemoteOffer(
    pc,
    buildRemoteSdp({
      sections: [
        { kind: "audio", mid: "0" },
        { kind: "video", mid: "1", codec: "VP8", port: 0 },
      ],
      bundle: ["0"],
    }),
  );
  const reservedVideo = pc.addTransceiver("video");
  return { pc, reservedVideo };
}

/**
 * onnegotiationneeded で offer を作り、WebSocket 相当の直列キューで answerer と往復させる
 * 一般的なアプリ実装を再現する。offer 数と発生したエラーを記録する。
 */
export function startAutoNegotiation(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
) {
  const result = { offers: 0, errors: [] as unknown[] };
  let queue = Promise.resolve();
  const send = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error) => {
      result.errors.push(error);
    });
  };
  offerer.onnegotiationneeded = async () => {
    try {
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      result.offers++;
      const localOffer = offerer.localDescription!;
      send(async () => {
        await answerer.setRemoteDescription(localOffer);
        await answerer.setLocalDescription(await answerer.createAnswer());
        const answer = answerer.localDescription!;
        send(() => offerer.setRemoteDescription(answer));
      });
    } catch (error) {
      result.errors.push(error);
    }
  };
  return {
    result,
    /** 直列キューの処理が落ち着くまで待つ */
    settle: async () => {
      for (let i = 0; i < 5; i++) {
        await flushEvents();
        await queue;
      }
    },
  };
}

/**
 * caller (compatible) が sendonly video を 1 本ずつ追加交渉し、callee を指定モードの answerer にした
 * 接続済みペアを作る (Chromium offerer + werift answerer の removeTrack E2E と同じ構成)。
 */
export async function createSendonlyVideoPair({
  calleeMLineReuse,
  count,
}: {
  calleeMLineReuse: MLineReuse;
  count: number;
}) {
  const caller = createPeer();
  const callee = createPeer({ mLineReuse: calleeMLineReuse });
  exchangeIceCandidates(caller, callee);
  const videos: RTCRtpTransceiver[] = [];
  for (let i = 0; i < count; i++) {
    videos.push(
      caller.addTransceiver(createTrack("video"), { direction: "sendonly" }),
    );
    await negotiate(caller, callee);
  }
  await waitForConnected(caller, callee);
  return { caller, callee, videos };
}

/**
 * video section の VP8 を、使われていない新しい payload type の非対応 codec (H264) に置き換える。
 * 使用中の payload type の codec を付け替える re-offer は適用前に拒否される (RFC 3264 8.3.2) ため、
 * 非対応 codec は新しい payload type で提案する。
 */
export function offerUnsupportedVideoCodec(sdp: string, payloadType = 125) {
  const [session, ...sections] = sdp.split(/\r\n(?=m=)/);
  return [
    session,
    ...sections.map((section) => {
      const vp8 = section.match(/^a=rtpmap:(\d+) VP8\/90000/m);
      if (!section.startsWith("m=video") || !vp8) {
        return section;
      }
      const pt = vp8[1];
      return section
        .replace(
          /^(m=video \S+ \S+)(.*)$/m,
          (_, head: string, fmts: string) =>
            `${head}${fmts
              .split(" ")
              .map((fmt) => (fmt === pt ? `${payloadType}` : fmt))
              .join(" ")}`,
        )
        .replace(
          `a=rtpmap:${pt} VP8/90000`,
          `a=rtpmap:${payloadType} H264/90000`,
        )
        .replaceAll(`a=rtcp-fb:${pt} `, `a=rtcp-fb:${payloadType} `)
        .replaceAll(`a=fmtp:${pt} `, `a=fmtp:${payloadType} `)
        .replaceAll(`apt=${pt}`, `apt=${payloadType}`);
    }),
  ].join("\r\n");
}

/**
 * SDP の指定 MID の m-line section だけ ICE credentials を差し替え、新しい DTLS association
 * として `a=setup:actpass` を提案する (RFC 8842 5.2: 新しい association の offerer は actpass)
 */
function replaceSectionIceCredentials(
  sdp: string,
  mid: string,
  ufrag: string,
  pwd: string,
) {
  const [session, ...sections] = sdp.split(/\r\n(?=m=)/);
  return [
    session,
    ...sections.map((section) =>
      section.includes(`\r\na=mid:${mid}\r\n`)
        ? section
            .replace(/a=ice-ufrag:.*/, `a=ice-ufrag:${ufrag}`)
            .replace(/a=ice-pwd:.*/, `a=ice-pwd:${pwd}`)
            .replace(/a=setup:.*/, "a=setup:actpass")
        : section,
    ),
  ].join("\r\n");
}

/**
 * werift 同士を BUNDLE (audio 0 / audio 1) で接続した後 (caller が初回 offerer)、
 * `reofferFrom` 側が audio を追加した re-offer を作り、新しい m-line だけを
 * BUNDLE group の外 (別 ICE credentials) にした offer を相手向けに返す。
 * re-offer 側には書き換え前の offer を適用済み (have-local-offer)。
 */
export async function createBundlePairWithOutsideReoffer({
  reofferFrom = "caller",
}: { reofferFrom?: "caller" | "callee" } = {}) {
  const caller = createPeer();
  const callee = createPeer();
  exchangeIceCandidates(caller, callee);
  caller.addTransceiver(createTrack("audio"));
  caller.addTransceiver(createTrack("audio"));
  await negotiate(caller, callee);
  await waitForConnected(caller, callee);

  const reofferer = reofferFrom === "caller" ? caller : callee;
  const added = reofferer.addTransceiver(createTrack("audio"));
  await reofferer.setLocalDescription(await reofferer.createOffer());
  const outsideMid = added.mid!;
  const original = reofferer.localDescription!.sdp;
  const bundleLine = original.match(/a=group:BUNDLE .*/)![0];
  const outsideOffer = replaceSectionIceCredentials(
    original.replace(
      bundleLine,
      bundleLine
        .split(" ")
        .filter((item) => item !== outsideMid)
        .join(" "),
    ),
    outsideMid,
    "outsideufrag",
    "outsidepasswordwithenoughlength",
  );
  return { caller, callee, outsideMid, outsideOffer };
}

/**
 * bundlePolicy: "disable" の werift 同士を接続した後 (caller が初回 offerer)、
 * callee が audio を追加して自分から re-offer する前の状態を作る。
 */
export async function createUnbundledPairForCalleeReoffer() {
  const caller = createPeer({ bundlePolicy: "disable" });
  const callee = createPeer({ bundlePolicy: "disable" });
  exchangeIceCandidates(caller, callee);
  caller.addTransceiver(createTrack("audio"));
  caller.addTransceiver(createTrack("video"));
  await negotiate(caller, callee);
  await waitForConnected(caller, callee);
  return { caller, callee };
}

/**
 * 初回 offer/answer 後の BUNDLE group と transport の対応を検証する (§3.5〜3.7 の範囲に限定)。
 * - answer の同じ BUNDLE group の受け入れ m-line は 1 つの transport を共有し、
 *   別 group・group 外の m-line とは共有しない
 *   (offerer 側で remote の ICE credentials が同じ m-line は共有を保つ #142 の例外を許す)
 * - 各 transport の local ICE ufrag は local SDP のその m-line の値と一致する
 * - 各 transport の remote ICE ufrag は、remote SDP の group で最初に受け入れた member
 *   (group 外ならその m-line) の値と一致する
 * - 各 transport の DTLS role は local answer の a=setup (offerer なら remote answer の逆) と一致する
 */
export function expectTransportsMatchBundle(pc: RTCPeerConnection) {
  const localIsAnswer = pc.localDescription!.type === "answer";
  const local = parseSdp(pc.localDescription!.sdp);
  const remote = parseSdp(pc.remoteDescription!.sdp);
  const answer = localIsAnswer ? local : remote;
  const bundleOf = (sdp: SessionDescription) =>
    sdp.group.filter((g) => g.semantic === "BUNDLE");
  const answerGroups = bundleOf(answer);
  const remoteGroups = bundleOf(remote);

  const accepted = answer.media
    .map((media, index) => ({ media, index, mid: media.rtp.muxId! }))
    .filter(({ media }) => media.port !== 0)
    .map((entry) => {
      const owner =
        entry.media.kind === "application"
          ? pc.sctpTransport
          : pc.getTransceivers().find((t) => t.mid === entry.mid && !t.stopped);
      return { ...entry, transport: owner?.dtlsTransport };
    })
    .filter((entry) => !!entry.transport);
  const groupOf = (groups: typeof answerGroups, mid: string) =>
    groups.find((g) => g.items.includes(mid));
  const remoteUfrag = (index: number) =>
    remote.media[index].iceParams?.usernameFragment;

  for (const a of accepted) {
    const context = `mid=${a.mid}`;
    // 共有関係は answer の BUNDLE group と一致する
    for (const b of accepted) {
      if (a === b) {
        continue;
      }
      const sameGroup =
        !!groupOf(answerGroups, a.mid) &&
        groupOf(answerGroups, a.mid) === groupOf(answerGroups, b.mid);
      const sameRemoteCredentials =
        !localIsAnswer && remoteUfrag(a.index) === remoteUfrag(b.index);
      if (sameGroup) {
        expect(a.transport, `${context} shares with mid=${b.mid}`).toBe(
          b.transport,
        );
      } else if (!sameRemoteCredentials) {
        expect(
          a.transport,
          `${context} is separate from mid=${b.mid}`,
        ).not.toBe(b.transport);
      }
    }
    const connection = a.transport!.iceTransport.connection;
    // local ICE ufrag は local SDP の値と一致する
    expect(connection.localUsername, `${context} local ufrag`).toBe(
      local.media[a.index].iceParams?.usernameFragment,
    );
    // remote ICE ufrag は group で最初に受け入れた member (group 外なら自身) の値
    const remoteGroup = groupOf(remoteGroups, a.mid);
    const source =
      remoteGroup?.items
        .map((mid) => accepted.find((e) => e.mid === mid))
        .find((e) => !!e) ?? a;
    expect(connection.remoteUsername, `${context} remote ufrag`).toBe(
      remoteUfrag(source.index),
    );
    // DTLS role は a=setup と一致する
    const answerRole = answer.media[a.index].dtlsParams?.role;
    const expectedRole = localIsAnswer
      ? answerRole
      : answerRole === "client"
        ? "server"
        : "client";
    expect(a.transport!.role, `${context} DTLS role`).toBe(expectedRole);
  }
}
