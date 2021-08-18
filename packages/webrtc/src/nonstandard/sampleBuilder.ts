import { int, uint32Add } from "../../../common/src";
import { DePacketizerBase, RtpPacket } from "../../../rtp/src";
import { enumerate } from "../helper";
import { JitterBuffer } from "./jitterBuffer";

export class SampleBuilder {
  readonly jitterBuffer = new JitterBuffer();
  buffer: RtpPacket[] = [];
  baseTimestamp!: number;

  constructor(readonly DePacketizer: typeof DePacketizerBase) {}

  push(p: RtpPacket) {
    if (this.baseTimestamp == undefined) {
      this.baseTimestamp = p.header.timestamp;
    }
    const buf = this.jitterBuffer.push(p);
    this.buffer = [...this.buffer, ...buf];
  }

  build() {
    let tail: number | undefined;
    for (const [i, p] of enumerate(this.buffer)) {
      if (this.DePacketizer.isDetectedFinalPacketInSequence(p.header)) {
        tail = i;
        break;
      }
    }

    if (tail == undefined) {
      return;
    }

    const elapsed = Number(
      uint32Add(
        BigInt(this.buffer[tail].header.timestamp),
        -BigInt(this.baseTimestamp)
      )
    );
    const duration = int((elapsed / 90000) * 1000);

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

    return { data, duration, isKeyframe };
  }
}
