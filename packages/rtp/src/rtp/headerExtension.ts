import { BitStream, bufferReader, bufferWriter } from "../../../common/src";
import type { Extension } from "./rtp";

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
  videoOrientation: "urn:3gpp:video-orientation",
} as const;

export type TransportWideCCPayload = number;

export type AudioLevelIndicationPayload = { v: boolean; level: number };
export interface videoOrientationPayload {
  /**
   Camera: indicates the direction of the camera used for this video stream. It can be used by the MTSI client in
  receiver to e.g. display the received video differently depending on the source camera.
  0: Front-facing camera, facing the user. If camera direction is unknown by the sending MTSI client in the terminal
  then this is the default value used.
  1: Back-facing camera, facing away from the user. 
 */
  c: number;
  /**
   F = Flip: indicates a horizontal (left-right flip) mirror operation on the video as sent on the link.
  0: No flip operation. If the sending MTSI client in terminal does not know if a horizontal mirror operation is
  necessary, then this is the default value used.
  1: Horizontal flip operation 
   */
  f: number;
  /**
   R1, R0 = Rotation: indicates the rotation of the video as transmitted on the link. The receiver should rotate the video to
  compensate that rotation. E.g. a 90° Counter Clockwise rotation should be compensated by the receiver with a 90°
  Clockwise rotation prior to displaying. 

    +----+----+-----------------------------------------------+------------------------------+
  | R1 | R0 | Rotation of the video as sent on the link     | Rotation on the receiver      |
  |    |    |                                               | before display                |
  +----+----+-----------------------------------------------+------------------------------+
  |  0 |  0 | 0° rotation                                   | None                         |
  +----+----+-----------------------------------------------+------------------------------+
  |  0 |  1 | 90° Counter Clockwise (CCW) rotation or 270°  | 90° Clockwise (CW) rotation  |
  |    |    | Clockwise (CW) rotation                       |                              |
  +----+----+-----------------------------------------------+------------------------------+
  |  1 |  0 | 180° CCW rotation or 180° CW rotation         | 180° CW rotation             |
  +----+----+-----------------------------------------------+------------------------------+
  |  1 |  1 | 270° CCW rotation or 90° CW rotation          | 90° CCW rotation             |
  +----+----+-----------------------------------------------+------------------------------+

   */
  r1: number;
  r0: number;
}

export interface Extensions {
  [uri: string]: any;
}

export function rtpHeaderExtensionsParser(
  extensions: Extension[],
  extIdUriMap: { [id: number]: string },
): Extensions {
  return extensions
    .map((extension) => {
      const uri = extIdUriMap[extension.id];
      if (!uri) {
        return { uri: "unknown", value: extension.payload };
      }
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
        case RTP_EXTENSION_URI.videoOrientation:
          return { uri, value: deserializeVideoOrientation(extension.payload) };
        default:
          return { uri, value: extension.payload };
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
  stream.writeBits(7, level);

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

export function deserializeVideoOrientation(payload: Buffer) {
  const stream = new BitStream(payload);
  stream.readBits(4);
  const value: videoOrientationPayload = {
    c: stream.readBits(1),
    f: stream.readBits(1),
    r1: stream.readBits(1),
    r0: stream.readBits(1),
  };
  return value;
}
