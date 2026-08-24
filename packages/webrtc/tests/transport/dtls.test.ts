import { Certificate } from "@fidm/x509";
import { setTimeout } from "timers/promises";

import {
  DtlsVersion,
  RTCDtlsFingerprint,
  RTCDtlsParameters,
  RTCDtlsTransport,
  defaultPeerConfig,
  fingerprint,
} from "../../src";
import { dtlsTransportPair } from "../fixture";
import { iceTransportPair } from "../fixture";
import { waitForDtlsState } from "../utils";

describe("RTCDtlsTransportTest", () => {
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
    const remoteCertificate = Certificate.fromPEM(
      Buffer.from(session2.localCertificate!.certPem),
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

  test("dtls 1.3 stats report DTLS 1.3 and TLS_AES_128_GCM_SHA256", async () => {
    const [session1, session2] = await dtlsTransportPair({
      protocolVersions: [DtlsVersion.V1_3],
    });
    try {
      // Assert: isDtls13 経路の stats。接続成功だけでは見ない。
      const stats1 = await session1.getStats();
      const transport = stats1.find((stat) => stat.type === "transport") as
        | { tlsVersion?: string; dtlsCipher?: string }
        | undefined;
      expect(transport?.tlsVersion).toBe("DTLS 1.3");
      expect(transport?.dtlsCipher).toBe("TLS_AES_128_GCM_SHA256");
      expect(session1.dtls?.isDtls13).toBe(true);
      expect(session2.dtls?.isDtls13).toBe(true);
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("dtls 1.2 stats report DTLS 1.2", async () => {
    const [session1, session2] = await dtlsTransportPair();
    try {
      const stats1 = await session1.getStats();
      const transport = stats1.find((stat) => stat.type === "transport") as
        | { tlsVersion?: string }
        | undefined;
      expect(transport?.tlsVersion).toBe("DTLS 1.2");
      expect(session1.dtls?.isDtls13).toBeFalsy();
      expect(session2.dtls?.isDtls13).toBeFalsy();
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("dtls_start_fails_for_mismatched_fingerprint_dtls13", async () => {
    const [session1, session2] = await createDtlsSessions({
      protocolVersions: [DtlsVersion.V1_3],
    });
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
      expect(session1.lastError?.message).toMatch(/fingerprint/i);
      await expect(session1.getStats()).resolves.toBeDefined();
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

async function createDtlsSessions(
  config: ConstructorParameters<typeof RTCDtlsTransport>[0] = defaultPeerConfig,
) {
  const [transport1, transport2] = await iceTransportPair();
  await RTCDtlsTransport.SetupCertificate();

  const session1 = new RTCDtlsTransport(config, transport1);
  const session2 = new RTCDtlsTransport(config, transport2);

  return [session1, session2] as const;
}

function mutateFingerprint(value: string) {
  const normalized = value.replace(/[^0-9a-f]/gi, "").toUpperCase();
  const flipped = `${normalized[0] === "A" ? "B" : "A"}${normalized.slice(1)}`;
  return flipped.match(/.{2}/g)!.join(":");
}
