import { useNACK, usePLI, useREMB } from "./extension/rtcpFeedback";
import { RTCRtpCodecParameters } from "./parameters";

export const useH264 = (props: Partial<RTCRtpCodecParameters> = {}) =>
  new RTCRtpCodecParameters({
    mimeType: "video/h264",
    clockRate: 90000,
    rtcpFeedback: [useNACK(), usePLI(), useREMB()],
    parameters:
      "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1",
    ...props,
  });

export const useVP8 = (props: Partial<RTCRtpCodecParameters> = {}) =>
  new RTCRtpCodecParameters({
    mimeType: "video/VP8",
    clockRate: 90000,
    rtcpFeedback: [useNACK(), usePLI(), useREMB()],
    ...props,
  });

export const useVP9 = (props: Partial<RTCRtpCodecParameters> = {}) =>
  new RTCRtpCodecParameters({
    mimeType: "video/VP9",
    clockRate: 90000,
    rtcpFeedback: [useNACK(), usePLI(), useREMB()],
    ...props,
  });

export const useAV1X = (props: Partial<RTCRtpCodecParameters> = {}) =>
  new RTCRtpCodecParameters({
    mimeType: "video/AV1X",
    clockRate: 90000,
    rtcpFeedback: [useNACK(), usePLI(), useREMB()],
    ...props,
  });

export const useOPUS = (props: Partial<RTCRtpCodecParameters> = {}) =>
  new RTCRtpCodecParameters({
    mimeType: "audio/OPUS",
    clockRate: 48000,
    channels: 2,
    ...props,
  });

export const usePCMU = (props: Partial<RTCRtpCodecParameters> = {}) =>
  new RTCRtpCodecParameters({
    mimeType: "audio/PCMU",
    clockRate: 8000,
    channels: 1,
    payloadType: 0,
    ...props,
  });

/** RFC 3551 static PT 8 / 8000 Hz. Not added to supportedCodecs (negotiation optional). */
export const usePCMA = (props: Partial<RTCRtpCodecParameters> = {}) =>
  new RTCRtpCodecParameters({
    mimeType: "audio/PCMA",
    clockRate: 8000,
    channels: 1,
    payloadType: 8,
    ...props,
  });

/** RFC 3551 static PT 9 / RTP clock 8000 Hz (codec samples at 16 kHz). */
export const useG722 = (props: Partial<RTCRtpCodecParameters> = {}) =>
  new RTCRtpCodecParameters({
    mimeType: "audio/G722",
    clockRate: 8000,
    channels: 1,
    payloadType: 9,
    ...props,
  });

export const supportedCodecs = [
  useAV1X(),
  useVP9(),
  useVP8(),
  useH264(),
  useOPUS(),
  usePCMU(),
].map((codec) => codec.mimeType);

export const supportedVideoCodecs = supportedCodecs.filter((codec) =>
  codec.toLowerCase().startsWith("video/"),
);

export const supportedAudioCodecs = supportedCodecs.filter((codec) =>
  codec.toLowerCase().startsWith("audio/"),
);
