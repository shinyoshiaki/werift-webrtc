import Event from "rx.mini";

import { int, PromiseQueue } from "../../../common/src";
import {
  AV1RtpPayload,
  DePacketizerBase,
  H264RtpPayload,
  OpusRtpPayload,
  RtpPacket,
  Vp8RtpPayload,
  Vp9RtpPayload,
} from "..";
import { SupportedCodec, WEBMBuilder } from "../container/webm";
import { Output } from "./base";

export class WebmOutput implements Output {
  private builder: WEBMBuilder;
  private queue = new PromiseQueue();
  private relativeTimestamp = 0;
  private timestamps: { [pt: number]: TimestampManager } = {};
  private disposer?: () => void;
  private cuePoints: CuePoint[] = [];
  private position = 0;
  stopped = false;

  constructor(
    /**fs/promises */
    private fs: any,
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
    }
  ) {
    this.builder = new WEBMBuilder(tracks);

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
    await this.fs.writeFile(this.path, staticPart);
    this.position += staticPart.length;

    const video = this.tracks.find((t) => t.kind === "video");
    if (video) {
      this.cuePoints.push(
        new CuePoint(this.builder, video.trackNumber, 0.0, this.position)
      );
    }

    const cluster = this.builder.createCluster(0.0);
    await this.fs.appendFile(this.path, cluster);
    this.position += cluster.length;
  }

  async stop() {
    this.stopped = true;
    if (this.disposer) {
      this.disposer();
    }

    const originStaticPartOffset = Buffer.concat([
      this.builder.ebmlHeader,
      this.builder.createSegment(),
    ]).length;
    const clusters = (await this.fs.readFile(this.path)).slice(
      originStaticPartOffset
    );

    const latestTimestamp = Object.values(this.timestamps).sort(
      (a, b) => a.relativeTimestamp - b.relativeTimestamp
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

    await this.fs.writeFile(this.path, staticPart);
    await this.fs.appendFile(this.path, cues);
    await this.fs.appendFile(this.path, clusters);
  }

  pushRtpPackets(packets: RtpPacket[]) {
    if (this.stopped) return;
    this.queue.push(() => this.onRtpPackets(packets));
  }

  private async onRtpPackets(packets: RtpPacket[]) {
    const track = this.tracks.find(
      (t) => t.payloadType === packets[0].header.payloadType
    );
    if (!track) {
      return;
    }

    const timestampManager = this.timestamps[track.payloadType];

    const { data, isKeyframe } = this.dePacketizeRtpPackets(
      track.codec,
      packets
    );

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
      await this.fs.appendFile(this.path, cluster);
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
    }

    const block = this.builder.createSimpleBlock(
      data,
      isKeyframe,
      track.trackNumber,
      timestampManager.relativeTimestamp
    );
    await this.fs.appendFile(this.path, block);
    this.position += block.length;
    const [cuePoint] = this.cuePoints.slice(-1);
    if (cuePoint) {
      cuePoint.blockNumber++;
    }
  }

  private dePacketizeRtpPackets(codec: string, packets: RtpPacket[]) {
    const basicCodecParser = (
      DePacketizer: typeof DePacketizerBase
    ): { data: Buffer; isKeyframe: boolean } => {
      const frames = packets.map((p) => DePacketizer.deSerialize(p.payload));
      const isKeyframe = !!frames.find((f) => f.isKeyframe);
      const data = Buffer.concat(frames.map((f) => f.payload));
      return { isKeyframe, data };
    };

    switch (codec) {
      case "AV1": {
        const chunks = packets.map((p) => AV1RtpPayload.deSerialize(p.payload));
        const data = AV1RtpPayload.getFrame(chunks);
        const isKeyframe = !!chunks.find((f) => f.isKeyframe);
        return { isKeyframe, data };
      }
      case "MPEG4/ISO/AVC":
        return basicCodecParser(H264RtpPayload);
      case "VP8":
        return basicCodecParser(Vp8RtpPayload);
      case "VP9":
        return basicCodecParser(Vp9RtpPayload);
      case "OPUS":
        return basicCodecParser(OpusRtpPayload);
      default:
        throw new Error();
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

    const relativeTimestamp = int((elapsed / this.clockRate) * 1000);
    this.relativeTimestamp = relativeTimestamp;
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
