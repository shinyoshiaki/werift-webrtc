import { type SCTPOptions, SCTP_STATE } from "../../sctp/src";
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

/** The SCTP binding of a PeerConnection, for a negotiation rollback baseline. */
export type SctpNegotiationState = ReturnType<
  SctpTransportManager["snapshotNegotiationState"]
>;

export class SctpTransportManager {
  sctpTransport?: RTCSctpTransport;
  sctpRemotePort?: number;
  dataChannelsOpened = 0;
  dataChannelsClosed = 0;
  private dataChannels: RTCDataChannel[] = [];
  /**
   * SCTP transports that carry a `createDataChannel` call. They are
   * application state: negotiation rollback keeps them instead of stopping.
   */
  private readonly applicationOwned = new WeakSet<RTCSctpTransport>();

  readonly onDataChannel = new Event<[RTCDataChannel]>();

  constructor() {}

  createSctpTransport(maxMessageSize?: number, sctpOptions?: SCTPOptions) {
    const sctp = new RTCSctpTransport(5000, maxMessageSize, sctpOptions);
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
    this.applicationOwned.add(this.sctpTransport);

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

  isApplicationOwned(transport: RTCSctpTransport) {
    return this.applicationOwned.has(transport);
  }

  /** Internal: the SCTP binding a negotiation may change, for a rollback baseline. */
  snapshotNegotiationState() {
    const transport = this.sctpTransport;
    return {
      transport,
      dtlsTransport: transport?.dtlsTransport as RTCDtlsTransport | undefined,
      remotePort: this.sctpRemotePort,
      mid: transport?.mid,
      mLineIndex: transport?.mLineIndex,
      remoteMaxMessageSize: transport?.remoteMaxMessageSize,
    };
  }

  /** Internal: return to a negotiation baseline taken by `snapshotNegotiationState`. */
  async restoreNegotiationState(state: SctpNegotiationState) {
    const added =
      this.sctpTransport !== state.transport ? this.sctpTransport : undefined;
    // createDataChannel is an application operation: its SCTP transport
    // survives rollback, unbound from the rolled-back m-line, so the next
    // offer carries m=application again. An association that already ran
    // under the pending description is description state and is torn down.
    const keepAdded =
      !!added &&
      this.isApplicationOwned(added) &&
      added.sctp.associationState === SCTP_STATE.CLOSED;
    if (added && !keepAdded) {
      await added.stop();
    }
    this.sctpTransport = keepAdded ? added : state.transport;
    if (
      state.transport &&
      state.dtlsTransport &&
      state.transport.dtlsTransport !== state.dtlsTransport
    ) {
      state.transport.setDtlsTransport(state.dtlsTransport);
    }
    if (added && keepAdded) this.detachFromDescription(added);
    this.sctpRemotePort = state.remotePort;
    if (state.transport) {
      state.transport.mid = state.mid;
      state.transport.mLineIndex = state.mLineIndex;
      if (state.remoteMaxMessageSize !== undefined) {
        state.transport.remoteMaxMessageSize = state.remoteMaxMessageSize;
      }
    }
  }

  /**
   * Internal: an SCTP transport that no description bound yet goes back to
   * the MID / m-line index of `state` (see TransceiverManager's
   * `revertUnappliedAssociations`).
   */
  revertUnappliedAssociation(state: SctpNegotiationState) {
    const transport = this.sctpTransport;
    if (
      transport &&
      transport === state.transport &&
      this.sctpRemotePort === undefined
    ) {
      transport.mid = state.mid;
      transport.mLineIndex = state.mLineIndex;
    }
  }

  /** Drop what a rolled-back description set on a kept SCTP transport. */
  detachFromDescription(transport: RTCSctpTransport) {
    transport.mid = undefined;
    transport.mLineIndex = undefined;
    transport.remoteMaxMessageSize = DEFAULT_MAX_MESSAGE_SIZE;
  }

  async connectSctp() {
    if (!this.sctpTransport || !this.sctpRemotePort) {
      return;
    }

    await this.sctpTransport.start(this.sctpRemotePort);
    await this.sctpTransport.sctp.stateChanged.connected.asPromise();
    log("sctp connected");
  }

  /**
   * A committed answer rejected the application m-line: the SCTP transport
   * closes with its channels and is no longer the connection's (W3C sets
   * [[SctpTransport]] to null). Returns the transport it ran on.
   */
  async closeRejected() {
    const transport = this.sctpTransport;
    if (!transport) return;
    this.sctpTransport = undefined;
    this.sctpRemotePort = undefined;
    await transport.stop();
    return transport.dtlsTransport;
  }

  /**
   * A renegotiation pranswer / answer keeps the association (and its port)
   * but updates the data max message size it negotiates.
   */
  updateRemoteMaxMessageSize(remoteMedia: MediaDescription) {
    this.sctpTransport?.setRemoteMaxMessageSize(
      remoteMedia.sctpCapabilities?.maxMessageSize,
    );
  }

  setRemoteSCTP(remoteMedia: MediaDescription, mLineIndex: number) {
    if (!this.sctpTransport) {
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
    this.sctpTransport.mLineIndex = mLineIndex;
    if (!this.sctpTransport.mid) {
      this.sctpTransport.mid = remoteMedia.rtp.muxId;
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
