import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { AlertDesc, ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * P1: pre-cookie (unpinned) epoch-0 fatal で listening server を DoS できない。
 */
test("e2e/self12: pre-cookie fatal alert does not tear down server", async () => {
  // Arrange: server だけを起動する（まだ pin なし）
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    // DTLS 1.2 の association アドレス pin は opt-in
    peerIdentityMode: "datagram-address",
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  const errors: Error[] = [];
  const closes: number[] = [];
  server.onError.subscribe((e) => errors.push(e));
  server.onClose.subscribe(() => closes.push(1));

  expect((server as any).transport.pinnedPeer).toBeUndefined();

  // Act: 認証前に任意の peer から epoch-0 の fatal alert を偽装して受信させる
  const alertPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([2, AlertDesc.HandshakeFailure]),
  );
  (server as any).udpOnMessage(alertPkt, ["127.0.0.1", 44444]);
  await new Promise((r) => setTimeout(r, 30));

  // Assert: エラー / close は起きず、association は listening のまま
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect((server as any).associationTornDown).toBe(false);
  expect(server.connected).toBe(false);

  // Act: 別の peer から 2 回目の偽装 fatal を受信させる
  (server as any).udpOnMessage(alertPkt, ["10.0.0.1", 1]);
  await new Promise((r) => setTimeout(r, 20));
  // Assert: 2 回目でも tear down しない
  expect(errors.length).toBe(0);
  expect((server as any).associationTornDown).toBe(false);

  server.close();
  await serverTransport.close().catch(() => {});
}, 10_000);

/**
 * P1: pre-cookie malformed ClientHello も association fatal にしない。
 */
test("e2e/self12: pre-cookie malformed ClientHello does not tear down server", async () => {
  // Arrange: server だけを起動し、onError / onClose を記録する
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    peerIdentityMode: "datagram-address",
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  const errors: Error[] = [];
  const closes: number[] = [];
  server.onError.subscribe((e) => errors.push(e));
  server.onClose.subscribe(() => closes.push(1));

  // Act: body が壊れた ClientHello (msg_type 1) の handshake レコードを受信させる
  // DTLS HS header: type(1) length(3) message_seq(2) frag_off(3) frag_len(3) + body
  const body = Buffer.alloc(20, 0xab);
  const hs = Buffer.alloc(12 + body.length);
  hs[0] = 1; // client_hello
  hs.writeUIntBE(body.length, 1, 3);
  hs.writeUInt16BE(0, 4);
  hs.writeUIntBE(0, 6, 3);
  hs.writeUIntBE(body.length, 9, 3);
  body.copy(hs, 12);
  const pkt = serializePlaintextRecord(ContentType.handshake, 0, 0, hs);
  (server as any).udpOnMessage(pkt, ["127.0.0.1", 55555]);

  // Allow async onHandleHandshakes rejection path
  await new Promise((r) => setTimeout(r, 50));

  // Assert: association fatal にならず、エラー / close も起きない
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect((server as any).associationTornDown).toBe(false);

  server.close();
  await serverTransport.close().catch(() => {});
}, 10_000);
