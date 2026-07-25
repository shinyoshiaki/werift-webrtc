import type { AcceptFn } from "protoo-server";
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
} from "..";
import { DtlsKeysContext } from "../fixture";
import { BottleneckLink, type BottleneckStats } from "./bottleneckLink";

/**
 * werift (sender) ↔ Chrome (recvonly) の GCC/TWCC 帯域シミュレーション用ハンドラ。
 * ネットワーク制限は **werift 側 ICE send** に BottleneckLink を付けて再現する。
 *
 * CI 通常 e2e (`./tests`) からは呼ばれない。`e2e/simulations/` 専用。
 */
export class sim_gcc_twcc_chrome {
  pc!: RTCPeerConnection;
  track!: MediaStreamTrack;
  sender!: RTCRtpSender;
  gcc!: GccBandwidthEstimator;
  link?: BottleneckLink;
  bitrateSamples: number[] = [];
  private mediaStop?: () => void;
  private targetBps = 0;
  private adaptMode = false;
  private capacityBps = 200_000;
  private dropsAtCongestionEnd = 0;

  private async peerConfig() {
    return {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      iceUseIpv4: true,
      iceUseIpv6: false,
      dtls: { keys: await DtlsKeysContext.get() },
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/VP8",
            clockRate: 90000,
            rtcpFeedback: [useNACK(), usePLI(), useREMB(), useTWCC()],
          }),
        ],
      },
      headerExtensions: {
        video: [useTransportWideCC(), useAbsSendTime()],
      },
    };
  }

  private installBottleneckOnWerift(link: BottleneckLink) {
    // すべての ICE transport の send をラップ（メディア a→b 相当）
    for (const ice of this.pc.iceTransports) {
      link.install(ice.connection, "a2b");
    }
  }

  private startMediaLoop(payloadBytes = 800) {
    this.mediaStop?.();
    let seq = 0;
    let timestamp = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      if (stopped || !this.track) return;
      const target = Math.max(0, this.targetBps);
      const bits = payloadBytes * 8;
      const intervalMs =
        target <= 0 ? 100 : Math.max(5, Math.round((bits * 1000) / target));

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
      this.track.writeRtp(rtp);
      seq++;
      timestamp = (timestamp + 3000) >>> 0;
      timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, 10);
    this.mediaStop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  private snapshot() {
    const outbound = this.link?.stats("a2b") ?? emptyStats();
    const lastBitrate =
      this.bitrateSamples[this.bitrateSamples.length - 1] ??
      this.gcc?.availableBitrate ??
      0;
    return {
      capacityBps: this.capacityBps,
      targetBps: this.targetBps,
      adaptMode: this.adaptMode,
      availableBitrate: this.gcc?.availableBitrate ?? 0,
      lastBitrate,
      bitrateSamples: [...this.bitrateSamples],
      sampleCount: this.bitrateSamples.length,
      connectionState: this.pc?.connectionState,
      outbound,
      dropsAtCongestionEnd: this.dropsAtCongestionEnd,
      dropsDuringAdapt: Math.max(
        0,
        outbound.dropped - this.dropsAtCongestionEnd,
      ),
    };
  }

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init": {
        // 既存リソースを掃除（vitest retry 対応）
        await this.cleanup();

        const startBitrateBps = payload?.startBitrateBps ?? 700_000;
        this.capacityBps = payload?.capacityBps ?? 200_000;
        this.bitrateSamples = [];
        this.dropsAtCongestionEnd = 0;
        this.adaptMode = false;
        this.targetBps = 0;

        this.pc = new RTCPeerConnection(await this.peerConfig());
        this.track = new MediaStreamTrack({ kind: "video" });
        const transceiver = this.pc.addTransceiver(this.track, {
          direction: "sendonly",
        });
        this.sender = transceiver.sender;
        this.gcc = new GccBandwidthEstimator(startBitrateBps);
        this.sender.setBandwidthEstimator(this.gcc);
        this.sender.onAvailableBitrate.subscribe((bps) => {
          this.bitrateSamples.push(bps);
          if (this.adaptMode && bps > 0) {
            this.targetBps = Math.max(
              40_000,
              Math.min(bps, this.capacityBps * 1.05),
            );
          }
        });

        // 接続後にボトルネックを装着
        this.pc.connectionStateChange.subscribe((state) => {
          if (state === "connected" && !this.link) {
            this.link = new BottleneckLink({
              capacityBps: this.capacityBps,
              baseDelayMs: payload?.baseDelayMs ?? 50,
              maxQueueBytes: payload?.maxQueueBytes ?? 24_000,
            });
            this.installBottleneckOnWerift(this.link);
          }
        });

        await this.pc.setLocalDescription(await this.pc.createOffer());
        accept(this.pc.localDescription);
        break;
      }
      case "candidate": {
        await this.pc.addIceCandidate(payload);
        accept({});
        break;
      }
      case "answer": {
        await this.pc.setRemoteDescription(payload);
        // 接続待ち（ボトルネック装着の猶予）
        if (this.pc.connectionState !== "connected") {
          await this.pc.connectionStateChange.watch((s) => s === "connected");
        }
        if (!this.link) {
          this.link = new BottleneckLink({
            capacityBps: this.capacityBps,
            baseDelayMs: 50,
            maxQueueBytes: 24_000,
          });
          this.installBottleneckOnWerift(this.link);
        }
        accept({});
        break;
      }
      case "startCongestion": {
        // 容量超過の固定レートで輻輳を誘発
        this.adaptMode = false;
        this.targetBps = payload?.targetBps ?? 700_000;
        this.startMediaLoop(payload?.payloadBytes ?? 800);
        accept(this.snapshot());
        break;
      }
      case "markCongestionEnd": {
        // 輻輳期終了時点のドロップ数を記録
        this.dropsAtCongestionEnd = this.link?.stats("a2b").dropped ?? 0;
        accept(this.snapshot());
        break;
      }
      case "startAdapt": {
        // 推定帯域に追従して送信レートを下げる
        this.adaptMode = true;
        const last =
          this.bitrateSamples[this.bitrateSamples.length - 1] ??
          this.gcc.availableBitrate;
        this.targetBps = Math.max(
          40_000,
          Math.min(last || this.capacityBps, this.capacityBps),
        );
        if (!this.mediaStop) {
          this.startMediaLoop(payload?.payloadBytes ?? 800);
        }
        accept(this.snapshot());
        break;
      }
      case "snapshot": {
        accept(this.snapshot());
        break;
      }
      case "done": {
        await this.cleanup();
        accept({});
        break;
      }
      default:
        accept({});
    }
  }

  private async cleanup() {
    this.mediaStop?.();
    this.mediaStop = undefined;
    this.link?.close();
    this.link = undefined;
    try {
      await this.pc?.close();
    } catch {
      // ignore
    }
  }
}

function emptyStats(): BottleneckStats {
  return {
    enqueued: 0,
    forwarded: 0,
    dropped: 0,
    bytesEnqueued: 0,
    bytesForwarded: 0,
    bytesDropped: 0,
    peakQueueBytes: 0,
  };
}
