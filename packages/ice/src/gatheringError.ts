/**
 * Why a gathering reported an error (`Connection.onGatheringError`).
 * New reasons may be added in a minor release: handle unknown values.
 * @enum
 */
export const IceGatheringErrorReason = {
  /** os.networkInterfaces() threw: no host address was enumerated. */
  interfaceEnumerationFailed: "interface-enumeration-failed",
  /** The generation's gathering ended without any local candidate. */
  noCandidates: "no-candidates",
  /** gatherCandidates() failed with an unexpected exception. */
  gatheringFailed: "gathering-failed",
} as const;
/** @enum */
export type IceGatheringErrorReason =
  (typeof IceGatheringErrorReason)[keyof typeof IceGatheringErrorReason];

/** A gathering error of one generation (`Connection.onGatheringError`). */
export type IceGatheringErrorInfo = {
  reason: IceGatheringErrorReason;
  /** Human-readable description, for logs. Not a stable identifier. */
  errorText: string;
  /** The original exception (e.g. the SystemError of os.networkInterfaces()), when there is one. */
  cause?: unknown;
  /** The generation whose gathering reported it. */
  generation: number;
};
