import {
  createWebRtcDomException,
  createWebRtcTypeError,
  OverconstrainedError,
} from "../errors";
import {
  constraintFitnessDistance,
  findFailedRequiredConstraint,
  stripUnsupportedConstraints,
  type WeriftConstraintName,
  type WeriftMediaTrackConstraintSet,
  type WeriftMediaTrackConstraints,
} from "../media/trackConstraints";

export type MediaKind = "audio" | "video";

export const polyfillSupportedConstraints = {
  deviceId: true,
  groupId: true,
  mimeType: true,
} as const satisfies Record<WeriftConstraintName, true>;

export type PolyfillConstraintName = WeriftConstraintName;

export interface MediaRegisterCandidate {
  deviceId: string;
  groupId?: string;
  mimeType: string;
  kinds: readonly MediaKind[];
}

export type PolyfillTrackConstraintSet = WeriftMediaTrackConstraintSet;

export type PolyfillTrackConstraints = WeriftMediaTrackConstraints;

export function assertRequestedMediaTypes(constraints: {
  audio?: unknown;
  video?: unknown;
}) {
  if (!constraints.audio && !constraints.video) {
    throw createWebRtcTypeError(
      "Failed to execute 'getUserMedia' on 'MediaDevices': At least one of audio and video must be requested",
    );
  }
}

export function selectRegisterForKind(
  kind: MediaKind,
  trackConstraints: boolean | PolyfillTrackConstraints,
  candidates: readonly MediaRegisterCandidate[],
): MediaRegisterCandidate {
  const ofKind = candidates.filter((candidate) =>
    candidate.kinds.includes(kind),
  );
  if (ofKind.length === 0) {
    throw createWebRtcDomException(
      "NotFoundError",
      `Requested device not found (${kind})`,
    );
  }

  if (trackConstraints === false) {
    throw createWebRtcTypeError(
      "selectRegisterForKind was called for a kind that was not requested",
    );
  }

  const constraintSet =
    trackConstraints === true
      ? {}
      : stripUnsupportedConstraints(
          trackConstraints as { [key: string]: unknown },
        );
  const { advanced = [], ...basic } = constraintSet;

  const selected = selectSettings(ofKind, basic, advanced);
  if (!selected) {
    throw new OverconstrainedError(
      findFailedRequiredConstraint(ofKind, basic) ?? "",
      "Cannot satisfy required constraints",
    );
  }
  return selected;
}

function selectSettings(
  candidates: readonly MediaRegisterCandidate[],
  basic: PolyfillTrackConstraintSet,
  advanced: PolyfillTrackConstraintSet[],
): MediaRegisterCandidate | undefined {
  let remaining = candidates.filter(
    (candidate) =>
      constraintFitnessDistance(candidate, basic, "ideal") <
      Number.POSITIVE_INFINITY,
  );
  if (remaining.length === 0) {
    return undefined;
  }

  for (const constraintSet of advanced) {
    const narrowed = remaining.filter(
      (candidate) =>
        constraintFitnessDistance(candidate, constraintSet, "exact") <
        Number.POSITIVE_INFINITY,
    );
    if (narrowed.length > 0) {
      remaining = narrowed;
    }
  }

  let best = remaining[0];
  let bestDistance = constraintFitnessDistance(best, basic, "ideal");
  for (const candidate of remaining.slice(1)) {
    const distance = constraintFitnessDistance(candidate, basic, "ideal");
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
