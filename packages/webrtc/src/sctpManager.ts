import { type SCTP, type SCTPOptions, SCTP_STATE } from "../../sctp/src";
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

/**
 * The SCTP transport of a PeerConnection and its application m-line.
 *
 * - Rejection of the application m-line (port 0 in the peer's offer, an
 *   answer or a pranswer) never closes the SCTP transport: it stays bound to
 *   its MID and the next offer offers the application again with that MID
 *   (W3C would set `sctpTransport` to null). The commit does not move it to a
 *   transport the answer did not negotiate for it. An answer to an offer whose
 *   application m-line has port 0 has port 0 (RFC 3264 section 6).
 * - The position (MID, index, rejected) is recorded by the current
 *   description, not by this object. An unbound transport takes a rejected
 *   position with a new MID; an offer that does so moves the transport to that
 *   MID (restored by rollback). A MID only an unapplied `createOffer`
 *   reserved follows the MID of the peer's offer.
 * - At the final answer SCTP moves straight to its owner's DTLS transport in
 *   the answer. A transport joining an already connected DTLS transport
 *   starts its association there; its client / server side follows the ICE
 *   role at the DTLS start.
 * - Rollback keeps an application-owned transport whose association never
 *   ran (`detachFromDescription` clears what the description set) and stops
 *   one a description created or whose association ran under the proposal;
 *   channels opened on a pending-only association close with it.
 * - `sctp.mtu` is configuration: every transport, also a pending one, is built
 *   with it, and moving to another DTLS transport keeps it.
 */
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
  /** SCTP transports that carry a createDataChannel call survive rollback. */
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

  /** Update negotiated message size while retaining the current association. */
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
