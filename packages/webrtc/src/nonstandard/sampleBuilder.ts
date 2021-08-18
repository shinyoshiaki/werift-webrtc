import { int, uint32Add } from "../../../common/src";
import { RtpPacket, Vp8RtpPayload } from "../../../rtp/src";
import { enumerate } from "../helper";
import { JitterBuffer } from "./jitterBuffer";

export class SampleBuilder {
  readonly jitterBuffer = new JitterBuffer();
  buffer: RtpPacket[] = [];
  baseTimestamp!: number;

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
      if (p.header.marker) {
        tail = i;
        break;
      } else {
        p.header.marker;
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
      const frame = Vp8RtpPayload.deSerialize(p.payload);
      if (frame.payload.length === 0) {
        p;
      }
      return frame;
    });
    const isKeyframe = !!frames.find((f) => f.isKeyframe);
    const data = Buffer.concat(frames.map((f) => f.payload));

    if (data.length === 0) {
      data;
    }

    this.buffer = this.buffer.slice(tail + 1);

    return { data, duration, isKeyframe };
  }
}
