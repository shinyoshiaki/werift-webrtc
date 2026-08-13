import type { IceConnection } from "../../../ice/src";
import {
  GccBandwidthEstimator,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpSender,
  RtpHeader,
  RtpPacket,
  useAbsSendTime,
  useNACK,
  usePLI,
  useREMB,
  useTWCC,
  useTransportWideCC,
} from "../../src";
import { BottleneckLink } from "./bottleneckLink";

export type TwccPeerPair = {
  senderPc: RTCPeerConnection;
  receiverPc: RTCPeerConnection;
  track: MediaStreamTrack;
  sender: RTCRtpSender;
  gcc: GccBandwidthEstimator;
  link: BottleneckLink;
  bitrateSamples: number[];
  close: () => Promise<void>;
};

function videoCodecWithTwcc() {
  return new RTCRtpCodecParameters({
    mimeType: "video/VP8",
    clockRate: 90000,
    rtcpFeedback: [useNACK(), usePLI(), useREMB(), useTWCC()],
  });
}

function peerConfig() {
  return {
    iceServers: [] as { urls: string }[],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: {
      video: [videoCodecWithTwcc()],
    },
    headerExtensions: {
      video: [useTransportWideCC(), useAbsSendTime()],
    },
  };
}

function iceConnectionOf(pc: RTCPeerConnection): IceConnection {
  const iceTransports = pc.iceTransports;
  if (iceTransports.length > 0) {
    return iceTransports[0].connection;
  }
  const transceiver = pc.getTransceivers()[0];
  const ice = transceiver?.dtlsTransport?.iceTransport?.connection;
  if (!ice) {
    throw new Error("ICE connection not available on peer");
  }
  return ice;
}

/**
 * TWCC + GCC を有効にした sendonly / recvonly peer 対を接続し、
 * 両者の ICE send を仮想ボトルネックに通す。
 */
export async function createGccTwccPeerPair(opts?: {
  capacityBps?: number;
  baseDelayMs?: number;
  maxQueueBytes?: number;
  startBitrateBps?: number;
  periodicAlrProbing?: boolean;
}): Promise<TwccPeerPair> {
  const startBitrateBps = opts?.startBitrateBps ?? 600_000;
  const link = new BottleneckLink({
    capacityBps: opts?.capacityBps ?? 250_000,
    baseDelayMs: opts?.baseDelayMs ?? 40,
    maxQueueBytes: opts?.maxQueueBytes ?? 32_000,
  });

  const senderPc = new RTCPeerConnection(peerConfig());
  const receiverPc = new RTCPeerConnection(peerConfig());

  const track = new MediaStreamTrack({ kind: "video" });
  const senderTransceiver = senderPc.addTransceiver(track, {
    direction: "sendonly",
  });
  receiverPc.addTransceiver("video", { direction: "recvonly" });

  const gcc = new GccBandwidthEstimator(startBitrateBps, {
    periodicAlrProbing: opts?.periodicAlrProbing === true,
  });
  const sender = senderTransceiver.sender;
  sender.setBandwidthEstimator(gcc);

  const bitrateSamples: number[] = [];
  sender.onAvailableBitrate.subscribe((bps) => {
    bitrateSamples.push(bps);
  });

  await senderPc.setLocalDescription(await senderPc.createOffer());
  await receiverPc.setRemoteDescription(senderPc.localDescription!);
  await receiverPc.setLocalDescription(await receiverPc.createAnswer());
  await senderPc.setRemoteDescription(receiverPc.localDescription!);

  // ICE/DTLS 接続待ち
  await Promise.all([
    senderPc.connectionStateChange.watch((s) => s === "connected"),
    receiverPc.connectionStateChange.watch((s) => s === "connected"),
  ]);

  // ボトルネックを双方の ICE 送信に取り付け（メディア a→b、TWCC feedback b→a）
  const senderIce = iceConnectionOf(senderPc);
  const receiverIce = iceConnectionOf(receiverPc);
  link.install(senderIce, "a2b");
  link.install(receiverIce, "b2a");

  return {
    senderPc,
    receiverPc,
    track,
    sender,
    gcc,
    link,
    bitrateSamples,
    close: async () => {
      link.close();
      await Promise.all([senderPc.close(), receiverPc.close()]);
    },
  };
}

/**
 * 指定ビットレートで合成 RTP を送信するループ。
 * `getTargetBps` が毎ティック呼ばれ、動的にレートを変えられる。
 */
export function startMediaSource(
  track: MediaStreamTrack,
  getTargetBps: () => number,
  opts?: { payloadBytes?: number; clockRate?: number },
): { stop: () => void; stats: () => { packets: number; bytes: number } } {
  const payloadBytes = opts?.payloadBytes ?? 900;
  const clockRate = opts?.clockRate ?? 90000;
  let seq = 0;
  let timestamp = 0;
  let packets = 0;
  let bytes = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    if (stopped) return;
    const targetBps = Math.max(0, getTargetBps());
    // 1 パケットあたりの目標間隔
    const bits = payloadBytes * 8;
    const intervalMs =
      targetBps <= 0 ? 100 : Math.max(5, Math.round((bits * 1000) / targetBps));

    const rtp = new RtpPacket(
      new RtpHeader({
        sequenceNumber: seq & 0xffff,
        timestamp: timestamp >>> 0,
        payloadType: 96,
        marker: false,
        extension: true,
        extensions: [],
        payloadOffset: 12,
      }),
      Buffer.alloc(payloadBytes, 0x5a),
    );
    track.writeRtp(rtp);
    seq++;
    // 約 30fps 相当のタイムスタンプ進行（レートとは独立）
    timestamp = (timestamp + Math.round(clockRate / 30)) >>> 0;
    packets++;
    bytes += payloadBytes + 12;

    timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, 10);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    stats: () => ({ packets, bytes }),
  };
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}
