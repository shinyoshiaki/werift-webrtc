import { randomUUID } from "crypto";
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

/**
 * How an RTP packet is classified at the moment it is delivered on
 * {@link MediaStreamTrack.onReceiveRtp}.
 *
 * - `media`: normal media (including RED-recovered audio blocks)
 * - `padding`: RFC 3550 padding-only (e.g. GCC probe). Payload is empty after
 *   deserialize; do not decode. TWCC/NACK still observed it.
 * - `retransmission`: RTX unwrapped onto the original media SSRC
 */
export const RtpReceivePacketType = {
  media: "media",
  padding: "padding",
  retransmission: "retransmission",
} as const;
export type RtpReceivePacketType =
  (typeof RtpReceivePacketType)[keyof typeof RtpReceivePacketType];

export type RtpReceiveInfo = {
  type: RtpReceivePacketType;
};

export class MediaStreamTrack extends EventTarget {
  readonly uuid = randomUUID().toString();
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

  /**
   * RTP packets delivered to this track.
   *
   * Arguments:
   * 1. `RtpPacket` — canonical form (`payload` is media only; padding-only probes have `payload.length === 0`)
   * 2. `Extensions` — parsed header extensions when present
   * 3. `RtpReceiveInfo` — packet kind (`media` / `padding` / `retransmission`).
   *    Receiver and {@link writeRtp} always pass this; the type is optional so
   *    existing 1- and 2-argument subscribers keep compiling.
   *
   * Padding-only packets (GCC `maybeInjectProbePadding`) are still received so
   * TWCC can ACK them, but they must not be decoded. Unmute happens only for
   * `media` and `retransmission`.
   */
  readonly onReceiveRtp = new Event<
    [RtpPacket, Extensions?, RtpReceiveInfo?]
  >();
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

    this.onReceiveRtp.subscribe((rtp, _extensions, info) => {
      this.header = rtp.header;
      if (
        info?.type === RtpReceivePacketType.media ||
        info?.type === RtpReceivePacketType.retransmission ||
        info?.type === undefined
      ) {
        this.muted = false;
      }
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
    this.onReceiveRtp.execute(packet, undefined, {
      type: RtpReceivePacketType.media,
    });
  };
}

export class MediaStream {
  id!: string;
  tracks: MediaStreamTrack[] = [];

  constructor(props: Partial<MediaStream> | MediaStreamTrack[] = {}) {
    if (Array.isArray(props)) {
      this.tracks = props;
    } else {
      Object.assign(this, props);
    }
    this.id ??= randomUUID().toString();
  }

  addTrack(track: MediaStreamTrack) {
    track.streamId = this.id;
    this.tracks.push(track);
  }

  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((currentTrack) => currentTrack !== track);
    if (track.streamId === this.id) {
      track.streamId = undefined;
    }
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
