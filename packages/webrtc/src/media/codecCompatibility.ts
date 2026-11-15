import { createWebRtcDomException } from "../errors";
import { codecParametersFromString } from "../sdp";
import type { Kind } from "../types/domain";
import { RTCRtpCodecParameters } from "./parameters";

/**
 * Lower-cased MIME type with the legacy `video/AV1X` name folded into
 * `video/av1`, so both names negotiate with each other.
 */
export function normalizeCodecMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  return lower === "video/av1x" ? "video/av1" : lower;
}

function codecName(codec: RTCRtpCodecParameters) {
  return codec.name.toLowerCase();
}

function optionalEqual<T>(left: T | undefined, right: T | undefined) {
  return left == undefined || right == undefined || left === right;
}

function h264Parameters(codec: RTCRtpCodecParameters) {
  const parameters = codecParametersFromString(codec.parameters ?? "");
  return {
    packetizationMode: parameters["packetization-mode"],
    profileLevelId: parameters["profile-level-id"]?.toString().toLowerCase(),
  };
}

export function isCodecCompatible(
  source: RTCRtpCodecParameters,
  configured: RTCRtpCodecParameters,
) {
  if (
    normalizeCodecMimeType(source.mimeType) !==
    normalizeCodecMimeType(configured.mimeType)
  ) {
    return false;
  }
  if (source.clockRate !== configured.clockRate) return false;
  if (!optionalEqual(source.channels, configured.channels)) return false;
  if (codecName(source) !== "h264") return true;

  const sourceParameters = h264Parameters(source);
  const configuredParameters = h264Parameters(configured);
  if (
    !optionalEqual(
      sourceParameters.packetizationMode,
      configuredParameters.packetizationMode,
    )
  ) {
    return false;
  }
  return optionalEqual(
    sourceParameters.profileLevelId,
    configuredParameters.profileLevelId,
  );
}

function isAuxiliary(codec: RTCRtpCodecParameters) {
  return ["rtx", "red"].includes(codecName(codec));
}

/**
 * remote track が実際に配信する codec を返す。
 * audio の RED は RTCRtpReceiver が primary へ展開してから track へ渡すため、
 * RED が参照する primary codec (不明なら先頭の primary) を track の codec とする。
 */
export function deliveredTrackCodec(
  kind: string,
  codec: RTCRtpCodecParameters | undefined,
  negotiated: readonly RTCRtpCodecParameters[],
) {
  if (kind !== "audio" || codec == undefined || codecName(codec) !== "red") {
    return codec;
  }
  const [primaryPayloadType] = referencedPayloadTypes(codec);
  return (
    negotiated.find(
      (candidate) =>
        !isAuxiliary(candidate) && candidate.payloadType === primaryPayloadType,
    ) ??
    negotiated.find((candidate) => !isAuxiliary(candidate)) ??
    codec
  );
}

/**
 * 交渉済み codec 列から remote track の codec を決める。
 * 先頭の RTX (と video の RED / FEC) は飛ばし、audio の RED は
 * {@link deliveredTrackCodec} と同じく primary へ解決する。
 */
export function primaryTrackCodec(
  kind: string,
  negotiated: readonly RTCRtpCodecParameters[],
) {
  const first =
    negotiated.find((codec) =>
      kind === "audio"
        ? codecName(codec) !== "rtx"
        : !isAuxiliary(codec) &&
          !["ulpfec", "flexfec-03"].includes(codecName(codec)),
    ) ?? negotiated[0];
  return deliveredTrackCodec(kind, first, negotiated);
}

/**
 * RTX / RED を除く primary codec に MIME 一致が 1 つでもあるか。
 * remote m-line を local capability で扱えるかの判定 (Issue #705) に使う。
 */
export function hasCommonPrimaryMimeType(
  local: readonly RTCRtpCodecParameters[],
  remote: readonly RTCRtpCodecParameters[],
) {
  return local.some(
    (localCodec) =>
      !isAuxiliary(localCodec) &&
      remote.some(
        (remoteCodec) =>
          normalizeCodecMimeType(remoteCodec.mimeType) ===
          normalizeCodecMimeType(localCodec.mimeType),
      ),
  );
}

function referencedPayloadTypes(codec: RTCRtpCodecParameters) {
  const parameters = codec.parameters ?? "";
  if (codecName(codec) === "rtx") {
    const apt = Number(codecParametersFromString(parameters).apt);
    return Number.isNaN(apt) ? [] : [apt];
  }
  if (codecName(codec) === "red") {
    // `Number("")` is 0: a RED without fmtp references nothing.
    return parameters
      .split("/")
      .filter((value) => value.trim() !== "")
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
    normalizeCodecMimeType(candidate.mimeType) ===
      normalizeCodecMimeType(preference.mimeType) &&
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

/**
 * Configured codecs a negotiated m-line offers, before payload types are
 * mapped (`keepNegotiatedPayloadTypes`): `capability` plus the configured
 * counterpart of every negotiated codec that `capability` lacks.
 *
 * `eligible` is every configured codec of the kind with the fixed source and
 * the codec preferences applied but no direction filter, and `capability` is
 * the same for the current direction. A direction change (`direction`,
 * `removeTrack()`) therefore never takes a negotiated codec off the m-line;
 * only an answer does. Preferences and a fixed source still exclude one. An
 * RTX / RED is kept when its primaries are and it is in `capability` or
 * negotiated for the same primaries. The order is that of `eligible`
 * (preferences, then configuration), the order of a first offer.
 */
export function withNegotiatedCodecs(
  eligible: readonly RTCRtpCodecParameters[],
  capability: readonly RTCRtpCodecParameters[],
  negotiated: readonly RTCRtpCodecParameters[],
): RTCRtpCodecParameters[] {
  const candidates = [
    ...eligible,
    ...capability.filter((codec) => !eligible.includes(codec)),
  ];
  const primaryOf = (
    codecs: readonly RTCRtpCodecParameters[],
    payloadType: number,
  ) =>
    codecs.find(
      (codec) => !isAuxiliary(codec) && codec.payloadType === payloadType,
    );
  const kept = new Set(
    candidates.filter(
      (codec) =>
        !isAuxiliary(codec) &&
        (capability.includes(codec) ||
          negotiated.some(
            (other) => !isAuxiliary(other) && isCodecCompatible(other, codec),
          )),
    ),
  );
  const negotiatedForSamePrimaries = (codec: RTCRtpCodecParameters) => {
    const primaries = referencedPayloadTypes(codec).map((payloadType) =>
      primaryOf(candidates, payloadType),
    );
    return negotiated.some((other) => {
      if (codecName(other) !== codecName(codec)) return false;
      const otherPrimaries = referencedPayloadTypes(other).map((payloadType) =>
        primaryOf(negotiated, payloadType),
      );
      return (
        otherPrimaries.length === primaries.length &&
        primaries.every((primary, index) => {
          const otherPrimary = otherPrimaries[index];
          return (
            primary != undefined &&
            otherPrimary != undefined &&
            isCodecCompatible(otherPrimary, primary)
          );
        })
      );
    });
  };
  return candidates.filter((codec) => {
    if (!isAuxiliary(codec)) return kept.has(codec);
    const primaries = referencedPayloadTypes(codec).map((payloadType) =>
      primaryOf(candidates, payloadType),
    );
    if (primaries.some((primary) => primary == undefined || !kept.has(primary)))
      return false;
    return capability.includes(codec) || negotiatedForSamePrimaries(codec);
  });
}

/**
 * The format parameters (`a=fmtp`) a payload type stands for, in a form that
 * compares equal when the parameters mean the same: parameter names are
 * case-insensitive and unordered, and H264 gets its RFC 6184 §8.1 defaults
 * (`packetization-mode` 0, `profile-level-id` 42000A, case-insensitive), so
 * an omitted parameter and its default are the same format. Anything else
 * (an RTX `apt`, the primaries of a RED `110/110`) is compared as written.
 */
function formatParameters(codec: RTCRtpCodecParameters) {
  const entries = new Map<string, string>();
  for (const item of (codec.parameters ?? "").split(";")) {
    const parameter = item.trim();
    if (parameter.length === 0) continue;
    const separator = parameter.indexOf("=");
    if (separator < 0) {
      entries.set(parameter, "");
      continue;
    }
    entries.set(
      parameter.slice(0, separator).trim().toLowerCase(),
      parameter.slice(separator + 1).trim(),
    );
  }
  if (codecName(codec) === "h264") {
    entries.set("packetization-mode", entries.get("packetization-mode") ?? "0");
    entries.set(
      "profile-level-id",
      (entries.get("profile-level-id") ?? "42000a").toLowerCase(),
    );
  }
  return [...entries]
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join(";");
}

/**
 * The RTCP feedback (`a=rtcp-fb`) a payload type stands for, unordered and
 * without duplicates, with the type and parameter compared case-insensitively.
 */
function feedbackTypes(codec: RTCRtpCodecParameters) {
  return [
    ...new Set(
      codec.rtcpFeedback.map((feedback) =>
        `${feedback.type} ${feedback.parameter ?? ""}`.trim().toLowerCase(),
      ),
    ),
  ]
    .sort()
    .join(";");
}

/**
 * Whether two codecs can share a payload type in one BUNDLE group (RFC 3264
 * §8.3.2, RFC 8843 §9.1): the same codec with the same format parameters and
 * RTCP feedback, the attributes RFC 8859 puts in the IDENTICAL-PER-PT
 * category (`a=fmtp`, `a=rtcp-fb`). So an H264 format with another
 * `packetization-mode` or `profile-level-id`, an RTX for another `apt`, a RED
 * with other primaries or a VP8 with other feedback is another codec.
 */
function samePayloadMapping(
  left: RTCRtpCodecParameters,
  right: RTCRtpCodecParameters,
) {
  return (
    normalizeCodecMimeType(left.mimeType) ===
      normalizeCodecMimeType(right.mimeType) &&
    left.clockRate === right.clockRate &&
    (left.channels ?? 1) === (right.channels ?? 1) &&
    formatParameters(left) === formatParameters(right) &&
    feedbackTypes(left) === feedbackTypes(right)
  );
}

function withPayloadType(
  codec: RTCRtpCodecParameters,
  payloadType: number,
  parameters = codec.parameters,
) {
  if (codec.payloadType === payloadType && codec.parameters === parameters) {
    return codec;
  }
  const next = new RTCRtpCodecParameters({
    mimeType: codec.mimeType,
    clockRate: codec.clockRate,
    ...(codec.channels != undefined ? { channels: codec.channels } : {}),
    payloadType,
    rtcpFeedback: codec.rtcpFeedback.map((feedback) => ({ ...feedback })),
    ...(parameters != undefined ? { parameters } : {}),
    direction: codec.direction,
  });
  return next;
}

/**
 * Offer codecs for a negotiated m-line (RFC 8829 §5.2.2, RFC 3264 §8.3.2):
 * `capability` (configured payload types, in offer order) with each codec
 * that is already negotiated moved to its negotiated payload type.
 *
 * A codec offered again keeps its configured payload type unless that type is
 * already used on this m-line or maps to another codec in `taken` (every
 * payload type the session uses; the same codec with other format parameters
 * or RTCP feedback, such as a RED with other primaries, is another codec);
 * then it takes a free dynamic type (96-127,
 * then 35-63). RTX `apt` and RED references follow their primaries, and an
 * RTX / RED whose primary is not offered is dropped. The order of
 * `capability` is kept.
 */
export function keepNegotiatedPayloadTypes(
  capability: readonly RTCRtpCodecParameters[],
  negotiated: readonly RTCRtpCodecParameters[],
  taken: ReadonlyMap<number, RTCRtpCodecParameters>,
): RTCRtpCodecParameters[] {
  const offered: (RTCRtpCodecParameters | undefined)[] = capability.map(
    () => undefined,
  );
  const used = new Set<number>();
  const primaryPayloadType = new Map<number, number>();
  const matched = new Set<RTCRtpCodecParameters>();
  const isFree = (payloadType: number, codec: RTCRtpCodecParameters) => {
    if (used.has(payloadType)) return false;
    const owner = taken.get(payloadType);
    return owner == undefined || samePayloadMapping(owner, codec);
  };
  const pick = (preferred: number, codec: RTCRtpCodecParameters) => {
    if (isFree(preferred, codec)) return preferred;
    for (const [from, to] of [
      [96, 127],
      [35, 63],
    ]) {
      for (let payloadType = from; payloadType <= to; payloadType++) {
        if (isFree(payloadType, codec)) return payloadType;
      }
    }
    return undefined;
  };
  const place = (index: number, codec: RTCRtpCodecParameters) => {
    offered[index] = codec;
    used.add(codec.payloadType);
  };

  // 1. Negotiated primaries keep their payload types.
  capability.forEach((codec, index) => {
    if (isAuxiliary(codec)) return;
    const match = negotiated.find(
      (candidate) =>
        !isAuxiliary(candidate) &&
        !matched.has(candidate) &&
        isCodecCompatible(candidate, codec),
    );
    if (!match || used.has(match.payloadType)) return;
    matched.add(match);
    primaryPayloadType.set(codec.payloadType, match.payloadType);
    place(index, withPayloadType(codec, match.payloadType));
  });
  // 2. Primaries offered again.
  capability.forEach((codec, index) => {
    if (isAuxiliary(codec) || offered[index]) return;
    const payloadType = pick(codec.payloadType, codec);
    if (payloadType == undefined) return;
    primaryPayloadType.set(codec.payloadType, payloadType);
    place(index, withPayloadType(codec, payloadType));
  });
  // 3. RTX / RED follow their primaries.
  capability.forEach((codec, index) => {
    if (!isAuxiliary(codec)) return;
    const references = referencedPayloadTypes(codec).map((payloadType) =>
      primaryPayloadType.get(payloadType),
    );
    // A video RED has no fmtp (nothing references a primary): it is offered
    // as configured. An RTX, or a RED that names primaries, needs them offered.
    const standalone = codecName(codec) === "red" && references.length === 0;
    if (
      !standalone &&
      (references.length === 0 ||
        references.some((payloadType) => payloadType == undefined))
    ) {
      return;
    }
    const parameters = standalone
      ? codec.parameters
      : codecName(codec) === "rtx"
        ? (codec.parameters ?? "").replace(
            /(^|;)\s*apt=\d+/,
            `$1apt=${references[0]}`,
          )
        : references.join("/");
    const candidate = withPayloadType(codec, codec.payloadType, parameters);
    const negotiatedPayloadType = negotiated.find(
      (other) =>
        codecName(other) === codecName(codec) &&
        (codecName(codec) === "rtx"
          ? referencedPayloadTypes(other)[0] === references[0]
          : (other.parameters ?? "") === parameters),
    )?.payloadType;
    const payloadType =
      negotiatedPayloadType != undefined && !used.has(negotiatedPayloadType)
        ? negotiatedPayloadType
        : pick(codec.payloadType, candidate);
    if (payloadType == undefined) return;
    place(index, withPayloadType(candidate, payloadType));
  });
  return offered.filter((codec) => codec != undefined);
}
