import { createSocket } from "dgram";
import { expect, test } from "vitest";
import { connectUdpDtlsPair, dtls12AddressPin } from "../fixture";

/**
 * P1: pure DTLS 1.2 server の application TX は association pin を使い、
 * spoof が UdpTransport.rinfo を上書きしても攻撃者へ送信されないこと。
 * （client 側 pin は既存。server だけ pin 欠落だった）
 */
test("e2e/self12: server app send stays on real peer after spoof RX", async () => {
  // Arrange: pure 1.2 接続完了
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({ shared: dtls12AddressPin });
  expect(server.connected).toBe(true);
  expect((server as any).transport.pinnedPeer).toBeTruthy();

  const spoof = createSocket("udp4");
  await new Promise<void>((r) => spoof.bind(0, "127.0.0.1", () => r()));
  let spoofGot = 0;
  spoof.on("message", () => {
    spoofGot++;
  });

  let clientGot = 0;
  const payloads: string[] = [];
  client.onData.subscribe((d) => {
    clientGot++;
    payloads.push(d.toString("utf8"));
  });

  // Act: spoof datagram — UdpTransport updates rinfo then association RX
  // drops non-pin and restores rinfo to pin (RX ownership).
  const serverPort = (serverTransport.address as { port: number }).port;
  const pinBefore = [...(server as any).transport.pinnedPeer] as [
    string,
    number,
  ];
  await new Promise<void>((resolve, reject) => {
    spoof.send(Buffer.from("spoof-noise"), serverPort, "127.0.0.1", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  await new Promise((r) => setTimeout(r, 40));

  // pin 不変; spoof 後 rinfo は pin へ restore（last-rinfo に攻撃者を残さない）
  const pin = (server as any).transport.pinnedPeer as [string, number];
  expect(pin[0]).toBe(pinBefore[0]);
  expect(pin[1]).toBe(pinBefore[1]);
  expect(pin[1]).not.toBe(spoof.address().port);
  expect((serverTransport as any).rinfo?.port).toBe(pin[1]);

  await server.send(Buffer.from("only-to-client"));
  await new Promise((r) => setTimeout(r, 80));

  // Assert: 本物の client のみ受信、spoof は 0
  expect(clientGot).toBe(1);
  expect(payloads).toEqual(["only-to-client"]);
  expect(spoofGot).toBe(0);

  client.close();
  server.close();
  spoof.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: pure 1.2 server pin は cookie 検証後に立ち、Finished 直前の spoof で
 * pin が上書きされないこと（set-if-empty）。
 */
test("e2e/self12: server pin is set-if-empty (spoof cannot replace)", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({ shared: dtls12AddressPin });

  const pinBefore = [...(server as any).transport.pinnedPeer] as [
    string,
    number,
  ];

  // Act: spoof + send path that might re-pin from rinfo
  const spoof = createSocket("udp4");
  await new Promise<void>((r) => spoof.bind(0, "127.0.0.1", () => r()));
  const serverPort = (serverTransport.address as { port: number }).port;
  await new Promise<void>((resolve, reject) => {
    spoof.send(Buffer.from("x"), serverPort, "127.0.0.1", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  await new Promise((r) => setTimeout(r, 30));

  // 明示的に set-if-empty を再実行しても pin は不変
  (server as any).pinSendPeerFromTransportRinfo("set-if-empty");
  const pinAfter = (server as any).transport.pinnedPeer as [string, number];
  expect(pinAfter[0]).toBe(pinBefore[0]);
  expect(pinAfter[1]).toBe(pinBefore[1]);

  client.close();
  server.close();
  spoof.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
