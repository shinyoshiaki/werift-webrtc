import { expect, test } from "vitest";
import { DtlsVersion } from "../../src";
import { connectUdpDtlsPair } from "../fixture";

/**
 * P1: pure 1.3 server local close() 直後の send は同期的に terminal で破棄される
 * （close_notify 完了を待たない）。
 */
test("e2e/self13: server close() drops send synchronously", async () => {
  // Arrange: pure DTLS 1.3 で接続する
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({
      shared: { protocolVersions: [DtlsVersion.V1_3] },
    });
  expect(server.isDtls13).toBe(true);
  expect(server.connected).toBe(true);

  // Act: server を close する（onClose は待たない）
  server.close();

  // Assert: 同期的に terminal になり、直後の send は破棄され exporter は closed で失敗する
  expect((server as any).associationTornDown).toBe(true);
  expect(server.connected).toBe(false);
  // send は接続終了後は reject せず破棄する
  await expect(
    server.send(Buffer.from("after-close")),
  ).resolves.toBeUndefined();
  expect(() => server.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 16)).toThrow(
    /closed/i,
  );

  try {
    client.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: pure 1.3 peer close_notify 開始直後も send は破棄される（teardown 完了前）。
 * client.close() が wire 上の close_notify を送り、server onClosing が同期 terminal。
 */
test("e2e/self13: peer close_notify drops send before teardown completes", async () => {
  // Arrange: pure DTLS 1.3 で接続し、server の onClose を記録する
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({
      shared: { protocolVersions: [DtlsVersion.V1_3] },
    });

  const closes: number[] = [];
  server.onClose.subscribe(() => closes.push(Date.now()));

  // Act: client を close し、UDP で close_notify を server に届ける
  client.close();

  // Wait until server observes peer close_notify (onClosing → associationTornDown)
  for (let i = 0; i < 100; i++) {
    if ((server as any).associationTornDown) break;
    await new Promise((r) => setTimeout(r, 10));
  }

  // Assert: close_notify を受けた server は terminal になり、send は破棄される
  expect((server as any).associationTornDown).toBe(true);
  // send は接続終了後は reject せず破棄する
  await expect(server.send(Buffer.from("late"))).resolves.toBeUndefined();

  // Assert: その後 onClose も発火する
  await new Promise<void>((resolve) => {
    if (closes.length > 0) {
      resolve();
      return;
    }
    const t = setTimeout(() => resolve(), 2000);
    server.onClose.subscribe(() => {
      clearTimeout(t);
      resolve();
    });
  });
  expect(closes.length).toBeGreaterThanOrEqual(1);

  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * pure 1.3 client close も同様に同期 terminal（dual closeAssociationHard 経路）。
 */
test("e2e/self13: client close() drops send synchronously", async () => {
  // Arrange: pure DTLS 1.3 で接続する
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({
      shared: { protocolVersions: [DtlsVersion.V1_3] },
    });

  // Act: client を close する
  client.close();
  // Assert: 同期的に terminal (phase closed) になり、直後の send は破棄される
  expect((client as any).associationTornDown).toBe(true);
  expect((client as any).dualAssociationPhase).toBe("closed");
  // send は接続終了後は reject せず破棄する
  await expect(client.send(Buffer.from("x"))).resolves.toBeUndefined();

  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
