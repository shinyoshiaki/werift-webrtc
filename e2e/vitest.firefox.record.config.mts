// vitest.firefox.config.mts plus the run-record reporter, for run-firefox.js
// (`npm run firefox:record`). The reporter is imported here, in Node, because
// a `--reporter <path>` would be loaded through Vite and its node polyfills.
import { mergeConfig } from "vitest/config";

import FirefoxRunReporter from "./firefox-run-reporter.mjs";
import firefox from "./vitest.firefox.config.mts";

export default mergeConfig(firefox, {
  test: { reporters: ["default", new FirefoxRunReporter()] },
});
