import { BitStream, BitWriter2, BufferChain } from "werift-rtp";
import * as EBML from "./ebml/ebml.js";
import { decodeVintEncodedNumber } from "./ebml/ebml.js";

export function serializeSimpleBlock(
  frame: Buffer,
  isKeyframe: boolean,
  trackNumber: number,
  relativeTimestamp: number,
) {
  const elementId = Buffer.from([0xa3]);

  const contentSize: Uint8Array = EBML.vintEncodedNumber(
    1 + 2 + 1 + frame.length,
  ).bytes;

  const keyframe = isKeyframe ? 1 : 0;
  const flags = new BitWriter2(8)
    .set(keyframe)
    .set(0, 3)
    .set(0)
    .set(0, 2)
    .set(0);

  const simpleBlock = Buffer.concat([
    elementId,
    contentSize,
    EBML.vintEncodedNumber(trackNumber).bytes,
    new BufferChain(2).writeInt16BE(relativeTimestamp).buffer,
    new BufferChain(1).writeUInt8(flags.value).buffer,
    frame,
  ]);
  return simpleBlock;
}

export interface SimpleBlock {
  data: Buffer;
  trackNumber: number;
  isKeyframe: boolean;
}

export function deserializeSimpleBlocks(data: Buffer) {
  const frames: SimpleBlock[] = [];
  let position = 0;
  while (position < data.length) {
    // Element ID (SimpleBlock = 0xA3)
    const elementId = data[position];
    if (elementId !== 0xa3) {
      throw new Error(`unexpected element id 0x${elementId.toString(16)}`);
    }
    position += 1;

    // Content size VINT
    const { value: contentSize, length: contentSizeLength } =
      decodeVintEncodedNumber(data, position);
    position += contentSizeLength;

    // Track number VINT (we don't actually need the value here but must know its length)
    const { value: trackNumber, length: trackNumberLength } =
      decodeVintEncodedNumber(data, position);
    position += trackNumberLength;

    // Timecode (signed int16)
    position += 2;
    // Flags (1 byte)
    const flags = new BitStream(data.subarray(position, position + 1));
    const isKeyframe = (flags.readBits(1) as number) === 1;

    position += 1;

    const metaSize = trackNumberLength + 2 + 1; // track + timecode + flags
    const remaining = Number(contentSize) - metaSize;
    if (remaining < 0) {
      throw new Error("invalid simple block size");
    }
    const frame = data.subarray(position, position + remaining);
    frames.push({ data: frame, trackNumber: Number(trackNumber), isKeyframe });
    position += remaining;
  }
  return frames;
}
