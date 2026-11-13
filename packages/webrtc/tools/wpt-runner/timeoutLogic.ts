import type { WptTarget } from "./runner";

export interface WptTimeoutProfile {
  completionTimeoutMs: number;
  cleanupTimeoutMs: number;
  vmTimeoutMs: number;
}

const QUICK_TIMEOUT_PROFILE: WptTimeoutProfile = {
  completionTimeoutMs: 400,
  cleanupTimeoutMs: 150,
  vmTimeoutMs: 400,
};

const DEFAULT_TIMEOUT_PROFILE: WptTimeoutProfile = {
  completionTimeoutMs: 800,
  cleanupTimeoutMs: 200,
  vmTimeoutMs: 800,
};

const SLOW_TIMEOUT_PROFILE: WptTimeoutProfile = {
  completionTimeoutMs: 1_500,
  cleanupTimeoutMs: 300,
  vmTimeoutMs: 1_500,
};

/**
 * Allowlisted files whose many sequential subtests (`<meta name="timeout"
 * content="long">`) take longer than the heavy profile; a whole-file timeout
 * would drop every subtest result. The stress-glare files are not gated yet
 * (ticket cd89d492) but keep this profile so their results stay observable.
 */
const LONG_TIMEOUT_PROFILE: WptTimeoutProfile = {
  completionTimeoutMs: 45_000,
  cleanupTimeoutMs: 400,
  vmTimeoutMs: 2_500,
};
const LONG_TARGETS = [
  "webrtc/rtcrtptransceiver.https.html ?rest",
  "webrtc/rtcpeerconnection-perfect-negotiation.https.html",
  "webrtc/rtcpeerconnection-perfect-negotiation-stress-glare.https.html",
  "webrtc/rtcpeerconnection-perfect-negotiation-stress-glare-linear.https.html",
];

const HEAVY_TIMEOUT_PROFILE: WptTimeoutProfile = {
  completionTimeoutMs: 2_500,
  cleanupTimeoutMs: 400,
  vmTimeoutMs: 2_500,
};

/**
 * The profile of `target`, every limit multiplied by `scale` (the rerun of a
 * target that only regressed by timeouts uses a larger scale, see
 * `selectTimeoutRetryTargets`).
 */
export function resolveTimeoutProfile(
  target: Pick<WptTarget, "file" | "variant">,
  scale = 1,
): WptTimeoutProfile {
  const profile = resolveBaseTimeoutProfile(target);
  if (scale === 1) return profile;
  return {
    completionTimeoutMs: Math.round(profile.completionTimeoutMs * scale),
    cleanupTimeoutMs: Math.round(profile.cleanupTimeoutMs * scale),
    vmTimeoutMs: Math.round(profile.vmTimeoutMs * scale),
  };
}

function resolveBaseTimeoutProfile(
  target: Pick<WptTarget, "file" | "variant">,
) {
  const key =
    `${target.file}${target.variant ? ` ${target.variant}` : ""}`.toLowerCase();

  if (LONG_TARGETS.includes(key)) {
    return LONG_TIMEOUT_PROFILE;
  }

  if (
    matchesAny(key, [
      "gc",
      "capture-video",
      "getstats",
      "transport-stats",
      "track-stats",
    ])
  ) {
    return HEAVY_TIMEOUT_PROFILE;
  }

  if (
    matchesAny(key, [
      "datachannel",
      "perfect-negotiation",
      "handover",
      "restartice",
      "simulcast",
      "rollback",
      "transceiver",
      "remote-track",
      "dtls",
      "sctp",
      "video",
      "audio",
    ])
  ) {
    return SLOW_TIMEOUT_PROFILE;
  }

  if (
    matchesAny(key, [
      "constructor",
      "validation",
      "rtcerror",
      "historical",
      "legacy",
      "bundlepolicy",
      "icecandidatepoolsize",
      "icecandidate-constructor",
    ])
  ) {
    return QUICK_TIMEOUT_PROFILE;
  }

  return DEFAULT_TIMEOUT_PROFILE;
}

function matchesAny(value: string, patterns: string[]) {
  return patterns.some((pattern) => value.includes(pattern));
}
