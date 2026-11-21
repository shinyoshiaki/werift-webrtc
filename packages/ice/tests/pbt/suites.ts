/**
 * The deep property searches of `packages/ice` (`npm run pbt:deep`, run by
 * `packages/pbt`'s `runDeepSearch`; options in its `deep.ts`). Every suite is
 * one property directory of `tests/pbt`, sharded by its seed variables.
 *
 *   npm run pbt:deep                       # every suite
 *   npm run pbt:deep -- --suite failoverBurst --seeds 5000
 */
import type { DeepSearchConfig } from "../../../pbt/src";

const config: DeepSearchConfig = {
  // 1 seed あたりの時間が長い順 (実時間に近いモデル、fake timer の長い流れ、純粋な規則)。
  suites: {
    regularNomination: {
      file: "tests/pbt/regularNomination/regularNominationProperty.test.ts",
      prefix: "WERIFT_ICE_REGULAR",
    },
    selection: {
      file: "tests/pbt/selection/selectionProperty.test.ts",
      prefix: "WERIFT_ICE_SELECTION",
    },
    controlledSelection: {
      file: "tests/pbt/controlledSelection/controlledSelectionProperty.test.ts",
      prefix: "WERIFT_ICE_CONTROLLED",
    },
    failoverMatrix: {
      file: "tests/pbt/failoverMatrix/failoverMatrixProperty.test.ts",
      prefix: "WERIFT_ICE_FAILOVER_MATRIX",
      seeds: 2000,
    },
    failoverBurst: {
      file: "tests/pbt/failoverBurst/failoverBurstProperty.test.ts",
      prefix: "WERIFT_ICE_FAILOVER_BURST",
      seeds: 2000,
    },
    pairPriority: {
      file: "tests/pbt/pairPriority/pairPriorityProperty.test.ts",
      prefix: "WERIFT_ICE_PAIR_PRIORITY",
    },
    decideNomination: {
      file: "tests/pbt/decideNomination/decideNominationProperty.test.ts",
      prefix: "WERIFT_ICE_DECIDE",
      seeds: 5000,
    },
    failoverRules: {
      file: "tests/pbt/failoverRules/failoverRulesProperty.test.ts",
      prefix: "WERIFT_ICE_FAILOVER_RULES",
      seeds: 5000,
    },
  },
};

export default config;
