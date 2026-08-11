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

  // Act: public close while probing
  client.close();

  // Assert: parked candidate hard-closed; carrier permanently closed
  expect(parked.isClosed()).toBe(true);
  expect(clientCarrier.isClosed()).toBe(true);
  expect(parked.getPendingFlightSize()).toBe(0);
  expect((client as any).parkedEngine13).toBeUndefined();
  expect((client as any).engine13).toBeUndefined();

  // RTO を越えても carrier send / onError なし
  await new Promise((r) => setTimeout(r, INITIAL_RTO_MS + 400));
  expect(carrierSendsAfterClose).toBe(0);
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
