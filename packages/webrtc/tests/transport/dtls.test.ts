import { Certificate } from "@fidm/x509";
import { setTimeout } from "timers/promises";

import type { Connection } from "../../../ice/src";
import { connectionDatagramEvent } from "../../../ice/src/internal/datagram";
import {
  DtlsVersion,
  ProtectionProfileAes128CmHmacSha1_80,
  RTCDtlsFingerprint,
  RTCDtlsParameters,
  RTCDtlsTransport,
  RtcpRrPacket,
  RtpHeader,
  RtpPacket,
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

  test("fingerprint mismatch does not release early DTLS application data", async () => {
    // Arrange: DTLS server の early write を許可し、client 側 fingerprint を壊す。
    const [server, client] = await createDtlsSessions({
      protocolVersions: [DtlsVersion.V1_3],
      warp: { allowEarlyServerData: true },
    });
    const received = new DummyDataReceiver();
    client.dataReceiver = received.handleData;
    const expected = server.localParameters.fingerprints[0];
    server.setRemoteParams(client.localParameters);
    client.setRemoteParams(
      new RTCDtlsParameters(
        [
          new RTCDtlsFingerprint(
            expected.algorithm,
            mutateFingerprint(expected.value),
          ),
        ],
        server.localParameters.role,
      ),
    );

    try {
      // Act: server Finished 後、client の SDP fingerprint 検証前に送信する。
      void server.start().catch(() => undefined);
      void client.start().catch(() => undefined);
      await server.waitForWriteReady();
      await server.sendData(Buffer.from("must-not-leak"));
      await waitForDtlsState(client, "failed");

      // Assert: DTLS record は gate で破棄され、SCTP 側へ一件も届かない。
      expect(client.state).toBe("failed");
      expect(received.data).toHaveLength(0);
    } finally {
      await Promise.allSettled([server.stop(), client.stop()]);
    }
  });

  test("startSrtp does not grant media permission before fingerprint authentication", async () => {
    // Arrange: key exporter だけを利用可能にし、WebRTC peer 認証は未完了に保つ。
    const [session] = await createDtlsSessions(
      {
        ...defaultPeerConfig,
        warp: { allowEarlyServerData: false, earlyMediaPolicy: "buffer" },
      },
      [ProtectionProfileAes128CmHmacSha1_80],
    );
    const key = Buffer.alloc(16, 1);
    const salt = Buffer.alloc(14, 2);
    session.dtls = {
      srtp: { srtpProfile: ProtectionProfileAes128CmHmacSha1_80 },
      extractSessionKeys: () => ({
        localKey: key,
        localSalt: salt,
        remoteKey: key,
        remoteSalt: salt,
      }),
    } as unknown as NonNullable<typeof session.dtls>;

    try {
      // Act: legacy public helper を認証前に呼び、RTP/RTCP 送信を試みる。
      session.startSrtp();
      const rtpBytes = await session.sendRtp(
        Buffer.from("pre-auth"),
        new RtpHeader({ ssrc: 1, payloadType: 96 }),
      );
      const rtcpBytes = await session.sendRtcp([
        new RtcpRrPacket({ ssrc: 1, reports: [] }),
      ]);

      // Assert: key install と permission は分離され、送信は一件も許可されない。
      expect(rtpBytes).toBe(0);
      expect(rtcpBytes).toBe(0);
    } finally {
      await session.stop();
    }
  });

  test("fingerprint mismatch releases neither buffered RTP nor RTCP", async () => {
    // Arrange: early media を暗号化状態で buffer し、受信側 fingerprint を壊す。
    const profile = ProtectionProfileAes128CmHmacSha1_80;
    const [server, client] = await createDtlsSessions(
      {
        ...defaultPeerConfig,
        protocolVersions: [DtlsVersion.V1_3],
        warp: { allowEarlyServerData: true, earlyMediaPolicy: "buffer" },
      },
      [profile],
    );
    let receivedRtp = 0;
    let receivedRtcp = 0;
    client.onRtp.subscribe(() => receivedRtp++);
    client.onRtcp.subscribe(() => receivedRtcp++);
    const expected = server.localParameters.fingerprints[0];
    server.setRemoteParams(client.localParameters);
    client.setRemoteParams(
      new RTCDtlsParameters(
        [
          new RTCDtlsFingerprint(
            expected.algorithm,
            mutateFingerprint(expected.value),
          ),
        ],
        server.localParameters.role,
      ),
    );

    try {
      // Act: server write-ready 直後に protected RTP/RTCP を送る。
      void server.start().catch(() => undefined);
      void client.start().catch(() => undefined);
      await server.waitForWriteReady();
      expect(
        await server.sendRtp(
          Buffer.from("must-not-leak"),
          new RtpHeader({ ssrc: 7, payloadType: 96 }),
        ),
      ).toBeGreaterThan(0);
      await server.sendRtcp([new RtcpRrPacket({ ssrc: 7, reports: [] })]);
      await waitForDtlsState(client, "failed");

      // Assert: fingerprint mismatch の abort 後も上位イベントはゼロのまま。
      await setTimeout(20);
      expect(receivedRtp).toBe(0);
      expect(receivedRtcp).toBe(0);
      expect(client.state).toBe("failed");
    } finally {
      await Promise.allSettled([server.stop(), client.stop()]);
    }
  });

  test.each(["drop", "buffer"] as const)(
    "pre-auth early media policy=%s enforces bounds and abort cleanup",
    async (earlyMediaPolicy) => {
      // Arrange: fingerprint 未認証の transport に SRTP key だけを導入する。
      const session = await createPreAuthSrtpSession(earlyMediaPolicy);
      const protectedLikeRtp = new RtpPacket(
        new RtpHeader({ ssrc: 9, payloadType: 96 }),
        Buffer.from("encrypted-like"),
      ).serialize();
      const mediaBuffer = (
        session as unknown as {
          mediaBuffer: {
            snapshot(): {
              bufferedPackets: number;
              droppedPackets: number;
            };
          };
        }
      ).mediaBuffer;

      try {
        // Act: 上限を一件超える pre-auth media を世代検証付き demux へ投入する。
        for (let i = 0; i < 257; i++) {
          injectAuthenticatedMedia(session, protectedLikeRtp);
        }
        const beforeAbort = mediaBuffer.snapshot();

        // Assert: drop は全破棄、buffer は古い256件を維持して最新を drop する。
        expect(beforeAbort).toMatchObject(
          earlyMediaPolicy === "buffer"
            ? { bufferedPackets: 256, droppedPackets: 1 }
            : { bufferedPackets: 0, droppedPackets: 257 },
        );

        // Act: transport close により保留 media を破棄する。
        await session.stop();

        // Assert: close 後に認証前 packet は残らない。
        expect(mediaBuffer.snapshot().bufferedPackets).toBe(0);
      } finally {
        await session.stop();
      }
    },
  );

  test("未認証・旧世代の pre-auth media は buffer せず破棄する", async () => {
    // Arrange: fingerprint 未認証の transport に SRTP key だけを導入する。
    const session = await createPreAuthSrtpSession("buffer");
    const protectedLikeRtp = new RtpPacket(
      new RtpHeader({ ssrc: 11, payloadType: 96 }),
      Buffer.from("encrypted-like"),
    ).serialize();
    const mediaBuffer = (
      session as unknown as {
        mediaBuffer: { snapshot(): { bufferedPackets: number } };
      }
    ).mediaBuffer;

    try {
      // Act: 未認証 pair・不一致 source・旧世代の media を投入する。
      injectMediaWith(session, protectedLikeRtp, { authenticated: false });
      const pair = requireAuthenticatedPair(session);
      const ice = session.iceTransport.connection as unknown as Connection;
      connectionDatagramEvent(ice as object).execute({
        bytes: protectedLikeRtp,
        source: ["8.8.8.8", 9],
        protocol: pair.protocol,
        pair,
        generation: ice.generation,
        authenticated: true,
      });
      connectionDatagramEvent(ice as object).execute({
        bytes: protectedLikeRtp,
        source: pair.remoteAddr,
        protocol: pair.protocol,
        pair,
        generation: ice.generation + 99,
        authenticated: true,
      });

      // Assert: いずれも buffer されず、上位へも届かない。
      expect(mediaBuffer.snapshot().bufferedPackets).toBe(0);
    } finally {
      await session.stop();
    }
  });

  test("media drain 中の close は残りを配送せず closed のままにする", async () => {
    // Arrange: SRTP 付きで接続済みの pair を作り、受信側の read を一時停止する。
    const profile = ProtectionProfileAes128CmHmacSha1_80;
    const [sender, receiver] = await createDtlsSessions(
      {
        ...defaultPeerConfig,
        protocolVersions: [DtlsVersion.V1_3],
        warp: { allowEarlyServerData: false, earlyMediaPolicy: "buffer" },
      },
      [profile],
    );
    sender.setRemoteParams(receiver.localParameters);
    receiver.setRemoteParams(sender.localParameters);
    await Promise.all([sender.start(), receiver.start()]);
    const internals = receiver as unknown as {
      srtpReadReady: boolean;
      currentAttempt: { id: number; iceGeneration: number };
      drainMediaBuffer(attempt: { id: number; iceGeneration: number }): void;
      mediaBuffer: { snapshot(): { bufferedPackets: number } };
    };
    internals.srtpReadReady = false;

    try {
      // Act: 実 SRTP 3 件を buffer させる。
      for (let seq = 1; seq <= 3; seq++) {
        expect(
          await sender.sendRtp(
            Buffer.from(`payload-${seq}`),
            new RtpHeader({ sequenceNumber: seq, ssrc: 13, payloadType: 96 }),
          ),
        ).toBeGreaterThan(0);
      }
      const deadline = Date.now() + 5_000;
      while (internals.mediaBuffer.snapshot().bufferedPackets < 3) {
        if (Date.now() > deadline) throw new Error("media が buffer されない");
        await setTimeout(20);
      }

      // Act: 先頭の onRtp で close してから drain する。
      let received = 0;
      receiver.onRtp.subscribe(() => {
        received++;
        if (received === 1) void receiver.stop();
      });
      internals.srtpReadReady = true;
      internals.drainMediaBuffer(internals.currentAttempt);
      await setTimeout(20);

      // Assert: 残りは配送されず、connected へ戻らない。
      expect(received).toBe(1);
      expect(receiver.state).toBe("closed");
      expect(internals.mediaBuffer.snapshot().bufferedPackets).toBe(0);
    } finally {
      await Promise.allSettled([sender.stop(), receiver.stop()]);
    }
  });

  test("application gate は deliver 中の close で残りを破棄する", async () => {
    // Arrange: 未認証の transport に application data 3 件を buffer する。
    const [session] = await createDtlsSessions();
    const gate = (
      session as unknown as {
        applicationGate: {
          receive(data: Buffer): void;
          authenticate(shouldContinue?: () => boolean): void;
        };
      }
    ).applicationGate;
    const received: string[] = [];
    session.dataReceiver = (buf: Buffer) => {
      received.push(buf.toString());
      // Act: 先頭の配送 callback 内で transport を close する。
      if (received.length === 1) void session.stop();
    };
    gate.receive(Buffer.from("first"));
    gate.receive(Buffer.from("second"));
    gate.receive(Buffer.from("third"));

    try {
      // Act: drain を開始する。
      gate.authenticate();
      await setTimeout(20);

      // Assert: 残りは配送されず、connected へ戻らない。
      expect(received).toEqual(["first"]);
      expect(session.state).toBe("closed");
    } finally {
      await session.stop();
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

  test("connecting 中の start() は既存 handshake に join する", async () => {
    // Arrange
    const [session1, session2] = await createDtlsSessions();
    session1.setRemoteParams(session2.localParameters);
    session2.setRemoteParams(session1.localParameters);

    try {
      // Act: 片側を connecting にしてから start を重ねる
      const first = session1.start();
      await waitForDtlsState(session1, "connecting");
      const second = session1.start();
      await Promise.all([first, second, session2.start()]);

      // Assert: 二重 start でも connected。再入で throw しない
      expect(session1.state).toBe("connected");
      expect(session2.state).toBe("connected");
      await session1.start();
      expect(session1.state).toBe("connected");
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
  srtpProfiles: ConstructorParameters<typeof RTCDtlsTransport>[3] = [],
) {
  const [transport1, transport2] = await iceTransportPair();
  await RTCDtlsTransport.SetupCertificate();

  const session1 = new RTCDtlsTransport(
    config,
    transport1,
    undefined,
    srtpProfiles,
  );
  const session2 = new RTCDtlsTransport(
    config,
    transport2,
    undefined,
    srtpProfiles,
  );

  return [session1, session2] as const;
}

function mutateFingerprint(value: string) {
  const normalized = value.replace(/[^0-9a-f]/gi, "").toUpperCase();
  const flipped = `${normalized[0] === "A" ? "B" : "A"}${normalized.slice(1)}`;
  return flipped.match(/.{2}/g)!.join(":");
}

async function createPreAuthSrtpSession(earlyMediaPolicy: "drop" | "buffer") {
  const [session] = await createDtlsSessions(
    {
      ...defaultPeerConfig,
      warp: { allowEarlyServerData: false, earlyMediaPolicy },
    },
    [ProtectionProfileAes128CmHmacSha1_80],
  );
  const key = Buffer.alloc(16, 1);
  const salt = Buffer.alloc(14, 2);
  session.dtls = {
    srtp: { srtpProfile: ProtectionProfileAes128CmHmacSha1_80 },
    extractSessionKeys: () => ({
      localKey: key,
      localSalt: salt,
      remoteKey: key,
      remoteSalt: salt,
    }),
  } as unknown as NonNullable<typeof session.dtls>;
  session.startSrtp();
  return session;
}

function requireAuthenticatedPair(session: RTCDtlsTransport) {
  const ice = session.iceTransport.connection as unknown as Connection;
  const pair = ice.nominated;
  if (!pair) throw new Error("nominated pair が無い");
  return pair;
}

function injectMediaWith(
  session: RTCDtlsTransport,
  bytes: Buffer,
  override: {
    authenticated?: boolean;
    source?: [string, number];
    generation?: number;
  } = {},
) {
  const ice = session.iceTransport.connection as unknown as Connection;
  const pair = requireAuthenticatedPair(session);
  connectionDatagramEvent(ice as object).execute({
    bytes,
    source: override.source ?? pair.remoteAddr,
    protocol: pair.protocol,
    pair,
    generation: override.generation ?? ice.generation,
    authenticated: override.authenticated ?? true,
  });
}

function injectAuthenticatedMedia(session: RTCDtlsTransport, bytes: Buffer) {
  injectMediaWith(session, bytes);
}
