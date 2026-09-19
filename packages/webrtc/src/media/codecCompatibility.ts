import { createWebRtcDomException } from "../errors";
import { codecParametersFromString } from "../sdp";
import type { Kind } from "../types/domain";
import type { RTCRtpCodecParameters } from "./parameters";

function codecName(codec: RTCRtpCodecParameters) {
  return codec.name.toLowerCase();
}

function optionalEqual<T>(left: T | undefined, right: T | undefined) {
  return left == undefined || right == undefined || left === right;
}

export function isCodecCompatible(
  source: RTCRtpCodecParameters,
  configured: RTCRtpCodecParameters,
) {
  if (source.mimeType.toLowerCase() !== configured.mimeType.toLowerCase()) {
    return false;
  }
  if (source.clockRate !== configured.clockRate) return false;
  if (!optionalEqual(source.channels, configured.channels)) return false;
  if (codecName(source) !== "h264") return true;

  const sourceParameters = codecParametersFromString(source.parameters ?? "");
  const configuredParameters = codecParametersFromString(
    configured.parameters ?? "",
  );
  return (
    optionalEqual(
      sourceParameters["packetization-mode"],
      configuredParameters["packetization-mode"],
    ) &&
    optionalEqual(
      sourceParameters["profile-level-id"]?.toLowerCase(),
      configuredParameters["profile-level-id"]?.toLowerCase(),
    )
  );
}

/** SDP negotiation compatibility. Unlike fixed-source constraints, H264 level
 * differences are allowed when both endpoints advertise level asymmetry. */
export function isRemoteCodecCompatible(
  local: RTCRtpCodecParameters,
  remote: RTCRtpCodecParameters,
) {
  if (local.mimeType.toLowerCase() !== remote.mimeType.toLowerCase()) {
    return false;
  }
  if (local.clockRate !== remote.clockRate) return false;
  if (!optionalEqual(local.channels, remote.channels)) return false;
  if (codecName(local) !== "h264") return true;

  const localParameters = codecParametersFromString(local.parameters ?? "");
  const remoteParameters = codecParametersFromString(remote.parameters ?? "");
  if (
    !optionalEqual(
      localParameters["packetization-mode"],
      remoteParameters["packetization-mode"],
    )
  ) {
    return false;
  }
  const localProfileLevelId =
    localParameters["profile-level-id"]?.toLowerCase();
  const remoteProfileLevelId =
    remoteParameters["profile-level-id"]?.toLowerCase();
  if (localProfileLevelId == undefined || remoteProfileLevelId == undefined) {
    return true;
  }
  if (localProfileLevelId.slice(0, 4) !== remoteProfileLevelId.slice(0, 4)) {
    return false;
  }
  const levelAsymmetryAllowed =
    String(localParameters["level-asymmetry-allowed"]) === "1" &&
    String(remoteParameters["level-asymmetry-allowed"]) === "1";
  return levelAsymmetryAllowed || localProfileLevelId === remoteProfileLevelId;
}

function isAuxiliary(codec: RTCRtpCodecParameters) {
  return ["rtx", "red"].includes(codecName(codec));
}

function referencedPayloadTypes(codec: RTCRtpCodecParameters) {
  const parameters = codec.parameters ?? "";
  if (codecName(codec) === "rtx") {
    const apt = Number(codecParametersFromString(parameters).apt);
    return Number.isNaN(apt) ? [] : [apt];
  }
  if (codecName(codec) === "red") {
    return parameters
      .split("/")
      .map(Number)
      .filter((value) => !Number.isNaN(value));
  }
  return [];
}

function withAuxiliaryCodecs(
  configured: RTCRtpCodecParameters[],
  primary: RTCRtpCodecParameters[],
) {
  const keptPayloadTypes = new Set(primary.map((codec) => codec.payloadType));
  const auxiliary = configured.filter((codec) => {
    if (!isAuxiliary(codec)) return false;
    const referenced = referencedPayloadTypes(codec);
    return (
      referenced.length > 0 &&
      referenced.every((payloadType) => keptPayloadTypes.has(payloadType))
    );
  });
  return configured.filter(
    (codec) => primary.includes(codec) || auxiliary.includes(codec),
  );
}

export function intersectCodecs(
  configured: RTCRtpCodecParameters[],
  source: readonly RTCRtpCodecParameters[],
) {
  const primary = configured.filter(
    (codec) =>
      !isAuxiliary(codec) &&
      source.some((sourceCodec) => isCodecCompatible(sourceCodec, codec)),
  );
  return withAuxiliaryCodecs(configured, primary);
}

function matchesPreference(
  candidate: RTCRtpCodecParameters,
  preference: RTCRtpCodecParameters,
) {
  return (
    candidate.mimeType.toLowerCase() === preference.mimeType.toLowerCase() &&
    optionalEqual(candidate.clockRate, preference.clockRate)
  );
}

export function applyCodecPreferences(
  configured: RTCRtpCodecParameters[],
  preferences: readonly RTCRtpCodecParameters[] | undefined,
) {
  if (preferences == undefined) return configured;
  const preferred = preferences.flatMap((preference) => {
    const match = configured.find((codec) =>
      matchesPreference(codec, preference),
    );
    return match ? [match] : [];
  });
  const uniquePreferred = [...new Set(preferred)];
  const referencedByPreferredAuxiliary = new Set(
    uniquePreferred.filter(isAuxiliary).flatMap(referencedPayloadTypes),
  );
  const primary = configured.filter(
    (codec) =>
      !isAuxiliary(codec) &&
      (uniquePreferred.includes(codec) ||
        referencedByPreferredAuxiliary.has(codec.payloadType)),
  );
  const allowed = withAuxiliaryCodecs(configured, primary);
  return [
    ...uniquePreferred.filter((codec) => allowed.includes(codec)),
    ...allowed.filter((codec) => !uniquePreferred.includes(codec)),
  ];
}

export function resolveCodecs(
  configured: RTCRtpCodecParameters[],
  source: readonly RTCRtpCodecParameters[] | undefined,
  preferences: readonly RTCRtpCodecParameters[] | undefined,
) {
  return applyCodecPreferences(
    source == undefined ? configured : intersectCodecs(configured, source),
    preferences,
  );
}

function list(codecs: readonly RTCRtpCodecParameters[] | undefined) {
  return codecs?.map((codec) => codec.mimeType).join(", ") || "(none)";
}

export function assertCodecsSupported(options: {
  kind: Kind;
  configured: RTCRtpCodecParameters[];
  source: readonly RTCRtpCodecParameters[] | undefined;
  preferences: readonly RTCRtpCodecParameters[] | undefined;
}) {
  const { kind, configured, source, preferences } = options;
  const sourceCompatible =
    source == undefined ? configured : intersectCodecs(configured, source);
  if (source != undefined && sourceCompatible.length === 0) {
    throw createWebRtcDomException(
      "NotSupportedError",
      `Track codec ${list(source)} is not supported by this RTCPeerConnection. Configured ${kind} codecs: ${list(configured)}`,
    );
  }
  const effective = applyCodecPreferences(sourceCompatible, preferences);
  if (effective.length === 0) {
    throw createWebRtcDomException(
      "NotSupportedError",
      `No codec remains after applying codec preferences. Source codecs: ${list(source)} Configured codecs: ${list(configured)} Preferred codecs: ${list(preferences)}`,
    );
  }
  return effective;
}
