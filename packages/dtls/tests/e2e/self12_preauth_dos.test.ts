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
  // Arrange: server only — no pin yet
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
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

  // Act: spoof fatal from arbitrary peer (pre-auth)
  const alertPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([2, AlertDesc.HandshakeFailure]),
  );
  (server as any).udpOnMessage(alertPkt, ["127.0.0.1", 44444]);
  await new Promise((r) => setTimeout(r, 30));

  // Assert: association still listening
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect((server as any).associationTornDown).toBe(false);
  expect(server.connected).toBe(false);

  // Second spoof still no tear down
  (server as any).udpOnMessage(alertPkt, ["10.0.0.1", 1]);
  await new Promise((r) => setTimeout(r, 20));
  expect(errors.length).toBe(0);
  expect((server as any).associationTornDown).toBe(false);

  server.close();
  await serverTransport.close().catch(() => {});
}, 10_000);

/**
 * P1: pre-cookie malformed ClientHello も association fatal にしない。
 */
test("e2e/self12: pre-cookie malformed ClientHello does not tear down server", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  const errors: Error[] = [];
  const closes: number[] = [];
  server.onError.subscribe((e) => errors.push(e));
  server.onClose.subscribe(() => closes.push(1));

  // Act: handshake record with garbage body (msg_type client_hello = 1)
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

  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect((server as any).associationTornDown).toBe(false);

  server.close();
  await serverTransport.close().catch(() => {});
}, 10_000);
