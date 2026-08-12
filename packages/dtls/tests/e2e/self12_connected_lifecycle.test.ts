import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { AlertDesc, ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

async function connectPair() {
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
 * P1: pure DTLS 1.2 接続完了後の **認証済み (epoch>0 AEAD)** fatal → association terminal。
 * epoch-0 平文 fatal は unauth として無視する（別テスト）。
 */
test("e2e/self12: connected authenticated fatal alert tears down pure association", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair();
  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);

  const errors: Error[] = [];
  const closes: number[] = [];
  const data: Buffer[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(Date.now()));
  client.onData.subscribe((d) => data.push(d));

  // Act: peer fatal encrypted with server write keys (epoch = server.dtls.epoch)
  const { createPlaintext } = await import("../../src/record/builder");
  const alertFrag = Buffer.from([2, AlertDesc.HandshakeFailure]);
  const pkt = createPlaintext((server as any).dtls)(
    [{ type: ContentType.alert, fragment: alertFrag }],
    ++(server as any).dtls.recordSequenceNumber,
  )[0];
  const alertPkt = (server as any).cipher.encryptPacket(pkt).serialize();
  (client as any).udpOnMessage(alertPkt, peerOf(serverTransport));

  // Assert: terminal
  expect(errors.length).toBe(1);
  expect(closes.length).toBe(1);
  expect(client.connected).toBe(false);
  expect((client as any).associationTornDown).toBe(true);
  expect((client as any).dtls.flightTimers.size).toBe(0);
  await expect(client.send(Buffer.from("x"))).rejects.toThrow(/closed/i);
  expect(() => client.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 16)).toThrow(
    /closed/i,
  );
  expect(() => client.remoteCertificate).toThrow(/closed/i);

  // late packet must not revive or deliver app data
  const app = serializePlaintextRecord(
    ContentType.applicationData,
    0,
    1,
    Buffer.from("ghost"),
  );
  (client as any).udpOnMessage(app, peerOf(serverTransport));
  await new Promise((r) => setTimeout(r, 30));
  expect(data.length).toBe(0);
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

/**
 * P2: pure 1.2 peer close_notify（AEAD 保護）→ graceful close, API 不可, late drop。
 */
test("e2e/self12: connected close_notify graceful association close", async () => {
  const { client, server, clientTransport, serverTransport } =
    await connectPair();

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(Date.now()));

  // Authenticated close_notify (epoch>0) — epoch-0 plaintext is ignored post-HS.
  const { createPlaintext } = await import("../../src/record/builder");
  const closeFrag = Buffer.from([1, AlertDesc.CloseNotify]);
  const closePktPlain = createPlaintext((server as any).dtls)(
    [{ type: ContentType.alert, fragment: closeFrag }],
    ++(server as any).dtls.recordSequenceNumber,
  )[0];
  const closePkt = (server as any).cipher
    .encryptPacket(closePktPlain)
    .serialize();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("onClose timeout")), 5_000);
    client.onClose.subscribe(() => {
      clearTimeout(timer);
      resolve();
    });
    (client as any).udpOnMessage(closePkt, peerOf(serverTransport));
  });

  expect(errors.length).toBe(0);
  expect(closes.length).toBe(1);
  expect(client.connected).toBe(false);
  expect((client as any).associationTornDown).toBe(true);
  expect((client as any).dtls.flightTimers.size).toBe(0);
  await expect(client.send(Buffer.from("x"))).rejects.toThrow(/closed/i);

  // late inject で復活しない
  (client as any).udpOnMessage(closePkt, peerOf(serverTransport));
  await new Promise((r) => setTimeout(r, 30));
  expect(closes.length).toBe(1);
  expect(errors.length).toBe(0);

  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P2: warning (user_canceled) は pure 1.2 でも connection を閉じない。
 */
test("e2e/self12: non-close_notify warning does not tear down", async () => {
  const { client, server, clientTransport, serverTransport } =
    await connectPair();

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(Date.now()));

  const warnPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([1, AlertDesc.UserCanceled]),
  );
  (client as any).udpOnMessage(warnPkt, peerOf(serverTransport));
  await new Promise((r) => setTimeout(r, 30));

  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(client.connected).toBe(true);
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
 * P2: pure 1.2 server local close() も client と同様に onClose をちょうど 1 回。
 * （以前は DtlsSocket.close が onClose なしで server だけ不整合だった）
 */
test("e2e/self12: server.close() fires onClose exactly once", async () => {
  // Arrange: pure 1.2 接続完了
  const { client, server, clientTransport, serverTransport } =
    await connectPair();
  expect(server.connected).toBe(true);

  const closes: number[] = [];
  server.onClose.subscribe(() => closes.push(Date.now()));

  // Act: local close
  server.close();

  // Assert: terminal + onClose 1 回
  expect(server.connected).toBe(false);
  expect((server as any).associationTornDown).toBe(true);
  expect(closes.length).toBe(1);

  // Act: second close は no-op
  server.close();
  expect(closes.length).toBe(1);

  await expect(server.send(Buffer.from("x"))).rejects.toThrow(/closed/i);

  try {
    client.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P2: waitForReady の association sleep は close で即 AbortSignal cancel。
 * 旧実装（sleep 完了後に tornDown を見て reject）では 400ms sleep の残りを
 * 待ってしまうため、elapsed < 100ms は AbortSignal 修正の回帰になる。
 */
test("e2e/self12: waitForReady sleep aborts immediately on close", async () => {
  // Arrange: socket だけ用意（HS 完了不要）
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  // never-true → i=0 sleep0, i=1 sleep100, … i=4 sleep400
  let conditionCalls = 0;
  const pending = (server as any).waitForReady(() => {
    conditionCalls += 1;
    return false;
  }) as Promise<void>;

  // 確実に 400ms sleep (i=4) に入ってから close する
  // conditionCalls=5 の直後が await setTimeout(400, { signal })
  for (let i = 0; i < 200 && conditionCalls < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(conditionCalls).toBeGreaterThanOrEqual(5);
  expect((server as any).associationAbort.signal.aborted).toBe(false);

  // Act: close は pending 400ms sleep を AbortSignal で即 cancel
  const t0 = Date.now();
  server.close();

  await expect(pending).rejects.toThrow(/association closed|waitForReady/i);
  const elapsed = Date.now() - t0;
  // 旧実装なら残り ~400ms 待ち → 100ms 未満は AbortSignal cancel の証拠
  expect(elapsed).toBeLessThan(100);
  expect((server as any).associationAbort.signal.aborted).toBe(true);
  expect((server as any).associationTornDown).toBe(true);

  await serverTransport.close().catch(() => {});
}, 15_000);

/**
 * P1: fatal と local close の race — event 二重なし、terminal 維持。
 */
test("e2e/self12: fatal vs local close race is terminal once", async () => {
  const { client, server, clientTransport, serverTransport } =
    await connectPair();

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(Date.now()));

  const alertPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([2, AlertDesc.InternalError]),
  );

  // Act: fatal と local close を連続
  (client as any).udpOnMessage(alertPkt, peerOf(serverTransport));
  client.close();

  await new Promise((r) => setTimeout(r, 50));

  // Assert: onError ≤1, onClose ≤1（fatal path fires both; close is no-op after)
  expect(errors.length).toBeLessThanOrEqual(1);
  expect(closes.length).toBeLessThanOrEqual(1);
  expect(errors.length + closes.length).toBeGreaterThanOrEqual(1);
  expect(client.connected).toBe(false);
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
