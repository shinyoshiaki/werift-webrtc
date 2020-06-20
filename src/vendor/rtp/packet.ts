type Extension = { id: number; payload: Buffer };

const versionShift = 6;
const versionMask = 0x3;
const paddingShift = 5;
const paddingMask = 0x1;
const extensionShift = 4;
const extensionMask = 0x1;
const ccMask = 0xf;
const markerShift = 7;
const markerMask = 0x1;
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
  public version: number;
  public padding: boolean;
  public extension: boolean;
  public marker: boolean;
  public payloadOffset: number;
  public payloadType: number;
  public sequenceNumber: number;
  public timestamp: number;
  public ssrc: number;
  public csrc: number[] = [];
  public extensionProfile: number;
  public extensions: Extension[] = [];
  constructor() {}

  static deSerialize(rawPacket: Buffer) {
    const h = new Header();
    h.version = (rawPacket[0] >> versionShift) & versionMask;
    h.padding = ((rawPacket[0] >> paddingShift) & paddingMask) > 0;
    h.extension = ((rawPacket[0] >> extensionShift) & extensionMask) > 0;
    h.csrc = new Array(rawPacket[0] & ccMask);

    let currOffset = csrcOffset + h.csrc.length * csrcLength;

    h.marker = ((rawPacket[1] >> markerShift) & markerMask) > 0;
    h.payloadType = rawPacket[1] & ptMask;
    h.sequenceNumber = rawPacket
      .slice(seqNumOffset, seqNumOffset + seqNumLength)
      .readInt16BE();
    h.timestamp = rawPacket
      .slice(timestampOffset, timestampOffset + timestampLength)
      .readUInt32BE();
    h.ssrc = rawPacket
      .slice(ssrcOffset, ssrcOffset + ssrcLength)
      .readUInt32BE();
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
    return h;
  }
}

export class Packet {
  constructor(
    public header: Header,
    public raw: Buffer,
    public payload: Buffer
  ) {}

  static deSerialize(buf: Buffer) {
    const header = Header.deSerialize(buf.slice(0, 20));
    return new Packet(header, buf, buf.slice(20));
  }
}
