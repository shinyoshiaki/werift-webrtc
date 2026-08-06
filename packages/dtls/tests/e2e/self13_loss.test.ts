import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { DtlsAck } from "../../src/handshake/message/tls13/ack";
import { certPem, keyPem } from "../fixture";

/**
 * Loss / reorder / duplicate helpers wrap the peer transport to drop or
 * reorder the first N handshake datagrams.
 */
function wrapTransport(
  transport: Awaited<ReturnType<typeof UdpTransport.init>>,
  mode: "drop-first" | "duplicate" | "none",
) {
  const originalSend = transport.send.bind(transport);
  let sent = 0;
  transport.send = async (buf: Buffer, addr?: any) => {
    sent++;
    if (mode === "drop-first" && sent === 1) {
      // 最初の ClientHello を落とす → 再送で回復
      return;
    }
    if (mode === "duplicate") {
      await originalSend(buf, addr);
      await originalSend(buf, addr);
      return;
    }
    await originalSend(buf, addr);
  };
  return transport;
}

test("e2e/self13 recovers from first ClientHello loss", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = wrapTransport(
    await UdpTransport.init("udp4"),
    "drop-first",
  );
  clientTransport.rinfo = serverTransport.address;

  const opts = {
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3] as const,
    addressValidation: "none" as const,
  };
  const server = new DtlsServer({ transport: serverTransport, ...opts });
  const client = new DtlsClient({ transport: clientTransport, ...opts });

  // Act / Assert
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("loss timeout")), 20_000);
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("after-loss"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("after-loss");
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 25_000);

test("e2e/self13 tolerates duplicate ClientHello datagrams", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = wrapTransport(
    await UdpTransport.init("udp4"),
    "duplicate",
  );
  clientTransport.rinfo = serverTransport.address;

  const opts = {
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3] as const,
    addressValidation: "none" as const,
  };
  const server = new DtlsServer({ transport: serverTransport, ...opts });
  const client = new DtlsClient({ transport: clientTransport, ...opts });

  // Act / Assert
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("duplicate timeout")),
      15_000,
    );
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 20_000);

test("ACK codec roundtrip for record numbers", () => {
  // Arrange
  const ack = new DtlsAck([
    { epoch: 2, sequenceNumber: 0 },
    { epoch: 2, sequenceNumber: 1 },
  ]);
  // Act
  const wire = ack.serialize();
  const parsed = DtlsAck.deSerialize(wire);
  // Assert
  expect(parsed.recordNumbers).toEqual([
    { epoch: 2, sequenceNumber: 0 },
    { epoch: 2, sequenceNumber: 1 },
  ]);
});

test("e2e/self13 recovers when early handshake datagrams are dropped", async () => {
  // Arrange: handshake 中の最初の数 datagram のみ drop（再送で復旧）。
  // 偶数回常時 drop は再送も同じカウンタで落ち続けるため使わない。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const orig = clientTransport.send.bind(clientTransport);
  let dropped = 0;
  const maxDrops = 2;
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    if (dropped < maxDrops) {
      dropped++;
      return;
    }
    await orig(buf, addr);
  };
  const opts = {
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3] as const,
    addressValidation: "none" as const,
  };
  const server = new DtlsServer({ transport: serverTransport, ...opts });
  const client = new DtlsClient({ transport: clientTransport, ...opts });

  // Act / Assert
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("handshake loss timeout")),
      25_000,
    );
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("lossy"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("lossy");
      expect(dropped).toBe(maxDrops);
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 30_000);

test("e2e/self13 tolerates duplicate application data records", async () => {
  // Arrange: 接続後の app data を二重送出しても 1 回だけ処理（replay）
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const opts = {
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3] as const,
    addressValidation: "none" as const,
  };
  const server = new DtlsServer({ transport: serverTransport, ...opts });
  const client = new DtlsClient({ transport: clientTransport, ...opts });

  const origSend = clientTransport.send.bind(clientTransport);
  let connected = false;
  let dupOnce = false;
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    await origSend(buf, addr);
    // After handshake, duplicate the next app-data datagram once
    if (connected && !dupOnce && (buf[0] & 0xe0) === 0x20) {
      dupOnce = true;
      await origSend(buf, addr);
    }
  };

  // Act / Assert
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dup appdata timeout")),
      15_000,
    );
    let count = 0;
    server.onData.subscribe((d) => {
      count++;
      expect(d.toString()).toBe("dup-app");
      // replay は drop されるので 1 回のみ
      if (count === 1) {
        setTimeout(() => {
          expect(count).toBe(1);
          clearTimeout(timer);
          client.close();
          server.close();
          resolve();
        }, 200);
      }
    });
    client.onConnect.subscribe(() => {
      connected = true;
      void client.send(Buffer.from("dup-app"));
    });
    client.onError.subscribe((e) => {
      // replay may surface as error on some paths — ignore if already resolved
      if (/replay/i.test(e.message)) return;
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      if (/replay/i.test(e.message)) return;
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 20_000);

test("e2e/self13 reorders client application data after handshake", async () => {
  // Arrange: 2 つの app data を逆順で配信
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const opts = {
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3] as const,
    addressValidation: "none" as const,
  };
  const server = new DtlsServer({ transport: serverTransport, ...opts });
  const client = new DtlsClient({ transport: clientTransport, ...opts });

  const orig = clientTransport.send.bind(clientTransport);
  let phase: "hs" | "hold" | "flush" = "hs";
  const held: Buffer[] = [];
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    if (phase === "hold" && (buf[0] & 0xe0) === 0x20) {
      held.push(Buffer.from(buf));
      if (held.length >= 2) {
        phase = "flush";
        // reverse order
        await orig(held[1], addr);
        await orig(held[0], addr);
        held.length = 0;
      }
      return;
    }
    await orig(buf, addr);
  };

  // Act / Assert
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("app reorder timeout")),
      15_000,
    );
    const got: string[] = [];
    server.onData.subscribe((d) => {
      got.push(d.toString());
      if (got.length === 2) {
        // both messages arrive (order may be reversed)
        expect(got.sort()).toEqual(["a", "b"]);
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      }
    });
    client.onConnect.subscribe(async () => {
      phase = "hold";
      await client.send(Buffer.from("a"));
      await client.send(Buffer.from("b"));
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 20_000);

test("e2e/self13 recovers from client final-flight loss", async () => {
  // Arrange: CH は通す。2 本目以降の最初の client→server 暗号化 flight を 1 回落とす
  // (final Certificate?/Finished)。再送で handshake 完了すること。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const orig = clientTransport.send.bind(clientTransport);
  let clientSends = 0;
  let droppedFinal = false;
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientSends++;
    // 1 = ClientHello (plaintext). 2 = final flight (epoch-2 ciphertext).
    if (clientSends === 2 && !droppedFinal) {
      droppedFinal = true;
      return;
    }
    await orig(buf, addr);
  };
  const opts = {
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3] as const,
    addressValidation: "none" as const,
  };
  const server = new DtlsServer({ transport: serverTransport, ...opts });
  const client = new DtlsClient({ transport: clientTransport, ...opts });

  // Act / Assert
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("final-flight loss timeout")),
      25_000,
    );
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("final-ok"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("final-ok");
      expect(droppedFinal).toBe(true);
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 30_000);

test("e2e/self13 recovers from KeyUpdate loss", async () => {
  // Arrange: 接続後 KeyUpdate の初回送出を 1 回 drop → 再送後に app data
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const opts = {
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3] as const,
    addressValidation: "none" as const,
  };
  const server = new DtlsServer({ transport: serverTransport, ...opts });
  const client = new DtlsClient({ transport: clientTransport, ...opts });

  const orig = clientTransport.send.bind(clientTransport);
  let connected = false;
  let droppedKu = false;
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    // After connect, first non-app-looking ciphertext from client is KeyUpdate flight
    if (connected && !droppedKu) {
      // Unified header: epoch bits in low 2 of first byte when C=0; app data also unified.
      // Drop the first post-connect client datagram once (KeyUpdate).
      droppedKu = true;
      return;
    }
    await orig(buf, addr);
  };

  // Act / Assert
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("KeyUpdate loss timeout")),
      25_000,
    );
    client.onConnect.subscribe(async () => {
      connected = true;
      try {
        await client.keyUpdate(false);
        // 再送完了を待ってから app data
        await new Promise((r) => setTimeout(r, 1500));
        await client.send(Buffer.from("ku-after-loss"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("ku-after-loss");
      expect(droppedKu).toBe(true);
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 30_000);

test("e2e/self13 completes with small MTU forcing certificate fragmentation", async () => {
  // Arrange: 実証明書を小さな MTU で fragment して送受信
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const opts = {
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3] as const,
    addressValidation: "none" as const,
    mtu: 256,
  };
  const server = new DtlsServer({ transport: serverTransport, ...opts });
  const client = new DtlsClient({ transport: clientTransport, ...opts });

  // Act / Assert
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("small-MTU cert timeout")),
      20_000,
    );
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("mtu-cert"));
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("mtu-cert");
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });
}, 25_000);
