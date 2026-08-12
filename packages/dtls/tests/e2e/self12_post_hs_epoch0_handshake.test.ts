import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { HandshakeType } from "../../src/handshake/const";
import { ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

async function connectPair12(clientVersions?: readonly DtlsVersion[]) {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: clientVersions ?? [DtlsVersion.V1_2],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
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

function epoch0ClientHelloLike(): Buffer {
  const body = Buffer.alloc(48, 0xcd);
  const hs = Buffer.alloc(12 + body.length);
  hs[0] = HandshakeType.client_hello_1;
  hs.writeUIntBE(body.length, 1, 3);
  hs.writeUInt16BE(0, 4);
  hs.writeUIntBE(0, 6, 3);
  hs.writeUIntBE(body.length, 9, 3);
  body.copy(hs, 12);
  return serializePlaintextRecord(ContentType.handshake, 0, 7, hs);
}

/**
 * P1: pure 1.2 接続後の epoch-0 handshake は drop — renegotiation で
 * connected/keys を壊さない（1.3 と対称）。
 */
test("e2e/self12: post-handshake epoch-0 ClientHello does not renegotiate", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair12();
  expect(server.connected).toBe(true);
  expect((server as any).dtls.epoch).toBeGreaterThan(0);
  const pinBefore = [...(server as any).transport.pinnedPeer] as [
    string,
    number,
  ];

  const errors: Error[] = [];
  server.onError.subscribe((e) => errors.push(e));

  // Act: inject epoch-0 CH-like record from pin peer
  (server as any).udpOnMessage(epoch0ClientHelloLike(), peerOf(clientTransport));

  // Assert: lifecycle unchanged (sync — no await sleep required)
  expect(server.connected).toBe(true);
  expect((server as any).associationTornDown).toBe(false);
  expect((server as any).dtls.epoch).toBeGreaterThan(0);
  expect((server as any).transport.pinnedPeer[0]).toBe(pinBefore[0]);
  expect((server as any).transport.pinnedPeer[1]).toBe(pinBefore[1]);
  expect(errors.length).toBe(0);
  await server.send(Buffer.from("still-connected"));

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: dual committed12 でも post-handshake epoch-0 HS は state 不変。
 */
test("e2e/self12: dual committed12 post-handshake epoch-0 HS is noop", async () => {
  const { client, server, clientTransport, serverTransport } =
    await connectPair12([DtlsVersion.V1_3, DtlsVersion.V1_2]);
  expect((client as any).dualAssociationPhase).toBe("committed12");
  expect(server.connected).toBe(true);
  expect(client.connected).toBe(true);

  (server as any).udpOnMessage(epoch0ClientHelloLike(), peerOf(clientTransport));
  (client as any).udpOnMessage(epoch0ClientHelloLike(), peerOf(serverTransport));

  expect(server.connected).toBe(true);
  expect(client.connected).toBe(true);
  expect((client as any).dualAssociationPhase).toBe("committed12");
  expect((server as any).associationTornDown).toBe(false);
  expect((client as any).associationTornDown).toBe(false);
  await client.send(Buffer.from("ok"));

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * spoof peer の epoch-0 HS は pin gate で drop（既存 spoof と揃え）。
 */
test("e2e/self12: spoof peer epoch-0 handshake is dropped", async () => {
  const { client, server, clientTransport, serverTransport } =
    await connectPair12();
  expect(server.connected).toBe(true);

  (server as any).udpOnMessage(epoch0ClientHelloLike(), ["127.0.0.1", 39998]);
  expect(server.connected).toBe(true);
  expect((server as any).associationTornDown).toBe(false);
  await server.send(Buffer.from("ok"));

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
