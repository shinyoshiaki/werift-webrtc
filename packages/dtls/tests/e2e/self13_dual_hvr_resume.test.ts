import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { DirectHandshakeCarrier } from "../../src/carrier/direct";
import { INITIAL_RTO_MS } from "../../src/engine/v1_3/types";
import { ServerHelloVerifyRequest } from "../../src/handshake/message/server/helloVerifyRequest";
import { createDtlsClientInternal } from "../../src/internal";
import { AlertDesc, ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

/**
 * Build a DTLS 1.2 HelloVerifyRequest epoch-0 record (unauthenticated).
 */
function buildHvrDatagram(cookie = Buffer.alloc(16, 0xab)): Buffer {
  const hvr = new ServerHelloVerifyRequest(
    { major: 254, minor: 253 }, // DTLS 1.2 wire
    cookie,
  );
  hvr.messageSeq = 0;
  const frag = hvr.toFragment();
  frag.message_seq = 0;
  return serializePlaintextRecord(
    ContentType.handshake,
    0,
    0,
    frag.serialize(),
  );
}

/**
 * Peer address as seen by a client that pinned the server destination.
 * UdpTransport.address is often 0.0.0.0:port; the 1.3 engine normalizes that
 * to 127.0.0.1 for pin. Injecting 0.0.0.0 is dropped as non-association peer.
 */
function clientFacingServerPeer(serverTransport: {
  address: { address: string; port: number } | string;
}): [string, number] {
  const a = serverTransport.address as { address: string; port: number };
  const host = a.address === "0.0.0.0" ? "127.0.0.1" : a.address;
  return [host, a.port];
}

/** Inject unauthenticated HVR as if it came from the dual/1.2 peer. */
function injectHvr(
  clientTransport: { onData?: (data: Buffer, addr?: any) => void },
  serverTransport: { address: { address: string; port: number } | string },
) {
  clientTransport.onData?.(
    buildHvrDatagram(),
    clientFacingServerPeer(serverTransport),
  );
}

/**
 * Shared race harness: deliver CH-A, hold server TX, inject spoofed HVR so the
 * client enters dualCookiePath with dualResume=CH-A, then release server TX.
 */
async function setupChAThenSpoofedHvr(opts?: {
  clientCarrier?: DirectHandshakeCarrier;
  addressValidation?: "dtls-cookie" | "none";
}) {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: opts?.addressValidation,
  });
  const client = opts?.clientCarrier
    ? createDtlsClientInternal({
        transport: clientTransport,
        cert: certPem,
        key: keyPem,
        protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
        addressValidation: opts?.addressValidation ?? "dtls-cookie",
        handshakeCarrier: opts.clientCarrier,
      })
    : new DtlsClient({
        transport: clientTransport,
        cert: certPem,
        key: keyPem,
        protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
        addressValidation: opts?.addressValidation,
      });

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  server.onError.subscribe((e) => errors.push(e));

  let releaseServerTx = false;
  const heldServerTx: { buf: Buffer; addr?: any }[] = [];
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    if (!releaseServerTx) {
      heldServerTx.push({ buf: Buffer.from(buf), addr });
      return;
    }
    return origServerSend(buf, addr);
  };
  const flushServerTx = async () => {
    releaseServerTx = true;
    for (const pkt of heldServerTx.splice(0)) {
      await origServerSend(pkt.buf, pkt.addr);
    }
  };

  let clientSends = 0;
  /** After HVR, hold dual cookie-CH TX until CH-A's 1.3 response is released. */
  let holdPostHvrClientTx = false;
  const heldClientTx: { buf: Buffer; addr?: any }[] = [];
  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientSends += 1;
    if (clientSends === 1) {
      // 1) CH-A をサーバへ実際に届ける
      await origClientSend(buf, addr);
      // 2) server が CH-A 向け応答を用意するまで待つ（hold 中）
      for (let i = 0; i < 50 && heldServerTx.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(heldServerTx.length).toBeGreaterThan(0);
      // Snapshot only CH-A responses (HRR/SH).
      const chAServerFlight = heldServerTx.splice(0);
      // 3) Hold any post-HVR client TX (legacy-cookie CH) so it cannot
      //    poison the server's CH-A HRR state before we deliver SH/HRR.
      holdPostHvrClientTx = true;
      injectHvr(clientTransport, serverTransport);
      for (let i = 0; i < 50; i++) {
        if (
          (client as any).dualPhase === "probing" &&
          !(client as any).engine13
        )
          break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((client as any).dualPhase).toBe("probing");
      expect((client as any).engine13).toBeUndefined();
      expect((client as any).dualResume).toBeTruthy();
      // Parked engine keeps CH-A retransmit for RFC 9147 loss recovery
      expect((client as any).parkedEngine13).toBeTruthy();
      expect((client as any).parkedEngine13.isDualProbeParked()).toBe(true);
      // 4) Release CH-A 向け server flight first; dual cookie CH stays held.
      //    1.3 resume will stop Flight1 (flight=99) so held cookie CH is obsolete.
      heldServerTx.length = 0;
      releaseServerTx = true;
      for (const pkt of chAServerFlight) {
        await origServerSend(pkt.buf, pkt.addr);
      }
      // Allow subsequent client TX (CH2 after HRR, app data, etc.)
      holdPostHvrClientTx = false;
      heldClientTx.length = 0; // drop obsolete dual cookie CH
      return;
    }
    if (holdPostHvrClientTx) {
      heldClientTx.push({ buf: Buffer.from(buf), addr });
      return;
    }
    return origClientSend(buf, addr);
  };

  return {
    server,
    client,
    errors,
    serverTransport,
    clientTransport,
    flushServerTx,
  };
}

/**
 * P1 race: original dual CH reaches the server; spoofed HVR races with the
 * real 1.3 SH/HRR. Client keeps CH-A transcript/keyPair and completes 1.3.
 */
test("e2e/dual: CH-A delivered + spoofed HVR race still completes DTLS 1.3", async () => {
  // Arrange / Act
  const { server, client, errors } = await setupChAThenSpoofedHvr();

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dual CH-A + HVR race → 1.3 timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        expect(client.isDtls13).toBe(true);
        expect(server.isDtls13).toBe(true);
        void client.send(Buffer.from("dual-hvr-race"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("dual-hvr-race");
        void server.send(Buffer.from("dual-hvr-race-ok"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    client.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("dual-hvr-race-ok");
        clearTimeout(timer);
        resolve();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    await client.connect();
  });

  // Assert: Flight1 終了後も遅延 onError なし
  await new Promise((r) => setTimeout(r, 600));
  expect(errors).toEqual([]);

  client.close();
  server.close();
}, 25_000);

test("e2e/dual: HVR→1.3 resume does not fire delayed onError after commit", async () => {
  // Arrange: CH-A 到達 + HVR 後に dual Flight1 が動き、1.3 commit しても
  // fatalError 由来の遅延 onError が無いこと（flight=99 のみで停止）。
  const { server, client, errors } = await setupChAThenSpoofedHvr({
    // none → full SH flight (no HRR); still exercises dual resume + Flight1 stop
    addressValidation: "none",
  });

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dual HVR→1.3 no-delayed-error timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        expect(client.isDtls13).toBe(true);
        void client.send(Buffer.from("dual-hvr-resume"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("dual-hvr-resume");
        void server.send(Buffer.from("dual-hvr-ok"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    client.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("dual-hvr-ok");
        clearTimeout(timer);
        resolve();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    await client.connect();
  });

  // Assert: ~500ms Flight1 interval を超えても errors 空
  await new Promise((r) => setTimeout(r, 600));
  expect(errors).toEqual([]);

  client.close();
  server.close();
}, 25_000);

/**
 * P2: custom (injected) carrier must survive soft HVR detach and work after
 * 1.3 resume — Epic 2 SPED path reuses handshakeCarrier instance.
 */
test("e2e/dual: injected carrier survives HVR soft fallback → 1.3 resume", async () => {
  const clientTransport = await UdpTransport.init("udp4");
  // carrier owns this transport; create before harness wires send hooks
  const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
    mtu: 1200,
  });

  // Rebuild harness pieces with injected carrier (custom setup)
  const serverTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
    handshakeCarrier: clientCarrier,
  });

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  server.onError.subscribe((e) => errors.push(e));

  let releaseServerTx = false;
  const heldServerTx: { buf: Buffer; addr?: any }[] = [];
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    if (!releaseServerTx) {
      heldServerTx.push({ buf: Buffer.from(buf), addr });
      return;
    }
    return origServerSend(buf, addr);
  };
  const flushServerTx = async () => {
    releaseServerTx = true;
    for (const pkt of heldServerTx.splice(0)) {
      await origServerSend(pkt.buf, pkt.addr);
    }
  };

  let clientSends = 0;
  let holdPostHvrClientTx = false;
  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientSends += 1;
    if (clientSends === 1) {
      await origClientSend(buf, addr);
      for (let i = 0; i < 50 && heldServerTx.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(heldServerTx.length).toBeGreaterThan(0);
      const chAServerFlight = heldServerTx.splice(0);
      holdPostHvrClientTx = true;
      injectHvr(clientTransport, serverTransport);
      for (let i = 0; i < 50; i++) {
        if (
          (client as any).dualPhase === "probing" &&
          !(client as any).engine13
        )
          break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((client as any).dualPhase).toBe("probing");
      // Soft park must not permanently close the injected carrier
      expect(clientCarrier.isClosed()).toBe(false);
      heldServerTx.length = 0;
      releaseServerTx = true;
      for (const pkt of chAServerFlight) {
        await origServerSend(pkt.buf, pkt.addr);
      }
      holdPostHvrClientTx = false;
      return;
    }
    if (holdPostHvrClientTx) return;
    return origClientSend(buf, addr);
  };

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("injected carrier dual HVR→1.3 timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        expect(client.isDtls13).toBe(true);
        expect(clientCarrier.isClosed()).toBe(false);
        const eng = (client as any).engine13;
        expect(eng.carrier).toBe(clientCarrier);
        void client.send(Buffer.from("carrier-hvr"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("carrier-hvr");
        void server.send(Buffer.from("carrier-hvr-ok"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    client.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("carrier-hvr-ok");
        clearTimeout(timer);
        resolve();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    await client.connect();
  });

  await new Promise((r) => setTimeout(r, 600));
  expect(errors).toEqual([]);
  expect(clientCarrier.isClosed()).toBe(false);

  client.close();
  server.close();
}, 25_000);

test("e2e/dual: HVR path still falls back to pure 1.2 server", async () => {
  // Arrange: 同じ dual 交渉が 1.2-only server では 1.2 完走すること（回帰）
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
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

  // Act / Assert: HVR はサーバ自身から。最終は 1.2。
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dual→1.2 fallback after HVR timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        expect(client.isDtls13).toBe(false);
        void client.send(Buffer.from("dual-12"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      expect(d.toString()).toBe("dual-12");
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    await client.connect();
  });
}, 25_000);

/**
 * P1: genuine 1.2 fatal alert during dual probing must surface immediately
 * (not only after retransmission timeout). Only illegal_parameter is suppressed.
 */
test("e2e/dual: genuine 1.2 handshake_failure during probing fires onError immediately", async () => {
  // Arrange: dual client × pure 1.2 server。HVR 後 probing に入り、
  // 正当な handshake_failure を注入したら即 onError すること。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
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

  // After server HVR, drop further server TX and inject handshake_failure
  let sawClientCookieCh = false;
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    // First server messages include HVR — deliver them
    if (!sawClientCookieCh) {
      return origServerSend(buf, addr);
    }
    // After probing cookie CH, suppress real SH and inject fatal instead
    return;
  };

  const origClientSend = clientTransport.send.bind(clientTransport);
  let clientSends = 0;
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientSends += 1;
    await origClientSend(buf, addr);
    // After dual probing starts, client will send cookie CH (2nd+ flight)
    if ((client as any).dualPhase === "probing" && clientSends >= 2) {
      sawClientCookieCh = true;
      // Act: inject genuine 1.2-style fatal handshake_failure (not illegal_parameter)
      const alertBody = Buffer.from([2, AlertDesc.HandshakeFailure]);
      const alertPkt = serializePlaintextRecord(
        ContentType.alert,
        0,
        0,
        alertBody,
      );
      queueMicrotask(() => {
        clientTransport.onData?.(
          alertPkt,
          clientFacingServerPeer(serverTransport),
        );
      });
    }
  };

  const t0 = Date.now();
  const err = await new Promise<Error>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("expected immediate onError on handshake_failure")),
      5_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      resolve(e);
    });
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      reject(new Error("must not connect after handshake_failure"));
    });
    void client.connect();
  });

  // Assert: 即時失敗（RTO 待ちにしない）
  expect(Date.now() - t0).toBeLessThan(3_000);
  expect(err.message).toMatch(/alert|handshake|fatal/i);
  expect((client as any).dualPhase).toBe("probing"); // never committed-12 via SH

  client.close();
  server.close();
}, 10_000);

/**
 * P2: when genuine CH-A HRR/SH is lost after HVR, parked engine must still
 * retransmit original CH-A so the 1.3 handshake can recover.
 */
test("e2e/dual: lost CH-A response after HVR recovers via CH-A retransmit", async () => {
  // Arrange:
  // 1) CH-A → server
  // 2) drop server's first response(s)
  // 3) spoofed HVR → dual probing (park keeps CH-A RTO)
  // 4) allow later server responses from CH-A retransmit
  // 5) DTLS 1.3 connects
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    // dtls-cookie: first reply is HRR; retransmitted CH-A can mint a fresh HRR
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  server.onError.subscribe((e) => errors.push(e));

  let clientHelloCount = 0;
  let dropServerUntilChaRetransmit = true;
  let chaRetransmitSeen = false;
  const firstChaBodies: Buffer[] = [];

  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    // Count epoch-0 ClientHello-looking handshake records (msg type 1)
    if (buf.length >= 14 && buf[0] === ContentType.handshake && buf[13] === 1) {
      clientHelloCount += 1;
      if (clientHelloCount === 1) {
        firstChaBodies.push(Buffer.from(buf));
      } else if (
        (client as any).dualPhase === "probing" &&
        firstChaBodies[0] &&
        buf.equals(firstChaBodies[0])
      ) {
        // Act: original CH-A retransmitted (same wire bytes, empty legacy cookie)
        chaRetransmitSeen = true;
        dropServerUntilChaRetransmit = false;
      }
    }
    if (clientHelloCount === 1) {
      await origClientSend(buf, addr);
      // Inject HVR after CH-A is on the wire; first server response stays dropped
      queueMicrotask(() => {
        injectHvr(clientTransport, serverTransport);
      });
      return;
    }
    return origClientSend(buf, addr);
  };

  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    if (dropServerUntilChaRetransmit) {
      // Drop first genuine SH/HRR for CH-A (and any illegal_parameter for cookie CH)
      return;
    }
    return origServerSend(buf, addr);
  };

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `CH-A retransmit recovery timeout (chaRetransmit=${chaRetransmitSeen}, dualPhase=${(client as any).dualPhase})`,
          ),
        ),
      25_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        expect(client.isDtls13).toBe(true);
        expect(server.isDtls13).toBe(true);
        expect(chaRetransmitSeen).toBe(true);
        void client.send(Buffer.from("cha-rto-ok"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("cha-rto-ok");
        clearTimeout(timer);
        resolve();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    await client.connect();
  });

  expect(errors).toEqual([]);
  client.close();
  server.close();
}, 30_000);

/**
 * P1: public close() during dual probing must hard-teardown parkedEngine13
 * (timers + pendingFlight + carrier). Merge-blocker for carrier lifecycle.
 */
test("e2e/dual: close() during probing tears down parked engine and carrier timers", async () => {
  // Arrange: dual client が CH-A 送出後 HVR で probing に入る
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
    mtu: 1200,
  });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    handshakeCarrier: clientCarrier,
  });
  // Blackhole peer — only need HVR to enter probing with pending CH-A
  let hvrInjected = false;
  clientTransport.send = async () => {
    if (!hvrInjected && (client as any).dualPhase === "none") {
      hvrInjected = true;
      queueMicrotask(() => {
        injectHvr(clientTransport, serverTransport);
      });
    }
  };

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));

  // Count carrier wire attempts after close (must stay 0 past RTO)
  let carrierSendsAfterClose = 0;
  const origCarrierSend = clientCarrier.send.bind(clientCarrier);
  clientCarrier.send = async (packet, addr) => {
    if (clientCarrier.isClosed()) {
      carrierSendsAfterClose += 1;
      return;
    }
    return origCarrierSend(packet, addr);
  };

  void client.connect();
  for (let i = 0; i < 50; i++) {
    if ((client as any).dualPhase === "probing") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect((client as any).dualPhase).toBe("probing");
  const parked = (client as any).parkedEngine13;
  expect(parked).toBeTruthy();
  expect(parked.isDualProbeParked()).toBe(true);
  expect(parked.getPendingFlightSize()).toBeGreaterThan(0);
  expect(clientCarrier.isClosed()).toBe(false);

  const connects: number[] = [];
  client.onConnect.subscribe(() => connects.push(Date.now()));

  // Act: public close while probing
  client.close();

  // Assert: parked candidate hard-closed; carrier permanently closed; phase closed
  expect(parked.isClosed()).toBe(true);
  expect(clientCarrier.isClosed()).toBe(true);
  expect(parked.getPendingFlightSize()).toBe(0);
  expect((client as any).parkedEngine13).toBeUndefined();
  expect((client as any).engine13).toBeUndefined();
  expect((client as any).dualPhase).toBe("closed");

  // RTO を越えても carrier send / onError / onConnect なし
  await new Promise((r) => setTimeout(r, INITIAL_RTO_MS + 400));
  expect(carrierSendsAfterClose).toBe(0);
  expect(errors).toEqual([]);
  expect(connects).toEqual([]);

  // close 後の inject は closed を壊さない
  clientCarrier.inject(
    buildHvrDatagram(),
    clientFacingServerPeer(serverTransport),
  );
  expect((client as any).dualPhase).toBe("closed");
  expect(connects).toEqual([]);
  expect(errors).toEqual([]);

  await serverTransport.close().catch(() => {});
  await clientTransport.close().catch(() => {});
}, 10_000);

/**
 * P2: carrier.inject during probing must go through association demux so
 * public engine13 is restored on 1.3 commit (not only UDP onData).
 */
test("e2e/dual: carrier.inject of 1.3 SH during probing commits via association", async () => {
  // Arrange: custom carrier; hold server TX; HVR → probing; inject SH via carrier
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
    mtu: 1200,
  });
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
    handshakeCarrier: clientCarrier,
  });

  const heldServerTx: { buf: Buffer; addr?: any }[] = [];
  let releaseServer = false;
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    if (!releaseServer) {
      heldServerTx.push({ buf: Buffer.from(buf), addr });
      return;
    }
    return origServerSend(buf, addr);
  };

  let clientSends = 0;
  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientSends += 1;
    if (clientSends === 1) {
      await origClientSend(buf, addr);
      for (let i = 0; i < 50 && heldServerTx.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(heldServerTx.length).toBeGreaterThan(0);
      const shFlight = heldServerTx.splice(0);
      injectHvr(clientTransport, serverTransport);
      for (let i = 0; i < 50; i++) {
        if ((client as any).dualPhase === "probing") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((client as any).dualPhase).toBe("probing");
      expect((client as any).engine13).toBeUndefined();
      expect(client.isDtls13).toBe(false);

      // Act: deliver 1.3 response via carrier.inject (not UDP onData)
      // — association demux must unpark and set engine13
      releaseServer = true;
      for (const pkt of shFlight) {
        clientCarrier.inject(pkt.buf, clientFacingServerPeer(serverTransport));
      }
      return;
    }
    return origClientSend(buf, addr);
  };

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("carrier.inject dual commit timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        // Assert: public socket owns the 1.3 engine after association demux
        expect(client.isDtls13).toBe(true);
        expect((client as any).engine13).toBeTruthy();
        expect((client as any).dualPhase).toBe("committed13");
        expect((client as any).parkedEngine13).toBeUndefined();
        const eng = (client as any).engine13;
        expect(eng.getHandshakeCarrier()).toBe(clientCarrier);
        void client.send(Buffer.from("inject-demux"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("inject-demux");
        clearTimeout(timer);
        resolve();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    await client.connect();
  });

  client.close();
  server.close();
}, 25_000);

/**
 * Test 3 (必須): probing 中に carrier.inject で正当な DTLS 1.2 ServerHello を
 * 届けて commit12 し、1.2 データと post-commit inject が association 1.2 path
 * を通ること（releaseForVersionFallback の no-op inject を踏まない）。
 */
test("e2e/dual: carrier.inject of 1.2 SH during probing commits via association", async () => {
  // Arrange: dual client × 1.2-only server。HVR 後 probing に入り、
  // server の 1.2 SH 以降を carrier.inject で client に届ける。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
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

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  server.onError.subscribe((e) => errors.push(e));

  // Hold all server→client wire TX; deliver only via carrier.inject after probing
  const heldServerTx: { buf: Buffer; addr?: any }[] = [];
  let injectViaCarrier = false;
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    if (!injectViaCarrier) {
      heldServerTx.push({ buf: Buffer.from(buf), addr });
      return;
    }
    // After commit path starts, still deliver remaining flights via inject so
    // association 1.2 path (not UDP only) is exercised for the whole HS.
    clientCarrier.inject(
      Buffer.from(buf),
      clientFacingServerPeer(serverTransport),
    );
  };

  let clientSends = 0;
  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientSends += 1;
    await origClientSend(buf, addr);
    // 最初の CH のあと HVR を注入して probing へ
    if (clientSends === 1) {
      for (let i = 0; i < 50 && heldServerTx.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // 1.2 server は通常 HVR を返す — wire へは出さず client に注入
      const firstFlight = heldServerTx.splice(0);
      for (const pkt of firstFlight) {
        clientTransport.onData?.(
          pkt.buf,
          clientFacingServerPeer(serverTransport),
        );
      }
      for (let i = 0; i < 50; i++) {
        if ((client as any).dualPhase === "probing") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((client as any).dualPhase).toBe("probing");
      expect(client.isDtls13).toBe(false);
      expect((client as any).parkedEngine13).toBeTruthy();
      // 以降の 1.2 SH 等は carrier.inject 経由
      injectViaCarrier = true;
      for (const pkt of heldServerTx.splice(0)) {
        clientCarrier.inject(pkt.buf, clientFacingServerPeer(serverTransport));
      }
    }
  };

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `carrier.inject 1.2 commit timeout (phase=${(client as any).dualPhase})`,
          ),
        ),
      20_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      try {
        // Assert: commit12 — 1.3 ではない、parked は停止
        expect(client.isDtls13).toBe(false);
        expect((client as any).dualPhase).toBe("committed12");
        expect((client as any).parkedEngine13).toBeUndefined();
        expect((client as any).engine13).toBeUndefined();
        // Act: 1.2 アプリデータ
        void client.send(Buffer.from("inject-12"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("inject-12");
        clearTimeout(timer);
        resolve();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    await client.connect();
  });

  expect(errors).toEqual([]);
  // carrier は soft transition 後も生きている（hard close ではない）
  expect(clientCarrier.isClosed()).toBe(false);

  client.close();
  server.close();
}, 25_000);

/**
 * Test 4a (必須): commit12 後の late 1.3 SH/HRR は version を巻き戻さない。
 */
test("e2e/dual: late 1.3 packet after commit12 does not reverse version", async () => {
  // Arrange: dual → pure 1.2 で commit12 まで完走
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
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

  const errors: Error[] = [];
  const connects: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onConnect.subscribe(() => connects.push(Date.now()));

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("commit12 setup timeout")),
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
    await client.connect();
  });

  expect(client.isDtls13).toBe(false);
  expect((client as any).dualPhase).toBe("committed12");
  const connectCountAfter12 = connects.length;

  // Act: late 1.3-looking SH（supported_versions=1.3）を注入
  const late13 = buildMinimalDtls13ServerHelloRecord();
  clientTransport.onData?.(late13, clientFacingServerPeer(serverTransport));
  await new Promise((r) => setTimeout(r, 50));

  // Assert: 1.2 のまま、二重 connect なし
  expect((client as any).dualPhase).toBe("committed12");
  expect(client.isDtls13).toBe(false);
  expect((client as any).engine13).toBeUndefined();
  expect(connects.length).toBe(connectCountAfter12);

  client.close();
  server.close();
}, 25_000);

/**
 * Test 4b (必須): commit13 後の late 1.2 SH / HVR / alert は 1.2 に戻らず、
 * public error を誤発火しない。
 */
test("e2e/dual: late 1.2 packet after commit13 does not reverse version", async () => {
  // Arrange: CH-A + spoofed HVR race で 1.3 完走
  const { server, client, errors, serverTransport, clientTransport } =
    await setupChAThenSpoofedHvr({ addressValidation: "none" });

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("commit13 setup timeout")),
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
    await client.connect();
  });

  expect(client.isDtls13).toBe(true);
  expect((client as any).dualPhase).toBe("committed13");
  const errCount = errors.length;
  const connects: number[] = [];
  client.onConnect.subscribe(() => connects.push(Date.now()));

  // Act: late 1.2-style packets
  clientTransport.onData?.(
    buildHvrDatagram(Buffer.alloc(8, 0xcd)),
    clientFacingServerPeer(serverTransport),
  );
  const alertBody = Buffer.from([2, AlertDesc.HandshakeFailure]);
  clientTransport.onData?.(
    serializePlaintextRecord(ContentType.alert, 0, 0, alertBody),
    clientFacingServerPeer(serverTransport),
  );
  await new Promise((r) => setTimeout(r, 50));

  // Assert: still 1.3 committed; no extra connect; no new public error required
  // (engine may silently discard unauthenticated late records)
  expect((client as any).dualPhase).toBe("committed13");
  expect(client.isDtls13).toBe(true);
  expect(connects).toEqual([]);
  // late unauthenticated alert must not surface as association-level version flip
  expect(errors.length).toBe(errCount);

  client.close();
  server.close();
}, 25_000);

/**
 * Test 5 (必須): probing 中の close と packet arrival の race。
 * 最終 state は必ず closed（再 connect なし、timer なし、error/connect なし）。
 */
test("e2e/dual: close races with carrier.inject leave association closed", async () => {
  // Arrange: custom carrier + probing
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
    mtu: 1200,
  });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    handshakeCarrier: clientCarrier,
  });

  let hvrInjected = false;
  clientTransport.send = async () => {
    if (!hvrInjected && (client as any).dualPhase === "none") {
      hvrInjected = true;
      queueMicrotask(() => {
        injectHvr(clientTransport, serverTransport);
      });
    }
  };

  const errors: Error[] = [];
  const connects: number[] = [];
  client.onError.subscribe((e) => errors.push(e));
  client.onConnect.subscribe(() => connects.push(Date.now()));

  void client.connect();
  for (let i = 0; i < 50; i++) {
    if ((client as any).dualPhase === "probing") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect((client as any).dualPhase).toBe("probing");

  // Act: close 直後に inject（race）
  client.close();
  const peer = clientFacingServerPeer(serverTransport);
  clientCarrier.inject(buildHvrDatagram(), peer);
  clientCarrier.inject(buildMinimalDtls13ServerHelloRecord(), peer);
  // ほぼ同時パターン: inject 中に再度 close してもよい
  client.close();

  // Assert: 最終 closed 不変
  expect((client as any).dualPhase).toBe("closed");
  expect((client as any).engine13).toBeUndefined();
  expect((client as any).parkedEngine13).toBeUndefined();
  expect(clientCarrier.isClosed()).toBe(true);

  await new Promise((r) => setTimeout(r, INITIAL_RTO_MS + 400));
  expect(errors).toEqual([]);
  expect(connects).toEqual([]);
  expect((client as any).dualPhase).toBe("closed");

  await serverTransport.close().catch(() => {});
  await clientTransport.close().catch(() => {});
}, 10_000);

/**
 * Minimal DTLSPlaintext ServerHello that advertises selected DTLS 1.3
 * (supported_versions). Used for late-packet / demux tests — not a full HS.
 */
function buildMinimalDtls13ServerHelloRecord(): Buffer {
  // Handshake fragment layout: type(1) length(3) msg_seq(2) frag_off(3) frag_len(3) body
  // ServerHello body (partial): server_version(2) random(32) session_id(1+0)
  // cipher(2) compression(1) extensions_len(2) + supported_versions ext
  const random = Buffer.alloc(32, 0x11);
  // supported_versions extension: type=43, length=2, selected=0xfefc (DTLS 1.3)
  const svExt = Buffer.alloc(6);
  svExt.writeUInt16BE(43, 0);
  svExt.writeUInt16BE(2, 2);
  svExt.writeUInt16BE(0xfefc, 4);
  const shBody = Buffer.concat([
    Buffer.from([0xfe, 0xfd]), // legacy version DTLS 1.2
    random,
    Buffer.from([0]), // session_id empty
    Buffer.from([0x13, 0x01]), // TLS_AES_128_GCM_SHA256
    Buffer.from([0]), // compression null
    (() => {
      const l = Buffer.alloc(2);
      l.writeUInt16BE(svExt.length, 0);
      return l;
    })(),
    svExt,
  ]);
  const frag = Buffer.alloc(12 + shBody.length);
  frag[0] = 2; // server_hello
  frag[1] = (shBody.length >> 16) & 0xff;
  frag[2] = (shBody.length >> 8) & 0xff;
  frag[3] = shBody.length & 0xff;
  // message_seq = 0, fragment_offset = 0
  frag[9] = (shBody.length >> 16) & 0xff;
  frag[10] = (shBody.length >> 8) & 0xff;
  frag[11] = shBody.length & 0xff;
  shBody.copy(frag, 12);
  return serializePlaintextRecord(ContentType.handshake, 0, 0, frag);
}

/**
 * P1: committed13 後の fatal（authenticated 相当の engine.fail）で association が
 * closed に遷移し、isDtls13 が false、stale callback / retransmit が残らないこと。
 */
test("e2e/dual: fatal after committed13 tears down association to closed", async () => {
  // Arrange: dual 1.3 完走（committed13）。carrier は setup 内 transport と同一にする。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
    mtu: 1200,
  });
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
    handshakeCarrier: clientCarrier,
  });

  // CH-A 到達 → spoofed HVR → genuine 1.3 応答（setupChA と同型の簡易版）
  let releaseServerTx = false;
  const heldServerTx: { buf: Buffer; addr?: any }[] = [];
  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    if (!releaseServerTx) {
      heldServerTx.push({ buf: Buffer.from(buf), addr });
      return;
    }
    return origServerSend(buf, addr);
  };
  let clientSends = 0;
  let holdPostHvrClientTx = false;
  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientSends += 1;
    if (clientSends === 1) {
      await origClientSend(buf, addr);
      for (let i = 0; i < 50 && heldServerTx.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const chAServerFlight = heldServerTx.splice(0);
      holdPostHvrClientTx = true;
      injectHvr(clientTransport, serverTransport);
      for (let i = 0; i < 50; i++) {
        if ((client as any).dualPhase === "probing") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      heldServerTx.length = 0;
      releaseServerTx = true;
      for (const pkt of chAServerFlight) {
        await origServerSend(pkt.buf, pkt.addr);
      }
      holdPostHvrClientTx = false;
      return;
    }
    if (holdPostHvrClientTx) return;
    return origClientSend(buf, addr);
  };

  let setupDone = false;
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("committed13 setup timeout")),
      20_000,
    );
    client.onError.subscribe((e) => {
      if (setupDone) return;
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      setupDone = true;
      resolve();
    });
    await client.connect();
  });

  expect(client.isDtls13).toBe(true);
  expect((client as any).dualPhase).toBe("committed13");
  const eng = (client as any).engine13;
  expect(eng).toBeTruthy();
  expect(clientCarrier.isClosed()).toBe(false);

  const fatalErrors: Error[] = [];
  const closes: number[] = [];
  const connectsAfter: number[] = [];
  client.onError.subscribe((e) => fatalErrors.push(e));
  client.onClose.subscribe(() => closes.push(Date.now()));
  client.onConnect.subscribe(() => connectsAfter.push(Date.now()));

  // Act: committed13 後の authenticated fatal（AEAD 済み peer alert 相当）
  // engine.fail は bridge → failAssociationFromEngine13 を通る
  eng.fail(new Error("fatal alert handshake_failure (authenticated)"));

  // Assert: association closed / public 1.3 ハンドルなし
  expect(fatalErrors.length).toBe(1);
  expect(fatalErrors[0].message).toMatch(/handshake_failure|fatal/i);
  expect(closes.length).toBe(1);
  expect(client.isDtls13).toBe(false);
  expect((client as any).engine13).toBeUndefined();
  expect((client as any).parkedEngine13).toBeUndefined();
  expect((client as any).dualPhase).toBe("closed");
  expect(clientCarrier.isClosed()).toBe(true);
  expect(eng.isClosed()).toBe(true);
  expect(eng.getPendingFlightSize()).toBe(0);

  // 再 inject / RTO 進行でも connect 二重・追加 error なし
  clientCarrier.inject(
    buildMinimalDtls13ServerHelloRecord(),
    clientFacingServerPeer(serverTransport),
  );
  await new Promise((r) => setTimeout(r, INITIAL_RTO_MS + 200));
  expect(connectsAfter).toEqual([]);
  expect(fatalErrors.length).toBe(1);
  expect(closes.length).toBe(1);
  expect((client as any).dualPhase).toBe("closed");
  expect(client.isDtls13).toBe(false);

  try {
    server.close();
  } catch {
    /* transport may already be closed */
  }
}, 30_000);

/**
 * P1: 1.3-only client × 1.2-only server の version mismatch 後、
 * association が closed で isDtls13 === false、carrier/retransmit が残らない。
 */
test("e2e/dual: 1.3-only version mismatch tears down association to closed", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
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
    protocolVersions: [DtlsVersion.V1_3],
    handshakeCarrier: clientCarrier,
  });

  const fatalErrors: Error[] = [];
  const connects: number[] = [];
  client.onError.subscribe((e) => fatalErrors.push(e));
  client.onConnect.subscribe(() => connects.push(Date.now()));

  // Act: HVR → ProtocolVersionError（1.3-only は dual soft に入らない）
  void client.connect();
  for (let i = 0; i < 100 && fatalErrors.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  // Assert: 公開 error は 1 回、version 系、association closed
  expect(fatalErrors.length).toBeGreaterThanOrEqual(1);
  expect(fatalErrors[0].message).toMatch(
    /protocol version|HelloVerifyRequest|DTLS 1\.2-only|ProtocolVersion/i,
  );
  expect(client.isDtls13).toBe(false);
  expect((client as any).engine13).toBeUndefined();
  expect((client as any).dualPhase).toBe("closed");
  expect(clientCarrier.isClosed()).toBe(true);
  expect(connects).toEqual([]);

  // 再 inject しても state 不変・追加 connect なし
  const errCount = fatalErrors.length;
  clientCarrier.inject(
    buildHvrDatagram(),
    clientFacingServerPeer(serverTransport),
  );
  await new Promise((r) => setTimeout(r, INITIAL_RTO_MS + 200));
  expect(fatalErrors.length).toBe(errCount);
  expect(connects).toEqual([]);
  expect((client as any).dualPhase).toBe("closed");
  expect(client.isDtls13).toBe(false);

  server.close();
}, 15_000);

/**
 * P1: commit12 後の hard close は associationCarrier を閉じる（1.3 engine 無しでも）。
 * soft release 後に carrier が生きたまま残るバグの回帰。
 */
test("e2e/dual: close() after committed12 closes association carrier", async () => {
  // Arrange: dual client × 1.2-only server → commit12 完走 + custom carrier
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
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

  await new Promise<void>(async (resolve, reject) => {
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
    await client.connect();
  });

  // Assert: commit12 — engine 無し、carrier は soft transition 後も生存
  expect(client.isDtls13).toBe(false);
  expect((client as any).dualPhase).toBe("committed12");
  expect((client as any).engine13).toBeUndefined();
  expect((client as any).parkedEngine13).toBeUndefined();
  expect(clientCarrier.isClosed()).toBe(false);

  // Act: public hard close（1.3 candidate 無し経路）
  client.close();

  // Assert: phase closed + carrier も hard-close
  expect((client as any).dualPhase).toBe("closed");
  expect(clientCarrier.isClosed()).toBe(true);
  expect((client as any).associationCarrier).toBeUndefined();

  // schedule / inject は no-op
  let scheduled = false;
  clientCarrier.schedule(10, () => {
    scheduled = true;
  });
  clientCarrier.inject(buildHvrDatagram());
  await new Promise((r) => setTimeout(r, 50));
  expect(scheduled).toBe(false);

  // closed 後の Public API は legacy 1.2 に落ちない
  await expect(client.connect()).rejects.toThrow(/closed/i);
  await expect(client.send(Buffer.from("x"))).rejects.toThrow(/closed/i);
  expect(() => client.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 16)).toThrow(
    /closed/i,
  );
  expect(() => client.remoteCertificate).toThrow(/closed/i);

  try {
    server.close();
  } catch {
    /* transport may already be closed */
  }
}, 25_000);

/**
 * P1: probing 中の send / exporter / 再 connect は 1.2 path にフォールスルーしない。
 */
test("e2e/dual: probing rejects send/export/reconnect fallthrough to 1.2", async () => {
  // Arrange: dual client を probing まで進める
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
    mtu: 1200,
  });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    handshakeCarrier: clientCarrier,
  });

  let hvrInjected = false;
  clientTransport.send = async () => {
    if (!hvrInjected && (client as any).dualPhase === "none") {
      hvrInjected = true;
      queueMicrotask(() => {
        injectHvr(clientTransport, serverTransport);
      });
    }
  };

  void client.connect();
  for (let i = 0; i < 50; i++) {
    if ((client as any).dualPhase === "probing") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect((client as any).dualPhase).toBe("probing");
  expect(client.isDtls13).toBe(false);

  // Act / Assert: probing 中は誤 1.2 送信・exporter・再 connect を拒否
  await expect(client.send(Buffer.from("probe-send"))).rejects.toThrow(
    /probing/i,
  );
  expect(() => client.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 16)).toThrow(
    /probing/i,
  );
  expect(() =>
    client.extractSessionKeys(16, 14),
  ).toThrow(/probing/i);
  expect(() => client.remoteCertificate).toThrow(/probing/i);
  await expect(client.connect()).rejects.toThrow(/probing/i);

  // まだ probing / carrier 生存（soft ではない）
  expect((client as any).dualPhase).toBe("probing");
  expect(clientCarrier.isClosed()).toBe(false);

  client.close();
  expect((client as any).dualPhase).toBe("closed");
  expect(clientCarrier.isClosed()).toBe(true);

  await serverTransport.close().catch(() => {});
  await clientTransport.close().catch(() => {});
}, 10_000);

/**
 * P1: 1.3 fatal teardown は candidate 有無に関わらず transport を閉じる。
 * hardDisposeResources は transport を閉じないため、association が必ず close する。
 */
test("e2e/dual: fatal after committed13 closes transport", async () => {
  // Arrange: dual 1.3 完走
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("committed13 setup timeout")),
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
    await client.connect();
  });

  // dual×dual without HVR keeps dualPhase "none" but owns engine13 (active 1.3)
  expect(client.isDtls13).toBe(true);
  expect((client as any).engine13).toBeTruthy();
  expect((clientTransport as any).closed).toBe(false);

  const eng = (client as any).engine13;
  // Act: authenticated fatal（hardDispose 経路 — transport は engine が閉じない）
  eng.fail(new Error("fatal alert handshake_failure (authenticated)"));

  // Assert: association closed + UDP transport closed
  expect((client as any).dualPhase).toBe("closed");
  expect(client.isDtls13).toBe(false);
  expect((clientTransport as any).closed).toBe(true);
  await expect(client.send(Buffer.from("x"))).rejects.toThrow(/closed/i);
  await expect(client.connect()).rejects.toThrow(/closed/i);
  expect(() => client.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 16)).toThrow(
    /closed/i,
  );

  try {
    server.close();
  } catch {
    /* */
  }
}, 25_000);

/**
 * P1: peer close_notify 後は dualPhase が closed。engine13 解除だけで 1.2 に落ちない。
 */
test("e2e/dual: peer close_notify sets phase closed and blocks 1.2 fallthrough", async () => {
  // Arrange: dual 1.3 完走後に server が close_notify
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });

  await Promise.all([
    new Promise<void>((r) => client.onConnect.once(r)),
    new Promise<void>((r) => server.onConnect.once(r)),
    client.connect(),
  ]);
  expect(client.isDtls13).toBe(true);
  expect((client as any).engine13).toBeTruthy();

  // Act: peer close_notify
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("peer close_notify timeout")),
      10_000,
    );
    client.onClose.subscribe(() => {
      try {
        // onClose 時点では engine をまだ検査可能、connected は false
        expect(client.connected).toBe(false);
        clearTimeout(timer);
        resolve();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    server.close();
  });

  // Assert: association closed（phase / API / transport）
  // peer-close 後の bridge が dualPhase を closed にする
  for (let i = 0; i < 20 && (client as any).dualPhase !== "closed"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect((client as any).dualPhase).toBe("closed");
  expect(client.isDtls13).toBe(false);
  expect((client as any).engine13).toBeUndefined();
  expect((clientTransport as any).closed).toBe(true);

  await expect(client.send(Buffer.from("after-peer-close"))).rejects.toThrow(
    /closed/i,
  );
  await expect(client.connect()).rejects.toThrow(/closed/i);
  expect(() => client.exportKeyingMaterial("EXTRACTOR-dtls_srtp", 16)).toThrow(
    /closed/i,
  );
  expect(() => client.remoteCertificate).toThrow(/closed/i);
}, 25_000);

/**
 * P1: 1.3-only version mismatch fatal でも transport が閉じる。
 */
test("e2e/dual: 1.3-only version mismatch closes transport", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const { HashAlgorithm, SignatureAlgorithm } = await import(
    "../../src/cipher/const"
  );
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
    protocolVersions: [DtlsVersion.V1_3],
  });

  const err = await new Promise<Error>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("expected ProtocolVersionError")),
      10_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      resolve(e);
    });
    client.onConnect.subscribe(() => {
      clearTimeout(timer);
      reject(new Error("must not connect"));
    });
    void client.connect();
  });

  expect(err.message).toMatch(
    /protocol version|HelloVerifyRequest|DTLS 1\.2-only/i,
  );
  expect((client as any).dualPhase).toBe("closed");
  expect(client.isDtls13).toBe(false);
  expect((clientTransport as any).closed).toBe(true);
  await expect(client.send(Buffer.from("x"))).rejects.toThrow(/closed/i);
  await expect(client.connect()).rejects.toThrow(/closed/i);

  try {
    server.close();
  } catch {
    /* */
  }
}, 15_000);

/**
 * P1: probing 中、異なる peer からの 1.3 SH は version commit しない（1.2 Flight を止めない）。
 */
test("e2e/dual: spoofed 1.3 SH from non-association peer does not commit version", async () => {
  // Arrange: dual client を probing まで進め、parked peer pin を確立
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  let hvrInjected = false;
  clientTransport.send = async () => {
    if (!hvrInjected && (client as any).dualPhase === "none") {
      hvrInjected = true;
      queueMicrotask(() => {
        injectHvr(clientTransport, serverTransport);
      });
    }
  };

  void client.connect();
  for (let i = 0; i < 50; i++) {
    if ((client as any).dualPhase === "probing") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect((client as any).dualPhase).toBe("probing");
  expect((client as any).parkedEngine13).toBeTruthy();
  const flightBefore = (client as any).dtls.flight;

  // Act: 別 peer からの 1.3-looking SH（spoof）
  const spoofPeer: [string, number] = ["203.0.113.50", 44444];
  clientTransport.onData?.(buildMinimalDtls13ServerHelloRecord(), spoofPeer);
  await new Promise((r) => setTimeout(r, 30));

  // Assert: version commit せず probing 維持、1.2 flight 未停止
  expect((client as any).dualPhase).toBe("probing");
  expect(client.isDtls13).toBe(false);
  expect((client as any).engine13).toBeUndefined();
  expect((client as any).parkedEngine13).toBeTruthy();
  // flight=99 は commit13 の印 — spoof では進まない
  expect((client as any).dtls.flight).toBe(flightBefore);

  client.close();
  await serverTransport.close().catch(() => {});
  await clientTransport.close().catch(() => {});
}, 10_000);

/**
 * P1: probing 中の illegal_parameter 抑制は epoch-0 のみ。epoch≥1 は actionable。
 */
test("e2e/dual: epoch-1 illegal_parameter during probing surfaces onError", async () => {
  // Arrange: probing まで進める
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  let hvrInjected = false;
  clientTransport.send = async () => {
    if (!hvrInjected && (client as any).dualPhase === "none") {
      hvrInjected = true;
      queueMicrotask(() => {
        injectHvr(clientTransport, serverTransport);
      });
    }
  };

  void client.connect();
  for (let i = 0; i < 50; i++) {
    if ((client as any).dualPhase === "probing") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect((client as any).dualPhase).toBe("probing");

  // Act: epoch-1 fatal illegal_parameter（抑制対象外）
  const alertBody = Buffer.from([2, AlertDesc.IllegalParameter]);
  const epoch1Alert = serializePlaintextRecord(
    ContentType.alert,
    1, // epoch ≥ 1
    0,
    alertBody,
  );

  const err = await new Promise<Error>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("expected onError for epoch-1 illegal_parameter")),
      3_000,
    );
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      resolve(e);
    });
    clientTransport.onData?.(
      epoch1Alert,
      clientFacingServerPeer(serverTransport),
    );
  });

  // Assert: public onError（timeout 化・握りつぶしではない）
  expect(err.message).toMatch(/alert|illegal|fatal/i);

  client.close();
  await serverTransport.close().catch(() => {});
  await clientTransport.close().catch(() => {});
}, 10_000);

/**
 * P2: connected 後の client.close() は close_notify を transport に載せる
 * （association hard-close が notify 送信前に socket を殺さない）。
 */
test("e2e/dual: local close sends close_notify before transport teardown", async () => {
  // Arrange: dual 1.3 完走
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
  });

  await Promise.all([
    new Promise<void>((r) => client.onConnect.once(r)),
    new Promise<void>((r) => server.onConnect.once(r)),
    client.connect(),
  ]);

  // Act: close 後に wire へ出た client TX を数える
  let clientTxAfterClose = 0;
  const origSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    clientTxAfterClose += 1;
    return origSend(buf, addr);
  };

  client.close();
  // close_notify は async finally 前に await send
  await new Promise((r) => setTimeout(r, 100));

  // Assert: close 後に少なくとも 1 パケット（close_notify）が出る
  expect(clientTxAfterClose).toBeGreaterThanOrEqual(1);
  expect((client as any).dualPhase).toBe("closed");

  try {
    server.close();
  } catch {
    /* */
  }
}, 20_000);

/**
 * P2: local client.close() は public onClose をちょうど 1 回発火する
 * （bridge を先に切っても association が代替発火する）。
 */
test("e2e/dual: local client.close() fires onClose once", async () => {
  // Arrange: pure 1.3 完走
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3],
    addressValidation: "none",
  });

  await Promise.all([
    new Promise<void>((r) => client.onConnect.once(r)),
    new Promise<void>((r) => server.onConnect.once(r)),
    client.connect(),
  ]);

  const closes: number[] = [];
  client.onClose.subscribe(() => {
    // Act 時点で engine13 をまだ検査できる（peer close 経路と対称）
    expect((client as any).engine13).toBeTruthy();
    closes.push(Date.now());
  });

  // Act: local close
  client.close();
  await new Promise((r) => setTimeout(r, 50));

  // Assert: onClose はちょうど 1 回、phase closed、再 close で二重発火なし
  expect(closes.length).toBe(1);
  expect((client as any).dualPhase).toBe("closed");
  expect(client.isDtls13).toBe(false);
  client.close();
  await new Promise((r) => setTimeout(r, 20));
  expect(closes.length).toBe(1);

  try {
    server.close();
  } catch {
    /* */
  }
}, 20_000);

/**
 * P3 補強: probing 中の spoofed 1.2-looking 入力も peer gate で落とす
 * （1.3 SH と同型の送信元検証）。
 */
test("e2e/dual: spoofed 1.2 alert from non-association peer does not surface onError", async () => {
  // Arrange: probing
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });

  let hvrInjected = false;
  clientTransport.send = async () => {
    if (!hvrInjected && (client as any).dualPhase === "none") {
      hvrInjected = true;
      queueMicrotask(() => {
        injectHvr(clientTransport, serverTransport);
      });
    }
  };

  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));

  void client.connect();
  for (let i = 0; i < 50; i++) {
    if ((client as any).dualPhase === "probing") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect((client as any).dualPhase).toBe("probing");

  // Act: 別 peer からの epoch-0 handshake_failure（本来は actionable）
  const alertBody = Buffer.from([2, AlertDesc.HandshakeFailure]);
  const alertPkt = serializePlaintextRecord(
    ContentType.alert,
    0,
    0,
    alertBody,
  );
  clientTransport.onData?.(alertPkt, ["198.51.100.9", 55555]);
  await new Promise((r) => setTimeout(r, 50));

  // Assert: peer gate で drop → onError なし、probing 維持
  expect(errors).toEqual([]);
  expect((client as any).dualPhase).toBe("probing");

  client.close();
  await serverTransport.close().catch(() => {});
  await clientTransport.close().catch(() => {});
}, 10_000);
