import {
  BitWriter,
  RtpHeader,
  RtpPacket,
  getBit,
  leb128decode,
  random16,
} from "../../imports/rtp";
import { H264AnnexBParser } from "../../imports/rtpExtra";
import type { RTCRtpCodecParameters } from "../../media/parameters";

import type { EncodedPacket } from "mediabunny";

const DEFAULT_MAX_RTP_PAYLOAD_SIZE = 1_200;

export const supportedSourceCodecs = [
  "avc",
  "vp8",
  "vp9",
  "av1",
  "opus",
] as const;
export type SupportedSourceCodec = (typeof supportedSourceCodecs)[number];

type SupportedMimeType =
  | "video/h264"
  | "video/vp8"
  | "video/vp9"
  | "video/av1x"
  | "audio/opus";

export interface Packetizer {
  packetize(packet: EncodedPacket, rtpTimestamp: number): RtpPacket[];
}

export function toSupportedMimeType(
  codec: SupportedSourceCodec,
): SupportedMimeType {
  switch (codec) {
    case "avc":
      return "video/h264";
    case "vp8":
      return "video/vp8";
    case "vp9":
      return "video/vp9";
    case "av1":
      return "video/av1x";
    case "opus":
      return "audio/opus";
  }
}

export function createPacketizer({
  codec,
  sourceCodec,
  decoderDescription,
}: {
  codec: RTCRtpCodecParameters;
  sourceCodec: SupportedSourceCodec;
  decoderDescription?: ArrayBuffer | ArrayBufferView | null;
}): Packetizer {
  switch (sourceCodec) {
    case "avc":
      return new H264Packetizer(codec, decoderDescription ?? null);
    case "vp8":
      return new Vp8Packetizer(codec);
    case "vp9":
      return new Vp9Packetizer(codec);
    case "av1":
      return new Av1Packetizer(codec);
    case "opus":
      return new OpusPacketizer(codec);
  }
}

abstract class BasePacketizer implements Packetizer {
  protected sequenceNumber = random16();

  constructor(
    protected readonly codec: RTCRtpCodecParameters,
    protected readonly maxPayloadSize = DEFAULT_MAX_RTP_PAYLOAD_SIZE,
  ) {}

  abstract packetize(packet: EncodedPacket, rtpTimestamp: number): RtpPacket[];

  protected buildPacket(
    payload: Buffer,
    timestamp: number,
    marker: boolean,
  ): RtpPacket {
    const packet = new RtpPacket(
      new RtpHeader({
        payloadType: this.codec.payloadType ?? 96,
        sequenceNumber: this.sequenceNumber,
        timestamp,
        marker,
      }),
      payload,
    );
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    return packet;
  }
}

class OpusPacketizer extends BasePacketizer {
  packetize(packet: EncodedPacket, rtpTimestamp: number): RtpPacket[] {
    return [this.buildPacket(toBuffer(packet.data), rtpTimestamp, true)];
  }
}

class Vp8Packetizer extends BasePacketizer {
  packetize(packet: EncodedPacket, rtpTimestamp: number): RtpPacket[] {
    const frame = toBuffer(packet.data);
    const chunkSize = this.maxPayloadSize - 1;
    if (chunkSize <= 0) {
      throw new Error("invalid VP8 RTP payload size");
    }

    const packets: RtpPacket[] = [];
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      const chunk = frame.subarray(
        offset,
        Math.min(frame.length, offset + chunkSize),
      );
      const descriptor = Buffer.from([offset === 0 ? 0x10 : 0x00]);
      packets.push(
        this.buildPacket(
          Buffer.concat([descriptor, chunk]),
          rtpTimestamp,
          offset + chunk.length >= frame.length,
        ),
      );
    }
    return packets;
  }
}

class Vp9Packetizer extends BasePacketizer {
  packetize(packet: EncodedPacket, rtpTimestamp: number): RtpPacket[] {
    const frame = toBuffer(packet.data);
    const chunkSize = this.maxPayloadSize - 1;
    if (chunkSize <= 0) {
      throw new Error("invalid VP9 RTP payload size");
    }

    const packets: RtpPacket[] = [];
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      const chunk = frame.subarray(
        offset,
        Math.min(frame.length, offset + chunkSize),
      );
      const descriptor = new BitWriter(8)
        .set(1, 0, 0)
        .set(1, 1, packet.type === "delta" ? 1 : 0)
        .set(1, 2, 0)
        .set(1, 3, 0)
        .set(1, 4, offset === 0 ? 1 : 0)
        .set(1, 5, offset + chunk.length >= frame.length ? 1 : 0)
        .set(1, 6, 0)
        .set(1, 7, 0).buffer;
      packets.push(
        this.buildPacket(
          Buffer.concat([descriptor, chunk]),
          rtpTimestamp,
          offset + chunk.length >= frame.length,
        ),
      );
    }
    return packets;
  }
}

class Av1Packetizer extends BasePacketizer {
  packetize(packet: EncodedPacket, rtpTimestamp: number): RtpPacket[] {
    const obus = splitAv1Obus(toBuffer(packet.data));
    const packets: RtpPacket[] = [];
    const fragmentSize = this.maxPayloadSize - 1;
    if (fragmentSize <= 0) {
      throw new Error("invalid AV1 RTP payload size");
    }

    let firstPacketInFrame = true;
    const startsNewCodedVideoSequence = packet.type === "key";
    for (const obu of obus) {
      if (obu.length <= fragmentSize) {
        const aggregationHeader = createAv1AggregationHeader({
          startsWithFragment: false,
          endsWithFragment: false,
          startsNewCodedVideoSequence:
            firstPacketInFrame && startsNewCodedVideoSequence,
        });
        packets.push(
          this.buildPacket(
            Buffer.concat([aggregationHeader, obu]),
            rtpTimestamp,
            false,
          ),
        );
        firstPacketInFrame = false;
        continue;
      }

      for (let offset = 0; offset < obu.length; offset += fragmentSize) {
        const chunk = obu.subarray(
          offset,
          Math.min(obu.length, offset + fragmentSize),
        );
        const aggregationHeader = createAv1AggregationHeader({
          startsWithFragment: offset > 0,
          endsWithFragment: offset + chunk.length < obu.length,
          startsNewCodedVideoSequence:
            firstPacketInFrame && startsNewCodedVideoSequence,
        });
        packets.push(
          this.buildPacket(
            Buffer.concat([aggregationHeader, chunk]),
            rtpTimestamp,
            false,
          ),
        );
        firstPacketInFrame = false;
      }
    }

    if (packets.length === 0) {
      throw new Error("AV1 sample did not contain any OBU data");
    }

    packets.at(-1)!.header.marker = true;
    return packets;
  }
}

class H264Packetizer extends BasePacketizer {
  private readonly naluLengthSize: number;
  private readonly parameterSets: Buffer[];

  constructor(
    codec: RTCRtpCodecParameters,
    decoderDescription: ArrayBuffer | ArrayBufferView | null,
  ) {
    super(codec);

    const packetizationMode = getH264PacketizationMode(codec.parameters);
    if (packetizationMode !== 1) {
      throw new Error(
        `Unsupported H264 packetization-mode=${packetizationMode}. File playback requires packetization-mode=1.`,
      );
    }

    const avcConfig = parseAvcDecoderConfiguration(decoderDescription);
    this.naluLengthSize = avcConfig?.naluLengthSize ?? 4;
    this.parameterSets = avcConfig
      ? [...avcConfig.sps.map(Buffer.from), ...avcConfig.pps.map(Buffer.from)]
      : [];
  }

  packetize(packet: EncodedPacket, rtpTimestamp: number): RtpPacket[] {
    let nalUnits = splitH264Sample(toBuffer(packet.data), this.naluLengthSize);
    if (
      packet.type === "key" &&
      this.parameterSets.length > 0 &&
      !containsH264ParameterSets(nalUnits)
    ) {
      nalUnits = [...this.parameterSets, ...nalUnits];
    }

    const packets: RtpPacket[] = [];

    nalUnits.forEach((nalUnit, index) => {
      const marker = index === nalUnits.length - 1;
      if (nalUnit.length <= this.maxPayloadSize) {
        packets.push(this.buildPacket(nalUnit, rtpTimestamp, marker));
        return;
      }

      const nalHeader = nalUnit[0];
      const fragmentPayload = nalUnit.subarray(1);
      const fragmentSize = this.maxPayloadSize - 2;
      if (fragmentSize <= 0) {
        throw new Error("invalid H264 RTP payload size");
      }

      const fuIndicator = (nalHeader & 0xe0) | 28;
      const nalType = nalHeader & 0x1f;

      for (
        let offset = 0;
        offset < fragmentPayload.length;
        offset += fragmentSize
      ) {
        const chunk = fragmentPayload.subarray(
          offset,
          Math.min(fragmentPayload.length, offset + fragmentSize),
        );
        const fuHeader = Buffer.from([
          (offset === 0 ? 0x80 : 0x00) |
            (offset + chunk.length >= fragmentPayload.length ? 0x40 : 0x00) |
            nalType,
        ]);
        packets.push(
          this.buildPacket(
            Buffer.concat([Buffer.from([fuIndicator]), fuHeader, chunk]),
            rtpTimestamp,
            marker && offset + chunk.length >= fragmentPayload.length,
          ),
        );
      }
    });

    return packets;
  }
}

function createAv1AggregationHeader({
  startsWithFragment,
  endsWithFragment,
  startsNewCodedVideoSequence,
}: {
  startsWithFragment: boolean;
  endsWithFragment: boolean;
  startsNewCodedVideoSequence: boolean;
}) {
  return new BitWriter(8)
    .set(1, 0, startsWithFragment ? 1 : 0)
    .set(1, 1, endsWithFragment ? 1 : 0)
    .set(2, 2, 1)
    .set(1, 4, startsNewCodedVideoSequence ? 1 : 0)
    .set(3, 5, 0).buffer;
}

function parseAvcDecoderConfiguration(
  decoderDescription: ArrayBuffer | ArrayBufferView | null,
) {
  if (!decoderDescription) {
    return null;
  }

  const description = toDescriptionBuffer(decoderDescription);
  if (description.length < 7) {
    throw new Error("invalid H264 decoder configuration");
  }

  const naluLengthSize = (description[4] & 0x03) + 1;
  const spsCount = description[5] & 0x1f;
  let offset = 6;

  const sps: Buffer[] = [];
  for (let index = 0; index < spsCount; index++) {
    const length = description.readUInt16BE(offset);
    offset += 2;
    sps.push(description.subarray(offset, offset + length));
    offset += length;
  }

  const ppsCount = description[offset] ?? 0;
  offset++;

  const pps: Buffer[] = [];
  for (let index = 0; index < ppsCount; index++) {
    const length = description.readUInt16BE(offset);
    offset += 2;
    pps.push(description.subarray(offset, offset + length));
    offset += length;
  }

  return { naluLengthSize, sps, pps };
}

function splitH264Sample(sample: Buffer, naluLengthSize: number) {
  if (looksLikeAnnexB(sample)) {
    const nalUnits: Buffer[] = [];
    const parser = new H264AnnexBParser(sample);
    let payload = parser.readNextNaluPayload();
    while (payload) {
      nalUnits.push(Buffer.from(payload.data));
      payload = parser.readNextNaluPayload();
    }
    return nalUnits;
  }

  const nalUnits: Buffer[] = [];
  let offset = 0;

  while (offset < sample.length) {
    const length = readUintLength(sample, offset, naluLengthSize);
    offset += naluLengthSize;
    const end = offset + length;
    if (end > sample.length) {
      throw new Error("invalid H264 sample length");
    }
    nalUnits.push(sample.subarray(offset, end));
    offset = end;
  }

  return nalUnits;
}

function splitAv1Obus(sample: Buffer) {
  const obus: Buffer[] = [];
  let offset = 0;

  while (offset < sample.length) {
    const start = offset;
    const header = sample[offset];
    offset += 1;
    if (header == undefined) {
      break;
    }

    const extensionFlag = getBit(header, 5);
    const hasSizeField = getBit(header, 6);
    if (extensionFlag) {
      offset += 1;
    }

    if (!hasSizeField) {
      obus.push(sample.subarray(start));
      break;
    }

    const [obuSize, leb128Length] = leb128decode(sample.subarray(offset));
    offset += leb128Length;
    const end = offset + obuSize;
    if (end > sample.length) {
      throw new Error("invalid AV1 OBU size");
    }
    obus.push(sample.subarray(start, end));
    offset = end;
  }

  return obus;
}

function containsH264ParameterSets(nalUnits: Buffer[]) {
  return nalUnits.some((nalUnit) => {
    const nalType = nalUnit[0] & 0x1f;
    return nalType === 7 || nalType === 8;
  });
}

function looksLikeAnnexB(sample: Buffer) {
  return (
    sample.length >= 4 &&
    sample[0] === 0x00 &&
    sample[1] === 0x00 &&
    ((sample[2] === 0x00 && sample[3] === 0x01) || sample[2] === 0x01)
  );
}

function readUintLength(buffer: Buffer, offset: number, length: number) {
  switch (length) {
    case 1:
      return buffer.readUInt8(offset);
    case 2:
      return buffer.readUInt16BE(offset);
    case 3:
      return buffer.readUIntBE(offset, 3);
    case 4:
      return buffer.readUInt32BE(offset);
    default:
      throw new Error(`unsupported H264 NALU length size: ${length}`);
  }
}

function getH264PacketizationMode(parameters?: string) {
  if (!parameters) {
    return 1;
  }

  const packetizationMode = parameters
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("packetization-mode="));

  if (!packetizationMode) {
    return 1;
  }

  return Number(packetizationMode.split("=")[1] ?? 1);
}

function toDescriptionBuffer(
  decoderDescription: ArrayBuffer | ArrayBufferView,
) {
  if (ArrayBuffer.isView(decoderDescription)) {
    return Buffer.from(
      decoderDescription.buffer,
      decoderDescription.byteOffset,
      decoderDescription.byteLength,
    );
  }

  return Buffer.from(decoderDescription);
}

function toBuffer(data: Uint8Array) {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
