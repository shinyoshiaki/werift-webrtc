export type ResolvePionSpedBinInput = {
  override: string | undefined;
  required: boolean;
  autoBuild: boolean;
  localBin: string;
  exists: (path: string) => boolean;
  isCompatible: (path: string) => boolean;
  tryBuildLocal: () => boolean;
};

/**
 * Default `npm test` may skip a missing/stale `WERIFT_PION_SPED`.
 * `npm run test:pion-sped` sets required=true and must not skip.
 */
export function resolvePionSpedBin(
  input: ResolvePionSpedBinInput,
): string | undefined {
  const {
    override,
    required,
    autoBuild,
    localBin,
    exists,
    isCompatible,
    tryBuildLocal,
  } = input;

  if (override !== undefined) {
    if (!exists(override)) {
      if (required) {
        throw new Error(`WERIFT_PION_SPED does not exist: ${override}`);
      }
      return undefined;
    }
    if (!isCompatible(override)) {
      if (required) {
        throw new Error(`WERIFT_PION_SPED is incompatible: ${override}`);
      }
      return undefined;
    }
    return override;
  }

  if (autoBuild) {
    if (isCompatible(localBin) || tryBuildLocal()) {
      return localBin;
    }
    throw new Error(
      "WERIFT_PION_SPED_AUTO_BUILD=1 but local pion-sped is missing or incompatible",
    );
  }

  if (required) {
    throw new Error(
      "Pion SPED opt-in requires WERIFT_PION_SPED or WERIFT_PION_SPED_AUTO_BUILD=1",
    );
  }

  return undefined;
}
