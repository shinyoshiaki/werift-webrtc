import debug from "debug";

import { int } from "..";
import {
  getEBMLByteLength,
  numberToByteArray,
  vintEncode,
} from "../container/ebml";
import { SupportedCodec, WEBMBuilder } from "../container/webm";
import { DepacketizerOutput } from "./depacketizer";

const sourcePath = `werift-rtp : packages/rtp/src/processor_v2/webmLive.ts`;
const log = debug(sourcePath);

export type WebmInput = DepacketizerOutput;

export type WebmOutput = {
  saveToFile?: Buffer;
  eol?: {
    /**ms */
    duration: number;
    durationElement: Uint8Array;
  };
};

export interface WebmOption {
  /**ms */
  duration?: number;
  encryptionKey?: Buffer;
  strictTimestamp?: boolean;
}

export class WebmBase {
  private builder: WEBMBuilder;
  private relativeTimestamp = 0;
  private timestamps: { [pt: number]: ClusterTimestamp } = {};
  private cuePoints: CuePoint[] = [];
  private position = 0;
  private clusterCounts = 0;
  stopped = false;
  elapsed?: number;

  constructor(
    public tracks: {
      width?: number;
      height?: number;
      kind: "audio" | "video";
      codec: SupportedCodec;
      clockRate: number;
      trackNumber: number;
    }[],
    private output: (output: WebmOutput) => void,
    private options: WebmOption = {}
  ) {
    this.builder = new WEBMBuilder(tracks, options.encryptionKey);

    tracks.forEach((t) => {
      this.timestamps[t.trackNumber] = new ClusterTimestamp(t.clockRate);
    });
  }

  private processInput(input: WebmInput, trackNumber: number) {
    if (this.stopped) return;
    if (!input.frame) {
      if (input.eol) {
        this.stop();
      }
      return;
    }

    this.onFrameReceived({ ...input.frame, trackNumber });
  }

  processAudioInput(input: WebmInput) {
    const track = this.tracks.find((t) => t.kind === "audio");
    if (track) {
      this.processInput(input, track.trackNumber);
    }
  }

  processVideoInput(input: WebmInput) {
    const track = this.tracks.find((t) => t.kind === "video");
    if (track) {
      this.processInput(input, track.trackNumber);
    }
  }

  start() {
    const staticPart = Buffer.concat([
      this.builder.ebmlHeader,
      this.builder.createSegment(this.options.duration),
    ]);
    this.output({ saveToFile: staticPart });
    this.position += staticPart.length;

    const video = this.tracks.find((t) => t.kind === "video");
    if (video) {
      this.cuePoints.push(
        new CuePoint(this.builder, video.trackNumber, 0.0, this.position)
      );
    }
  }

  private onFrameReceived(frame: WebmInput["frame"] & { trackNumber: number }) {
    const track = this.tracks.find((t) => t.trackNumber === frame.trackNumber);
    if (!track) {
      return;
    }

    const timestampManager = this.timestamps[track.trackNumber];
    let elapsed = timestampManager.update(frame.timestamp);

    if (this.clusterCounts === 0) {
      this.createCluster(0.0);
    } else if (
      (track.kind === "video" && frame.isKeyframe) ||
      elapsed > MaxSinged16Int
    ) {
      this.relativeTimestamp += elapsed;

      if (elapsed !== 0) {
        this.cuePoints.push(
          new CuePoint(
            this.builder,
            track.trackNumber,
            this.relativeTimestamp,
            this.position
          )
        );

        this.createCluster(this.relativeTimestamp);
        Object.values(this.timestamps).forEach((t) => t.reset());
        elapsed = timestampManager.update(frame.timestamp);
      }
    }

    this.createSimpleBlock({ frame, trackNumber: track.trackNumber, elapsed });
  }

  private createCluster(timestamp: number) {
    const cluster = this.builder.createCluster(timestamp);
    this.clusterCounts++;
    this.output({ saveToFile: Buffer.from(cluster) });
    this.position += cluster.length;
    this.elapsed = undefined;
  }

  private createSimpleBlock({
    frame,
    trackNumber,
    elapsed,
  }: {
    frame: NonNullable<WebmInput["frame"]>;
    trackNumber: number;
    elapsed: number;
  }) {
    if (this.elapsed == undefined) {
      this.elapsed = elapsed;
    }
    if (elapsed < this.elapsed && this.options.strictTimestamp) {
      log("previous timestamp", {
        elapsed,
        present: this.elapsed,
        trackNumber,
      });
      return;
    }
    this.elapsed = elapsed;

    const block = this.builder.createSimpleBlock(
      frame.data,
      frame.isKeyframe,
      trackNumber,
      elapsed
    );
    this.output({ saveToFile: block });
    this.position += block.length;
    const [cuePoint] = this.cuePoints.slice(-1);
    if (cuePoint) {
      cuePoint.blockNumber++;
    }
  }

  private stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    log("stop");

    const cues = this.builder.createCues(this.cuePoints.map((c) => c.build()));
    this.output({ saveToFile: Buffer.from(cues) });

    const latestTimestamp = Object.values(this.timestamps).sort(
      (a, b) => a.elapsed - b.elapsed
    )[0].elapsed;
    const duration = this.relativeTimestamp + latestTimestamp;
    const durationElement = this.builder.createDuration(duration);
    this.output({ eol: { duration, durationElement } });
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
export const Max32Uint = Number(0x01n << 32n) - 1;
/**32767 */
export const MaxSinged16Int = (0x01 << 16) / 2 - 1;

export const DurationPosition = 83;

export const SegmentSizePosition = 40;

export function replaceSegmentSize(totalFileSize: number) {
  const bodySize = totalFileSize - SegmentSizePosition;
  const resize = [
    ...vintEncode(numberToByteArray(bodySize, getEBMLByteLength(bodySize))),
  ];
  const todoFill = 8 - resize.length - 2;
  if (todoFill > 0) {
    resize.push(0xec);
    if (todoFill > 1) {
      const voidSize = vintEncode(
        numberToByteArray(todoFill, getEBMLByteLength(todoFill))
      );
      [...voidSize].forEach((i) => resize.push(i));
    }
  }
  return Buffer.from(resize);
}
