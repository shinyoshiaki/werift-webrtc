import { bufferReader, bufferWriter } from "../../helper";
import { BitWriter, getBit } from "../../utils";

export class ReceiverEstimatedMaxBitrate {
  static count = 15;
  length: number;
  count = ReceiverEstimatedMaxBitrate.count;
  senderSsrc: number;
  mediaSsrc: number;
  readonly uniqueID: string = "REMB";
  ssrcNum: number = 0;
  brExp: number;
  brMantissa: number;
  bitrate: bigint;
  ssrcFeedbacks: number[];

  constructor(props: Partial<ReceiverEstimatedMaxBitrate> = {}) {
    Object.assign(this, props);
  }

  static deSerialize(data: Buffer) {
    const [senderSsrc, mediaSsrc, uniqueID, ssrcNum, e_m] = bufferReader(data, [
      4,
      4,
      4,
      1,
      1,
    ]);

    const brExp = getBit(e_m, 0, 6);
    const brMantissa = (getBit(e_m, 6, 2) << 16) + (data[14] << 8) + data[15];

    const bitrate =
      brExp > 46 ? 18446744073709551615n : BigInt(brMantissa) << BigInt(brExp);

    const ssrcFeedbacks = [];
    for (let i = 16; i < data.length; i += 4) {
      const feedback = data.slice(i).readUIntBE(0, 4);
      ssrcFeedbacks.push(feedback);
    }

    return new ReceiverEstimatedMaxBitrate({
      senderSsrc,
      mediaSsrc,
      uniqueID: bufferWriter([4], [uniqueID]).toString(),
      ssrcNum,
      brExp,
      brMantissa,
      ssrcFeedbacks,
      bitrate,
    });
  }

  serialize() {
    const constant = Buffer.concat([
      bufferWriter([4, 4], [this.senderSsrc, this.mediaSsrc]),
      Buffer.from(this.uniqueID),
      bufferWriter([1], [this.ssrcNum]),
    ]);

    const writer = new BitWriter(24);
    writer.set(6, 0, this.brExp).set(18, 6, this.brMantissa);
    const feedbacks = Buffer.concat(
      this.ssrcFeedbacks.map((feedback) => bufferWriter([4], [feedback]))
    );

    const buf = Buffer.concat([
      constant,
      bufferWriter([3], [writer.value]),
      feedbacks,
    ]);
    this.length = buf.length / 4;
    return buf;
  }
}
