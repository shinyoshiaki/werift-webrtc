import { BitWriter, getBit } from "../utils";

export type Extension = { id: number; payload: Buffer };

const extensionProfileOneByte = 0xbede; // 48862
const extensionProfileTwoByte = 0x1000; // 4096

const seqNumOffset = 2;
const timestampOffset = 4;
const ssrcOffset = 8;
const csrcOffset = 12;
const csrcLength = 4;

/*
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |V=2|P|X|  CC   |M|     PT      |       sequence number         |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                           timestamp                           |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |           synchronization source (SSRC) identifier            |
 * +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
 * |            contributing source (CSRC) identifiers             |
 * |                             ....                              |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 */

export class RtpHeader {
  version: number = 2;
  padding: boolean = false;
  paddingSize: number = 0;
  extension: boolean = false;
  marker: boolean = false;
  payloadOffset: number = 0;
  payloadType: number = 0;
  sequenceNumber: number = 0;
  timestamp: number = 0;
  ssrc: number = 0;
  csrc: number[] = [];
  extensionProfile: number = extensionProfileOneByte;
  extensionLength?: number;
  extensions: Extension[] = [];
  constructor(props: Partial<RtpHeader> = {}) {
    Object.assign(this, props);
  }

  static deSerialize(rawPacket: Buffer) {
    const h = new RtpHeader();
    let currOffset = 0;
    const v_p_x_cc = rawPacket[currOffset++];
    h.version = getBit(v_p_x_cc, 0, 2);
    h.padding = getBit(v_p_x_cc, 2) > 0;
    h.extension = getBit(v_p_x_cc, 3) > 0;
    const cc = getBit(v_p_x_cc, 4, 4);
    h.csrc = [...Array(cc)].map(() => {
      const csrc = rawPacket.readUInt32BE(currOffset);
      currOffset += 4;
      return csrc;
    });
    currOffset += csrcOffset - 1;

    const m_pt = rawPacket[1];
    h.marker = getBit(m_pt, 0) > 0;
    h.payloadType = getBit(m_pt, 1, 7);

    h.sequenceNumber = rawPacket.readUInt16BE(seqNumOffset);
    h.timestamp = rawPacket.readUInt32BE(timestampOffset);
    h.ssrc = rawPacket.readUInt32BE(ssrcOffset);

    for (let i = 0; i < h.csrc.length; i++) {
      const offset = csrcOffset + i * csrcLength;
      h.csrc[i] = rawPacket.slice(offset).readUInt32BE();
    }
    if (h.extension) {
      h.extensionProfile = rawPacket.slice(currOffset).readUInt16BE();
      currOffset += 2;
      const extensionLength = rawPacket.slice(currOffset).readUInt16BE() * 4;
      h.extensionLength = extensionLength;
      currOffset += 2;

      switch (h.extensionProfile) {
        // RFC 8285 RTP One Byte Header Extension
        case 0xbede:
          {
            const end = currOffset + extensionLength;
            while (currOffset < end) {
              if (rawPacket[currOffset] === 0x00) {
                currOffset++;
                continue;
              }

              const extId = rawPacket[currOffset] >> 4;
              const len = // and not &^
                (rawPacket[currOffset] & (rawPacket[currOffset] ^ 0xf0)) + 1;
              currOffset++;
              if (extId === 0xf) {
                break;
              }
              const extension: Extension = {
                id: extId,
                payload: rawPacket.slice(currOffset, currOffset + len),
              };
              h.extensions = [...h.extensions, extension];
              currOffset += len;
            }
          }
          break;
        // RFC 8285 RTP Two Byte Header Extension
        case 0x1000:
          {
            const end = currOffset + extensionLength;
            while (currOffset < end) {
              if (rawPacket[currOffset] === 0x00) {
                currOffset++;
                continue;
              }
              const extId = rawPacket[currOffset];
              currOffset++;
              const len = rawPacket[currOffset];
              currOffset++;

              const extension: Extension = {
                id: extId,
                payload: rawPacket.slice(currOffset, currOffset + len),
              };
              h.extensions = [...h.extensions, extension];
              currOffset += len;
            }
          }
          break;
        default:
          {
            const extension: Extension = {
              id: 0,
              payload: rawPacket.slice(
                currOffset,
                currOffset + extensionLength
              ),
            };
            h.extensions = [...h.extensions, extension];
            currOffset += h.extensions[0].payload.length;
          }
          break;
      }
    }
    h.payloadOffset = currOffset;
    if (h.padding) {
      h.paddingSize = rawPacket[rawPacket.length - 1];
    }

    return h;
  }

  get serializeSize() {
    let size = 12 + this.csrc.length * csrcLength;

    if (this.extension) {
      let extSize = 4;
      switch (this.extensionProfile) {
        case extensionProfileOneByte:
          this.extensions.forEach((extension) => {
            extSize += 1 + extension.payload.length;
          });
          break;
        case extensionProfileTwoByte:
          this.extensions.forEach((extension) => {
            extSize += 2 + extension.payload.length;
          });
          break;
        default:
          extSize += this.extensions[0].payload.length;
      }
      size += Math.floor((extSize + 3) / 4) * 4;
    }

    return size;
  }

  serialize(size: number) {
    const buf = Buffer.alloc(size);
    let offset = 0;

    const v_p_x_cc = new BitWriter(8);
    v_p_x_cc.set(2, 0, this.version);
    if (this.padding) v_p_x_cc.set(1, 2, 1);
    if (this.extensions.length > 0) this.extension = true;
    if (this.extension) v_p_x_cc.set(1, 3, 1);
    v_p_x_cc.set(4, 4, this.csrc.length);
    buf.writeUInt8(v_p_x_cc.value, offset++);

    const m_pt = new BitWriter(8);
    if (this.marker) m_pt.set(1, 0, 1);
    m_pt.set(7, 1, this.payloadType);
    buf.writeUInt8(m_pt.value, offset++);

    buf.writeUInt16BE(this.sequenceNumber, seqNumOffset);
    offset += 2;
    buf.writeUInt32BE(this.timestamp, timestampOffset);
    offset += 4;
    buf.writeUInt32BE(this.ssrc, ssrcOffset);
    offset += 4;

    this.csrc.forEach((csrc) => {
      buf.writeUInt32BE(csrc, offset);
      offset += 4;
    });

    if (this.extension) {
      const extHeaderPos = offset;
      buf.writeUInt16BE(this.extensionProfile, offset);
      offset += 4;
      const startExtensionsPos = offset;

      switch (this.extensionProfile) {
        case extensionProfileOneByte:
          this.extensions.forEach((extension) => {
            buf.writeUInt8(
              (extension.id << 4) | (extension.payload.length - 1),
              offset++
            );
            extension.payload.copy(buf, offset);
            offset += extension.payload.length;
          });
          break;
        case extensionProfileTwoByte: // 1バイトで収まらなくなった歴史的経緯
          this.extensions.forEach((extension) => {
            buf.writeUInt8(extension.id, offset++);
            buf.writeUInt8(extension.payload.length, offset++);
            extension.payload.copy(buf, offset);
            offset += extension.payload.length;
          });
          break;
        default:
          const extLen = this.extensions[0].payload.length;
          if (extLen % 4 != 0) {
            throw new Error();
          }
          this.extensions[0].payload.copy(buf, offset);
          offset += extLen;
      }

      const extSize = offset - startExtensionsPos;
      const roundedExtSize = Math.floor((extSize + 3) / 4) * 4;

      buf.writeUInt16BE(Math.floor(roundedExtSize / 4), extHeaderPos + 2);
      for (let i = 0; i < roundedExtSize - extSize; i++) {
        buf.writeUInt8(0, offset);
        offset++;
      }
    }
    this.payloadOffset = offset;
    return buf;
  }
}

export class RtpPacket {
  constructor(public header: RtpHeader, public payload: Buffer) {}

  get serializeSize() {
    return this.header.serializeSize + this.payload.length;
  }

  serialize() {
    let buf = this.header.serialize(
      this.header.serializeSize + this.payload.length
    );
    const n = this.header.payloadOffset;
    this.payload.copy(buf, n);
    if (this.header.padding) {
      const padding = Buffer.alloc(this.header.paddingSize);
      padding.writeUInt8(this.header.paddingSize, this.header.paddingSize - 1);
      buf = Buffer.concat([buf, padding]);
    }

    return buf;
  }

  static deSerialize(buf: Buffer) {
    const header = RtpHeader.deSerialize(buf);
    const p = new RtpPacket(
      header,
      buf.slice(header.payloadOffset, buf.length - header.paddingSize)
    );
    return p;
  }
}
