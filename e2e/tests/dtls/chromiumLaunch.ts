/**
 * Chromium launch args for Epic 2 DTLS parameterized E2E.
 * Node-safe: imported from vitest.dtls.config.mts and browser tests.
 *
 * Measured on Playwright Chromium 140.0.7339.186 (build v1193):
 *   Off/  → transport.tlsVersion FEFD (DTLS 1.2)
 *   Only/ → transport.tlsVersion FEFC (DTLS 1.3)
 */
export type ChromiumDtlsMode = "dtls12" | "dtls13";

export function chromiumFieldTrialArgs(mode: ChromiumDtlsMode) {
  const forceDtls13 = mode === "dtls13" ? "Only" : "Off";
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
