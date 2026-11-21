import { expect, test } from "vitest";
import { DtlsVersion } from "../../src";
import { connectUdpDtlsPair } from "../fixture";

/**
 * P2: graceful close は transport.send が停滞しても carrier/timer を解放する。
 */
test("e2e/self13: graceful close frees carrier even if send hangs", async () => {
  // Arrange: pure DTLS 1.3 で接続し、server の close_notify 送信を永久に停滞させる
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({
      shared: {
        protocolVersions: [DtlsVersion.V1_3],
        addressValidation: "none",
      },
      rejectOnError: false,
    });
  const eng = (server as any).engine13;
  expect(eng).toBeTruthy();
  const carrier = eng.getHandshakeCarrier();

  // Hang flush path used by close_notify (hot-path send is fire-and-forget)
  const origSend = serverTransport.send.bind(serverTransport);
  const origFlush = serverTransport.sendAndWait.bind(serverTransport);
  const hang = () =>
    new Promise<void>(() => {
      /* never resolve */
    });
  serverTransport.send = hang;
  serverTransport.sendAndWait = hang;

  // Act: server を graceful close し、carrier が閉じるまで待つ
  const t0 = Date.now();
  server.close();
  // Public API terminal is sync; carrier free waits for notify budget if send hangs
  expect((server as any).associationTornDown).toBe(true);
  expect(eng.isClosed()).toBe(true); // closing=true immediately

  // Carrier must close within close_notify budget (~250ms) even if send never settles
  for (let i = 0; i < 40; i++) {
    if (carrier.isClosed()) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(800);

  // Assert: 送信が停滞していても期限内に carrier / retransmit / epoch prune が解放される
  expect(carrier.isClosed()).toBe(true);
  // Pending flight / retransmit should be cleared (no active cancel handle)
  expect((eng as any).cancelRetransmit).toBeUndefined();
  expect((eng as any).cancelEpochPrune).toBeUndefined();

  // Restore send for cleanup
  serverTransport.send = origSend;
  serverTransport.sendAndWait = origFlush;
  try {
    client.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * beginGracefulClose 直後に retransmit timer が即キャンセルされる。
 */
test("e2e/self13: beginGracefulClose cancels retransmit immediately", async () => {
  // Arrange: pure DTLS 1.3 で接続し、client engine に偽の retransmit / prune の cancel handle を仕込む
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({
      shared: {
        protocolVersions: [DtlsVersion.V1_3],
        addressValidation: "none",
      },
      rejectOnError: false,
    });
  const eng = (client as any).engine13;
  // Force a fake pending retransmit cancel handle
  let cancelled = false;
  (eng as any).cancelRetransmit = () => {
    cancelled = true;
  };
  (eng as any).cancelEpochPrune = () => {
    cancelled = true;
  };

  // Act: client engine を close する
  eng.close();
  // Assert: await より前に beginGracefulClose が走り、cancel handle が即座に呼ばれて消える
  expect(cancelled).toBe(true);
  expect((eng as any).cancelRetransmit).toBeUndefined();

  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
