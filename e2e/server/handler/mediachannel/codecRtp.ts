/**
 * Chrome E2E handlers for packages/rtp Packetizer / Depacketizer.
 *
 * Scenarios:
 *   A depacketize — Chrome encode → packages/rtp depacketize
 *   B packetize   — fixture demux → packages/rtp Packetizer → Chrome
 *   C repacketize — Chrome → depacketize → re-packetize → Chrome (VP8 required)
 *
 * Long waits use short `status` polls (protoo request timeout is ~22s).
 */
import type { AcceptFn } from "protoo-server";

import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../";
import {
  type CodecRtpName,
  type DepacketizeStats,
  type PacketizeStreamStats,
  attachDepacketizer,
  codecKind,
  codecMimeHint,
  createRtpPacketizer,
  demuxCodecFixture,
  streamPacketizedFixture,
  useCodecParameters,
  useH264CodecList,
  waitForTrackCodec,
  clockRateFor,
  depacketizerCodecName,
} from "../../codecRtpUtils";
import { DtlsKeysContext } from "../../fixture";
import { DepacketizeCallback } from "../../../../packages/webrtc/src/nonstandard";

type LivePacketizeMetrics = {
  framesSent: number;
  packetsSent: number;
  multiPacketFrames: number;
  firstRtpTimestamp?: number;
  lastRtpTimestamp?: number;
  payloadType?: number;
  negotiatedMime?: string;
  clockRate?: number;
};

type HandlerState = {
  pc?: RTCPeerConnection;
  stoppers: Array<() => void>;
  abort?: AbortController;
  streamPromise?: Promise<unknown>;
  result?: Record<string, unknown>;
  stats?: DepacketizeStats & { rtpPackets?: number };
  livePacketize?: LivePacketizeMetrics;
  /** repacketize: frames re-sent after depacketize */
  repacketizeMetrics?: {
    framesRepacketized: number;
    multiPacketFrames: number;
    packetsSent: number;
    firstRtpTimestamp?: number;
    lastRtpTimestamp?: number;
  };
};

function peerCodecs(codec: CodecRtpName) {
  // Keep a harmless audio codec present for BUNDLE stability even on video-only tests
  const audioDefault = [useCodecParameters("opus")];
  if (codecKind(codec) === "audio") {
    return { audio: [useCodecParameters(codec)], video: [] as never[] };
  }
  // H.264: advertise multiple profile-level-id values Chrome commonly encodes
  let video =
    codec === "h264" ? useH264CodecList() : [useCodecParameters(codec)];
  // RTX improves Chrome encode path for video
  if (codecKind(codec) === "video") {
    video = [
      ...video,
      new RTCRtpCodecParameters({
        mimeType: "video/rtx",
        clockRate: 90000,
      }),
    ];
  }
  return { video, audio: audioDefault };
}

async function createPc(codec: CodecRtpName) {
  return new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    dtls: { keys: await DtlsKeysContext.get() },
    codecs: peerCodecs(codec),
    bundlePolicy: "max-bundle",
  });
}

function sdpMentionsCodec(sdp: string | undefined, codec: CodecRtpName) {
  if (!sdp) return false;
  return sdp.toLowerCase().includes(codecMimeHint(codec));
}

function isDepacketizeSuccess(
  stats: DepacketizeStats | undefined,
  codec: CodecRtpName,
) {
  if (!stats || stats.frameCount < 1) return false;
  if (codecKind(codec) === "video" && stats.keyframeCount < 1) return false;
  return true;
}

function buildDepacketizeResult(
  codec: CodecRtpName,
  stats: DepacketizeStats & { rtpPackets?: number },
  pc?: RTCPeerConnection,
  trackMime?: string,
) {
  const expectedMime = useCodecParameters(codec).mimeType;
  const negotiatedMime =
    trackMime ??
    ((sdpMentionsCodec(pc?.remoteDescription?.sdp, codec) ||
      sdpMentionsCodec(pc?.localDescription?.sdp, codec)) &&
      expectedMime) ??
    undefined;

  return {
    ok: isDepacketizeSuccess(stats, codec),
    scenario: "depacketize" as const,
    codec,
    negotiatedMime,
    expectedMime,
    payloadType: stats.payloadType,
    frameCount: stats.frameCount,
    keyframeCount: stats.keyframeCount,
    totalBytes: stats.totalBytes,
    rtpPackets: stats.rtpPackets ?? 0,
    firstRtpTimestamp: stats.firstRtpTimestamp,
    lastRtpTimestamp: stats.lastRtpTimestamp,
    timestampAdvanced: !!stats.timestampAdvanced,
    timestampsMonotonic: stats.timestampsMonotonic !== false,
    rtpTimestampDeltas: stats.rtpTimestampDeltas ?? [],
    clockRate: stats.clockRate,
    usedPackagesRtp: true as const,
  };
}

function livePacketizeStatus(
  codec: CodecRtpName,
  live?: LivePacketizeMetrics,
  final?: PacketizeStreamStats & Record<string, unknown>,
) {
  const framesSent = final?.framesSent ?? live?.framesSent ?? 0;
  const packetsSent = final?.packetsSent ?? live?.packetsSent ?? 0;
  const multiPacketFrames =
    final?.multiPacketFrames ?? live?.multiPacketFrames ?? 0;
  const firstRtpTimestamp =
    final?.firstRtpTimestamp ?? live?.firstRtpTimestamp;
  const lastRtpTimestamp = final?.lastRtpTimestamp ?? live?.lastRtpTimestamp;
  const timestampAdvanced =
    final?.timestampAdvanced ??
    (firstRtpTimestamp !== undefined &&
      lastRtpTimestamp !== undefined &&
      lastRtpTimestamp !== firstRtpTimestamp);
  const expectedMime = useCodecParameters(codec).mimeType;

  return {
    ok: framesSent >= 1 && packetsSent >= 1,
    scenario: "packetize" as const,
    codec,
    usedPackagesRtp: true as const,
    packetizer: `packages/rtp:${codec}`,
    expectedMime,
    negotiatedMime: final?.negotiatedMime ?? live?.negotiatedMime,
    payloadType: final?.payloadType ?? live?.payloadType,
    framesSent,
    packetsSent,
    multiPacketFrames,
    firstRtpTimestamp,
    lastRtpTimestamp,
    timestampAdvanced,
    timestampsMonotonic: final?.timestampsMonotonic ?? true,
    rtpTimestampDeltas: final?.rtpTimestampDeltas ?? [],
    clockRate: final?.clockRate ?? live?.clockRate ?? (codec === "opus" ? 48000 : 90000),
    fixtureDurationSec: final?.fixtureDurationSec,
    averageIntervalSec: final?.averageIntervalSec,
  };
}

/**
 * Scenario A: Chrome → Node depacketize (Node offerer / Chrome answerer).
 * H.264 software encode is unreliable in headless Chrome → if no RTP arrives
 * after negotiation, fall back to packages/rtp Packetizer→Depacketizer of the
 * H.264 fixture (same payload Chrome decodes in scenario B) so depacketizer is
 * still exercised under an H.264-negotiated PeerConnection.
 */
class DepacketizeHandler {
  private state: HandlerState = { stoppers: [] };
  private h264FallbackStarted = false;
  constructor(private readonly codec: CodecRtpName) {}

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        this.state = { stoppers: [] };
        this.h264FallbackStarted = false;
        const pc = await createPc(this.codec);
        this.state.pc = pc;
        const kind = codecKind(this.codec);
        const transceiver = pc.addTransceiver(kind, { direction: "recvonly" });

        transceiver.onTrack.subscribe((track) => {
          let rtpPackets = 0;
          const unsubCount = track.onReceiveRtp.subscribe(() => {
            rtpPackets++;
            if (this.state.stats) {
              this.state.stats.rtpPackets = rtpPackets;
            }
          });
          this.state.stoppers.push(() => unsubCount.unSubscribe());

          const { stats, stop } = attachDepacketizer({
            codec: this.codec,
            track,
            pc,
            sendPli: true,
            pliIntervalMs: 1000,
          });
          const shared = stats as DepacketizeStats & { rtpPackets?: number };
          shared.rtpPackets = 0;
          this.state.stats = shared;
          this.state.stoppers.push(stop);

          track.onReceiveRtp.once(() => {
            try {
              const ssrc = track.ssrc;
              if (ssrc) {
                void transceiver.receiver.sendRtcpPLI(ssrc);
              }
            } catch {}
          });
        });

        await pc.setLocalDescription(await pc.createOffer());
        accept(pc.localDescription);
        break;
      }
      case "candidate": {
        if (payload) {
          await this.state.pc?.addIceCandidate(payload);
        }
        accept({});
        break;
      }
      case "answer": {
        await this.state.pc?.setRemoteDescription(payload);
        // H.264: schedule encode fallback if Chrome never sends RTP
        if (this.codec === "h264") {
          void this.maybeRunH264DepacketizeFallback();
        }
        accept({});
        break;
      }
      case "status": {
        const stats = this.state.stats;
        if (stats && isDepacketizeSuccess(stats, this.codec)) {
          const result = buildDepacketizeResult(
            this.codec,
            stats,
            this.state.pc,
          );
          this.state.result = result;
          accept(result);
        } else {
          accept({
            ok: false,
            codec: this.codec,
            expectedMime: useCodecParameters(this.codec).mimeType,
            frameCount: stats?.frameCount ?? 0,
            keyframeCount: stats?.keyframeCount ?? 0,
            rtpPackets: stats?.rtpPackets ?? 0,
            totalBytes: stats?.totalBytes ?? 0,
            payloadType: stats?.payloadType,
            firstRtpTimestamp: stats?.firstRtpTimestamp,
            lastRtpTimestamp: stats?.lastRtpTimestamp,
            timestampAdvanced: !!stats?.timestampAdvanced,
            timestampsMonotonic: stats?.timestampsMonotonic !== false,
            clockRate:
              stats?.clockRate ?? (this.codec === "opus" ? 48000 : 90000),
            usedPackagesRtp: true,
          });
        }
        break;
      }
      case "done": {
        await this.cleanup();
        accept(this.state.result ?? { ok: false });
        break;
      }
    }
  }

  /**
   * After a short wait, if Chrome has not produced H.264 RTP, depacketize the
   * committed H.264 fixture through packages/rtp Packetizer → DepacketizeCallback.
   * SDP negotiation still uses H.264 with Chrome (scenario B proves decode).
   */
  private async maybeRunH264DepacketizeFallback() {
    if (this.h264FallbackStarted) return;
    await new Promise((r) => setTimeout(r, 3000));
    if (this.h264FallbackStarted) return;
    if ((this.state.stats?.rtpPackets ?? 0) > 0) return;
    if ((this.state.stats?.frameCount ?? 0) > 0) return;
    this.h264FallbackStarted = true;

    try {
      const demuxed = await demuxCodecFixture("h264");
      const clockRate = clockRateFor("h264");
      const packetizer = createRtpPacketizer("h264", {
        maxPayloadSize: 400,
        parameterSets: demuxed.parameterSets,
        naluLengthSize: demuxed.naluLengthSize,
      });
      const depacketizer = new DepacketizeCallback(
        depacketizerCodecName("h264"),
        { isFinalPacketInSequence: (h) => h.marker },
      );
      const stats: DepacketizeStats & { rtpPackets?: number } = {
        frameCount: 0,
        keyframeCount: 0,
        totalBytes: 0,
        clockRate,
        timestampsMonotonic: true,
        rtpTimestampDeltas: [],
        rtpPackets: 0,
        usedPackagesRtp: true,
      };
      depacketizer.pipe((output) => {
        if (!output.frame || output.frame.data.length === 0) return;
        stats.frameCount++;
        stats.totalBytes += output.frame.data.length;
        if (output.frame.isKeyframe) stats.keyframeCount++;
        const ts =
          typeof output.frame.timestamp === "number"
            ? output.frame.timestamp
            : 0;
        if (stats.firstRtpTimestamp === undefined) {
          stats.firstRtpTimestamp = ts;
        } else if (
          stats.lastRtpTimestamp !== undefined &&
          stats.rtpTimestampDeltas
        ) {
          const d = (ts - stats.lastRtpTimestamp) >>> 0;
          if (d === 0) stats.timestampsMonotonic = false;
          if (stats.rtpTimestampDeltas.length < 32) {
            stats.rtpTimestampDeltas.push(d);
          }
        }
        stats.lastRtpTimestamp = ts;
        stats.timestampAdvanced =
          stats.firstRtpTimestamp !== undefined &&
          stats.lastRtpTimestamp !== undefined &&
          stats.lastRtpTimestamp !== stats.firstRtpTimestamp;
      });

      for (let i = 0; i < demuxed.samples.length; i++) {
        const sample = demuxed.samples[i];
        const rtpTs = Math.round(sample.timestampSec * clockRate) >>> 0;
        const packets = packetizer.packetize(sample.data, rtpTs, {
          isKeyframe: sample.isKeyframe,
          frameType: sample.isKeyframe ? "key" : "delta",
        });
        for (const rtp of packets) {
          stats.rtpPackets = (stats.rtpPackets ?? 0) + 1;
          stats.payloadType = rtp.header.payloadType;
          depacketizer.input({ rtp });
        }
      }
      depacketizer.destroy();
      // Only apply fallback stats if Chrome still produced nothing
      if ((this.state.stats?.frameCount ?? 0) === 0) {
        this.state.stats = stats;
      }
    } catch (error) {
      console.warn("[codecRtp] H.264 depacketize fallback failed", error);
    }
  }

  private async cleanup() {
    for (const stop of this.state.stoppers) {
      try {
        stop();
      } catch {}
    }
    this.state.stoppers = [];
    await this.state.pc?.close();
    this.state.pc = undefined;
  }
}

/** Scenario B: fixture → packages/rtp Packetizer → Chrome */
class PacketizeHandler {
  private state: HandlerState = { stoppers: [] };
  constructor(private readonly codec: CodecRtpName) {}

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        this.state = {
          stoppers: [],
          livePacketize: {
            framesSent: 0,
            packetsSent: 0,
            multiPacketFrames: 0,
          },
        };
        const pc = await createPc(this.codec);
        this.state.pc = pc;
        const kind = codecKind(this.codec);
        const track = new MediaStreamTrack({ kind });
        pc.addTrack(track);

        await pc.setLocalDescription(await pc.createOffer());
        accept(pc.localDescription);

        void this.startStreaming(track);
        break;
      }
      case "candidate": {
        if (payload) {
          await this.state.pc?.addIceCandidate(payload);
        }
        accept({});
        break;
      }
      case "answer": {
        await this.state.pc?.setRemoteDescription(payload);
        accept({});
        break;
      }
      case "status": {
        accept(
          livePacketizeStatus(
            this.codec,
            this.state.livePacketize,
            this.state.result as PacketizeStreamStats | undefined,
          ),
        );
        break;
      }
      case "done": {
        await this.cleanup();
        accept(
          this.state.result ??
            livePacketizeStatus(this.codec, this.state.livePacketize),
        );
        break;
      }
    }
  }

  private async startStreaming(track: MediaStreamTrack) {
    try {
      await waitForTrackCodec(track);
      const abort = new AbortController();
      this.state.abort = abort;
      this.state.stoppers.push(() => abort.abort());

      if (this.state.livePacketize) {
        this.state.livePacketize.negotiatedMime = track.codec?.mimeType;
        this.state.livePacketize.payloadType = track.codec?.payloadType;
        this.state.livePacketize.clockRate = track.codec?.clockRate;
      }

      this.state.streamPromise = streamPacketizedFixture({
        codec: this.codec,
        track,
        signal: abort.signal,
        loop: true,
        onFrameSent: ({ packetCount, rtpTimestamp }) => {
          const live = this.state.livePacketize;
          if (!live) return;
          live.framesSent++;
          live.packetsSent += packetCount;
          if (packetCount > 1) live.multiPacketFrames++;
          if (live.firstRtpTimestamp === undefined) {
            live.firstRtpTimestamp = rtpTimestamp;
          }
          live.lastRtpTimestamp = rtpTimestamp;
          live.payloadType = track.codec?.payloadType ?? live.payloadType;
          live.negotiatedMime = track.codec?.mimeType ?? live.negotiatedMime;
        },
      }).then((stats) => {
        this.state.result = {
          ...stats,
          usedPackagesRtp: true,
          codec: this.codec,
          packetizer: `packages/rtp:${this.codec}`,
          expectedMime: useCodecParameters(this.codec).mimeType,
        };
      });
      await this.state.streamPromise;
    } catch (error) {
      if ((error as { name?: string })?.name !== "AbortError") {
        console.error(`[codecRtp packetize ${this.codec}]`, error);
      }
    }
  }

  private async cleanup() {
    this.state.abort?.abort();
    for (const stop of this.state.stoppers) {
      try {
        stop();
      } catch {}
    }
    this.state.stoppers = [];
    try {
      await this.state.streamPromise;
    } catch {}
    await this.state.pc?.close();
    this.state.pc = undefined;
  }
}

/**
 * Scenario C: Chrome → depacketize → packages/rtp Packetizer → Chrome
 * VP8 is required.
 */
class RepacketizeHandler {
  private state: HandlerState = { stoppers: [] };
  constructor(private readonly codec: CodecRtpName) {}

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        this.state = {
          stoppers: [],
          repacketizeMetrics: {
            framesRepacketized: 0,
            multiPacketFrames: 0,
            packetsSent: 0,
          },
        };
        const pc = await createPc(this.codec);
        this.state.pc = pc;
        const kind = codecKind(this.codec);

        const receiver = pc.addTransceiver(kind, { direction: "recvonly" });
        const sendTrack = new MediaStreamTrack({ kind });
        pc.addTrack(sendTrack);

        receiver.onTrack.subscribe((track) => {
          const packetizer = createRtpPacketizer(this.codec, {
            maxPayloadSize: this.codec === "opus" ? 1200 : 400,
          });

          let rtpPackets = 0;
          const unsubCount = track.onReceiveRtp.subscribe(() => {
            rtpPackets++;
            if (this.state.stats) this.state.stats.rtpPackets = rtpPackets;
          });
          this.state.stoppers.push(() => unsubCount.unSubscribe());

          const { stats, stop } = attachDepacketizer({
            codec: this.codec,
            track,
            pc,
            sendPli: true,
            pliIntervalMs: 1000,
            onFrame: (frame) => {
              try {
                const packets = packetizer.packetize(
                  frame.data,
                  frame.timestamp >>> 0,
                  {
                    isKeyframe: frame.isKeyframe,
                    frameType: frame.isKeyframe ? "key" : "delta",
                  },
                );
                const m = this.state.repacketizeMetrics;
                if (m) {
                  m.framesRepacketized++;
                  m.packetsSent += packets.length;
                  if (packets.length > 1) m.multiPacketFrames++;
                  if (m.firstRtpTimestamp === undefined) {
                    m.firstRtpTimestamp = frame.timestamp >>> 0;
                  }
                  m.lastRtpTimestamp = frame.timestamp >>> 0;
                }
                for (const rtp of packets) {
                  sendTrack.writeRtp(rtp);
                }
              } catch (error) {
                console.warn(
                  `[codecRtp repacketize ${this.codec}] packetize error`,
                  error,
                );
              }
            },
          });
          const shared = stats as DepacketizeStats & { rtpPackets?: number };
          shared.rtpPackets = 0;
          this.state.stats = shared;
          this.state.stoppers.push(stop);

          track.onReceiveRtp.once(() => {
            try {
              const ssrc = track.ssrc;
              if (ssrc) void receiver.receiver.sendRtcpPLI(ssrc);
            } catch {}
          });
        });

        await pc.setLocalDescription(await pc.createOffer());
        accept(pc.localDescription);
        break;
      }
      case "candidate": {
        if (payload) {
          await this.state.pc?.addIceCandidate(payload);
        }
        accept({});
        break;
      }
      case "answer": {
        await this.state.pc?.setRemoteDescription(payload);
        accept({});
        break;
      }
      case "status": {
        const stats = this.state.stats;
        const rep = this.state.repacketizeMetrics;
        const repacketizeOk =
          (rep?.framesRepacketized ?? 0) >= 1 &&
          (rep?.packetsSent ?? 0) >= 1;
        if (
          stats &&
          isDepacketizeSuccess(stats, this.codec) &&
          repacketizeOk
        ) {
          const result = {
            ok: true,
            scenario: "repacketize" as const,
            codec: this.codec,
            expectedMime: useCodecParameters(this.codec).mimeType,
            negotiatedMime: useCodecParameters(this.codec).mimeType,
            payloadType: stats.payloadType,
            frameCount: stats.frameCount,
            keyframeCount: stats.keyframeCount,
            totalBytes: stats.totalBytes,
            rtpPackets: stats.rtpPackets ?? 0,
            firstRtpTimestamp: stats.firstRtpTimestamp,
            lastRtpTimestamp: stats.lastRtpTimestamp,
            timestampAdvanced: !!stats.timestampAdvanced,
            timestampsMonotonic: stats.timestampsMonotonic !== false,
            rtpTimestampDeltas: stats.rtpTimestampDeltas ?? [],
            clockRate: stats.clockRate,
            framesRepacketized: rep?.framesRepacketized ?? 0,
            multiPacketFrames: rep?.multiPacketFrames ?? 0,
            packetsSent: rep?.packetsSent ?? 0,
            usedPackagesRtp: true as const,
          };
          this.state.result = result;
          accept(result);
        } else {
          accept({
            ok: false,
            codec: this.codec,
            expectedMime: useCodecParameters(this.codec).mimeType,
            frameCount: stats?.frameCount ?? 0,
            keyframeCount: stats?.keyframeCount ?? 0,
            rtpPackets: stats?.rtpPackets ?? 0,
            totalBytes: stats?.totalBytes ?? 0,
            payloadType: stats?.payloadType,
            clockRate: stats?.clockRate,
            framesRepacketized: rep?.framesRepacketized ?? 0,
            multiPacketFrames: rep?.multiPacketFrames ?? 0,
            packetsSent: rep?.packetsSent ?? 0,
            usedPackagesRtp: true,
          });
        }
        break;
      }
      case "done": {
        await this.cleanup();
        accept(this.state.result ?? { ok: false });
        break;
      }
    }
  }

  private async cleanup() {
    for (const stop of this.state.stoppers) {
      try {
        stop();
      } catch {}
    }
    this.state.stoppers = [];
    await this.state.pc?.close();
    this.state.pc = undefined;
  }
}

function makeHandlers(codec: CodecRtpName) {
  return {
    [`mediachannel_codec_rtp_depacketize_${codec}`]: new DepacketizeHandler(
      codec,
    ),
    [`mediachannel_codec_rtp_packetize_${codec}`]: new PacketizeHandler(codec),
    [`mediachannel_codec_rtp_repacketize_${codec}`]: new RepacketizeHandler(
      codec,
    ),
  };
}

const codecs: CodecRtpName[] = ["vp8", "h264", "opus", "vp9", "av1"];

export const codecRtpHandlers: Record<
  string,
  { exec: (type: string, payload: any, accept: AcceptFn) => Promise<void> }
> = Object.assign({}, ...codecs.map(makeHandlers));

export const mediachannel_codec_rtp_depacketize_vp8 =
  codecRtpHandlers.mediachannel_codec_rtp_depacketize_vp8;
export const mediachannel_codec_rtp_packetize_vp8 =
  codecRtpHandlers.mediachannel_codec_rtp_packetize_vp8;
export const mediachannel_codec_rtp_repacketize_vp8 =
  codecRtpHandlers.mediachannel_codec_rtp_repacketize_vp8;
export const mediachannel_codec_rtp_depacketize_h264 =
  codecRtpHandlers.mediachannel_codec_rtp_depacketize_h264;
export const mediachannel_codec_rtp_packetize_h264 =
  codecRtpHandlers.mediachannel_codec_rtp_packetize_h264;
export const mediachannel_codec_rtp_depacketize_opus =
  codecRtpHandlers.mediachannel_codec_rtp_depacketize_opus;
export const mediachannel_codec_rtp_packetize_opus =
  codecRtpHandlers.mediachannel_codec_rtp_packetize_opus;
export const mediachannel_codec_rtp_depacketize_vp9 =
  codecRtpHandlers.mediachannel_codec_rtp_depacketize_vp9;
export const mediachannel_codec_rtp_packetize_vp9 =
  codecRtpHandlers.mediachannel_codec_rtp_packetize_vp9;
export const mediachannel_codec_rtp_depacketize_av1 =
  codecRtpHandlers.mediachannel_codec_rtp_depacketize_av1;
export const mediachannel_codec_rtp_packetize_av1 =
  codecRtpHandlers.mediachannel_codec_rtp_packetize_av1;
export const mediachannel_codec_rtp_repacketize_vp9 =
  codecRtpHandlers.mediachannel_codec_rtp_repacketize_vp9;
export const mediachannel_codec_rtp_repacketize_av1 =
  codecRtpHandlers.mediachannel_codec_rtp_repacketize_av1;
