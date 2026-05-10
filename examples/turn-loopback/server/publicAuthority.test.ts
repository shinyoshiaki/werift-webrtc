import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAuthority } from "./publicAuthority";

test("keeps bracketed IPv6 host headers valid", () => {
  assert.equal(normalizeAuthority("[::1]:8443", 9443), "[::1]:8443");
});

test("adds the fallback port to bracketed IPv6 hosts without one", () => {
  assert.equal(normalizeAuthority("[::1]", 8443), "[::1]:8443");
});

test("normalizes bare IPv6 values by bracketing them once", () => {
  assert.equal(normalizeAuthority("::1", 8443), "[::1]:8443");
});

test("keeps hostname authorities stable", () => {
  assert.equal(normalizeAuthority("example.test:8443", 9443), "example.test:8443");
});
