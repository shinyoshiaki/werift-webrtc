import { createSocket } from "dgram";
import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { createPlaintext } from "../../src/record/builder";
import { AlertDesc, ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import {
  certPem,
  connectUdpDtlsPair,
  dtls12AddressPin,
  keyPem,
  peerOf,
  rsaSignatureHash,
} from "../fixture";

/**
 * P1: 接続後 epoch-0 平文 fatal は unauthenticated — association を落とさない。
 */
test("e2e/self12: epoch-0 fatal alert after connect does not tear down", async () => {
  // Arrange: address pin 付きの DTLS 1.2 で接続し、client の onError / onClose を記録する
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({ shared: dtls12AddressPin });
  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(1));

  // Act: 正規 peer のアドレスから平文 (epoch 0) の fatal alert を client に受信させる
  const alertPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([2, AlertDesc.HandshakeFailure]),
  );
  (client as any).udpOnMessage(alertPkt, peerOf(serverTransport));
  await new Promise((r) => setTimeout(r, 30));

  // Assert: 未認証の alert なので無視され、接続を保ったまま送信できる
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(client.connected).toBe(true);
  expect((client as any).associationTornDown).toBe(false);
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
 * P1: spoofed UDP peer の epoch-0 fatal は pin で drop — terminal にしない。
 */
test("e2e/self12: spoofed UDP peer epoch-0 fatal does not tear down server", async () => {
  // Arrange: address pin 付きの DTLS 1.2 で接続し、spoof 用の UDP socket を用意する
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({ shared: dtls12AddressPin });
  expect((server as any).transport.pinnedPeer).toBeTruthy();

  const errors: Error[] = [];
  const closes: number[] = [];
  server.onError.subscribe((e) => errors.push(e));
  server.onClose.subscribe(() => closes.push(1));

  const spoof = createSocket("udp4");
  await new Promise<void>((r) => spoof.bind(0, "127.0.0.1", () => r()));
  const spoofPeer: [string, number] = ["127.0.0.1", spoof.address().port];

  // Act: spoof peer から来たものとして fatal alert を server に注入する（実 UDP を通さず RX gate を試す）
  const alertPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([2, AlertDesc.InternalError]),
  );
  (server as any).udpOnMessage(alertPkt, spoofPeer);
  await new Promise((r) => setTimeout(r, 30));

  // Assert: pin で drop され、server は接続を保ち pin も維持される
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(server.connected).toBe(true);
  expect((server as any).associationTornDown).toBe(false);
  // pin は維持、rinfo は pin へ restore 済み
  expect((server as any).matchesPinnedPeer(peerOf(clientTransport))).toBe(true);

  await server.send(Buffer.from("to-client"));
  client.close();
  server.close();
  spoof.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: spoof peer からの app data / garbage は onData に出ない。
 */
test("e2e/self12: spoofed peer cannot deliver application data to server", async () => {
  // Arrange: address pin 付きの DTLS 1.2 で接続し、server の onData を記録する
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({ shared: dtls12AddressPin });

  const data: Buffer[] = [];
  server.onData.subscribe((d) => data.push(d));

  const spoofPeer: [string, number] = ["127.0.0.1", 39999];
  // Act: spoof peer から epoch-0 の偽アプリデータ（未認証）を注入し、正規 client からも送信する
  const app = serializePlaintextRecord(
    ContentType.applicationData,
    0,
    1,
    Buffer.from("ghost-from-spoof"),
  );
  (server as any).udpOnMessage(app, spoofPeer);
  await client.send(Buffer.from("from-real-client"));
  await new Promise((r) => setTimeout(r, 80));

  // Assert: onData には正規 client のデータだけが届く
  expect(data.map((b) => b.toString("utf8"))).toEqual(["from-real-client"]);
  expect(server.connected).toBe(true);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: dual committed12 でも carrier.inject の spoof peer は drop。
 */
test("e2e/self12: dual committed12 carrier.inject spoof peer is dropped", async () => {
  // Arrange: dual client × 1.2-only server を address pin 付きで接続し、committed12 にする
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    peerIdentityMode: "datagram-address",
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: rsaSignatureHash,
    // 1.2-only server so dual client commits to 1.2
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    peerIdentityMode: "datagram-address",
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: rsaSignatureHash,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15_000);
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
    void client.connect();
  });

  expect((client as any).dualAssociationPhase).toBe("committed12");

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(1));

  const spoofAlert = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    Buffer.from([2, AlertDesc.HandshakeFailure]),
  );
  // Act: association 外の peer から carrier.inject で fatal alert を注入する
  const carrier = (client as any).associationCarrier;
  if (carrier?.inject) {
    carrier.inject(spoofAlert, ["127.0.0.1", 45000]);
  } else {
    // associationInject path
    (client as any).associationInject?.(spoofAlert, ["127.0.0.1", 45000]);
  }
  await new Promise((r) => setTimeout(r, 40));

  // Assert: spoof peer の alert は drop され、client は接続を保つ
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(client.connected).toBe(true);
  expect((client as any).associationTornDown).toBe(false);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: terminal 後 renegotiation() は association を復活させない。
 */
test("e2e/self12: renegotiation rejected after terminal close", async () => {
  // Arrange: address pin 付きの DTLS 1.2 で接続し、client を close して terminal にする
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({ shared: dtls12AddressPin });

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.close();
  await new Promise((r) => setTimeout(r, 30));
  expect((client as any).associationTornDown).toBe(true);

  // Act: terminal 後に renegotiation() を呼ぶ
  client.renegotiation();
  // Assert: エラーで拒否され、association は復活しない
  expect(errors.some((e) => /closed|renegotiation/i.test(e.message))).toBe(
    true,
  );
  expect((client as any).associationTornDown).toBe(true);
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

/**
 * 回帰: 認証済み encrypted fatal は今まで通り terminal。
 */
test("e2e/self12: AEAD-protected fatal from pin still tears down", async () => {
  // Arrange: address pin 付きの DTLS 1.2 で接続し、client の onError / onClose を記録する
  const { client, server, clientTransport, serverTransport } =
    await connectUdpDtlsPair({ shared: dtls12AddressPin });

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(1));

  // Act: pin 済み peer から server の鍵で暗号化した fatal alert を client に受信させる
  const alertFrag = Buffer.from([2, AlertDesc.DecryptError]);
  const pkt = createPlaintext((server as any).dtls)(
    [{ type: ContentType.alert, fragment: alertFrag }],
    ++(server as any).dtls.recordSequenceNumber,
  )[0];
  const wire = (server as any).cipher.encryptPacket(pkt).serialize();
  (client as any).udpOnMessage(wire, peerOf(serverTransport));
  await new Promise((r) => setTimeout(r, 30));

  // Assert: 認証済み fatal なので association は terminal になる
  expect(errors.length).toBe(1);
  // fatal は onError のみで onClose は発火しない
  expect(closes.length).toBe(0);
  expect((client as any).associationTornDown).toBe(true);

  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
