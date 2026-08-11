import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { AlertDesc, ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

/**
 * P2: DTLS 1.2 fatal alert during retransmit sleep must cancel flight timers
 * immediately on onError — not leave pending sleep until the next RTO
 * (carrier/lifecycle: cancel all timers on error).
 */
test("e2e/self12: fatal alert during retransmit sleep cancels timers", async () => {
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
    if (dropClientFinished && (client as any).dtls?.flight >= 5) {
      return;
    }
    return origClientSend(buf, addr);
  };

  let serverSends = 0;
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    serverSends += 1;
    if (serverSends >= 3) {
      dropClientFinished = true;
    }
    return origServerSend(buf, addr);
  };

  void client.connect();

  // Flight4 の cancelable sleep が積まれるまで待つ
  const serverDtls = (server as any).dtls;
  for (let i = 0; i < 80; i++) {
    if ((serverDtls.flightTimers?.size ?? 0) > 0 || serverDtls.flight === 4) {
      await new Promise((r) => setTimeout(r, 50));
      if ((serverDtls.flightTimers?.size ?? 0) > 0) break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }

  // 本物の Flight4 retransmit sleep があること（人工 flightSleep は使わない）
  expect(serverDtls.flight).toBeGreaterThanOrEqual(4);
  expect(serverDtls.flightTimers.size).toBeGreaterThan(0);

  let sendsAfterError = 0;
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    sendsAfterError += 1;
    return origServerSend(buf, addr);
  };

  const errors: Error[] = [];
  server.onError.subscribe((e) => errors.push(e));

  // Act: retransmit sleep 中に epoch-0 fatal handshake_failure を注入
  const alertBody = Buffer.from([2, AlertDesc.HandshakeFailure]);
  const alertPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    alertBody,
  );
  const serverPeer = clientTransport.rinfo
    ? ([clientTransport.rinfo.address, clientTransport.rinfo.port] as [
        string,
        number,
      ])
    : undefined;
  // server の inbound に直接 inject（peer からの fatal alert 相当）
  (server as any).udpOnMessage(
    alertPkt,
    serverPeer ??
      ([
        clientTransport.address[0],
        clientTransport.address[1],
      ] as [string, number]),
  );

  // Assert: onError 直後に timer/resolver が 0、flight 停止
  expect(errors.length).toBe(1);
  expect(errors[0].message).toMatch(/alert|handshake|fatal/i);
  expect(serverDtls.fatalError).toBeTruthy();
  expect(serverDtls.flight).toBe(99);
  expect(serverDtls.flightTimers.size).toBe(0);
  expect(serverDtls.flightSleepResolvers.size).toBe(0);

  // RTO 相当待っても追加 retransmit なし
  await new Promise((r) => setTimeout(r, 600));
  expect(sendsAfterError).toBe(0);
  expect(serverDtls.flightTimers.size).toBe(0);

  client.close();
  try {
    server.close();
  } catch {
    /* may already be aborted */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 15_000);
