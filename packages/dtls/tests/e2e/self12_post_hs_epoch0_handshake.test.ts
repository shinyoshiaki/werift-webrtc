import { expect, test } from "vitest";
import { DtlsVersion } from "../../src";
import { HandshakeType } from "../../src/handshake/const";
import { ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { connectUdpDtlsPair, dtls12AddressPin, peerOf } from "../fixture";

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
  // Arrange: address pin 付きの pure DTLS 1.2 で接続し、pin と onError を控える
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({
      shared: { ...dtls12AddressPin, protocolVersions: [DtlsVersion.V1_2] },
    });
  expect(server.connected).toBe(true);
  expect((server as any).dtls.epoch).toBeGreaterThan(0);
  const pinBefore = [...(server as any).transport.pinnedPeer] as [
    string,
    number,
  ];

  const errors: Error[] = [];
  server.onError.subscribe((e) => errors.push(e));

  // Act: pin 済み peer から epoch-0 の ClientHello 風レコードを server に注入する
  (server as any).udpOnMessage(
    epoch0ClientHelloLike(),
    peerOf(clientTransport),
  );

  // Assert: 接続 / epoch / pin は変わらず、エラーも出ず送信できる（同期処理なので待機不要）
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
  // Arrange: dual client × 1.2 server で接続し、committed12 になっていることを確かめる
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({
      shared: { ...dtls12AddressPin, protocolVersions: [DtlsVersion.V1_2] },
      client: { protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2] },
    });
  expect((client as any).dualAssociationPhase).toBe("committed12");
  expect(server.connected).toBe(true);
  expect(client.connected).toBe(true);

  // Act: 両側に相手 peer から epoch-0 の ClientHello 風レコードを注入する
  (server as any).udpOnMessage(
    epoch0ClientHelloLike(),
    peerOf(clientTransport),
  );
  (client as any).udpOnMessage(
    epoch0ClientHelloLike(),
    peerOf(serverTransport),
  );

  // Assert: 両側とも接続と committed12 を保ち、tear down せず送信できる
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
  // Arrange: address pin 付きの pure DTLS 1.2 で接続する
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({
      shared: { ...dtls12AddressPin, protocolVersions: [DtlsVersion.V1_2] },
    });
  expect(server.connected).toBe(true);

  // Act: pin と違う spoof peer から epoch-0 の ClientHello 風レコードを注入する
  (server as any).udpOnMessage(epoch0ClientHelloLike(), ["127.0.0.1", 39998]);
  // Assert: pin gate で drop され、接続を保ったまま送信できる
  expect(server.connected).toBe(true);
  expect((server as any).associationTornDown).toBe(false);
  await server.send(Buffer.from("ok"));

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
