import { Event, debug } from "./imports/common";

import { RTCDataChannel, RTCDataChannelParameters } from "./dataChannel";
import type { MediaDescription } from "./sdp";
import { RTCSctpTransport } from "./transport/sctp";

const log = debug("werift:packages/webrtc/src/transport/sctpManager.ts");

export class SctpTransportManager {
  sctpTransport?: RTCSctpTransport;
  sctpRemotePort?: number;

  readonly onDataChannel = new Event<[RTCDataChannel]>();

  constructor() {}

  createSctpTransport() {
    const sctp = new RTCSctpTransport();
    sctp.mid = undefined;

    sctp.onDataChannel.subscribe((channel) => {
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
    const base: typeof options = {
      protocol: "",
      ordered: true,
      negotiated: false,
    };
    const settings: Required<typeof base> = { ...base, ...options } as any;

    if (settings.maxPacketLifeTime && settings.maxRetransmits) {
      throw new Error("can not select both");
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

  setRemoteSCTP(remoteMedia: MediaDescription, mLineIndex: number) {
    if (!this.sctpTransport) {
      return;
    }

    // # configure sctp
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
    }
  }
}
