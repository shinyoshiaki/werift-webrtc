import { createWebRtcDomException } from "../errors";
import { codecParametersFromString, codecParametersToString } from "../sdp";
import type { Kind } from "../types/domain";
import { cloneCodecParameters } from "./codec";
import type { RTCRtpCodecParameters } from "./parameters";

function codecName(codec: RTCRtpCodecParameters) {
  return codec.name.toLowerCase();
}

function optionalEqual<T>(left: T | undefined, right: T | undefined) {
  return left == undefined || right == undefined || left === right;
}

const DEFAULT_H264_PROFILE_LEVEL_ID = "42e01f";

function h264Parameters(codec: RTCRtpCodecParameters) {
  const parameters = codecParametersFromString(codec.parameters ?? "");
  return {
    parameters,
    packetizationMode: Number(parameters["packetization-mode"] ?? 0),
    profileLevelId: String(
      parameters["profile-level-id"] ?? DEFAULT_H264_PROFILE_LEVEL_ID,
    ).toLowerCase(),
  };
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

  const sourceParameters = h264Parameters(source);
  const configuredParameters = h264Parameters(configured);
  if (
    sourceParameters.packetizationMode !==
    configuredParameters.packetizationMode
  ) {
    return false;
  }
  const sourceProfile = parseH264ProfileLevelId(
    sourceParameters.profileLevelId,
  );
  const configuredProfile = parseH264ProfileLevelId(
    configuredParameters.profileLevelId,
  );
  return (
    sourceProfile != undefined &&
    configuredProfile != undefined &&
    sourceProfile.profile === configuredProfile.profile &&
    sourceProfile.level === configuredProfile.level
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

  const localParameters = h264Parameters(local);
  const remoteParameters = h264Parameters(remote);
  if (
    localParameters.packetizationMode !== remoteParameters.packetizationMode
  ) {
    return false;
  }
  const localProfile = parseH264ProfileLevelId(localParameters.profileLevelId);
  const remoteProfile = parseH264ProfileLevelId(
    remoteParameters.profileLevelId,
  );
  if (
    !localProfile ||
    !remoteProfile ||
    localProfile.profile !== remoteProfile.profile
  ) {
    return false;
  }
  return true;
}

export function negotiateRemoteCodec(
  local: RTCRtpCodecParameters,
  remote: RTCRtpCodecParameters,
) {
  if (codecName(local) !== "h264") return remote;
  const localParameters = h264Parameters(local);
  const remoteParameters = h264Parameters(remote);
  const localId = localParameters.profileLevelId;
  const remoteId = remoteParameters.profileLevelId;
  const localProfile = parseH264ProfileLevelId(localId);
  const remoteProfile = parseH264ProfileLevelId(remoteId);
  if (!localProfile || !remoteProfile) return remote;
  const asymmetryAllowed =
    String(localParameters.parameters["level-asymmetry-allowed"]) === "1" &&
    String(remoteParameters.parameters["level-asymmetry-allowed"]) === "1";
  const negotiatedId = asymmetryAllowed
    ? localId
    : h264LevelRank(localProfile.level) <= h264LevelRank(remoteProfile.level)
      ? localId
      : remoteId;
  const negotiated = cloneCodecParameters(remote);
  negotiated.parameters = codecParametersToString({
    ...remoteParameters.parameters,
    "packetization-mode": remoteParameters.packetizationMode,
    "profile-level-id": negotiatedId,
  });
  return negotiated;
}

function h264LevelRank(level: number | string) {
  return level === "1b" ? 10.5 : Number(level);
}

function parseH264ProfileLevelId(value: string) {
  if (!/^[0-9a-f]{6}$/i.test(value) || value === "000000") return;
  const numeric = Number.parseInt(value, 16);
  const profileIdc = (numeric >> 16) & 0xff;
  const profileIop = (numeric >> 8) & 0xff;
  const levelIdc = numeric & 0xff;
  const patterns: Array<[number, number, number, string]> = [
    [0x42, 0x4f, 0x40, "constrained-baseline"],
    [0x4d, 0x8f, 0x80, "constrained-baseline"],
    [0x58, 0xcf, 0xc0, "constrained-baseline"],
    [0x42, 0x4f, 0x00, "baseline"],
    [0x58, 0xcf, 0x80, "baseline"],
    [0x4d, 0xaf, 0x00, "main"],
    [0x64, 0xff, 0x00, "high"],
    [0x64, 0xff, 0x0c, "constrained-high"],
    [0xf4, 0xff, 0x00, "predictive-high-444"],
  ];
  const profile = patterns.find(
    ([idc, mask, expected]) =>
      profileIdc === idc && (profileIop & mask) === expected,
  )?.[3];
  if (!profile) return;
  const level =
    levelIdc === 0x0b && (profileIop & 0x10) !== 0 ? "1b" : levelIdc;
  return { profile, level };
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
