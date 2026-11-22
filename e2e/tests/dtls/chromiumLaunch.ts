/**
 * Chromium launch args for Epic 2 DTLS parameterized E2E.
 * Node-safe: imported from vitest.dtls.config.mts and browser tests.
 *
 * Chromium is launched with its default DTLS policy (DTLS 1.3 max, DTLS 1.2
 * fallback). The negotiated version is selected by what werift advertises:
 * a werift peer limited to DTLS 1.2 makes Chromium fall back to 1.2.
 * Chromium 156 no longer ships the WebRTC-ForceDtls13 field trial, so the
 * browser side is not capped.
 *
 * WebRTC-IceHandshakeDtls/Disabled/ keeps Chromium's SPED off explicitly, so
 * SDP must not contain goog-sped-v1.
 */
export const chromiumMediaArgs = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--ignore-certificate-errors",
  "--allow-insecure-localhost",
  "--force-webrtc-ip-handling-policy=default_public_interface_only",
];

export const chromiumFieldTrialArgs = [
  "--force-fieldtrials=WebRTC-IceHandshakeDtls/Disabled/",
];

export const chromiumLaunchArgs = [
  ...chromiumMediaArgs,
  "--disable-features=WebRtcHideLocalIpsWithMdns",
  ...chromiumFieldTrialArgs,
];
