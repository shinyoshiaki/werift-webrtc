/**
 * Ogg page writer (RFC 3533) and Ogg Opus header packets (RFC 7845).
 */

/** header_type flag: the page continues a packet from the previous page */
export const OggHeaderTypeContinued = 0x01;
/** header_type flag: first page of a logical bitstream */
export const OggHeaderTypeBos = 0x02;
/** header_type flag: last page of a logical bitstream */
export const OggHeaderTypeEos = 0x04;

/** granule position of a page on which no packet ends (RFC 3533 §6) */
export const OggNoGranulePosition = -1n;

/** maximum number of lacing values in one page */
export const OggMaxSegments = 255;

const oggCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

/**
 * CRC32 used by Ogg pages: polynomial 0x04c11db7, MSB first (not reflected),
 * initial value 0 and no final XOR.
 * This differs from the zlib / IEEE `crc32` in `common`.
 */
export function oggCrc32(buf: Uint8Array) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc << 8) ^ oggCrcTable[((crc >>> 24) ^ buf[i]) & 0xff];
  }
  return crc >>> 0;
}

/**
 * Lacing values of one packet: 255 for each full segment and a final value
 * below 255. A packet whose size is a multiple of 255 ends with a 0 segment.
 */
export function oggLacingValues(packetLength: number) {
  const values = new Array<number>(Math.floor(packetLength / 255)).fill(255);
  values.push(packetLength % 255);
  return values;
}

export interface OggPageProps {
  /** combination of OggHeaderType* flags */
  headerType: number;
  granulePosition: bigint;
  serialNumber: number;
  pageSequence: number;
  segmentTable: number[];
  /** concatenated segment data, length must equal sum(segmentTable) */
  data: Buffer;
}

/** Serialize one Ogg page including its CRC. */
export function createOggPage({
  headerType,
  granulePosition,
  serialNumber,
  pageSequence,
  segmentTable,
  data,
}: OggPageProps) {
  if (segmentTable.length > OggMaxSegments) {
    throw new Error(`too many ogg segments: ${segmentTable.length}`);
  }
  const dataLength = segmentTable.reduce((acc, cur) => acc + cur, 0);
  if (dataLength !== data.length) {
    throw new Error(
      `ogg segment table (${dataLength}) does not match data (${data.length})`,
    );
  }

  const header = Buffer.alloc(27 + segmentTable.length);
  header.write("OggS", 0, "ascii");
  header.writeUInt8(0, 4); // version
  header.writeUInt8(headerType, 5);
  header.writeBigInt64LE(granulePosition, 6);
  header.writeUInt32LE(serialNumber >>> 0, 14);
  header.writeUInt32LE(pageSequence >>> 0, 18);
  header.writeUInt32LE(0, 22); // checksum placeholder
  header.writeUInt8(segmentTable.length, 26);
  segmentTable.forEach((v, i) => header.writeUInt8(v, 27 + i));

  const page = Buffer.concat([header, data]);
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

/**
 * Packs packets of one logical bitstream into Ogg pages.
 * Packets that do not fit into the 255 lacing values of a page are split
 * across pages with the continued flag.
 */
export class OggPager {
  private pageSequence = 0;
  private segmentTable: number[] = [];
  private chunks: Buffer[] = [];
  /** granule position of the last packet that ends on the pending page */
  private pendingGranule = OggNoGranulePosition;
  /** the pending page starts with the continuation of a packet */
  private pendingContinued = false;
  private bos = true;
  /** granule position of the last packet that was added */
  lastGranulePosition = 0n;
  ended = false;

  constructor(readonly serialNumber: number) {}

  get pendingPackets() {
    return this.segmentTable.filter((v) => v < 255).length;
  }

  get pendingSegments() {
    return this.segmentTable.length;
  }

  /**
   * Add one packet. Returns pages that were completed because the segment
   * table became full.
   */
  addPacket(packet: Buffer, granulePosition: bigint) {
    if (this.ended) {
      throw new Error("ogg stream already ended");
    }
    const pages: Buffer[] = [];
    const lacing = oggLacingValues(packet.length);

    let offset = 0;
    for (let i = 0; i < lacing.length; i++) {
      if (this.segmentTable.length === OggMaxSegments) {
        pages.push(this.buildPage(0));
        // the next page starts in the middle of this packet
        this.pendingContinued = i > 0;
      }
      const size = lacing[i];
      this.segmentTable.push(size);
      this.chunks.push(packet.subarray(offset, offset + size));
      offset += size;
    }
    this.pendingGranule = granulePosition;
    this.lastGranulePosition = granulePosition;
    return pages;
  }

  /**
   * Emit the pending page. Returns nothing when no data is pending unless
   * `eos` is set, in which case an empty EOS page is emitted.
   */
  flush({ eos }: { eos?: boolean } = {}) {
    if (this.ended) {
      return [];
    }
    if (this.segmentTable.length === 0 && !eos) {
      return [];
    }
    if (this.segmentTable.length === 0) {
      this.pendingGranule = this.lastGranulePosition;
    }
    const page = this.buildPage(eos ? OggHeaderTypeEos : 0);
    if (eos) {
      this.ended = true;
    }
    return [page];
  }

  private buildPage(flags: number) {
    let headerType = flags;
    if (this.bos) {
      headerType |= OggHeaderTypeBos;
      this.bos = false;
    }
    if (this.pendingContinued) {
      headerType |= OggHeaderTypeContinued;
    }
    const page = createOggPage({
      headerType,
      granulePosition: this.pendingGranule,
      serialNumber: this.serialNumber,
      pageSequence: this.pageSequence++,
      segmentTable: this.segmentTable,
      data: Buffer.concat(this.chunks),
    });
    this.segmentTable = [];
    this.chunks = [];
    this.pendingGranule = OggNoGranulePosition;
    this.pendingContinued = false;
    return page;
  }
}

/** pre-skip recommended for the 48 kHz Opus encoder delay (RFC 7845 §4.2) */
export const OpusDefaultPreSkip = 312;

export interface OpusHeadProps {
  /** 1 or 2 (channel mapping family 0) */
  channels?: number;
  preSkip?: number;
  inputSampleRate?: number;
  /** Q7.8 dB */
  outputGain?: number;
}

/** Identification header packet (RFC 7845 §5.1), mapping family 0 */
export function createOpusHead({
  channels = 2,
  preSkip = OpusDefaultPreSkip,
  inputSampleRate = 48000,
  outputGain = 0,
}: OpusHeadProps = {}) {
  if (channels !== 1 && channels !== 2) {
    throw new Error(`unsupported opus channel count for ogg: ${channels}`);
  }
  const buf = Buffer.alloc(19);
  buf.write("OpusHead", 0, "ascii");
  buf.writeUInt8(1, 8); // version
  buf.writeUInt8(channels, 9);
  buf.writeUInt16LE(preSkip, 10);
  buf.writeUInt32LE(inputSampleRate, 12);
  buf.writeInt16LE(outputGain, 16);
  buf.writeUInt8(0, 18); // channel mapping family
  return buf;
}

/** Comment header packet (RFC 7845 §5.2) */
export function createOpusTags(vendor = "werift", comments: string[] = []) {
  const vendorBuf = Buffer.from(vendor, "utf8");
  const parts: Buffer[] = [Buffer.from("OpusTags", "ascii")];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  parts.push(u32(vendorBuf.length), vendorBuf, u32(comments.length));
  for (const comment of comments) {
    const c = Buffer.from(comment, "utf8");
    parts.push(u32(c.length), c);
  }
  return Buffer.concat(parts);
}

/**
 * Number of 48 kHz samples in one Opus packet (RFC 6716 §3.1).
 * Returns undefined for a malformed packet.
 */
export function getOpusPacketSamples(packet: Uint8Array) {
  if (packet.length < 1) {
    return undefined;
  }
  const toc = packet[0];
  const config = toc >> 3;
  let frameSize: number;
  if (config < 12) {
    // SILK: 10, 20, 40, 60 ms
    frameSize = [480, 960, 1920, 2880][config & 0x03];
  } else if (config < 16) {
    // Hybrid: 10, 20 ms
    frameSize = [480, 960][config & 0x01];
  } else {
    // CELT: 2.5, 5, 10, 20 ms
    frameSize = [120, 240, 480, 960][config & 0x03];
  }

  let frames: number;
  switch (toc & 0x03) {
    case 0:
      frames = 1;
      break;
    case 1:
    case 2:
      frames = 2;
      break;
    default:
      if (packet.length < 2) {
        return undefined;
      }
      frames = packet[1] & 0x3f;
      break;
  }
  const samples = frameSize * frames;
  // a packet cannot exceed 120 ms
  if (samples === 0 || samples > 5760) {
    return undefined;
  }
  return samples;
}
