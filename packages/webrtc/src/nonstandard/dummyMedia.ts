import { RtpHeader, RtpPacket } from "../imports/rtp";
import { MediaStreamTrack } from "../media/track";

const AUDIO_PACKET_MS = 20;
const AUDIO_TIMESTAMP_STEP = 960;
const AUDIO_PAYLOAD = Buffer.from([0xf8, 0xff, 0xfe]);

const DEFAULT_VIDEO_FPS = 30;
const VIDEO_TIMESTAMP_STEP = 3_000;
const DUMMY_SSRC_BASE = 0x1a2b3c00;
const DUMMY_SEQUENCE_BASE = 0x4000;
const DUMMY_SEQUENCE_STEP = 0x0100;
let nextDummySourceId = 0;

const VP8_KEYFRAME = Buffer.from([
  0x10, 0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x02, 0x00, 0x02, 0x00,
]);
const VP8_DELTA_FRAME = Buffer.from([0x10, 0x11, 0x00, 0x00]);

export interface DummyAudioOptions {
  packetIntervalMs: number;
}

export interface DummyVideoOptions {
  fps: number;
  keyframeIntervalFrames: number;
}

export interface DummySource {
  stop(): void;
}

export function createDummyAudioTrack(
  options: Partial<DummyAudioOptions> = {},
): { track: MediaStreamTrack; source: DummySource } {
  const track = new MediaStreamTrack({ kind: "audio" });
  const source = new ScheduledRtpSource({
    track,
    intervalMs: options.packetIntervalMs ?? AUDIO_PACKET_MS,
    buildPacket: ({ sequenceNumber, timestamp, ssrc }) =>
      new RtpPacket(
        new RtpHeader({
          version: 2,
          payloadType: 111,
          sequenceNumber,
          timestamp,
          ssrc,
          marker: true,
        }),
        Buffer.from(AUDIO_PAYLOAD),
      ),
    nextTimestamp: (timestamp) => timestamp + AUDIO_TIMESTAMP_STEP,
  });
  source.start();
  return { track, source };
}

export function createDummyVideoTrack(
  options: Partial<DummyVideoOptions> = {},
): { track: MediaStreamTrack; source: DummySource } {
  const fps = options.fps ?? DEFAULT_VIDEO_FPS;
  const keyframeIntervalFrames = options.keyframeIntervalFrames ?? fps;
  const intervalMs = 1_000 / fps;
  const track = new MediaStreamTrack({ kind: "video" });

  const source = new ScheduledRtpSource({
    track,
    intervalMs,
    buildPacket: ({ sequenceNumber, timestamp, ssrc, iteration }) => {
      const isKeyframe = iteration % keyframeIntervalFrames === 0;
      return new RtpPacket(
        new RtpHeader({
          version: 2,
          payloadType: 96,
          sequenceNumber,
          timestamp,
          ssrc,
          marker: true,
        }),
        Buffer.from(isKeyframe ? VP8_KEYFRAME : VP8_DELTA_FRAME),
      );
    },
    nextTimestamp: (timestamp) => timestamp + VIDEO_TIMESTAMP_STEP,
  });
  source.start();
  return { track, source };
}

class ScheduledRtpSource implements DummySource {
  private readonly sourceId = nextDummySourceId++;
  private readonly ssrc = (DUMMY_SSRC_BASE + this.sourceId) >>> 0;
  private sequenceNumber =
    (DUMMY_SEQUENCE_BASE + this.sourceId * DUMMY_SEQUENCE_STEP) & 0xffff;
  private timestamp = 0;
  private iteration = 0;
  private nextTickAt?: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly props: {
      track: MediaStreamTrack;
      intervalMs: number;
      buildPacket(args: {
        sequenceNumber: number;
        timestamp: number;
        ssrc: number;
        iteration: number;
      }): RtpPacket;
      nextTimestamp(timestamp: number): number;
    },
  ) {}

  start() {
    this.nextTickAt = performance.now();
    this.schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule() {
    if (this.stopped || this.props.track.stopped) {
      this.stop();
      return;
    }

    this.nextTickAt =
      (this.nextTickAt ?? performance.now()) + this.props.intervalMs;
    const delay = Math.max(0, this.nextTickAt - performance.now());
    this.timer = setTimeout(() => {
      if (this.stopped || this.props.track.stopped) {
        this.stop();
        return;
      }

      const packet = this.props.buildPacket({
        sequenceNumber: this.sequenceNumber,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
        iteration: this.iteration,
      });
      this.props.track.writeRtp(packet);

      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      this.timestamp = this.props.nextTimestamp(this.timestamp) >>> 0;
      this.iteration += 1;
      this.schedule();
    }, delay);
  }
}
