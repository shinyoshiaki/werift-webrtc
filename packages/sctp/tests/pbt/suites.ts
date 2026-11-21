/**
 * The deep property searches of `packages/sctp` (`npm run pbt:deep`, run by
 * `packages/pbt`'s `runDeepSearch`; options in its `deep.ts`). Every suite is
 * one property directory of `tests/pbt`, sharded by its seed variables.
 *
 *   npm run pbt:deep                       # every suite
 *   npm run pbt:deep -- --suite congestion --seeds 1000
 */
import type { DeepSearchConfig } from "../../../pbt/src";

const config: DeepSearchConfig = {
  // 1 seed あたりの時間が長い順。
  suites: {
    loss: {
      file: "tests/pbt/loss/lossProperty.test.ts",
      prefix: "WERIFT_SCTP_LOSS",
    },
    reset: {
      file: "tests/pbt/reset/resetProperty.test.ts",
      prefix: "WERIFT_SCTP_RESET",
    },
    congestion: {
      file: "tests/pbt/congestion/congestionProperty.test.ts",
      prefix: "WERIFT_SCTP_CONGESTION",
    },
    setup: {
      file: "tests/pbt/setup/setupProperty.test.ts",
      prefix: "WERIFT_SCTP_SETUP",
    },
    bookSize: {
      file: "tests/pbt/bookSize/bookSizeProperty.test.ts",
      prefix: "WERIFT_SCTP_BOOK_SIZE",
      seeds: 5000,
    },
  },
};

export default config;
