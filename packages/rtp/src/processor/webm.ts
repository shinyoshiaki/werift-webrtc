import { appendFile, readFile, writeFile } from "fs/promises";
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
  timestamps: { [pt: number]: TimestampManager } = {};
  disposer: () => void;
  stopped = false;

  constructor(
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
    await writeFile(this.path, staticPart);
    const cluster = this.builder.createCluster(0.0);
    await appendFile(this.path, cluster);
  }

  async stop() {
    this.stopped = true;
    if (this.disposer) {
      this.disposer();
    }

    const staticPartLength = Buffer.concat([
      this.builder.ebmlHeader,
      this.builder.createSegment(),
    ]).length;
    const file = await readFile(this.path);
    const clusters = file.slice(staticPartLength);

    const latestTimestamp = Object.values(this.timestamps).sort(
      (a, b) => a.relativeTimestamp - b.relativeTimestamp
    )[0].relativeTimestamp;
    const duration = this.relativeTimestamp + latestTimestamp;

    const staticPart = Buffer.concat([
      this.builder.ebmlHeader,
      this.builder.createSegment(duration),
    ]);
    await writeFile(this.path, staticPart);
    await appendFile(this.path, clusters);
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
      await appendFile(this.path, cluster);

      Object.values(this.timestamps).forEach((t) => t.reset());
    }

    const simpleBlock = this.builder.createSimpleBlock(
      data,
      isKeyframe,
      track.trackNumber,
      timestampManager.relativeTimestamp
    );
    await appendFile(this.path, simpleBlock);
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

/**4294967295 */
const Max32Uint = Number(0x01n << 32n) - 1;
/**32767 */
const MaxSinged16Int = (0x01 << 16) / 2 - 1;
