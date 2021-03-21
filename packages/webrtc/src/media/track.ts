import Event from "rx.mini";
import { RtpHeader, RtpPacket } from "../../../rtp/src";
import { Kind } from "../typings/domain";

export class MediaStreamTrack {
  role: "read" | "write" = "write";
  kind!: Kind;
  id?: string;
  ssrc?: number;
  rid?: string;
  header?: RtpHeader;

  readonly onReceiveRtp = new Event<[RtpPacket]>();

  stopped = false;

  constructor(
    props: Partial<MediaStreamTrack> & Pick<MediaStreamTrack, "kind">
  ) {
    Object.assign(this, props);

    this.onReceiveRtp.subscribe((rtp) => {
      this.header = rtp.header;
    });
  }

  stop() {
    this.stopped = true;
    this.onReceiveRtp.complete();
  }

  writeRtp(rtp: RtpPacket | Buffer) {
    if (this.role === "read") throw new Error("wrong role");
    if (this.stopped) return;

    const packet = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    this.onReceiveRtp.execute(packet);
  }
}
