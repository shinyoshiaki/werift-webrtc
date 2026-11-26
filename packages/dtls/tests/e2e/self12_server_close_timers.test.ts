import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { certPem, keyPem } from "../fixture";

/**
 * P2: DTLS 1.2 server close() must cancel Flight4 retransmit timers
 * (cancelFlightTimers), not only close the UDP socket.
 */
test("e2e/self12: server.close() cancels Flight4 retransmit timers", async () => {
  // Arrange: 1.2 server + client。Flight4 が client Finished 待ちで sleep するまで進める
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };
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

  // client Finished を落とす: Flight4 が retransmit sleep に留まる
  let dropClientFinished = false;
  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    // Flight5 最終メッセージ（Finished 含む）を黒穴に
    if (dropClientFinished && (client as any).dtls?.flight >= 5) {
      return;
    }
    return origClientSend(buf, addr);
  };

  // Flight4 開始後に drop を有効化
  let serverSends = 0;
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    serverSends += 1;
    // ServerHelloDone 飛行後（flight4 retransmit ループ）で client 最終飛行を落とす
    if (serverSends >= 3) {
      dropClientFinished = true;
    }
    return origServerSend(buf, addr);
  };

  void client.connect();

  // Act: Flight4 の cancelable sleep が積まれるまで待つ
  const serverDtls = (server as any).dtls;
  for (let i = 0; i < 80; i++) {
    if ((serverDtls.flightTimers?.size ?? 0) > 0 || serverDtls.flight === 4) {
      // flight 4 に入り、sleep が登録されるのを待つ
      await new Promise((r) => setTimeout(r, 50));
      if ((serverDtls.flightTimers?.size ?? 0) > 0) break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }

  // 少なくとも Flight4 経路に入っていること
  expect(serverDtls.flight).toBeGreaterThanOrEqual(4);
  // sleep が無い場合でも close 後に 0 であることを検証するため、強制的に sleep を1つ積む
  if ((serverDtls.flightTimers?.size ?? 0) === 0) {
    void serverDtls.flightSleep(5000);
  }
  expect(serverDtls.flightTimers.size).toBeGreaterThan(0);

  let sendsAfterClose = 0;
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    sendsAfterClose += 1;
    return origServerSend(buf, addr);
  };

  // Act: server.close — timer cancel 必須
  server.close();

  // Assert: timers 即 cancel + flight 停止
  expect(serverDtls.flight).toBe(99);
  expect(serverDtls.flightTimers.size).toBe(0);
  expect(serverDtls.flightSleepResolvers.size).toBe(0);

  // RTO 相当待っても追加 retransmit なし
  await new Promise((r) => setTimeout(r, 600));
  expect(sendsAfterClose).toBe(0);

  client.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 15_000);
