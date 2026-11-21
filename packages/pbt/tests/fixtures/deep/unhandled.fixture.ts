import { expect, test } from "vitest";

// The test's assertions pass, then an asynchronous error nobody handles:
// vitest reports the test passed and still exits with code 1.
test("a fixture passing before an unhandled rejection", async () => {
  expect(1 + 1).toBe(2);
  void Promise.reject(new Error("unhandled after the assertions"));
});
