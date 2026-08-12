import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { Flight3 } from "../../src/flight/client/flight3";
import { ClientHello } from "../../src/handshake/message/client/hello";
import { ServerHelloVerifyRequest } from "../../src/handshake/message/server/helloVerifyRequest";
import { DtlsRandom } from "../../src/handshake/random";
import { ContentType } from "../../src/record/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * P2: Flight3 must accept a second HVR (re-challenge) while flight === 3
 * instead of throwing and fatally tearing down the association.
 */
test("unit/flight3: second HVR re-challenge updates cookie without throw", async () => {
  // Arrange: minimal Flight3 with lastFlight ClientHello
  const transport = await UdpTransport.init("udp4");
  transport.rinfo = { address: "127.0.0.1", port: 9 } as any;
  const sent: Buffer[] = [];
  transport.send = async (buf: Buffer) => {
    sent.push(Buffer.from(buf));
  };

  const { DtlsContext } = await import("../../src/context/dtls");
  const { SessionType } = await import("../../src/cipher/suites/abstract");
  const { TransportContext } = await import("../../src/context/transport");

  const dtls = new DtlsContext({ transport } as any, SessionType.CLIENT);
  dtls.flight = 1;
  // End Flight3 retransmit loop after first send (advance past nextFlight=5)
  dtls.flightSleep = async () => {
    dtls.flight = 5;
  };

  const hello = new ClientHello(
    { major: 254, minor: 253 },
    new DtlsRandom(),
    Buffer.alloc(0),
    Buffer.alloc(0),
    [0xc02f],
    [0],
    [],
  );
  dtls.lastFlight = [hello] as any;

  const udp = new TransportContext(transport);
  const flight3 = new Flight3(udp, dtls);

  const hvr1 = new ServerHelloVerifyRequest(
    { major: 254, minor: 253 },
    Buffer.alloc(20, 0xaa),
  );
  const hvr2 = new ServerHelloVerifyRequest(
    { major: 254, minor: 253 },
    Buffer.alloc(20, 0xbb),
  );

  // Act: first HVR
  await flight3.exec(hvr1);
  expect(hello.cookie.equals(Buffer.alloc(20, 0xaa))).toBe(true);
  const afterFirst = sent.length;
  expect(afterFirst).toBeGreaterThan(0);

  // Simulate still waiting for ServerHello (flight 3) when re-HVR arrives
  dtls.flight = 3;
  await flight3.exec(hvr2); // must not throw
  expect(hello.cookie.equals(Buffer.alloc(20, 0xbb))).toBe(true);
  expect(sent.length).toBeGreaterThan(afterFirst);

  // After flight advanced past 3, HVR is ignored
  dtls.flight = 5;
  const n = sent.length;
  await flight3.exec(hvr1);
  expect(sent.length).toBe(n);

  await transport.close().catch(() => {});
});

/**
 * P2 E2E: invalid cookie → server re-HVR → client Flight3 re-challenge → complete.
 * Simulate by rotating server cookieSecret after first HVR so CH2 fails verify.
 */
test("e2e/self12: client handles second HVR after invalid-cookie re-challenge", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

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

  let hvrCount = 0;
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    // HVR is flight 2 and not clientHelloCommitted
    if (
      !(server as any).dtls.clientHelloCommitted &&
      buf[0] === ContentType.handshake &&
      buf.length > 13 &&
      buf[13] === 3 // hello_verify_request
    ) {
      hvrCount += 1;
      // After first HVR is on the wire, rotate cookie secret so first CH2 fails
      if (hvrCount === 1) {
        const secret = (server as any).dtls.cookieSecret as Buffer;
        secret.fill(0x5a);
      }
    }
    return origServerSend(buf, addr);
  };

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(`re-HVR handshake timeout (hvrCount=${hvrCount})`),
        ),
      25_000,
    );
    client.onConnect.subscribe(() => {
      try {
        // Assert: server issued at least 2 HVRs (first + re-challenge)
        expect(hvrCount).toBeGreaterThanOrEqual(2);
        expect(client.connected).toBe(true);
        clearTimeout(t);
        resolve();
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
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

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 30_000);
