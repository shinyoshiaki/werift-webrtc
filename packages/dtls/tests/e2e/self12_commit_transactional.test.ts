import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import {
  build12ClientHello,
  certPem,
  chAsAssembled,
  fixedClientRandom,
  keyPem,
  rsaSignatureHash,
} from "../fixture";

/**
 * P1: failed commit after cookie-valid CH2 must not leave EMS/srtp/curve
 * partial state for the next peer (transactional commit).
 */
test("e2e/self12: failed CH2 commit does not poison association state", async () => {
  // Arrange: EMS 必須の RSA server に、peer A の CH1 を通して HVR cookie を発行させる
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    // DTLS 1.2 の association アドレス pin は opt-in
    peerIdentityMode: "datagram-address",
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: rsaSignatureHash,
    extendedMasterSecret: true,
  });
  serverTransport.send = async () => {};

  const peerA: [string, number] = ["198.51.100.1", 41001];
  const rndA = fixedClientRandom();

  // A CH1 → HVR
  await (server as any).handleHandshakes(
    chAsAssembled(
      build12ClientHello({ random: rndA, ems: true, ecdsaOnly: true }),
    ),
    peerA,
  );
  const cookieA = Buffer.from((server as any).dtls.cookie as Buffer);
  expect((server as any).dtls.remoteExtendedMasterSecret).toBe(false);

  // Act: cookie は正しく EMS もあるが、cipher suite 交渉に失敗する (ECDSA vs RSA) CH2 を A から渡す
  await (server as any).handleHandshakes(
    chAsAssembled(
      build12ClientHello({
        cookie: cookieA,
        random: rndA,
        ems: true,
        ecdsaOnly: true,
      }),
    ),
    peerA,
  );

  // Assert: EMS / random / 鍵 / cipher / SRTP / pin のどれも途中まで書き換わっていない
  expect((server as any).dtls.remoteExtendedMasterSecret).toBe(false);
  expect((server as any).dtls.clientHelloCommitted).toBe(false);
  expect((server as any).cipher.remoteRandom).toBeUndefined();
  expect((server as any).cipher.localKeyPair).toBeUndefined();
  expect((server as any).cipher.cipherSuite).toBeUndefined();
  expect((server as any).srtp.srtpProfile).toBeUndefined();
  expect((server as any).transport.pinnedPeer).toBeUndefined();

  server.close();
  await serverTransport.close().catch(() => {});
});

/**
 * After a failed commit poison attempt, a real peer still completes (same process).
 */
test("e2e/self12: after failed commit, clean client handshake succeeds", async () => {
  // Arrange: EMS 必須の RSA server に、偽 peer X から commit に失敗する CH1 / CH2 を先に渡す
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    peerIdentityMode: "datagram-address",
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: rsaSignatureHash,
    extendedMasterSecret: true,
  });

  // Poison attempt via direct handleHandshakes (no UDP)
  const peerX: [string, number] = ["203.0.113.9", 9];
  const rndX = fixedClientRandom();
  const blackhole = serverTransport.send.bind(serverTransport);
  serverTransport.send = async () => {};
  await (server as any).handleHandshakes(
    chAsAssembled(
      build12ClientHello({ random: rndX, ems: true, ecdsaOnly: true }),
    ),
    peerX,
  );
  const cX = Buffer.from((server as any).dtls.cookie as Buffer);
  await (server as any).handleHandshakes(
    chAsAssembled(
      build12ClientHello({
        cookie: cX,
        random: rndX,
        ems: true,
        ecdsaOnly: true,
      }),
    ),
    peerX,
  );
  expect((server as any).dtls.remoteExtendedMasterSecret).toBe(false);
  serverTransport.send = blackhole;

  const client = new DtlsClient({
    peerIdentityMode: "datagram-address",
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: rsaSignatureHash,
    extendedMasterSecret: true,
  });

  // Act: 正規 client が同じ server とハンドシェイクする
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("handshake timeout")), 15_000);
    client.onConnect.subscribe(() => {
      clearTimeout(t);
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    void client.connect();
  });

  // Assert: 失敗した commit の影響を受けず、両側が接続済みになる
  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
