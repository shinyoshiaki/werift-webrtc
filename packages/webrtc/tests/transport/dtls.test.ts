import { setTimeout } from "timers/promises";

import {
  RTCDtlsFingerprint,
  RTCDtlsParameters,
  RTCDtlsTransport,
  defaultPeerConfig,
} from "../../src";
import { dtlsTransportPair } from "../fixture";
import { iceTransportPair } from "../fixture";

describe("RTCDtlsTransportTest", () => {
  test("dtls_test_data", async () => {
    const [session1, session2] = await dtlsTransportPair();
    const receiver2 = new DummyDataReceiver();
    session2.dataReceiver = receiver2.handleData;

    session1.sendData(Buffer.from("ping"));
    await setTimeout(100);
    expect(receiver2.data).toEqual([Buffer.from("ping")]);
  });

  test("dtls_start_accepts_any_matching_fingerprint", async () => {
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

      const [result] = await Promise.allSettled([
        session1.start(),
        session2.start(),
      ]);

      expect(result.status).toBe("rejected");
      expect(session1.state).toBe("failed");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("dtls_start_fails_for_unsupported_fingerprint_algorithm", async () => {
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

      const [result] = await Promise.allSettled([
        session1.start(),
        session2.start(),
      ]);

      expect(result.status).toBe("rejected");
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
