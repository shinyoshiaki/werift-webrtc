import { BinaryLike } from "crypto";
import Event from "rx.mini";

import { int, PromiseQueue } from "../../../common/src";
import { RtpPacket } from "..";
import { dePacketizeRtpPackets } from "../codec";
import { SupportedCodec, WEBMContainer } from "../container/webm/container";
import { Output } from "./base";

export interface FileIO {
  writeFile: (path: string, bin: BinaryLike) => Promise<void>;
  appendFile: (path: string, bin: BinaryLike) => Promise<void>;
  readFile: (path: string) => Promise<Buffer>;
}

export class WebmOutput implements Output {
  private builder: WEBMContainer;
  private queue = new PromiseQueue();
  private relativeTimestamp = 0;
  private timestamps: { [pt: number]: TimestampManager } = {};
  private disposer?: () => void;
  private cuePoints: CuePoint[] = [];
  private position = 0;
  stopped = false;

  constructor(
    private writer: FileIO,
    public path: string,
    public tracks: {
      width?: number;
      height?: number;
      kind: "audio" | "video";
      codec: SupportedCodec;
      clockRate: number;
      payloadType: number;
      trackNumber: number;
    }[],
    streams?: {
      rtpStream?: Event<[RtpPacket]>;
    },
  ) {
    this.builder = new WEBMContainer(tracks);

    tracks.forEach((t) => {
      this.timestamps[t.payloadType] = new TimestampManager(t.clockRate);
    });

    this.queue.push(() => this.init());

    if (streams?.rtpStream) {
      const { unSubscribe } = streams.rtpStream.subscribe((packet) => {
        this.pushRtpPackets([packet]);
      });
      this.disposer = unSubscribe;
    }
  }

  private async init() {
    const staticPart = Buffer.concat([
      this.builder.ebmlHeader,
      this.builder.createSegment(),
    ]);
    await this.writer.writeFile(this.path, staticPart);
    this.position += staticPart.length;

    const video = this.tracks.find((t) => t.kind === "video");
    if (video) {
      this.cuePoints.push(
        new CuePoint(this.builder, video.trackNumber, 0.0, this.position),
      );
    }

    const cluster = this.builder.createCluster(0.0);
    await this.writer.appendFile(this.path, cluster);
    this.position += cluster.length;
  }

  async stop(insertDuration = true) {
    this.stopped = true;
    if (this.disposer) {
      this.disposer();
    }

    if (!insertDuration) {
      return;
    }

    const originStaticPartOffset = Buffer.concat([
      this.builder.ebmlHeader,
      this.builder.createSegment(),
    ]).length;
    const clusters = (await this.writer.readFile(this.path)).slice(
      originStaticPartOffset,
    );

    const latestTimestamp = Object.values(this.timestamps).sort(
      (a, b) => a.relativeTimestamp - b.relativeTimestamp,
    )[0].relativeTimestamp;
    const duration = this.relativeTimestamp + latestTimestamp;
    const staticPart = Buffer.concat([
      this.builder.ebmlHeader,
      this.builder.createSegment(duration),
    ]);
    // durationを挿入したことによるギャップの解消
    const staticPartGap = staticPart.length - originStaticPartOffset;
    this.cuePoints.forEach((c) => {
      c.position += staticPartGap;
    });

    let cuesSize = 0;
    let cues = this.builder.createCues(this.cuePoints.map((c) => c.build()));
    // cuesの最終的なサイズを再帰的に求める
    while (cuesSize !== cues.length) {
      cuesSize = cues.length;
      this.cuePoints.forEach((cue) => {
        cue.cuesLength += cuesSize;
      });
      cues = this.builder.createCues(this.cuePoints.map((c) => c.build()));
    }

    await this.writer.writeFile(this.path, staticPart);
    await this.writer.appendFile(this.path, cues);
    await this.writer.appendFile(this.path, clusters);
  }

  pushRtpPackets(packets: RtpPacket[]) {
    if (this.stopped) return;
    this.queue.push(() => this.onRtpPackets(packets));
  }

  private async onRtpPackets(packets: RtpPacket[]) {
    const track = this.tracks.find(
      (t) => t.payloadType === packets[0].header.payloadType,
    );
    if (!track) {
      return;
    }

    const timestampManager = this.timestamps[track.payloadType];

    const { data, isKeyframe } = dePacketizeRtpPackets(track.codec, packets);

    const tailTimestamp = packets.slice(-1)[0].header.timestamp;
    timestampManager.update(tailTimestamp);

    if (
      (track.kind === "video" &&
        timestampManager.relativeTimestamp > 0 &&
        isKeyframe) ||
      timestampManager.relativeTimestamp > MaxSinged16Int
    ) {
      this.relativeTimestamp += timestampManager.relativeTimestamp;

      const cluster = this.builder.createCluster(this.relativeTimestamp);
      await this.writer.appendFile(this.path, cluster);
      this.cuePoints.push(
        new CuePoint(
          this.builder,
          track.trackNumber,
          this.relativeTimestamp,
          this.position,
        ),
      );
      this.position += cluster.length;
      Object.values(this.timestamps).forEach((t) => t.reset());
    }

    const block = this.builder.createSimpleBlock(
      data,
      isKeyframe,
      track.trackNumber,
      timestampManager.relativeTimestamp,
    );
    await this.writer.appendFile(this.path, block);
    this.position += block.length;
    const [cuePoint] = this.cuePoints.slice(-1);
    if (cuePoint) {
      cuePoint.blockNumber++;
    }
  }
}

class TimestampManager {
  private baseTimestamp?: number;
  relativeTimestamp = 0;

  constructor(public clockRate: number) {}

  reset() {
    this.baseTimestamp = undefined;
    this.relativeTimestamp = 0;
  }

  update(tailTimestamp: number) {
    if (this.baseTimestamp == undefined) {
      this.baseTimestamp = tailTimestamp;
    }
    const rotate =
      Math.abs(tailTimestamp - this.baseTimestamp) > (Max32Uint / 4) * 3;

    const elapsed = rotate
      ? tailTimestamp + Max32Uint - this.baseTimestamp
      : tailTimestamp - this.baseTimestamp;

    this.relativeTimestamp = int((elapsed / this.clockRate) * 1000);
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
    private readonly builder: WEBMContainer,
    private readonly trackNumber: number,
    private readonly relativeTimestamp: number,
    public position: number,
  ) {}

  build() {
    return this.builder.createCuePoint(
      this.relativeTimestamp,
      this.trackNumber,
      this.position - 48 + this.cuesLength,
      this.blockNumber,
    );
  }
}

/**4294967295 */
const Max32Uint = Number(0x01n << 32n) - 1;
/**32767 */
const MaxSinged16Int = (0x01 << 16) / 2 - 1;
