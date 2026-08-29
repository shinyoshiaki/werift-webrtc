import {
  useAV1X,
  useH264,
  useOPUS,
  usePCMU,
  useVP8,
  useVP9,
} from "../media/codec";
import { RTCRtpCodecParameters } from "../media/parameters";
import type { SupportedSourceCodec } from "../nonstandard/userMedia/packetizer";
import type { MediaKind } from "./mediaRegister";

export type RtpCodecFromMimeTypeOptions = {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  payloadType?: number;
  parameters?: string;
  rtcpFeedback?: RTCRtpCodecParameters["rtcpFeedback"];
};

export function kindFromMimeType(mimeType: string): MediaKind {
  return mimeType.toLowerCase().startsWith("audio/") ? "audio" : "video";
}

export function rtpCodecFromMimeType(
  options: RtpCodecFromMimeTypeOptions,
): RTCRtpCodecParameters {
  const extra = extraCodecFields(options);
  const normalized = options.mimeType.toLowerCase();
  if (normalized.includes("pcmu")) {
    return usePCMU(extra);
  }
  try {
    return codecFromMimeType(options);
  } catch {
    const kind = kindFromMimeType(options.mimeType);
    return new RTCRtpCodecParameters({
      mimeType: options.mimeType,
      clockRate: extra.clockRate ?? (kind === "audio" ? 8_000 : 90_000),
      ...extra,
    });
  }
}

export function sourceCodecFromMimeType(
  mimeType: string,
): SupportedSourceCodec {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("h264") || normalized.includes("avc")) {
    return "avc";
  }
  if (normalized.includes("vp8")) {
    return "vp8";
  }
  if (normalized.includes("vp9")) {
    return "vp9";
  }
  if (normalized.includes("av1")) {
    return "av1";
  }
  if (normalized.includes("opus")) {
    return "opus";
  }
  throw new Error(`Unsupported encoded binary mimeType: ${mimeType}`);
}

export function codecFromMimeType(
  options: RtpCodecFromMimeTypeOptions,
): RTCRtpCodecParameters {
  const sourceCodec = sourceCodecFromMimeType(options.mimeType);
  const extra = extraCodecFields(options);
  switch (sourceCodec) {
    case "avc":
      return useH264(extra);
    case "vp8":
      return useVP8(extra);
    case "vp9":
      return useVP9(extra);
    case "av1":
      return useAV1X(extra);
    case "opus":
      return useOPUS(extra);
  }
}

function extraCodecFields(
  options: RtpCodecFromMimeTypeOptions,
): Partial<RTCRtpCodecParameters> {
  return {
    ...(options.clockRate != undefined ? { clockRate: options.clockRate } : {}),
    ...(options.channels != undefined ? { channels: options.channels } : {}),
    ...(options.payloadType != undefined
      ? { payloadType: options.payloadType }
      : {}),
    ...(options.parameters != undefined
      ? { parameters: options.parameters }
      : {}),
    ...(options.rtcpFeedback != undefined
      ? { rtcpFeedback: options.rtcpFeedback }
      : {}),
  };
}
