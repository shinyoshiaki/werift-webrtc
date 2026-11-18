/**
 * Vitest reporter of `run-firefox.js`: appends one JSON line per event to the
 * file named by `FIREFOX_RECORD_EVENTS` as the run goes, so a run that hangs
 * or is interrupted still leaves the results so far and the tests that were
 * running (`firefox-run-record.js` summarizes the lines).
 */
// Imported by vitest.firefox.record.config.mts, not named with `--reporter`:
// a reporter path is loaded through Vite, whose nodePolyfills plugin would
// replace node:fs and process with browser stubs.
import { appendFileSync } from "node:fs";

const file = process.env.FIREFOX_RECORD_EVENTS;

const write = (event) => {
  if (file) appendFileSync(file, `${JSON.stringify(event)}\n`);
};

const messages = (errors) =>
  (errors ?? []).map((error) =>
    [error.name, error.message].filter(Boolean).join(": "),
  );

export default class FirefoxRunReporter {
  onTestCaseReady(testCase) {
    write({
      type: "start",
      file: testCase.module.moduleId,
      name: testCase.fullName,
    });
  }

  onTestCaseResult(testCase) {
    const result = testCase.result();
    const diagnostic = testCase.diagnostic();
    write({
      type: "test",
      file: testCase.module.moduleId,
      name: testCase.fullName,
      state: result.state,
      durationMs: Math.round(diagnostic?.duration ?? 0),
      retryCount: diagnostic?.retryCount ?? 0,
      errors: messages(result.errors),
    });
  }

  onTestModuleEnd(testModule) {
    const errors = messages(testModule.errors());
    if (errors.length) {
      write({ type: "module", file: testModule.moduleId, errors });
    }
  }

  onTestRunEnd(_modules, unhandledErrors, reason) {
    write({ type: "end", reason, errors: messages(unhandledErrors) });
  }
}
