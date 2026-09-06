import { setTimeout } from "timers/promises";

import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { AlertDesc, ContentType } from "../../src/record/const";
import { encryptRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

const dtls13Options = {
  cert: certPem,
  key: keyPem,
  protocolVersions: [DtlsVersion.V1_3] as const,
  addressValidation: "none" as const,
};

test.each(["transport.onData", "carrier.inject"] as const)(
  "e2e/self13 %s の RX 世代不一致 datagram は queue 実行時に破棄される",
  async (inboundPath) => {
    // Arrange: 1.3-only の client/server を用意し、client 初回 flight を採取する。
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = { address: "127.0.0.1", port: 9 };
    const server = new DtlsServer({
      transport: serverTransport,
      ...dtls13Options,
    });
    const client = new DtlsClient({
      transport: clientTransport,
      ...dtls13Options,
    });
    const capturedFlights: Buffer[] = [];
    const originalClientSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (async (data: Buffer, addr?: [string, number]) => {
      capturedFlights.push(Buffer.from(data));
      return originalClientSend(data, addr);
    }) as typeof clientTransport.send;
    const sentByServer: Buffer[] = [];
    serverTransport.send = (async (data: Buffer) => {
      sentByServer.push(Buffer.from(data));
    }) as typeof serverTransport.send;
    // restart 後世代を 7 として provider を固定する。
    server.setExpectedRxGeneration(() => 7);
    const engine = (
      server as unknown as {
        engine13?: {
          hsPhase?: string;
          getHandshakeCarrier(): {
            inject(
              data: Buffer,
              peer?: [string, number],
              opts?: { rxGeneration?: number },
            ): Promise<void>;
          };
        };
      }
    ).engine13;
    if (!engine) throw new Error("1.3 engine が無い");
    const deliver = async (
      data: Buffer,
      peer: [string, number],
      rxGeneration: number,
    ) => {
      if (inboundPath === "transport.onData") {
        const onData = serverTransport.onData as (
          data: Buffer,
          addr: [string, number],
          meta?: { rxGeneration?: number },
        ) => void;
        await Promise.resolve(onData(data, peer, { rxGeneration }));
        return;
      }
      await engine.getHandshakeCarrier().inject(data, peer, { rxGeneration });
    };

    try {
      // Act: client の初回 flight が出るまで待つ。
      void client.connect().catch(() => undefined);
      const deadline = Date.now() + 5_000;
      while (capturedFlights.length === 0) {
        if (Date.now() > deadline) throw new Error("client flight が採れない");
        await setTimeout(20);
      }
      const flight = capturedFlights[0]!;
      const peer = clientTransport.address as unknown as [string, number];

      // Act: 旧世代 (6) の受付は queue 実行時に破棄される。
      await deliver(flight, peer, 6);
      await setTimeout(50);

      // Assert: server は一切応答せず、handshake は開始前相のまま。
      expect(sentByServer).toHaveLength(0);
      expect(engine.hsPhase).toBe("wait_client_hello");

      // Act: 現世代 (7) の同一 flight は正常に処理される。
      await deliver(flight, peer, 7);
      await setTimeout(200);

      // Assert: server が ServerHello flight を返す。
      expect(sentByServer.length).toBeGreaterThan(0);
    } finally {
      server.setExpectedRxGeneration(undefined);
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  20_000,
);

test.each(["transport.onData", "carrier.inject"] as const)(
  "e2e/self13 %s は同一 datagram 内の後続 record も restart 世代で破棄する",
  async (inboundPath) => {
    // Arrange: 実 DTLS 1.3 association を接続し、同一 epoch の暗号 record を
    // 2 件まとめて注入できる受信経路を用意する。
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const server = new DtlsServer({
      transport: serverTransport,
      ...dtls13Options,
    });
    const client = new DtlsClient({
      transport: clientTransport,
      ...dtls13Options,
    });
    const connected = new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(
        () => reject(new Error("self13 handshake timeout")),
        10_000,
      );
      server.onConnect.once(() => {
        globalThis.clearTimeout(timer);
        resolve();
      });
      server.onError.once((error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      });
    });
    let expectedGeneration = 7;
    const delivered: string[] = [];
    server.setExpectedRxGeneration(() => expectedGeneration);
    server.onData.subscribe((data) => {
      delivered.push(data.toString());
      if (delivered.length === 1) {
        // Act: 先行 record の callback 内で ICE restart 相当の世代変更を起こす。
        expectedGeneration++;
      }
    });

    try {
      // Act: client の実 DTLS handshake を完了させる。
      void client.connect().catch(() => undefined);
      await connected;

      const clientEngine = (
        client as unknown as {
          engine13?: {
            writeEpoch: number;
            epochs: Map<number, { writeKeys?: unknown; writeSequence: number }>;
          };
        }
      ).engine13;
      if (!clientEngine) throw new Error("client 1.3 engine が無い");
      const epoch = clientEngine.epochs.get(clientEngine.writeEpoch);
      if (!epoch?.writeKeys) throw new Error("client write key が無い");
      const first = encryptRecord(
        Buffer.from("fresh-first"),
        ContentType.applicationData,
        epoch as Parameters<typeof encryptRecord>[2],
      );
      const second = encryptRecord(
        Buffer.from("stale-second"),
        ContentType.applicationData,
        epoch as Parameters<typeof encryptRecord>[2],
      );
      const datagram = Buffer.concat([first, second]);
      // Act: 世代 7 として、2 record を同一 datagram のまま実受信経路へ渡す。
      if (inboundPath === "transport.onData") {
        const onData = serverTransport.onData as (
          data: Buffer,
          addr?: [string, number],
          meta?: { rxGeneration?: number },
        ) => void | Promise<void>;
        await onData(datagram, undefined, { rxGeneration: 7 });
      } else {
        const carrier = (
          server as unknown as {
            engine13?: {
              getHandshakeCarrier(): {
                inject(
                  data: Buffer,
                  peer?: [string, number],
                  opts?: { rxGeneration?: number },
                ): Promise<void>;
              };
            };
          }
        ).engine13?.getHandshakeCarrier();
        if (!carrier) throw new Error("server 1.3 carrier が無い");
        await carrier.inject(datagram, undefined, { rxGeneration: 7 });
      }

      // Assert: 先頭だけが配送され、後続の旧世代 record は同じ datagram
      // の中にあっても新世代へ漏れない。
      await setTimeout(0);
      expect(delivered).toEqual(["fresh-first"]);
    } finally {
      server.setExpectedRxGeneration(undefined);
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  20_000,
);

test("e2e/self13 は Finished 受信中の restart 後も ACK と handshakeComplete を維持する", async () => {
  // Arrange: 実 UDP の両端に受信世代メタデータを付与し、server の
  // connected 通知内で ICE restart 相当の世代変更を注入する。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const server = new DtlsServer({
    transport: serverTransport,
    ...dtls13Options,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...dtls13Options,
  });
  let serverGeneration = 0;
  const clientGeneration = 0;
  let dropNextServerDatagram = false;
  let droppedFinishedAck = false;
  const originalServerOnData = serverTransport.onData as (
    data: Buffer,
    addr: readonly [string, number],
    meta?: { rxGeneration?: number },
  ) => void;
  const originalClientOnData = clientTransport.onData as (
    data: Buffer,
    addr: readonly [string, number],
    meta?: { rxGeneration?: number },
  ) => void;
  const originalServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (async (data, addr) => {
    if (dropNextServerDatagram) {
      // Act: 最初の Finished ACK だけを落とし、再受信時の replay ACK
      // が受理記録を使って返ることを検証できるようにする。
      dropNextServerDatagram = false;
      droppedFinishedAck = true;
      return;
    }
    return originalServerSend(data, addr);
  }) as typeof serverTransport.send;
  serverTransport.onData = ((
    data: Buffer,
    addr: [string, number],
    meta?: { rxGeneration?: number },
  ) =>
    originalServerOnData(data, addr, {
      ...meta,
      rxGeneration: serverGeneration,
    })) as typeof serverTransport.onData;
  clientTransport.onData = ((
    data: Buffer,
    addr: [string, number],
    meta?: { rxGeneration?: number },
  ) =>
    originalClientOnData(data, addr, {
      ...meta,
      rxGeneration: clientGeneration,
    })) as typeof clientTransport.onData;
  server.setExpectedRxGeneration(() => serverGeneration);
  client.setExpectedRxGeneration(() => clientGeneration);

  let restartInjected = false;
  server.onConnect.subscribe(() => {
    if (restartInjected) return;
    // Act: Finished 検証 callback の途中で ICE restart が起きた状態を作る。
    restartInjected = true;
    serverGeneration += 1;
    dropNextServerDatagram = true;
  });

  const serverEngine = (
    server as unknown as {
      engine13?: {
        readiness: { handshakeComplete: boolean };
        retransmitCount: number;
        totalRetransmitCount: number;
        getPendingFlightSize(): number;
        getPendingFlightRecordCount(): number;
      };
    }
  ).engine13;
  const clientEngine = (
    client as unknown as {
      engine13?: {
        readiness: { handshakeComplete: boolean };
        retransmitCount: number;
        totalRetransmitCount: number;
        getPendingFlightSize(): number;
        getPendingFlightRecordCount(): number;
      };
    }
  ).engine13;
  if (!serverEngine || !clientEngine) {
    throw new Error("1.3 engine が無い");
  }

  const failure = new Promise<never>((_, reject) => {
    server.onError.once(reject);
    client.onError.once(reject);
  });
  const connectFailure = client.connect().then(
    () => new Promise<never>(() => undefined),
    (error) => Promise.reject(error),
  );
  const completion = Promise.all([
    server.waitForHandshakeComplete(),
    client.waitForHandshakeComplete(),
  ]);
  let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = globalThis.setTimeout(
      () => reject(new Error("Finished ACK restart recovery timeout")),
      5_000,
    );
  });

  try {
    // Act: 両端の handshakeComplete と Finished ACK の完了を待つ。
    await Promise.race([completion, connectFailure, failure, timeout]);

    // Assert: 世代変更後も両端が完了し、再送 flight が残らない。
    expect(restartInjected).toBe(true);
    expect(droppedFinishedAck).toBe(true);
    expect(serverEngine.readiness.handshakeComplete).toBe(true);
    expect(clientEngine.readiness.handshakeComplete).toBe(true);
    expect(server.readiness.handshakeComplete).toBe(true);
    expect(client.readiness.handshakeComplete).toBe(true);
    expect(serverEngine.getPendingFlightSize()).toBe(0);
    expect(serverEngine.getPendingFlightRecordCount()).toBe(0);
    expect(clientEngine.getPendingFlightSize()).toBe(0);
    expect(clientEngine.getPendingFlightRecordCount()).toBe(0);
    expect(clientEngine.totalRetransmitCount).toBeGreaterThan(0);

    const serverRetransmitCount = serverEngine.totalRetransmitCount;
    const clientRetransmitCount = clientEngine.totalRetransmitCount;
    await setTimeout(100);
    expect(serverEngine.totalRetransmitCount).toBe(serverRetransmitCount);
    expect(clientEngine.totalRetransmitCount).toBe(clientRetransmitCount);
  } finally {
    if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
    server.setExpectedRxGeneration(undefined);
    client.setExpectedRxGeneration(undefined);
    await Promise.allSettled([client.close(), server.close()]);
  }
}, 20_000);

type GenerationAware13Pair = {
  server: DtlsServer;
  client: DtlsClient;
  serverTransport: UdpTransport;
  clientTransport: UdpTransport;
  generations: { server: number; client: number };
};

async function createGenerationAware13Pair(): Promise<GenerationAware13Pair> {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const server = new DtlsServer({
    transport: serverTransport,
    ...dtls13Options,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...dtls13Options,
  });
  const generations = { server: 0, client: 0 };
  const originalServerOnData = serverTransport.onData as (
    data: Buffer,
    addr: readonly [string, number],
    meta?: { rxGeneration?: number },
  ) => void;
  const originalClientOnData = clientTransport.onData as (
    data: Buffer,
    addr: readonly [string, number],
    meta?: { rxGeneration?: number },
  ) => void;
  serverTransport.onData = ((data, addr) =>
    originalServerOnData(data, addr, {
      rxGeneration: generations.server,
    })) as typeof serverTransport.onData;
  clientTransport.onData = ((data, addr) =>
    originalClientOnData(data, addr, {
      rxGeneration: generations.client,
    })) as typeof clientTransport.onData;
  server.setExpectedRxGeneration(() => generations.server);
  client.setExpectedRxGeneration(() => generations.client);
  return {
    server,
    client,
    serverTransport,
    clientTransport,
    generations,
  };
}

type AckCapableEngine = {
  sendAck: (opts?: { allowEmpty?: boolean }) => Promise<number>;
  closed: boolean;
};

type AlertCapableEngine = {
  closed: boolean;
  close: () => void;
  sendFatalAlert: (description: number) => Promise<void>;
  handleAlert: (
    fragment: Buffer,
    receivedEpoch: number,
    sequenceNumber?: number,
    acceptedGeneration?: number,
  ) => void;
  getPeerAddr: () => [string, number] | undefined;
  getHandshakeCarrier: () => {
    inject(
      data: Buffer,
      peer?: [string, number],
      opts?: { rxGeneration?: number },
    ): Promise<void>;
  };
};

async function connectGenerationAware13Pair(pair: GenerationAware13Pair) {
  const connected = Promise.all([
    new Promise<void>((resolve) => pair.server.onConnect.once(resolve)),
    new Promise<void>((resolve) => pair.client.onConnect.once(resolve)),
  ]);
  const failure = new Promise<never>((_, reject) => {
    pair.server.onError.once(reject);
    pair.client.onError.once(reject);
  });
  // Act: start the real DTLS 1.3 association through UDP RX metadata wrappers.
  void pair.client.connect().catch(() => undefined);
  await Promise.race([connected, failure]);
}

test("e2e/self13 は旧世代の KeyUpdate ACK 送信 reject で association を壊さない", async () => {
  // Arrange: 接続済みの DTLS 1.3 pair と、server ACK の遅延・reject gate を用意する。
  const pair = await createGenerationAware13Pair();
  const serverErrors: Error[] = [];
  const errorSubscription = pair.server.onError.subscribe((error) => {
    serverErrors.push(error);
  });
  const serverEngine = (
    pair.server as unknown as { engine13?: AckCapableEngine }
  ).engine13;
  const clientEngine = (
    pair.client as unknown as {
      engine13?: { keyUpdate(requestUpdate?: boolean): Promise<void> };
    }
  ).engine13;
  if (!serverEngine || !clientEngine) {
    throw new Error("1.3 engine が無い");
  }
  try {
    await connectGenerationAware13Pair(pair);
    const originalSendAck = serverEngine.sendAck.bind(serverEngine);
    let ackEntered!: () => void;
    const ackEnteredPromise = new Promise<void>((resolve) => {
      ackEntered = resolve;
    });
    let releaseAck!: () => void;
    const ackRelease = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    let rejectNextAck = true;
    serverEngine.sendAck = async (opts) => {
      if (rejectNextAck) {
        rejectNextAck = false;
        ackEntered();
        await ackRelease;
        throw new Error("stale KeyUpdate ACK send failure");
      }
      return originalSendAck(opts);
    };

    // Act: KeyUpdate ACK の送信待ち中に ICE restart 相当の世代変更を起こし、
    // 旧世代の送信失敗を発生させる。
    void clientEngine.keyUpdate(true).catch(() => undefined);
    await ackEnteredPromise;
    pair.generations.server = 1;
    releaseAck();
    await setTimeout(20);

    // Assert: 旧世代の reject は onError / teardown に伝播しない。
    expect(serverErrors).toHaveLength(0);
    expect(pair.server.connected).toBe(true);
    expect(serverEngine.closed).toBe(false);
  } finally {
    errorSubscription.unSubscribe();
    pair.server.setExpectedRxGeneration(undefined);
    pair.client.setExpectedRxGeneration(undefined);
    await Promise.allSettled([pair.client.close(), pair.server.close()]);
  }
}, 20_000);

test("e2e/self13 は現世代の KeyUpdate ACK 送信 reject を fatal にする", async () => {
  // Arrange: 旧世代変更なしの接続済み pair と、現世代 ACK reject gate を用意する。
  const pair = await createGenerationAware13Pair();
  const serverErrors: Error[] = [];
  const errorSubscription = pair.server.onError.subscribe((error) => {
    serverErrors.push(error);
  });
  const serverEngine = (
    pair.server as unknown as { engine13?: AckCapableEngine }
  ).engine13;
  const clientEngine = (
    pair.client as unknown as {
      engine13?: { keyUpdate(requestUpdate?: boolean): Promise<void> };
    }
  ).engine13;
  if (!serverEngine || !clientEngine) {
    throw new Error("1.3 engine が無い");
  }
  const fatal = new Promise<void>((resolve) => {
    pair.server.onError.once(() => resolve());
  });

  try {
    await connectGenerationAware13Pair(pair);
    const originalSendAck = serverEngine.sendAck.bind(serverEngine);
    let rejectNextAck = true;
    serverEngine.sendAck = async (opts) => {
      if (rejectNextAck) {
        rejectNextAck = false;
        throw new Error("current KeyUpdate ACK send failure");
      }
      return originalSendAck(opts);
    };

    // Act: current-generation KeyUpdate ACK を reject し、通常の fatal 経路を通す。
    void clientEngine.keyUpdate(true).catch(() => undefined);
    await Promise.race([
      fatal,
      setTimeout(5_000).then(() => {
        throw new Error("current-generation KeyUpdate fatal timeout");
      }),
    ]);

    // Assert: 現世代の認証済み失敗は引き続き onError / teardown になる。
    expect(serverErrors).toHaveLength(1);
    expect(pair.server.connected).toBe(false);
    expect(serverEngine.closed).toBe(true);
  } finally {
    errorSubscription.unSubscribe();
    pair.server.setExpectedRxGeneration(undefined);
    pair.client.setExpectedRxGeneration(undefined);
    await Promise.allSettled([pair.client.close(), pair.server.close()]);
  }
}, 20_000);

test.each(["close_notify", "fatal"] as const)(
  "e2e/self13 は旧世代の暗号化 %s を現 association に適用しない",
  async (alertKind) => {
    // Arrange: 接続済み pair と、server から暗号化 Alert を採取する送信口を用意する。
    const pair = await createGenerationAware13Pair();
    const clientErrors: Error[] = [];
    const errorSubscription = pair.client.onError.subscribe((error) => {
      clientErrors.push(error);
    });
    const serverEngine = (
      pair.server as unknown as { engine13?: AlertCapableEngine }
    ).engine13;
    const clientEngine = (
      pair.client as unknown as { engine13?: AlertCapableEngine }
    ).engine13;
    if (!serverEngine || !clientEngine) {
      throw new Error("1.3 engine が無い");
    }
    const captured: Buffer[] = [];
    const originalSend = pair.serverTransport.send;
    const originalSendAndWait = pair.serverTransport.sendAndWait;
    try {
      await connectGenerationAware13Pair(pair);
      pair.serverTransport.send = async (data) => {
        captured.push(Buffer.from(data));
      };
      pair.serverTransport.sendAndWait = async (data) => {
        captured.push(Buffer.from(data));
      };

      // Act: server の暗号化 Alert を実際の DTLS engine から生成する。
      if (alertKind === "close_notify") {
        serverEngine.close();
      } else {
        await serverEngine.sendFatalAlert(AlertDesc.InternalError);
      }
      const deadline = Date.now() + 2_000;
      while (captured.length === 0) {
        if (Date.now() >= deadline) {
          throw new Error(`${alertKind} が採取できない`);
        }
        await setTimeout(10);
      }

      const peer = clientEngine.getPeerAddr();
      if (!peer) throw new Error("client peer address が無い");
      const originalHandleAlert = clientEngine.handleAlert.bind(clientEngine);
      let alertAccepted = false;
      clientEngine.handleAlert = (
        fragment,
        receivedEpoch,
        sequenceNumber,
        acceptedGeneration,
      ) => {
        // 暗号化 record の検証後、Alert callback 実行直前に restart を注入する。
        alertAccepted = true;
        pair.generations.client = 1;
        return originalHandleAlert(
          fragment,
          receivedEpoch,
          sequenceNumber,
          acceptedGeneration,
        );
      };
      await clientEngine.getHandshakeCarrier().inject(captured[0]!, peer, {
        rxGeneration: 0,
      });
      await setTimeout(20);

      // Assert: 旧世代の close_notify/fatal Alert は状態変更・onError を起こさない。
      expect(alertAccepted).toBe(true);
      expect(clientErrors).toHaveLength(0);
      expect(pair.client.connected).toBe(true);
      expect(clientEngine.closed).toBe(false);
    } finally {
      pair.serverTransport.send = originalSend;
      if (originalSendAndWait) {
        pair.serverTransport.sendAndWait = originalSendAndWait;
      }
      errorSubscription.unSubscribe();
      pair.server.setExpectedRxGeneration(undefined);
      pair.client.setExpectedRxGeneration(undefined);
      await Promise.allSettled([pair.client.close(), pair.server.close()]);
    }
  },
  20_000,
);
