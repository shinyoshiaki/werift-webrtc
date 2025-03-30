import { SRTP_PROFILE } from "../../const";
import { RTCDataChannel, RTCDataChannelParameters } from "../../dataChannel";
import { Event, debug } from "../../imports/common";
import type { RTCDtlsTransport } from "../../transport/dtls";
import { RTCSctpTransport } from "../../transport/sctp";
import type { Callback, CallbackWithValue } from "../../types/util";

const log = debug("werift:webrtc/sctpManager");

/**
 * SCTP Manager
 * Handles SCTP (Stream Control Transmission Protocol) related operations for DataChannels
 */
export class SctpManager {
  readonly onDataChannel = new Event<[RTCDataChannel]>();
  private transport?: RTCSctpTransport;
  private remotePort?: number;

  constructor() {}

  /**
   * Create an SCTP transport
   */
  createSctpTransport(dtlsTransport: RTCDtlsTransport): RTCSctpTransport {
    if (this.transport) {
      return this.transport;
    }

    const sctp = new RTCSctpTransport();
    sctp.setDtlsTransport(dtlsTransport);
    sctp.mid = undefined;

    // Handle data channel events
    sctp.onDataChannel.subscribe((channel) => {
      this.onDataChannel.execute(channel);
    });

    this.transport = sctp;
    return sctp;
  }

  /**
   * Create a data channel
   */
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
    if (!this.transport) {
      throw new Error("SCTP transport not initialized");
    }

    const base: typeof options = {
      protocol: "",
      ordered: true,
      negotiated: false,
    };
    const settings: Required<typeof base> = { ...base, ...options } as any;

    if (settings.maxPacketLifeTime && settings.maxRetransmits) {
      throw new Error(
        "Cannot specify both maxPacketLifeTime and maxRetransmits",
      );
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

    const channel = new RTCDataChannel(this.transport, parameters);
    return channel;
  }

  /**
   * Get the SCTP transport
   */
  getSctpTransport() {
    return this.transport;
  }

  /**
   * Set remote port for SCTP
   */
  setRemotePort(port: number) {
    this.remotePort = port;
    if (this.transport) {
      this.transport.setRemotePort(port);
    }
  }

  /**
   * Get remote port
   */
  getRemotePort() {
    return this.remotePort;
  }

  /**
   * Start SCTP transport
   */
  async startSctpTransport() {
    if (!this.transport || !this.remotePort) {
      log("Cannot start SCTP transport - transport or remote port missing");
      return;
    }

    if (this.transport.sctp.isInitialized) {
      log("SCTP transport already started");
      return;
    }

    await this.transport.start(this.remotePort);
    await this.transport.sctp.stateChanged.connected.asPromise();
    log("SCTP transport connected");
  }

  /**
   * Stop SCTP transport
   */
  async stopSctpTransport() {
    if (this.transport) {
      await this.transport.stop();
      this.transport = undefined;
    }
  }

  /**
   * Check if transport exists
   */
  hasTransport(): boolean {
    return !!this.transport;
  }

  /**
   * Update DTLS transport for SCTP
   */
  updateDtlsTransport(dtlsTransport: RTCDtlsTransport) {
    if (this.transport) {
      this.transport.setDtlsTransport(dtlsTransport);
    }
  }

  /**
   * Set MID for SCTP transport
   */
  setMid(mid: string) {
    if (this.transport) {
      this.transport.mid = mid;
    }
  }

  /**
   * Get MID for SCTP transport
   */
  getMid() {
    return this.transport?.mid;
  }

  /**
   * Set mLineIndex for SCTP transport
   */
  setMLineIndex(index: number) {
    if (this.transport) {
      this.transport.mLineIndex = index;
    }
  }

  /**
   * Get mLineIndex for SCTP transport
   */
  getMLineIndex() {
    return this.transport?.mLineIndex;
  }

  /**
   * Serialize to JSON for live migration
   */
  toJSON() {
    return {
      remotePort: this.remotePort,
      transportId: this.transport?.id,
      mid: this.transport?.mid,
      mLineIndex: this.transport?.mLineIndex,
    };
  }

  /**
   * Restore from JSON for live migration
   */
  fromJSON(
    json: any,
    getTransport: (id: string) => RTCSctpTransport | undefined,
  ) {
    if (json.remotePort !== undefined) {
      this.remotePort = json.remotePort;
    }

    if (json.transportId && getTransport) {
      this.transport = getTransport(json.transportId);

      // Restore properties if transport was found
      if (this.transport) {
        if (json.mid !== undefined) {
          this.transport.mid = json.mid;
        }
        if (json.mLineIndex !== undefined) {
          this.transport.mLineIndex = json.mLineIndex;
        }
        if (this.remotePort) {
          this.transport.setRemotePort(this.remotePort);
        }
      }
    }
  }
}
