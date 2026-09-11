import type { SCTP } from "../../sctp/src";
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
import { RTCSctpTransport } from "./transport/sctp";

const log = debug("werift:packages/webrtc/src/transport/sctpManager.ts");

export class SctpTransportManager {
  sctpTransport?: RTCSctpTransport;
  sctpRemotePort?: number;
  dataChannelsOpened = 0;
  dataChannelsClosed = 0;
  private dataChannels: RTCDataChannel[] = [];
  /** A fulfilled promise belongs to one concrete SCTP association only. */
  private connectAttempt?: {
    association: SCTP;
    promise: Promise<void>;
  };

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

  /** @internal Restore the SCTP owner after a rejected SDP transaction. */
  restoreSctpTransport(
    sctpTransport: RTCSctpTransport | undefined,
    sctpRemotePort?: number,
  ) {
    this.sctpTransport = sctpTransport;
    this.sctpRemotePort = sctpRemotePort;
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
    const transport = this.sctpTransport;
    const association = transport.prepareForStart();
    const previousAttempt = this.connectAttempt;
    if (previousAttempt?.association === association) {
      await previousAttempt.promise;
      return;
    }
    const outcome = this.waitForSctpOutcome(association);
    // Attach a fulfillment handler before starting SCTP.  INIT failure can
    // synchronously transition the association to CLOSED, so awaiting only
    // transport.start() would leave outcome.promise rejected and unhandled.
    const outcomeResult = outcome.promise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const attempt = (async () => {
      try {
        await transport.start(this.sctpRemotePort!);
        const result = await outcomeResult;
        if (result.ok === false) {
          throw result.error;
        }
        log("sctp connected");
      } finally {
        outcome.dispose();
      }
    })();
    const currentAttempt = { association, promise: attempt };
    this.connectAttempt = currentAttempt;
    try {
      await attempt;
    } catch (error) {
      if (this.connectAttempt === currentAttempt) {
        this.connectAttempt = undefined;
      }
      throw error;
    }
  }

  private waitForSctpOutcome(sctp: SCTP) {
    let settled = false;
    let unSubscribeConnected = () => {};
    let unSubscribeClosed = () => {};
    const dispose = () => {
      unSubscribeConnected();
      unSubscribeClosed();
      unSubscribeConnected = () => {};
      unSubscribeClosed = () => {};
    };

    const promise = new Promise<void>((resolve, reject) => {
      const complete = (callback: () => void) => {
        if (settled) return;
        settled = true;
        dispose();
        callback();
      };

      unSubscribeConnected = sctp.stateChanged.connected.subscribe(() =>
        complete(resolve),
      ).unSubscribe;
      unSubscribeClosed = sctp.stateChanged.closed.subscribe(() =>
        complete(() =>
          reject(
            sctp.startCancellationError ??
              new Error("SCTP association closed before connecting"),
          ),
        ),
      ).unSubscribe;

      // The association may already have transitioned before the listeners
      // were installed (notably after a synchronous INIT failure).
      if (sctp.state === "connected") {
        complete(resolve);
      } else if (sctp.state === "closed") {
        complete(() =>
          reject(
            sctp.startCancellationError ??
              new Error("SCTP association closed before connecting"),
          ),
        );
      }
    });

    return { promise, dispose };
  }

  /** Validate remote application media without mutating the live association. */
  validateRemoteSctp(remoteMedia: MediaDescription) {
    if (remoteMedia.sctpPort == undefined) {
      throw new Error("sctpRemotePort not exist");
    }
  }

  static nextLocalPort(currentPort: number | undefined): number {
    const current = currentPort && currentPort > 0 ? currentPort : 5000;
    const next = current >= 65535 ? 5000 : current + 1;
    return next === 0 ? 5001 : next;
  }

  async applyAssociationUpdate(params: {
    remotePort: number;
    localPort: number;
    mLineIndex: number;
    remoteMaxMessageSize?: number;
    replaceAssociation: boolean;
    closeAssociation: boolean;
  }) {
    if (!this.sctpTransport) {
      return;
    }

    this.sctpTransport.mLineIndex = params.mLineIndex;
    this.sctpTransport.setRemoteMaxMessageSize(params.remoteMaxMessageSize);

    if (params.closeAssociation) {
      this.sctpRemotePort = undefined;
      this.connectAttempt = undefined;
      await this.sctpTransport.closeAssociation();
      return;
    }

    if (params.replaceAssociation) {
      this.connectAttempt = undefined;
      await this.sctpTransport.replaceAssociation(params.localPort);
      this.sctpRemotePort = params.remotePort;
      this.sctpTransport.setRemotePort(params.remotePort);
      return;
    }

    this.setRemoteSCTPPort(params.remotePort, params.mLineIndex);
  }

  private setRemoteSCTPPort(remotePort: number, mLineIndex: number) {
    if (!this.sctpTransport) {
      return;
    }
    this.sctpRemotePort = remotePort;
    this.sctpTransport.setRemotePort(remotePort);
    this.sctpTransport.mLineIndex = mLineIndex;
  }

  setRemoteSCTP(remoteMedia: MediaDescription, mLineIndex: number) {
    if (!this.sctpTransport) {
      return;
    }

    this.validateRemoteSctp(remoteMedia);
    if (!remoteMedia.sctpPort) {
      throw new Error("sctpRemotePort not exist");
    }

    this.sctpTransport.setRemoteMaxMessageSize(
      remoteMedia.sctpCapabilities?.maxMessageSize,
    );
    this.setRemoteSCTPPort(remoteMedia.sctpPort, mLineIndex);
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
