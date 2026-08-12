import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

async function connectPair13(
  serverVersions: readonly DtlsVersion[] = [DtlsVersion.V1_3],
) {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: serverVersions,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
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

/**
 * P1: pure DTLS 1.3 server local close 後も associationTornDown が立たず、
 * send/exporter が空の 1.2 cipher に fallthrough して内部 TypeError になる非対称を防ぐ。
 * （client pure 1.3 / pure 1.2 は既に terminal API 拒否済み）
 */
test("e2e/self13: pure server close rejects send/exporter/cert cleanly", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair13([DtlsVersion.V1_3]);
  expect(server.isDtls13).toBe(true);
  expect(server.connected).toBe(true);

  const closes: number[] = [];
  server.onClose.subscribe(() => closes.push(Date.now()));

  // Act
  server.close();
  await new Promise((r) => setTimeout(r, 50));

  // Assert: terminal invariant（role 非依存）
  expect(server.connected).toBe(false);
  expect((server as any).associationTornDown).toBe(true);
  expect(server.isDtls13).toBe(false);
  expect(closes.length).toBe(1);

  await expect(server.send(Buffer.from("x"))).rejects.toThrow(/closed/i);
  expect(() => server.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 16)).toThrow(
    /closed/i,
  );
  expect(() => server.remoteCertificate).toThrow(/closed/i);

  // second close is no-op (onClose still once)
  server.close();
  expect(closes.length).toBe(1);

  try {
    client.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: pure DTLS 1.3 server fatal 後も Public API が 1.2 fallthrough しないこと。
 */
test("e2e/self13: pure server fatal rejects Public API and stays terminal", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair13([DtlsVersion.V1_3]);

  const errors: Error[] = [];
  const closes: number[] = [];
  server.onError.subscribe((e) => errors.push(e));
  server.onClose.subscribe(() => closes.push(Date.now()));

  // Act: engine-level fatal (bridge → failAssociationFromEngine13)
  const eng = (server as any).engine13;
  eng.onError.execute(new Error("probe peer fatal"));
  await new Promise((r) => setTimeout(r, 30));

  // Assert
  expect(errors.length).toBe(1);
  expect(closes.length).toBe(1);
  expect(server.connected).toBe(false);
  expect((server as any).associationTornDown).toBe(true);
  expect(server.isDtls13).toBe(false);
  await expect(server.send(Buffer.from("z"))).rejects.toThrow(/closed/i);
  expect(() => server.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 16)).toThrow(
    /closed/i,
  );

  // late re-fatal must not double-fire
  eng?.onError?.execute?.(new Error("late"));
  await new Promise((r) => setTimeout(r, 20));
  expect(errors.length).toBe(1);
  expect(closes.length).toBe(1);

  try {
    client.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: dual server が 1.3 に commit した後の close も pure 1.3 と同じ terminal。
 */
test("e2e/self13: dual server after 1.3 commit close is terminal", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair13([DtlsVersion.V1_3, DtlsVersion.V1_2]);
  expect(server.isDtls13).toBe(true);

  const closes: number[] = [];
  server.onClose.subscribe(() => closes.push(1));

  // Act
  server.close();
  await new Promise((r) => setTimeout(r, 50));

  // Assert
  expect((server as any).associationTornDown).toBe(true);
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
 * P1: pure 1.3 peer close_notify（client→server）後、server も terminal + API 拒否。
 * fatal ではなく graceful: onError なし、onClose 1 回。
 */
test("e2e/self13: peer close_notify leaves pure server terminal without onError", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair13([DtlsVersion.V1_3]);

  const errors: Error[] = [];
  const closes: number[] = [];
  server.onError.subscribe((e) => errors.push(e));
  server.onClose.subscribe(() => closes.push(Date.now()));

  // Act: client local close → close_notify → server peer close path
  client.close();
  await new Promise((r) => setTimeout(r, 200));

  // Assert
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(1);
  expect(server.connected).toBe(false);
  expect((server as any).associationTornDown).toBe(true);
  await expect(server.send(Buffer.from("x"))).rejects.toThrow(/closed/i);

  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);

/**
 * P1: pure 1.3 server→client close_notify も client dual terminal と整合。
 */
test("e2e/self13: peer close_notify leaves pure client terminal without onError", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair13([DtlsVersion.V1_3]);

  const errors: Error[] = [];
  const closes: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onClose.subscribe(() => closes.push(Date.now()));

  // Act
  server.close();
  await new Promise((r) => setTimeout(r, 200));

  // Assert
  expect(errors.length).toBe(0);
  expect(closes.length).toBe(1);
  expect(client.connected).toBe(false);
  expect((client as any).associationTornDown).toBe(true);
  expect((client as any).dualAssociationPhase).toBe("closed");
  await expect(client.send(Buffer.from("x"))).rejects.toThrow(/closed/i);
  await expect(client.connect()).rejects.toThrow(/closed/i);

  try {
    client.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
