/**
 * Why a gathering reported an error (`Connection.onGatheringError`).
 * New reasons may be added in a minor release: handle unknown values.
 * @enum
 */
export const IceGatheringErrorReason = {
  /** os.networkInterfaces() threw. @see packages/ice/tests/ice/interface-enumeration.test.ts「without servers or explicit addresses: ends with interface-enumeration-failed then no-candidates」 */
  interfaceEnumerationFailed: "interface-enumeration-failed",
  /** The gathering ended without any local candidate. @see packages/ice/tests/ice/interface-enumeration.test.ts「without servers or explicit addresses: ends with interface-enumeration-failed then no-candidates」 */
  noCandidates: "no-candidates",
  /** gatherCandidates() threw unexpectedly. @see packages/ice/tests/ice/interface-enumeration.test.ts「an unexpected exception reports gathering-failed, ends the generation and rejects」 */
  gatheringFailed: "gathering-failed",
} as const;
/** @enum */
export type IceGatheringErrorReason =
  (typeof IceGatheringErrorReason)[keyof typeof IceGatheringErrorReason];

/**
 * A gathering error of one generation (`Connection.onGatheringError`).
 * @see packages/ice/tests/ice/interface-enumeration.test.ts「without servers or explicit addresses: ends with interface-enumeration-failed then no-candidates」
 */
export type IceGatheringErrorInfo = {
  reason: IceGatheringErrorReason;
  /** Human-readable description, for logs. Not a stable identifier. */
  errorText: string;
  /** The original exception, when there is one. */
  cause?: unknown;
  /** @see packages/ice/tests/ice/interface-enumeration.test.ts「nothing is reported for a generation an ICE restart replaced」 */
  generation: number;
};
