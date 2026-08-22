import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

async function connectPair13() {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
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
 * P1: pure 1.3 server local close() 直後に send は同期的に拒否
 * （close_notify 完了を待たない）。
 */
test("e2e/self13: server close() rejects send synchronously", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair13();
  expect(server.isDtls13).toBe(true);
  expect(server.connected).toBe(true);

  // Act: close then immediate send (no await of onClose)
  server.close();

  // Assert: terminal sync — no race window for app send
  expect((server as any).associationTornDown).toBe(true);
  expect(server.connected).toBe(false);
  await expect(server.send(Buffer.from("after-close"))).rejects.toThrow(
    /closed/i,
  );
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
 * P1: pure 1.3 peer close_notify 開始直後も send 拒否（teardown 完了前）。
 * client.close() が wire 上の close_notify を送り、server onClosing が同期 terminal。
 */
test("e2e/self13: peer close_notify rejects send before teardown completes", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair13();

  const closes: number[] = [];
  server.onClose.subscribe(() => closes.push(Date.now()));

  // Act: client local close delivers close_notify to server over UDP
  client.close();

  // Wait until server observes peer close_notify (onClosing → associationTornDown)
  for (let i = 0; i < 100; i++) {
    if ((server as any).associationTornDown) break;
    await new Promise((r) => setTimeout(r, 10));
  }

  expect((server as any).associationTornDown).toBe(true);
  await expect(server.send(Buffer.from("late"))).rejects.toThrow(/closed/i);

  // onClose still eventually fires once
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
test("e2e/self13: client close() rejects send synchronously", async () => {
  const { client, server, clientTransport, serverTransport } =
    await connectPair13();

  client.close();
  expect((client as any).associationTornDown).toBe(true);
  expect((client as any).dualAssociationPhase).toBe("closed");
  await expect(client.send(Buffer.from("x"))).rejects.toThrow(/closed/i);

  try {
    server.close();
  } catch {
    /* */
  }
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
