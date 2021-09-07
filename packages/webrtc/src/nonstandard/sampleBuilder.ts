import { debug } from "debug";

import { int } from "../../../common/src";
import { DePacketizerBase, RtpPacket } from "../../../rtp/src";
import { enumerate } from "../helper";
import { JitterBuffer } from "./jitterBuffer";

const log = debug("werift:packages/webrtc/src/nonstandard/sampleBuilder.ts");

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

    if (tail == undefined) return;
    if (this.baseTimestamp == undefined) {
      this.baseTimestamp = this.buffer[tail].header.timestamp;
    }

    const tailTimestamp = this.buffer[tail].header.timestamp;
    const rotate =
      Math.abs(tailTimestamp - this.baseTimestamp) > (Max32Uint / 4) * 3;
    if (rotate) log({ rotate }, tailTimestamp, this.baseTimestamp);

    const elapsed = rotate
      ? tailTimestamp + Max32Uint - this.baseTimestamp
      : tailTimestamp - this.baseTimestamp;

    const relativeTimestamp = int((elapsed / this.clockRate) * 1000);
    this.relativeTimestamp = relativeTimestamp;

    const frames = this.buffer.slice(0, tail + 1).map((p) => {
      const frame = this.DePacketizer.deSerialize(p.payload);
      return frame;
    });
    const isKeyframe = !!frames.find((f) => f.isKeyframe);
    const data = Buffer.concat(frames.map((f) => f.payload));

    this.buffer = this.buffer.slice(tail + 1);

    return { data, relativeTimestamp, isKeyframe };
  }
}

/**4294967295 */
const Max32Uint = Number(0x01n << 32n) - 1;
