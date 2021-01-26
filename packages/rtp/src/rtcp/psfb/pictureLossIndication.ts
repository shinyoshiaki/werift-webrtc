import { bufferReader, bufferWriter } from "../../helper";

export class PictureLossIndication {
  static count = 1;
  count = PictureLossIndication.count;
  length = 2;

  senderSsrc!: number;
  mediaSsrc!: number;

  constructor(props: Partial<PictureLossIndication> = {}) {
    Object.assign(this, props);
  }

  static deSerialize(data: Buffer) {
    const [senderSsrc, mediaSsrc] = bufferReader(data, [4, 4]);
    return new PictureLossIndication({ senderSsrc, mediaSsrc });
  }

  serialize() {
    return bufferWriter([4, 4], [this.senderSsrc, this.mediaSsrc]);
  }
}
