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
          return { uri, value: extension.payload.toString() };
        case RTP_EXTENSION_URI.transportWideCC:
          return { uri, value: extension.payload.readUInt16BE() };
        case RTP_EXTENSION_URI.absSendTime:
          return {
            uri,
            value: bufferReader(extension.payload, [3])[0],
          };
        case RTP_EXTENSION_URI.audioLevelIndication: {
          const stream = new BitStream(extension.payload);
          const value: AudioLevelIndicationPayload = {
            v: stream.readBits(1) === 1,
            level: stream.readBits(7),
          };
          return { uri, value };
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
