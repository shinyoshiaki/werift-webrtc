/**
 * DTLS version helper for Epic 2 parameterized E2E.
 *
 * How to confirm the running Chromium:
 *   - Playwright: `npx playwright --version` and the Chromium revision
 *     printed by `playwright.chromium.executablePath()`
 *   - Override only: `DTLS_CHROME_BIN` (system Chrome is not used)
 *
 * Chromium runs with its default DTLS policy (DTLS 1.3 max, DTLS 1.2
 * fallback); see chromiumLaunch.ts. Each case selects the negotiated version
 * through werift's advertised `protocolVersions`:
 *   ["1.2"]        → Chromium falls back to DTLS 1.2
 *   ["1.3"]        → DTLS 1.3
 *   ["1.3", "1.2"] → DTLS 1.3 (werift prefers 1.3)
 * werift's own 1.3 → 1.2 fallback against a 1.2-only peer is covered by the
 * packages/dtls and packages/webrtc tests, because Chromium can no longer be
 * capped to DTLS 1.2.
 *
 * Assert Chromium `getStats()` transport.tlsVersion:
 *   DTLS 1.2 → "FEFD"
 *   DTLS 1.3 → "FEFC"
 * werift transport.tlsVersion is human-readable "DTLS 1.2" / "DTLS 1.3".
 */
import { peer, sleep, waitVideoPlay } from "../fixture";

export {
  chromiumFieldTrialArgs,
  chromiumLaunchArgs,
  chromiumMediaArgs,
} from "./chromiumLaunch";

export type BrowserDtlsTestCase = {
  name: string;
  weriftVersions: readonly string[];
  expectedWeriftVersion: "DTLS 1.2" | "DTLS 1.3";
  expectedChromiumVersion: "FEFD" | "FEFC";
};

export const BROWSER_DTLS_CASES: BrowserDtlsTestCase[] = [
  {
    name: "DTLS 1.2 baseline",
    weriftVersions: ["1.2"],
    expectedWeriftVersion: "DTLS 1.2",
    expectedChromiumVersion: "FEFD",
  },
  {
    name: "DTLS 1.3 opt-in",
    weriftVersions: ["1.3"],
    expectedWeriftVersion: "DTLS 1.3",
    expectedChromiumVersion: "FEFC",
  },
  {
    name: "1.3 preferred",
    weriftVersions: ["1.3", "1.2"],
    expectedWeriftVersion: "DTLS 1.3",
    expectedChromiumVersion: "FEFC",
  },
];

export type WeriftDtlsDiagnostics = {
  connectionState: string;
  dtlsState?: string;
  dtlsRole?: string;
  tlsVersion?: string;
  dtlsCipher?: string;
  srtpCipher?: string;
  lastError?: { name: string; message: string; code?: string };
  rtpPacketsReceived: number;
  rtcpPacketsReceived: number;
};

export type ChromiumDtlsStats = {
  tlsVersion?: string;
  dtlsCipher?: string;
  dtlsState?: string;
  inboundRtpPackets: number;
  remoteInboundRtp: boolean;
};

export function normalizeChromiumTlsVersion(value?: string) {
  if (!value) {
    return;
  }
  return value.replace(/^0x/i, "").toUpperCase();
}

export async function getChromiumDtlsStats(
  pc: RTCPeerConnection,
): Promise<ChromiumDtlsStats> {
  const stats = await pc.getStats();
  let tlsVersion: string | undefined;
  let dtlsCipher: string | undefined;
  let dtlsState: string | undefined;
  let inboundRtpPackets = 0;
  let remoteInboundRtp = false;

  stats.forEach((report) => {
    const record = report as Record<string, unknown>;
    if (report.type === "transport") {
      tlsVersion = normalizeChromiumTlsVersion(
        typeof record.tlsVersion === "string" ? record.tlsVersion : undefined,
      );
      dtlsCipher =
        typeof record.dtlsCipher === "string" ? record.dtlsCipher : undefined;
      dtlsState =
        typeof record.dtlsState === "string" ? record.dtlsState : undefined;
    }
    if (report.type === "inbound-rtp") {
      inboundRtpPackets += Number(record.packetsReceived ?? 0);
    }
    if (report.type === "remote-inbound-rtp") {
      remoteInboundRtp = true;
    }
  });

  return {
    tlsVersion,
    dtlsCipher,
    dtlsState,
    inboundRtpPackets,
    remoteInboundRtp,
  };
}

export async function ensureDtlsPeer() {
  if (!peer.connected) {
    await new Promise<void>((resolve) => peer.on("open", resolve));
  }
  await sleep(100);
}

export async function requestWeriftStats(method: string) {
  return (await peer.request(method, {
    type: "stats",
  })) as WeriftDtlsDiagnostics;
}

export async function waitForRtcpPath(
  pc: RTCPeerConnection,
  method: string,
  timeoutMs = 10_000,
) {
  const started = Date.now();
  for (;;) {
    const chromium = await getChromiumDtlsStats(pc);
    const werift = await requestWeriftStats(method);
    if (werift.rtcpPacketsReceived > 0 || chromium.remoteInboundRtp) {
      return { chromium, werift };
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `RTCP path not observed weriftRtcp=${werift.rtcpPacketsReceived} remoteInbound=${chromium.remoteInboundRtp}`,
      );
    }
    await sleep(200);
  }
}

export async function assertNegotiatedVersions(
  pc: RTCPeerConnection,
  method: string,
  testCase: BrowserDtlsTestCase,
) {
  const chromium = await getChromiumDtlsStats(pc);
  const werift = await requestWeriftStats(method);

  expect(chromium.tlsVersion, `chromium tlsVersion for ${testCase.name}`).toBe(
    testCase.expectedChromiumVersion,
  );
  expect(werift.tlsVersion, `werift tlsVersion for ${testCase.name}`).toBe(
    testCase.expectedWeriftVersion,
  );
  if (testCase.expectedWeriftVersion === "DTLS 1.3") {
    expect(werift.dtlsCipher).toBe("TLS_AES_128_GCM_SHA256");
  }
  return { chromium, werift };
}

export function waitForChannelOpen(
  channel: RTCDataChannel,
  timeoutMs = 30_000,
) {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`data channel did not open: ${channel.readyState}`));
    }, timeoutMs);
    channel.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function pingPong(channel: RTCDataChannel) {
  const reply = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pong timeout")), 20_000);
    channel.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      },
      { once: true },
    );
  });
  channel.send("ping");
  expect(await reply).toBe("pingpong");
}

export { peer, waitVideoPlay };
