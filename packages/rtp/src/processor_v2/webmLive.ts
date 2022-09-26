import debug from "debug";
import {
  ReadableStream,
  ReadableStreamController,
  WritableStream,
} from "stream/web";

import { int, PromiseQueue } from "..";
import { SupportedCodec, WEBMBuilder } from "../container/webm";
import { DepacketizerOutput } from "./depacketizer";

const sourcePath = `werift-rtp : packages/rtp/src/processor_v2/webmLive.ts`;
const log = debug(sourcePath);

export type WebmLiveInput = DepacketizerOutput;

export type WebmLiveOutput = {
  packet?: Buffer;
  eol?: {
    /**ms */
    duration: number;
    durationElement: Uint8Array;
  };
};

export interface WebmLiveOption {
  /**ms */
  duration?: number;
}

export class WebmLiveSink {
  private builder: WEBMBuilder;
  private queue = new PromiseQueue();
  private relativeTimestamp = 0;
  private timestamps: { [pt: number]: ClusterTimestamp } = {};
  private cuePoints: CuePoint[] = [];
  private position = 0;
  stopped = false;
  audioStream!: WritableStream<WebmLiveInput>;
  videoStream!: WritableStream<WebmLiveInput>;
  webmStream: ReadableStream<WebmLiveOutput>;
  private controller!: ReadableStreamController<WebmLiveOutput>;

  constructor(
    public tracks: {
      width?: number;
      height?: number;
      kind: "audio" | "video";
      codec: SupportedCodec;
      clockRate: number;
      trackNumber: number;
    }[],
    private options: WebmLiveOption = {}
  ) {
    this.builder = new WEBMBuilder(tracks);

    tracks.forEach((t) => {
      this.timestamps[t.trackNumber] = new ClusterTimestamp(t.clockRate);
    });

    const createStream = (trackNumber: number) =>
      new WritableStream({
        write: ({ frame, eol }: WebmLiveInput) => {
          if (this.stopped) return;
          if (!frame) {
            if (eol) {
              this.stop();
            }
            return;
          }

          this.queue.push(() =>
            this.onFrameReceived({ ...frame, trackNumber })
          );
        },
      });

    const audioTrack = tracks.find((t) => t.kind === "audio");
    if (audioTrack) {
      this.audioStream = createStream(audioTrack.trackNumber);
    }

    const videoTrack = tracks.find((t) => t.kind === "video");
    if (videoTrack) {
      this.videoStream = createStream(videoTrack.trackNumber);
    }

    this.webmStream = new ReadableStream<WebmLiveOutput>({
      start: (controller) => {
        this.controller = controller;
      },
    });

    this.queue.push(() => this.init());
  }

  private async init() {
    const staticPart = Buffer.concat([
      this.builder.ebmlHeader,
      this.builder.createSegment(this.options.duration),
    ]);
    this.controller.enqueue({ packet: staticPart });
    this.position += staticPart.length;

    const video = this.tracks.find((t) => t.kind === "video");
    if (video) {
      this.cuePoints.push(
        new CuePoint(this.builder, video.trackNumber, 0.0, this.position)
      );
    }
  }

  private async onFrameReceived(
    frame: WebmLiveInput["frame"] & { trackNumber: number }
  ) {
    const track = this.tracks.find((t) => t.trackNumber === frame.trackNumber);
    if (!track) {
      return;
    }

    const timestampManager = this.timestamps[track.trackNumber];
    let elapsed = timestampManager.update(frame.timestamp);

    if (
      (track.kind === "video" && frame.isKeyframe) ||
      elapsed > MaxSinged16Int
    ) {
      this.relativeTimestamp += elapsed;

      const cluster = this.builder.createCluster(this.relativeTimestamp);
      this.controller.enqueue({ packet: Buffer.from(cluster) });

      if (elapsed !== 0) {
        this.cuePoints.push(
          new CuePoint(
            this.builder,
            track.trackNumber,
            this.relativeTimestamp,
            this.position
          )
        );
      }
      this.position += cluster.length;
      Object.values(this.timestamps).forEach((t) => t.reset());
      elapsed = timestampManager.update(frame.timestamp);
    }

    const block = this.builder.createSimpleBlock(
      frame.data,
      frame.isKeyframe,
      track.trackNumber,
      elapsed
    );
    this.controller.enqueue({ packet: block });
    this.position += block.length;
    const [cuePoint] = this.cuePoints.slice(-1);
    if (cuePoint) {
      cuePoint.blockNumber++;
    }
  }

  private async stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    log("stop");

    const cues = this.builder.createCues(this.cuePoints.map((c) => c.build()));
    this.controller.enqueue({ packet: Buffer.from(cues) });

    const latestTimestamp = Object.values(this.timestamps).sort(
      (a, b) => a.elapsed - b.elapsed
    )[0].elapsed;
    const duration = this.relativeTimestamp + latestTimestamp;
    const durationElement = this.builder.createDuration(duration);
    this.controller.enqueue({ eol: { duration, durationElement } });

    this.controller.close();
  }
}

class ClusterTimestamp {
  baseTimestamp?: number;
  elapsed = 0;

  constructor(public clockRate: number) {}

  reset() {
    this.baseTimestamp = undefined;
  }

  update(timestamp: number) {
    if (this.baseTimestamp == undefined) {
      this.baseTimestamp = timestamp;
    }
    const rotate =
      Math.abs(timestamp - this.baseTimestamp) > (Max32Uint / 4) * 3;

    if (rotate) {
      log("rotate", { baseTimestamp: this.baseTimestamp, timestamp });
    }

    const elapsed = rotate
      ? timestamp + Max32Uint - this.baseTimestamp
      : timestamp - this.baseTimestamp;

    this.elapsed = int((elapsed / this.clockRate) * 1000);
    return this.elapsed;
  }
}

class CuePoint {
  /**
   * cuesの後のclusterのあるべき位置
   * cuesはclusterの前に挿入される
   */
  cuesLength = 0;
  blockNumber = 0;

  constructor(
    private readonly builder: WEBMBuilder,
    private readonly trackNumber: number,
    private readonly relativeTimestamp: number,
    public position: number
  ) {}

  build() {
    return this.builder.createCuePoint(
      this.relativeTimestamp,
      this.trackNumber,
      this.position - 48 + this.cuesLength,
      this.blockNumber
    );
  }
}

/**4294967295 */
const Max32Uint = Number(0x01n << 32n) - 1;
/**32767 */
const MaxSinged16Int = (0x01 << 16) / 2 - 1;
