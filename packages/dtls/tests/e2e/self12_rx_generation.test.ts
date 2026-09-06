import { setTimeout } from "timers/promises";

import { expect, test } from "vitest";

import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
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
  server.setExpectedRxGeneration(() => serverGeneration.value);

  return {
    client,
    clientTransport,
    server,
    serverTransport,
    originalServerOnData,
  };
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
