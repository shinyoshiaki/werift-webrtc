/**
 * Chromium launch args for Epic 2 DTLS parameterized E2E.
 * Node-safe: imported from vitest.dtls.config.mts and browser tests.
 *
 * WebRTC-ForceDtls13 in current Chromium (openssl_stream_adapter
 * GetForceDtls13, WEBRTC_CHROMIUM_BUILD):
 *   IsDisabled()  → DTLS 1.2 max  (group must be "Disabled", not "Off")
 *   Lookup==Only  → DTLS 1.3 only
 *   default       → DTLS 1.3 max, 1.2 fallback
 *
 * `Off/` is not recognized. GHA ubuntu-latest Google Chrome then keeps DTLS 1.3
 * as max, so `[V1_3, V1_2]` × intended-1.2 Chromium negotiates FEFC.
 *
 * Measured:
 *   Disabled/ → transport.tlsVersion FEFD (DTLS 1.2)
 *   Only/     → transport.tlsVersion FEFC (DTLS 1.3)
 */
export type ChromiumDtlsMode = "dtls12" | "dtls13";

export function chromiumFieldTrialArgs(mode: ChromiumDtlsMode) {
  const forceDtls13 = mode === "dtls13" ? "Only" : "Disabled";
  return [
    `--force-fieldtrials=WebRTC-ForceDtls13/${forceDtls13}/WebRTC-IceHandshakeDtls/Disabled/`,
  ];
}

export const chromiumMediaArgs = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--ignore-certificate-errors",
  "--allow-insecure-localhost",
  "--disable-features=WebRtcHideLocalIpsWithMdns",
  "--force-webrtc-ip-handling-policy=default_public_interface_only",
];

export function chromiumLaunchArgs(mode: ChromiumDtlsMode) {
  return [...chromiumMediaArgs, ...chromiumFieldTrialArgs(mode)];
}
