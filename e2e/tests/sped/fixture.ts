/**
 * Shared Arrange / Assert helpers for the opt-in Chromium SPED interop E2E
 * (`npm run sped:ci`, `vitest.sped.config.mts`): Chromium runs with its SPED
 * on (`WebRTC-IceHandshakeDtls/Enabled/`, chromiumLaunch.ts) and werift with
 * `sped: true`, so both ends carry the DTLS 1.3 handshake in ICE Binding.
 */
import {
  type BrowserDtlsTestCase,
  getChromiumDtlsStats,
  requestWeriftStats,
} from "../dtls/fixture";

export { hasSpedOption } from "../dtls/fixture";

export const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

export const SPED_CASES: BrowserDtlsTestCase[] = [
  {
    name: "SPED DTLS 1.3",
    weriftVersions: ["1.3"],
    weriftSped: true,
    expectedWeriftVersion: "DTLS 1.3",
    expectedChromiumVersion: "FEFC",
  },
  {
    name: "SPED DTLS [1.3, 1.2]",
    weriftVersions: ["1.3", "1.2"],
    weriftSped: true,
    expectedWeriftVersion: "DTLS 1.3",
    expectedChromiumVersion: "FEFC",
  },
];

/**
 * Assert: werift handshook over SPED (its runtime saw the peer's
 * DTLS-IN-STUN-DATA: `warpSpedState` is `active`, not `fallback`) and its
 * PeerConnection reached `connected` (stats right after the first message
 * may still show `connecting` for a moment).
 */
export async function expectWeriftSped(method: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const werift = await requestWeriftStats(method);
    if (werift.connectionState === "connected" || Date.now() > deadline) {
      expect(werift.connectionState).toBe("connected");
      expect(werift.warpSpedState).toBe("active");
      return werift;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Arrange helper: wait until Chromium received RTP from werift. */
export async function waitForInboundRtp(
  pc: RTCPeerConnection,
  timeoutMs = 20_000,
) {
  const started = Date.now();
  for (;;) {
    const stats = await getChromiumDtlsStats(pc);
    if (stats.inboundRtpPackets > 0) return stats;
    if (Date.now() - started > timeoutMs) {
      throw new Error("chromium inbound-rtp packetsReceived stayed 0");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
