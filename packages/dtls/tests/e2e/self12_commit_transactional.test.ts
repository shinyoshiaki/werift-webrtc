import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import {
  CipherSuite,
  HashAlgorithm,
  SignatureAlgorithm,
} from "../../src/cipher/const";
import { EllipticCurves } from "../../src/handshake/extensions/ellipticCurves";
import { ExtendedMasterSecret } from "../../src/handshake/extensions/extendedMasterSecret";
import { Signature } from "../../src/handshake/extensions/signature";
import { ClientHello } from "../../src/handshake/message/client/hello";
import { DtlsRandom } from "../../src/handshake/random";
import { FragmentedHandshake } from "../../src/record/message/fragment";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

type ClientRandom = { gmt_unix_time: number; random_bytes: Buffer };

function fixedRandom(): ClientRandom {
  const r = new DtlsRandom();
  return {
    gmt_unix_time: r.gmt_unix_time,
    random_bytes: Buffer.from(r.random_bytes),
  };
}

function buildCh(opts: {
  cookie?: Buffer;
  random?: ClientRandom;
  /** ECDSA-only suites so RSA server fails cipher negotiation */
  ecdsaOnly?: boolean;
  ems?: boolean;
}): ClientHello {
  const curves = new EllipticCurves({ data: [23, 29] });
  const signature = new Signature({
    data: opts.ecdsaOnly
      ? [
          {
            hash: HashAlgorithm.sha256_4,
            signature: SignatureAlgorithm.ecdsa_3,
          },
        ]
      : [
          {
            hash: HashAlgorithm.sha256_4,
            signature: SignatureAlgorithm.rsa_1,
          },
        ],
  });
  const exts = [curves.extension, signature.extension];
  if (opts.ems) {
    exts.push({ type: ExtendedMasterSecret.type, data: Buffer.alloc(0) });
  }
  return new ClientHello(
    { major: 254, minor: 253 },
    opts.random ?? fixedRandom(),
    Buffer.alloc(0),
    opts.cookie ?? Buffer.alloc(0),
    opts.ecdsaOnly
      ? [CipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256_49195]
      : [CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199],
    [0],
    exts,
  );
}

function assembled(hello: ClientHello): FragmentedHandshake[] {
  return [FragmentedHandshake.assemble([hello.toFragment()])];
}

/**
 * P1: failed commit after cookie-valid CH2 must not leave EMS/srtp/curve
 * partial state for the next peer (transactional commit).
 */
test("e2e/self12: failed CH2 commit does not poison association state", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    extendedMasterSecret: true,
  });
  serverTransport.send = async () => {};

  const peerA: [string, number] = ["198.51.100.1", 41001];
  const rndA = fixedRandom();

  // A CH1 → HVR
  await (server as any).handleHandshakes(
    assembled(buildCh({ random: rndA, ems: true, ecdsaOnly: true })),
    peerA,
  );
  const cookieA = Buffer.from((server as any).dtls.cookie as Buffer);
  expect((server as any).dtls.remoteExtendedMasterSecret).toBe(false);

  // Act: A CH2 cookie-valid, EMS present, cipher suite fails (ECDSA vs RSA)
  await (server as any).handleHandshakes(
    assembled(
      buildCh({
        cookie: cookieA,
        random: rndA,
        ems: true,
        ecdsaOnly: true,
      }),
    ),
    peerA,
  );

  // Assert: no partial association poison
  expect((server as any).dtls.remoteExtendedMasterSecret).toBe(false);
  expect((server as any).dtls.clientHelloCommitted).toBe(false);
  expect((server as any).cipher.remoteRandom).toBeUndefined();
  expect((server as any).cipher.localKeyPair).toBeUndefined();
  expect((server as any).cipher.cipherSuite).toBeUndefined();
  expect((server as any).srtp.srtpProfile).toBeUndefined();
  expect((server as any).transport.pinnedPeer).toBeUndefined();

  server.close();
  await serverTransport.close().catch(() => {});
});

/**
 * After a failed commit poison attempt, a real peer still completes (same process).
 */
test("e2e/self12: after failed commit, clean client handshake succeeds", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    extendedMasterSecret: true,
  });

  // Poison attempt via direct handleHandshakes (no UDP)
  const peerX: [string, number] = ["203.0.113.9", 9];
  const rndX = fixedRandom();
  const blackhole = serverTransport.send.bind(serverTransport);
  serverTransport.send = async () => {};
  await (server as any).handleHandshakes(
    assembled(buildCh({ random: rndX, ems: true, ecdsaOnly: true })),
    peerX,
  );
  const cX = Buffer.from((server as any).dtls.cookie as Buffer);
  await (server as any).handleHandshakes(
    assembled(
      buildCh({ cookie: cX, random: rndX, ems: true, ecdsaOnly: true }),
    ),
    peerX,
  );
  expect((server as any).dtls.remoteExtendedMasterSecret).toBe(false);
  serverTransport.send = blackhole;

  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    extendedMasterSecret: true,
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("handshake timeout")), 15_000);
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

  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
