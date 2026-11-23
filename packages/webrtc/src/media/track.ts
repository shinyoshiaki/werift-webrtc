import { randomUUID } from "crypto";
import { OverconstrainedError } from "../errors";
import { EventTarget } from "../helper";
import { Event } from "../imports/common";
import {
  type Extensions,
  type RtcpPacket,
  type RtpHeader,
  RtpPacket,
} from "../imports/rtp";
import type { Kind } from "../types/domain";
import type { RTCRtpCodecParameters } from "./parameters";
import {
  constraintFitnessDistance,
  findFailedRequiredConstraint,
  stripUnsupportedConstraints,
  type WeriftMediaTrackCapabilities,
  type WeriftMediaTrackConstraints,
  type WeriftMediaTrackSettings,
} from "./trackConstraints";

/**
 * The event object passed to the `on*` handlers of {@link MediaStreamTrack}
 * and {@link MediaStream}. It is structural so that a DOM `Event` (and a DOM
 * `MediaStreamTrackEvent`) is assignable to it and a werift handler can be
 * typed by the DOM `onended` / `onaddtrack` types.
 */
export interface WeriftEventLike {
  readonly type: string;
}

/** An `on*` event handler attribute of {@link MediaStreamTrack} / {@link MediaStream}. */
export type WeriftEventHandler<E = WeriftEventLike> = ((ev: E) => any) | null;

/**
 * Set the settings and the applied constraints of a track created by a media
 * source (the polyfill's `getUserMedia`).
 * @internal
 */
export function setTrackMediaSettings(
  track: MediaStreamTrack,
  settings: WeriftMediaTrackSettings,
  /** Unknown constraint names are dropped. */
  constraints: object,
) {
  track.sourceSettings = { ...settings };
  track.appliedConstraints = stripUnsupportedConstraints(
    constraints as { [key: string]: unknown },
  );
}

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

export function setTrackSourceCodecs(
  track: MediaStreamTrack,
  codecs: readonly RTCRtpCodecParameters[] | undefined,
) {
  track.sourceCodecsCaptured = true;
  track.sourceCodecs = codecs;
}

export function getTrackSourceCodecs(
  track: MediaStreamTrack | undefined | null,
) {
  return track?.sourceCodecs;
}

export function captureTrackSourceCodecs(track: MediaStreamTrack) {
  if (track.sourceCodecsCaptured) return;
  track.sourceCodecsCaptured = true;
  if (track.codec != undefined) {
    track.sourceCodecs = [track.codec];
  }
}

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
    for (const track of live) {
      track.applyIncomingRtp(packet.clone(), extensions);
    }
  }

  deliverRtcp(packet: RtcpPacket) {
    for (const track of this.tracks) {
      if (!track.stopped) {
        track.onReceiveRtcp.execute(packet);
      }
    }
  }

  deliverSourceChanged(
    header: Pick<RtpHeader, "sequenceNumber" | "timestamp">,
  ) {
    for (const track of this.tracks) {
      if (!track.stopped) {
        track.onSourceChanged.execute(header);
      }
    }
  }

  stopAllTracks() {
    for (const track of [...this.tracks]) {
      track.stop();
    }
  }
}

/**
 * `K` narrows {@link kind} (`new MediaStreamTrack({ kind: "audio" })` is a
 * `MediaStreamTrack<"audio">`), so that an audio track is assignable to typings
 * that specialize the DOM track by kind (such as `MediaStreamAudioTrack` of
 * `@types/dom-mediacapture-transform`).
 */
export class MediaStreamTrack<K extends Kind = Kind> extends EventTarget {
  readonly uuid = randomUUID().toString();
  /**MediaStream ID*/
  streamId?: string;
  remote = false;
  label: string;
  kind!: K;
  /** Track ID. Defaults to {@link uuid} when not given to the constructor. */
  id!: string;
  /**mediaSsrc */
  ssrc?: number;
  rid?: string;
  header?: RtpHeader;
  codec?: RTCRtpCodecParameters;
  /**todo impl */
  enabled = true;
  /** DOM `contentHint`. Stored only; werift does not change encoding by it. */
  contentHint = "";
  /**
   * DOM `onended`. Called right after the `"ended"` listeners of
   * `addEventListener`, every time `"ended"` is emitted. Unlike the DOM,
   * werift also emits `"ended"` when {@link stop} is called.
   */
  onended: WeriftEventHandler = null;
  /**
   * DOM `onmute`. werift does not detect a muted source, so `"mute"` is never
   * emitted and this handler is never called.
   */
  onmute: WeriftEventHandler = null;
  /**
   * DOM `onunmute`. werift changes {@link muted} on the first received media
   * packet without emitting `"unmute"`, so this handler is never called.
   */
  onunmute: WeriftEventHandler = null;

  readonly onReceiveRtp = new Event<
    [RtpPacket, Extensions?, RtpReceiveInfo?]
  >();
  readonly onReceiveRtcp = new Event<[RtcpPacket]>();
  readonly onSourceChanged = new Event<
    [Pick<RtpHeader, "sequenceNumber" | "timestamp">]
  >();

  stopped = false;
  muted = true;
  /**
   * @internal The codecs the source produces, set by
   * {@link setTrackSourceCodecs} or captured from `codec` when the track is
   * first attached to a sender ({@link captureTrackSourceCodecs}).
   */
  sourceCodecs?: readonly RTCRtpCodecParameters[];
  /** @internal Whether {@link sourceCodecs} is already decided. */
  sourceCodecsCaptured = false;
  /**
   * @internal The settings the media source reported
   * ({@link setTrackMediaSettings}); `undefined` for a track werift created
   * without a media source.
   */
  sourceSettings?: WeriftMediaTrackSettings;
  /** @internal The constraints most recently applied to this track. */
  appliedConstraints: WeriftMediaTrackConstraints = {};
  private broadcastSource: TrackBroadcastSource;

  constructor(
    props: Partial<MediaStreamTrack<K>> &
      Pick<MediaStreamTrack<K>, "kind"> & {
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

  override emit(type: string | symbol, ...args: any[]): boolean {
    if (type !== "ended") {
      return super.emit(type, ...args);
    }
    // onended も addEventListener("ended") と同じ Event を受け取る。
    const [event = new globalThis.Event("ended"), ...rest] = args;
    const listened = super.emit(type, event, ...rest);
    if (this.onended) {
      this.onended.call(this, event);
      return true;
    }
    return listened;
  }

  /**
   * DOM `getSettings()`. A track from the polyfill's `getUserMedia` reports
   * the `deviceId` / `groupId` / `mimeType` its media register was selected
   * by; another track reports what its {@link codec} tells (`mimeType`, and
   * `sampleRate` / `channelCount` for audio).
   */
  getSettings(): WeriftMediaTrackSettings {
    if (this.sourceSettings) {
      return { ...this.sourceSettings };
    }
    const settings: WeriftMediaTrackSettings = {};
    if (this.codec) {
      settings.mimeType = this.codec.mimeType;
      if (this.kind === "audio") {
        settings.sampleRate = this.codec.clockRate;
        if (this.codec.channels != undefined) {
          settings.channelCount = this.codec.channels;
        }
      }
    }
    return settings;
  }

  /**
   * DOM `getConstraints()`: the constraints most recently applied by
   * `getUserMedia` or {@link applyConstraints}, limited to the constraints
   * werift understands (`deviceId`, `groupId`, `mimeType`).
   */
  getConstraints(): WeriftMediaTrackConstraints {
    return structuredClone(this.appliedConstraints);
  }

  /**
   * DOM `getCapabilities()`. werift cannot reconfigure a source, so the only
   * capabilities are the `deviceId` / `groupId` it was selected by.
   */
  getCapabilities(): WeriftMediaTrackCapabilities {
    const capabilities: WeriftMediaTrackCapabilities = {};
    const { deviceId, groupId } = this.getSettings();
    if (deviceId != undefined) {
      capabilities.deviceId = deviceId;
    }
    if (groupId != undefined) {
      capabilities.groupId = groupId;
    }
    return capabilities;
  }

  /**
   * DOM `applyConstraints()`. werift cannot reconfigure a source, so the
   * current settings are the only possible settings: a required (`exact`)
   * constraint they do not satisfy rejects with `OverconstrainedError` and
   * keeps the previous constraints; otherwise the constraints are stored
   * (see {@link getConstraints}) and the settings stay the same. Unknown
   * constraint names are ignored.
   */
  async applyConstraints(
    constraints: WeriftMediaTrackConstraints = {},
  ): Promise<void> {
    const next = stripUnsupportedConstraints(
      constraints as { [key: string]: unknown },
    );
    const { advanced: _advanced, ...basic } = next;
    const settings = this.getSettings();
    if (
      constraintFitnessDistance(settings, basic, "ideal") ===
      Number.POSITIVE_INFINITY
    ) {
      throw new OverconstrainedError(
        findFailedRequiredConstraint([settings], basic) ?? "",
        "Cannot satisfy required constraints",
      );
    }
    this.appliedConstraints = next;
  }

  writeRtp = (rtp: RtpPacket | Buffer) => {
    if (this.remote) {
      throw new Error("this is remoteTrack");
    }

    const packet = Buffer.isBuffer(rtp)
      ? RtpPacket.deSerialize(rtp)
      : rtp.clone();
    packet.header.payloadType =
      this.codec?.payloadType ?? packet.header.payloadType;
    this.broadcastSource.deliverRtp(packet);
  };

  writeRtcp = (rtcp: RtcpPacket) => {
    this.broadcastSource.deliverRtcp(rtcp);
  };

  /**
   * Tell the senders of this track that the RTP written with {@link writeRtp}
   * now comes from another source (for example a recreated upstream
   * connection). Each `RTCRtpSender` continues its output sequence number /
   * timestamp from the last sent packet (timestamp step 1; use
   * `RTCRtpSender.replaceRTP` to choose the step) and drops queued packets of
   * the old source. `header` is kept for compatibility and is not used for the
   * offsets. Without an `RTCRtpSender`, use `RtpTimelineRewriter`.
   */
  notifySourceChanged(header: Pick<RtpHeader, "sequenceNumber" | "timestamp">) {
    this.broadcastSource.deliverSourceChanged(header);
  }

  applyIncomingRtp(
    packet: RtpPacket,
    extensions?: Extensions,
    info?: RtpReceiveInfo,
  ) {
    if (this.stopped) {
      return;
    }
    this.onReceiveRtp.execute(packet, extensions, info);
  }

  bindUpstreamStop(stop: () => void) {
    this.broadcastSource.addUpstreamStop(stop);
  }

  stopMediaSource() {
    this.broadcastSource.stopAllTracks();
  }

  clone(): MediaStreamTrack<K> {
    const cloned = new MediaStreamTrack<K>({
      kind: this.kind,
      remote: this.remote,
      enabled: this.enabled,
      muted: this.muted,
      stopped: this.stopped,
      codec: this.codec,
      ssrc: this.ssrc,
      rid: this.rid,
      header: this.header,
      contentHint: this.contentHint,
      broadcastSource: this.broadcastSource,
    });
    // DOM の clone と同じく settings と constraints を引き継ぐ。
    if (this.sourceSettings) {
      cloned.sourceSettings = { ...this.sourceSettings };
    }
    cloned.appliedConstraints = structuredClone(this.appliedConstraints);
    if (this.sourceCodecsCaptured) {
      setTrackSourceCodecs(cloned, this.sourceCodecs);
    } else {
      captureTrackSourceCodecs(cloned);
    }
    return cloned;
  }
}

export class MediaStream extends EventTarget {
  id!: string;
  tracks: MediaStreamTrack[] = [];
  /**
   * DOM `onaddtrack`. The DOM fires `"addtrack"` only when the user agent adds
   * a track; werift never does, and {@link addTrack} does not fire it either,
   * so this handler is never called.
   */
  onaddtrack: WeriftEventHandler = null;
  /** DOM `onremovetrack`. Never called, for the same reason as {@link onaddtrack}. */
  onremovetrack: WeriftEventHandler = null;

  constructor(props: Partial<MediaStream> | MediaStreamTrack[] = {}) {
    super();
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

  getAudioTracks(): MediaStreamTrack<"audio">[] {
    return this.tracks.filter(
      (track): track is MediaStreamTrack<"audio"> => track.kind === "audio",
    );
  }

  getVideoTracks(): MediaStreamTrack<"video">[] {
    return this.tracks.filter(
      (track): track is MediaStreamTrack<"video"> => track.kind === "video",
    );
  }

  getTrackById(id: string): MediaStreamTrack | null {
    return this.tracks.find((track) => track.id === id) ?? null;
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
