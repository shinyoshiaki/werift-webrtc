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

  readonly _onWriteRtp = new Event<[RtpPacket | Buffer]>();
  readonly onRtp = new Event<[RtpPacket]>();
  readonly stop: () => void;

  constructor(
    props: Partial<MediaStreamTrack> & Pick<MediaStreamTrack, "kind">
  ) {
    Object.assign(this, props);

    const { unSubscribe } = this.onRtp.subscribe((rtp) => {
      this.header = rtp.header;
      this._onWriteRtp.execute(rtp);
    });
    this.stop = unSubscribe;
  }

  writeRtp(rtp: RtpPacket | Buffer) {
    this._onWriteRtp.execute(rtp);
  }
}
