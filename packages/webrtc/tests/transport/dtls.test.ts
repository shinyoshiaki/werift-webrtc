import { Certificate } from "@fidm/x509";
import { setTimeout } from "timers/promises";
import { vi } from "vitest";

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
import type { RTCTransportStats } from "../../src/media/stats";
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

  test("DTLS internal early data is included in WARP stats until expiry", async () => {
    // Arrange: client の最終 flight を継続的に落とし、server が未接続のまま
    // application data を DTLS 内部 queue に保持する構成を作る。
    const [server, client] = await createUnstartedDtlsSessions({
      protocolVersions: [DtlsVersion.V1_3],
    });
    const clientIce = client.iceTransport.connection as Connection & {
      send: (data: Buffer) => Promise<void>;
    };
    const originalClientSend = clientIce.send.bind(clientIce);
    let clientDatagrams = 0;
    let allowNextClientDatagram = false;
    clientIce.send = async (data: Buffer) => {
      clientDatagrams++;
      // ClientHello だけは通し、final flight の再送は server の handshake
      // 完了を防ぐため継続的に落とす。
      if (clientDatagrams === 1) {
        return originalClientSend(data);
      }
      if (!allowNextClientDatagram) return;
      allowNextClientDatagram = false;
      return originalClientSend(data);
    };

    void server.start().catch(() => undefined);
    const payload = Buffer.alloc(27, 0x5a);

    try {
      // Act: client 側の fingerprint 認証完了後、次の1 packetだけ送る。
      await client.start();
      expect(clientDatagrams).toBeGreaterThanOrEqual(2);
      allowNextClientDatagram = true;
      await client.sendData(payload);

      // Assert: Finished 未到着の server 内部 queue が公開 transport stats に
      // packet 数と byte 数として反映されることを確認する。
      const bufferedDeadline = Date.now() + 5_000;
      let bufferedStats: RTCTransportStats | undefined;
      while (Date.now() < bufferedDeadline) {
        const stats = await server.getStats();
        bufferedStats = stats.find(
          (stat): stat is RTCTransportStats => stat.type === "transport",
        );
        if (
          bufferedStats?.warpEarlyBufferedPackets === 1 &&
          bufferedStats.warpEarlyBufferedBytes === payload.length
        ) {
          break;
        }
        await setTimeout(20);
      }
      expect(bufferedStats).toMatchObject({
        warpEarlyBufferedPackets: 1,
        warpEarlyBufferedBytes: payload.length,
      });

      // Act: retention timer を満了させ、保留 packet を全破棄する。
      await setTimeout(2_100);

      // Assert: timeout による DTLS 内部 queue の drop も diagnostics に残る。
      const expiredStats = (await server.getStats()).find(
        (stat): stat is RTCTransportStats => stat.type === "transport",
      );
      expect(expiredStats).toMatchObject({
        warpEarlyBufferedPackets: 0,
        warpEarlyBufferedBytes: 0,
        warpEarlyDroppedPackets: 1,
        warpEarlyDroppedBytes: payload.length,
      });
    } finally {
      await Promise.allSettled([client.stop(), server.stop()]);
    }
  }, 15_000);

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

  test("非SPEDの公開 transport は early DTLS application data を送信しない", async () => {
    // Arrange: 公開 RTCDtlsTransport に early policy を指定しても、SPED marker は付けない。
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
      // Act: server が write-ready になっても、非SPED transport から pre-auth 送信を試みる。
      void server.start().catch(() => undefined);
      void client.start().catch(() => undefined);
      await server.waitForWriteReady();
      await expect(
        server.sendData(Buffer.from("must-not-leak")),
      ).rejects.toThrow(/authenticated/i);
      await waitForDtlsState(client, "failed");

      // Assert: 公開 transport の設定だけでは early outbound permission を得られない。
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

  test("非SPEDの公開 transport は pre-auth RTP/RTCP を送信しない", async () => {
    // Arrange: early media policy を指定しても、受信側 fingerprint を壊した非SPED transport を使う。
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
      // Act: server write-ready 直後に pre-auth protected RTP/RTCP を送る。
      void server.start().catch(() => undefined);
      void client.start().catch(() => undefined);
      await server.waitForWriteReady();
      expect(
        await server.sendRtp(
          Buffer.from("must-not-leak"),
          new RtpHeader({ ssrc: 7, payloadType: 96 }),
        ),
      ).toBe(0);
      expect(
        await server.sendRtcp([new RtcpRrPacket({ ssrc: 7, reports: [] })]),
      ).toBe(0);
      await waitForDtlsState(client, "failed");

      // Assert: 非SPED transport の early media は送信されず、上位イベントもゼロのまま。
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

  test("start 前の media buffer は ICE restart で queue と timer を破棄する", async () => {
    // Arrange: DTLS start 前に認証済み pair から media を buffer できる transport を用意する。
    const session = await createPreAuthSrtpSession("buffer");
    const protectedLikeRtp = new RtpPacket(
      new RtpHeader({ ssrc: 12, payloadType: 96 }),
      Buffer.from("encrypted-like"),
    ).serialize();
    const internals = session as unknown as {
      mediaBuffer: {
        push(data: Buffer): boolean;
        snapshot(): {
          bufferedPackets: number;
          bufferedBytes: number;
          droppedPackets: number;
        };
      };
      handleIceRestart(): void;
    };
    const ice = session.iceTransport.connection as unknown as {
      generation: number;
    };

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      // Act: 旧世代の packet を実際の ICE datagram demux 経由で保留する。
      injectAuthenticatedMedia(session, protectedLikeRtp);
      const oldBuffer = internals.mediaBuffer;
      const oldBeforeRestart = oldBuffer.snapshot();
      const timersBeforeRestart = vi.getTimerCount();
      expect(oldBeforeRestart.bufferedPackets).toBe(1);
      expect(oldBeforeRestart.bufferedBytes).toBe(protectedLikeRtp.length);
      expect(timersBeforeRestart).toBeGreaterThan(0);

      // Act: attempt 未発行のまま ICE generation を進めて restart を通知する。
      ice.generation++;
      session.handleIceRestart();
      const newBuffer = internals.mediaBuffer;

      // Assert: 旧 queue と timer は破棄され、新 buffer は空である。
      expect(newBuffer).not.toBe(oldBuffer);
      expect(newBuffer.snapshot()).toMatchObject({
        bufferedPackets: 0,
        bufferedBytes: 0,
      });
      expect(oldBuffer.snapshot()).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 1,
      });
      expect(vi.getTimerCount()).toBe(timersBeforeRestart - 1);

      // Act: 新世代の packet を新 buffer に保留し、旧 timer の期限を越える。
      newBuffer.push(Buffer.from("fresh-generation"));
      expect(newBuffer.snapshot().bufferedPackets).toBe(1);
      vi.advanceTimersByTime(2_001);

      // Assert: 新世代の retention は独立して期限切れになり、旧 buffer は再実行されない。
      expect(newBuffer.snapshot()).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 1,
      });
      expect(oldBuffer.snapshot()).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 1,
      });
    } finally {
      vi.useRealTimers();
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

  test("複合 SRTCP の通知中に close すると後続 packet を配送しない", async () => {
    // Arrange: 1つの SRTCP datagram に複数 packet を含める実接続を用意する。
    const profile = ProtectionProfileAes128CmHmacSha1_80;
    const [sender, receiver] = await createDtlsSessions(
      {
        ...defaultPeerConfig,
        protocolVersions: [DtlsVersion.V1_3],
      },
      [profile],
    );
    sender.setRemoteParams(receiver.localParameters);
    receiver.setRemoteParams(sender.localParameters);
    await Promise.all([sender.start(), receiver.start()]);
    let received = 0;
    receiver.onRtcp.subscribe(() => {
      received++;
      if (received === 1) void receiver.stop();
    });

    try {
      // Act: 複合 SRTCP を送信し、先頭 callback 内で transport を停止する。
      await sender.sendRtcp([
        new RtcpRrPacket({ ssrc: 0x101, reports: [] }),
        new RtcpRrPacket({ ssrc: 0x202, reports: [] }),
      ]);
      await setTimeout(20);

      // Assert: stop 後は同じ datagram の後続 RTCP も配送されない。
      expect(received).toBe(1);
      expect(receiver.state).toBe("closed");
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

  test("drain 中の restart は terminal abort せず新 attempt 用に gate を開き直す", async () => {
    // Arrange: 未認証の transport に application data 2 件を buffer する。
    const [session] = await createDtlsSessions();
    const gate = (
      session as unknown as {
        applicationGate: {
          receive(data: Buffer): void;
          authenticate(
            shouldContinue?: () => boolean,
            isTerminal?: () => boolean,
          ): void;
          restartForNewAttempt(): void;
          snapshot(): { bufferedPackets: number };
        };
      }
    ).applicationGate;
    const received: string[] = [];
    session.dataReceiver = (buf: Buffer) => {
      received.push(buf.toString());
    };
    gate.receive(Buffer.from("a1"));
    gate.receive(Buffer.from("a2"));

    try {
      // Act: 先頭配送直後に restart 相当の再初期化が入り、guard が drift を検出する。
      let restarted = false;
      gate.authenticate(
        () => {
          if (received.length === 1 && !restarted) {
            restarted = true;
            // syncAttemptToIceGeneration の connecting 分岐と同等の再初期化。
            gate.restartForNewAttempt();
            return false;
          }
          return !restarted;
        },
        () => false,
      );

      // Assert: 旧 drain 残余は terminal abort されず、gate は新世代用に空く。
      expect(received).toEqual(["a1"]);
      gate.receive(Buffer.from("b1"));
      expect(gate.snapshot().bufferedPackets).toBe(1);

      // Act: 新 attempt の認証として drain し直す。
      gate.authenticate(
        () => true,
        () => false,
      );

      // Assert: 新世代 data が復旧し、旧残余は混入しない。
      expect(received).toEqual(["a1", "b1"]);
    } finally {
      await session.stop();
    }
  });

  test("application gate restart は旧 queue と retention timer を即時破棄する", async () => {
    // Arrange: transport の gate から旧 buffer を取得し、fake clock 上で timer を起動する。
    const [session] = await createDtlsSessions();
    const gate = (
      session as unknown as {
        applicationGate: {
          receive(data: Buffer): void;
          restartForNewAttempt(): void;
          buffer: {
            snapshot(): {
              bufferedPackets: number;
              droppedPackets: number;
            };
          };
        };
      }
    ).applicationGate;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    gate.receive(Buffer.from("old-attempt"));
    const oldBuffer = gate.buffer;
    const timersBeforeRestart = vi.getTimerCount();

    try {
      // Act: ICE generation 切り替えと同じ gate restart を実行する。
      gate.restartForNewAttempt();

      // Assert: 旧 record は drop 計上され、その retention timer は残らない。
      expect(timersBeforeRestart).toBeGreaterThan(0);
      expect(oldBuffer.snapshot()).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 1,
      });
      expect(vi.getTimerCount()).toBe(timersBeforeRestart - 1);

      // Act: 旧 retention 期限を越える。
      vi.advanceTimersByTime(2_001);

      // Assert: dispose 済み旧 buffer の統計は callback で再更新されない。
      expect(oldBuffer.snapshot()).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 1,
      });
    } finally {
      vi.useRealTimers();
      await session.stop();
    }
  });

  test("stop は ICE datagram listener を解放する", async () => {
    // Arrange: transport 構築時に購読した callback を spy へ差し替える。
    const [session] = await createDtlsSessions();
    const ice = session.iceTransport.connection as unknown as Connection;
    const pair = requireAuthenticatedPair(session);
    const onIceDatagram = vi.fn();
    (
      session as unknown as {
        onIceDatagram(ctx: unknown): void;
      }
    ).onIceDatagram = onIceDatagram;
    const datagram = connectionDatagramEvent(ice as object);
    const ctx = {
      bytes: Buffer.from([0]),
      source: pair.remoteAddr,
      protocol: pair.protocol,
      pair,
      generation: ice.generation,
      authenticated: true,
    };

    // Act: close 前に一度通知し、その後 transport を二重停止して再通知する。
    datagram.execute(ctx);
    await session.stop();
    await session.stop();
    datagram.execute(ctx);

    // Assert: idempotent な stop 後の通知は破棄済み callback へ到達しない。
    expect(onIceDatagram).toHaveBeenCalledTimes(1);
  });

  test("connecting 中の generation drift は gate を再初期化して attempt を付け替える", async () => {
    // Arrange: handshake 開始前の attempt を connecting 状態で発行する。
    const [session] = await createDtlsSessions();
    const internals = session as unknown as {
      beginAttempt(generation: number): { id: number; iceGeneration: number };
      syncAttemptToIceGeneration(): void;
      currentAttempt?: { id: number; iceGeneration: number };
      applicationGate: {
        receive(data: Buffer): void;
        authenticate(shouldContinue?: () => boolean): void;
        snapshot(): { bufferedPackets: number };
      };
    };
    session.state = "connecting";
    const ice = session.iceTransport.connection as unknown as {
      generation: number;
    };
    internals.beginAttempt(ice.generation);
    const received: string[] = [];
    session.dataReceiver = (buf: Buffer) => {
      received.push(buf.toString());
    };
    internals.applicationGate.receive(Buffer.from("stale-buffered"));

    try {
      // Act: answerer 側 restart 相当の generation drift を吸収する。
      ice.generation += 1;
      internals.syncAttemptToIceGeneration();

      // Assert: attempt が新世代へ付け替わり、旧 buffer は破棄される。
      expect(internals.currentAttempt?.iceGeneration).toBe(ice.generation);
      expect(internals.applicationGate.snapshot().bufferedPackets).toBe(0);

      // Act: 新世代の pre-auth data を受けて認証する。
      internals.applicationGate.receive(Buffer.from("fresh"));
      internals.applicationGate.authenticate(() => true);

      // Assert: 新世代 data だけが配送される。
      expect(received).toEqual(["fresh"]);
    } finally {
      await session.stop();
    }
  });

  test("connected 遷移 callback 内の restart では旧 attempt の認証通知を発火しない", async () => {
    // Arrange: 相互認証する DTLS pair を用意する。
    const [session1, session2] = await createDtlsSessions();
    session1.setRemoteParams(session2.localParameters);
    session2.setRemoteParams(session1.localParameters);
    let peerAuthenticatedFires = 0;
    let peerAuthenticatedOutcome = "pending";
    let handshakeCompleteOutcome = "pending";
    (
      session1 as unknown as {
        onPeerAuthenticated: { subscribe(cb: () => void): void };
      }
    ).onPeerAuthenticated.subscribe(() => {
      peerAuthenticatedFires++;
    });
    let handshakeCompleteFires = 0;
    (
      session1 as unknown as {
        onHandshakeComplete: { subscribe(cb: () => void): void };
      }
    ).onHandshakeComplete.subscribe(() => {
      handshakeCompleteFires++;
    });
    const peerAuthenticatedWait = session1.waitForPeerAuthenticated().then(
      () => {
        peerAuthenticatedOutcome = "resolved";
      },
      () => {
        peerAuthenticatedOutcome = "rejected";
      },
    );
    const handshakeCompleteWait = session1.waitForHandshakeComplete().then(
      () => {
        handshakeCompleteOutcome = "resolved";
      },
      () => {
        handshakeCompleteOutcome = "rejected";
      },
    );

    try {
      // Act: connected 遷移 callback 内で generation を進めて restart させる。
      const onStateChange = new Promise<void>((resolve) => {
        const check = () => {
          if (session1.state === "connected") resolve();
        };
        const poll = setInterval(() => {
          check();
          if (session1.state === "connected" || session1.state === "failed") {
            clearInterval(poll);
          }
        }, 10);
      });
      session1.onStateChange.subscribe((next) => {
        if (next === "connected") {
          // 世代を進めてから明示 restart し、旧 attempt を陳腐化させる。
          const ice = session1.iceTransport.connection as unknown as {
            generation: number;
          };
          ice.generation += 1;
          session1.handleIceRestart();
        }
      });
      await Promise.all([session1.start(), session2.start()]);
      // Act: 旧 attempt の通知ではなく、restart 後の readiness handoff を待つ。
      await Promise.race([
        Promise.all([peerAuthenticatedWait, handshakeCompleteWait]),
        setTimeout(2_000).then(() => {
          throw new Error("readiness waiter handoff timeout");
        }),
      ]);
      await onStateChange;
      await setTimeout(50);

      // Assert: 旧 attempt の通知は発火せず、登録済み waiter は新 attempt
      // の latch から解決される。
      expect(peerAuthenticatedFires).toBe(0);
      expect(handshakeCompleteFires).toBe(1);
      expect(peerAuthenticatedOutcome).toBe("resolved");
      expect(handshakeCompleteOutcome).toBe("resolved");
      expect(session1.dtls?.readiness.handshakeComplete).toBe(true);
      expect(session1.state).toBe("connected");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("DTLS 1.3 final ACK 後の restart は上位 handshakeComplete waiter を引き継ぐ", async () => {
    // Arrange: 最終 ACK だけを保留できる実 DTLS 1.3 association を用意する。
    const [server, client] = await createDtlsSessions({
      protocolVersions: [DtlsVersion.V1_3],
    });
    server.setRemoteParams(client.localParameters);
    client.setRemoteParams(server.localParameters);
    const serverIce = server.iceTransport.connection as unknown as {
      send: (data: Buffer) => Promise<void>;
    };
    const originalSend = serverIce.send.bind(serverIce);
    const held: Buffer[] = [];
    let holding = true;
    serverIce.send = async (data: Buffer) => {
      if (holding && server.dtls?.readiness.peerHandshakeAuthenticated) {
        held.push(Buffer.from(data));
        return;
      }
      return originalSend(data);
    };
    let handshakeCompleteOutcome = "pending";
    const handshakeCompleteWait = client.waitForHandshakeComplete().then(
      () => {
        handshakeCompleteOutcome = "resolved";
      },
      () => {
        handshakeCompleteOutcome = "rejected";
      },
    );

    try {
      // Act: fingerprint 認証後、client final-flight の ACK 待ちで両 ICE を restart する。
      await Promise.all([server.start(), client.start()]);
      await setTimeout(10);
      expect(held.length).toBeGreaterThan(0);
      expect(client.dtls?.readiness.handshakeComplete).toBe(false);

      for (const session of [server, client]) {
        session.iceTransport.restart();
        session.handleIceRestart();
      }
      const serverTransport = server.iceTransport;
      const clientTransport = client.iceTransport;
      type IceGathererView = {
        gather(): Promise<void>;
        localParameters: Parameters<typeof serverTransport.setRemoteParams>[0];
        localCandidates: Array<
          Parameters<typeof serverTransport.addRemoteCandidate>[0]
        >;
      };
      const serverGather = (
        serverTransport as unknown as { iceGather: IceGathererView }
      ).iceGather;
      const clientGather = (
        clientTransport as unknown as { iceGather: IceGathererView }
      ).iceGather;
      await Promise.all([serverGather.gather(), clientGather.gather()]);
      serverTransport.setRemoteParams(clientGather.localParameters);
      clientTransport.setRemoteParams(serverGather.localParameters);
      clientGather.localCandidates.forEach((candidate) =>
        serverTransport.addRemoteCandidate(candidate),
      );
      serverGather.localCandidates.forEach((candidate) =>
        clientTransport.addRemoteCandidate(candidate),
      );
      await Promise.all([serverTransport.start(), clientTransport.start()]);
      holding = false;
      await originalSend(held[0]!);
      await Promise.race([
        client.dtls!.waitForHandshakeComplete(),
        setTimeout(2_000).then(() => {
          throw new Error("lower DTLS ACK timeout");
        }),
      ]);
      await Promise.race([
        handshakeCompleteWait,
        setTimeout(2_000).then(() => {
          throw new Error("upper handshakeComplete waiter timeout");
        }),
      ]);

      // Assert: 現世代の実 ACK で下位 DTLS が完了し、上位 waiter も解決する。
      expect(client.dtls?.readiness.handshakeComplete).toBe(true);
      expect(server.dtls?.readiness.handshakeComplete).toBe(true);
      expect(server.state).toBe("connected");
      expect(client.state).toBe("connected");
      expect(handshakeCompleteOutcome).toBe("resolved");
    } finally {
      holding = false;
      await Promise.allSettled([server.stop(), client.stop()]);
    }
  }, 10_000);

  test("restart 前の writeReady waiter は新 attempt に許可を再付与しない", async () => {
    // Arrange: lower DTLS の write-ready 完了を制御できる transport を用意する。
    const [transport] = await createDtlsSessions({
      ...defaultPeerConfig,
      protocolVersions: [DtlsVersion.V1_3],
    });
    const internals = transport as unknown as {
      state: string;
      dtls: {
        isDtls13: boolean;
        close(): void;
        waitForWriteReady(): Promise<void>;
      };
      currentAttempt?: { id: number; iceGeneration: number };
      beginAttempt(generation: number): unknown;
      readiness: { writeReady: boolean };
      onWriteReady: { execute(): void };
    };
    let resolveWriteReady!: () => void;
    const writeReady = new Promise<void>((resolve) => {
      resolveWriteReady = resolve;
    });
    internals.dtls = {
      isDtls13: true,
      close: () => {},
      waitForWriteReady: () => writeReady,
    };
    const connection = transport.iceTransport.connection as unknown as {
      generation: number;
    };

    try {
      internals.state = "connecting";
      internals.beginAttempt(connection.generation);
      const oldWaiter = transport.waitForWriteReady();

      // Act: lower DTLS の完了前に ICE generation を進めて新 attempt を開始する。
      connection.generation++;
      internals.beginAttempt(connection.generation);
      resolveWriteReady();
      await Promise.resolve();
      await Promise.resolve();

      // Assert: 旧 waiter の完了では新 attempt の permission を再付与しない。
      expect(internals.readiness.writeReady).toBe(false);

      // Act: 新 attempt の上位 readiness edge を発火して旧 waiter を解放する。
      internals.readiness.writeReady = true;
      internals.onWriteReady.execute();
      await oldWaiter;

      // Assert: write-ready は新 attempt による明示通知後だけ有効になる。
      expect(internals.readiness.writeReady).toBe(true);
    } finally {
      await transport.stop();
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

  test("接続後の同一 fingerprint 差し替えは認証状態を維持する", async () => {
    // Arrange: 接続済み pair を用意する。
    const [session1, session2] = await dtlsTransportPair();
    const receiver = new DummyDataReceiver();
    session1.dataReceiver = receiver.handleData;

    try {
      // Act: 同一 fingerprint で remote SDP を適用し直す (ICE restart 相当)。
      session1.setRemoteParams(session2.localParameters);
      session2.setRemoteParams(session1.localParameters);
      session2.sendData(Buffer.from("after-same-fp"));
      await setTimeout(100);

      // Assert: connected のまま送受信が継続する。
      expect(session1.state).toBe("connected");
      expect(session2.state).toBe("connected");
      expect(receiver.data).toEqual([Buffer.from("after-same-fp")]);
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("接続後の fingerprint 不一致差し替えは旧認証を残さず失敗させる", async () => {
    // Arrange: 接続済み pair を用意する。
    const [session1, session2] = await dtlsTransportPair();
    const receiver = new DummyDataReceiver();
    session1.dataReceiver = receiver.handleData;
    const expected = session2.localParameters.fingerprints[0];

    try {
      // Act: 改ざん fingerprint で remote SDP を適用し直す。
      session1.setRemoteParams(
        new RTCDtlsParameters(
          [
            new RTCDtlsFingerprint(
              expected.algorithm,
              mutateFingerprint(expected.value),
            ),
          ],
          session2.localParameters.role,
        ),
      );

      // Assert: transport は失敗し、以後の一件も配送・送信しない。
      expect(session1.state).toBe("failed");
      expect(session1.lastError?.message).toMatch(/fingerprint/i);
      await session2.sendData(Buffer.from("must-not-leak"));
      await setTimeout(100);
      expect(receiver.data).toHaveLength(0);
      await expect(session1.sendData(Buffer.from("x"))).rejects.toThrow();
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("stop は DTLS engine を close し early queue と carrier を破棄する", async () => {
    // Arrange: 1.3 handshake 中の pair を用意し、engine 生成を待つ。
    const [server, client] = await createDtlsSessions({
      protocolVersions: [DtlsVersion.V1_3],
    });
    server.setRemoteParams(client.localParameters);
    client.setRemoteParams(server.localParameters);
    const serverStart = server.start();
    void serverStart.catch(() => undefined);
    const clientStart = client.start();
    void clientStart.catch(() => undefined);
    const deadline = Date.now() + 5_000;
    const engineOf = (session: RTCDtlsTransport) =>
      (
        session as unknown as {
          dtls?: {
            engine13?: {
              closed: boolean;
              earlyAppDataBuffer: { snapshot(): { bufferedPackets: number } };
              getHandshakeCarrier(): { isClosed(): boolean } | undefined;
            };
          };
        }
      ).dtls?.engine13;
    while (!engineOf(client)) {
      if (Date.now() > deadline) throw new Error("1.3 engine が生成されない");
      await setTimeout(20);
    }
    // stop() で socket が engine 参照を外すため、参照は事前に保持する。
    const engine = engineOf(client)!;

    const secondClientStart = client.start();
    void secondClientStart.catch(() => undefined);
    const peerAuthenticatedWait = client.waitForPeerAuthenticated();
    void peerAuthenticatedWait.catch(() => undefined);
    const handshakeCompleteWait = client.waitForHandshakeComplete();
    void handshakeCompleteWait.catch(() => undefined);

    try {
      // Act: handshake 完了を待たず client を停止する。
      await client.stop();

      // Assert: engine は閉じ、early queue と carrier が残らない。
      expect(engine.closed).toBe(true);
      expect(engine.earlyAppDataBuffer.snapshot().bufferedPackets).toBe(0);
      expect(engine.getHandshakeCarrier()?.isClosed()).toBe(true);
      expect(client.state).toBe("closed");
      await expect(clientStart).rejects.toThrow(/closed|completed/);
      await expect(secondClientStart).rejects.toThrow(/closed|completed/);
      await expect(peerAuthenticatedWait).rejects.toThrow(/closed|readiness/);
      await expect(handshakeCompleteWait).rejects.toThrow(/closed|readiness/);
    } finally {
      await Promise.allSettled([serverStart, server.stop()]);
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

async function createUnstartedDtlsSessions(
  config: ConstructorParameters<typeof RTCDtlsTransport>[0] = defaultPeerConfig,
) {
  const [transport1, transport2] = await iceTransportPair();
  await RTCDtlsTransport.SetupCertificate();

  const session1 = new RTCDtlsTransport(config, transport1);
  const session2 = new RTCDtlsTransport(config, transport2);
  session1.setRemoteParams(session2.localParameters);
  session2.setRemoteParams(session1.localParameters);

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
