import type { RTCPeerConnectionConfig } from "../../src";

/**
 * The constructor configuration closest to a browser `RTCPeerConnection`.
 * upstream WPT assumes browser behavior, so the WPT wrapper creates every
 * `RTCPeerConnection` with it. werift's own defaults (`src`) keep their
 * convenience behavior (root `AGENTS.md` Do 5).
 *
 * - every compatibility option (`CompatibilityOptionValues`) is `"standard"`:
 *   `certificateScope` (a certificate per connection), `mLineReuse`
 *   (accepted `inactive` m-lines keep their port), `transceiverPairing`
 *   (JSEP 5.10, #816), `keyFrameRequestRouting` (RFC 4585 / RFC 5104 targets).
 * - `iceServers: []` and `iceUseDefaultStunServer: false`: a browser has no
 *   STUN server unless one is configured (W3C: `iceServers` defaults to `[]`).
 *
 * Not covered, because werift has no browser-equivalent value:
 * `bundlePolicy` (`"balanced"` is read as `"max-compat"`).
 */
export const BROWSER_COMPATIBLE_PEER_CONFIG = {
  certificateScope: "standard",
  mLineReuse: "standard",
  transceiverPairing: "standard",
  keyFrameRequestRouting: "standard",
  iceServers: [],
  iceUseDefaultStunServer: false,
} as const satisfies RTCPeerConnectionConfig;

/**
 * The configuration a WPT `new RTCPeerConnection(config)` is created with:
 * a key the test leaves `undefined` takes the browser-compatible value, a key
 * the test gives is kept. A non-object `config` (for a test of the
 * constructor's own conversion) is passed through unchanged.
 */
export function withBrowserCompatibleConfig(config: unknown): unknown {
  if (config != undefined && typeof config !== "object") return config;
  const given = (config ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...given };
  for (const [key, value] of Object.entries(BROWSER_COMPATIBLE_PEER_CONFIG)) {
    if (merged[key] === undefined) {
      merged[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return merged;
}
