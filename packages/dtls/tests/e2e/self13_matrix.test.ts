import { UdpTransport } from "../../../common/src";
import {
  DtlsClient,
  DtlsServer,
  DtlsVersion,
  ProtocolVersionError,
} from "../../src";
import { NamedCurveAlgorithm } from "../../src/cipher/const";
import { SessionType } from "../../src/cipher/suites/abstract";
import { Dtls13Connection } from "../../src/engine/v1_3/connection";
import { certPem, keyPem } from "../fixture";

const base13 = {
  cert: certPem,
  key: keyPem,
  protocolVersions: [DtlsVersion.V1_3] as const,
  addressValidation: "none" as const,
};

async function udpPair() {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  return { serverTransport, clientTransport };
}

test("e2e/self13 P-256 via public DtlsClient/DtlsServer namedGroups", async () => {
  // Arrange: 前提を準備する
  const { serverTransport, clientTransport } = await udpPair();
  const groups = [NamedCurveAlgorithm.secp256r1_23] as const;
  const server = new DtlsServer({
    transport: serverTransport,
    ...base13,
    namedGroups: groups,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...base13,
    namedGroups: groups,
  });

  // Act / Assert: 期待どおりの結果を検証する
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("p256 api timeout")),
      15_000,
    );
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("p256-api"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("p256-api");
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 20_000);

test("e2e/self13 HRR when client key_share group mismatches server preference", async () => {
  // Arrange: 前提を準備する
  const { serverTransport, clientTransport } = await udpPair();
  const server = new DtlsServer({
    transport: serverTransport,
    ...base13,
    namedGroups: [NamedCurveAlgorithm.secp256r1_23],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...base13,
    // Client starts with X25519 only; after HRR must switch to P-256.
    // Engine re-generates key share for HRR selected group.
    namedGroups: [
      NamedCurveAlgorithm.x25519_29,
      NamedCurveAlgorithm.secp256r1_23,
    ],
  });

  // Force mismatch: server only P-256, client first share X25519 — server HRRs.
  // Client lists both so second CH can include P-256.
  // To force HRR, server groups = [P-256] and client initially uses X25519 only.
  // Re-create client with X25519-only first share by using engine that only has x25519 first.
  // Public API: client namedGroups [x25519] only vs server [p256] cannot complete without
  // client supporting p256 after HRR. So client must list both, but only send x25519 first.
  // Current engine sends only selectedGroup (= first). Server P-256 only → HRR for P-256.
  // Client has secp256r1 in list → sendClientHello(group) regenerates. Need client groups to include P-256.

  // Act / Assert: HelloRetryRequest 経路を検証する
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HRR timeout")), 20_000);
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("hrr-ok"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("hrr-ok");
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    // Client first group X25519, server only P-256 → HRR
    // Fix options: client namedGroups order x25519 then p256; server only p256
    await client.connect();
  });
}, 25_000);

test("e2e/self13 multi-record flight via small MTU", async () => {
  // Arrange: 前提を準備する
  const { serverTransport, clientTransport } = await udpPair();
  const server = new DtlsServer({
    transport: serverTransport,
    ...base13,
    mtu: 200,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...base13,
    mtu: 200,
  });

  // Act / Assert: MTU 制約を検証する
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mtu timeout")), 20_000);
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("mtu-ok"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("mtu-ok");
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 25_000);

test("e2e/self13 large multi-fragment handshake body via very small MTU", async () => {
  // Arrange: 前提を準備する
  const { serverTransport, clientTransport } = await udpPair();
  const server = new DtlsServer({
    transport: serverTransport,
    ...base13,
    mtu: 180,
    certificateRequest: true,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...base13,
    mtu: 180,
    certificateRequest: true,
  });

  // Act / Assert: MTU 制約を検証する
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("large flight timeout")),
      25_000,
    );
    let clientDone = false;
    let serverDone = false;
    const maybeDone = () => {
      if (!clientDone || !serverDone) return;
      expect(client.remoteCertificate!.length).toBeGreaterThan(100);
      expect(server.remoteCertificate!.length).toBeGreaterThan(100);
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    };
    client.onConnect.subscribe(() => {
      clientDone = true;
      maybeDone();
    });
    server.onConnect.subscribe(() => {
      serverDone = true;
      maybeDone();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 30_000);

test("e2e/self13 reorders encrypted handshake records within a datagram batch", async () => {
  // Arrange: 前提を準備する
  // Plaintext ServerHello must stay first so keys can be installed.
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const encHeld: Buffer[] = [];
  let seenPlain = false;
  let reordered = false;
  const origSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    // DTLSPlaintext starts with content type 20-26; unified ciphertext with 001xxxxx
    const isUnified = (buf[0] & 0xe0) === 0x20;
    if (!isUnified) {
      seenPlain = true;
      await origSend(buf, addr);
      return;
    }
    if (!seenPlain || reordered) {
      await origSend(buf, addr);
      return;
    }
    encHeld.push(Buffer.from(buf));
    if (encHeld.length >= 2) {
      reordered = true;
      // deliver second encrypted datagram before the first
      await origSend(encHeld[1], addr);
      await origSend(encHeld[0], addr);
      for (const p of encHeld.slice(2)) {
        await origSend(p, addr);
      }
      encHeld.length = 0;
    }
  };

  const server = new DtlsServer({
    transport: serverTransport,
    ...base13,
    // Encourage multiple encrypted datagrams
    mtu: 400,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...base13,
    mtu: 400,
  });

  // Act / Assert: ハンドシェイクを検証する
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("reorder timeout")),
      20_000,
    );
    setTimeout(() => {
      if (!reordered && encHeld.length > 0) {
        reordered = true;
        void (async () => {
          for (const p of encHeld) await origSend(p);
          encHeld.length = 0;
        })();
      }
    }, 800);

    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 25_000);

test("e2e/self13 fail() closes association and clears pending flight", async () => {
  // Arrange: 前提を準備する
  const { serverTransport, clientTransport } = await udpPair();
  // 1.3-only client vs nothing useful: inject version error via 1.2 peer path
  // Direct engine: trigger fail via protocol version alert path from empty peer
  const server = new Dtls13Connection(
    {
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      addressValidation: "none",
    },
    SessionType.SERVER,
  );
  // Act / Assert: 不正入力を拒否する
  let hardClosed = false;
  let hardErrored = false;
  server.onClose.subscribe(() => {
    hardClosed = true;
  });
  server.onError.subscribe(() => {
    hardErrored = true;
  });
  (server as any).fail(new Error("hard-fail-close"));
  expect(hardErrored).toBe(true);
  expect(hardClosed).toBe(true);
  expect(server.isClosed()).toBe(true);
  expect(server.getPendingFlightSize()).toBe(0);

  // Soft ProtocolVersionError: closed for 1.3 RX, pending cleared, transport reusable
  const server2 = new Dtls13Connection(
    {
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      addressValidation: "none",
    },
    SessionType.SERVER,
  );
  let softClosed = false;
  server2.onClose.subscribe(() => {
    softClosed = true;
  });
  (server2 as any).fail(new ProtocolVersionError("soft-version"));
  expect(server2.isClosed()).toBe(true);
  expect(server2.getPendingFlightSize()).toBe(0);
  expect(softClosed).toBe(false); // transport retained for dual fallback
});
