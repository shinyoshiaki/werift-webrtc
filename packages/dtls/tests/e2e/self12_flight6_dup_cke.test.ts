import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { HandshakeType } from "../../src/handshake/const";
import { ContentType } from "../../src/record/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * Wire-level Flight6: before server connects, retransmit Flight5 ClientKeyExchange
 * (and hold Finished) and assert Flight6 does not re-derive masterSecret.
 *
 * Must inject while !server.connected — after connect, CKE/Finished cases return
 * early and never reach handleHandshake (would make a false-green test).
 *
 * Pre-fix: Flight6.handleHandshake re-ran CKE handler every time →
 * cipher re-init mid-association / desync with client.
 */
test("e2e/self12: duplicate Flight5 CKE/Finished does not re-init server cipher", async () => {
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

  // Capture epoch-0 ClientKeyExchange; hold CCS+Finished so server stays pre-connect
  const ckePkts: Buffer[] = [];
  const finishedHold: Buffer[] = [];
  let releaseFinished = false;
  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    const flight = (client as any).dtls.flight;
    if (flight === 5 && buf.length >= 5) {
      const contentType = buf[0];
      const epoch = buf.readUInt16BE(3);
      // Encrypted Finished still has ContentType.handshake — use epoch to hold.
      if (
        !releaseFinished &&
        (epoch > 0 || contentType === ContentType.changeCipherSpec)
      ) {
        finishedHold.push(Buffer.from(buf));
        return;
      }
      if (
        contentType === ContentType.handshake &&
        epoch === 0 &&
        buf.length > 13 &&
        buf[13] === HandshakeType.client_key_exchange_16
      ) {
        ckePkts.push(Buffer.from(buf));
      }
    }
    return origClientSend(buf, addr);
  };

  void client.connect();

  // Wait until server has processed CKE (masterSecret) but not Finished
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      (server as any).flight6 &&
      (server as any).cipher.masterSecret &&
      ckePkts.length > 0 &&
      finishedHold.length > 0 &&
      !server.connected
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  expect((server as any).flight6).toBeTruthy();
  expect((server as any).cipher.masterSecret).toBeTruthy();
  expect(ckePkts.length).toBeGreaterThan(0);
  expect(finishedHold.length).toBeGreaterThan(0);
  expect(server.connected).toBe(false);

  const masterBefore = Buffer.from(
    (server as any).cipher.masterSecret as Buffer,
  );
  const writeKeyBefore = Buffer.from(
    (server as any).cipher.cipher?.writeKey ?? Buffer.alloc(0),
  );
  const cipherInstBefore = (server as any).cipher.cipher;
  const flight6 = (server as any).flight6;

  let handleCalls = 0;
  let ckeApplyCalls = 0;
  const origHandle = flight6.handleHandshake.bind(flight6);
  flight6.handleHandshake = (hs: any) => {
    handleCalls += 1;
    const already = !!((server as any).dtls.handshakeCache[5]?.data ?? []).some(
      (t: { msg_type: number }) => t.msg_type === hs.msg_type,
    );
    if (!already && hs.msg_type === HandshakeType.client_key_exchange_16) {
      ckeApplyCalls += 1;
    }
    return origHandle(hs);
  };

  // Act: re-inject ClientKeyExchange wire packets (Flight5 retransmit) pre-connect
  const peer: [string, number] = [
    clientTransport.address.address,
    clientTransport.address.port,
  ];
  for (const pkt of ckePkts) {
    serverTransport.onData(pkt, peer);
  }
  await new Promise((r) => setTimeout(r, 40));

  const masterAfter = Buffer.from(
    (server as any).cipher.masterSecret as Buffer,
  );
  const writeKeyAfter = Buffer.from(
    (server as any).cipher.cipher?.writeKey ?? Buffer.alloc(0),
  );

  // Assert: crypto state unchanged (idempotent Flight6 handlers)
  expect(masterAfter.equals(masterBefore)).toBe(true);
  expect((server as any).cipher.cipher).toBe(cipherInstBefore);
  if (writeKeyBefore.length > 0) {
    expect(writeKeyAfter.equals(writeKeyBefore)).toBe(true);
  }
  expect(handleCalls).toBeGreaterThan(0);
  expect(ckeApplyCalls).toBe(0);
  expect(server.connected).toBe(false);

  // Release CCS/Finished so handshake can complete
  releaseFinished = true;
  for (const buf of finishedHold) {
    await origClientSend(buf);
  }

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 15_000);
    const check = () => {
      if (client.connected && server.connected) {
        clearTimeout(t);
        resolve();
      }
    };
    check();
    client.onConnect.subscribe(check);
    server.onConnect.subscribe(check);
    client.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
  });

  expect(server.connected).toBe(true);
  expect(client.connected).toBe(true);

  // App data still works both ways after duplicate CKE inject
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("app data timeout")), 5_000);
    client.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("f6-dup-ok");
        clearTimeout(t);
        resolve();
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    void server.send(Buffer.from("f6-dup-ok"));
  });

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 25_000);

/**
 * Unit-level: second ClientKeyExchange on Flight6 must not re-init masterSecret.
 */
test("unit/flight6: second ClientKeyExchange does not re-init masterSecret", async () => {
  const { DtlsContext } = await import("../../src/context/dtls");
  const { CipherContext } = await import("../../src/context/cipher");
  const { TransportContext } = await import("../../src/context/transport");
  const { SessionType } = await import("../../src/cipher/suites/abstract");
  const { Flight6 } = await import("../../src/flight/server/flight6");
  const { ClientKeyExchange } = await import(
    "../../src/handshake/message/client/keyExchange"
  );
  const { DtlsRandom } = await import("../../src/handshake/random");
  const { generateKeyPair } = await import("../../src/cipher/namedCurve");
  const { NamedCurveAlgorithm, CipherSuite } = await import(
    "../../src/cipher/const"
  );
  const { createCipher } = await import("../../src/cipher/create");

  const transport = await UdpTransport.init("udp4");
  transport.send = async () => {};
  const dtls = new DtlsContext({ transport } as any, SessionType.SERVER);
  const cipher = new CipherContext(SessionType.SERVER, certPem, keyPem, sig);
  cipher.localRandom = new DtlsRandom();
  cipher.remoteRandom = new DtlsRandom();
  cipher.namedCurve = NamedCurveAlgorithm.secp256r1_23 as any;
  cipher.cipherSuite =
    CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199 as any;
  cipher.localKeyPair = generateKeyPair(cipher.namedCurve);
  const clientKp = generateKeyPair(cipher.namedCurve);

  // Seed handshake cache so EMS path has material (non-EMS uses randoms)
  dtls.handshakeCache[4] = {
    isLocal: true,
    flight: 4,
    data: [],
  };

  const flight6 = new Flight6(new TransportContext(transport), dtls, cipher);
  const cke = new ClientKeyExchange(clientKp.publicKey);
  cke.messageSeq = 5;
  const frag = cke.toFragment();

  flight6.handleHandshake(frag);
  expect(cipher.masterSecret).toBeTruthy();
  const master1 = Buffer.from(cipher.masterSecret as Buffer);
  const cipherInst1 = cipher.cipher;

  // Act: duplicate CKE (Flight5 retransmit)
  flight6.handleHandshake(frag);
  const master2 = Buffer.from(cipher.masterSecret as Buffer);

  // Assert
  expect(master2.equals(master1)).toBe(true);
  expect(cipher.cipher).toBe(cipherInst1);

  void createCipher;
  await transport.close().catch(() => {});
});

/**
 * Unit-level: duplicate Finished (Flight5 retransmit) must not re-enter apply
 * after the first Finished is cached.
 */
test("unit/flight6: second Finished does not re-apply Finished handler", async () => {
  const { DtlsContext } = await import("../../src/context/dtls");
  const { CipherContext } = await import("../../src/context/cipher");
  const { TransportContext } = await import("../../src/context/transport");
  const { SessionType } = await import("../../src/cipher/suites/abstract");
  const { Flight6 } = await import("../../src/flight/server/flight6");
  const { Finished } = await import("../../src/handshake/message/finished");

  const transport = await UdpTransport.init("udp4");
  transport.send = async () => {};
  const dtls = new DtlsContext({ transport } as any, SessionType.SERVER);
  const cipher = new CipherContext(SessionType.SERVER, certPem, keyPem, sig);

  const flight6 = new Flight6(new TransportContext(transport), dtls, cipher);
  const fin = new Finished(Buffer.alloc(12, 0xab));
  fin.messageSeq = 6;
  const frag = fin.toFragment();

  flight6.handleHandshake(frag);
  const cacheLen1 = (dtls.handshakeCache[5]?.data ?? []).length;
  expect(cacheLen1).toBe(1);

  // Act: duplicate Finished wire fragment
  flight6.handleHandshake(frag);
  const cacheLen2 = (dtls.handshakeCache[5]?.data ?? []).length;

  // Assert: transcript de-duped; no second Finished entry
  expect(cacheLen2).toBe(1);
  expect(
    (dtls.handshakeCache[5]?.data ?? []).filter(
      (t) => t.msg_type === HandshakeType.finished_20,
    ).length,
  ).toBe(1);

  await transport.close().catch(() => {});
});
