import Event from "rx.mini";

import { RtpHeader, RtpPacket } from "../../../rtp/src";
import { EventTarget } from "../helper";
import { Kind } from "../types/domain";
import { RTCRtpCodecParameters } from "./parameters";

export class MediaStreamTrack extends EventTarget {
  remote = false;
  label: string;
  kind!: Kind;
  id?: string;

  ssrc?: number;
  rid?: string;
  header?: RtpHeader;
  codec?: RTCRtpCodecParameters;
  /**todo impl */
  enabled = true;

  readonly onReceiveRtp = new Event<[RtpPacket]>();

  stopped = false;
  muted = true;

  constructor(
    props: Partial<MediaStreamTrack> & Pick<MediaStreamTrack, "kind">
  ) {
    super();
    Object.assign(this, props);

    this.onReceiveRtp.subscribe((rtp) => {
      this.muted = false;
      this.header = rtp.header;
    });

    this.label = `${this.remote ? "remote" : "local"} ${this.kind}`;
  }

  stop = () => {
    this.stopped = true;
    this.muted = true;
    this.onReceiveRtp.complete();
  };

  writeRtp = (rtp: RtpPacket | Buffer) => {
    if (this.remote) throw new Error("this is remoteTrack");
    if (!this.codec || this.stopped) return;

    const packet = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;
    packet.header.payloadType = this.codec.payloadType;
    this.onReceiveRtp.execute(packet);
  };
}

export class MediaStream {
  id!: string;
  constructor(props: MediaStream) {
    Object.assign(this, props);
  }
}
