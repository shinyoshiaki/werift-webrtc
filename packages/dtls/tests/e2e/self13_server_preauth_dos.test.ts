import { createSocket } from "dgram";
import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { DirectHandshakeCarrier } from "../../src/carrier/direct";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { HandshakeType } from "../../src/handshake/const";
import { createDtlsServerInternal } from "../../src/internal";
import { AlertDesc, ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

function epoch0Alert(desc: number, level = 2): Buffer {
  return serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([level, desc]),
  );
}

/**
 * P1: pure DTLS 1.3 server は pre-cookie 未認証 fatal で listener を落とさない。
 */
test("e2e/self13: pure server ignores unauth epoch-0 fatal (no DoS)", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
  });

  const errors: Error[] = [];
  const closes: number[] = [];
  server.onError.subscribe((e) => errors.push(e));
  server.onClose.subscribe(() => closes.push(1));

  const eng = (server as any).engine13;
  expect(eng).toBeTruthy();
  expect(eng.isClosed()).toBe(false);

  // Act: spoof UDP-path fatal
  const alert = epoch0Alert(AlertDesc.HandshakeFailure);
  serverTransport.onData?.(alert, ["127.0.0.1", 19991] as any);
  await new Promise((r) => setTimeout(r, 40));

  // Assert
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect((server as any).associationTornDown).toBe(false);
  expect(eng.isClosed()).toBe(false);

  // carrier.inject path (association-owned)
  const carrier = eng.getHandshakeCarrier();
  carrier.inject(epoch0Alert(AlertDesc.InternalError), ["10.1.2.3", 7]);
  await new Promise((r) => setTimeout(r, 40));
  expect(errors.length).toBe(0);
  expect((server as any).associationTornDown).toBe(false);

  // close_notify / warning also unauth pre-keys
  carrier.inject(epoch0Alert(AlertDesc.CloseNotify, 1), ["10.0.0.2", 9]);
  carrier.inject(epoch0Alert(AlertDesc.UserCanceled, 1), ["10.0.0.3", 9]);
  await new Promise((r) => setTimeout(r, 40));
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(eng.isClosed()).toBe(false);

  server.close();
  await serverTransport.close().catch(() => {});
}, 15_000);

/**
 * P1: dual server が 1.3 に commit した後も、未認証 epoch-0 fatal で落ちない。
 */
test("e2e/self13: dual server after 1.3 select ignores unauth fatal", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
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

  expect(server.isDtls13).toBe(true);
  const errors: Error[] = [];
  server.onError.subscribe((e) => errors.push(e));

  // spoof fatal after connected — epoch-0 dropped (protected keys exist)
  const spoof = createSocket("udp4");
  await new Promise<void>((r) => spoof.bind(0, "127.0.0.1", () => r()));
  const port = (serverTransport.address as { port: number }).port;
  await new Promise<void>((resolve, reject) => {
    spoof.send(epoch0Alert(AlertDesc.HandshakeFailure), port, "127.0.0.1", (e) =>
      e ? reject(e) : resolve(),
    );
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(errors.length).toBe(0);
  expect((server as any).associationTornDown).toBe(false);
  expect(server.connected).toBe(true);

  // post-handshake epoch-0 handshake must not change state
  const junkHs = Buffer.alloc(20, 0x11);
  junkHs[0] = HandshakeType.client_hello_1;
  const hsPkt = serializePlaintextRecord(ContentType.handshake, 0, 1, junkHs);
  (server as any).udpOnMessage(hsPkt, ["127.0.0.1", spoof.address().port]);
  await new Promise((r) => setTimeout(r, 30));
  expect(server.connected).toBe(true);
  expect((server as any).associationTornDown).toBe(false);

  client.close();
  // peer close will terminal server eventually
  for (let i = 0; i < 50; i++) {
    if ((server as any).associationTornDown) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  spoof.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 25_000);

/**
 * association dispatcher: terminal 後の inject / UDP は no-op。
 */
test("e2e/self13: pure server association RX drops after terminal", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const carrier = new DirectHandshakeCarrier(serverTransport, { mtu: 1200 });
  const server = createDtlsServerInternal({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
    handshakeCarrier: carrier,
  });

  // force terminal without full HS
  (server as any).prepareAssociationClosedFromEngine();
  expect((server as any).associationTornDown).toBe(true);

  const eng = (server as any).engine13;
  const errors: Error[] = [];
  server.onError.subscribe((e) => errors.push(e));

  carrier.inject(epoch0Alert(AlertDesc.HandshakeFailure), ["1.2.3.4", 1]);
  serverTransport.onData?.(epoch0Alert(AlertDesc.InternalError), [
    "1.2.3.4",
    2,
  ] as any);
  await new Promise((r) => setTimeout(r, 30));
  expect(errors.length).toBe(0);
  // engine may still exist until close, but association ignores RX
  expect((server as any).associationTornDown).toBe(true);

  try {
    server.close();
  } catch {
    /* */
  }
  await serverTransport.close().catch(() => {});
}, 10_000);

/**
 * post-handshake pure 1.3: epoch-0 handshake is dropped; connection stays up.
 */
test("e2e/self13: post-handshake epoch-0 handshake does not change state", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
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
    void client.connect();
  });

  const errors: Error[] = [];
  const closes: number[] = [];
  server.onError.subscribe((e) => errors.push(e));
  server.onClose.subscribe(() => closes.push(1));
  client.onError.subscribe((e) => errors.push(e));

  const body = Buffer.alloc(32, 0x5a);
  const hs = Buffer.alloc(12 + body.length);
  hs[0] = HandshakeType.client_hello_1;
  hs.writeUIntBE(body.length, 1, 3);
  hs.writeUInt16BE(0, 4);
  hs.writeUIntBE(0, 6, 3);
  hs.writeUIntBE(body.length, 9, 3);
  body.copy(hs, 12);
  const pkt = serializePlaintextRecord(ContentType.handshake, 0, 99, hs);

  // inject toward both
  (server as any).udpOnMessage(pkt, [
    (clientTransport.address as any).address === "0.0.0.0"
      ? "127.0.0.1"
      : (clientTransport.address as any).address,
    (clientTransport.address as any).port,
  ]);
  (client as any).udpOnMessage(pkt, [
    (serverTransport.address as any).address === "0.0.0.0"
      ? "127.0.0.1"
      : (serverTransport.address as any).address,
    (serverTransport.address as any).port,
  ]);
  await new Promise((r) => setTimeout(r, 40));

  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(server.connected).toBe(true);
  expect(client.connected).toBe(true);
  expect((server as any).associationTornDown).toBe(false);
  expect((client as any).associationTornDown).toBe(false);
  await client.send(Buffer.from("still-ok"));

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
