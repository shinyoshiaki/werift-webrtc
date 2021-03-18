import Event from "rx.mini";
import { RtpHeader, RtpPacket } from "../../../rtp/src";
import { Kind } from "../typings/domain";

export class MediaStreamTrack {
  role: "read" | "write" = "write";
  kind!: Kind;
  id?: string;
  ssrc?: number;
  rid?: string;
  //---------------
  cacheHeader?: RtpHeader;

  readonly _onWriteRtp = new Event<[RtpPacket | Buffer]>();
  readonly onRtp = new Event<[RtpPacket]>();

  constructor(
    props: Partial<MediaStreamTrack> & Pick<MediaStreamTrack, "kind">
  ) {
    Object.assign(this, props);

    this.onRtp.subscribe((rtp) => {
      this.cacheHeader = rtp.header;
      this._onWriteRtp.execute(rtp);
    });
  }

  writeRtp(rtp: RtpPacket | Buffer) {
    this._onWriteRtp.execute(rtp);
  }
}
