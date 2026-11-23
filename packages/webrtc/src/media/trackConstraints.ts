/**
 * Structural, DOM-independent counterparts of the DOM `MediaTrackSettings` /
 * `MediaTrackConstraints` / `MediaTrackCapabilities` dictionaries, and the
 * constraint evaluation shared by {@link MediaStreamTrack.applyConstraints}
 * and the polyfill's `getUserMedia` device selection.
 *
 * werift is built without `lib.dom`, so these types do not reference the DOM
 * dictionaries; they are written so that each one is assignable to its DOM
 * counterpart (DOM `MediaStreamTrack.getSettings()` and friends).
 */

/** `ConstrainDOMString` of Media Capture and Streams. */
export type WeriftConstrainDOMString =
  | string
  | string[]
  | {
      exact?: string | string[];
      ideal?: string | string[];
    };

/**
 * The constraints werift evaluates. `mimeType` is a werift extension that
 * selects a polyfill media register by the media it produces.
 */
export interface WeriftMediaTrackConstraintSet {
  deviceId?: WeriftConstrainDOMString;
  groupId?: WeriftConstrainDOMString;
  /** werift extension: the MIME type the source produces. */
  mimeType?: WeriftConstrainDOMString;
}

export interface WeriftMediaTrackConstraints
  extends WeriftMediaTrackConstraintSet {
  advanced?: WeriftMediaTrackConstraintSet[];
}

/** Assignable to the DOM `MediaTrackSettings`. */
export interface WeriftMediaTrackSettings {
  deviceId?: string;
  groupId?: string;
  /** werift extension: the MIME type the source produces. */
  mimeType?: string;
  sampleRate?: number;
  channelCount?: number;
}

/** Assignable to the DOM `MediaTrackCapabilities`. */
export interface WeriftMediaTrackCapabilities {
  deviceId?: string;
  groupId?: string;
}

/** The constraint names werift understands; the others are ignored. */
export type WeriftConstraintName = keyof WeriftMediaTrackConstraintSet;

export const weriftConstraintNames: readonly WeriftConstraintName[] = [
  "deviceId",
  "groupId",
  "mimeType",
];

/** The values a constraint set is evaluated against. */
export type WeriftConstrainableSettings = Partial<
  Record<WeriftConstraintName, string>
>;

/**
 * Keep only the constraints werift understands (Media Capture and Streams
 * ignores unknown constraint names). Returns a fresh object.
 */
export function stripUnsupportedConstraints(
  constraints: { [key: string]: unknown } | undefined,
): WeriftMediaTrackConstraints {
  const next: WeriftMediaTrackConstraints = pickSupported(constraints);
  const advanced = constraints?.advanced;
  if (Array.isArray(advanced)) {
    next.advanced = advanced.map((entry) => pickSupported(entry));
  }
  return next;
}

function pickSupported(
  constraintSet: { [key: string]: unknown } | undefined,
): WeriftMediaTrackConstraintSet {
  const next: WeriftMediaTrackConstraintSet = {};
  for (const name of weriftConstraintNames) {
    const value = constraintSet?.[name];
    if (value != undefined) {
      next[name] = value as WeriftConstrainDOMString;
    }
  }
  return next;
}

/**
 * The fitness distance of Media Capture and Streams' SelectSettings: `0` for
 * a perfect match, `Infinity` when a required (`exact`) constraint fails.
 * A bare value is `ideal` in the basic set and `exact` in an advanced set
 * (`bareMode`).
 */
export function constraintFitnessDistance(
  settings: WeriftConstrainableSettings,
  constraintSet: WeriftMediaTrackConstraintSet,
  bareMode: "ideal" | "exact",
): number {
  let distance = 0;
  for (const name of weriftConstraintNames) {
    const constraint = constraintSet[name];
    if (constraint == undefined) {
      continue;
    }
    const next = constrainDomStringDistance(
      settings[name],
      constraint,
      bareMode,
    );
    if (next === Number.POSITIVE_INFINITY) {
      return Number.POSITIVE_INFINITY;
    }
    distance += next;
  }
  return distance;
}

/**
 * The first required constraint of the basic set no candidate satisfies
 * (the `constraint` of the `OverconstrainedError`), or `undefined`.
 */
export function findFailedRequiredConstraint(
  candidates: readonly WeriftConstrainableSettings[],
  basic: WeriftMediaTrackConstraintSet,
): WeriftConstraintName | undefined {
  for (const name of weriftConstraintNames) {
    const constraint = basic[name];
    if (!isRequired(constraint)) {
      continue;
    }
    const anyFinite = candidates.some(
      (candidate) =>
        constraintFitnessDistance(candidate, { [name]: constraint }, "ideal") <
        Number.POSITIVE_INFINITY,
    );
    if (!anyFinite) {
      return name;
    }
  }
  return undefined;
}

function constrainDomStringDistance(
  actual: string | undefined,
  constraint: WeriftConstrainDOMString,
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
  constraint: WeriftConstrainDOMString,
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

function isRequired(constraint: WeriftConstrainDOMString | undefined) {
  if (constraint == undefined) {
    return false;
  }
  if (typeof constraint === "string" || Array.isArray(constraint)) {
    return false;
  }
  return constraint.exact != undefined;
}
