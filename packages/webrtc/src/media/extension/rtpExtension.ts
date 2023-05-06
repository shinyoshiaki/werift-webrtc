import { RTP_EXTENSION_URI } from "../../../../rtp/src";
import { RTCRtpHeaderExtensionParameters } from "../parameters";

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
