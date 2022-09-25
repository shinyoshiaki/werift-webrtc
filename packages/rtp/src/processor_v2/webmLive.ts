import {
  ReadableStream,
  ReadableStreamController,
  WritableStream,
} from "stream/web";

import { int, PromiseQueue } from "..";
import { SupportedCodec, WEBMBuilder } from "../container/webm";
import { DepacketizerOutput } from "./depacketizer";

export type WebmLiveInput = DepacketizerOutput;

export type WebmLiveOutput = {
  packet: Buffer;
};

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
    }[]
  ) {
    this.builder = new WEBMBuilder(tracks);

    tracks.forEach((t) => {
      this.timestamps[t.trackNumber] = new ClusterTimestamp(t.clockRate);
    });

    const createStream = (trackNumber: number) =>
      new WritableStream({
        write: (input: WebmLiveInput) => {
          if (this.stopped) return;
          this.queue.push(() =>
            this.onFrameReceived({ ...input.frame, trackNumber })
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
      this.builder.createSegment(),
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
      if (elapsed === 0) {
        elapsed = 1000;
      }
      this.relativeTimestamp += elapsed;

      const cluster = this.builder.createCluster(this.relativeTimestamp);
      this.controller.enqueue({ packet: Buffer.from(cluster) });
      this.cuePoints.push(
        new CuePoint(
          this.builder,
          track.trackNumber,
          this.relativeTimestamp,
          this.position
        )
      );
      this.position += cluster.length;
      Object.values(this.timestamps).forEach((t) => t.reset());
      elapsed = 0;
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

  async stop() {
    this.stopped = true;

    const cues = this.builder.createCues(this.cuePoints.map((c) => c.build()));
    this.controller.enqueue({ packet: Buffer.from(cues) });
    this.controller.close();
  }
}

class ClusterTimestamp {
  baseTimestamp?: number;

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
      console.log("rotate");
    }

    const elapsed = rotate
      ? timestamp + Max32Uint - this.baseTimestamp
      : timestamp - this.baseTimestamp;

    const elapsedNs = int((elapsed / this.clockRate) * 1000);
    return elapsedNs;
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
