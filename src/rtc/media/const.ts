import { RTCRtpCodecParameters } from "./parameters";

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
        { type: "ccm", parameter: "fir" },
        { type: "nack" },
        { type: "nack", parameter: "pli" },
        { type: "transport-cc" },
      ],
    }),
  ],
};

export const HEADER_EXTENSIONS = {
  audio: [],
  video: [],
};
