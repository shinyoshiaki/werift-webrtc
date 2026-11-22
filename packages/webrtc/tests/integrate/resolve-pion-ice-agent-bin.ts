export type ResolvePionIceAgentBinInput = {
  override: string | undefined;
  required: boolean;
  autoBuild: boolean;
  localBin: string;
  exists: (path: string) => boolean;
  tryBuildLocal: () => string | undefined;
};

/**
 * Default `npm test` may skip a missing `WERIFT_PION_ICE_AGENT`.
 * `npm run test:pion-ice-agent` sets required=true and must not skip.
 */
export function resolvePionIceAgentBin(
  input: ResolvePionIceAgentBinInput,
): string | undefined {
  const { override, required, autoBuild, localBin, exists, tryBuildLocal } =
    input;

  if (override !== undefined) {
    if (exists(override)) {
      return override;
    }
    if (required) {
      throw new Error(`WERIFT_PION_ICE_AGENT does not exist: ${override}`);
    }
    return undefined;
  }

  if (autoBuild) {
    const built = exists(localBin) ? localBin : tryBuildLocal();
    if (!built) {
      throw new Error(
        "WERIFT_PION_ICE_AGENT_AUTO_BUILD=1 but local pion-ice-agent is missing",
      );
    }
    return built;
  }

  if (required) {
    throw new Error(
      "Pion ICE agent opt-in requires WERIFT_PION_ICE_AGENT or WERIFT_PION_ICE_AGENT_AUTO_BUILD=1",
    );
  }

  return undefined;
}
