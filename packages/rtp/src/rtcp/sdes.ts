import { bufferWriter } from "../../../common/src";
import { RtcpHeader } from "./header";
import { RtcpPacketConverter } from "./rtcp";

export class RtcpSourceDescriptionPacket {
  static readonly type = 202;
  readonly type = RtcpSourceDescriptionPacket.type;
  chunks: SourceDescriptionChunk[] = [];

  constructor(props: Partial<RtcpSourceDescriptionPacket>) {
    Object.assign(this, props);
  }

  get length() {
    let length = 0;
    this.chunks.forEach((chunk) => (length += chunk.length));
    return length;
  }

  serialize() {
    let payload = Buffer.concat(this.chunks.map((chunk) => chunk.serialize()));
    while (payload.length % 4)
      payload = Buffer.concat([payload, Buffer.from([0])]);
    return RtcpPacketConverter.serialize(
      this.type,
      this.chunks.length,
      payload,
      payload.length / 4
    );
  }

  static deSerialize(payload: Buffer, header: RtcpHeader) {
    const chunks: SourceDescriptionChunk[] = [];
    for (let i = 0; i < payload.length; ) {
      const chunk = SourceDescriptionChunk.deSerialize(payload.slice(i));
      chunks.push(chunk);
      i += chunk.length;
    }

    return new RtcpSourceDescriptionPacket({ chunks });
  }
}

export class SourceDescriptionChunk {
  source!: number;
  items: SourceDescriptionItem[] = [];

  constructor(props: Partial<SourceDescriptionChunk> = {}) {
    Object.assign(this, props);
  }

  get length() {
    let length = 4;
    this.items.forEach((item) => (length += item.length));
    length += 1;
    length += getPadding(length);
    return length;
  }

  serialize() {
    const data = Buffer.concat([
      bufferWriter([4], [this.source]),
      Buffer.concat(this.items.map((item) => item.serialize())),
    ]);

    const res = Buffer.concat([data, Buffer.alloc(getPadding(data.length))]);
    return res;
  }

  static deSerialize(data: Buffer) {
    const source = data.readUInt32BE();
    const items: SourceDescriptionItem[] = [];
    for (let i = 4; i < data.length; ) {
      const type = data[i];
      if (type === 0) break;

      const item = SourceDescriptionItem.deSerialize(data.slice(i));
      items.push(item);
      i += item.length;
    }

    return new SourceDescriptionChunk({ source, items });
  }
}

export class SourceDescriptionItem {
  type!: number;
  text!: string;

  constructor(props: Partial<SourceDescriptionItem>) {
    Object.assign(this, props);
  }

  get length() {
    return 1 + 1 + Buffer.from(this.text).length;
  }

  serialize() {
    const text = Buffer.from(this.text);
    return Buffer.concat([
      bufferWriter([1, 1], [this.type, text.length]),
      text,
    ]);
  }

  static deSerialize(data: Buffer) {
    const type = data[0];
    const octetCount = data[1];
    const text = data.slice(2, 2 + octetCount).toString();
    return new SourceDescriptionItem({ type, text });
  }
}

function getPadding(len: number) {
  if (len % 4 == 0) {
    return 0;
  }
  return 4 - (len % 4);
}
