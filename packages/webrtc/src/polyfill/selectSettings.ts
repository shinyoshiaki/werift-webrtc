import {
  OverconstrainedError,
  createWebRtcDomException,
  createWebRtcTypeError,
} from "../errors";

export type MediaKind = "audio" | "video";

export const polyfillSupportedConstraints = {
  deviceId: true,
  groupId: true,
  mimeType: true,
} as const;

export type PolyfillConstraintName = keyof typeof polyfillSupportedConstraints;

export interface MediaRegisterCandidate {
  deviceId: string;
  groupId?: string;
  mimeType: string;
  kinds: readonly MediaKind[];
}

type ConstrainDomString =
  | string
  | string[]
  | {
      exact?: string | string[];
      ideal?: string | string[];
    };

export interface PolyfillTrackConstraintSet {
  deviceId?: ConstrainDomString;
  groupId?: ConstrainDomString;
  mimeType?: ConstrainDomString;
}

export interface PolyfillTrackConstraints extends PolyfillTrackConstraintSet {
  advanced?: PolyfillTrackConstraintSet[];
}

const CONSTRAINT_NAMES: PolyfillConstraintName[] = [
  "deviceId",
  "groupId",
  "mimeType",
];

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
    trackConstraints === true ? {} : stripUnsupported(trackConstraints);
  const { advanced = [], ...basic } = constraintSet;

  const selected = selectSettings(ofKind, basic, advanced);
  if (!selected) {
    throw new OverconstrainedError(
      findFailedConstraint(ofKind, basic) ?? "",
      "Cannot satisfy required constraints",
    );
  }
  return selected;
}

function stripUnsupported(
  constraints: PolyfillTrackConstraints,
): PolyfillTrackConstraints {
  const next: PolyfillTrackConstraints = {};
  for (const name of CONSTRAINT_NAMES) {
    if (constraints[name] != undefined) {
      next[name] = constraints[name];
    }
  }
  if (constraints.advanced) {
    next.advanced = constraints.advanced.map((entry) => {
      const stripped: PolyfillTrackConstraintSet = {};
      for (const name of CONSTRAINT_NAMES) {
        if (entry[name] != undefined) {
          stripped[name] = entry[name];
        }
      }
      return stripped;
    });
  }
  return next;
}

function selectSettings(
  candidates: readonly MediaRegisterCandidate[],
  basic: PolyfillTrackConstraintSet,
  advanced: PolyfillTrackConstraintSet[],
): MediaRegisterCandidate | undefined {
  let remaining = candidates.filter(
    (candidate) =>
      fitnessDistance(candidate, basic, "ideal") < Number.POSITIVE_INFINITY,
  );
  if (remaining.length === 0) {
    return undefined;
  }

  for (const constraintSet of advanced) {
    const narrowed = remaining.filter(
      (candidate) =>
        fitnessDistance(candidate, constraintSet, "exact") <
        Number.POSITIVE_INFINITY,
    );
    if (narrowed.length > 0) {
      remaining = narrowed;
    }
  }

  let best = remaining[0];
  let bestDistance = fitnessDistance(best, basic, "ideal");
  for (const candidate of remaining.slice(1)) {
    const distance = fitnessDistance(candidate, basic, "ideal");
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function findFailedConstraint(
  candidates: readonly MediaRegisterCandidate[],
  basic: PolyfillTrackConstraintSet,
): string | undefined {
  for (const name of CONSTRAINT_NAMES) {
    const constraint = basic[name];
    if (!isRequired(constraint)) {
      continue;
    }
    const anyFinite = candidates.some(
      (candidate) =>
        fitnessDistance(candidate, { [name]: constraint }, "ideal") <
        Number.POSITIVE_INFINITY,
    );
    if (!anyFinite) {
      return name;
    }
  }
  return undefined;
}

function fitnessDistance(
  candidate: MediaRegisterCandidate,
  constraintSet: PolyfillTrackConstraintSet,
  bareMode: "ideal" | "exact",
): number {
  let distance = 0;
  for (const name of CONSTRAINT_NAMES) {
    const constraint = constraintSet[name];
    if (constraint == undefined) {
      continue;
    }
    const actual = readSetting(candidate, name);
    const next = constrainDomStringDistance(actual, constraint, bareMode);
    if (next === Number.POSITIVE_INFINITY) {
      return Number.POSITIVE_INFINITY;
    }
    distance += next;
  }
  return distance;
}

function readSetting(
  candidate: MediaRegisterCandidate,
  name: PolyfillConstraintName,
): string | undefined {
  switch (name) {
    case "deviceId":
      return candidate.deviceId;
    case "groupId":
      return candidate.groupId;
    case "mimeType":
      return candidate.mimeType;
  }
}

function constrainDomStringDistance(
  actual: string | undefined,
  constraint: ConstrainDomString,
  bareMode: "ideal" | "exact",
): number {
  const { exact, ideal } = normalizeConstrainDomString(constraint, bareMode);
  if (exact && !matchesDomString(actual, exact)) {
    return Number.POSITIVE_INFINITY;
  }
  if (!ideal) {
    return 0;
  }
  return matchesDomString(actual, ideal) ? 0 : 1;
}

function normalizeConstrainDomString(
  constraint: ConstrainDomString,
  bareMode: "ideal" | "exact",
): { exact?: string[]; ideal?: string[] } {
  if (typeof constraint === "string" || Array.isArray(constraint)) {
    const values = toStringList(constraint);
    return bareMode === "exact" ? { exact: values } : { ideal: values };
  }
  return {
    exact: constraint.exact ? toStringList(constraint.exact) : undefined,
    ideal: constraint.ideal ? toStringList(constraint.ideal) : undefined,
  };
}

function toStringList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function matchesDomString(actual: string | undefined, expected: string[]) {
  return actual != undefined && expected.includes(actual);
}

function isRequired(constraint: ConstrainDomString | undefined) {
  if (constraint == undefined) {
    return false;
  }
  if (typeof constraint === "string" || Array.isArray(constraint)) {
    return false;
  }
  return constraint.exact != undefined;
}
