import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { ContentType } from "../../src/record/const";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * Wire-level Flight6: retransmit of Flight5 (ClientKeyExchange + Finished)
 * must not re-derive masterSecret / re-init AEAD on the server.
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

  // Capture first Flight5 wave from client (CKE, CCS, Finished)
  const flight5Pkts: Buffer[] = [];
  let capturing = true;
  const origClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    const flight = (client as any).dtls.flight;
    if (capturing && flight === 5) {
      flight5Pkts.push(Buffer.from(buf));
    }
    return origClientSend(buf, addr);
  };

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("handshake timeout")), 20_000);
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

  capturing = false;
  expect(flight5Pkts.length).toBeGreaterThan(0);
  expect(server.connected).toBe(true);

  const masterBefore = Buffer.from(
    (server as any).cipher.masterSecret as Buffer,
  );
  const writeKeyBefore = Buffer.from(
    (server as any).cipher.cipher?.writeKey ?? Buffer.alloc(0),
  );
  const flight6 = (server as any).flight6;
  expect(flight6).toBeTruthy();

  let handleCalls = 0;
  const origHandle = flight6.handleHandshake.bind(flight6);
  flight6.handleHandshake = (hs: any) => {
    handleCalls += 1;
    return origHandle(hs);
  };

  // Act: re-inject Flight5 wire packets (duplicate CKE / Finished)
  const peer: [string, number] = [
    clientTransport.address.address,
    clientTransport.address.port,
  ];
  for (const pkt of flight5Pkts) {
    serverTransport.onData(pkt, peer);
  }
  await new Promise((r) => setTimeout(r, 50));

  const masterAfter = Buffer.from((server as any).cipher.masterSecret as Buffer);
  const writeKeyAfter = Buffer.from(
    (server as any).cipher.cipher?.writeKey ?? Buffer.alloc(0),
  );

  // Assert: crypto state unchanged (idempotent Flight6 handlers)
  expect(masterAfter.equals(masterBefore)).toBe(true);
  if (writeKeyBefore.length > 0) {
    expect(writeKeyAfter.equals(writeKeyBefore)).toBe(true);
  }
  // Cache de-dupe: even if handleHandshake entered, side effects skipped
  void handleCalls;
  expect(server.connected).toBe(true);
  expect((server as any).associationTornDown).toBe(false);

  // App data still works both ways after duplicate Flight5 inject
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
  const { ClientKeyExchange } =
    await import("../../src/handshake/message/client/keyExchange");
  const { DtlsRandom } = await import("../../src/handshake/random");
  const { generateKeyPair } = await import("../../src/cipher/namedCurve");
  const { NamedCurveAlgorithm, CipherSuite } =
    await import("../../src/cipher/const");
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
