import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAuthority, resolvePublicAuthority } from "./publicAuthority";

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

test("uses the request host when only the public port is configured", () => {
  assert.equal(
    resolvePublicAuthority({
      defaultAuthority: "127.0.0.1:443",
      publicPort: 443,
      requestHost: "example.com",
    }),
    "example.com:443",
  );
});

test("keeps the configured host when explicitly provided", () => {
  assert.equal(
    resolvePublicAuthority({
      configuredHost: "turn.example.com",
      defaultAuthority: "turn.example.com:443",
      publicPort: 443,
      requestHost: "example.com",
    }),
    "turn.example.com:443",
  );
});
