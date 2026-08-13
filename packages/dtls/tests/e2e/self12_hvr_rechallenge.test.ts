import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { SessionType } from "../../src/cipher/suites/abstract";
import { DtlsContext } from "../../src/context/dtls";
import { TransportContext } from "../../src/context/transport";
import { Flight3 } from "../../src/flight/client/flight3";
import { flight2 } from "../../src/flight/server/flight2";
import { HandshakeType } from "../../src/handshake/const";
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
        reject(new Error(`re-HVR handshake timeout (hvrCount=${hvrCount})`)),
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

/** DTLS 1.2 handshake fragments in a datagram: type + message_seq. */
function handshakeSeqsFromDatagram(
  buf: Buffer,
): Array<{ type: number; seq: number }> {
  const out: Array<{ type: number; seq: number }> = [];
  let start = 0;
  while (buf.length > start + 13) {
    const contentType = buf[start];
    const fragLen = buf.readUInt16BE(start + 11);
    const recStart = start + 13;
    const recEnd = recStart + fragLen;
    if (buf.length < recEnd) break;
    if (contentType === ContentType.handshake) {
      let off = recStart;
      while (off + 12 <= recEnd) {
        const type = buf[off];
        const seq = buf.readUInt16BE(off + 4);
        const fragmentLength = buf.readUIntBE(off + 9, 3);
        out.push({ type, seq });
        off += 12 + fragmentLength;
      }
    }
    start = recEnd;
  }
  return out;
}

/**
 * P2 unit: re-HVR must use the ClientHello message_seq, not rewind to 0.
 */
test("unit/flight2: HVR message_seq follows ClientHello message_seq", async () => {
  // Arrange
  const transport = await UdpTransport.init("udp4");
  const sent: Buffer[] = [];
  transport.send = async (buf: Buffer) => {
    sent.push(Buffer.from(buf));
  };
  const dtls = new DtlsContext({ transport } as any, SessionType.SERVER);
  const udp = new TransportContext(transport);
  const hello = new ClientHello(
    { major: 254, minor: 253 },
    new DtlsRandom(),
    Buffer.alloc(0),
    Buffer.alloc(0),
    [0xc02f],
    [0],
    [],
  );

  // Act: CH seq=0 → HVR seq=0、続けて CH seq=1 → HVR seq=1
  flight2(udp, dtls)(hello, ["127.0.0.1", 9], 0);
  flight2(udp, dtls)(hello, ["127.0.0.1", 9], 1);

  // Assert
  expect(sent.length).toBe(2);
  const hvr0 = handshakeSeqsFromDatagram(sent[0]);
  const hvr1 = handshakeSeqsFromDatagram(sent[1]);
  expect(hvr0).toEqual([
    { type: HandshakeType.hello_verify_request_3, seq: 0 },
  ]);
  expect(hvr1).toEqual([
    { type: HandshakeType.hello_verify_request_3, seq: 1 },
  ]);

  await transport.close().catch(() => {});
});

/**
 * P2 E2E: cookie re-challenge の wire message_seq を明示検証する。
 * CH1=0 → HVR1=0 → CH2=1 → HVR2=1 → CH3=2 → ServerHello=2 → Certificate=3
 */
test("e2e/self12: re-HVR wire message_seq progresses with ClientHello", async () => {
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

  const chSeqs: number[] = [];
  const hvrSeqs: number[] = [];
  const serverHelloSeqs: number[] = [];
  const certificateSeqs: number[] = [];

  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    for (const hs of handshakeSeqsFromDatagram(buf)) {
      if (hs.type === HandshakeType.client_hello_1) {
        chSeqs.push(hs.seq);
      }
    }
    return origClientSend(buf, addr);
  };

  let hvrCount = 0;
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    for (const hs of handshakeSeqsFromDatagram(buf)) {
      if (hs.type === HandshakeType.hello_verify_request_3) {
        hvrSeqs.push(hs.seq);
        hvrCount += 1;
        // 最初の HVR 送信直後に cookie secret を回し、CH2 を invalid にする
        if (hvrCount === 1) {
          const secret = (server as any).dtls.cookieSecret as Buffer;
          secret.fill(0x5a);
        }
      }
      if (hs.type === HandshakeType.server_hello_2) {
        serverHelloSeqs.push(hs.seq);
      }
      if (hs.type === HandshakeType.certificate_11) {
        certificateSeqs.push(hs.seq);
      }
    }
    return origServerSend(buf, addr);
  };

  // Act: re-challenge 付きフルハンドシェイク
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `re-HVR seq handshake timeout (hvrCount=${hvrCount} ch=${chSeqs.join(",")} hvr=${hvrSeqs.join(",")})`,
          ),
        ),
      25_000,
    );
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

  // Assert: 初出の各 message_seq（再送は無視）
  const firstCh = [...new Set(chSeqs)];
  const firstHvr = [...new Set(hvrSeqs)];
  expect(hvrCount).toBeGreaterThanOrEqual(2);
  expect(firstCh[0]).toBe(0);
  expect(firstCh[1]).toBe(1);
  expect(firstCh[2]).toBe(2);
  expect(firstHvr[0]).toBe(0);
  expect(firstHvr[1]).toBe(1);
  expect(serverHelloSeqs[0]).toBe(2);
  expect(certificateSeqs[0]).toBe(3);
  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 30_000);
