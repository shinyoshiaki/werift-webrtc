import Event from "rx.mini";
import { v4 } from "uuid";
import { RtpHeader, RtpPacket } from "../../../rtp/src";
import { Kind } from "../types/domain";

export class MediaStreamTrack {
  role: "read" | "write" = "write";
  id: string = v4();
  kind!: Kind;
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

  stop = () => {
    this.stopped = true;
    this.onReceiveRtp.complete();
  };

  writeRtp = (rtp: RtpPacket | Buffer) => {
    if (this.role === "read") throw new Error("wrong role");
    if (this.stopped) return;

    const packet = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    this.onReceiveRtp.execute(packet);
  };
}
