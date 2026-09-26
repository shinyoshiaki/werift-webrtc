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
 * `bundle` を省略すると BUNDLE group を付けない (unbundled)。
 */
export function buildRemoteSdp({
  sections,
  bundle,
  setup = "actpass",
}: {
  sections: RemoteSection[];
  bundle?: string[];
  setup?: "actpass" | "active" | "passive";
}) {
  const lines = ["v=0", "o=- 4611731400430051336 2 IN IP4 127.0.0.1", "s=-"];
  lines.push("t=0 0");
  if (bundle) {
    lines.push(`a=group:BUNDLE ${bundle.join(" ")}`);
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
