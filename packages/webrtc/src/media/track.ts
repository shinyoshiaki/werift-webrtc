import Event from "rx.mini";
import { v4 } from "uuid";

import { RtcpPacket, RtpHeader, RtpPacket } from "../../../rtp/src";
import { EventTarget } from "../helper";
import { Kind } from "../types/domain";
import { RTCRtpCodecParameters } from "./parameters";

export class MediaStreamTrack extends EventTarget {
  readonly uuid = v4();
  /**MediaStream ID*/
  streamId?: string;
  remote = false;
  label: string;
  kind!: Kind;
  id?: string;
  /**mediaSsrc */
  ssrc?: number;
  rid?: string;
  header?: RtpHeader;
  codec?: RTCRtpCodecParameters;
  /**todo impl */
  enabled = true;

  readonly onReceiveRtp = new Event<
    [RtpPacket, { isRed?: boolean; isUlpFex?: boolean }]
  >();
  readonly onReceiveRtcp = new Event<[RtcpPacket]>();
  readonly onSourceChanged = new Event<
    [Pick<RtpHeader, "sequenceNumber" | "timestamp">]
  >();

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
    if (this.remote) {
      throw new Error("this is remoteTrack");
    }
    if (!this.codec || this.stopped) {
      return;
    }

    const packet = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;
    packet.header.payloadType = this.codec.payloadType;
    this.onReceiveRtp.execute(packet, {});
  };
}

export class MediaStream {
  id!: string;
  tracks: MediaStreamTrack[] = [];

  constructor(props: Partial<MediaStream> & Pick<MediaStream, "id">) {
    Object.assign(this, props);
  }

  addTrack(track: MediaStreamTrack) {
    track.streamId = this.id;
    this.tracks.push(track);
  }

  getTracks() {
    return this.tracks;
  }
}
