import { expect, test } from "vitest";
import { createPlaintext } from "../../src/record/builder";
import { AlertDesc, ContentType } from "../../src/record/const";
import { connectUdpDtlsPair, peerOf } from "../fixture";

/**
 * P2: 1.2 peer close_notify は transport.send が停滞しても onClose / tear down する。
 */
test("e2e/self12: peer close_notify frees association if send hangs", async () => {
  // Arrange: DTLS 1.2 で接続し、client の close_notify 返信送信を永久に停滞させる
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({ rejectOnError: false });

  // close_notify の返信に使う送信（confirm 付きを含む）を停滞させる
  const hang = () =>
    new Promise<void>(() => {
      /* never resolve */
    });
  clientTransport.send = hang;

  const closes: number[] = [];
  client.onClose.subscribe(() => closes.push(Date.now()));

  // Act: server の鍵で暗号化した close_notify を client に受信させる
  const frag = Buffer.from([1, AlertDesc.CloseNotify]);
  const pkt = createPlaintext((server as any).dtls)(
    [{ type: ContentType.alert, fragment: frag }],
    ++(server as any).dtls.recordSequenceNumber,
  )[0];
  const wire = (server as any).cipher.encryptPacket(pkt).serialize();
  const t0 = Date.now();
  (client as any).udpOnMessage(wire, peerOf(serverTransport));

  // Assert: 返信送信が停滞していても期限内に onClose が 1 回発火し、association が解放される
  for (let i = 0; i < 40; i++) {
    if (closes.length > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(closes.length).toBe(1);
  expect(Date.now() - t0).toBeLessThan(800);
  expect((client as any).associationTornDown).toBe(true);
  expect(client.connected).toBe(false);
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
