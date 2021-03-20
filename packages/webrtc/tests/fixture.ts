import {
  RTCDtlsTransport,
  RTCIceGatherer,
  RTCIceTransport,
  RtpHeader,
  RtpPacket,
} from "../src";
import { RtpRouter } from "../src/media/router";

export const createRtpPacket = () => {
  const header = new RtpHeader({
    sequenceNumber: 0,
    timestamp: 0,
    payloadType: 96,
    payloadOffset: 12,
    extension: true,
    marker: false,
    padding: false,
  });
  const rtp = new RtpPacket(header, Buffer.from([]));
  return rtp;
};

export const createDtlsTransport = () => {
  const dtls = new RTCDtlsTransport(
    new RTCIceTransport(new RTCIceGatherer()),
    new RtpRouter(),
    []
  );
  return dtls;
};
