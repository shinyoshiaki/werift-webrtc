import { v4 } from "uuid";
import { Event } from "../imports/common";

import { EventTarget } from "../helper";
import {
  type Extensions,
  type RtcpPacket,
  type RtpHeader,
  RtpPacket,
} from "../imports/rtp";
import type { Kind } from "../types/domain";
import type { RTCRtpCodecParameters } from "./parameters";

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

  readonly onReceiveRtp = new Event<[RtpPacket, Extensions?]>();
  readonly onReceiveRtcp = new Event<[RtcpPacket]>();
  readonly onSourceChanged = new Event<
    [Pick<RtpHeader, "sequenceNumber" | "timestamp">]
  >();

  stopped = false;
  muted = true;

  constructor(
    props: Partial<MediaStreamTrack> & Pick<MediaStreamTrack, "kind">,
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
    this.emit("ended");
  };

  writeRtp = (rtp: RtpPacket | Buffer) => {
    if (this.remote) {
      throw new Error("this is remoteTrack");
    }
    if (this.stopped) {
      return;
    }

    const packet = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;
    packet.header.payloadType =
      this.codec?.payloadType ?? packet.header.payloadType;
    this.onReceiveRtp.execute(packet);
  };
}

export class MediaStream {
  id!: string;
  tracks: MediaStreamTrack[] = [];

  constructor(props: Partial<MediaStream> | MediaStreamTrack[]) {
    if (Array.isArray(props)) {
      this.tracks = props;
    } else {
      Object.assign(this, props);
    }
    this.id ??= v4();
  }

  addTrack(track: MediaStreamTrack) {
    track.streamId = this.id;
    this.tracks.push(track);
  }

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
}
