import { RTCRtpHeaderExtensionParameters } from "../parameters";

export const RTP_EXTENSION_URI = {
  sdesMid: "urn:ietf:params:rtp-hdrext:sdes:mid",
  sdesRTPStreamID: "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
  repairedRtpStreamId: "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id",
  transportWideCC:
    "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
  absSendTime: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
  dependencyDescriptor:
    "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension",
} as const;

export function useSdesMid() {
  return new RTCRtpHeaderExtensionParameters({
    uri: RTP_EXTENSION_URI.sdesMid,
  });
}

export function useSdesRTPStreamId() {
  return new RTCRtpHeaderExtensionParameters({
    uri: RTP_EXTENSION_URI.sdesRTPStreamID,
  });
}

export function useRepairedRtpStreamId() {
  return new RTCRtpHeaderExtensionParameters({
    uri: RTP_EXTENSION_URI.repairedRtpStreamId,
  });
}

export function useTransportWideCC() {
  return new RTCRtpHeaderExtensionParameters({
    uri: RTP_EXTENSION_URI.transportWideCC,
  });
}

export function useAbsSendTime() {
  return new RTCRtpHeaderExtensionParameters({
    uri: RTP_EXTENSION_URI.absSendTime,
  });
}

export function useDependencyDescriptor() {
  return new RTCRtpHeaderExtensionParameters({
    uri: RTP_EXTENSION_URI.dependencyDescriptor,
  });
}
