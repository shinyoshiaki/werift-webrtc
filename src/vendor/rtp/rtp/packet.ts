import { setBit } from "../utils";

type Extension = { id: number; payload: Buffer };

const versionShift = 6;
const paddingShift = 5;
const paddingMask = 0x1;
const extensionShift = 4;
const extensionMask = 0x1;
const extensionProfileOneByte = 0xbede;
const extensionProfileTwoByte = 0x1000;
const ccMask = 0xf;
const markerShift = 7;
const ptMask = 0x7f;
const seqNumOffset = 2;
const seqNumLength = 2;
const timestampOffset = 4;
const timestampLength = 4;
const ssrcOffset = 8;
const ssrcLength = 4;
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

class Header {
  version: number;
  padding: boolean;
  paddingSize: number = 0;
  extension: boolean;
  marker: boolean;
  payloadOffset: number;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  csrc: number[] = [];
  extensionProfile: number;
  extensions: Extension[] = [];
  constructor() {}

  static deSerialize(rawPacket: Buffer) {
    const h = new Header();
    let currOffset = 0;
    const v_p_x_cc = rawPacket[currOffset++];
    h.version = v_p_x_cc >> versionShift;
    h.padding = ((v_p_x_cc >> paddingShift) & paddingMask) > 0;
    h.extension = ((v_p_x_cc >> extensionShift) & extensionMask) > 0;
    const cc = v_p_x_cc & ccMask;
    h.csrc = [...Array(cc)].map(() => {
      const csrc = rawPacket.readUInt32BE(currOffset);
      currOffset += 4;
      return csrc;
    });
    currOffset += csrcOffset - 1;

    const m_pt = rawPacket[1];
    h.marker = m_pt >> markerShift > 0;
    h.payloadType = m_pt & ptMask;

    h.sequenceNumber = rawPacket.readInt16BE(seqNumOffset);
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

    const v_p_x_cc = { v: 0 };
    setBit(v_p_x_cc, this.version, 1);
    if (this.padding) setBit(v_p_x_cc, 1, 2);
    if (this.extension) setBit(v_p_x_cc, 1, 3);
    setBit(v_p_x_cc, this.csrc.length, 4, 4);
    buf.writeUInt8(v_p_x_cc.v, offset++);

    const m_pt = { v: 0 };
    if (this.marker) setBit(m_pt, 1, 0);
    setBit(m_pt, this.payloadType, 1, 7);
    buf.writeUInt8(m_pt.v, offset++);

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
        case extensionProfileTwoByte:
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

      buf.writeInt16BE(Math.floor(roundedExtSize / 4), extHeaderPos + 2);
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
  constructor(public header: Header, public payload: Buffer) {}

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
    const header = Header.deSerialize(buf);
    const p = new RtpPacket(
      header,
      buf.slice(header.payloadOffset, buf.length - header.paddingSize)
    );
    return p;
  }
}
