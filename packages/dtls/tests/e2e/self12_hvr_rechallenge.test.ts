import { spawn } from "child_process";
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

type WireHs = {
  epoch: number;
  recordSeq: number;
  type: number;
  messageSeq: number;
};

/**
 * DTLS 1.2 handshake fragments: epoch + record sequence + message_seq.
 * Read-only on the wire buffer — must never throw or mutate TX bytes.
 */
function handshakeSeqsFromDatagram(buf: Buffer): WireHs[] {
  const out: WireHs[] = [];
  try {
    let start = 0;
    while (buf.length > start + 13) {
      const contentType = buf[start];
      const epoch = buf.readUInt16BE(start + 3);
      const recordSeq = buf.readUIntBE(start + 5, 6);
      const fragLen = buf.readUInt16BE(start + 11);
      const recEnd = start + 13 + fragLen;
      if (buf.length < recEnd) break;
      if (contentType === ContentType.handshake && fragLen >= 12) {
        let off = start + 13;
        while (off + 12 <= recEnd) {
          const type = buf[off];
          const messageSeq = buf.readUInt16BE(off + 4);
          const fragmentLength = buf.readUIntBE(off + 9, 3);
          out.push({ epoch, recordSeq, type, messageSeq });
          const next = off + 12 + fragmentLength;
          if (next <= off) break;
          off = next;
        }
      }
      start = recEnd;
    }
  } catch {
    // Observation only — never block the datagram.
  }
  return out;
}

function firstOfType(rows: WireHs[], type: number): WireHs | undefined {
  return rows.find((r) => r.type === type);
}

function firstNOfType(rows: WireHs[], type: number, n: number): WireHs[] {
  return rows.filter((r) => r.type === type).slice(0, n);
}

/** Same (epoch, recordSeq) must not appear twice among distinct records. */
function assertUniqueEpochRecordSeq(rows: WireHs[]) {
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.epoch}:${r.recordSeq}`;
    expect(seen.has(key), `duplicate epoch/record_seq ${key}`).toBe(false);
    seen.add(key);
  }
}

/**
 * P2 unit: re-HVR は ClientHello の message_seq に合わせ、record_seq は巻き戻さない。
 */
test("unit/flight2: HVR message_seq follows ClientHello; record_seq increases", async () => {
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

  // Act: CH seq=0 → HVR、続けて CH seq=1 → 再 HVR
  flight2(udp, dtls)(hello, ["127.0.0.1", 9], 0);
  flight2(udp, dtls)(hello, ["127.0.0.1", 9], 1);

  // Assert: handshake seq は CH に追従、record seq は epoch 0 で単調増加
  expect(sent.length).toBe(2);
  const hvr0 = handshakeSeqsFromDatagram(sent[0]);
  const hvr1 = handshakeSeqsFromDatagram(sent[1]);
  expect(hvr0).toHaveLength(1);
  expect(hvr1).toHaveLength(1);
  expect(hvr0[0].type).toBe(HandshakeType.hello_verify_request_3);
  expect(hvr1[0].type).toBe(HandshakeType.hello_verify_request_3);
  expect(hvr0[0].messageSeq).toBe(0);
  expect(hvr1[0].messageSeq).toBe(1);
  expect(hvr0[0].epoch).toBe(0);
  expect(hvr1[0].epoch).toBe(0);
  expect(hvr1[0].recordSeq).toBeGreaterThan(hvr0[0].recordSeq);
  assertUniqueEpochRecordSeq([...hvr0, ...hvr1]);

  await transport.close().catch(() => {});
});

/**
 * P2 E2E: cookie re-challenge の wire 上 handshake / record sequence。
 * CH1=0 → HVR1 msg=0 rec=1 → CH2=1 → HVR2 msg=1 rec>1 → CH3=2 → SH msg=2 rec>HVR2
 */
test("e2e/self12: re-HVR wire message_seq and record_seq progress", async () => {
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

  const clientHs: WireHs[] = [];
  const serverHs: WireHs[] = [];
  let hvrCount = 0;

  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientHs.push(...handshakeSeqsFromDatagram(buf));
    return origClientSend(buf, addr);
  };

  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    for (const hs of handshakeSeqsFromDatagram(buf)) {
      serverHs.push(hs);
      if (hs.type === HandshakeType.hello_verify_request_3) {
        hvrCount += 1;
        // 最初の HVR 送信直後に cookie secret を回し、CH2 を invalid にする
        if (hvrCount === 1) {
          const secret = (server as any).dtls.cookieSecret as Buffer;
          secret.fill(0x5a);
        }
      }
    }
    return origServerSend(buf, addr);
  };

  // Act: re-challenge 付きフルハンドシェイク
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(`re-HVR seq handshake timeout (hvrCount=${hvrCount})`),
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

  // Assert: handshake message_seq と record sequence の両方
  const chs = firstNOfType(clientHs, HandshakeType.client_hello_1, 3);
  const hvrs = firstNOfType(serverHs, HandshakeType.hello_verify_request_3, 2);
  const sh = firstOfType(serverHs, HandshakeType.server_hello_2);
  const cert = firstOfType(serverHs, HandshakeType.certificate_11);
  expect(hvrCount).toBeGreaterThanOrEqual(2);
  expect(chs.map((c) => c.messageSeq)).toEqual([0, 1, 2]);
  expect(hvrs[0].messageSeq).toBe(0);
  expect(hvrs[1].messageSeq).toBe(1);
  expect(sh?.messageSeq).toBe(2);
  expect(cert?.messageSeq).toBe(3);
  expect(hvrs[0].epoch).toBe(0);
  expect(hvrs[1].epoch).toBe(0);
  expect(sh?.epoch).toBe(0);
  expect(hvrs[1].recordSeq).toBeGreaterThan(hvrs[0].recordSeq);
  expect(sh!.recordSeq).toBeGreaterThan(hvrs[1].recordSeq);
  // 最初の Flight4 再送より前（HVR1/HVR2 + 初回 SH..）で record_seq 重複なし
  const firstSh = serverHs.findIndex(
    (r) => r.type === HandshakeType.server_hello_2,
  );
  const secondSh = serverHs.findIndex(
    (r, i) => r.type === HandshakeType.server_hello_2 && i > firstSh,
  );
  assertUniqueEpochRecordSeq(
    secondSh === -1 ? serverHs : serverHs.slice(0, secondSh),
  );
  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 30_000);

/**
 * P2: replay window を持つ OpenSSL DTLS 1.2 client でも re-HVR 後に接続できる。
 * HVR2 が HVR1 と同じ record_seq だと OpenSSL が replay discard して timeout する。
 */
test("e2e/openssl: re-HVR after cookie rotation completes DTLS 1.2", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  const serverHs: WireHs[] = [];
  let hvrCount = 0;
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    for (const hs of handshakeSeqsFromDatagram(buf)) {
      serverHs.push(hs);
      if (hs.type === HandshakeType.hello_verify_request_3) {
        hvrCount += 1;
        if (hvrCount === 1) {
          const secret = (server as any).dtls.cookieSecret as Buffer;
          secret.fill(0x5a);
        }
      }
    }
    return origServerSend(buf, addr);
  };

  const openssl = spawn("openssl", [
    "s_client",
    "-dtls1_2",
    "-connect",
    `127.0.0.1:${serverTransport.port}`,
  ]);
  openssl.stdout?.setEncoding("ascii");

  // Act: OpenSSL client が re-HVR を受けて接続し、app data を受信する
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(
          new Error(
            `openssl re-HVR timeout (hvrCount=${hvrCount} hvrs=${serverHs
              .filter((h) => h.type === HandshakeType.hello_verify_request_3)
              .map((h) => `msg=${h.messageSeq}/rec=${h.recordSeq}`)
              .join(",")})`,
          ),
        );
      }, 15_000);
      server.onConnect.subscribe(() => {
        void server.send(Buffer.from("re-hvr-openssl"));
      });
      server.onError.subscribe((e) => {
        clearTimeout(t);
        reject(e);
      });
      openssl.stdout?.on("data", (data: string) => {
        if (data.includes("re-hvr-openssl")) {
          clearTimeout(t);
          resolve();
        }
      });
      openssl.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });

    // Assert: 2 回の HVR があり record_seq は増加、handshake 完了
    const hvrs = firstNOfType(
      serverHs,
      HandshakeType.hello_verify_request_3,
      2,
    );
    const sh = firstOfType(serverHs, HandshakeType.server_hello_2);
    expect(hvrCount).toBeGreaterThanOrEqual(2);
    expect(hvrs[0].messageSeq).toBe(0);
    expect(hvrs[1].messageSeq).toBe(1);
    expect(hvrs[1].recordSeq).toBeGreaterThan(hvrs[0].recordSeq);
    expect(sh).toBeTruthy();
    expect(sh!.recordSeq).toBeGreaterThan(hvrs[1].recordSeq);
    expect(server.connected).toBe(true);
  } finally {
    openssl.kill("SIGTERM");
    try {
      server.close();
    } catch {
      /* */
    }
    await serverTransport.close().catch(() => {});
  }
}, 20_000);
