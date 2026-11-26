/**
 * The vitest reporter of the deep search (`runDeepSearch` in `deep.ts`):
 * writes to `PBT_DEEP_REPORT` every test with its state and errors, and the
 * errors outside the test results (unhandled errors, failing files and suite
 * hooks). Each error keeps what identifies its cause (`ReportedError` in
 * `failureForm.ts`); the built-in JSON reporter drops `actual`, `expected`,
 * `cause` and the errors outside the tests. Plain JavaScript, so the vitest
 * of any revision can load it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * This file, for `--reporter`: the runner is ESM under node and CommonJS under
 * vitest, so it cannot resolve a path beside itself in both.
 */
export const reporterPath = fileURLToPath(import.meta.url);

const text = (value) =>
  value === undefined || value === null ? undefined : String(value);

/** The first stack frame in the project (not in a dependency), with its source line. */
function location(error) {
  const frame = error.stacks?.find(
    (f) => f.file && !f.file.includes("/node_modules/"),
  );
  if (!frame) return undefined;
  let source;
  try {
    source = readFileSync(frame.file, "utf8").split("\n")[frame.line - 1];
  } catch {}
  return { file: frame.file, source: source?.trim() };
}

function serialize(error, depth = 0) {
  if (typeof error !== "object" || error === null) {
    return { message: text(error) };
  }
  const nested = depth < 8;
  return {
    type: text(error.type),
    name: text(error.name),
    message: text(error.message),
    expected: text(error.expected),
    actual: text(error.actual),
    at: location(error),
    cause:
      nested && error.cause !== undefined
        ? serialize(error.cause, depth + 1)
        : undefined,
    errors:
      nested && Array.isArray(error.errors)
        ? error.errors.map((e) => serialize(e, depth + 1))
        : undefined,
  };
}

export default class DeepSearchReporter {
  onTestRunEnd(modules, unhandledErrors) {
    const tests = [];
    const outside = unhandledErrors.map((error) => serialize(error));
    for (const module of modules) {
      outside.push(...module.errors().map((error) => serialize(error)));
      for (const suite of module.children.allSuites()) {
        outside.push(...suite.errors().map((error) => serialize(error)));
      }
      for (const test of module.children.allTests()) {
        const { state, errors } = test.result();
        tests.push({
          title: test.name,
          fullName: test.fullName,
          state,
          errors: (errors ?? []).map((error) => serialize(error)),
        });
      }
    }
    writeFileSync(
      process.env.PBT_DEEP_REPORT,
      JSON.stringify({ tests, outside }),
    );
  }
}
