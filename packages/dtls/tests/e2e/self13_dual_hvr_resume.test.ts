import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { DirectHandshakeCarrier } from "../../src/carrier/direct";
import { ServerHelloVerifyRequest } from "../../src/handshake/message/server/helloVerifyRequest";
import { createDtlsClientInternal } from "../../src/internal";
import { ContentType } from "../../src/record/const";
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
        if ((client as any).dualCookiePath && !(client as any).engine13) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((client as any).dualCookiePath).toBe(true);
      expect((client as any).engine13).toBeUndefined();
      expect((client as any).dualResume).toBeTruthy();
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
        if ((client as any).dualCookiePath && !(client as any).engine13) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((client as any).dualCookiePath).toBe(true);
      // Soft release must not permanently close the injected carrier
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
