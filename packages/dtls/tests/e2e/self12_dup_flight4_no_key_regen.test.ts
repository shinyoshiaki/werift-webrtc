import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import {
  CurveType,
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
} from "../../src/cipher/const";
import { ContentType } from "../../src/record/const";
import { certPem, keyPem } from "../fixture";

import { generateKeyPair } from "../../src/cipher/namedCurve";
import { SessionType } from "../../src/cipher/suites/abstract";
import { CipherContext } from "../../src/context/cipher";
import { DtlsContext } from "../../src/context/dtls";
import { SrtpContext } from "../../src/context/srtp";
import { TransportContext } from "../../src/context/transport";
import { Flight5 } from "../../src/flight/client/flight5";
import { ServerKeyExchange } from "../../src/handshake/message/server/keyExchange";
import { DtlsRandom } from "../../src/handshake/random";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

/**
 * P1: Flight4 retransmit must not re-run ServerKeyExchange handler.
 * Pre-fix: second SKX called generateKeyPair again → ClientKeyExchange
 * public key (already sent or about to send) desynced from cipher.localKeyPair
 * → Finished verify fails / handshake hang.
 */
test("e2e/self12: duplicate Flight4 does not regenerate client ECDHE", async () => {
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

  const flight4Waves: Buffer[][] = [];
  let currentWave: Buffer[] = [];
  let waveOpen = false;

  const origServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (buf: Buffer, addr?: any) => {
    const dtls = (server as any).dtls;
    if (dtls.clientHelloCommitted && dtls.flight === 4) {
      if (!waveOpen) {
        if (currentWave.length) flight4Waves.push(currentWave);
        currentWave = [];
        waveOpen = true;
      }
      currentWave.push(Buffer.from(buf));
    } else if (waveOpen) {
      flight4Waves.push(currentWave);
      currentWave = [];
      waveOpen = false;
    }
    return origServerSend(buf, addr);
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

  // Force a Flight4-shaped re-inject of the first wave (duplicate records)
  if (waveOpen && currentWave.length) flight4Waves.push(currentWave);
  expect(flight4Waves.length).toBeGreaterThan(0);
  const firstWave = flight4Waves[0];
  expect(firstWave.length).toBeGreaterThan(0);

  const keyAfterFirstSkx = Buffer.from(
    (client as any).cipher.localKeyPair.publicKey as Buffer,
  );

  // Act: re-inject entire first Flight4 wave as if retransmitted (duplicate HS)
  const serverAddr = serverTransport.address;
  const peer: [string, number] = [serverAddr.address, serverAddr.port];
  for (const pkt of firstWave) {
    clientTransport.onData(pkt, peer);
  }
  await new Promise((r) => setTimeout(r, 50));

  const keyAfterDupFlight4 = Buffer.from(
    (client as any).cipher.localKeyPair.publicKey as Buffer,
  );

  // Assert: ECDHE public key unchanged after duplicate Flight4
  expect(keyAfterDupFlight4.equals(keyAfterFirstSkx)).toBe(true);
  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);

  // App data still works (keys not desynced)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("app data timeout")), 5_000);
    server.onData.subscribe((d) => {
      try {
        expect(d.toString()).toBe("dup-f4-ok");
        clearTimeout(t);
        resolve();
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    void client.send(Buffer.from("dup-f4-ok"));
  });

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 25_000);

/**
 * Unit-level: Flight5.handleHandshake skips side effects when msg_type already
 * cached — would FAIL if handlers always re-ran generateKeyPair.
 */
test("unit/flight5: second ServerKeyExchange does not regenerate localKeyPair", async () => {
  const transport = await UdpTransport.init("udp4");
  transport.send = async () => {};
  const dtls = new DtlsContext({ transport } as any, SessionType.CLIENT);
  const cipher = new CipherContext(SessionType.CLIENT, certPem, keyPem, sig);
  cipher.localRandom = new DtlsRandom();
  cipher.remoteRandom = new DtlsRandom();
  const srtp = new SrtpContext();
  const flight5 = new Flight5(
    new TransportContext(transport),
    dtls,
    cipher,
    srtp,
  );

  const serverKp = generateKeyPair(NamedCurveAlgorithm.secp256r1_23 as any);
  const skx = new ServerKeyExchange(
    CurveType.named_curve_3,
    NamedCurveAlgorithm.secp256r1_23 as any,
    serverKp.publicKey.length,
    serverKp.publicKey,
    HashAlgorithm.sha256_4,
    SignatureAlgorithm.rsa_1,
    64,
    Buffer.alloc(64),
  );
  skx.messageSeq = 2;
  const frag = skx.toFragment();

  flight5.handleHandshake(frag);
  const firstPub = Buffer.from(cipher.localKeyPair!.publicKey);
  expect(firstPub.length).toBeGreaterThan(0);

  // Act: same msg_type again (Flight4 retransmit)
  flight5.handleHandshake(frag);
  const secondPub = Buffer.from(cipher.localKeyPair!.publicKey);

  // Assert
  expect(secondPub.equals(firstPub)).toBe(true);

  await transport.close().catch(() => {});
});
