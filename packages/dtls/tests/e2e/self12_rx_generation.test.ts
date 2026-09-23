import { setTimeout } from "timers/promises";

import { expect, test } from "vitest";

import { UdpTransport } from "../../../common/src";
import { ProtectionProfileAeadAes128Gcm } from "../../../rtp/src/srtp/const";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { HandshakeType } from "../../src/handshake/const";
import { UseSRTP } from "../../src/handshake/extensions/useSrtp";
import { ServerHello } from "../../src/handshake/message/server/hello";
import { ContentType } from "../../src/record/const";
import { FragmentedHandshake } from "../../src/record/message/fragment";
import { DtlsPlaintext } from "../../src/record/message/plaintext";
import { certPem, keyPem } from "../fixture";

type RxHandler = (
  data: Buffer,
  addr: readonly [string, number],
  meta?: { rxGeneration?: number },
) => void;

const cases = [
  {
    name: "DTLS 1.2-only",
    serverVersions: [DtlsVersion.V1_2] as const,
  },
  {
    name: "dual server fallback",
    serverVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2] as const,
  },
] as const;

const signatureHash = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
} as const;

async function waitUntil(
  condition: () => boolean,
  message: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await setTimeout(10);
  }
}

function addressOf(transport: UdpTransport): [string, number] {
  const address = transport.address;
  return [address.address, address.port];
}

async function createPair(
  serverVersions: readonly DtlsVersion[],
  serverGeneration: { value: number },
  clientGeneration: { value: number } = { value: 0 },
) {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash,
    addressValidation: "none",
    protocolVersions: serverVersions,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash,
    addressValidation: "none",
    protocolVersions: [DtlsVersion.V1_2],
  });

  const originalServerOnData = serverTransport.onData as RxHandler;
  serverTransport.onData = ((data, addr) => {
    originalServerOnData(data, addr, {
      rxGeneration: serverGeneration.value,
    });
  }) as typeof serverTransport.onData;
  const originalClientOnData = clientTransport.onData as RxHandler;
  clientTransport.onData = ((data, addr) => {
    originalClientOnData(data, addr, {
      rxGeneration: clientGeneration.value,
    });
  }) as typeof clientTransport.onData;
  server.setExpectedRxGeneration(() => serverGeneration.value);
  client.setExpectedRxGeneration(() => clientGeneration.value);

  return {
    client,
    clientTransport,
    server,
    serverTransport,
    originalServerOnData,
  };
}

function corruptServerHelloUseSrtp(data: Buffer): Buffer | undefined {
  try {
    const record = DtlsPlaintext.deSerialize(data);
    if (record.recordLayerHeader.contentType !== ContentType.handshake) {
      return undefined;
    }
    const handshake = FragmentedHandshake.deSerialize(record.fragment);
    if (
      handshake.msg_type !== HandshakeType.server_hello_2 ||
      handshake.fragment_length !== handshake.length
    ) {
      return undefined;
    }
    const serverHello = ServerHello.deSerialize(handshake.fragment);
    const useSrtp = serverHello.extensions.find(
      (extension) => extension.type === UseSRTP.type,
    );
    if (!useSrtp) return undefined;

    // Arrange: keep the ServerHello framing valid but make use_srtp parsing fail.
    useSrtp.data = Buffer.from([0x00]);
    const malformedBody = serverHello.serialize();
    const malformedHandshake = new FragmentedHandshake(
      handshake.msg_type,
      malformedBody.length,
      handshake.message_seq,
      0,
      malformedBody.length,
      malformedBody,
    );
    return new DtlsPlaintext(
      record.recordLayerHeader,
      malformedHandshake.serialize(),
    ).serialize();
  } catch {
    return undefined;
  }
}

type HandshakeWait = (condition: () => boolean) => Promise<void>;

async function assertStaleRejectDoesNotTearDown(
  serverVersions: readonly DtlsVersion[],
  side: "client" | "server",
) {
  // Arrange: DTLS 1.2-only / dual fallback pair with generation-aware RX on
  // both endpoints, so the rejected handler carries an immutable old token.
  const serverGeneration = { value: 0 };
  const clientGeneration = { value: 0 };
  const { client, clientTransport, server, serverTransport } = await createPair(
    serverVersions,
    serverGeneration,
    clientGeneration,
  );
  const target = side === "client" ? client : server;
  const generation = side === "client" ? clientGeneration : serverGeneration;
  const originalWaitForReady = (
    target as unknown as { waitForReady: HandshakeWait }
  ).waitForReady;
  let waitStarted!: () => void;
  const waitStartedPromise = new Promise<void>((resolve) => {
    waitStarted = resolve;
  });
  let releaseReject!: () => void;
  const rejectRelease = new Promise<void>((resolve) => {
    releaseReject = resolve;
  });
  let rejectNext = true;
  (target as unknown as { waitForReady: HandshakeWait }).waitForReady = async (
    condition,
  ) => {
    if (rejectNext) {
      rejectNext = false;
      waitStarted();
      await rejectRelease;
      throw new Error("stale waitForReady rejection");
    }
    return originalWaitForReady(condition);
  };
  const errors: Error[] = [];
  const errorSubscription = target.onError.subscribe((error) => {
    errors.push(error);
  });
  const connected = Promise.all([
    new Promise<void>((resolve) => client.onConnect.once(resolve)),
    new Promise<void>((resolve) => server.onConnect.once(resolve)),
  ]);

  try {
    // Act: start the real handshake and wait until the selected endpoint is
    // suspended inside its generation-0 asynchronous readiness wait.
    void client.connect().catch(() => undefined);
    await waitStartedPromise;

    // Act: restart ICE before the old wait rejects, then release the stale
    // continuation.  The old handler must be ignored by the socket catch.
    generation.value = 1;
    releaseReject();
    await setTimeout(0);

    // Assert: stale rejection did not emit onError or tear down the association.
    expect(errors).toHaveLength(0);
    expect(
      (target as unknown as { associationTornDown: boolean })
        .associationTornDown,
    ).toBe(false);

    // Act: let the peer retransmit into generation 1 and complete the same
    // association through the current handler.
    await Promise.race([
      connected,
      setTimeout(15_000).then(() => {
        throw new Error(`${side} current-generation retry timeout`);
      }),
    ]);

    // Assert: both endpoints reach connected without a fatal lifecycle edge.
    expect(client.connected).toBe(true);
    expect(server.connected).toBe(true);
    expect(errors).toHaveLength(0);
  } finally {
    errorSubscription.unSubscribe();
    server.setExpectedRxGeneration(undefined);
    client.setExpectedRxGeneration(undefined);
    await Promise.allSettled([client.close(), server.close()]);
    await Promise.allSettled([
      clientTransport.close(),
      serverTransport.close(),
    ]);
  }
}

test.each(cases)(
  "e2e/self12 $name は stale datagram で legacy association を進めない",
  async ({ serverVersions }) => {
    // Arrange: 初回 ClientHello を保留できる DTLS 1.2 / dual pair を用意する。
    const generation = { value: 8 };
    const {
      client,
      clientTransport,
      server,
      serverTransport,
      originalServerOnData,
    } = await createPair(serverVersions, generation);
    const firstFlights: Buffer[] = [];
    const originalClientSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (async (data) => {
      firstFlights.push(Buffer.from(data));
    }) as typeof clientTransport.send;
    let serverReplies = 0;
    const originalServerSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = (async (data, addr) => {
      serverReplies++;
      await originalServerSend(data, addr);
    }) as typeof serverTransport.send;
    const connected = Promise.all([
      new Promise<void>((resolve) => client.onConnect.once(resolve)),
      new Promise<void>((resolve) => server.onConnect.once(resolve)),
    ]);

    try {
      // Act: 旧世代の ClientHello を association の受信入口へ注入する。
      void client.connect().catch(() => undefined);
      await waitUntil(
        () => firstFlights.length > 0,
        "client ClientHello が生成されない",
      );
      originalServerOnData(firstFlights[0]!, addressOf(clientTransport), {
        rxGeneration: generation.value - 1,
      });
      await setTimeout(50);

      // Assert: DTLS 1.2 側は旧世代を解析・応答せず、handshake を進めない。
      expect(serverReplies).toBe(0);
      expect(server.connected).toBe(false);

      // Act: 同じ ClientHello を現在世代で再投入し、通常の retransmission を再開する。
      clientTransport.send = originalClientSend as typeof clientTransport.send;
      originalServerOnData(firstFlights[0]!, addressOf(clientTransport), {
        rxGeneration: generation.value,
      });

      // Assert: 現世代だけが HVR/Flight4 以降を進めて接続を成立させる。
      await Promise.race([
        connected,
        setTimeout(15_000).then(() => {
          throw new Error("current-generation DTLS 1.2 handshake timeout");
        }),
      ]);
      expect(client.connected).toBe(true);
      expect(server.connected).toBe(true);
    } finally {
      server.setExpectedRxGeneration(undefined);
      await Promise.allSettled([client.close(), server.close()]);
      await Promise.allSettled([
        clientTransport.close(),
        serverTransport.close(),
      ]);
    }
  },
  25_000,
);

test("e2e/self12 dual client は commit12 後の use_srtp 解析失敗を stale として捨てない", async () => {
  // Arrange: dual client と DTLS 1.2 server の実 UDP 接続を用意する。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const originalSend = serverTransport.send.bind(serverTransport);
  let malformed = false;
  serverTransport.send = async (data, addr) => {
    const corrupted = !malformed
      ? corruptServerHelloUseSrtp(Buffer.from(data))
      : undefined;
    if (corrupted) {
      malformed = true;
      await originalSend(corrupted, addr);
      return;
    }
    await originalSend(data, addr);
  };

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash,
    addressValidation: "none",
    protocolVersions: [DtlsVersion.V1_2],
    srtpProfiles: [ProtectionProfileAeadAes128Gcm],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash,
    addressValidation: "none",
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    srtpProfiles: [ProtectionProfileAeadAes128Gcm],
  });
  const errors: Error[] = [];
  const errorSubscription = client.onError.subscribe((error) => {
    errors.push(error);
  });

  try {
    // Act: commit12 の直後に malformed use_srtp を解析させる。
    await client.connect().catch(() => undefined);
    await waitUntil(() => malformed, "malformed ServerHello が送信されない");

    // Assert: 現在の dual handler の失敗として通知し、接続を破棄する。
    await waitUntil(() => errors.length > 0, "解析失敗が通知されない");
    expect(errors[0]!.message).toMatch(/use_srtp|truncated|MKI/i);
    expect(
      (client as unknown as { associationTornDown: boolean })
        .associationTornDown,
    ).toBe(true);
  } finally {
    errorSubscription.unSubscribe();
    await Promise.allSettled([client.close(), server.close()]);
    await Promise.allSettled([
      clientTransport.close(),
      serverTransport.close(),
    ]);
  }
}, 25_000);

test.each(cases)(
  "e2e/self12 $name は waitForReady 中の restart 後に stale continuation を実行しない",
  async ({ serverVersions }) => {
    // Arrange: server の Finished 処理を await 中に止め、legacy handshake を観測する。
    const generation = { value: 0 };
    const { client, server, clientTransport, serverTransport } =
      await createPair(serverVersions, generation);
    let releaseWait!: () => void;
    let waitEntered!: () => void;
    const waitEnteredPromise = new Promise<void>((resolve) => {
      waitEntered = resolve;
    });
    const waitRelease = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const originalWaitForReady = (
      server as unknown as {
        waitForReady: (condition: () => boolean) => Promise<void>;
      }
    ).waitForReady;
    let blockNextWait = true;
    (
      server as unknown as {
        waitForReady: (condition: () => boolean) => Promise<void>;
      }
    ).waitForReady = async (condition) => {
      if (blockNextWait) {
        blockNextWait = false;
        waitEntered();
        await waitRelease;
      }
      return originalWaitForReady(condition);
    };
    const connected = Promise.all([
      new Promise<void>((resolve) => client.onConnect.once(resolve)),
      new Promise<void>((resolve) => server.onConnect.once(resolve)),
    ]);

    try {
      // Act: 通常の DTLS 1.2 handshake を開始し、server の Finished 待機へ到達させる。
      void client.connect().catch(() => undefined);
      await waitEnteredPromise;

      // Act: await 中に ICE restart を起こして旧世代を無効化する。
      generation.value = 1;
      releaseWait();
      await setTimeout(0);

      // Assert: 旧 Finished continuation は connected を発火しない。
      expect(server.connected).toBe(false);

      // Act: client の次世代 retransmission は新しい metadata で届けられる。
      await Promise.race([
        connected,
        setTimeout(15_000).then(() => {
          throw new Error("current-generation continuation timeout");
        }),
      ]);

      // Assert: 新世代の DTLS 1.2 continuation だけで両端が完了する。
      expect(client.connected).toBe(true);
      expect(server.connected).toBe(true);
    } finally {
      server.setExpectedRxGeneration(undefined);
      await Promise.allSettled([client.close(), server.close()]);
      await Promise.allSettled([
        clientTransport.close(),
        serverTransport.close(),
      ]);
    }
  },
  25_000,
);

test.each(cases)(
  "e2e/self12 $name client は旧世代の waitForReady reject で teardown しない",
  async ({ serverVersions }) => {
    await assertStaleRejectDoesNotTearDown(serverVersions, "client");
  },
  25_000,
);

test.each(cases)(
  "e2e/self12 $name server は旧世代の waitForReady reject で teardown しない",
  async ({ serverVersions }) => {
    await assertStaleRejectDoesNotTearDown(serverVersions, "server");
  },
  25_000,
);
