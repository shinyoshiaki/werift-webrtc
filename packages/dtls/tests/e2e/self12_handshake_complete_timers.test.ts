import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { certPem, keyPem } from "../fixture";

/**
 * P2: DTLS 1.2 handshake complete must cancel Flight4/Flight5 retransmit
 * sleeps immediately — not leave cancelable sleep until the next RTO after
 * onConnect (carrier/lifecycle: cancel timers on handshake complete).
 *
 * Uses real Flight4/Flight5 timers only (no artificial flightSleep).
 */
test("e2e/self12: handshake complete clears both sides flight timers", async () => {
  // Arrange: pure 1.2 client/server
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
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  const clientDtls = (client as any).dtls;
  const serverDtls = (server as any).dtls;

  // Act: 双方 onConnect を待つ
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("handshake timeout")),
      10_000,
    );
    let clientOk = false;
    let serverOk = false;
    const maybeDone = () => {
      if (clientOk && serverOk) {
        clearTimeout(timer);
        resolve();
      }
    };
    client.onConnect.subscribe(() => {
      // Assert (onConnect 直後): client Flight5 sleep が即 cancel
      expect(clientDtls.flightTimers.size).toBe(0);
      expect(clientDtls.flightSleepResolvers.size).toBe(0);
      clientOk = true;
      maybeDone();
    });
    server.onConnect.subscribe(() => {
      // Assert (onConnect 直後): server Flight4 sleep が即 cancel
      expect(serverDtls.flightTimers.size).toBe(0);
      expect(serverDtls.flightSleepResolvers.size).toBe(0);
      serverOk = true;
      maybeDone();
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

  // Assert: 接続完了後も双方 empty（flight は 7 / 6、99 ではない）
  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);
  expect(clientDtls.flight).toBe(7);
  expect(serverDtls.flight).toBe(6);
  expect(clientDtls.flightTimers.size).toBe(0);
  expect(clientDtls.flightSleepResolvers.size).toBe(0);
  expect(serverDtls.flightTimers.size).toBe(0);
  expect(serverDtls.flightSleepResolvers.size).toBe(0);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 15_000);
