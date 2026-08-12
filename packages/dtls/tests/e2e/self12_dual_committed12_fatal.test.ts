import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { DirectHandshakeCarrier } from "../../src/carrier/direct";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { createDtlsClientInternal } from "../../src/internal";
import { AlertDesc, ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

/**
 * P1: dual → committed12 → connected の後に peer fatal alert を受けると、
 * association 全体が tear down され Public API が使えないこと。
 * （abortLegacy12Flight だけでは dualPhase/connected が残るバグの回帰）
 */
test("e2e/dual: committed12 fatal alert tears down association", async () => {
  // Arrange: dual client × 1.2-only server → committed12 完走
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };

  const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
    mtu: 1200,
  });
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    handshakeCarrier: clientCarrier,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("committed12 setup timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      resolve();
    });
    void client.connect();
  });

  expect(client.connected).toBe(true);
  expect(client.isDtls13).toBe(false);
  expect(client.dualAssociationPhase).toBe("committed12");
  expect(clientCarrier.isClosed()).toBe(false);

  // Act: peer fatal handshake_failure（1.2 record path）
  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(Date.now()));

  const alertBody = Buffer.from([2, AlertDesc.HandshakeFailure]);
  const alertPkt = serializePlaintextRecord(ContentType.alert, 0, 0, alertBody);
  (client as any).udpOnMessage(alertPkt, [
    (serverTransport.address as any).address === "0.0.0.0"
      ? "127.0.0.1"
      : (serverTransport.address as any).address,
    (serverTransport.address as any).port,
  ]);

  // Assert: onError 直後に association は閉じている
  expect(errors.length).toBe(1);
  expect(errors[0].message).toMatch(/alert|handshake|fatal/i);
  expect(client.connected).toBe(false);
  expect(client.dualAssociationPhase).toBe("closed");
  expect((client as any).associationTornDown).toBe(true);
  expect((client as any).dtls.flight).toBe(99);
  expect((client as any).dtls.flightTimers.size).toBe(0);
  expect(clientCarrier.isClosed()).toBe(true);
  expect(closes.length).toBe(1);

  // Public API 無効（committed12 のまま send できる状態に戻らない）
  await expect(client.send(Buffer.from("after-fatal"))).rejects.toThrow(
    /closed/i,
  );
  await expect(client.connect()).rejects.toThrow(/closed/i);
  expect(() => client.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 16)).toThrow(
    /closed/i,
  );
  expect(() => client.remoteCertificate).toThrow(/closed/i);

  try {
    server.close();
  } catch {
    /* */
  }
}, 25_000);

/**
 * P2: dual committed12 で peer close_notify は graceful association close。
 * fatal ではなく onClose、phase closed、API 拒否。
 */
test("e2e/dual: committed12 peer close_notify closes association gracefully", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };

  const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
    mtu: 1200,
  });
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    handshakeCarrier: clientCarrier,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("committed12 setup timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      resolve();
    });
    void client.connect();
  });

  expect(client.dualAssociationPhase).toBe("committed12");
  expect(client.connected).toBe(true);

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));

  // Act: peer close_notify (warning level)
  const closeBody = Buffer.from([1, AlertDesc.CloseNotify]);
  const closePkt = serializePlaintextRecord(ContentType.alert, 0, 0, closeBody);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("close_notify onClose timeout")),
      5_000,
    );
    client.onClose.subscribe(() => {
      clearTimeout(timer);
      resolve();
    });
    (client as any).udpOnMessage(closePkt, [
      (serverTransport.address as any).address === "0.0.0.0"
        ? "127.0.0.1"
        : (serverTransport.address as any).address,
      (serverTransport.address as any).port,
    ]);
  });

  // Assert: graceful close — onError なし、phase closed
  expect(errors.length).toBe(0);
  expect(client.connected).toBe(false);
  expect(client.dualAssociationPhase).toBe("closed");
  expect((client as any).associationTornDown).toBe(true);
  expect((client as any).dtls.flightTimers.size).toBe(0);
  expect(clientCarrier.isClosed()).toBe(true);

  await expect(client.send(Buffer.from("after-close-notify"))).rejects.toThrow(
    /closed/i,
  );
  await expect(client.connect()).rejects.toThrow(/closed/i);

  try {
    server.close();
  } catch {
    /* */
  }
}, 25_000);

/**
 * P2: 通常の warning alert は connection を閉じない。
 */
test("e2e/dual: committed12 non-close_notify warning does not tear down", async () => {
  // Arrange
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
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("committed12 setup timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      resolve();
    });
    void client.connect();
  });

  expect(client.dualAssociationPhase).toBe("committed12");
  expect(client.connected).toBe(true);

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(Date.now()));

  // Act: warning user_canceled (not close_notify) — must not close association
  const warnBody = Buffer.from([1, AlertDesc.UserCanceled]);
  const warnPkt = serializePlaintextRecord(ContentType.alert, 0, 0, warnBody);
  (client as any).udpOnMessage(warnPkt, [
    (serverTransport.address as any).address === "0.0.0.0"
      ? "127.0.0.1"
      : (serverTransport.address as any).address,
    (serverTransport.address as any).port,
  ]);

  await new Promise((r) => setTimeout(r, 50));

  // Assert: 接続継続
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(0);
  expect(client.connected).toBe(true);
  expect(client.dualAssociationPhase).toBe("committed12");
  // send 可能（association 生存）
  await client.send(Buffer.from("still-open"));

  client.close();
  try {
    server.close();
  } catch {
    /* */
  }
}, 25_000);
