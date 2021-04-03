import Event from "rx.mini";
import { v4 } from "uuid";
import { RtpHeader, RtpPacket } from "../../../rtp/src";
import { Kind } from "../types/domain";
import { RTCRtpCodecParameters } from "./parameters";

export class MediaStreamTrack {
  remote = false;
  label: string;
  id: string = v4();
  kind!: Kind;
  ssrc?: number;
  rid?: string;
  header?: RtpHeader;
  codec?: RTCRtpCodecParameters;

  readonly onReceiveRtp = new Event<[RtpPacket]>();

  stopped = false;
  muted = true;

  constructor(
    props: Partial<MediaStreamTrack> & Pick<MediaStreamTrack, "kind">
  ) {
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
    if (this.stopped) return;

    const packet = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    this.onReceiveRtp.execute(packet);
  };
}
