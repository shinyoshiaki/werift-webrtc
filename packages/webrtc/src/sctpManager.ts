import { createWebRtcTypeError } from "./errors";
import { Event, debug } from "./imports/common";

import { RTCDataChannel, RTCDataChannelParameters } from "./dataChannel";
import {
  type RTCDataChannelStats,
  type RTCStats,
  generateStatsId,
  getStatsTimestamp,
} from "./media/stats";
import type { MediaDescription } from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import { DEFAULT_MAX_MESSAGE_SIZE, RTCSctpTransport } from "./transport/sctp";

const log = debug("werift:packages/webrtc/src/transport/sctpManager.ts");

export interface SctpMediaSnapshot {
  existed: boolean;
  mid?: string;
  mLineIndex?: number;
  sctpRemotePort?: number;
  remoteMaxMessageSize?: number;
  dtlsTransport?: RTCDtlsTransport;
  internalRemotePort?: number;
}

export class SctpTransportManager {
  sctpTransport?: RTCSctpTransport;
  sctpRemotePort?: number;
  dataChannelsOpened = 0;
  dataChannelsClosed = 0;
  private dataChannels: RTCDataChannel[] = [];
  /**
   * commit 待ちの remote max-message-size。port と違って cap 変更は
   * association を壊さないが、current session への即時反映は避ける。
   */
  private stagedMaxMessageSize?: number;

  readonly onDataChannel = new Event<[RTCDataChannel]>();

  constructor() {}

  createSctpTransport(maxMessageSize?: number) {
    const sctp = new RTCSctpTransport(5000, maxMessageSize);
    sctp.mid = undefined;
    sctp.onDataChannel.subscribe((channel) => {
      this.dataChannelsOpened++;
      this.dataChannels.push(channel);
      this.onDataChannel.execute(channel);
    });

    this.sctpTransport = sctp;

    return sctp;
  }

  createDataChannel(
    label: string,
    options: Partial<{
      maxPacketLifeTime?: number;
      protocol: string;
      maxRetransmits?: number;
      ordered: boolean;
      negotiated: boolean;
      id?: number;
    }> = {},
  ): RTCDataChannel {
    const maxPacketLifeTime = coerceUnsignedShortOption(
      options.maxPacketLifeTime,
      "maxPacketLifeTime",
    );
    const maxRetransmits = coerceUnsignedShortOption(
      options.maxRetransmits,
      "maxRetransmits",
    );
    const base: typeof options = {
      protocol: "",
      ordered: true,
      negotiated: false,
    };
    const settings: Required<typeof base> = {
      ...base,
      ...options,
      maxPacketLifeTime,
      maxRetransmits,
    } as any;

    if (settings.maxPacketLifeTime != null && settings.maxRetransmits != null) {
      throw createWebRtcTypeError(
        "maxPacketLifeTime and maxRetransmits cannot both be set",
      );
    }

    if (!this.sctpTransport) {
      this.sctpTransport = this.createSctpTransport();
    }

    const parameters = new RTCDataChannelParameters({
      id: settings.id,
      label,
      maxPacketLifeTime: settings.maxPacketLifeTime,
      maxRetransmits: settings.maxRetransmits,
      negotiated: settings.negotiated,
      ordered: settings.ordered,
      protocol: settings.protocol,
    });

    const channel = new RTCDataChannel(this.sctpTransport, parameters);
    this.dataChannelsOpened++;
    this.dataChannels.push(channel);
    channel.stateChange.subscribe((state) => {
      if (state === "closed") {
        this.dataChannelsClosed++;
        const index = this.dataChannels.indexOf(channel);
        if (index !== -1) {
          this.dataChannels.splice(index, 1);
        }
      }
    });
    return channel;
  }

  async connectSctp() {
    if (!this.sctpTransport || !this.sctpRemotePort) {
      return;
    }

    await this.sctpTransport.start(this.sctpRemotePort);
    await this.sctpTransport.sctp.stateChanged.connected.asPromise();
    log("sctp connected");
  }

  setRemoteSCTP(
    remoteMedia: MediaDescription,
    mLineIndex: number,
    options: { deferAssociation?: boolean } = {},
  ) {
    if (!this.sctpTransport) {
      return;
    }

    // structural binding は常時即時 (answer 生成に必要)。
    this.sctpTransport.mLineIndex = mLineIndex;
    if (!this.sctpTransport.mid) {
      this.sctpTransport.mid = remoteMedia.rtp.muxId;
    }
    // live association がある場合だけ commit まで stage する。初回確立時は
    // 即時適用しないと datachannel が繋がらない。
    if (
      options.deferAssociation &&
      this.sctpTransport.sctp.getRemotePort() != null
    ) {
      // association への反映は local final answer の commit まで stage する。
      // port 変更自体は SRD 側で事前に拒否済みのため、ここでは max-size のみ。
      // 属性省略時は RFC 8841 §6.1 の 64K に正規化し、明示 0 (unlimited) と区別する。
      this.stagedMaxMessageSize =
        remoteMedia.sctpCapabilities?.maxMessageSize ??
        DEFAULT_MAX_MESSAGE_SIZE;
      return;
    }

    // # configure sctp
    this.sctpTransport.setRemoteMaxMessageSize(
      remoteMedia.sctpCapabilities?.maxMessageSize,
    );
    this.sctpRemotePort = remoteMedia.sctpPort;
    if (!this.sctpRemotePort) {
      throw new Error("sctpRemotePort not exist");
    }

    this.sctpTransport.setRemotePort(this.sctpRemotePort);
  }

  /** staged max-message-size を commit 時に反映する。 */
  commitStagedAssociation(): void {
    if (this.stagedMaxMessageSize !== undefined && this.sctpTransport) {
      this.sctpTransport.setRemoteMaxMessageSize(this.stagedMaxMessageSize);
    }
    this.stagedMaxMessageSize = undefined;
  }

  /** staged max-message-size を破棄する (rollback 用)。 */
  clearStagedAssociation(): void {
    this.stagedMaxMessageSize = undefined;
  }

  /**
   * remote offer/pranswer 適用前の SCTP 状態。rollback 時に復元し、pending 中に
   * 新規作成された transport は停止・除去する。datachannel 自体は対象外。
   */
  snapshotMediaState(): SctpMediaSnapshot {
    const transport = this.sctpTransport;
    return {
      existed: !!transport,
      mid: transport?.mid,
      mLineIndex: transport?.mLineIndex,
      sctpRemotePort: this.sctpRemotePort,
      remoteMaxMessageSize: transport?.remoteMaxMessageSize,
      dtlsTransport: transport?.dtlsTransport,
      internalRemotePort: transport?.sctp.getRemotePort(),
    };
  }

  async restoreMediaState(snapshot: SctpMediaSnapshot): Promise<void> {
    if (!snapshot.existed) {
      const created = this.sctpTransport;
      this.sctpTransport = undefined;
      this.sctpRemotePort = snapshot.sctpRemotePort;
      if (created) {
        await created.stop().catch(() => undefined);
      }
      return;
    }
    const transport = this.sctpTransport;
    if (!transport) {
      return;
    }
    transport.mid = snapshot.mid;
    transport.mLineIndex = snapshot.mLineIndex;
    this.sctpRemotePort = snapshot.sctpRemotePort;
    if (snapshot.remoteMaxMessageSize !== undefined) {
      transport.remoteMaxMessageSize = snapshot.remoteMaxMessageSize;
    }
    if (
      snapshot.dtlsTransport &&
      transport.dtlsTransport !== snapshot.dtlsTransport
    ) {
      transport.setDtlsTransport(snapshot.dtlsTransport);
    }
    if (snapshot.internalRemotePort !== undefined) {
      transport.setRemotePort(snapshot.internalRemotePort);
    }
  }

  async close() {
    if (this.sctpTransport) {
      await this.sctpTransport.stop();
      // UdpTransport.send は既知アドレスでは callback を待たない。呼び出し側が
      // 直後に ICE ソケットを閉じると queued な AbortChunk が落ちるので、1 tick 譲る。
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    this.onDataChannel.allUnsubscribe();
  }

  async getStats(timestamp = getStatsTimestamp()): Promise<RTCStats[]> {
    const stats: RTCStats[] = [];

    for (const channel of this.dataChannels) {
      const channelStats: RTCDataChannelStats = {
        type: "data-channel",
        id: generateStatsId("data-channel", channel.id ?? channel.statsId),
        timestamp,
        label: channel.label,
        protocol: channel.protocol,
        dataChannelIdentifier: channel.id ?? undefined,
        state: channel.readyState,
        messagesSent: channel.messagesSent || 0,
        bytesSent: channel.bytesSent || 0,
        messagesReceived: channel.messagesReceived || 0,
        bytesReceived: channel.bytesReceived || 0,
      };
      stats.push(channelStats);
    }

    return stats;
  }
}

function coerceUnsignedShortOption(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const coerced = Number(value);
  if (
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < 0 ||
    coerced > 65535
  ) {
    throw createWebRtcTypeError(`${name} must be an unsigned short`);
  }

  return coerced;
}
