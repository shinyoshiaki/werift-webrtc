import { bufferReader, bufferWriter } from "../../helper";

type firEntry = { ssrc: number; sequenceNumber: number };

export class FullIntraRequest {
  static count = 4;
  count = FullIntraRequest.count;

  senderSsrc!: number;
  mediaSsrc!: number;
  fir: firEntry[] = [];

  constructor(props: Partial<FullIntraRequest> = {}) {
    Object.assign(this, props);
  }

  get length() {
    return Math.floor(this.serialize().length / 4 - 1);
  }

  static deSerialize(data: Buffer) {
    const [senderSsrc, mediaSsrc] = bufferReader(data, [4, 4]);
    const fir: firEntry[] = [];
    for (let i = 8; i < data.length; i += 8) {
      fir.push({ ssrc: data.readUInt32BE(i), sequenceNumber: data[i + 4] });
    }

    return new FullIntraRequest({ senderSsrc, mediaSsrc, fir });
  }

  serialize() {
    const ssrcs = bufferWriter([4, 4], [this.senderSsrc, this.mediaSsrc]);

    const fir = Buffer.alloc(this.fir.length * 8);
    this.fir.forEach(({ ssrc, sequenceNumber }, i) => {
      fir.writeUInt32BE(ssrc, i * 8);
      fir[i * 8 + 4] = sequenceNumber;
    });

    return Buffer.concat([ssrcs, fir]);
  }
}
