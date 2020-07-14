import { RTCRtpCodecParameters, RTCRtcpFeedback } from "./parameters";

export const CODECS = {
  audio: [
    new RTCRtpCodecParameters({
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
      payloadType: 96,
    }),
  ],
  video: [
    new RTCRtpCodecParameters({
      mimeType: "video/VP8",
      clockRate: 90000,
      payloadType: 97,
      rtcpFeedback: [
        new RTCRtcpFeedback({ type: "nack" }),
        new RTCRtcpFeedback({ type: "nack", parameter: "pli" }),
        new RTCRtcpFeedback({ type: "goog-remb" }),
      ],
      parameters: {},
    }),
  ],
};

export const HEADER_EXTENSIONS = {
  audio: [],
  video: [],
};
