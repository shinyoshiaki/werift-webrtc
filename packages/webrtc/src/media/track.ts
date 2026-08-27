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

class TrackBroadcastSource {
  private readonly tracks = new Set<MediaStreamTrack>();
  private readonly upstreamStops = new Set<() => void>();

  attach(track: MediaStreamTrack) {
    this.tracks.add(track);
  }

  detach(track: MediaStreamTrack) {
    this.tracks.delete(track);
    if (this.tracks.size > 0) {
      return;
    }
    for (const stop of [...this.upstreamStops]) {
      stop();
    }
    this.upstreamStops.clear();
  }

  addUpstreamStop(stop: () => void) {
    const once = () => {
      this.upstreamStops.delete(once);
      stop();
    };
    this.upstreamStops.add(once);
  }

  deliverRtp(packet: RtpPacket, extensions?: Extensions) {
    const live = [...this.tracks].filter((track) => !track.stopped);
    live.forEach((track, index) => {
      track.applyIncomingRtp(index === 0 ? packet : packet.clone(), extensions);
    });
  }

  deliverRtcp(packet: RtcpPacket) {
    for (const track of this.tracks) {
      if (!track.stopped) {
        track.onReceiveRtcp.execute(packet);
      }
    }
  }

  stopAllTracks() {
    for (const track of [...this.tracks]) {
      track.stop();
    }
  }
}

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

  readonly onReceiveRtp = new Event<[RtpPacket, Extensions?]>();
  readonly onReceiveRtcp = new Event<[RtcpPacket]>();
  readonly onSourceChanged = new Event<
    [Pick<RtpHeader, "sequenceNumber" | "timestamp">]
  >();

  stopped = false;
  muted = true;
  private broadcastSource: TrackBroadcastSource;

  constructor(
    props: Partial<MediaStreamTrack> &
      Pick<MediaStreamTrack, "kind"> & {
        broadcastSource?: TrackBroadcastSource;
      },
  ) {
    super();
    const sharedSource = props.broadcastSource;
    Object.assign(this, props);
    this.id ??= this.uuid;
    this.broadcastSource = sharedSource ?? new TrackBroadcastSource();
    if (!this.stopped) {
      this.broadcastSource.attach(this);
    }

    this.onReceiveRtp.subscribe((rtp) => {
      this.muted = false;
      this.header = rtp.header;
    });

    this.label = `${this.remote ? "remote" : "local"} ${this.kind}`;
  }

  get readyState(): "live" | "ended" {
    return this.stopped ? "ended" : "live";
  }

  stop = () => {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.muted = true;
    this.onReceiveRtp.complete();
    this.emit("ended");
    this.broadcastSource.detach(this);
  };

  writeRtp = (rtp: RtpPacket | Buffer) => {
    if (this.remote) {
      throw new Error("this is remoteTrack");
    }

    const packet = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;
    packet.header.payloadType =
      this.codec?.payloadType ?? packet.header.payloadType;
    this.broadcastSource.deliverRtp(packet);
  };

  writeRtcp = (rtcp: RtcpPacket) => {
    this.broadcastSource.deliverRtcp(rtcp);
  };

  applyIncomingRtp(packet: RtpPacket, extensions?: Extensions) {
    if (this.stopped) {
      return;
    }
    this.onReceiveRtp.execute(packet, extensions);
  }

  bindUpstreamStop(stop: () => void) {
    this.broadcastSource.addUpstreamStop(stop);
  }

  stopMediaSource() {
    this.broadcastSource.stopAllTracks();
  }

  clone(): MediaStreamTrack {
    return new MediaStreamTrack({
      kind: this.kind,
      remote: this.remote,
      enabled: this.enabled,
      muted: this.muted,
      stopped: this.stopped,
      codec: this.codec,
      ssrc: this.ssrc,
      rid: this.rid,
      header: this.header,
      broadcastSource: this.broadcastSource,
    });
  }
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

  getTrackById(id: string) {
    return this.tracks.find((track) => track.id === id);
  }

  get active() {
    return this.tracks.some((track) => !track.stopped);
  }

  clone() {
    const cloned = new MediaStream();
    for (const track of this.tracks) {
      cloned.addTrack(track.clone());
    }
    return cloned;
  }
}
