import type { SCTPOptions } from "../../sctp/src";
import { RTCDataChannel, RTCDataChannelParameters } from "./dataChannel";
import { createWebRtcTypeError } from "./errors";
import { debug, Event } from "./imports/common";
import {
  generateStatsId,
  getStatsTimestamp,
  type RTCDataChannelStats,
  type RTCStats,
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
 * - Rejection of the application m-line (port 0) keeps the SCTP transport:
 *   it stays bound to its MID and the next offer offers the application again
 *   with that MID (W3C would set `sctpTransport` to null). A rejecting remote
 *   offer or pranswer is provisional and leaves the association alone, and
 *   so does any rejection of an association the rollback baseline negotiated.
 *   A final answer with port 0 (RFC 8841 section 10.4), local or remote,
 *   aborts an association the proposal started (a pranswer or the remote
 *   INIT) and releases the remote port on that peer (`rejectApplication`).
 *   Channels on it close; the other peer closes its own when it applies the
 *   same answer. The commit does not move the transport to
 *   a transport the answer did not negotiate for it. An answer to an offer
 *   whose application m-line has port 0 has port 0 (RFC 3264 section 6).
 * - The position (MID, index, rejected) is recorded by the current
 *   description, not by this object. An unbound transport takes a rejected
 *   position with a new MID; an offer that does so moves the transport to that
 *   MID (restored by rollback). A MID only an unapplied `createOffer`
 *   reserved follows the MID of the peer's offer.
 * - At the final answer SCTP moves straight to its owner's DTLS transport in
 *   the answer. SCTP starts after every answer or pranswer that negotiates the
 *   application m-line (JSEP 5.11), also on an already connected DTLS
 *   transport: an `m=application` a renegotiation adds to a connected session
 *   starts without touching ICE or DTLS and without moving `connectionState`.
 *   Its client / server side follows the ICE role at the DTLS start. Starting
 *   is idempotent (`RTCSctpTransport.ensureStarted`): an established
 *   association, also one the remote INIT established first, a handshaking
 *   one and a closed one never start again, so a final answer keeping the
 *   pranswer's sctp-port continues it. A final answer changing the sctp-port
 *   is rejected in validation.
 * - Rollback keeps an application-owned transport (`detachFromDescription`
 *   clears what the description set), whether it is in the baseline or was
 *   added during the transaction, and stops one a description created. When
 *   the baseline has no negotiated remote port, an association that left its
 *   initial state under the proposal (started by a pranswer, or established
 *   from the remote INIT) is pending-only: it is aborted and an
 *   application-owned transport gets a new, unstarted association on the same
 *   DTLS transport. Its channels with a stream ID close; channels still
 *   waiting for one stay `connecting` for the next negotiation.
 * - `sctp.mtu` is configuration: every transport, also a pending one, is built
 *   with it, and moving to another DTLS transport keeps it.
 */
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
      this.track(channel);
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
    this.track(channel);
    return channel;
  }

  /**
   * Count a channel (created here or announced by the remote peer) and keep
   * it for getStats until it closes. The listener goes with it: a closed
   * channel the application still holds must not keep the manager reachable.
   */
  private track(channel: RTCDataChannel) {
    this.dataChannelsOpened++;
    this.dataChannels.push(channel);
    const { unSubscribe } = channel.stateChange.subscribe((state) => {
      if (state === "closed") {
        unSubscribe();
        this.dataChannelsClosed++;
        const index = this.dataChannels.indexOf(channel);
        if (index !== -1) {
          this.dataChannels.splice(index, 1);
        }
      }
    });
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
    const current = this.sctpTransport;
    const added = current !== state.transport ? current : undefined;
    // createDataChannel is an application operation: its SCTP transport
    // survives rollback, unbound from the rolled-back m-line, so the next
    // offer carries m=application again. A transport a description created
    // is description state and is torn down.
    const keepAdded = !!added && this.isApplicationOwned(added);
    if (added && !keepAdded) {
      await added.stop();
    }
    // Without a negotiated binding in the baseline, an association that ran
    // under the pending description (started by a pranswer, or established
    // passively from the remote INIT) is pending-only: it is discarded and a
    // new, unstarted one waits for the next negotiation. Attached channels
    // close; unattached ones stay queued.
    const kept = keepAdded ? added : state.transport;
    if (kept && state.remotePort === undefined && kept.associationActive) {
      await kept.resetAssociation(
        kept === state.transport ? state.dtlsTransport : undefined,
      );
    }
    this.sctpTransport = kept;
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
   * Internal: a final answer rejected the application m-line (port 0, RFC
   * 8841 section 10.4). The association a pranswer started closes; the
   * transport waits unbound for a later negotiation.
   */
  async rejectApplication() {
    const transport = this.sctpTransport;
    if (!transport) return;
    if (transport.associationActive) await transport.resetAssociation();
    this.sctpRemotePort = undefined;
    this.detachFromDescription(transport);
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

  /**
   * Start the association of the negotiated application m-line and wait
   * until it is established. Safe to call any number of times: an
   * established (also passively established) or handshaking association is
   * not started again, and a closed one is not waited for. The wait is
   * bounded even if the remote never answers: the INIT retries (T1) give up
   * and the association emits `closed`.
   */
  async connectSctp() {
    const transport = this.sctpTransport;
    if (!transport || !this.sctpRemotePort) {
      return;
    }
    const { sctp } = transport;
    if (sctp.state === "closed") {
      log("sctp closed");
      return;
    }
    // Subscribe before starting so a transition during start is not missed.
    const settled =
      sctp.state === "connected"
        ? undefined
        : Promise.race([
            sctp.stateChanged.connected.asPromise(),
            sctp.stateChanged.closed.asPromise(),
          ]);

    await transport.ensureStarted(this.sctpRemotePort);
    // The state may have settled while starting.
    if (settled && !["connected", "closed"].includes(sctp.state)) {
      await settled;
    }
    log("sctp", sctp.state);
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
