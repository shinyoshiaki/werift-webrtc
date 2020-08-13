import { RTCRtpHeaderExtensionParameters } from "../media/parameters";

export function useSdesMid(id = 1) {
  return new RTCRtpHeaderExtensionParameters({
    id,
    uri: "urn:ietf:params:rtp-hdrext:sdes:mid",
  });
}
