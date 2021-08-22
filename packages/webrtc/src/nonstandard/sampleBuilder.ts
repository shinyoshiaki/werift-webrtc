import { int, uint32Add } from "../../../common/src";
import { DePacketizerBase, RtpPacket } from "../../../rtp/src";
import { enumerate } from "../helper";
import { JitterBuffer } from "./jitterBuffer";

export class SampleBuilder {
  private readonly jitterBuffer = new JitterBuffer();
  private buffer: RtpPacket[] = [];
  private baseTimestamp?: number;
  relativeTimestamp = 0;

  constructor(
    readonly DePacketizer: typeof DePacketizerBase,
    public clockRate: number
  ) {}

  push(p: RtpPacket) {
    if (this.baseTimestamp == undefined) {
      this.baseTimestamp = p.header.timestamp;
    }
    const buf = this.jitterBuffer.push(p);
    this.buffer = [...this.buffer, ...buf];
  }

  resetTimestamp() {
    this.baseTimestamp = undefined;
    this.relativeTimestamp = 0;
  }

  build() {
    let tail: number | undefined;
    for (const [i, p] of enumerate(this.buffer)) {
      if (this.DePacketizer.isDetectedFinalPacketInSequence(p.header)) {
        tail = i;
        break;
      }
    }

    if (tail == undefined || this.baseTimestamp == undefined) {
      return;
    }

    const elapsed = Number(
      uint32Add(
        BigInt(this.buffer[tail].header.timestamp),
        -BigInt(this.baseTimestamp)
      )
    );
    const relativeTimestamp = int((elapsed / this.clockRate) * 1000);
    this.relativeTimestamp = relativeTimestamp;

    const frames = this.buffer.slice(0, tail + 1).map((p) => {
      const frame = this.DePacketizer.deSerialize(p.payload);
      if (frame.payload.length === 0) {
        p;
      }
      return frame;
    });
    const isKeyframe = !!frames.find((f) => f.isKeyframe);
    const data = Buffer.concat(frames.map((f) => f.payload));

    this.buffer = this.buffer.slice(tail + 1);

    return { data, relativeTimestamp, isKeyframe };
  }
}
