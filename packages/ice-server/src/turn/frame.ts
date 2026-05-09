import { paddingLength } from "../stun/message";

export interface ChannelDataMessage {
  channelNumber: number;
  data: Buffer;
}

export function isChannelData(data: Buffer) {
  return data.length >= 4 && (data[0] & 0xc0) === 0x40;
}

export function encodeChannelData(channelNumber: number, data: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(channelNumber, 0);
  header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}

export function decodeChannelData(
  data: Buffer,
): ChannelDataMessage | undefined {
  if (!isChannelData(data) || data.length < 4) {
    return undefined;
  }

  const channelNumber = data.readUInt16BE(0);
  const length = data.readUInt16BE(2);
  if (data.length < 4 + length) {
    return undefined;
  }

  return {
    channelNumber,
    data: data.subarray(4, 4 + length),
  };
}

export function padTurnFrame(data: Buffer) {
  const padding = paddingLength(data.length);
  return padding > 0 ? Buffer.concat([data, Buffer.alloc(padding)]) : data;
}

export function splitTurnTcpFrames(buffer: Buffer) {
  const frames: Buffer[] = [];
  let offset = 0;
  let malformed = false;

  while (buffer.length - offset >= 4) {
    let frameLength: number;

    if (isChannelData(buffer.subarray(offset))) {
      const payloadLength = buffer.readUInt16BE(offset + 2);
      frameLength = 4 + payloadLength + paddingLength(payloadLength);
    } else if ((buffer[offset] & 0xc0) === 0) {
      if (buffer.length - offset < 20) {
        break;
      }
      const stunBodyLength = buffer.readUInt16BE(offset + 2);
      frameLength = 20 + stunBodyLength + paddingLength(stunBodyLength);
    } else {
      malformed = true;
      break;
    }

    if (buffer.length - offset < frameLength) {
      break;
    }

    frames.push(buffer.subarray(offset, offset + frameLength));
    offset += frameLength;
  }

  return {
    frames,
    malformed,
    rest: buffer.subarray(offset),
  };
}
