import { createSocket } from "dgram";
import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { createPlaintext } from "../../src/record/builder";
import { AlertDesc, ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

async function connectPair12() {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("connect timeout")),
      15_000,
    );
    let c = false;
    let s = false;
    const done = () => {
      if (c && s) {
        clearTimeout(timer);
        resolve();
      }
    };
    client.onConnect.subscribe(() => {
      c = true;
      done();
    });
    server.onConnect.subscribe(() => {
      s = true;
      done();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    void client.connect();
  });

  return { client, server, clientTransport, serverTransport };
}

function peerOf(t: { address: { address: string; port: number } | string }): [
  string,
  number,
] {
  const a = t.address as { address: string; port: number };
  return [a.address === "0.0.0.0" ? "127.0.0.1" : a.address, a.port];
}

/**
 * P1: 接続後 epoch-0 平文 fatal は unauthenticated — association を落とさない。
 */
test("e2e/self12: epoch-0 fatal alert after connect does not tear down", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair12();
  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(1));

  // Act: plaintext fatal (epoch 0) from real peer address
  const alertPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([2, AlertDesc.HandshakeFailure]),
  );
  (client as any).udpOnMessage(alertPkt, peerOf(serverTransport));
  await new Promise((r) => setTimeout(r, 30));

  // Assert: still connected
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(client.connected).toBe(true);
  expect((client as any).associationTornDown).toBe(false);
  await client.send(Buffer.from("still-ok"));

  client.close();
  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: spoofed UDP peer の epoch-0 fatal は pin で drop — terminal にしない。
 */
test("e2e/self12: spoofed UDP peer epoch-0 fatal does not tear down server", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair12();
  expect((server as any).transport.pinnedPeer).toBeTruthy();

  const errors: Error[] = [];
  const closes: number[] = [];
  server.onError.subscribe((e) => errors.push(e));
  server.onClose.subscribe(() => closes.push(1));

  const spoof = createSocket("udp4");
  await new Promise<void>((r) => spoof.bind(0, "127.0.0.1", () => r()));
  const spoofPeer: [string, number] = ["127.0.0.1", spoof.address().port];

  // Act: inject fatal as if from spoof peer (bypassing real UDP, tests RX gate)
  const alertPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([2, AlertDesc.InternalError]),
  );
  (server as any).udpOnMessage(alertPkt, spoofPeer);
  await new Promise((r) => setTimeout(r, 30));

  // Assert
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(server.connected).toBe(true);
  expect((server as any).associationTornDown).toBe(false);
  // pin は維持、rinfo は pin へ restore 済み
  expect((server as any).matchesPinnedPeer(peerOf(clientTransport))).toBe(true);

  await server.send(Buffer.from("to-client"));
  client.close();
  server.close();
  spoof.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: spoof peer からの app data / garbage は onData に出ない。
 */
test("e2e/self12: spoofed peer cannot deliver application data to server", async () => {
  const { client, server, clientTransport, serverTransport } =
    await connectPair12();

  const data: Buffer[] = [];
  server.onData.subscribe((d) => data.push(d));

  const spoofPeer: [string, number] = ["127.0.0.1", 39999];
  // Epoch-0 fake app (unauthenticated) — drop
  const app = serializePlaintextRecord(
    ContentType.applicationData,
    0,
    1,
    Buffer.from("ghost-from-spoof"),
  );
  (server as any).udpOnMessage(app, spoofPeer);
  // Real client app still works
  await client.send(Buffer.from("from-real-client"));
  await new Promise((r) => setTimeout(r, 80));

  expect(data.map((b) => b.toString("utf8"))).toEqual(["from-real-client"]);
  expect(server.connected).toBe(true);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: dual committed12 でも carrier.inject の spoof peer は drop。
 */
test("e2e/self12: dual committed12 carrier.inject spoof peer is dropped", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    // 1.2-only server so dual client commits to 1.2
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15_000);
    let c = false;
    let s = false;
    const done = () => {
      if (c && s) {
        clearTimeout(timer);
        resolve();
      }
    };
    client.onConnect.subscribe(() => {
      c = true;
      done();
    });
    server.onConnect.subscribe(() => {
      s = true;
      done();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    void client.connect();
  });

  expect((client as any).dualAssociationPhase).toBe("committed12");

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(1));

  const spoofAlert = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([2, AlertDesc.HandshakeFailure]),
  );
  // carrier inject from non-association peer
  const carrier = (client as any).associationCarrier;
  if (carrier?.inject) {
    carrier.inject(spoofAlert, ["127.0.0.1", 45000]);
  } else {
    // associationInject path
    (client as any).associationInject?.(spoofAlert, ["127.0.0.1", 45000]);
  }
  await new Promise((r) => setTimeout(r, 40));

  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(client.connected).toBe(true);
  expect((client as any).associationTornDown).toBe(false);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: terminal 後 renegotiation() は association を復活させない。
 */
test("e2e/self12: renegotiation rejected after terminal close", async () => {
  const { client, server, clientTransport, serverTransport } =
    await connectPair12();

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.close();
  await new Promise((r) => setTimeout(r, 30));
  expect((client as any).associationTornDown).toBe(true);

  client.renegotiation();
  expect(errors.some((e) => /closed|renegotiation/i.test(e.message))).toBe(
    true,
  );
  expect((client as any).associationTornDown).toBe(true);
  await expect(client.send(Buffer.from("x"))).rejects.toThrow(/closed/i);

  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * 回帰: 認証済み encrypted fatal は今まで通り terminal。
 */
test("e2e/self12: AEAD-protected fatal from pin still tears down", async () => {
  const { client, server, clientTransport, serverTransport } =
    await connectPair12();

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(1));

  const alertFrag = Buffer.from([2, AlertDesc.DecryptError]);
  const pkt = createPlaintext((server as any).dtls)(
    [{ type: ContentType.alert, fragment: alertFrag }],
    ++(server as any).dtls.recordSequenceNumber,
  )[0];
  const wire = (server as any).cipher.encryptPacket(pkt).serialize();
  (client as any).udpOnMessage(wire, peerOf(serverTransport));
  await new Promise((r) => setTimeout(r, 30));

  expect(errors.length).toBe(1);
  expect(closes.length).toBe(1);
  expect((client as any).associationTornDown).toBe(true);

  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
