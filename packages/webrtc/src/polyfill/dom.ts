import {
  MediaStream as WeriftMediaStream,
  MediaStreamTrack as WeriftMediaStreamTrack,
} from "../media/track";

export * from "./api";

/** The werift-specific members the polyfill adds to the DOM `MediaStreamTrack`. */
export type WeriftMediaStreamTrackExtensions = Pick<
  WeriftMediaStreamTrack,
  "writeRtp" | "writeRtcp" | "onReceiveRtp" | "onReceiveRtcp"
>;

declare global {
  // The members are derived from werift's class so that the augmentation and
  // the implementation cannot drift apart.
  interface MediaStreamTrack extends WeriftMediaStreamTrackExtensions {}
}

/** The argument of {@link MediaStreamTrack}: `kind` plus optional track fields. */
export type MediaStreamTrackInit = ConstructorParameters<
  typeof WeriftMediaStreamTrack
>[0];

/**
 * werift's `MediaStreamTrack` class typed as a constructor of the DOM
 * `MediaStreamTrack`. `lib.dom` declares the global constructor without
 * arguments (`new MediaStreamTrack({ kind })` is TS2554), so import this one
 * to create a track and pass it to DOM-typed APIs such as `mediasoup-client`.
 * It is the same class as `MediaStreamTrack` of `werift`.
 */
export const MediaStreamTrack: new (
  init: MediaStreamTrackInit,
) => globalThis.MediaStreamTrack = WeriftMediaStreamTrack;

/** The argument of {@link MediaStream}: tracks, or optional stream fields. */
export type MediaStreamInit = ConstructorParameters<
  typeof WeriftMediaStream
>[0];

/**
 * werift's `MediaStream` class typed as a constructor of the DOM
 * `MediaStream`. It is the same class as `MediaStream` of `werift`.
 */
export const MediaStream: new (
  init?: MediaStreamInit,
) => globalThis.MediaStream = WeriftMediaStream;
