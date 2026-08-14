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
  usePLI,
  useREMB,
  useTWCC,
  useTransportWideCC,
} from "..";
import { DtlsKeysContext } from "../fixture";
import { BottleneckLink, type BottleneckStats } from "./bottleneckLink";

/** Tiny VP8 keyframe descriptor so Chrome treats the payload as video RTP. */
const VP8_KEYFRAME_PREFIX = Buffer.from([
  0x10, 0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x02, 0x00, 0x02, 0x00,
]);

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
  private rtpDropsAtCongestionEnd = 0;
  /** Media packets that reached RTCDtlsTransport.sendRtp. */
  private mediaRtpAttempts = 0;
  private mediaRtpSentOk = 0;
  private mediaRtpBytes = 0;
  private lastSendRtpError?: string;
  private wrappedIce?: object;
  private sendRtpHooked = false;

  private async peerConfig() {
    return {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      iceUseIpv4: true,
      iceUseIpv6: false,
      // 単一 ICE/DTLS に束ね、sendRtp 経路とボトルネック対象を一致させる
      bundlePolicy: "max-bundle" as const,
      dtls: { keys: await DtlsKeysContext.get() },
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/VP8",
            clockRate: 90000,
            // Omit NACK: Chrome NACK/RTX storms after the congestion phase
            // re-flood the bottleneck and hide GCC/TWCC adaptation results.
            rtcpFeedback: [usePLI(), useREMB(), useTWCC()],
          }),
        ],
      },
      headerExtensions: {
        video: [useTransportWideCC(), useAbsSendTime()],
      },
    };
  }

  /** ICE connection actually used by RTCDtlsTransport.sendRtp. */
  private iceConnectionForSendRtp():
    | { send: (data: Buffer) => Promise<void> }
    | undefined {
    return this.sender?.dtlsTransport?.iceTransport?.connection;
  }

  /**
   * Wrap **only** the ICE connection sendRtp uses (not an unrelated transport).
   * Same object as `RTCDtlsTransport.iceTransport.connection.send`.
   */
  private installBottleneckOnWerift(link: BottleneckLink): boolean {
    const conn = this.iceConnectionForSendRtp();
    if (!conn) return false;
    link.install(conn, "a2b");
    this.wrappedIce = conn;
    return true;
  }

  private iceMatchesSendRtpPath(): boolean {
    const sendRtpIce = this.iceConnectionForSendRtp();
    if (!sendRtpIce) return false;
    if (this.wrappedIce !== sendRtpIce) return false;
    const listed = this.pc?.iceTransports.map((ice) => ice.connection) ?? [];
    return listed.some((ice) => ice === sendRtpIce);
  }

  /** Count media independently of ICE wrap (proves sendRtp is actually called). */
  private hookSendRtpCounter() {
    const dtls = this.sender?.dtlsTransport;
    if (!dtls || this.sendRtpHooked) return;
    this.sendRtpHooked = true;
    const orig = dtls.sendRtp.bind(dtls);
    dtls.sendRtp = async (payload, header) => {
      this.mediaRtpAttempts++;
      try {
        const n = await orig(payload, header);
        if (n > 0) {
          this.mediaRtpSentOk++;
          this.mediaRtpBytes += n;
        }
        return n;
      } catch (error) {
        this.lastSendRtpError = String(error);
        throw error;
      }
    };
  }

  private async waitUntilSenderCanSend(timeoutMs = 2_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (
        this.sender?.codec &&
        this.sender.dtlsTransport?.state === "connected"
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private startMediaLoop(payloadBytes = 800) {
    this.mediaStop?.();
    let seq = 0;
    let timestamp = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = Math.max(payloadBytes, VP8_KEYFRAME_PREFIX.length);
    const payload = Buffer.alloc(body, 0x5a);
    VP8_KEYFRAME_PREFIX.copy(payload);

    const tick = () => {
      if (stopped || !this.sender) return;
      const target = Math.max(0, this.targetBps);
      const bits = payload.length * 8;
      const intervalMs =
        target <= 0 ? 100 : Math.max(5, Math.round((bits * 1000) / target));

      const rtp = new RtpPacket(
        new RtpHeader({
          sequenceNumber: seq & 0xffff,
          timestamp: timestamp >>> 0,
          payloadType: this.sender.codec?.payloadType ?? 96,
          marker: seq % 30 === 0,
          extension: true,
          extensions: [],
          payloadOffset: 12,
        }),
        payload,
      );
      // sendRtp 直呼びで track Event を経由せず、ICE 経路に載せる
      void this.sender.sendRtp(rtp);
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
    const rtp = outbound.byKind.rtp;
    return {
      capacityBps: this.capacityBps,
      targetBps: this.targetBps,
      adaptMode: this.adaptMode,
      availableBitrate: this.gcc?.availableBitrate ?? 0,
      lastBitrate,
      bitrateSamples: [...this.bitrateSamples],
      sampleCount: this.bitrateSamples.length,
      connectionState: this.pc?.connectionState,
      dtlsState: this.sender?.dtlsTransport?.state,
      hasCodec: !!this.sender?.codec,
      iceMatchesSendRtpPath: this.iceMatchesSendRtpPath(),
      mediaRtpAttempts: this.mediaRtpAttempts,
      mediaRtpSentOk: this.mediaRtpSentOk,
      mediaRtpBytes: this.mediaRtpBytes,
      lastSendRtpError: this.lastSendRtpError,
      outbound,
      rtpOutbound: rtp,
      dropsAtCongestionEnd: this.dropsAtCongestionEnd,
      rtpDropsAtCongestionEnd: this.rtpDropsAtCongestionEnd,
      dropsDuringAdapt: Math.max(
        0,
        outbound.dropped - this.dropsAtCongestionEnd,
      ),
      rtpDropsDuringAdapt: Math.max(
        0,
        rtp.dropped - this.rtpDropsAtCongestionEnd,
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
        this.rtpDropsAtCongestionEnd = 0;
        this.mediaRtpAttempts = 0;
        this.mediaRtpSentOk = 0;
        this.mediaRtpBytes = 0;
        this.lastSendRtpError = undefined;
        this.wrappedIce = undefined;
        this.sendRtpHooked = false;
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
            // Follow estimate but never exceed ~90% of capacity so the
            // bottleneck stays clear after congestion recovery.
            this.targetBps = Math.max(
              40_000,
              Math.min(bps, this.capacityBps * 0.9),
            );
          }
        });

        // 接続後にボトルネックを装着
        this.pc.connectionStateChange.subscribe((state) => {
          if (state === "connected" && !this.link) {
            this.link = new BottleneckLink({
              capacityBps: this.capacityBps,
              baseDelayMs: payload?.baseDelayMs ?? 50,
              maxQueueBytes: payload?.maxQueueBytes ?? 12_000,
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
            maxQueueBytes: 12_000,
          });
          this.installBottleneckOnWerift(this.link);
        }
        accept({});
        break;
      }
      case "startCongestion": {
        // 送信可能になってから、sendRtp と同一 ICE にボトルネックを装着する
        await this.waitUntilSenderCanSend();
        this.hookSendRtpCounter();
        if (!this.link) {
          this.link = new BottleneckLink({
            capacityBps: this.capacityBps,
            baseDelayMs: 50,
            maxQueueBytes: 12_000,
          });
        }
        this.installBottleneckOnWerift(this.link);
        // ボトルネック装着後に probe を開始（装着前の timeout clock を避ける）
        this.gcc?.setNetworkAvailable(true);
        this.adaptMode = false;
        this.targetBps = payload?.targetBps ?? 700_000;
        this.startMediaLoop(payload?.payloadBytes ?? 800);
        accept(this.snapshot());
        break;
      }
      case "markCongestionEnd": {
        // 輻輳期終了時点のドロップ数を記録
        const st = this.link?.stats("a2b");
        this.dropsAtCongestionEnd = st?.dropped ?? 0;
        this.rtpDropsAtCongestionEnd = st?.byKind.rtp.dropped ?? 0;
        accept(this.snapshot());
        break;
      }
      case "startAdapt": {
        // 推定帯域に追従して送信レートを下げる
        this.adaptMode = true;
        const last =
          this.bitrateSamples[this.bitrateSamples.length - 1] ??
          this.gcc.availableBitrate;
        // Never chase above capacity; leave a small headroom for RTCP/ICE.
        this.targetBps = Math.max(
          40_000,
          Math.min(last || this.capacityBps * 0.9, this.capacityBps * 0.9),
        );
        if (!this.mediaStop) {
          this.startMediaLoop(payload?.payloadBytes ?? 800);
        }
        accept(this.snapshot());
        break;
      }
      case "markAdaptStart": {
        // Call after a short settle so residual queue / aborting probes are
        // not counted as adaptation-period drops.
        const st = this.link?.stats("a2b");
        this.dropsAtCongestionEnd = st?.dropped ?? 0;
        this.rtpDropsAtCongestionEnd = st?.byKind.rtp.dropped ?? 0;
        // Also re-baseline enqueued for rate math on the client.
        accept({
          ...this.snapshot(),
          enqueuedAtAdaptStart: st?.enqueued ?? 0,
          rtpEnqueuedAtAdaptStart: st?.byKind.rtp.enqueued ?? 0,
        });
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
    byKind: {
      rtp: { enqueued: 0, forwarded: 0, dropped: 0, bytesEnqueued: 0 },
      rtcp: { enqueued: 0, forwarded: 0, dropped: 0, bytesEnqueued: 0 },
      stun: { enqueued: 0, forwarded: 0, dropped: 0, bytesEnqueued: 0 },
      dtls: { enqueued: 0, forwarded: 0, dropped: 0, bytesEnqueued: 0 },
      other: { enqueued: 0, forwarded: 0, dropped: 0, bytesEnqueued: 0 },
    },
  };
}
