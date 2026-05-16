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

const HEAVY_TIMEOUT_PROFILE: WptTimeoutProfile = {
  completionTimeoutMs: 2_500,
  cleanupTimeoutMs: 400,
  vmTimeoutMs: 2_500,
};

export function resolveTimeoutProfile(target: Pick<WptTarget, "file" | "variant">) {
  const key = `${target.file}${target.variant ? ` ${target.variant}` : ""}`.toLowerCase();

  if (matchesAny(key, ["gc", "capture-video", "getstats", "transport-stats", "track-stats"])) {
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
