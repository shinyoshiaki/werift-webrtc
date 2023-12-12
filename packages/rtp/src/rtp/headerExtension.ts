import { BitStream, bufferReader, bufferWriter } from "../../../common/src";
import { Extension } from "./rtp";

export const RTP_EXTENSION_URI = {
  sdesMid: "urn:ietf:params:rtp-hdrext:sdes:mid",
  sdesRTPStreamID: "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
  repairedRtpStreamId: "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id",
  transportWideCC:
    "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
  absSendTime: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
  dependencyDescriptor:
    "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension",
  audioLevelIndication: "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
} as const;

export type TransportWideCCPayload = number;

export type AudioLevelIndicationPayload = { v: boolean; level: number };

export function rtpHeaderExtensionsParser(
  extensions: Extension[],
  extIdUriMap: { [id: number]: string }
): { [uri: string]: any } {
  return extensions
    .map((extension) => {
      const uri = extIdUriMap[extension.id];
      switch (uri) {
        case RTP_EXTENSION_URI.sdesMid:
        case RTP_EXTENSION_URI.sdesRTPStreamID:
        case RTP_EXTENSION_URI.repairedRtpStreamId:
          return { uri, value: deserializeString(extension.payload) };
        case RTP_EXTENSION_URI.transportWideCC:
          return { uri, value: deserializeUint16BE(extension.payload) };
        case RTP_EXTENSION_URI.absSendTime:
          return {
            uri,
            value: deserializeAbsSendTime(extension.payload),
          };
        case RTP_EXTENSION_URI.audioLevelIndication: {
          return {
            uri,
            value: deserializeAudioLevelIndication(extension.payload),
          };
        }
        default:
          return { uri, value: 0 };
      }
    })
    .reduce((acc: { [uri: string]: any }, cur) => {
      if (cur) acc[cur.uri] = cur.value;
      return acc;
    }, {});
}

export function serializeSdesMid(id: string) {
  return Buffer.from(id);
}

export function serializeSdesRTPStreamID(id: string) {
  return Buffer.from(id);
}

export function serializeRepairedRtpStreamId(id: string) {
  return Buffer.from(id);
}

export function serializeTransportWideCC(transportSequenceNumber: number) {
  return bufferWriter([2], [transportSequenceNumber]);
}

export function serializeAbsSendTime(ntpTime: bigint) {
  const buf = Buffer.alloc(3);
  const time = (ntpTime >> 14n) & 0x00ffffffn;
  buf.writeUIntBE(Number(time), 0, 3);
  return buf;
}

export function serializeAudioLevelIndication(level: number) {
  const stream = new BitStream(Buffer.alloc(1));
  stream.writeBits(1, 1);
  stream.writeBits(level, 7);

  return stream.uint8Array;
}

export function deserializeString(buf: Buffer) {
  return buf.toString();
}

export function deserializeUint16BE(buf: Buffer) {
  return buf.readUInt16BE();
}

export function deserializeAbsSendTime(buf: Buffer) {
  return bufferReader(buf, [3])[0];
}

export function deserializeAudioLevelIndication(buf: Buffer) {
  const stream = new BitStream(buf);
  const value: AudioLevelIndicationPayload = {
    v: stream.readBits(1) === 1,
    level: stream.readBits(7),
  };
  return value;
}
