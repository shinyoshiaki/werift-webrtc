import { RTCRtpHeaderExtensionParameters } from "../media/parameters";

export function createSdesMid() {
  return new RTCRtpHeaderExtensionParameters({
    id: 1,
    uri: "urn:ietf:params:rtp-hdrext:sdes:mid",
  });
}
