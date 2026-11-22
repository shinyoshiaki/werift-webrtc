import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * P1: server が Finished 処理中に close/fatal されたら onConnect / connected=true
 * に復帰しない（waitForReady / Flight6.exec 後の race）。
 */
test("e2e/self12: server close during Finished path does not reconnect", async () => {
  // Arrange: DTLS 1.2 の UDP ペアを作り、server の 2 回目の waitForReady 中に association を terminal にするフックを仕込む
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

  const connects: number[] = [];
  server.onConnect.subscribe(() => connects.push(Date.now()));

  // Intercept waitForReady to close association while Finished is in flight
  const originalWait = (server as any).waitForReady.bind(server);
  let intercept = 0;
  (server as any).waitForReady = async (cond: () => boolean) => {
    intercept++;
    if (intercept === 1) {
      // First wait (flight6 present) — let it proceed normally
      return originalWait(cond);
    }
    // Second wait (required handshakes): tear down mid-await
    const pending = originalWait(cond);
    // Mark terminal before wait settles so post-await guards fire
    (server as any).associationTornDown = true;
    (server as any).connected = false;
    (server as any).abortAssociationWaits();
    (server as any).abortLegacy12Flight();
    try {
      await pending;
    } catch {
      /* expected association closed */
    }
    // Simulate what close would leave; ensure Finished cannot set connected
    return;
  };

  // Act: ハンドシェイクを開始し、server が Finished 処理に入るまで待つ
  void client.connect();

  for (let i = 0; i < 100; i++) {
    if (intercept >= 2 || connects.length > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  // Assert: Finished 処理中に terminal になった server は接続済みに戻らず、onConnect も発火しない
  expect((server as any).associationTornDown).toBe(true);
  expect(server.connected).toBe(false);
  // onConnect must not fire after we forced terminal (may have fired before — 0 expected)
  expect(connects.length).toBe(0);
  // send は接続終了後は reject せず破棄する
  await expect(server.send(Buffer.from("x"))).resolves.toBeUndefined();

  try {
    client.close();
  } catch {
    /* */
  }
  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: fatal during waitForReady 後も connected に戻らない。
 */
test("e2e/self12: server fatal mid-handshake blocks later onConnect", async () => {
  // Arrange: DTLS 1.2 の UDP ペアを作り、server の 2 回目の waitForReady で association fatal を起こすフックを仕込む
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

  const connects: number[] = [];
  server.onConnect.subscribe(() => connects.push(1));

  const originalWait = (server as any).waitForReady.bind(server);
  let n = 0;
  (server as any).waitForReady = async (cond: () => boolean) => {
    n++;
    if (n >= 2) {
      // Association-fatal before second wait completes
      (server as any).reportLegacy12Fatal(new Error("inject fatal mid-hs"));
      throw new Error("association closed during waitForReady");
    }
    return originalWait(cond);
  };

  // Act: ハンドシェイクを開始し、fatal が起きるまで待つ
  void client.connect();
  await new Promise((r) => setTimeout(r, 800));

  // Assert: fatal 後の server は terminal のままで、onConnect も発火しない
  expect((server as any).associationTornDown).toBe(true);
  expect(server.connected).toBe(false);
  expect(connects.length).toBe(0);

  try {
    client.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 15_000);
