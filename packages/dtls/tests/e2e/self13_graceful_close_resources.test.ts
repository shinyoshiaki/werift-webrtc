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
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
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
    void client.connect();
  });
  return { client, server, clientTransport, serverTransport };
}

/**
 * P2: graceful close は transport.send が停滞しても carrier/timer を解放する。
 */
test("e2e/self13: graceful close frees carrier even if send hangs", async () => {
  // Arrange
  const { client, server, clientTransport, serverTransport } =
    await connectPair13();
  const eng = (server as any).engine13;
  expect(eng).toBeTruthy();
  const carrier = eng.getHandshakeCarrier();

  // Hang all subsequent transport sends (simulate stalled close_notify)
  const origSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async () =>
    new Promise<void>(() => {
      /* never resolve */
    });

  // Act
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

  // Assert: association resources released
  expect(carrier.isClosed()).toBe(true);
  // Pending flight / retransmit should be cleared (no active cancel handle)
  expect((eng as any).cancelRetransmit).toBeUndefined();
  expect((eng as any).cancelEpochPrune).toBeUndefined();

  // Restore send for cleanup
  serverTransport.send = origSend;
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
  const { client, server, clientTransport, serverTransport } =
    await connectPair13();
  const eng = (client as any).engine13;
  // Force a fake pending retransmit cancel handle
  let cancelled = false;
  (eng as any).cancelRetransmit = () => {
    cancelled = true;
  };
  (eng as any).cancelEpochPrune = () => {
    cancelled = true;
  };

  eng.close();
  // Sync: beginGracefulClose runs before any await
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
