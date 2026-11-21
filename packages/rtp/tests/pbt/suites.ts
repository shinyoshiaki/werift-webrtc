/**
 * The deep property searches of `packages/rtp` (`npm run pbt:deep`, run by
 * `packages/pbt`'s `runDeepSearch`; options in its `deep.ts`).
 *
 *   npm run pbt:deep -- --seeds 2000
 */
import type { DeepSearchConfig } from "../../../pbt/src";

const config: DeepSearchConfig = {
  suites: {
    jitterBuffer: {
      file: "tests/pbt/jitterBuffer/jitterBufferProperty.test.ts",
      prefix: "WERIFT_RTP_JITTER",
    },
  },
};

export default config;
