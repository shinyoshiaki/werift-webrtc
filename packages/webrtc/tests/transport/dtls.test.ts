import {
  createPrivateKey,
  createSign,
  createVerify,
  X509Certificate,
} from "node:crypto";
import { setTimeout } from "timers/promises";

import {
  defaultPeerConfig,
  fingerprint,
  RTCCertificate,
  RTCDtlsFingerprint,
  RTCDtlsParameters,
  RTCDtlsTransport,
} from "../../src";
import { isWithinBurstLossWindow } from "../../src/transport/debugPacketLoss";
import { isPacketLost } from "../../src/transport/dtls";
import { dtlsTransportPair, iceTransportPair } from "../fixture";

describe("RTCDtlsTransportTest", () => {
  test("debug packet loss uses the configured percentage", () => {
    // Arrange: 25% loss を境界値の乱数で評価する。
    // Act: 破棄判定を閾値の直前・直後で呼ぶ。
    const dropped = isPacketLost(25, 0.249);
    const kept = isPacketLost(25, 0.25);

    // Assert: 設定した割合どおりにパケットを破棄する。
    expect(dropped).toBe(true);
    expect(kept).toBe(false);
  });

  test("periodic debug burst loss has deterministic boundaries", () => {
    // Arrange: 1000 ms 周期の先頭 100 ms を損失区間にする。
    // Act: 区間内、区間外、次周期の先頭を判定する。
    const inside = isWithinBurstLossWindow(1050, 1000, 100);
    const outside = isWithinBurstLossWindow(1150, 1000, 100);
    const nextBurst = isWithinBurstLossWindow(2000, 1000, 100);

    // Assert: 境界を含む開始時刻から duration 未満だけ損失する。
    expect(inside).toBe(true);
    expect(outside).toBe(false);
    expect(nextBurst).toBe(true);
  });
  test("RTCCertificate preserves PKCS#8 PEM and signs with Node KeyObject", async () => {
    // Arrange
    const source = await RTCDtlsTransport.SetupCertificate();
    const certificate = new RTCCertificate(
      source.privateKey,
      source.certPem,
      source.signatureHash,
    );
    const data = Buffer.from("werift certificate signing");

    // Act
    const signature = createSign("sha256")
      .update(data)
      .sign(createPrivateKey(certificate.privateKey));
    const verified = createVerify("sha256")
      .update(data)
      .verify(new X509Certificate(certificate.certPem).publicKey, signature);

    // Assert
    expect(certificate.privateKey).toBe(source.privateKey);
    expect(verified).toBe(true);
  });

  test("dtls_test_data", async () => {
    const [session1, session2] = await dtlsTransportPair();
    const receiver2 = new DummyDataReceiver();
    session2.dataReceiver = receiver2.handleData;

    session1.sendData(Buffer.from("ping"));
    await setTimeout(100);
    expect(receiver2.data).toEqual([Buffer.from("ping")]);
  });

  test("dtls_start_accepts_matching_fingerprint_in_selected_algorithm_set", async () => {
    const [session1, session2] = await createDtlsSessions();
    const expectedFingerprint = session2.localParameters.fingerprints[0];

    try {
      session1.setRemoteParams(
        new RTCDtlsParameters(
          [
            new RTCDtlsFingerprint(
              expectedFingerprint.algorithm,
              mutateFingerprint(expectedFingerprint.value),
            ),
            new RTCDtlsFingerprint("sha256", expectedFingerprint.value),
          ],
          session2.localParameters.role,
        ),
      );
      session2.setRemoteParams(session1.localParameters);

      await Promise.all([session1.start(), session2.start()]);

      expect(session1.state).toBe("connected");
      expect(session2.state).toBe("connected");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("dtls_start_prefers_most_preferred_supported_fingerprint_algorithm", async () => {
    const [session1, session2] = await createDtlsSessions();
    const expectedFingerprint = session2.localParameters.fingerprints[0];
    const remoteCertificate = new X509Certificate(
      session2.localCertificate!.certPem,
    ).raw;

    try {
      session1.setRemoteParams(
        new RTCDtlsParameters(
          [
            new RTCDtlsFingerprint(
              "sha-1",
              fingerprint(remoteCertificate, "sha1"),
            ),
            new RTCDtlsFingerprint(
              expectedFingerprint.algorithm,
              mutateFingerprint(expectedFingerprint.value),
            ),
          ],
          session2.localParameters.role,
        ),
      );
      session2.setRemoteParams(session1.localParameters);

      void session1.start().catch(() => undefined);
      void session2.start().catch(() => undefined);

      await waitForDtlsState(session1, "failed");
      expect(session1.state).toBe("failed");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("dtls_start_fails_for_mismatched_fingerprint", async () => {
    const [session1, session2] = await createDtlsSessions();
    const expectedFingerprint = session2.localParameters.fingerprints[0];

    try {
      session1.setRemoteParams(
        new RTCDtlsParameters(
          [
            new RTCDtlsFingerprint(
              expectedFingerprint.algorithm,
              mutateFingerprint(expectedFingerprint.value),
            ),
          ],
          session2.localParameters.role,
        ),
      );
      session2.setRemoteParams(session1.localParameters);

      void session1.start().catch(() => undefined);
      void session2.start().catch(() => undefined);

      await waitForDtlsState(session1, "failed");
      expect(session1.state).toBe("failed");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("dtls_start_ignores_unsupported_fingerprint_algorithm_when_supported_match_exists", async () => {
    const [session1, session2] = await createDtlsSessions();
    const expectedFingerprint = session2.localParameters.fingerprints[0];

    try {
      session1.setRemoteParams(
        new RTCDtlsParameters(
          [
            new RTCDtlsFingerprint("sha-999", expectedFingerprint.value),
            new RTCDtlsFingerprint(
              expectedFingerprint.algorithm,
              expectedFingerprint.value,
            ),
          ],
          session2.localParameters.role,
        ),
      );
      session2.setRemoteParams(session1.localParameters);

      await Promise.all([session1.start(), session2.start()]);

      expect(session1.state).toBe("connected");
      expect(session2.state).toBe("connected");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("dtls_start_fails_when_no_supported_fingerprint_algorithm_is_offered", async () => {
    const [session1, session2] = await createDtlsSessions();
    const expectedFingerprint = session2.localParameters.fingerprints[0];

    try {
      session1.setRemoteParams(
        new RTCDtlsParameters(
          [new RTCDtlsFingerprint("sha-999", expectedFingerprint.value)],
          session2.localParameters.role,
        ),
      );
      session2.setRemoteParams(session1.localParameters);

      void session1.start().catch(() => undefined);
      void session2.start().catch(() => undefined);

      await waitForDtlsState(session1, "failed");
      expect(session1.state).toBe("failed");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });
});

class DummyDataReceiver {
  data: Buffer[] = [];
  handleData = (data: Buffer) => {
    this.data.push(data);
  };
}

async function createDtlsSessions() {
  const [transport1, transport2] = await iceTransportPair();
  await RTCDtlsTransport.SetupCertificate();

  const session1 = new RTCDtlsTransport(defaultPeerConfig, transport1);
  const session2 = new RTCDtlsTransport(defaultPeerConfig, transport2);

  return [session1, session2] as const;
}

function mutateFingerprint(value: string) {
  const normalized = value.replace(/[^0-9a-f]/gi, "").toUpperCase();
  const flipped = `${normalized[0] === "A" ? "B" : "A"}${normalized.slice(1)}`;
  return flipped.match(/.{2}/g)!.join(":");
}

async function waitForDtlsState(
  session: RTCDtlsTransport,
  state: RTCDtlsTransport["state"],
  timeoutMs = 5_000,
) {
  const started = Date.now();
  while (session.state !== state) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for dtls state ${state}`);
    }
    await setTimeout(50);
  }
}
