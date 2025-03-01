import { RTCDataChannel, RTCDataChannelParameters } from "../../dataChannel";
import { debug } from "../../imports/common";
import type { BaseManager } from "../types/manager";
import type { PeerConnectionContext } from "../types/peerConnectionContext";

const log = debug("werift:webrtc/sctpManager");

export class SctpManager implements BaseManager {
  constructor(public readonly context: PeerConnectionContext) {}

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
    const base: typeof options = {
      protocol: "",
      ordered: true,
      negotiated: false,
    };
    const settings: Required<typeof base> = { ...base, ...options } as any;

    if (settings.maxPacketLifeTime && settings.maxRetransmits) {
      throw new Error("can not select both");
    }

    if (!this.context.connection.sctpTransport) {
      this.context.connection.sctpTransport = this.createSctpTransport();
      this.context.needNegotiation();
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

    const channel = new RTCDataChannel(
      this.context.connection.sctpTransport,
      parameters,
    );
    return channel;
  }

  private createSctpTransport() {
    const dtlsTransport = this.context.connection.dtlsTransports[0]; //this.context.dtlsManager.createTransport([
    //SRTP_PROFILE.SRTP_AEAD_AES_128_GCM, // prefer
    //SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80,
    //]);
    const sctp = new RTCSctpTransport();
    sctp.setDtlsTransport(dtlsTransport);
    sctp.mid = undefined;

    sctp.onDataChannel.subscribe((channel) => {
      this.context.connection.onDataChannel.execute(channel);

      const event: RTCDataChannelEvent = { channel };
      if (this.context.connection.ondatachannel)
        this.context.connection.ondatachannel(event);
      this.context.connection.emit("datachannel", event);
    });

    this.context.connection.sctpTransport = sctp;
    this.context.updateIceConnectionState();

    return sctp;
  }

  dispose() {
    // Cleanup any SCTP-specific resources if needed
  }
}

export interface RTCDataChannelEvent {
  channel: RTCDataChannel;
}
