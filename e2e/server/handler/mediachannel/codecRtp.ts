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

import { MediaStreamTrack, RTCPeerConnection } from "../../";
import {
  type CodecRtpName,
  type DepacketizeStats,
  attachDepacketizer,
  codecKind,
  codecMimeHint,
  createRtpPacketizer,
  streamPacketizedFixture,
  useCodecParameters,
  waitForTrackCodec,
} from "../../codecRtpUtils";
import { DtlsKeysContext } from "../../fixture";

type HandlerState = {
  pc?: RTCPeerConnection;
  stoppers: Array<() => void>;
  abort?: AbortController;
  streamPromise?: Promise<unknown>;
  result?: Record<string, unknown>;
  stats?: DepacketizeStats & { rtpPackets?: number };
  depacketizeDone?: boolean;
};

function peerCodecs(codec: CodecRtpName) {
  const params = useCodecParameters(codec);
  // Keep both kinds present so PeerConfig stays well-formed
  if (codecKind(codec) === "audio") {
    return { audio: [params], video: [] as never[] };
  }
  return { video: [params], audio: [] as never[] };
}

async function createPc(codec: CodecRtpName) {
  return new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    dtls: { keys: await DtlsKeysContext.get() },
    codecs: peerCodecs(codec),
    // Match other mediachannel handlers for interop stability
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
) {
  return {
    ok: isDepacketizeSuccess(stats, codec),
    scenario: "depacketize" as const,
    codec,
    negotiatedMime:
      (sdpMentionsCodec(pc?.remoteDescription?.sdp, codec) ||
        sdpMentionsCodec(pc?.localDescription?.sdp, codec)) &&
      useCodecParameters(codec).mimeType,
    frameCount: stats.frameCount,
    keyframeCount: stats.keyframeCount,
    totalBytes: stats.totalBytes,
    rtpPackets: stats.rtpPackets ?? 0,
    usedPackagesRtp: true as const,
  };
}

/** Scenario A: Chrome → Node depacketize */
class DepacketizeHandler {
  private state: HandlerState = { stoppers: [] };
  constructor(private readonly codec: CodecRtpName) {}

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        this.state = { stoppers: [], depacketizeDone: false };
        const pc = await createPc(this.codec);
        this.state.pc = pc;
        const kind = codecKind(this.codec);

        // recvonly offer — Chrome answers with media (same pattern as oneway)
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
          this.state.stats = { ...stats, rtpPackets: 0 };
          // Keep stats object identity in sync by patching shared ref
          const shared = stats as DepacketizeStats & { rtpPackets?: number };
          shared.rtpPackets = 0;
          this.state.stats = shared;
          this.state.stoppers.push(stop);

          // Mirror PLI on first RTP for faster keyframe
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
        accept({});
        break;
      }
      case "status": {
        // Short poll — avoid protoo ~22s request timeout on long awaits
        const stats = this.state.stats;
        if (stats && isDepacketizeSuccess(stats, this.codec)) {
          const result = buildDepacketizeResult(
            this.codec,
            stats,
            this.state.pc,
          );
          this.state.result = result;
          this.state.depacketizeDone = true;
          accept(result);
        } else {
          accept({
            ok: false,
            frameCount: stats?.frameCount ?? 0,
            keyframeCount: stats?.keyframeCount ?? 0,
            rtpPackets: stats?.rtpPackets ?? 0,
            totalBytes: stats?.totalBytes ?? 0,
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

/** Scenario B: fixture → packages/rtp Packetizer → Chrome */
class PacketizeHandler {
  private state: HandlerState = { stoppers: [] };
  constructor(private readonly codec: CodecRtpName) {}

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        this.state = { stoppers: [] };
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
        accept({
          framesSent: this.state.result?.framesSent ?? 0,
          packetsSent: this.state.result?.packetsSent ?? 0,
          multiPacketFrames: this.state.result?.multiPacketFrames ?? 0,
          usedPackagesRtp: true,
          codec: this.codec,
        });
        break;
      }
      case "done": {
        await this.cleanup();
        accept(this.state.result ?? { usedPackagesRtp: true });
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

      let multiPacketFrames = 0;
      this.state.streamPromise = streamPacketizedFixture({
        codec: this.codec,
        track,
        signal: abort.signal,
        loop: true,
        onFrameSent: ({ packetCount }) => {
          if (packetCount > 1) multiPacketFrames++;
        },
      }).then((stats) => {
        this.state.result = {
          ...stats,
          multiPacketFrames,
          usedPackagesRtp: true,
          codec: this.codec,
          packetizer: `packages/rtp:${this.codec}`,
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
        this.state = { stoppers: [], depacketizeDone: false };
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
        if (stats && isDepacketizeSuccess(stats, this.codec)) {
          const result = {
            ok: true,
            scenario: "repacketize" as const,
            codec: this.codec,
            frameCount: stats.frameCount,
            keyframeCount: stats.keyframeCount,
            totalBytes: stats.totalBytes,
            rtpPackets: stats.rtpPackets ?? 0,
            usedPackagesRtp: true as const,
          };
          this.state.result = result;
          accept(result);
        } else {
          accept({
            ok: false,
            frameCount: stats?.frameCount ?? 0,
            keyframeCount: stats?.keyframeCount ?? 0,
            rtpPackets: stats?.rtpPackets ?? 0,
            totalBytes: stats?.totalBytes ?? 0,
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
