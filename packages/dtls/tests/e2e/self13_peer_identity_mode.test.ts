import { expect, test } from "vitest";
import type { Address } from "../../../common/src";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { AlertDesc, ContentType } from "../../src/record/const";
import { encryptRecord } from "../../src/record/v1_3/record";
import {
  certPem,
  connectPeerAuthPair,
  keyPem,
  rsaSignatureHash,
} from "../fixture";

/** Peer-auth DTLS 1.3 Options for the ICE-like {@link connectPeerAuthPair} pair. */
const peerAuth13Opts = {
  signatureHash: rsaSignatureHash,
  protocolVersions: [DtlsVersion.V1_3] as const,
  peerIdentityMode: "authenticated-single-peer" as const,
  addressValidation: "ice-authenticated" as const,
};

async function encryptAlertFrom(
  side: DtlsClient | DtlsServer,
  body: Buffer,
): Promise<Buffer> {
  const eng = (side as any).engine13;
  expect(eng).toBeTruthy();
  // Use engine send path for alerts when available; fall back to internal AEAD.
  const writeEpoch = eng.writeEpoch ?? 3;
  const ep = eng.epochs?.get?.(writeEpoch);
  expect(ep?.writeKeys).toBeTruthy();
  return encryptRecord(body, ContentType.alert, ep);
}

test("e2e/self13 peerIdentityMode: authenticated-single-peer delivers addressless app data + fatal + close_notify", async () => {
  // Arrange: アドレスなしの peer 認証済み transport で pure DTLS 1.3 を接続する
  const { client, server, t1, t2 } = await connectPeerAuthPair(peerAuth13Opts);
  expect(client.peerIdentityMode).toBe("authenticated-single-peer");
  expect(client.isDtls13).toBe(true);

  // Act: アドレスなしで client からアプリデータを送る
  // Assert: server の onData に同じデータが届く
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("app data timeout")), 5_000);
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("auth-peer-app");
        clearTimeout(t);
        resolve();
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    void client.send(Buffer.from("auth-peer-app"));
  });

  // Act: server の鍵で暗号化した fatal alert をアドレスなしで client に受信させる
  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  const fatalWire = await encryptAlertFrom(
    server,
    Buffer.from([2, AlertDesc.InternalError]),
  );
  t2.onData(fatalWire, undefined as any);
  await new Promise((r) => setTimeout(r, 40));
  // Assert: client は onError を出して terminal になる
  expect(errors.length).toBeGreaterThan(0);
  expect((client as any).associationTornDown).toBe(true);

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
  await t1.close().catch(() => {});
  await t2.close().catch(() => {});
}, 25_000);

test("e2e/self13 peerIdentityMode: authenticated-single-peer accepts protected RX from alternate fake addr", async () => {
  // Arrange: アドレスなしで接続した後、以降の受信に偽の送信元アドレスを付ける
  const { client, server, t1, t2 } = await connectPeerAuthPair(peerAuth13Opts);

  // Spoof different 5-tuple on deliver — must NOT drop under authenticated-single-peer
  t2.fakeRxAddr = ["203.0.113.50", 44444] as Address;

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(1));

  // Act: 違う送信元アドレスで、暗号化された close_notify を client に受信させる
  const closeWire = await encryptAlertFrom(
    server,
    Buffer.from([1, AlertDesc.CloseNotify]),
  );
  t2.onData(closeWire, t2.fakeRxAddr as any);
  await new Promise((r) => setTimeout(r, 50));

  // Assert: 別 peer として drop されず close_notify が処理され、onError は出ない
  expect(closes.length).toBeGreaterThanOrEqual(1);
  // close_notify is graceful — may not set onError
  expect(errors.length).toBe(0);

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
  await t1.close().catch(() => {});
  await t2.close().catch(() => {});
}, 25_000);

test("e2e/self13 peerIdentityMode: datagram-address rejects non-pin peer after connect", async () => {
  // Arrange: datagram-address (UDP アドレス pin) の pure DTLS 1.3 で接続し、pin が設定されたことを確かめる
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const base = {
    cert: certPem,
    key: keyPem,
    signatureHash: rsaSignatureHash,
    protocolVersions: [DtlsVersion.V1_3] as const,
    peerIdentityMode: "datagram-address" as const,
    addressValidation: "none" as const,
  };
  const server = new DtlsServer({ transport: serverTransport, ...base });
  const client = new DtlsClient({ transport: clientTransport, ...base });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 15_000);
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

  expect(client.peerIdentityMode).toBe("datagram-address");
  const eng = (client as any).engine13;
  expect(eng).toBeTruthy();
  // Pin should be set to server address after connect
  expect(eng.expectedPeerKey?.() || eng.pinnedPeerKey).toBeTruthy();

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  const closesBefore = { n: 0 };
  client.onClose.subscribe(() => {
    closesBefore.n += 1;
  });

  // Act: 暗号化された fatal alert を、別の UDP peer から来たものとして engine に注入する
  const fatalWire = await encryptAlertFrom(
    server,
    Buffer.from([2, AlertDesc.InternalError]),
  );
  const spoof: [string, number] = ["198.51.100.99", 9];
  // Direct inject into engine with wrong peer key (bypass UDP stack rinfo)
  eng.injectDatagram(fatalWire, spoof);
  await new Promise((r) => setTimeout(r, 40));

  // Assert: pin と違う peer なので drop され、client は接続を保つ
  expect(errors.length).toBe(0);
  expect(closesBefore.n).toBe(0);
  expect((client as any).associationTornDown).toBe(false);
  expect(client.connected).toBe(true);

  // Act: 対照として、同じ alert を正しい peer から注入する
  eng.injectDatagram(fatalWire, [
    serverTransport.address.address === "0.0.0.0"
      ? "127.0.0.1"
      : serverTransport.address.address,
    serverTransport.address.port,
  ]);
  await new Promise((r) => setTimeout(r, 40));
  // Assert: 正しい peer からの fatal は onError になる
  expect(errors.length).toBeGreaterThan(0);

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
}, 25_000);
