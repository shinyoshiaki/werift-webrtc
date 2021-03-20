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
  private readonly stopRtp: () => void;

  stopped = false;

  constructor(
    props: Partial<MediaStreamTrack> & Pick<MediaStreamTrack, "kind">
  ) {
    Object.assign(this, props);

    const { unSubscribe } = this.onRtp.subscribe((rtp) => {
      this.header = rtp.header;
      this._onWriteRtp.execute(rtp);
    });
    this.stopRtp = unSubscribe;
  }

  stop() {
    this.stopped = true;
    this.stopRtp();
  }

  writeRtp(rtp: RtpPacket | Buffer) {
    if (this.stopped) return;
    this._onWriteRtp.execute(rtp);
  }
}
